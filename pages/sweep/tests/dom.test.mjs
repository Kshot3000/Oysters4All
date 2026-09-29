// Pearl Sweep DOM integration test — boots the real index.html + committed
// bundle (pearl-sweep.bundle.js) + app.js against a minimal DOM shim and a
// stubbed Blockbook fetch. Drives: invalid address -> loud error; analyze ->
// dashboard; absurd fee rate -> loud refusal; sane plan -> WIF sign -> N/N
// signatures re-verified; wrong key refused; wipe; re-scan verify;
// standalone verifier; footer attribution.
// Run: node --no-warnings --loader ./tests/loader.mjs tests/dom.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { TextEncoder, TextDecoder } from "node:util";
import { webcrypto } from "node:crypto";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dir = resolvePath(here, "..");
const html = fs.readFileSync(resolvePath(dir, "index.html"), "utf8");

/* ---------- minimal DOM (same lineage as the other apps' DOM suites) ---------- */
class ClassList {
  constructor() { this.s = new Set(); }
  add(...c) { c.forEach((x) => this.s.add(x)); }
  remove(...c) { c.forEach((x) => this.s.delete(x)); }
  toggle(c, f) { (f ?? !this.s.has(c)) ? this.s.add(c) : this.s.delete(c); }
  contains(c) { return this.s.has(c); }
}
class El {
  constructor(tag, id = "") {
    this.tagName = tag.toUpperCase(); this.id = id;
    this.classList = new ClassList(); this.dataset = {};
    this.value = ""; this.textContent = ""; this._html = "";
    this.hidden = false; this.disabled = false; this.checked = false;
    this.style = {}; this._handlers = {}; this._kids = [];
    this.scrollTop = 0; this.scrollHeight = 0;
  }
  set innerHTML(v) { this._html = String(v); this._kids = []; }
  get innerHTML() { return this._html; }
  addEventListener(t, fn) { (this._handlers[t] ??= []).push(fn); }
  click() { (this._handlers.click || []).forEach((f) => f({ target: this, preventDefault() {} })); }
  fire(t, extra = {}) { (this._handlers[t] || []).forEach((f) => f({ target: this, preventDefault() {}, ...extra })); }
  appendChild(k) { this._kids.push(k); return k; }
  removeChild(k) { this._kids = this._kids.filter((x) => x !== k); return k; }
  remove() {}
  get children() { return this._kids; }
  get firstChild() { return this._kids[0]; }
  querySelectorAll() { return []; }
  querySelector() { return null; }
  scrollIntoView() {}
  select() {}
}
const byId = new Map();
const hiddenIds = new Set([...html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*\bhidden\b[^>]*>/g)].map((m) => m[1]));
const getEl = (id) => {
  if (!byId.has(id)) {
    const el = new El("div", id);
    if (hiddenIds.has(id)) el.hidden = true;
    const tagM = html.match(new RegExp(`<(?:input|select|textarea)[^>]*\\bid="${id}"[^>]*>`, "i"));
    if (tagM) {
      const tag = tagM[0];
      const valM = tag.match(/\bvalue="([^"]*)"/i);
      if (valM) el.value = valM[1];
      if (/\bchecked\b/i.test(tag)) el.checked = true;
    }
    byId.set(id, el);
  }
  return byId.get(id);
};
const documentShim = {
  getElementById: getEl,
  querySelectorAll: () => [],
  querySelector: () => null,
  createElement: (t) => new El(t),
  body: new El("body"),
};

/* ---------- stubbed Blockbook ---------- */
const PRIV_HEX = "0f".repeat(32);
let ADDR = null; // filled after bundle boot
let utxoMode = "full"; // "full" | "swept"
const FIXTURE_UTXOS = [100, 400, 2000, 2100, 2150, 2200, 50000, 200000].map((v, i) => ({
  txid: (i + 1).toString(16).padStart(64, "a"), vout: i, value: String(v), confirmations: 6,
}));
const fetchCalls = [];
async function stubFetch(url, opts = {}) {
  const u = String(url);
  fetchCalls.push({ url: u, method: opts.method || "GET" });
  const path = u.replace(/^https?:\/\/[^/]+/, "");
  const body = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
  if (path.startsWith("/api/v2/utxo/")) {
    if (utxoMode === "swept") {
      // post-consolidation: 970-grain output + the two healthy UTXOs that were
      // never swept. Total 250970 = 258950 (pre) - 7980 (fee). Count 3 < 8.
      return body([
        { txid: "f".repeat(64), vout: 0, value: "970", confirmations: 1 },
        { txid: "7".padStart(64, "a"), vout: 6, value: "50000", confirmations: 7 },
        { txid: "8".padStart(64, "a"), vout: 7, value: "200000", confirmations: 7 },
      ]);
    }
    return body(FIXTURE_UTXOS);
  }
  if (path.startsWith("/api/v2/estimatefee/")) return body({ result: "0.0002" }); // 20 gr/vB
  if (path.startsWith("/api/v2/tx/")) {
    return body({
      txid: "e".repeat(64), confirmations: 4, blockHeight: 812000,
      vin: [{ addresses: [ADDR], value: "8950" }],
      vout: [{ addresses: [ADDR], value: "970" }],
    });
  }
  if (path.endsWith("/api/sendtx/")) return body({ result: "e".repeat(64) });
  return { ok: false, status: 404, text: async () => "not found" };
}

const sandbox = {
  document: documentShim,
  navigator: { clipboard: { writeText: async () => {} } },
  TextDecoder, crypto: webcrypto, fetch: stubFetch,
  setTimeout, clearTimeout, setInterval, clearInterval,
  scrollTo() {},
  console,
  Date,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
{
  const OuterTE = TextEncoder;
  const VMUint8Array = vm.runInContext("Uint8Array", sandbox);
  sandbox.TextEncoder = class extends OuterTE {
    encode(s) { return new VMUint8Array(super.encode(s)); }
  };
}
for (const f of ["pearl-sweep.bundle.js", "app.js"]) {
  vm.runInContext(fs.readFileSync(resolvePath(dir, f), "utf8"), sandbox, { filename: f, timeout: 15000 });
}

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const R = sandbox.PearlSweep;
assert.ok(R, "bundle exposes window.PearlSweep");
ADDR = R.walletFromPriv(PRIV_HEX, R.NETWORKS.mainnet).address;
const WIF = R.walletToWIF(R.hexToBytes(PRIV_HEX), R.NETWORKS.mainnet);
const OTHER_WIF = R.walletToWIF(R.hexToBytes("ab".repeat(32)), R.NETWORKS.mainnet);

test("boot: bundle + app wired, footer carries @kshot9000 and the exact donation address", () => {
  assert.ok(typeof R.planSweep === "function");
  assert.ok(sandbox.__sweepTest, "test hook exposed");
  assert.equal(getEl("donate-addr").textContent, R.DONATE_ADDRESS);
  assert.equal(R.DONATE_ADDRESS, "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d");
  assert.ok(html.includes('https://x.com/kshot9000'), "x link in footer");
  assert.ok(html.includes("Honest limits"), "honest-limits panel present");
  assert.ok(getEl("sw-panel-2").hidden, "step 2 hidden at boot");
  assert.ok(!getEl("sw-panel-1").hidden, "step 1 visible at boot");
});

test("invalid address is refused loudly", () => {
  getEl("sw-address").value = "not an address";
  getEl("sw-analyze").click();
  return tick().then(() => {
    assert.equal(getEl("sw-error").hidden, false);
    assert.match(getEl("sw-error").textContent, /Not a valid Pearl Taproot address/);
  });
});

test("analyze renders the UTXO health dashboard", async () => {
  getEl("sw-address").value = ADDR;
  getEl("sw-analyze").click();
  for (let i = 0; i < 100 && getEl("sw-dash").hidden; i++) await tick();
  assert.equal(getEl("sw-dash").hidden, false, "dashboard shown");
  const st = sandbox.__sweepTest.state;
  assert.equal(st.address, ADDR.toLowerCase());
  assert.equal(getEl("sw-count").textContent, "8");
  assert.ok(getEl("sw-total").textContent.includes("PRL"));
  assert.equal(getEl("sw-total-grains").textContent, "258950 grains");
  assert.equal(getEl("sw-dust-count").textContent, "2");
  assert.equal(getEl("sw-dust-value").textContent, "0.000005 PRL");
  assert.equal(getEl("sw-unecon-count").textContent, "4");
  assert.equal(getEl("sw-healthy-count").textContent, "2");
  assert.equal(getEl("sw-hist").children.length, 6, "six histogram buckets");
  assert.ok(getEl("sw-fee-note").textContent.includes("20 grains/vB"), getEl("sw-fee-note").textContent);
  const utxoRows = getEl("sw-utxo-tbody").children;
  assert.equal(utxoRows.length, 8, "eight UTXO rows");
  assert.ok(utxoRows[0].innerHTML.includes("badge dust"), "dust badges rendered");
  assert.ok(utxoRows[2].innerHTML.includes("badge uneconomic"), "uneconomic badges rendered");
  assert.ok(utxoRows[6].innerHTML.includes("badge healthy"), "healthy badges rendered");
  assert.ok(getEl("sw-savings").textContent.includes("PRL"), "savings estimate shown");
  assert.equal(getEl("sw-target").value, ADDR.toLowerCase(), "target defaults to analyzed address");
});

test("absurd fee rate -> loud refusal with the math; sane rate -> plan renders", async () => {
  getEl("sw-to-plan").click();
  assert.equal(getEl("sw-panel-2").hidden, false, "step 2 shown");
  getEl("sw-feerate").value = "10000";
  getEl("sw-build-plan").click();
  await tick();
  assert.equal(getEl("sw-refusal").hidden, false, "refusal panel shown");
  assert.match(getEl("sw-refusal-text").textContent, /REFUSED/);
  assert.match(getEl("sw-refusal-text").textContent, /Fee .* ≥ swept value/);
  assert.equal(getEl("sw-plan-out").hidden, true, "no plan output on refusal");

  getEl("sw-feerate").value = "20";
  getEl("sw-build-plan").click();
  await tick();
  assert.equal(getEl("sw-refusal").hidden, true, "refusal cleared");
  assert.equal(getEl("sw-plan-out").hidden, false, "plan shown");
  const math = getEl("sw-plan-math").textContent;
  assert.match(math, /Inputs swept:\s+6 UTXOs/);
  assert.match(math, /Fee:\s+0\.0000798 PRL \(7980 grains\)/);
  assert.match(math, /Net recovered:\s+0\.0000097 PRL \(970 grains\)/);
  assert.equal(getEl("sw-plan-tbody").children.length, 6, "six input rows");
  assert.equal(getEl("sw-plan-out-tbody").children.length, 1, "one output row");
  assert.ok(getEl("sw-plan-warnings").children.length > 0, "net-negative warning shown");
  assert.ok(getEl("sw-plan-warnings").children[0].textContent.includes("cost"), getEl("sw-plan-warnings").children[0].textContent);
});

test("deselecting a UTXO re-plans — and refuses loudly when the fee eats the rest", async () => {
  // uncheck the 2200-grain UTXO (txid aaaa...0006, vout 5):
  // remaining 6750 grains vs 341 vB × 20 = 6820 fee -> refusal
  const key = "a".repeat(63) + "6:5";
  getEl("sw-plan-tbody").fire("change", { target: { dataset: { key }, checked: false } });
  await tick();
  assert.equal(getEl("sw-refusal").hidden, false, "refusal panel shown after deselect");
  assert.match(getEl("sw-refusal-text").textContent, /REFUSED/);
  assert.match(getEl("sw-refusal-text").textContent, /Fee .* ≥ swept value/);
  assert.equal(getEl("sw-plan-out").hidden, true, "plan output hidden on refusal");
});

test("full sign flow: WIF signs, N/N signatures re-verified, txid shown", async () => {
  // rebuild the sane 6-input plan first (re-check the box)
  getEl("sw-feerate").value = "20";
  getEl("sw-build-plan").click();
  await tick();
  assert.equal(getEl("sw-plan-out").hidden, false);
  getEl("sw-to-sign").click();
  assert.equal(getEl("sw-sign-addr").textContent, ADDR.toLowerCase());
  getEl("sw-key").value = WIF;
  getEl("sw-sign").click();
  for (let i = 0; i < 100 && getEl("sw-signed").hidden; i++) await tick();
  assert.equal(getEl("sw-signed").hidden, false, "signed panel shown");
  assert.match(getEl("sw-sign-ok").textContent, /6\/6 Schnorr signatures re-verified/);
  assert.match(getEl("sw-txid").value, /^[0-9a-f]{64}$/);
  assert.ok(getEl("sw-hex").value.length > 200, "raw hex present");
  assert.ok(getEl("sw-key-note").textContent.includes("WIF"), "key kind labeled");
  // broadcast requires the double-confirm
  assert.equal(getEl("sw-broadcast").disabled, true, "broadcast disabled before confirm");
  getEl("sw-confirm-final").checked = true;
  getEl("sw-confirm-final").fire("change");
  assert.equal(getEl("sw-broadcast").disabled, false, "broadcast enabled after confirm");
});

test("wrong key is refused loudly; wipe clears the key", async () => {
  getEl("sw-key").value = OTHER_WIF;
  getEl("sw-sign").click();
  await tick(80);
  assert.equal(getEl("sw-error").hidden, false);
  assert.match(getEl("sw-error").textContent, /KEY DOES NOT CONTROL THIS ADDRESS/);
  getEl("sw-key").value = WIF;
  getEl("sw-wipe").click();
  assert.equal(getEl("sw-key").value, "");
  assert.match(getEl("sw-sign-status").textContent, /wiped/);
  assert.equal(sandbox.__sweepTest.state.keyText, null);
});

test("broadcast posts to Blockbook and hands the txid to Track", async () => {
  getEl("sw-key").value = WIF;
  getEl("sw-sign").click();
  for (let i = 0; i < 100 && getEl("sw-signed").hidden; i++) await tick();
  getEl("sw-confirm-final").checked = true;
  getEl("sw-confirm-final").fire("change");
  getEl("sw-broadcast").click();
  for (let i = 0; i < 100 && getEl("sw-panel-4").hidden; i++) await tick();
  assert.equal(getEl("sw-panel-4").hidden, false, "moved to Track");
  assert.equal(getEl("sw-track-txid").value, "e".repeat(64));
  const post = fetchCalls.find((c) => c.method === "POST");
  assert.ok(post && post.url.endsWith("/api/sendtx/"), "POSTed to /api/sendtx/");
  assert.equal(getEl("sw-key").value, "", "key wiped after broadcast");
});

test("verify step: re-scan proves the consolidation", async () => {
  utxoMode = "swept"; // Blockbook now shows a single 970-grain UTXO
  getEl("sw-verify-rescan").click();
  for (let i = 0; i < 100 && getEl("sw-verify-out").hidden; i++) await tick();
  assert.equal(getEl("sw-verify-out").hidden, false);
  assert.match(getEl("sw-verdict").textContent, /CONSOLIDATION VERIFIED/);
  assert.ok(getEl("sw-verdict").className.includes("good"));
  const vrows = getEl("sw-verify-tbody").children;
  assert.equal(vrows.length, 3, "three check rows");
  assert.ok(vrows.every((r) => r.innerHTML.includes("check-ok")), "all check rows pass");
  utxoMode = "full";
});

test("standalone verifier: clean tx verifies with exact fee; foreign input refused", async () => {
  getEl("sw-sa-txid").value = "e".repeat(64);
  getEl("sw-sa-swept").value = ADDR;
  getEl("sw-sa-target").value = ADDR;
  getEl("sw-sa-run").click();
  for (let i = 0; i < 100 && getEl("sw-sa-out").hidden; i++) await tick();
  assert.match(getEl("sw-sa-out").textContent, /CLEAN CONSOLIDATION/);
  assert.match(getEl("sw-sa-out").textContent, /Fee:\s+0\.0000798 PRL \(7980 grains\)/);

  // foreign input: point the stub at a tx spending someone else's coin
  const origFetch = sandbox.fetch;
  sandbox.fetch = async (url, opts = {}) => {
    if (String(url).includes("/api/v2/tx/")) {
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({
          txid: "e".repeat(64), confirmations: 1,
          vin: [{ addresses: ["prl1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqnrql8a"], value: "8950" }],
          vout: [{ addresses: [ADDR], value: "970" }],
        }),
      };
    }
    return stubFetch(url, opts);
  };
  getEl("sw-sa-out").hidden = true;
  getEl("sw-sa-run").click();
  for (let i = 0; i < 100 && getEl("sw-sa-out").hidden; i++) await tick();
  assert.match(getEl("sw-sa-out").textContent, /input #0 is not from the swept address/);
  sandbox.fetch = origFetch;
});
