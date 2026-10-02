/* Pearl Vanity page wiring — classic script, uses window.PearlVanity bundle.
 * Spawns the grind pool as Blob-URL workers (works on https and file://);
 * falls back to cooperative main-thread grinding if Worker construction fails.
 */
(function () {
  "use strict";
  const V = window.PearlVanity;
  if (!V) { document.body.innerHTML = "<p style='padding:40px'>Failed to load the Vanity bundle.</p>"; return; }

  const $ = (id) => document.getElementById(id);
  const DONATE = "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d";

  const state = {
    running: false,
    workers: [],
    workerStats: [],
    totalAttempts: 0,
    t0: 0,
    timer: null,
    prefix: "",
    networkId: "mainnet",
    mode: "random",
    seedHex: null,
    account: 0,
    threads: 4,
    maxAttempts: 0,
    expected: 0n,
    fallback: null, // {stop:boolean} when using main-thread grinding
    lastLog: 0,
  };

  /* ---------- steps ---------- */
  const stepBtns = [...document.querySelectorAll("#steps button")];
  function goto(step) {
    document.querySelectorAll(".step").forEach((s) => s.classList.toggle("active", s.id === "step-" + step));
    stepBtns.forEach((b) => {
      b.classList.toggle("active", b.dataset.step === step);
      if (b.dataset.step === step) b.classList.add("done");
    });
    window.scrollTo({ top: 0, behavior: (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth") });
  }
  stepBtns.forEach((b) => b.addEventListener("click", () => { if (!state.running) goto(b.dataset.step); }));

  /* ---------- forge form ---------- */
  const prefixEl = $("prefix"), prefixErr = $("prefix-err"), previewEl = $("preview");

  function readPrefix() { return V.normalizePrefix(prefixEl.value); }

  function refreshForge() {
    const r = readPrefix();
    state.networkId = $("network").value;
    const hrp = V.NETWORKS[state.networkId].hrp;
    if (r.error) {
      prefixErr.textContent = r.error;
      prefixErr.hidden = false;
      previewEl.textContent = hrp + "1p…";
      $("d-expected").textContent = "—"; $("d-5k").textContent = "—"; $("d-20k").textContent = "—";
      $("d-warn").hidden = true;
      return false;
    }
    prefixErr.hidden = true;
    state.prefix = r.prefix;
    previewEl.textContent = hrp + "1p" + r.prefix + "…";
    const exp = V.expectedAttempts(r.prefix.length);
    state.expected = exp;
    $("d-expected").textContent = V.formatBig(exp);
    $("d-5k").textContent = "≈ " + V.formatDuration(Number(exp) / 5000);
    $("d-20k").textContent = "≈ " + V.formatDuration(Number(exp) / 20000);
    const warn = $("d-warn");
    if (r.prefix.length >= 5) {
      warn.hidden = false;
      warn.textContent = "5 characters averages 33.5M attempts — an overnight forge run, and luck varies wildly. 3–4 characters is the sweet spot for a browser.";
    } else if (r.prefix.length === 4) {
      warn.hidden = false;
      warn.textContent = "4 characters averages ~1M attempts — a few minutes on several threads. Grab coffee.";
    } else { warn.hidden = true; }
    return true;
  }
  prefixEl.addEventListener("input", refreshForge);
  $("network").addEventListener("change", refreshForge);

  document.querySelectorAll('input[name="mode"]').forEach((r) =>
    r.addEventListener("change", () => {
      state.mode = document.querySelector('input[name="mode"]:checked').value;
      $("seed-box").hidden = state.mode !== "bip86";
    })
  );
  $("gen-seed").addEventListener("click", () => {
    $("seed").value = V.newVanityMnemonic();
    $("seed-err").hidden = true;
  });

  $("to-grind").addEventListener("click", () => {
    if (!refreshForge()) { prefixEl.focus(); return; }
    state.threads = Math.max(1, Math.min(8, parseInt($("threads").value, 10) || 4));
    $("threads").value = state.threads;
    state.maxAttempts = Math.max(0, parseInt($("max-attempts").value, 10) || 0);
    state.account = Math.max(0, parseInt($("account").value, 10) || 0);
    if (state.mode === "bip86") {
      try {
        state.seedHex = V.bytesToHex(V.seedFromMnemonic($("seed").value));
        $("seed-err").hidden = true;
      } catch (e) {
        $("seed-err").textContent = e.message;
        $("seed-err").hidden = false;
        return;
      }
    } else { state.seedHex = null; }
    $("grind-target").textContent = V.fullTarget(state.networkId, state.prefix);
    $("grind-sub").textContent =
      `${state.threads} thread${state.threads > 1 ? "s" : ""} · ${state.mode === "random" ? "fresh random keys" : "BIP-86 account " + state.account} · expected ≈ ${V.formatBig(state.expected)} attempts`;
    goto("grind");
    resetGrindUI();
  });
  $("back-forge").addEventListener("click", () => { if (!state.running) goto("forge"); });

  /* ---------- grind ---------- */
  function log(msg, hot) {
    const el = $("grind-log");
    const line = document.createElement("div");
    if (hot) line.className = "hot";
    line.textContent = msg;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
    while (el.children.length > 200) el.removeChild(el.firstChild);
  }

  function resetGrindUI() {
    $("s-attempts").textContent = "0";
    $("s-rate").textContent = "0 addr/s";
    $("s-elapsed").textContent = "0s";
    $("s-expected").textContent = V.formatBig(state.expected);
    $("s-prob").textContent = "0%";
    $("s-eta").textContent = "—";
    $("grind-log").innerHTML = "";
    const tb = $("thread-bars");
    tb.innerHTML = "";
    for (let i = 0; i < state.threads; i++) {
      const row = document.createElement("div");
      row.className = "thread";
      row.innerHTML = `<span>thread ${i + 1}</span><div class="bar"><div class="fill" id="tfill-${i}"></div></div><span class="mono" id="trate-${i}">idle</span>`;
      tb.appendChild(row);
    }
    $("start").disabled = false;
    $("stop").disabled = true;
  }

  function fmtRate(r) {
    if (r >= 1000) return (r / 1000).toFixed(1) + "k addr/s";
    return Math.round(r) + " addr/s";
  }

  function tick() {
    const el = (Date.now() - state.t0) / 1000;
    $("s-elapsed").textContent = V.formatDuration(el);
    const rate = el > 0 ? state.totalAttempts / el : 0;
    $("s-rate").textContent = fmtRate(rate);
    $("s-attempts").textContent = V.formatBig(BigInt(state.totalAttempts));
    const p = V.hitProbability(BigInt(state.totalAttempts), state.prefix.length);
    $("s-prob").textContent = (p * 100).toFixed(p < 0.01 ? 2 : 1) + "%";
    $("s-eta").textContent = rate > 0 ? "≈ " + V.formatDuration(Number(state.expected) / rate) : "—";
    for (let i = 0; i < state.workerStats.length; i++) {
      const w = state.workerStats[i];
      const fill = $("tfill-" + i), lr = $("trate-" + i);
      if (fill) fill.style.width = Math.min(100, (w.attempts / (Number(state.expected) / state.threads)) * 100) + "%";
      if (lr) lr.textContent = fmtRate(w.rate || 0);
    }
    if (Date.now() - state.lastLog > 4000 && state.running) {
      state.lastLog = Date.now();
      log(`[t+${Math.round(el)}s] ${V.formatBig(BigInt(state.totalAttempts))} attempts · ${fmtRate(rate)} · luck ${(p * 100).toFixed(1)}%`);
    }
  }

  function spawnWorkers() {
    const blob = new Blob([V.WORKER_SRC], { type: "text/javascript" });
    const url = URL.createObjectURL(blob);
    state.workers = [];
    state.workerStats = [];
    const perWorkerCap = state.maxAttempts > 0 ? Math.ceil(state.maxAttempts / state.threads) : 0;
    for (let i = 0; i < state.threads; i++) {
      const w = new Worker(url);
      const st = { attempts: 0, rate: 0, ended: false };
      state.workerStats.push(st);
      w.onmessage = (e) => onWorkerMsg(i, e.data);
      w.onerror = (e) => {
        log(`thread ${i + 1} error: ${(e && e.message) || "worker error"}`, true);
        onWorkerMsg(i, { type: "error", message: "worker error" });
      };
      w.postMessage({
        cmd: "start", prefix: state.prefix, networkId: state.networkId,
        mode: state.mode, seedHex: state.seedHex, account: state.account,
        startIndex: i, stride: state.threads, maxAttempts: perWorkerCap,
      });
      state.workers.push(w);
    }
    // keep the blob URL alive for the session; revoked on stop
    state.workerUrl = url;
  }

  function onWorkerMsg(i, msg) {
    if (!state.running) return;
    const st = state.workerStats[i];
    if (msg.type === "progress") {
      const prev = st.attempts;
      st.attempts = msg.attempts;
      state.totalAttempts += msg.attempts - prev;
      st.rate = msg.rate;
    } else if (msg.type === "found") {
      state.totalAttempts += msg.attempts - st.attempts;
      st.attempts = msg.attempts;
      onFound(msg.result);
    } else if (msg.type === "capped" || msg.type === "stopped") {
      state.totalAttempts += (msg.attempts - st.attempts);
      st.attempts = msg.attempts;
      st.ended = true;
      if (msg.type === "capped") log(`thread ${i + 1} hit the attempt cap.`, true);
      checkAllStopped();
    } else if (msg.type === "error") {
      log(`thread ${i + 1}: ${msg.message}`, true);
      st.ended = true;
      checkAllStopped();
    }
  }

  function checkAllStopped() {
    // a worker ended without a find; stop everything only once ALL ended
    if (state.workerStats.length && state.workerStats.every((s) => s.ended)) {
      stopGrind("All threads stopped.");
    }
  }

  function onFound(result) {
    // integrity: re-derive from the secret before showing anything
    const v = V.verifyFound(result, state.prefix);
    if (!v.ok) {
      log("Found key FAILED integrity re-check: " + v.error, true);
      stopGrind("Integrity check failed — see log.");
      return;
    }
    log(`⚒ STRUCK after ${V.formatBig(BigInt(state.totalAttempts))} attempts: ${result.address}`, true);
    stopGrind(null);
    showClaim(result);
  }

  function stopAllWorkers() {
    state.workers.forEach((w) => { try { w.postMessage({ cmd: "stop" }); } catch {} });
    setTimeout(() => {
      state.workers.forEach((w) => { try { w.terminate(); } catch {} });
      if (state.workerUrl) { try { URL.revokeObjectURL(state.workerUrl); } catch {} }
      state.workers = [];
    }, 400);
    if (state.fallback) { state.fallback.stop = true; state.fallback = null; }
  }

  function stopGrind(note) {
    if (!state.running) return;
    state.running = false;
    stopAllWorkers();
    clearInterval(state.timer);
    tick();
    $("start").disabled = false;
    $("stop").disabled = true;
    if (note) log(note, true);
  }

  /* main-thread fallback (no Worker support) */
  function grindMainThread() {
    const fb = { stop: false };
    state.fallback = fb;
    const rng = (n) => { const b = new Uint8Array(n); crypto.getRandomValues(b); return b; };
    let accountNode = null;
    if (state.mode === "bip86") {
      accountNode = V.bip86AccountNode(V.hexToBytes(state.seedHex), V.NETWORKS[state.networkId], state.account);
    }
    const BATCH = 512;
    let idx = 0, attempts = 0;
    const t0 = Date.now();
    state.workerStats = [{ attempts: 0, rate: 0 }];
    (function loop() {
      if (fb.stop || !state.running) return;
      let res;
      try {
        res = V.grindBatch({
          prefix: state.prefix, networkId: state.networkId, mode: state.mode,
          accountNode, startIndex: idx, stride: 1, batchSize: BATCH, rng,
        });
      } catch (e) { stopGrind("Grind error: " + e.message); return; }
      attempts += res.scanned; idx += res.scanned;
      state.totalAttempts = attempts;
      state.workerStats[0].attempts = attempts;
      state.workerStats[0].rate = attempts / ((Date.now() - t0) / 1000);
      if (res.found) { onFound(res.found); return; }
      if (state.maxAttempts > 0 && attempts >= state.maxAttempts) { stopGrind("Hit the attempt cap."); return; }
      setTimeout(loop, 0);
    })();
  }

  $("start").addEventListener("click", () => {
    if (state.running) return;
    if (!refreshForge()) { goto("forge"); return; }
    state.running = true;
    state.totalAttempts = 0;
    state.t0 = Date.now();
    state.lastLog = 0;
    $("grind-log").innerHTML = "";
    $("start").disabled = true;
    $("stop").disabled = false;
    log(`⚒ forge lit: hunting ${V.fullTarget(state.networkId, state.prefix)} on ${state.threads} thread(s)…`, true);
    let workersOk = false;
    try {
      if (typeof Worker !== "undefined" && V.WORKER_SRC) { spawnWorkers(); workersOk = true; }
    } catch (e) {
      log("Worker spawn failed (" + e.message + ") — grinding on the main thread instead.", true);
    }
    if (!workersOk) {
      log("Grinding on the main thread (single-threaded fallback).", true);
      grindMainThread();
    }
    state.timer = setInterval(tick, 500);
  });
  $("stop").addEventListener("click", () => stopGrind("Stopped by user."));

  /* ---------- claim ---------- */
  function drawQR(el, text) {
    el.innerHTML = "";
    try {
      if (!window.qrcode || !text) return;
      const qr = window.qrcode(0, "M");
      qr.addData(text);
      qr.make();
      el.innerHTML = qr.createImgTag(5, 8);
    } catch { /* QR is a convenience; never fatal */ }
  }

  function copyText(t, btn) {
    const done = () => {
      const old = btn.textContent;
      btn.textContent = "Copied ✓";
      setTimeout(() => (btn.textContent = old), 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).then(done, () => fallbackCopy(t, done));
    } else fallbackCopy(t, done);
  }
  function fallbackCopy(t, done) {
    const ta = document.createElement("textarea");
    ta.value = t;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); done(); } catch {}
    document.body.removeChild(ta);
  }

  function showClaim(result) {
    goto("claim");
    $("r-address").textContent = result.address;
    $("r-network").textContent = V.NETWORKS[result.networkId].label;
    $("r-mode").textContent = result.mode === "random"
      ? "Fresh random key (NOT in any seed — back it up)"
      : "BIP-86 from your seed";
    $("r-path").textContent = result.path || "— (random key, no path)";
    $("r-attempts").textContent = V.formatBig(BigInt(state.totalAttempts));
    $("r-verify").textContent = "✓ re-derived from secret + prefix matched";
    $("r-verify").className = "ok";
    $("r-privhex").textContent = result.privHex;
    $("r-wif").textContent = result.wif;
    $("secrets").hidden = true;
    $("reveal").textContent = "Reveal private key";
    drawQR($("r-qr"), result.address);
    state.claim = result;
  }

  $("reveal").addEventListener("click", () => {
    const s = $("secrets");
    s.hidden = !s.hidden;
    $("reveal").textContent = s.hidden ? "Reveal private key" : "Hide private key";
  });
  $("copy-addr").addEventListener("click", (e) => copyText($("r-address").textContent, e.target));
  $("copy-privhex").addEventListener("click", (e) => copyText($("r-privhex").textContent, e.target));
  $("copy-wif").addEventListener("click", (e) => copyText($("r-wif").textContent, e.target));
  $("copy-donate").addEventListener("click", (e) => copyText(DONATE, e.target));
  $("export").addEventListener("click", () => {
    if (!state.claim) return;
    const data = {
      app: "pearl-vanity",
      exportedAt: new Date().toISOString(),
      address: state.claim.address,
      xonlyPubkey: state.claim.xonlyHex,
      privateKeyHex: state.claim.privHex,
      wif: state.claim.wif,
      network: state.claim.networkId,
      mode: state.claim.mode,
      derivationPath: state.claim.path,
      prefix: state.prefix,
      attempts: state.totalAttempts.toString(),
      warning: "Anyone with the private key controls these coins. Store offline.",
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "pearl-vanity-" + state.claim.address.slice(0, 12) + ".json";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  });
  $("again").addEventListener("click", () => goto("forge"));

  refreshForge();
})();
