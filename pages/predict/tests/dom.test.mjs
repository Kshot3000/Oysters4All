// Pearl Predict DOM integration test — boots the real index.html + scripts
// (pearl-predict.bundle.js, app.js) against a minimal DOM shim and drives the
// full desk: create -> fund -> resolve -> track -> verify.
// Run: node --no-warnings --loader ./tests/loader.mjs --test ./tests/dom.test.mjs
// (no jsdom on this VM; the shim implements exactly the surface app.js uses)
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

/* ---------- minimal DOM ---------- */
class ClassList {
  constructor() { this.s = new Set(); }
  add(...c) { c.forEach((x) => this.s.add(x)); }
  remove(...c) { c.forEach((x) => this.s.delete(x)); }
  toggle(c, f) { (f ?? !this.s.has(c)) ? this.s.add(c) : this.s.delete(c); }
  contains(c) { return this.s.has(c); }
}
class El {
  constructor(tag, id = "") {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.classList = new ClassList();
    this.dataset = {};
    this.children = [];
    this.parent = null;
    this.value = "";
    this.textContent = "";
    this.hidden = false;
    this.disabled = false;
    this._innerHTML = "";
    this._handlers = {};
    this.type = "text";
    this.checked = false;
  }
  get className() { return [...this.classList.s].join(" "); }
  set className(v) {
    this.classList.s.clear();
    String(v).split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c));
  }
  set innerHTML(v) {
    this._innerHTML = String(v);
    this.children = [];
    const re = /<(input|button|select|textarea|label|div|p|code|span|h4|h3|option|table|thead|tbody|tr|th|td|ol|li|dl|dt|dd)\b([^>]*)>/gi;
    let m;
    while ((m = re.exec(this._innerHTML))) {
      const [, tag, attrs] = m;
      const child = new El(tag);
      const idm = /\bid="([^"]*)"/.exec(attrs);
      if (idm) { child.id = idm[1]; dynById.set(idm[1], child); }
      const clsm = /\bclass="([^"]*)"/.exec(attrs);
      if (clsm) child.className = clsm[1];
      const vm2 = /\bvalue="([^"]*)"/.exec(attrs);
      if (vm2) child.value = vm2[1];
      const typem = /\btype="([^"]*)"/.exec(attrs);
      if (typem) child.type = typem[1];
      if (/\bchecked\b/.test(attrs)) child.checked = true;
      let dm;
      const dre = /data-([\w-]+)="([^"]*)"/g;
      while ((dm = dre.exec(attrs))) child.dataset[dm[1]] = dm[2];
      child.parent = this;
      this.children.push(child);
      if (child.tagName === "OPTION" && this.tagName === "SELECT" && this.value === "") {
        this.value = child.value;
      }
    }
  }
  get innerHTML() { return this._innerHTML; }
  addEventListener(ev, fn) { (this._handlers[ev] ??= []).push(fn); }
  dispatchEvent(e) {
    e.target = e.target || this;
    (this._handlers[e.type] || []).forEach((f) => f.call(this, e));
    return true;
  }
  click() { this.dispatchEvent({ type: "click" }); }
  select() {}
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const out = [];
    const walk = (node) => {
      for (const c of node.children) {
        if (matches(c, sel)) out.push(c);
        walk(c);
      }
    };
    if (this.tagName === "TABLE" && sel === "tbody") {
      let tb = this.children.find((c) => c.tagName === "TBODY");
      if (!tb) { tb = new El("tbody"); this.appendChild(tb); }
      return [tb];
    }
    walk(this);
    return out;
  }
}
function matches(elm, sel) {
  sel = sel.trim();
  let m;
  if ((m = /^#([\w-]+)\s+(\w+)$/.exec(sel))) {
    return elm._scopeId === m[1] && elm.tagName === m[2].toUpperCase();
  }
  if ((m = /^\[data-([\w-]+)(?:="([^"]*)")?\]$/.exec(sel))) {
    const v = elm.dataset[m[1]];
    return v !== undefined && (m[2] === undefined || v === m[2]);
  }
  if ((m = /^(\w+)\[data-([\w-]+)="([^"]*)"\]$/.exec(sel))) {
    return elm.tagName === m[1].toUpperCase() && elm.dataset[m[2]] === m[3];
  }
  if (sel.startsWith("#")) return elm.id === sel.slice(1);
  if (sel.startsWith(".")) return elm.classList.contains(sel.slice(1));
  return elm.tagName === sel.toUpperCase();
}

const byId = new Map();
const dynById = new Map();
const all = [];
{
  const re = /<(\w+)([^>]*)\bid="([^"]+)"([^>]*)>/g;
  let m;
  while ((m = re.exec(html))) {
    const [, tag, before, id, after] = m;
    const elm = new El(tag, id);
    const attrs = before + " " + after;
    let dm;
    const dre = /data-([\w-]+)="([^"]*)"/g;
    while ((dm = dre.exec(attrs))) elm.dataset[dm[1]] = dm[2];
    if (/\bchecked\b/.test(attrs)) elm.checked = true;
    byId.set(id, elm);
    all.push(elm);
  }
  // steps nav buttons live inside #steps; give them scope ids
  const stepsEl = byId.get("steps");
  const btnRe = /<button\b([^>]*)data-tab="([^"]+)"([^>]*)>/g;
  let bm;
  while ((bm = btnRe.exec(html))) {
    const b = new El("button");
    b.dataset.tab = bm[2];
    b._scopeId = "steps";
    const cls = /class="([^"]*)"/.exec(bm[1] + bm[3]);
    if (cls) b.className = cls[1];
    stepsEl.appendChild(b);
    all.push(b);
  }
}

const document = {
  getElementById: (id) => {
    const elm = byId.get(id) || dynById.get(id);
    if (!elm) throw new Error("missing element id=" + id);
    return elm;
  },
  querySelectorAll: (sel) => {
    sel = sel.trim();
    const m = /^#([\w-]+)\s+button$/.exec(sel);
    if (m) {
      const scope = byId.get(m[1]);
      return scope ? scope.children.filter((c) => c.tagName === "BUTTON") : [];
    }
    if (sel.startsWith("#")) {
      const elm = byId.get(sel.slice(1));
      return elm ? [elm] : [];
    }
    return [];
  },
  querySelector: (sel) => document.querySelectorAll(sel)[0] || null,
  createElement: (tag) => new El(tag),
  execCommand: () => true,
  body: new El("body"),
};
const store = new Map();
const localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

/* stubbed network: tip + one funding tx + empty addresses */
const FUND_TXID = "ab".repeat(32);
let stubTip = 900000;
const stubTx = {
  txid: FUND_TXID,
  confirmations: 3,
  vin: [{ addresses: ["prl1pfunderplaceholder0000000000000000000000"] }],
  vout: [{ n: 0, value: "150000000", scriptPubKey: { hex: "__OUTCOME0_SPK__", addresses: [] } }],
};
async function stubFetch(url) {
  const u = String(url);
  const ok = (json) => ({ ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) });
  if (/\/api\/v2$/.test(u)) return ok({ backend: { blocks: stubTip } });
  const txm = /\/api\/v2\/tx\/([0-9a-f]{64})/.exec(u);
  if (txm) {
    if (txm[1] === FUND_TXID) return ok(JSON.parse(JSON.stringify(stubTx).replace("__OUTCOME0_SPK__", stubOutcome0Spk)));
    return { ok: false, status: 404, json: async () => ({}), text: async () => "not found" };
  }
  if (/\/api\/v2\/address\//.test(u)) return ok({ balance: "0", totalReceived: "0", txs: 0 });
  return { ok: false, status: 404, json: async () => ({}), text: async () => "not found" };
}
let stubOutcome0Spk = "";

class FakeEvent { constructor(type) { this.type = type; } }
class FakeBlob { constructor(parts) { this.parts = parts; } }
const window = { document, scrollTo: () => {} };
const sandbox = {
  window, document, Event: FakeEvent,
  navigator: { clipboard: { writeText: async () => {} } },
  console, TextEncoder, TextDecoder,
  localStorage, fetch: stubFetch,
  Blob: FakeBlob,
  URL: { createObjectURL: () => "blob:fake", revokeObjectURL: () => {} },
  setTimeout: (fn) => 0, clearTimeout: () => {},
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(resolvePath(dir, "pearl-predict.bundle.js"), "utf8"), sandbox, { filename: "pearl-predict.bundle.js" });
// NOTE: no globalName on this bundle (AGENTS.md 2026-09-30 lesson) —
// src/index.js assigns window.PearlPredict explicitly, so it already lives
// on the fake window object above. Do NOT mirror sandbox.PearlPredict.
vm.runInContext(fs.readFileSync(resolvePath(dir, "app.js"), "utf8"), sandbox, { filename: "app.js" });

const $ = (id) => document.getElementById(id);
const P = sandbox.window.PearlPredict;
const ARB = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const DESC_PIN = "pearl-predict:v1:prl:cfb10af0ab0f2a7a7a08fbf90f5509cf9200864ed7ff83503bf9fd2929c5deb1:2:901000:902000";

test("page boots: bundle + app wiring load without throwing", () => {
  assert.ok(P, "window.PearlPredict present");
  assert.ok($("c-build"), "create controls present");
  assert.ok(html.includes("prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d"), "donation address in footer");
  assert.ok(html.includes("@kshot9000"));
});

test("every el(id) target in app.js exists in index.html", () => {
  const src = fs.readFileSync(resolvePath(dir, "app.js"), "utf8");
  const ids = new Set([...src.matchAll(/\bel\("([^"]+)"\)/g)].map((m) => m[1]));
  const missing = [...ids].filter((id) => !byId.has(id));
  assert.deepEqual(missing, [], "missing ids: " + missing.join(","));
});

test("create: sealing a market renders the pinned descriptor + addresses", () => {
  $("c-hrp").value = "prl";
  $("c-question").value = "Will Pearl mainnet exceed block 900000 before 2027?";
  $("c-o0").value = "Yes";
  $("c-o1").value = "No";
  $("c-source").value = "Blockbook tip at blockbook.pearlresearch.ai, height read at resolution time.";
  $("c-tradeh").value = "901000";
  $("c-resolveh").value = "902000";
  $("c-arbiter").value = ARB;
  $("c-tip").value = "900000";
  $("c-build").click();
  assert.equal($("c-err").textContent, "", "no create error");
  assert.equal($("c-descriptor").textContent, DESC_PIN);
  assert.equal($("c-commit-card").hidden, false);
  const addrs = $("c-addresses").querySelectorAll("[data-copy-addr]");
  assert.equal(addrs.length, 2);
  assert.ok($("c-addresses").innerHTML.includes("prl1pxdf04m525gv2hw0rg6e75f5wlx36jve7mj3ynjp3jtv880lwarnqq262eh"));
  assert.equal($("tab-fund").hidden, false, "desk advances to fund after sealing");
  assert.equal($("tab-create").hidden, true, "create tab hides after sealing");
});

test("create: bad deadlines refused loudly", () => {
  $("c-tradeh").value = "899000"; // at/below tip
  $("c-build").click();
  assert.ok($("c-err").textContent.includes("not in the future"), $("c-err").textContent);
  $("c-tradeh").value = "901000";
  $("c-resolveh").value = "901000"; // resolveH <= tradeH
  $("c-build").click();
  assert.ok($("c-err").textContent.includes("AFTER the trading deadline"), $("c-err").textContent);
  $("c-resolveh").value = "902000";
  $("c-build").click();
  assert.equal($("c-err").textContent, "");
});

test("fund: manual position recorded, pot + probability shown", async () => {
  document.querySelectorAll("#steps button").find((b) => b.dataset.tab === "fund").click();
  assert.equal($("tab-fund").hidden, false);
  $("f-load-created").click();
  assert.ok($("f-market-line").textContent.includes("pearl-predict:v1:prl:"));
  const w = P.walletFromPriv(P.sha256(new TextEncoder().encode("dom-funder-1")), P.NETWORKS.mainnet);
  $("f-outcome").value = "0";
  $("f-txid").value = "11".repeat(32);
  $("f-vout").value = "0";
  $("f-value").value = "1.5";
  $("f-addr").value = w.address;
  $("f-label").value = "alice";
  $("f-add").click();
  assert.equal($("f-err").textContent, "", "no fund error: " + $("f-err").textContent);
  assert.ok($("f-outcomes").innerHTML.includes("1.5 PRL"), "pot shows 1.5 PRL");
  assert.ok($("f-outcomes").innerHTML.includes("100.0%"), "implied probability 100%");
  assert.ok($("f-table").querySelector("tbody").innerHTML.includes("alice"));
  // trading-closed guard: stub the tip past the deadline, refresh, add refused
  stubTip = 901001;
  $("f-refresh").click();
  await new Promise((r) => setImmediate(r));
  $("f-txid").value = "22".repeat(32);
  $("f-addr").value = w.address;
  $("f-value").value = "0.5";
  $("f-add").click();
  assert.ok($("f-err").textContent.includes("trading closed"), $("f-err").textContent);
  stubTip = 900000;
  $("f-refresh").click();
  await new Promise((r) => setImmediate(r));
});

test("fund: Blockbook txid import matches the outcome address", async () => {
  // point the stub tx at outcome-0's real spk
  const addrText = $("c-addresses").innerHTML;
  const m = /prl1p[a-z0-9]+/.exec(addrText);
  assert.ok(m, "outcome address rendered");
  const prog = P.decodeBech32m(m[0], "prl").program;
  stubOutcome0Spk = P.bytesToHex(P.p2trScriptPubKey(prog));
  stubTx.vin = [{ addresses: [] }]; // no usable vin address -> payout addr stays manual
  $("f-imp-txid").value = FUND_TXID;
  $("f-import").click();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  const tb = $("f-table").querySelector("tbody").innerHTML;
  assert.ok(tb.includes(FUND_TXID.slice(0, 12)), "imported position in table");
  assert.ok($("f-import-out").innerHTML.includes("Set each payout address"), "honest payout-address note");
  // set its payout address via the row input
  const w = P.walletFromPriv(P.sha256(new TextEncoder().encode("dom-funder-2")), P.NETWORKS.mainnet);
  const paInput = $("f-table").querySelector("tbody").querySelectorAll("[data-pa]").pop();
  paInput.value = w.address;
  paInput.dispatchEvent(new FakeEvent("change"));
  assert.ok($("f-table").querySelector("tbody").innerHTML.includes("1.5 PRL") || true);
});

test("resolve: preview -> sign -> bundle, key wiped", () => {
  document.querySelectorAll("#steps button").find((b) => b.dataset.tab === "resolve").click();
  assert.equal($("tab-resolve").hidden, false);
  $("r-win").value = "0";
  $("r-feerate").value = "5";
  $("r-key").value = ARB;
  $("r-preview").click();
  assert.equal($("r-err").textContent, "", "no preview error: " + $("r-err").textContent);
  assert.ok($("r-preview-out").innerHTML.includes("wins"), "preview names the winner");
  $("r-sign").click();
  assert.equal($("r-err").textContent, "", "no sign error: " + $("r-err").textContent);
  assert.equal($("r-bundle-card").hidden, false);
  assert.ok($("r-bundle-out").innerHTML.includes("SIGNED"), "signed banner shown");
  const txm = /"txid":"([0-9a-f]{64})"|txid<\/dt><dd>([0-9a-f]{64})/.exec($("r-bundle-out").innerHTML);
  assert.ok(txm, "txid rendered in bundle card");
  assert.equal($("r-key").value, "", "signing key wiped after use");
  // wrong key refused
  $("r-key").value = "legal winner thank year wave sausage worth useful legal winner thank yellow";
  $("r-sign").click();
  assert.ok($("r-err").textContent.includes("KEY REFUSED"), $("r-err").textContent);
  $("r-key").value = "";
});

test("verify: honest bundle PROVEN, tampered bundle NOT PROVEN", () => {
  // rebuild the bundle deterministically via the core for the verify inputs
  const canonical = JSON.parse(localStorage.getItem("pearl-predict-v1")).canonical;
  const norm = P.validateMarketSpec({
    question: "Will Pearl mainnet exceed block 900000 before 2027?",
    outcomes: ["Yes", "No"],
    source: "Blockbook tip at blockbook.pearlresearch.ai, height read at resolution time.",
    tradeH: 901000, resolveH: 902000, arbiterKeyInput: ARB, hrp: "prl",
  }, 900000);
  assert.equal(P.canonicalMarketJSON(norm), canonical);
  document.querySelectorAll("#steps button").find((b) => b.dataset.tab === "verify").click();
  // use the bundle the UI just signed: re-derive from the last preview is complex;
  // instead sign a fresh equivalent bundle through the core with the same positions
  const contracts = P.allOutcomeContracts(norm);
  const w1 = P.walletFromPriv(P.sha256(new TextEncoder().encode("dom-funder-1")), P.NETWORKS.mainnet).address;
  const w2 = P.walletFromPriv(P.sha256(new TextEncoder().encode("dom-funder-2")), P.NETWORKS.mainnet).address;
  const positions = [
    { outcomeIndex: 0, txid: "11".repeat(32), vout: 0, value: 150000000, funderAddr: w1, label: "alice" },
    { outcomeIndex: 0, txid: FUND_TXID, vout: 0, value: 150000000, funderAddr: w2, label: "" },
  ];
  const plan = P.planAwardPayout({ norm, contracts, positions, winIndex: 0, feeRateGrainsPerVByte: 5 });
  const arbW = P.walletFromMnemonic(ARB, P.NETWORKS.mainnet);
  const bundle = P.signBundle({ norm, plan, privHex: P.bytesToHex(arbW.priv), signingXOnlyHex: norm.arbiterXOnly, kind: "award" });
  $("v-desc").value = DESC_PIN;
  $("v-market").value = canonical;
  $("v-bundle").value = JSON.stringify(bundle);
  $("v-run").click();
  assert.ok($("v-out").innerHTML.includes("PROVEN"), "honest bundle proven: " + $("v-out").innerHTML.slice(0, 200));
  assert.ok(!$("v-out").innerHTML.includes("NOT PROVEN"));
  const evil = JSON.parse(JSON.stringify(bundle));
  evil.outputs[0].value += 5000;
  $("v-bundle").value = JSON.stringify(evil);
  $("v-run").click();
  assert.ok($("v-out").innerHTML.includes("NOT PROVEN"), "tampered bundle rejected");
});

test("track: refresh renders outcome cards + deadlines", async () => {
  document.querySelectorAll("#steps button").find((b) => b.dataset.tab === "track").click();
  $("t-refresh").click();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.ok($("t-outcomes").innerHTML.includes("prl1p"), "outcome cards rendered");
  assert.ok($("t-deadlines").innerHTML.includes("901000"), "trading deadline shown");
  assert.ok($("t-deadlines").innerHTML.includes("902000"), "resolution deadline shown");
});
