// Pearl Invoice DOM integration test — boots the real index.html + committed
// bundle (pearl-invoice.bundle.js) + qrcode.min.js + app.js against a minimal
// DOM shim (with class-aware querySelector) and stubbed Blockbook fetch.
// Drives: refused builds (empty / dust / bad address) -> sealed descriptor ->
// fresh-address derivation + wipe -> receive QR -> watch unpaid/partial/paid/
// overpaid/unreachable -> air-gapped txid -> receipt -> CSV/JSON export fns ->
// verify tab PROVEN / NOT PROVEN -> footer attribution + honest limits.
// Run: node --no-warnings --loader ./tests/loader.mjs --test tests/dom.test.mjs
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
let watchMode = "unpaid"; // unpaid | partial | paid | overpaid | unreachable | txids
const TXA = "a".repeat(64), TXB = "b".repeat(64);
// The derivation test re-seals the invoice to a fresh address, so the stub
// pays whatever address the live invoice carries (fallback: the fixture one).
const payAddr = () => (sandbox.__invoiceTest && sandbox.__invoiceTest.state.invoice && sandbox.__invoiceTest.state.invoice.address) || ADDR;
const txObj = (txid, conf, v) => ({ txid, confirmations: conf, vout: [{ addresses: [payAddr()], value: String(v) }] });
async function stubFetch(url, opts = {}) {
  const u = String(url);
  const path = u.replace(/^https?:\/\/[^/]+/, "");
  const body = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
  if (path.startsWith("/api/v2/tx/")) {
    const id = path.split("/api/v2/tx/")[1].split("?")[0];
    if (id === TXA) return body(txObj(TXA, 6, 175000000));
    return body(txObj(id, 1, 175000000));
  }
  if (path.startsWith("/api/v2/address/")) {
    if (watchMode === "unreachable") return { ok: false, status: 502, text: async () => "bad gateway" };
    if (watchMode === "txids") return body({ txs: [TXA], totalReceived: "175000000" });
    if (watchMode === "partial") return body({ txs: [txObj(TXA, 3, 50000000)], totalReceived: "50000000" });
    if (watchMode === "paid") return body({ txs: [txObj(TXA, 6, 175000000)], totalReceived: "175000000" });
    if (watchMode === "overpaid") return body({ txs: [txObj(TXA, 6, 200000000)], totalReceived: "200000000" });
    return body({ txs: [], totalReceived: "0" });
  }
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
for (const f of ["qrcode.min.js", "pearl-invoice.bundle.js", "app.js"]) {
  vm.runInContext(fs.readFileSync(resolvePath(dir, f), "utf8"), sandbox, { filename: f, timeout: 15000 });
}

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const R = sandbox.PearlInvoice;
assert.ok(R, "bundle exposes window.PearlInvoice");

async function waitFor(fn, label) {
  for (let i = 0; i < 150; i++) { if (fn()) return; await tick(40); }
  throw new Error("timeout waiting for: " + label);
}

test("boot: footer attribution, honest limits, step 1 visible", () => {
  assert.equal(getEl("donate-addr").textContent, "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d");
  assert.ok(html.includes("https://x.com/kshot9000"), "x link in footer");
  assert.ok(html.includes("Honest limits"), "honest-limits panel present");
  assert.ok(!getEl("inv-panel-1").hidden, "step 1 visible at boot");
  assert.ok(getEl("inv-panel-2").hidden, "step 2 hidden at boot");
  assert.ok(sandbox.__invoiceTest, "test hook exposed");
});

test("refused: empty invoicee + empty items", () => {
  getEl("inv-build").click();
  return tick().then(() => {
    assert.equal(getEl("inv-error").hidden, false);
    assert.match(getEl("inv-error").textContent, /invoicee name is required|line item/);
  });
});

test("refused: sub-dust total", async () => {
  getEl("inv-invoicee").value = "Acme";
  const rows = documentShim.querySelectorAll(".inv-item-row");
  rows[0].querySelector(".inv-item-desc").value = "tiny";
  rows[0].querySelector(".inv-item-amt").value = "0.00000001";
  rows[1].querySelector(".inv-rm").click();
  getEl("inv-address").value = ADDR;
  getEl("inv-build").click();
  await tick();
  assert.equal(getEl("inv-error").hidden, false);
  assert.match(getEl("inv-error").textContent, /dust floor/);
});

test("refused: invalid address is loud", async () => {
  const rows = documentShim.querySelectorAll(".inv-item-row");
  rows[0].querySelector(".inv-item-amt").value = "1.75";
  getEl("inv-address").value = "junk address";
  getEl("inv-build").click();
  await tick();
  assert.equal(getEl("inv-error").hidden, false);
  assert.match(getEl("inv-error").textContent, /Not a valid Pearl Taproot address/);
});

test("compose -> descriptor sealed with pinned hash", async () => {
  getEl("inv-address").value = ADDR;
  getEl("inv-payer").value = "Bob";
  getEl("inv-memo").value = "test memo";
  getEl("inv-build").click();
  await waitFor(() => !getEl("inv-panel-2").hidden, "descriptor panel");
  const desc = getEl("inv-descriptor").textContent;
  assert.match(desc, /^pearl-invoice:v1:prl:[0-9a-f]{64}:175000000$/);
  assert.equal(getEl("inv-hash").textContent.length, 64);
  assert.ok(getEl("inv-canonical").textContent.includes("Acme"));
  assert.ok(getEl("inv-desc-meta").textContent.includes("1.75 PRL"));
});

test("fresh address derivation + wipe + re-seal", async () => {
  const M = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  getEl("inv-mnemonic").value = M;
  getEl("inv-derive").click();
  await tick();
  const fresh = getEl("inv-fresh-addr").textContent;
  assert.match(fresh, /^prl1/);
  assert.equal(fresh, "prl1pj05kqvekpwaa6880l6fcr3sqzv4r7a65ms5pt3qmt6dpr92lj8hqnngdlv");
  assert.ok(getEl("inv-fresh-path").textContent.includes("9001"));
  getEl("inv-use-fresh").click();
  await tick();
  assert.ok(getEl("inv-desc-meta").textContent.includes(fresh.slice(0, 12)));
  assert.equal(getEl("inv-address").value, fresh);
  // restore the fixture address for the watch tests
  getEl("inv-wipe").click();
  await tick();
  assert.equal(getEl("inv-mnemonic").value, "");
  assert.ok(getEl("inv-fresh-out").hidden);
});

test("receive step renders QR + exact pearl: URI", async () => {
  getEl("inv-to-receive").click();
  await waitFor(() => !getEl("inv-panel-3").hidden, "receive panel");
  assert.ok(getEl("inv-qr").innerHTML.includes("<svg"), "QR svg rendered");
  const uri = getEl("inv-uri").textContent;
  assert.ok(uri.startsWith("pearl:prl1"), uri.slice(0, 40));
  assert.ok(uri.includes("?amount="), uri);
});

test("watch: unpaid -> partial -> paid -> overpaid", async () => {
  getEl("inv-to-watch").click();
  await waitFor(() => !getEl("inv-panel-4").hidden, "watch panel");
  getEl("inv-blockbook").value = "https://blockbook.pearlresearch.ai";
  watchMode = "unpaid";
  getEl("inv-refresh").click();
  await waitFor(() => /UNPAID|UNREACHABLE/.test(getEl("inv-watch-state").textContent), "unpaid state");
  assert.match(getEl("inv-watch-state").textContent, /UNPAID/);
  assert.ok(getEl("inv-to-receipt").disabled, "receipt locked while unpaid");

  watchMode = "partial";
  getEl("inv-refresh").click();
  await waitFor(() => /PARTIAL/.test(getEl("inv-watch-state").textContent), "partial state");
  assert.match(getEl("inv-watch-state").textContent, /0\.5 PRL.*1\.25 PRL|still due/, "partial shows received + remaining");
  assert.equal(getEl("inv-tx-tbody").children.length, 1, "one payment row");

  watchMode = "paid";
  getEl("inv-refresh").click();
  await waitFor(() => /PAID/.test(getEl("inv-watch-state").textContent), "paid state");
  assert.ok(!getEl("inv-to-receipt").disabled, "receipt unlocked on paid");

  watchMode = "overpaid";
  getEl("inv-refresh").click();
  await waitFor(() => /OVERPAID/.test(getEl("inv-watch-state").textContent), "overpaid state");
  assert.match(getEl("inv-watch-state").textContent, /over the total/);
});

test("watch: txid-only backend falls back to per-tx fetch", async () => {
  watchMode = "txids";
  getEl("inv-refresh").click();
  await waitFor(() => /PAID/.test(getEl("inv-watch-state").textContent), "paid via txid fallback");
});

test("watch: unreachable Blockbook is honest", async () => {
  watchMode = "unreachable";
  getEl("inv-refresh").click();
  await waitFor(() => /UNREACHABLE/.test(getEl("inv-watch-state").textContent), "unreachable state");
  assert.equal(getEl("inv-error").hidden, false);
  assert.match(getEl("inv-error").textContent, /Blockbook read failed/);
  watchMode = "paid";
});

test("air-gapped txid path", async () => {
  getEl("inv-txid-paste").value = TXA;
  getEl("inv-check-txid").click();
  await waitFor(() => /PAID/.test(getEl("inv-watch-state").textContent), "txid analyzed");
  assert.match(getEl("inv-watch-note").textContent, /Air-gapped/);
});

test("receipt issue + export helpers", async () => {
  getEl("inv-to-receipt").click();
  await waitFor(() => !getEl("inv-panel-5").hidden, "receipt panel");
  getEl("inv-issue-receipt").click();
  await tick();
  assert.ok(!getEl("inv-receipt-out").hidden, "receipt shown");
  assert.match(getEl("inv-receipt-str").textContent, /^pearl-invoice-receipt:v1:[0-9a-f]{64}:[0-9a-f]{64}:175000000$/);
  const st = sandbox.__invoiceTest.state;
  const csv = R.invoiceToCSV(st.invoice, st.descriptorObj, st.receiptObj);
  assert.match(csv, /pearl-invoice-receipt:v1:/);
  const json = JSON.parse(R.invoiceToJSONExport(st.invoice, st.descriptorObj, st.receiptObj));
  assert.equal(json.receipt.receiptHash, st.receiptObj.receiptHash);
});

test("verify tab: PROVEN, then tampered -> NOT PROVEN", async () => {
  getEl("inv-ver-tab").click();
  await tick();
  assert.ok(!getEl("inv-verify-wrap").hidden, "verify shown");
  getEl("inv-ver-fill").click();
  await tick();
  getEl("inv-ver-run").click();
  await tick();
  assert.match(getEl("inv-ver-out").innerHTML, /PROVEN/);
  assert.ok(!/NOT PROVEN/.test(getEl("inv-ver-out").innerHTML));
  // tamper one character of the invoice JSON
  const j = getEl("inv-ver-json");
  j.value = j.value.replace("test memo", "test MEMO");
  getEl("inv-ver-run").click();
  await tick();
  assert.match(getEl("inv-ver-out").innerHTML, /NOT PROVEN/);
});
