// Pearl Watch DOM tests: runs the real pearl-watch.bundle.js + app.js in a
// minimal vm DOM (adapted from the batch app's harness), with a stubbed
// Blockbook. Drives watchlist -> rules -> beacon sweep -> events -> track.
// Usage: node --no-warnings --loader ./tests/loader.mjs tests/watch.dom.test.mjs
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

/* ---------- minimal DOM ---------- */
class ClassList {
  constructor() { this.s = new Set(); }
  add(...c) { c.forEach((x) => this.s.add(x)); }
  remove(...c) { c.forEach((x) => this.s.delete(x)); }
  toggle(c, f) { (f ?? !this.s.has(c)) ? this.s.add(c) : this.s.delete(c); }
  contains(c) { return this.s.has(c); }
}
const registry = [];
class El {
  constructor(tag, id = "") {
    this.tagName = tag.toUpperCase(); this.id = id;
    this.classList = new ClassList(); this._className = "";
    this.dataset = {};
    this.value = ""; this._text = ""; this._html = "";
    this.hidden = false; this.disabled = false; this.checked = false;
    this.style = {}; this._handlers = {}; this._kids = [];
    this.scrollTop = 0; this.scrollHeight = 0; this._attached = false;
    this._attrs = {};
    registry.push(this);
  }
  setAttribute(k, v) { this._attrs[k] = String(v); }
  getAttribute(k) { return this._attrs[k] ?? null; }
  set className(v) { this._className = String(v); String(v).split(/\s+/).forEach((c) => c && this.classList.add(c)); }
  get className() { return this._className; }
  set innerHTML(v) {
    this._html = String(v); this._kids = [];
    this._text = String(v).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  }
  get innerHTML() { return this._html; }
  set textContent(v) { this._text = String(v); }
  get textContent() { return this._text; }
  addEventListener(t, fn) { (this._handlers[t] ??= []).push(fn); }
  click() { (this._handlers.click || []).forEach((f) => f({ target: this, preventDefault() {} })); }
  fire(t, extra = {}) { (this._handlers[t] || []).forEach((f) => f({ target: this, preventDefault() {}, ...extra })); }
  appendChild(k) { this._kids.push(k); return k; }
  removeChild(k) { this._kids = this._kids.filter((x) => x !== k); return k; }
  remove() { for (const e of registry) e._kids = e._kids.filter((x) => x !== this); }
  get children() { return this._kids; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  scrollIntoView() {}
  select() {}
}
const byId = new Map();
const attrMap = new Map();
for (const m of html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)) {
  if (attrMap.has(m[1])) continue;
  const tag = m[0];
  const vv = tag.match(/\bvalue="([^"]*)"/);
  attrMap.set(m[1], {
    value: vv ? vv[1] : "",
    checked: /\bchecked\b/.test(tag),
    hidden: /\bhidden\b/.test(tag),
  });
}
const getEl = (id) => {
  if (!byId.has(id)) {
    const el = new El("div", id);
    el._attached = true;
    const a = attrMap.get(id);
    if (a) {
      if (a.value) el.value = a.value;
      if (a.checked) el.checked = true;
      if (a.hidden) el.hidden = true;
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
  readyState: "complete",
  execCommand: () => false,
};

/* ---------- stubbed Blockbook ---------- */
const TX1 = "ab".repeat(32);
const TX2 = "cd".repeat(32);
const QA = { tip: 120105, down: false, phase: 0, txDetail: null };
const okBody = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });
const fail = (status) => ({ ok: false, status, json: async () => ({}), text: async () => "error" });
async function stubFetch(url) {
  const u = String(url);
  const path = u.replace(/^https?:\/\/[^/]+/, "");
  if (QA.down) throw new Error("ECONNREFUSED");
  if (path === "/api/status" || path.endsWith("/api/status")) return okBody({ backend: { blocks: QA.tip } });
  if (path.startsWith("/api/v2/address/")) {
    const a = decodeURIComponent(path.split("/api/v2/address/")[1].split("?")[0]);
    if (a !== QA.addr) return fail(404);
    const base = {
      address: a, balance: "250000000", totalReceived: "500000000", totalSent: "250000000",
      txCount: 2,
      transactions: [
        { txid: TX1, blockHeight: 120100, confirmations: 5, valueIn: "0", value: "250000000", fees: "10000" },
      ],
    };
    if (QA.phase >= 1) {
      base.balance = "750000000";
      base.totalReceived = "1000000000";
      base.txCount = 3;
      base.transactions.push({ txid: TX2, blockHeight: -1, confirmations: 0, valueIn: "0", value: "500000000", fees: "10000" });
    }
    return okBody(base);
  }
  if (path.startsWith("/api/v2/tx/")) {
    const id = path.split("/api/v2/tx/")[1].split("?")[0];
    if (QA.txDetail && QA.txDetail.txid === id) return okBody(QA.txDetail);
    return fail(404);
  }
  return fail(404);
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
for (const f of ["pearl-watch.bundle.js", "app.js"]) {
  vm.runInContext(fs.readFileSync(resolvePath(dir, f), "utf8"), sandbox, { filename: f, timeout: 30000 });
}

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const R = sandbox.PearlWatch;
assert.ok(R, "bundle exposes window.PearlWatch");
const T = sandbox.__watchTest;
assert.ok(T, "test hook exposed");
const get = (id) => documentShim.getElementById(id);
const grains = (s) => BigInt(String(s).replace(/n$/, ""));

// fixture identity through the real bundle
const N = R.NETWORKS.mainnet;
const A1 = R.encodeBech32m("prl", 1, R.sha256(new TextEncoder().encode("watch-dom-a1")));
QA.addr = A1;
QA.txDetail = {
  txid: TX2, blockHeight: -1, confirmations: 0,
  vout: [{ value: "500000000", addresses: [A1] }],
  vin: [{ value: "500010000", addresses: ["ee".repeat(32)] }],
};

test("boot: attribution, honest limits, watchlist tab active", () => {
  assert.ok(html.includes("prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d"), "donation address in footer");
  assert.ok(html.includes("https://x.com/kshot9000"), "x link in footer");
  assert.ok(html.includes("Honest limits"), "honest-limits panel present");
  assert.ok(get("tb-watchlist").classList.contains("active"), "watchlist tab active");
  assert.ok(get("tab-watchlist").classList.contains("active"), "watchlist panel visible");
  assert.ok(!get("tab-beacon").classList.contains("active"), "beacon panel hidden");
});

test("watchlist: invalid address refused loudly", () => {
  get("w-addr").value = "junk-address";
  get("w-add").click();
  assert.ok(!get("w-err").hidden, "error shown");
  assert.match(get("w-err").textContent, /WATCH REFUSED/);
  assert.equal(T.state().watched.length, 0);
});

test("watchlist: valid address added, duplicate refused", () => {
  get("w-addr").value = A1;
  get("w-label").value = "vault";
  get("w-add").click();
  assert.ok(get("w-err").hidden, "no error");
  const st = T.state();
  assert.equal(st.watched.length, 1);
  assert.equal(st.watched[0].address, A1);
  assert.equal(st.watched[0].label, "vault");
  assert.equal(get("w-tbody").children.length, 1, "one table row");
  // duplicate
  get("w-addr").value = A1;
  get("w-add").click();
  assert.match(get("w-err").textContent, /already on the watchlist/);
  assert.equal(T.state().watched.length, 1);
});

test("beacon: sweep fills balances from stubbed Blockbook", async () => {
  await T.sweep(true);
  await tick();
  const st = T.state();
  assert.ok(T.snapshots().has(A1), "snapshot cached");
  assert.equal(get("w-tbody").children.length, 1);
  // balance cell shows 2.5 PRL
  const rowText = get("w-tbody").children[0].children.map((c) => c.textContent).join(" | ");
  assert.ok(rowText.includes("2.5"), "balance 2.5 PRL rendered: " + rowText);
  assert.ok(get("b-tip").textContent.includes("120105"), "tip shown");
});

test("rules: bad config refused loudly", () => {
  get("r-kind").value = "incoming";
  get("r-kind").fire("change");
  get("r-addr").value = "junk";
  get("r-amt").value = "1";
  get("r-add").click();
  assert.ok(!get("r-err").hidden);
  assert.match(get("r-err").textContent, /WATCH REFUSED/);
  assert.equal(T.state().rules.length, 0);
});

test("rules: incoming rule added, then fires on the next sweep", async () => {
  get("r-addr").value = A1;
  get("r-amt").value = "1";
  get("r-label").value = "whale ping";
  get("r-add").click();
  assert.ok(get("r-err").hidden, "rule accepted");
  assert.equal(T.state().rules.length, 1);
  assert.equal(get("r-tbody").children.length, 1);
  // new tx arrives on the backend
  QA.phase = 1;
  await T.sweep(true);
  await tick();
  const st = T.state();
  assert.equal(st.events.length, 1, "one event fired");
  const ev = st.events[0];
  assert.equal(ev.kind, "incoming");
  assert.equal(grains(ev.grains), 500000000n);
  assert.equal(ev.txid, TX2);
  assert.equal(get("ev-count").textContent, "1", "event pill updated");
  const evRow = get("e-tbody").children[0].children.map((c) => c.textContent).join(" | ");
  assert.ok(evRow.includes("5"), "event row shows 5 PRL: " + evRow);
  // next sweep: no refire
  await T.sweep(true);
  await tick();
  assert.equal(T.state().events.length, 1, "edge-triggered: no refire");
});

test("rules: tx-confirmed rule validates txid and fires", async () => {
  get("r-kind").value = "tx-confirmed";
  get("r-kind").fire("change");
  get("r-txid").value = "short";
  get("r-conf").value = "6";
  get("r-add").click();
  assert.match(get("r-err").textContent, /64-hex/);
  get("r-txid").value = TX2;
  get("r-add").click();
  assert.ok(get("r-err").hidden, "tx-confirmed rule accepted");
  assert.equal(T.state().rules.length, 2);
  QA.txDetail = { ...QA.txDetail, blockHeight: 120104, confirmations: 6 };
  await T.sweep(true);
  await tick();
  const st = T.state();
  assert.ok(st.events.some((e) => e.kind === "tx-confirmed"), "confirmation event fired");
});

test("track: bad txid refused; stubbed tx shows progress", async () => {
  T.goto("track");
  get("t-txid").value = "nope";
  get("t-watch").click();
  assert.match(get("t-err").textContent, /64 hex/);
  get("t-txid").value = TX2;
  get("t-target").value = "6";
  get("t-watch").click();
  await tick(120);
  assert.ok(!get("t-out").hidden, "tracker output shown");
  assert.ok(get("t-line").textContent.includes("Landed"), "landed line: " + get("t-line").textContent);
  assert.ok(get("t-line").textContent.includes("6 confirmations"), "confirmation count: " + get("t-line").textContent);
  get("t-stop").click(); // stop the poll timer so the suite exits
});

test("beacon: unreachable backend reported honestly", async () => {
  QA.down = true;
  await T.sweep(true);
  await tick();
  assert.ok(!get("b-err").hidden, "honest error shown");
  assert.match(get("b-err").textContent, /unreachable/i);
  QA.down = false;
});
