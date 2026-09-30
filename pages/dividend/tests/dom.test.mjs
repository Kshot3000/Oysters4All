// Pearl Dividend DOM tests: runs the real pearl-dividend.bundle.js + app.js in a
// minimal vm DOM (adapted from the lend harness). Drives Token (manual meta) ->
// Snapshot (sample CSV) -> Plan -> Fund (pasted UTXOs) -> Sign (real Schnorr,
// key wiped) -> Broadcast list render -> Verify (plan-only PROVEN).
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

/* ---------- minimal DOM (from the lend harness) ---------- */
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
  querySelector() { return null; }
  querySelectorAll() { return []; }
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
  querySelectorAll: (sel) => (sel === "#steps button" ? stepButtons : []),
  querySelector: () => null,
  createElement: (t) => new El(t),
  body: new El("body"),
  readyState: "complete",
};

async function unexpectedFetch(url) {
  throw new Error("unexpected network fetch in DOM test: " + url);
}

const sandbox = {
  document: documentShim,
  navigator: {},
  URL: { createObjectURL: () => "blob:stub", revokeObjectURL() {} },
  Blob: class { constructor(parts) { this.parts = parts; } },
  TextDecoder, crypto: webcrypto, fetch: unexpectedFetch,
  setTimeout, clearTimeout, setInterval, clearInterval,
  addEventListener() {},
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
for (const f of ["pearl-dividend.bundle.js", "app.js"]) {
  vm.runInContext(fs.readFileSync(resolvePath(dir, f), "utf8"), sandbox, { filename: f, timeout: 30000 });
}

const P = sandbox.PearlDividend;
assert.ok(P, "bundle exposes window.PearlDividend");
const get = (id) => documentShim.getElementById(id);
const set = (id, v) => { get(id).value = v; };
const click = (id) => get(id).click();
const noErr = (id) => assert.equal(get(id).hidden, true, `${id} should be hidden, got: ${get(id).textContent}`);

// fixture keys through the real bundle (funder address = the secret's tweaked keypath address)
const PRIV_F = "99".repeat(32);
const FUNDER = P.parseBatchSecret(PRIV_F, P.NETWORKS.mainnet).address;
const H = (seed) => P.encodeBech32m("prl", 1, P.schnorr.getPublicKey(P.hexToBytes(seed.repeat(32))));
const A1 = H("a1"), A2 = H("a2"), A3 = H("a3");
const CSV = `${A1},100\n${A2},300\n${A3},600`;

test("token step: manual metadata unlocks snapshot", () => {
  set("tok-tick", "divt");
  get("tok-manual").checked = true;
  get("tok-manual").fire("change");
  assert.equal(get("tok-decimals").disabled, false);
  set("tok-decimals", "8");
  click("tok-fetch");
  noErr("tok-error");
  assert.equal(get("tok-result").hidden, false);
  assert.equal(get("tok-r-tick").textContent, "divt");
  assert.match(get("tok-r-src").textContent, /manual/);
  const snapBtn = stepButtons.find((b) => b.dataset.step === "snapshot");
  assert.equal(snapBtn.disabled, false, "snapshot step unlocked");
});

test("snapshot step: sample CSV seals with fingerprint", () => {
  click("snap-sample");
  assert.ok(get("snap-csv").value.includes("prl1"), "sample CSV loaded");
  click("snap-parse");
  noErr("snap-error");
  assert.equal(get("snap-result").hidden, false);
  assert.equal(get("snap-r-count").textContent, "8");
  assert.match(get("snap-r-fp").textContent, /^[0-9a-f]{16}$/);
  const planBtn = stepButtons.find((b) => b.dataset.step === "plan");
  assert.equal(planBtn.disabled, false, "plan step unlocked");
  // the rest of the flow uses a small deterministic 3-holder snapshot
  set("snap-csv", CSV);
  click("snap-parse");
  noErr("snap-error");
  assert.equal(get("snap-r-count").textContent, "3");
});

test("snapshot step: duplicates surface merge/refuse", () => {
  const dup = `${A1},100\n${A2},300\n${A1},50`;
  set("snap-csv", dup);
  click("snap-parse");
  assert.equal(get("snap-dups").hidden, false, "duplicate panel shown");
  click("snap-merge");
  noErr("snap-error");
  assert.equal(get("snap-result").hidden, false);
  // restore the deterministic 3-holder snapshot for the rest of the flow
  set("snap-csv", CSV);
  click("snap-parse");
  noErr("snap-error");
  assert.equal(get("snap-r-count").textContent, "3");
});

test("plan step: shares computed grain-exact, table rendered", () => {
  set("plan-pool", "1");
  set("plan-rule", "proportional");
  set("plan-funder", FUNDER);
  click("plan-build");
  noErr("plan-error");
  assert.equal(get("plan-result").hidden, false);
  assert.match(get("plan-r-counts").textContent, /3 eligible · 3 paid/);
  assert.match(get("plan-r-total").textContent, /1 PRL/);
  assert.match(get("plan-r-remainder").textContent, /0 PRL/);
  assert.match(get("plan-r-fp").textContent, /^[0-9a-f]{16}$/);
  const body = get("plan-table-body").innerHTML;
  assert.ok(body.includes(A1.slice(0, 20)), "share table lists holder 1");
  assert.ok(body.includes("0.1"), "share table shows 0.1 PRL share");
  const fundBtn = stepButtons.find((b) => b.dataset.step === "fund");
  assert.equal(fundBtn.disabled, false, "fund step unlocked");
});

test("fund step: pasted UTXOs fund the chunk", () => {
  set("fund-paste", `${"ab".repeat(32)}:0 200000000`);
  click("fund-apply");
  noErr("fund-error");
  assert.equal(get("fund-result").hidden, false);
  assert.match(get("fund-chunks").innerHTML, /Transaction 1 of 1/);
  assert.match(get("fund-chunks").innerHTML, /3 UTXO|1 UTXO/);
  const signBtn = stepButtons.find((b) => b.dataset.step === "sign");
  assert.equal(signBtn.disabled, false, "sign step unlocked");
});

test("sign step: local sign re-verifies and wipes the key", async () => {
  set("sign-key", PRIV_F);
  click("sign-sign");
  await new Promise((r) => setImmediate(r)); // let the async sign handler finish
  noErr("sign-error");
  assert.equal(get("sign-result").hidden, false);
  assert.equal(get("sign-r-txid").textContent.length, 64);
  assert.match(get("sign-r-sigs").textContent, /1\/1/);
  assert.equal(get("sign-key").value, "", "key wiped after signing");
  assert.ok(get("sign-r-hex").value.length > 100, "signed hex present");
  assert.match(get("bcast-list").innerHTML, /Broadcast/);
  const bBtn = stepButtons.find((b) => b.dataset.step === "broadcast");
  assert.equal(bBtn.disabled, false, "broadcast step unlocked");
});

test("sign step: wrong key is refused", () => {
  set("sign-key", "11".repeat(32));
  click("sign-sign");
  assert.equal(get("sign-error").hidden, false);
  assert.match(get("sign-error").textContent, /does not control|refus/i);
  assert.equal(get("sign-result").hidden, true);
});

test("verify step: plan-only verify returns PROVEN", async () => {
  // self-contained: seal + plan through the bundle, verify through the UI
  const parsed = P.parseSnapshotCsv(CSV, { network: P.NETWORKS.mainnet, decimals: 8 });
  const sealed = P.buildSnapshotDescriptor({
    network: P.NETWORKS.mainnet, tick: "divt", decimals: 8,
    holders: parsed.holders, manualMeta: true,
  });
  const plan = P.planDividend({
    network: P.NETWORKS.mainnet, snapshot: sealed, snapshotFingerprint: sealed.fingerprint,
    rule: "proportional", poolPRL: "1", dustPRL: "0.00000546", feeRate: 2,
    maxOutputsPerTx: 250, exclusions: [], minBalanceUnits: "0",
    treasuryAddress: null, funderAddress: FUNDER, memo: "",
  });
  set("ver-csv", CSV);
  set("ver-bundle", JSON.stringify({ descriptor: plan.descriptor, fingerprint: plan.fingerprint, funderAddress: FUNDER }));
  set("ver-txids", "");
  click("ver-run");
  await new Promise((r) => setImmediate(r));
  noErr("ver-error");
  assert.equal(get("ver-verdict").hidden, false);
  assert.match(get("ver-verdict").textContent, /PROVEN/);
});

test("verify step: tampered fingerprint is NOT PROVEN", async () => {
  set("ver-bundle", JSON.stringify({ descriptor: { kind: "pearl-div:v1" }, fingerprint: "0".repeat(16) }));
  click("ver-run");
  await new Promise((r) => setImmediate(r));
  assert.equal(get("ver-verdict").hidden, false);
  assert.match(get("ver-verdict").textContent, /NOT PROVEN/);
});
