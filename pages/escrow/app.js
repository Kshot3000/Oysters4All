/* Pearl Escrow UI — 4-step escrow wizard. All signing happens via the
 * window.PearlEscrow bundle (audited crypto + verified escrow core); this
 * file is pure UI wiring. Keys and mnemonics never leave the page and are
 * never persisted. */
(() => {
  "use strict";
  const E = window.PearlEscrow;
  if (!E) { document.body.innerHTML = "<p style='padding:2rem'>Failed to load pearl-escrow.bundle.js</p>"; return; }

  const $ = (id) => document.getElementById(id);
  const DONATE = "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d";

  /* storage that survives hostile localStorage (Gallery lesson) */
  const store = {
    m: {},
    get(k) { try { return localStorage.getItem(k); } catch { return this.m[k] ?? null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { this.m[k] = v; } },
  };

  const S = {
    network: E.NETWORKS.mainnet,
    blockbook: store.get("escrow.blockbook") || E.NETWORKS.mainnet.blockbook,
    parties: null,      // {buyer:{xonly,priv}, seller, arbiter, refund}
    lockHeight: 0,
    contract: null,     // {releaseScript, refundScript, tree}
    utxo: null,         // {txid, vout, value}
    mode: "release",
    plan: null,         // {outputs, fee, vBytes, digest, input, leafScript, controlBlock, stackLens, sequence, locktime}
    sigs: [],           // [{keyIndex, sig:hex}]
    finalTx: null,
    chainHeight: 0,
  };

  const fmtPRL = (g) => {
/* BigInt-exact (pool float-format class): the old float format
     * silently rounds grain counts past Number.MAX_SAFE_INTEGER.
     * Integer string/BigInt grain counts format exactly; anything
     * else keeps the legacy float rendering. */
    const s = typeof g === "bigint" ? g.toString() : String(g).trim();
    if (!/^-?\d+$/.test(s)) return (Number(g) / E.GRAIN_PER_PRL).toFixed(8).replace(/0+$/, "").replace(/\.$/, ".0") + " PRL";
    const b = BigInt(s), neg = b < 0n, a = neg ? -b : b;
    const w = (a / 100000000n).toString();
    const f = (a % 100000000n).toString().padStart(8, "0").replace(/0+$/, "");
    return (neg ? "-" : "") + w + "." + (f || "0") + " PRL";
  };
  const err = (id, msg) => { const e = $(id); e.hidden = !msg; e.textContent = msg || ""; };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const hex = (b) => E.bytesToHex(b);

  /* ---------- step navigation ---------- */
  const steps = ["parties", "contract", "spend", "broadcast"];
  function goto(step) {
    steps.forEach((s) => {
      $("step-" + s).classList.toggle("active", s === step);
      const b = document.querySelector(`#steps button[data-step="${s}"]`);
      b.classList.toggle("active", s === step);
      if (steps.indexOf(s) < steps.indexOf(step)) b.classList.add("done");
    });
    window.scrollTo({ top: 0, behavior: (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth") });
  }
  document.querySelectorAll("#steps button").forEach((b) =>
    b.addEventListener("click", () => goto(b.dataset.step)));

  document.querySelectorAll(".copy-btn").forEach((b) =>
    b.addEventListener("click", async () => {
      const t = $(b.dataset.for);
      const v = t.value !== undefined && t.tagName !== "CODE" ? t.value : t.textContent;
      try { await navigator.clipboard.writeText(v.trim()); b.textContent = "Copied"; }
      catch { b.textContent = "Copy failed"; }
      setTimeout(() => (b.textContent = "Copy"), 1200);
    }));
  $("donate-addr").textContent = DONATE;

  /* ---------- network / blockbook ---------- */
  function applyNetwork() {
    S.network = E.NETWORKS[$("network").value] || E.NETWORKS.mainnet;
    if (!store.get("escrow.blockbook")) $("blockbook").value = S.network.blockbook;
    S.blockbook = $("blockbook").value.trim() || S.network.blockbook;
    store.set("escrow.blockbook", S.blockbook);
  }
  $("network").addEventListener("change", () => { store.set("escrow.blockbook", ""); applyNetwork(); });
  $("blockbook").addEventListener("change", applyNetwork);
  $("blockbook").value = S.blockbook;

  /* ---------- step 1: parties ---------- */
  document.querySelectorAll(".gen-key").forEach((b) =>
    b.addEventListener("click", () => {
      $(b.dataset.for).value = E.newMnemonic();
      $(b.dataset.for).dispatchEvent(new Event("input"));
    }));
  ["buyer", "seller", "arbiter"].forEach((role) => {
    $("key-" + role).addEventListener("input", () => {
      const ok = $("ok-" + role);
      try {
        const k = E.partyKeyFromInput($("key-" + role).value, S.network);
        ok.textContent = "✓ " + hex(k.xonly).slice(0, 16) + "…" + (k.priv ? " (signing key present)" : " (pubkey only)");
        ok.style.color = "";
      } catch (e) { ok.textContent = $("key-" + role).value.trim() ? "✗ " + e.message : ""; ok.style.color = "#e88a7d"; }
    });
  });
  $("refund-is-buyer").addEventListener("click", () => { $("key-refund").value = $("key-buyer").value.trim(); });
  $("fetch-height").addEventListener("click", async () => {
    try {
      const r = await fetch(S.blockbook.replace(/\/$/, "") + "/api/v2");
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      if (!Number.isFinite(j.blockHeight)) throw new Error("no blockHeight in response");
      S.chainHeight = j.blockHeight;
      $("chain-height").value = j.blockHeight;
    } catch (e) { err("parties-error", "Could not fetch chain height: " + e.message); }
  });
  $("lock-plus-week").addEventListener("click", () => {
    const h = Number($("chain-height").value) || S.chainHeight;
    if (!h) { err("parties-error", "Fetch the chain height first (or type it in)."); return; }
    err("parties-error", null);
    $("lock-height").value = h + 3120;
  });

  $("to-contract").addEventListener("click", () => {
    err("parties-error", null);
    try {
      applyNetwork();
      const buyer = E.partyKeyFromInput($("key-buyer").value, S.network);
      const seller = E.partyKeyFromInput($("key-seller").value, S.network);
      const arbiter = E.partyKeyFromInput($("key-arbiter").value, S.network);
      const refundRaw = $("key-refund").value.trim();
      const refund = refundRaw ? E.partyKeyFromInput(refundRaw, S.network) : buyer;
      const lockHeight = Number($("lock-height").value);
      if (!Number.isSafeInteger(lockHeight) || lockHeight <= 0) throw new Error("set a refund unlock block height");
      const h = Number($("chain-height").value);
      if (h) S.chainHeight = h;
      if (S.chainHeight && lockHeight <= S.chainHeight) {
        throw new Error(`lock height ${lockHeight} is not in the future (chain at ${S.chainHeight})`);
      }
      const releaseScript = E.buildReleaseScript(buyer.xonly, seller.xonly, arbiter.xonly);
      const refundScript = E.buildRefundScript(refund.xonly, lockHeight);
      // NUMS internal key — no party knows the discrete log, so keypath
      // spending is impossible (a party-controlled internal key would leave
      // a keypath backdoor: the holder can compute d + TapTweak and spend
      // unilaterally, bypassing both leaves).
      const internalXOnly = E.numsInternalKeyEscrow(releaseScript, refundScript);
      const tree = E.taptree2(S.network, internalXOnly, releaseScript, refundScript);
      S.parties = { buyer, seller, arbiter, refund };
      S.lockHeight = lockHeight;
      S.contract = { releaseScript, refundScript, internalXOnly, tree };
      S.utxo = null;
      renderContract();
      goto("contract");
    } catch (e) { err("parties-error", e.message); }
  });

  function renderContract() {
    const { releaseScript, refundScript, tree } = S.contract;
    $("escrow-address").textContent = tree.address;
    $("release-asm").textContent = E.scriptAsm(releaseScript);
    $("refund-asm").textContent = E.scriptAsm(refundScript);
    $("kv-internal").textContent = hex(S.contract.internalXOnly) + "  (NUMS — no known private key)";
    $("kv-leaf0").textContent = hex(tree.leafHashes[0]);
    $("kv-leaf1").textContent = hex(tree.leafHashes[1]);
    $("kv-root").textContent = hex(tree.root);
    $("cb-release").value = hex(tree.controlBlocks[0]);
    $("cb-refund").value = hex(tree.controlBlocks[1]);
    $("refund-height-echo").textContent = S.lockHeight;
    // QR
    try {
      const qr = qrcode(0, "M");
      qr.addData(tree.address);
      qr.make();
      const c = $("escrow-qr"), ctx = c.getContext("2d"), n = qr.getModuleCount(), s = c.width / n;
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
      ctx.fillStyle = "#000";
      for (let r = 0; r < n; r++) for (let col = 0; col < n; col++)
        if (qr.isDark(r, col)) ctx.fillRect(col * s, r * s, s + 0.5, s + 0.5);
    } catch { /* QR is a convenience; the address text is authoritative */ }
    $("utxo-list").innerHTML = "";
    $("funding-status").textContent = "";
    $("to-spend").disabled = true;
    updateLockStatus();
  }

  /* ---------- step 2: funding ---------- */
  $("check-funding").addEventListener("click", async () => {
    err("contract-error", null);
    $("funding-status").textContent = "querying…";
    try {
      const utxos = await E.fetchUtxos(S.blockbook, S.contract.tree.address);
      const funded = utxos.filter((u) => u.confirmations > 0);
      $("funding-status").textContent =
        utxos.length === 0 ? "no UTXOs — fund the escrow address first" :
        `${utxos.length} UTXO(s), ${fmtPRL(utxos.reduce((a, u) => a + u.value, 0))} total` +
        (funded.length < utxos.length ? " (unconfirmed UTXOs are hidden for safety)" : "");
      renderUtxos(funded);
    } catch (e) { err("contract-error", "Funding check failed: " + e.message); $("funding-status").textContent = ""; }
  });

  function renderUtxos(utxos) {
    const list = $("utxo-list");
    list.innerHTML = "";
    if (utxos.length === 0) {
      list.innerHTML = `<p class="hint">No confirmed UTXOs. Send PRL to the escrow address, then check again.
      Only confirmed coins are listed — spending an unconfirmed escrow output would let a funder double-spend the deposit.</p>`;
      return;
    }
    utxos.forEach((u, i) => {
      const d = document.createElement("div");
      d.className = "utxo";
      d.innerHTML = `<input type="radio" name="utxo" ${i === 0 ? "checked" : ""}>
        <code>${esc(u.txid)}:${u.vout}</code><span>${fmtPRL(u.value)}</span><span class="hint">${u.confirmations} conf</span>`;
      d.addEventListener("click", () => {
        list.querySelectorAll(".utxo").forEach((x) => x.classList.remove("selected"));
        d.classList.add("selected");
        d.querySelector("input").checked = true;
        S.utxo = u;
        $("to-spend").disabled = false;
      });
      if (i === 0) { d.classList.add("selected"); S.utxo = u; $("to-spend").disabled = false; }
      list.appendChild(d);
    });
  }

  $("manual-utxo").addEventListener("click", () => {
    const list = $("utxo-list");
    list.innerHTML = `<div class="form-grid">
      <label class="wide">Funding txid<input id="mu-txid" spellcheck="false" placeholder="64 hex chars"></label>
      <label>vout<input id="mu-vout" type="number" min="0" value="0"></label>
      <label>Value (grains)<input id="mu-value" type="number" min="546" placeholder="e.g. 500000000"></label>
    </div><div class="row"><button id="mu-use" class="btn primary">Use this UTXO</button></div>
    <p class="hint">Only use a confirmed funding output you control. The app cannot verify confirmation here — double-check in an explorer.</p>`;
    $("mu-use").addEventListener("click", () => {
      err("contract-error", null);
      try {
        const txid = $("mu-txid").value.trim().toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(txid)) throw new Error("bad txid");
        const vout = Number($("mu-vout").value), value = Number($("mu-value").value);
        if (!Number.isSafeInteger(vout) || vout < 0) throw new Error("bad vout");
        if (!Number.isSafeInteger(value) || value < 546) throw new Error("value must be ≥ 546 grains");
        S.utxo = { txid, vout, value, confirmations: 0 };
        $("funding-status").textContent = `manual UTXO ${fmtPRL(value)} (unverified — confirm it yourself)`;
        $("to-spend").disabled = false;
      } catch (e) { err("contract-error", e.message); }
    });
  });

  $("to-spend").addEventListener("click", () => {
    // sensible defaults
    const buyerAddr = E.encodeBech32m(S.network.hrp, 1, S.parties.buyer.xonly);
    if (!$("pay-buyer-addr").value.trim()) $("pay-buyer-addr").value = buyerAddr;
    const refundAddr = E.encodeBech32m(S.network.hrp, 1, S.parties.refund.xonly);
    if (!$("refund-dest").value.trim()) $("refund-dest").value = refundAddr;
    updateLockStatus();
    goto("spend");
  });

  /* ---------- step 3: spend ---------- */
  document.querySelectorAll(".mode-card").forEach((b) =>
    b.addEventListener("click", () => {
      document.querySelectorAll(".mode-card").forEach((x) => x.classList.remove("selected"));
      b.classList.add("selected");
      S.mode = b.dataset.mode;
      $("spend-release-form").hidden = S.mode !== "release";
      $("spend-refund-form").hidden = S.mode !== "refund";
      $("plan-card").hidden = true;
      err("spend-error", null);
    }));

  $("fee-fetch").addEventListener("click", async () => {
    try {
      const r = await E.fetchFeeRateGrainsPerVByte(S.blockbook, 2);
      $("fee-rate").value = Math.max(1, Math.ceil(r));
    } catch (e) { err("spend-error", "Fee estimate failed: " + e.message); }
  });

  function updateLockStatus() {
    const el = $("refund-lock-status");
    if (!S.lockHeight) { el.textContent = ""; return; }
    if (S.chainHeight && S.chainHeight >= S.lockHeight) {
      el.className = "lock-status open";
      el.textContent = `✓ Timelock open — chain at ${S.chainHeight}, refund unlocks at ${S.lockHeight}.`;
    } else if (S.chainHeight) {
      el.className = "lock-status locked";
      el.textContent = `🔒 Refund locked — chain at ${S.chainHeight}, unlocks at ${S.lockHeight} (${S.lockHeight - S.chainHeight} blocks to go).`;
    } else {
      el.className = "lock-status locked";
      el.textContent = `Refund unlocks at block ${S.lockHeight}. Fetch the chain height on step 1 to check the lock.`;
    }
  }

  const prlToGrains = (s) => {
    // Exact parser: a float round-trip silently rounds sub-grain and
    // >8-decimal inputs (0.123456789 -> 12345679 grains). Parse the decimal
    // string with BigInt instead, like the core parser; refuse inexact input.
    const m = String(s).trim().match(/^(\d+)(?:\.(\d{1,8}))?$/);
    if (!m) throw new Error("amount must be a positive number");
    const g = BigInt(m[1]) * BigInt(E.GRAIN_PER_PRL) + BigInt((m[2] || "").padEnd(8, "0"));
    if (g <= 0n) throw new Error("amount must be a positive number");
    if (g > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("amount out of range");
    if (g < 546n) throw new Error("amount below dust (546 grains)");
    return Number(g);
  };

  $("build-plan").addEventListener("click", () => {
    err("spend-error", null);
    err("assemble-error", null);
    $("plan-card").hidden = true;
    S.sigs = [];
    try {
      if (!S.utxo) throw new Error("select a funding UTXO on step 2 first");
      const { releaseScript, refundScript, tree } = S.contract;
      const input = { txid: S.utxo.txid, vout: S.utxo.vout, value: S.utxo.value, spk: tree.spk };
      let outputs, leafScript, controlBlock, stackLens, sequence, locktime, plan;

      if (S.mode === "release") {
        const sellerProg = E.addressToProgram($("pay-seller-addr").value, S.network);
        const sellerAmt = prlToGrains($("pay-seller-amt").value);
        const buyerProg = E.addressToProgram($("pay-buyer-addr").value, S.network);
        const feeRate = Number($("fee-rate").value);
        plan = E.planSpend({
          inputValue: S.utxo.value,
          payments: [{ program: sellerProg, value: sellerAmt }],
          feeRateGrainsPerVByte: feeRate,
          scriptLen: releaseScript.length, controlLen: 65, stackLens: [64, 0, 64],
        });
        const ch = plan.outputs.find((o) => o.change);
        if (ch) ch.program = buyerProg; // no change output when dust was folded into the fee
        leafScript = releaseScript; controlBlock = tree.controlBlocks[0];
        stackLens = [64, 0, 64]; sequence = 0xffffffff; locktime = 0;
        outputs = plan.outputs;
      } else {
        if (S.chainHeight && S.chainHeight < S.lockHeight) {
          throw new Error(`refund is timelocked until block ${S.lockHeight} (chain at ${S.chainHeight})`);
        }
        const destProg = E.addressToProgram($("refund-dest").value, S.network);
        // Refund takes everything: exactly one output, fee computed from the
        // real witness size (1 sig + script + 65-byte control block).
        const feeRate = 5;
        const vB = E.spendVBytes({ nOut: 1, scriptLen: refundScript.length, controlLen: 65, stackLens: [64] });
        const fee = Math.ceil(vB * feeRate);
        const payVal = S.utxo.value - fee;
        if (payVal < 546) throw new Error("insufficient funds for the refund fee");
        plan = { outputs: [{ program: destProg, value: payVal }], fee, vBytes: vB, change: 0 };
        leafScript = refundScript; controlBlock = tree.controlBlocks[1];
        stackLens = [64]; sequence = 0xfffffffe; locktime = S.lockHeight;
        outputs = plan.outputs;
      }

      const digest = E.scriptPathSigDigestEx(S.network, input, outputs, leafScript, { sequence, locktime });
      S.plan = { input, outputs, leafScript, controlBlock, stackLens, sequence, locktime, fee: plan.fee, vBytes: plan.vBytes, digest: hex(digest), change: plan.change };

      $("plan-digest").textContent = S.plan.digest;
      $("plan-outputs").innerHTML = outputs.map((o) =>
        `<div>${o.change ? "↩ change" : "→"} <code>${E.encodeBech32m(S.network.hrp, 1, o.program)}</code> — ${fmtPRL(o.value)}</div>`).join("");
      $("plan-fee").textContent = `${fmtPRL(plan.fee)} (${plan.vBytes} vB)`;
      renderSigSlots();
      $("plan-card").hidden = false;
    } catch (e) { err("spend-error", e.message); }
  });

  const ROLE_NAMES = ["buyer", "seller", "arbiter"];
  function renderSigSlots() {
    const wrap = $("sig-slots");
    wrap.innerHTML = "";
    const n = S.mode === "release" ? 2 : 1;
    for (let i = 0; i < n; i++) {
      const d = document.createElement("div");
      d.className = "sig-slot";
      const roleOpts = S.mode === "release"
        ? ROLE_NAMES.map((r, k) => `<option value="${k}">${r}</option>`).join("")
        : `<option value="refund">refund key</option>`;
      d.innerHTML = `<h4>${S.mode === "release" ? `Signature ${i + 1} of 2` : "Refund signature"}</h4>
        <div class="form-grid">
          <label>Party<select class="slot-role">${roleOpts}</select></label>
          <label>Mnemonic / privkey <span class="hint-inline">(or paste a 64-hex signature below)</span>
            <input class="slot-key" type="password" spellcheck="false" placeholder="leave blank to paste a signature" autocomplete="off">
          </label>
          <label class="wide">Signature (128 hex = 64 bytes)<input class="slot-sig" spellcheck="false" placeholder="…"></label>
        </div>
        <div class="row"><button class="btn ghost slot-sign">Sign digest with this key</button></div>
        <div class="sig-out" hidden></div>`;
      const roleSel = d.querySelector(".slot-role"), keyIn = d.querySelector(".slot-key"),
        sigIn = d.querySelector(".slot-sig"), out = d.querySelector(".sig-out");
      const setSig = (sigHex, note) => {
        sigIn.value = sigHex;
        out.hidden = false;
        out.textContent = "✓ " + note + ": " + sigHex.slice(0, 32) + "…";
      };
      d.querySelector(".slot-sign").addEventListener("click", () => {
        err("assemble-error", null);
        try {
          const kv = keyIn.value.trim();
          if (!kv) throw new Error("enter the party's mnemonic or private key, or paste their signature");
          let priv, xonly;
          if (/^[0-9a-fA-F]{64}$/.test(kv)) {
            priv = E.hexToBytes(kv.toLowerCase());
            xonly = xonlyFromPriv(priv);
          } else {
            const k = E.partyKeyFromInput(kv, S.network);
            if (!k.priv) throw new Error("that input has no private key — paste the party's signature instead");
            priv = k.priv; xonly = k.xonly;
          }
          const expected = S.mode === "release" ? S.parties[ROLE_NAMES[Number(roleSel.value)]].xonly : S.parties.refund.xonly;
          if (hex(xonly) !== hex(expected)) throw new Error("this key does not match the selected party's contract key");
          const sig = E.signForXOnly(priv, S.plan.digest);
          if (!E.verifySchnorrSig(sig, S.plan.digest, expected)) throw new Error("self-check failed — refusing");
          setSig(hex(sig), "signed locally & self-verified");
        } catch (e) { err("assemble-error", e.message); }
      });
      // keep slot state in sync for assembly
      d._slot = { roleSel, sigIn };
      wrap.appendChild(d);
    }
    $("assemble").disabled = false;
  }

  // x-only pubkey from a raw 32-byte privkey (for the paste-privkey path)
  function xonlyFromPriv(priv) {
    // secp256k1 is not exported; derive via schnorr.getPublicKey (x-only, BIP-340)
    return E.schnorr.getPublicKey(priv);
  }

  $("assemble").addEventListener("click", () => {
    err("assemble-error", null);
    try {
      const slots = [...$("sig-slots").querySelectorAll(".sig-slot")];
      const keys = [S.parties.buyer.xonly, S.parties.seller.xonly, S.parties.arbiter.xonly];
      let stackItems;
      if (S.mode === "release") {
        const sigs = slots.map((d) => {
          const keyIndex = Number(d._slot.roleSel.value);
          const sigHex = d._slot.sigIn.value.trim().toLowerCase();
          if (!/^[0-9a-f]{128}$/.test(sigHex)) throw new Error("each signature slot needs a 128-hex (64-byte) signature");
          return { keyIndex, sig: sigHex };
        });
        stackItems = E.combineReleaseSigs(sigs, S.plan.digest, keys); // verifies both, throws otherwise
      } else {
        const sigHex = slots[0]._slot.sigIn.value.trim().toLowerCase();
        if (!/^[0-9a-f]{128}$/.test(sigHex)) throw new Error("paste the refund signature (128 hex = 64 bytes)");
        if (!E.verifySchnorrSig(sigHex, S.plan.digest, S.parties.refund.xonly)) {
          throw new Error("refund signature does not verify against the refund key");
        }
        stackItems = [E.hexToBytes(sigHex)];
      }
      const spend = E.buildScriptPathSpend(
        S.network, S.plan.input, S.plan.outputs,
        S.plan.leafScript, S.plan.controlBlock, stackItems,
        { sequence: S.plan.sequence, locktime: S.plan.locktime },
      );
      if (spend.digest !== S.plan.digest) throw new Error("digest mismatch — aborting");
      S.finalTx = spend;
      $("final-txid").textContent = spend.txid;
      $("final-vbytes").textContent = spend.vBytes + " vB";
      $("final-hex").value = spend.hex;
      $("broadcast-error").hidden = true;
      $("broadcast-ok").hidden = true;
      goto("broadcast");
    } catch (e) { err("assemble-error", e.message); }
  });

  /* ---------- step 4: broadcast ---------- */
  $("copy-hex").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("final-hex").value); $("copy-hex").textContent = "Copied"; }
    catch { $("copy-hex").textContent = "Copy failed"; }
    setTimeout(() => ($("copy-hex").textContent = "Copy hex"), 1200);
  });
  $("broadcast").addEventListener("click", async () => {
    err("broadcast-error", null);
    $("broadcast-ok").hidden = true;
    try {
      const txid = await E.broadcastTx(S.blockbook, $("final-hex").value);
      const ok = $("broadcast-ok");
      ok.hidden = false;
      ok.textContent = "✓ Broadcast accepted. TXID: " + txid;
    } catch (e) { err("broadcast-error", e.message); }
  });

  // QR library guard: qrcode.min.js defines window.qrcode
  if (typeof window.qrcode === "undefined") {
    console.warn("qrcode lib missing — address QR disabled");
  }
})();
