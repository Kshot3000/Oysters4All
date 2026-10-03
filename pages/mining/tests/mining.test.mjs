// Pearl Mining Calculator — emission-math tests.
// Run: node --test tests/mining.test.mjs
//
// app.js exports its pure emission core for node when no DOM is present
// (its UI wiring is guarded by `typeof document`).
//
// Vector provenance: the known-answer heights/values below are upstream's
// OWN test table — node/blockchain/emission_test.go in
// pearl-research-labs/pearl (TestEmissionSchedule), cross-checked against
// CalcBlockSubsidy in node/blockchain/validate.go:
//   subsidy(h) = totalSupply * EC / ((h + EC) * (h - 1 + EC))   [grains]
//   EC = (4*365*24*3600) / TargetTimePerBlock(194s) = 650226
//   cumulative(h) = totalSupply * h / (h + EC)
// Exact grain values were produced by the app itself AFTER the formula was
// verified against that upstream table (they agree to upstream's rounding).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const m = require("../app.js");

test("exports the emission core with upstream constants", () => {
  assert.equal(typeof m.subsidyGrains, "function");
  assert.equal(typeof m.subsidyPrl, "function");
  assert.equal(typeof m.cumulativePrl, "function");
  assert.equal(m.GRAINS_PER_PRL, 100000000n); // 1 PRL = 1e8 grains
  assert.equal(m.TOTAL_SUPPLY_GRAINS, 2100000000n * 100000000n); // 2.1B PRL cap
  assert.equal(m.EMISSION_CONSTANT, 650226n); // (4*365*24*3600)/194
  assert.equal(m.BLOCK_SECS, 194); // TargetTimePerBlock, all networks
  assert.ok(Math.abs(m.BLOCKS_PER_DAY - 86400 / 194) < 1e-12);
});

test("genesis and invalid heights pay zero (upstream: height 0 -> 0)", () => {
  assert.equal(m.subsidyGrains(0), 0n);
  assert.equal(m.subsidyGrains(-5), 0n);
  assert.equal(m.subsidyPrl(0), 0);
  assert.equal(m.cumulativePrl(0), 0);
});

test("known-answer subsidies match upstream emission_test.go exactly (grains)", () => {
  // Exact grain values; upstream's table rounds these to 3dp in PRL:
  // 3229.641 / 807.412 / 358.850 / 201.853 / 89.712 / 26.691 / 1.242
  const vectors = [
    [1, 322964134063n],
    [650226, 80741219776n],
    [1300452, 35884977369n],
    [1950678, 20185297183n],
    [3251130, 8971242042n],
    [6502260, 2669129553n],
    [32511300, 124169411n],
  ];
  for (const [h, grains] of vectors) {
    assert.equal(m.subsidyGrains(h), grains, `subsidyGrains(${h})`);
    // and agree with upstream's rounded PRL figures
    assert.equal(Number(m.subsidyPrl(h).toFixed(3)), Number((Number(grains) / 1e8).toFixed(3)));
  }
});

test("fractional heights floor to the block below (subsidy is per-block)", () => {
  assert.equal(m.subsidyGrains(1.9), m.subsidyGrains(1));
  assert.equal(m.subsidyGrains(650226.5), m.subsidyGrains(650226));
});

test("subsidy is strictly decreasing in height", () => {
  let prev = m.subsidyGrains(1);
  for (const h of [2, 10, 100, 1000, 99000, 650226, 1300452, 3251130, 32511300]) {
    const s = m.subsidyGrains(h);
    assert.ok(s < prev, `subsidy(${h}) < previous`);
    assert.ok(s > 0n, `subsidy(${h}) still positive`);
    prev = s;
  }
});

test("cumulative closed form hits upstream's milestone supplies", () => {
  // Upstream expectedCumulative, in billions of PRL.
  const vectors = [
    [650226, 1.05],   // exactly 50% of the 2.1B cap at h = EC
    [1300452, 1.40],  // 2 x EC -> 66.67%
    [1950678, 1.575], // 3 x EC -> 75%
    [3251130, 1.75],  // 5 x EC -> 83.33%
    [6502260, 1.909], // 10 x EC -> 90.91%
    [32511300, 2.059],// 50 x EC -> 98.04%
  ];
  for (const [h, billions] of vectors) {
    assert.ok(Math.abs(m.cumulativePrl(h) / 1e9 - billions) < 0.001, `cumulative(${h}) ~ ${billions}B`);
  }
  // Exact: at h = EC the closed form is precisely half the cap.
  assert.equal(m.cumulativePrl(650226), 1050000000);
});

test("per-block subsidies telescope to the closed-form cumulative supply", () => {
  // sum_{h=1..N} TOTAL*EC/((h+EC)(h-1+EC)) telescopes to TOTAL*N/(N+EC)
  // exactly in rationals; each BigInt floor loses < 1 grain, so the summed
  // subsidies trail the closed form by >= 0 and < N grains.
  const N = 100000;
  let sum = 0n;
  for (let h = 1; h <= N; h++) sum += m.subsidyGrains(h);
  const closed = (m.TOTAL_SUPPLY_GRAINS * BigInt(N)) / (BigInt(N) + m.EMISSION_CONSTANT);
  const deficit = closed - sum;
  assert.ok(deficit >= 0n, "floored sum never exceeds the closed form");
  assert.ok(deficit < BigInt(N), `deficit ${deficit} < ${N} grains (one per block max)`);
});

test("cumulative supply is bounded by the 2.1B cap and monotonic", () => {
  let prev = 0;
  for (const h of [1, 1000, 650226, 3251130, 32511300, 1e9]) {
    const c = m.cumulativePrl(h);
    assert.ok(c > prev, `cumulative(${h}) increasing`);
    assert.ok(c < 2100000000, `cumulative(${h}) below cap`);
    prev = c;
  }
});
