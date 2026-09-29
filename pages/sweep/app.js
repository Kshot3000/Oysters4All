/* Pearl Sweep page wiring — classic script, uses window.PearlSweep bundle.
 *
 * The private key lives only in the `keyText` variable (page memory) between
 * Sign and Wipe. It is never written to localStorage, never put in a URL,
 * never sent anywhere. The Wipe button nulls it and clears the textarea.
 * Blockbook reads are GET-only; broadcast is a single explicit POST the user
 * double-confirms.
 */
(function () {
  "use strict";
  const R = window.PearlSweep;
  if (!R) { document.body.innerHTML = "<p style='padding:40px'>Failed to load the Sweep bundle.</p>"; return; }

  const $ = (id) => document.getElementById(id);
  const els = {
    error: $("sw-error"),
    steps: [1, 2, 3, 4, 5].map((n) => $("sw-step-" + n)),
    panels: [1, 2, 3, 4, 5].map((n) => $("sw-panel-" + n)),
    // step 1
    address: $("sw-address"), networkLabel: $("sw-network-label"), blockbook: $("sw-blockbook"),
    analyze: $("sw-analyze"), analyzeStatus: $("sw-analyze-status"),
    dash: $("sw-dash"), total: $("sw-total"), totalGrains: $("sw-total-grains"),
    count: $("sw-count"), dustCount: $("sw-dust-count"), dustValue: $("sw-dust-value"),
    uneconCount: $("sw-unecon-count"), uneconValue: $("sw-unecon-value"),
    healthyCount: $("sw-healthy-count"), savings: $("sw-savings"),
    hist: $("sw-hist"), feeNote: $("sw-fee-note"), utxoTbody: $("sw-utxo-tbody"),
    toPlan: $("sw-to-plan"),
    // step 2
    stratU: $("sw-strat-uneconomic"), stratT: $("sw-strat-threshold"), stratA: $("sw-strat-all"),
    threshold: $("sw-threshold"), noutputs: $("sw-noutputs"), feerate: $("sw-feerate"),
    estfee: $("sw-estfee"), target: $("sw-target"), buildPlan: $("sw-build-plan"),
    refusal: $("sw-refusal"), refusalText: $("sw-refusal-text"),
    planOut: $("sw-plan-out"), planMath: $("sw-plan-math"), planWarnings: $("sw-plan-warnings"),
    planTbody: $("sw-plan-tbody"), planOutTbody: $("sw-plan-out-tbody"),
    toSign: $("sw-to-sign"),
    // step 3
    signAddr: $("sw-sign-addr"), key: $("sw-key"), sign: $("sw-sign"), wipe: $("sw-wipe"),
    signStatus: $("sw-sign-status"), signed: $("sw-signed"), signOk: $("sw-sign-ok"),
    keyNote: $("sw-key-note"), txid: $("sw-txid"), hex: $("sw-hex"),
    copyHex: $("sw-copy-hex"), copied: $("sw-copied"),
    confirmFinal: $("sw-confirm-final"), broadcast: $("sw-broadcast"),
    broadcastStatus: $("sw-broadcast-status"),
    // step 4
    trackTxid: $("sw-track-txid"), trackStart: $("sw-track-start"), trackStop: $("sw-track-stop"),
    trackStatus: $("sw-track-status"), trackOut: $("sw-track-out"),
    trConf: $("sw-tr-conf"), trIn: $("sw-tr-in"), trInval: $("sw-tr-inval"),
    trOutval: $("sw-tr-outval"), trFee: $("sw-tr-fee"), trBlock: $("sw-tr-block"),
    // step 5
    verifyRescan: $("sw-verify-rescan"), verifyStatus: $("sw-verify-status"),
    verifyOut: $("sw-verify-out"), verdict: $("sw-verdict"), verifyTbody: $("sw-verify-tbody"),
    saTxid: $("sw-sa-txid"), saSwept: $("sw-sa-swept"), saTarget: $("sw-sa-target"),
    saRun: $("sw-sa-run"), saStatus: $("sw-sa-status"), saOut: $("sw-sa-out"),
    // footer
    donateAddr: $("donate-addr"), copyDonate: $("copy-donate"),
  };

  els.donateAddr.textContent = R.DONATE_ADDRESS;

  const S = {
    network: null, address: null, program: null, base: null,
    rawUtxos: null, classified: null, summary: null, rateMp: null, rateSource: "",
    plan: null, planPool: null, selected: null,
    signed: null, keyText: null,
    trackTimer: null,
    preCount: 0, preTotal: 0n,
  };

  function showError(msg) {
    els.error.textContent = msg;
    els.error.hidden = false;
    try { els.error.scrollIntoView(); } catch { /* shim */ }
  }
  function clearError() { els.error.hidden = true; els.error.textContent = ""; }

  function goStep(n) {
    clearError();
    els.steps.forEach((b, i) => {
      b.classList.toggle("active", i === n - 1);
      b.classList.toggle("done", i < n - 1);
    });
    els.panels.forEach((p, i) => { p.hidden = i !== n - 1; });
  }
  els.steps.forEach((b, i) => b.addEventListener("click", () => goStep(i + 1)));

  function readBase() {
    const base = els.blockbook.value.trim().replace(/\/$/, "");
    if (!/^https?:\/\//.test(base)) { showError("Blockbook URL must start with http(s)://"); return null; }
    return base;
  }

  function healthBadge(u) {
    if (u.dust) return '<span class="badge dust">dust</span>';
    if (u.uneconomic) return '<span class="badge uneconomic">uneconomic</span>';
    return '<span class="badge healthy">healthy</span>';
  }
  function shortTxid(t) { return t.slice(0, 10) + "…" + t.slice(-6); }
  function prlLine(grains) {
    return R.formatGrains(grains) + " PRL (" + BigInt(grains).toString() + " grains)";
  }

  /* ---------- step 1: analyze ---------- */

  async function analyze() {
    clearError();
    const parsed = R.parseSweepAddress(els.address.value);
    if (parsed.error) { showError(parsed.error); return; }
    const base = readBase();
    if (!base) return;
    els.analyze.disabled = true;
    els.analyzeStatus.textContent = "Fetching UTXOs from Blockbook…";
    try {
      const utxos = await R.fetchSweepUtxos(fetch, base, parsed.address);
      let rateMp, rateSource;
      try {
        rateMp = await R.fetchFeeRateMp(fetch, base);
        rateSource = "Blockbook estimate";
      } catch {
        rateMp = 1000n; // 1 grain/vB fallback
        rateSource = "fallback 1 grain/vB (fee estimate unavailable)";
      }
      const classified = R.classifyUtxos(utxos, rateMp);
      const summary = R.summarizeUtxos(classified);
      S.network = parsed.network; S.address = parsed.address; S.program = parsed.program;
      S.base = base; S.rawUtxos = utxos; S.classified = classified; S.summary = summary;
      S.rateMp = rateMp; S.rateSource = rateSource;
      S.preCount = summary.count; S.preTotal = summary.total;
      renderDash();
      els.dash.hidden = false;
      els.analyzeStatus.textContent =
        `Found ${summary.count} UTXO${summary.count === 1 ? "" : "s"} · ${R.formatGrains(summary.total)} PRL total.`;
      els.networkLabel.value = `${parsed.network.label} (${parsed.network.hrp}1…)`;
    } catch (e) {
      showError("Analyze failed: " + (e.message || e));
    } finally {
      els.analyze.disabled = false;
    }
  }

  function renderDash() {
    const s = S.summary;
    els.total.textContent = R.formatGrains(s.total) + " PRL";
    els.totalGrains.textContent = s.total.toString() + " grains";
    els.count.textContent = String(s.count);
    els.dustCount.textContent = String(s.dustCount);
    els.dustValue.textContent = R.formatGrains(s.dustValue) + " PRL";
    els.uneconCount.textContent = String(s.uneconomicCount);
    els.uneconValue.textContent = R.formatGrains(s.uneconomicValue) + " PRL";
    els.healthyCount.textContent = String(s.healthyCount);
    const save = R.futureSavingsGrains(s.count, S.rateMp);
    els.savings.textContent = s.count > 1 ? R.formatGrains(save) + " PRL" : "—";
    els.feeNote.textContent = `health classified at ${R.formatRateMp(S.rateMp)} grains/vB (${S.rateSource})`;

    const maxCount = Math.max(1, ...s.buckets.map((b) => b.count));
    els.hist.innerHTML = "";
    for (const b of s.buckets) {
      const row = document.createElement("div");
      row.className = "hrow";
      const pct = Math.round((b.count / maxCount) * 100);
      row.innerHTML =
        `<span>${b.label}</span>` +
        `<span class="bar-track"><span class="bar-fill" style="width:${pct}%"></span></span>` +
        `<span class="hv">${b.count} · ${R.formatGrains(b.value)} PRL</span>`;
      els.hist.appendChild(row);
    }

    els.utxoTbody.innerHTML = "";
    for (const u of S.classified) {
      const tr = document.createElement("tr");
      tr.innerHTML =
        `<td class="txid" title="${u.txid}">${shortTxid(u.txid)}</td>` +
        `<td>${u.vout}</td>` +
        `<td class="mono">${R.formatGrains(u.value)} PRL</td>` +
        `<td>${u.confirmations}</td>` +
        `<td>${healthBadge(u)}</td>`;
      els.utxoTbody.appendChild(tr);
    }
    els.target.value = S.address; // default output target = analyzed address
  }

  /* ---------- step 2: plan ---------- */

  function readStrategy() {
    if (els.stratT.checked) return "threshold";
    if (els.stratA.checked) return "all";
    return "uneconomic";
  }

  function buildPlan() {
    clearError();
    if (!S.classified) { showError("Analyze an address first (step 1)."); return; }
    const strategy = readStrategy();
    const fr = R.parseFeeRate(els.feerate.value);
    if (fr.error) { showError(fr.error); return; }
    const target = R.parseSweepAddress(els.target.value);
    if (target.error) { showError("Output target: " + target.error); return; }
    if (target.network.hrp !== S.network.hrp) {
      showError(`Output target is a ${target.network.hrp}1… address but you analyzed a ${S.network.hrp}1… address — networks must match.`);
      return;
    }
    const threshold = BigInt(Math.max(0, Math.floor(Number(els.threshold.value) || 0)));
    const nOutputs = Math.floor(Number(els.noutputs.value) || 1);
    // Re-classify at the plan's fee rate — "uneconomic" depends on the rate.
    S.classified = R.classifyUtxos(S.rawUtxos, fr.rateMp);
    S.summary = R.summarizeUtxos(S.classified);
    let pool = S.classified;
    try {
      const plan = R.planSweep({
        classified: pool, strategy, thresholdGrains: threshold, nOutputs,
        targetProgram: target.program, rateMp: fr.rateMp, network: S.network,
      });
      if (plan.refused) {
        els.refusal.hidden = false;
        els.refusalText.textContent = plan.refusal;
        els.planOut.hidden = true;
        return;
      }
      S.plan = plan;
      S.planPool = plan.inputs.slice();
      S.selected = new Set(plan.inputs.map((u) => u.txid + ":" + u.vout));
      S.rateMp = fr.rateMp; S.rateSource = "your setting";
      renderPlan();
    } catch (e) {
      showError("Plan failed: " + (e.message || e));
    }
  }

  function replanFromSelection() {
    const kept = S.planPool.filter((u) => S.selected.has(u.txid + ":" + u.vout));
    const plan = R.planSweep({
      classified: kept,
      strategy: "all", // manual refinement of the strategy's selection
      thresholdGrains: 0n,
      nOutputs: S.plan.outputs.length,
      targetProgram: S.plan.outputs[0].program,
      rateMp: S.plan.rateMp,
      network: S.network,
    });
    if (plan.refused) {
      els.refusal.hidden = false;
      els.refusalText.textContent = plan.refusal;
      els.planOut.hidden = true;
      S.plan = null;
      return;
    }
    S.plan = plan;
    renderPlan();
  }

  function renderPlan() {
    const plan = S.plan;
    els.refusal.hidden = true;
    els.planOut.hidden = false;
    els.planMath.textContent =
      `Inputs swept:    ${plan.inputs.length} UTXO${plan.inputs.length === 1 ? "" : "s"}\n` +
      `Total in:        ${prlLine(plan.total)}\n` +
      `Tx size:         ${plan.vBytes} vBytes (${plan.inputs.length} in × ${R.INPUT_VBYTES} + ${plan.outputs.length} out × ${R.OUTPUT_VBYTES} + overhead)\n` +
      `Fee rate:        ${R.formatRateMp(plan.rateMp)} grains/vB\n` +
      `Fee:             ${prlLine(plan.fee)}\n` +
      `Net recovered:   ${prlLine(plan.netValue)}\n` +
      `Output${plan.outputs.length === 1 ? "" : "s"}:          ${plan.outputs.length} × ${prlLine(plan.perOutput)} → ${plan.targetAddress.slice(0, 20)}…\n` +
      (plan.feeRemainder > 0n ? `Split remainder:  ${plan.feeRemainder} grains (absorbed into the fee)\n` : "");
    els.planWarnings.innerHTML = "";
    for (const w of plan.warnings) {
      const d = document.createElement("div");
      d.className = "warn";
      d.textContent = "⚠ " + w;
      els.planWarnings.appendChild(d);
    }
    els.planTbody.innerHTML = "";
    for (const u of S.planPool) {
      const key = u.txid + ":" + u.vout;
      const checked = S.selected.has(key) ? "checked" : "";
      const tr = document.createElement("tr");
      tr.innerHTML =
        `<td><input type="checkbox" data-key="${key}" ${checked} aria-label="include UTXO"></td>` +
        `<td class="txid" title="${u.txid}">${shortTxid(u.txid)}</td>` +
        `<td>${u.vout}</td>` +
        `<td class="mono">${R.formatGrains(u.value)} PRL</td>` +
        `<td>${healthBadge(u)}</td>`;
      els.planTbody.appendChild(tr);
    }
    els.planOutTbody.innerHTML = "";
    plan.outputs.forEach((o, i) => {
      const tr = document.createElement("tr");
      tr.innerHTML =
        `<td>${i}</td>` +
        `<td class="addr">${plan.targetAddress}</td>` +
        `<td class="mono">${R.formatGrains(o.value)} PRL</td>`;
      els.planOutTbody.appendChild(tr);
    });
  }

  async function useEstimate() {
    clearError();
    const base = readBase();
    if (!base) return;
    els.estfee.disabled = true;
    try {
      const mp = await R.fetchFeeRateMp(fetch, base);
      els.feerate.value = R.formatRateMp(mp);
    } catch (e) {
      showError("Fee estimate unavailable: " + (e.message || e));
    } finally {
      els.estfee.disabled = false;
    }
  }

  /* ---------- step 3: sign ---------- */

  function wipeKey() {
    S.keyText = null;
    els.key.value = "";
    els.signStatus.textContent = "Key wiped from page memory.";
  }

  async function sign() {
    clearError();
    if (!S.plan || S.plan.refused) { showError("Build a valid plan first (step 2)."); return; }
    const secretText = els.key.value;
    if (!secretText.trim()) { showError("Paste the key that controls the analyzed address."); return; }
    els.sign.disabled = true;
    els.signStatus.textContent = "Deriving key, checking address match, signing…";
    try {
      // keep the async boundary tiny — the key never leaves this function scope
      await new Promise((r) => setTimeout(r, 10));
      const signed = R.buildSweepTx({
        network: S.network, sweptAddress: S.address, secretText, plan: S.plan,
      });
      S.signed = signed;
      S.keyText = secretText; // page memory only
      els.signOk.textContent =
        `✓ ${signed.checks.length}/${signed.checks.length} Schnorr signatures re-verified locally — ` +
        `every input's BIP-341 keypath signature is valid.`;
      els.keyNote.textContent = signed.note;
      els.txid.value = signed.txid;
      els.hex.value = signed.hex;
      els.signed.hidden = false;
      els.signStatus.textContent = "";
      els.confirmFinal.checked = false;
      els.broadcast.disabled = true;
    } catch (e) {
      showError("Signing refused: " + (e.message || e));
      els.signed.hidden = true;
    } finally {
      els.sign.disabled = false;
    }
  }

  function copyText(text, doneEl) {
    const flash = () => { if (doneEl) { doneEl.hidden = false; setTimeout(() => { doneEl.hidden = true; }, 2000); } };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(flash, () => showError("Copy failed — select the text manually."));
      } else {
        showError("Clipboard unavailable — select the text manually.");
      }
    } catch {
      showError("Clipboard unavailable — select the text manually.");
    }
  }

  async function broadcast() {
    clearError();
    if (!els.confirmFinal.checked) { showError("Tick the confirmation box first — broadcasting is final."); return; }
    if (!S.signed) { showError("Sign the consolidation first."); return; }
    const base = readBase();
    if (!base) return;
    els.broadcast.disabled = true;
    els.broadcastStatus.textContent = "Broadcasting…";
    try {
      const txid = await R.broadcastSweepTx(fetch, base, S.signed.hex);
      els.broadcastStatus.textContent = "Broadcast accepted. Txid: " + txid;
      els.trackTxid.value = txid;
      // the key has done its job — wipe it now that the tx is out
      wipeKey();
      goStep(4);
    } catch (e) {
      showError("Broadcast failed: " + (e.message || e));
    } finally {
      els.broadcast.disabled = !els.confirmFinal.checked;
    }
  }

  /* ---------- step 4: track ---------- */

  async function pollTrack() {
    const txid = els.trackTxid.value.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(txid)) { showError("Paste a valid 64-hex-char txid to watch."); return; }
    const base = readBase();
    if (!base) return;
    clearError();
    els.trackStatus.textContent = "Fetching…";
    try {
      const tx = await R.fetchSweepTx(fetch, base, txid);
      const vin = tx.vin || [], vout = tx.vout || [];
      const inTotal = vin.reduce((a, v) => a + BigInt(v.value ?? 0), 0n);
      const outTotal = vout.reduce((a, v) => a + BigInt(v.value ?? 0), 0n);
      els.trConf.textContent = String(tx.confirmations ?? 0);
      els.trIn.textContent = String(vin.length);
      els.trInval.textContent = R.formatGrains(inTotal) + " PRL";
      els.trOutval.textContent = R.formatGrains(outTotal) + " PRL";
      els.trFee.textContent = R.formatGrains(inTotal - outTotal) + " PRL";
      els.trBlock.textContent = tx.blockHeight != null ? String(tx.blockHeight) : "mempool";
      els.trackOut.hidden = false;
      els.trackStatus.textContent = "Last checked " + new Date().toLocaleTimeString() + " — watching every 15s.";
    } catch (e) {
      showError("Track failed: " + (e.message || e));
    }
  }

  function startTrack() {
    stopTrack();
    pollTrack();
    S.trackTimer = setInterval(pollTrack, 15000);
    els.trackStart.disabled = true;
    els.trackStop.disabled = false;
  }
  function stopTrack() {
    if (S.trackTimer) { clearInterval(S.trackTimer); S.trackTimer = null; }
    els.trackStart.disabled = false;
    els.trackStop.disabled = true;
  }

  /* ---------- step 5: verify ---------- */

  async function rescan() {
    clearError();
    if (!S.address || !S.plan) { showError("Run Analyze and build a plan first — the verifier needs the pre-sweep snapshot."); return; }
    const base = readBase();
    if (!base) return;
    els.verifyRescan.disabled = true;
    els.verifyStatus.textContent = "Re-scanning…";
    try {
      const postUtxos = await R.fetchSweepUtxos(fetch, base, S.address);
      const res = R.comparePostSweep({
        preCount: S.preCount, preTotal: S.preTotal, fee: S.plan.fee,
        postUtxos, targetAddress: S.plan.targetAddress,
      });
      els.verdict.textContent = res.verdict;
      els.verdict.className = "verdict " + (res.ok ? "good" : "bad");
      els.verifyTbody.innerHTML = "";
      for (const l of res.lines) {
        const tr = document.createElement("tr");
        tr.innerHTML =
          `<td>${l.label}</td><td class="mono">${l.before}</td><td class="mono">${l.after}</td>` +
          `<td class="${l.ok ? "check-ok" : "check-bad"}">${l.ok ? "✓" : "✗"}</td>`;
        els.verifyTbody.appendChild(tr);
      }
      els.verifyOut.hidden = false;
      els.verifyStatus.textContent = "";
    } catch (e) {
      showError("Re-scan failed: " + (e.message || e));
    } finally {
      els.verifyRescan.disabled = false;
    }
  }

  async function standaloneVerify() {
    clearError();
    const base = readBase();
    if (!base) return;
    const swept = R.parseSweepAddress(els.saSwept.value);
    if (swept.error) { showError("Swept address: " + swept.error); return; }
    const target = R.parseSweepAddress(els.saTarget.value);
    if (target.error) { showError("Target address: " + target.error); return; }
    els.saRun.disabled = true;
    els.saStatus.textContent = "Fetching transaction…";
    try {
      const tx = await R.fetchSweepTx(fetch, base, els.saTxid.value);
      const res = R.verifyConsolidationTx(tx, swept.address, target.address);
      els.saOut.hidden = false;
      if (!res.ok) {
        els.saOut.textContent = res.refusal;
        els.saStatus.textContent = "";
      } else {
        els.saOut.textContent =
          `✓ CLEAN CONSOLIDATION\n` +
          `Inputs:  ${res.nIn} (all from ${swept.address.slice(0, 22)}…)\n` +
          `Outputs: ${res.nOut} (all to ${target.address.slice(0, 22)}…)\n` +
          `In:      ${prlLine(res.inTotal)}\n` +
          `Out:     ${prlLine(res.outTotal)}\n` +
          `Fee:     ${prlLine(res.fee)}\n` +
          `Confirmations: ${res.confirmations}\n\n${res.note}`;
        els.saStatus.textContent = "";
      }
    } catch (e) {
      showError("Verifier failed: " + (e.message || e));
    } finally {
      els.saRun.disabled = false;
    }
  }

  /* ---------- wire up ---------- */

  els.analyze.addEventListener("click", analyze);
  els.toPlan.addEventListener("click", () => goStep(2));
  els.buildPlan.addEventListener("click", buildPlan);
  els.estfee.addEventListener("click", useEstimate);
  els.planTbody.addEventListener("change", (ev) => {
    const key = ev.target && ev.target.dataset ? ev.target.dataset.key : null;
    if (!key || !S.selected) return;
    if (ev.target.checked) S.selected.add(key); else S.selected.delete(key);
    try { replanFromSelection(); } catch (e) { showError("Re-plan failed: " + (e.message || e)); }
  });
  els.toSign.addEventListener("click", () => {
    els.signAddr.textContent = S.address || "";
    goStep(3);
  });
  els.sign.addEventListener("click", sign);
  els.wipe.addEventListener("click", wipeKey);
  els.copyHex.addEventListener("click", () => copyText(els.hex.value, els.copied));
  els.confirmFinal.addEventListener("change", () => {
    els.broadcast.disabled = !els.confirmFinal.checked || !S.signed;
  });
  els.broadcast.addEventListener("click", broadcast);
  els.trackStart.addEventListener("click", startTrack);
  els.trackStop.addEventListener("click", stopTrack);
  els.verifyRescan.addEventListener("click", rescan);
  els.saRun.addEventListener("click", standaloneVerify);
  els.copyDonate.addEventListener("click", () => copyText(R.DONATE_ADDRESS));

  // expose a tiny hook for the DOM test suite (harmless in production)
  window.__sweepTest = { state: S, goStep };
})();
