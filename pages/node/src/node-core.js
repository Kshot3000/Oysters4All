// Pearl Node — pearld operator console (read-only).
// node-core.js: pure, dependency-free logic. No cryptography, no network
// assumptions beyond a JSON-RPC endpoint. Every RPC method name and result
// field used here was verified against upstream node/docs/json_rpc_api.md
// (pearl-research-labs/pearl @ 3fe2267): getinfo, getmininginfo,
// getmempoolinfo, getpeerinfo, getnettotals, getchaintips.
//
// The page never sends state-changing RPCs. It only ever calls the six
// read-only methods above.

export const NETWORKS = {
  mainnet:  { label: "Mainnet",  rpcPort: 44107, p2pPort: 44108, hrp: "prl"  },
  testnet:  { label: "Testnet",  rpcPort: 44109, p2pPort: 44110, hrp: "tprl" },
  testnet2: { label: "Testnet2", rpcPort: 44111, p2pPort: 44112, hrp: "tprl" },
};

// Default relay endpoint: browsers cannot call pearld directly (no CORS
// headers, TLS with a self-signed cert by default), so the page talks to the
// tiny zero-dependency relay.mjs shipped beside it.
export const DEFAULT_ENDPOINT = "http://127.0.0.1:44120/rpc";

export function defaultSettings() {
  return {
    endpoint: DEFAULT_ENDPOINT,
    user: "",
    pass: "",
    network: "mainnet",
    pollSec: 30,
  };
}

// ---------------------------------------------------------------- settings

export function validateSettings(s) {
  const errors = [];
  if (!s || typeof s !== "object") return { ok: false, errors: ["settings missing"] };
  const ep = String(s.endpoint || "").trim();
  if (!ep) {
    errors.push("RPC endpoint is required.");
  } else {
    let u;
    try {
      u = new URL(ep);
    } catch {
      u = null;
    }
    if (!u || (u.protocol !== "http:" && u.protocol !== "https:")) {
      errors.push("Endpoint must be an http(s) URL, e.g. http://127.0.0.1:44120/rpc");
    }
  }
  if (s.network && !NETWORKS[s.network]) errors.push(`Unknown network "${s.network}".`);
  const poll = Number(s.pollSec);
  if (!Number.isFinite(poll) || poll < 0 || poll > 3600) {
    errors.push("Poll interval must be 0 (off) to 3600 seconds.");
  } else if (poll > 0 && poll < 5) {
    errors.push("Poll interval below 5 s hammers your node — use 5 s or more.");
  }
  return { ok: errors.length === 0, errors };
}

export function basicAuthHeader(user, pass) {
  if (!user) return null;
  // btoa is available in browsers and Node 16+.
  return "Basic " + btoa(`${user}:${pass || ""}`);
}

// ------------------------------------------------------------------- RPC

// Single JSON-RPC call. fetchImpl is injectable for tests.
// Returns {ok:true, result} or {ok:false, kind, message} where kind is one of
// "network" | "http" | "auth" | "badjson" | "rpc".
export async function rpcCall(fetchImpl, endpoint, method, params = [], authHeader = null) {
  const body = JSON.stringify({ jsonrpc: "1.0", id: "pearl-node", method, params });
  let res;
  try {
    res = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authHeader ? { Authorization: authHeader } : {}),
      },
      body,
    });
  } catch (e) {
    return { ok: false, kind: "network", message: `Could not reach ${endpoint}: ${e && e.message ? e.message : e}` };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, kind: "auth", message: `HTTP ${res.status} — RPC credentials rejected. Set rpcuser/rpcpass (or rpclimituser) on pearld and enter them in Settings.` };
  }
  if (!res.ok) {
    return { ok: false, kind: "http", message: `HTTP ${res.status} from ${endpoint}` };
  }
  let json;
  try {
    json = await res.json();
  } catch {
    return { ok: false, kind: "badjson", message: "Endpoint did not return JSON — is this a pearld JSON-RPC relay?" };
  }
  if (json && json.error) {
    const code = json.error.code !== undefined ? ` (code ${json.error.code})` : "";
    return { ok: false, kind: "rpc", message: `pearld error${code}: ${json.error.message || "unknown"}` };
  }
  return { ok: true, result: json ? json.result : undefined };
}

// The six read-only methods the console ever calls.
export const READ_METHODS = [
  "getinfo",
  "getmininginfo",
  "getmempoolinfo",
  "getpeerinfo",
  "getnettotals",
  "getchaintips",
];

// ---------------------------------------------------------------- formatters

export function fmtInt(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return "—";
  return Number(n).toLocaleString("en-US");
}

export function fmtBytes(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return "—";
  const v = Number(n);
  if (v < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let x = v, u = 0;
  while (x >= 1024 && u < units.length - 1) { x /= 1024; u++; }
  return `${x >= 100 ? Math.round(x) : x.toFixed(x >= 10 ? 1 : 2)} ${units[u]}`;
}

export function fmtHashrate(hps) {
  if (hps === null || hps === undefined || !Number.isFinite(Number(hps))) return "—";
  const v = Number(hps);
  if (v < 0) return "—";
  const units = ["H/s", "kH/s", "MH/s", "GH/s", "TH/s", "PH/s", "EH/s"];
  let x = v, u = 0;
  while (x >= 1000 && u < units.length - 1) { x /= 1000; u++; }
  return `${x >= 100 ? x.toFixed(1) : x.toFixed(2)} ${units[u]}`;
}

// pingtime from getpeerinfo is microseconds.
export function fmtPingUs(us) {
  if (us === null || us === undefined || !Number.isFinite(Number(us))) return "—";
  const ms = Number(us) / 1000;
  return ms >= 100 ? `${Math.round(ms)} ms` : `${ms.toFixed(1)} ms`;
}

export function fmtAgeSec(s) {
  if (s === null || s === undefined || !Number.isFinite(Number(s))) return "—";
  const v = Math.max(0, Math.floor(Number(s)));
  if (v < 60) return `${v}s`;
  const m = Math.floor(v / 60);
  if (m < 60) return `${m}m ${v % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function fmtUnixSec(sec) {
  if (sec === null || sec === undefined || !Number.isFinite(Number(sec)) || sec <= 0) return "—";
  return new Date(Number(sec) * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

// Escape untrusted strings (peer user-agents) before innerHTML.
export function escHtml(s) {
  return String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

// ------------------------------------------------------------------- peers

export function normalizePeer(p, nowSec) {
  const row = p && typeof p === "object" ? p : {};
  const lastRecv = Number(row.lastrecv) || 0;
  const connTime = Number(row.conntime) || 0;
  const pingUs = row.pingtime === undefined || row.pingtime === null ? null : Number(row.pingtime);
  return {
    addr: String(row.addr || "—"),
    subver: String(row.subver || "—"),
    services: String(row.services || "—"),
    pingUs: Number.isFinite(pingUs) ? pingUs : null,
    inbound: row.inbound === true,
    syncNode: row.syncnode === true,
    startHeight: Number.isFinite(Number(row.startingheight)) ? Number(row.startingheight) : null,
    curHeight: Number.isFinite(Number(row.currentheight)) ? Number(row.currentheight) : null,
    bytesSent: Number.isFinite(Number(row.bytessent)) ? Number(row.bytessent) : 0,
    bytesRecv: Number.isFinite(Number(row.bytesrecv)) ? Number(row.bytesrecv) : 0,
    connAgeSec: connTime > 0 ? Math.max(0, nowSec - connTime) : null,
    stale: lastRecv > 0 ? nowSec - lastRecv > 600 : null,
    version: Number.isFinite(Number(row.version)) ? Number(row.version) : null,
  };
}

export function sortPeers(rows, key = "ping", dir = 1) {
  const val = {
    ping: (r) => (r.pingUs === null ? Infinity : r.pingUs),
    age: (r) => (r.connAgeSec === null ? -1 : r.connAgeSec),
    sent: (r) => r.bytesSent,
    recv: (r) => r.bytesRecv,
    height: (r) => (r.curHeight === null ? -1 : r.curHeight),
    addr: (r) => r.addr,
  }[key] || ((r) => (r.pingUs === null ? Infinity : r.pingUs));
  return [...rows].sort((a, b) => {
    const x = val(a), y = val(b);
    if (x < y) return -dir;
    if (x > y) return dir;
    return 0;
  });
}

// ------------------------------------------------------------------- health

// Pure health classification over the six RPC results. notes is an array of
// {tone:"ok"|"warn"|"error"|"info", text}.
export function nodeHealth({ info, mining, mempool, peerRows, tips }) {
  const notes = [];
  let level = "ok";
  const bump = (to) => {
    if (to === "error") level = "error";
    else if (to === "warn" && level === "ok") level = "warn";
  };

  if (mining && typeof mining.errors === "string" && mining.errors.trim()) {
    bump("error");
    notes.push({ tone: "error", text: `Node reports an error: ${mining.errors.trim()}` });
  }
  const conns = info ? Number(info.connections) : NaN;
  if (Number.isFinite(conns)) {
    if (conns === 0) {
      bump("warn");
      notes.push({ tone: "warn", text: "Zero peer connections — the node is isolated. Check P2P port 44108 and addnode/connect peers." });
    } else {
      notes.push({ tone: "ok", text: `${conns} peer connection${conns === 1 ? "" : "s"} active.` });
    }
  }
  if (info && info.testnet === true) {
    notes.push({ tone: "info", text: "Chain is testnet (getinfo testnet=true) — values are play money." });
  }
  const offset = info ? Number(info.timeoffset) : NaN;
  if (Number.isFinite(offset) && Math.abs(offset) > 300) {
    bump("warn");
    notes.push({ tone: "warn", text: `Median clock offset ${offset}s vs peers — check NTP; large offsets can stall sync.` });
  }
  if (Array.isArray(tips)) {
    const forks = tips.filter((t) => t && t.status && t.status !== "active");
    if (forks.length > 0) {
      bump("warn");
      notes.push({ tone: "warn", text: `${forks.length} non-active chain tip${forks.length === 1 ? "" : "s"} visible (${forks.map((t) => t.status).join(", ")}) — a fork or stale branch exists.` });
    } else {
      notes.push({ tone: "ok", text: "Single active chain tip — no forks visible." });
    }
  }
  if (mempool && Number.isFinite(Number(mempool.size))) {
    const sz = Number(mempool.size);
    if (sz > 5000) {
      bump("warn");
      notes.push({ tone: "warn", text: `Mempool holds ${fmtInt(sz)} transactions — unusually deep; fee pressure may be high.` });
    }
  }
  if (Array.isArray(peerRows)) {
    const stale = peerRows.filter((r) => r.stale === true).length;
    if (stale > 0 && peerRows.length > 0) {
      bump("warn");
      notes.push({ tone: "warn", text: `${stale} of ${peerRows.length} peers silent for >10 min — consider disconnecting dead peers.` });
    }
    const syncs = peerRows.filter((r) => r.syncNode);
    if (peerRows.length > 0 && syncs.length === 0) {
      notes.push({ tone: "info", text: "No peer is flagged as the sync node." });
    }
  }
  if (notes.length === 0) {
    notes.push({ tone: "info", text: "Not enough data to classify health — connect the node first." });
  }
  return { level, notes };
}

export function mempoolStats(mempool, mining) {
  const size = mempool && Number.isFinite(Number(mempool.size)) ? Number(mempool.size) : null;
  const bytes = mempool && Number.isFinite(Number(mempool.bytes)) ? Number(mempool.bytes) : null;
  const pooledtx = mining && Number.isFinite(Number(mining.pooledtx)) ? Number(mining.pooledtx) : null;
  return {
    size,
    bytes,
    avgTxBytes: size && size > 0 && bytes !== null ? Math.round(bytes / size) : null,
    pooledtx,
    poolMatch: size !== null && pooledtx !== null ? size === pooledtx : null,
  };
}

// Overview cards: label/value/sub/tone. Pure function of RPC results.
export function overviewCards({ info, mining, mempool, nettotals, tips }) {
  const cards = [];
  const blocks = info && Number.isFinite(Number(info.blocks)) ? Number(info.blocks) : null;
  cards.push({
    label: "Block height",
    value: blocks === null ? "—" : fmtInt(blocks),
    sub: info && info.testnet ? "testnet chain" : "mainnet chain",
    tone: "ok",
  });
  const diff = info && info.difficulty !== undefined && info.difficulty !== null ? Number(info.difficulty) : NaN;
  cards.push({
    label: "Difficulty",
    value: Number.isFinite(diff) ? diff.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "—",
    sub: "current target difficulty",
    tone: "ok",
  });
  const hps = mining && Number.isFinite(Number(mining.networkhashps)) ? Number(mining.networkhashps) : null;
  cards.push({
    label: "Network hashrate",
    value: fmtHashrate(hps),
    sub: "estimated over recent blocks",
    tone: "ok",
  });
  const conns = info && Number.isFinite(Number(info.connections)) ? Number(info.connections) : null;
  cards.push({
    label: "Peers",
    value: conns === null ? "—" : fmtInt(conns),
    sub: conns === 0 ? "isolated — check P2P" : "connected",
    tone: conns === 0 ? "warn" : "ok",
  });
  const msize = mempool && Number.isFinite(Number(mempool.size)) ? Number(mempool.size) : null;
  cards.push({
    label: "Mempool",
    value: msize === null ? "—" : `${fmtInt(msize)} tx`,
    sub: mempool ? fmtBytes(mempool.bytes) : "—",
    tone: "ok",
  });
  const ver = info && info.version !== undefined ? String(info.version) : "—";
  const proto = info && info.protocolversion !== undefined ? `proto ${info.protocolversion}` : "";
  cards.push({
    label: "pearld version",
    value: ver,
    sub: proto || "node version",
    tone: "ok",
  });
  if (nettotals) {
    cards.push({
      label: "Bandwidth",
      value: `↓ ${fmtBytes(nettotals.totalbytesrecv)}`,
      sub: `↑ ${fmtBytes(nettotals.totalbytessent)} lifetime`,
      tone: "ok",
    });
  }
  const activeTip = Array.isArray(tips) ? tips.find((t) => t && t.status === "active") : null;
  cards.push({
    label: "Best block",
    value: activeTip && activeTip.hash ? `${String(activeTip.hash).slice(0, 16)}…` : "—",
    sub: activeTip ? `height ${fmtInt(activeTip.height)}` : "tip hash",
    tone: "ok",
  });
  return cards;
}

// Detect which network the node claims to be on (getinfo.testnet) vs the
// network selected in settings — surfaces a mismatch loudly.
export function networkMismatch(settingsNetwork, info) {
  if (!info || info.testnet === undefined) return null;
  const onTestnet = info.testnet === true;
  if (onTestnet && settingsNetwork === "mainnet") {
    return "Settings say mainnet but the node reports testnet=true — switch the network preset in Settings.";
  }
  if (!onTestnet && settingsNetwork !== "mainnet") {
    return `Settings say ${settingsNetwork} but the node reports a mainnet chain — switch the network preset in Settings.`;
  }
  return null;
}
