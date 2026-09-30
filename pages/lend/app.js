/* Pearl Lend UI — the counting-house desk.
 * Classic script; uses window.PearlLend (pearl-lend.bundle.js).
 * Keys live in memory only and are wiped after signing; descriptors and
 * non-secret state persist in localStorage. */
(function () {
  "use strict";
  const P = window.PearlLend;
  const $ = (id) => document.getElementById(id);
  const LS_DESC = "pearl-lend.descriptor";
  const LS_BB = "pearl-lend.blockbook";

  const S = {
    descriptor: null,
    lock: null,          // { txid, vout, value (grains string), height }
    fundTxid: null,
    repayProposal: null, // unsigned proposal built by borrower
    repayBorrowerSig: null,
    repayImported: null, // lender side
    repayLenderSig: null,
    repayFinal: null,
    mutProposal: null,
    mutFinal: null,
    claim: null,
    blockbook: "",
    armed: {},           // double-confirm broadcast arming
  };

  /* ---------- helpers ---------- */
  function showError(boxId, e) {
    const b = $(boxId);
    b.hidden = false;
    b.textContent = "Error: " + (e && e.message ? e.message : e);
  }
  function clearError(boxId) { const b = $(boxId); b.hidden = true; b.textContent = ""; }
  function grainsToPRL(g) { return P.fmtPRL(g) + " PRL"; }
  function download(name, text) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function copyText(t, btn) {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(t).then(() => {
        const old = btn.textContent; btn.textContent = "Copied";
        setTimeout(() => { btn.textContent = old; }, 1200);
      }).catch(() => {});
    }
  }
  function goStep(name) {
    document.querySelectorAll("#steps button").forEach((b) => {
      b.classList.toggle("active", b.dataset.step === name);
    });
    document.querySelectorAll("main .panel").forEach((p) => {
      p.classList.toggle("active", p.id === "step-" + name);
    });
  }
  document.querySelectorAll("#steps button").forEach((b) => {
    b.addEventListener("click", () => { if (!b.disabled) goStep(b.dataset.step); });
  });
  function enableSteps() {
    const has = !!S.descriptor;
    const set = (name, disabled) => {
      const b = $("steps").querySelector('[data-step="' + name + '"]');
      if (b) b.disabled = disabled;
    };
    set("lock", !has); set("fund", !has); set("track", !has); set("repay", !has);
  }
  function requireDescriptor() {
    if (!S.descriptor) throw new Error("draft or restore a loan offer first (step 1)");
    return S.descriptor;
  }
  function bb() {
    const v = S.blockbook.trim();
    if (!v) throw new Error("set a Blockbook base URL first");
    return v;
  }
  /** Parse a signing key (32-byte hex priv or 12/24-word mnemonic) and check it
   *  matches the expected x-only pubkey. Returns { privHex, xonlyHex }. */
  function signingKey(input, expectedXOnly, network) {
    const t = String(input || "").trim();
    if (!t) throw new Error("enter your signing key");
    let privBytes, xonlyHex;
    if (/^[0-9a-fA-F]{64}$/.test(t)) {
      privBytes = P.hexToBytes(t.toLowerCase());
      xonlyHex = P.bytesToHex(P.schnorr.getPublicKey(privBytes));
    } else {
      const w = P.walletFromMnemonic(t, network);
      privBytes = w.priv; xonlyHex = P.bytesToHex(w.internalXOnly);
    }
    if (xonlyHex.toLowerCase() !== expectedXOnly.toLowerCase()) {
      throw new Error("this key does not match the key in the loan descriptor — refusing to sign");
    }
    return { privHex: P.bytesToHex(privBytes), xonlyHex };
  }
  function wipeInput(id) { const el = $(id); if (el) el.value = ""; }
  /** Double-confirm broadcast: first click arms, second click sends. */
  async function broadcastArmed(btnId, boxId, hex, label) {
    const btn = $(btnId);
    if (!S.armed[btnId]) {
      S.armed[btnId] = true;
      const old = btn.textContent;
      btn.textContent = "Click again to broadcast " + label;
      btn.classList.add("armed");
      setTimeout(() => {
        S.armed[btnId] = false; btn.textContent = old; btn.classList.remove("armed");
      }, 15000);
      return null;
    }
    S.armed[btnId] = false;
    btn.classList.remove("armed");
    try {
      const txid = await P.broadcastTx(bb(), hex);
      clearError(boxId);
      return txid;
    } catch (e) { showError(boxId, e); return null; }
  }
  async function chainHeight() {
    const res = await fetch(bb().replace(/\/$/, "") + "/api/v2/");
    if (!res.ok) throw new Error("blockbook status " + res.status);
    const j = await res.json();
    const h = j && j.blockbook && j.blockbook.bestHeight;
    if (!Number.isInteger(h)) throw new Error("unexpected blockbook status response");
    return h;
  }

  /* ---------- step 1: offer ---------- */
  $("offer-build").addEventListener("click", () => {
    clearError("offer-error");
    try {
      const network = P.NETWORKS[$("offer-network").value];
      const aprPct = Number($("offer-apr").value);
      if (!Number.isFinite(aprPct) || aprPct < 0) throw new Error("APR must be >= 0");
      const d = P.buildDescriptor({
        network,
        borrowerXOnly: $("offer-borrowerkey").value,
        lenderXOnly: $("offer-lenderkey").value,
        borrowerPayout: $("offer-borrowerpayout").value,
        lenderPayout: $("offer-lenderpayout").value,
        principalPRL: $("offer-principal").value,
        aprBps: String(Math.round(aprPct * 100)),
        termBlocks: $("offer-term").value,
        graceBlocks: $("offer-grace").value,
        ratioBps: String(Math.round(Number($("offer-ratio").value) * 100)),
        collateralPRL: $("offer-collateral").value,
        note: $("offer-note").value,
      });
      S.descriptor = d;
      try { localStorage.setItem(LS_DESC, JSON.stringify(d)); } catch {}
      renderOffer(d);
      enableSteps();
    } catch (e) { showError("offer-error", e); }
  });

  function renderOffer(d) {
    $("offer-result").hidden = false;
    $("offer-address").textContent = d.vaultAddress;
    $("offer-fp").textContent = d.fingerprint;
    $("offer-interest").textContent = grainsToPRL(d.interestGrains) + " (floor-rounded, disclosed)";
    $("offer-repayment").textContent = grainsToPRL(d.repaymentGrains);
    $("offer-mincol").textContent = grainsToPRL(P.minCollateralGrains(BigInt(d.principalGrains), BigInt(d.aprBps), BigInt(d.termBlocks), BigInt(d.ratioBps)).toString());
    const days = P.termDays(Number(BigInt(d.termBlocks)));
    $("offer-termdays").textContent = d.termBlocks + " blocks (≈ " + days + " days at 194 s/block)";
    $("offer-delay").textContent = d.delayBlocks + " blocks (term + grace)";
    const loan = P.deriveLoan({
      network: P.NETWORKS[d.network],
      borrowerXOnly: d.borrowerXOnly, lenderXOnly: d.lenderXOnly,
      termBlocks: Number(BigInt(d.termBlocks)), graceBlocks: Number(BigInt(d.graceBlocks)),
    });
    $("offer-repayscript").textContent = P.scriptAsm(loan.repayScript);
    $("offer-defaultscript").textContent = P.scriptAsm(loan.defaultScript);
    $("offer-descriptor").textContent = JSON.stringify(d, null, 2);
    // prefill downstream fields
    $("lock-value").value = P.fmtPRL(d.collateralGrains);
    $("repay-value").value = P.fmtPRL(d.collateralGrains);
    $("close-value").value = P.fmtPRL(d.collateralGrains);
    $("close-mvalue").value = P.fmtPRL(d.collateralGrains);
    $("fund-principal-show").textContent = grainsToPRL(d.principalGrains);
    $("fund-borrowerpayout-show").textContent = d.borrowerPayout;
  }

  $("offer-copydesc").addEventListener("click", (e) => copyText($("offer-descriptor").textContent, e.target));
  $("offer-dl").addEventListener("click", () => download("pearl-lend-descriptor.json", $("offer-descriptor").textContent));
  $("offer-restore").addEventListener("click", () => { $("offer-restorebox").hidden = !$("offer-restorebox").hidden; });
  $("offer-dorestore").addEventListener("click", () => {
    clearError("offer-restoreerror");
    try {
      const d = JSON.parse($("offer-restorejson").value);
      const vr = P.verifyDescriptor(d);
      if (!vr.ok) throw new Error("descriptor invalid: " + vr.errors.join("; "));
      S.descriptor = d;
      try { localStorage.setItem(LS_DESC, JSON.stringify(d)); } catch {}
      renderOffer(d);
      enableSteps();
      $("offer-restorebox").hidden = true;
    } catch (e) { showError("offer-restoreerror", e); }
  });

  /* ---------- step 2: lock ---------- */
  async function recordLock(txid, vout, valueGrains, height, confs, checked) {
    S.lock = { txid: txid.toLowerCase(), vout, value: valueGrains.toString(), height };
    $("lock-result").hidden = false;
    $("lock-address").textContent = S.descriptor.vaultAddress;
    $("lock-amount").textContent = grainsToPRL(S.lock.value) + (checked ? " — confirmed on-chain" : " — recorded manually, NOT verified");
    $("lock-confs").textContent = confs == null ? "unknown (manual)" : String(confs);
    $("lock-height").textContent = height == null ? "unknown (manual)" : String(height);
    const term = Number(BigInt(S.descriptor.termBlocks));
    $("lock-maturity").textContent = height == null ? "unknown until lock is verified" : String(height + term) + " (default sweep after +" + S.descriptor.delayBlocks + ")";
    $("repay-txid").value = S.lock.txid;
    $("repay-vout").value = String(S.lock.vout);
    $("close-txid").value = S.lock.txid;
    $("close-vout").value = String(S.lock.vout);
    $("close-mtxid").value = S.lock.txid;
    $("close-mvout").value = String(S.lock.vout);
    enableSteps();
  }

  $("lock-scan").addEventListener("click", async () => {
    clearError("lock-error");
    try {
      const d = requireDescriptor();
      const txid = $("lock-txid").value.trim().toLowerCase();
      const vout = Number($("lock-vout").value);
      const tx = await P.fetchTxStatus(bb(), txid);
      const out = (tx.vout || [])[vout];
      if (!out) throw new Error("vout " + vout + " not found in tx");
      const hex = (out.scriptPubKey && out.scriptPubKey.hex || "").toLowerCase();
      if (hex !== d.vaultSpk.toLowerCase()) {
        throw new Error("that output does not pay the vault script — expected the collateral vault, found something else");
      }
      const value = BigInt(out.value);
      if (value.toString() !== d.collateralGrains) {
        throw new Error("locked value " + P.fmtPRL(value) + " PRL does not match the offer collateral " + P.fmtPRL(d.collateralGrains) + " PRL");
      }
      await recordLock(txid, vout, value, tx.blockHeight ?? null, tx.confirmations ?? 0, true);
    } catch (e) { showError("lock-error", e); }
  });

  $("lock-manualgo").addEventListener("click", async () => {
    clearError("lock-error");
    try {
      const d = requireDescriptor();
      const txid = $("lock-txid").value.trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(txid)) throw new Error("bad lock txid");
      const vout = Number($("lock-vout").value);
      const value = BigInt(P.parsePRL($("lock-value").value || "0"));
      if (value.toString() !== d.collateralGrains) {
        throw new Error("recorded value must equal the offer collateral (" + P.fmtPRL(d.collateralGrains) + " PRL)");
      }
      await recordLock(txid, vout, value, null, null, false);
    } catch (e) { showError("lock-error", e); }
  });

  /* ---------- step 3: fund ---------- */
  $("fund-build").addEventListener("click", () => {
    clearError("fund-error");
    try {
      const d = requireDescriptor();
      const network = P.NETWORKS[d.network];
      const utxos = JSON.parse($("fund-utxos").value);
      if (!Array.isArray(utxos) || !utxos.length) throw new Error("paste at least one UTXO");
      const p = P.buildFundingPayment(network, utxos, d.borrowerPayout, d.principalGrains,
        Number($("fund-feerate").value), $("fund-changeaddr").value.trim());
      $("fund-hexbox").hidden = false;
      $("fund-hex").textContent = p.hex;
      $("fund-fee").textContent = grainsToPRL(p.feeGrains);
      $("fund-change").textContent = grainsToPRL(p.changeGrains);
      S.fundUnsigned = p;
    } catch (e) { showError("fund-error", e); }
  });

  $("fund-record").addEventListener("click", () => {
    clearError("fund-error");
    try {
      requireDescriptor();
      const txid = $("fund-txid").value.trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(txid)) throw new Error("bad funding txid");
      S.fundTxid = txid;
      $("fund-result").hidden = false;
      enableSteps();
    } catch (e) { showError("fund-error", e); }
  });

  /* ---------- step 4: track ---------- */
  $("track-refresh").addEventListener("click", async () => {
    clearError("track-error");
    try {
      const d = requireDescriptor();
      if (!S.lock) throw new Error("record the collateral lock first (step 2)");
      const height = await chainHeight();
      const utxos = await P.fetchUtxos(bb(), d.vaultAddress);
      const mine = utxos.find((u) => u.txid === S.lock.txid && u.vout === S.lock.vout);
      $("track-result").hidden = false;
      $("track-height").textContent = String(height);
      $("track-vault").textContent = mine
        ? "FUNDED — " + grainsToPRL(mine.value) + " sitting in the vault (" + mine.confirmations + " confs on the UTXO)"
        : "EMPTY or SPENT — the vault output is gone (repaid, claimed, or never funded)";
      if (S.lock.height != null) {
        const maturity = S.lock.height + Number(BigInt(d.termBlocks));
        const defAt = S.lock.height + Number(BigInt(d.delayBlocks));
        const toMat = maturity - height;
        const toDef = defAt - height;
        $("track-remaining").textContent = toMat > 0 ? toMat + " blocks (≈ " + Math.round(toMat * 194 / 3600) + "h)" : "MATURE — repayment is due";
        $("track-todefault").textContent = toDef > 0 ? toDef + " blocks (≈ " + Math.round(toDef * 194 / 3600) + "h)" : "DEFAULT WINDOW OPEN — the lender may sweep";
      } else {
        $("track-remaining").textContent = "unknown — verify the lock on-chain (step 2)";
        $("track-todefault").textContent = "unknown — verify the lock on-chain (step 2)";
      }
      $("track-interest").textContent = grainsToPRL(d.interestGrains) + " (fixed at origination)";
      const cov = mine && BigInt(mine.value) >= BigInt(d.repaymentGrains);
      $("track-coverage").textContent = mine
        ? (cov ? "WHOLE — vault covers the full repayment " + grainsToPRL(d.repaymentGrains)
               : "BROKEN — vault holds less than the repayment; do not lend against this")
        : "n/a";
    } catch (e) { showError("track-error", e); }
  });

  /* ---------- step 5: repay ---------- */
  $("repay-build").addEventListener("click", () => {
    clearError("repay-error");
    try {
      const d = requireDescriptor();
      const p = P.buildRepayment(d, $("repay-txid").value.trim(), Number($("repay-vout").value),
        BigInt(P.parsePRL($("repay-value").value || "0")), Number($("repay-feerate").value));
      S.repayProposal = p; S.repayBorrowerSig = null;
      $("repay-proposalbox").hidden = false;
      $("repay-lenderbox").hidden = false;
      $("repay-borrowersigbox").hidden = true;
      $("repay-finalbox").hidden = true;
      $("repay-lendergets").textContent = grainsToPRL(p.outputs[0].value);
      $("repay-change").textContent = p.outputs.length > 1 ? grainsToPRL(p.outputs[1].value) : "none — dust folded into the fee (disclosed)";
      $("repay-fee").textContent = grainsToPRL(p.feeGrains) + (p.dustFolded ? " (includes dust remainder)" : "");
      $("repay-digest").textContent = p.digest;
      $("repay-proposal").textContent = JSON.stringify({ kind: "repay", descriptor: d, proposal: { input: p.input, outputs: p.outputs, feeGrains: p.feeGrains, vbytes: p.vbytes, digest: p.digest } }, null, 2);
    } catch (e) { showError("repay-error", e); }
  });

  $("repay-export").addEventListener("click", (e) => copyText($("repay-proposal").textContent, e.target));

  function repayPackage() {
    return JSON.stringify({
      kind: "repay",
      descriptor: S.descriptor,
      proposal: { input: S.repayProposal.input, outputs: S.repayProposal.outputs, feeGrains: S.repayProposal.feeGrains, vbytes: S.repayProposal.vbytes, digest: S.repayProposal.digest, feeRateGrainsPerVByte: S.repayProposal.feeRateGrainsPerVByte },
      borrowerSig: S.repayBorrowerSig,
    }, null, 2);
  }

  $("repay-sign").addEventListener("click", () => {
    clearError("repay-error");
    try {
      const d = requireDescriptor();
      if (!S.repayProposal) throw new Error("build the repayment proposal first");
      const network = P.NETWORKS[d.network];
      const k = signingKey($("repay-signkey").value, d.borrowerXOnly, network);
      const sig = P.signRepaymentDigest(k.privHex, S.repayProposal.digest);
      if (!P.verifySchnorrSig(P.hexToBytes(sig), P.hexToBytes(S.repayProposal.digest), P.hexToBytes(d.borrowerXOnly))) {
        throw new Error("self-verification failed — signature does not match the digest");
      }
      S.repayBorrowerSig = sig;
      $("repay-borrowersigbox").hidden = false;
      $("repay-borrowersig").textContent = sig;
      wipeInput("repay-signkey");
    } catch (e) { showError("repay-error", e); }
  });

  $("repay-export2").addEventListener("click", (e) => {
    if (!S.repayBorrowerSig) { showError("repay-error", new Error("sign as borrower first")); return; }
    copyText(repayPackage(), e.target);
  });

  $("repay-doimport").addEventListener("click", () => {
    clearError("repay-error");
    try {
      const d = requireDescriptor();
      const pkg = JSON.parse($("repay-import").value);
      if (!pkg || pkg.kind !== "repay" || !pkg.descriptor || !pkg.proposal || !pkg.borrowerSig) {
        throw new Error("not a signed repay proposal package");
      }
      const vd = P.verifyDescriptor(pkg.descriptor);
      if (!vd.ok) throw new Error("proposal descriptor invalid: " + vd.errors.join("; "));
      if (pkg.descriptor.fingerprint !== d.fingerprint) {
        throw new Error("proposal is for a DIFFERENT loan (fingerprint mismatch) — refusing");
      }
      // Re-derive the proposal from the descriptor with the package's own fee rate:
      // the digest must recompute byte-identically, or the proposal was altered.
      const rebuilt = P.buildRepayment(d, pkg.proposal.input.txid, pkg.proposal.input.vout,
        BigInt(pkg.proposal.input.value), Number(pkg.proposal.feeRateGrainsPerVByte));
      if (rebuilt.digest !== pkg.proposal.digest) {
        throw new Error("LEND REFUSED: proposal digest does not re-derive from the descriptor — refusing to co-sign");
      }
      const digest = pkg.proposal.digest;
      if (!/^[0-9a-f]{128}$/i.test(pkg.borrowerSig)) throw new Error("borrower signature malformed");
      if (!P.verifySchnorrSig(P.hexToBytes(pkg.borrowerSig), P.hexToBytes(digest), P.hexToBytes(d.borrowerXOnly))) {
        throw new Error("LEND REFUSED: borrower signature invalid for this proposal — refusing to co-sign");
      }
      S.repayImported = pkg;
      $("repay-importresult").hidden = false;
      $("repay-finalbox").hidden = true;
      $("repay-importsig").textContent = "VALID — " + pkg.borrowerSig.slice(0, 24) + "…";
      $("repay-importgets").textContent = grainsToPRL(pkg.proposal.outputs[0].value) + " to " + pkg.proposal.outputs[0].address;
    } catch (e) { showError("repay-error", e); }
  });

  $("repay-lendersign").addEventListener("click", () => {
    clearError("repay-error");
    try {
      const d = requireDescriptor();
      if (!S.repayImported) throw new Error("import and verify the borrower's proposal first");
      const network = P.NETWORKS[d.network];
      const k = signingKey($("repay-lendersignkey").value, d.lenderXOnly, network);
      const sig = P.signRepaymentDigest(k.privHex, S.repayImported.proposal.digest);
      if (!P.verifySchnorrSig(P.hexToBytes(sig), P.hexToBytes(S.repayImported.proposal.digest), P.hexToBytes(d.lenderXOnly))) {
        throw new Error("self-verification failed — lender signature does not match the digest");
      }
      S.repayLenderSig = sig;
      wipeInput("repay-lendersignkey");
      $("repay-importsig").textContent += " · co-signed, ready to assemble";
    } catch (e) { showError("repay-error", e); }
  });

  $("repay-assemble").addEventListener("click", () => {
    clearError("repay-error");
    try {
      const d = requireDescriptor();
      let proposal, borrowerSig;
      if (S.repayProposal && S.repayBorrowerSig && S.repayLenderSig) {
        // single-machine flow: borrower built + signed here, lender co-signed here
        proposal = S.repayProposal; borrowerSig = S.repayBorrowerSig;
      } else if (S.repayImported && S.repayLenderSig) {
        // two-machine flow: proposal imported from the borrower
        proposal = S.repayImported.proposal; borrowerSig = S.repayImported.borrowerSig;
      } else throw new Error("nothing to assemble — build/sign or import/co-sign a proposal first");
      const tx = P.assembleRepayment(d, proposal, borrowerSig, S.repayLenderSig);
      S.repayFinal = tx;
      $("repay-finalbox").hidden = false;
      $("repay-hex").textContent = tx.hex;
      $("repay-finaltxid").textContent = tx.txid;
    } catch (e) { showError("repay-error", e); }
  });

  $("repay-broadcast").addEventListener("click", async () => {
    if (!S.repayFinal) { showError("repay-error", new Error("assemble the repayment first")); return; }
    const txid = await broadcastArmed("repay-broadcast", "repay-error", S.repayFinal.hex, "repayment");
    if (txid) {
      $("repay-finalbox").insertAdjacentHTML("beforeend",
        '<p class="ok">Repayment broadcast: <code class="addr">' + txid + "</code></p>");
    }
  });

  /* ---------- step 6: close ---------- */
  $("close-buildclaim").addEventListener("click", async () => {
    clearError("close-error");
    try {
      const d = requireDescriptor();
      const network = P.NETWORKS[d.network];
      // maturity guard (before demanding the key)
      if (S.lock && S.lock.height != null && !$("close-override").checked) {
        try {
          const height = await chainHeight();
          const defAt = S.lock.height + Number(BigInt(d.delayBlocks));
          if (height < defAt) {
            throw new Error("loan not mature: default sweep opens at height " + defAt + ", chain is at " + height +
              " (" + (defAt - height) + " blocks to go). Tick the override to build anyway.");
          }
        } catch (e) {
          if (/not mature/.test(e.message)) throw e;
          throw new Error("could not check maturity: " + e.message);
        }
      }
      const k = signingKey($("close-key").value, d.lenderXOnly, network);
      const claim = P.buildDefaultClaim(d, $("close-txid").value.trim(), Number($("close-vout").value),
        BigInt(P.parsePRL($("close-value").value || "0")), Number($("close-feerate").value), k.privHex);
      S.claim = claim;
      wipeInput("close-key");
      $("close-claimbox").hidden = false;
      $("close-claimgets").textContent = grainsToPRL(claim.paysLenderGrains);
      $("close-claimfee").textContent = grainsToPRL(claim.feeGrains);
      $("close-claimtxid").textContent = claim.txid;
      $("close-claimhex").textContent = claim.hex;
    } catch (e) { showError("close-error", e); }
  });

  $("close-broadcast").addEventListener("click", async () => {
    if (!S.claim) { showError("close-error", new Error("build the default claim first")); return; }
    const txid = await broadcastArmed("close-broadcast", "close-error", S.claim.hex, "default claim");
    if (txid) {
      $("close-claimbox").insertAdjacentHTML("beforeend",
        '<p class="ok">Default claim broadcast: <code class="addr">' + txid + "</code></p>");
    }
  });

  $("close-mutbuild").addEventListener("click", () => {
    clearError("close-muterror");
    try {
      const d = requireDescriptor();
      const splits = JSON.parse($("close-splits").value);
      if (!Array.isArray(splits) || !splits.length) throw new Error("enter at least one split");
      const m = P.buildMutualClose(d, $("close-mtxid").value.trim(), Number($("close-mvout").value),
        BigInt(P.parsePRL($("close-mvalue").value || "0")),
        splits.map((s) => ({ address: s.address, valueGrains: BigInt(P.parsePRL(String(s.valuePRL))).toString() })),
        Number($("close-mfeerate").value));
      S.mutProposal = m;
      $("close-mutbox").hidden = false;
      $("close-muthexbox").hidden = true;
      $("close-mutfee").textContent = grainsToPRL(m.feeGrains);
      $("close-mutdigest").textContent = m.digest;
    } catch (e) { showError("close-muterror", e); }
  });

  $("close-mutassemble").addEventListener("click", () => {
    clearError("close-muterror");
    try {
      const d = requireDescriptor();
      if (!S.mutProposal) throw new Error("build the mutual close first");
      const network = P.NETWORKS[d.network];
      const kb = signingKey($("close-mutbkey").value, d.borrowerXOnly, network);
      const kl = signingKey($("close-mutlkey").value, d.lenderXOnly, network);
      const bSig = P.signRepaymentDigest(kb.privHex, S.mutProposal.digest);
      const lSig = P.signRepaymentDigest(kl.privHex, S.mutProposal.digest);
      wipeInput("close-mutbkey"); wipeInput("close-mutlkey");
      const tx = P.assembleMutualClose(d, S.mutProposal, bSig, lSig);
      S.mutFinal = tx;
      $("close-muthexbox").hidden = false;
      $("close-muthex").textContent = tx.hex;
    } catch (e) { showError("close-muterror", e); }
  });

  $("close-mutbroadcast").addEventListener("click", async () => {
    if (!S.mutFinal) { showError("close-muterror", new Error("assemble the mutual close first")); return; }
    const txid = await broadcastArmed("close-mutbroadcast", "close-muterror", S.mutFinal.hex, "mutual close");
    if (txid) {
      $("close-muthexbox").insertAdjacentHTML("beforeend",
        '<p class="ok">Mutual close broadcast: <code class="addr">' + txid + "</code></p>");
    }
  });

  /* ---------- standalone verifier ---------- */
  $("verify-desc").addEventListener("click", () => {
    const vEl = $("verify-verdict"), dEl = $("verify-details");
    vEl.hidden = true; dEl.hidden = true;
    try {
      const d = JSON.parse($("verify-descriptor").value);
      const hex = $("verify-hex").value.trim().toLowerCase();
      if (!/^[0-9a-f]+$/.test(hex)) throw new Error("signed tx must be hex");
      const prevouts = JSON.parse($("verify-prevouts").value || "[]");
      const r = P.verifyLoanTx(d, hex, prevouts);
      vEl.hidden = false;
      vEl.textContent = r.verdict === "PROVEN" ? "PROVEN" : "NOT PROVEN";
      vEl.className = "verdict " + (r.verdict === "PROVEN" ? "proven" : "notproven");
      dEl.hidden = false;
      dEl.textContent = r.details.join("\n");
    } catch (e) {
      vEl.hidden = false;
      vEl.textContent = "NOT PROVEN";
      vEl.className = "verdict notproven";
      dEl.hidden = false;
      dEl.textContent = "verifier error: " + (e.message || e);
    }
  });

  /* ---------- test hook (used by tests/dom.test.mjs; harmless in production) ---------- */
  window.__lendTest = {
    state: () => S,
    err: (id) => { const e = $(id); return { hidden: e.hidden, text: e.textContent }; },
    click: (id) => $(id).click(),
    set: (id, v) => { $(id).value = v; },
    text: (id) => $(id).textContent,
    renderOffer,
  };

  /* ---------- init ---------- */
  (function init() {
    try { S.blockbook = localStorage.getItem(LS_BB) || P.NETWORKS.mainnet.blockbook || ""; } catch {}
    for (const id of ["lock-blockbook", "track-blockbook", "close-blockbook"]) {
      if ($(id)) $(id).value = S.blockbook;
    }
    try {
      const raw = localStorage.getItem(LS_DESC);
      if (raw) {
        const d = JSON.parse(raw);
        if (P.verifyDescriptor(d).ok) {
          S.descriptor = d;
          renderOffer(d);
        }
      }
    } catch { /* start clean */ }
    enableSteps();
    for (const id of ["lock-blockbook", "track-blockbook", "close-blockbook"]) {
      const el = $(id);
      if (el) el.addEventListener("change", () => {
        S.blockbook = el.value;
        try { localStorage.setItem(LS_BB, el.value); } catch {}
        for (const id2 of ["lock-blockbook", "track-blockbook", "close-blockbook"]) {
          if ($(id2) && id2 !== id) $(id2).value = el.value;
        }
      });
    }
  })();
})();
