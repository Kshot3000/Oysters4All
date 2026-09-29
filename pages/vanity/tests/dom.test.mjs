// Pearl Vanity DOM integration test — boots the real index.html + committed
// bundle (pearl-vanity.bundle.js) + app.js against a minimal DOM shim and a
// FakeWorker (Blob-URL worker path) that grinds a real 1-char prefix with the
// actual bundled crypto. Drives: invalid prefix -> error; valid prefix ->
// difficulty panel; forge -> grind -> found -> claim; reveal secrets; footer
// attribution. Run: node --no-warnings --loader ./tests/loader.mjs tests/dom.test.mjs
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
  select() {}
}
const byId = new Map();
const hiddenIds = new Set([...html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*\bhidden\b[^>]*>/g)].map((m) => m[1]));
const getEl = (id) => {
  if (!byId.has(id)) {
    const el = new El("div", id);
    if (hiddenIds.has(id)) el.hidden = true;
    // seed default form values from the real HTML
    const tagM = html.match(new RegExp(`<(?:input|select|textarea)[^>]*\\bid="${id}"[^>]*>`, "i"));
    if (tagM) {
      const tag = tagM[0];
      const valM = tag.match(/\bvalue="([^"]*)"/i);
      if (valM) el.value = valM[1];
      if (/^<select/i.test(tag)) {
        const sel = tagM[0] + html.slice(tagM.index + tagM[0].length, tagM.index + tagM[0].length + 2000).split("</select>")[0];
        const optM = sel.match(/<option[^>]*\bvalue="([^"]*)"[^>]*\bselected\b/i) || sel.match(/<option[^>]*\bvalue="([^"]*)"/i);
        if (optM) el.value = optM[1];
      }
    }
    byId.set(id, el);
  }
  return byId.get(id);
};
let modeValue = "random";
const stepEls = [...html.matchAll(/<section[^>]*\bid="step-([^"]+)"[^>]*>/g)].map((m) => {
  const el = getEl("step-" + m[1]); // shared registry: app toggles these same objects
  el.classList.remove("active");
  if (/class="[^"]*\bactive\b/.test(m[0])) el.classList.add("active");
  return el;
});
const stepBtns = [...html.matchAll(/<button data-step="([^"]+)"[^>]*>/g)].map((m) => {
  const b = new El("button"); b.dataset.step = m[1];
  if (/\bactive\b/.test(m[0])) b.classList.add("active");
  return b;
});
const modeRadios = ["random", "bip86"].map((v) => {
  const el = new El("input"); el.value = v; el.name = "mode";
  el.addEventListener("change", () => { modeValue = v; });
  return el;
});
const documentShim = {
  getElementById: getEl,
  querySelectorAll: (sel) => {
    if (sel === "#steps button") return stepBtns;
    if (sel === ".step") return stepEls;
    if (sel === 'input[name="mode"]') return modeRadios;
    return [];
  },
  querySelector: (sel) => {
    const m = sel.match(/^input\[name="mode"\]:checked$/);
    if (m) { const el = new El("input"); el.value = modeValue; return el; }
    return null;
  },
  createElement: (t) => new El(t),
  body: new El("body"),
};

/* FakeWorker: exercises the Blob-URL worker path; grinds with real bundled crypto */
const posted = [];
class FakeWorker {
  constructor(url) { this.url = url; this.onmessage = null; this.onerror = null; posted.push(this); }
  postMessage(msg) {
    if (msg.cmd === "stop") return;
    if (msg.cmd !== "start") return;
    setTimeout(() => {
      try {
        const V = sandbox.PearlVanity;
        let found = null, scanned = 0;
        const rnd = (n) => vm.runInContext(`crypto.getRandomValues(new Uint8Array(${n}))`, sandbox);
        for (let b = 0; b < 4000 && !found; b++) {
          const r = V.grindBatch({
            prefix: msg.prefix, networkId: msg.networkId, mode: "random",
            startIndex: 0, stride: 1, batchSize: 256, rng: rnd,
          });
          scanned += r.scanned;
          found = r.found;
        }
        if (!found) throw new Error("fake worker failed to find 1-char prefix");
        this.onmessage({ data: { type: "found", result: found, attempts: scanned } });
      } catch (e) {
        if (this.onerror) this.onerror(e);
        else this.onmessage({ data: { type: "error", message: String(e.message || e) } });
      }
    }, 5);
  }
  terminate() {}
}

const sandbox = {
  document: documentShim,
  navigator: { clipboard: { writeText: async () => {} } },
  TextDecoder, crypto: webcrypto,
  setTimeout, clearTimeout, setInterval, clearInterval,
  scrollTo() {},
  console,
  URL: { createObjectURL: () => "blob:fake", revokeObjectURL() {} },
  Blob: class { constructor(parts) { this.parts = parts; } },
  Worker: FakeWorker,
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
for (const f of ["pearl-vanity.bundle.js", "app.js"]) {
  vm.runInContext(fs.readFileSync(resolvePath(dir, f), "utf8"), sandbox, { filename: f, timeout: 15000 });
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

test("invalid prefix shows error and blocks forging", () => {
  const V = sandbox.PearlVanity;
  assert.ok(V, "bundle exposes window.PearlVanity");
  assert.ok(V.WORKER_SRC && V.WORKER_SRC.length > 100000, "worker source embedded");
  const prefix = getEl("prefix");
  prefix.value = "ab1";
  prefix.fire("input");
  assert.equal(getEl("prefix-err").hidden, false);
  assert.match(getEl("prefix-err").textContent, /bech32/);
});

test("valid prefix updates difficulty panel", async () => {
  const prefix = getEl("prefix");
  prefix.value = "q";
  prefix.fire("input");
  assert.equal(getEl("prefix-err").hidden, true);
  assert.equal(getEl("preview").textContent, "prl1pq…");
  assert.equal(getEl("d-expected").textContent, "32");
});

test("full flow: forge -> grind -> found -> claim", async () => {
  getEl("threads").value = "2";
  getEl("max-attempts").value = "0";
  getEl("to-grind").click();
  assert.ok(getEl("step-grind").classList.contains("active"), "grind step active");
  assert.equal(posted.length, 0, "no workers before start");
  getEl("start").click();
  assert.equal(posted.length, 2, "two Blob-URL workers spawned");
  assert.ok(posted[0].url === "blob:fake");
  // wait for the fake worker's found message
  for (let i = 0; i < 200 && !getEl("step-claim").classList.contains("active"); i++) await tick();
  assert.ok(getEl("step-claim").classList.contains("active"), "claim step shown after find");
  const addr = getEl("r-address").textContent;
  assert.ok(addr.startsWith("prl1pq"), "found address matches prefix: " + addr);
  assert.equal(getEl("r-verify").textContent, "✓ re-derived from secret + prefix matched");
  // independent re-derivation through the bundle
  const V = sandbox.PearlVanity;
  const w = V.vanityFromPriv(getEl("r-privhex").textContent, V.NETWORKS.mainnet);
  assert.equal(w.address, addr);
  assert.equal(getEl("r-wif").textContent, V.vanityToWIF(getEl("r-privhex").textContent, V.NETWORKS.mainnet));
  assert.equal(getEl("r-mode").textContent, "Fresh random key (NOT in any seed — back it up)");
});

test("reveal toggles secrets; footer carries attribution", () => {
  getEl("reveal").click();
  assert.equal(getEl("secrets").hidden, false);
  assert.equal(getEl("r-privhex").textContent.length, 64);
  assert.ok(getEl("r-wif").textContent.length > 40);
  getEl("reveal").click();
  assert.equal(getEl("secrets").hidden, true);
  assert.ok(html.includes("@kshot9000"), "footer X handle");
  assert.ok(html.includes("prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d"), "footer donation address");
});

test("bundle exposes the documented API", () => {
  const V = sandbox.PearlVanity;
  for (const fn of ["normalizePrefix", "expectedAttempts", "grindBatch", "verifyFound",
    "vanityFromPriv", "vanityToWIF", "vanityFromWIF", "seedFromMnemonic",
    "newVanityMnemonic", "bip86AccountNode", "proveKeyControl", "WORKER_SRC"]) {
    assert.ok(V[fn] !== undefined, "missing export: " + fn);
  }
});
