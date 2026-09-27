/**
 * util.js — pure helpers for the Pearl mining pool.
 *
 * Target/difficulty math follows the pool conventions captured live on 2026-09-26
 * (see docs/protocol/*.md in the spark-pearl-miner checkout):
 *   HeroMiners/LuckyPool: target = floor(0xFFFF * 2^208 / diff)   (Bitcoin pdiff)
 *   Kryptex:              target = floor(2^224 / diff) - 1
 * The pool server issues pdiff targets (HeroMiners/LuckyPool convention).
 *
 * bech32m codec: same lineage as the audited PRL-20 launcher / Pearl Pay
 * (pearlpurse lineage, polymod constant 0x2bc830a3 verified against real prl1...
 * addresses). Pearl rejects witness v0 — only v1+ (bech32m) addresses are valid.
 */

export const GRAIN_PER_PRL = 100_000_000n;

/* ---------------- difficulty / target ---------------- */

/** Bitcoin pdiff share target for a difficulty: floor(0xFFFF * 2^208 / diff). */
export function targetForDiff(diff) {
  const d = BigInt(Math.max(1, Math.floor(diff)));
  return ((0xffffn << 208n) / d);
}

/** Kryptex's target convention: floor(2^224 / diff) - 1 (kept for reference). */
export function kryptexTargetForDiff(diff) {
  const d = BigInt(Math.max(1, Math.floor(diff)));
  return ((1n << 224n) / d) - 1n;
}

/** pdiff value implied by a target: floor(0xFFFF * 2^208 / target). */
export function diffForTarget(target) {
  const t = BigInt(target);
  if (t <= 0n) return 1;
  const d = (0xffffn << 208n) / t;
  return d > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(d);
}

/** Bitcoin compact "nbits" encoding of a 256-bit target. */
export function targetToCompact(target) {
  let t = BigInt(target);
  if (t <= 0n) return 0;
  let size = 0;
  let tmp = t;
  while (tmp > 0n) { size++; tmp >>= 8n; }
  let compact;
  if (size <= 3) {
    compact = Number(t << BigInt(8 * (3 - size)));
  } else {
    compact = Number(t >> BigInt(8 * (size - 3)));
  }
  // If the sign bit (0x00800000) would be set, shift down and bump the size.
  if (compact & 0x00800000) {
    compact >>= 8;
    size++;
  }
  return (size << 24) | (compact & 0x007fffff);
}

/** Decode Bitcoin compact nbits to a 256-bit target. */
export function compactToTarget(nbits) {
  const size = nbits >>> 24;
  const word = BigInt(nbits & 0x007fffff);
  if (size <= 3) return word >> BigInt(8 * (3 - size));
  return word << BigInt(8 * (size - 3));
}

export function targetToHexBE(target) {
  return BigInt(target).toString(16).padStart(64, "0");
}

export function targetFromHexBE(hex) {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]{1,64}$/.test(h)) throw new Error("targetFromHexBE: bad hex");
  return BigInt("0x" + h);
}

export function formatPRL(grains) {
  const g = BigInt(grains);
  const neg = g < 0n;
  const a = neg ? -g : g;
  const whole = a / GRAIN_PER_PRL;
  const frac = (a % GRAIN_PER_PRL).toString().padStart(8, "0").replace(/0+$/, "") || "0";
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

export function parsePRL(str) {
  const m = /^(\d+)(?:\.(\d{1,8}))?$/.exec(String(str).trim());
  if (!m) throw new Error(`parsePRL: bad amount "${str}"`);
  return BigInt(m[1]) * GRAIN_PER_PRL + BigInt((m[2] || "").padEnd(8, "0"));
}

/* ---------------- bech32m (pearlpurse lineage, verified) ---------------- */

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32M_CONST = 0x2bc830a3;

function polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= GEN[i];
  }
  return chk;
}
function hrpExpand(hrp) {
  const out = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}
function convertBits(data, fromBits, toBits, pad) {
  let acc = 0, bits = 0;
  const out = [];
  const maxv = (1 << toBits) - 1;
  for (const value of data) {
    if (value < 0 || value >> fromBits !== 0) throw new Error("convertBits: invalid value");
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) { bits -= toBits; out.push((acc >> bits) & maxv); }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (toBits - bits)) & maxv);
  } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv)) {
    throw new Error("convertBits: invalid padding");
  }
  return out;
}

/**
 * Decode a bech32m Pearl address. Returns { hrp, version, program }.
 * Throws on any malformed input. Pearl only accepts witness v1+ (bech32m);
 * v0 (bech32) addresses are rejected by consensus.
 */
export function decodePearlAddress(addr) {
  const s = String(addr);
  const lower = s.toLowerCase();
  if (s !== lower && s !== s.toUpperCase()) throw new Error("address: mixed case");
  const pos = lower.lastIndexOf("1");
  if (pos < 1 || pos + 7 > lower.length) throw new Error("address: bad separator");
  const hrp = lower.slice(0, pos);
  const data = [];
  for (const c of lower.slice(pos + 1)) {
    const i = CHARSET.indexOf(c);
    if (i < 0) throw new Error("address: bad charset char");
    data.push(i);
  }
  if (polymod([...hrpExpand(hrp), ...data]) !== BECH32M_CONST)
    throw new Error("address: bad bech32m checksum");
  const version = data[0];
  const program = new Uint8Array(convertBits(data.slice(1, -6), 5, 8, false));
  return { hrp, version, program };
}

const HRP_FOR_NETWORK = { mainnet: "prl", testnet: "tprl", regtest: "rprl" };

/** True when addr is a valid P2TR-style Pearl address for the network. */
export function isValidPearlAddress(addr, network = "mainnet") {
  try {
    const d = decodePearlAddress(addr);
    return d.hrp === HRP_FOR_NETWORK[network] && d.version >= 1 && d.version <= 16 && d.program.length === 32;
  } catch {
    return false;
  }
}

/* ---------------- misc ---------------- */

export function nowSec() { return Math.floor(Date.now() / 1000); }

export function randHex(bytes) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Split "wallet.worker" login into { wallet, worker }. Also handles solo: prefix. */
export function splitLogin(login) {
  let s = String(login || "").trim();
  let solo = false;
  if (s.toLowerCase().startsWith("solo:")) { solo = true; s = s.slice(5); }
  const i = s.indexOf(".");
  if (i < 0) return { wallet: s, worker: "", solo };
  return { wallet: s.slice(0, i), worker: s.slice(i + 1), solo };
}
