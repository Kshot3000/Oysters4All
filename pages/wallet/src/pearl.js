// Pearl wallet core — BIP86 keypath taproot.
// Verified byte-for-byte against Pearl's own Go reference (node/txscript):
//   addresses, signatures, signed tx bytes, txids.
//
// Chain params from pearl-labs/node/chaincfg/params.go MainNetParams:
//   bech32m HRP "prl", BIP44/86 coin type 808276, tx version 1.

import { HDKey } from "@scure/bip32";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToNumberBE, numberToBytesBE } from "@noble/curves/abstract/utils";

// ---------- bech32m ----------
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32M_CONST = 0x2bc830a3;

function polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >>> i) & 1) chk ^= GEN[i];
  }
  return chk;
}
function hrpExpand(hrp) {
  const a = [];
  for (const c of hrp) a.push(c.charCodeAt(0) >>> 5);
  a.push(0);
  for (const c of hrp) a.push(c.charCodeAt(0) & 31);
  return a;
}
function checksum(hrp, data) {
  const values = hrpExpand(hrp).concat(data, [0, 0, 0, 0, 0, 0]);
  const mod = polymod(values) ^ BECH32M_CONST;
  const out = [];
  for (let i = 0; i < 6; i++) out.push((mod >>> (5 * (5 - i))) & 31);
  return out;
}
export function convertBits(data, fromBits, toBits, pad, strictPadding = false) {
  let acc = 0, bits = 0;
  const ret = [];
  const maxv = (1 << toBits) - 1;
  for (const value of data) {
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      ret.push((acc >>> bits) & maxv);
    }
  }
  if (pad && bits) ret.push((acc << (toBits - bits)) & maxv);
  if (!pad && bits) {
    if (strictPadding && (acc & ((1 << bits) - 1)) !== 0) throw new Error("invalid padding");
  }
  return ret;
}
export function encodeBech32m(hrp, data8) {
  const data5 = convertBits([...data8], 8, 5, true);
  return hrp + "1" + data5.concat(checksum(hrp, data5)).map((v) => CHARSET[v]).join("");
}
export function decodeBech32m(addr) {
  if (typeof addr !== "string") throw new Error("address must be string");
  const raw = addr.trim();
  if (raw !== raw.toLowerCase() && raw !== raw.toUpperCase()) throw new Error("mixed case");
  addr = raw.toLowerCase();
  if (addr.length > 90) throw new Error("too long");
  const pos = addr.lastIndexOf("1");
  if (pos < 1 || addr.length - pos - 1 < 7) throw new Error("missing separator");
  const hrp = addr.slice(0, pos);
  if (!/^[a-z0-9]+$/.test(hrp)) throw new Error("bad hrp");
  const data5 = [];
  for (const c of addr.slice(pos + 1)) {
    const v = CHARSET.indexOf(c);
    if (v === -1) throw new Error("invalid char");
    data5.push(v);
  }
  if (polymod(hrpExpand(hrp).concat(data5)) !== BECH32M_CONST) throw new Error("bad checksum");
  const payload = data5.slice(0, -6);
  const data8 = convertBits(payload.slice(1), 5, 8, false, true);
  if (data8.length !== 32) throw new Error("program must be 32 bytes (v1 taproot)");
  if (payload[0] !== 1) throw new Error("only witness v1 (taproot) supported");
  return { hrp, version: payload[0], program: Uint8Array.from(data8) };
}

// strict variant used for user-entered recipients: locks HRP to Pearl
export function decodePearlAddress(addr) {
  const d = decodeBech32m(addr);
  if (d.hrp !== PEARL.hrp) throw new Error(`not a Pearl address (network: ${d.hrp})`);
  return d;
}

// ---------- chain params ----------
export const PEARL = {
  hrp: "prl",
  coinType: 808276,
  txVersion: 1,
  dust: 546,
  blockbook: "https://blockbook.pearlresearch.ai",
};

// ---------- hashing ----------
function taggedHash(tag, msg) {
  const enc = new TextEncoder();
  const tagHash = sha256(enc.encode(tag));
  const pre = new Uint8Array(tagHash.length * 2 + msg.length);
  pre.set(tagHash);
  pre.set(tagHash, tagHash.length);
  pre.set(msg, tagHash.length * 2);
  return sha256(pre);
}
const dblSha = (b) => sha256(sha256(b));

// ---------- keys ----------
export function hdFromSeed(seed) {
  return HDKey.fromMasterSeed(seed);
}
export function derivePriv(root, index) {
  const child = root.derive(`m/86'/${PEARL.coinType}'/0'/0/${index}`);
  return child.privateKey; // 32 bytes
}

// BIP341 tweak
export function tweakXOnlyPub(xOnlyPub) {
  const t = taggedHash("TapTweak", xOnlyPub);
  // lift_x throws if not on curve; internal keys from HD are always lift-able in practice
  const P = schnorr.utils.lift_x(bytesToNumberBE(xOnlyPub));
  const Q = P.add(schnorr.Point.BASE.multiply(bytesToNumberBE(t)));
  return { tweakedX: schnorr.utils.pointToBytes(Q), t };
}
export function tweakPriv(priv, xOnlyPub) {
  // BIP341: if internal pubkey y is odd, negate d first
  let d = bytesToNumberBE(priv);
  const P = secp256k1.ProjectivePoint.fromPrivateKey(numberToBytesBE(d, 32));
  // full compressed pub: first byte 0x03 => odd y
  const comp = P.toRawBytes(true);
  if (comp[0] === 0x03) d = secp256k1.CURVE.n - d;
  const { t } = tweakXOnlyPub(xOnlyPub);
  const n = secp256k1.CURVE.n;
  const tv = bytesToNumberBE(t);
  return numberToBytesBE((d + tv) % n, 32);
}

export function addressFromPriv(priv) {
  const xOnly = schnorr.getPublicKey(priv); // x-only internal key
  return addressFromXOnly(xOnly);
}
export function addressFromXOnly(xOnly) {
  const { tweakedX } = tweakXOnlyPub(xOnly);
  // segwit v1: data5 = [version(1) as raw 5-bit] + convertBits(program,8,5)
  const data5 = [1, ...convertBits([...tweakedX], 8, 5, true)];
  return PEARL.hrp + "1" + data5.concat(checksum(PEARL.hrp, data5)).map((v) => CHARSET[v]).join("");
}

// ---------- tx building (wire format per node/wire/msgtx.go) ----------
function varint(n) {
  if (n < 0xfd) return [n];
  if (n <= 0xffff) return [0xfd, n & 0xff, (n >> 8) & 0xff];
  if (n <= 0xffffffff) return [0xfe, ...u32le(n)];
  return [0xff, ...u64le(n)];
}
function u16le(n) { return [n & 0xff, (n >> 8) & 0xff]; }
function u32le(n) { return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]; }
function u64le(n) {
  // n up to 2^53 safe
  const lo = n % 0x100000000;
  const hi = Math.floor(n / 0x100000000);
  return [...u32le(lo), ...u32le(hi)];
}

export function p2trScript(xOnlyPub) {
  // OP_1 <32-byte key> (per txscript.PayToTaprootScript)
  return [0x51, 0x20, ...xOnlyPub];
}

// Virtual size (vbytes) of a Pearl P2TR keypath tx — for fee estimation.
// Sizes verified against the serialization in buildTx() above and upstream
// btcd-derived wire format (Pearl txVersion 1):
//   input base  = 41 B (32 txid + 4 vout + 1 script-len + 4 sequence)
//   output base = 43 B (8 value + 1 script-len + 34 P2TR script)
//   witness/input = 66 raw B (1 stack-count + 1 sig-len + 64 BIP340 sig)
//   marker+flag = 2 weight units
export function txVBytes(nIn, nOut) {
  if (!Number.isInteger(nIn) || nIn < 1) throw new Error("nIn must be a positive integer");
  if (!Number.isInteger(nOut) || nOut < 1) throw new Error("nOut must be a positive integer");
  const baseBytes = 4 + 1 + 41 * nIn + 1 + 43 * nOut + 4; // ver + counts + inputs + outputs + locktime
  const weight = 4 * baseBytes + 2 + 66 * nIn; // + marker/flag + witness data
  return Math.ceil(weight / 4);
}

// inputs: [{txid (LE-hex string as displayed), vout, value, xOnlyKey}]
// outputs: [{xOnlyPub, value}]
export function buildTx(inputs, outputs, sequence = 0xffffffff) {
  if (!Array.isArray(inputs) || inputs.length === 0) throw new Error("no inputs");
  if (!Array.isArray(outputs) || outputs.length === 0) throw new Error("no outputs");
  for (const i of inputs) if (!(Number.isInteger(i.vout) && i.vout >= 0)) throw new Error("bad vout");
  for (const o of outputs) {
    if (!(o.xOnlyPub instanceof Uint8Array) || o.xOnlyPub.length !== 32) throw new Error("bad output key");
    if (!Number.isSafeInteger(o.value) || o.value <= 0 || o.value > 2.1e15) throw new Error("bad output value");
  }
  const txidLE = (txidHex) => {
    if (!/^[0-9a-f]{64}$/.test(txidHex)) throw new Error("bad txid");
    return txidHex.match(/../g).reverse().map((h) => parseInt(h, 16));
  };

  // no-witness serialization (for txid + BIP341 base)
  const core = [
    ...u32le(PEARL.txVersion),
    ...varint(inputs.length),
  ];
  for (const inp of inputs) {
    core.push(...txidLE(inp.txid), ...u32le(inp.vout), ...varint(0), ...u32le(sequence));
  }
  core.push(...varint(outputs.length));
  for (const out of outputs) {
    const script = p2trScript(out.xOnlyPub);
    core.push(...u64le(out.value), ...varint(script.length), ...script);
  }
  core.push(...u32le(0)); // locktime

  const txid = dblSha(Uint8Array.from(core)).reverse();

  // BIP341 keypath signature per input
  const sigs = inputs.map((inp, i) => {
    const sigMsg = taprootSigMsg(inputs, outputs, sequence, i);
    const digest = taggedHash("TapSighash", sigMsg);
    const xOnly = inp.xOnlyPub ?? schnorr.getPublicKey(inp.priv);
    const tweaked = tweakPriv(inp.priv, xOnly);
    const zeroAux = new Uint8Array(32); // btcd/btcec deterministic aux
    return { sig: schnorr.sign(digest, tweaked, zeroAux), digest };
  });

  // full serialization with witness (BIP144: marker+flag after version)
  const full = [
    ...u32le(PEARL.txVersion),
    0x00, 0x01, // TxFlagMarker + WitnessFlag
    ...varint(inputs.length),
  ];
  for (const inp of inputs) {
    full.push(...txidLE(inp.txid), ...u32le(inp.vout), ...varint(0), ...u32le(sequence));
  }
  full.push(...varint(outputs.length));
  for (const out of outputs) {
    const script = p2trScript(out.xOnlyPub);
    full.push(...u64le(out.value), ...varint(script.length), ...script);
  }
  // witness stack per input
  for (const s of sigs) {
    full.push(...varint(1), ...varint(s.sig.length), ...s.sig);
  }
  full.push(...u32le(0));

  return {
    txid: [...txid].map((b) => b.toString(16).padStart(2, "0")).join(""),
    hex: full.map((b) => (b < 16 ? "0" : "") + b.toString(16)).join(""),
    sigs: sigs.map((s) => [...s.sig].map((b) => b.toString(16).padStart(2, "0")).join("")),
  };
}

// BIP341 common sig message for SigHashDefault (keypath, no annex, no ext)
function taprootSigMsg(inputs, outputs, sequence, idx) {
  const txidLE = (txidHex) => txidHex.match(/../g).reverse().map((h) => parseInt(h, 16));

  // midstate hashes
  // Pearl divergence: v1 midstates use SINGLE sha256 (per node/txscript/hashcache.go)
  const sha = (b) => sha256(b);
  const hashPrevOuts = sha(Uint8Array.from(inputs.flatMap((i) => [...txidLE(i.txid), ...u32le(i.vout)])));
  const hashAmounts = sha(Uint8Array.from(inputs.flatMap((i) => u64le(i.value))));
  const hashScripts = sha(Uint8Array.from(inputs.flatMap((i) => { const x = i.xOnlyPub ?? schnorr.getPublicKey(i.priv); const s = p2trScript(tweakXOnlyPub(x).tweakedX); return [...varint(s.length), ...s]; })));
  const hashSequence = sha(Uint8Array.from(inputs.flatMap(() => u32le(sequence))));
  const hashOutputs = sha(Uint8Array.from(outputs.flatMap((o) => { const s = p2trScript(o.xOnlyPub); return [...u64le(o.value), ...varint(s.length), ...s]; })));

  const msg = [
    0x00,       // epoch
    0x00,       // hash type = SigHashDefault
    ...u32le(PEARL.txVersion),
    ...u32le(0), // locktime
    ...hashPrevOuts,
    ...hashAmounts,
    ...hashScripts,
    ...hashSequence,
    ...hashOutputs,
    0x00,       // spend_type: keypath, no annex
    ...u32le(idx),
  ];
  return Uint8Array.from(msg);
}

export { taggedHash, dblSha, varint, u32le, u64le, u16le };
