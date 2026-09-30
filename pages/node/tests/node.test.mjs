// Pearl Node core tests — pure node-core.js logic, no DOM, no network.
// Run: node --test tests/node.test.mjs  (from pages/node/)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NETWORKS, DEFAULT_ENDPOINT, defaultSettings, validateSettings, basicAuthHeader,
  rpcCall, READ_METHODS, fmtInt, fmtBytes, fmtHashrate, fmtPingUs, fmtAgeSec,
  fmtUnixSec, escHtml, normalizePeer, sortPeers, nodeHealth, mempoolStats,
  overviewCards, networkMismatch,
} from "../src/node-core.js";

test("networks table matches verified ports", () => {
  assert.equal(NETWORKS.mainnet.rpcPort, 44107);
  assert.equal(NETWORKS.mainnet.p2pPort, 44108);
  assert.equal(NETWORKS.testnet.rpcPort, 44109);
  assert.equal(NETWORKS.testnet2.rpcPort, 44111);
  assert.equal(DEFAULT_ENDPOINT, "http://127.0.0.1:44120/rpc");
});

test("read methods are exactly the six documented read-only calls", () => {
  assert.deepEqual([...READ_METHODS].sort(), ["getchaintips", "getinfo", "getmempoolinfo", "getmininginfo", "getnettotals", "getpeerinfo"].sort());
});

test("validateSettings accepts a sane relay config", () => {
  const v = validateSettings({ endpoint: "http://127.0.0.1:44120/rpc", user: "u", pass: "p", network: "mainnet", pollSec: 30 });
  assert.ok(v.ok, v.errors.join("; "));
});

test("validateSettings refuses garbage", () => {
  assert.ok(!validateSettings({ endpoint: "not a url", network: "mainnet", pollSec: 30 }).ok);
  assert.ok(!validateSettings({ endpoint: "ftp://x/", network: "mainnet", pollSec: 30 }).ok);
  assert.ok(!validateSettings({ endpoint: "http://127.0.0.1:44120/rpc", network: "nope", pollSec: 30 }).ok);
  assert.ok(!validateSettings({ endpoint: "http://127.0.0.1:44120/rpc", network: "mainnet", pollSec: 2 }).ok);
  assert.ok(!validateSettings({ endpoint: "", network: "mainnet", pollSec: 30 }).ok);
  assert.ok(validateSettings({ endpoint: "http://127.0.0.1:44120/rpc", network: "mainnet", pollSec: 0 }).ok);
});

test("basicAuthHeader", () => {
  assert.equal(basicAuthHeader("", ""), null);
  assert.equal(basicAuthHeader("u", "p"), "Basic " + Buffer.from("u:p").toString("base64"));
});

const okFetch = (result) => async () => ({ ok: true, status: 200, json: async () => ({ result, error: null }) });
const rpcErrFetch = async () => ({ ok: true, status: 200, json: async () => ({ result: null, error: { code: -1, message: "boom" } }) });
const authFetch = async () => ({ ok: false, status: 401 });
const httpFetch = async () => ({ ok: false, status: 500 });
const badJsonFetch = async () => ({ ok: true, status: 200, json: async () => { throw new Error("nope"); } });
const downFetch = async () => { throw new Error("ECONNREFUSED"); };

test("rpcCall success passes result through", async () => {
  const r = await rpcCall(okFetch({ blocks: 120000 }), "http://x/", "getinfo");
  assert.ok(r.ok);
  assert.equal(r.result.blocks, 120000);
});

test("rpcCall classifies failures", async () => {
  assert.equal((await rpcCall(rpcErrFetch, "http://x/", "getinfo")).kind, "rpc");
  assert.equal((await rpcCall(authFetch, "http://x/", "getinfo")).kind, "auth");
  assert.equal((await rpcCall(httpFetch, "http://x/", "getinfo")).kind, "http");
  assert.equal((await rpcCall(badJsonFetch, "http://x/", "getinfo")).kind, "badjson");
  assert.equal((await rpcCall(downFetch, "http://x/", "getinfo")).kind, "network");
});

test("formatters", () => {
  assert.equal(fmtInt(1234567), "1,234,567");
  assert.equal(fmtInt(null), "—");
  assert.equal(fmtBytes(0), "0.00 B");
  assert.equal(fmtBytes(310768), "303 KB");
  assert.equal(fmtBytes(5 * 1024 * 1024), "5.00 MB");
  assert.equal(fmtHashrate(0), "0.00 H/s");
  assert.equal(fmtHashrate(33081554756), "33.08 GH/s");
  assert.equal(fmtHashrate(1500), "1.50 kH/s");
  assert.equal(fmtPingUs(405551), "406 ms");
  assert.equal(fmtPingUs(5000), "5.0 ms");
  assert.equal(fmtPingUs(null), "—");
  assert.equal(fmtAgeSec(45), "45s");
  assert.equal(fmtAgeSec(3723), "1h 2m");
  assert.equal(fmtAgeSec(90000), "1d 1h");
  assert.equal(fmtUnixSec(0), "—");
  assert.ok(fmtUnixSec(1391626433).includes("2014"));
  assert.equal(escHtml('<script>alert("x")</script>'), "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
});

test("normalizePeer converts microseconds and flags staleness", () => {
  const now = 1_700_000_000;
  const r = normalizePeer({
    addr: "1.2.3.4:44108", subver: "/pearld:1.4.9/", pingtime: 405551,
    inbound: false, syncnode: true, startingheight: 100, currentheight: 120,
    bytessent: 1000, bytesrecv: 2000, conntime: now - 3600, lastrecv: now - 30,
    version: 70001,
  }, now);
  assert.equal(r.addr, "1.2.3.4:44108");
  assert.equal(r.pingUs, 405551);
  assert.equal(r.syncNode, true);
  assert.equal(r.connAgeSec, 3600);
  assert.equal(r.stale, false);
  const stale = normalizePeer({ lastrecv: now - 3601, conntime: now - 7200 }, now);
  assert.equal(stale.stale, true);
  assert.equal(stale.pingUs, null);
});

test("sortPeers orders by key and direction", () => {
  const rows = [
    { addr: "b", pingUs: 9000 }, { addr: "a", pingUs: 1000 }, { addr: "c", pingUs: null },
  ];
  assert.deepEqual(sortPeers(rows, "ping", 1).map((r) => r.addr), ["a", "b", "c"]);
  assert.deepEqual(sortPeers(rows, "ping", -1).map((r) => r.addr), ["c", "b", "a"]);
});

test("nodeHealth flags errors, isolation, forks, stale peers", () => {
  const base = {
    info: { connections: 8, testnet: false, timeoffset: 0 },
    mining: { errors: "" },
    mempool: { size: 12 },
    peerRows: [{ stale: false, syncNode: true }],
    tips: [{ height: 1, hash: "ab", status: "active" }],
  };
  const ok = nodeHealth(base);
  assert.equal(ok.level, "ok");

  const err = nodeHealth({ ...base, mining: { errors: "disk full" } });
  assert.equal(err.level, "error");
  assert.ok(err.notes.some((n) => n.text.includes("disk full")));

  const iso = nodeHealth({ ...base, info: { connections: 0, testnet: false, timeoffset: 0 } });
  assert.equal(iso.level, "warn");
  assert.ok(iso.notes.some((n) => n.text.includes("Zero peer")));

  const fork = nodeHealth({ ...base, tips: [{ status: "active" }, { status: "valid-fork" }] });
  assert.equal(fork.level, "warn");

  const stale = nodeHealth({ ...base, peerRows: [{ stale: true, syncNode: false }, { stale: true, syncNode: false }] });
  assert.equal(stale.level, "warn");

  const testnet = nodeHealth({ ...base, info: { connections: 3, testnet: true, timeoffset: 0 } });
  assert.ok(testnet.notes.some((n) => n.text.includes("testnet")));
});

test("mempoolStats derives averages and cross-checks pooledtx", () => {
  const s = mempoolStats({ size: 157, bytes: 310768 }, { pooledtx: 157 });
  assert.equal(s.avgTxBytes, 1979);
  assert.equal(s.poolMatch, true);
  const s2 = mempoolStats({ size: 10, bytes: 1000 }, { pooledtx: 11 });
  assert.equal(s2.poolMatch, false);
  const s3 = mempoolStats({ size: 0, bytes: 0 }, {});
  assert.equal(s3.avgTxBytes, null);
});

test("overviewCards covers the verified getinfo/getmininginfo fields", () => {
  const cards = overviewCards({
    info: { blocks: 120195, difficulty: 256, connections: 17, testnet: false, version: 1040900, protocolversion: 70001, relayfee: 0.00001 },
    mining: { networkhashps: 33081554756 },
    mempool: { size: 8, bytes: 310768 },
    nettotals: { totalbytesrecv: 1150990, totalbytessent: 206739 },
    tips: [{ height: 120195, hash: "abc123def456789012345678", status: "active" }],
  });
  const labels = cards.map((c) => c.label);
  for (const want of ["Block height", "Difficulty", "Network hashrate", "Peers", "Mempool", "pearld version", "Bandwidth", "Best block"]) {
    assert.ok(labels.includes(want), `missing card ${want}`);
  }
  const h = cards.find((c) => c.label === "Block height");
  assert.equal(h.value, "120,195");
});

test("networkMismatch catches settings/node disagreement", () => {
  assert.ok(networkMismatch("mainnet", { testnet: true }).includes("testnet"));
  assert.ok(networkMismatch("testnet", { testnet: false }).includes("mainnet"));
  assert.equal(networkMismatch("mainnet", { testnet: false }), null);
  assert.equal(networkMismatch("mainnet", {}), null);
});
