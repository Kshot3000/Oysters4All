// Pearl Payroll DOM tests: runs the real pearl-payroll.bundle.js + app.js in a
// minimal vm DOM (adapted from the batch harness), with a stubbed Blockbook
// and an in-memory localStorage. Drives the full 6-step wizard end to end.
// Usage: node --no-warnings --loader ./tests/loader.mjs tests/payroll.dom.test.mjs
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
    registry.push(this);
  }
  set className(v) { this._className = String(v); String(v).split(/\s+/).forEach((c) => c && this.classList.add(c)); }
  get className() { return this._className; }
  set innerHTML(v) {
    this._html = String(v); this._kids = [];
    this._text = String(v).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(); // readable text for tests
  }
  get innerHTML() { return this._html; }
  set textContent(v) { this._text = String(v); }
  get textContent() { return this._text; }
  insertAdjacentHTML(pos, html) {
    this._html += String(html);
    this._text = (this._text + " " + String(html).replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
  }
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
  querySelectorAll: (sel) => {
    if (sel === "[data-copy]") return [];
    return [];
  },
  querySelector: () => null,
  createElement: (t) => new El(t),
  body: new El("body"),
  readyState: "complete",
  execCommand: () => false,
};

/* ---------- in-memory localStorage ---------- */
const lsStore = new Map();
const localStorageShim = {
  getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
  setItem: (k, v) => { lsStore.set(k, String(v)); },
  removeItem: (k) => { lsStore.delete(k); },
};

/* ---------- stubbed Blockbook ---------- */
let PRIV_HEX = "0f".repeat(32);
const QA = { mode: "ok", signedTxid: null, utxos: null, postedHex: null };
const okBody = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });
const fail = (status) => ({ ok: false, status, json: async () => ({}), text: async () => "error" });
async function stubFetch(url, opts = {}) {
  const u = String(url);
  const path = u.replace(/^https?:\/\/[^/]+/, "");
  if (path.startsWith("/api/v2/utxo/")) return okBody(QA.utxos);
  if (path.startsWith("/api/v2/estimatefee/")) return okBody({ result: "0.0002" });
  if (path.endsWith("/api/sendtx/")) {
    if (opts.method !== "POST") return fail(405);
    QA.postedHex = opts.body;
    return okBody({ result: QA.signedTxid });
  }
  return fail(404);
}

const sandbox = {
  document: documentShim,
  localStorage: localStorageShim,
  navigator: { clipboard: { writeText: async (t) => { sandbox.__copied = t; } } },
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
for (const f of ["pearl-payroll.bundle.js", "app.js"]) {
  vm.runInContext(fs.readFileSync(resolvePath(dir, f), "utf8"), sandbox, { filename: f, timeout: 30000 });
}

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const R = sandbox.PearlPayroll;
assert.ok(R, "bundle exposes window.PearlPayroll");
const T = sandbox.__payrollTest;
assert.ok(T, "test hook exposed");
const get = (id) => documentShim.getElementById(id);
async function waitFor(fn, label) {
  for (let i = 0; i < 150; i++) { if (fn()) return; await tick(40); }
  throw new Error("timeout waiting for: " + label);
}

// fixture identities derived through the real bundle
const N = R.NETWORKS.mainnet;
const wSender = R.walletFromPriv(PRIV_HEX, N);
const SENDER = wSender.address;
const WIF = R.walletToWIF(R.hexToBytes(PRIV_HEX), N);
const recip = (h) => R.walletFromPriv(h, N).address;
const A1 = recip("aa".repeat(32)), A2 = recip("bb".repeat(32)), A3 = recip("cc".repeat(32));
QA.utxos = [
  { txid: "a".repeat(64), vout: 0, value: "800000000", confirmations: 10 },
  { txid: "b".repeat(64), vout: 1, value: "500000000", confirmations: 7 },
  { txid: "c".repeat(64), vout: 2, value: "50000000", confirmations: 2 },
];

test("boot: footer attribution, honest limits (7), step 1 + history visible", () => {
  assert.ok(html.includes("prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d"), "donation address in footer");
  assert.ok(html.includes("https://x.com/kshot9000"), "x link in footer");
  assert.ok(html.includes("Honest limits — payroll edition"), "honest-limits panel present");
  assert.ok(html.includes("No auto-pay — ever."), "no-auto-pay rule present");
  assert.equal((html.match(/<li><strong>/g) || []).length >= 7, true, "at least 7 limit items");
  assert.ok(!get("step-roster").hidden, "step 1 visible at boot");
  assert.ok(get("step-schedule").hidden, "step 2 hidden at boot");
  assert.ok(get("st-roster").classList.contains("active"), "nav 1 active");
  assert.ok(get("st-history"), "history nav present");
});

test("roster: invalid address refused loudly", async () => {
  get("r-text").value = "junk-address, 1";
  get("r-parse").click();
  await tick();
  assert.ok(!get("r-err").hidden, "error shown");
  assert.match(get("r-err").textContent, /ROSTER REFUSED/);
  assert.equal(T.state().roster, null);
});

test("roster: sample validates — exact totals, 3 rows, labels", async () => {
  get("r-text").value = R.sampleRoster().replace(/prl1pr6yuq8u2r95wjzzgpdy8cpnncpl7l8zgy6x5q0367pnc53s2famqg7pt74/g, A1)
    .replace(/prl1p7dwp74zgd4te3mqr58d6x3p3t70jljmpe4auey8g824ra4x43tks3y4pr6/g, A2)
    .replace(/prl1p5gfau0gepxzjkjyx9t88ewnhujrmpjqgqfh8v9vympjaz94x36jqpepvyt/g, A3);
  get("r-parse").click();
  await tick();
  const m = T.state().roster;
  assert.ok(m, "roster accepted");
  assert.equal(get("r-tbody").children.length, 3);
  assert.equal(m.total, "1125000546n");
  assert.match(get("r-total").textContent, /11\.25000546 PRL/);
  assert.match(get("r-merged").textContent, /none/);
  assert.match(get("r-tbody").children[0].textContent, /Alice/);
  assert.match(get("r-tbody").children[1].textContent, /Bob/);
  get("r-next").click();
  await tick();
  assert.ok(!get("step-schedule").hidden, "moved to schedule");
});

test("roster: dust line refused, duplicates merge, merge-off refuses", async () => {
  get("st-roster").click();
  await tick();
  get("r-text").value = `${A1}, 1\n${A2}, 545 grains`;
  get("r-parse").click();
  await tick();
  assert.match(get("r-err").textContent, /dust floor/);
  get("r-merge").checked = false;
  get("r-text").value = `${A1}, 1\n${A2}, 2\n${A1}, 0.5`;
  get("r-parse").click();
  await tick();
  assert.match(get("r-err").textContent, /merging is OFF/);
  get("r-merge").checked = true;
  get("r-parse").click();
  await tick();
  assert.equal(get("r-tbody").children.length, 2);
  assert.match(get("r-merged").textContent, /1 duplicate/);
  // restore the full sample for the rest of the flow
  get("r-text").value = `${A1}, 1.25, Alice\n${A2}, 546 grains, Bob\n${A3}, 10, Carol`;
  get("r-parse").click();
  await tick();
  assert.equal(get("r-tbody").children.length, 3);
});

test("roster: add / edit / remove rows, duplicates refused loudly", async () => {
  const rowBtns = (rowIdx) => {
    const tr = get("r-tbody").children[rowIdx];
    const td = tr.children[tr.children.length - 1];
    const wrap = td.children[0];
    return { edit: wrap.children[0], remove: wrap.children[1] };
  };
  const A4 = recip("dd".repeat(32));
  get("a-addr").value = A4; get("a-amount").value = "0.5"; get("a-label").value = "Dave";
  get("a-add").click();
  await tick();
  assert.match(get("a-msg").textContent, /Payee added/);
  assert.equal(get("r-tbody").children.length, 4);
  // loud duplicate refusal in the add form
  get("a-addr").value = A4; get("a-amount").value = "1"; get("a-label").value = "Dave dup";
  get("a-add").click();
  await tick();
  assert.ok(!get("a-err").hidden);
  assert.match(get("a-err").textContent, /DUPLICATE ADDRESS/);
  // edit row 4 through its Edit button: bump Dave to 0.75
  rowBtns(3).edit.click();
  await tick();
  assert.equal(get("a-addr").value, A4);
  assert.match(get("a-msg").textContent, /Editing payee #4/);
  get("a-amount").value = "0.75";
  get("a-add").click();
  await tick();
  assert.match(get("a-msg").textContent, /Payee updated/);
  assert.match(get("r-total").textContent, /12\.00000546 PRL/);
  // remove row 4 through its Remove button: back to the 3-line roster
  rowBtns(3).remove.click();
  await tick();
  assert.equal(get("r-tbody").children.length, 3);
  assert.match(get("r-total").textContent, /11\.25000546 PRL/);
});

test("schedule: 12 biweekly paydays planned, countdown, per-run total", async () => {
  get("p-period").value = "biweekly";
  get("p-anchor").value = "2026-10-01";
  get("p-label").value = "October payroll";
  get("p-plan").click();
  await tick();
  const sch = T.state().schedule;
  assert.ok(sch, "schedule planned");
  assert.equal(sch.period, "biweekly");
  assert.equal(sch.payDate, "2026-10-01");
  assert.equal(sch.runLabel, "October payroll");
  assert.equal(get("p-tbody").children.length, 12);
  assert.match(get("p-countdown").textContent, /2026-10-01/);
  assert.match(get("p-total-out").textContent, /11\.25000546 PRL/);
  get("p-next").click();
  await tick();
  assert.ok(!get("step-fund").hidden, "moved to fund");
});

test("schedule: custom days + monthly, no-auto-pay note always shown", async () => {
  get("p-period").value = "custom";
  get("p-custom-days").value = "10";
  get("p-anchor").value = "2026-10-01";
  get("p-label").value = "";
  get("p-plan").click();
  await tick();
  const sch = T.state().schedule;
  assert.equal(sch.period, "custom");
  assert.equal(get("p-tbody").children.length, 12);
  assert.match(get("p-period-out").textContent, /Custom — every 10 days/);
  assert.ok(html.includes("No auto-pay: each of these dates needs a fresh signed dispatch"), "no-auto-pay note in markup");
  // restore a labeled schedule for the rest of the flow
  get("p-period").value = "weekly";
  get("p-anchor").value = "2026-10-01";
  get("p-label").value = "October payroll";
  get("p-plan").click();
  await tick();
  assert.equal(T.state().schedule.runLabel, "October payroll");
});

test("fund: bad sender refused, fetch loads 3 UTXOs, totals balance, no 2-run warning", async () => {
  get("f-sender").value = "not-an-address";
  get("f-fetch").click();
  await tick();
  assert.match(get("f-err").textContent, /FETCH FAILED/);
  get("f-sender").value = SENDER;
  get("blockbook").value = "https://bb.test";
  get("f-fetch").click();
  await waitFor(() => get("f-tbody").children.length === 3, "utxo rows");
  assert.match(get("f-fetch-msg").textContent, /Loaded 3 UTXO/);
  await tick();
  assert.ok(!/SHORTFALL/.test(get("f-totals").textContent), "no shortfall");
  assert.match(get("f-totals").textContent, /OK — inputs = payees \+ fee \+ change/);
  // 1.3e9 selected covers exactly 1 full run of ~1.125e9 -> the <2-run warning fires
  assert.ok(!get("f-warn").hidden, "funding warning shown: balance covers 1 run");
  assert.match(get("f-warn").textContent, /fewer than 2/);
  assert.match(get("f-warn").textContent, /covers 1 upcoming pay run/);
});

test("fund: manual empty selection refused, paste path works", async () => {
  get("f-auto").checked = false;
  get("f-auto").fire("change");
  get("f-none").click();
  await tick();
  assert.ok(!get("f-cover-err").hidden, "shortfall visible");
  assert.match(get("f-cover-err").textContent, /NOT COVERED/);
  get("f-all").click();
  await tick();
  assert.ok(get("f-cover-err").hidden, "shortfall cleared");
  get("f-auto").checked = true;
  get("f-auto").fire("change");
  await tick();
  // air-gapped paste
  get("f-paste").value = `${"d".repeat(64)}:0 900000000\n${"e".repeat(64)}:1 3 prl`;
  get("f-parse-paste").click();
  await tick();
  assert.equal(get("f-tbody").children.length, 2);
  assert.match(get("f-totals").textContent, /OK — inputs = payees \+ fee \+ change/);
  // restore fetched utxos for the signing flow
  get("f-sender").value = SENDER;
  get("f-fetch").click();
  await waitFor(() => get("f-tbody").children.length === 3, "utxo rows again");
});

test("review: breakdown, exact fee math, double-confirm gate, bundle", async () => {
  get("f-next").click();
  await tick();
  assert.ok(!get("step-review").hidden, "review visible");
  assert.equal(get("r2-tbody").children.length, 3, "3 payee rows");
  assert.equal(get("r2-itbody").children.length, 2, "2 input rows (auto-selected)");
  const st = T.state();
  const plan = JSON.parse(JSON.stringify(st.plan));
  const wantVBytes = R.keypathTxVBytes(2, 4);
  assert.match(get("r2-fee").textContent, new RegExp(`${wantVBytes} vB`));
  const feeGrains = BigInt(wantVBytes) * 20n;
  assert.match(get("r2-fee").textContent, new RegExp(`${feeGrains} grains`));
  assert.match(get("r2-summary").textContent, /exact to the grain/);
  assert.match(get("r2-summary").textContent, /October payroll/);
  assert.ok(get("r2-next").disabled, "next gated on double-confirm");
  get("r2-confirm").checked = true;
  get("r2-confirm").fire("change");
  assert.ok(!get("r2-next").disabled, "next enabled after confirm");
  get("r2-next").click();
  await tick();
  assert.ok(!get("step-sign").hidden, "sign visible");
  assert.match(get("s-fp").textContent, /^[0-9a-f]{16}$/);
  const b = JSON.parse(get("s-bundle").value);
  assert.equal(b.bundle, "pearl-payroll-unsigned:v1:");
  assert.equal(b.descriptor.runLabel, "October payroll");
  assert.equal(b.descriptor.payDate, "2026-10-01");
  assert.equal(b.descriptor.period, "weekly");
});

test("sign: bundle import round-trip + tamper refusal, wrong key refused, sign + wipe", async () => {
  const raw = get("s-bundle").value;
  get("s-import").value = raw;
  get("s-import-fp").value = get("s-fp").textContent;
  get("s-import-btn").click();
  await tick();
  assert.ok(!get("s-import-ok").hidden, "import ok shown");
  assert.match(get("s-import-ok").textContent, /all cross-checks passed/);
  const tampered = JSON.parse(raw);
  tampered.descriptor.payees[0].amountGrains = "999999999";
  get("s-import").value = JSON.stringify(tampered);
  get("s-import-fp").value = "";
  get("s-import-btn").click();
  await tick();
  assert.match(get("s-import-err").textContent, /FINGERPRINT MISMATCH/);
  const otherWif = R.walletToWIF(R.hexToBytes("ab".repeat(32)), N);
  get("s-key").value = otherWif;
  get("s-sign").click();
  await tick(300);
  assert.match(get("s-err").textContent, /KEY DOES NOT CONTROL/);
  get("s-key").value = WIF;
  get("s-sign").click();
  await waitFor(() => !get("s-out").hidden, "signed output");
  assert.match(get("s-verify").textContent, /2\/2 Schnorr signatures re-verified/);
  assert.match(get("s-txid").textContent, /^[0-9a-f]{64}$/);
  assert.ok(get("s-hex").value.length > 500, "signed hex present");
  assert.equal(get("s-key").value, "", "key wiped from the input");
  assert.equal(T.state().secret, null, "key wiped from state");
  assert.equal(get("s-txid").textContent, get("s-unsigned-txid").textContent);
  QA.signedTxid = get("s-txid").textContent;
  get("s-next").click();
  await tick();
  assert.ok(!get("step-broadcast").hidden, "broadcast visible");
  assert.match(get("b-runlabel").textContent, /October payroll/);
});

test("broadcast: double-confirm gate, POST to /api/sendtx/, run recorded to history", async () => {
  assert.ok(get("b-send").disabled, "broadcast gated");
  get("b-confirm").checked = true;
  get("b-confirm").fire("change");
  assert.ok(!get("b-send").disabled, "broadcast enabled after confirm");
  get("b-send").click();
  await waitFor(() => !get("b-ok").hidden, "broadcast ok");
  assert.equal(QA.postedHex, get("s-hex").value, "posted hex is the signed hex");
  assert.match(get("b-ok").textContent, /recorded in the History ledger/);
  // the run landed in localStorage under the network key
  const raw = localStorageShim.getItem("pearl-payroll:history:mainnet");
  const runs = JSON.parse(raw);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].txid, QA.signedTxid);
  assert.equal(runs[0].runLabel, "October payroll");
  assert.equal(runs[0].payees.length, 3);
  assert.equal(runs[0].payees[0].grains, "125000000");
});

test("history: run listed, per-payee totals, export CSV path, clear", async () => {
  get("st-history").click();
  await tick();
  assert.ok(!get("step-history").hidden, "history visible");
  assert.equal(get("h-tbody").children.length, 1, "one run row");
  assert.match(get("h-tbody").children[0].textContent, /October payroll/);
  assert.match(get("h-tbody").children[0].textContent, new RegExp(QA.signedTxid.slice(0, 10)));
  const totText = [...get("h-tot-tbody").children].map((c) => c.textContent).join(" | ");
  assert.match(totText, /Alice/);
  assert.match(totText, /1\.25/);
  assert.match(totText, /Carol/);
  assert.match(get("h-count").textContent, /\(1\)/);
  // history survives a re-render and validates records
  T.renderHistory();
  await tick();
  assert.equal(get("h-tbody").children.length, 1);
  assert.match(get("h-tbody").children[0].textContent, /October payroll/);
  get("h-clear").click();
  await tick();
  assert.equal(localStorageShim.getItem("pearl-payroll:history:mainnet"), null);
  assert.match(get("h-msg").textContent, /cleared/);
});

test("wipe button clears key material", async () => {
  get("s-key").value = WIF;
  get("wipe").click();
  await tick();
  assert.equal(get("s-key").value, "");
  assert.match(get("wipe-msg").textContent, /wiped/);
});
