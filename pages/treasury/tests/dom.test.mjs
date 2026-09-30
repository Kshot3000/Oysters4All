/* Pearl Treasury DOM tests — drive the REAL app.js against a strict DOM shim.
 *
 * Strictness rule: document.getElementById THROWS on an unknown id, so a test
 * can never pass by clicking phantom elements the app never wired. Every id
 * used here was copied from index.html; every flow below exercises the real
 * handlers in app.js (vault register -> proposal -> round build -> 2-key sign
 * to quorum -> disburse finalize -> audit verify), with all cryptography
 * running locally in the bundle. fetch is stubbed offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolvePath(here, "..");

/* ---------- strict minimal DOM (copied from the bounty harness) ---------- */
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
    if (this.tagName === "TEXTAREA" || this.tagName === "PRE") this.textContent = "";
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
let B; // the PearlTreasury bundle namespace, for fixtures
const consoleErrors = [];
function bootApp() {
  consoleErrors.length = 0;
  const html = readFileSync(resolvePath(appDir, "index.html"), "utf8");
  const { document } = buildDocument(html);
  const bundleJs = readFileSync(resolvePath(appDir, "pearl-treasury.bundle.js"), "utf8");
  const appJs = readFileSync(resolvePath(appDir, "app.js"), "utf8");
  const store = {};
  const wrappedConsole = {
    log: () => {}, info: () => {}, warn: () => {},
    error: (...a) => { consoleErrors.push(a.map(String).join(" ")); },
  };
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
    console: wrappedConsole,
    URL, Blob, Date,
    TextEncoder, TextDecoder,
    btoa, atob,
    crypto: globalThis.crypto,
    window: {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(bundleJs + "\nwindow.PearlTreasury = PearlTreasury;", sandbox, { filename: "pearl-treasury.bundle.js" });
  vm.runInContext(appJs, sandbox, { filename: "app.js" });
  B = vm.runInContext("window.PearlTreasury", sandbox);
  const $ = (id) => document.getElementById(id);
  return { $, document, store };
}

const tick = () => new Promise((r) => setTimeout(r, 20));
bootApp(); // module-level boot so B (the bundle) exists for fixtures
const sha = (s) => B.sha256(new TextEncoder().encode(s));
const PRIVS = [1, 2, 3].map((i) => B.bytesToHex(sha("treasury-dom-key-" + i)));
const XONLY = PRIVS.map((p) => B.Covenant.pubkeyFromPriv(p));
const PAYEE = B.walletFromPriv(B.hexToBytes(B.bytesToHex(sha("treasury-dom-payee"))), B.NETWORKS.mainnet).address;
const OUTSIDER = B.bytesToHex(sha("treasury-dom-outsider"));

function detDescriptor() {
  const { covenant } = B.Covenant.createCovenant({ m: 2, keyInputs: XONLY, network: B.NETWORKS.mainnet });
  return B.Covenant.covenantDescriptor(covenant);
}
function vaultIdFromStore(store, label) {
  const vs = JSON.parse(store["pearl-treasury-v1:vaults"]);
  return vs.find((v) => v.label === label).id;
}

function registerDetVault($, store) {
  $("v-label").value = "Det vault";
  $("v-desc").value = detDescriptor();
  $("v-register").click();
  assert.equal($("v-err").textContent, "", "register error box must be empty");
  return vaultIdFromStore(store, "Det vault");
}

function createProposalDom($, vaultId, amount = "1.25") {
  $("p-vault").value = vaultId;
  $("p-payee").value = PAYEE;
  $("p-amount").value = amount;
  $("p-memo").value = "dom invoice";
  $("p-creator").value = "dom";
  $("p-create").click();
  assert.equal($("p-err").textContent, "", "proposal error box must be empty");
  assert.match($("p-detail").textContent, /"fingerprint": "[0-9a-f]{16}"/, "proposal detail shows fingerprint");
  const ps = JSON.parse($("p-detail").textContent);
  return ps.id;
}

test("bundle exposes the treasury API", () => {
  bootApp();
  for (const fn of ["registerVault", "generateDemoVault", "fetchVaultBalance", "vaultTotals",
    "createProposal", "verifyProposal", "parseProposal", "serializeProposal", "assertProposalTransition",
    "selectUtxoForProposal", "buildProposalRound", "roundMatchesProposal", "finalizeProposalSpend",
    "createKeyVault", "cosignerKeyFromInput", "validateRecurrence", "nextDueISO",
    "auditAppend", "verifyAuditChain", "exportAuditJSON", "exportAuditCSV",
    "prlToGrains", "grainsToPRL", "tamperId", "covenantDescriptor", "parseRound", "serializeRound",
    "signRound", "importSig", "roundStatus", "NETWORKS", "BLOCKBOOK_MAINNET", "DUST_GRAIN"]) {
    assert.ok(B[fn] !== undefined, fn + " exposed");
  }
  assert.ok(B.Covenant && B.Sign, "Covenant + Sign namespaces ride along");
});

test("step navigation toggles panels", () => {
  const { $, document } = bootApp();
  document.querySelector('#steps button[data-step="sign"]').click();
  assert.ok($("step-sign").classList.contains("active"), "sign panel active");
  assert.ok(!$("step-vaults").classList.contains("active"), "vaults panel inactive");
  document.querySelector('#steps button[data-step="audit"]').click();
  assert.ok($("step-audit").classList.contains("active"), "audit panel active");
});

test("vaults: demo generation + manual descriptor registration", async () => {
  const { $, store } = bootApp();
  $("v-gen").click();
  await tick();
  assert.ok(!$("v-genout").classList.contains("hidden"), "demo panel shown");
  assert.match($("v-gen-desc").value, /^covenant:v1:prl:2-of-3:/, "demo descriptor shape");
  assert.match($("v-gen-address").value, /^prl1p/, "demo address shown");
  assert.ok($("v-rows").innerHTML.includes("demo"), "demo badge in row");
  assert.match($("v-totals").textContent, /across 1 vault/, "totals row");
  const vid = registerDetVault($, store);
  assert.ok($("v-rows").innerHTML.includes("Det vault"), "second vault row");
  assert.match($("v-totals").textContent, /across 2 vault/, "totals updated");
  assert.ok(vid, "vault id returned");
});

test("vaults: bad descriptor refused loudly", () => {
  const { $ } = bootApp();
  $("v-label").value = "bad";
  $("v-desc").value = "covenant:v9:prl:2-of-3:deadbeef";
  $("v-register").click();
  assert.match($("v-err").textContent, /descriptor/i, "error shown");
  assert.ok(!$("v-rows").innerHTML.includes("bad</strong>"), "no row added");
});

test("proposals: create -> detail -> tamper-check passes", async () => {
  const { $, document, store } = bootApp();
  const vid = registerDetVault($, store);
  document.querySelector('#steps button[data-step="proposals"]').click();
  const pid = createProposalDom($, vid);
  assert.match($("p-rows").innerHTML, /1\.25/, "proposal row shows amount");
  $("p-verify").click();
  await tick();
  assert.match($("p-verify-out").textContent, /verify/, "tamper-check passes");
  const ps = JSON.parse(store["pearl-treasury-v1:proposals"]);
  assert.ok(ps.some((p) => p.id === pid && p.status === "open"), "proposal persisted open");
});

test("proposals: bad payee refused", () => {
  const { $, document, store } = bootApp();
  const vid = registerDetVault($, store);
  document.querySelector('#steps button[data-step="proposals"]').click();
  $("p-vault").value = vid;
  $("p-payee").value = "not an address";
  $("p-amount").value = "1";
  $("p-create").click();
  assert.ok($("p-err").textContent.length > 0, "payee error shown");
});

test("sign: wrong key refused, two cosigners reach quorum", async () => {
  const { $, document, store } = bootApp();
  const vid = registerDetVault($, store);
  document.querySelector('#steps button[data-step="proposals"]').click();
  const pid = createProposalDom($, vid);
  document.querySelector('#steps button[data-step="sign"]').click();

  // build the round with a demo UTXO
  $("s-proposal").value = pid;
  $("s-utxo").value = `${"ab".repeat(32)}:0`;
  $("s-utxo-value").value = "250000000";
  $("s-feerate").value = "5";
  $("s-buildround").click();
  await tick();
  assert.equal($("s-err").textContent, "", "round build error box empty");
  assert.match($("s-round-out").textContent, /digest\s+:\s+[0-9a-f]{64}/, "round digest shown");
  assert.ok($("d-round").value.length > 100, "round fanned out to disburse tab");

  // outsider key: review refuses loudly
  $("s-keylabel").value = "mallory";
  $("s-key").value = OUTSIDER;
  $("s-review").click();
  await tick();
  assert.match($("s-err").textContent, /REFUSED.*NOT a cosigner/, "wrong key loudly refused");

  // cosigner 1 signs (double-confirm)
  $("s-keylabel").value = "alice";
  $("s-key").value = PRIVS[0];
  $("s-review").click();
  await tick();
  assert.ok(!$("s-review-wrap").classList.contains("hidden"), "review panel shown");
  assert.match($("s-review-out").textContent, /1\.25000000 PRL/, "review shows amount");
  $("s-confirm").click();
  await tick();
  assert.equal($("s-key").value, "", "key field cleared after signing");
  assert.match($("s-quorum").textContent, /quorum 1-of-2/, "one signature counted");
  assert.match($("s-keystatus").textContent, /alice/, "key held in memory");

  // cosigner 2 signs -> quorum
  $("s-keylabel").value = "bob";
  $("s-key").value = PRIVS[1];
  $("s-review").click();
  await tick();
  $("s-confirm").click();
  await tick();
  assert.match($("s-quorum").textContent, /quorum 2-of-2.*READY/, "quorum reached");
  const ps = JSON.parse(store["pearl-treasury-v1:proposals"]);
  assert.equal(ps.find((p) => p.id === pid).status, "quorum", "proposal -> quorum");

  // wipe keys
  $("s-wipe").click();
  await tick();
  assert.match($("s-keystatus").textContent, /no keys in memory/, "keys wiped");
});

test("sign: duplicate signature refused", async () => {
  const { $, document, store } = bootApp();
  const vid = registerDetVault($, store);
  document.querySelector('#steps button[data-step="proposals"]').click();
  const pid = createProposalDom($, vid);
  document.querySelector('#steps button[data-step="sign"]').click();
  $("s-proposal").value = pid;
  $("s-utxo").value = `${"ab".repeat(32)}:0`;
  $("s-utxo-value").value = "250000000";
  $("s-buildround").click();
  await tick();
  $("s-keylabel").value = "alice";
  $("s-key").value = PRIVS[0];
  $("s-review").click(); await tick();
  $("s-confirm").click(); await tick();
  $("s-key").value = PRIVS[0];
  $("s-review").click(); await tick();
  $("s-confirm").click(); await tick();
  assert.match($("s-err").textContent, /already signed/, "duplicate refused");
});

test("disburse: intent match -> finalize hex", async () => {
  const { $, document, store } = bootApp();
  const vid = registerDetVault($, store);
  document.querySelector('#steps button[data-step="proposals"]').click();
  const pid = createProposalDom($, vid);
  document.querySelector('#steps button[data-step="sign"]').click();
  $("s-proposal").value = pid;
  $("s-utxo").value = `${"ab".repeat(32)}:0`;
  $("s-utxo-value").value = "250000000";
  $("s-buildround").click(); await tick();
  for (const [label, priv] of [["alice", PRIVS[0]], ["bob", PRIVS[1]]]) {
    $("s-keylabel").value = label;
    $("s-key").value = priv;
    $("s-review").click(); await tick();
    $("s-confirm").click(); await tick();
  }
  document.querySelector('#steps button[data-step="disburse"]').click();
  $("d-verify-match").click();
  await tick();
  assert.match($("d-match-out").textContent, /matches proposal intent.*READY/, "intent match + ready");
  $("d-finalize").click();
  await tick();
  assert.match($("d-txid").textContent, /^[0-9a-f]{64}$/, "txid shown");
  assert.match($("d-hex").value, /^[0-9a-f]{400,}$/, "raw hex built");
  assert.match($("d-fee").textContent, /PRL/, "fee shown");
});

test("disburse: tampered round is refused", async () => {
  const { $, document, store } = bootApp();
  const vid = registerDetVault($, store);
  document.querySelector('#steps button[data-step="proposals"]').click();
  const pid = createProposalDom($, vid);
  document.querySelector('#steps button[data-step="disburse"]').click();
  $("d-proposal").value = pid;
  // a round for a DIFFERENT payee must fail the intent check (digest mismatch on parse)
  const evil = B.Covenant.buildSigningRound(
    B.Covenant.covenantFromDescriptor(detDescriptor(), B.NETWORKS.mainnet),
    B.NETWORKS.mainnet,
    { utxo: { txid: "ab".repeat(32), vout: 0, value: 250_000_000 },
      payments: [{ address: B.walletFromPriv(B.hexToBytes(OUTSIDER), B.NETWORKS.mainnet).address, valueGrains: 125_000_000 }],
      feeRateGrainsPerVByte: 5, memo: "" },
  );
  $("d-round").value = B.Covenant.serializeRound(evil);
  $("d-verify-match").click();
  await tick();
  assert.ok($("d-err").textContent.length > 0, "mismatched round refused");
});

test("audit: chain verifies, exports work", async () => {
  const { $, document } = bootApp();
  $("v-label").value = "Audit vault";
  $("v-desc").value = detDescriptor();
  $("v-register").click();
  await tick();
  document.querySelector('#steps button[data-step="audit"]').click();
  $("a-verify").click();
  await tick();
  assert.match($("a-verdict").textContent, /chain intact/, "chain verifies");
  assert.ok($("a-rows").innerHTML.includes("vault.registered"), "event logged");
  $("a-export-json").click();
  const j = JSON.parse($("a-export").value);
  assert.ok(j.length >= 1 && j[0].hash, "JSON export");
  $("a-export-csv").click();
  assert.match($("a-export").value, /^seq,ts,kind,actor,detail,prev,hash\n/, "CSV export");
});

test("schedules: add + next-due renders", async () => {
  const { $, document, store } = bootApp();
  const vid = registerDetVault($, store);
  document.querySelector('#steps button[data-step="proposals"]').click();
  const pid = createProposalDom($, vid);
  document.querySelector('#steps button[data-step="disburse"]').click();
  $("d-sched-proposal").value = pid;
  $("d-sched-start").value = "2026-10-01";
  $("d-sched-unit").value = "weeks";
  $("d-sched-every").value = "2";
  $("d-sched-add").click();
  await tick();
  assert.ok($("d-sched-rows").innerHTML.includes("every 2 weeks"), "schedule row");
  assert.match($("d-sched-rows").innerHTML, /2026-10-1\d|2026-10-0\d/, "next due date shown");
});

test("honest limits + footer attribution always visible", () => {
  bootApp();
  const html = readFileSync(resolvePath(appDir, "index.html"), "utf8");
  assert.ok(html.includes("no smart contracts"), "limits mention no smart contracts");
  assert.ok(html.includes("Blockbook"), "limits mention Blockbook");
  assert.ok(html.includes("in memory only"), "limits mention key hygiene");
  assert.ok(html.includes("@kshot9000"), "footer attribution");
  assert.ok(html.includes("prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d"), "donation address");
});

test("zero console errors across the whole drive", () => {
  bootApp();
  assert.deepEqual(consoleErrors, [], "no console.error calls during boot");
});
