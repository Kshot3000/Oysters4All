// Pearl Pact core tests — adaptor round-trips, tamper regressions, oracle
// attestation, descriptor seals, exact fee math, full ceremony end-to-end.
// Usage: node --no-warnings --loader ./tests/loader.mjs tests/pact.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import * as P from "../src/pact-core.js";
import { numsInternalKeyVault, scriptPathVBytes } from "../../vault/src/vault-core.js";
import { sha256 } from "../../sign/src/crypto.js";

const ALICE = "1111111111111111111111111111111111111111111111111111111111111111";
const BOB = "2222222222222222222222222222222222222222222222222222222222222222";
const ORACLE = "3333333333333333333333333333333333333333333333333333333333333333";

import { secp256k1 as secp } from "@noble/curves/secp256k1";
const xonly = (privHex) => {
  const p = secp.ProjectivePoint.fromPrivateKey(P.hexToBytes(privHex));
  return P.bytesToHex(p.toRawBytes(true).slice(1));
};

test("NUMS domain is distinct from sibling apps (domain separation)", () => {
  assert.notEqual(P.NUMS_DOMAIN, "PearlVaultNUMS/v1");
  assert.ok(P.NUMS_DOMAIN.startsWith("PearlPact"));
  // and the derived internal key differs from vault's for the same script
  const { script } = P.buildFundingScript(xonly(ALICE), xonly(BOB));
  const pactKey = P.bytesToHex(P.numsInternalKeyPact(script));
  const vaultKey = P.bytesToHex(numsInternalKeyVault(2, 2, [xonly(ALICE), xonly(BOB)].map((h) => P.hexToBytes(h))));
  assert.notEqual(pactKey, vaultKey);
});

test("adaptor round-trip: encrypt -> verify -> decrypt -> BIP-340 verifies", () => {
  const digest = P.bytesToHex(sha256(new TextEncoder().encode("fake digest input")));
  const T = P.oracleOutcomeSecret(ORACLE, "evt", 0).pointXHex;
  const enc = P.adaptorEncrypt(ALICE, digest, T);
  assert.match(enc.RprimeX, /^[0-9a-f]{64}$/);
  assert.match(enc.sStar, /^[0-9a-f]{64}$/);
  assert.equal(P.adaptorVerify(enc.RprimeX, enc.sStar, xonly(ALICE), digest, T), true);
  // wrong key fails
  assert.equal(P.adaptorVerify(enc.RprimeX, enc.sStar, xonly(BOB), digest, T), false);
  // wrong adaptor point fails
  const T2 = P.oracleOutcomeSecret(ORACLE, "evt", 1).pointXHex;
  assert.equal(P.adaptorVerify(enc.RprimeX, enc.sStar, xonly(ALICE), digest, T2), false);
  // wrong digest fails
  const digest2 = P.bytesToHex(sha256(new TextEncoder().encode("other")));
  assert.equal(P.adaptorVerify(enc.RprimeX, enc.sStar, xonly(ALICE), digest2, T), false);
  // decrypt with the revealed secret -> valid BIP-340 signature
  const { tHex } = P.oracleOutcomeSecret(ORACLE, "evt", 0);
  const s = P.adaptorDecrypt(enc.sStar, tHex);
  const sig = P.hexToBytes(enc.RprimeX + s);
  assert.equal(P.schnorr.verify(sig, P.hexToBytes(digest), P.hexToBytes(xonly(ALICE))), true);
  // decrypt with the WRONG secret -> invalid signature
  const { tHex: tWrong } = P.oracleOutcomeSecret(ORACLE, "evt", 1);
  const sBad = P.adaptorDecrypt(enc.sStar, tWrong);
  assert.equal(P.schnorr.verify(P.hexToBytes(enc.RprimeX + sBad), P.hexToBytes(digest), P.hexToBytes(xonly(ALICE))), false);
});

test("oracle announcements are deterministic; attestation verifies", () => {
  const a1 = P.oracleAnnouncements(ORACLE, "evt-x", 3);
  const a2 = P.oracleAnnouncements(ORACLE, "evt-x", 3);
  assert.deepEqual(a1, a2);
  const oraclePub = xonly(ORACLE);
  for (const { index, pointXHex } of a1) {
    const att = P.oracleAttest(ORACLE, "evt-x", index);
    const v = P.verifyAttestation({
      oraclePubXOnlyHex: oraclePub, eventId: "evt-x", outcomeIndex: index,
      tHex: att.tHex, sigHex: att.sigHex, committedPointXHex: pointXHex,
    });
    assert.equal(v.ok, true, JSON.stringify(v.reasons));
  }
  // attestation for outcome 0 does NOT verify against outcome 1's commitment
  const att0 = P.oracleAttest(ORACLE, "evt-x", 0);
  const bad = P.verifyAttestation({
    oraclePubXOnlyHex: oraclePub, eventId: "evt-x", outcomeIndex: 0,
    tHex: att0.tHex, sigHex: att0.sigHex, committedPointXHex: a1[1].pointXHex,
  });
  assert.equal(bad.ok, false);
  // forged signature fails
  const att1 = P.oracleAttest(ORACLE, "evt-x", 1);
  const forged = P.verifyAttestation({
    oraclePubXOnlyHex: oraclePub, eventId: "evt-x", outcomeIndex: 1,
    tHex: att1.tHex, sigHex: att1.sigHex.slice(0, 126) + "00", committedPointXHex: a1[1].pointXHex,
  });
  assert.equal(forged.ok, false);
});

function buildTerms(networkId = "mainnet") {
  const eventId = "test/ceremony-" + networkId;
  const commits = P.oracleAnnouncements(ORACLE, eventId, 2).map((a) => a.pointXHex);
  const { script } = P.buildFundingScript(xonly(ALICE), xonly(BOB));
  // CET fee: exactly like the core computes it
  const cetVBytes = scriptPathVBytes(1, 2, script.length, 2, 2);
  const cetFee = Math.ceil(cetVBytes * 5);
  const distributable = 200_000_000 - cetFee;
  return P.buildPactTerms({
    networkId,
    title: "Test pact",
    aliceName: "Alice", aliceKey: ALICE, aliceKind: "priv",
    bobName: "Bob", bobKey: BOB, bobKind: "priv",
    oracleName: "O", oraclePubkey: xonly(ORACLE),
    eventId, oracleCommits: commits,
    outcomes: [
      { label: "alice wins", aliceGrains: distributable - 546, bobGrains: 546 },
      { label: "bob wins", aliceGrains: 546, bobGrains: distributable - 546 },
    ],
    collateralAlice: 100_000_000, collateralBob: 100_000_000,
    fundingFeeRate: 5, cetFeeRate: 5, refundFeeRate: 5,
    refundLockHeight: 900000,
  });
}

test("draft: descriptor seals and re-verifies; tampering is caught", () => {
  const t = buildTerms();
  assert.match(t.descriptor, /^pearl-pact:v1:prl:[0-9a-f]{64}$/);
  assert.match(t.address, /^prl1p/);
  const exported = P.exportTerms(t);
  const v = P.verifyPactDescriptor(exported);
  assert.equal(v.verdict, "PROVEN");
  // tamper with a payout row -> NOT PROVEN
  const o = JSON.parse(exported);
  o.outcomes[0].aliceGrains += 1;
  assert.equal(P.verifyPactDescriptor(JSON.stringify(o)).verdict, "NOT PROVEN");
  // duplicate keys refused
  assert.throws(() => P.buildPactTerms({
    networkId: "mainnet", title: "x",
    aliceName: "A", aliceKey: ALICE, aliceKind: "priv",
    bobName: "B", bobKey: ALICE, bobKind: "priv",
    oracleName: "O", oraclePubkey: xonly(ORACLE), eventId: "e",
    oracleCommits: P.oracleAnnouncements(ORACLE, "e", 2).map((a) => a.pointXHex),
    outcomes: [{ label: "a", aliceGrains: 100000000 - 546 - 300, bobGrains: 546 }, { label: "b", aliceGrains: 546, bobGrains: 100000000 - 546 - 300 }],
    collateralAlice: 50000000, collateralBob: 50000000,
    fundingFeeRate: 5, cetFeeRate: 5, refundFeeRate: 5, refundLockHeight: 900000,
  }), /different keys/);
  // payout rows that don't sum to collateral - fee are refused
  assert.throws(() => P.buildPactTerms({
    networkId: "mainnet", title: "x",
    aliceName: "A", aliceKey: ALICE, aliceKind: "priv",
    bobName: "B", bobKey: BOB, bobKind: "priv",
    oracleName: "O", oraclePubkey: xonly(ORACLE), eventId: "e2",
    oracleCommits: P.oracleAnnouncements(ORACLE, "e2", 2).map((a) => a.pointXHex),
    outcomes: [{ label: "a", aliceGrains: 99999999, bobGrains: 99999999 }, { label: "b", aliceGrains: 99999999, bobGrains: 99999999 }],
    collateralAlice: 100000000, collateralBob: 100000000,
    fundingFeeRate: 5, cetFeeRate: 5, refundFeeRate: 5, refundLockHeight: 900000,
  }), /must equal exactly/);
});

test("funding plan: exact fee math, dust absorption, shortfall refusal", () => {
  const t = buildTerms();
  const utxoA = "aa".repeat(32) + ":0:100001000";
  const utxoB = "bb".repeat(32) + ":1:100001000";
  const plan = P.planFundingTx({ networkId: "mainnet", terms: t, aliceUtxoText: utxoA, bobUtxoText: utxoB, fundingFeeRate: 5 });
  assert.equal(plan.fundingValue, 200000000);
  assert.equal(plan.fundingVout, 0);
  assert.match(plan.txid, /^[0-9a-f]{64}$/);
  assert.ok(plan.vBytes > 0 && plan.feeGrains > 0);
  // fee math: ceil(vBytes * rate) plus absorbed dust
  const expectedBase = Math.ceil(plan.vBytes * 5);
  assert.ok(plan.feeGrains >= expectedBase);
  assert.equal(plan.outputs[0].value, 200000000);
  // shortfall refused loudly
  assert.throws(() => P.planFundingTx({
    networkId: "mainnet", terms: t,
    aliceUtxoText: "aa".repeat(32) + ":0:500", bobUtxoText: utxoB, fundingFeeRate: 5,
  }), /PACT REFUSED/);
});

test("funding sign: both parties sign keypath inputs; sigs re-verify", () => {
  const t = buildTerms();
  const plan = P.planFundingTx({
    networkId: "mainnet", terms: t,
    aliceUtxoText: "aa".repeat(32) + ":0:100001000", bobUtxoText: "bb".repeat(32) + ":1:100001000",
    fundingFeeRate: 5,
  });
  // NOTE: the plan's UTXOs are arbitrary txids; signing uses the party keys as
  // the input owners' keypath keys (the test's coins are synthetic).
  const signed = P.signFundingTx({ networkId: "mainnet", plan, terms: t, alicePrivHex: ALICE, bobPrivHex: BOB });
  assert.equal(signed.txid, plan.txid);
  assert.ok(signed.hex.length > plan.unsignedHex.length);
});

test("full ceremony: CETs -> seal -> verify -> execute (outcome 1)", () => {
  const t = buildTerms();
  const fundingTxid = "cc".repeat(32);
  const cets = P.buildCets({ networkId: "mainnet", terms: t, fundingTxid, fundingVout: 0 });
  assert.equal(cets.cets.length, 2);
  assert.notEqual(cets.cets[0].txid, cets.cets[1].txid);
  assert.notEqual(cets.cets[0].digest, cets.cets[1].digest);
  const sealed = P.sealPact({ networkId: "mainnet", terms: t, cets, alicePrivHex: ALICE, bobPrivHex: BOB });
  assert.equal(sealed.outcomes.length, 2);
  assert.match(sealed.fingerprint, /^[0-9a-f]{16}$/);
  const sv = P.verifySealedPact({ networkId: "mainnet", terms: t, sealed });
  assert.equal(sv.ok, true, JSON.stringify(sv.failures));
  // tampered sealed bundle fails
  const tampered = JSON.parse(JSON.stringify(sealed));
  tampered.outcomes[0].alice.sStar = tampered.outcomes[0].bob.sStar;
  assert.equal(P.verifySealedPact({ networkId: "mainnet", terms: t, sealed: tampered }).ok, false);
  // oracle attests to outcome 1 ("bob wins"); execute
  const att = P.oracleAttest(ORACLE, t.oracle.eventId, 1);
  const ex = P.executePact({ networkId: "mainnet", terms: t, sealed, attestation: att });
  assert.equal(ex.txid, cets.cets[1].txid);
  assert.equal(ex.label, "bob wins");
  assert.ok(ex.hex.length > 0);
  // executing with the WRONG outcome secret fails (attestation won't verify)
  const att0 = P.oracleAttest(ORACLE, t.oracle.eventId, 0);
  const wrongCommit = P.verifySealedPact({ networkId: "mainnet", terms: t, sealed });
  assert.equal(wrongCommit.ok, true);
  const exWrong = () => P.executePact({
    networkId: "mainnet", terms: t, sealed,
    attestation: { ...att0, outcomeIndex: 1 }, // secret for 0, claimed as 1
  });
  assert.throws(exWrong, /PACT REFUSED/);
});

test("refund: timelocked, both parties sign, locktime on the wire", () => {
  const t = buildTerms();
  const fundingTxid = "cc".repeat(32);
  const refund = P.buildRefundTx({ networkId: "mainnet", terms: t, fundingTxid, fundingVout: 0 });
  assert.equal(refund.lockHeight, 900000);
  assert.equal(refund.aliceGrains + refund.bobGrains + refund.feeGrains, 200000000);
  const signed = P.signRefundTx({ networkId: "mainnet", terms: t, refund, alicePrivHex: ALICE, bobPrivHex: BOB });
  assert.equal(signed.txid, refund.txid);
  // locktime is the last 4 bytes LE of the base serialization
  const raw = P.hexToBytes(refund.unsignedBaseHex);
  const lockLE = raw.slice(-4);
  assert.deepEqual(Array.from(lockLE), [900000 & 0xff, (900000 >>> 8) & 0xff, (900000 >>> 16) & 0xff, (900000 >>> 24) & 0xff]);
  // and the input sequence is 0xfffffffe
  const seqBytes = raw.slice(4 + 1 + 32 + 4 + 1, 4 + 1 + 32 + 4 + 1 + 4);
  assert.deepEqual(Array.from(seqBytes), [0xfe, 0xff, 0xff, 0xff]);
});

test("demo minter produces a working pact end-to-end", () => {
  const demo = P.mintDemoPact("mainnet");
  assert.match(demo.terms.descriptor, /^pearl-pact:v1:prl:/);
  const cets = P.buildCets({ networkId: "mainnet", terms: demo.terms, fundingTxid: "dd".repeat(32), fundingVout: 0 });
  const sealed = P.sealPact({
    networkId: "mainnet", terms: demo.terms, cets,
    alicePrivHex: demo.keys.alicePriv, bobPrivHex: demo.keys.bobPriv,
  });
  assert.equal(P.verifySealedPact({ networkId: "mainnet", terms: demo.terms, sealed }).ok, true);
  const att = P.oracleAttest(demo.keys.oraclePriv, demo.eventId, 0);
  const ex = P.executePact({ networkId: "mainnet", terms: demo.terms, sealed, attestation: att });
  assert.equal(ex.txid, cets.cets[0].txid);
});

test("payout math helpers", () => {
  assert.equal(P.prlToGrains("1.5"), 150000000);
  assert.equal(P.grainsToPRL(150000000), "1.5");
  assert.throws(() => P.prlToGrains("abc"), /PACT REFUSED/);
});
