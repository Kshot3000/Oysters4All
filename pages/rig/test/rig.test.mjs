import test from 'node:test';
import assert from 'node:assert/strict';
import {
  blockSubsidyGrains, blockSubsidyPRL, blocksPerDay, dailyEmissionPRL,
  estimateFromYield, plan, fleetWatts,
  parseCoinGeckoPayload, parseCoinExPayload,
  fmtPRL, fmtUSD, fmtDays, fmtPct,
} from '../js/rig-core.js';

// --- Emission math: exact replica of upstream CalcBlockSubsidy ---
// Vectors from pearl-knowledge.md (verified vs node/blockchain/emission_test.go
// @ 3fe2267): h=1 ≈ 3229.64, h=650226 ≈ 807.41, h=1300452 ≈ 358.85,
// h=3251130 ≈ 89.71 PRL.

test('subsidy: genesis is 0', () => {
  assert.equal(blockSubsidyGrains(0), 0n);
  assert.equal(blockSubsidyPRL(0), 0);
});

test('subsidy: h=1 ≈ 3229.64 PRL', () => {
  const s = blockSubsidyPRL(1);
  assert.ok(Math.abs(s - 3229.64) < 0.02, `got ${s}`);
});

test('subsidy: h=650226 (emission constant) ≈ 807.41 PRL', () => {
  const s = blockSubsidyPRL(650226);
  assert.ok(Math.abs(s - 807.41) < 0.02, `got ${s}`);
});

test('subsidy: h=1300452 ≈ 358.85 PRL', () => {
  const s = blockSubsidyPRL(1300452);
  assert.ok(Math.abs(s - 358.85) < 0.05, `got ${s}`);
});

test('subsidy: h=3251130 ≈ 89.71 PRL', () => {
  const s = blockSubsidyPRL(3251130);
  assert.ok(Math.abs(s - 89.71) < 0.05, `got ${s}`);
});

test('subsidy: grains are integers and strictly decreasing', () => {
  let prev = blockSubsidyGrains(1);
  for (const h of [10, 100, 1000, 100000, 650226, 2000000]) {
    const g = blockSubsidyGrains(h);
    assert.equal(typeof g, 'bigint');
    assert.ok(g < prev, `h=${h} not decreasing`);
    prev = g;
  }
});

test('blocksPerDay: 86400/194 ≈ 445.36', () => {
  assert.ok(Math.abs(blocksPerDay() - 86400 / 194) < 1e-9);
});

test('dailyEmissionPRL: subsidy × blocks/day', () => {
  const d = dailyEmissionPRL(650226);
  assert.ok(Math.abs(d - 807.41 * (86400 / 194)) < 1, `got ${d}`);
});

// --- Yield estimate ---
test('estimateFromYield: 80 TH/s × 0.0241 = 1.928 PRL/day', () => {
  // spark-pearl-miner DUAL-MINING.md: 80 TH/s ≈ 1.85–1.94 PRL/day
  const p = estimateFromYield(80, 0.0241);
  assert.ok(Math.abs(p - 1.928) < 1e-9);
  assert.ok(p >= 1.85 && p <= 1.94, 'inside reported window');
});

test('estimateFromYield rejects bad input', () => {
  assert.throws(() => estimateFromYield(-1, 0.02));
  assert.throws(() => estimateFromYield(80, NaN));
});

// --- Plan math ---
test('plan: textbook case', () => {
  const r = plan({ prlPerDay: 2, priceUsd: 1.4, poolFeePct: 1, watts: 360, kwhRate: 0.12, capexUsd: 5000 });
  assert.ok(Math.abs(r.grossUsd - 2.8) < 1e-9);
  assert.ok(Math.abs(r.feeUsd - 0.028) < 1e-9);
  assert.ok(Math.abs(r.powerUsd - (0.36 * 24 * 0.12)) < 1e-9);
  assert.ok(Math.abs(r.netUsd - (2.8 - 0.028 - 1.0368)) < 1e-9);
  assert.ok(Math.abs(r.breakEvenDays - 5000 / r.netUsd) < 1e-6);
  assert.ok(Math.abs(r.monthlyNetUsd - r.netUsd * 30) < 1e-9);
});

test('plan: unprofitable → breakEvenDays null, margin negative', () => {
  const r = plan({ prlPerDay: 0.1, priceUsd: 0.5, poolFeePct: 0, watts: 2000, kwhRate: 0.3, capexUsd: 1000 });
  assert.ok(r.netUsd < 0);
  assert.equal(r.breakEvenDays, null);
  assert.ok(r.marginPct < 0);
});

test('plan: zero capex → breakEvenDays null even when profitable', () => {
  const r = plan({ prlPerDay: 2, priceUsd: 1.4, poolFeePct: 0, watts: 100, kwhRate: 0.1 });
  assert.ok(r.netUsd > 0);
  assert.equal(r.breakEvenDays, null);
});

test('plan rejects negatives and non-numbers', () => {
  assert.throws(() => plan({ prlPerDay: -1, priceUsd: 1 }));
  assert.throws(() => plan({ prlPerDay: 'x', priceUsd: 1 }));
});

// --- Fleet ---
test('fleetWatts sums count × wattsEach', () => {
  assert.equal(fleetWatts([{ count: 2, wattsEach: 180 }, { count: 1, wattsEach: 320 }]), 680);
  assert.equal(fleetWatts([]), 0);
});

// --- Price parsers ---
test('parseCoinGeckoPayload: happy path', () => {
  const p = parseCoinGeckoPayload({
    id: 'pearl-2',
    market_data: {
      current_price: { usd: 1.418 },
      price_change_percentage_24h: -1.87,
    },
  });
  assert.equal(p.market, 'PRL/USD');
  assert.equal(p.last, 1.418);
  assert.equal(p.source, 'CoinGecko');
});

test('parseCoinGeckoPayload rejects bad payload', () => {
  assert.throws(() => parseCoinGeckoPayload({}));
  assert.throws(() => parseCoinGeckoPayload({ market_data: { current_price: { usd: 0 } } }));
});

test('parseCoinExPayload: happy path (PEARLUSDT)', () => {
  const p = parseCoinExPayload({
    code: 0,
    data: [{ market: 'PEARLUSDT', last: '1.41811703', open: '1.45', high: '1.5', low: '1.4' }],
  });
  assert.equal(p.market, 'PEARLUSDT');
  assert.ok(Math.abs(p.last - 1.41811703) < 1e-9);
  assert.equal(p.source, 'CoinEx');
});

test('parseCoinExPayload rejects non-zero code', () => {
  assert.throws(() => parseCoinExPayload({ code: 1, data: [] }));
});

// --- Formatting ---
test('formatters do not crash on edge values', () => {
  assert.equal(fmtPRL(NaN), '—');
  assert.equal(fmtUSD(Infinity), '—');
  assert.equal(fmtDays(NaN), '—');
  assert.equal(fmtPct(NaN), '—');
  assert.ok(fmtUSD(-5).startsWith('-$'));
  assert.ok(fmtDays(400).includes('months'));
  assert.ok(fmtPct(2.5).startsWith('+'));
});
