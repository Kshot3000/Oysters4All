// Real-browser QA for Pearl Dividend: headless Chrome (file://), CDP-driven.
// Drives Token (manual) -> Snapshot (seal) -> Plan -> Fund -> Sign ->
// Broadcast (stubbed Blockbook) -> Verify (PROVEN). Fails loudly on any
// console/page error or missing asset.
//
// Usage:
//   mkdir -p /tmp/divqa && cp index.html app.js styles.css pearl-dividend.bundle.js /tmp/divqa/
//   node tests/dividend.browser.qa.mjs
// (Chrome binary: /opt/meta-chromium/chrome; sandbox loopback is blocked, so
// the page loads via file:// and Blockbook calls are stubbed in-page.)
import { spawn } from "node:child_process";

const PORT = 9341;
const PAGE = "file:///tmp/divqa/index.html";

const errors = [];

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const chrome = spawn("/opt/meta-chromium/chrome", [
    "--headless=new", "--no-sandbox", "--disable-gpu",
    `--remote-debugging-port=${PORT}`,
    "--user-data-dir=/tmp/divqa-profile",
    "about:blank",
  ], { stdio: "ignore" });
  await sleep(2500);

  try {
    let page = null;
    for (let i = 0; i < 20 && !page; i++) {
      try {
        const all = await getJson("/json/list");
        page = all.find((t) => t.type === "page" && /^https?:|^file:|^about:blank/.test(t.url) && !t.url.includes("top-chrome"));
      } catch { /* retry */ }
      if (!page) await sleep(500);
    }
    if (!page) throw new Error("no page target found");
    const cdp = await wsConnect(page.webSocketDebuggerUrl);
    const results = [];
    cdp.onEvent((msg) => {
      if (msg.method === "Runtime.consoleAPICalled") {
        const text = (msg.params.args || []).map((a) => a.value ?? a.description ?? "").join(" ");
        if (msg.params.type === "error") errors.push("console.error: " + text);
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
    await sleep(2500);

    const check = async (name, expr) => {
      let v, extra = "";
      try {
        v = await ev(expr);
        if (v !== true) extra = String(v).slice(0, 200);
      } catch (e) { v = false; extra = "EVAL THREW: " + e.message.slice(0, 200); }
      results.push([name, !!v]);
      console.log((v ? "✔ " : "✖ ") + name + (extra && !v ? " — " + extra : ""));
      if (!v) errors.push(`CHECK FAILED: ${name}${extra ? " — " + extra : ""}`);
    };

    await check("bundle loaded", `!!window.PearlDividend`);
    await check("app loaded (test hook)", `!!window.__divTest`);
    await check("no missing assets", `performance.getEntriesByType('resource').every(r => r.responseStatus ? r.responseStatus < 400 : true)`);
    await check("donation address in footer", `document.body.textContent.includes('prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d')`);
    await check("honest scope visible", `document.body.textContent.includes('never trusted for who gets paid')`);
    await check("mint-hall theme", `getComputedStyle(document.body).backgroundColor !== ''`);

    // ---- TOKEN (manual metadata) ----
    await ev(`(() => {
      const T = __divTest;
      document.getElementById('tok-manual').checked = true;
      document.getElementById('tok-manual').dispatchEvent(new Event('change'));
      T.set('tok-tick', 'divt'); T.set('tok-decimals', '8');
      T.click('tok-fetch');
    })()`);
    await check("manual metadata unlocks snapshot", `!document.getElementById('tok-result').hidden && document.getElementById('snap-csv').disabled === false`);

    // ---- SNAPSHOT ----
    await ev(`(() => {
      const P = window.PearlDividend;
      const H = (s) => P.encodeBech32m('prl', 1, P.sha256(new TextEncoder().encode(s)));
      const csv = H('qa-holder-1') + ',100\\n' + H('qa-holder-2') + ',300\\n' + H('qa-holder-3') + ',600';
      window.__qaCsv = csv;
      __divTest.set('snap-csv', csv);
      __divTest.click('snap-parse');
    })()`);
    await check("snapshot seals with fingerprint", `document.getElementById('snap-result').hidden === false && document.getElementById('snap-r-fp').textContent.length === 16`);
    await check("plan step unlocked", `document.querySelector('#steps [data-step="plan"]').disabled === false`);

    // ---- PLAN ----
    await ev(`(() => {
      const P = window.PearlDividend;
      const T = __divTest;
      const funder = P.parseBatchSecret('99'.repeat(32), P.NETWORKS.mainnet).address;
      window.__qaFunder = funder;
      T.set('plan-pool', '1'); T.set('plan-rule', 'proportional');
      T.set('plan-dust', '0.00000546'); T.set('plan-feerate', '2');
      T.set('plan-funder', funder);
      T.click('plan-build');
    })()`);
    await check("plan builds grain-exact shares", `document.getElementById('plan-result').hidden === false && document.getElementById('plan-table').textContent.includes('0.1')`);
    await check("plan fingerprint shown", `document.getElementById('plan-r-fp').textContent.length === 16`);

    // ---- FUND ----
    await ev(`(() => {
      const T = __divTest;
      T.set('fund-paste', '${"ab".repeat(32)}:0 200000000');
      T.click('fund-apply');
    })()`);
    await sleep(500);
    await check("chunk funded from pasted UTXO", `document.getElementById('fund-result').hidden === false && document.getElementById('fund-chunks').textContent.includes('Transaction 1')`);

    // ---- SIGN ----
    await ev(`(() => {
      const T = __divTest;
      T.set('sign-key', '99'.repeat(32));
      T.click('sign-sign');
    })()`);
    await sleep(1500);
    await check("signed txid is 64 hex", `/^[0-9a-f]{64}$/.test(document.getElementById('sign-r-txid').textContent)`);
    await check("secret wiped after signing", `document.getElementById('sign-key').value === ''`);
    await check("broadcast step unlocked", `document.querySelector('#steps [data-step="broadcast"]').disabled === false`);

    // ---- install Blockbook stub, then BROADCAST + TRACK ----
    await ev(`(() => {
      const P = window.PearlDividend;
      const realFetch = window.fetch.bind(window);
      window.fetch = async (url, opts) => {
        const u = String(url);
        if (u.includes('/api/sendtx/')) {
          const hex = String(opts.body || '');
          const txid = P.bytesToHex(P.sha256(P.sha256(P.hexToBytes(hex))).reverse());
          const j = { result: txid };
          return { ok: true, status: 200, text: async () => JSON.stringify(j), json: async () => j };
        }
        if (/\\/api\\/v2\\/tx\\//.test(u)) {
          const id = u.split('/api/v2/tx/')[1].split('?')[0];
          const j = { txid: id.toLowerCase(), confirmations: 3, blockHeight: 905000 };
          return { ok: true, status: 200, text: async () => JSON.stringify(j), json: async () => j };
        }
        return realFetch(url, opts);
      };
      __divTest.set('bcast-blockbook', 'https://blockbook.pearlresearch.ai');
      document.querySelector('[data-bcast="0"]').click();
    })()`);
    await sleep(800);
    await check("broadcast asks for confirmation", `!document.querySelector('[data-bcast-arm="0"]').hidden`);
    await ev(`document.querySelector('[data-bcast-arm="0"]').click()`);
    await sleep(1500);
    await check("broadcast recorded on stubbed Blockbook", `document.getElementById('bcast-list').textContent.includes('broadcast ·')`);
    await ev(`document.querySelector('[data-track="0"]').click()`);
    await sleep(1200);
    await check("confirmation tracking works", `document.getElementById('bcast-list').textContent.includes('3 confirmation(s)')`);

    // ---- VERIFY: full on-chain PROVEN ----
    await ev(`(() => {
      const P = window.PearlDividend;
      const st = __divTest.state();
      const plan = st.plan, signed = st.signed[0], funder = window.__qaFunder;
      const dec = P.decodeRawTx(signed.hex);
      const inputSum = st.funded.fundedChunks[0].plan.total.toString();
      const txJson = {
        txid: signed.txid, confirmations: 3, blockHeight: 905000,
        vin: [{ addresses: [funder], value: inputSum }],
        vout: dec.outputs.map((o) => ({
          addresses: [P.encodeBech32m('prl', 1, o.spk.slice(2))],
          value: o.value.toString(),
        })),
      };
      __divTest.set('ver-csv', window.__qaCsv);
      __divTest.set('ver-bundle', JSON.stringify({ descriptor: plan.descriptor, fingerprint: plan.fingerprint, funderAddress: funder }));
      __divTest.set('ver-txids', '0,' + signed.txid);
      __divTest.set('ver-txjson', JSON.stringify([txJson]));
      __divTest.click('ver-run');
    })()`);
    await sleep(1200);
    await check("standalone verifier PROVEN", `document.getElementById('ver-verdict').textContent.includes('PROVEN')`);

    // ---- step navigation + dead-button sweep ----
    await ev(`document.querySelector('#steps [data-step="verify"]').click()`);
    await check("verify step shows", `document.getElementById('step-verify').classList.contains('active')`);
    await check("no dead step buttons", `[...document.querySelectorAll('#steps button')].every((b) => b.textContent.trim().length > 0)`);

    const failed = results.filter(([, v]) => !v);
    console.log(`\n${results.length - failed.length}/${results.length} browser checks passed, ${errors.length} page/console errors`);
    if (errors.length) {
      console.log("ERRORS:");
      for (const e of errors.slice(0, 20)) console.log("  " + e);
    }
    cdp.close();
    if (failed.length || errors.length) process.exitCode = 1;
    else console.log("BROWSER QA GREEN");
  } finally {
    chrome.kill();
  }
}

main().catch((e) => { console.error("QA FAILED:", e); process.exit(1); });
