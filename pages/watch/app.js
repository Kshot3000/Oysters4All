/* Pearl Watch page wiring — classic script, uses window.PearlWatch bundle.
 *
 * Watch-only, read-only. No keys, seeds, or signing anywhere on this page.
 * Blockbook reads are GET-only; a broadcast/post path does not exist here.
 * Watchlist + rules + events persist in localStorage (hostile-safe wrappers);
 * snapshots live in page memory only. The beacon only sweeps while this tab
 * is open — a closed tab watches nothing, and the honest-limits panel says so.
 */
(function () {
  "use strict";
  const R = window.PearlWatch;
  if (!R) { document.body.innerHTML = "<p style='padding:40px'>Failed to load the Watch bundle.</p>"; return; }

  const $ = (id) => document.getElementById(id);
  const store = {
    get(k) { try { return typeof localStorage !== "undefined" ? localStorage.getItem(k) : null; } catch (e) { return null; } },
    set(k, v) { try { if (typeof localStorage !== "undefined") localStorage.setItem(k, v); } catch (e) {} },
    del(k) { try { if (typeof localStorage !== "undefined") localStorage.removeItem(k); } catch (e) {} },
  };

  const net = () => R.NETWORKS[state.network];
  const storeKey = () => `pearl-watch:${state.network}:v${R.WATCH_VERSION}`;

  const state = {
    network: "mainnet",
    watched: [],   // {address, label, addedAt}
    rules: [],     // normalized rules (with .state)
    events: [],    // newest first
    blockbook: "",
    pollMs: R.DEFAULT_POLL_MS,
    notify: false,
    sound: false,
  };
  let snapshots = new Map(); // address -> snapshot (memory only)
  let lastNewTx = new Map(); // address -> new-txid count from the last sweep
  let beaconTimer = null;
  let trackTimer = null;
  let tracked = null; // {txid, target}
  let tipHeight = null;

  /* ---------- persistence ---------- */

  function persist() {
    store.set(storeKey(), R.serializeWatchState({
      version: R.WATCH_VERSION, network: state.network,
      watched: state.watched, rules: state.rules,
      events: state.events.slice(0, R.MAX_EVENTS),
      blockbook: state.blockbook, pollMs: state.pollMs,
      notify: state.notify, sound: state.sound,
    }));
  }

  function load() {
    const raw = store.get(storeKey());
    if (!raw) {
      const d = R.defaultWatchState(net());
      Object.assign(state, d);
      state.blockbook = d.blockbook;
      return;
    }
    try {
      const s = R.deserializeWatchState(raw, net());
      Object.assign(state, s);
    } catch (e) {
      console.warn("watch state unreadable, starting fresh:", e.message);
      const d = R.defaultWatchState(net());
      Object.assign(state, d);
      state.blockbook = d.blockbook;
    }
  }

  /* ---------- tabs ---------- */

  const TABS = ["watchlist", "beacon", "rules", "events", "track"];
  function goto(tab) {
    TABS.forEach((t) => {
      $("tb-" + t).classList.toggle("active", t === tab);
      $("tab-" + t).classList.toggle("active", t === tab);
    });
  }
  TABS.forEach((t) => $("tb-" + t).addEventListener("click", () => goto(t)));

  /* ---------- errors ---------- */

  function showErr(id, msg) { const e = $(id); e.textContent = msg; e.hidden = false; }
  function hideErr(id) { $(id).hidden = true; }

  function download(name, text, mime) {
    const b = new Blob([text], { type: mime || "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(b); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  /* ---------- watchlist ---------- */

  function cell(tr, text, cls) {
    const td = document.createElement("td");
    if (cls) td.className = cls;
    td.textContent = text;
    tr.appendChild(td);
    return td;
  }

  function renderWatchlist() {
    const tb = $("w-tbody");
    tb.innerHTML = "";
    if (!state.watched.length) {
      const tr = document.createElement("tr");
      tr.className = "empty";
      const td = document.createElement("td");
      td.colSpan = 8;
      td.textContent = "No addresses yet. Add one above — the lamp only watches what you point it at.";
      tr.appendChild(td);
      tb.appendChild(tr);
    }
    for (const w of state.watched) {
      const snap = snapshots.get(w.address);
      const tr = document.createElement("tr");
      cell(tr, w.label || "—");
      const aCell = cell(tr, R.shortAddr(w.address), "mono");
      aCell.title = w.address;
      cell(tr, snap ? R.fmtPRL(snap.balance) : "—", "num");
      cell(tr, snap ? R.fmtPRL(snap.totalReceived) : "—", "num");
      cell(tr, snap ? R.fmtPRL(snap.totalSent) : "—", "num");
      cell(tr, snap ? String(snap.txCount) : "—", "num");
      cell(tr, snap ? R.fmtAge(snap.fetchedAt, Date.now()) : "never");
      const rm = document.createElement("button");
      rm.type = "button"; rm.className = "rowbtn danger"; rm.textContent = "Remove";
      rm.addEventListener("click", () => {
        state.watched = state.watched.filter((x) => x.address !== w.address);
        state.rules = state.rules.filter((r) => r.address !== w.address);
        snapshots.delete(w.address);
        persist(); renderAll();
      });
      const td = document.createElement("td");
      td.appendChild(rm);
      tr.appendChild(td);
      tb.appendChild(tr);
    }
    $("w-count").textContent = `${state.watched.length} / ${R.MAX_WATCHED} watched`;
  }

  function addWatched() {
    hideErr("w-err");
    try {
      const address = R.validateWatchAddress($("w-addr").value, net());
      if (state.watched.some((w) => w.address === address)) {
        throw new Error("WATCH REFUSED: that address is already on the watchlist");
      }
      if (state.watched.length >= R.MAX_WATCHED) {
        throw new Error(`WATCH REFUSED: watchlist is full (max ${R.MAX_WATCHED})`);
      }
      state.watched.push({ address, label: $("w-label").value.trim().slice(0, 80), addedAt: Date.now() });
      $("w-addr").value = ""; $("w-label").value = "";
      persist(); renderWatchlist(); renderBeaconTable();
    } catch (e) { showErr("w-err", e.message); }
  }

  /* ---------- blockbook ---------- */

  function bbBase() {
    return state.blockbook || net().blockbook || "";
  }

  async function checkBackend() {
    const st = $("bb-status");
    const base = $("bb-url").value.trim() || net().blockbook || "";
    if (!base) { st.textContent = "backend: none configured"; st.className = "status"; return false; }
    st.textContent = "backend: checking…"; st.className = "status";
    try {
      tipHeight = await R.fetchTipHeight(fetch, base);
      st.textContent = `backend: OK · tip ${tipHeight}`;
      st.className = "status ok";
      $("b-tip").textContent = `chain tip: ${tipHeight}`;
      return true;
    } catch (e) {
      st.textContent = `backend: unreachable (${e.message.slice(0, 80)})`;
      st.className = "status bad";
      return false;
    }
  }

  /* ---------- beacon sweep ---------- */

  function alertUser(events) {
    if (!events.length) return;
    const first = events[0];
    const title = events.length === 1 ? "Pearl Watch: " + first.kind : `Pearl Watch: ${events.length} events`;
    const body = first.message.slice(0, 140);
    if (state.notify && typeof Notification !== "undefined" && Notification.permission === "granted") {
      try { new Notification(title, { body }); } catch (e) {}
    }
    if (state.sound) {
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) {
          const ac = new AC();
          const o = ac.createOscillator(), g = ac.createGain();
          o.connect(g); g.connect(ac.destination);
          o.frequency.value = 880; g.gain.value = 0.08;
          o.start(); o.stop(ac.currentTime + 0.18);
          setTimeout(() => ac.close(), 400);
        }
      } catch (e) {}
    }
  }

  async function sweep(manual) {
    hideErr("b-err");
    const base = bbBase();
    if (!state.watched.length) { if (manual) showErr("b-err", "Nothing to sweep — the watchlist is empty."); return; }
    let baseOk = true;
    try { R.normalizeBlockbookBase(base); } catch (e) { showErr("b-err", e.message); return; }
    try {
      tipHeight = await R.fetchTipHeight(fetch, base);
      $("b-tip").textContent = `chain tip: ${tipHeight}`;
    } catch (e) { baseOk = false; }

    const fresh = new Map();
    const newTxDetails = new Map();
    const sweepErrors = [];
    for (const w of state.watched) {
      try {
        const snap = await R.fetchAddressSnapshot(fetch, base, w.address);
        fresh.set(w.address, snap);
      } catch (e) { sweepErrors.push(`${R.shortAddr(w.address)}: ${e.message.slice(0, 90)}`); }
    }
    if (!baseOk && !fresh.size) {
      showErr("b-err", "Blockbook unreachable — no data this sweep. Check the backend URL; the page stays honest and keeps old data.");
      renderBeaconTable(sweepErrors);
      return;
    }
    // fetch full tx details for new txids (incoming/outgoing attribution)
    const need = new Set();
    for (const rule of state.rules) {
      if (!rule.enabled || (rule.kind !== "incoming" && rule.kind !== "outgoing")) continue;
      const snap = fresh.get(rule.address), p = snapshots.get(rule.address);
      if (!snap) continue;
      for (const id of R.diffSnapshots(p || null, snap).newTxids) need.add(id);
    }
    for (const txid of need) {
      try { newTxDetails.set(txid, await R.fetchTxDetail(fetch, base, txid)); }
      catch (e) { sweepErrors.push(`tx ${R.shortTxid(txid)}: ${e.message.slice(0, 90)}`); }
    }
    // tx-confirmed rules need their txids too
    const txDetails = new Map(newTxDetails);
    for (const rule of state.rules) {
      if (rule.enabled && rule.kind === "tx-confirmed" && !txDetails.has(rule.txid)) {
        try { txDetails.set(rule.txid, await R.fetchTxDetail(fetch, base, rule.txid)); }
        catch (e) { sweepErrors.push(`tx ${R.shortTxid(rule.txid)}: ${e.message.slice(0, 90)}`); }
      }
    }

    const { events } = R.evaluateRules({
      snapshots: fresh, prev: snapshots, rules: state.rules,
      newTxDetails, txDetails, tipHeight, nowMs: Date.now(),
    });
    // per-address "new this sweep" counts for the beacon table
    lastNewTx = new Map();
    for (const w of state.watched) {
      const snap = fresh.get(w.address);
      if (snap) lastNewTx.set(w.address, R.diffSnapshots(snapshots.get(w.address) || null, snap).newTxids.length);
    }
    if (events.length) {
      state.events = events.concat(state.events).slice(0, R.MAX_EVENTS);
      const firedAt = new Map();
      for (const e of events) firedAt.set(e.ruleId, Math.max(firedAt.get(e.ruleId) || 0, e.ts));
      for (const r of state.rules) {
        if (firedAt.has(r.id)) r.state.lastFiredAt = firedAt.get(r.id);
      }
      alertUser(events);
    }
    snapshots = fresh;
    persist();
    renderAll();
    renderBeaconTable(sweepErrors);
    if (manual) $("w-ref-status").textContent = `swept ${fresh.size}/${state.watched.length} addresses · ${events.length} new event(s)`;
  }

  function renderBeaconTable(errors) {
    const tb = $("b-tbody");
    tb.innerHTML = "";
    if (!state.watched.length) {
      const tr = document.createElement("tr");
      tr.className = "empty";
      const td = document.createElement("td");
      td.colSpan = 5;
      td.textContent = "Beacon idle. Start it to sweep the watchlist.";
      tr.appendChild(td);
      tb.appendChild(tr);
      return;
    }
    for (const w of state.watched) {
      const snap = snapshots.get(w.address);
      const tr = document.createElement("tr");
      const err = (errors || []).find((e) => e.startsWith(R.shortAddr(w.address)));
      const aCell = cell(tr, R.shortAddr(w.address), "mono");
      aCell.title = w.address;
      cell(tr, snap ? R.fmtPRL(snap.balance) + " PRL" : "—", "num");
      cell(tr, snap ? String(lastNewTx.get(w.address) ?? 0) : "—");
      cell(tr, snap ? R.fmtTime(snap.fetchedAt) : "never");
      const st = cell(tr, err ? "error" : (snap ? "ok" : "pending"));
      st.style.color = err ? "var(--signal)" : (snap ? "var(--seafoam)" : "var(--dim)");
      tb.appendChild(tr);
    }
  }

  function setBeacon(on) {
    if (beaconTimer) { clearInterval(beaconTimer); beaconTimer = null; }
    $("lamp").classList.toggle("on", on);
    $("b-toggle").textContent = on ? "Stop beacon" : "Start beacon";
    $("b-toggle").classList.toggle("primary", !on);
    if (on) {
      sweep(false);
      beaconTimer = setInterval(() => sweep(false), state.pollMs);
    }
  }

  /* ---------- rules ---------- */

  function ruleKindChanged() {
    const k = $("r-kind").value;
    $("r-addr-wrap").hidden = k === "tx-confirmed";
    $("r-txid-wrap").hidden = k !== "tx-confirmed";
    $("r-amt-wrap").hidden = !(k === "incoming" || k === "outgoing" || k === "balance-above" || k === "balance-below");
    $("r-conf-wrap").hidden = k !== "tx-confirmed";
    $("r-amt").placeholder = (k === "balance-above" || k === "balance-below") ? "threshold in PRL" : "min amount in PRL (0 = any)";
  }

  function describeRule(r) {
    const a = r.address ? R.shortAddr(r.address) : R.shortTxid(r.txid);
    switch (r.kind) {
      case "incoming": return `incoming ≥ ${R.fmtPRL(r.minGrains)} PRL`;
      case "outgoing": return `outgoing ≥ ${R.fmtPRL(r.minGrains)} PRL`;
      case "balance-above": return `crosses above ${R.fmtPRL(r.thresholdGrains)} PRL`;
      case "balance-below": return `crosses below ${R.fmtPRL(r.thresholdGrains)} PRL`;
      case "tx-confirmed": return `reaches ${r.target} confirmations`;
      default: return r.kind;
    }
  }

  function addRule() {
    hideErr("r-err");
    try {
      const kind = $("r-kind").value;
      const rule = { kind, label: $("r-label").value.trim() };
      if (kind === "tx-confirmed") {
        rule.txid = $("r-txid").value.trim();
        rule.target = $("r-conf").value.trim();
      } else {
        rule.address = $("r-addr").value.trim();
        rule.minGrains = $("r-amt").value.trim() === "" ? 0n : R.parsePRL($("r-amt").value.trim());
        rule.thresholdGrains = rule.minGrains;
      }
      if (state.rules.length >= R.MAX_RULES) throw new Error(`RULE REFUSED: too many rules (max ${R.MAX_RULES})`);
      const norm = R.normalizeRule(rule, net());
      state.rules.push(norm);
      $("r-addr").value = ""; $("r-txid").value = ""; $("r-amt").value = ""; $("r-conf").value = ""; $("r-label").value = "";
      persist(); renderRules();
    } catch (e) { showErr("r-err", e.message); }
  }

  function renderRules() {
    const tb = $("r-tbody");
    tb.innerHTML = "";
    if (!state.rules.length) {
      const tr = document.createElement("tr");
      tr.className = "empty";
      const td = document.createElement("td");
      td.colSpan = 6;
      td.textContent = "No rules. A watchtower with no rules is just a nice view.";
      tr.appendChild(td);
      tb.appendChild(tr);
      return;
    }
    for (const r of state.rules) {
      const tr = document.createElement("tr");
      const tdT = document.createElement("td");
      const tgl = document.createElement("input");
      tgl.type = "checkbox"; tgl.checked = r.enabled;
      tgl.setAttribute("aria-label", "enable rule");
      tgl.addEventListener("change", () => { r.enabled = tgl.checked; persist(); });
      tdT.appendChild(tgl);
      tr.appendChild(tdT);
      cell(tr, r.label || R.RULE_KINDS[r.kind]);
      const target = cell(tr, r.address ? R.shortAddr(r.address) : R.shortTxid(r.txid), "mono");
      target.title = r.address || r.txid;
      cell(tr, describeRule(r));
      cell(tr, r.state && r.state.lastFiredAt ? R.fmtAge(r.state.lastFiredAt, Date.now()) : "never");
      const td5 = document.createElement("td");
      const del = document.createElement("button");
      del.type = "button"; del.className = "rowbtn danger"; del.textContent = "Delete";
      del.addEventListener("click", () => {
        state.rules = state.rules.filter((x) => x.id !== r.id);
        persist(); renderRules();
      });
      td5.appendChild(del);
      tr.appendChild(td5);
      tr.style.opacity = r.enabled ? "1" : ".55";
      tb.appendChild(tr);
    }
  }

  /* ---------- events ---------- */

  const KIND_CLASS = {
    incoming: "kind-in", outgoing: "kind-out",
    "balance-above": "kind-cross", "balance-below": "kind-cross",
    "tx-confirmed": "kind-conf", "rule-error": "kind-out",
  };

  function renderEvents() {
    const f = $("e-filter").value;
    const list = f ? state.events.filter((e) => e.kind === f) : state.events;
    const tb = $("e-tbody");
    tb.innerHTML = "";
    if (!list.length) {
      const tr = document.createElement("tr");
      tr.className = "empty";
      const td = document.createElement("td");
      td.colSpan = 6;
      td.textContent = "Quiet seas. Events appear here when rules fire.";
      tr.appendChild(td);
      tb.appendChild(tr);
    }
    for (const e of list.slice(0, 200)) {
      const tr = document.createElement("tr");
      cell(tr, R.fmtTime(e.ts));
      cell(tr, e.kind, KIND_CLASS[e.kind] || "");
      cell(tr, e.message);
      cell(tr, e.grains != null ? R.fmtPRL(BigInt(e.grains)) + " PRL" : "—", "num");
      cell(tr, e.confirmations != null ? String(e.confirmations) : "—", "num");
      const txCell = cell(tr, e.txid ? R.shortTxid(e.txid) : "—", "mono");
      txCell.title = e.txid || "";
      tb.appendChild(tr);
    }
    const pill = $("ev-count");
    pill.textContent = String(state.events.length);
    pill.classList.toggle("zero", !state.events.length);
  }

  /* ---------- track ---------- */

  async function trackOnce() {
    hideErr("t-err");
    if (!tracked) return;
    const base = bbBase();
    try { R.normalizeBlockbookBase(base); } catch (e) { showErr("t-err", e.message); return; }
    try {
      tipHeight = await R.fetchTipHeight(fetch, base);
    } catch (e) { showErr("t-err", `blockbook unreachable: ${e.message.slice(0, 100)}`); return; }
    let tx;
    try { tx = await R.fetchTxDetail(fetch, base, tracked.txid); }
    catch (e) { showErr("t-err", `tx lookup failed: ${e.message.slice(0, 120)}`); return; }
    const p = R.confirmationProgress(tx, tipHeight, tracked.target);
    $("t-out").hidden = false;
    $("t-bar").style.width = Math.min(100, (p.confirmations / p.target) * 100) + "%";
    $("t-line").textContent = p.done
      ? `⚓ Landed — ${p.confirmations} confirmation${p.confirmations === 1 ? "" : "s"} (target ${p.target})`
      : tx.blockHeight == null || tx.blockHeight < 0
        ? `🌊 Unconfirmed — in mempool, ${p.remaining} to go (target ${p.target})`
        : `${p.confirmations} / ${p.target} confirmations — ${p.remaining} to go`;
    $("t-meta").textContent =
      `txid ${tracked.txid} · block ${tx.blockHeight == null || tx.blockHeight < 0 ? "—" : tx.blockHeight} · ` +
      `tip ${tipHeight} · value ${tx.value != null ? R.fmtPRL(BigInt(String(tx.value))) + " PRL" : "—"} · ` +
      `fees ${tx.fees != null ? R.fmtPRL(BigInt(String(tx.fees))) + " PRL" : "—"}`;
    if (p.done && trackTimer) { clearInterval(trackTimer); trackTimer = null; $("t-stop").hidden = true; }
  }

  /* ---------- wiring ---------- */

  function renderAll() { renderWatchlist(); renderBeaconTable(); renderRules(); renderEvents(); }

  $("w-add").addEventListener("click", addWatched);
  $("w-addr").addEventListener("keydown", (e) => { if (e.key === "Enter") addWatched(); });
  $("w-refresh").addEventListener("click", () => sweep(true));
  $("w-clear").addEventListener("click", () => {
    if (!state.watched.length) return;
    if (confirm(`Remove all ${state.watched.length} watched addresses and their rules?`)) {
      state.watched = []; state.rules = []; snapshots = new Map();
      persist(); renderAll();
    }
  });
  $("w-export").addEventListener("click", () => {
    download("pearl-watchlist.json", R.serializeWatchState({
      version: R.WATCH_VERSION, network: state.network,
      watched: state.watched, rules: state.rules, events: [],
      blockbook: state.blockbook, pollMs: state.pollMs, notify: state.notify, sound: state.sound,
    }));
  });
  $("w-import-btn").addEventListener("click", () => $("w-import").click());
  $("w-import").addEventListener("change", () => {
    const f = $("w-import").files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const s = R.deserializeWatchState(String(rd.result), net());
        state.watched = s.watched; state.rules = s.rules;
        snapshots = new Map();
        persist(); renderAll();
      } catch (e) { showErr("w-err", "Import refused: " + e.message); }
      $("w-import").value = "";
    };
    rd.readAsText(f);
  });

  $("net").addEventListener("change", () => {
    setBeacon(false);
    stopTracking();
    snapshots = new Map(); tipHeight = null;
    state.network = $("net").value;
    load();
    $("bb-url").value = state.blockbook || "";
    $("b-interval").value = String(state.pollMs);
    $("b-notify").checked = state.notify; $("b-sound").checked = state.sound;
    checkBackend();
    renderAll();
  });
  $("bb-save").addEventListener("click", async () => {
    hideErr("b-err");
    try {
      state.blockbook = $("bb-url").value.trim() ? R.normalizeBlockbookBase($("bb-url").value) : "";
      persist();
      await checkBackend();
    } catch (e) { showErr("b-err", e.message); }
  });
  $("b-interval").addEventListener("change", () => {
    state.pollMs = Number($("b-interval").value) || 0;
    persist();
    if (beaconTimer) setBeacon(true); // restart with new cadence
  });
  $("b-toggle").addEventListener("click", () => setBeacon(!beaconTimer));
  $("b-sweep").addEventListener("click", () => sweep(true));

  $("b-notify").addEventListener("change", async () => {
    if ($("b-notify").checked && typeof Notification !== "undefined" && Notification.permission === "default") {
      try { await Notification.requestPermission(); } catch (e) {}
    }
    if ($("b-notify").checked && typeof Notification !== "undefined" && Notification.permission === "denied") {
      $("b-notify").checked = false;
      showErr("b-err", "Browser notifications are blocked for this page — allow them in the browser's site settings first.");
      return;
    }
    state.notify = $("b-notify").checked;
    persist();
  });
  $("b-sound").addEventListener("change", () => { state.sound = $("b-sound").checked; persist(); });

  $("r-kind").addEventListener("change", ruleKindChanged);
  $("r-add").addEventListener("click", addRule);

  $("e-filter").addEventListener("change", renderEvents);
  $("e-csv").addEventListener("click", () => {
    if (!state.events.length) return;
    download("pearl-watch-events.csv", R.eventsToCSV(state.events), "text/csv");
  });
  $("e-json").addEventListener("click", () => {
    if (!state.events.length) return;
    download("pearl-watch-events.json", JSON.stringify(state.events, null, 2));
  });
  $("e-clear").addEventListener("click", () => {
    if (!state.events.length) return;
    if (confirm(`Clear all ${state.events.length} logged events?`)) {
      state.events = []; persist(); renderEvents();
    }
  });

  function stopTracking() {
    if (trackTimer) { clearInterval(trackTimer); trackTimer = null; }
    tracked = null; $("t-stop").hidden = true; $("t-out").hidden = true;
  }
  $("t-watch").addEventListener("click", () => {
    hideErr("t-err");
    const txid = $("t-txid").value.trim();
    if (!/^[0-9a-fA-F]{64}$/.test(txid)) { showErr("t-err", "TRACK REFUSED: txid must be 64 hex characters"); return; }
    const target = Number($("t-target").value);
    if (!Number.isInteger(target) || target < 1 || target > 100000) {
      showErr("t-err", "TRACK REFUSED: target must be 1..100000 confirmations"); return;
    }
    stopTracking();
    tracked = { txid: txid.toLowerCase(), target };
    $("t-stop").hidden = false;
    trackOnce();
    trackTimer = setInterval(trackOnce, Math.max(state.pollMs || R.DEFAULT_POLL_MS, R.MIN_POLL_MS));
  });
  $("t-stop").addEventListener("click", stopTracking);

  /* ---------- boot ---------- */

  load();
  $("net").value = state.network;
  $("bb-url").value = state.blockbook || "";
  $("b-interval").value = String(state.pollMs);
  $("b-notify").checked = state.notify; $("b-sound").checked = state.sound;
  ruleKindChanged();
  goto("watchlist");
  renderAll();
  checkBackend();

  /* test hook (drives the DOM test suite; exposes no secrets) */
  window.__watchTest = {
    state: () => JSON.parse(JSON.stringify(state, (k, v) => typeof v === "bigint" ? v.toString() + "n" : v)),
    snapshots: () => snapshots,
    sweep: (manual) => sweep(manual),
    goto,
    R,
  };
})();
