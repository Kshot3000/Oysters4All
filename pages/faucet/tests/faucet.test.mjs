// Pearl Testnet Faucet — bech32m address-validation tests.
// Run: node --test tests/faucet.test.mjs
//
// app.js exports { bech32Decode, validatePearlAddress } for node when no
// DOM is present (its UI wiring is guarded by `typeof document`).
//
// Vector provenance: the tprl vectors below were generated with an
// INDEPENDENT BIP-350 bech32m encoder written from the spec for this
// suite (hidden_files/faucet-tests-2026-10-03/gen-vectors.mjs) — not by
// the code under test — and the encoder itself was pinned against the
// real mainnet address in the page footer: decoding it yields a v1
// 32-byte program whose re-encoding reproduces the address
// character-for-character. The strings are pinned literally here so a
// future edit to either side cannot drift silently.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { bech32Decode, validatePearlAddress } = require("../app.js");

// Real mainnet address carried in the page footer (donation address).
const MAINNET = "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d";
// Same 32-byte witness program as MAINNET, tprl HRP (independent encoder).
const T32 = "tprl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psh7xs6c";
const T_2B = "tprl1pw4mq9384zn"; // v1, 2-byte program (minimum)
const T_40B = "tprl1pqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0jqgfzyvjz2f38u4tam8"; // v1, 40-byte program (maximum)
const T_V2 = "tprl1z62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8pslrll5n"; // v2, 32-byte program
const T_V0_BECH32M = "tprl1q62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psg4k48x"; // v0, bech32m checksum
const T_V0_BECH32 = "tprl1q62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psafxezy"; // v0, bech32 (BIP-173) checksum
const T_PROG_1B = "tprl1p4vzj6qtr"; // v1, 1-byte program (too short)
const T_PROG_41B = "tprl1pqqrsu9guyv4rzwplgex4gkmzd9c8wl593jfe4gdg47mtm3xt6tv7pelw7h7qxzs3rqty69kc"; // v1, 41-byte program (too long)
const T_VER_17 = "tprl1362v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8pst2uj05"; // payload version value 17 (> 16)
const T_BAD_PAD = "tprl1pw4mpc8nqlp"; // v1 2-byte program with a non-zero padding bit

test("exports exist", () => {
  assert.equal(typeof bech32Decode, "function");
  assert.equal(typeof validatePearlAddress, "function");
});

test("real mainnet address decodes: prl / v1 / 32-byte program", () => {
  const dec = bech32Decode(MAINNET);
  assert.equal(dec.hrp, "prl");
  assert.equal(dec.version, 1);
  assert.equal(dec.program.length, 32);
  assert.ok(dec.program instanceof Uint8Array);
});

test("same witness program validates under the tprl HRP", () => {
  const a = bech32Decode(MAINNET);
  const b = validatePearlAddress(T32, "testnet");
  assert.equal(b.hrp, "tprl");
  assert.equal(b.version, 1);
  assert.deepEqual([...b.program], [...a.program]);
});

test("testnet2 maps to the same tprl HRP", () => {
  assert.equal(validatePearlAddress(T32, "testnet2").hrp, "tprl");
});

test("mainnet address is rejected for the testnet faucet (wrong prefix)", () => {
  assert.throws(() => validatePearlAddress(MAINNET, "testnet"), /wrong network prefix/);
  assert.throws(() => validatePearlAddress(MAINNET, "testnet2"), /wrong network prefix/);
});

test("program length boundaries: 2 and 40 bytes accepted", () => {
  assert.equal(bech32Decode(T_2B).program.length, 2);
  assert.equal(bech32Decode(T_40B).program.length, 40);
});

test("witness v2 accepted (Pearl allows v1..v16)", () => {
  const dec = bech32Decode(T_V2);
  assert.equal(dec.version, 2);
  assert.equal(dec.program.length, 32);
});

test("all-uppercase form accepted (BIP-350), case preserved program", () => {
  const dec = bech32Decode(T32.toUpperCase());
  assert.equal(dec.hrp, "tprl");
  assert.deepEqual([...dec.program], [...bech32Decode(T32).program]);
});

test("surrounding whitespace is trimmed", () => {
  assert.equal(bech32Decode("  " + T32 + "\n").hrp, "tprl");
});

test("mixed case rejected", () => {
  const mixed = T32.slice(0, 5) + T32[5].toUpperCase() + T32.slice(6); // tprl1P… — one upper letter among lowers
  assert.throws(() => bech32Decode(mixed), /mixed case/);
});

test("checksum tampering rejected (first, middle, and last data chars)", () => {
  const flip = (s, i) => s.slice(0, i) + (s[i] === "q" ? "p" : "q") + s.slice(i + 1);
  assert.throws(() => bech32Decode(flip(T32, 8)), /checksum mismatch/);
  assert.throws(() => bech32Decode(flip(T32, 30)), /checksum mismatch/);
  assert.throws(() => bech32Decode(flip(T32, T32.length - 1)), /checksum mismatch/);
});

test("characters outside the bech32 charset rejected (b, i, o)", () => {
  for (const bad of ["b", "i", "o"]) {
    const s = T32.slice(0, 10) + bad + T32.slice(11);
    assert.throws(() => bech32Decode(s), /invalid bech32 character/);
  }
});

test("witness v0 rejected even with a valid bech32m checksum (Pearl v1+ rule)", () => {
  assert.throws(() => bech32Decode(T_V0_BECH32M), /unsupported witness version/);
});

test("witness v0 with a BIP-173 bech32 checksum rejected (not bech32m)", () => {
  assert.throws(() => bech32Decode(T_V0_BECH32), /checksum mismatch/);
});

test("version value above 16 rejected", () => {
  assert.throws(() => bech32Decode(T_VER_17), /unsupported witness version/);
});

test("program lengths 1 and 41 rejected", () => {
  assert.throws(() => bech32Decode(T_PROG_1B), /invalid program length/);
  assert.throws(() => bech32Decode(T_PROG_41B), /invalid program length/);
});

test("non-zero padding bits rejected", () => {
  assert.throws(() => bech32Decode(T_BAD_PAD), /invalid padding/);
});

test("malformed inputs rejected", () => {
  assert.throws(() => bech32Decode(42), /must be a string/);
  assert.throws(() => bech32Decode(""), /invalid length/);
  assert.throws(() => bech32Decode("tprl1qq"), /invalid length/);
  assert.throws(() => bech32Decode("tprl1" + "q".repeat(100)), /invalid length/);
  assert.throws(() => bech32Decode("tprlqqqqqqq"), /missing separator/);
});
