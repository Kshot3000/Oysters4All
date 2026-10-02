/* Pearl Bond core — fixed-income desk for PRL.
 *
 * A Pearl bond is a set of PRE-FUNDED Taproot tranche outputs. The issuer
 * locks the full coupon stream plus principal up front, so a bond is fully
 * collateralized by construction — no issuer credit risk, no oracle, no
 * custodian, no smart contracts (Pearl has none). Pure Bitcoin-style Taproot
 * script, signed locally in the browser.
 *
 * Each tranche commits a 2-leaf taptree under a NUMS internal key
 * (domain "PearlBondNUMS/v1", a point nobody controls — keypath spending is
 * impossible):
 *   leaf A (claim):    <lock> OP_CHECKLOCKTIMEVERIFY OP_DROP <holderXOnly> OP_CHECKSIG
 *   leaf B (transfer): <holderXOnly> OP_CHECKSIG
 * Leaf A pays coupons/principal to the holder after the lock height.
 * Leaf B lets the current holder reassign the tranche to a buyer at any
 * time — the secondary-market transfer path.
 *
 * Cryptography: everything is the audited Sign/Escrow/Market lineage —
 * taggedHash, tapLeafHash, Schnorr sign/verify, bech32m, BIP-86 wallets,
 * script-path spend building. The ONE new construction in this file is
 * scriptPathSigDigest83(): the BIP-341 sighash for a script-path input with
 * hash_type 0x83 (SIGHASH_SINGLE|ANYONECANPAY). It mirrors the audited
 * keypath 0x83 digest in market/src/crypto.js field-for-field (verified
 * byte-for-byte against pearld's txscript there), extended with the
 * script-path tail (spend_type 0x02, tapleaf hash, key version, codesep).
 * Its consensus byte-equality is checked in tests/ against pearld's
 * txscript.CalcTaprootSignatureHash via a Go harness (see README).
 *
 * Money math: 30/360 day count, coupons rounded to grains, dust floor 546,
 * block target 194 s (node/chaincfg/params.go TargetTimePerBlock).
 */

import {
  taggedHash, tapLeafHash, encodeBech32m, decodeBech32m,
  schnorr, sha256, bytesToHex, hexToBytes,
  varint, u32le, u64le, p2trScriptPubKey, txidLE, dblSha,
  DUST_GRAIN, GRAIN_PER_PRL, NETWORKS,
  walletFromMnemonic, newMnemonic, walletFromWIF, walletFromPriv,
  keypathSigDigestEx,
  fetchUtxos, fetchFeeRateGrainsPerVByte, broadcastTx, fetchTxStatus,
} from "../../sign/src/crypto.js";
import {
  fmtPRL, parsePRL,
  SIGHASH_DEFAULT,
} from "../../sign/src/sign-core.js";
import {
  partyKeyFromInput, parseXOnlyKey, scriptPathSigDigestEx,
  signForXOnly, verifySchnorrSig, verifyControlBlock,
  buildScriptPathSpend, spendVBytes, planSpend,
  addressToProgram, scriptAsm, encodeScriptNum, pushData,
} from "../../escrow/src/escrow-core.js";
import { bytesToNumberBE } from "@noble/curves/abstract/utils";

export {
  DUST_GRAIN, GRAIN_PER_PRL, NETWORKS,
  walletFromMnemonic, newMnemonic, walletFromWIF, walletFromPriv,
  fetchUtxos, fetchFeeRateGrainsPerVByte, broadcastTx, fetchTxStatus,
  bytesToHex, hexToBytes, schnorr, sha256, dblSha,
  encodeBech32m, decodeBech32m, p2trScriptPubKey, txidLE,
  partyKeyFromInput, parseXOnlyKey, scriptAsm, addressToProgram,
  verifySchnorrSig, signForXOnly, scriptPathSigDigestEx,
  encodeScriptNum, spendVBytes, planSpend, fmtPRL, parsePRL,
};

export const BLOCKBOOK_MAINNET = "https://blockbook.pearlresearch.ai";
export const BLOCK_TIME_SEC = 194; // node/chaincfg/params.go TargetTimePerBlock
export const MAX_PERIODS = 240;    // up to 30y monthly
export const SIGHASH_SINGLE_ANYONECANPAY = 0x83;
export const SEQ_NONFINAL = 0xfffffffe; // CLTV-safe, RBF-opt-in
export const SEQ_FINAL = 0xffffffff;
export const DESCRIPTOR_PREFIX = "bond:v1";

const OP = { DROP: 0x75, CHECKSIG: 0xac, CLTV: 0xb1 };
const TAPLEAF_VERSION = 0xc0;
const LOCKTIME_THRESHOLD = 500_000_000;

/* ---------------- terms ---------------- */

/** Parse + validate bond terms. Throws with a human message on bad input. */
export function parseBondTerms(t) {
  if (!t || typeof t !== "object") throw new Error("terms required");
  const name = String(t.name ?? "").trim().slice(0, 48) || "Unnamed series";
  const faceGrains = toGrains(t.facePRL, "face value");
  if (faceGrains < DUST_GRAIN) throw new Error(`face value below dust (${DUST_GRAIN} grains)`);
  const annualBps = toInt(t.annualBps, "annual coupon (bps)", 0, 100_000);
  const freq = toInt(t.frequency, "coupon frequency", 1, 12);
  if (![1, 2, 4, 12].includes(freq)) throw new Error("frequency must be 1, 2, 4 or 12 coupons per year");
  const periods = toInt(t.periods, "number of periods", 1, MAX_PERIODS);
  const issueHeight = toInt(t.issueHeight, "issue height", 0, 10_000_000);
  return { name, faceGrains, annualBps, frequency: freq, periods, issueHeight };
}

function toInt(v, label, min, max) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label} must be an integer in ${min}..${max}`);
  return n;
}

function toGrains(prl, label) {
  // parsePRL returns BigInt; keep integer grains as Number (safe range checked)
  const g = BigInt(parsePRL(String(prl)));
  if (g > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label} too large`);
  const n = Number(g);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${label} must be a positive PRL amount`);
  return n;
}

/* ---------------- schedule math (30/360) ---------------- */

/** Coupon per period in grains (rounded). */
export function couponGrains(terms) {
  const c = Math.round((terms.faceGrains * terms.annualBps) / 10_000 / terms.frequency);
  if (c < DUST_GRAIN && terms.annualBps > 0) {
    throw new Error(`coupon would be ${c} grains — below dust; raise face, rate, or lower frequency`);
  }
  return c;
}

/** Lock height of coupon period i (1-based). */
export function lockHeightForPeriod(terms, i) {
  const months = (i * 12) / terms.frequency;
  const blocks = Math.round((months * 30 * 86400) / BLOCK_TIME_SEC);
  const h = terms.issueHeight + blocks;
  if (h >= LOCKTIME_THRESHOLD) throw new Error("lock height exceeds locktime height range");
  return h;
}

/** Full tranche schedule: periods coupons + principal at maturity. */
export function couponSchedule(terms) {
  const c = couponGrains(terms);
  const out = [];
  for (let i = 1; i <= terms.periods; i++) {
    const last = i === terms.periods;
    const amount = last ? c + terms.faceGrains : c;
    if (amount < DUST_GRAIN) throw new Error(`tranche ${i} below dust`);
    out.push({
      index: i, kind: last ? "coupon+principal" : "coupon",
      amountGrains: amount, couponGrains: c,
      principalGrains: last ? terms.faceGrains : 0,
      lockHeight: lockHeightForPeriod(terms, i),
      approxMonths: (i * 12) / terms.frequency,
    });
  }
  // locks must strictly increase (short periods on fast chains could collide)
  for (let i = 1; i < out.length; i++) {
    if (out[i].lockHeight <= out[i - 1].lockHeight) {
      throw new Error(`periods ${i} and ${i + 1} map to the same lock height — lengthen the term`);
    }
  }
  return out;
}

/** Total funding the issuer must lock (sum of tranches). */
export function totalFundingGrains(schedule) {
  return schedule.reduce((a, t) => a + t.amountGrains, 0);
}

/** Accrued interest in grains at settleTimeMs (30/360, actual elapsed days). */
export function accruedInterest(terms, settleTimeMs, issueTimeMs) {
  const c = couponGrains(terms);
  if (c === 0) return 0;
  const periodDays = 360 / terms.frequency;
  const elapsedDays = Math.max(0, (settleTimeMs - issueTimeMs) / 86_400_000);
  const inPeriod = elapsedDays % periodDays;
  return Math.round((c * inPeriod) / periodDays);
}

/** Yield to maturity (annual, decimal) for a clean price via bisection. */
export function yieldToMaturity(terms, cleanPriceGrains) {
  const c = couponGrains(terms);
  const price = Number(cleanPriceGrains);
  if (!(price > 0)) throw new Error("price must be positive");
  const pv = (y) => {
    let s = 0;
    for (let i = 1; i <= terms.periods; i++) {
      const cf = i === terms.periods ? c + terms.faceGrains : c;
      s += cf / Math.pow(1 + y / terms.frequency, i);
    }
    return s;
  };
  // pv decreases monotonically in y; bracket [-0.999, 10]
  let lo = -0.999, hi = 10;
  if (pv(lo) < price) throw new Error("price above any finite yield — check inputs");
  for (let k = 0; k < 200; k++) {
    const mid = (lo + hi) / 2;
    if (pv(mid) > price) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/* ---------------- taproot tranche forging ---------------- */

/** leaf A (claim): <lock> CLTV DROP <holderXOnly> CHECKSIG — byte-identical
 *  shape to the audited vesting claim leaf. */
export function buildClaimScript(holderXOnly, lock) {
  const k = holderXOnly instanceof Uint8Array ? holderXOnly : parseXOnlyKey(holderXOnly);
  if (k.length !== 32) throw new Error("holder key must be 32 bytes");
  if (!Number.isInteger(lock) || lock < 1 || lock >= LOCKTIME_THRESHOLD) {
    throw new Error("lock must be a block height in 1..499999999");
  }
  return Uint8Array.from([...pushData(encodeScriptNum(lock)), OP.CLTV, OP.DROP, ...pushData(k), OP.CHECKSIG]);
}

/** leaf B (transfer): <holderXOnly> CHECKSIG — lets the current holder
 *  reassign the tranche to a buyer before maturity. */
export function buildTransferScript(holderXOnly) {
  const k = holderXOnly instanceof Uint8Array ? holderXOnly : parseXOnlyKey(holderXOnly);
  if (k.length !== 32) throw new Error("holder key must be 32 bytes");
  return Uint8Array.from([...pushData(k), OP.CHECKSIG]);
}

/** NUMS internal key: H("PearlBondNUMS/v1" || scripts...) lifted to the
 *  curve — nobody controls it, so keypath spending is impossible. */
export function numsInternalKeyBond(scripts) {
  if (!Array.isArray(scripts) || scripts.length !== 2) throw new Error("need exactly 2 leaf scripts");
  const preimage = Uint8Array.from(scripts.flatMap((s) => [...s]));
  for (let ctr = 0; ; ctr++) {
    const h = taggedHash("PearlBondNUMS/v1", Uint8Array.from([...preimage, ctr]));
    try {
      return schnorr.utils.pointToBytes(schnorr.utils.lift_x(bytesToNumberBE(h)));
    } catch { /* off-curve — practically unreachable, re-hash with counter */ }
  }
}

function tapBranch(a, b) {
  const [x, y] = bytesToHex(a) <= bytesToHex(b) ? [a, b] : [b, a];
  return taggedHash("TapBranch", Uint8Array.from([...x, ...y]));
}

/** 2-leaf taptree. Returns address, spk, tweak, parity, control blocks. */
export function taptreeBond(network, internalXOnly, claimScript, transferScript) {
  if (!(internalXOnly instanceof Uint8Array) || internalXOnly.length !== 32) {
    throw new Error("internal key must be 32 bytes");
  }
  const lhClaim = tapLeafHash(claimScript);
  const lhTransfer = tapLeafHash(transferScript);
  const root = tapBranch(lhClaim, lhTransfer);
  const t = taggedHash("TapTweak", Uint8Array.from([...internalXOnly, ...root]));
  const P = schnorr.utils.lift_x(bytesToNumberBE(internalXOnly));
  const Q = P.add(schnorr.Point.BASE.multiply(bytesToNumberBE(t)));
  const tweakedX = schnorr.utils.pointToBytes(Q);
  const parity = Q.toAffine().y & 1n ? 1 : 0;
  const mkCb = (sib) => Uint8Array.from([TAPLEAF_VERSION | parity, ...internalXOnly, ...sib]);
  return {
    leafHashes: { claim: lhClaim, transfer: lhTransfer },
    root, tweak: t, tweakedX, parity, internalXOnly,
    address: encodeBech32m(network.hrp, 1, tweakedX),
    spk: p2trScriptPubKey(tweakedX),
    claimControlBlock: mkCb(lhTransfer),
    transferControlBlock: mkCb(lhClaim),
  };
}

/** Forge one tranche: returns everything the UI and the verifier need. */
export function forgeTranche(network, holderXOnly, lock) {
  const claimScript = buildClaimScript(holderXOnly, lock);
  const transferScript = buildTransferScript(holderXOnly);
  const internalXOnly = numsInternalKeyBond([claimScript, transferScript]);
  const tree = taptreeBond(network, internalXOnly, claimScript, transferScript);
  return {
    lock, holder: bytesToHex(holderXOnly instanceof Uint8Array ? holderXOnly : parseXOnlyKey(holderXOnly)),
    claimScript, transferScript, internalXOnly,
    tweakedX: tree.tweakedX, parity: tree.parity,
    address: tree.address, spk: tree.spk,
    claimControlBlock: tree.claimControlBlock,
    transferControlBlock: tree.transferControlBlock,
    claimAsm: scriptAsm(claimScript), transferAsm: scriptAsm(transferScript),
  };
}

/** Forge every tranche of a bond for a holder key. holder may be a
 *  {key, mode} from partyKeyFromInput() — mode 'address' uses the address
 *  program as the leaf key (holder signs with the matching key). */
export function forgeBond(network, terms, holder) {
  if (!network || !network.hrp) throw new Error("network required");
  const hk = holder && typeof holder === "object" && holder.key ? holder : partyKeyFromInput(holder, network);
  const hx = hk.key instanceof Uint8Array ? hk.key : parseXOnlyKey(hk.key);
  const schedule = couponSchedule(terms);
  const tranches = schedule.map((s) => ({ ...s, ...forgeTranche(network, hx, s.lockHeight) }));
  return {
    terms, holderMode: hk.mode || "raw",
    holderKey: bytesToHex(hx),
    descriptor: encodeBondDescriptor(network, terms, hk),
    tranches,
    totalGrains: totalFundingGrains(schedule),
  };
}

/* ---------------- bond descriptor (shareable, re-derivable) ---------------- */

const NET_LETTER = { mainnet: "m", testnet: "t", regtest: "r" };
const LETTER_NET = { m: "mainnet", t: "testnet", r: "regtest" };

/** Compact descriptor: anyone with it re-derives every tranche address. */
export function encodeBondDescriptor(network, terms, holder) {
  const hk = holder && typeof holder === "object" && holder.key ? holder : partyKeyFromInput(holder, network);
  const letter = NET_LETTER[network.id] || "m";
  const mode = hk.mode === "address" ? "addr" : "raw";
  const keyHex = hk.key instanceof Uint8Array ? bytesToHex(hk.key) : String(hk.key);
  return [DESCRIPTOR_PREFIX, letter, terms.faceGrains, terms.annualBps,
    terms.frequency, terms.periods, terms.issueHeight, mode, keyHex].join("/");
}

export function decodeBondDescriptor(desc) {
  if (typeof desc !== "string") throw new Error("descriptor must be a string");
  const p = desc.trim().split("/");
  if (p.length !== 9 || p[0] !== DESCRIPTOR_PREFIX) throw new Error("bad bond descriptor");
  const netName = LETTER_NET[p[1]];
  if (!netName || !NETWORKS[netName]) throw new Error("bad network in descriptor");
  const terms = parseBondTerms({
    facePRL: (Number(p[2]) / GRAIN_PER_PRL).toFixed(8),
    annualBps: Number(p[3]), frequency: Number(p[4]),
    periods: Number(p[5]), issueHeight: Number(p[6]),
  });
  if (!/^[0-9a-fA-F]{64}$/.test(p[8])) throw new Error("bad holder key in descriptor");
  if (p[7] !== "raw" && p[7] !== "addr") throw new Error("bad holder mode in descriptor");
  return { network: NETWORKS[netName], terms, holder: { key: hexToBytes(p[8].toLowerCase()), mode: p[7] === "addr" ? "address" : "raw" } };
}

/** Re-derive every tranche address from a descriptor (the audit one-liner). */
export function verifyDescriptor(desc) {
  const { network, terms, holder } = decodeBondDescriptor(desc);
  const bond = forgeBond(network, terms, holder);
  return {
    network: network.id, terms, holderMode: bond.holderMode,
    descriptor: bond.descriptor,
    tranches: bond.tranches.map((t) => ({
      index: t.index, kind: t.kind, amountGrains: t.amountGrains,
      lockHeight: t.lockHeight, address: t.address,
      spkHex: bytesToHex(t.spk),
    })),
  };
}

/* ---------------- funding plan ---------------- */

/** Issuer funding checklist: total lock + exact outputs + fee estimate. */
export function fundingPlan(bond, feeRateGrainsPerVByte, nFundingInputs = 1) {
  if (!Number.isFinite(feeRateGrainsPerVByte) || feeRateGrainsPerVByte <= 0) {
    throw new Error("fee rate must be positive");
  }
  const nOut = bond.tranches.length;
  // Funding spends are ordinary keypath P2TR inputs (issuer's wallet):
  // vBytes = 10.5 + 57.25*nIn + 43*nOut (ceil), same formula the fee
  // estimator in Pearl Sign uses for keypath spends.
  const vBytes = Math.ceil(10.5 + 57.25 * nFundingInputs + 43 * nOut);
  const fee = Math.ceil(vBytes * feeRateGrainsPerVByte);
  return {
    tranches: bond.tranches.map((t) => ({
      index: t.index, kind: t.kind, address: t.address,
      amountGrains: t.amountGrains, lockHeight: t.lockHeight,
    })),
    totalGrains: bond.totalGrains,
    estFeeGrains: fee, estVBytes: vBytes,
    grandTotalGrains: bond.totalGrains + fee,
    feeRateGrainsPerVByte,
  };
}

/* ---------------- claim (leaf A, after maturity) ---------------- */

function validOutpoint(txid, vout) {
  const t = String(txid || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(t)) throw new Error("funding txid must be 64 hex characters");
  if (!Number.isInteger(vout) || vout < 0) throw new Error("vout must be a non-negative integer");
  return t;
}

/** Build + sign a claim of one matured tranche to destProgram.
 *  Returns the signed tx; every signature is re-verified before return. */
export function planClaim(network, tranche, outpoint, destProgram, feeRateGrainsPerVByte, currentHeight) {
  if (!(destProgram instanceof Uint8Array) || destProgram.length !== 32) {
    throw new Error("destination program must be 32 bytes");
  }
  if (!Number.isInteger(currentHeight) || currentHeight < 0) throw new Error("current height required");
  if (currentHeight < tranche.lockHeight) {
    throw new Error(`tranche locked until height ${tranche.lockHeight} (chain at ${currentHeight})`);
  }
  const txid = validOutpoint(outpoint.txid, outpoint.vout);
  const input = {
    txid, vout: outpoint.vout, value: outpoint.value, spk: tranche.spk,
  };
  if (!Number.isSafeInteger(input.value) || input.value <= 0) throw new Error("bad tranche value");
  if (!Number.isFinite(feeRateGrainsPerVByte) || feeRateGrainsPerVByte <= 0) {
    throw new Error("fee rate must be positive");
  }
  // Single payment, no change output: fee from the exact witness size, the
  // rest goes to the destination (dust remainder folds into the fee).
  const scriptLen = tranche.claimScript.length;
  const controlLen = tranche.claimControlBlock.length;
  const vBytes = spendVBytes({ nOut: 1, scriptLen, controlLen, stackLens: [64] });
  const fee = Math.ceil(vBytes * feeRateGrainsPerVByte);
  const payValue = input.value - fee;
  if (payValue < DUST_GRAIN) throw new Error(`tranche value ${input.value} cannot cover fee ${fee}`);
  const outputs = [{ program: destProgram, value: payValue }];
  return { input, outputs, fee, vBytes, lockHeight: tranche.lockHeight };
}

/** Sign a planned claim with the holder's privkey (32 bytes). */
export function signClaim(network, tranche, planned, holderPriv) {
  const digest = scriptPathSigDigestEx(network, planned.input, planned.outputs, tranche.claimScript, {
    sequence: SEQ_NONFINAL, locktime: tranche.lockHeight,
  });
  const sig = signForXOnly(holderPriv, digest);
  if (!verifySchnorrSig(sig, digest, tranche.holder)) {
    throw new Error("claim signature failed local re-verification — refusing to build");
  }
  const built = buildScriptPathSpend(network, planned.input, planned.outputs,
    tranche.claimScript, tranche.claimControlBlock, [sig],
    { sequence: SEQ_NONFINAL, locktime: tranche.lockHeight });
  return { ...built, sig: bytesToHex(sig), digest: bytesToHex(digest) };
}

/* ---------------- secondary transfer (leaf B, 0x83 presign) ---------------- */

/** BIP-341 sighash for a script-path input with hash_type 0x83
 *  (SIGHASH_SINGLE | ANYONECANPAY).
 *
 *  Layout mirrors the audited keypath 0x83 digest in market/src/crypto.js
 *  (itself verified byte-for-byte against pearld's
 *  node/txscript calcTaprootSignatureHashRaw), with the script-path tail:
 *    0x00 || 0x83 || nVersion || nLockTime ||
 *    (ANYONECANPAY: omit sha_prevouts/amounts/spks/sequences) ||
 *    (SINGLE: omit sha_outputs) ||
 *    0x02 (spend_type: script path, ext_flag=1, no annex) ||
 *    outpoint || amount || spk || nSequence ||
 *    sha256(CTxOut at input index) ||
 *    tapleaf_hash || key_version (0x00) || codesep (0xffffffff)
 *  then taggedHash("TapSighash", ...).
 */
export function scriptPathSigDigest83(network, input, output, leafScript, sequence = SEQ_FINAL) {
  const sha = (b) => sha256(b);
  if (!/^[0-9a-f]{64}$/i.test(input.txid || "")) throw new Error("bad input txid");
  if (!Number.isInteger(input.vout) || input.vout < 0) throw new Error("bad input vout");
  if (!Number.isSafeInteger(input.value) || input.value <= 0) throw new Error("bad input value");
  if (!(input.spk instanceof Uint8Array) || input.spk.length === 0) throw new Error("bad input spk");
  if (!(output.program instanceof Uint8Array) || output.program.length !== 32) {
    throw new Error("output program must be 32 bytes");
  }
  if (!Number.isSafeInteger(output.value) || output.value < DUST_GRAIN) {
    throw new Error(`output below dust (${DUST_GRAIN} grains)`);
  }
  if (!(leafScript instanceof Uint8Array) || leafScript.length === 0) throw new Error("bad leaf script");
  const msg = [0x00, SIGHASH_SINGLE_ANYONECANPAY, ...u32le(network.txVersion), ...u32le(0)];
  // ANYONECANPAY: sha_prevouts / sha_amounts / sha_scriptpubkeys / sha_sequences omitted.
  // SINGLE: sha_outputs omitted.
  msg.push(0x02); // spend_type: script path (ext_flag=1), no annex
  msg.push(...txidLE(input.txid), ...u32le(input.vout), ...u64le(input.value),
    ...varint(input.spk.length), ...input.spk, ...u32le(sequence));
  const s = p2trScriptPubKey(output.program);
  msg.push(...sha(Uint8Array.from([...u64le(output.value), ...varint(s.length), ...s])));
  msg.push(...tapLeafHash(leafScript), 0x00, 0xff, 0xff, 0xff, 0xff);
  return taggedHash("TapSighash", Uint8Array.from(msg));
}

/** Marginal vBytes one transfer leg adds to the buyer's fill tx:
 *  input base (41) + output (43) + witness (sig65 + script + control). */
export function transferLegVBytes(transferScriptLen, controlLen = 65) {
  const wit = 1 + (1 + 65) + (1 + transferScriptLen) + (1 + controlLen);
  return 84 + wit / 4;
}

/** Seller presigns one tranche's transfer (leaf B) to the buyer's tranche
 *  address. The 0x83 signature commits to this input + output[0] only, so
 *  the buyer can append their payment input/outputs without invalidating it.
 *  Returns the transfer package the buyer verifies. */
export function presignTransferLeg(network, tranche, outpoint, sellerPriv, buyerProgram, feeRateGrainsPerVByte) {
  if (!(buyerProgram instanceof Uint8Array) || buyerProgram.length !== 32) {
    throw new Error("buyer tranche program must be 32 bytes");
  }
  if (!Number.isFinite(feeRateGrainsPerVByte) || feeRateGrainsPerVByte <= 0) {
    throw new Error("fee rate must be positive");
  }
  const txid = validOutpoint(outpoint.txid, outpoint.vout);
  if (!Number.isSafeInteger(outpoint.value) || outpoint.value <= 0) throw new Error("bad tranche value");
  const legVBytes = transferLegVBytes(tranche.transferScript.length, tranche.transferControlBlock.length);
  const feeLeg = Math.ceil(legVBytes * feeRateGrainsPerVByte);
  const outValue = outpoint.value - feeLeg;
  if (outValue < DUST_GRAIN) {
    throw new Error(`tranche value cannot cover the transfer leg fee (${feeLeg} grains)`);
  }
  const input = { txid, vout: outpoint.vout, value: outpoint.value, spk: tranche.spk };
  const output = { program: buyerProgram, value: outValue };
  const digest = scriptPathSigDigest83(network, input, output, tranche.transferScript, SEQ_FINAL);
  const sig = signForXOnly(sellerPriv, digest);
  if (!verifySchnorrSig(sig, digest, tranche.holder)) {
    throw new Error("transfer presignature failed local re-verification — refusing to export");
  }
  const sig65 = Uint8Array.from([...sig, SIGHASH_SINGLE_ANYONECANPAY]);
  return {
    version: 1, trancheIndex: tranche.index, kind: tranche.kind,
    lockHeight: tranche.lockHeight, trancheValue: outpoint.value,
    input: { txid, vout: outpoint.vout, value: outpoint.value, spkHex: bytesToHex(tranche.spk) },
    sellerXOnly: tranche.holder,
    internalXOnlyHex: bytesToHex(tranche.internalXOnly),
    tweakedXHex: bytesToHex(tranche.tweakedX),
    transferScriptHex: bytesToHex(tranche.transferScript),
    transferControlBlockHex: bytesToHex(tranche.transferControlBlock),
    output: { programHex: bytesToHex(buyerProgram), value: outValue },
    feeRateGrainsPerVByte, feeLegGrains: feeLeg, sequence: SEQ_FINAL,
    digestHex: bytesToHex(digest), sig65Hex: bytesToHex(sig65),
  };
}

/** Buyer-side verification of a transfer package. Recomputes the digest
 *  from the package fields, checks the Schnorr signature against the
 *  seller's leaf key, validates the control block binds the leaf, and
 *  re-derives the leg fee. Throws on anything unexpected. */
export function verifyTransferLeg(network, pkg) {
  if (!pkg || pkg.version !== 1) throw new Error("bad transfer package version");
  const transferScript = hexToBytes(pkg.transferScriptHex);
  const controlBlock = hexToBytes(pkg.transferControlBlockHex);
  const internalXOnly = hexToBytes(pkg.internalXOnlyHex);
  const tweakedX = hexToBytes(pkg.tweakedXHex);
  const input = {
    txid: pkg.input.txid, vout: pkg.input.vout, value: pkg.input.value,
    spk: hexToBytes(pkg.input.spkHex),
  };
  const output = { program: hexToBytes(pkg.output.programHex), value: pkg.output.value };
  // 1. control block binds this leaf under the committed internal key
  if (!verifyControlBlock(internalXOnly, transferScript, controlBlock, tweakedX)) {
    throw new Error("control block does not bind the transfer leaf — package forged or corrupted");
  }
  // 2. the spk really is this taptree's output
  if (bytesToHex(p2trScriptPubKey(tweakedX)) !== bytesToHex(input.spk)) {
    throw new Error("input spk does not match the package taptree");
  }
  // 3. fee math re-derived
  const expectFee = Math.ceil(transferLegVBytes(transferScript.length, controlBlock.length) * pkg.feeRateGrainsPerVByte);
  if (expectFee !== pkg.feeLegGrains) throw new Error("leg fee mismatch");
  if (pkg.output.value !== pkg.input.value - pkg.feeLegGrains) throw new Error("output value mismatch");
  // 4. digest recomputation + signature check
  const digest = scriptPathSigDigest83(network, input, output, transferScript, pkg.sequence);
  if (bytesToHex(digest) !== pkg.digestHex.toLowerCase()) throw new Error("digest mismatch — package tampered");
  const sig65 = hexToBytes(pkg.sig65Hex);
  if (sig65.length !== 65 || sig65[64] !== SIGHASH_SINGLE_ANYONECANPAY) {
    throw new Error("presignature must be 65 bytes ending in 0x83");
  }
  if (!verifySchnorrSig(sig65.slice(0, 64), digest, hexToBytes(pkg.sellerXOnly))) {
    throw new Error("seller presignature INVALID for this leg — do not pay");
  }
  return {
    ok: true, trancheIndex: pkg.trancheIndex, kind: pkg.kind,
    inputValue: pkg.input.value, buyerReceives: pkg.output.value,
    sellerXOnly: pkg.sellerXOnly,
  };
}

/** Buyer builds the fill tx: each verified leg's tranche input (with the
 *  seller's 0x83 witness) at index i, buyer tranche output at index i
 *  (SINGLE commits input i <-> output i), then the seller's payment and the
 *  buyer's change. The buyer signs their payment input SIGHASH_DEFAULT.
 *
 *  legs: verified transfer packages (in order); priceGrains: total agreed
 *  price, split across legs pro-rata; buyerUtxo: {txid,vout,value,spk,priv};
 *  sellerPayProgram / buyerChangeProgram: 32-byte programs. */
export function buildFillTx(network, legs, priceGrains, buyerUtxo, sellerPayProgram, buyerChangeProgram, feeRateGrainsPerVByte) {
  if (!Array.isArray(legs) || legs.length === 0 || legs.length > MAX_PERIODS) {
    throw new Error("need 1..N verified legs");
  }
  // Each tranche input may appear only once: repeating an outpoint would
  // build a tx that double-spends the same UTXO (consensus-invalid).
  const seenOutpoints = new Set();
  for (const leg of legs) {
    const k = String(leg.input.txid).toLowerCase() + ":" + leg.input.vout;
    if (seenOutpoints.has(k)) throw new Error(`duplicate leg outpoint ${k} — each tranche input once`);
    seenOutpoints.add(k);
  }
  if (!Number.isSafeInteger(priceGrains) || priceGrains < 0) throw new Error("bad price");
  for (const p of [sellerPayProgram, buyerChangeProgram]) {
    if (!(p instanceof Uint8Array) || p.length !== 32) throw new Error("payment programs must be 32 bytes");
  }
  if (!Number.isFinite(feeRateGrainsPerVByte) || feeRateGrainsPerVByte <= 0) throw new Error("bad fee rate");
  const bu = buyerUtxo;
  if (!/^[0-9a-f]{64}$/i.test(bu.txid || "") || !Number.isInteger(bu.vout) || bu.vout < 0) {
    throw new Error("bad buyer utxo outpoint");
  }
  if (!Number.isSafeInteger(bu.value) || bu.value <= 0) throw new Error("bad buyer utxo value");
  if (!(bu.spk instanceof Uint8Array) || bu.spk.length !== 34) throw new Error("buyer utxo spk must be a P2TR spk");
  if (!(bu.priv instanceof Uint8Array) || bu.priv.length !== 32) throw new Error("buyer privkey must be 32 bytes");

  // Outputs: [buyer tranche 0..n-1, seller payment, buyer change?]
  const totalTrancheIn = legs.reduce((a, l) => a + l.input.value, 0);
  const outputs = [];
  let priceLeft = priceGrains;
  legs.forEach((leg, i) => {
    const last = i === legs.length - 1;
    const share = last ? priceLeft : Math.floor((priceGrains * leg.input.value) / totalTrancheIn);
    priceLeft -= share;
    leg._sellerShare = share;
    outputs.push({ program: hexToBytes(leg.output.programHex), value: leg.output.value });
  });
  if (priceGrains >= DUST_GRAIN) outputs.push({ program: sellerPayProgram, value: priceGrains });

  const nIn = legs.length + 1;
  const witLeg = (leg) => {
    const script = hexToBytes(leg.transferScriptHex);
    const cb = hexToBytes(leg.transferControlBlockHex);
    return 1 + 66 + (1 + script.length) + (1 + cb.length);
  };
  // vBytes with change output, then without
  const vBytesFor = (nOut) => {
    const base = 4 + 1 + nIn * 41 + 1 + nOut * 43 + 4;
    let wit = 0;
    for (const leg of legs) wit += witLeg(leg);
    wit += 1 + 65; // buyer keypath witness: count + 64-byte sig
    const total = base + 2 + wit;
    return Math.ceil((base * 3 + total) / 4);
  };

  const totalIn = totalTrancheIn + bu.value;
  const trancheOut = outputs.reduce((a, o) => a + o.value, 0);
  let fee = Math.ceil(vBytesFor(outputs.length + 1) * feeRateGrainsPerVByte);
  let change = totalIn - trancheOut - fee;
  let withChange = true;
  if (change < DUST_GRAIN) {
    fee = Math.ceil(vBytesFor(outputs.length) * feeRateGrainsPerVByte);
    change = totalIn - trancheOut - fee;
    withChange = false;
    if (change > 0) { fee += change; change = 0; }
  }
  if (change < 0) throw new Error(`buyer funds short: need ${trancheOut + fee} grains, have ${totalIn}`);
  if (withChange) outputs.push({ program: buyerChangeProgram, value: change });
  const vBytes = vBytesFor(outputs.length);

  // Serialize. Inputs: legs (script-path) then buyer keypath input.
  const inParts = [];
  const witnesses = [];
  legs.forEach((leg) => {
    inParts.push(...txidLE(leg.input.txid), ...u32le(leg.input.vout), ...varint(0), ...u32le(leg.sequence));
    const sig65 = hexToBytes(leg.sig65Hex);
    const script = hexToBytes(leg.transferScriptHex);
    const cb = hexToBytes(leg.transferControlBlockHex);
    const w = [3, ...varint(65), ...sig65, ...varint(script.length), ...script, ...varint(cb.length), ...cb];
    witnesses.push(w);
  });
  const buyerSeq = SEQ_NONFINAL; // buyer keeps RBF on their own input
  inParts.push(...txidLE(bu.txid.toLowerCase()), ...u32le(bu.vout), ...varint(0), ...u32le(buyerSeq));
  const buyerWitIdx = witnesses.length;
  witnesses.push(null); // filled after signing

  const outParts = [];
  for (const o of outputs) {
    const s = p2trScriptPubKey(o.program);
    outParts.push(...u64le(o.value), ...varint(s.length), ...s);
  }
  const base = [...u32le(network.txVersion), ...varint(nIn), ...inParts,
    ...varint(outputs.length), ...outParts, ...u32le(0)];
  const txid = bytesToHex(dblSha(Uint8Array.from(base)).reverse());

  // Buyer signs their input SIGHASH_DEFAULT over the full input/output set.
  const allInputs = legs.map((leg) => ({
    txid: leg.input.txid, vout: leg.input.vout, value: leg.input.value,
    spk: hexToBytes(leg.input.spkHex),
  }));
  allInputs.push({ txid: bu.txid.toLowerCase(), vout: bu.vout, value: bu.value, spk: bu.spk });
  const seqs = [...legs.map((l) => l.sequence), buyerSeq];
  const digest = keypathSigDigestExMulti(network, allInputs, outputs, seqs, legs.length, SIGHASH_DEFAULT);
  const sig = signForXOnly(bu.priv, digest);
  witnesses[buyerWitIdx] = [1, ...varint(64), ...sig];

  const witFlat = witnesses.flatMap((w) => w);
  const full = [...u32le(network.txVersion), 0x00, 0x01, ...varint(nIn), ...inParts,
    ...varint(outputs.length), ...outParts, ...witFlat, ...u32le(0)];
  return {
    hex: bytesToHex(Uint8Array.from(full)), txid,
    feeGrains: fee, vBytes, nLegs: legs.length,
    buyerPaid: priceGrains, buyerChange: withChange ? change : 0,
    buyerDigestHex: bytesToHex(digest), buyerSigHex: bytesToHex(sig),
  };
}

/** Multi-input keypath sighash (SIGHASH_DEFAULT) for the buyer's input.
 *  crypto.js keypathSigDigestEx takes one shared sequence; the fill tx mixes
 *  SEQ_FINAL (legs) and SEQ_NONFINAL (buyer), so sequences are per-input. */
function keypathSigDigestExMulti(network, inputs, outputs, sequences, idx, hashType) {
  const sha = (b) => sha256(b);
  const msg = [0x00, hashType, ...u32le(network.txVersion), ...u32le(0)];
  msg.push(...sha(Uint8Array.from(inputs.flatMap((i) => [...txidLE(i.txid), ...u32le(i.vout)]))));
  msg.push(...sha(Uint8Array.from(inputs.flatMap((i) => u64le(i.value)))));
  msg.push(...sha(Uint8Array.from(inputs.flatMap((i) => [...varint(i.spk.length), ...i.spk]))));
  msg.push(...sha(Uint8Array.from(sequences.flatMap((s) => u32le(s)))));
  msg.push(...sha(Uint8Array.from(outputs.flatMap((o) => {
    const s = p2trScriptPubKey(o.program);
    return [...u64le(o.value), ...varint(s.length), ...s];
  }))));
  msg.push(0x00, ...u32le(idx)); // spend_type keypath, input index
  return taggedHash("TapSighash", Uint8Array.from(msg));
}

/* ---------------- tracking ---------------- */

/** Classify each tranche against chain state.
 *  chainState: { height, info: { [address]: { balance, txs } } } */
export function classifyTranches(bond, chainState) {
  const height = chainState && Number.isInteger(chainState.height) ? chainState.height : null;
  const info = (chainState && chainState.info) || {};
  return bond.tranches.map((t) => {
    const st = info[t.address] || { balance: 0, txs: 0 };
    const funded = st.balance >= t.amountGrains;
    const matured = height === null ? null : height >= t.lockHeight;
    let status = "unfunded";
    if (funded && matured === true) status = "claimable";
    else if (funded && matured === false) status = "locked";
    else if (funded) status = "funded";
    else if (st.txs > 0 && st.balance === 0) status = "spent";
    return {
      index: t.index, kind: t.kind, address: t.address,
      amountGrains: t.amountGrains, lockHeight: t.lockHeight,
      balance: st.balance, txs: st.txs, matured, funded, status,
    };
  });
}
