// Pearl Mesh DOM integration test — boots the real index.html + committed
// bundle (pearl-mesh.bundle.js) + app.js against a minimal DOM shim and
// drives the full flow: setup -> aggregate -> fund -> sign (guided ceremony
// with local keys) -> verify, plus footer-attribution checks. localStorage is
// hostile (throws); fetch is dead (no network in the shim).
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

/* ---------- minimal DOM (same strict shim as the policy page) ---------- */
class ClassList {
  constructor() { this.s = new Set(); }
  add(...c) { c.forEach((x) => this.s.add(x)); }
  remove(...c) { c.forEach((x) => this.s.delete(x)); }
  toggle(c, f) { (f ?? !this.s.has(c)) ? this.s.add(c) : this.s.delete(c); }
  contains(c) { return this.s.has(c); }
}
const TAG_RE = "(input|button|select|textarea|label|div|p|code|span|h3|h4|tr|td|th|tbody|thead|table|dt|dd|option|a|pre)";
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
for (const f of ["pearl-mesh.bundle.js", "qrcode.min.js"]) {
  vm.runInContext(fs.readFileSync(resolvePath(dir, f), "utf8"), sandbox, { filename: f });
}
sandbox.window.PearlMesh = sandbox.PearlMesh;
vm.runInContext(fs.readFileSync(resolvePath(dir, "app.js"), "utf8"), sandbox, { filename: "app.js" });

const $ = (id) => document.getElementById(id);
const E = () => sandbox.window.PearlMesh;
const K1 = "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
const K2 = "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9";
const K3 = "8200cf0ce11447bf6353cbac964d07d1c390d61d07e6c5d0214450b3add6449b";
const PIN_ADDRESS = "prl1p3faqn7s30jk4qmz06309lyry3v7yjy34lglq22px3ypheykhyq0s23h6ky";
const PIN_SEALED = "pearl-mesh:v1:prl:6bac3d1db6e81bf04c56bd16c8fca636f28a981b4ffdd51ef1b1628de7edf5a9";
const TIP = "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d";
const TEST_MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

function clickStep(name) {
  document.querySelectorAll("#steps button").find((b) => b.dataset.step === name).click();
}
function addMember(name, pubkey) {
  $("s-name").value = name;
  $("s-pubkey").value = pubkey;
  $("s-add").click();
}
function addLocalMember(name, idx) {
  $("s-mnemonic").value = TEST_MNEMONIC;
  $("s-index").value = String(idx);
  $("s-name").value = name;
  $("s-derive").click();
}

test("page boots with zero console errors (hostile localStorage, no network)", () => {
  assert.ok(E(), "bundle global present");
  assert.ok($("s-add"), "setup button present");
  assert.ok($("v-check-sig"), "verify button present");
  assert.deepEqual(errors, [], "console errors: " + errors.join(" | "));
});

test("every getElementById target in app.js exists in index.html", () => {
  const src = fs.readFileSync(resolvePath(dir, "app.js"), "utf8");
  const ids = new Set([...src.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]));
  const missing = [...ids].filter((id) => !byId.has(id));
  assert.deepEqual(missing, [], "missing ids: " + missing.join(","));
});

test("setup: pasted + local members, pinned triple aggregates byte-identical", () => {
  $("s-network").value = "mainnet"; // shim does not parse <option> children
  addMember("Ada", K1);
  addMember("Bo", K2);
  addMember("Cy", K3);
  assert.equal($("s-err").hidden, true, "no setup error: " + $("s-err").textContent);
  assert.ok($("s-count").textContent.includes("3"), "count shows 3");
  // duplicate refused
  addMember("Ada2", K1);
  assert.equal($("s-err").hidden, false, "duplicate refused");
  assert.ok($("s-err").textContent.match(/duplicate/i));
  // local member from test mnemonic
  addLocalMember("Dee", 0);
  assert.equal($("s-err").hidden, true, "no derive error: " + $("s-err").textContent);
  assert.ok($("s-count").textContent.includes("4"), "count shows 4");
  // remove the local + one pasted to get back to the pinned triple
  $("s-list").querySelectorAll("button")[3].click();
  $("s-list").querySelectorAll("button")[2].click();
  assert.ok($("s-count").textContent.includes("2"), "two members remain");
  addMember("Cy", K3);
  $("s-continue").click();
  assert.equal($("s-err").hidden, true, "continue ok: " + $("s-err").textContent);
  assert.equal($("step-aggregate").classList.contains("active"), true, "aggregate panel active");
  assert.equal($("a-address").textContent, PIN_ADDRESS, "pinned address rendered");
  assert.equal($("a-sealed").textContent, PIN_SEALED, "pinned sealed rendered");
  assert.deepEqual(errors, [], "console errors: " + errors.join(" | "));
});

test("aggregate: recompute & compare rules PROVEN on the pinned descriptor", () => {
  $("a-check").click();
  const box = $("a-check-result");
  assert.equal(box.hidden, false);
  assert.ok(box.classList.contains("proven"), "verdict PROVEN: " + box.textContent.slice(0, 120));
  assert.deepEqual(errors, [], "console errors: " + errors.join(" | "));
});

test("fund: address + QR render, air-gapped UTXO tally works", () => {
  clickStep("fund");
  assert.equal($("f-address").textContent, PIN_ADDRESS);
  assert.ok($("f-qr").textContent.length > 0 || $("f-qr").innerHTML.length > 0, "QR area rendered");
  const txid = "ab".repeat(32);
  $("f-utxos").value = `${txid}:0 1.5 prl ${PIN_ADDRESS}`;
  $("f-tally").click();
  assert.equal($("f-err").hidden, true, "no tally error: " + $("f-err").textContent);
  const r = $("f-tally-result");
  assert.equal(r.hidden, false);
  assert.ok(r.textContent.includes("1.50000000"), "1.5 PRL tallied: " + r.textContent.slice(0, 120));
  assert.deepEqual(errors, [], "console errors: " + errors.join(" | "));
});

test("sign: full guided ceremony with two local keys ends PROVEN", () => {
  // rebuild setup with two LOCAL members so the ceremony runs in-page
  clickStep("setup");
  // clear members via the list buttons
  let btns;
  while ((btns = $("s-list").querySelectorAll("button")).length) btns[0].click();
  addLocalMember("Ada", 0);
  addLocalMember("Bo", 1);
  assert.equal($("s-err").hidden, true, "locals added: " + $("s-err").textContent);
  $("s-continue").click();
  clickStep("sign");
  assert.equal($("g-err").hidden, true, "sign step ok: " + $("g-err").textContent);
  $("g-msg").value = "mesh pays 2.5 PRL to prl1p… (dom test)";
  // round 1: commit both local nonces
  $("g-local-commit").querySelectorAll("button").forEach((b) => b.click());
  assert.equal($("g-err").hidden, true, "commit ok: " + $("g-err").textContent);
  const bundles = $("g-local-commit").querySelectorAll("pre").map((p) => p.textContent);
  assert.equal(bundles.length, 2, "two bundles committed");
  $("g-bundles").value = bundles.join("\n");
  // coordinator aggregates
  $("g-aggregate-nonces").click();
  assert.equal($("g-err").hidden, true, "nonce aggregation ok: " + $("g-err").textContent);
  assert.equal($("g-aggbundle").hidden, false, "challenge shown");
  // round 2: sign locally
  $("g-local-sign").querySelectorAll("button").forEach((b) => b.click());
  assert.equal($("g-err").hidden, true, "local signing ok: " + $("g-err").textContent);
  const partials = $("g-local-sign").querySelectorAll("pre").map((p) => p.textContent);
  assert.equal(partials.length, 2, "two partials produced");
  $("g-partials").value = partials.join("\n");
  // coordinator aggregates + verifies
  $("g-aggregate-partials").click();
  assert.equal($("g-err").hidden, true, "aggregation ok: " + $("g-err").textContent);
  const fin = $("g-final");
  assert.equal(fin.hidden, false);
  assert.ok(fin.classList.contains("proven"), "final signature PROVEN: " + fin.textContent.slice(0, 160));
  // shim: the label "Signature" ends in 'e' (a hex char), gluing to the sig —
  // blank labels before extracting so the run is exactly the 128-hex sig
  const clean = (t) => t.replace(/signature/ig, " ");
  const sigMatch = clean(fin.textContent).match(/[0-9a-f]{128}/);
  assert.ok(sigMatch, "128-hex signature rendered");
  const sig = sigMatch[0];
  assert.deepEqual(errors, [], "console errors: " + errors.join(" | "));
});

test("sign: local simulation is clearly demo-grade and verifies", () => {
  $("g-simulate").click();
  assert.equal($("g-err").hidden, true, "simulation ok: " + $("g-err").textContent);
  const r = $("g-sim-result");
  assert.equal(r.hidden, false);
  assert.ok(r.textContent.includes("throwaway"), "demo-grade labeled: " + r.textContent.slice(0, 120));
  assert.ok(r.textContent.includes("✓ PROVEN"), "simulation verifies");
  assert.deepEqual(errors, [], "console errors: " + errors.join(" | "));
});

test("verify: descriptor verifier rules PROVEN then NOT PROVEN on tamper", () => {
  clickStep("verify");
  const desc = $("a-descriptor").textContent;
  const addr = $("a-address").textContent;
  const sealed = $("a-sealed").textContent;
  $("v-desc").value = desc;
  $("v-addr").value = addr;
  $("v-sealed").value = sealed;
  $("v-check-desc").click();
  const ok = $("v-desc-result");
  assert.ok(ok.classList.contains("proven"), "descriptor PROVEN: " + ok.textContent.slice(0, 120));
  $("v-desc").value = desc.replace("Ada", "Ade");
  $("v-check-desc").click();
  const bad = $("v-desc-result");
  assert.ok(bad.classList.contains("notproven"), "tampered descriptor NOT PROVEN");
  assert.deepEqual(errors, [], "console errors: " + errors.join(" | "));
});

test("verify: signature verifier rules PROVEN, rejects wrong message loudly", () => {
  // re-run: use the ceremony signature captured above
  clickStep("setup");
  let btns;
  while ((btns = $("s-list").querySelectorAll("button")).length) btns[0].click();
  addLocalMember("Ada", 0);
  addLocalMember("Bo", 1);
  $("s-continue").click();
  clickStep("sign");
  $("g-msg").value = "dom sig verify";
  $("g-local-commit").querySelectorAll("button").forEach((b) => b.click());
  assert.equal($("g-err").hidden, true, "re-commit ok: " + $("g-err").textContent);
  $("g-bundles").value = $("g-local-commit").querySelectorAll("pre").map((p) => p.textContent).join("\n");
  $("g-aggregate-nonces").click();
  assert.equal($("g-err").hidden, true, "re-aggregate nonces ok: " + $("g-err").textContent);
  $("g-local-sign").querySelectorAll("button").forEach((b) => b.click());
  assert.equal($("g-err").hidden, true, "re-sign ok: " + $("g-err").textContent);
  $("g-partials").value = $("g-local-sign").querySelectorAll("pre").map((p) => p.textContent).join("\n");
  $("g-aggregate-partials").click();
  assert.equal($("g-err").hidden, true, "re-aggregate partials ok: " + $("g-err").textContent);
  assert.ok($("g-final").classList.contains("proven"), "second ceremony PROVEN: " + $("g-final").textContent.slice(0, 160));
  const sigMatch2 = $("g-final").textContent.replace(/signature/ig, " ").match(/[0-9a-f]{128}/);
  assert.ok(sigMatch2, "ceremony produced a signature");
  const sig = sigMatch2[0];
  const addr = $("a-address").textContent;
  clickStep("verify");
  $("v-sig").value = sig;
  $("v-msg").value = "dom sig verify";
  $("v-key").value = addr;
  $("v-check-sig").click();
  const ok = $("v-sig-result");
  assert.ok(ok.classList.contains("proven"), "signature PROVEN: " + ok.textContent.slice(0, 120));
  $("v-msg").value = "different message";
  $("v-check-sig").click();
  const bad = $("v-sig-result");
  assert.ok(bad.classList.contains("notproven"), "wrong message NOT PROVEN");
  assert.deepEqual(errors, [], "console errors: " + errors.join(" | "));
});

test("footer carries @kshot9000 and the PRL tip address", () => {
  const foot = html.slice(html.indexOf("<footer"));
  assert.ok(foot.includes("@kshot9000"), "x handle present");
  assert.ok(foot.includes(TIP), "PRL tip address present character-for-character");
});
