// Pearl Registry DOM integration test — boots the real index.html + committed
// bundle (pearl-registry.bundle.js) + app.js against a minimal DOM shim and a
// stubbed Pearlscriptions indexer + Blockbook. Drives: directory scan (first-
// seen resolution, losing-claim + wrong-owner rejections), handle lookup,
// claim wizard (invalid handle, squatting guard, owner validation, WIF key,
// exact plan math, double-confirm commit+reveal broadcast), standalone pair
// verifier (valid pair verifies, tampered pair refused), verifier tab
// (tampered content refused, losing claim loses, released claim verified,
// valid transfer verified), footer attribution.
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
    this.scrollTop = 0; this.scrollHeight = 0;
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

/* ---------- stubbed indexer + blockbook ---------- */
const IDX = "https://idx.example";
const BB = "https://bb.example";
const OWNER_A = "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d";
const OWNER_B = "prl1qdifferentowner00000000000000000000000000000000000000000";

const F = {}; // inscription fixtures, filled after bundle boot

function jsonBody(o) {
  return { ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) };
}
async function stubFetch(url, opts = {}) {
  const u = String(url);
  const path = u.replace(/^https?:\/\/[^/]+/, "");
  if (u.startsWith(IDX)) {
    if (path === "/inscriptions" || path.startsWith("/inscriptions?")) {
      return jsonBody({ inscriptions: F.rows });
    }
    const m = path.match(/^\/inscriptions\/([^/]+)(\/content)?$/);
    if (m) {
      const rec = F.byId[m[1]];
      if (!rec) return { ok: false, status: 404, json: async () => ({}), text: async () => "not found" };
      if (m[2]) return jsonBody({ bodyText: rec.bodyText });
      return jsonBody({ inscription: { id: m[1], inscriptionNumber: rec.n } });
    }
  }
  if (u.startsWith(BB)) {
    if (path.startsWith("/api/v2/utxo/")) {
      return jsonBody([{ txid: "ab".repeat(32), vout: 0, value: 50000, confirmations: 6 }]);
    }
    if (path.startsWith("/api/v2/estimatefee/")) return jsonBody({ result: "0.00005" }); // 5 gr/vB
    if (path.endsWith("/api/sendtx/")) return jsonBody({ result: "e".repeat(64) });
  }
  return { ok: false, status: 404, json: async () => ({}), text: async () => "not found" };
}

const sandbox = {
  document: documentShim,
  navigator: { clipboard: { writeText: async () => {} } },
  TextDecoder, crypto: webcrypto, fetch: stubFetch,
  setTimeout, clearTimeout, setInterval, clearInterval,
  scrollTo() {},
  console,
  Date,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
{
  const OuterTE = TextEncoder;
  const VMUint8Array = vm.runInContext("Uint8Array", sandbox);
  sandbox.TextEncoder = class extends OuterTE {
    encode(s) { return new VMUint8Array(super.encode(s)); }
  };
}
for (const f of ["pearl-registry.bundle.js", "app.js"]) {
  vm.runInContext(fs.readFileSync(resolvePath(dir, f), "utf8"), sandbox, { filename: f, timeout: 15000 });
}

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const R = sandbox.PearlRegistry;
assert.ok(R, "bundle exposes window.PearlRegistry");

/* fixture wallet + addresses (OWNER_B is a real derived address so the
 * fixtures carry valid bech32m throughout) */
const W2 = R.walletFromPriv("ab".repeat(32), R.NETWORKS.mainnet);
const OWNER_B_REAL = W2.address;
{
  const rows = [
    { id: "claim1", n: 10, ct: "application/json", body: R.buildClaimJson({ handle: "satoshi", owner: OWNER_A, ts: 1 }) },
    { id: "claim2", n: 20, ct: "application/json", body: R.buildClaimJson({ handle: "satoshi", owner: OWNER_B_REAL, ts: 2 }) }, // loses
    { id: "xfer1", n: 30, ct: "application/json", body: R.buildTransferJson({ handle: "satoshi", from: OWNER_A, to: OWNER_B_REAL, ts: 3 }) },
    { id: "bad1", n: 40, ct: "application/json", body: R.buildTransferJson({ handle: "satoshi", from: OWNER_A, to: OWNER_B_REAL, ts: 4 }) }, // wrong owner: OWNER_A already transferred away at #30
    { id: "rel1", n: 50, ct: "application/json", body: R.buildReleaseJson({ handle: "satoshi", from: OWNER_B_REAL, ts: 5 }) },
    { id: "img1", n: 60, ct: "image/png", body: "" }, // not a candidate
    { id: "tamper1", n: 70, ct: "application/json", body: JSON.stringify({ p: "prl-name", op: "claim", handle: "SATOSHI", owner: OWNER_A, ts: 6 }) }, // non-canonical
    { id: "pearl1", n: 80, ct: "application/json", body: R.buildClaimJson({ handle: "pearl", owner: OWNER_B_REAL, ts: 7 }) },
  ];
  F.rows = rows.map((r) => ({ id: r.id, inscriptionNumber: r.n, contentType: r.ct }));
  F.byId = Object.fromEntries(rows.map((r) => [r.id, { n: r.n, bodyText: r.body }]));
}

const PRIV_HEX = "0f".repeat(32);
const W = R.walletFromPriv(PRIV_HEX, R.NETWORKS.mainnet);
const WIF = R.walletToWIF(R.hexToBytes(PRIV_HEX), R.NETWORKS.mainnet);

test("boot: bundle + app wired, footer carries @kshot9000 and the exact donation address", () => {
  assert.ok(typeof R.planNameClaim === "function");
  assert.equal(R.DONATE_ADDRESS, "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d");
  assert.ok(html.includes("prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d"), "donation address in footer");
  assert.ok(html.includes("https://x.com/kshot9000"), "x link in footer");
  assert.ok(html.includes("Registrar's notice"), "honest-limits panel present");
  assert.ok(html.includes("sample of indexed data"), "honest scan wording present");
  assert.ok(html.includes('src="pearl-registry.bundle.js?v=3"'), "cache-busted bundle script");
  assert.ok(html.includes('src="app.js?v=2"'), "cache-busted app script");
  assert.ok(html.includes('href="styles.css?v=5"'), "cache-busted stylesheet");
});

test("directory scan builds the register with first-seen resolution", async () => {
  getEl("idx-base").value = IDX;
  getEl("idx-base").fire("change");
  getEl("idx-scan").click();
  for (let i = 0; i < 200 && getEl("idx-scan").disabled; i++) await tick();
  const results = getEl("dir-results").innerHTML;
  assert.ok(results.includes("satoshi"), "satoshi plate rendered");
  assert.ok(results.includes("pearl"), "pearl plate rendered");
  assert.ok(!results.includes("SATOSHI"), "non-canonical record never becomes a handle");
  const status = getEl("idx-status").innerHTML;
  assert.ok(status.includes("<strong>2</strong> handle(s)"), `two handles resolved, got: ${status.slice(0, 200)}`);
  assert.ok(status.includes("<strong>2 rejected</strong>"), `losing claim + wrong-owner transfer rejected, got: ${status.slice(0, 220)}`);
});

test("handle lookup: released satoshi, owned pearl, free nobody", () => {
  getEl("dir-search").value = "satoshi";
  getEl("dir-lookup").click();
  assert.ok(getEl("dir-lookup-out").innerHTML.includes("was released"), "satoshi shows released");
  getEl("dir-search").value = "pearl";
  getEl("dir-lookup").click();
  const pearl = getEl("dir-lookup-out").innerHTML;
  assert.ok(pearl.includes("is owned"), "pearl shows owned");
  assert.ok(pearl.includes(OWNER_B_REAL), "pearl owner is the first claimant");
  getEl("dir-search").value = "nobody-home";
  getEl("dir-lookup").click();
  assert.ok(getEl("dir-lookup-out").innerHTML.includes("is free in this scan"), "unknown handle shows free");
  getEl("dir-search").value = "bad--handle";
  getEl("dir-lookup").click();
  assert.ok(getEl("dir-lookup-out").innerHTML.includes("Invalid handle"), "bad handle refused");
});

test("claim wizard step 1: validation + squatting guard", () => {
  getEl("cw-handle").value = "Bad--Handle!";
  getEl("cw-check").click();
  assert.ok(getEl("cw-handle-status").innerHTML.includes("Invalid handle"), "invalid handle refused");
  assert.equal(getEl("cw-to2").disabled, true, "cannot continue with bad handle");
  getEl("cw-handle").value = "pearl";
  getEl("cw-check").click();
  assert.ok(getEl("cw-squat").innerHTML.includes("Taken in this scan"), "squatting guard flags owned handle");
  getEl("cw-handle").value = "fresh-handle-9";
  getEl("cw-check").click();
  assert.ok(getEl("cw-handle-status").innerHTML.includes("well-formed"), "good handle accepted");
  assert.ok(getEl("cw-squat").innerHTML.includes("Looks free in this scan"), "free handle reported honestly");
  assert.equal(getEl("cw-to2").disabled, false, "can continue");
  getEl("cw-to2").click();
});

test("claim wizard step 2: owner address validation gates continue", () => {
  getEl("cw-owner").value = "not-an-address";
  getEl("cw-owner").fire("input");
  assert.ok(getEl("cw-owner-status").innerHTML.includes("Invalid owner address"), "bad address refused");
  assert.equal(getEl("cw-to3").disabled, true);
  getEl("cw-owner").value = W.address;
  getEl("cw-owner").fire("input");
  assert.ok(getEl("cw-owner-status").innerHTML.includes("Owner address valid"), "good address accepted");
  assert.equal(getEl("cw-to3").disabled, false);
  getEl("cw-to3").click();
});

test("claim wizard step 3: key, exact plan math, double-confirm broadcast", async () => {
  getEl("cw-wif").value = "definitely-not-a-wif";
  getEl("cw-unlock").click();
  assert.ok(getEl("cw-keystatus").innerHTML.includes("Key rejected"), "bad WIF refused");
  getEl("cw-wif").value = WIF;
  getEl("cw-unlock").click();
  assert.ok(getEl("cw-keystatus").innerHTML.includes(W.address), "key loaded, address shown");
  assert.equal(getEl("cw-wif").value, "", "WIF cleared from the input after load");

  getEl("cw-blockbook").value = BB;
  getEl("cw-blockbook").fire("change");
  getEl("cw-fee").value = "5";
  getEl("cw-plan").click();
  for (let i = 0; i < 200 && !getEl("cw-plan-out").innerHTML; i++) await tick();
  const plan = getEl("cw-plan-out").innerHTML;
  assert.ok(plan.includes("prl-name"), "plan uses the prl-name marker");
  assert.ok(plan.includes("Total fees"), "exact fee math rendered");
  assert.ok(plan.includes("fresh-handle-9"), "claim JSON carries the handle");
  assert.ok(getEl("cw-utxos").innerHTML.includes("Funding:"), "funding UTXO listed");

  getEl("cw-commit-broadcast").click(); // arm
  assert.ok(getEl("cw-commit-broadcast").textContent.includes("click again"), "double-confirm arming");
  getEl("cw-commit-broadcast").click(); // confirm
  for (let i = 0; i < 200 && !getEl("cw-result").innerHTML.includes("Commit broadcast"); i++) await tick();
  assert.ok(getEl("cw-result").innerHTML.includes("e".repeat(64)), "commit txid shown");
  assert.equal(getEl("cw-reveal-broadcast").disabled, false, "reveal unlocked after commit");

  getEl("cw-reveal-broadcast").click();
  getEl("cw-reveal-broadcast").click();
  for (let i = 0; i < 200 && !getEl("cw-result").innerHTML.includes("Handle claimed on-chain"); i++) await tick();
  const done = getEl("cw-result").innerHTML;
  assert.ok(done.includes("Handle claimed on-chain"), "claim completes");
  assert.ok(done.includes("e".repeat(64) + "i0"), "inscription id shown as txid+i0");
});

test("standalone pair verifier: real pair verifies, tampered pair refused", () => {
  const net = R.NETWORKS.mainnet;
  const nameJson = R.buildClaimJson({ handle: "satoshi", owner: OWNER_A, ts: 1759170000 });
  const plan = R.planNameClaim({ network: net, internalXOnly: W.internalXOnly, nameJson, feeRate: 5, changeAddress: W.address });
  const funding = [{ txid: "ab".repeat(32), vout: 0, value: plan.commitValue + 20000, priv: W.priv, internalXOnly: W.internalXOnly }];
  const commit = R.buildCommitTx({ network: net, fundingInputs: funding, commitProgram: plan.commitProgram, commitValue: plan.commitValue, changeProgram: plan.changeProgram, feeRate: 5 });
  const reveal = R.buildRevealTxSigned({ plan, commitTxid: commit.txid, commitVout: 0, internalPriv: W.priv, changeAddress: W.address });

  getEl("pv-commit-hex").value = commit.hex;
  getEl("pv-reveal-hex").value = reveal.hex;
  getEl("pv-run").click();
  const good = getEl("pv-out").innerHTML;
  assert.ok(good.includes("Pair verifies"), "valid pair verifies");
  assert.ok(good.includes("satoshi"), "handle shown");

  // tamper: flip a hex digit inside the reveal (corrupts the envelope body)
  const chars = reveal.hex.split("");
  const pos = Math.floor(chars.length / 2);
  chars[pos] = chars[pos] === "a" ? "b" : "a";
  getEl("pv-reveal-hex").value = chars.join("");
  getEl("pv-run").click();
  assert.ok(getEl("pv-out").innerHTML.includes("REFUSED"), "tampered pair refused loudly");
});

test("verifier tab: tampered content, losing claim, released claim, valid transfer", async () => {
  getEl("v-id").value = "tamper1";
  getEl("v-run").click();
  for (let i = 0; i < 200 && getEl("v-out").innerHTML.includes("Verifying"); i++) await tick();
  const t1 = getEl("v-out").innerHTML;
  assert.ok(t1.includes("Content refused"), "non-canonical handle content refused");
  assert.ok(t1.includes("canonical"), "field-level reason given");

  getEl("v-id").value = "claim2";
  getEl("v-run").click();
  for (let i = 0; i < 200 && getEl("v-out").innerHTML.includes("Verifying"); i++) await tick();
  const t2 = getEl("v-out").innerHTML;
  assert.ok(t2.includes("LOSES"), "later claim loses loudly");
  assert.ok(t2.includes("#10"), "first-seen inscription cited");

  getEl("v-id").value = "claim1";
  getEl("v-run").click();
  for (let i = 0; i < 200 && getEl("v-out").innerHTML.includes("Verifying"); i++) await tick();
  const t3 = getEl("v-out").innerHTML;
  assert.ok(t3.includes("VERIFIED"), "first claim verified");
  assert.ok(t3.includes("now released"), "released state reported");

  getEl("v-id").value = "xfer1";
  getEl("v-run").click();
  for (let i = 0; i < 200 && getEl("v-out").innerHTML.includes("Verifying"); i++) await tick();
  const t4 = getEl("v-out").innerHTML;
  assert.ok(t4.includes("valid transfer"), "winning-chain transfer verified");
});
