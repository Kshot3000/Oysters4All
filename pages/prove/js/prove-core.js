/*
 * Pearl Prove — pure verification core (no DOM, no network).
 *
 * Shared between the browser UI and the node test suite.
 * Works in both: uses only Uint8Array / Math.
 *
 * Cryptographic facts (verified, not assumed):
 *  - Pearl's tx merkle tree is Bitcoin-style: every interior node is
 *    double-SHA256(left || right), an odd lone node is duplicated
 *    (hashed with itself). Source: node/blockchain/merkle.go
 *    (HashMerkleBranches + BuildMerkleTreeStore, upstream master @ 3fe2267).
 *  - Empirically confirmed: recomputing the root from the 40 txids of
 *    mainnet block 120195 reproduces blockbook's merkleRoot byte-for-byte
 *    (tests/fixture-120195.json).
 *  - Txids are shown in display order (big-endian hex); hashing uses the
 *    internal little-endian byte order — same convention as Bitcoin.
 *  - Block header: 80 bytes, Bitcoin layout (version u32 LE, prev hash,
 *    merkle root, time u32 LE, bits u32 LE, nonce u32 LE). Header id =
 *    double-SHA256 of the 80 bytes, shown in display order.
 */
"use strict";

/* ------------------------------------------------------------------ */
/* SHA-256 (pure JS, FIPS 180-4). Cross-checked against node:crypto in */
/* the test suite so any implementation slip fails loudly.            */
/* ------------------------------------------------------------------ */

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }

/** sha256(bytes: Uint8Array) -> Uint8Array(32) */
function sha256(msg) {
  const ml = msg.length;
  const bitLenHi = Math.floor((ml / 0x20000000) >>> 0);
  const bitLenLo = (ml << 3) >>> 0;
  const paddedLen = (((ml + 8) >> 6) + 1) << 6;
  const m = new Uint8Array(paddedLen);
  m.set(msg);
  m[ml] = 0x80;
  const dv = new DataView(m.buffer);
  dv.setUint32(paddedLen - 8, bitLenHi);
  dv.setUint32(paddedLen - 4, bitLenLo);

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Uint32Array(64);

  for (let off = 0; off < paddedLen; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K256[i] + w[i]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }
  const out = new Uint8Array(32);
  const od = new DataView(out.buffer);
  od.setUint32(0, h0); od.setUint32(4, h1); od.setUint32(8, h2); od.setUint32(12, h3);
  od.setUint32(16, h4); od.setUint32(20, h5); od.setUint32(24, h6); od.setUint32(28, h7);
  return out;
}

/** double-SHA256, the hash Pearl uses for txids, merkle nodes, block ids. */
function dsha(bytes) { return sha256(sha256(bytes)); }

/* ------------------------------------------------------------------ */
/* Byte-order + input validation                                       */
/* ------------------------------------------------------------------ */

const HEX64 = /^[0-9a-fA-F]{64}$/;
const HEX160 = /^[0-9a-fA-F]{160}$/;

function hexToBytes(hex) {
  if (typeof hex !== "string" || hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error("not hex");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** txid (display order) -> internal byte order used for hashing. */
function txidToInternal(txidHex) {
  if (!HEX64.test(txidHex.trim())) throw new Error("txid must be 64 hex chars");
  const b = hexToBytes(txidHex.trim());
  return b.reverse();
}

/** internal bytes -> txid display hex. */
function internalToTxid(bytes) { return bytesToHex(bytes.slice().reverse()); }

/* ------------------------------------------------------------------ */
/* Merkle tree (Pearl/Bitcoin construction)                             */
/* ------------------------------------------------------------------ */

/**
 * Compute the merkle root over txids given in display order.
 * Returns the root in display order. Throws on empty / invalid input.
 */
function merkleRoot(txids) {
  if (!Array.isArray(txids) || txids.length === 0) {
    throw new Error("need at least one txid");
  }
  let level = txids.map(txidToInternal);
  while (level.length > 1) {
    if (level.length % 2 === 1) level.push(level[level.length - 1]);
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const cat = new Uint8Array(64);
      cat.set(level[i], 0);
      cat.set(level[i + 1], 32);
      next.push(dsha(cat));
    }
    level = next;
  }
  return internalToTxid(level[0]);
}

/**
 * Build an inclusion proof for the txid at `index` in `txids` (display order).
 * Returns [{ sibling: <display hex>, position: "left"|"right" }...] from the
 * leaf level up to (but excluding) the root.
 */
function merkleProof(txids, index) {
  if (!Array.isArray(txids) || txids.length === 0) throw new Error("need at least one txid");
  if (!Number.isInteger(index) || index < 0 || index >= txids.length) {
    throw new Error("index out of range");
  }
  let level = txids.map(txidToInternal);
  let idx = index;
  const proof = [];
  while (level.length > 1) {
    if (level.length % 2 === 1) level.push(level[level.length - 1]);
    const isRight = idx % 2 === 1;
    const sibIdx = isRight ? idx - 1 : idx + 1;
    proof.push({
      sibling: internalToTxid(level[sibIdx]),
      position: isRight ? "left" : "right",
    });
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const cat = new Uint8Array(64);
      cat.set(level[i], 0);
      cat.set(level[i + 1], 32);
      next.push(dsha(cat));
    }
    level = next;
    idx = Math.floor(idx / 2);
  }
  return proof;
}

/**
 * Verify an inclusion proof. `proof` is [{ sibling: <display hex>,
 * position: "left"|"right" }...] leaf-up. Returns true iff hashing the txid
 * with the path reproduces `rootHex` (display order).
 */
function verifyProof(txidHex, proof, rootHex) {
  if (!HEX64.test(txidHex.trim())) throw new Error("txid must be 64 hex chars");
  if (!HEX64.test(rootHex.trim())) throw new Error("root must be 64 hex chars");
  if (!Array.isArray(proof) || proof.length === 0) throw new Error("proof must be non-empty");
  let cur = txidToInternal(txidHex.trim());
  for (const step of proof) {
    if (!step || (step.position !== "left" && step.position !== "right")) {
      throw new Error("proof step needs position left|right");
    }
    const sib = txidToInternal(step.sibling);
    const cat = new Uint8Array(64);
    if (step.position === "left") { cat.set(sib, 0); cat.set(cur, 32); }
    else { cat.set(cur, 0); cat.set(sib, 32); }
    cur = dsha(cat);
  }
  return internalToTxid(cur) === rootHex.trim().toLowerCase();
}

/**
 * Parse pasted proof lines like "L <64hex>" / "R <64hex>" (case-insensitive),
 * ignoring blank lines and lines starting with #.
 */
function parseProofLines(text) {
  const proof = [];
  for (const raw of String(text).split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([lLrR])\s+([0-9a-fA-F]{64})$/);
    if (!m) throw new Error(`bad proof line: "${raw.trim()}" (want "L <64hex>" or "R <64hex>")`);
    proof.push({ sibling: m[2].toLowerCase(), position: m[1].toLowerCase() === "l" ? "left" : "right" });
  }
  if (proof.length === 0) throw new Error("no proof lines found");
  return proof;
}

/** Split pasted txid lists (whitespace / comma separated), validating each. */
function parseTxidList(text) {
  const ids = String(text).split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) throw new Error("no txids found");
  for (const id of ids) {
    if (!HEX64.test(id)) throw new Error(`not a 64-hex txid: "${id.slice(0, 20)}…"`);
  }
  return ids;
}

/* ------------------------------------------------------------------ */
/* Block header (80 bytes, Bitcoin layout)                             */
/* ------------------------------------------------------------------ */

/** Decode a compact nBits value to a 32-byte big-endian target. */
function targetFromBits(bits) {
  const b = bits >>> 0;
  const exp = b >>> 24;
  const mant = b & 0x007fffff;
  const neg = (b & 0x00800000) !== 0;
  if (exp < 3 || exp > 32 || neg || mant === 0) {
    throw new Error("invalid nBits");
  }
  const target = new Uint8Array(32);
  // value = mant * 256^(exp-3); place mantissa at the right offset (big-endian).
  const shift = exp - 3;
  if (shift + 3 > 32) throw new Error("nBits target overflows 256 bits");
  target[32 - shift - 3] = (mant >>> 16) & 0xff;
  target[32 - shift - 2] = (mant >>> 8) & 0xff;
  target[32 - shift - 1] = mant & 0xff;
  return target;
}

/** Compare two 32-byte big-endian numbers: -1 / 0 / 1. */
function cmp256(a, b) {
  for (let i = 0; i < 32; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Decode an 80-byte (160 hex char) block header.
 * Returns { version, prevHash, merkleRoot, time, bits, nonce, hash, targetHex,
 * meetsTarget } — hashes in display order.
 */
function decodeHeader(hex) {
  if (!HEX160.test(String(hex).trim())) throw new Error("header must be 160 hex chars (80 bytes)");
  const raw = hexToBytes(String(hex).trim());
  const dv = new DataView(raw.buffer);
  const version = dv.getUint32(0, true);
  const prevHash = internalToTxid(raw.slice(4, 36));
  const merkleRootHex = internalToTxid(raw.slice(36, 68));
  const time = dv.getUint32(68, true);
  const bits = dv.getUint32(72, true);
  const nonce = dv.getUint32(76, true);
  const hash = internalToTxid(dsha(raw));
  const target = targetFromBits(bits);
  return {
    version,
    prevHash,
    merkleRoot: merkleRootHex,
    time,
    timeISO: new Date(time * 1000).toISOString(),
    bits: bits.toString(16).padStart(8, "0"),
    nonce,
    hash,
    targetHex: bytesToHex(target),
    meetsTarget: cmp256(hexToBytes(hash).reverse(), target) <= 0,
  };
}

/* ------------------------------------------------------------------ */
/* Exports (node) + browser global                                     */
/* ------------------------------------------------------------------ */

const PearlProve = {
  sha256, dsha, hexToBytes, bytesToHex,
  txidToInternal, internalToTxid,
  merkleRoot, merkleProof, verifyProof, parseProofLines, parseTxidList,
  targetFromBits, cmp256, decodeHeader,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = PearlProve;
} else if (typeof window !== "undefined") {
  window.PearlProve = PearlProve;
}
