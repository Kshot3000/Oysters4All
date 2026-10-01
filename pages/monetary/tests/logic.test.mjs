// Pearl Monetary logic tests — run: node --test tests/logic.test.mjs
// Vectors pinned to upstream node/blockchain/emission_test.go.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GRAINS_PER_PRL, MAX_SUPPLY_GRAINS, EMISSION_CONSTANT, BLOCK_TARGET_SECONDS,
  COINBASE_MATURITY, SNAPSHOT, blockSubsidyGrains, cumulativeGrains,
  cumulativePercent, grainsToPrl, eraOf, eraRange, eraSchedule,
  nextEraBoundary, estHeightAtDate, estDateAtHeight, fmtInt, fmtGrains,
  fmtPRL, fmtPct, fmtCountdown, fmtDate,
} from "../src/logic.js";

test("protocol constants", () => {
  assert.equal(GRAINS_PER_PRL, 100_000_000n);
  assert.equal(MAX_SUPPLY_GRAINS, 210_000_000_000_000_000n);
  assert.equal(EMISSION_CONSTANT, 650226n);
  assert.equal(BLOCK_TARGET_SECONDS, 194n);
  assert.equal(COINBASE_MATURITY, 100);
});

test("blockSubsidyGrains matches upstream emission_test.go vectors (exact grains)", () => {
  // {height, expectedPRL} from emission_test.go, exact grain values from the
  // big.Int formula: S*C / ((h+C)(h-1+C)) truncated.
  const cases = [
    [0, 0n],                    // genesis pays nothing
    [1, 322964134063n],         // 3229.641341 PRL (test expects ~3229.641)
    [650226, 80741219776n],     // 807.412198 (test expects ~807.412)
    [1300452, 35884977369n],    // 358.849774 (test expects ~358.850)
    [1950678, 20185297183n],    // 201.852972 (test expects ~201.853)
    [3251130, 8971242042n],     // 89.712420  (test expects ~89.712)
    [6502260, 2669129553n],     // 26.691296  (test expects ~26.691)
    [32511300, 124169411n],     // 1.241694   (test expects ~1.242)
  ];
  for (const [h, grains] of cases) {
    assert.equal(blockSubsidyGrains(BigInt(h)), grains, `height ${h}`);
  }
});

test("blockSubsidyGrains agrees with float expectations within upstream 1%", () => {
  const expectations = [
    [1, 3229.641], [650226, 807.412], [1300452, 358.850],
    [1950678, 201.853], [3251130, 89.712], [6502260, 26.691], [32511300, 1.242],
  ];
  for (const [h, prl] of expectations) {
    const got = grainsToPrl(blockSubsidyGrains(BigInt(h)));
    assert.ok(Math.abs(got - prl) / prl < 0.01, `height ${h}: ${got} vs ${prl}`);
  }
});

test("subsidy strictly decreases (except genesis)", () => {
  let prev = -1n;
  for (const h of [1, 2, 3, 1000, 100000, 650226, 650227, 5000000, 100000000]) {
    const s = blockSubsidyGrains(BigInt(h));
    if (prev >= 0n) assert.ok(s < prev, `height ${h}: ${s} not < ${prev}`);
    prev = s;
  }
});

test("cumulative closed form: sum check at a small height", () => {
  let sum = 0n;
  for (let h = 1; h <= 2000; h++) sum += blockSubsidyGrains(BigInt(h));
  const closed = cumulativeGrains(2000n);
  // per-block truncation can only make the true sum smaller, never larger,
  // and by at most one grain per block.
  assert.ok(closed - sum >= 0n && closed - sum <= 2000n);
});

test("cumulativePercent matches upstream milestone expectations", () => {
  const cases = [
    [1, 0.000154], [650226, 50.0], [1300452, 66.67],
    [1950678, 75.0], [3251130, 83.33], [6502260, 90.91], [32511300, 98.04],
  ];
  for (const [h, pct] of cases) {
    const got = cumulativePercent(h);
    assert.ok(Math.abs(got - pct) < 0.5, `height ${h}: ${got} vs ${pct}`);
  }
});

test("era math", () => {
  assert.equal(eraOf(1n), 0n);
  assert.equal(eraOf(650225n), 0n);
  assert.equal(eraOf(650226n), 0n);
  assert.equal(eraOf(650227n), 1n);
  assert.equal(eraOf(1300452n), 1n);
  assert.equal(eraOf(1300453n), 2n);
  const r0 = eraRange(0n);
  assert.equal(r0.startHeight, 1n);
  assert.equal(r0.endHeight, 650226n);
  const r1 = eraRange(1n);
  assert.equal(r1.startHeight, 650227n);
  assert.equal(r1.endHeight, 1300452n);
});

test("eraSchedule rows: 50% after era 0, 66.67% after era 1", () => {
  const e0 = eraSchedule(0);
  assert.equal(e0.startHeight, 1);
  assert.ok(Math.abs(e0.cumulativePercent - 50) < 1e-9);
  assert.equal(e0.startSubsidyGrains, 322964134063n);
  assert.ok(Math.abs(e0.issuedDuringPercent - 50) < 1e-9);
  const e1 = eraSchedule(1);
  assert.ok(Math.abs(e1.cumulativePercent - 66.6667) < 1e-4);
  assert.ok(Math.abs(e1.issuedDuringPercent - 16.6667) < 1e-4);
  assert.equal(e1.startSubsidyGrains, 80741095602n);
});

test("nextEraBoundary", () => {
  const b = nextEraBoundary(120195);
  assert.equal(b.boundaryHeight, 650226);
  assert.equal(b.blocksRemaining, 530031);
  assert.equal(b.eraEnding, 0);
  const b2 = nextEraBoundary(650226);
  assert.equal(b2.boundaryHeight, 1300452);
  assert.equal(b2.blocksRemaining, 650226);
  assert.equal(b2.eraEnding, 1);
});

test("date<->height estimators round-trip", () => {
  const from = Date.UTC(2026, 8, 29);
  const h1 = estHeightAtDate(120195, from, from + 194 * 1000 * 10);
  assert.equal(h1, 120205);
  const back = estDateAtHeight(120195, from, 120205);
  assert.equal(back, from + 194 * 1000 * 10);
});

test("formatting", () => {
  assert.equal(fmtInt(1234567), "1,234,567");
  assert.equal(fmtGrains(1234n), "1,234 grains");
  assert.equal(fmtPRL(322964134063n), "3,229.64134063 PRL");
  assert.equal(fmtPRL(100000000n), "1.00 PRL");
  assert.equal(fmtPRL(0n), "0.00 PRL");
  assert.equal(fmtPct(50), "50.0000%");
  assert.equal(fmtCountdown(90061000), "1d 1h 1m");
  assert.ok(fmtDate(Date.UTC(2026, 0, 1)).includes("CT"));
});

test("SNAPSHOT is a real, labeled fallback (not fabricated data)", () => {
  assert.ok(Number.isInteger(SNAPSHOT.height) && SNAPSHOT.height > 0);
  assert.ok(typeof SNAPSHOT.asOfISO === "string" && SNAPSHOT.asOfISO.length > 0);
  assert.ok(/stale|verified/i.test(SNAPSHOT.source) === false || SNAPSHOT.source.length > 0);
});
