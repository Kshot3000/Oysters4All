// Pearl Batch DOM tests: runs the real pearl-batch.bundle.js + app.js in a
// minimal vm DOM (adapted from the tax app's harness), with a stubbed
// Blockbook. Drives the full 5-step wizard end to end.
// Usage: node --no-warnings --loader ./tests/loader.mjs tests/batch.dom.test.mjs
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
    registry.push(this);
  }
  set className(v) { this._className = String(v); String(v).split(/\s+/).forEach((c) => c && this.classList.add(c)); }
  get className() { return this._className; }
  set innerHTML(v) {
    this._html = String(v); this._kids = [];
    this._text = String(v).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(); // readable text for tests
  }
  get innerHTML() { return this._html; }
  set textContent(v) { this._text = String(v); }
  get textContent() { return this._text; }
  insertAdjacentHTML(pos, html) {
    this._html += String(html);
    this._text = (this._text + " " + String(html).replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
  }
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
// Honor value/checked/hidden attributes present in the static HTML so the
// shimmed inputs behave like a real browser's defaults.
const attrMap = new Map();
for (const m of html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)) {
  if (attrMap.has(m[1])) continue;
  const tag = m[0];
  const vv = tag.match(/\bvalue="([^"]*)"/);
  attrMap.set(m[1], {
    value: vv ? vv[1] : "",
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
    if (sel === "[data-copy]") return [];
    return [];
  },
  querySelector: () => null,
  createElement: (t) => new El(t),
  body: new El("body"),
  readyState: "complete",
  execCommand: () => false,
};

/* ---------- stubbed Blockbook ---------- */
let PRIV_HEX = "0f".repeat(32);
const QA = { mode: "ok", signedTxid: null, utxos: null, trackTx: null };
const okBody = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });
const fail = (status) => ({ ok: false, status, json: async () => ({}), text: async () => "error" });
async function stubFetch(url, opts = {}) {
  const u = String(url);
  const path = u.replace(/^https?:\/\/[^/]+/, "");
  if (path.startsWith("/api/v2/utxo/")) return okBody(QA.utxos);
  if (path.startsWith("/api/v2/estimatefee/")) return okBody({ result: "0.0002" });
  if (path.endsWith("/api/sendtx/")) {
    if (opts.method !== "POST") return fail(405);
    QA.postedHex = opts.body;
    return okBody({ result: QA.signedTxid });
  }
  if (path.startsWith("/api/v2/tx/")) {
    const id = path.split("/api/v2/tx/")[1].split("?")[0];
    return QA.trackTx && QA.trackTx.txid === id ? okBody(QA.trackTx) : fail(404);
  }
  return fail(404);
}

const sandbox = {
  document: documentShim,
  navigator: { clipboard: { writeText: async (t) => { sandbox.__copied = t; } } },
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
for (const f of ["pearl-batch.bundle.js", "app.js"]) {
  vm.runInContext(fs.readFileSync(resolvePath(dir, f), "utf8"), sandbox, { filename: f, timeout: 30000 });
}

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const R = sandbox.PearlBatch;
assert.ok(R, "bundle exposes window.PearlBatch");
const T = sandbox.__batchTest;
assert.ok(T, "test hook exposed");
const get = (id) => documentShim.getElementById(id);
async function waitFor(fn, label) {
  for (let i = 0; i < 150; i++) { if (fn()) return; await tick(40); }
  throw new Error("timeout waiting for: " + label);
}

// fixture identities derived through the real bundle
const N = R.NETWORKS.mainnet;
const wSender = R.walletFromPriv(PRIV_HEX, N);
const SENDER = wSender.address;
const WIF = R.walletToWIF(R.hexToBytes(PRIV_HEX), N);
const recip = (h) => R.walletFromPriv(h, N).address;
const A1 = recip("aa".repeat(32)), A2 = recip("bb".repeat(32)), A3 = recip("cc".repeat(32));
QA.utxos = [
  { txid: "a".repeat(64), vout: 0, value: "800000000", confirmations: 10 },
  { txid: "b".repeat(64), vout: 1, value: "500000000", confirmations: 7 },
  { txid: "c".repeat(64), vout: 2, value: "50000000", confirmations: 2 },
];

test("boot: footer attribution, honest limits, step 1 visible", () => {
  assert.ok(html.includes("prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d"), "donation address in footer");
  assert.ok(html.includes("https://x.com/kshot9000"), "x link in footer");
  assert.ok(html.includes("Honest limits"), "honest-limits panel present");
  assert.ok(!get("step-manifest").hidden, "step 1 visible at boot");
  assert.ok(get("step-freight").hidden, "step 2 hidden at boot");
  assert.ok(get("st-manifest").classList.contains("active"), "nav 1 active");
});

test("manifest: invalid address refused loudly", async () => {
  get("m-text").value = "junk-address, 1";
  get("m-parse").click();
  await tick();
  assert.ok(!get("m-err").hidden, "error shown");
  assert.match(get("m-err").textContent, /MANIFEST REFUSED/);
  assert.equal(T.state().manifest, null);
});

test("manifest: sample validates — exact totals, 3 rows", async () => {
  get("m-text").value = R.sampleManifest().replace(/prl1pr6yuq8u2r95wjzzgpdy8cpnncpl7l8zgy6x5q0367pnc53s2famqg7pt74/g, A1)
    .replace(/prl1p7dwp74zgd4te3mqr58d6x3p3t70jljmpe4auey8g824ra4x43tks3y4pr6/g, A2)
    .replace(/prl1p5gfau0gepxzjkjyx9t88ewnhujrmpjqgqfh8v9vympjaz94x36jqpepvyt/g, A3);
  get("m-parse").click();
  await tick();
  const m = T.state().manifest;
  assert.ok(m, "manifest accepted");
  assert.equal(JSON.parse(JSON.stringify(m.recipients)).length, 3);
  assert.equal(get("m-tbody").children.length, 3);
  assert.equal(m.total, "1125000546n");
  assert.match(get("m-total").textContent, /11\.25000546 PRL/);
  assert.match(get("m-merged").textContent, /none/);
  get("m-next").click();
  await tick();
  assert.ok(!get("step-freight").hidden, "moved to freight");
});

test("manifest: dust line refused, duplicates merge", async () => {
  get("m-text").value = `${A1}, 1\n${A2}, 545 grains`;
  get("m-parse").click();
  await tick();
  assert.match(get("m-err").textContent, /dust floor/);
  get("m-text").value = `${A1}, 1\n${A2}, 2\n${A1}, 0.5`;
  get("m-parse").click();
  await tick();
  assert.equal(get("m-tbody").children.length, 2);
  assert.match(get("m-merged").textContent, /1 duplicate/);
  // restore the full sample for the rest of the flow
  get("m-text").value = `${A1}, 1.25, vendor\n${A2}, 546 grains\n${A3}, 10`;
  get("m-parse").click();
  await tick();
  assert.equal(get("m-tbody").children.length, 3);
});

test("manifest: merge off refuses duplicates loudly", async () => {
  get("m-merge").checked = false;
  get("m-text").value = `${A1}, 1\n${A2}, 2\n${A1}, 0.5`;
  get("m-parse").click();
  await tick();
  assert.ok(!get("m-err").hidden, "refusal shown");
  assert.match(get("m-err").textContent, /merging is OFF/);
  assert.equal(T.state().manifest, null);
  get("m-merge").checked = true;
  get("m-parse").click();
  await tick();
  assert.equal(get("m-tbody").children.length, 2, "merging back on merges");
  // restore the full sample for the rest of the flow
  get("m-text").value = `${A1}, 1.25, vendor\n${A2}, 546 grains\n${A3}, 10`;
  get("m-parse").click();
  await tick();
  assert.equal(get("m-tbody").children.length, 3);
});

test("freight: bad sender refused, fetch loads 3 UTXOs, totals balance", async () => {
  get("f-sender").value = "not-an-address";
  get("f-fetch").click();
  await tick();
  assert.match(get("f-err").textContent, /FETCH FAILED/);
  get("f-sender").value = SENDER;
  get("blockbook").value = "https://bb.test";
  get("f-fetch").click();
  await waitFor(() => get("f-tbody").children.length === 3, "utxo rows");
  assert.match(get("f-fetch-msg").textContent, /Loaded 3 UTXO/);
  await tick();
  assert.match(get("f-totals").textContent, /Coverage/);
  assert.ok(!/SHORTFALL/.test(get("f-totals").textContent), "no shortfall: " + get("f-totals").textContent.slice(0, 120));
  assert.match(get("f-totals").textContent, /OK — inputs = outputs \+ fee/);
});

test("freight: manual mode shortfall refused loudly", async () => {
  get("f-auto").checked = false;
  get("f-auto").fire("change");
  get("f-none").click();
  await tick();
  assert.ok(!get("f-cover-err").hidden, "shortfall error visible");
  assert.match(get("f-cover-err").textContent, /NOT COVERED/);
  get("f-all").click();
  await tick();
  assert.ok(get("f-cover-err").hidden, "shortfall cleared");
  get("f-auto").checked = true;
  get("f-auto").fire("change");
  await tick();
});

test("freight: pasted UTXOs parse (air-gapped path)", async () => {
  get("f-paste").value = `${"d".repeat(64)}:0 900000000\n${"e".repeat(64)}:1 3 prl`;
  get("f-parse-paste").click();
  await tick();
  assert.equal(get("f-tbody").children.length, 2, "pasted utxos replace the list");
  assert.match(get("f-totals").textContent, /OK — inputs = outputs \+ fee/);
  // restore fetched utxos for the signing flow
  get("f-sender").value = SENDER;
  get("f-fetch").click();
  await waitFor(() => get("f-tbody").children.length === 3, "utxo rows again");
});

test("review: full breakdown, exact fee math, balance check", async () => {
  get("f-next").click();
  await tick();
  assert.ok(!get("step-review").hidden, "review visible");
  assert.equal(get("r-tbody").children.length, 3, "3 recipient rows");
  assert.equal(get("r-itbody").children.length, 2, "2 input rows (auto-selected)");
  const st = T.state();
  const plan = JSON.parse(JSON.stringify(st.plan), (k, v) => v);
  const wantVBytes = R.keypathTxVBytes(2, 4);
  assert.match(get("r-fee").textContent, new RegExp(`${wantVBytes} vB`));
  const feeGrains = BigInt(wantVBytes) * 20n;
  assert.match(get("r-fee").textContent, new RegExp(`${feeGrains} grains`));
  assert.match(get("r-summary").textContent, /exact to the grain/);
  // dust-change note path: change is large here, so note hidden
  assert.ok(get("r-dust-note").hidden);
  assert.ok(get("r-next").disabled, "next gated on double-confirm");
  get("r-confirm").checked = true;
  get("r-confirm").fire("change");
  assert.ok(!get("r-next").disabled, "next enabled after confirm");
  get("r-next").click();
  await tick();
  assert.ok(!get("step-sign").hidden, "sign visible");
});

test("sign: bundle exported with 16-hex fingerprint", async () => {
  assert.match(get("s-fp").textContent, /^[0-9a-f]{16}$/);
  assert.match(get("s-unsigned-txid").textContent, /^[0-9a-f]{64}$/);
  const b = JSON.parse(get("s-bundle").value);
  assert.equal(b.bundle, "pearl-batch-unsigned:v1:");
  assert.equal(b.fingerprint, get("s-fp").textContent);
  // unsigned txid in the bundle IS the final txid (segwit property)
  assert.equal(b.unsignedTxid, get("s-unsigned-txid").textContent);
});

test("sign: bundle import round-trip + tamper refusal", async () => {
  const raw = get("s-bundle").value;
  get("s-import").value = raw;
  get("s-import-fp").value = get("s-fp").textContent;
  get("s-import-btn").click();
  await tick();
  assert.ok(!get("s-import-ok").hidden, "import ok shown");
  assert.match(get("s-import-ok").textContent, /all cross-checks passed/);
  const tampered = JSON.parse(raw);
  tampered.descriptor.recipients[0].amountGrains = "999999999";
  get("s-import").value = JSON.stringify(tampered);
  get("s-import-fp").value = "";
  get("s-import-btn").click();
  await tick();
  assert.match(get("s-import-err").textContent, /FINGERPRINT MISMATCH/);
  // wrong expected fingerprint also refused
  get("s-import").value = raw;
  get("s-import-fp").value = "0".repeat(16);
  get("s-import-btn").click();
  await tick();
  assert.match(get("s-import-err").textContent, /FINGERPRINT MISMATCH/);
});

test("sign: wrong key refused, right key signs with N/N verification + wipe", async () => {
  const otherWif = R.walletToWIF(R.hexToBytes("ab".repeat(32)), N);
  get("s-key").value = otherWif;
  get("s-sign").click();
  await tick(300);
  assert.match(get("s-err").textContent, /KEY DOES NOT CONTROL/);
  get("s-key").value = WIF;
  get("s-sign").click();
  await waitFor(() => !get("s-out").hidden, "signed output");
  assert.match(get("s-verify").textContent, /2\/2 Schnorr signatures re-verified/);
  assert.match(get("s-txid").textContent, /^[0-9a-f]{64}$/);
  assert.ok(get("s-hex").value.length > 500, "signed hex present");
  assert.equal(get("s-key").value, "", "key wiped from the input");
  assert.equal(T.state().secret, null, "key wiped from state");
  // txid matches the bundle's unsigned txid (segwit property)
  assert.equal(get("s-txid").textContent, get("s-unsigned-txid").textContent);
  QA.signedTxid = get("s-txid").textContent;
  get("s-next").click();
  await tick();
  assert.ok(!get("step-broadcast").hidden, "broadcast visible");
  assert.ok(get("b-pearld-cmd").textContent.includes("sendrawtransaction"), "pearld command shown");
});

test("broadcast: double-confirm gate, POST to /api/sendtx/, track + verify", async () => {
  assert.ok(get("b-send").disabled, "broadcast gated");
  get("b-confirm").checked = true;
  get("b-confirm").fire("change");
  assert.ok(!get("b-send").disabled, "broadcast enabled after confirm");
  // build the chain-side fixture for the audit
  const st = T.state();
  const revive = (k, v) => (typeof v === "string" && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v);
  const plan = JSON.parse(JSON.stringify(st.plan), revive);
  const recips = JSON.parse(JSON.stringify(st.manifest.recipients), revive);
  const vinSum = 1300000000n;
  const vout = recips.map((r) => ({ addresses: [r.address], value: String(BigInt(r.amount)) }));
  const fee = BigInt(plan.fee);
  const change = BigInt(plan.change);
  if (change > 0n) vout.push({ addresses: [SENDER], value: change.toString() });
  QA.trackTx = {
    txid: QA.signedTxid, confirmations: 4, blockHeight: 900123,
    vin: [{ addresses: [SENDER], value: vinSum.toString() }],
    vout,
  };
  get("b-send").click();
  await waitFor(() => !get("b-track").hidden, "track panel");
  assert.equal(QA.postedHex, get("s-hex").value, "posted hex is the signed hex");
  assert.match(get("b-stamp").textContent, /BROADCAST/);
  get("b-track-start").click();
  await waitFor(() => !get("b-verify-out").hidden, "verify panel");
  await tick(200);
  assert.match(get("b-verdict").textContent, /BATCH VERIFIED/);
  assert.match(get("b-verify-kv").textContent, new RegExp(`${fee} grains`));
  get("b-track-stop").click();
});

test("standalone verifier: clean batch verifies, shorted batch fails", async () => {
  get("v-txid").value = QA.signedTxid;
  get("v-sender").value = SENDER;
  get("v-manifest").value = `${A1}, 1.25\n${A2}, 546 grains\n${A3}, 10`;
  get("v-run").click();
  await waitFor(() => !get("v-out").hidden, "verifier output");
  assert.match(get("v-verdict").textContent, /BATCH VERIFIED/);
  get("v-manifest").value = `${A1}, 999\n${A2}, 546 grains\n${A3}, 10`;
  get("v-run").click();
  await tick(200);
  assert.match(get("v-verdict").textContent, /NOT VERIFIED/);
});

test("wipe button clears key material", async () => {
  get("s-key").value = WIF;
  get("wipe").click();
  await tick();
  assert.equal(get("s-key").value, "");
  assert.match(get("wipe-msg").textContent, /wiped/);
});


test("address/txid title attributes are escaped (XSS audit latent queue)", () => {
  const src = fs.readFileSync(resolvePath(dir, "app.js"), "utf8");
  assert.ok(!/title="\$\{(r\.address|u\.txid|state\.senderAddress|e\.address)\}"/.test(src), "no raw title interpolation");
  assert.equal((src.match(/title="\$\{escapeHtml\(/g) || []).length, 5, "all five titles escaped");
  assert.ok(html.includes('app.js?v=3'), "cache key bumped");
});
