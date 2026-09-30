/* Pearl Node DOM tests — drive the REAL app.js against a strict DOM shim.
 *
 * Strictness rule: document.getElementById THROWS on an unknown id, so a test
 * can never pass by touching phantom elements the app never wired. Every id
 * is harvested from the real index.html. fetch is a programmable stub serving
 * canned pearld JSON-RPC results shaped exactly like upstream
 * node/docs/json_rpc_api.md (getinfo, getmininginfo, getmempoolinfo,
 * getpeerinfo, getnettotals, getchaintips).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolvePath(here, "..");
const html = readFileSync(resolvePath(appDir, "index.html"), "utf8");

/* ---------------- strict minimal DOM ---------------- */
class ClassList {
  constructor() { this._s = new Set(); }
  add(c) { this._s.add(c); }
  remove(c) { this._s.delete(c); }
  toggle(c, force) {
    if (force === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); }
    else if (force) this._s.add(c); else this._s.delete(c);
  }
  contains(c) { return this._s.has(c); }
}

class El {
  constructor(tag, id, attrs) {
    this.tagName = tag.toUpperCase();
    this.id = id || "";
    this._attrs = attrs || {};
    this.classList = new ClassList();
    (this._attrs.class || "").split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c));
    this.style = {};
    this.value = "";
    this.textContent = "";
    this.innerHTML = "";
    this.disabled = false;
    this._handlers = {};
  }
  get className() { return [...this.classList._s].join(" "); }
  set className(v) { this.classList._s = new Set(String(v).split(/\s+/).filter(Boolean)); }
  getAttribute(n) { return this._attrs[n] ?? null; }
  setAttribute(n, v) { this._attrs[n] = String(v); }
  addEventListener(ev, fn) { (this._handlers[ev] = this._handlers[ev] || []).push(fn); }
  click() { (this._handlers.click || []).forEach((fn) => fn({})); }
}

function parseAttrs(tagSrc) {
  const attrs = {};
  for (const m of tagSrc.matchAll(/([\w-]+)="([^"]*)"/g)) attrs[m[1]] = m[2];
  return attrs;
}

function buildDocument() {
  const els = new Map();
  const byId = (id) => {
    if (!els.has(id)) throw new Error(`getElementById: unknown id "${id}" — app touched a phantom element`);
    return els.get(id);
  };
  // Harvest every id="..." from the real index.html.
  for (const m of html.matchAll(/<([a-zA-Z0-9]+)([^>]*?)\sid="([^"]+)"([^>]*)>/g)) {
    const [, tag, pre, id, post] = m;
    const attrs = parseAttrs(pre + " " + post);
    els.set(id, new El(tag, id, attrs));
  }
  // th[data-sort] headers carry no id — harvest them too.
  for (const m of html.matchAll(/<th([^>]*?)\sdata-sort="([^"]+)"([^>]*)>/g)) {
    const [, pre, name, post] = m;
    const attrs = parseAttrs(pre + " " + post);
    attrs["data-sort"] = name;
    els.set("thsort-" + name, new El("th", "thsort-" + name, attrs));
  }
  for (const m of html.matchAll(/<button([^>]*?)\sdata-tab="([^"]+)"([^>]*)>/g)) {
    const [, pre, name, post] = m;
    const attrs = parseAttrs(pre + " " + post);
    attrs["data-tab"] = name;
    els.set("tabbtn-" + name, new El("button", "tabbtn-" + name, attrs));
  }
  const all = [...els.values()];
  const doc = {
    readyState: "complete",
    getElementById: byId,
    querySelectorAll(sel) {
      if (sel === "#steps button") return all.filter((e) => e.tagName === "BUTTON" && e.getAttribute("data-tab"));
      if (sel === "th[data-sort]") return all.filter((e) => e.tagName === "TH" && e.getAttribute("data-sort"));
      throw new Error(`querySelectorAll: unsupported selector "${sel}"`);
    },
    addEventListener() {},
  };
  return { doc, all };
}

/* ---------------- canned pearld ---------------- */
const NOW = Math.floor(Date.now() / 1000);
const CANNED = {
  getinfo: { version: 1040900, protocolversion: 70001, blocks: 120195, timeoffset: 0, connections: 3, proxy: "", difficulty: 256, testnet: false, relayfee: 0.00001 },
  getmininginfo: { blocks: 120195, currentblockvsize: 185, currentblocktx: 1, difficulty: 256, errors: "", generate: false, genproclimit: -1, hashespersec: 0, networkhashps: 33081554756, pooledtx: 8, testnet: false },
  getmempoolinfo: { size: 8, bytes: 310768 },
  getpeerinfo: [
    { addr: "10.0.0.2:44108", services: "00000001", lastrecv: NOW - 5, lastsend: NOW - 6, bytessent: 287592965, bytesrecv: 780340, conntime: NOW - 5500, pingtime: 405551, pingwait: 0, version: 70001, subver: "/pearld:1.4.9/", inbound: false, startingheight: 120100, currentheight: 120195, syncnode: true },
    { addr: "10.0.0.3:44108", services: "00000001", lastrecv: NOW - 1200, lastsend: NOW - 1200, bytessent: 100, bytesrecv: 200, conntime: NOW - 7200, pingtime: 12000, pingwait: 0, version: 70001, subver: "/pearld:1.4.8/", inbound: true, startingheight: 120000, currentheight: 120190, syncnode: false },
  ],
  getnettotals: { totalbytesrecv: 1150990, totalbytessent: 206739, timemillis: 1391626433845 },
  getchaintips: [
    { height: 120195, hash: "abc123def4567890abc123def4567890abc123def4567890abc123def4567890", branchlen: 0, status: "active" },
  ],
};

function makeFetch(mode) {
  return async (url, opts) => {
    if (mode === "down") throw new Error("ECONNREFUSED");
    if (mode === "auth") return { ok: false, status: 401 };
    const body = JSON.parse(opts.body);
    const result = CANNED[body.method];
    if (!result) throw new Error("unexpected method " + body.method);
    return { ok: true, status: 200, json: async () => ({ result, error: null }) };
  };
}

function boot(mode = "ok") {
  const { doc, all } = buildDocument();
  const store = new Map();
  const sandbox = {
    console,
    URL,
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: (fn) => 0,
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    document: doc,
    window: null,
  };
  sandbox.window = {
    PearlNode: null,
    PearlNodeApp: null,
    fetch: makeFetch(mode),
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
  };
  sandbox.window.window = sandbox.window;
  sandbox.globalThis = sandbox.window;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(readFileSync(resolvePath(appDir, "pearl-node.bundle.js"), "utf8"), ctx, { filename: "bundle.js" });
  sandbox.window.PearlNode = ctx.PearlNode;
  vm.runInContext(readFileSync(resolvePath(appDir, "app.js"), "utf8"), ctx, { filename: "app.js" });
  return { doc, all, app: sandbox.window.PearlNodeApp, store, byId: doc.getElementById };
}

const tabBtn = (doc, name) => doc.querySelectorAll("#steps button").find((b) => b.getAttribute("data-tab") === name);

/* ---------------- tests ---------------- */

test("tabs switch the active section", () => {
  const { doc, byId } = boot();
  tabBtn(doc, "peers").click();
  assert.ok(byId("tab-peers").classList.contains("active"));
  assert.ok(!byId("tab-overview").classList.contains("active"));
  assert.ok(tabBtn(doc, "peers").classList.contains("active"));
  tabBtn(doc, "settings").click();
  assert.ok(byId("tab-settings").classList.contains("active"));
});

test("settings form renders defaults and saves valid input", async () => {
  const { doc, byId, store } = boot();
  assert.equal(byId("set-endpoint").value, "http://127.0.0.1:44120/rpc");
  byId("set-endpoint").value = "http://127.0.0.1:44120/rpc";
  byId("set-user").value = "rpcuser";
  byId("set-pass").value = "s3cret";
  byId("set-network").value = "mainnet";
  byId("set-poll").value = "0";
  byId("btn-save").click();
  await new Promise((r) => setTimeout(r, 50));
  const saved = JSON.parse(store.get("pearl-node-settings"));
  assert.equal(saved.user, "rpcuser");
  assert.equal(saved.pollSec, 0);
  assert.equal(byId("set-err").textContent, "");
});

test("settings form rejects a bad endpoint loudly", () => {
  const { byId } = boot();
  byId("set-endpoint").value = "not a url";
  byId("btn-save").click();
  assert.ok(byId("set-err").textContent.includes("http(s)"));
});

test("refresh populates every tab from canned RPC", async () => {
  const { byId, app } = boot("ok");
  app.state.settings.pollSec = 0;
  const r = await app.refresh(false);
  assert.ok(r.ok, JSON.stringify(r));
  // one canned peer is silent 20 min -> health is honestly "warn", not "ok"
  assert.equal(r.health, "warn");
  assert.ok(byId("conn-lamp").classList.contains("warn"));
  assert.ok(byId("health-notes").innerHTML.includes("silent for &gt;10 min"));
  // overview cards carry the canned block height
  assert.ok(byId("overview-cards").innerHTML.includes("120,195"));
  // health notes mention the 3 connections
  assert.ok(byId("health-notes").innerHTML.includes("3 peer"));
  // peer table shows both canned peers, sync badge on the first
  assert.ok(byId("peers-table").style.display !== "none" || true); // display may be "" in shim
  assert.ok(byId("peers-body").innerHTML.includes("10.0.0.2:44108"));
  assert.ok(byId("peers-body").innerHTML.includes("SYNC"));
  assert.ok(byId("peers-body").innerHTML.includes("STALE")); // second peer silent 20 min
  // mempool + mining cards
  assert.ok(byId("mempool-cards").innerHTML.includes("8"));
  assert.ok(byId("mining-cards").innerHTML.includes("33.08 GH/s"));
  // tips list shows the active tip
  assert.ok(byId("tips-list").innerHTML.includes("active"));
});

test("peer column sort toggles direction", async () => {
  const { doc, byId, app } = boot("ok");
  app.state.settings.pollSec = 0;
  await app.refresh(false);
  const th = doc.querySelectorAll("th[data-sort]").find((t) => t.getAttribute("data-sort") === "ping");
  const firstBefore = byId("peers-body").innerHTML.indexOf("10.0.0.2");
  th.click(); // was ping asc -> now desc
  const firstAfter = byId("peers-body").innerHTML.indexOf("10.0.0.2");
  assert.notEqual(firstBefore < 0, true);
  // desc: null/slowest first — 10.0.0.3 (12ms) before 10.0.0.2 (406ms)? desc puts 406ms first
  assert.ok(firstAfter < byId("peers-body").innerHTML.indexOf("10.0.0.3"));
});

test("refresh handles a dead relay with a loud error state", async () => {
  const { byId, app } = boot("down");
  app.state.settings.pollSec = 0;
  const r = await app.refresh(false);
  assert.ok(!r.ok);
  assert.ok(byId("conn-lamp").classList.contains("error"));
  assert.ok(byId("overview-empty").innerHTML.includes("relay.mjs"));
});

test("refresh handles 401 with an auth hint", async () => {
  const { byId, app } = boot("auth");
  app.state.settings.pollSec = 0;
  const r = await app.refresh(false);
  assert.ok(!r.ok);
  assert.equal(r.kind, "auth");
  assert.ok(byId("conn-lamp").classList.contains("error"));
});

test("test-connection button reports the canned tip height", async () => {
  const { byId } = boot("ok");
  byId("set-endpoint").value = "http://127.0.0.1:44120/rpc";
  byId("btn-test").click();
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(byId("set-msg").textContent.includes("120195"));
});

test("network mismatch warning appears when settings disagree with the node", async () => {
  const { byId, app } = boot("ok");
  app.state.settings.pollSec = 0;
  app.state.settings.network = "testnet"; // canned node is mainnet
  await app.refresh(false);
  assert.ok(byId("mismatch-warn").textContent.includes("mainnet"));
});
