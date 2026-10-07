/* Pearl Metrics — UI wiring. All scrape-derived strings are rendered
 * through esc() (label values are node-controlled and must never reach
 * innerHTML raw — the fleet XSS lesson). Parsing/summary live in
 * metrics-core.js (window.PearlMetrics). */
"use strict";

const M = window.PearlMetrics;
const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/* A realistic scrape in the exact PR #310 format, so the dashboard can be
 * evaluated without a metrics-enabled node. The UI labels it SAMPLE. */
const SAMPLE_SCRAPE = [
  "# HELP pearld_info Node build and network identity.",
  "# TYPE pearld_info gauge",
  'pearld_info{network="mainnet",protocol_version="70016",version="1.4.9"} 1',
  "# HELP pearld_chain_tip_height Current chain tip height.",
  "# TYPE pearld_chain_tip_height gauge",
  "pearld_chain_tip_height 241318",
  "# TYPE pearld_chain_tip_timestamp_seconds gauge",
  "pearld_chain_tip_timestamp_seconds 1759772400",
  "# TYPE pearld_chain_total_transactions gauge",
  "pearld_chain_total_transactions 8123456",
  "# TYPE pearld_chain_is_current gauge",
  "pearld_chain_is_current 1",
  "# TYPE pearld_chain_blocks_connected_total counter",
  "pearld_chain_blocks_connected_total 1204",
  "# TYPE pearld_chain_blocks_disconnected_total counter",
  "pearld_chain_blocks_disconnected_total 2",
  "# TYPE pearld_chain_blocks_accepted_total counter",
  "pearld_chain_blocks_accepted_total 1206",
  "# TYPE pearld_p2p_peers gauge",
  'pearld_p2p_peers{direction="inbound"} 9',
  'pearld_p2p_peers{direction="outbound"} 8',
  "# TYPE pearld_p2p_peer_connects_total counter",
  'pearld_p2p_peer_connects_total{direction="inbound"} 312',
  'pearld_p2p_peer_connects_total{direction="outbound"} 96',
  "# TYPE pearld_p2p_peer_disconnects_total counter",
  'pearld_p2p_peer_disconnects_total{direction="inbound"} 303',
  'pearld_p2p_peer_disconnects_total{direction="outbound"} 88',
  "# TYPE pearld_p2p_peers_banned_total counter",
  "pearld_p2p_peers_banned_total 1",
  "# TYPE pearld_p2p_peers_rejected_total counter",
  'pearld_p2p_peers_rejected_total{reason="max_peers"} 14',
  'pearld_p2p_peers_rejected_total{reason="other"} 3',
  "# TYPE pearld_p2p_wire_messages_total counter",
  'pearld_p2p_wire_messages_total{command="tx",direction="inbound"} 152233',
  'pearld_p2p_wire_messages_total{command="tx",direction="outbound"} 148901',
  'pearld_p2p_wire_messages_total{command="inv",direction="inbound"} 40211',
  'pearld_p2p_wire_messages_total{command="inv",direction="outbound"} 39877',
  'pearld_p2p_wire_messages_total{command="ping",direction="inbound"} 9120',
  'pearld_p2p_wire_messages_total{command="ping",direction="outbound"} 9104',
  "# TYPE pearld_p2p_wire_bytes_total counter",
  'pearld_p2p_wire_bytes_total{command="tx",direction="inbound"} 81234567',
  'pearld_p2p_wire_bytes_total{command="tx",direction="outbound"} 79012345',
  'pearld_p2p_wire_bytes_total{command="inv",direction="inbound"} 1447561',
  'pearld_p2p_wire_bytes_total{command="inv",direction="outbound"} 1434002',
  'pearld_p2p_wire_bytes_total{command="ping",direction="inbound"} 292032',
  'pearld_p2p_wire_bytes_total{command="ping",direction="outbound"} 291328',
  "# TYPE pearld_net_totalbytes_recv_total counter",
  "pearld_net_totalbytes_recv_total 104857600",
  "# TYPE pearld_net_totalbytes_sent_total counter",
  "pearld_net_totalbytes_sent_total 99614720",
  "# TYPE pearld_rpc_requests_total counter",
  'pearld_rpc_requests_total{method="getblock",result="success"} 1820',
  'pearld_rpc_requests_total{method="getblock",result="error"} 12',
  'pearld_rpc_requests_total{method="getbestblockhash",result="success"} 5311',
  'pearld_rpc_requests_total{method="getmininginfo",result="success"} 2874',
  'pearld_rpc_requests_total{method="unknown",result="error"} 4',
  "# TYPE pearld_rpc_request_duration_seconds histogram",
  'pearld_rpc_request_duration_seconds_bucket{method="getblock",le="0.001"} 900',
  'pearld_rpc_request_duration_seconds_bucket{method="getblock",le="0.005"} 1600',
  'pearld_rpc_request_duration_seconds_bucket{method="getblock",le="0.025"} 1800',
  'pearld_rpc_request_duration_seconds_bucket{method="getblock",le="+Inf"} 1832',
  'pearld_rpc_request_duration_seconds_sum{method="getblock"} 4.393',
  'pearld_rpc_request_duration_seconds_count{method="getblock"} 1832',
  'pearld_rpc_request_duration_seconds_bucket{method="getbestblockhash",le="0.001"} 5200',
  'pearld_rpc_request_duration_seconds_bucket{method="getbestblockhash",le="0.005"} 5305',
  'pearld_rpc_request_duration_seconds_bucket{method="getbestblockhash",le="0.025"} 5311',
  'pearld_rpc_request_duration_seconds_bucket{method="getbestblockhash",le="+Inf"} 5311',
  'pearld_rpc_request_duration_seconds_sum{method="getbestblockhash"} 1.06',
  'pearld_rpc_request_duration_seconds_count{method="getbestblockhash"} 5311',
  "# TYPE pearld_rpc_auth_failures_total counter",
  "pearld_rpc_auth_failures_total 0",
  "# TYPE pearld_rpc_websocket_clients gauge",
  "pearld_rpc_websocket_clients 2",
  "# TYPE pearld_mempool_transactions gauge",
  "pearld_mempool_transactions 4211",
  "# TYPE pearld_mempool_bytes gauge",
  "pearld_mempool_bytes 7340032",
  "# TYPE pearld_mempool_max_bytes gauge",
  "pearld_mempool_max_bytes 314572800",
  "# TYPE pearld_mempool_last_updated_timestamp_seconds gauge",
  "pearld_mempool_last_updated_timestamp_seconds 1759772460",
  "# TYPE go_goroutines gauge",
  "go_goroutines 148",
  "",
].join("\n");

const state = { prev: null, prevAt: 0, timer: null, lastSummary: null };

function setStatus(msg, isErr) {
  const el = $("status");
  el.textContent = msg;
  el.className = "status" + (isErr ? " err" : "");
}

function kpi(label, value, sub) {
  return `<div class="kpi"><span class="kpi-label">${esc(label)}</span>` +
    `<span class="kpi-value">${esc(value)}</span>` +
    (sub ? `<span class="kpi-sub">${esc(sub)}</span>` : "") + "</div>";
}

function render(text, sourceLabel, fetchedAt) {
  const parsed = M.parseExposition(text);
  const now = Date.now() / 1000;
  const s = M.summarize(parsed, now);
  state.lastSummary = s;

  // rates vs the previous scrape, when we have one
  let ratesHtml = "";
  if (state.prev) {
    const elapsed = now - state.prevAt;
    const rates = M.counterRates(state.prev.samples, parsed.samples, elapsed);
    const parts = [];
    const show = (name, label, fmt) => {
      const r = rates[name];
      if (r != null) parts.push(`${esc(label)}: ${esc(fmt(r))}/s`);
    };
    show("pearld_rpc_requests_total", "RPC requests", M.fmtRate);
    show("pearld_chain_blocks_connected_total", "blocks connected", M.fmtRate);
    show("pearld_net_totalbytes_recv_total", "net recv", (v) => M.fmtBytes(v));
    show("pearld_net_totalbytes_sent_total", "net sent", (v) => M.fmtBytes(v));
    if (parts.length) {
      ratesHtml = `<p class="rates">Rates vs previous scrape (${esc(elapsed.toFixed(0))}s apart) — ${parts.join(" · ")}</p>`;
    } else {
      ratesHtml = `<p class="rates">Second scrape received, but a counter moved backwards — the node likely restarted, so no rates are shown.</p>`;
    }
  }
  state.prev = parsed;
  state.prevAt = now;

  const id = s.info || {};
  $("identity").innerHTML =
    `<span class="id-item">version <strong>${esc(id.version ?? "—")}</strong></span>` +
    `<span class="id-item">network <strong>${esc(id.network ?? "—")}</strong></span>` +
    `<span class="id-item">protocol <strong>${esc(id.protocol_version ?? "—")}</strong></span>` +
    `<span class="id-item">source <strong>${esc(sourceLabel)}</strong></span>` +
    `<span class="id-item">scraped <strong>${esc(fetchedAt)}</strong></span>` +
    `<span class="id-item">${esc(M.fmtInt(s.seriesCount))} series · ${esc(M.fmtInt(s.familyCount))} families${s.parseErrors ? ` · ${esc(s.parseErrors)} malformed lines skipped` : ""}</span>`;

  $("kpis").innerHTML = [
    kpi("Chain tip", M.fmtInt(s.chain.tipHeight), "tip " + M.fmtAge(s.chain.tipAgeSeconds) + (s.chain.isCurrent === 0 ? " · syncing" : s.chain.isCurrent === 1 ? " · synced" : "")),
    kpi("Peers", M.fmtInt((s.peers.inbound || 0) + (s.peers.outbound || 0)), `${M.fmtInt(s.peers.inbound)} in · ${M.fmtInt(s.peers.outbound)} out`),
    kpi("Mempool", M.fmtInt(s.mempool.transactions) + " tx", `${M.fmtBytes(s.mempool.bytes)}${s.mempool.utilization != null ? " · " + (s.mempool.utilization * 100).toFixed(1) + "% of limit" : ""}`),
    kpi("RPC requests", M.fmtInt(s.rpc.totals.total), `${M.fmtInt(s.rpc.totals.error)} errors${s.rpc.totals.errorRate != null ? " (" + (s.rpc.totals.errorRate * 100).toFixed(1) + "%)" : ""} · ${M.fmtInt(s.rpc.websocketClients)} ws clients`),
    kpi("Bandwidth (since start)", M.fmtBytes((s.net.recvTotal || 0) + (s.net.sentTotal || 0)), `${M.fmtBytes(s.net.recvTotal)} in · ${M.fmtBytes(s.net.sentTotal)} out`),
    kpi("Chain transactions", M.fmtInt(s.chain.totalTransactions), `${M.fmtInt(s.chain.blocksConnected)} blocks connected · ${M.fmtInt(s.chain.blocksDisconnected)} disconnected`),
  ].join("");

  $("health").innerHTML = s.health.map((n) =>
    `<li class="note-${esc(n.level)}">${esc(n.text)}</li>`).join("");

  $("chainBody").innerHTML = [
    ["Tip height", M.fmtInt(s.chain.tipHeight)],
    ["Tip timestamp", s.chain.tipTimestamp ? new Date(s.chain.tipTimestamp * 1000).toISOString() : "—"],
    ["Tip age", M.fmtAge(s.chain.tipAgeSeconds)],
    ["Synced (is_current)", s.chain.isCurrent == null ? "—" : s.chain.isCurrent === 1 ? "yes" : "no — syncing"],
    ["Total chain transactions", M.fmtInt(s.chain.totalTransactions)],
    ["Blocks connected", M.fmtInt(s.chain.blocksConnected)],
    ["Blocks disconnected (reorgs)", M.fmtInt(s.chain.blocksDisconnected)],
    ["Blocks accepted", M.fmtInt(s.chain.blocksAccepted)],
  ].map(([k, v]) => `<tr><th scope="row">${esc(k)}</th><td class="mono">${esc(v)}</td></tr>`).join("");

  $("peerBody").innerHTML = [
    ["Inbound peers", M.fmtInt(s.peers.inbound)],
    ["Outbound peers", M.fmtInt(s.peers.outbound)],
    ["Connects (in / out)", `${M.fmtInt(s.peers.connectsInbound)} / ${M.fmtInt(s.peers.connectsOutbound)}`],
    ["Disconnects (in / out)", `${M.fmtInt(s.peers.disconnectsInbound)} / ${M.fmtInt(s.peers.disconnectsOutbound)}`],
    ["Peers banned", M.fmtInt(s.peers.banned)],
    ["Rejected connections", M.fmtInt(s.peers.rejectedTotal) + (Object.keys(s.peers.rejected).length ? " (" + Object.entries(s.peers.rejected).map(([k, v]) => `${k}: ${M.fmtInt(v)}`).join(", ") + ")" : "")],
  ].map(([k, v]) => `<tr><th scope="row">${esc(k)}</th><td class="mono">${esc(v)}</td></tr>`).join("");

  $("rpcBody").innerHTML = s.rpc.byMethod.length ? s.rpc.byMethod.map((r) =>
    `<tr><td class="mono">${esc(r.method)}</td><td class="mono">${esc(M.fmtInt(r.total))}</td>` +
    `<td class="mono">${esc(M.fmtInt(r.error))}</td>` +
    `<td class="mono">${r.errorRate == null ? "—" : esc((r.errorRate * 100).toFixed(1) + "%")}</td>` +
    `<td class="mono">${esc(M.fmtSeconds(r.meanSeconds))}</td>` +
    `<td class="mono">${esc(M.fmtSeconds(r.p95Seconds))}</td></tr>`).join("")
    : `<tr><td colspan="6" class="muted">No pearld_rpc_requests_total series in this scrape.</td></tr>`;

  $("wireBody").innerHTML = s.wire.length ? s.wire.map((w) =>
    `<tr><td class="mono">${esc(w.command)}</td><td class="mono">${esc(M.fmtInt(w.inMessages))}</td>` +
    `<td class="mono">${esc(M.fmtInt(w.outMessages))}</td><td class="mono">${esc(M.fmtBytes(w.inBytes))}</td>` +
    `<td class="mono">${esc(M.fmtBytes(w.outBytes))}</td></tr>`).join("")
    : `<tr><td colspan="5" class="muted">No wire series — per-frame wire hooks are only installed when the metrics endpoint is configured on the node.</td></tr>`;

  $("mempoolBody").innerHTML = [
    ["Transactions", M.fmtInt(s.mempool.transactions)],
    ["Size", M.fmtBytes(s.mempool.bytes)],
    ["Configured limit", M.fmtBytes(s.mempool.maxBytes)],
    ["Utilization", s.mempool.utilization == null ? "—" : (s.mempool.utilization * 100).toFixed(2) + "%"],
    ["Last change", M.fmtAge(s.mempool.lastUpdatedAgeSeconds)],
  ].map(([k, v]) => `<tr><th scope="row">${esc(k)}</th><td class="mono">${esc(v)}</td></tr>`).join("");

  $("rates").innerHTML = ratesHtml;
  renderSeries(parsed, $("seriesFilter").value);
  $("results").hidden = false;
}

function renderSeries(parsed, filter) {
  const q = (filter || "").trim().toLowerCase();
  const rows = [];
  for (const s of parsed.samples) {
    const labelStr = Object.entries(s.labels).map(([k, v]) => `${k}="${v}"`).join(",");
    const hay = (s.name + "{" + labelStr + "}").toLowerCase();
    if (q && !hay.includes(q)) continue;
    const type = parsed.families[s.name] ? parsed.families[s.name].type : "";
    rows.push(`<tr><td class="mono">${esc(s.name)}${labelStr ? `<span class="labels">{${esc(labelStr)}}</span>` : ""}</td>` +
      `<td>${esc(type || "")}</td><td class="mono">${esc(Number.isFinite(s.value) ? String(s.value) : (s.value > 0 ? "+Inf" : s.value < 0 ? "-Inf" : "NaN"))}</td></tr>`);
    if (rows.length >= 500) { rows.push(`<tr><td colspan="3" class="muted">…truncated at 500 rows — refine the filter.</td></tr>`); break; }
  }
  $("seriesBody").innerHTML = rows.length ? rows.join("") : `<tr><td colspan="3" class="muted">No series match.</td></tr>`;
  state.lastParsed = parsed;
}

async function fetchScrape() {
  const url = $("endpoint").value.trim();
  if (!url) { setStatus("Enter a metrics endpoint URL first.", true); return; }
  try { localStorage.setItem("pearlMetrics.endpoint", url); } catch (e) { /* private mode */ }
  setStatus("Fetching " + url + " …");
  try {
    const res = await fetch(url, { headers: { "Accept": "text/plain" } });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const text = await res.text();
    render(text, url, new Date().toLocaleTimeString());
    setStatus("Scrape rendered — " + state.lastSummary.seriesCount + " series from " + url + ".");
  } catch (err) {
    setStatus("Fetch failed (" + err.message + "). pearld serves no CORS headers, so a browser fetch from this HTTPS page usually fails — run the page locally, put the endpoint behind a CORS proxy you control, or paste a scrape instead (curl the endpoint and paste the output).", true);
  }
}

function wire() {
  try {
    const saved = localStorage.getItem("pearlMetrics.endpoint");
    if (saved) $("endpoint").value = saved;
  } catch (e) { /* private mode */ }
  $("btnFetch").addEventListener("click", fetchScrape);
  $("btnPaste").addEventListener("click", () => {
    const text = $("paste").value;
    if (!text.trim()) { setStatus("Paste a /metrics scrape first, or load the sample.", true); return; }
    render(text, "pasted scrape", new Date().toLocaleTimeString());
    setStatus("Pasted scrape rendered — " + state.lastSummary.seriesCount + " series.");
  });
  $("btnSample").addEventListener("click", () => {
    // Rebase the sample's timestamps to now so its ages read realistically;
    // values stay sample figures and the source label says SAMPLE.
    const now = Math.floor(Date.now() / 1000);
    const text = SAMPLE_SCRAPE
      .replace("pearld_chain_tip_timestamp_seconds 1759772400", "pearld_chain_tip_timestamp_seconds " + (now - 74))
      .replace("pearld_mempool_last_updated_timestamp_seconds 1759772460", "pearld_mempool_last_updated_timestamp_seconds " + (now - 14));
    render(text, "SAMPLE data (illustrative, not a live node)", new Date().toLocaleTimeString());
    setStatus("Sample scrape rendered — these are illustrative figures in the exact PR #310 format, not a live node.");
  });
  $("seriesFilter").addEventListener("input", () => {
    if (state.lastParsed) renderSeries(state.lastParsed, $("seriesFilter").value);
  });
  $("autoRefresh").addEventListener("change", () => {
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    if ($("autoRefresh").checked) {
      state.timer = setInterval(fetchScrape, 15000);
      setStatus("Auto-refresh on — fetching every 15s.");
    } else setStatus("Auto-refresh off.");
  });
  const addr = $("donateAddr");
  if (addr) {
    const copy = () => {
      if (navigator.clipboard) navigator.clipboard.writeText(addr.textContent.trim());
      $("copiedMsg").hidden = false;
      setTimeout(() => { $("copiedMsg").hidden = true; }, 1600);
    };
    addr.addEventListener("click", copy);
    addr.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); copy(); } });
  }
}

document.addEventListener("DOMContentLoaded", wire);
