// Pearl Block Explorer — pure-helper tests.
// Run: node --test tests/explorer.test.mjs
//
// app.js exports its pure helpers for node when no DOM is present (its UI
// wiring is guarded by `typeof document`). These pin the formatting and
// request-shaping behaviour the whole UI depends on: block times, stat
// numbers, HTML escaping of node-supplied strings, the height-vs-hash
// lookup split, and the exact JSON-RPC 1.0 envelope sent to pearld.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const m = require("../app.js");

test("exports the pure helpers and the storage key", () => {
  for (const k of ["fmtTime", "fmtNum", "escapeHtml", "isHeightQuery", "rpcBody"])
    assert.equal(typeof m[k], "function", k);
  assert.equal(m.LS_KEY, "pearl-explorer-rpc");
});

test("fmtTime renders unix seconds as UTC text", () => {
  assert.equal(m.fmtTime(0), "1970-01-01 00:00:00.000 UTC");
  assert.equal(m.fmtTime(1231006505), "2009-01-03 18:15:05.000 UTC");
  assert.equal(m.fmtTime(1767225600), "2026-01-01 00:00:00.000 UTC");
});

test("fmtTime dashes anything that is not a number (defensive render)", () => {
  for (const v of [undefined, null, "1231006505", "x", {}, []])
    assert.equal(m.fmtTime(v), "—", String(v));
});

test("fmtNum groups thousands en-US and keeps zero", () => {
  assert.equal(m.fmtNum(0), "0");
  assert.equal(m.fmtNum(42), "42");
  assert.equal(m.fmtNum(1234567), "1,234,567");
  assert.equal(m.fmtNum(2100000000), "2,100,000,000");
});

test("fmtNum dashes non-numbers instead of printing garbage", () => {
  for (const v of [undefined, null, "42", {}, []])
    assert.equal(m.fmtNum(v), "—", String(v));
});

test("escapeHtml escapes all five markup characters", () => {
  assert.equal(
    m.escapeHtml(`<a href="x">&'</a>`),
    "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;"
  );
});

test("escapeHtml escapes & first (no double-escaping of its own output)", () => {
  assert.equal(m.escapeHtml("&lt;"), "&amp;lt;");
  assert.equal(m.escapeHtml("plain text 123"), "plain text 123");
  assert.equal(m.escapeHtml(42), "42"); // coerced, never throws
});

test("isHeightQuery: digits only are heights, everything else is a hash", () => {
  assert.equal(m.isHeightQuery("0"), true);
  assert.equal(m.isHeightQuery("12345"), true);
  assert.equal(m.isHeightQuery("000123"), true);
  const hash = "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f";
  assert.equal(m.isHeightQuery(hash), false);
  for (const q of ["", " 12", "12 ", "12a", "0x12", "-1", "1.5"])
    assert.equal(m.isHeightQuery(q), false, JSON.stringify(q));
});

test("rpcBody builds the JSON-RPC 1.0 envelope pearld expects", () => {
  assert.deepEqual(m.rpcBody("getblockcount"), {
    jsonrpc: "1.0", id: "getblockcount", method: "getblockcount", params: []
  });
  assert.deepEqual(m.rpcBody("getblock", ["abc123", 1]), {
    jsonrpc: "1.0", id: "getblock", method: "getblock", params: ["abc123", 1]
  });
  assert.deepEqual(m.rpcBody("getblockhash", [650226]).params, [650226]);
  // id mirrors the method — refreshStatus/lookup correlate replies by it
  assert.equal(m.rpcBody("getinfo").id, "getinfo");
});
