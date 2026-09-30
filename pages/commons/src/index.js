// Pearl Commons — quadratic funding rounds desk UI.
// window.PearlCommons. No keys, no signing: the desk only RECORDS rounds,
// projects and contributions (local ledger) and computes open QF math.
// Settlement is manual on-chain by the round operator. Honest limits panel
// is always visible.
import {
  GRAIN_PER_PRL,
  NETWORKS,
  COMMONS_VERSION,
  ROUND_NAME_MIN, ROUND_NAME_MAX,
  PROJECT_NAME_MIN, PROJECT_NAME_MAX,
  DONOR_LABEL_MIN, DONOR_LABEL_MAX,
  DESC_MAX, MAX_PROJECTS_PER_ROUND,
  parsePRLtoGrains, formatPRL,
  validatePearlAddress,
  normalizeDonorLabel,
  createRound, roundStatus, canContribute,
  projectCategories, createProject,
  recordContribution,
  aggregateByDonor, qfDesiredMatch, computeResults,
  appendAuditEvent, verifyAuditChain,
  fetchBlockbookTx, locateContributionOutput,
  sha256HexText, canon,
} from "./commons-core.js";

const LS_KEY = "pearl-commons/v1";

const defaultState = () => ({
  v: COMMONS_VERSION,
  rounds: [],
  projects: [],
  contributions: [],
  audit: [],
  settings: { network: "mainnet", blockbook: NETWORKS.mainnet.blockbook },
});

let S = defaultState();

function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const j = JSON.parse(raw);
    if (!j || j.v !== COMMONS_VERSION) return;
    if (!Array.isArray(j.rounds) || !Array.isArray(j.projects) || !Array.isArray(j.contributions) || !Array.isArray(j.audit)) return;
    S = { ...defaultState(), ...j, settings: { ...defaultState().settings, ...(j.settings || {}) } };
  } catch { /* hostile storage: start clean */ }
}

function saveState() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(S));
  } catch { /* quota/private mode: session-only */ }
}

function audit(type, body) {
  appendAuditEvent(S.audit, type, body);
  saveState();
}

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function fmtDate(iso) {
  const d = new Date(iso);
  return isFinite(d) ? d.toLocaleString() : "—";
}

function statusBadge(st) {
  const cls = { upcoming: "st-up", active: "st-ac", closed: "st-cl", finalized: "st-fi" }[st] || "";
  return `<span class="status ${cls}">${esc(st)}</span>`;
}

function getRound(id) { return S.rounds.find((r) => r.id === id); }
function roundProjects(rid) { return S.projects.filter((p) => p.roundId === rid); }
function roundContributions(rid) { return S.contributions.filter((c) => c.roundId === rid); }

function setMsg(id, text, ok = false) {
  const el = $(id);
  if (!el) return;
  el.textContent = text || "";
  el.className = "msg" + (text ? (ok ? " ok" : " err") : "");
}

/* ---------------- Rounds tab ---------------- */

function renderRounds() {
  const host = $("tab-rounds");
  const rows = [...S.rounds].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const cards = rows.map((r) => {
    const st = roundStatus(r);
    const np = roundProjects(r.id).length;
    const nc = roundContributions(r.id).length;
    return `<article class="card round-card" data-round="${r.id}">
      <div class="card-top"><h3>${esc(r.name)}</h3>${statusBadge(st)}</div>
      <p class="muted">${esc(r.description || "No description.")}</p>
      <dl class="facts">
        <div><dt>Matching pool</dt><dd>${esc(formatPRL(r.matchingPoolGrains))} PRL</dd></div>
        <div><dt>Min. contribution</dt><dd>${esc(formatPRL(r.minContributionGrains))} PRL</dd></div>
        <div><dt>Window</dt><dd>${esc(fmtDate(r.startsAt))} → ${esc(fmtDate(r.endsAt))}</dd></div>
        <div><dt>Projects</dt><dd>${np}</dd></div>
        <div><dt>Contributions</dt><dd>${nc}</dd></div>
      </dl>
      <div class="card-actions">
        ${st === "closed" ? `<button data-act="finalize" data-id="${r.id}">Finalize &amp; lock results</button>` : ""}
        ${r.status !== "finalized" ? `<button class="ghost" data-act="delete-round" data-id="${r.id}">Delete</button>` : `<span class="muted small">Locked — results sealed in audit log.</span>`}
      </div>
    </article>`;
  }).join("");

  host.innerHTML = `
    <h2>Funding rounds</h2>
    <p class="lede">A round is a fixed matching pool of PRL and a contribution window.
      Projects register, donors contribute, and the desk computes each project's
      quadratic-funding match with the capital constraint applied.</p>
    <div class="grid">${cards || `<p class="muted empty">No rounds yet — create the first one below.</p>`}</div>
    <section class="panel">
      <h3>Create a round</h3>
      <form id="round-form" class="form">
        <label>Round name<input id="r-name" maxlength="${ROUND_NAME_MAX}" placeholder="e.g. Pearl Commons Q4 2026" required></label>
        <label>Description (optional)<input id="r-desc" maxlength="${DESC_MAX}" placeholder="What is this round for?"></label>
        <div class="row2">
          <label>Matching pool (PRL)<input id="r-pool" inputmode="decimal" placeholder="e.g. 5000" required></label>
          <label>Min. contribution (PRL)<input id="r-min" inputmode="decimal" placeholder="e.g. 0.5" required></label>
        </div>
        <div class="row2">
          <label>Starts<input id="r-start" type="datetime-local" required></label>
          <label>Ends<input id="r-end" type="datetime-local" required></label>
        </div>
        <button type="submit">Create round</button>
        <p id="r-msg" class="msg" role="status"></p>
      </form>
    </section>`;

  $("round-form").addEventListener("submit", (e) => {
    e.preventDefault();
    try {
      const r = createRound({
        name: $("r-name").value,
        description: $("r-desc").value,
        matchingPoolPRL: $("r-pool").value,
        minContributionPRL: $("r-min").value,
        startsAt: $("r-start").value,
        endsAt: $("r-end").value,
      });
      S.rounds.push(r);
      audit("round.created", { id: r.id, name: r.name, pool: r.matchingPoolGrains });
      saveState();
      renderAll();
      setMsg("r-msg", `Round created — status: ${roundStatus(r)}.`, true);
    } catch (err) {
      setMsg("r-msg", err.message);
    }
  });

  host.querySelectorAll("[data-act]").forEach((b) =>
    b.addEventListener("click", () => {
      const r = getRound(b.dataset.id);
      if (!r) return;
      if (b.dataset.act === "delete-round") {
        if (!confirm(`Delete round "${r.name}" and its ${roundProjects(r.id).length} projects / ${roundContributions(r.id).length} contributions?`)) return;
        S.rounds = S.rounds.filter((x) => x.id !== r.id);
        S.projects = S.projects.filter((x) => x.roundId !== r.id);
        S.contributions = S.contributions.filter((x) => x.roundId !== r.id);
        audit("round.deleted", { id: r.id, name: r.name });
        saveState(); renderAll();
      } else if (b.dataset.act === "finalize") {
        if (!confirm(`Finalize "${r.name}"? Results are computed, hashed into the audit log, and the round locks forever.`)) return;
        const res = computeResults(r, S.projects, S.contributions);
        r.status = "finalized";
        r.resultsHash = sha256HexText(canon(res));
        audit("round.finalized", { id: r.id, name: r.name, resultsHash: r.resultsHash, match: res.totals.matchGrains });
        saveState(); renderAll();
        setMsg("r-msg", "Round finalized — results sealed.", true);
      }
    })
  );
}

/* ---------------- Projects tab ---------------- */

function refreshRoundSelectors() {
  for (const id of ["p-round", "c-round", "res-round"]) {
    const sel = $(id);
    if (!sel) continue;
    const cur = sel.value;
    sel.innerHTML = S.rounds
      .map((r) => `<option value="${r.id}">${esc(r.name)} (${roundStatus(r)})</option>`)
      .join("") || `<option value="">— no rounds —</option>`;
    if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
  }
  refreshProjectSelector();
}

function refreshProjectSelector() {
  const rs = $("p-round"), cs = $("c-round"), ps = $("c-project");
  if (rs && ps) {
    const projs = roundProjects(rs.value);
    ps.innerHTML = projs.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("") || `<option value="">— no projects —</option>`;
  }
  if (cs && ps && !$("p-round")) { /* contribute tab only */ }
}

function renderProjects() {
  const host = $("tab-projects");
  const rid = ($("p-round") && $("p-round").value) || (S.rounds[0] && S.rounds[0].id) || "";
  const r = getRound(rid);
  const projs = r ? roundProjects(r.id) : [];
  const locked = r && r.status === "finalized";

  const cards = projs.map((p) => {
    const agg = S.contributions.filter((c) => c.projectId === p.id);
    const donors = new Set(agg.map((c) => c.donor)).size;
    const sum = agg.reduce((a, c) => a + BigInt(c.amountGrains), 0n);
    return `<article class="card">
      <div class="card-top"><h3>${esc(p.name)}</h3><span class="pill">${esc(p.category)}</span></div>
      <p class="muted small mono">${esc(p.address)}</p>
      <p class="muted">${esc(p.description || "No description.")}</p>
      <dl class="facts">
        <div><dt>Raised</dt><dd>${esc(formatPRL(sum))} PRL</dd></div>
        <div><dt>Donors</dt><dd>${donors}</dd></div>
        <div><dt>Contributions</dt><dd>${agg.length}</dd></div>
      </dl>
    </article>`;
  }).join("");

  host.innerHTML = `
    <h2>Projects</h2>
    <p class="lede">Projects register a Pearl Taproot address where their funds go.
      The desk validates every address against chain policy (bech32m, witness v1, 32-byte program).</p>
    <label class="inline-label">Round
      <select id="p-round">${S.rounds.map((x) => `<option value="${x.id}" ${x.id === rid ? "selected" : ""}>${esc(x.name)} (${roundStatus(x)})</option>`).join("") || `<option value="">— no rounds —</option>`}</select>
    </label>
    <div class="grid">${cards || `<p class="muted empty">No projects in this round yet.</p>`}</div>
    <section class="panel">
      <h3>Register a project</h3>
      ${locked ? `<p class="muted">This round is finalized — registration is closed.</p>` : `
      <form id="project-form" class="form">
        <label>Project name<input id="p-name" maxlength="${PROJECT_NAME_MAX}" placeholder="e.g. Pearl Docs" required></label>
        <label>Payout address (prl1… Taproot)<input id="p-address" class="mono" placeholder="prl1…" required spellcheck="false"></label>
        <div class="row2">
          <label>Category<select id="p-category">${projectCategories().map((c) => `<option>${c}</option>`).join("")}</select></label>
          <label>Description (optional)<input id="p-desc" maxlength="${DESC_MAX}"></label>
        </div>
        <button type="submit">Register project</button>
        <p id="p-msg" class="msg" role="status"></p>
      </form>`}
    </section>`;

  $("p-round").addEventListener("change", () => { renderProjects(); });
  const form = $("project-form");
  if (form) form.addEventListener("submit", (e) => {
    e.preventDefault();
    try {
      const rr = getRound($("p-round").value);
      if (!rr) throw new Error("Pick a round first.");
      if (roundProjects(rr.id).length >= MAX_PROJECTS_PER_ROUND)
        throw new Error(`This round already has the maximum ${MAX_PROJECTS_PER_ROUND} projects.`);
      const p = createProject({
        roundId: rr.id,
        name: $("p-name").value,
        address: $("p-address").value,
        networkId: S.settings.network,
        category: $("p-category").value,
        description: $("p-desc").value,
      });
      S.projects.push(p);
      audit("project.registered", { id: p.id, roundId: rr.id, name: p.name, address: p.address });
      saveState();
      renderAll();
      // stay on the projects tab after the re-render
      document.querySelector('#steps [data-tab="projects"]').click();
      setMsg("p-msg", `Registered — address re-derived and canonicalized.`, true);
    } catch (err) {
      setMsg("p-msg", err.message);
    }
  });
}

/* ---------------- Contribute tab ---------------- */

function renderContribute() {
  const host = $("tab-contribute");
  const rid = ($("c-round") && $("c-round").value) || (S.rounds[0] && S.rounds[0].id) || "";
  const r = getRound(rid);
  const projs = r ? roundProjects(r.id) : [];
  const pid = ($("c-project") && $("c-project").value) || (projs[0] && projs[0].id) || "";
  const st = r ? roundStatus(r) : "—";
  const open = r ? canContribute(r) : false;

  const recent = r
    ? [...roundContributions(r.id)].sort((a, b) => b.notedAt.localeCompare(a.notedAt)).slice(0, 8)
    : [];

  host.innerHTML = `
    <h2>Contribute</h2>
    <p class="lede">Record a contribution to a project. Donate on-chain yourself, then log it
      here — or paste the txid and let the desk read the payment off Blockbook (GET-only, no keys).</p>
    <div class="row2">
      <label class="inline-label">Round
        <select id="c-round">${S.rounds.map((x) => `<option value="${x.id}" ${x.id === rid ? "selected" : ""}>${esc(x.name)} (${roundStatus(x)})</option>`).join("") || `<option value="">— no rounds —</option>`}</select>
      </label>
      <label class="inline-label">Project
        <select id="c-project">${projs.map((p) => `<option value="${p.id}" ${p.id === pid ? "selected" : ""}>${esc(p.name)}</option>`).join("") || `<option value="">— no projects —</option>`}</select>
      </label>
    </div>
    ${r ? `<p>Round status: ${statusBadge(st)}${open ? "" : ` — contributions are only accepted while a round is <em>active</em>.`}</p>` : ""}
    <section class="panel">
      <h3>Record a contribution</h3>
      ${!open ? `<p class="muted">Select an active round to record contributions.</p>` : `
      <form id="contrib-form" class="form">
        <div class="row2">
          <label>Donor label<input id="c-donor" maxlength="${DONOR_LABEL_MAX}" placeholder="e.g. alice" required></label>
          <label>Amount (PRL)<input id="c-amount" inputmode="decimal" placeholder="e.g. 25" required></label>
        </div>
        <label>On-chain txid (optional)<input id="c-txid" class="mono" placeholder="64 hex chars" spellcheck="false"></label>
        <div class="btn-row">
          <button type="button" id="c-verify" class="ghost">Verify txid on Blockbook</button>
          <button type="submit">Record contribution</button>
        </div>
        <p id="c-msg" class="msg" role="status"></p>
      </form>`}
    </section>
    <section class="panel">
      <h3>Recent contributions</h3>
      ${recent.length ? `<table class="table"><thead><tr><th>Donor</th><th>Project</th><th>Amount</th><th>txid</th><th>Logged</th></tr></thead><tbody>
        ${recent.map((c) => {
          const p = S.projects.find((x) => x.id === c.projectId);
          return `<tr><td>${esc(c.donor)}</td><td>${esc(p ? p.name : "?")}</td><td class="num">${esc(formatPRL(c.amountGrains))} PRL</td><td class="mono small">${c.txid ? esc(c.txid.slice(0, 12)) + "…" : "—"}</td><td class="small">${esc(fmtDate(c.notedAt))}</td></tr>`;
        }).join("")}</tbody></table>` : `<p class="muted empty">None logged yet.</p>`}
    </section>`;

  $("c-round").addEventListener("change", () => renderContribute());
  $("c-project").addEventListener("change", () => renderContribute());
  const form = $("contrib-form");
  if (!form) return;

  $("c-verify").addEventListener("click", async () => {
    const txid = $("c-txid").value.trim();
    const proj = S.projects.find((x) => x.id === $("c-project").value);
    if (!proj) { setMsg("c-msg", "Pick a project first."); return; }
    setMsg("c-msg", "Reading transaction from Blockbook…", true);
    try {
      const tx = await fetchBlockbookTx(S.settings.blockbook, txid);
      const hit = locateContributionOutput(tx, proj.address, "1");
      if (!hit) { setMsg("c-msg", `No output in ${txid.slice(0, 12)}… pays ${proj.name}'s address.`); return; }
      $("c-amount").value = formatPRL(hit.valueGrains);
      setMsg("c-msg", `Found ${formatPRL(hit.valueGrains)} PRL to this project (${tx.confirmations} confirmations). Amount filled in — review, then record.`, true);
    } catch (err) {
      setMsg("c-msg", "Blockbook lookup failed: " + err.message);
    }
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    try {
      const rr = getRound($("c-round").value);
      const proj = S.projects.find((x) => x.id === $("c-project").value);
      if (!rr || !proj) throw new Error("Pick a round and a project first.");
      const c = recordContribution({
        round: rr, project: proj,
        donor: $("c-donor").value,
        amountPRL: $("c-amount").value,
        txid: $("c-txid").value,
      });
      S.contributions.push(c);
      audit("contribution.recorded", { id: c.id, roundId: rr.id, projectId: proj.id, donor: c.donor, amount: c.amountGrains, txid: c.txid || null });
      saveState();
      renderAll();
      document.querySelector('#steps [data-tab="contribute"]').click();
      setMsg("c-msg", `Recorded ${formatPRL(c.amountGrains)} PRL from ${c.donor}.`, true);
    } catch (err) {
      setMsg("c-msg", err.message);
    }
  });
}

/* ---------------- Results tab ---------------- */

function renderResults() {
  const host = $("tab-results");
  const rid = ($("res-round") && $("res-round").value) || (S.rounds[0] && S.rounds[0].id) || "";
  const r = getRound(rid);
  const res = r ? computeResults(r, S.projects, S.contributions) : null;
  const maxTotal = res && res.projects.length ? BigInt(res.projects[0].totalGrains) : 0n;

  const rows = res ? res.projects.map((p, i) => {
    const tot = BigInt(p.totalGrains);
    const pct = maxTotal > 0n ? Number((tot * 10000n) / maxTotal) / 100 : 0;
    return `<tr>
      <td class="num">${i + 1}</td>
      <td><strong>${esc(p.name)}</strong><br><span class="mono small muted">${esc(p.address.slice(0, 18))}…</span></td>
      <td class="num">${p.donorCount}</td>
      <td class="num">${esc(formatPRL(p.contributedGrains))}</td>
      <td class="num">${esc(formatPRL(p.desiredMatchGrains))}</td>
      <td class="num match">${esc(formatPRL(p.matchGrains))}</td>
      <td class="num total">${esc(formatPRL(p.totalGrains))}</td>
      <td class="barcell"><div class="bar" style="width:${pct.toFixed(1)}%"></div></td>
    </tr>`;
  }).join("") : "";

  host.innerHTML = `
    <h2>Results — quadratic funding</h2>
    <p class="lede">match<sub>p</sub> = (Σ√c<sub>i</sub>)² − Σc<sub>i</sub>, aggregated per donor.
      ${res && res.capitalConstrained ? `<strong class="warn">Capital-constrained:</strong> desired matching exceeded the pool, so every match was scaled by k = ${res.scaleK.toFixed(6)}.` : "The pool covers all desired matching — no scaling needed."}</p>
    <label class="inline-label">Round
      <select id="res-round">${S.rounds.map((x) => `<option value="${x.id}" ${x.id === rid ? "selected" : ""}>${esc(x.name)} (${roundStatus(x)})</option>`).join("") || `<option value="">— no rounds —</option>`}</select>
    </label>
    ${!res ? `<p class="muted empty">Create a round to see results.</p>` : `
    <div class="stat-row">
      <div class="stat"><span>Matching pool</span><strong>${esc(formatPRL(res.poolGrains))} PRL</strong></div>
      <div class="stat"><span>Contributed</span><strong>${esc(formatPRL(res.totals.contributedGrains))} PRL</strong></div>
      <div class="stat"><span>Donors</span><strong>${res.totals.uniqueDonors}</strong></div>
      <div class="stat"><span>Matched</span><strong>${esc(formatPRL(res.totals.matchGrains))} PRL</strong></div>
      <div class="stat"><span>Pool remainder</span><strong>${esc(formatPRL(res.totals.remainderGrains))} PRL</strong></div>
    </div>
    <table class="table results"><thead><tr>
      <th>#</th><th>Project</th><th>Donors</th><th>Contributed</th><th>Desired match</th><th>Match paid</th><th>Total</th><th></th>
    </tr></thead><tbody>${rows || `<tr><td colspan="8" class="muted">No projects yet.</td></tr>`}</tbody></table>
    ${r && r.status === "finalized" ? `<p class="sealed">🔒 Finalized — results hash <code class="mono">${esc(r.resultsHash || "")}</code> is sealed in the audit log.</p>` : `<p class="muted small">Not finalized: numbers update live as contributions are logged. Finalize the round on the Rounds tab to lock them.</p>`}
    <div class="btn-row">
      <button id="res-json" class="ghost">Export round JSON</button>
      <button id="res-csv" class="ghost">Export results CSV</button>
    </div>`}`;

  $("res-round").addEventListener("change", () => renderResults());
  if (!res) return;
  $("res-json").addEventListener("click", () => {
    const packet = { v: COMMONS_VERSION, exportedAt: new Date().toISOString(), round: r, projects: roundProjects(r.id), contributions: roundContributions(r.id), results: res, audit: S.audit.filter((e) => e.body && (e.body.roundId === r.id || e.body.id === r.id)) };
    download(`pearl-commons-${r.id.slice(0, 8)}.json`, JSON.stringify(packet, null, 2), "application/json");
  });
  $("res-csv").addEventListener("click", () => {
    const lines = ["rank,project,address,category,donors,contributed_prl,desired_match_prl,match_prl,total_prl"];
    res.projects.forEach((p, i) => lines.push([i + 1, csv(p.name), p.address, p.category, p.donorCount, formatPRL(p.contributedGrains), formatPRL(p.desiredMatchGrains), formatPRL(p.matchGrains), formatPRL(p.totalGrains)].join(",")));
    download(`pearl-commons-${r.id.slice(0, 8)}.csv`, lines.join("\n"), "text/csv");
  });
}

function csv(s) { return `"${String(s).replace(/"/g, '""')}"`; }

function download(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

/* ---------------- Audit tab ---------------- */

function renderAudit() {
  const host = $("tab-audit");
  const items = [...S.audit].reverse().slice(0, 120).map((e) => `
    <div class="audit-row"><span class="mono small">#${e.seq}</span>
      <span class="pill">${esc(e.type)}</span>
      <span class="mono small muted">${esc(e.hash.slice(0, 16))}…</span>
      <span class="small muted">${esc(fmtDate(e.ts))}</span>
      <details><summary class="small">body</summary><pre class="mono small">${esc(JSON.stringify(e.body, null, 1))}</pre></details>
    </div>`).join("");

  host.innerHTML = `
    <h2>Audit log</h2>
    <p class="lede">Every round, project, and contribution is appended to a hash-chained log
      (each entry commits to the previous entry's SHA-256). Tampering breaks the chain.</p>
    <div class="btn-row">
      <button id="audit-verify">Verify chain</button>
      <button id="audit-export" class="ghost">Export JSON</button>
    </div>
    <p id="audit-msg" class="msg" role="status"></p>
    <div class="audit-list">${items || `<p class="muted empty">No events yet.</p>`}</div>`;

  $("audit-verify").addEventListener("click", () => {
    const v = verifyAuditChain(S.audit);
    setMsg("audit-msg", v.ok ? `Chain valid — ${v.entries} entries, tip ${v.tip.slice(0, 16)}…` : `CHAIN BROKEN at entry #${v.badSeq}: ${v.reason}`, v.ok);
  });
  $("audit-export").addEventListener("click", () => download("pearl-commons-audit.json", JSON.stringify(S.audit, null, 2), "application/json"));
}

/* ---------------- Settings tab ---------------- */

function renderSettings() {
  const host = $("tab-settings");
  host.innerHTML = `
    <h2>Settings</h2>
    <section class="panel"><h3>Network &amp; data</h3>
      <form id="settings-form" class="form">
        <label>Network (address validation)
          <select id="s-network">
            <option value="mainnet" ${S.settings.network === "mainnet" ? "selected" : ""}>Mainnet (prl1…)</option>
            <option value="testnet" ${S.settings.network === "testnet" ? "selected" : ""}>Testnet (tprl1…)</option>
          </select>
        </label>
        <label>Blockbook URL (GET-only tx lookups)<input id="s-blockbook" class="mono" value="${esc(S.settings.blockbook)}" spellcheck="false"></label>
        <button type="submit">Save settings</button>
        <p id="s-msg" class="msg" role="status"></p>
      </form>
    </section>
    <section class="panel danger"><h3>Danger zone</h3>
      <p class="muted">Erase every round, project, contribution, and audit event stored in this browser.</p>
      <button id="s-wipe" class="danger-btn">Wipe all local data</button>
    </section>`;

  $("settings-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const bb = $("s-blockbook").value.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//.test(bb)) { setMsg("s-msg", "Blockbook URL must start with http(s)://"); return; }
    S.settings.network = $("s-network").value;
    S.settings.blockbook = bb;
    audit("settings.changed", { network: S.settings.network, blockbook: bb });
    saveState();
    setMsg("s-msg", "Settings saved.", true);
  });
  $("s-wipe").addEventListener("click", () => {
    if (!confirm("Wipe ALL Pearl Commons data in this browser? This cannot be undone.")) return;
    S = defaultState();
    saveState();
    renderAll();
  });
}

/* ---------------- shell ---------------- */

const TABS = ["rounds", "projects", "contribute", "results", "audit", "settings"];

function renderAll() {
  renderRounds(); renderProjects(); renderContribute(); renderResults(); renderAudit(); renderSettings();
  refreshRoundSelectors();
}

function init() {
  loadState();
  document.querySelectorAll("#steps [data-tab]").forEach((b) =>
    b.addEventListener("click", () => {
      document.querySelectorAll("#steps [data-tab]").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      TABS.forEach((t) => $("tab-" + t).hidden = t !== b.dataset.tab);
    })
  );
  renderAll();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();

window.PearlCommons = {
  core: {
    parsePRLtoGrains, formatPRL, validatePearlAddress, normalizeDonorLabel,
    createRound, roundStatus, canContribute, projectCategories, createProject,
    recordContribution, aggregateByDonor, qfDesiredMatch, computeResults,
    appendAuditEvent, verifyAuditChain, fetchBlockbookTx, locateContributionOutput,
    sha256HexText, canon,
  },
  ui: { init, renderAll, get state() { return S; } },
};
