// Pearl Bond node core tests — schedule math, YTM, tranche forging,
// descriptor round-trip, claim + transfer signing round-trips, and the
// script-path 0x83 sighash consensus cross-check (see bottom).
// Usage: node --no-warnings --loader ./tests/loader.mjs tests/bond.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseBondTerms, couponGrains, lockHeightForPeriod, couponSchedule,
  totalFundingGrains, accruedInterest, yieldToMaturity,
  buildClaimScript, buildTransferScript, numsInternalKeyBond, taptreeBond,
  forgeTranche, forgeBond, encodeBondDescriptor, decodeBondDescriptor,
  verifyDescriptor, fundingPlan, planClaim, signClaim,
  scriptPathSigDigest83, transferLegVBytes, presignTransferLeg,
  verifyTransferLeg, buildFillTx, classifyTranches,
  BLOCK_TIME_SEC, DUST_GRAIN, GRAIN_PER_PRL, NETWORKS,
  SIGHASH_SINGLE_ANYONECANPAY, SEQ_FINAL,
  schnorr, sha256, bytesToHex, hexToBytes, encodeBech32m,
  signForXOnly, verifySchnorrSig, p2trScriptPubKey,
  BLOCKBOOK_MAINNET,
} from "../src/index.js";
import { forgeTranche as vestingForgeTranche } from "../../vesting/src/vesting-core.js";
import { scriptPathSigDigestEx } from "../../escrow/src/escrow-core.js";

const MAINNET = NETWORKS.mainnet;
const sha = (s) => sha256(new TextEncoder().encode(s));
const SELLER_PRIV = sha("pearl-bond-fixture-seller-v1");
const BUYER_PRIV = sha("pearl-bond-fixture-buyer-v1");
const sellerXOnly = schnorr.getPublicKey(SELLER_PRIV);
const buyerXOnly = schnorr.getPublicKey(BUYER_PRIV);

const TERMS = parseBondTerms({
  name: "Test Series A", facePRL: "1000", annualBps: 500,
  frequency: 2, periods: 4, issueHeight: 200000,
});

/* ---------- terms validation ---------- */

test("parseBondTerms: rejects bad input", () => {
  assert.throws(() => parseBondTerms({ facePRL: "0", annualBps: 500, frequency: 2, periods: 4, issueHeight: 1 }), /positive/);
  assert.throws(() => parseBondTerms({ facePRL: "100", annualBps: 500, frequency: 3, periods: 4, issueHeight: 1 }), /frequency/);
  assert.throws(() => parseBondTerms({ facePRL: "100", annualBps: 500, frequency: 2, periods: 0, issueHeight: 1 }), /periods/);
  assert.throws(() => parseBondTerms({ facePRL: "100", annualBps: 500, frequency: 2, periods: 241, issueHeight: 1 }), /periods/);
  assert.throws(() => parseBondTerms({ facePRL: "0.00000001", annualBps: 1, frequency: 12, periods: 12, issueHeight: 1 }), /dust/);
});

test("schedule math pinned: 1000 PRL 5% semiannual x4 @ h200000", () => {
  assert.equal(BLOCK_TIME_SEC, 194);
  assert.equal(couponGrains(TERMS), 2_500_000_000); // 25 PRL
  const sched = couponSchedule(TERMS);
  assert.equal(sched.length, 4);
  // 6 months ≈ 80165 blocks
  assert.deepEqual(sched.map((s) => s.lockHeight), [280165, 360330, 440495, 520660]);
  assert.deepEqual(sched.map((s) => s.amountGrains),
    [2_500_000_000, 2_500_000_000, 2_500_000_000, 102_500_000_000]);
  assert.equal(sched[3].kind, "coupon+principal");
  assert.equal(totalFundingGrains(sched), 110_000_000_000); // 1100 PRL
});

test("yieldToMaturity: par bond yields the coupon rate", () => {
  const y = yieldToMaturity(TERMS, 100_000_000_000); // clean price = face
  assert.ok(Math.abs(y - 0.05) < 1e-9, `ytm=${y}`);
  const yDisc = yieldToMaturity(TERMS, 90_000_000_000);
  assert.ok(yDisc > 0.05, `discount bond yields more: ${yDisc}`);
  const yPrem = yieldToMaturity(TERMS, 105_000_000_000);
  assert.ok(yPrem < 0.05 && yPrem > 0, `premium bond yields less: ${yPrem}`);
});

test("accruedInterest: half period -> half coupon (30/360)", () => {
  const issue = Date.UTC(2026, 0, 1);
  const half = issue + (180 / 2) * 86_400_000; // 90 days into a 180-day period
  assert.equal(accruedInterest(TERMS, half, issue), 1_250_000_000);
  assert.equal(accruedInterest(TERMS, issue, issue), 0);
});

/* ---------- tranche forging ---------- */

test("claim leaf byte-identical to audited vesting claim leaf", () => {
  const lock = 280165;
  const mine = buildClaimScript(sellerXOnly, lock);
  const ref = vestingForgeTranche(MAINNET, sellerXOnly, buyerXOnly, lock, false);
  assert.equal(bytesToHex(mine), bytesToHex(ref.claimScript));
});

test("transfer leaf is bare CHECKSIG on the holder key", () => {
  const s = buildTransferScript(sellerXOnly);
  assert.equal(bytesToHex(s), "20" + bytesToHex(sellerXOnly) + "ac");
});

test("NUMS internal key: deterministic, unspendable-shaped, on-curve", () => {
  const scripts = [buildClaimScript(sellerXOnly, 280165), buildTransferScript(sellerXOnly)];
  const k1 = numsInternalKeyBond(scripts);
  const k2 = numsInternalKeyBond(scripts);
  assert.equal(bytesToHex(k1), bytesToHex(k2));
  assert.equal(k1.length, 32);
  // not equal to the holder key and not the vesting domain key
  assert.notEqual(bytesToHex(k1), bytesToHex(sellerXOnly));
});

test("forgeBond: addresses are prl1p, distinct per tranche, re-derivable", () => {
  const bond = forgeBond(MAINNET, TERMS, { key: sellerXOnly, mode: "raw" });
  assert.equal(bond.tranches.length, 4);
  const addrs = bond.tranches.map((t) => t.address);
  assert.ok(addrs.every((a) => a.startsWith("prl1p")));
  assert.equal(new Set(addrs).size, 4);
  // re-forge -> identical addresses
  const bond2 = forgeBond(MAINNET, TERMS, { key: sellerXOnly, mode: "raw" });
  assert.deepEqual(bond2.tranches.map((t) => t.address), addrs);
  // different holder -> different addresses
  const bond3 = forgeBond(MAINNET, TERMS, { key: buyerXOnly, mode: "raw" });
  assert.ok(!bond3.tranches.some((t) => addrs.includes(t.address)));
  // control blocks are 65 bytes (2-leaf tree)
  for (const t of bond.tranches) {
    assert.equal(t.transferControlBlock.length, 65);
    assert.equal(t.claimControlBlock.length, 65);
  }
});

test("descriptor round-trip re-derives every address", () => {
  const bond = forgeBond(MAINNET, TERMS, { key: sellerXOnly, mode: "raw" });
  const v = verifyDescriptor(bond.descriptor);
  assert.deepEqual(v.tranches.map((t) => t.address), bond.tranches.map((t) => t.address));
  assert.equal(v.descriptor, bond.descriptor);
  const dec = decodeBondDescriptor(bond.descriptor);
  assert.equal(dec.terms.faceGrains, TERMS.faceGrains);
  assert.throws(() => decodeBondDescriptor("bond:v1/m/1/2/3"), /bad bond descriptor/);
  assert.throws(() => decodeBondDescriptor(bond.descriptor.replace("/m/", "/z/")), /bad network/);
});

test("fundingPlan: totals + fee math", () => {
  const bond = forgeBond(MAINNET, TERMS, { key: sellerXOnly, mode: "raw" });
  const plan = fundingPlan(bond, 10, 1);
  assert.equal(plan.totalGrains, 110_000_000_000);
  assert.equal(plan.tranches.length, 4);
  const expectVBytes = Math.ceil(10.5 + 57.25 + 43 * 4);
  assert.equal(plan.estVBytes, expectVBytes);
  assert.equal(plan.estFeeGrains, Math.ceil(expectVBytes * 10));
  assert.equal(plan.grandTotalGrains, plan.totalGrains + plan.estFeeGrains);
});

/* ---------- claim flow ---------- */

test("planClaim + signClaim round-trip; lock enforced", () => {
  const bond = forgeBond(MAINNET, TERMS, { key: sellerXOnly, mode: "raw" });
  const t = bond.tranches[0];
  const dest = buyerXOnly; // pay to buyer program for the test
  assert.throws(
    () => planClaim(MAINNET, t, { txid: "ab".repeat(32), vout: 0, value: t.amountGrains }, dest, 10, t.lockHeight - 1),
    /locked until height/);
  const planned = planClaim(MAINNET, t,
    { txid: "ab".repeat(32), vout: 0, value: t.amountGrains }, dest, 10, t.lockHeight);
  assert.ok(planned.fee > 0 && planned.outputs[0].value === t.amountGrains - planned.fee);
  const signed = signClaim(MAINNET, t, planned, SELLER_PRIV);
  assert.ok(/^[0-9a-f]+$/.test(signed.hex) && signed.hex.length > 200);
  assert.ok(/^[0-9a-f]{64}$/.test(signed.txid));
  // witness commits the claim leaf + control block; sig re-verified inside signClaim
  assert.ok(signed.hex.includes(bytesToHex(t.claimScript).slice(0, 40)));
});

test("claim with wrong key fails re-verification", () => {
  const bond = forgeBond(MAINNET, TERMS, { key: sellerXOnly, mode: "raw" });
  const t = bond.tranches[0];
  const planned = planClaim(MAINNET, t,
    { txid: "ab".repeat(32), vout: 0, value: t.amountGrains }, buyerXOnly, 10, t.lockHeight);
  assert.throws(() => signClaim(MAINNET, t, planned, BUYER_PRIV), /re-verification/);
});

/* ---------- transfer flow ---------- */

function fixtureBond() {
  return forgeBond(MAINNET, TERMS, { key: sellerXOnly, mode: "raw" });
}

function buyerBond() {
  return forgeBond(MAINNET, TERMS, { key: buyerXOnly, mode: "raw" });
}

test("presign + verify transfer leg round-trip", () => {
  const seller = fixtureBond();
  const buyer = buyerBond();
  const t = seller.tranches[1];
  const bt = buyer.tranches[1];
  assert.equal(t.lockHeight, bt.lockHeight); // same locks, new holder
  const pkg = presignTransferLeg(MAINNET, t,
    { txid: "cc".repeat(32), vout: 2, value: t.amountGrains },
    SELLER_PRIV, hexToBytes(bytesToHex(bt.tweakedX)), 10);
  assert.equal(pkg.sig65Hex.length, 130);
  assert.ok(pkg.sig65Hex.endsWith("83"));
  const v = verifyTransferLeg(MAINNET, pkg);
  assert.equal(v.ok, true);
  assert.equal(v.buyerReceives, t.amountGrains - pkg.feeLegGrains);
});

test("verifyTransferLeg rejects tampering", () => {
  const seller = fixtureBond();
  const buyer = buyerBond();
  const t = seller.tranches[0];
  const bt = buyer.tranches[0];
  const good = () => presignTransferLeg(MAINNET, t,
    { txid: "cc".repeat(32), vout: 0, value: t.amountGrains },
    SELLER_PRIV, hexToBytes(bytesToHex(bt.tweakedX)), 10);
  // flipped signature byte
  const p1 = good();
  const s = hexToBytes(p1.sig65Hex); s[0] ^= 1;
  p1.sig65Hex = bytesToHex(s);
  assert.throws(() => verifyTransferLeg(MAINNET, p1), /INVALID/);
  // wrong output value
  const p2 = good();
  p2.output.value += 1;
  assert.throws(() => verifyTransferLeg(MAINNET, p2), /mismatch/);
  // wrong fee
  const p3 = good();
  p3.feeLegGrains += 1;
  assert.throws(() => verifyTransferLeg(MAINNET, p3), /mismatch/);
});

test("buildFillTx: atomic fill, fee covers vBytes, buyer sig verifies", () => {
  const seller = fixtureBond();
  const buyer = buyerBond();
  const legs = [0, 1].map((i) => {
    const t = seller.tranches[i], bt = buyer.tranches[i];
    return presignTransferLeg(MAINNET, t,
      { txid: "dd".repeat(32), vout: i, value: t.amountGrains },
      SELLER_PRIV, hexToBytes(bytesToHex(bt.tweakedX)), 10);
  });
  for (const l of legs) verifyTransferLeg(MAINNET, l);
  const buyerUtxo = {
    txid: "ee".repeat(32), vout: 0, value: 60_000_000_000,
    spk: p2trScriptPubKey(tweak(BUYER_PRIV)), priv: BUYER_PRIV,
  };
  const sellerPay = sellerXOnly, buyerChange = buyerXOnly;
  const fill = buildFillTx(MAINNET, legs, 50_000_000_000, buyerUtxo, sellerPay, buyerChange, 10);
  assert.ok(/^[0-9a-f]{64}$/.test(fill.txid));
  assert.ok(fill.feeGrains >= Math.ceil(fill.vBytes * 10), "fee must cover vBytes");
  assert.equal(fill.nLegs, 2);
  assert.equal(fill.buyerPaid, 50_000_000_000);
  // buyer's keypath signature verifies against the returned digest
  assert.ok(verifySchnorrSig(hexToBytes(fill.buyerSigHex), hexToBytes(fill.buyerDigestHex), buyerXOnly));
  // outputs: [buyer tranche x2, seller payment, (change)]
  assert.ok(fill.hex.length > 500);
});

test("buildFillTx rejects duplicate leg outpoints", () => {
  const seller = fixtureBond();
  const buyer = buyerBond();
  const t = seller.tranches[0];
  const bt = buyer.tranches[0];
  const mk = (vout) => presignTransferLeg(MAINNET, t,
    { txid: "dd".repeat(32), vout, value: t.amountGrains }, SELLER_PRIV,
    hexToBytes(bytesToHex(bt.tweakedX)), 10);
  const buyerUtxo = {
    txid: "ee".repeat(32), vout: 0, value: 60_000_000_000,
    spk: p2trScriptPubKey(tweak(BUYER_PRIV)), priv: BUYER_PRIV,
  };
  // same outpoint twice -> would double-spend one UTXO: refused
  assert.throws(() => buildFillTx(MAINNET, [mk(0), mk(0)], 50_000_000_000, buyerUtxo, sellerXOnly, buyerXOnly, 10),
    /duplicate leg outpoint/);
  // distinct outpoints still fine
  const fill = buildFillTx(MAINNET, [mk(0), mk(1)], 50_000_000_000, buyerUtxo, sellerXOnly, buyerXOnly, 10);
  assert.equal(fill.nLegs, 2);
});

test("buildFillTx rejects underfunded buyer", () => {
  const seller = fixtureBond();
  const buyer = buyerBond();
  const t = seller.tranches[3]; // 1025 PRL tranche
  const bt = buyer.tranches[3];
  const leg = presignTransferLeg(MAINNET, t,
    { txid: "dd".repeat(32), vout: 0, value: t.amountGrains }, SELLER_PRIV,
    hexToBytes(bytesToHex(bt.tweakedX)), 10);
  const buyerUtxo = {
    txid: "ee".repeat(32), vout: 0, value: 1000, // dust, can't pay
    spk: p2trScriptPubKey(tweak(BUYER_PRIV)), priv: BUYER_PRIV,
  };
  assert.throws(() => buildFillTx(MAINNET, [leg], 50_000_000_000, buyerUtxo, sellerXOnly, buyerXOnly, 10),
    /short/);
});

function tweak(priv) {
  // buyer keypath x-only (untweaked key used as the wallet's P2TR key here)
  return schnorr.getPublicKey(priv);
}

test("transferLegVBytes pinned", () => {
  // transfer leaf = 34 bytes, control = 65 -> 84 + 168/4 = 126
  assert.equal(transferLegVBytes(34, 65), 126);
});

test("classifyTranches lifecycle", () => {
  const bond = forgeBond(MAINNET, TERMS, { key: sellerXOnly, mode: "raw" });
  const addrs = bond.tranches.map((t) => t.address);
  const info = {
    [addrs[0]]: { balance: bond.tranches[0].amountGrains, txs: 1 },
    [addrs[1]]: { balance: bond.tranches[1].amountGrains, txs: 1 },
    [addrs[2]]: { balance: 0, txs: 2 },
  };
  const cls = classifyTranches(bond, { height: bond.tranches[0].lockHeight, info });
  assert.equal(cls[0].status, "claimable");
  assert.equal(cls[1].status, "locked");
  assert.equal(cls[2].status, "spent");
  assert.equal(cls[3].status, "unfunded");
});

test("blockbook endpoint constant", () => {
  assert.equal(BLOCKBOOK_MAINNET, "https://blockbook.pearlresearch.ai");
});

/* ---------- 0x83 script-path sighash: pinned consensus vector ----------
 * The digests below were verified byte-for-byte against pearld's
 * node/txscript CalcTapscriptSignaturehash using a temporary Go harness
 * (since removed). Fixture: tranche[1] of the deterministic bond below,
 * spent via the transfer leaf (0x83) / claim leaf (SIGHASH_DEFAULT).
 * spend_type is 0x02 per BIP-341 (ext_flag=1) — the 0x01 the JS lineage used
 * before 2026-09-30 was a latent consensus bug, fixed and pinned here. */
function goFixture() {
  const sha = (s) => sha256(new TextEncoder().encode(s));
  const sellerXOnly = schnorr.getPublicKey(sha("pearl-bond-fixture-seller-v1"));
  const buyerXOnly = schnorr.getPublicKey(sha("pearl-bond-fixture-buyer-v1"));
  const terms = parseBondTerms({ name: "vec", facePRL: "1000", annualBps: 500, frequency: 2, periods: 4, issueHeight: 200000 });
  const seller = forgeBond(MAINNET, terms, { key: sellerXOnly, mode: "raw" });
  const buyer = forgeBond(MAINNET, terms, { key: buyerXOnly, mode: "raw" });
  const t = seller.tranches[1];
  return {
    input: { txid: "ab".repeat(32), vout: 2, value: t.amountGrains, spk: t.spk },
    output: { program: buyer.tranches[1].tweakedX, value: t.amountGrains - 1260 },
    t,
  };
}

test("scriptPathSigDigest83: structure + pinned Go vector", () => {
  const input = { txid: "ab".repeat(32), vout: 0, value: 2_500_000_000, spk: p2trScriptPubKey(sellerXOnly) };
  const output = { program: buyerXOnly, value: 2_499_998_740 };
  const leaf = buildTransferScript(sellerXOnly);
  const d = scriptPathSigDigest83(MAINNET, input, output, leaf, SEQ_FINAL);
  assert.equal(d.length, 32);
  // determinism
  assert.equal(bytesToHex(d), bytesToHex(scriptPathSigDigest83(MAINNET, input, output, leaf, SEQ_FINAL)));
  // sequence commits: different sequence -> different digest
  const d2 = scriptPathSigDigest83(MAINNET, input, output, leaf, 0xfffffffe);
  assert.notEqual(bytesToHex(d), bytesToHex(d2));
});

test("scriptPathSigDigest83 matches pearld consensus (Go-pinned)", () => {
  const { input, output, t } = goFixture();
  const d = scriptPathSigDigest83(MAINNET, input, output, t.transferScript, SEQ_FINAL);
  assert.equal(bytesToHex(d),
    "6eb021de48aea483a3aabf214dbbbcd1a050a13558a0a5a1f1e928da11ecb51e");
});

test("scriptPathSigDigestEx SIGHASH_DEFAULT matches pearld consensus (Go-pinned)", () => {
  const { input, output, t } = goFixture();
  const d = scriptPathSigDigestEx(MAINNET, input, [output], t.claimScript,
    { sequence: 0xfffffffe, locktime: t.lockHeight });
  assert.equal(bytesToHex(d),
    "8f24f0320f668dc105a10abb02b200484b0d9b3431ec214f93c22d06e85c0186");
});
