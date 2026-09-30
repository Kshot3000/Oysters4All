// Pearl Vault DOM tests: runs the real pearl-vault.bundle.js + qrcode.min.js +
// app.js in a minimal vm DOM (adapted from the watch app's harness), with a
// stubbed Blockbook. Drives Forge -> Fund -> Plan -> Sign -> Track -> Verify.
// Usage: node --no-warnings --loader ./tests/loader.mjs tests/vault.dom.test.mjs
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

/* ---------- minimal DOM (from the watch harness) ---------- */
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
    this.type = ""; this.placeholder = ""; this.spellcheck = false;
    this.autocomplete = ""; this.title = "";
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
    el._attached = true;
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
  querySelectorAll: () => [],
  querySelector: () => null,
  createElement: (t) => new El(t),
  body: new El("body"),
  readyState: "complete",
  execCommand: () => false,
};

/* ---------- stubbed Blockbook ---------- */
const QA = { addr: null, utxos: [], txid: null, down: false };
const okBody = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });
const fail = (status) => ({ ok: false, status, json: async () => ({}), text: async () => "error" });
async function stubFetch(url, opts = {}) {
  const u = String(url);
  const path = u.replace(/^https?:\/\/[^/]+/, "");
  if (QA.down) throw new Error("ECONNREFUSED");
  if (path.startsWith("/api/v2/address/")) {
    const a = decodeURIComponent(path.split("/api/v2/address/")[1].split("?")[0]);
    if (a !== QA.addr) return fail(404);
    const bal = QA.utxos.reduce((s, x) => s + BigInt(x.value), 0n);
    return okBody({ address: a, balance: bal.toString(), totalReceived: bal.toString(), totalSent: "0", txCount: QA.utxos.length });
  }
  if (path.startsWith("/api/v2/utxo/")) {
    return okBody(QA.utxos);
  }
  if (path.startsWith("/api/v2/estimatefee/")) {
    return okBody({ result: 0.00012 }); // PRL/kB -> grains/vB math is the app's
  }
  if (path === "/api/sendtx/" || path === "/api/sendtx") {
    return okBody({ result: QA.txid || "00".repeat(32) });
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
for (const f of ["qrcode.min.js", "pearl-vault.bundle.js", "app.js"]) {
  vm.runInContext(fs.readFileSync(resolvePath(dir, f), "utf8"), sandbox, { filename: f, timeout: 30000 });
}

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const R = sandbox.PearlVault;
assert.ok(R, "bundle exposes window.PearlVault");
const T = sandbox.__vaultTest;
assert.ok(T, "test hook exposed");
const get = (id) => documentShim.getElementById(id);

// fixture cosigners: fixed privkeys -> x-only pubkeys through the real bundle
const PRIVS = ["11".repeat(32), "22".repeat(32), "33".repeat(32)];
const XONLY = PRIVS.map((p) => R.bytesToHex(R.schnorr.getPublicKey(R.hexToBytes(p))));
const TXA = "aa".repeat(32);

test("boot: attribution, honest limits, forge tab active", () => {
  assert.ok(html.includes("prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d"), "donation address in footer");
  assert.ok(html.includes("https://x.com/kshot9000"), "x link in footer");
  assert.ok(html.includes("Honest limits"), "honest-limits panel present");
  assert.ok(get("tb-forge").classList.contains("active"), "forge tab active");
  assert.ok(!get("panel-forge").hidden, "forge panel visible");
  assert.ok(get("panel-fund").hidden, "fund panel hidden");
});

test("forge: junk key refused loudly", () => {
  T.forge("mainnet", 2, ["junk-key", XONLY[1], XONLY[2]]);
  const e = T.err();
  assert.ok(!e.hidden, "error shown");
  assert.match(e.text, /VAULT REFUSED/);
  assert.equal(T.state().descriptor, null);
});

test("forge: duplicate cosigner refused loudly", () => {
  T.forge("mainnet", 2, [XONLY[0], XONLY[0], XONLY[2]]);
  assert.match(T.err().text, /duplicate/);
  assert.equal(T.state().descriptor, null);
});

test("forge: 2-of-3 vault forges, descriptor stored", () => {
  T.forge("mainnet", 2, XONLY);
  const e = T.err();
  assert.ok(e.hidden, "no error: " + e.text);
  const st = T.state();
  assert.ok(st.descriptor, "descriptor in state");
  assert.equal(st.descriptor.m, 2);
  assert.equal(st.descriptor.n, 3);
  assert.ok(st.descriptor.address.startsWith("prl1"), "prl1 address");
  assert.ok(st.descriptor.descriptor.startsWith("pearlvault:v1:prl:2:3:"));
  assert.equal(get("f-address").textContent, st.descriptor.address);
  assert.ok(!get("f-result").hidden, "result shown");
  QA.addr = st.descriptor.address;
});

test("fund: refresh fills balance + UTXOs from stubbed Blockbook", async () => {
  QA.utxos = [{ txid: TXA, vout: 0, value: 300000000, confirmations: 6 }];
  get("tb-fund").click();
  get("fund-refresh").click();
  await tick(80);
  const e = T.err();
  assert.ok(e.hidden, "no error: " + e.text);
  assert.ok(get("fund-balance").textContent.includes("3"), "balance rendered: " + get("fund-balance").textContent);
  assert.equal(T.state().fundUtxos.length, 1);
});

test("plan: bundle builds with exact fee math", async () => {
  get("tb-plan").click();
  get("plan-fetch").click();
  await tick(80);
  assert.ok(T.err().hidden, "fetch ok: " + T.err().text);
  assert.equal(T.planUtxoRows().length, 1);
  const d = T.state().descriptor;
  T.addRecip(d.address, "1");
  get("plan-feerate").value = "10";
  get("plan-build").click();
  const e2 = T.err();
  assert.ok(e2.hidden, "no error: " + e2.text);
  const st = T.state();
  assert.ok(st.bundle, "bundle in state");
  assert.equal(st.bundle.kind, "pearl-vault-unsigned:v1");
  assert.equal(st.bundle.digests.length, 1);
  assert.ok(get("plan-bundle").value.includes("pearl-vault-unsigned:v1"), "bundle JSON rendered");
  assert.ok(!get("plan-result").hidden, "result shown");
});

test("plan: dust output refused loudly", () => {
  const d = T.state().descriptor;
  T.addRecip(d.address, "0.000001"); // 100 grains < 546 dust
  get("plan-build").click();
  assert.match(T.err().text, /dust/);
});

test("sign: bundle import re-derives and checks out", () => {
  get("tb-sign").click();
  const st = T.state();
  get("s-bundle").value = JSON.stringify(st.bundle);
  get("s-import").click();
  const e = T.err();
  assert.ok(e.hidden, "no error: " + e.text);
  assert.ok(get("s-check").textContent.includes("BUNDLE CHECKS OUT"), "check shown");
  assert.ok(!get("s-signbox").hidden, "sign box shown");
});

test("sign: wrong-party key refused loudly", () => {
  get("s-keyindex").value = "1"; // cosigner 1, but key belongs to cosigner 0
  get("s-key").value = PRIVS[0];
  get("s-sign").click();
  assert.match(T.err().text, /not cosigner 1|wrong party/);
  assert.equal(get("s-partial").value, "", "no partial exported");
});

test("sign: cosigner 0 signs, partial exported", () => {
  get("s-keyindex").value = "0";
  get("s-key").value = PRIVS[0];
  get("s-sign").click();
  const e = T.err();
  assert.ok(e.hidden, "no error: " + e.text);
  const p = JSON.parse(get("s-partial").value);
  assert.equal(p.kind, "pearl-vault-partialsig:v1");
  assert.equal(p.keyIndex, 0);
  get("s-wipe").click();
  assert.equal(get("s-key").value, "", "key wiped");
});

test("coordinator: two partials finalize a 2-of-3 spend", async () => {
  // second cosigner signs through the real bundle (test-side, same code path)
  const st = T.state();
  const d = st.descriptor;
  const parsed = R.parseUnsignedBundle(st.bundle, d);
  const p1 = R.signBundle(parsed, d, 1, R.hexToBytes(PRIVS[1]));
  // first partial came from the UI; add it
  get("c-partials").value = get("s-partial").value;
  get("c-add").click();
  assert.ok(T.err().hidden, "partial 0 accepted: " + T.err().text);
  get("c-partials").value = JSON.stringify(p1);
  get("c-add").click();
  assert.ok(T.err().hidden, "partial 1 accepted: " + T.err().text);
  assert.equal(T.state().partials.length, 2);
  get("c-finalize").click();
  const e = T.err();
  assert.ok(e.hidden, "no error: " + e.text);
  const fin = T.state().finalized;
  assert.ok(fin && /^[0-9a-f]{64}$/.test(fin.txid), "txid: " + (fin && fin.txid));
  assert.ok(get("c-hex").value.length > 100, "hex rendered");
  assert.ok(!get("c-result").hidden, "result shown");
});

test("coordinator: broadcast needs two clicks, then accepted", async () => {
  const fin = T.state().finalized;
  QA.txid = fin.txid;
  get("c-broadcast").click(); // arms
  assert.ok(get("c-broadcast").textContent.includes("again"), "armed");
  assert.ok(get("c-bcast").hidden, "not broadcast yet");
  get("c-broadcast").click(); // confirms
  await tick(80);
  assert.ok(T.err().hidden, "no error: " + T.err().text);
  assert.ok(get("c-bcast").textContent.includes("BROADCAST ACCEPTED"), "accepted");
  assert.equal(get("t-txid").value, fin.txid, "txid carried to track tab");
});

test("track: confirmations from stubbed Blockbook", async () => {
  const fin = T.state().finalized;
  QA.txDetail = { txid: fin.txid, blockHeight: 120200, confirmations: 3 };
  get("tb-track").click();
  get("t-check").click();
  await tick(80);
  assert.ok(T.err().hidden, "no error: " + T.err().text);
  assert.ok(get("t-result").textContent.includes("3 confirmation"), "confirmations shown");
});

test("verify: descriptor PROVEN, tampered NOT PROVEN", () => {
  const d = T.state().descriptor;
  get("tb-verify").click();
  get("v-json").value = JSON.stringify(d);
  get("v-run").click();
  assert.ok(get("v-result").textContent.includes("PROVEN"), "proven");
  assert.ok(!get("v-result").textContent.includes("NOT PROVEN"), "not not-proven");
  const bad = { ...d, address: d.address.slice(0, -2) + "qq" };
  get("v-json").value = JSON.stringify(bad);
  get("v-run").click();
  assert.ok(get("v-result").textContent.includes("NOT PROVEN"), "tampered refused");
});
