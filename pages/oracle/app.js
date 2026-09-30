/* Pearl Oracle — browser UI (classic script, drives window.PearlOracle).
 * Keys live in page memory only; publishing signs locally; the feed is
 * localStorage-only. Nothing is ever sent anywhere. */
(function () {
  "use strict";
  const E = window.PearlOracle;
  const $ = (id) => document.getElementById(id);

  let wallet = null;   // { priv, internalXOnly, address, network, source } — memory only
  let feed = [];       // local signed envelopes (objects)
  let viewingImport = false;

  /* ---------- helpers ---------- */

  const show = (el, on) => { el.hidden = !on; };
  const setErr = (id, msg) => { const e = $(id); e.textContent = msg || ""; e.hidden = !msg; };
  const setOk = (id, msg) => { const e = $(id); e.textContent = msg || ""; e.hidden = !msg; };

  function download(name, text, type) {
    try {
      const blob = new Blob([text], { type: type || "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
    } catch (e) {
      setErr("or-feed-err", "download failed: " + e.message);
    }
  }

  async function copyText(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
      const old = btn.textContent;
      btn.textContent = "Copied";
      setTimeout(() => { btn.textContent = old; }, 1200);
    } catch {
      setErr("or-feed-err", "copy failed — select the text manually");
    }
  }

  document.addEventListener("click", (ev) => {
    const b = ev.target && ev.target.closest ? ev.target.closest(".copy-btn") : null;
    if (!b) return;
    const src = $(b.getAttribute("data-for"));
    if (src) copyText(src.textContent || src.value || "", b);
  });

  /* ---------- tabs ---------- */

  const tabBtns = Array.prototype.slice.call(document.querySelectorAll("#tabs button"));
  function showTab(name) {
    tabBtns.forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    Array.prototype.forEach.call(document.querySelectorAll(".tab"), (s) => {
      s.classList.toggle("active", s.id === "tab-" + name);
    });
  }
  tabBtns.forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

  /* ---------- identity ---------- */

  function renderIdentity() {
    const has = !!wallet;
    show($("or-key-out"), has);
    $("or-wipe").hidden = !has;
    if (has) {
      $("or-key-source").textContent = wallet.source + " · " + wallet.network.label;
      $("or-xonly").textContent = E.oraclePubkeyHex(wallet.internalXOnly);
      $("or-address").textContent = wallet.address;
      $("or-network").textContent = wallet.network.id;
      refreshPublishDefaults();
    }
  }

  function loadKey(input) {
    try {
      wallet = E.oracleKeyFromInput(input, E.NETWORKS.mainnet);
      setErr("or-identity-err", null);
      renderIdentity();
    } catch (e) {
      wallet = null;
      renderIdentity();
      setErr("or-identity-err", "key rejected: " + e.message);
    }
  }

  $("or-gen12").addEventListener("click", () => loadKey(E.newMnemonic()));
  $("or-import").addEventListener("click", () => loadKey($("or-import-input").value));
  $("or-wipe").addEventListener("click", () => {
    wallet = null;
    $("or-import-input").value = "";
    renderIdentity();
    setErr("or-identity-err", null);
  });

  /* ---------- publish ---------- */

  function currentAsset() {
    return $("or-asset").value === "__custom" ? $("or-asset-custom").value.trim() : $("or-asset").value;
  }

  function refreshPublishDefaults() {
    const d = E.nextChainDefaults(feed);
    $("or-ts").value = String(Math.floor(Date.now() / 1000));
    $("or-seq").value = d.seq;
    $("or-prev").value = d.prev;
    $("or-nonce").value = E.genNonceHex();
    updatePreview();
  }

  $("or-asset").addEventListener("change", () => {
    $("or-asset-custom-box").hidden = $("or-asset").value !== "__custom";
    updatePreview();
  });

  $("or-nonce-gen").addEventListener("click", () => { $("or-nonce").value = E.genNonceHex(); updatePreview(); });

  ["or-price", "or-decimals", "or-ts", "or-seq", "or-nonce", "or-prev", "or-source", "or-asset-custom"].forEach((id) => {
    $(id).addEventListener("input", updatePreview);
  });

  function collectFields() {
    return {
      asset: currentAsset(),
      price: $("or-price").value.trim(),
      decimals: $("or-decimals").value.trim(),
      ts: $("or-ts").value.trim(),
      seq: $("or-seq").value.trim(),
      nonce: $("or-nonce").value.trim(),
      prev: $("or-prev").value.trim(),
      source: $("or-source").value,
    };
  }

  function updatePreview() {
    const f = collectFields();
    try {
      $("or-price-preview").textContent =
        "reads as " + E.formatPrice(f.price, f.decimals) + " " + (f.asset || "?");
    } catch { $("or-price-preview").textContent = "reads as — (fix price/decimals)"; }
    try {
      const c = E.canonicalAttestation(f);
      $("or-canonical").value = c;
      $("or-attid").textContent = E.attestationId(c);
    } catch (e) {
      $("or-canonical").value = "— invalid: " + e.message;
      $("or-attid").textContent = "—";
    }
  }

  $("or-publish").addEventListener("click", () => {
    setErr("or-pub-err", null);
    if (!wallet) { setErr("or-pub-err", "load an oracle key in the Identity tab first — publishing signs locally"); return; }
    let signed;
    try {
      signed = E.signAttestation({ fields: collectFields(), priv: wallet.priv, internalXOnly: wallet.internalXOnly });
    } catch (e) {
      setErr("or-pub-err", "refused: " + e.message);
      return;
    }
    feed.push(signed);
    try { E.saveFeed(feed); } catch (e) { setErr("or-pub-err", "signed but NOT persisted: " + e.message); return; }
    viewingImport = false;
    renderFeed();
    $("or-signed-json").value = JSON.stringify(signed, null, 2);
    show($("or-pub-out"), true);
    refreshPublishDefaults(); // next tick: seq+1, prev = this id
    updatePreview();
  });

  $("or-copy-signed").addEventListener("click", (ev) => copyText($("or-signed-json").value, ev.target));
  $("or-dl-signed").addEventListener("click", () => {
    download("attestation-" + $("or-attid").textContent.slice(0, 12) + ".json", $("or-signed-json").value);
  });
  $("or-goto-feed").addEventListener("click", () => showTab("feed"));

  /* ---------- feed ---------- */

  function fmtTs(ts) {
    try { return new Date(Number(BigInt(ts)) * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z"); }
    catch { return "—"; }
  }

  function renderFeed() {
    setErr("or-feed-err", null);
    setOk("or-feed-ok", null);
    const body = $("or-feed-body");
    body.innerHTML = "";
    $("or-feed-empty").hidden = feed.length > 0;
    feed.forEach((row, i) => {
      const v = E.verifyAttestation(row);
      const tr = document.createElement("tr");
      const price = (() => { try { return E.formatPrice(row.price, row.decimals); } catch { return "?"; } })();
      const idShort = (v.id || "?").slice(0, 12) + "…";
      const st = v.verdict === "INVALID" ? '<span class="st-invalid">INVALID</span>' : '<span class="st-valid">VALID</span>';
      tr.innerHTML =
        "<td>" + esc(row.seq) + "</td><td>" + esc(row.asset) + "</td><td>" + esc(price) + "</td>" +
        "<td>" + esc(fmtTs(row.ts)) + "</td><td title=\"" + esc(v.id || "") + "\">" + esc(idShort) + "</td>" +
        "<td class=\"src\">" + esc(row.source) + "</td><td>" + st + "</td>" +
        "<td><button class=\"rowbtn\" data-act=\"copy\" data-i=\"" + i + "\">copy</button>" +
        "<button class=\"rowbtn\" data-act=\"del\" data-i=\"" + i + "\">delete</button></td>";
      body.appendChild(tr);
    });
    body.querySelectorAll(".rowbtn").forEach((b) => b.addEventListener("click", () => {
      const i = Number(b.getAttribute("data-i"));
      if (b.getAttribute("data-act") === "del") {
        feed.splice(i, 1);
        persistQuiet();
        renderFeed();
      } else {
        copyText(JSON.stringify(feed[i], null, 2), b);
      }
    }));
    renderChartAssets();
    drawChart();
  }

  function esc(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function persistQuiet() {
    if (viewingImport) return; // imported feeds are not the local feed
    try { E.saveFeed(feed); } catch (e) { setErr("or-feed-err", "persist failed: " + e.message); }
  }

  $("or-chain-check").addEventListener("click", () => {
    const r = E.verifyFeedChain(feed);
    renderFeed(); // refresh per-row badges first (it clears stale messages)
    const el = $("or-chain-summary");
    if (r.ok) {
      el.textContent = "✓ chain intact — " + r.rows.length + " row(s): every signature verifies, prev links unbroken, seq strictly increasing";
      el.className = "chain-summary ok";
      setOk("or-feed-ok", "Whole-chain tamper check passed on " + r.rows.length + " attestation(s).");
    } else {
      el.textContent = "✗ chain BROKEN — see rows below";
      el.className = "chain-summary bad";
      const bad = r.rows.filter((x) => x.status === "INVALID");
      setErr("or-feed-err", "TAMPER DETECTED in " + bad.length + " row(s): " +
        bad.map((x) => "row " + x.index + " (" + x.errors.join("; ") + ")").join(" · "));
    }
  });

  /* ----- chart ----- */

  function renderChartAssets() {
    const sel = $("or-chart-asset");
    const assets = [...new Set(feed.map((r) => String(r.asset)))];
    const cur = sel.value;
    sel.innerHTML = "";
    assets.forEach((a) => {
      const o = document.createElement("option");
      o.value = a; o.textContent = a;
      sel.appendChild(o);
    });
    if (assets.includes(cur)) sel.value = cur;
  }

  $("or-chart-asset").addEventListener("change", drawChart);

  function drawChart() {
    const cv = $("or-chart");
    const note = $("or-chart-note");
    const g = cv.getContext ? cv.getContext("2d") : null;
    const asset = $("or-chart-asset").value;
    const s = asset ? E.seriesForAsset(feed, asset) : { points: [] };
    if (!g) { note.textContent = "canvas unavailable in this environment"; return; }
    const Wpx = cv.width, Hpx = cv.height, pad = 34;
    g.clearRect(0, 0, Wpx, Hpx);
    if (!s.points.length) {
      note.textContent = "Select an asset with at least one tick.";
      g.fillStyle = "#8a76b8"; g.font = "13px sans-serif"; g.textAlign = "center";
      g.fillText("no ticks yet", Wpx / 2, Hpx / 2);
      return;
    }
    note.textContent = s.points.length + " tick(s) · display conversion only — wire format keeps integer minor units";
    const xs = s.points.map((p) => p.ts), ys = s.points.map((p) => p.value);
    const x0 = Math.min(...xs), x1 = Math.max(...xs);
    const y0 = Math.min(...ys), y1 = Math.max(...ys);
    const X = (t) => pad + (x1 === x0 ? 0.5 : (t - x0) / (x1 - x0)) * (Wpx - 2 * pad);
    const Y = (v) => Hpx - pad - (y1 === y0 ? 0.5 : (v - y0) / (y1 - y0)) * (Hpx - 2 * pad);
    // gridlines
    g.strokeStyle = "#2c1d4d"; g.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad + (i / 4) * (Hpx - 2 * pad);
      g.beginPath(); g.moveTo(pad, y); g.lineTo(Wpx - pad, y); g.stroke();
    }
    // amber beacon line
    const grad = g.createLinearGradient(0, 0, Wpx, 0);
    grad.addColorStop(0, "#8b5cf6"); grad.addColorStop(1, "#fbbf24");
    g.strokeStyle = grad; g.lineWidth = 2.5; g.lineJoin = "round";
    g.beginPath();
    s.points.forEach((p, i) => { i ? g.lineTo(X(p.ts), Y(p.value)) : g.moveTo(X(p.ts), Y(p.value)); });
    g.stroke();
    // glow dots
    s.points.forEach((p) => {
      g.fillStyle = "#fbbf24";
      g.shadowColor = "#fbbf24"; g.shadowBlur = 10;
      g.beginPath(); g.arc(X(p.ts), Y(p.value), 3.5, 0, Math.PI * 2); g.fill();
      g.shadowBlur = 0;
    });
    // labels
    g.fillStyle = "#8a76b8"; g.font = "11px sans-serif"; g.textAlign = "left";
    g.fillText(fmtPrice(s.points[s.points.length - 1].value, s.decimals) + " " + asset, pad + 4, pad - 8);
    g.textAlign = "right";
    g.fillText(new Date(x0 * 1000).toISOString().slice(0, 10), Wpx - pad, Hpx - 8);
  }

  function fmtPrice(value, decimals) {
    // value is already scaled to `decimals` (Number, display only)
    const s = String(value);
    if (decimals === 0) return s;
    const neg = s.startsWith("-");
    const d = (neg ? s.slice(1) : s).padStart(decimals + 1, "0");
    return (neg ? "-" : "") + d.slice(0, -decimals) + "." + d.slice(-decimals);
  }

  /* ----- import / export ----- */

  $("or-feed-import-btn").addEventListener("click", () => {
    setErr("or-feed-err", null);
    try {
      const rows = E.importFeedText($("or-feed-import").value);
      feed = rows;
      viewingImport = true;
      renderFeed();
      const r = E.verifyFeedChain(feed);
      setOk("or-feed-ok", "Imported " + rows.length + " attestation(s) — all signatures verify. Chain check: " + (r.ok ? "INTACT" : "BROKEN (see rows)"));
    } catch (e) {
      setErr("or-feed-err", String(e.message || e));
    }
  });

  $("or-feed-import-file").addEventListener("change", (ev) => {
    const f = ev.target.files && ev.target.files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => { $("or-feed-import").value = String(rd.result || ""); $("or-feed-import-btn").click(); };
    rd.readAsText(f);
    ev.target.value = "";
  });

  $("or-feed-restore").addEventListener("click", () => {
    const { rows, dropped } = E.loadFeed();
    feed = rows;
    viewingImport = false;
    renderFeed();
    setOk("or-feed-ok", "Restored local feed (" + rows.length + " row(s)" + (dropped ? ", " + dropped + " invalid stored row(s) dropped" : "") + ").");
  });

  $("or-export-json").addEventListener("click", () => download("pearl-oracle-feed.json", E.feedToJSON(feed)));
  $("or-export-csv").addEventListener("click", () => download("pearl-oracle-feed.csv", E.feedToCSV(feed), "text/csv"));
  $("or-copy-feed").addEventListener("click", (ev) => copyText(E.feedToJSON(feed), ev.target));
  $("or-clear-feed").addEventListener("click", () => {
    if (!feed.length) return;
    if (!confirm("Delete all " + feed.length + " row(s) from the current view?" + (viewingImport ? "" : " This clears your LOCAL feed."))) return;
    feed = [];
    if (!viewingImport) { try { E.saveFeed(feed); } catch {} }
    viewingImport = false;
    renderFeed();
  });

  /* ---------- verify tab ---------- */

  $("or-verify-btn").addEventListener("click", () => {
    const v = E.verifyAttestation($("or-verify-input").value);
    show($("or-verify-result"), true);
    const vd = $("or-verdict");
    vd.textContent = v.verdict === "VALID-WARN" ? "VALID ⚠" : v.verdict;
    vd.className = "verdict " + v.verdict;
    $("or-verify-id").textContent = v.id || "— (could not recompute)";
    const box = $("or-verify-checks");
    box.innerHTML = "";
    v.checks.forEach((c) => {
      const d = document.createElement("div");
      d.className = "check " + c.status;
      d.innerHTML = "<span class=\"cs\">" + c.status + "</span><span><span class=\"cn\">" +
        esc(c.name) + "</span><br><span class=\"cd\">" + esc(c.detail) + "</span></span>";
      box.appendChild(d);
    });
  });

  /* ---------- boot ---------- */

  (function boot() {
    const { rows, dropped } = E.loadFeed();
    feed = rows;
    renderFeed();
    refreshPublishDefaults();
    renderIdentity();
    if (dropped) setErr("or-feed-err", dropped + " invalid stored row(s) were dropped from the local feed on load.");
  })();
})();
