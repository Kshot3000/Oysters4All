// Pearl Ballot DOM integration test — boots the real index.html + committed
// bundle (pearl-ballot.bundle.js) + app.js against a minimal DOM shim and a
// stubbed Blockbook. Drives: draft refusal -> forged descriptor -> publish
// commitment -> vote proposal verify -> wrong-key loud refusal -> right-key
// sign -> weight label -> wipe -> tally import -> duplicate report -> winner;
// verify standalone: proven + NOT PROVEN; footer attribution.
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

/* ---------- minimal DOM (same lineage as the other apps' DOM suites) ---------- */
class ClassList {
  constructor() { this.s = new Set(); }
  add(...c) { c.forEach((x) => this.s.add(x)); }
  remove(...c) { c.forEach((x) => this.s.delete(x)); }
  toggle(c, f) { (f ?? !this.s.has(c)) ? this.s.add(c) : this.s.delete(c); }
  contains(c) { return this.s.has(c); }
}
class El {
  constructor(tag, id = "") {
    this.tagName = tag.toUpperCase(); this.id = id;
    this.classList = new ClassList(); this.dataset = {};
    this.value = ""; this.textContent = ""; this._html = "";
    this.hidden = false; this.disabled = false; this.checked = false;
    this.style = {}; this._handlers = {}; this._kids = [];
    this.scrollTop = 0; this.scrollHeight = 0; this.files = null;
  }
  set innerHTML(v) { this._html = String(v); this._kids = []; }
  get innerHTML() { return this._html; }
  addEventListener(t, fn) { (this._handlers[t] ??= []).push(fn); }
  click() { (this._handlers.click || []).forEach((f) => f({ target: this, preventDefault() {} })); }
  fire(t, extra = {}) { (this._handlers[t] || []).forEach((f) => f({ target: this, preventDefault() {}, ...extra })); }
  appendChild(k) { this._kids.push(k); return k; }
  removeChild(k) { this._kids = this._kids.filter((x) => x !== k); return k; }
  remove() {}
  get children() { return this._kids; }
  get firstChild() { return this._kids[0]; }
  querySelectorAll() { return []; }
  querySelector() { return null; }
  scrollIntoView() {}
  select() {}
}
const byId = new Map();
const hiddenIds = new Set([...html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*\bhidden\b[^>]*>/g)].map((m) => m[1]));
const getEl = (id) => {
  if (!byId.has(id)) {
    const el = new El("div", id);
    if (hiddenIds.has(id)) el.hidden = true;
    const tagM = html.match(new RegExp(`<(?:input|select|textarea)[^>]*\\bid="${id}"[^>]*>`, "i"));
    if (tagM) {
      const tag = tagM[0];
      const valM = tag.match(/\bvalue="([^"]*)"/i);
      if (valM) el.value = valM[1];
      if (/\bchecked\b/i.test(tag)) el.checked = true;
    }
    byId.set(id, el);
  }
  return byId.get(id);
};
const documentShim = {
  getElementById: getEl,
  querySelectorAll: () => [],
  querySelector: () => null,
  createElement: (t) => new El(t),
  body: new El("body"),
};

/* ---------- stubbed Blockbook ---------- */
const fetchCalls = [];
async function stubFetch(url, opts = {}) {
  const u = String(url);
  fetchCalls.push({ url: u, method: opts.method || "GET" });
  const path = u.replace(/^https?:\/\/[^/]+/, "");
  const body = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
  if (path === "/api/v2") return body({ backend: { blocks: 120150 } });
  if (path.startsWith("/api/v2/address/")) return body({ balance: "5000000" });
  return { ok: false, status: 404, text: async () => "not found" };
}

const sandbox = {
  document: documentShim,
  navigator: { clipboard: { writeText: async () => {} } },
  TextDecoder, TextEncoder, crypto: webcrypto, fetch: stubFetch,
  Blob, URL,
  setTimeout, clearTimeout, setInterval, clearInterval,
  scrollTo() {},
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(resolvePath(dir, "pearl-ballot.bundle.js"), "utf8"), sandbox, { filename: "pearl-ballot.bundle.js" });
vm.runInContext(fs.readFileSync(resolvePath(dir, "app.js"), "utf8"), sandbox, { filename: "app.js" });

const E = sandbox.PearlBallot;
assert.ok(E, "bundle booted as window.PearlBallot");

const $ = (id) => getEl(id);
const t = (id) => $(id).textContent;
const PIN_DESC = "pearl-ballot:v1:prl:9d5bc9f1fcfacc1f898d00be4b1782445df3d3ae119c54c93c529569181bca4b:120100:120200:120000:aa03e90d8276a7557913ec29fd561eb9e2e47ad2cd113532714b4e97b3a90027";
const PIN_PROPOSAL = JSON.stringify({
  title: "Treasury grant: Harbor Node Relay",
  description: "Fund a community relay node for 12 months.",
  options: ["Yes, fund it", "No, decline"],
  startH: 120100, endH: 120200, snapshotH: 120000,
}, null, 2);
const PRIV1 = "0f".repeat(32), PRIV2 = "1f".repeat(32);
const W1 = E.walletFromPriv(PRIV1, E.NETWORKS.mainnet);
const W2 = E.walletFromPriv(PRIV2, E.NETWORKS.mainnet);
const D = E.parseDescriptor(PIN_DESC);

function mkBallot(w, choice, weight, nonce) {
  return E.signBallot({
    tweakedPriv: E.ballotSigningKey(w),
    fields: { network: E.NETWORKS.mainnet, descriptorHash: D.descriptorHash, voter: w.address, choice, weightGrains: BigInt(weight), snapshotH: 120000, nonce },
  });
}
const tick = (ms = 250) => new Promise((r) => setTimeout(r, ms));

test("draft: empty title refused; valid draft forges the descriptor", () => {
  $("bt-title").value = "";
  $("bt-desc").value = "x";
  $("bt-options").value = "Yes\nNo";
  $("bt-startH").value = "120100"; $("bt-endH").value = "120200"; $("bt-snapshotH").value = "120000";
  $("bt-tip-manual").value = "120000";
  $("bt-draft").click();
  assert.match(t("bt-error"), /needs a title/);
  $("bt-title").value = "Treasury grant: Harbor Node Relay";
  $("bt-desc").value = "Fund a community relay node for 12 months.";
  $("bt-draft").click();
  assert.equal(t("bt-error"), "");
  assert.ok(!$("bt-out").hidden);
  assert.match(t("bt-descriptor"), /^pearl-ballot:v1:prl:[0-9a-f]{64}:120100:120200:120000:[0-9a-f]{64}$/);
});

test("publish: commitment panel renders the forge", () => {
  $("bt-to-publish").click();
  assert.ok(!$("bt-pub-out").hidden);
  assert.equal(t("bt-pub-dhash"), E.parseDescriptor(t("bt-pub-desc")).descriptorHash);
  assert.match(t("bt-pub-window"), /120100 → 120200/);
  assert.ok($("bt-pub-json").value.includes("Treasury grant"));
});

test("vote: proposal verify -> wrong key loud refusal -> right key signs", async () => {
  $("bt-vote-descriptor").value = PIN_DESC;
  $("bt-vote-proposal").value = PIN_PROPOSAL;
  $("bt-vote-load").click();
  assert.equal($("bt-vote-choice").children.length, 2);
  assert.ok(!$("bt-vote-proposal-out").hidden);
  assert.match(t("bt-vote-phash"), /✓ matches descriptor/);
  $("bt-vote-addr").value = W1.address;
  $("bt-vote-choice").value = "0";
  $("bt-vote-key").value = E.walletToWIF(E.hexToBytes(PRIV2), E.NETWORKS.mainnet); // wrong key
  $("bt-vote-sign").click();
  await tick();
  assert.match(t("bt-vote-error"), /LOUD REFUSAL/);
  assert.ok($("bt-vote-out").hidden);
  $("bt-vote-key").value = E.walletToWIF(E.hexToBytes(PRIV1), E.NETWORKS.mainnet); // right key
  $("bt-vote-sign").click();
  await tick();
  assert.equal(t("bt-vote-error"), "", t("bt-vote-error"));
  assert.ok(!$("bt-vote-out").hidden, "signed ballot panel shown");
  const signed = JSON.parse($("bt-vote-json").value);
  assert.equal(signed.protocol, "pearl-ballot-ballot");
  assert.equal(signed.voter, W1.address);
  assert.equal(signed.weightGrains, "5000000");
  assert.match(t("bt-vote-weight"), /0\.05 PRL/);
  assert.match(t("bt-vote-weight"), /CURRENT confirmed balance/);
  $("bt-vote-wipe").click();
  assert.equal($("bt-vote-key").value, "");
});

test("tally: import -> totals -> duplicate report -> winner -> result record", async () => {
  $("bt-tally-descriptor").value = PIN_DESC;
  $("bt-tally-proposal").value = PIN_PROPOSAL;
  const b1 = mkBallot(W1, 0, 5000000, "aabbccddeeff0011");
  const b2 = mkBallot(W2, 1, 3000000, "aabbccddeeff0022");
  const b1dup = mkBallot(W1, 1, 9000000, "aabbccddeeff0033");
  $("bt-tally-ballots").value = JSON.stringify([b1, b2, b1dup]);
  $("bt-tally-add").click();
  assert.match(t("bt-tally-count"), /3 ballots imported/);
  $("bt-tally-tip-manual").value = "120150";
  $("bt-tally-run").click();
  await tick();
  assert.equal(t("bt-tally-error"), "", t("bt-tally-error"));
  assert.ok(!$("bt-tally-out").hidden);
  assert.match(t("bt-tally-winner"), /Winner: option 0/);
  assert.match(t("bt-tally-record"), /^pearl-ballot-result:v1:9067b2e7e92ea84319f35a6984098a58322c762efa6cab04526e72cef6a7e4fb:0:8000000:2:[0-9a-f]{64}$/);
  assert.ok(!$("bt-tally-dups").hidden, "duplicate report shown");
  assert.equal($("bt-tally-dups-list").children.length, 1);
  assert.equal($("bt-tally-tbody").children.length, 2, "two accepted ballots");
  assert.equal($("bt-tally-totals").children.length, 2, "two option total rows");
  assert.match($("bt-tally-totals").children[0].innerHTML, /Yes, fund it/);
});

test("verify: proven poll + tampered proposal -> NOT PROVEN", () => {
  const b1 = mkBallot(W1, 0, 5000000, "aabbccddeeff0011");
  const b2 = mkBallot(W2, 1, 3000000, "aabbccddeeff0022");
  $("bt-ver-proposal").value = PIN_PROPOSAL;
  $("bt-ver-ballots").value = JSON.stringify([b1, b2]);
  $("bt-ver-run").click();
  assert.equal(t("bt-ver-error"), "");
  assert.ok(!$("bt-ver-out").hidden);
  assert.match(t("bt-ver-head"), /PROVEN/);
  assert.match(t("bt-ver-record"), /^pearl-ballot-result:v1:/);
  // tamper the proposal title -> NOT PROVEN
  const bad = JSON.parse(PIN_PROPOSAL); bad.title += " (edited)";
  $("bt-ver-proposal").value = JSON.stringify(bad);
  $("bt-ver-run").click();
  assert.match(t("bt-ver-error"), /NOT PROVEN/);
});

test("footer carries @kshot9000 + the exact donation address", () => {
  assert.ok(html.includes("https://x.com/kshot9000"), "x link");
  assert.ok(html.includes("prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d"), "donation address");
});

test("five steps + honest limits + cache-busted assets", () => {
  for (const s of ["draft", "publish", "vote", "tally", "verify"]) {
    assert.ok(html.includes(`id="step-${s}"`), `step-${s} section`);
    assert.ok(html.includes(`data-step="${s}"`), `nav ${s}`);
  }
  assert.ok(html.includes('id="honest-limits"'), "honest limits panel");
  assert.ok(html.includes('src="pearl-ballot.bundle.js?v=1"'), "bundle cache key");
  assert.ok(html.includes('src="app.js?v=1"'), "app.js cache key");
  assert.ok(html.includes('href="styles.css?v=3"'), "css cache key");
});
