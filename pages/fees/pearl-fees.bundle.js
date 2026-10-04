/* Pearl Fees bundle (window.PearlFees) — built with esbuild from src/index.js. Do not edit by hand; run `node build.mjs`. */
(() => {
  // src/logic.js
  var GRAINS_PER_PRL = 1e8;
  var BLOCK_TARGET_SECONDS = 194;
  var MAX_BLOCK_VSIZE = 1e6;
  var P2TR_INPUT_VSIZE = 57.5;
  var P2TR_OUTPUT_VSIZE = 43;
  var TX_OVERHEAD_VSIZE = 11;
  function feeRateGrainsPerVb(feePRL, vsize) {
    if (!(vsize > 0) || !(feePRL >= 0)) return 0;
    return feePRL * GRAINS_PER_PRL / vsize;
  }
  function percentile(sortedAsc, p) {
    if (!sortedAsc.length) return 0;
    if (sortedAsc.length === 1) return sortedAsc[0];
    const rank = p / 100 * (sortedAsc.length - 1);
    const lo = Math.floor(rank);
    const hi = Math.ceil(rank);
    return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (rank - lo);
  }
  function feeRecommendations(ratesGrainsPerVb) {
    const asc = [...ratesGrainsPerVb].filter((r) => r > 0).sort((a, b) => a - b);
    if (!asc.length) return null;
    const at = (p) => Math.max(1, Math.round(percentile(asc, p)));
    return {
      next: at(95),
      fast: at(75),
      normal: at(50),
      economy: at(25),
      floor: Math.max(1, Math.round(asc[0])),
      count: asc.length
    };
  }
  function bucketize(rates, nBuckets = 24) {
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
  function estimateVsize(nInputs, nOutputs) {
    const nIn = Math.max(0, Math.floor(nInputs));
    const nOut = Math.max(1, Math.floor(nOutputs));
    return Math.ceil(TX_OVERHEAD_VSIZE + nIn * P2TR_INPUT_VSIZE + nOut * P2TR_OUTPUT_VSIZE);
  }
  function feeFor(vsize, rateGrainsPerVb) {
    const grains = Math.ceil(vsize * Math.max(0, rateGrainsPerVb));
    return { grains, prl: grains / GRAINS_PER_PRL };
  }
  function parsePRLToGrains(s) {
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
  function parseFeeToGrains(s, unit) {
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
  function fmtGrains(g) {
    return Math.round(g).toLocaleString("en-US");
  }
  function fmtPRL(p) {
    return p.toFixed(8).replace(/\.?0+$/, "") || "0";
  }
  function fmtDuration(sec) {
    if (sec < 90) return `~${Math.round(sec)}s`;
    const m = sec / 60;
    if (m < 90) return `~${Math.round(m)} min`;
    const h = m / 60;
    if (h < 48) return `~${Math.round(h)} hr`;
    return `~${Math.round(h / 24)} days`;
  }
  function blocksAhead(rateGrainsPerVb, entries2) {
    let above = 0;
    for (const e of entries2) {
      if (e.rate > rateGrainsPerVb) above += e.vsize;
    }
    return Math.floor(above / MAX_BLOCK_VSIZE);
  }
  function etaForRate(rateGrainsPerVb, entries2) {
    const blocks = blocksAhead(rateGrainsPerVb, entries2);
    return { blocks, seconds: blocks * BLOCK_TARGET_SECONDS };
  }
  function readVarInt(bytes, off) {
    const b = bytes[off];
    if (b < 253) return [b, off + 1];
    if (b === 253) return [bytes[off + 1] | bytes[off + 2] << 8, off + 3];
    if (b === 254) {
      return [
        bytes[off + 1] | bytes[off + 2] << 8 | bytes[off + 3] << 16 | bytes[off + 4] << 24,
        off + 5
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
  function parseTxVsize(hex) {
    const bytes = hexToBytes(hex.trim());
    const total = bytes.length;
    let off = 4;
    if (off + 2 > total) throw new Error("tx too short");
    let segwit = false;
    if (bytes[off] === 0 && bytes[off + 1] === 1) {
      segwit = true;
      off += 2;
    }
    const baseStart = off - 4;
    let [nIn, o] = readVarInt(bytes, off);
    off = o;
    const sequences = [];
    for (let i = 0; i < nIn; i++) {
      if (off + 36 > total) throw new Error("truncated input");
      off += 36;
      const [sl, o2] = readVarInt(bytes, off);
      off = o2 + sl;
      if (off + 4 > total) throw new Error("truncated sequence");
      sequences.push(
        (bytes[off] | bytes[off + 1] << 8 | bytes[off + 2] << 16 | bytes[off + 3] << 24) >>> 0
      );
      off += 4;
    }
    let [nOut, o3] = readVarInt(bytes, off);
    off = o3;
    for (let i = 0; i < nOut; i++) {
      if (off + 8 > total) throw new Error("truncated output");
      off += 8;
      const [sl, o4] = readVarInt(bytes, off);
      off = o4 + sl;
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
    off += 4;
    if (off !== total) throw new Error("trailing bytes after tx");
    const base = baseEndNoWitness - baseStart + 4;
    const vsize = Math.ceil((base * 3 + total) / 4);
    const rbfSignaled = sequences.some((s) => s < 4294967294);
    return { vsize, totalBytes: total, baseBytes: base, nInputs: nIn, nOutputs: nOut, rbfSignaled, segwit };
  }
  function bumpPlan({ stuckVsize, stuckFeeGrains, targetRate }) {
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
      bumpX: stuckFeeGrains > 0 ? wantFeeGrains / stuckFeeGrains : Infinity
    };
  }
  function demoMempool() {
    const rows = [];
    const push = (n, vsize, feePRL) => {
      for (let i = 0; i < n; i++) rows.push({ vsize, fee: feePRL });
    };
    push(18, 141, 141e-6);
    push(12, 141, 705e-7);
    push(9, 200, 6e-5);
    push(8, 198, 396e-7);
    push(6, 250, 25e-6);
    push(5, 315, 1575e-8);
    push(4, 400, 8e-6);
    push(3, 500, 5e-6);
    push(2, 141, 282e-6);
    push(1, 141, 705e-6);
    push(2, 1100, 11e-6);
    return rows;
  }

  // src/index.js
  var LS_KEY = "pearl-fees-settings-v1";
  var DONATE = "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d";
  function loadSettings() {
    try {
      return JSON.parse(localStorage.getItem(LS_KEY)) || {};
    } catch {
      return {};
    }
  }
  function saveSettings(s) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(s));
    } catch {
    }
  }
  var settings = Object.assign({ endpoint: "", user: "", pass: "", auto: false }, loadSettings());
  var $ = (id) => document.getElementById(id);
  var els = {};
  for (const id of [
    "conn-badge",
    "m-status",
    "m-stats",
    "m-hist",
    "m-recs",
    "m-table",
    "e-nin",
    "e-nout",
    "e-vsize",
    "e-rate",
    "e-fee",
    "e-presets",
    "e-targets",
    "b-txid",
    "b-fee",
    "b-feeunit",
    "b-target",
    "b-run",
    "b-out",
    "b-err",
    "s-endpoint",
    "s-user",
    "s-pass",
    "s-auto",
    "s-connect",
    "s-err",
    "refresh",
    "foot-donate"
  ]) els[id] = $(id);
  document.querySelectorAll("#steps button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#steps button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
      $("step-" + btn.dataset.step).classList.add("active");
    });
  });
  async function rpc(method, params = []) {
    const ep = (settings.endpoint || "").trim();
    if (!ep) throw new Error("no-endpoint");
    const headers = { "Content-Type": "application/json" };
    if (settings.user) headers.Authorization = "Basic " + btoa(settings.user + ":" + settings.pass);
    const res = await fetch(ep.replace(/\/$/, ""), {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "1.0", id: "pearl-fees", method, params })
    });
    if (!res.ok) throw new Error("HTTP " + res.status + " \u2014 is the endpoint right and RPC enabled (rpcuser/rpcpass in pearld.conf)?");
    const data = await res.json();
    if (data.error) throw new Error("RPC error: " + (data.error.message || JSON.stringify(data.error)));
    return data.result;
  }
  var entries = [];
  var live = false;
  var mempoolInfo = null;
  function setBadge() {
    els["conn-badge"].innerHTML = live ? '<span class="pill live">\u25CF LIVE \u2014 your pearld node</span>' : '<span class="pill demo">\u25C6 SAMPLE DATA \u2014 connect a node for live fees</span>';
  }
  async function refreshMempool() {
    els["m-status"].textContent = "Loading\u2026";
    try {
      const [info, raw] = await Promise.all([
        rpc("getmempoolinfo"),
        rpc("getrawmempool", [true])
      ]);
      mempoolInfo = info;
      entries = Object.values(raw).filter((t) => t && t.vsize > 0 && t.fee >= 0).map((t) => ({ vsize: t.vsize, fee: t.fee, rate: feeRateGrainsPerVb(t.fee, t.vsize) }));
      live = true;
      els["m-status"].textContent = `Refreshed just now from your node \xB7 ${entries.length} txs`;
    } catch (e) {
      if (e.message === "no-endpoint") {
        entries = demoMempool().map((t) => ({ vsize: t.vsize, fee: t.fee, rate: feeRateGrainsPerVb(t.fee, t.vsize) }));
        mempoolInfo = null;
        live = false;
        els["m-status"].textContent = "No node connected \u2014 showing clearly-labeled sample data. Add your pearld RPC endpoint in Settings.";
      } else {
        els["m-status"].textContent = "Failed: " + e.message + " \u2014 falling back to sample data.";
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
    const stat = (label, value) => `<div class="stat"><span class="stat-label">${label}</span><span class="stat-val">${value}</span></div>`;
    els["m-stats"].innerHTML = stat("Mempool txs", entries.length.toLocaleString("en-US")) + stat("Total size", (totalVb / 1e6).toFixed(2) + " MB") + stat("Median rate", fmtGrains(percentile(asc, 50)) + " g/vB") + stat("p90 rate", fmtGrains(percentile(asc, 90)) + " g/vB") + (mempoolInfo ? stat("Node bytes", Number(mempoolInfo.bytes || 0).toLocaleString("en-US")) : stat("Source", "sample"));
    const buckets = bucketize(rates);
    const cv = els["m-hist"];
    const ctx = cv.getContext("2d");
    const W = cv.width = cv.clientWidth * 2 || 1200;
    const H = cv.height = 360;
    ctx.clearRect(0, 0, W, H);
    const maxC = Math.max(1, ...buckets.map((b) => b.count));
    const bw = W / buckets.length;
    buckets.forEach((b, i) => {
      const h = b.count / maxC * (H - 60);
      const x = i * bw + 2, y = H - 40 - h;
      const g = ctx.createLinearGradient(0, y, 0, H - 40);
      g.addColorStop(0, "#ffb35c");
      g.addColorStop(1, "#7a3b10");
      ctx.fillStyle = g;
      ctx.fillRect(x, y, bw - 4, h);
    });
    ctx.fillStyle = "#c9a06a";
    ctx.font = "20px ui-monospace, monospace";
    ctx.fillText(fmtGrains(buckets[0].lo) + " g/vB", 8, H - 12);
    ctx.fillText(fmtGrains(buckets[buckets.length - 1].hi) + "+ g/vB", W - 200, H - 12);
    ctx.fillText("fee rate \u2192 (log scale)", 8, 24);
    const rec = feeRecommendations(rates);
    const rows = [
      ["Next block", rec.next, "pays above ~95% of the mempool"],
      ["~10 minutes", rec.fast, "above ~75% \u2014 the confident default"],
      ["~1 hour", rec.normal, "median of the mempool"],
      ["Economy", rec.economy, "above ~25% \u2014 only if you can wait"]
    ];
    els["m-recs"].innerHTML = rows.map(([label, rate, hint]) => {
      const eta = etaForRate(rate, entries);
      return `<div class="rec"><div class="rec-head"><strong>${label}</strong><span class="rate">${fmtGrains(rate)} g/vB</span></div>
      <div class="rec-hint">${hint} \xB7 ~${eta.blocks === 0 ? "next" : eta.blocks + " block" + (eta.blocks > 1 ? "s" : "")} ahead \u2248 ${fmtDuration(eta.seconds)}</div>
      <button class="use-rate" data-rate="${rate}">Use in estimator \u2192</button></div>`;
    }).join("");
    els["m-recs"].querySelectorAll(".use-rate").forEach(
      (b) => b.addEventListener("click", () => {
        els["e-rate"].value = b.dataset.rate;
        document.querySelector('[data-step="estimator"]').click();
        updateEstimator();
      })
    );
    const top = [...entries].sort((a, b) => b.rate - a.rate).slice(0, 20);
    els["m-table"].innerHTML = `<table><thead><tr><th>#</th><th>Fee rate</th><th>Size</th><th>Fee</th></tr></thead><tbody>` + top.map(
      (e, i) => `<tr><td>${i + 1}</td><td class="mono">${fmtGrains(e.rate)} g/vB</td><td class="mono">${e.vsize} vB</td><td class="mono">${fmtPRL(e.fee)} PRL</td></tr>`
    ).join("") + `</tbody></table>`;
  }
  function renderEstimatorTargets() {
    const rec = feeRecommendations(entries.map((e) => e.rate));
    const opts = rec ? [["next", rec.next, "Next block"], ["fast", rec.fast, "~10 min"], ["normal", rec.normal, "~1 hr"], ["economy", rec.economy, "Economy"]] : [["fast", 50, "~10 min (sample)"], ["normal", 25, "~1 hr (sample)"]];
    els["e-targets"].innerHTML = opts.map(
      ([k, r, label]) => `<label class="radio"><input type="radio" name="etarget" value="${r}" ${k === "fast" ? "checked" : ""}> ${label} <span class="mono">${fmtGrains(r)} g/vB</span></label>`
    ).join("") + `<label class="radio"><input type="radio" name="etarget" value="custom"> Custom <input id="e-custom" class="inline mono" type="number" min="1" value="20" style="width:6em"> g/vB</label>`;
    els["e-targets"].querySelectorAll('input[name="etarget"]').forEach(
      (r) => r.addEventListener("change", updateEstimator)
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
    els["e-fee"].innerHTML = `<div class="fee-big">${fmtGrains(fee.grains)} <span>grains</span></div>
     <div class="fee-sub mono">\u2248 ${fmtPRL(fee.prl)} PRL @ ${fmtGrains(rate)} g/vB</div>
     <div class="fee-sub">${vsize} vB \xD7 ${fmtGrains(rate)} g/vB \xB7 1 PRL = 100,000,000 grains</div>`;
    const eta = etaForRate(rate, entries);
    els["e-fee"].innerHTML += `<div class="fee-sub">Rough wait at this rate: ${eta.blocks === 0 ? "next block" : "~" + eta.blocks + " blocks"} \u2248 ${fmtDuration(eta.seconds)} (3m14s block target, ~1 MB blocks)</div>`;
  }
  els["e-nin"].addEventListener("input", updateEstimator);
  els["e-nout"].addEventListener("input", updateEstimator);
  els["e-rate"].addEventListener("input", () => {
    document.querySelectorAll('input[name="etarget"]').forEach((r) => {
      if (r.value === "custom") r.checked = true;
      else if (parseFloat(r.value) === parseFloat(els["e-rate"].value)) r.checked = true;
    });
    const c = $("e-custom");
    if (c) c.value = els["e-rate"].value;
    updateEstimator();
  });
  els["e-presets"].querySelectorAll("button").forEach(
    (b) => b.addEventListener("click", () => {
      els["e-nin"].value = b.dataset.nin;
      els["e-nout"].value = b.dataset.nout;
      updateEstimator();
    })
  );
  function renderBumpTargets() {
    const rec = feeRecommendations(entries.map((e) => e.rate));
    const opts = rec ? [["Next block", rec.next], ["~10 min", rec.fast], ["~1 hr", rec.normal]] : [["~10 min", 50], ["~1 hr", 25]];
    els["b-target"].innerHTML = opts.map(([l, r]) => `<option value="${r}">${l} \u2014 ${fmtGrains(r)} g/vB</option>`).join("");
  }
  els["b-run"].addEventListener("click", async () => {
    const txid = els["b-txid"].value.trim();
    els["b-err"].textContent = "";
    els["b-out"].innerHTML = "";
    if (!/^[0-9a-fA-F]{64}$/.test(txid)) {
      els["b-err"].textContent = "Enter a 64-hex-char txid.";
      return;
    }
    const feeRaw = els["b-fee"].value;
    if (!feeRaw.trim()) {
      els["b-err"].textContent = "Enter the fee the stuck transaction paid.";
      return;
    }
    let feeGrains;
    try {
      feeGrains = parseFeeToGrains(feeRaw, els["b-feeunit"].value);
    } catch (e) {
      els["b-err"].textContent = e.message;
      return;
    }
    if (!(feeGrains > 0)) {
      els["b-err"].textContent = "Enter the fee the stuck transaction paid.";
      return;
    }
    let hex = null;
    try {
      hex = await rpc("getrawtransaction", [txid, 0]);
    } catch (e) {
      els["b-err"].textContent = e.message === "no-endpoint" ? "Bump planner needs your pearld RPC endpoint (Settings) to fetch the transaction. Tip: you can paste raw hex below instead \u2014 coming right up." : "Could not fetch tx: " + e.message;
      return;
    }
    let parsed;
    try {
      parsed = parseTxVsize(hex);
    } catch (e) {
      els["b-err"].textContent = "Could not parse transaction hex: " + e.message;
      return;
    }
    const targetRate = parseFloat(els["b-target"].value);
    const plan = bumpPlan({ stuckVsize: parsed.vsize, stuckFeeGrains: feeGrains, targetRate });
    els["b-out"].innerHTML = `
    <div class="plan">
      <h3>Bump plan for <span class="mono">${txid.slice(0, 12)}\u2026${txid.slice(-8)}</span></h3>
      <div class="grid2">
        <div>Size</div><div class="mono">${parsed.vsize} vB (${parsed.nInputs} in / ${parsed.nOutputs} out, ${parsed.segwit ? "segwit" : "legacy"})</div>
        <div>Paid rate</div><div class="mono">${fmtGrains(plan.currentRate)} g/vB (${fmtGrains(feeGrains)} grains)</div>
        <div>Target rate</div><div class="mono">${fmtGrains(targetRate)} g/vB</div>
        <div>Replacement must pay</div><div class="mono"><strong>${fmtGrains(plan.wantFeeGrains)} grains</strong> \u2248 ${fmtPRL(plan.wantFeePRL)} PRL</div>
        <div>Extra fee needed</div><div class="mono"><strong>${fmtGrains(plan.extraGrains)} grains</strong> \u2248 ${fmtPRL(plan.extraPRL)} PRL (${plan.bumpX === Infinity ? "\u2014" : plan.bumpX.toFixed(1) + "\xD7"} current)</div>
        <div>RBF signaled?</div><div>${parsed.rbfSignaled ? "Yes \u2014 at least one input has sequence &lt; 0xfffffffe, so the tx opted into replace-by-fee (if your node's policy honors it)." : "No \u2014 all inputs use final sequence. RBF replacement will be rejected by default policy; use CPFP (spend the stuck output in a high-fee child) instead."}</div>
      </div>
      <p class="hint">This desk plans the numbers \u2014 it never signs or broadcasts. Build the replacement in your wallet (Pearl Sign, Oyster, or your own tooling) and double-check the hex before broadcast.</p>
    </div>`;
  });
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
  var autoTimer = null;
  function armAuto() {
    if (autoTimer) {
      clearInterval(autoTimer);
      autoTimer = null;
    }
    if (settings.auto && settings.endpoint) autoTimer = setInterval(refreshMempool, 3e4);
  }
  els["refresh"].addEventListener("click", refreshMempool);
  els["foot-donate"].textContent = DONATE;
  syncSettingsForm();
  setBadge();
  refreshMempool().then(() => {
    renderBumpTargets();
    armAuto();
  });
  window.PearlFees = { refreshMempool, parseTxVsize, feeRecommendations, estimateVsize };
})();
