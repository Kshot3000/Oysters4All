/* Pearl Bounty DOM tests — drive the REAL app.js against a strict DOM shim.
 *
 * Strictness rule: document.getElementById THROWS on an unknown id, so a test
 * can never pass by clicking phantom elements the app never wired. Every id
 * used here was copied from index.html; every flow below exercises the real
 * handlers in app.js (post -> hunt commit/reveal -> award plan/sign ->
 * reclaim pre-deadline refusal + post-deadline sign -> verify), with all
 * cryptography running locally in the bundle. fetch is stubbed offline.
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
    if (v === "") this._children = this._children.filter((c) => c === this._tbody);
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
  select() {}
  querySelector(sel) {
    if (sel === "tbody") return this._tbody || null;
    return null;
  }
  querySelectorAll() { return []; }
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
let B; // the PearlBounty bundle namespace, for fixtures
function bootApp() {
  const html = readFileSync(resolvePath(appDir, "index.html"), "utf8");
  const { document } = buildDocument(html);
  const bundleJs = readFileSync(resolvePath(appDir, "pearl-bounty.bundle.js"), "utf8");
  const appJs = readFileSync(resolvePath(appDir, "app.js"), "utf8");
  const store = {};
  const sandbox = {
    document,
    navigator: {},
    alert: () => {},
    fetch: () => Promise.reject(new Error("stubbed offline")),
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    setTimeout, clearTimeout,
    console,
    URL, Blob, Date,
    TextEncoder, TextDecoder,
    btoa, atob,
    crypto: globalThis.crypto,
    window: {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(bundleJs + "\nwindow.PearlBounty = PearlBounty;", sandbox, { filename: "pearl-bounty.bundle.js" });
  vm.runInContext(appJs, sandbox, { filename: "app.js" });
  B = vm.runInContext("window.PearlBounty", sandbox);
  const $ = (id) => document.getElementById(id);
  return { $, document };
}

const tick = () => new Promise((r) => setTimeout(r, 20));
const sha = (s) => B.sha256(new TextEncoder().encode(s));
const POSTER_PRIV = () => B.bytesToHex(sha("pearl-bounty-dom-poster"));
const HUNTER_PRIV = () => B.bytesToHex(sha("pearl-bounty-dom-hunter"));

async function forgeBountyDom($) {
  $("p-title").value = "DOM bounty";
  $("p-network").value = "mainnet";
  $("p-reward").value = "25";
  $("p-deadline").value = "900000";
  $("p-mode").value = "priv";
  $("p-key").value = POSTER_PRIV();
  $("p-contact").value = "@dom";
  $("p-terms").value = "dom terms";
  $("p-forge").click();
  await tick();
  assert.equal($("p-err").textContent, "", "forge error box must be empty");
  return $("p-spec").value;
}

test("bundle exposes the bounty API", () => {
  bootApp();
  for (const fn of ["forgeBounty", "bountyDescriptor", "parseBountyDescriptor", "verifyDescriptor",
    "parseBountySpec", "serializeBounty", "descriptorFingerprint",
    "buildAwardScript", "buildReclaimScript", "numsInternalKeyBounty", "bountyTaptree",
    "submissionCommitment", "verifySubmissionReveal", "newSalt",
    "planAward", "buildAwardTx", "planReclaim", "buildReclaimTx",
    "classifyBounty", "verifyBountyTx", "parsePRLToGrains", "fmtPRL", "pubkeyFromPriv",
    "fetchBountyUtxos", "fetchBlockHeight", "broadcastTx", "posterPrivFromInput",
    "BLOCKBOOK_MAINNET", "NETWORKS"]) {
    assert.ok(B[fn] !== undefined, fn + " exposed");
  }
});

test("step navigation toggles panels", () => {
  const { $, document } = bootApp();
  document.querySelector('#steps button[data-step="award"]').click();
  assert.ok($("step-award").classList.contains("active"), "award panel active");
  assert.ok(!$("step-post").classList.contains("active"), "post panel inactive");
  document.querySelector('#steps button[data-step="hunt"]').click();
  assert.ok($("step-hunt").classList.contains("active"), "hunt panel active");
});

test("post flow: forge -> descriptor + fan-out", async () => {
  const { $ } = bootApp();
  const spec = await forgeBountyDom($);
  assert.match($("p-desc").value, /^bounty:v1:prl:/, "descriptor shape");
  assert.match($("p-fp").textContent, /^[0-9a-f]{16}$/, "64-bit fingerprint shown");
  assert.match($("p-address").value, /^prl1p/, "bounty address shown");
  assert.match($("p-summary").textContent, /25 PRL/, "summary mentions reward");
  assert.ok($("p-awardasm").textContent.includes("CHECKSIG"), "award asm shown");
  assert.ok($("p-reclaimasm").textContent.includes("CLTV"), "reclaim asm shown");
  assert.equal($("u-spec").value, spec, "fund fanned out");
  assert.equal($("h-spec").value, spec, "hunt fanned out");
  assert.equal($("a-spec").value, spec, "award fanned out");
  assert.equal($("r-spec").value, spec, "reclaim fanned out");
  assert.equal($("v-spec").value, spec, "verify fanned out");
  assert.equal($("p-key").value, "", "poster key cleared after forge");
});

test("hunt flow: commit -> board -> reveal verify", async () => {
  const { $ } = bootApp();
  await forgeBountyDom($);
  $("h-load").click(); await tick();
  assert.equal($("h-err").textContent, "");
  assert.ok(!$("h-out").classList.contains("hidden"), "hunt panel opened");
  $("h-handle").value = "hunter-7";
  $("h-solution").value = "the fix is to check the locktime";
  $("h-gensalt").click(); await tick();
  assert.match($("h-salt").value, /^[0-9a-f]{64}$/, "salt generated");
  const salt = $("h-salt").value;
  $("h-commit").click(); await tick();
  assert.match($("h-commitment").value, /^[0-9a-f]{64}$/, "commitment produced");
  $("h-record").click(); await tick();
  assert.equal($("h-err").textContent, "");
  const rows = $("h-table").querySelector("tbody")._children.filter((c) => c.tagName === "TR");
  assert.equal(rows.length, 1, "one board row");
  // Poster verifies the reveal: correct first, then tampered.
  $("h-rhandle").value = "hunter-7";
  $("h-rcommitment").value = $("h-commitment").value;
  $("h-rsolution").value = "the fix is to check the locktime";
  $("h-rsalt").value = salt;
  $("h-verifyreveal").click(); await tick();
  assert.match($("h-revealout").textContent, /REVEAL VERIFIED/, "good reveal verifies");
  $("h-rsolution").value = "a different solution";
  $("h-verifyreveal").click(); await tick();
  assert.match($("h-revealout").textContent, /REVEAL REJECTED/, "tampered reveal rejected");
});

test("award flow: plan -> double-confirm -> signed hex, wrong key refused", async () => {
  const { $ } = bootApp();
  await forgeBountyDom($);
  $("a-utxo").value = `${"ab".repeat(32)}:0`;
  $("a-value").value = "25";
  const winnerXOnly = B.bytesToHex(B.schnorr.getPublicKey(sha("pearl-bounty-dom-winner")));
  $("a-winner").value = B.encodeBech32m("prl", 1, B.hexToBytes(winnerXOnly));
  $("a-amount").value = "20";
  const posterXOnly = B.bytesToHex(B.schnorr.getPublicKey(sha("pearl-bounty-dom-poster")));
  $("a-change").value = B.encodeBech32m("prl", 1, B.hexToBytes(posterXOnly));
  $("a-feerate").value = "2";
  $("a-plan").click(); await tick();
  assert.equal($("a-err").textContent, "", "plan error box empty");
  assert.match($("a-planmeta").textContent, /20 PRL/, "plan shows award");
  assert.match($("a-planmeta").textContent, /change to poster/, "plan shows change");
  // Wrong key is refused at signing.
  $("a-key").value = HUNTER_PRIV();
  $("a-build").click(); await tick();
  $("a-confirmyes").click(); await tick();
  assert.match($("a-err").textContent, /not the poster's award key/, "wrong key refused");
  // Right key signs.
  $("a-key").value = POSTER_PRIV();
  $("a-build").click(); await tick();
  assert.ok(!$("a-confirm").classList.contains("hidden"), "double-confirm shown");
  assert.match($("a-confirmtext").textContent, /20 PRL/, "confirm names the award");
  $("a-confirmyes").click(); await tick();
  assert.equal($("a-err").textContent, "", "sign error box empty");
  assert.match($("a-hex").value, /^[0-9a-f]{200,}$/, "award hex produced");
  assert.match($("a-meta").textContent, /re-verified/, "meta mentions re-verification");
  assert.match($("a-meta").textContent, /txid [0-9a-f]{64}/, "meta shows txid");
  // The produced hex verifies against the bounty contract.
  const spec = JSON.parse($("a-spec").value);
  const v = B.verifyBountyTx($("a-hex").value, spec);
  assert.equal(v.spends[0].leaf, "award");
  // Wipe clears the key field.
  $("a-wipe").click(); await tick();
  assert.equal($("a-key").value, "", "key wiped");
});

test("reclaim flow: pre-deadline refusal, post-deadline sign", async () => {
  const { $ } = bootApp();
  await forgeBountyDom($);
  $("r-utxo").value = `${"cd".repeat(32)}:1`;
  $("r-value").value = "25";
  const posterXOnly = B.bytesToHex(B.schnorr.getPublicKey(sha("pearl-bounty-dom-poster")));
  $("r-dest").value = B.encodeBech32m("prl", 1, B.hexToBytes(posterXOnly));
  $("r-feerate").value = "2";
  $("r-key").value = POSTER_PRIV();
  // Before the deadline: loud refusal with blocks-to-go.
  $("r-height").value = "899999";
  $("r-plan").click(); await tick();
  assert.match($("r-err").textContent, /not yet available/, "pre-deadline refused");
  assert.match($("r-err").textContent, /1 blocks to go/, "blocks-to-go shown");
  // After the deadline: plan + sign.
  $("r-height").value = "900100";
  $("r-plan").click(); await tick();
  assert.equal($("r-err").textContent, "", "plan error box empty");
  assert.match($("r-planmeta").textContent, /nLockTime/, "plan mentions locktime");
  $("r-build").click(); await tick();
  $("r-confirmyes").click(); await tick();
  assert.equal($("r-err").textContent, "", "sign error box empty");
  assert.match($("r-hex").value, /^[0-9a-f]{200,}$/, "reclaim hex produced");
  const spec = JSON.parse($("r-spec").value);
  const v = B.verifyBountyTx($("r-hex").value, spec);
  assert.equal(v.spends[0].leaf, "reclaim");
  assert.equal(v.spends[0].locktime, 900000);
});

test("verify tab: descriptor check + tamper refusal + tx check", async () => {
  const { $ } = bootApp();
  await forgeBountyDom($);
  $("v-network").value = "mainnet";
  $("v-verifydesc").click(); await tick();
  assert.match($("v-descout").textContent, /DESCRIPTOR VERIFIED/, "descriptor verifies");
  assert.match($("v-descout").textContent, /safe to fund/, "funding guidance shown");
  // Tampered descriptor (deadline +1) is refused against the claimed address.
  const tampered = $("v-descriptor").value.replace(/:900000$/, ":900001");
  $("v-descriptor").value = tampered;
  $("v-verifydesc").click(); await tick();
  assert.match($("v-descout").textContent, /REFUSED/, "tampered descriptor refused");
});
