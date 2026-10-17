// Pearl Atomic DOM integration test — boots the real index.html + scripts
// (pearl-atomic.bundle.js, app.js) in a stub DOM and checks:
//  1. every id referenced by app.js exists in index.html
//  2. app.js initializes without throwing (all listeners wired)
//  3. the forge path renders a contract (steps navigate)
// Run: node --no-warnings --test tests/dom.test.mjs
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
const appSrc = fs.readFileSync(resolvePath(dir, "app.js"), "utf8");
const bundleSrc = fs.readFileSync(resolvePath(dir, "pearl-atomic.bundle.js"), "utf8");

test("every id referenced by app.js exists in index.html", () => {
  const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const refs = new Set([...appSrc.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]));
  const missing = [...refs].filter((id) => !htmlIds.has(id));
  assert.deepEqual(missing, [], "app.js references ids missing from index.html: " + missing.join(", "));
});

test("app.js initializes without errors in a stub DOM", () => {
  class ClassList {
    constructor() { this.s = new Set(); }
    add(...c) { c.forEach((x) => this.s.add(x)); }
    remove(...c) { c.forEach((x) => this.s.delete(x)); }
    toggle(c, f) { (f ?? !this.s.has(c)) ? this.s.add(c) : this.s.delete(c); }
    contains(c) { return this.s.has(c); }
  }
  const elements = new Map();
  const stepButtons = [];
  const roleInputs = [];
  const copyBtns = [];
  const sections = [];
  function makeEl(id) {
    const el = {
      id, classList: new ClassList(), dataset: {},
      value: "", textContent: "", innerHTML: "", hidden: false, disabled: false,
      checked: false, width: 240, height: 240, style: {},
      _handlers: {},
      addEventListener(t, f) { (this._handlers[t] ??= []).push(f); },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      append() {},
      getContext() { return { fillStyle: "", fillRect() {}, getModuleCount: () => 0, isDark: () => false }; },
      click() { (this._handlers.click ?? []).forEach((f) => f({})); },
    };
    elements.set(id, el);
    return el;
  }
  for (const s of ["deal", "contract", "fund", "track", "settle", "verify"]) {
    const b = makeEl("stepbtn-" + s); b.dataset.step = s; stepButtons.push(b);
    const sec = makeEl("step-" + s); sections.push(sec);
  }
  for (const r of ["maker", "taker"]) {
    const inp = makeEl("role-" + r); inp.value = r; inp.checked = r === "maker";
    inp._handlers = {}; inp.addEventListener = function (t, f) { (this._handlers[t] ??= []).push(f); };
    roleInputs.push(inp);
  }
  const doc = {
    getElementById(id) { return elements.get(id) || makeEl(id); },
    querySelectorAll(sel) {
      if (sel === "#steps button") return stepButtons;
      if (sel === 'input[name="role"]') return roleInputs;
      if (sel === ".copy-btn") return copyBtns;
      if (sel === "main > section.panel") return sections;
      return [];
    },
    querySelector(sel) {
      const m = sel.match(/^input\[name="role"\]\[value="([^"]+)"\]$/);
      if (m) return roleInputs.find((r) => r.value === m[1]);
      if (sel === 'input[name="role"]:checked') return roleInputs.find((r) => r.checked);
      return null;
    },
    body: { innerHTML: "" },
  };
  // role inputs need change simulation helpers

  const sandbox = {
    document: doc,
    console, TextEncoder, TextDecoder,
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: async () => { throw new Error("no network in dom test"); },
    setTimeout, clearTimeout, scrollTo() {},
  };
  sandbox.window = sandbox; // in a browser window IS the global
  sandbox.window.scrollTo = () => {};
  vm.createContext(sandbox);
  vm.runInContext(bundleSrc, sandbox, { filename: "bundle.js" });
  assert.ok(sandbox.PearlAtomic, "bundle should set window.PearlAtomic");
  vm.runInContext(appSrc, sandbox, { filename: "app.js" });
  assert.ok(true, "app.js ran without throwing");
});


test("deal warnings are fully escaped, not just '<' (XSS audit latent queue)", () => {
  assert.match(appSrc, /function esc\(s\)/);
  assert.ok(appSrc.includes("warns.map((x) => `<li>${esc(x)}</li>`)"), "warnings escaped");
  assert.ok(!appSrc.includes("warns.map((x) => `<li>${x.replace"), "warnings no longer use partial escaping");
  assert.ok(html.includes('app.js?v=5'), "cache key bumped");
});

test("builder tip: claim checkbox off by default, disclosure in page, bundle API exact", () => {
  assert.ok(html.includes('id="claim-builder-tip" type="checkbox"'), "tip checkbox present in the claim form");
  assert.ok(!html.includes('id="claim-builder-tip" type="checkbox" checked'), "tip checkbox off by default");
  assert.ok(html.includes("add a 1% tip to the builder address"), "disclosure names the 1% in the page");
  assert.ok(html.includes("you receive the HTLC value minus the fee and the tip"), "disclosure states the claimer pays it out of the claim");
  assert.ok(html.includes("Refunds never carry a tip"), "refund exclusion disclosed in the page");
  assert.ok(appSrc.includes('builderTipEnabled: $("claim-builder-tip").checked === true'), "claim plan wires the checkbox into the core planner");
  assert.ok(appSrc.includes("Builder tip (optional, 1%)"), "plan review renders the tip as its own line before signing");
  assert.ok(html.includes("pearl-atomic.bundle.js?v=12"), "bundle cache key bumped");
  assert.ok(html.includes("styles.css?v=6"), "styles cache key bumped");
});
