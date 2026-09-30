/* Pearl Atomic — cross-chain HTLC desk. All crypto runs locally; the page only
 * reads the chain (GET) until the user presses Broadcast. */
(() => {
  "use strict";
  const E = window.PearlAtomic;
  if (!E) {
    document.body.innerHTML = "<p style='padding:2rem'>Pearl Atomic failed to load (pearl-atomic.bundle.js missing). Check the console.</p>";
    return;
  }
  const $ = (id) => document.getElementById(id);
  const hex = (b) => E.bytesToHex(b instanceof Uint8Array ? b : E.hexToBytes(String(b)));
  const DONATE = "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d";

  /* storage that survives hostile localStorage (Gallery lesson) */
  const store = {
    m: {},
    get(k) { try { return localStorage.getItem(k); } catch { return this.m[k] ?? null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { this.m[k] = v; } },
    del(k) { try { localStorage.removeItem(k); } catch { delete this.m[k]; } },
  };

  const S = {
    network: E.NETWORKS.mainnet,
    blockbook: store.get("atomic.blockbook") || E.NETWORKS.mainnet.blockbook,
    role: "maker",
    you: null,          // {xonly, priv, source}
    cp: null,           // {xonly}
    amountGrains: 0,
    timeout: 0,
    chainHeight: 0,
    preimageHex: "",    // maker secret (sensitive)
    hashHex: "",
    counterparty: {},
    label: "",
    contract: null,     // {claimScript, refundScript, internalXOnly, tree}
    descriptor: null,   // {obj, fingerprint, string}
    utxo: null,         // {txid, vout, value}
    plan: null,         // settle plan
    finalTx: null,
    settleMode: "claim",
  };

  function err(id, msg) {
    const el = $(id);
    if (msg == null) { el.hidden = true; el.textContent = ""; }
    else { el.hidden = false; el.textContent = msg; }
  }
  function ok(id, msg) {
    const el = $(id);
    if (msg == null) { el.hidden = true; el.textContent = ""; }
    else { el.hidden = false; el.textContent = msg; }
  }
  function goto(step) {
    for (const b of document.querySelectorAll("#steps button")) {
      b.classList.toggle("active", b.dataset.step === step);
    }
    for (const s of document.querySelectorAll("main > section.panel")) {
      s.classList.toggle("active", s.id === "step-" + step);
    }
    window.scrollTo(0, 0);
  }
  for (const b of document.querySelectorAll("#steps button")) {
    b.addEventListener("click", () => goto(b.dataset.step));
  }

  function applyNetwork() {
    const v = $("network").value;
    S.network = v === "testnet" ? E.NETWORKS.testnet : E.NETWORKS.mainnet;
    if (!store.get("atomic.blockbook")) S.blockbook = S.network.blockbook;
    $("blockbook").value = S.blockbook;
  }
  $("network").addEventListener("change", applyNetwork);
  $("blockbook").addEventListener("change", () => {
    S.blockbook = $("blockbook").value.trim() || S.network.blockbook;
    store.set("atomic.blockbook", S.blockbook);
  });
  applyNetwork();

  /* ---------- role ---------- */
  function applyRole() {
    S.role = document.querySelector('input[name="role"]:checked').value;
    const maker = S.role === "maker";
    $("maker-secret-box").hidden = !maker;
    $("taker-secret-box").hidden = maker;
    $("you-label").textContent = maker
      ? "Your key — the refundee (64-hex x-only pubkey or 12/24-word mnemonic)"
      : "Your key — the claimer (64-hex x-only pubkey or 12/24-word mnemonic)";
    $("cp-label").textContent = maker
      ? "Counterparty key — the claimer (64-hex x-only pubkey)"
      : "Counterparty key — the refundee / maker (64-hex x-only pubkey)";
  }
  for (const r of document.querySelectorAll('input[name="role"]')) r.addEventListener("change", applyRole);
  applyRole();

  $("gen-you").addEventListener("click", () => {
    try {
      const m = E.newMnemonic(12);
      $("key-you").value = m;
      const k = E.partyKeyFromInput(m, S.network);
      S.you = k;
      $("ok-you").textContent = "✓ " + hex(k.xonly).slice(0, 16) + "… (fresh mnemonic — write it down)";
    } catch (e) { err("deal-error", e.message); }
  });
  $("key-you").addEventListener("change", () => {
    const v = $("key-you").value.trim();
    try {
      if (!v) { S.you = null; $("ok-you").textContent = ""; return; }
      const k = E.partyKeyFromInput(v, S.network);
      S.you = k;
      $("ok-you").textContent = "✓ " + hex(k.xonly).slice(0, 16) + "…" + (k.priv ? " (signing key present)" : " (pubkey only)");
      err("deal-error", null);
    } catch (e) { S.you = null; $("ok-you").textContent = "✗ " + e.message; }
  });

  /* ---------- secret / hash ---------- */
  $("gen-secret").addEventListener("click", () => {
    try {
      const { preimage, hash } = E.newPreimage();
      $("preimage").value = hex(preimage);
      $("hashlock").value = hex(hash);
      $("copy-secret").disabled = false;
      S.preimageHex = hex(preimage);
      S.hashHex = hex(hash);
    } catch (e) { err("deal-error", e.message); }
  });
  $("copy-secret").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("preimage").value); $("copy-secret").textContent = "Copied"; }
    catch { $("copy-secret").textContent = "Copy failed"; }
    setTimeout(() => ($("copy-secret").textContent = "Copy"), 1200);
  });
  $("hash-from-preimage").addEventListener("click", () => {
    try {
      const p = $("preimage").value.trim();
      if (!/^[0-9a-fA-F]{64}$/.test(p)) throw new Error("preimage must be 64 hex characters");
      const h = hex(E.sha256(E.hexToBytes(p.toLowerCase())));
      $("hashlock").value = h;
      S.preimageHex = p.toLowerCase();
      S.hashHex = h;
      $("copy-secret").disabled = false;
      err("deal-error", null);
    } catch (e) { err("deal-error", e.message); }
  });

  /* ---------- chain height / timeout ---------- */
  $("fetch-height").addEventListener("click", async () => {
    err("deal-error", null);
    try {
      const r = await fetch(S.blockbook.replace(/\/$/, "") + "/api/v2");
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      if (!Number.isFinite(j.blockHeight)) throw new Error("no blockHeight in response");
      S.chainHeight = j.blockHeight;
      $("chain-height").value = j.blockHeight;
    } catch (e) { err("deal-error", "Could not fetch chain height: " + e.message); }
  });
  $("chain-height").addEventListener("change", () => {
    S.chainHeight = Number($("chain-height").value) || 0;
  });
  $("timeout-suggest").addEventListener("click", () => {
    const h = Number($("chain-height").value) || S.chainHeight;
    if (!h) { err("deal-error", "Fetch the chain height first (or type it in)."); return; }
    err("deal-error", null);
    $("timeout").value = h + 1440;
  });

  /* ---------- forge ---------- */
  $("to-contract").addEventListener("click", () => {
    err("deal-error", null);
    err("deal-warnings", null);
    try {
      applyNetwork();
      applyRole();
      const maker = S.role === "maker";
      // your key
      const you = E.partyKeyFromInput($("key-you").value, S.network);
      // counterparty key (pubkey only is fine)
      const cpRaw = $("key-cp").value.trim();
      if (!/^[0-9a-fA-F]{64}$/.test(cpRaw)) throw new Error("counterparty key must be a 64-hex x-only pubkey");
      const cpXOnly = E.parseXOnlyKey(cpRaw);
      // hash lock
      let hashHex;
      if (maker) {
        const hRaw = $("hashlock").value.trim();
        if (!/^[0-9a-fA-F]{64}$/.test(hRaw)) throw new Error("set the hash lock — generate a secret or paste the 64-hex hash");
        hashHex = hRaw.toLowerCase();
        const pRaw = $("preimage").value.trim();
        S.preimageHex = /^[0-9a-fA-F]{64}$/.test(pRaw) ? pRaw.toLowerCase() : "";
        if (S.preimageHex) E.checkPreimage(S.preimageHex, hashHex); // self-check
      } else {
        const hRaw = $("hashlock-taker").value.trim();
        if (!/^[0-9a-fA-F]{64}$/.test(hRaw)) throw new Error("paste the 64-hex hash lock from the maker's descriptor");
        hashHex = hRaw.toLowerCase();
        S.preimageHex = "";
      }
      S.hashHex = hashHex;
      // amount + timeout
      S.amountGrains = E.parsePRLtoGrains($("amount").value);
      const timeout = Number($("timeout").value);
      const h = Number($("chain-height").value) || S.chainHeight;
      if (h) S.chainHeight = h;
      const { warnings } = E.validateTimeout(timeout, S.chainHeight || null);
      S.timeout = timeout;
      // roles -> claimer / refundee
      const claimerXOnly = maker ? cpXOnly : you.xonly;
      const refundeeXOnly = maker ? you.xonly : cpXOnly;
      const contract = E.forgeHtlc(S.network, { claimerXOnly, refundeeXOnly, hash: hashHex, timeout });
      S.contract = contract;
      S.you = you;
      S.cp = { xonly: cpXOnly };
      S.counterparty = {
        chain: $("cp-chain").value.trim(),
        asset: $("cp-asset").value.trim(),
        amount: $("cp-amount").value.trim(),
        htlcRef: $("cp-ref").value.trim(),
        refundTimeout: $("cp-timeout").value.trim() === "" ? null : Number($("cp-timeout").value),
      };
      S.label = $("deal-label").value.trim();
      S.descriptor = E.makeDescriptor(S.network, contract, {
        timeout, amountGrains: S.amountGrains, label: S.label, counterparty: S.counterparty,
      });
      S.utxo = null;
      S.plan = null;
      S.finalTx = null;
      const warns = [...warnings];
      const ordering = E.timeoutOrderingWarning(S.role, timeout, S.counterparty.refundTimeout);
      if (ordering) warns.push(ordering);
      if (warns.length) {
        const w = $("deal-warnings");
        w.hidden = false;
        w.innerHTML = "<strong>Warnings — read before funding:</strong><ul>" +
          warns.map((x) => `<li>${x.replace(/</g, "&lt;")}</li>`).join("") + "</ul>";
      }
      renderContract();
      goto("contract");
    } catch (e) { err("deal-error", e.message); }
  });

  function renderContract() {
    const { claimScript, refundScript, internalXOnly, tree } = S.contract;
    $("htlc-address").textContent = tree.address;
    $("claim-asm").textContent = E.scriptAsm(claimScript);
    $("refund-asm").textContent = E.scriptAsm(refundScript)
      .replace(/^<([0-9a-f]+)…3B> CLTV/, (m, h) => {
        // render the timelock push as the block height it is, not raw hex
        const n = Number(E.bytesToNumberBE
          ? E.bytesToNumberBE(E.hexToBytes(h.padEnd(6, "0").slice(0, 6)))
          : parseInt(h.slice(0, 6).match(/../g).reverse().join(""), 16));
        return Number.isSafeInteger(n) ? `<block ${n}> CLTV` : m;
      });
    $("kv-internal").textContent = hex(internalXOnly);
    $("kv-leaf0").textContent = hex(tree.leafHashes[0]);
    $("kv-leaf1").textContent = hex(tree.leafHashes[1]);
    $("kv-root").textContent = hex(tree.root);
    $("kv-timeout").textContent = `${S.timeout}` +
      (S.chainHeight ? ` (chain at ${S.chainHeight}; ${S.timeout - S.chainHeight} blocks to go)` : "");
    $("cb-claim").value = hex(tree.controlBlocks[0]);
    $("cb-refund").value = hex(tree.controlBlocks[1]);
    $("desc-fp").textContent = S.descriptor.fingerprint;
    $("descriptor").value = S.descriptor.string;
    $("funding-status").textContent = "";
    // QR
    try {
      if (typeof window.qrcode !== "undefined") {
        const qr = qrcode(0, "M");
        qr.addData(tree.address);
        qr.make();
        const c = $("htlc-qr"), ctx = c.getContext("2d"), n = qr.getModuleCount(), s = c.width / n;
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
        ctx.fillStyle = "#000";
        for (let r = 0; r < n; r++) for (let col = 0; col < n; col++)
          if (qr.isDark(r, col)) ctx.fillRect(col * s, r * s, s + 0.5, s + 0.5);
      }
    } catch { /* QR is a convenience; the address text is authoritative */ }
    const ordering = E.timeoutOrderingWarning(S.role, S.timeout, S.counterparty.refundTimeout);
    if (ordering) { $("ordering-warning").hidden = false; $("ordering-warning").textContent = ordering; }
    else { $("ordering-warning").hidden = true; $("ordering-warning").textContent = ""; }
    err("contract-error", null);
    ok("desc-import-out", null);
  }

  $("copy-address").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("htlc-address").textContent); $("copy-address").textContent = "Copied"; }
    catch { $("copy-address").textContent = "Copy failed"; }
    setTimeout(() => ($("copy-address").textContent = "Copy address"), 1200);
  });
  $("copy-desc").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("descriptor").value); $("copy-desc").textContent = "Copied"; }
    catch { $("copy-desc").textContent = "Copy failed"; }
    setTimeout(() => ($("copy-desc").textContent = "Copy"), 1200);
  });
  for (const b of document.querySelectorAll(".copy-btn")) {
    b.addEventListener("click", async () => {
      const t = $(b.dataset.for);
      try { await navigator.clipboard.writeText(t.value || t.textContent); b.textContent = "Copied"; }
      catch { b.textContent = "Copy failed"; }
      setTimeout(() => (b.textContent = "Copy"), 1200);
    });
  }

  $("desc-import-btn").addEventListener("click", () => {
    err("contract-error", null);
    ok("desc-import-out", null);
    try {
      applyNetwork();
      const parsed = E.parseDescriptor(S.network, $("desc-import").value);
      S.contract = parsed.contract;
      S.descriptor = { obj: parsed.obj, fingerprint: parsed.fingerprint, string: $("desc-import").value.trim() };
      S.timeout = parsed.obj.timeout;
      S.hashHex = parsed.obj.hash;
      S.amountGrains = parsed.obj.amountGrains ?? 0;
      S.label = parsed.obj.label ?? "";
      S.counterparty = parsed.obj.counterparty ?? {};
      // adopt the contract's keys for display
      const claimerXOnly = E.hexToBytes(parsed.obj.claimerXOnly);
      const refundeeXOnly = E.hexToBytes(parsed.obj.refundeeXOnly);
      S.cp = { xonly: S.role === "maker" ? claimerXOnly : refundeeXOnly };
      S.you = S.you || null;
      S.utxo = null; S.plan = null; S.finalTx = null;
      renderContract();
      ok("desc-import-out", "✓ Descriptor verified — every field re-derived from the contract. Fingerprint " + parsed.fingerprint);
    } catch (e) { err("contract-error", e.message); }
  });

  $("save-deal").addEventListener("click", () => {
    try {
      const deals = loadDeals();
      const id = "deal-" + Date.now().toString(36);
      deals.push({
        id, label: S.label || ("HTLC " + S.descriptor.fingerprint),
        role: S.role, network: S.network.hrp,
        address: S.contract.tree.address,
        descriptor: S.descriptor.string,
        fingerprint: S.descriptor.fingerprint,
        timeout: S.timeout, hash: S.hashHex, amountGrains: S.amountGrains,
        counterparty: S.counterparty,
        preimage: S.role === "maker" ? S.preimageHex : "", // sensitive — local only
        createdAt: new Date().toISOString(),
      });
      store.set("atomic.deals", JSON.stringify(deals));
      renderDeals();
      ok("desc-import-out", "✓ Deal saved locally.");
    } catch (e) { err("contract-error", e.message); }
  });

  function loadDeals() {
    try { return JSON.parse(store.get("atomic.deals") || "[]"); }
    catch { return []; }
  }
  function renderDeals() {
    const deals = loadDeals();
    const box = $("deals-list");
    if (!deals.length) { box.innerHTML = '<p class="hint">No saved deals yet.</p>'; return; }
    box.innerHTML = "";
    for (const d of deals) {
      const row = document.createElement("div");
      row.className = "deal-row";
      row.innerHTML = `<div><strong></strong> <code></code><br><span class="hint"></span></div>`;
      row.querySelector("strong").textContent = d.label;
      row.querySelector("code").textContent = d.address;
      row.querySelector(".hint").textContent =
        `${d.role} · ${d.network} · timeout ${d.timeout} · fp ${d.fingerprint}` +
        (d.preimage ? " · secret stored" : "");
      const btns = document.createElement("div");
      btns.className = "row";
      const load = document.createElement("button");
      load.className = "btn ghost"; load.textContent = "Load";
      load.addEventListener("click", () => loadDeal(d));
      const del = document.createElement("button");
      del.className = "btn ghost"; del.textContent = "Delete";
      del.addEventListener("click", () => {
        store.set("atomic.deals", JSON.stringify(loadDeals().filter((x) => x.id !== d.id)));
        renderDeals();
      });
      btns.append(load, del);
      row.append(btns);
      box.append(row);
    }
  }
  function loadDeal(d) {
    try {
      err("deal-error", null);
      $("network").value = d.network === "tprl" ? "testnet" : "mainnet";
      applyNetwork();
      document.querySelector(`input[name="role"][value="${d.role}"]`).checked = true;
      applyRole();
      const parsed = E.parseDescriptor(S.network, d.descriptor);
      S.contract = parsed.contract;
      S.descriptor = { obj: parsed.obj, fingerprint: parsed.fingerprint, string: d.descriptor };
      S.timeout = parsed.obj.timeout;
      S.hashHex = parsed.obj.hash;
      S.amountGrains = parsed.obj.amountGrains ?? 0;
      S.label = d.label || "";
      S.counterparty = d.counterparty || {};
      S.preimageHex = d.preimage || "";
      if (S.role === "maker" && S.preimageHex) {
        $("preimage").value = S.preimageHex;
        $("hashlock").value = S.hashHex;
        $("copy-secret").disabled = false;
      } else if (S.role === "taker") {
        $("hashlock-taker").value = S.hashHex;
      }
      $("amount").value = S.amountGrains ? (S.amountGrains / 1e8).toString() : "";
      $("timeout").value = S.timeout;
      $("deal-label").value = S.label;
      S.utxo = null; S.plan = null; S.finalTx = null;
      renderContract();
      goto("contract");
    } catch (e) { err("deal-error", e.message); }
  }
  renderDeals();

  $("check-funding").addEventListener("click", async () => {
    err("contract-error", null);
    try {
      const utxos = await E.fetchUtxos(S.blockbook, S.contract.tree.address);
      const conf = utxos.filter((u) => u.confirmations > 0);
      const total = conf.reduce((a, u) => a + u.value, 0);
      $("funding-status").textContent = conf.length
        ? `✓ ${conf.length} confirmed UTXO(s), ${E.fmtPRL(total)} total`
        : (utxos.length ? "…unconfirmed UTXOs only — not safe to settle yet" : "no funding seen yet");
    } catch (e) { err("contract-error", "Funding check failed: " + e.message); }
  });
  $("to-fund").addEventListener("click", () => {
    $("fund-address").textContent = S.contract.tree.address;
    $("fund-expected").textContent = S.amountGrains ? E.fmtPRL(S.amountGrains) + ` (${S.amountGrains} grains)` : "— (amount was not recorded)";
    $("fund-utxos").innerHTML = "";
    ok("fund-pick", null);
    $("to-track").disabled = true;
    goto("fund");
  });

  /* ---------- fund ---------- */
  $("fund-refresh").addEventListener("click", async () => {
    err("fund-error", null);
    ok("fund-pick", null);
    $("to-track").disabled = true;
    try {
      const utxos = await E.fetchUtxos(S.blockbook, S.contract.tree.address);
      const conf = utxos.filter((u) => u.confirmations > 0);
      const box = $("fund-utxos");
      box.innerHTML = "";
      if (!conf.length) {
        box.innerHTML = '<p class="hint">No confirmed funding UTXOs. Fund the address from your wallet, then refresh. Unconfirmed UTXOs are hidden — spending one would let the funder double-spend the deposit.</p>';
        return;
      }
      for (const u of conf) {
        const row = document.createElement("div");
        row.className = "utxo-row";
        const okAmt = !S.amountGrains || u.value >= S.amountGrains;
        row.innerHTML = `<code></code><span></span><span class="hint"></span>`;
        row.querySelector("code").textContent = `${u.txid.slice(0, 16)}…:${u.vout}`;
        row.querySelector("span").textContent = E.fmtPRL(u.value);
        row.querySelector(".hint").textContent = `${u.confirmations} conf` + (okAmt ? "" : " — below the deal amount");
        const pick = document.createElement("button");
        pick.className = "btn ghost"; pick.textContent = "Select";
        pick.addEventListener("click", () => {
          S.utxo = { txid: u.txid, vout: u.vout, value: u.value, spk: S.contract.tree.spk };
          for (const r of box.querySelectorAll(".utxo-row")) r.classList.remove("selected");
          row.classList.add("selected");
          ok("fund-pick", `✓ Funding UTXO selected: ${u.txid.slice(0, 16)}…:${u.vout} — ${E.fmtPRL(u.value)}`);
          $("to-track").disabled = false;
        });
        row.append(pick);
        box.append(row);
      }
    } catch (e) { err("fund-error", "UTXO fetch failed: " + e.message); }
  });
  $("fund-manual").addEventListener("click", () => {
    err("fund-error", null);
    try {
      const txid = $("fund-txid").value.trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(txid)) throw new Error("funding txid must be 64 hex characters");
      const vout = Number($("fund-vout").value);
      const value = Number($("fund-value").value);
      if (!Number.isSafeInteger(vout) || vout < 0) throw new Error("bad vout");
      if (!Number.isSafeInteger(value) || value < 546) throw new Error("value below dust (546 grains)");
      S.utxo = { txid, vout, value, spk: S.contract.tree.spk };
      ok("fund-pick", `✓ Manual outpoint accepted (trusted as-is): ${txid.slice(0, 16)}…:${vout} — ${E.fmtPRL(value)}`);
      $("to-track").disabled = false;
    } catch (e) { err("fund-error", e.message); }
  });
  $("to-track").addEventListener("click", () => { refreshTrack(); goto("track"); });

  /* ---------- track ---------- */
  async function refreshTrack() {
    err("track-error", null);
    $("track-updated").textContent = "refreshing…";
    try {
      const txs = await E.fetchAddressTxs(S.blockbook, S.contract.tree.address);
      const st = E.classifyHtlcState(txs, S.contract.tree.address, hex(S.contract.tree.spk));
      $("tr-funding").textContent = st.funding
        ? `${st.funding.txid.slice(0, 16)}… — ${E.fmtPRL(st.funding.value)} (${st.funding.confirmations} conf, height ${st.funding.height ?? "?"})`
        : "no confirmed funding seen";
      $("tr-spend").textContent = st.spend
        ? `SPENT in ${st.spend.txid} (${st.spend.confirmations} conf, height ${st.spend.height ?? "?"}) — claim or refund executed`
        : "unspent — HTLC still locked";
      $("tr-timeout").textContent = `block ${S.timeout}`;
      if (S.chainHeight) {
        const left = S.timeout - S.chainHeight;
        const mins = Math.round((left * 194) / 60);
        $("tr-countdown").textContent = left > 0
          ? `${left} blocks (~${mins} min) until the refund opens`
          : `timeout passed ${-left} blocks ago — refund is open`;
      } else {
        $("tr-countdown").textContent = "fetch the chain height on the Deal step for a countdown";
      }
      if (st.funding && !S.utxo) {
        S.utxo = { txid: st.funding.txid, vout: st.funding.vout, value: st.funding.value, spk: S.contract.tree.spk };
      }
      $("track-updated").textContent = "updated " + new Date().toLocaleTimeString();
    } catch (e) {
      err("track-error", "Track refresh failed: " + e.message);
      $("track-updated").textContent = "";
    }
  }
  $("track-refresh").addEventListener("click", refreshTrack);

  $("store-preimage").addEventListener("click", () => {
    err("revealed-error", null);
    ok("revealed-out", null);
    try {
      const p = $("revealed-preimage").value.trim();
      E.checkPreimage(p, S.hashHex); // throws on mismatch
      S.preimageHex = p.toLowerCase();
      // persist with the current deal if one is loaded
      const deals = loadDeals();
      const d = deals.find((x) => x.fingerprint === S.descriptor.fingerprint);
      if (d) { d.preimage = S.preimageHex; store.set("atomic.deals", JSON.stringify(deals)); renderDeals(); }
      ok("revealed-out", "✓ Preimage matches the hash lock and is stored with the deal.");
    } catch (e) { err("revealed-error", e.message); }
  });
  $("to-settle").addEventListener("click", () => {
    if (!S.utxo) { err("track-error", "Select a funding UTXO on the Fund step first (or refresh tracking to auto-pick it)."); return; }
    setSettleMode("claim");
    updateRefundLockStatus();
    goto("settle");
  });

  /* ---------- settle ---------- */
  function setSettleMode(m) {
    S.settleMode = m;
    $("tab-claim").classList.toggle("active", m === "claim");
    $("tab-refund").classList.toggle("active", m === "refund");
    $("settle-claim-form").hidden = m !== "claim";
    $("settle-refund-form").hidden = m !== "refund";
    $("plan-card").hidden = true;
    S.plan = null; S.finalTx = null;
    $("to-verify").disabled = true;
    err("settle-error", null);
    err("assemble-error", null);
    ok("sign-out", null);
    if (m === "claim" && S.preimageHex) $("claim-preimage").value = S.preimageHex;
    $("sign-key-hint").textContent = m === "claim" ? "(claimer's key)" : "(refundee's key)";
  }
  $("tab-claim").addEventListener("click", () => setSettleMode("claim"));
  $("tab-refund").addEventListener("click", () => setSettleMode("refund"));

  function updateRefundLockStatus() {
    const el = $("refund-lock-status");
    if (S.chainHeight && S.chainHeight < S.timeout) {
      el.className = "lock-status locked";
      el.textContent = `🔒 Refund locked until block ${S.timeout} (chain at ${S.chainHeight} — ${S.timeout - S.chainHeight} blocks to go)`;
    } else if (S.chainHeight) {
      el.className = "lock-status open";
      el.textContent = `🔓 Refund open (chain at ${S.chainHeight}, timeout was ${S.timeout})`;
    } else {
      el.className = "lock-status locked";
      el.textContent = "Chain height unknown — fetch it on the Deal step before refunding.";
    }
  }

  $("build-plan").addEventListener("click", () => {
    err("settle-error", null);
    err("assemble-error", null);
    ok("sign-out", null);
    $("plan-card").hidden = true;
    S.plan = null; S.finalTx = null;
    $("to-verify").disabled = true;
    try {
      if (!S.utxo) throw new Error("select a funding UTXO on the Fund step first");
      const input = { txid: S.utxo.txid, vout: S.utxo.vout, value: S.utxo.value, spk: S.contract.tree.spk };
      let plan;
      if (S.settleMode === "claim") {
        const destProg = E.addressToProgram($("claim-dest").value, S.network);
        const feeRate = Number($("claim-feerate").value);
        if (!Number.isFinite(feeRate) || feeRate <= 0) throw new Error("bad fee rate");
        plan = E.planClaim({
          network: S.network, contract: S.contract, input,
          preimageHex: $("claim-preimage").value.trim(),
          destProgram: destProg, feeRateGrainsPerVByte: feeRate,
        });
        $("plan-kind").textContent = "Claim — preimage revealed, claimer paid";
      } else {
        const destRaw = $("refund-dest").value.trim();
        const destProg = destRaw
          ? E.addressToProgram(destRaw, S.network)
          : S.role === "maker" ? S.you.xonly : S.cp.xonly;
        const feeRate = Number($("refund-feerate").value);
        if (!Number.isFinite(feeRate) || feeRate <= 0) throw new Error("bad fee rate");
        plan = E.planRefund({
          network: S.network, contract: S.contract, input,
          destProgram: destProg, feeRateGrainsPerVByte: feeRate,
          chainHeight: S.chainHeight || null,
        });
        $("plan-kind").textContent = "Refund — timelock open, refundee reclaims";
      }
      S.plan = plan;
      const digest = E.settleDigest(S.network, plan);
      S.planDigest = hex(digest);
      $("plan-digest").textContent = S.planDigest;
      $("plan-outputs").innerHTML = plan.outputs.map((o) =>
        `<div>→ <code>${E.encodeBech32m(S.network.hrp, 1, o.program)}</code> — ${E.fmtPRL(o.value)}</div>`).join("");
      $("plan-fee").textContent = `${E.fmtPRL(plan.fee)} (${plan.fee} grains · ${plan.vBytes} vB)`;
      $("plan-card").hidden = false;
    } catch (e) { err("settle-error", e.message); }
  });

  function keyToPrivXonly(kv) {
    const t = kv.trim();
    if (/^[0-9a-fA-F]{64}$/.test(t)) {
      // ambiguous: could be x-only pubkey or privkey. Try privkey path only if
      // the user explicitly chose it — here we treat 64-hex as a PRIVATE key
      // for signing (pubkeys can't sign). The address guard below confirms it
      // matches the expected contract key.
      const priv = E.hexToBytes(t.toLowerCase());
      return { priv, xonly: E.schnorr.getPublicKey(priv) };
    }
    const k = E.partyKeyFromInput(t, S.network);
    if (!k.priv) throw new Error("that input has no private key — paste the signature instead");
    return { priv: k.priv, xonly: k.xonly };
  }

  $("sign-local").addEventListener("click", () => {
    err("assemble-error", null);
    ok("sign-out", null);
    try {
      if (!S.plan) throw new Error("build a settlement plan first");
      const expected = S.settleMode === "claim"
        ? E.hexToBytes(S.descriptor.obj.claimerXOnly)
        : E.hexToBytes(S.descriptor.obj.refundeeXOnly);
      const { priv, xonly } = keyToPrivXonly($("sign-key").value);
      if (hex(xonly) !== hex(expected)) {
        throw new Error("this key does not match the " +
          (S.settleMode === "claim" ? "claimer's" : "refundee's") + " contract key");
      }
      const sig = E.signForXOnly(priv, S.planDigest);
      if (!E.verifySchnorrSig(sig, S.planDigest, expected)) throw new Error("self-check failed — refusing");
      $("sign-sig").value = hex(sig);
      ok("sign-out", "✓ Signed locally & self-verified against the contract key.");
    } catch (e) { err("assemble-error", e.message); }
  });

  $("assemble").addEventListener("click", () => {
    err("assemble-error", null);
    try {
      if (!S.plan) throw new Error("build a settlement plan first");
      const sigHex = $("sign-sig").value.trim();
      let spend;
      if (S.settleMode === "claim") {
        spend = E.assembleClaim(S.network, S.plan, sigHex, E.hexToBytes(S.descriptor.obj.claimerXOnly));
      } else {
        spend = E.assembleRefund(S.network, S.plan, sigHex, E.hexToBytes(S.descriptor.obj.refundeeXOnly));
      }
      if (spend.digest !== S.planDigest) throw new Error("digest mismatch — aborting");
      if (spend.vBytes !== S.plan.vBytes) throw new Error("vBytes mismatch — aborting");
      S.finalTx = spend;
      $("final-txid").textContent = spend.txid;
      $("final-vbytes").textContent = spend.vBytes + " vB";
      $("final-kind").textContent = S.settleMode === "claim" ? "Claim" : "Refund";
      $("final-hex").value = spend.hex;
      $("to-verify").disabled = false;
      $("sign-key").value = ""; // wipe key material after assembly
      goto("verify");
    } catch (e) { err("assemble-error", e.message); }
  });

  $("bundle-export").addEventListener("click", () => {
    err("assemble-error", null);
    try {
      if (!S.plan) throw new Error("build a settlement plan first");
      const b = E.exportUnsignedBundle(S.network, S.plan, S.descriptor);
      $("bundle-text").value = JSON.stringify(b);
      $("bundle-fp").textContent = b.fingerprint;
    } catch (e) { err("assemble-error", e.message); }
  });
  $("bundle-copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("bundle-text").value); $("bundle-copy").textContent = "Copied"; }
    catch { $("bundle-copy").textContent = "Copy failed"; }
    setTimeout(() => ($("bundle-copy").textContent = "Copy"), 1200);
  });
  $("bundle-import-btn").addEventListener("click", () => {
    err("bundle-import-error", null);
    ok("bundle-import-out", null);
    try {
      const { bundle } = E.importUnsignedBundle(S.network, $("bundle-import").value, S.contract);
      ok("bundle-import-out",
        `✓ Bundle verified — fingerprint ${bundle.fingerprint}, kind ${bundle.kind}, ` +
        `digest ${String(bundle.digest).slice(0, 16)}…, fee ${bundle.feeGrains} grains.`);
    } catch (e) { err("bundle-import-error", e.message); }
  });
  $("to-verify").addEventListener("click", () => goto("verify"));

  /* ---------- broadcast + wipe ---------- */
  $("copy-hex").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("final-hex").value); $("copy-hex").textContent = "Copied"; }
    catch { $("copy-hex").textContent = "Copy failed"; }
    setTimeout(() => ($("copy-hex").textContent = "Copy hex"), 1200);
  });
  $("broadcast").addEventListener("click", async () => {
    err("broadcast-error", null);
    ok("broadcast-ok", null);
    try {
      if (!S.finalTx) throw new Error("assemble a settlement transaction first");
      const txid = await E.broadcastTx(S.blockbook, $("final-hex").value);
      ok("broadcast-ok", "✓ Broadcast accepted. TXID: " + txid);
    } catch (e) { err("broadcast-error", e.message); }
  });
  $("wipe").addEventListener("click", () => {
    for (const id of ["key-you", "preimage", "sign-key", "sign-sig", "claim-preimage", "revealed-preimage"]) {
      $(id).value = "";
    }
    S.preimageHex = "";
    $("wipe-msg").textContent = "key material wiped from this page (saved deals keep their stored secrets — delete them in the list to remove)";
  });

  /* ---------- standalone verifier ---------- */
  $("verify-desc-btn").addEventListener("click", () => {
    err("verify-desc-error", null);
    ok("verify-desc-out", null);
    try {
      applyNetwork();
      const parsed = E.parseDescriptor(S.network, $("verify-desc").value);
      const o = parsed.obj;
      ok("verify-desc-out",
        `✓ VERIFIED — pearl-atomic:v1: descriptor, fingerprint ${parsed.fingerprint}. ` +
        `Address ${o.address} re-derived; claim/refund scripts, NUMS internal key and both control blocks check out. ` +
        `Timeout block ${o.timeout}, hash ${String(o.hash).slice(0, 16)}….`);
    } catch (e) { err("verify-desc-error", e.message); }
  });
  $("verify-addr-btn").addEventListener("click", async () => {
    err("verify-addr-error", null);
    ok("verify-addr-out", null);
    try {
      const addr = $("verify-addr").value.trim();
      E.addressToProgram(addr, S.network); // validates shape + network
      const txs = await E.fetchAddressTxs(S.blockbook, addr);
      const st = E.classifyHtlcState(txs, addr, null);
      ok("verify-addr-out",
        (st.funding ? `FUNDED: ${st.funding.txid} (${st.funding.confirmations} conf, ${E.fmtPRL(st.funding.value)})` : "UNFUNDED: no confirmed funding seen") +
        (st.spend ? ` · SPENT in ${st.spend.txid} (${st.spend.confirmations} conf)` : " · unspent"));
    } catch (e) { err("verify-addr-error", e.message); }
  });

  if (typeof window.qrcode === "undefined") {
    console.warn("qrcode lib missing — address QR disabled");
  }
})();
