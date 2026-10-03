// Pearl Foundry dashboard — DOM wiring + docs-honesty checks (pure node).
// Run: node --test tests/dom.test.mjs
// Every $('id') lookup in app.js must resolve in index.html, the app.js
// cache key stays pinned, attribution holds, the dashboard stays a single
// external script (no inline logic to drift from the tested module), and
// the README must name exactly the four API endpoints app.js actually
// calls — the docs-drift class the explorer/prl20 suites were born from.
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
  for (const mm of js.matchAll(/\$\('([A-Za-z0-9_]+)'\)/g)) ids.add(mm[1]);
  for (const mm of js.matchAll(/\$\("([A-Za-z0-9_]+)"\)/g)) ids.add(mm[1]);
  for (const mm of js.matchAll(/getElementById\('([A-Za-z0-9_]+)'\)/g)) ids.add(mm[1]);
  for (const mm of js.matchAll(/getElementById\("([A-Za-z0-9_]+)"\)/g)) ids.add(mm[1]);
  assert.ok(ids.size >= 13, "expected the full wiring set, got " + ids.size);
  const missing = [...ids].filter((id) => !new RegExp(`id="${id}"`).test(html));
  assert.deepEqual(missing, [], "missing ids: " + missing.join(", "));
});

test("cache-buster key present and pinned on app.js; no inline dashboard script remains", () => {
  assert.ok(html.includes('src="app.js?v=1"'), "app.js ?v= pin moved — bump it deliberately, never silently");
  assert.ok(!html.includes("pearlFoundryApi") || js.includes("pearlFoundryApi"),
    "storage key lives in the tested module");
  assert.ok(!/<script>\s*"use strict";/.test(html), "dashboard logic must not be inline in index.html");
});

test("attribution: PRL address and @kshot9000 present", () => {
  const addr = "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d";
  assert.ok(html.includes(addr), "donation address present character-for-character");
  assert.ok(html.includes("https://x.com/kshot9000"), "@kshot9000 linked");
  assert.ok(readme.includes(addr), "README carries the same address");
});

test("app.js calls exactly the four pool API endpoints the docs claim", () => {
  const called = [...new Set([...js.matchAll(/get\("(\/api\/[a-z]+)"\)/g)].map((x) => x[1]))].sort();
  assert.deepEqual(called, ["/api/balances", "/api/config", "/api/miners", "/api/stats"]);
  for (const ep of called) {
    assert.ok(readme.includes("`" + ep + "`"), "README names " + ep);
  }
});

test("all dashboard fetches are GET-only reads (the page never writes pool state)", () => {
  assert.ok(!/method:\s*["'](POST|PUT|PATCH|DELETE)["']/.test(js), "no mutating fetch in app.js");
  assert.ok(js.includes('cache: "no-store"'), "reads bypass the HTTP cache");
});

test("backend strings pass through esc() in every section builder (XSS guard)", () => {
  assert.ok(js.includes('title="${esc(m.wallet)}"'), "miner wallet attribute escaped");
  assert.ok(js.includes('title="${esc(b.wallet)}"'), "balance wallet attribute escaped");
  assert.ok(js.includes("esc(m.worker"), "worker escaped");
  assert.ok(js.includes("esc(m.dialect"), "dialect escaped");
  assert.ok(js.includes("esc(pool.templateSource"), "templateSource escaped");
  assert.ok(js.includes("esc(pool.network"), "network escaped");
});

test("persisted backend uses the pinned localStorage key and the demo fallback is labelled", () => {
  assert.ok(js.includes('"pearlFoundryApi"'), "storage key pinned");
  assert.ok(html.includes("DEMO MODE"), "demo banner exists in the page");
  assert.ok(js.includes('DEMO — backend unreachable'), "unreachable state is labelled demo");
  assert.ok(readme.includes("Demo mode is loud"), "README documents the honest demo limit");
});
