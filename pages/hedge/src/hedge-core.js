/* Pearl Hedge core — pure-Taproot covered options (covered calls + protective puts).
 *
 * Pure ESM, zero build step for developers. The browser ships a committed
 * esbuild IIFE bundle (pearl-hedge.bundle.js); node runs this file directly
 * for the verification suite.
 *
 * What this does:
 *   1. Write: a writer locks `qty` PRL collateral in a 2-leaf Taproot vault
 *      under a NUMS internal key derived from "PearlHedgeNUMS/v1":
 *        leaf E (exercise): <expiry> OP_CHECKLOCKTIMEVERIFY OP_DROP
 *                           <lockHash> OP_EQUALVERIFY <buyer_xonly> OP_CHECKSIG
 *          the buyer claims the collateral at/after the expiry block by
 *          revealing a preimage (sha256(preimage) == lockHash) and signing.
 *        leaf X (refund):   <expiry> OP_CHECKLOCKTIMEVERIFY OP_DROP
 *                           <writer_xonly> OP_CHECKSIG
 *          the writer reclaims the collateral after expiry.
 *      There is NO keypath spend — the NUMS point is nobody's key.
 *      A protective put is the same vault with the roles labeled swapped
 *      (the put holder locks their underlying; the put writer exercises).
 *   2. Fund: the canonical descriptor `pearl-hedge:v1:<hrp>:<C|P>:<writer>:
 *      <buyer>:<lockHash>:<qty>:<strike>:<expiry>:<premium>` fully determines
 *      the vault address (tamper-evident); the sealed commitment
 *      `pearl-hedge:v1:<hrp>:<sha256(descriptor)>` commits to it.
 *   3. Exercise (buyer side): the desk verifies the buyer's off-chain strike
 *      payment txid via Blockbook (GET-only, >=1 confirmation, pays
 *      strikeGrains to the writer's address — shortfalls refused in grains),
 *      checks sha256(preimage) == lockHash, refuses to build the exercise
 *      before the expiry block, signs locally with the buyer's key, and
 *      RE-VERIFIES the Schnorr signature before exposing hex.
 *      nLockTime = expiry, sequence = 0xfffffffe.
 *   4. Refund (writer side): same shape through leaf X after expiry; refused
 *      before expiry.
 *   5. Track: Blockbook lifecycle (unfunded/funded/spent/expired), expiry
 *      countdown in blocks (~194 s/block, labeled approximate).
 *   6. Verify: standalone paste-descriptor verifier -> PROVEN / NOT PROVEN.
 *
 * Honest core limitation, stated everywhere it matters: Pearl script cannot
 * atomically verify the buyer's off-chain strike payment on-chain. The desk
 * verifies the strike payment via Blockbook BEFORE the buyer's exercise tx is
 * built; the script guarantees only that collateral can go to
 * buyer-with-preimage-at/after-expiry or writer-after-expiry. Premiums are
 * pledged off-chain payments the desk never escrows. Not financial advice.
 *
 * Crypto lineage: key derivation, TapTweak, bech32m, taggedHash, tapLeafHash,
 * BIP-340/341 sighash, party-key parsing and wire serialization come from the
 * audited files/pages/sign/src/crypto.js; script-path spend planning,
 * signing, and verification come from the audited
 * files/pages/escrow/src/escrow-core.js. The refund leaf is byte-identical to
 * escrow's audited buildRefundScript (asserted by test). No new cryptography
 * is invented.
 */

import {
  taggedHash, tapLeafHash, encodeBech32m, decodeBech32m,
  schnorr, sha256, bytesToHex, hexToBytes, convertBits,
  varint, u32le, u64le, p2trScriptPubKey, txidLE, dblSha,
  DUST_GRAIN, GRAIN_PER_PRL, NETWORKS,
  walletFromMnemonic, newMnemonic, walletFromWIF,
  tweakKeypath, tweakPrivKeypath,
  fetchUtxos, fetchFeeRateGrainsPerVByte, broadcastTx, fetchTxStatus,
} from "../../sign/src/crypto.js";
import {
  partyKeyFromInput, parseXOnlyKey, scriptPathSigDigestEx,
  signForXOnly, verifySchnorrSig, buildScriptPathSpend,
  spendVBytes, planSpend, addressToProgram, scriptAsm,
  encodeScriptNum, buildRefundScript,
} from "../../escrow/src/escrow-core.js";
import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesToNumberBE, numberToBytesBE } from "@noble/curves/abstract/utils";

export {
  DUST_GRAIN, GRAIN_PER_PRL, NETWORKS,
  walletFromMnemonic, newMnemonic, walletFromWIF,
  tweakKeypath, tweakPrivKeypath,
  fetchUtxos, fetchFeeRateGrainsPerVByte, broadcastTx, fetchTxStatus,
  bytesToHex, hexToBytes, schnorr, sha256, taggedHash, dblSha, convertBits,
  encodeBech32m, decodeBech32m, p2trScriptPubKey, txidLE,
  partyKeyFromInput, parseXOnlyKey, scriptAsm, addressToProgram,
  verifySchnorrSig, signForXOnly, scriptPathSigDigestEx,
  encodeScriptNum, spendVBytes, planSpend, buildRefundScript,
};

const OP = {
  FALSE: 0x00,
  DROP: 0x75,
  EQUALVERIFY: 0x88,
  CHECKSIG: 0xac,
  CLTV: 0xb1,
};
const TAPLEAF_VERSION = 0xc0;
const MAX_LOCKTIME = 0xffffffff;
const MAX_SEQ_NONFINAL = 0xfffffffe; // non-final (CLTV satisfied) + RBF-safe
const EXPIRY_MAX_HEIGHT = 500_000_000; // expiry is a block height
export const DESCRIPTOR_PREFIX = "pearl-hedge:v1";
export const SEALED_PREFIX = "pearl-hedge:v1";
export const BLOCK_SECONDS = 194; // Pearl target block time (approximate — label as such)
export const MIN_EXPIRY_BLOCKS = 1;

function constEq(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

function pushData(data) {
  const b = data instanceof Uint8Array ? data : Uint8Array.from(data);
  if (b.length === 0) return [OP.FALSE];
  if (b.length <= 75) return [b.length, ...b];
  throw new Error("push exceeds 75 bytes");
}

/** Parse a 32-byte hex lock hash (arbitrary bytes — NOT a curve point). */
function parseLockHash(lockHash) {
  const b = lockHash instanceof Uint8Array ? lockHash : hexToBytes(String(lockHash));
  if (b.length !== 32) throw new Error("lock hash must be 32 bytes (64 hex chars)");
  return b;
}
/** Validate an expiry block height. Throws on anything consensus-invalid. */
export function validateExpiry(expiry) {
  if (!Number.isSafeInteger(expiry) || expiry < 1 || expiry >= EXPIRY_MAX_HEIGHT) {
    throw new Error("expiry must be a block height in 1..499999999");
  }
  return expiry;
}

/** Expiry in days -> blocks at the Pearl target block time. */
export function expiryBlocksFromDays(days) {
  const d = Number(days);
  if (!Number.isFinite(d) || d <= 0) throw new Error("expiry days must be a positive number");
  return Math.max(MIN_EXPIRY_BLOCKS, Math.ceil((d * 86400) / BLOCK_SECONDS));
}

/** sha256 over a 32-byte preimage -> the exercise leaf's lock hash. */
export function lockHashForPreimage(preimage) {
  const p = preimage instanceof Uint8Array ? preimage : hexToBytes(String(preimage));
  if (p.length !== 32) throw new Error("preimage must be 32 bytes (64 hex chars)");
  return sha256(p);
}

/** Exercise leaf: <expiry> CLTV DROP <lockHash:32> EQUALVERIFY <buyer_xonly> CHECKSIG.
 *  Spendable by the buyer's key at/after `expiry` when the preimage is revealed. */
export function buildExerciseScript(buyerXOnly, lockHash, expiry) {
  const b = buyerXOnly instanceof Uint8Array ? buyerXOnly : parseXOnlyKey(buyerXOnly);
  const h = parseLockHash(lockHash);
  if (b.length !== 32) throw new Error("buyer key must be 32 bytes");
  if (h.length !== 32) throw new Error("lock hash must be 32 bytes");
  schnorr.utils.lift_x(bytesToNumberBE(b)); // rejects x >= p
  validateExpiry(expiry);
  const e = encodeScriptNum(expiry);
  return Uint8Array.from([
    ...pushData(e), OP.CLTV, OP.DROP,
    ...pushData(h), OP.EQUALVERIFY,
    ...pushData(b), OP.CHECKSIG,
  ]);
}

/** Parse the exercise leaf shape back into its committed parts.
 *  <e-push> CLTV DROP <32-push> EQUALVERIFY <32-push> CHECKSIG. */
export function parseExerciseScript(leaf) {
  const l = leaf instanceof Uint8Array ? leaf : hexToBytes(String(leaf));
  const eLen = l[0];
  if (!Number.isInteger(eLen) || eLen < 1 || eLen > 4) throw new Error("unexpected exercise leaf shape");
  const p = 1 + eLen; // p: CLTV, p+1: DROP, p+2: <32>, p+35: EQUALVERIFY, p+36: <32>, p+69: CHECKSIG
  if (l.length !== p + 70) throw new Error("unexpected exercise leaf shape");
  if (l[p] !== OP.CLTV || l[p + 1] !== OP.DROP) throw new Error("unexpected exercise leaf shape");
  if (l[p + 2] !== 32 || l[p + 35] !== OP.EQUALVERIFY) throw new Error("unexpected exercise leaf shape");
  if (l[p + 36] !== 32 || l[p + 69] !== OP.CHECKSIG) throw new Error("unexpected exercise leaf shape");
  return {
    expiryBytes: l.slice(1, 1 + eLen),
    lockHash: l.slice(p + 3, p + 35),
    buyerKey: l.slice(p + 37, p + 69),
  };
}

/** Refund leaf: <expiry> CLTV DROP <writer_xonly> CHECKSIG.
 *  Byte-identical construction to the audited escrow buildRefundScript —
 *  asserted byte-for-byte in the test suite. */
export function buildHedgeRefundScript(writerXOnly, expiry) {
  return buildRefundScript(writerXOnly, expiry);
}

/** NUMS internal key bound to this option's scripts. Derived as
 *  lift_x(taggedHash("PearlHedgeNUMS/v1", leafE || leafX || 0)) — a point
 *  nobody controls, so keypath spending is impossible and the vault address
 *  is fully determined by the two leaves. */
export function numsInternalKeyHedge(exerciseScript, refundScript) {
  if (!(exerciseScript instanceof Uint8Array) || exerciseScript.length === 0) {
    throw new Error("exercise script required");
  }
  if (!(refundScript instanceof Uint8Array) || refundScript.length === 0) {
    throw new Error("refund script required");
  }
  const preimage = Uint8Array.from([...exerciseScript, ...refundScript]);
  for (let ctr = 0; ; ctr++) {
    const h = taggedHash("PearlHedgeNUMS/v1", Uint8Array.from([...preimage, ctr]));
    try {
      return schnorr.utils.pointToBytes(schnorr.utils.lift_x(bytesToNumberBE(h)));
    } catch {
      continue; // hash lands off-curve — practically unreachable, re-hash with counter
    }
  }
}

function tapBranch(a, b) {
  const [x, y] = bytesToHex(a) <= bytesToHex(b) ? [a, b] : [b, a];
  return taggedHash("TapBranch", Uint8Array.from([...x, ...y]));
}

/** 2-leaf taptree under a given internal key. Returns address, spk,
 *  tweaked key, parity, per-leaf 65-byte control blocks. */
export function taptreeHedge(network, internalXOnly, exerciseScript, refundScript) {
  if (!(internalXOnly instanceof Uint8Array) || internalXOnly.length !== 32) {
    throw new Error("internal key must be 32 bytes");
  }
  const leafE = tapLeafHash(exerciseScript);
  const leafX = tapLeafHash(refundScript);
  const root = tapBranch(leafE, leafX);
  const t = taggedHash("TapTweak", Uint8Array.from([...internalXOnly, ...root]));
  const P = schnorr.utils.lift_x(bytesToNumberBE(internalXOnly));
  const Q = P.add(schnorr.Point.BASE.multiply(bytesToNumberBE(t)));
  const tweakedX = schnorr.utils.pointToBytes(Q);
  const parity = Q.toAffine().y & 1n ? 1 : 0;
  const controlFor = (own, other) =>
    Uint8Array.from([TAPLEAF_VERSION | parity, ...internalXOnly, ...other]);
  return {
    leafE, leafX, root, tweak: t, tweakedX, parity,
    internalXOnly,
    address: encodeBech32m(network.hrp, 1, tweakedX),
    spk: p2trScriptPubKey(tweakedX),
    exerciseControlBlock: controlFor(leafE, leafX),
    refundControlBlock: controlFor(leafX, leafE),
  };
}

/** Write one option vault: exercise leaf (buyer) + refund leaf (writer),
 *  under a NUMS internal key. kind: 'C' (covered call) or 'P' (protective put).
 *  Returns everything the UI needs. */
export function forgeOption({ network, kind, writer, buyer, lockHash, qtyGrains, strikeGrains, expiry, premiumGrains = 0 }) {
  if (!network || !network.hrp) throw new Error("network required");
  if (kind !== "C" && kind !== "P") throw new Error("kind must be 'C' (covered call) or 'P' (protective put)");
  const w = writer instanceof Uint8Array ? writer : parseXOnlyKey(writer);
  const b = buyer instanceof Uint8Array ? buyer : parseXOnlyKey(buyer);
  const h = parseLockHash(lockHash);
  if (!Number.isSafeInteger(qtyGrains) || qtyGrains < DUST_GRAIN) {
    throw new Error(`collateral must be a positive integer of grains >= dust (${DUST_GRAIN})`);
  }
  if (!Number.isSafeInteger(strikeGrains) || strikeGrains <= 0) {
    throw new Error("strike must be a positive integer of grains");
  }
  if (!Number.isSafeInteger(premiumGrains) || premiumGrains < 0) {
    throw new Error("premium must be a non-negative integer of grains");
  }
  validateExpiry(expiry);
  const exerciseScript = buildExerciseScript(b, h, expiry);
  const refundScript = buildHedgeRefundScript(w, expiry);
  const internalXOnly = numsInternalKeyHedge(exerciseScript, refundScript);
  const tree = taptreeHedge(network, internalXOnly, exerciseScript, refundScript);
  const descriptor = descriptorFor({ network, kind, writer: w, buyer: b, lockHash: h, qtyGrains, strikeGrains, expiry, premiumGrains });
  return {
    kind, expiry, qtyGrains, strikeGrains, premiumGrains,
    writer: bytesToHex(w), buyer: bytesToHex(b), lockHash: bytesToHex(h),
    exerciseScript, refundScript,
    internalXOnly, tweakedX: tree.tweakedX, parity: tree.parity,
    leafE: tree.leafE, leafX: tree.leafX, root: tree.root,
    address: tree.address, spk: tree.spk,
    exerciseControlBlock: tree.exerciseControlBlock,
    refundControlBlock: tree.refundControlBlock,
    descriptor,
    sealed: sealedDescriptor(descriptor),
  };
}

/** Deterministic canonical descriptor: everything needed to re-derive the
 *  vault address. */
export function descriptorFor({ network, kind, writer, buyer, lockHash, qtyGrains, strikeGrains, expiry, premiumGrains = 0 }) {
  if (kind !== "C" && kind !== "P") throw new Error("kind must be 'C' or 'P'");
  const w = bytesToHex(writer instanceof Uint8Array ? writer : parseXOnlyKey(writer)).toLowerCase();
  const b = bytesToHex(buyer instanceof Uint8Array ? buyer : parseXOnlyKey(buyer)).toLowerCase();
  const h = bytesToHex(parseLockHash(lockHash)).toLowerCase();
  validateExpiry(expiry);
  if (!Number.isSafeInteger(qtyGrains) || qtyGrains < DUST_GRAIN) throw new Error("bad qtyGrains");
  if (!Number.isSafeInteger(strikeGrains) || strikeGrains <= 0) throw new Error("bad strikeGrains");
  if (!Number.isSafeInteger(premiumGrains) || premiumGrains < 0) throw new Error("bad premiumGrains");
  return `${DESCRIPTOR_PREFIX}:${network.hrp}:${kind}:${w}:${b}:${h}:${qtyGrains}:${strikeGrains}:${expiry}:${premiumGrains}`;
}

/** Sealed commitment: `pearl-hedge:v1:<hrp>:<sha256(canonical descriptor)>`. */
export function sealedDescriptor(descriptor) {
  const d = String(descriptor || "").trim();
  const m = /^pearl-hedge:v1:([a-z0-9]{2,8}):/.exec(d);
  if (!m) throw new Error("not a pearl-hedge descriptor");
  const te = new TextEncoder().encode(d);
  return `${SEALED_PREFIX}:${m[1]}:${bytesToHex(sha256(te))}`;
}

/** Parse a full canonical descriptor into its components. */
export function parseDescriptor(descriptor) {
  const m = /^pearl-hedge:v1:([a-z0-9]{2,8}):([CP]):([0-9a-f]{64}):([0-9a-f]{64}):([0-9a-f]{64}):(\d+):(\d+):(\d+):(\d+)$/i
    .exec(String(descriptor || "").trim());
  if (!m) throw new Error("descriptor must look like pearl-hedge:v1:<hrp>:<C|P>:<writer>:<buyer>:<lockHash>:<qty>:<strike>:<expiry>:<premium>");
  const qty = Number(m[6]), strike = Number(m[7]), expiry = Number(m[8]), premium = Number(m[9]);
  if (!Number.isSafeInteger(qty) || qty < DUST_GRAIN) throw new Error("descriptor qty below dust");
  if (!Number.isSafeInteger(strike) || strike <= 0) throw new Error("descriptor strike invalid");
  validateExpiry(expiry);
  if (!Number.isSafeInteger(premium) || premium < 0) throw new Error("descriptor premium invalid");
  const net = Object.values(NETWORKS).find((n) => n.hrp === m[1].toLowerCase());
  if (!net) throw new Error("unknown network hrp '" + m[1] + "' (expected prl/tprl/rprl)");
  return {
    network: net, kind: m[2].toUpperCase(),
    writer: m[3].toLowerCase(), buyer: m[4].toLowerCase(), lockHash: m[5].toLowerCase(),
    qtyGrains: qty, strikeGrains: strike, expiry, premiumGrains: premium,
  };
}

/** Re-derive an option vault from a descriptor.
 *  Throws if recomputation does not reproduce the descriptor (tampered). */
export function optionFromDescriptor(descriptor) {
  const p = parseDescriptor(descriptor);
  const forged = forgeOption({
    network: p.network, kind: p.kind,
    writer: p.writer, buyer: p.buyer, lockHash: p.lockHash,
    qtyGrains: p.qtyGrains, strikeGrains: p.strikeGrains,
    expiry: p.expiry, premiumGrains: p.premiumGrains,
  });
  if (forged.descriptor !== String(descriptor).trim()) {
    throw new Error("descriptor failed self-consistency check");
  }
  return { parsed: p, forged };
}

/** Strike-payment verification (GET-only): fetch the buyer's strike tx from
 *  Blockbook and check it actually paid `strikeGrains` to `writerAddress`
 *  with at least one confirmation. Returns { ok, confirmations, paidGrains }
 *  or throws with a loud refusal (shortfall reported in grains). */
export async function verifyStrikePayment({ blockbookBase, txid, writerAddress, strikeGrains }) {
  const t = String(txid || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(t)) throw new Error("strike txid must be 64 hex characters");
  if (!Number.isSafeInteger(strikeGrains) || strikeGrains <= 0) throw new Error("bad strikeGrains");
  const addr = String(writerAddress || "").trim();
  let tx;
  try {
    tx = await fetchTxStatus(blockbookBase, t);
  } catch (e) {
    throw new Error("could not fetch the strike payment from Blockbook: " + (e && e.message ? e.message : e));
  }
  const conf = Number(tx.confirmations);
  if (!Number.isFinite(conf) || conf < 1) {
    throw new Error("strike payment is unconfirmed (0 confirmations) — wait for 1+ confirmation");
  }
  const vouts = Array.isArray(tx.vout) ? tx.vout : [];
  let paid = 0;
  for (const v of vouts) {
    const addrs = Array.isArray(v.addresses) ? v.addresses : (v.scriptPubKey && Array.isArray(v.scriptPubKey.addresses) ? v.scriptPubKey.addresses : []);
    if (addrs.includes(addr)) paid += Number(v.value) || 0;
  }
  if (paid < strikeGrains) {
    const short = strikeGrains - paid;
    throw new Error(`strike underpaid: paid ${paid} grains to ${addr}, strike is ${strikeGrains} grains — shortfall ${short} grains`);
  }
  return { ok: true, confirmations: conf, paidGrains: paid };
}

/** Exact spend plan for a single-input, single-output script-path spend.
 *  stackLens: witness item lengths (e.g. [64, 32] for exercise: sig+preimage). */
export function planOptionSpend({ inputValue, feeRateGrainsPerVByte, scriptLen, controlLen, stackLens }) {
  if (!Number.isSafeInteger(inputValue) || inputValue <= 0) throw new Error("bad input value");
  if (!Number.isFinite(feeRateGrainsPerVByte) || feeRateGrainsPerVByte <= 0) throw new Error("bad fee rate");
  const vBytes = spendVBytes({ nOut: 1, scriptLen, controlLen, stackLens });
  const fee = Math.ceil(vBytes * feeRateGrainsPerVByte);
  const payment = inputValue - fee;
  if (payment < DUST_GRAIN) {
    throw new Error(`insufficient funds: ${inputValue} grains covers the ${fee}-grain fee but leaves < dust (${DUST_GRAIN}); the vault must be topped up`);
  }
  return { payment, fee, vBytes };
}

/** Shared secret parser: 12/24-word mnemonic or WIF. Throws loudly otherwise. */
function walletFromSecret(secretInput, network, role) {
  const t = String(secretInput || "").trim();
  const words = t.split(/\s+/);
  if (words.length === 12 || words.length === 24) {
    return walletFromMnemonic(t, network);
  }
  try {
    return walletFromWIF(t, network);
  } catch {
    throw new Error(`${role} secret must be a 12/24-word mnemonic or WIF private key`);
  }
}

/** Resolve a counterparty key (writer or buyer) from user input.
 *  - 64-hex x-only pubkey: used raw (mode 'raw') — the party signs with the
 *    matching mnemonic/WIF behind the internal key.
 *  - PRL address (prl1p...): its 32-byte program is the leaf key
 *    (mode 'address') — the party later signs with the keypath-tweaked
 *    private key behind their address.
 *  - 12/24-word mnemonic: the keypath-tweaked x-only key (mode 'address').
 *  Private keys are never returned here; the exercise/refund step re-derives
 *  them from the party's own import. */
export function counterpartyKeyFromInput(input, network) {
  const t = String(input || "").trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) {
    return { key: parseXOnlyKey(t), mode: "raw", source: "x-only pubkey" };
  }
  const words = t.split(/\s+/);
  if (words.length === 12 || words.length === 24) {
    const w = walletFromMnemonic(t, network);
    const { tweakedX } = tweakKeypath(w.internalXOnly);
    return { key: tweakedX, mode: "address", internalXOnly: w.internalXOnly, source: "mnemonic (keypath-tweaked)" };
  }
  const program = addressToProgram(t, network); // throws on bad address/hrp/version
  return { key: program, mode: "address", source: "PRL address" };
}
export function buyerSignerFor(secretInput, network, buyerKeyHex, mode) {
  const w = walletFromSecret(secretInput, network, "buyer");
  if (mode === "raw") {
    if (bytesToHex(w.internalXOnly).toLowerCase() !== String(buyerKeyHex).toLowerCase()) {
      throw new Error("this key does not match the buyer key in the option — wrong key imported");
    }
    return { priv: w.priv, xonly: w.internalXOnly };
  }
  const { tweakedX } = tweakKeypath(w.internalXOnly);
  if (bytesToHex(tweakedX).toLowerCase() !== String(buyerKeyHex).toLowerCase()) {
    throw new Error("this key does not match the buyer address in the option — wrong key imported");
  }
  return { priv: tweakPrivKeypath(w.priv, w.internalXOnly), xonly: tweakedX };
}

/** Resolve a writer's signing key the same way (for refunds). */
export function writerSignerFor(secretInput, network, writerKeyHex, mode) {
  const w = walletFromSecret(secretInput, network, "writer");
  if (mode === "raw") {
    if (bytesToHex(w.internalXOnly).toLowerCase() !== String(writerKeyHex).toLowerCase()) {
      throw new Error("this key does not match the writer key in the option — wrong key imported");
    }
    return { priv: w.priv, xonly: w.internalXOnly };
  }
  const { tweakedX } = tweakKeypath(w.internalXOnly);
  if (bytesToHex(tweakedX).toLowerCase() !== String(writerKeyHex).toLowerCase()) {
    throw new Error("this key does not match the writer address in the option — wrong key imported");
  }
  return { priv: tweakPrivKeypath(w.priv, w.internalXOnly), xonly: tweakedX };
}

/** Build, sign, and locally re-verify a buyer exercise transaction.
 *  Witness: <buyer_sig> <preimage>. nLockTime = expiry, seq 0xfffffffe.
 *  Loud refusals: wrong preimage, chain tip before expiry (CLTV would fail),
 *  wrong key, underfunded vault. The returned hex is only produced after the
 *  signature verifies. */
export function buildExerciseTx({
  network, utxo, option, preimage, signerPriv,
  destinationProgram, feeRateGrainsPerVByte, chainTip = null,
}) {
  if (!network || !network.hrp) throw new Error("network required");
  if (!utxo || !/^[0-9a-f]{64}$/i.test(utxo.txid || "")) throw new Error("utxo.txid required");
  if (!Number.isInteger(utxo.vout) || utxo.vout < 0) throw new Error("utxo.vout required");
  if (!Number.isSafeInteger(utxo.value) || utxo.value <= 0) throw new Error("utxo.value required");
  if (!option || !(option.exerciseScript instanceof Uint8Array)) throw new Error("option (from optionFromDescriptor) required");
  const pre = preimage instanceof Uint8Array ? preimage : hexToBytes(String(preimage || ""));
  if (pre.length !== 32) throw new Error("preimage must be 32 bytes (64 hex chars)");
  // The preimage must hash to the lock hash committed in the exercise leaf.
  const parsed = parseExerciseScript(option.exerciseScript);
  if (!constEq(sha256(pre), parsed.lockHash)) {
    throw new Error("preimage does not hash to the option's lock hash — wrong secret");
  }
  const expiry = option.parsed ? option.parsed.expiry : option.expiry;
  if (chainTip != null && Number.isSafeInteger(chainTip) && chainTip < expiry) {
    throw new Error(`exercise not yet possible: chain tip ${chainTip} is before expiry ${expiry} (CLTV would fail)`);
  }
  const input = { txid: utxo.txid, vout: utxo.vout, value: utxo.value, spk: option.forged.spk };
  const spend = planOptionSpend({
    inputValue: utxo.value,
    feeRateGrainsPerVByte,
    scriptLen: option.exerciseScript.length,
    controlLen: option.exerciseControlBlock.length,
    stackLens: [64, 32], // buyer sig + preimage
  });
  if (!(destinationProgram instanceof Uint8Array) || destinationProgram.length !== 32) {
    throw new Error("destination program must be 32 bytes");
  }
  const outputs = [{ program: destinationProgram, value: spend.payment }];
  const digest = scriptPathSigDigestEx(network, input, outputs, option.exerciseScript, {
    sequence: MAX_SEQ_NONFINAL, locktime: expiry,
  });
  const sig = signForXOnly(signerPriv, digest);
  const signerX = (() => {
    const d = bytesToNumberBE(signerPriv instanceof Uint8Array ? signerPriv : hexToBytes(String(signerPriv)));
    const P = secp256k1.ProjectivePoint.fromPrivateKey(numberToBytesBE(d, 32));
    return schnorr.utils.pointToBytes(P);
  })();
  if (!constEq(signerX, parsed.buyerKey)) {
    throw new Error("signer key does not match the buyer key committed in the exercise leaf — wrong key imported");
  }
  if (!verifySchnorrSig(sig, digest, signerX)) {
    throw new Error("local signature self-check failed — refusing to emit transaction hex");
  }
  const built = buildScriptPathSpend(network, input, outputs, option.exerciseScript, option.exerciseControlBlock, [sig, pre], {
    sequence: MAX_SEQ_NONFINAL, locktime: expiry,
  });
  if (built.digest !== bytesToHex(digest)) throw new Error("sighash mismatch between planner and serializer");
  return {
    txid: built.txid, hex: built.hex,
    fee: spend.fee, vBytes: built.vBytes, payment: spend.payment,
    sigHex: bytesToHex(sig), digestHex: bytesToHex(digest),
    locktime: expiry, sequence: MAX_SEQ_NONFINAL,
    scriptAsm: scriptAsm(option.exerciseScript),
  };
}

/** Build, sign, and locally re-verify a writer refund transaction.
 *  Witness: <writer_sig>. Refused before the expiry block. */
export function buildRefundTx({
  network, utxo, option, signerPriv,
  destinationProgram, feeRateGrainsPerVByte, chainTip = null,
}) {
  if (!network || !network.hrp) throw new Error("network required");
  if (!utxo || !/^[0-9a-f]{64}$/i.test(utxo.txid || "")) throw new Error("utxo.txid required");
  if (!Number.isInteger(utxo.vout) || utxo.vout < 0) throw new Error("utxo.vout required");
  if (!Number.isSafeInteger(utxo.value) || utxo.value <= 0) throw new Error("utxo.value required");
  if (!option || !(option.refundScript instanceof Uint8Array)) throw new Error("option (from optionFromDescriptor) required");
  const expiry = option.parsed ? option.parsed.expiry : option.expiry;
  if (chainTip != null && Number.isSafeInteger(chainTip) && chainTip < expiry) {
    throw new Error(`refund not yet possible: chain tip ${chainTip} is before expiry ${expiry} — the writer cannot reclaim early`);
  }
  const input = { txid: utxo.txid, vout: utxo.vout, value: utxo.value, spk: option.forged.spk };
  const spend = planOptionSpend({
    inputValue: utxo.value,
    feeRateGrainsPerVByte,
    scriptLen: option.refundScript.length,
    controlLen: option.refundControlBlock.length,
    stackLens: [64], // writer sig
  });
  if (!(destinationProgram instanceof Uint8Array) || destinationProgram.length !== 32) {
    throw new Error("destination program must be 32 bytes");
  }
  const outputs = [{ program: destinationProgram, value: spend.payment }];
  const digest = scriptPathSigDigestEx(network, input, outputs, option.refundScript, {
    sequence: MAX_SEQ_NONFINAL, locktime: expiry,
  });
  // Parse the refund leaf shape: <e-push> CLTV DROP <32-push> CHECKSIG.
  const leaf = option.refundScript;
  const eLen = leaf[0];
  const p = 1 + eLen;
  if (leaf.length !== p + 36 || leaf[p] !== OP.CLTV || leaf[p + 1] !== OP.DROP || leaf[p + 2] !== 32 || leaf[p + 35] !== OP.CHECKSIG) {
    throw new Error("unexpected refund leaf shape");
  }
  const leafKey = leaf.slice(p + 3, p + 35);
  const sig = signForXOnly(signerPriv, digest);
  const signerX = (() => {
    const d = bytesToNumberBE(signerPriv instanceof Uint8Array ? signerPriv : hexToBytes(String(signerPriv)));
    const P = secp256k1.ProjectivePoint.fromPrivateKey(numberToBytesBE(d, 32));
    return schnorr.utils.pointToBytes(P);
  })();
  if (!constEq(signerX, leafKey)) {
    throw new Error("signer key does not match the writer key committed in the refund leaf — wrong key imported");
  }
  if (!verifySchnorrSig(sig, digest, signerX)) {
    throw new Error("local signature self-check failed — refusing to emit transaction hex");
  }
  const built = buildScriptPathSpend(network, input, outputs, option.refundScript, option.refundControlBlock, [sig], {
    sequence: MAX_SEQ_NONFINAL, locktime: expiry,
  });
  if (built.digest !== bytesToHex(digest)) throw new Error("sighash mismatch between planner and serializer");
  return {
    txid: built.txid, hex: built.hex,
    fee: spend.fee, vBytes: built.vBytes, payment: spend.payment,
    sigHex: bytesToHex(sig), digestHex: bytesToHex(digest),
    locktime: expiry, sequence: MAX_SEQ_NONFINAL,
    scriptAsm: scriptAsm(option.refundScript),
  };
}

/** Lifecycle classification for a vault address from Blockbook data.
 *  utxos: from fetchUtxos; txCount: address tx count; tip: chain tip height. */
export function classifyLifecycle({ utxos, txCount, tip, expiry }) {
  validateExpiry(expiry);
  const funded = Array.isArray(utxos) && utxos.some((u) => u.value > 0);
  if (funded) {
    if (tip != null && Number.isSafeInteger(tip) && tip >= expiry) return "expired-funded";
    return "funded";
  }
  if (Number.isInteger(txCount) && txCount > 0) return "spent";
  return "unfunded";
}

/** Best-effort chain tip height from Blockbook (GET-only). Null when unreachable. */
export async function fetchChainTip(blockbookBase) {
  try {
    const base = String(blockbookBase || "").replace(/\/+$/, "");
    if (!base) return null;
    const s = await (await fetch(`${base}/api/v2`)).json();
    const h = s && s.blockbook && s.blockbook.bestHeight;
    return Number.isInteger(h) ? h : null;
  } catch {
    return null;
  }
}

/** GET-only Blockbook address summary: utxos + tx count. */
export async function fetchAddressSummary(blockbookBase, address) {
  const base = String(blockbookBase || "").replace(/\/+$/, "");
  if (!base) throw new Error("no Blockbook endpoint configured");
  const [utxos, info] = await Promise.all([
    fetchUtxos(blockbookBase, address),
    fetch(`${base}/api/v2/address/${address}`).then((r) => r.json()),
  ]);
  const txCount = Number(info && info.txApperances != null ? info.txApperances : info.transactions);
  return { utxos, txCount: Number.isInteger(txCount) ? txCount : (Array.isArray(info.transactions) ? info.transactions.length : 0) };
}

/** Securely wipe a secret: zero every byte of each Uint8Array passed. */
export function wipeSecrets(...secrets) {
  for (const s of secrets) {
    if (s instanceof Uint8Array) s.fill(0);
  }
}

/** Expected vault address recomputation — the audit one-liner. */
export function expectedAddress({ network, kind, writer, buyer, lockHash, qtyGrains, strikeGrains, expiry, premiumGrains = 0 }) {
  return forgeOption({ network, kind, writer, buyer, lockHash, qtyGrains, strikeGrains, expiry, premiumGrains }).address;
}
