/* Pearl Split — tavern-ledger UI controller.
 *
 * Classic IIFE over window.PearlSplit. Five steps: Tab → Expenses → Settle →
 * Pay → Ledger. Secrets live in memory only; the desk wipes the key field
 * after every sign.
 */
(function () {
  "use strict";
  const P = window.PearlSplit;
  if (!P) throw new Error("Pearl Split bundle failed to load");

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const ORDER = ["tab", "expenses", "settle", "pay", "ledger"];

  const S = {
    network: P.NETWORKS.mainnet,
    tabName: "",
    members: [],        // raw { name, address } — validated at settlement
    expenses: [],       // addExpense() records
    settlement: null,   // settleTab() result
    plans: [],          // debtorPlans
    utxos: null,
    plan: null,
    imported: null,
    signed: [],         // [{ debtorIdx, txid, hex, feeGrains }]
    bcast: {},          // debtorIdx -> txid
    armTimer: null,
  };

  function err(id, msg) { const e = $(id); e.hidden = !msg; e.textContent = msg || ""; }
  function showStep(name) {
    ORDER.forEach((s) => { $("step-" + s).classList.toggle("active", s === name); });
    document.querySelectorAll("#steps button").forEach((b) => {
      b.classList.toggle("active", b.dataset.step === name);
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
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
  const net = () => ($("tab-network").value === "testnet" ? P.NETWORKS.testnet : P.NETWORKS.mainnet);
  const g2p = (g) => P.fmtPRL(BigInt(g));

  /* ---------- STEP 1: tab ---------- */
  $("tab-network").addEventListener("change", () => {
    if (S.members.length && !confirm("Changing the network clears the seated members. Continue?")) {
      $("tab-network").value = S.network.id;
      return;
    }
    S.network = net();
    S.members = [];
    renderMembers();
  });

  function renderMembers() {
    const box = $("members-list");
    if (!S.members.length) { box.innerHTML = '<p class="note">Nobody seated yet.</p>'; return; }
    box.innerHTML = S.members.map((m, i) =>
      `<div class="member-row"><span class="m-name">${esc(m.name)}</span>` +
      `<code class="m-addr">${esc(m.address)}</code>` +
      `<button class="ghost small" data-rm="${i}">Unseat</button></div>`
    ).join("");
    box.querySelectorAll("[data-rm]").forEach((b) => {
      b.addEventListener("click", () => { S.members.splice(Number(b.dataset.rm), 1); renderMembers(); });
    });
  }

  $("m-add").addEventListener("click", () => {
    err("tab-error");
    try {
      const m = P.validateMember($("m-name").value, $("m-addr").value, S.network);
      if (S.members.some((x) => x.address.toLowerCase() === m.address.toLowerCase())) {
        throw new Error("that address is already seated at this tab");
      }
      if (S.members.some((x) => x.name.toLowerCase() === m.name.toLowerCase())) {
        throw new Error("that name is already seated at this tab");
      }
      S.members.push({ name: m.name, address: m.address });
      $("m-name").value = ""; $("m-addr").value = "";
      renderMembers();
    } catch (e) { err("tab-error", e.message); }
  });

  $("m-sample").addEventListener("click", () => {
    $("tab-network").value = "testnet";
    S.network = P.NETWORKS.testnet;
    S.members = [];
    const seeds = ["split-hank-1", "split-jolene-2", "split-marv-3", "split-polly-4"];
    const names = ["Hank", "Jolene", "Marv", "Polly"];
    seeds.forEach((s, i) => S.members.push({ name: names[i], address: P.encodeBech32m("tprl", 1, P.sha256(new TextEncoder().encode(s))) }));
    $("tab-name").value = "Sample steak night";
    renderMembers();
    err("tab-error", "");
  });

  function refreshExpenseForms() {
    const ps = $("e-payer");
    ps.innerHTML = S.members.map((m, i) => `<option value="${i}">${esc(m.name)}</option>`).join("");
    $("e-members").innerHTML = S.members.map((m, i) =>
      `<label class="check"><input type="checkbox" data-em="${i}" checked> ${esc(m.name)}</label>`
    ).join(" ");
  }

  $("tab-start").addEventListener("click", () => {
    err("tab-error");
    try {
      const name = $("tab-name").value.trim();
      if (!name) throw new Error("name the tab first — every ledger needs a heading");
      const mem = P.validateMembers(S.members, S.network); // throws on anything bad
      S.tabName = name;
      S.expenses = [];
      S.settlement = null;
      S.plans = [];
      S.signed = [];
      S.bcast = {};
      renderExpenses();
      refreshExpenseForms();
      unlock("expenses");
      showStep("expenses");
    } catch (e) { err("tab-error", e.message); }
  });

  /* ---------- STEP 2: expenses ---------- */
  $("e-mode").addEventListener("change", (e) => {
    const v = e.target.value;
    $("e-shares-wrap").hidden = v !== "shares";
    $("e-perc-wrap").hidden = v !== "percent";
  });

  function selMembers() {
    return [...document.querySelectorAll("#e-members [data-em]")].filter((c) => c.checked).map((c) => Number(c.dataset.em));
  }

  $("e-add").addEventListener("click", () => {
    err("exp-error");
    try {
      const mode = $("e-mode").value;
      const sel = selMembers();
      const csv = (s) => String(s || "").split(",").map((x) => x.trim()).filter((x) => x !== "");
      const e = P.addExpense(
        { members: S.members, network: S.network },
        {
          desc: $("e-desc").value, amountPRL: $("e-amount").value,
          payerIdx: Number($("e-payer").value), mode, memberIdxs: sel,
          shares: csv($("e-shares").value), percents: csv($("e-perc").value),
        }
      );
      S.expenses.push(e);
      $("e-desc").value = ""; $("e-amount").value = "";
      $("e-shares").value = ""; $("e-perc").value = "";
      document.querySelectorAll("#e-members [data-em]").forEach((c) => { c.checked = true; });
      renderExpenses();
      unlock("settle");
    } catch (e) { err("exp-error", e.message); }
  });

  function renderExpenses() {
    const box = $("exp-list");
    if (!S.expenses.length) { box.innerHTML = '<p class="note">No expenses chalked up yet.</p>'; return; }
    box.innerHTML = S.expenses.map((e, i) => {
      const mem = S.members;
      const lines = e.lines.map((l) => `${esc(mem[l.memberIdx].name)} owes ${g2p(l.grains)} PRL`).join("<br>");
      return `<div class="expense-row"><div class="e-head"><strong>#${i + 1} ${esc(e.desc)}</strong>` +
        `<span>${g2p(e.totalGrains)} PRL · paid by ${esc(mem[e.payerIdx].name)} · ${esc(e.mode)}</span>` +
        `<button class="ghost small" data-re="${i}">Strike</button></div>` +
        `<div class="e-lines">${lines}</div></div>`;
    }).join("");
    box.querySelectorAll("[data-re]").forEach((b) => {
      b.addEventListener("click", () => { S.expenses.splice(Number(b.dataset.re), 1); renderExpenses(); });
    });
  }

  /* ---------- STEP 3: settle ---------- */
  $("st-compute").addEventListener("click", () => {
    err("st-error");
    try {
      if (!S.expenses.length) throw new Error("chalk up at least one expense first");
      const settled = P.settleTab({ tabName: S.tabName, members: S.members, expenses: S.expenses, network: S.network });
      S.settlement = settled;
      S.plans = P.debtorPlans(settled.payable, settled.members, S.network);
      S.utxos = null; S.plan = null; S.imported = null; S.signed = []; S.bcast = {};
      $("st-result").hidden = false;

      $("st-table-body").innerHTML = settled.members.map((m, i) => {
        const b = settled.balances[i];
        const side = b > 0n ? "is owed" : b < 0n ? "owes" : "even";
        return `<tr><td>${esc(m.name)}</td><td class="${b > 0n ? "pos" : b < 0n ? "neg" : ""}">${b > 0n ? "+" : ""}${g2p(b)} PRL</td><td>${side}</td></tr>`;
      }).join("");

      const tl = $("st-transfers");
      if (!settled.payable.length) {
        tl.innerHTML = '<li class="even">The tab nets to zero — nobody owes anyone a grain.</li>';
      } else {
        tl.innerHTML = settled.payable.map((t) =>
          `<li><strong>${esc(settled.members[t.from].name)}</strong> pays ` +
          `<strong>${esc(settled.members[t.to].name)}</strong> ` +
          `<span class="amt">${g2p(t.grains)} PRL</span></li>`
        ).join("");
      }

      $("st-dust").hidden = !settled.blocked.length;
      $("st-dust-list").innerHTML = settled.blocked.map((b) => `<li>${esc(b.reason)}</li>`).join("");
      $("st-fp").textContent = settled.fingerprint;

      const pd = $("pay-debtor");
      pd.innerHTML = S.plans.map((p, i) =>
        `<option value="${i}">${esc(p.debtorName)} — owes ${g2p(p.recipients.reduce((a, r) => a + r.amount, 0n))} PRL ` +
        `(${p.recipients.length} creditor${p.recipients.length > 1 ? "s" : ""})` +
        `${S.bcast[p.debtorIdx] ? " · PAID " + S.bcast[p.debtorIdx].slice(0, 12) + "…" : ""}</option>`
      ).join("");

      unlock("pay");
      renderLedgerList();
    } catch (e) { err("st-error", e.message); }
  });

  $("st-download").addEventListener("click", () => {
    if (!S.settlement) return;
    const st = S.settlement;
    download(
      "pearl-split-settlement.json",
      JSON.stringify({
        descriptor: st.descriptor, fingerprint: st.fingerprint,
        transfers: st.transfers.map((t) => ({ ...t, grains: String(t.grains) })),
      }, null, 2)
    );
  });

  /* ---------- STEP 4: pay ---------- */
  function curPlan() { return S.plans[Number($("pay-debtor").value)] || null; }

  async function fundFrom(utxos) {
    const plan0 = curPlan();
    if (!plan0) throw new Error("no settlement to pay — compute the settlement first");
    const rate = Number($("pay-feerate").value);
    const plan = P.fundSettlement({ network: S.network, debtorPlan: plan0, utxos, feeRateGrainsPerVByte: rate });
    S.utxos = utxos; S.plan = plan; S.imported = null;
    $("pay-result").hidden = false;
    $("pay-signed").hidden = true; $("pay-bcast").hidden = true;
    $("pay-r-ins").textContent = `${plan.inputs.length} UTXO(s) — ${g2p(plan.total)} PRL`;
    $("pay-r-out").textContent = plan0.recipients.map((r) => `${r.name}: ${g2p(r.amount)} PRL`).join(" · ");
    $("pay-r-fee").textContent = `${g2p(plan.fee)} PRL${plan.changeDropped ? ` (includes ${g2p(plan.changeBump)} dust change)` : ""}`;
    $("pay-r-change").textContent = plan.changeDropped ? "dropped to fee (dust)" : `${g2p(plan.change)} PRL back to ${esc(plan0.debtorName)}`;
  }

  $("pay-fetch").addEventListener("click", async () => {
    err("pay-error");
    $("pay-fetch").disabled = true;
    try {
      const base = $("pay-blockbook").value.trim().replace(/\/+$/, "");
      if (!base) throw new Error("enter a Blockbook base URL, or use pasted UTXOs");
      const plan0 = curPlan();
      const utxos = await P.fetchUtxos(base, plan0.debtorAddress);
      if (!utxos.length) throw new Error(`Blockbook knows no UTXOs for ${plan0.debtorName}'s address — fund it first, or paste UTXOs manually`);
      await fundFrom(utxos);
    } catch (e) { err("pay-error", e.message); }
    finally { $("pay-fetch").disabled = false; }
  });

  $("pay-apply").addEventListener("click", () => {
    err("pay-error");
    try {
      const utxos = P.parseUtxoList($("pay-paste").value, S.network);
      if (!utxos.length) throw new Error("no UTXOs pasted");
      fundFrom(utxos);
    } catch (e) { err("pay-error", e.message); }
  });

  $("pay-export").addEventListener("click", () => {
    err("pay-error");
    try {
      if (!S.plan) throw new Error("fund the payment first");
      const plan0 = curPlan();
      const bundle = P.exportSplitBundle({
        network: S.network, debtorPlan: plan0,
        tabFingerprint: S.settlement.fingerprint,
        plan: S.plan, feeRate: Number($("pay-feerate").value),
      });
      download("pearl-split-unsigned.json", JSON.stringify(bundle, null, 2));
    } catch (e) { err("pay-error", e.message); }
  });

  $("pay-import").addEventListener("click", () => {
    err("pay-error");
    try {
      const imp = P.importSplitBundle($("pay-bundle").value);
      const plan0 = curPlan();
      if (imp.descriptor.debtorAddress.toLowerCase() !== plan0.debtorAddress.toLowerCase()) {
        throw new Error("bundle is for a different debtor — select the right debtor first");
      }
      S.imported = imp; S.plan = imp.plan; S.utxos = imp.plan.inputs;
      $("pay-result").hidden = false;
      $("pay-r-ins").textContent = `${imp.plan.inputs.length} UTXO(s) — ${g2p(imp.plan.total)} PRL (from bundle)`;
      $("pay-r-out").textContent = imp.recipients.map((r) => `${esc(r.name)}: ${g2p(r.amount)} PRL`).join(" · ");
      $("pay-r-fee").textContent = `${g2p(imp.plan.fee)} PRL`;
      $("pay-r-change").textContent = imp.plan.changeDropped ? "dropped to fee (dust)" : `${g2p(imp.plan.change)} PRL change`;
    } catch (e) { err("pay-error", e.message); }
  });

  $("pay-wipe").addEventListener("click", () => {
    $("pay-key").value = "";
    err("pay-error", "");
  });

  $("pay-sign").addEventListener("click", () => {
    err("pay-error");
    try {
      const plan0 = curPlan();
      if (!S.plan) throw new Error("fund the payment (or import a bundle) first");
      const secret = P.parseBatchSecret($("pay-key").value, S.network);
      const { txid, hex, plan } = P.buildSettlementTx({
        secret, debtorAddress: plan0.debtorAddress, utxos: S.utxos, plan: S.plan, network: S.network,
      });
      $("pay-key").value = ""; // wipe the key the moment the hex is built
      const checks = P.verifySignedTx(S.network, hex, S.plan.inputs.map((u) => ({
        value: u.value,
        spk: (() => { const h = new Uint8Array(34); h[0] = 0x51; h[1] = 0x20; h.set(plan0.senderProgram, 2); return h; })(),
      })));
      const bad = checks.filter((c) => !c.ok);
      const okCount = checks.length - bad.length;
      $("pay-signed").hidden = false;
      $("pay-bcast").hidden = true;
      $("pay-r-txid").textContent = txid;
      $("pay-r-fee2").textContent = `${g2p(plan.fee)} PRL`;
      $("pay-r-sigs").textContent = `${okCount}/${checks.length} signatures re-verified locally`;
      $("pay-r-hex").value = hex;
      S.signed = S.signed.filter((s) => s.debtorIdx !== plan0.debtorIdx);
      S.signed.push({ debtorIdx: plan0.debtorIdx, txid, hex, feeGrains: plan.fee.toString() });
      $("pay-confirm").hidden = true;
      $("pay-arm").hidden = false;
      if (bad.length) throw new Error("local signature re-verification failed — the hex is NOT safe to broadcast");
    } catch (e) { err("pay-error", e.message); }
  });

  $("pay-arm").addEventListener("click", () => {
    const plan0 = curPlan();
    const s = S.signed.find((x) => x.debtorIdx === plan0.debtorIdx);
    if (!s) { err("pay-error", "sign the payment first"); return; }
    $("pay-confirm").hidden = false;
    $("pay-arm").hidden = true;
    $("pay-confirm").textContent = `Confirm broadcast of ${s.txid.slice(0, 16)}…`;
  });

  $("pay-confirm").addEventListener("click", async () => {
    err("pay-error");
    $("pay-confirm").disabled = true;
    try {
      const plan0 = curPlan();
      const s = S.signed.find((x) => x.debtorIdx === plan0.debtorIdx);
      if (!s) throw new Error("sign the payment first");
      const base = $("pay-blockbook").value.trim().replace(/\/+$/, "");
      if (!base) throw new Error("enter the Blockbook base URL used for reads — broadcast goes through it");
      const txid = await P.broadcastViaBlockbook(base, s.hex);
      S.bcast[plan0.debtorIdx] = txid;
      $("pay-bcast").hidden = false;
      $("pay-r-bcast").textContent = `${plan0.debtorName}'s payment broadcast · txid ${txid}`;
      $("pay-confirm").hidden = true;
      $("pay-arm").hidden = false;
      unlock("ledger");
    } catch (e) { err("pay-error", e.message); }
    finally { $("pay-confirm").disabled = false; }
  });

  /* ---------- STEP 5: ledger ---------- */
  function getLedger() { return P.loadLedger(window.localStorage); }
  function setLedger(l) { P.saveLedger(window.localStorage, l); }

  $("led-record").addEventListener("click", () => {
    err("led-error");
    try {
      if (!S.settlement) throw new Error("compute a settlement first — the ledger records settled tabs");
      const ledger = getLedger();
      const txids = {};
      for (const s of S.signed) txids[String(s.debtorIdx)] = s.txid;
      const entry = {
        recordedAt: new Date().toISOString(),
        tabName: S.tabName, fingerprint: S.settlement.fingerprint,
        network: S.network.id,
        members: S.settlement.members.map((m) => ({ name: m.name, address: m.address })),
        expenses: S.settlement.descriptor.expenses,
        balances: S.settlement.balances.map((b, i) => ({ member: S.settlement.members[i].name, grains: b.toString() })),
        transfers: S.settlement.transfers.map((t) => ({
          from: S.settlement.members[t.from].name, to: S.settlement.members[t.to].name,
          grains: String(t.grains), txid: S.bcast[t.from] || null,
        })),
      };
      ledger.tabs = ledger.tabs.filter((t) => t.fingerprint !== entry.fingerprint);
      ledger.tabs.push(entry);
      setLedger(ledger);
      renderLedgerList();
    } catch (e) { err("led-error", e.message); }
  });

  function renderLedgerList() {
    const ledger = getLedger();
    const box = $("led-list");
    if (!ledger.tabs.length) { box.innerHTML = '<p class="note">The ledger is empty.</p>'; return; }
    box.innerHTML = ledger.tabs.map((t) =>
      `<div class="ledger-entry"><div class="e-head"><strong>${esc(t.tabName)}</strong>` +
      `<span>${esc(t.recordedAt.slice(0, 10))} · ${t.transfers.length} transfer(s) · <code>${esc(t.fingerprint.slice(0, 12))}</code></span></div>` +
      `<div class="e-lines">` +
      t.transfers.map((x) => `${esc(x.from)} → ${esc(x.to)}: ${g2p(x.grains)} PRL` +
        (x.txid ? ` · <code class="addr">${esc(x.txid)}</code>` : " · <em>unpaid</em>")).join("<br>") +
      `</div></div>`
    ).join("");
  }

  $("led-csv").addEventListener("click", () => {
    download("pearl-split-ledger.csv", P.ledgerToCsv(getLedger()), "text/csv");
  });

  $("led-clear").addEventListener("click", () => {
    if ($("led-clear").dataset.armed) {
      setLedger({ tabs: [] });
      delete $("led-clear").dataset.armed;
      $("led-clear").textContent = "Clear ledger";
      renderLedgerList();
    } else {
      $("led-clear").dataset.armed = "1";
      $("led-clear").textContent = "Click again to confirm clearing the ledger";
    }
  });

  renderMembers();
  renderExpenses();
  renderLedgerList();

  // test hook for headless-browser QA (drives the same DOM as a visitor)
  window.__splitTest = {
    state: () => S,
    err: (id) => { const e = $(id); return { hidden: e.hidden, text: e.textContent }; },
    click: (id) => $(id).click(),
    set: (id, v) => { $(id).value = v; },
    text: (id) => $(id).textContent,
  };
})();
