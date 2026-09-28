/* Pearl Gallery — node test suite for js/gallery-core.js (pure logic). */
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const g = require("../js/gallery-core.js");

test("normalizeContentType strips params and lowercases", () => {
  assert.equal(g.normalizeContentType("image/png; charset=x"), "image/png");
  assert.equal(g.normalizeContentType("Image/PNG"), "image/png");
  assert.equal(g.normalizeContentType("application/json"), "application/json");
});

test("normalizeContentType rejects hostile or malformed values", () => {
  assert.equal(g.normalizeContentType('image/png";alert(1)//'), "");
  assert.equal(g.normalizeContentType('text/html"><svg onload=x>'), "");
  assert.equal(g.normalizeContentType("not a type"), "");
  assert.equal(g.normalizeContentType("image/"), "");
  assert.equal(g.normalizeContentType("/png"), "");
  assert.equal(g.normalizeContentType(""), "");
  assert.equal(g.normalizeContentType(null), "");
  assert.equal(g.normalizeContentType(undefined), "");
  assert.equal(g.normalizeContentType("image/svg+xml"), "image/svg+xml");
});

test("classifyContent image/audio/video buckets", () => {
  assert.equal(g.classifyContent("image/png", 100).bucket, "image");
  assert.equal(g.classifyContent("image/webp;foo=1", 100).bucket, "image");
  assert.equal(g.classifyContent("audio/mpeg", 100).bucket, "audio");
  assert.equal(g.classifyContent("video/mp4", 100).bucket, "video");
  assert.equal(g.classifyContent("text/plain", 10).bucket, "text");
  assert.equal(g.classifyContent("application/json", 10).bucket, "text");
  assert.equal(g.classifyContent("application/vnd.foo+json", 10).bucket, "text");
});

test("classifyContent never renders script-capable types", () => {
  assert.equal(g.classifyContent("image/svg+xml", 100).bucket, "not-rendered");
  assert.equal(g.classifyContent("text/html", 100).bucket, "not-rendered");
  assert.equal(g.classifyContent("application/xhtml+xml", 100).bucket, "not-rendered");
  assert.equal(g.classifyContent("application/octet-stream", 100).bucket, "binary");
  assert.equal(g.classifyContent("", 100).bucket, "unknown");
});

test("classifyContent refuses oversize previews", () => {
  const big = g.MAX_PREVIEW_BYTES + 1;
  assert.equal(g.classifyContent("image/png", big).bucket, "too-large");
  assert.equal(g.classifyContent("image/png", 8).bucket, "image");
  assert.equal(g.classifyContent("image/png", null).bucket, "image"); // unknown size allowed
});

test("decodeBase64Strict accepts clean, rejects hostile", () => {
  const ok = g.decodeBase64Strict("aGVsbG8=");
  assert.ok(ok instanceof Uint8Array);
  assert.equal(Buffer.from(ok).toString(), "hello");
  const ws = g.decodeBase64Strict("aGVs\nbG8=");
  assert.ok(ws instanceof Uint8Array);
  assert.equal(Buffer.from(ws).toString(), "hello");
  assert.equal(g.decodeBase64Strict("aGVsbG8=;evil"), null);
  assert.equal(g.decodeBase64Strict("***"), null);
  assert.equal(g.decodeBase64Strict("a"), null); // bad length
  assert.equal(g.decodeBase64Strict(""), null);
  assert.equal(g.decodeBase64Strict(null), null);
});

test("buildDataUrl happy path for png", () => {
  // 1x1 transparent png
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const url = g.buildDataUrl({
    encoding: "base64", contentType: "image/png",
    byteLength: Buffer.from(png, "base64").length, bodyBase64: png,
  });
  assert.ok(url.startsWith("data:image/png;base64,"));
  assert.ok(url.includes(png));
});

test("buildDataUrl refuses unsafe cases", () => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const base = { encoding: "base64", contentType: "image/png", byteLength: Buffer.from(png, "base64").length, bodyBase64: png };
  // svg is not-rendered -> refuse
  assert.equal(g.buildDataUrl({ ...base, contentType: "image/svg+xml" }), "");
  // wrong encoding
  assert.equal(g.buildDataUrl({ ...base, encoding: "hex" }), "");
  // length mismatch lie
  assert.equal(g.buildDataUrl({ ...base, byteLength: 1 }), "");
  // oversize declaration
  assert.equal(g.buildDataUrl({ ...base, byteLength: g.MAX_PREVIEW_BYTES + 1 }), "");
  // garbage base64
  assert.equal(g.buildDataUrl({ ...base, bodyBase64: "!!!" }), "");
  // text is not a data-url bucket
  assert.equal(g.buildDataUrl({ ...base, contentType: "text/plain", bodyBase64: "aGVsbG8=" }), "");
});

test("fmtBytes formats sizes", () => {
  assert.equal(g.fmtBytes(0), "0 B");
  assert.equal(g.fmtBytes(512), "512 B");
  assert.equal(g.fmtBytes(1536), "1.50 KB");
  assert.equal(g.fmtBytes(3 * 1024 * 1024), "3.00 MB");
  assert.equal(g.fmtBytes(null), "—");
  assert.equal(g.fmtBytes("abc"), "—");
});

test("short truncates long ids", () => {
  const long = "a".repeat(40);
  assert.equal(g.short(long, 8), "aaaaaaaa…aaaaaaaa");
  assert.equal(g.short("short"), "short");
});

test("normalizeCard reads camelCase and snake_case", () => {
  const c1 = g.normalizeCard({
    inscriptionId: "abc", inscriptionNumber: 42, contentType: "image/png",
    byteLength: 100, txid: "tx1", blockHeight: 120000, protocolMarker: "prl-20",
    currentOwnerAddress: "prl1p…"
  });
  assert.equal(c1.id, "abc");
  assert.equal(c1.inscriptionNumber, 42);
  assert.equal(c1.cls.bucket, "image");
  assert.equal(c1.ownerAddress, "prl1p…");
  const c2 = g.normalizeCard({ id: "x", content_type: "text/plain", byte_length: 5 });
  assert.equal(c2.id, "x");
  assert.equal(c2.cls.bucket, "text");
  assert.equal(c2.inscriptionNumber, null);
  assert.equal(g.normalizeCard(null).id, "");
});

test("inscriptionsQuery clamps and defaults", () => {
  assert.equal(g.inscriptionsQuery({ order: "desc", page: 2, limit: 24 }), "?order=desc&page=2&limit=24");
  assert.equal(g.inscriptionsQuery({ order: "nope", page: -3, limit: 500 }), "?order=desc&page=1&limit=100");
  assert.equal(g.inscriptionsQuery({ order: "asc" }), "?order=asc&page=1&limit=24");
});

test("parseLookup routes numbers vs ids", () => {
  assert.deepEqual(g.parseLookup("  "), { kind: "empty" });
  assert.deepEqual(g.parseLookup("42"), { kind: "number", value: "42" });
  assert.deepEqual(g.parseLookup("006"), { kind: "number", value: "006" });
  assert.deepEqual(g.parseLookup("a1b2c3d4"), { kind: "id", value: "a1b2c3d4" });
});

test("findByNumber scans a list-page payload", () => {
  const payload = { inscriptions: [{ inscriptionNumber: 9, id: "a" }, { inscriptionNumber: 10, id: "b" }] };
  assert.equal(g.findByNumber(payload, "10").id, "b");
  assert.equal(g.findByNumber(payload, 7), null);
  assert.equal(g.findByNumber(null, 1), null);
});

test("standing identifiers present in core", () => {
  assert.equal(g.DONATE_ADDRESS, "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d");
  assert.equal(g.X_HANDLE, "kshot9000");
});
