/* Pearl Will app — Taproot inheritance vault desk UI.
 * Drives window.PearlWill (committed esbuild bundle of will-core + the audited
 * Sign/Escrow primitives). Fully offline except optional GET-only Blockbook
 * lookups and the double-confirmed broadcast. Private keys and mnemonics live
 * in page memory only; drafts are saved to hostile-localStorage-safe storage.
 */
(function () {
  "use strict";
  const W = window.PearlWill;
  if (!W) throw new Error("Pearl Will bundle failed to load");

  const DONATION = "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d";

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function showErr(id, msg) { const e = $(id); e.textContent = msg; e.hidden = false; }
  function hideErr(id) { $(id).hidden = true; }
  function trunc(h, n) { n = n || 14; return h.length > 2 * n ? h.slice(0, n) + "…" + h.slice(-n) : h; }
  function fmtPRL(g) { return (Number(g) / 100000000).toFixed(8) + " PRL"; }

  /* hostile-localStorage-safe storage */
  const store = {
    get(k) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* hostile storage: ignore */ } },
  };
  const LS_DRAFT = "pearl-will:draft:v1";
  const LS_BB = "pearl-will:blockbook:v1";

  /* ---------- step nav ---------- */
  const panels = { draft: "step-draft", fund: "step-fund", watch: "step-watch", claim: "step-claim", verify: "step-verify" };
  const state = { vault: null, spec: null, ownerPriv: null, claim: null, chainTip: null };
  function goStep(name) {
    document.querySelectorAll("#steps button").forEach((b) => {
      b.classList.toggle("active", b.dataset.step === name);
    });
    Object.keys(panels).forEach((k) => { $(panels[k]).classList.toggle("active", k === name); });
    if (name === "fund") renderFund();
    if (name === "watch") renderWatchSaved();
    window.scrollTo(0, 0);
  }
  document.querySelectorAll("#steps button").forEach((b) => {
    b.addEventListener("click", () => goStep(b.dataset.step));
  });

  /* ---------- QR + copy ---------- */
  function renderQR(el, text) {
    el.innerHTML = "";
    try {
      if (typeof window.qrcode === "undefined") throw new Error("qr lib missing");
      const qr = window.qrcode(0, "M");
      qr.addData(text);
      qr.make();
      el.innerHTML = qr.createImgTag(4, 8);
    } catch (e) {
      el.textContent = "QR unavailable: " + e.message;
    }
  }
  document.querySelectorAll("button.copy").forEach((b) => {
    b.addEventListener("click", () => {
      const el = $(b.dataset.copy);
      const t = el.tagName === "TEXTAREA" || el.tagName === "INPUT" ? el.value : el.textContent;
      navigator.clipboard.writeText(t).catch(() => {});
      b.textContent = "copied";
      setTimeout(() => { b.textContent = "copy"; }, 1200);
    });
  });

  /* ---------- DRAFT ---------- */
  let heirCount = 0;
  function addHeirRow(name, key) {
    if (heirCount >= W.MAX_HEIRS) return;
    heirCount++;
    const div = document.createElement("div");
    div.className = "heir-row";
    div.dataset.idx = heirCount;
    div.innerHTML =
      '<label>Heir ' + heirCount + ' name<input type="text" class="heir-name" autocomplete="off" spellcheck="false" placeholder="e.g. Mara" value="' + esc(name || "") + '"></label>' +
      '<label>X-only pubkey (64-hex)<input type="text" class="heir-key" autocomplete="off" spellcheck="false" placeholder="64-hex x-only pubkey" value="' + esc(key || "") + '"></label>' +
      '<button class="heir-del secondary">remove</button>';
    div.querySelector(".heir-del").addEventListener("click", () => { div.remove(); refreshM(); });
    $("d-heirs").appendChild(div);
    refreshM();
  }
  function heirRows() {
    return Array.from(document.querySelectorAll("#d-heirs .heir-row")).map((r) => ({
      name: r.querySelector(".heir-name").value.trim(),
      key: r.querySelector(".heir-key").value.trim(),
    }));
  }
  function refreshM() {
    const n = document.querySelectorAll("#d-heirs .heir-row").length;
    const sel = $("d-m");
    const prev = sel.value;
    sel.innerHTML = "";
    for (let m = 1; m <= n; m++) {
      const o = document.createElement("option");
      o.value = m; o.textContent = m + " of " + n;
      sel.appendChild(o);
    }
    if (prev && Number(prev) <= n) sel.value = prev;
    else sel.value = Math.min(2, n) || 1;
  }
  addHeirRow("Heir 1", "");
  addHeirRow("Heir 2", "");
  $("d-heir-add").addEventListener("click", () => addHeirRow("", ""));

  $("d-unlock-mode").addEventListener("change", () => {
    const days = $("d-unlock-mode").value === "days";
    $("d-unlock-height-wrap").hidden = days;
    $("d-unlock-days-wrap").hidden = !days;
    $("d-unlock-tip-wrap").hidden = !days;
    $("d-unlock-note").textContent = days
      ? "Days are converted to blocks at Pearl's ≈194 s target from YOUR chain tip (labeled approximate). The script locks to the computed block height."
      : "Enter the absolute block height at/after which heirs may claim. Heirs are refused loudly before it.";
  });

  $("d-owner-new").addEventListener("click", () => {
    const mn = W.newMnemonic();
    const w = W.walletFromMnemonic(mn, W.NETWORKS[$("d-network").value]);
    $("d-owner").value = W.bytesToHex(w.internalXOnly);
    state.ownerPriv = w.priv;
    $("d-owner-mnemonic").textContent = mn;
    $("d-owner-mnemonic-box").hidden = false;
  });
  $("d-owner-from-mnemonic").addEventListener("click", () => {
    const mn = prompt("Owner mnemonic (12/24 words) — stays in this page's memory only:");
    if (!mn) return;
    try {
      const w = W.walletFromMnemonic(mn.trim(), W.NETWORKS[$("d-network").value]);
      $("d-owner").value = W.bytesToHex(w.internalXOnly);
      state.ownerPriv = w.priv;
      $("d-owner-mnemonic").textContent = "(entered via prompt — not displayed)";
      $("d-owner-mnemonic-box").hidden = false;
    } catch (e) { showErr("d-err", "Bad mnemonic: " + e.message); }
  });
  $("d-owner-clear-mnemonic").addEventListener("click", () => {
    $("d-owner-mnemonic").textContent = "";
    $("d-owner-mnemonic-box").hidden = true;
    if (state.ownerPriv) { state.ownerPriv.fill(0); state.ownerPriv = null; }
  });
  $("d-network").addEventListener("change", () => {
    $("d-owner").value = ""; $("d-owner-mnemonic-box").hidden = true;
    state.ownerPriv = null;
  });

  function resolveUnlockHeight() {
    if ($("d-unlock-mode").value === "days") {
      const days = Number($("d-unlock-days").value);
      const tip = Number($("d-unlock-tip").value);
      if (!Number.isFinite(days) || days <= 0 || days > 36500) throw new Error("WILL REFUSED: days must be in 1..36500");
      if (!Number.isSafeInteger(tip) || tip < 0) throw new Error("WILL REFUSED: enter the current chain tip height for days → blocks");
      return tip + Math.floor(days * 86400 / W.BLOCK_SECONDS);
    }
    const h = Number($("d-unlock-height").value);
    if (!Number.isSafeInteger(h) || h < 1) throw new Error("WILL REFUSED: enter an unlock block height");
    return h;
  }

  $("d-seal").addEventListener("click", () => {
    hideErr("d-err");
    $("d-result").hidden = true;
    try {
      const network = $("d-network").value;
      const owner = W.partyKeyFromInput($("d-owner").value, W.NETWORKS[network]).xonly;
      const rows = heirRows().filter((r) => r.key);
      if (rows.length < 1) throw new Error("WILL REFUSED: add at least one heir key");
      if (rows.length > W.MAX_HEIRS) throw new Error("WILL REFUSED: at most " + W.MAX_HEIRS + " heirs");
      const m = Number($("d-m").value);
      const unlockHeight = resolveUnlockHeight();
      const vault = W.buildWillVault({
        network, owner,
        heirs: rows.map((r) => r.key),
        m, unlockHeight,
        label: $("d-label").value,
      });
      state.vault = vault;
      state.spec = {
        network, m, n: rows.length, unlockHeight,
        owner: W.bytesToHex(owner),
        heirs: rows.map((r) => r.key.toLowerCase()),
        heirNames: rows.map((r) => r.name || ("Heir " + (rows.indexOf(r) + 1))),
        label: $("d-label").value.trim(),
        descriptor: vault.descriptor,
      };
      $("d-addr").textContent = vault.address;
      $("d-sealed").textContent = vault.sealed;
      $("d-desc").textContent = vault.descriptor;
      $("d-unlock-out").textContent = unlockHeight + ($("d-unlock-mode").value === "days" ? " (≈" + $("d-unlock-days").value + " days at ≈194 s/block)" : "");
      $("d-owner-asm").textContent = W.scriptAsm(vault.ownerScript);
      $("d-heir-asm").textContent = W.scriptAsm(vault.heirScript);
      $("d-nums").textContent = W.bytesToHex(vault.internalXOnly);
      $("d-cb").textContent = vault.controlBlocks.map((c) => trunc(W.bytesToHex(c), 20)).join("  |  ");
      $("d-result").hidden = false;
    } catch (e) { showErr("d-err", e.message); }
  });
  $("d-save").addEventListener("click", () => {
    if (!state.spec) return;
    store.set(LS_DRAFT, state.spec);
    $("d-save").textContent = "Saved ✓";
    setTimeout(() => { $("d-save").textContent = "Save draft locally"; }, 1500);
  });
  $("d-goto-fund").addEventListener("click", () => goStep("fund"));

  /* ---------- FUND ---------- */
  function currentVault() {
    if (state.vault) return state.vault;
    const saved = store.get(LS_DRAFT);
    if (saved && saved.descriptor) {
      const { vault } = W.willFromDescriptor(saved.descriptor);
      state.vault = vault; state.spec = saved;
      return vault;
    }
    return null;
  }
  function renderFund() {
    const v = currentVault();
    if (!v) {
      $("f-addr").textContent = "(seal a draft first)";
      return;
    }
    $("f-addr").textContent = v.address;
    renderQR($("f-qr"), v.address);
    const bb = store.get(LS_BB);
    if (bb) $("f-blockbook").value = bb;
  }
  $("f-refresh").addEventListener("click", async () => {
    hideErr("f-err");
    try {
      const bb = $("f-blockbook").value.trim();
      if (!bb) throw new Error("Enter a Blockbook URL (or use the offline tally below).");
      store.set(LS_BB, bb);
      const v = currentVault();
      if (!v) throw new Error("Seal a draft first.");
      const utxos = await W.fetchUtxos(bb, v.address);
      const total = utxos.reduce((a, u) => a + u.value, 0);
      $("f-balance").textContent = utxos.length + " UTXO(s) · " + fmtPRL(total);
    } catch (e) { showErr("f-err", e.message); }
  });
  $("f-tally").addEventListener("click", () => {
    try {
      const lines = $("f-utxos").value.split("\n").map((l) => l.trim()).filter(Boolean);
      let total = 0, n = 0;
      for (const l of lines) {
        const parts = l.split(/\s+/);
        if (parts.length < 3) throw new Error("bad line (want txid:vout amount address): " + l.slice(0, 40));
        /* Exact parser (core): the old Number()+Math.round float parse
         * silently rounded sub-grain amounts and accepted "0x10"/"1e3". */
        const amt = W.parsePRLToGrains(parts[1]);
        if (amt <= 0) throw new Error("bad amount: " + parts[1]);
        total += amt; n++;
      }
      $("f-tally-out").textContent = n + " UTXO(s) tallied · " + fmtPRL(total) + " (offline — nothing left your machine)";
    } catch (e) { $("f-tally-out").textContent = "Tally refused: " + e.message; }
  });
  $("f-plan").addEventListener("click", () => {
    try {
      const v = currentVault();
      if (!v) throw new Error("Seal a draft first.");
      const rate = Number($("f-feerate").value);
      const nOut = Number($("f-nout").value);
      if (!(rate > 0) || !(nOut >= 1)) throw new Error("Enter a fee rate and output count.");
      const n = state.spec ? state.spec.n : 1;
      const m = state.spec ? state.spec.m : 1;
      const ownerVB = W.spendVBytes({ nOut, scriptLen: v.ownerScript.length, controlLen: v.controlBlocks[0].length, stackLens: [64] });
      const heirVB = W.spendVBytes({ nOut, scriptLen: v.heirScript.length, controlLen: v.controlBlocks[1].length, stackLens: Array(n).fill(64) });
      $("f-plan-owner").textContent = ownerVB + " vB ≈ " + fmtPRL(Math.ceil(ownerVB * rate)) + " fee";
      $("f-plan-heir").textContent = heirVB + " vB ≈ " + fmtPRL(Math.ceil(heirVB * rate)) + " fee (" + m + "-of-" + n + " witness)";
      $("f-plan-out").hidden = false;
    } catch (e) { showErr("f-err", e.message); }
  });

  /* ---------- WATCH ---------- */
  function renderWatchSaved() {
    if (!state.vault) currentVault();
  }
  function countdownText(unlock, tip) {
    if (tip >= unlock) return "UNLOCKED — heirs may claim (block " + unlock + " reached at tip " + tip + ")";
    const left = unlock - tip;
    const days = Math.floor(left * W.BLOCK_SECONDS / 86400);
    return left.toLocaleString() + " blocks to go ≈ " + days + " day(s) (at ≈194 s/block — approximate)";
  }
  async function refreshWatch(tipOverride) {
    hideErr("w-err");
    $("w-out").hidden = true;
    try {
      const v = currentVault();
      if (!v) throw new Error("Seal a draft first.");
      const bb = $("f-blockbook").value.trim() || (store.get(LS_BB) || "");
      let tip = tipOverride;
      if (tip === undefined || tip === null) {
        if (!bb) throw new Error("Enter a Blockbook URL on the Fund tab, or use the manual countdown below.");
        tip = await W.fetchChainTip(bb);
      }
      state.chainTip = tip;
      let st = null;
      if (bb) { try { st = await W.fetchVaultStatus(bb, v.address); } catch { st = null; } }
      const spec = state.spec || {};
      const unlock = spec.unlockHeight;
      $("w-tip").textContent = tip.toLocaleString();
      $("w-unlock").textContent = unlock !== undefined ? unlock.toLocaleString() : "(unknown — seal a draft)";
      $("w-countdown").textContent = unlock !== undefined ? countdownText(unlock, tip) : "—";
      if (st) {
        const spent = st.txCount > 0 && st.balance === 0 && st.unconfirmed === 0;
        $("w-status").textContent = spent ? "SPENT (vault emptied)" : st.balance > 0 ? "FUNDED" : "UNFUNDED";
        $("w-balance").textContent = fmtPRL(st.balance) + (st.unconfirmed ? " (+" + fmtPRL(st.unconfirmed) + " unconfirmed)" : "");
        $("w-txs").textContent = st.txs.length ? st.txs.map((t) => trunc(t.txid, 10) + " (" + t.confirmations + " conf)").join(", ") : "none";
      } else {
        $("w-status").textContent = bb ? "unreachable — balance unknown" : "offline mode";
        $("w-balance").textContent = "—";
        $("w-txs").textContent = "—";
      }
      $("w-out").hidden = false;
    } catch (e) { showErr("w-err", e.message); }
  }
  $("w-refresh").addEventListener("click", () => refreshWatch());
  $("w-count").addEventListener("click", () => {
    try {
      const tip = Number($("w-tip-manual").value);
      const unlock = state.spec && state.spec.unlockHeight;
      if (!Number.isSafeInteger(tip) || tip < 0) throw new Error("Enter a chain tip height.");
      if (unlock === undefined) throw new Error("Seal a draft first (unlock unknown).");
      state.chainTip = tip;
      $("w-count-out").textContent = countdownText(unlock, tip);
    } catch (e) { $("w-count-out").textContent = "Refused: " + e.message; }
  });

  /* ---------- CLAIM ---------- */
  function parsePriv(input, network) {
    const t = String(input || "").trim();
    if (!t) throw new Error("WILL REFUSED: enter the private key");
    if (/^[0-9a-fA-F]{64}$/.test(t)) return { priv: W.hexToBytes(t.toLowerCase()), xonly: W.bytesToHex(W.schnorr.getPublicKey(W.hexToBytes(t.toLowerCase()))) };
    const words = t.split(/\s+/);
    if (words.length === 12 || words.length === 24) {
      const w = W.walletFromMnemonic(t, network);
      return { priv: w.priv, xonly: W.bytesToHex(w.internalXOnly) };
    }
    const w = W.walletFromWIF(t, network);
    return { priv: w.priv, xonly: W.bytesToHex(w.internalXOnly) };
  }
  function parseUtxo(s) {
    const parts = String(s || "").trim().split(":");
    if (parts.length !== 3 || !/^[0-9a-fA-F]{64}$/.test(parts[0]) || !/^\d+$/.test(parts[1]) || !/^\d+$/.test(parts[2])) {
      throw new Error("WILL REFUSED: UTXO must be txid:vout:value-grains (e.g. a3f1…:0:150000000)");
    }
    return { txid: parts[0].toLowerCase(), vout: Number(parts[1]), value: Number(parts[2]) };
  }

  $("c-load").addEventListener("click", () => {
    hideErr("c-err");
    $("c-vault").hidden = true;
    try {
      const { vault, m, n, unlockHeight } = W.willFromDescriptor($("c-desc").value);
      state.vault = vault;
      state.spec = Object.assign(state.spec || {}, { m, n, unlockHeight, descriptor: $("c-desc").value.trim() });
      state.claim = null;
      $("c-addr").textContent = vault.address;
      $("c-threshold").textContent = m + "-of-" + n;
      $("c-unlock").textContent = unlockHeight.toLocaleString();
      $("c-sealed").textContent = vault.sealed;
      $("c-vault").hidden = false;
    } catch (e) { showErr("c-err", e.message); }
  });

  async function doubleConfirmBroadcast(bbInputId, hexId, errId) {
    hideErr(errId);
    try {
      const bb = ($(bbInputId) ? $(bbInputId).value.trim() : "") || (store.get(LS_BB) || "");
      if (!bb) throw new Error("WILL REFUSED: enter a Blockbook URL on the Fund tab first.");
      const hex = $(hexId).value.trim();
      if (!hex) throw new Error("WILL REFUSED: no signed hex to broadcast.");
      if (!confirm("Broadcast this transaction to the Pearl network via Blockbook? This moves real PRL.")) return;
      if (!confirm("Final confirmation: broadcast NOW?")) return;
      const txid = await W.broadcastTx(bb, hex);
      alert("Broadcast accepted. Txid: " + txid);
    } catch (e) { showErr(errId, e.message); }
  }

  /* owner reclaim */
  $("co-build").addEventListener("click", () => {
    hideErr("co-err");
    $("co-out").hidden = true;
    try {
      const v = state.vault;
      if (!v) throw new Error("WILL REFUSED: load a vault descriptor first.");
      const net = v.net;
      const { priv, xonly } = parsePriv($("co-priv").value, net);
      // The pasted key must be the owner key of THIS vault.
      const ownerX = W.bytesToHex(v.ownerScript.slice(1, 33));
      if (xonly !== ownerX) throw new Error("WILL REFUSED: this key is not the owner key of the loaded vault — refusing to sign");
      const input = parseUtxo($("co-utxo").value);
      const payments = [{ address: $("co-dest").value.trim(), value: null }];
      const feeRate = Number($("co-feerate").value);
      const changeAddress = $("co-change").value.trim();
      if (!changeAddress) throw new Error("WILL REFUSED: enter a change address");
      W.addressToProgram(payments[0].address, net); // validates
      W.addressToProgram(changeAddress, net);
      // Payment value: everything minus fee (single-recipient reclaim). Use planSpend via buildOwnerClaim with full-value payment:
      const feeEst = Math.ceil(W.spendVBytes({ nOut: 2, scriptLen: v.ownerScript.length, controlLen: v.controlBlocks[0].length, stackLens: [64] }) * feeRate);
      const value = input.value - feeEst;
      if (value < W.DUST_GRAIN) throw new Error("WILL REFUSED: UTXO value " + input.value + " grains cannot cover the ~" + feeEst + "-grain fee");
      payments[0].value = value;
      const built = W.buildOwnerClaim(v, {
        input,
        payments: payments.map((p) => ({ address: p.address, value: p.value })),
        changeAddress, feeRateGrainsPerVByte: feeRate, privOwner: priv, signerXOnly: ownerX,
      });
      // Independent re-verification: decode the built hex, recompute the
      // sighash from its decoded outputs, re-check the control block against
      // the vault, and re-verify the witness signature against the owner key.
      const rv = W.reverifyClaimTx(v, built, {
        leaf: "owner", input, sequence: 0xffffffff, locktime: 0, keys: [ownerX],
      });
      if (!rv.ok) throw new Error("WILL REFUSED: built transaction failed local re-verification");
      $("co-txid").textContent = built.txid;
      $("co-fee").textContent = fmtPRL(built.fee) + " (" + built.vBytes + " vB)";
      $("co-hex").value = built.hex;
      $("co-out").hidden = false;
      priv.fill(0);
    } catch (e) { showErr("co-err", e.message); }
  });
  $("co-broadcast").addEventListener("click", () => doubleConfirmBroadcast("f-blockbook", "co-hex", "co-broadcast-err"));

  /* heir claim */
  $("ch-digest").addEventListener("click", () => {
    hideErr("ch-err");
    $("ch-sigs").hidden = true;
    $("ch-out").hidden = true;
    try {
      const v = state.vault, spec = state.spec;
      if (!v || !spec) throw new Error("WILL REFUSED: load a vault descriptor first.");
      const tip = Number($("ch-tip").value);
      W.assertClaimable(spec.unlockHeight, tip, "heir"); // the loud gate, checked FIRST
      const net = v.net;
      const input = parseUtxo($("ch-utxo").value);
      const dest = $("ch-dest").value.trim();
      const changeAddress = $("ch-change").value.trim();
      if (!changeAddress) throw new Error("WILL REFUSED: enter a change address");
      const feeRate = Number($("ch-feerate").value);
      W.addressToProgram(dest, net);
      W.addressToProgram(changeAddress, net);
      const feeEst = Math.ceil(W.spendVBytes({ nOut: 2, scriptLen: v.heirScript.length, controlLen: v.controlBlocks[1].length, stackLens: Array(spec.n).fill(64) }) * feeRate);
      const value = input.value - feeEst;
      if (value < W.DUST_GRAIN) throw new Error("WILL REFUSED: UTXO value cannot cover the ~" + feeEst + "-grain fee");
      const payments = [{ program: W.addressToProgram(dest, net), value }];
      const changeProgram = W.addressToProgram(changeAddress, net);
      const stackLens = Array(spec.n).fill(64);
      const plan = W.planSpend({
        inputValue: input.value, payments,
        feeRateGrainsPerVByte: feeRate, scriptLen: v.heirScript.length,
        controlLen: v.controlBlocks[1].length, stackLens,
      });
      const outputs = plan.outputs.map((o) => ({ program: o.program || changeProgram, value: o.value }));
      const digest = W.scriptPathSigDigestEx(net,
        { txid: input.txid, vout: input.vout, value: input.value, spk: v.spk },
        outputs, v.heirScript, { sequence: 0xfffffffe, locktime: spec.unlockHeight });
      state.claim = {
        input, outputs, digest: W.bytesToHex(digest), feeRate, changeAddress,
        dest, value, planFee: plan.fee, specN: spec.n,
      };
      $("ch-digest-out").textContent = state.claim.digest;
      // heir signature slots (sorted key order)
      const list = $("ch-sig-list");
      list.innerHTML = "";
      const sorted = state.spec.heirKeysSorted || specHeirKeysSorted();
      sorted.forEach((hk, i) => {
        const row = document.createElement("div");
        row.className = "form-grid";
        row.innerHTML = '<label class="wide">Heir slot ' + (i + 1) + ' — ' + esc(trunc(hk, 12)) + '… signature (64-hex)<input type="text" class="ch-sig" data-key="' + hk + '" autocomplete="off" spellcheck="false" placeholder="64-hex Schnorr signature (leave empty = non-signer)"></label>';
        list.appendChild(row);
      });
      $("ch-sigs").hidden = false;
    } catch (e) { showErr("ch-err", e.message); }
  });
  function specHeirKeysSorted() {
    // Heir keys from the loaded descriptor, sorted (descriptor stores them sorted already).
    const parts = state.spec.descriptor.split(":");
    const n = state.spec.n;
    return parts.slice(5, 5 + n).map((h) => h.toLowerCase()).sort();
  }
  $("ch-sign-local").addEventListener("click", () => {
    hideErr("ch-err");
    try {
      if (!state.claim) throw new Error("WILL REFUSED: compute the claim digest first.");
      const v = state.vault;
      const { priv, xonly } = parsePriv($("ch-priv").value, v.net);
      const slot = document.querySelector('.ch-sig[data-key="' + xonly + '"]');
      if (!slot) throw new Error("WILL REFUSED: this key is not an heir of the loaded vault — refusing to sign");
      const sig = W.signForXOnly(priv, W.hexToBytes(state.claim.digest));
      if (!W.verifySchnorrSig(sig, W.hexToBytes(state.claim.digest), xonly)) {
        throw new Error("WILL REFUSED: local signature failed re-verification");
      }
      slot.value = W.bytesToHex(sig);
      priv.fill(0);
      $("ch-priv").value = "";
    } catch (e) { showErr("ch-err", e.message); }
  });
  $("ch-build").addEventListener("click", () => {
    hideErr("ch-err");
    $("ch-out").hidden = true;
    try {
      if (!state.claim) throw new Error("WILL REFUSED: compute the claim digest first.");
      const v = state.vault, spec = state.spec, c = state.claim;
      const sigs = Array.from(document.querySelectorAll(".ch-sig")).map((el) => ({
        key: el.dataset.key, sig: el.value.trim() || null,
      })).filter((s) => s.sig);
      if (sigs.length < spec.m) throw new Error("WILL REFUSED: only " + sigs.length + " signature(s) pasted, need " + spec.m + " of " + spec.n);
      const sorted = specHeirKeysSorted();
      const built = W.buildHeirClaim(v, sorted, spec.m, spec.unlockHeight, {
        input: c.input,
        payments: [{ address: c.dest, value: c.value }],
        changeAddress: c.changeAddress,
        feeRateGrainsPerVByte: c.feeRate,
        signatures: sigs,
        chainTip: Number($("ch-tip").value),
        outputsOverride: c.outputs, // the exact outputs the heirs signed
      });
      // Independent re-verification from the decoded hex.
      const rv = W.reverifyClaimTx(v, built, {
        leaf: "heir", input: c.input, sequence: 0xfffffffe, locktime: spec.unlockHeight, keys: sorted,
      });
      if (!rv.ok || rv.sigs < spec.m) throw new Error("WILL REFUSED: built heir claim failed local re-verification");
      $("ch-txid").textContent = built.txid;
      $("ch-locktime").textContent = spec.unlockHeight.toLocaleString() + " (nLockTime), sequence 0xfffffffe";
      $("ch-fee").textContent = fmtPRL(built.fee) + " (" + built.vBytes + " vB)";
      $("ch-hex").value = built.hex;
      $("ch-out").hidden = false;
    } catch (e) { showErr("ch-err", e.message); }
  });
  $("ch-broadcast").addEventListener("click", () => doubleConfirmBroadcast("f-blockbook", "ch-hex", "ch-broadcast-err"));

  /* ---------- VERIFY ---------- */
  $("v-check").addEventListener("click", () => {
    hideErr("v-err");
    $("v-result").hidden = true;
    try {
      const v = W.verifyWillDescriptor($("v-desc").value, $("v-addr").value, $("v-sealed").value || null);
      $("v-verdict").innerHTML = v.verdict === "PROVEN"
        ? '<span style="color:var(--ok)">PROVEN</span> — the descriptor re-derives the claimed vault'
        : '<span style="color:var(--bad)">NOT PROVEN</span> — do not trust this descriptor';
      const ul = $("v-checks");
      ul.innerHTML = "";
      for (const c of v.checks) {
        const li = document.createElement("li");
        li.innerHTML = '<span class="' + (c.ok ? "ok" : "no") + '">' + (c.ok ? "✓" : "✗") + "</span> " + esc(c.label) +
          '<span class="detail">' + esc(c.detail || "") + "</span>";
        ul.appendChild(li);
      }
      $("v-result").hidden = false;
    } catch (e) { showErr("v-err", e.message); }
  });
})();
