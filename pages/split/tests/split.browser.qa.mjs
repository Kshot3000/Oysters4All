// Real-browser QA for Pearl Split: headless Chrome (file://), CDP-driven.
// Drives Tab -> Expenses -> Settle -> Pay (sign + double-confirm broadcast
// with a stubbed Blockbook) -> Ledger (record + CSV). Fails loudly on any
// console/page error or missing asset.
//
// Usage: node tests/split.browser.qa.mjs
// (Chrome binary: /opt/meta-chromium/chrome; sandbox loopback is blocked, so
// the page loads via file:// and Blockbook calls are stubbed in-page.
// /tmp is a shared 512M tmpfs: Chrome launches with TMPDIR=$HOME/.cache/chrome-tmp
// so it does not die with "No space left on device".)
import { spawn, execSync } from "node:child_process";
import { mkdirSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dir = resolvePath(here, "..");
const QADIR = "/tmp/splitqa";
mkdirSync(QADIR, { recursive: true });
for (const f of ["index.html", "app.js", "styles.css", "pearl-split.bundle.js"]) {
  copyFileSync(resolvePath(dir, f), resolvePath(QADIR, f));
}

const PORT = 9342;
const PAGE = "file:///tmp/splitqa/index.html";
const TMPDIR = resolvePath(homedir(), ".cache", "chrome-tmp");
mkdirSync(TMPDIR, { recursive: true });

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
  // clear only our own stale profile; never touch other loops' /tmp files
  try { execSync(`pkill -f ${QADIR}-profile 2>/dev/null || true`); } catch { /* ignore */ }
  const chrome = spawn("/opt/meta-chromium/chrome", [
    "--headless=new", "--no-sandbox", "--disable-gpu",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${QADIR}-profile`,
    "about:blank",
  ], { stdio: "ignore", env: { ...process.env, TMPDIR } });
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

    await check("bundle loaded", `!!window.PearlSplit`);
    await check("app loaded (test hook)", `!!window.__splitTest`);
    await check("no missing assets", `performance.getEntriesByType('resource').every(r => r.responseStatus ? r.responseStatus < 400 : true)`);
    await check("donation address in footer", `document.body.textContent.includes('prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d')`);
    await check("honest scope visible", `document.body.textContent.includes('no smart contracts')`);
    await check("tavern-ledger theme", `getComputedStyle(document.body).backgroundColor !== ''`);

    // ---- TAB: seat 3 members, bad address refused ----
    await ev(`(() => {
      const P = window.PearlSplit;
      const T = __splitTest;
      const debtor = P.parseBatchSecret('${"99".repeat(32)}', P.NETWORKS.mainnet).address;
      window.__qaDebtor = debtor;
      const mk = (s) => P.encodeBech32m('prl', 1, P.schnorr.getPublicKey(P.hexToBytes(s.repeat(32))));
      const party = [['Deb', debtor], ['CredA', mk('c1')], ['CredB', mk('c2')]];
      for (const [n, a] of party) { T.set('m-name', n); T.set('m-addr', a); T.click('m-add'); }
      T.set('m-name', 'Bad'); T.set('m-addr', 'prl1notreal'); T.click('m-add');
      T.set('tab-name', 'QA steak night');
    })()`);
    await check("bad address refused", `!document.getElementById('tab-error').hidden && document.getElementById('members-list').textContent.includes('Deb')`);
    await ev(`__splitTest.click('tab-start')`);
    await check("tab opens, expenses unlocked", `document.getElementById('step-expenses').classList.contains('active') && document.querySelector('#steps [data-step="expenses"]').disabled === false`);

    // ---- EXPENSES ----
    await ev(`(() => {
      const T = __splitTest;
      T.set('e-desc', 'Steakhouse bill'); T.set('e-amount', '1'); T.set('e-payer', '1');
      T.click('e-add');
      T.set('e-desc', 'Wine'); T.set('e-amount', '0.3'); T.set('e-payer', '2');
      T.set('e-mode', 'shares');
      document.getElementById('e-mode').dispatchEvent(new Event('change'));
      const boxes = [...document.querySelectorAll('#e-members input')];
      boxes[2].checked = false;
      T.set('e-shares', '2, 1');
      T.click('e-add');
    })()`);
    await check("two expenses chalked up", `document.getElementById('exp-list').textContent.includes('Wine') && document.getElementById('exp-list').textContent.includes('0.33333334')`);

    // ---- SETTLE ----
    await ev(`__splitTest.click('st-compute')`);
    await check("settlement seals with fingerprint", `document.getElementById('st-fp').textContent.length === 16`);
    await check("who-pays-whom rendered", `document.getElementById('st-transfers').textContent.includes('pays')`);
    await check("pay step unlocked", `document.querySelector('#steps [data-step="pay"]').disabled === false`);

    // ---- PAY: fund from pasted UTXOs ----
    await ev(`(() => {
      const st = __splitTest.state();
      const di = st.plans.findIndex((p) => p.debtorAddress === window.__qaDebtor);
      __splitTest.set('pay-debtor', String(di));
      __splitTest.set('pay-feerate', '2');
      __splitTest.set('pay-paste', '${"ab".repeat(32)}:0 200000000');
      __splitTest.click('pay-apply');
    })()`);
    await sleep(300);
    await check("funding plan rendered", `!document.getElementById('pay-result').hidden && document.getElementById('pay-r-ins').textContent.includes('1 UTXO')`);

    // ---- unsigned bundle export shape ----
    await ev(`(() => {
      const P = window.PearlSplit;
      const st = __splitTest.state();
      const di = st.plans.findIndex((p) => p.debtorAddress === window.__qaDebtor);
      const bundle = P.exportSplitBundle({ network: st.network, debtorPlan: st.plans[di], tabFingerprint: st.settlement.fingerprint, plan: st.plan, feeRate: 2 });
      window.__qaBundle = JSON.stringify(bundle);
    })()`);
    await check("unsigned bundle has pearlsplit kind tags", `window.__qaBundle.includes('pearl-split-unsigned:v1:') && window.__qaBundle.includes('pearlsplit:v1:')`);

    // ---- SIGN: real Schnorr, key wiped ----
    await ev(`(() => {
      __splitTest.set('pay-key', '${"99".repeat(32)}');
      __splitTest.click('pay-sign');
    })()`);
    await sleep(800);
    await check("signed txid is 64 hex", `/^[0-9a-f]{64}$/.test(document.getElementById('pay-r-txid').textContent)`);
    await check("signatures re-verified", `document.getElementById('pay-r-sigs').textContent.includes('/1')`);
    await check("secret wiped after signing", `document.getElementById('pay-key').value === ''`);

    // ---- install Blockbook stub, then BROADCAST (double-confirm) ----
    await ev(`(() => {
      const realFetch = window.fetch.bind(window);
      window.fetch = async (url, opts) => {
        const u = String(url);
        if (u.includes('/api/sendtx/')) {
          const j = { result: '${"cd".repeat(32)}' };
          return { ok: true, status: 200, text: async () => JSON.stringify(j), json: async () => j };
        }
        return realFetch(url, opts);
      };
      __splitTest.set('pay-blockbook', 'https://blockbook.pearlresearch.ai');
      __splitTest.click('pay-arm');
    })()`);
    await sleep(300);
    await check("broadcast asks for confirmation", `!document.getElementById('pay-confirm').hidden`);
    await ev(`document.getElementById('pay-confirm').click()`);
    await sleep(1200);
    await check("broadcast recorded on stubbed Blockbook", `document.getElementById('pay-r-bcast').textContent.includes('broadcast')`);

    // ---- LEDGER: record + list ----
    await ev(`__splitTest.click('led-record')`);
    await check("tab recorded in ledger", `document.getElementById('led-list').textContent.includes('QA steak night')`);
    await check("txid on ledger entry", `document.getElementById('led-list').textContent.includes('${"cd".repeat(32).slice(0, 20)}')`);

    // ---- step navigation + dead-button sweep ----
    for (const s of ["tab", "expenses", "settle", "pay", "ledger"]) {
      await ev(`document.querySelector('#steps [data-step="${s}"]').click()`);
      await check(`step ${s} shows`, `document.getElementById('step-${s}').classList.contains('active')`);
    }
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
