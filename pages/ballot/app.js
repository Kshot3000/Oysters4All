/* Pearl Ballot UI — draft / publish / vote / tally / verify.
 * All hashing and signing runs through the window.PearlBallot bundle (audited
 * Sign lineage — BIP-86 derivation, BIP-340 Schnorr); this file is pure UI
 * wiring. Keys entered on the Vote step live in page memory only (never
 * localStorage, never sent anywhere) and the Wipe button nulls them.
 * Blockbook is only ever read (GET), never trusted blindly. */
(() => {
  "use strict";
  const E = window.PearlBallot;
  if (!E) { document.body.innerHTML = "<p style='padding:2rem'>Failed to load pearl-ballot.bundle.js</p>"; return; }

  const $ = (id) => document.getElementById(id);

  /* storage that survives hostile localStorage */
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return this.m?.[k] ?? null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { (this.m ??= {})[k] = v; } },
  };

  const S = {
    network: E.NETWORKS.mainnet,
    blockbook: store.get("ballot.blockbook") || E.NETWORKS.mainnet.blockbook,
    draftTip: null,
    forged: null,        // forgeBallot() result
    vote: null,          // { descriptor, proposal }
    ballots: [],         // imported ballot objects (tally)
    tallyTip: null,
  };

  const err = (id, msg) => { const e = $(id); e.hidden = !msg; e.textContent = msg || ""; };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtPRL = (g) => E.fmtPRL(typeof g === "bigint" ? g : BigInt(g)) + " PRL";
  const shortAddr = (a) => esc(a.slice(0, 14)) + "…" + esc(a.slice(-10));
  const shortHex = (h) => esc(h.slice(0, 12)) + "…" + esc(h.slice(-8));

  document.querySelectorAll(".copy-btn").forEach((b) => b.addEventListener("click", async () => {
    const t = $(b.dataset.for);
    const txt = t.value !== undefined && t.tagName !== "CODE" ? t.value : t.textContent;
    try { await navigator.clipboard.writeText(txt); b.textContent = "Copied"; }
    catch { b.textContent = "Copy failed"; }
    setTimeout(() => { b.textContent = "Copy"; }, 1500);
  }));

  function download(name, text, type) {
    if (typeof URL === "undefined" || !URL.createObjectURL) throw new Error("download not supported in this browser");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
  }

  /* ---------- step navigation ---------- */
  const STEPS = ["draft", "publish", "vote", "tally", "verify"];
  function goto(step) {
    STEPS.forEach((s) => {
      $("step-" + s).classList.toggle("active", s === step);
      const b = document.querySelector(`#steps button[data-step="${s}"]`);
      if (b) {
        b.classList.toggle("active", s === step);
        if (STEPS.indexOf(s) < STEPS.indexOf(step)) b.classList.add("done");
      }
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  document.querySelectorAll("#steps button").forEach((b) => b.addEventListener("click", () => goto(b.dataset.step)));

  function blockbookBase(fallbackInputId) {
    const v = ($(fallbackInputId).value || S.blockbook || "").trim().replace(/\/+$/, "");
    if (v) { S.blockbook = v; store.set("ballot.blockbook", v); }
    return v;
  }

  async function readTip(base, outId) {
    const out = $(outId);
    out.hidden = false; out.textContent = "Reading chain tip…";
    try {
      const h = await E.fetchTipHeight(fetch, base);
      out.textContent = `Chain tip: block ${h} (via ${base || "default Blockbook"})`;
      return h;
    } catch (e) {
      out.textContent = `Tip read failed: ${e.message} — enter the tip manually.`;
      return null;
    }
  }

  function manualTip(id) {
    const v = $(id).value.trim();
    if (!v) return null;
    const h = Number(v);
    if (!Number.isSafeInteger(h) || h < 0) throw new Error("manual tip must be a non-negative integer block height");
    return h;
  }

  /* ---------- key entry (vote step): WIF / hex / mnemonic, in-memory only ---------- */
  function parseKey(text, network) {
    const t = String(text ?? "").trim();
    if (!t) throw new Error("paste your key first — WIF, 64-char hex, or BIP-39 mnemonic");
    if (/^[0-9a-fA-F]{64}$/.test(t)) return E.walletFromPriv(t.toLowerCase(), network);
    try { return E.walletFromWIF(t, network); }
    catch (e1) {
      try { return E.walletFromMnemonic(t, network, 0, 0); }
      catch (e2) { throw new Error(`not a valid key for this network: ${e1.message} / ${e2.message}`); }
    }
  }

  function wipeKey() {
    $("bt-vote-key").value = "";
    err("bt-vote-error", "");
  }

  /* ================= STEP 1: DRAFT ================= */
  $("bt-network").addEventListener("change", (ev) => {
    S.network = ev.target.value === "testnet" ? E.NETWORKS.testnet : E.NETWORKS.mainnet;
    if (!S.blockbook) S.blockbook = S.network.blockbook;
    $("bt-blockbook").value = S.blockbook || "";
  });
  $("bt-blockbook").value = S.blockbook || "";
  $("bt-nonce").value = E.genBallotNonceHex();
  $("bt-new-nonce").addEventListener("click", () => { $("bt-nonce").value = E.genBallotNonceHex(); });
  $("bt-tip").addEventListener("click", async () => {
    S.draftTip = await readTip(blockbookBase("bt-blockbook"), "bt-tip-out");
  });

  $("bt-draft").addEventListener("click", () => {
    err("bt-error", "");
    try {
      const tip = manualTip("bt-tip-manual") ?? S.draftTip;
      const options = $("bt-options").value.split("\n").map((o) => o.trim()).filter((o) => o);
      const f = E.forgeBallot({
        network: S.network,
        title: $("bt-title").value,
        description: $("bt-desc").value,
        options,
        startH: Number($("bt-startH").value),
        endH: Number($("bt-endH").value),
        snapshotH: Number($("bt-snapshotH").value),
        nonce: $("bt-nonce").value.trim() || null,
        currentHeight: tip,
      });
      S.forged = f;
      $("bt-descriptor").textContent = f.descriptor;
      $("bt-out-start").textContent = f.startH;
      $("bt-out").hidden = false;
      // pre-fill publish + vote + tally fields
      $("bt-vote-descriptor").value = f.descriptor;
      $("bt-vote-proposal").value = JSON.stringify(f.proposal, null, 2);
      $("bt-tally-descriptor").value = f.descriptor;
      $("bt-tally-proposal").value = JSON.stringify(f.proposal, null, 2);
    } catch (e) { err("bt-error", e.message); }
  });
  $("bt-to-publish").addEventListener("click", () => { renderPublish(); goto("publish"); });

  /* ================= STEP 2: PUBLISH ================= */
  function renderPublish() {
    err("bt-pub-error", "");
    const f = S.forged;
    if (!f) {
      // review mode: pasted descriptor
      const raw = $("bt-pub-descriptor").value.trim();
      if (!raw) { $("bt-pub-out").hidden = true; $("bt-pub-empty").hidden = false; return; }
      try {
        const d = E.parseDescriptor(raw);
        $("bt-pub-desc").textContent = d.descriptor;
        $("bt-pub-dhash").textContent = d.descriptorHash;
        $("bt-pub-phash").textContent = d.proposalHash;
        $("bt-pub-ohash").textContent = d.optionsHash;
        $("bt-pub-window").textContent = `${d.startH} → ${d.endH}`;
        $("bt-pub-snap").textContent = String(d.snapshotH);
        $("bt-pub-start").textContent = String(d.startH);
        $("bt-pub-json").value = "(proposal JSON not in this session — paste the published one to re-verify)";
        $("bt-pub-out").hidden = false; $("bt-pub-empty").hidden = true;
      } catch (e) { err("bt-pub-error", e.message); }
      return;
    }
    $("bt-pub-desc").textContent = f.descriptor;
    $("bt-pub-dhash").textContent = f.descriptorHash;
    $("bt-pub-phash").textContent = f.proposalHash;
    $("bt-pub-ohash").textContent = f.optionsHash;
    $("bt-pub-window").textContent = `${f.startH} → ${f.endH}`;
    $("bt-pub-snap").textContent = String(f.snapshotH);
    $("bt-pub-start").textContent = String(f.startH);
    $("bt-pub-json").value = JSON.stringify(f.proposal, null, 2);
    $("bt-pub-out").hidden = false; $("bt-pub-empty").hidden = true;
  }
  $("bt-pub-load").addEventListener("click", renderPublish);
  $("bt-pub-copy-json").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("bt-pub-json").value); $("bt-pub-copy-json").textContent = "Copied"; }
    catch { $("bt-pub-copy-json").textContent = "Copy failed"; }
    setTimeout(() => { $("bt-pub-copy-json").textContent = "Copy JSON"; }, 1500);
  });
  $("bt-pub-download").addEventListener("click", () => {
    try { download("pearl-ballot-proposal.json", $("bt-pub-json").value, "application/json"); }
    catch (e) { err("bt-pub-error", e.message); }
  });
  $("bt-pub-to-vote").addEventListener("click", () => goto("vote"));

  /* ================= STEP 3: VOTE ================= */
  $("bt-vote-load").addEventListener("click", () => {
    err("bt-vote-error", "");
    try {
      const d = E.parseDescriptor($("bt-vote-descriptor").value);
      let p;
      try { p = JSON.parse($("bt-vote-proposal").value); } catch { throw new Error("proposal is not valid JSON"); }
      const ph = E.proposalHashOf(p), oh = E.optionsHashOf(p.options || []);
      if (ph !== d.proposalHash || oh !== d.optionsHash) {
        throw new Error("LOUD REFUSAL: the pasted proposal does NOT match the descriptor (proposalHash/optionsHash differ) — the proposal was altered after publication, or it belongs to a different poll. Do NOT vote on it.");
      }
      S.vote = { descriptor: d, proposal: p };
      const sel = $("bt-vote-choice");
      sel.innerHTML = "";
      p.options.forEach((o, i) => {
        const opt = document.createElement("option");
        opt.value = String(i); opt.textContent = `${i} · ${o}`;
        sel.appendChild(opt);
      });
      $("bt-vote-desc").textContent = d.descriptor;
      $("bt-vote-phash").textContent = `${ph.slice(0, 16)}… ✓ matches descriptor`;
      $("bt-vote-window").textContent = `blocks ${d.startH} → ${d.endH} (snapshot ${d.snapshotH})`;
      $("bt-vote-proposal-out").hidden = false;
    } catch (e) { err("bt-vote-error", e.message); }
  });

  $("bt-vote-tip").addEventListener("click", async () => {
    await readTip(blockbookBase("bt-blockbook"), "bt-vote-tip-out");
  });
  $("bt-vote-wipe").addEventListener("click", wipeKey);
  $("bt-vote-wipe2").addEventListener("click", wipeKey);

  $("bt-vote-sign").addEventListener("click", async () => {
    err("bt-vote-error", "");
    $("bt-vote-out").hidden = true;
    try {
      if (!S.vote) throw new Error("verify the proposal + load choices first");
      const { descriptor: d, proposal: p } = S.vote;
      const voter = E.validVoterAddress($("bt-vote-addr").value, d.network);
      const choice = Number($("bt-vote-choice").value);
      if (!Number.isSafeInteger(choice) || choice < 0 || choice >= p.options.length) {
        throw new Error("pick one of the proposal's options");
      }
      // voting window enforcement (live tip or air-gapped manual tip)
      const base = blockbookBase("bt-blockbook");
      let tip = manualTip("bt-vote-tip-manual");
      if (tip == null) tip = await E.fetchTipHeight(fetch, base);
      if (tip < d.startH) throw new Error(`REFUSED: voting has not started — the window opens at block ${d.startH} (tip is ${tip})`);
      if (tip > d.endH) throw new Error(`REFUSED: voting closed at block ${d.endH} (tip is ${tip}) — late ballots are not signed`);
      // key -> address must match the declared voter
      const wallet = parseKey($("bt-vote-key").value, d.network);
      if (wallet.address !== voter) {
        throw new Error(`LOUD REFUSAL: the pasted key derives ${wallet.address}, not the voter address ${voter}. A ballot signed with this key would be rejected at tally. Enter the key that controls the voter address.`);
      }
      // weight = CURRENT confirmed balance, honestly labeled
      const weight = await E.fetchAddressBalanceGrains(fetch, base, voter);
      if (weight === 0n) throw new Error("REFUSED: this address holds 0 PRL — a zero-balance address casts no vote");
      const signed = E.signBallot({
        tweakedPriv: E.ballotSigningKey(wallet),
        fields: {
          network: d.network, descriptorHash: d.descriptorHash, voter, choice,
          weightGrains: weight, snapshotH: d.snapshotH, nonce: E.genBallotNonceHex(),
        },
      });
      $("bt-vote-weight").textContent =
        `Weight: ${fmtPRL(weight)} — the CURRENT confirmed balance from Blockbook (not a snapshot-height read; ` +
        `the organizer enforces the snapshot height ${d.snapshotH}. Signed at tip ${tip}.`;
      $("bt-vote-json").value = JSON.stringify(signed, null, 2);
      $("bt-vote-out").hidden = false;
    } catch (e) { err("bt-vote-error", e.message); }
  });

  $("bt-vote-copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("bt-vote-json").value); $("bt-vote-copy").textContent = "Copied"; }
    catch { $("bt-vote-copy").textContent = "Copy failed"; }
    setTimeout(() => { $("bt-vote-copy").textContent = "Copy ballot JSON"; }, 1500);
  });
  $("bt-vote-download").addEventListener("click", () => {
    try { download("pearl-ballot.json", $("bt-vote-json").value, "application/json"); }
    catch (e) { err("bt-vote-error", e.message); }
  });

  /* ================= STEP 4: TALLY ================= */
  function updateTallyCount() {
    $("bt-tally-count").textContent = `${S.ballots.length} ballot${S.ballots.length === 1 ? "" : "s"} imported.`;
  }

  $("bt-tally-add").addEventListener("click", () => {
    err("bt-tally-error", "");
    try {
      const raw = $("bt-tally-ballots").value.trim();
      if (!raw) throw new Error("paste a ballot JSON object or a JSON array first");
      let parsed;
      try { parsed = JSON.parse(raw); } catch { throw new Error("not valid JSON"); }
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      if (arr.length === 0) throw new Error("no ballots in the pasted JSON");
      for (const b of arr) E.parseSignedBallot(b); // shape-check now, signature re-checked at tally
      S.ballots.push(...arr);
      $("bt-tally-ballots").value = "";
      updateTallyCount();
    } catch (e) { err("bt-tally-error", e.message); }
  });

  $("bt-tally-file").addEventListener("change", async (ev) => {
    err("bt-tally-error", "");
    try {
      const f = ev.target.files && ev.target.files[0];
      if (!f) return;
      $("bt-tally-ballots").value = await f.text();
      ev.target.value = "";
    } catch (e) { err("bt-tally-error", e.message); }
  });

  $("bt-tally-clear").addEventListener("click", () => {
    S.ballots = [];
    $("bt-tally-out").hidden = true;
    updateTallyCount();
    err("bt-tally-error", "");
  });

  $("bt-tally-tip").addEventListener("click", async () => {
    S.tallyTip = await readTip(blockbookBase("bt-blockbook"), "bt-tally-tip-out");
  });

  function renderTotals(el, perOption, labels, totalWeight) {
    el.innerHTML = "";
    perOption.forEach((w, i) => {
      const row = document.createElement("div");
      row.className = "total-row";
      const pct = totalWeight > 0n ? Number((w * 10000n) / totalWeight) / 100 : 0;
      row.innerHTML = `<span class="opt">${esc(labels[i] ?? ("option " + i))}</span>` +
        `<span class="bar"><span style="width:${pct.toFixed(2)}%"></span></span>` +
        `<span class="w">${esc(fmtPRL(w))} (${pct.toFixed(2)}%)</span>`;
      el.appendChild(row);
    });
  }

  $("bt-tally-run").addEventListener("click", async () => {
    err("bt-tally-error", "");
    $("bt-tally-out").hidden = true;
    try {
      if (S.ballots.length === 0) throw new Error("import ballots first");
      const d = E.parseDescriptor($("bt-tally-descriptor").value);
      let labels = null, optionCount = null;
      const pRaw = $("bt-tally-proposal").value.trim();
      if (pRaw) {
        let p;
        try { p = JSON.parse(pRaw); } catch { throw new Error("proposal JSON is not valid JSON"); }
        if (E.proposalHashOf(p) !== d.proposalHash || E.optionsHashOf(p.options || []) !== d.optionsHash) {
          throw new Error("LOUD REFUSAL: the pasted proposal does NOT match the descriptor — tallying against altered terms is refused");
        }
        labels = p.options; optionCount = p.options.length;
      }
      const tip = manualTip("bt-tally-tip-manual") ?? S.tallyTip;
      const t = E.tallyBallots({
        descriptor: d.descriptor, signedBallots: S.ballots,
        tipHeight: tip, tipSource: tip == null ? "not-recorded" : (manualTip("bt-tally-tip-manual") != null ? "manual" : "blockbook"),
        optionCount,
      });
      const res = E.resultRecord(t);
      $("bt-tally-meta").textContent =
        `Descriptor ${t.descriptorHash.slice(0, 16)}… · ${t.nVoters} valid voter(s), ${t.nRejected} rejected · ` +
        `total weight ${fmtPRL(t.totalWeight)} · import tip ${t.tipHeight == null ? "not recorded" : t.tipHeight + " (" + t.tipSource + ")"}`;
      renderTotals($("bt-tally-totals"), t.perOption, labels, t.totalWeight);
      const tb = $("bt-tally-tbody");
      tb.innerHTML = "";
      t.accepted.forEach((a, i) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `<td>${i + 1}</td><td>${shortAddr(a.voter)}</td>` +
          `<td>${esc(String(a.choice))}${labels ? " · " + esc(labels[a.choice] ?? "") : ""}</td>` +
          `<td>${esc(fmtPRL(a.weightGrains))}</td><td>${shortHex(a.ballotHash)}</td>`;
        tb.appendChild(tr);
      });
      const dups = $("bt-tally-dups"), dupsList = $("bt-tally-dups-list");
      dupsList.innerHTML = "";
      if (t.duplicates.length) {
        t.duplicates.forEach((x) => {
          const li = document.createElement("li");
          li.textContent = `ballot #${x.index + 1} from ${x.voter} — DUPLICATE, first valid ballot stands (${x.ballotHash.slice(0, 16)}…)`;
          dupsList.appendChild(li);
        });
        dups.hidden = false;
      } else dups.hidden = true;
      const rej = $("bt-tally-rej"), rejList = $("bt-tally-rej-list");
      rejList.innerHTML = "";
      const hardRejects = t.rejected.filter((r) => !/DUPLICATE/.test(r.reason));
      if (hardRejects.length) {
        hardRejects.forEach((r) => {
          const li = document.createElement("li");
          li.textContent = `ballot #${r.index + 1} (${r.voter}): ${r.reason}`;
          rejList.appendChild(li);
        });
        rej.hidden = false;
      } else rej.hidden = true;
      $("bt-tally-record").textContent = res.record;
      $("bt-tally-winner").textContent = (() => {
        if (res.tie) {
          const top = t.perOption.reduce((a, b) => (a > b ? a : b), 0n);
          const tiedIdx = t.perOption.map((w, i) => (w === top ? i : null)).filter((x) => x !== null);
          return `Result: TIE — options ${tiedIdx.join(", ")} share the top weight ${fmtPRL(top)}. The page refuses to pick a winner out of thin air; break ties socially.`;
        }
        return res.winner >= 0
          ? `Winner: option ${res.winner}${labels ? ` — “${labels[res.winner]}”` : ""} with ${fmtPRL(t.perOption[res.winner])}.`
          : "No valid ballots — no winner.";
      })();
      $("bt-tally-out").hidden = false;
      S.lastTally = t; S.lastResult = res;
    } catch (e) { err("bt-tally-error", e.message); }
  });

  $("bt-tally-csv").addEventListener("click", () => {
    try { download("pearl-ballot-tally.csv", E.tallyCsv(S.lastTally), "text/csv"); }
    catch (e) { err("bt-tally-error", e.message); }
  });
  $("bt-tally-json").addEventListener("click", () => {
    try {
      download("pearl-ballot-tally.json", JSON.stringify({
        result: S.lastResult, tally: { ...S.lastTally, perOption: S.lastTally.perOption.map((w) => w.toString()), totalWeight: S.lastTally.totalWeight.toString(), accepted: S.lastTally.accepted.map((a) => ({ ...a, weightGrains: a.weightGrains.toString() })) },
      }, null, 2), "application/json");
    } catch (e) { err("bt-tally-error", e.message); }
  });

  /* ================= STEP 5: VERIFY ================= */
  $("bt-ver-run").addEventListener("click", () => {
    err("bt-ver-error", "");
    $("bt-ver-out").hidden = true;
    try {
      let optionCount = null;
      try { optionCount = JSON.parse($("bt-ver-proposal").value).options.length; } catch { /* verifier reports */ }
      const v = E.verifyBallotElection({ proposal: $("bt-ver-proposal").value, ballots: $("bt-ver-ballots").value, optionCount });
      $("bt-ver-head").textContent = "✓ PROVEN — descriptor re-derived, every signature re-verified";
      $("bt-ver-desc").textContent = v.descriptor.descriptor;
      $("bt-ver-dhash").textContent = v.descriptor.descriptorHash;
      $("bt-ver-n").textContent = String(v.tally.nVoters);
      $("bt-ver-rej").textContent = String(v.tally.nRejected);
      $("bt-ver-record").textContent = v.result.record;
      let labels = null;
      try { labels = JSON.parse($("bt-ver-proposal").value).options; } catch { /* ignore */ }
      renderTotals($("bt-ver-totals"), v.tally.perOption, labels, v.tally.totalWeight);
      $("bt-ver-out").hidden = false;
    } catch (e) { err("bt-ver-error", e.message); }
  });
})();
