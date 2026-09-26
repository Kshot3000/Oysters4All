/**
 * Minimal BIP-32 HD key derivation (secp256k1) used for Pearl BIP-86 paths.
 *
 * Implements exactly what is needed: master key from seed, hardened and
 * non-hardened child derivation, and xprv/xpub serialization with the
 * standard version bytes. Hashing via node:crypto, EC math via
 * @noble/secp256k1.
 */

import { createHash, createHmac } from 'node:crypto';
import { Point } from '@noble/secp256k1';

const CURVE_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const HARDENED = 0x80000000;

const VERSION_XPRV_MAIN = 0x0488ade4;
const VERSION_XPUB_MAIN = 0x0488b21e;
const VERSION_XPRV_TEST = 0x04358394;
const VERSION_XPUB_TEST = 0x043587cf;

function hmac512(key: Uint8Array, data: Uint8Array): Uint8Array {
  return new Uint8Array(createHmac('sha512', key).update(data).digest());
}

function sha256d(data: Uint8Array): Uint8Array {
  const h1 = createHash('sha256').update(data).digest();
  return new Uint8Array(createHash('sha256').update(h1).digest());
}

function hash160(data: Uint8Array): Uint8Array {
  const sha = createHash('sha256').update(data).digest();
  return new Uint8Array(createHash('ripemd160').update(sha).digest());
}

function bigToBytes32(n: bigint): Uint8Array {
  return Uint8Array.from(Buffer.from(n.toString(16).padStart(64, '0'), 'hex'));
}

function bytesToBig(bytes: Uint8Array): bigint {
  return BigInt('0x' + Buffer.from(bytes).toString('hex'));
}

function ser32(i: number): Uint8Array {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(i >>> 0, 0);
  return new Uint8Array(b);
}

/** Compressed SEC encoding of the public key for private scalar `k`. */
export function privToCompressedPub(k: bigint): Uint8Array {
  return Point.BASE.multiply(k).toBytes(true);
}

export interface ExtendedKey {
  /** private key scalar */
  priv: bigint;
  chainCode: Uint8Array;
  depth: number;
  /** 4-byte parent fingerprint */
  parentFingerprint: Uint8Array;
  childNumber: number;
}

/** BIP-32 master key from a seed (e.g. a BIP-39 64-byte seed). */
export function masterKeyFromSeed(seed: Uint8Array): ExtendedKey {
  const I = hmac512(Buffer.from('Bitcoin seed', 'utf8'), seed);
  const il = bytesToBig(I.subarray(0, 32));
  if (il === 0n || il >= CURVE_N) throw new Error('invalid master key (unlucky seed)');
  return {
    priv: il,
    chainCode: I.subarray(32, 64),
    depth: 0,
    parentFingerprint: new Uint8Array(4),
    childNumber: 0,
  };
}

/** Derive child `index` (add HARDENED for hardened derivation). */
export function deriveChild(parent: ExtendedKey, index: number): ExtendedKey {
  let data: Uint8Array;
  if (index >= HARDENED) {
    data = new Uint8Array(37);
    data.set(bigToBytes32(parent.priv), 1);
    data.set(ser32(index), 33);
  } else {
    const pub = privToCompressedPub(parent.priv);
    data = new Uint8Array(37);
    data.set(pub, 0);
    data.set(ser32(index), 33);
  }
  const I = hmac512(parent.chainCode, data);
  const il = bytesToBig(I.subarray(0, 32));
  if (il >= CURVE_N) throw new Error('invalid child derivation (IL >= n)');
  const childPriv = (il + parent.priv) % CURVE_N;
  if (childPriv === 0n) throw new Error('invalid child derivation (key is zero)');
  return {
    priv: childPriv,
    chainCode: I.subarray(32, 64),
    depth: parent.depth + 1,
    parentFingerprint: hash160(privToCompressedPub(parent.priv)).subarray(0, 4),
    childNumber: index,
  };
}

/** Parse "m/86'/808276'/0'/0/0" (also accepts "h"/"H" suffixes and "M/"). */
export function parsePath(path: string): number[] {
  const clean = path.trim().replace(/^[mM]\//, '');
  if (!clean) throw new Error('empty derivation path');
  return clean.split('/').map((part) => {
    const hardened = part.endsWith("'") || part.endsWith('h') || part.endsWith('H');
    const num = parseInt(hardened ? part.slice(0, -1) : part, 10);
    if (!Number.isInteger(num) || num < 0 || num >= HARDENED) {
      throw new Error(`invalid path component "${part}"`);
    }
    return hardened ? num + HARDENED : num;
  });
}

/** Derive the full path from a master key. */
export function derivePath(master: ExtendedKey, path: string | number[]): ExtendedKey {
  const indexes = typeof path === 'string' ? parsePath(path) : path;
  let key = master;
  for (const index of indexes) key = deriveChild(key, index);
  return key;
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Check(payload: Uint8Array): string {
  const check = sha256d(payload).subarray(0, 4);
  const full = Buffer.concat([Buffer.from(payload), Buffer.from(check)]);
  let n = BigInt('0x' + full.toString('hex'));
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of full) {
    if (b === 0) out = '1' + out;
    else break;
  }
  return out;
}

/** Serialize an extended private key (xprv/tprv, standard version bytes). */
export function serializeXprv(key: ExtendedKey, testnet: boolean): string {
  const buf = Buffer.alloc(78);
  buf.writeUInt32BE(testnet ? VERSION_XPRV_TEST : VERSION_XPRV_MAIN, 0);
  buf.writeUInt8(key.depth, 4);
  Buffer.from(key.parentFingerprint).copy(buf, 5);
  buf.writeUInt32BE(key.childNumber >>> 0, 9);
  Buffer.from(key.chainCode).copy(buf, 13);
  buf.writeUInt8(0, 45);
  Buffer.from(bigToBytes32(key.priv)).copy(buf, 46);
  return base58Check(new Uint8Array(buf));
}

/** Serialize an extended public key (xpub/tpub, standard version bytes). */
export function serializeXpub(key: ExtendedKey, testnet: boolean): string {
  const buf = Buffer.alloc(78);
  buf.writeUInt32BE(testnet ? VERSION_XPUB_TEST : VERSION_XPUB_MAIN, 0);
  buf.writeUInt8(key.depth, 4);
  Buffer.from(key.parentFingerprint).copy(buf, 5);
  buf.writeUInt32BE(key.childNumber >>> 0, 9);
  Buffer.from(key.chainCode).copy(buf, 13);
  Buffer.from(privToCompressedPub(key.priv)).copy(buf, 45);
  return base58Check(new Uint8Array(buf));
}

export { HARDENED, CURVE_N };
