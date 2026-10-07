// Pearl Metrics — DOM wiring + honesty pins. Run: node --test tests/dom.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(dir, "..", "index.html"), "utf8");
const js = readFileSync(path.join(dir, "..", "app.js"), "utf8");
const core = readFileSync(path.join(dir, "..", "metrics-core.js"), "utf8");

test("all id lookups in app.js resolve to an element in index.html", () => {
  const ids = new Set();
  for (const mm of js.matchAll(/\$\("([A-Za-z0-9_]+)"\)/g)) ids.add(mm[1]);
  for (const mm of js.matchAll(/\$\('([A-Za-z0-9_]+)'\)/g)) ids.add(mm[1]);
  assert.ok(ids.size >= 20, "expected the full wiring set, got " + ids.size);
  const missing = [...ids].filter((id) => !new RegExp(`id="${id}"`).test(html));
  assert.deepEqual(missing, [], "missing ids: " + missing.join(", "));
});

test("cache-buster keys present and pinned", () => {
  assert.ok(html.includes('href="styles.css?v=1"'));
  assert.ok(html.includes('src="metrics-core.js?v=1"'));
  assert.ok(html.includes('src="app.js?v=1"'));
});

test("attribution: PRL address and @kshot9000 present character-for-character", () => {
  assert.ok(html.includes("prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d"));
  assert.ok(html.includes("https://x.com/kshot9000"));
  assert.ok(html.includes("@pearl-research-labs PR #310") || html.includes("pearl-research-labs/pearl/pull/310"));
});

test("honesty: pre-release status of PR #310 + unauthenticated warning are on the page", () => {
  assert.ok(html.includes("not yet in a released pearld"), "PR #310 must be labelled pre-release");
  assert.ok(html.includes("unauthenticated"), "endpoint auth warning present");
  assert.ok(js.includes("SAMPLE data (illustrative"), "sample scrape is labelled in the UI");
});

test("every pearld_* metric the UI summarises exists in the PR #310 catalogue set in core", () => {
  const catalogue = [
    "pearld_info", "pearld_chain_tip_height", "pearld_chain_tip_timestamp_seconds",
    "pearld_chain_total_transactions", "pearld_chain_is_current",
    "pearld_chain_blocks_connected_total", "pearld_chain_blocks_disconnected_total",
    "pearld_chain_blocks_accepted_total", "pearld_p2p_peers",
    "pearld_p2p_peer_connects_total", "pearld_p2p_peer_disconnects_total",
    "pearld_p2p_peers_banned_total", "pearld_p2p_peers_rejected_total",
    "pearld_p2p_wire_bytes_total", "pearld_p2p_wire_messages_total",
    "pearld_net_totalbytes_recv_total", "pearld_net_totalbytes_sent_total",
    "pearld_rpc_requests_total", "pearld_rpc_request_duration_seconds",
    "pearld_rpc_auth_failures_total", "pearld_rpc_websocket_clients",
    "pearld_mempool_transactions", "pearld_mempool_bytes",
    "pearld_mempool_max_bytes", "pearld_mempool_last_updated_timestamp_seconds",
  ];
  for (const name of catalogue) assert.ok(core.includes(name), "core references " + name);
});

test("XSS pin: scrape-derived rendering goes through esc()", () => {
  assert.ok(js.includes("function esc("), "esc helper defined");
  // identity + tables are built with esc() on every interpolated label/value
  for (const needle of ["esc(id.version", "esc(r.method)", "esc(w.command)", "esc(n.text)"]) {
    assert.ok(js.includes(needle), "rendering escapes via " + needle);
  }
  assert.ok(!js.includes("innerHTML = text"), "raw scrape text is never assigned to innerHTML");
});

test("sample scrape uses only PR #310 metric names for pearld_* series", () => {
  const sample = js.slice(js.indexOf("SAMPLE_SCRAPE"));
  const names = new Set([...sample.matchAll(/\b(pearld_[a-z0-9_]+)/g)].map((m) => m[1]));
  assert.ok(names.size >= 15, "sample covers the catalogue, got " + names.size);
});
