/* Pearl Tax — PRL capital-gains desk (read-only).
 * Boots window.PearlTax (the audited-bundle). Six tabs: Addresses → Import →
 * Classify → Prices → Report → Export. The page never holds keys, never signs,
 * never broadcasts; Blockbook is only ever read with GET.
 */
(function () {
  "use strict";
  if (!window.PearlTax) {
    document.body.innerHTML = "<p style='padding:40px'>Failed to load the tax bundle.</p>";
    return;
  }
  const R = window.PearlTax;
  const $ = (id) => document.getElementById(id);
  const LS_KEY = "pearl-tax:v1";

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const msg = (el, text, cls) => {
    el.textContent = text;
    el.className = "msg" + (cls ? " " + cls : "");
  };
  const shortTx = (t) => (t.length > 18 ? t.slice(0, 10) + "…" + t.slice(-6) : t);
  const attr = (el, k, v) => { if (el.setAttribute) el.setAttribute(k, v); };

  /* ---------------- state ---------------- */

  const blank = () => ({
    addresses: [],
    blockbook: R.DEFAULT_BLOCKBOOK,
    txs: [],
    classifications: {},
    prices: [],
    openingLots: [],
  });
  let state = blank();
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) state = Object.assign(blank(), JSON.parse(raw));
  } catch (e) { /* corrupted storage -> start blank */ }
  const save = () => {
    try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) { /* storage full/blocked */ }
  };
  let lastReport = null;
  let lastLedger = null;

  /* ---------------- tabs ---------------- */

  const tabs = Array.from(document.querySelectorAll(".tab"));
  tabs.forEach((b) =>
    b.addEventListener("click", () => {
      tabs.forEach((x) => x.classList.toggle("active", x === b));
      document.querySelectorAll("main .panel").forEach((p) => {
        if (p.classList.contains("limits")) return;
        p.hidden = p.id !== "tab-" + b.dataset.tab;
      });
      const fn = { import: renderImport, classify: renderClassify, prices: renderPrices, report: renderReportTab, export: renderExport }[b.dataset.tab];
      if (fn) fn();
    })
  );

  /* ---------------- 1 addresses ---------------- */

  function renderAddresses() {
    const ul = $("tx-addr-list");
    ul.innerHTML = "";
    state.addresses.forEach((a, i) => {
      const li = document.createElement("li");
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = a.hrp;
      const grow = document.createElement("span");
      grow.className = "grow mono";
      grow.textContent = a.address + (a.label ? " — " + a.label : "");
      const rm = document.createElement("button");
      rm.className = "rm";
      rm.type = "button";
      rm.textContent = "✕";
      attr(rm, "aria-label", "Remove address");
      rm.addEventListener("click", () => {
        state.addresses.splice(i, 1);
        save();
        renderAddresses();
      });
      li.appendChild(tag);
      li.appendChild(grow);
      li.appendChild(rm);
      ul.appendChild(li);
    });
  }

  $("tx-addr-add").addEventListener("click", () => {
    const input = $("tx-addr-input");
    const raw = input.value;
    try {
      const v = R.validateWatchAddress(raw);
      if (state.addresses.some((a) => a.address === v.address)) throw new Error("address already watched");
      state.addresses.push({ address: v.address, hrp: v.hrp, label: $("tx-addr-label").value.trim() });
      input.value = "";
      $("tx-addr-label").value = "";
      save();
      renderAddresses();
      msg($("tx-addr-msg"), `Watching ${v.address.slice(0, 20)}… (${state.addresses.length} total).`, "ok");
    } catch (e) {
      msg($("tx-addr-msg"), "Refused: " + e.message, "err");
    }
  });

  /* ---------------- 2 import ---------------- */

  function watchedSet() {
    return new Set(state.addresses.map((a) => a.address));
  }

  function mergeTx(norm) {
    if (!state.txs.some((t) => t.txid === norm.txid)) state.txs.push(norm);
  }

  async function normalizeWithFallback(raw, w) {
    try {
      return R.normalizeBlockbookTx(raw, w);
    } catch (e) {
      if (e instanceof R.UnresolvableTx) {
        const full = await R.fetchTxDetail({ blockbook: state.blockbook, txid: raw.txid });
        return R.normalizeBlockbookTx(full, w);
      }
      throw e;
    }
  }

  $("tx-imp-fetch").addEventListener("click", async () => {
    const btn = $("tx-imp-fetch");
    if (!state.addresses.length) {
      msg($("tx-imp-msg"), "Refused: add at least one watched address first.", "err");
      return;
    }
    state.blockbook = $("tx-imp-blockbook").value.trim().replace(/\/$/, "") || R.DEFAULT_BLOCKBOOK;
    btn.disabled = true;
    msg($("tx-imp-msg"), "Reading Blockbook (GET-only)…", "");
    let added = 0;
    let failed = 0;
    let capped = false;
    const w = watchedSet();
    for (const a of state.addresses) {
      try {
        const { txs, capped: c } = await R.fetchAddressTxs({ blockbook: state.blockbook, address: a.address });
        capped = capped || c;
        for (const raw of txs) {
          try {
            mergeTx(await normalizeWithFallback(raw, w));
            added++;
          } catch (e) {
            failed++;
          }
        }
      } catch (e) {
        msg($("tx-imp-msg"), "Blockbook error on " + a.address.slice(0, 18) + "…: " + e.message, "err");
        btn.disabled = false;
        return;
      }
    }
    save();
    renderImport();
    btn.disabled = false;
    msg(
      $("tx-imp-msg"),
      `Imported ${added} transaction(s) (${state.txs.length} unique).${failed ? ` ${failed} skipped (unresolvable).` : ""}${capped ? " Capped at 20 pages — narrow the address set." : ""}`,
      failed ? "" : "ok"
    );
  });

  $("tx-imp-paste-add").addEventListener("click", () => {
    const w = watchedSet();
    let arr;
    try {
      const j = JSON.parse($("tx-imp-paste").value);
      arr = Array.isArray(j) ? j : [j];
      if (!arr.length) throw new Error("empty JSON");
    } catch (e) {
      msg($("tx-imp-msg"), "Refused: pasted JSON does not parse: " + e.message, "err");
      return;
    }
    let added = 0;
    const errs = [];
    for (const raw of arr) {
      try {
        mergeTx(R.normalizeBlockbookTx(raw, w));
        added++;
      } catch (e) {
        errs.push((raw.txid || "?").slice(0, 12) + ": " + e.message);
      }
    }
    $("tx-imp-paste").value = "";
    save();
    renderImport();
    msg(
      $("tx-imp-msg"),
      added ? `Normalized ${added} pasted transaction(s).` + (errs.length ? ` Skipped: ${errs.slice(0, 3).join(" · ")}` : "") : "Refused: none usable — " + errs.slice(0, 2).join(" · "),
      added ? "ok" : "err"
    );
  });

  $("tx-open-add").addEventListener("click", () => {
    try {
      const date = $("tx-open-date").value;
      if (!date) throw new Error("date is required");
      R.dateToUnix(date);
      const grains = R.parsePRLToGrains($("tx-open-grains").value);
      const cents = R.parseUSDToCents($("tx-open-price").value);
      state.openingLots.push({ date, grains: grains.toString(), priceCents: cents.toString() });
      $("tx-open-date").value = "";
      $("tx-open-grains").value = "";
      $("tx-open-price").value = "";
      save();
      renderImport();
      msg($("tx-imp-msg"), "Opening lot added.", "ok");
    } catch (e) {
      msg($("tx-imp-msg"), "Refused: " + e.message, "err");
    }
  });

  function renderOpeningLots() {
    const ul = $("tx-open-list");
    ul.innerHTML = "";
    state.openingLots.forEach((o, i) => {
      const li = document.createElement("li");
      const grow = document.createElement("span");
      grow.className = "grow mono";
      grow.textContent = `${o.date} — ${R.formatPRL(o.grains)} PRL @ ${R.formatUSD(o.priceCents)}`;
      const rm = document.createElement("button");
      rm.className = "rm";
      rm.type = "button";
      rm.textContent = "✕";
      attr(rm, "aria-label", "Remove opening lot");
      rm.addEventListener("click", () => {
        state.openingLots.splice(i, 1);
        save();
        renderOpeningLots();
      });
      li.appendChild(grow);
      li.appendChild(rm);
      ul.appendChild(li);
    });
  }

  function renderImport() {
    if (!$("tx-imp-blockbook").value) $("tx-imp-blockbook").value = state.blockbook;
    renderOpeningLots();
    const tb = $("tx-imp-txlist");
    tb.innerHTML = "";
    const rows = [...state.txs].sort((a, b) => b.time - a.time);
    $("tx-imp-count").textContent = rows.length ? `(${rows.length})` : "";
    const unconf = rows.filter((t) => t.unconfirmed).length;
    $("tx-imp-summary").textContent = rows.length
      ? `${rows.length} transaction(s), ${state.addresses.length} watched address(es).${unconf ? ` ${unconf} unconfirmed — excluded from the ledger.` : ""}`
      : "No transactions imported yet.";
    for (const t of rows) {
      const tr = document.createElement("tr");
      const delta = BigInt(t.deltaGrains);
      const cls = state.classifications[t.txid];
      tr.innerHTML =
        `<td class="mono">${t.unconfirmed ? '<span class="unc">unconfirmed</span>' : esc(R.unixToDate(t.time))}</td>` +
        `<td class="mono" title="${esc(t.txid)}">${esc(shortTx(t.txid))}</td>` +
        `<td><span class="kind ${esc(t.kind)}">${esc(t.kind)}</span></td>` +
        `<td class="amt ${delta > 0n ? "pos" : delta < 0n ? "neg" : ""}">${delta > 0n ? "+" : ""}${esc(R.formatPRL(delta < 0n ? -delta : delta))}${delta < 0n ? " −" : ""}</td>` +
        `<td class="amt">${esc(R.formatPRL(t.feeGrains))}</td>` +
        `<td>${t.unconfirmed ? '<span class="unc">excluded</span>' : cls ? '<span class="pos">classified</span>' : '<span class="unc">unclassified</span>'}</td>`;
      tb.appendChild(tr);
    }
  }

  /* ---------------- 3 classify ---------------- */

  function subOptions(map, current) {
    return Object.keys(map)
      .map((k) => `<option value="${esc(k)}"${k === current ? " selected" : ""}>${esc(map[k])}</option>`)
      .join("");
  }

  function renderClassify() {
    const list = $("tx-cls-list");
    list.innerHTML = "";
    const onlyUn = $("tx-cls-unclass").checked;
    const rows = [...state.txs].filter((t) => !t.unconfirmed).sort((a, b) => a.time - b.time);
    let done = 0;
    for (const t of rows) {
      const c = state.classifications[t.txid];
      if (onlyUn && c) continue;
      if (c) done++;
      const row = document.createElement("div");
      row.className = "cls-row" + (c ? " done" : "");
      const delta = BigInt(t.deltaGrains);
      const meta = document.createElement("div");
      meta.className = "cls-meta";
      meta.innerHTML =
        `<span class="txid">${esc(shortTx(t.txid))}</span> · ${esc(R.unixToDate(t.time))} · ` +
        `<span class="kind ${esc(t.kind)}">${esc(t.kind)}</span> · net ` +
        `<span class="${delta > 0n ? "pos" : delta < 0n ? "neg" : ""}">${delta > 0n ? "+" : ""}${esc(R.formatPRL(delta < 0n ? -delta : delta))} PRL</span>` +
        (BigInt(t.feeGrains) > 0n ? ` · fee ${esc(R.formatPRL(t.feeGrains))} PRL` : "") +
        (t.mixedFeeNote ? `<div class="cls-note">${esc(t.mixedFeeNote)}</div>` : "");
      const ctl = document.createElement("div");
      ctl.className = "cls-controls";

      if (t.kind === "mixed") {
        const rs = document.createElement("select");
        rs.className = "input";
        attr(rs, "aria-label", "Receive leg classification");
        rs.innerHTML = subOptions(R.RECEIVE_SUBS, c && c.recvSub);
        const ss = document.createElement("select");
        ss.className = "input";
        attr(ss, "aria-label", "Send leg classification");
        ss.innerHTML = subOptions(R.SEND_SUBS, c && c.sendSub);
        const racq = document.createElement("input");
        racq.className = "input";
        racq.type = "date";
        racq.title = "Original acquisition date (receive leg transfer-in only — preserves holding period)";
        attr(racq, "aria-label", "Original acquisition date for mixed receive leg transfer-in");
        if (c && c.recvAcquiredUnix) racq.value = R.unixToDate(c.recvAcquiredUnix);
        const go = document.createElement("button");
        go.className = "btn btn-small";
        go.type = "button";
        go.textContent = c ? "Update" : "Classify";
        go.addEventListener("click", () => {
          try {
            const obj = { kind: "mixed", recvSub: rs.value, sendSub: ss.value };
            if (rs.value === "transfer-in") {
              if (!racq.value) throw new Error("transfer-in receive leg needs its original acquisition date");
              obj.recvAcquiredUnix = R.dateToUnix(racq.value);
            }
            R.validateClassification(obj);
            state.classifications[t.txid] = obj;
            save();
            renderClassify();
          } catch (e) { msg($("tx-cls-msg"), "Refused: " + e.message, "err"); }
        });
        ctl.appendChild(rs);
        ctl.appendChild(racq);
        ctl.appendChild(ss);
        ctl.appendChild(go);
        const note = document.createElement("div");
        note.className = "cls-note";
        note.textContent = "Mixed tx: outside money co-signed — modeled as a receive leg + a send leg. Classify both; the fee is assigned to the send leg.";
        row.appendChild(meta);
        row.appendChild(ctl);
        row.appendChild(note);
      } else {
        const sel = document.createElement("select");
        sel.className = "input";
        attr(sel, "aria-label", "Classification");
        const map = t.kind === "receive" ? R.RECEIVE_SUBS : t.kind === "send" ? R.SEND_SUBS : { internal: "Internal move (fee only)" };
        sel.innerHTML = `<option value="">— choose —</option>` + subOptions(map, c && c.sub);
        if (t.kind === "self") sel.value = "internal";
        const go = document.createElement("button");
        go.className = "btn btn-small";
        go.type = "button";
        go.textContent = c ? "Update" : "Classify";
        const apply = () => {
          try {
            if (t.kind === "self") {
              state.classifications[t.txid] = { kind: "self", sub: "internal" };
            } else {
              if (!sel.value) throw new Error("pick a classification");
              const obj = { kind: t.kind, sub: sel.value };
              if (t.kind === "receive" && sel.value === "transfer-in" && acq && acq.value) {
                obj.acquiredUnix = R.dateToUnix(acq.value);
              }
              R.validateClassification(obj);
              state.classifications[t.txid] = obj;
            }
            save();
            renderClassify();
            msg($("tx-cls-msg"), "", "");
          } catch (e) { msg($("tx-cls-msg"), "Refused: " + e.message, "err"); }
        };
        go.addEventListener("click", apply);
        ctl.appendChild(sel);
        let acq = null;
        if (t.kind === "receive") {
          acq = document.createElement("input");
          acq.className = "input";
          acq.type = "date";
          acq.title = "Original acquisition date (transfer-in only — preserves holding period)";
          attr(acq, "aria-label", "Original acquisition date for transfer-in");
          if (c && c.acquiredUnix) acq.value = R.unixToDate(c.acquiredUnix);
          ctl.appendChild(acq);
        }
        ctl.appendChild(go);
        row.appendChild(meta);
        row.appendChild(ctl);
      }
      list.appendChild(row);
    }
    const total = rows.length;
    $("tx-cls-count").textContent = total ? `${done}/${total} classified` : "";
    if (!total) list.innerHTML = '<p class="lede">Nothing to classify yet — import history first.</p>';
  }

  $("tx-cls-unclass").addEventListener("change", renderClassify);

  /* ---------------- 4 prices ---------------- */

  function renderPrices() {
    const ul = $("tx-px-list");
    ul.innerHTML = "";
    const rows = [...state.prices].sort((a, b) => b.unix - a.unix);
    rows.forEach((p) => {
      const li = document.createElement("li");
      const grow = document.createElement("span");
      grow.className = "grow mono";
      grow.textContent = `${p.date} — ${R.formatUSD(p.cents)} / PRL`;
      const rm = document.createElement("button");
      rm.className = "rm";
      rm.type = "button";
      rm.textContent = "✕";
      attr(rm, "aria-label", "Remove price");
      rm.addEventListener("click", () => {
        state.prices = state.prices.filter((x) => x.date !== p.date);
        save();
        renderPrices();
      });
      li.appendChild(grow);
      li.appendChild(rm);
      ul.appendChild(li);
    });
  }

  function upsertPrice(date, centsStr) {
    const cents = R.parseUSDToCents(centsStr);
    R.dateToUnix(date);
    state.prices = state.prices.filter((x) => x.date !== date);
    state.prices.push({ date, unix: R.dateToUnix(date), cents: cents.toString() });
  }

  $("tx-px-add").addEventListener("click", () => {
    try {
      const d = $("tx-px-date").value;
      if (!d) throw new Error("date is required");
      upsertPrice(d, $("tx-px-price").value);
      $("tx-px-date").value = "";
      $("tx-px-price").value = "";
      save();
      renderPrices();
      msg($("tx-px-msg"), "Price added.", "ok");
    } catch (e) { msg($("tx-px-msg"), "Refused: " + e.message, "err"); }
  });

  $("tx-px-csv-import").addEventListener("click", () => {
    try {
      const rows = R.parsePriceCSV($("tx-px-csv").value);
      for (const r of rows) {
        state.prices = state.prices.filter((x) => x.date !== r.date);
        state.prices.push({ date: r.date, unix: r.unix, cents: r.cents.toString() });
      }
      $("tx-px-csv").value = "";
      save();
      renderPrices();
      msg($("tx-px-msg"), `${rows.length} price(s) imported.`, "ok");
    } catch (e) { msg($("tx-px-msg"), "Refused: " + e.message, "err"); }
  });

  /* ---------------- 5 report ---------------- */

  function txYears() {
    const ys = new Set(state.txs.filter((t) => !t.unconfirmed).map((t) => new Date(t.time * 1000).getUTCFullYear()));
    ys.add(new Date().getUTCFullYear());
    return [...ys].sort((a, b) => b - a);
  }

  let renderedYearsKey = "";
  function renderReportTab() {
    const sel = $("tx-rep-year");
    const cur = sel.value;
    const years = txYears();
    const key = years.join(",");
    if (key !== renderedYearsKey) {
      sel.innerHTML = "";
      for (const y of years) {
        const o = document.createElement("option");
        o.value = String(y);
        o.textContent = String(y);
        sel.appendChild(o);
      }
      renderedYearsKey = key;
    }
    if (cur && years.includes(Number(cur))) sel.value = cur;
  }

  function priceTable() {
    return [...state.prices]
      .map((p) => ({ date: p.date, unix: Number(p.unix), cents: BigInt(p.cents) }))
      .sort((a, b) => a.unix - b.unix);
  }

  $("tx-rep-run").addEventListener("click", () => {
    const year = Number($("tx-rep-year").value);
    lastReport = null;
    lastLedger = null;
    try {
      const ledger = R.runLedger({
        txs: state.txs,
        classifications: state.classifications,
        priceTable: priceTable(),
        openingLots: state.openingLots.map((o) => ({ date: o.date, grains: o.grains, priceCents: BigInt(o.priceCents) })),
      });
      lastLedger = ledger;
      lastReport = R.buildReport(ledger, year);
      renderReport(lastReport);
      msg($("tx-rep-msg"), `Report for ${year} complete — ${lastReport.totals.disposalCount} disposal(s).`, "ok");
    } catch (e) {
      renderRefusal(e);
      msg($("tx-rep-msg"), "REFUSED: " + e.message, "err");
    }
  });

  function renderRefusal(e) {
    $("tx-rep-summary").innerHTML = "";
    $("tx-rep-table").innerHTML = "";
    $("tx-rep-income").innerHTML = "";
    $("tx-rep-fees").innerHTML = "";
    const d = e.detail || {};
    const box = document.createElement("div");
    box.className = "refusal";
    let html = `<h4>The ledger refuses to run — nothing was guessed.</h4><p>${esc(e.message)}</p>`;
    if (d.unclassified && d.unclassified.length) {
      html += `<h4>Unclassified (${d.unclassified.length})</h4><ul>` +
        d.unclassified.slice(0, 20).map((t) => `<li><code>${esc(shortTx(t))}</code> — classify it in step ③</li>`).join("") +
        `</ul>`;
    }
    if (d.missingPrices && d.missingPrices.length) {
      html += `<h4>Missing prices (${d.missingPrices.length})</h4><ul>` +
        d.missingPrices.slice(0, 20).map((m) => `<li><code>${esc(m.txid.slice(0, 12))}…</code> · ${esc(m.date)} · ${esc(m.why)} — add it in step ④</li>`).join("") +
        `</ul>`;
    }
    box.innerHTML = html;
    $("tx-rep-summary").appendChild(box);
  }

  function renderReport(rep) {
    const t = rep.totals;
    const usd = (c) => R.formatUSD(c);
    const card = (k, v, cls) =>
      `<div class="card"><div class="k">${esc(k)}</div><div class="v ${cls || ""}">${esc(v)}</div></div>`;
    const gain = BigInt(t.gainCents);
    $("tx-rep-summary").innerHTML =
      card("Proceeds", usd(t.proceedsCents)) +
      card("Cost basis", usd(t.basisCents)) +
      card("Net gain / loss (fees incl.)", usd(t.gainCents), gain > 0n ? "pos" : gain < 0n ? "neg" : "") +
      card("Short-term", usd(t.shortGainCents)) +
      card("Long-term", usd(t.longGainCents)) +
      card("PRL income (FMV)", usd(t.incomeCents)) +
      card("Fee basis consumed", usd(t.feeBasisCents));

    const tb = $("tx-rep-table");
    tb.innerHTML = "";
    for (const d of rep.disposals) {
      const g = BigInt(d.gainCents);
      const tr = document.createElement("tr");
      tr.innerHTML =
        `<td class="mono">${esc(R.unixToDate(d.acquiredUnix))}</td>` +
        `<td class="mono">${esc(R.unixToDate(d.disposedUnix))}</td>` +
        `<td>${esc(d.label)} ${esc(R.formatPRL(d.grains))} PRL</td>` +
        `<td class="amt">${esc(usd(d.proceedsCents))}</td>` +
        `<td class="amt">${esc(usd(d.basisCents))}</td>` +
        `<td class="amt ${g > 0n ? "pos" : g < 0n ? "neg" : ""}">${esc(usd(d.gainCents))}</td>` +
        `<td>${d.longTerm ? "Long" : "Short"}</td>`;
      tb.appendChild(tr);
    }
    if (!rep.disposals.length) tb.innerHTML = '<tr><td colspan="7" class="unc">No disposals in this year.</td></tr>';

    const ti = $("tx-rep-income");
    ti.innerHTML = "";
    for (const e of rep.income) {
      const tr = document.createElement("tr");
      tr.innerHTML =
        `<td class="mono">${esc(e.date)}</td><td>${esc(e.type)}</td>` +
        `<td class="amt">${esc(R.formatPRL(e.grains))}</td>` +
        `<td class="amt">${esc(usd(e.fmvCents))}</td>` +
        `<td class="mono">${esc(shortTx(e.txid))}</td>`;
      ti.appendChild(tr);
    }
    if (!rep.income.length) ti.innerHTML = '<tr><td colspan="5" class="unc">No PRL income in this year.</td></tr>';

    const tf = $("tx-rep-fees");
    tf.innerHTML = "";
    for (const f of rep.fees) {
      const tr = document.createElement("tr");
      tr.innerHTML =
        `<td class="mono">${esc(f.date)}</td><td>${esc(f.label)}</td>` +
        `<td class="amt">${esc(R.formatPRL(f.grains))}</td>` +
        `<td class="amt">${esc(usd(f.basisCents))}</td>`;
      tf.appendChild(tr);
    }
    if (!rep.fees.length) tf.innerHTML = '<tr><td colspan="4" class="unc">No network fees in this year.</td></tr>';
  }

  /* ---------------- 6 export ---------------- */

  function download(name, text, mime) {
    const blob = new Blob([text], { type: mime || "text/plain" });
    const a = document.createElement("a");
    const url = typeof URL !== "undefined" && URL.createObjectURL ? URL.createObjectURL(blob) : null;
    if (!url) {
      msg($("tx-exp-msg"), "Refused: downloads are not available in this browser context.", "err");
      return;
    }
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      if (a.remove) a.remove();
      URL.revokeObjectURL(url);
    }, 1000);
  }

  function ensureReport() {
    if (lastReport) return lastReport;
    const year = Number($("tx-rep-year").value || new Date().getUTCFullYear());
    const ledger = R.runLedger({
      txs: state.txs,
      classifications: state.classifications,
      priceTable: priceTable(),
      openingLots: state.openingLots.map((o) => ({ date: o.date, grains: o.grains, priceCents: BigInt(o.priceCents) })),
    });
    lastLedger = ledger;
    lastReport = R.buildReport(ledger, year);
    return lastReport;
  }

  function renderExport() { /* nothing dynamic needed yet */ }

  $("tx-exp-csv-disp").addEventListener("click", () => {
    try {
      const rep = ensureReport();
      download(`pearl-tax-disposals-${rep.year}.csv`, R.disposalsCSV(rep), "text/csv");
      msg($("tx-exp-msg"), "Disposals CSV downloaded.", "ok");
    } catch (e) { msg($("tx-exp-msg"), "REFUSED: " + e.message, "err"); }
  });
  $("tx-exp-csv-income").addEventListener("click", () => {
    try {
      const rep = ensureReport();
      download(`pearl-tax-income-${rep.year}.csv`, R.incomeCSV(rep), "text/csv");
      msg($("tx-exp-msg"), "Income CSV downloaded.", "ok");
    } catch (e) { msg($("tx-exp-msg"), "REFUSED: " + e.message, "err"); }
  });
  $("tx-exp-json").addEventListener("click", () => {
    try {
      const rep = ensureReport();
      download(
        `pearl-tax-${rep.year}.json`,
        JSON.stringify({ exportedAt: new Date().toISOString(), addresses: state.addresses, report: rep }, null, 2),
        "application/json"
      );
      msg($("tx-exp-msg"), "Full JSON downloaded.", "ok");
    } catch (e) { msg($("tx-exp-msg"), "REFUSED: " + e.message, "err"); }
  });
  $("tx-exp-state-export").addEventListener("click", () => {
    const s = JSON.stringify(state);
    const done = () => msg($("tx-exp-msg"), "State JSON copied — store it somewhere safe.", "ok");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(s).then(done, () => {
        $("tx-exp-state-import").value = s;
        msg($("tx-exp-msg"), "Clipboard blocked — state placed in the box below instead.", "");
      });
    } else {
      $("tx-exp-state-import").value = s;
      msg($("tx-exp-msg"), "Clipboard unavailable — state placed in the box below.", "");
    }
  });
  $("tx-exp-state-restore").addEventListener("click", () => {
    try {
      const j = JSON.parse($("tx-exp-state-import").value);
      if (!j || !Array.isArray(j.addresses) || !Array.isArray(j.txs)) throw new Error("not a Pearl Tax state file");
      state = Object.assign(blank(), j);
      save();
      renderAll();
      msg($("tx-exp-msg"), "State restored.", "ok");
    } catch (e) { msg($("tx-exp-msg"), "Refused: " + e.message, "err"); }
  });
  let wipeArmed = false;
  $("tx-exp-wipe").addEventListener("click", () => {
    if (!wipeArmed) {
      wipeArmed = true;
      $("tx-exp-wipe").textContent = "Click again to confirm wipe";
      setTimeout(() => {
        wipeArmed = false;
        $("tx-exp-wipe").textContent = "Wipe all local data";
      }, 5000);
      return;
    }
    state = blank();
    lastReport = null;
    lastLedger = null;
    try { localStorage.removeItem(LS_KEY); } catch (e) {}
    wipeArmed = false;
    $("tx-exp-wipe").textContent = "Wipe all local data";
    renderAll();
    msg($("tx-exp-msg"), "All local data wiped.", "ok");
  });

  /* ---------------- footer ---------------- */

  $("tx-copy-donate").addEventListener("click", () => {
    const addr = $("tx-donate-addr").textContent.trim();
    const done = () => { $("tx-copy-donate").textContent = "Copied"; setTimeout(() => { $("tx-copy-donate").textContent = "Copy"; }, 1500); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(addr).then(done, done);
    else done();
  });

  /* ---------------- boot ---------------- */

  function renderAll() {
    renderAddresses();
    renderImport();
    renderClassify();
    renderPrices();
    renderReportTab();
  }
  renderAll();

  window.__taxTest = {
    state: () => state,
    save,
    renderAll,
    R,
  };
})();
