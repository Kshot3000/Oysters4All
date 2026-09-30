/* Pearl Bounty core — bug-bounty / task-bounty desk for PRL.
 *
 * Pure ESM, zero build step for developers. The browser ships a committed
 * esbuild IIFE bundle (pearl-bounty.bundle.js); node runs this file directly
 * for the verification suite.
 *
 * Protocol: a two-leaf Taproot bounty output under a NUMS internal key (no
 * keypath bypass — keypath spends are impossible by construction, asserted
 * in tests).
 *   Leaf A (award): <poster_xonly> OP_CHECKSIG
 *     The poster's signature IS the award decision: the poster signs a payout
 *     transaction to the winning hunter's address (full pot, or a chosen
 *     award amount with the remainder returned to the poster as change).
 *     Script cannot judge solution quality — the poster can, and their key
 *     does. This is stated loudly in the UI: a bounty is a TRUSTED-poster
 *     instrument, trustless only in the reclaim direction.
 *   Leaf B (reclaim): <deadline> OP_CHECKLOCKTIMEVERIFY OP_DROP <poster_xonly> OP_CHECKSIG
 *     After absolute block height `deadline` the poster can unilaterally
 *     reclaim the pot (tx nLockTime = deadline, input sequence < 0xffffffff).
 *     Hunters' funds are never at risk — only the poster funds the output.
 *
 * Hunters compete off-chain: each hunter submits a SHA-256 solution
 * commitment to the desk (handle + commitment), and reveals the solution to
 * the poster out-of-band. The commitment binds handle+descriptor+solution+
 * salt, so a hunter can't be front-run by someone copying their revealed
 * solution under a different name. Submissions live in the page's
 * localStorage only — there is no listing relay, and the UI says so.
 *
 * Crypto lineage: key derivation, TapTweak, bech32m, BIP-341 sighash, wire
 * serialization and the segwit tx parser come from the audited
 * files/pages/sign/src/crypto.js (verified byte-for-byte against Pearl's Go
 * reference node/txscript); script-path sighash/spend/fee helpers, the CLTV
 * reclaim leaf, and the planSpend change-folder come from the audited
 * files/pages/escrow/src/escrow-core.js (themselves verified against the
 * consensus implementation). New here: only the award script template, the
 * "PearlBountyNUMS/v1" NUMS derivation, the bounty spec/descriptor, the
 * submission-commitment scheme, the award/reclaim spend builders, and the
 * bounty-watch status classifier. The award/reclaim scripts use only opcodes
 * Pearl consensus supports (OP_CHECKSIG, OP_CHECKLOCKTIMEVERIFY, OP_DROP).
 */

import {
  taggedHash, tapLeafHash, encodeBech32m, decodeBech32m,
  schnorr, sha256, bytesToHex, hexToBytes, convertBits,
  p2trScriptPubKey, txidLE, dblSha, u64le, u32le, varint,
  DUST_GRAIN, GRAIN_PER_PRL, NETWORKS,
  walletFromMnemonic, walletFromWIF, walletFromPriv, walletToWIF,
  fetchUtxos, fetchFeeRateGrainsPerVByte, broadcastTx, fetchTxStatus,
  tweakKeypath,
} from "../../sign/src/crypto.js";
import {
  partyKeyFromInput, parseXOnlyKey, scriptPathSigDigestEx,
  signForXOnly, verifySchnorrSig, buildScriptPathSpend,
  spendVBytes, planSpend, addressToProgram, scriptAsm,
  buildRefundScript, verifyControlBlock, taptree2,
} from "../../escrow/src/escrow-core.js";
import { parseTx } from "../../swap/src/swap-core.js";
import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesToNumberBE } from "@noble/curves/abstract/utils";

export {
  DUST_GRAIN, GRAIN_PER_PRL, NETWORKS,
  walletFromMnemonic, walletFromWIF, walletFromPriv, walletToWIF,
  fetchUtxos, fetchFeeRateGrainsPerVByte, broadcastTx, fetchTxStatus,
  taggedHash, tapLeafHash, bytesToHex, hexToBytes, schnorr, sha256, convertBits,
  encodeBech32m, decodeBech32m, p2trScriptPubKey, txidLE, tweakKeypath,
  partyKeyFromInput, parseXOnlyKey, addressToProgram, parseTx, scriptAsm,
  verifySchnorrSig, signForXOnly, scriptPathSigDigestEx, buildScriptPathSpend,
  spendVBytes, planSpend, buildRefundScript, verifyControlBlock, taptree2,
};

export const BLOCKBOOK_MAINNET = "https://blockbook.pearlresearch.ai";
export const BLOCKBOOK_TESTNET = "https://blockbook-test.pearlresearch.ai";
/** Pearl target block time in seconds (pearl-knowledge.md, node/chaincfg).
 *  Day-estimates in the UI are derived from this constant and labeled. */
export const PEARL_BLOCK_SECS = 194;

export const BOUNTY_KIND = "pearl-bounty";
export const BOUNTY_VERSION = 1;
export const DESCRIPTOR_PREFIX = "bounty:v1";
/** Award outputs below this are refused as dust (audited constant). */
export const SEQ_FINAL = 0xfffffffe; // non-final sequence: enables nLockTime
export const MAX_TITLE = 120;
export const MAX_NOTE = 2000;

const TE = new TextEncoder();

function constEq(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

/* ------------------------------------------------------------------ */
/* Guards                                                              */
/* ------------------------------------------------------------------ */

/** Bounty reward in grains: positive, dust-floor, safe-integer. */
export function checkRewardGrains(g) {
  if (!Number.isSafeInteger(g) || g <= 0) throw new Error("reward must be a positive PRL amount");
  if (g < DUST_GRAIN) throw new Error(`reward ${g} grains is below the dust floor (${DUST_GRAIN} grains) — the bounty output could never be spent`);
  return g;
}

/** Absolute reclaim deadline (block height): positive, below the 500M
 *  timestamp threshold so it is unambiguously a HEIGHT, and not absurdly
 *  far in the past/future (checked against nothing on-chain — the UI warns
 *  the poster to pick a height past the intended hunting window). */
export function checkDeadlineHeight(h) {
  if (!Number.isSafeInteger(h) || h <= 0) throw new Error("deadline must be a positive block height");
  if (h >= 500000000) throw new Error("deadline must be a block height (< 500000000), not a timestamp");
  if (h < 100000) throw new Error(`deadline ${h} is below any plausible Pearl chain height — refusing (likely a paste error)`);
  return h;
}

export function checkTitle(title) {
  const t = String(title || "").trim();
  if (t.length === 0) throw new Error("give the bounty a title");
  if (t.length > MAX_TITLE) throw new Error(`title is ${t.length} chars — keep it under ${MAX_TITLE}`);
  return t;
}

/** Parse a PRL amount string ("1.5", "0.00000001") into grains (BigInt-free
 *  safe path: at most 8 decimals, result must be a safe integer). */
export function parsePRLToGrains(s) {
  const t = String(s || "").trim();
  if (!/^\d+(\.\d{1,8})?$/.test(t)) throw new Error(`"${t}" is not a PRL amount (up to 8 decimals)`);
  const [w, f = ""] = t.split(".");
  const g = Number(w) * GRAIN_PER_PRL + Number((f + "00000000").slice(0, 8));
  if (!Number.isSafeInteger(g)) throw new Error("amount out of range");
  return checkRewardGrains(g);
}

/** Format grains as a PRL amount string (no unit suffix). */
export function fmtPRL(grains) {
  const g = BigInt(grains);
  const neg = g < 0n;
  const a = neg ? -g : g;
  const whole = a / BigInt(GRAIN_PER_PRL);
  const frac = (a % BigInt(GRAIN_PER_PRL)).toString().padStart(8, "0").replace(/0+$/, "");
  return (neg ? "-" : "") + whole.toString() + (frac ? "." + frac : "");
}

/* ------------------------------------------------------------------ */
/* Script templates                                                    */
/* ------------------------------------------------------------------ */

const OP = { CHECKSIG: 0xac, CLTV: 0xb1, DROP: 0x75 };

function pushData(data) {
  const b = data instanceof Uint8Array ? data : Uint8Array.from(data);
  if (b.length === 0) return [0x00];
  if (b.length <= 75) return [b.length, ...b];
  throw new Error("push exceeds 75 bytes");
}

/** Leaf A (award): <poster_xonly> OP_CHECKSIG.
 *  The poster's signature is the award decision — it authorizes a payout to
 *  whatever address the signed transaction pays. No timelock. */
export function buildAwardScript(posterXOnly) {
  const k = posterXOnly instanceof Uint8Array ? posterXOnly : parseXOnlyKey(posterXOnly);
  if (k.length !== 32) throw new Error("poster key must be 32 bytes");
  schnorr.utils.lift_x(bytesToNumberBE(k));
  return Uint8Array.from([...pushData(k), OP.CHECKSIG]);
}

/** Leaf B (reclaim): the audited escrow CLTV refund leaf, byte-identical:
 *  <deadline> OP_CHECKLOCKTIMEVERIFY OP_DROP <poster_xonly> OP_CHECKSIG.
 *  Spendable only by the poster once chain height >= deadline, with the
 *  spending transaction's nLockTime = deadline and input sequence < 0xffffffff. */
export function buildReclaimScript(posterXOnly, deadlineHeight) {
  return buildRefundScript(posterXOnly, checkDeadlineHeight(deadlineHeight));
}

/** NUMS internal key: H("PearlBountyNUMS/v1" || leafAHash || leafBHash)
 *  lifted to the curve (leaf order canonical: award, reclaim). Nobody knows
 *  the discrete log, so keypath spending is impossible — coins move only
 *  through the two script leaves. Same construction as the audited escrow
 *  NUMS, distinct domain string. */
export function numsInternalKeyBounty(leafA, leafB) {
  if (!(leafA instanceof Uint8Array) || leafA.length === 0) throw new Error("bad award script");
  if (!(leafB instanceof Uint8Array) || leafB.length === 0) throw new Error("bad reclaim script");
  const domain = TE.encode("PearlBountyNUMS/v1");
  const preimage = Uint8Array.from([...domain, ...tapLeafHash(leafA), ...tapLeafHash(leafB)]);
  for (let counter = 0; counter < 256; counter++) {
    const pre = counter === 0 ? preimage : Uint8Array.from([...preimage, counter]);
    const h = sha256(pre);
    try {
      schnorr.utils.lift_x(bytesToNumberBE(h));
      return h;
    } catch { /* try next counter */ }
  }
  throw new Error("NUMS lift failed (unreachable in practice)");
}

/** Two-leaf taptree under the NUMS internal key. Reuses the audited
 *  escrow taptree2 (byte-identical arithmetic); the bounty difference is
 *  only the leaf templates and the NUMS domain. */
export function bountyTaptree(network, awardScript, reclaimScript) {
  const internalXOnly = numsInternalKeyBounty(awardScript, reclaimScript);
  const tree = taptree2(network, internalXOnly, awardScript, reclaimScript);
  // Belt-and-braces: the same verification a funding wallet performs.
  for (const [script, cb, name] of [
    [awardScript, tree.controlBlocks[0], "award"],
    [reclaimScript, tree.controlBlocks[1], "reclaim"],
  ]) {
    if (!verifyControlBlock(internalXOnly, script, cb, tree.tweakedX)) {
      throw new Error(`internal ${name} control-block self-check failed`);
    }
  }
  return { internalXOnly, ...tree };
}

/* ------------------------------------------------------------------ */
/* Key inputs                                                          */
/* ------------------------------------------------------------------ */

/** x-only pubkey for a 32-byte private key (even-Y normalized, BIP-340). */
export function pubkeyFromPriv(priv) {
  const p = priv instanceof Uint8Array ? priv : hexToBytes(String(priv).trim());
  if (p.length !== 32) throw new Error("private key must be 32 bytes");
  const P = secp256k1.ProjectivePoint.fromPrivateKey(p);
  return bytesToHex(P.toRawBytes(true).slice(1));
}

/**
 * Poster key: 64-hex private key, WIF, or 12/24-word mnemonic (BIP-86 account
 * key, same scheme as Pearl Sign). Returns { priv, xonly, source }.
 */
export function posterPrivFromInput(input, network) {
  const t = String(input || "").trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) return { ...walletFromPriv(hexToBytes(t.toLowerCase()), network), source: "hex private key" };
  if (/^[1-9A-HJ-NP-Za-km-z]{30,60}$/.test(t)) {
    try { return { ...walletFromWIF(t, network), source: "WIF" }; } catch { /* fall through */ }
  }
  const words = t.split(/\s+/);
  if (words.length === 12 || words.length === 24) {
    return { ...walletFromMnemonic(t, network), source: "mnemonic (BIP-86 m/86'/coin'/0'/0/0)" };
  }
  throw new Error("poster key must be a 32-byte hex private key, WIF, or a 12/24-word mnemonic");
}

/* ------------------------------------------------------------------ */
/* Bounty spec: forge / descriptor / parse / verify                     */
/* ------------------------------------------------------------------ */

/**
 * Forge a bounty. params:
 *   network: NETWORKS.mainnet | NETWORKS.testnet
 *   title, rewardPRL ("1.5"), deadlineHeight
 *   posterKeyInput + posterKeyMode ("priv" | "watch")
 *   contact: optional public contact string (<= 200 chars, informational)
 *   termsNote: optional public terms text (<= 2000 chars, informational)
 *
 * Returns { bounty, secrets }: bounty is fully serializable (safe to share);
 * secrets holds the poster private key IN MEMORY ONLY and never enters JSON.
 */
export function forgeBounty(params) {
  const { network, title, rewardPRL, deadlineHeight, posterKeyInput, posterKeyMode, contact, termsNote } = params || {};
  if (!network || !network.hrp) throw new Error("bad network");
  const cleanTitle = checkTitle(title);
  const rewardGrains = parsePRLToGrains(rewardPRL);
  checkDeadlineHeight(deadlineHeight);
  const contactClean = String(contact || "").trim().slice(0, 200);
  const termsClean = String(termsNote || "").trim().slice(0, MAX_NOTE);

  let posterXOnly, posterSource;
  const secrets = [];
  if (posterKeyMode === "watch") {
    const k = parseXOnlyKey(String(posterKeyInput || "").trim());
    posterXOnly = bytesToHex(k);
    posterSource = "watch-only x-only pubkey";
  } else if (!posterKeyMode || posterKeyMode === "priv") {
    const w = posterPrivFromInput(posterKeyInput, network);
    posterXOnly = bytesToHex(w.internalXOnly);
    posterSource = w.source;
    secrets.push({ xonly: posterXOnly, priv: bytesToHex(w.priv), role: "poster" });
  } else {
    throw new Error('posterKeyMode must be "priv" or "watch"');
  }

  const awardScript = buildAwardScript(hexToBytes(posterXOnly));
  const reclaimScript = buildReclaimScript(hexToBytes(posterXOnly), deadlineHeight);
  const tree = bountyTaptree(network, awardScript, reclaimScript);

  const bounty = {
    kind: BOUNTY_KIND,
    version: BOUNTY_VERSION,
    network: network.id,
    hrp: network.hrp,
    title: cleanTitle,
    rewardGrains,
    rewardPRL: fmtPRL(rewardGrains),
    deadlineHeight,
    posterXOnly,
    posterKeySource: posterSource,
    contact: contactClean,
    termsNote: termsClean,
    awardScriptHex: bytesToHex(awardScript),
    awardAsm: scriptAsm(awardScript),
    reclaimScriptHex: bytesToHex(reclaimScript),
    reclaimAsm: scriptAsm(reclaimScript),
    internalKeyHex: bytesToHex(tree.internalXOnly),
    tweakedHex: bytesToHex(tree.tweakedX),
    awardControlBlockHex: bytesToHex(tree.controlBlocks[0]),
    reclaimControlBlockHex: bytesToHex(tree.controlBlocks[1]),
    address: tree.address,
    spkHex: bytesToHex(tree.spk),
  };
  bounty.descriptor = bountyDescriptor(bounty);
  bounty.fingerprint = descriptorFingerprint(bounty.descriptor);
  return { bounty, secrets };
}

/** Compact descriptor: bounty:v1:<hrp>:<posterXOnlyHex>:<deadlineHeight>.
 *  Recomputable, NOT authenticated — see verifyDescriptor. */
export function bountyDescriptor(bounty) {
  return `${DESCRIPTOR_PREFIX}:${bounty.hrp}:${bounty.posterXOnly}:${bounty.deadlineHeight}`;
}

/** 64-bit fingerprint of the descriptor (first 8 bytes of SHA-256, hex). */
export function descriptorFingerprint(descriptor) {
  return bytesToHex(sha256(TE.encode(String(descriptor).trim()))).slice(0, 16);
}

export function serializeBounty(bounty) {
  return JSON.stringify(bounty);
}

/**
 * Parse + fully re-derive a bounty spec: JSON shape, field validation,
 * script rebuild from poster key + deadline, taptree re-derivation,
 * control-block self-check, descriptor round-trip. Throws on anything
 * unexpected — a tampered spec can never produce a fundable address.
 */
export function parseBountySpec(json, network) {
  let s;
  try {
    s = typeof json === "string" ? JSON.parse(json) : json;
  } catch {
    throw new Error("bounty spec is not valid JSON");
  }
  if (!s || s.kind !== BOUNTY_KIND || s.version !== BOUNTY_VERSION) {
    throw new Error("not a Pearl Bounty spec (kind pearl-bounty, version 1)");
  }
  if (s.hrp !== network.hrp) throw new Error(`spec is for ${s.hrp}, not ${network.hrp}`);
  const { bounty } = forgeBounty({
    network,
    title: s.title,
    rewardPRL: fmtPRL(checkRewardGrains(s.rewardGrains)),
    deadlineHeight: s.deadlineHeight,
    posterKeyInput: s.posterXOnly,
    posterKeyMode: "watch",
    contact: s.contact,
    termsNote: s.termsNote,
  });
  // Every re-derived CONTRACT field must match byte-for-byte — tampering with
  // the poster key, deadline, or network changes the contract, so a modified
  // spec can never pass as the original. Title, reward, contact, and terms
  // are informational (they do not affect the on-chain contract) and are
  // therefore NOT tamper-evident — they are carried through verbatim.
  for (const f of ["address", "spkHex", "awardScriptHex", "reclaimScriptHex",
    "internalKeyHex", "tweakedHex", "awardControlBlockHex", "reclaimControlBlockHex",
    "posterXOnly", "descriptor", "fingerprint", "deadlineHeight"]) {
    if (bounty[f] !== s[f]) throw new Error(`bounty spec failed re-derivation check on ${f} — the spec was tampered with`);
  }
  return { ...bounty, posterKeySource: String(s.posterKeySource || "watch-only"), contact: String(s.contact || ""), termsNote: String(s.termsNote || "") };
}

/** Parse a compact descriptor back into its fields. */
export function parseBountyDescriptor(descriptor) {
  const t = String(descriptor || "").trim();
  const parts = t.split(":");
  if (parts.length !== 5 || parts[0] !== "bounty" || parts[1] !== "v1") {
    throw new Error("bad bounty descriptor (expected bounty:v1:<hrp>:<posterXOnly>:<deadline>)");
  }
  const [, , hrp, posterXOnly, deadlineRaw] = parts;
  parseXOnlyKey(posterXOnly);
  const deadline = Number(deadlineRaw);
  if (!Number.isSafeInteger(deadline)) throw new Error("bad bounty descriptor: deadline is not an integer");
  checkDeadlineHeight(deadline);
  return { hrp, posterXOnly: posterXOnly.toLowerCase(), deadlineHeight: deadline };
}

/**
 * Standalone verifier: recompute the contract from the descriptor's poster
 * key + deadline and LOUDLY REFUSE on malformed input, network mismatch, or
 * when the recomputed address does not match the claimed address.
 */
export function verifyDescriptor(descriptor, network, expectedAddress = null) {
  const f = parseBountyDescriptor(descriptor);
  if (f.hrp !== network.hrp) {
    throw new Error(`LOUD REFUSAL — descriptor is for network ${f.hrp}, not ${network.hrp}`);
  }
  const { bounty } = forgeBounty({
    network,
    title: "descriptor verification",
    rewardPRL: fmtPRL(DUST_GRAIN),
    deadlineHeight: f.deadlineHeight,
    posterKeyInput: f.posterXOnly,
    posterKeyMode: "watch",
  });
  const expect = bountyDescriptor(bounty);
  if (expect !== String(descriptor).trim()) {
    throw new Error("LOUD REFUSAL — descriptor fields are internally inconsistent: re-derivation mismatch");
  }
  if (expectedAddress !== null && String(expectedAddress).trim() !== bounty.address) {
    throw new Error(
      `LOUD REFUSAL — this descriptor recomputes to ${bounty.address}, ` +
      `NOT to the claimed address ${String(expectedAddress).trim()}. ` +
      `The descriptor was altered (or belongs to a different bounty). Do not fund the claimed address.`
    );
  }
  return {
    bounty,
    awardHash: bytesToHex(tapLeafHash(hexToBytes(bounty.awardScriptHex))),
    reclaimHash: bytesToHex(tapLeafHash(hexToBytes(bounty.reclaimScriptHex))),
    recomputed: expect,
    fingerprint: descriptorFingerprint(expect),
  };
}

/* ------------------------------------------------------------------ */
/* Hunter submissions: commit-reveal                                   */
/* ------------------------------------------------------------------ */

function submissionPreimage({ descriptor, handle, solution, salt }) {
  const d = String(descriptor || "").trim();
  const h = String(handle || "").trim();
  const sol = String(solution || "");
  const s = String(salt || "").trim().toLowerCase();
  if (!d) throw new Error("descriptor required");
  if (h.length === 0 || h.length > 64) throw new Error("handle must be 1–64 characters");
  if (!/^[0-9a-f]{32,128}$/.test(s)) throw new Error("salt must be 16–64 bytes of hex");
  if (sol.length === 0) throw new Error("solution text is empty");
  return TE.encode(["pearl-bounty-submission:v1", d, h, sol, s].join("\n"));
}

/** Hunter commitment: SHA-256 over descriptor + handle + solution + salt.
 *  Publish the handle + commitment; keep solution + salt secret until reveal.
 *  The descriptor binding stops commitment replay across bounties. */
export function submissionCommitment(fields) {
  return bytesToHex(sha256(submissionPreimage(fields)));
}

/** Verify a hunter's reveal against their published commitment. Loud boolean,
 *  never throws on a mismatch (throws only on malformed fields). */
export function verifySubmissionReveal(commitment, fields) {
  const c = String(commitment || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(c)) throw new Error("commitment must be 64 hex characters");
  return constEq(hexToBytes(c), sha256(submissionPreimage(fields)));
}

/** Random 32-byte salt, hex. */
export function newSalt() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return bytesToHex(b);
}

/* ------------------------------------------------------------------ */
/* Award: plan + build + sign                                          */
/* ------------------------------------------------------------------ */

const AWARD_SCRIPT_LEN = 34; // <32-byte key> CHECKSIG
const CONTROL_LEN = 65;

/** Plan an award spend of one bounty UTXO.
 *  awardGrains: amount to the winner (<= utxo value). Remainder is returned
 *  to changeAddr (the poster's own address) — dust remainder is folded into
 *  the fee and disclosed. Returns { outputs, feeGrains, vBytes, changeGrains }. */
export function planAward({ network, bounty, utxo, winnerAddr, awardGrains, changeAddr, feeRateGrainsPerVByte }) {
  if (!bounty || !bounty.awardScriptHex) throw new Error("bad bounty");
  if (!Number.isSafeInteger(awardGrains) || awardGrains < DUST_GRAIN) {
    throw new Error(`award must be at least the dust floor (${DUST_GRAIN} grains)`);
  }
  if (!Number.isSafeInteger(utxo?.value) || utxo.value <= 0) throw new Error("bad utxo value");
  if (awardGrains > utxo.value) throw new Error(`award ${awardGrains} exceeds the bounty UTXO value ${utxo.value}`);
  const winnerProgram = addressToProgram(winnerAddr, network);
  const changeProgram = addressToProgram(changeAddr, network);
  const planned = planSpend({
    inputValue: utxo.value,
    payments: [{ program: winnerProgram, value: awardGrains }],
    feeRateGrainsPerVByte,
    scriptLen: AWARD_SCRIPT_LEN,
    controlLen: CONTROL_LEN,
    stackLens: [64],
  });
  const outputs = planned.outputs.map((o) => o.change
    ? { program: changeProgram, value: o.value, change: true }
    : { program: o.program, value: o.value });
  return { outputs, feeGrains: planned.fee, vBytes: planned.vBytes, changeGrains: planned.change };
}

/**
 * Build + sign the award transaction (leaf A). Guards:
 *  - signing key must be the poster's key from the spec (a hunter's or any
 *    other key is refused);
 *  - the UTXO's spk must belong to the bounty address when supplied;
 *  - the signature is re-verified before the witness is assembled;
 *  - wire-level checks: witness layout [sig, awardScript, awardCB].
 */
export function buildAwardTx({ network, bounty, utxo, posterPrivHex, winnerAddr, awardGrains, changeAddr, feeRateGrainsPerVByte }) {
  const posterXOnly = pubkeyFromPriv(posterPrivHex);
  if (posterXOnly !== bounty.posterXOnly) {
    throw new Error("this key is not the poster's award key for this bounty — award refused");
  }
  if (!/^[0-9a-f]{64}$/i.test(utxo?.txid || "")) throw new Error("bad utxo txid");
  if (!Number.isInteger(utxo?.vout) || utxo.vout < 0) throw new Error("bad utxo vout");
  const planned = planAward({ network, bounty, utxo, winnerAddr, awardGrains, changeAddr, feeRateGrainsPerVByte });
  const bountySpk = hexToBytes(bounty.spkHex);
  const input = { txid: utxo.txid.toLowerCase(), vout: utxo.vout, value: utxo.value, spk: bountySpk };
  const awardScript = hexToBytes(bounty.awardScriptHex);
  const controlBlock = hexToBytes(bounty.awardControlBlockHex);
  const outputs = planned.outputs.map((o) => ({ program: o.program, value: o.value }));
  const priv = hexToBytes(String(posterPrivHex).trim().toLowerCase());
  const digest = scriptPathSigDigestEx(network, input, outputs, awardScript, { sequence: SEQ_FINAL });
  const sig = signForXOnly(priv, digest);
  if (!verifySchnorrSig(sig, digest, hexToBytes(bounty.posterXOnly))) {
    throw new Error("award signature failed re-verification — refusing to build the tx");
  }
  const spend = buildScriptPathSpend(network, input, outputs, awardScript, controlBlock, [sig], { sequence: SEQ_FINAL });
  if (spend.digest !== bytesToHex(digest)) throw new Error("internal: award digest mismatch");
  const parsed = parseTx(spend.hex);
  if (parsed.inputs.length !== 1 || parsed.inputs[0].sequence !== SEQ_FINAL) throw new Error("internal: award sequence wrong");
  const wit = parsed.inputs[0].witness;
  if (wit.length !== 3 || wit[0].length !== 64) throw new Error("internal: award witness layout wrong");
  if (bytesToHex(wit[1]) !== bounty.awardScriptHex) throw new Error("internal: award leaf wrong");
  return { ...spend, ...planned };
}

/* ------------------------------------------------------------------ */
/* Reclaim: plan + build + sign (post-deadline CLTV)                   */
/* ------------------------------------------------------------------ */

/** Plan a reclaim spend. Refuses before the deadline with blocks-to-go. */
export function planReclaim({ network, bounty, utxo, destAddr, feeRateGrainsPerVByte, currentHeight }) {
  if (!bounty || !bounty.reclaimScriptHex) throw new Error("bad bounty");
  if (!Number.isSafeInteger(currentHeight) || currentHeight <= 0) throw new Error("bad current height");
  if (currentHeight < bounty.deadlineHeight) {
    throw new Error(
      `reclaim not yet available: chain is at ${currentHeight}, deadline is ${bounty.deadlineHeight} ` +
      `(${bounty.deadlineHeight - currentHeight} blocks to go — a reclaim broadcast now is invalid on-chain)`
    );
  }
  if (!/^[0-9a-f]{64}$/i.test(utxo?.txid || "")) throw new Error("bad utxo txid");
  if (!Number.isInteger(utxo?.vout) || utxo.vout < 0) throw new Error("bad utxo vout");
  if (!Number.isSafeInteger(utxo?.value) || utxo.value <= 0) throw new Error("bad utxo value");
  const destProgram = addressToProgram(destAddr, network);
  const vBytes = spendVBytes({ nOut: 1, scriptLen: hexToBytes(bounty.reclaimScriptHex).length, controlLen: CONTROL_LEN, stackLens: [64] });
  const fee = Math.ceil(vBytes * feeRateGrainsPerVByte);
  const value = utxo.value - fee;
  if (value < DUST_GRAIN) {
    throw new Error(`reclaim output ${value} grains is below dust after fees — UTXO too small to reclaim`);
  }
  return { outputs: [{ program: destProgram, value }], feeGrains: fee, vBytes, value };
}

/**
 * Build + sign the reclaim transaction (leaf B). Guards: poster key match,
 * signature re-verification, wire-level checks (nLockTime == deadline,
 * sequence < 0xffffffff, witness layout).
 */
export function buildReclaimTx({ network, bounty, utxo, posterPrivHex, destAddr, feeRateGrainsPerVByte, currentHeight }) {
  const posterXOnly = pubkeyFromPriv(posterPrivHex);
  if (posterXOnly !== bounty.posterXOnly) {
    throw new Error("this key is not the poster's key for this bounty — reclaim refused");
  }
  const planned = planReclaim({ network, bounty, utxo, destAddr, feeRateGrainsPerVByte, currentHeight });
  const bountySpk = hexToBytes(bounty.spkHex);
  const input = { txid: utxo.txid.toLowerCase(), vout: utxo.vout, value: utxo.value, spk: bountySpk };
  const reclaimScript = hexToBytes(bounty.reclaimScriptHex);
  const controlBlock = hexToBytes(bounty.reclaimControlBlockHex);
  const outputs = planned.outputs.map((o) => ({ program: o.program, value: o.value }));
  const priv = hexToBytes(String(posterPrivHex).trim().toLowerCase());
  // CLTV: nLockTime = deadline, sequence non-final.
  const digest = scriptPathSigDigestEx(network, input, outputs, reclaimScript, { sequence: SEQ_FINAL, locktime: bounty.deadlineHeight });
  const sig = signForXOnly(priv, digest);
  if (!verifySchnorrSig(sig, digest, hexToBytes(bounty.posterXOnly))) {
    throw new Error("reclaim signature failed re-verification — refusing to build the tx");
  }
  const spend = buildScriptPathSpend(network, input, outputs, reclaimScript, controlBlock, [sig],
    { sequence: SEQ_FINAL, locktime: bounty.deadlineHeight });
  if (spend.digest !== bytesToHex(digest)) throw new Error("internal: reclaim digest mismatch");
  const parsed = parseTx(spend.hex);
  if (parsed.locktime !== bounty.deadlineHeight) throw new Error("internal: reclaim locktime != deadline");
  if (parsed.inputs[0].sequence === 0xffffffff) throw new Error("internal: reclaim sequence disables locktime");
  const wit = parsed.inputs[0].witness;
  if (wit.length !== 3 || wit[0].length !== 64) throw new Error("internal: reclaim witness layout wrong");
  if (bytesToHex(wit[1]) !== bounty.reclaimScriptHex) throw new Error("internal: reclaim leaf wrong");
  return { ...spend, ...planned };
}

/* ------------------------------------------------------------------ */
/* Blockbook: GET-only watching                                        */
/* ------------------------------------------------------------------ */

async function bountyGet(base, path) {
  const res = await fetch(String(base).replace(/\/$/, "") + path);
  if (!res.ok) throw new Error(`blockbook ${res.status} on ${path}`);
  const text = await res.text();
  try { return JSON.parse(text); } catch { throw new Error("blockbook returned non-JSON on " + path); }
}

/** Current chain tip height (GET /api/v2 → backend.blocks). */
export async function fetchBlockHeight(blockbookBase) {
  const j = await bountyGet(blockbookBase, "/api/v2");
  const h = j && j.backend && j.backend.blocks;
  if (!Number.isSafeInteger(h) || h < 0) throw new Error("blockbook returned a bad tip height");
  return h;
}

/** GET-only bounty watch: UTXO list with per-funding-tx scriptPubKey checks.
 *  A UTXO whose vout spk does NOT match the bounty contract comes back
 *  scriptOk:false and the UI drops it loudly. Unconfirmed → fundingHeight:null.
 *  Returns [{ txid, vout, value, fundingHeight, confirmations, scriptOk }]. */
export async function fetchBountyUtxos(blockbookBase, bounty) {
  if (!bounty || !bounty.spkHex || !bounty.address) throw new Error("bad bounty");
  const want = bounty.spkHex.toLowerCase();
  const list = await bountyGet(blockbookBase, `/api/v2/utxo/${bounty.address}`);
  if (!Array.isArray(list)) throw new Error("unexpected utxo response");
  const out = [];
  for (const u of list) {
    const txid = String(u.txid || "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(txid)) continue;
    const vout = Number(u.vout);
    const value = Number(u.value);
    if (!Number.isSafeInteger(vout) || vout < 0) continue;
    if (!Number.isSafeInteger(value) || value <= 0) continue;
    let scriptOk = false;
    let fundingHeight = null;
    try {
      const txj = await bountyGet(blockbookBase, `/api/v2/tx/${txid}`);
      const vo = txj && Array.isArray(txj.vout) ? txj.vout[vout] : null;
      const spk = vo && vo.scriptPubKey && vo.scriptPubKey.hex
        ? String(vo.scriptPubKey.hex).toLowerCase() : "";
      scriptOk = spk === want;
      if (txj && typeof txj.blockHeight === "number" && txj.blockHeight >= 0) {
        fundingHeight = txj.blockHeight;
      }
    } catch { /* tx lookup failed: scriptOk stays false */ }
    out.push({ txid, vout, value, fundingHeight, confirmations: u.confirmations ?? 0, scriptOk });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Status classification                                               */
/* ------------------------------------------------------------------ */

/**
 * Classify a bounty against its UTXOs and a chain tip.
 *   "awaiting-funding" — no contract-matching UTXO yet
 *   "open"             — funded, deadline in the future
 *   "past-deadline"    — funded, tip >= deadline, poster may reclaim
 *   "spent"            — no UTXOs but the bounty was funded before (the
 *                        caller passes hadFunding:true when history shows it)
 * Returns { status, blocksLeft, etaSecs, detail }.
 */
export function classifyBounty(bounty, utxos, tipHeight, hadFunding = false) {
  if (!Number.isSafeInteger(tipHeight) || tipHeight <= 0) throw new Error("bad tip height");
  const good = (utxos || []).filter((u) => u.scriptOk);
  if (good.length === 0) {
    return {
      status: hadFunding ? "spent" : "awaiting-funding",
      blocksLeft: Math.max(0, bounty.deadlineHeight - tipHeight),
      etaSecs: Math.max(0, bounty.deadlineHeight - tipHeight) * PEARL_BLOCK_SECS,
      detail: hadFunding
        ? "the bounty output was spent — the pot moved via the award or reclaim leaf"
        : "no funds at the bounty address yet — the poster funds it with any PRL wallet",
    };
  }
  const past = tipHeight >= bounty.deadlineHeight;
  const blocksLeft = Math.max(0, bounty.deadlineHeight - tipHeight);
  return {
    status: past ? "past-deadline" : "open",
    blocksLeft,
    etaSecs: blocksLeft * PEARL_BLOCK_SECS,
    detail: past
      ? "deadline passed — the poster can reclaim the pot with the CLTV leaf, or still award it"
      : `${good.length} funded output(s) — hunters can submit; the poster can award at any time`,
  };
}

/* ------------------------------------------------------------------ */
/* Transaction verification                                            */
/* ------------------------------------------------------------------ */

/**
 * Verify a pasted transaction against a bounty contract. A raw transaction
 * does not carry prevout scriptPubKeys, so bounty inputs are identified by
 * their witness: the script must be EXACTLY the award or reclaim leaf and
 * the control block must re-derive the bounty's tweaked key (the same check
 * a wallet performs). For reclaim spends, nLockTime must equal the deadline
 * and the sequence must be < 0xffffffff.
 * Returns { ok, txid, spends: [{ inputIndex, leaf, locktime, sequence }] }
 * and throws LOUDLY when no input conforms. Pure offline check — proves
 * contract conformance, not confirmation.
 */
export function verifyBountyTx(hex, bounty) {
  const clean = String(hex || "").trim().toLowerCase();
  if (!/^[0-9a-f]{32,}$/.test(clean) || clean.length % 2 !== 0) {
    throw new Error("not a hex transaction");
  }
  const parsed = parseTx(clean);
  const awardScript = hexToBytes(bounty.awardScriptHex);
  const reclaimScript = hexToBytes(bounty.reclaimScriptHex);
  const internalXOnly = hexToBytes(bounty.internalKeyHex);
  const tweakedX = hexToBytes(bounty.tweakedHex);
  const spends = [];
  for (let i = 0; i < parsed.inputs.length; i++) {
    const pin = parsed.inputs[i];
    const wit = pin.witness;
    if (!Array.isArray(wit) || wit.length !== 3) continue;
    const [sig, script, cb] = wit;
    if (!(sig instanceof Uint8Array) || sig.length !== 64) continue;
    let leaf = null;
    if (constEq(script, awardScript)) leaf = "award";
    else if (constEq(script, reclaimScript)) leaf = "reclaim";
    if (!leaf) continue; // not a bounty input — not our business
    if (!verifyControlBlock(internalXOnly, script, cb, tweakedX)) {
      throw new Error(`LOUD REFUSAL — input ${i}: control block does not re-derive the bounty address for the ${leaf} leaf`);
    }
    if (leaf === "reclaim") {
      if (parsed.locktime !== bounty.deadlineHeight) {
        throw new Error(`LOUD REFUSAL — input ${i}: reclaim nLockTime ${parsed.locktime} != deadline ${bounty.deadlineHeight}`);
      }
      if (pin.sequence === 0xffffffff) {
        throw new Error(`LOUD REFUSAL — input ${i}: sequence 0xffffffff disables the CLTV locktime`);
      }
    }
    spends.push({ inputIndex: i, leaf, locktime: parsed.locktime, sequence: pin.sequence });
  }
  if (spends.length === 0) {
    throw new Error("LOUD REFUSAL — no input of this transaction spends from this bounty's contract");
  }
  return { ok: true, txid: parsed.txid, spends };
}
