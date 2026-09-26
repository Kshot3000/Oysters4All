/* Pearl testnet faucet — pure library functions (no I/O, no config globals).
 *
 * Extracted from server.js so every money-critical rule can be unit-tested:
 *  - Pearl bech32m (BIP-350) address validation, witness v1+ only (Taproot, P2MR)
 *  - drip rate limiting (per-address cooldown + rolling 24h daily cap)
 *
 * Source for address policy: upstream node/btcutil/address.go
 * (decodeSegWitAddress) — bech32m const 0x2bc830a3, witness v0 rejected.
 */
'use strict';

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32M_CONST = 0x2bc830a3;

function bech32Polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >>> i) & 1) chk ^= GEN[i];
  }
  return chk;
}

function bech32HrpExpand(hrp) {
  const out = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >>> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

/* Decode a bech32m segwit address. Throws on any invalid input.
 * Returns { hrp, version, program } where program is an array of bytes. */
function bech32Decode(addr) {
  if (typeof addr !== 'string') throw new Error('address must be a string');
  const s = addr.trim();
  if (s.length < 8 || s.length > 90) throw new Error('invalid length');
  if (s !== s.toLowerCase() && s !== s.toUpperCase()) throw new Error('mixed case not allowed');
  const lower = s.toLowerCase();
  const pos = lower.lastIndexOf('1');
  if (pos < 1 || pos + 7 > lower.length) throw new Error('missing separator');
  const hrp = lower.slice(0, pos);
  const data = [];
  for (const ch of lower.slice(pos + 1)) {
    const d = BECH32_CHARSET.indexOf(ch);
    if (d === -1) throw new Error('invalid bech32 character');
    data.push(d);
  }
  if (bech32Polymod(bech32HrpExpand(hrp).concat(data)) !== BECH32M_CONST) {
    throw new Error('checksum mismatch (not valid bech32m)');
  }
  const payload = data.slice(0, -6);
  if (payload.length < 1) throw new Error('empty payload');
  const version = payload[0];
  // Pearl rejects witness v0 entirely; only v1+ (Taproot, P2MR).
  if (version < 1 || version > 16) {
    throw new Error('unsupported witness version (Pearl requires v1+)');
  }
  let acc = 0, bits = 0;
  const program = [];
  for (let i = 1; i < payload.length; i++) {
    acc = (acc << 5) | payload[i];
    bits += 5;
    while (bits >= 8) { bits -= 8; program.push((acc >>> bits) & 0xff); }
  }
  if (bits >= 5 || ((acc << (8 - bits)) & 0xff) !== 0) throw new Error('invalid padding');
  if (program.length < 2 || program.length > 40) throw new Error('invalid program length');
  return { hrp, version, program };
}

/* Validate that addr is a Pearl testnet (tprl) bech32m address.
 * expectedHrp must be 'tprl' — testnet and testnet2 both use the tprl HRP
 * (upstream node/chaincfg/params.go). Throws on invalid input. */
function validatePearlAddress(addr, expectedHrp = 'tprl') {
  const dec = bech32Decode(addr);
  if (dec.hrp !== expectedHrp) {
    throw new Error(`wrong prefix "${dec.hrp}": faucet only serves ${expectedHrp} testnet addresses`);
  }
  return dec;
}

/* Pure rate-limit check. drips: array of { address, amountPRL, time }.
 * opts: { cooldownMs, maxDripPRL, dailyCapPRL, now }.
 * Returns { ok: true } or { ok: false, error, detail }. */
function rateLimitCheck(drips, address, opts) {
  const { cooldownMs, maxDripPRL, dailyCapPRL, now = Date.now() } = opts;
  const addrLower = String(address).toLowerCase();
  // The latest drip wins regardless of array order (store file is normally
  // appended chronologically, but don't depend on it).
  const mine = drips.filter((d) => String(d.address).toLowerCase() === addrLower);
  const last = mine.length ? mine.reduce((a, b) => (b.time > a.time ? b : a)) : null;
  if (last && now - last.time < cooldownMs) {
    const waitH = Math.ceil((cooldownMs - (now - last.time)) / 3600000);
    return {
      ok: false,
      error: 'rate limited',
      detail: `this address already received a drip; try again in ~${waitH}h`,
    };
  }
  const dayAgo = now - 24 * 3600 * 1000;
  const spent24h = drips
    .filter((d) => d.time > dayAgo)
    .reduce((s, d) => s + d.amountPRL, 0);
  if (spent24h + maxDripPRL > dailyCapPRL) {
    return {
      ok: false,
      error: 'daily cap reached',
      detail: 'faucet daily budget exhausted; try again tomorrow',
    };
  }
  return { ok: true };
}

module.exports = {
  BECH32M_CONST,
  bech32Polymod,
  bech32HrpExpand,
  bech32Decode,
  validatePearlAddress,
  rateLimitCheck,
};
