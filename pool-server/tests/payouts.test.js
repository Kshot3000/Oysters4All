import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Payouts } from "../src/payouts.js";

const W1 = "prl1" + "a".repeat(58); // shape-only; Payouts doesn't validate addresses
const W2 = "prl1" + "b".repeat(58);

function pplns(opts = {}) {
  return new Payouts({ windowShares: 100, poolFeePct: 1.0, finderBonusPct: 0.0, stateFile: null, ...opts });
}

test("PPLNS splits a block reward by share weight, exact to the grain", () => {
  const p = pplns();
  p.addShare({ wallet: W1, diff: 1, solo: false, height: 1, at: 1 });
  p.addShare({ wallet: W2, diff: 3, solo: false, height: 1, at: 2 });
  const round = p.creditConfirmedBlock({ height: 1, rewardGrains: 1000n, finderWallet: W2, solo: false, at: 3 });
  // fee 1% = 10 grains; distributable 990 -> 1:3 split = 247.5 : 742.5
  // largest remainder: 248 + 742 = 990.
  assert.equal(round.fee, "10");
  const b = p.balancesView();
  const w1 = b.find((x) => x.wallet === W1);
  const w2 = b.find((x) => x.wallet === W2);
  assert.equal(w1.unpaidGrains, "248");
  assert.equal(w2.unpaidGrains, "742");
  // Books balance: fee + payouts == reward.
  const paid = round.payouts.reduce((a, r) => a + BigInt(r.grains), 0n);
  assert.equal(paid + BigInt(round.fee), 1000n);
  assert.equal(w2.blocks, 1);
});

test("PPLNS window only counts the trailing N shares", () => {
  const p = pplns({ windowShares: 2 });
  p.addShare({ wallet: W1, diff: 100, solo: false, height: 1, at: 1 });
  p.addShare({ wallet: W1, diff: 100, solo: false, height: 1, at: 2 });
  p.addShare({ wallet: W2, diff: 1, solo: false, height: 1, at: 3 }); // pushes one W1 share out
  assert.equal(p.window.length, 2);
  const round = p.creditConfirmedBlock({ height: 1, rewardGrains: 1010n, finderWallet: W2, solo: false, at: 4 });
  const paid = Object.fromEntries(round.payouts.map((r) => [r.wallet, BigInt(r.grains)]));
  // window weights: W1=100, W2=1 -> distributable 1000 (fee 10): 990.099... / 9.9...
  assert.ok(paid[W1] > paid[W2]);
  assert.equal(paid[W1] + paid[W2] + BigInt(round.fee), 1010n);
});

test("solo blocks pay the finder directly, bypassing PPLNS", () => {
  const p = pplns();
  p.addShare({ wallet: W1, diff: 50, solo: false, height: 1, at: 1 });
  const round = p.creditConfirmedBlock({ height: 1, rewardGrains: 1000n, finderWallet: W2, solo: true, at: 2 });
  const b = p.balancesView();
  const w2 = b.find((x) => x.wallet === W2);
  assert.equal(w2.unpaidGrains, "990"); // reward minus 1% fee
  assert.equal(round.payouts.length, 1);
});

test("finder bonus goes to the finder on top of PPLNS", () => {
  const p = pplns({ finderBonusPct: 10.0 });
  p.addShare({ wallet: W1, diff: 1, solo: false, height: 1, at: 1 });
  const round = p.creditConfirmedBlock({ height: 1, rewardGrains: 1000n, finderWallet: W1, solo: false, at: 2 });
  assert.equal(round.bonus, "100");
  const w1 = p.balancesView().find((x) => x.wallet === W1);
  assert.equal(w1.unpaidGrains, "990"); // 890 PPLNS + 100 bonus
});

test("duePayouts threshold and markPaid move unpaid -> paid", () => {
  const p = pplns();
  p.addShare({ wallet: W1, diff: 1, solo: false, height: 1, at: 1 });
  p.creditConfirmedBlock({ height: 1, rewardGrains: 200_000_000n, finderWallet: W1, solo: false, at: 2 });
  assert.equal(p.duePayouts("100000000").length, 1);
  assert.equal(p.duePayouts("999999999999").length, 0);
  const r = p.markPaid(W1, 198000000n - 198000000n % 2n, "txid-1");
  assert.equal(r.txid, "txid-1");
  const w1 = p.balancesView().find((x) => x.wallet === W1);
  assert.equal(BigInt(w1.unpaidGrains) + BigInt(198000000n - 198000000n % 2n), 198000000n);
  assert.throws(() => p.markPaid(W1, 10n ** 30n), /exceeds unpaid/);
});

test("state persists across restarts", () => {
  const dir = mkdtempSync(join(tmpdir(), "pool-payouts-"));
  const file = join(dir, "payouts.json");
  try {
    const p1 = new Payouts({ windowShares: 10, poolFeePct: 1.0, stateFile: file });
    p1.addShare({ wallet: W1, diff: 5, solo: false, height: 9, at: 1 });
    p1.creditConfirmedBlock({ height: 9, rewardGrains: 500n, finderWallet: W1, solo: false, at: 2 });
    const p2 = new Payouts({ windowShares: 10, poolFeePct: 1.0, stateFile: file });
    assert.equal(p2.blocksFound, 1);
    assert.equal(p2.window.length, 1);
    assert.equal(p2.balancesView()[0].unpaidGrains, "495");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recordPendingBlock: candidate recorded WITHOUT crediting any balances", () => {
  const p = pplns();
  p.addShare({ wallet: W1, diff: 1, solo: false, height: 1, at: 1 });
  p.addShare({ wallet: W2, diff: 3, solo: false, height: 1, at: 2 });
  const entry = p.recordPendingBlock({ height: 1, rewardGrains: 1000n, finderWallet: W2, solo: false, at: 3 });
  assert.equal(entry.status, "awaiting-submission");
  assert.equal(entry.credited, false);
  assert.equal(p.blocksFound, 1);
  assert.equal(p.rounds.length, 0, "no round created for an unconfirmed candidate");
  assert.equal(p.listPendingBlocks().length, 1);
  // Balances untouched — nothing spendable until the operator confirms.
  assert.equal(p.balancesView().length, 0, "no balances credited for pending block");
  assert.deepEqual(p.duePayouts(0), []);
});

test("recordPendingBlock persists across restarts", () => {
  const dir = mkdtempSync(join(tmpdir(), "pearl-pool-pend-"));
  const sf = join(dir, "payouts.json");
  const p1 = pplns({ stateFile: sf });
  p1.recordPendingBlock({ height: 9, rewardGrains: 500n, finderWallet: W1, solo: false, at: 2 });
  const p2 = new Payouts({ stateFile: sf });
  assert.equal(p2.blocksFound, 1);
  assert.equal(p2.listPendingBlocks().length, 1);
  assert.equal(p2.listPendingBlocks()[0].status, "awaiting-submission");
  rmSync(dir, { recursive: true, force: true });
});
