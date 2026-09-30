/* Pearl Circle UI — five-step wizard driving the real window.PearlCircle bundle.
 * No localStorage (nothing worth persisting outlives the page); keys are held
 * in memory only and every signing step is double-confirmed with a wipe button.
 */
(function () {
  "use strict";
  const B = window.PearlCircle;
  const $ = (id) => {
    const el = document.getElementById(id);
    if (!el) throw new Error("missing element #" + id);
    return el;
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const setErr = (id, msg) => { $(id).textContent = msg || ""; };
  const short = (s, a = 12, b = 8) => (s && s.length > a + b + 1 ? s.slice(0, a) + "…" + s.slice(-b) : s);
  const prl = (g) => B.fmtPRL(g);

  let lotterySecrets = [];   // [{memberIndex, secretHex, commitment}]
  let lotteryOrder = null;   // [memberIndex...]
  let circle = null;         // forged circle (fund/claim/refund/track share it)
  let network = null;
  let pendingClaim = null;
  let refundTemplate = null;
  let refundSigs = [];

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
  const fanOut = (desc, order) => {
    for (const id of ["l-desc", "u-desc", "c-desc", "k-desc"]) $(id).value = desc;
    if (order) for (const id of ["u-order", "c-order", "k-order"]) $(id).value = order.join(",");
  };

  function privFromInput(s, net) {
    s = String(s || "").trim();
    if (!s) throw new Error("paste a key first");
    try { return B.walletFromMnemonic(s, net).priv; } catch (_) {}
    try { return B.walletFromWIF(s, net).priv; } catch (_) {}
    const h = s.toLowerCase().replace(/^0x/, "");
    if (/^[0-9a-f]{64}$/.test(h)) return B.hexToBytes(h);
    throw new Error("key not recognized — paste a BIP-39 mnemonic, WIF, or 64-hex private key");
  }

  async function bbGet(path) {
    const r = await fetch(B.BLOCKBOOK_MAINNET + path);
    if (!r.ok) throw new Error("Blockbook answered " + r.status + " — it may be down or rate-limiting");
    return r.json();
  }

  /* ---------- 1 · FOUND ---------- */
  $("f-forge").addEventListener("click", () => {
    setErr("f-err");
    try {
      const net = B.NETWORKS[$("f-network").value];
      const lines = $("f-members").value.split("\n").map((l) => l.trim()).filter(Boolean);
      if (lines.length === 0) throw new Error("add at least two members, one per line:  Name | address-or-key-or-mnemonic");
      const members = lines.map((line, i) => {
        const cut = line.indexOf("|");
        if (cut < 0) throw new Error(`member line ${i + 1}: use the form  Name | address-or-key-or-mnemonic`);
        return { name: line.slice(0, cut), input: line.slice(cut + 1) };
      });
      const mRaw = $("f-m").value.trim();
      const terms = B.parseCircleTerms({
        name: $("f-name").value,
        members,
        contributionPRL: $("f-contrib").value,
        roundBlocks: $("f-roundblocks").value,
        startHeight: $("f-startheight").value,
        graceBlocks: $("f-grace").value,
        m: mRaw === "" ? undefined : mRaw,
      }, net);
      const desc = B.encodeCircleDescriptor(terms);
      $("f-desc").value = desc;
      $("f-fp").textContent = B.descriptorFingerprint(desc);
      $("f-setuphash").textContent = B.circleSetupHash(terms);
      const n = terms.members.length;
      const pot = n * terms.contributionGrains;
      $("f-summary").innerHTML =
        `<b>${n} members</b> × <b>${prl(terms.contributionGrains)} PRL</b> per round, ` +
        `<b>${n} rounds</b> → pot <b>${prl(pot)} PRL</b> each round. ` +
        `Every member pays <b>${prl(n * terms.contributionGrains)} PRL</b> total across the circle. ` +
        `Timeout refunds need <b>${terms.m}-of-${n}</b> signatures. ` +
        `Round 1 funding opens at height <b>${terms.startHeight}</b>; rounds last ~<b>${terms.roundBlocks}</b> blocks each.`;
      $("f-out").classList.remove("hidden");
      fanOut(desc, null);
      lotterySecrets = []; lotteryOrder = null;
    } catch (e) { setErr("f-err", e.message); }
  });
  $("f-copydesc").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("f-desc").value); }
    catch (_) { $("f-desc").select(); document.execCommand("copy"); }
  });
  $("f-golottery").addEventListener("click", () => goto("lottery"));

  /* ---------- 2 · LOTTERY ---------- */
  let secretsVisible = false;
  function decodedTerms() {
    const { network: net, terms } = B.decodeCircleDescriptor($("l-desc").value);
    return { net, terms };
  }
  $("l-gensecrets").addEventListener("click", () => {
    setErr("l-err");
    try {
      const { terms } = decodedTerms();
      lotterySecrets = terms.members.map((m, i) => {
        const secretHex = B.newSecret();
        return { memberIndex: i, name: m.name, secretHex, commitment: B.commitmentFor(secretHex) };
      });
      const tb = $("l-table").querySelector("tbody");
      tb.innerHTML = lotterySecrets.map((s) =>
        `<tr><td>${s.memberIndex + 1}</td><td><span class="nm">${esc(s.name)}</span></td>` +
        `<td class="sec">${secretsVisible ? esc(s.secretHex) : "•••••••• (hidden until reveal)"}</td>` +
        `<td>${esc(s.commitment)}</td></tr>`).join("");
      $("l-table").classList.remove("hidden");
      $("l-commitments").value = JSON.stringify(
        lotterySecrets.map((s) => ({ memberIndex: s.memberIndex, commitment: s.commitment })), null, 1);
      $("l-reveals").value = "";
    } catch (e) { setErr("l-err", e.message); }
  });
  $("l-togglesecrets").addEventListener("click", () => {
    secretsVisible = !secretsVisible;
    $("l-togglesecrets").textContent = secretsVisible ? "Hide secrets" : "Show secrets";
    const tb = $("l-table").querySelector("tbody");
    [...tb.rows].forEach((row, i) => {
      row.cells[2].textContent = secretsVisible ? lotterySecrets[i].secretHex : "•••••••• (hidden until reveal)";
    });
  });
  $("l-draw").addEventListener("click", () => {
    setErr("l-err");
    try {
      const { network: net, terms } = decodedTerms();
      const commitments = JSON.parse($("l-commitments").value || "[]");
      const reveals = JSON.parse($("l-reveals").value || "[]");
      const order = B.payoutOrderFor({
        setupHash: B.circleSetupHash(terms),
        commitments, reveals, n: terms.members.length,
      });
      lotteryOrder = order;
      network = net;
      const pot = terms.members.length * terms.contributionGrains;
      $("l-order").innerHTML = order.map((mi, r) =>
        `<li><span class="nm">${esc(terms.members[mi].name)}</span>` +
        `<span class="pot">round ${r + 1} · takes ${prl(pot)} PRL</span></li>`).join("");
      $("l-orderjson").textContent = JSON.stringify(order);
      $("l-out").classList.remove("hidden");
      fanOut($("l-desc").value, order);
    } catch (e) { setErr("l-err", e.message); }
  });
  $("l-gofund").addEventListener("click", () => goto("fund"));

  /* ---------- 3 · FUND ---------- */
  function loadCircle(descId, orderId, errId) {
    setErr(errId);
    const { network: net, terms } = B.decodeCircleDescriptor($(descId).value);
    const order = String($(orderId).value || "").split(",").map((s) => s.trim()).filter(Boolean).map(Number);
    circle = B.forgeCircle(net, terms, order);
    network = net;
    return circle;
  }
  function feeRate(id) {
    const v = Number($(id).value);
    if (!Number.isFinite(v) || v <= 0) throw new Error("fee rate must be positive");
    return v;
  }
  $("u-load").addEventListener("click", () => {
    try {
      const c = loadCircle("u-desc", "u-order", "u-err");
      const plan = B.fundingPlan(c, feeRate("u-feerate"));
      const tb = $("u-table").querySelector("tbody");
      tb.innerHTML = plan.rounds.map((r) =>
        `<tr><td>${r.index}</td><td>${esc(r.address)}</td><td>${prl(r.amountGrains)} PRL</td>` +
        `<td><span class="nm">${esc(r.winnerName)}</span></td><td>${r.fundingOpensHeight}</td><td>${r.lockHeight}</td></tr>`).join("");
      $("u-table").classList.remove("hidden");
      $("u-plan").innerHTML =
        `<h3>Per-member totals</h3><table><thead><tr><th>Member</th><th>Contributions</th>` +
        `<th>Est. funding fees</th><th>Grand total</th></tr></thead><tbody>` +
        plan.perMember.map((m) =>
          `<tr><td><span class="nm">${esc(m.name)}</span></td><td>${prl(m.totalGrains)} PRL</td>` +
          `<td>≈ ${m.estFundingFeesGrains.toLocaleString()} grains</td>` +
          `<td>${prl(m.grandTotalGrains)} PRL</td></tr>`).join("") +
        `</tbody></table><p class="hint">Each member sends exactly ` +
        `<code>${prl(c.terms.contributionGrains)} PRL</code> to each round address, ` +
        `ideally after that round's funding height opens. The page cannot verify ` +
        `<em>who</em> sent funds — only that a round address holds them.</p>`;
      $("u-plan").classList.remove("hidden");
    } catch (e) { setErr("u-err", e.message); }
  });
  $("u-check").addEventListener("click", async () => {
    setErr("u-checkerr");
    try {
      if (!circle) loadCircle("u-desc", "u-order", "u-err");
      const api = await bbGet("/api/v2/api");
      const height = api.backend && api.backend.blocks;
      const info = {};
      for (const r of circle.rounds) {
        try {
          const a = await bbGet("/api/v2/address/" + r.address);
          info[r.address] = { balance: Number(a.balance || 0), txs: Number(a.txs || 0) };
        } catch (_) { info[r.address] = { balance: 0, txs: 0 }; }
      }
      const rows = B.classifyRounds(circle, { height, info });
      const tb = $("u-checktable").querySelector("tbody");
      tb.innerHTML = rows.map((r) =>
        `<tr><td>${r.index}</td><td>${r.balance.toLocaleString()} grains</td>` +
        `<td>${r.potGrains.toLocaleString()} grains</td>` +
        `<td><span class="status-${r.status}">${r.status.replace("-", " ")}</span>` +
        (r.status === "pot-full" ? ` — claimable by ${esc(r.winnerName)}` : "") + `</td></tr>`).join("");
      $("u-checktable").classList.remove("hidden");
    } catch (e) { setErr("u-checkerr", e.message); }
  });

  /* ---------- 4 · CLAIM ---------- */
  function fillRoundSelect(sel, memberSel) {
    const rs = $(sel), ms = memberSel ? $(memberSel) : null;
    rs.innerHTML = circle.rounds.map((r) =>
      `<option value="${r.index}">Round ${r.index} — ${esc(r.winnerName)} takes ${prl(r.potGrains)} PRL</option>`).join("");
    if (ms) ms.innerHTML = circle.terms.members.map((m, i) =>
      `<option value="${i}">${esc(m.name)}</option>`).join("");
  }
  $("c-load").addEventListener("click", () => {
    try {
      loadCircle("c-desc", "c-order", "c-err");
      fillRoundSelect("c-round");
      fillRoundSelect("d-round", "d-member");
      $("c-out").classList.add("hidden");
      $("d-tplout").classList.add("hidden");
      refundTemplate = null; refundSigs = [];
    } catch (e) { setErr("c-err", e.message); }
  });
  function outpoint(prefix) {
    return {
      txid: $(prefix + "-txid").value,
      vout: Number($(prefix + "-vout").value),
      value: Number($(prefix + "-value").value),
    };
  }
  $("c-build").addEventListener("click", () => {
    setErr("c-err");
    try {
      if (!circle) throw new Error("load the circle first");
      const round = circle.rounds[Number($("c-round").value) - 1];
      const destRaw = $("c-dest").value.trim();
      const dest = destRaw ? B.addressToProgram(destRaw, network)
        : B.hexToBytes(round.winnerXOnly);
      const planned = B.planClaim(network, round, outpoint("c"), dest, feeRate("c-feerate"));
      const priv = privFromInput($("c-key").value, network);
      pendingClaim = { round, planned, priv };
      $("c-confirmtext").innerHTML =
        `Sign the claim for <b>round ${round.index}</b> — winner <b>${esc(round.winnerName)}</b> ` +
        `takes <b>${prl(planned.outputs[0].value)} PRL</b>, fee ` +
        `<b>${planned.fee.toLocaleString()} grains</b> (${planned.vBytes} vB). ` +
        `The signature is re-verified locally before the tx is built. Proceed?`;
      $("c-confirm").classList.remove("hidden");
    } catch (e) { setErr("c-err", e.message); }
  });
  $("c-confirmno").addEventListener("click", () => {
    pendingClaim = null;
    $("c-confirm").classList.add("hidden");
  });
  $("c-confirmyes").addEventListener("click", () => {
    setErr("c-err");
    try {
      if (!pendingClaim) throw new Error("nothing to sign");
      const { round, planned, priv } = pendingClaim;
      const signed = B.signClaim(network, round, planned, priv);
      $("c-meta").textContent =
        `claim round ${round.index} · txid ${signed.txid} · fee ${planned.fee} grains · ` +
        `signature re-verified ✓ · signed with SIGHASH_DEFAULT (0x00)`;
      $("c-hex").value = signed.hex;
      $("c-out").classList.remove("hidden");
      $("c-confirm").classList.add("hidden");
      pendingClaim = null;
      $("c-key").value = "";
    } catch (e) { setErr("c-err", e.message); }
  });
  $("c-wipekey").addEventListener("click", () => { $("c-key").value = ""; });
  $("c-copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("c-hex").value); }
    catch (_) { $("c-hex").select(); document.execCommand("copy"); }
  });
  $("c-broadcast").addEventListener("click", async () => {
    try { $("c-bout").textContent = "txid " + await B.broadcastTx(B.BLOCKBOOK_MAINNET, $("c-hex").value); }
    catch (e) { $("c-bout").textContent = "broadcast failed: " + e.message; }
  });

  /* ---------- 4 · REFUND ---------- */
  $("d-template").addEventListener("click", () => {
    setErr("d-err");
    try {
      if (!circle) throw new Error("load the circle first");
      const round = circle.rounds[Number($("d-round").value) - 1];
      const height = Number($("d-height").value);
      const tpl = B.planRefund(network, circle, round, outpoint("d"), feeRate("d-feerate"), height);
      refundTemplate = tpl; refundSigs = [];
      $("d-meta").textContent =
        `refund round ${tpl.roundIndex} · pot split ${prl(circle.terms.contributionGrains)} PRL × ${tpl.of} members ` +
        `· fee ${tpl.fee.toLocaleString()} grains (${tpl.vBytes} vB) · lock ${tpl.lockHeight} · ` +
        `needs ${tpl.need} of ${tpl.of} signatures · digest ${tpl.digestHex.slice(0, 16)}…`;
      $("d-sigs").innerHTML = "";
      $("d-tplout").classList.remove("hidden");
      $("d-out").classList.add("hidden");
    } catch (e) { setErr("d-err", e.message); }
  });
  $("d-sign").addEventListener("click", () => {
    setErr("d-err");
    try {
      if (!refundTemplate) throw new Error("build the refund template first");
      const mi = Number($("d-member").value);
      const priv = privFromInput($("d-key").value, network);
      const entry = B.signRefund(network, circle, refundTemplate, mi, priv);
      if (refundSigs.some((s) => s.xonly === entry.xonly)) throw new Error(entry.name + " already signed");
      refundSigs.push(entry);
      $("d-sigs").innerHTML = refundSigs.map((s) =>
        `<li>✓ ${esc(s.name)} — signature verified against registered key</li>`).join("");
      $("d-key").value = "";
    } catch (e) { setErr("d-err", e.message); }
  });
  $("d-wipekey").addEventListener("click", () => { $("d-key").value = ""; });
  $("d-finalize").addEventListener("click", () => {
    setErr("d-err");
    try {
      if (!refundTemplate) throw new Error("build the refund template first");
      const fin = B.finalizeRefund(network, circle, refundTemplate, refundSigs);
      $("d-fmeta").textContent =
        `refund txid ${fin.txid} · ${fin.sigsUsed} signatures · fee ${refundTemplate.fee} grains · ` +
        `every signature re-verified ✓ · digest matches template ✓`;
      $("d-hex").value = fin.hex;
      $("d-out").classList.remove("hidden");
    } catch (e) { setErr("d-err", e.message); }
  });
  $("d-copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("d-hex").value); }
    catch (_) { $("d-hex").select(); document.execCommand("copy"); }
  });
  $("d-broadcast").addEventListener("click", async () => {
    try { $("d-bout").textContent = "txid " + await B.broadcastTx(B.BLOCKBOOK_MAINNET, $("d-hex").value); }
    catch (e) { $("d-bout").textContent = "broadcast failed: " + e.message; }
  });

  /* ---------- 5 · TRACK ---------- */
  $("k-check").addEventListener("click", async () => {
    setErr("k-err");
    try {
      const { network: net, terms } = B.decodeCircleDescriptor($("k-desc").value);
      const orderRaw = String($("k-order").value || "").trim();
      if (!orderRaw) {
        throw new Error("the payout order is required: round addresses commit to each round's winner, so they cannot be derived until the lottery is drawn");
      }
      const order = orderRaw.split(",").map((s) => s.trim()).filter(Boolean).map(Number);
      const c = B.forgeCircle(net, terms, order);
      const api = await bbGet("/api/v2/api");
      const height = api.backend && api.backend.blocks;
      const info = {};
      for (const r of c.rounds) {
        try {
          const a = await bbGet("/api/v2/address/" + r.address);
          info[r.address] = { balance: Number(a.balance || 0), txs: Number(a.txs || 0) };
        } catch (_) { info[r.address] = { balance: 0, txs: 0 }; }
      }
      const rows = B.classifyRounds(c, { height, info });
      const tb = $("k-table").querySelector("tbody");
      tb.innerHTML = rows.map((r) =>
        `<tr><td>${r.index}</td><td>${esc(r.address)}</td>` +
        `<td><span class="nm">${esc(r.winnerName)}</span></td>` +
        `<td>${r.balance.toLocaleString()} / ${r.potGrains.toLocaleString()}</td>` +
        `<td><span class="status-${r.status}">${r.status.replace("-", " ")}</span>` +
        (r.status === "pot-full" ? ` — claimable by ${esc(r.winnerName)}` : "") + `</td>` +
        `<td>${r.refundable ? "unlocked" : "height " + r.lockHeight}</td></tr>`).join("");
      $("k-table").classList.remove("hidden");
      const counts = {};
      for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
      $("k-meta").textContent =
        `${c.terms.name} · chain height ${height} · ` +
        Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ") +
        ` · fingerprint ${B.descriptorFingerprint(c.descriptor)}`;
    } catch (e) { setErr("k-err", e.message); }
  });
})();
