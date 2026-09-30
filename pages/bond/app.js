/* Pearl Bond UI — 5-step wizard over window.PearlBond (bond-core + Sign bundle).
 * All cryptography runs locally. Keys are never transmitted anywhere. */
(function () {
  "use strict";
  const B = window.PearlBond;
  const $ = (id) => document.getElementById(id);
  const GRAIN = 100_000_000;

  function errBox(id) { return $(id); }
  function fail(id, e) { errBox(id).textContent = e && e.message ? e.message : String(e); }
  function clearErr(id) { errBox(id).textContent = ""; }
  function prl(grains) {
    return (grains / GRAIN).toLocaleString("en-US", { maximumFractionDigits: 8 });
  }
  function parsePRL(s) {
    const v = Number(String(s).trim());
    if (!Number.isFinite(v) || v <= 0) throw new Error("enter a positive PRL amount");
    return Math.round(v * GRAIN);
  }
  function parseFee(s) {
    const v = Number(String(s).trim());
    if (!Number.isFinite(v) || v <= 0) throw new Error("fee rate must be positive");
    return v;
  }
  function copyText(id, text) {
    const done = () => { const b = $(id); if (b) { const t = b.textContent; b.textContent = "Copied"; setTimeout(() => (b.textContent = t), 1200); } };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
    } else fallbackCopy(text, done);
  }
  function fallbackCopy(text, done) {
    const ta = document.createElement("textarea");
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch { /* noop */ }
    document.body.removeChild(ta); done();
  }

  /* ---------- step navigation ---------- */
  const steps = ["terms", "fund", "redeem", "transfer", "track"];
  document.querySelectorAll("#steps button").forEach((b) => {
    b.addEventListener("click", () => {
      document.querySelectorAll("#steps button").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      document.querySelectorAll("main > section.panel[id^='step-']").forEach((s) => s.classList.remove("active"));
      $("step-" + b.dataset.step).classList.add("active");
    });
  });

  /* ---------- shared state ---------- */
  const S = { network: null, terms: null, bond: null, holderPriv: null, holderXOnly: null };

  function getNetwork() {
    const id = $("t-network").value;
    return B.NETWORKS[id];
  }
  function blockbookBase() {
    // Only mainnet has a known public indexer; testnet tracking is manual.
    if (getNetwork().id !== "mainnet") throw new Error("live tracking needs mainnet (no public testnet indexer configured) — paste the height manually");
    return B.BLOCKBOOK_MAINNET;
  }
  async function fetchTipHeight() {
    const base = blockbookBase().replace(/\/+$/, "");
    const res = await fetch(base + "/api/v2/api");
    if (!res.ok) throw new Error("blockbook status HTTP " + res.status);
    const j = await res.json();
    const h = j && j.backend && j.backend.blocks;
    if (!Number.isInteger(h)) throw new Error("unexpected blockbook status response");
    return h;
  }
  async function fetchAddrInfo(address) {
    const base = blockbookBase().replace(/\/+$/, "");
    const res = await fetch(base + "/api/v2/address/" + address);
    if (!res.ok) throw new Error("blockbook address HTTP " + res.status);
    const j = await res.json();
    return { balance: Number(j.balance || 0), txs: Number(j.txs || 0) };
  }

  /* Parse a holder key field: returns { xonly, priv } where priv may be null.
   * Accepts 12/24-word mnemonic (BIP-86, has priv), 64-hex privkey, or
   * 64-hex x-only pubkey (watch-only, cannot sign). */
  function parseKeyField(raw, network) {
    const t = String(raw || "").trim();
    if (!t) throw new Error("holder key required");
    if (/^[0-9a-fA-F]{64}$/.test(t)) {
      // Ambiguous: could be privkey or x-only pubkey. Disambiguate by trying
      // to derive a pubkey — both are valid 32-byte scalars/points, so we
      // treat 64-hex as a PRIVKEY only when explicitly in a signing field.
      return { ambiguousHex: t.toLowerCase() };
    }
    const words = t.split(/\s+/);
    if (words.length === 12 || words.length === 24) {
      const w = B.walletFromMnemonic(t, network); // throws on bad mnemonic
      return { xonly: w.internalXOnly, priv: w.priv, source: "mnemonic (BIP-86)" };
    }
    throw new Error("key must be 64-hex or a 12/24-word mnemonic");
  }
  function resolveSigningKey(parsed, network) {
    if (parsed.priv) return parsed.priv;
    if (parsed.ambiguousHex) return B.hexToBytes(parsed.ambiguousHex); // signing field: treat as privkey
    throw new Error("this key cannot sign (x-only pubkey) — paste the mnemonic or privkey");
  }
  function resolveXOnly(parsed) {
    if (parsed.xonly) return parsed.xonly;
    if (parsed.ambiguousHex) {
      // Forge field: treat 64-hex as x-only pubkey (watch-only).
      return B.hexToBytes(parsed.ambiguousHex);
    }
    throw new Error("bad key");
  }

  /* ---------- STEP 1: terms ---------- */
  $("t-genkey").addEventListener("click", () => {
    const mn = B.newMnemonic(); // 12 words; BIP-86 derivation on use
    $("t-holder").value = mn;
    S.holderPriv = null;
    $("t-err").textContent = "";
    alert("New 12-word mnemonic placed in the holder field.\n\nWrite it down now — it is the ONLY way to sign claims and transfers later. This page will not show it again.");
  });

  $("t-forge").addEventListener("click", async () => {
    clearErr("t-err");
    try {
      const network = getNetwork();
      const faceGrains = parsePRL($("t-face").value);
      const ratePct = Number(String($("t-rate").value).trim());
      if (!Number.isFinite(ratePct) || ratePct < 0 || ratePct > 100) throw new Error("rate must be 0–100%");
      const frequency = Number($("t-freq").value);
      const periods = Number($("t-periods").value);
      if (!Number.isInteger(periods) || periods < 1 || periods > 240) throw new Error("periods must be 1–240");
      let issueHeight = $("t-issue").value.trim();
      if (issueHeight === "") {
        try { issueHeight = await fetchTipHeight(); }
        catch { throw new Error("could not fetch chain tip — enter the issue height manually"); }
      } else {
        issueHeight = Number(issueHeight);
        if (!Number.isInteger(issueHeight) || issueHeight < 0) throw new Error("issue height must be a non-negative integer");
      }
      const parsed = parseKeyField($("t-holder").value, network);
      const xonly = resolveXOnly(parsed);
      const terms = B.parseBondTerms({
        name: $("t-name").value.trim() || "Pearl Bond",
        facePRL: String($("t-face").value).trim(),
        annualBps: Math.round(ratePct * 100),
        frequency, periods, issueHeight,
      });
      const bond = B.forgeBond(network, terms, { key: xonly, mode: "raw" });
      S.network = network; S.terms = terms; S.bond = bond;
      S.holderPriv = parsed.priv || null;
      S.holderXOnly = xonly;
      const sched = B.couponSchedule(terms);
      const total = B.totalFundingGrains(sched);
      $("t-summary").classList.remove("hidden");
      $("t-summary").innerHTML =
        `<strong>${escapeHtml(terms.name)}</strong> — ${sched.length} tranches, ` +
        `total funding <strong>${prl(total)} PRL</strong>, ` +
        `first coupon at height ${sched[0].lockHeight}, maturity at height ${sched[sched.length - 1].lockHeight}.<br>` +
        `<span class="hint">Holder key source: ${parsed.source || "x-only pubkey (watch-only — paste the mnemonic/privkey in Redeem to sign)"}</span>`;
      renderFund();
      // carry the descriptor + network into the other steps
      for (const id of ["r-desc", "s-desc", "k-desc"]) $(id).value = bond.descriptor;
      if (parsed.priv) { $("r-key").value = $("t-holder").value.trim(); $("s-key").value = $("t-holder").value.trim(); }
      // jump to funding
      document.querySelector('#steps button[data-step="fund"]').click();
    } catch (e) { fail("t-err", e); }
  });

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  /* ---------- STEP 2: schedule & fund ---------- */
  function renderFund() {
    if (!S.bond) return;
    $("f-empty").classList.add("hidden");
    $("f-body").classList.remove("hidden");
    const tb = $("f-table").querySelector("tbody");
    tb.innerHTML = "";
    for (const t of S.bond.tranches) {
      const tr = document.createElement("tr");
      tr.innerHTML =
        `<td>${t.index}</td><td>${escapeHtml(t.kind)}</td>` +
        `<td class="mono">${prl(t.amountGrains)}</td><td class="mono">${t.lockHeight}</td>` +
        `<td class="mono" style="font-size:0.72rem">${t.address}</td>` +
        `<td><button class="copy-btn" data-addr="${t.address}">Copy</button></td>`;
      tb.appendChild(tr);
    }
    tb.querySelectorAll(".copy-btn").forEach((b) =>
      b.addEventListener("click", () => copyText(null, b.dataset.addr)));
    renderPlan();
    $("f-desc").value = S.bond.descriptor;
  }

  function renderPlan() {
    if (!S.bond) return;
    try {
      const feeRate = parseFee($("f-feerate").value);
      const plan = B.fundingPlan(S.bond, feeRate, 1);
      $("f-plan").innerHTML =
        `Fund <strong>${plan.tranches.length}</strong> tranche addresses with exactly their listed amounts.<br>` +
        `Tranche total: <strong>${prl(plan.totalGrains)} PRL</strong> · ` +
        `est. funding fee: <strong>${plan.estFeeGrains.toLocaleString()} grains</strong> (${plan.estVBytes} vB @ ${feeRate} gr/vB) · ` +
        `grand total: <strong>${prl(plan.grandTotalGrains)} PRL</strong>.<br>` +
        `<span class="hint">Single funding input assumed; add inputs in your wallet and re-check the fee. Nothing is locked until these outputs confirm.</span>`;
    } catch (e) { $("f-plan").textContent = "Funding plan: " + e.message; }
  }
  $("f-feerate").addEventListener("input", renderPlan);
  $("f-ytm").addEventListener("click", () => {
    try {
      if (!S.terms) throw new Error("forge a bond first");
      const priceStr = $("f-price").value.trim();
      const priceGrains = priceStr === "" ? S.terms.faceGrains : parsePRL(priceStr);
      const ytm = B.yieldToMaturity(S.terms, priceGrains);
      $("f-ytm-out").textContent = "YTM ≈ " + (ytm * 100).toFixed(3) + "%";
    } catch (e) { $("f-ytm-out").textContent = "error: " + e.message; }
  });
  $("f-copydesc").addEventListener("click", () => copyText("f-copydesc", $("f-desc").value));
  $("f-dl").addEventListener("click", () => {
    if (!S.bond) return;
    const doc = {
      kind: "pearl-bond-term-sheet", version: 1,
      network: S.network.id, terms: S.terms,
      descriptor: S.bond.descriptor,
      tranches: S.bond.tranches.map((t) => ({
        index: t.index, kind: t.kind, address: t.address,
        amountPRL: prl(t.amountGrains), amountGrains: t.amountGrains,
        lockHeight: t.lockHeight,
      })),
      totalPRL: prl(S.bond.totalGrains),
      builtBy: "@kshot9000",
    };
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = (S.terms.name || "pearl-bond").replace(/[^\w\-]+/g, "-") + "-term-sheet.json";
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  });

  /* ---------- STEP 3: redeem ---------- */
  function loadDescriptorInto(fieldId, selectId) {
    const desc = $(fieldId).value.trim();
    if (!desc) throw new Error("paste a bond descriptor");
    const v = B.verifyDescriptor(desc);
    S.network = B.NETWORKS[v.network];
    const sel = $(selectId);
    sel.innerHTML = "";
    for (const t of v.tranches) {
      const o = document.createElement("option");
      o.value = t.index;
      o.textContent = `#${t.index} ${t.kind} — ${prl(t.amountGrains)} PRL @ ${t.lockHeight}`;
      sel.appendChild(o);
    }
    return v;
  }
  let R = null; // loaded descriptor verification
  $("r-load").addEventListener("click", () => {
    clearErr("r-err");
    try { R = loadDescriptorInto("r-desc", "r-tranche"); $("r-err").textContent = ""; }
    catch (e) { fail("r-err", e); }
  });
  $("r-tip").addEventListener("click", async () => {
    clearErr("r-err");
    try { $("r-height").value = String(await fetchTipHeight()); }
    catch (e) { fail("r-err", e); }
  });
  $("r-build").addEventListener("click", async () => {
    clearErr("r-err");
    $("r-out").classList.add("hidden");
    try {
      if (!R) R = loadDescriptorInto("r-desc", "r-tranche");
      const network = S.network;
      const tIdx = Number($("r-tranche").value);
      const { terms, holder } = B.decodeBondDescriptor($("r-desc").value.trim());
      const bond = B.forgeBond(network, terms, holder);
      const tranche = bond.tranches.find((t) => t.index === tIdx);
      if (!tranche) throw new Error("tranche not found");
      const txid = $("r-txid").value.trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(txid)) throw new Error("funding txid must be 64 hex characters");
      const vout = Number($("r-vout").value);
      if (!Number.isInteger(vout) || vout < 0) throw new Error("vout must be a non-negative integer");
      // tranche value: fetch from chain if we can, else ask — use the
      // expected tranche amount (funding must be exact for the plan to be valid)
      const destProgram = B.addressToProgram($("r-dest").value, network);
      let height = $("r-height").value.trim();
      if (height === "") height = await fetchTipHeight();
      else { height = Number(height); if (!Number.isInteger(height) || height < 0) throw new Error("bad height"); }
      const feeRate = parseFee($("r-feerate").value);
      const keyParsed = parseKeyField($("r-key").value, network);
      const priv = resolveSigningKey(keyParsed, network);
      const outpoint = { txid, vout, value: tranche.amountGrains };
      const planned = B.planClaim(network, tranche, outpoint, destProgram, feeRate, height);
      const signed = B.signClaim(network, tranche, planned, priv);
      $("r-meta").innerHTML =
        `Tranche #${tranche.index} (${escapeHtml(tranche.kind)}) — ${prl(tranche.amountGrains)} PRL, ` +
        `lock ${tranche.lockHeight}, chain ${height}.<br>` +
        `Fee: <strong>${signed.feeGrains !== undefined ? signed.feeGrains : planned.fee} grains</strong> (${planned.vBytes} vB) · ` +
        `you receive: <strong>${prl(planned.outputs[0].value)} PRL</strong>.<br>` +
        `<span class="hint">Signature re-verified locally before building. Broadcast with your node or wallet — this page never broadcasts on its own.</span>`;
      $("r-hex").value = signed.hex;
      $("r-txid-out").textContent = "txid " + signed.txid;
      $("r-out").classList.remove("hidden");
    } catch (e) { fail("r-err", e); }
  });
  $("r-copy").addEventListener("click", () => copyText("r-copy", $("r-hex").value));

  /* ---------- STEP 4: transfer ---------- */
  function parseOutpointLine(line) {
    const p = line.trim().split(":");
    if (p.length !== 3) throw new Error(`bad outpoint line (want txid:vout:valueGrains): ${line}`);
    if (!/^[0-9a-fA-F]{64}$/.test(p[0])) throw new Error("bad txid in: " + line);
    const vout = Number(p[1]), value = Number(p[2]);
    if (!Number.isInteger(vout) || vout < 0 || !Number.isSafeInteger(value) || value <= 0) {
      throw new Error("bad vout/value in: " + line);
    }
    return { txid: p[0].toLowerCase(), vout, value };
  }
  function buyerProgramFromInput(raw, network) {
    const t = String(raw || "").trim();
    if (/^[0-9a-fA-F]{64}$/.test(t)) return B.hexToBytes(t.toLowerCase());
    return B.addressToProgram(t, network); // PRL address
  }
  $("s-presign").addEventListener("click", () => {
    clearErr("s-err");
    $("t-pkg-out").classList.add("hidden");
    try {
      const { network, terms, holder } = B.decodeBondDescriptor($("s-desc").value.trim());
      const bond = B.forgeBond(network, terms, holder);
      const keyParsed = parseKeyField($("s-key").value, network);
      const sellerPriv = resolveSigningKey(keyParsed, network);
      const buyerProgram = buyerProgramFromInput($("s-buyer").value, network);
      const idxs = $("s-legs").value.split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
      if (!idxs.length) throw new Error("list at least one tranche index");
      const lines = $("s-outpoints").value.split("\n").map((l) => l.trim()).filter(Boolean);
      if (lines.length !== idxs.length) throw new Error(`need ${idxs.length} outpoint line(s), got ${lines.length}`);
      const feeRate = parseFee($("s-feerate").value);
      const legs = idxs.map((idx, i) => {
        const tranche = bond.tranches.find((t) => t.index === idx);
        if (!tranche) throw new Error("tranche #" + idx + " not in this bond");
        return B.presignTransferLeg(network, tranche, parseOutpointLine(lines[i]), sellerPriv, buyerProgram, feeRate);
      });
      const pkg = { kind: "pearl-bond-transfer", version: 1, descriptor: $("s-desc").value.trim(), legs };
      $("t-pkg").value = JSON.stringify(pkg, null, 2);
      $("t-pkg-out").classList.remove("hidden");
    } catch (e) { fail("s-err", e); }
  });
  $("t-pkgcopy").addEventListener("click", () => copyText("t-pkgcopy", $("t-pkg").value));

  $("b-fill").addEventListener("click", () => {
    clearErr("b-err");
    $("t-fill-out").classList.add("hidden");
    try {
      const pkg = JSON.parse($("b-pkg").value);
      if (!pkg || pkg.kind !== "pearl-bond-transfer" || pkg.version !== 1) throw new Error("bad transfer package");
      const { network, terms, holder } = B.decodeBondDescriptor(pkg.descriptor);
      const bond = B.forgeBond(network, terms, holder);
      if (!Array.isArray(pkg.legs) || !pkg.legs.length) throw new Error("package has no legs");
      // verify every leg before touching money
      for (const leg of pkg.legs) B.verifyTransferLeg(network, leg);
      const priceGrains = parsePRL($("b-price").value);
      const utxo = parseOutpointLine($("b-utxo").value);
      const utxoKeyParsed = parseKeyField($("b-utxokey").value, network);
      const buyerPrivInternal = resolveSigningKey(utxoKeyParsed, network);
      // Buyer pays from a keypath P2TR UTXO: the spendable key is the
      // BIP-86-tweaked key, so derive it (and the tweaked privkey) here.
      const buyerInternalX = utxoKeyParsed.xonly || B.schnorr.getPublicKey(buyerPrivInternal);
      const buyerTweakedX = B.tweakKeypath(buyerInternalX).tweakedX;
      const buyerPriv = B.tweakPrivKeypath(buyerPrivInternal, buyerInternalX);
      const buyerUtxo = { txid: utxo.txid, vout: utxo.vout, value: utxo.value, spk: B.p2trScriptPubKey(buyerTweakedX), priv: buyerPriv };
      const sellerPayProgram = B.addressToProgram($("b-sellerpay").value, network);
      const buyerChangeProgram = B.addressToProgram($("b-change").value, network);
      const feeRate = parseFee($("b-feerate").value);
      const fill = B.buildFillTx(network, pkg.legs, priceGrains, buyerUtxo, sellerPayProgram, buyerChangeProgram, feeRate);
      $("t-fill-meta").innerHTML =
        `Verified <strong>${fill.nLegs}</strong> leg(s). Buyer pays <strong>${prl(fill.buyerPaid)} PRL</strong>, ` +
        `change <strong>${prl(fill.buyerChange)} PRL</strong>, fill fee <strong>${fill.feeGrains.toLocaleString()} grains</strong> (${fill.vBytes} vB).<br>` +
        `<span class="hint">Every seller presignature verified against its digest before building; your payment input is signed SIGHASH_DEFAULT. Broadcast with your node or wallet.</span>`;
      $("t-fill-hex").value = fill.hex;
      $("t-fill-out").classList.remove("hidden");
    } catch (e) { fail("b-err", e); }
  });
  $("t-fill-copy").addEventListener("click", () => copyText("t-fill-copy", $("t-fill-hex").value));

  /* ---------- STEP 5: verify & track ---------- */
  $("k-check").addEventListener("click", async () => {
    clearErr("k-err");
    $("k-out").classList.add("hidden");
    try {
      const desc = $("k-desc").value.trim();
      if (!desc) throw new Error("paste a bond descriptor");
      const v = B.verifyDescriptor(desc);
      const network = B.NETWORKS[v.network];
      const { terms } = B.decodeBondDescriptor(desc);
      const bond = B.forgeBond(network, terms, B.decodeBondDescriptor(desc).holder);
      let height = null, info = {}, src = "unavailable";
      try {
        height = await fetchTipHeight();
        src = "blockbook";
        const rows = await Promise.all(bond.tranches.map((t) => fetchAddrInfo(t.address).catch(() => ({ balance: 0, txs: 0 }))));
        rows.forEach((r, i) => { info[bond.tranches[i].address] = r; });
      } catch (e) {
        src = "offline (" + e.message + ")";
      }
      const rows = B.classifyTranches(bond, { height, info });
      const counts = {};
      for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
      $("k-meta").innerHTML =
        `Descriptor re-derives <strong>${v.tranches.length}</strong> tranches — addresses match.` +
        (v.descriptor === desc ? ` <span class="hint">Round-trip exact.</span>` : ` <span class="err">WARNING: re-encoded descriptor differs!</span>`) +
        `<br>Chain height: <strong>${height === null ? "—" : height}</strong> <span class="hint">(${escapeHtml(src)})</span> · ` +
        Object.entries(counts).map(([k, n]) => `${n}× ${k}`).join(" · ");
      const tb = $("k-table").querySelector("tbody");
      tb.innerHTML = "";
      for (const r of rows) {
        const tr = document.createElement("tr");
        tr.innerHTML =
          `<td>${r.index}</td><td>${escapeHtml(r.kind)}</td>` +
          `<td class="mono" style="font-size:0.72rem">${r.address}</td>` +
          `<td class="mono">${prl(r.amountGrains)}</td><td class="mono">${r.lockHeight}</td>` +
          `<td><span class="status ${r.status}">${r.status}</span></td>`;
        tb.appendChild(tr);
      }
      $("k-out").classList.remove("hidden");
    } catch (e) { fail("k-err", e); }
  });

  /* ---------- footer copy buttons ---------- */
  document.querySelectorAll(".copy-btn[data-for]").forEach((b) => {
    b.addEventListener("click", () => {
      const el = $(b.dataset.for);
      copyText(null, el.textContent.trim());
      const t = b.textContent; b.textContent = "Copied"; setTimeout(() => (b.textContent = t), 1200);
    });
  });
})();
