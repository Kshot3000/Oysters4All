import { test } from "node:test";
import assert from "node:assert/strict";
import {
  targetForDiff, kryptexTargetForDiff, diffForTarget,
  targetToCompact, compactToTarget, targetToHexBE, targetFromHexBE,
  formatPRL, parsePRL, decodePearlAddress, isValidPearlAddress, splitLogin,
} from "../src/util.js";

// Donation address from the Pearl builder project (known-good bech32m P2TR).
const DONATION = "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d";

test("targetForDiff(2097152) matches the documented HeroMiners share target", () => {
  // docs/protocol/herominers.md: target = 0x7fff8 << 184, compact 0x1a07fff8.
  assert.equal(targetForDiff(2097152), 0x7fff8n << 184n);
  assert.equal(targetToCompact(targetForDiff(2097152)), 0x1a07fff8);
});

test("kryptex target convention differs from pdiff by 65535/65536", () => {
  const p = targetForDiff(2097152);
  const k = kryptexTargetForDiff(2097152);
  assert.equal(k, (1n << 224n) / 2097152n - 1n);
  // pdiff target is the smaller (harder) one: p/k ~= 65535/65536.
  assert.ok(k > p && k - p < k / 60000n);
});

test("compact round-trips", () => {
  for (const diff of [1024, 26000, 888888, 2097152, 2 ** 32]) {
    const t = targetForDiff(diff);
    const nbits = targetToCompact(t);
    const back = compactToTarget(nbits);
    // compact keeps the top 3 bytes; the decoded target is within the low bytes.
    const size = Math.ceil(t.toString(16).length / 2);
    const maxErr = size > 3 ? 1n << BigInt(8 * (size - 3)) : 1n;
    assert.ok(back <= t && t - back < maxErr, `diff ${diff}`);
    assert.equal(diffForTarget(t), diff);
  }
  assert.equal(compactToTarget(0x1a07fff8), 0x7fff8n << 184n);
});

test("target hex helpers", () => {
  const t = targetForDiff(888888);
  const hex = targetToHexBE(t);
  assert.equal(hex.length, 64);
  assert.equal(targetFromHexBE(hex), t);
  assert.throws(() => targetFromHexBE("zz"), /bad hex/);
});

test("PRL/grain conversions are exact", () => {
  assert.equal(parsePRL("1"), 100000000n);
  assert.equal(parsePRL("1.5"), 150000000n);
  assert.equal(parsePRL("0.00000001"), 1n);
  assert.equal(formatPRL(150000000n), "1.5");
  assert.equal(formatPRL(230549524009n), "2305.49524009");
  assert.equal(parsePRL(formatPRL(230549524009n)), 230549524009n);
  assert.throws(() => parsePRL("abc"), /bad amount/);
});

test("bech32m decodes the known-good donation address", () => {
  const d = decodePearlAddress(DONATION);
  assert.equal(d.hrp, "prl");
  assert.equal(d.version, 1);
  assert.equal(d.program.length, 32);
  assert.ok(isValidPearlAddress(DONATION, "mainnet"));
  assert.ok(!isValidPearlAddress(DONATION, "testnet"));
});

test("bech32m rejects malformed addresses", () => {
  assert.ok(!isValidPearlAddress("prl1qqqq", "mainnet"));
  assert.ok(!isValidPearlAddress("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", "mainnet")); // bitcoin hrp
  assert.ok(!isValidPearlAddress(DONATION.slice(0, -1) + "x", "mainnet")); // bad checksum
  assert.ok(!isValidPearlAddress("", "mainnet"));
  // Mixed case must throw on decode.
  assert.throws(() => decodePearlAddress("PrL1" + DONATION.slice(4).toUpperCase()), /mixed case/);
});

test("splitLogin handles wallet.worker and solo: prefix", () => {
  assert.deepEqual(splitLogin("prl1abc.worker1"), { wallet: "prl1abc", worker: "worker1", solo: false });
  assert.deepEqual(splitLogin("solo:prl1abc.w"), { wallet: "prl1abc", worker: "w", solo: true });
  assert.deepEqual(splitLogin("prl1abc"), { wallet: "prl1abc", worker: "", solo: false });
});
