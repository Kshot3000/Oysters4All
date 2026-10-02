/* Pearl Bond DOM tests — drive the REAL app.js against a strict DOM shim.
 *
 * Strictness rule: document.getElementById THROWS on an unknown id, so a test
 * can never pass by clicking phantom elements the app never wired. Every id
 * used here was copied from index.html; every flow below exercises the real
 * handlers in app.js (forge -> schedule/funding plan -> redeem claim signing
 * -> secondary transfer presign+fill -> verify/track), with all cryptography
 * running locally in the bundle. fetch is stubbed offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolvePath(here, "..");
const require = createRequire("/home/hatch/workspace/.build-tools/package.json");
const esbuild = require("esbuild");

/* ---------- strict minimal DOM ---------- */
class El {
  constructor(tag, id, attrs = {}) {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this._cls = new Set((attrs.class || "").split(/\s+/).filter(Boolean));
    this.dataset = {};
    for (const m of (attrs.raw || "").matchAll(/data-([\w-]+)="([^"]*)"/g)) {
      const camel = m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      this.dataset[camel] = m[2];
    }
    this._listeners = {};
    this._children = [];
    this._innerHTML = "";
    this._text = "";
    this.value = attrs.value !== undefined ? attrs.value : "";
    this.style = {};
    this.parent = null;
    if (this.tagName === "TABLE") {
      this._tbody = new El("tbody", "");
      this._tbody.parent = this;
      this._children.push(this._tbody);
    }
  }
  get classList() {
    const s = this._cls;
    return {
      add: (c) => s.add(c), remove: (c) => s.delete(c),
      contains: (c) => s.has(c), toggle: (c) => (s.has(c) ? s.delete(c) : s.add(c)),
    };
  }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(v) {
    this._innerHTML = String(v);
    if (v === "") this._children = this._children.filter((c) => c === this._tbody);
  }
  get textContent() {
    if (this._text) return this._text;
    return this._innerHTML.replace(/<[^>]*>/g, "");
  }
  set textContent(v) { this._text = String(v); }
  addEventListener(t, fn) { (this._listeners[t] ||= []).push(fn); }
  click() { for (const fn of this._listeners.click || []) fn({ preventDefault() {} }); }
  appendChild(c) { c.parent = this; this._children.push(c); return c; }
  removeChild(c) { this._children = this._children.filter((x) => x !== c); return c; }
  select() {}
  querySelector(sel) {
    if (sel === "tbody") return this._tbody || null;
    return null;
  }
  querySelectorAll(sel) {
    if (sel === ".copy-btn") return [];
    return [];
  }
}

function buildDocument(html) {
  const byId = new Map();
  const buttons = [];
  const sections = [];
  const copyBtns = [];
  for (const m of html.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*?)>/g)) {
    const tag = m[1].toLowerCase(), raw = m[2];
    const idm = /\bid="([^"]*)"/.exec(raw);
    const id = idm ? idm[1] : "";
    const el = new El(tag, id, { raw, value: (/\bvalue="([^"]*)"/.exec(raw) || [])[1] });
    if (id) {
      if (byId.has(id)) throw new Error("duplicate id in fixture: " + id);
      byId.set(id, el);
    }
    if (tag === "button") buttons.push(el);
    if (tag === "section" && id.startsWith("step-")) sections.push(el);
    if (el.dataset.for !== undefined) copyBtns.push(el);
  }
  const stepBtn = (name) => buttons.find((b) => b.dataset.step === name) || null;
  const document = {
    getElementById(id) {
      if (id === null || id === undefined) return null;
      const key = String(id);
      if (!byId.has(key)) throw new Error("unknown element id (strict shim): " + key);
      return byId.get(key);
    },
    createElement: (t) => new El(t, ""),
    querySelector(sel) {
      let m = /^#steps button\[data-step="([^"]+)"\]$/.exec(sel);
      if (m) return stepBtn(m[1]);
      return null;
    },
    querySelectorAll(sel) {
      if (sel === "#steps button") return buttons.filter((b) => b.dataset.step);
      if (sel === "main > section.panel[id^='step-']") return sections;
      if (sel === '.copy-btn[data-for]') return copyBtns;
      return [];
    },
    body: { appendChild() {}, removeChild() {} },
    execCommand: () => true,
  };
  return { document, byId };
}

/* ---------- boot the real app ---------- */
let B; // the PearlBond bundle namespace, for assertions
function bootApp() {
  const html = readFileSync(resolvePath(appDir, "index.html"), "utf8");
  const { document } = buildDocument(html);
  const bundleJs = readFileSync(resolvePath(appDir, "pearl-bond.bundle.js"), "utf8");
  const appJs = readFileSync(resolvePath(appDir, "app.js"), "utf8");
  const sandbox = {
    document,
    navigator: {},
    alert: () => {},
    fetch: () => Promise.reject(new Error("stubbed offline")),
    setTimeout, clearTimeout,
    console,
    URL, Blob,
    TextEncoder, TextDecoder,
    crypto: globalThis.crypto,
    window: {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(bundleJs + "\nwindow.PearlBond = PearlBond;", sandbox, { filename: "pearl-bond.bundle.js" });
  vm.runInContext(appJs, sandbox, { filename: "app.js" });
  B = vm.runInContext("window.PearlBond", sandbox);
  const $ = (id) => document.getElementById(id);
  return { $, document };
}

const tick = () => new Promise((r) => setTimeout(r, 20));

/* Forge one deterministic bond through the real step-1 handler. */
async function forgeBond($) {
  const net = B.NETWORKS.mainnet;
  const sellerMn = B.newMnemonic(), buyerMn = B.newMnemonic();
  const seller = B.walletFromMnemonic(sellerMn, net);
  const buyer = B.walletFromMnemonic(buyerMn, net);
  $("t-face").value = "1000";
  $("t-rate").value = "5";
  $("t-freq").value = "2";
  $("t-periods").value = "4";
  $("t-issue").value = "200000";
  $("t-network").value = "mainnet";
  $("t-holder").value = sellerMn;
  $("t-forge").click();
  await tick();
  assert.equal($("t-err").textContent, "", "forge error box must be empty");
  return { seller, buyer, net, sellerMn, buyerMn };
}

/* ---------- tests ---------- */

test("bundle exposes the bond API", () => {
  bootApp();
  for (const fn of ["forgeBond", "couponSchedule", "planClaim", "signClaim",
    "presignTransferLeg", "verifyTransferLeg", "buildFillTx",
    "verifyDescriptor", "decodeBondDescriptor", "yieldToMaturity",
    "fundingPlan", "classifyTranches", "tweakKeypath", "tweakPrivKeypath",
    "addressToProgram", "p2trScriptPubKey", "walletFromMnemonic", "newMnemonic"]) {
    assert.equal(typeof B[fn], "function", fn + " exposed");
  }
});

test("step navigation toggles panels", () => {
  const { $, document } = bootApp();
  document.querySelector('#steps button[data-step="transfer"]').click();
  assert.ok($("step-transfer").classList.contains("active"), "transfer panel active");
  assert.ok(!$("step-terms").classList.contains("active"), "terms panel inactive");
  document.querySelector('#steps button[data-step="terms"]').click();
  assert.ok($("step-terms").classList.contains("active"), "terms panel reactivated");
});

test("forge flow: terms -> schedule table + descriptor fan-out", async () => {
  const { $ } = bootApp();
  await forgeBond($);
  // schedule table: 4 tranches (3 coupons + coupon+principal), pinned locks
  const tb = $("f-table").querySelector("tbody");
  assert.equal(tb._children.length, 4, "4 tranche rows");
  assert.match($("t-summary").textContent, /4 tranches/, "summary mentions 4 tranches");
  assert.match($("t-summary").textContent, /280165/, "first coupon lock 280165");
  assert.match($("t-summary").textContent, /520660/, "maturity lock 520660");
  // descriptor fan-out
  const desc = $("f-desc").value;
  assert.match(desc, /^bond:v1\//, "descriptor shape");
  assert.equal($("r-desc").value, desc, "redeem fanned out");
  assert.equal($("s-desc").value, desc, "transfer fanned out");
  assert.equal($("k-desc").value, desc, "track fanned out");
  // holder mnemonic carried into signing fields
  assert.ok($("r-key").value.split(/\s+/).length === 12, "redeem key prefilled");
  assert.ok($("s-key").value.split(/\s+/).length === 12, "transfer key prefilled");
  // funding plan rendered
  assert.match($("f-plan").textContent, /grand total/, "funding plan rendered");
  // auto-advanced to the fund step
  assert.ok($("step-fund").classList.contains("active"), "advanced to fund step");
  // descriptor round-trips through the verifier
  const v = B.verifyDescriptor(desc);
  assert.equal(v.tranches.length, 4, "verifier sees 4 tranches");
});

test("redeem flow: load descriptor -> build a signed claim tx", async () => {
  const { $ } = bootApp();
  const { seller } = await forgeBond($);
  $("r-load").click();
  await tick();
  assert.equal($("r-err").textContent, "", "load error box empty");
  assert.equal($("r-tranche")._children.length, 4, "4 tranche options");
  // claim tranche #1 (25 PRL coupon, lock 280165) at height 300000
  $("r-tranche").value = "1";
  $("r-txid").value = "ab".repeat(32);
  $("r-vout").value = "0";
  $("r-dest").value = seller.address;
  $("r-height").value = "300000";
  $("r-build").click();
  await tick();
  assert.equal($("r-err").textContent, "", "build error box empty, got: " + $("r-err").textContent);
  const hex = $("r-hex").value;
  assert.match(hex, /^[0-9a-f]{50,}$/, "signed claim tx hex produced");
  assert.match($("r-txid-out").textContent, /^txid [0-9a-f]{64}$/, "claim txid shown");
  assert.ok(!$("r-out").classList.contains("hidden"), "result panel revealed");
  assert.match($("r-meta").textContent, /re-verified/, "signature re-verified note");
  // redeeming too early is refused honestly
  $("r-height").value = "200000";
  $("r-build").click();
  await tick();
  assert.match($("r-err").textContent, /locked until height 280165/, "early claim refused");
});

test("transfer flow: presign legs -> buyer verifies + fills", async () => {
  const { $ } = bootApp();
  const { seller, buyer, net, buyerMn } = await forgeBond($);
  // sell tranches #1 and #2 (two 25-PRL coupons) for 45 PRL
  const terms = B.parseBondTerms({ facePRL: "1000", annualBps: 500, frequency: 2, periods: 4, issueHeight: 200000 });
  const sched = B.couponSchedule(terms);
  const outpoints = [1, 2].map((i) => `${"cd".repeat(32)}:${i - 1}:${sched[i - 1].amountGrains}`).join("\n");
  $("s-buyer").value = B.bytesToHex(buyer.internalXOnly);
  $("s-legs").value = "1,2";
  $("s-outpoints").value = outpoints;
  $("s-presign").click();
  await tick();
  assert.equal($("s-err").textContent, "", "presign error box empty, got: " + $("s-err").textContent);
  const pkg = JSON.parse($("t-pkg").value);
  assert.equal(pkg.kind, "pearl-bond-transfer", "package kind");
  assert.equal(pkg.legs.length, 2, "two legs");
  assert.equal(pkg.legs[0].trancheIndex, 1, "first leg is tranche #1");
  // every leg verifies against its digest (buyer-side check, before money moves)
  for (const leg of pkg.legs) B.verifyTransferLeg(net, leg);
  // buyer fills: 45 PRL price from a 100 PRL keypath UTXO
  $("b-pkg").value = $("t-pkg").value;
  $("b-price").value = "45";
  $("b-utxo").value = `${"ee".repeat(32)}:1:${100 * 100_000_000}`;
  $("b-utxokey").value = buyerMn;
  $("b-sellerpay").value = seller.address;
  $("b-change").value = buyer.address;
  $("b-fill").click();
  await tick();
  assert.equal($("b-err").textContent, "", "fill error box empty, got: " + $("b-err").textContent);
  assert.match($("t-fill-hex").value, /^[0-9a-f]{50,}$/, "fill tx hex produced");
  assert.match($("t-fill-meta").textContent, /2 leg\(s\)/, "fill meta counts legs");
  assert.ok(!$("t-fill-out").classList.contains("hidden"), "fill result revealed");
});

test("track flow: descriptor check + lifecycle table (offline)", async () => {
  const { $ } = bootApp();
  await forgeBond($);
  $("k-check").click();
  await tick();
  assert.equal($("k-err").textContent, "", "track error box empty");
  assert.match($("k-meta").textContent, /Round-trip exact/, "descriptor round-trip noted");
  assert.match($("k-meta").textContent, /offline/, "offline source disclosed");
  const tb = $("k-table").querySelector("tbody");
  assert.equal(tb._children.length, 4, "4 lifecycle rows");
  assert.match($("k-meta").textContent, /4× unfunded/, "all tranches unfunded");
});

test("index.html carries attribution, honest limits, and cache keys", () => {
  const html = readFileSync(resolvePath(appDir, "index.html"), "utf8");
  assert.match(html, /@kshot9000/, "X attribution");
  assert.match(html, /prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d/, "donation address, character-for-character");
  assert.match(html, /honest-limits|Honest limits/i, "honest limits panel");
  assert.match(html, /pearl-bond\.bundle\.js\?v=2/, "bundle cache key");
  assert.match(html, /app\.js\?v=2/, "app cache key");
  assert.match(html, /styles\.css\?v=1/, "css cache key");
});
