// Pearl Watch core tests (node:test). Runs against src/ via the importmap
// loader hook — exercises the real audited Sign lineage, not the bundle.
// Usage: node --no-warnings --loader ./tests/loader.mjs tests/watch.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  NETWORKS, GRAIN_PER_PRL, fmtPRL, parsePRL,
  WATCH_VERSION, MAX_WATCHED, MAX_RULES,
  validateWatchAddress, networkForHrp,
  shortAddr, shortTxid, fmtAge,
  normalizeBlockbookBase,
  fetchAddressSnapshot, fetchTxDetail, fetchTipHeight,
  summarizeTxForAddress, txConfirmations, confirmationProgress,
  diffSnapshots,
  RULE_KINDS, normalizeRule, evaluateRules,
  eventsToCSV, serializeWatchState, deserializeWatchState, defaultWatchState,
} from "../src/index.js";
import { encodeBech32m, decodeBech32m, sha256, hexToBytes } from "../../sign/src/crypto.js";

const N = NETWORKS.mainnet;
const TN = NETWORKS.testnet;
const te = new TextEncoder();

function prlAddr(seed) {
  return encodeBech32m("prl", 1, sha256(te.encode(seed)));
}
const A1 = prlAddr("watch-test-a1");
const A2 = prlAddr("watch-test-a2");
const TX1 = "ab".repeat(32);

/* ---------------- address validation ---------------- */

test("validateWatchAddress accepts a canonical prl1 address", () => {
  assert.equal(validateWatchAddress(A1, N), A1);
  assert.equal(validateWatchAddress("  " + A1.toUpperCase() + " ", N), A1); // trim + normalize
});

test("validateWatchAddress refuses junk loudly", () => {
  assert.throws(() => validateWatchAddress("", N), /empty/);
  assert.throws(() => validateWatchAddress("junk-address", N), /WATCH REFUSED/);
  assert.throws(() => validateWatchAddress("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", N), /WATCH REFUSED/);
});

test("validateWatchAddress refuses wrong-network hrp", () => {
  const t = encodeBech32m("tprl", 1, sha256(te.encode("x")));
  assert.throws(() => validateWatchAddress(t, N), /WATCH REFUSED/);
  assert.equal(validateWatchAddress(t, TN), t);
});

test("validateWatchAddress refuses witness v0 and short programs", () => {
  // Test-only bech32m encoder (scaffolding — never shipped): the audited
  // encoder rightly refuses to *create* these, so we mint hostile specimens
  // by hand to prove validateWatchAddress refuses them.
  const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  const hrpExpand = (h) => [...h].map((c) => c.charCodeAt(0) >> 5).concat([0], [...h].map((c) => c.charCodeAt(0) & 31));
  const polymod = (v) => {
    let chk = 1;
    for (const x of v) { const b = chk >> 25; chk = ((chk & 0x1ffffff) << 5) ^ x; for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= GEN[i]; }
    return chk;
  };
  const convertBits = (data, from, to, pad) => {
    let acc = 0, bits = 0; const ret = []; const maxv = (1 << to) - 1;
    for (const value of data) { acc = (acc << from) | value; bits += from; while (bits >= to) { bits -= to; ret.push((acc >>> bits) & maxv); } }
    if (pad && bits) ret.push((acc << (to - bits)) & maxv);
    return ret;
  };
  const hostile = (hrp, version, program) => {
    const data = [version, ...convertBits([...program], 8, 5, true)];
    const pm = polymod(hrpExpand(hrp).concat(data, [0, 0, 0, 0, 0, 0])) ^ 0x2bc830a3;
    const cs = [0, 1, 2, 3, 4, 5].map((i) => (pm >> (5 * (5 - i))) & 31);
    return hrp + "1" + data.concat(cs).map((v) => CHARSET[v]).join("");
  };
  const v0 = hostile("prl", 0, sha256(te.encode("v0")).slice(0, 20));
  assert.throws(() => validateWatchAddress(v0, N), /WATCH REFUSED/);
  const short = hostile("prl", 1, sha256(te.encode("short")).slice(0, 20));
  assert.throws(() => validateWatchAddress(short, N), /WATCH REFUSED/);
  // sanity: the hostile encoder agrees with the audited one on valid inputs
  const good = hostile("prl", 1, sha256(te.encode("agree")));
  assert.equal(validateWatchAddress(good, N), good);
});

test("networkForHrp", () => {
  assert.equal(networkForHrp("prl").id, "mainnet");
  assert.equal(networkForHrp("tprl").id, "testnet");
  assert.throws(() => networkForHrp("btc"), /unsupported hrp/);
});

test("fmtPRL/parsePRL grain-exact round-trip (audited reuse)", () => {
  assert.equal(parsePRL("2.5"), 250000000n);
  assert.equal(fmtPRL(250000000n), "2.5");
  assert.throws(() => parsePRL("1.123456789"), /invalid PRL amount/);
});

test("shortAddr/shortTxid/fmtAge", () => {
  assert.ok(shortAddr(A1).includes("…"));
  assert.equal(shortAddr("abc"), "abc");
  assert.ok(shortTxid(TX1).includes("…"));
  assert.equal(fmtAge(60000, 90000), "30s ago");
  assert.equal(fmtAge(0, 3 * 3600 * 1000), "3h ago");
});

/* ---------------- blockbook URL ---------------- */

test("normalizeBlockbookBase", () => {
  assert.equal(normalizeBlockbookBase("https://blockbook.pearlresearch.ai/"), "https://blockbook.pearlresearch.ai");
  assert.throws(() => normalizeBlockbookBase(""), /empty/);
  assert.throws(() => normalizeBlockbookBase("blockbook.example.com"), /http\(s\)/);
});

/* ---------------- stubbed fetches ---------------- */

function stubFetch(routes) {
  return async (url) => {
    const u = String(url);
    for (const [prefix, payload, status] of routes) {
      if (u.includes(prefix)) {
        const ok = (status ?? 200) < 400;
        return {
          ok, status: status ?? 200,
          text: async () => (typeof payload === "string" ? payload : JSON.stringify(payload)),
        };
      }
    }
    return { ok: false, status: 404, text: async () => "nf" };
  };
}

const ADDR_JSON = {
  address: A1, balance: "250000000", totalReceived: "500000000", totalSent: "250000000",
  txCount: 2,
  transactions: [
    { txid: TX1, blockHeight: 120100, confirmations: 5, valueIn: "0", value: "250000000", fees: "10000" },
    { txid: "cd".repeat(32), blockHeight: -1, confirmations: 0, valueIn: "250000000", value: "249990000", fees: "10000" },
  ],
};

test("fetchAddressSnapshot parses grains as BigInt", async () => {
  const f = stubFetch([["/api/v2/address/", ADDR_JSON]]);
  const s = await fetchAddressSnapshot(f, "https://bb.example", A1);
  assert.equal(s.balance, 250000000n);
  assert.equal(s.totalReceived, 500000000n);
  assert.equal(s.txs.length, 2);
  assert.equal(s.txs[0].txid, TX1);
  assert.equal(s.txs[1].blockHeight, -1);
});

test("fetchAddressSnapshot throws honestly on unreachable / bad status", async () => {
  const down = async () => { throw new Error("ECONNREFUSED"); };
  await assert.rejects(() => fetchAddressSnapshot(down, "https://bb.example", A1), /blockbook unreachable/);
  const f404 = stubFetch([]);
  await assert.rejects(() => fetchAddressSnapshot(f404, "https://bb.example", A1), /blockbook 404/);
});

test("fetchTxDetail refuses malformed txid", async () => {
  const f = stubFetch([]);
  await assert.rejects(() => fetchTxDetail(f, "https://bb.example", "xyz"), /64 hex/);
});

test("fetchTipHeight reads backend.blocks, refuses missing", async () => {
  const f = stubFetch([["/api/status", { backend: { blocks: 120105 } }]]);
  assert.equal(await fetchTipHeight(f, "https://bb.example"), 120105);
  const bad = stubFetch([["/api/status", { backend: {} }]]);
  await assert.rejects(() => fetchTipHeight(bad, "https://bb.example"), /no backend.blocks/);
});

/* ---------------- tx summary / confirmations ---------------- */

const FULL_TX = {
  txid: TX1, blockHeight: 120100, confirmations: 5,
  vout: [
    { value: "250000000", addresses: [A1] },
    { value: "100000000", addresses: [A2] },
  ],
  vin: [{ value: "350010000", addresses: [A2] }],
};

test("summarizeTxForAddress attributes vin/vout per address", () => {
  const s1 = summarizeTxForAddress(FULL_TX, A1);
  assert.equal(s1.received, 250000000n);
  assert.equal(s1.sent, 0n);
  assert.equal(s1.net, 250000000n);
  assert.equal(s1.unconfirmed, false);
  const s2 = summarizeTxForAddress(FULL_TX, A2);
  assert.equal(s2.received, 100000000n);
  assert.equal(s2.sent, 350010000n);
  assert.equal(s2.net, -250010000n);
  const mem = summarizeTxForAddress({ ...FULL_TX, blockHeight: -1, confirmations: 0 }, A1);
  assert.equal(mem.unconfirmed, true);
});

test("txConfirmations prefers Blockbook, falls back to tip math", () => {
  assert.equal(txConfirmations(FULL_TX, 120105), 5);
  assert.equal(txConfirmations({ blockHeight: 120100 }, 120105), 6);
  assert.equal(txConfirmations({ blockHeight: -1 }, 120105), 0);
  assert.equal(txConfirmations({ blockHeight: 120100 }, null), 0);
});

test("confirmationProgress", () => {
  const p = confirmationProgress({ blockHeight: 120100 }, 120105, 6);
  assert.deepEqual([p.confirmations, p.remaining, p.done], [6, 0, true]);
  const q = confirmationProgress({ blockHeight: -1 }, 120105, 6);
  assert.deepEqual([q.confirmations, q.remaining, q.done], [0, 6, false]);
});

/* ---------------- diffs ---------------- */

function snap(balance, txids) {
  return {
    address: A1, fetchedAt: 1, balance: BigInt(balance), totalReceived: 0n, totalSent: 0n,
    txCount: txids.length,
    txs: txids.map((t) => ({ txid: t, blockHeight: 1, confirmations: 1, valueIn: null, value: null, fees: null })),
  };
}

test("diffSnapshots finds new txids and balance deltas", () => {
  const d = diffSnapshots(snap(100, ["aa"]), snap(250, ["aa", "bb"]));
  assert.deepEqual(d.newTxids, ["bb"]);
  assert.equal(d.balanceDelta, 150n);
  assert.equal(d.firstSeen, false);
  const first = diffSnapshots(null, snap(100, ["aa"]));
  assert.equal(first.firstSeen, true);
  assert.deepEqual(first.newTxids, ["aa"]); // no events fire on first sight (seenTxids empty, but evaluateRules skips? see below)
});

/* ---------------- rules ---------------- */

test("normalizeRule: all kinds validate", () => {
  const r1 = normalizeRule({ kind: "incoming", address: A1, minGrains: 1000n, label: "whale" }, N);
  assert.equal(r1.address, A1);
  assert.equal(r1.minGrains, 1000n);
  const r2 = normalizeRule({ kind: "balance-above", address: A1, thresholdGrains: parsePRL("10") }, N);
  assert.equal(r2.thresholdGrains, 1000000000n);
  const r3 = normalizeRule({ kind: "tx-confirmed", txid: TX1, target: 6 }, N);
  assert.equal(r3.txid, TX1);
  assert.equal(r3.target, 6);
  assert.ok(RULE_KINDS.incoming && RULE_KINDS["tx-confirmed"]);
});

test("normalizeRule refuses bad config loudly", () => {
  assert.throws(() => normalizeRule({ kind: "nope", address: A1 }, N), /unknown rule kind/);
  assert.throws(() => normalizeRule({ kind: "incoming", address: "junk" }, N), /WATCH REFUSED/);
  assert.throws(() => normalizeRule({ kind: "incoming", address: A1, minGrains: -5n }, N), /non-negative/);
  assert.throws(() => normalizeRule({ kind: "tx-confirmed", txid: "zz", target: 6 }, N), /64-hex/);
  assert.throws(() => normalizeRule({ kind: "tx-confirmed", txid: TX1, target: 0 }, N), /1\.\.100000/);
  assert.throws(() => normalizeRule({ kind: "incoming" }, N), /needs a watched address/);
});

test("evaluateRules: first sight stays silent (history is not news)", () => {
  const rule = normalizeRule({ kind: "incoming", address: A1, minGrains: 0n }, N);
  const { events } = evaluateRules({
    snapshots: new Map([[A1, snap(250000000, [TX1])]]), prev: new Map(),
    rules: [rule], newTxDetails: new Map([[TX1, FULL_TX]]), txDetails: new Map(), tipHeight: 120105, nowMs: 1,
  });
  assert.equal(events.length, 0);
  // and the historical tx is now marked seen — a later genuinely-new tx still fires
  const later = evaluateRules({
    snapshots: new Map([[A1, snap(500000000, [TX1, "bb".repeat(32)])]]),
    prev: new Map([[A1, snap(250000000, [TX1])]]),
    rules: [rule],
    newTxDetails: new Map([["bb".repeat(32), { ...FULL_TX, txid: "bb".repeat(32) }]]),
    txDetails: new Map(), tipHeight: 120106, nowMs: 2,
  });
  assert.equal(later.events.length, 1);
  assert.equal(later.events[0].txid, "bb".repeat(32));
});

test("evaluateRules: incoming fires once per new tx, respects minimum", () => {
  const rule = normalizeRule({ kind: "incoming", address: A1, minGrains: parsePRL("1") }, N);
  const prev = new Map([[A1, snap(0, [])]]);
  const next = new Map([[A1, snap(250000000, [TX1])]]);
  const newTxDetails = new Map([[TX1, FULL_TX]]);
  const r1 = evaluateRules({ snapshots: next, prev, rules: [rule], newTxDetails, txDetails: new Map(), tipHeight: 120105, nowMs: 1000 });
  assert.equal(r1.events.length, 1);
  assert.equal(r1.events[0].kind, "incoming");
  assert.equal(r1.events[0].grains, "250000000");
  // second sweep: no refire (edge-triggered)
  const r2 = evaluateRules({ snapshots: next, prev: next, rules: [rule], newTxDetails, txDetails: new Map(), tipHeight: 120106, nowMs: 2000 });
  assert.equal(r2.events.length, 0);
});

test("evaluateRules: incoming below minimum stays silent", () => {
  const rule = normalizeRule({ kind: "incoming", address: A1, minGrains: parsePRL("1000") }, N);
  const prev = new Map([[A1, snap(0, [])]]);
  const next = new Map([[A1, snap(250000000, [TX1])]]);
  const { events } = evaluateRules({
    snapshots: next, prev, rules: [rule],
    newTxDetails: new Map([[TX1, FULL_TX]]), txDetails: new Map(), tipHeight: 120105, nowMs: 1000,
  });
  assert.equal(events.length, 0); // 2.5 PRL < 1000 PRL minimum
});

test("evaluateRules: outgoing fires on net send", () => {
  const rule = normalizeRule({ kind: "outgoing", address: A2, minGrains: 0n }, N);
  const prev = new Map([[A2, snap(350010000, [])]]);
  const next = new Map([[A2, snap(100000000, [TX1])]]);
  const { events } = evaluateRules({
    snapshots: next, prev, rules: [rule],
    newTxDetails: new Map([[TX1, FULL_TX]]), txDetails: new Map(), tipHeight: 120105, nowMs: 1000,
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "outgoing");
  assert.equal(events[0].grains, "350010000");
});

test("evaluateRules: balance-above edge-triggers and re-arms", () => {
  const rule = normalizeRule({ kind: "balance-above", address: A1, thresholdGrains: parsePRL("1") }, N);
  const low = new Map([[A1, snap(50000000, [])]]);   // 0.5 PRL
  const high = new Map([[A1, snap(200000000, [])]]); // 2 PRL
  const run = (p, n) => evaluateRules({ snapshots: n, prev: p, rules: [rule], newTxDetails: new Map(), txDetails: new Map(), tipHeight: 1, nowMs: 1 }).events;
  assert.equal(run(low, high).length, 1);   // cross up -> fire
  assert.equal(run(high, high).length, 0);  // stays above -> silent
  assert.equal(run(high, low).length, 0);   // cross back down -> re-arm, silent
  assert.equal(run(low, high).length, 1);   // cross up again -> fire again
});

test("evaluateRules: tx-confirmed fires at target, re-arms below", () => {
  const rule = normalizeRule({ kind: "tx-confirmed", txid: TX1, target: 6 }, N);
  const at5 = new Map([[TX1, { ...FULL_TX, confirmations: 5 }]]);
  const at6 = new Map([[TX1, { ...FULL_TX, confirmations: 6 }]]);
  const run = (d) => evaluateRules({ snapshots: new Map(), prev: new Map(), rules: [rule], newTxDetails: new Map(), txDetails: d, tipHeight: 120106, nowMs: 1 }).events;
  assert.equal(run(at5).length, 0);
  assert.equal(run(at6).length, 1);
  assert.equal(run(at6).length, 0); // already fired -> silent
});

test("evaluateRules: disabled rules never fire", () => {
  const rule = normalizeRule({ kind: "incoming", address: A1, minGrains: 0n, enabled: false }, N);
  const { events } = evaluateRules({
    snapshots: new Map([[A1, snap(1, [TX1])]]), prev: new Map([[A1, snap(0, [])]]),
    rules: [rule], newTxDetails: new Map([[TX1, FULL_TX]]), txDetails: new Map(), tipHeight: 1, nowMs: 1,
  });
  assert.equal(events.length, 0);
});

/* ---------------- export / state ---------------- */

test("eventsToCSV quotes safely", () => {
  const csv = eventsToCSV([{
    id: "ev-1", ts: 1700000000000, ruleId: "r1", ruleLabel: 'say "hi", bob',
    kind: "incoming", address: A1, txid: TX1, grains: "100", confirmations: 3,
    message: 'got "paid", ok',
  }]);
  const lines = csv.split("\n");
  assert.equal(lines.length, 2);
  assert.ok(lines[0].startsWith("ts_utc,kind,"));
  assert.ok(lines[1].includes('"say ""hi"", bob"'));
});

test("serialize/deserialize round-trips and validates", () => {
  const st = defaultWatchState(N);
  st.watched.push({ address: A1, label: "mine", addedAt: 123 });
  st.rules.push(normalizeRule({ kind: "incoming", address: A1, minGrains: 0n }, N));
  st.events.push({ id: "e1", ts: 1, kind: "incoming" });
  st.blockbook = "https://bb.example";
  const back = deserializeWatchState(serializeWatchState(st), N);
  assert.equal(back.watched[0].address, A1);
  assert.equal(back.rules[0].kind, "incoming");
  assert.equal(back.blockbook, "https://bb.example");
  assert.equal(back.version, WATCH_VERSION);
});

test("deserializeWatchState refuses duplicates and bad rules", () => {
  assert.throws(() => deserializeWatchState(JSON.stringify({
    watched: [{ address: A1 }, { address: A1 }], rules: [],
  }), N), /duplicate/);
  assert.throws(() => deserializeWatchState(JSON.stringify({
    watched: [], rules: [{ kind: "incoming", address: "junk" }],
  }), N), /WATCH REFUSED/);
  assert.throws(() => deserializeWatchState(JSON.stringify({
    watched: [{ address: "junk" }], rules: [],
  }), N), /WATCH REFUSED/);
});

test("defaultWatchState carries the network blockbook default", () => {
  assert.equal(defaultWatchState(N).blockbook, N.blockbook);
  assert.equal(defaultWatchState(TN).blockbook, "");
});
