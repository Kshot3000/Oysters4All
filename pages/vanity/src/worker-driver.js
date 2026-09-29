/* Pearl Vanity worker driver — classic dedicated-worker script.
 * build.mjs concatenates the grind bundle (above) with this driver into
 * grind-worker.js. The page spawns it via Blob URL so it works on both
 * https (GitHub Pages) and file://. Cooperative: yields via setTimeout(0)
 * so 'stop' messages are honored between batches.
 */
var __vanityStop = false;
var __vanityAccountNode = null;

onmessage = function (e) {
  var cfg = e.data || {};
  if (cfg.cmd === "stop") { __vanityStop = true; return; }
  if (cfg.cmd !== "start") return;
  __vanityStop = false;
  __vanityAccountNode = null;
  var G = PearlVanityGrind;
  var BATCH = 1024;
  var attempts = 0;
  var idx = cfg.startIndex | 0;
  var stride = cfg.stride | 0 || 1;
  var t0 = performance.now();
  var lastPing = 0;
  var accountNode = null;
  if (cfg.mode === "bip86") {
    accountNode = G.bip86AccountNode(G.hexToBytes(cfg.seedHex), G.NETWORKS[cfg.networkId], cfg.account);
  }
  function rng(n) {
    var b = new Uint8Array(n);
    crypto.getRandomValues(b);
    return b;
  }
  (function loop() {
    if (__vanityStop) { postMessage({ type: "stopped", attempts: attempts }); return; }
    var res;
    try {
      res = G.grindBatch({
        prefix: cfg.prefix, networkId: cfg.networkId, mode: cfg.mode,
        accountNode: accountNode, startIndex: idx, stride: stride,
        batchSize: BATCH, rng: rng,
      });
    } catch (err) {
      postMessage({ type: "error", message: String((err && err.message) || err) });
      return;
    }
    attempts += res.scanned;
    idx += res.scanned * stride;
    if (res.found) { postMessage({ type: "found", result: res.found, attempts: attempts }); return; }
    if (cfg.maxAttempts && attempts >= cfg.maxAttempts) {
      postMessage({ type: "capped", attempts: attempts }); return;
    }
    var now = performance.now();
    if (now - lastPing > 250) {
      lastPing = now;
      postMessage({ type: "progress", attempts: attempts, rate: attempts / ((now - t0) / 1000) });
    }
    setTimeout(loop, 0);
  })();
};
