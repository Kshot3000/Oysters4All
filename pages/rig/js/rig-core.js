/**
 * Pearl Rig — pure mining-economics core (no DOM, shared with node tests).
 *
 * Emission math is an EXACT replica of upstream `CalcBlockSubsidy`
 * (node/blockchain/validate.go @ 3fe2267, pearl-research-labs/pearl):
 *
 *   subsidy(h) = (totalSupply * emissionConstant)
 *              / ((h + emissionConstant) * (h - 1 + emissionConstant))
 *
 * in grains, with totalSupply = 2.1e9 PRL * 1e8 grains/PRL and
 * emissionConstant = 650226 (4 years of blocks at 194 s/block).
 * Upstream divides big.Ints (truncating); we do the same with BigInt.
 *
 * Price parsers:
 *  - CoinGecko /api/v3/coins/pearl-2 (PRL/USD, aggregated, CORS-open)
 *  - CoinEx /v2/spot/ticker?market=PEARLUSDT — Pearl (the L1) is PEARLUSDT,
 *    NOT PRLUSDT (a different token). Verified 2026-09-27.
 */

export const GRAINS_PER_PRL = 1e8;
export const EMISSION_CONSTANT = 650226;
export const TARGET_BLOCK_SEC = 194;
export const COINBASE_MATURITY = 100;

const TOTAL_SUPPLY_GRAINS = 2100000000n * 100000000n;
const EC = 650226n;

/** Block subsidy in grains (integer), exact replica of upstream. */
export function blockSubsidyGrains(height) {
  const h = BigInt(Math.trunc(Number(height)));
  if (h <= 0n) return 0n;
  const num = TOTAL_SUPPLY_GRAINS * EC;
  const den = (h + EC) * (h - 1n + EC);
  return num / den; // truncating, like Go big.Int.Div on positives
}

/** Block subsidy in PRL (float). */
export function blockSubsidyPRL(height) {
  return Number(blockSubsidyGrains(height)) / GRAINS_PER_PRL;
}

/** Expected blocks per day at the 194 s target. */
export function blocksPerDay() {
  return 86400 / TARGET_BLOCK_SEC;
}

/** Whole-network gross emission per day in PRL at a given height. */
export function dailyEmissionPRL(height) {
  return blockSubsidyPRL(height) * blocksPerDay();
}

/**
 * Estimate gross PRL/day from a credited hashrate using a community-reported
 * yield factor (PRL per TH/s per day). The factor drifts with network
 * difficulty and subsidy — it is a labeled snapshot, not a protocol constant.
 */
export function estimateFromYield(creditedTHs, prlPerThPerDay) {
  const r = Number(creditedTHs);
  const y = Number(prlPerThPerDay);
  if (!Number.isFinite(r) || r < 0) throw new Error('credited TH/s must be a non-negative number');
  if (!Number.isFinite(y) || y < 0) throw new Error('yield factor must be a non-negative number');
  return r * y;
}

/**
 * Full profitability plan. All money figures in USD/day unless noted.
 * Returns { grossPrlDay, grossUsd, feeUsd, powerUsd, netUsd, marginPct,
 *           monthlyNetUsd, yearlyNetUsd, breakEvenDays }.
 */
export function plan(o) {
  const prlDay = num(o.prlPerDay, 'prlPerDay');
  const price = num(o.priceUsd, 'priceUsd');
  const feePct = num(o.poolFeePct ?? 0, 'poolFeePct');
  const watts = num(o.watts ?? 0, 'watts');
  const kwh = num(o.kwhRate ?? 0, 'kwhRate');
  const capex = num(o.capexUsd ?? 0, 'capexUsd');
  if (prlDay < 0 || price < 0 || feePct < 0 || watts < 0 || kwh < 0 || capex < 0) {
    throw new Error('plan inputs must be non-negative numbers');
  }
  const grossUsd = prlDay * price;
  const feeUsd = grossUsd * (feePct / 100);
  const powerUsd = (watts / 1000) * 24 * kwh;
  const netUsd = grossUsd - feeUsd - powerUsd;
  const marginPct = grossUsd > 0 ? (netUsd / grossUsd) * 100 : null;
  return {
    grossPrlDay: prlDay,
    grossUsd,
    feeUsd,
    powerUsd,
    netUsd,
    marginPct,
    monthlyNetUsd: netUsd * 30,
    yearlyNetUsd: netUsd * 365,
    breakEvenDays: netUsd > 0 && capex > 0 ? capex / netUsd : null,
  };
}

function num(v, name) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(name + ' must be a finite number');
  return n;
}

/** Total wall power of a fleet: [{count, wattsEach}]. */
export function fleetWatts(entries) {
  return entries.reduce((sum, e) => sum + num(e.count ?? 0, 'count') * num(e.wattsEach ?? 0, 'wattsEach'), 0);
}

/** Parse CoinGecko /api/v3/coins/pearl-2 → {market, last, changePct, source}. */
export function parseCoinGeckoPayload(j) {
  const md = j && j.market_data;
  if (!md) throw new Error('missing market_data in CoinGecko payload');
  const last = Number(md.current_price && md.current_price.usd);
  if (!Number.isFinite(last) || last <= 0) {
    throw new Error('CoinGecko payload missing a usable USD price');
  }
  const chg = Number(md.price_change_percentage_24h);
  return {
    market: 'PRL/USD',
    last,
    changePct: Number.isFinite(chg) ? chg : null,
    source: 'CoinGecko',
    coinId: (j && j.id) || 'pearl-2',
  };
}

/** Parse CoinEx /v2/spot/ticker?market=PEARLUSDT → {market, last, changePct, source}. */
export function parseCoinExPayload(j) {
  if (!j || j.code !== 0 || !Array.isArray(j.data) || j.data.length === 0) {
    throw new Error('unexpected CoinEx ticker payload (code != 0 or empty data)');
  }
  const t = j.data[0];
  const last = Number(t.last);
  const open = Number(t.open);
  if (!Number.isFinite(last) || !Number.isFinite(open) || open === 0) {
    throw new Error('ticker missing numeric last/open');
  }
  return {
    market: t.market || 'PEARLUSDT',
    last,
    changePct: ((last - open) / open) * 100,
    source: 'CoinEx',
  };
}

/** Formatting helpers. */
export function fmtPRL(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString('en-US', { maximumFractionDigits: 4 }) + ' PRL';
}
export function fmtUSD(n, digits = 2) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  const sign = v < 0 ? '-' : '';
  return sign + '$' + Math.abs(v).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}
export function fmtDays(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  if (v < 90) return v.toFixed(0) + ' days';
  if (v < 730) return (v / 30.44).toFixed(1) + ' months';
  return (v / 365.25).toFixed(1) + ' years';
}
export function fmtPct(n, digits = 1) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return (v >= 0 ? '+' : '') + v.toFixed(digits) + '%';
}
export function timeAgo(iso) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '—';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return Math.floor(s) + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}
