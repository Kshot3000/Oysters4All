/* Pearl Recover page wiring — classic script, uses window.PearlRecover bundle.
 * The seed lives only in the `seed` variable (page memory). It is never
 * written to localStorage, never put in a URL, never sent anywhere.
 * The Lock button nulls it and clears the textarea. */
(function () {
  "use strict";
  const R = window.PearlRecover;
  if (!R) { document.body.innerHTML = "<p style='padding:40px'>Failed to load the Recover bundle.</p>"; return; }

  const $ = (id) => document.getElementById(id);
  const els = {
    seed: $("rc-seed"), network: $("rc-network"),
    acctStart: $("rc-acct-start"), acctEnd: $("rc-acct-end"),
    gap: $("rc-gap"), cap: $("rc-cap"), blockbook: $("rc-blockbook"),
    start: $("rc-start"), stop: $("rc-stop"), lock: $("rc-lock"),
    error: $("rc-error"),
    progressPanel: $("progress-panel"), bar: $("rc-bar"), status: $("rc-status"),
    resultsPanel: $("results-panel"), tbody: $("rc-tbody"),
    totals: $("rc-totals"), empty: $("rc-empty"),
    csv: $("rc-csv"), copy: $("rc-copy"), copied: $("rc-copied"),
    copyDonate: $("copy-donate"), donateAddr: $("donate-addr"),
  };

  // Single source of truth for the donation address (core constant).
  els.donateAddr.textContent = R.DONATE_ADDRESS;

  let seed = null;        // the mnemonic, page memory only
  let abortFlag = false;  // scan abort
  let found = [];         // hits so far
  let scannedTotal = 0;
  let running = false;

  function showError(msg) {
    els.error.textContent = msg;
    els.error.hidden = false;
  }
  function clearError() { els.error.hidden = true; els.error.textContent = ""; }

  function readSettings() {
    const networkId = els.network.value;
    const network = R.NETWORKS[networkId];
    if (!network) return { error: "Unknown network." };
    const range = R.normalizeAccountRange(els.acctStart.value, els.acctEnd.value);
    if (range.error) return { error: range.error };
    const gapLimit = Number(els.gap.value);
    const indexCap = Number(els.cap.value);
    if (!Number.isInteger(gapLimit) || gapLimit < 1) return { error: "Gap limit must be a positive integer." };
    if (!Number.isInteger(indexCap) || indexCap < 1) return { error: "Index cap must be a positive integer." };
    let base = els.blockbook.value.trim().replace(/\/$/, "");
    if (!/^https?:\/\//.test(base)) return { error: "Blockbook URL must start with http(s)://" };
    return { networkId, network, range, gapLimit, indexCap, base };
  }

  function chainName(c) {
    return c === 0
      ? '<span class="chain-ext">external</span>'
      : '<span class="chain-int">internal</span>';
  }

  function renderTotals() {
    const s = R.summarize(found);
    els.totals.innerHTML =
      `<span>Used addresses <strong>${s.count}</strong></span>` +
      `<span>Total balance <strong>${s.totalPrl} PRL</strong></span>` +
      `<span class="mono">${s.totalGrains.toString()} grains</span>` +
      `<span>Scanned <strong>${scannedTotal}</strong></span>`;
    els.empty.hidden = s.count !== 0;
  }

  function addRow(h) {
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td class="num">${h.account}</td><td>${chainName(h.change)}</td>` +
      `<td class="num">${h.index}</td>` +
      `<td class="addr">${h.address}</td>` +
      `<td class="num">${h.txs}</td>` +
      `<td class="num">${R.formatPrl(h.balance)} PRL</td>`;
    els.tbody.appendChild(tr);
  }

  function setRunning(on) {
    running = on;
    els.start.disabled = on;
    els.stop.disabled = !on;
    els.seed.disabled = on;
  }

  async function startScan() {
    clearError();
    const mnemonic = els.seed.value;
    const v = R.validateSeedPhrase(mnemonic);
    if (v.error) { showError(v.error); return; }
    const s = readSettings();
    if (s.error) { showError(s.error); return; }
    seed = v.words.join(" ");

    found = [];
    scannedTotal = 0;
    els.tbody.innerHTML = "";
    els.resultsPanel.hidden = false;
    els.progressPanel.hidden = false;
    renderTotals();
    setRunning(true);
    abortFlag = false;

    const accounts = s.range.end - s.range.start + 1;
    const estimate = accounts * 2 * s.indexCap; // lower-bound progress estimate
    const chainLabel = (c) => (c === 0 ? "external" : "internal");

    try {
      const res = await R.scanAccounts({
        mnemonic: seed,
        network: s.network,
        accountStart: s.range.start,
        accountEnd: s.range.end,
        gapLimit: s.gapLimit,
        indexCap: s.indexCap,
        concurrency: R.DEFAULT_CONCURRENCY,
        blockbookBase: s.base,
        shouldAbort: () => abortFlag,
        onProgress: (p) => {
          scannedTotal = p.scannedTotal;
          const pct = Math.min(100, (scannedTotal / estimate) * 100);
          els.bar.style.width = pct.toFixed(1) + "%";
          els.status.textContent =
            `account ${p.account} · ${chainLabel(p.change)} · index ${p.index} — ` +
            `${found.length} used · ${scannedTotal} scanned`;
          renderTotals();
        },
        onAddress: (h) => { found.push(h); addRow(h); renderTotals(); },
      });
      if (res.aborted) {
        els.status.textContent += " — stopped by user.";
      } else {
        els.status.textContent =
          `done — ${R.summaryLine(found, scannedTotal)}` +
          (res.cappedChains.length ? ` (index cap hit on ${res.cappedChains.length} chain(s) — raise the cap and re-scan if you expected more)` : "");
        els.bar.style.width = "100%";
      }
    } catch (e) {
      showError("Scan failed: " + (e && e.message ? e.message : e));
    } finally {
      setRunning(false);
      renderTotals();
    }
  }

  function lock() {
    seed = null;
    els.seed.value = "";
    els.status.textContent = "🔒 Seed wiped from page memory.";
    els.error.hidden = true;
  }

  function downloadCsv() {
    if (!found.length) return;
    const blob = new Blob([R.toCsv(found)], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "pearl-recover.csv";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  async function copyText(text, doneEl) {
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { ok = document.execCommand("copy"); } catch { ok = false; }
      ta.remove();
    }
    if (doneEl) {
      doneEl.hidden = !ok;
      if (ok) setTimeout(() => { doneEl.hidden = true; }, 2000);
    }
    return ok;
  }

  els.start.addEventListener("click", startScan);
  els.stop.addEventListener("click", () => { abortFlag = true; });
  els.lock.addEventListener("click", lock);
  els.csv.addEventListener("click", downloadCsv);
  els.copy.addEventListener("click", () => copyText(found.map((h) => h.address).join("\n"), els.copied));
  els.copyDonate.addEventListener("click", () => copyText(els.donateAddr.textContent.trim(), null));
})();
