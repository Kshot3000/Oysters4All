// Pearl Paywall DOM integration test — boots the real index.html + scripts
// (qrcode.min.js, pearl-paywall.bundle.js, app.js) against a minimal DOM shim
// and drives the full desk: create -> pay -> token -> verify -> snippet.
// Run: node --no-warnings --loader ./tests/loader.mjs --test ./tests/dom.test.mjs
// (no jsdom on this VM; the shim implements exactly the surface app.js uses)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { TextEncoder, TextDecoder } from "node:util";
import { randomFillSync } from "node:crypto";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dir = resolvePath(here, "..");
const html = fs.readFileSync(resolvePath(dir, "index.html"), "utf8");

/* ---------- minimal DOM (same surface as predict's shim) ---------- */
class ClassList {
  constructor() { this.s = new Set(); }
  add(...c) { c.forEach((x) => this.s.add(x)); }
  remove(...c) { c.forEach((x) => this.s.delete(x)); }
  toggle(c, f) { (f ?? !this.s.has(c)) ? this.s.add(c) : this.s.delete(c); }
  contains(c) { return this.s.has(c); }
}
class El {
  constructor(tag, id = "") {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.classList = new ClassList();
    this.dataset = {};
    this.children = [];
    this.parent = null;
    this.value = "";
    this.textContent = "";
    this.hidden = false;
    this.disabled = false;
    this._innerHTML = "";
    this._handlers = {};
    this.type = "text";
    this.checked = false;
  }
  get className() { return [...this.classList.s].join(" "); }
  set className(v) {
    this.classList.s.clear();
    String(v).split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c));
  }
  set innerHTML(v) {
    this._innerHTML = String(v);
    this.children = [];
    const re = /<(input|button|select|textarea|label|div|p|code|span|h4|h3|option|table|thead|tbody|tr|th|td|ol|li|dl|dt|dd)\b([^>]*)>/gi;
    let m;
    while ((m = re.exec(this._innerHTML))) {
      const [, tag, attrs] = m;
      const child = new El(tag);
      const idm = /\bid="([^"]*)"/.exec(attrs);
      if (idm) { child.id = idm[1]; dynById.set(idm[1], child); }
      const clsm = /\bclass="([^"]*)"/.exec(attrs);
      if (clsm) child.className = clsm[1];
      const vm2 = /\bvalue="([^"]*)"/.exec(attrs);
      if (vm2) child.value = vm2[1];
      const typem = /\btype="([^"]*)"/.exec(attrs);
      if (typem) child.type = typem[1];
      if (/\bchecked\b/.test(attrs)) child.checked = true;
      let dm;
      const dre = /data-([\w-]+)="([^"]*)"/g;
      while ((dm = dre.exec(attrs))) child.dataset[dm[1]] = dm[2];
      child.parent = this;
      this.children.push(child);
    }
  }
  get innerHTML() { return this._innerHTML; }
  addEventListener(ev, fn) { (this._handlers[ev] ??= []).push(fn); }
  dispatchEvent(e) {
    e.target = e.target || this;
    (this._handlers[e.type] || []).forEach((f) => f.call(this, e));
    return true;
  }
  click() { this.dispatchEvent({ type: "click" }); }
  select() {}
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const out = [];
    const walk = (node) => {
      for (const c of node.children) {
        if (matches(c, sel)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
}
function matches(elm, sel) {
  sel = sel.trim();
  let m;
  if ((m = /^#([\w-]+)\s+(\w+)$/.exec(sel))) {
    return elm._scopeId === m[1] && elm.tagName === m[2].toUpperCase();
  }
  if ((m = /^\[data-([\w-]+)(?:="([^"]*)")?\]$/.exec(sel))) {
    const v = elm.dataset[m[1]];
    return v !== undefined && (m[2] === undefined || v === m[2]);
  }
  if ((m = /^(\w+)\[data-([\w-]+)="([^"]*)"\]$/.exec(sel))) {
    return elm.tagName === m[1].toUpperCase() && elm.dataset[m[2]] === m[3];
  }
  if (sel.startsWith("#")) return elm.id === sel.slice(1);
  if (sel.startsWith(".")) return elm.classList.contains(sel.slice(1));
  return elm.tagName === sel.toUpperCase();
}

const byId = new Map();
const dynById = new Map();
const all = [];
{
  const re = /<(\w+)([^>]*)\bid="([^"]+)"([^>]*)>/g;
  let m;
  while ((m = re.exec(html))) {
    const [, tag, before, id, after] = m;
    const elm = new El(tag, id);
    const attrs = before + " " + after;
    let dm;
    const dre = /data-([\w-]+)="([^"]*)"/g;
    while ((dm = dre.exec(attrs))) elm.dataset[dm[1]] = dm[2];
    if (/\bchecked\b/.test(attrs)) elm.checked = true;
    const valuem = /\bvalue="([^"]*)"/.exec(attrs);
    if (valuem) elm.value = valuem[1];
    byId.set(id, elm);
    all.push(elm);
  }
  // steps nav buttons live inside #steps; give them scope ids
  const stepsEl = byId.get("steps");
  const btnRe = /<button\b([^>]*)data-tab="([^"]+)"([^>]*)>/g;
  let bm;
  while ((bm = btnRe.exec(html))) {
    const b = new El("button");
    b.dataset.tab = bm[2];
    b._scopeId = "steps";
    const cls = /class="([^"]*)"/.exec(bm[1] + bm[3]);
    if (cls) b.className = cls[1];
    stepsEl.appendChild(b);
    all.push(b);
  }
}

const document = {
  getElementById: (id) => {
    const elm = byId.get(id) || dynById.get(id);
    if (!elm) throw new Error("missing element id=" + id);
    return elm;
  },
  querySelectorAll: (sel) => {
    sel = sel.trim();
    const m = /^#([\w-]+)\s+button$/.exec(sel);
    if (m) {
      const scope = byId.get(m[1]);
      return scope ? scope.children.filter((c) => c.tagName === "BUTTON") : [];
    }
    if (sel.startsWith("#")) {
      const elm = byId.get(sel.slice(1));
      return elm ? [elm] : [];
    }
    return [];
  },
  querySelector: (sel) => document.querySelectorAll(sel)[0] || null,
  createElement: (tag) => new El(tag),
  execCommand: () => true,
  body: new El("body"),
};
const store = new Map();
const localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

/* ---------- fixtures ---------- */
const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const PW_ADDR = "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d"; // paywall receiving address (pinned vector)
const DESC_PIN = "pearl-paywall:v1:prl:d20d4c7652d8091d047c7f25ad4f04d457e60aa3f0c0b21b98490b44fd12b02f";
const TOKEN_PUBKEY_PIN = "1e89c01f8a1968e908480b487c0673c07fef9c48268d403e3af0678a460a4f76";
const FUND_TXID = "22".repeat(32);
let stubTx = null; // set after the bundle loads (needs P for the funder address)

async function stubFetch(url) {
  const u = String(url);
  const ok = (json) => ({ ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) });
  const txm = /\/api\/v2\/tx\/([0-9a-f]{64})/.exec(u);
  if (txm) {
    if (stubTx && txm[1] === stubTx.txid) return ok(JSON.parse(JSON.stringify(stubTx)));
    return { ok: false, status: 404, json: async () => ({}), text: async () => "not found" };
  }
  if (/\/api\/v2\/address\//.test(u)) {
    return ok({ address: PW_ADDR, balance: "0", totalReceived: "0", txs: stubTx ? [JSON.parse(JSON.stringify(stubTx))] : [] });
  }
  return { ok: false, status: 404, json: async () => ({}), text: async () => "not found" };
}

class FakeEvent { constructor(type) { this.type = type; } }
class FakeBlob { constructor(parts) { this.parts = parts; } }
const window = { document, scrollTo: () => {} };
const sandbox = {
  window, document, Event: FakeEvent,
  navigator: { clipboard: { writeText: async () => {} } },
  console, TextEncoder, TextDecoder,
  localStorage, fetch: stubFetch,
  Blob: FakeBlob,
  URL: { createObjectURL: () => "blob:fake", revokeObjectURL: () => {} },
  setTimeout: (fn) => 0, clearTimeout: () => {},
  setInterval: (fn) => 0, clearInterval: () => {},
  crypto: { getRandomValues: (arr) => randomFillSync(arr) },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(resolvePath(dir, "qrcode.min.js"), "utf8"), sandbox, { filename: "qrcode.min.js" });
// vendored QR lib is a top-level `var qrcode` (window.qrcode in a real browser)
sandbox.window.qrcode = sandbox.qrcode;
vm.runInContext(fs.readFileSync(resolvePath(dir, "pearl-paywall.bundle.js"), "utf8"), sandbox, { filename: "pearl-paywall.bundle.js" });
// NOTE: no globalName on this bundle (AGENTS.md 2026-09-30 lesson) —
// src/index.js assigns window.PearlPaywall explicitly.
vm.runInContext(fs.readFileSync(resolvePath(dir, "app.js"), "utf8"), sandbox, { filename: "app.js" });

const $ = (id) => document.getElementById(id);
const P = sandbox.window.PearlPaywall;

function makeStubTx() {
  const funder = P.walletFromMnemonic(MNEMONIC, P.NETWORKS.mainnet);
  return {
    txid: FUND_TXID,
    confirmations: 3,
    vin: [{ addresses: [funder.address] }],
    vout: [{ n: 0, value: "250000000", addresses: [PW_ADDR], scriptPubKey: { addresses: [PW_ADDR] } }],
  };
}
stubTx = makeStubTx();

const tick = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const goTab = (name) => document.querySelectorAll("#steps button").find((b) => b.dataset.tab === name).click();

/* ---------- tests ---------- */

test("page boots: bundle + app wiring load without throwing", () => {
  assert.ok(P, "window.PearlPaywall present");
  assert.ok(sandbox.window.qrcode, "window.qrcode present");
  assert.ok($("c-build"), "create controls present");
  assert.equal(document.querySelectorAll("#steps button").length, 5, "five step tabs");
  assert.ok(html.includes("prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d"), "donation address in footer");
  assert.ok(html.includes("@kshot9000"));
  assert.ok(html.includes("?v=1"), "cache-busted script URLs");
});

test("every el(id) target in app.js exists in index.html", () => {
  const src = fs.readFileSync(resolvePath(dir, "app.js"), "utf8");
  const ids = new Set([...src.matchAll(/\bel\("([^"]+)"\)/g)].map((m) => m[1]));
  const missing = [...ids].filter((id) => !byId.has(id));
  assert.deepEqual(missing, [], "missing ids: " + missing.join(","));
});

test("create: sealing renders the pinned descriptor, URI and QR", () => {
  goTab("create");
  $("c-hrp").value = "prl";
  $("c-title").value = "Backstage pass: studio session stems";
  $("c-price").value = "2.5";
  $("c-address").value = PW_ADDR;
  $("c-deliverable").value = "WAV stems + project file, delivered by email within 48h of payment.";
  $("c-expiry").value = "2027-12-31";
  $("c-build").click();
  assert.equal($("c-err").textContent, "", "no create error: " + $("c-err").textContent);
  assert.equal($("c-descriptor").textContent, DESC_PIN, "pinned descriptor");
  assert.equal($("c-commit-card").hidden, false);
  assert.equal($("tab-pay").hidden, false, "desk advances to pay after sealing");
  assert.equal($("tab-create").hidden, true);
  assert.ok($("p-uri").textContent.startsWith("pearl:" + PW_ADDR + "?amount=2.5"), "payment URI: " + $("p-uri").textContent);
  assert.ok($("p-qr").innerHTML.includes("<svg"), "QR rendered");
  assert.ok($("p-price-line").textContent.includes("2.5 PRL"), "price line grain-exact");
  const saved = JSON.parse(localStorage.getItem("pearl-paywall-v1"));
  assert.equal(saved.descriptor, DESC_PIN, "descriptor persisted (no keys persisted)");
  assert.ok(!JSON.stringify(saved).includes("abandon"), "mnemonic never persisted");
});

test("create: bad price / address refused loudly", () => {
  goTab("create");
  $("c-price").value = "abc";
  $("c-build").click();
  assert.ok($("c-err").textContent.length > 0, "bad price refused");
  $("c-price").value = "2.5";
  $("c-address").value = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
  $("c-build").click();
  assert.ok($("c-err").textContent.includes("invalid for prl"), "wrong-network address refused: " + $("c-err").textContent);
  $("c-address").value = PW_ADDR;
  $("c-build").click();
  assert.equal($("c-err").textContent, "", "re-seal works");
});

test("pay: exact payment shows PAID; variants show honestly", async () => {
  goTab("pay");
  $("p-txid").value = FUND_TXID;
  $("p-check").click();
  await tick();
  assert.equal($("p-err").textContent, "");
  assert.ok($("p-out").innerHTML.includes("PAID ✓"), "exact payment PAID: " + $("p-out").innerHTML.slice(0, 120));
  // unconfirmed variant
  stubTx.confirmations = 0;
  $("p-check").click();
  await tick();
  assert.ok($("p-out").innerHTML.includes("UNCONFIRMED"), "0-conf flagged provisional");
  stubTx.confirmations = 3;
  // shortfall variant
  stubTx.vout[0].value = "100000000";
  $("p-check").click();
  await tick();
  assert.ok($("p-out").innerHTML.includes("UNDERPAID"), "shortfall honest");
  assert.ok($("p-out").innerHTML.includes("1.5 PRL"), "shortfall amount shown");
  stubTx.vout[0].value = "250000000";
  // unknown txid
  $("p-txid").value = "99".repeat(32);
  $("p-check").click();
  await tick();
  assert.ok($("p-out").innerHTML.includes("LOOKUP FAILED"), "missing txid fails loudly");
  $("p-txid").value = FUND_TXID;
});

test("pay: recent-payments list with use buttons; auto-refresh ticks", async () => {
  $("p-addr-refresh").click();
  await tick();
  assert.ok($("p-recent-note").textContent.includes("1 recent"), "recent list loaded: " + $("p-recent-note").textContent);
  const useBtns = $("p-recent").querySelectorAll("[data-txid]");
  assert.equal(useBtns.length, 1, "one use button");
  assert.equal(useBtns[0].dataset.txid, FUND_TXID);
  $("p-txid").value = "";
  useBtns[0].click();
  await tick();
  assert.equal($("p-txid").value, FUND_TXID, "use button fills txid");
  assert.ok($("p-out").innerHTML.includes("PAID ✓"), "check ran after use");
  // auto-refresh: checkbox triggers an immediate check (interval stubbed no-op)
  $("p-auto").checked = true;
  $("p-auto").dispatchEvent(new FakeEvent("change"));
  await tick();
  assert.ok($("p-out").innerHTML.includes("PAID"), "auto-refresh check ran");
  $("p-auto").checked = false;
  $("p-auto").dispatchEvent(new FakeEvent("change"));
});

test("token: mint from funding key, wrong key refused, key wiped", async () => {
  goTab("token");
  $("t-load-pay").click();
  assert.equal($("t-descriptor").value, DESC_PIN, "descriptor carried from pay tab");
  assert.equal($("t-txid").value, FUND_TXID, "txid carried from pay tab");
  $("t-key").value = MNEMONIC;
  $("t-mint").click();
  await tick(5);
  assert.equal($("t-err").textContent, "", "no mint error: " + $("t-err").textContent);
  assert.equal($("t-token-card").hidden, false);
  assert.ok($("t-token").textContent.includes(TOKEN_PUBKEY_PIN), "token carries pinned pubkey");
  assert.equal($("t-key").value, "", "key wiped after mint");
  // wrong key refused loudly
  $("t-key").value = "legal winner thank year wave sausage worth useful legal winner thank yellow";
  $("t-mint").click();
  await tick(5);
  assert.ok($("t-err").textContent.includes("KEY REFUSED"), "wrong key refused: " + $("t-err").textContent);
  assert.equal($("t-key").value, "", "key wiped after refusal");
});

test("verify: honest token PROVEN, tampered token NOT PROVEN", async () => {
  goTab("verify");
  $("v-desc").value = DESC_PIN;
  $("v-canonical").value = $("c-canonical").textContent;
  $("v-token").value = $("t-token").textContent;
  $("v-run").click();
  await tick(5);
  assert.ok($("v-out").innerHTML.includes("PROVEN"), "honest token proven: " + $("v-out").innerHTML.slice(0, 160));
  assert.ok(!$("v-out").innerHTML.includes("NOT PROVEN"));
  const evil = JSON.parse($("t-token").textContent);
  evil.sig = evil.sig.slice(0, -1) + (evil.sig.endsWith("0") ? "1" : "0");
  $("v-token").value = JSON.stringify(evil);
  $("v-run").click();
  await tick(5);
  assert.ok($("v-out").innerHTML.includes("NOT PROVEN"), "tampered token rejected");
});

test("snippet: generated + crypto self-test passes in-page", () => {
  goTab("snippet");
  $("s-generate").click();
  assert.equal($("s-err").textContent, "", "no snippet error: " + $("s-err").textContent);
  assert.equal($("s-snippet-card").hidden, false);
  const snip = $("s-snippet").textContent;
  assert.ok(snip.includes("PearlPaywallGate"), "snippet defines the gate");
  assert.ok(snip.includes(DESC_PIN), "snippet binds the paywall descriptor");
  assert.ok(snip.includes("250000000"), "snippet binds the grain-exact price");
  $("s-test-snippet").click();
  assert.ok($("s-test-out").textContent.includes("PASS"), "snippet self-test: " + $("s-test-out").textContent);
});

test("footer: copy-donate wired, honest limits present", () => {
  assert.ok(html.includes("Honest limits"), "honest limits panel");
  assert.ok(html.includes("not DRM"), "DRM disclaimer");
  $("copy-donate").click(); // must not throw
});
