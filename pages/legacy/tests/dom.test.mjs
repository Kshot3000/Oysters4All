// Pearl Legacy DOM integration test — boots the real index.html + committed
// bundle (pearl-legacy.bundle.js) + app.js against a minimal DOM shim and
// drives the full flow: plan -> vault -> watch (stubbed Blockbook) ->
// claim -> refresh -> verify (good + tampered) -> footer-attribution checks.
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
    this.tagName = tag.toUpperCase(); this.id = id;
    this.classList = new ClassList(); this.dataset = {};
    this.value = ""; this.textContent = ""; this._html = "";
    this.hidden = false; this.disabled = false; this.checked = false;
    this._handlers = {}; this._kids = [];
  }
  set innerHTML(v) { this._html = String(v); }
  get innerHTML() { return this._html; }
  addEventListener(t, fn) { (this._handlers[t] ??= []).push(fn); }
  click() { (this._handlers.click || []).forEach((f) => f({ target: this, preventDefault() {} })); }
  fire(t, extra = {}) { (this._handlers[t] || []).forEach((f) => f({ target: this, preventDefault() {}, ...extra })); }
  querySelectorAll() { return []; }
  querySelector(sel) { // nested lookups (e.g. tbody) get a cached child shim
    this._q ??= {};
    return (this._q[sel] ??= new El("div"));
  }
}
const byId = new Map();
const hiddenIds = new Set([...html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*\bhidden\b[^>]*>/g)].map((m) => m[1]));
const radios = new Map(); // name -> checked value
for (const m of html.matchAll(/<input[^>]*\btype="radio"[^>]*>/g)) {
  const tag = m[0];
  const name = /name="([^"]+)"/.exec(tag)?.[1];
  const value = /value="([^"]+)"/.exec(tag)?.[1];
  if (name && value && !radios.has(name) && /\bchecked\b/.test(tag)) radios.set(name, value);
}
const getEl = (id) => {
  if (!byId.has(id)) {
    const el = new El("div", id);
    if (hiddenIds.has(id)) el.hidden = true;
    byId.set(id, el);
  }
  return byId.get(id);
};
const stepButtons = [...html.matchAll(/<button data-step="([^"]+)"[^>]*>/g)].map((m) => {
  const b = new El("button"); b.dataset.step = m[1]; return b;
});
const documentShim = {
  getElementById: (id) => getEl(id),
  querySelectorAll: (sel) => (sel === "#steps button" ? stepButtons : []),
  querySelector: (sel) => {
    let m = sel.match(/#steps button\[data-step="([^"]+)"\]/);
    if (m) return stepButtons.find((b) => b.dataset.step === m[1]) || null;
    m = sel.match(/^input\[name="([^"]+)"\]:checked$/);
    if (m) {
      const el = new El("input");
      el.value = radios.get(m[1]) ?? "";
      return el;
    }
    m = sel.match(/^input\[name="([^"]+)"\]\[value="([^"]+)"\]$/);
    if (m) {
      const el = new El("input");
      el.value = m[2];
      el.checked = radios.get(m[1]) === m[2];
      el.addEventListener = () => {};
      return { ...el, click() { radios.set(m[1], m[2]); } };
    }
    return null;
  },
  createElement: (t) => new El(t),
  body: new El("body"),
};
// dynamic stub state (filled in once the vault is forged)
const stub = { tip: 120600, utxos: [], blockbook: "", vaultSpk: "" };
const fetchStub = async (url) => {
  const u = String(url);
  const json = (obj) => ({ ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) });
  if (u === stub.blockbook + "/api/v2") return json({ backend: { blocks: stub.tip } });
  if (u.startsWith(stub.blockbook + "/api/v2/utxo/")) return json(stub.utxos);
  if (u.startsWith(stub.blockbook + "/api/v2/tx/")) {
    const txid = u.split("/").pop();
    const mk = (spk) => ({ scriptPubKey: { hex: spk }, value: 1 });
    if (txid === "ab".repeat(32)) return json({ blockHeight: 120000, vout: [mk(stub.vaultSpk)] });
    if (txid === "cd".repeat(32)) return json({ blockHeight: 120000, vout: [mk("00"), mk(stub.vaultSpk)] });
    return json({ blockHeight: 120000, vout: [mk("deadbeef")] }); // impostor script
  }
  throw new Error("unstubbed fetch: " + u);
};
const sandbox = {
  document: documentShim,
  navigator: { clipboard: { writeText: async () => {} } },
  TextDecoder, crypto: webcrypto, fetch: fetchStub,
  location: { reload() {} },
  setTimeout, clearTimeout,
  scrollTo() {},
  confirm() { return true; },
  console,
  URL: { createObjectURL: () => "blob:fake", revokeObjectURL() {} },
  Blob: class { constructor(parts) { this.parts = parts; } },
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
for (const f of ["pearl-legacy.bundle.js", "app.js"]) {
  vm.runInContext(fs.readFileSync(resolvePath(dir, f), "utf8"), sandbox, { filename: f, timeout: 15000 });
}
const E = sandbox.PearlLegacy;
assert.ok(E && E.planLegacy, "bundle exposes window.PearlLegacy");

/* ---------- helpers ---------- */
const setVal = (id, v) => { getEl(id).value = v; };
const click = (id) => getEl(id).click();
const setRadio = (name, value) => radios.set(name, value);
const OWNER_PRIV = "11".repeat(32);
const HEIR_PRIV = "22".repeat(32);
const net = E.NETWORKS.mainnet;
const HEIR_XONLY = E.bytesToHex(E.walletFromPriv(HEIR_PRIV, net).internalXOnly);
const HEIR_ADDR = E.walletFromPriv(HEIR_PRIV, net).address;
stub.blockbook = net.blockbook;

test("flow: plan -> forge -> carry to vault", () => {
  setRadio("pl-owner-mode", "priv");
  setVal("pl-owner-input", OWNER_PRIV);
  setVal("pl-heir", HEIR_XONLY);
  setVal("pl-n", "445");
  click("pl-forge");
  assert.equal(getEl("pl-error").hidden, true, "no forge error: " + getEl("pl-error").textContent);
  assert.equal(getEl("pl-out").hidden, false, "plan output shown");
  const expected = E.planLegacy({
    network: net, ownerKeyInput: OWNER_PRIV, ownerKeyMode: "priv",
    ownerKeySrc: "hex", heirKeyInput: HEIR_XONLY, n: 445,
  }).vault;
  assert.equal(getEl("pl-address").textContent, expected.address, "address matches core");
  assert.equal(getEl("pl-desc").textContent, expected.descriptor, "descriptor matches core");
  assert.ok(getEl("pl-desc").textContent.endsWith(":445"), "descriptor carries n as final field");
  assert.ok(!getEl("pl-desc").textContent.endsWith(":445:0"), "descriptor has no epoch field");
  const spec = E.parseVaultSpec(getEl("pl-spec").value, net);
  assert.equal(spec.address, expected.address, "spec JSON round-trips");
  assert.equal(getEl("pl-owner-input").value, "", "owner secret wiped after forge");

  click("pl-carry-vault");
  assert.equal(getEl("v-spec").value, getEl("pl-spec").value, "spec carried to vault tab");
  assert.equal(getEl("v-out").hidden, false, "vault output shown");
  assert.equal(getEl("v-address").textContent, expected.address, "vault tab address");
  sandbox.__vault = expected;
  stub.vaultSpk = expected.spkHex;
});

test("flow: vault -> watch (stubbed blockbook, script re-check, maturity)", async () => {
  const vault = sandbox.__vault;
  click("v-carry-watch");
  assert.equal(getEl("w-address").value, vault.address, "address carried to watch");
  stub.utxos = [
    { txid: "ab".repeat(32), vout: 0, value: 100000000, confirmations: 600 },
    { txid: "cd".repeat(32), vout: 1, value: 200000000, confirmations: 600 },
    // an impostor UTXO whose funding tx pays a foreign script: the watcher
    // fetches the tx, sees the mismatch, and never believes it
    { txid: "ef".repeat(32), vout: 0, value: 999, confirmations: 600 },
  ];
  click("w-scan");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(getEl("w-error").hidden, true, "no scan error: " + getEl("w-error").textContent);
  assert.equal(getEl("w-out").hidden, false, "watch output shown");
  assert.ok(getEl("w-tip").textContent.includes("120,600"), "stubbed tip shown");
  assert.ok(getEl("w-balance").textContent.includes("3"), "balance = 3 PRL, impostor ignored");
  assert.ok(getEl("w-balance").textContent.includes("1 foreign-script"), "ignored impostor reported");
  assert.ok(getEl("w-status").innerHTML.includes("HEIR CLAIM LIVE"), "mature at 600 blocks >= n=445");
  assert.ok(getEl("w-countdown").textContent.includes("claimable now"), "countdown zero");
  const rows = getEl("w-utxos").innerHTML;
  assert.ok(!rows.includes("deadbeef"), "foreign-script UTXO not rendered");
  sandbox.__tip = 120600;
});

test("flow: watch -> heir claim (mature, exact fee, verified sig)", () => {
  const vault = sandbox.__vault;
  click("w-carry-claim");
  assert.equal(getEl("c-txid").value, "ab".repeat(32), "oldest UTXO carried");
  assert.equal(getEl("c-vout").value, "0", "vout carried");
  assert.equal(getEl("c-value").value, "100000000", "value carried");
  assert.equal(getEl("c-fheight").value, "120000", "funding height carried");
  assert.equal(getEl("c-cheight").value, "120600", "tip carried as current height");
  setVal("c-heir-input", HEIR_PRIV);
  setVal("c-dest", HEIR_ADDR);
  setVal("c-fee", "5");
  // one block early: the UI surfaces the core's loud maturity refusal
  setVal("c-cheight", "120444");
  click("c-build");
  assert.ok(!getEl("c-error").hidden, "immature claim shows an error");
  assert.ok(getEl("c-error").textContent.includes("not yet mature"), "maturity refusal: " + getEl("c-error").textContent);
  assert.ok(getEl("c-error").textContent.includes("1 blocks to go"), "blocks-to-go shown");
  // mature: builds
  setVal("c-cheight", "120600");
  click("c-build");
  assert.equal(getEl("c-error").hidden, true, "no claim error: " + getEl("c-error").textContent);
  assert.equal(getEl("c-result").hidden, false, "claim result shown");
  assert.equal(getEl("c-heir-input").value, "", "heir secret wiped after build");
  const expected = E.buildHeirClaim(net, vault, {
    utxo: { txid: "ab".repeat(32), vout: 0, value: 100000000 },
    heirPrivHex: HEIR_PRIV,
    destAddress: HEIR_ADDR, fundingHeight: 120000, currentHeight: 120600,
    feeRateGrainsPerVByte: 5,
  });
  // Schnorr aux randomness -> structural comparison (core re-verified the DOM sigs)
  const dom = E.parseTx(getEl("c-hex").value);
  const ref = E.parseTx(expected.hex);
  assert.equal(dom.inputs.length, 1, "single claim input");
  assert.equal(dom.inputs[0].sequence, 445, "claim nSequence = n");
  assert.equal(dom.inputs[0].witness.length, 3, "script-path witness shape");
  assert.equal(dom.outputs.length, 1, "single output");
  assert.equal(dom.outputs[0].value, ref.outputs[0].value, "output value matches core fee math");
  assert.equal(E.bytesToHex(dom.outputs[0].spk), E.bytesToHex(ref.outputs[0].spk), "output pays the heir destination");
  assert.ok(/^[0-9a-f]{64}$/.test(getEl("c-txid-out").textContent), "txid shown");
  assert.ok(getEl("c-fee-out").textContent.includes("grains @"), "fee + vbytes shown");
});

test("flow: owner refresh (same address, fresh UTXO, multi-input)", () => {
  const vault = sandbox.__vault;
  setRadio("c-mode", "refresh"); // the UI's claimMode() reads this on change
  getEl("c-claim-box").hidden = true;
  getEl("c-refresh-box").hidden = false;
  setVal("r-owner-input", OWNER_PRIV);
  setVal("r-utxos", `ab${"0".repeat(62)}:0:100000000\ncd${"0".repeat(62)}:1:200000000`);
  setVal("r-fee", "5");
  // note: refresh uses the carried spec; ensure the claim tab has it
  setVal("c-spec", getEl("pl-spec").value);
  click("c-load");
  click("r-build");
  assert.equal(getEl("c-error").hidden, true, "no refresh error: " + getEl("c-error").textContent);
  assert.equal(getEl("r-fresh").hidden, false, "heartbeat panel shown");
  const freshAddr = getEl("r-fresh-address").textContent;
  assert.equal(freshAddr, vault.address, "refresh pays the SAME vault address (heartbeat = fresh UTXO, same contract)");
  assert.ok(getEl("r-fresh-note").textContent.includes("SAME vault address"), "heartbeat note explains same address");
  const rdom = E.parseTx(getEl("c-hex").value);
  assert.equal(rdom.outputs.length, 1, "refresh has a single output");
  assert.equal(E.bytesToHex(rdom.outputs[0].spk), vault.spkHex, "refresh output pays the vault's own spk");
  assert.equal(rdom.inputs.length, 2, "refresh spends every UTXO");
  for (const pin of rdom.inputs) assert.equal(pin.sequence, 0xfffffffe, "refresh inputs final");
  assert.equal(getEl("r-owner-input").value, "", "owner secret wiped after build");
});

test("flow: verifier (good + tampered + malformed)", () => {
  const vault = sandbox.__vault;
  setVal("vf-descriptor", vault.descriptor);
  setVal("vf-address", vault.address);
  click("vf-run");
  assert.equal(getEl("vf-error").hidden, true, "no verify error");
  assert.ok(getEl("vf-verdict").innerHTML.includes("VERIFIED"), "good descriptor verifies");
  assert.ok(getEl("vf-verdict").innerHTML.includes(vault.address), "recomputed address shown");

  // tamper with n against the claimed original address -> LOUD REFUSAL
  setVal("vf-descriptor", vault.descriptor.replace(":445", ":446"));
  click("vf-run");
  assert.ok(getEl("vf-verdict").innerHTML.includes("REFUSED"), "tampered descriptor refused");
  assert.ok(getEl("vf-verdict").innerHTML.includes("LOUD REFUSAL"), "loud refusal wording");

  // malformed
  setVal("vf-descriptor", "legacy:v1:bogus");
  click("vf-run");
  assert.ok(getEl("vf-verdict").innerHTML.includes("REFUSED"), "malformed -> refused");

  // address missing
  setVal("vf-descriptor", vault.descriptor);
  setVal("vf-address", "");
  click("vf-run");
  assert.ok(getEl("vf-verdict").innerHTML.includes("REFUSED"), "missing address -> refused");
});

test("footer carries donation address + X link; honest limits present", () => {
  assert.ok(html.includes("prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d"), "donation address in footer");
  assert.ok(html.includes("https://x.com/kshot9000"), "X link in footer");
  assert.ok(html.includes("honest-limits"), "honest limits panel");
  assert.ok(html.includes("never moves PRL by itself"), "no-PRL-movement honesty");
  const bundle = fs.readFileSync(resolvePath(dir, "pearl-legacy.bundle.js"), "utf8");
  assert.ok(bundle.includes("PearlLegacy"), "bundle exposes window.PearlLegacy");
});
