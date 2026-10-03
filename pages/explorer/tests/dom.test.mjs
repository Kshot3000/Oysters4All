// Pearl Block Explorer — DOM wiring + docs-honesty checks (pure node).
// Run: node --test tests/dom.test.mjs
// Every $('id') lookup in app.js must resolve in index.html, cache keys stay
// pinned, attribution holds, and — the bug this suite was born from — the
// README and the in-page Settings note must name exactly the RPC methods
// app.js actually calls (they previously claimed getblockchaininfo and
// getrawtransaction, which the app has never called, and a btcd port).
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
  for (const mm of js.matchAll(/getElementById\('([A-Za-z0-9_]+)'\)/g)) ids.add(mm[1]);
  assert.ok(ids.size >= 25, "expected the full wiring set, got " + ids.size);
  const missing = [...ids].filter((id) => !new RegExp(`id="${id}"`).test(html));
  assert.deepEqual(missing, [], "missing ids: " + missing.join(", "));
});

test("cache-buster keys present and pinned on css + js", () => {
  assert.ok(html.includes('href="styles.css?v=5"'), "styles.css ?v= pin moved — bump it deliberately, never silently");
  assert.ok(html.includes('src="app.js?v=4"'), "app.js ?v= pin moved — bump it deliberately, never silently");
});

test("attribution: PRL address and @kshot9000 present", () => {
  const addr = "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d";
  assert.ok(html.includes(addr), "donation address present character-for-character");
  assert.ok(html.includes("https://x.com/kshot9000"), "@kshot9000 linked");
  assert.ok(readme.includes(addr), "README carries the same address");
});

test("app.js calls exactly the five pearld methods the docs claim", () => {
  const called = [...new Set([...js.matchAll(/rpc\('([a-z]+)'/g)].map((x) => x[1]))].sort();
  assert.deepEqual(called, [
    "getbestblockhash", "getblock", "getblockcount", "getblockhash", "getinfo"
  ]);
  for (const method of called) {
    assert.ok(readme.includes("`" + method + "`"), "README names " + method);
    assert.ok(html.includes("<code>" + method + "</code>") || html.includes(method),
      "Settings note names " + method);
  }
});

test("docs never claim methods the app does not call (getblockchaininfo / getrawtransaction)", () => {
  for (const [name, text] of [["README", readme], ["index.html", html]]) {
    assert.ok(!text.includes("getblockchaininfo"), name + " must not claim getblockchaininfo");
    assert.ok(!text.includes("getrawtransaction"), name + " must not claim getrawtransaction");
  }
});

test("docs give Pearl's real RPC port (44107), not btcd's 8332", () => {
  assert.ok(readme.includes("44107"), "README names the pearld RPC port");
  assert.ok(!readme.includes("8332"), "README must not carry the btcd default port");
  assert.ok(html.includes("http://127.0.0.1:44107"), "endpoint placeholder uses 44107");
});

test("lookup splits height vs hash through the tested isHeightQuery helper", () => {
  assert.ok(js.includes("isHeightQuery(q)"), "lookup uses the exported helper");
  assert.ok(js.includes("rpc('getblockhash', [parseInt(q, 10)])"), "heights resolve via getblockhash");
  assert.ok(js.includes("rpc('getblock', [hash, 1])"), "blocks fetch at verbosity 1");
});
