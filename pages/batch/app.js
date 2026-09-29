/* Pearl Batch page wiring — classic script, uses window.PearlBatch bundle.
 *
 * Five steps: Manifest -> Freight -> Review -> Sign -> Broadcast.
 * Secrets (mnemonics, WIFs, xprvs, hex keys) live only in page memory between
 * entry and Wipe/signing; they are never written to storage, never put in a
 * URL, never sent anywhere. Blockbook reads are GET-only; broadcast is a
 * single explicit POST behind a double-confirm checkbox. All crypto runs
 * through the audited Pearl Sign lineage (bundled as window.PearlBatch).
 */
(function () {
  "use strict";
  const R = window.PearlBatch;
  if (!R) { document.body.innerHTML = "<p style='padding:40px'>Failed to load the Batch bundle.</p>"; return; }

  const $ = (id) => document.getElementById(id);
  const store = {
    get(k) { try { return typeof localStorage !== "undefined" ? localStorage.getItem(k) : null; } catch (e) { return null; } },
    set(k, v) { try { if (typeof localStorage !== "undefined") localStorage.setItem(k, v); } catch (e) {} },
  };

  const state = {
    network: "mainnet", blockbook: "", feeRate: 20,
    manifest: null,            // {recipients, merged, total}
    senderAddress: "",
    utxos: [],                 // {txid, vout, value, confirmations, checked}
    autoSelect: true,
    plan: null,
    bundle: null,
    fingerprint: "",
    signed: null,              // {txid, hex}
    broadcastTxid: "",
    secret: null,              // held in memory only
    trackTimer: null,
  };

  /* ---------- helpers ---------- */

  const net = () => R.NETWORKS[state.network];
  const shortAddr = (a) => a.length > 22 ? a.slice(0, 14) + "…" + a.slice(-6) : a;
  const shortTxid = (t) => t.slice(0, 10) + "…" + t.slice(-6);
  function showErr(id, msg) { const e = $(id); e.textContent = msg; e.hidden = false; }
  function hideErr(id) { $(id).hidden = true; }
  function feeRate() {
    const r = Math.ceil(Number($("feerate").value));
    if (!Number.isFinite(r) || r <= 0) throw new Error("fee rate must be a positive number of grains/vB");
    return r;
  }
  const STEPS = ["manifest", "freight", "review", "sign", "broadcast"];
  function goto(step) {
    STEPS.forEach((s) => { const b = $("st-" + s); if (b) b.classList.toggle("active", s === step); });
    STEPS.forEach((s) => { const p = $("step-" + s); if (p) p.hidden = s !== step; });
    const el = $("step-" + step);
    if (el && el.scrollIntoView) el.scrollIntoView({ block: "start" });
  }
  async function copyText(text, msg) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return; }
    } catch (e) { /* fall through */ }
    const ta = document.createElement("textarea");
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch (e) {}
    ta.remove();
  }
  document.querySelectorAll("[data-copy]").forEach((b) => {
    b.addEventListener("click", () => {
      const t = $(b.dataset.copy);
      const text = t ? (t.value !== undefined ? t.value : t.textContent) : "";
      copyText(text);
    });
  });

  /* ---------- config strip ---------- */

  function loadConfig() {
    const savedBb = store.get("pearl-batch:blockbook");
    const savedRate = store.get("pearl-batch:feerate");
    $("blockbook").value = savedBb || R.NETWORKS.mainnet.blockbook;
    if (savedRate) $("feerate").value = savedRate;
    state.blockbook = $("blockbook").value.trim();
    try { state.feeRate = feeRate(); } catch (e) { state.feeRate = 20; }
  }
  $("blockbook").addEventListener("change", () => {
    state.blockbook = $("blockbook").value.trim();
    store.set("pearl-batch:blockbook", state.blockbook);
    $("cfg-msg").textContent = state.blockbook ? "Blockbook endpoint saved (this browser only)." : "No Blockbook endpoint — online reads disabled, paste mode still works.";
  });
  $("feerate").addEventListener("change", () => {
    try { state.feeRate = feeRate(); store.set("pearl-batch:feerate", String(state.feeRate)); $("cfg-msg").textContent = ""; }
    catch (e) { $("cfg-msg").textContent = e.message; }
  });
  $("network").addEventListener("change", () => {
    state.network = $("network").value;
    resetWorkflow();
    $("cfg-msg").textContent = `Network: ${net().label} (${net().hrp}1…) — workflow reset.`;
    if (!net().blockbook) $("cfg-msg").textContent += " No default Blockbook on testnet — configure one or use paste mode.";
  });
  $("fee-estimate").addEventListener("click", async () => {
    const bb = $("blockbook").value.trim();
    if (!bb) { $("cfg-msg").textContent = "Set a Blockbook endpoint first (or keep the manual fee rate)."; return; }
    $("cfg-msg").textContent = "Estimating…";
    try {
      const r = await R.fetchFeeRate(bb, 2);
      const g = Math.max(1, Math.ceil(r));
      $("feerate").value = String(g);
      state.feeRate = g;
      store.set("pearl-batch:feerate", String(g));
      $("cfg-msg").textContent = `Fee estimate: ${g} grains/vB (2-block target, rounded up).`;
    } catch (e) {
      $("cfg-msg").textContent = "Estimate failed: " + (e.message || e) + " — keep the manual rate.";
    }
  });
  function wipeKeys(silent) {
    state.secret = null;
    $("s-key").value = "";
    $("s-key-addr").textContent = "";
    if (!silent) { $("wipe-msg").textContent = "Keys wiped from page memory."; setTimeout(() => { $("wipe-msg").textContent = ""; }, 4000); }
  }
  $("wipe").addEventListener("click", () => wipeKeys(false));

  function resetWorkflow() {
    wipeKeys(true);
    state.manifest = null; state.senderAddress = ""; state.utxos = [];
    state.plan = null; state.bundle = null; state.fingerprint = "";
    state.signed = null; state.broadcastTxid = "";
    stopTracking();
    ["m-out", "f-out", "r-out", "s-out", "b-ready", "b-track", "b-verify-out", "v-out"].forEach((id) => { $(id).hidden = true; });
    $("b-send").disabled = true; $("b-confirm").checked = false; $("r-confirm").checked = false; $("r-next").disabled = true;
  }

  /* ---------- step 1: manifest ---------- */

  $("m-sample").addEventListener("click", () => { $("m-text").value = R.sampleManifest(); });
  $("m-import").addEventListener("click", () => { if (typeof FileReader !== "undefined") $("m-file").click(); else showErr("m-err", "File import needs a real browser FileReader."); });
  $("m-file").addEventListener("change", () => {
    const f = $("m-file").files && $("m-file").files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => { $("m-text").value = String(rd.result || ""); };
    rd.readAsText(f);
  });
  $("m-parse").addEventListener("click", () => {
    hideErr("m-err"); $("m-out").hidden = true;
    try {
      const m = R.parseRecipients($("m-text").value, net(), { mergeDuplicates: $("m-merge").checked });
      state.manifest = m;
      state.mergeDuplicates = $("m-merge").checked;
      $("m-count").textContent = String(m.recipients.length);
      $("m-total").textContent = `${R.fmtPRL(m.total)} PRL (${m.total.toString()} grains)`;
      $("m-merged").textContent = m.merged === 0 ? "none — all addresses unique" : `${m.merged} duplicate line(s) merged into one output each`;
      const tb = $("m-tbody"); tb.innerHTML = "";
      m.recipients.forEach((r, i) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `<td class="mut">${i + 1}</td><td class="addr-short" title="${r.address}">${shortAddr(r.address)}</td>` +
          `<td>${R.fmtPRL(r.amount)} <span class="mut">PRL</span></td><td class="mut">${r.memo ? escapeHtml(r.memo) : "—"}</td>`;
        tb.appendChild(tr);
      });
      $("m-out").hidden = false;
    } catch (e) {
      state.manifest = null;
      showErr("m-err", "MANIFEST REFUSED: " + (e.message || e));
    }
  });
  $("m-copy").addEventListener("click", () => copyText($("m-text").value));
  $("m-next").addEventListener("click", () => { goto("freight"); });

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  /* ---------- step 2: freight ---------- */

  function selectedUtxos() {
    if (state.autoSelect) {
      const r = R.autoSelectUtxos(state.utxos, state.manifest.total, feeRate(), state.manifest.recipients.length);
      return r.selected;
    }
    const sel = state.utxos.filter((u) => u.checked);
    if (!sel.length) throw new Error("no inputs selected — check at least one UTXO or enable auto-load");
    return sel;
  }

  function renderUtxos() {
    const tb = $("f-tbody"); tb.innerHTML = "";
    state.utxos.forEach((u, i) => {
      const tr = document.createElement("tr");
      if (u.checked) tr.classList.add("sel");
      const cb = document.createElement("input");
      cb.type = "checkbox"; cb.checked = !!u.checked; cb.disabled = state.autoSelect;
      cb.addEventListener("change", () => { u.checked = cb.checked; tr.classList.toggle("sel", cb.checked); renderTotals(); });
      const td0 = document.createElement("td"); td0.appendChild(cb); tr.appendChild(td0);
      tr.insertAdjacentHTML("beforeend",
        `<td class="mut">${i + 1}</td><td title="${u.txid}">${shortTxid(u.txid)}</td>` +
        `<td>${u.vout}</td><td>${R.fmtPRL(BigInt(u.value))} <span class="mut">PRL</span></td><td class="mut">${u.confirmations ?? "?"}</td>`);
      tb.appendChild(tr);
    });
    $("f-out").hidden = state.utxos.length === 0;
    renderTotals();
  }

  function renderTotals() {
    const kv = $("f-totals");
    hideErr("f-cover-err");
    if (!state.manifest) { kv.innerHTML = "<div><dt>Manifest</dt><dd>validate the manifest first (step 1)</dd></div>"; return; }
    try {
      const sel = selectedUtxos();
      const plan = R.planDispatch({
        utxos: sel, recipients: state.manifest.recipients,
        senderProgram: R.decodeBech32m(state.senderAddress, net().hrp).program,
        feeRateGrainsPerVByte: feeRate(), network: net(),
      });
      const inSum = sel.reduce((a, u) => a + BigInt(u.value), 0n);
      kv.innerHTML =
        `<div><dt>Recipients</dt><dd>${plan.nOut - (plan.changeDropped ? 0 : 1)} → ${R.fmtPRL(plan.sumOut)} PRL</dd></div>` +
        `<div><dt>Inputs selected</dt><dd>${sel.length} UTXO(s) → ${R.fmtPRL(inSum)} PRL</dd></div>` +
        `<div><dt>Fee</dt><dd>${plan.fee} grains (${R.fmtPRL(plan.fee)} PRL) @ ${plan.feeRate} gr/vB × ${plan.vBytes} vB</dd></div>` +
        `<div><dt>Change</dt><dd>${plan.changeDropped ? `dust absorbed into fee (+${plan.changeBump} grains)` : R.fmtPRL(plan.change) + " PRL back to sender"}</dd></div>` +
        `<div><dt>Coverage</dt><dd style="color:var(--go)">OK — inputs = outputs + fee, grain-exact</dd></div>`;
    } catch (e) {
      kv.innerHTML = `<div><dt>Coverage</dt><dd style="color:var(--stop)">SHORTFALL</dd></div>`;
      showErr("f-cover-err", "NOT COVERED: " + (e.message || e));
    }
  }

  function setUtxos(list) {
    state.utxos = list.map((u) => ({ txid: String(u.txid).toLowerCase(), vout: u.vout, value: u.value, confirmations: u.confirmations ?? 0, checked: true }));
    renderUtxos();
  }

  function requireSender() {
    const a = $("f-sender").value.trim();
    if (!a) throw new Error("enter the sender's PRL address first");
    const canon = R.canonicalAddress(a, net());
    state.senderAddress = canon;
    return canon;
  }

  $("f-fetch").addEventListener("click", async () => {
    hideErr("f-err"); $("f-fetch-msg").textContent = "";
    try {
      const addr = requireSender();
      const bb = $("blockbook").value.trim();
      if (!bb) throw new Error("no Blockbook endpoint configured — paste UTXOs below instead (air-gapped)");
      $("f-fetch-msg").textContent = "Fetching…";
      const list = await R.fetchUtxos(bb, addr);
      if (!list.length) throw new Error("Blockbook reports no UTXOs for this address — nothing to spend");
      setUtxos(list);
      $("f-fetch-msg").textContent = `Loaded ${list.length} UTXO(s) (GET-only).`;
    } catch (e) {
      $("f-fetch-msg").textContent = "";
      showErr("f-err", "FETCH FAILED: " + (e.message || e));
    }
  });
  $("f-parse-paste").addEventListener("click", () => {
    hideErr("f-err");
    try {
      requireSender();
      const list = R.parseUtxoList($("f-paste").value, net());
      if (!list.length) throw new Error("no UTXO lines parsed");
      setUtxos(list);
    } catch (e) { showErr("f-err", "PASTE REFUSED: " + (e.message || e)); }
  });
  $("f-auto").addEventListener("change", () => { state.autoSelect = $("f-auto").checked; renderUtxos(); });
  $("f-all").addEventListener("click", () => { state.utxos.forEach((u) => { u.checked = true; }); renderUtxos(); });
  $("f-none").addEventListener("click", () => { state.utxos.forEach((u) => { u.checked = false; }); renderUtxos(); });
  $("f-next").addEventListener("click", () => {
    if (!state.manifest) { goto("manifest"); return; }
    try {
      requireSender();
      const sel = selectedUtxos();
      const plan = R.planDispatch({
        utxos: sel, recipients: state.manifest.recipients,
        senderProgram: R.decodeBech32m(state.senderAddress, net().hrp).program,
        feeRateGrainsPerVByte: feeRate(), network: net(),
      });
      state.plan = plan;
      renderReview();
      goto("review");
    } catch (e) { showErr("f-err", "DISPATCH REFUSED: " + (e.message || e)); }
  });

  /* ---------- step 3: review ---------- */

  function renderReview() {
    const plan = state.plan, m = state.manifest;
    $("r-refusal").hidden = true; $("r-out").hidden = true;
    const bal = plan.total - (plan.sumOut + plan.fee + plan.change);
    if (bal !== 0n) {
      const r = $("r-refusal");
      r.textContent = `BILL OF LADING REFUSED — inputs (${R.fmtPRL(plan.total)} PRL) do not equal recipients + fee + change. This should be impossible; the plan was not sealed.`;
      r.hidden = false; return;
    }
    $("r-summary").innerHTML =
      `<div><dt>Sender</dt><dd title="${state.senderAddress}">${shortAddr(state.senderAddress)}</dd></div>` +
      `<div><dt>Network</dt><dd>${net().label} (${net().hrp}1…)</dd></div>` +
      `<div><dt>Inputs</dt><dd>${plan.nIn} UTXO(s) → ${R.fmtPRL(plan.total)} PRL</dd></div>` +
      `<div><dt>Recipients</dt><dd>${m.recipients.length} → ${R.fmtPRL(plan.sumOut)} PRL</dd></div>` +
      `<div><dt>Balance check</dt><dd style="color:var(--go)">inputs = recipients + fee + change — exact to the grain</dd></div>`;
    $("r-rcount").textContent = `(${m.recipients.length})`;
    const tb = $("r-tbody"); tb.innerHTML = "";
    m.recipients.forEach((r, i) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td class="mut">${i + 1}</td><td class="addr-short" title="${r.address}">${shortAddr(r.address)}</td>` +
        `<td>${R.fmtPRL(r.amount)} <span class="mut">PRL</span></td><td class="mut">${r.memo ? escapeHtml(r.memo) : "—"}</td>`;
      tb.appendChild(tr);
    });
    $("r-icount").textContent = `(${plan.inputs.length})`;
    const ib = $("r-itbody"); ib.innerHTML = "";
    plan.inputs.forEach((u, i) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td class="mut">${i + 1}</td><td title="${u.txid}">${shortTxid(u.txid)}</td><td>${u.vout}</td><td>${R.fmtPRL(BigInt(u.value))} <span class="mut">PRL</span></td>`;
      ib.appendChild(tr);
    });
    $("r-fee").innerHTML =
      `<div><dt>vBytes</dt><dd>${plan.vBytes} vB — keypathTxVBytes(${plan.nIn} in, ${plan.nOut} out)</dd></div>` +
      `<div><dt>Rate</dt><dd>${plan.feeRate} grains/vB</dd></div>` +
      `<div><dt>Fee</dt><dd>${plan.fee} grains = ${R.fmtPRL(plan.fee)} PRL</dd></div>` +
      `<div><dt>Change</dt><dd>${plan.changeDropped ? `dust change absorbed into the fee (+${plan.changeBump} grains)` : R.fmtPRL(plan.change) + " PRL → sender"}</dd></div>`;
    const dn = $("r-dust-note");
    if (plan.changeDropped) {
      dn.textContent = `Note: the change output would have been ${plan.changeBump} grains — below the 546-grain dust floor — so it was added to the miner fee instead of creating an unspendable output.`;
      dn.hidden = false;
    } else dn.hidden = true;
    $("r-stamp").textContent = "UNSEALED";
    $("r-stamp").className = "stamp warn";
    $("r-confirm").checked = false; $("r-next").disabled = true;
    $("r-out").hidden = false;
  }
  $("r-confirm").addEventListener("change", () => { $("r-next").disabled = !$("r-confirm").checked; });
  $("r-export").addEventListener("click", () => {
    if (!state.plan) return;
    buildBundle();
    goto("sign");
  });
  $("r-next").addEventListener("click", () => {
    if (!state.plan) return;
    buildBundle();
    goto("sign");
  });

  function buildBundle() {
    const bundle = R.exportUnsignedBundle({
      network: net(), senderAddress: state.senderAddress,
      recipients: state.manifest.recipients, plan: state.plan, feeRate: state.plan.feeRate,
    });
    state.bundle = bundle;
    state.fingerprint = bundle.fingerprint;
    $("s-fp").textContent = bundle.fingerprint;
    $("s-unsigned-txid").textContent = bundle.unsignedTxid;
    $("s-bundle").value = JSON.stringify(bundle, null, 2);
  }

  /* ---------- step 4: sign ---------- */

  $("s-download").addEventListener("click", () => {
    if (!state.bundle) return;
    const blob = new Blob([JSON.stringify(state.bundle, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `pearl-batch-unsigned-${state.fingerprint}.json`;
    document.body.appendChild(a); a.click(); a.remove();
  });

  $("s-import-btn").addEventListener("click", () => {
    hideErr("s-import-err"); $("s-import-ok").hidden = true;
    try {
      const raw = $("s-import").value.trim();
      if (!raw) throw new Error("paste a bundle JSON first");
      const wantFp = $("s-import-fp").value.trim().toLowerCase();
      if (wantFp) {
        let probe;
        try { probe = JSON.parse(raw); } catch (e) { throw new Error("bundle is not valid JSON"); }
        if (String(probe.fingerprint || "").toLowerCase() !== wantFp) {
          throw new Error(`FINGERPRINT MISMATCH — expected ${wantFp}, bundle carries ${probe.fingerprint}. Refusing to load.`);
        }
      }
      const imp = R.importUnsignedBundle(raw);
      if (imp.network.id !== state.network) {
        state.network = imp.network.id;
        $("network").value = state.network;
      }
      state.senderAddress = imp.senderAddress;
      state.manifest = { recipients: imp.recipients, merged: 0, total: imp.recipients.reduce((a, r) => a + r.amount, 0n) };
      state.plan = imp.plan;
      state.fingerprint = imp.fingerprint;
      state.bundle = R.exportUnsignedBundle({ network: imp.network, senderAddress: imp.senderAddress, recipients: imp.recipients, plan: imp.plan, feeRate: imp.feeRate });
      $("s-fp").textContent = imp.fingerprint;
      $("s-unsigned-txid").textContent = state.bundle.unsignedTxid;
      $("s-bundle").value = JSON.stringify(state.bundle, null, 2);
      $("f-sender").value = imp.senderAddress;
      const ok = $("s-import-ok");
      ok.textContent = `Bundle verified & loaded: fingerprint ${imp.fingerprint}, unsigned txid ${state.bundle.unsignedTxid.slice(0, 16)}…, ` +
        `${imp.recipients.length} recipients, fee ${imp.plan.fee} grains, ${imp.plan.vBytes} vB — all cross-checks passed.`;
      ok.hidden = false;
    } catch (e) {
      showErr("s-import-err", "BUNDLE REFUSED: " + (e.message || e));
    }
  });

  $("s-gen").addEventListener("click", () => {
    const mn = R.newMnemonic();
    $("s-key").value = mn;
    const ko = $("s-key-out");
    ko.textContent = "Fresh sender key (BIP-39, write it down — shown once): " + mn;
    ko.hidden = false;
  });

  $("s-sign").addEventListener("click", () => {
    hideErr("s-err"); $("s-out").hidden = true; $("s-key-out").hidden = true;
    try {
      if (!state.plan) throw new Error("no dispatch plan — build one from the Review step (or import a bundle) first");
      const secret = R.parseBatchSecret($("s-key").value, net());
      $("s-key-addr").textContent = `key → ${shortAddr(secret.address)}`;
      R.assertKeyControlsAddress(secret, state.senderAddress);
      const signed = R.buildBatchTx({ secret, senderAddress: state.senderAddress, utxos: state.plan.inputs, plan: state.plan, network: net() });
      state.secret = null; // wipe before exposing anything
      wipeKeys(true);
      state.signed = signed;
      $("s-verify").textContent = `${signed.plan.inputs.length}/${signed.plan.inputs.length} Schnorr signatures re-verified locally (BIP-341 keypath)`;
      $("s-txid").textContent = signed.txid;
      $("s-hex").value = signed.hex;
      $("s-out").hidden = false;
      $("r-stamp").textContent = "SEALED";
      $("r-stamp").className = "stamp ok";
    } catch (e) {
      showErr("s-err", "SIGNING REFUSED: " + (e.message || e));
    }
  });
  $("s-next").addEventListener("click", () => {
    if (!state.signed) return;
    $("b-txid").textContent = state.signed.txid;
    $("b-nrecip").textContent = String(state.manifest.recipients.length);
    $("b-total").textContent = `${R.fmtPRL(state.plan.sumOut)} PRL`;
    $("b-fee").textContent = `${state.plan.fee} grains (${R.fmtPRL(state.plan.fee)} PRL)`;
    $("b-net").textContent = net().label;
    $("b-pearld-cmd").textContent =
      `curl -s --user RPCUSER:RPCPASS -H 'content-type: application/json' \\\n` +
      `  --data '{"jsonrpc":"1.0","id":"pearl-batch","method":"sendrawtransaction","params":["${state.signed.hex}"]}' \\\n` +
      `  http://127.0.0.1:44107/`;
    $("b-ready").hidden = false;
    $("b-confirm").checked = false; $("b-send").disabled = true;
    goto("broadcast");
  });

  /* ---------- step 5: broadcast ---------- */

  $("b-confirm").addEventListener("change", () => { $("b-send").disabled = !$("b-confirm").checked; });
  $("b-send").addEventListener("click", async () => {
    hideErr("b-err");
    if (!state.signed) return;
    const bb = $("blockbook").value.trim();
    if (!bb) { showErr("b-err", "No Blockbook endpoint configured — use the pearld command below instead."); return; }
    $("b-send").disabled = true;
    try {
      const txid = await R.broadcastViaBlockbook(bb, state.signed.hex);
      state.broadcastTxid = txid;
      if (txid !== state.signed.txid) throw new Error(`node returned a different txid (${txid}) than the signed one — investigate before continuing`);
      const st = $("b-stamp"); st.textContent = "BROADCAST · " + txid.slice(0, 12) + "…"; st.className = "stamp ok";
      $("b-track").hidden = false;
      $("b-track-kv").innerHTML = `<div><dt>TXID</dt><dd>${txid}</dd></div><div><dt>Status</dt><dd>broadcast accepted — start tracking to verify on-chain</dd></div>`;
    } catch (e) {
      $("b-send").disabled = false;
      showErr("b-err", "BROADCAST FAILED: " + (e.message || e));
    }
  });

  function stopTracking() {
    if (state.trackTimer) { clearInterval(state.trackTimer); state.trackTimer = null; }
  }
  async function trackOnce() {
    const txid = state.broadcastTxid || (state.signed && state.signed.txid);
    if (!txid) { $("b-track-msg").textContent = "Nothing to track yet."; return; }
    const bb = $("blockbook").value.trim();
    if (!bb) { $("b-track-msg").textContent = "No Blockbook endpoint — cannot track."; return; }
    try {
      const res = await fetch(bb.replace(/\/$/, "") + "/api/v2/tx/" + txid);
      if (!res.ok) { $("b-track-msg").textContent = `Not on chain yet (HTTP ${res.status}) — still in mempool or propagating.`; return; }
      const j = await res.json();
      const audit = R.auditBatchTx(j, { txid, senderAddress: state.senderAddress, recipients: state.manifest.recipients }, net());
      $("b-verify-out").hidden = false;
      const v = $("b-verdict");
      v.textContent = audit.verdict;
      v.style.color = audit.ok ? "var(--go)" : "var(--stop)";
      $("b-verify-kv").innerHTML =
        `<div><dt>Confirmations</dt><dd>${audit.confirmations}</dd></div>` +
        `<div><dt>Block</dt><dd>${audit.blockHeight ?? "mempool"}</dd></div>` +
        `<div><dt>Fee paid</dt><dd>${audit.fee} grains (${audit.feePRL} PRL)</dd></div>` +
        `<div><dt>Inputs / outputs</dt><dd>${audit.nIn} / ${audit.nOut}</dd></div>`;
      const nt = $("b-verify-notes");
      const problems = [...audit.notes, ...audit.missingRecipients.map((m) => `missing/short output: ${shortAddr(m.address)} expected ${m.expected} grains, found ${m.found}`)];
      if (problems.length) { nt.textContent = problems.join(" · "); nt.hidden = false; } else nt.hidden = true;
      $("b-track-msg").textContent = audit.ok ? "Verified on-chain." : "On chain but FAILED verification — read the notes.";
    } catch (e) {
      $("b-track-msg").textContent = "Track failed: " + (e.message || e);
    }
  }
  $("b-track-start").addEventListener("click", () => {
    stopTracking();
    trackOnce();
    state.trackTimer = setInterval(trackOnce, 15000);
    $("b-track-msg").textContent = "Tracking every 15s…";
  });
  $("b-track-stop").addEventListener("click", () => { stopTracking(); $("b-track-msg").textContent = "Tracking stopped."; });

  /* ---------- standalone verifier ---------- */

  $("v-run").addEventListener("click", async () => {
    hideErr("v-err"); $("v-out").hidden = true;
    try {
      const txid = $("v-txid").value.trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(txid)) throw new Error("txid must be 64 hex characters");
      const sender = R.canonicalAddress($("v-sender").value.trim(), net());
      const { recipients } = R.parseRecipients($("v-manifest").value, net());
      const bb = $("blockbook").value.trim();
      if (!bb) throw new Error("no Blockbook endpoint configured");
      const res = await fetch(bb.replace(/\/$/, "") + "/api/v2/tx/" + txid);
      if (!res.ok) throw new Error(`Blockbook: tx not found (HTTP ${res.status}) — not on chain at this endpoint`);
      const j = await res.json();
      const audit = R.auditBatchTx(j, { txid, senderAddress: sender, recipients }, net());
      $("v-out").hidden = false;
      const v = $("v-verdict");
      v.textContent = audit.verdict;
      v.style.color = audit.ok ? "var(--go)" : "var(--stop)";
      $("v-kv").innerHTML =
        `<div><dt>Confirmations</dt><dd>${audit.confirmations}</dd></div>` +
        `<div><dt>Block</dt><dd>${audit.blockHeight ?? "mempool"}</dd></div>` +
        `<div><dt>Fee paid</dt><dd>${audit.fee} grains (${audit.feePRL} PRL)</dd></div>` +
        `<div><dt>Recipients checked</dt><dd>${recipients.length} — ${audit.missingRecipients.length} missing/short</dd></div>`;
      if (audit.notes.length) showErr("v-err", audit.notes.join(" · "));
    } catch (e) { showErr("v-err", "VERIFIER: " + (e.message || e)); }
  });

  /* ---------- boot ---------- */

  STEPS.forEach((s) => {
    const b = $("st-" + s);
    if (b) b.addEventListener("click", () => goto(s));
  });
  loadConfig();
  goto("manifest");

  /* test hook (drives the DOM test suite; exposes no secrets) */
  window.__batchTest = {
    state: () => JSON.parse(JSON.stringify(state, (k, v) => typeof v === "bigint" ? v.toString() + "n" : (v instanceof Uint8Array ? Array.from(v) : v))),
    goto,
    R,
  };
})();
