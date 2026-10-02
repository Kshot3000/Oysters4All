// Pearl ID DOM integration test — boots the real index.html + committed
// bundle (pearl-id.bundle.js) + app.js against a minimal DOM shim and
// drives the full flow: keys (generate/import/wipe) -> sign in (review,
// confirm, credential) -> verify (good/tampered/malformed) ->
// integrate (snippets present) -> footer-attribution checks.
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

/* ---------- minimal DOM ---------- */
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
    this._handlers = {}; this._kids = [];
  }
  set innerHTML(v) { this._html = String(v); this._kids = []; }
  get innerHTML() { return this._html + this._kids.map((k) => k.innerHTML).join(""); }
  appendChild(c) { this._kids.push(c); return c; }
  remove() { /* noop */ }
  addEventListener(t, fn) { (this._handlers[t] ??= []).push(fn); }
  click() { (this._handlers.click || []).forEach((f) => f({ target: this, preventDefault() {} })); }
  fire(t, extra = {}) { (this._handlers[t] || []).forEach((f) => f({ target: this, preventDefault() {}, ...extra })); }
  querySelectorAll() { return []; }
  querySelector() { return null; }
  closest() { return null; }
  getContext() { return null; } // canvas unavailable in the shim
  scrollIntoView() { /* noop */ }
}
const byId = new Map();
const hiddenIds = new Set([...html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*\bhidden\b[^>]*>/g)].map((m) => m[1]));
const getEl = (id) => {
  if (!byId.has(id)) {
    const el = new El("div", id);
    if (hiddenIds.has(id)) el.hidden = true;
    byId.set(id, el);
  }
  return byId.get(id);
};
// selects default to their first option's value (like a real browser)
for (const m of html.matchAll(/<select id="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
  const first = /<option value="([^"]+)"/.exec(m[2]);
  if (first) getEl(m[1]).value = first[1];
}
const tabButtons = [...html.matchAll(/<button data-tab="([^"]+)"[^>]*>/g)].map((m) => {
  const b = new El("button"); b.dataset.tab = m[1];
  if (/\bclass="active"/.test(m[0])) b.classList.add("active");
  return b;
});
const tabSections = [...html.matchAll(/<section class="tab([^"]*)" id="([^"]+)">/g)].map((m) => {
  const s = new El("section", m[2]);
  if (m[1].includes("active")) s.classList.add("active");
  return s;
});
const docHandlers = {};
const documentShim = {
  getElementById: (id) => getEl(id),
  querySelectorAll: (sel) => (sel === "#tabs button" ? tabButtons : sel === ".tab" ? tabSections : []),
  querySelector: () => null,
  createElement: (t) => new El(t),
  body: new El("body"),
  addEventListener: (t, fn) => { (docHandlers[t] ??= []).push(fn); },
};
const lsData = {};
const sandbox = {
  document: documentShim,
  navigator: { clipboard: { writeText: async () => {} } },
  localStorage: {
    getItem: (k) => (k in lsData ? lsData[k] : null),
    setItem: (k, v) => { lsData[k] = String(v); },
    removeItem: (k) => { delete lsData[k]; },
  },
  TextDecoder, crypto: webcrypto,
  location: { reload() {} },
  setTimeout, clearTimeout,
  confirm() { return true; },
  console,
  URL: { createObjectURL: () => "blob:fake", revokeObjectURL() {} },
  Blob: class { constructor(parts) { this.parts = parts; } },
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
for (const f of ["pearl-id.bundle.js", "app.js"]) {
  vm.runInContext(fs.readFileSync(resolvePath(dir, f), "utf8"), sandbox, { filename: f, timeout: 15000 });
}
const E = sandbox.PearlID;
assert.ok(E && E.signCredential, "bundle exposes window.PearlID");

/* ---------- helpers ---------- */
const setVal = (id, v) => { getEl(id).value = v; };
const click = (id) => getEl(id).click();

test("tabs switch", () => {
  const signinBtn = tabButtons.find((b) => b.dataset.tab === "signin");
  signinBtn.click();
  assert.ok(tabSections.find((s) => s.id === "tab-signin").classList.contains("active"));
  assert.ok(!tabSections.find((s) => s.id === "tab-keys").classList.contains("active"));
  tabButtons.find((b) => b.dataset.tab === "keys").click();
  assert.ok(tabSections.find((s) => s.id === "tab-keys").classList.contains("active"));
});

test("keys: generate -> address + xonly shown, wipe clears", () => {
  click("pid-gen12");
  assert.equal(getEl("pid-identity-err").hidden, true, "no identity error");
  assert.equal(getEl("pid-key-out").hidden, false, "identity shown");
  assert.match(getEl("pid-xonly").textContent, /^[0-9a-f]{64}$/, "x-only pubkey");
  assert.ok(getEl("pid-address").textContent.startsWith("prl1p"), "prl1p address");
  assert.equal(getEl("pid-wipe").hidden, false, "wipe offered");
  click("pid-wipe");
  assert.equal(getEl("pid-key-out").hidden, true, "identity hidden after wipe");
  assert.equal(getEl("pid-wipe").hidden, true, "wipe hidden after wipe");
});

test("keys: bad import shows error, good import loads", () => {
  setVal("pid-import-input", "definitely not a key");
  click("pid-import");
  assert.equal(getEl("pid-identity-err").hidden, false, "error shown");
  assert.equal(getEl("pid-key-out").hidden, true, "no identity on bad import");
  setVal("pid-import-input", "ab".repeat(32));
  click("pid-import");
  assert.equal(getEl("pid-identity-err").hidden, true, "no error on hex import");
  assert.ok(getEl("pid-address").textContent.startsWith("prl1p"), "address loaded");
});

test("sign in: requires key; review -> confirm -> credential", () => {
  // wipe first: signing without a key must refuse
  click("pid-wipe");
  setVal("pid-domain", "shop.example.com");
  setVal("pid-challenge", "cd".repeat(32));
  click("pid-sign");
  assert.equal(getEl("pid-sign-err").hidden, false, "refuses without key");
  // load key and sign
  setVal("pid-import-input", "ab".repeat(32));
  click("pid-import");
  click("pid-sign");
  assert.equal(getEl("pid-sign-err").hidden, true, "no error with key");
  assert.equal(getEl("pid-confirm").hidden, false, "confirm screen shown");
  assert.equal(getEl("pid-confirm-domain").textContent, "shop.example.com", "domain shown big");
  click("pid-confirm-sign");
  assert.equal(getEl("pid-cred-out").hidden, false, "credential shown");
  assert.match(getEl("pid-cred-fingerprint").textContent, /^[0-9a-f]{16}$/, "64-bit fingerprint");
  const env = JSON.parse(getEl("pid-cred-json").textContent);
  assert.equal(env.protocol, "prl-id");
  assert.equal(env.domain, "shop.example.com");
  // the credential the page produced must verify
  const v = E.verifyCredential(env, { expectedDomain: "shop.example.com" });
  assert.equal(v.verdict, "VALID");
});

test("sign in: bad challenge rejected at review", () => {
  setVal("pid-domain", "shop.example.com");
  setVal("pid-challenge", "too-short");
  click("pid-sign");
  assert.equal(getEl("pid-sign-err").hidden, false, "challenge error shown");
  assert.equal(getEl("pid-confirm").hidden, true, "no confirm on bad input");
});

test("verify: good / tampered / malformed", () => {
  const env = JSON.parse(getEl("pid-cred-json").textContent);
  setVal("pid-verify-input", JSON.stringify(env));
  setVal("pid-verify-domain", "shop.example.com");
  click("pid-verify-btn");
  assert.equal(getEl("pid-verify-result").hidden, false, "result shown");
  assert.equal(getEl("pid-verdict").textContent, "VALID", "verdict VALID");

  const tampered = { ...env, domain: "evil.example" };
  setVal("pid-verify-input", JSON.stringify(tampered));
  click("pid-verify-btn");
  assert.equal(getEl("pid-verdict").textContent, "INVALID", "tampered -> INVALID");

  setVal("pid-verify-input", "{not json");
  click("pid-verify-btn");
  assert.equal(getEl("pid-verdict").textContent, "INVALID", "malformed -> INVALID");
});

test("integrate: snippets present and copyable", () => {
  const v = getEl("pid-snippet-verify").textContent;
  assert.ok(v.includes("PearlID.verifyCredential"), "verifier snippet references the bundle");
  assert.ok(v.includes("expectedDomain"), "verifier snippet binds domain");
  const iss = getEl("pid-snippet-issuer").textContent;
  assert.ok(iss.includes("randomBytes(32)"), "issuer snippet mints 256-bit challenges");
  assert.ok(iss.includes("DELETE"), "issuer snippet says to burn challenges");
});

test("honest limits + footer attribution present", () => {
  assert.ok(html.includes("replays until it expires"), "replay warning in honest limits");
  assert.ok(html.includes("control of a key"), "key-control honesty in limits");
  assert.ok(html.includes("Read the domain line before you sign"), "phishing warning");
  assert.ok(html.includes("@kshot9000"), "X attribution");
  assert.ok(html.includes("prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d"), "exact PRL address in footer");
  assert.ok(html.includes("pearl-id.bundle.js?v=1"), "bundle cache key");
  assert.ok(html.includes("app.js?v=2"), "app cache key");
  assert.ok(html.includes("styles.css?v=5"), "stylesheet cache key");
});
