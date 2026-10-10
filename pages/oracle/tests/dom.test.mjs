// Pearl Oracle DOM integration test — boots the real index.html + committed
// bundle (pearl-oracle.bundle.js) + app.js against a minimal DOM shim and
// drives the full flow: identity (generate/import/wipe) -> publish ->
// feed (chain check, import, clear) -> verify (good/tampered/malformed) ->
// footer-attribution checks.
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
for (const f of ["pearl-oracle.bundle.js", "app.js"]) {
  vm.runInContext(fs.readFileSync(resolvePath(dir, f), "utf8"), sandbox, { filename: f, timeout: 15000 });
}
const E = sandbox.PearlOracle;
assert.ok(E && E.signAttestation, "bundle exposes window.PearlOracle");

/* ---------- helpers ---------- */
const setVal = (id, v) => { getEl(id).value = v; };
const click = (id) => getEl(id).click();
const PRL_ADDR = "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d";

test("identity: generate -> pubkey + address shown, wipe clears", () => {
  click("or-gen12");
  assert.equal(getEl("or-identity-err").hidden, true, "no identity error");
  assert.equal(getEl("or-key-out").hidden, false, "identity shown");
  assert.match(getEl("or-xonly").textContent, /^[0-9a-f]{64}$/, "x-only pubkey");
  assert.ok(getEl("or-address").textContent.startsWith("prl1p"), "prl1p address");
  assert.equal(getEl("or-wipe").hidden, false, "wipe offered");
  click("or-wipe");
  assert.equal(getEl("or-key-out").hidden, true, "identity hidden after wipe");
});

test("identity: import WIF auto-detected", () => {
  const w = E.walletFromPriv("33".repeat(32), E.NETWORKS.mainnet);
  const wif = E.walletToWIF(w.priv, E.NETWORKS.mainnet);
  setVal("or-import-input", wif);
  click("or-import");
  assert.equal(getEl("or-key-out").hidden, false);
  assert.match(getEl("or-key-source").textContent, /WIF/);
  assert.equal(getEl("or-address").textContent, w.address);
});

test("identity: garbage key refused loudly", () => {
  setVal("or-import-input", "not a key at all");
  click("or-import");
  assert.equal(getEl("or-identity-err").hidden, false, "error shown");
  assert.equal(getEl("or-key-out").hidden, true, "no identity shown");
});

test("publish: full tick flow signs and lands in the feed", () => {
  click("or-gen12"); // fresh oracle key
  setVal("or-price", "41250");
  setVal("or-decimals", "2");
  setVal("or-source", "CoinGecko spot");
  click("or-publish");
  assert.equal(getEl("or-pub-err").hidden, true, "no publish error: " + getEl("or-pub-err").textContent);
  assert.equal(getEl("or-pub-out").hidden, false, "signed output shown");
  const signed = JSON.parse(getEl("or-signed-json").value);
  assert.equal(signed.p, "prl-oracle");
  assert.equal(signed.price, "41250");
  const v = E.verifyAttestation(signed);
  assert.equal(v.verdict, "VALID", "published attestation verifies");
  // feed table picked it up
  assert.ok(getEl("or-feed-body").innerHTML.includes("VALID"), "feed row shows VALID badge");
  assert.ok(getEl("or-feed-body").innerHTML.includes("412.50"), "price rendered as 412.50");
  // chain defaults advanced: next seq = 1, prev = this id
  assert.equal(getEl("or-seq").value, "1", "seq advanced");
  assert.equal(getEl("or-prev").value, v.id, "prev = published id");
  sandbox.__signed1 = signed;
  sandbox.__id1 = v.id;
});

test("publish: second tick chains prev + seq", () => {
  setVal("or-price", "41300");
  setVal("or-source", "CoinGecko spot");
  click("or-publish");
  assert.equal(getEl("or-pub-err").hidden, true, "no publish error");
  const signed = JSON.parse(getEl("or-signed-json").value);
  assert.equal(signed.seq, "1");
  assert.equal(signed.prev, sandbox.__id1, "prev links to first attestation");
  const r = E.verifyFeedChain([sandbox.__signed1, signed]);
  assert.equal(r.ok, true, "two-row chain intact");
});

test("feed: whole-chain tamper check passes", () => {
  click("or-chain-check");
  assert.ok(getEl("or-chain-summary").textContent.includes("chain intact"), "summary ok: " + getEl("or-chain-summary").textContent);
  assert.equal(getEl("or-chain-summary").className, "chain-summary ok");
  assert.equal(getEl("or-feed-ok").hidden, false);
});

test("feed: import refuses a tampered feed", () => {
  const tampered = JSON.parse(JSON.stringify(sandbox.__signed1));
  tampered.price = "99999";
  setVal("or-feed-import", JSON.stringify([sandbox.__signed1, tampered]));
  click("or-feed-import-btn");
  assert.equal(getEl("or-feed-err").hidden, false, "import error shown");
  assert.match(getEl("or-feed-err").textContent, /row 1 INVALID/);
});

test("feed: import good feed then restore local", () => {
  setVal("or-feed-import", JSON.stringify(sandbox.__signed1));
  click("or-feed-import-btn");
  assert.equal(getEl("or-feed-err").hidden, true, "import accepted: " + getEl("or-feed-err").textContent);
  assert.equal(getEl("or-feed-ok").hidden, false);
  click("or-feed-restore");
  assert.equal(getEl("or-feed-ok").hidden, false, "local feed restored");
});

test("verify: good attestation VALID with all checks passing", () => {
  setVal("or-verify-input", JSON.stringify(sandbox.__signed1));
  click("or-verify-btn");
  assert.equal(getEl("or-verify-result").hidden, false);
  assert.equal(getEl("or-verdict").textContent, "VALID");
  assert.equal(getEl("or-verify-id").textContent, sandbox.__id1);
  assert.ok(getEl("or-verify-checks").innerHTML.includes("BIP-340 signature verifies under pub"), "sig check row");
});

test("verify: tampered price INVALID", () => {
  const t = JSON.parse(JSON.stringify(sandbox.__signed1));
  t.price = "41251";
  setVal("or-verify-input", JSON.stringify(t));
  click("or-verify-btn");
  assert.equal(getEl("or-verdict").textContent, "INVALID");
  assert.ok(getEl("or-verify-checks").innerHTML.includes("fail"), "a check failed");
});

test("verify: malformed + unknown field INVALID", () => {
  setVal("or-verify-input", "{not json");
  click("or-verify-btn");
  assert.equal(getEl("or-verdict").textContent, "INVALID");
  const u = JSON.parse(JSON.stringify(sandbox.__signed1));
  u.fork = 1;
  setVal("or-verify-input", JSON.stringify(u));
  click("or-verify-btn");
  assert.equal(getEl("or-verdict").textContent, "INVALID");
  assert.ok(getEl("or-verify-checks").innerHTML.includes("unknown"), "unknown-field row");
});

test("verify: future ts draws loud warning, stays VALID", () => {
  const f = JSON.parse(JSON.stringify(sandbox.__signed1));
  // re-sign with a far-future ts would need the key; instead craft via core
  const w = E.walletFromPriv("44".repeat(32), E.NETWORKS.mainnet);
  const future = String(Math.floor(Date.now() / 1000) + 100000);
  const s = E.signAttestation({
    fields: { asset: "PRL/USD", price: "1", decimals: "0", ts: future, seq: "0", nonce: "ab".repeat(16), prev: "0".repeat(64), source: "test" },
    priv: w.priv, internalXOnly: w.internalXOnly,
  });
  setVal("or-verify-input", JSON.stringify(s));
  click("or-verify-btn");
  assert.equal(getEl("or-verdict").textContent, "VALID ⚠");
  assert.ok(getEl("or-verify-checks").innerHTML.includes("timestamp sanity"), "ts sanity row");
});

test("feed: clear-all deletes rows", () => {
  click("or-feed-restore");
  click("or-clear-feed"); // confirm() stubbed true
  assert.equal(getEl("or-feed-body").innerHTML, "", "table cleared");
  assert.equal(getEl("or-feed-empty").hidden, false, "empty note shown");
});

test("tabs switch + footer attribution", () => {
  tabButtons.find((b) => b.dataset.tab === "verify").click();
  assert.ok(tabSections.find((s) => s.id === "tab-verify").classList.contains("active"), "verify tab active");
  assert.ok(!tabSections.find((s) => s.id === "tab-feed").classList.contains("active"), "feed tab inactive");
  assert.ok(html.includes("@kshot9000"), "footer carries @kshot9000");
  assert.ok(html.includes(PRL_ADDR), "footer carries the PRL address character-for-character");
  assert.ok(html.includes("signal-beacon") || html.includes("pearl-oracle.bundle.js?v=2"), "wired bundle");
});

test("honest limits panel always present", () => {
  assert.ok(html.includes("Honest limits"), "panel heading");
  assert.ok(html.includes("authorship"), "authorship-not-truth copy");
  assert.ok(html.includes("never moves PRL"), "never-moves-PRL copy");
});
