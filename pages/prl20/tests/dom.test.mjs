// Pearlscriptions / PRL-20 Explorer — DOM wiring + docs-honesty checks (pure node).
// Run: node --test tests/dom.test.mjs
// Every $("id") lookup in app.js must resolve in index.html, cache keys stay
// pinned, attribution holds, the README must name exactly the indexer
// endpoints app.js calls (the status trio /health + /indexer/status +
// /network was previously undocumented), and the two rendering bugs this
// suite was born from stay fixed: api() building its URL outside the try
// (a malformed stored base threw instead of reporting "unreachable") and
// the inscription Location row printing "undefined:?" for a txid-less
// location.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(dir, "..", "index.html"), "utf8");
const js = readFileSync(path.join(dir, "..", "app.js"), "utf8");
const readme = readFileSync(path.join(dir, "..", "README.md"), "utf8");

test("all id lookups in app.js resolve to an element in index.html", () => {
  const ids = new Set();
  for (const mm of js.matchAll(/\$\("([A-Za-z0-9-]+)"\)/g)) ids.add(mm[1]);
  assert.ok(ids.size >= 26, "expected the full wiring set, got " + ids.size);
  const missing = [...ids].filter((id) => !new RegExp(`id="${id}"`).test(html));
  assert.deepEqual(missing, [], "missing ids: " + missing.join(", "));
});

test("tab buttons map to tab panels (dynamic panel-<tab> lookups)", () => {
  const tabs = [...html.matchAll(/data-tab="([a-z]+)"/g)].map((x) => x[1]);
  assert.deepEqual([...tabs].sort(), ["address", "inscriptions", "operations", "tokens"]);
  for (const t of tabs) assert.ok(html.includes(`id="panel-${t}"`), "panel-" + t + " exists");
  assert.ok(js.includes('getElementById') && js.includes('"panel-" + btn.dataset.tab') || js.includes('$("panel-" + btn.dataset.tab)'),
    "tab wiring builds panel ids from data-tab");
});

test("cache-buster keys present and pinned on css + js", () => {
  assert.ok(html.includes('href="styles.css?v=4"'), "styles.css ?v= pin moved — bump it deliberately, never silently");
  assert.ok(html.includes('src="app.js?v=4"'), "app.js ?v= pin moved — bump it deliberately, never silently");
});

test("attribution: PRL address and @kshot9000 present", () => {
  const addr = "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d";
  assert.ok(html.includes(addr), "donation address present character-for-character");
  assert.ok(html.includes("https://x.com/kshot9000"), "@kshot9000 linked");
  assert.ok(readme.includes(addr), "README carries the same address");
});

test("app.js calls exactly the indexer endpoints the README documents", () => {
  const calls = [
    'api("/health")',
    'api("/indexer/status")',
    'api("/network")',
    'api("/tokens")',
    'api("/tokens/" + encodeURIComponent(t))',
    'api("/inscriptions", { order: "desc", limit: 24 })',
    'api("/inscriptions/" + encodeURIComponent(id))',
    'api("/inscriptions/" + encodeURIComponent(id) + "/location")',
    'api("/operations", { limit: 25 })',
    'api("/addresses/" + enc + "/balances")',
    'api("/addresses/" + enc + "/transfer-lots")',
    'api("/addresses/" + enc + "/utxos")',
    'api("/addresses/" + enc + "/inscriptions")'
  ];
  for (const c of calls) assert.ok(js.includes(c), "app.js calls " + c);
  const total = [...js.matchAll(/(?<![\w.])api\("/g)].length;
  assert.equal(total, calls.length, "no undocumented api() call sites");
  for (const route of ["/health", "/indexer/status", "/network", "/tokens", "/inscriptions", "/operations", "/addresses/"])
    assert.ok(readme.includes("`" + route) || readme.includes("`" + route.replace(/\/$/, "")) || readme.includes(route),
      "README names " + route);
  for (const suffix of ["/balances", "/transfer-lots", "/utxos", "/inscriptions", "/location"])
    assert.ok(readme.includes(suffix), "README names address/location suffix " + suffix);
});

test("the dashboard is GET-only: no request method is ever set", () => {
  assert.ok(!/method\s*:/.test(js), "fetch options set no method (defaults to GET)");
  assert.ok(!js.includes('"POST"') && !js.includes("'POST'"), "no POST anywhere");
  assert.ok(js.includes('headers: { Accept: "application/json" }'), "api() sends only the Accept header");
});

test("api() builds its URL inside the try (malformed base -> ok:false, not a throw)", () => {
  assert.ok(js.includes("fetch(buildUrl(base, path, query)"), "api() fetches via the tested buildUrl helper");
  const apiFn = js.slice(js.indexOf("async function api("), js.indexOf("function setConn"));
  assert.ok(apiFn.indexOf("try {") < apiFn.indexOf("buildUrl(base"), "buildUrl is called inside the try block");
  assert.ok(!apiFn.includes("new URL("), "api() itself no longer constructs a URL outside the try");
});

test("inscription detail guards stay in place (locText + unified content length)", () => {
  assert.ok(js.includes("function locText(l)"), "location text goes through the tested locText helper");
  assert.ok(js.includes('if (l.txid)'), "locText only builds txid:vout when a txid exists");
  assert.ok(!js.includes("esc(l.outpoint ||"), "the old unguarded location expression is gone");
  assert.ok(js.includes("const clen = d.contentLength ?? d.content_length"), "content size uses one unified length");
  assert.ok(js.includes('fmtNum(clen) + (clen ? " bytes" : "")'), "the bytes suffix follows the same unified length");
});

test("storage key in code matches the README (prl20.api, localStorage only)", () => {
  assert.ok(js.includes('const LS_KEY = "prl20.api"'), "LS_KEY is prl20.api");
  assert.ok(readme.includes("prl20.api"), "README names the storage key");
});
