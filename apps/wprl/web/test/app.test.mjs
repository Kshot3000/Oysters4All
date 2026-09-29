// Unit tests for web/app.js pure helpers. Run: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const h = require("../app.js");

test("parsePrlToGrains: exact decimal parsing, never floats", () => {
  assert.equal(h.parsePrlToGrains("10"), 1000000000n);
  assert.equal(h.parsePrlToGrains("2.5"), 250000000n);
  assert.equal(h.parsePrlToGrains("0.00000001"), 1n);
  assert.equal(h.parsePrlToGrains("0.00000005"), 5n); // the scientific-notation float trap
  assert.throws(() => h.parsePrlToGrains("1.123456789"), /max 8 decimals/);
  assert.throws(() => h.parsePrlToGrains("abc"), /PRL amount/);
  assert.throws(() => h.parsePrlToGrains("-1"), /PRL amount/);
  assert.throws(() => h.parsePrlToGrains(""), /PRL amount/);
});

test("parseWprlToWei: 18 decimals exact", () => {
  assert.equal(h.parseWprlToWei("1"), 1000000000000000000n);
  assert.equal(h.parseWprlToWei("0.000000000000000001"), 1n);
  assert.throws(() => h.parseWprlToWei("1.0000000000000000001"), /max 18 decimals/);
});

test("grainsToPrlString / weiToWprlString round-trip", () => {
  assert.equal(h.grainsToPrlString(123456789n), "1.23456789");
  assert.equal(h.grainsToPrlString(100000000n), "1");
  assert.equal(h.grainsToPrlString(1n), "0.00000001");
  assert.equal(h.grainsToPrlString(0n), "0");
  assert.equal(h.weiToWprlString(2500000000000000000n), "2.5");
  assert.equal(h.weiToWprlString(1n), "0.000000000000000001");
  // round trips
  assert.equal(h.grainsToPrlString(h.parsePrlToGrains("12.345678")), "12.345678");
  assert.equal(h.weiToWprlString(h.parseWprlToWei("7.5")), "7.5");
});

test("depositFeeGrains: ceil(D*25/10000) — matches backend deposit.js", () => {
  assert.equal(h.depositFeeGrains(100000000n), 250000n); // 1 PRL -> 0.0025 PRL
  assert.equal(h.depositFeeGrains(100000n), 250n);       // min deposit 0.001 PRL
  assert.equal(h.depositFeeGrains(1n), 1n);             // ceil: never rounds to zero
  assert.equal(h.depositFeeGrains(399n), 1n);           // 399*25/10000 = 0.9975 -> 1
  assert.equal(h.depositFeeGrains(400n), 1n);           // exactly 1
});

test("withdrawFeeWei: floor(amountWei*25/10000) — matches WPRLBridge", () => {
  assert.equal(h.withdrawFeeWei(1000000000000000000n), 2500000000000000n); // 1 wPRL -> 0.0025
  assert.equal(h.withdrawFeeWei(399n), 0n);  // floor: sub-wei dust truncates
  assert.equal(h.withdrawFeeWei(400n), 1n);
});

test("isValidEvmAddress", () => {
  assert.ok(h.isValidEvmAddress("0x4b6f3BC697D9dAF3e8dE182aEc56eD208B9087f1"));
  assert.ok(!h.isValidEvmAddress("0x123"));
  assert.ok(!h.isValidEvmAddress("prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d"));
});

test("isValidPrlAddress: mirrors contract (prl1 prefix, len>=8), rejects EVM", () => {
  assert.ok(h.isValidPrlAddress("prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d"));
  assert.ok(!h.isValidPrlAddress("0x4b6f3BC697D9dAF3e8dE182aEc56eD208B9087f1"));
  assert.ok(!h.isValidPrlAddress("prl1"));
  assert.ok(!h.isValidPrlAddress("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"));
});

test("buildMemo", () => {
  assert.equal(
    h.buildMemo("0x4b6f3BC697D9dAF3e8dE182aEc56eD208B9087f1"),
    "wprl:0x4b6f3BC697D9dAF3e8dE182aEc56eD208B9087f1"
  );
});
