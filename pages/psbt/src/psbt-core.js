/* Pearl PSBT core — the signing workbench for Pearl Taproot.
 *
 * Pure ESM, zero build step for node tests. The browser ships a committed
 * esbuild IIFE bundle (pearl-psbt.bundle.js) built from src/index.js.
 *
 * CRYPTO LINEAGE (no new cryptography):
 *  - SHA-256, tagged_hash, double-SHA256, bech32m encode/decode, compact-uint
 *    helpers, txid/u32/u64 little-endian helpers, P2TR scriptPubKey builder,
 *    TapLeaf hashing, keypath TapTweak and tweaked-private-key derivation, and
 *    the BIP-340 Schnorr sign/verify implementation are ALL taken from the
 *    audited files/pages/sign/src/crypto.js (from pearlpurse, verified
 *    byte-for-byte against Pearl's Go reference node/txscript).
 *  - The keypath BIP-341 sighash layout below is differentially pinned in
 *    tests against sign's audited keypathSigDigestEx (DEFAULT + SINGLE|ACP).
 *  - The control-block parity construction mirrors sign's commitKeyInfo
 *    (Q = P + H_TapTweak(P||root)*G, parity = y(Q) & 1).
 *  - Everything else in this file (BIP-174 map codec, BIP-341 message
 *    assembly for all sighash types, scriptpath fields, the combiner, the
 *    finalizer/extractor, the mini script assembler) is pure *construction*
 *    over those audited primitives — no new signature schemes, no new hashes.
 *
 * Protocol facts (verified, not from memory):
 *  - prl1… bech32m Taproot-only addresses (BIP-350 bech32m, HRP "prl",
 *    witness v1, 32-byte program); 1 PRL = 1e8 grains (smallest unit).
 *  - Pearl unsigned tx version is 1 (sign NETWORKS.mainnet.txVersion).
 *  - PSBT magic is "psbt" || 0xff; maps are key-sorted-by-convention
 *    key/value pairs terminated by a zero-length key (BIP-174).
 *  - BIP-371 Taproot key types: input 0x13 key-sig, 0x14 script-sig,
 *    0x15 leaf-script, 0x16 bip32-derivation, 0x17 internal-key,
 *    0x18 merkle-root; output 0x16/0x17/0x18.
 */

import {
  sha256, taggedHash, dblSha,
  bytesToHex, hexToBytes,
  encodeBech32m, decodeBech32m,
  u32le, txidLE, p2trScriptPubKey,
  tapLeafHash, tweakKeypath, tweakPrivKeypath,
  schnorr, NETWORKS, walletFromWIF, GRAIN_PER_PRL,
} from "../../sign/src/crypto.js";

/* ================= byte helpers ================= */

function concat(...arrs) {
  let total = 0;
  for (const a of arrs) total += a.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
function le32(n) {
  return Uint8Array.from([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
}
/** u64 little-endian from a BigInt (amounts are grain-exact BigInts). */
export function u64le(n) {
  let v = BigInt(n);
  if (v < 0n || v > 0xffffffffffffffffn) throw new Error("u64 out of range");
  const b = new Uint8Array(8);
  for (let i = 0; i < 8; i++) { b[i] = Number(v & 0xffn); v >>= 8n; }
  return b;
}
/** Bitcoin compact uint (canonical), BigInt-aware. */
export function compactUint(n) {
  const v = BigInt(n);
  if (v < 0n) throw new Error("negative compact uint");
  if (v < 0xfdn) return [Number(v)];
  if (v <= 0xffffn) return [0xfd, Number(v & 0xffn), Number((v >> 8n) & 0xffn)];
  if (v <= 0xffffffffn) return [0xfe, ...le32(Number(v))];
  if (v <= 0xffffffffffffffffn) return [0xff, ...u64le(v)];
  throw new Error("compact uint too large");
}
function bytesToBigInt(b) { return BigInt("0x" + bytesToHex(b)); }
function eq(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
export function bytesToBase64(b) {
  if (typeof Buffer !== "undefined") return Buffer.from(b).toString("base64");
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  }
  return btoa(s);
}
export function base64ToBytes(s) {
  const t = String(s).trim().replace(/\s+/g, "");
  if (t.length === 0) throw new Error("empty base64");
  if (t.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(t)) throw new Error("not valid base64");
  if (typeof Buffer !== "undefined") return Uint8Array.from(Buffer.from(t, "base64"));
  const bin = atob(t);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function randomBytes32() {
  const g = typeof globalThis !== "undefined" ? globalThis.crypto : null;
  if (!g || !g.getRandomValues) throw new Error("no secure RNG available");
  const b = new Uint8Array(32);
  g.getRandomValues(b);
  return b;
}
const utf8 = (s) => new TextEncoder().encode(s);

/* ================= binary reader ================= */

class Reader {
  constructor(bytes) { this.b = bytes; this.o = 0; }
  eof() { return this.o >= this.b.length; }
  bytes(n) {
    if (!Number.isInteger(n) || n < 0) throw new Error("bad read length");
    if (this.o + n > this.b.length) throw new Error("truncated data");
    const s = this.b.slice(this.o, this.o + n);
    this.o += n;
    return s;
  }
  u8() { return this.bytes(1)[0]; }
  u32() {
    const x = this.bytes(4);
    return (x[0] | (x[1] << 8) | (x[2] << 16)) + x[3] * 0x1000000;
  }
  u64() {
    const x = this.bytes(8);
    let v = 0n;
    for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(x[i]);
    return v;
  }
  varint() {
    const f = this.u8();
    if (f < 0xfd) return BigInt(f);
    if (f === 0xfd) { const b = this.bytes(2); return BigInt(b[0] | (b[1] << 8)); }
    if (f === 0xfe) {
      const b = this.bytes(4);
      return BigInt(b[0]) | (BigInt(b[1]) << 8n) | (BigInt(b[2]) << 16n) | (BigInt(b[3]) << 24n);
    }
    return this.u64();
  }
}

/* ================= amounts ================= */

/** Whole grains, exact BigInt. Rejects decimals, negatives, junk. */
export function parseGrains(str) {
  const t = String(str).trim();
  if (!/^\d+$/.test(t)) throw new Error("amount must be a whole number of grains (no decimals)");
  const v = BigInt(t.replace(/^0+(?=\d)/, ""));
  if (v <= 0n) throw new Error("amount must be > 0 grains");
  if (v > 21000000n * BigInt(GRAIN_PER_PRL)) throw new Error("amount exceeds max PRL supply");
  return v;
}
export function grainsToPrl(g) {
  const v = BigInt(g);
  if (v < 0n) throw new Error("negative grains");
  const w = v.toString().padStart(9, "0");
  const i = w.slice(0, -8).replace(/^0+(?=\d)/, "") || "0";
  const f = w.slice(-8).replace(/0+$/, "");
  return f ? `${i}.${f}` : i;
}

/* ================= addresses ================= */

/** Strict prl1… validation: BIP-350 bech32m, HRP prl, v1, 32-byte program,
 *  canonical re-encode. Returns the 32-byte program. */
export function validatePrlAddress(addr) {
  const d = decodeBech32m(addr, "prl"); // checksum, hrp, v1, 32-byte checks inside
  const canon = encodeBech32m("prl", 1, d.program);
  if (canon !== String(addr).trim().toLowerCase()) throw new Error("non-canonical address encoding");
  return d.program;
}
export const addressToSpk = (addr) => p2trScriptPubKey(validatePrlAddress(addr));
export const xonlyToAddress = (xonly) => encodeBech32m("prl", 1, xonly);

/* ================= taproot ================= */

/** Q = P + H_TapTweak(P || root)*G. root=null → keypath-only tweak.
 *  Same construction as sign's tweakKeypath / commitKeyInfo. */
export function tapTweak(internalXOnly, merkleRoot) {
  if (!(internalXOnly instanceof Uint8Array) || internalXOnly.length !== 32)
    throw new Error("internal key must be 32 bytes");
  if (merkleRoot !== null && (!(merkleRoot instanceof Uint8Array) || merkleRoot.length !== 32))
    throw new Error("merkle root must be 32 bytes");
  const t = taggedHash("TapTweak", merkleRoot ? concat(internalXOnly, merkleRoot) : internalXOnly);
  const P = schnorr.utils.lift_x(bytesToBigInt(internalXOnly));
  const Q = P.add(schnorr.Point.BASE.multiply(bytesToBigInt(t)));
  return { Q: schnorr.utils.pointToBytes(Q), t, parity: Number(Q.toAffine().y & 1n) };
}
/** 33-byte control block for a single-leaf tree (empty merkle path). */
export function controlBlockFor(internalXOnly, merkleRoot) {
  const { parity } = tapTweak(internalXOnly, merkleRoot);
  return Uint8Array.from([0xc0 | parity, ...internalXOnly]);
}
/** All data pushes in a script (for signer-pubkey lookup). */
export function scriptPushes(script) {
  const pushes = [];
  let i = 0;
  while (i < script.length) {
    const op = script[i++];
    let n = -1;
    if (op <= 0x4b) n = op;
    else if (op === 0x4c) { n = script[i++]; }
    else if (op === 0x4d) { n = script[i] | (script[i + 1] << 8); i += 2; }
    else if (op === 0x4e) {
      n = script[i] | (script[i + 1] << 8) | (script[i + 2] << 16) | (script[i + 3] << 24);
      i += 4;
    } else continue;
    if (n < 0 || i + n > script.length) throw new Error("truncated push in script");
    pushes.push(script.slice(i, i + n));
    i += n;
  }
  return pushes;
}

/* ================= mini script assembler =================
 * Supports the two desk templates plus a small generic set:
 *   <hex>            push hex bytes
 *   <decimal>        push as minimal script number (e.g. 500000 for CLTV)
 *   OP_CHECKSIG OP_CHECKLOCKTIMEVERIFY OP_DROP OP_EQUAL OP_EQUALVERIFY
 *   OP_SHA256 OP_HASH160 OP_DUP OP_IF OP_NOTIF OP_ELSE OP_ENDIF
 *   OP_0/OP_FALSE OP_1..OP_16/OP_TRUE OP_1NEGATE OP_RETURN OP_SWAP OP_2DROP
 *   OP_CHECKSIGVERIFY OP_CHECKSIGADD OP_CHECKSEQUENCEVERIFY OP_SIZE
 */

const OPCODES = {
  OP_0: 0x00, OP_FALSE: 0x00, OP_1NEGATE: 0x4f,
  OP_1: 0x51, OP_TRUE: 0x51, OP_2: 0x52, OP_3: 0x53, OP_4: 0x54,
  OP_5: 0x55, OP_6: 0x56, OP_7: 0x57, OP_8: 0x58, OP_9: 0x59,
  OP_10: 0x5a, OP_11: 0x5b, OP_12: 0x5c, OP_13: 0x5d, OP_14: 0x5e,
  OP_15: 0x5f, OP_16: 0x60,
  OP_DUP: 0x76, OP_EQUAL: 0x87, OP_EQUALVERIFY: 0x88,
  OP_SHA256: 0xa8, OP_HASH160: 0xa9,
  OP_CHECKSIG: 0xac, OP_CHECKSIGVERIFY: 0xad, OP_CHECKSIGADD: 0xba,
  OP_CHECKLOCKTIMEVERIFY: 0xb1, OP_CHECKSEQUENCEVERIFY: 0xb2,
  OP_DROP: 0x75, OP_2DROP: 0x6d, OP_SWAP: 0x7c, OP_SIZE: 0x82,
  OP_IF: 0x63, OP_NOTIF: 0x64, OP_ELSE: 0x67, OP_ENDIF: 0x68,
  OP_RETURN: 0x6a,
};
const OPCODE_NAMES = {};
for (const [name, code] of Object.entries(OPCODES)) {
  if (!(code in OPCODE_NAMES)) OPCODE_NAMES[code] = name;
}
// canonical display names for aliases
OPCODE_NAMES[0x00] = "OP_0"; OPCODE_NAMES[0x51] = "OP_1";
OPCODE_NAMES[0xac] = "OP_CHECKSIG"; OPCODE_NAMES[0xb1] = "OP_CHECKLOCKTIMEVERIFY";

function pushBytes(b) {
  if (b.length === 0) return [0x00];
  if (b.length <= 75) return [b.length, ...b];
  if (b.length <= 255) return [0x4c, b.length, ...b];
  if (b.length <= 520) return [0x4d, b.length & 0xff, (b.length >> 8) & 0xff, ...b];
  throw new Error("push exceeds 520 bytes");
}
/** Minimal script-number encoding. */
export function scriptNum(n) {
  let v = BigInt(n);
  if (v === 0n) return new Uint8Array(0);
  const neg = v < 0n;
  if (neg) v = -v;
  const out = [];
  while (v > 0n) { out.push(Number(v & 0xffn)); v >>= 8n; }
  if (out[out.length - 1] & 0x80) out.push(neg ? 0x80 : 0x00);
  else if (neg) out[out.length - 1] |= 0x80;
  return Uint8Array.from(out);
}
export function asmToScript(asm) {
  const toks = String(asm).trim().split(/\s+/).filter(Boolean);
  if (!toks.length) throw new Error("empty script");
  const out = [];
  for (const t of toks) {
    if (t.startsWith("<") && t.endsWith(">") && t.length >= 2) {
      const hex = t.slice(1, -1);
      if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex))
        throw new Error(`bad <hex> push: ${t}`);
      out.push(...pushBytes(hexToBytes(hex)));
    } else if (/^\d+$/.test(t)) {
      out.push(...pushBytes(scriptNum(BigInt(t))));
    } else if (t in OPCODES) {
      out.push(OPCODES[t]);
    } else {
      throw new Error(`unknown token: ${t}`);
    }
  }
  return Uint8Array.from(out);
}
/** Leaf script input: raw hex (whitespace tolerated) or ASM. */
export function parseLeafScript(input) {
  const t = String(input).trim();
  if (!t) throw new Error("leaf script required");
  const isAsm = /[<>\s]/.test(t) || /OP_[A-Z0-9_]+/.test(t) || /[^0-9a-fA-F\s]/.test(t);
  if (!isAsm) {
    const hex = t.replace(/\s+/g, "");
    if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex))
      throw new Error("bad hex leaf script");
    return hexToBytes(hex);
  }
  return asmToScript(t);
}
/** Disassembler for display (Inspect tab). */
export function scriptToAsm(script) {
  const out = [];
  let i = 0;
  while (i < script.length) {
    const op = script[i++];
    if (op <= 0x4b) {
      const data = script.slice(i, i + op);
      if (data.length !== op) throw new Error("truncated push");
      i += op;
      out.push("<" + bytesToHex(data) + ">");
      continue;
    }
    if (op === 0x4c || op === 0x4d || op === 0x4e) {
      let n;
      if (op === 0x4c) { n = script[i++]; }
      else if (op === 0x4d) { n = script[i] | (script[i + 1] << 8); i += 2; }
      else { n = script[i] | (script[i + 1] << 8) | (script[i + 2] << 16) | (script[i + 3] << 24); i += 4; }
      const data = script.slice(i, i + n);
      if (data.length !== n) throw new Error("truncated push");
      i += n;
      out.push("<" + bytesToHex(data) + ">");
      continue;
    }
    const name = OPCODE_NAMES[op];
    out.push(name !== undefined ? name : ("OP_UNKNOWN_0x" + op.toString(16).padStart(2, "0")));
  }
  return out.join(" ");
}

/* ================= unsigned transaction =================
 * Pearl tx version 1 (sign NETWORKS.mainnet.txVersion). scriptSig must be
 * empty in PSBT_GLOBAL_UNSIGNED_TX (BIP-174).
 */

export function parseUnsignedTx(bytes) {
  const r = new Reader(bytes);
  const version = r.u32();
  const nIn = r.varint();
  if (nIn > 100000n) throw new Error("absurd input count");
  const inputs = [];
  for (let i = 0n; i < nIn; i++) {
    const txidLEb = r.bytes(32);
    const vout = r.u32();
    const scriptLen = r.varint();
    if (scriptLen !== 0n) throw new Error(`input ${i}: unsigned tx must have empty scriptSig`);
    const sequence = r.u32();
    inputs.push({ txid: bytesToHex(Uint8Array.from(txidLEb).reverse()), vout, sequence });
  }
  const nOut = r.varint();
  if (nOut > 100000n) throw new Error("absurd output count");
  const outputs = [];
  for (let i = 0n; i < nOut; i++) {
    const value = r.u64();
    const sl = r.varint();
    if (sl > 10000n) throw new Error(`output ${i}: absurd script length`);
    const script = r.bytes(Number(sl));
    outputs.push({ value, script });
  }
  const locktime = r.u32();
  if (!r.eof()) throw new Error("trailing bytes in unsigned tx");
  return { version, inputs, outputs, locktime };
}
export function serializeUnsignedTx(tx) {
  const out = [...u32le(tx.version), ...compactUint(tx.inputs.length)];
  for (const inp of tx.inputs) {
    out.push(...txidLE(inp.txid), ...u32le(inp.vout), 0x00, ...u32le(inp.sequence));
  }
  out.push(...compactUint(tx.outputs.length));
  for (const o of tx.outputs) {
    out.push(...u64le(o.value), ...compactUint(o.script.length), ...o.script);
  }
  out.push(...u32le(tx.locktime));
  return Uint8Array.from(out);
}
/** Display txid: reverse(double-SHA256(stripped tx)) shown as big-endian hex. */
export function txidOfUnsigned(unsignedTxBytes) {
  return bytesToHex(Uint8Array.from(dblSha(unsignedTxBytes)).reverse());
}

/* ================= BIP-174 PSBT codec ================= */

export const PSBT_MAGIC = Uint8Array.from([0x70, 0x73, 0x62, 0x74, 0xff]); // "psbt\xff"

// Global key types
export const G_UNSIGNED_TX = 0x00, G_XPUB = 0x01;
export const G_TX_VERSION = 0xfb, G_FALLBACK_LOCKTIME = 0xfc;
export const G_INPUT_COUNT = 0xfd, G_OUTPUT_COUNT = 0xfe, G_TX_MODIFIABLE = 0xff;
// Input key types (BIP-174 + BIP-371)
export const IN_NON_WITNESS_UTXO = 0x00, IN_WITNESS_UTXO = 0x01;
export const IN_PARTIAL_SIG = 0x02, IN_SIGHASH_TYPE = 0x03;
export const IN_FINAL_SCRIPTSIG = 0x07, IN_FINAL_SCRIPTWITNESS = 0x08;
export const IN_TAP_KEY_SIG = 0x13, IN_TAP_SCRIPT_SIG = 0x14;
export const IN_TAP_LEAF_SCRIPT = 0x15, IN_TAP_BIP32_DERIVATION = 0x16;
export const IN_TAP_INTERNAL_KEY = 0x17, IN_TAP_MERKLE_ROOT = 0x18;
// Output key types
export const OUT_AMOUNT = 0x03, OUT_SCRIPT = 0x04;
export const OUT_TAP_BIP32_DERIVATION = 0x16, OUT_TAP_INTERNAL_KEY = 0x17;
export const OUT_TAP_TREE = 0x18;

function readMap(r, label) {
  const pairs = [];
  const seen = new Set();
  for (;;) {
    const klen = r.varint();
    if (klen === 0n) break;
    if (klen > 512n) throw new Error(`${label}: key too long`);
    const key = r.bytes(Number(klen));
    const vlen = r.varint();
    if (vlen > 10_000_000n) throw new Error(`${label}: value too long`);
    const value = r.bytes(Number(vlen));
    const kh = bytesToHex(key);
    if (seen.has(kh)) throw new Error(`${label}: duplicate key 0x${kh}`);
    seen.add(kh);
    pairs.push({ key, value });
  }
  return pairs;
}
function writeMap(pairs) {
  const out = [];
  for (const { key, value } of pairs) {
    out.push(...compactUint(key.length), ...key, ...compactUint(value.length), ...value);
  }
  out.push(0x00);
  return Uint8Array.from(out);
}
const findKey = (pairs, b0, keyLen = 1) =>
  pairs.find((p) => p.key.length === keyLen && p.key[0] === b0);
const findKeyPrefix = (pairs, b0, keyLen) =>
  pairs.filter((p) => p.key.length === keyLen && p.key[0] === b0);

export function parsePsbt(bytes) {
  const r = new Reader(bytes);
  const magic = r.bytes(5);
  if (!eq(magic, PSBT_MAGIC)) throw new Error("bad magic: not a PSBT (expected 'psbt\\xff')");
  const globalPairs = readMap(r, "global");
  const unsignedTxEntry = findKey(globalPairs, G_UNSIGNED_TX);
  if (!unsignedTxEntry) throw new Error("global map missing PSBT_GLOBAL_UNSIGNED_TX (0x00)");
  const unsignedTxBytes = unsignedTxEntry.value;
  const unsignedTx = parseUnsignedTx(unsignedTxBytes);
  // standard count fields, when present, must match
  for (const [kt, label, want] of [
    [G_INPUT_COUNT, "input", unsignedTx.inputs.length],
    [G_OUTPUT_COUNT, "output", unsignedTx.outputs.length],
  ]) {
    const e = findKey(globalPairs, kt);
    if (e) {
      const n = new Reader(e.value).varint();
      if (n !== BigInt(want)) throw new Error(`PSBT_GLOBAL_${label.toUpperCase()}_COUNT mismatch (${n} vs ${want})`);
    }
  }
  const inputs = [], outputs = [];
  for (let i = 0; i < unsignedTx.inputs.length; i++) inputs.push(readMap(r, `input ${i}`));
  for (let i = 0; i < unsignedTx.outputs.length; i++) outputs.push(readMap(r, `output ${i}`));
  if (!r.eof()) throw new Error("trailing bytes after output maps");
  return { globalPairs, unsignedTx, unsignedTxBytes, inputs, outputs };
}
export const parsePsbtBase64 = (b64) => parsePsbt(base64ToBytes(b64));
export function serializePsbt(psbt) {
  return concat(
    PSBT_MAGIC,
    writeMap(psbt.globalPairs),
    ...psbt.inputs.map(writeMap),
    ...psbt.outputs.map(writeMap),
  );
}
export const psbtToBase64 = (psbt) => bytesToBase64(serializePsbt(psbt));
function upsertPair(pairs, key, value) {
  const kh = bytesToHex(key);
  const i = pairs.findIndex((p) => bytesToHex(p.key) === kh);
  const e = { key, value };
  if (i >= 0) pairs[i] = e; else pairs.push(e);
}

/* ================= Create (unsigned PSBTv0) =================
 * inputs: [{ txid (64-hex BE), vout, amount (grains, BigInt|string),
 *            mode: "keypath"|"scriptpath", internalKey (64-hex x-only),
 *            script (hex|ASM, scriptpath only) }]
 * outputs: [{ address, amount } | { opReturn (hex ≤80B), amount: "0" }]
 */

export function createPsbt({ inputs, outputs, locktime = 0 }) {
  if (!Array.isArray(inputs) || inputs.length === 0) throw new Error("at least one input required");
  if (!Array.isArray(outputs) || outputs.length === 0) throw new Error("at least one output required");
  if (!Number.isInteger(locktime) || locktime < 0 || locktime > 0xffffffff)
    throw new Error("locktime must be a uint32");
  const txInputs = [], txOutputs = [], inMaps = [], outMaps = [];
  const inputInfo = [];
  let totalIn = 0n, totalOut = 0n;
  inputs.forEach((inp, i) => {
    const label = `input ${i}`;
    if (!/^[0-9a-fA-F]{64}$/.test(inp.txid || "")) throw new Error(`${label}: bad txid (64 hex chars)`);
    const vout = inp.vout;
    if (!Number.isInteger(vout) || vout < 0 || vout > 0xffffffff) throw new Error(`${label}: bad vout`);
    const amount = BigInt(inp.amount);
    if (amount <= 0n || amount > 0xffffffffffffffffn) throw new Error(`${label}: bad amount`);
    if (!/^[0-9a-fA-F]{64}$/.test(inp.internalKey || "")) throw new Error(`${label}: internal key must be 32-byte x-only hex`);
    const internalKey = hexToBytes(inp.internalKey.toLowerCase());
    let merkleRoot = null, leafScript = null, controlBlock = null, leafHash = null;
    if (inp.mode === "scriptpath") {
      leafScript = parseLeafScript(inp.script);
      if (leafScript.length === 0 || leafScript.length > 10000) throw new Error(`${label}: bad leaf script length`);
      leafHash = tapLeafHash(leafScript);
      merkleRoot = leafHash; // single-leaf tree: root IS the leaf hash
      controlBlock = controlBlockFor(internalKey, merkleRoot);
    } else if (inp.mode !== "keypath") {
      throw new Error(`${label}: mode must be "keypath" or "scriptpath"`);
    }
    const { Q } = tapTweak(internalKey, merkleRoot);
    const spk = p2trScriptPubKey(Q);
    const witnessUtxo = concat(u64le(amount), Uint8Array.from(compactUint(spk.length)), spk);
    const pairs = [
      { key: Uint8Array.from([IN_WITNESS_UTXO]), value: witnessUtxo },
      { key: Uint8Array.from([IN_TAP_INTERNAL_KEY]), value: internalKey },
    ];
    if (merkleRoot) {
      pairs.push({ key: Uint8Array.from([IN_TAP_MERKLE_ROOT]), value: merkleRoot });
      pairs.push({ key: concat(Uint8Array.from([IN_TAP_LEAF_SCRIPT]), controlBlock), value: leafScript });
      // BIP-371 tap derivation: 1 leaf hash, zero master fp, empty path
      pairs.push({
        key: concat(Uint8Array.from([IN_TAP_BIP32_DERIVATION]), internalKey),
        value: concat(Uint8Array.from(compactUint(1)), leafHash, new Uint8Array(4), Uint8Array.from(compactUint(0))),
      });
    }
    inMaps.push(pairs);
    txInputs.push({ txid: inp.txid.toLowerCase(), vout, sequence: 0xffffffff });
    totalIn += amount;
    inputInfo.push({
      mode: inp.mode, internalKeyHex: inp.internalKey.toLowerCase(),
      outputKeyHex: bytesToHex(Q), spkHex: bytesToHex(spk),
      leafHashHex: leafHash ? bytesToHex(leafHash) : null,
      leafAsm: leafScript ? scriptToAsm(leafScript) : null,
    });
  });
  const outputInfo = [];
  outputs.forEach((o, i) => {
    const label = `output ${i}`;
    let script, amount;
    if (o.opReturn !== undefined) {
      const hex = String(o.opReturn).trim().replace(/\s+/g, "");
      if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new Error(`${label}: bad OP_RETURN hex`);
      const data = hexToBytes(hex);
      if (data.length > 80) throw new Error(`${label}: OP_RETURN data > 80 bytes`);
      amount = BigInt(o.amount || 0);
      if (amount !== 0n) throw new Error(`${label}: OP_RETURN output amount must be 0`);
      script = concat(Uint8Array.from([0x6a]), Uint8Array.from(pushBytes(data)));
      outputInfo.push({ kind: "op_return", dataHex: hex });
    } else {
      const prog = validatePrlAddress(o.address);
      script = p2trScriptPubKey(prog);
      amount = BigInt(o.amount);
      if (amount <= 0n || amount > 0xffffffffffffffffn) throw new Error(`${label}: bad amount`);
      outputInfo.push({ kind: "p2tr", address: String(o.address).trim().toLowerCase() });
    }
    outMaps.push([
      { key: Uint8Array.from([OUT_AMOUNT]), value: u64le(amount) },
      { key: Uint8Array.from([OUT_SCRIPT]), value: script },
    ]);
    txOutputs.push({ value: amount, script });
    totalOut += amount;
  });
  if (totalOut > totalIn) throw new Error(`outputs (${totalOut}) exceed inputs (${totalIn})`);
  const fee = totalIn - totalOut;
  const unsignedTx = { version: 1, inputs: txInputs, outputs: txOutputs, locktime };
  const unsignedTxBytes = serializeUnsignedTx(unsignedTx);
  const psbt = {
    globalPairs: [
      { key: Uint8Array.from([G_UNSIGNED_TX]), value: unsignedTxBytes },
      { key: Uint8Array.from([G_TX_MODIFIABLE]), value: Uint8Array.from([0x03]) }, // inputs+outputs modifiable
    ],
    unsignedTx, unsignedTxBytes,
    inputs: inMaps, outputs: outMaps,
  };
  // rough keypath vsize estimate (labeled as such in the UI)
  const base = 10 + 41 * txInputs.length + 43 * txOutputs.length;
  const vsize = Math.ceil((4 * base + 2 + 66 * txInputs.length) / 4);
  return {
    base64: psbtToBase64(psbt),
    fee, totalIn, totalOut,
    inputCount: txInputs.length, outputCount: txOutputs.length,
    vsizeEst: vsize,
    feeRateEst: fee === 0n ? "0" : (Number(fee) / vsize).toFixed(2),
    txidPreview: txidOfUnsigned(unsignedTxBytes),
    inputInfo, outputInfo,
  };
}

/* ================= BIP-341 Taproot sighash =================
 * sighash = tagged_hash("TapSighash",
 *   0x00 || hash_type || nVersion || nLockTime ||
 *   [sha_prevouts || sha_amounts || sha_scriptpubkeys || sha_sequences]  (unless ANYONECANPAY) ||
 *   [sha_outputs]  (unless NONE or SINGLE) ||
 *   spend_type || [scriptpath: leaf_hash || key_version || codesep_pos] ||
 *   (ANYONECANPAY ? outpoint || amount || spk || nSequence : input_index) ||
 *   [SINGLE: sha_single_output])
 * sha_* components are single-SHA256 (Pearl node/txscript, same as BIP-341).
 * scriptPubKeys are compact-size-prefixed inside sha_scriptpubkeys and the
 * per-input section; outputs hash as amount(8LE) || compactsize(spk) || spk.
 */

export const SIGHASH = {
  DEFAULT: 0x00, ALL: 0x01, NONE: 0x02, SINGLE: 0x03,
  ALL_ANYONECANPAY: 0x81, NONE_ANYONECANPAY: 0x82, SINGLE_ANYONECANPAY: 0x83,
};
const SIGHASH_NAMES = {
  0x00: "DEFAULT", 0x01: "ALL", 0x02: "NONE", 0x03: "SINGLE",
  0x81: "ALL|ANYONECANPAY", 0x82: "NONE|ANYONECANPAY", 0x83: "SINGLE|ANYONECANPAY",
};
export function sighashName(b) {
  const n = SIGHASH_NAMES[b];
  if (n === undefined) throw new Error(`unknown sighash byte 0x${Number(b).toString(16).padStart(2, "0")}`);
  return n;
}
export const SIGHASH_OPTIONS = [0x00, 0x01, 0x02, 0x03, 0x81, 0x82, 0x83];

export function taprootSighash({ tx, inputIndex, prevouts, hashType = 0x00, scriptPath = null }) {
  sighashName(hashType); // validates the byte
  const nIn = tx.inputs.length;
  if (!Number.isInteger(inputIndex) || inputIndex < 0 || inputIndex >= nIn)
    throw new Error("input index out of range");
  if (!Array.isArray(prevouts) || prevouts.length !== nIn)
    throw new Error("prevouts length must match input count");
  const acp = (hashType & 0x80) !== 0;
  const base = hashType & 0x1f; // 0x00 DEFAULT behaves like ALL for outputs
  const msg = [];
  const push = (...parts) => { for (const p of parts) msg.push(...p); };
  push([0x00, hashType]);
  push(u32le(tx.version), u32le(tx.locktime));
  if (!acp) {
    push(sha256(concat(...tx.inputs.map((inp) =>
      concat(txidLE(inp.txid), le32(inp.vout))))));
    push(sha256(concat(...prevouts.map((p) => u64le(p.amount)))));
    push(sha256(concat(...prevouts.map((p) =>
      concat(Uint8Array.from(compactUint(p.spk.length)), p.spk)))));
    push(sha256(concat(...tx.inputs.map((inp) => le32(inp.sequence)))));
  }
  if (base !== 0x02 && base !== 0x03) { // not NONE / SINGLE
    push(sha256(concat(...tx.outputs.map((o) =>
      concat(u64le(o.value), Uint8Array.from(compactUint(o.script.length)), o.script)))));
  }
  push([scriptPath ? 0x02 : 0x00]); // spend_type: scriptpath ext_flag, no annex
  if (scriptPath) {
    if (!(scriptPath.leafHash instanceof Uint8Array) || scriptPath.leafHash.length !== 32)
      throw new Error("scriptPath.leafHash must be 32 bytes");
    push(scriptPath.leafHash, [0x00], u32le(0xffffffff)); // key_version, codesep_pos
  }
  if (acp) {
    const inp = tx.inputs[inputIndex], p = prevouts[inputIndex];
    push(txidLE(inp.txid), le32(inp.vout), u64le(p.amount),
      Uint8Array.from(compactUint(p.spk.length)), p.spk, le32(inp.sequence));
  } else {
    push(u32le(inputIndex));
  }
  if (base === 0x03) { // SINGLE commits to the output at the input index
    if (inputIndex >= tx.outputs.length)
      throw new Error("SIGHASH_SINGLE: no output at input index");
    const o = tx.outputs[inputIndex];
    push(sha256(concat(u64le(o.value), Uint8Array.from(compactUint(o.script.length)), o.script)));
  }
  return taggedHash("TapSighash", Uint8Array.from(msg));
}

/** prevouts (amount + actual scriptPubKey) from PSBT_IN_WITNESS_UTXO entries. */
export function prevoutsFromPsbt(psbt) {
  return psbt.inputs.map((pairs, i) => {
    const w = findKey(pairs, IN_WITNESS_UTXO);
    if (!w) throw new Error(`input ${i}: missing PSBT_IN_WITNESS_UTXO (needed for the BIP-341 sighash)`);
    const r = new Reader(w.value);
    const amount = r.u64();
    const sl = r.varint();
    if (sl > 10000n) throw new Error(`input ${i}: absurd scriptPubKey length`);
    const spk = r.bytes(Number(sl));
    if (!r.eof()) throw new Error(`input ${i}: trailing bytes in witness UTXO`);
    return { amount, spk };
  });
}

/* ================= Sign =================
 * privKey: 32-byte Uint8Array (hex or WIF parsed by the caller).
 * Keypath: accepts the internal key's privkey (desk tweaks it) OR an
 * already-tweaked key whose pubkey equals Q — reports which path was taken.
 * Scriptpath: the leaf signer's raw privkey (no tweak); its x-only pubkey
 * must appear as a 32-byte push in the chosen leaf script.
 * The fresh signature is RE-VERIFIED against the sighash before the PSBT is
 * mutated; failure throws instead of reporting success.
 */

export function parsePrivKey(input) {
  const t = String(input).trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) return hexToBytes(t.toLowerCase());
  try {
    return walletFromWIF(t, NETWORKS.mainnet).priv;
  } catch {
    throw new Error("private key must be 32-byte hex or mainnet WIF");
  }
}

export function signPsbtInput({ psbt, inputIndex, privKey, hashType = 0x00, leafIndex = 0, auxRand = null }) {
  sighashName(hashType);
  if (!(privKey instanceof Uint8Array) || privKey.length !== 32)
    throw new Error("private key must be 32 bytes");
  const tx = psbt.unsignedTx;
  if (!Number.isInteger(inputIndex) || inputIndex < 0 || inputIndex >= tx.inputs.length)
    throw new Error("input index out of range");
  const prevouts = prevoutsFromPsbt(psbt);
  const pairs = psbt.inputs[inputIndex];
  const internalE = findKey(pairs, IN_TAP_INTERNAL_KEY);
  if (!internalE || internalE.value.length !== 32)
    throw new Error(`input ${inputIndex}: missing PSBT_IN_TAP_INTERNAL_KEY`);
  const internalKey = internalE.value;
  const merkleE = findKey(pairs, IN_TAP_MERKLE_ROOT);
  const merkleRoot = merkleE ? merkleE.value : null;
  if (merkleE && merkleE.value.length !== 32)
    throw new Error(`input ${inputIndex}: bad merkle root length`);
  const leafEntries = findKeyPrefix(pairs, IN_TAP_LEAF_SCRIPT, 34).map((p) => ({
    controlBlock: p.key.slice(1), script: p.value, leafHash: tapLeafHash(p.value),
  }));
  const pubBytes = schnorr.getPublicKey(privKey);
  let mode, sighash, signKey, verifyKey, sigKey, keyNote;
  if (leafEntries.length === 0) {
    // ---- keypath ----
    mode = "keypath";
    const { Q } = tapTweak(internalKey, merkleRoot);
    const qHex = bytesToHex(Q);
    if (bytesToHex(pubBytes) === qHex) {
      signKey = privKey; // already the tweaked key
      keyNote = "pasted key is the tweaked keypath key (pubkey == Q)";
    } else {
      const tweaked = tweakPrivKeypath(privKey, internalKey);
      if (bytesToHex(schnorr.getPublicKey(tweaked)) !== qHex) {
        throw new Error(
          `input ${inputIndex}: private key matches neither the tweaked output key Q (${qHex.slice(0, 16)}…) ` +
          "nor the internal key it was derived from — wrong key or wrong input");
      }
      signKey = tweaked;
      keyNote = "pasted key is the internal key; desk applied the TapTweak";
    }
    verifyKey = Q;
    sighash = taprootSighash({ tx, inputIndex, prevouts, hashType, scriptPath: null });
    sigKey = Uint8Array.from([IN_TAP_KEY_SIG]);
  } else {
    // ---- scriptpath ----
    mode = "scriptpath";
    const leaf = leafEntries[leafIndex];
    if (!leaf) throw new Error(`input ${inputIndex}: leaf index out of range`);
    const pushes = scriptPushes(leaf.script);
    if (!pushes.some((p) => p.length === 32 && eq(p, pubBytes))) {
      throw new Error(
        `input ${inputIndex}: this key's x-only pubkey is not a 32-byte push in the chosen leaf script — ` +
        "it cannot sign this leaf");
    }
    signKey = privKey; // scriptpath: raw key, no tweak
    verifyKey = pubBytes;
    sighash = taprootSighash({ tx, inputIndex, prevouts, hashType, scriptPath: { leafHash: leaf.leafHash } });
    sigKey = concat(Uint8Array.from([IN_TAP_SCRIPT_SIG]), pubBytes, leaf.leafHash);
    keyNote = `signing leaf ${leafIndex} (leaf hash ${bytesToHex(leaf.leafHash).slice(0, 16)}…)`;
  }
  const sig64 = schnorr.sign(sighash, signKey, auxRand || randomBytes32());
  if (!schnorr.verify(sig64, sighash, verifyKey))
    throw new Error("internal error: fresh signature failed re-verification");
  // SIGHASH_DEFAULT (0x00): 64 bytes, no suffix. Others: 65 bytes + type byte.
  const sig = hashType === 0x00 ? sig64 : concat(sig64, Uint8Array.from([hashType]));
  upsertPair(pairs, sigKey, sig);
  const declared = findKey(pairs, IN_SIGHASH_TYPE);
  let declaredWarn = null;
  if (declared && declared.value.length === 4) {
    const dv = new Reader(declared.value).u32();
    if (dv !== hashType) declaredWarn = `PSBT declares ${sighashName(dv)} but you signed ${sighashName(hashType)}`;
  }
  return {
    sighashHex: bytesToHex(sighash),
    sigHex: bytesToHex(sig),
    pubkeyHex: bytesToHex(verifyKey),
    mode, keyNote, declaredWarn,
    leafHashHex: leafEntries.length ? bytesToHex(leafEntries[leafIndex].leafHash) : null,
  };
}

/* ================= Combine (BIP-174) =================
 * Union of all key/value pairs per map; identical keys must carry identical
 * values or the combine is rejected. Unsigned transactions must match
 * byte-for-byte.
 */

export function combinePsbts(b64a, b64b) {
  const a = parsePsbtBase64(b64a), b = parsePsbtBase64(b64b);
  if (!eq(a.unsignedTxBytes, b.unsignedTxBytes))
    throw new Error("unsigned transactions differ — refusing to combine PSBTs that spend different txns");
  if (a.inputs.length !== b.inputs.length || a.outputs.length !== b.outputs.length)
    throw new Error("input/output count mismatch between the two PSBTs");
  const mergeMaps = (ma, mb, label) => {
    const out = ma.map((p) => ({ key: p.key, value: p.value }));
    const seen = new Map(out.map((p) => [bytesToHex(p.key), bytesToHex(p.value)]));
    for (const p of mb) {
      const kh = bytesToHex(p.key), vh = bytesToHex(p.value);
      if (seen.has(kh)) {
        if (seen.get(kh) !== vh) throw new Error(`${label}: conflicting values for key 0x${kh}`);
      } else {
        seen.set(kh, vh);
        out.push({ key: p.key, value: p.value });
      }
    }
    return out;
  };
  const psbt = {
    globalPairs: mergeMaps(a.globalPairs, b.globalPairs, "global map"),
    unsignedTx: a.unsignedTx,
    unsignedTxBytes: a.unsignedTxBytes,
    inputs: a.inputs.map((m, i) => mergeMaps(m, b.inputs[i], `input ${i}`)),
    outputs: a.outputs.map((m, i) => mergeMaps(m, b.outputs[i], `output ${i}`)),
  };
  return psbtToBase64(psbt);
}

/* ================= Finalize + Extract =================
 * Keypath input:   witness = [sig]            (from PSBT_IN_TAP_KEY_SIG)
 * Scriptpath input: witness = [sigs…, script, control_block]
 *   (control block comes from the PSBT_IN_TAP_LEAF_SCRIPT key; this desk
 *   creates single-leaf trees so the merkle path is empty)
 * Every signature is re-verified against its sighash before the witness is
 * accepted. Extract serializes the witness tx and reports the txid.
 */

function sigHashTypeOf(sig, label) {
  if (sig.length === 64) return 0x00;
  if (sig.length === 65) { sighashName(sig[64]); return sig[64]; }
  throw new Error(`${label}: bad signature length ${sig.length}`);
}
function parseWitnessStack(bytes) {
  const r = new Reader(bytes);
  const n = r.varint();
  const stack = [];
  for (let i = 0n; i < n; i++) {
    const l = r.varint();
    stack.push(r.bytes(Number(l)));
  }
  if (!r.eof()) throw new Error("trailing bytes in witness stack");
  return stack;
}

export function finalizePsbtInput(psbt, i, prevouts) {
  const tx = psbt.unsignedTx;
  if (!prevouts) prevouts = prevoutsFromPsbt(psbt);
  const pairs = psbt.inputs[i];
  const keySigE = findKey(pairs, IN_TAP_KEY_SIG);
  const scriptSigEs = findKeyPrefix(pairs, IN_TAP_SCRIPT_SIG, 65).map((p) => ({
    pubkey: p.key.slice(1, 33), leafHash: p.key.slice(33, 65), sig: p.value,
  }));
  const leafEs = findKeyPrefix(pairs, IN_TAP_LEAF_SCRIPT, 34).map((p) => ({
    controlBlock: p.key.slice(1), script: p.value, leafHash: tapLeafHash(p.value),
  }));
  const internalE = findKey(pairs, IN_TAP_INTERNAL_KEY);
  const internalKey = internalE ? internalE.value : null;
  const merkleE = findKey(pairs, IN_TAP_MERKLE_ROOT);
  const merkleRoot = merkleE ? merkleE.value : null;
  let witness, desc;
  if (keySigE && scriptSigEs.length === 0) {
    // ---- keypath ----
    if (!internalKey) throw new Error(`input ${i}: keypath sig without internal key`);
    const { Q } = tapTweak(internalKey, merkleRoot);
    const ht = sigHashTypeOf(keySigE.value, `input ${i} key sig`);
    const sighash = taprootSighash({ tx, inputIndex: i, prevouts, hashType: ht, scriptPath: null });
    if (!schnorr.verify(keySigE.value.slice(0, 64), sighash, Q))
      throw new Error(`input ${i}: keypath signature does not verify — refusing to finalize`);
    witness = [keySigE.value];
    desc = `keypath · sig ${sighashName(ht)} verified against Q`;
  } else if (scriptSigEs.length > 0 && !keySigE) {
    // ---- scriptpath ----
    const byLeaf = new Map();
    for (const s of scriptSigEs) {
      const h = bytesToHex(s.leafHash);
      if (!byLeaf.has(h)) byLeaf.set(h, []);
      byLeaf.get(h).push(s);
    }
    let chosen = null;
    for (const leaf of leafEs) {
      const h = bytesToHex(leaf.leafHash);
      const sigs = byLeaf.get(h);
      if (!sigs || sigs.length === 0) continue;
      // verify every sig for this leaf against the scriptpath sighash
      let okAll = true;
      for (const s of sigs) {
        const ht = sigHashTypeOf(s.sig, `input ${i} script sig`);
        const sighash = taprootSighash({
          tx, inputIndex: i, prevouts, hashType: ht, scriptPath: { leafHash: leaf.leafHash },
        });
        if (!schnorr.verify(s.sig.slice(0, 64), sighash, s.pubkey)) { okAll = false; break; }
      }
      if (okAll) { chosen = { leaf, sigs }; break; }
    }
    if (!chosen) throw new Error(`input ${i}: no leaf with fully-verifying script sigs`);
    witness = [...chosen.sigs.map((s) => s.sig), chosen.leaf.script, chosen.leaf.controlBlock];
    desc = `scriptpath · ${chosen.sigs.length} sig(s) verified, leaf ${bytesToHex(chosen.leaf.leafHash).slice(0, 16)}…`;
  } else if (keySigE && scriptSigEs.length > 0) {
    throw new Error(`input ${i}: has both keypath and scriptpath sigs — ambiguous, refusing`);
  } else {
    throw new Error(`input ${i}: no signatures present — sign it first`);
  }
  const witBytes = concat(
    Uint8Array.from(compactUint(witness.length)),
    ...witness.map((w) => concat(Uint8Array.from(compactUint(w.length)), w)),
  );
  // BIP-174: a finalized input keeps only PSBT_IN_FINAL_SCRIPTWITNESS —
  // partial sigs and taproot metadata are stripped.
  psbt.inputs[i] = [{ key: Uint8Array.from([IN_FINAL_SCRIPTWITNESS]), value: witBytes }];
  return { ok: true, witnessHex: witness.map(bytesToHex), desc };
}

export function finalizePsbt(b64) {
  const psbt = parsePsbtBase64(b64);
  const prevouts = prevoutsFromPsbt(psbt); // computed once — finalize strips UTXO data per input
  const results = psbt.inputs.map((_, i) => finalizePsbtInput(psbt, i, prevouts));
  return { base64: psbtToBase64(psbt), results };
}

function serializeWitnessTx(tx, witnesses) {
  const core = serializeUnsignedTx(tx);
  const body = core.slice(4, core.length - 4); // inputs + outputs
  const wit = concat(...witnesses.map((stack) =>
    concat(Uint8Array.from(compactUint(stack.length)),
      ...stack.map((w) => concat(Uint8Array.from(compactUint(w.length)), w)))));
  return concat(core.slice(0, 4), Uint8Array.from([0x00, 0x01]), body, wit, core.slice(core.length - 4));
}

/** Extract the final network transaction: raw hex + txid. */
export function extractTx(psbtOrB64) {
  const psbt = typeof psbtOrB64 === "string" ? parsePsbtBase64(psbtOrB64) : psbtOrB64;
  const tx = psbt.unsignedTx;
  const witnesses = tx.inputs.map((_, i) => {
    const f = findKey(psbt.inputs[i], IN_FINAL_SCRIPTWITNESS);
    if (!f) throw new Error(`input ${i} is not finalized`);
    return parseWitnessStack(f.value);
  });
  const raw = serializeWitnessTx(tx, witnesses);
  const stripped = serializeUnsignedTx(tx);
  const weight = 3 * stripped.length + raw.length;
  return { hex: bytesToHex(raw), txid: txidOfUnsigned(stripped), vsize: Math.ceil(weight / 4) };
}

/** Parse a finalized (witness) tx back — used by tests + the Extract panel. */
export function parseFinalTx(hex) {
  const bytes = hexToBytes(hex);
  const r = new Reader(bytes);
  const version = r.u32();
  const marker = r.u8(), flag = r.u8();
  if (marker !== 0x00 || flag !== 0x01) throw new Error("not a witness tx");
  const nIn = r.varint();
  const inputs = [];
  for (let i = 0n; i < nIn; i++) {
    const txidLEb = r.bytes(32);
    const vout = r.u32();
    const sl = r.varint();
    r.bytes(Number(sl));
    const sequence = r.u32();
    inputs.push({ txid: bytesToHex(Uint8Array.from(txidLEb).reverse()), vout, sequence });
  }
  const nOut = r.varint();
  const outputs = [];
  for (let i = 0n; i < nOut; i++) {
    const value = r.u64();
    const sl = r.varint();
    const script = r.bytes(Number(sl));
    outputs.push({ value, script });
  }
  const witnesses = [];
  for (let i = 0n; i < nIn; i++) {
    const stackLen = r.varint();
    if (stackLen > 100n) throw new Error("absurd witness stack size");
    const stack = [];
    for (let j = 0n; j < stackLen; j++) {
      const l = r.varint();
      if (l > 10000n) throw new Error("absurd witness item size");
      stack.push(r.bytes(Number(l)));
    }
    witnesses.push(stack);
  }
  const locktime = r.u32();
  if (!r.eof()) throw new Error("trailing bytes in final tx");
  return { version, inputs, outputs, witnesses, locktime };
}

/* ================= Inspect (describe) ================= */

function describeSpk(script) {
  if (script.length === 34 && script[0] === 0x51 && script[1] === 0x20) {
    const prog = script.slice(2);
    return { kind: "p2tr", keyHex: bytesToHex(prog), address: xonlyToAddress(prog) };
  }
  if (script.length >= 1 && script[0] === 0x6a) {
    let dataHex = "";
    try {
      const pushes = scriptPushes(script.slice(1));
      dataHex = pushes.map(bytesToHex).join("");
    } catch { /* fall through */ }
    return { kind: "op_return", dataHex };
  }
  return { kind: "other", asm: (() => { try { return scriptToAsm(script); } catch { return "(undecodable)"; } })() };
}
function decodeModifiable(b) {
  if (b.length !== 1) return { raw: bytesToHex(b), note: "must be 1 byte" };
  const v = b[0];
  const flags = [];
  if (v & 0x01) flags.push("inputs modifiable");
  if (v & 0x02) flags.push("outputs modifiable");
  if (v & 0x04) flags.push("sighash_single");
  return { raw: "0x" + v.toString(16).padStart(2, "0"), flags: flags.length ? flags : ["nothing modifiable"] };
}

export function describePsbt(psbt) {
  const tx = psbt.unsignedTx;
  const issues = [];
  const g = {};
  for (const p of psbt.globalPairs) {
    const k = bytesToHex(p.key);
    if (g[k]) issues.push(`global: duplicate key 0x${k} (rejected at parse — unreachable)`);
    g[k] = p.value;
  }
  const KNOWN_GLOBAL = new Set(["00", "fb", "fc", "fd", "fe", "ff"]);
  const proprietary = psbt.globalPairs.filter((p) => {
    const k = bytesToHex(p.key);
    if (KNOWN_GLOBAL.has(k)) return false;
    if (p.key.length === 79 && p.key[0] === 0x01) return false; // xpub
    return true;
  }).map((p) => "0x" + bytesToHex(p.key));
  const global = {
    txVersion: tx.version,
    locktime: tx.locktime,
    nInputs: tx.inputs.length,
    nOutputs: tx.outputs.length,
    unsignedTxid: txidOfUnsigned(psbt.unsignedTxBytes),
    modifiable: g["ff"] ? decodeModifiable(g["ff"]) : null,
    txVersionProp: g["fb"] ? new Reader(g["fb"]).u32() : null,
    fallbackLocktime: g["fc"] ? new Reader(g["fc"]).u32() : null,
    xpubs: psbt.globalPairs.filter((p) => p.key.length === 79 && p.key[0] === 0x01).length,
    proprietary,
  };
  const inputs = psbt.inputs.map((pairs, i) => {
    const u = tx.inputs[i];
    const w = findKey(pairs, IN_WITNESS_UTXO);
    const nw = findKey(pairs, IN_NON_WITNESS_UTXO);
    let witnessUtxo = null;
    if (w) {
      try {
        const r = new Reader(w.value);
        const amount = r.u64();
        const sl = r.varint();
        const spk = r.bytes(Number(sl));
        witnessUtxo = { amount, spkHex: bytesToHex(spk), desc: describeSpk(spk) };
      } catch (e) { issues.push(`input ${i}: bad WITNESS_UTXO (${e.message})`); }
    }
    const shE = findKey(pairs, IN_SIGHASH_TYPE);
    let sighash = "not declared (signer may choose; DEFAULT assumed)";
    if (shE) {
      try {
        const v = new Reader(shE.value).u32();
        sighash = `0x${v.toString(16).padStart(8, "0")} = SIGHASH_${sighashName(v & 0xff)}${v > 0xff ? " (upper bytes set — nonstandard)" : ""}`;
      } catch (e) { sighash = `unparseable (${e.message})`; issues.push(`input ${i}: bad SIGHASH_TYPE`); }
    }
    const internalE = findKey(pairs, IN_TAP_INTERNAL_KEY);
    const internalKeyHex = internalE ? bytesToHex(internalE.value) : null;
    if (internalE && internalE.value.length !== 32) issues.push(`input ${i}: internal key not 32 bytes`);
    const merkleE = findKey(pairs, IN_TAP_MERKLE_ROOT);
    const merkleRootHex = merkleE ? bytesToHex(merkleE.value) : null;
    const leaves = findKeyPrefix(pairs, IN_TAP_LEAF_SCRIPT, 34).map((p) => {
      const cb = p.key.slice(1);
      const leafVersion = cb[0] & 0xfe, parity = cb[0] & 0x01;
      const cbInternal = bytesToHex(cb.slice(1));
      const script = p.value;
      let leafHashHex = null, asm = null;
      try { leafHashHex = bytesToHex(tapLeafHash(script)); asm = scriptToAsm(script); }
      catch (e) { issues.push(`input ${i}: bad leaf script (${e.message})`); }
      return {
        leafVersion: "0x" + leafVersion.toString(16).padStart(2, "0"),
        parity, cbInternal,
        cbMatchesInternalKey: internalKeyHex ? cbInternal === internalKeyHex : null,
        leafHashHex, asm,
        matchesMerkleRoot: merkleRootHex ? leafHashHex === merkleRootHex : null,
        pathBytes: cb.length - 33,
      };
    });
    const keySigE = findKey(pairs, IN_TAP_KEY_SIG);
    const keySig = keySigE ? {
      len: keySigE.value.length,
      sighash: (() => { try { return sighashName(keySigE.value.length === 64 ? 0 : keySigE.value[64]); } catch { return "UNKNOWN"; } })(),
      hex: bytesToHex(keySigE.value),
    } : null;
    const scriptSigs = findKeyPrefix(pairs, IN_TAP_SCRIPT_SIG, 65).map((p) => ({
      pubkeyHex: bytesToHex(p.key.slice(1, 33)),
      leafHashHex: bytesToHex(p.key.slice(33, 65)),
      len: p.value.length,
      sighash: (() => { try { return sighashName(p.value.length === 64 ? 0 : p.value[64]); } catch { return "UNKNOWN"; } })(),
      hex: bytesToHex(p.value),
      leafKnown: leaves.some((l) => l.leafHashHex === bytesToHex(p.key.slice(33, 65))),
    }));
    const derivations = findKeyPrefix(pairs, IN_TAP_BIP32_DERIVATION, 33).map((p) => {
      try {
        const r = new Reader(p.value);
        const nH = r.varint();
        const hashes = [];
        for (let j = 0n; j < nH; j++) hashes.push(bytesToHex(r.bytes(32)));
        const fp = bytesToHex(r.bytes(4));
        const nP = r.varint();
        const path = [];
        for (let j = 0n; j < nP; j++) path.push(r.u32());
        return { xonlyHex: bytesToHex(p.key.slice(1)), leafHashes: hashes, masterFp: fp, path };
      } catch (e) { return { xonlyHex: bytesToHex(p.key.slice(1)), error: e.message }; }
    });
    const finalized = !!findKey(pairs, IN_FINAL_SCRIPTWITNESS);
    return {
      index: i, prevout: `${u.txid}:${u.vout}`, sequence: "0x" + u.sequence.toString(16).padStart(8, "0"),
      hasWitnessUtxo: !!w, hasNonWitnessUtxo: !!nw, witnessUtxo,
      sighash, internalKeyHex, merkleRootHex, leaves,
      keySig, scriptSigs, derivations, finalized,
    };
  });
  const outputs = psbt.outputs.map((pairs, i) => {
    const aE = findKey(pairs, OUT_AMOUNT);
    const sE = findKey(pairs, OUT_SCRIPT);
    const amount = aE ? new Reader(aE.value).u64() : null;
    const script = sE ? sE.value : null;
    const txo = tx.outputs[i];
    const match = script ? eq(script, txo.script) : null;
    if (match === false) issues.push(`output ${i}: PSBT_OUT_SCRIPT differs from unsigned tx output script`);
    return {
      index: i, amount, amountPrl: amount !== null ? grainsToPrl(amount) : null,
      scriptHex: script ? bytesToHex(script) : null,
      desc: script ? describeSpk(script) : null,
      matchesUnsignedTx: match,
    };
  });
  return { global, inputs, outputs, issues };
}

/* ================= deterministic example fixture =================
 * Two inputs (keypath + scriptpath/CLTV), two outputs (P2TR + OP_RETURN).
 * Keys are sha256("psbt-example-…") — TEST KEYS, never for real funds.
 */

function examplePriv(tag) { return sha256(utf8("psbt-example-" + tag)); }

export function examplePrivkeys() {
  return {
    keypath: bytesToHex(examplePriv("keypath-internal")),
    scriptpath: bytesToHex(examplePriv("scriptpath-internal")),
    note: "TEST KEYS for the demo PSBT only — never use for real funds",
  };
}

export function exampleSpec() {
  const k1 = examplePriv("keypath-internal");
  const k2 = examplePriv("scriptpath-internal");
  const destProg = sha256(utf8("psbt-example-dest"));
  const leafAsm = `500000 OP_CHECKLOCKTIMEVERIFY OP_DROP <${bytesToHex(schnorr.getPublicKey(k2))}> OP_CHECKSIG`;
  return {
    inputs: [
      {
        txid: bytesToHex(sha256(utf8("psbt-example-prevout-1"))),
        vout: 0,
        amount: 250000000n,
        mode: "keypath",
        internalKey: bytesToHex(schnorr.getPublicKey(k1)),
      },
      {
        txid: bytesToHex(sha256(utf8("psbt-example-prevout-2"))),
        vout: 1,
        amount: 100000000n,
        mode: "scriptpath",
        internalKey: bytesToHex(schnorr.getPublicKey(k2)),
        script: leafAsm,
      },
    ],
    outputs: [
      { address: xonlyToAddress(destProg), amount: 300000000n },
      { opReturn: bytesToHex(utf8("pearl-psbt")), amount: 0n },
    ],
    locktime: 0,
  };
}

/** Build the demo PSBT (unsigned). Returns { base64, fee, … } like createPsbt. */
export function buildExamplePsbt() {
  return createPsbt(exampleSpec());
}

/* re-export the sign core's network + grain constants for the UI */
export { NETWORKS, GRAIN_PER_PRL, schnorr, bytesToHex, hexToBytes, sha256, tapLeafHash };
