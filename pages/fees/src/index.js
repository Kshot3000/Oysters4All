// Pearl Fees — browser app. Bundled by build.mjs into pearl-fees.bundle.js
// (window.PearlFees). Works from file:// and GitHub Pages with zero deps.
import {
  BLOCK_TARGET_SECONDS, MAX_BLOCK_VSIZE,
  feeRateGrainsPerVb, percentile, feeRecommendations, bucketize,
  estimateVsize, feeFor, fmtGrains, fmtPRL, fmtDuration,
  blocksAhead, etaForRate, parseTxVsize, bumpPlan, demoMempool,
  parseFeeToGrains,
} from "./logic.js";

const LS_KEY = "pearl-fees-settings-v1";
const DONATE = "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d";

function loadSettings() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch { return {}; }
}
function saveSettings(s) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch { /* private mode */ }
}
const settings = Object.assign({ endpoint: "", user: "", pass: "", auto: false }, loadSettings());

const $ = (id) => document.getElementById(id);
const els = {};
for (const id of [
  "conn-badge", "m-status", "m-stats", "m-hist", "m-recs", "m-table",
  "e-nin", "e-nout", "e-vsize", "e-rate", "e-fee", "e-presets", "e-targets",
  "b-txid", "b-fee", "b-feeunit", "b-target", "b-run", "b-out", "b-err",
  "s-endpoint", "s-user", "s-pass", "s-auto", "s-connect", "s-err",
  "refresh", "foot-donate",
]) els[id] = $(id);

// ---------- steps nav ----------
document.querySelectorAll("#steps button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#steps button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    $("step-" + btn.dataset.step).classList.add("active");
  });
});

// ---------- RPC ----------
async function rpc(method, params = []) {
  const ep = (settings.endpoint || "").trim();
  if (!ep) throw new Error("no-endpoint");
  const headers = { "Content-Type": "application/json" };
  if (settings.user) headers.Authorization = "Basic " + btoa(settings.user + ":" + settings.pass);
  const res = await fetch(ep.replace(/\/$/, ""), {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "1.0", id: "pearl-fees", method, params }),
  });
  if (!res.ok) throw new Error("HTTP " + res.status + " — is the endpoint right and RPC enabled (rpcuser/rpcpass in pearld.conf)?");
  const data = await res.json();
  if (data.error) throw new Error("RPC error: " + (data.error.message || JSON.stringify(data.error)));
  return data.result;
}

// ---------- mempool state ----------
let entries = []; // { vsize, fee(PRL), rate }
let live = false;
let mempoolInfo = null;

function setBadge() {
  els["conn-badge"].innerHTML = live
    ? '<span class="pill live">● LIVE — your pearld node</span>'
    : '<span class="pill demo">◆ SAMPLE DATA — connect a node for live fees</span>';
}

async function refreshMempool() {
  els["m-status"].textContent = "Loading…";
  try {
    const [info, raw] = await Promise.all([
      rpc("getmempoolinfo"),
      rpc("getrawmempool", [true]),
    ]);
    mempoolInfo = info;
    entries = Object.values(raw)
      .filter((t) => t && t.vsize > 0 && t.fee >= 0)
      .map((t) => ({ vsize: t.vsize, fee: t.fee, rate: feeRateGrainsPerVb(t.fee, t.vsize) }));
    live = true;
    els["m-status"].textContent = `Refreshed just now from your node · ${entries.length} txs`;
  } catch (e) {
    if (e.message === "no-endpoint") {
      entries = demoMempool().map((t) => ({ vsize: t.vsize, fee: t.fee, rate: feeRateGrainsPerVb(t.fee, t.vsize) }));
      mempoolInfo = null;
      live = false;
      els["m-status"].textContent = "No node connected — showing clearly-labeled sample data. Add your pearld RPC endpoint in Settings.";
    } else {
      els["m-status"].textContent = "Failed: " + e.message + " — falling back to sample data.";
      entries = demoMempool().map((t) => ({ vsize: t.vsize, fee: t.fee, rate: feeRateGrainsPerVb(t.fee, t.vsize) }));
      mempoolInfo = null;
      live = false;
    }
  }
  setBadge();
  renderMempool();
  renderEstimatorTargets();
}

function renderMempool() {
  const rates = entries.map((e) => e.rate);
  const totalVb = entries.reduce((a, e) => a + e.vsize, 0);
  const asc = [...rates].sort((a, b) => a - b);
  const stat = (label, value) =>
    `<div class="stat"><span class="stat-label">${label}</span><span class="stat-val">${value}</span></div>`;
  els["m-stats"].innerHTML =
    stat("Mempool txs", entries.length.toLocaleString("en-US")) +
    stat("Total size", (totalVb / 1e6).toFixed(2) + " MB") +
    stat("Median rate", fmtGrains(percentile(asc, 50)) + " g/vB") +
    stat("p90 rate", fmtGrains(percentile(asc, 90)) + " g/vB") +
    (mempoolInfo ? stat("Node bytes", Number(mempoolInfo.bytes || 0).toLocaleString("en-US")) : stat("Source", "sample"));

  // histogram
  const buckets = bucketize(rates);
  const cv = els["m-hist"];
  const ctx = cv.getContext("2d");
  const W = (cv.width = cv.clientWidth * 2 || 1200);
  const H = (cv.height = 360);
  ctx.clearRect(0, 0, W, H);
  const maxC = Math.max(1, ...buckets.map((b) => b.count));
  const bw = W / buckets.length;
  buckets.forEach((b, i) => {
    const h = (b.count / maxC) * (H - 60);
    const x = i * bw + 2, y = H - 40 - h;
    const g = ctx.createLinearGradient(0, y, 0, H - 40);
    g.addColorStop(0, "#ffb35c"); g.addColorStop(1, "#7a3b10");
    ctx.fillStyle = g;
    ctx.fillRect(x, y, bw - 4, h);
  });
  ctx.fillStyle = "#c9a06a";
  ctx.font = "20px ui-monospace, monospace";
  ctx.fillText(fmtGrains(buckets[0].lo) + " g/vB", 8, H - 12);
  ctx.fillText(fmtGrains(buckets[buckets.length - 1].hi) + "+ g/vB", W - 200, H - 12);
  ctx.fillText("fee rate → (log scale)", 8, 24);

  // recommendations
  const rec = feeRecommendations(rates);
  const rows = [
    ["Next block", rec.next, "pays above ~95% of the mempool"],
    ["~10 minutes", rec.fast, "above ~75% — the confident default"],
    ["~1 hour", rec.normal, "median of the mempool"],
    ["Economy", rec.economy, "above ~25% — only if you can wait"],
  ];
  els["m-recs"].innerHTML = rows.map(([label, rate, hint]) => {
    const eta = etaForRate(rate, entries);
    return `<div class="rec"><div class="rec-head"><strong>${label}</strong><span class="rate">${fmtGrains(rate)} g/vB</span></div>
      <div class="rec-hint">${hint} · ~${eta.blocks === 0 ? "next" : eta.blocks + " block" + (eta.blocks > 1 ? "s" : "")} ahead ≈ ${fmtDuration(eta.seconds)}</div>
      <button class="use-rate" data-rate="${rate}">Use in estimator →</button></div>`;
  }).join("");
  els["m-recs"].querySelectorAll(".use-rate").forEach((b) =>
    b.addEventListener("click", () => {
      els["e-rate"].value = b.dataset.rate;
      document.querySelector('[data-step="estimator"]').click();
      updateEstimator();
    })
  );

  // top txs by rate
  const top = [...entries].sort((a, b) => b.rate - a.rate).slice(0, 20);
  els["m-table"].innerHTML =
    `<table><thead><tr><th>#</th><th>Fee rate</th><th>Size</th><th>Fee</th></tr></thead><tbody>` +
    top.map((e, i) =>
      `<tr><td>${i + 1}</td><td class="mono">${fmtGrains(e.rate)} g/vB</td><td class="mono">${e.vsize} vB</td><td class="mono">${fmtPRL(e.fee)} PRL</td></tr>`
    ).join("") + `</tbody></table>`;
}

// ---------- estimator ----------
function renderEstimatorTargets() {
  const rec = feeRecommendations(entries.map((e) => e.rate));
  const opts = rec
    ? [["next", rec.next, "Next block"], ["fast", rec.fast, "~10 min"], ["normal", rec.normal, "~1 hr"], ["economy", rec.economy, "Economy"]]
    : [["fast", 50, "~10 min (sample)"], ["normal", 25, "~1 hr (sample)"]];
  els["e-targets"].innerHTML = opts.map(([k, r, label]) =>
    `<label class="radio"><input type="radio" name="etarget" value="${r}" ${k === "fast" ? "checked" : ""}> ${label} <span class="mono">${fmtGrains(r)} g/vB</span></label>`
  ).join("") + `<label class="radio"><input type="radio" name="etarget" value="custom"> Custom <input id="e-custom" class="inline mono" type="number" min="1" value="20" style="width:6em"> g/vB</label>`;
  els["e-targets"].querySelectorAll('input[name="etarget"]').forEach((r) =>
    r.addEventListener("change", updateEstimator)
  );
  $("e-custom").addEventListener("input", updateEstimator);
  updateEstimator();
}

function updateEstimator() {
  const nIn = Math.max(0, parseInt(els["e-nin"].value || "0", 10));
  const nOut = Math.max(1, parseInt(els["e-nout"].value || "1", 10));
  const vsize = estimateVsize(nIn, nOut);
  els["e-vsize"].value = vsize + " vB";
  const sel = document.querySelector('input[name="etarget"]:checked');
  let rate = 50;
  if (sel) rate = sel.value === "custom" ? Math.max(1, parseFloat($("e-custom").value || "1")) : parseFloat(sel.value);
  const fee = feeFor(vsize, rate);
  els["e-rate"].value = rate;
  els["e-fee"].innerHTML =
    `<div class="fee-big">${fmtGrains(fee.grains)} <span>grains</span></div>
     <div class="fee-sub mono">≈ ${fmtPRL(fee.prl)} PRL @ ${fmtGrains(rate)} g/vB</div>
     <div class="fee-sub">${vsize} vB × ${fmtGrains(rate)} g/vB · 1 PRL = 100,000,000 grains</div>`;
  const eta = etaForRate(rate, entries);
  els["e-fee"].innerHTML += `<div class="fee-sub">Rough wait at this rate: ${eta.blocks === 0 ? "next block" : "~" + eta.blocks + " blocks"} ≈ ${fmtDuration(eta.seconds)} (3m14s block target, ~1 MB blocks)</div>`;
}

els["e-nin"].addEventListener("input", updateEstimator);
els["e-nout"].addEventListener("input", updateEstimator);
els["e-rate"].addEventListener("input", () => {
  document.querySelectorAll('input[name="etarget"]').forEach((r) => {
    if (r.value === "custom") r.checked = true;
    else if (parseFloat(r.value) === parseFloat(els["e-rate"].value)) r.checked = true;
  });
  const c = $("e-custom"); if (c) c.value = els["e-rate"].value;
  updateEstimator();
});
els["e-presets"].querySelectorAll("button").forEach((b) =>
  b.addEventListener("click", () => {
    els["e-nin"].value = b.dataset.nin;
    els["e-nout"].value = b.dataset.nout;
    updateEstimator();
  })
);

// ---------- bump planner ----------
function renderBumpTargets() {
  const rec = feeRecommendations(entries.map((e) => e.rate));
  const opts = rec
    ? [["Next block", rec.next], ["~10 min", rec.fast], ["~1 hr", rec.normal]]
    : [["~10 min", 50], ["~1 hr", 25]];
  els["b-target"].innerHTML = opts.map(([l, r]) => `<option value="${r}">${l} — ${fmtGrains(r)} g/vB</option>`).join("");
}

els["b-run"].addEventListener("click", async () => {
  const txid = els["b-txid"].value.trim();
  els["b-err"].textContent = "";
  els["b-out"].innerHTML = "";
  if (!/^[0-9a-fA-F]{64}$/.test(txid)) { els["b-err"].textContent = "Enter a 64-hex-char txid."; return; }
  /* Exact fee parse (core): the old parseFloat + Math.round silently
   * rounded sub-grain PRL fees to 0 grains and fractional grains up —
   * the planner then computed rates from an amount never typed. */
  const feeRaw = els["b-fee"].value;
  if (!feeRaw.trim()) { els["b-err"].textContent = "Enter the fee the stuck transaction paid."; return; }
  let feeGrains;
  try { feeGrains = parseFeeToGrains(feeRaw, els["b-feeunit"].value); }
  catch (e) { els["b-err"].textContent = e.message; return; }
  if (!(feeGrains > 0)) { els["b-err"].textContent = "Enter the fee the stuck transaction paid."; return; }
  let hex = null;
  try { hex = await rpc("getrawtransaction", [txid, 0]); }
  catch (e) {
    els["b-err"].textContent = e.message === "no-endpoint"
      ? "Bump planner needs your pearld RPC endpoint (Settings) to fetch the transaction. Tip: you can paste raw hex below instead — coming right up."
      : "Could not fetch tx: " + e.message;
    return;
  }
  let parsed;
  try { parsed = parseTxVsize(hex); }
  catch (e) { els["b-err"].textContent = "Could not parse transaction hex: " + e.message; return; }
  const targetRate = parseFloat(els["b-target"].value);
  const plan = bumpPlan({ stuckVsize: parsed.vsize, stuckFeeGrains: feeGrains, targetRate });
  els["b-out"].innerHTML = `
    <div class="plan">
      <h3>Bump plan for <span class="mono">${txid.slice(0, 12)}…${txid.slice(-8)}</span></h3>
      <div class="grid2">
        <div>Size</div><div class="mono">${parsed.vsize} vB (${parsed.nInputs} in / ${parsed.nOutputs} out, ${parsed.segwit ? "segwit" : "legacy"})</div>
        <div>Paid rate</div><div class="mono">${fmtGrains(plan.currentRate)} g/vB (${fmtGrains(feeGrains)} grains)</div>
        <div>Target rate</div><div class="mono">${fmtGrains(targetRate)} g/vB</div>
        <div>Replacement must pay</div><div class="mono"><strong>${fmtGrains(plan.wantFeeGrains)} grains</strong> ≈ ${fmtPRL(plan.wantFeePRL)} PRL</div>
        <div>Extra fee needed</div><div class="mono"><strong>${fmtGrains(plan.extraGrains)} grains</strong> ≈ ${fmtPRL(plan.extraPRL)} PRL (${plan.bumpX === Infinity ? "—" : plan.bumpX.toFixed(1) + "×"} current)</div>
        <div>RBF signaled?</div><div>${parsed.rbfSignaled
          ? "Yes — at least one input has sequence &lt; 0xfffffffe, so the tx opted into replace-by-fee (if your node's policy honors it)."
          : "No — all inputs use final sequence. RBF replacement will be rejected by default policy; use CPFP (spend the stuck output in a high-fee child) instead."}</div>
      </div>
      <p class="hint">This desk plans the numbers — it never signs or broadcasts. Build the replacement in your wallet (Pearl Sign, Oyster, or your own tooling) and double-check the hex before broadcast.</p>
    </div>`;
});

// ---------- settings ----------
function syncSettingsForm() {
  els["s-endpoint"].value = settings.endpoint;
  els["s-user"].value = settings.user;
  els["s-pass"].value = settings.pass;
  els["s-auto"].checked = !!settings.auto;
}
els["s-connect"].addEventListener("click", async () => {
  settings.endpoint = els["s-endpoint"].value.trim();
  settings.user = els["s-user"].value.trim();
  settings.pass = els["s-pass"].value;
  settings.auto = els["s-auto"].checked;
  saveSettings(settings);
  els["s-err"].textContent = "";
  await refreshMempool();
  if (live) els["s-err"].textContent = "";
});
els["s-auto"].addEventListener("change", () => {
  settings.auto = els["s-auto"].checked;
  saveSettings(settings);
  armAuto();
});
let autoTimer = null;
function armAuto() {
  if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
  if (settings.auto && settings.endpoint) autoTimer = setInterval(refreshMempool, 30000);
}

els["refresh"].addEventListener("click", refreshMempool);
els["foot-donate"].textContent = DONATE;

// ---------- boot ----------
syncSettingsForm();
setBadge();
refreshMempool().then(() => { renderBumpTargets(); armAuto(); });

window.PearlFees = { refreshMempool, parseTxVsize, feeRecommendations, estimateVsize };
