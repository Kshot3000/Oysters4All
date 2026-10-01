/* Pearl Paywall UI — drives window.PearlPaywall (committed esbuild bundle).
 * Plain classic script, no build step. All signing is local; funding keys live
 * only in memory (wipe button) and are never persisted. */
(function () {
  "use strict";
  const P = window.PearlPaywall;
  if (!P) { document.body.innerHTML = "<p style='padding:2rem'>PearlPaywall bundle failed to load.</p>"; return; }

  const el = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const LS_KEY = "pearl-paywall-v1";

  const S = {
    spec: null, canonical: "", descriptor: "", hash: "",
    blockbook: "https://blockbook.pearlresearch.ai",
    txid: "", token: null,
    pollTimer: null,
  };

  function setErr(id, msg) { const e = el(id); if (e) e.textContent = msg || ""; }
  function fmtPRLg(g) { try { return P.fmtPRL(BigInt(g)) + " PRL"; } catch { return String(g) + " grains"; } }
  function shortTxid(t) { return t.length > 20 ? t.slice(0, 12) + "…" + t.slice(-6) : t; }

  function copyText(t, btn) {
    const done = () => { if (btn) { const o = btn.textContent; btn.textContent = "copied ✓"; setTimeout(() => { btn.textContent = o; }, 1200); } };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(t).then(done, () => fallbackCopy(t, done));
      } else fallbackCopy(t, done);
    } catch { fallbackCopy(t, done); }
  }
  function fallbackCopy(t, done) {
    try {
      const ta = document.createElement("textarea");
      ta.value = t; document.body.appendChild(ta); ta.select();
      document.execCommand("copy"); document.body.removeChild(ta); done();
    } catch { /* clipboard unavailable — user can select manually */ }
  }
  function download(name, text) {
    const blob = new Blob([text], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  /* ---------------- tabs ---------------- */
  const tabBtns = Array.from(document.querySelectorAll("#steps button"));
  function showTab(name) {
    tabBtns.forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    ["create", "pay", "token", "verify", "snippet"].forEach((t) => {
      el("tab-" + t).hidden = t !== name;
    });
    if (name !== "pay") {
      stopPolling();
      const cb = el("p-auto"); if (cb) cb.checked = false;
    }
  }
  tabBtns.forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

  /* ---------------- persistence (never keys) ---------------- */
  function save() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        canonical: S.canonical, descriptor: S.descriptor, hash: S.hash,
        blockbook: S.blockbook, txid: S.txid,
        token: S.token ? JSON.stringify(S.token) : null,
      }));
    } catch { /* private mode */ }
  }
  function load() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      const d = JSON.parse(raw);
      if (d.canonical && d.descriptor) {
        const parsed = JSON.parse(d.canonical);
        S.spec = P.validatePaywallSpec({
          title: parsed.title, pricePRL: P.fmtPRL(BigInt(parsed.priceGrains)),
          address: parsed.address, deliverable: parsed.deliverable,
          expiry: parsed.expiry ?? "", hrp: parsed.hrp,
        });
        S.canonical = d.canonical; S.descriptor = d.descriptor; S.hash = d.hash || "";
        S.blockbook = d.blockbook || S.blockbook;
        S.txid = d.txid || "";
        S.token = d.token ? JSON.parse(d.token) : null;
        renderCommitment();
      }
    } catch { /* corrupt snapshot — start clean */ }
  }

  /* ---------------- create ---------------- */
  function renderCommitment() {
    if (!S.descriptor) return;
    el("c-commit-card").hidden = false;
    el("c-descriptor").textContent = S.descriptor;
    el("c-canonical").textContent = S.canonical;
  }
  el("c-build").addEventListener("click", () => {
    setErr("c-err", "");
    try {
      S.spec = P.validatePaywallSpec({
        title: el("c-title").value, pricePRL: el("c-price").value,
        address: el("c-address").value, deliverable: el("c-deliverable").value,
        expiry: el("c-expiry").value, hrp: el("c-hrp").value,
      });
      S.blockbook = P.normalizeBlockbookBase(el("c-blockbook").value);
      const sealed = P.sealPaywall(S.spec);
      S.canonical = sealed.canonical; S.hash = sealed.hash; S.descriptor = sealed.descriptor;
      S.txid = ""; S.token = null;
      save();
      renderCommitment();
      showTab("pay");
      renderPayRequest();
    } catch (e) {
      setErr("c-err", e.message);
    }
  });
  el("c-copy-desc").addEventListener("click", (e) => copyText(S.descriptor, e.target));
  el("c-copy-canonical").addEventListener("click", (e) => copyText(S.canonical, e.target));
  el("c-dl-paywall").addEventListener("click", () => {
    download("pearl-paywall.json", JSON.stringify({
      descriptor: S.descriptor, hash: S.hash, canonical: JSON.parse(S.canonical),
    }, null, 2));
  });
  el("c-load-pay").addEventListener("click", () => { showTab("pay"); renderPayRequest(); });

  /* ---------------- pay ---------------- */
  function qrSvg(uri) {
    if (!window.qrcode) return "";
    const qr = window.qrcode(0, "M");
    qr.addData(uri);
    qr.make();
    return qr.createSvgTag({ cellSize: 5, margin: 4, scalable: true });
  }
  function renderPayRequest() {
    if (!S.spec) { el("p-price-line").textContent = "Seal a paywall on the Create tab first."; return; }
    const uri = P.paymentURI(S.spec.address, S.spec.priceGrains);
    el("p-price-line").textContent = `Pay exactly ${fmtPRLg(S.spec.priceGrains)} to`;
    el("p-uri").textContent = uri;
    const svg = qrSvg(uri);
    el("p-qr").innerHTML = svg;
    el("p-qr-note").textContent = svg ? "Scan with any Pearl wallet." : "QR library failed to load — copy the URI above instead.";
    if (S.txid) el("p-txid").value = S.txid;
  }
  el("p-load-created").addEventListener("click", renderPayRequest);
  el("p-copy-uri").addEventListener("click", (e) => copyText(el("p-uri").textContent, e.target));

  function renderPayAnalysis(a) {
    const box = el("p-out");
    const cls = a.paid ? (a.unconfirmed ? "pending" : "paid") : (a.paidGrains > 0n ? "short" : "unknown");
    const state = a.paid
      ? (a.unconfirmed ? "PAID — UNCONFIRMED (0-conf, provisional)" : "PAID ✓")
      : (a.paidGrains > 0n ? `UNDERPAID — shortfall ${fmtPRLg(a.shortfallGrains)}` : "NO PAYMENT FOUND");
    box.innerHTML =
      `<div class="paystate ${cls}"><strong>${esc(state)}</strong>` +
      `<dl class="kv">` +
      `<dt>txid</dt><dd>${esc(a.txid)}</dd>` +
      `<dt>received</dt><dd>${esc(fmtPRLg(a.paidGrains))} of ${esc(fmtPRLg(a.priceGrains))}</dd>` +
      `<dt>confirmations</dt><dd>${a.confirmations}</dd>` +
      (a.overpaidGrains > 0n ? `<dt>overpaid</dt><dd>${esc(fmtPRLg(a.overpaidGrains))}</dd>` : "") +
      `</dl></div>` +
      (a.paid ? `<p class="muted small">Payment looks good — continue to the Token tab to mint the buyer's access token.</p>` : "");
  }

  async function checkPayment() {
    setErr("p-err", "");
    el("p-out").innerHTML = "";
    if (!S.spec) { setErr("p-err", "Seal a paywall on the Create tab first."); return; }
    const txid = el("p-txid").value.trim();
    if (!/^[0-9a-fA-F]{64}$/.test(txid)) { setErr("p-err", "txid must be 64 hex chars."); return; }
    S.txid = txid.toLowerCase(); save();
    el("p-check").disabled = true;
    try {
      const tx = await P.fetchTx(fetch, S.blockbook, S.txid);
      renderPayAnalysis(P.analyzePayment(tx, S.spec.address, S.spec.priceGrains));
    } catch (e) {
      el("p-out").innerHTML = `<div class="paystate unknown"><strong>LOOKUP FAILED</strong><br>${esc(e.message)}<br><span class="muted small">The page shows this loudly instead of guessing — check the Blockbook endpoint or the txid and try again.</span></div>`;
    } finally {
      el("p-check").disabled = false;
    }
  }
  el("p-check").addEventListener("click", checkPayment);

  function stopPolling() {
    if (S.pollTimer) { clearInterval(S.pollTimer); S.pollTimer = null; }
  }
  el("p-auto").addEventListener("change", (e) => {
    stopPolling();
    if (e.target.checked) {
      if (!S.spec) { setErr("p-err", "Seal a paywall first."); e.target.checked = false; return; }
      const ms = parseInt(el("p-interval").value, 10) || 30000;
      checkPayment();
      S.pollTimer = setInterval(checkPayment, ms);
    }
  });

  el("p-addr-refresh").addEventListener("click", async () => {
    setErr("p-err", "");
    el("p-recent").innerHTML = "";
    if (!S.spec) { setErr("p-err", "Seal a paywall on the Create tab first."); return; }
    el("p-recent-note").textContent = "Loading…";
    try {
      const txs = await P.fetchAddressTxs(fetch, S.blockbook, S.spec.address, 25);
      if (!txs.length) {
        el("p-recent-note").textContent = "No transactions seen for this address yet.";
        return;
      }
      el("p-recent-note").textContent = `${txs.length} recent transaction(s), newest first.`;
      el("p-recent").innerHTML = txs.map((tx) => {
        const a = P.analyzePayment(tx, S.spec.address, S.spec.priceGrains);
        const conf = Number(tx.confirmations ?? 0);
        return `<div class="txrow"><button class="ghost small use" data-txid="${esc(String(tx.txid).toLowerCase())}">use</button>` +
          `<b>${esc(fmtPRLg(a.paidGrains))}</b> · ${esc(shortTxid(String(tx.txid)))} · ${conf} conf` +
          (a.paid ? " · <b>≥ price ✓</b>" : "") + `</div>`;
      }).join("");
      el("p-recent").querySelectorAll("[data-txid]").forEach((b) => {
        b.addEventListener("click", () => {
          el("p-txid").value = b.dataset.txid;
          checkPayment();
        });
      });
    } catch (e) {
      el("p-recent-note").textContent = "Blockbook unreachable: " + e.message;
    }
  });

  /* ---------------- token ---------------- */
  el("t-load-pay").addEventListener("click", () => {
    if (S.descriptor) el("t-descriptor").value = S.descriptor;
    if (S.txid) el("t-txid").value = S.txid;
    if (!S.descriptor) setErr("t-err", "No paywall sealed yet — create one first, or paste a descriptor by hand.");
  });
  el("t-wipe").addEventListener("click", () => {
    el("t-key").value = "";
    setErr("t-err", "");
  });
  el("t-mint").addEventListener("click", async () => {
    setErr("t-err", "");
    el("t-token-card").hidden = true;
    const descriptor = el("t-descriptor").value.trim();
    const txid = el("t-txid").value.trim();
    const key = el("t-key").value;
    if (!key) { setErr("t-err", "Enter the funding key (WIF, hex, or mnemonic)."); return; }
    el("t-mint").disabled = true;
    try {
      const { token, source } = await P.mintToken({
        descriptor, txid, keyInput: key,
        blockbookBase: S.blockbook, fetcher: fetch,
      });
      S.token = token; save();
      el("t-token-card").hidden = false;
      el("t-pubkey-line").innerHTML =
        `Token key <span class="mono">${esc(token.pubkey.slice(0, 16))}…</span> ` +
        `(${esc(source)}) — matches a P2TR input of the payment.`;
      el("t-token").textContent = JSON.stringify(token);
    } catch (e) {
      setErr("t-err", e.message);
    } finally {
      el("t-key").value = ""; // wipe on every attempt
      el("t-mint").disabled = false;
    }
  });
  el("t-copy-token").addEventListener("click", (e) => copyText(el("t-token").textContent, e.target));
  el("t-dl-token").addEventListener("click", () => {
    download("pearl-paywall-token.json", JSON.stringify(S.token, null, 2));
  });

  /* ---------------- verify ---------------- */
  el("v-run").addEventListener("click", async () => {
    setErr("v-err", "");
    el("v-out").innerHTML = `<p class="muted small">Verifying…</p>`;
    try {
      const r = await P.verifyToken({
        descriptor: el("v-desc").value,
        canonical: el("v-canonical").value,
        token: el("v-token").value,
        blockbookBase: S.blockbook,
        fetcher: fetch,
      });
      el("v-out").innerHTML =
        `<div class="verdict ${r.proven ? "proven" : "notproven"}">` +
        `<strong>${r.proven ? "PROVEN ✓" : "NOT PROVEN ✗"}</strong>` +
        `<ul>${r.reasons.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>`;
    } catch (e) {
      setErr("v-err", e.message);
      el("v-out").innerHTML = "";
    }
  });

  /* ---------------- snippet ---------------- */
  el("s-load-created").addEventListener("click", () => {
    if (!S.spec) { setErr("s-err", "Seal a paywall on the Create tab first."); return; }
    setErr("s-err", "");
  });
  el("s-generate").addEventListener("click", () => {
    setErr("s-err", "");
    el("s-snippet-card").hidden = true;
    if (!S.spec) { setErr("s-err", "Seal a paywall on the Create tab first."); return; }
    try {
      const snippet = P.buildEmbedSnippet({
        descriptor: S.descriptor,
        address: S.spec.address,
        priceGrains: String(S.spec.priceGrains),
        expiry: S.spec.expiry,
        blockbook: el("s-blockbook").value,
        contentId: el("s-content-id").value.trim() || "pw-content",
        tokenInputId: el("s-token-input-id").value.trim() || "pw-token",
        verifyButtonId: el("s-verify-button-id").value.trim() || "pw-verify",
        resultId: el("s-result-id").value.trim() || "pw-result",
      });
      S.snippet = snippet;
      el("s-snippet-card").hidden = false;
      el("s-echo-content").textContent = el("s-content-id").value.trim() || "pw-content";
      el("s-snippet").textContent = snippet;
      el("s-test-out").textContent = "";
    } catch (e) {
      setErr("s-err", e.message);
    }
  });
  el("s-copy-snippet").addEventListener("click", (e) => copyText(S.snippet || "", e.target));
  el("s-dl-snippet").addEventListener("click", () => {
    download("pearl-paywall-snippet.html", S.snippet || "");
  });
  el("s-test-snippet").addEventListener("click", () => {
    const out = el("s-test-out");
    try {
      if (!S.snippet) { out.textContent = "Generate the snippet first."; return; }
      // the snippet must inline the three primitives byte-identical to the bundle's
      const checks = [
        ["snipSha256Bytes", P.snipSha256Bytes],
        ["snipBech32mDecode", P.snipBech32mDecode],
        ["snipSchnorrVerify", P.snipSchnorrVerify],
      ];
      for (const [name, fn] of checks) {
        if (!S.snippet.includes(`var ${name} = ${fn.toString()};`)) {
          out.textContent = `SELF-TEST FAILED: inlined ${name} does not match the tested implementation.`;
          return;
        }
      }
      // live round-trip: the audited path takes Uint8Arrays, the snippet
      // contract is plain byte arrays — feed each its proper input type and
      // require both to agree.
      const priv = P.sha256(new TextEncoder().encode("paywall-selftest"));
      const msg = P.sha256(new TextEncoder().encode("paywall-selftest-msg"));
      const pub = P.schnorr.getPublicKey(priv);
      const sig = P.schnorr.sign(msg, priv);
      const okAudited = P.schnorr.verify(sig, msg, pub);
      const okSnippet = P.snipSchnorrVerify(
        Array.from(sig), Array.from(msg), Array.from(pub), P.snipSha256Bytes
      );
      if (okAudited && okSnippet) {
        out.textContent = "Self-test PASS: snippet inlines the tested primitives byte-identical, and a live sign/verify round-trip passes on both the audited and snippet paths.";
      } else {
        out.textContent = "SELF-TEST FAILED: live sign/verify round-trip mismatch.";
      }
    } catch (e) {
      out.textContent = "SELF-TEST FAILED: " + e.message;
    }
  });

  /* ---------------- footer ---------------- */
  el("copy-donate").addEventListener("click", (e) => copyText(el("donate-addr").textContent.trim(), e.target));

  /* ---------------- boot ---------------- */
  load();
  if (S.descriptor) renderPayRequest();
  showTab("create");
})();
