/**
 * Pearl Pulse — pure core logic (no DOM, no network).
 *
 * Shared between the browser UI (js/app.js) and the node test suite
 * (tests/verify.mjs). Protocol facts verified against the Pearl builder
 * knowledge base + upstream `node/btcutil/address.go` `decodeSegWitAddress`:
 * Pearl addresses are bech32m (BIP-350), witness version 1..16 only —
 * witness v0 is rejected.
 *
 * 1 PRL = 100_000_000 grains.
 */

export const GRAIN_PER_PRL = 100000000n;

export const PEARL_NETWORKS = {
  prl: 'mainnet',
  tprl: 'testnet',
  rprl: 'regtest/simnet',
};

// ---------------------------------------------------------------------------
// bech32 / bech32m codec (BIP-173 / BIP-350), ported from the wallet-helper
// TypeScript implementation (itself verified against upstream test vectors)
// ---------------------------------------------------------------------------

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32_CONST = 1;
const BECH32M_CONST = 0x2bc830a3;

function polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((b >>> i) & 1) chk ^= GEN[i];
    }
  }
  return chk >>> 0;
}

function hrpExpand(hrp) {
  const out = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >>> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

function verifyChecksum(hrp, data) {
  const pm = polymod([...hrpExpand(hrp), ...data]);
  if (pm === BECH32_CONST) return 'bech32';
  if (pm === BECH32M_CONST) return 'bech32m';
  return null;
}

function createChecksum(hrp, data, variant) {
  const pm = polymod([...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^
    (variant === 'bech32m' ? BECH32M_CONST : BECH32_CONST);
  const out = [];
  for (let i = 0; i < 6; i++) out.push((pm >>> (5 * (5 - i))) & 31);
  return out;
}

export function convertBits(data, from, to, pad) {
  let acc = 0;
  let bits = 0;
  const out = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    if (value < 0 || value >> from !== 0) return null;
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >>> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv) !== 0) {
    return null;
  }
  return Uint8Array.from(out);
}

/** Encode a segwit address (bech32m). Handy for generating test vectors. */
export function encodeSegwitAddress(hrp, version, program) {
  if (version < 0 || version > 16) throw new Error(`invalid witness version ${version}`);
  const data5 = convertBits(program, 8, 5, true);
  if (!data5) throw new Error('convertBits failed');
  const data = [version, ...data5];
  const checksum = createChecksum(hrp.toLowerCase(), data, 'bech32m');
  return hrp.toLowerCase() + '1' + [...data, ...checksum].map((d) => CHARSET[d]).join('');
}

/** Decode a segwit address without enforcing Pearl policy. Throws on failure. */
export function decodeSegwitAddress(address) {
  const addr = address.toLowerCase();
  if (address !== address.toLowerCase() && address !== address.toUpperCase()) {
    throw new Error('mixed-case address');
  }
  const pos = addr.lastIndexOf('1');
  if (pos < 1 || pos + 7 > addr.length || addr.length > 90) {
    throw new Error('invalid bech32 string');
  }
  const hrp = addr.slice(0, pos);
  const data = [];
  for (const c of addr.slice(pos + 1)) {
    const d = CHARSET.indexOf(c);
    if (d === -1) throw new Error(`invalid bech32 character "${c}"`);
    data.push(d);
  }
  const variant = verifyChecksum(hrp, data);
  if (!variant) throw new Error('invalid checksum');
  const payload = data.slice(0, -6);
  if (payload.length < 1) throw new Error('no witness version');
  const version = payload[0];
  const program = convertBits(Uint8Array.from(payload.slice(1)), 5, 8, false);
  if (!program) throw new Error('invalid witness program padding');
  return { hrp, variant, version, program };
}

/**
 * Validate a Pearl address exactly like upstream `decodeSegWitAddress`
 * (node/btcutil/address.go): bech32m only, witness version 1..16, witness
 * program 2..40 bytes, HRP prl / tprl / rprl. Returns decoded info; throws
 * with a human-readable reason otherwise.
 */
export function validatePearlAddress(address) {
  const trimmed = String(address).trim();
  const decoded = decodeSegwitAddress(trimmed);
  if (decoded.variant !== 'bech32m') {
    throw new Error(`invalid checksum: Pearl addresses are bech32m-encoded (witness v1+)`);
  }
  if (decoded.version === 0 || decoded.version > 16) {
    throw new Error(`unsupported witness version ${decoded.version} (Pearl only supports v1+)`);
  }
  if (decoded.program.length < 2 || decoded.program.length > 40) {
    throw new Error(`invalid witness program length ${decoded.program.length} (expected 2..40 bytes)`);
  }
  const network = PEARL_NETWORKS[decoded.hrp];
  if (!network) {
    throw new Error(`unknown Pearl HRP "${decoded.hrp}" (expected prl, tprl, or rprl)`);
  }
  return {
    ...decoded,
    network,
    isP2TR: decoded.version === 1 && decoded.program.length === 32,
  };
}

export function isValidPearlAddress(address) {
  try {
    validatePearlAddress(address);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Money formatting
// ---------------------------------------------------------------------------

export function grainsToBigInt(g) {
  if (typeof g === 'bigint') return g;
  return BigInt(String(g));
}

/**
 * Format a grain amount as PRL with up to 8 decimals, trailing zeros
 * trimmed, thousands separators on the integer part. Accepts
 * bigint | string | number (numbers are truncated — pass bigint for
 * exactness).
 */
export function fmtPRL(grains) {
  const g = typeof grains === 'number' ? BigInt(Math.trunc(grains)) : grainsToBigInt(grains);
  const sign = g < 0n ? '-' : '';
  const abs = g < 0n ? -g : g;
  const int = abs / GRAIN_PER_PRL;
  let frac = (abs % GRAIN_PER_PRL).toString().padStart(8, '0').replace(/0+$/, '');
  const intStr = int.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return sign + intStr + (frac ? '.' + frac : '');
}

/** Format a number as USD with 2 decimals. */
export function fmtUSD(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** USD value of a grain balance at a given PRL price. */
export function grainsUsd(grains, priceUsd) {
  const g = grainsToBigInt(grains);
  return (Number(g) / 1e8) * Number(priceUsd);
}

/** "38e1cd…" style short hash. */
export function shortHash(h, head = 8, tail = 6) {
  const s = String(h);
  if (s.length <= head + tail + 1) return s;
  return s.slice(0, head) + '…' + s.slice(-tail);
}

/** Compact address label: "prl1p62v…u3zw9d". */
export function shortAddress(addr) {
  const s = String(addr);
  if (s.length <= 20) return s;
  return s.slice(0, 8) + '…' + s.slice(-6);
}

/** Human "3h 12m ago" from unix seconds. */
export function timeAgo(tsSec, nowSec = Math.floor(Date.now() / 1000)) {
  const d = nowSec - Number(tsSec);
  if (d < 0) return 'in the future';
  if (d < 60) return `${d}s ago`;
  const m = Math.floor(d / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m ago`;
  const days = Math.floor(h / 24);
  return `${days}d ${h % 24}h ago`;
}

// ---------------------------------------------------------------------------
// Blockbook payload parsing (https://blockbook.pearlresearch.ai, Trezor fork)
// ---------------------------------------------------------------------------

/**
 * Parse /api/v2/status → {height, inSync, syncing, mempoolSize, lastBlockTime,
 * lastMempoolTime, coin, network, decimals, version}
 */
export function parseStatusPayload(j) {
  const b = j && j.blockbook;
  if (!b) throw new Error('missing blockbook section in status payload');
  return {
    height: Number(b.bestHeight),
    inSync: !!b.inSync,
    syncing: !!b.syncMode,
    initialSync: !!b.initialSync,
    mempoolSize: Number(b.mempoolSize || 0),
    lastBlockTime: b.lastBlockTime || null,
    lastMempoolTime: b.lastMempoolTime || null,
    coin: b.coin || 'Pearl',
    network: b.network || 'PRL',
    decimals: Number(b.decimals ?? 8),
    version: [b.version, b.gitCommit ? b.gitCommit.slice(0, 7) : null].filter(Boolean).join(' @ ') || '—',
  };
}

/**
 * Parse /api/v2/address/<addr> (details=basic|txs) → normalized record.
 */
export function parseAddressPayload(j) {
  if (!j || typeof j.address !== 'string') throw new Error('missing address in payload');
  const rec = {
    address: j.address,
    balance: grainsToBigInt(j.balance ?? 0),
    totalReceived: grainsToBigInt(j.totalReceived ?? 0),
    totalSent: grainsToBigInt(j.totalSent ?? 0),
    unconfirmedBalance: grainsToBigInt(j.unconfirmedBalance ?? 0),
    unconfirmedTxs: Number(j.unconfirmedTxs ?? 0),
    txs: Number(j.txs ?? 0),
    transactions: Array.isArray(j.transactions) ? j.transactions : [],
    page: Number(j.page ?? 1),
    totalPages: Number(j.totalPages ?? 1),
  };
  return rec;
}

function vinAddresses(vin) {
  return (vin && Array.isArray(vin.addresses)) ? vin.addresses : [];
}

function voutAddresses(vout) {
  return (vout && Array.isArray(vout.addresses)) ? vout.addresses : [];
}

/** Grains the watched address RECEIVED in this tx (sum of its vout outputs). */
export function txReceived(tx, address) {
  let sum = 0n;
  for (const o of tx.vout || []) {
    if (voutAddresses(o).includes(address)) sum += grainsToBigInt(o.value ?? 0);
  }
  return sum;
}

/** Grains the watched address SPENT in this tx (sum of its vin inputs). */
export function txSent(tx, address) {
  let sum = 0n;
  for (const i of tx.vin || []) {
    if (vinAddresses(i).includes(address)) sum += grainsToBigInt(i.value ?? 0);
  }
  return sum;
}

/** Net change for the address in this tx (received - sent). */
export function txNet(tx, address) {
  return txReceived(tx, address) - txSent(tx, address);
}

/** "received" | "sent" | "moved" | "unknown" from the address's point of view. */
export function txDirection(tx, address) {
  const r = txReceived(tx, address);
  const s = txSent(tx, address);
  if (r > 0n && s === 0n) return 'received';
  if (s > 0n && r === 0n) return 'sent';
  if (r > 0n || s > 0n) return 'moved';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// CoinEx ticker parsing (public, unauthenticated: /v2/spot/ticker?market=PEARLUSDT)
// ---------------------------------------------------------------------------

/**
 * Parse CoinEx v2 ticker payload → {market, last, open, high, low, volume,
 * value, changePct, source}.
 * NOTE: Pearl (the L1) trades on CoinEx as PEARLUSDT — PRLUSDT is a different
 * token. Verified 2026-09-27: PEARLUSDT last $1.418 vs PRLUSDT $0.119.
 */
export function parseTickerPayload(j) {
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
    market: t.market || 'PRLUSDT',
    last,
    open,
    high: Number(t.high),
    low: Number(t.low),
    volume: Number(t.volume),
    value: Number(t.value),
    volumeBuy: Number(t.volume_buy),
    volumeSell: Number(t.volume_sell),
    changePct: ((last - open) / open) * 100,
    source: 'CoinEx',
  };
}

/**
 * Parse CoinGecko /api/v3/coins/{id} (CORS-open, aggregated spot price) →
 * {market, last, changePct, high, low, volumeUsd, mcapUsd, mcapRank,
 *  lastUpdated, source, coinId}.
 * Pearl (the L1) is CoinGecko id "pearl-2" (symbol PRL) — NOT the unrelated
 * tokens that share the name.
 */
export function parseCoinGeckoPayload(j) {
  const md = j && j.market_data;
  if (!md) throw new Error('missing market_data in CoinGecko payload');
  const last = Number(md.current_price && md.current_price.usd);
  if (!Number.isFinite(last) || last <= 0) {
    throw new Error('CoinGecko payload missing a usable USD price');
  }
  const num = (o, k) => (o && Number.isFinite(Number(o[k])) ? Number(o[k]) : null);
  return {
    market: 'PRL/USD',
    last,
    changePct: num(md, 'price_change_percentage_24h'),
    high: num(md.high_24h, 'usd'),
    low: num(md.low_24h, 'usd'),
    volumeUsd: num(md.total_volume, 'usd'),
    mcapUsd: num(md.market_cap, 'usd'),
    mcapRank: md.market_cap_rank ?? null,
    lastUpdated: md.last_updated || null,
    source: 'CoinGecko',
    coinId: j.id || 'pearl-2',
  };
}

/** Compact USD: 4882235 -> "$4.88M". */
export function fmtCompactUsd(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
  return '$' + v.toFixed(2);
}

// ---------------------------------------------------------------------------
// Portfolio aggregation
// ---------------------------------------------------------------------------

/** Sum of balances (grains, bigint) across watched address records. */
export function portfolioTotal(records) {
  let sum = 0n;
  for (const r of records) sum += grainsToBigInt(r.balance ?? 0);
  return sum;
}

/** Number of watched addresses with a nonzero balance. */
export function fundedCount(records) {
  return records.filter((r) => grainsToBigInt(r.balance ?? 0) > 0n).length;
}
