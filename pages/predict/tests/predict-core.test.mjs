// Pearl Predict core tests.
// Run: node --no-warnings --loader ./tests/loader.mjs --test ./tests/predict-core.test.mjs
// (from the predict directory)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateMarketSpec, canonicalMarketJSON, marketHashHex, marketDescriptor,
  parseMarketDescriptor, verifyMarketDescriptor,
  numsInternalKeyPredict, outcomeContract, allOutcomeContracts,
  scriptPathVBytes, feeForVBytes, validatePosition, largestRemainder,
  planAwardPayout, planVoidRefund, tapSighashMulti,
  buildMultiInputScriptPathSpend, signBundle, verifyBundle,
  fmtPRL, parsePRLToGrains, blocksToCountdown, impliedProbabilities,
  bytesToHex, hexToBytes, walletFromMnemonic, walletFromPriv,
  DUST_GRAIN, GRAIN_PER_PRL, NETWORKS, BLOCK_TARGET_SECONDS,
  schnorr, sha256, decodeBech32m,
} from "../src/predict-core.js";
import { buildAwardScript } from "../../bounty/src/bounty-core.js";
import {
  buildRefundScript, scriptPathSigDigestEx, verifySchnorrSig,
} from "../../escrow/src/escrow-core.js";
import { bytesToNumberBE } from "@noble/curves/abstract/utils";

const TE = new TextEncoder();
const ARB_MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const net = NETWORKS.mainnet;

function fixtureSpec(over = {}) {
  return validateMarketSpec({
    question: "Will Pearl mainnet exceed block 900000 before 2027?",
    outcomes: ["Yes", "No"],
    source: "Blockbook tip at blockbook.pearlresearch.ai, height read at resolution time.",
    tradeH: 901000, resolveH: 902000,
    arbiterKeyInput: ARB_MNEMONIC, hrp: "prl",
    ...over,
  }, 900000);
}
const funderAddr = (seed) => walletFromPriv(sha256(TE.encode(seed)), net).address;

/* ---------------- descriptor vectors (pinned) ---------------- */

test("descriptor pinned vector", () => {
  const norm = fixtureSpec();
  assert.equal(marketHashHex(norm), "cfb10af0ab0f2a7a7a08fbf90f5509cf9200864ed7ff83503bf9fd2929c5deb1");
  assert.equal(
    marketDescriptor(norm),
    "pearl-predict:v1:prl:cfb10af0ab0f2a7a7a08fbf90f5509cf9200864ed7ff83503bf9fd2929c5deb1:2:901000:902000"
  );
  assert.equal(norm.arbiterXOnly, "e0cafb2d3590eae1a95747476dd321335ac47b9c348026f19543dc6289f4ec4e");
});

test("descriptor round-trip parse", () => {
  const d = marketDescriptor(fixtureSpec());
  const p = parseMarketDescriptor(d);
  assert.deepEqual(p, {
    hrp: "prl",
    marketHash: "cfb10af0ab0f2a7a7a08fbf90f5509cf9200864ed7ff83503bf9fd2929c5deb1",
    nOutcomes: 2, tradeH: 901000, resolveH: 902000,
  });
  assert.throws(() => parseMarketDescriptor("pearl-predict:v1:prl:zz:2:1:2"), /bad pearl-predict/);
  assert.throws(() => parseMarketDescriptor("pearl-predict:v1:prl:" + "ab".repeat(32) + ":2:5:5"), /resolveH/);
});

test("tampered market JSON breaks the descriptor", () => {
  const norm = fixtureSpec();
  const evil = { ...norm, question: "Will Pearl mainnet exceed block 900000 before 2028?" };
  assert.notEqual(marketHashHex(evil), marketHashHex(norm));
  const v = verifyMarketDescriptor(evil, marketDescriptor(norm));
  assert.equal(v.ok, false);
  assert.ok(v.failures.some((f) => /marketHash|commitment/.test(f)));
});

test("verifyMarketDescriptor ok on honest input", () => {
  const norm = fixtureSpec();
  const v = verifyMarketDescriptor(norm, marketDescriptor(norm));
  assert.equal(v.ok, true);
  assert.deepEqual(v.failures, []);
});

/* ---------------- deadline + input guards ---------------- */

test("deadline guards refuse bad heights", () => {
  assert.throws(() => fixtureSpec({ tradeH: 899000 }), /not in the future/); // at/below tip
  assert.throws(() => fixtureSpec({ tradeH: 902000, resolveH: 902000 }), /AFTER the trading deadline/);
  assert.throws(() => fixtureSpec({ tradeH: 903000, resolveH: 902500 }), /AFTER the trading deadline/);
  assert.throws(() => fixtureSpec({ resolveH: 500_000_000 }), /block height/);
  assert.throws(() => fixtureSpec({ tradeH: 1.5 }), /block height/);
});

test("market spec guards: outcomes, question, source, keys", () => {
  assert.throws(() => fixtureSpec({ outcomes: ["Only"] }), /2-4/);
  assert.throws(() => fixtureSpec({ outcomes: ["a", "b", "c", "d", "e"] }), /2-4/);
  assert.throws(() => fixtureSpec({ outcomes: ["Yes", "yes"] }), /unique/);
  assert.throws(() => fixtureSpec({ question: "short" }), /8-200/);
  assert.throws(() => fixtureSpec({ source: "x" }), /8-300/);
  assert.throws(() => fixtureSpec({ arbiterKeyInput: "notakey" }), /party key/);
  assert.throws(() => fixtureSpec({ hrp: "bc" }), /hrp/);
  // 64-hex x-only arbiter accepted
  const n2 = fixtureSpec({ arbiterKeyInput: norm0().arbiterXOnly });
  assert.equal(n2.arbiterXOnly, norm0().arbiterXOnly);
  // default refund key = arbiter key; explicit refund key honored
  assert.equal(fixtureSpec().refundXOnly, fixtureSpec().arbiterXOnly);
  const refundW = walletFromPriv(sha256(TE.encode("refund-key-test")), net);
  const r = fixtureSpec({ refundKeyInput: bytesToHex(refundW.internalXOnly) });
  assert.equal(r.refundXOnly, bytesToHex(refundW.internalXOnly));
});
function norm0() { return fixtureSpec(); }

test("position guards: dust, network, duplicates", () => {
  const norm = fixtureSpec();
  const good = { outcomeIndex: 0, txid: "aa".repeat(32), vout: 0, value: 546, funderAddr: funderAddr("p1") };
  assert.equal(validatePosition(norm, good).value, 546);
  assert.throws(() => validatePosition(norm, { ...good, value: 545 }), /dust/);
  assert.throws(() => validatePosition(norm, { ...good, outcomeIndex: 7 }), /out of range/);
  assert.throws(() => validatePosition(norm, { ...good, txid: "zz" }), /64 hex/);
  // wrong-network payout address refused
  const tnet = walletFromPriv(sha256(TE.encode("t1")), NETWORKS.testnet).address;
  assert.throws(() => validatePosition(norm, { ...good, funderAddr: tnet }), /wrong network HRP/);
  // duplicate inputs refused at plan time
  const c = allOutcomeContracts(norm);
  assert.throws(
    () => planAwardPayout({ norm, contracts: c, positions: [good, good], winIndex: 0, feeRateGrainsPerVByte: 5 }),
    /duplicate position/
  );
});

/* ---------------- audited leaf lineage ---------------- */

test("Leaf A byte-equals the audited Pearl Bounty award leaf", () => {
  const norm = fixtureSpec();
  const c = outcomeContract(norm, 0);
  const audited = buildAwardScript(hexToBytes(norm.arbiterXOnly));
  assert.deepEqual(c.leafA, audited);
  assert.equal(bytesToHex(c.leafA), "20" + norm.arbiterXOnly + "ac"); // <key> CHECKSIG
});

test("Leaf B byte-equals the audited Pearl Escrow refund leaf", () => {
  const norm = fixtureSpec();
  const c = outcomeContract(norm, 1);
  const audited = buildRefundScript(hexToBytes(norm.refundXOnly), norm.resolveH);
  assert.deepEqual(c.leafB, audited);
  // <resolveH> CLTV DROP <key> CHECKSIG
  assert.equal(bytesToHex(c.leafB), "0370c30db17520" + norm.refundXOnly + "ac");
});

test("outcome addresses pinned + deterministic per outcome index", () => {
  const norm = fixtureSpec();
  const c0 = outcomeContract(norm, 0);
  const c1 = outcomeContract(norm, 1);
  assert.equal(c0.address, "prl1pxdf04m525gv2hw0rg6e75f5wlx36jve7mj3ynjp3jtv880lwarnqq262eh");
  assert.equal(c1.address, "prl1plem6tw2lafh6rc4t4x4l9tjnregvq8d96f69nrl9gj2g5rfvh9usud3xxg");
  assert.notEqual(c0.address, c1.address);
  assert.equal(bytesToHex(c0.internalXOnly), "98e9161009a23c0aa66f72ea7364936198db4d1a1f6f7517b4bf4f9b38f74a43");
});

test("NUMS internal key: deterministic, domain-bound, lifts to curve", () => {
  const h = marketHashHex(fixtureSpec());
  const k0a = numsInternalKeyPredict(h, 0);
  const k0b = numsInternalKeyPredict(h, 0);
  assert.deepEqual(k0a, k0b);
  assert.equal(k0a.length, 32);
  const k1 = numsInternalKeyPredict(h, 1);
  assert.ok(!k0a.every((b, i) => b === k1[i]), "outcome index must change the key");
  // lifts (no throw) and is even-Y x-only
  schnorr.utils.lift_x(bytesToNumberBE(k0a));
  assert.throws(() => numsInternalKeyPredict("zz", 0), /bad market hash/);
  assert.throws(() => numsInternalKeyPredict(h, 4), /0-3/);
});

/* ---------------- fee math + payout proportionality ---------------- */

test("largestRemainder is grain-exact", () => {
  assert.deepEqual(largestRemainder([100, 50, 150], 299_998_275), [99999425, 49999713, 149999137]);
  const out = largestRemainder([7, 3], 100);
  assert.equal(out.reduce((a, b) => a + b, 0), 100);
  assert.deepEqual(largestRemainder([1, 1, 1], 10), [4, 3, 3]); // remainder to lowest index on ties
});

test("award payout plan: pinned proportional shares", () => {
  const norm = fixtureSpec();
  const contracts = allOutcomeContracts(norm);
  const positions = [
    { outcomeIndex: 0, txid: "11".repeat(32), vout: 0, value: 100_000_000, funderAddr: funderAddr("pf1") },
    { outcomeIndex: 0, txid: "22".repeat(32), vout: 1, value: 50_000_000, funderAddr: funderAddr("pf2") },
    { outcomeIndex: 1, txid: "33".repeat(32), vout: 0, value: 150_000_000, funderAddr: funderAddr("pf3") },
  ];
  const plan = planAwardPayout({ norm, contracts, positions, winIndex: 0, feeRateGrainsPerVByte: 5 });
  assert.equal(plan.vBytes, 345);
  assert.equal(plan.fee, 1725);
  assert.equal(plan.totalPot, 300_000_000);
  assert.equal(plan.winningPot, 150_000_000);
  // winner 1: 100M/150M of the pot minus fee share; winner 2: 50M/150M
  assert.deepEqual(plan.outputs.map((o) => o.value), [199998850, 99999425]);
  assert.equal(plan.outputs.reduce((a, o) => a + o.value, 0), plan.totalPot - plan.fee);
  assert.ok(plan.outputs.every((o) => o.value >= DUST_GRAIN));
});

test("award plan refuses: no winners, dust payouts, fee eats pot", () => {
  const norm = fixtureSpec();
  const contracts = allOutcomeContracts(norm);
  const mk = (v, oi = 1) => ({ outcomeIndex: oi, txid: "44".repeat(32), vout: 0, value: v, funderAddr: funderAddr("x" + v) });
  assert.throws(
    () => planAwardPayout({ norm, contracts, positions: [mk(1_000_000)], winIndex: 0, feeRateGrainsPerVByte: 5 }),
    /no positions on the winning outcome/
  );
  // tiny winner's pro-rata share is eaten below dust by the fee -> refused
  assert.throws(
    () => planAwardPayout({
      norm, contracts,
      positions: [
        { outcomeIndex: 0, txid: "aa".repeat(32), vout: 0, value: 546, funderAddr: funderAddr("w1") },
        { outcomeIndex: 0, txid: "bb".repeat(32), vout: 0, value: 100_000_000, funderAddr: funderAddr("w2") },
      ],
      winIndex: 0, feeRateGrainsPerVByte: 2000, // high rate: tiny winner's share drops below dust
    }),
    /below dust/
  );
});

test("void plan refunds stakes minus pro-rata fee, locktime = resolveH", () => {
  const norm = fixtureSpec();
  const contracts = allOutcomeContracts(norm);
  const positions = [
    { outcomeIndex: 0, txid: "11".repeat(32), vout: 0, value: 100_000_000, funderAddr: funderAddr("vf1") },
    { outcomeIndex: 1, txid: "22".repeat(32), vout: 0, value: 100_000_000, funderAddr: funderAddr("vf2") },
  ];
  const plan = planVoidRefund({ norm, contracts, positions, feeRateGrainsPerVByte: 5 });
  assert.equal(plan.kind, "void");
  assert.equal(plan.locktime, 902000);
  assert.equal(plan.outputs.reduce((a, o) => a + o.value, 0), plan.totalPot - plan.fee);
  for (const o of plan.outputs) {
    assert.ok(o.value < o.stake && o.value >= DUST_GRAIN);
    assert.ok(o.feeShare > 0);
  }
  assert.equal(plan.inputs[0].leafScript.length, contracts[0].leafB.length); // refund leaf
});

test("feeForVBytes + scriptPathVBytes sanity", () => {
  assert.equal(feeForVBytes(345, 5), 1725);
  assert.equal(feeForVBytes(100, 2.5), 250);
  assert.throws(() => feeForVBytes(100, 0), /positive/);
  const v1 = scriptPathVBytes({ nIn: 1, nOut: 1, scriptLen: 34 });
  const v2 = scriptPathVBytes({ nIn: 2, nOut: 1, scriptLen: 34 });
  assert.ok(v2 > v1);
  assert.equal(v1, 137); // pinned single-input award-spend shape
});

/* ---------------- multi-input sighash lineage ---------------- */

test("1-input multi sighash byte-equals the audited escrow digest", () => {
  const norm = fixtureSpec();
  const c = outcomeContract(norm, 0);
  const inp = { txid: "aa".repeat(32), vout: 0, value: 100_000, spk: c.spk, sequence: 0xffffffff };
  const outs = [{ program: c.tweakedX, value: 99_000 }];
  const mine = tapSighashMulti(net, [inp], outs, 0, c.leafA, {});
  const audited = scriptPathSigDigestEx(net, inp, outs, c.leafA, {});
  assert.deepEqual(mine, audited);
});

test("multi-input digest varies per input index", () => {
  const norm = fixtureSpec();
  const c = outcomeContract(norm, 0);
  const mk = (t) => ({ txid: t, vout: 0, value: 100_000, spk: c.spk, sequence: 0xffffffff });
  const ins = [mk("aa".repeat(32)), mk("bb".repeat(32))];
  const outs = [{ program: c.tweakedX, value: 198_000 }];
  const d0 = tapSighashMulti(net, ins, outs, 0, c.leafA, {});
  const d1 = tapSighashMulti(net, ins, outs, 1, c.leafA, {});
  assert.ok(!d0.every((b, i) => b === d1[i]));
});

/* ---------------- bundle sign + verify ---------------- */

function signedAwardFixture() {
  const norm = fixtureSpec();
  const contracts = allOutcomeContracts(norm);
  const positions = [
    { outcomeIndex: 0, txid: "11".repeat(32), vout: 0, value: 100_000_000, funderAddr: funderAddr("sf1") },
    { outcomeIndex: 0, txid: "22".repeat(32), vout: 1, value: 50_000_000, funderAddr: funderAddr("sf2") },
    { outcomeIndex: 1, txid: "33".repeat(32), vout: 0, value: 150_000_000, funderAddr: funderAddr("sf3") },
  ];
  const plan = planAwardPayout({ norm, contracts, positions, winIndex: 0, feeRateGrainsPerVByte: 5 });
  const arbW = walletFromMnemonic(ARB_MNEMONIC, net);
  const bundle = signBundle({
    norm, plan,
    privHex: bytesToHex(arbW.priv), signingXOnlyHex: norm.arbiterXOnly, kind: "award",
  });
  return { norm, contracts, bundle, plan, canonical: canonicalMarketJSON(norm) };
}

test("award bundle: pinned txid, every signature re-verifies against recomputed digests", () => {
  const { norm, bundle } = signedAwardFixture();
  assert.equal(bundle.txid, "2d95f7bb5bd78f6c9f3d547f76393bd8aea33542009cab4592edf4f11c43f63b");
  assert.deepEqual(bundle.outputs.map((o) => o.value), [199998850, 99999425]);
  assert.equal(bundle.inputs.length, 3);
  for (const inp of bundle.inputs) {
    assert.equal(inp.sig.length, 128);
  }
  // per-input Schnorr re-verification against recomputed multi-input digests
  const contracts = allOutcomeContracts(norm);
  const sigInputs = bundle.inputs.map((inp) => {
    const c = contracts[inp.outcomeIndex];
    return {
      txid: inp.txid, vout: inp.vout, value: inp.value, spk: c.spk,
      sequence: 0xffffffff, leafScript: c.leafA, controlBlock: c.controlBlocks[0], stackItems: [],
    };
  });
  const sigOutputs = bundle.outputs.map((o) => {
    const { program } = decodeBech32m(o.address, "prl");
    return { program, value: o.value };
  });
  bundle.inputs.forEach((inp, i) => {
    const digest = tapSighashMulti(net, sigInputs, sigOutputs, i, sigInputs[i].leafScript, {});
    assert.ok(verifySchnorrSig(inp.sig, digest, norm.arbiterXOnly), `input ${i} signature must verify`);
  });
});

test("verifyBundle PROVEN on honest award bundle", () => {
  const { norm, bundle, canonical } = signedAwardFixture();
  const r = verifyBundle({ descriptor: marketDescriptor(norm), marketJSON: canonical, bundle });
  assert.deepEqual(r.failures, []);
  assert.equal(r.proven, true);
  assert.equal(r.summary, "PROVEN");
});

test("verifyBundle NOT PROVEN on tampered payout", () => {
  const { norm, bundle, canonical } = signedAwardFixture();
  const evil = JSON.parse(JSON.stringify(bundle));
  evil.outputs[0].value += 1000; // steal 1000 grains
  const r = verifyBundle({ descriptor: marketDescriptor(norm), marketJSON: canonical, bundle: evil });
  assert.equal(r.proven, false);
  assert.equal(r.summary, "NOT PROVEN");
  assert.ok(r.failures.length > 0);
});

test("verifyBundle NOT PROVEN on tampered signature", () => {
  const { norm, bundle, canonical } = signedAwardFixture();
  const evil = JSON.parse(JSON.stringify(bundle));
  const sig = evil.inputs[0].sig;
  evil.inputs[0].sig = (sig[0] === "0" ? "1" : "0") + sig.slice(1);
  const r = verifyBundle({ descriptor: marketDescriptor(norm), marketJSON: canonical, bundle: evil });
  assert.equal(r.proven, false);
  assert.ok(r.failures.some((f) => /signature INVALID/.test(f)));
});

test("verifyBundle NOT PROVEN on descriptor/market mismatch", () => {
  const { bundle, canonical } = signedAwardFixture();
  const r = verifyBundle({ descriptor: marketDescriptor(fixtureSpec()).replace("901000", "901001"), marketJSON: canonical, bundle });
  assert.equal(r.proven, false);
});

test("verifyBundle NOT PROVEN when market JSON arbiter key swapped", () => {
  const { norm, bundle } = signedAwardFixture();
  const evilJSON = canonicalMarketJSON({ ...norm, arbiterXOnly: "22".repeat(32), refundXOnly: "22".repeat(32) });
  const r = verifyBundle({ descriptor: marketDescriptor(norm), marketJSON: evilJSON, bundle });
  assert.equal(r.proven, false);
});

test("void bundle signs via refund leaf and verifies PROVEN", () => {
  const norm = fixtureSpec();
  const contracts = allOutcomeContracts(norm);
  const positions = [
    { outcomeIndex: 0, txid: "11".repeat(32), vout: 0, value: 100_000_000, funderAddr: funderAddr("vf1") },
    { outcomeIndex: 1, txid: "22".repeat(32), vout: 0, value: 100_000_000, funderAddr: funderAddr("vf2") },
  ];
  const plan = planVoidRefund({ norm, contracts, positions, feeRateGrainsPerVByte: 5 });
  const arbW = walletFromMnemonic(ARB_MNEMONIC, net); // refund key defaults to arbiter
  const bundle = signBundle({
    norm, plan, privHex: bytesToHex(arbW.priv), signingXOnlyHex: norm.refundXOnly, kind: "void",
  });
  assert.equal(bundle.kind, "void");
  assert.equal(bundle.locktime, 902000);
  const r = verifyBundle({ descriptor: marketDescriptor(norm), marketJSON: canonicalMarketJSON(norm), bundle });
  assert.deepEqual(r.failures, []);
  assert.equal(r.proven, true);
});

test("signBundle refuses a signing key that does not match the leaf key", () => {
  const { norm, plan } = signedAwardFixture();
  const wrong = walletFromPriv(sha256(TE.encode("wrong-key")), net);
  assert.throws(
    () => signBundle({ norm, plan, privHex: bytesToHex(wrong.priv), signingXOnlyHex: norm.arbiterXOnly, kind: "award" }),
    /failed re-verification/
  );
});

/* ---------------- formatting helpers ---------------- */

test("fmtPRL / parsePRLToGrains round-trip", () => {
  assert.equal(fmtPRL(199998850n), "1.9999885");
  assert.equal(fmtPRL(100_000_000n), "1.0");
  assert.equal(parsePRLToGrains("1.9999885").toString(), "199998850");
  assert.equal(parsePRLToGrains("0.00000546").toString(), "546");
  assert.throws(() => parsePRLToGrains("abc"), /bad PRL/);
  assert.equal(GRAIN_PER_PRL, 100_000_000);
  assert.equal(DUST_GRAIN, 546);
  assert.equal(BLOCK_TARGET_SECONDS, 194);
});

test("blocksToCountdown + impliedProbabilities", () => {
  assert.equal(blocksToCountdown(0), "closed");
  assert.equal(blocksToCountdown(-5), "closed");
  assert.ok(blocksToCountdown(1000).includes("d"));
  assert.ok(blocksToCountdown(10).includes("m"));
  assert.deepEqual(impliedProbabilities([100, 300]), [0.25, 0.75]);
  assert.deepEqual(impliedProbabilities([0, 0]), [0, 0]);
});
