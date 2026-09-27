import { test } from "node:test";
import assert from "node:assert/strict";
import {
  blockSubsidyGrains, merkleRootDisplay, buildHeaderBytes,
  SyntheticProvider, PearldProvider, HEADER_BYTES,
} from "../src/templates.js";
import { compactToTarget } from "../src/util.js";

test("blockSubsidyGrains matches the documented height-119365 value", () => {
  // Documented: ~2305.5 PRL at height 119365.
  assert.equal(blockSubsidyGrains(119365), 230549524009n);
  // Monotonically decreasing, positive.
  assert.ok(blockSubsidyGrains(200000) < blockSubsidyGrains(119365));
  assert.ok(blockSubsidyGrains(1000000) > 0n);
});

test("merkleRootDisplay: single tx root is the txid", () => {
  const tx = "ab".repeat(32);
  assert.equal(merkleRootDisplay([tx]), tx);
});

test("merkleRootDisplay: two-tx vector (double-sha256, display order)", () => {
  assert.equal(
    merkleRootDisplay(["aa".repeat(32), "bb".repeat(32)]),
    "fb76b78e0fae95e9804262321cd913f27a1f41b799f3b0b7b93f37393b0d9d49"
  );
});

test("merkleRootDisplay: odd count duplicates the last leaf", () => {
  const txs = ["aa".repeat(32), "bb".repeat(32), "cc".repeat(32)];
  const r3 = merkleRootDisplay(txs);
  assert.equal(r3.length, 64);
  assert.notEqual(r3, merkleRootDisplay(txs.slice(0, 2)));
});

test("buildHeaderBytes lays out the 76-byte header", () => {
  const prev = "11".repeat(32), root = "22".repeat(32);
  const h = buildHeaderBytes({ version: 0x20000000, prevHex: prev, merkleHex: root, timestamp: 1759000000, nbits: 0x1a07fff8 });
  assert.equal(h.length, HEADER_BYTES);
  assert.equal(h.readUInt32LE(0), 0x20000000);
  assert.equal(h.subarray(4, 36).toString("hex"), prev);
  assert.equal(h.subarray(36, 68).toString("hex"), root);
  assert.equal(h.readUInt32LE(68), 1759000000);
  assert.equal(h.readUInt32LE(72), 0x1a07fff8);
  // The IncompleteBlockHeader layout the Rust verifier parses: version|prev|root|time|nbits.
  assert.equal(h.toString("hex").length, 152);
});

test("SyntheticProvider emits well-formed templates", async () => {
  const p = new SyntheticProvider({ networkDiff: 65536, startHeight: 120000, certVersion: 3 });
  const t1 = await p.getTemplate();
  assert.equal(t1.headerHex.length, 152);
  assert.equal(t1.certVersion, 3);
  assert.equal(t1.height, 120000);
  assert.ok(t1.networkTarget > 0n);
  assert.equal(t1.coinbaseValueGrains, blockSubsidyGrains(120000));
  assert.equal(t1.source, "synthetic-demo");
  // Block found -> chain advances, prev links to the found header.
  p.notifyBlockFound(t1.headerHex);
  const t2 = await p.getTemplate();
  assert.equal(t2.height, 120001);
  assert.notEqual(t2.templateId, t1.templateId);
});

test("PearldProvider builds a header from a mocked getblocktemplate", async () => {
  const p = new PearldProvider({ url: "http://127.0.0.1:1" });
  // Mock the RPC layer: coinbasetxn mode.
  p._rpc = async (method) => {
    assert.equal(method, "getblocktemplate");
    return {
      version: 0x20000000,
      previousblockhash: "dd".repeat(32),
      transactions: [{ hash: "bb".repeat(32), fee: 1000 }],
      coinbasetxn: { hash: "aa".repeat(32) },
      curtime: 1759000000,
      bits: "1a07fff8",
      height: 119376,
      requiredcertversion: 3,
    };
  };
  const t = await p.getTemplate(true);
  assert.equal(t.height, 119376);
  assert.equal(t.certVersion, 3);
  assert.equal(t.headerHex.length, 152);
  assert.equal(t.nbits, 0x1a07fff8);
  assert.equal(t.networkTarget, compactToTarget(0x1a07fff8));
  // Merkle root over [coinbase, tx] must appear in the header bytes (display order).
  const root = merkleRootDisplay(["aa".repeat(32), "bb".repeat(32)]);
  assert.equal(Buffer.from(t.headerHex, "hex").subarray(36, 68).toString("hex"), root);
  // coinbasevalue = subsidy + fees.
  assert.equal(t.coinbaseValueGrains, blockSubsidyGrains(119376) + 1000n);
});
