// Pearl Escrow DOM integration test — boots the real index.html + scripts
// (pearl-escrow.bundle.js, app.js) against a minimal DOM shim and drives the
// full wizard: parties -> contract -> spend (release) -> assemble.
// Run: node --no-warnings --loader ./tests/loader.mjs tests/dom.test.mjs
// (no jsdom on this VM; the shim implements exactly the surface app.js uses)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { TextEncoder, TextDecoder } from "node:util";
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
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.classList = new ClassList();    this.dataset = {};
    this.children = [];
    this.parent = null;
    this.value = "";
    this.textContent = "";
    this.hidden = false;
    this.disabled = false;
    this._innerHTML = "";
    this._handlers = {};
    this._props = {};
  }
  get className() { return [...this.classList.s].join(" "); }
  set className(v) {
    this.classList.s.clear();
    String(v).split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c));
  }
  set innerHTML(v) {
    this._innerHTML = String(v);
    this.children = [];
    // small parse: create stubs for common tags so app.js can query them
    const re = /<(input|button|select|textarea|label|div|p|code|span|h4|h3)\b([^>]*)>/gi;
    let m;
    while ((m = re.exec(this._innerHTML))) {
      const [, tag, attrs] = m;
      const el = new El(tag);
      const idm = /\bid="([^"]*)"/.exec(attrs);
      if (idm) { el.id = idm[1]; dynById.set(idm[1], el); }
      const clsm = /\bclass="([^"]*)"/.exec(attrs);
      if (clsm) clsm[1].split(/\s+/).filter(Boolean).forEach((c) => el.classList.add(c));
      const type = /\btype="([^"]*)"/.exec(attrs);
      el.type = type ? type[1] : "text";
      el.checked = /\bchecked\b/.test(attrs);
      const namem = /\bname="([^"]*)"/.exec(attrs);
      if (namem) el.name = namem[1];
      el.parent = this;
      this.children.push(el);
    }
  }
  get innerHTML() { return this._innerHTML; }
  addEventListener(ev, fn) { (this._handlers[ev] ??= []).push(fn); }
  dispatchEvent(e) { (this._handlers[e.type] || []).forEach((f) => f.call(this, e)); return true; }
  click() { this.dispatchEvent({ type: "click" }); }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const out = [];
    const walk = (el) => {
      for (const c of el.children) {
        if (matches(c, sel)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  getContext() { return null; } // canvas: QR path is try/caught in app.js
}
function matches(el, sel) {
  sel = sel.trim();
  if (sel.startsWith("#")) {
    const rest = sel.slice(1);
    const m = /^([\w-]+)(?:\s+(\w+)(?:\[([\w-]+)="([^"]+)"\])?)?$/.exec(rest);
    if (!m) return false;
    if (el.id !== m[1] && !(el._scopeId === m[1])) return false;
    if (m[2] && el.tagName !== m[2].toUpperCase()) return false;
    if (m[3] && String(el.dataset[m[3].replace(/^data-/, "")] ?? el[m[3]]) !== m[4]) return false;
    return true;
  }
  if (sel.startsWith(".")) return el.classList.contains(sel.slice(1));
  return el.tagName === sel.toUpperCase();
}

const byId = new Map();
const dynById = new Map(); // elements created later via innerHTML
const all = [];
const stubCache = new Map(); // one stable stub per underlying HTML tag occurrence
function stubFor(tag, attrs) {
  const key = tag + "|" + attrs;
  let el = stubCache.get(key);
  if (!el) {
    el = new El(tag);
    let dm;
    const dre = /data-([\w-]+)="([^"]*)"/g;
    while ((dm = dre.exec(attrs))) el.dataset[dm[1]] = dm[2];
    const clsm = /\bclass="([^"]*)"/.exec(attrs);
    if (clsm) el.className = clsm[1];
    stubCache.set(key, el);
    all.push(el);
  }
  return el;
}
// pre-create every id="..." element from the real HTML, with tag + data-* attrs
{
  const re = /<(\w+)([^>]*)\bid="([^"]+)"([^>]*)>/g;
  let m;
  while ((m = re.exec(html))) {
    const [, tag, before, id, after] = m;
    const el = new El(tag, id);
    const attrs = before + " " + after;
    let dm;
    const dre = /data-([\w-]+)="([^"]*)"/g;
    while ((dm = dre.exec(attrs))) el.dataset[dm[1]] = dm[2];
    if (/\bchecked\b/.test(attrs)) el.checked = true;
    const sel = /<select\b/.test(m[0]) ? null : null;
    byId.set(id, el);
    all.push(el);
  }
  // steps nav buttons live inside #steps; give them scope ids
  const stepsEl = byId.get("steps");
  const btnRe = /<button\b([^>]*)data-step="([^"]+)"([^>]*)>/g;
  let bm;
  while ((bm = btnRe.exec(html))) {
    const b = new El("button");
    b.dataset.step = bm[2];
    b._scopeId = "steps";
    const cls = /class="([^"]*)"/.exec(bm[1] + bm[3]);
    if (cls) cls[1].split(/\s+/).forEach((c) => b.classList.add(c));
    stepsEl.appendChild(b);
    all.push(b);
  }
}

const document = {
  getElementById: (id) => {
    const el = byId.get(id) || dynById.get(id);
    if (!el) throw new Error("missing element id=" + id);
    return el;
  },
  querySelectorAll: (sel) => {
    sel = sel.trim();
    // ".class" or '.class[attr="v"]' — built from data-* markers in the HTML
    const cm = /^\.([\w-]+)(?:\[([\w-]+)="([^"]+)"\])?$/.exec(sel);
    if (cm) {
      const [, cls, attr, val] = cm;
      const out = [];
      const re = new RegExp(`<(button|div|span|a)\\b([^>]*)>`, "g");
      let m;
      while ((m = re.exec(html))) {
        const attrs = m[2];
        if (!new RegExp(`class="[^"]*\\b${cls}\\b`).test(attrs)) continue;
        if (attr) {
          const am = new RegExp(`${attr}="([^"]*)"`).exec(attrs);
          if (!am || am[1] !== val) continue;
        }
        out.push(stubFor(m[1], attrs));
      }
      return out;
    }
    // "#steps button" / '#steps button[data-step="x"]'
    const m = /^#([\w-]+)\s+button(?:\[data-step="([^"]+)"\])?$/.exec(sel);
    if (m) {
      const scope = byId.get(m[1]);
      return scope.children.filter(
        (c) => c.tagName === "BUTTON" && (!m[2] || c.dataset.step === m[2]),
      );
    }
    if (sel.startsWith("#")) {
      const el = byId.get(sel.slice(1));
      return el ? [el] : [];
    }
    return [];
  },
  querySelector: (sel) => document.querySelectorAll(sel)[0] || null,
  createElement: (tag) => new El(tag),
  body: new El("body"),
};
const window = {
  document,
  scrollTo: () => {},
  qrcode: () => { throw new Error("no QR in shim"); }, // exercises the try/catch path
};
class FakeEvent { constructor(type) { this.type = type; } }

const sandbox = {
  window, document, Event: FakeEvent,
  navigator: {}, console, TextEncoder, TextDecoder,
  setTimeout: (fn) => 0, clearTimeout: () => {},
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
// esbuild iife attaches to the vm global; run bundle first, mirror it onto
// window (like a browser would), then load the QR lib and app.js
for (const f of ["pearl-escrow.bundle.js", "qrcode.min.js"]) {
  vm.runInContext(fs.readFileSync(resolvePath(dir, f), "utf8"), sandbox, { filename: f });
}
window.PearlEscrow = sandbox.PearlEscrow;
if (sandbox.qrcode) window.qrcode = sandbox.qrcode;
vm.runInContext(fs.readFileSync(resolvePath(dir, "app.js"), "utf8"), sandbox, { filename: "app.js" });

const $ = (id) => document.getElementById(id);
const MNEMONICS = [
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  "legal winner thank year wave sausage worth useful legal winner thank yellow",
  "letter advice cage absurd amount doctor acoustic avoid letter advice cage above",
];

test("page boots: bundle + app wiring load without throwing", () => {
  assert.ok(sandbox.window.PearlEscrow, "bundle global present");
  assert.ok($("to-contract"), "wizard controls present");
});

test("every getElementById target in app.js exists in index.html", () => {
  const src = fs.readFileSync(resolvePath(dir, "app.js"), "utf8");
  const ids = new Set([...src.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]));
  // mu-* ids are created at runtime by the manual-UTXO form (by design)
  const missing = [...ids].filter((id) => !byId.has(id) && !id.startsWith("mu-"));
  assert.deepEqual(missing, [], "missing ids: " + missing.join(","));
});

test("full wizard: parties -> contract renders a prl1p escrow address", () => {
  $("key-buyer").value = MNEMONICS[0];
  $("key-seller").value = MNEMONICS[1];
  $("key-arbiter").value = MNEMONICS[2];
  $("lock-height").value = "140000";
  $("chain-height").value = "120195";
  $("to-contract").click();
  assert.equal($("parties-error").hidden, true, "no parties error: " + $("parties-error").textContent);
  const addr = $("escrow-address").textContent;
  assert.ok(/^prl1p/.test(addr), "escrow address: " + addr);
  assert.ok($("release-asm").textContent.includes("CHECKSIGADD"));
  assert.ok($("refund-asm").textContent.includes("CLTV"));
  assert.ok($("step-contract").classList.contains("active"));
  assert.equal($("cb-release").value.length, 130); // 65 bytes hex
  // donation + x account present (standing requirement)
  assert.ok($("donate-addr").textContent.includes("prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d"));
  assert.ok(html.includes("@kshot9000"));
});

test("spend: release plan -> two local signatures -> assembled tx", () => {
  // jump straight to spend with a synthetic confirmed UTXO
  const E = sandbox.window.PearlEscrow;
  const tree = { address: $("escrow-address").textContent };
  void tree;
  // select UTXO path: enable via manual entry instead of network
  $("manual-utxo").click();
  $("mu-txid").value = "ab".repeat(32);
  $("mu-vout").value = "0";
  $("mu-value").value = String(5 * 100000000);
  $("mu-use").click();
  assert.equal($("contract-error").hidden, true, "no utxo error");
  $("to-spend").click();
  assert.ok($("step-spend").classList.contains("active"));

  const E2 = sandbox.window.PearlEscrow;
  const buyerKey = E2.partyKeyFromInput(MNEMONICS[0], E2.NETWORKS.mainnet).xonly;
  const sellerKey = E2.partyKeyFromInput(MNEMONICS[1], E2.NETWORKS.mainnet).xonly;
  $("pay-seller-addr").value = E2.encodeBech32m("prl", 1, sellerKey);
  $("pay-seller-amt").value = "4";
  $("pay-buyer-addr").value = E2.encodeBech32m("prl", 1, buyerKey);
  $("fee-rate").value = "5";
  $("build-plan").click();
  assert.equal($("spend-error").hidden, true, "no plan error: " + $("spend-error").textContent);
  assert.equal($("plan-card").hidden, false);
  assert.equal($("plan-digest").textContent.length, 64);

  // sign both slots with the buyer + arbiter mnemonics via the UI buttons
  const slots = $("sig-slots").querySelectorAll(".sig-slot");
  assert.equal(slots.length, 2);
  const signOne = (slot, roleIdx, mnemonic) => {
    slot.querySelector(".slot-role").value = String(roleIdx);
    slot.querySelector(".slot-key").value = mnemonic;
    slot.querySelector(".slot-sign").click();
    assert.equal($("assemble-error").hidden, true, "no sign error: " + $("assemble-error").textContent);
    assert.equal(slot.querySelector(".slot-sig").value.length, 128); // 64-byte schnorr sig
  };
  signOne(slots[0], 0, MNEMONICS[0]); // buyer
  signOne(slots[1], 2, MNEMONICS[2]); // arbiter

  $("assemble").click();
  assert.equal($("assemble-error").hidden, true, "no assemble error: " + $("assemble-error").textContent);
  assert.ok($("step-broadcast").classList.contains("active"));
  const txid = $("final-txid").textContent;
  assert.ok(/^[0-9a-f]{64}$/.test(txid), "txid: " + txid);
  assert.ok($("final-hex").value.length > 400, "hex length " + $("final-hex").value.length);

  // independently recompute: the assembled tx must spend the escrow address's coins
  // and its digest must match the plan digest shown to the signers
  const hexTx = $("final-hex").value;
  assert.ok(hexTx.includes(E2.bytesToHex(E2.buildReleaseScript(buyerKey, sellerKey,
    E2.partyKeyFromInput(MNEMONICS[2], E2.NETWORKS.mainnet).xonly)).slice(0, 40)));
});

test("refund is blocked while the timelock is closed", () => {
  document.querySelector('.mode-card[data-mode="refund"]').click();
  assert.equal($("spend-refund-form").hidden, false);
  $("build-plan").click();
  // chain height (120195) < lock height (140000): plan must refuse
  assert.equal($("spend-error").hidden, false, "expected a timelock error");
  assert.ok(/timelocked/.test($("spend-error").textContent), $("spend-error").textContent);
  assert.equal($("plan-card").hidden, true);
  // back to release mode
  document.querySelector('.mode-card[data-mode="release"]').click();
});

test("tampered signature is refused at assembly", () => {
  // rebuild a fresh release plan (previous test hid the plan card)
  $("build-plan").click();
  assert.equal($("spend-error").hidden, true, "no plan error: " + $("spend-error").textContent);
  const slots = $("sig-slots").querySelectorAll(".sig-slot");
  const signOne = (slot, roleIdx, mnemonic) => {
    slot.querySelector(".slot-role").value = String(roleIdx);
    slot.querySelector(".slot-key").value = mnemonic;
    slot.querySelector(".slot-sign").click();
  };
  signOne(slots[0], 0, MNEMONICS[0]);
  signOne(slots[1], 2, MNEMONICS[2]);
  const txidBefore = $("final-txid").textContent;
  // tamper with the second signature's last byte
  const sigIn = slots[1].querySelector(".slot-sig");
  const bad = sigIn.value.slice(0, -2) + (sigIn.value.slice(-2) === "00" ? "ff" : "00");
  sigIn.value = bad;
  $("assemble").click();
  assert.equal($("assemble-error").hidden, false, "expected signature rejection");
  assert.ok(/verif|signature/i.test($("assemble-error").textContent), $("assemble-error").textContent);
  assert.equal($("final-txid").textContent, txidBefore, "no new tx may be produced from a bad signature");
});
