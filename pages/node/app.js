/* Pearl Node — DOM application.
 * Read-only pearld operator console. Uses window.PearlNode (the esbuild
 * bundle of src/node-core.js) for all logic; this file only touches the DOM.
 * Never sends state-changing RPCs. fetch is the only network surface, and the
 * six read-only methods are enumerated in PearlNode.READ_METHODS.
 */
(function () {
  "use strict";
  const N = window.PearlNode;
  if (!N) throw new Error("PearlNode bundle missing");

  const $ = (id) => document.getElementById(id);
  const LS_KEY = "pearl-node-settings";

  const state = {
    settings: N.defaultSettings(),
    data: null,          // last successful full snapshot {info, mining, mempool, peers, nettotals, tips}
    lastOk: 0,
    pollTimer: null,
    peerSort: { key: "ping", dir: 1 },
    conn: "idle",        // idle | ok | warn | error
  };

  // ------------------------------------------------------------ settings

  function loadSettings() {
    try {
      const raw = window.localStorage.getItem(LS_KEY);
      if (!raw) return N.defaultSettings();
      const parsed = JSON.parse(raw);
      const merged = Object.assign(N.defaultSettings(), parsed);
      return merged;
    } catch {
      return N.defaultSettings();
    }
  }

  function persistSettings() {
    try {
      window.localStorage.setItem(LS_KEY, JSON.stringify(state.settings));
    } catch { /* storage may be unavailable; settings still work in memory */ }
  }

  function clearSaved() {
    try { window.localStorage.removeItem(LS_KEY); } catch {}
    state.settings = N.defaultSettings();
    renderSettingsForm();
    setConn("idle", "settings cleared — not connected");
  }

  function renderSettingsForm() {
    const s = state.settings;
    $("set-endpoint").value = s.endpoint || "";
    $("set-user").value = s.user || "";
    $("set-pass").value = s.pass || "";
    $("set-network").value = s.network || "mainnet";
    $("set-poll").value = String(s.pollSec);
  }

  function readSettingsForm() {
    return {
      endpoint: $("set-endpoint").value.trim(),
      user: $("set-user").value.trim(),
      pass: $("set-pass").value,
      network: $("set-network").value,
      pollSec: Number($("set-poll").value),
    };
  }

  function applyNetworkPreset(net) {
    const info = N.NETWORKS[net];
    if (!info) return;
    state.settings.network = net;
    // Point at the conventional local relay; the pearld port itself is shown
    // as a hint, because browsers must go through relay.mjs.
    $("set-network").value = net;
    setMsg(`Network preset: ${info.label} (pearld RPC :${info.rpcPort} — via your relay)`);
  }

  function setMsg(t) { $("set-msg").textContent = t || ""; $("set-err").textContent = ""; }
  function setErr(t) { $("set-err").textContent = t || ""; $("set-msg").textContent = ""; }

  function schedulePoll() {
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
    const s = Number(state.settings.pollSec);
    if (s > 0 && state.conn === "ok") {
      state.pollTimer = setInterval(() => { refresh(true); }, s * 1000);
    }
  }

  // ---------------------------------------------------------------- tabs

  function selectTab(name) {
    document.querySelectorAll("#steps button").forEach((b) => {
      b.classList.toggle("active", b.getAttribute("data-tab") === name);
    });
    ["overview", "peers", "mempool", "mining", "settings"].forEach((t) => {
      $("tab-" + t).classList.toggle("active", t === name);
    });
  }

  // -------------------------------------------------------------- conn UI

  function setConn(kind, label) {
    state.conn = kind;
    const lamp = $("conn-lamp");
    lamp.className = "lamp" + (kind === "idle" ? "" : " " + kind);
    $("conn-label").innerHTML = label;
    schedulePoll();
  }

  // -------------------------------------------------------------- refresh

  async function refresh(quiet) {
    const v = N.validateSettings(state.settings);
    if (!v.ok) {
      setConn("error", "invalid settings — see Settings");
      if (!quiet) { selectTab("settings"); setErr(v.errors.join(" ")); }
      return { ok: false, errors: v.errors };
    }
    const auth = N.basicAuthHeader(state.settings.user, state.settings.pass);
    const ep = state.settings.endpoint;
    if (!quiet) setConn("idle", "contacting node…");

    const calls = {};
    await Promise.all(N.READ_METHODS.map(async (m) => {
      calls[m] = await N.rpcCall(window.fetch.bind(window), ep, m, [], auth);
    }));

    const failed = N.READ_METHODS.map((m) => [m, calls[m]]).filter(([, r]) => !r.ok);
    if (failed.length > 0) {
      const kinds = [...new Set(failed.map(([, r]) => r.kind))];
      const first = failed[0][1];
      const detail = failed.map(([m, r]) => `${m}: ${r.message}`).join("\n");
      setConn("error", `<b>node unreachable</b> — ${N.escHtml(first.message)}`);
      state.data = null;
      renderEmpty(detail, kinds);
      return { ok: false, kind: first.kind, detail };
    }

    const data = {
      info: calls.getinfo.result,
      mining: calls.getmininginfo.result,
      mempool: calls.getmempoolinfo.result,
      peers: calls.getpeerinfo.result,
      nettotals: calls.getnettotals.result,
      tips: calls.getchaintips.result,
    };
    state.data = data;
    state.lastOk = Date.now();
    renderAll(data);
    const health = N.nodeHealth({
      info: data.info,
      mining: data.mining,
      mempool: data.mempool,
      peerRows: Array.isArray(data.peers) ? data.peers.map((p) => N.normalizePeer(p, Date.now() / 1000)) : [],
      tips: data.tips,
    });
    setConn(health.level === "ok" ? "ok" : health.level,
      `<b>connected</b> — ${N.escHtml(ep)} · updated ${new Date(state.lastOk).toLocaleTimeString()}`);
    schedulePoll();
    return { ok: true, health: health.level };
  }

  function renderEmpty(detail, kinds) {
    $("overview-empty").style.display = "";
    $("overview-live").style.display = "none";
    const relayHint = kinds.includes("network")
      ? "\n\nIs relay.mjs running on the node machine? The page cannot reach pearld directly (no CORS / self-signed TLS) — start the relay and retry."
      : "";
    $("overview-empty").innerHTML =
      `<b>Could not read the node.</b><br><span class="mono">${N.escHtml(detail)}${N.escHtml(relayHint)}</span>`;
    $("peers-summary").textContent = "No data — the last refresh failed.";
    $("peers-table").style.display = "none";
    $("mempool-cards").innerHTML = "";
    $("mempool-note").textContent = "";
    $("mining-cards").innerHTML = "";
    $("mining-errors").textContent = "";
  }

  // ------------------------------------------------------------- renderers

  function renderAll(data) {
    $("overview-empty").style.display = "none";
    $("overview-live").style.display = "";
    renderOverview(data);
    renderPeers(data.peers);
    renderMempool(data);
    renderMining(data);
  }

  function renderOverview(data) {
    const mismatch = N.networkMismatch(state.settings.network, data.info);
    const mw = $("mismatch-warn");
    if (mismatch) { mw.textContent = "⚠ " + mismatch; mw.style.display = ""; }
    else { mw.style.display = "none"; }

    const peerRows = Array.isArray(data.peers)
      ? data.peers.map((p) => N.normalizePeer(p, Date.now() / 1000)) : [];
    const health = N.nodeHealth({
      info: data.info, mining: data.mining, mempool: data.mempool,
      peerRows, tips: data.tips,
    });
    $("health-notes").innerHTML = health.notes.map((n) =>
      `<li class="${n.tone}">${N.escHtml(n.text)}</li>`).join("");

    $("overview-cards").innerHTML = N.overviewCards({
      info: data.info, mining: data.mining, mempool: data.mempool,
      nettotals: data.nettotals, tips: data.tips,
    }).map((c) => `<div class="card ${c.tone === "ok" ? "" : c.tone}">` +
      `<div class="lbl">${N.escHtml(c.label)}</div>` +
      `<div class="val">${N.escHtml(c.value)}</div>` +
      `<div class="sub2">${N.escHtml(c.sub)}</div></div>`).join("");

    const tips = Array.isArray(data.tips) ? data.tips : [];
    $("tips-list").innerHTML = tips.length === 0
      ? `<p class="hint">No tips returned.</p>`
      : `<dl class="kv">` + tips.map((t) =>
        `<dt>height ${N.escHtml(String(t.height))} · ${N.escHtml(String(t.status))}</dt>` +
        `<dd>${N.escHtml(String(t.hash || ""))}${t.branchlen ? ` (branch len ${N.escHtml(String(t.branchlen))})` : ""}</dd>`
      ).join("") + `</dl>`;
  }

  function peerRowHtml(r) {
    const badges = [];
    if (r.syncNode) badges.push(`<span class="badge sync">SYNC</span>`);
    badges.push(r.inbound ? `<span class="badge in">IN</span>` : `<span class="badge">OUT</span>`);
    if (r.stale) badges.push(`<span class="badge stale">STALE</span>`);
    return `<tr${r.syncNode ? ` class="sync"` : ""}>` +
      `<td class="addr">${N.escHtml(r.addr)}</td>` +
      `<td>${N.fmtPingUs(r.pingUs)}</td>` +
      `<td>${badges.join(" ")}</td>` +
      `<td>${r.curHeight === null ? "—" : N.fmtInt(r.curHeight)}</td>` +
      `<td>${N.fmtAgeSec(r.connAgeSec)}</td>` +
      `<td>${N.fmtBytes(r.bytesSent)}</td>` +
      `<td>${N.fmtBytes(r.bytesRecv)}</td>` +
      `<td title="${N.escHtml(r.subver)}">${N.escHtml(r.subver.length > 26 ? r.subver.slice(0, 25) + "…" : r.subver)}</td>` +
      `</tr>`;
  }

  function renderPeers(peers) {
    const rows = Array.isArray(peers)
      ? peers.map((p) => N.normalizePeer(p, Date.now() / 1000)) : [];
    const sorted = N.sortPeers(rows, state.peerSort.key, state.peerSort.dir);
    const inbound = rows.filter((r) => r.inbound).length;
    $("peers-summary").textContent =
      rows.length === 0 ? "No peers connected." :
      `${rows.length} peer${rows.length === 1 ? "" : "s"} (${inbound} inbound, ${rows.length - inbound} outbound), sorted by ${state.peerSort.key}.`;
    $("peers-table").style.display = rows.length === 0 ? "none" : "";
    $("peers-body").innerHTML = sorted.map(peerRowHtml).join("");
    document.querySelectorAll("th[data-sort]").forEach((th) => {
      const k = th.getAttribute("data-sort");
      th.textContent = th.textContent.replace(/ [▲▼]$/, "") + (state.peerSort.key === k ? (state.peerSort.dir === 1 ? " ▲" : " ▼") : "");
    });
  }

  function renderMempool(data) {
    const st = N.mempoolStats(data.mempool, data.mining);
    const relayFee = data.info && data.info.relayfee !== undefined ? Number(data.info.relayfee) : NaN;
    const cards = [
      { label: "Transactions", value: st.size === null ? "—" : N.fmtInt(st.size), sub: "unconfirmed in mempool" },
      { label: "Total size", value: N.fmtBytes(st.bytes), sub: st.avgTxBytes === null ? "—" : `avg ${N.fmtInt(st.avgTxBytes)} B/tx` },
      { label: "Pooled tx (mining)", value: st.pooledtx === null ? "—" : N.fmtInt(st.pooledtx), sub: "from getmininginfo" },
      { label: "Min relay fee", value: Number.isFinite(relayFee) ? `${relayFee} PRL/kB` : "—", sub: "non-free tx floor" },
    ];
    $("mempool-cards").innerHTML = cards.map((c) =>
      `<div class="card"><div class="lbl">${N.escHtml(c.label)}</div>` +
      `<div class="val">${N.escHtml(c.value)}</div><div class="sub2">${N.escHtml(c.sub)}</div></div>`).join("");
    $("mempool-note").textContent = st.poolMatch === false
      ? "Note: getmempoolinfo.size and getmininginfo.pooledtx disagree — the node may be mid-update; refresh to re-check."
      : st.poolMatch === true ? "getmempoolinfo and getmininginfo agree on the transaction count." : "";
  }

  function renderMining(data) {
    const m = data.mining || {};
    const num = (v) => (v === undefined || v === null || !Number.isFinite(Number(v)) ? "—" : N.fmtInt(v));
    const cards = [
      { label: "Network hashrate", value: N.fmtHashrate(m.networkhashps), sub: "recent blocks estimate" },
      { label: "Difficulty", value: m.difficulty === undefined ? "—" : Number(m.difficulty).toLocaleString("en-US", { maximumFractionDigits: 2 }), sub: "current target" },
      { label: "Generating", value: m.generate === true ? "YES" : m.generate === false ? "no" : "—", sub: "local mining enabled" },
      { label: "Own hashrate", value: m.hashespersec === undefined ? "—" : N.fmtHashrate(m.hashespersec), sub: "while generating" },
      { label: "Gen proc limit", value: m.genproclimit === undefined ? "—" : String(m.genproclimit), sub: "-1 = disabled" },
      { label: "Pooled tx", value: num(m.pooledtx), sub: "awaiting inclusion" },
      { label: "Last block size", value: m.currentblockvsize === undefined ? "—" : N.fmtBytes(m.currentblockvsize), sub: "virtual size" },
      { label: "Last block tx", value: num(m.currentblocktx), sub: "transactions" },
    ];
    $("mining-cards").innerHTML = cards.map((c) =>
      `<div class="card"><div class="lbl">${N.escHtml(c.label)}</div>` +
      `<div class="val">${N.escHtml(c.value)}</div><div class="sub2">${N.escHtml(c.sub)}</div></div>`).join("");
    $("mining-errors").textContent =
      (typeof m.errors === "string" && m.errors.trim()) ? "Node error: " + m.errors.trim() : "";
  }

  // ---------------------------------------------------------------- wiring

  function init() {
    state.settings = loadSettings();
    renderSettingsForm();

    document.querySelectorAll("#steps button").forEach((b) => {
      b.addEventListener("click", () => selectTab(b.getAttribute("data-tab")));
    });
    document.querySelectorAll("th[data-sort]").forEach((th) => {
      th.addEventListener("click", () => {
        const k = th.getAttribute("data-sort");
        if (state.peerSort.key === k) state.peerSort.dir *= -1;
        else state.peerSort = { key: k, dir: 1 };
        if (state.data) renderPeers(state.data.peers);
      });
    });

    $("btn-refresh").addEventListener("click", () => refresh(false));
    $("btn-save").addEventListener("click", () => {
      const s = readSettingsForm();
      const v = N.validateSettings(s);
      if (!v.ok) { setErr(v.errors.join(" ")); return; }
      state.settings = s;
      persistSettings();
      setMsg("Settings saved. Refreshing…");
      refresh(false);
    });
    $("btn-test").addEventListener("click", async () => {
      const s = readSettingsForm();
      const v = N.validateSettings(s);
      if (!v.ok) { setErr(v.errors.join(" ")); return; }
      setMsg("Testing…");
      const r = await N.rpcCall(window.fetch.bind(window), s.endpoint, "getinfo", [],
        N.basicAuthHeader(s.user, s.pass));
      if (r.ok) setMsg(`OK — node answered getinfo at block ${r.result && r.result.blocks !== undefined ? r.result.blocks : "?"}.`);
      else setErr(r.message);
    });
    $("btn-clear").addEventListener("click", clearSaved);
    $("preset-mainnet").addEventListener("click", () => applyNetworkPreset("mainnet"));
    $("preset-testnet").addEventListener("click", () => applyNetworkPreset("testnet"));
    $("preset-testnet2").addEventListener("click", () => applyNetworkPreset("testnet2"));
  }

  // Test seam: drives the real handlers against a DOM shim.
  window.PearlNodeApp = { state, init, refresh, selectTab, renderAll, loadSettings };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
