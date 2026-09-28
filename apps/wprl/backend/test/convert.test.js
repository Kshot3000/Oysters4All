import test from "node:test";
import assert from "node:assert/strict";
import {
  grainsToWei,
  weiToGrains,
  feeOf,
  depositFeeGrains,
  prlValueToGrains,
  grainsToPrlString,
  isValidPrlAddress,
  isValidEvmAddress,
  WEI_PER_GRAIN,
} from "../convert.js";

test("grain<->wei conversion is exact", () => {
  assert.equal(WEI_PER_GRAIN, 10_000_000_000n);
  assert.equal(grainsToWei(1n), 10_000_000_000n);
  assert.equal(grainsToWei(100_000_000n), 1_000_000_000_000_000_000n); // 1 PRL = 1 wPRL
  assert.equal(weiToGrains(10_000_000_000n), 1n);
  assert.equal(weiToGrains(19_999_999_999n), 1n); // sub-grain dust truncates
  assert.equal(weiToGrains(grainsToWei(123456789n)), 123456789n); // round-trip
  assert.throws(() => grainsToWei(-1n), RangeError);
});

test("fee math matches the contract (25 bps, integer division)", () => {
  assert.equal(feeOf(10_000n), 25n); // 10000 * 25 / 10000
  assert.equal(feeOf(1n), 0n); // dust -> zero fee, like the contract
  assert.equal(feeOf(1_000_000_000_000_000_000n), 2_500_000_000_000_000n); // 1 wPRL -> 0.0025
});

test("deposit fee rounds UP so the operator is never shorted", () => {
  assert.equal(depositFeeGrains(100_000_000n), 250_000n); // 1 PRL -> 0.0025 PRL
  assert.equal(depositFeeGrains(1n), 1n); // ceil: 1 grain deposit needs a 1-grain fee output
  assert.equal(depositFeeGrains(400n), 1n); // 400*25/10000 = 1 exactly
  assert.equal(depositFeeGrains(401n), 2n); // 401*25/10000 = 1.0025 -> 2
});

test("prlValueToGrains parses decimals exactly, never floats", () => {
  assert.equal(prlValueToGrains(1.1), 110_000_000n); // the classic float trap: 1.1 is not exact in binary
  assert.equal(prlValueToGrains("0.00000001"), 1n);
  assert.equal(prlValueToGrains("123.45678901"), 12_345_678_901n);
  assert.equal(prlValueToGrains(0), 0n);
  // real RPC floats stringify to scientific notation — must still parse exactly
  assert.equal(prlValueToGrains(0.0000005), 50n); // String(0.0000005) === "5e-7"
  assert.equal(prlValueToGrains(2e-8), 2n);
  assert.equal(prlValueToGrains("1e-8"), 1n);
  assert.throws(() => prlValueToGrains("1.234567891"), /invalid PRL/); // 9 decimals
  assert.throws(() => prlValueToGrains("abc"), /invalid PRL/);
  assert.throws(() => prlValueToGrains("-1"), /invalid PRL/);
});

test("grainsToPrlString produces exact 8-decimal strings for sendtoaddress", () => {
  assert.equal(grainsToPrlString(1n), "0.00000001");
  assert.equal(grainsToPrlString(123456789n), "1.23456789");
  assert.equal(grainsToPrlString(100_000_000n), "1.00000000");
  assert.equal(grainsToPrlString(0n), "0.00000000");
  // round-trips through the parser, including huge values
  assert.equal(prlValueToGrains(grainsToPrlString(9876543210123456789n)), 9876543210123456789n);
  assert.throws(() => grainsToPrlString(-5n), RangeError);
});

test("address validators", () => {
  assert.ok(isValidPrlAddress("prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d"));
  assert.ok(!isValidPrlAddress("0x4b6f3BC697D9dAF3e8dE182aEc56eD208B9087f1"));
  assert.ok(!isValidPrlAddress("prl1"));
  assert.ok(isValidEvmAddress("0x4b6f3BC697D9dAF3e8dE182aEc56eD208B9087f1"));
  assert.ok(!isValidEvmAddress("0x123"));
  assert.ok(!isValidEvmAddress("prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d"));
});
