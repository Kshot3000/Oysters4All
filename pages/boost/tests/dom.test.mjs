// Pearl Boost DOM tests: runs the real pearl-boost.bundle.js + app.js in a
// minimal vm DOM. Drives Diagnose -> CPFP (plan, key/address guard, sign with
// real Schnorr + re-verification, double-confirm broadcast via stubbed
// fetch, key wipe) -> RBF (plan, sign, broadcast) -> Track -> Verify
// (PROVEN / NOT PROVEN), plus loud refusals (confirmed tx, wrong key, dust).
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
const bundleSrc = fs.readFileSync(resolvePath(dir, "pearl-boost.bundle.js"), "utf8");
const appSrc = fs.readFileSync(resolvePath(dir, "app.js"), "utf8");

/* ---------- pinned fixture keypairs (same as qa-boost-browser.mjs) ---------- */
const FIX1 = {
  wif: "KwntMbt59tTsj8xqpqYqRRWufyjGunvhSyeMo3NTYpFYzZbXJ5Hp",
  address: "prl1p9fjtrm3nwhemkjek0wxtswz2glmneu33w9lcylrvd7alttk0psmqztxl5f",
  spkHex: "51202a64b1ee3375f3bb4b367b8cb8384a47f73cf231717f827c6c6fbbf5aecf0c36",
};
const FIX2 = {
  wif: "KxN4XYdzu6f9j3EMryaMwZvUVLk3y29M4QZ2xwPoFP2zwka1aWxU",
  address: "prl1pvf8l7evgsrnvjsh0e3f8622e0utw2asn0wyt8un8432xshzltqkspwlu5h",
  spkHex: "5120624fff658880e6c942efcc527d29597f16e576137b88b3f267ac54685c5f582d",
};
const PARENT_TXID = "aa".repeat(32);
const PREV_TXID = "bb".repeat(32);
const CHILD_TXID = "cc".repeat(32);
const CONFIRMED_TXID = "dd".repeat(32);
const DUSTY_TXID = "ee".repeat(32);

const parentTx = {
  txid: PARENT_TXID, confirmations: 0, fees: "1000", vsize: 140,
  vin: [{ n: 0, txid: PREV_TXID, vout: 0, sequence: 0xfffffffd, value: "110000", addresses: [FIX1.address] }],
  vout: [
    { n: 0, value: "100000", spent: false, hex: FIX1.spkHex, addresses: [FIX1.address] },
    { n: 1, value: "9000", spent: false, hex: FIX2.spkHex, addresses: [FIX2.address] },
  ],
};
const prevTx = {
  txid: PREV_TXID, confirmations: 6, fees: "500", vsize: 140,
  vin: [], vout: [{ n: 0, value: "110000", spent: true, hex: FIX1.spkHex, addresses: [FIX1.address] }],
};
const childTx = {
  txid: CHILD_TXID, confirmations: 0, fees: "1510", vsize: 111, vin: [], vout: [],
};
const confirmedTx = { ...structuredClone(parentTx), txid: CONFIRMED_TXID, confirmations: 4 };
const dustyTx = {
  txid: DUSTY_TXID, confirmations: 0, fees: "1000", vsize: 140,
  vin: [{ n: 0, txid: PREV_TXID, vout: 0, sequence: 0xfffffffd, value: "110000", addresses: [FIX1.address] }],
  vout: [{ n: 0, value: "2000", spent: false, hex: FIX1.spkHex, addresses: [FIX1.address] }],
};

const fetchCalls = [];
async function stubFetch(url, opts = {}) {
  const u = String(url);
  fetchCalls.push({ url: u, method: opts.method || "GET" });
  const body = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });
  const fail = (s) => ({ ok: false, status: s, json: async () => ({}), text: async () => "nf" });
  if (u.includes("/api/sendtx")) return body({ result: CHILD_TXID });
  const m = u.match(/\/api\/v2\/tx\/([0-9a-f]{64})/);
  if (m) {
    const id = m[1];
    if (id === PARENT_TXID) return body(parentTx);
    if (id === PREV_TXID) return body(prevTx);
    if (id === CHILD_TXID) return body(childTx);
    if (id === CONFIRMED_TXID) return body(confirmedTx);
    if (id === DUSTY_TXID) return body(dustyTx);
    return fail(404);
  }
  return fail(404);
}

/* ---------- minimal DOM ---------- */
class ClassList {
  constructor() { this.s = new Set(); }
  add(...c) { c.forEach((x) => this.s.add(x)); }
  remove(...c) { c.forEach((x) => this.s.delete(x)); }
  toggle(c, f) { const on = f ?? !this.s.has(c); on ? this.s.add(c) : this.s.delete(c); return on; }
  contains(c) { return this.s.has(c); }
}
const registry = new Map();
class El {
  constructor(tag, id = "") {
    this.tagName = tag.toUpperCase(); this.id = id;
    this.classList = new ClassList(); this.dataset = {};
    this._value = ""; this._text = ""; this._html = "";
    this.hidden = false; this.disabled = false; this.checked = false;
    this.style = {}; this._handlers = {}; this._kids = []; this._attrs = {};
    this.type = ""; this.placeholder = ""; this.spellcheck = false;
    this._regKey = id || `__anon_${El._n++}`;
    registry.set(this._regKey, this);
  }
  static _n = 0;
  setAttribute(k, v) { this._attrs[k] = String(v); }
  getAttribute(k) { return this._attrs[k] ?? null; }
  addEventListener(t, fn) { (this._handlers[t] ||= []).push(fn); }
  click() { for (const fn of this._handlers.click || []) fn({ target: this, preventDefault() {} }); }
  change() { for (const fn of this._handlers.change || []) fn({ target: this }); }
  closest(sel) {
    if (sel === "button[data-tab]" && this.tagName === "BUTTON" && this.dataset.tab) return this;
    return null;
  }
  querySelector(sel) {
    const all = this.querySelectorAll(sel);
    return all[0] || null;
  }
  querySelectorAll(sel) {
    if (sel === ".verdict") return this._kids.filter((k) => k.classList.contains("verdict"));
    if (sel.startsWith("[data-rbf-wif")) {
      const out = [];
      for (const el of registry.values()) if (el.dataset.rbfWif !== undefined) out.push(el);
      return out;
    }
    return [];
  }
  appendChild(kid) { this._kids.push(kid); return kid; }
  insertAdjacentHTML(pos, s) { this._html += s; hydrate(this, s); }
  get value() {
    if (this.tagName === "SELECT") {
      if (this._value !== "") return this._value;
      const first = this._kids.find((k) => k.tagName === "OPTION");
      return first ? first._value : "";
    }
    return this._value;
  }
  set value(v) { this._value = String(v); }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
  get innerHTML() { return this._html; }
  set innerHTML(s) {
    // wipe this subtree from the registry (recursive)
    const drop = (el) => { registry.delete(el._regKey); el._kids.forEach(drop); };
    this._kids.forEach(drop);
    this._kids = [];
    this._html = String(s);
    hydrate(this, s);
  }
}
/** Register elements created by dynamic innerHTML: options, inputs with ids
 *  or data-rbf-wif, so getElementById/querySelector keep working. */
function hydrate(owner, s) {
  const re = /<(input|button|option|select|textarea|div)\b([^>]*)>/g;
  let m;
  while ((m = re.exec(s))) {
    const [, tag, attrs] = m;
    const idm = attrs.match(/\bid="([^"]*)"/);
    const dm = attrs.match(/\bdata-rbf-wif="([^"]*)"/);
    if (!idm && !dm) continue;
    const el = new El(tag, idm ? idm[1] : "");
    if (dm) { el.dataset.rbfWif = dm[1]; el._owner = owner; }
    const vm = attrs.match(/\bvalue="([^"]*)"/);
    if (vm && tag === "option") el._value = vm[1];
    if (/\bdisabled\b/.test(attrs)) el.disabled = true;
    owner._kids.push(el);
  }
}

const tabButtons = [];
const panels = [];
const document = {
  getElementById: (id) => registry.get(id) || null,
  createElement: (tag) => new El(tag),
  querySelector(sel) {
    if (sel === ".verdict") return null;
    const m = sel.match(/^\[data-rbf-wif="(\d+)"\]$/);
    if (m) {
      for (const el of registry.values()) if (el.dataset.rbfWif === m[1]) return el;
      return null;
    }
    return null;
  },
  querySelectorAll(sel) {
    if (sel === "#tabs button") return tabButtons;
    if (sel === "main .panel") return panels;
    if (sel === "[data-rbf-wif]") {
      const out = [];
      for (const el of registry.values()) if (el.dataset.rbfWif !== undefined) out.push(el);
      return out;
    }
    return [];
  },
};

/* Build the static DOM from index.html ids (+ data-tab buttons, which have no id) */
{
  const re = /<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*?)>/g;
  let m;
  while ((m = re.exec(html))) {
    const [, tag, attrs] = m;
    const idm = attrs.match(/\bid="([^"]+)"/);
    const dm = attrs.match(/\bdata-tab="([^"]*)"/);
    const id = idm ? idm[1] : "";
    if (!id && !dm) continue;
    if (id && registry.has(id)) continue;
    const el = new El(tag, id);
    const cm = attrs.match(/\bclass="([^"]*)"/);
    if (cm) cm[1].split(/\s+/).filter(Boolean).forEach((c) => el.classList.add(c));
    if (dm) { el.dataset.tab = dm[1]; tabButtons.push(el); }
    if (tag === "section" && el.classList.contains("panel")) panels.push(el);
    const tm = attrs.match(/\btype="([^"]*)"/);
    if (tm) el.type = tm[1];
  }
}

const sandbox = {
  console, TextEncoder, TextDecoder, crypto: webcrypto, fetch: stubFetch,
  setTimeout, clearTimeout, setInterval, clearInterval,
  URL, URLSearchParams,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.document = document;
sandbox.window.scrollTo = () => {};
sandbox.addEventListener = () => {};
vm.createContext(sandbox);
vm.runInContext(bundleSrc, sandbox, { filename: "pearl-boost.bundle.js" });
vm.runInContext(appSrc, sandbox, { filename: "app.js" });

const P = sandbox.window.PearlBoost;
const $ = (id) => document.getElementById(id);
const sleep = (ms = 25) => new Promise((r) => setTimeout(r, ms));
async function settle(n = 6) { for (let i = 0; i < n; i++) await sleep(); }
const has = (id, needle) => $(id).innerHTML.includes(needle);

/* ---------- tests ---------- */

test("bundle boots; footer attribution present", () => {
  assert.ok(P, "window.PearlBoost missing");
  assert.ok(P.Sign && P.Sign.buildKeypathTxEx, "Sign namespace missing");
  assert.match(html, /@kshot9000/);
  assert.ok(html.includes("prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d"));
});

test("tabs switch panels", () => {
  // the tab handler lives on the nav (bubbling); dispatch through it
  const clickTab = (name) => {
    const btn = tabButtons.find((b) => b.dataset.tab === name);
    for (const fn of $("tabs")._handlers.click || []) fn({ target: btn, preventDefault() {} });
  };
  clickTab("cpfp");
  assert.ok($("tab-cpfp").classList.contains("active"));
  assert.ok(!$("tab-diagnose").classList.contains("active"));
  clickTab("diagnose");
  assert.ok($("tab-diagnose").classList.contains("active"));
});

test("diagnose: unconfirmed RBF-signaled tx", async () => {
  $("dg-txid").value = PARENT_TXID;
  $("dg-go").click();
  await settle();
  assert.ok(has("dg-result", "BIP-125 SIGNALED"), "missing RBF badge");
  assert.ok(has("dg-result", "7.143"), "missing feerate 7.143");
  assert.ok(has("dg-result", "UNCONFIRMED"), "missing unconfirmed badge");
  assert.ok(has("dg-result", "0xfffffffd"), "missing sequence row");
});

test("cpfp: plan -> sign -> double-confirm broadcast -> key wipe", async () => {
  $("cp-output").value = "0";
  $("cp-wif").value = FIX1.wif;
  $("cp-target").value = "10";
  $("cp-plan").click();
  await settle();
  assert.ok(has("cp-planout", "1,510"), "child fee 1,510 missing: " + $("cp-planout").innerHTML.slice(0, 300));
  assert.ok(has("cp-planout", "10.000"), "package rate missing");
  assert.ok(has("cp-planout", "MATCH"), "key guard match missing");
  $("cp-sign").click();
  await settle();
  assert.ok(has("cp-signout", "ALL SIGNATURES RE-VERIFIED"), "re-verify badge missing");
  assert.ok(!$("cp-bcast").disabled, "broadcast should be enabled");
  const before = fetchCalls.length;
  $("cp-bcast").click(); // arm
  await settle();
  assert.ok($("cp-bcast").classList.contains("armed"), "not armed");
  assert.equal(fetchCalls.length, before, "broadcast fired on first click");
  $("cp-bcast").click(); // confirm
  await settle();
  const post = fetchCalls.find((c) => c.url.includes("/api/sendtx") && c.method === "POST");
  assert.ok(post, "no POST /api/sendtx");
  assert.ok(has("cp-bcastout", "broadcast accepted"), "acceptance missing");
  assert.equal($("cp-wif").value, "", "WIF not wiped after broadcast");
});

test("cpfp: wrong key -> loud KEY/ADDRESS MISMATCH refusal", async () => {
  $("dg-txid").value = PARENT_TXID;
  $("dg-go").click();
  await settle();
  $("cp-output").value = "0";
  $("cp-wif").value = FIX2.wif; // FIX2 does not own output #0
  $("cp-target").value = "10";
  $("cp-plan").click();
  await settle();
  assert.ok(has("cp-planout", "KEY/ADDRESS MISMATCH"), "mismatch refusal missing");
});

test("cpfp: confirmed parent -> loud refusal", async () => {
  $("dg-txid").value = CONFIRMED_TXID;
  $("dg-go").click();
  await settle();
  assert.ok(has("dg-result", "CONFIRMED"), "confirmed badge missing");
  $("cp-output").value = "0";
  $("cp-wif").value = FIX1.wif;
  $("cp-plan").click();
  await settle();
  assert.ok(has("cp-planout", "already CONFIRMED"), "confirmed refusal missing");
});

test("cpfp: dust child output -> loud refusal", async () => {
  $("dg-txid").value = DUSTY_TXID;
  $("dg-go").click();
  await settle();
  $("cp-output").value = "0";
  $("cp-wif").value = FIX1.wif;
  $("cp-target").value = "10";
  $("cp-plan").click();
  await settle();
  assert.ok(has("cp-planout", "dust"), "dust refusal missing");
});

test("rbf: non-signaling diagnosis refuses loudly", async () => {
  // craft a non-signaling variant via offline JSON
  const tx = JSON.parse(JSON.stringify(parentTx));
  tx.vin[0].sequence = 0xffffffff;
  tx.txid = "ff".repeat(32);
  $("dg-json").value = JSON.stringify(tx);
  $("dg-go-offline").click();
  await settle();
  assert.ok(has("rbf-planout", "does not signal BIP-125"), "RBF refusal missing");
});

test("rbf: plan -> sign -> broadcast", async () => {
  $("dg-txid").value = PARENT_TXID;
  $("dg-go").click();
  await settle();
  const wifEl = document.querySelector('[data-rbf-wif="0"]');
  assert.ok(wifEl, "RBF wif row missing");
  wifEl.value = FIX1.wif;
  $("rbf-feesrc").value = "1"; // trim output #1 (9000 grains)
  $("rbf-target").value = "10";
  $("rbf-plan").click();
  await settle(10);
  assert.ok(has("rbf-planout", "1,400"), "new fee 1,400 missing: " + $("rbf-planout").innerHTML.slice(0, 400));
  assert.ok(has("rbf-planout", "8,600"), "trimmed fee-source 8,600 missing");
  $("rbf-sign").click();
  await settle(10);
  assert.ok(has("rbf-signout", "ALL SIGNATURES RE-VERIFIED"), "rbf re-verify missing");
  $("rbf-bcast").click();
  await settle();
  assert.ok($("rbf-bcast").classList.contains("armed"));
  $("rbf-bcast").click();
  await settle();
  assert.ok(has("rbf-bcastout", "broadcast accepted"), "rbf acceptance missing");
});

test("track: polls and reports mempool state", async () => {
  $("tr-txid").value = PARENT_TXID;
  $("tr-go").click();
  await settle(10);
  assert.ok(has("tr-result", "still in mempool"), "track output missing");
  $("tr-stop").click();
  await settle();
});

test("verify: PROVEN and NOT PROVEN rulings", async () => {
  $("vf-parent").value = PARENT_TXID;
  $("vf-child").value = CHILD_TXID;
  $("vf-claimed").value = "10";
  $("vf-go").click();
  await settle(10);
  assert.ok(has("vf-result", "PROVEN"), "PROVEN missing");
  assert.ok(!$("vf-result").innerHTML.includes("NOT PROVEN"), "false NOT PROVEN");
  assert.ok(has("vf-result", "2510"), "derivation numerator missing");
  $("vf-claimed").value = "99";
  $("vf-go").click();
  await settle(10);
  assert.ok(has("vf-result", "NOT PROVEN"), "NOT PROVEN missing");
});

test("verify: unreachable backend -> loud refusal", async () => {
  const realFetch = sandbox.fetch;
  sandbox.fetch = async () => { throw new Error("boom"); };
  $("vf-parent").value = PARENT_TXID;
  $("vf-child").value = "";
  $("vf-claimed").value = "10";
  $("vf-go").click();
  await settle(10);
  assert.ok(has("vf-result", "backend unreachable"), "unreachable refusal missing");
  sandbox.fetch = realFetch;
});
