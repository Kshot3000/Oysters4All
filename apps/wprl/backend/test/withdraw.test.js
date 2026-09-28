import test from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { processWithdrawal, validateWithdrawEvent, decodeWithdrawEvent } from "../withdraw.js";

const BRIDGE_ABI = [
  "event WithdrawRequested(address indexed user, string prlRecipient, uint256 netWei, uint256 netGrains, uint256 feeWei, uint256 nonce)",
];
const iface = new ethers.Interface(BRIDGE_ABI);

const RECIPIENT = "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d";

function makeEvent({ netWei = 997500000000000000n, prlRecipient = RECIPIENT, nonce = 7n } = {}) {
  const netGrains = netWei / 10_000_000_000n;
  const feeWei = 1_000_000_000_000_000_000n - netWei; // 1 wPRL total
  const log = {
    blockNumber: 12345,
    transactionHash: "0x" + "bb".repeat(32),
    topics: [
      iface.getEvent("WithdrawRequested").topicHash,
      ethers.zeroPadValue("0x1111111111111111111111111111111111111111", 32),
    ],
    data: new ethers.AbiCoder().encode(
      ["string", "uint256", "uint256", "uint256", "uint256"],
      [prlRecipient, netWei, netGrains, feeWei, nonce]
    ),
  };
  return decodeWithdrawEvent(log, iface);
}

function fakeState() {
  const m = new Map();
  return { has: (k) => m.has(k), set: (k, v) => m.set(k, v), get: (k, f) => (m.has(k) ? m.get(k) : f) };
}

test("valid withdrawal sends exact net grains and records the nonce", async () => {
  const ev = makeEvent();
  const calls = [];
  const oyster = { sendToAddress: async (addr, grains) => { calls.push([addr, grains]); return "pearl-txid-1"; } };
  const state = fakeState();
  const res = await processWithdrawal(ev, oyster, state);
  assert.equal(res.pearlTxid, "pearl-txid-1");
  assert.deepEqual(calls, [[RECIPIENT, 99750000n]]); // 0.9975 PRL in grains
  assert.ok(state.has("withdraw:7"));
  // idempotent: second processing is a no-op
  const res2 = await processWithdrawal(ev, oyster, state);
  assert.equal(res2.skipped, true);
  assert.equal(calls.length, 1); // no double-send
});

test("withdrawal to a non-prl1 address is refused before any send", async () => {
  const ev = makeEvent({ prlRecipient: "0x4b6f3BC697D9dAF3e8dE182aEc56eD208B9087f1" });
  let sent = false;
  const oyster = { sendToAddress: async () => { sent = true; return "x"; } };
  await assert.rejects(() => processWithdrawal(ev, oyster, fakeState()), /invalid prl recipient/);
  assert.equal(sent, false);
});

test("wei/grains mismatch in the event is refused", async () => {
  const ev = makeEvent();
  ev.netGrains = 1n; // tampered: does not match netWei
  const oyster = { sendToAddress: async () => "x" };
  await assert.rejects(() => processWithdrawal(ev, oyster, fakeState()), /mismatch/);
});

test("validateWithdrawEvent rejects zero net", () => {
  const ev = makeEvent({ netWei: 0n });
  assert.throws(() => validateWithdrawEvent(ev), /non-positive/);
});

test("decodeWithdrawEvent rejects foreign logs", () => {
  assert.throws(() => decodeWithdrawEvent({ topics: ["0xdead"], data: "0x" }, iface), /not a WithdrawRequested/);
});
