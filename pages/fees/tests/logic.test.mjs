// Pearl Fees logic tests — run: node --test tests/logic.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GRAINS_PER_PRL, BLOCK_TARGET_SECONDS, MAX_BLOCK_VSIZE,
  feeRateGrainsPerVb, percentile, feeRecommendations, bucketize,
  estimateVsize, feeFor, fmtGrains, fmtPRL, fmtDuration,
  blocksAhead, etaForRate, parseTxVsize, bumpPlan, demoMempool,
} from "../src/logic.js";

test("protocol constants", () => {
  assert.equal(GRAINS_PER_PRL, 100_000_000);
  assert.equal(BLOCK_TARGET_SECONDS, 194);
  assert.equal(MAX_BLOCK_VSIZE, 1_000_000);
});

test("feeRateGrainsPerVb", () => {
  assert.ok(Math.abs(feeRateGrainsPerVb(0.000141, 141) - 100) < 1e-9);
  assert.equal(feeRateGrainsPerVb(0, 141), 0);
  assert.equal(feeRateGrainsPerVb(1, 0), 0);
});

test("percentile", () => {
  const a = [1, 2, 3, 4, 5];
  assert.equal(percentile(a, 0), 1);
  assert.equal(percentile(a, 100), 5);
  assert.equal(percentile(a, 50), 3);
  assert.equal(percentile([], 50), 0);
  assert.equal(percentile([7], 95), 7);
});

test("feeRecommendations bands ordered + floor >= 1", () => {
  const rec = feeRecommendations([1, 2, 5, 10, 20, 30, 50, 100, 200, 500]);
  assert.ok(rec.next >= rec.fast && rec.fast >= rec.normal && rec.normal >= rec.economy);
  assert.ok(rec.floor >= 1);
  assert.equal(feeRecommendations([]), null);
});

test("bucketize covers all values", () => {
  const b = bucketize([1, 5, 50, 500], 8);
  assert.equal(b.reduce((n, x) => n + x.count, 0), 4);
  assert.equal(bucketize([]).length, 0);
});

test("estimateVsize P2TR key-spend shapes", () => {
  // 1 in / 2 out: 11 + 57.5 + 86 = 154.5 -> 155
  assert.equal(estimateVsize(1, 2), 155);
  // 2 in / 2 out: 11 + 115 + 86 = 212
  assert.equal(estimateVsize(2, 2), 212);
  // 0 inputs clamped, outputs at least 1
  assert.equal(estimateVsize(0, 0), estimateVsize(0, 1));
});

test("feeFor math", () => {
  const f = feeFor(155, 100);
  assert.equal(f.grains, 15500);
  assert.ok(Math.abs(f.prl - 0.000155) < 1e-12);
});

test("fmtGrains / fmtPRL / fmtDuration", () => {
  assert.equal(fmtGrains(15500), "15,500");
  assert.equal(fmtPRL(0.000155), "0.000155");
  assert.equal(fmtPRL(1.5), "1.5");
  assert.ok(fmtDuration(60).includes("s"));
  assert.ok(fmtDuration(600).includes("min"));
  assert.ok(fmtDuration(7200).includes("hr"));
});

test("blocksAhead / etaForRate", () => {
  const entries = [
    { vsize: 600_000, rate: 500 },
    { vsize: 600_000, rate: 400 },
    { vsize: 100, rate: 10 },
  ];
  // 1.2MB above rate 300 -> 1 full block ahead
  assert.equal(blocksAhead(300, entries), 1);
  assert.equal(blocksAhead(600, entries), 0);
  const eta = etaForRate(300, entries);
  assert.equal(eta.seconds, 194);
});

test("parseTxVsize on a real-shaped segwit tx", () => {
  // version(4) + marker/flag + 1 in (41) + 1 out P2TR (43) + locktime(4) + witness (1 + 65)
  const hex =
    "02000000" + "0001" + "01" +
    "aa".repeat(32) + "00000000" + "00" + "ffffffff" +
    "01" + "1027000000000000" + "22" + "5120" + "bb".repeat(32) +
    "01" + "41" + "cc".repeat(65) +
    "00000000";
  const p = parseTxVsize(hex);
  assert.equal(p.nInputs, 1);
  assert.equal(p.nOutputs, 1);
  assert.equal(p.segwit, true);
  assert.equal(p.rbfSignaled, false);
  // base = 4 + 41 + 1 + 43 + 4 = 94 ; total = 163 ; vsize = ceil((94*3+163)/4) = ceil(445/4) = 112
  assert.equal(p.totalBytes, 163);
  assert.equal(p.baseBytes, 94);
  assert.equal(p.vsize, 112);
});

test("parseTxVsize detects RBF signaling", () => {
  const hex =
    "02000000" + "0001" + "01" +
    "aa".repeat(32) + "00000000" + "00" + "fdffffff" +
    "01" + "1027000000000000" + "22" + "5120" + "bb".repeat(32) +
    "01" + "41" + "cc".repeat(65) +
    "00000000";
  const p = parseTxVsize(hex);
  assert.equal(p.rbfSignaled, true);
});

test("parseTxVsize rejects garbage", () => {
  assert.throws(() => parseTxVsize("zz"), /not hex/);
  assert.throws(() => parseTxVsize("0200"), /too short/);
});

test("bumpPlan math", () => {
  const plan = bumpPlan({ stuckVsize: 155, stuckFeeGrains: 1550, targetRate: 100 });
  assert.equal(plan.currentRate, 10);
  assert.equal(plan.wantFeeGrains, 15500);
  assert.equal(plan.extraGrains, 13950);
  assert.ok(Math.abs(plan.extraPRL - 0.0001395) < 1e-12);
  assert.equal(plan.bumpX, 10);
});

test("demoMempool is labeled sample with sane rates", () => {
  const rows = demoMempool();
  assert.ok(rows.length > 20);
  const rates = rows.map((r) => feeRateGrainsPerVb(r.fee, r.vsize));
  assert.ok(Math.min(...rates) >= 1);
  assert.ok(Math.max(...rates) <= 1000);
});
