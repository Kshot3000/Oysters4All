// Pearl Foundry dashboard — pure-helper + section-builder tests.
// Run: node --test tests/pool.test.mjs
//
// app.js exports its pure helpers for node when no DOM is present (its UI
// wiring is guarded by `typeof document`). These pin the defensive
// rendering the dashboard depends on: every value the pool API returns is
// untrusted display data — wallet/worker strings come straight from miner
// logins — so escaping, truncation, time/hashrate formatting, grain-exact
// PRL conversion, API-base resolution, and the section builders must
// behave exactly as the renderers assume, including for missing and
// hostile fields. Two bugs motivated this suite: (1) NO value was escaped
// before innerHTML, so a backend reached via a crafted ?api= link could
// inject markup through a wallet/worker/dialect string; (2) round rewards
// were formatted with (Number(grains)/1e8).toFixed(4), which misprints
// grain counts past Number.MAX_SAFE_INTEGER.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const m = require("../app.js");

test("exports the pure helpers, section builders, DEMO data, and the storage key", () => {
  for (const k of ["esc", "fmtInt", "trunc", "timeAgo", "hashrate", "fmtPRL", "resolveApiBase",
                   "filterMiners", "statsHtml", "minersSection", "roundsHtml", "balancesHtml"])
    assert.equal(typeof m[k], "function", k);
  assert.equal(m.LS_KEY, "pearlFoundryApi");
  assert.ok(m.DEMO && Array.isArray(m.DEMO.miners) && Array.isArray(m.DEMO.balances));
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

test("fmtInt groups thousands and coerces missing values to 0", () => {
  assert.equal(m.fmtInt(120042), "120,042");
  assert.equal(m.fmtInt(0), "0");
  assert.equal(m.fmtInt(undefined), "0");
  assert.equal(m.fmtInt(null), "0");
  assert.equal(m.fmtInt("888888"), "888,888");
});

test("trunc leaves addresses of 18 chars or fewer untouched", () => {
  assert.equal(m.trunc("prl1demo…"), "prl1demo…");
  assert.equal(m.trunc("x".repeat(18)), "x".repeat(18));
  assert.equal(m.trunc(""), "—");
  assert.equal(m.trunc(null), "—");
  assert.equal(m.trunc(undefined), "—");
});

test("trunc shortens longer addresses to head + ellipsis + tail", () => {
  const a = "prl1demo0000000000000000000000000000000000000000"; // demo wallet, 46 chars
  assert.equal(m.trunc(a), "prl1demo00…000000");
  assert.equal(m.trunc("x".repeat(19)), "x".repeat(10) + "…" + "x".repeat(6));
});

const NOW = 1_700_000_000_000; // fixed clock (ms) for timeAgo

test("timeAgo dashes a miner that has never shared (lastShareAt 0 / missing)", () => {
  assert.equal(m.timeAgo(0, NOW), "—");
  assert.equal(m.timeAgo(undefined, NOW), "—");
  assert.equal(m.timeAgo(null, NOW), "—");
});

test("timeAgo formats seconds, minutes, and hours against the ms clock", () => {
  assert.equal(m.timeAgo(NOW - 8_000, NOW), "8s ago"); // the DEMO rig1 case
  assert.equal(m.timeAgo(NOW - 59_000, NOW), "59s ago");
  assert.equal(m.timeAgo(NOW - 60_000, NOW), "1m ago");
  assert.equal(m.timeAgo(NOW - 61_000, NOW), "1m ago"); // the DEMO solo1 case
  assert.equal(m.timeAgo(NOW - 3_599_000, NOW), "59m ago");
  assert.equal(m.timeAgo(NOW - 3_600_000, NOW), "1h ago");
  assert.equal(m.timeAgo(NOW - 49 * 3_600_000, NOW), "49h ago");
});

test("timeAgo clamps future timestamps to 0s ago instead of going negative", () => {
  assert.equal(m.timeAgo(NOW + 60_000, NOW), "0s ago");
});

test("hashrate dashes non-positive and missing rates", () => {
  for (const v of [0, -5, NaN, undefined, null]) assert.equal(m.hashrate(v), "—", String(v));
});

test("hashrate scales by 1000s and caps at GH/s", () => {
  assert.equal(m.hashrate(68), "68.00 H/s");
  assert.equal(m.hashrate(999), "999.00 H/s");
  assert.equal(m.hashrate(1000), "1.00 kH/s");
  assert.equal(m.hashrate(59259), "59.26 kH/s");   // DEMO rig1
  assert.equal(m.hashrate(139810), "139.81 kH/s"); // DEMO cmp1
  assert.equal(m.hashrate(2_500_000), "2.50 MH/s");
  assert.equal(m.hashrate(1_000_000_000), "1.00 GH/s");
  assert.equal(m.hashrate(1_000_000_000_000), "1000.00 GH/s"); // capped, never TH/s
});

test("fmtPRL matches the old float formatting for ordinary rewards", () => {
  assert.equal(m.fmtPRL("230549524009"), "2305.4952"); // DEMO round reward (grains)
  assert.equal(m.fmtPRL("2305495240"), "23.0550");     // DEMO round fee
  assert.equal(m.fmtPRL(230549524009), "2305.4952");   // numeric input coerced
  assert.equal(m.fmtPRL("0"), "0.0000");
  assert.equal(m.fmtPRL("100000000"), "1.0000");
  assert.equal(m.fmtPRL("-100000000"), "-1.0000");
});

test("fmtPRL rounds half-up at the 4th decimal, carrying into the whole part", () => {
  assert.equal(m.fmtPRL("4999"), "0.0000");
  assert.equal(m.fmtPRL("5000"), "0.0001");
  assert.equal(m.fmtPRL("99999999"), "1.0000"); // 0.99999999 PRL rounds up and carries
});

test("fmtPRL is grain-exact past Number.MAX_SAFE_INTEGER (the float bug)", () => {
  // Number("900719925474099300000000")/1e8 prints 9007199254740994.0000 — wrong.
  assert.equal(m.fmtPRL("900719925474099300000000"), "9007199254740993.0000");
  assert.equal(m.fmtPRL("123456789012345678"), "1234567890.1235");
});

test("fmtPRL dashes missing and non-integer grain counts instead of printing NaN", () => {
  for (const v of [null, undefined, "", "abc", "1.5", "12e3", {}])
    assert.equal(m.fmtPRL(v), "—", String(v));
});

test("resolveApiBase prefers ?api= over the stored backend over same-origin", () => {
  assert.equal(m.resolveApiBase("http://q:1", "http://s:2", "http://o:3"), "http://q:1");
  assert.equal(m.resolveApiBase(null, "http://s:2", "http://o:3"), "http://s:2");
  assert.equal(m.resolveApiBase("", "", "http://o:3"), "http://o:3");
  assert.equal(m.resolveApiBase(null, null, null), "");
});

test("resolveApiBase strips exactly one trailing slash", () => {
  assert.equal(m.resolveApiBase("http://x:8888/", null, null), "http://x:8888");
  assert.equal(m.resolveApiBase("http://x:8888//", null, null), "http://x:8888/");
  assert.equal(m.resolveApiBase("http://x:8888", null, null), "http://x:8888");
});

test("filterMiners returns everyone for an empty filter", () => {
  assert.deepEqual(m.filterMiners(m.DEMO.miners, ""), m.DEMO.miners);
  assert.deepEqual(m.filterMiners(null, ""), []);
  assert.deepEqual(m.filterMiners(undefined, "rig"), []);
});

test("filterMiners matches wallet + worker case-insensitively", () => {
  const f = (q) => m.filterMiners(m.DEMO.miners, q).map((x) => x.worker);
  assert.deepEqual(f("rig1"), ["rig1"]);
  assert.deepEqual(f("RIG1"), ["rig1"]); // the helper lowercases its needle too
  assert.deepEqual(f("prl1demo1111"), ["cmp1"]);
  assert.deepEqual(f("solo1"), ["solo1"]);
  assert.deepEqual(f("nope"), []);
});

test("statsHtml renders the six cards from pool + payouts", () => {
  const html = m.statsHtml(m.DEMO.pool, m.DEMO.payouts, true);
  for (const s of ["Block height", "120,042", "Miners online", "Shares accepted",
                   "Blocks found", "1% pool fee · PPLNS", "PPLNS window",
                   "1,204", "of 1,000,000 shares", "Uptime", "24h", "cert v3 · mainnet"])
    assert.ok(html.includes(s), "stats card contains: " + s);
  assert.equal((html.match(/class="card"/g) || []).length, 6);
});

test("statsHtml marks demo figures with the demo tag only in demo mode", () => {
  assert.ok(m.statsHtml(m.DEMO.pool, m.DEMO.payouts, true).includes('class="demo-tag"'));
  assert.ok(!m.statsHtml(m.DEMO.pool, m.DEMO.payouts, false).includes('class="demo-tag"'));
});

test("statsHtml escapes backend strings (templateSource / network / fee / cert)", () => {
  const pool = { ...m.DEMO.pool, templateSource: "<img src=x>", network: 'main"><svg>', certVersion: "3<b>" };
  const html = m.statsHtml(pool, { ...m.DEMO.payouts, poolFeePct: "1<script>" }, false);
  assert.ok(!html.includes("<img src=x>"), "templateSource cannot inject markup");
  assert.ok(!html.includes('main"><svg>'), "network cannot break out");
  assert.ok(!html.includes("1<script>"), "poolFeePct cannot inject markup");
  assert.ok(!html.includes("3<b>"), "certVersion cannot inject markup");
  assert.ok(html.includes("&lt;img src=x&gt;"), "templateSource still readable, escaped");
});

test("minersSection renders demo miners with truncated wallets and solo tag", () => {
  const { sub, html } = m.minersSection(m.DEMO.miners, "");
  assert.equal(sub, "3 connected");
  assert.ok(html.includes("prl1demo00…000000"));
  assert.ok(html.includes("rig1"));
  assert.ok(html.includes('<span class="tag solo">solo</span>'));
  assert.ok(html.includes("59.26 kH/s"));
  assert.ok(html.includes("888,888"));
});

test("minersSection reports the match count and empty states honestly", () => {
  const one = m.minersSection(m.DEMO.miners, "rig1");
  assert.equal(one.sub, "3 connected · 1 match");
  assert.ok(!one.html.includes("cmp1"));
  const none = m.minersSection(m.DEMO.miners, "zzz");
  assert.equal(none.sub, "3 connected · 0 match");
  assert.ok(none.html.includes("No miners match your search."));
  const empty = m.minersSection([], "");
  assert.equal(empty.sub, "0 connected");
  assert.ok(empty.html.includes("No miners connected yet."));
});

test("minersSection escapes hostile wallet / worker / dialect (the XSS fix)", () => {
  const hostile = [{
    wallet: '"><img src=x onerror=alert(1)>',
    worker: "<script>alert(2)</" + "script>",
    dialect: 'hero" onmouseover="alert(3)',
    diff: 1, sharesValid: 1, sharesInvalid: 0, lastShareAt: 0, estHashrate: 0, solo: false,
  }];
  const { html } = m.minersSection(hostile, "");
  assert.ok(!html.includes("<img"), "wallet cannot inject an <img> (text or title attribute)");
  assert.ok(!html.includes("<script>alert"), "worker cannot inject a <script>");
  assert.ok(!html.includes('onmouseover="alert'), "dialect cannot break out into an attribute");
  assert.ok(html.includes("&lt;img"), "hostile wallet still shown, escaped");
  assert.ok(html.includes('title="&quot;&gt;&lt;img'), "title attribute is quote-escaped");
});

test("roundsHtml formats reward + fee grain-exactly and counts payouts", () => {
  const html = m.roundsHtml(m.DEMO.payouts.rounds);
  assert.ok(html.includes("<td>120041</td>"));
  assert.ok(html.includes("2305.4952 PRL"));
  assert.ok(html.includes("23.0550"));
  assert.ok(html.includes("<td>5</td>")); // second round paid 5 miners
  assert.ok(m.roundsHtml([]).includes("No blocks found yet."));
  assert.ok(m.roundsHtml(undefined).includes("No blocks found yet."));
});

test("roundsHtml dashes a missing reward instead of printing NaN PRL", () => {
  const html = m.roundsHtml([{ height: 7, payouts: [] }]);
  assert.ok(html.includes("— PRL"));
  assert.ok(!html.includes("NaN"));
});

test("balancesHtml renders balances, escapes hostile wallets, dashes missing fields", () => {
  const html = m.balancesHtml(m.DEMO.balances);
  assert.ok(html.includes("12.45019302 PRL"));
  assert.ok(html.includes("4.11882011 PRL"));
  assert.ok(html.includes("prl1demo00…000000"));
  const hostile = m.balancesHtml([{ wallet: "<svg onload=alert(1)>", unpaidPRL: "1", paidPRL: "0", blocks: 0 }]);
  assert.ok(!hostile.includes("<svg"), "balance wallet cannot inject markup");
  assert.ok(hostile.includes("&lt;svg"));
  const missing = m.balancesHtml([{ wallet: "prl1x" }]);
  assert.ok(missing.includes("— PRL") && !missing.includes("undefined"));
  assert.ok(m.balancesHtml([]).includes("No balances yet"));
});
