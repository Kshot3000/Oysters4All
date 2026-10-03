// Pearlscriptions / PRL-20 Explorer — pure-helper tests.
// Run: node --test tests/prl20.test.mjs
//
// app.js exports its pure helpers for node when no DOM is present (its UI
// wiring is guarded by `typeof document`). These pin the defensive
// rendering the whole dashboard depends on: every value the indexer API
// returns is untrusted display data, so escaping, truncation, number
// formatting, URL building, and the card builders must behave exactly
// as the loaders assume — including for missing and hostile fields.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const m = require("../app.js");

test("exports the pure helpers, card builders, and the storage key", () => {
  for (const k of ["esc", "short", "fmtNum", "buildUrl", "locText", "emptyBox", "stat", "tokenCard", "inscCard"])
    assert.equal(typeof m[k], "function", k);
  assert.equal(m.LS_KEY, "prl20.api");
});

test("esc escapes all five markup characters", () => {
  assert.equal(
    m.esc(`<a href="x">&'</a>`),
    "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;"
  );
});

test("esc escapes & first and coerces defensively", () => {
  assert.equal(m.esc("&lt;"), "&amp;lt;"); // no double-escape hole
  assert.equal(m.esc("plain 123"), "plain 123");
  assert.equal(m.esc(42), "42");
  assert.equal(m.esc(null), "");
  assert.equal(m.esc(undefined), "");
});

test("short leaves strings at or under 2n+3 untouched", () => {
  assert.equal(m.short("abc"), "abc");
  assert.equal(m.short("x".repeat(35)), "x".repeat(35)); // default n=16: 2*16+3
  assert.equal(m.short("abcde", 1), "abcde"); // exactly 2*1+3 stays whole
});

test("short truncates long strings with a single ellipsis", () => {
  const long = "abcdefghijklmnopqrstuvwxyz0123456789"; // 36 chars > 35
  assert.equal(m.short(long), "abcdefghijklmnop…uvwxyz0123456789");
  assert.equal(m.short("abcdefghij", 3), "abc…hij");
  assert.equal(m.short(null), "");
  assert.equal(m.short(undefined), "");
});

test("fmtNum dashes null, undefined, and empty string", () => {
  for (const v of [null, undefined, ""]) assert.equal(m.fmtNum(v), "—", String(v));
});

test("fmtNum formats integer strings exactly via BigInt (no float rounding)", () => {
  assert.equal(m.fmtNum("0"), "0");
  assert.equal(m.fmtNum("230549524009"), "230,549,524,009");
  // beyond Number.MAX_SAFE_INTEGER: a float would print 9,007,199,254,740,992
  assert.equal(m.fmtNum("9007199254740993"), "9,007,199,254,740,993");
  assert.equal(m.fmtNum(1234567), "1,234,567");
});

test("fmtNum formats decimals and negative integers via Number", () => {
  assert.equal(m.fmtNum("12.5"), "12.5");
  assert.equal(m.fmtNum("-1234"), "-1,234");
  assert.equal(m.fmtNum(0), "0");
});

test("fmtNum passes non-numeric strings through escaped, never raw", () => {
  assert.equal(m.fmtNum("abc"), "abc");
  assert.equal(m.fmtNum("<b>1</b>"), "&lt;b&gt;1&lt;/b&gt;");
});

test("buildUrl joins base + path and sets only non-empty query values", () => {
  assert.equal(
    m.buildUrl("https://idx.example.com", "/inscriptions", { order: "desc", limit: 24 }),
    "https://idx.example.com/inscriptions?order=desc&limit=24"
  );
  assert.equal(
    m.buildUrl("https://idx.example.com/api", "/tokens", { a: "", b: null, c: undefined, d: 0 }),
    "https://idx.example.com/api/tokens?d=0"
  );
  assert.equal(m.buildUrl("https://idx.example.com", "/health"), "https://idx.example.com/health");
});

test("buildUrl throws on a malformed base (api() converts that to ok:false)", () => {
  assert.throws(() => m.buildUrl("not a url", "/tokens"), TypeError);
  assert.throws(() => m.buildUrl("", "/tokens"), TypeError);
});

test("locText never renders 'undefined' for a partial location", () => {
  assert.equal(m.locText(null), null);
  assert.equal(m.locText(undefined), null);
  assert.equal(m.locText({}), null);
  assert.equal(m.locText({ address: "prl1x" }), null); // owner-only shape: no location
  assert.equal(m.locText({ txid: "ab12" }), "ab12:?");
  assert.equal(m.locText({ txid: "ab12", vout: 0 }), "ab12:0");
  assert.equal(m.locText({ txid: "ab12", vout: 3 }), "ab12:3");
  assert.equal(m.locText({ outpoint: "ab12:1", txid: "zz", vout: 9 }), "ab12:1"); // outpoint wins
});

test("emptyBox and stat render their fleet shapes", () => {
  assert.equal(m.emptyBox("Nothing here."), '<div class="empty">Nothing here.</div>');
  // stat escapes the label; the value is caller-built HTML/formatted numbers
  assert.equal(
    m.stat("<chain>", "<b>pearl</b>"),
    '<div class="stat"><div class="k">&lt;chain&gt;</div><div class="v "><b>pearl</b></div></div>'
  );
  assert.equal(
    m.stat("sync state", "synced", "ok"),
    '<div class="stat"><div class="k">sync state</div><div class="v ok">synced</div></div>'
  );
});

test("tokenCard renders formatted fields and the mintLimit -> lim fallback", () => {
  const html = m.tokenCard({
    ticker: "prls", maxSupply: "2100000000", mintedSupply: 500, holderCount: 7, lim: "1000"
  });
  assert.ok(html.includes('data-ticker="prls"'));
  assert.ok(html.includes("<span>Max supply</span><b>2,100,000,000</b>"));
  assert.ok(html.includes("<span>Minted</span><b>500</b>"));
  assert.ok(html.includes("<span>Holders</span><b>7</b>"));
  assert.ok(html.includes("<span>Mint limit</span><b>1,000</b>"));
  assert.ok(!html.includes("progress"), "no progress bar when mintProgress is not a number");
});

test("tokenCard dashes missing fields and defaults the ticker", () => {
  const html = m.tokenCard({});
  assert.ok(html.includes('data-ticker="?"'));
  assert.ok(html.includes("<span>Max supply</span><b>—</b>"));
  assert.ok(html.includes("<span>Holders</span><b>—</b>"));
});

test("tokenCard clamps the progress bar width but labels the raw percent", () => {
  const over = m.tokenCard({ ticker: "x", mintProgress: 150 });
  assert.ok(over.includes('style="width:100%"'));
  assert.ok(over.includes("Minted 150.00%"));
  const under = m.tokenCard({ ticker: "x", mintProgress: -5 });
  assert.ok(under.includes('style="width:0%"'));
  const mid = m.tokenCard({ ticker: "x", mintProgress: 33.333 });
  assert.ok(mid.includes("Minted 33.33%"));
});

test("tokenCard escapes a hostile ticker in attribute and text", () => {
  const html = m.tokenCard({ ticker: '"><script>alert(1)</script>' });
  assert.ok(!html.includes("<script>"), "no raw script tag in card HTML");
  assert.ok(html.includes("&quot;&gt;&lt;script&gt;"));
});

test("inscCard renders number, type, truncated id/owner, and the block row", () => {
  const html = m.inscCard({
    inscriptionNumber: 42,
    inscriptionId: "a".repeat(40),
    contentType: "text/plain",
    ownerAddress: "prl1" + "b".repeat(40),
    blockHeight: 120042
  });
  assert.ok(html.includes('<div class="tick">#42</div>'));
  assert.ok(html.includes("<span>Type</span><b>text/plain</b>"));
  assert.ok(html.includes("a".repeat(10) + "…" + "a".repeat(10)), "id truncated at n=10");
  assert.ok(html.includes("<span>Block</span><b>120,042</b>"));
});

test("inscCard dashes missing fields and omits the block row without a height", () => {
  const html = m.inscCard({});
  assert.ok(html.includes('<div class="tick">—</div>'));
  assert.ok(html.includes("<span>Type</span><b>—</b>"));
  assert.ok(html.includes("<span>Owner</span><b class=\"mono\">—</b>"));
  assert.ok(html.includes('data-insc=""'));
  assert.ok(!html.includes("<span>Block</span>"));
});

test("inscCard accepts the snake_case / alt field names the API also uses", () => {
  const html = m.inscCard({ number: 7, id: "xyz", content_type: "image/png", currentAddress: "prl1abc" });
  assert.ok(html.includes('<div class="tick">#7</div>'));
  assert.ok(html.includes("<span>Type</span><b>image/png</b>"));
  assert.ok(html.includes('data-insc="xyz"'));
});
