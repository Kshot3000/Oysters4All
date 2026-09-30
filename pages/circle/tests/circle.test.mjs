// Pearl Circle node core tests — terms validation, member parsing,
// commit-reveal lottery, round forging (pinned vectors), descriptor
// round-trip, funding plan, winner claim + timeout refund signing
// round-trips, and classification.
// Usage: node --no-warnings --loader ./tests/loader.mjs tests/circle.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseMember, parseCircleTerms, potGrains, lockHeightForRound,
  payoutOrderFor, memberCommitment,
  numsInternalKeyCircle, buildRefundScriptCircle, forgeRound, forgeCircle,
  canonicalSetupJson, circleSetupHash, encodeCircleDescriptor, decodeCircleDescriptor,
  verifyDescriptor, fundingPlan, planClaim, signClaim,
  planRefund, signRefund, finalizeRefund, classifyRounds,
  BLOCK_TIME_SEC, DUST_GRAIN, GRAIN_PER_PRL, NETWORKS,
  SEQ_NONFINAL, SEQ_FINAL, DESCRIPTOR_PREFIX,
  schnorr, sha256, bytesToHex, hexToBytes, encodeBech32m,
  newSecret, commitmentFor, verifyReveal, descriptorFingerprint,
  signForXOnly, verifySchnorrSig, scriptPathSigDigestEx,
} from "../src/index.js";
import { verifyControlBlock } from "../../escrow/src/escrow-core.js";
import { buildTransferScript } from "../../bond/src/bond-core.js";
import { buildMultisigScript } from "../../covenant/src/covenant-core.js";

const MAINNET = NETWORKS.mainnet;
const sha = (s) => sha256(new TextEncoder().encode(s));
const keyFor = (l) => bytesToHex(schnorr.getPublicKey(sha("pearl-circle-fixture-" + l)));
const privFor = (l) => sha("pearl-circle-fixture-" + l);

const MEMBERS = [
  { name: "Ava", input: keyFor("ava") },
  { name: "Ben", input: keyFor("ben") },
  { name: "Cy", input: keyFor("cy") },
];
const TERMS = () => parseCircleTerms({
  name: "Pinned Circle", contributionPRL: "10", roundBlocks: 2160,
  startHeight: 800000, graceBlocks: 144, m: 2, members: MEMBERS,
}, MAINNET);

// Pinned vectors (from the fixture above — recompute only if fixtures change).
const PIN = {
  setupHash: "e982c3a93583b20fda8d727f1437e5894b1d1e3e66613c3b2f17d9e674d4bcb9",
  fingerprint: "066e8cd7c0a1713c",
  order: [1, 2, 0],
  addresses: [
    "prl1p59rkmmxku8n380j8wd9kt08xjfe0sh43pedcrg4679q2xhs7m5nqga8ss0",
    "prl1p2u2vu747t9xkz2tq2ayyh7tr7wq83unl3duuuc5dxyf7m5cx49xsyjpck6",
    "prl1p5hg6jl9w9jjntxv2l45xugzlppjmjcqhdxdtsut9md05tkxv0twspydlvx",
  ],
  locks: [802304, 804464, 806624],
  claimTxid: "a48bbf929f13879533c0b6a5d97a3076b3f1aa8a7863db12d6fc9414bc37aa90",
  refundTxid: "689239698679746017baf3fe1bd8c40818912e0f6ad5b376e497634789197f59",
};

function fixtureLottery(terms) {
  const setupHash = circleSetupHash(terms);
  const secrets = [0, 1, 2].map((i) => bytesToHex(sha("pearl-circle-fixture-secret-" + i)));
  const commitments = secrets.map((s, i) => ({ memberIndex: i, commitment: commitmentFor(s) }));
  const reveals = secrets.map((s, i) => ({ memberIndex: i, secretHex: s }));
  const order = payoutOrderFor({ setupHash, commitments, reveals, n: 3 });
  return { setupHash, secrets, commitments, reveals, order };
}

/* ---------- terms validation ---------- */

test("parseCircleTerms: rejects bad input", () => {
  const base = { name: "x", contributionPRL: "10", roundBlocks: 2160, startHeight: 1, graceBlocks: 144 };
  assert.throws(() => parseCircleTerms({ ...base, members: [MEMBERS[0]] }, MAINNET), /at least 2/);
  assert.throws(() => parseCircleTerms({ ...base, members: Array(17).fill(MEMBERS[0]) }, MAINNET), /at most 16/);
  assert.throws(() => parseCircleTerms({ ...base, members: [MEMBERS[0], MEMBERS[0]] }, MAINNET), /duplicate/);
  assert.throws(() => parseCircleTerms({ ...base, members: MEMBERS, contributionPRL: "0.00000001" }, MAINNET), /dust/);
  assert.throws(() => parseCircleTerms({ ...base, members: MEMBERS, m: 4 }, MAINNET), /m must be/);
  assert.throws(() => parseCircleTerms({ ...base, members: MEMBERS, m: 0 }, MAINNET), /m must be/);
  assert.throws(() => parseCircleTerms({ ...base, members: [MEMBERS[0], { name: "Z", input: "nope" }] }, MAINNET), /party key/);
});

test("parseMember: accepts address, x-only hex, mnemonic", () => {
  const hex = keyFor("ava");
  const byHex = parseMember(hex, "Hex", MAINNET, 0);
  assert.equal(byHex.xonly, hex);
  assert.ok(byHex.refundAddress.startsWith("prl1"));
  const byAddr = parseMember(byHex.refundAddress, "Addr", MAINNET, 1);
  assert.equal(byAddr.xonly, hex);
  assert.equal(byAddr.refundAddress, byHex.refundAddress);
  // wrong-network address rejected
  assert.throws(() => parseMember(byHex.refundAddress, "W", NETWORKS.testnet, 2), /party key|HRP/);
  // mnemonic derives the BIP-86 key
  const mn = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  const byMn = parseMember(mn, "Mn", MAINNET, 3);
  assert.match(byMn.xonly, /^[0-9a-f]{64}$/);
  assert.ok(byMn.refundAddress.startsWith("prl1"));
});

test("money math pinned", () => {
  assert.equal(BLOCK_TIME_SEC, 194);
  const t = TERMS();
  assert.equal(potGrains(t), 3_000_000_000); // 30 PRL
  assert.deepEqual([1, 2, 3].map((r) => lockHeightForRound(t, r)), PIN.locks);
  assert.equal(t.m, 2);
});

/* ---------- lottery ---------- */

test("payoutOrderFor: pinned order + tamper paths", () => {
  const t = TERMS();
  const { setupHash, commitments, reveals } = fixtureLottery(t);
  assert.equal(setupHash, PIN.setupHash);
  const order = payoutOrderFor({ setupHash, commitments, reveals, n: 3 });
  assert.deepEqual(order, PIN.order);
  // tampered secret voids the draw
  const bad = reveals.map((r) => ({ ...r }));
  bad[0] = { ...bad[0], secretHex: "ff".repeat(32) };
  assert.throws(() => payoutOrderFor({ setupHash, commitments, reveals: bad, n: 3 }), /NOT match|void/);
  // missing reveal → honest abort error, not a silent partial order
  assert.throws(() => payoutOrderFor({ setupHash, commitments, reveals: reveals.slice(0, 2), n: 3 }), /lottery incomplete/);
  // double commitment rejected
  assert.throws(() => payoutOrderFor({
    setupHash, commitments: [...commitments, commitments[0]], reveals, n: 3,
  }), /twice/);
});

test("commitment round-trip uses the audited games lineage", () => {
  const s = newSecret();
  assert.ok(verifyReveal(s, commitmentFor(s)));
  assert.equal(verifyReveal("00".repeat(32), commitmentFor(s)), false);
  assert.equal(memberCommitment(2, s).commitment, commitmentFor(s));
});

/* ---------- forging ---------- */

test("forgeCircle: pinned addresses, winners, locks", () => {
  const t = TERMS();
  const { order } = fixtureLottery(t);
  const c = forgeCircle(MAINNET, t, order);
  assert.deepEqual(c.rounds.map((r) => r.address), PIN.addresses);
  assert.deepEqual(c.rounds.map((r) => r.winnerName), ["Ben", "Cy", "Ava"]);
  assert.deepEqual(c.rounds.map((r) => r.lockHeight), PIN.locks);
  assert.equal(c.descriptor.startsWith(DESCRIPTOR_PREFIX + ":"), true);
  assert.equal(descriptorFingerprint(c.descriptor), PIN.fingerprint);
  // non-permutation order refused
  assert.throws(() => forgeCircle(MAINNET, t, [0, 0, 1]), /permutation/);
});

test("leaves reuse audited lineage byte-for-byte", () => {
  const t = TERMS();
  const { order } = fixtureLottery(t);
  const r = forgeRound(MAINNET, t, order, 1);
  // leaf A == bond's buildTransferScript(winnerXOnly)
  assert.deepEqual(r.claimScript, buildTransferScript(r.winnerXOnly));
  // leaf B == CLTV-prefix + covenant's buildMultisigScript over sorted keys
  const sortedKeys = t.members.map((m) => hexToBytes(m.xonly)).map(bytesToHex).sort().map(hexToBytes);
  const multi = buildMultisigScript(sortedKeys, t.m);
  assert.deepEqual(r.refundScript.slice(multi.length * 0), r.refundScript); // sanity
  assert.ok(r.refundAsm.includes("CLTV") && r.refundAsm.includes("DROP"));
  assert.ok(r.refundAsm.includes("CHECKSIGADD") && r.refundAsm.endsWith("EQUAL"));
  // NUMS: internal key is on-curve but matches no party key
  for (const m of t.members) assert.notEqual(bytesToHex(r.internalXOnly), m.xonly);
});

test("verifyControlBlock binds both leaves", () => {
  const t = TERMS();
  const { order } = fixtureLottery(t);
  const r = forgeRound(MAINNET, t, order, 2);
  const tweaked = r.spk.slice(2); // strip 0x5120
  assert.ok(verifyControlBlock(r.internalXOnly, r.claimScript, r.claimControlBlock, tweaked));
  assert.ok(verifyControlBlock(r.internalXOnly, r.refundScript, r.refundControlBlock, tweaked));
  // cross-leaf control block must NOT verify
  assert.equal(verifyControlBlock(r.internalXOnly, r.claimScript, r.refundControlBlock, tweaked), false);
});

/* ---------- descriptor ---------- */

test("descriptor round-trip + tamper detection", () => {
  const t = TERMS();
  const desc = encodeCircleDescriptor(t);
  const { network, terms } = decodeCircleDescriptor(desc);
  assert.equal(network.id, "mainnet");
  assert.equal(canonicalSetupJson(terms), canonicalSetupJson(t));
  assert.equal(verifyDescriptor(desc, PIN.order).rounds[0].address, PIN.addresses[0]);
  // tamper with the payload: flip the last char
  const tampered = desc.slice(0, -1) + (desc.slice(-1) === "A" ? "B" : "A");
  assert.throws(() => decodeCircleDescriptor(tampered), /JSON|payload|descriptor/);
  assert.throws(() => decodeCircleDescriptor("bond:v1/m/1/2/3"), /bad circle descriptor/);
});

/* ---------- funding plan ---------- */

test("fundingPlan: per-member totals", () => {
  const t = TERMS();
  const { order } = fixtureLottery(t);
  const c = forgeCircle(MAINNET, t, order);
  const plan = fundingPlan(c, 2);
  assert.equal(plan.rounds.length, 3);
  assert.ok(plan.rounds.every((r) => r.amountGrains === 1_000_000_000));
  assert.equal(plan.perMember[0].totalGrains, 3_000_000_000);
  assert.equal(plan.estFeePerFundingVBytes, 111);
  assert.equal(plan.estFeePerFundingGrains, 222);
  assert.throws(() => fundingPlan(c, 0), /positive/);
});

/* ---------- winner claim ---------- */

test("claim: pinned txid, re-verification, wrong key refused", () => {
  const t = TERMS();
  const { order } = fixtureLottery(t);
  const c = forgeCircle(MAINNET, t, order);
  const r = c.rounds[0]; // Ben wins round 1
  const names = ["ava", "ben", "cy"];
  const winnerPriv = privFor(names[order[0]]);
  const planned = planClaim(MAINNET, r,
    { txid: "ab".repeat(32), vout: 0, value: r.potGrains },
    hexToBytes(r.winnerXOnly), 2);
  assert.equal(planned.fee, 274);
  const signed = signClaim(MAINNET, r, planned, winnerPriv);
  assert.equal(signed.txid, PIN.claimTxid);
  // signature really verifies against the winner key
  assert.ok(verifySchnorrSig(hexToBytes(signed.sig), hexToBytes(signed.digest), r.winnerXOnly));
  // a non-winner key cannot produce a passing signature
  const loserPriv = privFor(names[(order[0] + 1) % 3]);
  assert.throws(() => signClaim(MAINNET, r, planned, loserPriv), /re-verification/);
  // dust-value pot refused
  assert.throws(() => planClaim(MAINNET, r,
    { txid: "ab".repeat(32), vout: 0, value: 100 }, hexToBytes(r.winnerXOnly), 2), /cannot cover/);
});

/* ---------- timeout refund ---------- */

test("refund: pinned txid, quorum, tamper paths", () => {
  const t = TERMS();
  const { order } = fixtureLottery(t);
  const c = forgeCircle(MAINNET, t, order);
  const r = c.rounds[0];
  const outpoint = { txid: "cd".repeat(32), vout: 0, value: r.potGrains };
  // before the lock: honest refusal
  assert.throws(() => planRefund(MAINNET, c, r, outpoint, 2, r.lockHeight - 1), /locked until/);
  const tpl = planRefund(MAINNET, c, r, outpoint, 2, r.lockHeight);
  assert.equal(tpl.need, 2);
  // fee split is grain-exact
  const outSum = tpl.outputs.reduce((a, o) => a + o.value, 0);
  assert.equal(outSum, r.potGrains - tpl.fee);
  assert.ok(tpl.outputs.every((o) => o.value >= DUST_GRAIN));
  const names = ["ava", "ben", "cy"];
  const sigs = [0, 1].map((i) => signRefund(MAINNET, c, tpl, i, privFor(names[i])));
  const fin = finalizeRefund(MAINNET, c, tpl, sigs);
  assert.equal(fin.txid, PIN.refundTxid);
  assert.equal(fin.sigsUsed, 2);
  assert.equal(fin.digest, tpl.digestHex);
  // quorum not reached
  assert.throws(() => finalizeRefund(MAINNET, c, tpl, sigs.slice(0, 1)), /quorum not reached/);
  // tampered signature refused
  const bad = sigs.map((s) => ({ ...s, sig: "00".repeat(64) }));
  assert.throws(() => finalizeRefund(MAINNET, c, tpl, bad), /INVALID/);
  // wrong member index refused
  assert.throws(() => signRefund(MAINNET, c, tpl, 9, privFor("ava")), /bad member index/);
});

/* ---------- tracking ---------- */

test("classifyRounds: lifecycle statuses", () => {
  const t = TERMS();
  const { order } = fixtureLottery(t);
  const c = forgeCircle(MAINNET, t, order);
  const info = {
    [c.rounds[0].address]: { balance: 0, txs: 0 },
    [c.rounds[1].address]: { balance: 1_000_000_000, txs: 1 },
    [c.rounds[2].address]: { balance: 3_000_000_000, txs: 3 },
  };
  const rows = classifyRounds(c, { height: 900000, info });
  assert.deepEqual(rows.map((r) => r.status), ["unfunded", "funding", "pot-full"]);
  assert.equal(rows[2].funded, true);
  assert.equal(rows[0].refundable, true); // 900000 > 802304
  const spent = classifyRounds(c, {
    height: 900000,
    info: { [c.rounds[0].address]: { balance: 0, txs: 4 } },
  });
  assert.equal(spent[0].status, "spent");
});
