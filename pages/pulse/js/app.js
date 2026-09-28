/**
 * Pearl Pulse UI — watch-only PRL portfolio + network dashboard.
 *
 * Data sources (all GET, read-only, unauthenticated):
 *  - blockbook.pearlresearch.ai/api/v2  — chain status, address balances, txs
 *  - api.coingecko.com/api/v3/coins/pearl-2 — PRL/USD price (default, CORS-open)
 *  - api.coinex.com/v2/spot/ticker?market=PEARLUSDT — alternate price (needs proxy)
 * Addresses stored in localStorage only. Nothing here signs or broadcasts.
 */
import {
  validatePearlAddress,
  fmtPRL, fmtUSD, grainsUsd, fmtCompactUsd,
  shortHash, shortAddress, timeAgo,
  parseStatusPayload, parseAddressPayload,
  txReceived, txSent, txNet, txDirection,
  parseTickerPayload, parseCoinGeckoPayload,
  portfolioTotal, fundedCount,
} from './pulse-core.js';

const LS_KEY = 'pearlPulse.v1';
const DONATE = 'prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d';
const PROXY_HINT = 'Browsers block cross-origin reads to this API (it sends no CORS headers). ' +
  'For full live data, run the bundled proxy — `node proxy.mjs` in the pages/pulse folder — ' +
  'then set the blockbook base URL in Settings to http://127.0.0.1:8787/blockbook.';

const DEFAULTS = {
  watchlist: [], // [{addr, label, addedAt}]
  settings: {
    blockbook: 'https://blockbook.pearlresearch.ai',
    priceSource: 'coingecko', // 'coingecko' | 'coinex'
    coingecko: 'https://api.coingecko.com',
    coinex: 'https://api.coinex.com',
    refreshSec: 120,
    demo: false,
  },
  cache: {}, // addr -> last parseAddressPayload-shaped record (plain)
};

let state = load();
let lastPrice = null;
let lastPriceAt = null;
let refreshTimer = null;

function load() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return structuredClone(DEFAULTS);
    const s = JSON.parse(raw);
    return {
      watchlist: Array.isArray(s.watchlist) ? s.watchlist : [],
      settings: { ...DEFAULTS.settings, ...(s.settings || {}) },
      cache: s.cache && typeof s.cache === 'object' ? s.cache : {},
    };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

function save() {
  try {
    // store balances as strings so JSON round-trips bigint safely
    const cache = {};
    for (const [k, v] of Object.entries(state.cache)) {
      cache[k] = {
        ...v,
        balance: String(v.balance ?? 0),
        totalReceived: String(v.totalReceived ?? 0),
        totalSent: String(v.totalSent ?? 0),
        unconfirmedBalance: String(v.unconfirmedBalance ?? 0),
        transactions: [],
      };
    }
    localStorage.setItem(LS_KEY, JSON.stringify({ ...state, cache }));
  } catch { /* storage full/blocked — non-fatal */ }
}

const $ = (id) => document.getElementById(id);

function alert(id, kind, html) {
  let el = document.getElementById('alert-' + id);
  if (!el) {
    el = document.createElement('div');
    el.id = 'alert-' + id;
    $('alerts').appendChild(el);
  }
  el.className = 'alert ' + kind;
  el.innerHTML = html;
}
function clearAlert(id) {
  const el = document.getElementById('alert-' + id);
  if (el) el.remove();
}

async function fetchJSON(url, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function bb(path) {
  return state.settings.blockbook.replace(/\/+$/, '') + path;
}
function demoTag() {
  return state.settings.demo ? '<span class="demo-tag">demo data</span>' : '';
}
function fetchedNow(el, label) {
  el.textContent = `${label} · ${new Date().toLocaleTimeString()}${state.settings.demo ? ' (demo)' : ''}`;
}

// ---------------------------------------------------------------- network card
async function loadNetwork() {
  const errEl = $('net-err');
  errEl.classList.add('hidden');
  try {
    const s = parseStatusPayload(await fetchJSON(bb('/api/v2/status')));
    $('net-height').textContent = Number(s.height).toLocaleString('en-US');
    const syncEl = $('net-sync');
    if (s.inSync) {
      syncEl.innerHTML = '<span class="up">● in sync</span>' + demoTag();
    } else {
      syncEl.innerHTML = '<span class="down">● syncing</span>' + demoTag();
    }
    $('net-mempool').textContent = Number(s.mempoolSize).toLocaleString('en-US');
    $('net-lastblock').textContent = s.lastBlockTime
      ? timeAgo(Math.floor(new Date(s.lastBlockTime).getTime() / 1000))
      : '—';
    $('net-version').textContent = s.version;
    $('network-src').textContent = 'blockbook';
    fetchedNow($('net-fetched'), 'blockbook /api/v2/status');
    clearAlert('net');
  } catch (e) {
    errEl.textContent = 'Chain status unavailable: ' + e.message + '. ' + PROXY_HINT;
    errEl.classList.remove('hidden');
    alert('net', 'warn', '⚠ Could not reach the blockbook API — network card is stale. ' + PROXY_HINT);
  }
}

// ---------------------------------------------------------------- market card
async function loadMarket() {
  const errEl = $('market-err');
  errEl.classList.add('hidden');
  try {
    let view;
    if (state.settings.priceSource === 'coinex') {
      // Pearl (the L1) is PEARLUSDT on CoinEx — PRLUSDT is a different token.
      const t = parseTickerPayload(
        await fetchJSON(`${state.settings.coinex.replace(/\/+$/, '')}/v2/spot/ticker?market=PEARLUSDT`)
      );
      view = {
        last: t.last, changePct: t.changePct,
        highText: '$' + Number(t.high).toFixed(4), lowText: '$' + Number(t.low).toFixed(4),
        volText: Number(t.volume).toLocaleString('en-US', { maximumFractionDigits: 0 }) + ' PRL',
        src: 'CoinEx PEARLUSDT', fetched: 'CoinEx /v2/spot/ticker?market=PEARLUSDT',
      };
    } else {
      // Default: CoinGecko aggregates across exchanges and is CORS-open, so it
      // works directly in the browser. Pearl (the L1) is id "pearl-2".
      const p = parseCoinGeckoPayload(
        await fetchJSON(`${state.settings.coingecko.replace(/\/+$/, '')}/api/v3/coins/pearl-2?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=false`)
      );
      view = {
        last: p.last, changePct: p.changePct,
        highText: p.high !== null ? '$' + p.high.toFixed(2) : '—',
        lowText: p.low !== null ? '$' + p.low.toFixed(2) : '—',
        volText: fmtCompactUsd(p.volumeUsd) + ' (24h)',
        src: 'CoinGecko · PRL/USD' + (p.mcapRank ? ` · mcap #${p.mcapRank}` : ''),
        fetched: 'CoinGecko /api/v3/coins/pearl-2',
      };
    }
    lastPrice = view.last;
    lastPriceAt = new Date();
    $('market-last').textContent = '$' + view.last.toLocaleString('en-US', { maximumFractionDigits: 6 });
    const chg = $('market-change');
    const cls = view.changePct >= 0 ? 'up' : 'down';
    const arrow = view.changePct >= 0 ? '▲' : '▼';
    chg.innerHTML = `<span class="${cls}">${arrow} ${Math.abs(view.changePct).toFixed(2)}%</span> 24h` + demoTag();
    $('market-high').textContent = view.highText;
    $('market-low').textContent = view.lowText;
    $('market-vol').textContent = view.volText;
    $('market-src').textContent = view.src;
    fetchedNow($('market-fetched'), view.fetched);
    clearAlert('mkt');
  } catch (e) {
    errEl.textContent = 'Price unavailable: ' + e.message + '. Portfolio USD values are paused.';
    errEl.classList.remove('hidden');
    lastPrice = null;
    alert('mkt', 'warn', '⚠ Could not reach the price feed — price card is stale. Try the other price source in Settings.');
  }
}

// ---------------------------------------------------------------- watchlist
function recordFor(addr) {
  return state.cache[addr] || null;
}

async function loadWatchlist() {
  const body = $('watch-body');
  const recs = [];
  for (const w of state.watchlist) {
    let rec = recordFor(w.addr);
    try {
      rec = parseAddressPayload(await fetchJSON(bb(`/api/v2/address/${w.addr}?details=basic`)));
      state.cache[w.addr] = rec;
      clearAlert('addr-' + w.addr.slice(0, 12));
    } catch (e) {
      if (!rec) {
        alert('addr-' + w.addr.slice(0, 12), 'warn',
          `⚠ Could not load ${shortAddress(w.addr)}: ${e.message}. ${PROXY_HINT}`);
      }
    }
    recs.push({ w, rec });
  }
  save();
  renderWatchlist(recs);
  renderPortfolio(recs);
}

function renderWatchlist(recs) {
  const body = $('watch-body');
  if (recs.length === 0) {
    body.innerHTML = '<tr class="empty-row"><td colspan="7">No addresses watched yet — add one above.</td></tr>';
    return;
  }
  body.innerHTML = '';
  for (const { w, rec } of recs) {
    const tr = document.createElement('tr');
    const bal = rec ? rec.balance : null;
    const usd = bal !== null && lastPrice !== null ? fmtUSD(grainsUsd(bal, lastPrice)) : '—';
    tr.innerHTML = `
      <td class="addr-cell" title="${w.addr}">${shortAddress(w.addr)}
        ${w.label ? `<span class="lbl"></span>` : ''}</td>
      <td class="num">${bal === null ? '—' : fmtPRL(bal) + ' PRL'}</td>
      <td class="num">${usd}</td>
      <td class="num">${rec ? Number(rec.txs).toLocaleString('en-US') : '—'}</td>
      <td class="num">${rec ? fmtPRL(rec.totalReceived) : '—'}</td>
      <td class="num">${rec ? fmtPRL(rec.totalSent) : '—'}</td>
      <td class="row-actions">
        <button class="link-btn" data-act="txs" data-addr="${w.addr}">txs</button>
        <button class="link-btn" data-act="open" data-addr="${w.addr}">open ↗</button>
        <button class="link-btn" data-act="rm" data-addr="${w.addr}">remove</button>
      </td>`;
    if (w.label) tr.querySelector('.lbl').textContent = w.label;
    body.appendChild(tr);
  }
}

function renderPortfolio(recs) {
  const funded = recs.filter((r) => r.rec).map((r) => r.rec);
  const total = portfolioTotal(funded);
  $('networth-prl').innerHTML = fmtPRL(total) + ' <span style="font-size:18px;color:var(--muted)">PRL</span>' + demoTag();
  $('networth-usd').textContent = lastPrice !== null ? fmtUSD(grainsUsd(total, lastPrice)) + ' @ $' + lastPrice : 'price unavailable';
  $('stat-watched').textContent = String(state.watchlist.length);
  $('stat-funded').textContent = String(fundedCount(funded));
  $('stat-txs').textContent = funded.length
    ? funded.reduce((a, r) => a + Number(r.txs || 0), 0).toLocaleString('en-US')
    : '—';
  $('networth-src').textContent = state.watchlist.length ? 'Σ watched balances' : 'add addresses below';
}

// ---------------------------------------------------------------- tx panel
let txAddr = null;

async function loadTxs(addr) {
  txAddr = addr;
  const rec = state.watchlist.find((w) => w.addr === addr);
  $('tx-for').textContent = '— ' + shortAddress(addr) + (rec && rec.label ? ` (${rec.label})` : '');
  const link = $('tx-explorer-link');
  link.href = bb(`/address/${addr}`);
  link.classList.remove('hidden');
  $('tx-hint').textContent = 'Latest 25 transactions. Received/sent are computed from this address\'s outputs/inputs in each transaction.';
  const body = $('tx-body');
  const errEl = $('tx-err');
  errEl.classList.add('hidden');
  body.innerHTML = '<tr class="empty-row"><td colspan="8">Loading…</td></tr>';
  try {
    const data = parseAddressPayload(
      await fetchJSON(bb(`/api/v2/address/${addr}?page=1&pageSize=25&details=txs`))
    );
    if (data.transactions.length === 0) {
      body.innerHTML = '<tr class="empty-row"><td colspan="8">No transactions for this address.</td></tr>';
      return;
    }
    body.innerHTML = '';
    for (const tx of data.transactions) {
      const dir = txDirection(tx, addr);
      const r = txReceived(tx, addr);
      const s = txSent(tx, addr);
      const net = txNet(tx, addr);
      const tr = document.createElement('tr');
      const confs = tx.confirmations ?? (tx.blockHeight ? '—' : '0');
      tr.innerHTML = `
        <td><a class="link-btn" href="${bb('/tx/' + tx.txid)}" target="_blank" rel="noopener">${shortHash(tx.txid)} ↗</a></td>
        <td>${tx.blockTime ? timeAgo(tx.blockTime) : '—'}</td>
        <td><span class="dir ${dir}">${dir}</span></td>
        <td class="num">${r > 0n ? fmtPRL(r) : '—'}</td>
        <td class="num">${s > 0n ? fmtPRL(s) : '—'}</td>
        <td class="num">${net === 0n ? '0' : (net > 0n ? '+' : '−') + fmtPRL(net < 0n ? -net : net)}</td>
        <td class="num">${tx.fees ? fmtPRL(tx.fees) : '—'}</td>
        <td class="num">${typeof confs === 'number' ? confs.toLocaleString('en-US') : confs}</td>`;
      body.appendChild(tr);
    }
  } catch (e) {
    errEl.textContent = 'Could not load transactions: ' + e.message;
    errEl.classList.remove('hidden');
    body.innerHTML = '<tr class="empty-row"><td colspan="8">—</td></tr>';
  }
}

// ---------------------------------------------------------------- demo fixtures
const DEMO_STATUS = { blockbook: { coin: 'Pearl', network: 'PRL', version: 'devel', gitCommit: '81f52f2', syncMode: true, initialSync: false, inSync: true, bestHeight: 120142, lastBlockTime: '2026-09-28T02:50:31.614380827Z', inSyncMempool: true, lastMempoolTime: '2026-09-28T02:56:27.324757227Z', mempoolSize: 25, decimals: 8 } };
const DEMO_COINGECKO = {
  id: 'pearl-2', symbol: 'prl', name: 'Pearl',
  market_data: {
    current_price: { usd: 1.41 },
    price_change_percentage_24h: -1.4059,
    high_24h: { usd: 1.74 }, low_24h: { usd: 1.41 },
    total_volume: { usd: 4882235 }, market_cap: { usd: 461809989 },
    market_cap_rank: 120, last_updated: '2026-09-28T03:06:40.000Z',
  },
};
const DEMO_ADDR = { page: 1, totalPages: 3, address: DONATE, balance: '265588747897', totalReceived: '265588747897', totalSent: '0', unconfirmedBalance: '0', unconfirmedTxs: 0, txs: 64, transactions: [] };

// ---------------------------------------------------------------- refresh orchestration
async function refreshAll() {
  if (state.settings.demo) {
    const s = parseStatusPayload(DEMO_STATUS);
    $('net-height').textContent = Number(s.height).toLocaleString('en-US');
    $('net-sync').innerHTML = '<span class="up">● in sync</span>' + demoTag();
    $('net-mempool').textContent = '25';
    $('net-lastblock').textContent = 'demo';
    $('net-version').textContent = s.version;
    $('network-src').textContent = 'blockbook';
    fetchedNow($('net-fetched'), 'demo fixture');

    const p = parseCoinGeckoPayload(DEMO_COINGECKO);
    lastPrice = p.last;
    $('market-last').textContent = '$' + p.last;
    $('market-change').innerHTML = `<span class="down">▼ ${Math.abs(p.changePct).toFixed(2)}%</span> 24h` + demoTag();
    $('market-high').textContent = '$' + p.high.toFixed(2);
    $('market-low').textContent = '$' + p.low.toFixed(2);
    $('market-vol').textContent = fmtCompactUsd(p.volumeUsd) + ' (24h)';
    $('market-src').textContent = 'CoinGecko · PRL/USD';
    fetchedNow($('market-fetched'), 'demo fixture');

    if (!state.watchlist.some((w) => w.addr === DONATE)) {
      state.watchlist.unshift({ addr: DONATE, label: 'demo', addedAt: Date.now() });
    }
    state.cache[DONATE] = parseAddressPayload(DEMO_ADDR);
    save();
    renderWatchlist(state.watchlist.map((w) => ({ w, rec: state.cache[w.addr] || null })));
    renderPortfolio(state.watchlist.map((w) => ({ w, rec: state.cache[w.addr] || null })));
    alert('demo', 'info', 'ℹ Demo mode is ON — all numbers are fixtures, clearly labeled. Turn it off in Settings for live data.');
    return;
  }
  clearAlert('demo');
  await Promise.allSettled([loadNetwork(), loadMarket()]);
  await loadWatchlist();
}

function armAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
  const sec = Number(state.settings.refreshSec) || 0;
  if (sec > 0) refreshTimer = setInterval(() => { void refreshAll(); }, sec * 1000);
}

// ---------------------------------------------------------------- events
function init() {
  $('set-blockbook').value = state.settings.blockbook;
  $('set-pricesource').value = state.settings.priceSource;
  $('set-coingecko').value = state.settings.coingecko;
  $('set-coinex').value = state.settings.coinex;
  $('set-refresh').value = state.settings.refreshSec;
  $('set-demo').checked = !!state.settings.demo;

  $('add-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const errEl = $('add-err');
    errEl.classList.add('hidden');
    const raw = $('addr-input').value;
    const label = $('label-input').value.trim();
    let info;
    try {
      info = validatePearlAddress(raw);
    } catch (err) {
      errEl.textContent = 'Not a valid Pearl address: ' + err.message;
      errEl.classList.remove('hidden');
      return;
    }
    if (info.network !== 'mainnet') {
      errEl.textContent = `This watchlist tracks mainnet only — "${info.network}" address not added.`;
      errEl.classList.remove('hidden');
      return;
    }
    const addr = raw.trim().toLowerCase();
    if (state.watchlist.some((w) => w.addr === addr)) {
      errEl.textContent = 'That address is already on the watchlist.';
      errEl.classList.remove('hidden');
      return;
    }
    state.watchlist.push({ addr, label, addedAt: Date.now() });
    save();
    $('addr-input').value = '';
    $('label-input').value = '';
    void loadWatchlist();
  });

  $('watch-body').addEventListener('click', (e) => {
    const btn = e.target.closest('.link-btn');
    if (!btn) return;
    const addr = btn.dataset.addr;
    if (btn.dataset.act === 'rm') {
      state.watchlist = state.watchlist.filter((w) => w.addr !== addr);
      delete state.cache[addr];
      save();
      if (txAddr === addr) {
        txAddr = null;
        $('tx-for').textContent = '';
        $('tx-hint').textContent = 'Click “txs” on any watched address to inspect its latest transactions.';
        $('tx-body').innerHTML = '<tr class="empty-row"><td colspan="8">—</td></tr>';
        $('tx-explorer-link').classList.add('hidden');
      }
      void loadWatchlist();
    } else if (btn.dataset.act === 'txs') {
      void loadTxs(addr);
    } else if (btn.dataset.act === 'open') {
      window.open(bb(`/address/${addr}`), '_blank', 'noopener');
    }
  });

  $('btn-refresh').addEventListener('click', () => { void refreshAll(); });

  $('btn-save-settings').addEventListener('click', () => {
    state.settings.blockbook = $('set-blockbook').value.trim() || DEFAULTS.settings.blockbook;
    state.settings.priceSource = $('set-pricesource').value === 'coinex' ? 'coinex' : 'coingecko';
    state.settings.coingecko = $('set-coingecko').value.trim() || DEFAULTS.settings.coingecko;
    state.settings.coinex = $('set-coinex').value.trim() || DEFAULTS.settings.coinex;
    state.settings.refreshSec = Math.max(0, Math.min(3600, Number($('set-refresh').value) || 0));
    state.settings.demo = $('set-demo').checked;
    save();
    armAutoRefresh();
    void refreshAll();
  });

  $('btn-export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), watchlist: state.watchlist }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'pearl-pulse-watchlist.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });

  $('btn-clear').addEventListener('click', () => {
    if (!confirm('Remove all watched addresses, cached balances, and settings from this browser?')) return;
    state = structuredClone(DEFAULTS);
    save();
    txAddr = null;
    lastPrice = null;
    init();
    void refreshAll();
  });

  armAutoRefresh();
  void refreshAll();
}

document.addEventListener('DOMContentLoaded', init);
