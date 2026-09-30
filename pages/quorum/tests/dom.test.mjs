// Pearl Quorum DOM tests: runs the real pearl-quorum.bundle.js + app.js in a
// minimal vm DOM (same harness family as split/dividend). Drives Vault (forge
// a 2-of-3 from BIP-340 test keys 0x01..0x03) -> Fund (pasted UTXOs) -> Spend
// (plan + tamper-evident unsigned bundle) -> Cosign (two slots sign with real
// Schnorr, keys wiped, signatures collected + verified, quorum finalize) ->
// Broadcast (stubbed /api/sendtx, double-confirm gate) -> Ledger (record + CSV).
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

/* ---------- minimal DOM (split/dividend harness, quorum attrs) ---------- */
class ClassList {
  constructor() { this.s = new Set(); }
  add(...c) { c.forEach((x) => this.s.add(x)); }
  remove(...c) { c.forEach((x) => this.s.delete(c)); }
  toggle(c, f) { (f ?? !this.s.has(c)) ? this.s.add(c) : this.s.delete(c); }
  contains(c) { return this.s.has(c); }
}
const registry = [];
function hydrate(el, htmlStr) {
  const re = /<(input|button)\b([^>]*)>/g;
  let m;
  while ((m = re.exec(htmlStr))) {
    const attrs = m[2];
    const dm = attrs.match(/\bdata-(key|utxo|oaddr|oprl)\b(?:="([^"]*)")?/) || attrs.match(/\b(data-orm)\b/);
    if (!dm) continue;
    const kid = new El(m[1]);
    kid.dataset[dm[1].replace(/^data-/, "")] = dm[2] ?? "";
    if (/\bchecked\b/.test(attrs)) kid.checked = true;
    if (/\bdisabled\b/.test(attrs)) kid.disabled = true;
    const tm = attrs.match(/\btype="([^"]*)"/);
    if (tm) kid.type = tm[1];
    el._kids.push(kid);
  }
}
function walkDesc(e, pred, out = []) {
  for (const k of e._kids) {
    if (pred(k)) out.push(k);
    walkDesc(k, pred, out);
  }
  return out;
}
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
    this.selected = false;
    registry.push(this);
  }
  setAttribute(k, v) { this._attrs[k] = String(v); }
  getAttribute(k) { return this._attrs[k] ?? null; }
  set className(v) { this._className = String(v); String(v).split(/\s+/).forEach((c) => c && this.classList.add(c)); }
  get className() { return this._className; }
  set innerHTML(v) {
    this._html = String(v); this._kids = [];
    this._text = String(v).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    hydrate(this, String(v));
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
  querySelector(sel) { const all = this.querySelectorAll(sel); return all[0] || null; }
  querySelectorAll(sel) {
    const mm = sel.match(/^\[data-(key|utxo|oaddr|oprl|orm)\]$/);
    if (mm) return walkDesc(this, (k) => k.dataset[mm[1]] !== undefined);
    const cm = sel.match(/^\.([\w-]+)$/);
    if (cm) return walkDesc(this, (k) => k.classList.contains(cm[1]));
    return [];
  }
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
  querySelectorAll: (sel) => {
    if (sel === "#steps button") return stepButtons;
    if (sel === "[data-key]") return walkDesc(getEl("v-keys"), (k) => k.dataset.key !== undefined);
    if (sel === "#s-outputs .out-row") return getEl("s-outputs").querySelectorAll(".out-row");
    return [];
  },
  querySelector: () => null,
  createElement: (t) => new El(t),
  body: new El("body"),
  readyState: "complete",
};

const lsMem = {};
const lsShim = {
  getItem: (k) => (k in lsMem ? lsMem[k] : null),
  setItem: (k, v) => { lsMem[k] = String(v); },
  removeItem: (k) => { delete lsMem[k]; },
};

async function stubFetch(url, opts = {}) {
  const u = String(url);
  if (u.includes("/api/sendtx/")) {
    const j = { result: "cd".repeat(32) };
    return { ok: true, status: 200, text: async () => JSON.stringify(j), json: async () => j };
  }
  if (/\/api\/v2\/tx\/[0-9a-f]{64}$/.test(u)) {
    const j = { txid: u.slice(-64), confirmations: 3 };
    return { ok: true, status: 200, text: async () => JSON.stringify(j), json: async () => j };
  }
  throw new Error("unexpected network fetch in DOM test: " + url);
}

const sandbox = {
  document: documentShim,
  navigator: {},
  localStorage: lsShim,
  URL: { createObjectURL: () => "blob:stub", revokeObjectURL() {} },
  Blob: class { constructor(parts) { this.parts = parts; } },
  TextDecoder, crypto: webcrypto, fetch: stubFetch,
  setTimeout, clearTimeout, setInterval, clearInterval,
  addEventListener() {},
  scrollTo() {},
  confirm: () => true,
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
for (const f of ["pearl-quorum.bundle.js", "app.js"]) {
  vm.runInContext(fs.readFileSync(resolvePath(dir, f), "utf8"), sandbox, { filename: f, timeout: 30000 });
}

const P = sandbox.PearlQuorum;
assert.ok(P, "bundle exposes window.PearlQuorum");
const get = (id) => documentShim.getElementById(id);
const set = (id, v) => { get(id).value = v; };
const click = (id) => get(id).click();
const noErr = (id) => assert.equal(get(id).hidden, true, `${id} should be hidden, got: ${get(id).textContent}`);

// fixtures: BIP-340 test vector secrets (TEST USE ONLY — never real money)
const K1 = "01".repeat(32), K2 = "02".repeat(32), K3 = "03".repeat(32);
// schnorr.getPublicKey returns the 32-byte x-only key directly
const X1 = P.schnorr.getPublicKey(P.hexToBytes(K1));
const X2 = P.schnorr.getPublicKey(P.hexToBytes(K2));
const X3 = P.schnorr.getPublicKey(P.hexToBytes(K3));
const PINNED_TESTNET = "tprl1pq98jxc0fmn9nez5j6pr3s9vlf5wjzzk8ve2hr0t09vdpymwtmxmqd2pkz9";
const DEST = P.encodeBech32m("tprl", 1, P.hexToBytes("ab".repeat(32)));

test("vault: 2-of-3 forged from pasted keys on testnet", () => {
  set("v-name", "Test council");
  set("v-network", "testnet");
  set("v-n", "3"); get("v-n").fire("change");
  const inputs = documentShim.querySelectorAll("[data-key]");
  assert.equal(inputs.length, 3, "three key inputs rendered");
  [X1, X2, X3].forEach((x, i) => { inputs[i].value = P.bytesToHex(x); });
  set("v-m", "2");
  click("v-forge");
  noErr("vault-error");
  assert.equal(get("vault-result").hidden, false);
  assert.equal(get("v-r-addr").textContent, PINNED_TESTNET, "pinned address");
  assert.equal(get("v-r-backdoor").hidden, true, "no backdoor warning with NUMS internal key");
  const expBtn = stepButtons.find((b) => b.dataset.step === "spend");
  assert.equal(expBtn.disabled, false, "spend unlocked");
});

test("vault: bad key refused, duplicate keys refused", () => {
  const inputs = documentShim.querySelectorAll("[data-key]");
  inputs[0].value = "zz";
  click("v-forge");
  assert.equal(get("vault-error").hidden, false);
  assert.match(get("vault-error").textContent, /hex/i);
  inputs[0].value = P.bytesToHex(X1);
  inputs[1].value = P.bytesToHex(X1);
  click("v-forge");
  assert.equal(get("vault-error").hidden, false);
  assert.match(get("vault-error").textContent, /duplicate/i);
  inputs[1].value = P.bytesToHex(X2);
});

test("fund: pasted UTXOs become the selected set", () => {
  set("f-paste", JSON.stringify([
    { txid: "ab".repeat(32), vout: 0, value: 500000000 },
    { txid: "cd".repeat(32), vout: 1, value: 300000000 },
  ]));
  click("f-apply");
  noErr("fund-error");
  assert.equal(get("f-r-bal").textContent, "8 PRL", "balance sums pasted UTXOs");
  assert.equal(get("f-r-count").textContent, "2");
});

test("spend: plan, fee and tamper-evident bundle", () => {
  const rows = documentShim.querySelectorAll("#s-outputs .out-row");
  assert.equal(rows.length, 1, "one recipient row by default");
  rows[0].querySelector("[data-oaddr]").value = DEST;
  rows[0].querySelector("[data-oprl]").value = "5";
  set("s-feerate", "2");
  click("s-build");
  noErr("spend-error");
  assert.equal(get("spend-result").hidden, false);
  assert.match(get("s-r-fee").textContent, /PRL @ 2 gr\/vB/);
  assert.match(get("s-r-thr").textContent, /2-of-3/);
  const digests = get("s-r-digests").innerHTML;
  assert.equal((digests.match(/<li>/g) || []).length, 2, "one digest per input");
  const bundle = get("s-bundle").value;
  assert.ok(bundle.startsWith("pearl-quorum-unsigned:v1:"), "kind tag is a text prefix");
  const parsed = JSON.parse(bundle.slice("pearl-quorum-unsigned:v1:".length));
  assert.equal(parsed.fingerprint, get("s-r-fp").textContent);
  assert.equal(parsed.n, 3);
});

test("cosign: slot 1 signs, key wiped, wrong slot refused", () => {
  set("c-bundle", get("s-bundle").value);
  click("c-import");
  noErr("cosign-error");
  set("c-slot", "0");
  set("c-key", "cd".repeat(32)); // valid scalar, unrelated key
  click("c-sign");
  assert.equal(get("cosign-error").hidden, false, "unrelated key refused");
  assert.match(get("cosign-error").textContent, /not cosigner slot|wrong slot/i);
  set("c-key", K1);
  click("c-sign");
  noErr("cosign-error");
  assert.equal(get("c-key").value, "", "key wiped after signing");
  const sb = P.importSigBundleText(get("c-sigs-out").value);
  assert.equal(sb.slot, 0);
  assert.equal(sb.sigs.length, 2, "one sig per input");
  assert.ok(get("q-count").textContent.startsWith("1/2"), "ring shows 1 of 2");
});

test("cosign: slot 2 signs, duplicate paste refused, finalize assembles", () => {
  set("c-slot", "1");
  set("c-key", K2);
  click("c-sign");
  noErr("cosign-error");
  // re-pasting the same bundle must be refused as a duplicate
  set("c-sigs-in", get("c-sigs-out").value);
  click("c-add");
  assert.equal(get("c-collect-error").hidden, false, "duplicate bundle refused");
  assert.match(get("c-collect-error").textContent, /duplicate/i);
  assert.ok(get("q-count").textContent.startsWith("2/2"), "ring shows 2 of 2");
  assert.equal(get("c-finalize").disabled, false, "finalize enabled at quorum");
  click("c-finalize");
  noErr("c-collect-error");
  assert.equal(get("c-final").hidden, false);
  assert.match(get("c-r-txid").textContent, /^[0-9a-f]{64}$/);
  assert.equal(get("c-r-slots").textContent, "1, 2");
  assert.equal(get("b-arm").disabled, false, "broadcast arm button enabled after finalize");
});

test("broadcast: double-confirm, stubbed sendtx, track confirmations", async () => {
  set("b-blockbook", "https://blockbook.stub");
  click("b-arm");
  assert.equal(get("b-confirm").hidden, false, "confirm gate appears");
  click("b-confirm");
  await new Promise((r) => setImmediate(r));
  noErr("bcast-error");
  assert.equal(get("bcast-result").hidden, false);
  assert.equal(get("b-r-txid").textContent, "cd".repeat(32), "stub txid recorded");
  click("b-track");
  await new Promise((r) => setImmediate(r));
  assert.equal(get("b-r-confs").textContent, "3", "stub confirmations shown");
});

test("ledger: record spend and export CSV", () => {
  click("b-record");
  click("v-save");
  click("l-csv-vaults");
  const ledger = JSON.parse(lsShim.getItem("pearl-quorum-ledger-v1"));
  const spends = P.spendsToCSV(ledger.spends);
  assert.ok(spends.includes("cd".repeat(32)), "spend CSV has the txid");
  assert.ok(get("l-spends").innerHTML.includes("cd".repeat(32)), "spend rendered");
  assert.ok(get("l-vaults").innerHTML.includes(PINNED_TESTNET), "vault rendered");
});
