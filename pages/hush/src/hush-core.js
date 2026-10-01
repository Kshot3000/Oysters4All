/* Pearl Hush — BIP-352 Silent Payments core.
 *
 * Pure ESM, zero build step for the logic itself (bundled for the browser via
 * build.mjs). Implements the sender and receiver exactly per the canonical
 * BIP-352 text (bitcoin/bips bip-0352.mediawiki, v1.1.1) and the official
 * Python reference implementation (bip-0352/reference.py), cross-checked
 * against the pinned official test vectors in src/vectors-bip352.json.
 *
 * Spec lineage (verified against the BIP text, not from memory):
 *  - Address: bech32m, HRP "sp" (mainnet) / "tsp" (testnets); data part =
 *    version char "q" (v0) || serP(Bscan) || serP(Bm), 66 bytes total.
 *    v1..v30: read the first 66 bytes, discard the rest; v31: fail.
 *  - Labels: Bm = Bspend + hashBIP0352/Label(ser256(bscan) || ser32(m))*G,
 *    m an integer (m = 0 reserved for change, m >= 1 user labels).
 *    No label  =>  Bm = Bspend.
 *  - Sender: ai = per-input private key for the taproot OUTPUT key; negate ai
 *    if ai*G has odd Y; a = sum(ai) mod n (fail if 0);
 *    input_hash = hashBIP0352/Inputs(outpointL || serP(a*G)),
 *    outpointL = lexicographically smallest 36-byte COutPoint
 *    (txid least-significant-byte-first || vout LE32);
 *    ecdh = input_hash * a * Bscan;
 *    t_k = hashBIP0352/SharedSecret(serP(ecdh) || ser32(k)) (ser32 big-endian);
 *    P_k = Bm + t_k*G, encoded as a BIP-341 taproot output (x-only).
 *    Recipients grouped by Bscan; > Kmax (2323) recipients per group fails.
 *  - Receiver: A = sum(input pubkeys) (skip tx if point at infinity);
 *    input_hash as above; ecdh = input_hash * bscan * A;
 *    P_k = Bspend + t_k*G; match xonly(P_k) against taproot outputs;
 *    label check: label = lift_x(output) - P_k, then (-lift_x(output)) - P_k,
 *    compared against hashBIP0352/Label(ser256(bscan)||ser32(m))*G for the
 *    wallet's known labels (m = 0 change label always checked).
 *  - Spending: d = (bspend + t_k + label_tweak) mod n; negate d if d*G has
 *    odd Y (BIP-340 key normalization) so xonly(d*G) is the output key.
 *  - hashBIP0352/X are BIP-340-style tagged hashes:
 *    SHA256(SHA256(tag) || SHA256(tag) || x).
 *
 * Where the task brief's shorthand formulas disagreed with the BIP text
 * (e.g. the shared secret MUST include the input_hash factor), the BIP
 * text + reference implementation + vectors win. See README.md.
 *
 * Honest scope: this is a standards-faithful reference implementation of the
 * BIP-352 math. BIP-352 is not yet supported by Pearl wallet software
 * (Oyster); this desk derives keys locally, never signs, never broadcasts.
 */

import { sha256 } from "@noble/hashes/sha256";
import { ripemd160 } from "@noble/hashes/legacy";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1";
import {
  encodeBech32mParts, decodeBech32mParts, encodeBech32m, convertBits,
} from "./bech32m.js";

export const VERSION = 1;
export { bytesToHex, hexToBytes }; // re-exported for the desk UI + tests
export const K_MAX = 2323; // per-group recipient limit (BIP-352 v1.1.0)
export const GRAIN_PER_PRL = 100_000_000n;
export const MAX_GRAINS = 21_000_000n * GRAIN_PER_PRL;
export const SP_HRP_MAIN = "sp";
export const SP_HRP_TEST = "tsp";
// NUMS point H x-coordinate (BIP-341): inputs using H as internal key are skipped.
export const NUMS_H_X = "50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0";
export const ATTRIBUTION = {
  x: "@kshot9000",
  xUrl: "https://x.com/kshot9000",
  prl: "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d",
};

const N = secp256k1.CURVE.n;
const G = secp256k1.ProjectivePoint.BASE;
const bytesToNumberBE = schnorr.utils.bytesToNumberBE;
const numberToBytesBE = schnorr.utils.numberToBytesBE;

/* ---------------- small helpers ---------------- */

export function fail(msg) { throw new Error(msg); }
const isHex = (s, len) => typeof s === "string" && (len == null ? /^[0-9a-fA-F]*$/.test(s) : /^[0-9a-fA-F]+$/.test(s) && s.length === len);

export function hexToBytesChecked(hex, len, what) {
  const h = String(hex || "").trim().toLowerCase().replace(/^0x/, "");
  if (!isHex(h, len)) fail(`bad ${what}: need ${len}-char hex, got ${JSON.stringify(String(hex).slice(0, 40))}`);
  return hexToBytes(h);
}
export function scalarFromHex(hex, what) {
  const b = hexToBytesChecked(hex, 64, what || "scalar");
  const n = bytesToNumberBE(b);
  if (n === 0n || n >= N) fail(`bad ${what || "scalar"}: not in 1..n-1`);
  return n;
}
export function ser32(i) {
  if (!Number.isInteger(i) || i < 0 || i > 0xffffffff) fail("ser32: need uint32");
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, i, false); // big-endian per BIP-352
  return b;
}
export function ser256(n) {
  if (typeof n !== "bigint" || n < 0n || n >= N) fail("ser256: need scalar");
  return numberToBytesBE(n, 32);
}
export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
export function taggedHash(tag, msg) {
  const enc = new TextEncoder();
  const tagHash = sha256(enc.encode(tag));
  return sha256(concat(tagHash, tagHash, msg));
}
const hash160 = (b) => ripemd160(sha256(b));

/* ---------------- point helpers ---------------- */

/** lift an x-only key to its even-Y point (BIP-340 lift_x). */
export function liftX(xonly32) {
  return schnorr.utils.lift_x(bytesToNumberBE(xonly32));
}
export function pointFromCompressed(hex33) {
  const b = hexToBytesChecked(hex33, 66, "compressed pubkey");
  if (b[0] !== 0x02 && b[0] !== 0x03) fail("bad compressed pubkey prefix");
  return secp256k1.ProjectivePoint.fromHex(b);
}
export function serP(P) { return P.toRawBytes(true); } // 33-byte SEC1 compressed
export function serPHex(P) { return bytesToHex(serP(P)); }
// x-only: first 32 bytes of the 65-byte uncompressed form (0x04 || x || y).
export function xonly(P) { return P.toRawBytes(false).slice(1, 33); } // 32-byte x-only
export function xonlyHex(P) { return bytesToHex(xonly(P)); }
export function hasEvenY(P) { return P.hasEvenY(); }
/** Compressed (33-byte SEC1) public key for a private-key hex scalar. */
export function compressedPubkeyFromSecret(secretHex) {
  return serPHex(G.multiply(scalarFromHex(secretHex, "private key")));
}

/* ---------------- silent-payment addresses ---------------- */

/** Encode a v0 silent-payment address: bech32m(hrp, "q" || serP(Bscan) || serP(Bm)). */
export function encodeSilentPaymentAddress(BscanHex, BmHex, hrp = SP_HRP_MAIN) {
  if (hrp !== SP_HRP_MAIN && hrp !== SP_HRP_TEST) fail(`bad hrp: want "sp" or "tsp", got ${JSON.stringify(hrp)}`);
  const Bscan = pointFromCompressed(BscanHex); // validates curve membership
  const Bm = pointFromCompressed(BmHex);
  void Bscan; void Bm;
  return encodeBech32mParts(hrp, 0, concat(hexToBytes(BscanHex.toLowerCase()), hexToBytes(BmHex.toLowerCase())));
}

/**
 * Decode a silent-payment address. Returns
 * { hrp, version, Bscan (point), Bm (point), BscanHex, BmHex }.
 * v0: data must be exactly 66 bytes. v1..v30: first 66 bytes are read,
 * remainder discarded. v31: refused. (BIP-352 § Versions)
 */
export function decodeSilentPaymentAddress(addr) {
  let parts;
  try { parts = decodeBech32mParts(addr); }
  catch (e) { fail("not a silent-payment address: " + e.message); }
  if (parts.hrp !== SP_HRP_MAIN && parts.hrp !== SP_HRP_TEST)
    fail(`not a silent-payment address: hrp ${JSON.stringify(parts.hrp)} (want "sp" or "tsp")`);
  if (parts.version === 31) fail("silent-payment version 31 is reserved: refused");
  if (parts.version > 31) fail(`bad silent-payment version: ${parts.version}`);
  if (parts.data.length < 66) fail(`bad silent-payment address: data is ${parts.data.length} bytes, need at least 66`);
  if (parts.version === 0 && parts.data.length !== 66)
    fail(`bad v0 silent-payment address: data is ${parts.data.length} bytes, need exactly 66`);
  const BscanHex = bytesToHex(parts.data.slice(0, 33));
  const BmHex = bytesToHex(parts.data.slice(33, 66));
  let Bscan, Bm;
  try { Bscan = pointFromCompressed(BscanHex); Bm = pointFromCompressed(BmHex); }
  catch (e) { fail("bad silent-payment address keys: " + e.message); }
  return { hrp: parts.hrp, version: parts.version, Bscan, Bm, BscanHex, BmHex };
}

/* ---------------- labels ---------------- */

/**
 * Label tweak scalar: hashBIP0352/Label(ser256(bscan) || ser32(m)).
 * m is an integer label (m = 0 reserved for change, m >= 1 user labels).
 */
export function labelTweak(bscanHex, m) {
  if (!Number.isInteger(m) || m < 0 || m > 0xffffffff) fail("label m must be a uint32 integer");
  const bscan = scalarFromHex(bscanHex, "scan secret");
  const t = bytesToNumberBE(taggedHash("BIP0352/Label", concat(ser256(bscan), ser32(m))));
  if (t === 0n || t >= N) fail("label tweak is not a valid scalar (astronomically unlikely)");
  return t;
}
export function labelPoint(bscanHex, m) { return G.multiply(labelTweak(bscanHex, m)); }
/** Labeled spend key Bm = Bspend + labelTweak*G. */
export function labeledSpendKey(BspendPoint, tweakScalar) { return BspendPoint.add(G.multiply(tweakScalar)); }
/** Build the labeled silent-payment address (Bscan, Bm) for label m. */
export function createLabeledAddress(bscanHex, bspendHex, m, hrp = SP_HRP_MAIN) {
  const bscan = scalarFromHex(bscanHex, "scan secret");
  const Bscan = G.multiply(bscan);
  const Bspend = pointFromCompressed(bspendHex);
  const Bm = labeledSpendKey(Bspend, labelTweak(bscanHex, m));
  const addr = encodeSilentPaymentAddress(serPHex(Bscan), serPHex(Bm), hrp);
  return { address: addr, BscanHex: serPHex(Bscan), BmHex: serPHex(Bm), tweakHex: bytesToHex(ser256(labelTweak(bscanHex, m))) };
}

/* ---------------- outpoints ---------------- */

/** 36-byte COutPoint serialization: txid least-significant-byte-first || vout LE32. */
export function outpointBytes(txidHex, vout) {
  const txid = hexToBytesChecked(txidHex, 64, "txid");
  if (!Number.isInteger(vout) || vout < 0 || vout > 0xffffffff) fail("bad vout: need uint32");
  const le = new Uint8Array(4);
  new DataView(le.buffer).setUint32(0, vout, true);
  return concat(Uint8Array.from(txid).reverse(), le);
}
const cmpBytes = (a, b) => { for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) return a[i] - b[i]; } return 0; };
/** input_hash = hashBIP0352/Inputs(outpointL || serP(A)) */
export function inputHash(outpoints36, A) {
  if (!outpoints36.length) fail("need at least one outpoint");
  const L = [...outpoints36].sort(cmpBytes)[0];
  return taggedHash("BIP0352/Inputs", concat(L, serP(A)));
}

/* ---------------- input classification (BIP-352 § Inputs For Shared Secret Derivation) --- */

function deserWitness(hex) {
  // Minimal bitcoin witness deserializer: varint count, then varint-len items.
  const b = hexToBytesChecked(hex, null, "witness");
  let o = 0;
  const varint = () => {
    if (o >= b.length) fail("witness truncated");
    const f = b[o++];
    if (f < 0xfd) return f;
    if (f === 0xfd) { const v = b[o] | (b[o + 1] << 8); o += 2; return v; }
    if (f === 0xfe) { const v = new DataView(b.buffer, b.byteOffset + o).getUint32(0, true); o += 4; return v; }
    const v = Number(new DataView(b.buffer, b.byteOffset + o).getBigUint64(0, true)); o += 8; return v;
  };
  const n = varint();
  const items = [];
  for (let i = 0; i < n; i++) { const l = varint(); items.push(b.slice(o, o + l)); o += l; }
  return items;
}
const isP2tr = (spk) => spk.length === 34 && spk[0] === 0x51 && spk[1] === 0x20;
const isP2wpkh = (spk) => spk.length === 22 && spk[0] === 0x00 && spk[1] === 0x14;
const isP2sh = (spk) => spk.length === 23 && spk[0] === 0xa9 && spk[1] === 0x14 && spk[22] === 0x87;
const isP2pkh = (spk) => spk.length === 25 && spk[0] === 0x76 && spk[1] === 0xa9 && spk[2] === 0x14 && spk[23] === 0x88 && spk[24] === 0xac;

/**
 * Extract the eligible public key for an input per BIP-352.
 * vin = { prevoutSpk (hex), scriptSig (hex), txinwitness (hex, may be "") }.
 * Returns { kind, pubkey (point) } or null when the input is skipped
 * (non-eligible type, or taproot script-path with NUMS point H internal key).
 */
export function classifyInput(vin) {
  const spk = hexToBytesChecked(vin.prevoutSpk, null, "scriptPubKey");
  const scriptSig = hexToBytesChecked(vin.scriptSig || "", null, "scriptSig");
  if (isP2pkh(spk)) {
    const want = spk.slice(3, 23);
    // Scan from the back with a 33-byte window (handles malleated scriptSigs).
    for (let i = scriptSig.length; i >= 33; i--) {
      const cand = scriptSig.slice(i - 33, i);
      if (cand[0] !== 0x02 && cand[0] !== 0x03) continue;
      if (bytesToHex(hash160(cand)) !== bytesToHex(want)) continue;
      try { return { kind: "p2pkh", pubkey: secp256k1.ProjectivePoint.fromHex(cand) }; } catch { /* keep scanning */ }
    }
    return null;
  }
  if (isP2sh(spk)) {
    if (scriptSig.length < 2) return null;
    const redeem = scriptSig.slice(1);
    if (!isP2wpkh(redeem)) return null;
    const wit = deserWitness(vin.txinwitness || "");
    if (!wit.length) return null;
    const cand = wit[wit.length - 1];
    if (cand.length !== 33 || (cand[0] !== 0x02 && cand[0] !== 0x03)) return null;
    try { return { kind: "p2sh-p2wpkh", pubkey: secp256k1.ProjectivePoint.fromHex(cand) }; } catch { return null; }
  }
  if (isP2wpkh(spk)) {
    const wit = deserWitness(vin.txinwitness || "");
    if (!wit.length) return null;
    const cand = wit[wit.length - 1];
    if (cand.length !== 33 || (cand[0] !== 0x02 && cand[0] !== 0x03)) return null;
    try { return { kind: "p2wpkh", pubkey: secp256k1.ProjectivePoint.fromHex(cand) }; } catch { return null; }
  }
  if (isP2tr(spk)) {
    const wit = deserWitness(vin.txinwitness || "");
    const stack = [...wit];
    if (stack.length >= 1) {
      if (stack.length > 1 && stack[stack.length - 1][0] === 0x50) stack.pop(); // annex
      if (stack.length > 1) {
        // Script-path spend: use the taproot output key, unless H is the internal key.
        const control = stack[stack.length - 1];
        if (control.length >= 33 && bytesToHex(control.slice(1, 33)).toLowerCase() === NUMS_H_X) return null; // NUMS H: skip
      }
    }
    try { return { kind: "p2tr", pubkey: liftX(spk.slice(2)), xonly: true }; }
    catch { return null; }
  }
  return null; // not in the Inputs For Shared Secret Derivation list
}

/* ---------------- sender ---------------- */

/**
 * Create silent-payment outputs.
 * inputs: [{ txid, vout, prevoutSpk, scriptSig?, txinwitness?, privkey (hex:
 *           private key for the taproot OUTPUT key; for P2TR inputs the key
 *           is negated first if its point has odd Y, per BIP-352) }]
 * recipients: [{ address, count? }]  (count = repeated outputs to same address)
 * opts.taprootOnly: when true, refuse any non-P2TR input loudly (the desk's
 *   Send tab policy; the core itself implements the full BIP input list so the
 *   official vectors pin byte-exact).
 * Returns { outputs: [{ address, k, pubkeyXonly, prlAddress }], sharedSecrets,
 *           inputPrivSum, inputPubKeys, inputHash, tweakDebug }.
 * Loud refusals: no eligible inputs, a_sum = 0, bad t_k, >Kmax per group.
 */
export function senderCreateOutputs({ inputs, recipients, taprootOnly = false }) {
  if (!Array.isArray(inputs) || !inputs.length) fail("need at least one input");
  if (!Array.isArray(recipients) || !recipients.length) fail("need at least one recipient");

  // input_hash commits to ALL outpoints (eligible or not); the key sum A
  // only covers eligible inputs (BIP-352 § Creating outputs + reference).
  const allOutpoints = inputs.map((inp) => outpointBytes(inp.txid, inp.vout));
  const privs = [], pubs = [], skipped = [];
  for (const inp of inputs) {
    const cls = classifyInput(inp);
    if (!cls) {
      if (taprootOnly)
        fail(`REFUSED: input ${String(inp.txid).slice(0, 12)}…:${inp.vout} is not a taproot key-path input — this desk derives shared secrets from taproot inputs only.`);
      skipped.push(`${String(inp.txid).slice(0, 12)}…:${inp.vout}`);
      continue;
    }
    if (taprootOnly && cls.kind !== "p2tr")
      fail(`REFUSED: non-taproot input (${cls.kind}) — this desk derives shared secrets from taproot key-path inputs only. Input ${String(inp.txid).slice(0, 12)}…:${inp.vout} rejected.`);
    let k = scalarFromHex(inp.privkey, "input private key");
    if (cls.xonly && !G.multiply(k).hasEvenY()) k = N - k; // BIP-352: negate taproot keys with odd Y
    privs.push(k); pubs.push(cls.pubkey);
  }
  if (!privs.length) fail("no eligible inputs for shared-secret derivation (need at least one P2TR/P2WPKH/P2SH-P2WPKH/P2PKH input with extractable key)");
  let aSum = 0n;
  for (const k of privs) aSum = (aSum + k) % N;
  if (aSum === 0n) fail("input private keys sum to zero: cannot derive a shared secret");
  const A = G.multiply(aSum);
  const ih = inputHash(allOutpoints, A);
  const ihScalar = bytesToNumberBE(ih);
  if (ihScalar === 0n || ihScalar >= N) fail("input_hash is not a valid scalar (astronomically unlikely)");

  // Expand recipients (count) and group by Bscan.
  const expanded = [];
  for (const r of recipients) {
    const dec = decodeSilentPaymentAddress(r.address);
    const count = r.count == null ? 1 : r.count;
    if (!Number.isInteger(count) || count < 1 || count > K_MAX) fail(`bad output count ${count}: need 1..${K_MAX}`);
    for (let i = 0; i < count; i++) expanded.push({ address: r.address, Bscan: dec.Bscan, Bm: dec.Bm, BscanHex: dec.BscanHex, BmHex: dec.BmHex });
  }
  const groups = new Map(); // BscanHex -> [{...}]
  for (const e of expanded) {
    if (!groups.has(e.BscanHex)) groups.set(e.BscanHex, []);
    groups.get(e.BscanHex).push(e);
  }
  for (const [g, list] of groups) if (list.length > K_MAX) fail(`recipient group exceeds Kmax (${K_MAX})`);

  const outputs = [], sharedSecrets = [];
  for (const [bscanHex, list] of groups) {
    const Bscan = list[0].Bscan;
    const ecdh = Bscan.multiply(ihScalar).multiply(aSum); // input_hash * a * Bscan
    sharedSecrets.push(serPHex(ecdh));
    let k = 0;
    for (const e of list) {
      const tk = bytesToNumberBE(taggedHash("BIP0352/SharedSecret", concat(serP(ecdh), ser32(k))));
      if (tk === 0n || tk >= N) fail(`t_${k} is not a valid scalar (astronomically unlikely)`);
      const P = e.Bm.add(G.multiply(tk));
      const x = xonlyHex(P);
      outputs.push({ address: e.address, k, pubkeyXonly: x, prlAddress: encodeBech32m("prl", 1, hexToBytes(x)) });
      k++;
    }
  }
  return {
    outputs,
    sharedSecrets,
    inputPrivSum: bytesToHex(ser256(aSum)),
    inputPubKeys: pubs.map(serPHex),
    inputHash: bytesToHex(ih),
    groupCount: groups.size,
    skippedInputs: skipped,
  };
}

/* ---------------- receiver ---------------- */

/**
 * Scan a transaction's taproot outputs for payments to (bscan, bspend).
 * args: { bscanHex (scan SECRET), bspendHex (spend SECRET — the desk
 *         derives Bspend = bspend*G itself), labelMs: [ints] (m=0 change label always
 *         included), vins: [{ txid, vout, prevoutSpk, scriptSig?, txinwitness? }],
 *         outputs: [xonlyHex], maxK = 64 }
 * Ineligible inputs are skipped for the pubkey sum A, but ALL outpoints feed
 * input_hash (BIP-352 § Scanning + reference implementation).
 * Returns { matches: [{ k, labelM|null, pubkeyXonly, prlAddress, privKeyTweak,
 *           spendPrivkey }], inputHash, aSumCompressed, ecdhCompressed,
 *           tweakPointCompressed, skipped }.
 */
export function receiverScan({ bscanHex, bspendHex, labelMs = [], vins, outputs, maxK = 64 }) {
  const bscan = scalarFromHex(bscanHex, "scan secret");
  const bspend = scalarFromHex(bspendHex, "spend secret");
  const Bscan = G.multiply(bscan);
  const Bspend = G.multiply(bspend);
  void Bscan;
  if (!Array.isArray(vins) || !vins.length) fail("need at least one input");
  if (!Array.isArray(outputs)) fail("need an outputs array");

  const allOutpoints = [];
  let A = null;
  for (const vin of vins) {
    allOutpoints.push(outpointBytes(vin.txid, vin.vout));
    const cls = classifyInput(vin);
    if (!cls) continue; // ineligible inputs contribute their outpoint only
    A = A ? A.add(cls.pubkey) : cls.pubkey;
  }
  if (!A) {
    return { matches: [], skipped: true, reason: "no eligible inputs: transaction skipped" };
  }
  if (A.equals(secp256k1.ProjectivePoint.ZERO)) {
    return { matches: [], skipped: true, reason: "input pubkeys sum to the point at infinity: transaction skipped" };
  }
  const ih = inputHash(allOutpoints, A);
  const ihScalar = bytesToNumberBE(ih);
  if (ihScalar === 0n || ihScalar >= N) fail("input_hash is not a valid scalar (astronomically unlikely)");
  const ecdh = A.multiply(ihScalar).multiply(bscan); // input_hash * bscan * A
  const tweakPoint = A.multiply(ihScalar);

  // Label map: compressed label point -> { m, tweakHex }. m = 0 always included.
  const labelSet = new Set([0, ...labelMs.filter((m) => Number.isInteger(m) && m >= 0 && m <= 0xffffffff)]);
  const labels = new Map();
  for (const m of labelSet) {
    const t = labelTweak(bscanHex, m);
    labels.set(serPHex(G.multiply(t)), { m, tweakHex: bytesToHex(ser256(t)) });
  }

  const remaining = [...outputs];
  const matches = [];
  let k = 0;
  for (;;) {
    if (k >= maxK) break;
    const tk = bytesToNumberBE(taggedHash("BIP0352/SharedSecret", concat(serP(ecdh), ser32(k))));
    if (tk === 0n || tk >= N) fail(`t_${k} is not a valid scalar (astronomically unlikely)`);
    const Pk = Bspend.add(G.multiply(tk));
    let found = null;
    for (let i = 0; i < remaining.length; i++) {
      const outX = hexToBytesChecked(remaining[i], 64, "taproot output");
      if (xonlyHex(Pk) === bytesToHex(outX)) { found = { i, labelM: null, tweakHex: null }; break; }
      let outP;
      try { outP = liftX(outX); }
      catch { continue; } // not a curve x-coordinate: can't be ours, skip
      const d1 = outP.add(Pk.negate());
      const hit1 = labels.get(serPHex(d1));
      if (hit1) { found = { i, labelM: hit1.m, tweakHex: hit1.tweakHex }; break; }
      const d2 = outP.negate().add(Pk.negate());
      const hit2 = labels.get(serPHex(d2));
      if (hit2) { found = { i, labelM: hit2.m, tweakHex: hit2.tweakHex }; break; }
    }
    if (!found) break;
    const outHex = remaining.splice(found.i, 1)[0];
    let privTweak = tk;
    if (found.tweakHex) privTweak = (tk + bytesToNumberBE(hexToBytes(found.tweakHex))) % N;
    let d = (bspend + privTweak) % N;
    if (!G.multiply(d).hasEvenY()) d = N - d; // BIP-340 key normalization
    matches.push({
      k, labelM: found.labelM, pubkeyXonly: outHex,
      prlAddress: encodeBech32m("prl", 1, hexToBytes(outHex)),
      privKeyTweak: bytesToHex(ser256(privTweak)),
      spendPrivkey: bytesToHex(ser256(d)),
    });
    k++;
  }
  return {
    matches,
    inputHash: bytesToHex(ih),
    aSumCompressed: serPHex(A),
    ecdhCompressed: serPHex(ecdh),
    tweakPointCompressed: serPHex(tweakPoint),
    skipped: false,
  };
}

/* ---------------- taproot key handling (send-tab input modes) ---------------- */

/**
 * BIP-341 key-path taptweak: d_tweaked = (d_internal + taggedHash("TapTweak", xonly)) mod n,
 * negated to even Y (the key-path signing key).
 */
export function tapTweakPrivkey(internalPrivHex) {
  const d = scalarFromHex(internalPrivHex, "internal private key");
  const P = G.multiply(d);
  const x = xonly(P);
  const t = bytesToNumberBE(taggedHash("TapTweak", x));
  let dt = (d + t) % N;
  if (dt === 0n) fail("tweaked key is zero (astronomically unlikely)");
  if (!G.multiply(dt).hasEvenY()) dt = N - dt;
  return { tweakedPrivHex: bytesToHex(ser256(dt)), tweakedXonlyHex: bytesToHex(xonly(G.multiply(dt))) };
}

/** Random 32-byte secret (browser + node). */
export function randomSecret() {
  const b = new Uint8Array(32);
  (globalThis.crypto || fail("no crypto.getRandomValues")).getRandomValues(b);
  const n = bytesToNumberBE(b);
  if (n === 0n || n >= N) return randomSecret();
  return bytesToHex(b);
}
/** Derive { scan, spend } key material: secrets + compressed pubkeys + address. */
export function generateKeyMaterial(hrp = SP_HRP_MAIN) {
  const bscanHex = randomSecret(), bspendHex = randomSecret();
  const Bscan = G.multiply(bytesToNumberBE(hexToBytes(bscanHex)));
  const Bspend = G.multiply(bytesToNumberBE(hexToBytes(bspendHex)));
  const BscanHex = serPHex(Bscan), BspendHex = serPHex(Bspend);
  return {
    bscanHex, bspendHex, BscanHex, BspendHex,
    address: encodeSilentPaymentAddress(BscanHex, BspendHex, hrp),
  };
}

/* ---------------- misc ---------------- */

export function grainsToPRL(grains) {
  const g = BigInt(grains);
  const neg = g < 0n;
  const a = neg ? -g : g;
  const whole = a / GRAIN_PER_PRL, frac = a % GRAIN_PER_PRL;
  return (neg ? "-" : "") + whole.toString() + "." + frac.toString().padStart(8, "0");
}
export function parseGrains(s, what) {
  const t = String(s == null ? "" : s).trim();
  if (!/^\d+$/.test(t)) fail(`bad ${what}: need a non-negative integer number of grains, got ${JSON.stringify(String(s).slice(0, 24))}`);
  const g = BigInt(t);
  if (g > MAX_GRAINS) fail(`bad ${what}: exceeds max supply`);
  return g;
}
