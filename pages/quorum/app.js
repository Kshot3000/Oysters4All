/* Pearl Quorum — the council chamber UI controller.
 *
 * Classic IIFE over window.PearlQuorum. Six steps: Vault → Fund → Spend →
 * Cosign → Broadcast → Ledger. Private keys live in memory only; the desk
 * wipes the key field after every signing. No key ever leaves the page
 * except inside a signature the cosigner chose to emit.
 */
(function () {
  "use strict";
  const P = window.PearlQuorum;
  if (!P) throw new Error("Pearl Quorum bundle failed to load");

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const ORDER = ["vault", "fund", "spend", "cosign", "broadcast", "ledger"];
  const LS_KEY = "pearl-quorum-ledger-v1";
  const DONATE = "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d";

  const S = {
    network: P.NETWORKS.mainnet,
    vault: null,          // forged descriptor
    utxos: [],            // [{txid, vout, value, spkHex, confs, selected}]
    plan: null,           // spend plan
    bundle: null,         // imported unsigned bundle (cosign)
    sigBundles: [],       // collected signature bundles
    finalized: null,      // {txid, hex, ...}
    armed: false,
  };

  function err(id, msg) { const e = $(id); if (!e) return; e.hidden = !msg; e.textContent = msg || ""; }
  function showStep(name) {
    ORDER.forEach((s) => { $("step-" + s).classList.toggle("active", s === name); });
    document.querySelectorAll("#steps button").forEach((b) => {
      b.classList.toggle("active", b.dataset.step === name);
    });
    window.scrollTo({ top: 0, behavior: (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth") });
  }
  function unlock(upto) {
    const idx = ORDER.indexOf(upto);
    document.querySelectorAll("#steps button").forEach((b) => {
      if (ORDER.indexOf(b.dataset.step) <= idx) b.disabled = false;
    });
  }
  document.querySelectorAll("#steps button").forEach((b) => {
    b.addEventListener("click", () => { if (!b.disabled) showStep(b.dataset.step); });
  });
  function download(name, text, type) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: type || "application/json" }));
    a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  const net = () => ($("v-network").value === "testnet" ? P.NETWORKS.testnet : P.NETWORKS.mainnet);
  const g2p = (g) => P.fmtPRL(BigInt(g));
  const bb = (id, fallback) => {
    const v = $(id).value.trim();
    return v || fallback || "";
  };

  /* ---------- ledger ---------- */
  function loadLedger() {
    try { return JSON.parse(localStorage.getItem(LS_KEY)) || { vaults: [], spends: [] }; }
    catch { return { vaults: [], spends: [] }; }
  }
  function saveLedger(l) { localStorage.setItem(LS_KEY, JSON.stringify(l)); }
  function renderLedger() {
    const l = loadLedger();
    $("l-vaults").innerHTML = l.vaults.length ? l.vaults.map((v) =>
      `<div class="ledger-item"><h4>${esc(v.name)} — ${v.m}-of-${v.n} (${esc(v.network)})</h4>` +
      `<p>${esc(v.address)}</p><p>fingerprint ${esc(v.fingerprint)} · internal key: ${esc(v.internalKeyMode)}</p></div>`
    ).join("") : '<p class="note">No vaults recorded yet.</p>';
    $("l-spends").innerHTML = l.spends.length ? l.spends.map((s) =>
      `<div class="ledger-item"><h4>${esc(s.vault)} — ${g2p(s.outputsGrains)} PRL</h4>` +
      `<p>txid ${esc(s.txid)}</p><p>${s.inputs} inputs · fee ${g2p(s.feeGrains)} PRL · slots ${esc((s.slots || []).join("+"))} · ${esc(s.at)}</p></div>`
    ).join("") : '<p class="note">No spends recorded yet.</p>';
  }

  /* ---------- STEP 1: vault ---------- */
  function renderKeyInputs() {
    const n = Number($("v-n").value);
    const box = $("v-keys");
    box.innerHTML = "";
    for (let i = 0; i < n; i++) {
      const row = document.createElement("div");
      row.className = "key-row";
      row.innerHTML = `<span class="slot">Slot ${i + 1}</span>` +
        `<input data-key="${i}" aria-label="Slot ${i + 1} pubkey" autocomplete="off" spellcheck="false" placeholder="64-hex x-only or 66-hex compressed pubkey">`;
      box.appendChild(row);
    }
    const mSel = $("v-m");
    mSel.innerHTML = "";
    for (let i = 1; i <= n; i++) {
      const o = document.createElement("option");
      o.value = i; o.textContent = i;
      if (i === Math.min(2, n)) o.selected = true;
      mSel.appendChild(o);
    }
    const ik = $("v-ikslot");
    ik.innerHTML = "";
    for (let i = 0; i < n; i++) {
      const o = document.createElement("option");
      o.value = i; o.textContent = `Slot ${i + 1}`;
      ik.appendChild(o);
    }
  }
  $("v-n").addEventListener("change", renderKeyInputs);
  $("v-ikmode").addEventListener("change", () => {
    $("v-ikslot-wrap").hidden = $("v-ikmode").value !== "cosigner";
  });
  renderKeyInputs();

  $("v-sample").addEventListener("click", () => {
    $("v-network").value = "testnet";
    $("v-n").value = "3";
    renderKeyInputs();
    // BIP-340 test keys 0x01..0x03 -> x-only pubkeys (test use only)
    const pubs = ["79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
      "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5",
      "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9"];
    document.querySelectorAll("[data-key]").forEach((el, i) => { el.value = pubs[i] || ""; });
    $("v-name").value = "Sample council";
    err("vault-error", "");
  });

  function showVault(v) {
    S.vault = v;
    S.network = net();
    // A newly forged/imported vault invalidates any previously loaded spend
    // bundle, collected signatures, and finalize output — never let the
    // Cosign step act on another vault's state.
    S.bundle = null;
    S.sigBundles = [];
    S.finalized = null;
    $("c-final").hidden = true;
    $("vault-result").hidden = false;
    resetArm(); // S.finalized was just cleared above
    $("v-r-addr").textContent = v.address;
    $("v-r-fp").textContent = v.fingerprint;
    $("v-r-asm").textContent = v.scriptAsm;
    $("v-r-cb").textContent = v.controlBlockHex;
    const bd = $("v-r-backdoor");
    if (v.backdoorWarning) { bd.hidden = false; bd.textContent = "⚠ " + v.backdoorWarning; }
    else bd.hidden = true;
    $("v-desc-out").value = P.exportDescriptorText(v);
    $("f-addr").textContent = v.address;
    $("f-blockbook").value = v.network === "mainnet" ? P.DEFAULT_BLOCKBOOK : "";
    drawQR(v.address);
    refreshCosignSlots();
    drawRing();
    unlock("broadcast");
  }

  $("v-forge").addEventListener("click", () => {
    err("vault-error", "");
    try {
      const keys = [...document.querySelectorAll("[data-key]")].map((el) => el.value);
      const v = P.createVault({
        name: $("v-name").value,
        network: net(),
        m: Number($("v-m").value),
        keys,
        internalKeyMode: $("v-ikmode").value || "nums",
        internalKeySlot: Number($("v-ikslot").value) || 0,
      });
      showVault(v);
    } catch (e) { err("vault-error", e.message); }
  });

  $("v-import").addEventListener("click", () => {
    err("vault-import-error", "");
    try {
      const v = P.importDescriptorText($("v-desc-in").value);
      $("v-network").value = v.network;
      showVault(v);
      err("vault-import-error", "");
    } catch (e) { err("vault-import-error", e.message); }
  });

  $("v-copy-addr").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(S.vault.address); } catch { /* clipboard unavailable */ }
  });
  $("v-export").addEventListener("click", () => {
    if (!S.vault) return;
    download(`quorum-descriptor-${S.vault.fingerprint}.txt`, P.exportDescriptorText(S.vault), "text/plain");
  });
  $("v-save").addEventListener("click", () => {
    if (!S.vault) return;
    const l = loadLedger();
    if (!l.vaults.some((v) => v.fingerprint === S.vault.fingerprint)) l.vaults.push(S.vault);
    saveLedger(l);
    renderLedger();
  });

  /* ---------- QR (convenience only; the text address is authoritative) ---------- */
  function drawQR(text) {
    try {
      const qr = window.qrcode(0, "M");
      qr.addData(text); qr.make();
      const cv = $("f-qr"), ctx = cv.getContext("2d");
      const n = qr.getModuleCount(), s = cv.width / n;
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.fillStyle = "#0d0b09";
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++)
        if (qr.isDark(r, c)) ctx.fillRect(c * s, r * s, s + 0.5, s + 0.5);
    } catch { /* QR is a convenience */ }
  }
  $("f-copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(S.vault.address); } catch { /* ignore */ }
  });

  /* ---------- STEP 2: fund ---------- */
  $("f-recompute").addEventListener("click", () => {
    const box = $("f-verify");
    try {
      if (!S.vault) throw new Error("forge or import a vault first");
      const again = P.createVault({
        name: S.vault.name, network: S.vault.network, m: S.vault.m,
        keys: S.vault.pubkeys, internalKeyMode: S.vault.internalKeyMode,
        internalKeySlot: 0,
      });
      // NOTE: designated-key re-derivation needs the slot; find it.
      let match = again.address === S.vault.address;
      if (!match && S.vault.internalKeyMode === "cosigner") {
        const slot = S.vault.pubkeys.findIndex((k) => k === S.vault.internalXOnlyHex);
        const v2 = P.createVault({
          name: S.vault.name, network: S.vault.network, m: S.vault.m,
          keys: S.vault.pubkeys, internalKeyMode: "cosigner", internalKeySlot: slot,
        });
        match = v2.address === S.vault.address;
      }
      box.hidden = false;
      box.className = "note";
      box.textContent = match
        ? "✓ Address re-derived from the descriptor's cosigner keys — it matches. Every cosigner should see this same address."
        : "✗ MISMATCH — the address does NOT re-derive from the descriptor. Do not fund.";
    } catch (e) { box.hidden = false; box.className = "error"; box.textContent = e.message; }
  });

  function renderUtxos() {
    const tb = $("f-utxos");
    tb.innerHTML = "";
    S.utxos.forEach((u, i) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td><input type="checkbox" data-utxo="${i}" ${u.selected ? "checked" : ""}></td>` +
        `<td>${esc(u.txid.slice(0, 16))}…</td><td>${u.vout}</td>` +
        `<td>${g2p(u.value)}</td><td>${u.confs ?? "—"}</td>`;
      tb.appendChild(tr);
    });
    tb.querySelectorAll("[data-utxo]").forEach((c) => {
      c.addEventListener("change", () => { S.utxos[Number(c.dataset.utxo)].selected = c.checked; });
    });
    const bal = S.utxos.reduce((a, u) => a + BigInt(u.value), 0n);
    $("f-r-bal").textContent = g2p(bal) + " PRL";
    $("f-r-count").textContent = String(S.utxos.length);
    $("fund-result").hidden = false;
  }

  $("f-fetch").addEventListener("click", async () => {
    err("fund-error", "");
    try {
      if (!S.vault) throw new Error("forge or import a vault first");
      const base = bb("f-blockbook");
      if (!base) throw new Error("no Blockbook URL configured — paste UTXOs air-gapped below, or enter a Blockbook base URL");
      const list = await P.fetchUtxos(base, S.vault.address);
      S.utxos = list.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, spkHex: S.vault.spkHex, confs: u.confirmations, selected: true }));
      renderUtxos();
    } catch (e) { err("fund-error", e.message); }
  });

  $("f-apply").addEventListener("click", () => {
    err("fund-error", "");
    try {
      if (!S.vault) throw new Error("forge or import a vault first");
      let arr;
      try { arr = JSON.parse($("f-paste").value); }
      catch { throw new Error("pasted UTXOs are not valid JSON"); }
      if (!Array.isArray(arr) || !arr.length) throw new Error("paste a non-empty JSON array of UTXOs");
      S.utxos = arr.map((u, i) => {
        if (!/^[0-9a-f]{64}$/i.test(u.txid || "")) throw new Error(`UTXO ${i}: bad txid`);
        const v = Number(u.value);
        if (!Number.isSafeInteger(v) || v <= 0) throw new Error(`UTXO ${i}: bad value`);
        return { txid: u.txid.toLowerCase(), vout: Number(u.vout) || 0, value: v, spkHex: S.vault.spkHex, confs: null, selected: true };
      });
      renderUtxos();
    } catch (e) { err("fund-error", e.message); }
  });

  /* ---------- STEP 3: spend ---------- */
  function addOutputRow(addr, prl) {
    const box = $("s-outputs");
    const row = document.createElement("div");
    row.className = "out-row";
    row.innerHTML = `<label>Recipient address <input data-oaddr autocomplete="off" spellcheck="false" placeholder="prl1…" value="${esc(addr || "")}"></label>` +
      `<label>Amount (PRL) <input data-oprl type="number" min="0" step="any" placeholder="0.1" value="${esc(prl || "")}"></label>` +
      `<button class="ghost small" data-orm>✕</button>`;
    row.querySelector("[data-orm]").addEventListener("click", () => row.remove());
    box.appendChild(row);
  }
  $("s-add-out").addEventListener("click", () => addOutputRow("", ""));
  addOutputRow("", "");

  $("s-estimate").addEventListener("click", async () => {
    err("spend-error", "");
    try {
      const base = bb("s-blockbook", P.DEFAULT_BLOCKBOOK);
      const r = await P.fetchFeeRate(base, 2);
      // Blockbook quotes PRL/kB as a decimal; the grains/vB conversion can
      // land a hair above an integer in binary float (e.g. 2.0000000004),
      // and a naive Math.ceil would then overcharge by a whole grain/vB.
      $("s-feerate").value = Math.max(1, Math.ceil(r - 1e-9));
    } catch (e) { err("spend-error", e.message); }
  });

  $("s-build").addEventListener("click", () => {
    err("spend-error", "");
    try {
      if (!S.vault) throw new Error("forge or import a vault first");
      const ins = S.utxos.filter((u) => u.selected);
      if (!ins.length) throw new Error("no UTXOs selected — fetch or paste UTXOs in the Fund step and tick them");
      const payments = [...document.querySelectorAll("#s-outputs .out-row")].map((row, i) => {
        const addr = row.querySelector("[data-oaddr]").value.trim();
        const prl = row.querySelector("[data-oprl]").value.trim();
        if (!addr && !prl) return null;
        if (!addr || !prl) throw new Error(`recipient ${i + 1}: address and amount are both required`);
        let grains;
        try { grains = Number(P.parsePRL(prl)); }
        catch { throw new Error(`recipient ${i + 1}: invalid PRL amount`); }
        return { address: addr, grains };
      }).filter(Boolean);
      if (!payments.length) throw new Error("add at least one recipient");
      const plan = P.planQuorumSpend({
        vault: S.vault,
        inputs: ins,
        payments,
        feeRateGrainsPerVByte: Number($("s-feerate").value),
        feeRateSource: "manual",
      });
      S.plan = plan;
      $("spend-result").hidden = false;
      $("s-r-fp").textContent = plan.fingerprint;
      $("s-r-ins").textContent = `${plan.inputs.length} — ${g2p(plan.inputs.reduce((a, u) => a + u.value, 0))} PRL`;
      $("s-r-out").textContent = `${plan.outputs.filter((o) => !o.isChange).length} — ${g2p(plan.outputs.filter((o) => !o.isChange).reduce((a, o) => a + o.grains, 0))} PRL`;
      $("s-r-change").textContent = plan.changeGrains > 0 ? `${g2p(plan.changeGrains)} PRL → vault` : "none";
      $("s-r-fee").textContent = `${g2p(plan.feeGrains)} PRL @ ${plan.feeRateGrainsPerVByte} gr/vB`;
      $("s-r-vb").textContent = `${plan.vBytes} vB`;
      $("s-r-thr").textContent = `${plan.m}-of-${plan.n} signatures required per input`;
      const dw = $("s-r-dust");
      if (plan.dustAbsorbedGrains > 0) {
        dw.hidden = false;
        dw.textContent = `⚠ ${g2p(plan.dustAbsorbedGrains)} PRL of sub-dust change was absorbed into the fee (disclosed, not hidden).`;
      } else dw.hidden = true;
      $("s-r-digests").innerHTML = plan.digests.map((d, i) =>
        `<li><b>input ${i + 1}</b> ${esc(d)}</li>`).join("");
      $("s-bundle").value = P.exportUnsignedBundle(plan);
    } catch (e) { err("spend-error", e.message); }
  });

  $("s-export").addEventListener("click", () => {
    if (!S.plan) return;
    download(`quorum-unsigned-${S.plan.fingerprint}.json`, P.exportUnsignedBundle(S.plan));
  });
  $("s-copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("s-bundle").value); } catch { /* ignore */ }
  });

  /* ---------- STEP 4: cosign ---------- */
  function refreshCosignSlots() {
    const sel = $("c-slot");
    sel.innerHTML = "";
    const src = S.bundle || S.vault; // an imported bundle defines the slots, not the forged vault
    const n = src ? src.n : 3;
    for (let i = 0; i < n; i++) {
      const o = document.createElement("option");
      o.value = i;
      o.textContent = `Slot ${i + 1} (${src ? src.pubkeys[i].slice(0, 12) + "…" : ""})`;
      sel.appendChild(o);
    }
  }

  function drawRing() {
    const svg = $("q-ring");
    const n = S.bundle ? S.bundle.n : (S.vault ? S.vault.n : 3);
    const m = S.bundle ? S.bundle.m : (S.vault ? S.vault.m : 2);
    const signed = new Set(S.sigBundles.map((s) => s.slot));
    const cx = 60, cy = 60, r = 48;
    const gap = 0.06; // radians
    let html = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#2e251b" stroke-width="10"/>`;
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2 + gap / 2;
      const a1 = ((i + 1) / n) * Math.PI * 2 - gap / 2;
      const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
      const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
      const large = (a1 - a0) > Math.PI ? 1 : 0;
      const col = signed.has(i) ? "#f2c66d" : "#3a2f20";
      html += `<path d="M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}" ` +
        `fill="none" stroke="${col}" stroke-width="10" stroke-linecap="round"/>`;
    }
    svg.innerHTML = html;
    $("q-count").textContent = `${signed.size}/${m}`;
    const box = $("c-slots");
    box.innerHTML = (S.bundle ? S.bundle.pubkeys : []).map((k, i) =>
      `<div class="slot-row"><span class="slot-dot ${signed.has(i) ? "signed" : ""}"></span>` +
      `<span>Slot ${i + 1}</span><code>${esc(k.slice(0, 20))}…</code>` +
      `<span>${signed.has(i) ? "sealed ✓" : "awaiting"}</span></div>`
    ).join("") || '<p class="note">Load an unsigned bundle to begin.</p>';
    $("c-finalize").disabled = !(S.bundle && signed.size >= S.bundle.m);
  }

  $("c-import").addEventListener("click", () => {
    err("cosign-error", "");
    try {
      const b = P.importUnsignedBundle($("c-bundle").value);
      S.bundle = b;
      S.sigBundles = [];
      S.finalized = null;
      $("c-final").hidden = true;
      refreshCosignSlots();
      drawRing();
      err("cosign-error", "");
    } catch (e) { err("cosign-error", e.message); }
  });

  $("c-sign").addEventListener("click", () => {
    err("cosign-error", "");
    try {
      if (!S.bundle) throw new Error("verify & load an unsigned bundle first");
      const sb = P.signSlot({ bundle: S.bundle, slot: Number($("c-slot").value), privHex: $("c-key").value });
      $("c-key").value = ""; // the key never lingers in the page after signing
      $("c-sigs-out").value = P.exportSigBundleText(sb);
      addSigBundle(sb);
    } catch (e) { err("cosign-error", e.message); }
  });

  $("c-wipe").addEventListener("click", () => {
    $("c-key").value = "";
    err("cosign-error", "");
  });

  function addSigBundle(sb) {
    const c = P.collectSigs(S.bundle, [...S.sigBundles, sb]);
    if (c.problems.length) throw new Error(c.problems[0]);
    S.sigBundles = [...S.sigBundles, sb];
    $("c-sigs-in").value = "";
    drawRing();
  }

  $("c-add").addEventListener("click", () => {
    err("c-collect-error", "");
    try {
      if (!S.bundle) throw new Error("verify & load an unsigned bundle first");
      let sb;
      try { sb = P.importSigBundleText($("c-sigs-in").value); }
      catch (e) { throw new Error("signature bundle rejected: " + e.message); }
      addSigBundle(sb);
    } catch (e) { err("c-collect-error", e.message); }
  });

  $("c-finalize").addEventListener("click", () => {
    err("c-collect-error", "");
    try {
      const f = P.finalizeSpend(S.bundle, S.sigBundles);
      S.finalized = f;
      $("c-final").hidden = false;
      $("c-r-txid").textContent = f.txid;
      $("c-r-slots").textContent = f.slots.map((s) => s + 1).join(", ");
      $("c-r-fee").textContent = g2p(f.feeGrains) + " PRL";
      $("c-r-sigs").textContent = `${f.slots.length * S.bundle.inputs.length}/${f.slots.length * S.bundle.inputs.length} valid`;
      $("c-r-hex").value = f.hex;
      $("b-arm").disabled = false; // the desk can arm the broadcast now
      unlock("broadcast");
    } catch (e) { err("c-collect-error", e.message); }
  });

  /* ---------- STEP 5: broadcast ---------- */
  function resetArm() {
    S.armed = false;
    $("b-confirm").hidden = true;
    $("b-arm").disabled = !S.finalized;
  }
  $("b-arm").addEventListener("click", () => {
    err("bcast-error", "");
    if (!S.finalized) { err("bcast-error", "nothing to broadcast — assemble a quorum spend in the Cosign step first"); return; }
    S.armed = true;
    $("b-confirm").hidden = false;
    err("bcast-error", "Armed. Press CONFIRM to broadcast — this moves real PRL on " + (S.bundle ? S.bundle.network : "mainnet") + ".");
  });
  $("b-confirm").addEventListener("click", async () => {
    err("bcast-error", "");
    if (!S.armed || !S.finalized) return;
    try {
      const base = bb("b-blockbook", P.DEFAULT_BLOCKBOOK);
      if (!base) throw new Error("no Blockbook URL configured");
      const txid = await P.broadcastViaBlockbook(base, S.finalized.hex);
      S.broadcastTxid = txid; // what the network accepted is the record of truth
      $("bcast-result").hidden = false;
      $("b-r-status").textContent = "broadcast accepted";
      $("b-r-txid").textContent = txid;
      $("b-r-confs").textContent = "0 (just broadcast)";
      resetArm();
    } catch (e) { err("bcast-error", e.message); }
  });
  $("b-track").addEventListener("click", async () => {
    err("bcast-error", "");
    try {
      if (!S.finalized) throw new Error("no broadcast yet");
      const base = bb("b-blockbook", P.DEFAULT_BLOCKBOOK);
      const st = await P.fetchTxStatus(base, S.finalized.txid);
      $("b-r-confs").textContent = String(st.confirmations ?? st.confs ?? "?");
    } catch (e) { err("bcast-error", e.message); }
  });
  $("b-record").addEventListener("click", () => {
    if (!S.finalized || !S.bundle) return;
    const l = loadLedger();
    l.spends.push({
      at: new Date().toISOString(),
      vault: S.bundle.vaultName,
      txid: S.broadcastTxid || S.finalized.txid,
      inputs: S.bundle.inputs.length,
      outputsGrains: S.bundle.outputs.filter((o) => !o.isChange).reduce((a, o) => a + o.grains, 0),
      feeGrains: S.finalized.feeGrains,
      slots: S.finalized.slots.map((s) => s + 1),
    });
    saveLedger(l);
    renderLedger();
  });

  /* ---------- STEP 6: ledger ---------- */
  $("l-csv-vaults").addEventListener("click", () => {
    download("quorum-vaults.csv", P.vaultToCSV(loadLedger().vaults), "text/csv");
  });
  $("l-csv-spends").addEventListener("click", () => {
    download("quorum-spends.csv", P.spendsToCSV(loadLedger().spends), "text/csv");
  });
  $("l-clear").addEventListener("click", () => {
    if (!confirm("Clear the whole council record?")) return;
    saveLedger({ vaults: [], spends: [] });
    renderLedger();
  });

  // test hook (used by the committed browser QA only — same pattern as the other desks)
  window.__quorumTest = {
    set: (id, v) => { $(id).value = v; },
    click: (id) => $(id).click(),
    state: () => ({
      vault: S.vault, plan: S.plan, bundle: S.bundle,
      sigBundles: S.sigBundles, finalized: S.finalized, utxos: S.utxos,
    }),
  };

  // init
  if (DONATE !== "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d") {
    console.error("donation address mismatch");
  }
  drawRing();
  renderLedger();
  resetArm();
})();
