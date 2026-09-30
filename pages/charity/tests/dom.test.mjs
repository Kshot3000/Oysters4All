/* Pearl Charity DOM tests — drive the REAL app.js against a strict DOM shim.
 *
 * Strictness rule: document.getElementById THROWS on an unknown id, so a test
 * can never pass by clicking phantom elements the app never wired. Every id
 * used here was copied from index.html; every flow below exercises the real
 * handlers in app.js (launch -> fund -> receipts -> track -> verify), with all
 * cryptography running locally in the bundle. fetch is a programmable stub
 * serving canned Blockbook JSON (tip 900050, one 50-PRL donation).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolvePath(here, "..");

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
    this._text = ""; // setting innerHTML replaces children (kills any prior textContent)
    // Materialize <button> children so querySelectorAll("button[data-del]") works
    // like a real DOM (the app wires delete buttons this way).
    this._children = this._children.filter((c) => c === this._tbody);
    for (const bm of String(v).matchAll(/<button\b([^>]*)>/gi)) {
      const btn = new El("button", "", { raw: bm[1] });
      btn.parent = this;
      this._children.push(btn);
    }
  }
  get textContent() {
    if (this._text) return this._text;
    return this._innerHTML.replace(/<[^>]*>/g, "");
  }
  set textContent(v) { this._text = String(v); }
  addEventListener(t, fn) { (this._listeners[t] ||= []).push(fn); }
  click() { for (const fn of this._listeners.click || []) fn({ preventDefault() {}, target: this }); }
  appendChild(c) { c.parent = this; this._children.push(c); return c; }
  removeChild(c) { this._children = this._children.filter((x) => x !== c); return c; }
  remove() { if (this.parent) this.parent.removeChild(this); }
  select() {}
  querySelector(sel) {
    if (sel === "tbody") return this._tbody || null;
    if (sel === 'button[data-del]') return this._children.flatMap((c) => c.tagName === "TR" ? [] : []);
    return null;
  }
  querySelectorAll(sel) {
    if (sel === "button[data-del]") {
      const out = [];
      const walk = (el) => {
        for (const c of el._children) {
          if (c.tagName === "BUTTON" && c.dataset.del !== undefined) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    }
    return [];
  }
}

function buildDocument(html) {
  const byId = new Map();
  const buttons = [];
  const sections = [];
  for (const m of html.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*?)>/g)) {
    const tag = m[1].toLowerCase(), raw = m[2];
    const idm = /\bid="([^"]*)"/.exec(raw);
    const id = idm ? idm[1] : "";
    const elm = new El(tag, id, { raw, value: (/\bvalue="([^"]*)"/.exec(raw) || [])[1] });
    if (id) {
      if (byId.has(id)) throw new Error("duplicate id in fixture: " + id);
      byId.set(id, elm);
    }
    if (tag === "button") buttons.push(elm);
    if (tag === "section" && id.startsWith("step-")) sections.push(elm);
  }
  const stepBtn = (name) => buttons.find((b) => b.dataset.step === name) || null;
  const document = {
    getElementById(id) {
      const key = String(id);
      if (!byId.has(key)) throw new Error("unknown element id (strict shim): " + key);
      return byId.get(key);
    },
    createElement: (t) => new El(t, ""),
    querySelector(sel) {
      const m = /^#steps button\[data-step="([^"]+)"\]$/.exec(sel);
      if (m) return stepBtn(m[1]);
      return null;
    },
    querySelectorAll(sel) {
      if (sel === "#steps button") return buttons.filter((b) => b.dataset.step);
      if (sel === "main .panel") return sections;
      return [];
    },
    body: { appendChild() {}, removeChild() {} },
    execCommand: () => true,
  };
  return { document, byId };
}

/* ---------- boot the real app ---------- */
let B; // the PearlCharity bundle namespace, for fixtures
function bootApp() {
  const html = readFileSync(resolvePath(appDir, "index.html"), "utf8");
  const { document } = buildDocument(html);
  const bundleJs = readFileSync(resolvePath(appDir, "pearl-charity.bundle.js"), "utf8");
  const appJs = readFileSync(resolvePath(appDir, "app.js"), "utf8");
  const store = {};
  const resp = (j) => ({ ok: true, status: 200, text: async () => JSON.stringify(j) });
  const sandbox = {
    document,
    navigator: {},
    alert: () => {},
    confirm: () => true,
    print: () => {},
    fetch: async (url) => {
      const u = String(url);
      const recip = sandbox.__recip || "";
      if (/\/api\/v2\/?$/.test(u)) return resp({ backend: { blocks: 900050 } });
      if (u.includes("/api/v2/tx/")) {
        const txid = u.split("/api/v2/tx/")[1].split("?")[0];
        if (txid === sandbox.__txid) {
          return resp({
            txid, blockHeight: 900040, confirmations: 10,
            vout: [{ value: String(5 * 100000000), scriptPubKey: { addresses: [recip] } }],
          });
        }
        return { ok: false, status: 404, text: async () => "{}" };
      }
      if (u.includes("/api/v2/address/")) {
        return resp({
          address: recip,
          totalReceived: String(50 * 100000000),
          txs: [{
            txid: sandbox.__txid || "ab".repeat(32),
            blockHeight: 900040, confirmations: 10,
            vout: [{ value: String(50 * 100000000), scriptPubKey: { addresses: [recip] } }],
          }],
        });
      }
      throw new Error("stubbed offline: " + u);
    },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    setTimeout, clearTimeout,
    console,
    URL: { createObjectURL: () => "blob:stub", revokeObjectURL: () => {} },
    Blob: globalThis.Blob,
    Date,
    TextEncoder, TextDecoder,
    btoa, atob,
    crypto: globalThis.crypto,
    window: {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(bundleJs + "\nwindow.PearlCharity = PearlCharity;", sandbox, { filename: "pearl-charity.bundle.js" });
  vm.runInContext(appJs, sandbox, { filename: "app.js" });
  B = vm.runInContext("window.PearlCharity", sandbox);
  const $ = (id) => document.getElementById(id);
  return { $, document, sandbox };
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => B.sha256(new TextEncoder().encode(s));
const RECIP = () => B.encodeBech32m("prl", 1, sha("pearl-charity-dom-recipient"));
const ORG_PRIV = () => B.bytesToHex(sha("pearl-charity-dom-organizer"));

async function forgeCampaignDom($, { signed = false, goal = "100", deadline = "901000", recipient = null } = {}) {
  $("l-org").value = "DOM Lanterns";
  $("l-network").value = "mainnet";
  $("l-recipient").value = recipient || RECIP();
  $("l-goal").value = goal;
  $("l-deadline").value = deadline;
  $("l-desc").value = "dom campaign";
  $("l-contact").value = "@dom";
  if (signed) {
    $("l-mode").value = "sign";
    // fire the change listener the shim registered
    for (const fn of $("l-mode")._listeners.change || []) fn({});
    $("l-key").value = ORG_PRIV();
  }
  $("l-forge").click();
  await tick();
  assert.equal($("l-err").textContent, "", "forge error box must be empty");
  return $("l-spec").value;
}

const tableRows = ($) => (id) =>
  $(id).querySelector("tbody")._children.filter((c) => c.tagName === "TR");

test("bundle exposes the charity API", () => {
  bootApp();
  for (const fn of ["forgeCampaign", "campaignDescriptor", "parseCampaignDescriptor",
    "verifyDescriptor", "parseCampaignSpec", "serializeCampaign",
    "descriptorFingerprint", "campaignHash", "recordReceipt", "verifyReceiptHash",
    "crossCheckReceipt", "classifyCampaign", "formatDeadlineCountdown",
    "countDonors", "checkGoalGrains", "checkRecipientAddress",
    "checkDeadlineHeight", "parsePRLToGrains", "fmtPRL", "organizerKeyFromInput",
    "fetchCampaignStats", "fetchTipHeight",
    "BLOCKBOOK_MAINNET", "NETWORKS", "DUST_GRAIN"]) {
    assert.ok(B[fn] !== undefined, fn + " exposed");
  }
});

test("step navigation toggles panels", () => {
  const { $, document } = bootApp();
  document.querySelector('#steps button[data-step="track"]').click();
  assert.ok($("step-track").classList.contains("active"), "track panel active");
  assert.ok(!$("step-launch").classList.contains("active"), "launch panel inactive");
  document.querySelector('#steps button[data-step="verify"]').click();
  assert.ok($("step-verify").classList.contains("active"), "verify panel active");
});

test("launch flow: forge -> descriptor + fan-out", async () => {
  const { $, sandbox } = bootApp();
  sandbox.__recip = RECIP();
  const spec = await forgeCampaignDom($);
  assert.match($("l-descriptor").value, /^pearl-charity:v1:prl:[0-9a-f]{64}:10000000000:901000$/, "descriptor shape");
  assert.match($("l-fp").textContent, /^[0-9a-f]{16}$/, "64-bit fingerprint shown");
  assert.equal($("l-address").value, RECIP(), "donation address shown");
  assert.match($("l-summary").textContent, /100 PRL/, "summary mentions goal");
  assert.match($("l-authnote").textContent, /unsigned/, "unsigned authorship noted");
  assert.equal($("f-spec").value, spec, "fund fanned out");
  assert.equal($("r-spec").value, spec, "receipts fanned out");
  assert.equal($("t-spec").value, spec, "track fanned out");
  assert.equal($("v-spec").value, spec, "verify spec fanned out");
  assert.equal($("v-descriptor").value, $("l-descriptor").value, "verify descriptor fanned out");
  assert.equal($("v-address").value, RECIP(), "verify address fanned out");
  assert.equal($("l-key").value, "", "organizer key cleared after forge");
});

test("launch: bad input refused loudly", async () => {
  const { $ } = bootApp();
  $("l-org").value = "x";
  $("l-network").value = "mainnet";
  $("l-recipient").value = "not-an-address";
  $("l-goal").value = "100";
  $("l-forge").click(); await tick();
  assert.match($("l-err").textContent, /rejected/, "bad address refused");
  $("l-recipient").value = RECIP();
  $("l-goal").value = "0";
  $("l-forge").click(); await tick();
  assert.match($("l-err").textContent, /positive/, "zero goal refused");
  $("l-goal").value = "0.00000001";
  $("l-forge").click(); await tick();
  assert.match($("l-err").textContent, /dust floor/, "dust goal refused");
});

test("launch: signed authorship recorded and key wiped", async () => {
  const { $ } = bootApp();
  await forgeCampaignDom($, { signed: true });
  assert.match($("l-authnote").textContent, /signed by x-only key/, "authorship noted");
  assert.equal($("l-key").value, "", "key wiped");
  const spec = JSON.parse($("l-spec").value);
  assert.match(spec.orgSigHex, /^[0-9a-f]{128}$/, "spec carries the signature");
});

test("fund flow: load -> check (stubbed Blockbook) + air-gapped path", async () => {
  const { $, sandbox } = bootApp();
  sandbox.__recip = RECIP();
  sandbox.__txid = "ab".repeat(32);
  await forgeCampaignDom($);
  $("f-load").click(); await tick();
  assert.equal($("f-err").textContent, "");
  assert.equal($("f-address").value, RECIP());
  assert.ok(!$("f-out").classList.contains("hidden"), "fund panel opened");
  $("f-check").click(); await tick(60);
  assert.equal($("f-err").textContent, "", "check error box empty");
  assert.equal(tableRows($)("f-table").length, 1, "one donation row");
  assert.match($("f-meta").textContent, /funding/, "status funding");
  assert.match($("f-meta").textContent, /50 PRL/, "raised shown");
  assert.match($("f-meta").textContent, /900050/, "tip shown");
  // Air-gapped path: manual records, labeled unverified.
  $("f-airtx").value = JSON.stringify([{ txid: "cd".repeat(32), valueGrains: 700000000, blockHeight: 900100 }]);
  $("f-airload").click(); await tick(60);
  assert.match($("f-meta").textContent, /NOT verified/, "offline records labeled");
  assert.match($("f-meta").textContent, /7 PRL/, "manual total shown");
});

test("receipts flow: issue -> ledger -> export -> delete", async () => {
  const { $, sandbox } = bootApp();
  sandbox.__recip = RECIP();
  await forgeCampaignDom($);
  $("r-load").click(); await tick();
  assert.equal($("r-err").textContent, "");
  assert.ok(!$("r-out").classList.contains("hidden"), "receipts panel opened");
  $("r-donor").value = "lantern-fan";
  $("r-txid").value = "ab".repeat(32);
  $("r-amount").value = "5";
  $("r-height").value = "900040";
  $("r-add").click(); await tick();
  assert.equal($("r-err").textContent, "", "issue error box empty");
  assert.equal(tableRows($)("r-table").length, 1, "one receipt row");
  assert.match($("r-total").textContent, /5 PRL/, "total shows 5 PRL");
  assert.match($("r-total").textContent, /1 donor/, "donor counted");
  // Anonymous default.
  $("r-donor").value = "";
  $("r-txid").value = "cd".repeat(32);
  $("r-amount").value = "1";
  $("r-height").value = "";
  $("r-add").click(); await tick();
  assert.equal(tableRows($)("r-table").length, 2, "two receipt rows");
  // Export + print paths must not throw.
  $("r-exportcsv").click(); await tick();
  $("r-exportjson").click(); await tick();
  $("r-print").click(); await tick();
  assert.ok($("r-printarea").innerHTML.includes("lantern-fan"), "print area built");
  // Delete one row via its button.
  const delBtns = $("r-table").querySelectorAll("button[data-del]");
  assert.equal(delBtns.length, 2, "two delete buttons");
  delBtns[0].click(); await tick();
  assert.equal(tableRows($)("r-table").length, 1, "one row after delete");
  // Clear all.
  $("r-clear").click(); await tick();
  assert.equal(tableRows($)("r-table").length, 0, "ledger cleared");
});

test("track flow: refresh renders meter + stats", async () => {
  const { $, sandbox } = bootApp();
  sandbox.__recip = RECIP();
  sandbox.__txid = "ab".repeat(32);
  await forgeCampaignDom($);
  // Issue a receipt so the donor count is real.
  $("r-load").click(); await tick();
  $("r-donor").value = "tracker";
  $("r-txid").value = "ab".repeat(32);
  $("r-amount").value = "50";
  $("r-add").click(); await tick();
  $("t-load").click(); await tick();
  assert.ok(!$("t-out").classList.contains("hidden"), "track panel opened");
  $("t-refresh").click(); await tick(60);
  assert.equal($("t-err").textContent, "", "refresh error box empty");
  assert.match($("t-pct").textContent, /50\.0%/, "50% of goal");
  assert.match($("t-raised").textContent, /50 PRL/, "raised shown");
  assert.match($("t-goal").textContent, /100 PRL/, "goal shown");
  assert.equal($("t-donors").textContent, "1", "one ledger donor");
  assert.match($("t-deadline").textContent, /901000/, "deadline height shown");
  assert.match($("t-deadline").textContent, /approximate/, "countdown labeled approximate");
  assert.equal(tableRows($)("t-table").length, 1, "one donation row");
  assert.match($("t-meta").textContent, /funding/, "status shown");
});

test("verify tab: descriptor + tamper refusal + receipt hash + cross-check", async () => {
  const { $, sandbox } = bootApp();
  sandbox.__recip = RECIP();
  sandbox.__txid = "ab".repeat(32);
  await forgeCampaignDom($);
  $("v-network").value = "mainnet";
  $("v-verifydesc").click(); await tick();
  assert.match($("v-descout").textContent, /DESCRIPTOR VERIFIED/, "descriptor verifies");
  assert.match($("v-descout").textContent, /safe to fund/, "funding guidance shown");
  assert.match($("v-descout").textContent, /unsigned/, "authorship state shown");
  // Tampered descriptor (deadline +1) is refused.
  $("v-descriptor").value = $("v-descriptor").value.replace(/:901000$/, ":901001");
  $("v-verifydesc").click(); await tick();
  assert.match($("v-descout").textContent, /REFUSED/, "tampered descriptor refused");
  // Receipt: hash check then live cross-check.
  const c = B.parseCampaignSpec($("v-spec").value, B.NETWORKS.mainnet);
  const r = B.recordReceipt({ campaign: c, donor: "lantern-fan", txid: "ab".repeat(32), amountPRL: "5" });
  $("v-receipt").value = JSON.stringify(r);
  $("v-verifyreceipt").click(); await tick();
  assert.match($("v-receiptout").textContent, /RECEIPT HASH MATCHES/, "hash matches");
  $("v-crosscheck").click(); await tick(60);
  assert.match($("v-receiptout").textContent, /RECEIPT PROVEN/, "receipt proven on-chain");
  // Unknown txid → NOT PROVEN with a reason.
  const r2 = B.recordReceipt({ campaign: c, donor: "ghost", txid: "ff".repeat(32), amountPRL: "1" });
  $("v-receipt").value = JSON.stringify(r2);
  $("v-crosscheck").click(); await tick(60);
  assert.match($("v-receiptout").textContent, /NOT PROVEN/, "unknown tx not proven");
  assert.match($("v-receiptout").textContent, /not found/, "reason explains");
});
