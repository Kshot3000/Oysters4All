// Pearl Testnet Faucet — DOM wiring checks (pure node, no jsdom).
// Run: node --test tests/dom.test.mjs
// Every $('id') lookup in app.js must resolve to an element in
// index.html, cache keys stay pinned, and the testnet-only contract
// (no mainnet option) holds in the markup.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(dir, "..", "index.html"), "utf8");
const js = readFileSync(path.join(dir, "..", "app.js"), "utf8");

test('all $(\'id\') lookups resolve to an element in index.html', () => {
  const ids = new Set();
  for (const m of js.matchAll(/\$\('([A-Za-z0-9_]+)'\)/g)) ids.add(m[1]);
  assert.ok(ids.size >= 20, "expected the full wiring set, got " + ids.size);
  const missing = [...ids].filter((id) => !new RegExp(`id="${id}"`).test(html));
  assert.deepEqual(missing, [], "missing ids: " + missing.join(", "));
});

test("cache-buster keys present and pinned on css + js", () => {
  assert.ok(html.includes('href="styles.css?v=6"'), "styles.css ?v= pin moved — bump it deliberately, never silently");
  assert.ok(html.includes('src="app.js?v=2"'), "app.js ?v= pin moved — bump it deliberately, never silently");
});

test("footer + donate section carry the PRL address and @kshot9000", () => {
  const addr = "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d";
  assert.ok((html.match(new RegExp(addr, "g")) || []).length >= 2, "address in donate section AND footer");
  assert.ok(html.includes("https://x.com/kshot9000"));
});

test("network select is testnet-only (no mainnet option)", () => {
  const sel = html.match(/<select id="networkSel"[\s\S]*?<\/select>/);
  assert.ok(sel, "networkSel select present");
  const values = [...sel[0].matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(values, ["testnet", "testnet2"]);
});

test("honest-limits copy present: mainnet rejection + self-run backend", () => {
  assert.ok(html.includes("rejected"), "page states mainnet addresses are rejected");
  assert.ok(html.includes("faucet-backend"), "page links the reference backend");
});

test("backend hint escapes backend URL and backend-supplied network name", () => {
  // Regression pin (2026-10-04 fleet XSS audit): refreshStatus renders the
  // free-text backend URL and the backend JSON's network field into
  // backendHint.innerHTML — both must go through esc().
  assert.match(js, /function esc\(s\) \{\s*return String\(s \?\? ''\)\s*\.replace\(\/&\/g, '&amp;'\)/);
  assert.match(js, /esc\(base\) \+ '<\/code> on ' \+ esc\(st\.network \|\| 'testnet'\)/);
  assert.doesNotMatch(js, /\+ \(st\.network \|\| 'testnet'\) \+ '\.'/);
});
