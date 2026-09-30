/* Pearl Boost — classic IIFE over window.PearlBoost.
 * Five tabs: Diagnose -> CPFP -> RBF -> Track -> Verify, plus an always-
 * visible Honest Limits panel. All crypto is the audited Sign core
 * (window.PearlBoost.Sign / .Crypto bridge): WIF -> tweaked P2TR key,
 * keypath tx build, per-signature re-verification. No new cryptography.
 * Keys live in page memory only; Wipe + auto-wipe after broadcast.
 */
(() => {
  "use strict";
  const P = window.PearlBoost;
  const DONATE = "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d";
  if (DONATE !== "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d") {
    throw new Error("donation address constant corrupted — refusing to run");
  }

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtPRL = P.Sign.fmtPRL;
  const grains = (g) => `${Number(g).toLocaleString("en-US")} grains (${fmtPRL(g)} PRL)`;

  const S = {
    network: "mainnet",
    backend: P.BLOCKBOOK_MAINNET,
    diag: null,          // diagnoseTx() output
    diagRaw: null,       // raw blockbook tx json
    cpfp: { keys: null, plan: null, signed: null, armed: false },
    rbf: { keys: [], plan: null, signed: null, armed: false, prevouts: [] },
    trackTimer: null,
  };
  const net = () => P.NETWORKS[S.network];

  /* ---------- tabs ---------- */
  $("tabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tab]");
    if (!b) return;
    document.querySelectorAll("#tabs button").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    document.querySelectorAll("main .panel").forEach((p) => p.classList.remove("active"));
    $("tab-" + b.dataset.tab).classList.add("active");
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  $("cfg-network").addEventListener("change", (e) => { S.network = e.target.value; });
  $("cfg-backend").addEventListener("change", (e) => { S.backend = e.target.value.trim() || P.BLOCKBOOK_MAINNET; });

  function validTxid(s) {
    const t = String(s || "").trim();
    if (!/^[0-9a-fA-F]{64}$/.test(t)) throw new Error("txid must be 64 hex characters");
    return t.toLowerCase();
  }

  /* ---------- diagnose ---------- */
  async function diagnoseFromJson(bb) {
    const d = P.diagnoseTx(bb, bb.hex || null);
    S.diag = d;
    S.diagRaw = bb;
    renderDiagnosis(d);
    setupCpfp();
    setupRbf();
    return d;
  }

  function renderDiagnosis(d) {
    const badge = d.confirmed
      ? `<span class="badge bad">CONFIRMED ×${d.confirmations}</span>`
      : `<span class="badge warn">UNCONFIRMED · ${d.confirmations} confirmations</span>`;
    const rbf = d.rbfSignaled
      ? `<span class="badge ok">BIP-125 SIGNALED</span>`
      : `<span class="badge info">no RBF signal</span>`;
    const spentRows = d.vout.map((o) => `<tr><td class="mono">${o.n}</td><td class="mono">${grains(o.value)}</td><td>${o.spent ? "spent" : "unspent"}</td><td class="mono">${o.addresses.map(esc).join("<br>") || "—"}</td></tr>`).join("");
    const seqRows = d.vin.map((i) => `<tr><td class="mono">${i.n}</td><td class="mono">${i.txid ? esc(i.txid.slice(0, 16)) + "…" : "coinbase?"}</td><td class="mono">0x${i.sequence.toString(16).padStart(8, "0")}</td><td>${i.sequence <= P.MAX_RBF_SEQUENCE ? '<span class="badge ok">signals</span>' : "—"}</td></tr>`).join("");
    $("dg-result").innerHTML = `
      <div class="card"><h3>Diagnosis <span class="flame">🔥</span></h3>
        <div class="kv">
          <dt>txid</dt><dd>${esc(d.txid || "—")}</dd>
          <dt>status</dt><dd>${badge}</dd>
          <dt>fee paid</dt><dd>${grains(d.feeGrains)}</dd>
          <dt>vSize</dt><dd>${d.vSize} vB <span class="hint">(${esc(d.vSizeSource)}${d.vSizeEstimated ? " — estimate, treat feerate as approximate" : ""})</span></dd>
          <dt>effective feerate</dt><dd><span class="bigfee">${d.feeRate.toFixed(3)}</span> grains/vB</dd>
          <dt>RBF</dt><dd>${rbf} <span class="hint">explicit signal = any nSequence ≤ 0xfffffffd (pearld MaxRBFSequence)</span></dd>
          <dt>shape</dt><dd>${d.nIn} in / ${d.nOut} out</dd>
        </div>
        ${d.confirmed ? `<div class="errbox">⛔ This transaction is CONFIRMED. It cannot be accelerated — both the CPFP and RBF paths will refuse. Spend the outputs onward instead.</div>` : ""}
        ${!d.rbfSignaled && !d.confirmed ? `<div class="warnbox">No BIP-125 signal: the RBF path is closed for this transaction (pearld only accepts replacements for signaling txs, unless the node operator disabled replacement rejection — not something this page can check). CPFP remains available.</div>` : ""}
        <h3>Outputs</h3>
        <table class="grid"><tr><th>n</th><th>value</th><th>spent?</th><th>address</th></tr>${spentRows}</table>
        <h3>Inputs &amp; sequences</h3>
        <table class="grid"><tr><th>n</th><th>prev tx</th><th>nSequence</th><th>RBF</th></tr>${seqRows}</table>
      </div>`;
  }

  $("dg-go").addEventListener("click", async () => {
    $("dg-result").innerHTML = "";
    try {
      const txid = validTxid($("dg-txid").value);
      const bb = await P.fetchTxDetail(S.backend, txid);
      await diagnoseFromJson(bb);
    } catch (e) { $("dg-result").innerHTML = `<div class="errbox">⛔ ${esc(e.message)}</div>`; }
  });

  $("dg-go-offline").addEventListener("click", () => {
    $("dg-result").innerHTML = "";
    try {
      const bb = JSON.parse($("dg-json").value);
      diagnoseFromJson(bb);
      $("dg-result").insertAdjacentHTML("beforeend", `<div class="okbox">Air-gapped note: diagnosed from pasted JSON — no backend was contacted.</div>`);
    } catch (e) { $("dg-result").innerHTML = `<div class="errbox">⛔ ${esc(e.message)}</div>`; }
  });

  /* ---------- CPFP ---------- */
  function setupCpfp() {
    const d = S.diag;
    const sel = $("cp-output");
    sel.innerHTML = "";
    $("cp-need-diag").style.display = "none";
    const usable = d.vout.filter((o) => !o.spent && o.value > 0);
    for (const o of usable) {
      const opt = document.createElement("option");
      opt.value = String(o.n);
      opt.textContent = `#${o.n} — ${grains(o.value)} — ${(o.addresses[0] || "no address").slice(0, 24)}…`;
      sel.appendChild(opt);
    }
    if (!usable.length) {
      $("cp-planout").innerHTML = `<div class="errbox">⛔ No unspent outputs on this transaction — nothing to build a child from.</div>`;
    }
    $("cp-planout").innerHTML = ""; $("cp-signout").innerHTML = ""; $("cp-bcastout").innerHTML = "";
    $("cp-bcast").disabled = true;
    wipeCpfpKeys();
  }

  function cpfpSelectedOutput() {
    const d = S.diag;
    const n = Number($("cp-output").value);
    const o = d.vout.find((x) => x.n === n);
    if (!o) throw new Error("select an output first");
    if (o.spent) throw new Error(`output #${n} is already spent — pick an unspent one`);
    return o;
  }

  /** Loud key<->address guard: derived tweaked spk must equal the output's
   *  scriptPubKey byte-for-byte (from Blockbook vout.hex), else the address
   *  string must match. Refuses loudly otherwise. */
  function guardKeyMatchesOutput(wallet, out, rawVout) {
    const tweaked = P.tweakKeypath(wallet.internalXOnly).tweakedX;
    const derivedSpk = P.bytesToHex(P.p2trScriptPubKey(tweaked));
    const chainSpk = (rawVout && rawVout.hex ? String(rawVout.hex) : "").toLowerCase();
    if (chainSpk && chainSpk === derivedSpk.toLowerCase()) return { tweaked, spk: P.hexToBytes(chainSpk) };
    if (out.addresses.includes(wallet.address)) {
      return { tweaked, spk: P.hexToBytes(derivedSpk) };
    }
    throw new Error(
      `⛔ KEY/ADDRESS MISMATCH — the WIF derives ${wallet.address}, which does not match output ` +
      `#${out.n}. Refusing: signing with the wrong key would burn the fee and create an invalid child.`
    );
  }

  function readCpfpKey(out) {
    const wif = $("cp-wif").value.trim();
    if (!wif) throw new Error("paste the WIF for this output's key");
    let wallet;
    try { wallet = P.walletFromWIF(wif, net()); }
    catch (e) { throw new Error(`bad WIF: ${e.message}`); }
    const rawVout = (S.diagRaw.vout || []).find((x) => Number(x.n) === out.n);
    const { tweaked, spk } = guardKeyMatchesOutput(wallet, out, rawVout);
    if (S.cpfp.keys && S.cpfp.keys.wallet.priv) S.cpfp.keys.wallet.priv.fill(0); // retire previous
    S.cpfp.keys = { wallet, tweaked, spk };
    return S.cpfp.keys;
  }

  function wipeCpfpKeys() {
    if (S.cpfp.keys && S.cpfp.keys.wallet && S.cpfp.keys.wallet.priv) S.cpfp.keys.wallet.priv.fill(0);
    S.cpfp.keys = null; S.cpfp.signed = null; S.cpfp.plan = null; S.cpfp.armed = false;
    $("cp-wif").value = "";
    const b = $("cp-bcast"); b.disabled = true; b.classList.remove("armed"); b.textContent = "Broadcast child tx";
  }
  $("cp-wipe").addEventListener("click", () => {
    wipeCpfpKeys();
    $("cp-signout").innerHTML = `<div class="okbox">Key wiped from page memory.</div>`;
  });

  $("cp-plan").addEventListener("click", () => {
    $("cp-planout").innerHTML = ""; $("cp-signout").innerHTML = ""; $("cp-bcastout").innerHTML = "";
    try {
      const d = S.diag;
      if (!d) throw new Error("diagnose a transaction first");
      if (d.confirmed) throw new Error("⛔ RBF/CPFP refused: the parent is already CONFIRMED — it cannot be accelerated.");
      if (!d.txid) throw new Error("this diagnosis has no txid (pasted JSON without one) — the child cannot reference its parent. Diagnose via the backend instead.");
      const out = cpfpSelectedOutput();
      const keys = readCpfpKey(out);
      const target = Number($("cp-target").value);
      if (!Number.isFinite(target) || target <= 0) throw new Error("target package feerate must be a positive number");
      const childVBytes = P.keypathTxVBytes(1, 1); // exact: 1 keypath in, 1 keypath out
      const plan = P.planCpfp({
        parentFeeGrains: d.feeGrains, parentVBytes: d.vSize,
        targetRate: target, childVBytes, spendValueGrains: out.value,
      });
      S.cpfp.plan = { plan, out, keys };
      $("cp-planout").innerHTML = `
        <div class="card"><h3>Child plan <span class="flame">🔥</span></h3>
          <div class="kv">
            <dt>spends output</dt><dd>#${out.n} · ${grains(out.value)}</dd>
            <dt>child vSize (exact)</dt><dd>${childVBytes} vB — 1 P2TR keypath in + 1 out</dd>
            <dt>child fee</dt><dd><span class="bigfee">${plan.childFee.toLocaleString("en-US")}</span> grains (${fmtPRL(plan.childFee)} PRL)</dd>
            <dt>child pays to</dt><dd>${esc($("cp-dest").value.trim() || out.addresses[0] || "(same output address)")}</dd>
            <dt>package feerate</dt><dd><span class="bigfee">${plan.packageRate.toFixed(3)}</span> grains/vB</dd>
          </div>
          <p class="hint">Derivation: (${d.feeGrains} + ${plan.childFee}) grains ÷ (${d.vSize} + ${childVBytes}) vB = ${plan.packageRate.toFixed(3)} gr/vB. Child nSequence = 0xfffffffd (RBF-signaled, disclosed).</p>
          <p class="hint">Key↔address guard: <span class="badge ok">MATCH</span> — the WIF derives the output's key.</p>
        </div>`;
    } catch (e) { $("cp-planout").innerHTML = `<div class="errbox">${esc(e.message)}</div>`; }
  });

  $("cp-sign").addEventListener("click", () => {
    $("cp-signout").innerHTML = ""; $("cp-bcastout").innerHTML = "";
    try {
      const st = S.cpfp.plan;
      if (!st) throw new Error("plan the child first");
      const d = S.diag;
      const destAddr = $("cp-dest").value.trim() || st.out.addresses[0];
      if (!destAddr) throw new Error("no destination address available — enter one explicitly");
      const dec = P.decodeBech32m(destAddr, net().hrp);
      if (dec.version !== 1 || dec.program.length !== 32) throw new Error("destination must be a P2TR (v1, 32-byte) address on this network");
      const built = P.Sign.buildKeypathTxEx(
        net(),
        [{ txid: d.txid, vout: st.out.n, value: st.out.value, spk: st.keys.spk, priv: st.keys.wallet.priv, internalXOnly: st.keys.wallet.internalXOnly }],
        [{ program: dec.program, value: st.plan.childOutValue }],
        P.Sign.SIGHASH_DEFAULT,
        0xfffffffd
      );
      // Per-signature re-verification before anything else touches this tx.
      const checks = P.Sign.verifySignedTx(net(), built.hex, [{ value: st.out.value, spk: st.keys.spk }]);
      const allOk = checks.every((c) => c.ok);
      S.cpfp.signed = allOk ? built : null;
      $("cp-signout").innerHTML = `
        <div class="card"><h3>Signed child ${allOk ? '<span class="badge ok">ALL SIGNATURES RE-VERIFIED</span>' : '<span class="badge bad">VERIFICATION FAILED</span>'}</h3>
          <div class="kv">
            <dt>child txid</dt><dd>${built.txid}</dd>
            ${checks.map((c) => `<dt>input #${c.index}</dt><dd>${c.ok ? "✓" : "✗"} ${esc(c.reason)}</dd>`).join("")}
          </div>
          <p class="hint">Raw hex (copy for air-gapped broadcast):</p>
          <p class="mono" style="word-break:break-all;font-size:.75rem">${built.hex}</p>
          <p class="hint">Or via your own node:</p>
          <p class="mono" style="word-break:break-all;font-size:.75rem">${esc(P.pearldBroadcastCmd(built.hex))}</p>
        </div>`;
      $("cp-bcast").disabled = !allOk;
      if (!allOk) throw new Error("signature re-verification failed — the child was NOT kept. Do not broadcast.");
    } catch (e) {
      if (!$("cp-signout").innerHTML) $("cp-signout").innerHTML = `<div class="errbox">${esc(e.message)}</div>`;
      else $("cp-signout").insertAdjacentHTML("beforeend", `<div class="errbox">${esc(e.message)}</div>`);
    }
  });

  $("cp-bcast").addEventListener("click", async () => {
    const st = S.cpfp.signed;
    if (!st) return;
    const btn = $("cp-bcast");
    if (!S.cpfp.armed) {
      S.cpfp.armed = true;
      btn.classList.add("armed");
      btn.textContent = `⚠ Click again to CONFIRM broadcast of ${st.txid.slice(0, 16)}…`;
      $("cp-bcastout").innerHTML = `<div class="warnbox">Double-confirm gate: this will submit the child to <code>${esc(S.backend)}</code>. The fee (${st ? "" : ""}${S.cpfp.plan.plan.childFee.toLocaleString("en-US")} grains) becomes unrecoverable once mined. Click again only if you mean it.</div>`;
      return;
    }
    btn.disabled = true;
    try {
      const txid = await P.broadcastViaBlockbook(S.backend, st.hex);
      $("cp-bcastout").innerHTML = `<div class="okbox">✅ Child broadcast accepted — txid <code class="mono">${esc(txid)}</code>. Track it in tab 4. Keys wiped.</div>`;
      wipeCpfpKeys();
    } catch (e) {
      $("cp-bcastout").innerHTML = `<div class="errbox">⛔ ${esc(e.message)}<br><span class="hint">The signed child is preserved above — you can broadcast it manually with the pearld one-liner. Keys were NOT wiped (you may still need them); use Wipe key when done.</span></div>`;
      S.cpfp.armed = false; btn.classList.remove("armed"); btn.textContent = "Broadcast child tx"; btn.disabled = false;
    }
  });

  /* ---------- RBF ---------- */
  function setupRbf() {
    const d = S.diag;
    $("rbf-planout").innerHTML = ""; $("rbf-signout").innerHTML = ""; $("rbf-bcastout").innerHTML = "";
    $("rbf-bcast").disabled = true;
    wipeRbfKeys();
    const wrap = $("rbf-wifs");
    wrap.innerHTML = "";
    $("rbf-need-diag").style.display = "none";
    if (!d) return;
    if (d.confirmed) {
      $("rbf-planout").innerHTML = `<div class="errbox">⛔ RBF refused: the transaction is already CONFIRMED.</div>`;
      return;
    }
    if (!d.rbfSignaled) {
      $("rbf-planout").innerHTML = `<div class="errbox">⛔ RBF refused: this transaction does not signal BIP-125 (no input with nSequence ≤ 0xfffffffd). pearld will reject a replacement. Use CPFP instead.</div>`;
      return;
    }
    d.vin.forEach((inp, i) => {
      const row = document.createElement("div");
      row.className = "wifrow";
      row.innerHTML = `<div class="who">input #${i} · spends ${inp.txid ? esc(inp.txid.slice(0, 20)) + "…" : "?"}:${inp.vout ?? "?"} · seq 0x${inp.sequence.toString(16).padStart(8, "0")} · ${(inp.addresses[0] || "unknown address").slice(0, 30)}</div>
        <label>WIF for input #${i} <input type="password" data-rbf-wif="${i}" spellcheck="false" autocomplete="off"></label>
        <div class="hint">in-memory only</div>`;
      wrap.appendChild(row);
    });
    const fs = $("rbf-feesrc");
    fs.innerHTML = "";
    d.vout.forEach((o) => {
      const opt = document.createElement("option");
      opt.value = String(o.n);
      opt.textContent = `#${o.n} — ${grains(o.value)} — ${(o.addresses[0] || "no address").slice(0, 24)}…`;
      fs.appendChild(opt);
    });
    if (!$("rbf-target").value) $("rbf-target").value = (d.feeRate * 2).toFixed(1);
  }

  function clearRbfKeyMaterial() {
    for (const k of S.rbf.keys) { if (k.wallet && k.wallet.priv) k.wallet.priv.fill(0); }
    S.rbf.keys = []; S.rbf.signed = null; S.rbf.plan = null; S.rbf.armed = false; S.rbf.prevouts = [];
  }
  function wipeRbfKeys() {
    clearRbfKeyMaterial();
    document.querySelectorAll("[data-rbf-wif]").forEach((el) => { el.value = ""; });
    const b = $("rbf-bcast"); b.disabled = true; b.classList.remove("armed"); b.textContent = "Broadcast replacement";
  }
  $("rbf-wipe").addEventListener("click", () => {
    wipeRbfKeys();
    $("rbf-signout").innerHTML = `<div class="okbox">Keys wiped from page memory.</div>`;
  });

  /** Load + guard all input keys; fetch each prevout for value + scriptPubKey. */
  async function loadRbfInputs() {
    const d = S.diag;
    clearRbfKeyMaterial(); // wipe previous in-memory keys, keep the DOM fields we are about to read
    const prevouts = [];
    const keys = [];
    for (let i = 0; i < d.vin.length; i++) {
      const inp = d.vin[i];
      const wifEl = document.querySelector(`[data-rbf-wif="${i}"]`);
      const wif = (wifEl && wifEl.value.trim()) || "";
      if (!wif) throw new Error(`paste the WIF for input #${i}`);
      let wallet;
      try { wallet = P.walletFromWIF(wif, net()); }
      catch (e) { throw new Error(`input #${i}: bad WIF (${e.message})`); }
      if (!inp.txid || inp.vout == null) throw new Error(`input #${i}: no prevout reference — cannot rebuild faithfully`);
      // Fetch the prevout for value + scriptPubKey (Blockbook tx detail).
      let prev;
      try { prev = await P.fetchTxDetail(S.backend, inp.txid); }
      catch (e) { throw new Error(`input #${i}: cannot fetch prevout ${inp.txid.slice(0, 16)}… — ${e.message}`); }
      const po = (prev.vout || []).find((x) => Number(x.n) === inp.vout);
      if (!po) throw new Error(`input #${i}: prevout #${inp.vout} not found on chain`);
      const spkHex = String(po.hex || "").toLowerCase();
      if (!spkHex) throw new Error(`input #${i}: prevout has no scriptPubKey hex — refusing`);
      const derivedSpk = P.bytesToHex(P.p2trScriptPubKey(P.tweakKeypath(wallet.internalXOnly).tweakedX)).toLowerCase();
      if (derivedSpk !== spkHex) {
        throw new Error(`⛔ KEY/ADDRESS MISMATCH on input #${i} — the WIF derives ${wallet.address}, but the prevout script is different. Refusing: wrong-key signatures are invalid and burn fees.`);
      }
      prevouts.push({ txid: inp.txid, vout: inp.vout, value: Number(po.value), spk: P.hexToBytes(spkHex) });
      keys.push({ wallet, internalXOnly: wallet.internalXOnly, priv: wallet.priv });
    }
    S.rbf.prevouts = prevouts;
    S.rbf.keys = keys;
    return { prevouts, keys };
  }

  $("rbf-plan").addEventListener("click", async () => {
    $("rbf-planout").innerHTML = ""; $("rbf-signout").innerHTML = ""; $("rbf-bcastout").innerHTML = "";
    try {
      const d = S.diag;
      if (!d) throw new Error("diagnose a transaction first");
      if (d.confirmed) throw new Error("⛔ RBF refused: the transaction is already CONFIRMED.");
      if (!d.rbfSignaled) throw new Error("⛔ RBF refused: no BIP-125 signal on this transaction.");
      const { prevouts } = await loadRbfInputs();
      const fsN = Number($("rbf-feesrc").value);
      const fsOut = d.vout.find((x) => x.n === fsN);
      if (!fsOut) throw new Error("choose the fee-source output");
      const target = Number($("rbf-target").value);
      if (!Number.isFinite(target) || target <= 0) throw new Error("target feerate must be a positive number");
      const plan = P.planRbf({
        oldFeeGrains: d.feeGrains, oldVBytes: d.vSize,
        targetRate: target, feeSourceValue: fsOut.value,
      });
      S.rbf.plan = { plan, fsOut, prevouts };
      $("rbf-planout").innerHTML = `
        <div class="card"><h3>Replacement plan <span class="flame">🔥</span></h3>
          <div class="kv">
            <dt>old fee / rate</dt><dd>${grains(d.feeGrains)} · ${d.feeRate.toFixed(3)} gr/vB</dd>
            <dt>new fee / rate</dt><dd><span class="bigfee">${plan.newFee.toLocaleString("en-US")}</span> grains · <span class="bigfee">${plan.targetRate}</span> gr/vB</dd>
            <dt>fee bump (Δ)</dt><dd>${plan.feeDelta.toLocaleString("en-US")} grains — trimmed from output #${fsOut.n}</dd>
            <dt>fee-source after trim</dt><dd>${grains(plan.newFeeSourceValue)} (≥ 546 dust ✓)</dd>
            <dt>min-relay check</dt><dd>${plan.newFee.toLocaleString()} &gt; ${plan.oldFee.toLocaleString()} + ${plan.minRelayEstimate} (est. per pearld policy.go) ✓</dd>
            <dt>inputs</dt><dd>${prevouts.length} — same outpoints, key↔script guard <span class="badge ok">MATCH</span> on all</dd>
            <dt>outputs</dt><dd>${d.vout.length} — identical, except #${fsOut.n} trimmed</dd>
            <dt>nSequence</dt><dd>0xfffffffd on all inputs (RBF-signaled, disclosed)</dd>
            <dt>version</dt><dd>${net().txVersion} (audited keypath builder; disclosed)</dd>
          </div>
          <p class="hint">pearld rules enforced: strictly higher feerate, absolute fee &gt; old fee + min-relay, same inputs (no new unconfirmed spends), dust floor honored.</p>
        </div>`;
    } catch (e) { $("rbf-planout").innerHTML = `<div class="errbox">${esc(e.message)}</div>`; }
  });

  $("rbf-sign").addEventListener("click", () => {
    $("rbf-signout").innerHTML = ""; $("rbf-bcastout").innerHTML = "";
    try {
      const st = S.rbf.plan;
      if (!st) throw new Error("plan the replacement first");
      const d = S.diag;
      const rawVouts = S.diagRaw.vout || [];
      const outputs = d.vout.map((o) => {
        const raw = rawVouts.find((x) => Number(x.n) === o.n);
        const addr = (raw && raw.addresses && raw.addresses[0]) || o.addresses[0];
        if (!addr) throw new Error(`output #${o.n} has no address — cannot rebuild faithfully, refusing`);
        const dec = P.decodeBech32m(addr, net().hrp);
        if (dec.version !== 1 || dec.program.length !== 32) throw new Error(`output #${o.n} is not P2TR — refusing`);
        const value = o.n === st.fsOut.n ? st.plan.newFeeSourceValue : o.value;
        return { program: dec.program, value };
      });
      const inputs = st.prevouts.map((po, i) => ({
        txid: po.txid, vout: po.vout, value: po.value, spk: po.spk,
        priv: S.rbf.keys[i].priv, internalXOnly: S.rbf.keys[i].internalXOnly,
      }));
      const built = P.Sign.buildKeypathTxEx(net(), inputs, outputs, P.Sign.SIGHASH_DEFAULT, 0xfffffffd);
      const checks = P.Sign.verifySignedTx(net(), built.hex, st.prevouts.map((po) => ({ value: po.value, spk: po.spk })));
      const allOk = checks.every((c) => c.ok);
      S.rbf.signed = allOk ? built : null;
      $("rbf-signout").innerHTML = `
        <div class="card"><h3>Signed replacement ${allOk ? '<span class="badge ok">ALL SIGNATURES RE-VERIFIED</span>' : '<span class="badge bad">VERIFICATION FAILED</span>'}</h3>
          <div class="kv">
            <dt>replacement txid</dt><dd>${built.txid}</dd>
            ${checks.map((c) => `<dt>input #${c.index}</dt><dd>${c.ok ? "✓" : "✗"} ${esc(c.reason)}</dd>`).join("")}
          </div>
          <p class="mono" style="word-break:break-all;font-size:.75rem">${built.hex}</p>
          <p class="mono" style="word-break:break-all;font-size:.75rem">${esc(P.pearldBroadcastCmd(built.hex))}</p>
        </div>`;
      $("rbf-bcast").disabled = !allOk;
      if (!allOk) throw new Error("signature re-verification failed — the replacement was NOT kept. Do not broadcast.");
    } catch (e) {
      if (!$("rbf-signout").innerHTML) $("rbf-signout").innerHTML = `<div class="errbox">${esc(e.message)}</div>`;
      else $("rbf-signout").insertAdjacentHTML("beforeend", `<div class="errbox">${esc(e.message)}</div>`);
    }
  });

  $("rbf-bcast").addEventListener("click", async () => {
    const st = S.rbf.signed;
    if (!st) return;
    const btn = $("rbf-bcast");
    if (!S.rbf.armed) {
      S.rbf.armed = true;
      btn.classList.add("armed");
      btn.textContent = `⚠ Click again to CONFIRM broadcast of ${st.txid.slice(0, 16)}…`;
      $("rbf-bcastout").innerHTML = `<div class="warnbox">Double-confirm gate: this submits a <strong>replacement</strong> to <code>${esc(S.backend)}</code>. If the relay or miners reject it, the original stays — nothing is lost but the attempt. The extra ${S.rbf.plan.plan.feeDelta.toLocaleString("en-US")} grains are unrecoverable once mined. Click again only if you mean it.</div>`;
      return;
    }
    btn.disabled = true;
    try {
      const txid = await P.broadcastViaBlockbook(S.backend, st.hex);
      $("rbf-bcastout").innerHTML = `<div class="okbox">✅ Replacement broadcast accepted — txid <code class="mono">${esc(txid)}</code>. Track it in tab 4. Keys wiped.</div>`;
      wipeRbfKeys();
    } catch (e) {
      $("rbf-bcastout").innerHTML = `<div class="errbox">⛔ ${esc(e.message)}<br><span class="hint">The signed replacement is preserved above — broadcast it manually with the pearld one-liner if you prefer. Keys were NOT wiped; use Wipe keys when done.</span></div>`;
      S.rbf.armed = false; btn.classList.remove("armed"); btn.textContent = "Broadcast replacement"; btn.disabled = false;
    }
  });

  /* ---------- track ---------- */
  function stopTrack() {
    if (S.trackTimer) { clearInterval(S.trackTimer); S.trackTimer = null; }
  }
  $("tr-stop").addEventListener("click", () => {
    stopTrack();
    $("tr-result").insertAdjacentHTML("beforeend", `<div class="warnbox">Tracking stopped by user.</div>`);
  });

  async function pollTrack(txid) {
    try {
      const bb = await P.fetchTxDetail(S.backend, txid);
      const conf = Number(bb.confirmations || 0);
      if (conf > 0) {
        stopTrack();
        $("tr-result").innerHTML = `<div class="verdict proven">CONFIRMED ×${conf}</div>
          <div class="okbox">Transaction <code class="mono">${esc(txid)}</code> has ${conf} confirmation(s). The boost worked — stand down. 🚀</div>`;
      } else {
        $("tr-result").innerHTML = `<div class="card"><h3>Tracking <span class="flame">🔥</span></h3>
          <div class="kv"><dt>txid</dt><dd>${esc(txid)}</dd><dt>confirmations</dt><dd>0 — still in mempool (or unpropagated)</dd><dt>backend</dt><dd>${esc(S.backend)}</dd></div>
          <p class="hint">Polling every 15 s…</p></div>`;
      }
    } catch (e) {
      $("tr-result").innerHTML = `<div class="errbox">⛔ Track poll failed: ${esc(e.message)}</div>`;
    }
  }

  $("tr-go").addEventListener("click", async () => {
    stopTrack();
    $("tr-result").innerHTML = "";
    try {
      const txid = validTxid($("tr-txid").value);
      await pollTrack(txid);
      if (!$("tr-result").querySelector(".verdict")) {
        S.trackTimer = setInterval(() => pollTrack(txid), 15000);
      }
    } catch (e) { $("tr-result").innerHTML = `<div class="errbox">⛔ ${esc(e.message)}</div>`; }
  });

  /* ---------- verify ---------- */
  $("vf-go").addEventListener("click", async () => {
    $("vf-result").innerHTML = "";
    try {
      const pTxid = validTxid($("vf-parent").value);
      const cRaw = $("vf-child").value.trim();
      const cTxid = cRaw ? validTxid(cRaw) : null;
      const claimed = Number($("vf-claimed").value);
      if (!Number.isFinite(claimed) || claimed < 0) throw new Error("claimed feerate must be a non-negative number");
      const pBb = await P.fetchTxDetail(S.backend, pTxid);
      const pDiag = P.diagnoseTx(pBb, pBb.hex || null);
      let child = { feeGrains: 0, vBytes: 0, txid: null };
      if (cTxid) {
        const cBb = await P.fetchTxDetail(S.backend, cTxid);
        const cDiag = P.diagnoseTx(cBb, cBb.hex || null);
        child = { feeGrains: cDiag.feeGrains, vBytes: cDiag.vSize, txid: cTxid };
      }
      const v = P.verifyPackageClaim(
        { feeGrains: pDiag.feeGrains, vBytes: pDiag.vSize },
        child, claimed
      );
      $("vf-result").innerHTML = `
        <div class="verdict ${v.proven ? "proven" : "notproven"}">${v.proven ? "✓ PROVEN" : "✗ NOT PROVEN"}</div>
        <div class="card"><h3>Derivation</h3>
          <table class="grid"><tr><th></th><th>fee (grains)</th><th>vSize (vB)</th></tr>
          <tr><td class="mono">parent ${esc(pTxid.slice(0, 16))}…</td><td class="mono">${pDiag.feeGrains}</td><td class="mono">${pDiag.vSize}${pDiag.vSizeEstimated ? " (est.)" : ""}</td></tr>
          ${cTxid ? `<tr><td class="mono">child ${esc(cTxid.slice(0, 16))}…</td><td class="mono">${child.feeGrains}</td><td class="mono">${child.vBytes}</td></tr>` : ""}
          <tr><td><strong>package</strong></td><td class="mono"><strong>${v.num.toString()}</strong></td><td class="mono"><strong>${v.den.toString()}</strong></td></tr></table>
          <div class="kv"><dt>computed</dt><dd>${v.num} ÷ ${v.den} = <span class="bigfee">${v.computedRate.toFixed(4)}</span> gr/vB</dd>
          <dt>claimed</dt><dd>${v.claimedRate} gr/vB</dd>
          <dt>ruling</dt><dd>${v.proven ? "computed ≥ claimed → PROVEN" : "computed < claimed → NOT PROVEN"}</dd></div>
        </div>`;
    } catch (e) { $("vf-result").innerHTML = `<div class="errbox">⛔ ${esc(e.message)}</div>`; }
  });

  /* ---------- key hygiene on unload ---------- */
  window.addEventListener("beforeunload", () => { wipeCpfpKeys(); wipeRbfKeys(); });

  /* ---------- test hooks ---------- */
  window.__boostTest = {
    state: S,
    validTxid,
    diagnoseFromJson,
    net,
  };
})();
