/* Pearl Raffle UI — forge / track / draw / verify / payout.
 * All hashing runs through the window.PearlRaffle bundle (audited Sign lineage);
 * this file is pure UI wiring. No secrets exist in this flow; nothing is stored
 * server-side. Blockbook is only ever read, never trusted blindly. */
(() => {
  "use strict";
  const E = window.PearlRaffle;
  if (!E) { document.body.innerHTML = "<p style='padding:2rem'>Failed to load pearl-raffle.bundle.js</p>"; return; }

  const $ = (id) => document.getElementById(id);

  /* storage that survives hostile localStorage */
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return this.m?.[k] ?? null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { (this.m ??= {})[k] = v; } },
  };

  const S = {
    network: E.NETWORKS.mainnet,
    blockbook: store.get("raffle.blockbook") || E.NETWORKS.mainnet.blockbook,
    forgeEntries: null,   // parseEntries() result
    forgeTip: null,        // current height seen at forge time
    forgeResult: null,     // forgeRaffle() result
    track: null,           // { descriptor(parsed), entries|null }
    drawResult: null,      // drawRaffle() result
    payoutPlan: null,      // buildPayoutPlan() result
  };

  const err = (id, msg) => { const e = $(id); e.hidden = !msg; e.textContent = msg || ""; };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtPRL = (g) => E.fmtPRL(typeof g === "bigint" ? g : BigInt(g)) + " PRL";
  const shortAddr = (a) => esc(a.slice(0, 14)) + "…" + esc(a.slice(-10));

  document.querySelectorAll(".copy-btn").forEach((b) => b.addEventListener("click", async () => {
    const t = $(b.dataset.for);
    const txt = t.value !== undefined && t.tagName !== "CODE" ? t.value : t.textContent;
    try { await navigator.clipboard.writeText(txt); b.textContent = "Copied"; }
    catch { b.textContent = "Copy failed"; }
    setTimeout(() => { b.textContent = "Copy"; }, 1500);
  }));

  /* ---------- step navigation ---------- */
  function goto(step) {
    ["forge", "track", "draw", "verify", "payout"].forEach((s) => {
      $("step-" + s).classList.toggle("active", s === step);
      const b = document.querySelector(`#steps button[data-step="${s}"]`);
      if (b) {
        b.classList.toggle("active", s === step);
        if (["forge", "track", "draw", "verify", "payout"].indexOf(s) < ["forge", "track", "draw", "verify", "payout"].indexOf(step)) b.classList.add("done");
      }
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  document.querySelectorAll("#steps button").forEach((b) => b.addEventListener("click", () => goto(b.dataset.step)));

  function blockbookBase(fallbackInputId) {
    const v = ($(fallbackInputId).value || S.blockbook || "").trim().replace(/\/+$/, "");
    if (v) { S.blockbook = v; store.set("raffle.blockbook", v); }
    return v;
  }

  function renderQR(el, text) {
    el.innerHTML = "";
    try {
      if (typeof window.qrcode === "undefined") throw new Error("qr lib missing");
      const qr = window.qrcode(0, "M");
      qr.addData(text);
      qr.make();
      el.innerHTML = qr.createImgTag(4, 8);
    } catch {
      el.innerHTML = "<p class='hint'>QR too large — copy the URI instead.</p>";
    }
  }

  /* ================= FORGE ================= */
  $("network").addEventListener("change", (e) => {
    S.network = E.NETWORKS[e.target.value];
    if (!store.get("raffle.blockbook")) { S.blockbook = S.network.blockbook || ""; $("forge-blockbook").value = S.blockbook; }
    S.forgeEntries = null; S.forgeResult = null;
    $("forge-entries-summary").textContent = "No list validated yet.";
    $("forge-entries-table-wrap").hidden = true;
    $("forge-out").hidden = true;
    err("forge-error", "");
  });
  $("forge-blockbook").value = S.blockbook || "";

  function validateForgeEntries() {
    const raw = $("forge-entries").value;
    const res = E.parseEntries(raw, S.network);
    S.forgeEntries = res;
    const shown = res.entries.slice(0, 50);
    $("forge-entries-summary").innerHTML =
      `<strong>${res.entries.length}</strong> entries · <strong>${res.totalTickets}</strong> tickets` +
      (res.merged ? ` · ${res.merged} duplicate${res.merged > 1 ? "s" : ""} merged` : "") +
      (res.entries.length > 50 ? " · showing first 50" : "");
    $("forge-entries-table").innerHTML = shown.map((e, i) =>
      `<tr><td>${i + 1}</td><td class="addr">${esc(e.address)}</td><td class="num">${e.tickets}</td></tr>`).join("");
    $("forge-entries-table-wrap").hidden = false;
    err("forge-entries-error", "");
    return res;
  }
  $("forge-parse").addEventListener("click", () => {
    try { validateForgeEntries(); }
    catch (e) { err("forge-entries-error", e.message); S.forgeEntries = null; $("forge-entries-table-wrap").hidden = true; }
  });
  $("forge-sample").addEventListener("click", () => { $("forge-entries").value = E.sampleRaffleCsv(); $("forge-parse").click(); });
  $("forge-file").addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => { $("forge-entries").value = String(r.result || ""); $("forge-parse").click(); };
    r.readAsText(f);
  });

  $("forge-tip").addEventListener("click", async () => {
    err("forge-error", "");
    try {
      const base = blockbookBase("forge-blockbook");
      if (!base) throw new Error("no Blockbook endpoint — enter the tip manually instead");
      const h = await E.fetchTipHeight(base);
      S.forgeTip = h;
      $("forge-tip-manual").value = "";
      $("forge-tip-out").hidden = false;
      $("forge-tip-out").textContent = `Chain tip: block ${h.toLocaleString()} (Blockbook). Settlement must be at least ${h + E.MIN_SETTLE_LEAD + 1}.`;
    } catch (e) { err("forge-error", "tip lookup failed: " + e.message + " — enter the tip manually"); }
  });

  $("forge-button").addEventListener("click", async () => {
    err("forge-error", "");
    try {
      let res = S.forgeEntries;
      if (!res) res = validateForgeEntries();
      const prize = E.parsePRL($("forge-prize").value.trim());
      const heightRaw = $("forge-height").value.trim();
      if (!/^\d+$/.test(heightRaw)) throw new Error("settlement height must be a positive integer block height");
      const settleHeight = Number(heightRaw);
      let tip = S.forgeTip;
      const manual = $("forge-tip-manual").value.trim();
      if (manual) {
        if (!/^\d+$/.test(manual)) throw new Error("manual tip must be a non-negative integer");
        tip = Number(manual);
      }
      if (tip == null) throw new Error("need the current chain height — read it from Blockbook or enter it manually");
      const forged = E.forgeRaffle({ network: S.network, prizeGrains: prize, settleHeight, entries: res.entries, currentHeight: tip });
      S.forgeResult = forged;
      const forgedAt = new Date().toISOString();
      $("forge-descriptor").value = forged.descriptor;
      $("forge-commit-height").textContent = String(forged.settleHeight);
      $("forge-dhash").textContent = forged.descriptorHash;
      $("forge-publish").value =
        `PRL-RAFFLE-COMMIT:v1\n${forged.descriptor}\nSHA-256: ${forged.descriptorHash}\n` +
        `forged: ${forgedAt}\nMUST be published BEFORE block ${forged.settleHeight}. ` +
        `Prize ${fmtPRL(forged.prizeGrains)} · ${forged.n} entries · ${forged.totalTickets} tickets.`;
      $("forge-forged-at").textContent = forgedAt;
      $("forge-prize-out").textContent = fmtPRL(forged.prizeGrains);
      $("forge-count-out").textContent = `${forged.n} entries · ${forged.totalTickets} tickets`;
      $("forge-out").hidden = false;
      document.querySelector('#steps button[data-step="forge"]').classList.add("done");
    } catch (e) { err("forge-error", e.message); }
  });

  $("forge-download").addEventListener("click", () => {
    if (!S.forgeResult) return;
    const f = S.forgeResult;
    const data = {
      descriptor: f.descriptor, descriptorHash: f.descriptorHash,
      network: f.network.hrp, prizeGrains: f.prizeGrains.toString(),
      prizePRL: E.fmtPRL(f.prizeGrains), settleHeight: f.settleHeight,
      entriesHash: f.entriesHash, entryCount: f.n, totalTickets: f.totalTickets.toString(),
      entries: f.canonical.split("\n").map((l) => { const [address, tickets] = l.split(" "); return { address, tickets }; }),
      forgedAt: new Date().toISOString(),
    };
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    a.download = "pearl-raffle-forge.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });

  /* ================= TRACK ================= */
  function loadTrack() {
    const d = E.parseDescriptor($("track-descriptor").value);
    let commit = null;
    const raw = $("track-entries").value.trim();
    if (raw) {
      const { entries, totalTickets } = E.parseEntries(raw, d.network);
      const h = E.entriesHashOf(entries);
      commit = { ok: h === d.entriesHash, entries, totalTickets };
      if (!commit.ok) throw new Error("entry commitment MISMATCH — these entries do not reproduce the descriptor's entriesHash. The list was altered (or is a different list) after forging.");
    }
    S.track = { d, commit };
    $("track-fields").innerHTML =
      `<dt>Network</dt><dd>${esc(d.network.label)} (${esc(d.hrp)})</dd>` +
      `<dt>Prize</dt><dd>${fmtPRL(d.prizeGrains)} (${d.prizeGrains} grains)</dd>` +
      `<dt>Settlement height</dt><dd>${d.settleHeight}</dd>` +
      `<dt>Entries committed</dt><dd>${d.n}</dd>` +
      `<dt>entriesHash</dt><dd>${esc(d.entriesHash)}</dd>` +
      `<dt>Descriptor hash</dt><dd>${esc(d.descriptorHash)}</dd>`;
    const c = $("track-commit");
    if (commit) { c.hidden = false; c.className = "hint ok"; c.textContent = `✓ entry commitment matches — ${commit.entries.length} entries, ${commit.totalTickets} tickets`; }
    else { c.hidden = false; c.className = "hint"; c.textContent = "no entry list pasted — commitment not re-checked"; }
    $("track-out").hidden = false;
    return S.track;
  }
  $("track-load").addEventListener("click", () => { err("track-error", ""); try { loadTrack(); } catch (e) { err("track-error", e.message); $("track-out").hidden = true; } });

  const eta = (blocks) => {
    const s = blocks * E.BLOCK_TARGET_S;
    if (s < 90) return `~${Math.max(1, Math.round(s / 60))} min`;
    const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
    if (h < 48) return `~${h}h ${m}m`;
    return `~${(h / 24).toFixed(1)} days`;
  };

  $("track-scan").addEventListener("click", async () => {
    err("track-error", "");
    try {
      const t = S.track || loadTrack();
      const base = blockbookBase("track-blockbook");
      if (!base) throw new Error("no Blockbook endpoint — use the manual block-hash path below instead");
      const tip = await E.fetchTipHeight(base);
      $("track-tip").textContent = tip.toLocaleString();
      const left = t.d.settleHeight - tip;
      $("track-left").textContent = left > 0 ? left.toLocaleString() : "mined ✓";
      $("track-eta").textContent = left > 0 ? eta(left) + " (at 194 s/block)" : "—";
      if (left <= 0) {
        const h = await E.fetchBlockHashAtHeight(base, t.d.settleHeight);
        $("track-sethash").textContent = h;
        S.track.settleHash = h;
      } else {
        $("track-sethash").textContent = "not mined yet";
        S.track.settleHash = null;
      }
    } catch (e) { err("track-error", e.message); }
  });

  $("track-carry").addEventListener("click", () => {
    const t = S.track; if (!t) return;
    $("draw-descriptor").value = t.d.descriptor;
    if (t.commit) $("draw-entries").value = $("track-entries").value;
    if (t.settleHash) $("draw-blockhash").value = t.settleHash;
    goto("draw");
  });
  $("track-manual-carry").addEventListener("click", () => {
    err("track-error", "");
    try {
      const t = S.track || loadTrack();
      const h = $("track-hash-manual").value.trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(h)) throw new Error("settlement block hash must be 64 hex characters");
      $("draw-descriptor").value = t.d.descriptor;
      if (t.commit) $("draw-entries").value = $("track-entries").value;
      $("draw-blockhash").value = h;
      goto("draw");
    } catch (e) { err("track-error", e.message); }
  });

  /* ================= DRAW ================= */
  function derivationHtml(drawn) {
    return drawn.rounds.map((r) => `
      <div class="deriv">
        <h4>Round ${r.round + 1}</h4>
        <div class="step">preimage&nbsp;&nbsp;<b>${esc(r.preimage)}</b></div>
        <div class="step">SHA-256&nbsp;&nbsp;<b>${esc(r.drawHex)}</b></div>
        <div class="step">as uint256&nbsp;&nbsp;<b>${esc(r.drawInt.toString())}</b></div>
        <div class="step">index = uint256 mod ${esc(r.totalTickets.toString())} tickets&nbsp;&nbsp;=&nbsp;&nbsp;<b>${esc(r.index.toString())}</b></div>
        <div class="step">winner range [${esc(r.winnerRange.lo.toString())}, ${esc(r.winnerRange.hi.toString())}) of ${esc(r.eligible.toString())} eligible entries</div>
        <div class="winner-line">→ ${shortAddr(r.winner.address)} (${esc(r.winner.tickets.toString())} tickets)</div>
      </div>`).join("");
  }

  function runDraw() {
    const descriptor = $("draw-descriptor").value;
    const { entries } = E.parseEntries($("draw-entries").value, E.parseDescriptor(descriptor).network);
    const rounds = Number($("draw-rounds").value);
    const drawn = E.drawRaffle({ descriptor, entries, blockHash: $("draw-blockhash").value, rounds });
    S.drawResult = { drawn, entries };
    $("draw-winners").innerHTML = drawn.rounds.map((r) => `
      <div class="winner-card">
        <div class="round">Round ${r.round + 1} winner</div>
        <div class="addr">${esc(r.winner.address)}</div>
        <div class="prize">index ${esc(r.index.toString())} of ${esc(r.totalTickets.toString())}</div>
      </div>`).join("");
    $("draw-derivation").innerHTML = derivationHtml(drawn);
    $("draw-out").hidden = false;
    document.querySelector('#steps button[data-step="draw"]').classList.add("done");
    return S.drawResult;
  }
  $("draw-run").addEventListener("click", () => { err("draw-error", ""); try { runDraw(); } catch (e) { err("draw-error", e.message); $("draw-out").hidden = true; } });

  $("draw-carry-verify").addEventListener("click", () => {
    $("verify-descriptor").value = $("draw-descriptor").value;
    $("verify-entries").value = $("draw-entries").value;
    $("verify-blockhash").value = $("draw-blockhash").value;
    $("verify-rounds").value = $("draw-rounds").value;
    goto("verify");
  });
  $("draw-carry-payout").addEventListener("click", () => {
    const r = S.drawResult; if (!r) return;
    $("payout-descriptor").value = r.drawn.descriptor.descriptor;
    $("payout-winners").value = r.drawn.winners.map((w) => w.address).join("\n");
    goto("payout");
  });

  /* ================= VERIFY ================= */
  $("verify-run").addEventListener("click", () => {
    err("verify-error", "");
    try {
      const rounds = Number($("verify-rounds").value);
      const v = E.verifyDraw({
        descriptor: $("verify-descriptor").value,
        entriesText: $("verify-entries").value,
        blockHash: $("verify-blockhash").value,
        rounds,
      });
      const box = $("verify-verdict");
      box.className = "verdict ok";
      box.innerHTML = `<span class="big">✓ VERIFIED</span><br><span class="hint">Commitment matches · draw recomputed locally · ${v.winners.length} winner${v.winners.length > 1 ? "s" : ""}:</span>` +
        v.winners.map((w, i) => `<div class="addr mono">round ${i + 1}: ${esc(w.address)}</div>`).join("");
      $("verify-detail").innerHTML = derivationHtml(v);
      $("verify-out").hidden = false;
      document.querySelector('#steps button[data-step="verify"]').classList.add("done");
    } catch (e) {
      const box = $("verify-verdict");
      box.hidden = false;
      box.className = "verdict bad";
      box.innerHTML = `<span class="big">✗ NOT PROVEN</span><br>${esc(e.message)}`;
      $("verify-detail").innerHTML = "";
      $("verify-out").hidden = false;
      err("verify-error", e.message);
    }
  });

  /* ================= PAYOUT ================= */
  function validAddress(addr, network) {
    let dec;
    try { dec = E.decodeBech32m(addr, network.hrp); }
    catch { throw new Error(`not a valid ${network.hrp}1 address: ${addr}`); }
    if (dec.version !== 1 || dec.program.length !== 32) throw new Error(`not a Pearl v1 (Taproot) address: ${addr}`);
    return E.encodeBech32m(network.hrp, 1, dec.program);
  }

  $("payout-build").addEventListener("click", () => {
    err("payout-error", "");
    try {
      const d = E.parseDescriptor($("payout-descriptor").value);
      const addrs = $("payout-winners").value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (!addrs.length) throw new Error("paste at least one winner address");
      if (addrs.length > E.MAX_ROUNDS) throw new Error(`at most ${E.MAX_ROUNDS} rounds`);
      const winners = addrs.map((a) => ({ address: validAddress(a, d.network) }));
      const plan = E.buildPayoutPlan({ winners, prizeGrains: d.prizeGrains, rounds: winners.length });
      S.payoutPlan = plan;
      $("payout-total").textContent = fmtPRL(plan.total);
      $("payout-rows").innerHTML = plan.rows.map((r) => {
        const uri = E.paymentUri(r.address, r.grains);
        return `
        <div class="payout-card">
          <div class="round">Round ${r.round}</div>
          <div class="addr mono">${esc(r.address)}</div>
          <div class="amt">${fmtPRL(r.grains)}</div>
          <div class="uri">${esc(uri)}</div>
          <div class="row"><button class="ghost" data-qr="${r.round}">Show QR</button><button class="ghost" data-copyuri="${esc(uri)}">Copy URI</button></div>
          <div class="qr" id="payout-qr-${r.round}"></div>
        </div>`;
      }).join("");
      $("payout-rows").querySelectorAll("[data-qr]").forEach((b) => b.addEventListener("click", () => {
        const i = Number(b.dataset.qr);
        renderQR($("payout-qr-" + i), E.paymentUri(plan.rows[i - 1].address, plan.rows[i - 1].grains));
      }));
      $("payout-rows").querySelectorAll("[data-copyuri]").forEach((b) => b.addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(b.dataset.copyuri); b.textContent = "Copied"; }
        catch { b.textContent = "Copy failed"; }
        setTimeout(() => { b.textContent = "Copy URI"; }, 1500);
      }));
      $("payout-out").hidden = false;
      $("payout-csv").disabled = false;
      document.querySelector('#steps button[data-step="payout"]').classList.add("done");
    } catch (e) { err("payout-error", e.message); $("payout-out").hidden = true; $("payout-csv").disabled = true; }
  });

  $("payout-csv").addEventListener("click", () => {
    if (!S.payoutPlan) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([E.payoutCsv(S.payoutPlan)], { type: "text/csv" }));
    a.download = "pearl-raffle-payout.csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });
})();
