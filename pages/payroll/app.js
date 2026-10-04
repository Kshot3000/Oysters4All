/* Pearl Payroll page wiring — classic script, uses window.PearlPayroll bundle.
 *
 * Six steps: Roster -> Schedule -> Fund -> Review -> Sign -> Broadcast,
 * plus a History ledger (localStorage, this browser only).
 * Secrets (mnemonics, WIFs, xprvs, hex keys) live only in page memory between
 * entry and Wipe/signing; they are never written to storage, never put in a
 * URL, never sent anywhere. Blockbook reads are GET-only; broadcast is a
 * single explicit POST behind a double-confirm checkbox. All crypto runs
 * through the audited Pearl Sign lineage (bundled as window.PearlPayroll).
 *
 * The schedule is a PLANNER, never auto-pay: every payday is a manual signed
 * dispatch through steps 3-6.
 */
(function () {
  "use strict";
  const R = window.PearlPayroll;
  if (!R) { document.body.innerHTML = "<p style='padding:40px'>Failed to load the Payroll bundle.</p>"; return; }

  const $ = (id) => document.getElementById(id);
  const store = {
    get(k) { try { return typeof localStorage !== "undefined" ? localStorage.getItem(k) : null; } catch (e) { return null; } },
    set(k, v) { try { if (typeof localStorage !== "undefined") localStorage.setItem(k, v); } catch (e) {} },
    del(k) { try { if (typeof localStorage !== "undefined") localStorage.removeItem(k); } catch (e) {} },
  };

  const state = {
    network: "mainnet", blockbook: "", feeRate: 20,
    roster: null,              // {payees, merged, total}
    schedule: null,            // {dates, period, customDays, anchor, runLabel, payDate}
    senderAddress: "",
    utxos: [],                 // {txid, vout, value, confirmations, checked}
    autoSelect: true,
    plan: null,
    bundle: null,
    fingerprint: "",
    signed: null,              // {txid, hex}
    broadcastTxid: "",
    secret: null,              // held in memory only
    editIndex: -1,
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
  const STEPS = ["roster", "schedule", "fund", "review", "sign", "broadcast"];
  function goto(step, skipScroll) {
    STEPS.forEach((s) => { const b = $("st-" + s); if (b) b.classList.toggle("active", s === step); });
    STEPS.forEach((s) => { const p = $("step-" + s); if (p) p.hidden = s !== step; });
    $("st-history").classList.remove("active");
    $("step-history").hidden = true;
    const el = $("step-" + step);
    // scrollIntoView also moves the keyboard focus-navigation starting point;
    // the boot call passes skipScroll so the page loads at the top and the
    // first Tab reaches the skip link, not the roster textarea.
    if (el && el.scrollIntoView && !skipScroll) el.scrollIntoView({ block: "start" });
  }
  function gotoHistory() {
    STEPS.forEach((s) => { const b = $("st-" + s); if (b) b.classList.remove("active"); });
    STEPS.forEach((s) => { const p = $("step-" + s); if (p) p.hidden = true; });
    $("st-history").classList.add("active");
    $("step-history").hidden = false;
    renderHistory();
    const el = $("step-history");
    if (el && el.scrollIntoView) el.scrollIntoView({ block: "start" });
  }
  function download(name, text, mime) {
    const blob = new Blob([text], { type: mime || "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
  }
  async function copyText(text) {
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
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  /* ---------- config strip ---------- */

  function loadConfig() {
    const savedBb = store.get("pearl-payroll:blockbook");
    const savedRate = store.get("pearl-payroll:feerate");
    $("blockbook").value = savedBb || R.NETWORKS.mainnet.blockbook;
    if (savedRate) $("feerate").value = savedRate;
    state.blockbook = $("blockbook").value.trim();
    try { state.feeRate = feeRate(); } catch (e) { state.feeRate = 20; }
  }
  $("blockbook").addEventListener("change", () => {
    state.blockbook = $("blockbook").value.trim();
    store.set("pearl-payroll:blockbook", state.blockbook);
    $("cfg-msg").textContent = state.blockbook ? "Blockbook endpoint saved (this browser only)." : "No Blockbook endpoint — online reads disabled, paste mode still works.";
  });
  $("feerate").addEventListener("change", () => {
    try { state.feeRate = feeRate(); store.set("pearl-payroll:feerate", String(state.feeRate)); $("cfg-msg").textContent = ""; }
    catch (e) { $("cfg-msg").textContent = e.message; }
  });
  $("network").addEventListener("change", () => {
    state.network = $("network").value;
    resetWorkflow();
    $("cfg-msg").textContent = `Network: ${net().label} (${net().hrp}1…) — workflow reset.`;
    if (!net().blockbook) $("cfg-msg").textContent += " No default Blockbook on testnet — configure one or use paste mode.";
    renderHistory();
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
      store.set("pearl-payroll:feerate", String(g));
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
    state.roster = null; state.schedule = null; state.senderAddress = ""; state.utxos = [];
    state.plan = null; state.bundle = null; state.fingerprint = "";
    state.signed = null; state.broadcastTxid = ""; state.editIndex = -1;
    ["r-out", "p-out", "f-out", "r2-out", "s-out", "b-ready"].forEach((id) => { $(id).hidden = true; });
    $("b-send").disabled = true; $("b-confirm").checked = false; $("r2-confirm").checked = false; $("r2-next").disabled = true;
  }

  /* ---------- step 1: roster ---------- */

  function renderRosterTable() {
    const tb = $("r-tbody"); tb.innerHTML = "";
    state.roster.payees.forEach((r, i) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td class="mut">${i + 1}</td>` +
        `<td>${r.label ? escapeHtml(r.label) : '<span class="mut">—</span>'}</td>` +
        `<td class="addr-short" title="${escapeHtml(r.address)}">${escapeHtml(shortAddr(r.address))}</td>` +
        `<td>${R.fmtPRL(r.amount)} <span class="mut">PRL</span></td>`;
      const td = document.createElement("td");
      const eb = document.createElement("button");
      eb.type = "button"; eb.className = "btn ghost tiny"; eb.textContent = "Edit";
      eb.addEventListener("click", () => startEdit(i));
      const rb = document.createElement("button");
      rb.type = "button"; rb.className = "btn danger-ghost tiny"; rb.textContent = "Remove";
      rb.addEventListener("click", () => removePayee(i));
      const wrap = document.createElement("div"); wrap.className = "rowbtns";
      wrap.appendChild(eb); wrap.appendChild(rb); td.appendChild(wrap);
      tr.appendChild(td);
      tb.appendChild(tr);
    });
    $("r-count").textContent = String(state.roster.payees.length);
    $("r-total").textContent = `${R.fmtPRL(state.roster.total)} PRL (${state.roster.total.toString()} grains)`;
    $("r-out").hidden = false;
  }

  function recomputeTotal() {
    state.roster.total = state.roster.payees.reduce((a, r) => a + r.amount, 0n);
  }

  function startEdit(i) {
    const r = state.roster.payees[i];
    state.editIndex = i;
    $("a-addr").value = r.address;
    $("a-amount").value = R.fmtPRL(r.amount);
    $("a-label").value = r.label || "";
    $("a-add").textContent = "Update payee";
    $("a-cancel").hidden = false;
    $("a-msg").textContent = `Editing payee #${i + 1}.`;
  }
  function cancelEdit() {
    state.editIndex = -1;
    $("a-addr").value = ""; $("a-amount").value = ""; $("a-label").value = "";
    $("a-add").textContent = "Add payee";
    $("a-cancel").hidden = true;
  }

  function removePayee(i) {
    state.roster.payees.splice(i, 1);
    if (state.editIndex === i) cancelEdit();
    else if (state.editIndex > i) state.editIndex--;
    if (state.roster.payees.length === 0) {
      state.roster = null;
      $("r-out").hidden = true;
      return;
    }
    recomputeTotal();
    renderRosterTable();
  }

  $("r-sample").addEventListener("click", () => { $("r-text").value = R.sampleRoster(); });
  $("r-import").addEventListener("click", () => { if (typeof FileReader !== "undefined") $("r-file").click(); else showErr("r-err", "File import needs a real browser FileReader."); });
  $("r-file").addEventListener("change", () => {
    const f = $("r-file").files && $("r-file").files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => { $("r-text").value = String(rd.result || ""); };
    rd.readAsText(f);
  });
  $("r-parse").addEventListener("click", () => {
    hideErr("r-err"); $("r-out").hidden = true; cancelEdit();
    try {
      const m = R.parseRoster($("r-text").value, net(), { mergeDuplicates: $("r-merge").checked });
      state.roster = m;
      state.schedule = null; $("p-out").hidden = true; // roster changed -> replan
      $("r-merged").textContent = m.merged === 0 ? "none — all addresses unique" : `${m.merged} duplicate line(s) merged into one payee each`;
      renderRosterTable();
    } catch (e) {
      state.roster = null;
      showErr("r-err", "ROSTER REFUSED: " + (e.message || e));
    }
  });

  /** Validate a single add/edit line and return {address, program, amount, label}. */
  function parseSinglePayee(addrS, amountS, labelS) {
    const line = `${addrS.trim()}, ${amountS.trim()}${labelS.trim() ? ", " + labelS.trim() : ""}`;
    const { payees } = R.parseRoster(line, net(), { mergeDuplicates: false });
    return payees[0];
  }

  $("a-add").addEventListener("click", () => {
    hideErr("a-err"); $("a-msg").textContent = "";
    if (!state.roster) { showErr("a-err", "Validate a roster first — the add form edits the validated ledger."); return; }
    try {
      const p = parseSinglePayee($("a-addr").value, $("a-amount").value, $("a-label").value);
      if (state.roster.payees.length >= R.PAYROLL_MAX_PAYEES && state.editIndex < 0) {
        throw new Error(`roster is full (${R.PAYROLL_MAX_PAYEES} payees) — remove someone first`);
      }
      const dupIdx = state.roster.payees.findIndex((r) => r.address.toLowerCase() === p.address.toLowerCase());
      if (state.editIndex >= 0) {
        if (dupIdx >= 0 && dupIdx !== state.editIndex) {
          throw new Error("DUPLICATE — another payee already uses this address. Merging is loud here: edit that row instead, or remove one of them.");
        }
        state.roster.payees[state.editIndex] = p;
        $("a-msg").textContent = "Payee updated.";
      } else {
        if (dupIdx >= 0) {
          throw new Error("DUPLICATE ADDRESS — this payee is already on the ledger. Remove the old row first, or edit it. Duplicates merge only in the paste/CSV path, and only when merging is on.");
        }
        state.roster.payees.push(p);
        $("a-msg").textContent = "Payee added.";
      }
      recomputeTotal();
      renderRosterTable();
      state.schedule = null; $("p-out").hidden = true; // roster changed -> replan
      cancelEdit();
    } catch (e) {
      showErr("a-err", "PAYEE REFUSED: " + (e.message || e));
    }
  });
  $("a-cancel").addEventListener("click", () => { cancelEdit(); $("a-msg").textContent = ""; });

  $("r-export-csv").addEventListener("click", () => {
    if (!state.roster) return;
    download(`pearl-payroll-roster-${state.network}.csv`, R.rosterToCsv(state.roster.payees), "text/csv");
  });
  $("r-next").addEventListener("click", () => {
    if (!state.roster) return;
    goto("schedule");
  });

  /* ---------- step 2: schedule ---------- */

  const PERIOD_LABELS = { weekly: "Weekly", biweekly: "Biweekly", monthly: "Monthly", custom: "Custom" };

  $("p-plan").addEventListener("click", () => {
    hideErr("p-err"); $("p-out").hidden = true;
    try {
      if (!state.roster) throw new Error("validate the roster first (step 1)");
      const period = $("p-period").value;
      const customDays = Math.floor(Number($("p-custom-days").value));
      const anchor = $("p-anchor").value;
      if (!anchor) throw new Error("pick an anchor payday");
      const dates = R.nextPayDates({ anchor, period, customDays, count: 12 });
      const runLabel = $("p-label").value.trim() || `${PERIOD_LABELS[period] || period} run — ${dates[0].iso}`;
      state.schedule = { dates, period, customDays, anchor, runLabel, payDate: dates[0].iso };
      const skipped = dates.skippedPaydays || 0;
      const warn = $("p-skip-warn");
      if (skipped > 0) {
        warn.hidden = false;
        warn.innerHTML = `<strong>Heads up:</strong> the anchor ${escapeHtml(anchor)} is in the past — ${skipped} payday${skipped > 1 ? "s were" : " was"} skipped, so the calendar starts from the next upcoming payday, ${escapeHtml(dates[0].iso)}. If ${skipped === 1 ? "that run was" : "any of those runs were"} never paid, settle ${skipped === 1 ? "it" : "them"} manually before continuing.`;
      } else {
        warn.hidden = true; warn.textContent = "";
      }
      $("p-period-out").textContent = period === "custom" ? `Custom — every ${customDays} days (anchor ${anchor})` : `${PERIOD_LABELS[period]} (anchor ${anchor})`;
      $("p-total-out").textContent = `${R.fmtPRL(state.roster.total)} PRL per run × ${state.roster.payees.length} payee(s)`;
      const ms = R.msUntilPayday(dates);
      $("p-countdown").textContent = `${dates[0].iso} (${dates[0].dow}) — ${R.fmtCountdown(ms)}`;
      const tb = $("p-tbody"); tb.innerHTML = "";
      dates.forEach((d, i) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `<td class="mut">${i + 1}</td><td>${d.iso}</td><td class="mut">${d.dow}</td>` +
          `<td>${R.fmtPRL(state.roster.total)} <span class="mut">PRL</span></td>`;
        tb.appendChild(tr);
      });
      $("p-out").hidden = false;
    } catch (e) {
      state.schedule = null;
      showErr("p-err", "SCHEDULE REFUSED: " + (e.message || e));
    }
  });
  $("p-next").addEventListener("click", () => {
    if (!state.schedule) return;
    goto("fund");
  });

  /* ---------- step 3: fund ---------- */

  function selectedUtxos() {
    if (state.autoSelect) {
      const r = R.autoSelectUtxos(state.utxos, state.roster.total, feeRate(), state.roster.payees.length);
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
        `<td class="mut">${i + 1}</td><td title="${escapeHtml(u.txid)}">${escapeHtml(shortTxid(u.txid))}</td>` +
        `<td>${u.vout}</td><td>${R.fmtPRL(BigInt(u.value))} <span class="mut">PRL</span></td><td class="mut">${u.confirmations ?? "?"}</td>`);
      tb.appendChild(tr);
    });
    $("f-out").hidden = state.utxos.length === 0;
    renderTotals();
  }

  function renderTotals() {
    const kv = $("f-totals");
    hideErr("f-cover-err"); $("f-warn").hidden = true;
    if (!state.roster) { kv.innerHTML = "<div><dt>Roster</dt><dd>validate the roster first (step 1)</dd></div>"; return; }
    try {
      const sel = selectedUtxos();
      const plan = R.planRun({
        utxos: sel, payees: state.roster.payees,
        senderProgram: R.decodeBech32m(state.senderAddress, net().hrp).program,
        feeRateGrainsPerVByte: feeRate(), network: net(),
      });
      const inSum = sel.reduce((a, u) => a + BigInt(u.value), 0n);
      kv.innerHTML =
        `<div><dt>Payees</dt><dd>${plan.nOut - (plan.changeDropped ? 0 : 1)} → ${R.fmtPRL(plan.sumOut)} PRL</dd></div>` +
        `<div><dt>Inputs selected</dt><dd>${sel.length} UTXO(s) → ${R.fmtPRL(inSum)} PRL</dd></div>` +
        `<div><dt>Fee</dt><dd>${plan.fee} grains (${R.fmtPRL(plan.fee)} PRL) @ ${plan.feeRate} gr/vB × ${plan.vBytes} vB</dd></div>` +
        `<div><dt>Change</dt><dd>${plan.changeDropped ? `dust absorbed into fee (+${plan.changeBump} grains)` : R.fmtPRL(plan.change) + " PRL back to sender"}</dd></div>` +
        `<div><dt>Coverage</dt><dd style="color:var(--go)">OK — inputs = payees + fee + change, grain-exact</dd></div>`;
      const covered = R.runsCovered(inSum, plan.sumOut, plan.fee);
      if (covered < 2) {
        const w = $("f-warn");
        w.textContent = `Funding warning: this balance covers ${covered} upcoming pay run(s) — fewer than 2. ` +
          `Each period costs ${R.fmtPRL(plan.sumOut)} PRL to payees + ~${R.fmtPRL(plan.fee)} PRL fee. Top up the strongbox before payday.`;
        w.hidden = false;
      }
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
    if (!state.roster) { goto("roster"); return; }
    if (!state.schedule) { goto("schedule"); return; }
    try {
      requireSender();
      const sel = selectedUtxos();
      const plan = R.planRun({
        utxos: sel, payees: state.roster.payees,
        senderProgram: R.decodeBech32m(state.senderAddress, net().hrp).program,
        feeRateGrainsPerVByte: feeRate(), network: net(),
      });
      state.plan = plan;
      renderReview();
      goto("review");
    } catch (e) { showErr("f-err", "RUN REFUSED: " + (e.message || e)); }
  });

  /* ---------- step 4: review ---------- */

  function renderReview() {
    const plan = state.plan, roster = state.roster, sch = state.schedule;
    $("r2-refusal").hidden = true; $("r2-out").hidden = true;
    const bal = plan.total - (plan.sumOut + plan.fee + plan.change);
    if (bal !== 0n) {
      const r = $("r2-refusal");
      r.textContent = `PAY SLIP REFUSED — inputs (${R.fmtPRL(plan.total)} PRL) do not equal payees + fee + change. This should be impossible; the run was not sealed.`;
      r.hidden = false; return;
    }
    $("r2-summary").innerHTML =
      `<div><dt>Sender</dt><dd title="${escapeHtml(state.senderAddress)}">${escapeHtml(shortAddr(state.senderAddress))}</dd></div>` +
      `<div><dt>Network</dt><dd>${net().label} (${net().hrp}1…)</dd></div>` +
      `<div><dt>Run</dt><dd>${escapeHtml(sch.runLabel)} — ${sch.payDate} (${sch.period})</dd></div>` +
      `<div><dt>Inputs</dt><dd>${plan.nIn} UTXO(s) → ${R.fmtPRL(plan.total)} PRL</dd></div>` +
      `<div><dt>Payees</dt><dd>${roster.payees.length} → ${R.fmtPRL(plan.sumOut)} PRL</dd></div>` +
      `<div><dt>Balance check</dt><dd style="color:var(--go)">inputs = payees + fee + change — exact to the grain</dd></div>`;
    $("r2-rcount").textContent = `(${roster.payees.length})`;
    const tb = $("r2-tbody"); tb.innerHTML = "";
    roster.payees.forEach((r, i) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td class="mut">${i + 1}</td><td>${r.label ? escapeHtml(r.label) : '<span class="mut">—</span>'}</td>` +
        `<td class="addr-short" title="${escapeHtml(r.address)}">${escapeHtml(shortAddr(r.address))}</td>` +
        `<td>${R.fmtPRL(r.amount)} <span class="mut">PRL</span></td>`;
      tb.appendChild(tr);
    });
    $("r2-icount").textContent = `(${plan.inputs.length})`;
    const ib = $("r2-itbody"); ib.innerHTML = "";
    plan.inputs.forEach((u, i) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td class="mut">${i + 1}</td><td title="${escapeHtml(u.txid)}">${escapeHtml(shortTxid(u.txid))}</td><td>${u.vout}</td><td>${R.fmtPRL(BigInt(u.value))} <span class="mut">PRL</span></td>`;
      ib.appendChild(tr);
    });
    $("r2-fee").innerHTML =
      `<div><dt>vBytes</dt><dd>${plan.vBytes} vB — keypathTxVBytes(${plan.nIn} in, ${plan.nOut} out)</dd></div>` +
      `<div><dt>Rate</dt><dd>${plan.feeRate} grains/vB</dd></div>` +
      `<div><dt>Fee</dt><dd>${plan.fee} grains = ${R.fmtPRL(plan.fee)} PRL</dd></div>` +
      `<div><dt>Change</dt><dd>${plan.changeDropped ? `dust change absorbed into the fee (+${plan.changeBump} grains)` : R.fmtPRL(plan.change) + " PRL → sender"}</dd></div>`;
    const dn = $("r2-dust-note");
    if (plan.changeDropped) {
      dn.textContent = `Note: the change output would have been ${plan.changeBump} grains — below the 546-grain dust floor — so it was added to the miner fee instead of creating an unspendable output.`;
      dn.hidden = false;
    } else dn.hidden = true;
    $("r2-stamp").textContent = "UNSEALED";
    $("r2-stamp").className = "stamp warn";
    $("r2-confirm").checked = false; $("r2-next").disabled = true;
    $("r2-out").hidden = false;
  }
  $("r2-confirm").addEventListener("change", () => { $("r2-next").disabled = !$("r2-confirm").checked; });
  $("r2-export").addEventListener("click", () => {
    if (!state.plan) return;
    buildBundle();
    goto("sign");
  });
  $("r2-next").addEventListener("click", () => {
    if (!state.plan) return;
    buildBundle();
    goto("sign");
  });

  function buildBundle() {
    const bundle = R.exportUnsignedBundle({
      network: net(), senderAddress: state.senderAddress,
      payees: state.roster.payees, plan: state.plan, feeRate: state.plan.feeRate,
      period: state.schedule.period, payDate: state.schedule.payDate, runLabel: state.schedule.runLabel,
    });
    state.bundle = bundle;
    state.fingerprint = bundle.fingerprint;
    $("s-fp").textContent = bundle.fingerprint;
    $("s-unsigned-txid").textContent = bundle.unsignedTxid;
    $("s-bundle").value = JSON.stringify(bundle, null, 2);
  }

  /* ---------- step 5: sign ---------- */

  $("s-download").addEventListener("click", () => {
    if (!state.bundle) return;
    download(`pearl-payroll-unsigned-${state.fingerprint}.json`, JSON.stringify(state.bundle, null, 2), "application/json");
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
      state.roster = { payees: imp.payees, merged: 0, total: imp.payees.reduce((a, r) => a + r.amount, 0n) };
      state.plan = imp.plan;
      state.fingerprint = imp.fingerprint;
      state.schedule = { period: imp.period || "custom", customDays: 0, anchor: imp.payDate || "", runLabel: imp.runLabel || "imported run", payDate: imp.payDate || "", dates: imp.payDate ? [{ index: 0, iso: imp.payDate, dow: "" }] : [] };
      state.bundle = R.exportUnsignedBundle({
        network: imp.network, senderAddress: imp.senderAddress, payees: imp.payees, plan: imp.plan, feeRate: imp.feeRate,
        period: imp.period, payDate: imp.payDate, runLabel: imp.runLabel,
      });
      $("s-fp").textContent = imp.fingerprint;
      $("s-unsigned-txid").textContent = state.bundle.unsignedTxid;
      $("s-bundle").value = JSON.stringify(state.bundle, null, 2);
      $("f-sender").value = imp.senderAddress;
      const ok = $("s-import-ok");
      ok.textContent = `Bundle verified & loaded: fingerprint ${imp.fingerprint}, unsigned txid ${state.bundle.unsignedTxid.slice(0, 16)}…, ` +
        `${imp.payees.length} payees, fee ${imp.plan.fee} grains, ${imp.plan.vBytes} vB — all cross-checks passed.` +
        (imp.runLabel ? ` Run: ${imp.runLabel} (${imp.payDate}, ${imp.period}).` : "");
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
      if (!state.plan) throw new Error("no pay run — build one from the Review step (or import a bundle) first");
      const secret = R.parsePayrollSecret($("s-key").value, net());
      $("s-key-addr").textContent = `key → ${shortAddr(secret.address)}`;
      R.assertKeyControlsAddress(secret, state.senderAddress);
      const signed = R.buildPayrollTx({ secret, senderAddress: state.senderAddress, utxos: state.plan.inputs, plan: state.plan, network: net() });
      state.secret = null; // wipe before exposing anything
      wipeKeys(true);
      state.signed = signed;
      $("s-verify").textContent = `${signed.plan.inputs.length}/${signed.plan.inputs.length} Schnorr signatures re-verified locally (BIP-341 keypath)`;
      $("s-txid").textContent = signed.txid;
      $("s-hex").value = signed.hex;
      $("s-out").hidden = false;
      $("r2-stamp").textContent = "SEALED";
      $("r2-stamp").className = "stamp ok";
    } catch (e) {
      showErr("s-err", "SIGNING REFUSED: " + (e.message || e));
    }
  });
  $("s-next").addEventListener("click", () => {
    if (!state.signed) return;
    $("b-txid").textContent = state.signed.txid;
    $("b-runlabel").textContent = state.schedule ? `${state.schedule.runLabel} — ${state.schedule.payDate} (${state.schedule.period})` : "imported run";
    $("b-nrecip").textContent = String(state.roster.payees.length);
    $("b-total").textContent = `${R.fmtPRL(state.plan.sumOut)} PRL`;
    $("b-fee").textContent = `${state.plan.fee} grains (${R.fmtPRL(state.plan.fee)} PRL)`;
    $("b-net").textContent = net().label;
    $("b-pearld-cmd").textContent =
      `curl -s --user RPCUSER:RPCPASS -H 'content-type: application/json' \\\n` +
      `  --data '{"jsonrpc":"1.0","id":"pearl-payroll","method":"sendrawtransaction","params":["${state.signed.hex}"]}' \\\n` +
      `  http://127.0.0.1:44107/`;
    $("b-ready").hidden = false;
    $("b-confirm").checked = false; $("b-send").disabled = true;
    $("b-ok").hidden = true;
    goto("broadcast");
  });

  /* ---------- step 6: broadcast ---------- */

  $("b-confirm").addEventListener("change", () => { $("b-send").disabled = !$("b-confirm").checked; });
  $("b-send").addEventListener("click", async () => {
    hideErr("b-err"); $("b-ok").hidden = true;
    if (!state.signed) return;
    const bb = $("blockbook").value.trim();
    if (!bb) { showErr("b-err", "No Blockbook endpoint configured — use the pearld command below instead."); return; }
    $("b-send").disabled = true;
    try {
      const txid = await R.broadcastViaBlockbook(bb, state.signed.hex);
      state.broadcastTxid = txid;
      if (txid !== state.signed.txid) throw new Error(`node returned a different txid (${txid}) than the signed one — investigate before continuing`);
      const rec = R.recordPayrollRun({
        payDate: state.schedule ? state.schedule.payDate : "",
        period: state.schedule ? state.schedule.period : "",
        runLabel: state.schedule ? state.schedule.runLabel : "imported run",
        txid,
        payees: state.roster.payees.map((p) => ({ address: p.address, label: p.label, grains: p.amount })),
        feeGrains: state.plan.fee,
        vBytes: state.plan.vBytes,
      });
      const key = R.historyStorageKey(state.network);
      let runs = [];
      try { runs = JSON.parse(store.get(key) || "[]"); if (!Array.isArray(runs)) runs = []; } catch (e) { runs = []; }
      runs.push(rec);
      store.set(key, JSON.stringify(runs));
      const ok = $("b-ok");
      ok.textContent = `Broadcast accepted — txid ${txid.slice(0, 16)}…. This run is recorded in the History ledger (${runs.length} run(s) on ${net().label}).`;
      ok.hidden = false;
    } catch (e) {
      $("b-send").disabled = false;
      showErr("b-err", "BROADCAST FAILED: " + (e.message || e));
    }
  });

  /* ---------- history ---------- */

  function loadHistory() {
    const key = R.historyStorageKey(state.network);
    let runs = [];
    try {
      const raw = store.get(key);
      runs = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(runs)) runs = [];
    } catch (e) { runs = []; }
    return runs.filter((r) => { try { R.assertHistoryRecord(r); return true; } catch (e) { return false; } });
  }

  function renderHistory() {
    const runs = loadHistory();
    $("h-count").textContent = `(${runs.length})`;
    const tb = $("h-tbody"); tb.innerHTML = "";
    runs.forEach((r) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${escapeHtml(r.payDate) || '<span class="mut">—</span>'}</td>` +
        `<td>${escapeHtml(r.runLabel) || '<span class="mut">—</span>'}</td>` +
        `<td class="addr-short" title="${escapeHtml(r.txid)}">${escapeHtml(shortTxid(r.txid))}</td>` +
        `<td class="mut">${r.payees.length}</td>` +
        `<td>${R.fmtPRL(BigInt(r.feeGrains))} <span class="mut">PRL</span></td>`;
      tb.appendChild(tr);
    });
    const totals = R.perPayeeTotals(runs);
    $("h-tot-count").textContent = `(${totals.size})`;
    const ttb = $("h-tot-tbody"); ttb.innerHTML = "";
    [...totals.values()]
      .sort((a, b) => (b.totalGrains > a.totalGrains ? 1 : b.totalGrains < a.totalGrains ? -1 : 0))
      .forEach((e) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `<td>${e.label ? escapeHtml(e.label) : '<span class="mut">—</span>'}</td>` +
          `<td class="addr-short" title="${escapeHtml(e.address)}">${escapeHtml(shortAddr(e.address))}</td>` +
          `<td>${R.fmtPRL(e.totalGrains)} <span class="mut">PRL</span></td><td class="mut">${e.runs}</td>`;
        ttb.appendChild(tr);
      });
    if (runs.length === 0) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="5" class="mut">No pay runs recorded yet in this browser. Broadcast a run and it lands here.</td>`;
      tb.appendChild(tr);
    }
  }

  $("h-export").addEventListener("click", () => {
    const runs = loadHistory();
    if (!runs.length) { $("h-msg").textContent = "Nothing to export yet."; return; }
    download(`pearl-payroll-history-${state.network}.csv`, R.runsToCsv(runs), "text/csv");
    $("h-msg").textContent = `Exported ${runs.length} run(s).`;
  });
  $("h-clear").addEventListener("click", () => {
    store.del(R.historyStorageKey(state.network));
    renderHistory();
    $("h-msg").textContent = "History cleared from this browser. (Exports you downloaded are unaffected.)";
  });
  $("st-history").addEventListener("click", gotoHistory);

  /* ---------- boot ---------- */

  STEPS.forEach((s) => {
    const b = $("st-" + s);
    if (b) b.addEventListener("click", () => goto(s));
  });
  loadConfig();
  renderHistory();
  goto("roster", true);

  /* test hook (drives the DOM test suite; exposes no secrets) */
  window.__payrollTest = {
    state: () => JSON.parse(JSON.stringify(state, (k, v) => typeof v === "bigint" ? v.toString() + "n" : (v instanceof Uint8Array ? Array.from(v) : v))),
    goto, gotoHistory, renderHistory,
    R,
  };
})();
