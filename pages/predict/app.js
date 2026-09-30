/* Pearl Predict UI — drives window.PearlPredict (committed esbuild bundle).
 * Plain classic script, no build step. All signing is local; keys live only in
 * memory (wipe buttons) and never in the persisted state. */
(function () {
  "use strict";
  const P = window.PearlPredict;
  if (!P) { document.body.innerHTML = "<p style='padding:2rem'>PearlPredict bundle failed to load.</p>"; return; }

  const el = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const LS_KEY = "pearl-predict-v1";

  const S = {
    norm: null, canonical: "", descriptor: "", contracts: [],
    positions: [], tip: null, blockbook: "https://blockbook.pearlresearch.ai",
    bundle: null, voidBundle: null,
  };

  function setErr(id, msg) { const e = el(id); if (e) e.textContent = msg || ""; }
  function fmtPRLg(g) { try { return P.fmtPRL(BigInt(g)) + " PRL"; } catch { return String(g) + " grains"; } }
  function shortAddr(a) { return a.length > 24 ? a.slice(0, 14) + "…" + a.slice(-8) : a; }

  function copyText(t, btn) {
    const done = () => { if (btn) { const o = btn.textContent; btn.textContent = "copied ✓"; setTimeout(() => { btn.textContent = o; }, 1200); } };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(t).then(done, () => fallbackCopy(t, done));
      } else fallbackCopy(t, done);
    } catch { fallbackCopy(t, done); }
  }
  function fallbackCopy(t, done) {
    try {
      const ta = document.createElement("textarea");
      ta.value = t; document.body.appendChild(ta); ta.select();
      document.execCommand("copy"); document.body.removeChild(ta); done();
    } catch { /* clipboard unavailable — user can select manually */ }
  }
  function download(name, text) {
    const blob = new Blob([text], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  /* ---------------- tabs ---------------- */
  const tabBtns = Array.from(document.querySelectorAll("#steps button"));
  function showTab(name) {
    tabBtns.forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    ["create", "fund", "resolve", "track", "verify"].forEach((t) => {
      el("tab-" + t).hidden = t !== name;
    });
  }
  tabBtns.forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

  /* ---------------- persistence ---------------- */
  function save() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        canonical: S.canonical, positions: S.positions,
        blockbook: S.blockbook, tip: S.tip,
      }));
    } catch { /* storage unavailable */ }
  }
  function loadPersisted() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return false;
      const d = JSON.parse(raw);
      if (!d.canonical) return false;
      if (loadMarketFromCanonical(d.canonical)) {
        S.positions = Array.isArray(d.positions) ? d.positions : [];
        if (d.blockbook) { S.blockbook = d.blockbook; el("c-blockbook").value = d.blockbook; }
        if (Number.isSafeInteger(d.tip)) S.tip = d.tip;
        return true;
      }
    } catch { /* ignore */ }
    return false;
  }
  function loadMarketFromCanonical(canonical) {
    try {
      const parsed = JSON.parse(canonical);
      const norm = P.validateMarketSpec({
        question: parsed.question, outcomes: parsed.outcomes, source: parsed.source,
        tradeH: parsed.tradeH, resolveH: parsed.resolveH,
        arbiterKeyInput: parsed.arbiter, refundKeyInput: parsed.refund, hrp: parsed.hrp,
      });
      S.norm = norm; S.canonical = canonical;
      S.descriptor = P.marketDescriptor(norm);
      S.contracts = P.allOutcomeContracts(norm);
      return true;
    } catch { return false; }
  }

  /* ---------------- ticker ---------------- */
  (function ticker() {
    const items = [
      "PEARL PREDICT", "NO SMART CONTRACTS", "TAPROOT ONLY", "194 S BLOCK TARGET",
      "546 GRAIN DUST FLOOR", "ARBITER-SIGNED PAYOUTS", "CLTV VOID REFUNDS",
      "DESCRIPTOR-COMMITTED MARKETS", "VERIFY BEFORE YOU TRUST",
    ];
    const half = items.map((t) => `<b>◆</b> ${esc(t)} `).join("");
    el("ticker-tape").innerHTML = half + half;
  })();

  /* ---------------- CREATE ---------------- */
  async function fetchTip() {
    const bb = el("c-blockbook").value.trim() || S.blockbook;
    setErr("c-err", "");
    el("c-tip-status").textContent = "Fetching tip from " + bb + " …";
    try {
      const r = await fetch(bb.replace(/\/$/, "") + "/api/v2");
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      const h = j && j.backend && j.backend.blocks;
      if (!Number.isSafeInteger(h)) throw new Error("unexpected response shape");
      S.tip = h; S.blockbook = bb;
      el("c-tip").value = String(h);
      el("c-tip-status").textContent = "Live tip: block " + h + " (" + new Date().toLocaleTimeString() + ")";
      save();
    } catch (e) {
      el("c-tip-status").textContent = "";
      setErr("c-err", "Could not fetch the live tip (" + e.message + "). Enter the tip by hand for air-gapped sealing, or retry.");
    }
  }
  el("c-fetch-tip").addEventListener("click", fetchTip);

  el("c-build").addEventListener("click", () => {
    setErr("c-err", "");
    try {
      const outcomes = [el("c-o0").value, el("c-o1").value, el("c-o2").value, el("c-o3").value]
        .map((s) => s.trim()).filter((s) => s.length > 0);
      const tipRaw = el("c-tip").value.trim();
      const tip = tipRaw === "" ? null : Number(tipRaw);
      if (tipRaw !== "" && (!Number.isSafeInteger(tip) || tip <= 0)) throw new Error("tip height must be a positive integer");
      const norm = P.validateMarketSpec({
        question: el("c-question").value,
        outcomes,
        source: el("c-source").value,
        tradeH: Number(el("c-tradeh").value),
        resolveH: Number(el("c-resolveh").value),
        arbiterKeyInput: el("c-arbiter").value,
        refundKeyInput: el("c-refund").value,
        hrp: el("c-hrp").value,
      }, tip);
      S.norm = norm;
      S.canonical = P.canonicalMarketJSON(norm);
      S.descriptor = P.marketDescriptor(norm);
      S.contracts = P.allOutcomeContracts(norm);
      if (tip !== null) S.tip = tip;
      S.blockbook = el("c-blockbook").value.trim() || S.blockbook;
      S.positions = [];
      renderCommitment();
      save();
      el("c-commit-card").hidden = false;
      showTab("fund"); // advance the desk: the market is sealed, time to fund
    } catch (e) {
      setErr("c-err", "MARKET REFUSED: " + e.message);
    }
  });

  function renderCommitment() {
    const n = S.norm;
    el("c-descriptor").textContent = S.descriptor;
    el("c-addresses").innerHTML = S.contracts.map((c, i) => `
      <div class="ocard">
        <h4>${esc(n.outcomes[i])}</h4>
        <div class="addr">${esc(c.address)}</div>
        <div class="btnrow">
          <button class="ghost small" data-copy-addr="${esc(c.address)}">copy</button>
        </div>
        <div class="kv">
          <dt>internal key</dt><dd>${P.bytesToHex(c.internalXOnly).slice(0, 24)}… (NUMS)</dd>
          <dt>leaf A</dt><dd>award · &lt;arbiter&gt; CHECKSIG</dd>
          <dt>leaf B</dt><dd>refund · &lt;${n.resolveH}&gt; CLTV DROP &lt;key&gt; CHECKSIG</dd>
        </div>
      </div>`).join("");
    el("c-addresses").querySelectorAll("[data-copy-addr]").forEach((b) =>
      b.addEventListener("click", () => copyText(b.dataset.copyAddr, b)));
  }
  el("c-copy-desc").addEventListener("click", (e) => copyText(S.descriptor, e.target));
  el("c-dl-market").addEventListener("click", () => download("pearl-predict-market.json", S.canonical));
  el("c-copy-addrs").addEventListener("click", (e) =>
    copyText(S.contracts.map((c, i) => `${S.norm.outcomes[i]}: ${c.address}`).join("\n"), e.target));

  /* ---------------- FUND ---------------- */
  function needMarket() {
    if (!S.norm) { setErr("f-err", "Load a market first — create one on the Create tab or load from a descriptor."); return false; }
    return true;
  }
  function marketLine() {
    el("f-market-line").textContent = S.norm ? S.descriptor : "(no market loaded)";
  }
  el("f-load-created").addEventListener("click", () => {
    if (loadPersisted() || S.norm) { setErr("f-err", ""); marketLine(); renderFund(); }
    else setErr("f-err", "No saved market in this browser yet — create one on the Create tab.");
  });
  el("f-load-desc").addEventListener("click", () => {
    const d = prompt("Paste the pearl-predict descriptor:");
    if (!d) return;
    const m = prompt("Paste the canonical market JSON for that descriptor:");
    if (!m) return;
    try {
      const parsed = JSON.parse(m);
      const norm = P.validateMarketSpec({
        question: parsed.question, outcomes: parsed.outcomes, source: parsed.source,
        tradeH: parsed.tradeH, resolveH: parsed.resolveH,
        arbiterKeyInput: parsed.arbiter, refundKeyInput: parsed.refund, hrp: parsed.hrp,
      });
      const v = P.verifyMarketDescriptor(norm, d);
      if (!v.ok) throw new Error("descriptor does not match the market JSON: " + v.failures.join("; "));
      S.norm = norm; S.canonical = m; S.descriptor = d;
      S.contracts = P.allOutcomeContracts(norm);
      S.positions = [];
      save(); setErr("f-err", ""); marketLine(); renderFund();
    } catch (e) { setErr("f-err", "LOAD REFUSED: " + e.message); }
  });

  function potTotals() {
    const pots = S.norm.outcomes.map(() => 0);
    for (const p of S.positions) pots[p.outcomeIndex] += p.value;
    return pots;
  }
  function tradingOpen() {
    if (S.tip === null || S.tip === undefined) return null; // unknown
    return S.tip < S.norm.tradeH;
  }

  function renderFund() {
    marketLine();
    if (!S.norm) { el("f-outcomes").innerHTML = ""; return; }
    const pots = potTotals();
    const probs = P.impliedProbabilities(pots);
    const open = tradingOpen();
    const cd = S.tip !== null && S.tip !== undefined
      ? P.blocksToCountdown(S.norm.tradeH - S.tip) : "tip unknown";
    el("f-outcome").innerHTML = S.norm.outcomes.map((o, i) => `<option value="${i}">${esc(o)}</option>`).join("");
    el("r-win").innerHTML = el("f-outcome").innerHTML;
    el("f-outcomes").innerHTML = `<div class="ocards">` + S.contracts.map((c, i) => `
      <div class="ocard">
        <h4>${esc(S.norm.outcomes[i])} <span class="prob">${(probs[i] * 100).toFixed(1)}%</span></h4>
        <div class="addr">${esc(c.address)}</div>
        <div class="pot">${fmtPRLg(pots[i])}</div>
        <div class="muted small">${S.positions.filter((p) => p.outcomeIndex === i).length} position(s) tracked</div>
        <div class="btnrow"><button class="ghost small" data-copy-addr="${esc(c.address)}">copy address</button></div>
      </div>`).join("") + `</div>
      <p class="muted small">Trading ${open === null ? "window unknown (no tip)" : open ? "OPEN" : "CLOSED"} · deadline block ${S.norm.tradeH} · countdown ${esc(cd)} · tip ${S.tip ?? "—"}</p>`;
    el("f-outcomes").querySelectorAll("[data-copy-addr]").forEach((b) =>
      b.addEventListener("click", () => copyText(b.dataset.copyAddr, b)));
    renderPositions();
  }

  function renderPositions() {
    const tb = el("f-table").querySelector("tbody");
    tb.innerHTML = S.positions.map((p, i) => `
      <tr>
        <td>${esc(S.norm.outcomes[p.outcomeIndex])}</td>
        <td class="mono">${esc(p.txid.slice(0, 12))}…:${p.vout}</td>
        <td class="num">${fmtPRLg(p.value)}</td>
        <td><input type="text" data-pa="${i}" value="${esc(p.funderAddr)}" spellcheck="false" style="min-width:220px" placeholder="prl1… payout address"></td>
        <td>${esc(p.label)}</td>
        <td><button class="ghost small" data-rm="${i}">✕</button></td>
      </tr>`).join("");
    tb.querySelectorAll("[data-pa]").forEach((inp) =>
      inp.addEventListener("change", () => { S.positions[Number(inp.dataset.pa)].funderAddr = inp.value.trim(); save(); }));
    tb.querySelectorAll("[data-rm]").forEach((b) =>
      b.addEventListener("click", () => { S.positions.splice(Number(b.dataset.rm), 1); save(); renderFund(); }));
    el("f-count").textContent = `(${S.positions.length})`;
  }

  function guardFunding() {
    if (!needMarket()) return false;
    const open = tradingOpen();
    if (open === false) {
      setErr("f-err", `FUNDING REFUSED: trading closed — tip ${S.tip} is at/past the trading deadline ${S.norm.tradeH}.`);
      return false;
    }
    return true;
  }

  el("f-add").addEventListener("click", () => {
    setErr("f-err", "");
    if (!guardFunding()) return;
    try {
      const pos = P.validatePosition(S.norm, {
        outcomeIndex: Number(el("f-outcome").value),
        txid: el("f-txid").value,
        vout: Number(el("f-vout").value),
        value: Number(P.parsePRLToGrains(el("f-value").value)),
        funderAddr: el("f-addr").value,
        label: el("f-label").value,
      });
      const key = pos.txid + ":" + pos.vout;
      if (S.positions.some((p) => p.txid + ":" + p.vout === key)) throw new Error("position already tracked");
      S.positions.push(pos);
      el("f-txid").value = ""; el("f-addr").value = ""; el("f-label").value = "";
      save(); renderFund();
    } catch (e) { setErr("f-err", "POSITION REFUSED: " + e.message); }
  });

  el("f-import").addEventListener("click", async () => {
    setErr("f-err", "");
    if (!guardFunding()) return;
    const txid = el("f-imp-txid").value.trim();
    if (!/^[0-9a-f]{64}$/i.test(txid)) { setErr("f-err", "IMPORT REFUSED: txid must be 64 hex."); return; }
    el("f-import-out").innerHTML = `<p class="muted small">Reading ${esc(txid.slice(0, 16))}… from Blockbook (GET-only)…</p>`;
    try {
      const tx = await P.fetchTxStatus(S.blockbook, txid);
      const spkHex = S.contracts.map((c) => P.bytesToHex(c.spk));
      const found = [];
      for (const vout of tx.vout || []) {
        const hex = vout.scriptPubKey && vout.scriptPubKey.hex;
        const oi = spkHex.indexOf(hex);
        if (oi >= 0) {
          const val = Number(vout.value);
          if (!Number.isSafeInteger(val) || val < 546) continue;
          found.push({ outcomeIndex: oi, txid: txid.toLowerCase(), vout: vout.n, value: val, funderAddr: "", label: "" });
        }
      }
      if (found.length === 0) {
        el("f-import-out").innerHTML = `<p class="err">No outputs of this transaction pay any outcome address of the loaded market.</p>`;
        return;
      }
      let added = 0;
      for (const f of found) {
        const key = f.txid + ":" + f.vout;
        if (!S.positions.some((p) => p.txid + ":" + p.vout === key)) { S.positions.push(f); added++; }
      }
      // best-effort payout address: first vin address that is P2TR on this network
      let vinAddr = "";
      try {
        for (const vin of tx.vin || []) {
          for (const a of vin.addresses || []) {
            try { P.addressToProgram(a, S.norm.hrp === "tprl" ? P.NETWORKS.testnet : P.NETWORKS.mainnet); vinAddr = a; break; }
            catch { /* not ours */ }
          }
          if (vinAddr) break;
        }
      } catch { /* ignore */ }
      if (vinAddr) {
        for (const f of found) if (!f.funderAddr) f.funderAddr = vinAddr;
      }
      save(); renderFund();
      el("f-import-out").innerHTML = `<p class="muted small">Imported ${added} new position(s) on: ${esc(found.map((f) => S.norm.outcomes[f.outcomeIndex]).join(", "))}.
        ${vinAddr ? "Payout address prefilled from the funding input — <strong>confirm it with the trader</strong>." : "<strong>Set each payout address by hand</strong> — it is not on-chain."}</p>`;
    } catch (e) {
      el("f-import-out").innerHTML = `<p class="err">Import failed: ${esc(e.message)}</p>`;
    }
  });

  el("f-refresh").addEventListener("click", async () => {
    if (!needMarket()) return;
    setErr("f-err", "");
    try {
      const r = await fetch(S.blockbook.replace(/\/$/, "") + "/api/v2");
      const j = await r.json();
      if (j && j.backend && Number.isSafeInteger(j.backend.blocks)) { S.tip = j.backend.blocks; save(); }
      renderFund();
    } catch (e) { setErr("f-err", "Refresh failed: " + e.message); }
  });

  /* ---------------- RESOLVE ---------------- */
  function resolveKey(kind) {
    const raw = kind === "void" ? el("r-void-key").value : el("r-key").value;
    if (!raw.trim()) throw new Error("signing key is empty");
    const net = S.norm.hrp === "tprl" ? P.NETWORKS.testnet : P.NETWORKS.mainnet;
    const k = P.partyKeyFromInput(raw, net);
    if (!k.priv) throw new Error("this key input has no private key — paste a hex privkey, WIF, or mnemonic");
    const expectXOnly = kind === "void" ? S.norm.refundXOnly : S.norm.arbiterXOnly;
    if (P.bytesToHex(k.xonly) !== expectXOnly) {
      throw new Error(`KEY REFUSED: this key's x-only pubkey does not match the market's ${kind === "void" ? "refund sweep" : "arbiter"} key`);
    }
    return k;
  }

  function previewAward() {
    setErr("r-err", "");
    try {
      if (!S.norm) throw new Error("load a market first");
      const plan = P.planAwardPayout({
        norm: S.norm, contracts: S.contracts, positions: S.positions,
        winIndex: Number(el("r-win").value),
        feeRateGrainsPerVByte: Number(el("r-feerate").value),
      });
      el("r-preview-out").innerHTML = `
        <h3>Payout plan — ${esc(plan.winName)} wins</h3>
        <div class="tablewrap"><table>
          <thead><tr><th>Payout address</th><th>Stake</th><th>Share</th></tr></thead>
          <tbody>${plan.outputs.map((o) => `
            <tr><td class="mono">${esc(shortAddr(o.address))}</td><td class="num">${fmtPRLg(o.stake)}</td><td class="num">${fmtPRLg(o.value)}</td></tr>`).join("")}
            <tr class="total"><td>Total</td><td class="num">${fmtPRLg(plan.totalPot)}</td><td class="num">${fmtPRLg(plan.outputs.reduce((a, o) => a + o.value, 0))}</td></tr>
          </tbody>
        </table></div>
        <div class="kv">
          <dt>inputs</dt><dd>${plan.inputs.length} funding UTXOs (${plan.inputs.filter((i) => i.outcomeIndex === plan.winIndex).length} winner-side, ${plan.inputs.filter((i) => i.outcomeIndex !== plan.winIndex).length} loser-side)</dd>
          <dt>fee</dt><dd>${plan.fee} grains @ ${plan.vBytes} vB</dd>
          <dt>winning pot</dt><dd>${fmtPRLg(plan.winningPot)}</dd>
        </div>
        <p class="muted small">Share = stake × totalPot ÷ winningPot, fee deducted, grain-exact (largest remainder). Losers receive nothing — their stake funds the winners.</p>`;
      return plan;
    } catch (e) { setErr("r-err", "PLAN REFUSED: " + e.message); return null; }
  }
  el("r-preview").addEventListener("click", previewAward);

  el("r-sign").addEventListener("click", () => {
    setErr("r-err", "");
    try {
      const plan = previewAward();
      if (!plan) return;
      const k = resolveKey("award");
      const bundle = P.signBundle({
        norm: S.norm, plan,
        privHex: P.bytesToHex(k.priv), signingXOnlyHex: S.norm.arbiterXOnly, kind: "award",
      });
      S.bundle = bundle;
      renderBundle(bundle, "Award");
      el("r-key").value = ""; // wipe after use
    } catch (e) { setErr("r-err", "SIGN REFUSED: " + e.message); }
  });
  el("r-wipe").addEventListener("click", () => { el("r-key").value = ""; el("r-void-key").value = ""; });

  function previewVoid() {
    setErr("r-void-err", "");
    try {
      if (!S.norm) throw new Error("load a market first");
      if (S.tip !== null && S.tip !== undefined && S.tip < S.norm.resolveH) {
        throw new Error(`too early — chain tip ${S.tip} has not reached the resolution deadline ${S.norm.resolveH}`);
      }
      const plan = P.planVoidRefund({
        norm: S.norm, contracts: S.contracts, positions: S.positions,
        feeRateGrainsPerVByte: Number(el("r-feerate").value),
      });
      el("r-void-out").innerHTML = `
        <h3>Void plan — every funder refunded</h3>
        <div class="tablewrap"><table>
          <thead><tr><th>Payout address</th><th>Stake</th><th>Fee share</th><th>Refund</th></tr></thead>
          <tbody>${plan.outputs.map((o) => `
            <tr><td class="mono">${esc(shortAddr(o.address))}</td><td class="num">${fmtPRLg(o.stake)}</td><td class="num">${o.feeShare} gr</td><td class="num">${fmtPRLg(o.value)}</td></tr>`).join("")}
          </tbody>
        </table></div>
        <div class="kv"><dt>fee</dt><dd>${plan.fee} grains @ ${plan.vBytes} vB</dd>
        <dt>nLockTime</dt><dd>${plan.locktime} (= resolveH; spends via the CLTV refund leaf)</dd></div>`;
      return plan;
    } catch (e) { setErr("r-void-err", "VOID PLAN REFUSED: " + e.message); return null; }
  }
  el("r-void-preview").addEventListener("click", previewVoid);
  el("r-void-sign").addEventListener("click", () => {
    setErr("r-void-err", "");
    try {
      const plan = previewVoid();
      if (!plan) return;
      const k = resolveKey("void");
      const bundle = P.signBundle({
        norm: S.norm, plan,
        privHex: P.bytesToHex(k.priv), signingXOnlyHex: S.norm.refundXOnly, kind: "void",
      });
      S.voidBundle = bundle;
      renderBundle(bundle, "Void");
      el("r-void-key").value = "";
    } catch (e) { setErr("r-void-err", "VOID SIGN REFUSED: " + e.message); }
  });

  function renderBundle(bundle, label) {
    el("r-bundle-card").hidden = false;
    el("r-bundle-out").innerHTML = `
      <div class="verdict proven">SIGNED — ${esc(label)} bundle · ${bundle.inputs.length} input(s), ${bundle.outputs.length} output(s), every signature re-verified locally.</div>
      <div class="kv">
        <dt>txid</dt><dd>${esc(bundle.txid)}</dd>
        <dt>fee</dt><dd>${bundle.fee} grains @ ${bundle.vBytes} vB</dd>
        <dt>total in</dt><dd>${fmtPRLg(bundle.totalIn)}</dd>
        <dt>locktime</dt><dd>${bundle.locktime}</dd>
        <dt>raw tx</dt><dd style="font-size:11px">${esc(bundle.hex.slice(0, 120))}…</dd>
      </div>`;
    el("r-dl").onclick = () => download(`pearl-predict-${bundle.kind}-bundle.json`, JSON.stringify(bundle, null, 2));
    const bc = el("r-broadcast");
    bc.textContent = "Broadcast via Blockbook…";
    bc.onclick = async () => {
      if (!bc.dataset.armed) {
        bc.dataset.armed = "1";
        bc.textContent = "Click again to broadcast " + bundle.txid.slice(0, 12) + "… (moves real PRL)";
        return;
      }
      delete bc.dataset.armed;
      bc.textContent = "Broadcasting…";
      try {
        const res = await fetch(S.blockbook.replace(/\/$/, "") + "/api/v2/sendtx/" + bundle.hex);
        const txt = await res.text();
        if (!res.ok) throw new Error(txt.slice(0, 200));
        bc.textContent = "Broadcast accepted: " + txt.slice(0, 40);
      } catch (e) {
        bc.textContent = "Broadcast via Blockbook…";
        setErr("r-err", "Broadcast failed: " + e.message);
      }
    };
  }

  /* ---------------- TRACK ---------------- */
  el("t-load-created").addEventListener("click", () => {
    if (loadPersisted() || S.norm) { setErr("t-err", ""); refreshTrack(); }
    else setErr("t-err", "No saved market in this browser yet.");
  });
  el("t-refresh").addEventListener("click", refreshTrack);

  async function refreshTrack() {
    setErr("t-err", "");
    if (!S.norm) { setErr("t-err", "Load a market first."); return; }
    el("t-status").textContent = "Reading outcome addresses from Blockbook (GET-only)…";
    const pots = potTotals();
    const probs = P.impliedProbabilities(pots);
    const cards = [];
    let tip = S.tip;
    try {
      const r = await fetch(S.blockbook.replace(/\/$/, "") + "/api/v2");
      const j = await r.json();
      if (j && j.backend && Number.isSafeInteger(j.backend.blocks)) { tip = j.backend.blocks; S.tip = tip; }
    } catch { /* keep last tip */ }
    for (let i = 0; i < S.contracts.length; i++) {
      const c = S.contracts[i];
      let bal = null, txs = null, life = "open", note = "";
      try {
        const r = await fetch(S.blockbook.replace(/\/$/, "") + "/api/v2/address/" + c.address);
        if (!r.ok) throw new Error("HTTP " + r.status);
        const j = await r.json();
        bal = Number(j.balance); txs = Number(j.txs);
        if (bal > 0 || txs > 0) life = "funded";
        // award/void detection: a known bundle txid confirmed on this address
        for (const b of [S.bundle, S.voidBundle]) {
          if (!b) continue;
          try {
            const st = await P.fetchTxStatus(S.blockbook, b.txid);
            if (st && Number(st.confirmations) > 0) {
              life = b.kind === "void" ? "refunded" : "awarded";
              note = b.txid.slice(0, 16) + "…";
              break;
            }
          } catch { /* tx unknown yet */ }
        }
      } catch (e) { note = "read failed: " + e.message; }
      cards.push(`
        <div class="ocard">
          <h4>${esc(S.norm.outcomes[i])} <span class="prob">${(probs[i] * 100).toFixed(1)}%</span></h4>
          <div class="addr">${esc(c.address)}</div>
          <div class="pot">${bal === null ? "—" : fmtPRLg(bal)} <span class="muted small">on-chain</span></div>
          <div class="muted small">tracked pot ${fmtPRLg(pots[i])} · ${txs === null ? "?" : txs} txs</div>
          <div class="lifecycle ${life}">${life}</div>
          ${note ? `<div class="muted small mono">${esc(note)}</div>` : ""}
        </div>`);
    }
    el("t-outcomes").innerHTML = `<div class="ocards">${cards.join("")}</div>`;
    const n = S.norm;
    const dl = (label, h) => {
      const left = tip === null || tip === undefined ? null : h - tip;
      return `<div class="deadline"><div class="t">${label}</div><div class="h">${h}</div>
        <div class="c">${left === null ? "tip unknown" : left <= 0 ? "PASSED" : left + " blocks · ~" + P.blocksToCountdown(left)}</div></div>`;
    };
    el("t-deadlines").innerHTML = dl("Trading deadline", n.tradeH) + dl("Resolution deadline", n.resolveH);
    el("t-status").textContent = `Tip ${tip ?? "unknown"} · lifecycle: open (no funds seen) → funded → awarded / refunded.`;
    save();
  }

  /* ---------------- VERIFY ---------------- */
  el("v-run").addEventListener("click", () => {
    setErr("v-err", "");
    el("v-out").innerHTML = "";
    let bundle;
    try { bundle = JSON.parse(el("v-bundle").value); }
    catch { setErr("v-err", "Bundle is not valid JSON."); return; }
    const r = P.verifyBundle({
      descriptor: el("v-desc").value,
      marketJSON: el("v-market").value,
      bundle,
    });
    const fails = r.failures.map((f) => `<li>${esc(f)}</li>`).join("");
    const warns = r.warnings.map((w) => `<li>${esc(w)}</li>`).join("");
    el("v-out").innerHTML = `
      <div class="verdict ${r.proven ? "proven" : "notproven"}">${r.proven ? "✓ PROVEN" : "✗ NOT PROVEN"}
        ${r.proven ? " — descriptor, addresses, proportionality, and every signature check out." : " — do not trust this bundle."}
        ${fails ? `<ul>${fails}</ul>` : ""}${warns ? `<ul>${warns}</ul>` : ""}
      </div>`;
  });

  /* ---------------- footer ---------------- */
  el("copy-donate").addEventListener("click", (e) => copyText(el("donate-addr").textContent.trim(), e.target));

  /* ---------------- boot ---------------- */
  if (loadPersisted()) {
    marketLine(); renderFund();
    el("c-tip-status").textContent = S.tip ? "Restored saved market · tip " + S.tip : "Restored saved market.";
  } else {
    marketLine();
  }
})();
