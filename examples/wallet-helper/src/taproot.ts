/**
 * BIP-86 Taproot address derivation for Pearl.
 *
 * Pearl's Oyster wallet derives P2TR (pay-to-taproot) addresses exactly per
 * BIP-86 (verified in upstream `wallet/waddrmgr`):
 *   path:        m/86'/coin'/account'/change/index
 *   coin:        808276 on mainnet, 1 on testnets
 *                (node/chaincfg/params.go: HDCoinTypePearl / HDCoinTypeTestnet;
 *                wallet/waddrmgr/scoped_manager.go: InitKeyScopes)
 *   tweak:       Q = P + int(HashTapTweak(bytes(P))) * G   (BIP-341 key-only,
 *                matches upstream txscript.ComputeTaprootKeyNoScript, which
 *                re-parses the internal key x-only via lift_x)
 *   address:     bech32m, witness version 1, 32-byte program
 *                (upstream node/btcutil/address.go NewAddressTaproot /
 *                decodeSegWitAddress — v0 rejected)
 */

import { createHash } from 'node:crypto';
import { Point } from '@noble/secp256k1';
import { mnemonicToSeedSync, validateMnemonic } from 'bip39';
import {
  derivePath,
  masterKeyFromSeed,
  privToCompressedPub,
  serializeXprv,
  serializeXpub,
  CURVE_N,
} from './bip32.js';
import { encodeSegwitAddress, validatePearlAddress } from './bech32.js';
import { getNetwork, type NetworkName, type PearlNetwork } from './networks.js';

function taggedHash(tag: string, ...parts: Uint8Array[]): Uint8Array {
  const tagHash = createHash('sha256').update(tag, 'utf8').digest();
  const h = createHash('sha256');
  h.update(tagHash);
  h.update(tagHash);
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
}

function xOnly(pubCompressed: Uint8Array): Uint8Array {
  return pubCompressed.subarray(1, 33);
}

const FIELD_P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;

/**
 * lift_x per BIP-340: given a 32-byte x-only encoding, return the curve point
 * with even y. Throws if x >= p or x is not a valid x-coordinate.
 */
function liftX(xBytes: Uint8Array): Point {
  if (xBytes.length !== 32) throw new Error('lift_x requires 32 bytes');
  const x = BigInt('0x' + Buffer.from(xBytes).toString('hex'));
  if (x >= FIELD_P) throw new Error('lift_x: x >= field prime');
  const ySq = (x * x * x + 7n) % FIELD_P;
  // p ≡ 3 (mod 4), so sqrt(y²) = y²^((p+1)/4).
  let y = modPow(ySq, (FIELD_P + 1n) / 4n, FIELD_P);
  if ((y * y) % FIELD_P !== ySq) throw new Error('lift_x: not a quadratic residue');
  if (y % 2n !== 0n) y = FIELD_P - y;
  return new Point(x, y, 1n);
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

/**
 * BIP-86 output key: given the 32-byte x-only internal key, compute the
 * tweaked 32-byte x-only output key (key-path spend, no script).
 */
export function taprootOutputKey(internalXOnly: Uint8Array): Uint8Array {
  if (internalXOnly.length !== 32) throw new Error('internal key must be 32 bytes');
  const P = liftX(internalXOnly);
  const t = BigInt('0x' + Buffer.from(taggedHash('TapTweak', internalXOnly)).toString('hex')) % CURVE_N;
  // Q = P + t*G (t = 0 is cryptographically impossible; guard anyway since
  // noble's multiply requires 1 <= scalar).
  const Q = t === 0n ? P : P.add(Point.BASE.multiply(t));
  const affine = Q.toAffine();
  const xHex = affine.x.toString(16).padStart(64, '0');
  return Uint8Array.from(Buffer.from(xHex, 'hex'));
}

/** Internal (untweaked) x-only key for a derived private scalar. */
export function internalKeyFromPriv(priv: bigint): Uint8Array {
  // lift_x: re-parse x-only so y is even, exactly like upstream
  // schnorr.ParsePubKey(schnorr.SerializePubKey(pubKey)).
  const x = xOnly(privToCompressedPub(priv));
  return Uint8Array.from(liftX(x).toBytes(true).subarray(1, 33));
}

export interface DerivedAddress {
  /** bech32m Pearl address, e.g. prl1p… */
  address: string;
  /** full derivation path used */
  path: string;
  /** 32-byte x-only internal key (hex) */
  internalKey: string;
  /** 32-byte x-only tweaked output key (hex) */
  outputKey: string;
  network: PearlNetwork;
}

export interface DeriveOptions {
  network: NetworkName | PearlNetwork;
  /** BIP-86 account level, default 0 */
  account?: number;
  /** 0 = external/receiving, 1 = internal/change. Default 0 */
  change?: 0 | 1;
  /** address index. Default 0 */
  index?: number;
}

/**
 * Derive a Pearl BIP-86 P2TR address from a BIP-39 mnemonic.
 * Path: m/86'/coin'/account'/change/index  (coin per network).
 */
export function deriveAddressFromMnemonic(mnemonic: string, opts: DeriveOptions): DerivedAddress {
  if (!validateMnemonic(mnemonic.trim().replace(/\s+/g, ' '))) {
    throw new Error('invalid BIP-39 mnemonic');
  }
  const seed = mnemonicToSeedSync(mnemonic.trim().replace(/\s+/g, ' '));
  try {
    return deriveAddressFromSeed(seed, opts);
  } finally {
    seed.fill(0);
  }
}

/** Derive a Pearl BIP-86 P2TR address from a raw seed (Uint8Array). */
export function deriveAddressFromSeed(seed: Uint8Array, opts: DeriveOptions): DerivedAddress {
  const network = typeof opts.network === 'string' ? getNetwork(opts.network) : opts.network;
  const account = opts.account ?? 0;
  const change = opts.change ?? 0;
  const index = opts.index ?? 0;
  if (!Number.isInteger(account) || account < 0) throw new Error('account must be a non-negative integer');
  if (change !== 0 && change !== 1) throw new Error('change must be 0 or 1');
  if (!Number.isInteger(index) || index < 0) throw new Error('index must be a non-negative integer');

  const path = `m/86'/${network.coinType}'/${account}'/${change}/${index}`;
  const master = masterKeyFromSeed(seed);
  const key = derivePath(master, path);
  const internalKey = internalKeyFromPriv(key.priv);
  const outputKey = taprootOutputKey(internalKey);
  const address = encodeSegwitAddress(network.hrp, 1, outputKey);
  // Self-check: the address we just built must pass Pearl validation.
  validatePearlAddress(address);
  return {
    address,
    path,
    internalKey: Buffer.from(internalKey).toString('hex'),
    outputKey: Buffer.from(outputKey).toString('hex'),
    network,
  };
}

/** Derive `count` consecutive addresses starting at `startIndex` (gap-limit scanning helper). */
export function deriveAddressRange(
  mnemonic: string,
  opts: DeriveOptions & { startIndex?: number; count?: number },
): DerivedAddress[] {
  const start = opts.startIndex ?? 0;
  const count = opts.count ?? 10;
  const out: DerivedAddress[] = [];
  for (let i = 0; i < count; i++) {
    out.push(deriveAddressFromMnemonic(mnemonic, { ...opts, index: start + i }));
  }
  return out;
}

/** Account-level extended keys (xprv/xpub) at m/86'/coin'/account' — useful for watch-only setups. */
export function accountExtendedKeys(
  mnemonic: string,
  network: NetworkName | PearlNetwork,
  account = 0,
): { xprv: string; xpub: string; path: string } {
  const net = typeof network === 'string' ? getNetwork(network) : network;
  const normalized = mnemonic.trim().replace(/\s+/g, ' ');
  if (!validateMnemonic(normalized)) throw new Error('invalid BIP-39 mnemonic');
  const seed = mnemonicToSeedSync(normalized);
  try {
    const path = `m/86'/${net.coinType}'/${account}'`;
    const master = masterKeyFromSeed(seed);
    const key = derivePath(master, path);
    const isTest = net.name !== 'mainnet';
    return {
      xprv: serializeXprv(key, isTest),
      xpub: serializeXpub(key, isTest),
      path,
    };
  } finally {
    seed.fill(0);
  }
}
