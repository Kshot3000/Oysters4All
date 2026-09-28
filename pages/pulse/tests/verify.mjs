/**
 * Pearl Pulse core tests — `node --test tests/verify.mjs` (zero deps).
 * Vectors: live API payloads captured 2026-09-27 (blockbook
 * https://blockbook.pearlresearch.ai, CoinEx /v2/spot/ticker?market=PRLUSDT)
 * and bech32m vectors ported from the wallet-helper's verified codec.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
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
const TICKER_FIXTURE = {
  code: 0,
  data: [{
    close: '0.119', high: '0.125607', last: '0.119', low: '0.118999',
    market: 'PRLUSDT', open: '0.122', period: 86400,
    value: '2468.66539790194772', volume: '20561.93671831',
    volume_buy: '17107.06761112', volume_sell: '2118.12211005',
  }],
  message: 'OK',
};

test('parseTickerPayload — live CoinEx fixture 2026-09-27', () => {
  const t = parseTickerPayload(TICKER_FIXTURE);
  assert.equal(t.market, 'PRLUSDT');
  assert.equal(t.last, 0.119);
  assert.equal(t.high, 0.125607);
  assert.equal(t.low, 0.118999);
  assert.equal(t.volume, 20561.93671831);
  // (0.119 - 0.122) / 0.122 * 100 ≈ -2.459016
  assert.ok(Math.abs(t.changePct - -2.459016) < 1e-6, `changePct was ${t.changePct}`);
  assert.equal(t.source, 'CoinEx');
});

test('parseTickerPayload rejects error payloads', () => {
  assert.throws(() => parseTickerPayload({ code: 1, data: [], message: 'x' }), /unexpected/);
  assert.throws(() => parseTickerPayload({ code: 0, data: [{ last: '0', open: '0' }] }), /last\/open/);
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
