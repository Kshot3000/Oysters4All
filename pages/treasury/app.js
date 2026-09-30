/* Pearl Treasury UI — five-tab desk driving the real window.PearlTreasury bundle.
 *
 * Keys are held in memory only (KeyVault), never in localStorage; every signing
 * step is double-confirmed with a wipe button. Vault descriptors, proposals,
 * schedules, and the audit log are public metadata and do persist locally.
 * Blockbook reads are GET-only; the only POST is the explicit broadcast.
 */
(function () {
  "use strict";
  const T = window.PearlTreasury;
  const $ = (id) => {
    const el = document.getElementById(id);
    if (!el) throw new Error("missing element #" + id);
    return el;
  };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const setErr = (id, msg) => { $(id).textContent = msg || ""; };
  const short = (s, a = 14, b = 10) => (s && s.length > a + b + 1 ? s.slice(0, a) + "…" + s.slice(-b) : s);
  const prl = (g) => T.fmtPRL(BigInt(g || 0));
  const show = (id) => $(id).classList.remove("hidden");
  const hide = (id) => $(id).classList.add("hidden");

  /* ---------- step nav ---------- */
  document.querySelectorAll("#steps button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#steps button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      document.querySelectorAll("main .panel").forEach((p) => p.classList.remove("active"));
      $("step-" + btn.dataset.step).classList.add("active");
      if (btn.dataset.step === "audit") renderAudit();
    });
  });
  const goto = (step) => document.querySelector(`#steps button[data-step="${step}"]`).click();

  /* ---------- persistent public state (never keys) ---------- */
  const LS = { vaults: "pearl-treasury-v1:vaults", proposals: "pearl-treasury-v1:proposals", schedules: "pearl-treasury-v1:schedules", audit: "pearl-treasury-v1:audit" };
  const load = (k, dflt) => {
    try {
      const raw = localStorage.getItem(k);
      return raw ? JSON.parse(raw) : dflt;
    } catch { return dflt; }
  };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

  let vaults = load(LS.vaults, []);
  let proposals = load(LS.proposals, []);
  let schedules = load(LS.schedules, []);
  let auditLog = load(LS.audit, []);

  const netOf = (vault) => T.NETWORKS[vault.network] || T.NETWORKS.mainnet;
  const bbBase = (vault) => {
    const ov = ($("v-bburl").value || "").trim();
    if (ov) return ov.replace(/\/$/, "");
    return netOf(vault).blockbook;
  };
  const findVault = (id) => vaults.find((v) => v.id === id);
  const findProposal = (id) => proposals.find((p) => p.id === id);
  const vaultLabel = (desc) => {
    const v = vaults.find((x) => x.descriptor === desc);
    return v ? v.label : short(desc, 18, 8);
  };

  /* ---------- audit ---------- */
  function audit(kind, actor, detail) {
    T.auditAppend(auditLog, { kind, actor, detail });
    save(LS.audit, auditLog);
    if ($("step-audit").classList.contains("active")) renderAudit();
  }
  function renderAudit() {
    const rows = auditLog.map((e) => `<tr><td>${e.seq}</td><td class="mono">${esc(e.ts.slice(0, 19).replace("T", " "))}</td><td>${esc(e.kind)}</td><td>${esc(e.actor)}</td><td>${esc(e.detail)}</td><td class="mono">${esc(short(e.hash, 10, 6))}</td></tr>`).join("");
    $("a-rows").innerHTML = rows || `<tr><td colspan="6" class="dim">No events yet — every vault, proposal, signature, and disbursement lands here.</td></tr>`;
  }

  /* ---------- in-memory keys ---------- */
  const keys = T.createKeyVault();
  function renderKeyStatus() {
    const ls = keys.labels();
    $("s-keystatus").textContent = ls.length ? "keys in memory: " + ls.join(", ") : "no keys in memory";
  }

  async function copyText(text, btn) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      if (btn) { const o = btn.textContent; btn.textContent = "Copied ✓"; setTimeout(() => { btn.textContent = o; }, 1200); }
    } catch (e) {
      setErr("s-err", "copy failed: " + e.message);
    }
  }

  /* ================= 1 · VAULTS ================= */

  function renderVaults() {
    const rows = vaults.map((v) => {
      const b = v.balance || {};
      return `<tr>
        <td><strong>${esc(v.label)}</strong>${v.demo ? ' <span class="badge demo">demo</span>' : ""}<br><span class="dim mono">${esc(short(v.id, 10, 6))}</span></td>
        <td class="mono">${esc(short(v.address, 18, 12))}</td>
        <td>${v.m}-of-${v.n}</td>
        <td>${prl(b.confirmed)} <span class="dim">PRL</span></td>
        <td>${prl(b.unconfirmed)} <span class="dim">PRL</span></td>
        <td>${b.utxoCount ?? 0}</td>
        <td class="dim mono">${b.refreshedAt ? esc(b.refreshedAt.slice(0, 19).replace("T", " ")) : "—"}</td>
        <td><button data-action="copy-desc" data-id="${esc(v.id)}">Descriptor</button>
            <button data-action="refresh" data-id="${esc(v.id)}">Refresh</button>
            <button data-action="remove" data-id="${esc(v.id)}">Remove</button></td>
      </tr>`;
    }).join("");
    $("v-rows").innerHTML = rows || `<tr><td colspan="8" class="dim">No vaults yet — register one above, or generate a demo vault to explore.</td></tr>`;
    const t = T.vaultTotals(vaults);
    $("v-totals").textContent = vaults.length
      ? `Treasury total: ${prl(t.total)} PRL (${prl(t.confirmed)} confirmed + ${prl(t.unconfirmed)} unconfirmed) across ${t.count} vault(s)`
      : "";
    refreshProposalVaultOptions();
  }

  $("v-rows").addEventListener("click", async (e) => {
    const btn = e.target.closest ? e.target.closest("button[data-action]") : null;
    if (!btn) return;
    const v = findVault(btn.dataset.id);
    if (!v) return;
    if (btn.dataset.action === "copy-desc") copyText(v.descriptor, btn);
    if (btn.dataset.action === "remove") {
      if (proposals.some((p) => p.vault === v.descriptor && p.status !== "cancelled" && p.status !== "disbursed")) {
        setErr("v-err", "vault has live proposals — cancel or disburse them first");
        return;
      }
      vaults = vaults.filter((x) => x.id !== v.id);
      save(LS.vaults, vaults);
      audit("vault.removed", "treasury", `${v.label} (${short(v.address, 12, 8)})`);
      renderVaults();
    }
    if (btn.dataset.action === "refresh") {
      setErr("v-err", "");
      try {
        const bal = await T.fetchVaultBalance(bbBase(v), v);
        v.balance = { confirmed: bal.confirmed, unconfirmed: bal.unconfirmed, utxoCount: bal.utxoCount, refreshedAt: bal.refreshedAt };
        save(LS.vaults, vaults);
        audit("vault.balance", "treasury", `${v.label}: ${prl(bal.confirmed)} confirmed + ${prl(bal.unconfirmed)} unconfirmed PRL`);
        renderVaults();
      } catch (err) {
        setErr("v-err", `refresh failed for ${v.label}: ${err.message}`);
      }
    }
  });

  $("v-register").addEventListener("click", () => {
    setErr("v-err", "");
    try {
      const network = T.NETWORKS[$("v-network").value] || T.NETWORKS.mainnet;
      const vault = T.registerVault({ descriptor: $("v-desc").value, label: $("v-label").value }, network);
      if (vaults.some((v) => v.descriptor === vault.descriptor)) throw new Error("vault already registered");
      vaults.push(vault);
      save(LS.vaults, vaults);
      $("v-desc").value = "";
      audit("vault.registered", "treasury", `${vault.label}: ${vault.m}-of-${vault.n} ${short(vault.address, 16, 10)}`);
      renderVaults();
    } catch (e) {
      setErr("v-err", e.message);
    }
  });

  $("v-gen").addEventListener("click", () => {
    setErr("v-err", "");
    try {
      const network = T.NETWORKS[$("v-network").value] || T.NETWORKS.mainnet;
      const { vault, mnemonics } = T.generateDemoVault({
        m: 2, n: 3, network, label: "Demo vault " + new Date().toISOString().slice(0, 16).replace("T", " "),
      });
      vaults.push(vault);
      save(LS.vaults, vaults);
      $("v-gen-desc").value = vault.descriptor;
      $("v-gen-address").value = vault.address;
      $("v-gen-keys").value = mnemonics.map((m, i) => `cosigner ${i + 1}: ${m}`).join("\n");
      show("v-genout");
      audit("vault.registered", "treasury", `DEMO ${vault.label}: ${short(vault.address, 16, 10)}`);
      renderVaults();
    } catch (e) {
      setErr("v-err", e.message);
    }
  });
  $("v-gen-hide").addEventListener("click", () => {
    $("v-gen-keys").value = "";
    hide("v-genout");
  });
  $("v-gen-copy").addEventListener("click", (e) => copyText($("v-gen-desc").value, e.target));

  $("v-refresh-all").addEventListener("click", async () => {
    setErr("v-err", "");
    let ok = 0, fail = 0;
    for (const v of vaults) {
      try {
        const bal = await T.fetchVaultBalance(bbBase(v), v);
        v.balance = { confirmed: bal.confirmed, unconfirmed: bal.unconfirmed, utxoCount: bal.utxoCount, refreshedAt: bal.refreshedAt };
        ok++;
      } catch (e) { fail++; }
    }
    save(LS.vaults, vaults);
    renderVaults();
    audit("vault.balance", "treasury", `refreshed ${ok} vault(s)${fail ? `, ${fail} failed` : ""}`);
    if (fail) setErr("v-err", `${fail} vault(s) failed to refresh — Blockbook may be unreachable`);
  });

  /* ================= 2 · PROPOSALS ================= */

  let currentProposalId = null;

  function refreshProposalVaultOptions() {
    const opts = vaults.map((v) => `<option value="${esc(v.id)}">${esc(v.label)} (${v.m}-of-${v.n})</option>`).join("");
    $("p-vault").innerHTML = opts || `<option value="">— register a vault first —</option>`;
    $("s-proposal").innerHTML = proposals.length
      ? proposals.map((p) => `<option value="${esc(p.id)}">${esc(p.fingerprint)} · ${esc(vaultLabel(p.vault))} · ${prl(p.amountGrains)} PRL · ${esc(p.status)}</option>`).join("")
      : `<option value="">— create a proposal first —</option>`;
    $("d-proposal").innerHTML = $("s-proposal").innerHTML;
    $("d-sched-proposal").innerHTML = $("s-proposal").innerHTML;
    if (currentProposalId) {
      for (const id of ["s-proposal", "d-proposal", "d-sched-proposal"]) {
        const sel = $(id);
        if (sel.innerHTML.includes(`value="${currentProposalId}"`)) sel.value = currentProposalId;
      }
    }
  }

  function renderProposals() {
    const rows = proposals.map((p) => `<tr>
      <td class="mono">${esc(p.fingerprint)}</td>
      <td>${esc(vaultLabel(p.vault))}</td>
      <td class="mono">${esc(short(p.payee, 16, 10))}</td>
      <td>${prl(p.amountGrains)} <span class="dim">PRL</span></td>
      <td><span class="badge ${esc(p.status)}">${esc(p.status)}</span></td>
      <td class="dim mono">${p.dueDate ? esc(p.dueDate.slice(0, 10)) : "—"}${p.recurrence ? ` ↻ ${p.recurrence.every} ${p.recurrence.unit}` : ""}</td>
      <td><button data-action="open" data-id="${esc(p.id)}">Open</button></td>
    </tr>`).join("");
    $("p-rows").innerHTML = rows || `<tr><td colspan="7" class="dim">No proposals yet.</td></tr>`;
    refreshProposalVaultOptions();
    if (currentProposalId) renderProposalDetail();
  }

  function renderProposalDetail() {
    const p = findProposal(currentProposalId);
    if (!p) { hide("p-detail-wrap"); return; }
    $("p-detail").textContent = JSON.stringify(p, null, 2);
    show("p-detail-wrap");
  }

  $("p-rows").addEventListener("click", (e) => {
    const btn = e.target.closest ? e.target.closest("button[data-action='open']") : null;
    if (!btn) return;
    currentProposalId = btn.dataset.id;
    renderProposalDetail();
    refreshProposalVaultOptions();
  });

  $("p-create").addEventListener("click", () => {
    setErr("p-err", "");
    try {
      const vault = findVault($("p-vault").value);
      if (!vault) throw new Error("register a vault first");
      const network = netOf(vault);
      const recUnit = $("p-recur-unit").value;
      const recurrence = recUnit ? T.validateRecurrence({ unit: recUnit, every: $("p-recur-every").value }) : null;
      const p = T.createProposal({
        vault,
        payee: $("p-payee").value,
        amountPRL: $("p-amount").value,
        memo: $("p-memo").value,
        dueDateISO: $("p-due").value || null,
        recurrence,
        createdBy: $("p-creator").value,
      }, network);
      proposals.unshift(p);
      save(LS.proposals, proposals);
      currentProposalId = p.id;
      $("p-payee").value = ""; $("p-amount").value = ""; $("p-memo").value = "";
      audit("proposal.created", "treasury", `${p.fingerprint}: ${prl(p.amountGrains)} PRL → ${short(p.payee, 14, 8)}${p.memo ? " — " + p.memo : ""}`);
      renderProposals();
    } catch (e) {
      setErr("p-err", e.message);
    }
  });

  $("p-verify").addEventListener("click", () => {
    const p = findProposal(currentProposalId);
    if (!p) return;
    try {
      const vault = vaults.find((v) => v.descriptor === p.vault);
      T.verifyProposal(p, vault ? netOf(vault) : T.NETWORKS.mainnet);
      $("p-verify-out").textContent = "✓ id, fingerprint, vault, payee, and amount all verify";
      setTimeout(() => { $("p-verify-out").textContent = ""; }, 4000);
    } catch (e) {
      $("p-verify-out").textContent = "";
      setErr("p-err", "TAMPERED: " + e.message);
    }
  });

  $("p-copy").addEventListener("click", (e) => {
    const p = findProposal(currentProposalId);
    if (p) copyText(T.serializeProposal(p), e.target);
  });
  $("p-goto-sign").addEventListener("click", () => goto("sign"));
  $("p-cancel").addEventListener("click", () => {
    const p = findProposal(currentProposalId);
    if (!p) return;
    try {
      T.assertProposalTransition(p.status, "cancelled");
      p.status = "cancelled";
      save(LS.proposals, proposals);
      audit("proposal.cancelled", "treasury", p.fingerprint);
      renderProposals();
    } catch (e) { setErr("p-err", e.message); }
  });

  /* ================= 3 · SIGN ================= */

  let currentRound = null;   // parsed round (in memory)
  let currentCovenant = null;

  function covenantFor(proposal) {
    const vault = vaults.find((v) => v.descriptor === proposal.vault);
    if (!vault) throw new Error("the proposal's vault is not registered on this device — import its descriptor first");
    return { covenant: T.covenantFromDescriptor(proposal.vault, netOf(vault)), vault };
  }

  function roundSummary(round, covenant) {
    const d = T.describeRound(round, covenant);
    const st = T.roundStatus(round, covenant);
    return [
      `covenant : ${d.covenant}  ${short(covenant.address, 16, 10)}`,
      `input    : ${d.input}`,
      ...d.outputs.map((o) => `output   : ${o.value} PRL → ${o.address}${o.change ? "  (change → vault)" : ""}`),
      `fee      : ${d.fee} PRL  (${d.feeRate} grains/vB, ${round.vBytes} vBytes)`,
      `digest   : ${round.digest}`,
      `quorum   : ${st.have}/${st.need}${st.ready ? "  READY ✓" : ""}`,
      `memo     : ${d.memo || "—"}`,
    ].join("\n");
  }

  function renderSigs() {
    if (!currentRound || !currentCovenant) { $("s-sigs").innerHTML = ""; $("s-quorum").textContent = ""; return; }
    const st = T.roundStatus(currentRound, currentCovenant);
    $("s-quorum").textContent = `quorum ${st.have}-of-${st.need}${st.ready ? " — READY ✓" : ""}`;
    $("s-sigs").innerHTML = currentRound.partialSigs.length
      ? currentRound.partialSigs.map((ps) => `<div class="sig"><span>key ${esc(short(ps.key, 12, 8))}</span><span class="dim">${esc(short(ps.sig, 16, 10))}</span><span class="ok">✓ verified</span></div>`).join("")
      : `<p class="dim">No signatures yet.</p>`;
  }

  function afterRoundChange(proposal, note) {
    $("s-round-out").textContent = roundSummary(currentRound, currentCovenant);
    show("s-round-out");
    $("d-round").value = T.serializeRound(currentRound); // fan out to Disburse
    renderSigs();
    const st = T.roundStatus(currentRound, currentCovenant);
    if (st.ready && proposal.status === "open") {
      T.assertProposalTransition("open", "quorum");
      proposal.status = "quorum";
      save(LS.proposals, proposals);
      audit("proposal.quorum", "treasury", `${proposal.fingerprint}: ${st.have}-of-${st.need} signatures`);
      renderProposals();
    }
    if (note) audit(note.kind, note.actor, note.detail);
  }

  $("s-import-btn").addEventListener("click", () => {
    setErr("s-err", "");
    try {
      let p;
      try {
        p = JSON.parse($("s-import").value);
      } catch {
        throw new Error("proposal is not valid JSON");
      }
      // the network comes from the registered vault, not the import text
      const vault = vaults.find((v) => v.descriptor === p.vault);
      if (!vault) throw new Error("proposal is for an unknown vault — register its descriptor first");
      T.verifyProposal(p, netOf(vault));
      if (!findProposal(p.id)) {
        proposals.unshift(p);
        save(LS.proposals, proposals);
      }
      currentProposalId = p.id;
      $("s-import").value = "";
      audit("proposal.imported", "treasury", `${p.fingerprint} from cosigner`);
      renderProposals();
    } catch (e) {
      setErr("s-err", e.message);
    }
  });

  $("s-estfee").addEventListener("click", async () => {
    setErr("s-err", "");
    try {
      const p = findProposal($("s-proposal").value);
      if (!p) throw new Error("select a proposal first");
      const { vault } = covenantFor(p);
      const r = await T.fetchFeeRateGrainsPerVByte(bbBase(vault));
      $("s-feerate").value = String(Math.max(1, Math.ceil(r)));
    } catch (e) {
      setErr("s-err", "fee estimate failed: " + e.message);
    }
  });

  function parseUtxoField() {
    const m = $("s-utxo").value.trim().match(/^([0-9a-fA-F]{64})\s*:\s*(\d+)$/);
    if (!m) throw new Error("UTXO: use the form txid:vout");
    const value = Number($("s-utxo-value").value.trim());
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("UTXO value must be a positive integer (grains)");
    return { txid: m[1].toLowerCase(), vout: parseInt(m[2], 10), value };
  }

  $("s-buildround").addEventListener("click", () => {
    setErr("s-err", "");
    try {
      const p = findProposal($("s-proposal").value);
      if (!p) throw new Error("select a proposal first");
      if (p.status === "cancelled" || p.status === "disbursed") throw new Error(`proposal is ${p.status}`);
      const { covenant, vault } = covenantFor(p);
      const network = netOf(vault);
      const feeRate = Number($("s-feerate").value);
      if (!Number.isFinite(feeRate) || feeRate <= 0) throw new Error("bad fee rate");
      const utxo = parseUtxoField();
      const { round } = T.buildProposalRound(vault, p, network, { utxo, feeRateGrainsPerVByte: feeRate });
      save(LS.proposals, proposals);
      currentRound = T.parseRound(T.serializeRound(round), network);
      currentCovenant = covenant;
      afterRoundChange(p, { kind: "round.built", actor: "treasury", detail: `${p.fingerprint}: digest ${short(round.digest, 12, 8)}, fee ${prl(round.feeGrains)} PRL` });
    } catch (e) {
      setErr("s-err", e.message);
    }
  });

  $("s-load-round").addEventListener("click", () => {
    setErr("s-err", "");
    try {
      const p = findProposal($("s-proposal").value);
      if (!p) throw new Error("select a proposal first");
      const { covenant, vault } = covenantFor(p);
      const round = T.parseRound($("s-round-json").value, netOf(vault)); // full re-verify
      const match = T.roundMatchesProposal(p, round, covenant, netOf(vault));
      if (!match.ok) throw new Error("round does not match this proposal: " + match.why);
      currentRound = round;
      currentCovenant = covenant;
      if (!p.roundDigests.includes(round.digest)) { p.roundDigests.push(round.digest); save(LS.proposals, proposals); }
      afterRoundChange(p, { kind: "round.loaded", actor: "treasury", detail: `${p.fingerprint}: loaded round ${short(round.digest, 12, 8)}` });
    } catch (e) {
      setErr("s-err", e.message);
    }
  });

  $("s-export").addEventListener("click", (e) => {
    if (!currentRound) { setErr("s-err", "no round to export — build or load one first"); return; }
    copyText(T.serializeRound(currentRound), e.target);
  });

  $("s-review").addEventListener("click", () => {
    setErr("s-err", "");
    try {
      if (!currentRound || !currentCovenant) throw new Error("build or load a signing round first");
      const p0 = findProposal($("s-proposal").value);
      if (!p0) throw new Error("select a proposal first");
      const network0 = netOf(vaults.find((v) => v.descriptor === p0.vault) || { network: "mainnet" });
      const label = $("s-keylabel").value.trim() || "cosigner";
      const { xonly } = T.cosignerKeyFromInput($("s-key").value, network0);
      // membership check against the CURRENT round's vault (loud refusal here, not at sign time)
      const vaultKeys = currentCovenant.keys.map((k) => k.xonly);
      if (!vaultKeys.includes(xonly)) {
        throw new Error(`REFUSED: key ${short(xonly, 12, 8)} is NOT a cosigner of this vault`);
      }
      const d = T.describeRound(currentRound, currentCovenant);
      $("s-review-out").textContent = [
        `You are about to sign as "${label}"  (key ${short(xonly, 16, 10)})`,
        ``,
        `pay      : ${d.outputs.filter((o) => !o.change).map((o) => `${o.value} PRL → ${o.address}`).join(", ")}`,
        `fee      : ${d.fee} PRL  (${d.feeRate} grains/vB)`,
        `change   : ${d.outputs.filter((o) => o.change).map((o) => o.value + " PRL → vault").join(", ") || "none (remainder to fee)"}`,
        `digest   : ${currentRound.digest}`,
        ``,
        `This signature authorizes the spend above and nothing else.`,
      ].join("\n");
      show("s-review-wrap");
    } catch (e) {
      setErr("s-err", e.message);
    }
  });
  $("s-cancel-review").addEventListener("click", () => hide("s-review-wrap"));

  $("s-confirm").addEventListener("click", () => {
    setErr("s-err", "");
    try {
      const p = findProposal($("s-proposal").value);
      if (!p) throw new Error("select a proposal first");
      const label = $("s-keylabel").value.trim() || "cosigner";
      const network = netOf(vaults.find((v) => v.descriptor === p.vault) || { network: "mainnet" });
      const { priv, xonly } = T.cosignerKeyFromInput($("s-key").value, network);
      keys.set(label, priv, xonly);           // in-memory only
      priv.fill(0);                            // the parsed copy is wiped; the vault holds its own
      T.signRound(currentRound, currentCovenant, T.bytesToHex(keys.get(label).priv));
      $("s-key").value = "";                   // clear the field; the vault keeps the key until wipe
      hide("s-review-wrap");
      renderKeyStatus();
      afterRoundChange(p, { kind: "signature.added", actor: label, detail: `${p.fingerprint}: key ${short(xonly, 12, 8)}` });
    } catch (e) {
      setErr("s-err", e.message);
    }
  });

  $("s-importsig-btn").addEventListener("click", () => {
    setErr("s-err", "");
    try {
      const p = findProposal($("s-proposal").value);
      if (!p || !currentRound || !currentCovenant) throw new Error("build or load a signing round first");
      T.importSig(currentRound, currentCovenant, $("s-importkey").value, $("s-importsig").value);
      $("s-importkey").value = ""; $("s-importsig").value = "";
      afterRoundChange(p, { kind: "signature.added", actor: "treasury", detail: `${p.fingerprint}: imported cosigner signature` });
    } catch (e) {
      setErr("s-err", e.message);
    }
  });

  $("s-wipe").addEventListener("click", () => {
    keys.wipe();
    renderKeyStatus();
    audit("keys.wiped", "treasury", "in-memory cosigner keys wiped");
  });

  /* ================= 4 · DISBURSE ================= */

  let lastSpend = null;

  $("d-verify-match").addEventListener("click", () => {
    setErr("d-err", "");
    $("d-match-out").textContent = "";
    try {
      const p = findProposal($("d-proposal").value);
      if (!p) throw new Error("select a proposal first");
      const { covenant, vault } = covenantFor(p);
      const network = netOf(vault);
      const round = T.parseRound($("d-round").value, network);
      const match = T.roundMatchesProposal(p, round, covenant, network);
      if (!match.ok) throw new Error("MISMATCH: " + match.why);
      const st = T.roundStatus(round, covenant);
      $("d-match-out").textContent = `✓ round matches proposal intent · quorum ${st.have}/${st.need}${st.ready ? " — READY" : " — NOT READY"}`;
      lastSpend = { proposal: p, round, covenant, network, vault };
    } catch (e) {
      lastSpend = null;
      setErr("d-err", e.message);
    }
  });

  $("d-finalize").addEventListener("click", () => {
    setErr("d-err", "");
    try {
      if (!lastSpend) { $("d-verify-match").click(); }
      if (!lastSpend) throw new Error("check the intent match first");
      const { proposal, round, covenant, network } = lastSpend;
      const spend = T.finalizeProposalSpend(proposal, round, covenant, network);
      $("d-txid").textContent = spend.txid;
      $("d-vbytes").textContent = String(spend.vBytes ?? spend.totalBytes);
      $("d-fee").textContent = prl(round.feeGrains) + " PRL";
      $("d-hex").value = spend.hex;
      show("d-txout");
      hide("d-broadcast-wrap");
      $("d-broadcast-out").textContent = "";
      lastSpend.spend = spend;
      audit("tx.finalized", "treasury", `${proposal.fingerprint}: ${spend.txid} (${prl(round.feeGrains)} PRL fee)`);
    } catch (e) {
      setErr("d-err", e.message);
    }
  });

  $("d-copy-hex").addEventListener("click", (e) => copyText($("d-hex").value, e.target));

  $("d-broadcast").addEventListener("click", () => {
    if (!lastSpend || !lastSpend.spend) { setErr("d-err", "finalize the transaction first"); return; }
    show("d-broadcast-wrap");
  });
  $("d-broadcast-cancel").addEventListener("click", () => hide("d-broadcast-wrap"));
  $("d-broadcast-confirm").addEventListener("click", async () => {
    setErr("d-err", "");
    try {
      const { proposal, vault, spend } = lastSpend;
      const txid = await T.broadcastTx(bbBase(vault), spend.hex);
      $("d-broadcast-out").textContent = "broadcast accepted · txid " + txid;
      T.assertProposalTransition(proposal.status, "disbursed");
      proposal.status = "disbursed";
      proposal.txids.push(txid);
      save(LS.proposals, proposals);
      audit("tx.broadcast", "treasury", `${proposal.fingerprint}: ${txid}`);
      renderProposals();
      hide("d-broadcast-wrap");
    } catch (e) {
      setErr("d-err", "broadcast failed: " + e.message);
    }
  });

  /* schedules */
  function renderSchedules() {
    const now = new Date().toISOString();
    const rows = schedules.map((s) => {
      const p = findProposal(s.proposalId);
      let next = "—";
      try { next = T.nextDueISO(s.startISO, s.recurrence, now).slice(0, 10); } catch {}
      return `<tr>
        <td class="mono">${p ? esc(p.fingerprint) : "?"}</td>
        <td>every ${s.recurrence.every} ${s.recurrence.unit}</td>
        <td class="mono">${esc(next)}</td>
        <td class="mono dim">${s.lastPaid ? esc(s.lastPaid.slice(0, 10)) : "—"}</td>
        <td><span class="badge ${s.active ? "open" : "cancelled"}">${s.active ? "active" : "paused"}</span></td>
        <td><button data-action="paid" data-id="${esc(s.id)}">Mark paid</button>
            <button data-action="toggle" data-id="${esc(s.id)}">${s.active ? "Pause" : "Resume"}</button>
            <button data-action="del" data-id="${esc(s.id)}">Delete</button></td>
      </tr>`;
    }).join("");
    $("d-sched-rows").innerHTML = rows || `<tr><td colspan="6" class="dim">No schedules. Recurring proposals are calendar reminders — payouts still need quorum.</td></tr>`;
  }

  $("d-sched-add").addEventListener("click", () => {
    setErr("d-err", "");
    try {
      const p = findProposal($("d-sched-proposal").value);
      if (!p) throw new Error("select a proposal first");
      const recurrence = T.validateRecurrence({ unit: $("d-sched-unit").value, every: $("d-sched-every").value });
      const start = $("d-sched-start").value;
      if (!start) throw new Error("pick a start date");
      const s = {
        id: T.sha256HexText(p.id + start + JSON.stringify(recurrence)).slice(0, 16),
        proposalId: p.id,
        startISO: new Date(start + "T00:00:00Z").toISOString(),
        recurrence,
        lastPaid: null,
        active: true,
        createdAt: new Date().toISOString(),
      };
      if (schedules.some((x) => x.id === s.id)) throw new Error("identical schedule already exists");
      schedules.push(s);
      save(LS.schedules, schedules);
      audit("schedule.added", "treasury", `${p.fingerprint}: every ${recurrence.every} ${recurrence.unit} from ${start}`);
      renderSchedules();
    } catch (e) {
      setErr("d-err", e.message);
    }
  });

  $("d-sched-rows").addEventListener("click", (e) => {
    const btn = e.target.closest ? e.target.closest("button[data-action]") : null;
    if (!btn) return;
    const s = schedules.find((x) => x.id === btn.dataset.id);
    if (!s) return;
    const p = findProposal(s.proposalId);
    if (btn.dataset.action === "paid") {
      s.lastPaid = new Date().toISOString();
      audit("schedule.paid", "treasury", `${p ? p.fingerprint : s.proposalId}: marked paid`);
    } else if (btn.dataset.action === "toggle") {
      s.active = !s.active;
      audit("schedule.toggled", "treasury", `${p ? p.fingerprint : s.proposalId}: ${s.active ? "resumed" : "paused"}`);
    } else if (btn.dataset.action === "del") {
      schedules = schedules.filter((x) => x.id !== s.id);
      audit("schedule.deleted", "treasury", `${p ? p.fingerprint : s.proposalId}`);
    }
    save(LS.schedules, schedules);
    renderSchedules();
  });

  /* ================= 5 · AUDIT ================= */

  $("a-verify").addEventListener("click", () => {
    const v = T.verifyAuditChain(auditLog);
    $("a-verdict").textContent = v.ok
      ? `✓ chain intact — ${v.entries} entries, head ${short(v.head, 12, 8)}`
      : `✗ TAMPERED at seq ${v.badSeq}: ${v.why}`;
    $("a-verdict").className = v.ok ? "ok" : "err";
  });
  $("a-export-json").addEventListener("click", () => {
    $("a-export").value = T.exportAuditJSON(auditLog);
    show("a-export");
  });
  $("a-export-csv").addEventListener("click", () => {
    $("a-export").value = T.exportAuditCSV(auditLog);
    show("a-export");
  });
  $("a-clear").addEventListener("click", () => {
    auditLog = [];
    save(LS.audit, auditLog);
    audit("log.cleared", "treasury", "audit log cleared by operator (fresh genesis)");
    renderAudit();
  });

  /* ---------- boot ---------- */
  renderKeyStatus();
  renderVaults();
  renderProposals();
  renderSchedules();
  renderAudit();
})();
