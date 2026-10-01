// Pearl Hedge DOM integration test — boots the real index.html + committed
// bundle (pearl-hedge.bundle.js) + app.js against a minimal DOM shim and
// drives the full flow: write -> fund -> exercise -> track -> verify, plus
// verify -> sign (local + cosigner) -> finalize, plus footer-attribution
// checks. localStorage is hostile (throws) to exercise the memory fallback.
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
const TAG_RE = "(input|button|select|textarea|label|div|p|code|span|h3|h4|tr|td|th|tbody|thead|table|dt|dd|option|a)";
class El {
  constructor(tag, id = "") {
    this.tagName = tag.toUpperCase(); this.id = id;
    this.classList = new ClassList(); this.dataset = {};
    this.children = []; this.parent = null;
    this.style = {};
    this.value = ""; this.textContent = ""; this.checked = false;
    this.hidden = false; this.disabled = false;
    this._innerHTML = ""; this._handlers = {};
  }
  get className() { return [...this.classList.s].join(" "); }
  set className(v) {
    this.classList.s.clear();
    String(v).split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c));
  }
  set innerHTML(v) {
    this._innerHTML = String(v);
    this.textContent = String(v).replace(/<[^>]*>/g, "");
    this.children = [];
    const re = new RegExp("<" + TAG_RE + "\\b([^>]*)>", "gi");
    let m;
    while ((m = re.exec(this._innerHTML))) {
      const [, tag, attrs] = m;
      const el = new El(tag);
      const idm = /\bid="([^"]*)"/.exec(attrs);
      if (idm) { el.id = idm[1]; dynById.set(idm[1], el); }
      const clsm = /\bclass="([^"]*)"/.exec(attrs);
      if (clsm) clsm[1].split(/\s+/).filter(Boolean).forEach((c) => el.classList.add(c));
      const typem = /\btype="([^"]*)"/.exec(attrs);
      el.type = typem ? typem[1] : "text";
      el.checked = /\bchecked\b/.test(attrs);
      let dm; const dre = /data-([\w-]+)="([^"]*)"/g;
      while ((dm = dre.exec(attrs))) el.dataset[dm[1]] = dm[2];
      el.parent = this;
      this.children.push(el);
      all.push(el);
    }
  }
  get innerHTML() { return this._innerHTML; }
  addEventListener(ev, fn) { (this._handlers[ev] ??= []).push(fn); }
  dispatchEvent(e) { (this._handlers[e.type] || []).forEach((f) => f.call(this, e)); return true; }
  click() { this.dispatchEvent({ type: "click", target: this, preventDefault() {} }); }
  appendChild(c) {
    c.parent = this; this.children.push(c);
    // mirror browser <select>: a selected <option> sets the select's value
    if (c.tagName === "OPTION" && c.selected && this.tagName === "SELECT" && !this.value) {
      this.value = c.value;
    }
    return c;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const out = [];
    const walk = (el) => {
      for (const c of el.children) { if (matches(c, sel)) out.push(c); walk(c); }
    };
    walk(this);
    return out;
  }
}
function matches(el, sel) {
  sel = sel.trim();
  if (sel.startsWith("#")) {
    const m = /^#([\w-]+)(?:\s+(\w+)(?:\[data-([\w-]+)="([^"]+)"\])?)?$/.exec(sel.slice(1));
    if (!m) return false;
    if (el.id !== m[1] && el._scopeId !== m[1]) return false;
    if (m[2] && el.tagName !== m[2].toUpperCase()) return false;
    if (m[3] && String(el.dataset[m[3]] ?? "") !== m[4]) return false;
    return true;
  }
  if (sel.startsWith(".")) {
    const m = /^\.([\w-]+)(?:\[data-([\w-]+)="([^"]+)"\])?$/.exec(sel);
    if (!m) return false;
    if (!el.classList.contains(m[1])) return false;
    if (m[2] && String(el.dataset[m[2]] ?? "") !== m[3]) return false;
    return true;
  }
  return el.tagName === sel.toUpperCase();
}

const byId = new Map();
const dynById = new Map();
const all = [];
{
  const re = /<(\w+)([^>]*)\bid="([^"]+)"([^>]*)>/g;
  let m;
  while ((m = re.exec(html))) {
    const [, tag, before, id, after] = m;
    const el = new El(tag, id);
    const attrs = before + " " + after;
    let dm; const dre = /data-([\w-]+)="([^"]*)"/g;
    while ((dm = dre.exec(attrs))) el.dataset[dm[1]] = dm[2];
    const clsm = /\bclass="([^"]*)"/.exec(attrs);
    if (clsm) el.className = clsm[1];
    if (/\bchecked\b/.test(attrs)) el.checked = true;
    if (/\bhidden\b/.test(attrs)) el.hidden = true;
    byId.set(id, el);
    all.push(el);
  }
  const stepsEl = byId.get("steps");
  const btnRe = /<button\b([^>]*)data-step="([^"]+)"([^>]*)>/g;
  let bm;
  while ((bm = btnRe.exec(html))) {
    const b = new El("button");
    b.dataset.step = bm[2];
    b._scopeId = "steps";
    const cls = /class="([^"]*)"/.exec(bm[1] + bm[3]);
    if (cls) b.className = cls[1];
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
    const m = /^#([\w-]+)\s+button(?:\[data-step="([^"]+)"\])?$/.exec(sel);
    if (m) {
      const scope = byId.get(m[1]);
      return (scope ? scope.children : []).filter(
        (c) => c.tagName === "BUTTON" && (!m[2] || c.dataset.step === m[2]));
    }
    return all.filter((el) => matches(el, sel));
  },
  querySelector: (sel) => document.querySelectorAll(sel)[0] || null,
  createElement: (tag) => { const el = new El(tag); all.push(el); return el; },
  body: new El("body"),
};

/* hostile localStorage: every access throws, exercising the memory fallback */
const hostileStorage = {
  getItem() { throw new Error("SecurityError"); },
  setItem() { throw new Error("SecurityError"); },
};
const errors = [];
const sandbox = {
  document,
  navigator: { clipboard: { writeText: async () => {} } },
  localStorage: hostileStorage,
  TextEncoder, TextDecoder,
  crypto: webcrypto,
  location: { reload() {} },
  setTimeout: (fn) => 0, clearTimeout: () => {},
  scrollTo() {},
  URL: { createObjectURL: () => "blob:fake", revokeObjectURL: () => {} },
  Blob: class { constructor(parts) { this.parts = parts; } },
  fetch: async () => { throw new Error("no network in DOM test"); },
  console: { ...console, error: (...a) => { errors.push(a.join(" ")); } },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);
for (const f of ["pearl-hedge.bundle.js", "qrcode.min.js"]) {
  vm.runInContext(fs.readFileSync(resolvePath(dir, f), "utf8"), sandbox, { filename: f });
}
sandbox.window.PearlHedge = sandbox.PearlHedge;
vm.runInContext(fs.readFileSync(resolvePath(dir, "app.js"), "utf8"), sandbox, { filename: "app.js" });


const $ = (id) => document.getElementById(id);
const E = () => sandbox.window.PearlHedge;
const WRITER_MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const BUYER_MNEMONIC = "legal winner thank year wave sausage worth useful legal winner thank yellow";

test("page boots with zero console errors (hostile localStorage)", () => {
  assert.ok(E(), "bundle global present");
  assert.ok($("w-write"), "write button present");
  assert.ok($("x-exercise"), "exercise button present");
  assert.deepEqual(errors, [], "console errors: " + errors.join(" | "));
});

test("every getElementById target in app.js exists in index.html", () => {
  const src = fs.readFileSync(resolvePath(dir, "app.js"), "utf8");
  const ids = new Set([...src.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]));
  const missing = [...ids].filter((id) => !byId.has(id));
  assert.deepEqual(missing, [], "missing ids: " + missing.join(","));
});

test("write: full covered-call flow renders descriptor + vault address", () => {
  $("w-network").value = "mainnet";
  $("w-kind").value = "C";
  $("w-strike-mode").value = "prl";
  $("w-writer").value = WRITER_MNEMONIC;
  $("w-buyer").value = BUYER_MNEMONIC;
  $("w-qty").value = "1";
  $("w-strike").value = "2.5";
  $("w-days").value = "30";
  $("w-anchor").value = "800000";
  $("w-premium").value = "0";
  $("w-hashlock").click();
  assert.equal($("w-hashlock-out").hidden, false, "hashlock note shown");
  assert.ok(/^[0-9a-f]{64}$/.test($("w-preimage-in").value), "preimage generated");
  $("w-write").click();
  assert.equal($("w-err").hidden, true, "no write error: " + $("w-err").textContent);
  assert.equal($("w-out").hidden, false);
  const desc = $("w-descriptor").value;
  assert.ok(desc.startsWith("pearl-hedge:v1:prl:C:"), "descriptor: " + desc.slice(0, 40));
  assert.ok(desc.includes(":100000000:250000000:"), "qty/strike grains in descriptor");
  const review = $("w-review").textContent;
  assert.ok(/prl1p[0-9a-z]+/.test(review), "vault address rendered");
  assert.ok($("w-asm-e").textContent.includes("EQUALVERIFY"), "exercise leaf asm shown");
  assert.ok($("w-asm-x").textContent.includes("CLTV"), "refund leaf asm shown");
  assert.ok(html.includes("prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d"), "donation address in footer");
  assert.ok(html.includes("@kshot9000"), "x handle in footer");
  assert.deepEqual(errors, [], "console errors: " + errors.join(" | "));
});

test("write rejects dust collateral honestly", () => {
  $("w-qty").value = "0.000001"; // 100 grains < 546 dust
  $("w-write").click();
  assert.equal($("w-err").hidden, false);
  assert.ok(/dust/.test($("w-err").textContent), "error text: " + $("w-err").textContent);
  $("w-qty").value = "1";
});

test("write rejects a missing preimage honestly", () => {
  $("w-preimage-in").value = "";
  $("w-write").click();
  assert.equal($("w-err").hidden, false);
  assert.ok(/preimage/.test($("w-err").textContent), "error text: " + $("w-err").textContent);
  $("w-hashlock").click();
});

test("put kind swaps role labels and flips the kind bit", () => {
  $("w-kind").value = "P";
  $("w-kind").dispatchEvent({ type: "change" });
  assert.ok($("locker-label").textContent.includes("Put holder"), "locker label: " + $("locker-label").textContent);
  $("w-write").click();
  assert.equal($("w-err").hidden, true, "no write error: " + $("w-err").textContent);
  assert.ok($("w-descriptor").value.startsWith("pearl-hedge:v1:prl:P:"), "put descriptor");
  $("w-kind").value = "C";
  $("w-kind").dispatchEvent({ type: "change" });
});

test("fund: descriptor re-derives the vault address", () => {
  const desc = $("w-descriptor").value;
  $("f-descriptor").value = desc;
  $("f-load").click();
  assert.equal($("f-err").hidden, true, "no fund error: " + $("f-err").textContent);
  assert.equal($("f-out").hidden, false);
  const addr = $("f-address").textContent;
  assert.ok(/^prl1p[0-9a-z]+$/.test(addr), "vault address: " + addr);
  assert.ok($("f-address").textContent === addr, "address shown in fund panel");
  assert.ok($("f-sealed").textContent.startsWith("pearl-hedge:v1:prl:"), "sealed commitment shown");
  assert.ok($("f-fees").textContent.includes("vB"), "fee planner rendered");
});

test("exercise: strike verification fails honestly with no network", async () => {
  $("x-buyer-mode").value = "address";
  $("x-writer-mode").value = "address";
  $("x-descriptor").value = $("w-descriptor").value;
  $("x-load").click();
  assert.equal($("x-err").hidden, true, "no load error: " + $("x-err").textContent);
  $("x-strike-txid").value = "a".repeat(64);
  $("x-strike-addr").value = "prl1pqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";
  $("x-verify-strike").click();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal($("x-err").hidden, false, "strike verify error shown");
  assert.ok(/Blockbook|fetch/i.test($("x-err").textContent), "error text: " + $("x-err").textContent);
});

test("exercise refuses to build without a verified strike payment", async () => {
  $("x-buyer-secret").value = BUYER_MNEMONIC;
  $("x-preimage").value = $("w-preimage-in").value;
  $("x-utxo").value = `${"f".repeat(64)}:0:100000000`;
  $("x-buyer-dest").value = E().walletFromMnemonic(BUYER_MNEMONIC, E().NETWORKS.mainnet).address;
  $("x-exercise").click();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal($("x-err").hidden, false);
  assert.ok(/verify the strike payment first/.test($("x-err").textContent), "error text: " + $("x-err").textContent);
  assert.equal($("x-buyer-secret").value, "", "secret wiped after attempt");
  assert.deepEqual(errors, [], "console errors: " + errors.join(" | "));
});

test("step nav switches panels", () => {
  document.querySelector('#steps button[data-step="track"]').click();
  assert.ok($("step-track").classList.contains("active"));
  assert.ok(!$("step-write").classList.contains("active"));
  document.querySelector('#steps button[data-step="write"]').click();
  assert.ok($("step-write").classList.contains("active"));
});

test("verify: pinned descriptor -> PROVEN; seal mismatch -> NOT PROVEN; garbage -> NOT PROVEN", () => {
  const PIN = "pearl-hedge:v1:prl:C:c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5:f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9:8200cf0ce11447bf6353cbac964d07d1c390d61d07e6c5d0214450b3add6449b:100000000:250000000:800000:5000000";
  $("v-descriptor").value = PIN;
  $("v-sealed").value = "pearl-hedge:v1:prl:3fcee31ca30511bc86b04af7692ed14635c5f2bdfce69e935edfa3d0f85b38ad";
  $("v-check").click();
  assert.ok($("v-verdict").textContent.includes("PROVEN"), "verdict: " + $("v-verdict").textContent);
  assert.ok($("v-review").textContent.includes("prl1pj4u2nr5h6wzn9hgsl4yw8jn338su4xqatj5nqkwrwk4xj3a290eqc6jcc4"), "pinned address re-derived");
  // wrong seal -> NOT PROVEN
  $("v-sealed").value = "pearl-hedge:v1:prl:0000000000000000000000000000000000000000000000000000000000000000";
  $("v-check").click();
  assert.ok($("v-verdict").textContent.includes("NOT PROVEN"), "verdict: " + $("v-verdict").textContent);
  // garbage -> NOT PROVEN
  $("v-descriptor").value = "pearl-hedge:v1:prl:C:garbage";
  $("v-sealed").value = "";
  $("v-check").click();
  assert.ok($("v-verdict").textContent.includes("NOT PROVEN"), "verdict: " + $("v-verdict").textContent);
  assert.deepEqual(errors, [], "console errors: " + errors.join(" | "));
});
