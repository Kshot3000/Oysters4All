import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { scanDeposits, scanWithdrawals, MAX_DEPOSIT_PAGES_PER_SCAN } from "../operator.js";
import { StateStore } from "../state.js";

const VAULT = "prl1vault0000000000000000000000000000000000000000";
const FEE = "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d";
const EVM_USER = "0x4b6f3BC697D9dAF3e8dE182aEc56eD208B9087f1";

function opReturnHex(text) {
  const data = Buffer.from(text, "utf8");
  return "6a" + data.length.toString(16).padStart(2, "0") + data.toString("hex");
}

function makeTx(confirmations) {
  return {
    txid: "dd".repeat(32),
    confirmations,
    vout: [
      { n: 0, value: 1.0, scriptPubKey: { addresses: [VAULT], type: "witness_v0_keyhash" } },
      { n: 1, value: 0.0025, scriptPubKey: { addresses: [FEE], type: "witness_v0_keyhash" } },
      { n: 2, value: 0, scriptPubKey: { hex: opReturnHex(`wprl:${EVM_USER}`), type: "nulldata" } },
    ],
  };
}

function makeOp({ txs = [], mints = [], usedTxids = new Set() } = {}) {
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wprl-op-")), "state.json");
  const state = new StateStore(stateFile);
  const cfg = {
    vaultAddress: VAULT,
    prlFeeAddress: FEE,
    minConfirmations: 6,
    minDepositGrains: 100000n,
    feeBps: 25,
    deployBlock: 100,
  };
  const pearld = {
    searchRawTransactions: async () => txs,
    getRawTransaction: async (txid) => {
      const t = txs.find((x) => (x.txid ?? x.hash) === txid);
      if (!t) { const e = new Error("No information available about transaction"); e.code = -5; throw e; }
      return t;
    },
  };
  const bridge = {
    usedPearlTxids: async (b32) => usedTxids.has(b32),
    mintDeposit: async (user, amountWei, txid) => {
      mints.push({ user, amountWei, txid });
      return { wait: async () => ({ hash: "0xmint" }) };
    },
    queryFilter: async () => [],
    filters: { WithdrawRequested: () => "topic" },
  };
  return { op: { cfg, pearld, bridge, state }, state, mints };
}

test("too-young deposit is parked in pending and minted after it confirms", async () => {
  const young = makeTx(2);
  const { op, state, mints } = makeOp({ txs: [young] });

  const r1 = await scanDeposits(op);
  assert.equal(r1.minted, 0);
  assert.deepEqual(Object.keys(state.get("pearl:pending", {})), [young.txid]);
  assert.ok(!state.has(`deposit:${young.txid}`)); // NOT marked done

  // The tx confirms; the recheck path picks it up via getrawtransaction.
  young.confirmations = 10;
  const r2 = await scanDeposits(op);
  assert.equal(r2.minted, 1);
  assert.equal(r2.rechecked, 1);
  assert.deepEqual(mints[0].user, EVM_USER);
  assert.equal(mints[0].amountWei, 1_000_000_000_000_000_000n);
  assert.deepEqual(state.get("pearl:pending", {}), {});
  assert.ok(state.has(`deposit:${young.txid}`));
});

test("a pearld that ignores skip cannot loop a deposit scan forever — the pass caps and the next poll resumes", async () => {
  const batch = Array.from({ length: 100 }, (_, i) => ({ txid: String(i).padStart(64, "0"), confirmations: 10, vout: [] }));
  const { op, state } = makeOp({});
  let calls = 0;
  op.pearld.searchRawTransactions = async () => {
    calls++;
    if (calls > MAX_DEPOSIT_PAGES_PER_SCAN + 50) throw new Error("scan did not terminate");
    return batch; // hostile/broken: same full batch whatever skip says
  };
  const r1 = await scanDeposits(op);
  assert.equal(calls, MAX_DEPOSIT_PAGES_PER_SCAN);
  assert.equal(r1.capped, true);
  assert.equal(r1.pages, MAX_DEPOSIT_PAGES_PER_SCAN);
  assert.equal(state.get("pearl:skip"), MAX_DEPOSIT_PAGES_PER_SCAN * 100); // cursor persisted — nothing lost
  calls = 0; // the sentinel above is per-scan
  const r2 = await scanDeposits(op); // next poll resumes from the persisted cursor
  assert.equal(r2.capped, true);
  assert.equal(state.get("pearl:skip"), MAX_DEPOSIT_PAGES_PER_SCAN * 200);
});

test("an honest multi-page history still completes in one uncapped pass", async () => {
  const all = Array.from({ length: 250 }, (_, i) => ({ txid: String(i).padStart(64, "0"), confirmations: 10, vout: [] }));
  const { op, state } = makeOp({});
  op.pearld.searchRawTransactions = async (addr, skip, count) => all.slice(skip, skip + count);
  const r = await scanDeposits(op);
  assert.equal(r.capped, false);
  assert.equal(r.pages, 3);
  assert.equal(r.scanned, 250);
  assert.equal(state.get("pearl:skip"), 250);
});

test("a JSON array state file is an empty store whose records actually persist", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wprl-op-")), "state.json");
  fs.writeFileSync(file, "[]");
  const s1 = new StateStore(file);
  s1.set("withdraw:7", { nonce: "7", netGrains: "5" });
  const s2 = new StateStore(file);
  assert.ok(s2.has("withdraw:7")); // string keys must survive a restart
  assert.equal(s2.get("withdraw:7").netGrains, "5");
});

test("a wrong-shape pending value is repaired — a too-young deposit still parks and later mints", async () => {
  const young = makeTx(2);
  const { op, state, mints } = makeOp({ txs: [young] });
  state.set("pearl:pending", 123); // not a { txid: {firstSeen} } map
  const r1 = await scanDeposits(op); // must not throw on p[txid] =
  assert.equal(r1.minted, 0);
  assert.deepEqual(Object.keys(state.get("pearl:pending", {})), [young.txid]);
  young.confirmations = 10;
  const r2 = await scanDeposits(op);
  assert.equal(r2.minted, 1);
  assert.equal(mints.length, 1);
});

test("a null pending entry for a vanished tx does not crash the recheck loop", async () => {
  const { op, state } = makeOp({ txs: [] });
  const deadTxid = "ee".repeat(32);
  state.set("pearl:pending", { [deadTxid]: null });
  const r = await scanDeposits(op); // getRawTransaction throws; firstSeen of null must not
  assert.equal(r.rechecked, 0);
  assert.ok(state.get("pearl:pending", {})[deadTxid]); // repaired and kept for retry
});

test("a non-numeric skip cursor restarts the deposit scan from 0 instead of stalling", async () => {
  const tx = makeTx(10);
  const { op, state, mints } = makeOp({ txs: [tx] });
  state.set("pearl:skip", "not-a-number");
  const r = await scanDeposits(op);
  assert.equal(r.minted, 1);
  assert.equal(mints.length, 1);
  assert.equal(state.get("pearl:skip"), 1);
});

test("a non-numeric lastEventBlock cursor falls back to the deploy block", async () => {
  const { op, state } = makeOp({});
  state.set("base:lastEventBlock", "abc");
  op.oyster = { sendToAddress: async () => "ptx" };
  op.provider = { getBlockNumber: async () => 1000 };
  const ranges = [];
  op.bridge.queryFilter = async (_f, from, to) => { ranges.push([from, to]); return []; };
  const r = await scanWithdrawals(op);
  assert.equal(r.events, 0);
  assert.ok(ranges.length > 0); // the scan actually ran
  assert.equal(ranges[0][0], 100); // deployBlock, not NaN
  assert.ok(Number.isInteger(state.get("base:lastEventBlock")));
});

test("already-used txid on-chain is not re-minted", async () => {
  const tx = makeTx(10);
  const usedTxids = new Set(["0x" + tx.txid]);
  const { op, mints } = makeOp({ txs: [tx], usedTxids });
  const r = await scanDeposits(op);
  assert.equal(r.minted, 0);
  assert.equal(mints.length, 0);
});

test("scanWithdrawals defers events inside the reorg margin, never loses them", async () => {
  const { op, state } = makeOp({});
  const oysterCalls = [];
  op.oyster = { sendToAddress: async (a, g) => { oysterCalls.push([a, g]); return "ptx"; } };
  // Event at block 100, chain tip at 101 -> inside the 2-block margin.
  const ev = {
    user: "0x1111111111111111111111111111111111111111",
    prlRecipient: FEE,
    netWei: 997500000000000000n,
    netGrains: 99750000n,
    feeWei: 2500000000000000n,
    nonce: 1n,
    blockNumber: 100,
    txHash: "0xabc",
  };
  const { decodeWithdrawEvent } = await import("../withdraw.js");
  const { ethers } = await import("ethers");
  const iface = new ethers.Interface([
    "event WithdrawRequested(address indexed user, string prlRecipient, uint256 netWei, uint256 netGrains, uint256 feeWei, uint256 nonce)",
  ]);
  const log = {
    blockNumber: 100,
    transactionHash: "0xabc",
    topics: [iface.getEvent("WithdrawRequested").topicHash, ethers.zeroPadValue(ev.user, 32)],
    data: new ethers.AbiCoder().encode(
      ["string", "uint256", "uint256", "uint256", "uint256"],
      [ev.prlRecipient, ev.netWei, ev.netGrains, ev.feeWei, ev.nonce]
    ),
  };
  const decoded = decodeWithdrawEvent(log, iface);
  op.bridge.queryFilter = async (f, from, to) => {
    assert.ok(from <= 100 && to >= 100, `event block must be in range (got ${from}..${to})`);
    return [log];
  };
  op.provider = { getBlockNumber: async () => 101 }; // tip: event block + 1 -> margin
  // Patch decodeWithdrawEvent usage: scanWithdrawals decodes internally; feed via queryFilter.
  // (decode path already covered in withdraw.test.js; here we assert cursor behavior.)
  const r1 = await scanWithdrawals(op);
  assert.equal(r1.events, 0); // deferred: block 100 is within 2 of tip 101
  assert.ok(r1.pendingBlocks > 0);
  assert.equal(oysterCalls.length, 0);
  assert.equal(state.get("base:lastEventBlock"), undefined); // cursor untouched — event retried next poll

  op.provider = { getBlockNumber: async () => 103 }; // tip moved: block 100 now safe
  const r2 = await scanWithdrawals(op);
  assert.equal(r2.events, 1);
  assert.equal(r2.released, 1);
  assert.deepEqual(oysterCalls, [[FEE, 99750000n]]);
  assert.ok(decoded.nonce === 1n);
});
