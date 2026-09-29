// Pearl Rain DOM integration test — boots the real index.html + committed
// bundle (pearl-rain.bundle.js) + app.js against a minimal DOM shim and
// drives the full flow: funder -> recipients -> plan -> sign (manual UTXO
// mode), plus footer-attribution checks.
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
  scrollTo() {},
  confirm() { return true; },
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
for (const f of ["pearl-rain.bundle.js", "app.js"]) {
  vm.runInContext(fs.readFileSync(resolvePath(dir, f), "utf8"), sandbox, { filename: f, timeout: 15000 });
}
const N = sandbox.PearlRain;
assert.ok(N, "bundle loaded as window.PearlRain");

const click = (id) => getEl(id).click();
const setVal = (id, v) => { getEl(id).value = v; };
const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const FUNDER = "prl1pr6yuq8u2r95wjzzgpdy8cpnncpl7l8zgy6x5q0367pnc53s2famqg7pt74";
const R1 = "prl1p7dwp74zgd4te3mqr58d6x3p3t70jljmpe4auey8g824ra4x43tks3y4pr6";
const R2 = "prl1p5gfau0gepxzjkjyx9t88ewnhujrmpjqgqfh8v9vympjaz94x36jqpepvyt";

test("flow: funder -> utxos (manual air-gapped mode, committed bundle)", () => {
  setVal("fund-secret", MNEMONIC);
  click("fund-derive");
  assert.equal(getEl("fund-error").hidden, true, "no derive error: " + getEl("fund-error").textContent);
  assert.equal(getEl("fund-card").hidden, false);
  assert.equal(getEl("fund-address").textContent, FUNDER);
  assert.match(getEl("fund-path").textContent, /m\/86'\/\d+'\/0'\/0\/0/);

  setVal("utxo-mode", "manual"); getEl("utxo-mode").fire("change");
  assert.equal(getEl("utxo-paste-wrap").hidden, false);
  setVal("utxo-paste", `${"aa".repeat(32)}:0 250000000 ${FUNDER}`);
  click("fund-fetch");
  assert.equal(getEl("fetch-error").hidden, true, "no fetch error: " + getEl("fetch-error").textContent);
  assert.ok(getEl("fund-utxos").textContent.includes("1 UTXO"), getEl("fund-utxos").textContent);

  // foreign UTXO is refused
  setVal("utxo-paste", `${"bb".repeat(32)}:0 250000000 ${R1}`);
  click("fund-fetch");
  assert.equal(getEl("fetch-error").hidden, false, "foreign UTXO refused");
  assert.match(getEl("fetch-error").textContent, /not the funder address/);

  // bad secrets are rejected
  setVal("fund-secret", "obviously not a key");
  click("fund-derive");
  assert.equal(getEl("fund-error").hidden, false);

  // restore the good funder + utxo for the rest of the flow
  setVal("fund-secret", MNEMONIC);
  click("fund-derive");
  assert.equal(getEl("fund-error").hidden, true);
  setVal("utxo-paste", `${"aa".repeat(32)}:0 250000000 ${FUNDER}`);
  click("fund-fetch");
  assert.equal(getEl("fetch-error").hidden, true);
});

test("flow: recipients -> plan -> sign (committed bundle)", () => {
  setVal("recip-list", `${R1} 1.25\n${R2},0.5\n${R1} 0.25`);
  click("recip-parse");
  assert.equal(getEl("recip-error").hidden, true, "no parse error: " + getEl("recip-error").textContent);
  assert.ok(getEl("recip-summary").innerHTML.includes("2 recipients"), "duplicates merged: " + getEl("recip-summary").innerHTML);
  assert.ok(getEl("recip-summary").innerHTML.includes("merged"));

  // dust line refused
  setVal("recip-list", `${R1} 545 grains`);
  click("recip-parse");
  assert.equal(getEl("recip-error").hidden, false);
  assert.match(getEl("recip-error").textContent, /dust/);

  // restore good list
  setVal("recip-list", `${R1} 1.25\n${R2},0.5\n${R1} 0.25`);
  click("recip-parse");
  assert.equal(getEl("recip-error").hidden, true);

  setVal("fee-rate", "5");
  click("plan-button");
  assert.equal(getEl("plan-error").hidden, true, "no plan error: " + getEl("plan-error").textContent);
  assert.equal(getEl("plan-summary").hidden, false);
  assert.ok(getEl("plan-summary").innerHTML.includes("Recipients"));
  assert.equal(getEl("sign-button").disabled, false);

  click("sign-button");
  assert.equal(getEl("sign-error").hidden, true, "no sign error: " + getEl("sign-error").textContent);
  assert.equal(getEl("rain-result").hidden, false);
  assert.match(getEl("rain-txid").textContent, /^[0-9a-f]{64}$/);
  assert.ok(getEl("rain-hex").value.length > 400, "signed hex present");
  assert.equal(getEl("rain-verified").hidden, false);

  // independent check: the shown tx verifies against the funder prevout spk,
  // and decodes to exactly 2 recipient outputs + funder change
  const f = N.parseRainSecret(MNEMONIC, N.NETWORKS.mainnet);
  const { tweakedX } = N.tweakKeypath(N.hexToBytes(f.internalXOnlyHex));
  const spk = N.p2trScriptPubKey(tweakedX);
  const checks = N.verifySignedTx(N.NETWORKS.mainnet, getEl("rain-hex").value, [{ value: 250000000, spk }]);
  assert.equal(checks.length, 1);
  assert.ok(checks[0].ok, JSON.stringify(checks));
  const dec = N.decodeRawTx(getEl("rain-hex").value);
  assert.equal(dec.outputs.length, 3, "2 recipients + change");
  const vals = Array.from(dec.outputs, (o) => String(o.value));
  assert.deepEqual(vals.slice(0, 2), ["150000000", "50000000"], "merged duplicate paid once");
  const big = vals.map(BigInt);
  assert.ok(big[2] > 0n, "change output present");
  assert.equal(big[0] + big[1] + big[2], 250000000n - BigInt(N.keypathTxVBytes(1, 3)) * 5n, "exact accounting: total = out + fee + change");
});

test("plan: insufficient funds refused in the UI", () => {
  setVal("utxo-paste", `${"aa".repeat(32)}:0 100000000 ${FUNDER}`);
  click("fund-fetch");
  assert.equal(getEl("fetch-error").hidden, true);
  setVal("recip-list", `${R1} 3.5`);
  click("recip-parse");
  assert.equal(getEl("recip-error").hidden, true);
  click("plan-button");
  assert.equal(getEl("plan-error").hidden, false);
  assert.match(getEl("plan-error").textContent, /insufficient funds/);
});

test("footer carries donation address + X link", () => {
  assert.ok(html.includes("prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d"));
  assert.ok(html.includes("https://x.com/kshot9000"));
});

test("no localStorage dependency: store falls back in-memory", () => {
  // the sandbox has no localStorage at all — every flow above already ran
  // through the in-memory fallback without throwing.
  assert.equal(typeof sandbox.localStorage, "undefined");
});
