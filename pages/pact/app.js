/* Pearl Pact app — drives the committed pearl-pact.bundle.js (window.PearlPact).
 * Five steps: Draft -> Fund -> Seal -> Execute -> Refund. Keys live in page
 * memory only; the page never broadcasts without an explicit double-confirm. */
(function () {
  "use strict";
  const P = window.PearlPact;
  if (!P || P.version !== 1) {
    document.body.insertAdjacentHTML("afterbegin",
      '<div style="padding:2rem;color:#ff5d5d">Pearl Pact failed to load its crypto bundle.</div>');
    return;
  }
  const $ = (s) => document.querySelector(s);
  let demoKeys = null; // filled by the demo minter; wiped by #wipe-keys

  /* ---------- step tabs ---------- */
  const STEP_IDS = ["draft", "fund", "seal", "execute", "refund"];
  document.querySelectorAll("#steps button").forEach((b) => {
    b.addEventListener("click", () => {
      document.querySelectorAll("#steps button").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
      $("#step-" + b.dataset.step).classList.add("active");
      history.replaceState(null, "", "#" + b.dataset.step);
    });
  });
  const initial = (location.hash || "").replace("#", "");
  if (STEP_IDS.includes(initial)) document.querySelector(`#steps button[data-step="${initial}"]`).click();

  /* ---------- helpers ---------- */
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
  $("#wipe-keys").addEventListener("click", () => {
    ["#d-akey", "#d-bkey", "#f-apriv", "#f-bpriv", "#s-apriv", "#s-bpriv",
     "#r-apriv", "#r-bpriv", "#x-oraclepriv", "#x-t"].forEach((s) => { $(s).value = ""; });
    demoKeys = null;
    alert("Key fields cleared. (Terms, descriptors and bundles contain no private keys.)");
  });
  function showError(sel, msg) {
    const box = $(sel);
    box.hidden = false;
    box.textContent = String(msg).replace(/^PACT REFUSED: /, "Refused: ");
  }
  function hideError(sel) { $(sel).hidden = true; }
  function verdictBox(sel, verdict, lines) {
    const box = $(sel);
    box.hidden = false;
    box.classList.toggle("proven", verdict === "PROVEN");
    box.classList.toggle("unproven", verdict !== "PROVEN");
    box.innerHTML = "";
    const v = document.createElement("p");
    v.className = "verdict";
    v.textContent = verdict;
    box.appendChild(v);
    if (lines && lines.length) {
      const ul = document.createElement("ul");
      for (const l of lines) {
        const li = document.createElement("li");
        li.textContent = l;
        ul.appendChild(li);
      }
      box.appendChild(ul);
    }
  }
  function carryTerms(exported) {
    ["#f-terms", "#s-terms", "#x-terms", "#r-terms"].forEach((s) => { if (!$(s).value) $(s).value = exported; });
  }
  function readTerms(sel) {
    const raw = $(sel).value.trim();
    if (!raw) throw new Error("PACT REFUSED: paste the pact terms JSON first (Draft step)");
    return P.importTerms(raw);
  }
  function normBlockbook(sel) {
    const t = $(sel).value.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//.test(t)) throw new Error("PACT REFUSED: Blockbook URL must start with http(s)://");
    return t;
  }
  async function doubleConfirmedBroadcast(hex, label) {
    if (!confirm(`Broadcast this ${label} to the Pearl network via Blockbook?\n\nThis moves real PRL. There is no undo.`)) return;
    if (!confirm("Final confirmation — broadcast now?")) return;
    const base = normBlockbook("#f-blockbook");
    const txid = await P.broadcastTx(base, hex);
    alert(`Broadcast accepted. txid:\n${txid}`);
  }

  /* ---------- STEP 1: DRAFT ---------- */
  $("#d-mint-oracle").addEventListener("click", () => {
    const o = P.mintOracleKey();
    $("#d-opub").value = o.pubXOnlyHex;
    alert("Fresh oracle key minted.\n\nPublic (filled in): " + o.pubXOnlyHex + "\n\nPrivate (SAVE IT — the oracle needs it to attest):\n" + o.privHex);
  });

  $("#d-demo").addEventListener("click", () => {
    hideError("#d-error");
    try {
      const demo = P.mintDemoPact($("#d-network").value);
      demoKeys = demo.keys;
      const t = demo.terms;
      $("#d-title").value = t.title;
      $("#d-aname").value = "Alice (demo)"; $("#d-akind").value = "priv"; $("#d-akey").value = demo.keys.alicePriv;
      $("#d-bname").value = "Bob (demo)"; $("#d-bkind").value = "priv"; $("#d-bkey").value = demo.keys.bobPriv;
      $("#d-colla").value = "1"; $("#d-collb").value = "1";
      $("#d-oname").value = "Demo Oracle"; $("#d-opub").value = demo.keys.oraclePub;
      $("#d-event").value = demo.eventId;
      $("#d-commits").value = t.oracle.commits.join("\n");
      $("#d-outcomes").value = t.outcomes.map((o) => `${o.label} | ${P.grainsToPRL(o.aliceGrains)} | ${P.grainsToPRL(o.bobGrains)}`).join("\n");
      $("#d-feef").value = "5"; $("#d-feec").value = "5"; $("#d-feer").value = "5";
      $("#d-lock").value = "950000";
      $("#x-oraclepriv").value = demo.keys.oraclePriv;
      renderDraftResult(t);
      alert("Demo pact minted.\n\nOracle private key (needed to attest in step 4):\n" + demo.keys.oraclePriv + "\n\nIt is also filled into the Execute step's simulator box.");
    } catch (e) { showError("#d-error", e.message || e); }
  });

  function parseOutcomeLines(text) {
    const rows = [];
    for (const line of String(text).split("\n")) {
      const t = line.trim();
      if (!t) continue;
      const parts = t.split("|").map((x) => x.trim());
      if (parts.length !== 3) throw new Error(`PACT REFUSED: outcome line "${t}" must be "label | alice PRL | bob PRL"`);
      rows.push({ label: parts[0], aliceGrains: P.prlToGrains(parts[1]), bobGrains: P.prlToGrains(parts[2]) });
    }
    return rows;
  }

  function renderDraftResult(t) {
    $("#d-descriptor").textContent = t.descriptor;
    $("#d-address").textContent = t.address;
    $("#d-script").textContent = t.script;
    $("#d-internal").textContent = t.internalXOnly;
    $("#d-cetfee").textContent = `${P.grainsToPRL(t.cetFeeGrains)} PRL (${t.cetFeeGrains} grains, ${t.cetVBytes} vB @ ${t.cetFeeRate} gr/vB) → distributable ${P.grainsToPRL(t.totalCollateral - t.cetFeeGrains)} PRL`;
    renderQR($("#d-qr"), t.address);
    const exported = P.exportTerms(t);
    $("#d-terms").value = exported;
    $("#d-result").hidden = false;
    carryTerms(exported);
  }

  $("#d-draft").addEventListener("click", () => {
    hideError("#d-error");
    $("#d-result").hidden = true;
    try {
      const commits = $("#d-commits").value.split("\n").map((x) => x.trim()).filter(Boolean);
      const t = P.buildPactTerms({
        networkId: $("#d-network").value,
        title: $("#d-title").value,
        aliceName: $("#d-aname").value, aliceKey: $("#d-akey").value, aliceKind: $("#d-akind").value,
        bobName: $("#d-bname").value, bobKey: $("#d-bkey").value, bobKind: $("#d-bkind").value,
        oracleName: $("#d-oname").value, oraclePubkey: $("#d-opub").value,
        eventId: $("#d-event").value, oracleCommits: commits,
        outcomes: parseOutcomeLines($("#d-outcomes").value),
        collateralAlice: P.prlToGrains($("#d-colla").value),
        collateralBob: P.prlToGrains($("#d-collb").value),
        fundingFeeRate: Number($("#d-feef").value),
        cetFeeRate: Number($("#d-feec").value),
        refundFeeRate: Number($("#d-feer").value),
        refundLockHeight: Number($("#d-lock").value),
      });
      renderDraftResult(t);
    } catch (e) { showError("#d-error", e.message || e); }
  });

  $("#d-verify").addEventListener("click", () => {
    const r = P.verifyPactDescriptor($("#d-verify-in").value);
    verdictBox("#d-verify-result", r.verdict, r.reasons);
  });

  /* ---------- STEP 2: FUND ---------- */
  let fundPlan = null, fundTerms = null;
  $("#f-plan").addEventListener("click", () => {
    hideError("#f-error");
    $("#f-result").hidden = true;
    $("#f-signed-wrap").hidden = true;
    try {
      fundTerms = readTerms("#f-terms");
      fundPlan = P.planFundingTx({
        networkId: fundTerms.networkId,
        terms: fundTerms,
        aliceUtxoText: $("#f-autxo").value,
        bobUtxoText: $("#f-butxo").value,
        fundingFeeRate: Number($("#f-fee").value),
      });
      $("#f-txid").textContent = fundPlan.txid;
      $("#f-feeinfo").textContent = `${fundPlan.vBytes} vB · ${P.grainsToPRL(fundPlan.feeGrains)} PRL (${fundPlan.feeGrains} grains) @ ${fundPlan.feeRate} gr/vB` +
        (fundPlan.absorbedDust ? ` · ${fundPlan.absorbedDust} grains dust absorbed into fee` : "");
      $("#f-outputs").textContent = fundPlan.outputs.map((o) => `${P.grainsToPRL(o.value)} PRL → ${o.label}`).join(" · ");
      $("#f-hex").value = fundPlan.unsignedHex;
      $("#f-vout-note").textContent = String(fundPlan.fundingVout);
      $("#f-result").hidden = false;
      if (!$("#s-ftxid").value) $("#s-ftxid").value = fundPlan.txid;
      if (!$("#r-ftxid").value) $("#r-ftxid").value = fundPlan.txid;
    } catch (e) { showError("#f-error", e.message || e); }
  });

  $("#f-sign").addEventListener("click", () => {
    hideError("#f-sign-error");
    $("#f-signed-wrap").hidden = true;
    try {
      if (!fundPlan || !fundTerms) throw new Error("PACT REFUSED: plan the funding tx first");
      const signed = P.signFundingTx({
        networkId: fundTerms.networkId, plan: fundPlan, terms: fundTerms,
        alicePrivHex: $("#f-apriv").value.trim() || null,
        bobPrivHex: $("#f-bpriv").value.trim() || null,
      });
      $("#f-signed").value = signed.hex;
      $("#f-signed-wrap").hidden = false;
      $("#f-apriv").value = ""; $("#f-bpriv").value = "";
    } catch (e) { showError("#f-sign-error", e.message || e); }
  });

  $("#f-broadcast").addEventListener("click", async () => {
    try { await doubleConfirmedBroadcast($("#f-signed").value.trim(), "funding transaction"); }
    catch (e) { showError("#f-sign-error", e.message || e); }
  });

  $("#f-balance").addEventListener("click", async () => {
    const box = $("#f-balance-result");
    box.hidden = false;
    box.classList.remove("proven", "unproven");
    box.innerHTML = '<p class="hint">Querying Blockbook (GET-only)…</p>';
    try {
      const terms = readTerms("#f-terms");
      const base = normBlockbook("#f-blockbook");
      const utxos = await P.fetchUtxos(base, terms.address);
      const total = utxos.reduce((n, u) => n + Number(u.value || u.satoshis || 0), 0);
      verdictBox("#f-balance-result",
        total >= terms.totalCollateral ? "PROVEN" : "NOT PROVEN",
        [`Funding address balance: ${P.grainsToPRL(total)} PRL across ${utxos.length} UTXO(s).`,
         `Required: ${P.grainsToPRL(terms.totalCollateral)} PRL total collateral.`]);
    } catch (e) {
      verdictBox("#f-balance-result", "NOT PROVEN", ["Balance lookup failed: " + String(e.message || e)]);
    }
  });

  /* ---------- STEP 3: SEAL ---------- */
  let sealCets = null, sealTerms = null;
  $("#s-build").addEventListener("click", () => {
    hideError("#s-error");
    $("#s-result").hidden = true;
    $("#s-sealed-wrap").hidden = true;
    try {
      sealTerms = readTerms("#s-terms");
      sealCets = P.buildCets({
        networkId: sealTerms.networkId, terms: sealTerms,
        fundingTxid: $("#s-ftxid").value.trim(), fundingVout: Number($("#s-fvout").value),
      });
      const host = $("#s-cets");
      host.innerHTML = "";
      const tbl = document.createElement("table");
      tbl.className = "grid";
      tbl.innerHTML = "<tr><th>#</th><th>Outcome</th><th>Alice gets</th><th>Bob gets</th><th>Fee</th><th>CET txid</th></tr>";
      for (const c of sealCets.cets) {
        const tr = document.createElement("tr");
        tr.innerHTML = `<td>${c.index}</td><td></td><td>${P.grainsToPRL(c.aliceGrains)} PRL</td>` +
          `<td>${P.grainsToPRL(c.bobGrains)} PRL</td><td>${c.feeGrains} gr</td><td><code>${c.txid}</code></td>`;
        tr.children[1].textContent = c.label;
        tbl.appendChild(tr);
      }
      host.appendChild(tbl);
      const note = document.createElement("p");
      note.className = "hint";
      note.textContent = "CET txids are final already — signatures don't affect txids. Digests are per-outcome sighash commitments.";
      host.appendChild(note);
      $("#s-result").hidden = false;
    } catch (e) { showError("#s-error", e.message || e); }
  });

  $("#s-seal").addEventListener("click", () => {
    hideError("#s-seal-error");
    $("#s-sealed-wrap").hidden = true;
    try {
      if (!sealCets || !sealTerms) throw new Error("PACT REFUSED: build the CETs first");
      const sealed = P.sealPact({
        networkId: sealTerms.networkId, terms: sealTerms, cets: sealCets,
        alicePrivHex: $("#s-apriv").value.trim(),
        bobPrivHex: $("#s-bpriv").value.trim(),
      });
      const host = $("#s-seal-table");
      host.innerHTML = "";
      const tbl = document.createElement("table");
      tbl.className = "grid";
      tbl.innerHTML = "<tr><th>Outcome</th><th>Alice encrypted sig</th><th>Bob encrypted sig</th></tr>";
      for (const o of sealed.outcomes) {
        const okA = P.adaptorVerify(o.alice.RprimeX, o.alice.sStar, sealTerms.alice.xonly, o.digest, sealTerms.oracle.commits[o.index]);
        const okB = P.adaptorVerify(o.bob.RprimeX, o.bob.sStar, sealTerms.bob.xonly, o.digest, sealTerms.oracle.commits[o.index]);
        const tr = document.createElement("tr");
        const pill = (ok) => `<span class="pill ${ok ? "ok" : "bad"}">${ok ? "VERIFIED" : "FAILED"}</span>`;
        tr.innerHTML = `<td></td><td><code>${o.alice.RprimeX.slice(0, 16)}…${o.alice.sStar.slice(0, 16)}…</code> ${pill(okA)}</td>` +
          `<td><code>${o.bob.RprimeX.slice(0, 16)}…${o.bob.sStar.slice(0, 16)}…</code> ${pill(okB)}</td>`;
        tr.children[0].textContent = o.label;
        tbl.appendChild(tr);
      }
      host.appendChild(tbl);
      const meta = document.createElement("p");
      meta.className = "hint";
      meta.textContent = `Bundle fingerprint ${sealed.fingerprint} · descriptor ${sealed.descriptor}`;
      host.appendChild(meta);
      $("#s-bundle").value = P.exportSealed(sealed);
      $("#s-sealed-wrap").hidden = false;
      if (!$("#x-bundle").value) $("#x-bundle").value = $("#s-bundle").value;
      $("#s-apriv").value = ""; $("#s-bpriv").value = "";
    } catch (e) { showError("#s-seal-error", e.message || e); }
  });

  /* ---------- STEP 4: EXECUTE ---------- */
  $("#x-sim-oracle").addEventListener("click", () => {
    $("#x-sim-wrap").hidden = !$("#x-sim-wrap").hidden;
  });

  $("#x-execute").addEventListener("click", async () => {
    hideError("#x-error");
    $("#x-result").hidden = true;
    $("#x-hex-wrap").hidden = true;
    try {
      const terms = readTerms("#x-terms");
      const sealed = P.importSealed($("#x-bundle").value);
      let idx = Number($("#x-index").value), tHex = $("#x-t").value.trim(), sigHex = $("#x-sig").value.trim();
      const opriv = $("#x-oraclepriv").value.trim();
      if (opriv && (!tHex || !sigHex)) {
        // simulate the oracle attesting with its private key
        const att = P.oracleAttest(opriv, terms.oracle.eventId, idx);
        if (att.tHex && att.sigHex) {
          $("#x-t").value = att.tHex;
          $("#x-sig").value = att.sigHex;
          tHex = att.tHex; sigHex = att.sigHex;
        }
      }
      const ex = P.executePact({
        networkId: terms.networkId, terms, sealed,
        attestation: { outcomeIndex: idx, tHex, sigHex },
      });
      verdictBox("#x-result", "PROVEN", [
        `Oracle attestation verified: t·G matches the committed announcement point for outcome ${idx}, oracle signature valid.`,
        `Both adaptor signatures decrypted with t and re-verified as plain BIP-340 signatures.`,
        `Final CET pays ${P.grainsToPRL(ex.aliceGrains)} PRL to ${terms.alice.name} and ${P.grainsToPRL(ex.bobGrains)} PRL to ${terms.bob.name}.`,
      ]);
      $("#x-label").textContent = ex.label;
      $("#x-txid").textContent = ex.txid;
      $("#x-hex").value = ex.hex;
      $("#x-hex-wrap").hidden = false;
      $("#x-oraclepriv").value = "";
    } catch (e) { showError("#x-error", e.message || e); }
  });

  $("#x-broadcast").addEventListener("click", async () => {
    try { await doubleConfirmedBroadcast($("#x-hex").value.trim(), "CET"); }
    catch (e) { showError("#x-error", e.message || e); }
  });

  /* ---------- STEP 5: REFUND ---------- */
  let refundPlan = null, refundTerms = null;
  $("#r-build").addEventListener("click", () => {
    hideError("#r-error");
    $("#r-result").hidden = true;
    $("#r-signed-wrap").hidden = true;
    try {
      refundTerms = readTerms("#r-terms");
      refundPlan = P.buildRefundTx({
        networkId: refundTerms.networkId, terms: refundTerms,
        fundingTxid: $("#r-ftxid").value.trim(), fundingVout: Number($("#r-fvout").value),
      });
      $("#r-txid").textContent = refundPlan.txid;
      $("#r-lock").textContent = `block ${refundPlan.lockHeight} (sequence 0xfffffffe — invalid before then)`;
      $("#r-splits").textContent = `${P.grainsToPRL(refundPlan.aliceGrains)} PRL / ${P.grainsToPRL(refundPlan.bobGrains)} PRL / ${refundPlan.feeGrains} grains`;
      $("#r-digest").textContent = refundPlan.digest;
      $("#r-result").hidden = false;
    } catch (e) { showError("#r-error", e.message || e); }
  });

  $("#r-sign").addEventListener("click", () => {
    hideError("#r-sign-error");
    $("#r-signed-wrap").hidden = true;
    try {
      if (!refundPlan || !refundTerms) throw new Error("PACT REFUSED: build the refund tx first");
      const signed = P.signRefundTx({
        networkId: refundTerms.networkId, terms: refundTerms, refund: refundPlan,
        alicePrivHex: $("#r-apriv").value.trim(),
        bobPrivHex: $("#r-bpriv").value.trim(),
      });
      $("#r-signed").value = signed.hex;
      $("#r-signed-wrap").hidden = false;
      $("#r-apriv").value = ""; $("#r-bpriv").value = "";
    } catch (e) { showError("#r-sign-error", e.message || e); }
  });
})();
