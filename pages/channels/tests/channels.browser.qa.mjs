// Real-browser QA for Pearl Channels: headless Chrome (file://), CDP-driven.
// Drives Open -> Fund (manual) -> State (propose/sign/assemble/activate) ->
// Close (coop build + unilateral claim build) -> Verify (descriptor + tx).
// Fails loudly on any console/page error or missing asset.
//
// Usage:
//   mkdir -p /tmp/channelsqa && cp index.html app.js styles.css pearl-channels.bundle.js /tmp/channelsqa/
//   node tests/channels.browser.qa.mjs
// (Chrome binary: /opt/meta-chromium/chrome; sandbox loopback is blocked, so
// the page loads via file:// and no network is touched.)
import { spawn } from "node:child_process";

const PORT = 9337;
const PAGE = "file:///tmp/channelsqa/index.html";

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

async function main() {
  const chrome = spawn("/opt/meta-chromium/chrome", [
    "--headless=new", "--no-sandbox", "--disable-gpu",
    `--remote-debugging-port=${PORT}`,
    "--user-data-dir=/tmp/channelsqa-profile",
    "about:blank",
  ], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 2500));

  try {
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
      results.push([name, !!v]);
      console.log((v ? "✔ " : "✖ ") + name + (extra && !v ? " — " + extra : ""));
      if (!v) errors.push(`CHECK FAILED: ${name}${extra ? " — " + extra : ""}`);
    };

    await check("bundle loaded", `!!window.PearlChannels`);
    await check("app loaded (test hook)", `!!window.__channelsTest`);
    await check("no missing assets", `performance.getEntriesByType('resource').every(r => r.responseStatus ? r.responseStatus < 400 : true)`);
    await check("donation address in footer", `document.getElementById('donate-addr').textContent.includes('prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d')`);
    await check("honest limits visible", `document.getElementById('limits').textContent.includes('watchtower')`);

    // ---- OPEN ----
    await ev(`(() => {
      const P = window.PearlChannels;
      const X = (p) => P.bytesToHex(P.schnorr.getPublicKey(P.hexToBytes(p)));
      window.__qa = {
        xA: X("11".repeat(32)), xB: X("22".repeat(32)),
        payMe: P.encodeBech32m("prl", 1, P.hexToBytes(X("33".repeat(32)))),
        payPeer: P.encodeBech32m("prl", 1, P.hexToBytes(X("44".repeat(32)))),
      };
      document.getElementById('open-mykey').value = window.__qa.xA;
      document.getElementById('open-peerkey').value = window.__qa.xB;
      document.getElementById('open-mypayout').value = window.__qa.payMe;
      document.getElementById('open-peerpayout').value = window.__qa.payPeer;
      document.getElementById('open-mycap').value = "10";
      document.getElementById('open-peercap').value = "5";
      document.getElementById('open-csv').value = "144";
      document.getElementById('open-build').click();
    })()`);
    await check("open ok", `__channelsTest.err('open-error').hidden === true`);
    await check("channel address rendered", `document.getElementById('open-address').textContent.startsWith('prl1')`);

    // ---- FUND (manual) ----
    await ev(`(() => {
      document.getElementById('fund-manualtxid').value = "${"ff".repeat(32)}";
      document.getElementById('fund-manualvout').value = "0";
      document.getElementById('fund-manualgo').click();
    })()`);
    await check("fund ok", `__channelsTest.err('fund-error').hidden === true`);
    await check("state 0 active", `__channelsTest.state().states[0].active === true`);

    // ---- STATE: propose / sign / peer sigs / assemble / activate ----
    await ev(`(() => {
      document.getElementById('pay-direction').value = "out";
      document.getElementById('pay-amount').value = "1";
      document.getElementById('pay-feerate').value = "2";
      document.getElementById('pay-propose').click();
    })()`);
    await check("propose ok", `__channelsTest.err('pay-error').hidden === true`);
    await ev(`(() => {
      document.getElementById('pay-key').value = "${"11".repeat(32)}";
      document.getElementById('pay-sign').click();
    })()`);
    await check("sign ok", `__channelsTest.err('pay-error').hidden === true`);
    await ev(`(() => {
      const P = window.PearlChannels, st = __channelsTest.state().proposal;
      document.getElementById('pay-peersig-mine').value = P.signChannelDigest("${"22".repeat(32)}", st.pair.mine.digest);
      document.getElementById('pay-peersig-theirs').value = P.signChannelDigest("${"22".repeat(32)}", st.pair.theirs.digest);
      document.getElementById('pay-assemble').click();
    })()`);
    await check("assemble ok", `__channelsTest.err('pay-error').hidden === true`);
    await ev(`document.getElementById('pay-activate').click()`);
    await check("activate ok", `__channelsTest.state().states[1].active === true`);
    await check("state 0 revoked", `__channelsTest.state().states[0].revoked === true`);
    await check("revocation box visible", `!document.getElementById('state-revokebox').hidden`);

    // ---- CLOSE: cooperative + unilateral ----
    await ev(`document.getElementById('close-coop-build').click()`);
    await check("coop build ok", `__channelsTest.err('close-coop-error').hidden === true`);
    await ev(`(() => {
      document.getElementById('close-coop-key').value = "${"11".repeat(32)}";
      document.getElementById('close-coop-sign').click();
      document.getElementById('close-coop-peersig').value =
        PearlChannels.signChannelDigest("${"22".repeat(32)}", __channelsTest.state().coop.digest);
      document.getElementById('close-coop-assemble').click();
    })()`);
    await check("coop assemble ok", `__channelsTest.err('close-coop-error').hidden === true`);
    await check("coop hex shown", `!document.getElementById('close-coop-hex').hidden`);
    await ev(`document.getElementById('close-uni-build').click()`);
    await check("claim build ok", `__channelsTest.err('close-uni-error').hidden === true`);
    await ev(`(() => {
      document.getElementById('close-uni-key').value = "${"11".repeat(32)}";
      document.getElementById('close-uni-sign').click();
    })()`);
    await check("claim sign ok", `__channelsTest.err('close-uni-error').hidden === true`);

    // ---- VERIFY ----
    await ev(`(() => {
      const st = __channelsTest.state();
      document.getElementById('verify-descriptor').value = JSON.stringify(st.chan);
      document.getElementById('verify-desc').click();
    })()`);
    await check("descriptor valid", `document.getElementById('verify-verdict').textContent === 'DESCRIPTOR VALID'`);
    await ev(`(() => {
      const st = __channelsTest.state();
      document.getElementById('verify-descriptor').value = JSON.stringify(st.chan);
      document.getElementById('verify-fundingtxid').value = "${"ff".repeat(32)}";
      document.getElementById('verify-fundingvout').value = "0";
      document.getElementById('verify-version').value = "1";
      document.getElementById('verify-mine').value = st.states[1].myBal;
      document.getElementById('verify-peer').value = st.states[1].peerBal;
      document.getElementById('verify-mypayout').value = window.__qa.payMe;
      document.getElementById('verify-feerate').value = "2";
      document.getElementById('verify-myhash').value = st.states[1].myRevokeHash160;
      document.getElementById('verify-peerhash').value = st.states[1].peerRevokeHash160;
      document.getElementById('verify-hex').value = st.states[1].signed.mine;
      document.getElementById('verify-go').click();
    })()`);
    await check("commitment PROVEN", `document.getElementById('verify-verdict').textContent === 'PROVEN'`);

    // ---- step navigation ----
    await ev(`document.querySelector('#steps [data-step="track"]').click()`);
    await check("track step shows", `document.getElementById('step-track').classList.contains('active')`);

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
