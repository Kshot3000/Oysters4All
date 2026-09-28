// Exact unit conversion + fee math for the wPRL bridge.
//
//   1 PRL = 1e8 grains            (upstream node/btcutil/const.go: GrainPerPearl)
//   1 wPRL = 1e18 wei             (ERC-20, 18 decimals)
//   => 1 grain = 1e10 wei         (exact, matches WPRLBridge.WEI_PER_GRAIN)
//
// All arithmetic is BigInt — never floats — so grain<->wei conversion is exact.

export const GRAINS_PER_PRL = 100_000_000n;
export const WEI_PER_WPRL = 1_000_000_000_000_000_000n;
export const WEI_PER_GRAIN = 10_000_000_000n; // 1e10, exact

/** grains (BigInt) -> wei (BigInt). Exact: wei = grains * 1e10. */
export function grainsToWei(grains) {
  const g = BigInt(grains);
  if (g < 0n) throw new RangeError("grains must be non-negative");
  return g * WEI_PER_GRAIN;
}

/** wei (BigInt) -> grains (BigInt). Truncates sub-grain dust (integer division). */
export function weiToGrains(wei) {
  const w = BigInt(wei);
  if (w < 0n) throw new RangeError("wei must be non-negative");
  return w / WEI_PER_GRAIN;
}

/**
 * 0.25% fee in basis points: fee = amount * 25 / 10000 (integer division,
 * matching the contract's `feeWei = amountWei * BRIDGE_FEE_BPS / BPS_DENOMINATOR`).
 */
export function feeOf(amount, feeBps = 25n) {
  const a = BigInt(amount);
  const b = BigInt(feeBps);
  if (a < 0n) throw new RangeError("amount must be non-negative");
  return (a * b) / 10000n;
}

/** Pearl-side deposit fee: ceil(deposit * 25 / 10000) grains — the operator
 *  rounds UP so the fee output can never be a wei under. */
export function depositFeeGrains(depositGrains, feeBps = 25n) {
  const d = BigInt(depositGrains);
  const b = BigInt(feeBps);
  if (d < 0n) throw new RangeError("deposit must be non-negative");
  return (d * b + 9999n) / 10000n;
}

/**
 * Expand scientific notation ("5e-7", "1.1e-8") into a plain decimal string.
 * JSON numbers like 0.0000005 arrive from the RPC as floats, and
 * String(0.0000005) === "5e-7" — without this, tiny real outputs would throw.
 */
function expandScientific(s) {
  const m = /^(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(s);
  if (!m) return s;
  const digits = m[1] + (m[2] ?? "");
  const pointPos = m[1].length + parseInt(m[3], 10);
  if (pointPos <= 0) return "0." + "0".repeat(-pointPos) + digits;
  if (pointPos >= digits.length) return digits + "0".repeat(pointPos - digits.length);
  return digits.slice(0, pointPos) + "." + digits.slice(pointPos);
}

/**
 * Convert a JSON-RPC decimal coin amount (e.g. 1.23456789 from
 * getrawtransaction/searchrawtransactions vout "value", denominated in PRL)
 * to exact grains. Parses the DECIMAL STRING — never goes through a float —
 * so no binary rounding error can create or destroy a grain.
 */
export function prlValueToGrains(value) {
  const s = expandScientific(String(value).trim());
  if (!/^\d+(\.\d{1,8})?$/.test(s)) {
    throw new Error(`invalid PRL coin amount: ${JSON.stringify(value)}`);
  }
  const [whole, frac = ""] = s.split(".");
  return BigInt(whole) * GRAINS_PER_PRL + BigInt(frac.padEnd(8, "0"));
}

/**
 * Convert grains to an exact PRL decimal string with 8 places, for the Oyster
 * `sendtoaddress` wallet RPC (which takes coin amounts, not grains).
 *   123456789n -> "1.23456789"
 */
export function grainsToPrlString(grains) {
  const g = BigInt(grains);
  if (g < 0n) throw new RangeError("grains must be non-negative");
  const whole = g / GRAINS_PER_PRL;
  const frac = (g % GRAINS_PER_PRL).toString().padStart(8, "0");
  return `${whole}.${frac}`;
}

/** Pearl mainnet bech32m address sanity check (mirrors the contract guard). */
export function isValidPrlAddress(addr) {
  return typeof addr === "string" && addr.length >= 8 && addr.startsWith("prl1");
}

/** EVM address sanity check. */
export function isValidEvmAddress(addr) {
  return typeof addr === "string" && /^0x[0-9a-fA-F]{40}$/.test(addr);
}
