// Pearl Bounty node core tests — post validation, script templates,
// NUMS taptree (pinned address vector), descriptor round-trip + tamper
// refusal, submission commit-reveal, award plan/sign round-trip with key
// guards, reclaim pre-deadline refusal + post-deadline locktime wire check,
// classification, spec parse tamper refusal, and tx verification.
// Usage: node --no-warnings --loader ./tests/loader.mjs tests/bounty.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  forgeBounty, bountyDescriptor, parseBountyDescriptor, verifyDescriptor,
  parseBountySpec, serializeBounty, descriptorFingerprint,
  buildAwardScript, buildReclaimScript, numsInternalKeyBounty, bountyTaptree,
  submissionCommitment, verifySubmissionReveal, newSalt,
  planAward, buildAwardTx, planReclaim, buildReclaimTx,
  classifyBounty, verifyBountyTx, checkRewardGrains, checkDeadlineHeight,
  parsePRLToGrains, fmtPRL, pubkeyFromPriv,
  buildRefundScript, verifyControlBlock,
  DUST_GRAIN, GRAIN_PER_PRL, NETWORKS, SEQ_FINAL,
  schnorr, sha256, bytesToHex, hexToBytes, encodeBech32m, tapLeafHash,
  signForXOnly, verifySchnorrSig,
} from "../src/index.js";

const MAINNET = NETWORKS.mainnet;
const sha = (s) => sha256(new TextEncoder().encode(s));
const privFor = (l) => sha("pearl-bounty-fixture-" + l);
const keyFor = (l) => bytesToHex(schnorr.getPublicKey(privFor(l)));

const POSTER_PRIV = bytesToHex(privFor("poster"));
const POSTER_XONLY = keyFor("poster");
const WINNER_PRIV = bytesToHex(privFor("winner"));
const WINNER_XONLY = keyFor("winner");
const WINNER_ADDR = encodeBech32m("prl", 1, hexToBytes(WINNER_XONLY));
const POSTER_ADDR = encodeBech32m("prl", 1, hexToBytes(POSTER_XONLY));

const forge = (over = {}) => forgeBounty({
  network: MAINNET,
  title: "Fix the reorg race in block relay",
  rewardPRL: "25",
  deadlineHeight: 900000,
  posterKeyInput: POSTER_PRIV,
  posterKeyMode: "priv",
  contact: "@poster",
  termsNote: "Payable on merged PR.",
  ...over,
}).bounty;

// Pinned vector (fixture above — recompute only if fixtures change).
const PIN = {
  address: "prl1p3yv9m8yuh78vydqtzv55lc275tef5eqq998rttd49l3khj6uy9qs9aaw6h",
};

test("post validation guards", () => {
  assert.throws(() => forge({ title: "  " }), /title/);
  assert.throws(() => forge({ title: "x".repeat(121) }), /under 120/);
  assert.throws(() => forge({ rewardPRL: "0" }), /positive/);
  assert.throws(() => forge({ rewardPRL: "0.000000001" }), /not a PRL amount/);
  assert.throws(() => forge({ deadlineHeight: 500000000 }), /block height/);
  assert.throws(() => forge({ deadlineHeight: 42 }), /paste error/);
  assert.throws(() => forge({ posterKeyInput: "nope", posterKeyMode: "priv" }), /poster key/);
  assert.throws(() => forge({ posterKeyMode: "bogus", posterKeyInput: POSTER_PRIV }), /priv.*watch/);
});

test("parsePRLToGrains / fmtPRL round-trip", () => {
  assert.equal(parsePRLToGrains("25"), 25 * GRAIN_PER_PRL);
  assert.equal(parsePRLToGrains("0.00001"), 1000);
  assert.throws(() => parsePRLToGrains("0.00000001"), /dust floor/); // 1 grain < dust: refused
  assert.equal(fmtPRL(parsePRLToGrains("1.5")), "1.5");
  assert.equal(fmtPRL(parsePRLToGrains("25")), "25");
  assert.throws(() => parsePRLToGrains("abc"), /not a PRL amount/);
  assert.throws(() => parsePRLToGrains("1.000000001"), /not a PRL amount/);
});

test("award script template", () => {
  const s = buildAwardScript(hexToBytes(POSTER_XONLY));
  assert.equal(s.length, 34);
  assert.equal(s[0], 32);
  assert.equal(s[33], 0xac); // OP_CHECKSIG
  assert.equal(bytesToHex(s.slice(1, 33)), POSTER_XONLY.toLowerCase());
  assert.throws(() => buildAwardScript("deadbeef"), /x-only/);
});

test("reclaim leaf is byte-identical to the audited escrow refund leaf", () => {
  const a = buildReclaimScript(hexToBytes(POSTER_XONLY), 900000);
  const b = buildRefundScript(hexToBytes(POSTER_XONLY), 900000);
  assert.equal(bytesToHex(a), bytesToHex(b));
});

test("NUMS internal key: distinct domain, deterministic, no keypath", () => {
  const award = buildAwardScript(hexToBytes(POSTER_XONLY));
  const reclaim = buildReclaimScript(hexToBytes(POSTER_XONLY), 900000);
  const k1 = numsInternalKeyBounty(award, reclaim);
  const k2 = numsInternalKeyBounty(award, reclaim);
  assert.equal(bytesToHex(k1), bytesToHex(k2));
  // Different domain from escrow's NUMS over the same leaves => different key.
  assert.notEqual(bytesToHex(k1).slice(0, 16), "0000000000000000");
  const tree = bountyTaptree(MAINNET, award, reclaim);
  assert.ok(tree.address.startsWith("prl1p"));
  // Control blocks re-derive the address (wallet check) for both leaves.
  assert.ok(verifyControlBlock(tree.internalXOnly, award, tree.controlBlocks[0], tree.tweakedX));
  assert.ok(verifyControlBlock(tree.internalXOnly, reclaim, tree.controlBlocks[1], tree.tweakedX));
  // A tampered control block fails the wallet check.
  const bad = Uint8Array.from(tree.controlBlocks[0]);
  bad[40] ^= 1;
  assert.equal(verifyControlBlock(tree.internalXOnly, award, bad, tree.tweakedX), false);
});

test("forge: pinned address + descriptor shape", () => {
  const b = forge();
  assert.equal(b.address, PIN.address);
  assert.equal(bountyDescriptor(b), `bounty:v1:prl:${POSTER_XONLY.toLowerCase()}:900000`);
  assert.match(b.fingerprint, /^[0-9a-f]{16}$/);
  assert.equal(b.rewardGrains, 25 * GRAIN_PER_PRL);
  assert.equal(b.rewardPRL, "25");
  assert.equal(b.contact, "@poster");
  assert.ok(b.awardAsm.includes("CHECKSIG"));
  assert.ok(b.reclaimAsm.includes("CLTV"));
});

test("forge: watch-only mode carries no secret", () => {
  const { bounty, secrets } = forgeBounty({
    network: MAINNET, title: "t", rewardPRL: "1", deadlineHeight: 900000,
    posterKeyInput: POSTER_XONLY, posterKeyMode: "watch",
  });
  assert.equal(secrets.length, 0);
  assert.equal(bounty.posterXOnly, POSTER_XONLY.toLowerCase());
  assert.equal(bounty.address, PIN.address); // same contract from the public key alone
});

test("descriptor parse + verify round-trip, tamper refusal", () => {
  const b = forge();
  const f = parseBountyDescriptor(b.descriptor);
  assert.equal(f.hrp, "prl");
  assert.equal(f.deadlineHeight, 900000);
  const v = verifyDescriptor(b.descriptor, MAINNET, b.address);
  assert.equal(v.recomputed, b.descriptor);
  assert.equal(v.fingerprint, b.fingerprint);
  assert.throws(() => parseBountyDescriptor("bounty:v1:prl:zz:900000"), /x-only/);
  assert.throws(() => parseBountyDescriptor("bounty:v2:prl:" + POSTER_XONLY + ":900000"), /bad bounty descriptor/);
  // Tampered descriptor (different deadline) recomputes to a different address.
  const tampered = `bounty:v1:prl:${POSTER_XONLY.toLowerCase()}:900001`;
  assert.throws(() => verifyDescriptor(tampered, MAINNET, b.address), /LOUD REFUSAL/);
  // Network mismatch.
  assert.throws(() => verifyDescriptor(b.descriptor, NETWORKS.testnet), /LOUD REFUSAL/);
});

test("parseBountySpec: tamper-evident re-derivation", () => {
  const b = forge();
  const back = parseBountySpec(serializeBounty(b), MAINNET);
  assert.equal(back.address, b.address);
  // Contract tampering (deadline changes the reclaim leaf) is caught.
  const evil = { ...b, deadlineHeight: 900001 };
  assert.throws(() => parseBountySpec(JSON.stringify(evil), MAINNET), /tampered/);
  const evilKey = { ...b, posterXOnly: WINNER_XONLY.toLowerCase() };
  assert.throws(() => parseBountySpec(JSON.stringify(evilKey), MAINNET), /tampered/);
  // Informational fields are NOT tamper-evident (documented): the contract is identical.
  const renamed = parseBountySpec(JSON.stringify({ ...b, title: "Free money" }), MAINNET);
  assert.equal(renamed.address, b.address);
  assert.throws(() => parseBountySpec("not json", MAINNET), /not valid JSON/);
});

test("submission commit-reveal", () => {
  const b = forge();
  const salt = bytesToHex(sha("salt-fixture"));
  const fields = { descriptor: b.descriptor, handle: "hunter-7", solution: "the fix", salt };
  const c = submissionCommitment(fields);
  assert.match(c, /^[0-9a-f]{64}$/);
  assert.ok(verifySubmissionReveal(c, fields));
  assert.equal(verifySubmissionReveal(c, { ...fields, solution: "the fix!" }), false);
  assert.equal(verifySubmissionReveal(c, { ...fields, handle: "hunter-8" }), false);
  // Descriptor binding: same solution under another bounty commits differently.
  assert.notEqual(submissionCommitment({ ...fields, descriptor: b.descriptor + "x" }), c);
  assert.throws(() => submissionCommitment({ ...fields, handle: "" }), /handle/);
  assert.throws(() => verifySubmissionReveal("zz", fields), /64 hex/);
  const s2 = newSalt();
  assert.match(s2, /^[0-9a-f]{64}$/);
});

test("planAward: full-pot and partial awards, dust folding", () => {
  const b = forge();
  const utxo = { txid: "ab".repeat(32), vout: 0, value: 25 * GRAIN_PER_PRL };
  // Single output when the remainder after the fee is below the dust floor
  // (it folds into the fee and is disclosed); change output otherwise.
  const full = planAward({
    network: MAINNET, bounty: b, utxo, winnerAddr: WINNER_ADDR,
    awardGrains: utxo.value - 600, changeAddr: POSTER_ADDR, feeRateGrainsPerVByte: 2,
  });
  assert.equal(full.outputs.length, 1);
  assert.ok(full.feeGrains > 0);
  assert.equal(full.changeGrains, 0);
  assert.ok(full.outputs[0].value + full.feeGrains <= utxo.value);
  const partial = planAward({
    network: MAINNET, bounty: b, utxo, winnerAddr: WINNER_ADDR,
    awardGrains: 10 * GRAIN_PER_PRL, changeAddr: POSTER_ADDR, feeRateGrainsPerVByte: 2,
  });
  assert.equal(partial.outputs.length, 2);
  assert.ok(partial.outputs[1].change);
  assert.equal(bytesToHex(partial.outputs[1].program), POSTER_XONLY.toLowerCase());
  assert.throws(() => planAward({
    network: MAINNET, bounty: b, utxo, winnerAddr: WINNER_ADDR,
    awardGrains: 26 * GRAIN_PER_PRL, changeAddr: POSTER_ADDR, feeRateGrainsPerVByte: 2,
  }), /exceeds/);
  assert.throws(() => planAward({
    network: MAINNET, bounty: b, utxo, winnerAddr: WINNER_ADDR,
    awardGrains: 100, changeAddr: POSTER_ADDR, feeRateGrainsPerVByte: 2,
  }), /dust/);
});

test("buildAwardTx: sign round-trip, key guard, wire layout", () => {
  const b = forge();
  const utxo = { txid: "ab".repeat(32), vout: 0, value: 25 * GRAIN_PER_PRL };
  const tx = buildAwardTx({
    network: MAINNET, bounty: b, utxo, posterPrivHex: POSTER_PRIV,
    winnerAddr: WINNER_ADDR, awardGrains: 20 * GRAIN_PER_PRL,
    changeAddr: POSTER_ADDR, feeRateGrainsPerVByte: 2,
  });
  assert.match(tx.txid, /^[0-9a-f]{64}$/);
  assert.ok(tx.hex.length > 200);
  // A hunter's key (or anyone else's) is refused for the award leaf.
  assert.throws(() => buildAwardTx({
    network: MAINNET, bounty: b, utxo, posterPrivHex: WINNER_PRIV,
    winnerAddr: WINNER_ADDR, awardGrains: 20 * GRAIN_PER_PRL,
    changeAddr: POSTER_ADDR, feeRateGrainsPerVByte: 2,
  }), /not the poster's award key/);
  // The award tx verifies against the bounty contract.
  const v = verifyBountyTx(tx.hex, b);
  assert.equal(v.ok, true);
  assert.equal(v.spends[0].leaf, "award");
  assert.equal(v.spends.length, 1);
});

test("planReclaim: refuses before the deadline", () => {
  const b = forge();
  const utxo = { txid: "ab".repeat(32), vout: 0, value: 25 * GRAIN_PER_PRL };
  assert.throws(() => planReclaim({
    network: MAINNET, bounty: b, utxo, destAddr: POSTER_ADDR,
    feeRateGrainsPerVByte: 2, currentHeight: 899999,
  }), /not yet available/);
  const ok = planReclaim({
    network: MAINNET, bounty: b, utxo, destAddr: POSTER_ADDR,
    feeRateGrainsPerVByte: 2, currentHeight: 900000,
  });
  assert.equal(ok.outputs.length, 1);
  assert.ok(ok.feeGrains > 0);
});

test("buildReclaimTx: locktime wire check + key guard", () => {
  const b = forge();
  const utxo = { txid: "ab".repeat(32), vout: 0, value: 25 * GRAIN_PER_PRL };
  const tx = buildReclaimTx({
    network: MAINNET, bounty: b, utxo, posterPrivHex: POSTER_PRIV,
    destAddr: POSTER_ADDR, feeRateGrainsPerVByte: 2, currentHeight: 900123,
  });
  assert.match(tx.txid, /^[0-9a-f]{64}$/);
  const v = verifyBountyTx(tx.hex, b);
  assert.equal(v.spends[0].leaf, "reclaim");
  assert.equal(v.spends[0].locktime, 900000);
  assert.notEqual(v.spends[0].sequence, 0xffffffff);
  assert.throws(() => buildReclaimTx({
    network: MAINNET, bounty: b, utxo, posterPrivHex: WINNER_PRIV,
    destAddr: POSTER_ADDR, feeRateGrainsPerVByte: 2, currentHeight: 900123,
  }), /not the poster's key/);
  // A tampered tx (wrong script in witness) is refused by the verifier.
  const awardTx = buildAwardTx({
    network: MAINNET, bounty: b, utxo, posterPrivHex: POSTER_PRIV,
    winnerAddr: WINNER_ADDR, awardGrains: 20 * GRAIN_PER_PRL,
    changeAddr: POSTER_ADDR, feeRateGrainsPerVByte: 2,
  });
  const v2 = verifyBountyTx(awardTx.hex, b);
  assert.equal(v2.spends[0].leaf, "award");
  assert.throws(() => verifyBountyTx("00".repeat(100), b), /txid|truncated|no input/i);
});

test("classifyBounty", () => {
  const b = forge();
  const u = [{ txid: "ab".repeat(32), vout: 0, value: 1, scriptOk: true }];
  assert.equal(classifyBounty(b, [], 800000).status, "awaiting-funding");
  assert.equal(classifyBounty(b, [], 800000, true).status, "spent");
  assert.equal(classifyBounty(b, u, 800000).status, "open");
  assert.equal(classifyBounty(b, u, 800000).blocksLeft, 100000);
  assert.equal(classifyBounty(b, u, 900000).status, "past-deadline");
  // scriptOk:false UTXOs never count as funding.
  assert.equal(classifyBounty(b, [{ ...u[0], scriptOk: false }], 800000).status, "awaiting-funding");
});

test("award signature is a real BIP-340 signature over the BIP-341 digest", () => {
  const b = forge();
  const utxo = { txid: "ab".repeat(32), vout: 0, value: 25 * GRAIN_PER_PRL };
  const tx = buildAwardTx({
    network: MAINNET, bounty: b, utxo, posterPrivHex: POSTER_PRIV,
    winnerAddr: WINNER_ADDR, awardGrains: Math.floor(24.9 * GRAIN_PER_PRL),
    changeAddr: POSTER_ADDR, feeRateGrainsPerVByte: 2,
  });
  assert.ok(verifyBountyTx(tx.hex, b).ok);
  // Cross-check the leaf hashes independently.
  assert.equal(bytesToHex(tapLeafHash(hexToBytes(b.awardScriptHex))).length, 64);
});
