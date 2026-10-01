/* Pearl Payjoin page logic — classic script, talks to window.PearlPayjoin.
 * Keys and mnemonics live in memory only; nothing is persisted anywhere.
 * Every localStorage access is wrapped in try/catch (none are needed here —
 * state is kept in the PJ object and deep-linked tabs use location.hash). */
(function () {
  "use strict";
  const PJ = window.PearlPayjoin;
  const $ = (id) => document.getElementById(id);
  const state = { offer: null, original: null, proposal: null, signed: null };

  function errText(e) {
    const m = String((e && e.message) || e);
    return m.startsWith("REFUSED") ? m : "Error: " + m;
  }
  function showErr(id, e) {
    const el = $(id);
    el.textContent = errText(e);
    el.hidden = false;
  }
  function hideErr(id) { $(id).hidden = true; }
  function kv(el, rows) {
    el.innerHTML = rows.map(([k, v]) => `<div class="row"><span class="k"></span><span class="v"></span></div>`)
      .join("");
    const divs = el.querySelectorAll(".row");
    rows.forEach(([k, v], i) => {
      divs[i].querySelector(".k").textContent = k;
      divs[i].querySelector(".v").textContent = String(v);
    });
    el.hidden = false;
  }
  function grainsStr(n) { return n.toString() + " grains (" + PJ.grainsToPRL(BigInt(n)) + " PRL)"; }

  /* ---------- tabs + deep links ---------- */
  const tabs = [...document.querySelectorAll('.pj-tabs [role="tab"]')];
  function selectTab(name, push) {
    tabs.forEach((b) => {
      const on = b.dataset.tab === name;
      b.setAttribute("aria-selected", on ? "true" : "false");
      $("tab-" + b.dataset.tab).hidden = !on;
    });
    if (push !== false) {
      try { history.replaceState(null, "", "#" + name); } catch { /* file:// may refuse */ }
    }
  }
  tabs.forEach((b) => b.addEventListener("click", () => selectTab(b.dataset.tab)));
  const initial = (location.hash || "").replace("#", "");
  if (tabs.some((b) => b.dataset.tab === initial)) selectTab(initial, false);
  window.addEventListener("hashchange", () => {
    const h = (location.hash || "").replace("#", "");
    if (tabs.some((b) => b.dataset.tab === h)) selectTab(h, false);
  });

  /* ---------- copy buttons ---------- */
  document.addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-copy],[data-copytext]");
    if (!b) return;
    const text = b.hasAttribute("data-copytext")
      ? b.getAttribute("data-copytext")
      : $(b.getAttribute("data-copy")).value || $(b.getAttribute("data-copy")).textContent;
    navigator.clipboard.writeText(text).then(() => {
      const old = b.textContent;
      b.textContent = "Copied";
      setTimeout(() => { b.textContent = old; }, 1200);
    }).catch(() => { b.textContent = "Copy failed"; });
  });

  function wipeKeys() {
    ["s-mnemonic", "p-mnemonic", "g-mnemonic"].forEach((id) => { $(id).value = ""; });
    document.querySelectorAll(".utxo-row .meta").forEach((m) => { m.textContent = ""; });
  }
  ["s-wipe", "p-wipe", "g-wipe"].forEach((id) => $(id).addEventListener("click", wipeKeys));

  /* ---------- TAB 1 · Receiver ---------- */
  $("r-fill-lab").addEventListener("click", () => {
    // Lab-only convenience: a deterministic address from the public test
    // vector. Clearly labeled — never presented as anyone's real address.
    try {
      $("r-address").value = PJ.deriveSenderKey(
        "legal winner thank year wave sausage worth useful legal winner thank yellow", 7).address;
    } catch (e) { showErr("r-error", e); }
  });
  $("r-build").addEventListener("click", () => {
    hideErr("r-error");
    try {
      const offer = PJ.buildReceiverOffer({
        amount: $("r-amount").value,
        paymentAddress: $("r-address").value.trim(),
        maxadditionalfeecontribution: $("r-maxadd").value,
        minfeerate: $("r-minfeerate").value,
        disableoutputsubstitution: $("r-nosub").checked,
      });
      state.offer = offer;
      $("r-query").textContent = offer.query;
      $("r-envelope").value = JSON.stringify(offer.envelope, null, 2);
      $("r-psbt").value = offer.base64;
      kv($("r-summary"), [
        ["Payment", grainsStr(offer.envelope.payment.value_grains)],
        ["Pay to", offer.envelope.payment.address],
        ["Fee terms", `maxadditionalfeecontribution=${offer.envelope.params.maxadditionalfeecontribution_grains} grains · minfeerate=${offer.envelope.params.minfeerate} · substitution ${offer.envelope.params.disableoutputsubstitution ? "disabled" : "allowed"}`],
      ]);
      $("r-out").hidden = false;
    } catch (e) { showErr("r-error", e); $("r-out").hidden = true; }
  });

  /* ---------- UTXO rows (shared by Sender + Proposal tabs) ---------- */
  function makeUtxoRow(listEl, keyIdxDefault) {
    const row = document.createElement("div");
    row.className = "utxo-row";
    row.innerHTML =
      `<label>txid (64 hex)<input class="u-txid" spellcheck="false" placeholder="aa…"></label>` +
      `<label>vout<input class="u-vout" inputmode="numeric" value="0"></label>` +
      `<label>value (PRL or grains)<input class="u-value" placeholder="1 PRL"></label>` +
      `<label>key idx<input class="u-keyidx" inputmode="numeric" value="${keyIdxDefault}"></label>` +
      `<div class="meta"></div>` +
      `<button class="pj-btn small danger-ghost u-del" type="button">remove</button>`;
    row.querySelector(".u-del").addEventListener("click", () => row.remove());
    listEl.appendChild(row);
    return row;
  }
  function readUtxoRows(listEl, mnemonic, kind) {
    const rows = [...listEl.querySelectorAll(".utxo-row")];
    if (!rows.length) throw new Error(`REFUSED [no-inputs]: add at least one ${kind} UTXO`);
    if (!mnemonic) throw new Error("REFUSED [no-mnemonic]: a mnemonic is required to sign — it stays in this page only");
    return rows.map((row, i) => {
      const txid = row.querySelector(".u-txid").value.trim();
      const vout = Number(row.querySelector(".u-vout").value);
      const value = row.querySelector(".u-value").value.trim();
      const keyIdx = Number(row.querySelector(".u-keyidx").value);
      if (!/^[0-9a-fA-F]{64}$/.test(txid)) throw new Error(`REFUSED [bad-utxo]: row ${i + 1}: txid must be 64 hex chars`);
      if (!Number.isInteger(vout) || vout < 0) throw new Error(`REFUSED [bad-utxo]: row ${i + 1}: bad vout`);
      if (!Number.isInteger(keyIdx) || keyIdx < 0) throw new Error(`REFUSED [bad-utxo]: row ${i + 1}: bad key index`);
      const key = PJ.deriveSenderKey(mnemonic, keyIdx);
      row.querySelector(".meta").textContent = `key #${keyIdx} → ${key.address}`;
      return { input: PJ.prepareSenderInput({ txid, vout, value, key }), key };
    });
  }
  async function lookupUtxos(address, listEl) {
    // Live blockbook call — honestly labeled at the call site.
    const utxos = await PJ.fetchUtxos(address);
    if (!utxos.length) throw new Error("REFUSED [no-utxos]: the blockbook reports no UTXOs for " + address);
    const box = document.createElement("div");
    box.className = "pj-kv";
    box.innerHTML = utxos.slice(0, 20).map((u, i) =>
      `<div class="row"><span class="k">${u.txid.slice(0, 16)}…:${u.vout}</span>` +
      `<span class="v">${u.value} grains <button class="pj-btn small" data-use-utxo="${i}">use</button></span></div>`).join("");
    box.querySelectorAll("[data-use-utxo]").forEach((b) => b.addEventListener("click", () => {
      const u = utxos[Number(b.getAttribute("data-use-utxo"))];
      const row = makeUtxoRow(listEl, listEl.querySelectorAll(".utxo-row").length);
      row.querySelector(".u-txid").value = u.txid;
      row.querySelector(".u-vout").value = String(u.vout);
      row.querySelector(".u-value").value = u.value + " grains";
      box.remove();
    }));
    return box;
  }

  /* ---------- TAB 2 · Sender ---------- */
  $("utxo-add").addEventListener("click", () => makeUtxoRow($("utxo-list"), $("utxo-list").querySelectorAll(".utxo-row").length));
  makeUtxoRow($("utxo-list"), 0);
  $("s-validate").addEventListener("click", () => {
    hideErr("s-error");
    try {
      const dec = PJ.decodePaste($("s-offer").value);
      if (dec.kind === "bare-psbt" || dec.kind === "pearl-payjoin-offer") {
        const b64 = dec.psbtB64;
        const info = PJ.validateOfferTemplate(b64);
        state.offer = { base64: b64, envelope: dec.kind === "pearl-payjoin-offer" ? { params: dec.params, payment: dec.payment, fee: dec.fee } : null, params: dec.params };
        kv($("s-offerinfo"), [
          ["Template", "valid — 0 inputs, 1 payment output"],
          ["Payment", grainsStr(info.paymentValue)],
          ["Pay to", info.paymentAddress],
          ...(dec.params ? [["Fee terms", `maxadditionalfeecontribution=${dec.params.maxadditionalfeecontribution} grains · minfeerate=${dec.params.minfeerate.num}/${dec.params.minfeerate.den} · substitution ${dec.params.disableoutputsubstitution ? "disabled" : "allowed"}`]] : [["Fee terms", "bare PSBT pasted — paste the full envelope JSON to carry the fee terms"]]),
        ]);
        $("s-fund-card").hidden = false;
      } else {
        throw new Error("REFUSED [wrong-envelope]: this tab needs the receiver's offer, not a " + dec.kind);
      }
    } catch (e) { showErr("s-error", e); }
  });
  $("s-derive").addEventListener("click", () => {
    hideErr("s-build-error");
    try {
      const m = $("s-mnemonic").value.trim();
      if (!m) throw new Error("REFUSED [no-mnemonic]: enter a mnemonic to derive from");
      const n = Math.max(1, Math.min(25, Number($("s-scan").value) || 5));
      const rows = [];
      for (let i = 0; i < n; i++) {
        const k = PJ.deriveSenderKey(m, i);
        rows.push([`BIP-86 #${i}`, `${k.address}  —  lookup UTXOs`]);
      }
      const el = $("s-derived");
      el.innerHTML = rows.map(([k, v], i) =>
        `<div class="row"><span class="k">${k}</span><span class="v"><span class="addr">${v.split("  —  ")[0]}</span> <button class="pj-btn small" data-lookup="${i}">lookup (live)</button></span></div>`).join("");
      el.hidden = false;
      el.querySelectorAll("[data-lookup]").forEach((b) => b.addEventListener("click", async () => {
        const i = Number(b.getAttribute("data-lookup"));
        const addr = PJ.deriveSenderKey($("s-mnemonic").value.trim(), i).address;
        b.textContent = "…";
        try {
          const box = await lookupUtxos(addr, $("utxo-list"));
          el.appendChild(box);
          b.textContent = "lookup (live)";
        } catch (e) { showErr("s-build-error", e); b.textContent = "lookup (live)"; }
      }));
    } catch (e) { showErr("s-build-error", e); }
  });
  $("s-estimate").addEventListener("click", async () => {
    hideErr("s-build-error");
    try {
      const r = await PJ.fetchFeeRateGrainsPerVByte();
      $("s-feerate").value = String(r);
    } catch (e) { showErr("s-build-error", new Error("fee estimate failed (live blockbook call): " + errText(e))); }
  });
  $("s-build").addEventListener("click", () => {
    hideErr("s-build-error");
    try {
      if (!state.offer || !state.offer.params) throw new Error("REFUSED [no-offer]: validate a full offer envelope first (fee terms are required)");
      const mnemonic = $("s-mnemonic").value.trim();
      const items = readUtxoRows($("utxo-list"), mnemonic, "sender");
      const change = $("s-change").value.trim();
      const original = PJ.buildSenderOriginal({
        offerB64: state.offer.base64,
        params: state.offer.params,
        senderInputs: items.map((x) => x.input),
        tweakedPrivs: items.map((x) => x.key.tweakedPriv),
        changeAddress: change,
        feeRate: $("s-feerate").value,
      });
      state.original = original;
      $("s-envelope").value = JSON.stringify(original.envelope, null, 2);
      $("s-psbt").value = original.base64;
      kv($("s-summary"), [
        ["Inputs", `${original.nIn} (all signed + finalized, SIGHASH_DEFAULT)`],
        ["Payment", grainsStr(original.paymentValue)],
        ["Change", original.changeValue ? grainsStr(original.changeValue) : "none"],
        ["Fee", `${original.fee} grains @ ${(Number(original.fee) / original.vsize).toFixed(2)} grains/vB (${original.vsize} vB)`],
      ]);
      $("s-out").hidden = false;
    } catch (e) { showErr("s-build-error", e); }
  });
  $("s-to-proposal").addEventListener("click", () => {
    if (state.original) $("p-original").value = JSON.stringify(state.original.envelope);
    selectTab("proposal");
  });

  /* ---------- TAB 3 · Proposal ---------- */
  $("putxo-add").addEventListener("click", () => makeUtxoRow($("putxo-list"), $("putxo-list").querySelectorAll(".utxo-row").length));
  makeUtxoRow($("putxo-list"), 0);
  $("p-load").addEventListener("click", () => {
    hideErr("p-error");
    try {
      const dec = PJ.decodePaste($("p-original").value);
      if (dec.kind !== "pearl-payjoin-original") throw new Error("REFUSED [wrong-envelope]: this tab needs the sender's signed original, not " + dec.kind);
      const info = PJ.validateFundedOriginal(dec.psbtB64); // re-verifies sender sigs
      state.original = { base64: dec.psbtB64, envelope: { params: dec.params, payment: dec.payment, fee: dec.fee }, fee: info.fee };
      kv($("p-originfo"), [
        ["Original", `valid — ${info.nIn} input(s), ${info.nOut} output(s), every sender signature re-verified`],
        ["Fee", `${info.fee} grains @ ${info.feeRate.toFixed(2)} grains/vB`],
        ["Fee terms", `maxadditionalfeecontribution=${dec.params.maxadditionalfeecontribution} grains · minfeerate=${dec.params.minfeerate.num}/${dec.params.minfeerate.den} · substitution ${dec.params.disableoutputsubstitution ? "disabled" : "allowed"}`],
      ]);
      $("p-build-card").hidden = false;
    } catch (e) { showErr("p-error", e); }
  });
  $("p-build").addEventListener("click", () => {
    hideErr("p-build-error");
    try {
      if (!state.original) throw new Error("REFUSED [no-original]: load the sender's signed original first");
      const mnemonic = $("p-mnemonic").value.trim();
      const items = readUtxoRows($("putxo-list"), mnemonic, "receiver");
      const proposal = PJ.buildProposal({
        originalB64: state.original.base64,
        params: state.original.envelope.params,
        paymentScriptHex: state.original.envelope.payment.script_hex,
        receiverInputs: items.map((x) => x.input),
        tweakedPrivs: items.map((x) => x.key.tweakedPriv),
        receiverChangeAddress: $("p-change").value.trim(),
        rng: undefined, // real randomness: crypto.getRandomValues
      });
      state.proposal = proposal;
      $("p-envelope").value = JSON.stringify(proposal.envelope, null, 2);
      $("p-psbt").value = proposal.base64;
      kv($("p-fee"), [
        ["Inputs / outputs", `${proposal.nIn} in / ${proposal.nOut} out (receiver input inserted at #${proposal.inIdx}, change at #${proposal.changeIdx ?? "—"})`],
        ["Original fee", `${proposal.feeO} grains over ${proposal.vsizeO} vB`],
        ["Added weight", `${proposal.addedVBytes} vB → receiver cost ${proposal.weightCost} grains at the original rate`],
        ["Receiver contribution required", `${proposal.required} grains (added-weight cost, honoring minfeerate floor ${proposal.minTotal} total)`],
        ["Covered by receiver change shave", `${proposal.cRecv} grains`],
        ["Deducted from payment", `${proposal.d} grains (cap: ${state.original.envelope.params.maxadditionalfeecontribution})`],
        ["Receiver change", proposal.rChange ? grainsStr(proposal.rChange) : "none"],
        ["Final fee", `${proposal.feeP} grains @ ${(Number(proposal.feeP) / proposal.vsizeP).toFixed(2)} grains/vB`],
      ]);
      $("p-out").hidden = false;
    } catch (e) { showErr("p-build-error", e); }
  });
  $("p-to-verify").addEventListener("click", () => {
    if (state.proposal) $("v-proposal").value = JSON.stringify(state.proposal.envelope);
    selectTab("verify");
  });

  /* ---------- TAB 4 · Verify ---------- */
  $("v-run").addEventListener("click", () => {
    hideErr("v-error");
    $("v-verdict").hidden = true;
    $("v-table").hidden = true;
    $("v-to-sign-row").hidden = true;
    try {
      if (!state.original) throw new Error("REFUSED [no-original]: the sender's original is needed for comparison — build one in the Sender tab first");
      const dec = PJ.decodePaste($("v-proposal").value);
      if (dec.kind !== "pearl-payjoin-proposal" && dec.kind !== "bare-psbt")
        throw new Error("REFUSED [wrong-envelope]: this tab needs the receiver's proposal, not " + dec.kind);
      const verdict = PJ.verifyProposal({
        originalB64: state.original.base64,
        proposalB64: dec.psbtB64,
        params: state.original.envelope.params,
        paymentScriptHex: state.original.envelope.payment.script_hex,
      });
      state.proposal = { base64: dec.psbtB64, envelope: dec.kind === "pearl-payjoin-proposal" ? { params: dec.params, payment: dec.payment, fee: dec.fee } : state.proposal?.envelope, verdict };
      const vd = $("v-verdict");
      vd.className = "pj-verdict " + (verdict.ok ? "ok" : "no");
      vd.textContent = verdict.ok
        ? `PASS — all ${verdict.checks.length} BIP-78 checks passed. This proposal is safe to sign.`
        : `FAIL — ${verdict.checks.filter((c) => !c.pass).length} of ${verdict.checks.length} checks failed. DO NOT SIGN this proposal.`;
      vd.hidden = false;
      const tb = $("v-table").querySelector("tbody");
      tb.innerHTML = "";
      verdict.checks.forEach((c) => {
        const tr = document.createElement("tr");
        const tdN = document.createElement("td"); tdN.textContent = c.name;
        const tdR = document.createElement("td");
        tdR.textContent = c.pass ? "PASS" : "FAIL";
        tdR.className = c.pass ? "pass" : "fail";
        const tdD = document.createElement("td"); tdD.textContent = c.detail; tdD.className = "mono";
        tr.append(tdN, tdR, tdD);
        tb.appendChild(tr);
      });
      $("v-table").hidden = false;
      if (verdict.ok) $("v-to-sign-row").hidden = false;
    } catch (e) { showErr("v-error", e); }
  });
  $("v-to-sign").addEventListener("click", () => {
    if (state.proposal && state.proposal.envelope) $("g-proposal").value = JSON.stringify(state.proposal.envelope);
    else if (state.proposal) $("g-proposal").value = $("v-proposal").value; // bare PSBT passthrough
    selectTab("sign");
  });

  /* ---------- TAB 5 · Sign ---------- */
  $("g-confirm").addEventListener("change", (ev) => { $("g-broadcast").disabled = !ev.target.checked; });
  $("g-sign").addEventListener("click", () => {
    hideErr("g-error");
    $("g-out").hidden = true;
    try {
      if (!state.original) throw new Error("REFUSED [no-original]: build the original in the Sender tab first");
      const dec = PJ.decodePaste($("g-proposal").value);
      if (dec.kind !== "pearl-payjoin-proposal" && dec.kind !== "bare-psbt")
        throw new Error("REFUSED [wrong-envelope]: this tab needs the receiver's proposal, not " + dec.kind);
      const mnemonic = $("g-mnemonic").value.trim();
      if (!mnemonic) throw new Error("REFUSED [no-mnemonic]: your sender mnemonic is required to sign");
      const signed = PJ.signProposal({
        proposalB64: dec.psbtB64,
        originalB64: state.original.base64,
        params: state.original.envelope.params,
        paymentScriptHex: state.original.envelope.payment.script_hex,
        mnemonic,
      });
      state.signed = signed;
      $("g-hex").value = signed.txHex;
      $("g-psbt").value = signed.finalB64;
      kv($("g-summary"), [
        ["Verification", `all ${signed.checks.length} BIP-78 checks passed before signing`],
        ["Signed inputs", signed.signedInputs.map((s) => `#${s.index} ${s.outpoint.slice(0, 20)}… (${s.address.slice(0, 18)}…)`).join(", ")],
        ["txid", signed.txid],
        ["Size / fee", `${signed.vsize} vB · ${signed.fee} grains @ ${signed.feeRate} grains/vB`],
      ]);
      $("g-out").hidden = false;
      $("g-confirm").checked = false;
      $("g-broadcast").disabled = true;
    } catch (e) { showErr("g-error", e); }
  });
  $("g-broadcast").addEventListener("click", async () => {
    // Double-gated: only reachable with the confirmation box checked.
    hideErr("g-error");
    const btn = $("g-broadcast");
    btn.disabled = true;
    btn.textContent = "Broadcasting…";
    try {
      if (!state.signed) throw new Error("REFUSED [no-tx]: sign the proposal first");
      const txid = await PJ.broadcastTx(state.signed.txHex);
      kv($("g-broadcast-out"), [["Broadcast result", "accepted by the Pearl blockbook, txid " + txid]]);
    } catch (e) {
      showErr("g-error", new Error("broadcast failed (live network call): " + errText(e)));
    } finally {
      btn.disabled = !$("g-confirm").checked;
      btn.textContent = "Broadcast transaction";
    }
  });

  /* ---------- self-test ---------- */
  $("t-run").addEventListener("click", () => {
    const out = $("t-out");
    out.hidden = false;
    out.innerHTML = "running…";
    setTimeout(() => {
      try {
        const r = PJ.labSelfTest();
        out.innerHTML = r.lines.map((l) => {
          const cls = l.startsWith("ok") ? "ok" : "no";
          const div = document.createElement("div");
          div.className = cls;
          div.textContent = (cls === "ok" ? "PASS " : "FAIL ") + l.slice(3);
          return div.outerHTML;
        }).join("");
      } catch (e) {
        const div = document.createElement("div");
        div.className = "no";
        div.textContent = "FAIL " + errText(e);
        out.innerHTML = div.outerHTML;
      }
    }, 30);
  });
})();
