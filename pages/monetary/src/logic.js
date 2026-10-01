// Pearl Monetary — issuance & halving math.
// Exact port of upstream CalcBlockSubsidy from node/blockchain/validate.go:
//
//   totalSupply = 2100000000 * GrainPerPearl   (grains)
//   emissionConstant = (4*365*24*60*60) / targetTimePerBlockSeconds   (194s -> 650226)
//   if height == 0: 0
//   subsidy = floor( totalSupply * emissionConstant
//                   / ((height + emissionConstant) * (height - 1 + emissionConstant)) )
//
// Units are GRAINS (integer) everywhere; big.Int division truncates, so JS
// BigInt division (also truncating) is the exact match. Never float math.

export const GRAINS_PER_PRL = 100_000_000n;            // node/btcutil/const.go
export const MAX_SUPPLY_PRL = 2_100_000_000n;
export const MAX_SUPPLY_GRAINS = MAX_SUPPLY_PRL * GRAINS_PER_PRL; // 2.1e17
export const EMISSION_CONSTANT = 650226n;              // (4*365*86400)/194 = 650226
export const BLOCK_TARGET_SECONDS = 194n;              // 3m14s, chaincfg params.go
export const COINBASE_MATURITY = 100;                  // chaincfg params.go

// A real, dated fallback: mainnet block 120195, verified on-chain during the
// Pearl Prove build (see files/pages/README.md). Only used when the live
// Blockbook probe fails. Always labeled "stale snapshot".
export const SNAPSHOT = {
  height: 120195,
  asOfISO: "2026-09-29T00:00:00-05:00",
  source: "mainnet block 120195, verified during Pearl Prove QA",
};

/** Block subsidy in grains at a given height (exact upstream formula). */
export function blockSubsidyGrains(height) {
  const h = BigInt(height);
  if (h < 1n) return 0n; // genesis pays no subsidy (validate.go)
  const numerator = MAX_SUPPLY_GRAINS * EMISSION_CONSTANT;
  const denominator = (h + EMISSION_CONSTANT) * (h - 1n + EMISSION_CONSTANT);
  return numerator / denominator;
}

/** Cumulative issued supply in grains at a height, closed form:
 *  subsidy(h) is the exact discrete difference of S*h/(h+C), so
 *  cumulative(h) = floor(S*h/(h+C)). */
export function cumulativeGrains(height) {
  const h = BigInt(height);
  if (h < 1n) return 0n;
  return (MAX_SUPPLY_GRAINS * h) / (h + EMISSION_CONSTANT);
}

/** Percent of max supply issued at a height (float, display only). */
export function cumulativePercent(height) {
  const h = Number(height);
  return (h / (h + Number(EMISSION_CONSTANT))) * 100;
}

export function grainsToPrl(grains) {
  return Number(grains) / 1e8;
}

/** Era n covers heights (n*C, (n+1)*C] — the cumulative-percent breakpoints.
 *  Era 0 is [1, 650226], era 1 is [650227, 1300452], ... */
export function eraOf(height) {
  const h = BigInt(height);
  if (h < 1n) return 0n;
  return (h - 1n) / EMISSION_CONSTANT;
}

export function eraRange(n) {
  const nn = BigInt(n);
  return {
    era: nn,
    startHeight: nn * EMISSION_CONSTANT + 1n,
    endHeight: (nn + 1n) * EMISSION_CONSTANT,
  };
}

/** One row of the subsidy schedule table. */
export function eraSchedule(n) {
  const { era, startHeight, endHeight } = eraRange(n);
  const startSubsidy = blockSubsidyGrains(startHeight);
  const prevCumPct = cumulativePercent(endHeight - EMISSION_CONSTANT);
  const cumPct = cumulativePercent(endHeight);
  return {
    era: Number(era),
    startHeight: Number(startHeight),
    endHeight: Number(endHeight),
    startSubsidyGrains: startSubsidy,
    issuedDuringPercent: cumPct - prevCumPct,
    cumulativePercent: cumPct,
    cumulativeGrains: cumulativeGrains(endHeight),
  };
}

/** Next emission-constant boundary strictly above `height`. */
export function nextEraBoundary(height) {
  const h = BigInt(height);
  if (h < 1n) return { boundaryHeight: Number(EMISSION_CONSTANT), eraEnding: 0, blocksRemaining: Number(EMISSION_CONSTANT) };
  const nextN = h / EMISSION_CONSTANT + 1n; // h == k*C is the boundary itself -> next
  const boundary = nextN * EMISSION_CONSTANT;
  return {
    boundaryHeight: Number(boundary),
    eraEnding: Number(nextN - 1n),
    blocksRemaining: Number(boundary - h),
  };
}

/** Estimate the height at a future date, relative to a known height + date. */
export function estHeightAtDate(fromHeight, fromDateMs, targetDateMs) {
  const deltaBlocks = Math.floor((targetDateMs - fromDateMs) / (Number(BLOCK_TARGET_SECONDS) * 1000));
  return fromHeight + deltaBlocks;
}

export function estDateAtHeight(fromHeight, fromDateMs, targetHeight) {
  return fromDateMs + (targetHeight - fromHeight) * Number(BLOCK_TARGET_SECONDS) * 1000;
}

// ---------- formatting (display only) ----------
const intFmt = new Intl.NumberFormat("en-US");
export function fmtInt(n) {
  return intFmt.format(Number(n));
}
export function fmtGrains(g) {
  return intFmt.format(Number(g)) + " grains";
}
/** PRL with up to 8 decimals, trailing zeros trimmed, min 2 decimals. */
export function fmtPRL(grains) {
  const neg = grains < 0n;
  const abs = neg ? -grains : grains;
  const whole = abs / GRAINS_PER_PRL;
  const frac = (abs % GRAINS_PER_PRL).toString().padStart(8, "0").replace(/0+$/, "");
  const fracShow = frac.length < 2 ? frac.padEnd(2, "0") : frac;
  return (neg ? "-" : "") + intFmt.format(Number(whole)) + "." + fracShow + " PRL";
}
export function fmtPct(x, digits = 4) {
  return x.toFixed(digits) + "%";
}
export function fmtCountdown(ms) {
  if (ms < 0) return "past";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}
export function fmtDate(ms) {
  return new Date(ms).toLocaleString("en-US", { timeZone: "America/Chicago" }) + " CT";
}
