// Pearl Lend DOM tests: runs the real pearl-lend.bundle.js + app.js in a
// minimal vm DOM (adapted from the channels harness), with a stubbed Blockbook.
// Drives Offer -> Lock -> Fund -> Track -> Repay (build/sign/export/import/
// co-sign/assemble) -> Close (default claim + mutual close) -> Verify.
// Usage: node --no-warnings tests/dom.test.mjs
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

/* ---------- minimal DOM (from the channels harness) ---------- */
class ClassList {
  constructor() { this.s = new Set(); }
  add(...c) { c.forEach((x) => this.s.add(x)); }
  remove(...c) { c.forEach((x) => this.s.delete(x)); }
  toggle(c, f) { (f ?? !this.s.has(c)) ? this.s.add(c) : this.s.delete(c); }
  contains(c) { return this.s.has(c); }
}
const registry = [];
class El {
  constructor(tag, id = "") {
    this.tagName = tag.toUpperCase(); this.id = id;
    this.classList = new ClassList(); this._className = "";
    this.dataset = {};
    this.value = ""; this._text = ""; this._html = "";
    this.hidden = false; this.disabled = false; this.checked = false;
    this.style = {}; this._handlers = {}; this._kids = [];
    this._attrs = {};
    this.type = ""; this.placeholder = ""; this.spellcheck = false;
    registry.push(this);
  }
  setAttribute(k, v) { this._attrs[k] = String(v); }
  getAttribute(k) { this._attrs[k] ?? null; return this._attrs[k] ?? null; }
  set className(v) { this._className = String(v); String(v).split(/\s+/).forEach((c) => c && this.classList.add(c)); }
  get className() { return this._className; }
  set innerHTML(v) {
    this._html = String(v); this._kids = [];
    this._text = String(v).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  }
  get innerHTML() { return this._html; }
  set textContent(v) { this._text = String(v); }
  get textContent() { return this._text; }
  addEventListener(t, fn) { (this._handlers[t] ??= []).push(fn); }
  click() { (this._handlers.click || []).forEach((f) => f({ target: this, preventDefault() {} })); }
  fire(t, extra = {}) { (this._handlers[t] || []).forEach((f) => f({ target: this, preventDefault() {}, ...extra })); }
  appendChild(k) { this._kids.push(k); return k; }
  remove() { for (const e of registry) e._kids = e._kids.filter((x) => x !== this); }
  get children() { return this._kids; }
  querySelector(sel) {
    const m = sel.match(/\[data-step="([^"]+)"\]/);
    if (m) return registry.find((e) => e.dataset.step === m[1]) || null;
    return null;
  }
  querySelectorAll() { return []; }
  scrollIntoView() {}
  select() {}
}
const byId = new Map();
const stepButtons = [];
for (const m of html.matchAll(/<button[^>]*\bdata-step="([^"]+)"[^>]*>/g)) {
  const el = new El("button");
  el.dataset.step = m[1];
  el.disabled = /disabled/.test(m[0]);
  if (/\bactive\b/.test(m[0])) el.classList.add("active");
  el.addEventListener("click", () => {
    for (const b of stepButtons) b.classList.toggle("active", b === el);
    for (const p of registry) {
      if (p.id && p.id.startsWith("step-")) p.classList.toggle("active", p.id === "step-" + m[1]);
    }
  });
  stepButtons.push(el);
}
const attrMap = new Map();
for (const m of html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)) {
  if (attrMap.has(m[1])) continue;
  const tag = m[0];
  const vv = tag.match(/\bvalue="([^"]*)"/);
  const cc = tag.match(/\bclass="([^"]*)"/);
  attrMap.set(m[1], {
    value: vv ? vv[1] : "",
    cls: cc ? cc[1] : "",
    checked: /\bchecked\b/.test(tag),
    hidden: /\bhidden\b/.test(tag),
  });
}
const getEl = (id) => {
  if (!byId.has(id)) {
    const el = new El("div", id);
    const a = attrMap.get(id);
    if (a) {
      if (a.value) el.value = a.value;
      if (a.cls) el.className = a.cls;
      if (a.checked) el.checked = true;
      if (a.hidden) el.hidden = true;
    }
    byId.set(id, el);
  }
  return byId.get(id);
};
const store = new Map();
const documentShim = {
  getElementById: getEl,
  querySelectorAll: (sel) => {
    if (sel === "#steps button") return stepButtons;
    return [];
  },
  querySelector: () => null,
  createElement: (t) => new El(t),
  body: new El("body"),
  readyState: "complete",
  execCommand: () => false,
};

/* ---------- stubbed Blockbook ---------- */
const QA = { lockTx: null, vaultUtxos: [], height: 901234 };
const okBody = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });
const fail = (status) => ({ ok: false, status, json: async () => ({}), text: async () => "error" });
async function stubFetch(url) {
  const u = String(url);
  const path = u.replace(/^https?:\/\/[^/]+/, "");
  if (path === "/api/v2/" || path === "/api/v2") return okBody({ blockbook: { bestHeight: QA.height } });
  if (path.startsWith("/api/v2/utxo/")) return okBody(QA.vaultUtxos);
  if (path.startsWith("/api/v2/tx/")) {
    const id = path.split("/api/v2/tx/")[1].split("?")[0].toLowerCase();
    if (QA.lockTx && QA.lockTx.txid === id) return okBody(QA.lockTx);
    return fail(404);
  }
  return fail(404);
}

const sandbox = {
  document: documentShim,
  navigator: { clipboard: { writeText: async () => {} } },
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  },
  URL: { createObjectURL: () => "blob:stub", revokeObjectURL() {} },
  TextDecoder, crypto: webcrypto, fetch: stubFetch,
  setTimeout, clearTimeout, setInterval, clearInterval,
  confirm: () => true,
  addEventListener() {},
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
for (const f of ["pearl-lend.bundle.js", "app.js"]) {
  vm.runInContext(fs.readFileSync(resolvePath(dir, f), "utf8"), sandbox, { filename: f, timeout: 30000 });
}

const R = sandbox.PearlLend;
assert.ok(R, "bundle exposes window.PearlLend");
const T = sandbox.__lendTest;
assert.ok(T, "test hook exposed");
const get = (id) => documentShim.getElementById(id);

// fixture keys: fixed privkeys -> x-only pubkeys through the real bundle
const PRIV_B = "11".repeat(32); // borrower
const PRIV_L = "22".repeat(32); // lender
const X_B = R.bytesToHex(R.schnorr.getPublicKey(R.hexToBytes(PRIV_B)));
const X_L = R.bytesToHex(R.schnorr.getPublicKey(R.hexToBytes(PRIV_L)));
const X_C = R.bytesToHex(R.schnorr.getPublicKey(R.hexToBytes("33".repeat(32))));
const X_D = R.bytesToHex(R.schnorr.getPublicKey(R.hexToBytes("44".repeat(32))));
const PAY_B = R.encodeBech32m("prl", 1, R.hexToBytes(X_C));
const PAY_L = R.encodeBech32m("prl", 1, R.hexToBytes(X_D));
const LOCK_TXID = "aa".repeat(32);
const FUND_TXID = "bb".repeat(32);

function draftOffer() {
  T.set("offer-network", "mainnet");
  T.set("offer-borrowerkey", X_B);
  T.set("offer-lenderkey", X_L);
  T.set("offer-borrowerpayout", PAY_B);
  T.set("offer-lenderpayout", PAY_L);
  T.set("offer-principal", "100");
  T.set("offer-apr", "10");
  T.set("offer-term", "10000");
  T.set("offer-grace", "144");
  T.set("offer-ratio", "150");
  T.set("offer-collateral", "160");
  T.click("offer-build");
}

test("boot: attribution, honest limits, step 1 visible", () => {
  assert.ok(html.includes("prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d"), "donation address in footer");
  assert.ok(html.includes("https://x.com/kshot9000"), "x link in footer");
  assert.ok(html.includes("@kshot9000"), "@kshot9000 attribution");
  assert.ok(html.includes("Honest limits"), "honest-limits panel present");
  assert.ok(html.includes("No oracle"), "oracle disclaimer present");
  assert.ok(get("step-offer").classList.contains("active"), "step 1 panel active");
  assert.ok(get("offer-error").hidden, "no error at boot");
});

test("offer: junk key refused; good offer drafts the vault", () => {
  T.set("offer-borrowerkey", "xyz");
  T.set("offer-lenderkey", X_L);
  T.set("offer-borrowerpayout", PAY_B);
  T.set("offer-lenderpayout", PAY_L);
  T.click("offer-build");
  assert.ok(!T.err("offer-error").hidden, "junk key refused loudly");
  draftOffer();
  assert.ok(T.err("offer-error").hidden, "good offer builds: " + T.err("offer-error").text);
  assert.ok(T.text("offer-address").startsWith("prl1"), "vault address rendered");
  assert.equal(T.text("offer-fp").length, 64, "fingerprint rendered");
  assert.ok(T.text("offer-interest").includes("PRL"), "interest shown");
  assert.ok(T.text("offer-repayment").includes("PRL"), "repayment shown");
  const st = T.state();
  assert.ok(st.descriptor && st.descriptor.kind === "pearllend:v1");
});

test("offer: undercollateralized offer refused", () => {
  T.set("offer-collateral", "140");
  T.click("offer-build");
  assert.ok(!T.err("offer-error").hidden, "low collateral refused");
  T.set("offer-collateral", "160");
  T.click("offer-build");
  assert.ok(T.err("offer-error").hidden, "offer restored");
});

test("lock: on-chain scan verifies the vault output", () => {
  const d = T.state().descriptor;
  QA.lockTx = {
    txid: LOCK_TXID,
    blockHeight: 900000,
    confirmations: 1234,
    vout: [{ value: d.collateralGrains, scriptPubKey: { hex: d.vaultSpk } }],
  };
  T.set("lock-blockbook", "https://bb.example");
  T.set("lock-txid", LOCK_TXID);
  T.set("lock-vout", "0");
  get("lock-scan").fire("click");
  return new Promise((resolve) => setTimeout(() => {
    assert.ok(T.err("lock-error").hidden, "scan ok: " + T.err("lock-error").text);
    assert.ok(!get("lock-result").hidden, "lock result shown");
    assert.ok(T.text("lock-amount").includes("confirmed on-chain"));
    assert.equal(T.text("lock-maturity"), "910000 (default sweep after +10144)");
    resolve();
  }, 50));
});

test("fund: unsigned payment builds; txid records", () => {
  const utxoX = R.bytesToHex(R.schnorr.getPublicKey(R.hexToBytes("66".repeat(32))));
  const utxoAddr = R.encodeBech32m("prl", 1, R.hexToBytes(utxoX));
  const spk = R.bytesToHex(R.p2trScriptPubKey(R.hexToBytes(utxoX)));
  T.set("fund-utxos", JSON.stringify([{
    txid: "ee".repeat(32), vout: 0, value: String(200n * 100000000n),
    spk, priv: "66".repeat(32), internalXOnly: utxoX,
  }]));
  T.set("fund-changeaddr", utxoAddr);
  T.set("fund-feerate", "2");
  T.click("fund-build");
  assert.ok(T.err("fund-error").hidden, "payment builds: " + T.err("fund-error").text);
  assert.ok(!get("fund-hexbox").hidden, "unsigned hex shown");
  assert.ok(T.text("fund-hex").length > 200, "hex present");
  T.set("fund-txid", FUND_TXID);
  T.click("fund-record");
  assert.ok(T.err("fund-error").hidden, "funding records");
});

test("track: stubbed chain shows loan standing", () => {
  const d = T.state().descriptor;
  QA.height = 905000; // before maturity (910000)
  QA.vaultUtxos = [{ txid: LOCK_TXID, vout: 0, value: Number(BigInt(d.collateralGrains)), confirmations: 5000 }];
  T.set("track-blockbook", "https://bb.example");
  get("track-refresh").fire("click");
  return new Promise((resolve) => setTimeout(() => {
    assert.ok(T.err("track-error").hidden, "track ok: " + T.err("track-error").text);
    assert.ok(T.text("track-vault").includes("FUNDED"));
    assert.ok(T.text("track-remaining").includes("5000 blocks"), "blocks to maturity: " + T.text("track-remaining"));
    assert.ok(T.text("track-coverage").includes("WHOLE"));
    resolve();
  }, 50));
});

test("repay: build -> borrower sign -> export -> import/verify -> lender co-sign -> assemble", () => {
  T.set("repay-txid", LOCK_TXID);
  T.set("repay-vout", "0");
  T.set("repay-value", T.state().descriptor ? R.fmtPRL(T.state().descriptor.collateralGrains) : "160");
  T.set("repay-feerate", "2");
  T.click("repay-build");
  assert.ok(T.err("repay-error").hidden, "proposal builds: " + T.err("repay-error").text);
  assert.ok(T.text("repay-lendergets").includes("PRL"));
  T.set("repay-signkey", PRIV_B);
  T.click("repay-sign");
  assert.ok(T.err("repay-error").hidden, "borrower signs: " + T.err("repay-error").text);
  assert.equal(T.text("repay-borrowersig").length, 128, "borrower sig shown");
  // lender side: import the signed package (simulate by rebuilding it from state)
  const st = T.state();
  const pkg = JSON.stringify({
    kind: "repay",
    descriptor: st.descriptor,
    proposal: {
      input: st.repayProposal.input, outputs: st.repayProposal.outputs,
      feeGrains: st.repayProposal.feeGrains, vbytes: st.repayProposal.vbytes,
      digest: st.repayProposal.digest, feeRateGrainsPerVByte: st.repayProposal.feeRateGrainsPerVByte,
    },
    borrowerSig: st.repayBorrowerSig,
  });
  T.set("repay-import", pkg);
  T.click("repay-doimport");
  assert.ok(T.err("repay-error").hidden, "import verifies: " + T.err("repay-error").text);
  assert.ok(T.text("repay-importsig").includes("VALID"));
  T.set("repay-lendersignkey", PRIV_L);
  T.click("repay-lendersign");
  assert.ok(T.err("repay-error").hidden, "lender co-signs: " + T.err("repay-error").text);
  T.click("repay-assemble");
  assert.ok(T.err("repay-error").hidden, "assembles: " + T.err("repay-error").text);
  assert.ok(T.text("repay-hex").length > 300, "final hex present");
  assert.equal(T.text("repay-finaltxid").length, 64, "txid shown");
});

test("repay: tampered borrower signature refused at import", () => {
  const st = T.state();
  const bad = {
    kind: "repay",
    descriptor: st.descriptor,
    proposal: {
      input: st.repayProposal.input, outputs: st.repayProposal.outputs,
      feeGrains: st.repayProposal.feeGrains, vbytes: st.repayProposal.vbytes,
      digest: st.repayProposal.digest, feeRateGrainsPerVByte: st.repayProposal.feeRateGrainsPerVByte,
    },
    borrowerSig: "00".repeat(64),
  };
  T.set("repay-import", JSON.stringify(bad));
  T.click("repay-doimport");
  assert.ok(!T.err("repay-error").hidden, "bad borrower sig refused");
  assert.ok(T.err("repay-error").text.includes("invalid"), "refusal names the bad signature");
});

test("close: default claim builds past maturity; mutual close assembles", () => {
  QA.height = 920000; // past default (910144)
  T.set("close-blockbook", "https://bb.example");
  T.set("close-txid", LOCK_TXID);
  T.set("close-vout", "0");
  T.set("close-value", R.fmtPRL(T.state().descriptor.collateralGrains));
  T.set("close-feerate", "2");
  T.set("close-key", PRIV_L);
  get("close-buildclaim").fire("click");
  return new Promise((resolve) => setTimeout(() => {
    assert.ok(T.err("close-error").hidden, "claim builds: " + T.err("close-error").text);
    assert.ok(!get("close-claimbox").hidden, "claim shown");
    assert.ok(T.text("close-claimhex").length > 200);
    // mutual close: lender takes repayment, borrower takes the rest
    const d = T.state().descriptor;
    const collateral = BigInt(d.collateralGrains);
    const fee = BigInt(Math.ceil(R.vaultSpendVBytes("repay", d) * 2));
    const repay = BigInt(d.repaymentGrains);
    T.set("close-mtxid", LOCK_TXID);
    T.set("close-mvout", "0");
    T.set("close-mvalue", R.fmtPRL(d.collateralGrains));
    T.set("close-mfeerate", "2");
    T.set("close-splits", JSON.stringify([
      { address: d.lenderPayout, valuePRL: R.fmtPRL(repay) },
      { address: d.borrowerPayout, valuePRL: R.fmtPRL(collateral - repay - fee) },
    ]));
    T.click("close-mutbuild");
    assert.ok(T.err("close-muterror").hidden, "mutual builds: " + T.err("close-muterror").text);
    T.set("close-mutbkey", PRIV_B);
    T.set("close-mutlkey", PRIV_L);
    T.click("close-mutassemble");
    assert.ok(T.err("close-muterror").hidden, "mutual assembles: " + T.err("close-muterror").text);
    assert.ok(T.text("close-muthex").length > 200);
    resolve();
  }, 50));
});

test("close: early default claim refused without override", () => {
  QA.height = 905000; // before default
  get("close-buildclaim").fire("click");
  return new Promise((resolve) => setTimeout(() => {
    assert.ok(!T.err("close-error").hidden, "early claim refused");
    assert.ok(T.err("close-error").text.includes("not mature"));
    get("close-override").checked = true;
    T.set("close-key", PRIV_L);
    get("close-buildclaim").fire("click");
    setTimeout(() => {
      assert.ok(T.err("close-error").hidden, "override builds: " + T.err("close-error").text);
      get("close-override").checked = false;
      resolve();
    }, 50);
  }, 50));
});

test("verify: PROVEN for the repayment, NOT PROVEN for garbage", () => {
  const st = T.state();
  const d = st.descriptor;
  T.set("verify-descriptor", JSON.stringify(d));
  T.set("verify-hex", T.text("repay-hex"));
  T.set("verify-prevouts", JSON.stringify([{
    txid: LOCK_TXID, vout: 0, value: d.collateralGrains, spk: d.vaultSpk,
  }]));
  T.click("verify-desc");
  assert.equal(T.text("verify-verdict"), "PROVEN", "verdict: " + T.text("verify-details"));
  T.set("verify-hex", "00".repeat(100));
  T.click("verify-desc");
  assert.equal(T.text("verify-verdict"), "NOT PROVEN");
});

test("restore: tampered descriptor refused", () => {
  const d = { ...T.state().descriptor, principalGrains: "1" };
  T.set("offer-restorejson", JSON.stringify(d));
  T.click("offer-dorestore");
  assert.ok(!T.err("offer-restoreerror").hidden, "tampered descriptor refused");
});
