// Pearl Monetary — browser app. Bundled by build.mjs into pearl-monetary.bundle.js
// (window.PearlMonetary). Works from file:// and GitHub Pages with zero deps.
import {
  GRAINS_PER_PRL, EMISSION_CONSTANT, BLOCK_TARGET_SECONDS, COINBASE_MATURITY,
  SNAPSHOT, blockSubsidyGrains, cumulativeGrains, cumulativePercent,
  grainsToPrl, eraOf, eraRange, eraSchedule, nextEraBoundary,
  estHeightAtDate, estDateAtHeight,
  fmtInt, fmtGrains, fmtPRL, fmtPct, fmtCountdown, fmtDate,
} from "./logic.js";

const DONATE = "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d";
const BLOCKBOOK_URL = "https://blockbook.pearlresearch.ai/api/v2";
const SNAPSHOT_MS = Date.parse(SNAPSHOT.asOfISO);

const state = {
  height: SNAPSHOT.height,
  heightMs: SNAPSHOT_MS,
  source: "snapshot", // "live" | "snapshot" | "manual"
};

const $ = (id) => document.getElementById(id);

// ---------- tabs ----------
$("tabs").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-tab]");
  if (!btn) return;
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.remove("active"));
  document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
  btn.classList.add("active");
  $("tab-" + btn.dataset.tab).classList.add("active");
});

// ---------- live height ----------
async function fetchLiveHeight() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(BLOCKBOOK_URL, { signal: ctrl.signal });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const j = await res.json();
    const h = j?.blockbook?.bestHeight ?? j?.backend?.blocks;
    if (!Number.isInteger(h) || h < 1) throw new Error("no height in response");
    return h;
  } finally {
    clearTimeout(t);
  }
}

function setHeight(h, source, ms) {
  state.height = h;
  state.source = source;
  state.heightMs = ms;
  renderOverview();
  renderChart();
}

async function probeLive() {
  const badge = $("height-badge");
  const note = $("height-note");
  badge.className = "badge stale";
  badge.textContent = "PROBING…";
  try {
    const h = await fetchLiveHeight();
    setHeight(h, "live", Date.now());
  } catch (err) {
    setHeight(SNAPSHOT.height, "snapshot", SNAPSHOT_MS);
  }
}

function renderHeightBadge() {
  const badge = $("height-badge");
  const note = $("height-note");
  if (state.source === "live") {
    badge.className = "badge live";
    badge.textContent = "● LIVE";
    note.textContent = "from Blockbook, " + fmtDate(state.heightMs);
  } else if (state.source === "manual") {
    badge.className = "badge manual";
    badge.textContent = "◐ MANUAL";
    note.textContent = "entered by you — not chain data";
  } else {
    badge.className = "badge stale";
    badge.textContent = "◑ STALE SNAPSHOT";
    note.textContent = `block ${fmtInt(SNAPSHOT.height)}, as of ${fmtDate(SNAPSHOT_MS)} — ${SNAPSHOT.source}. Live probe failed.`;
  }
}

$("height-set").addEventListener("click", () => {
  const v = parseInt($("height-input").value, 10);
  if (!Number.isInteger(v) || v < 1) {
    $("height-note").textContent = "Enter a positive block height.";
    return;
  }
  setHeight(v, "manual", Date.now());
});
$("height-live").addEventListener("click", probeLive);

// ---------- overview ----------
function renderOverview() {
  renderHeightBadge();
  const h = state.height;
  const sub = blockSubsidyGrains(BigInt(h));
  const era = Number(eraOf(BigInt(h)));
  const cum = cumulativeGrains(BigInt(h));
  const pct = cumulativePercent(h);
  const nb = nextEraBoundary(h);
  const msLeft = nb.blocksRemaining * Number(BLOCK_TARGET_SECONDS) * 1000;
  const estMs = state.heightMs + msLeft;

  $("overview-stats").innerHTML = `
    <div class="stat"><div class="k">Block height</div><div class="v gold">${fmtInt(h)}</div><div class="n">era ${era} · boundary ${fmtInt((era + 1) * Number(EMISSION_CONSTANT))}</div></div>
    <div class="stat"><div class="k">Block subsidy</div><div class="v gold">${fmtPRL(sub)}</div><div class="n">${fmtGrains(sub)}</div></div>
    <div class="stat"><div class="k">Issued supply</div><div class="v">${fmtPRL(cum)}</div><div class="n">${fmtPct(pct, 4)} of 2.1B PRL</div></div>
    <div class="stat"><div class="k">Next decay milestone</div><div class="v">${fmtInt(nb.blocksRemaining)} blocks</div><div class="n">era ${nb.eraEnding} ends at ${fmtInt(nb.boundaryHeight)}<br>≈ ${fmtCountdown(msLeft)} — est. ${fmtDate(estMs)}</div></div>
    <div class="stat"><div class="k">Remaining to issue</div><div class="v">${fmtPRL(2_100_000_000n * GRAINS_PER_PRL - cum)}</div><div class="n">${fmtPct(100 - pct, 4)} of max supply</div></div>
    <div class="stat"><div class="k">Emission constant</div><div class="v">650,226</div><div class="n">blocks ≈ 4 years at 194 s/block</div></div>`;

  const eraStart = era * Number(EMISSION_CONSTANT);
  const prog = Math.min(100, ((h - eraStart) / Number(EMISSION_CONSTANT)) * 100);
  $("era-progress").innerHTML = `
    <div class="prog"><div style="width:${prog.toFixed(2)}%"></div></div>
    <div class="prog-labels"><span>era ${era} start · ${fmtInt(eraStart + 1)}</span>
    <span>${prog.toFixed(2)}% through era ${era}</span>
    <span>era ${era} end · ${fmtInt(eraStart + Number(EMISSION_CONSTANT))}</span></div>`;
}

// ---------- chart ----------
function renderChart() {
  const W = 960, H = 440, L = 64, R = 64, T = 18, B = 52;
  const maxH = 65_022_600; // 100 eras
  const xMin = 0, xMax = Math.log10(maxH);
  const yLMin = 0, yLMax = 100;               // cumulative %
  const yRMin = -2, yRMax = 4;                // log10 PRL/block
  const X = (h) => L + ((Math.log10(Math.max(1, h)) - xMin) / (xMax - xMin)) * (W - L - R);
  const YL = (p) => T + (1 - (p - yLMin) / (yLMax - yLMin)) * (H - T - B);
  const YR = (prl) => T + (1 - (Math.log10(Math.max(1e-2, prl)) - yRMin) / (yRMax - yRMin)) * (H - T - B);

  const N = 220;
  let supplyPts = "", subsidyPts = "";
  for (let i = 0; i <= N; i++) {
    const h = Math.round(Math.exp(Math.log(1) + (Math.log(maxH) - Math.log(1)) * (i / N)));
    const p = cumulativePercent(h);
    const prl = grainsToPrl(blockSubsidyGrains(BigInt(h)));
    supplyPts += `${X(h).toFixed(1)},${YL(p).toFixed(1)} `;
    subsidyPts += `${X(h).toFixed(1)},${YR(prl).toFixed(1)} `;
  }

  let grid = "";
  for (let n = 1; n <= 99; n++) {
    const h = n * Number(EMISSION_CONSTANT);
    if (h > maxH) break;
    const x = X(h);
    const major = n % 10 === 0;
    grid += `<line x1="${x.toFixed(1)}" y1="${T}" x2="${x.toFixed(1)}" y2="${H - B}" stroke="${major ? "#9c8128" : "#2c2718"}" stroke-width="${major ? 1 : 0.5}"/>`;
  }
  // era end labels
  let eraLabels = "";
  for (const [h, label] of [[650226, "era 0 end"], [6_502_260, "era 9 end"], [65_022_600, "era 99 end"]]) {
    eraLabels += `<text x="${X(h).toFixed(1)}" y="${H - B + 34}" fill="#b3a67f" font-size="11" text-anchor="middle" font-family="monospace">${label}</text>`;
  }
  let xTicks = "";
  for (let e = 0; e <= 7; e++) {
    const h = 10 ** e;
    if (h > maxH) break;
    xTicks += `<text x="${X(h).toFixed(1)}" y="${H - B + 18}" fill="#b3a67f" font-size="11" text-anchor="middle" font-family="monospace">${fmtInt(h)}</text>`;
  }

  let yL = "";
  for (const p of [0, 25, 50, 75, 100]) {
    yL += `<line x1="${L}" y1="${YL(p)}" x2="${W - R}" y2="${YL(p)}" stroke="#2c2718" stroke-width="0.5"/>
           <text x="${L - 8}" y="${YL(p) + 4}" fill="#d4af37" font-size="11" text-anchor="end" font-family="monospace">${p}%</text>`;
  }
  let yR = "";
  for (const [prl, label] of [[0.01, "0.01"], [0.1, "0.1"], [1, "1"], [10, "10"], [100, "100"], [1000, "1k"], [3229.64, "3229.64"]]) {
    yR += `<text x="${W - R + 8}" y="${YR(prl) + 4}" fill="#5fd4c4" font-size="11" font-family="monospace">${label}</text>`;
  }

  const hx = X(state.height);
  const marker = state.height <= maxH ? `
    <line x1="${hx.toFixed(1)}" y1="${T}" x2="${hx.toFixed(1)}" y2="${H - B}" stroke="#e0685c" stroke-width="1.5" stroke-dasharray="6,4"/>
    <text x="${hx.toFixed(1)}" y="${T + 12}" fill="#e0685c" font-size="12" text-anchor="middle" font-family="monospace">you are here · ${fmtInt(state.height)}</text>` : "";

  $("chart-wrap").innerHTML = `
  <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="PRL issuance curve">
    ${grid}
    ${yL}${yR}${xTicks}${eraLabels}
    <polyline points="${supplyPts}" fill="none" stroke="#d4af37" stroke-width="2.5"/>
    <polyline points="${subsidyPts}" fill="none" stroke="#5fd4c4" stroke-width="2"/>
    ${marker}
    <text x="${L - 8}" y="${T - 4}" fill="#d4af37" font-size="11" text-anchor="end">% of supply</text>
    <text x="${W - R + 8}" y="${T - 4}" fill="#5fd4c4" font-size="11">PRL / block (log)</text>
    <text x="${(L + W - R) / 2}" y="${H - 4}" fill="#b3a67f" font-size="11" text-anchor="middle" font-family="monospace">block height (log scale)</text>
  </svg>`;
}

// ---------- schedule ----------
function renderSchedule() {
  const tb = document.querySelector("#era-table tbody");
  let rows = "";
  for (let n = 0; n < 10; n++) {
    const e = eraSchedule(n);
    rows += `<tr>
      <td>${e.era}</td>
      <td>${fmtInt(e.startHeight)} – ${fmtInt(e.endHeight)}</td>
      <td>${fmtPRL(e.startSubsidyGrains)}</td>
      <td>${e.issuedDuringPercent.toFixed(4)}%</td>
      <td>${fmtPRL(e.cumulativeGrains)} (${fmtPct(e.cumulativePercent, 2)})</td>
    </tr>`;
  }
  tb.innerHTML = rows;
}

// ---------- tools ----------
function toolTable(rows) {
  return `<table>${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("")}</table>`;
}

$("t-height-go").addEventListener("click", () => {
  const out = $("t-height-out");
  const h = parseInt($("t-height").value, 10);
  if (!Number.isInteger(h) || h < 0) {
    out.innerHTML = `<span class="big" style="color:var(--red)">✗</span> enter a non-negative block height.`;
    return;
  }
  if (h === 0) {
    out.innerHTML = toolTable([["Block subsidy", "0 PRL (genesis pays nothing)"], ["Era", "—"], ["Cumulative issued", "0 PRL"]]);
    return;
  }
  const sub = blockSubsidyGrains(BigInt(h));
  const era = Number(eraOf(BigInt(h)));
  const r = eraRange(era);
  const nb = nextEraBoundary(h);
  out.innerHTML = `<div class="big">${fmtPRL(sub)}</div>` + toolTable([
    ["Grains", fmtInt(sub)],
    ["Era", `${era} (${fmtInt(Number(r.startHeight))} – ${fmtInt(Number(r.endHeight))})`],
    ["Cumulative issued", fmtPRL(cumulativeGrains(BigInt(h))) + ` (${fmtPct(cumulativePercent(h), 4)})`],
    ["Next era boundary", `${fmtInt(nb.boundaryHeight)} — ${fmtInt(nb.blocksRemaining)} blocks away`],
  ]);
});

$("t-date-go").addEventListener("click", () => {
  const out = $("t-date-out");
  const v = $("t-date").value;
  if (!v) { out.innerHTML = "Pick a date first."; return; }
  const target = new Date(v).getTime();
  const blocks = Math.floor((target - SNAPSHOT_MS) / (Number(BLOCK_TARGET_SECONDS) * 1000));
  if (blocks < 0) {
    out.innerHTML = `<span class="big" style="color:var(--red)">✗</span> before the snapshot anchor (${fmtDate(SNAPSHOT_MS)}) — this desk does not estimate backwards.`;
    return;
  }
  const h = SNAPSHOT.height + blocks;
  const sub = blockSubsidyGrains(BigInt(h));
  const drift = Math.abs(target - SNAPSHOT_MS) / 86400000 / 365;
  out.innerHTML = `<div class="big">≈ block ${fmtInt(h)}</div>` + toolTable([
    ["Block subsidy", fmtPRL(sub)],
    ["Era", String(Number(eraOf(BigInt(h))))],
    ["Cumulative issued", fmtPct(cumulativePercent(h), 2) + " of 2.1B"],
  ]) + `<p class="hint">Estimate at exactly 194 s/block from the snapshot anchor.
    Real block times drift — expect roughly ±${Math.max(1, Math.round(drift))} day(s) of error at this distance.</p>`;
});

function prlToGrains(text) {
  const t = text.trim();
  if (!/^\d+(\.\d{1,8})?$/.test(t)) return null;
  const [w, f = ""] = t.split(".");
  return BigInt(w) * GRAINS_PER_PRL + BigInt((f + "00000000").slice(0, 8));
}
$("t-prl").addEventListener("input", () => {
  const g = prlToGrains($("t-prl").value);
  $("t-conv-out").innerHTML = g === null
    ? ($("t-prl").value.trim() === "" ? "" : "Enter a PRL amount with at most 8 decimals.")
    : `<div class="big">${fmtInt(g)} grains</div>`;
});
$("t-grains").addEventListener("input", () => {
  const t = $("t-grains").value.trim();
  if (t === "") { $("t-conv-out").innerHTML = ""; return; }
  if (!/^\d+$/.test(t)) { $("t-conv-out").innerHTML = "Grains must be a whole number."; return; }
  $("t-conv-out").innerHTML = `<div class="big">${fmtPRL(BigInt(t))}</div>`;
});

$("t-mat-go").addEventListener("click", () => {
  const out = $("t-mat-out");
  const h = parseInt($("t-mat").value, 10);
  if (!Number.isInteger(h) || h < 1) {
    out.innerHTML = `<span class="big" style="color:var(--red)">✗</span> enter a positive funding height.`;
    return;
  }
  const mature = h + COINBASE_MATURITY;
  const cur = state.height;
  const blocksLeft = mature - cur;
  const estMs = estDateAtHeight(SNAPSHOT.height, SNAPSHOT_MS, mature);
  const status = blocksLeft <= 0
    ? `<span style="color:#7fe6a8">● MATURE</span> — spendable since ~block ${fmtInt(mature)}`
    : `<span style="color:var(--gold)">◐ IMMATURE</span> — ${fmtInt(blocksLeft)} blocks to go`;
  out.innerHTML = `<div class="big">${status}</div>` + toolTable([
    ["Coinbase funded at", fmtInt(h)],
    ["Spendable at height", fmtInt(mature) + ` (+${COINBASE_MATURITY})`],
    ["Est. maturity date", fmtDate(estMs) + " (at 194 s/block)"],
  ]) + `<p class="hint">Why: a reorg shorter than 100 blocks can still orphan a
    young coinbase, so consensus forbids spending it first. Waiting miners honor
    the rule — a wallet that spends early produces an invalid transaction.</p>`;
});

// ---------- donate ----------
$("donate-copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(DONATE);
    $("donate-copy").textContent = "copied ✓";
  } catch {
    $("donate-copy").textContent = "select & copy";
  }
  setTimeout(() => { $("donate-copy").textContent = "copy"; }, 2000);
});

// ---------- init ----------
$("t-anchor").textContent = `block ${fmtInt(SNAPSHOT.height)} @ ${fmtDate(SNAPSHOT_MS)}`;
renderSchedule();
probeLive();

window.PearlMonetary = { state, blockSubsidyGrains, eraSchedule };
