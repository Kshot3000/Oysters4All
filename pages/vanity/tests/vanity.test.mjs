// Pearl Vanity verification suite.
// Run: node --no-warnings --loader ./tests/loader.mjs tests/vanity.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { pbkdf2Sync } from "node:crypto";
import {
  BECH32_CHARSET,
  normalizePrefix,
  expectedAttempts,
  hitProbability,
  formatBig,
  formatDuration,
  randomScalar,
  vanityFromPriv,
  vanityToWIF,
  vanityFromWIF,
  bip86AccountNode,
  bip86ChildPriv,
  seedFromMnemonic,
  newVanityMnemonic,
  fullTarget,
  addressMatches,
  grindBatch,
  verifyFound,
  proveKeyControl,
  decodeVanityAddress,
  NETWORKS,
  hexToBytes,
  bytesToHex,
  schnorr,
} from "../src/vanity-core.js";
import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesToNumberBE, numberToBytesBE } from "@noble/curves/abstract/utils";

/* deterministic byte RNG (mulberry32) for reproducible grind tests */
function seededRng(seed) {
  let a = seed >>> 0;
  return (n) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      out[i] = ((t ^ (t >>> 14)) >>> 0) & 0xff;
    }
    return out;
  };
}

test("normalizePrefix accepts valid input, lowercases", () => {
  assert.equal(normalizePrefix("pearl").prefix, "pearl");
  assert.equal(normalizePrefix("  QrZ9  ").prefix, "qrz9");
  assert.equal(normalizePrefix("a").prefix, "a");
});

test("normalizePrefix rejects bad input with helpful errors", () => {
  assert.match(normalizePrefix("").error, /at least 1/);
  assert.match(normalizePrefix("abcdef").error, /5 characters/);
  assert.match(normalizePrefix("ab1").error, /not in the bech32 alphabet/);
  assert.match(normalizePrefix("1").error, /separator/);
  assert.match(normalizePrefix("ob").error, /look-alikes/);
  assert.match(normalizePrefix("bi").error, /look-alikes/);
  // every charset char is accepted
  for (const ch of BECH32_CHARSET) {
    const r = normalizePrefix(ch);
    assert.ok(!r.error, `charset char '${ch}' rejected: ${r.error}`);
  }
});

test("expectedAttempts / hitProbability / formatters", () => {
  assert.equal(expectedAttempts(1), 32n);
  assert.equal(expectedAttempts(3), 32768n);
  assert.equal(expectedAttempts(5), 33554432n);
  const p = hitProbability(expectedAttempts(3), 3);
  assert.ok(Math.abs(p - (1 - 1 / Math.E)) < 1e-9, `p=${p}`);
  assert.equal(hitProbability(0n, 3), 0);
  assert.equal(formatBig(33554432n), "33,554,432");
  assert.equal(formatDuration(0.4), "< 1 second");
  assert.equal(formatDuration(90), "1 minute 30 seconds");
  assert.equal(formatDuration(90061), "1 day 1 hour");
});

test("randomScalar rejects zero and >= n, accepts valid", () => {
  const n = secp256k1.CURVE.n;
  const nBytes = numberToBytesBE(n, 32);
  let calls = 0;
  const s = randomScalar(() => {
    calls++;
    if (calls === 1) return new Uint8Array(32); // zero -> reject
    if (calls === 2) return nBytes.slice(); // n -> reject
    const b = new Uint8Array(32); b[31] = 7; return b;
  });
  assert.equal(calls, 3);
  assert.equal(bytesToNumberBE(s), 7n);
  assert.throws(() => randomScalar(() => new Uint8Array(16)), /32 bytes/);
});

test("vanityFromPriv: deterministic, v1 32-byte program, bech32m round-trip", () => {
  const net = NETWORKS.mainnet;
  const priv = new Uint8Array(32).fill(1);
  const w1 = vanityFromPriv(priv, net);
  const w2 = vanityFromPriv(bytesToHex(priv), net);
  assert.equal(w1.address, w2.address);
  assert.ok(w1.address.startsWith("prl1p"), w1.address);
  assert.equal(w1.xonly.length, 32);
  // independent check: x-only pubkey matches noble directly
  assert.equal(bytesToHex(w1.xonly), bytesToHex(schnorr.getPublicKey(priv)));
  // decode round-trip recovers the program
  assert.equal(decodeVanityAddress(w1.address, "mainnet"), bytesToHex(w1.xonly));
  // testnet hrp differs
  const wt = vanityFromPriv(priv, NETWORKS.testnet);
  assert.ok(wt.address.startsWith("tprl1p"), wt.address);
});

test("WIF round-trip preserves the raw spend secret (no tweak)", () => {
  const net = NETWORKS.mainnet;
  const priv = seededRng(42)(32);
  const wif = vanityToWIF(priv, net);
  const back = vanityFromWIF(wif, net);
  assert.equal(bytesToHex(back.priv), bytesToHex(priv));
  assert.equal(back.address, vanityFromPriv(priv, net).address);
  assert.throws(() => vanityFromWIF(wif, NETWORKS.testnet), /network version/);
});

test("grindBatch random mode finds a 1-char prefix with seeded RNG", () => {
  const rng = seededRng(1234);
  let total = 0, found = null;
  for (let b = 0; b < 40 && !found; b++) {
    const r = grindBatch({ prefix: "q", networkId: "mainnet", mode: "random", startIndex: 0, batchSize: 256, rng });
    total += r.scanned;
    found = r.found;
  }
  assert.ok(found, "1-char prefix should be found within 10240 seeded attempts");
  assert.ok(found.address.startsWith("prl1pq"), found.address);
  assert.ok(addressMatches(found.address, "mainnet", "q"));
  assert.equal(found.mode, "random");
  assert.equal(found.index, null);
  // re-derive integrity
  const v = verifyFound(found, "q");
  assert.ok(v.ok, v.error);
  assert.equal(v.xonlyHex, found.xonlyHex);
  // wrong prefix fails verification
  assert.ok(!verifyFound(found, "z").ok);
  // key actually controls the address (keypath Schnorr round-trip)
  const msg = new Uint8Array(32).fill(0xab);
  const proof = proveKeyControl(found.privHex, msg);
  assert.ok(proof.ok);
  assert.equal(proof.xonlyHex, found.xonlyHex);
});

test("grindBatch bip86 mode walks the derivation path with stride", () => {
  const mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  // BIP-39 seed for the test vector (PBKDF2-HMAC-SHA512, 2048 rounds, "mnemonic" salt)
  const seed = pbkdf2Sync(mnemonic.normalize("NFKD"), "mnemonic", 2048, 64, "sha512");
  const acct = bip86AccountNode(seed, NETWORKS.mainnet, 0);
  const rng = seededRng(7); // unused in bip86 mode
  let found = null, scannedTotal = 0;
  for (let b = 0; b < 60 && !found; b++) {
    const r = grindBatch({
      prefix: "qp", networkId: "mainnet", mode: "bip86",
      accountNode: acct, startIndex: b * 256, stride: 1, batchSize: 256, rng,
    });
    scannedTotal += r.scanned;
    found = r.found;
  }
  assert.ok(found, `2-char prefix should be found within ${scannedTotal} derivations`);
  assert.ok(found.address.startsWith("prl1pqp"), found.address);
  assert.match(found.path, /^m\/86'\/808276'\/0'\/0\/\d+$/);
  assert.equal(found.index, Number(found.path.split("/").pop()));
  // child key re-derives the same address independently
  const c = bip86ChildPriv(acct, found.index);
  assert.equal(c.path, found.path);
  assert.equal(vanityFromPriv(c.priv, NETWORKS.mainnet).address, found.address);
});

test("grindBatch validates inputs", () => {
  const rng = seededRng(1);
  assert.throws(() => grindBatch({ prefix: "!!!", networkId: "mainnet", mode: "random", startIndex: 0, batchSize: 8, rng }), /bech32/);
  assert.throws(() => grindBatch({ prefix: "q", networkId: "nope", mode: "random", startIndex: 0, batchSize: 8, rng }), /unknown network/);
  assert.throws(() => grindBatch({ prefix: "q", networkId: "mainnet", mode: "bip86", startIndex: 0, batchSize: 8, rng }), /accountNode/);
  assert.throws(() => grindBatch({ prefix: "q", networkId: "mainnet", mode: "weird", startIndex: 0, batchSize: 8, rng }), /unknown grind mode/);
  const empty = grindBatch({ prefix: "qpzry", networkId: "mainnet", mode: "random", startIndex: 0, batchSize: 4, rng: seededRng(99) });
  assert.equal(empty.scanned, 4);
  assert.equal(empty.found, null);
});

test("seedFromMnemonic validates and derives the BIP-39 test-vector seed", () => {
  const mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  const seed = seedFromMnemonic(mnemonic);
  assert.equal(seed.length, 64);
  assert.equal(bytesToHex(seed.slice(0, 8)), "5eb00bbddcf06908");
  assert.throws(() => seedFromMnemonic("abandon abandon about"), /12- or 24-word/);
  assert.throws(() => seedFromMnemonic("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon"), /checksum/);
  const fresh = newVanityMnemonic();
  assert.equal(fresh.trim().split(/\s+/).length, 12);
  assert.ok(seedFromMnemonic(fresh).length === 64);
});

test("fullTarget / addressMatches", () => {
  assert.equal(fullTarget("mainnet", "pearl"), "prl1ppearl");
  assert.equal(fullTarget("testnet", "pearl"), "tprl1ppearl");
  assert.ok(addressMatches("prl1ppearlxxxx", "mainnet", "pearl"));
  assert.ok(!addressMatches("prl1pqrzxxxx", "mainnet", "pearl"));
});
