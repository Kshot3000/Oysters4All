/* Pearl Circle DOM tests — drive the REAL app.js against a strict DOM shim.
 *
 * Strictness rule: document.getElementById THROWS on an unknown id, so a test
 * can never pass by clicking phantom elements the app never wired. Every id
 * used here was copied from index.html; every flow below exercises the real
 * handlers in app.js (forge -> schedule/funding plan -> redeem claim signing
 * -> secondary transfer presign+fill -> verify/track), with all cryptography
 * running locally in the bundle. fetch is stubbed offline. Every flow below
 * exercises the real handlers in app.js (found -> lottery commit/reveal/draw ->
 * fund -> winner claim signing -> m-of-n timeout refund -> track), with all
 * cryptography running locally in the bundle.
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
      if (sel === "main .panel") return sections;
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
let B; // the PearlCircle bundle namespace, for assertions
function bootApp() {
  const html = readFileSync(resolvePath(appDir, "index.html"), "utf8");
  const { document } = buildDocument(html);
  const bundleJs = readFileSync(resolvePath(appDir, "pearl-circle.bundle.js"), "utf8");
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
    btoa, atob,
    crypto: globalThis.crypto,
    window: {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(bundleJs + "\nwindow.PearlCircle = PearlCircle;", sandbox, { filename: "pearl-circle.bundle.js" });
  vm.runInContext(appJs, sandbox, { filename: "app.js" });
  B = vm.runInContext("window.PearlCircle", sandbox);
  const $ = (id) => document.getElementById(id);
  return { $, document };
}

const tick = () => new Promise((r) => setTimeout(r, 20));

/* ---------- circle flows ---------- */

/* Forge a 2-member circle through the real step-1 handler. Returns the
 * member mnemonics + decoded terms for later steps. */
async function forgeCircle2($) {
  const net = B.NETWORKS.mainnet;
  const mnA = B.newMnemonic(), mnB = B.newMnemonic();
  $("f-name").value = "DOM Circle";
  $("f-network").value = "mainnet";
  $("f-contrib").value = "5";
  $("f-roundblocks").value = "2160";
  $("f-startheight").value = "800000";
  $("f-grace").value = "144";
  $("f-m").value = "1";
  $("f-members").value = `Ava | ${mnA}\nBen | ${mnB}`;
  $("f-forge").click();
  await tick();
  assert.equal($("f-err").textContent, "", "forge error box must be empty");
  const desc = $("f-desc").value;
  const { terms } = B.decodeCircleDescriptor(desc);
  return { mnA, mnB, net, desc, terms };
}

test("bundle exposes the circle API", () => {
  bootApp();
  for (const fn of ["forgeCircle", "forgeRound", "parseCircleTerms", "parseMember",
    "payoutOrderFor", "memberCommitment", "newSecret", "commitmentFor", "verifyReveal",
    "encodeCircleDescriptor", "decodeCircleDescriptor", "verifyDescriptor",
    "descriptorFingerprint", "circleSetupHash", "fundingPlan",
    "planClaim", "signClaim", "planRefund", "signRefund", "finalizeRefund",
    "classifyRounds", "buildRefundScriptCircle", "numsInternalKeyCircle",
    "walletFromMnemonic", "newMnemonic", "broadcastTx", "fetchFeeRateGrainsPerVByte"]) {
    assert.equal(typeof B[fn], "function", fn + " exposed");
  }
});

test("step navigation toggles panels", () => {
  const { $, document } = bootApp();
  document.querySelector('#steps button[data-step="claim"]').click();
  assert.ok($("step-claim").classList.contains("active"), "claim panel active");
  assert.ok(!$("step-found").classList.contains("active"), "found panel inactive");
  document.querySelector('#steps button[data-step="lottery"]').click();
  assert.ok($("step-lottery").classList.contains("active"), "lottery panel active");
});

test("found flow: terms -> descriptor + fan-out", async () => {
  const { $ } = bootApp();
  const { desc, terms } = await forgeCircle2($);
  assert.match(desc, /^pearlcircle:v1:/, "descriptor shape");
  assert.match($("f-fp").textContent, /^[0-9a-f]{16}$/, "64-bit fingerprint shown");
  assert.match($("f-setuphash").textContent, /^[0-9a-f]{64}$/, "setup hash shown");
  assert.match($("f-summary").textContent, /2 members/, "summary mentions 2 members");
  assert.match($("f-summary").textContent, /1-of-2/, "summary mentions 1-of-2 refund");
  assert.equal($("l-desc").value, desc, "lottery fanned out");
  assert.equal($("u-desc").value, desc, "fund fanned out");
  assert.equal($("c-desc").value, desc, "claim fanned out");
  assert.equal($("k-desc").value, desc, "track fanned out");
  assert.equal(terms.members.length, 2);
});

test("lottery flow: secrets -> commitments -> verified draw", async () => {
  const { $ } = bootApp();
  const { desc, terms } = await forgeCircle2($);
  // generate secrets through the real handler
  $("l-gensecrets").click();
  await tick();
  assert.equal($("l-err").textContent, "", "gensecrets error box empty");
  const comms = JSON.parse($("l-commitments").value);
  assert.equal(comms.length, 2, "two commitments published");
  assert.ok($("l-table").querySelector("tbody")._innerHTML.includes("Ava"), "member table rendered");
  // draw with independently generated secrets (proves the verify path, not the UI's memory)
  const secrets = [B.newSecret(), B.newSecret()];
  const commitments = secrets.map((s, i) => ({ memberIndex: i, commitment: B.commitmentFor(s) }));
  $("l-commitments").value = JSON.stringify(commitments);
  $("l-reveals").value = JSON.stringify(secrets.map((s, i) => ({ memberIndex: i, secretHex: s })));
  $("l-draw").click();
  await tick();
  assert.equal($("l-err").textContent, "", "draw error box empty, got: " + $("l-err").textContent);
  const expectOrder = B.payoutOrderFor({
    setupHash: B.circleSetupHash(terms), commitments,
    reveals: secrets.map((s, i) => ({ memberIndex: i, secretHex: s })), n: 2,
  });
  assert.equal($("l-orderjson").textContent, JSON.stringify(expectOrder), "order matches independent recomputation");
  assert.match($("l-order").textContent, /round 1/, "order list rendered");
  assert.equal($("u-order").value, expectOrder.join(","), "fund order fanned out");
  assert.equal($("c-order").value, expectOrder.join(","), "claim order fanned out");
  assert.equal($("k-order").value, expectOrder.join(","), "track order fanned out");
  // tampered reveal is refused with the honest abort message
  $("l-reveals").value = JSON.stringify([
    { memberIndex: 0, secretHex: "ff".repeat(32) },
    { memberIndex: 1, secretHex: secrets[1] },
  ]);
  $("l-draw").click();
  await tick();
  assert.match($("l-err").textContent, /NOT match|void/, "tampered reveal refused");
});

test("fund flow: derive rounds + funding plan", async () => {
  const { $ } = bootApp();
  await forgeCircle2($);
  // draw the order first (needed to derive round addresses)
  const secrets = [B.newSecret(), B.newSecret()];
  const { terms } = B.decodeCircleDescriptor($("l-desc").value);
  const commitments = secrets.map((s, i) => ({ memberIndex: i, commitment: B.commitmentFor(s) }));
  $("l-commitments").value = JSON.stringify(commitments);
  $("l-reveals").value = JSON.stringify(secrets.map((s, i) => ({ memberIndex: i, secretHex: s })));
  $("l-draw").click();
  await tick();
  assert.equal($("l-err").textContent, "", "draw ok");
  $("u-feerate").value = "2";
  $("u-load").click();
  await tick();
  assert.equal($("u-err").textContent, "", "fund error box empty, got: " + $("u-err").textContent);
  const body = $("u-table").querySelector("tbody")._innerHTML;
  assert.ok(body.includes("prl1"), "round addresses rendered");
  assert.ok(body.includes("802304") || body.includes("804464"), "refund lock heights rendered");
  assert.match($("u-plan").textContent, /Grand total/, "per-member totals rendered");
  assert.match($("u-plan").textContent, /10 PRL/, "each member pays 10 PRL total (2 rounds x 5)");
});

test("claim flow: double-confirm, sign, re-verify, wipe", async () => {
  const { $ } = bootApp();
  const { mnA, mnB } = await forgeCircle2($);
  const secrets = [B.newSecret(), B.newSecret()];
  const commitments = secrets.map((s, i) => ({ memberIndex: i, commitment: B.commitmentFor(s) }));
  $("l-commitments").value = JSON.stringify(commitments);
  $("l-reveals").value = JSON.stringify(secrets.map((s, i) => ({ memberIndex: i, secretHex: s })));
  $("l-draw").click();
  await tick();
  const order = JSON.parse($("l-orderjson").textContent);
  const winnerMn = [mnA, mnB][order[0]];
  $("c-load").click();
  await tick();
  assert.equal($("c-err").textContent, "", "load error box empty");
  assert.ok($("c-round")._innerHTML.includes("Round 1"), "round options rendered");
  assert.ok($("d-round")._innerHTML.includes("Round 2"), "refund round options rendered");
  $("c-round").value = "1";
  $("c-txid").value = "ab".repeat(32);
  $("c-vout").value = "0";
  $("c-value").value = String(2 * 5 * 100000000); // pot: 2 members x 5 PRL
  $("c-dest").value = "";
  $("c-feerate").value = "2";
  $("c-key").value = winnerMn;
  $("c-build").click();
  await tick();
  assert.equal($("c-err").textContent, "", "build error box empty, got: " + $("c-err").textContent);
  assert.ok(!$("c-confirm").classList.contains("hidden"), "double-confirm shown");
  assert.match($("c-confirmtext").textContent, /round 1/, "confirm names the round");
  $("c-confirmyes").click();
  await tick();
  assert.equal($("c-err").textContent, "", "sign error box empty");
  assert.match($("c-hex").value, /^[0-9a-f]{200,}$/, "signed claim tx hex produced");
  assert.match($("c-meta").textContent, /re-verified/, "re-verification reported");
  assert.equal($("c-key").value, "", "key wiped after signing");
});

test("refund flow: template -> 1-of-2 sign -> finalize", async () => {
  const { $ } = bootApp();
  const { mnA } = await forgeCircle2($);
  const secrets = [B.newSecret(), B.newSecret()];
  const commitments = secrets.map((s, i) => ({ memberIndex: i, commitment: B.commitmentFor(s) }));
  $("l-commitments").value = JSON.stringify(commitments);
  $("l-reveals").value = JSON.stringify(secrets.map((s, i) => ({ memberIndex: i, secretHex: s })));
  $("l-draw").click();
  await tick();
  $("c-load").click();
  await tick();
  // round 1 lock = 800000 + 2160 + 144 = 802304
  $("d-round").value = "1";
  $("d-txid").value = "cd".repeat(32);
  $("d-vout").value = "0";
  $("d-value").value = String(2 * 5 * 100000000);
  $("d-height").value = "802304";
  $("d-feerate").value = "2";
  $("d-template").click();
  await tick();
  assert.equal($("d-err").textContent, "", "template error box empty, got: " + $("d-err").textContent);
  assert.ok(!$("d-tplout").classList.contains("hidden"), "template panel shown");
  assert.match($("d-meta").textContent, /needs 1 of 2/, "quorum shown");
  $("d-member").value = "0";
  $("d-key").value = mnA;
  $("d-sign").click();
  await tick();
  assert.equal($("d-err").textContent, "", "sign error box empty, got: " + $("d-err").textContent);
  assert.match($("d-sigs").textContent, /Ava/, "signature recorded for Ava");
  assert.equal($("d-key").value, "", "signer key wiped after signing");
  $("d-finalize").click();
  await tick();
  assert.equal($("d-err").textContent, "", "finalize error box empty, got: " + $("d-err").textContent);
  assert.match($("d-hex").value, /^[0-9a-f]{200,}$/, "signed refund tx hex produced");
  assert.match($("d-fmeta").textContent, /re-verified/, "re-verification reported");
  // too early: lock not reached
  $("d-height").value = "802303";
  $("d-template").click();
  await tick();
  assert.match($("d-err").textContent, /locked until/, "early refund honestly refused");
});

test("track: order required before addresses can be derived", async () => {
  const { $ } = bootApp();
  await forgeCircle2($);
  $("k-order").value = "";
  $("k-check").click();
  await tick();
  assert.match($("k-err").textContent, /payout order is required/, "honest refusal without order");
});
