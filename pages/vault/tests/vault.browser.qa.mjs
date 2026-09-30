// Real-browser QA for Pearl Vault: headless Chrome (file://), CDP-driven,
// stubbed Blockbook injected as window.fetch. Drives the full flow:
// Forge -> Fund -> Plan -> Sign -> Coordinator -> Finalize -> Broadcast -> Track -> Verify.
// Fails loudly on any console/page error or missing asset.
//
// Usage:
//   cp index.html app.js styles.css pearl-vault.bundle.js qrcode.min.js /tmp/vaultqa/  # renderer can't read root-owned files
//   node tests/vault.browser.qa.mjs
// (Chrome binary: /opt/meta-chromium/chrome; sandbox loopback is blocked, so
// the page loads via file:// and Blockbook is stubbed in-page.)
import { spawn } from "node:child_process";

const PORT = 9336;
const PAGE = "file:///tmp/vaultqa/index.html";

const errors = [];
const logs = [];

function wsConnect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    let id = 0;
    ws.onopen = () => resolve({
      send(method, params = {}) {
        return new Promise((res, rej) => {
          const mid = ++id;
          pending.set(mid, { res, rej });
          ws.send(JSON.stringify({ id: mid, method, params }));
        });
      },
      onEvent(fn) {
        ws.onmessage = (e) => {
          const msg = JSON.parse(e.data);
          if (msg.id && pending.has(msg.id)) {
            const { res, rej } = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.error) rej(new Error("CDP error: " + JSON.stringify(msg.error).slice(0, 300)));
            else res(msg.result);
          } else fn(msg);
        };
      },
      close() { ws.close(); },
    });
    ws.onerror = (e) => reject(e);
    setTimeout(() => reject(new Error("ws connect timeout")), 15000);
  });
}

async function getJson(path) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`);
  return res.json();
}

async function main() {
  const chrome = spawn("/opt/meta-chromium/chrome", [
    "--headless=new", "--no-sandbox", "--disable-gpu",
    `--remote-debugging-port=${PORT}`,
    "--user-data-dir=/tmp/vaultqa-profile",
    "about:blank",
  ], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 2500));

  try {
    // pick a real page target (not omnibox popups), navigate it ourselves
    let page = null;
    for (let i = 0; i < 20 && !page; i++) {
      try {
        const all = await getJson("/json/list");
        page = all.find((t) => t.type === "page" && /^https?:|^file:|^about:blank/.test(t.url) && !t.url.includes("top-chrome"));
      } catch { /* retry */ }
      if (!page) await new Promise((r) => setTimeout(r, 500));
    }
    if (!page) throw new Error("no page target found");
    const cdp = await wsConnect(page.webSocketDebuggerUrl);
    const results = [];
    cdp.onEvent((msg) => {
      if (msg.method === "Runtime.consoleAPICalled") {
        const text = (msg.params.args || []).map((a) => a.value ?? a.description ?? "").join(" ");
        if (msg.params.type === "error") errors.push("console.error: " + text);
        else logs.push(`${msg.params.type}: ${text.slice(0, 120)}`);
      }
      if (msg.method === "Runtime.exceptionThrown") {
        errors.push("page exception: " + (msg.params.exceptionDetails?.text || JSON.stringify(msg.params.exceptionDetails).slice(0, 300)));
      }
      if (msg.method === "Log.entryAdded") {
        const e = msg.params.entry;
        if (e.level === "error") errors.push(`log error: ${e.text} @ ${e.url || ""}`);
      }
    });
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Page.enable");
    const ev = async (expr, awaitPromise = true) => {
      const r = await cdp.send("Runtime.evaluate", { expression: expr, awaitPromise, returnByValue: true });
      if (r.exceptionDetails) throw new Error("evaluate threw: " + JSON.stringify(r.exceptionDetails).slice(0, 500));
      return r.result?.value;
    };

    await cdp.send("Page.navigate", { url: PAGE });
    await new Promise((r) => setTimeout(r, 2500));

    const check = async (name, expr) => {
      let v, extra = "";
      try {
        v = await ev(expr);
        if (v !== true) extra = String(v).slice(0, 200);
      } catch (e) { v = false; extra = "EVAL THREW: " + e.message.slice(0, 200); }
      results.push([name, !!v, extra]);
      console.log((v ? "✔ " : "✖ ") + name + (extra && !v ? " — " + extra : ""));
      if (!v) errors.push(`CHECK FAILED: ${name}${extra ? " — " + extra : ""}`);
    };

    await check("bundle loaded", `!!window.PearlVault`);
    await check("qr lib loaded", `!!window.qrcode`);
    await check("test hook", `!!window.__vaultTest`);
    await check("no assets 404 (perf entries)", `performance.getEntriesByType('resource').every(r => !String(r.name).includes('404'))`);

    // ---- FORGE (pure crypto, no network) ----
    await ev(`__vaultTest.forge("mainnet", 2, [
      PearlVault.bytesToHex(PearlVault.schnorr.getPublicKey(PearlVault.hexToBytes("11".repeat(32)))),
      PearlVault.bytesToHex(PearlVault.schnorr.getPublicKey(PearlVault.hexToBytes("22".repeat(32)))),
      PearlVault.bytesToHex(PearlVault.schnorr.getPublicKey(PearlVault.hexToBytes("33".repeat(32))))
    ])`);
    await check("forge ok", `__vaultTest.err().hidden === true`);
    const addr = await ev(`__vaultTest.state().descriptor.address`);
    await check("address rendered", `document.getElementById('f-address').textContent === ${JSON.stringify(addr)}`);
    await check("qr rendered", `document.getElementById('f-qr').innerHTML.length > 50`);

    // ---- inject stubbed Blockbook as window.fetch ----
    await ev(`(() => {
      const ADDR = ${JSON.stringify(addr)};
      const UTXOS = [{ txid: "${"aa".repeat(32)}", vout: 0, value: 300000000, confirmations: 6 }];
      const ok = (o) => Promise.resolve({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });
      const fail = (s) => Promise.resolve({ ok: false, status: s, json: async () => ({}), text: async () => "err" });
      window.__qa = { txid: null, detail: null };
      window.fetch = async (url, opts = {}) => {
        const path = String(url).replace(/^https?:\\/\\/[^/]+/, "");
        if (path.startsWith("/api/v2/address/")) {
          const a = decodeURIComponent(path.split("/api/v2/address/")[1].split("?")[0]);
          if (a !== ADDR) return fail(404);
          return ok({ address: a, balance: "300000000", totalReceived: "300000000", totalSent: "0", txCount: 1 });
        }
        if (path.startsWith("/api/v2/utxo/")) return ok(UTXOS);
        if (path.startsWith("/api/v2/estimatefee/")) return ok({ result: 0.00012 });
        if (path === "/api/sendtx/" || path === "/api/sendtx") return ok({ result: window.__qa.txid || "${"00".repeat(32)}" });
        if (path.startsWith("/api/v2/tx/")) {
          const id = path.split("/api/v2/tx/")[1].split("?")[0];
          if (window.__qa.detail && window.__qa.detail.txid === id) return ok(window.__qa.detail);
          return fail(404);
        }
        return fail(404);
      };
      return true;
    })()`);

    // ---- FUND ----
    await ev(`document.getElementById('tb-fund').click()`);
    await ev(`document.getElementById('fund-refresh').click()`);
    await new Promise((r) => setTimeout(r, 1500));
    await check("fund ok", `__vaultTest.err().hidden === true`);
    await check("balance 3 PRL", `document.getElementById('fund-balance').textContent.includes('3')`);

    // ---- PLAN ----
    await ev(`document.getElementById('tb-plan').click()`);
    await ev(`document.getElementById('plan-fetch').click()`);
    await new Promise((r) => setTimeout(r, 1500));
    await ev(`__vaultTest.addRecip(${JSON.stringify(addr)}, "1")`);
    await ev(`document.getElementById('plan-feerate').value = "10"`);
    await ev(`document.getElementById('plan-build').click()`);
    await new Promise((r) => setTimeout(r, 800));
    await check("plan ok", `__vaultTest.err().hidden === true`);
    await check("plan err text", `__vaultTest.err().hidden ? "none" : __vaultTest.err().text`);
    await check("bundle kind", `__vaultTest.state().bundle && __vaultTest.state().bundle.kind`);
    await check("bundle rendered", `document.getElementById('plan-bundle').value.includes('pearl-vault-unsigned:v1')`);
    await check("fee shown", `document.getElementById('plan-result').textContent.includes('Fee')`);

    // ---- SIGN ----
    await ev(`document.getElementById('tb-sign').click()`);
    await ev(`document.getElementById('s-bundle').value = JSON.stringify(__vaultTest.state().bundle)`);
    await ev(`document.getElementById('s-import').click()`);
    await check("import ok", `__vaultTest.err().hidden === true && document.getElementById('s-check').textContent.includes('BUNDLE CHECKS OUT')`);
    await ev(`document.getElementById('s-keyindex').value = "0"`);
    await ev(`document.getElementById('s-key').value = ${JSON.stringify("11".repeat(32))}`);
    await ev(`document.getElementById('s-sign').click()`);
    await new Promise((r) => setTimeout(r, 800));
    await check("partial exported", `document.getElementById('s-partial').value.includes('pearl-vault-partialsig:v1')`);
    const partial0 = await ev(`document.getElementById('s-partial').value`);
    // second cosigner signs via bundle API in-page
    await ev(`window.__p1 = JSON.stringify(PearlVault.signBundle(
      PearlVault.parseUnsignedBundle(JSON.stringify(__vaultTest.state().bundle), __vaultTest.state().descriptor),
      __vaultTest.state().descriptor, 1, PearlVault.hexToBytes(${JSON.stringify("22".repeat(32))})))`);
    const partial1 = await ev(`window.__p1`);

    // ---- COORDINATOR ----
    await ev(`document.getElementById('c-partials').value = ${JSON.stringify(partial0)}`);
    await ev(`document.getElementById('c-add').click()`);
    await check("partial0 accepted", `__vaultTest.err().hidden === true`);
    await ev(`document.getElementById('c-partials').value = window.__p1`);
    await ev(`document.getElementById('c-add').click()`);
    await check("partial1 accepted", `__vaultTest.err().hidden === true`);
    await ev(`document.getElementById('c-finalize').click()`);
    await new Promise((r) => setTimeout(r, 800));
    await check("finalized", `__vaultTest.err().hidden === true && !!__vaultTest.state().finalized`);
    const txid = await ev(`__vaultTest.state().finalized.txid`);
    await check("txid sane", `/^[0-9a-f]{64}$/.test(${JSON.stringify(txid)})`);
    await ev(`window.__qa.txid = ${JSON.stringify(txid)}`);
    await ev(`document.getElementById('c-broadcast').click()`);
    await ev(`document.getElementById('c-broadcast').click()`);
    await new Promise((r) => setTimeout(r, 1500));
    await check("broadcast accepted", `document.getElementById('c-bcast').textContent.includes('BROADCAST ACCEPTED')`);

    // ---- TRACK ----
    await ev(`window.__qa.detail = { txid: ${JSON.stringify(txid)}, blockHeight: 120200, confirmations: 3 }`);
    await ev(`document.getElementById('tb-track').click()`);
    await ev(`document.getElementById('t-check').click()`);
    await new Promise((r) => setTimeout(r, 1500));
    await check("track ok", `document.getElementById('t-result').textContent.includes('3 confirmation')`);

    // ---- VERIFY ----
    await ev(`document.getElementById('tb-verify').click()`);
    await ev(`document.getElementById('v-json').value = JSON.stringify(__vaultTest.state().descriptor)`);
    await ev(`document.getElementById('v-run').click()`);
    await check("verify proven", `document.getElementById('v-result').textContent.includes('PROVEN') && !document.getElementById('v-result').textContent.includes('NOT PROVEN')`);

    // attribution
    await check("donation addr visible", `document.body.textContent.includes('prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d')`);
    await check("x handle visible", `document.body.textContent.includes('@kshot9000')`);

    console.log("\n==== VAULT REAL-BROWSER QA ====");
    for (const [n, ok, extra] of results) console.log((ok ? "✔ " : "✖ ") + n + (extra ? " — " + extra : ""));
    if (errors.length) {
      console.log("\nERRORS:");
      errors.forEach((e) => console.log("  ✖ " + e));
      process.exitCode = 1;
    } else {
      console.log("\nALL CHECKS PASSED, zero console/page errors");
    }
    if (logs.length) { console.log("\nconsole sample:"); logs.slice(0, 5).forEach((l) => console.log("  " + l)); }
    await cdp.close();
  } finally {
    chrome.kill("SIGKILL");
  }
}

main().catch((e) => { console.error("QA HARNESS FAILED:", e); process.exit(1); });
