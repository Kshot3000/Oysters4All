/* Unit tests for faucet lib.js — pure functions.
 *
 * Address vectors were generated INDEPENDENTLY with the TypeScript bech32m
 * encoder in examples/wallet-helper (which passes official BIP-86
 * known-answer vectors), from the BIP-86 test-vector x-only pubkey
 * 68e78cdb2f856c7144d1a4d2c26da4dd9d0883c0dc7c47eb6f8e4fbb1b2b.
 * They are hardcoded here so this test catches regressions in lib.js itself.
 *
 * Run: npm test   (node --test test/)
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  bech32Decode,
  validatePearlAddress,
  rateLimitCheck,
} = require('../lib.js');

/* ---------- address validation ---------- */

const VALID_TPRL_V1 = 'tprl1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxq99uv3z';
const VALID_TPRL_V2 = 'tprl1z5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqdc9rlf';
const MAINNET_PRL_V1 = 'prl1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqw2cjwh';
const REGTEST_RPRL_V1 = 'rprl1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqluq552';
// bech32 (not bech32m) witness-v0 address — Pearl rejects v0 entirely
const TPRL_V0 = 'tprl1qqurswpc8qurswpc8qurswpc8qurswpc864wmrk';

describe('bech32Decode', () => {
  it('decodes a valid tprl v1 (Taproot) address', () => {
    const dec = bech32Decode(VALID_TPRL_V1);
    assert.equal(dec.hrp, 'tprl');
    assert.equal(dec.version, 1);
    assert.equal(dec.program.length, 32);
    assert.deepEqual(
      Buffer.from(dec.program).toString('hex'),
      'a60869f0dbcf1dc659c9cecbaf8050135ea9e8cdc487053f1dc6880949dc684c' // BIP-86 m/86'/0'/0'/0/0 taproot output key
    );
  });

  it('accepts uppercase input (decodes case-insensitively)', () => {
    const dec = bech32Decode(VALID_TPRL_V1.toUpperCase());
    assert.equal(dec.hrp, 'tprl');
    assert.equal(dec.version, 1);
  });

  it('trims surrounding whitespace', () => {
    assert.equal(bech32Decode('  ' + VALID_TPRL_V1 + '\n').version, 1);
  });

  it('rejects mixed case', () => {
    assert.throws(() => bech32Decode('TpRl1pdrnceke0s4k8z3x35nfvymdymkws3q7qm37y06m03e8mkxetr3mcf8'),
      /mixed case/);
  });

  it('rejects a bech32m-encoded v0 address — Pearl is witness v1+ only', () => {
    // (A proper bech32 v0 address fails earlier with a checksum mismatch;
    // either way Pearl policy rejects v0.)
    assert.throws(() => bech32Decode(TPRL_V0), /(not valid bech32m|unsupported witness version)/);
  });

  it('rejects corrupted checksums', () => {
    const bad = VALID_TPRL_V1.slice(0, -1) + (VALID_TPRL_V1.endsWith('8') ? '9' : '8');
    assert.throws(() => bech32Decode(bad), /checksum/);
  });

  it('rejects invalid characters', () => {
    assert.throws(() => bech32Decode(VALID_TPRL_V1.slice(0, 10) + 'i' + VALID_TPRL_V1.slice(11)),
      /invalid bech32 character/);
  });

  it('rejects garbage and wrong types', () => {
    assert.throws(() => bech32Decode('not an address'), /missing separator|invalid/);
    assert.throws(() => bech32Decode(''), /invalid length/);
    assert.throws(() => bech32Decode(null), /must be a string/);
    assert.throws(() => bech32Decode('x'.repeat(91)), /invalid length/);
  });
});

describe('validatePearlAddress (faucet policy: tprl only)', () => {
  it('accepts a valid tprl v1 address', () => {
    assert.equal(validatePearlAddress(VALID_TPRL_V1).hrp, 'tprl');
  });

  it('accepts a valid tprl v2 (future P2MR) address', () => {
    assert.equal(validatePearlAddress(VALID_TPRL_V2).version, 2);
  });

  it('rejects mainnet prl addresses', () => {
    assert.throws(() => validatePearlAddress(MAINNET_PRL_V1), /wrong prefix "prl"/);
  });

  it('rejects regtest rprl addresses', () => {
    assert.throws(() => validatePearlAddress(REGTEST_RPRL_V1), /wrong prefix "rprl"/);
  });

  it('rejects witness v0 addresses outright', () => {
    assert.throws(() => validatePearlAddress(TPRL_V0));
  });
});

/* ---------- rate limiting ---------- */

const OPTS = { cooldownMs: 24 * 3600 * 1000, maxDripPRL: 1, dailyCapPRL: 100 };
const NOW = 1_750_000_000_000; // fixed "now" for deterministic tests

function drip(address, time, amountPRL = 1) {
  return { address, time, amountPRL, txid: 'x'.repeat(64), network: 'testnet' };
}

describe('rateLimitCheck', () => {
  it('allows the first drip to a fresh address', () => {
    assert.deepEqual(rateLimitCheck([], VALID_TPRL_V1, { ...OPTS, now: NOW }), { ok: true });
  });

  it('blocks a second drip inside the cooldown window', () => {
    const drips = [drip(VALID_TPRL_V1, NOW - 3600 * 1000)]; // 1h ago
    const r = rateLimitCheck(drips, VALID_TPRL_V1, { ...OPTS, now: NOW });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'rate limited');
    assert.match(r.detail, /try again in ~\d+h/);
  });

  it('matches addresses case-insensitively', () => {
    const drips = [drip(VALID_TPRL_V1, NOW - 3600 * 1000)];
    const r = rateLimitCheck(drips, VALID_TPRL_V1.toUpperCase(), { ...OPTS, now: NOW });
    assert.equal(r.ok, false);
  });

  it('allows a drip after the cooldown expires', () => {
    const drips = [drip(VALID_TPRL_V1, NOW - 25 * 3600 * 1000)]; // 25h ago
    assert.deepEqual(rateLimitCheck(drips, VALID_TPRL_V1, { ...OPTS, now: NOW }), { ok: true });
  });

  it('only considers the latest drip per address', () => {
    const drips = [
      drip(VALID_TPRL_V1, NOW - 3600 * 1000), // recent — blocks
      drip(VALID_TPRL_V1, NOW - 48 * 3600 * 1000),
    ];
    assert.equal(rateLimitCheck(drips, VALID_TPRL_V1, { ...OPTS, now: NOW }).ok, false);
    const oldFirst = [
      drip(VALID_TPRL_V1, NOW - 48 * 3600 * 1000),
      drip(VALID_TPRL_V1, NOW - 25 * 3600 * 1000), // latest is 25h ago — allowed
    ];
    assert.deepEqual(rateLimitCheck(oldFirst, VALID_TPRL_V1, { ...OPTS, now: NOW }), { ok: true });
  });

  it('blocks when the rolling 24h daily cap would be exceeded', () => {
    const drips = [];
    for (let i = 0; i < 100; i++) drips.push(drip(`tprl1addr${i}`, NOW - i * 60 * 1000));
    const r = rateLimitCheck(drips, VALID_TPRL_V1, { ...OPTS, now: NOW });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'daily cap reached');
  });

  it('ignores drips older than 24h in the cap accounting', () => {
    const drips = [];
    for (let i = 0; i < 200; i++) drips.push(drip(`tprl1addr${i}`, NOW - 25 * 3600 * 1000));
    assert.deepEqual(rateLimitCheck(drips, VALID_TPRL_V1, { ...OPTS, now: NOW }), { ok: true });
  });

  it('sums partial drips against the cap', () => {
    const drips = [drip('tprl1a', NOW - 1000, 99.5)];
    const ok = rateLimitCheck(drips, VALID_TPRL_V1, { ...OPTS, maxDripPRL: 0.5, now: NOW });
    assert.deepEqual(ok, { ok: true });
    const blocked = rateLimitCheck(drips, VALID_TPRL_V1, { ...OPTS, maxDripPRL: 1, now: NOW });
    assert.equal(blocked.ok, false);
  });
});
