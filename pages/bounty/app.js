/* Pearl Bounty UI — six-step wizard driving the real window.PearlBounty bundle.
 * Keys are held in memory only, never in localStorage; every signing step is
 * double-confirmed with a wipe button. Submissions board lives in
 * localStorage (public commitments only — never solutions or salts).
 */
(function () {
  "use strict";
  const B = window.PearlBounty;
  const $ = (id) => {
    const el = document.getElementById(id);
    if (!el) throw new Error("missing element #" + id);
    return el;
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const setErr = (id, msg) => { $(id).textContent = msg || ""; };
  const short = (s, a = 14, b = 10) => (s && s.length > a + b + 1 ? s.slice(0, a) + "…" + s.slice(-b) : s);
  const prl = (g) => B.fmtPRL(g);
  const bbBase = (net) => (net.id === "testnet" ? B.BLOCKBOOK_TESTNET : B.BLOCKBOOK_MAINNET);

  let bounty = null;   // loaded bounty spec (shared across steps)
  let network = null;
  let pendingAward = null;
  let pendingReclaim = null;

  /* ---------- step nav ---------- */
  document.querySelectorAll("#steps button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#steps button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      document.querySelectorAll("main .panel").forEach((p) => p.classList.remove("active"));
      $("step-" + btn.dataset.step).classList.add("active");
    });
  });
  const goto = (step) => document.querySelector(`#steps button[data-step="${step}"]`).click();

  const fanOut = (specText, descText, address) => {
    for (const id of ["u-spec", "h-spec", "a-spec", "r-spec", "v-spec"]) $(id).value = specText;
    $("v-descriptor").value = descText;
    if (address) $("v-address").value = address;
  };

  function loadBounty(specText, net) {
    const t = String(specText || "").trim();
    if (!t) throw new Error("paste the bounty spec first");
    try {
      return { bounty: B.parseBountySpec(t, net), note: "" };
    } catch (e1) {
      try {
        const v = B.verifyDescriptor(t, net, null);
        return { bounty: v.bounty, note: "loaded from descriptor only (title/reward are placeholders)" };
      } catch (e2) {
        throw new Error("not a bounty spec or descriptor: " + e1.message);
      }
    }
  }

  function parseOutpoint(text, prefix) {
    const m = String(text || "").trim().match(/^([0-9a-fA-F]{64})\s*:\s*(\d+)$/);
    if (!m) throw new Error(`${prefix}: use the form txid:vout`);
    return { txid: m[1].toLowerCase(), vout: Number(m[2]) };
  }

  function posterPriv(keyInput, net) {
    const w = B.posterPrivFromInput(keyInput, net);
    return B.bytesToHex(w.priv);
  }

  async function copyText(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
      const old = btn.textContent;
      btn.textContent = "Copied ✓";
      setTimeout(() => { btn.textContent = old; }, 1200);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } catch {}
      ta.remove();
    }
  }

  /* ---------- localStorage: submission board (public commitments only) ---------- */
  const SUB_KEY = "pearl-bounty-subs:v1";
  function readBoard() {
    try {
      const raw = localStorage.getItem(SUB_KEY);
      const j = raw ? JSON.parse(raw) : {};
      return (j && typeof j === "object") ? j : {};
    } catch { return {}; }
  }
  function writeBoard(b) {
    try { localStorage.setItem(SUB_KEY, JSON.stringify(b)); } catch {}
  }

  /* ---------- 1 · POST ---------- */
  $("p-forge").addEventListener("click", () => {
    setErr("p-err");
    try {
      const net = B.NETWORKS[$("p-network").value];
      const { bounty: b, secrets } = B.forgeBounty({
        network: net,
        title: $("p-title").value,
        rewardPRL: $("p-reward").value,
        deadlineHeight: Number($("p-deadline").value),
        posterKeyInput: $("p-key").value,
        posterKeyMode: $("p-mode").value,
        contact: $("p-contact").value,
        termsNote: $("p-terms").value,
      });
      // Never retain the poster key past the forge — secrets die with this handler.
      if (secrets && secrets[0]) secrets[0].priv = "0".repeat(64);
      $("p-key").value = "";
      bounty = b; network = net;
      const spec = B.serializeBounty(b);
      $("p-address").value = b.address;
      $("p-desc").value = b.descriptor;
      $("p-fp").textContent = b.fingerprint;
      $("p-spec").value = spec;
      $("p-awardasm").textContent = b.awardAsm;
      $("p-reclaimasm").textContent = b.reclaimAsm;
      $("p-summary").innerHTML =
        `Forged <b>${esc(b.title)}</b> — reward <b>${esc(b.rewardPRL)} PRL</b>, ` +
        `reclaimable after height <b>${b.deadlineHeight}</b>. ` +
        `Contract re-derived and control blocks self-checked. ` +
        `Fund <code>${esc(b.address)}</code> with any PRL wallet to activate the hunt.`;
      $("p-out").classList.remove("hidden");
      fanOut(spec, b.descriptor, b.address);
    } catch (e) { setErr("p-err", e.message); }
  });
  $("p-copyaddr").addEventListener("click", (e) => copyText($("p-address").value, e.target));
  $("p-copydesc").addEventListener("click", (e) => copyText($("p-desc").value, e.target));
  $("p-copyspec").addEventListener("click", (e) => copyText($("p-spec").value, e.target));
  $("p-gofund").addEventListener("click", () => goto("fund"));

  /* ---------- 2 · FUND ---------- */
  $("u-load").addEventListener("click", () => {
    setErr("u-err");
    try {
      const net = bounty && bounty.hrp === "tprl" ? B.NETWORKS.testnet : B.NETWORKS.mainnet;
      const r = loadBounty($("u-spec").value, net);
      bounty = r.bounty; network = net;
      $("u-address").value = bounty.address;
      $("u-out").classList.remove("hidden");
      $("u-meta").textContent = `Loaded “${bounty.title}” — deadline ${bounty.deadlineHeight}.` + (r.note ? " " + r.note : "");
    } catch (e) { setErr("u-err", e.message); }
  });
  $("u-check").addEventListener("click", async () => {
    setErr("u-err");
    try {
      if (!bounty) throw new Error("load the bounty first");
      const utxos = await B.fetchBountyUtxos(bbBase(network), bounty);
      const tb = $("u-table").querySelector("tbody");
      tb.innerHTML = "";
      for (const u of utxos) {
        const tr = document.createElement("tr");
        tr.innerHTML = `<td>${esc(short(u.txid))}</td><td>${u.vout}</td>` +
          `<td>${esc(prl(u.value))}</td><td>${u.confirmations}</td>` +
          `<td>${u.scriptOk ? "✓" : "✗ DROPPED"}</td>`;
        tb.appendChild(tr);
      }
      $("u-table").classList.remove("hidden");
      const tip = await B.fetchBlockHeight(bbBase(network));
      const c = B.classifyBounty(bounty, utxos, tip, false);
      $("u-meta").innerHTML =
        `Chain tip <b>${tip}</b> · status <b>${esc(c.status)}</b> — ${esc(c.detail)}` +
        (c.blocksLeft > 0 ? ` · <b>${c.blocksLeft}</b> blocks to the deadline.` : "");
    } catch (e) { setErr("u-err", e.message); }
  });
  $("u-gohunt").addEventListener("click", () => goto("hunt"));

  /* ---------- 3 · HUNT ---------- */
  function renderBoard() {
    const tb = $("h-table").querySelector("tbody");
    tb.innerHTML = "";
    if (!bounty) return;
    const rows = (readBoard()[bounty.fingerprint] || []);
    for (const r of rows) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${esc(r.handle)}</td><td>${esc(short(r.commitment))}</td>` +
        `<td>${r.revealed ? "yes" : "—"}</td><td>${esc(r.ts)}</td>`;
      tb.appendChild(tr);
    }
  }
  $("h-load").addEventListener("click", () => {
    setErr("h-err");
    try {
      const net = bounty && bounty.hrp === "tprl" ? B.NETWORKS.testnet : B.NETWORKS.mainnet;
      const r = loadBounty($("h-spec").value, net);
      bounty = r.bounty; network = net;
      $("h-out").classList.remove("hidden");
      renderBoard();
    } catch (e) { setErr("h-err", e.message); }
  });
  $("h-gensalt").addEventListener("click", () => { $("h-salt").value = B.newSalt(); });
  $("h-commit").addEventListener("click", () => {
    setErr("h-err");
    try {
      if (!bounty) throw new Error("load the bounty first");
      const c = B.submissionCommitment({
        descriptor: bounty.descriptor,
        handle: $("h-handle").value,
        solution: $("h-solution").value,
        salt: $("h-salt").value,
      });
      $("h-commitment").value = c;
    } catch (e) { setErr("h-err", e.message); }
  });
  $("h-record").addEventListener("click", () => {
    setErr("h-err");
    try {
      if (!bounty) throw new Error("load the bounty first");
      const handle = $("h-handle").value.trim();
      const commitment = $("h-commitment").value.trim();
      if (!handle || !/^[0-9a-f]{64}$/.test(commitment)) throw new Error("make a commitment first");
      const board = readBoard();
      const rows = board[bounty.fingerprint] || [];
      if (rows.some((r) => r.commitment === commitment)) throw new Error("that commitment is already on the board");
      rows.push({ handle, commitment, revealed: false, ts: new Date().toISOString() });
      board[bounty.fingerprint] = rows;
      writeBoard(board);
      renderBoard();
    } catch (e) { setErr("h-err", e.message); }
  });
  $("h-clearboard").addEventListener("click", () => {
    if (!bounty) return;
    const board = readBoard();
    delete board[bounty.fingerprint];
    writeBoard(board);
    renderBoard();
  });
  $("h-verifyreveal").addEventListener("click", () => {
    setErr("h-err");
    try {
      if (!bounty) throw new Error("load the bounty first");
      const ok = B.verifySubmissionReveal($("h-rcommitment").value, {
        descriptor: bounty.descriptor,
        handle: $("h-rhandle").value,
        solution: $("h-rsolution").value,
        salt: $("h-rsalt").value,
      });
      $("h-revealout").innerHTML = ok
        ? `<span class="good">REVEAL VERIFIED</span> — the solution + salt reproduce the published commitment for <b>${esc($("h-rhandle").value.trim())}</b>.`
        : `<span class="bad">REVEAL REJECTED</span> — does not match the published commitment.`;
      if (ok) {
        const board = readBoard();
        const rows = board[bounty.fingerprint] || [];
        const row = rows.find((r) => r.commitment === $("h-rcommitment").value.trim().toLowerCase());
        if (row) row.revealed = true;
        writeBoard(board);
        renderBoard();
      }
    } catch (e) { setErr("h-err", e.message); }
  });

  /* ---------- 4 · AWARD ---------- */
  $("a-plan").addEventListener("click", () => {
    setErr("a-err");
    try {
      const net = bounty && bounty.hrp === "tprl" ? B.NETWORKS.testnet : B.NETWORKS.mainnet;
      const r = loadBounty($("a-spec").value, net);
      bounty = r.bounty; network = net;
      const op = parseOutpoint($("a-utxo").value, "UTXO");
      const utxo = { ...op, value: Number($("a-value").value) > 0 ? B.parsePRLToGrains($("a-value").value) : 0 };
      if (utxo.value <= 0) throw new Error("UTXO value must be a positive PRL amount");
      const awardGrains = B.parsePRLToGrains($("a-amount").value);
      const planned = B.planAward({
        network, bounty, utxo,
        winnerAddr: $("a-winner").value.trim(),
        awardGrains,
        changeAddr: $("a-change").value.trim(),
        feeRateGrainsPerVByte: Number($("a-feerate").value),
      });
      pendingAward = { utxo, awardGrains, planned };
      const outs = planned.outputs.map((o) =>
        `${prl(o.value)} PRL → ${short(B.bytesToHex(o.program), 16, 10)}${o.change ? " (change to poster)" : " (winner)"}`).join("<br>");
      $("a-planmeta").innerHTML =
        `Award <b>${prl(awardGrains)} PRL</b> from <code>${esc(short(op.txid))}:${op.vout}</code>.<br>${outs}<br>` +
        `Fee <b>${planned.feeGrains}</b> grains (${planned.vBytes} vB)${planned.changeGrains ? "" : " — dust remainder folded into the fee"}.`;
      $("a-planout").classList.remove("hidden");
      $("a-out").classList.add("hidden");
      $("a-confirm").classList.add("hidden");
    } catch (e) { setErr("a-err", e.message); }
  });
  $("a-build").addEventListener("click", () => {
    setErr("a-err");
    if (!pendingAward) { setErr("a-err", "plan the award first"); return; }
    $("a-confirmtext").textContent =
      `Sign the award of ${prl(pendingAward.awardGrains)} PRL to ${short($("a-winner").value.trim())} ` +
      `from the bounty “${bounty.title}”? This moves real PRL once broadcast.`;
    $("a-confirm").classList.remove("hidden");
  });
  $("a-confirmno").addEventListener("click", () => $("a-confirm").classList.add("hidden"));
  $("a-confirmyes").addEventListener("click", () => {
    setErr("a-err");
    try {
      $("a-confirm").classList.add("hidden");
      const tx = B.buildAwardTx({
        network, bounty,
        utxo: pendingAward.utxo,
        posterPrivHex: posterPriv($("a-key").value, network),
        winnerAddr: $("a-winner").value.trim(),
        awardGrains: pendingAward.awardGrains,
        changeAddr: $("a-change").value.trim(),
        feeRateGrainsPerVByte: Number($("a-feerate").value),
      });
      $("a-hex").value = tx.hex;
      $("a-meta").innerHTML =
        `Signed &amp; <b>re-verified</b> — txid <code>${esc(tx.txid)}</code>, ` +
        `fee <b>${tx.feeGrains}</b> grains. The key stays in memory until you wipe it.`;
      $("a-out").classList.remove("hidden");
      pendingAward = null;
    } catch (e) { setErr("a-err", e.message); }
  });
  $("a-copyhex").addEventListener("click", (e) => copyText($("a-hex").value, e.target));
  $("a-broadcast").addEventListener("click", async () => {
    setErr("a-err");
    try { $("a-meta").innerHTML += `<br>Broadcast result: <code>${esc(await B.broadcastTx(bbBase(network), $("a-hex").value))}</code>`; }
    catch (e) { setErr("a-err", e.message); }
  });
  $("a-wipe").addEventListener("click", () => {
    $("a-key").value = "";
    $("a-meta").innerHTML += "<br>Poster key wiped from the page.";
  });

  /* ---------- 5 · RECLAIM ---------- */
  $("r-fetchheight").addEventListener("click", async () => {
    setErr("r-err");
    try {
      const net = bounty && bounty.hrp === "tprl" ? B.NETWORKS.testnet : B.NETWORKS.mainnet;
      $("r-height").value = String(await B.fetchBlockHeight(bbBase(net)));
    } catch (e) { setErr("r-err", e.message); }
  });
  $("r-plan").addEventListener("click", () => {
    setErr("r-err");
    try {
      const net = bounty && bounty.hrp === "tprl" ? B.NETWORKS.testnet : B.NETWORKS.mainnet;
      const r = loadBounty($("r-spec").value, net);
      bounty = r.bounty; network = net;
      const op = parseOutpoint($("r-utxo").value, "UTXO");
      const utxo = { ...op, value: B.parsePRLToGrains($("r-value").value) };
      const height = Number($("r-height").value);
      const planned = B.planReclaim({
        network, bounty, utxo,
        destAddr: $("r-dest").value.trim(),
        feeRateGrainsPerVByte: Number($("r-feerate").value),
        currentHeight: height,
      });
      pendingReclaim = { utxo, planned };
      $("r-planmeta").innerHTML =
        `Reclaim <b>${prl(planned.value)} PRL</b> to <code>${esc(short($("r-dest").value.trim()))}</code> ` +
        `at deadline height <b>${bounty.deadlineHeight}</b> (nLockTime). ` +
        `Fee <b>${planned.feeGrains}</b> grains (${planned.vBytes} vB).`;
      $("r-planout").classList.remove("hidden");
      $("r-out").classList.add("hidden");
      $("r-confirm").classList.add("hidden");
    } catch (e) { setErr("r-err", e.message); }
  });
  $("r-build").addEventListener("click", () => {
    setErr("r-err");
    if (!pendingReclaim) { setErr("r-err", "plan the reclaim first"); return; }
    $("r-confirmtext").textContent =
      `Sign the reclaim of ${prl(pendingReclaim.planned.value)} PRL to your address ` +
      `from the bounty “${bounty.title}”? This moves real PRL once broadcast.`;
    $("r-confirm").classList.remove("hidden");
  });
  $("r-confirmno").addEventListener("click", () => $("r-confirm").classList.add("hidden"));
  $("r-confirmyes").addEventListener("click", () => {
    setErr("r-err");
    try {
      $("r-confirm").classList.add("hidden");
      const tx = B.buildReclaimTx({
        network, bounty,
        utxo: pendingReclaim.utxo,
        posterPrivHex: posterPriv($("r-key").value, network),
        destAddr: $("r-dest").value.trim(),
        feeRateGrainsPerVByte: Number($("r-feerate").value),
        currentHeight: Number($("r-height").value),
      });
      $("r-hex").value = tx.hex;
      $("r-meta").innerHTML =
        `Signed &amp; <b>re-verified</b> — txid <code>${esc(tx.txid)}</code>, ` +
        `nLockTime <b>${bounty.deadlineHeight}</b>, fee <b>${tx.feeGrains}</b> grains.`;
      $("r-out").classList.remove("hidden");
      pendingReclaim = null;
    } catch (e) { setErr("r-err", e.message); }
  });
  $("r-copyhex").addEventListener("click", (e) => copyText($("r-hex").value, e.target));
  $("r-broadcast").addEventListener("click", async () => {
    setErr("r-err");
    try { $("r-meta").innerHTML += `<br>Broadcast result: <code>${esc(await B.broadcastTx(bbBase(network), $("r-hex").value))}</code>`; }
    catch (e) { setErr("r-err", e.message); }
  });
  $("r-wipe").addEventListener("click", () => {
    $("r-key").value = "";
    $("r-meta").innerHTML += "<br>Poster key wiped from the page.";
  });

  /* ---------- 6 · VERIFY ---------- */
  $("v-verifydesc").addEventListener("click", () => {
    setErr("v-erra");
    try {
      const net = B.NETWORKS[$("v-network").value];
      const claimed = $("v-address").value.trim() || null;
      const v = B.verifyDescriptor($("v-descriptor").value, net, claimed);
      $("v-descout").innerHTML =
        `<span class="good">DESCRIPTOR VERIFIED</span> — recomputes to ` +
        `<code>${esc(v.bounty.address)}</code> (fingerprint <code>${esc(v.fingerprint)}</code>). ` +
        `Award leaf <code>${esc(v.bounty.awardAsm)}</code> · reclaim leaf <code>${esc(v.bounty.reclaimAsm)}</code>.` +
        (claimed ? " The claimed address matches — safe to fund." : "");
    } catch (e) {
      $("v-descout").innerHTML = `<span class="bad">REFUSED</span> — ${esc(e.message)}`;
    }
  });
  $("v-verifytx").addEventListener("click", () => {
    setErr("v-errb");
    try {
      const net = bounty && bounty.hrp === "tprl" ? B.NETWORKS.testnet : B.NETWORKS.mainnet;
      const r = loadBounty($("v-spec").value, net);
      const v = B.verifyBountyTx($("v-txhex").value, r.bounty);
      $("v-txout").innerHTML =
        `<span class="good">TRANSACTION CONFORMS</span> — txid <code>${esc(v.txid)}</code>: ` +
        v.spends.map((s) => `input ${s.inputIndex} via the <b>${s.leaf}</b> leaf` +
          (s.leaf === "reclaim" ? ` (nLockTime ${s.locktime})` : "")).join("; ") + ".";
    } catch (e) {
      $("v-txout").innerHTML = `<span class="bad">REFUSED</span> — ${esc(e.message)}`;
    }
  });
})();
