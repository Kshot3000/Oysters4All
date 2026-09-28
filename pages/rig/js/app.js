/**
 * Pearl Rig — DOM layer. State in localStorage ('pearlRig.v1').
 * Price: CoinGecko pearl-2 default (CORS-open); CoinEx PEARLUSDT via the
 * bundled proxy.mjs (same pattern as Pearl Pulse).
 */
import {
  blockSubsidyPRL, blocksPerDay, dailyEmissionPRL,
  estimateFromYield, plan, fleetWatts,
  parseCoinGeckoPayload, parseCoinExPayload,
  fmtPRL, fmtUSD, fmtDays, fmtPct, timeAgo,
} from './rig-core.js';

const LS_KEY = 'pearlRig.v1';
const DONATE = 'prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d';
const COINGECKO = 'https://api.coingecko.com/api/v3/coins/pearl-2?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=false';

const GPU_PRESETS = {
  cmp90hx: {
    name: 'CMP 90HX',
    watts: 180,
    note: 'Preset: 180 W wall per GPU — sampled 179.47 / 179.55 W on the 2-card HiveOS rig ' +
          '(docs/rig-benchmarks.md, chernuha-dev/miner-cpm90hx-pearl, 2026-09-27).',
  },
};

const defaults = () => ({
  priceSource: 'coingecko',
  priceManual: '',
  proxyBase: '',
  chainHeight: 120142,
  fleet: [{ name: 'CMP 90HX', count: 2, wattsEach: 180 }],
  mode: 'measured',
  prlPerDay: 1.9,
  creditedThs: 80,
  yieldFactor: 0.0241,
  poolFee: 1,
  kwhRate: 0.12,
  capex: 0,
  lastPrice: null, // {last, changePct, source, at}
});

let state = load();
function load() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return { ...defaults(), ...JSON.parse(raw) };
  } catch { /* corrupted → defaults */ }
  return defaults();
}
function save() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch { /* private mode */ }
}

const $ = (id) => document.getElementById(id);

/* ---------- price ---------- */
async function fetchJSON(url) {
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

async function refreshPrice() {
  const badge = $('priceBadge');
  const note = $('priceNote');
  badge.textContent = '● price: fetching…';
  badge.classList.remove('live');
  note.textContent = '';
  try {
    let p;
    if (state.priceSource === 'coingecko') {
      p = parseCoinGeckoPayload(await fetchJSON(COINGECKO));
    } else if (state.priceSource === 'coinex') {
      const base = (state.proxyBase || '').replace(/\/+$/, '');
      if (!base) throw new Error('CoinEx needs the proxy: run `node proxy.mjs` in pages/rig and set the proxy base above.');
      p = parseCoinExPayload(await fetchJSON(base + '/coinex/v2/spot/ticker?market=PEARLUSDT'));
    } else {
      const m = Number(state.priceManual);
      if (!Number.isFinite(m) || m <= 0) throw new Error('Enter a manual price first.');
      p = { market: 'PRL/USD', last: m, changePct: null, source: 'manual' };
    }
    state.lastPrice = { last: p.last, changePct: p.changePct, source: p.source, at: new Date().toISOString() };
    save();
    renderPrice();
  } catch (e) {
    badge.textContent = '● price: failed';
    note.textContent = 'Price fetch failed: ' + e.message +
      (state.priceSource === 'coinex' ? ' CoinEx sends no CORS headers — the proxy is required.' : '');
    renderPrice();
  }
}

function effectivePrice() {
  if (state.lastPrice && Number.isFinite(state.lastPrice.last)) return state.lastPrice.last;
  const m = Number(state.priceManual);
  return Number.isFinite(m) && m > 0 ? m : null;
}

function renderPrice() {
  const badge = $('priceBadge');
  const lp = state.lastPrice;
  if (lp) {
    $('priceBig').textContent = fmtUSD(lp.last, 4);
    const chg = $('priceChg');
    if (lp.changePct == null) { chg.textContent = '—'; chg.className = ''; }
    else {
      chg.textContent = fmtPct(lp.changePct) + ' / 24h';
      chg.className = lp.changePct >= 0 ? 'up' : 'down';
      chg.id = 'priceChg';
    }
    $('priceSrc').textContent = lp.source + ' · ' + timeAgo(lp.at);
    badge.textContent = '● price: live';
    badge.classList.add('live');
  } else {
    const m = effectivePrice();
    $('priceBig').textContent = m ? fmtUSD(m, 4) : '—';
    $('priceChg').textContent = '—';
    $('priceSrc').textContent = m ? 'manual entry' : 'not set';
    badge.textContent = '● price: manual';
    badge.classList.remove('live');
  }
}

/* ---------- fleet ---------- */
function renderFleet() {
  const body = $('fleetBody');
  body.innerHTML = '';
  state.fleet.forEach((g, i) => {
    const tr = document.createElement('tr');
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    tr.innerHTML =
      '<td>' + esc(g.name || 'GPU') + '</td>' +
      '<td>' + esc(g.count) + '</td>' +
      '<td>' + esc(g.wattsEach) + ' W</td>' +
      '<td>' + (Number(g.count) * Number(g.wattsEach)) + ' W</td>' +
      '<td><button class="row-del" data-i="' + i + '" aria-label="Remove row">✕</button></td>';
    body.appendChild(tr);
  });
  body.querySelectorAll('.row-del').forEach((b) =>
    b.addEventListener('click', () => { state.fleet.splice(Number(b.dataset.i), 1); save(); renderFleet(); recalc(); }));
  $('fleetTotal').textContent = fleetWatts(state.fleet) + ' W';
}

/* ---------- calc ---------- */
function currentInputs() {
  const price = effectivePrice();
  const watts = fleetWatts(state.fleet);
  let prlPerDay;
  if (state.mode === 'yield') {
    prlPerDay = estimateFromYield(state.creditedThs, state.yieldFactor);
  } else {
    prlPerDay = Number(state.prlPerDay);
  }
  return {
    prlPerDay, price, watts,
    poolFeePct: Number(state.poolFee) || 0,
    kwhRate: Number(state.kwhRate) || 0,
    capexUsd: Number(state.capex) || 0,
  };
}

function recalc() {
  // emission hero
  const h = Math.max(1, Math.trunc(Number(state.chainHeight) || 1));
  const sub = blockSubsidyPRL(h);
  const em = dailyEmissionPRL(h);
  $('hsHeight').textContent = h.toLocaleString('en-US');
  $('hsSubsidy').textContent = fmtPRL(sub);
  $('hsEmission').textContent = fmtPRL(em);
  $('hsBlocksDay').textContent = blocksPerDay().toFixed(1);
  $('subsidyAt').textContent = fmtPRL(sub);
  $('emissionAt').textContent = fmtPRL(em);

  const inp = currentInputs();
  const set = (id, txt, cls) => {
    const el = $(id);
    el.textContent = txt;
    el.className = 'r-value' + (cls ? ' ' + cls : '');
  };
  if (inp.price == null || !Number.isFinite(inp.prlPerDay) || inp.prlPerDay < 0) {
    ['rGross', 'rFee', 'rPower', 'rNet', 'rMonth', 'rYear', 'rBreak', 'rPowerShare'].forEach((id) => set(id, '—'));
    $('rGrossPrl').textContent = '—'; $('rMargin').textContent = '—';
    $('rPowerKwh').textContent = '—'; $('rBreakSub').textContent = 'set a price + output';
    $('sensRow').innerHTML = '<td>—</td>'.repeat(6);
    return;
  }
  const r = plan({
    prlPerDay: inp.prlPerDay, priceUsd: inp.price,
    poolFeePct: inp.poolFeePct, watts: inp.watts,
    kwhRate: inp.kwhRate, capexUsd: inp.capexUsd,
  });
  set('rGross', fmtUSD(r.grossUsd), r.grossUsd >= 0 ? 'pos' : 'neg');
  $('rGrossPrl').textContent = fmtPRL(r.grossPrlDay) + ' / day';
  set('rFee', fmtUSD(r.feeUsd), 'dim');
  set('rPower', fmtUSD(r.powerUsd), 'dim');
  $('rPowerKwh').textContent = ((inp.watts / 1000) * 24).toFixed(1) + ' kWh / day';
  set('rNet', fmtUSD(r.netUsd), r.netUsd >= 0 ? 'pos' : 'neg');
  $('rMargin').textContent = 'margin ' + (r.marginPct == null ? '—' : fmtPct(r.marginPct));
  set('rMonth', fmtUSD(r.monthlyNetUsd), r.monthlyNetUsd >= 0 ? 'pos' : 'neg');
  set('rYear', fmtUSD(r.yearlyNetUsd), r.yearlyNetUsd >= 0 ? 'pos' : 'neg');
  if (r.breakEvenDays == null) {
    set('rBreak', '—');
    $('rBreakSub').textContent = inp.capexUsd > 0 ? 'never at current net' : 'enter capex $';
  } else {
    set('rBreak', fmtDays(r.breakEvenDays));
    $('rBreakSub').textContent = fmtUSD(inp.capexUsd, 0) + ' capex';
  }
  set('rPowerShare', r.grossUsd > 0 ? fmtPct((r.powerUsd / r.grossUsd) * 100) : '—');

  // sensitivity: recompute net at ±50/±25% price
  const cells = [-0.5, -0.25, 0, 0.25, 0.5].map((d) => {
    const net = plan({ ...{ prlPerDay: inp.prlPerDay }, priceUsd: inp.price * (1 + d),
      poolFeePct: inp.poolFeePct, watts: inp.watts, kwhRate: inp.kwhRate, capexUsd: 0 }).netUsd;
    const cls = d === 0 ? 'cur' : (net >= 0 ? 'pos' : 'neg');
    return '<td class="' + cls + '">' + fmtUSD(net, 2) + '</td>';
  });
  $('sensRow').innerHTML = '<td>' + fmtUSD(inp.price, 4) + '</td>' + cells.join('');
}

/* ---------- wiring ---------- */
function bindInputs() {
  const num = (id, key) => $(id).addEventListener('input', (e) => {
    state[key] = e.target.value === '' ? '' : Number(e.target.value);
    save(); recalc();
  });
  const str = (id, key) => $(id).addEventListener('input', (e) => {
    state[key] = e.target.value; save(); recalc();
  });
  num('priceManual', 'priceManual');
  str('proxyBase', 'proxyBase');
  num('chainHeight', 'chainHeight');
  num('prlPerDay', 'prlPerDay');
  num('creditedThs', 'creditedThs');
  num('yieldFactor', 'yieldFactor');
  num('poolFee', 'poolFee');
  num('kwhRate', 'kwhRate');
  num('capex', 'capex');

  $('priceSource').addEventListener('change', (e) => {
    state.priceSource = e.target.value; save();
    if (state.priceSource !== 'manual') refreshPrice(); else renderPrice();
  });
  $('refreshPrice').addEventListener('click', refreshPrice);

  const setMode = (m) => {
    state.mode = m; save();
    $('tabMeasured').classList.toggle('active', m === 'measured');
    $('tabYield').classList.toggle('active', m === 'yield');
    $('tabMeasured').setAttribute('aria-selected', m === 'measured');
    $('tabYield').setAttribute('aria-selected', m === 'yield');
    $('paneMeasured').classList.toggle('hidden', m !== 'measured');
    $('paneYield').classList.toggle('hidden', m !== 'yield');
    recalc();
  };
  $('tabMeasured').addEventListener('click', () => setMode('measured'));
  $('tabYield').addEventListener('click', () => setMode('yield'));

  $('gpuPreset').addEventListener('change', (e) => {
    const p = GPU_PRESETS[e.target.value];
    $('presetNote').textContent = p ? p.note : '';
    if (p) { $('gpuName').value = p.name; $('gpuWatts').value = p.watts; }
  });
  $('addGpu').addEventListener('click', () => {
    const name = $('gpuName').value.trim() || 'GPU';
    const count = Math.max(1, Math.trunc(Number($('gpuCount').value) || 1));
    const watts = Math.max(1, Number($('gpuWatts').value) || 0);
    if (!watts) return;
    state.fleet.push({ name, count, wattsEach: watts });
    save(); renderFleet(); recalc();
    $('gpuName').value = ''; $('gpuWatts').value = '';
  });

  $('copyDonate').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(DONATE); $('copyDonate').textContent = 'Copied'; }
    catch { $('copyDonate').textContent = 'Copy failed'; }
    setTimeout(() => { $('copyDonate').textContent = 'Copy'; }, 1500);
  });
}

function hydrate() {
  $('priceSource').value = state.priceSource;
  $('priceManual').value = state.priceManual;
  $('proxyBase').value = state.proxyBase;
  $('chainHeight').value = state.chainHeight;
  $('prlPerDay').value = state.prlPerDay;
  $('creditedThs').value = state.creditedThs;
  $('yieldFactor').value = state.yieldFactor;
  $('poolFee').value = state.poolFee;
  $('kwhRate').value = state.kwhRate;
  $('capex').value = state.capex;
  $('tabMeasured').classList.toggle('active', state.mode === 'measured');
  $('tabYield').classList.toggle('active', state.mode === 'yield');
  $('paneMeasured').classList.toggle('hidden', state.mode !== 'measured');
  $('paneYield').classList.toggle('hidden', state.mode !== 'yield');
}

hydrate();
bindInputs();
renderFleet();
renderPrice();
recalc();
if (state.priceSource !== 'manual' && !state.lastPrice) refreshPrice();
