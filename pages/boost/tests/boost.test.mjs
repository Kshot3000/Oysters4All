// Pearl Boost node core tests — pinned vectors, exact fee math, BIP-125
// boundary, and a real crypto round-trip through the audited Sign core.
// Usage: node --no-warnings --loader ./tests/loader.mjs tests/boost.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_RBF_SEQUENCE, NON_RBF_SEQUENCE, FINAL_SEQUENCE,
  MIN_RELAY_PER_KB_GRAINS, DUST_GRAINS, MAX_REPLACEMENT_EVICTIONS,
  signalsRbf, estimateMinRelayFee, packageFeeRate, diagnoseTx,
  vSizeFromRawHex, planCpfp, planRbf, verifyPackageClaim,
  pearldBroadcastCmd,
  Sign,
} from "../src/index.js";
import { NETWORKS, walletFromPriv, walletToWIF, walletFromWIF, p2trScriptPubKey, tweakKeypath, keypathTxVBytes } from "../../sign/src/crypto.js";

const MAINNET = NETWORKS.mainnet;

/* ---------- pinned policy constants (pearld source) ---------- */

test("policy constants match pearld mempool source", () => {
  assert.equal(MAX_RBF_SEQUENCE, 0xfffffffd); // node/mempool/mempool.go
  assert.equal(MAX_REPLACEMENT_EVICTIONS, 100);
  assert.equal(MIN_RELAY_PER_KB_GRAINS, 1000); // DefaultMinRelayTxFee
  assert.equal(DUST_GRAINS, 546);
});

/* ---------- BIP-125 sequence boundary ---------- */

test("signalsRbf: boundary pinned — 0xfffffffd signals, 0xfffffffe does not", () => {
  assert.equal(signalsRbf([0xfffffffd]), true);
  assert.equal(signalsRbf([NON_RBF_SEQUENCE]), false);
  assert.equal(signalsRbf([FINAL_SEQUENCE]), false);
  assert.equal(signalsRbf([0xffffffff, 0xfffffffd]), true); // one opt-in is enough
  assert.equal(signalsRbf([0xfffffffe, 0xffffffff]), false);
  assert.equal(signalsRbf([]), false);
  assert.equal(signalsRbf([0x00000000]), true); // min sequence signals
});

/* ---------- min-relay fee: exact upstream mirror ---------- */

test("estimateMinRelayFee mirrors calcMinRequiredTxRelayFee", () => {
  // (size * 1000) / 1000 with the 1000-grain floor when the result is 0
  assert.equal(estimateMinRelayFee(140), 140);
  assert.equal(estimateMinRelayFee(1000), 1000);
  assert.equal(estimateMinRelayFee(0), 1000); // floor kicks in
  assert.equal(estimateMinRelayFee(1), 1); // floor(1*1000/1000) = 1, no floor needed
  assert.equal(estimateMinRelayFee(2500), 2500);
});

/* ---------- package feerate: pinned computation ---------- */

test("packageFeeRate: pinned vector (10000gr/140vB + 5000gr/100vB = 62.5)", () => {
  const p = packageFeeRate(10000, 140, 5000, 100);
  assert.equal(p.num, 15000n);
  assert.equal(p.den, 240n);
  assert.equal(p.rate, 62.5);
});

test("packageFeeRate refuses degenerate input", () => {
  assert.throws(() => packageFeeRate(1, 0, 1, 0), /vsize must be positive/);
});

/* ---------- child tx vBytes shape ---------- */

test("keypath child tx is exactly 111 vBytes (1 in, 1 out)", () => {
  assert.equal(keypathTxVBytes(1, 1), 111);
});

/* ---------- CPFP planning: pinned ---------- */

test("planCpfp: pinned vector — parent 1000gr/140vB, target 10gr/vB, child 111vB", () => {
  const plan = planCpfp({
    parentFeeGrains: 1000, parentVBytes: 140, targetRate: 10,
    childVBytes: 111, spendValueGrains: 100000,
  });
  // package fee needed = ceil(10 * 251) = 2510; child pays 2510 - 1000 = 1510
  assert.equal(plan.childFee, 1510);
  assert.equal(plan.childOutValue, 100000 - 1510);
  assert.equal(plan.packageRate, 10); // (1000 + 1510) / 251 = 10 exactly
  assert.equal(plan.childVBytes, 111);
});

test("planCpfp refuses when the target is already met by the parent alone", () => {
  // parent rate 1000/140 = 7.14; target 3 needs only 753 total < 1000 paid
  assert.throws(
    () => planCpfp({ parentFeeGrains: 1000, parentVBytes: 140, targetRate: 3, childVBytes: 111, spendValueGrains: 100000 }),
    /already met/
  );
});

test("planCpfp refuses dust child output", () => {
  // childFee = 1510; output value 2000 -> 490 < 546 dust
  assert.throws(
    () => planCpfp({ parentFeeGrains: 1000, parentVBytes: 140, targetRate: 10, childVBytes: 111, spendValueGrains: 2000 }),
    /dust/
  );
});

test("planCpfp validates inputs", () => {
  assert.throws(() => planCpfp({ parentFeeGrains: -1, parentVBytes: 140, targetRate: 10, childVBytes: 111, spendValueGrains: 100 }), /positive/);
});

/* ---------- RBF planning: pinned ---------- */

test("planRbf: pinned vector — 1000gr/140vB -> 10gr/vB", () => {
  const plan = planRbf({ oldFeeGrains: 1000, oldVBytes: 140, targetRate: 10, feeSourceValue: 50000 });
  assert.equal(plan.oldRate, 1000 / 140);
  assert.equal(plan.newFee, 1400); // ceil(10 * 140)
  assert.equal(plan.feeDelta, 400);
  assert.equal(plan.minRelayEstimate, 140); // floor(140*1000/1000)
  assert.equal(plan.newFeeSourceValue, 49600);
});

test("planRbf refuses non-strict feerate increase (pearld rule)", () => {
  assert.throws(
    () => planRbf({ oldFeeGrains: 1000, oldVBytes: 140, targetRate: 1000 / 140, feeSourceValue: 50000 }),
    /STRICTLY greater/
  );
  assert.throws(
    () => planRbf({ oldFeeGrains: 1000, oldVBytes: 140, targetRate: 7, feeSourceValue: 50000 }),
    /STRICTLY greater/
  );
});

test("planRbf refuses when absolute fee fails the min-relay rule", () => {
  // target 7.2 -> newFee 1008; need > 1000 + 140 = 1140
  assert.throws(
    () => planRbf({ oldFeeGrains: 1000, oldVBytes: 140, targetRate: 7.2, feeSourceValue: 50000 }),
    /min-relay/
  );
});

test("planRbf refuses dust fee-source output", () => {
  // newFee = ceil(50*140) = 7000; feeDelta = 6000; 6400 - 6000 = 400 < 546
  assert.throws(
    () => planRbf({ oldFeeGrains: 1000, oldVBytes: 140, targetRate: 50, feeSourceValue: 6400 }),
    /dust/
  );
});

/* ---------- vSizeFromRawHex: pinned ---------- */

test("vSizeFromRawHex: pinned 94 vB unsigned P2TR tx", () => {
  // version(4) + vinCount(1) + [txid(32)+vout(4)+scriptLen(1)+seq(4)]
  // + voutCount(1) + [value(8)+scriptLen(1)+spk(34)] + locktime(4) = 94
  const spk = "51" + "20" + "11".repeat(32);
  const hex = "02000000" + "01" + "00".repeat(32) + "00000000" + "00" + "ffffffff"
    + "01" + "1027000000000000" + "22" + spk + "00000000";
  assert.equal(vSizeFromRawHex(hex), 94);
});

test("vSizeFromRawHex rejects garbage", () => {
  assert.throws(() => vSizeFromRawHex("zz"), /invalid tx hex/);
  assert.throws(() => vSizeFromRawHex("0200"), /truncated/);
});

/* ---------- diagnoseTx: pinned Blockbook fixture ---------- */

const BB_FIXTURE = {
  txid: "aa".repeat(32),
  confirmations: 0,
  fees: "1000",
  vsize: 140,
  vin: [
    { n: 0, txid: "bb".repeat(32), vout: 0, sequence: 0xfffffffd, value: "60000", addresses: ["prl1pqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq"] },
    { n: 1, txid: "cc".repeat(32), vout: 1, sequence: 0xffffffff, value: "50000", addresses: [] },
  ],
  vout: [
    { n: 0, value: "100000", spent: false, addresses: ["prl1pzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"] },
    { n: 1, value: "9000", spent: false, addresses: [] },
  ],
};

test("diagnoseTx: unconfirmed, RBF signaled, exact feerate", () => {
  const d = diagnoseTx(BB_FIXTURE);
  assert.equal(d.confirmed, false);
  assert.equal(d.confirmations, 0);
  assert.equal(d.feeGrains, 1000);
  assert.equal(d.vSize, 140);
  assert.equal(d.vSizeSource, "blockbook");
  assert.equal(d.vSizeEstimated, false);
  assert.equal(d.feeRate, 1000 / 140);
  assert.equal(d.rbfSignaled, true); // 0xfffffffd <= MaxRBFSequence
  assert.equal(d.nIn, 2);
  assert.equal(d.nOut, 2);
  assert.equal(d.vout[0].spent, false);
});

test("diagnoseTx: confirmed tx is classified confirmed", () => {
  const d = diagnoseTx({ ...BB_FIXTURE, confirmations: 3 });
  assert.equal(d.confirmed, true);
});

test("diagnoseTx: non-signaling sequences -> no RBF", () => {
  const tx = structuredClone(BB_FIXTURE);
  tx.vin[0].sequence = 0xfffffffe;
  assert.equal(diagnoseTx(tx).rbfSignaled, false);
});

test("diagnoseTx: estimate path flagged when backend lacks vsize", () => {
  const tx = structuredClone(BB_FIXTURE);
  delete tx.vsize;
  const d = diagnoseTx(tx);
  assert.equal(d.vSizeEstimated, true);
  assert.equal(d.vSize, 10 + 41 * 2 + 43 * 2);
  assert.match(d.vSizeSource, /estimate/);
});

test("diagnoseTx refuses fee-less payload", () => {
  assert.throws(() => diagnoseTx({ confirmations: 0, vin: [], vout: [] }), /fee/);
});

/* ---------- real crypto: WIF -> address, child build, re-verify ---------- */

const FIX_PRIV_HEX = "11".repeat(32);

test("WIF -> tweaked P2TR address (pinned)", () => {
  const w = walletFromPriv(FIX_PRIV_HEX, MAINNET);
  const addr = w.address;
  assert.match(addr, /^prl1p/);
  // pinned: recompute from WIF form must match
  const wif = walletToWIF(w.priv, MAINNET);
  const w2 = walletFromWIF(wif, MAINNET);
  assert.equal(w2.address, addr);
  globalThis.__BOOST_FIXTURE = { addr, internalXOnly: w.internalXOnly, priv: w.priv };
});

test("signed child tx re-verifies; tampered copy does not", () => {
  const { internalXOnly, priv } = globalThis.__BOOST_FIXTURE;
  const spk = p2trScriptPubKey(tweakKeypath(internalXOnly).tweakedX);
  const prevTxid = "dd".repeat(32);
  const built = Sign.buildKeypathTxEx(
    MAINNET,
    [{ txid: prevTxid, vout: 0, value: 100000, spk, priv, internalXOnly }],
    [{ program: tweakKeypath(internalXOnly).tweakedX, value: 98490 }],
    Sign.SIGHASH_DEFAULT,
    0xfffffffd
  );
  assert.ok(/^[0-9a-f]+$/.test(built.hex));
  const ok = Sign.verifySignedTx(MAINNET, built.hex, [{ value: 100000, spk }]);
  assert.equal(ok.length, 1);
  assert.equal(ok[0].ok, true);

  // tamper: flip one output-value byte -> signature must fail re-verification
  const tampered = built.hex.slice(0, 120) + (built.hex[120] === "0" ? "1" : "0") + built.hex.slice(121);
  const bad = Sign.verifySignedTx(MAINNET, tampered, [{ value: 100000, spk }]);
  assert.equal(bad[0].ok, false);
});

/* ---------- verifier ---------- */

test("verifyPackageClaim: pinned PROVEN and NOT PROVEN", () => {
  const proven = verifyPackageClaim(
    { feeGrains: 1000, vBytes: 140 }, { feeGrains: 1510, vBytes: 111 }, 10
  );
  assert.equal(proven.verdict, "PROVEN");
  assert.equal(proven.proven, true);
  assert.equal(proven.computedRate, 2510 / 251);
  assert.equal(proven.num, 2510n);

  const notProven = verifyPackageClaim(
    { feeGrains: 1000, vBytes: 140 }, { feeGrains: 1510, vBytes: 111 }, 10.5
  );
  assert.equal(notProven.verdict, "NOT PROVEN");
  assert.equal(notProven.proven, false);
});

test("verifyPackageClaim refuses bad claims", () => {
  assert.throws(() => verifyPackageClaim({ feeGrains: 1, vBytes: 1 }, { feeGrains: 1, vBytes: 1 }, -1), /non-negative/);
});

/* ---------- broadcast helper ---------- */

test("pearldBroadcastCmd emits the sendrawtransaction one-liner", () => {
  const cmd = pearldBroadcastCmd("deadbeef");
  assert.match(cmd, /sendrawtransaction/);
  assert.match(cmd, /127\.0\.0\.1:44107/);
  assert.match(cmd, /deadbeef/);
});
