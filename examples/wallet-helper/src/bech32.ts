/**
 * Pure-TypeScript bech32 / bech32m codec plus Pearl address validation.
 *
 * Pearl addresses are bech32m (BIP-350) segwit, witness version 1+ only —
 * witness v0 is rejected. Verified against upstream
 * `node/btcutil/address.go` `decodeSegWitAddress`:
 *   - version 0 and >16 rejected
 *   - non-bech32m checksums rejected ("invalid checksum: expected bech32m
 *     encoding")
 *   - witness program must be 2..40 bytes
 * The bech32m checksum constant is 0x2bc830a3 (BIP-350).
 */

import { getNetwork, type PearlNetwork } from './networks.js';

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32_CONST = 1;
const BECH32M_CONST = 0x2bc830a3;

export type Bech32Variant = 'bech32' | 'bech32m';

function polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((b >>> i) & 1) chk ^= GEN[i];
    }
  }
  return chk >>> 0;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >>> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

function verifyChecksum(hrp: string, data: number[]): Bech32Variant | null {
  const pm = polymod([...hrpExpand(hrp), ...data]);
  if (pm === BECH32_CONST) return 'bech32';
  if ((pm >>> 0) === BECH32M_CONST) return 'bech32m';
  return null;
}

function createChecksum(hrp: string, data: number[], variant: Bech32Variant): number[] {
  const pm = polymod([...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ (variant === 'bech32m' ? BECH32M_CONST : BECH32_CONST);
  const out: number[] = [];
  for (let i = 0; i < 6; i++) out.push((pm >>> (5 * (5 - i))) & 31);
  return out;
}

/** Convert between bit groups (BIP-173 convertbits). */
export function convertBits(data: Uint8Array, from: number, to: number, pad: boolean): Uint8Array | null {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    if (value < 0 || value >> from !== 0) return null;
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >>> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv) !== 0) {
    return null;
  }
  return Uint8Array.from(out);
}

/** Encode a segwit address: hrp + version + witness program. */
export function encodeSegwitAddress(hrp: string, version: number, program: Uint8Array): string {
  if (version < 0 || version > 16) throw new Error(`invalid witness version ${version}`);
  const data5 = convertBits(program, 8, 5, true);
  if (!data5) throw new Error('convertBits failed');
  const data = [version, ...data5];
  const checksum = createChecksum(hrp.toLowerCase(), data, 'bech32m');
  return hrp.toLowerCase() + '1' + [...data, ...checksum].map((d) => CHARSET[d]).join('');
}

export interface DecodedSegwitAddress {
  hrp: string;
  variant: Bech32Variant;
  version: number;
  program: Uint8Array;
}

/** Decode a segwit address without enforcing Pearl policy (HRP/version). */
export function decodeSegwitAddress(address: string): DecodedSegwitAddress {
  const addr = address.toLowerCase();
  if (address !== address.toLowerCase() && address !== address.toUpperCase()) {
    throw new Error('mixed-case address');
  }
  const pos = addr.lastIndexOf('1');
  if (pos < 1 || pos + 7 > addr.length || addr.length > 90) {
    throw new Error('invalid bech32 string');
  }
  const hrp = addr.slice(0, pos);
  const data: number[] = [];
  for (const c of addr.slice(pos + 1)) {
    const d = CHARSET.indexOf(c);
    if (d === -1) throw new Error(`invalid bech32 character "${c}"`);
    data.push(d);
  }
  const variant = verifyChecksum(hrp, data);
  if (!variant) throw new Error('invalid checksum');
  const payload = data.slice(0, -6);
  if (payload.length < 1) throw new Error('no witness version');
  const version = payload[0];
  const program = convertBits(Uint8Array.from(payload.slice(1)), 5, 8, false);
  if (!program) throw new Error('invalid witness program padding');
  return { hrp, variant, version, program };
}

export interface PearlAddressInfo extends DecodedSegwitAddress {
  network: PearlNetwork;
  /** true when this is a standard Pearl P2TR address (v1, 32-byte program) */
  isP2TR: boolean;
}

/**
 * Validate a Pearl address exactly the way upstream `decodeSegWitAddress`
 * does (node/btcutil/address.go): bech32m, witness version 1..16, program
 * 2..40 bytes — plus the Pearl HRP check (prl/tprl/rprl).
 * Throws on any violation; returns decoded info otherwise.
 */
export function validatePearlAddress(address: string): PearlAddressInfo {
  const decoded = decodeSegwitAddress(address);
  if (decoded.variant !== 'bech32m') {
    throw new Error(`invalid checksum: expected bech32m encoding for witness version ${decoded.version}`);
  }
  if (decoded.version === 0 || decoded.version > 16) {
    throw new Error(`unsupported witness version: ${decoded.version} (Pearl only supports witness versions 1+)`);
  }
  if (decoded.program.length < 2 || decoded.program.length > 40) {
    throw new Error(`invalid witness program length: ${decoded.program.length} (expected 2..40 bytes)`);
  }
  const network = getNetwork(decoded.hrp); // throws on unknown HRP
  return {
    ...decoded,
    network,
    isP2TR: decoded.version === 1 && decoded.program.length === 32,
  };
}

/** true if `address` is a valid Pearl address for the given network (or any Pearl network). */
export function isValidPearlAddress(address: string, network?: string | PearlNetwork): boolean {
  try {
    const info = validatePearlAddress(address);
    if (network) {
      const want = typeof network === 'string' ? getNetwork(network) : network;
      return info.network.name === want.name;
    }
    return true;
  } catch {
    return false;
  }
}
