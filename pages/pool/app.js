/* Pearl Foundry — Open-Source PRL Mining Pool (dashboard).
 * Talks to the pool-server dashboard API (GET /api/stats, /api/miners,
 * /api/balances, /api/config); when no backend is reachable it falls back
 * to DEMO data that is always labelled as such, never disguised as live.
 * Every field the API returns is untrusted display data: wallet and worker
 * strings come from miner logins, so all backend-supplied strings are
 * HTML-escaped before they reach innerHTML. */
"use strict";

const LS_KEY = "pearlFoundryApi";
const $ = (id) => document.getElementById(id);

/* ---------- pure helpers (unit-tested in tests/pool.test.mjs) ---------- */

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

const fmtInt = (n) => Number(n || 0).toLocaleString("en-US");

const trunc = (a) => a && a.length > 18 ? a.slice(0, 10) + "…" + a.slice(-6) : (a || "—");

/* lastShareAt is a Date.now() millisecond timestamp (pool-server pool.js);
 * 0 means the miner has not shared yet. `now` is injectable for tests. */
const timeAgo = (ts, now = Date.now()) => {
  if (!ts) return "—";
  const s = Math.max(0, Math.floor(now / 1000 - ts / 1000));
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  return Math.floor(s / 3600) + "h ago";
};

const hashrate = (h) => {
  if (!h || h <= 0) return "—";
  const units = ["H/s", "kH/s", "MH/s", "GH/s"];
  let v = h, u = 0;
  while (v >= 1000 && u < units.length - 1) { v /= 1000; u++; }
  return v.toFixed(2) + " " + units[u];
};

/* Grains (1 PRL = 1e8 grains) -> PRL string at 4 decimal places, exact via
 * BigInt: the old (Number(grains) / 1e8).toFixed(4) silently rounds grain
 * counts past Number.MAX_SAFE_INTEGER. Anything that is not an integer
 * grain count renders as a dash instead of a fabricated figure. */
function fmtPRL(grains) {
  if (grains === null || grains === undefined || grains === "") return "—";
  const s = String(grains).trim();
  if (!/^-?\d+$/.test(s)) return "—";
  const g = BigInt(s);
  const neg = g < 0n;
  const a = neg ? -g : g;
  const units4 = (a + 5000n) / 10000n; // PRL * 10^4, rounded half-up
  const whole = units4 / 10000n;
  const frac = (units4 % 10000n).toString().padStart(4, "0");
  return (neg && units4 !== 0n ? "-" : "") + whole.toString() + "." + frac;
}

/* API base precedence: ?api= query param, then the stored backend, then
 * same-origin. Exactly one trailing slash is stripped, as before. */
function resolveApiBase(queryApi, storedApi, origin) {
  return (queryApi || storedApi || origin || "").replace(/\/$/, "");
}

function filterMiners(miners, f) {
  const needle = String(f || "").toLowerCase();
  if (!needle) return miners || [];
  return (miners || []).filter((m) =>
    ((m.wallet || "") + " " + (m.worker || "")).toLowerCase().includes(needle));
}

/* ---------- section builders (pure; every API string escaped) ---------- */

function statsHtml(pool, payouts, isDemo) {
  pool = pool || {}; payouts = payouts || {};
  const tag = isDemo ? '<span class="demo-tag">demo</span>' : "";
  const blockSub = pool.templateSource === "synthetic-demo" ? "demo templates"
    : (pool.templateSource === "demo" ? "sample data" + tag : (esc(pool.templateSource || "—") + tag));
  const cards = [
    ["Block height", fmtInt(pool.height), blockSub],
    ["Miners online", fmtInt(pool.minersOnline), fmtInt(pool.connections) + " connections total" + tag],
    ["Shares accepted", fmtInt(pool.sharesValid), fmtInt(pool.sharesInvalid) + " invalid · " + fmtInt(pool.sharesStale) + " stale" + tag],
    ["Blocks found", fmtInt(pool.blocksFound), esc(payouts.poolFeePct ?? 1) + "% pool fee · PPLNS" + tag],
    ["PPLNS window", fmtInt(payouts.windowShares), "of " + fmtInt(payouts.windowMax) + " shares" + tag],
    ["Uptime", Math.floor((pool.uptimeSec || 0) / 3600) + "h", "cert v" + esc(pool.certVersion ?? 3) + " · " + esc(pool.network || "") + tag],
  ];
  return cards.map(([k, v, s]) =>
    `<div class="card"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join("");
}

function minersSection(miners, f) {
  const all = miners || [];
  const shown = filterMiners(all, f);
  const sub = all.length + " connected" + (f ? " · " + shown.length + " match" : "");
  if (!shown.length) {
    return { sub, html: all.length
      ? `<div class="empty">No miners match your search.</div>`
      : `<div class="empty">No miners connected yet. See “Connect your miner” below.</div>` };
  }
  const rows = shown.map((m) => `<tr><td class="addr" title="${esc(m.wallet)}">${esc(trunc(m.wallet))}</td>
    <td>${esc(m.worker || "—")} ${m.solo ? '<span class="tag solo">solo</span>' : ""}</td>
    <td>${esc(m.dialect || "—")}</td><td>${fmtInt(m.diff)}</td><td>${fmtInt(m.sharesValid)}</td>
    <td>${fmtInt(m.sharesInvalid)}</td><td>${hashrate(m.estHashrate)}</td><td>${timeAgo(m.lastShareAt)}</td></tr>`).join("");
  return { sub, html: `<table><thead><tr><th>Wallet</th><th>Worker</th><th>Dialect</th><th>Diff</th>
    <th>Valid</th><th>Invalid</th><th>Est. rate</th><th>Last share</th></tr></thead><tbody>${rows}</tbody></table>` };
}

function roundsHtml(rounds) {
  if (!rounds || !rounds.length) return `<div class="empty">No blocks found yet.</div>`;
  return `<table><thead><tr><th>Height</th><th>Reward</th><th>Fee</th><th>Miners paid</th></tr></thead><tbody>` +
    rounds.map((r) => `<tr><td>${esc(r.height ?? "—")}</td><td>${fmtPRL(r.reward)} PRL</td>
      <td>${fmtPRL(r.fee)}</td><td>${(r.payouts || []).length}</td></tr>`).join("") + `</tbody></table>`;
}

function balancesHtml(balances) {
  if (!balances || !balances.length) return `<div class="empty">No balances yet — shares earn PPLNS weight once miners connect.</div>`;
  return `<table><thead><tr><th>Wallet</th><th>Unpaid</th><th>Paid</th><th>Blocks</th></tr></thead><tbody>` +
    balances.map((b) => `<tr><td class="addr" title="${esc(b.wallet)}">${esc(trunc(b.wallet))}</td>
      <td>${esc(b.unpaidPRL ?? "—")} PRL</td><td>${esc(b.paidPRL ?? "—")} PRL</td><td>${esc(b.blocks ?? "—")}</td></tr>`).join("") + `</tbody></table>`;
}

/* ---------- demo data (labelled demo in the UI, never live figures) ---------- */

const DEMO = {
  pool: { uptimeSec: 86400, minersOnline: 3, connections: 41, height: 120042, templateSource: "demo",
          certVersion: 3, network: "mainnet", activeDiffs: [1024, 888888], sharesValid: 1204,
          sharesInvalid: 7, sharesStale: 11, sharesDuplicate: 2, blocksFound: 1 },
  payouts: { windowShares: 1204, windowMax: 1000000, poolFeePct: 1, blocksFound: 1, miners: 3,
             rounds: [{ height: 120041, reward: "230549524009", fee: "2305495240", finder: "prl1demo…", payouts: [] },
                      { height: 119988, reward: "230549524009", fee: "2305495240", finder: "prl1demo…", payouts: [{},{},{},{},{}] },
                      { height: 119912, reward: "230549524009", fee: "2305495240", finder: "prl1demo…", payouts: [{},{},{}] }] },
  miners: [
    { wallet: "prl1demo0000000000000000000000000000000000000000", worker: "rig1", solo: false, dialect: "hero",
      diff: 888888, sharesValid: 812, sharesInvalid: 3, lastShareAt: Date.now() - 8000, estHashrate: 59259 },
    { wallet: "prl1demo1111111111111111111111111111111111111111", worker: "cmp1", solo: false, dialect: "kryptex",
      diff: 2097152, sharesValid: 301, sharesInvalid: 1, lastShareAt: Date.now() - 22000, estHashrate: 139810 },
    { wallet: "prl1demo2222222222222222222222222222222222222222", worker: "solo1", solo: true, dialect: "hero",
      diff: 1024, sharesValid: 91, sharesInvalid: 3, lastShareAt: Date.now() - 61000, estHashrate: 68 },
  ],
  balances: [
    { wallet: "prl1demo0000000000000000000000000000000000000000", unpaidPRL: "12.45019302", paidPRL: "0", blocks: 0 },
    { wallet: "prl1demo1111111111111111111111111111111111111111", unpaidPRL: "4.11882011", paidPRL: "0", blocks: 1 },
  ],
};

if (typeof document === "undefined") {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { esc, fmtInt, trunc, timeAgo, hashrate, fmtPRL, resolveApiBase,
                       filterMiners, statsHtml, minersSection, roundsHtml, balancesHtml, DEMO, LS_KEY };
  }
} else {

/* ---------- browser wiring ---------- */

const store = {
  get api() { return localStorage.getItem(LS_KEY) || ""; },
  set api(v) { v ? localStorage.setItem(LS_KEY, v) : localStorage.removeItem(LS_KEY); },
};
function apiBase() {
  const q = new URLSearchParams(location.search).get("api");
  return resolveApiBase(q, store.api, location.origin);
}
async function get(path) {
  const r = await fetch(apiBase() + path, { cache: "no-store" });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

let demo = false;

function renderStats(pool, payouts) {
  $("statGrid").innerHTML = statsHtml(pool, payouts, demo);
}

let currentMiners = [];
const minerFilterVal = () => (($("minerFilter") && $("minerFilter").value) || "").trim().toLowerCase();

function renderMiners(miners) {
  currentMiners = miners || [];
  const section = minersSection(currentMiners, minerFilterVal());
  $("minerSub").textContent = section.sub;
  $("minerTable").innerHTML = section.html;
}
$("minerFilter").addEventListener("input", () => renderMiners(currentMiners));

function renderRounds(rounds) {
  $("roundList").innerHTML = roundsHtml(rounds);
}

function renderBalances(balances) {
  $("balanceList").innerHTML = balancesHtml(balances);
}

function setConn(live, label) {
  $("dot").className = "dot" + (live ? " live" : "");
  $("connLabel").textContent = label;
  $("demoBanner").classList.toggle("show", !live);
  demo = !live;
}

async function refresh() {
  try {
    const [stats, miners, balances] = await Promise.all([
      get("/api/stats"), get("/api/miners"), get("/api/balances"),
    ]);
    setConn(true, "LIVE · " + apiBase());
    renderStats(stats.pool, stats.payouts);
    renderMiners(miners.miners || []);
    renderRounds(stats.payouts.rounds || []);
    renderBalances(balances.balances || []);
    try {
      const cfg = await get("/api/config");
      const host = new URL(apiBase()).hostname;
      document.querySelectorAll(".ph").forEach((el) => el.textContent = host);
      $("hostLine").textContent = host + ":" + (cfg.stratumPort || 3333);
    } catch { /* keep placeholders */ }
  } catch (e) {
    setConn(false, "DEMO — backend unreachable");
    renderStats(DEMO.pool, DEMO.payouts);
    renderMiners(DEMO.miners);
    renderRounds(DEMO.payouts.rounds);
    renderBalances(DEMO.balances);
  }
}

$("apiSave").onclick = () => { store.api = $("apiUrl").value.trim(); refresh(); };
$("apiReset").onclick = () => { store.api = ""; $("apiUrl").value = ""; refresh(); };
$("apiUrl").value = store.api || "";
refresh();
setInterval(refresh, 10000);

} /* end browser-only wiring guard */
