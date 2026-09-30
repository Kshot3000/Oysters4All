/* Pearl Dividend — mint-hall UI controller.
 *
 * Classic IIFE over window.PearlDividend (div-core) + window.PearlSign/PearlBatch.
 * Six working steps, one verify step. Secrets live in memory only; the desk
 * wipes the key field after every sign.
 */
(function () {
  "use strict";
  const P = window.PearlDividend;
  const PS = P && P.Sign;
  if (!P || !PS) throw new Error("Pearl Dividend bundle failed to load");

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const grainsToPRL = (g) => PS.fmtPRL(BigInt(g));
  const ORDER = ["token", "snapshot", "plan", "fund", "sign", "broadcast", "verify"];

  const S = {
    network: P.NETWORKS.mainnet,
    token: null,          // { tick, decimals, maxSupplyUnits, holderCount, height, indexerBase, indexerStatus, manualMeta }
    tokenFp: null,
    snapCsv: null,
    snapshot: null,       // { descriptor, fingerprint }
    plan: null,           // { descriptor, fingerprint, shares, chunks }
    funded: null,
    utxos: null,
    imported: null,       // imported bundle for the selected chunk
    signed: [],           // [{ chunkIndex, txid, hex, fee }]
    bcast: {},            // chunkIndex -> { txid, confirmations }
    pendingDup: null,
  };

  function err(id, msg) { const e = $(id); e.hidden = !msg; e.textContent = msg || ""; }
  function showStep(name) {
    ORDER.forEach((s) => {
      $("step-" + s).classList.toggle("active", s === name);
    });
    document.querySelectorAll("#steps button").forEach((b) => {
      b.classList.toggle("active", b.dataset.step === name);
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function unlock(upto) {
    const idx = ORDER.indexOf(upto);
    document.querySelectorAll("#steps button").forEach((b) => {
      if (b.dataset.step === "verify") return;
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
  const net = () => ($("tok-network").value === "testnet" ? P.NETWORKS.testnet : P.NETWORKS.mainnet);

  /* ---------- STEP 1: token ---------- */
  $("tok-manual").addEventListener("change", (e) => {
    $("tok-decimals").disabled = !e.target.checked;
    $("tok-maxsupply").disabled = !e.target.checked;
    $("tok-indexer").disabled = e.target.checked;
  });

  $("tok-fetch").addEventListener("click", async () => {
    err("tok-error");
    S.network = net();
    const tick = $("tok-tick").value.trim();
    if (!tick) { err("tok-error", "Enter the token ticker first."); return; }
    $("tok-fetch").disabled = true;
    try {
      let meta;
      if ($("tok-manual").checked) {
        const dec = Math.max(0, Math.min(18, parseInt($("tok-decimals").value, 10) || 0));
        const maxRaw = $("tok-maxsupply").value.trim();
        meta = P.normalizeTokenMeta(
          { tick, decimals: dec, maxSupply: maxRaw || null },
          { tick, indexerBase: null, indexerStatus: null, manualMeta: true }
        );
      } else {
        const base = $("tok-indexer").value.trim().replace(/\/+$/, "");
        if (!base) throw new Error("Enter the Pearlscriptions indexer base URL, or tick the manual-metadata box.");
        const r = await P.fetchTokenMeta(fetch, base, tick);
        if (!r.ok) throw new Error(`indexer read failed (${r.error || "unknown error"}) — check the URL, or use manual metadata.`);
        let status = null;
        try { const rs = await P.fetchIndexerStatus(fetch, base); if (rs.ok) status = rs.data; } catch { /* optional pin */ }
        meta = P.normalizeTokenMeta(r.data, { tick, indexerBase: base, indexerStatus: status });
        if (!meta.tick) throw new Error("the indexer answered but named no ticker — unexpected response shape. Use manual metadata instead.");
      }
      S.token = meta;
      $("tok-r-tick").textContent = meta.tick;
      $("tok-r-max").textContent = meta.maxSupplyUnits == null ? "—" : P.formatTokenUnits(meta.maxSupplyUnits, meta.decimals) + " " + meta.tick.toUpperCase();
      $("tok-r-minted").textContent = meta.mintedUnits == null ? "—" : P.formatTokenUnits(meta.mintedUnits, meta.decimals) + " " + meta.tick.toUpperCase();
      $("tok-r-holders").textContent = meta.holderCount == null ? "—" : Number(meta.holderCount).toLocaleString();
      $("tok-r-dec").textContent = meta.decimals;
      $("tok-r-height").textContent = meta.indexerStatus && meta.indexerStatus.height != null ? Number(meta.indexerStatus.height).toLocaleString() : "—";
      $("tok-r-src").textContent = meta.manualMeta ? "manual — you vouch for it" : "indexer (GET-only)";
      $("tok-result").hidden = false;
      unlock("snapshot");
    } catch (e) { err("tok-error", e.message); }
    finally { $("tok-fetch").disabled = false; }
  });

  /* ---------- STEP 2: snapshot ---------- */
  $("snap-sample").addEventListener("click", () => {
    $("snap-csv").value = P.sampleSnapshotCsv(net());
  });

  function sealSnapshot(csvText, merge) {
    const parsed = P.parseSnapshotCsv(csvText, { network: net(), tick: $("tok-tick").value.trim() || "token" });
    if (parsed.duplicates.length && !merge) { S.pendingDup = { csvText, parsed }; showDups(parsed.duplicates); return; }
    const holders = merge ? P.mergeDuplicateHolders(parsed.holders) : parsed.holders;
    const meta = S.token || {};
    const sealed = P.buildSnapshotDescriptor({
      network: net(), tick: meta.tick || $("tok-tick").value.trim() || "token",
      decimals: meta.decimals ?? 8, holders,
      maxSupplyUnits: meta.maxSupplyUnits != null ? meta.maxSupplyUnits.toString() : null,
      indexerBase: meta.indexerBase || null, indexerStatus: meta.indexerStatus || null,
      manualMeta: !!meta.manualMeta, memo: "",
    });
    S.snapshot = sealed; S.snapCsv = csvText;
    $("snap-dups").hidden = true; S.pendingDup = null;
    $("snap-r-count").textContent = sealed.descriptor.holderCount.toLocaleString();
    $("snap-r-total").textContent = P.formatTokenUnits(BigInt(sealed.descriptor.totalUnits), sealed.descriptor.decimals) + " " + (sealed.descriptor.tick || "").toUpperCase();
    $("snap-r-supply").textContent = supplyLine(sealed.descriptor.supplyCheck);
    $("snap-r-fp").textContent = sealed.fingerprint;
    $("snap-result").hidden = false;
    unlock("plan");
  }
  function supplyLine(sc) {
    if (!sc || sc.status === "unknown") return "unknown (no supply metadata)";
    if (sc.status === "over") return "OVER MAX SUPPLY — refusing to continue until resolved";
    return sc.status === "ok" ? "ok — total within max supply" : sc.status;
  }
  function showDups(dups) {
    $("snap-dups-list").innerHTML = dups.map((d) =>
      `<li>${esc(d.address.slice(0, 20))}… — ${d.count} entries, total ${esc(d.totalUnits)}</li>`).join("");
    $("snap-dups").hidden = false;
    err("snap-error", "Duplicate addresses found — choose merge or refuse above.");
  }
  $("snap-parse").addEventListener("click", () => {
    err("snap-error"); $("snap-result").hidden = true;
    try { sealSnapshot($("snap-csv").value, false); }
    catch (e) { err("snap-error", e.message); }
  });
  $("snap-merge").addEventListener("click", () => {
    if (!S.pendingDup) return;
    err("snap-error");
    try { sealSnapshot(S.pendingDup.csvText, true); }
    catch (e) { err("snap-error", e.message); }
  });
  $("snap-refuse").addEventListener("click", () => {
    $("snap-dups").hidden = true; S.pendingDup = null;
    err("snap-error", "Snapshot refused — fix the CSV and validate again.");
  });
  $("snap-download").addEventListener("click", () => {
    download("dividend-snapshot.json", JSON.stringify({ descriptor: S.snapshot.descriptor, fingerprint: S.snapshot.fingerprint }, null, 2));
  });

  /* ---------- STEP 3: plan ---------- */
  $("plan-rule").addEventListener("change", (e) => {
    $("plan-fixed").disabled = e.target.value !== "fixed";
  });

  $("plan-build").addEventListener("click", async () => {
    err("plan-error"); $("plan-result").hidden = true;
    try {
      if (!S.snapshot) throw new Error("Seal a holder snapshot first (step 2).");
      const funder = $("plan-funder").value.trim();
      if (!funder) throw new Error("Enter the funder address (prl1…) — the remainder returns there.");
      const treasury = $("plan-treasury").value.trim() || null;
      const plan = P.planDividend({
        network: net(),
        snapshot: S.snapshot,
        snapshotFingerprint: S.snapshot.fingerprint,
        rule: $("plan-rule").value,
        fixedPRL: $("plan-fixed").value || "0",
        poolPRL: $("plan-pool").value || "0",
        dustPRL: $("plan-dust").value || "0",
        feeRate: $("plan-feerate").value || "2",
        maxOutputsPerTx: parseInt($("plan-maxtx").value, 10) || 250,
        exclusions: $("plan-exclusions").value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
        minBalanceUnits: ($("plan-minbal").value.trim() || "0"),
        treasuryAddress: treasury,
        funderAddress: funder,
        memo: $("plan-note").value.trim(),
      });
      // drift check against the step-1 read, when available
      let drift = "";
      if (S.token && S.token.indexerBase && !S.token.manualMeta) {
        try {
          const r = await P.fetchTokenMeta(fetch, S.token.indexerBase, S.token.tick);
          if (r.ok) {
            const fresh = P.normalizeTokenMeta(r.data, { tick: S.token.tick, indexerBase: S.token.indexerBase, indexerStatus: null });
            if (P.tokenMetaFingerprint(fresh) !== P.tokenMetaFingerprint(S.token)) {
              drift = " Drift warning: token metadata changed since step 1 (supply or holder count moved) — your snapshot may be stale.";
            }
          } else {
            drift = " Could not re-read the indexer for a drift check — proceeding without one.";
          }
        } catch { drift = " Could not re-read the indexer for a drift check — proceeding without one."; }
      }
      S.plan = plan;
      const d = plan.descriptor;
      const dd = d.dustDropped || { count: 0, grains: "0" };
      const exCount = (plan.shares && plan.shares.excludedCount) || 0;
      $("plan-r-counts").textContent = `${d.eligibleCount.toLocaleString()} eligible · ${d.paidCount.toLocaleString()} paid · ${dd.count.toLocaleString()} dust-dropped · ${exCount.toLocaleString()} excluded`;
      $("plan-r-total").textContent = grainsToPRL(d.totals.recipientsGrains) + " PRL";
      $("plan-r-remainder").textContent = grainsToPRL(d.remainderGrains) + " PRL → " + (d.remainderTo === "treasury" ? "treasury" : d.remainderTo === "funder-change-output" ? "funder (explicit output)" : "folded into funder change");
      $("plan-r-dust").textContent = grainsToPRL(dd.grains) + " PRL across " + dd.count + " holders";
      $("plan-r-chunks").textContent = String(d.chunks.length);
      $("plan-r-fees").textContent = "≈ " + grainsToPRL(plan.chunks.reduce((a, c) => a + BigInt(c.estFeeGrains), 0n)) + " PRL (estimate)";
      $("plan-r-fp").textContent = plan.fingerprint;
      renderShareTable(plan);
      $("plan-result").hidden = false;
      if (drift) err("plan-error", "Note:" + drift);
      unlock("fund");
    } catch (e) { err("plan-error", e.message); }
  });

  function renderShareTable(plan) {
    const tb = $("plan-table-body");
    // map each paid address to its chunk (plan chunks carry the full recipient lists)
    const chunkOf = new Map();
    for (const c of plan.chunks) {
      for (const r of c.recipients) {
        if (r.address) chunkOf.set(String(r.address).toLowerCase(), c.index);
      }
    }
    const paid = plan.shares.paid;
    const max = paid.reduce((a, s) => (s.shareGrains > a ? s.shareGrains : a), 0n);
    const rows = paid.slice(0, 500).map((s, i) => {
      const w = max ? Number((s.shareGrains * 100n) / max) : 0;
      const ci = chunkOf.get(String(s.address).toLowerCase());
      return `<tr><td class="num">${i + 1}</td><td><code>${esc(s.address)}</code></td>` +
        `<td class="num">${esc(P.formatTokenUnits(s.units, plan.descriptor.decimals))}</td>` +
        `<td class="num">${esc(grainsToPRL(s.shareGrains))}<div class="bar"><i style="width:${w}%"></i></div></td>` +
        `<td class="num">${ci == null ? "—" : ci + 1}</td></tr>`;
    }).join("");
    tb.innerHTML = rows + (paid.length > 500
      ? `<tr><td colspan="5" class="note">…and ${(paid.length - 500).toLocaleString()} more — download the plan JSON for the full list.</td></tr>` : "");
  }
  $("plan-download").addEventListener("click", () => {
    download("dividend-plan.json", JSON.stringify({
      descriptor: S.plan.descriptor, fingerprint: S.plan.fingerprint,
      funderAddress: $("plan-funder").value.trim(),
    }, null, 2));
  });

  /* ---------- STEP 4: fund ---------- */
  function collectUtxos() {
    const pasted = $("fund-paste").value.trim();
    if (!pasted) return null;
    return PS.parseUtxoList(pasted, net()).map((u) => ({ txid: u.txid, vout: u.vout, value: u.value }));
  }
  async function fundFrom(utxos) {
    err("fund-error"); $("fund-result").hidden = true;
    if (!S.plan) throw new Error("Build a dividend plan first (step 3).");
    if (!utxos || !utxos.length) throw new Error("No UTXOs — fetch from Blockbook or paste a list.");
    const funder = $("plan-funder").value.trim();
    const funded = P.fundDividend({ network: net(), plan: S.plan, utxos, funderAddress: funder });
    S.funded = funded; S.utxos = utxos;
    $("fund-chunks").innerHTML = funded.fundedChunks.map((fc) => {
      const nPay = fc.plan.outputs.filter((o) => !o.change && !o.remainder).length;
      const outSum = fc.plan.outputs.reduce((a, o) => a + BigInt(o.value), 0n);
      return `
      <div class="chunk-card">
        <h4>Transaction ${fc.index + 1} of ${funded.fundedChunks.length}</h4>
        <div class="kv">
          <div><dt>Holder payouts</dt><dd>${nPay}</dd></div>
          <div><dt>Inputs</dt><dd>${fc.plan.inputs.length} UTXO(s) — ${esc(grainsToPRL(fc.plan.total))} PRL in</dd></div>
          <div><dt>Outputs</dt><dd>${esc(grainsToPRL(outSum))} PRL out · fee ${esc(grainsToPRL(fc.plan.fee))} PRL · change ${esc(grainsToPRL(fc.plan.change))} PRL</dd></div>
        </div>
      </div>`; }).join("");
    $("fund-result").hidden = false;
    // populate sign select
    $("sign-chunk").innerHTML = funded.fundedChunks.map((fc) => {
      const nPay = fc.plan.outputs.filter((o) => !o.change && !o.remainder).length;
      return `<option value="${fc.index}">Transaction ${fc.index + 1} — ${nPay} payouts</option>`; }).join("");
    S.imported = null; S.signed = []; S.bcast = {};
    unlock("sign");
  }
  $("fund-fetch").addEventListener("click", async () => {
    $("fund-fetch").disabled = true;
    try {
      const base = $("fund-blockbook").value.trim();
      if (!base) throw new Error("Enter the Blockbook base URL, or paste UTXOs below.");
      const utxos = await PS.fetchUtxos(base, $("plan-funder").value.trim());
      await fundFrom(utxos);
    } catch (e) { err("fund-error", e.message); }
    finally { $("fund-fetch").disabled = false; }
  });
  $("fund-apply").addEventListener("click", async () => {
    try { await fundFrom(collectUtxos()); }
    catch (e) { err("fund-error", e.message); }
  });

  /* ---------- STEP 5: sign ---------- */
  function currentChunkIndex() { return parseInt($("sign-chunk").value, 10) || 0; }
  $("sign-export").addEventListener("click", () => {
    err("sign-error");
    try {
      if (!S.funded) throw new Error("Fund the plan first (step 4).");
      const b = P.exportChunkBundle({ network: net(), funded: S.funded, chunkIndex: currentChunkIndex() });
      download(`dividend-chunk-${currentChunkIndex() + 1}-unsigned.json`, JSON.stringify(b, null, 2));
      err("sign-error", "Unsigned bundle exported. Move it to the offline machine, sign there, and import the signed result — or paste the bundle into the import box and sign here.");
    } catch (e) { err("sign-error", e.message); }
  });
  $("sign-import").addEventListener("click", () => {
    err("sign-error");
    try {
      const txt = $("sign-bundle").value.trim();
      if (!txt) throw new Error("Paste an unsigned bundle first.");
      const imp = P.importChunkBundle(JSON.parse(txt));
      if (imp.chunkIndex !== currentChunkIndex()) {
        err("sign-error", `Bundle is for transaction ${imp.chunkIndex + 1}, but transaction ${currentChunkIndex() + 1} is selected — refusing to mix them.`);
        return;
      }
      S.imported = imp;
      err("sign-error", `Bundle verified: fingerprint, fee, vBytes and wire digest all match. ${imp.plan.outputs.length} outputs, ${imp.inputs.length} inputs. Safe to sign.`);
    } catch (e) { err("sign-error", e.message); }
  });
  $("sign-sign").addEventListener("click", async () => {
    err("sign-error"); $("sign-result").hidden = true;
    const keyEl = $("sign-key");
    const secret = keyEl.value;
    if (!secret) { err("sign-error", "Paste the funder secret to sign."); return; }
    if (!S.funded) { err("sign-error", "Fund the plan first (step 4)."); return; }
    $("sign-sign").disabled = true;
    try {
      let imp = S.imported;
      if (!imp || imp.chunkIndex !== currentChunkIndex()) {
        const b = P.exportChunkBundle({ network: net(), funded: S.funded, chunkIndex: currentChunkIndex() });
        imp = P.importChunkBundle(b); // in-memory round trip — same guarantees
        S.imported = imp;
      }
      const signed = await P.signChunk({ network: net(), imported: imp, secretText: secret });
      S.signed = S.signed.filter((s) => s.chunkIndex !== signed.chunkIndex).concat([signed]);
      keyEl.value = ""; // wipe
      $("sign-r-txid").textContent = signed.txid;
      $("sign-r-fee").textContent = grainsToPRL(signed.fee) + " PRL";
      $("sign-r-sigs").textContent = `${signed.verifiedCount}/${signed.inputCount} — every input re-verified`;
      $("sign-r-hex").value = signed.hex;
      $("sign-result").hidden = false;
      renderBroadcastList();
      unlock("broadcast");
    } catch (e) { err("sign-error", e.message); }
    finally { $("sign-sign").disabled = false; }
  });
  $("sign-wipe").addEventListener("click", () => { $("sign-key").value = ""; err("sign-error", "Key field wiped."); });

  /* ---------- STEP 6: broadcast ---------- */
  function renderBroadcastList() {
    const list = $("bcast-list");
    if (!S.funded) { list.innerHTML = "<p class='note'>Sign at least one transaction first.</p>"; return; }
    list.innerHTML = S.funded.fundedChunks.map((fc) => {
      const s = S.signed.find((x) => x.chunkIndex === fc.index);
      const b = S.bcast[fc.index];
      const nPay = fc.plan.outputs.filter((o) => !o.change && !o.remainder).length;
      const status = b ? `<span class="st">broadcast · ${b.confirmations} confirmation(s)</span><br><span class="txid">${esc(b.txid)}</span>`
        : s ? `<span class="txid">${esc(s.txid)}</span>` : "<em>not signed yet</em>";
      return `<div class="chunk-card">
        <h4>Transaction ${fc.index + 1} — ${nPay} payouts</h4>
        <p>${status}</p>
        <div class="bcast-row">
          <button data-bcast="${fc.index}" ${s && !b ? "" : "disabled"}>Broadcast</button>
          <button data-bcast-arm="${fc.index}" ${s && !b ? "" : "disabled"} hidden>Confirm broadcast</button>
          <button data-track="${fc.index}" ${b ? "" : "disabled"}>Refresh confirmations</button>
        </div></div>`;
    }).join("");
    list.querySelectorAll("[data-bcast]").forEach((btn) => btn.addEventListener("click", () => {
      const i = +btn.dataset.bcast;
      btn.hidden = true;
      const arm = list.querySelector(`[data-bcast-arm="${i}"]`);
      arm.hidden = false;
      arm.classList.add("danger-arm");
    }));
    list.querySelectorAll("[data-bcast-arm]").forEach((btn) => btn.addEventListener("click", async () => {
      const i = +btn.dataset.bcastArm;
      err("bcast-error");
      btn.disabled = true;
      try {
        const base = $("bcast-blockbook").value.trim();
        if (!base) throw new Error("Enter the Blockbook base URL for broadcast.");
        const s = S.signed.find((x) => x.chunkIndex === i);
        const txid = await PS.broadcastViaBlockbook(base, s.hex);
        S.bcast[i] = { txid, confirmations: 0 };
        renderBroadcastList();
      } catch (e) { err("bcast-error", e.message); btn.disabled = false; }
    }));
    list.querySelectorAll("[data-track]").forEach((btn) => btn.addEventListener("click", async () => {
      const i = +btn.dataset.track;
      err("bcast-error");
      try {
        const base = $("bcast-blockbook").value.trim();
        const r = await P.fetchPayoutTx(fetch, base, S.bcast[i].txid);
        if (!r.ok) throw new Error(`tracking failed (${r.error || "not found"})`);
        S.bcast[i].confirmations = (r.data && r.data.confirmations) || 0;
        renderBroadcastList();
      } catch (e) { err("bcast-error", e.message); }
    }));
  }

  /* ---------- STEP 7: verify ---------- */
  $("ver-run").addEventListener("click", async () => {
    err("ver-error"); $("ver-verdict").hidden = true; $("ver-details").hidden = true;
    $("ver-run").disabled = true;
    try {
      const csv = $("ver-csv").value.trim();
      if (!csv) throw new Error("Paste the holder CSV.");
      const bundle = JSON.parse($("ver-bundle").value.trim() || "{}");
      const lines = $("ver-txids").value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      const base = $("ver-blockbook").value.trim();
      let pasted = [];
      const pj = $("ver-txjson").value.trim();
      if (pj) { pasted = JSON.parse(pj); if (!Array.isArray(pasted)) throw new Error("Payout tx JSON must be an array."); }
      const payouts = [];
      for (const ln of lines) {
        const m = ln.match(/^(\d+)\s*,\s*([0-9a-f]{64})$/i);
        if (!m) throw new Error(`Bad payout line: "${ln}" — expected chunkIndex,txid.`);
        const txid = m[2].toLowerCase();
        const found = pasted.find((t) => (t.txid || "").toLowerCase() === txid);
        let txJson = found || null;
        if (!txJson) {
          if (!base) throw new Error(`No tx data for ${txid.slice(0, 16)}… — paste its Blockbook JSON or set a Blockbook URL.`);
          const r = await P.fetchPayoutTx(fetch, base, txid);
          if (!r.ok) throw new Error(`Blockbook could not return ${txid.slice(0, 16)}… (${r.error || "not found"}) — paste the tx JSON manually.`);
          txJson = r.data;
        }
        payouts.push({ chunkIndex: +m[1], txid, txJson });
      }
      const verdict = P.verifyDividend({ network: net(), snapshotCsvText: csv, dividendBundle: bundle, payouts });
      const v = $("ver-verdict");
      v.hidden = false;
      v.className = "verdict " + (verdict.verdict === "PROVEN" ? "proven" : "unproven");
      v.textContent = verdict.verdict === "PROVEN" ? "✓ PROVEN — every check passed" : "✗ NOT PROVEN — see failing checks";
      const det = $("ver-details");
      det.hidden = false;
      det.innerHTML = verdict.checks.map((c) =>
        `<div class="check ${c.ok ? "ok" : "bad"}"><span class="st">${c.ok ? "✓" : "✗"} ${esc(c.name)}</span><span class="dt">${esc(c.detail)}</span></div>`).join("");
    } catch (e) { err("ver-error", e.message); }
    finally { $("ver-run").disabled = false; }
  });

  // test hook for headless-browser QA (drives the same DOM as a visitor)
  window.__divTest = {
    state: () => S,
    err: (id) => { const e = $(id); return { hidden: e.hidden, text: e.textContent }; },
    click: (id) => $(id).click(),
    set: (id, v) => { $(id).value = v; },
    text: (id) => $(id).textContent,
  };
})();
