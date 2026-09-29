/* Pearl Registry — directory, claim wizard, verifier.
 * Reads the configured Pearlscriptions indexer API (GET-only) and Blockbook
 * (GET-only UTXO/fee reads; broadcast endpoint for the signed pair).
 * All crypto via window.PearlRegistry (audited Sign core + Etch commit/reveal
 * machinery) — no new cryptography. Keys live in page memory with lock/wipe.
 */
"use strict";

const $ = (id) => document.getElementById(id);
const R = window.PearlRegistry || null;

if (!R) {
  document.body.innerHTML = "<p style='color:#e05c5c;padding:2rem'>Pearl Registry failed to boot: pearl-registry.bundle.js did not load.</p>";
  throw new Error("PearlRegistry bundle missing");
}

const {
  DONATE_ADDRESS, X_HANDLE, NETWORKS, DUST_GRAIN,
  normalizeHandle, validateHandle, validateOwnerAddress,
  validateNameJson, buildClaimJson, parseNameRecord,
  buildDirectory, lookupHandle,
  planNameClaim, assertSpendableCommitValue,
  inscriptionsQuery, isNameCandidate, clampMaxPages, formatPRL, shortId,
  newMnemonic, walletFromMnemonic, walletFromWIF,
  fetchUtxos, fetchFeeRateGrainsPerVByte, broadcastTx,
  buildCommitTx, buildRevealTxSigned, extractEnvelopes, witnessOfInput,
  hexToBytes, bytesToHex,
} = R;

/* ---------- hostile-localStorage-safe store ---------- */
const memStore = {};
const store = {
  get(k, dflt = "") {
    try { return localStorage.getItem(k) ?? memStore[k] ?? dflt; }
    catch { return memStore[k] ?? dflt; }
  },
  set(k, v) {
    memStore[k] = v;
    try { localStorage.setItem(k, v); } catch {}
  },
};
const LS_IDX = "registry.indexer", LS_BB = "registry.blockbook", LS_PAGES = "registry.maxpages";

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
function okBox(html) { return `<div class="ok-box">${html}</div>`; }
function errBox(html) { return `<div class="error-box">${html}</div>`; }
function verdict(ok, title, bodyHtml) {
  return `<div class="verdict ${ok ? "ok" : "bad"}"><h3>${ok ? "✓" : "✗"} ${esc(title)}</h3>${bodyHtml}</div>`;
}
function reasonsList(reasons) {
  return `<ul class="reasons">${reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>`;
}

/* ---------- tabs ---------- */
function switchTab(name) {
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll("main > .panel").forEach((p) => p.classList.toggle("active", p.id === "tab-" + name));
}
document.querySelectorAll("#tabs button").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));

/* ---------- config ---------- */
function apiBase() { return String(store.get(LS_IDX, "")).trim().replace(/\/+$/, ""); }
function bbBase(fallback = "") { return String(store.get(LS_BB, "") || fallback).trim().replace(/\/+$/, ""); }
$("idx-base").value = store.get(LS_IDX, "");
$("idx-maxpages").value = store.get(LS_PAGES, "20");
$("cw-blockbook").value = store.get(LS_BB, "");

$("idx-base").addEventListener("change", (e) => store.set(LS_IDX, e.target.value.trim()));
$("idx-maxpages").addEventListener("change", (e) => store.set(LS_PAGES, String(clampMaxPages(e.target.value))));
$("cw-blockbook").addEventListener("change", (e) => store.set(LS_BB, e.target.value.trim()));

async function apiGet(path) {
  const base = apiBase();
  if (!base) return { ok: false, error: "NO_API", message: "No indexer API configured — paste one above." };
  try {
    const res = await fetch(base + path, { headers: { Accept: "application/json" } });
    if (!res.ok) return { ok: false, error: "HTTP_" + res.status, message: `Indexer returned HTTP ${res.status} for ${esc(path)}` };
    const data = await res.json().catch(() => null);
    if (data === null) return { ok: false, error: "BAD_JSON", message: "Indexer returned non-JSON." };
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: "NET", message: `Network error reaching the indexer: ${esc(e.message || e)}` };
  }
}

/* ================= DIRECTORY ================= */
let DIR = null; // last built directory
let DIR_META = null;

function setProgress(frac, label) {
  const bar = $("idx-progress");
  bar.hidden = false;
  $("idx-progress-fill").style.width = `${Math.round(frac * 100)}%`;
  if (label) $("idx-status").textContent = label;
}

async function scanDirectory({ forHandle = null } = {}) {
  const maxPages = clampMaxPages($("idx-maxpages").value);
  store.set(LS_PAGES, String(maxPages));
  const records = [];
  const parseFailures = [];
  let pages = 0, candidates = 0, stopEarly = null;
  for (let page = 1; page <= maxPages; page++) {
    setProgress(page / maxPages, `Scanning page ${page}/${maxPages}…`);
    const r = await apiGet("/inscriptions" + inscriptionsQuery({ order: "asc", page, limit: 100 }));
    if (!r.ok) {
      if (page === 1) { $("idx-status").innerHTML = errBox(r.message); return null; }
      $("idx-status").innerHTML = errBox(r.message + " — showing the partial scan below.");
      break;
    }
    const rows = r.data.inscriptions || r.data || [];
    if (!Array.isArray(rows) || rows.length === 0) break;
    pages = page;
    let minNum = Infinity;
    for (const row of rows) {
      const num = Number(row.inscriptionNumber);
      if (Number.isFinite(num) && num < minNum) minNum = num;
      if (!isNameCandidate(row)) continue;
      candidates++;
      const id = row.id || row.inscriptionId;
      if (!id) continue;
      const c = await apiGet(`/inscriptions/${encodeURIComponent(id)}/content`);
      if (!c.ok) { parseFailures.push({ id, reasons: [c.message] }); continue; }
      const body = c.data.bodyText ?? "";
      const p = parseNameRecord(body, Number.isFinite(num) ? num : -1, id);
      if (p.ok) records.push(p.record);
      else parseFailures.push({ id, reasons: p.reasons });
    }
    // Early stop for a targeted handle scan: pages are asc-ordered, so once a
    // page starts past the target inscription number, nothing earlier can appear.
    if (forHandle && forHandle.stopAfterNumber !== null && minNum > forHandle.stopAfterNumber) {
      stopEarly = page;
      break;
    }
    if (rows.length < 100) break;
    await new Promise((r2) => setTimeout(r2, 0)); // let the UI breathe
  }
  setProgress(1, `Scanned ${pages} page(s), ${candidates} JSON candidate(s), ${records.length} valid prl-name record(s).`);
  return { records, parseFailures, pages, candidates, stopEarly };
}

function renderDirectory(dir, meta) {
  const list = $("dir-results");
  $("dir-count").textContent = String(dir.order.length);
  if (dir.order.length === 0) {
    list.innerHTML = `<p class="muted">No prl-name records found in this scan. This is a sample of indexed data — try a different indexer or more pages.</p>`;
    return;
  }
  list.innerHTML = dir.order.map((h) => {
    const e = dir.entries[h];
    const free = e.owner === null;
    return `<div class="plate-row" data-handle="${esc(h)}" role="button" tabindex="0">
      <p class="handle">${esc(h)}</p>
      <p class="owner">${free ? '<span class="status-free">released — free to claim</span>' : esc(e.owner)}</p>
      <p class="meta">inscription <span class="mono">#${e.inscriptionNumber}</span> ·
        <span class="mono">${esc(shortId(e.inscriptionId))}</span> · ${e.history.length} event(s)</p>
    </div>`;
  }).join("");
  list.querySelectorAll(".plate-row").forEach((el) => {
    const open = () => showDetail(el.dataset.handle);
    el.addEventListener("click", open);
    el.addEventListener("keydown", (ev) => { if (ev.key === "Enter") open(); });
  });
}

function showDetail(handle) {
  const e = DIR.entries[handle];
  if (!e) return;
  const hist = e.history.map((r) => ({
    op: r.op, inscriptionNumber: r.inscriptionNumber, inscriptionId: r.inscriptionId,
    ...(r.owner ? { owner: r.owner } : {}),
    ...(r.from ? { from: r.from } : {}),
    ...(r.to ? { to: r.to } : {}),
    ts: r.ts,
  }));
  $("dir-detail").innerHTML = `<div class="card detail">
    <h3>Nameplate — ${esc(handle)}</h3>
    <dl class="kv">
      <dt>Current owner</dt><dd>${e.owner ? esc(e.owner) : '<span class="status-free">released — free to claim</span>'}</dd>
      <dt>First claim</dt><dd>inscription #${e.inscriptionNumber} · ${esc(e.inscriptionId)}</dd>
      <dt>Events</dt><dd>${e.history.length}</dd>
    </dl>
    <div class="row">
      <button class="btn small" id="detail-verify">Open in verifier →</button>
    </div>
    <h4>Event chain (first-seen order)</h4>
    <pre>${esc(JSON.stringify(hist, null, 2))}</pre>
  </div>`;
  $("detail-verify").addEventListener("click", () => {
    switchTab("verify");
    $("v-id").value = e.inscriptionId;
    $("v-run").click();
  });
  $("dir-detail").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

$("idx-scan").addEventListener("click", async () => {
  const btn = $("idx-scan");
  btn.disabled = true;
  try {
    const s = await scanDirectory();
    if (!s) return;
    DIR = buildDirectory(s.records);
    DIR_META = s;
    renderDirectory(DIR, s);
    const rej = DIR.rejected.length;
    $("idx-status").innerHTML = okBox(
      `Register built: <strong>${DIR.order.length}</strong> handle(s), ${DIR.accepted.length} accepted record(s)` +
      (rej ? `, <strong>${rej} rejected</strong> (losing claims, bad transfers)` : "") +
      (s.parseFailures.length ? `, ${s.parseFailures.length} unparsable JSON bodie(s) skipped` : "") +
      `. <span class="honest">Sample of indexed data — capped at ${s.pages} page(s).</span>`
    );
  } finally { btn.disabled = false; }
});

$("dir-lookup").addEventListener("click", () => {
  const out = $("dir-lookup-out");
  const q = $("dir-search").value;
  const v = validateHandle(q);
  if (!v.ok) { out.innerHTML = verdict(false, "Invalid handle", reasonsList(v.reasons)); return; }
  if (!DIR) {
    out.innerHTML = `<div class="verdict warn"><h3>⚠ No directory scanned yet</h3>
      <p><code class="mono">${esc(v.handle)}</code> is a valid handle shape, but ownership can only be
      checked against a scan. Scan the register first — and remember the scan is a sample of indexed data.</p></div>`;
    return;
  }
  const e = lookupHandle(DIR, v.handle);
  if (!e) {
    out.innerHTML = verdict(true, `Handle "${esc(v.handle)}" is free in this scan`,
      `<p>No prl-name record for it in the last scan (${DIR_META.pages} page(s)). First-seen still applies — someone else's claim can land first.</p>`);
  } else if (e.owner) {
    out.innerHTML = verdict(true, `Handle "${esc(v.handle)}" is owned`,
      `<dl class="kv"><dt>Owner</dt><dd>${esc(e.owner)}</dd><dt>First claim</dt><dd>#${e.inscriptionNumber} · ${esc(shortId(e.inscriptionId))}</dd></dl>`);
  } else {
    out.innerHTML = verdict(true, `Handle "${esc(v.handle)}" was released`,
      `<p>Previously registered, now free for re-claim (released at inscription #${e.lastInscriptionNumber ?? e.inscriptionNumber}).</p>`);
  }
});
$("dir-search").addEventListener("keydown", (ev) => { if (ev.key === "Enter") $("dir-lookup").click(); });

/* ================= CLAIM WIZARD ================= */
const cw = { handle: null, owner: null, network: "mainnet", wallet: null, plan: null, commit: null, reveal: null, nameJson: null };
function cwStep(name) {
  document.querySelectorAll("#cw-steps button").forEach((b) => b.classList.toggle("active", b.dataset.step === name));
  ["s1", "s2", "s3"].forEach((s) => $("cw-" + s).classList.toggle("active", s === name));
}
document.querySelectorAll("#cw-steps button").forEach((b) => b.addEventListener("click", () => cwStep(b.dataset.step)));
$("cw-back1").addEventListener("click", () => cwStep("s1"));
$("cw-back2").addEventListener("click", () => cwStep("s2"));

function nowTs() { return Math.floor(Date.now() / 1000); }

$("cw-check").addEventListener("click", () => {
  const v = validateHandle($("cw-handle").value);
  const st = $("cw-handle-status");
  const sq = $("cw-squat");
  cw.handle = null; $("cw-to2").disabled = true; sq.hidden = true;
  if (!v.ok) { st.innerHTML = verdict(false, "Invalid handle", reasonsList(v.reasons)); return; }
  cw.handle = v.handle;
  st.innerHTML = okBox(`Handle <strong>${esc(v.handle)}</strong> is well-formed. Canonical JSON will use this exact form.`);
  // squatting guard: check the last directory scan
  sq.hidden = false;
  if (!DIR) {
    sq.className = "squat";
    sq.innerHTML = `<strong>Squatting guard:</strong> no directory scan yet — ownership unknown. ` +
      `Scan the register first, or accept the risk: someone else's claim can confirm first.`;
  } else {
    const e = lookupHandle(DIR, v.handle);
    if (e && e.owner) {
      sq.className = "squat taken";
      sq.innerHTML = `<strong>⚠ Taken in this scan:</strong> <code class="mono">${esc(v.handle)}</code> is owned by ` +
        `<code class="mono">${esc(shortId(e.owner))}</code> (inscription #${e.inscriptionNumber}). A new claim would lose.`;
    } else if (e) {
      sq.className = "squat free";
      sq.innerHTML = `<strong>Released:</strong> <code class="mono">${esc(v.handle)}</code> was released — free for re-claim in this scan.`;
    } else {
      sq.className = "squat free";
      sq.innerHTML = `<strong>Looks free in this scan</strong> (${DIR_META.pages} page(s)). Not a guarantee — the scan is a sample, and a rival claim can land first.`;
    }
  }
  $("cw-to2").disabled = false;
});
$("cw-handle").addEventListener("keydown", (ev) => { if (ev.key === "Enter") $("cw-check").click(); });
$("cw-to2").addEventListener("click", () => cwStep("s2"));

function refreshOwnerStep() {
  const net = $("cw-network").value === "testnet" ? "testnet" : "mainnet";
  cw.network = net;
  const net0 = NETWORKS[net];
  if (!$("cw-blockbook").value.trim() && net0.blockbook) $("cw-blockbook").value = net0.blockbook;
  const v = validateOwnerAddress($("cw-owner").value, net);
  cw.owner = v.ok ? v.address : null;
  $("cw-owner-status").innerHTML = v.ok
    ? okBox(`Owner address valid — <code class="mono">${esc(shortId(v.address))}</code> (${v.hrp}1… Taproot).`)
    : ($("cw-owner").value.trim() ? verdict(false, "Invalid owner address", reasonsList(v.reasons)) : "");
  $("cw-to3").disabled = !v.ok;
  if (cw.wallet && cw.wallet.network.id !== net) { lockKey(); $("cw-keystatus").innerHTML = errBox("Network changed — key wiped. Re-enter your key."); }
}
$("cw-owner").addEventListener("input", refreshOwnerStep);
$("cw-network").addEventListener("change", refreshOwnerStep);
$("cw-to3").addEventListener("click", () => cwStep("s3"));

/* --- key handling --- */
function showKey(addr) {
  $("cw-keystatus").innerHTML = okBox(`Key loaded — address <code class="mono">${esc(addr)}</code>. ` +
    `It lives in page memory only; <strong>Lock &amp; wipe</strong> erases it.`);
  $("cw-lock").disabled = false;
  $("cw-plan").disabled = false;
}
function lockKey() {
  cw.wallet = null;
  $("cw-wif").value = "";
  $("cw-keystatus").innerHTML = `<span class="muted">No key loaded.</span>`;
  $("cw-lock").disabled = true;
  $("cw-plan").disabled = true;
  $("cw-commit-broadcast").disabled = true;
  $("cw-reveal-broadcast").disabled = true;
}
$("cw-newkey").addEventListener("click", () => {
  try {
    const m = newMnemonic();
    const w = walletFromMnemonic(m, NETWORKS[cw.network]);
    w.mnemonic = m;
    cw.wallet = w;
    showKey(w.address);
    $("cw-keystatus").innerHTML = okBox(`Fresh key generated — address <code class="mono">${esc(w.address)}</code>.<br>` +
      `<strong>Write down this seed phrase now</strong> (it is shown once):<br><code class="mono">${esc(m)}</code>`);
  } catch (e) { $("cw-keystatus").innerHTML = errBox(esc(e.message)); }
});
$("cw-unlock").addEventListener("click", () => {
  try {
    const w = walletFromWIF($("cw-wif").value.trim(), NETWORKS[cw.network]);
    $("cw-wif").value = "";
    cw.wallet = w;
    showKey(w.address);
  } catch (e) { $("cw-keystatus").innerHTML = errBox(`Key rejected: ${esc(e.message)}`); }
});
$("cw-lock").addEventListener("click", lockKey);

/* --- fees & planning --- */
$("cw-fee-fetch").addEventListener("click", async () => {
  const bb = bbBase(NETWORKS[cw.network].blockbook);
  if (!bb) { $("cw-utxos").innerHTML = errBox("No Blockbook base URL — set one in step 2."); return; }
  try {
    const r = await fetchFeeRateGrainsPerVByte(bb, 2);
    $("cw-fee").value = String(r);
    $("cw-utxos").innerHTML = okBox(`Suggested fee rate: <strong>${r}</strong> grains/vB.`);
  } catch (e) { $("cw-utxos").innerHTML = errBox(`Fee suggestion failed: ${esc(e.message || e)}`); }
});

$("cw-plan").addEventListener("click", async () => {
  const out = $("cw-plan-out");
  out.innerHTML = "";
  try {
    if (!cw.wallet) throw new Error("load a signing key first");
    if (!cw.handle || !cw.owner) throw new Error("complete steps 1 and 2 first");
    const net = NETWORKS[cw.network];
    const bb = bbBase(net.blockbook);
    if (!bb) throw new Error("no Blockbook base URL — set one in step 2");
    const feeRate = Math.max(1, Math.ceil(Number($("cw-fee").value)));
    if (!Number.isFinite(feeRate)) throw new Error("bad fee rate");

    const utxos = await fetchUtxos(bb, cw.wallet.address);
    const spendable = (utxos || []).filter((u) => Number(u.value) >= DUST_GRAIN && u.confirmations !== 0);
    if (spendable.length === 0) throw new Error(`no spendable confirmed UTXOs at ${cw.wallet.address} — fund it first`);
    const funding = spendable.map((u) => ({
      txid: u.txid, vout: u.vout, value: Number(u.value),
      priv: cw.wallet.priv, internalXOnly: cw.wallet.internalXOnly,
    }));
    $("cw-utxos").innerHTML = okBox(`Funding: ${funding.length} UTXO(s), total <strong>${formatPRL(funding.reduce((n, u) => n + u.value, 0))}</strong>.`);

    cw.nameJson = buildClaimJson({ handle: cw.handle, owner: cw.owner, ts: nowTs() });
    const plan = planNameClaim({
      network: net, internalXOnly: cw.wallet.internalXOnly,
      nameJson: cw.nameJson, feeRate, changeAddress: cw.wallet.address,
    });
    assertSpendableCommitValue(plan.commitValue); // dust refusal

    const commit = buildCommitTx({
      network: net, fundingInputs: funding, commitProgram: plan.commitProgram,
      commitValue: plan.commitValue, changeProgram: plan.changeProgram, feeRate,
    });
    cw.plan = plan; cw.commit = commit;
    const totalFee = commit.fee + plan.revealFee;
    out.innerHTML = `<div class="verdict warn"><h3>⚠ Plan — exact fee math (grain-exact)</h3>
      <dl class="kv">
        <dt>Claim JSON</dt><dd>${esc(cw.nameJson)}</dd>
        <dt>Commit address</dt><dd>${esc(plan.commitAddress)}</dd>
        <dt>Reveal script marker</dt><dd>${esc(plan.marker)} ✓</dd>
        <dt>Carrier (owner output)</dt><dd>${formatPRL(plan.ownerOutputs[0].value)} (1000 grains)</dd>
        <dt>Reveal fee</dt><dd>${formatPRL(plan.revealFee)} @ ${plan.feeRate} gr/vB</dd>
        <dt>Commit value</dt><dd>${formatPRL(plan.commitValue)}</dd>
        <dt>Commit fee</dt><dd>${formatPRL(commit.fee)} · change ${formatPRL(commit.change)}</dd>
        <dt>Total fees</dt><dd><strong>${formatPRL(totalFee)}</strong></dd>
      </dl>
      <p class="honest">Double-check the handle spelling — a confirmed claim cannot be renamed, and a rival claim confirmed first wins.</p></div>`;
    $("cw-commit-broadcast").disabled = false;
    $("cw-commit-broadcast").dataset.armed = "";
    $("cw-commit-broadcast").textContent = "1 · Broadcast commit";
  } catch (e) {
    out.innerHTML = errBox(`<strong>Plan refused:</strong> ${esc(e.message || e)}`);
  }
});

/* --- broadcast with double confirmation --- */

$("cw-commit-broadcast").addEventListener("click", () => {
  const btn = $("cw-commit-broadcast");
  const label = "1 · Broadcast commit";
  if (!btn.dataset.armed) {
    btn.dataset.armed = "1";
    btn.textContent = label + " — click again to confirm";
    return;
  }
  delete btn.dataset.armed; btn.textContent = label; btn.disabled = true;
  (async () => {
    const out = $("cw-result");
    try {
      const bb = bbBase(NETWORKS[cw.network].blockbook);
      const txid = await broadcastTx(bb, cw.commit.hex);
      cw.commit.txid = txid;
      out.innerHTML = okBox(`Commit broadcast: <code class="mono">${esc(txid)}</code> — wait for 1 confirmation, then broadcast the reveal.`);
      $("cw-reveal-broadcast").disabled = false;
      $("cw-reveal-broadcast").textContent = "2 · Broadcast reveal";
    } catch (e) {
      out.innerHTML = errBox(`Commit broadcast failed: ${esc(e.message || e)}`);
      btn.disabled = false;
    }
  })();
});

$("cw-reveal-broadcast").addEventListener("click", () => {
  const btn = $("cw-reveal-broadcast");
  const label = "2 · Broadcast reveal";
  if (!btn.dataset.armed) {
    btn.dataset.armed = "1";
    btn.textContent = label + " — click again to confirm";
    return;
  }
  delete btn.dataset.armed; btn.textContent = label; btn.disabled = true;
  (async () => {
    const out = $("cw-result");
    try {
      const net = NETWORKS[cw.network];
      const reveal = buildRevealTxSigned({
        plan: cw.plan, commitTxid: cw.commit.txid, commitVout: 0,
        internalPriv: cw.wallet.priv, changeAddress: cw.wallet.address,
      });
      cw.reveal = reveal;
      const bb = bbBase(net.blockbook);
      const txid = await broadcastTx(bb, reveal.hex);
      const inscriptionId = `${txid}i0`;
      out.innerHTML = verdict(true, "Handle claimed on-chain",
        `<p>Reveal broadcast: <code class="mono">${esc(txid)}</code></p>
         <p>Inscription id: <code class="mono">${esc(inscriptionId)}</code> — verify it in the Verifier tab once indexed.</p>
         <p class="honest">Remember: ownership is first-seen per the indexer. If a rival claim confirms first, yours loses.</p>`);
      lockKey();
    } catch (e) {
      out.innerHTML = errBox(`Reveal failed: ${esc(e.message || e)}`);
      btn.disabled = false;
    }
  })();
});

/* --- standalone reveal-pair verifier --- */
$("pv-run").addEventListener("click", () => {
  const out = $("pv-out");
  const reasons = [];
  try {
    const commitHex = $("pv-commit-hex").value.trim();
    const revealHex = $("pv-reveal-hex").value.trim();
    if (!/^[0-9a-fA-F]+$/.test(commitHex) || commitHex.length < 20) reasons.push("commit hex is not plausible hex");
    if (!/^[0-9a-fA-F]+$/.test(revealHex) || revealHex.length < 20) reasons.push("reveal hex is not plausible hex");
    if (reasons.length) throw new Error("refused");
    const stack = witnessOfInput(revealHex, 0);
    let leaf = null, envs = null;
    for (const item of stack) {
      const e = extractEnvelopes(item);
      if (e.length > 0) { leaf = item; envs = e; break; }
    }
    if (!envs) reasons.push("no inscription envelopes found in the reveal witness");
    else {
      if (envs.length !== 1) reasons.push(`expected exactly 1 envelope, found ${envs.length}`);
      const env = envs[0];
      if (env.marker !== "prl-name") reasons.push(`protocol marker mismatch: expected "prl-name", found ${JSON.stringify(env.marker)}`);
      if (env.contentType.split(";")[0].trim().toLowerCase() !== "application/json") {
        reasons.push(`content-type mismatch: expected application/json, found ${JSON.stringify(env.contentType)}`);
      }
      let v = null;
      try { v = validateNameJson(JSON.parse(env.bodyText)); }
      catch (e) { reasons.push(`envelope body is not valid JSON: ${e.message}`); }
      if (v && !v.ok) reasons.push(...v.reasons);
      if (reasons.length === 0) {
        out.innerHTML = verdict(true, "Pair verifies",
          `<p>Marker <code class="mono">prl-name</code> ✓ · op <code class="mono">${esc(v.record.op)}</code> · ` +
          `handle <code class="mono">${esc(v.record.handle)}</code> ✓ · schema valid ✓</p>` +
          `<pre>${esc(JSON.stringify(v.record, null, 2))}</pre>`);
        return;
      }
    }
    throw new Error("refused");
  } catch (e) {
    if (reasons.length === 0) reasons.push(e.message || String(e));
    out.innerHTML = verdict(false, "Pair REFUSED", reasonsList(reasons));
  }
});

/* ================= VERIFIER ================= */
$("v-run").addEventListener("click", async () => {
  const out = $("v-out");
  const id = $("v-id").value.trim();
  if (!id) { out.innerHTML = errBox("Paste an inscription id first."); return; }
  out.innerHTML = `<p class="muted">Verifying…</p>`;
  const fail = (title, reasons) => { out.innerHTML = verdict(false, title, reasonsList(reasons)); };
  try {
    const meta = await apiGet(`/inscriptions/${encodeURIComponent(id)}`);
    if (!meta.ok) return fail("Inscription not found", [meta.message]);
    const m = meta.data.inscription || meta.data || {};
    const number = Number(m.inscriptionNumber ?? m.number);
    if (!Number.isFinite(number)) return fail("Inscription refused", ["indexer did not return a numeric inscriptionNumber"]);

    const c = await apiGet(`/inscriptions/${encodeURIComponent(id)}/content`);
    if (!c.ok) return fail("Content fetch failed", [c.message]);
    const p = parseNameRecord(c.data.bodyText ?? "", number, id);
    if (!p.ok) return fail("Content refused — not a valid prl-name record", p.reasons);
    const rec = p.record;

    // live re-scan of this handle, stopping once pages pass the target number
    const s = await scanDirectory({ forHandle: { stopAfterNumber: number } });
    if (!s) return fail("Re-scan failed", ["could not re-scan the directory for this handle"]);
    const dir = buildDirectory(s.records);
    const entry = lookupHandle(dir, rec.handle);
    if (!entry) return fail("Handle has no registration", [
      `inscription ${id} carries a well-formed prl-name ${rec.op}, but no first-seen claim for "${rec.handle}" exists in the re-scan (${s.pages} page(s)). It may be unindexed or beyond the scan cap.`,
    ]);

    // confirm the target inscription participates correctly in the chain
    const inHistory = entry.history.some((h) => h.inscriptionId === id);
    if (!inHistory) {
      return fail("LOSES — not part of the winning chain", [
        `the first-seen claim for "${rec.handle}" is inscription #${entry.inscriptionNumber} (${shortId(entry.inscriptionId)}), not this one (#${number}).`,
        `per first-seen consensus this record loses; the owner is ${entry.owner ?? "(released)"}.`,
      ]);
    }
    if (entry.inscriptionId === id && rec.op === "claim") {
      if (entry.owner === null) {
        return void (out.innerHTML = verdict(true, `VERIFIED — "${esc(rec.handle)}" was first claimed here, now released`,
          `<p>This inscription (#${entry.inscriptionNumber}) is the first-seen claim for <code class="mono">${esc(rec.handle)}</code>. ` +
          `It was later released — the handle is currently <strong>free for re-claim</strong>.</p>`));
      }
      return void (out.innerHTML = verdict(true, `VERIFIED — "${esc(rec.handle)}" is owned by this inscription`,
        `<dl class="kv"><dt>Owner</dt><dd>${esc(entry.owner)}</dd><dt>First seen</dt><dd>#${entry.inscriptionNumber}</dd><dt>Chain events</dt><dd>${entry.history.length}</dd></dl>`));
    }
    // transfer/release: confirm it is a valid link in the winning chain
    const idx = entry.history.findIndex((h) => h.inscriptionId === id);
    const ev = entry.history[idx];
    const prevOwner = idx === 0 ? "(genesis)" : (entry.history[idx - 1].to || entry.history[idx - 1].owner);
    if (rec.op === "transfer" && ev.from === prevOwner) {
      return void (out.innerHTML = verdict(true, "VERIFIED — valid transfer in the winning chain",
        `<p><code class="mono">${esc(rec.handle)}</code>: ${esc(rec.from)} → ${esc(rec.to)} at inscription #${number}.</p>`));
    }
    if (rec.op === "release" && ev.from === prevOwner) {
      return void (out.innerHTML = verdict(true, "VERIFIED — valid release in the winning chain",
        `<p><code class="mono">${esc(rec.handle)}</code> was released by ${esc(rec.from)} at inscription #${number}; it is now free for re-claim.</p>`));
    }
    return fail("Chain mismatch — refused", [
      `the record is in history but the "${rec.op}" does not match the winning chain at that position (expected from ${prevOwner}). Possible indexer inconsistency or tampering.`,
    ]);
  } catch (e) {
    fail("Verification error", [e.message || String(e)]);
  }
});
$("v-id").addEventListener("keydown", (ev) => { if (ev.key === "Enter") $("v-run").click(); });

/* ---------- footer ---------- */
$("copy-donate").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(DONATE_ADDRESS); $("copy-donate").textContent = "Copied ✓"; }
  catch { $("copy-donate").textContent = "Copy failed"; }
  setTimeout(() => { $("copy-donate").textContent = "Copy"; }, 1500);
});

/* ---------- boot ---------- */
refreshOwnerStep();
