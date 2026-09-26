/** bech32m codec + Pearl address policy tests. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  convertBits,
  decodeSegwitAddress,
  encodeSegwitAddress,
  isValidPearlAddress,
  validatePearlAddress,
} from '../src/index.js';

// The donation address — a real mainnet Pearl P2TR address (also used as a
// decode fixture; verified against upstream node/btcutil/address.go policy).
const DONATION = 'prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d';

describe('bech32m codec', () => {
  it('round-trips encode → decode', () => {
    const program = Uint8Array.from(Buffer.from('a60869f0dbcf1dc659c9cecbaf8050135ea9e8cdc487053f1dc6880949dc684c', 'hex'));
    const addr = encodeSegwitAddress('prl', 1, program);
    const dec = decodeSegwitAddress(addr);
    assert.equal(dec.hrp, 'prl');
    assert.equal(dec.variant, 'bech32m');
    assert.equal(dec.version, 1);
    assert.deepEqual(Buffer.from(dec.program), Buffer.from(program));
  });

  it('accepts uppercase, rejects mixed case', () => {
    const program = new Uint8Array(32).fill(7);
    const lower = encodeSegwitAddress('prl', 1, program);
    assert.equal(decodeSegwitAddress(lower.toUpperCase()).hrp, 'prl');
    const mixed = lower.slice(0, 5).toUpperCase() + lower.slice(5);
    assert.throws(() => decodeSegwitAddress(mixed), /mixed-case/);
  });

  it('rejects tampered checksums', () => {
    const program = new Uint8Array(32).fill(7);
    const addr = encodeSegwitAddress('prl', 1, program);
    const last = addr[addr.length - 1];
    const tampered = addr.slice(0, -1) + (last === 'q' ? 'p' : 'q');
    assert.throws(() => decodeSegwitAddress(tampered), /invalid checksum/);
  });
});

describe('Pearl address policy (mirrors upstream decodeSegWitAddress)', () => {
  it('validates the real donation address as mainnet P2TR', () => {
    const info = validatePearlAddress(DONATION);
    assert.equal(info.network.name, 'mainnet');
    assert.equal(info.version, 1);
    assert.equal(info.program.length, 32);
    assert.equal(info.isP2TR, true);
    assert.equal(info.variant, 'bech32m');
    assert.ok(isValidPearlAddress(DONATION));
    assert.ok(isValidPearlAddress(DONATION, 'mainnet'));
    assert.ok(!isValidPearlAddress(DONATION, 'testnet'));
  });

  it('rejects witness v0 (bech32) addresses', () => {
    // BIP-173 v0 test vector — valid bech32, but Pearl requires v1+ bech32m.
    const v0 = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
    const dec = decodeSegwitAddress(v0);
    assert.equal(dec.version, 0);
    assert.equal(dec.variant, 'bech32');
    assert.throws(() => validatePearlAddress(v0), /bech32m|witness version/);
    assert.ok(!isValidPearlAddress(v0));
  });

  it('rejects unknown HRPs', () => {
    const program = new Uint8Array(32).fill(9);
    const addr = encodeSegwitAddress('doge', 1, program);
    assert.throws(() => validatePearlAddress(addr), /unknown Pearl network/);
    assert.ok(!isValidPearlAddress(addr));
  });

  it('accepts all Pearl HRPs', () => {
    const program = new Uint8Array(32).fill(3);
    for (const [hrp, net] of [['prl', 'mainnet'], ['tprl', 'testnet'], ['rprl', 'regtest']] as const) {
      const addr = encodeSegwitAddress(hrp, 1, program);
      assert.equal(validatePearlAddress(addr).network.name, net);
    }
  });

  it('rejects garbage', () => {
    for (const bad of ['', 'prl1', 'notanaddress', 'prl1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq']) {
      assert.ok(!isValidPearlAddress(bad), `expected invalid: ${bad}`);
    }
  });

  it('flags non-32-byte v1 programs as non-P2TR but still valid', () => {
    const program = new Uint8Array(20).fill(1);
    const addr = encodeSegwitAddress('prl', 1, program);
    const info = validatePearlAddress(addr);
    assert.equal(info.isP2TR, false); // upstream allows 2..40 bytes; P2TR needs 32
  });
});

describe('convertBits', () => {
  it('rejects invalid padding', () => {
    assert.equal(convertBits(Uint8Array.from([0xff]), 5, 8, false), null);
  });
});
