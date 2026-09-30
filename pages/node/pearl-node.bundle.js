/* Pearl Node bundle (window.PearlNode) — built with esbuild from src/index.js. Do not edit by hand; run `node build.mjs`. */
var PearlNode = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/index.js
  var index_exports = {};
  __export(index_exports, {
    DEFAULT_ENDPOINT: () => DEFAULT_ENDPOINT,
    NETWORKS: () => NETWORKS,
    READ_METHODS: () => READ_METHODS,
    basicAuthHeader: () => basicAuthHeader,
    defaultSettings: () => defaultSettings,
    escHtml: () => escHtml,
    fmtAgeSec: () => fmtAgeSec,
    fmtBytes: () => fmtBytes,
    fmtHashrate: () => fmtHashrate,
    fmtInt: () => fmtInt,
    fmtPingUs: () => fmtPingUs,
    fmtUnixSec: () => fmtUnixSec,
    mempoolStats: () => mempoolStats,
    networkMismatch: () => networkMismatch,
    nodeHealth: () => nodeHealth,
    normalizePeer: () => normalizePeer,
    overviewCards: () => overviewCards,
    rpcCall: () => rpcCall,
    sortPeers: () => sortPeers,
    validateSettings: () => validateSettings
  });

  // src/node-core.js
  var NETWORKS = {
    mainnet: { label: "Mainnet", rpcPort: 44107, p2pPort: 44108, hrp: "prl" },
    testnet: { label: "Testnet", rpcPort: 44109, p2pPort: 44110, hrp: "tprl" },
    testnet2: { label: "Testnet2", rpcPort: 44111, p2pPort: 44112, hrp: "tprl" }
  };
  var DEFAULT_ENDPOINT = "http://127.0.0.1:44120/rpc";
  function defaultSettings() {
    return {
      endpoint: DEFAULT_ENDPOINT,
      user: "",
      pass: "",
      network: "mainnet",
      pollSec: 30
    };
  }
  function validateSettings(s) {
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
      if (!u || u.protocol !== "http:" && u.protocol !== "https:") {
        errors.push("Endpoint must be an http(s) URL, e.g. http://127.0.0.1:44120/rpc");
      }
    }
    if (s.network && !NETWORKS[s.network]) errors.push(`Unknown network "${s.network}".`);
    const poll = Number(s.pollSec);
    if (!Number.isFinite(poll) || poll < 0 || poll > 3600) {
      errors.push("Poll interval must be 0 (off) to 3600 seconds.");
    } else if (poll > 0 && poll < 5) {
      errors.push("Poll interval below 5 s hammers your node \u2014 use 5 s or more.");
    }
    return { ok: errors.length === 0, errors };
  }
  function basicAuthHeader(user, pass) {
    if (!user) return null;
    return "Basic " + btoa(`${user}:${pass || ""}`);
  }
  async function rpcCall(fetchImpl, endpoint, method, params = [], authHeader = null) {
    const body = JSON.stringify({ jsonrpc: "1.0", id: "pearl-node", method, params });
    let res;
    try {
      res = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeader ? { Authorization: authHeader } : {}
        },
        body
      });
    } catch (e) {
      return { ok: false, kind: "network", message: `Could not reach ${endpoint}: ${e && e.message ? e.message : e}` };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, kind: "auth", message: `HTTP ${res.status} \u2014 RPC credentials rejected. Set rpcuser/rpcpass (or rpclimituser) on pearld and enter them in Settings.` };
    }
    if (!res.ok) {
      return { ok: false, kind: "http", message: `HTTP ${res.status} from ${endpoint}` };
    }
    let json;
    try {
      json = await res.json();
    } catch {
      return { ok: false, kind: "badjson", message: "Endpoint did not return JSON \u2014 is this a pearld JSON-RPC relay?" };
    }
    if (json && json.error) {
      const code = json.error.code !== void 0 ? ` (code ${json.error.code})` : "";
      return { ok: false, kind: "rpc", message: `pearld error${code}: ${json.error.message || "unknown"}` };
    }
    return { ok: true, result: json ? json.result : void 0 };
  }
  var READ_METHODS = [
    "getinfo",
    "getmininginfo",
    "getmempoolinfo",
    "getpeerinfo",
    "getnettotals",
    "getchaintips"
  ];
  function fmtInt(n) {
    if (n === null || n === void 0 || !Number.isFinite(Number(n))) return "\u2014";
    return Number(n).toLocaleString("en-US");
  }
  function fmtBytes(n) {
    if (n === null || n === void 0 || !Number.isFinite(Number(n))) return "\u2014";
    const v = Number(n);
    if (v < 0) return "\u2014";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let x = v, u = 0;
    while (x >= 1024 && u < units.length - 1) {
      x /= 1024;
      u++;
    }
    return `${x >= 100 ? Math.round(x) : x.toFixed(x >= 10 ? 1 : 2)} ${units[u]}`;
  }
  function fmtHashrate(hps) {
    if (hps === null || hps === void 0 || !Number.isFinite(Number(hps))) return "\u2014";
    const v = Number(hps);
    if (v < 0) return "\u2014";
    const units = ["H/s", "kH/s", "MH/s", "GH/s", "TH/s", "PH/s", "EH/s"];
    let x = v, u = 0;
    while (x >= 1e3 && u < units.length - 1) {
      x /= 1e3;
      u++;
    }
    return `${x >= 100 ? x.toFixed(1) : x.toFixed(2)} ${units[u]}`;
  }
  function fmtPingUs(us) {
    if (us === null || us === void 0 || !Number.isFinite(Number(us))) return "\u2014";
    const ms = Number(us) / 1e3;
    return ms >= 100 ? `${Math.round(ms)} ms` : `${ms.toFixed(1)} ms`;
  }
  function fmtAgeSec(s) {
    if (s === null || s === void 0 || !Number.isFinite(Number(s))) return "\u2014";
    const v = Math.max(0, Math.floor(Number(s)));
    if (v < 60) return `${v}s`;
    const m = Math.floor(v / 60);
    if (m < 60) return `${m}m ${v % 60}s`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ${m % 60}m`;
    return `${Math.floor(h / 24)}d ${h % 24}h`;
  }
  function fmtUnixSec(sec) {
    if (sec === null || sec === void 0 || !Number.isFinite(Number(sec)) || sec <= 0) return "\u2014";
    return new Date(Number(sec) * 1e3).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
  }
  function escHtml(s) {
    return String(s === null || s === void 0 ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[c]);
  }
  function normalizePeer(p, nowSec) {
    const row = p && typeof p === "object" ? p : {};
    const lastRecv = Number(row.lastrecv) || 0;
    const connTime = Number(row.conntime) || 0;
    const pingUs = row.pingtime === void 0 || row.pingtime === null ? null : Number(row.pingtime);
    return {
      addr: String(row.addr || "\u2014"),
      subver: String(row.subver || "\u2014"),
      services: String(row.services || "\u2014"),
      pingUs: Number.isFinite(pingUs) ? pingUs : null,
      inbound: row.inbound === true,
      syncNode: row.syncnode === true,
      startHeight: Number.isFinite(Number(row.startingheight)) ? Number(row.startingheight) : null,
      curHeight: Number.isFinite(Number(row.currentheight)) ? Number(row.currentheight) : null,
      bytesSent: Number.isFinite(Number(row.bytessent)) ? Number(row.bytessent) : 0,
      bytesRecv: Number.isFinite(Number(row.bytesrecv)) ? Number(row.bytesrecv) : 0,
      connAgeSec: connTime > 0 ? Math.max(0, nowSec - connTime) : null,
      stale: lastRecv > 0 ? nowSec - lastRecv > 600 : null,
      version: Number.isFinite(Number(row.version)) ? Number(row.version) : null
    };
  }
  function sortPeers(rows, key = "ping", dir = 1) {
    const val = {
      ping: (r) => r.pingUs === null ? Infinity : r.pingUs,
      age: (r) => r.connAgeSec === null ? -1 : r.connAgeSec,
      sent: (r) => r.bytesSent,
      recv: (r) => r.bytesRecv,
      height: (r) => r.curHeight === null ? -1 : r.curHeight,
      addr: (r) => r.addr
    }[key] || ((r) => r.pingUs === null ? Infinity : r.pingUs);
    return [...rows].sort((a, b) => {
      const x = val(a), y = val(b);
      if (x < y) return -dir;
      if (x > y) return dir;
      return 0;
    });
  }
  function nodeHealth({ info, mining, mempool, peerRows, tips }) {
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
        notes.push({ tone: "warn", text: "Zero peer connections \u2014 the node is isolated. Check P2P port 44108 and addnode/connect peers." });
      } else {
        notes.push({ tone: "ok", text: `${conns} peer connection${conns === 1 ? "" : "s"} active.` });
      }
    }
    if (info && info.testnet === true) {
      notes.push({ tone: "info", text: "Chain is testnet (getinfo testnet=true) \u2014 values are play money." });
    }
    const offset = info ? Number(info.timeoffset) : NaN;
    if (Number.isFinite(offset) && Math.abs(offset) > 300) {
      bump("warn");
      notes.push({ tone: "warn", text: `Median clock offset ${offset}s vs peers \u2014 check NTP; large offsets can stall sync.` });
    }
    if (Array.isArray(tips)) {
      const forks = tips.filter((t) => t && t.status && t.status !== "active");
      if (forks.length > 0) {
        bump("warn");
        notes.push({ tone: "warn", text: `${forks.length} non-active chain tip${forks.length === 1 ? "" : "s"} visible (${forks.map((t) => t.status).join(", ")}) \u2014 a fork or stale branch exists.` });
      } else {
        notes.push({ tone: "ok", text: "Single active chain tip \u2014 no forks visible." });
      }
    }
    if (mempool && Number.isFinite(Number(mempool.size))) {
      const sz = Number(mempool.size);
      if (sz > 5e3) {
        bump("warn");
        notes.push({ tone: "warn", text: `Mempool holds ${fmtInt(sz)} transactions \u2014 unusually deep; fee pressure may be high.` });
      }
    }
    if (Array.isArray(peerRows)) {
      const stale = peerRows.filter((r) => r.stale === true).length;
      if (stale > 0 && peerRows.length > 0) {
        bump("warn");
        notes.push({ tone: "warn", text: `${stale} of ${peerRows.length} peers silent for >10 min \u2014 consider disconnecting dead peers.` });
      }
      const syncs = peerRows.filter((r) => r.syncNode);
      if (peerRows.length > 0 && syncs.length === 0) {
        notes.push({ tone: "info", text: "No peer is flagged as the sync node." });
      }
    }
    if (notes.length === 0) {
      notes.push({ tone: "info", text: "Not enough data to classify health \u2014 connect the node first." });
    }
    return { level, notes };
  }
  function mempoolStats(mempool, mining) {
    const size = mempool && Number.isFinite(Number(mempool.size)) ? Number(mempool.size) : null;
    const bytes = mempool && Number.isFinite(Number(mempool.bytes)) ? Number(mempool.bytes) : null;
    const pooledtx = mining && Number.isFinite(Number(mining.pooledtx)) ? Number(mining.pooledtx) : null;
    return {
      size,
      bytes,
      avgTxBytes: size && size > 0 && bytes !== null ? Math.round(bytes / size) : null,
      pooledtx,
      poolMatch: size !== null && pooledtx !== null ? size === pooledtx : null
    };
  }
  function overviewCards({ info, mining, mempool, nettotals, tips }) {
    const cards = [];
    const blocks = info && Number.isFinite(Number(info.blocks)) ? Number(info.blocks) : null;
    cards.push({
      label: "Block height",
      value: blocks === null ? "\u2014" : fmtInt(blocks),
      sub: info && info.testnet ? "testnet chain" : "mainnet chain",
      tone: "ok"
    });
    const diff = info && info.difficulty !== void 0 && info.difficulty !== null ? Number(info.difficulty) : NaN;
    cards.push({
      label: "Difficulty",
      value: Number.isFinite(diff) ? diff.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "\u2014",
      sub: "current target difficulty",
      tone: "ok"
    });
    const hps = mining && Number.isFinite(Number(mining.networkhashps)) ? Number(mining.networkhashps) : null;
    cards.push({
      label: "Network hashrate",
      value: fmtHashrate(hps),
      sub: "estimated over recent blocks",
      tone: "ok"
    });
    const conns = info && Number.isFinite(Number(info.connections)) ? Number(info.connections) : null;
    cards.push({
      label: "Peers",
      value: conns === null ? "\u2014" : fmtInt(conns),
      sub: conns === 0 ? "isolated \u2014 check P2P" : "connected",
      tone: conns === 0 ? "warn" : "ok"
    });
    const msize = mempool && Number.isFinite(Number(mempool.size)) ? Number(mempool.size) : null;
    cards.push({
      label: "Mempool",
      value: msize === null ? "\u2014" : `${fmtInt(msize)} tx`,
      sub: mempool ? fmtBytes(mempool.bytes) : "\u2014",
      tone: "ok"
    });
    const ver = info && info.version !== void 0 ? String(info.version) : "\u2014";
    const proto = info && info.protocolversion !== void 0 ? `proto ${info.protocolversion}` : "";
    cards.push({
      label: "pearld version",
      value: ver,
      sub: proto || "node version",
      tone: "ok"
    });
    if (nettotals) {
      cards.push({
        label: "Bandwidth",
        value: `\u2193 ${fmtBytes(nettotals.totalbytesrecv)}`,
        sub: `\u2191 ${fmtBytes(nettotals.totalbytessent)} lifetime`,
        tone: "ok"
      });
    }
    const activeTip = Array.isArray(tips) ? tips.find((t) => t && t.status === "active") : null;
    cards.push({
      label: "Best block",
      value: activeTip && activeTip.hash ? `${String(activeTip.hash).slice(0, 16)}\u2026` : "\u2014",
      sub: activeTip ? `height ${fmtInt(activeTip.height)}` : "tip hash",
      tone: "ok"
    });
    return cards;
  }
  function networkMismatch(settingsNetwork, info) {
    if (!info || info.testnet === void 0) return null;
    const onTestnet = info.testnet === true;
    if (onTestnet && settingsNetwork === "mainnet") {
      return "Settings say mainnet but the node reports testnet=true \u2014 switch the network preset in Settings.";
    }
    if (!onTestnet && settingsNetwork !== "mainnet") {
      return `Settings say ${settingsNetwork} but the node reports a mainnet chain \u2014 switch the network preset in Settings.`;
    }
    return null;
  }
  return __toCommonJS(index_exports);
})();
