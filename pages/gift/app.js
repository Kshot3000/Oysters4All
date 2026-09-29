/* Pearl Gift UI — create / load / print / redeem paper wallets.
 * All crypto runs through the window.PearlGift bundle (audited Sign lineage);
 * this file is pure UI wiring. Keys live only in page memory. */
(() => {
  "use strict";
  const N = window.PearlGift;
  if (!N) { document.body.innerHTML = "<p style='padding:2rem'>Failed to load pearl-gift.bundle.js</p>"; return; }

  const $ = (id) => document.getElementById(id);
  const DONATE = "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d";

  /* storage that survives hostile localStorage (Gallery lesson) */
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return this.m?.[k] ?? null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { (this.m ??= {})[k] = v; } },
  };

  const S = {
    gift: null,                 // created/imported key material
    design: "abyss",
    network: N.NETWORKS.mainnet,
    blockbook: store.get("gift.blockbook") || N.NETWORKS.mainnet.blockbook,
    redeem: null,               // derived gift for the redeem flow
    utxos: [],
    plan: null,
    sweep: null,
  };

  const err = (id, msg) => { const e = $(id); e.hidden = !msg; e.textContent = msg || ""; };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmtPRL = (g) => N.fmtPRL(typeof g === "bigint" ? g : BigInt(g)) + " PRL";

  async function copyText(t) {
    try { await navigator.clipboard.writeText(t); return true; }
    catch { return false; }
  }

  /* ---------- step navigation ---------- */
  const steps = ["create", "load", "card", "redeem"];
  function goto(step) {
    steps.forEach((s) => {
      $("step-" + s).classList.toggle("active", s === step);
      const b = document.querySelector(`#steps button[data-step="${s}"]`);
      b.classList.toggle("active", s === step);
      if (steps.indexOf(s) < steps.indexOf(step)) b.classList.add("done");
    });
    if (step === "card") renderCard();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  document.querySelectorAll("#steps button").forEach((b) => b.addEventListener("click", () => goto(b.dataset.step)));

  /* ---------- QR helpers (convenience only; text is authoritative) ---------- */
  function drawQr(canvas, text) {
    try {
      if (typeof window.qrcode === "undefined") return;
      const qr = window.qrcode(0, "M");
      qr.addData(text); qr.make();
      const ctx = canvas.getContext("2d");
      const n = qr.getModuleCount(), s = canvas.width / n;
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#000";
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++)
        if (qr.isDark(r, c)) ctx.fillRect(c * s, r * s, s + 0.5, s + 0.5);
    } catch { /* QR is a convenience */ }
  }
  function svgQr(el, text) {
    try {
      if (typeof window.qrcode === "undefined") return;
      const qr = window.qrcode(0, "M");
      qr.addData(text); qr.make();
      el.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 8, scalable: true });
    } catch { /* QR is a convenience */ }
  }

  /* ---------- step 1: create ---------- */
  $("key-source").addEventListener("change", (e) => {
    $("key-input-wrap").hidden = e.target.value === "generate";
  });
  $("network").addEventListener("change", (e) => {
    S.network = N.NETWORKS[e.target.value];
    if (!store.get("gift.blockbook")) { S.blockbook = S.network.blockbook || ""; $("blockbook").value = S.blockbook; }
    S.gift = null; $("gift-key-card").hidden = true;
  });
  document.querySelectorAll(".design-btn").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll(".design-btn").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    S.design = b.dataset.design;
    renderCard();
  }));

  function makeGift(fresh) {
    err("gift-error", null);
    try {
      const src = fresh ? "generate" : $("key-source").value;
      let gift;
      if (src === "generate") gift = N.createGift({ network: S.network });
      else if (src === "mnemonic") gift = N.createGift({ mnemonic: $("key-input").value, network: S.network });
      else if (src === "wif") gift = N.createGift({ wif: $("key-input").value.trim(), network: S.network });
      else gift = N.createGift({ privHex: $("key-input").value.trim(), network: S.network });
      S.gift = gift;
      renderGiftCard();
    } catch (e) { err("gift-error", e.message); }
  }
  $("make-gift").addEventListener("click", () => makeGift(false));
  $("new-gift").addEventListener("click", () => { $("key-source").value = "generate"; $("key-input-wrap").hidden = true; makeGift(true); });

  function renderGiftCard() {
    const g = S.gift;
    if (!g) { $("gift-key-card").hidden = true; return; }
    $("gift-address").textContent = g.address;
    $("gift-path").textContent = g.account == null ? "imported key (no derivation path)" : `m/86'/${g.network.coinType}'/${g.account}'/0/${g.index}`;
    $("gift-wif").textContent = "••••••••••••••••";
    $("gift-wif").dataset.real = g.wif;
    $("secret-wrap") && ($("secret-wrap").hidden = true);
    $("reveal-secret").textContent = "Reveal private key";
    const mw = $("gift-mnemonic-wrap");
    if (g.mnemonic) { mw.hidden = false; $("gift-mnemonic").textContent = g.mnemonic; }
    else mw.hidden = true;
    drawQr($("gift-address-qr"), g.address);
    drawQr($("gift-wif-qr"), N.privateQrPayload(g));
    $("gift-key-card").hidden = false;
    $("to-load").disabled = false;
  }
  $("reveal-secret").addEventListener("click", () => {
    const el = $("gift-wif");
    const showing = el.textContent !== "••••••••••••••••";
    el.textContent = showing ? "••••••••••••••••" : el.dataset.real;
    $("reveal-secret").textContent = showing ? "Reveal private key" : "Hide private key";
  });
  $("copy-address").addEventListener("click", async () => {
    if (S.gift && await copyText(S.gift.address)) $("copy-address").textContent = "Copied ✓";
  });
  $("copy-wif").addEventListener("click", async () => {
    if (S.gift && await copyText(S.gift.wif)) $("copy-wif").textContent = "Copied ✓";
  });
  $("to-load").addEventListener("click", () => {
    renderLoad();
    goto("load");
  });

  /* ---------- step 2: load ---------- */
  function renderLoad() {
    const g = S.gift;
    if (!g) { err("funding-error", "Create a gift wallet first."); return; }
    $("load-address").textContent = g.address;
    drawQr($("load-qr"), g.address);
    $("load-balance").textContent = "not checked";
  }
  $("load-copy").addEventListener("click", async () => {
    if (S.gift && await copyText(S.gift.address)) $("load-copy").textContent = "Copied ✓";
  });
  $("check-funding").addEventListener("click", async () => {
    err("funding-error", null);
    if (!S.gift) return;
    const bb = $("blockbook").value.trim();
    if (!bb) { err("funding-error", "Set a Blockbook endpoint on the Create step first."); return; }
    S.blockbook = bb; store.set("gift.blockbook", bb);
    $("load-balance").textContent = "checking…";
    try {
      const utxos = await N.fetchUtxos(bb, S.gift.address);
      const confirmed = utxos.filter((u) => (u.confirmations ?? 0) > 0);
      const total = confirmed.reduce((a, u) => a + BigInt(u.value), 0n);
      $("load-balance").textContent = fmtPRL(total) + (utxos.length !== confirmed.length ? " confirmed" : "");
      if (confirmed.length === 0) err("funding-error", utxos.length ? "Funds seen but not yet confirmed — wait for one confirmation." : "No funds yet — send PRL to the address above, then check again.");
    } catch (e) { $("load-balance").textContent = "check failed"; err("funding-error", e.message); }
  });
  $("to-card").addEventListener("click", () => goto("card"));

  /* ---------- step 3: printable card ---------- */
  function renderCard() {
    const g = S.gift;
    const card = $("card-preview");
    card.classList.remove("design-abyss", "design-rose", "design-glacier");
    card.classList.add("design-" + S.design);
    if (!g) {
      $("card-to").textContent = $("gift-to").value || "—";
      $("card-from").textContent = $("gift-from").value || "—";
      $("card-message").textContent = $("gift-message").value || "";
      $("card-address").textContent = "create a gift wallet first";
      $("card-wif").textContent = "—";
      return;
    }
    $("card-to").textContent = $("gift-to").value.trim() || "—";
    $("card-from").textContent = $("gift-from").value.trim() || "—";
    $("card-message").textContent = $("gift-message").value.trim();
    $("card-address").textContent = g.address;
    $("card-wif").textContent = g.wif;
    svgQr($("card-address-qr"), g.address);
    svgQr($("card-wif-qr"), N.privateQrPayload(g));
  }
  $("gift-to").addEventListener("input", renderCard);
  $("gift-from").addEventListener("input", renderCard);
  $("gift-message").addEventListener("input", renderCard);
  $("print-card").addEventListener("click", () => window.print());
  $("to-redeem").addEventListener("click", () => goto("redeem"));

  /* ---------- step 4: redeem ---------- */
  $("redeem-derive").addEventListener("click", () => {
    err("redeem-error", null);
    S.redeem = null; S.utxos = []; S.plan = null; S.sweep = null;
    $("redeem-card").hidden = true; $("redeem-plan-panel").hidden = true;
    try {
      S.redeem = N.parseGiftSecret($("redeem-secret").value, S.network);
      $("redeem-address").textContent = S.redeem.address;
      $("redeem-card").hidden = false;
      $("utxo-paste-wrap").hidden = $("utxo-mode").value !== "manual";
    } catch (e) { err("redeem-error", e.message); }
  });
  $("utxo-mode").addEventListener("change", (e) => {
    $("utxo-paste-wrap").hidden = e.target.value !== "manual";
  });

  function parseManualUtxos(text) {
    const out = [];
    for (const line of String(text).split("\n").map((l) => l.trim()).filter(Boolean)) {
      const m = line.match(/^([0-9a-fA-F]{64}):(\d+)\s+(\d+)(?:\s+([a-zA-Z0-9]+))?$/);
      if (!m) throw new Error(`bad utxo line: "${line.slice(0, 40)}…" — expected txid:vout value [address]`);
      out.push({ txid: m[1].toLowerCase(), vout: Number(m[2]), value: Number(m[3]), address: m[4] || null });
    }
    if (!out.length) throw new Error("paste at least one UTXO line");
    return out;
  }

  $("redeem-fetch").addEventListener("click", async () => {
    err("redeem-error", null);
    $("redeem-utxos").textContent = "";
    $("redeem-plan-panel").hidden = true;
    S.utxos = []; S.plan = null;
    try {
      if (!S.redeem) throw new Error("Read the card first.");
      let utxos;
      if ($("utxo-mode").value === "manual") {
        utxos = parseManualUtxos($("utxo-paste").value);
        N.assertUtxosBelong(utxos, S.redeem.address);
      } else {
        const bb = $("blockbook").value.trim();
        if (!bb) throw new Error("Set a Blockbook endpoint on the Create step first.");
        S.blockbook = bb; store.set("gift.blockbook", bb);
        utxos = (await N.fetchUtxos(bb, S.redeem.address)).filter((u) => (u.confirmations ?? 0) > 0);
        if (!utxos.length) throw new Error("No confirmed funds found at this address. Wait for a confirmation, or paste UTXOs manually.");
        // suggest the live fee rate
        try { $("fee-rate").value = Math.max(1, Math.ceil(await N.fetchFeeRate(bb))); } catch { /* keep manual */ }
      }
      S.utxos = utxos;
      const total = utxos.reduce((a, u) => a + BigInt(u.value), 0n);
      $("redeem-utxos").textContent = `${utxos.length} confirmed UTXO${utxos.length === 1 ? "" : "s"} · ${fmtPRL(total)} available`;
      $("redeem-plan-panel").hidden = false;
    } catch (e) { err("redeem-error", e.message); }
  });

  $("redeem-plan").addEventListener("click", () => {
    err("sweep-error", null);
    $("plan-summary").hidden = true; $("sweep-result").hidden = true;
    $("build-sweep").disabled = true; S.sweep = null;
    try {
      if (!S.utxos.length) throw new Error("Find the gift funds first.");
      S.plan = N.planSweep({
        utxos: S.utxos,
        recipient: $("redeem-recipient").value,
        feeRateGrainsPerVByte: $("fee-rate").value,
        network: S.network,
      });
      const p = S.plan;
      $("plan-summary").innerHTML =
        `<div class="prow"><span>Inputs</span><span>${p.nIn} UTXO${p.nIn === 1 ? "" : "s"} (${fmtPRL(p.total)})</span></div>` +
        `<div class="prow"><span>Fee (${p.feeRate} gr/vB)</span><span>${fmtPRL(p.fee)}</span></div>` +
        `<div class="prow total"><span>You receive</span><span>${fmtPRL(p.amount)}</span></div>` +
        `<div class="prow"><span>To</span><span><code>${esc(p.recipient)}</code></span></div>`;
      $("plan-summary").hidden = false;
      $("build-sweep").disabled = false;
    } catch (e) { err("sweep-error", e.message); }
  });

  $("build-sweep").addEventListener("click", () => {
    err("sweep-error", null);
    $("sweep-result").hidden = true; $("broadcast-ok").hidden = true;
    try {
      if (!S.plan || !S.redeem) throw new Error("Plan the sweep first.");
      S.sweep = N.buildSweepTx({ privHex: S.redeem.privHex, utxos: S.utxos, plan: S.plan, network: S.network });
      $("sweep-txid").textContent = S.sweep.txid;
      $("sweep-hex").value = S.sweep.hex;
      $("sweep-result").hidden = false;
    } catch (e) { err("sweep-error", e.message); }
  });

  $("broadcast-sweep").addEventListener("click", async () => {
    err("broadcast-error", null); $("broadcast-ok").hidden = true;
    try {
      if (!S.sweep) throw new Error("Build the sweep first.");
      const bb = $("blockbook").value.trim();
      if (!bb) throw new Error("Set a Blockbook endpoint on the Create step first.");
      const txid = await N.broadcastTx(bb, S.sweep.hex);
      const ok = $("broadcast-ok");
      ok.textContent = "✓ Broadcast accepted. TXID: " + txid;
      ok.hidden = false;
    } catch (e) { err("broadcast-error", e.message); }
  });

  /* ---------- init ---------- */
  $("blockbook").value = S.blockbook;
  renderCard();
  if (typeof window.qrcode === "undefined") {
    console.warn("qrcode lib missing — QR codes disabled, addresses shown as text");
  }
})();
