/* Pearlscriptions / PRL-20 Explorer — talks to a configurable read-only indexer API.
 * API contract: Pearlscriptions/indexer docs/api-contract.md (GET-only).
 * Every field read defensively: render only what the API actually returns. */
"use strict";

const LS_KEY = "prl20.api";
const $ = (id) => document.getElementById(id);

const store = {
  get api() { return (localStorage.getItem(LS_KEY) || "").replace(/\/+$/, ""); },
  set api(v) { localStorage.setItem(LS_KEY, (v || "").trim().replace(/\/+$/, "")); }
};

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function short(v, n = 16) {
  const s = String(v ?? "");
  if (s.length <= n * 2 + 3) return s;
  return s.slice(0, n) + "…" + s.slice(-n);
}

function fmtNum(v) {
  if (v === null || v === undefined || v === "") return "—";
  try {
    const s = String(v);
    if (/^\d+$/.test(s)) return BigInt(s).toLocaleString("en-US");
    const n = Number(s);
    return Number.isFinite(n) ? n.toLocaleString("en-US") : esc(s);
  } catch { return esc(String(v)); }
}

async function api(path, query = {}) {
  const base = store.api;
  if (!base) return { ok: false, error: "NO_API" };
  const url = new URL(base + path);
  for (const [k, v] of Object.entries(query)) if (v !== "" && v != null) url.searchParams.set(k, v);
  try {
    const res = await fetch(url.toString(), { headers: { Accept: "application/json" } });
    if (!res.ok) return { ok: false, error: `HTTP_${res.status}` };
    const data = await res.json().catch(() => null);
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

function setConn(state, text) {
  const el = $("conn");
  el.className = "conn" + (state === "on" ? " on" : state === "err" ? " err" : "");
  el.textContent = text;
}

function safeScroll(el) {
  if (el && typeof el.scrollIntoView === "function") {
    try { el.scrollIntoView({ behavior: (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"), block: "nearest" }); } catch {}
  }
}

function emptyBox(msg) {
  return `<div class="empty">${msg}</div>`;
}

function stat(k, v, cls = "") {
  return `<div class="stat"><div class="k">${esc(k)}</div><div class="v ${cls}">${v}</div></div>`;
}

/* ---------- connection / status ---------- */

async function connect() {
  const url = store.api;
  if (!url) {
    setConn("off", "indexer: unconfigured");
    $("status").classList.add("hidden");
    $("api-hint").classList.remove("ok");
    $("api-hint").innerHTML =
      "<strong>Not connected.</strong> Set the indexer API base URL above. " +
      "Data is fetched live from that API; nothing is bundled or faked.";
    renderTabsEmpty();
    return;
  }
  setConn("off", "indexer: connecting…");
  const health = await api("/health");
  if (!health.ok) {
    setConn("err", "indexer: unreachable");
    $("api-hint").classList.remove("ok");
    $("api-hint").innerHTML =
      `<strong>Unreachable.</strong> Could not reach <code class="mono">${esc(url)}</code> ` +
      `(<code>${esc(health.error)}</code>). Check the URL and CORS on the API side.`;
    renderTabsEmpty();
    return;
  }
  const h = health.data || {};
  setConn("on", `indexer: live · ${esc(h.chain || h.service || "ok")}`);
  $("api-hint").classList.add("ok");
  $("api-hint").innerHTML =
    `<strong>Connected.</strong> Reading live data from <code class="mono">${esc(url)}</code>. ` +
    `Service: <code>${esc(h.service || "—")}</code>` +
    (h.forkEra ? ` · fork era <code>${esc(h.forkEra)}</code>` : "");
  await loadStatus();
  loadTokens();
  loadInscriptions();
  loadOperations();
}

async function loadStatus() {
  const st = await api("/indexer/status");
  const net = await api("/network");
  const box = $("status-stats");
  if (!st.ok) {
    box.innerHTML = stat("status", "error: " + esc(st.error), "bad");
    $("status").classList.remove("hidden");
    return;
  }
  const s = st.data || {};
  const parts = [
    stat("chain", esc(s.chain ?? "—")),
    stat("indexed height", fmtNum(s.indexedHeight)),
    stat("best height", fmtNum(s.bestHeight)),
    stat("sync state", s.synced === true ? "synced" : s.synced === false ? "syncing" : "—",
      s.synced === true ? "ok" : s.synced === false ? "bad" : ""),
    stat("blocks stored", fmtNum(s.blocksStored)),
    stat("reorgs", fmtNum(s.reorgCount))
  ];
  if (s.checkpoint && s.checkpoint.status)
    parts.push(stat("checkpoint", esc(s.checkpoint.status),
      s.checkpoint.status === "match" ? "ok" : s.checkpoint.status === "mismatch" ? "bad" : ""));
  if (net.ok && net.data && typeof net.data === "object") {
    for (const [k, v] of Object.entries(net.data)) {
      if (["chain", "indexedHeight", "bestHeight"].includes(k)) continue;
      if (v !== null && typeof v !== "object")
        parts.push(stat(k, esc(String(v))));
    }
  }
  box.innerHTML = parts.join("");
  $("status").classList.remove("hidden");
}

function renderTabsEmpty() {
  $("tokens").innerHTML = emptyBox("Configure the indexer API above to list PRL-20 tokens.");
  $("inscriptions").innerHTML = emptyBox("Configure the indexer API above to browse inscriptions.");
  $("operations").innerHTML = emptyBox("Configure the indexer API above to browse operations.");
  $("addr-result").innerHTML = "";
  $("status-stats").innerHTML = "";
  $("status").classList.add("hidden");
}

/* ---------- tokens ---------- */

function tokenCard(t) {
  const tick = esc(t.ticker ?? "?");
  const prog = typeof t.mintProgress === "number" ? t.mintProgress : null;
  const bar = prog === null ? "" :
    `<div class="progress"><i style="width:${Math.min(100, Math.max(0, prog))}%"></i></div>
     <div class="prog-label">Minted ${prog.toFixed(2)}%</div>`;
  return `<div class="tcard" data-ticker="${tick}" tabindex="0" role="button" aria-label="Token ${tick}">
    <div class="tick">${tick}</div>
    ${bar}
    <div class="kv"><span>Max supply</span><b>${fmtNum(t.maxSupply)}</b></div>
    <div class="kv"><span>Minted</span><b>${fmtNum(t.mintedSupply)}</b></div>
    <div class="kv"><span>Holders</span><b>${fmtNum(t.holderCount)}</b></div>
    <div class="kv"><span>Mint limit</span><b>${fmtNum(t.mintLimit ?? t.lim)}</b></div>
  </div>`;
}

async function loadTokens() {
  const box = $("tokens");
  $("token-detail").innerHTML = "";
  if (!store.api) { box.innerHTML = emptyBox("Configure the indexer API above to list PRL-20 tokens."); return; }
  box.innerHTML = emptyBox("Loading tokens…");
  const r = await api("/tokens");
  if (!r.ok) { box.innerHTML = `<div class="err">Failed to load: ${esc(r.error)}</div>`; return; }
  const tokens = (r.data && r.data.tokens) || [];
  if (!tokens.length) { box.innerHTML = emptyBox("The indexer reports no deployed PRL-20 tokens."); return; }
  box.innerHTML = tokens.map(tokenCard).join("");
  box.querySelectorAll(".tcard").forEach((el) => {
    el.addEventListener("click", () => loadTokenDetail(el.dataset.ticker));
    el.addEventListener("keydown", (e) => { if (e.key === "Enter") loadTokenDetail(el.dataset.ticker); });
  });
}

async function loadTokenDetail(ticker) {
  const box = $("token-detail");
  const t = (ticker || "").toLowerCase().trim();
  if (!t) return;
  box.innerHTML = emptyBox("Loading token…");
  if (!store.api) { box.innerHTML = emptyBox("Configure the indexer API above to list PRL-20 tokens."); return; }
  const r = await api("/tokens/" + encodeURIComponent(t));
  if (!r.ok) {
    box.innerHTML = r.error === "HTTP_404"
      ? `<div class="err">Token <code class="mono">${esc(t)}</code> not found on this indexer.</div>`
      : `<div class="err">Failed to load token: ${esc(r.error)}</div>`;
    return;
  }
  const d = r.data || {};
  const rows = [
    ["Ticker", `<code class="mono">${esc(d.ticker)}</code>`],
    ["Max supply", fmtNum(d.maxSupply)],
    ["Minted", fmtNum(d.mintedSupply)],
    ["Remaining", fmtNum(d.remainingSupply)],
    ["Mint limit / tx", fmtNum(d.mintLimit ?? d.lim)],
    ["Decimals", esc(d.decimals ?? d.dec ?? "—")],
    ["Holders", fmtNum(d.holderCount)],
    ["Mint progress", typeof d.mintProgress === "number" ? d.mintProgress.toFixed(2) + "%" : "—"],
    ["Deploy inscription", d.deployInscriptionId ? `<code class="mono">${esc(short(d.deployInscriptionId))}</code>` : "—"],
    ["Deploy block", fmtNum(d.deployBlockHeight ?? d.deployBlock)],
    ["Deploy tx", d.deployTxid ? `<code class="mono">${esc(short(d.deployTxid))}</code>` : "—"]
  ];
  box.innerHTML = `<div class="detail"><h3>Token detail</h3>
    <dl class="dl">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}</dl></div>`;
  safeScroll(box);
}

/* ---------- inscriptions ---------- */

function inscCard(i) {
  const num = i.inscriptionNumber ?? i.number;
  const id = i.inscriptionId ?? i.id;
  const ctype = esc(i.contentType || i.content_type || "—");
  const owner = i.ownerAddress || i.currentAddress;
  return `<div class="tcard" data-insc="${esc(id ?? "")}" tabindex="0" role="button" aria-label="Inscription ${esc(id ?? "")}">
    <div class="tick">${num === null || num === undefined ? "—" : "#" + esc(String(num))}</div>
    <div class="kv"><span>Type</span><b>${ctype}</b></div>
    <div class="kv"><span>Id</span><b class="mono">${esc(short(id, 10))}</b></div>
    <div class="kv"><span>Owner</span><b class="mono">${owner ? esc(short(owner, 8)) : "—"}</b></div>
    ${i.blockHeight ? `<div class="kv"><span>Block</span><b>${fmtNum(i.blockHeight)}</b></div>` : ""}
  </div>`;
}

async function loadInscriptions() {
  const box = $("inscriptions");
  $("insc-detail").innerHTML = "";
  if (!store.api) { box.innerHTML = emptyBox("Configure the indexer API above to browse inscriptions."); return; }
  box.innerHTML = emptyBox("Loading inscriptions…");
  const r = await api("/inscriptions", { order: "desc", limit: 24 });
  if (!r.ok) { box.innerHTML = `<div class="err">Failed to load: ${esc(r.error)}</div>`; return; }
  const d = r.data || {};
  const items = d.inscriptions || d.items || [];
  if (!items.length) { box.innerHTML = emptyBox("No inscriptions returned by this indexer."); return; }
  box.innerHTML = items.map(inscCard).join("");
  box.querySelectorAll(".tcard").forEach((el) => {
    el.addEventListener("click", () => loadInscDetail(el.dataset.insc));
    el.addEventListener("keydown", (e) => { if (e.key === "Enter") loadInscDetail(el.dataset.insc); });
  });
}

async function loadInscDetail(id) {
  const box = $("insc-detail");
  if (!id) return;
  box.innerHTML = emptyBox("Loading inscription…");
  if (!store.api) { box.innerHTML = emptyBox("Configure the indexer API above to browse inscriptions."); return; }
  const [meta, loc] = await Promise.all([
    api("/inscriptions/" + encodeURIComponent(id)),
    api("/inscriptions/" + encodeURIComponent(id) + "/location")
  ]);
  if (!meta.ok) {
    box.innerHTML = `<div class="err">Failed to load inscription: ${esc(meta.error)}</div>`;
    return;
  }
  const d = meta.data || {};
  const l = loc.ok && loc.data ? (loc.data.current || loc.data) : null;
  const rows = [
    ["Inscription #", esc(d.inscriptionNumber ?? d.number ?? "—")],
    ["Id", `<code class="mono">${esc(d.inscriptionId ?? d.id ?? id)}</code>`],
    ["Content type", esc(d.contentType || d.content_type || "—")],
    ["Content size", fmtNum(d.contentLength ?? d.content_length) + (d.contentLength ? " bytes" : "")],
    ["Block", fmtNum(d.blockHeight)],
    ["Tx", d.txid ? `<code class="mono">${esc(short(d.txid))}</code>` : "—"],
    ["Owner", l && l.address ? `<code class="mono">${esc(short(l.address, 10))}</code>` : "—"],
    ["Location", l ? `<code class="mono">${esc(l.outpoint || (l.txid + ":" + (l.vout ?? "?")))}</code>` : "—"]
  ];
  box.innerHTML = `<div class="detail"><h3>Inscription detail</h3>
    <dl class="dl">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}</dl></div>`;
  safeScroll(box);
}

/* ---------- operations ---------- */

async function loadOperations() {
  const box = $("operations");
  const filter = $("op-filter").value;
  if (!store.api) { box.innerHTML = emptyBox("Configure the indexer API above to browse operations."); return; }
  box.innerHTML = emptyBox("Loading operations…");
  const r = await api("/operations", { limit: 25 });
  if (!r.ok) { box.innerHTML = `<div class="err">Failed to load: ${esc(r.error)}</div>`; return; }
  const d = r.data || {};
  let items = d.operations || d.items || [];
  if (filter) items = items.filter((o) => (o.op || "").toLowerCase() === filter);
  if (!items.length) { box.innerHTML = emptyBox("No operations returned by this indexer."); return; }
  box.innerHTML = items.map((o) => {
    const op = esc(o.op || "?");
    const tick = esc(o.ticker || "—");
    const valid = o.valid === true
      ? '<span class="badge ok">valid</span>'
      : o.valid === false
        ? `<span class="badge bad" title="${esc(o.invalidReason || "")}">invalid</span>`
        : '<span class="badge info">unknown</span>';
    return `<div class="op">
      <div><span class="badge info">${op}</span> <span class="tick">${tick}</span></div>
      <div class="meta">
        amount <code>${fmtNum(o.amount)}</code> ·
        block <code>${fmtNum(o.blockHeight)}</code> ·
        tx <code class="mono">${esc(short(o.txid, 10))}</code>
        ${o.inscriptionNumber !== null && o.inscriptionNumber !== undefined ? ` · insc <code>#${esc(String(o.inscriptionNumber))}</code>` : ""}
        ${o.ownerAddress ? ` · <code class="mono">${esc(short(o.ownerAddress, 8))}</code>` : ""}
      </div>
      <div>${valid}</div>
    </div>`;
  }).join("");
}

/* ---------- address ---------- */

async function loadAddress(addr) {
  const box = $("addr-result");
  box.innerHTML = emptyBox("Loading address data…");
  if (!store.api) { box.innerHTML = emptyBox("Configure the indexer API above to look up an address."); return; }
  const enc = encodeURIComponent(addr);
  const [bal, lots, utxos, insc] = await Promise.all([
    api("/addresses/" + enc + "/balances"),
    api("/addresses/" + enc + "/transfer-lots"),
    api("/addresses/" + enc + "/utxos"),
    api("/addresses/" + enc + "/inscriptions")
  ]);
  if (!bal.ok && !lots.ok && !utxos.ok && !insc.ok) {
    box.innerHTML = `<div class="err">Failed to load address: ${esc(bal.error || "unknown")}</div>`;
    return;
  }
  let html = `<div class="detail"><h3 class="mono" style="font-size:0.9rem;word-break:break-all">${esc(addr)}</h3>`;

  // balances
  if (bal.ok && bal.data) {
    const b = bal.data;
    const prl = b.prl ?? b.prls ?? b.balance;
    const tokens = b.tokens || b.balances || {};
    html += "<h3>Balances</h3><dl class=\"dl\">";
    if (prl !== null && prl !== undefined) html += `<dt>PRL</dt><dd>${fmtNum(prl)}</dd>`;
    for (const [ticker, amt] of Object.entries(tokens))
      html += `<dt><code class="mono">${esc(ticker)}</code></dt><dd>${fmtNum(amt)}</dd>`;
    html += "</dl>";
  }

  // transfer lots
  if (lots.ok && lots.data) {
    const d = lots.data;
    const list = d.lots || d.transferLots || d.items || [];
    html += `<h3>Transfer lots (${list.length})</h3>`;
    html += list.length ? list.slice(0, 25).map((l) =>
      `<div class="op"><div><span class="tick">${esc(l.ticker || "?")}</span></div>` +
      `<div class="meta">lot <code class="mono">${esc(short(l.transferLotId || l.id || "—", 10))}</code> · ` +
      `amount <code>${fmtNum(l.amount)}</code> · ` +
      `<code class="mono">${esc(short(l.outpoint || "—", 10))}</code></div>` +
      `<div>${l.confirmed === false ? '<span class="badge warn">pending</span>' : '<span class="badge ok">confirmed</span>'}</div></div>`
    ).join("") : "<p class=\"note\">No transfer lots.</p>";
  }

  // utxos
  if (utxos.ok && utxos.data) {
    const d = utxos.data;
    const list = d.utxos || d.items || [];
    html += `<h3>UTXOs (${list.length})</h3>`;
    html += list.length ? list.slice(0, 25).map((u) => {
      const prot = u.protected === true
        ? `<span class="badge warn">protected${u.protectionReason ? ": " + esc(u.protectionReason) : ""}</span>` : "";
      return `<div class="utxo"><span class="protect">${prot}</span>
        <code class="mono">${esc(short(u.txid || "—", 12))}:${esc(String(u.vout ?? "?"))}</code>
        · <code>${fmtNum(u.value ?? u.amount)}</code> grains</div>`;
    }).join("") : "<p class=\"note\">No UTXOs.</p>";
  }

  // inscriptions
  if (insc.ok && insc.data) {
    const d = insc.data;
    const list = d.inscriptions || d.items || [];
    html += `<h3>Inscriptions owned (${list.length})</h3>`;
    html += list.length
      ? `<div class="grid">` + list.slice(0, 24).map(inscCard).join("") + "</div>"
      : "<p class=\"note\">None.</p>";
  }

  html += "</div>";
  box.innerHTML = html;
  safeScroll(box);
}

/* ---------- wiring ---------- */

document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    document.querySelectorAll(".tabpanel").forEach((p) => p.classList.add("hidden"));
    $("panel-" + btn.dataset.tab).classList.remove("hidden");
  });
});

$("api-form").addEventListener("submit", (e) => {
  e.preventDefault();
  store.api = $("api-url").value;
  connect();
});
$("api-clear").addEventListener("click", () => {
  store.api = "";
  $("api-url").value = "";
  connect();
});
$("token-lookup").addEventListener("click", () => loadTokenDetail($("token-search").value));
$("token-search").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); loadTokenDetail($("token-search").value); } });
$("tokens-refresh").addEventListener("click", loadTokens);
$("insc-refresh").addEventListener("click", loadInscriptions);
$("insc-lookup").addEventListener("click", () => {
  const q = $("insc-search").value.trim();
  if (q) loadInscDetail(q);
});
$("ops-refresh").addEventListener("click", loadOperations);
$("op-filter").addEventListener("change", loadOperations);
$("addr-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const a = $("addr-input").value.trim();
  if (a) loadAddress(a);
});

$("donate-copy").addEventListener("click", async () => {
  const addr = $("donate-addr").textContent.trim();
  try {
    await navigator.clipboard.writeText(addr);
    $("donate-msg").textContent = "Copied to clipboard. Thank you!";
  } catch {
    $("donate-msg").textContent = "Copy failed — please select the address manually.";
  }
});

/* init */
$("api-url").value = store.api;
connect();
