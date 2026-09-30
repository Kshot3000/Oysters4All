// Pearl Solvency DOM integration test — boots the real index.html + scripts
// (pearl-solvency.bundle.js, app.js) in a stub DOM and checks:
//  1. every static id referenced by app.js exists in index.html
//  2. app.js initializes without throwing (all listeners wired)
//  3. the full custodian -> addresses -> prove -> bundle flow works with a
//     fixture key, and the emitted bundle re-parses with a valid fingerprint
// Run: node --no-warnings --test tests/dom.test.mjs
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
const appSrc = fs.readFileSync(resolvePath(dir, "app.js"), "utf8");
const bundleSrc = fs.readFileSync(resolvePath(dir, "pearl-solvency.bundle.js"), "utf8");

test("every static id referenced by app.js exists in index.html", () => {
  const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const refs = new Set([...appSrc.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]));
  const missing = [...refs].filter((id) => !htmlIds.has(id));
  assert.deepEqual(missing, [], "app.js references ids missing from index.html: " + missing.join(", "));
});

test("donation address and X handle are present and exact", () => {
  assert.ok(html.includes("prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d"), "donation address missing");
  assert.ok(html.includes("https://x.com/kshot9000"), "X link missing");
});

function buildStubDom() {
  class ClassList {
    constructor() { this.s = new Set(); }
    add(...c) { c.forEach((x) => this.s.add(x)); }
    remove(...c) { c.forEach((x) => this.s.delete(x)); }
    toggle(c, f) { (f ?? !this.s.has(c)) ? this.s.add(c) : this.s.delete(c); }
    contains(c) { return this.s.has(c); }
  }
  const elements = new Map();
  const stepButtons = [];
  const sections = [];
  function makeEl(id) {
    const el = {
      classList: new ClassList(), dataset: {},
      value: "", textContent: "", hidden: false, disabled: false,
      placeholder: "", style: {},
      _handlers: {},
      children: [],
      addEventListener(t, f) { (this._handlers[t] ??= []).push(f); },
      appendChild(c) { this.children.push(c); return c; },
      append(...cs) { this.children.push(...cs); },
      click() { (this._handlers.click ?? []).forEach((f) => f({ target: this })); },
      querySelector() { return null; },
    };
    let _id = id, _innerHTML = "";
    Object.defineProperty(el, "id", {
      get() { return _id; },
      set(v) { elements.delete(_id); _id = v; elements.set(v, el); },
    });
    Object.defineProperty(el, "innerHTML", {
      get() { return _innerHTML; },
      set(v) {
        _innerHTML = String(v);
        // stub: materialize id="..." children like a real parser would
        for (const m of _innerHTML.matchAll(/id="([^"]+)"/g)) {
          if (!elements.has(m[1])) { const c = makeEl(m[1]); el.children.push(c); }
        }
      },
    });
    elements.set(_id, el);
    return el;
  }
  for (const s of ["custodian", "addresses", "prove", "bundle", "verify"]) {
    const b = makeEl("stepbtn-" + s); b.dataset.step = s; stepButtons.push(b);
    const sec = makeEl("step-" + s); sections.push(sec);
  }
  const doc = {
    getElementById(id) { return elements.get(id) || makeEl(id); },
    querySelectorAll(sel) {
      if (sel === "#steps button") return stepButtons;
      if (sel === "main > section.panel") return sections;
      if (sel === ".copy-btn") return [];
      return [];
    },
    querySelector() { return null; },
    createElement(tag) {
      const el = makeEl("dyn-" + Math.random().toString(36).slice(2));
      el.tagName = tag.toUpperCase();
      return el;
    },
    body: null,
  };
  doc.body = makeEl("body");
  return { doc, elements, makeEl };
}

test("full custodian -> addresses -> prove -> bundle flow in stub DOM", () => {
  const { doc, elements, makeEl } = buildStubDom();
  // pre-register every static id from index.html so the test can drive the UI;
  // honor the hidden attribute like a real parser
  for (const m of html.matchAll(/<(\w+)[^>]*id="([^"]+)"[^>]*>/g)) {
    const el = makeEl(m[2]);
    if (/\shidden(?=[\s>])/.test(m[0])) el.hidden = true;
    if (m[1] === "button" && /disabled(?=[\s>])/.test(m[0])) el.disabled = true;
  }
  const ctx = vm.createContext({
    document: doc,
    window: { scrollTo() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    crypto: webcrypto,
    TextEncoder, TextDecoder,
    URL, Blob,
    setTimeout, clearTimeout,
    console,
  });
  vm.runInContext(bundleSrc, ctx, { filename: "pearl-solvency.bundle.js" });
  assert.ok(ctx.PearlSolvency, "bundle must set window.PearlSolvency");
  // in a real browser, top-level `var PearlSolvency` lands on window; mirror that
  vm.runInContext("window.PearlSolvency = PearlSolvency;", ctx);
  vm.runInContext(appSrc, ctx, { filename: "app.js" });

  const E = ctx.PearlSolvency;
  const NW = E.NETWORKS.mainnet;
  const key = E.custodianKeyFromInput("11".repeat(32), NW);
  const $ = (id) => elements.get(id);

  // step 1: custodian
  $("custodian").value = "Test Custodian";
  $("chall-date").value = "2026-09-29";
  $("chall-nonce").value = "abc123";
  $("liabilities").value = "1500.25";
  $("blockbook").value = "https://blockbook.example";
  $("custodian-next").click();
  assert.equal($("custodian-err").hidden, true, "custodian step must not error: " + $("custodian-err").textContent);

  // step 2: addresses
  $("addr-list").value = key.keypathAddress + "\n" + key.keypathAddress + "\nnot-an-address";
  $("addr-validate").click();
  assert.equal($("addr-err").hidden, true, "address step must not error: " + $("addr-err").textContent);
  assert.equal($("addr-next").disabled, false, "next must enable with one valid address");

  // step 3: prove — drive the REAL UI sign path with the fixture key
  $("prove-key-0").value = "11".repeat(32);
  $("prove-sign-all").click();
  assert.equal($("prove-err").hidden, true, "prove step must not error: " + $("prove-err").textContent);
  assert.equal($("prove-key-0").value, "", "key input must be wiped after signing");
  assert.equal($("prove-next").disabled, false, "next must enable when all rows signed");

  // step 4: bundle — built by the UI
  $("prove-next").click();
  const fp = $("bundle-fp").textContent;
  assert.match(fp, /^[0-9a-f]{16}$/, "bundle fingerprint must be 64-bit hex");
  assert.equal($("bundle-naddr").textContent, 1);
  assert.equal($("bundle-liab").textContent, "1500.25 PRL");
  const parsed = E.parseSolvencyBundle($("bundle-text").value);
  assert.equal(parsed.fingerprint, fp);
  assert.equal(parsed.liabilitiesGrains, 150025000000n);
  assert.ok(E.verifyBundleSignatures(parsed).every((s) => s.ok), "bundle signatures must verify");
});
