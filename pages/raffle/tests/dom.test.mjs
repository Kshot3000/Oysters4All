// Pearl Raffle DOM integration test — boots the real index.html + committed
// bundle (pearl-raffle.bundle.js) + app.js against a minimal DOM shim and
// drives the full flow: forge -> track+scan -> draw -> verify -> payout,
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
  querySelectorAll() { return []; } // children not modeled in the shim
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
// fetch stub: Blockbook tip + block-index
const fetchStub = async (url) => {
  const u = String(url);
  const json = (obj) => ({ ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) });
  if (u.endsWith("/api/v2")) return json({ blockbook: { bestHeight: 120600 }, backend: { blocks: 120600 } });
  if (u.includes("/api/v2/block-index/")) return json({ blockHash: "bb".repeat(32) });
  throw new Error("unstubbed fetch: " + u);
};
const sandbox = {
  document: documentShim,
  navigator: { clipboard: { writeText: async () => {} } },
  TextDecoder, crypto: webcrypto, fetch: fetchStub,
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
for (const f of ["pearl-raffle.bundle.js", "app.js"]) {
  vm.runInContext(fs.readFileSync(resolvePath(dir, f), "utf8"), sandbox, { filename: f, timeout: 15000 });
}
const E = sandbox.PearlRaffle;
assert.ok(E, "bundle loaded as window.PearlRaffle");

const click = (id) => getEl(id).click();
const setVal = (id, v) => { getEl(id).value = v; };
const A0 = "prl1pr6yuq8u2r95wjzzgpdy8cpnncpl7l8zgy6x5q0367pnc53s2famqg7pt74";
const R1 = "prl1p7dwp74zgd4te3mqr58d6x3p3t70jljmpe4auey8g824ra4x43tks3y4pr6";
const R2 = "prl1p5gfau0gepxzjkjyx9t88ewnhujrmpjqgqfh8v9vympjaz94x36jqpepvyt";
const PIN_DESC = "raffle:v1:prl:250000000:120500:dd49308dd9be23d6935380452aec46a51b2feb80b1a9b9e4a27f0db45b601e1a:3";
const SAMPLE = `${A0} 10\n${R1} 5\n${R2} 1`;

test("flow: forge (manual tip, committed bundle)", async () => {
  setVal("forge-prize", "2.5");
  setVal("forge-height", "120500");
  setVal("forge-tip-manual", "120000");
  setVal("forge-entries", SAMPLE);
  click("forge-parse");
  assert.equal(getEl("forge-entries-error").hidden, true, "no entry error: " + getEl("forge-entries-error").textContent);
  assert.ok(getEl("forge-entries-summary").innerHTML.includes("3</strong> entries"), getEl("forge-entries-summary").innerHTML);
  assert.ok(getEl("forge-entries-summary").innerHTML.includes("16</strong> tickets"), getEl("forge-entries-summary").innerHTML);

  // too-near settlement refused
  setVal("forge-height", "120002");
  click("forge-button");
  assert.equal(getEl("forge-error").hidden, false, "too-near settle refused");
  assert.match(getEl("forge-error").textContent, /lead/);

  // dust prize refused
  setVal("forge-height", "120500");
  setVal("forge-prize", "0.000001");
  click("forge-button");
  assert.equal(getEl("forge-error").hidden, false, "dust prize refused");
  assert.match(getEl("forge-error").textContent, /dust/);

  // good forge: descriptor equals the pinned vector
  setVal("forge-prize", "2.5");
  click("forge-button");
  assert.equal(getEl("forge-error").hidden, true, "no forge error: " + getEl("forge-error").textContent);
  assert.equal(getEl("forge-out").hidden, false);
  assert.equal(getEl("forge-descriptor").value, PIN_DESC, "forged descriptor matches pinned vector");
  assert.ok(getEl("forge-publish").value.includes("PRL-RAFFLE-COMMIT:v1"), "publishable commitment");
  assert.ok(getEl("forge-publish").value.includes("MUST be published BEFORE block 120500"), "commitment warns about timing");
});

test("flow: track + scan (stubbed blockbook)", async () => {
  setVal("track-descriptor", PIN_DESC);
  setVal("track-entries", SAMPLE);
  click("track-load");
  assert.equal(getEl("track-error").hidden, true, "no track error: " + getEl("track-error").textContent);
  assert.equal(getEl("track-out").hidden, false);
  assert.ok(getEl("track-fields").innerHTML.includes("2.5 PRL"), "prize shown");
  assert.ok(getEl("track-commit").textContent.includes("matches"), "commitment re-check passes: " + getEl("track-commit").textContent);

  // tampered entry list refused at track
  setVal("track-entries", `${A0} 10\n${R1} 5\n${R2} 99`);
  click("track-load");
  assert.equal(getEl("track-error").hidden, false, "tampered entries refused");
  assert.match(getEl("track-error").textContent, /MISMATCH/);
  setVal("track-entries", SAMPLE);
  click("track-load");
  assert.equal(getEl("track-error").hidden, true);

  click("track-scan");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(getEl("track-error").hidden, true, "no scan error: " + getEl("track-error").textContent);
  assert.ok(getEl("track-tip").textContent.includes("120,600"), "tip shown: " + getEl("track-tip").textContent);
  assert.ok(getEl("track-left").textContent.includes("mined"), "settlement mined: " + getEl("track-left").textContent);
  assert.equal(getEl("track-sethash").textContent, "bb".repeat(32), "settlement hash from block-index stub");
});

test("flow: draw (committed bundle, pinned vector)", async () => {
  setVal("draw-descriptor", PIN_DESC);
  setVal("draw-entries", SAMPLE);
  setVal("draw-blockhash", "aa".repeat(32));
  setVal("draw-rounds", "3");
  click("draw-run");
  assert.equal(getEl("draw-error").hidden, true, "no draw error: " + getEl("draw-error").textContent);
  assert.equal(getEl("draw-out").hidden, false);
  const winners = getEl("draw-winners").innerHTML;
  assert.ok(winners.includes(A0), "round 1 winner pinned");
  assert.ok(winners.includes(R1), "round 2 winner pinned");
  assert.ok(winners.includes(R2), "round 3 winner pinned");
  const deriv = getEl("draw-derivation").innerHTML;
  assert.ok(deriv.includes("775102a3bf756956de81605683f2ac91ba637b16135cfbb9b51ffd8815760dcf"), "round-1 draw bytes shown");
  assert.ok(deriv.includes("raffle-draw:v1:"), "preimage shape shown for hand verification");

  // refusal: no block hash
  setVal("draw-blockhash", "");
  click("draw-run");
  assert.equal(getEl("draw-error").hidden, false, "missing block hash refused");
  assert.match(getEl("draw-error").textContent, /64 hex/);
});

test("flow: verify standalone (tamper refused loudly)", async () => {
  setVal("verify-descriptor", PIN_DESC);
  setVal("verify-entries", SAMPLE);
  setVal("verify-blockhash", "aa".repeat(32));
  setVal("verify-rounds", "3");
  click("verify-run");
  assert.equal(getEl("verify-error").hidden, true, "no verify error: " + getEl("verify-error").textContent);
  assert.ok(getEl("verify-verdict").innerHTML.includes("VERIFIED"), "verified verdict");

  setVal("verify-entries", `${A0} 10\n${R1} 5\n${R2} 99`);
  click("verify-run");
  assert.equal(getEl("verify-error").hidden, false, "tampered verify refused");
  assert.ok(getEl("verify-verdict").innerHTML.includes("NOT PROVEN"), "loud refusal verdict");
  assert.match(getEl("verify-error").textContent, /LOUD REFUSAL/);
});

test("flow: payout plan (exact split, pearl URIs)", async () => {
  setVal("payout-descriptor", PIN_DESC);
  setVal("payout-winners", `${A0}\n${R1}\n${R2}`);
  click("payout-build");
  assert.equal(getEl("payout-error").hidden, true, "no payout error: " + getEl("payout-error").textContent);
  assert.equal(getEl("payout-out").hidden, false);
  assert.ok(getEl("payout-total").textContent.includes("2.5"), "total 2.5 PRL");
  const rows = getEl("payout-rows").innerHTML;
  assert.ok(rows.includes(`pearl:${A0}?amount=0.83333334`), "round-1 URI with remainder grain");
  assert.ok(rows.includes(`pearl:${R2}?amount=0.83333333`), "round-3 URI");

  // bad winner address refused
  setVal("payout-winners", "notanaddress");
  click("payout-build");
  assert.equal(getEl("payout-error").hidden, false, "bad winner address refused");
});

test("footer carries donation address + X link", () => {
  assert.ok(html.includes("prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d"));
  assert.ok(html.includes("https://x.com/kshot9000"));
});

test("honest limits panel present, no placeholders", () => {
  assert.ok(html.includes("honest-limits"), "honest limits panel");
  assert.ok(html.includes("never moves PRL"), "no-PRL-movement honesty");
  const bundle = fs.readFileSync(resolvePath(dir, "pearl-raffle.bundle.js"), "utf8");
  assert.ok(bundle.includes("PearlRaffle"), "bundle exposes window.PearlRaffle");
});
