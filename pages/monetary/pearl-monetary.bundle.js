/* Pearl Monetary bundle (window.PearlMonetary) — built with esbuild from src/index.js. Do not edit by hand; run `node build.mjs`. */
(() => {
  // src/logic.js
  var GRAINS_PER_PRL = 100000000n;
  var MAX_SUPPLY_PRL = 2100000000n;
  var MAX_SUPPLY_GRAINS = MAX_SUPPLY_PRL * GRAINS_PER_PRL;
  var EMISSION_CONSTANT = 650226n;
  var BLOCK_TARGET_SECONDS = 194n;
  var COINBASE_MATURITY = 100;
  var SNAPSHOT = {
    height: 120195,
    asOfISO: "2026-09-29T00:00:00-05:00",
    source: "mainnet block 120195, verified during Pearl Prove QA"
  };
  function blockSubsidyGrains(height) {
    const h = BigInt(height);
    if (h < 1n) return 0n;
    const numerator = MAX_SUPPLY_GRAINS * EMISSION_CONSTANT;
    const denominator = (h + EMISSION_CONSTANT) * (h - 1n + EMISSION_CONSTANT);
    return numerator / denominator;
  }
  function cumulativeGrains(height) {
    const h = BigInt(height);
    if (h < 1n) return 0n;
    return MAX_SUPPLY_GRAINS * h / (h + EMISSION_CONSTANT);
  }
  function cumulativePercent(height) {
    const h = Number(height);
    return h / (h + Number(EMISSION_CONSTANT)) * 100;
  }
  function grainsToPrl(grains) {
    return Number(grains) / 1e8;
  }
  function eraOf(height) {
    const h = BigInt(height);
    if (h < 1n) return 0n;
    return (h - 1n) / EMISSION_CONSTANT;
  }
  function eraRange(n) {
    const nn = BigInt(n);
    return {
      era: nn,
      startHeight: nn * EMISSION_CONSTANT + 1n,
      endHeight: (nn + 1n) * EMISSION_CONSTANT
    };
  }
  function eraSchedule(n) {
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
      cumulativeGrains: cumulativeGrains(endHeight)
    };
  }
  function nextEraBoundary(height) {
    const h = BigInt(height);
    if (h < 1n) return { boundaryHeight: Number(EMISSION_CONSTANT), eraEnding: 0, blocksRemaining: Number(EMISSION_CONSTANT) };
    const nextN = h / EMISSION_CONSTANT + 1n;
    const boundary = nextN * EMISSION_CONSTANT;
    return {
      boundaryHeight: Number(boundary),
      eraEnding: Number(nextN - 1n),
      blocksRemaining: Number(boundary - h)
    };
  }
  function estDateAtHeight(fromHeight, fromDateMs, targetHeight) {
    return fromDateMs + (targetHeight - fromHeight) * Number(BLOCK_TARGET_SECONDS) * 1e3;
  }
  var intFmt = new Intl.NumberFormat("en-US");
  function fmtInt(n) {
    return intFmt.format(Number(n));
  }
  function fmtGrains(g) {
    return intFmt.format(Number(g)) + " grains";
  }
  function fmtPRL(grains) {
    const neg = grains < 0n;
    const abs = neg ? -grains : grains;
    const whole = abs / GRAINS_PER_PRL;
    const frac = (abs % GRAINS_PER_PRL).toString().padStart(8, "0").replace(/0+$/, "");
    const fracShow = frac.length < 2 ? frac.padEnd(2, "0") : frac;
    return (neg ? "-" : "") + intFmt.format(Number(whole)) + "." + fracShow + " PRL";
  }
  function fmtPct(x, digits = 4) {
    return x.toFixed(digits) + "%";
  }
  function fmtCountdown(ms) {
    if (ms < 0) return "past";
    const s = Math.floor(ms / 1e3);
    const d = Math.floor(s / 86400);
    const h = Math.floor(s % 86400 / 3600);
    const m = Math.floor(s % 3600 / 60);
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m ${s % 60}s`;
  }
  function fmtDate(ms) {
    return new Date(ms).toLocaleString("en-US", { timeZone: "America/Chicago" }) + " CT";
  }

  // src/index.js
  var DONATE = "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d";
  var BLOCKBOOK_URL = "https://blockbook.pearlresearch.ai/api/v2";
  var SNAPSHOT_MS = Date.parse(SNAPSHOT.asOfISO);
  var state = {
    height: SNAPSHOT.height,
    heightMs: SNAPSHOT_MS,
    source: "snapshot"
    // "live" | "snapshot" | "manual"
  };
  var $ = (id) => document.getElementById(id);
  $("tabs").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-tab]");
    if (!btn) return;
    document.querySelectorAll("#tabs button").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    $("tab-" + btn.dataset.tab).classList.add("active");
  });
  async function fetchLiveHeight() {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8e3);
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
    badge.textContent = "PROBING\u2026";
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
      badge.textContent = "\u25CF LIVE";
      note.textContent = "from Blockbook, " + fmtDate(state.heightMs);
    } else if (state.source === "manual") {
      badge.className = "badge manual";
      badge.textContent = "\u25D0 MANUAL";
      note.textContent = "entered by you \u2014 not chain data";
    } else {
      badge.className = "badge stale";
      badge.textContent = "\u25D1 STALE SNAPSHOT";
      note.textContent = `block ${fmtInt(SNAPSHOT.height)}, as of ${fmtDate(SNAPSHOT_MS)} \u2014 ${SNAPSHOT.source}. Live probe failed.`;
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
  function renderOverview() {
    renderHeightBadge();
    const h = state.height;
    const sub = blockSubsidyGrains(BigInt(h));
    const era = Number(eraOf(BigInt(h)));
    const cum = cumulativeGrains(BigInt(h));
    const pct = cumulativePercent(h);
    const nb = nextEraBoundary(h);
    const msLeft = nb.blocksRemaining * Number(BLOCK_TARGET_SECONDS) * 1e3;
    const estMs = state.heightMs + msLeft;
    $("overview-stats").innerHTML = `
    <div class="stat"><div class="k">Block height</div><div class="v gold">${fmtInt(h)}</div><div class="n">era ${era} \xB7 boundary ${fmtInt((era + 1) * Number(EMISSION_CONSTANT))}</div></div>
    <div class="stat"><div class="k">Block subsidy</div><div class="v gold">${fmtPRL(sub)}</div><div class="n">${fmtGrains(sub)}</div></div>
    <div class="stat"><div class="k">Issued supply</div><div class="v">${fmtPRL(cum)}</div><div class="n">${fmtPct(pct, 4)} of 2.1B PRL</div></div>
    <div class="stat"><div class="k">Next decay milestone</div><div class="v">${fmtInt(nb.blocksRemaining)} blocks</div><div class="n">era ${nb.eraEnding} ends at ${fmtInt(nb.boundaryHeight)}<br>\u2248 ${fmtCountdown(msLeft)} \u2014 est. ${fmtDate(estMs)}</div></div>
    <div class="stat"><div class="k">Remaining to issue</div><div class="v">${fmtPRL(2100000000n * GRAINS_PER_PRL - cum)}</div><div class="n">${fmtPct(100 - pct, 4)} of max supply</div></div>
    <div class="stat"><div class="k">Emission constant</div><div class="v">650,226</div><div class="n">blocks \u2248 4 years at 194 s/block</div></div>`;
    const eraStart = era * Number(EMISSION_CONSTANT);
    const prog = Math.min(100, (h - eraStart) / Number(EMISSION_CONSTANT) * 100);
    $("era-progress").innerHTML = `
    <div class="prog"><div style="width:${prog.toFixed(2)}%"></div></div>
    <div class="prog-labels"><span>era ${era} start \xB7 ${fmtInt(eraStart + 1)}</span>
    <span>${prog.toFixed(2)}% through era ${era}</span>
    <span>era ${era} end \xB7 ${fmtInt(eraStart + Number(EMISSION_CONSTANT))}</span></div>`;
  }
  function renderChart() {
    const W = 960, H = 440, L = 64, R = 64, T = 18, B = 52;
    const maxH = 65022600;
    const xMin = 0, xMax = Math.log10(maxH);
    const yLMin = 0, yLMax = 100;
    const yRMin = -2, yRMax = 4;
    const X = (h) => L + (Math.log10(Math.max(1, h)) - xMin) / (xMax - xMin) * (W - L - R);
    const YL = (p) => T + (1 - (p - yLMin) / (yLMax - yLMin)) * (H - T - B);
    const YR = (prl) => T + (1 - (Math.log10(Math.max(0.01, prl)) - yRMin) / (yRMax - yRMin)) * (H - T - B);
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
    let eraLabels = "";
    for (const [h, label] of [[650226, "era 0 end"], [6502260, "era 9 end"], [65022600, "era 99 end"]]) {
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
    for (const [prl, label] of [[0.01, "0.01"], [0.1, "0.1"], [1, "1"], [10, "10"], [100, "100"], [1e3, "1k"], [3229.64, "3229.64"]]) {
      yR += `<text x="${W - R + 8}" y="${YR(prl) + 4}" fill="#5fd4c4" font-size="11" font-family="monospace">${label}</text>`;
    }
    const hx = X(state.height);
    const marker = state.height <= maxH ? `
    <line x1="${hx.toFixed(1)}" y1="${T}" x2="${hx.toFixed(1)}" y2="${H - B}" stroke="#e0685c" stroke-width="1.5" stroke-dasharray="6,4"/>
    <text x="${hx.toFixed(1)}" y="${T + 12}" fill="#e0685c" font-size="12" text-anchor="middle" font-family="monospace">you are here \xB7 ${fmtInt(state.height)}</text>` : "";
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
  function renderSchedule() {
    const tb = document.querySelector("#era-table tbody");
    let rows = "";
    for (let n = 0; n < 10; n++) {
      const e = eraSchedule(n);
      rows += `<tr>
      <td>${e.era}</td>
      <td>${fmtInt(e.startHeight)} \u2013 ${fmtInt(e.endHeight)}</td>
      <td>${fmtPRL(e.startSubsidyGrains)}</td>
      <td>${e.issuedDuringPercent.toFixed(4)}%</td>
      <td>${fmtPRL(e.cumulativeGrains)} (${fmtPct(e.cumulativePercent, 2)})</td>
    </tr>`;
    }
    tb.innerHTML = rows;
  }
  function toolTable(rows) {
    return `<table>${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("")}</table>`;
  }
  $("t-height-go").addEventListener("click", () => {
    const out = $("t-height-out");
    const h = parseInt($("t-height").value, 10);
    if (!Number.isInteger(h) || h < 0) {
      out.innerHTML = `<span class="big" style="color:var(--red)">\u2717</span> enter a non-negative block height.`;
      return;
    }
    if (h === 0) {
      out.innerHTML = toolTable([["Block subsidy", "0 PRL (genesis pays nothing)"], ["Era", "\u2014"], ["Cumulative issued", "0 PRL"]]);
      return;
    }
    const sub = blockSubsidyGrains(BigInt(h));
    const era = Number(eraOf(BigInt(h)));
    const r = eraRange(era);
    const nb = nextEraBoundary(h);
    out.innerHTML = `<div class="big">${fmtPRL(sub)}</div>` + toolTable([
      ["Grains", fmtInt(sub)],
      ["Era", `${era} (${fmtInt(Number(r.startHeight))} \u2013 ${fmtInt(Number(r.endHeight))})`],
      ["Cumulative issued", fmtPRL(cumulativeGrains(BigInt(h))) + ` (${fmtPct(cumulativePercent(h), 4)})`],
      ["Next era boundary", `${fmtInt(nb.boundaryHeight)} \u2014 ${fmtInt(nb.blocksRemaining)} blocks away`]
    ]);
  });
  $("t-date-go").addEventListener("click", () => {
    const out = $("t-date-out");
    const v = $("t-date").value;
    if (!v) {
      out.innerHTML = "Pick a date first.";
      return;
    }
    const target = new Date(v).getTime();
    const blocks = Math.floor((target - SNAPSHOT_MS) / (Number(BLOCK_TARGET_SECONDS) * 1e3));
    if (blocks < 0) {
      out.innerHTML = `<span class="big" style="color:var(--red)">\u2717</span> before the snapshot anchor (${fmtDate(SNAPSHOT_MS)}) \u2014 this desk does not estimate backwards.`;
      return;
    }
    const h = SNAPSHOT.height + blocks;
    const sub = blockSubsidyGrains(BigInt(h));
    const drift = Math.abs(target - SNAPSHOT_MS) / 864e5 / 365;
    out.innerHTML = `<div class="big">\u2248 block ${fmtInt(h)}</div>` + toolTable([
      ["Block subsidy", fmtPRL(sub)],
      ["Era", String(Number(eraOf(BigInt(h))))],
      ["Cumulative issued", fmtPct(cumulativePercent(h), 2) + " of 2.1B"]
    ]) + `<p class="hint">Estimate at exactly 194 s/block from the snapshot anchor.
    Real block times drift \u2014 expect roughly \xB1${Math.max(1, Math.round(drift))} day(s) of error at this distance.</p>`;
  });
  function prlToGrains(text) {
    const t = text.trim();
    if (!/^\d+(\.\d{1,8})?$/.test(t)) return null;
    const [w, f = ""] = t.split(".");
    return BigInt(w) * GRAINS_PER_PRL + BigInt((f + "00000000").slice(0, 8));
  }
  $("t-prl").addEventListener("input", () => {
    const g = prlToGrains($("t-prl").value);
    $("t-conv-out").innerHTML = g === null ? $("t-prl").value.trim() === "" ? "" : "Enter a PRL amount with at most 8 decimals." : `<div class="big">${fmtInt(g)} grains</div>`;
  });
  $("t-grains").addEventListener("input", () => {
    const t = $("t-grains").value.trim();
    if (t === "") {
      $("t-conv-out").innerHTML = "";
      return;
    }
    if (!/^\d+$/.test(t)) {
      $("t-conv-out").innerHTML = "Grains must be a whole number.";
      return;
    }
    $("t-conv-out").innerHTML = `<div class="big">${fmtPRL(BigInt(t))}</div>`;
  });
  $("t-mat-go").addEventListener("click", () => {
    const out = $("t-mat-out");
    const h = parseInt($("t-mat").value, 10);
    if (!Number.isInteger(h) || h < 1) {
      out.innerHTML = `<span class="big" style="color:var(--red)">\u2717</span> enter a positive funding height.`;
      return;
    }
    const mature = h + COINBASE_MATURITY;
    const cur = state.height;
    const blocksLeft = mature - cur;
    const estMs = estDateAtHeight(SNAPSHOT.height, SNAPSHOT_MS, mature);
    const status = blocksLeft <= 0 ? `<span style="color:#7fe6a8">\u25CF MATURE</span> \u2014 spendable since ~block ${fmtInt(mature)}` : `<span style="color:var(--gold)">\u25D0 IMMATURE</span> \u2014 ${fmtInt(blocksLeft)} blocks to go`;
    out.innerHTML = `<div class="big">${status}</div>` + toolTable([
      ["Coinbase funded at", fmtInt(h)],
      ["Spendable at height", fmtInt(mature) + ` (+${COINBASE_MATURITY})`],
      ["Est. maturity date", fmtDate(estMs) + " (at 194 s/block)"]
    ]) + `<p class="hint">Why: a reorg shorter than 100 blocks can still orphan a
    young coinbase, so consensus forbids spending it first. Waiting miners honor
    the rule \u2014 a wallet that spends early produces an invalid transaction.</p>`;
  });
  $("donate-copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(DONATE);
      $("donate-copy").textContent = "copied \u2713";
    } catch {
      $("donate-copy").textContent = "select & copy";
    }
    setTimeout(() => {
      $("donate-copy").textContent = "copy";
    }, 2e3);
  });
  $("t-anchor").textContent = `block ${fmtInt(SNAPSHOT.height)} @ ${fmtDate(SNAPSHOT_MS)}`;
  renderSchedule();
  probeLive();
  window.PearlMonetary = { state, blockSubsidyGrains, eraSchedule };
})();
