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

/* ---------- minimal DOM with class-aware query ---------- */
class ClassList {
  constructor() { this.s = new Set(); }
  add(...c) { c.forEach((x) => this.s.add(x)); }
  remove(...c) { c.forEach((x) => this.s.delete(x)); }
  toggle(c, f) { (f ?? !this.s.has(c)) ? this.s.add(c) : this.s.delete(c); }
  contains(c) { return this.s.has(c); }
}
const registry = [];
function hasClass(el, cls) {
  if (el.classList && el.classList.contains(cls)) return true;
  return String(el._className || "").split(/\s+/).includes(cls);
}
class El {
  constructor(tag, id = "") {
    this.tagName = tag.toUpperCase(); this.id = id;
    this.classList = new ClassList(); this._className = "";
    this.dataset = {};
    this.value = ""; this.textContent = ""; this._html = "";
    this.hidden = false; this.disabled = false; this.checked = false;
    this.style = {}; this._handlers = {}; this._kids = [];
    this.scrollTop = 0; this.scrollHeight = 0;
    this._attached = false;
    registry.push(this);
  }
  set className(v) { this._className = String(v); String(v).split(/\s+/).forEach((c) => c && this.classList.add(c)); }
  get className() { return this._className; }
  set innerHTML(v) { this._html = String(v); this._kids = []; }
  get innerHTML() { return this._html; }
  addEventListener(t, fn) { (this._handlers[t] ??= []).push(fn); }
  click() { (this._handlers.click || []).forEach((f) => f({ target: this, preventDefault() {} })); }
  fire(t, extra = {}) { (this._handlers[t] || []).forEach((f) => f({ target: this, preventDefault() {}, ...extra })); }
  appendChild(k) { this._kids.push(k); const mark = (e) => { e._attached = true; e._kids.forEach(mark); }; mark(k); return k; }
  removeChild(k) { this._kids = this._kids.filter((x) => x !== k); return k; }
  remove() {
    for (const e of registry) e._kids = e._kids.filter((x) => x !== this);
    const unmark = (e) => { e._attached = false; e._kids.forEach(unmark); };
    unmark(this);
  }
  get children() { return this._kids; }
  get firstChild() { return this._kids[0]; }
  querySelector(sel) {
    if (sel.startsWith(".")) {
      const cls = sel.slice(1);
      const walk = (kids) => {
        for (const k of kids) {
          if (hasClass(k, cls)) return k;
          const d = walk(k._kids);
          if (d) return d;
        }
        return null;
      };
      return walk(this._kids);
    }
    return null;
  }
  querySelectorAll(sel) {
    if (sel.startsWith(".")) {
      const cls = sel.slice(1);
      const out = [];
      const walk = (kids) => { for (const k of kids) { if (hasClass(k, cls)) out.push(k); walk(k._kids); } };
      walk(this._kids);
      return out;
    }
    return [];
  }
  scrollIntoView() {}
  select() {}
}
const byId = new Map();
const hiddenIds = new Set([...html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*\bhidden\b[^>]*>/g)].map((m) => m[1]));
const getEl = (id) => {
  if (!byId.has(id)) {
    const el = new El("div", id);
    el._attached = true; // page elements are always in the document
    if (hiddenIds.has(id)) el.hidden = true;
    byId.set(id, el);
  }
  return byId.get(id);
};
const documentShim = {
  getElementById: getEl,
  querySelectorAll: (sel) => (sel.startsWith(".") ? registry.filter((e) => e._attached && hasClass(e, sel.slice(1))) : []),
  querySelector: (sel) => documentShim.querySelectorAll(sel)[0] || null,
  createElement: (t) => new El(t),
  body: new El("body"),
  readyState: "complete",
};

/* ---------- stubbed Blockbook ---------- */
const ADDR = "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d";
const EXT = "external-counterparty";
let bbMode = "ok"; // ok | unreachable
const bbTx = (txid, time, vin, vout, fees) => ({ txid, blockHeight: 100, blockTime: time, fees, vin, vout });
function fixtureTxs() {
  const T = (d) => R.dateToUnix(d);
  return [
    bbTx("buy-tx-0001", T("2024-06-01"),
      [{ addresses: [EXT], value: "100000000" }],
      [{ value: "100000000", addresses: [ADDR] }], "0"),
    bbTx("sell-tx-0002", T("2025-03-01"),
      [{ addresses: [ADDR], value: "250000000" }],
      [{ value: "249900000", addresses: [EXT] }], "100000"),
  ];
}
async function stubFetch(url, opts = {}) {
  const u = String(url);
  const path = u.replace(/^https?:\/\/[^/]+/, "");
  const body = (obj) => ({ ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) });
  const fail = (status) => ({ ok: false, status, json: async () => ({}), text: async () => "error" });
  if (bbMode === "unreachable") return fail(502);
  if (path.startsWith("/api/v2/address/")) return body({ txs: fixtureTxs(), totalTxs: 2 });
  if (path.startsWith("/api/v2/tx/")) {
    const id = path.split("/api/v2/tx/")[1].split("?")[0];
    const t = fixtureTxs().find((x) => x.txid === id);
    return t ? body(t) : fail(404);
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
for (const f of ["pearl-tax.bundle.js", "app.js"]) {
  vm.runInContext(fs.readFileSync(resolvePath(dir, f), "utf8"), sandbox, { filename: f, timeout: 15000 });
}


const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const R = sandbox.PearlTax;
assert.ok(R, "bundle exposes window.PearlTax");
const T = sandbox.__taxTest;
assert.ok(T, "test hook exposed");

async function waitFor(fn, label) {
  for (let i = 0; i < 150; i++) { if (fn()) return; await tick(40); }
  throw new Error("timeout waiting for: " + label);
}
const get = (id) => documentShim.getElementById(id);
// shim quirk: re-rendered rows stay _attached in the registry — only count
// rows currently parented under the live list.
const liveRows = () => {
  const list = get("tx-cls-list");
  return documentShim.querySelectorAll(".cls-row").filter((r) => list.children.indexOf(r) !== -1);
};
const lastRefusalHTML = () => {
  const boxes = documentShim.querySelectorAll(".refusal");
  return boxes.length ? boxes[boxes.length - 1].innerHTML : "";
};

test("boot: footer attribution, honest limits, tab 1 visible", () => {
  assert.ok(html.includes("prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d"), "donation address in footer");
  assert.ok(html.includes("https://x.com/kshot9000"), "x link in footer");
  assert.ok(html.includes("Honest limits"), "honest-limits panel present");
  assert.ok(html.includes("Not tax advice"), "not-tax-advice disclaimer present");
  assert.ok(!get("tab-addresses").hidden, "tab 1 visible at boot");
  assert.ok(get("tab-import").hidden, "tab 2 hidden at boot");
});

test("addresses: invalid refused, valid added", async () => {
  get("tx-addr-input").value = "bogus-address";
  get("tx-addr-add").click();
  await tick();
  assert.match(get("tx-addr-msg").className, /err/, "invalid address refused");
  assert.equal(T.state().addresses.length, 0);
  get("tx-addr-input").value = ADDR;
  get("tx-addr-label").value = "test wallet";
  get("tx-addr-add").click();
  await tick();
  assert.equal(T.state().addresses.length, 1);
  assert.equal(T.state().addresses[0].hrp, "prl");
  assert.equal(get("tx-addr-list").children.length, 1);
});

test("import: stubbed Blockbook fetch normalizes 2 txs", async () => {
  get("tx-imp-blockbook").value = "https://bb.test";
  get("tx-imp-fetch").click();
  await waitFor(() => T.state().txs.length === 2, "blockbook import");
  const kinds = Object.fromEntries(T.state().txs.map((t) => [t.txid, t.kind]));
  assert.equal(kinds["buy-tx-0001"], "receive");
  assert.equal(kinds["sell-tx-0002"], "send");
  assert.equal(get("tx-imp-txlist").children.length, 2);
  assert.match(get("tx-imp-msg").textContent, /Imported 2 transaction/);
});

test("classify: report refuses while txs unclassified", async () => {
  T.renderAll();
  get("tx-rep-year").value = "2025";
  get("tx-rep-run").click();
  await tick();
  assert.match(get("tx-rep-msg").className, /err/, "refusal surfaced");
  assert.match(lastRefusalHTML(), /Unclassified \(2\)/, "refusal names the gap");
});

test("classify: both txs classified through the UI", async () => {
  // show only unclassified so each pass shrinks the live list by one
  get("tx-cls-unclass").checked = true;
  get("tx-cls-unclass").fire("change");
  await tick();
  const subs = ["buy", "sell"];
  for (let i = 0; i < 2; i++) {
    const rows = liveRows();
    assert.equal(rows.length, 2 - i, "one row done per pass");
    const sel = rows[0].querySelector(".input");
    sel.value = subs[i];
    const btn = rows[0].querySelectorAll(".btn")[0];
    btn.click();
    await tick();
  }
  const c = T.state().classifications;
  assert.equal(c["buy-tx-0001"].sub, "buy");
  assert.equal(c["sell-tx-0002"].sub, "sell");
});

test("prices: CSV import", async () => {
  get("tx-px-csv").value = "2024-01-01,1.00\n2024-06-01,1.50\n2025-03-01,2.00\n";
  get("tx-px-csv-import").click();
  await tick();
  assert.equal(T.state().prices.length, 3);
  assert.equal(get("tx-px-list").children.length, 3);
});

test("report: dry FIFO refused, opening lot repairs it", async () => {
  get("tx-rep-year").value = "2025";
  get("tx-rep-run").click();
  await tick();
  assert.match(lastRefusalHTML(), /ran dry/, "dry FIFO named");
  get("tx-open-date").value = "2024-01-01";
  get("tx-open-grains").value = "2";
  get("tx-open-price").value = "1.00";
  get("tx-open-add").click();
  await tick();
  assert.equal(T.state().openingLots.length, 1);
  get("tx-rep-run").click();
  await tick();
  assert.match(get("tx-rep-msg").className, /ok/, "report ran");
  assert.match(get("tx-rep-summary").innerHTML, /Net gain \/ loss/, "summary cards rendered");
  assert.equal(get("tx-rep-table").children.length, 2, "two disposal rows");
  assert.match(get("tx-rep-summary").innerHTML, /\$2\.25/, "net gain $2.25 shown");
});

test("export: state export + double-click wipe", async () => {
  get("tx-exp-state-export").click();
  await tick();
  assert.match(get("tx-exp-msg").className, /ok/, "state export ok");
  get("tx-exp-wipe").click(); // arms
  assert.match(get("tx-exp-wipe").textContent, /confirm/i, "wipe asks for confirmation");
  get("tx-exp-wipe").click(); // confirms
  await tick();
  assert.equal(T.state().addresses.length, 0);
  assert.equal(T.state().txs.length, 0);
  assert.match(get("tx-exp-msg").textContent, /wiped/i);
});
