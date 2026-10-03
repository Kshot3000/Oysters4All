// Pearl Wallet headless smoke test — run:
//   node --no-warnings tests/smoke.mjs
// Drives the real index.html + bundle + app.js inside jsdom with a mocked
// network (Blockbook / CoinGecko) through: onboarding -> quiz -> password ->
// home -> send validation -> receive rotation -> settings -> backup export ->
// lock -> unlock.
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

// jsdom is a test-only dependency, kept out of this repo (it ships as a
// static site). Resolve it from, in order: a node_modules next to this
// suite, $PEARL_QA_PACKAGE (path to a package.json whose node_modules
// provides jsdom), the durable QA tools dir ~/workspace/.qa-tools, and
// the legacy /tmp install. (/tmp alone was unreliable: it is a shared
// tmpfs that gets wiped, which silently darkened this suite.)
function loadJsdom() {
  const bases = [new URL("./package.json", import.meta.url)];
  if (process.env.PEARL_QA_PACKAGE) bases.push(new URL(`file://${process.env.PEARL_QA_PACKAGE}`));
  bases.push(new URL(`file://${join(homedir(), "workspace/.qa-tools/package.json")}`));
  bases.push(new URL("file:///tmp/package.json"));
  for (const base of bases) {
    try { return createRequire(base)("jsdom"); } catch { /* try next */ }
  }
  throw new Error("jsdom not found — install it into ~/workspace/.qa-tools (npm i jsdom) or set PEARL_QA_PACKAGE");
}
const { JSDOM: JSDOMC } = loadJsdom();

const DIR = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const html = readFileSync(DIR + "/index.html", "utf8");
const dom = new JSDOMC(html, {
  url: "https://example.com/wallet/index.html",
  runScripts: "outside-only",
  pretendToBeVisual: true,
});
const { window } = dom;
const { document } = window;

// --- browser APIs jsdom lacks ---
// jsdom's window has no TextEncoder/TextDecoder globals, but the bundle's
// noble crypto calls them — lend it Node's implementations.
if (typeof window.TextEncoder === "undefined") window.TextEncoder = TextEncoder;
if (typeof window.TextDecoder === "undefined") window.TextDecoder = TextDecoder;
// jsdom ships window.crypto (Node webcrypto) as a getter-only prop — use it.
if (!window.crypto || !window.crypto.subtle) {
  Object.defineProperty(window, "crypto", { value: webcrypto, configurable: true });
}
window.confirm = () => true;
window.prompt = () => "";
if (!window.navigator.clipboard) {
  Object.defineProperty(window.navigator, "clipboard", {
    value: { writeText: async (t) => { window.__copied = t; } },
    configurable: true,
  });
}

// --- mocked network ---
const BB = "https://blockbook.pearlresearch.ai";
window.fetch = async (url, opts = {}) => {
  const u = String(url);
  const json = (obj, ok = true) => ({ ok, status: ok ? 200 : 404, json: async () => obj, text: async () => JSON.stringify(obj) });
  if (u.startsWith(BB + "/api/v2/address/")) {
    const addr = u.split("/api/v2/address/")[1].split("?")[0];
    return json({ address: addr, balance: "0", unconfirmedBalance: "0", totalReceived: "0", totalSent: "0", unconfirmedTxs: 0, txs: 0, txids: [] });
  }
  if (u.includes("/api/v2/utxo/")) return json([]);
  if (u.includes("/api/v2/estimatefee/")) return json({ result: 0.00005 });
  if (u.includes("api.coingecko.com")) return json({ "pearl-2": { usd: 2.5, usd_24h_change: 1.2 } });
  if (u === BB + "/api/sendtx/") return json({ result: "f".repeat(64) });
  return json({ error: "mock 404" }, false);
};

// --- load scripts in page order ---
for (const f of ["qrcode.min.js", "pearl-wallet.bundle.js", "app.js"]) {
  window.eval(readFileSync(DIR + "/" + f, "utf8"));
}

let pass = 0, fail = 0;
function ok(name, cond, extra = "") {
  if (cond) { pass++; }
  else { fail++; console.error("FAIL:", name, extra); }
}
const $ = (id) => document.getElementById(id);
async function waitFor(fn, ms = 15000, label = "") {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  ok("waitFor " + label, false, "timeout");
  return false;
}
const click = (elm) => elm.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const visible = (id) => { const e = $(id); return !!(e && !e.classList.contains("hidden")); };

// 1. onboarding shows (no vault yet)
ok("onboarding view active", $("view-onboarding").classList.contains("active"));
ok("welcome step visible", visible("ob-welcome"));

// 2. create -> 12 words -> seed grid
click($("btn-new"));
ok("length step", visible("ob-length"));
click(document.querySelector('[data-words="12"]'));
ok("seed step", visible("ob-seed"));
await waitFor(() => document.querySelectorAll("#seed-grid .w").length === 12, 5000, "seed grid");
const words = [...document.querySelectorAll("#seed-grid .w")].map((d) => d.textContent.replace(/^\d+\s*/, ""));
ok("12 words rendered", words.length === 12 && words.every((w) => w.length >= 3), words.join(","));

// 3. quiz — answer 3 prompts
click($("btn-seed-done"));
ok("quiz step", visible("ob-quiz"));
for (let step = 0; step < 3; step++) {
  await waitFor(() => $("quiz-prompt").textContent.includes("#"), 3000, "quiz prompt " + step);
  const m = $("quiz-prompt").textContent.match(/#(\d+)/);
  const want = words[parseInt(m[1], 10) - 1];
  const btn = [...document.querySelectorAll("#quiz-bank button")].find((b) => b.textContent === want);
  ok("quiz answer found (step " + step + ")", !!btn, "want=" + want);
  click(btn);
  await new Promise((r) => setTimeout(r, 150));
}
await waitFor(() => visible("ob-password"), 5000, "password step");

// 4. set password -> wallet created, app shows
$("pw1").value = "test-password-1";
$("pw2").value = "test-password-1";
click($("btn-finish"));
await waitFor(() => $("view-app").classList.contains("active"), 30000, "app view after finish");
ok("vault stored", !!window.localStorage.getItem("pearl-wallet:vault:v1"));
await waitFor(() => $("bal-prl").textContent.trim() !== "…" && $("bal-prl").textContent.trim() !== "—", 20000, "balance rendered");
ok("zero balance shown", $("bal-prl").textContent.trim() === "0", $("bal-prl").textContent);
ok("price chip", $("price-chip").textContent.includes("PRL"), $("price-chip").textContent);

// 5. send tab: invalid address rejected, valid accepted
click(document.querySelector('.tab[data-tab="send"]'));
ok("send tab active", $("tab-send").classList.contains("active"));
$("send-to").value = "garbage";
$("send-to").dispatchEvent(new window.Event("input", { bubbles: true }));
ok("invalid address flagged", $("send-to-err").textContent.length > 0);
const goodAddr = "prl1ppmla838yflfcsm5vr6lfgvfclf4fgn3puja70cke4wqqkl6vflaq3cn7ea";
$("send-to").value = goodAddr;
$("send-to").dispatchEvent(new window.Event("input", { bubbles: true }));
ok("valid address accepted", $("send-to-err").textContent === "");
$("send-amt").value = "1.5";
$("send-amt").dispatchEvent(new window.Event("input", { bubbles: true }));
ok("fiat estimate shows", $("send-fiat").textContent.includes("$"), $("send-fiat").textContent);
ok("fee estimate shows", $("fee-est").textContent.includes("PRL"), $("fee-est").textContent);

// 6. receive tab: address + QR + rotation
click(document.querySelector('.tab[data-tab="receive"]'));
await waitFor(() => $("recv-addr").textContent.startsWith("prl1p"), 5000, "receive address");
const addr1 = $("recv-addr").textContent;
ok("QR rendered", $("recv-qr").querySelector("img") !== null);
click($("btn-new-addr"));
await waitFor(() => $("recv-addr").textContent !== addr1 && $("recv-addr").textContent.startsWith("prl1p"), 5000, "fresh address");
const addr2 = $("recv-addr").textContent;
ok("fresh address differs", addr1 !== addr2, addr1 + " vs " + addr2);
ok("history has 2 entries", document.querySelectorAll("#addr-history .tx").length === 2);

// 7. activity tab renders empty state
click(document.querySelector('.tab[data-tab="activity"]'));
ok("activity empty state", $("tx-list").textContent.includes("No transactions"));

// 8. settings: network toggle + save
click($("btn-settings"));
ok("settings tab", $("tab-settings").classList.contains("active"));
click(document.querySelector('#seg-net button[data-net="testnet"]'));
ok("testnet pill", $("net-pill").textContent === "Testnet");
click(document.querySelector('#seg-net button[data-net="mainnet"]'));
ok("mainnet pill", $("net-pill").textContent === "Mainnet");
$("set-fiat").value = "EUR";
click($("btn-save-settings"));
ok("fiat saved", JSON.parse(window.localStorage.getItem("pearl-wallet:settings:v1")).fiat === "EUR");

// 9. backup export sheet shows vault JSON
click($("btn-export"));
await waitFor(() => $("scrim").classList.contains("open"), 3000, "export sheet");
const bakText = $("bak-text").value;
let bakJson = null;
try { bakJson = JSON.parse(bakText); } catch {}
ok("backup is vault JSON", bakJson && bakJson.v === 1 && bakJson.ct && bakJson.salt, bakText.slice(0, 60));
click($("bak-close"));

// 10. lock + unlock round-trip
click($("btn-lock-now"));
ok("locked view", $("view-lock").classList.contains("active"));
$("lock-pw").value = "wrong-pw";
click($("btn-unlock"));
await waitFor(() => $("lock-err").textContent.length > 0, 15000, "wrong pw error");
ok("wrong password rejected", $("lock-err").textContent.includes("Wrong password"));
$("lock-pw").value = "test-password-1";
click($("btn-unlock"));
await waitFor(() => $("view-app").classList.contains("active"), 30000, "unlock");
ok("unlocked OK", $("view-app").classList.contains("active"));

// 11. funded send flow: mock a funded receive address, then review + broadcast
click(document.querySelector('.tab[data-tab="receive"]'));
await waitFor(() => $("recv-addr").textContent.startsWith("prl1p"), 5000, "recv addr after unlock");
const fundedAddr = $("recv-addr").textContent;
// wait for the post-unlock auto-sync to finish (balance rendered) so our
// manual refresh isn't skipped by the `syncing` guard
click(document.querySelector('.tab[data-tab="home"]'));
await waitFor(() => $("bal-prl").textContent.trim() === "0", 25000, "post-unlock sync settled");
window.__mockLog = [];
window.fetch = async (url, opts = {}) => {
  const u = String(url);
  const json = (obj, ok = true) => ({ ok, status: ok ? 200 : 404, json: async () => obj, text: async () => JSON.stringify(obj) });
  if (u.startsWith(BB + "/api/v2/address/")) {
    const addr = u.split("/api/v2/address/")[1].split("?")[0];
    window.__mockLog.push("addr:" + addr.slice(0, 16) + (addr === fundedAddr ? "=FUNDED" : ""));
    if (addr === fundedAddr)
      return json({ address: addr, balance: "250000", unconfirmedBalance: "0", totalReceived: "250000", totalSent: "0", unconfirmedTxs: 0,
        txs: [{ txid: "d".repeat(64), blockHeight: 12345, blockTime: 1727000000, confirmations: 6, fees: "500",
                vout: [{ value: "250000", addresses: [fundedAddr] }], vin: [] }] });
    return json({ address: addr, balance: "0", unconfirmedBalance: "0", totalReceived: "0", totalSent: "0", unconfirmedTxs: 0, txs: [] });
  }
  if (u.includes("/api/v2/utxo/")) {
    const addr = u.split("/api/v2/utxo/")[1].split("?")[0];
    if (addr === fundedAddr) return json([{ txid: "e".repeat(64), vout: 0, value: 250000, confirmations: 6 }]);
    return json([]);
  }
  if (u.includes("/api/v2/estimatefee/")) return json({ result: 0.00005 });
  if (u.includes("api.coingecko.com")) return json({ "pearl-2": { usd: 2.5, usd_24h_change: 1.2 } });
  if (u === BB + "/api/sendtx/") {
    window.__broadcastHex = (opts && opts.body) || "";
    return json({ result: "f".repeat(64) });
  }
  return json({ error: "mock 404" }, false);
};
click($("btn-refresh"));
await waitFor(() => $("bal-prl").textContent.trim() === "0.0025", 25000, "funded balance");
console.log("MOCKLOG fundedAddr=" + fundedAddr.slice(0, 20) + " queries=" + window.__mockLog.length +
  " fundedHits=" + window.__mockLog.filter((x) => x.includes("FUNDED")).length);
ok("funded balance 0.0025 PRL", $("bal-prl").textContent.trim() === "0.0025", $("bal-prl").textContent);

click(document.querySelector('.tab[data-tab="send"]'));
$("send-to").value = goodAddr;
$("send-to").dispatchEvent(new window.Event("input", { bubbles: true }));
$("send-amt").value = "0.001";
$("send-amt").dispatchEvent(new window.Event("input", { bubbles: true }));
click($("btn-review"));
await waitFor(() => $("scrim").classList.contains("open") && $("sheet-body").textContent.includes("Confirm send"), 25000, "confirm sheet");
ok("confirm sheet", $("sheet-body").textContent.includes("Confirm send"));
ok("sheet shows amount", $("sheet-body").textContent.includes("0.001 PRL"));
ok("sheet shows fee", /Network fee/.test($("sheet-body").textContent));
ok("sheet shows txid", /[0-9a-f]{64}/.test($("sheet-body").textContent));
click($("sheet-broadcast"));
await waitFor(() => $("sheet-body").textContent.includes("Sent"), 25000, "sent sheet");
ok("broadcast success sheet", $("sheet-body").textContent.includes("Sent"));
ok("txid f…f shown", $("sheet-body").textContent.includes("f".repeat(16)));
ok("broadcast posted hex", (window.__broadcastHex || "").length > 200, String((window.__broadcastHex || "").length));
click($("sheet-done"));
ok("back to activity", $("tab-activity").classList.contains("active"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);