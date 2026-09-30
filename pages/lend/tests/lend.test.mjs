// Pearl Lend core tests: terms math, script templates, descriptor honesty,
// repayment/default/mutual-close signing discipline, standalone verifier.
// Usage: node --no-warnings --loader ./tests/loader.mjs tests/lend.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import * as L from "../src/lend-core.js";

const NET = L.NETWORKS.mainnet;
const xOnly = (privHex) => L.bytesToHex(L.schnorr.getPublicKey(L.hexToBytes(privHex)));
const B_PRIV = "11".repeat(32); // borrower
const L_PRIV = "22".repeat(32); // lender
const BX = xOnly(B_PRIV);
const LX = xOnly(L_PRIV);
const bPay = L.encodeBech32m("prl", 1, L.hexToBytes(xOnly("33".repeat(32))));
const lPay = L.encodeBech32m("prl", 1, L.hexToBytes(xOnly("44".repeat(32))));

function terms(over = {}) {
  return {
    network: NET,
    borrowerXOnly: BX,
    lenderXOnly: LX,
    borrowerPayout: bPay,
    lenderPayout: lPay,
    principalPRL: "100",
    aprBps: "1000", // 10%
    termBlocks: "10000",
    graceBlocks: "144",
    ratioBps: "15000",
    collateralPRL: "160",
    note: "test loan",
    ...over,
  };
}

test("interest math is grain-exact and floored", () => {
  // 100 PRL @ 10% APR for 10000 blocks: 100e8 * 1000 * 10000 * 194 / (1e4 * 31556952)
  const i = L.interestGrains(100n * 100000000n, 1000n, 10000n);
  const exact = (100n * 100000000n * 1000n * 10000n * 194n) / (10000n * 31556952n);
  assert.equal(i, exact);
  assert.equal(L.repaymentGrains(100n * 100000000n, 1000n, 10000n), 100n * 100000000n + exact);
  // zero APR -> zero interest
  assert.equal(L.interestGrains(10n ** 12n, 0n, 50000n), 0n);
  // negative APR refused
  assert.throws(() => L.interestGrains(100n, -1n, 10n), /negative/);
});

test("min collateral is max(ratio floor, full repayment)", () => {
  const min = L.minCollateralGrains(100n * 100000000n, 1000n, 10000n, 15000n);
  const byRatio = (100n * 100000000n * 15000n + 9999n) / 10000n; // 150 PRL
  const byRepay = 100n * 100000000n + L.interestGrains(100n * 100000000n, 1000n, 10000n);
  assert.equal(min, byRatio > byRepay ? byRatio : byRepay);
  assert.throws(() => L.minCollateralGrains(100n, 0n, 10n, 9999n), />= 100%/);
});

test("term days uses the 194s block target", () => {
  assert.equal(L.termDays(10000), Math.floor((10000 * 194) / 86400)); // 22 days
  assert.equal(L.termDays(446), 1);
});

test("repay script is <borrower> CHECKSIGVERIFY <lender> CHECKSIG", () => {
  const s = L.buildRepayScript(BX, LX);
  // raw layout: <32B borrower> 0xad <32B lender> 0xac
  assert.equal(s.length, 1 + 32 + 1 + 1 + 32 + 1);
  assert.equal(s[0], 32);
  assert.equal(s[33], 0xad); // OP_CHECKSIGVERIFY
  assert.equal(s[34], 32);
  assert.equal(s[67], 0xac); // OP_CHECKSIG
  assert.equal(L.bytesToHex(s.slice(1, 33)), BX);
  assert.equal(L.bytesToHex(s.slice(35, 67)), LX);
  assert.throws(() => L.buildRepayScript(BX, BX), /identical/);
});

test("default script commits term+grace with CSV", () => {
  const s = L.buildDefaultScript(LX, 10144);
  const asm = L.scriptAsm(s);
  assert.match(asm, /0xb2|CSV/, "contains CSV opcode");
  assert.match(asm, /DROP/);
  assert.throws(() => L.buildDefaultScript(LX, 0), /1\.\.65535/);
  assert.throws(() => L.buildDefaultScript(LX, 65536), /1\.\.65535/);
});

test("deriveLoan is deterministic and control blocks verify", () => {
  const a = L.deriveLoan({ network: NET, borrowerXOnly: BX, lenderXOnly: LX, termBlocks: 10000, graceBlocks: 144 });
  const b = L.deriveLoan({ network: NET, borrowerXOnly: BX, lenderXOnly: LX, termBlocks: 10000, graceBlocks: 144 });
  assert.equal(a.address, b.address);
  assert.ok(a.address.startsWith("prl1"), "bech32m prl1 address");
  assert.equal(a.delayBlocks, 10144);
  assert.ok(L.verifyControlBlock(a.internalXOnly, a.repayScript, a.repayControl, a.tweakedX));
  assert.ok(L.verifyControlBlock(a.internalXOnly, a.defaultScript, a.defaultControl, a.tweakedX));
  // different keys -> different address
  const c = L.deriveLoan({ network: NET, borrowerXOnly: LX, lenderXOnly: BX, termBlocks: 10000, graceBlocks: 144 });
  assert.notEqual(a.address, c.address);
});

test("descriptor builds, verifies, and is tamper-evident", () => {
  const d = L.buildDescriptor(terms());
  assert.equal(d.kind, "pearllend:v1");
  assert.ok(d.vaultAddress.startsWith("prl1"));
  assert.ok(L.verifyDescriptor(d).ok, "fresh descriptor verifies");
  const tampered = { ...d, principalGrains: (BigInt(d.principalGrains) + 1n).toString() };
  const v = L.verifyDescriptor(tampered);
  assert.ok(!v.ok, "tampered descriptor fails");
  assert.ok(v.errors.some((e) => /fingerprint|interest|repayment/.test(e)));
});

test("descriptor refuses bad terms", () => {
  assert.throws(() => L.buildDescriptor(terms({ borrowerXOnly: LX })), /identical/);
  assert.throws(() => L.buildDescriptor(terms({ collateralPRL: "140" })), /below minimum/);
  assert.throws(() => L.buildDescriptor(terms({ termBlocks: "65500", graceBlocks: "100" })), /CSV maximum/);
  assert.throws(() => L.buildDescriptor(terms({ principalPRL: "0.00000001" })), /dust/);
  const tprlPay = L.encodeBech32m("tprl", 1, L.hexToBytes(xOnly("44".repeat(32))));
  assert.throws(() => L.buildDescriptor(terms({ lenderPayout: tprlPay })), /wrong network HRP/);
});

test("repayment proposal -> borrower sign -> lender co-sign -> assemble verifies", () => {
  const d = L.buildDescriptor(terms());
  const lockTxid = "aa".repeat(32);
  const collateral = BigInt(d.collateralGrains);
  const p = L.buildRepayment(d, lockTxid, 0, collateral, 2);
  assert.equal(p.kind, "repay");
  assert.equal(p.outputs[0].value, d.repaymentGrains, "lender paid exactly principal + interest");
  assert.equal(p.outputs[0].address, d.lenderPayout);
  const total = p.outputs.reduce((a, o) => a + BigInt(o.value), 0n);
  assert.equal(total + BigInt(p.feeGrains), collateral, "outputs + fee = vault value");
  // borrower signs
  const bSig = L.signRepaymentDigest(B_PRIV, p.digest);
  assert.ok(L.verifySchnorrSig(L.hexToBytes(bSig), L.hexToBytes(p.digest), L.hexToBytes(BX)));
  // lender co-signs after re-verifying; assembly checks both
  const lSig = L.signRepaymentDigest(L_PRIV, p.digest);
  const tx = L.assembleRepayment(d, p, bSig, lSig);
  assert.ok(/^[0-9a-f]+$/.test(tx.hex));
  assert.equal(tx.hex.length % 2, 0);
  // wrong borrower sig refused
  const badSig = L.signRepaymentDigest(L_PRIV, p.digest); // lender's sig in borrower's slot
  assert.throws(() => L.assembleRepayment(d, p, badSig, lSig), /borrower signature invalid/);
  // tampered proposal refused
  const tampered = { ...p, outputs: [{ ...p.outputs[0], value: (BigInt(p.outputs[0].value) + 1n).toString() }, p.outputs[1]] };
  assert.throws(() => L.assembleRepayment(d, tampered, bSig, lSig), /digest does not recompute/);
});

test("repayment refuses undercollateralized vault value", () => {
  const d = L.buildDescriptor(terms());
  assert.throws(() => L.buildRepayment(d, "aa".repeat(32), 0, BigInt(d.repaymentGrains) - 1n, 2), /below repayment/);
});

test("default claim builds, self-verifies, and uses the CSV delay as sequence", () => {
  const d = L.buildDescriptor(terms());
  const claim = L.buildDefaultClaim(d, "bb".repeat(32), 1, BigInt(d.collateralGrains), 2, L_PRIV);
  assert.equal(claim.kind, "default");
  assert.equal(claim.delayBlocks, 10144);
  assert.ok(BigInt(claim.paysLenderGrains) + BigInt(claim.feeGrains) === BigInt(d.collateralGrains));
  // sequence in the raw tx equals the committed delay
  const dec = L.decodeRawTx(claim.hex);
  assert.equal(dec.inputs[0].sequence, 10144);
  // witness is [sig, script, control]
  assert.equal(dec.witness[0].length, 3);
  assert.equal(dec.witness[0][0].length, 64);
});

test("mutual close requires splits + fee = vault value, assembles with both sigs", () => {
  const d = L.buildDescriptor(terms());
  const collateral = BigInt(d.collateralGrains);
  // exact fee for a 2-output repay-leaf spend at 2 grains/vB
  const fee = BigInt(Math.ceil(L.vaultSpendVBytes("repay", d) * 2));
  const s1 = (collateral - fee) / 2n;
  const s2 = collateral - fee - s1;
  const m = L.buildMutualClose(d, "cc".repeat(32), 0, collateral,
    [{ address: lPay, valueGrains: s1.toString() }, { address: bPay, valueGrains: s2.toString() }], 2);
  assert.equal(m.feeGrains, fee.toString());
  const bSig = L.signRepaymentDigest(B_PRIV, m.digest);
  const lSig = L.signRepaymentDigest(L_PRIV, m.digest);
  const tx = L.assembleMutualClose(d, m, bSig, lSig);
  assert.ok(tx.hex.length > 100);
  assert.throws(() => L.buildMutualClose(d, "cc".repeat(32), 0, collateral,
    [{ address: lPay, valueGrains: "1000" }], 2), /must equal vault value/);
});

test("standalone verifier: PROVEN for a real repayment, NOT PROVEN for garbage", () => {
  const d = L.buildDescriptor(terms());
  const collateral = BigInt(d.collateralGrains);
  const p = L.buildRepayment(d, "aa".repeat(32), 0, collateral, 2);
  const tx = L.assembleRepayment(d, p, L.signRepaymentDigest(B_PRIV, p.digest), L.signRepaymentDigest(L_PRIV, p.digest));
  const prevouts = [{ txid: "aa".repeat(32), vout: 0, value: collateral.toString(), spk: d.vaultSpk }];
  const good = L.verifyLoanTx(d, tx.hex, prevouts);
  assert.equal(good.verdict, "PROVEN", "got: " + JSON.stringify(good));
  const bad = L.verifyLoanTx(d, "00".repeat(100), prevouts);
  assert.equal(bad.verdict, "NOT PROVEN");
  // wrong descriptor (different keys) -> NOT PROVEN
  const d2 = L.buildDescriptor(terms({ lenderXOnly: xOnly("55".repeat(32)) }));
  const bad2 = L.verifyLoanTx(d2, tx.hex, prevouts);
  assert.equal(bad2.verdict, "NOT PROVEN");
});

test("vaultSpendVBytes is sane and fee math covers dust-folded edge", () => {
  const d = L.buildDescriptor(terms());
  const vb = L.vaultSpendVBytes("repay", d);
  assert.ok(vb > 100 && vb < 2000, "vbytes=" + vb);
  // tiny collateral where change < dust folds into fee
  const repay = BigInt(d.repaymentGrains);
  const vb2 = L.spendVBytes({ nOut: 2, scriptLen: L.buildRepayScript(BX, LX).length, controlLen: 33, stackLens: [64, 64] });
  const fee2 = BigInt(Math.ceil(vb2 * 2));
  const p = L.buildRepayment(d, "dd".repeat(32), 0, repay + fee2 + 100n, 2);
  assert.equal(p.outputs.length, 1, "dust change folds into fee");
  assert.ok(p.dustFolded);
});

test("funding payment builds a valid unsigned keypath tx", () => {
  const utxoPriv = "66".repeat(32);
  const utxoX = xOnly(utxoPriv);
  const utxoAddr = L.encodeBech32m("prl", 1, L.hexToBytes(utxoX));
  // fake prevout spk: P2TR for the utxo key (keypath spend)
  const { p2trScriptPubKey } = L;
  const utxos = [{ txid: "ee".repeat(32), vout: 0, value: 200n * 100000000n, spk: L.bytesToHex(p2trScriptPubKey(L.hexToBytes(utxoX))), priv: utxoPriv, internalXOnly: utxoX }];
  const tx = L.buildFundingPayment(NET, utxos, bPay, 100n * 100000000n, 2, utxoAddr);
  assert.ok(/^[0-9a-f]+$/.test(tx.hex));
});
