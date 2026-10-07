// Pearl Policy DOM integration test — boots the real index.html + committed
// bundle (pearl-policy.bundle.js) + app.js against a minimal DOM shim and
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
for (const f of ["pearl-policy.bundle.js", "qrcode.min.js"]) {
  vm.runInContext(fs.readFileSync(resolvePath(dir, f), "utf8"), sandbox, { filename: f });
}
sandbox.window.PearlPolicy = sandbox.PearlPolicy;
vm.runInContext(fs.readFileSync(resolvePath(dir, "app.js"), "utf8"), sandbox, { filename: "app.js" });



const $ = (id) => document.getElementById(id);
const E = () => sandbox.window.PearlPolicy;
const K1 = "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
const K2 = "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9";
const K3 = "8200cf0ce11447bf6353cbac964d07d1c390d61d07e6c5d0214450b3add6449b";
const PIN_DESCRIPTOR =
  "pearl-policy:v1:prl:nums:" +
  "k:" + K1 + ";" +
  "t:900000:" + K2 + ";" +
  "m:2of3:" + K3 + ":" + K1 + ":" + K2;
const PIN_ADDRESS = "prl1p80pyvs0jh82hdl3zf7zq3gcvmlfv2qutfm9yhszam2nd44c8qsysnfqxjm";
const PIN_SEALED = "pearl-policy:v1:prl:c72f8c4927a9d8a5d3bf1413176ac98c5678e80ea84d49601eea130b9dae2f07";

const leafKey = (i) => document.getElementById("leaf-" + i + "-key");
const leafKindSel = (i) => document.getElementById("leaf-" + i + "-kind");
function setKind(i, kind) {
  leafKindSel(i).value = kind;
  leafKindSel(i).dispatchEvent({ type: "change" });
}

test("page boots with zero console errors (hostile localStorage)", () => {
  assert.ok(E(), "bundle global present");
  assert.ok($("d-draft"), "draft button present");
  assert.ok($("v-check"), "verify button present");
  assert.deepEqual(errors, [], "console errors: " + errors.join(" | "));
});

test("every getElementById target in app.js exists in index.html", () => {
  const src = fs.readFileSync(resolvePath(dir, "app.js"), "utf8");
  const ids = new Set([...src.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]));
  const missing = [...ids].filter((id) => !byId.has(id));
  assert.deepEqual(missing, [], "missing ids: " + missing.join(","));
});

test("design: draft the pinned 3-leaf NUMS blueprint", () => {
  $("d-network").value = "mainnet";
  // leaf 1: keylock K1 (default)
  leafKey(0).value = K1;
  // leaf 2: timelock
  $("d-add-leaf").click();
  setKind(1, "timelock");
  leafKey(1).value = K2;
  document.getElementById("leaf-1-height").value = "900000";
  // leaf 3: multisig 2-of-3
  $("d-add-leaf").click();
  setKind(2, "multisig");
  document.getElementById("leaf-2-m").value = "2";
  document.getElementById("leaf-2-keys").value = [K3, K1, K2].join("\n");
  assert.equal($("d-leaf-count").textContent, "(3 of 8)");
  $("d-draft").click();
  assert.equal($("d-err").hidden, true, "no draft error: " + $("d-err").textContent);
  assert.equal($("d-out").hidden, false);
  assert.equal($("d-descriptor").value, PIN_DESCRIPTOR);
  const review = $("d-review").textContent;
  assert.ok(review.includes(PIN_ADDRESS), "address rendered: " + review.slice(0, 80));
  assert.ok(review.includes("NUMS"), "NUMS internal key labeled");
  assert.ok($("d-tree").innerHTML.includes("<svg"), "tree SVG rendered");
  const detail = $("d-leaf-detail").textContent;
  assert.ok(detail.includes("control block verified"), "control blocks verified");
  assert.ok(detail.includes("CHECKSIG"), "leaf asm rendered");
  assert.deepEqual(errors, [], "console errors: " + errors.join(" | "));
});

test("design: empty leaf key is refused honestly", () => {
  leafKey(0).value = "";
  $("d-draft").click();
  assert.equal($("d-err").hidden, false);
  assert.ok(/key/i.test($("d-err").textContent), "error text: " + $("d-err").textContent);
  leafKey(0).value = K1;
  $("d-draft").click();
  assert.equal($("d-err").hidden, true);
});

test("expert mode: custom leaf shows loud warning and drafts", () => {
  setKind(0, "custom");
  const card = document.getElementById("leaf-0-card");
  assert.equal(document.getElementById("leaf-0-warn").hidden, false, "expert warning visible");
  assert.ok(card.classList.contains("expert"), "expert styling applied");
  document.getElementById("leaf-0-hex").value = "51ac";
  $("d-draft").click();
  assert.equal($("d-err").hidden, true, "no draft error: " + $("d-err").textContent);
  assert.ok($("d-descriptor").value.startsWith("pearl-policy:v1:prl:nums:x:51ac;"), "custom descriptor: " + $("d-descriptor").value.slice(0, 60));
  // switch back for later tests
  setKind(0, "keylock");
  leafKey(0).value = K1;
  $("d-draft").click();
  assert.equal($("d-descriptor").value, PIN_DESCRIPTOR);
  assert.deepEqual(errors, [], "console errors: " + errors.join(" | "));
});

test("address tab: re-verify all control blocks", () => {
  document.querySelector('#steps button[data-step="address"]').click();
  assert.ok($("step-address").classList.contains("active"));
  assert.equal($("a-addr").textContent, PIN_ADDRESS);
  $("a-reverify").click();
  assert.equal($("a-reverify-out").hidden, false);
  assert.ok(/re-verified/.test($("a-reverify-out").textContent), "reverify text: " + $("a-reverify-out").textContent);
  assert.deepEqual(errors, [], "console errors: " + errors.join(" | "));
});

test("verify: pinned descriptor -> PROVEN; wrong address -> NOT PROVEN; garbage -> NOT PROVEN", () => {
  document.querySelector('#steps button[data-step="verify"]').click();
  $("v-descriptor").value = PIN_DESCRIPTOR;
  $("v-address").value = PIN_ADDRESS;
  $("v-sealed").value = PIN_SEALED;
  $("v-check").click();
  assert.equal($("v-out").hidden, false);
  assert.ok($("v-verdict").textContent.includes("PROVEN"), "verdict: " + $("v-verdict").textContent);
  assert.ok($("v-verdict").classList.contains("proven"));
  // wrong address -> NOT PROVEN (a valid address for a different tree)
  const other = E().forgePolicy({ network: E().NETWORKS.mainnet, internalSource: { mode: "nums" }, leafInputs: [{ kind: "keylock", xonly: K3 }] });
  $("v-address").value = other.address;
  $("v-sealed").value = "";
  $("v-check").click();
  assert.ok($("v-verdict").textContent.includes("NOT PROVEN"), "verdict: " + $("v-verdict").textContent);
  assert.ok($("v-verdict").classList.contains("notproven"));
  assert.ok(/mismatch/i.test($("v-verdict").textContent), "loud mismatch reason");
  // garbage -> NOT PROVEN
  $("v-descriptor").value = "pearl-policy:v1:prl:nums:k:garbage";
  $("v-check").click();
  assert.ok($("v-verdict").textContent.includes("NOT PROVEN"), "verdict: " + $("v-verdict").textContent);
  assert.deepEqual(errors, [], "console errors: " + errors.join(" | "));
});

test("export: json, markdown, share URL carry the blueprint", () => {
  document.querySelector('#steps button[data-step="export"]').click();
  assert.equal($("x-out").hidden, false);
  const j = JSON.parse($("x-json").value);
  assert.equal(j.descriptor, PIN_DESCRIPTOR);
  assert.equal(j.address, PIN_ADDRESS);
  assert.equal(j.leaves.length, 3);
  assert.ok($("x-md").value.includes(PIN_ADDRESS) && $("x-md").value.includes("## Honest limits"));
  assert.ok($("x-share").value.startsWith("https://kshot3000.github.io/Oysters4All/pages/policy/#p="),
    "share url: " + $("x-share").value.slice(0, 80));
  assert.ok($("x-share").value.includes(encodeURIComponent(PIN_DESCRIPTOR).slice(0, 40)));
  assert.deepEqual(errors, [], "console errors: " + errors.join(" | "));
});

test("remove leaf shrinks the tree; add is capped at 8", () => {
  document.querySelector('#steps button[data-step="design"]').click();
  // remove the multisig leaf (index 2)
  document.getElementById("leaf-2-remove").click();
  assert.equal($("d-leaf-count").textContent, "(2 of 8)");
  leafKey(0).value = K1;
  setKind(1, "timelock");
  leafKey(1).value = K2;
  $("d-draft").click();
  assert.equal($("d-err").hidden, true, "no draft error: " + $("d-err").textContent);
  assert.ok($("d-descriptor").value.startsWith("pearl-policy:v1:prl:nums:k:" + K1 + ";t:900000:" + K2));
  assert.deepEqual(errors, [], "console errors: " + errors.join(" | "));
});

test("footer attribution is present in the markup", () => {
  assert.ok(html.includes("prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d"), "donation address in footer");
  assert.ok(html.includes("@kshot9000"), "x handle in footer");
  assert.ok(html.includes("https://x.com/kshot9000"), "x link in footer");
});

test("honest limits panel is always visible", () => {
  const limits = $("honest-limits");
  assert.ok(limits.classList.contains("limits"));
  assert.ok(html.includes("never moves PRL"), "honest limits copy present");
});
