/* Pearl Tipjar generator page wiring — classic script, uses window.PearlTipjar
 * bundle + the vendored qrcode lib (for pre-rendering QR art into the
 * snippet). The snippet itself is fully self-contained. */
(function () {
  "use strict";
  const R = window.PearlTipjar;
  if (!R) { document.body.innerHTML = "<p style='padding:40px'>Failed to load the Tipjar bundle.</p>"; return; }
  if (!window.qrcode) { document.body.innerHTML = "<p style='padding:40px'>Failed to load the QR library.</p>"; return; }

  const $ = (id) => document.getElementById(id);
  const els = {
    address: $("tj-address"), title: $("tj-title"), goal: $("tj-goal"),
    poll: $("tj-poll"), blockbook: $("tj-blockbook"),
    presets: [$("tj-p0"), $("tj-p1"), $("tj-p2"), $("tj-p3")],
    generate: $("tj-generate"), error: $("tj-error"),
    previewPanel: $("preview-panel"), preview: $("tj-preview"),
    snippetPanel: $("snippet-panel"), snippet: $("tj-snippet"),
    copySnippet: $("tj-copy-snippet"), snippetCopied: $("tj-snippet-copied"),
    descPanel: $("descriptor-panel"), descriptor: $("tj-descriptor"),
    copyDesc: $("tj-copy-desc"), copyConfig: $("tj-copy-config"),
    vConfig: $("tj-v-config"), vDesc: $("tj-v-desc"),
    verifyBtn: $("tj-verify"), verifyResult: $("tj-verify-result"),
    listenStart: $("tj-listen-start"), listenStop: $("tj-listen-stop"),
    listenCsv: $("tj-listen-csv"), listenMount: $("tj-listen"),
    copyDonate: $("copy-donate"), donateAddr: $("donate-addr"),
  };

  // Single source of truth for the donation address (core constant).
  els.donateAddr.textContent = R.DONATE_ADDRESS;
  els.address.value = R.DONATE_ADDRESS;

  // The widget runtime ships serialized in the bundle; the generator page
  // mounts the exact same code the snippet carries (byte-identical logic).
  const mountWidget = new Function("return (" + R.WIDGET_RUNTIME + ")")();

  let current = null; // { forged, configWithQr, snippet }

  function showError(msg) {
    els.error.textContent = msg;
    els.error.hidden = false;
    els.error.scrollIntoView({ block: "nearest" });
  }
  function clearError() { els.error.hidden = true; els.error.textContent = ""; }

  function selectedTheme() {
    const el = document.querySelector('input[name="tj-theme"]:checked');
    return el ? el.value : "harbor-lantern";
  }

  function readWizard() {
    const presets = els.presets.map((i) => i.value.trim()).filter((v) => v !== "");
    return {
      address: els.address.value,
      title: els.title.value,
      presets,
      goal: els.goal.value,
      theme: selectedTheme(),
      pollSec: els.poll.value,
      blockbook: els.blockbook.value,
    };
  }

  function qrSvg(uri) {
    const qr = window.qrcode(0, "M");
    qr.addData(uri);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
  }

  function stopWidget(container) {
    const h = container._pearlTipjar;
    if (h && h.stop) { try { h.stop(); } catch { /* already stopped */ } }
    container._pearlTipjar = null;
    container.innerHTML = "";
  }

  function generate() {
    clearError();
    let forged;
    try {
      forged = R.forgeTipjar(readWizard());
    } catch (e) {
      showError(e.message);
      return;
    }
    const cfg = forged.config;
    const qr = { "": qrSvg(R.pearlUri(cfg.address, null)) };
    for (const p of cfg.presets) {
      qr[p] = qrSvg(R.pearlUri(cfg.address, R.parsePRLToGrains(p)));
    }
    const configWithQr = { ...cfg, qr };
    let snippet;
    try {
      snippet = R.buildEmbedSnippet(configWithQr);
    } catch (e) {
      showError("Snippet build failed: " + e.message);
      return;
    }
    current = { forged, configWithQr, snippet };

    // preview: mount the real widget
    stopWidget(els.preview);
    mountWidget(els.preview, configWithQr);
    els.previewPanel.hidden = false;

    // snippet
    els.snippet.value = snippet;
    els.snippetPanel.hidden = false;

    // descriptor + verifier defaults
    els.descriptor.textContent = forged.descriptor;
    els.vConfig.value = forged.configJson;
    els.vDesc.value = forged.descriptor;
    els.verifyResult.hidden = true;
    els.descPanel.hidden = false;

    els.previewPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function verify() {
    const box = els.verifyResult;
    box.hidden = false;
    box.className = "verify";
    try {
      const v = R.verifyTipjar({ configJson: els.vConfig.value, descriptor: els.vDesc.value });
      box.classList.add("pass");
      box.innerHTML = "";
      const ok = document.createElement("div");
      ok.textContent = "✓ VERIFIED — this config exactly matches the descriptor.";
      const h = document.createElement("span");
      h.className = "vhash";
      h.textContent = "configHash " + v.configHash + " · " + v.config.title + " → " + v.config.address;
      box.appendChild(ok);
      box.appendChild(h);
    } catch (e) {
      box.classList.add("fail");
      box.innerHTML = "";
      const msg = document.createElement("div");
      msg.textContent = String((e && e.message) || e);
      box.appendChild(msg);
      const hint = document.createElement("span");
      hint.className = "vhash";
      hint.textContent = "Refusal is the correct outcome for any config that differs from what the descriptor commits to.";
      box.appendChild(hint);
    }
  }

  function setListening(on) {
    els.listenStart.disabled = on;
    els.listenStop.disabled = !on;
    els.listenCsv.disabled = !on;
  }

  function startListen() {
    clearError();
    if (!current) {
      // generate silently from the wizard so listen always has a config
      generate();
      if (!current || !els.error.hidden) return;
    }
    stopWidget(els.listenMount);
    mountWidget(els.listenMount, current.configWithQr);
    setListening(true);
  }

  function stopListen() {
    stopWidget(els.listenMount);
    setListening(false);
  }

  function exportCsv() {
    const h = els.listenMount._pearlTipjar;
    if (!h) return;
    const tips = h.tips();
    if (!tips.length) { showError("No tips detected yet — nothing to export."); return; }
    const blob = new Blob([R.tipsToCsv(tips)], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "pearl-tipjar-tips.csv";
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

  els.generate.addEventListener("click", generate);
  els.copySnippet.addEventListener("click", () => copyText(els.snippet.value, els.snippetCopied));
  els.snippet.addEventListener("click", () => els.snippet.select());
  els.copyDesc.addEventListener("click", () => copyText(els.descriptor.textContent.trim(), null));
  els.copyConfig.addEventListener("click", () => copyText(els.vConfig.value, null));
  els.verifyBtn.addEventListener("click", verify);
  els.listenStart.addEventListener("click", startListen);
  els.listenStop.addEventListener("click", stopListen);
  els.listenCsv.addEventListener("click", exportCsv);
  els.copyDonate.addEventListener("click", () => copyText(els.donateAddr.textContent.trim(), null));
})();
