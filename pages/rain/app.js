/* Pearl Rain UI — funder / recipients / plan / sign & send.
 * All crypto runs through the window.PearlRain bundle (audited Sign lineage);
 * this file is pure UI wiring. Keys live only in page memory and are never
 * stored. Broadcasting is always an explicit user action. */
(() => {
  "use strict";
  const N = window.PearlRain;
  if (!N) { document.body.innerHTML = "<p style='padding:2rem'>Failed to load pearl-rain.bundle.js</p>"; return; }

  const $ = (id) => document.getElementById(id);

  /* storage that survives hostile localStorage (Gallery lesson) */
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return this.m?.[k] ?? null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { (this.m ??= {})[k] = v; } },
  };

  const S = {
    network: N.NETWORKS.mainnet,
    blockbook: store.get("rain.blockbook") || N.NETWORKS.mainnet.blockbook,
    funder: null,      // parseRainSecret() result
    utxos: [],         // {txid,vout,value,confirmations?,address?}
    recips: null,      // parseRecipients() result
    plan: null,        // planRain() result
    signed: null,      // buildRainTx() result
  };

  const err = (id, msg) => { const e = $(id); e.hidden = !msg; e.textContent = msg || ""; };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmtPRL = (g) => N.fmtPRL(typeof g === "bigint" ? g : BigInt(g)) + " PRL";

  /* ---------- step navigation ---------- */
  const steps = ["funder", "recipients", "plan", "send"];
  function goto(step) {
    steps.forEach((s) => {
      $("step-" + s).classList.toggle("active", s === step);
      const b = document.querySelector(`#steps button[data-step="${s}"]`);
      b.classList.toggle("active", s === step);
      if (steps.indexOf(s) < steps.indexOf(step)) b.classList.add("done");
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  document.querySelectorAll("#steps button").forEach((b) => b.addEventListener("click", () => goto(b.dataset.step)));

  /* ---------- step 1: funder ---------- */
  $("network").addEventListener("change", (e) => {
    S.network = N.NETWORKS[e.target.value];
    if (!store.get("rain.blockbook")) { S.blockbook = S.network.blockbook || ""; $("blockbook").value = S.blockbook; }
    resetFunder();
  });
  $("utxo-mode").addEventListener("change", (e) => {
    const manual = e.target.value === "manual";
    $("utxo-paste-wrap").hidden = !manual;
    $("utxo-bb-wrap").hidden = manual;
  });
  function resetFunder() {
    S.funder = null; S.utxos = []; S.plan = null; S.signed = null;
    $("fund-card").hidden = true;
    $("fund-utxos").textContent = "";
    $("sign-button").disabled = true;
    $("rain-result").hidden = true;
    $("plan-summary").hidden = true;
  }
  $("fund-derive").addEventListener("click", () => {
    err("fund-error", null);
    try {
      const f = N.parseRainSecret($("fund-secret").value, S.network);
      S.funder = f; S.utxos = []; S.plan = null; S.signed = null;
      $("fund-address").textContent = f.address;
      $("fund-path").textContent = f.account == null ? "imported key (no derivation path)" : `m/86'/${S.network.coinType}'/${f.account}'/0/0`;
      $("fund-card").hidden = false;
      $("fund-utxos").textContent = "";
      $("sign-button").disabled = true; $("rain-result").hidden = true; $("plan-summary").hidden = true;
    } catch (e) { err("fund-error", e.message); resetFunder(); }
  });

  $("fund-fetch").addEventListener("click", async () => {
    err("fetch-error", null);
    if (!S.funder) { err("fetch-error", "Read the funder key first — the UTXOs must belong to that address."); return; }
    try {
      let utxos;
      if ($("utxo-mode").value === "manual") {
        utxos = N.parseManualUtxos($("utxo-paste").value, S.network);
        N.assertUtxosBelong(utxos, S.funder.address);
      } else {
        const bb = ($("blockbook").value || "").trim() || S.network.blockbook;
        if (!bb) throw new Error("No blockbook configured for this network — paste a UTXO list instead.");
        S.blockbook = bb; store.set("rain.blockbook", bb);
        utxos = await N.fetchUtxos(bb, S.funder.address);
        utxos = utxos.map((u) => ({ ...u, address: S.funder.address }));
      }
      if (!utxos.length) throw new Error("No UTXOs found for the funder address — fund it before raining.");
      S.utxos = utxos; S.plan = null; S.signed = null;
      const total = utxos.reduce((a, u) => a + BigInt(u.value), 0n);
      $("fund-utxos").textContent = `${utxos.length} UTXO${utxos.length === 1 ? "" : "s"} · ${fmtPRL(total)} available`;
      $("sign-button").disabled = true; $("rain-result").hidden = true; $("plan-summary").hidden = true;
    } catch (e) { err("fetch-error", e.message); }
  });

  /* ---------- step 2: recipients ---------- */
  function renderRecips() {
    const r = S.recips;
    if (!r) { $("recip-summary").textContent = "No list validated yet."; $("recip-table-wrap").hidden = true; return; }
    const total = r.recipients.reduce((a, x) => a + x.amount, 0n);
    $("recip-summary").innerHTML =
      `<strong>${r.recipients.length} recipient${r.recipients.length === 1 ? "" : "s"}</strong> · total ${fmtPRL(total)}` +
      (r.merged ? ` · ${r.merged} duplicate${r.merged === 1 ? "" : "s"} merged` : "");
    $("recip-table").innerHTML = r.recipients.map((x, i) =>
      `<tr><td>${i + 1}</td><td class="addr">${esc(x.address)}</td><td class="num">${esc(N.fmtPRL(x.amount))}</td></tr>`).join("");
    $("recip-table-wrap").hidden = false;
  }
  $("recip-parse").addEventListener("click", () => {
    err("recip-error", null);
    try {
      S.recips = N.parseRecipients($("recip-list").value, S.network);
      S.plan = null; S.signed = null;
      $("sign-button").disabled = true; $("rain-result").hidden = true; $("plan-summary").hidden = true;
      renderRecips();
    } catch (e) { err("recip-error", e.message); S.recips = null; renderRecips(); }
  });
  $("recip-sample").addEventListener("click", () => {
    const blob = new Blob([N.sampleRainCsv()], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "pearl-rain-sample.csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });
  $("recip-file").addEventListener("change", (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => { $("recip-list").value = String(rd.result || ""); $("recip-parse").click(); };
    rd.readAsText(f);
  });

  /* ---------- step 3: plan ---------- */
  $("plan-button").addEventListener("click", () => {
    err("plan-error", null);
    try {
      if (!S.funder) throw new Error("Read the funder key first (step 1).");
      if (!S.utxos.length) throw new Error("Find the funder's coins first (step 1).");
      if (!S.recips) throw new Error("Validate the recipient list first (step 2).");
      const rate = Number($("fee-rate").value);
      const plan = N.planRain({
        utxos: S.utxos, recipients: S.recips.recipients,
        funderProgram: S.funder.program, feeRateGrainsPerVByte: rate, network: S.network,
      });
      S.plan = plan; S.signed = null;
      const rows = [
        [`Recipients`, `${plan.nOut - (plan.changeDropped ? 0 : 1)} outputs`],
        [`To recipients`, fmtPRL(plan.sumOut)],
        [`Fee`, `${fmtPRL(plan.fee)} (${plan.vBytes} vB @ ${plan.feeRate} gr/vB)`],
        ...(plan.changeDropped ? [[`Dust change`, `absorbed into fee (+${fmtPRL(plan.feeBump)})`]] : [[`Change to funder`, fmtPRL(plan.change)]]),
        [`Inputs`, `${plan.nIn} UTXO${plan.nIn === 1 ? "" : "s"} · ${fmtPRL(plan.total)}`],
      ];
      $("plan-summary").innerHTML =
        `<div class="prow total"><span>Plan</span><span class="n">1 tx · ${plan.nOut} outputs</span></div>` +
        rows.map(([k, v]) => `<div class="prow"><span>${esc(k)}</span><span>${esc(v)}</span></div>`).join("") +
        `<div class="prow total"><span>Accounting</span><span>${fmtPRL(plan.total)} = ${fmtPRL(plan.sumOut)} + ${fmtPRL(plan.fee)}${plan.changeDropped ? " + fee bump" : " + " + fmtPRL(plan.change)}</span></div>`;
      $("plan-summary").hidden = false;
      $("sign-button").disabled = false;
      $("rain-result").hidden = true;
    } catch (e) { err("plan-error", e.message); S.plan = null; $("plan-summary").hidden = true; $("sign-button").disabled = true; }
  });

  /* ---------- step 4: sign & send ---------- */
  $("sign-button").addEventListener("click", () => {
    err("sign-error", null);
    try {
      if (!S.plan) throw new Error("Compute the plan first (step 3).");
      const { txid, hex } = N.buildRainTx({ privHex: S.funder.privHex, utxos: S.utxos, plan: S.plan, network: S.network });
      S.signed = { txid, hex };
      $("rain-txid").textContent = txid;
      $("rain-hex").value = hex;
      $("rain-verified").hidden = false;
      $("rain-result").hidden = false;
      $("broadcast-ok").hidden = true;
      err("broadcast-error", null);
    } catch (e) { err("sign-error", e.message); }
  });

  $("broadcast-button").addEventListener("click", async () => {
    err("broadcast-error", null);
    $("broadcast-ok").hidden = true;
    if (!S.signed) { err("broadcast-error", "Nothing signed yet."); return; }
    const bb = ($("blockbook").value || "").trim() || S.network.blockbook;
    if (!bb) { err("broadcast-error", "No blockbook endpoint — paste the signed hex into a node manually instead."); return; }
    if (!confirm(`Broadcast this rain transaction? This sends ${fmtPRL(S.plan.sumOut)} to ${S.recips.recipients.length} recipients — real PRL, irreversible.`)) return;
    try {
      const txid = await N.broadcastTx(bb, S.signed.hex);
      $("broadcast-ok").hidden = false;
      $("broadcast-ok").textContent = `⛈ Broadcast accepted — txid ${txid}. You can now clear the secrets below.`;
    } catch (e) { err("broadcast-error", e.message); }
  });

  $("clear-secrets").addEventListener("click", () => {
    S.funder = null; S.utxos = []; S.recips = null; S.plan = null; S.signed = null;
    $("fund-secret").value = "";
    $("rain-hex").value = "";
    $("fund-card").hidden = true; $("rain-result").hidden = true; $("plan-summary").hidden = true;
    $("sign-button").disabled = true;
    renderRecips();
  });

  /* ---------- init ---------- */
  $("blockbook").value = S.blockbook || "";
  renderRecips();
})();
