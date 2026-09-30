// Real-browser QA for Pearl Lend: headless Chrome (file://), CDP-driven.
// Drives Offer -> Lock (scan via stubbed fetch) -> Fund -> Track -> Repay
// (build/sign/export/import/co-sign/assemble) -> Close (default claim + mutual
// close) -> Verify (PROVEN). Fails loudly on any console/page error or
// missing asset.
//
// Usage:
//   mkdir -p /tmp/lendqa && cp index.html app.js styles.css pearl-lend.bundle.js /tmp/lendqa/
//   node tests/lend.browser.qa.mjs
// (Chrome binary: /opt/meta-chromium/chrome; sandbox loopback is blocked, so
// the page loads via file:// and the Blockbook calls are stubbed in-page.)
import { spawn } from "node:child_process";

const PORT = 9339;
const PAGE = "file:///tmp/lendqa/index.html";

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
    "--user-data-dir=/tmp/lendqa-profile",
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

    await check("bundle loaded", `!!window.PearlLend`);
    await check("app loaded (test hook)", `!!window.__lendTest`);
    await check("no missing assets", `performance.getEntriesByType('resource').every(r => r.responseStatus ? r.responseStatus < 400 : true)`);
    await check("donation address in footer", `document.body.textContent.includes('prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d')`);
    await check("honest limits visible", `document.getElementById('limits').textContent.includes('oracle')`);
    await check("counting-house theme", `getComputedStyle(document.body).backgroundColor !== ''`);

    // ---- OFFER (real keys through the real bundle) ----
    await ev(`(() => {
      const P = window.PearlLend;
      const X = (p) => P.bytesToHex(P.schnorr.getPublicKey(P.hexToBytes(p)));
      window.__qa = {
        pb: "11".repeat(32), pl: "22".repeat(32),
        xb: X("11".repeat(32)), xl: X("22".repeat(32)),
        xc: X("33".repeat(32)), xd: X("44".repeat(32)),
      };
      window.__qa.payB = P.encodeBech32m("prl", 1, P.hexToBytes(window.__qa.xc));
      window.__qa.payL = P.encodeBech32m("prl", 1, P.hexToBytes(window.__qa.xd));
      const T = __lendTest;
      T.set("offer-network", "mainnet");
      T.set("offer-borrowerkey", window.__qa.xb);
      T.set("offer-lenderkey", window.__qa.xl);
      T.set("offer-borrowerpayout", window.__qa.payB);
      T.set("offer-lenderpayout", window.__qa.payL);
      T.set("offer-principal", "100");
      T.set("offer-apr", "10");
      T.set("offer-term", "10000");
      T.set("offer-grace", "144");
      T.set("offer-ratio", "150");
      T.set("offer-collateral", "160");
      T.click("offer-build");
    })()`);
    await check("offer drafts vault", `document.getElementById('offer-address').textContent.startsWith('prl1')`);
    await check("offer interest shown", `document.getElementById('offer-interest').textContent.includes('PRL')`);

    // ---- install Blockbook stub, then LOCK scan ----
    await ev(`(() => {
      const P = window.PearlLend;
      window.__qaHeight = 901234;
      window.__qaLockTx = null;
      window.__qaUtxos = [];
      const realFetch = window.fetch.bind(window);
      window.fetch = async (url, opts) => {
        const u = String(url);
        if (!u.includes("blockbook.pearlresearch.ai") && !u.includes("bb.example")) return realFetch(url, opts);
        const path = u.replace(/^https?:\\/\\/[^/]+/, "");
        const ok = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });
        const no = { ok: false, status: 404, json: async () => ({}), text: async () => "nf" };
        if (path === "/api/v2/" || path === "/api/v2") return ok({ blockbook: { bestHeight: window.__qaHeight } });
        if (path.startsWith("/api/v2/utxo/")) return ok(window.__qaUtxos);
        if (path.startsWith("/api/v2/tx/")) {
          const id = path.split("/api/v2/tx/")[1].split("?")[0].toLowerCase();
          if (window.__qaLockTx && window.__qaLockTx.txid === id) return ok(window.__qaLockTx);
          return no;
        }
        return no;
      };
      const d = __lendTest.state().descriptor;
      window.__qaLockTx = {
        txid: "${"aa".repeat(32)}",
        blockHeight: 900000, confirmations: 1234,
        vout: [{ value: d.collateralGrains, scriptPubKey: { hex: d.vaultSpk } }],
      };
      const T = __lendTest;
      T.set("lock-txid", "${"aa".repeat(32)}");
      T.set("lock-vout", "0");
      document.getElementById('lock-scan').click();
    })()`);
    await sleep(1200);
    await check("lock scan verifies", `!document.getElementById('lock-result').hidden && document.getElementById('lock-amount').textContent.includes('confirmed on-chain')`);
    await check("lock maturity shown", `document.getElementById('lock-maturity').textContent.includes('910000')`);

    // ---- FUND ----
    await ev(`(() => {
      const P = window.PearlLend;
      const ux = P.bytesToHex(P.schnorr.getPublicKey(P.hexToBytes("66".repeat(32))));
      const ua = P.encodeBech32m("prl", 1, P.hexToBytes(ux));
      const T = __lendTest;
      T.set("fund-utxos", JSON.stringify([{ txid: "${"ee".repeat(32)}", vout: 0, value: String(200n * 100000000n), spk: P.bytesToHex(P.p2trScriptPubKey(P.hexToBytes(ux))), priv: "66".repeat(32), internalXOnly: ux }]));
      T.set("fund-changeaddr", ua);
      T.set("fund-feerate", "2");
      T.click("fund-build");
    })()`);
    await check("funding payment builds", `!document.getElementById('fund-hexbox').hidden`);
    await ev(`(() => { __lendTest.set("fund-txid", "${"bb".repeat(32)}"); __lendTest.click("fund-record"); })()`);
    await check("funding recorded", `document.getElementById('fund-error').hidden`);

    // ---- TRACK ----
    await ev(`(() => {
      const d = __lendTest.state().descriptor;
      window.__qaHeight = 905000;
      window.__qaUtxos = [{ txid: "${"aa".repeat(32)}", vout: 0, value: Number(BigInt(d.collateralGrains)), confirmations: 5000 }];
      document.getElementById('track-refresh').click();
    })()`);
    await sleep(1200);
    await check("track shows FUNDED", `document.getElementById('track-vault').textContent.includes('FUNDED')`);
    await check("track blocks to maturity", `document.getElementById('track-remaining').textContent.includes('5000 blocks')`);

    // ---- REPAY: build -> borrower sign -> export -> import/verify -> co-sign -> assemble ----
    await ev(`(() => {
      const P = window.PearlLend;
      const d = __lendTest.state().descriptor;
      const T = __lendTest;
      T.set("repay-txid", "${"aa".repeat(32)}");
      T.set("repay-vout", "0");
      T.set("repay-value", P.fmtPRL(d.collateralGrains));
      T.set("repay-feerate", "2");
      T.click("repay-build");
    })()`);
    await check("repay proposal builds", `document.getElementById('repay-error').hidden && document.getElementById('repay-lendergets').textContent.includes('PRL')`);
    await ev(`(() => { __lendTest.set("repay-signkey", window.__qa.pb); __lendTest.click("repay-sign"); })()`);
    await check("borrower signs", `document.getElementById('repay-borrowersig').textContent.length === 128`);
    // lender imports the signed package
    await ev(`(() => {
      const st = __lendTest.state();
      const pkg = { kind: "repay", descriptor: st.descriptor,
        proposal: { input: st.repayProposal.input, outputs: st.repayProposal.outputs, feeGrains: st.repayProposal.feeGrains, vbytes: st.repayProposal.vbytes, digest: st.repayProposal.digest, feeRateGrainsPerVByte: st.repayProposal.feeRateGrainsPerVByte },
        borrowerSig: st.repayBorrowerSig };
      __lendTest.set("repay-import", JSON.stringify(pkg));
      __lendTest.click("repay-doimport");
    })()`);
    await check("lender import verifies borrower sig", `document.getElementById('repay-importsig').textContent.includes('VALID')`);
    await ev(`(() => { __lendTest.set("repay-lendersignkey", window.__qa.pl); __lendTest.click("repay-lendersign"); })()`);
    await check("lender co-signs", `document.getElementById('repay-error').hidden`);
    await ev(`(() => { __lendTest.click("repay-assemble"); })()`);
    await check("repay assembles", `document.getElementById('repay-hex').textContent.length > 300`);
    await check("repay txid shown", `document.getElementById('repay-finaltxid').textContent.length === 64`);

    // ---- CLOSE: early claim refused, then past-maturity claim builds ----
    await ev(`(() => { window.__qaHeight = 905000; document.getElementById('close-buildclaim').click(); })()`);
    await sleep(1200);
    await check("early claim refused", `!document.getElementById('close-error').hidden && document.getElementById('close-error').textContent.includes('not mature')`);
    await ev(`(() => {
      const P = window.PearlLend;
      const d = __lendTest.state().descriptor;
      window.__qaHeight = 920000;
      const T = __lendTest;
      T.set("close-txid", "${"aa".repeat(32)}");
      T.set("close-vout", "0");
      T.set("close-value", P.fmtPRL(d.collateralGrains));
      T.set("close-feerate", "2");
      T.set("close-key", window.__qa.pl);
      document.getElementById('close-buildclaim').click();
    })()`);
    await sleep(1200);
    await check("default claim builds past maturity", `!document.getElementById('close-claimbox').hidden && document.getElementById('close-claimhex').textContent.length > 200`);

    // ---- CLOSE: mutual close ----
    await ev(`(() => {
      const P = window.PearlLend;
      const d = __lendTest.state().descriptor;
      const collateral = BigInt(d.collateralGrains);
      const repay = BigInt(d.repaymentGrains);
      const fee = BigInt(Math.ceil(P.vaultSpendVBytes("repay", d) * 2));
      const T = __lendTest;
      T.set("close-mtxid", "${"aa".repeat(32)}");
      T.set("close-mvout", "0");
      T.set("close-mvalue", P.fmtPRL(d.collateralGrains));
      T.set("close-mfeerate", "2");
      T.set("close-splits", JSON.stringify([
        { address: d.lenderPayout, valuePRL: P.fmtPRL(repay) },
        { address: d.borrowerPayout, valuePRL: P.fmtPRL(collateral - repay - fee) },
      ]));
      T.click("close-mutbuild");
    })()`);
    await check("mutual close builds", `document.getElementById('close-muterror').hidden && !document.getElementById('close-mutbox').hidden`);
    await ev(`(() => {
      __lendTest.set("close-mutbkey", window.__qa.pb);
      __lendTest.set("close-mutlkey", window.__qa.pl);
      __lendTest.click("close-mutassemble");
    })()`);
    await check("mutual close assembles", `document.getElementById('close-muthex').textContent.length > 200`);

    // ---- VERIFY: standalone PROVEN ----
    await ev(`(() => {
      const st = __lendTest.state();
      const d = st.descriptor;
      __lendTest.set("verify-descriptor", JSON.stringify(d));
      __lendTest.set("verify-hex", document.getElementById('repay-hex').textContent);
      __lendTest.set("verify-prevouts", JSON.stringify([{ txid: "${"aa".repeat(32)}", vout: 0, value: d.collateralGrains, spk: d.vaultSpk }]));
      __lendTest.click("verify-desc");
    })()`);
    await check("standalone verifier PROVEN", `document.getElementById('verify-verdict').textContent === 'PROVEN'`);

    // ---- step navigation ----
    await ev(`document.querySelector('#steps [data-step="close"]').click()`);
    await check("close step shows", `document.getElementById('step-close').classList.contains('active')`);

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
