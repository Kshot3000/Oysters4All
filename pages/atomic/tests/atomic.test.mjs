// Pearl Atomic verification suite — node --test, zero new deps.
// Run: node --no-warnings --loader ./tests/loader.mjs tests/atomic.test.mjs
// Exercises the HTLC claim-leaf template, NUMS internal key, forge path,
// descriptor tamper-evidence, preimage checks, timeout rules, the full
// claim flow (plan -> sign -> assemble -> verify) and the refund flow,
// unsigned-bundle round-trip, and the negative cases.
import test from "node:test";
import assert from "node:assert/strict";

import {
  NETWORKS, DUST_GRAIN,
  parseXOnlyKey, parseHash,
  buildClaimScript, buildRefundScript, scriptAsm,
  numsInternalKeyAtomic, forgeHtlc,
  newPreimage, checkPreimage,
  timeoutRules, validateTimeout, timeoutOrderingWarning,
  makeDescriptor, parseDescriptor,
  planClaim, planRefund, settleDigest, assembleClaim, assembleRefund,
  builderTipGrainsFor, BUILDER_TIP_BPS, BUILDER_TIP_ADDRESS, BUILDER_TIP_NAME,
  exportUnsignedBundle, importUnsignedBundle,
  classifyHtlcState, fetchAddressTxs, fmtPRL, parsePRLtoGrains,
  signForXOnly, verifySchnorrSig,
  taptree2, verifyControlBlock, spendVBytes,
  addressToProgram,
  bytesToHex, hexToBytes, schnorr, sha256, encodeBech32m, decodeBech32m,
  walletFromMnemonic, partyKeyFromInput,
} from "../src/atomic-core.js";
import { tapLeafHash } from "../../sign/src/crypto.js";
import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesToNumberBE } from "@noble/curves/abstract/utils";

const net = NETWORKS.mainnet;
// Fixed BIP-39 test mnemonics (never funded; test-only).
const MNEMONICS = [
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  "legal winner thank year wave sausage worth useful legal winner thank yellow",
  "letter advice cage absurd amount doctor acoustic avoid letter advice cage above",
];
const wallets = [
  walletFromMnemonic(MNEMONICS[0], net, 0, 1), // index 1: odd-Y key (BIP-340 negation path)
  walletFromMnemonic(MNEMONICS[1], net),
  walletFromMnemonic(MNEMONICS[2], net),
];
const KEYS = wallets.map((w) => w.internalXOnly);
const PRIVS = wallets.map((w) => w.priv);
const HASH = sha256(hexToBytes("11".repeat(32)));
const TIMEOUT = 200000;

const isOddY = (priv) =>
  secp256k1.ProjectivePoint.fromPrivateKey(priv).toRawBytes(true)[0] === 0x03;

test("at least one test key has odd Y (parity-negation path is exercised)", () => {
  assert.ok(PRIVS.some(isOddY), "expected an odd-Y key among the fixtures");
});

test("buildClaimScript: exact byte layout", () => {
  const s = buildClaimScript(KEYS[0], HASH);
  const expect = "a8" + "20" + bytesToHex(HASH) + "88" + "20" + bytesToHex(KEYS[0]) + "ac";
  assert.equal(bytesToHex(s), expect);
  assert.equal(s.length, 69);
  const asm = scriptAsm(s);
  assert.ok(asm.includes("SHA256"), asm);
  assert.ok(asm.includes("EQUALVERIFY"), asm);
  assert.ok(asm.endsWith("CHECKSIG"), asm);
});

test("buildClaimScript rejects bad inputs", () => {
  assert.throws(() => buildClaimScript(KEYS[0], "zz"), /64 hex/);
  assert.throws(() => buildClaimScript("zz", HASH), /64 hex/);
  assert.throws(() => buildClaimScript(KEYS[0], hexToBytes("aa".repeat(31))), /32 bytes/);
  assert.throws(() => parseHash("f".repeat(63)), /64 hex/);
});

test("numsInternalKeyAtomic: deterministic NUMS point, independent of party keys", () => {
  const c = buildClaimScript(KEYS[0], HASH);
  const r = buildRefundScript(KEYS[1], TIMEOUT);
  const k1 = numsInternalKeyAtomic(c, r);
  const k2 = numsInternalKeyAtomic(c, r);
  assert.equal(k1.length, 32);
  assert.equal(bytesToHex(k1), bytesToHex(k2), "deterministic");
  schnorr.utils.lift_x(bytesToNumberBE(k1));
  // equals the documented construction: first hash of
  // SHA-256("PearlAtomicNUMS/v1" || leafHashC || leafHashR || counter) that lifts
  // (only ~half of all hashes are valid x-coordinates — the counter loop is required)
  const te = new TextEncoder();
  const pre0 = Uint8Array.from([...te.encode("PearlAtomicNUMS/v1"), ...tapLeafHash(c), ...tapLeafHash(r)]);
  let manual = null;
  for (let i = 0; i < 256 && !manual; i++) {
    const pre = i === 0 ? pre0 : Uint8Array.from([...pre0, i]);
    const h = sha256(pre);
    try { schnorr.utils.lift_x(bytesToNumberBE(h)); manual = h; } catch { /* next */ }
  }
  assert.ok(manual, "counter search found a lifting hash");
  assert.equal(bytesToHex(k1), bytesToHex(manual));
  for (const k of KEYS) assert.notEqual(bytesToHex(k1), bytesToHex(k));
  assert.throws(() => numsInternalKeyAtomic(c, null), /bad refund script/);
});

test("forgeHtlc: full contract, NUMS key, control blocks verify", () => {
  const f = forgeHtlc(net, { claimerXOnly: KEYS[0], refundeeXOnly: KEYS[1], hash: HASH, timeout: TIMEOUT });
  assert.equal(f.claimScript.length, 69);
  assert.ok(f.refundScript.length > 0);
  for (const k of KEYS) assert.notEqual(bytesToHex(f.internalXOnly), bytesToHex(k));
  assert.ok(verifyControlBlock(f.internalXOnly, f.claimScript, f.tree.controlBlocks[0], f.tree.tweakedX));
  assert.ok(verifyControlBlock(f.internalXOnly, f.refundScript, f.tree.controlBlocks[1], f.tree.tweakedX));
  const dec = decodeBech32m(f.tree.address);
  assert.equal(dec.hrp, net.hrp);
  assert.equal(dec.version, 1);
  assert.equal(dec.program.length, 32);
  // claimer == refundee refused
  assert.throws(() => forgeHtlc(net, { claimerXOnly: KEYS[0], refundeeXOnly: KEYS[0], hash: HASH, timeout: TIMEOUT }), /must differ/);
  // bad timeout refused by the refund-leaf template
  assert.throws(() => forgeHtlc(net, { claimerXOnly: KEYS[0], refundeeXOnly: KEYS[1], hash: HASH, timeout: 0 }), /positive block height/);
});

test("newPreimage / checkPreimage", () => {
  const { preimage, hash } = newPreimage();
  assert.equal(preimage.length, 32);
  assert.equal(bytesToHex(sha256(preimage)), bytesToHex(hash));
  const got = checkPreimage(bytesToHex(preimage), hash);
  assert.equal(bytesToHex(got), bytesToHex(preimage));
  assert.throws(() => checkPreimage(bytesToHex(preimage), sha256(hexToBytes("22".repeat(32)))), /does not hash/);
  assert.throws(() => checkPreimage("zz", hash), /./);
});

test("timeout rules", () => {
  const r = timeoutRules(150000);
  assert.equal(r.min, 150144);
  assert.equal(r.warnBelow, 150720);
  assert.ok(validateTimeout(160000, 150000).ok);
  const w = validateTimeout(150500, 150000);
  assert.ok(w.ok && w.warnings.length === 1, "caution band warns");
  assert.throws(() => validateTimeout(150000, 150000), /not in the future/);
  assert.throws(() => validateTimeout(150100, 150000), /minimum/);
  assert.throws(() => validateTimeout(0, 150000), /positive block height/);
  assert.throws(() => validateTimeout(500000000, 150000), /positive block height/);
  // unknown height: no rules, still structurally valid
  assert.ok(validateTimeout(200000, null).ok);
});

test("timeout ordering warnings (TierNolan)", () => {
  // maker locks first -> PRL timeout must exceed counterparty timeout
  assert.ok(timeoutOrderingWarning("maker", 200000, 210000).includes("UNSAFE ORDERING"));
  assert.equal(timeoutOrderingWarning("maker", 220000, 210000), null);
  // taker claims PRL -> PRL timeout must exceed their own leg timeout
  assert.ok(timeoutOrderingWarning("taker", 200000, 210000).includes("UNSAFE ORDERING"));
  assert.equal(timeoutOrderingWarning("taker", 220000, 210000), null);
  assert.equal(timeoutOrderingWarning("maker", 200000, null), null, "unknown counterparty timeout: no warning");
});

test("descriptor round-trip + tamper evidence", () => {
  const f = forgeHtlc(net, { claimerXOnly: KEYS[0], refundeeXOnly: KEYS[1], hash: HASH, timeout: TIMEOUT });
  const d = makeDescriptor(net, f, {
    timeout: TIMEOUT, amountGrains: 100000000, label: "test swap",
    counterparty: { chain: "Ergo", asset: "ERG", amount: "50", htlcRef: "abc", refundTimeout: 190000 },
  });
  assert.ok(/^[0-9a-f]{16}$/.test(d.fingerprint));
  assert.ok(d.string.startsWith("pearl-atomic:v1:"));
  const p = parseDescriptor(net, d.string);
  assert.equal(p.fingerprint, d.fingerprint);
  assert.equal(p.contract.tree.address, f.tree.address);
  assert.equal(p.obj.counterparty.chain, "Ergo");
  // tamper: flip a char in the payload -> fingerprint or re-derivation must fail
  const tampered = d.string.slice(0, 40) + (d.string[40] === "A" ? "B" : "A") + d.string.slice(41);
  assert.throws(() => parseDescriptor(net, tampered), /ATOMIC REFUSED/);
  // wrong network refused
  assert.throws(() => parseDescriptor(NETWORKS.testnet, d.string), /not a pearl-atomic|for prl, not/);
  // garbage refused
  assert.throws(() => parseDescriptor(net, "pearl-atomic:v1:!!!"), /ATOMIC REFUSED/);
  assert.throws(() => parseDescriptor(net, "nope"), /not a pearl-atomic/);
});

test("claim flow: plan -> sign -> assemble -> digest cross-check", () => {
  const f = forgeHtlc(net, { claimerXOnly: KEYS[0], refundeeXOnly: KEYS[1], hash: HASH, timeout: TIMEOUT });
  const { preimage } = (() => {
    // find a preimage for the fixed HASH: use a fresh one and re-forge
    const np = newPreimage();
    const ff = forgeHtlc(net, { claimerXOnly: KEYS[0], refundeeXOnly: KEYS[1], hash: np.hash, timeout: TIMEOUT });
    return { preimage: np.preimage, forge: ff };
  })();
  const c = forgeHtlc(net, { claimerXOnly: KEYS[0], refundeeXOnly: KEYS[1], hash: sha256(preimage), timeout: TIMEOUT });
  const dest = wallets[0].internalXOnly; // claimer pays themselves (any P2TR program works)
  const input = { txid: "ab".repeat(32), vout: 0, value: 100000000, spk: c.tree.spk };
  const plan = planClaim({
    network: net, contract: c, input,
    preimageHex: bytesToHex(preimage), destProgram: dest, feeRateGrainsPerVByte: 20,
  });
  assert.equal(plan.kind, "claim");
  assert.equal(plan.sequence, 0xffffffff);
  assert.equal(plan.locktime, 0);
  const wantVB = spendVBytes({ nOut: 1, scriptLen: c.claimScript.length, controlLen: 65, stackLens: [64, 32] });
  assert.equal(plan.vBytes, wantVB);
  assert.equal(plan.fee, Math.ceil(wantVB * 20));
  assert.equal(plan.outputs[0].value, 100000000 - plan.fee);
  // sign with the claimer's key (index 0 is odd-Y: exercises negation)
  const digest = settleDigest(net, plan);
  const sig = signForXOnly(PRIVS[0], digest);
  assert.ok(verifySchnorrSig(sig, digest, KEYS[0]));
  const spend = assembleClaim(net, plan, bytesToHex(sig), KEYS[0]);
  assert.equal(spend.digest, bytesToHex(digest));
  assert.equal(spend.vBytes, wantVB, "built tx weight matches the plan");
  assert.ok(/^[0-9a-f]{64}$/.test(spend.txid));
  assert.ok(spend.hex.length > 200);
  // wrong-key signature refused at assembly
  const badSig = signForXOnly(PRIVS[1], digest);
  assert.throws(() => assembleClaim(net, plan, bytesToHex(badSig), KEYS[0]), /does not verify/);
  // wrong preimage refused at planning
  assert.throws(() => planClaim({
    network: net, contract: c, input,
    preimageHex: "cc".repeat(32), destProgram: dest, feeRateGrainsPerVByte: 20,
  }), /does not hash/);
  // dust input refused
  assert.throws(() => planClaim({
    network: net, contract: c,
    input: { txid: "ab".repeat(32), vout: 0, value: 600, spk: c.tree.spk },
    preimageHex: bytesToHex(preimage), destProgram: dest, feeRateGrainsPerVByte: 20,
  }), /insufficient funds/);
  // bad fee rates refused: a negative rate used to plan an output worth
  // MORE than the input (fee < 0), and NaN poisoned the plan's fee/output
  for (const badRate of [-5, 0, NaN, Infinity]) {
    assert.throws(() => planClaim({
      network: net, contract: c, input,
      preimageHex: bytesToHex(preimage), destProgram: dest, feeRateGrainsPerVByte: badRate,
    }), /bad fee rate/);
  }
});

test("refund flow: plan -> sign -> assemble; timelock enforced", () => {
  const c = forgeHtlc(net, { claimerXOnly: KEYS[0], refundeeXOnly: KEYS[1], hash: HASH, timeout: TIMEOUT });
  const dest = wallets[1].internalXOnly;
  const input = { txid: "cd".repeat(32), vout: 1, value: 50000000, spk: c.tree.spk };
  // closed timelock refused loudly
  assert.throws(() => planRefund({
    network: net, contract: c, input, destProgram: dest,
    feeRateGrainsPerVByte: 20, chainHeight: TIMEOUT - 1,
  }), /timelocked until block 200000/);
  const plan = planRefund({
    network: net, contract: c, input, destProgram: dest,
    feeRateGrainsPerVByte: 20, chainHeight: TIMEOUT,
  });
  assert.equal(plan.kind, "refund");
  assert.equal(plan.locktime, TIMEOUT);
  assert.equal(plan.sequence, 0xfffffffe);
  const wantVB = spendVBytes({ nOut: 1, scriptLen: c.refundScript.length, controlLen: 65, stackLens: [64] });
  assert.equal(plan.vBytes, wantVB);
  const digest = settleDigest(net, plan);
  const sig = signForXOnly(PRIVS[1], digest);
  const spend = assembleRefund(net, plan, bytesToHex(sig), KEYS[1]);
  assert.equal(spend.digest, bytesToHex(digest));
  assert.equal(spend.vBytes, wantVB);
  assert.ok(/^[0-9a-f]{64}$/.test(spend.txid));
  // wrong-key signature refused
  const badSig = signForXOnly(PRIVS[0], digest);
  assert.throws(() => assembleRefund(net, plan, bytesToHex(badSig), KEYS[1]), /does not verify/);
  // bad fee rates refused (negative rate planned an output > the input)
  for (const badRate of [-5, 0, NaN, Infinity]) {
    assert.throws(() => planRefund({
      network: net, contract: c, input, destProgram: dest,
      feeRateGrainsPerVByte: badRate, chainHeight: TIMEOUT,
    }), /bad fee rate/);
  }
});

test("unsigned bundle round-trip + tamper refusal", () => {
  const np = newPreimage();
  const c = forgeHtlc(net, { claimerXOnly: KEYS[0], refundeeXOnly: KEYS[1], hash: np.hash, timeout: TIMEOUT });
  const d = makeDescriptor(net, c, { timeout: TIMEOUT, amountGrains: 100000000 });
  const input = { txid: "ab".repeat(32), vout: 0, value: 100000000, spk: c.tree.spk };
  const plan = planClaim({
    network: net, contract: c, input,
    preimageHex: bytesToHex(np.preimage), destProgram: KEYS[0], feeRateGrainsPerVByte: 20,
  });
  const b = exportUnsignedBundle(net, plan, d);
  assert.equal(b.bundle, "pearl-atomic-unsigned:v1:");
  assert.ok(/^[0-9a-f]{16}$/.test(b.fingerprint));
  const imp = importUnsignedBundle(net, JSON.stringify(b), c);
  assert.equal(imp.bundle.fingerprint, b.fingerprint);
  assert.equal(imp.descriptor.contract.tree.address, c.tree.address);
  // tamper with an output value -> fingerprint breaks
  const t2 = JSON.parse(JSON.stringify(b));
  t2.outputs[0].value = String(Number(t2.outputs[0].value) + 1);
  assert.throws(() => importUnsignedBundle(net, JSON.stringify(t2), c), /fingerprint mismatch/);
  // tamper with the digest but fix the fingerprint is impossible without the
  // preimage of the hash — instead verify digest recomputation catches edits
  const t3 = JSON.parse(JSON.stringify(b));
  t3.digest = "00".repeat(32);
  assert.throws(() => importUnsignedBundle(net, JSON.stringify(t3), c), /fingerprint mismatch/);
});

test("classifyHtlcState: funding then spend", () => {
  const f = forgeHtlc(net, { claimerXOnly: KEYS[0], refundeeXOnly: KEYS[1], hash: HASH, timeout: TIMEOUT });
  const addr = f.tree.address;
  const fundTxid = "aa".repeat(32), spendTxid = "bb".repeat(32);
  const txs = [
    { txid: fundTxid, confirmations: 12, blockHeight: 199000, vout: [{ n: 0, value: "100000000", addresses: [addr] }], vin: [{ txid: "ff".repeat(32), vout: 0 }] },
    { txid: spendTxid, confirmations: 3, blockHeight: 199010, vout: [{ n: 0, value: "99990000", addresses: ["prl1pother"] }], vin: [{ txid: fundTxid, vout: 0 }] },
  ];
  const st = classifyHtlcState(txs, addr, null);
  assert.equal(st.funding.txid, fundTxid);
  assert.equal(st.funding.value, 100000000);
  assert.equal(st.spend.txid, spendTxid);
  const empty = classifyHtlcState([], addr, null);
  assert.equal(empty.funding, null);
  assert.equal(empty.spend, null);
});

test("classifyHtlcState: endpoint fields are coerced before they can feed a signer", () => {
  const f = forgeHtlc(net, { claimerXOnly: KEYS[0], refundeeXOnly: KEYS[1], hash: HASH, timeout: TIMEOUT });
  const addr = f.tree.address;
  const fundTxid = "aa".repeat(32), spendTxid = "bb".repeat(32);
  // A vout value past MAX_SAFE_INTEGER must not be silently rounded into
  // the funding UTXO (9007199254740993 came back 9007199254740992): the
  // vout is not a usable funding hit.
  const jumbo = classifyHtlcState([
    { txid: fundTxid, confirmations: 12, blockHeight: 199000, vout: [{ n: 0, value: "9007199254740993", addresses: [addr] }], vin: [] },
  ], addr, null);
  assert.equal(jumbo.funding, null);
  // Numeric-string fields from the endpoint are coerced to safe integers,
  // and the spend is still detected when vin.vout arrives as a string.
  const coerced = classifyHtlcState([
    { txid: fundTxid, confirmations: "12", blockHeight: "199000", vout: [{ n: "0", value: "100000000", addresses: [addr] }], vin: [{ txid: "ff".repeat(32), vout: 0 }] },
    { txid: spendTxid, confirmations: "3", blockHeight: 199010, vout: [], vin: [{ txid: fundTxid, vout: "0" }] },
  ], addr, null);
  assert.equal(coerced.funding.txid, fundTxid);
  assert.equal(coerced.funding.vout, 0);
  assert.equal(coerced.funding.value, 100000000);
  assert.equal(coerced.funding.confirmations, 12);
  assert.equal(coerced.funding.height, 199000);
  assert.equal(coerced.spend.txid, spendTxid);
  assert.equal(coerced.spend.confirmations, 3);
  // A non-string txid is skipped, never crashed on (the old spend loop
  // threw TypeError on funding.txid.toLowerCase()).
  const junk = classifyHtlcState([
    { txid: 12345, confirmations: 12, blockHeight: 199000, vout: [{ n: 0, value: "100000000", addresses: [addr] }], vin: [] },
    { txid: spendTxid, confirmations: 3, blockHeight: 199010, vout: [], vin: [{ txid: fundTxid, vout: 0 }] },
  ], addr, null);
  assert.equal(junk.funding, null);
  assert.equal(junk.spend, null);
});

test("fmtPRL / parsePRLtoGrains", () => {
  assert.equal(fmtPRL(100000000), "1 PRL");
  assert.equal(fmtPRL(125000000), "1.25 PRL");
  assert.equal(fmtPRL(333), "0.00000333 PRL");
  assert.equal(parsePRLtoGrains("1.25"), 125000000);
  assert.equal(parsePRLtoGrains("1.25 PRL"), 125000000);
  assert.equal(parsePRLtoGrains("333 grains"), 333);
  assert.throws(() => parsePRLtoGrains("0.00000332"), /dust/);
  assert.throws(() => parsePRLtoGrains("abc"), /amount must look like/);
  // Exact-range regression: past MAX_SAFE_INTEGER grains the old
  // Number(grains) silently dropped grains (…001 came back …000).
  assert.equal(parsePRLtoGrains("90071992.54740991"), 9007199254740991);
  assert.throws(() => parsePRLtoGrains("90071992.54740992"), /out of range/);
  assert.throws(() => parsePRLtoGrains("100000000.00000001"), /out of range/);
});

/* ---------------- builder tip (optional, disclosed, claim-only) ---------------- */

function parseOutputsFromHex(hex) {
  const b = Buffer.from(hex, "hex");
  let o = 4;
  if (b[o] === 0 && b[o + 1] === 1) o += 2;
  const vi = () => {
    const v = b[o];
    if (v < 0xfd) { o += 1; return v; }
    if (v === 0xfd) { const n = b.readUInt16LE(o + 1); o += 3; return n; }
    throw new Error("varint too big");
  };
  const nIn = vi();
  for (let i = 0; i < nIn; i++) { o += 36; const sl = vi(); o += sl + 4; }
  const nOut = vi();
  const outs = [];
  for (let i = 0; i < nOut; i++) {
    const v = Number(b.readBigUInt64LE(o)); o += 8;
    const sl = vi(); const spk = b.subarray(o, o + sl).toString("hex"); o += sl;
    outs.push({ value: v, spk });
  }
  return outs;
}

test("builder tip: exactness and waivers", () => {
  assert.equal(BUILDER_TIP_BPS, 100);
  assert.equal(BUILDER_TIP_ADDRESS, "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d");
  assert.equal(BUILDER_TIP_NAME, "Builder tip (optional)");
  assert.equal(builderTipGrainsFor(100000000, net, true), 1000000, "1% of 1 PRL");
  assert.equal(builderTipGrainsFor(100000000, net, false), 0, "off unless enabled === true");
  assert.equal(builderTipGrainsFor(100000000, net, 1), 0, "truthy is not true");
  assert.equal(builderTipGrainsFor(100000000, NETWORKS.testnet, true), 0, "mainnet only");
  // dust floor: waived below it, never rounded up; charged exactly at it
  assert.equal(builderTipGrainsFor(33299, net, true), 0, "332-grain tip waived");
  assert.equal(builderTipGrainsFor(33300, net, true), 333, "333-grain tip charged exactly");
  assert.equal(builderTipGrainsFor(1000, net, true), 0, "10-grain tip waived");
});

test("builder tip: tipped claim plans, signs, assembles with the tip exact on the wire", () => {
  const np = newPreimage();
  const c = forgeHtlc(net, { claimerXOnly: KEYS[0], refundeeXOnly: KEYS[1], hash: np.hash, timeout: TIMEOUT });
  const input = { txid: "ab".repeat(32), vout: 0, value: 100000000, spk: c.tree.spk };
  const dest = wallets[0].internalXOnly;
  const builderProgram = addressToProgram(BUILDER_TIP_ADDRESS, net);
  const plan = planClaim({
    network: net, contract: c, input,
    preimageHex: bytesToHex(np.preimage), destProgram: dest, feeRateGrainsPerVByte: 20,
    builderTipEnabled: true,
  });
  assert.equal(plan.builderTip, 1000000);
  assert.equal(plan.outputs.length, 2);
  assert.equal(plan.outputs[1].value, 1000000);
  assert.equal(plan.outputs[1].builderTip, true);
  assert.equal(bytesToHex(plan.outputs[1].program), bytesToHex(builderProgram));
  const wantVB = spendVBytes({ nOut: 2, scriptLen: c.claimScript.length, controlLen: 65, stackLens: [64, 32] });
  assert.equal(plan.vBytes, wantVB, "fee computed over 2 outputs");
  assert.equal(plan.fee, Math.ceil(wantVB * 20));
  assert.equal(plan.outputs[0].value + plan.outputs[1].value + plan.fee, 100000000, "conservation");
  // untipped plan is identical to the pre-tip planner and its digest differs
  const plain = planClaim({
    network: net, contract: c, input,
    preimageHex: bytesToHex(np.preimage), destProgram: dest, feeRateGrainsPerVByte: 20,
  });
  assert.equal(plain.builderTip, 0);
  assert.equal(plain.outputs.length, 1);
  assert.notEqual(bytesToHex(settleDigest(net, plan)), bytesToHex(settleDigest(net, plain)),
    "the sighash commits to the tip output — it cannot be added after signing");
  // sign + assemble: the tip is output 1 on the wire, exact to the builder program
  const digest = settleDigest(net, plan);
  const sig = signForXOnly(PRIVS[0], digest);
  const spend = assembleClaim(net, plan, bytesToHex(sig), KEYS[0]);
  const outs = parseOutputsFromHex(spend.hex);
  assert.equal(outs.length, 2);
  assert.equal(outs[1].value, 1000000);
  assert.equal(outs[1].spk, "5120" + bytesToHex(builderProgram));
  assert.equal(outs[0].value, plan.outputs[0].value);
  // destination == builder address refuses at plan time (tip would duplicate)
  assert.throws(() => planClaim({
    network: net, contract: c, input,
    preimageHex: bytesToHex(np.preimage), destProgram: builderProgram, feeRateGrainsPerVByte: 20,
    builderTipEnabled: true,
  }), /builder tip would duplicate/);
  // rerouted flagged tip refused at assembly (last hop before the tx is built)
  const rerouted = { ...plan, outputs: plan.outputs.map((o, i) => i === 1 ? { ...o, program: dest } : o) };
  assert.throws(() => assembleClaim(net, rerouted, bytesToHex(sig), KEYS[0]), /does not pay the builder address/);
  // stray flagged output on an untipped plan refused at assembly
  const stray = { ...plain, outputs: [...plain.outputs, { program: builderProgram, value: 1000, builderTip: true }] };
  const straySig = signForXOnly(PRIVS[0], settleDigest(net, stray));
  assert.throws(() => assembleClaim(net, stray, bytesToHex(straySig), KEYS[0]), /flagged builder tip but no planned tip/);
  // a tip that would leave the claimer below dust refuses at plan time naming the tip
  assert.throws(() => planClaim({
    network: net, contract: c,
    input: { txid: "ab".repeat(32), vout: 0, value: 100000, spk: c.tree.spk },
    preimageHex: bytesToHex(np.preimage), destProgram: dest, feeRateGrainsPerVByte: 600,
    builderTipEnabled: true,
  }), /builder tip/);
});

test("builder tip: refund never carries one; tipped claim bundle round-trips", () => {
  const np = newPreimage();
  const c = forgeHtlc(net, { claimerXOnly: KEYS[0], refundeeXOnly: KEYS[1], hash: np.hash, timeout: TIMEOUT });
  const d = makeDescriptor(net, c, { timeout: TIMEOUT, amountGrains: 100000000 });
  const input = { txid: "cd".repeat(32), vout: 1, value: 50000000, spk: c.tree.spk };
  // planRefund takes no tip parameter at all — exclusion by construction
  const refund = planRefund({
    network: net, contract: c, input, destProgram: wallets[1].internalXOnly,
    feeRateGrainsPerVByte: 20, chainHeight: TIMEOUT,
  });
  assert.equal(refund.outputs.length, 1);
  assert.ok(!refund.builderTip, "refund plan carries no tip");
  assert.equal(refund.outputs[0].value + refund.fee, 50000000, "refund conservation exact");
  // a tipped claim survives the air-gapped bundle round-trip (the digest
  // inside the bundle commits to both outputs — no separate tip leg needed)
  const claimInput = { txid: "ab".repeat(32), vout: 0, value: 100000000, spk: c.tree.spk };
  const tipped = planClaim({
    network: net, contract: c, input: claimInput,
    preimageHex: bytesToHex(np.preimage), destProgram: KEYS[0], feeRateGrainsPerVByte: 20,
    builderTipEnabled: true,
  });
  const b = exportUnsignedBundle(net, tipped, d);
  assert.equal(b.outputs.length, 2);
  assert.equal(Number(b.outputs[1].value), 1000000);
  assert.equal(b.outputs[1].address, BUILDER_TIP_ADDRESS);
  const imp = importUnsignedBundle(net, JSON.stringify(b), c);
  assert.equal(imp.bundle.fingerprint, b.fingerprint);
});

test("partyKeyFromInput + addressToProgram gates", () => {
  const k = partyKeyFromInput(MNEMONICS[0], net);
  // partyKeyFromInput derives BIP-86 m/86'/coin'/0'/0/0 (index 0)
  assert.equal(bytesToHex(k.xonly), bytesToHex(walletFromMnemonic(MNEMONICS[0], net).internalXOnly));
  assert.ok(k.priv);
  const hx = partyKeyFromInput(bytesToHex(KEYS[1]), net);
  assert.equal(hx.priv, null);
  assert.throws(() => partyKeyFromInput("junk", net), /64-hex x-only pubkey or a 12\/24-word mnemonic/);
  const prog = addressToProgram(encodeBech32m(net.hrp, 1, KEYS[0]), net);
  assert.equal(bytesToHex(prog), bytesToHex(KEYS[0]));
  assert.throws(() => addressToProgram(encodeBech32m("tprl", 1, KEYS[0]), net), /wrong network HRP/);
});

test("fetchAddressTxs reads the real Blockbook shape (txs is a count, array is transactions)", async () => {
  const realFetch = globalThis.fetch;
  const body = { address: "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d", txs: 1, transactions: [{ txid: "a".repeat(64), confirmations: 5, vout: [] }] };
  globalThis.fetch = async () => ({ ok: true, json: async () => body });
  try {
    const txs = await fetchAddressTxs("https://x", "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d");
    assert.equal(txs.length, 1);
  } finally { globalThis.fetch = realFetch; }
});
