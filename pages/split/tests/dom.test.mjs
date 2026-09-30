// Pearl Split DOM tests: runs the real pearl-split.bundle.js + app.js in a
// minimal vm DOM (adapted from the dividend harness). Drives Tab -> Expenses
// -> Settle -> Pay (fund, sign with real Schnorr, key wiped, broadcast via a
// stubbed fetch) -> Ledger (record + CSV). The harness teaches the fake DOM
// to parse the member-checkbox picker and data-rm/data-re buttons, since the
// split UI renders those dynamically.
// Usage: node --no-warnings tests/dom.test.mjs
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

/* ---------- minimal DOM (from the dividend harness, + data-attr parsing) ---------- */
class ClassList {
  constructor() { this.s = new Set(); }
  add(...c) { c.forEach((x) => this.s.add(x)); }
  remove(...c) { c.forEach((x) => this.s.delete(c)); }
  toggle(c, f) { (f ?? !this.s.has(c)) ? this.s.add(c) : this.s.delete(c); }
  contains(c) { return this.s.has(c); }
}
const registry = [];
function hydrate(el, htmlStr) {
  // parse the dynamically-rendered inputs/buttons the split UI creates
  const re = /<(input|button)\b([^>]*)>/g;
  let m;
  while ((m = re.exec(htmlStr))) {
    const attrs = m[2];
    const dm = attrs.match(/\bdata-(em|rm|re)="([^"]*)"/);
    if (!dm) continue;
    const kid = new El(m[1]);
    kid.dataset[dm[1]] = dm[2];
    if (/\bchecked\b/.test(attrs)) kid.checked = true;
    if (/\bdisabled\b/.test(attrs)) kid.disabled = true;
    const tm = attrs.match(/\btype="([^"]*)"/);
    if (tm) kid.type = tm[1];
    el._kids.push(kid);
  }
}
class El {
  constructor(tag, id = "") {
    this.tagName = tag.toUpperCase(); this.id = id;
    this.classList = new ClassList(); this._className = "";
    this.dataset = {};
    this.value = ""; this._text = ""; this._html = "";
    this.hidden = false; this.disabled = false; this.checked = false;
    this.style = {}; this._handlers = {}; this._kids = [];
    this._attrs = {};
    this.type = ""; this.placeholder = ""; this.spellcheck = false;
    registry.push(this);
  }
  setAttribute(k, v) { this._attrs[k] = String(v); }
  getAttribute(k) { return this._attrs[k] ?? null; }
  set className(v) { this._className = String(v); String(v).split(/\s+/).forEach((c) => c && this.classList.add(c)); }
  get className() { return this._className; }
  set innerHTML(v) {
    this._html = String(v); this._kids = [];
    this._text = String(v).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    hydrate(this, String(v));
  }
  get innerHTML() { return this._html; }
  set textContent(v) { this._text = String(v); }
  get textContent() { return this._text; }
  addEventListener(t, fn) { (this._handlers[t] ??= []).push(fn); }
  click() { (this._handlers.click || []).forEach((f) => f({ target: this, preventDefault() {} })); }
  fire(t, extra = {}) { (this._handlers[t] || []).forEach((f) => f({ target: this, preventDefault() {}, ...extra })); }
  appendChild(k) { this._kids.push(k); return k; }
  remove() { for (const e of registry) e._kids = e._kids.filter((x) => x !== this); }
  get children() { return this._kids; }
  querySelector(sel) { const all = this.querySelectorAll(sel); return all[0] || null; }
  querySelectorAll(sel) {
    const mm = sel.match(/^\[data-(em|rm|re)\]$/);
    if (!mm) return [];
    const out = [];
    const walk = (e) => { for (const k of e._kids) { if (k.dataset[mm[1]] !== undefined) out.push(k); walk(k); } };
    walk(this);
    return out;
  }
  scrollIntoView() {}
  select() {}
}
const byId = new Map();
const stepButtons = [];
for (const m of html.matchAll(/<button[^>]*\bdata-step="([^"]+)"[^>]*>/g)) {
  const el = new El("button");
  el.dataset.step = m[1];
  el.disabled = /disabled/.test(m[0]);
  if (/\bactive\b/.test(m[0])) el.classList.add("active");
  stepButtons.push(el);
}
const attrMap = new Map();
for (const m of html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)) {
  if (attrMap.has(m[1])) continue;
  const tag = m[0];
  const vv = tag.match(/\bvalue="([^"]*)"/);
  const cc = tag.match(/\bclass="([^"]*)"/);
  attrMap.set(m[1], {
    value: vv ? vv[1] : "",
    cls: cc ? cc[1] : "",
    checked: /\bchecked\b/.test(tag),
    hidden: /\bhidden\b/.test(tag),
  });
}
const getEl = (id) => {
  if (!byId.has(id)) {
    const el = new El("div", id);
    const a = attrMap.get(id);
    if (a) {
      if (a.value) el.value = a.value;
      if (a.cls) el.className = a.cls;
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
    if (sel === "#steps button") return stepButtons;
    if (sel.startsWith("#e-members")) return getEl("e-members").querySelectorAll("[data-em]");
    return [];
  },
  querySelector: () => null,
  createElement: (t) => new El(t),
  body: new El("body"),
  readyState: "complete",
};

const lsMem = {};
const lsShim = {
  getItem: (k) => (k in lsMem ? lsMem[k] : null),
  setItem: (k, v) => { lsMem[k] = String(v); },
  removeItem: (k) => { delete lsMem[k]; },
};

async function stubFetch(url, opts = {}) {
  const u = String(url);
  if (u.includes("/api/sendtx/")) {
    const j = { result: "cd".repeat(32) };
    return { ok: true, status: 200, text: async () => JSON.stringify(j), json: async () => j };
  }
  throw new Error("unexpected network fetch in DOM test: " + url);
}

const sandbox = {
  document: documentShim,
  navigator: {},
  localStorage: lsShim,
  URL: { createObjectURL: () => "blob:stub", revokeObjectURL() {} },
  Blob: class { constructor(parts) { this.parts = parts; } },
  TextDecoder, crypto: webcrypto, fetch: stubFetch,
  setTimeout, clearTimeout, setInterval, clearInterval,
  addEventListener() {},
  scrollTo() {},
  confirm: () => true,
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
for (const f of ["pearl-split.bundle.js", "app.js"]) {
  vm.runInContext(fs.readFileSync(resolvePath(dir, f), "utf8"), sandbox, { filename: f, timeout: 30000 });
}

const P = sandbox.PearlSplit;
assert.ok(P, "bundle exposes window.PearlSplit");
const get = (id) => documentShim.getElementById(id);
const set = (id, v) => { get(id).value = v; };
const click = (id) => get(id).click();
const noErr = (id) => assert.equal(get(id).hidden, true, `${id} should be hidden, got: ${get(id).textContent}`);

// fixture: debtor's key controls the debtor address; creditors are plain addresses
const DEBTOR_PRIV = "99".repeat(32);
const DEBTOR = P.parseBatchSecret(DEBTOR_PRIV, P.NETWORKS.mainnet).address;
const H = (seed) => P.encodeBech32m("prl", 1, P.schnorr.getPublicKey(P.hexToBytes(seed.repeat(32))));
const C1 = H("c1"), C2 = H("c2");

test("tab step: seat members, bad address refused", () => {
  set("m-name", "Deb"); set("m-addr", DEBTOR); click("m-add"); noErr("tab-error");
  set("m-name", "CredA"); set("m-addr", C1); click("m-add"); noErr("tab-error");
  set("m-name", "CredB"); set("m-addr", C2); click("m-add"); noErr("tab-error");
  set("m-name", "Bad"); set("m-addr", "prl1notreal"); click("m-add");
  assert.equal(get("tab-error").hidden, false, "bad address refused");
  assert.match(get("tab-error").textContent, /invalid address|wrong network/i);
  set("tab-name", "Sample steak night");
  click("tab-start");
  noErr("tab-error");
  assert.equal(get("e-payer").innerHTML.match(/<option/g).length, 3, "payer select has 3 members");
  const boxes = documentShim.querySelectorAll("#e-members [data-em]");
  assert.equal(boxes.length, 3, "member picker has 3 checkboxes");
  assert.ok(boxes.every((b) => b.checked), "all checked by default");
  const expBtn = stepButtons.find((b) => b.dataset.step === "expenses");
  assert.equal(expBtn.disabled, false, "expenses step unlocked");
});

test("expenses step: equal expense chalked up grain-exact", () => {
  set("e-desc", "Steakhouse bill"); set("e-amount", "1"); set("e-payer", "1");
  set("e-mode", "equal"); get("e-mode").fire("change");
  click("e-add");
  noErr("exp-error");
  const body = get("exp-list").innerHTML;
  assert.ok(body.includes("Steakhouse bill"), "expense rendered");
  assert.ok(body.includes("0.33333334 PRL"), "remainder grain on first member by index");
  const st = stepButtons.find((b) => b.dataset.step === "settle");
  assert.equal(st.disabled, false, "settle step unlocked");
});

test("expenses step: shares expense on a subset", () => {
  // uncheck CredB (index 2), shares 2:1 between Deb and CredA
  const boxes = documentShim.querySelectorAll("#e-members [data-em]");
  boxes[2].checked = false;
  set("e-desc", "Wine"); set("e-amount", "0.3"); set("e-payer", "2");
  set("e-mode", "shares"); get("e-mode").fire("change");
  set("e-shares", "2, 1");
  click("e-add");
  noErr("exp-error");
  assert.ok(get("exp-list").innerHTML.includes("Wine"), "shares expense rendered");
});

test("settle step: minimal transfers + fingerprint", () => {
  click("st-compute");
  noErr("st-error");
  assert.equal(get("st-result").hidden, false);
  const body = get("st-table-body").innerHTML;
  assert.ok(body.includes("Deb") && body.includes("CredA") && body.includes("CredB"), "balances for all members");
  const transfers = get("st-transfers").innerHTML;
  assert.ok(transfers.includes("pays"), "transfers rendered");
  assert.match(get("st-fp").textContent, /^[0-9a-f]{16}$/);
  // determinism: same state → same fingerprint through the bundle
  const st = sandbox.__splitTest.state();
  const fp2 = P.settleTab({ tabName: st.tabName, members: st.members, expenses: st.expenses, network: P.NETWORKS.mainnet }).fingerprint;
  assert.equal(get("st-fp").textContent, fp2, "fingerprint deterministic");
  const payBtn = stepButtons.find((b) => b.dataset.step === "pay");
  assert.equal(payBtn.disabled, false, "pay step unlocked");
});

test("pay step: fund from pasted UTXOs", () => {
  const st = sandbox.__splitTest.state();
  const di = st.plans.findIndex((p) => p.debtorAddress === DEBTOR);
  assert.ok(di >= 0, "Deb is a debtor in the settlement");
  set("pay-debtor", String(di));
  set("pay-feerate", "2");
  set("pay-paste", `${"ab".repeat(32)}:0 200000000`);
  click("pay-apply");
  noErr("pay-error");
  assert.equal(get("pay-result").hidden, false);
  assert.match(get("pay-r-ins").textContent, /1 UTXO/);
  assert.match(get("pay-r-fee").textContent, /PRL/);
  // Deb owes 53333334 grains to CredA — one creditor output
  assert.match(get("pay-r-out").textContent, /CredA: 0.53333334 PRL/);
});

test("pay step: wrong key is refused, right key signs and wipes", () => {
  set("pay-key", "11".repeat(32));
  click("pay-sign");
  assert.equal(get("pay-error").hidden, false);
  assert.match(get("pay-error").textContent, /does not control/i);
  assert.equal(get("pay-signed").hidden, true, "no signed hex exposed for wrong key");

  set("pay-key", DEBTOR_PRIV);
  click("pay-sign");
  noErr("pay-error");
  assert.equal(get("pay-signed").hidden, false);
  assert.match(get("pay-r-txid").textContent, /^[0-9a-f]{64}$/);
  assert.match(get("pay-r-sigs").textContent, /1\/1/);
  assert.equal(get("pay-key").value, "", "key wiped after signing");
  assert.ok(get("pay-r-hex").value.length > 100, "signed hex present");
});

test("pay step: double-confirm broadcast records the txid", async () => {
  click("pay-arm");
  assert.equal(get("pay-confirm").hidden, false, "confirm gate appears");
  set("pay-blockbook", "https://blockbook.stub");
  click("pay-confirm");
  await new Promise((r) => setImmediate(r));
  noErr("pay-error");
  assert.match(get("pay-r-bcast").textContent, /broadcast/, "broadcast recorded");
});

test("ledger step: record tab and CSV export", () => {
  click("led-record");
  noErr("led-error");
  const list = get("led-list").innerHTML;
  assert.ok(list.includes("Sample steak night"), "tab recorded in ledger");
  assert.ok(list.includes("cd".repeat(32)), "broadcast txid recorded");
  const csv = P.ledgerToCsv(P.loadLedger(lsShim));
  assert.ok(csv.includes("tab") && csv.includes("debtor"), "CSV has header + sides");
});
