/**
 * Pearl Pulse core tests — `node --test tests/verify.mjs` (zero deps).
 * Vectors: live API payloads captured 2026-09-27/28 (blockbook
 * https://blockbook.pearlresearch.ai, CoinEx /v2/spot/ticker?market=PEARLUSDT,
 * CoinGecko /api/v3/coins/pearl-2) and bech32m vectors ported from the
 * wallet-helper's verified codec.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  GRAIN_PER_PRL,
  validatePearlAddress,
  isValidPearlAddress,
  encodeSegwitAddress,
  grainsToBigInt,
  fmtPRL,
  fmtUSD,
  grainsUsd,
  shortHash,
  shortAddress,
  timeAgo,
  parseStatusPayload,
  parseAddressPayload,
  txReceived,
  txSent,
  txNet,
  txDirection,
  parseTickerPayload,
  parseCoinGeckoPayload,
  fmtCompactUsd,
  portfolioTotal,
  fundedCount,
} from '../js/pulse-core.js';

const DONATE = 'prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d';
const PROG32 = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff);

// ---------------------------------------------------------------- address validation
test('valid mainnet P2TR address (the builder donation address)', () => {
  const info = validatePearlAddress(DONATE);
  assert.equal(info.network, 'mainnet');
  assert.equal(info.version, 1);
  assert.equal(info.program.length, 32);
  assert.equal(info.isP2TR, true);
});

test('uppercase form of a valid address is accepted', () => {
  assert.equal(isValidPearlAddress(DONATE.toUpperCase()), true);
});

test('surrounding whitespace is tolerated', () => {
  assert.equal(isValidPearlAddress('  ' + DONATE + '\n'), true);
});

test('mixed-case address is rejected', () => {
  assert.throws(() => validatePearlAddress('prl1P62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d'));
});

test('single-char checksum mutation is rejected', () => {
  const bad = DONATE.slice(0, -1) + (DONATE.endsWith('9') ? '8' : '9');
  assert.equal(isValidPearlAddress(bad), false);
});

test('witness v0 is rejected (Pearl is v1+ only)', () => {
  const v0 = encodeSegwitAddress('prl', 0, new Uint8Array(20).fill(2));
  assert.throws(() => validatePearlAddress(v0), /witness version 0/);
});

test('Bitcoin P2TR address is rejected on HRP', () => {
  const bc = encodeSegwitAddress('bc', 1, PROG32);
  assert.throws(() => validatePearlAddress(bc), /unknown Pearl HRP/);
});

test('base58 address is rejected', () => {
  assert.equal(isValidPearlAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'), false);
});

test('testnet tprl address validates', () => {
  const t = encodeSegwitAddress('tprl', 1, PROG32);
  const info = validatePearlAddress(t);
  assert.equal(info.network, 'testnet');
  assert.equal(info.isP2TR, true);
});

test('rprl v2 40-byte program validates (non-P2TR, still legal)', () => {
  const r = encodeSegwitAddress('rprl', 2, new Uint8Array(40).fill(9));
  const info = validatePearlAddress(r);
  assert.equal(info.network, 'regtest/simnet');
  assert.equal(info.isP2TR, false);
});

test('41-byte program is rejected', () => {
  const r = encodeSegwitAddress('rprl', 1, new Uint8Array(41).fill(9));
  assert.throws(() => validatePearlAddress(r), /program length/);
});

test('empty string is rejected', () => {
  assert.equal(isValidPearlAddress(''), false);
});

// ---------------------------------------------------------------- money formatting
test('fmtPRL exact vectors', () => {
  assert.equal(fmtPRL(0n), '0');
  assert.equal(fmtPRL(1n), '0.00000001');
  assert.equal(fmtPRL(GRAIN_PER_PRL), '1');
  assert.equal(fmtPRL(265588747897n), '2,655.88747897');
  assert.equal(fmtPRL('11900000'), '0.119');
  assert.equal(fmtPRL(-150000000n), '-1.5');
});

test('fmtUSD and grainsUsd', () => {
  assert.equal(fmtUSD(238.4), '$238.40');
  assert.equal(fmtUSD(NaN), '—');
  // 2,000 PRL @ $0.119 = $238.00
  assert.equal(grainsUsd(2000n * GRAIN_PER_PRL, 0.119).toFixed(2), '238.00');
});

test('shortHash / shortAddress', () => {
  assert.equal(shortHash('38e1cd18c9d663137ea348fcab574c31a'), '38e1cd18…74c31a');
  assert.equal(shortAddress(DONATE), 'prl1p62v…u3zw9d');
});

test('timeAgo', () => {
  const now = 1_789_000_000;
  assert.equal(timeAgo(now - 30, now), '30s ago');
  assert.equal(timeAgo(now - 90, now), '1m ago');
  assert.equal(timeAgo(now - 3 * 3600 - 12 * 60, now), '3h 12m ago');
  assert.equal(timeAgo(now - 2 * 86400, now), '2d 0h ago');
});

// ---------------------------------------------------------------- blockbook status
const STATUS_FIXTURE = {
  blockbook: {
    coin: 'Pearl', network: 'PRL', host: 'blockbook-0', version: 'devel',
    gitCommit: '81f52f2', buildTime: '2026-08-11T10:42:47+00:00',
    syncMode: true, initialSync: false, inSync: true, bestHeight: 120142,
    lastBlockTime: '2026-09-28T02:50:31.614380827Z', inSyncMempool: true,
    lastMempoolTime: '2026-09-28T02:56:27.324757227Z', mempoolSize: 25,
    decimals: 8, dbSize: 15888501463,
  },
  backend: { chain: 'main', blocks: 120142 },
};

test('parseStatusPayload — live fixture 2026-09-27', () => {
  const s = parseStatusPayload(STATUS_FIXTURE);
  assert.equal(s.height, 120142);
  assert.equal(s.inSync, true);
  assert.equal(s.mempoolSize, 25);
  assert.equal(s.coin, 'Pearl');
  assert.equal(s.network, 'PRL');
  assert.equal(s.decimals, 8);
  assert.equal(s.lastBlockTime, '2026-09-28T02:50:31.614380827Z');
});

test('parseStatusPayload rejects garbage', () => {
  assert.throws(() => parseStatusPayload({}), /missing blockbook/);
});

// ---------------------------------------------------------------- blockbook address
const ADDR_FIXTURE = {
  page: 1, totalPages: 225, itemsOnPage: 1, address: DONATE,
  balance: '0', totalReceived: '265588747897', totalSent: '265588747897',
  unconfirmedBalance: '0', unconfirmedTxs: 0, txs: 225,
};

test('parseAddressPayload — live fixture (donation address)', () => {
  const a = parseAddressPayload(ADDR_FIXTURE);
  assert.equal(a.address, DONATE);
  assert.equal(a.balance, 0n);
  assert.equal(a.totalReceived, 265588747897n);
  assert.equal(fmtPRL(a.totalReceived), '2,655.88747897');
  assert.equal(a.txs, 225);
  assert.deepEqual(a.transactions, []);
});

const ADDR_A = encodeSegwitAddress('prl', 1, PROG32);
const ADDR_B = encodeSegwitAddress('prl', 1, new Uint8Array(32).fill(7));
const TX_FIXTURE = {
  txid: '38e1cd18c9d663137ea348fcab574c31a36b1d1f374ceb857285e27c94533c69',
  blockHeight: 86727, confirmations: 33418, blockTime: 1784083235,
  vin: [
    { txid: 'aa', n: 0, addresses: [ADDR_B], isAddress: true, value: '50000000' },
    { txid: 'bb', n: 1, addresses: [ADDR_A], isAddress: true, value: '250000000' },
  ],
  vout: [
    { value: '100000000', n: 0, addresses: [ADDR_A], isAddress: true, spent: true },
    { value: '290000000', n: 1, addresses: [ADDR_B], isAddress: true, spent: false },
  ],
  value: '390000000', valueIn: '300000000', fees: '10000000',
};

test('tx received/sent/net/direction from the watched address POV', () => {
  assert.equal(txReceived(TX_FIXTURE, ADDR_A), 100000000n);
  assert.equal(txSent(TX_FIXTURE, ADDR_A), 250000000n);
  assert.equal(txNet(TX_FIXTURE, ADDR_A), -150000000n);
  assert.equal(txDirection(TX_FIXTURE, ADDR_A), 'moved');
  assert.equal(txDirection(TX_FIXTURE, ADDR_B), 'moved');
  assert.equal(txReceived(TX_FIXTURE, ADDR_B), 290000000n);
  assert.equal(txSent(TX_FIXTURE, ADDR_B), 50000000n);
});

test('tx direction for receive-only and send-only', () => {
  const rx = { vin: [], vout: [{ value: '1000', addresses: [ADDR_A], isAddress: true }] };
  assert.equal(txDirection(rx, ADDR_A), 'received');
  assert.equal(txDirection(rx, ADDR_B), 'unknown');
  const sx = { vin: [{ value: '1000', addresses: [ADDR_A], isAddress: true }], vout: [] };
  assert.equal(txDirection(sx, ADDR_A), 'sent');
});

// ---------------------------------------------------------------- CoinEx ticker
// Pearl (the L1) is PEARLUSDT on CoinEx — PRLUSDT is a different token.
// Fixture: real payload 2026-09-27 (last 1.41811703, open 1.30887023).
const TICKER_FIXTURE = {
  code: 0,
  data: [{
    close: '1.41811703', high: '1.50300433', last: '1.41811703',
    low: '1.2704545', market: 'PEARLUSDT', open: '1.30887023', period: 86400,
    value: '5186.49', volume: '3658.39003884',
    volume_buy: '2118.12', volume_sell: '1540.27',
  }],
  message: 'OK',
};

test('parseTickerPayload — live CoinEx PEARLUSDT fixture 2026-09-27', () => {
  const t = parseTickerPayload(TICKER_FIXTURE);
  assert.equal(t.market, 'PEARLUSDT');
  assert.equal(t.last, 1.41811703);
  assert.equal(t.high, 1.50300433);
  assert.equal(t.low, 1.2704545);
  assert.equal(t.volume, 3658.39003884);
  // (1.41811703 - 1.30887023) / 1.30887023 * 100 ≈ 8.3465
  assert.ok(Math.abs(t.changePct - 8.3465) < 1e-3, `changePct was ${t.changePct}`);
  assert.equal(t.source, 'CoinEx');
});

test('parseTickerPayload rejects error payloads', () => {
  assert.throws(() => parseTickerPayload({ code: 1, data: [], message: 'x' }), /unexpected/);
  assert.throws(() => parseTickerPayload({ code: 0, data: [{ last: '0', open: '0' }] }), /last\/open/);
});

// ---------------------------------------------------------------- CoinGecko
// Pearl (the L1) is CoinGecko id "pearl-2" (symbol PRL). Fixture: real
// /api/v3/coins/pearl-2 payload 2026-09-27.
const COINGECKO_FIXTURE = {
  id: 'pearl-2', symbol: 'prl', name: 'Pearl',
  market_data: {
    current_price: { usd: 1.41 },
    price_change_percentage_24h: -1.4059,
    high_24h: { usd: 1.74 },
    low_24h: { usd: 1.41 },
    total_volume: { usd: 4882235 },
    market_cap: { usd: 461809989 },
    market_cap_rank: 120,
    last_updated: '2026-09-28T03:06:40.000Z',
  },
};

test('parseCoinGeckoPayload — live pearl-2 fixture 2026-09-27', () => {
  const p = parseCoinGeckoPayload(COINGECKO_FIXTURE);
  assert.equal(p.market, 'PRL/USD');
  assert.equal(p.last, 1.41);
  assert.equal(p.changePct, -1.4059);
  assert.equal(p.high, 1.74);
  assert.equal(p.low, 1.41);
  assert.equal(p.volumeUsd, 4882235);
  assert.equal(p.mcapUsd, 461809989);
  assert.equal(p.mcapRank, 120);
  assert.equal(p.source, 'CoinGecko');
  assert.equal(p.coinId, 'pearl-2');
});

test('parseCoinGeckoPayload rejects payloads without a price', () => {
  assert.throws(() => parseCoinGeckoPayload({}), /market_data/);
  assert.throws(() => parseCoinGeckoPayload({ market_data: { current_price: {} } }), /USD price/);
});

test('fmtCompactUsd', () => {
  assert.equal(fmtCompactUsd(4882235), '$4.88M');
  assert.equal(fmtCompactUsd(461809989), '$461.81M');
  assert.equal(fmtCompactUsd(1500), '$1.5K');
  assert.equal(fmtCompactUsd(42), '$42.00');
  assert.equal(fmtCompactUsd(NaN), '—');
});

// ---------------------------------------------------------------- portfolio math
test('portfolioTotal and fundedCount', () => {
  const recs = [
    { balance: '265588747897' },
    { balance: 100000000n },
    { balance: '0' },
  ];
  assert.equal(portfolioTotal(recs), 265688747897n);
  assert.equal(fundedCount(recs), 2);
});

test('grainsToBigInt accepts bigint/string/number forms', () => {
  assert.equal(grainsToBigInt('42'), 42n);
  assert.equal(grainsToBigInt(42n), 42n);
});

// ------------------------------------------------- XSS hardening (app.js)
// Regression pins for the 2026-10-04 fleet XSS audit (the pool-dashboard
// bug class): Pulse renders data from a user-configurable blockbook
// backend and from localStorage into innerHTML, so every non-numeric
// interpolation must be escaped and persisted watchlist entries must be
// re-validated on load. These are source pins in the fleet dom-suite style.
const APP_JS = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const INDEX_HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('app.js defines the fleet esc() helper (& escaped first)', () => {
  assert.match(APP_JS, /function esc\(s\) \{\s*return String\(s \?\? ''\)\s*\.replace\(\/&\/g, '&amp;'\)/);
});

test('watchlist row escapes the address in title, content and data-addr', () => {
  assert.match(APP_JS, /title="\$\{esc\(w\.addr\)\}"/);
  assert.match(APP_JS, /\$\{esc\(shortAddress\(w\.addr\)\)\}/);
  assert.equal(APP_JS.match(/data-addr="\$\{esc\(w\.addr\)\}"/g)?.length, 3);
  assert.doesNotMatch(APP_JS, /data-addr="\$\{w\.addr\}"/);
});

test('watchlist load alert escapes address and error message', () => {
  assert.match(APP_JS, /Could not load \$\{esc\(shortAddress\(w\.addr\)\)\}: \$\{esc\(e\.message\)\}/);
});

test('tx row escapes backend-supplied txid and confirmations', () => {
  assert.match(APP_JS, /href="\$\{esc\(bb\('\/tx\/' \+ tx\.txid\)\)\}"/);
  assert.match(APP_JS, /\$\{esc\(shortHash\(tx\.txid\)\)\}/);
  assert.match(APP_JS, /: esc\(String\(confs\)\)\}/);
});

test('load() re-validates persisted watchlist entries (mainnet only)', () => {
  assert.match(APP_JS, /validatePearlAddress\(String\(w\.addr \?\? ''\)\)\.network === 'mainnet'/);
  assert.match(INDEX_HTML, /js\/app\.js\?v=1\.2\.1/);
});
