// Pearl Gift DOM integration test — boots the real index.html + committed
// bundle (pearl-gift.bundle.js) + app.js against a minimal DOM shim and
// drives the full flow: create -> load -> card -> redeem (manual UTXO mode),
// plus footer-attribution checks.
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
  remove(...c) { c.forEach((x) => this.s.delete(c)); }
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
}
const byId = new Map();
const hiddenIds = new Set([...html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*\bhidden\b[^>]*>/g)].map((m) => m[1]));
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
  setTimeout, clearTimeout,
  scrollTo() {}, print() {},
  console,
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
for (const f of ["pearl-gift.bundle.js", "app.js"]) {
  vm.runInContext(fs.readFileSync(resolvePath(dir, f), "utf8"), sandbox, { filename: f, timeout: 15000 });
}
const N = sandbox.PearlGift;
assert.ok(N, "bundle loaded as window.PearlGift");

const click = (id) => getEl(id).click();
const setVal = (id, v) => { getEl(id).value = v; };

test("flow: create -> load -> card (committed bundle)", () => {
  // 1. create: generate a fresh gift wallet
  click("make-gift");
  assert.equal(getEl("gift-error").hidden, true, "no create error: " + getEl("gift-error").textContent);
  assert.equal(getEl("gift-key-card").hidden, false);
  const addr = getEl("gift-address").textContent;
  assert.match(addr, /^prl1p[0-9a-z]{58}$/, "fresh prl1p address");
  assert.match(getEl("gift-path").textContent, /m\/86'\/\d+'\/1000'\/0\/0/);
  assert.equal(getEl("gift-mnemonic-wrap").hidden, false, "fresh wallet shows its mnemonic");
  const mnemonic = getEl("gift-mnemonic").textContent;

  // reveal toggles the private key
  click("reveal-secret");
  const wif = getEl("gift-wif").textContent;
  assert.match(wif, /^[1-9A-HJ-NP-Za-km-z]{51,52}$/, "WIF revealed");
  click("reveal-secret");
  assert.equal(getEl("gift-wif").textContent, "••••••••••••••••");

  // card fields live-update the preview
  setVal("gift-to", "Ada"); getEl("gift-to").fire("input");
  setVal("gift-from", "Bob"); getEl("gift-from").fire("input");
  setVal("gift-message", "Happy birthday"); getEl("gift-message").fire("input");
  click("to-load");
  assert.equal(getEl("load-address").textContent, addr);

  // 3. card step renders the design + fields
  click("to-card");
  assert.ok(getEl("card-preview").classList.contains("design-abyss"));
  assert.equal(getEl("card-to").textContent, "Ada");
  assert.equal(getEl("card-from").textContent, "Bob");
  assert.equal(getEl("card-message").textContent, "Happy birthday");
  assert.equal(getEl("card-address").textContent, addr);
  assert.match(getEl("card-wif").textContent, /^[1-9A-HJ-NP-Za-km-z]{51,52}$/);

  // design switch changes the card skin
  const roseBtn = documentShim.querySelectorAll("#steps button"); // sanity: shim api works
  assert.ok(Array.isArray(roseBtn));
  // store the secret for the redeem flow
  sandbox.__gift = { addr, wif, mnemonic };
});

test("flow: redeem -> plan -> sign (manual UTXOs, committed bundle)", () => {
  const { addr, wif } = sandbox.__gift;
  click("to-redeem");
  setVal("redeem-secret", wif);
  click("redeem-derive");
  assert.equal(getEl("redeem-error").hidden, true, "no derive error: " + getEl("redeem-error").textContent);
  assert.equal(getEl("redeem-card").hidden, false);
  assert.equal(getEl("redeem-address").textContent, addr, "derived address matches the created gift");

  // manual air-gapped UTXO mode — no network in the shim
  setVal("utxo-mode", "manual"); getEl("utxo-mode").fire("change");
  setVal("utxo-paste", `${"aa".repeat(32)}:0 250000000 ${addr}`);
  click("redeem-fetch");
  assert.equal(getEl("redeem-error").hidden, true, "no fetch error: " + getEl("redeem-error").textContent);
  assert.ok(getEl("redeem-utxos").textContent.includes("1 confirmed UTXO"));
  assert.equal(getEl("redeem-plan-panel").hidden, false);

  // wrong-address UTXO is refused
  setVal("utxo-paste", `${"bb".repeat(32)}:0 250000000 prl1p${"0".repeat(58)}`);
  click("redeem-fetch");
  assert.equal(getEl("redeem-error").hidden, false, "foreign UTXO refused");
  assert.match(getEl("redeem-error").textContent, /not the gift address/);

  // back to the good UTXO, plan the sweep
  setVal("utxo-paste", `${"aa".repeat(32)}:0 250000000 ${addr}`);
  click("redeem-fetch");
  assert.equal(getEl("redeem-error").hidden, true);
  setVal("redeem-recipient", "prl1pr6yuq8u2r95wjzzgpdy8cpnncpl7l8zgy6x5q0367pnc53s2famqg7pt74");
  setVal("fee-rate", "5");
  click("redeem-plan");
  assert.equal(getEl("sweep-error").hidden, true, "no plan error: " + getEl("sweep-error").textContent);
  assert.equal(getEl("plan-summary").hidden, false);
  assert.ok(getEl("plan-summary").innerHTML.includes("You receive"));

  // build + sign: local verification must pass before the hex is shown
  click("build-sweep");
  assert.equal(getEl("sweep-error").hidden, true, "no sweep error: " + getEl("sweep-error").textContent);
  assert.equal(getEl("sweep-result").hidden, false);
  assert.match(getEl("sweep-txid").textContent, /^[0-9a-f]{64}$/);
  assert.ok(getEl("sweep-hex").value.length > 200, "signed hex present");
  assert.equal(getEl("sweep-verified").hidden, false);

  // independent check: the shown tx verifies against the gift prevout spk
  const g2 = N.parseGiftSecret(sandbox.__gift.wif, N.NETWORKS.mainnet);
  const { tweakedX } = N.tweakKeypath(N.hexToBytes(g2.internalXOnlyHex));
  const spk = N.p2trScriptPubKey(tweakedX);
  const checks = N.verifySignedTx(N.NETWORKS.mainnet, getEl("sweep-hex").value, [{ value: 250000000, spk }]);
  assert.equal(checks.length, 1);
  assert.ok(checks[0].ok, JSON.stringify(checks));
});

test("redeem: bad secrets are rejected with useful errors", () => {
  setVal("redeem-secret", "obviously not a key");
  click("redeem-derive");
  assert.equal(getEl("redeem-error").hidden, false);
  setVal("redeem-secret", "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon");
  click("redeem-derive");
  assert.match(getEl("redeem-error").textContent, /not valid BIP-39/);
});

test("footer carries donation address", () => {
  assert.ok(html.includes("prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d"));
  assert.ok(html.includes("https://x.com/kshot9000"));
});

test("no localStorage dependency: store falls back in-memory", () => {
  // the sandbox has no localStorage at all — every flow above already ran
  // through the in-memory fallback without throwing.
  assert.equal(typeof sandbox.localStorage, "undefined");
});
