/* Pearl Prove — node test suite. Run: node --test tests/ */
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const P = require("../js/prove-core.js");

function dshaNode(b) {
  return crypto.createHash("sha256").update(crypto.createHash("sha256").update(b).digest()).digest();
}
function randHex(n, bytes) {
  return crypto.randomBytes(bytes).toString("hex").padStart(n, "0").slice(0, n);
}

/* --- SHA-256 correctness (cross-checked vs node:crypto) --- */

test("sha256 matches FIPS vectors + node:crypto", () => {
  const abc = Buffer.from("abc");
  assert.equal(P.bytesToHex(P.sha256(abc)), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(P.bytesToHex(P.sha256(new Uint8Array(0))), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  for (let i = 0; i < 20; i++) {
    const m = crypto.randomBytes(1 + Math.floor(Math.random() * 300));
    assert.deepEqual(Buffer.from(P.sha256(m)), crypto.createHash("sha256").update(m).digest());
  }
});

test("dsha matches node double-sha256", () => {
  for (let i = 0; i < 10; i++) {
    const m = crypto.randomBytes(64);
    assert.deepEqual(Buffer.from(P.dsha(m)), dshaNode(m));
  }
});

/* --- input validation --- */

test("strict input validation", () => {
  assert.throws(() => P.txidToInternal("zz".repeat(32)), /txid/);
  assert.throws(() => P.txidToInternal("ab".repeat(31)), /txid/);
  assert.throws(() => P.merkleRoot([]), /at least one/);
  assert.throws(() => P.merkleRoot(["ab".repeat(31)]), /txid/);
  assert.throws(() => P.merkleProof(["ab".repeat(32)], 1), /out of range/);
  assert.throws(() => P.verifyProof("ab".repeat(32), [], "cd".repeat(32)), /non-empty/);
  assert.throws(() => P.verifyProof("ab".repeat(32), [{ sibling: "cd".repeat(32), position: "up" }], "cd".repeat(32)), /position/);
  assert.throws(() => P.decodeHeader("ab".repeat(79)), /160 hex/);
  assert.throws(() => P.parseProofLines("hello"), /bad proof line/);
  assert.throws(() => P.parseTxidList(""), /no txids/);
});

/* --- merkle vectors --- */

test("merkle: single tx -> root is the txid", () => {
  const t = randHex(64, 32);
  assert.equal(P.merkleRoot([t]), t.toLowerCase());
  assert.deepEqual(P.merkleProof([t], 0), []);
});

test("merkle: two txs -> dsha(a||b) in display order", () => {
  const a = "aa".repeat(32), b = "bb".repeat(32);
  const cat = Buffer.concat([Buffer.from(P.txidToInternal(a)), Buffer.from(P.txidToInternal(b))]);
  const expect = P.internalToTxid(new Uint8Array(dshaNode(cat)));
  assert.equal(P.merkleRoot([a, b]), expect);
});

test("merkle: odd count duplicates the last node (upstream rule)", () => {
  const ts = [randHex(64, 32), randHex(64, 32), randHex(64, 32)];
  const dup4 = P.merkleRoot([ts[0], ts[1], ts[2], ts[2]]);
  assert.equal(P.merkleRoot(ts), dup4);
});

test("merkle: proof round-trip for every leaf of a 5-leaf tree", () => {
  const ts = Array.from({ length: 5 }, () => randHex(64, 32));
  const root = P.merkleRoot(ts);
  ts.forEach((t, i) => {
    const proof = P.merkleProof(ts, i);
    assert.ok(P.verifyProof(t, proof, root), `leaf ${i} should verify`);
    // tamper with the first sibling -> must fail
    const bad = JSON.parse(JSON.stringify(proof));
    bad[0].sibling = "ff".repeat(32);
    assert.ok(!P.verifyProof(t, bad, root), `leaf ${i} tampered must fail`);
  });
});

test("merkle: proof positions are correct on a 3-leaf tree", () => {
  const ts = ["11".repeat(32), "22".repeat(32), "33".repeat(32)];
  const root = P.merkleRoot(ts);
  const p0 = P.merkleProof(ts, 0);
  assert.equal(p0.length, 2);
  assert.equal(p0[0].position, "right"); // sibling is tx1
  assert.equal(p0[0].sibling, ts[1]);
  assert.equal(p0[1].position, "right"); // sibling is h(33||33)
  const p2 = P.merkleProof(ts, 2);
  assert.equal(p2[0].position, "right"); // 33 duplicated: sibling is itself
  assert.equal(p2[0].sibling, ts[2]);
  assert.ok(P.verifyProof(ts[2], p2, root));
});

/* --- real Pearl mainnet block 120195 (fixture) --- */

test("REAL PEARL BLOCK 120195: recomputed root == blockbook merkleRoot", () => {
  const f = JSON.parse(fs.readFileSync(path.join(__dirname, "fixture-120195.json"), "utf8"));
  assert.equal(f.txids.length, 40);
  const root = P.merkleRoot(f.txids);
  assert.equal(root, f.merkleRoot, "must match the real chain data");
});

test("REAL PEARL BLOCK 120195: inclusion proof for a mid-list tx verifies", () => {
  const f = JSON.parse(fs.readFileSync(path.join(__dirname, "fixture-120195.json"), "utf8"));
  const idx = 17;
  const proof = P.merkleProof(f.txids, idx);
  assert.ok(proof.length > 0);
  assert.ok(P.verifyProof(f.txids[idx], proof, f.merkleRoot));
  // proof lines round-trip through the parser
  const lines = proof.map((s) => `${s.position === "left" ? "L" : "R"} ${s.sibling}`).join("\n");
  assert.ok(P.verifyProof(f.txids[idx], P.parseProofLines(lines), f.merkleRoot));
  // a tx NOT in the block must not verify against the block's root
  const outsider = randHex(64, 32);
  assert.ok(!P.verifyProof(outsider, proof, f.merkleRoot));
});

/* --- header decode + target check --- */

function buildHeader({ version, prevHex, rootHex, time, bits, nonce }) {
  const b = Buffer.alloc(80);
  b.writeUInt32LE(version, 0);
  Buffer.from(P.txidToInternal(prevHex)).copy(b, 4);
  Buffer.from(P.txidToInternal(rootHex)).copy(b, 36);
  b.writeUInt32LE(time, 68);
  b.writeUInt32LE(bits, 72);
  b.writeUInt32LE(nonce, 76);
  return b.toString("hex");
}

test("decodeHeader round-trips every field", () => {
  const prev = randHex(64, 32), root = randHex(64, 32);
  const hex = buildHeader({ version: 0x20000000, prevHex: prev, rootHex: root, time: 1790572974, bits: 0x180087d6, nonce: 42 });
  const h = P.decodeHeader(hex);
  assert.equal(h.version, 0x20000000);
  assert.equal(h.prevHash, prev.toLowerCase());
  assert.equal(h.merkleRoot, root.toLowerCase());
  assert.equal(h.time, 1790572974);
  assert.equal(h.bits, "180087d6");
  assert.equal(h.nonce, 42);
  assert.equal(h.hash, P.internalToTxid(P.dsha(Buffer.from(hex, "hex"))));
});

test("decodeHeader target check: easy target passes, real target fails for random header", () => {
  const prev = "00".repeat(32), root = "11".repeat(32);
  // bits 0x207fffff -> astronomically easy target: any hash passes
  const easy = buildHeader({ version: 1, prevHex: prev, rootHex: root, time: 1, bits: 0x207fffff, nonce: 0 });
  const he = P.decodeHeader(easy);
  assert.ok(he.meetsTarget, "easy target must pass");
  assert.equal(he.targetHex.slice(0, 4), "7fff");
  // Bitcoin mainnet genesis-ish difficulty: random header must fail
  const hard = buildHeader({ version: 1, prevHex: prev, rootHex: root, time: 1, bits: 0x1d00ffff, nonce: 0 });
  assert.ok(!P.decodeHeader(hard).meetsTarget, "hard target must fail for a random header");
});

test("targetFromBits rejects malformed nBits", () => {
  assert.throws(() => P.targetFromBits(0x00800000), /invalid/); // negative bit
  assert.throws(() => P.targetFromBits(0x02000001), /invalid/); // exponent < 3
  assert.throws(() => P.targetFromBits(0x1d000000), /invalid/); // zero mantissa
});

test("parseTxidList handles mixed separators and validates", () => {
  const a = "aa".repeat(32), b = "bb".repeat(32);
  assert.deepEqual(P.parseTxidList(`${a}\n${b},  ${a}`), [a, b, a]);
  assert.throws(() => P.parseTxidList(`${a} nothex`), /not a 64-hex/);
});

test("parseProofLines ignores comments and blanks", () => {
  const a = "aa".repeat(32), b = "bb".repeat(32);
  const p = P.parseProofLines(`# comment\nL ${a}\n\nR ${b}\n`);
  assert.deepEqual(p, [
    { sibling: a, position: "left" },
    { sibling: b, position: "right" },
  ]);
});
