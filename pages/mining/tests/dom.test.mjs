// Pearl Mining Calculator — DOM wiring checks (pure node, no jsdom).
// Run: node --test tests/dom.test.mjs
// Every $('id') / getElementById('id') lookup in app.js must resolve to an
// element in index.html, cache keys stay pinned, and the attribution +
// honest framing hold in the markup.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(dir, "..", "index.html"), "utf8");
const js = readFileSync(path.join(dir, "..", "app.js"), "utf8");

test("all id lookups in app.js resolve to an element in index.html", () => {
  const ids = new Set();
  for (const mm of js.matchAll(/\$\('([A-Za-z0-9_]+)'\)/g)) ids.add(mm[1]);
  for (const mm of js.matchAll(/getElementById\('([A-Za-z0-9_]+)'\)/g)) ids.add(mm[1]);
  // array-driven lookups: ['inHeight', ...].forEach(id => $(id) ...)
  for (const mm of js.matchAll(/'((?:in|out|rpc)[A-Z][A-Za-z0-9]*)'/g)) ids.add(mm[1]);
  assert.ok(ids.size >= 30, "expected the full wiring set, got " + ids.size);
  const missing = [...ids].filter((id) => !new RegExp(`id="${id}"`).test(html));
  assert.deepEqual(missing, [], "missing ids: " + missing.join(", "));
});

test("cache-buster keys present and pinned on css + js", () => {
  assert.ok(html.includes('href="styles.css?v=6"'), "styles.css ?v= pin moved — bump it deliberately, never silently");
  assert.ok(html.includes('src="app.js?v=3"'), "app.js ?v= pin moved — bump it deliberately, never silently");
});

test("attribution: PRL address and @kshot9000 present", () => {
  const addr = "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d";
  assert.ok(html.includes(addr), "donation address present character-for-character");
  assert.ok(html.includes("https://x.com/kshot9000"), "@kshot9000 linked");
});

test("chart tabs offer exactly subsidy + supply modes, matching app.js", () => {
  const modes = [...html.matchAll(/data-chart="([^"]+)"/g)].map((x) => x[1]);
  assert.deepEqual(modes.sort(), ["subsidy", "supply"]);
  assert.ok(js.includes("chartMode === 'subsidy'"), "app.js renders the subsidy mode");
});

test("node panel speaks pearld JSON-RPC (getblockcount + getmininginfo)", () => {
  assert.ok(js.includes("rpc('getblockcount')"), "height comes from getblockcount");
  assert.ok(js.includes("rpc('getmininginfo')"), "hashrate/difficulty from getmininginfo");
  assert.ok(js.includes("networkhashps"), "reads networkhashps from getmininginfo");
});

test("milestone heights in app.js match the upstream emission milestones", () => {
  for (const h of ["650226", "1300452", "1950678", "3251130"]) {
    assert.ok(new RegExp(`h: ${h}\\b`).test(js), `milestone ${h} present`);
  }
  assert.ok(js.includes("Salted-seed hard fork"), "h=99,000 fork milestone labelled");
});
