/* Pearl Burn app — drives the committed pearl-burn.bundle.js (window.PearlBurn).
 * No keys, no signing, no broadcasting: the planner emits unsigned hex only. */
(function () {
  "use strict";
  const B = window.PearlBurn;
  if (!B || B.version !== 1) {
    document.body.insertAdjacentHTML("afterbegin",
      '<div style="padding:2rem;color:#ff5d5d">Pearl Burn failed to load its crypto bundle.</div>');
    return;
  }
  const $ = (s) => document.querySelector(s);

  /* ---------- step tabs ---------- */
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
  if (["generate", "plan", "certify", "verify"].includes(initial)) {
    document.querySelector(`#steps button[data-step="${initial}"]`).click();
  }

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
    const origLabel = b.textContent;
    b.addEventListener("click", () => {
      const el = $(b.dataset.copy);
      if (!el) return;
      const t = el.tagName === "TEXTAREA" || el.tagName === "INPUT" ? el.value : el.textContent;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(t).catch(() => {});
      }
      b.textContent = "copied";
      setTimeout(() => { b.textContent = origLabel; }, 1200);
    });
  });

  function showError(boxSel, msg) {
    const box = $(boxSel);
    box.hidden = false;
    box.textContent = String(msg).replace(/^BURN REFUSED: /, "Refused: ");
  }
  function hideError(boxSel) { $(boxSel).hidden = true; }

  /* ---------- STEP 1: GENERATE ---------- */
  $("#g-generate").addEventListener("click", () => {
    try {
      const b = B.burnAddressForTag($("#g-tag").value, $("#g-network").value);
      $("#g-address").textContent = b.address;
      $("#g-internal").textContent = b.internalKeyHex;
      $("#g-output").textContent = b.outputKeyHex;
      $("#g-tweak").textContent = b.tweakHex;
      renderQR($("#g-qr"), b.address);
      $("#g-result").hidden = false;
      // carry the tag forward
      if (!$("#p-tag").value) $("#p-tag").value = b.tag;
      if (!$("#c-tag").value) $("#c-tag").value = b.tag;
    } catch (e) {
      $("#g-result").hidden = true;
      alert(String(e.message || e));
    }
  });

  /* ---------- STEP 2: PLAN ---------- */
  $("#p-plan").addEventListener("click", () => {
    hideError("#p-error");
    $("#p-result").hidden = true;
    try {
      const networkId = $("#p-network").value;
      const burn = B.burnAddressForTag($("#p-tag").value, networkId);
      const amountGrains = B.prlToGrains($("#p-amount").value);
      const feeRate = Number($("#p-feerate").value);
      const utxo = {
        txid: $("#p-txid").value,
        vout: Number($("#p-vout").value),
        value: Number($("#p-value").value),
      };
      const p = B.planBurnTx({
        networkId, utxo, burnAddress: burn.address,
        amountGrains, changeAddress: $("#p-change").value, feeRateGrainsPerVByte: feeRate,
      });
      $("#p-burnaddr").textContent = burn.address;
      $("#p-burnout").textContent = `${B.grainsToPRL(p.burnGrains)} PRL (${p.burnGrains} grains) → burn (unspendable)`;
      $("#p-changeout").textContent = p.changeGrains > 0
        ? `${B.grainsToPRL(p.changeGrains)} PRL (${p.changeGrains} grains) → your change address`
        : "none — exact fit, remainder absorbed as fee";
      $("#p-vbytes").textContent = `${p.vBytes} vB (1 P2TR keypath input, ${p.outputs.length} P2TR outputs)`;
      $("#p-fee").textContent = `${B.grainsToPRL(p.feeGrains)} PRL (${p.feeGrains} grains) @ ${feeRate} grains/vB`;
      $("#p-hex").value = p.unsignedHex;
      $("#p-result").hidden = false;
      // carry forward to certify
      $("#c-tag").value = burn.tag;
      $("#c-network").value = networkId;
      $("#c-amount").value = $("#p-amount").value.trim();
    } catch (e) {
      showError("#p-error", e.message || e);
    }
  });

  /* ---------- STEP 3: CERTIFY ---------- */
  $("#c-build").addEventListener("click", () => {
    hideError("#c-error");
    $("#c-result").hidden = true;
    try {
      const cert = B.formatCertificate({
        tag: $("#c-tag").value,
        networkId: $("#c-network").value,
        amountGrains: B.prlToGrains($("#c-amount").value),
        txid: $("#c-txid").value.trim() || "pending",
      });
      $("#c-cert").value = cert;
      $("#c-result").hidden = false;
    } catch (e) {
      showError("#c-error", e.message || e);
    }
  });

  /* ---------- STEP 4: VERIFY ---------- */
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

  $("#v-check").addEventListener("click", () => {
    const r = B.verifyBurnSeal($("#v-cert").value);
    verdictBox("#v-result", r.verdict,
      r.verdict === "PROVEN"
        ? ["Tag → address recomputed and matches.", "Seal hash recomputes over tag, address, amount and txid.", "Note: a pending txid proves the math, not the burn — confirm on-chain below."]
        : r.reasons);
  });

  $("#o-check").addEventListener("click", async () => {
    const box = $("#o-result");
    box.hidden = false;
    box.classList.remove("proven", "unproven");
    box.innerHTML = '<p class="hint">Querying Blockbook (GET-only)…</p>';
    let amountGrains;
    try {
      amountGrains = B.prlToGrains($("#o-amount").value);
    } catch (e) {
      // local validation failure, not a Blockbook failure — say so honestly
      verdictBox("#o-result", "NOT PROVEN", [
        "Invalid expected amount: " + String(e.message || e).replace(/^BURN REFUSED: /, ""),
      ]);
      return;
    }
    try {
      const r = await B.verifyBurnTx($("#o-endpoint").value.trim().replace(/\/+$/, ""), {
        txid: $("#o-txid").value.trim(),
        address: $("#o-address").value.trim(),
        amountGrains,
      });
      if (r.found) {
        const when = r.time ? new Date(r.time * 1000).toISOString() : "unknown time";
        verdictBox("#o-result", "PROVEN", [
          `Output of ${B.grainsToPRL(r.valueGrains)} PRL to the burn address found on-chain.`,
          `Block height: ${r.height ?? "unconfirmed"} · confirmations: ${r.confirmations} · time: ${when}.`,
        ]);
      } else {
        verdictBox("#o-result", "NOT PROVEN", [
          "No output matching that address + amount was found in the tx.",
          "Check the txid, address and amount — or the tx may not be confirmed yet.",
        ]);
      }
    } catch (e) {
      verdictBox("#o-result", "NOT PROVEN", [
        "Blockbook lookup failed: " + String(e.message || e),
        "The certificate math can still be verified offline above; chain state is unknown.",
      ]);
    }
  });
})();
