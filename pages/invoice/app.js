/* Pearl Invoice — PRL invoicing studio (receive-only).
 * Boots window.PearlInvoice (the audited-bundle) + the vendored qrcode lib.
 * Five steps: Compose → Descriptor → Receive → Watch → Receipt, plus a
 * standalone Verify tab. The page never spends and never needs keys;
 * the optional fresh-address tool derives BIP-86 addresses in page memory
 * with a wipe button, and nothing is ever broadcast.
 */
(function () {
  "use strict";
  if (!window.PearlInvoice) { document.body.innerHTML = "<p style='padding:40px'>Failed to load the invoice bundle.</p>"; return; }
  if (!window.qrcode) { document.body.innerHTML = "<p style='padding:40px'>Failed to load the QR library.</p>"; return; }
  const R = window.PearlInvoice;
  const $ = (id) => document.getElementById(id);

  const state = {
    invoice: null,
    descriptorObj: null,
    receiptObj: null,
    payments: null,   // analyzePayments() result
    mnemonic: null,   // in-memory only, wipeable
    derivedCount: 0,
    autoTimer: null,
    watchRuns: 0,
  };
  window.__invoiceTest = { state };

  /* ---------- helpers ---------- */

  function showError(msg) {
    const e = $("inv-error");
    e.textContent = "⛔ " + msg;
    e.hidden = false;
    e.scrollIntoView({ block: "nearest" });
  }
  function clearError() { $("inv-error").hidden = true; $("inv-error").textContent = ""; }
  function toast(msg) {
    const t = $("inv-toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(t._h);
    t._h = setTimeout(() => { t.hidden = true; }, 2200);
  }
  async function copyText(text, label) {
    try {
      await navigator.clipboard.writeText(text);
      toast((label || "Copied") + " ✓");
    } catch {
      showError("Clipboard write failed — select and copy manually.");
    }
  }
  function goStep(n) {
    clearError();
    for (let i = 1; i <= 5; i++) {
      $("inv-panel-" + i).hidden = i !== n;
      $("inv-step-" + i).classList.toggle("active", i === n);
      $("inv-step-" + i).classList.toggle("done", i < n);
    }
    $("inv-wizard").hidden = false;
    $("inv-verify-wrap").hidden = true;
    $("inv-wiz-tab").classList.add("active");
    $("inv-ver-tab").classList.remove("active");
  }
  function showVerify() {
    clearError();
    $("inv-wizard").hidden = true;
    $("inv-verify-wrap").hidden = false;
    $("inv-wiz-tab").classList.remove("active");
    $("inv-ver-tab").classList.add("active");
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function qrSvg(uri) {
    const qr = window.qrcode(0, "M");
    qr.addData(uri);
    qr.make();
    return qr.createSvgTag({ cellSize: 5, margin: 4, scalable: true });
  }
  function download(filename, text, mime) {
    try {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([text], { type: mime || "application/json" }));
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => a.remove(), 500);
      toast("Downloaded " + filename + " ✓");
    } catch (e) {
      showError("Download failed: " + e.message);
    }
  }

  /* ---------- step 1: compose ---------- */

  function addItemRow(desc, amt) {
    const tr = document.createElement("tr");
    tr.className = "inv-item-row";
    const tdD = document.createElement("td");
    const inpD = document.createElement("input");
    inpD.className = "inv-item-desc"; inpD.placeholder = "e.g. Logo design"; inpD.value = desc || "";
    tdD.appendChild(inpD);
    const tdA = document.createElement("td");
    const inpA = document.createElement("input");
    inpA.className = "inv-item-amt"; inpA.placeholder = "0.00"; inpA.inputMode = "decimal"; inpA.value = amt || "";
    tdA.appendChild(inpA);
    const tdX = document.createElement("td");
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "inv-rm"; btn.textContent = "✕"; btn.title = "remove row";
    btn.addEventListener("click", () => { tr.remove(); updateTotalHint(); });
    tdX.appendChild(btn);
    tr.appendChild(tdD); tr.appendChild(tdA); tr.appendChild(tdX);
    $("inv-items-tbody").appendChild(tr);
    inpA.addEventListener("input", updateTotalHint);
    return tr;
  }

  function readItems() {
    const rows = Array.from(document.querySelectorAll(".inv-item-row"));
    return rows.map((tr) => ({
      description: tr.querySelector(".inv-item-desc").value,
      amountPRL: tr.querySelector(".inv-item-amt").value,
    }));
  }

  function updateTotalHint() {
    const hint = $("inv-total-hint");
    try {
      const items = readItems().filter((it) => it.amountPRL.trim());
      if (!items.length) { hint.textContent = ""; return; }
      let total = 0n;
      for (const it of items) total += R.parsePRLToGrains(it.amountPRL);
      const dust = total < R.MIN_TOTAL_GRAINS ? " — below the 546-grain dust floor ⚠" : "";
      hint.textContent = "Running total: " + R.formatPRL(total) + " PRL (" + total.toString() + " grains)" + dust;
      hint.classList.toggle("warn", total < R.MIN_TOTAL_GRAINS);
    } catch {
      hint.textContent = "";
    }
  }

  function buildInvoice() {
    clearError();
    const dueStr = $("inv-due").value;
    let dueUnix = null;
    if (dueStr) {
      const ms = Date.parse(dueStr + "T23:59:59");
      if (Number.isNaN(ms)) { showError("Due date is not a valid date."); return; }
      dueUnix = Math.floor(ms / 1000);
    }
    let inv;
    try {
      inv = R.buildInvoice({
        invoicee: $("inv-invoicee").value,
        items: readItems(),
        dueUnix,
        memo: $("inv-memo").value,
        address: $("inv-address").value,
        payerLabel: $("inv-payer").value,
      });
    } catch (e) {
      showError(e.message);
      return;
    }
    state.invoice = inv;
    state.descriptorObj = R.buildDescriptor(inv);
    state.receiptObj = null;
    state.payments = null;
    renderDescriptor();
    goStep(2);
    toast("Invoice sealed ✓");
  }

  /* ---------- step 2: descriptor ---------- */

  function renderDescriptor() {
    const d = state.descriptorObj;
    $("inv-canonical").textContent = d.canonical;
    $("inv-hash").textContent = d.hash;
    $("inv-descriptor").textContent = d.descriptor;
    $("inv-desc-meta").textContent =
      `network ${state.invoice.hrp} · total ${R.formatPRL(state.invoice.totalGrains)} PRL (${state.invoice.totalGrains} grains)` +
      (state.invoice.dueUnix ? ` · due ${new Date(state.invoice.dueUnix * 1000).toLocaleDateString()}` : " · no due date") +
      ` · pay to ${state.invoice.address}`;
  }

  function deriveFresh() {
    clearError();
    const m = $("inv-mnemonic").value.trim();
    if (!m) { showError("Paste your BIP-39 mnemonic first (it stays in page memory; use Wipe after)."); return; }
    try {
      const w = R.deriveInvoiceAddress(m, state.invoice.hrp, state.derivedCount);
      state.mnemonic = m;
      state.derivedCount += 1;
      $("inv-fresh-out").hidden = false;
      $("inv-fresh-addr").textContent = w.address;
      $("inv-fresh-path").textContent = w.path;
      $("inv-derive").textContent = "Derive next (index " + state.derivedCount + ")";
      toast("Fresh address derived ✓");
    } catch (e) {
      showError("Derivation failed: " + e.message);
    }
  }
  function useFreshAddress() {
    const addr = $("inv-fresh-addr").textContent.trim();
    if (!addr) return;
    // Re-seal the invoice against the fresh address.
    try {
      const inv = R.buildInvoice({
        invoicee: state.invoice.invoicee,
        items: state.invoice.items.map((it) => ({ description: it.description, amountPRL: R.formatPRL(it.grains) })),
        dueUnix: state.invoice.dueUnix,
        memo: state.invoice.memo,
        address: addr,
        payerLabel: state.invoice.payerLabel,
      });
      state.invoice = inv;
      state.descriptorObj = R.buildDescriptor(inv);
      $("inv-address").value = addr;
      renderDescriptor();
      renderReceive();
      toast("Invoice re-sealed to the fresh address ✓");
    } catch (e) {
      showError("Re-seal failed: " + e.message);
    }
  }
  function wipeMnemonic() {
    $("inv-mnemonic").value = "";
    state.mnemonic = null;
    state.derivedCount = 0;
    $("inv-fresh-out").hidden = true;
    $("inv-derive").textContent = "Derive fresh address (index 0)";
    toast("Mnemonic wiped from page memory ✓");
  }

  /* ---------- step 3: receive ---------- */

  function renderReceive() {
    const uri = R.paymentURI(state.invoice.address, state.invoice.totalGrains);
    $("inv-qr").innerHTML = qrSvg(uri);
    $("inv-uri").textContent = uri;
    $("inv-recv-addr").textContent = state.invoice.address;
    $("inv-recv-total").textContent = R.formatPRL(state.invoice.totalGrains) + " PRL (" + state.invoice.totalGrains + " grains)";
    state.lastURI = uri;
  }

  /* ---------- step 4: watch ---------- */

  function defaultBlockbook() {
    return R.NETWORKS[state.invoice.hrp === "tprl" ? "testnet" : "mainnet"].blockbook || "";
  }

  function watchStatus(txt, cls) {
    const el = $("inv-watch-state");
    el.textContent = txt;
    el.className = "watch-state " + (cls || "");
  }

  function renderPayments(analysis) {
    state.payments = analysis;
    const st = analysis.state;
    const fmt = (g) => R.formatPRL(g) + " PRL";
    if (st === "unpaid") {
      watchStatus("● UNPAID — no payments seen yet", "unpaid");
    } else if (st === "partial") {
      watchStatus(`◐ PARTIAL — ${fmt(analysis.receivedGrains)} received, ${fmt(analysis.remainingGrains)} still due`, "partial");
    } else if (st === "paid") {
      watchStatus(`● PAID — ${fmt(analysis.receivedGrains)} received in full ✓`, "paid");
    } else {
      watchStatus(`● OVERPAID — ${fmt(analysis.receivedGrains)} received, ${fmt(analysis.overpaidGrains)} over the total`, "paid");
    }
    const tb = $("inv-tx-tbody");
    tb.innerHTML = "";
    for (const p of analysis.payments) {
      const tr = document.createElement("tr");
      const unconf = p.confirmations === 0;
      tr.innerHTML =
        "<td class='mono'>" + esc(p.txid.slice(0, 16)) + "…" + "</td>" +
        "<td>" + fmt(p.grains) + "</td>" +
        "<td>" + p.confirmations + (unconf ? " ⚠ unconfirmed" : "") + "</td>";
      tb.appendChild(tr);
    }
    if (!analysis.payments.length) {
      tb.innerHTML = "<tr><td colspan='3' class='dim'>No payments to this address yet.</td></tr>";
    }
    const canReceipt = st === "paid" || st === "overpaid";
    $("inv-to-receipt").disabled = !canReceipt;
    $("inv-receipt-hint").textContent = canReceipt
      ? "Payment complete — you may issue a hash-bound receipt."
      : "Receipt unlocks when the invoice is paid in full.";
  }

  async function refreshWatch() {
    clearError();
    const base = $("inv-blockbook").value.trim() || defaultBlockbook();
    $("inv-blockbook").value = base;
    if (!base) {
      watchStatus("⚠ UNCONFIGURED — no Blockbook endpoint for this network. Paste one above.", "unpaid");
      showError("No Blockbook endpoint configured (no public Pearl testnet Blockbook is known — paste a custom one).");
      return;
    }
    watchStatus("… scanning Blockbook (GET-only) …", "");
    try {
      const act = await R.fetchAddressActivity(window.fetch.bind(window), base, state.invoice.address);
      let txs = act.txs;
      if (txs.length && typeof txs[0] === "string") {
        // Backend returned txids only — fetch each tx for its vouts.
        const full = [];
        for (const id of txs.slice(0, 100)) full.push(await R.fetchTx(window.fetch.bind(window), base, id));
        txs = full;
      }
      state.watchRuns += 1;
      renderPayments(R.analyzePayments(txs, state.invoice.address, state.invoice.totalGrains));
      $("inv-watch-note").textContent =
        `Last scan #${state.watchRuns} · ${txs.length} tx(s) seen at ${new Date().toLocaleTimeString()} · GET-only, nothing signed or broadcast.`;
    } catch (e) {
      watchStatus("⚠ UNREACHABLE — " + e.message, "unpaid");
      showError("Blockbook read failed: " + e.message + " — the watch is honestly offline, no data shown.");
    }
  }

  async function checkPastedTxid() {
    clearError();
    const txid = $("inv-txid-paste").value.trim();
    if (!/^[0-9a-fA-F]{64}$/.test(txid)) { showError("That is not a 64-hex-char txid."); return; }
    const base = $("inv-blockbook").value.trim() || defaultBlockbook();
    if (!base) { showError("Configure a Blockbook endpoint first (air-gapped path still needs a read source)."); return; }
    try {
      const tx = await R.fetchTx(window.fetch.bind(window), base, txid);
      renderPayments(R.analyzePayments([tx], state.invoice.address, state.invoice.totalGrains));
      $("inv-watch-note").textContent = "Air-gapped check: analyzed the pasted txid only — this is not a full address scan.";
      toast("txid analyzed ✓");
    } catch (e) {
      showError("Could not read that txid: " + e.message);
    }
  }

  function setAuto(on) {
    if (state.autoTimer) { clearInterval(state.autoTimer); state.autoTimer = null; }
    if (on) {
      state.autoTimer = setInterval(() => { refreshWatch(); }, 20000);
      toast("Auto-refresh on (20s) ✓");
    }
  }

  /* ---------- step 5: receipt ---------- */

  function issueReceipt() {
    clearError();
    if (!state.payments || !["paid", "overpaid"].includes(state.payments.state)) {
      showError("Receipt requires a paid invoice — run the Watch step first.");
      return;
    }
    const ps = state.payments.payments;
    const primary = ps.reduce((a, b) => (BigInt(a.grains) >= BigInt(b.grains) ? a : b));
    const conf = Math.min(...ps.map((p) => p.confirmations));
    state.receiptObj = R.buildReceipt(state.descriptorObj.hash, primary.txid, state.payments.receivedGrains, conf);
    $("inv-receipt-out").hidden = false;
    $("inv-receipt-str").textContent = state.receiptObj.receipt;
    $("inv-receipt-meta").textContent =
      `settling tx ${primary.txid.slice(0, 20)}… · ${state.payments.receivedGrains} grains (${R.formatPRL(state.payments.receivedGrains)} PRL)` +
      ` · min confirmations ${conf}${conf === 0 ? " ⚠ unconfirmed — wait for 1+ before treating this as settled" : ""}`;
    toast("Receipt issued ✓");
  }

  /* ---------- verify tab ---------- */

  function runVerify() {
    clearError();
    const out = $("inv-ver-out");
    out.hidden = false;
    const res = R.verifyInvoice($("inv-ver-desc").value, $("inv-ver-json").value);
    const rcptStr = $("inv-ver-receipt").value.trim();
    let rcptHtml = "";
    if (rcptStr) {
      const rr = R.verifyReceipt(rcptStr, {});
      rcptHtml = `<div class="verdict ${rr.proven ? "good" : "bad"}">${rr.proven ? "✓ RECEIPT FORMAT VALID" : "⛔ RECEIPT NOT VALID"} — ${esc(rr.reason)}</div>`;
    }
    out.innerHTML =
      `<div class="verdict ${res.proven ? "good" : "bad"}">${res.proven ? "✓ PROVEN" : "⛔ NOT PROVEN"} — ${esc(res.reason)}</div>` +
      rcptHtml +
      (res.proven
        ? `<div class="dim" style="margin-top:8px">The descriptor was recomputed from the invoice JSON you pasted and every field matches. Share both with confidence.</div>`
        : `<div class="dim" style="margin-top:8px">Do NOT trust this invoice: the descriptor does not match the invoice content.</div>`);
  }

  /* ---------- wire up ---------- */

  function init() {
    $("donate-addr").textContent = R.DONATE_ADDRESS;
    for (let i = 1; i <= 5; i++) {
      $("inv-step-" + i).addEventListener("click", () => {
        if (i > 1 && !state.invoice) { showError("Compose an invoice first."); return; }
        if (i > 3 && !state.descriptorObj) { showError("Seal the invoice (Descriptor step) first."); return; }
        if (i === 3) renderReceive();
        if (i === 4 && !$("inv-blockbook").value) $("inv-blockbook").value = defaultBlockbook();
        goStep(i);
      });
    }
    $("inv-wiz-tab").addEventListener("click", () => goStep(state.invoice ? 2 : 1));
    $("inv-ver-tab").addEventListener("click", showVerify);

    $("inv-add-item").addEventListener("click", () => addItemRow());
    $("inv-build").addEventListener("click", buildInvoice);

    $("inv-copy-desc").addEventListener("click", () => copyText($("inv-descriptor").textContent, "Descriptor copied"));
    $("inv-copy-canon").addEventListener("click", () => copyText($("inv-canonical").textContent, "Canonical JSON copied"));
    $("inv-download").addEventListener("click", () => {
      download(
        "pearl-invoice-commitment.json",
        R.invoiceToJSONExport(state.invoice, state.descriptorObj, null),
        "application/json"
      );
    });
    $("inv-derive").addEventListener("click", deriveFresh);
    $("inv-use-fresh").addEventListener("click", useFreshAddress);
    $("inv-wipe").addEventListener("click", wipeMnemonic);
    $("inv-to-receive").addEventListener("click", () => { renderReceive(); goStep(3); });

    $("inv-copy-uri").addEventListener("click", () => copyText(state.lastURI, "Payment URI copied"));
    $("inv-copy-addr").addEventListener("click", () => copyText(state.invoice ? state.invoice.address : "", "Address copied"));
    $("inv-to-watch").addEventListener("click", () => { if (!$("inv-blockbook").value) $("inv-blockbook").value = defaultBlockbook(); goStep(4); });

    $("inv-refresh").addEventListener("click", refreshWatch);
    $("inv-check-txid").addEventListener("click", checkPastedTxid);
    $("inv-auto").addEventListener("change", (e) => setAuto(e.target.checked));
    $("inv-to-receipt").addEventListener("click", () => goStep(5));

    $("inv-issue-receipt").addEventListener("click", issueReceipt);
    $("inv-export-json").addEventListener("click", () => {
      if (!state.receiptObj) { showError("Issue a receipt first."); return; }
      download("pearl-invoice-receipt.json", R.invoiceToJSONExport(state.invoice, state.descriptorObj, state.receiptObj));
    });
    $("inv-export-csv").addEventListener("click", () => {
      if (!state.receiptObj) { showError("Issue a receipt first."); return; }
      download("pearl-invoice-receipt.csv", R.invoiceToCSV(state.invoice, state.descriptorObj, state.receiptObj), "text/csv");
    });

    $("inv-ver-run").addEventListener("click", runVerify);
    $("inv-ver-fill").addEventListener("click", () => {
      if (!state.invoice) { showError("Compose an invoice first, then one click fills the verifier."); return; }
      $("inv-ver-desc").value = state.descriptorObj.descriptor;
      $("inv-ver-json").value = state.descriptorObj.canonical;
      toast("Verifier filled from the live invoice ✓");
    });

    // seed two blank rows + a demo-free compose form
    addItemRow();
    addItemRow();
    goStep(1);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
