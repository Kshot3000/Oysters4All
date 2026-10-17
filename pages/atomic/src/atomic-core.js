/* Pearl Atomic core — cross-chain HTLC (hash-time-locked contract) desk for PRL.
 *
 * Pure ESM, zero build step for developers. The browser ships a committed
 * esbuild IIFE bundle (pearl-atomic.bundle.js); node runs this file directly
 * for the verification suite.
 *
 * What this does: build a 2-leaf Taproot HTLC —
 *   leaf 0 (claim):  SHA256 <hash> EQUALVERIFY <claimerKey> CHECKSIG
 *   leaf 1 (refund): <timeoutHeight> CHECKLOCKTIMEVERIFY DROP <refundeeKey> CHECKSIG
 * derive the HTLC P2TR address under a NUMS internal key, then build / sign /
 * verify / broadcast script-path spends for both leaves. All signing is local;
 * nothing secret ever leaves the machine.
 *
 * Crypto lineage: key derivation, TapTweak, bech32m, BIP-341 sighash and
 * wire serialization come from the audited files/pages/sign/src/crypto.js
 * (verified byte-for-byte against Pearl's Go reference node/txscript); the
 * 2-leaf taptree, script-path sighash/digest, Schnorr sign/verify,
 * spend-builder and fee math come from the audited
 * files/pages/escrow/src/escrow-core.js. New here: the HTLC claim-leaf
 * template (SHA256 hash-lock — the canonical TierNolan HTLC, verified against
 * the opcode semantics in node/txscript/opcode.go: OP_SHA256 pushes the
 * 32-byte digest, OP_EQUALVERIFY fails the script on mismatch), the NUMS
 * internal-key derivation (domain "PearlAtomicNUMS/v1"), tamper-evident
 * descriptors, and deal/timeout planning rules. No new cryptography.
 *
 * Protocol facts (verified, not from memory):
 *  - TapLeaf/TapBranch/TapTweak tags + branch sort order: BIP-341, and the
 *    single/double-leaf cases match commitKeyInfo()/taptree2 in the audited cores.
 *  - P2TR dust 333 grains, tx version 1, bech32m HRPs prl/tprl/rprl,
 *    BIP-86 coin type 808276/1: pearl-knowledge.md (from node/chaincfg).
 *  - CLTV lock heights < 500000000 are block heights (BIP-65); the refund
 *    leaf needs tx locktime >= timeout and input sequence < 0xffffffff.
 *  - Blockbook v2 REST: /api/v2/utxo/<addr>, /api/v2/address/<addr>?details=txs,
 *    /api/v2/tx/<txid>, /api/sendtx/ (v1 POST, text/plain raw hex).
 */

import {
  encodeBech32m, decodeBech32m,
  schnorr, sha256, bytesToHex, hexToBytes,
  DUST_GRAIN, GRAIN_PER_PRL, NETWORKS,
  walletFromMnemonic, newMnemonic,
  fetchUtxos, fetchFeeRateGrainsPerVByte, broadcastTx, fetchTxStatus,
  taptree2, verifyControlBlock,
  scriptPathSigDigestEx, signForXOnly, verifySchnorrSig,
  buildScriptPathSpend, spendVBytes, scriptAsm,
  addressToProgram, partyKeyFromInput, parseXOnlyKey, pushData,
  buildRefundScript,
} from "../../escrow/src/escrow-core.js";
import { tapLeafHash, walletFromPriv } from "../../sign/src/crypto.js";
import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesToNumberBE } from "@noble/curves/abstract/utils";

export {
  DUST_GRAIN, GRAIN_PER_PRL, NETWORKS,
  walletFromMnemonic, walletFromPriv, newMnemonic,
  fetchUtxos, fetchFeeRateGrainsPerVByte, broadcastTx, fetchTxStatus,
  bytesToHex, hexToBytes, schnorr, sha256,
  encodeBech32m, decodeBech32m,
  scriptPathSigDigestEx, signForXOnly, verifySchnorrSig,
  buildScriptPathSpend, spendVBytes, scriptAsm,
  addressToProgram, partyKeyFromInput, parseXOnlyKey,
  taptree2, verifyControlBlock,
};

const OP = {
  FALSE: 0x00,
  SHA256: 0xa8,
  EQUALVERIFY: 0x88,
  CHECKSIG: 0xac,
};
const TE = new TextEncoder();
const utf8 = (s) => TE.encode(s);
const NUMS_DOMAIN = "PearlAtomicNUMS/v1";
const DESCRIPTOR_PREFIX = "pearl-atomic:v1:";
const MAX_SEQ = 0xffffffff;
const REFUND_SEQ = 0xfffffffe;

function constEq(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

/* ---------------- HTLC script templates ---------------- */

/** Validate a 32-byte preimage hash (64 hex). */
export function parseHash(hex) {
  if (typeof hex !== "string" || !/^[0-9a-fA-F]{64}$/.test(hex.trim())) {
    throw new Error("hash lock must be 64 hex characters (32 bytes)");
  }
  return hexToBytes(hex.trim().toLowerCase());
}

/** Claim leaf: OP_SHA256 <32-byte hash> OP_EQUALVERIFY <claimer x-only> OP_CHECKSIG.
 *  Spends with witness [sig, preimage, script, controlBlock]: the preimage's
 *  SHA-256 must equal the hash lock, then the claimer's Schnorr signature is
 *  checked. Byte layout: a8 20 <hash> 88 21 <key> ac (69 bytes). */
export function buildClaimScript(claimerXOnly, hash32) {
  const ck = claimerXOnly instanceof Uint8Array ? claimerXOnly : parseXOnlyKey(claimerXOnly);
  const h = hash32 instanceof Uint8Array ? hash32 : parseHash(hash32);
  if (ck.length !== 32) throw new Error("claimer key must be 32 bytes");
  if (h.length !== 32) throw new Error("hash lock must be 32 bytes");
  schnorr.utils.lift_x(bytesToNumberBE(ck));
  return Uint8Array.from([OP.SHA256, ...pushData(h), OP.EQUALVERIFY, ...pushData(ck), OP.CHECKSIG]);
}

/** Refund leaf reuses the audited escrow template:
 *  <timeoutHeight> CHECKLOCKTIMEVERIFY DROP <refundeeKey> CHECKSIG. */
export { buildRefundScript };

/* ---------------- NUMS internal key ---------------- */

/** NUMS internal key: lift_x(SHA-256("PearlAtomicNUMS/v1" || claimLeafHash || refundLeafHash)).
 *  Nobody knows the discrete log, so keypath spending is impossible — coins
 *  move only through the two script leaves. Deterministic and recomputable
 *  from the scripts. The counter loop is REQUIRED, not a formality: only
 *  about half of all 32-byte strings are valid x-coordinates on secp256k1
 *  (x^3+7 must be a quadratic residue), so the first hash usually fails to
 *  lift and the search continues. */
export function numsInternalKeyAtomic(claimScript, refundScript) {
  if (!(claimScript instanceof Uint8Array) || claimScript.length === 0) throw new Error("bad claim script");
  if (!(refundScript instanceof Uint8Array) || refundScript.length === 0) throw new Error("bad refund script");
  const preimage = Uint8Array.from(
    [utf8(NUMS_DOMAIN), tapLeafHash(claimScript), tapLeafHash(refundScript)].flatMap((x) => [...x]));
  for (let counter = 0; counter < 256; counter++) {
    const pre = counter === 0 ? preimage : Uint8Array.from([...preimage, counter]);
    const h = sha256(pre);
    try {
      schnorr.utils.lift_x(bytesToNumberBE(h));
      return h;
    } catch { /* try next counter */ }
  }
  throw new Error("ATOMIC REFUSED: NUMS lift failed (unreachable in practice)");
}

/* ---------------- contract forging ---------------- */

/** Forge the full HTLC contract. Throws on any invalid input — a contract is
 *  never half-built. */
export function forgeHtlc(network, { claimerXOnly, refundeeXOnly, hash, timeout }) {
  const ck = claimerXOnly instanceof Uint8Array ? claimerXOnly : parseXOnlyKey(claimerXOnly);
  const rk = refundeeXOnly instanceof Uint8Array ? refundeeXOnly : parseXOnlyKey(refundeeXOnly);
  if (constEq(ck, rk)) throw new Error("ATOMIC REFUSED: claimer and refundee keys must differ");
  const claimScript = buildClaimScript(ck, hash);
  const refundScript = buildRefundScript(rk, timeout); // enforces height < 500000000
  const internalXOnly = numsInternalKeyAtomic(claimScript, refundScript);
  const tree = taptree2(network, internalXOnly, claimScript, refundScript);
  return { claimScript, refundScript, internalXOnly, tree };
}

/* ---------------- preimage ---------------- */

/** Generate a fresh 32-byte preimage (CSPRNG) and its SHA-256 hash lock. */
export function newPreimage() {
  const c = typeof globalThis.crypto !== "undefined" ? globalThis.crypto : null;
  if (!c || !c.getRandomValues) throw new Error("no CSPRNG available");
  const bytes = c.getRandomValues(new Uint8Array(32));
  return { preimage: bytes, hash: sha256(bytes) };
}

/** Parse a user-supplied preimage (64 hex) and check it against a hash lock.
 *  Loud refusal on mismatch — a wrong preimage can never reach the chain. */
export function checkPreimage(preimageHex, hash32) {
  const p = parseHash(preimageHex); // 64-hex shape check, message mentions "preimage"
  const h = hash32 instanceof Uint8Array ? hash32 : parseHash(hash32);
  if (!constEq(sha256(p), h)) {
    throw new Error("ATOMIC REFUSED: preimage does not hash to the contract's hash lock");
  }
  return p;
}

/* ---------------- timeout planning rules ---------------- */

/** Minimum safe refund timeout: chain height + 144 blocks (~7.8h at 194s).
 *  Warn band: below height + 720 (~1.6 days) the counterparty may not have
 *  time to react — allowed, but loudly warned. */
export function timeoutRules(chainHeight) {
  const h = Number(chainHeight);
  if (!Number.isSafeInteger(h) || h <= 0) return { min: null, warnBelow: null };
  return { min: h + 144, warnBelow: h + 720 };
}

/** Validate a refund timeout against the rules. Returns {ok, warnings[]}.
 *  Throws (loud refusal) when the timeout is unusable. */
export function validateTimeout(timeout, chainHeight) {
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout >= 500000000) {
    throw new Error("ATOMIC REFUSED: timeout must be a positive block height (< 500000000)");
  }
  const warnings = [];
  const rules = timeoutRules(chainHeight);
  if (rules.min !== null) {
    if (timeout <= chainHeight) {
      throw new Error(`ATOMIC REFUSED: timeout ${timeout} is not in the future (chain at ${chainHeight})`);
    }
    if (timeout < rules.min) {
      throw new Error(`ATOMIC REFUSED: timeout ${timeout} is under the ${rules.min} minimum (chain + 144 blocks) — the counterparty could not react in time`);
    }
    if (timeout < rules.warnBelow) {
      warnings.push(`timeout ${timeout} is inside the ${rules.warnBelow} caution band (chain + 720) — short for a cross-chain swap`);
    }
  }
  return { ok: true, warnings };
}

/** Cross-chain timeout ordering (TierNolan). The party that locks FIRST must
 *  use the LONGER refund timeout, so the second locker cannot claim and then
 *  strand the first locker's refund.
 *  - maker (locks PRL first): PRL timeout must EXCEED the counterparty leg's timeout.
 *  - taker (locks second, claims PRL): the PRL timeout must EXCEED the taker's own leg timeout.
 *  Returns a warning string, or null when ordering is safe / unknown. */
export function timeoutOrderingWarning(role, prlTimeout, counterpartyTimeout) {
  const cp = Number(counterpartyTimeout);
  if (!Number.isSafeInteger(cp) || cp <= 0) return null; // unknown — can't judge
  if (role === "maker") {
    if (prlTimeout <= cp) {
      return `UNSAFE ORDERING: your PRL refund timeout (${prlTimeout}) is not longer than the counterparty leg's refund timeout (${cp}). You lock first — your timeout must be longer, or the counterparty can claim your PRL and let their leg expire.`;
    }
  } else {
    if (prlTimeout <= cp) {
      return `UNSAFE ORDERING: the PRL refund timeout (${prlTimeout}) is not longer than your own leg's refund timeout (${cp}). You need time to claim the PRL after revealing the preimage on your leg.`;
    }
  }
  return null;
}

/* ---------------- descriptors (tamper-evident) ---------------- */

// Depth cap for the recursive canonicalizer: import paths fingerprint the
// RAW parsed payload before normalizing it, and JSON.parse survives ~10k
// nesting levels while this recursion dies near ~5k — a crafted descriptor,
// bundle, proposal, or audit entry nested 5,000 deep surfaced a raw
// RangeError instead of the app's standard refusal. 128 matches the
// descriptor parser's MAX_EXPR_DEPTH; no legitimate payload comes close.
const MAX_CANON_DEPTH = 128;
function canonicalJson(v, depth = 0) {
  if (depth > MAX_CANON_DEPTH) throw new Error("canonical JSON nested deeper than " + MAX_CANON_DEPTH + " levels — refusing");
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map((x) => canonicalJson(x, depth + 1)).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson(v[k], depth + 1)).join(",") + "}";
}

function b64urlEncode(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : utf8(String(bytes));
  let bin = "";
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s) {
  const t = String(s).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(t + "=".repeat((4 - (t.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Build a tamper-evident descriptor for a forged contract + deal memo.
 *  The fingerprint is SHA-256 over the canonical JSON; any edit to the
 *  descriptor (or to the contract it describes) breaks verification. */
export function makeDescriptor(network, contract, deal) {
  const d = deal || {};
  const obj = {
    app: "pearl-atomic",
    v: 1,
    hrp: network.hrp,
    claimerXOnly: bytesToHex(contract.claimScript && claimerFromClaimScript(contract.claimScript)),
    refundeeXOnly: bytesToHex(refundeeFromRefundScript(contract.refundScript)),
    hash: bytesToHex(hashFromClaimScript(contract.claimScript)),
    timeout: d.timeout ?? timeoutFromRefundScript(contract.refundScript),
    address: contract.tree.address,
    internalXOnly: bytesToHex(contract.internalXOnly),
    claimScript: bytesToHex(contract.claimScript),
    refundScript: bytesToHex(contract.refundScript),
    claimControl: bytesToHex(contract.tree.controlBlocks[0]),
    refundControl: bytesToHex(contract.tree.controlBlocks[1]),
    amountGrains: d.amountGrains ?? null,
    label: d.label ?? "",
    counterparty: {
      chain: d.counterparty?.chain ?? "",
      asset: d.counterparty?.asset ?? "",
      amount: d.counterparty?.amount ?? "",
      htlcRef: d.counterparty?.htlcRef ?? "",
      refundTimeout: d.counterparty?.refundTimeout ?? null,
    },
  };
  const fingerprint = bytesToHex(sha256(utf8(canonicalJson(obj)))).slice(0, 16); // 64-bit
  obj.fingerprint = fingerprint;
  const string = DESCRIPTOR_PREFIX + b64urlEncode(utf8(canonicalJson(obj)));
  return { obj, fingerprint, string };
}

/** Parse + fully verify a descriptor: prefix, JSON shape, fingerprint, and
 *  independent re-derivation of every consensus field (scripts, NUMS key,
 *  taptree, address, control blocks). Throws on any mismatch — a tampered
 *  or foreign descriptor can never be funded through this app. */
export function parseDescriptor(network, str) {
  const s = String(str || "").trim();
  if (!s.startsWith(DESCRIPTOR_PREFIX)) {
    throw new Error("ATOMIC REFUSED: not a pearl-atomic:v1: descriptor");
  }
  let obj;
  try {
    obj = JSON.parse(new TextDecoder().decode(b64urlDecode(s.slice(DESCRIPTOR_PREFIX.length))));
  } catch {
    throw new Error("ATOMIC REFUSED: descriptor is not valid base64url JSON");
  }
  if (obj.app !== "pearl-atomic" || obj.v !== 1) throw new Error("ATOMIC REFUSED: unknown descriptor app/version");
  if (obj.hrp !== network.hrp) throw new Error(`ATOMIC REFUSED: descriptor is for ${obj.hrp}, not ${network.hrp}`);
  // fingerprint over the canonical JSON of the payload WITHOUT the fingerprint field
  const { fingerprint, ...payload } = obj;
  const want = bytesToHex(sha256(utf8(canonicalJson(payload)))).slice(0, 16);
  if (typeof fingerprint !== "string" || fingerprint.toLowerCase() !== want) {
    throw new Error("ATOMIC REFUSED: descriptor fingerprint mismatch — tampered or corrupted");
  }
  // re-derive the contract from the primitive fields
  const claimScript = buildClaimScript(obj.claimerXOnly, obj.hash);
  const refundScript = buildRefundScript(obj.refundeeXOnly, obj.timeout);
  if (bytesToHex(claimScript) !== String(obj.claimScript).toLowerCase()) {
    throw new Error("ATOMIC REFUSED: claim script does not match the descriptor's keys/hash");
  }
  if (bytesToHex(refundScript) !== String(obj.refundScript).toLowerCase()) {
    throw new Error("ATOMIC REFUSED: refund script does not match the descriptor's keys/timeout");
  }
  const internalXOnly = numsInternalKeyAtomic(claimScript, refundScript);
  if (bytesToHex(internalXOnly) !== String(obj.internalXOnly).toLowerCase()) {
    throw new Error("ATOMIC REFUSED: internal key is not the NUMS derivation — keypath backdoor risk");
  }
  const tree = taptree2(network, internalXOnly, claimScript, refundScript);
  if (tree.address !== obj.address) throw new Error("ATOMIC REFUSED: address does not re-derive from the descriptor");
  if (bytesToHex(tree.controlBlocks[0]) !== String(obj.claimControl).toLowerCase() ||
      bytesToHex(tree.controlBlocks[1]) !== String(obj.refundControl).toLowerCase()) {
    throw new Error("ATOMIC REFUSED: control blocks do not re-derive from the descriptor");
  }
  if (!verifyControlBlock(internalXOnly, claimScript, tree.controlBlocks[0], tree.tweakedX) ||
      !verifyControlBlock(internalXOnly, refundScript, tree.controlBlocks[1], tree.tweakedX)) {
    throw new Error("ATOMIC REFUSED: control-block self-check failed");
  }
  return { obj, fingerprint: want, contract: { claimScript, refundScript, internalXOnly, tree } };
}

/* script field extractors (single source of truth for makeDescriptor) */
function claimerFromClaimScript(script) {
  // a8 20 <32 hash> 88 21 <32 key> ac
  if (script.length !== 69 || script[0] !== OP.SHA256 || script[1] !== 0x20 ||
      script[34] !== OP.EQUALVERIFY || script[35] !== 0x20 || script[68] !== OP.CHECKSIG) {
    throw new Error("not a pearl-atomic claim script");
  }
  return script.slice(36, 68);
}
function hashFromClaimScript(script) {
  if (script.length !== 69 || script[0] !== OP.SHA256 || script[1] !== 0x20) {
    throw new Error("not a pearl-atomic claim script");
  }
  return script.slice(2, 34);
}
function refundeeFromRefundScript(script) {
  // <push len> <height bytes> b1 75 20 <32 key> ac
  if (script[script.length - 1] !== OP.CHECKSIG || script[script.length - 34] !== 0x20) {
    throw new Error("not a pearl-atomic refund script");
  }
  return script.slice(script.length - 33, script.length - 1);
}
function timeoutFromRefundScript(script) {
  // first push is the minimal-encoded height
  const op = script[0];
  let len, hlen;
  if (op === 0x00) return 0;
  if (op <= 0x4b) { len = op; hlen = 1; }
  else if (op === 0x4c) { len = script[1]; hlen = 2; }
  else if (op === 0x4d) { len = script[1] | (script[2] << 8); hlen = 3; }
  else throw new Error("not a pearl-atomic refund script");
  const bytes = script.slice(hlen, hlen + len);
  let n = 0;
  for (let i = bytes.length - 1; i >= 0; i--) n = n * 256 + bytes[i];
  return n;
}

/* ---------------- builder tip (optional, disclosed) ---------------- */

/* Optional builder tip (profit mandate, disclosed, opt-in/default-off):
 * a claim spends the whole HTLC through the claim leaf, signed by the
 * claimer alone, so — like Circle/Bond — the tip is never automatic:
 * the claimer explicitly opts in. builderTipGrainsFor() is the single
 * source; planClaim() adds the tip as its own second output BEFORE
 * signing, and the script-path sighash commits to every output — so it
 * cannot be added or skimmed after signing. Off = plan identical to
 * the pre-tip planner. Offered on the claim flow only: the refund
 * takes no tip parameter at all — it returns the maker's own locked
 * funds after the timeout, so a tip output is excluded by
 * construction. The recipient is the operator address published in
 * every Atomic footer. */
export const BUILDER_TIP_BPS = 100; // 1%
export const BUILDER_TIP_ADDRESS = "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d";
export const BUILDER_TIP_NAME = "Builder tip (optional)";

/** Builder tip in grains for a claim of totalGrains on network.
 *  Returns 0 unless enabled === true, the network is mainnet, and the
 *  1% floor reaches the dust floor (waived, never rounded up). Computed
 *  in BigInt so large HTLCs stay exact, then returned in this core's
 *  Number style (the input is already range-checked to a safe integer). */
export function builderTipGrainsFor(totalGrains, network, enabled) {
  if (enabled !== true) return 0;
  if (!network || network.hrp !== "prl") return 0;
  if (!Number.isSafeInteger(totalGrains) || totalGrains <= 0) throw new Error("bad total for builder tip");
  const tip = Number((BigInt(totalGrains) * BigInt(BUILDER_TIP_BPS)) / 10000n);
  return tip >= DUST_GRAIN ? tip : 0;
}

/* ---------------- settle planning ---------------- */

/** Plan a CLAIM spend: the claimer reveals the preimage and pays themselves
 *  (minus fee, and minus the optional builder tip when the claimer opts
 *  in). The preimage is hash-checked BEFORE anything is built. */
export function planClaim({ network, contract, input, preimageHex, destProgram, feeRateGrainsPerVByte, builderTipEnabled = false }) {
  const preimage = checkPreimage(preimageHex, hashFromClaimScript(contract.claimScript));
  if (!(destProgram instanceof Uint8Array) || destProgram.length !== 32) {
    throw new Error("claim destination must be a 32-byte P2TR program");
  }
  if (!Number.isFinite(feeRateGrainsPerVByte) || feeRateGrainsPerVByte <= 0) {
    throw new Error("ATOMIC REFUSED: bad fee rate (must be a positive number of grains/vB)");
  }
  if (!Number.isSafeInteger(input?.value) || input.value <= 0) {
    throw new Error("ATOMIC REFUSED: bad input value (must be a positive whole number of grains)");
  }
  const builderTip = builderTipGrainsFor(input.value, network, builderTipEnabled === true);
  const builderTipProgram = builderTip > 0 ? addressToProgram(BUILDER_TIP_ADDRESS, NETWORKS.mainnet) : null;
  if (builderTip > 0 && constEq(destProgram, builderTipProgram)) {
    throw new Error("ATOMIC REFUSED: claim destination is the builder address — the builder tip would duplicate the claim output; leave the tip off");
  }
  // Claim takes everything to one output (two with the optional builder
  // tip): fee from the exact witness size (1 sig + 32-byte preimage +
  // claim script + 65-byte control block).
  const vB = spendVBytes({ nOut: builderTip > 0 ? 2 : 1, scriptLen: contract.claimScript.length, controlLen: 65, stackLens: [64, 32] });
  const fee = Math.ceil(vB * feeRateGrainsPerVByte);
  const payVal = input.value - fee - builderTip;
  if (payVal < DUST_GRAIN) {
    if (builderTip > 0) {
      throw new Error(`ATOMIC REFUSED: claim value ${input.value} cannot cover fee ${fee} and the ${builderTip}-grain builder tip and still pay out >= dust (${DUST_GRAIN}); leave the builder tip off`);
    }
    throw new Error(`ATOMIC REFUSED: insufficient funds for the claim fee (need ${fee} grains)`);
  }
  const outputs = [{ program: destProgram, value: payVal }];
  if (builderTip > 0) outputs.push({ program: builderTipProgram, value: builderTip, builderTip: true });
  return {
    kind: "claim",
    input, outputs, fee, vBytes: vB, change: 0,
    leafScript: contract.claimScript,
    controlBlock: contract.tree.controlBlocks[0],
    stackLens: [64, 32],
    sequence: MAX_SEQ, locktime: 0,
    preimage,
    builderTip, builderTipProgram,
  };
}

/** Plan a REFUND spend: after the timeout, the refundee reclaims everything.
 *  Loud refusal while the timelock is closed. */
export function planRefund({ network, contract, input, destProgram, feeRateGrainsPerVByte, chainHeight }) {
  const timeout = timeoutFromRefundScript(contract.refundScript);
  if (Number.isSafeInteger(chainHeight) && chainHeight < timeout) {
    throw new Error(`ATOMIC REFUSED: refund is timelocked until block ${timeout} (chain at ${chainHeight})`);
  }
  if (!(destProgram instanceof Uint8Array) || destProgram.length !== 32) {
    throw new Error("refund destination must be a 32-byte P2TR program");
  }
  if (!Number.isFinite(feeRateGrainsPerVByte) || feeRateGrainsPerVByte <= 0) {
    throw new Error("ATOMIC REFUSED: bad fee rate (must be a positive number of grains/vB)");
  }
  if (!Number.isSafeInteger(input?.value) || input.value <= 0) {
    throw new Error("ATOMIC REFUSED: bad input value (must be a positive whole number of grains)");
  }
  const vB = spendVBytes({ nOut: 1, scriptLen: contract.refundScript.length, controlLen: 65, stackLens: [64] });
  const fee = Math.ceil(vB * feeRateGrainsPerVByte);
  const payVal = input.value - fee;
  if (payVal < DUST_GRAIN) throw new Error(`ATOMIC REFUSED: insufficient funds for the refund fee (need ${fee} grains)`);
  return {
    kind: "refund",
    input,
    outputs: [{ program: destProgram, value: payVal }],
    fee, vBytes: vB, change: 0,
    leafScript: contract.refundScript,
    controlBlock: contract.tree.controlBlocks[1],
    stackLens: [64],
    sequence: REFUND_SEQ, locktime: timeout,
  };
}

/** Digest for a settle plan (claim or refund). */
export function settleDigest(network, p) {
  return scriptPathSigDigestEx(network, p.input, p.outputs, p.leafScript, {
    sequence: p.sequence, locktime: p.locktime,
  });
}

/** Assemble + verify a claim witness: [sig, preimage, script, controlBlock].
 *  The signature is verified against the claimer key before assembly — a bad
 *  sig never reaches the chain. */
export function assembleClaim(network, p, sigHex, claimerXOnly) {
  // Last-hop builder-tip assertion (Circle/Bond pattern): assembly is
  // the last hop before the tx exists, so a flagged tip is a trust
  // claim — the tip program is re-derived here from the builder
  // address constant, never trusted from the plan, and the flagged
  // output must pay it at exactly the planned amount. An untipped plan
  // must carry no flagged output at all.
  const flagged = (p.outputs || []).filter((o) => o && o.builderTip);
  if (p.builderTip > 0) {
    const want = addressToProgram(BUILDER_TIP_ADDRESS, NETWORKS.mainnet);
    if (flagged.length !== 1 || !constEq(flagged[0].program, want) || flagged[0].value !== p.builderTip) {
      throw new Error("ATOMIC REFUSED: builder tip in the plan does not pay the builder address at the planned amount — refusing to assemble");
    }
  } else if (flagged.length > 0) {
    throw new Error("ATOMIC REFUSED: plan carries a flagged builder tip but no planned tip amount — refusing to assemble");
  }
  if (!/^[0-9a-fA-F]{128}$/.test(String(sigHex || "").trim())) {
    throw new Error("claim signature must be 128 hex characters (64 bytes)");
  }
  const digest = settleDigest(network, p);
  if (!verifySchnorrSig(sigHex, digest, claimerXOnly)) {
    throw new Error("ATOMIC REFUSED: claim signature does not verify against the claimer key");
  }
  return buildScriptPathSpend(network, p.input, p.outputs, p.leafScript, p.controlBlock,
    [hexToBytes(String(sigHex).trim().toLowerCase()), p.preimage],
    { sequence: p.sequence, locktime: p.locktime });
}

/** Assemble + verify a refund witness: [sig, script, controlBlock]. */
export function assembleRefund(network, p, sigHex, refundeeXOnly) {
  if (!/^[0-9a-fA-F]{128}$/.test(String(sigHex || "").trim())) {
    throw new Error("refund signature must be 128 hex characters (64 bytes)");
  }
  const digest = settleDigest(network, p);
  if (!verifySchnorrSig(sigHex, digest, refundeeXOnly)) {
    throw new Error("ATOMIC REFUSED: refund signature does not verify against the refundee key");
  }
  return buildScriptPathSpend(network, p.input, p.outputs, p.leafScript, p.controlBlock,
    [hexToBytes(String(sigHex).trim().toLowerCase())],
    { sequence: p.sequence, locktime: p.locktime });
}

/* ---------------- unsigned settle bundles (air-gap) ---------------- */

function canonicalBundleJson(b) {
  const o = {
    bundle: b.bundle, network: b.network, kind: b.kind,
    input: b.input, outputs: b.outputs, feeGrains: b.feeGrains,
    vBytes: b.vBytes, sequence: b.sequence, locktime: b.locktime,
    digest: b.digest, leafScript: b.leafScript, controlBlock: b.controlBlock,
    descriptor: b.descriptor,
  };
  return canonicalJson(o);
}

/** Export an unsigned settle bundle for cold signing. The fingerprint is the
 *  first 64 bits of SHA-256 over the canonical JSON — any tampering breaks it.
 *  A tipped claim's tip output travels as a plain output to the builder
 *  address (the flag is a plan-level label, not a wire field): the bundle
 *  digest recomputes over both outputs, so import needs no separate tip
 *  leg — a stripped or rerouted tip breaks the digest (checked, not
 *  assumed — same call as Bounty's output-blind verifier). */
export function exportUnsignedBundle(network, p, descriptor) {
  const b = {
    bundle: "pearl-atomic-unsigned:v1:",
    network: network.hrp,
    kind: p.kind,
    input: { txid: p.input.txid, vout: p.input.vout, value: p.input.value },
    outputs: p.outputs.map((o) => ({
      address: encodeBech32m(network.hrp, 1, o.program), value: String(o.value),
    })),
    feeGrains: String(p.fee),
    vBytes: p.vBytes,
    sequence: p.sequence,
    locktime: p.locktime,
    digest: bytesToHex(settleDigest(network, p)),
    leafScript: bytesToHex(p.leafScript),
    controlBlock: bytesToHex(p.controlBlock),
    descriptor: descriptor.string,
  };
  b.fingerprint = bytesToHex(sha256(utf8(canonicalBundleJson(b)))).slice(0, 16);
  return b;
}

/** Import + verify an unsigned bundle: fingerprint, digest recomputation, and
 *  the embedded descriptor (which itself is fully re-derived). */
export function importUnsignedBundle(network, bundleJson, contract) {
  let b;
  try { b = JSON.parse(bundleJson); }
  catch { throw new Error("ATOMIC REFUSED: bundle is not valid JSON"); }
  if (b.bundle !== "pearl-atomic-unsigned:v1:") throw new Error("ATOMIC REFUSED: unknown bundle kind");
  if (b.network !== network.hrp) throw new Error(`ATOMIC REFUSED: bundle is for ${b.network}, not ${network.hrp}`);
  const { fingerprint, ...payload } = b;
  const want = bytesToHex(sha256(utf8(canonicalBundleJson(payload)))).slice(0, 16);
  if (String(fingerprint).toLowerCase() !== want) {
    throw new Error("ATOMIC REFUSED: bundle fingerprint mismatch — tampered or corrupted");
  }
  // the descriptor inside is verified independently
  const parsed = parseDescriptor(network, b.descriptor);
  // digest must match the plan the bundle claims
  const input = { txid: b.input.txid, vout: b.input.vout, value: Number(b.input.value), spk: parsed.contract.tree.spk };
  const outputs = b.outputs.map((o) => ({ program: addressToProgram(o.address, network), value: Number(o.value) }));
  const leafScript = hexToBytes(b.leafScript);
  const recomputed = bytesToHex(scriptPathSigDigestEx(network, input, outputs, leafScript, {
    sequence: b.sequence, locktime: b.locktime,
  }));
  if (recomputed !== String(b.digest).toLowerCase()) {
    throw new Error("ATOMIC REFUSED: bundle digest does not recompute from its inputs/outputs");
  }
  return { bundle: b, descriptor: parsed };
}

/* ---------------- chain tracking ---------------- */

/** Fetch address txs (GET-only) for the Track step. */
export async function fetchAddressTxs(blockbookBase, address) {
  const res = await fetch(blockbookBase.replace(/\/$/, "") + `/api/v2/address/${address}?details=txs&pageSize=50`);
  if (!res.ok) throw new Error(`blockbook ${res.status} on /api/v2/address/`);
  const j = await res.json();
  // Blockbook v2: the tx array is `transactions`; `txs` is an integer count.
  return Array.isArray(j.transactions) ? j.transactions : Array.isArray(j.txs) ? j.txs : [];
}

/** Classify the HTLC state from address txs: funding + any spend of it.
 *  fundingTx: the tx that paid the HTLC address (first confirmed vout to it).
 *  spendTx: a later tx consuming that outpoint (claim or refund — the witness
 *  is not exposed by Blockbook, so the kind is reported as "spent"). */
export function classifyHtlcState(txs, address, spkHex) {
  let funding = null, spend = null;
  const addrLower = address.toLowerCase();
  // The txs come from a user-configured Blockbook endpoint, and the funding
  // object feeds the claim/refund signers as a UTXO (txid, vout, value) —
  // so every field is coerced at this data layer in the fleet shape (the
  // games findFunding / bounty fetcher pattern): a txid must be real
  // 32-byte hex (lowercased), vout/value/confirmations safe integers, and
  // blockHeight a safe non-negative integer else null. A vout whose value
  // cannot be represented exactly (past MAX_SAFE_INTEGER) is not a usable
  // funding hit at all — the old Number(v.value) silently rounded
  // 9007199254740993 grains to 9007199254740992 — and a non-string txid
  // crashed the spend loop on funding.txid.toLowerCase().
  const txidOf = (t) => {
    const id = String(t?.txid || "").toLowerCase();
    return /^[0-9a-f]{64}$/.test(id) ? id : null;
  };
  const confOf = (t) => {
    const c = Number(t?.confirmations);
    return Number.isSafeInteger(c) && c >= 0 ? c : 0;
  };
  const heightOf = (t) => {
    const h = Number(t?.blockHeight);
    return Number.isSafeInteger(h) && h >= 0 ? h : null;
  };
  for (const t of txs || []) {
    const txid = txidOf(t);
    if (!txid) continue;
    for (const v of t.vout || []) {
      const addrs = (v.addresses || []).map((a) => String(a).toLowerCase());
      const scriptHex = String(v.hex || "").toLowerCase();
      if (addrs.includes(addrLower) || (spkHex && scriptHex === spkHex.toLowerCase())) {
        const vout = Number(v.n);
        const value = Number(v.value);
        if (!Number.isSafeInteger(vout) || vout < 0) continue;
        if (!Number.isSafeInteger(value) || value <= 0) continue;
        const conf = confOf(t);
        if (!funding && conf > 0) funding = { txid, vout, value, confirmations: conf, height: heightOf(t) };
      }
    }
  }
  if (funding) {
    for (const t of txs || []) {
      const txid = txidOf(t);
      if (!txid) continue;
      for (const vin of t.vin || []) {
        const vinVout = Number(vin.vout);
        if (String(vin.txid || "").toLowerCase() === funding.txid && Number.isSafeInteger(vinVout) && vinVout >= 0 && vinVout === funding.vout) {
          if (!spend) spend = { txid, confirmations: confOf(t), height: heightOf(t) };
        }
      }
    }
  }
  return { funding, spend };
}

/* ---------------- formatting ---------------- */

export function fmtPRL(grains) {
  const g = BigInt(grains);
  const neg = g < 0n;
  const a = neg ? -g : g;
  const whole = (a / 100000000n).toString();
  const fracTrim = (a % 100000000n).toString().padStart(8, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${fracTrim ? "." + fracTrim : ""} PRL`;
}

export function parsePRLtoGrains(s) {
  const t = String(s || "").trim().toLowerCase().replace(/,/g, "");
  let grains;
  const m = t.match(/^([0-9]+(?:\.[0-9]{1,8})?)\s*(prl|grains?)?$/);
  if (!m) throw new Error("amount must look like 1.25, 1.25 PRL, or 125000000 grains");
  const [, num, unit] = m;
  if (unit && unit.startsWith("grain")) {
    if (num.includes(".")) throw new Error("grain amounts must be whole numbers");
    grains = BigInt(num);
  } else {
    const [w, f = ""] = num.split(".");
    grains = BigInt(w) * 100000000n + BigInt((f + "00000000").slice(0, 8));
  }
  if (grains < BigInt(DUST_GRAIN)) throw new Error(`amount below dust (${DUST_GRAIN} grains)`);
  if (grains > 2100000000n * 100000000n) throw new Error("amount exceeds max PRL supply");
  // Number(grains) is exact only up to MAX_SAFE_INTEGER, and the supply
  // cap (2.1e17 grains) sits far above it: refuse the inexact band
  // instead of silently dropping grains (100000000.00000001 PRL came
  // back as 10000000000000000 grains, −1). Fleet-standard range check.
  if (grains > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("amount out of range");
  return Number(grains);
}
