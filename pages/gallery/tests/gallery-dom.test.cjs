/* Pearl Gallery — jsdom smoke test: page boots, connects to a stub indexer API,
 * wall renders frames, filter applies, detail modal opens and renders an image.
 * Run from pages/gallery/: node tests/gallery-dom.test.cjs
 */
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const http = require("node:http");

const HERE = __dirname;
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_LEN = Buffer.from(PNG, "base64").length;

function stubServer() {
  const inscriptions = [
    { inscriptionId: "aaa1i0", inscriptionNumber: 0, contentType: "image/png", byteLength: PNG_LEN,
      txid: "t".repeat(64), blockHeight: 120000, protocolMarker: "", currentOwnerAddress: "prl1powner1" },
    { inscriptionId: "bbb2i0", inscriptionNumber: 1, contentType: "text/plain", byteLength: 11,
      txid: "u".repeat(64), blockHeight: 120001, protocolMarker: "prl-20", currentOwnerAddress: "prl1powner2" },
  ];
  return http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    res.setHeader("content-type", "application/json");
    res.setHeader("access-control-allow-origin", "*");
    const json = (o, code = 200) => { res.writeHead(code); res.end(JSON.stringify(o)); };
    if (u.pathname === "/health") return json({ ok: true, service: "prl20-indexer-api", chain: "pearl-mainnet", forkEra: "moe-v2" });
    if (u.pathname === "/indexer/status") return json({ chain: "pearl-mainnet", indexedHeight: 120002, synced: true, summary: { inscriptions: 2 } });
    if (u.pathname === "/inscriptions") return json({ inscriptions, total: 2, page: 1, pageCount: 1 });
    const content = u.pathname.match(/^\/inscriptions\/([^/]+)\/content$/);
    if (content) {
      const id = decodeURIComponent(content[1]);
      if (id === "aaa1i0") return json({ id, inscriptionNumber: 0, contentType: "image/png", byteLength: PNG_LEN, encoding: "base64", bodyBase64: PNG, bodyHex: null, bodyText: null });
      if (id === "bbb2i0") return json({ id, inscriptionNumber: 1, contentType: "text/plain", byteLength: 11, encoding: "base64", bodyBase64: Buffer.from("hello world").toString("base64"), bodyHex: null, bodyText: "hello world" });
      return json({ ok: false, error: "INSCRIPTION_NOT_FOUND" }, 404);
    }
    const detail = u.pathname.match(/^\/inscriptions\/([^/]+)$/);
    if (detail) {
      const id = decodeURIComponent(detail[1]);
      const hit = inscriptions.find((i) => i.inscriptionId === id || String(i.inscriptionNumber) === id);
      return hit ? json(hit) : json({ ok: false, error: "INSCRIPTION_NOT_FOUND" }, 404);
    }
    const loc = u.pathname.match(/^\/inscriptions\/([^/]+)\/location$/);
    if (loc) {
      const id = decodeURIComponent(loc[1]);
      const hit = inscriptions.find((i) => i.inscriptionId === id);
      return hit ? json({ id, inscriptionNumber: hit.inscriptionNumber, currentOwnerAddress: hit.currentOwnerAddress, status: "located" }) : json({ ok: false, error: "INSCRIPTION_NOT_FOUND" }, 404);
    }
    const addr = u.pathname.match(/^\/addresses\/([^/]+)\/inscriptions$/);
    if (addr) return json({ inscriptions, total: 2, page: 1, pageCount: 1 });
    return json({ ok: false, error: "NOT_FOUND" }, 404);
  });
}

test("gallery boots, connects, renders wall, filters, opens detail modal", async () => {
  let JSDOM;
  try { ({ JSDOM } = require("jsdom")); } catch { console.log("SKIP: jsdom not installed"); return; }
  const srv = stubServer();
  await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  let window;
  try {
  const html = readFileSync(join(HERE, "..", "index.html"), "utf8");
  const core = readFileSync(join(HERE, "..", "js", "gallery-core.js"), "utf8");
  const app = readFileSync(join(HERE, "..", "app.js"), "utf8");
  const errors = [];

  const dom = new JSDOM(html, {
    url: "https://kshot3000.github.io/Pearl-Muse-24-7-Ai-builder/pages/gallery/",
    runScripts: "outside-only",
  });
  window = dom.window;
  window.localStorage.setItem("gallery.api", base);
  window.fetch = (...args) => fetch(...args); // jsdom has no fetch; use node's
  // IntersectionObserver stub: immediately mark all as intersecting
  window.IntersectionObserver = class {
    constructor(cb) { this.cb = cb; }
    observe(el) { this.cb([{ isIntersecting: true, target: el }], this); }
    unobserve() {}
    disconnect() {}
  };
  // dialog stub
  if (window.HTMLDialogElement) {
    window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  }
  window.addEventListener("error", (e) => errors.push(String(e.message || e.error)));

  window.eval(core);
  assert.ok(window.__galleryCore, "gallery-core exposes window.__galleryCore");
  window.eval(app); // boot runs via readyState/DOMContentLoaded

  // wait for wall to load
  const waitFor = async (fn, label) => {
    for (let i = 0; i < 100; i++) {
      if (fn()) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("timeout waiting for " + label);
  };
  await waitFor(() => window.document.querySelectorAll("#wall .frame").length === 2, "wall cards");
  assert.match(window.document.getElementById("conn").textContent, /live/);
  const frames = window.document.querySelectorAll("#wall .frame");
  assert.equal(frames[0].querySelector(".frame-num").textContent, "#0");
  // thumbnails preload: at least one image frame rendered
  await waitFor(() => frames[0].querySelector(".thumb img") !== null, "image thumbnail");
  const img = frames[0].querySelector(".thumb img");
  assert.ok(img.getAttribute("src").startsWith("data:image/png;base64,"));
  // filter: images only hides the text card
  window.document.querySelector('.fchip[data-f="images"]').click();
  const visible = [...window.document.querySelectorAll("#wall .frame")].filter((c) => c.style.display !== "none");
  assert.equal(visible.length, 1);
  // detail modal
  frames[0].click();
  await waitFor(() => window.document.querySelector("#detail .full-img") !== null, "modal image");
  assert.ok(window.document.querySelector("#detail .kv"), "modal metadata table present");
  assert.match(window.document.querySelector("#detail").textContent, /prl1powner1/);
  // text inscription detail renders escaped text
  window.document.querySelector('.fchip[data-f="all"]').click();
  frames[1].click();
  await waitFor(() => window.document.querySelector("#detail .code-view") !== null, "modal text");
  assert.match(window.document.querySelector("#detail .code-view").textContent, /hello world/);
  // footer carries donation address + x handle
  assert.match(window.document.body.textContent, /prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d/);
  assert.match(window.document.body.textContent, /kshot9000/);

  assert.deepEqual(errors, [], "no window errors: " + JSON.stringify(errors));
  } finally {
    srv.close();
    if (window) window.close();
  }
});

test("gallery renders honest unconfigured state", async () => {
  let JSDOM;
  try { ({ JSDOM } = require("jsdom")); } catch { console.log("SKIP: jsdom not installed"); return; }
  const html = readFileSync(join(HERE, "..", "index.html"), "utf8");
  const core = readFileSync(join(HERE, "..", "js", "gallery-core.js"), "utf8");
  const app = readFileSync(join(HERE, "..", "app.js"), "utf8");
  const dom = new JSDOM(html, { url: "https://kshot3000.github.io/x/", runScripts: "outside-only" });
  const { window } = dom;
  try {
  window.fetch = (...args) => fetch(...args);
  window.IntersectionObserver = class { constructor() {} observe() {} unobserve() {} disconnect() {} };
  window.eval(core); window.eval(app); // boot runs via readyState/DOMContentLoaded
  await new Promise((r) => setTimeout(r, 100));
  assert.match(window.document.getElementById("conn").textContent, /unconfigured/);
  assert.match(window.document.getElementById("wall").textContent, /Set the indexer API URL/);
  } finally { window.close(); }
});
