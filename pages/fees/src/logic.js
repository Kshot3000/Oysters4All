// Pearl Fees — pure fee math. No DOM, no network. Imported by the browser
// bundle (src/index.js) and by tests/logic.test.mjs under node.
//
// Unit facts (verified against upstream pearld):
//   - 1 PRL = 1e8 grains (smallest unit)
//   - pearld `getrawmempool(verbose=true)` returns { vsize, fee (in PRL), ... }
//   - MaxBlockVsize = 1_000_000 vB (node/blockchain/vsize.go)
//   - TargetTimePerBlock = 3m14s (194s) (node/chaincfg/params.go)

export const GRAINS_PER_PRL = 100_000_000;
export const BLOCK_TARGET_SECONDS = 194; // 3m14s per upstream chaincfg
export const MAX_BLOCK_VSIZE = 1_000_000; // vB, node/blockchain/vsize.go

// P2TR key-path (BIP-86) shapes, vB:
//   input: 41 vB non-witness + 16.25 vB witness (64B sig + 1B push) = 57.25 -> 57.5 used
//   output: 8 + 1 + 34 = 43 vB
//   overhead: 4 + 1 + 1 + 1 + 4 + segwit marker/flag (0.5) = ~10.5 -> 11 used
export const P2TR_INPUT_VSIZE = 57.5;
export const P2TR_OUTPUT_VSIZE = 43;
export const TX_OVERHEAD_VSIZE = 11;

/** fee rate in grains per vB */
export function feeRateGrainsPerVb(feePRL, vsize) {
  if (!(vsize > 0) || !(feePRL >= 0)) return 0;
  return (feePRL * GRAINS_PER_PRL) / vsize;
}

/** percentile of an ascending-sorted array (linear interpolation) */
export function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const rank = (p / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (rank - lo);
}

/**
 * Recommendation bands from mempool fee rates (grains/vB).
 * next   — p95 : likely in the next block
 * fast   — p75 : ~10 min
 * normal — p50 : ~1 hr
 * economy— p25 : low priority
 * floor  — minimum observed (mempool floor)
 */
export function feeRecommendations(ratesGrainsPerVb) {
  const asc = [...ratesGrainsPerVb].filter((r) => r > 0).sort((a, b) => a - b);
  if (!asc.length) return null;
  const at = (p) => Math.max(1, Math.round(percentile(asc, p)));
  return {
    next: at(95),
    fast: at(75),
    normal: at(50),
    economy: at(25),
    floor: Math.max(1, Math.round(asc[0])),
    count: asc.length,
  };
}

/** histogram buckets (log-spaced) over fee rates; returns [{lo, hi, count, vbytes}] */
export function bucketize(rates, nBuckets = 24) {
  const vals = rates.filter((r) => r > 0);
  if (!vals.length) return [];
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const lo = Math.max(1, Math.floor(min));
  const hi = Math.max(lo * 2, Math.ceil(max));
  const buckets = [];
  for (let i = 0; i < nBuckets; i++) {
    const a = lo * Math.pow(hi / lo, i / nBuckets);
    const b = lo * Math.pow(hi / lo, (i + 1) / nBuckets);
    buckets.push({ lo: a, hi: b, count: 0, vbytes: 0 });
  }
  for (const r of vals) {
    let idx = buckets.findIndex((b) => r < b.hi);
    if (idx < 0) idx = buckets.length - 1;
    buckets[idx].count += 1;
  }
  return buckets;
}

/** estimated vsize of a P2TR key-spend transaction */
export function estimateVsize(nInputs, nOutputs) {
  const nIn = Math.max(0, Math.floor(nInputs));
  const nOut = Math.max(1, Math.floor(nOutputs));
  return Math.ceil(TX_OVERHEAD_VSIZE + nIn * P2TR_INPUT_VSIZE + nOut * P2TR_OUTPUT_VSIZE);
}

/** fee for a vsize at a rate; returns { grains, prl } */
export function feeFor(vsize, rateGrainsPerVb) {
  const grains = Math.ceil(vsize * Math.max(0, rateGrainsPerVb));
  return { grains, prl: grains / GRAINS_PER_PRL };
}

/** Parse a PRL amount string into grains (Number, exact). Fleet-standard
 *  strict form — digits with an optional fraction of at most 8 decimal
 *  places, computed in BigInt and range-checked to a safe integer. This
 *  replaces the bump planner's old float parse (parseFloat +
 *  Math.round(x * 1e8)), which silently rounded a sub-grain fee like
 *  "0.000000001" PRL down to 0 grains (the old > 0 check ran on the
 *  float, before conversion, so the planner happily planned around a
 *  0-grain fee) and silently rounded fractional grains like "100.5"
 *  up to 101: rates and replacement fees were computed from an amount
 *  the user never typed. Throws on bad input. */
export function parsePRLToGrains(s) {
  if (typeof s !== "string") throw new Error("amount must be a string");
  const t = s.trim();
  const m = /^(\d+)(?:\.(\d{1,8}))?$/.exec(t);
  if (!m) throw new Error(`invalid PRL amount: ${t.slice(0, 40)}`);
  const grains = BigInt(m[1]) * BigInt(GRAINS_PER_PRL) + (m[2] ? BigInt(m[2].padEnd(8, "0")) : 0n);
  if (grains > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`PRL amount out of range: ${t.slice(0, 40)}`);
  }
  return Number(grains);
}

/** Parse the bump planner's fee field into grains (Number, exact).
 *  Unit "prl" uses parsePRLToGrains; unit "grains" accepts whole grains
 *  only — a fractional grain does not exist, so "100.5" is rejected,
 *  never rounded. Throws on bad input. */
export function parseFeeToGrains(s, unit) {
  if (unit === "prl") return parsePRLToGrains(s);
  if (unit !== "grains") throw new Error(`unknown fee unit: ${unit}`);
  if (typeof s !== "string") throw new Error("fee must be a string");
  const t = s.trim();
  if (!/^\d+$/.test(t)) throw new Error(`invalid fee in grains (whole grains only): ${t.slice(0, 40)}`);
  const grains = BigInt(t);
  if (grains > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`fee out of range: ${t.slice(0, 40)}`);
  }
  return Number(grains);
}

/** format grains with thousands separators */
export function fmtGrains(g) {
  return Math.round(g).toLocaleString("en-US");
}

/** format PRL to 8 decimals, trimming trailing zeros */
export function fmtPRL(p) {
  return p.toFixed(8).replace(/\.?0+$/, "") || "0";
}

/** short human duration for seconds */
export function fmtDuration(sec) {
  if (sec < 90) return `~${Math.round(sec)}s`;
  const m = sec / 60;
  if (m < 90) return `~${Math.round(m)} min`;
  const h = m / 60;
  if (h < 48) return `~${Math.round(h)} hr`;
  return `~${Math.round(h / 24)} days`;
}

/**
 * Rough confirmation estimate: mempool entries sorted by rate desc; cumulative
 * vbytes of everything paying strictly more than `rate` decide how many full
 * blocks sit ahead of you. Honest caveat: miners are free to order however they
 * like; this models fee-rate-priority packing.
 */
export function blocksAhead(rateGrainsPerVb, entries) {
  // entries: [{ vsize, rate }]
  let above = 0;
  for (const e of entries) {
    if (e.rate > rateGrainsPerVb) above += e.vsize;
  }
  return Math.floor(above / MAX_BLOCK_VSIZE);
}

export function etaForRate(rateGrainsPerVb, entries) {
  const blocks = blocksAhead(rateGrainsPerVb, entries);
  return { blocks, seconds: blocks * BLOCK_TARGET_SECONDS };
}

// ---------- raw transaction parsing (for the bump planner) ----------

function readVarInt(bytes, off) {
  const b = bytes[off];
  if (b < 0xfd) return [b, off + 1];
  if (b === 0xfd) return [bytes[off + 1] | (bytes[off + 2] << 8), off + 3];
  if (b === 0xfe) {
    return [
      bytes[off + 1] | (bytes[off + 2] << 8) | (bytes[off + 3] << 16) | (bytes[off + 4] << 24),
      off + 5,
    ];
  }
  let lo = 0n;
  for (let i = 0; i < 8; i++) lo |= BigInt(bytes[off + 1 + i]) << BigInt(8 * i);
  return [Number(lo), off + 9];
}

function hexToBytes(hex) {
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) throw new Error("not hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Parse a serialized transaction; compute weight/vsize locally.
 * Returns { vsize, totalBytes, baseBytes, nInputs, nOutputs, rbfSignaled, segwit }.
 * vsize = ceil((base*3 + total) / 4), the standard segwit weight formula.
 */
export function parseTxVsize(hex) {
  const bytes = hexToBytes(hex.trim());
  const total = bytes.length;
  let off = 4; // version
  if (off + 2 > total) throw new Error("tx too short");
  let segwit = false;
  if (bytes[off] === 0x00 && bytes[off + 1] === 0x01) {
    segwit = true;
    off += 2;
  }
  const baseStart = off - 4; // base serialization starts at version
  let [nIn, o] = readVarInt(bytes, off);
  off = o;
  const sequences = [];
  for (let i = 0; i < nIn; i++) {
    if (off + 36 > total) throw new Error("truncated input");
    off += 36; // prev txid + vout
    const [sl, o2] = readVarInt(bytes, off);
    off = o2 + sl; // scriptSig
    if (off + 4 > total) throw new Error("truncated sequence");
    sequences.push(
      ((bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0)
    );
    off += 4;
  }
  let [nOut, o3] = readVarInt(bytes, off);
  off = o3;
  for (let i = 0; i < nOut; i++) {
    if (off + 8 > total) throw new Error("truncated output");
    off += 8; // value
    const [sl, o4] = readVarInt(bytes, off);
    off = o4 + sl; // scriptPubKey
  }
  const baseEndNoWitness = off;
  if (segwit) {
    for (let i = 0; i < nIn; i++) {
      const [wc, o5] = readVarInt(bytes, off);
      off = o5;
      for (let w = 0; w < wc; w++) {
        const [wl, o6] = readVarInt(bytes, off);
        off = o6 + wl;
      }
    }
  }
  if (off + 4 > total) throw new Error("truncated locktime");
  off += 4; // locktime
  if (off !== total) throw new Error("trailing bytes after tx");
  const base = baseEndNoWitness - baseStart + 4; // + locktime
  const vsize = Math.ceil((base * 3 + total) / 4);
  const rbfSignaled = sequences.some((s) => s < 0xfffffffe);
  return { vsize, totalBytes: total, baseBytes: base, nInputs: nIn, nOutputs: nOut, rbfSignaled, segwit };
}

/**
 * Bump plan: given the stuck tx's vsize, the fee it paid (grains), and the
 * desired rate, compute what a replacement / CPFP child must pay.
 */
export function bumpPlan({ stuckVsize, stuckFeeGrains, targetRate }) {
  const currentRate = stuckVsize > 0 ? stuckFeeGrains / stuckVsize : 0;
  const wantFeeGrains = Math.ceil(stuckVsize * targetRate);
  const extraGrains = Math.max(0, wantFeeGrains - stuckFeeGrains);
  return {
    currentRate,
    targetRate,
    wantFeeGrains,
    wantFeePRL: wantFeeGrains / GRAINS_PER_PRL,
    extraGrains,
    extraPRL: extraGrains / GRAINS_PER_PRL,
    bumpX: stuckFeeGrains > 0 ? wantFeeGrains / stuckFeeGrains : Infinity,
  };
}

/** Baked sample mempool used when no node is connected. Clearly labeled SAMPLE. */
export function demoMempool() {
  // ~70 entries: { vsize, fee (PRL) } — representative spread, not real data.
  const rows = [];
  const push = (n, vsize, feePRL) => {
    for (let i = 0; i < n; i++) rows.push({ vsize, fee: feePRL });
  };
  push(18, 141, 0.000141); // 100 g/vB simple 1-in/2-out
  push(12, 141, 0.0000705); // 50
  push(9, 200, 0.00006); // 30
  push(8, 198, 0.0000396); // 20
  push(6, 250, 0.000025); // 10
  push(5, 315, 0.00001575); // 5
  push(4, 400, 0.000008); // 2
  push(3, 500, 0.000005); // 1
  push(2, 141, 0.000282); // 200 — urgent
  push(1, 141, 0.000705); // 500 — very urgent
  push(2, 1100, 0.000011); // 1 — big consolidation
  return rows;
}
