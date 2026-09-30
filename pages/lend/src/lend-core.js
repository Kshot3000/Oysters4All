/* Pearl Lend core — collateralized PRL loans on pure Taproot script.
 *
 * Pearl has no smart contracts, so a loan is enforced with pure Bitcoin-style
 * Taproot script. The design is a pawn-shop loan, and it is honest about it:
 * both the principal and the collateral are PRL, so there is no price oracle
 * and no liquidation math to get wrong. The borrower locks collateral C in a
 * Taproot vault; the lender sends principal P to the borrower off-script; the
 * borrower repays P + interest to reclaim the collateral, or the lender sweeps
 * the collateral after the term plus a grace period.
 *
 *   COLLATERAL VAULT (the loan): a 2-leaf P2TR output under a NUMS
 *   (nothing-up-my-sleeve) internal key. Keypath spending is impossible —
 *   coins move only through the two script leaves.
 *
 *   leaf 0 (REPAY — 2-of-2 mutual):
 *     <borrower> OP_CHECKSIGVERIFY <lender> OP_CHECKSIG
 *   The borrower proposes a repayment transaction: one output pays the lender
 *   exactly principal + interest at the lender's prl1 payout address, the
 *   change output returns the remaining collateral to the borrower. The
 *   lender re-verifies the borrower's Schnorr signature against the
 *   repayment digest, checks the outputs, then co-signs. The app refuses to
 *   assemble if either signature fails verification. Witness order is the
 *   reverse of script-key order (as in the audited escrow CHECKSIGADD):
 *     [lenderSig, borrowerSig, repayScript, controlBlock]
 *
 *   leaf 1 (DEFAULT — lender-only after delay):
 *     <termBlocks + graceBlocks> OP_CHECKSEQUENCEVERIFY OP_DROP <lender> OP_CHECKSIG
 *   Spendable only by the lender once (termBlocks + graceBlocks) have passed
 *   since the collateral-lock transaction confirmed (BIP-68, block units, type
 *   flag clear). The delay is committed in the leaf, so neither party can
 *   shorten it later.
 *
 *   EARLY / MUTUAL CLOSE: the repay leaf is policy-neutral — any 2-of-2
 *   agreed split (early repayment, negotiated haircut) is a valid spend of
 *   the same leaf. The UI builds the standard repayment and labels anything
 *   else as what it is: a mutual agreement, signed by both.
 *
 * Interest is grain-exact integer math, computed once at origination:
 *   interest = floor(P * aprBps * termBlocks * 194 / (10_000 * 31_556_952))
 * BigInt throughout (PRL supply in grains exceeds 2^53). The floor rounding
 * is disclosed in the UI, never hidden.
 *
 * Crypto lineage: key handling, TapTweak, bech32m, BIP-341 sighash and wire
 * serialization come from the audited files/pages/sign/src/crypto.js; the
 * 2-leaf taptree, NUMS construction, BIP-341 digests, Schnorr sign/verify,
 * witness assembly and vByte math come from files/pages/escrow/src/
 * escrow-core.js; coin selection and keypath payment building from
 * files/pages/sign/src/sign-core.js. The two script templates below are new
 * composition only — OP_CHECKSIGVERIFY (0xad) and OP_CHECKSEQUENCEVERIFY
 * (0xb2) verified in node/txscript/opcode.go; CSV sequence/locktime rules per
 * BIP-68; leaf version 0xc0 per BIP-341. No new cryptography.
 *
 * Protocol facts (verified, not from memory):
 *  - P2TR dust 546 grains; tx version from network.txVersion (pearld = 1);
 *    bech32m HRPs prl/tprl/rprl; BIP-86 coin type 808276/1.
 *  - TargetTimePerBlock = 3m14s = 194s (node/chaincfg/params.go).
 *  - BIP-68 CSV block delays use sequences 1..65535 with the type flag
 *    clear; the input sequence on the claim tx MUST equal the leaf's delay.
 */

import {
  taggedHash, tapLeafHash, encodeBech32m, decodeBech32m,
  schnorr, sha256, bytesToHex, hexToBytes,
  varint, u32le, u64le, p2trScriptPubKey, txidLE, dblSha,
  DUST_GRAIN, GRAIN_PER_PRL, NETWORKS,
  walletFromMnemonic, newMnemonic, walletFromPriv,
  fetchUtxos, fetchFeeRateGrainsPerVByte, broadcastTx, fetchTxStatus,
} from "../../sign/src/crypto.js";
import { bytesToNumberBE } from "@noble/curves/abstract/utils";
import {
  pushData, parseXOnlyKey, partyKeyFromInput, encodeScriptNum,
  taptree2, verifyControlBlock,
  scriptPathSigDigestEx, signForXOnly, verifySchnorrSig,
  buildScriptPathSpend, spendVBytes, planSpend, scriptAsm, addressToProgram,
} from "../../escrow/src/escrow-core.js";
import {
  selectCoins, buildKeypathTxEx, verifySignedTx, decodeRawTx,
  fmtPRL, parsePRL, SIGHASH_DEFAULT,
} from "../../sign/src/sign-core.js";

export {
  DUST_GRAIN, GRAIN_PER_PRL, NETWORKS, fmtPRL, parsePRL,
  walletFromMnemonic, newMnemonic, walletFromPriv, fetchUtxos, fetchFeeRateGrainsPerVByte,
  broadcastTx, fetchTxStatus, bytesToHex, hexToBytes, schnorr, sha256,
  encodeBech32m, decodeBech32m, p2trScriptPubKey, selectCoins,
  buildKeypathTxEx, verifySignedTx, decodeRawTx,
  verifyControlBlock, scriptAsm, addressToProgram, partyKeyFromInput,
  pushData, parseXOnlyKey, encodeScriptNum, scriptPathSigDigestEx,
  signForXOnly, verifySchnorrSig, buildScriptPathSpend, spendVBytes, planSpend,
};

const OP = {
  CHECKSIG: 0xac,
  CHECKSIGVERIFY: 0xad, // verified: node/txscript/opcode.go OP_CHECKSIGVERIFY = 0xad
  DROP: 0x75,
  CSV: 0xb2,            // verified: node/txscript/opcode.go OP_CHECKSEQUENCEVERIFY = 0xb2
};
const TAPLEAF_VERSION = 0xc0;
const FINAL_SEQ = 0xffffffff;
const MAX_CSV_BLOCKS = 65535; // BIP-68: 16-bit block count, type flag clear
const NUMS_DOMAIN = "pearl-lend/nums/v1";
const DESCRIPTOR_KIND = "pearllend:v1";
const FP_DOMAIN = "pearl-lend/fingerprint/v1";
const BLOCK_SECS = 194n;          // node/chaincfg/params.go TargetTimePerBlock
const SECS_PER_YEAR = 31556952n;  // 365.2425 days
const BPS = 10000n;

const utf8 = (s) => new TextEncoder().encode(s);
function constEq(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

/* ---------------- terms math (BigInt, grain-exact) ---------------- */

/** Floor interest in grains for principal P at aprBps over termBlocks.
 *  I = floor(P * aprBps * termBlocks * 194 / (10000 * 31556952)).
 *  The floor (always in the borrower's favor, at most 1 grain) is disclosed. */
export function interestGrains(principalGrains, aprBps, termBlocks) {
  const P = BigInt(principalGrains);
  const r = BigInt(aprBps);
  const t = BigInt(termBlocks);
  if (P <= 0n) throw new Error("principal must be positive");
  if (r < 0n) throw new Error("APR cannot be negative");
  if (t <= 0n) throw new Error("term must be positive");
  return (P * r * t * BLOCK_SECS) / (BPS * SECS_PER_YEAR);
}

/** Total repayment: principal + floor interest. */
export function repaymentGrains(principalGrains, aprBps, termBlocks) {
  return BigInt(principalGrains) + interestGrains(principalGrains, aprBps, termBlocks);
}

/** Minimum collateral: the greater of (a) the ratio floor and (b) full repayment.
 *  (b) is what makes the lender whole on default — the vault must always be
 *  able to pay the lender back. Ratio default 150%. */
export function minCollateralGrains(principalGrains, aprBps, termBlocks, ratioBps = 15000) {
  const P = BigInt(principalGrains);
  const ratio = BigInt(ratioBps);
  if (ratio < BPS) throw new Error("collateral ratio must be >= 100%");
  const byRatio = (P * ratio + BPS - 1n) / BPS; // ceil
  const byRepay = repaymentGrains(P, aprBps, termBlocks);
  return byRatio > byRepay ? byRatio : byRepay;
}

/** Whole days (floor) covered by termBlocks at 194 s/block. */
export function termDays(termBlocks) {
  return Number((BigInt(termBlocks) * BLOCK_SECS) / 86400n);
}

/** Effective APR in bps implied by an actual interest quote (for display). */
export function effectiveAprBps(principalGrains, interestGrains_, termBlocks) {
  const P = BigInt(principalGrains);
  const I = BigInt(interestGrains_);
  const t = BigInt(termBlocks);
  if (P <= 0n || t <= 0n) throw new Error("bad inputs");
  return (I * BPS * SECS_PER_YEAR) / (P * t * BLOCK_SECS);
}

/* ---------------- script templates ---------------- */

/** Repay leaf (2-of-2 mutual): <borrower> CHECKSIGVERIFY <lender> CHECKSIG.
 *  Stack at CHECKSIGVERIFY: [sig_b, K_b] — pops K_b, then sig_b, verifies.
 *  Stack at CHECKSIG:       [sig_l, K_l] — pops K_l, then sig_l, verifies.
 *  Witness (reverse script-key order): [lenderSig, borrowerSig, script, control]. */
export function buildRepayScript(borrowerXOnly, lenderXOnly) {
  const kb = borrowerXOnly instanceof Uint8Array ? borrowerXOnly : parseXOnlyKey(borrowerXOnly);
  const kl = lenderXOnly instanceof Uint8Array ? lenderXOnly : parseXOnlyKey(lenderXOnly);
  for (const [k, name] of [[kb, "borrower"], [kl, "lender"]]) {
    if (k.length !== 32) throw new Error(`${name} key must be 32 bytes`);
    schnorr.utils.lift_x(bytesToNumberBE(k)); // refuse non-curve x-coords
  }
  if (constEq(kb, kl)) throw new Error("LEND REFUSED: borrower and lender keys are identical — a 2-of-2 with one key is a 1-of-1");
  return Uint8Array.from([...pushData(kb), OP.CHECKSIGVERIFY, ...pushData(kl), OP.CHECKSIG]);
}

/** Default leaf: <delayBlocks> CSV DROP <lender> CHECKSIG.
 *  delayBlocks = termBlocks + graceBlocks, 1..65535, committed in the leaf. */
export function buildDefaultScript(lenderXOnly, delayBlocks) {
  const kl = lenderXOnly instanceof Uint8Array ? lenderXOnly : parseXOnlyKey(lenderXOnly);
  if (kl.length !== 32) throw new Error("lender key must be 32 bytes");
  schnorr.utils.lift_x(bytesToNumberBE(kl));
  if (!Number.isSafeInteger(delayBlocks) || delayBlocks < 1 || delayBlocks > MAX_CSV_BLOCKS) {
    throw new Error(`default delay must be 1..${MAX_CSV_BLOCKS} blocks (BIP-68)`);
  }
  const d = encodeScriptNum(delayBlocks);
  return Uint8Array.from([...pushData(d), OP.CSV, OP.DROP, ...pushData(kl), OP.CHECKSIG]);
}

/** NUMS internal key: lift_x(SHA-256("pearl-lend/nums/v1" || leafHashA || leafHashB)).
 *  Same verified construction as the audited escrow NUMS key, new domain.
 *  Nobody knows the discrete log, so keypath spending is impossible. */
export function numsInternalKeyLend(leafA, leafB) {
  if (!(leafA instanceof Uint8Array) || leafA.length === 0) throw new Error("bad leaf A");
  if (!(leafB instanceof Uint8Array) || leafB.length === 0) throw new Error("bad leaf B");
  const preimage = Uint8Array.from([utf8(NUMS_DOMAIN), tapLeafHash(leafA), tapLeafHash(leafB)].flatMap((x) => [...x]));
  for (let counter = 0; counter < 256; counter++) {
    const pre = counter === 0 ? preimage : Uint8Array.from([...preimage, counter]);
    const h = sha256(pre);
    try {
      schnorr.utils.lift_x(bytesToNumberBE(h));
      return h;
    } catch { /* try next counter */ }
  }
  throw new Error("LEND REFUSED: NUMS lift failed (unreachable in practice)");
}

/* ---------------- loan derivation + descriptor ---------------- */

/**
 * Derive the collateral-vault address and all spend data from loan terms.
 * params: { network, borrowerXOnly, lenderXOnly, termBlocks, graceBlocks }
 * Returns { address, spk, tweakedX, internalXOnly, repayScript, defaultScript,
 *           repayControl, defaultControl, delayBlocks, leafHashes }.
 */
export function deriveLoan(params) {
  const { network, borrowerXOnly, lenderXOnly, termBlocks, graceBlocks } = params;
  if (!network || !network.hrp) throw new Error("bad network");
  const delayBlocks = Number(BigInt(termBlocks)) + Number(BigInt(graceBlocks || 0));
  const repayScript = buildRepayScript(borrowerXOnly, lenderXOnly);
  const defaultScript = buildDefaultScript(lenderXOnly, delayBlocks);
  const internalXOnly = numsInternalKeyLend(repayScript, defaultScript);
  const tree = taptree2(network, internalXOnly, repayScript, defaultScript);
  return {
    address: tree.address,
    spk: tree.spk,
    tweakedX: tree.tweakedX,
    internalXOnly,
    repayScript,
    defaultScript,
    repayControl: tree.controlBlocks[0],
    defaultControl: tree.controlBlocks[1],
    leafHashes: tree.leafHashes,
    delayBlocks,
  };
}

/** Canonical (key-sorted, whitespace-free) JSON for tamper-evident descriptors. */
export function canonicalJson(obj) {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    if (Array.isArray(obj)) return "[" + obj.map(canonicalJson).join(",") + "]";
    return JSON.stringify(obj);
  }
  return "{" + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") + "}";
}

/**
 * Build a tamper-evident loan descriptor. Throws on any invalid term.
 * All grain amounts are decimal strings (BigInt-safe); keys are 64-hex x-only.
 */
export function buildDescriptor(o) {
  const network = o.network;
  if (!network || !NETWORKS[network.id]) throw new Error("unknown network");
  const borrowerXOnly = bytesToHex(parseXOnlyKey(o.borrowerXOnly));
  const lenderXOnly = bytesToHex(parseXOnlyKey(o.lenderXOnly));
  if (borrowerXOnly === lenderXOnly) throw new Error("LEND REFUSED: borrower and lender keys are identical");
  const borrowerPayout = o.borrowerPayout.trim();
  const lenderPayout = o.lenderPayout.trim();
  addressToProgram(borrowerPayout, network); // throws unless valid P2TR on this network
  addressToProgram(lenderPayout, network);
  const principal = BigInt(parsePRL(String(o.principalPRL))); // parsePRL returns BigInt
  if (principal < BigInt(DUST_GRAIN)) throw new Error(`principal below dust (${DUST_GRAIN} grains)`);
  const aprBps = BigInt(o.aprBps);
  if (aprBps < 0n || aprBps > 1000000n) throw new Error("APR must be 0..10000% (0..1000000 bps)");
  const termBlocks = BigInt(o.termBlocks);
  const graceBlocks = BigInt(o.graceBlocks ?? 0);
  if (termBlocks < 1n) throw new Error("term must be >= 1 block");
  if (graceBlocks < 0n) throw new Error("grace cannot be negative");
  const delay = termBlocks + graceBlocks;
  if (delay > BigInt(MAX_CSV_BLOCKS)) throw new Error(`term + grace exceeds BIP-68 CSV maximum (${MAX_CSV_BLOCKS} blocks)`);
  const ratioBps = BigInt(o.ratioBps ?? 15000);
  if (ratioBps < BPS) throw new Error("collateral ratio must be >= 100%");
  const collateral = BigInt(parsePRL(String(o.collateralPRL)));
  const interest = interestGrains(principal, aprBps, termBlocks);
  const repayment = principal + interest;
  const minCol = minCollateralGrains(principal, aprBps, termBlocks, ratioBps);
  if (collateral < minCol) {
    throw new Error(`LEND REFUSED: collateral ${fmtPRL(collateral)} PRL below minimum ${fmtPRL(minCol)} PRL (max of ${Number(ratioBps) / 100}% ratio and full repayment ${fmtPRL(repayment)} PRL)`);
  }
  const loan = deriveLoan({ network, borrowerXOnly: hexToBytes(borrowerXOnly), lenderXOnly: hexToBytes(lenderXOnly), termBlocks: Number(termBlocks), graceBlocks: Number(graceBlocks) });
  const d = {
    kind: DESCRIPTOR_KIND,
    network: network.id,
    borrowerXOnly,
    lenderXOnly,
    borrowerPayout,
    lenderPayout,
    principalGrains: principal.toString(),
    aprBps: aprBps.toString(),
    termBlocks: termBlocks.toString(),
    graceBlocks: graceBlocks.toString(),
    delayBlocks: delay.toString(),
    ratioBps: ratioBps.toString(),
    collateralGrains: collateral.toString(),
    interestGrains: interest.toString(),
    repaymentGrains: repayment.toString(),
    vaultAddress: loan.address,
    vaultSpk: bytesToHex(loan.spk),
    createdAt: new Date().toISOString(),
    note: String(o.note || "").slice(0, 280),
  };
  d.fingerprint = bytesToHex(sha256(utf8(FP_DOMAIN + "\n" + canonicalJson({ ...d, fingerprint: undefined }))));
  return d;
}

/** Re-derive and verify a descriptor: address, amounts, fingerprint. Returns {ok, errors[]}. */
export function verifyDescriptor(d) {
  const errors = [];
  try {
    const network = NETWORKS[d.network];
    if (!network) throw new Error("unknown network");
    if (d.kind !== DESCRIPTOR_KIND) throw new Error("wrong descriptor kind");
    const loan = deriveLoan({
      network,
      borrowerXOnly: hexToBytes(d.borrowerXOnly),
      lenderXOnly: hexToBytes(d.lenderXOnly),
      termBlocks: Number(BigInt(d.termBlocks)),
      graceBlocks: Number(BigInt(d.graceBlocks)),
    });
    if (loan.address !== d.vaultAddress) errors.push("vault address does not re-derive from terms");
    if (bytesToHex(loan.spk) !== d.vaultSpk) errors.push("vault scriptPubKey does not re-derive from terms");
    const interest = interestGrains(BigInt(d.principalGrains), BigInt(d.aprBps), BigInt(d.termBlocks));
    if (interest.toString() !== d.interestGrains) errors.push("interest does not recompute from terms");
    if ((BigInt(d.principalGrains) + interest).toString() !== d.repaymentGrains) errors.push("repayment != principal + interest");
    const minCol = minCollateralGrains(BigInt(d.principalGrains), BigInt(d.aprBps), BigInt(d.termBlocks), BigInt(d.ratioBps));
    if (BigInt(d.collateralGrains) < minCol) errors.push("collateral below minimum for terms");
    const fp = bytesToHex(sha256(utf8(FP_DOMAIN + "\n" + canonicalJson({ ...d, fingerprint: undefined }))));
    if (fp !== d.fingerprint) errors.push("fingerprint mismatch — descriptor was modified");
    if ((BigInt(d.termBlocks) + BigInt(d.graceBlocks)).toString() !== d.delayBlocks) errors.push("delay != term + grace");
  } catch (e) {
    errors.push("verify threw: " + e.message);
  }
  return { ok: errors.length === 0, errors };
}

/* ---------------- transaction building ---------------- */

function loanInput(descriptor, lockTxid, lockVout, collateralValue) {
  const network = NETWORKS[descriptor.network];
  if (!/^[0-9a-f]{64}$/i.test(lockTxid || "")) throw new Error("bad lock txid");
  if (!Number.isInteger(lockVout) || lockVout < 0) throw new Error("bad lock vout");
  const value = BigInt(collateralValue);
  if (value <= 0n) throw new Error("collateral value must be positive");
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("collateral value exceeds safe integer range");
  return {
    network,
    txid: lockTxid.toLowerCase(),
    vout: lockVout,
    value: Number(value),
    spk: hexToBytes(descriptor.vaultSpk),
  };
}

function loanScripts(descriptor) {
  const network = NETWORKS[descriptor.network];
  const loan = deriveLoan({
    network,
    borrowerXOnly: hexToBytes(descriptor.borrowerXOnly),
    lenderXOnly: hexToBytes(descriptor.lenderXOnly),
    termBlocks: Number(BigInt(descriptor.termBlocks)),
    graceBlocks: Number(BigInt(descriptor.graceBlocks)),
  });
  if (loan.address !== descriptor.vaultAddress) throw new Error("LEND REFUSED: descriptor vault address does not re-derive — refusing to sign against it");
  return loan;
}

/** vByte estimate for a script-path spend of the vault. */
export function vaultSpendVBytes(kind, descriptor) {
  const loan = loanScripts(descriptor);
  const scriptLen = kind === "repay" ? loan.repayScript.length : loan.defaultScript.length;
  return spendVBytes({
    nOut: kind === "repay" ? 2 : 1,
    scriptLen,
    controlLen: 33,
    stackLens: kind === "repay" ? [64, 64] : [64],
  });
}

/**
 * Build the UNSIGNED repayment transaction template.
 * Input: the collateral vault UTXO. Outputs: lender gets exactly
 * principal + interest at their payout address; borrower gets the change.
 * If the change would be below dust, it folds into the miner fee ONLY when
 * the vault still covers repayment + the 1-output fee — disclosed in the plan.
 * Returns { input, outputs, feeGrains, vbytes, digest, repayScript, repayControl }.
 */
export function buildRepayment(descriptor, lockTxid, lockVout, collateralValue, feeRateGrainsPerVByte) {
  const feeRate = Number(feeRateGrainsPerVByte);
  if (!Number.isFinite(feeRate) || feeRate <= 0) throw new Error("fee rate must be positive");
  const input = loanInput(descriptor, lockTxid, lockVout, collateralValue);
  const loan = loanScripts(descriptor);
  const network = input.network;
  const repayment = BigInt(descriptor.repaymentGrains);
  const collateral = BigInt(input.value);
  if (collateral < repayment) throw new Error("LEND REFUSED: collateral value below repayment — vault cannot pay the lender");
  const lenderProgram = addressToProgram(descriptor.lenderPayout, network);
  const borrowerProgram = addressToProgram(descriptor.borrowerPayout, network);

  // Try 2 outputs first (lender + borrower change).
  const vb2 = spendVBytes({ nOut: 2, scriptLen: loan.repayScript.length, controlLen: 33, stackLens: [64, 64] });
  const fee2 = BigInt(Math.ceil(vb2 * feeRate));
  let outputs, feeGrains, vbytes;
  const change2 = collateral - repayment - fee2;
  if (change2 >= BigInt(DUST_GRAIN)) {
    outputs = [
      { program: lenderProgram, value: Number(repayment) },
      { program: borrowerProgram, value: Number(change2) },
    ];
    feeGrains = fee2; vbytes = vb2;
  } else {
    // Change below dust: single lender output; leftover becomes fee (disclosed).
    const vb1 = spendVBytes({ nOut: 1, scriptLen: loan.repayScript.length, controlLen: 33, stackLens: [64, 64] });
    const fee1 = BigInt(Math.ceil(vb1 * feeRate));
    if (collateral < repayment + fee1) {
      throw new Error(`LEND REFUSED: collateral ${fmtPRL(collateral)} covers repayment but not the claim fee (${fmtPRL(repayment + fee1)} needed)`);
    }
    outputs = [{ program: lenderProgram, value: Number(repayment) }];
    feeGrains = collateral - repayment; vbytes = vb1; // actual fee incl. dust remainder
  }
  const digest = scriptPathSigDigestEx(network, input, outputs, loan.repayScript, { sequence: FINAL_SEQ });
  return {
    kind: "repay",
    input: { txid: input.txid, vout: input.vout, value: input.value },
    feeRateGrainsPerVByte: feeRate,
    outputs: outputs.map((o) => ({ address: encodeBech32m(network.hrp, 1, o.program), value: o.value.toString() })),
    feeGrains: feeGrains.toString(),
    vbytes,
    dustFolded: outputs.length === 1,
    digest: bytesToHex(digest),
    _repayScript: loan.repayScript,
    _repayControl: loan.repayControl,
  };
}

/** Sign the repayment digest with a 32-byte private key (hex). Returns 64-byte hex Schnorr sig. */
export function signRepaymentDigest(privHex, digestHex) {
  if (!/^[0-9a-f]{64}$/i.test(privHex || "")) throw new Error("private key must be 32-byte hex");
  return bytesToHex(signForXOnly(hexToBytes(privHex), hexToBytes(digestHex)));
}

/**
 * Assemble the fully-signed repayment tx. Re-verifies BOTH Schnorr signatures
 * against the digest before assembly — a bad signature refuses, never
 * produces a half-signed broadcast. Witness: [lenderSig, borrowerSig, script, control].
 * Returns { hex, txid }.
 */
export function assembleRepayment(descriptor, proposal, borrowerSigHex, lenderSigHex) {
  const network = NETWORKS[descriptor.network];
  const loan = loanScripts(descriptor);
  for (const [s, who] of [[borrowerSigHex, "borrower"], [lenderSigHex, "lender"]]) {
    if (!/^[0-9a-f]{128}$/i.test(s || "")) throw new Error(`${who} signature must be 64-byte hex`);
  }
  const input = loanInput(descriptor, proposal.input.txid, proposal.input.vout, proposal.input.value);
  const outputs = proposal.outputs.map((o) => ({ program: addressToProgram(o.address, network), value: Number(BigInt(o.value)) }));
  const digest = scriptPathSigDigestEx(network, input, outputs, loan.repayScript, { sequence: FINAL_SEQ });
  if (bytesToHex(digest) !== proposal.digest) throw new Error("LEND REFUSED: proposal digest does not recompute — refusing to sign");
  const bX = hexToBytes(descriptor.borrowerXOnly);
  const lX = hexToBytes(descriptor.lenderXOnly);
  if (!verifySchnorrSig(hexToBytes(borrowerSigHex), digest, bX)) {
    throw new Error("LEND REFUSED: borrower signature invalid for this repayment — assembly aborted");
  }
  if (!verifySchnorrSig(hexToBytes(lenderSigHex), digest, lX)) {
    throw new Error("LEND REFUSED: lender signature invalid for this repayment — assembly aborted");
  }
  const tx = buildScriptPathSpend(
    network, input, outputs, loan.repayScript, loan.repayControl,
    [hexToBytes(lenderSigHex), hexToBytes(borrowerSigHex)], // reverse script-key order
    { sequence: FINAL_SEQ },
  );
  const v = verifyAssembledScriptSpend(network, tx.hex, {
    input, outputs,
    script: loan.repayScript, control: loan.repayControl,
    internalXOnly: loan.internalXOnly, tweakedX: loan.tweakedX,
    sigKeys: [hexToBytes(descriptor.lenderXOnly), hexToBytes(descriptor.borrowerXOnly)],
    sequence: FINAL_SEQ,
  });
  if (!v.ok) throw new Error("assembled repayment failed self-verification: " + v.errors.join("; "));
  return tx;
}

/**
 * Build the lender's DEFAULT claim (unilateral sweep after term + grace).
 * The input sequence equals the leaf's committed delay (BIP-68); the claim is
 * only consensus-valid once delayBlocks have passed since the lock confirmed.
 * Returns { hex, txid, digest, vbytes, feeGrains } — unsigned until signed.
 */
export function buildDefaultClaim(descriptor, lockTxid, lockVout, collateralValue, feeRateGrainsPerVByte, lenderPrivHex) {
  const feeRate = Number(feeRateGrainsPerVByte);
  if (!Number.isFinite(feeRate) || feeRate <= 0) throw new Error("fee rate must be positive");
  if (!/^[0-9a-f]{64}$/i.test(lenderPrivHex || "")) throw new Error("lender private key must be 32-byte hex");
  const input = loanInput(descriptor, lockTxid, lockVout, collateralValue);
  const loan = loanScripts(descriptor);
  const network = input.network;
  const delay = Number(BigInt(descriptor.delayBlocks));
  const vb = spendVBytes({ nOut: 1, scriptLen: loan.defaultScript.length, controlLen: 33, stackLens: [64] });
  const fee = BigInt(Math.ceil(vb * feeRate));
  const collateral = BigInt(input.value);
  const pay = collateral - fee;
  if (pay < BigInt(DUST_GRAIN)) throw new Error("LEND REFUSED: collateral does not cover the claim fee");
  const lenderProgram = addressToProgram(descriptor.lenderPayout, network);
  const outputs = [{ program: lenderProgram, value: Number(pay) }];
  const digest = scriptPathSigDigestEx(network, input, outputs, loan.defaultScript, { sequence: delay });
  const sig = signForXOnly(hexToBytes(lenderPrivHex), digest);
  if (!verifySchnorrSig(sig, digest, hexToBytes(descriptor.lenderXOnly))) {
    throw new Error("LEND REFUSED: lender signature failed self-verification");
  }
  const tx = buildScriptPathSpend(
    network, input, outputs, loan.defaultScript, loan.defaultControl,
    [sig], { sequence: delay },
  );
  const v = verifyAssembledScriptSpend(network, tx.hex, {
    input, outputs,
    script: loan.defaultScript, control: loan.defaultControl,
    internalXOnly: loan.internalXOnly, tweakedX: loan.tweakedX,
    sigKeys: [hexToBytes(descriptor.lenderXOnly)],
    sequence: delay,
  });
  if (!v.ok) throw new Error("default claim failed self-verification: " + v.errors.join("; "));
  return {
    kind: "default",
    hex: tx.hex,
    txid: tx.txid,
    digest: bytesToHex(digest),
    sig: bytesToHex(sig),
    vbytes: vb,
    feeGrains: fee.toString(),
    paysLenderGrains: pay.toString(),
    delayBlocks: delay,
  };
}

/**
 * Build a MUTUAL close: any 2-of-2 agreed split of the vault (early
 * repayment, negotiated haircut, refinance). Both parties sign the same
 * digest; the app verifies both before assembly. splits: [{address, valueGrains}].
 */
export function buildMutualClose(descriptor, lockTxid, lockVout, collateralValue, splits, feeRateGrainsPerVByte) {
  const feeRate = Number(feeRateGrainsPerVByte);
  if (!Number.isFinite(feeRate) || feeRate <= 0) throw new Error("fee rate must be positive");
  if (!Array.isArray(splits) || splits.length < 1 || splits.length > 8) throw new Error("splits must be 1..8 outputs");
  const input = loanInput(descriptor, lockTxid, lockVout, collateralValue);
  const loan = loanScripts(descriptor);
  const network = input.network;
  const vb = spendVBytes({ nOut: splits.length, scriptLen: loan.repayScript.length, controlLen: 33, stackLens: [64, 64] });
  const fee = BigInt(Math.ceil(vb * feeRate));
  const outputs = splits.map((s) => {
    const program = addressToProgram(s.address, network);
    const value = BigInt(s.valueGrains);
    if (value < BigInt(DUST_GRAIN)) throw new Error("split output below dust");
    return { program, value: Number(value) };
  });
  const total = outputs.reduce((a, o) => a + BigInt(o.value), 0n);
  if (total + fee !== BigInt(input.value)) {
    throw new Error(`splits (${fmtPRL(total)}) + fee (${fmtPRL(fee)}) must equal vault value (${fmtPRL(BigInt(input.value))})`);
  }
  const digest = scriptPathSigDigestEx(network, input, outputs, loan.repayScript, { sequence: FINAL_SEQ });
  return {
    kind: "mutual",
    input: { txid: input.txid, vout: input.vout, value: input.value },
    outputs: outputs.map((o, i) => ({ address: splits[i].address, value: o.value.toString() })),
    feeGrains: fee.toString(),
    vbytes: vb,
    digest: bytesToHex(digest),
    _repayScript: loan.repayScript,
    _repayControl: loan.repayControl,
  };
}

/** Assemble a mutual close from both verified signatures. Returns { hex, txid }. */
export function assembleMutualClose(descriptor, proposal, borrowerSigHex, lenderSigHex) {
  // Same 2-of-2 leaf and verification discipline as the repayment.
  return assembleRepayment(descriptor, { ...proposal, kind: "repay" }, borrowerSigHex, lenderSigHex);
}

/**
 * Self-verify an assembled script-path spend: decode the raw bytes and check
 * the input (txid/vout/sequence), every output (program + value), the witness
 * shape ([sigs..., script, control]), the control block against the tweaked
 * key, and that each signature verifies against the recomputed BIP-341
 * digest. Returns { ok, errors[] }.
 */
export function verifyAssembledScriptSpend(network, txHex, spec) {
  const errors = [];
  try {
    const { input, outputs, script, control, internalXOnly, tweakedX, sigKeys, sequence } = spec;
    const dec = decodeRawTx(txHex);
    if (dec.inputs.length !== 1) errors.push("expected 1 input");
    else {
      const inp = dec.inputs[0];
      if (inp.txid !== input.txid || inp.vout !== input.vout) errors.push("input outpoint mismatch");
      if (inp.sequence !== sequence) errors.push(`input sequence ${inp.sequence} != expected ${sequence}`);
    }
    if (dec.outputs.length !== outputs.length) {
      errors.push(`output count ${dec.outputs.length} != ${outputs.length}`);
    } else {
      dec.outputs.forEach((o, i) => {
        if (!(o.spk.length === 34 && o.spk[0] === 0x51 && o.spk[1] === 0x20)) {
          errors.push(`output ${i} is not P2TR`);
          return;
        }
        if (!constEq(o.spk.slice(2), outputs[i].program)) errors.push(`output ${i} program mismatch`);
        if (BigInt(o.value) !== BigInt(outputs[i].value)) errors.push(`output ${i} value mismatch`);
      });
    }
    const wit = (dec.witness && dec.witness[0]) || [];
    const nSigs = sigKeys.length;
    if (wit.length !== nSigs + 2) {
      errors.push(`witness has ${wit.length} items, expected ${nSigs + 2}`);
    } else {
      const sigs = wit.slice(0, nSigs);
      if (!constEq(wit[nSigs], script)) errors.push("witness script mismatch");
      if (!constEq(wit[nSigs + 1], control)) errors.push("witness control block mismatch");
      if (!verifyControlBlock(internalXOnly, script, control, tweakedX)) {
        errors.push("control block does not verify against tweaked key");
      }
      const digest = scriptPathSigDigestEx(network, input, outputs, script, { sequence });
      sigs.forEach((s, i) => {
        if (s.length !== 64) errors.push(`witness sig ${i} not 64 bytes`);
        else if (!verifySchnorrSig(s, digest, sigKeys[i])) errors.push(`witness sig ${i} invalid for its key`);
      });
    }
  } catch (e) {
    errors.push("verify threw: " + e.message);
  }
  return { ok: errors.length === 0, errors };
}
export function verifyLoanTx(descriptor, signedHex, prevouts) {
  const details = [];
  try {
    const vd = verifyDescriptor(descriptor);
    if (!vd.ok) return { verdict: "NOT PROVEN", details: ["descriptor invalid: " + vd.errors.join("; ")] };
    const network = NETWORKS[descriptor.network];
    const loan = loanScripts(descriptor);
    const decoded = decodeRawTx(signedHex);
    if (decoded.inputs.length !== 1) return { verdict: "NOT PROVEN", details: ["expected exactly 1 input"] };
    const inp = decoded.inputs[0];
    const prev = (prevouts || []).find((p) => p.txid === inp.txid && p.vout === inp.vout);
    if (!prev) return { verdict: "NOT PROVEN", details: ["prevout not supplied for input"] };
    const prevValue = BigInt(prev.value);
    if (prevValue <= 0n || prevValue > BigInt(Number.MAX_SAFE_INTEGER)) {
      return { verdict: "NOT PROVEN", details: ["prevout value out of range"] };
    }
    const input = { txid: inp.txid, vout: inp.vout, value: Number(prevValue), spk: hexToBytes(prev.spk) };
    const outputs = decoded.outputs.map((o) => {
      const m = /^OP_1 <([0-9a-f]{64})>$/.exec(describeSpk(o.spk));
      if (!m) throw new Error("non-P2TR output");
      if (o.value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("output value out of range");
      return { program: hexToBytes(m[1]), value: Number(o.value) };
    });
    const wit = decoded.witness[0] || [];
    const sigs = wit.filter((w) => w.length === 64);
    if (sigs.length === 0) return { verdict: "NOT PROVEN", details: ["no Schnorr signatures in witness"] };
    // Try both leaves.
    const leaves = [
      { name: "repay", script: loan.repayScript, keys: [descriptor.borrowerXOnly, descriptor.lenderXOnly], seq: FINAL_SEQ },
      { name: "default", script: loan.defaultScript, keys: [descriptor.lenderXOnly], seq: Number(BigInt(descriptor.delayBlocks)) },
    ];
    for (const leaf of leaves) {
      try {
        const digest = scriptPathSigDigestEx(network, input, outputs, leaf.script, { sequence: inp.sequence });
        const keys = leaf.keys.map((k) => hexToBytes(k));
        const okSigs = sigs.filter((s) => keys.some((k) => { try { return verifySchnorrSig(s, digest, k); } catch { return false; } }));
        if (okSigs.length > 0 && inp.sequence === leaf.seq) {
          details.push(`leaf=${leaf.name} digest=${bytesToHex(digest).slice(0, 16)}… sigs=${okSigs.length}/${sigs.length} valid`);
          const need = leaf.name === "repay" ? 2 : 1;
          if (okSigs.length >= need) {
            return { verdict: "PROVEN", details: [...details, `spend authorized via the ${leaf.name} leaf (${okSigs.length}/${need} required signatures valid)`] };
          }
        }
      } catch { /* next leaf */ }
    }
    return { verdict: "NOT PROVEN", details: [...details, "no leaf authorizes this spend"] };
  } catch (e) {
    return { verdict: "NOT PROVEN", details: ["verifier threw: " + e.message] };
  }
}

/** Describe a scriptPubKey for the verifier (P2TR only here). */
function describeSpk(spk) {
  if (spk.length === 34 && spk[0] === 0x51 && spk[1] === 0x20) {
    return `OP_1 <${bytesToHex(spk.slice(2))}>`;
  }
  return "non-P2TR";
}

/** Build an unsigned keypath funding payment (lender -> borrower principal).
 *  Thin wrapper over the audited sign-core coin selection + tx builder.
 *  utxos: [{txid, vout, value (grains), spk (hex of prevout scriptPubKey),
 *           priv (32-byte hex), internalXOnly (64-hex x-only)}].
 *  Returns { txid, hex, feeGrains, changeGrains } — unsigned template; the
 *  caller signs with buildKeypathTxEx-compatible keys or in their wallet. */
export function buildFundingPayment(network, utxos, toAddress, amountGrains, feeRateGrainsPerVByte, changeAddress) {
  const toProgram = addressToProgram(toAddress, network);
  const changeProgram = addressToProgram(changeAddress, network);
  const amount = BigInt(amountGrains);
  if (amount < BigInt(DUST_GRAIN)) throw new Error("payment below dust");
  const picked = selectCoins(utxos, amount, Number(feeRateGrainsPerVByte), 2);
  const inputs = picked.selected.map((u) => {
    const value = BigInt(u.value);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("utxo value out of range");
    const priv = typeof u.priv === "string" ? hexToBytes(u.priv) : u.priv;
    const internalXOnly = typeof u.internalXOnly === "string" ? hexToBytes(u.internalXOnly) : u.internalXOnly;
    if (!(priv instanceof Uint8Array) || priv.length !== 32) throw new Error("utxo priv must be 32 bytes");
    if (!(internalXOnly instanceof Uint8Array) || internalXOnly.length !== 32) throw new Error("utxo internalXOnly must be 32 bytes");
    return {
      txid: u.txid, vout: u.vout, value: Number(value),
      spk: hexToBytes(u.spk), priv, internalXOnly,
    };
  });
  const outs = [{ program: toProgram, value: Number(amount) }];
  if (picked.change >= BigInt(DUST_GRAIN)) {
    outs.push({ program: changeProgram, value: Number(picked.change) });
  }
  const tx = buildKeypathTxEx(network, inputs, outs);
  return { txid: tx.txid, hex: tx.hex, feeGrains: picked.fee.toString(), changeGrains: picked.change.toString() };
}
