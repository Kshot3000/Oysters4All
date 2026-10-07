/* Pearl Metrics — core: Prometheus exposition parser + pearld summarizer.
 *
 * Pure logic, no DOM. Works in the browser (window.PearlMetrics) and in
 * Node for tests (module.exports).
 *
 * Metric catalogue provenance: pearl-research-labs/pearl PR #310
 * (feat/pearld-metrics, @Aharonee) — node/metrics/README.md and
 * node/metrics/collector.go / metrics.go on that branch. Every pearld_*
 * name below is copied from that catalogue; nothing is invented.
 * The endpoint is opt-in (--metricslisten, default port 9105, /metrics
 * plus /healthz) and, as of 2026-10-06, is NOT in a released pearld —
 * the UI labels that honestly.
 */
"use strict";

/* ---------------- Prometheus text exposition parsing ---------------- */

// Parse a label set body like: method="getblock",result="success",note="a\"b\\c\nd"
function parseLabels(body) {
  const labels = {};
  let i = 0;
  const n = body.length;
  while (i < n) {
    // key
    let key = "";
    while (i < n && /[a-zA-Z0-9_]/.test(body[i])) { key += body[i]; i++; }
    if (!key) return null;
    if (body[i] !== "=") return null;
    i++;
    if (body[i] !== '"') return null;
    i++;
    let val = "";
    let closed = false;
    while (i < n) {
      const c = body[i];
      if (c === "\\" && i + 1 < n) {
        const e = body[i + 1];
        if (e === "n") val += "\n";
        else if (e === '"') val += '"';
        else if (e === "\\") val += "\\";
        else val += e;
        i += 2;
      } else if (c === '"') { closed = true; i++; break; }
      else { val += c; i++; }
    }
    if (!closed) return null;
    labels[key] = val;
    if (i < n) {
      if (body[i] !== ",") return null;
      i++;
    }
  }
  return labels;
}

function parseValue(tok) {
  if (tok === "+Inf") return Infinity;
  if (tok === "-Inf") return -Infinity;
  if (tok === "NaN") return NaN;
  const v = Number(tok);
  return Number.isNaN(v) ? null : v;
}

// Parse one scrape. Returns { families, samples, errors } where families is
// a plain object name -> { help, type, samples: [...] } and samples is the
// flat list { name, labels, value }. Malformed lines land in errors with
// their 1-based line number; parsing never throws.
function parseExposition(text) {
  const families = {};
  const samples = [];
  const errors = [];
  const lines = String(text == null ? "" : text).split(/\r?\n/);
  const fam = (name) => families[name] || (families[name] = { help: "", type: "", samples: [] });
  lines.forEach((raw, idx) => {
    const line = raw.trim();
    if (!line) return;
    if (line.startsWith("#")) {
      const help = line.match(/^#\s*HELP\s+(\S+)\s+(.*)$/);
      const type = line.match(/^#\s*TYPE\s+(\S+)\s+(\S+)\s*$/);
      if (help) fam(help[1]).help = help[2];
      else if (type) fam(type[1]).type = type[2];
      return; // other comments are free text
    }
    const m = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{.*\})?\s+(\S+)(?:\s+\S+)?$/);
    if (!m) { errors.push({ line: idx + 1, text: raw.slice(0, 120) }); return; }
    let labels = {};
    if (m[2]) {
      labels = parseLabels(m[2].slice(1, -1));
      if (labels === null) { errors.push({ line: idx + 1, text: raw.slice(0, 120) }); return; }
    }
    const value = parseValue(m[3]);
    if (value === null) { errors.push({ line: idx + 1, text: raw.slice(0, 120) }); return; }
    const sample = { name: m[1], labels, value };
    samples.push(sample);
    fam(m[1]).samples.push(sample);
  });
  return { families, samples, errors };
}

/* ---------------- Lookup helpers ---------------- */

function getValue(parsed, name, labelMatch) {
  const f = parsed.families[name];
  if (!f) return null;
  for (const s of f.samples) {
    if (!labelMatch) return s.value;
    let ok = true;
    for (const k of Object.keys(labelMatch)) if (s.labels[k] !== labelMatch[k]) { ok = false; break; }
    if (ok) return s.value;
  }
  return null;
}

function sumBy(parsed, name, groupLabel) {
  const out = {};
  const f = parsed.families[name];
  if (!f) return out;
  for (const s of f.samples) {
    const key = groupLabel ? (s.labels[groupLabel] ?? "") : "";
    out[key] = (out[key] || 0) + s.value;
  }
  return out;
}

/* ---------------- Histogram latency ---------------- */

// buckets: [{ le: number (may be Infinity), count: cumulative }] sorted by le.
// Approximate quantile by linear interpolation inside the bucket where the
// rank falls (the standard Prometheus histogram_quantile approximation).
// Returns null when the rank falls in the +Inf bucket or data is unusable.
function approxQuantile(buckets, totalCount, q) {
  if (!buckets.length || !(totalCount > 0)) return null;
  const sorted = [...buckets].sort((a, b) => a.le - b.le);
  const rank = q * totalCount;
  let prevLe = 0, prevCount = 0;
  for (const b of sorted) {
    if (b.count >= rank) {
      if (!Number.isFinite(b.le)) return null;
      const bucketCount = b.count - prevCount;
      if (bucketCount <= 0) return b.le;
      const frac = (rank - prevCount) / bucketCount;
      return prevLe + (b.le - prevLe) * frac;
    }
    prevLe = b.le; prevCount = b.count;
  }
  return null;
}

function histogramStats(parsed, baseName, method) {
  const bucketFam = parsed.families[baseName + "_bucket"];
  if (!bucketFam) return null;
  const byMethod = {};
  for (const s of bucketFam.samples) {
    const meth = s.labels.method ?? "";
    if (method != null && meth !== method) continue;
    (byMethod[meth] = byMethod[meth] || []).push({ le: parseValue(s.labels.le), count: s.value });
  }
  const out = {};
  for (const meth of Object.keys(byMethod)) {
    const count = getValue(parsed, baseName + "_count", method != null || meth ? { method: meth } : null);
    const sum = getValue(parsed, baseName + "_sum", method != null || meth ? { method: meth } : null);
    const c = count == null ? (byMethod[meth].length ? Math.max(...byMethod[meth].map((b) => b.count)) : null) : count;
    out[meth] = {
      count: c,
      sum,
      mean: sum != null && c > 0 ? sum / c : null,
      p50: approxQuantile(byMethod[meth], c, 0.5),
      p95: approxQuantile(byMethod[meth], c, 0.95),
    };
  }
  return out;
}

/* ---------------- pearld summary ---------------- */

const CORE_METRICS = [
  "pearld_chain_tip_height",
  "pearld_p2p_peers",
  "pearld_mempool_transactions",
  "pearld_rpc_requests_total",
];

function summarize(parsed, nowSeconds) {
  const now = nowSeconds == null ? Date.now() / 1000 : nowSeconds;
  const g = (n, lm) => getValue(parsed, n, lm);
  const missing = CORE_METRICS.filter((n) => !parsed.families[n]);

  const infoFam = parsed.families["pearld_info"];
  const info = infoFam && infoFam.samples.length ? { ...infoFam.samples[0].labels } : null;

  const tipHeight = g("pearld_chain_tip_height");
  const tipTs = g("pearld_chain_tip_timestamp_seconds");
  const mempoolMax = g("pearld_mempool_max_bytes");
  const mempoolBytes = g("pearld_mempool_bytes");
  const mempoolUpdated = g("pearld_mempool_last_updated_timestamp_seconds");

  // RPC per-method table
  const rpc = {};
  const reqFam = parsed.families["pearld_rpc_requests_total"];
  if (reqFam) {
    for (const s of reqFam.samples) {
      const meth = s.labels.method ?? "(none)";
      const row = rpc[meth] || (rpc[meth] = { method: meth, success: 0, error: 0, total: 0 });
      if (s.labels.result === "error") row.error += s.value; else row.success += s.value;
      row.total += s.value;
    }
  }
  const latency = histogramStats(parsed, "pearld_rpc_request_duration_seconds", null) || {};
  for (const meth of Object.keys(rpc)) {
    const lat = latency[meth];
    rpc[meth].meanSeconds = lat ? lat.mean : null;
    rpc[meth].p95Seconds = lat ? lat.p95 : null;
    rpc[meth].errorRate = rpc[meth].total > 0 ? rpc[meth].error / rpc[meth].total : null;
  }
  const rpcTotals = Object.values(rpc).reduce(
    (a, r) => ({ total: a.total + r.total, error: a.error + r.error, success: a.success + r.success }),
    { total: 0, error: 0, success: 0 }
  );

  // Wire table by command
  const wire = {};
  const addWire = (famName, field) => {
    const f = parsed.families[famName];
    if (!f) return;
    for (const s of f.samples) {
      const cmd = s.labels.command ?? "(none)";
      const dir = s.labels.direction === "inbound" ? "in" : "out";
      const row = wire[cmd] || (wire[cmd] = { command: cmd, inMessages: 0, outMessages: 0, inBytes: 0, outBytes: 0 });
      row[field === "messages" ? (dir === "in" ? "inMessages" : "outMessages") : (dir === "in" ? "inBytes" : "outBytes")] += s.value;
    }
  };
  addWire("pearld_p2p_wire_messages_total", "messages");
  addWire("pearld_p2p_wire_bytes_total", "bytes");

  const rejected = sumBy(parsed, "pearld_p2p_peers_rejected_total", "reason");

  const summary = {
    isPearld: missing.length < CORE_METRICS.length,
    missing,
    info,
    seriesCount: parsed.samples.length,
    familyCount: Object.keys(parsed.families).filter((n) => parsed.families[n].samples.length).length,
    parseErrors: parsed.errors.length,
    chain: {
      tipHeight,
      tipTimestamp: tipTs,
      tipAgeSeconds: tipTs == null ? null : Math.max(0, now - tipTs),
      totalTransactions: g("pearld_chain_total_transactions"),
      isCurrent: g("pearld_chain_is_current"),
      blocksConnected: g("pearld_chain_blocks_connected_total"),
      blocksDisconnected: g("pearld_chain_blocks_disconnected_total"),
      blocksAccepted: g("pearld_chain_blocks_accepted_total"),
    },
    peers: {
      inbound: g("pearld_p2p_peers", { direction: "inbound" }),
      outbound: g("pearld_p2p_peers", { direction: "outbound" }),
      connectsInbound: g("pearld_p2p_peer_connects_total", { direction: "inbound" }),
      connectsOutbound: g("pearld_p2p_peer_connects_total", { direction: "outbound" }),
      disconnectsInbound: g("pearld_p2p_peer_disconnects_total", { direction: "inbound" }),
      disconnectsOutbound: g("pearld_p2p_peer_disconnects_total", { direction: "outbound" }),
      banned: g("pearld_p2p_peers_banned_total"),
      rejected,
      rejectedTotal: Object.values(rejected).reduce((a, b) => a + b, 0),
    },
    net: {
      recvTotal: g("pearld_net_totalbytes_recv_total"),
      sentTotal: g("pearld_net_totalbytes_sent_total"),
    },
    rpc: {
      byMethod: Object.values(rpc).sort((a, b) => b.total - a.total),
      totals: { ...rpcTotals, errorRate: rpcTotals.total > 0 ? rpcTotals.error / rpcTotals.total : null },
      authFailures: g("pearld_rpc_auth_failures_total"),
      websocketClients: g("pearld_rpc_websocket_clients"),
    },
    wire: Object.values(wire).sort((a, b) => (b.inBytes + b.outBytes) - (a.inBytes + a.outBytes)),
    mempool: {
      transactions: g("pearld_mempool_transactions"),
      bytes: mempoolBytes,
      maxBytes: mempoolMax,
      utilization: mempoolBytes != null && mempoolMax > 0 ? mempoolBytes / mempoolMax : null,
      lastUpdatedAgeSeconds: mempoolUpdated == null ? null : Math.max(0, now - mempoolUpdated),
    },
  };
  summary.health = healthNotes(summary);
  return summary;
}

// Heuristics only — labelled as such in the UI, never consensus facts.
// Pearl's block target is 194 s (upstream chaincfg), so a tip older than
// ~3 blocks (600 s) is worth a look and >1 h is a stall for a synced node.
function healthNotes(s) {
  const notes = [];
  if (!s.isPearld) {
    notes.push({ level: "error", text: "This does not look like a pearld /metrics scrape — none of the core pearld_* series (chain tip, peers, mempool, RPC) were found." });
    return notes;
  }
  if (s.missing.length) notes.push({ level: "warn", text: "Missing expected series: " + s.missing.join(", ") + ". The node may be running a different build than PR #310." });
  if (s.chain.isCurrent === 0) notes.push({ level: "warn", text: "pearld reports it is still syncing (pearld_chain_is_current = 0)." });
  if (s.chain.tipAgeSeconds != null && s.chain.isCurrent !== 0) {
    if (s.chain.tipAgeSeconds > 3600) notes.push({ level: "error", text: "Chain tip is over an hour old — the node looks stalled or partitioned." });
    else if (s.chain.tipAgeSeconds > 600) notes.push({ level: "warn", text: "Chain tip is more than ~3 blocks old (target 194 s/block) — check peer connectivity." });
  }
  const peerTotal = (s.peers.inbound || 0) + (s.peers.outbound || 0);
  if (peerTotal === 0) notes.push({ level: "error", text: "Zero connected peers — the node is isolated." });
  if (s.mempool.utilization != null && s.mempool.utilization >= 1) notes.push({ level: "error", text: "Mempool is at its configured size limit — new transactions may be evicted or rejected." });
  else if (s.mempool.utilization != null && s.mempool.utilization >= 0.9) notes.push({ level: "warn", text: "Mempool is over 90% of its configured size limit." });
  if (s.rpc.authFailures > 0) notes.push({ level: "warn", text: s.rpc.authFailures + " failed RPC authentication attempts — the RPC port may be receiving unwanted attention. pearld RPC should not be exposed beyond trusted hosts." });
  if (s.rpc.totals.errorRate != null && s.rpc.totals.total >= 20 && s.rpc.totals.errorRate > 0.05) notes.push({ level: "warn", text: "RPC error rate is " + (s.rpc.totals.errorRate * 100).toFixed(1) + "% over " + s.rpc.totals.total + " requests." });
  if (s.peers.banned > 0) notes.push({ level: "note", text: s.peers.banned + " peers banned for misbehavior since node start." });
  if (s.chain.blocksDisconnected > 0) notes.push({ level: "note", text: s.chain.blocksDisconnected + " blocks disconnected (reorgs) since node start." });
  if (!notes.length) notes.push({ level: "ok", text: "No heuristic warnings — tip is fresh, peers are connected, mempool has headroom." });
  return notes;
}

/* ---------------- Counter rates between two scrapes ---------------- */

// Given the flat samples of two scrapes and the seconds between them,
// return per-second rates for a chosen set of counter names (summed over
// all label sets). Counters that went backwards (node restart) yield null
// for that name instead of a negative rate.
function counterRates(prevSamples, currSamples, elapsedSeconds) {
  if (!(elapsedSeconds > 0)) return {};
  const sum = (samples, name) => {
    let v = null;
    for (const s of samples) if (s.name === name) v = (v || 0) + s.value;
    return v;
  };
  const names = new Set([...prevSamples, ...currSamples].map((s) => s.name));
  const out = {};
  for (const name of names) {
    const a = sum(prevSamples, name), b = sum(currSamples, name);
    if (a == null || b == null) continue;
    out[name] = b < a ? null : (b - a) / elapsedSeconds;
  }
  return out;
}

/* ---------------- Formatting ---------------- */

function fmtInt(v) {
  if (v == null || Number.isNaN(v)) return "—";
  return Math.round(v).toLocaleString("en-US");
}
function fmtBytes(v) {
  if (v == null || Number.isNaN(v)) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let x = v, u = 0;
  while (Math.abs(x) >= 1024 && u < units.length - 1) { x /= 1024; u++; }
  return (u === 0 ? Math.round(x) : x.toFixed(x >= 100 ? 0 : x >= 10 ? 1 : 2)) + " " + units[u];
}
function fmtAge(sec) {
  if (sec == null || Number.isNaN(sec)) return "—";
  if (sec < 90) return Math.round(sec) + "s ago";
  if (sec < 5400) return Math.round(sec / 60) + "m ago";
  if (sec < 172800) return (sec / 3600).toFixed(1) + "h ago";
  return (sec / 86400).toFixed(1) + "d ago";
}
function fmtSeconds(v) {
  if (v == null || Number.isNaN(v)) return "—";
  if (v < 0.001) return (v * 1e6).toFixed(0) + " µs";
  if (v < 1) return (v * 1000).toFixed(1) + " ms";
  return v.toFixed(2) + " s";
}
function fmtRate(v) {
  if (v == null || Number.isNaN(v)) return "—";
  return v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(1) : v.toFixed(3);
}

const api = {
  parseLabels, parseExposition, getValue, sumBy,
  approxQuantile, histogramStats, summarize, healthNotes, counterRates,
  fmtInt, fmtBytes, fmtAge, fmtSeconds, fmtRate, CORE_METRICS,
};
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.PearlMetrics = api;
