// Pearl Metrics — core tests. Run: node --test tests/metrics.test.mjs
// Metric names/format are pinned to pearl-research-labs/pearl PR #310
// (node/metrics/README.md on feat/pearld-metrics).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const M = require("../metrics-core.js");

const SCRAPE = [
  "# HELP pearld_info Node identity.",
  "# TYPE pearld_info gauge",
  'pearld_info{network="mainnet",protocol_version="70016",version="1.4.9"} 1',
  "pearld_chain_tip_height 1000",
  "pearld_chain_tip_timestamp_seconds 900",
  "pearld_chain_total_transactions 555",
  "pearld_chain_is_current 1",
  "pearld_chain_blocks_connected_total 10",
  "pearld_chain_blocks_disconnected_total 1",
  "pearld_chain_blocks_accepted_total 10",
  'pearld_p2p_peers{direction="inbound"} 3',
  'pearld_p2p_peers{direction="outbound"} 8',
  'pearld_p2p_peers_rejected_total{reason="max_peers"} 5',
  "pearld_rpc_requests_total" + '{method="getblock",result="success"} 90',
  'pearld_rpc_requests_total{method="getblock",result="error"} 10',
  'pearld_rpc_request_duration_seconds_bucket{method="getblock",le="0.005"} 50',
  'pearld_rpc_request_duration_seconds_bucket{method="getblock",le="0.025"} 97',
  'pearld_rpc_request_duration_seconds_bucket{method="getblock",le="+Inf"} 100',
  'pearld_rpc_request_duration_seconds_sum{method="getblock"} 1.0',
  'pearld_rpc_request_duration_seconds_count{method="getblock"} 100',
  "pearld_rpc_auth_failures_total 2",
  "pearld_rpc_websocket_clients 1",
  "pearld_mempool_transactions 42",
  "pearld_mempool_bytes 900",
  "pearld_mempool_max_bytes 1000",
  "pearld_mempool_last_updated_timestamp_seconds 990",
  "this is not a metric line",
  'pearld_net_totalbytes_recv_total 2048',
].join("\n");

test("parser: families, types, labels, malformed lines", () => {
  const p = M.parseExposition(SCRAPE);
  assert.equal(p.families["pearld_info"].type, "gauge");
  assert.equal(p.families["pearld_info"].samples[0].labels.version, "1.4.9");
  assert.equal(p.errors.length, 1);
  assert.equal(p.errors[0].line, 27);
});

test("parser: label escapes and special values", () => {
  const p = M.parseExposition('x{a="b\\"c\\\\d\\ne"} +Inf\ny -Inf\nz NaN');
  assert.equal(p.samples[0].labels.a, 'b"c\\d\ne');
  assert.equal(p.samples[0].value, Infinity);
  assert.equal(p.samples[1].value, -Infinity);
  assert.ok(Number.isNaN(p.samples[2].value));
});

test("summary: chain, peers, mempool, rpc error rate", () => {
  const s = M.summarize(M.parseExposition(SCRAPE), 1000);
  assert.equal(s.isPearld, true);
  assert.deepEqual(s.missing, []);
  assert.equal(s.chain.tipHeight, 1000);
  assert.equal(s.chain.tipAgeSeconds, 100);
  assert.equal(s.info.network, "mainnet");
  assert.equal(s.peers.inbound + s.peers.outbound, 11);
  assert.equal(s.peers.rejected.max_peers, 5);
  assert.equal(s.mempool.utilization, 0.9);
  assert.equal(s.rpc.totals.total, 100);
  assert.equal(s.rpc.totals.errorRate, 0.1);
  const gb = s.rpc.byMethod.find((r) => r.method === "getblock");
  assert.equal(gb.meanSeconds, 0.01);
  // rank 95 falls in the 0.025 bucket: 0.005 + (95-50)/(90-50)... capped in-bucket interpolation
  assert.ok(gb.p95Seconds > 0.005 && gb.p95Seconds <= 0.025, "p95 interpolates inside its bucket, got " + gb.p95Seconds);
});

test("summary: health flags mempool >=90%, auth failures, rpc errors", () => {
  const s = M.summarize(M.parseExposition(SCRAPE), 1000);
  const texts = s.health.map((n) => n.text).join(" | ");
  assert.match(texts, /Mempool is over 90%/);
  assert.match(texts, /failed RPC authentication/);
  assert.match(texts, /RPC error rate/);
});

test("summary: non-pearld scrape is flagged, not summarised as healthy", () => {
  const s = M.summarize(M.parseExposition("go_goroutines 12\n"), 1000);
  assert.equal(s.isPearld, false);
  assert.equal(s.health[0].level, "error");
});

test("summary: stale tip and zero peers are errors", () => {
  const stale = SCRAPE.replace("pearld_chain_tip_timestamp_seconds 900", "pearld_chain_tip_timestamp_seconds 100")
    .replace('pearld_p2p_peers{direction="inbound"} 3', 'pearld_p2p_peers{direction="inbound"} 0')
    .replace('pearld_p2p_peers{direction="outbound"} 8', 'pearld_p2p_peers{direction="outbound"} 0');
  const s = M.summarize(M.parseExposition(stale), 5000);
  const levels = s.health.map((n) => n.level + ":" + n.text).join(" | ");
  assert.match(levels, /error:Chain tip is over an hour old/);
  assert.match(levels, /error:Zero connected peers/);
});

test("quantile: rank in +Inf bucket returns null (honest, not a number)", () => {
  const buckets = [{ le: 0.005, count: 10 }, { le: Infinity, count: 100 }];
  assert.equal(M.approxQuantile(buckets, 100, 0.95), null);
  assert.ok(M.approxQuantile(buckets, 100, 0.05) <= 0.005);
});

test("counterRates: per-second deltas, restart yields null", () => {
  const a = M.parseExposition("c_total 100\nd_total 50").samples;
  const b = M.parseExposition("c_total 160\nd_total 40").samples;
  const r = M.counterRates(a, b, 10);
  assert.equal(r.c_total, 6);
  assert.equal(r.d_total, null);
});

test("formatters", () => {
  assert.equal(M.fmtBytes(2048), "2.00 KiB");
  assert.equal(M.fmtBytes(500), "500 B");
  assert.equal(M.fmtAge(30), "30s ago");
  assert.equal(M.fmtSeconds(0.0024), "2.4 ms");
  assert.equal(M.fmtInt(null), "—");
});
