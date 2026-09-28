// Pearl Notary DOM integration test — boots the real index.html + committed
// bundle (pearl-notary.bundle.js) + app.js against a minimal DOM shim and
// drives the full wizard: document -> key -> commit -> reveal -> seal,
// plus the hostile-bytes tokenizer case through the shipped bundle.
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
    this.hidden = false; this.disabled = false;
    this._handlers = {}; this._kids = [];
  }
  set innerHTML(v) { this._html = String(v); }
  get innerHTML() { return this._html; }
  addEventListener(t, fn) { (this._handlers[t] ??= []).push(fn); }
  click() { (this._handlers.click || []).forEach((f) => f({ target: this, preventDefault() {} })); }
  fire(t, extra = {}) { (this._handlers[t] || []).forEach((f) => f({ target: this, preventDefault() {}, ...extra })); }
  querySelector(sel) {
    if (sel === ".dz-main") {
      let k = this._kids.find((x) => x.classList.contains("dz-main"));
      if (!k) { k = new El("p"); k.classList.add("dz-main"); this._kids.push(k); }
      return k;
    }
    return null;
  }
}
const byId = new Map();
// ids carrying the `hidden` attribute in the real markup start hidden
const hiddenIds = new Set([...html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*\bhidden\b[^>]*>/g)].map((m) => m[1]));
// <select> default values come from the selected <option>
const selectDefaults = new Map();
for (const m of html.matchAll(/<select[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
  const sel = m[2].match(/<option[^>]*\bvalue="([^"]*)"[^>]*\bselected\b[^>]*>/) || m[2].match(/<option[^>]*\bvalue="([^"]*)"[^>]*>/);
  if (sel) selectDefaults.set(m[1], sel[1]);
}
const getEl = (id) => {
  if (!byId.has(id)) {
    const el = new El("div", id);
    if (hiddenIds.has(id)) el.hidden = true;
    if (selectDefaults.has(id)) el.value = selectDefaults.get(id);
    byId.set(id, el);
  }
  return byId.get(id);
};
// step buttons from the real markup
const stepButtons = [...html.matchAll(/<button data-step="([^"]+)"[^>]*>/g)].map((m) => {
  const b = new El("button"); b.dataset.step = m[1]; return b;
});
const documentShim = {
  getElementById: (id) => getEl(id),
  querySelectorAll: (sel) => (sel === "#steps button" ? stepButtons : []),
  querySelector: (sel) => {
    const m = sel.match(/#steps button\[data-step="([^"]+)"\]/);
    return m ? stepButtons.find((b) => b.dataset.step === m[1]) : null;
  },
  createElement: (t) => new El(t),
  body: new El("body"),
};
const sandbox = {
  document: documentShim,
  navigator: { clipboard: { writeText: async () => {} } },
  TextDecoder, crypto: webcrypto,
  location: { reload() {} },
  Blob: class Blob {}, URL: { createObjectURL: () => "", revokeObjectURL() {} },
  FileReader: class FileReader {},
  setTimeout, clearTimeout,
  scrollTo() {}, print() {},
  console,
};
sandbox.window = sandbox; // like a real browser, window IS the global
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
// Realm-consistent TextEncoder: node:util's encoder returns outer-realm
// Uint8Arrays, which fail the bundle's `instanceof Uint8Array` checks.
// Re-wrap into the vm realm (a real browser has a single realm).
{
  const OuterTE = TextEncoder;
  const VMUint8Array = vm.runInContext("Uint8Array", sandbox);
  sandbox.TextEncoder = class extends OuterTE {
    encode(s) { return new VMUint8Array(super.encode(s)); }
  };
}
for (const f of ["pearl-notary.bundle.js", "app.js"]) {
  vm.runInContext(fs.readFileSync(resolvePath(dir, f), "utf8"), sandbox, { filename: f, timeout: 15000 });
}
const N = sandbox.PearlNotary;
assert.ok(N, "bundle loaded as window.PearlNotary");

const click = (id) => getEl(id).click();
const setVal = (id, v) => { getEl(id).value = v; };

test("wizard: document -> key -> commit -> reveal -> seal (committed bundle)", () => {
  // 1. document: paste text, compose
  setVal("doc-text", "The quick brown fox jumps over the lazy dog");
  getEl("doc-text").fire("input");
  setVal("doc-title", "Test deed");
  setVal("doc-by", "Alice");
  click("seal-compose");
  assert.equal(getEl("doc-error").hidden, true, "no compose error: " + getEl("doc-error").textContent);
  assert.equal(getEl("doc-result").hidden, false);
  assert.match(getEl("doc-hash").textContent, /^[0-9a-f]{64}$/);
  assert.ok(getEl("doc-envelope").textContent.includes('"p":"prl-notary"'));
  assert.equal(getEl("to-key").disabled, false);

  // 2. key: generate
  click("to-key");
  click("make-key");
  assert.equal(getEl("key-error").hidden, true, "no key error");
  assert.match(getEl("key-address").textContent, /^prl1p/);
  assert.equal(getEl("to-commit").disabled, false);

  // 3. commit: plan renders, paste UTXO, build
  click("to-commit");
  assert.equal(getEl("commit-plan").hidden, false);
  assert.ok(getEl("commit-plan").innerHTML.includes("prl1p"), "commit address shown");
  setVal("utxo-paste", "44".repeat(32) + ":0:1000000");
  getEl("utxo-paste").fire("change");
  assert.equal(getEl("build-commit").disabled, false);
  click("build-commit");
  assert.equal(getEl("commit-error").hidden, true, "no commit error: " + getEl("commit-error").textContent);
  assert.match(getEl("commit-txid").textContent, /^[0-9a-f]{64}$/);
  assert.ok(getEl("commit-hex").value.length > 100);
  assert.equal(getEl("to-reveal").disabled, false);

  // 4. reveal: build, indexer-style verify
  click("to-reveal");
  setVal("reveal-commit-txid", getEl("commit-txid").textContent);
  setVal("reveal-commit-vout", "0");
  click("build-reveal");
  assert.equal(getEl("reveal-error").hidden, true, "no reveal error: " + getEl("reveal-error").textContent);
  assert.match(getEl("reveal-txid").textContent, /^[0-9a-f]{64}$/);
  click("verify-reveal");
  assert.equal(getEl("reveal-verify").hidden, false);
  assert.ok(getEl("reveal-verify").innerHTML.includes("matches the sealed fingerprint"));
  assert.equal(getEl("to-seal").disabled, false);

  // 5. seal: certificate renders the audit trail
  click("to-seal");
  const seal = getEl("seal-body").innerHTML;
  assert.ok(seal.includes(getEl("doc-hash").textContent), "seal carries the fingerprint");
  assert.ok(seal.includes(getEl("reveal-txid").textContent), "seal carries the reveal txid");
  assert.ok(seal.includes("Test deed"), "seal carries the title");
});

test("shipped bundle: hostile witness bytes terminate (OOM regression)", () => {
  const hostile = new Uint8Array([0xa1, 0x74, 0xe4, 0x90, 0x92, 0xdd, 0xc5, 0x4e, 0x89, 0xe9, 0x0a, 0xfa, 0x3f, 0xdb, 0xcb, 0xc1]);
  assert.deepEqual([...N.extractEnvelopes(hostile)], []); // spread: vm-realm array !== outer Array
});

test("footer carries donation address", () => {
  assert.ok(html.includes("prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d"));
  assert.ok(html.includes("https://x.com/kshot9000"));
});
