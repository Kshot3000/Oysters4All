/* Pearl Gallery — the Pearlscriptions inscription wall.
 * Reads the public Pearlscriptions indexer API (GET-only, read-only):
 *   GET /health, /indexer/status, /inscriptions, /inscriptions/:id,
 *   /inscriptions/:id/content, /inscriptions/:id/location,
 *   /addresses/:address/inscriptions
 * Nothing is bundled or faked; everything unconfigured/unreachable renders
 * an honest state. Content safety: only raster image/audio/video buckets are
 * rendered inline (see js/gallery-core.js); HTML/SVG never touch the DOM.
 */
"use strict";

const LS_KEY = "gallery.api";
const $ = (id) => document.getElementById(id);
const {
  DONATE_ADDRESS, X_HANDLE, classifyContent, buildDataUrl, decodeBase64Strict,
  fmtBytes, short, normalizeCard, inscriptionsQuery, parseLookup, findByNumber,
} = window.__galleryCore || {};

/* localStorage may be unavailable or throw (private mode, blocked site data,
 * sandboxed iframes). Never let that kill the app: fall back to memory. */
const memStore = {};
const store = {
  get api() {
    try { return (localStorage.getItem(LS_KEY) || "").replace(/\/+$/, ""); }
    catch { return (memStore[LS_KEY] || "").replace(/\/+$/, ""); }
  },
  set api(v) {
    const clean = (v || "").trim().replace(/\/+$/, "");
    try { localStorage.setItem(LS_KEY, clean); } catch {}
    memStore[LS_KEY] = clean;
  },
};

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

async function api(path, query = "") {
  const base = store.api;
  if (!base) return { ok: false, error: "NO_API" };
  const url = base + path + query;
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return { ok: false, error: "HTTP_" + res.status };
    const data = await res.json().catch(() => null);
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* ---------- lazy content loading (concurrency-capped) ---------- */
const preloadQueue = [];
const activeLoads = new Set();
const MAX_CONCURRENT = 4;
const loaded = new Map(); // inscriptionId -> content payload or error marker

function queuePreload(card) {
  if (!card || loaded.has(card.dataset.inscId) || preloadQueue.includes(card)) return;
  preloadQueue.push(card);
  pumpPreloads();
}

async function pumpPreloads() {
  while (activeLoads.size < MAX_CONCURRENT && preloadQueue.length) {
    const card = preloadQueue.shift();
    if (loaded.has(card.dataset.inscId)) continue;
    activeLoads.add(card);
    fillCard(card).finally(() => { activeLoads.delete(card); pumpPreloads(); });
  }
}

async function fillCard(card) {
  const id = card.dataset.inscId;
  const thumb = card.querySelector(".thumb");
  const r = await api("/inscriptions/" + encodeURIComponent(id) + "/content");
  if (!r.ok) {
    loaded.set(id, { error: r.error });
    thumb.classList.add("failed");
    thumb.innerHTML = '<span class="thumb-err">unavailable</span>';
    return;
  }
  const c = r.data || {};
  const cls = classifyContent(c.contentType, c.byteLength);
  loaded.set(id, { content: c, cls });
  if (cls.bucket === "image") {
    const url = buildDataUrl(c);
    if (url) {
      thumb.innerHTML = `<img loading="lazy" alt="inscription content" src="${esc(url)}">`;
      card.classList.add("has-img");
      return;
    }
  }
  thumb.innerHTML = bucketIcon(cls.bucket, c.contentType);
}

function bucketIcon(bucket, contentType) {
  const label = esc((contentType || "").split(";")[0] || bucket);
  const glyphs = { audio: "♪", video: "▸", text: "✎", binary: "▦", "too-large": "▦", "not-rendered": "⊘", unknown: "?" };
  return `<span class="thumb-glyph">${glyphs[bucket] || "?"}</span><span class="thumb-type">${label}</span>`;
}

/* ---------- wall grid ---------- */
let wallPage = 1;
let wallTotal = null;
let wallFilter = "all";
let wallMode = { kind: "latest" }; // or { kind: "address", address }
let observer = null;

function cardHTML(rec) {
  const c = normalizeCard(rec);
  const num = c.inscriptionNumber !== null ? "#" + c.inscriptionNumber : "—";
  const cls = c.cls;
  const bucket = cls.bucket;
  return `
  <article class="frame" data-insc-id="${esc(c.id)}" data-bucket="${esc(bucket)}" tabindex="0" role="button" aria-label="inscription ${esc(num)}">
    <div class="frame-num">${esc(num)}</div>
    <div class="thumb loading"><span class="thumb-glyph">◌</span></div>
    <div class="frame-meta">
      <span class="chip type">${esc(cls.type || "unknown")}</span>
      ${c.protocolMarker ? `<span class="chip marker">${esc(c.protocolMarker)}</span>` : ""}
      <span class="size">${esc(fmtBytes(c.byteLength))}</span>
    </div>
    <div class="frame-sub"><code class="mono">${esc(short(c.txid))}</code>${c.blockHeight !== null && c.blockHeight !== undefined ? ` · <span class="blk">⛏ ${esc(String(c.blockHeight))}</span>` : ""}</div>
  </article>`;
}

function applyFilter() {
  const cards = document.querySelectorAll("#wall .frame");
  cards.forEach((card) => {
    const b = card.dataset.bucket;
    const show =
      wallFilter === "all" ||
      (wallFilter === "images" && b === "image") ||
      (wallFilter === "text" && b === "text") ||
      (wallFilter === "media" && (b === "audio" || b === "video")) ||
      (wallFilter === "other" && !["image", "text", "audio", "video"].includes(b));
    card.style.display = show ? "" : "none";
  });
  const visible = [...cards].filter((c) => c.style.display !== "none").length;
  $("wall-count").textContent = `${visible} shown · page ${wallPage}${wallTotal !== null ? " of " + wallTotal + " total" : ""}`;
}

async function loadWall(reset = true) {
  const grid = $("wall");
  if (reset) { wallPage = 1; wallTotal = null; loaded.clear(); preloadQueue.length = 0; grid.innerHTML = ""; }
  $("wall-more").disabled = true;
  $("wall-note").textContent = "Loading…";
  let path, query;
  if (wallMode.kind === "address") {
    path = "/addresses/" + encodeURIComponent(wallMode.address) + "/inscriptions";
    query = inscriptionsQuery({ order: "desc", page: wallPage, limit: 24 });
  } else {
    path = "/inscriptions";
    query = inscriptionsQuery({ order: "desc", page: wallPage, limit: 24 });
  }
  const r = await api(path, query);
  if (!r.ok) {
    grid.innerHTML = `<div class="empty">Could not load inscriptions: <code>${esc(r.error)}</code>. Check the indexer URL and CORS.</div>`;
    $("wall-note").textContent = "";
    return;
  }
  const d = r.data || {};
  const items = d.inscriptions || d.items || [];
  wallTotal = d.total ?? null;
  if (reset && items.length === 0) {
    grid.innerHTML = `<div class="empty">No inscriptions indexed yet at this endpoint.</div>`;
    $("wall-note").textContent = "";
    return;
  }
  grid.insertAdjacentHTML("beforeend", items.map(cardHTML).join(""));
  wireCards(grid);
  applyFilter();
  const hasMore = wallTotal === null ? items.length === 24 : wallPage * 24 < wallTotal;
  $("wall-more").disabled = !hasMore;
  $("wall-more").style.display = hasMore ? "" : "none";
  $("wall-note").textContent = hasMore ? "" : "End of the wall.";
}

function wireCards(scope) {
  if (!("IntersectionObserver" in window)) {
    scope.querySelectorAll(".frame").forEach(queuePreload);
    return;
  }
  if (!observer) {
    observer = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) { queuePreload(e.target); observer.unobserve(e.target); } });
    }, { rootMargin: "400px" });
  }
  scope.querySelectorAll(".frame").forEach((card) => {
    if (!card.dataset.wired) {
      card.dataset.wired = "1";
      observer.observe(card);
      card.addEventListener("click", () => openDetail(card.dataset.inscId));
      card.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDetail(card.dataset.inscId); } });
    }
  });
}

/* ---------- detail modal ---------- */
function openDialog(id, num, metaHTML, contentHTML) {
  const dlg = $("detail");
  dlg.innerHTML = `
    <div class="dlg-head">
      <h2>Inscription ${esc(num !== null ? "#" + num : short(id))}</h2>
      <button class="dlg-close" id="dlg-close" aria-label="close">✕</button>
    </div>
    <div class="dlg-body">
      <div class="dlg-content">${contentHTML}</div>
      <div class="dlg-meta">${metaHTML}</div>
    </div>`;
  dlg.showModal();
  $("dlg-close").addEventListener("click", () => dlg.close());
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); }, { once: true });
}

async function openDetail(id) {
  openDialog(id, null, '<p class="muted">Loading…</p>', '<div class="empty">Loading content…</div>');
  const [meta, content, loc] = await Promise.all([
    api("/inscriptions/" + encodeURIComponent(id)),
    api("/inscriptions/" + encodeURIComponent(id) + "/content"),
    api("/inscriptions/" + encodeURIComponent(id) + "/location"),
  ]);
  if (!meta.ok) {
    openDialog(id, null, "", `<div class="empty">Could not load inscription: <code>${esc(meta.error)}</code></div>`);
    return;
  }
  const c = normalizeCard(meta.data || {});
  const lc = (content.ok && content.data) || {};
  const cls = content.ok ? classifyContent(lc.contentType, lc.byteLength) : c.cls;
  const contentHTML = renderContent(lc, cls);
  const l = (loc.ok && loc.data) || {};
  const metaHTML = `
    <table class="kv">
      <tr><th>Number</th><td>${c.inscriptionNumber !== null ? "#" + esc(String(c.inscriptionNumber)) : "—"}</td></tr>
      <tr><th>Id</th><td><code class="mono wrap">${esc(c.id)}</code></td></tr>
      <tr><th>Content type</th><td><code class="mono">${esc(cls.type || c.contentType || "—")}</code></td></tr>
      <tr><th>Size</th><td>${esc(fmtBytes(lc.byteLength ?? c.byteLength))}</td></tr>
      <tr><th>Marker</th><td>${esc(c.protocolMarker || "—")}</td></tr>
      <tr><th>Block</th><td>${c.blockHeight !== null && c.blockHeight !== undefined ? esc(String(c.blockHeight)) : "—"}</td></tr>
      <tr><th>Txid</th><td><code class="mono wrap">${esc(c.txid || "—")}</code></td></tr>
      <tr><th>Owner</th><td><code class="mono wrap">${esc(l.currentOwnerAddress || c.ownerAddress || "—")}</code></td></tr>
      <tr><th>Location</th><td>${esc(l.status || "—")}${l.currentOutpoint ? ` · <code class="mono">${esc(short(l.currentOutpoint))}</code>` : ""}</td></tr>
    </table>`;
  openDialog(c.id, c.inscriptionNumber, metaHTML, contentHTML);
}

function renderContent(lc, cls) {
  if (!lc || !Object.keys(lc).length) {
    return `<div class="empty">Content endpoint not available at this indexer (<code>/inscriptions/:id/content</code> is optional in the API contract).</div>`;
  }
  if (cls.bucket === "image") {
    const url = buildDataUrl(lc);
    if (url) return `<img class="full-img" alt="inscription content" src="${esc(url)}">`;
    return `<div class="empty">Image failed safety checks — not rendered.</div>`;
  }
  if (cls.bucket === "audio") {
    const url = buildDataUrl(lc);
    return url ? `<audio controls src="${esc(url)}"></audio>` : `<div class="empty">Audio failed safety checks.</div>`;
  }
  if (cls.bucket === "video") {
    const url = buildDataUrl(lc);
    return url ? `<video controls playsinline src="${esc(url)}"></video>` : `<div class="empty">Video failed safety checks.</div>`;
  }
  if (cls.bucket === "text") {
    let text = lc.bodyText;
    if (typeof text !== "string" && typeof lc.bodyBase64 === "string") {
      const bytes = decodeBase64Strict(lc.bodyBase64);
      if (bytes) { try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { text = null; } }
    }
    if (typeof text !== "string") return `<div class="empty">Text could not be decoded as UTF-8.</div>`;
    let pretty = text;
    try { if (cls.type.endsWith("json")) pretty = JSON.stringify(JSON.parse(text), null, 2); } catch {}
    return `<pre class="code-view">${esc(pretty.length > 20000 ? pretty.slice(0, 20000) + "\n…(truncated)" : pretty)}</pre>`;
  }
  if (cls.bucket === "too-large") {
    return `<div class="empty">Content is ${esc(fmtBytes(lc.byteLength))} — too large for an inline preview. Fetch it from the indexer directly: <code class="mono">/inscriptions/${esc(String(lc.id ?? ""))}/content</code></div>`;
  }
  // binary / not-rendered / unknown: show hex sample, never render
  let hex = lc.bodyHex;
  if (typeof hex !== "string" && typeof lc.bodyBase64 === "string") {
    const bytes = decodeBase64Strict(lc.bodyBase64);
    if (bytes) hex = [...bytes.slice(0, 256)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  return `<div class="empty">Type <code class="mono">${esc(cls.type || "unknown")}</code> is not rendered inline (scripts/styles risk). Hex sample:</div>
    <pre class="code-view">${esc((hex || "—").slice(0, 512))}</pre>`;
}

/* ---------- lookup ---------- */
async function runLookup() {
  const q = $("lookup-q").value;
  const box = $("lookup-out");
  const parsed = parseLookup(q);
  if (parsed.kind === "empty") { box.innerHTML = `<div class="empty">Enter an inscription number (e.g. 42) or an inscription id.</div>`; return; }
  box.innerHTML = `<div class="empty">Looking up…</div>`;
  if (parsed.kind === "id") {
    const r = await api("/inscriptions/" + encodeURIComponent(parsed.value));
    if (!r.ok) { box.innerHTML = `<div class="empty">Not found: <code>${esc(r.error)}</code></div>`; return; }
    openDetail(String((r.data || {}).inscriptionId ?? (r.data || {}).id ?? parsed.value));
    box.innerHTML = "";
    return;
  }
  // by number: page through asc-ordered list in 100s (contract max)
  let page = 1;
  for (let guard = 0; guard < 50; guard++) {
    const r = await api("/inscriptions", inscriptionsQuery({ order: "asc", page, limit: 100 }));
    if (!r.ok) { box.innerHTML = `<div class="empty">Lookup failed: <code>${esc(r.error)}</code></div>`; return; }
    const d = r.data || {};
    const hit = findByNumber(d, parsed.value);
    if (hit) {
      box.innerHTML = "";
      openDetail(String(hit.inscriptionId ?? hit.id));
      return;
    }
    const total = d.total ?? 0;
    if (page * 100 >= total) break;
    page++;
  }
  box.innerHTML = `<div class="empty">No inscription numbered <code>${esc(parsed.value)}</code> in the indexed range.</div>`;
}

/* ---------- collection ---------- */
async function runCollection() {
  const addr = $("coll-addr").value.trim();
  const box = $("coll-out");
  if (!addr) { box.innerHTML = `<div class="empty">Enter a Pearl address (e.g. <code class="mono">prl1p…</code>).</div>`; return; }
  wallMode = { kind: "address", address: addr };
  $("wall-title").textContent = "Collection — " + short(addr, 10);
  switchTab("wall");
  await loadWall(true);
}

/* ---------- connection ---------- */
function setConn(state, text) {
  const el = $("conn");
  el.className = "conn" + (state === "on" ? " on" : state === "err" ? " err" : "");
  el.textContent = text;
}

async function connect() {
  const url = store.api;
  if (!url) {
    setConn("off", "indexer: unconfigured");
    $("status").classList.add("hidden");
    $("api-hint").classList.remove("ok");
    $("api-hint").innerHTML = "<strong>Not connected.</strong> Set the indexer API base URL above — e.g. the public endpoint published by a Pearlscriptions indexer operator. Data is fetched live; nothing is bundled or faked.";
    renderEmptyWall();
    return;
  }
  setConn("off", "indexer: connecting…");
  const health = await api("/health");
  if (!health.ok) {
    setConn("err", "indexer: unreachable");
    $("api-hint").classList.remove("ok");
    $("api-hint").innerHTML = `<strong>Unreachable.</strong> Could not reach <code class="mono">${esc(url)}</code> (<code>${esc(health.error)}</code>). Check the URL and CORS on the API side.`;
    renderEmptyWall();
    return;
  }
  const h = health.data || {};
  setConn("on", `indexer: live · ${esc(h.chain || h.service || "ok")}`);
  $("api-hint").classList.add("ok");
  $("api-hint").innerHTML = `<strong>Connected.</strong> Reading live data from <code class="mono">${esc(url)}</code>.` +
    (h.forkEra ? ` · fork era <code>${esc(h.forkEra)}</code>` : "");
  const st = await api("/indexer/status");
  if (st.ok) {
    const s = st.data || {};
    $("status").classList.remove("hidden");
    $("status-stats").innerHTML =
      `<div class="stat"><div class="k">chain</div><div class="v">${esc(s.chain ?? "—")}</div></div>` +
      `<div class="stat"><div class="k">indexed height</div><div class="v">${esc(String(s.indexedHeight ?? "—"))}</div></div>` +
      `<div class="stat"><div class="k">synced</div><div class="v">${s.synced === true ? "yes" : s.synced === false ? "catching up" : "—"}</div></div>` +
      `<div class="stat"><div class="k">inscriptions</div><div class="v">${esc(String(s.summary?.inscriptions ?? s.inscriptionCount ?? "—"))}</div></div>`;
  }
  wallMode = { kind: "latest" };
  $("wall-title").textContent = "The wall — latest inscriptions";
  await loadWall(true);
}

function renderEmptyWall() {
  $("wall").innerHTML = `<div class="empty">Set the indexer API URL above to hang the wall.</div>`;
  $("wall-more").style.display = "none";
  $("wall-note").textContent = "";
}

/* ---------- tabs ---------- */
function switchTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".tabpanel").forEach((p) => p.classList.toggle("hidden", p.id !== "panel-" + name));
}

/* ---------- boot ---------- */
function safeBoot() {
  try {
    boot();
  } catch (e) {
    // Never leave the page silently dead: surface the failure where the
    // operator can see it and keep the static content honest.
    try {
      const el = $("conn");
      el.className = "conn err";
      el.textContent = "gallery failed to start: " + String((e && e.message) || e);
      $("wall").innerHTML = '<div class="empty">The gallery could not start in this browser (' +
        esc(String((e && e.message) || e)) + '). The page content above is static.</div>';
    } catch {}
    if (typeof console !== "undefined" && console.error) console.error("[gallery] boot failed:", e);
  }
}

function boot() {
  // gallery-core.js loads before this script and exposes window.__galleryCore
  $("api-url").value = store.api;
  $("api-save").addEventListener("click", () => { store.api = $("api-url").value; connect(); });
  $("api-clear").addEventListener("click", () => { store.api = ""; $("api-url").value = ""; connect(); });
  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => switchTab(t.dataset.tab)));
  document.querySelectorAll(".fchip").forEach((c) => c.addEventListener("click", () => {
    document.querySelectorAll(".fchip").forEach((x) => x.classList.remove("active"));
    c.classList.add("active");
    wallFilter = c.dataset.f;
    applyFilter();
  }));
  $("wall-more").addEventListener("click", async () => { wallPage++; await loadWall(false); });
  $("lookup-go").addEventListener("click", runLookup);
  $("lookup-q").addEventListener("keydown", (e) => { if (e.key === "Enter") runLookup(); });
  $("coll-go").addEventListener("click", runCollection);
  $("coll-addr").addEventListener("keydown", (e) => { if (e.key === "Enter") runCollection(); });
  $("donate-addr").textContent = DONATE_ADDRESS;
  $("donate-addr").addEventListener("click", () => {
    const v = DONATE_ADDRESS;
    const done = () => { $("donate-msg").textContent = "Copied. Thank you!"; };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(v).then(done).catch(() => { $("donate-msg").textContent = "Copy failed — select manually."; });
    else $("donate-msg").textContent = "Select the address manually.";
  });
  connect();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", safeBoot);
} else {
  safeBoot();
}
