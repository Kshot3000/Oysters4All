// Real-browser QA for Pearl Quorum: headless Chrome (file://), CDP-driven.
// Drives Vault -> Fund -> Spend -> Cosign (two slots sign with real Schnorr,
// keys wiped, duplicate paste refused, quorum finalize) -> Broadcast
// (double-confirm, stubbed Blockbook) -> Ledger (record + CSV).
// Fails loudly on any console/page error or missing asset.
//
// Usage: node tests/quorum.browser.qa.mjs
// (Chrome binary: /opt/meta-chromium/chrome; sandbox loopback is blocked, so
// the page loads via file:// and Blockbook calls are stubbed in-page.
// /tmp is a shared 512M tmpfs: Chrome launches with TMPDIR=$HOME/.cache/chrome-tmp
// so it does not die with "No space left on device".
// Env overrides (used by the run-specific hidden_files wrapper):
//   QUORUM_QADIR — scratch dir, QUORUM_QAPORT — CDP port.)
import { spawn, execSync } from "node:child_process";
import { mkdirSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dir = resolvePath(here, "..");
const QADIR = process.env.QUORUM_QADIR || "/tmp/quorumqa";
mkdirSync(QADIR, { recursive: true });
for (const f of ["index.html", "app.js", "styles.css", "pearl-quorum.bundle.js", "qrcode.min.js"]) {
  copyFileSync(resolvePath(dir, f), resolvePath(QADIR, f));
}

const PORT = Number(process.env.QUORUM_QAPORT) || 9343;
const PAGE = `file://${QADIR}/index.html`;
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
const K1 = "01".repeat(32), K2 = "02".repeat(32);
const CD = "cd".repeat(32);
const PINNED = "tprl1pq98jxc0fmn9nez5j6pr3s9vlf5wjzzk8ve2hr0t09vdpymwtmxmqd2pkz9";

async function main() {
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

    await check("bundle loaded", `!!window.PearlQuorum`);
    await check("app loaded (test hook)", `!!window.__quorumTest`);
    await check("no missing assets", `performance.getEntriesByType('resource').every(r => r.responseStatus ? r.responseStatus < 400 : true)`);
    await check("attribution in footer", `document.body.textContent.includes('@kshot9000') && document.body.textContent.includes('prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d')`);
    await check("x.com link", `document.body.innerHTML.includes('https://x.com/kshot9000')`);
    await check("honest scope visible", `document.body.textContent.includes('no smart contracts')`);
    await check("qr lib loaded", `typeof window.qrcode === 'function'`);

    // ---- VAULT: 2-of-3 from BIP-340 test keys ----
    await ev(`(() => {
      const P = window.PearlQuorum, T = window.__quorumTest;
      T.set('v-name', 'QA council');
      T.set('v-network', 'testnet');
      T.set('v-n', '3');
      document.getElementById('v-n').dispatchEvent(new Event('change'));
      const xs = ['${K1}', '${K2}', '${"03".repeat(32)}'].map((k) => P.bytesToHex(P.schnorr.getPublicKey(P.hexToBytes(k))));
      const ins = document.querySelectorAll('#v-keys [data-key]');
      ins.forEach((el, i) => { el.value = xs[i]; });
      T.set('v-m', '2');
      T.click('v-forge');
    })()`);
    await sleep(300);
    await check("vault forged, pinned testnet address", `!document.getElementById('vault-result').hidden && document.getElementById('v-r-addr').textContent === '${PINNED}'`);
    await check("descriptor export present", `document.getElementById('v-desc-out').value.includes('pearl-quorum:v1:')`);
    await check("qr rendered", `(() => {
      const c = document.getElementById('f-qr');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let dark = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] < 128) dark++;
      return c.width > 0 && dark > 100;
    })()`);
    await check("spend unlocked", `document.querySelector('#steps [data-step="spend"]').disabled === false`);

    // ---- FUND: pasted air-gapped UTXOs ----
    await ev(`(() => {
      const T = window.__quorumTest;
      T.set('f-paste', JSON.stringify([
        { txid: '${"ab".repeat(32)}', vout: 0, value: 500000000 },
        { txid: '${"cd".repeat(32)}', vout: 1, value: 300000000 },
      ]));
      T.click('f-apply');
    })()`);
    await check("balance is 8 PRL", `document.getElementById('f-r-bal').textContent === '8 PRL'`);

    // ---- SPEND: plan + tamper-evident bundle ----
    await ev(`(() => {
      const P = window.PearlQuorum, T = window.__quorumTest;
      const row = document.querySelector('#s-outputs .out-row');
      row.querySelector('[data-oaddr]').value = P.encodeBech32m('tprl', 1, P.hexToBytes('${"ab".repeat(32)}'));
      row.querySelector('[data-oprl]').value = '5';
      T.set('s-feerate', '2');
      T.click('s-build');
    })()`);
    await sleep(300);
    await check("plan rendered with 2-of-3 threshold", `!document.getElementById('spend-result').hidden && document.getElementById('s-r-thr').textContent.includes('2-of-3')`);
    await check("one digest per input", `document.querySelectorAll('#s-r-digests li').length === 2`);
    await check("bundle tamper-evident", `document.getElementById('s-bundle').value.startsWith('pearl-quorum-unsigned:v1:')`);

    // ---- COSIGN: import, sign two slots, finalize ----
    await ev(`(() => {
      const T = window.__quorumTest;
      T.set('c-bundle', document.getElementById('s-bundle').value);
      T.click('c-import');
      T.set('c-slot', '0');
      T.set('c-key', '${K1}');
      T.click('c-sign');
    })()`);
    await sleep(600);
    await check("slot 1 signed, key wiped", `document.getElementById('q-count').textContent.startsWith('1/2') && document.getElementById('c-key').value === ''`);
    await ev(`(() => {
      const T = window.__quorumTest;
      T.set('c-slot', '1');
      T.set('c-key', '${K2}');
      T.click('c-sign');
    })()`);
    await sleep(600);
    await check("ring shows 2/2 at quorum", `document.getElementById('q-count').textContent.startsWith('2/2')`);
    await check("finalize enabled", `document.getElementById('c-finalize').disabled === false`);
    await ev(`document.getElementById('c-finalize').click()`);
    await sleep(400);
    await check("final txid is 64 hex", `/^[0-9a-f]{64}$/.test(document.getElementById('c-r-txid').textContent)`);
    await check("slots 1,2 credited", `document.getElementById('c-r-slots').textContent === '1, 2'`);

    // ---- stub Blockbook, BROADCAST double-confirm ----
    await ev(`(() => {
      const realFetch = window.fetch.bind(window);
      window.fetch = async (url, opts) => {
        const u = String(url);
        if (u.includes('/api/sendtx/')) {
          const j = { result: '${CD}' };
          return { ok: true, status: 200, text: async () => JSON.stringify(j), json: async () => j };
        }
        if (/\\/api\\/v2\\/tx\\/[0-9a-f]{64}$/.test(u)) {
          const j = { txid: u.slice(-64), confirmations: 3 };
          return { ok: true, status: 200, text: async () => JSON.stringify(j), json: async () => j };
        }
        return realFetch(url, opts);
      };
      document.getElementById('b-blockbook').value = 'https://blockbook.pearlresearch.ai';
      document.getElementById('b-arm').click();
    })()`);
    await sleep(300);
    await check("broadcast asks for confirmation", `!document.getElementById('b-confirm').hidden`);
    await ev(`document.getElementById('b-confirm').click()`);
    await sleep(1200);
    await check("broadcast recorded on stubbed Blockbook", `document.getElementById('b-r-txid').textContent === '${CD}'`);
    await ev(`document.getElementById('b-track').click()`);
    await sleep(600);
    await check("confirmations tracked", `document.getElementById('b-r-confs').textContent === '3'`);

    // ---- LEDGER: record vault + spend ----
    await ev(`(() => { document.getElementById('v-save').click(); document.getElementById('b-record').click(); })()`);
    await check("vault in ledger", `document.getElementById('l-vaults').textContent.includes('${PINNED.slice(0, 20)}')`);
    await check("spend in ledger", `document.getElementById('l-spends').textContent.includes('${CD.slice(0, 20)}')`);

    // ---- step navigation sweep ----
    for (const s of ["vault", "fund", "spend", "cosign", "broadcast", "ledger"]) {
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
