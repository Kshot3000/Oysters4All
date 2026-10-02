/* Pearl Vault UI — boots window.PearlVault (the audited bundle) + vendored qrcode.
 * The page never uploads keys anywhere; signing keys live in memory only. */
(function () {
  "use strict";
  const V = window.PearlVault;
  if (!V) { document.body.innerHTML = "<p style='padding:40px'>Failed to load the Pearl Vault bundle.</p>"; return; }
  if (!window.qrcode) { document.body.innerHTML = "<p style='padding:40px'>Failed to load the QR library.</p>"; return; }

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const state = { descriptor: null, network: null, bundle: null, partials: [], trackTimer: null };

  function showErr(msg) {
    const e = $("err");
    e.hidden = false;
    e.textContent = String(msg).slice(0, 600);
    e.scrollIntoView({ behavior: (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"), block: "nearest" });
  }
  function clearErr() { $("err").hidden = true; $("err").textContent = ""; }
  function toast(msg) {
    const t = document.createElement("div");
    t.className = "toast"; t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2200);
  }
  function download(filename, text, mime) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: mime || "application/json" }));
    a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(() => a.remove(), 500);
    toast("Downloaded " + filename + " ✓");
  }
  function copyText(text, label) {
    navigator.clipboard.writeText(text).then(
      () => toast((label || "Copied") + " ✓"),
      () => showErr("Copy failed — select the text manually."));
  }
  function qrSvg(uri) {
    const qr = window.qrcode(0, "M");
    qr.addData(uri);
    qr.make();
    return qr.createSvgTag({ cellSize: 5, margin: 4, scalable: true });
  }
  const fmtPRL = (g) => V.grainsToPRL(g);

  /* ---------- tabs ---------- */
  const TABNAMES = ["forge", "fund", "plan", "sign", "track", "verify"];
  const tabBtns = TABNAMES.map((n) => $("tb-" + n));
  tabBtns.forEach((b) => b.addEventListener("click", () => {
    tabBtns.forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    TABNAMES.forEach((n) => { $("panel-" + n).hidden = true; });
    $("panel-" + b.dataset.tab).hidden = false;
    clearErr();
    window.scrollTo({ top: 0, behavior: (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth") });
  }));
  const gotoTab = (name) => $("tb-" + name).click();

  /* ---------- descriptor persistence (descriptor only — never keys) ---------- */
  function saveDescriptor(d) {
    state.descriptor = d;
    state.network = Object.values(V.NETWORKS).find((x) => x.id === d.network);
    try { localStorage.setItem("pearl-vault:descriptor", JSON.stringify(d)); } catch {}
    syncVaultViews();
  }
  function loadDescriptor() {
    if (state.descriptor) return state.descriptor;
    try {
      const raw = localStorage.getItem("pearl-vault:descriptor");
      if (!raw) return null;
      const d = JSON.parse(raw);
      const v = V.verifyDescriptor(d);
      if (!v.ok) { localStorage.removeItem("pearl-vault:descriptor"); return null; }
      state.descriptor = d;
      state.network = Object.values(V.NETWORKS).find((x) => x.id === d.network);
      return d;
    } catch { return null; }
  }
  function defaultBlockbook(network) {
    return (network && network.blockbook) || "";
  }

  /* ---------- 1 · FORGE ---------- */
  let keyRows = []; // [{input, priv}]
  function renderKeyRows() {
    const n = Number($("f-n").value);
    const wrap = $("f-keys");
    wrap.innerHTML = "";
    keyRows = [];
    for (let i = 0; i < n; i++) {
      const row = document.createElement("div");
      row.className = "keyrow";
      const idx = document.createElement("span");
      idx.className = "kidx"; idx.textContent = `Cosigner ${i}`;
      const input = document.createElement("input");
      input.type = "text"; input.autocomplete = "off"; input.spellcheck = false;
      input.placeholder = "64-hex x-only pubkey · priv hex · WIF · mnemonic";
      input.setAttribute("aria-label", "Cosigner " + i + " key");
      const lab = document.createElement("label");
      lab.className = "priv";
      lab.title = "Tick if this row holds YOUR private key (lets you sign later)";
      const priv = document.createElement("input");
      priv.type = "checkbox";
      const labTxt = document.createElement("span");
      labTxt.textContent = " my privkey";
      lab.appendChild(priv);
      lab.appendChild(labTxt);
      row.appendChild(idx); row.appendChild(input); row.appendChild(lab);
      wrap.appendChild(row);
      keyRows.push({ input, priv });
    }
    const mSel = $("f-m");
    const cur = Number(mSel.value);
    mSel.innerHTML = "";
    for (let m = 1; m <= n; m++) {
      const o = document.createElement("option");
      o.textContent = String(m);
      if (m === Math.min(cur, n)) o.selected = true;
      mSel.appendChild(o);
    }
  }
  $("f-n").addEventListener("change", renderKeyRows);
  renderKeyRows();

  $("f-clear").addEventListener("click", () => {
    keyRows.forEach((r) => { r.input.value = ""; r.priv.checked = false; });
    $("f-result").hidden = true;
    clearErr();
  });

  $("f-forge").addEventListener("click", () => {
    clearErr();
    try {
      const network = V.NETWORKS[$("f-network").value];
      const n = Number($("f-n").value);
      const m = Number($("f-m").value);
      const inputs = [];
      keyRows.slice(0, n).forEach((r, i) => {
        const raw = r.input.value.trim();
        const isPriv = r.priv.checked;
        if (!raw) throw new Error(`VAULT REFUSED: cosigner ${i} is empty`);
        if (isPriv) {
          // Marked "my privkey": resolve to the x-only key NOW — the
          // descriptor stores public keys only, never the secret.
          let xhex;
          if (/^[0-9a-fA-F]{64}$/.test(raw)) {
            xhex = V.bytesToHex(V.cosignerPrivFromHex(raw, network).xonly);
          } else {
            const k = V.cosignerKeyFromInput(raw, network);
            if (!k.priv) throw new Error(`VAULT REFUSED: cosigner ${i} marked as privkey but has no private part`);
            xhex = V.bytesToHex(k.xonly);
          }
          inputs.push(xhex);
        } else {
          inputs.push(raw);
        }
      });
      const d = V.buildVaultDescriptor(network, inputs, m);
      saveDescriptor(d);
      $("f-address").textContent = d.address;
      $("f-qr").innerHTML = qrSvg("pearl:" + d.address);
      $("f-descriptor").textContent = d.descriptor;
      $("f-hash").textContent = d.hash;
      $("f-quorum").textContent = `${d.m}-of-${d.n} · ${network.label}`;
      $("f-internal").textContent = d.internalXOnly + "  (NUMS — no known private key)";
      $("f-result").hidden = false;
      toast("Vault forged ✓");
    } catch (e) { showErr(e.message); }
  });
  $("f-copy-addr").addEventListener("click", () => copyText($("f-address").textContent, "Address"));
  $("f-copy-desc").addEventListener("click", () => copyText($("f-descriptor").textContent, "Descriptor"));
  $("f-download").addEventListener("click", () => {
    if (!state.descriptor) return;
    download(`pearl-vault-${state.descriptor.m}of${state.descriptor.n}.json`,
      JSON.stringify(state.descriptor, null, 2));
  });
  $("f-use").addEventListener("click", () => gotoTab("fund"));

  /* ---------- shared vault views ---------- */
  function syncVaultViews() {
    const d = state.descriptor;
    const has = !!d;
    $("fund-empty").hidden = has;
    $("fund-body").hidden = !has;
    $("plan-empty").hidden = has;
    $("plan-body").hidden = !has;
    if (has) {
      $("fund-address").textContent = d.address;
      $("fund-qr").innerHTML = qrSvg("pearl:" + d.address);
      $("fund-quorum").textContent = `Quorum: ${d.m}-of-${d.n} · vault address is P2TR`;
      $("fund-net").textContent = state.network.label;
      $("plan-net").textContent = state.network.label;
      if (!$("fund-bb").value) $("fund-bb").value = defaultBlockbook(state.network);
      if (!$("t-bb").value) $("t-bb").value = defaultBlockbook(state.network);
    }
  }
  $("fund-goto-forge").addEventListener("click", () => gotoTab("forge"));

  /* ---------- 2 · FUND ---------- */
  $("fund-copy").addEventListener("click", () => copyText($("fund-address").textContent, "Address"));
  let fundUtxos = [];
  $("fund-refresh").addEventListener("click", async () => {
    clearErr();
    const d = loadDescriptor();
    if (!d) { showErr("VAULT REFUSED: no vault loaded"); return; }
    const bb = $("fund-bb").value.trim() || defaultBlockbook(state.network);
    if (!bb) { showErr("VAULT REFUSED: no Blockbook URL — set one above (no public testnet Blockbook is known)"); return; }
    $("fund-refresh").disabled = true;
    try {
      const st = await V.fetchVaultState(bb, d.address);
      fundUtxos = st.utxos;
      $("fund-balance").textContent = `${fmtPRL(st.balance)} PRL (${st.balance} grains)`;
      $("fund-received").textContent = `${fmtPRL(st.totalReceived)} PRL`;
      $("fund-txs").textContent = String(st.txCount);
      const box = $("fund-utxos");
      box.innerHTML = st.utxos.length ? "" : "<p class='hint'>No UTXOs — fund the address above first.</p>";
      st.utxos.forEach((u) => {
        const div = document.createElement("div");
        div.className = "utxo";
        div.innerHTML = `<code>${esc(u.txid)}:${u.vout}</code><span class="conf">${u.confirmations} conf</span><span class="val">${esc(fmtPRL(u.value))} PRL</span>`;
        box.appendChild(div);
      });
      toast("Refreshed ✓");
    } catch (e) { showErr(e.message); }
    finally { $("fund-refresh").disabled = false; }
  });
  $("fund-load-plan").addEventListener("click", () => { gotoTab("plan"); });

  /* ---------- 3 · PLAN ---------- */
  let recipRows = []; // [{div, addr, amt}]
  function addRecipRow(addr, prl) {
    const div = document.createElement("div");
    div.className = "recip";
    const row = document.createElement("div");
    row.className = "row";
    const labA = document.createElement("label");
    labA.className = "grow"; labA.textContent = "Recipient (prl1…/tprl1…)";
    const addrEl = document.createElement("input");
    addrEl.type = "text"; addrEl.spellcheck = false;
    addrEl.placeholder = "prl1…"; addrEl.value = addr || "";
    labA.appendChild(addrEl);
    const labP = document.createElement("label");
    labP.textContent = "Amount (PRL)";
    const amtEl = document.createElement("input");
    amtEl.type = "text"; amtEl.setAttribute("inputmode", "decimal");
    amtEl.placeholder = "0.5"; amtEl.value = prl || "";
    labP.appendChild(amtEl);
    const rm = document.createElement("button");
    rm.type = "button"; rm.className = "btn-small rm"; rm.textContent = "✕";
    row.appendChild(labA); row.appendChild(labP); row.appendChild(rm);
    div.appendChild(row);
    $("plan-recips").appendChild(div);
    const rec = { div, addr: addrEl, amt: amtEl };
    rm.addEventListener("click", () => {
      div.remove();
      recipRows = recipRows.filter((x) => x !== rec);
    });
    recipRows.push(rec);
  }
  $("plan-add-recip").addEventListener("click", () => addRecipRow("", ""));
  addRecipRow("", "");

  $("plan-fetch").addEventListener("click", async () => {
    clearErr();
    const d = loadDescriptor();
    if (!d) { showErr("VAULT REFUSED: no vault loaded"); return; }
    const bb = $("fund-bb").value.trim() || defaultBlockbook(state.network);
    if (!bb) { showErr("VAULT REFUSED: set a Blockbook URL in step 2 first"); return; }
    try {
      const utxos = await V.fetchUtxos(bb, d.address);
      fundUtxos = utxos.map((u) => ({ txid: u.txid, vout: u.vout, value: BigInt(String(u.value)), confirmations: u.confirmations ?? 0 }));
      renderPlanUtxos();
    } catch (e) { showErr(e.message); }
  });
  let planUtxoRows = []; // [{check, utxo}]
  function renderPlanUtxos() {
    const box = $("plan-utxos");
    box.innerHTML = fundUtxos.length ? "" : "<p class='hint'>No UTXOs fetched yet.</p>";
    planUtxoRows = [];
    fundUtxos.forEach((u) => {
      const div = document.createElement("div");
      div.className = "utxo";
      const check = document.createElement("input");
      check.type = "checkbox"; check.checked = true;
      const code = document.createElement("code");
      code.textContent = `${u.txid}:${u.vout}`;
      const conf = document.createElement("span");
      conf.className = "conf"; conf.textContent = `${u.confirmations} conf`;
      const val = document.createElement("span");
      val.className = "val"; val.textContent = `${fmtPRL(u.value)} PRL`;
      div.appendChild(check); div.appendChild(code); div.appendChild(conf); div.appendChild(val);
      box.appendChild(div);
      planUtxoRows.push({ check, utxo: u });
    });
  }
  $("plan-all").addEventListener("click", () => planUtxoRows.forEach((r) => { r.check.checked = true; }));
  $("plan-none").addEventListener("click", () => planUtxoRows.forEach((r) => { r.check.checked = false; }));

  $("plan-estimate").addEventListener("click", async () => {
    clearErr();
    const d = loadDescriptor();
    if (!d) { showErr("VAULT REFUSED: no vault loaded"); return; }
    const bb = $("fund-bb").value.trim() || defaultBlockbook(state.network);
    if (!bb) { showErr("VAULT REFUSED: set a Blockbook URL in step 2 first"); return; }
    try {
      const r = await V.fetchFeeRateGrainsPerVByte(bb, 2);
      $("plan-feerate").value = String(Math.max(1, Math.ceil(r)));
      toast(`Fee estimate: ${r} grains/vB ✓`);
    } catch (e) { showErr(e.message); }
  });

  $("plan-build").addEventListener("click", () => {
    clearErr();
    try {
      const d = loadDescriptor();
      if (!d) throw new Error("VAULT REFUSED: no vault loaded");
      const selected = [];
      planUtxoRows.forEach((r) => { if (r.check.checked) selected.push(r.utxo); });
      const recipients = [];
      recipRows.forEach((row) => {
        const a = row.addr.value.trim();
        const p = row.amt.value.trim();
        if (!a && !p) return;
        recipients.push({ address: a, grains: V.prlToGrains(p) });
      });
      const bb = $("fund-bb").value.trim() || defaultBlockbook(state.network);
      const plan = V.planSpend({
        network: state.network, descriptor: d,
        selectedUtxos: selected, recipients,
        feeRateGrainsPerVByte: Number($("plan-feerate").value),
        blockbookBase: bb,
      });
      const bundle = V.buildUnsignedBundle(plan, d);
      state.bundle = bundle;
      $("plan-in-n").textContent = `${bundle.inputs.length} (total ${fmtPRL(plan.inTotal)} PRL)`;
      $("plan-out-n").textContent = `${bundle.outputs.length}${plan.changeGrains > 0n ? " (incl. change to vault)" : ""}`;
      $("plan-vbytes").textContent = `${bundle.vBytes} vB`;
      $("plan-fee").textContent = `${fmtPRL(plan.feeGrains)} PRL @ ${bundle.feeRate} grains/vB`;
      $("plan-change").textContent = plan.changeGrains > 0n
        ? `${fmtPRL(plan.changeGrains)} PRL back to vault`
        : (plan.dustAbsorbedGrains > 0n
          ? `dust ${fmtPRL(plan.dustAbsorbedGrains)} PRL absorbed into the fee (disclosed)`
          : "none");
      $("plan-fp").textContent = bundle.fingerprint;
      $("plan-bundle").value = JSON.stringify(bundle, null, 2);
      $("plan-result").hidden = false;
      toast("Bundle built ✓");
    } catch (e) { showErr(e.message); }
  });
  $("plan-copy").addEventListener("click", () => copyText($("plan-bundle").value, "Bundle"));
  $("plan-download").addEventListener("click", () => {
    if (!state.bundle) return;
    download(`pearl-vault-unsigned-${state.bundle.fingerprint}.json`, JSON.stringify(state.bundle, null, 2));
  });
  $("plan-to-sign").addEventListener("click", () => {
    if (state.bundle) $("s-bundle").value = $("plan-bundle").value;
    gotoTab("sign");
  });

  /* ---------- 4 · SIGN ---------- */
  let parsedBundle = null;
  $("s-import").addEventListener("click", () => {
    clearErr();
    try {
      const d = loadDescriptor();
      if (!d) throw new Error("VAULT REFUSED: no vault loaded — the bundle must match this vault's descriptor");
      parsedBundle = V.parseUnsignedBundle($("s-bundle").value, d);
      const box = $("s-check");
      box.hidden = false;
      box.classList.remove("bad");
      const outs = parsedBundle.outputs.map((o, i) =>
        `  out ${i}: ${V.grainsToPRL(BigInt(o.value))} PRL → ${o.address.slice(0, 18)}…`).join("\n");
      box.innerHTML = `<span class="ok">✓ BUNDLE CHECKS OUT</span>\n` +
        `fingerprint <code>${esc(parsedBundle.fingerprint)}</code> · vault ${esc(d.m)}-of-${esc(d.n)}\n` +
        `inputs: ${parsedBundle.inputs.length} · fee ${V.grainsToPRL(BigInt(parsedBundle.feeGrains))} PRL (${parsedBundle.vBytes} vB @ ${esc(String(parsedBundle.feeRate))} gr/vB)\n${esc(outs)}`;
      const sel = $("s-keyindex");
      sel.innerHTML = "";
      for (let i = 0; i < d.n; i++) {
        const o = document.createElement("option");
        o.value = String(i);
        o.textContent = `Cosigner ${i} (${d.keys[i].slice(0, 10)}…)`;
        sel.appendChild(o);
      }
      $("s-signbox").hidden = false;
      $("c-nobundle").hidden = true;
      $("c-box").hidden = false;
    } catch (e) { showErr(e.message); }
  });

  $("s-sign").addEventListener("click", () => {
    clearErr();
    try {
      if (!parsedBundle) throw new Error("VAULT REFUSED: import a bundle first");
      const d = loadDescriptor();
      const ki = Number($("s-keyindex").value);
      const keyRaw = $("s-key").value.trim();
      if (!keyRaw) throw new Error("VAULT REFUSED: enter your signing key");
      const net = state.network;
      let k;
      if (/^[0-9a-fA-F]{64}$/.test(keyRaw)) {
        // Could be x-only pubkey (useless for signing) or priv hex — try priv.
        k = V.cosignerPrivFromHex(keyRaw, net);
      } else {
        k = V.cosignerKeyFromInput(keyRaw, net);
        if (!k.priv) throw new Error("VAULT REFUSED: that key has no private part — enter a private key, WIF or mnemonic");
      }
      if (V.bytesToHex(k.xonly).toLowerCase() !== d.keys[ki].toLowerCase()) {
        const asPub = d.keys.findIndex((x) => x.toLowerCase() === keyRaw.toLowerCase());
        if (asPub >= 0) {
          throw new Error(`VAULT REFUSED: you entered cosigner ${asPub}'s PUBLIC key — signing needs the private key, WIF or mnemonic`);
        }
        const actual = d.keys.findIndex((x) => x.toLowerCase() === V.bytesToHex(k.xonly).toLowerCase());
        throw new Error(`VAULT REFUSED: this key belongs to cosigner ${actual}, not cosigner ${ki} — refusing to sign as the wrong party`);
      }
      const partial = V.signBundle(parsedBundle, d, ki, k.priv);
      $("s-partial").value = JSON.stringify(partial, null, 2);
      toast("Partial signature exported ✓");
    } catch (e) { showErr(e.message); }
  });
  $("s-wipe").addEventListener("click", () => {
    $("s-key").value = "";
    toast("Key wiped from the page ✓");
  });
  $("s-copy-partial").addEventListener("click", () => copyText($("s-partial").value, "Partial"));

  $("c-add").addEventListener("click", () => {
    clearErr();
    try {
      if (!parsedBundle) throw new Error("VAULT REFUSED: import the bundle on the left first");
      const d = loadDescriptor();
      if (!d) throw new Error("VAULT REFUSED: no vault descriptor — forge or verify one first");
      const raw = $("c-partials").value.trim();
      if (!raw) throw new Error("VAULT REFUSED: paste a partial signature first");
      const ps = JSON.parse(raw);
      // Verify THIS partial's signatures now — no quorum needed yet. A bad
      // signature is rejected at the door, before it can pollute the stack.
      const ki = V.verifyPartialSigs(ps, parsedBundle, d);
      if (state.partials.some((p) => p.keyIndex === ki)) {
        throw new Error(`VAULT REFUSED: cosigner ${ki} already submitted a partial`);
      }
      state.partials.push(ps);
      $("c-partials").value = "";
      renderPartialList();
      toast(`Partial from cosigner ${ki} verified ✓ (${state.partials.length} of ${d.m} needed)`);
    } catch (e) { showErr(e.message); }
  });
  function renderPartialList() {
    const box = $("c-list");
    box.innerHTML = state.partials.length
      ? state.partials.map((p, i) => `<div>✓ partial ${i + 1}: cosigner ${p.keyIndex} — ${p.sigs.length} input sig(s), all verified</div>`).join("")
      : "<span class='hint'>No partials yet.</span>";
  }

  let bcastArmed = false;
  let finalized = null;
  $("c-finalize").addEventListener("click", () => {
    clearErr();
    try {
      if (!parsedBundle) throw new Error("VAULT REFUSED: import the bundle on the left first");
      if (state.partials.length === 0) throw new Error("VAULT REFUSED: add at least one partial signature");
      const d = loadDescriptor();
      finalized = V.finalizeSpend(parsedBundle, d, state.partials);
      $("c-txid").textContent = finalized.txid;
      $("c-fee").textContent = `${V.grainsToPRL(BigInt(finalized.feeGrains))} PRL (${finalized.vBytes} vB)`;
      $("c-hex").value = finalized.hex;
      $("c-result").hidden = false;
      $("c-bcast").hidden = true;
      bcastArmed = false;
      $("c-broadcast").textContent = "Broadcast via Blockbook";
      toast("Spend finalized ✓");
    } catch (e) { showErr(e.message); }
  });
  $("c-copy-txid").addEventListener("click", () => copyText($("c-txid").textContent, "txid"));
  $("c-copy-hex").addEventListener("click", () => copyText($("c-hex").value, "Hex"));

  $("c-broadcast").addEventListener("click", async () => {
    clearErr();
    if (!finalized) { showErr("VAULT REFUSED: finalize a spend first"); return; }
    if (!bcastArmed) {
      bcastArmed = true;
      $("c-broadcast").textContent = "⚠ Click again to confirm broadcast";
      return;
    }
    bcastArmed = false;
    $("c-broadcast").textContent = "Broadcast via Blockbook";
    const bb = $("fund-bb").value.trim() || defaultBlockbook(state.network);
    if (!bb) { showErr("VAULT REFUSED: no Blockbook URL — set one in step 2"); return; }
    $("c-broadcast").disabled = true;
    try {
      const txid = await V.broadcastTx(bb, finalized.hex);
      const box = $("c-bcast");
      box.hidden = false;
      box.classList.remove("bad");
      box.innerHTML = `<span class="ok">✓ BROADCAST ACCEPTED</span>\ntxid <code>${esc(txid)}</code>`;
      $("t-txid").value = txid;
      toast("Broadcast accepted ✓");
    } catch (e) { showErr(e.message); }
    finally { $("c-broadcast").disabled = false; }
  });

  /* ---------- 5 · TRACK ---------- */
  async function checkTrack() {
    clearErr();
    const bb = $("t-bb").value.trim() || defaultBlockbook(state.network);
    if (!bb) { showErr("VAULT REFUSED: set a Blockbook URL"); return; }
    try {
      const r = await V.fetchTxConfirmations(bb, $("t-txid").value.trim());
      const box = $("t-result");
      box.hidden = false;
      box.classList.remove("bad");
      box.innerHTML = `txid <code>${esc(r.txid)}</code>\n` +
        (r.confirmations > 0
          ? `<span class="ok">✓ ${r.confirmations} confirmation${r.confirmations === 1 ? "" : "s"}</span>${r.blockHeight != null ? ` at height ${r.blockHeight}` : ""}`
          : `<span class="ok">◌ seen in mempool — 0 confirmations so far</span>`);
    } catch (e) { showErr(e.message); }
  }
  $("t-check").addEventListener("click", checkTrack);
  $("t-auto").addEventListener("click", () => {
    if (state.trackTimer) {
      clearInterval(state.trackTimer);
      state.trackTimer = null;
      $("t-auto").textContent = "Auto-refresh 30s";
    } else {
      checkTrack();
      state.trackTimer = setInterval(checkTrack, 30000);
      $("t-auto").textContent = "Stop auto-refresh";
    }
  });

  /* ---------- VERIFY ---------- */
  $("v-run").addEventListener("click", () => {
    clearErr();
    const box = $("v-result");
    box.hidden = false;
    try {
      const d = JSON.parse($("v-json").value);
      const v = V.verifyDescriptor(d);
      if (v.ok) {
        box.classList.remove("bad");
        box.innerHTML = `<span class="ok">✓ PROVEN</span> — the vault address re-derives exactly.\n` +
          `address <code>${esc(v.address)}</code>\nquorum ${v.m}-of-${v.n} · network ${esc(v.network)}`;
      } else {
        box.classList.add("bad");
        box.innerHTML = `<span class="no">✗ NOT PROVEN</span> — ${esc(v.reason)}`;
      }
    } catch (e) {
      box.classList.add("bad");
      box.innerHTML = `<span class="no">✗ NOT PROVEN</span> — ${esc(e.message)}`;
    }
  });

  /* ---------- footer ---------- */
  $("donate-copy").addEventListener("click", () => copyText($("donate-addr").textContent, "Address"));

  /* ---------- boot ---------- */
  loadDescriptor();
  syncVaultViews();

  /* Test hook (used by tests/vault.dom.test.mjs; harmless in production). */
  window.__vaultTest = {
    state: () => ({
      descriptor: state.descriptor,
      network: state.network && state.network.id,
      bundle: state.bundle,
      partials: state.partials,
      finalized: finalized && { txid: finalized.txid },
      fundUtxos,
    }),
    keyRows: () => keyRows,
    recipRows: () => recipRows,
    planUtxoRows: () => planUtxoRows,
    forge: (networkId, m, keyInputs, privFlags) => {
      $("f-network").value = networkId;
      $("f-n").value = String(keyInputs.length);
      renderKeyRows();
      keyRows.forEach((r, i) => {
        r.input.value = keyInputs[i] || "";
        r.priv.checked = !!(privFlags && privFlags[i]);
      });
      $("f-m").value = String(m);
      $("f-forge").click();
    },
    addUtxo: (u) => { fundUtxos.push(u); renderPlanUtxos(); },
    addRecip: (addr, prl) => addRecipRow(addr, prl),
    err: () => ({ hidden: $("err").hidden, text: $("err").textContent }),
  };
})();
