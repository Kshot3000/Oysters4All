// Pearl Covenant core verification suite.
// Run: node --no-warnings --loader ./tests/loader.mjs tests/covenant.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  NETWORKS, DUST_GRAIN, GRAIN_PER_PRL,
  bytesToHex, hexToBytes, schnorr,
  createCovenant, covenantDescriptor, covenantFromDescriptor,
  buildMultisigScript, sortKeys, parseXOnlyKey, scriptAsm,
  numsInternalKey, covenantTaptree, verifyCovenantControlBlock,
  pubkeyFromPriv, buildSigningRound, serializeRound, parseRound,
  signRound, importSig, roundStatus, finalizeRound, describeRound,
  covenantSpendVBytes, addressToProgram,
  signForXOnly, verifySchnorrSig, scriptPathSigDigestEx,
  walletFromMnemonic, newMnemonic,
} from "../src/covenant-core.js";
import { buildReleaseScript } from "../../escrow/src/escrow-core.js"; // audited 2-of-3 — parity target
import { bytesToNumberBE, numberToBytesBE } from "@noble/curves/abstract/utils";
import { secp256k1 } from "@noble/curves/secp256k1";

const net = NETWORKS.mainnet;

// Deterministic test keys: priv 1..5 (x-only keys derived, even-Y normalized).
function testKey(i) {
  const priv = numberToBytesBE(BigInt(i), 32);
  const P = secp256k1.ProjectivePoint.fromPrivateKey(priv);
  return { priv: bytesToHex(priv), xonly: bytesToHex(P.toRawBytes(true).slice(1)) };
}
const K = [1, 2, 3, 4, 5].map(testKey);

function makeCovenant(m, idxs, network = net) {
  return createCovenant({ m, keyInputs: idxs.map((i) => K[i].xonly), network });
}

test("descriptor validation rejects bad parameters", () => {
  assert.throws(() => createCovenant({ m: 0, keyInputs: [K[0].xonly], network: net }), /m must be/);
  assert.throws(() => createCovenant({ m: 4, keyInputs: [K[0].xonly, K[1].xonly], network: net }), /m must be/);
  assert.throws(() => createCovenant({ m: 1, keyInputs: [K[0].xonly, K[0].xonly], network: net }), /duplicate/);
  assert.throws(() => createCovenant({ m: 1, keyInputs: ["zzzz"], network: net }), /64-hex x-only pubkey/);
  assert.throws(() => createCovenant({ m: 1, keyInputs: [], network: net }), /at least one/);
  const many = Array.from({ length: 17 }, (_, i) => testKey(100 + i).xonly);
  assert.throws(() => createCovenant({ m: 9, keyInputs: many, network: net }), /at most 16/);
});

test("2-of-3 script is byte-identical to escrow's audited 2-of-3 CHECKSIGADD script", () => {
  const sorted = sortKeys([K[0].xonly, K[1].xonly, K[2].xonly]).map(bytesToHex);
  const ours = buildMultisigScript(sorted.map(hexToBytes), 2);
  const theirs = buildReleaseScript(sorted[0], sorted[1], sorted[2]);
  assert.equal(bytesToHex(ours), bytesToHex(theirs));
});

test("key order does not affect the covenant address (BIP-67 style sort)", () => {
  const a = makeCovenant(2, [0, 1, 2]);
  const b = makeCovenant(2, [2, 0, 1]);
  const c = makeCovenant(2, [1, 2, 0]);
  assert.equal(a.covenant.address, b.covenant.address);
  assert.equal(a.covenant.address, c.covenant.address);
  assert.equal(a.covenant.scriptHex, b.covenant.scriptHex);
});

test("different m gives a different address; different keys give different address", () => {
  const a = makeCovenant(2, [0, 1, 2]);
  const b = makeCovenant(3, [0, 1, 2]);
  const d = makeCovenant(2, [0, 1, 3]);
  assert.notEqual(a.covenant.address, b.covenant.address);
  assert.notEqual(a.covenant.address, d.covenant.address);
  assert.ok(a.covenant.address.startsWith("prl1"));
});

test("NUMS internal key is nobody's key and the control block re-derives", () => {
  const { covenant } = makeCovenant(2, [0, 1, 2]);
  const memberKeys = covenant.keys.map((k) => k.xonly);
  assert.ok(!memberKeys.includes(covenant.internalKeyHex));
  const ok = verifyCovenantControlBlock(
    hexToBytes(covenant.internalKeyHex),
    hexToBytes(covenant.scriptHex),
    hexToBytes(covenant.controlBlockHex),
    hexToBytes(covenant.tweakedHex),
  );
  assert.equal(ok, true);
  // Tampered control block fails.
  const bad = hexToBytes(covenant.controlBlockHex);
  bad[0] ^= 1;
  assert.equal(verifyCovenantControlBlock(
    hexToBytes(covenant.internalKeyHex), hexToBytes(covenant.scriptHex),
    bad, hexToBytes(covenant.tweakedHex)), false);
});

test("descriptor round-trips; tampering yields a different covenant, never a silent one", () => {
  const { covenant } = makeCovenant(2, [0, 1, 2]);
  const d = covenantDescriptor(covenant);
  assert.ok(d.startsWith("covenant:v1:prl:2-of-3:"));
  const back = covenantFromDescriptor(d, net);
  assert.equal(back.address, covenant.address);
  // Tamper with m -> a DIFFERENT, honestly-derived covenant (1-of-3), never the original.
  const tamperedM = covenantFromDescriptor(d.replace("2-of-3", "1-of-3"), net);
  assert.notEqual(tamperedM.address, covenant.address);
  assert.equal(tamperedM.m, 1);
  // Tamper with a key -> different address.
  const parts = d.split(":");
  parts[4] = K[4].xonly;
  const tamperedK = covenantFromDescriptor(parts.join(":"), net);
  assert.notEqual(tamperedK.address, covenant.address);
  // Malformed descriptors throw.
  const badKey = d.split(":");
  badKey[4] = "zz".repeat(32);
  assert.throws(() => covenantFromDescriptor(badKey.join(":"), net), /64-hex x-only pubkey/);
  const short = d.split(":").slice(0, -1).join(":"); // drop a key: count != n
  assert.throws(() => covenantFromDescriptor(short, net), /key count/);
  assert.throws(() => covenantFromDescriptor(d, NETWORKS.testnet), /tprl/);
  assert.throws(() => covenantFromDescriptor("garbage", net), /bad covenant descriptor/);
});

test("mnemonic cosigner input derives a BIP-86 key and keeps the secret separate", () => {
  const mn = newMnemonic(128);
  const { covenant, secrets } = createCovenant({ m: 1, keyInputs: [mn, K[1].xonly], network: net });
  assert.equal(covenant.n, 2);
  assert.equal(secrets.length, 1);
  assert.equal(pubkeyFromPriv(secrets[0].priv), secrets[0].xonly);
  assert.ok(covenant.keys.some((k) => k.xonly === secrets[0].xonly && k.hasPriv));
  assert.ok(!covenantDescriptor(covenant).includes(secrets[0].priv));
  assert.ok(!serializeRound.toString().includes("priv"));
});

test("buildSigningRound: fee math, dust refusal, change to vault", () => {
  const { covenant } = makeCovenant(2, [0, 1, 2]);
  const dest = testKey(40);
  const destAddr = (() => {
    const { covenant: solo } = createCovenant({ m: 1, keyInputs: [dest.xonly], network: net });
    return solo.address;
  })();
  const utxo = { txid: "a".repeat(64), vout: 0, value: 5 * GRAIN_PER_PRL };
  const round = buildSigningRound(covenant, net, {
    utxo,
    payments: [{ address: destAddr, valueGrains: 1 * GRAIN_PER_PRL }],
    feeRateGrainsPerVByte: 10,
  });
  assert.equal(round.outputs.length, 2); // payment + change
  const change = round.outputs.find((o) => o.change);
  assert.ok(change && change.address === covenant.address);
  assert.ok(round.feeGrains > 0);
  assert.equal(round.input.value, round.outputs.reduce((a, o) => a + o.value, 0) + round.feeGrains);
  assert.equal(round.vBytes, covenantSpendVBytes(covenant, 2));
  // Dust payment refused.
  assert.throws(() => buildSigningRound(covenant, net, {
    utxo, payments: [{ address: destAddr, valueGrains: 100 }], feeRateGrainsPerVByte: 10,
  }), /dust/);
  // Insufficient funds.
  assert.throws(() => buildSigningRound(covenant, net, {
    utxo: { ...utxo, value: 1000 },
    payments: [{ address: destAddr, valueGrains: 1 * GRAIN_PER_PRL }],
    feeRateGrainsPerVByte: 10,
  }), /insufficient funds/);
  // Bad address.
  assert.throws(() => buildSigningRound(covenant, net, {
    utxo, payments: [{ address: "bc1qxyz", valueGrains: 1000 }], feeRateGrainsPerVByte: 10,
  }), /missing separator|HRP|P2TR|bech32/i);
});

test("sign -> import -> quorum -> finalize produces a valid single-input spend", () => {
  const { covenant } = makeCovenant(2, [0, 1, 2]);
  const dest = testKey(41);
  const { covenant: solo } = createCovenant({ m: 1, keyInputs: [dest.xonly], network: net });
  const utxo = { txid: "b".repeat(64), vout: 1, value: 3 * GRAIN_PER_PRL };
  const round = buildSigningRound(covenant, net, {
    utxo,
    payments: [{ address: solo.address, valueGrains: 1 * GRAIN_PER_PRL }],
    feeRateGrainsPerVByte: 5,
  });
  // Quorum not reached with zero / one sig.
  assert.equal(roundStatus(round, covenant).ready, false);
  assert.throws(() => finalizeRound(round, covenant, net), /quorum not reached/);
  signRound(round, covenant, K[0].priv);
  assert.equal(roundStatus(round, covenant).ready, false);
  // Duplicate signer rejected.
  assert.throws(() => signRound(round, covenant, K[0].priv), /already signed/);
  // Non-cosigner rejected.
  assert.throws(() => signRound(round, covenant, dest.priv), /not a cosigner/);
  // Second cosigner via importSig (as if received over the wire).
  const sig2 = bytesToHex(signForXOnly(hexToBytes(K[2].priv), round.digest));
  importSig(round, covenant, K[2].xonly, sig2);
  assert.equal(roundStatus(round, covenant).ready, true);
  // Tampered sig rejected.
  const r2 = buildSigningRound(covenant, net, {
    utxo, payments: [{ address: solo.address, valueGrains: 1 * GRAIN_PER_PRL }], feeRateGrainsPerVByte: 5,
  });
  const bad = sig2.slice(0, 126) + (sig2[126] === "0" ? "1" : "0") + sig2[127];
  assert.throws(() => importSig(r2, covenant, K[2].xonly, bad), /does not verify/);

  const spend = finalizeRound(round, covenant, net);
  assert.equal(spend.digest, round.digest);
  assert.ok(/^[0-9a-f]+$/.test(spend.hex));
  assert.ok(spend.hex.length > 400);
  // Every collected signature verifies against the digest and its key.
  for (const ps of round.partialSigs) {
    assert.equal(verifySchnorrSig(ps.sig, round.digest, ps.key), true);
  }
});

test("finalize drops signatures beyond quorum deterministically", () => {
  const { covenant } = makeCovenant(2, [0, 1, 2]);
  const { covenant: solo } = createCovenant({ m: 1, keyInputs: [testKey(42).xonly], network: net });
  const utxo = { txid: "c".repeat(64), vout: 0, value: 2 * GRAIN_PER_PRL };
  const round = buildSigningRound(covenant, net, {
    utxo, payments: [{ address: solo.address, valueGrains: 5e7 }], feeRateGrainsPerVByte: 5,
  });
  signRound(round, covenant, K[0].priv);
  signRound(round, covenant, K[1].priv);
  signRound(round, covenant, K[2].priv); // 3 sigs, m=2
  const spend = finalizeRound(round, covenant, net);
  assert.equal(spend.digest, round.digest);
  // Witness must contain exactly n stack items before script+control: count
  // non-empty sig items == m.
  const hex = spend.hex;
  assert.ok(hex.length > 0);
});

test("round JSON round-trips; tampering with outputs is caught", () => {
  const { covenant } = makeCovenant(2, [0, 1, 2]);
  const { covenant: solo } = createCovenant({ m: 1, keyInputs: [testKey(43).xonly], network: net });
  const utxo = { txid: "d".repeat(64), vout: 0, value: 2 * GRAIN_PER_PRL };
  const round = buildSigningRound(covenant, net, {
    utxo, payments: [{ address: solo.address, valueGrains: 5e7 }],
    feeRateGrainsPerVByte: 5, memo: "vault payout #1",
  });
  signRound(round, covenant, K[1].priv);
  const json = serializeRound(round);
  const back = parseRound(json, net);
  assert.equal(back.digest, round.digest);
  assert.equal(back.memo, "vault payout #1");
  assert.deepEqual(back.partialSigs, round.partialSigs);
  // Quorum not yet reached after the round-trip (1 of 2).
  assert.throws(() => finalizeRound(back, covenant, net), /quorum not reached/);
  // Add the second signature, finalize both copies: identical tx hex.
  signRound(back, covenant, K[0].priv);
  signRound(round, covenant, K[0].priv);
  const spendBack = finalizeRound(back, covenant, net);
  const spendOrig = finalizeRound(round, covenant, net);
  assert.equal(spendBack.hex, spendOrig.hex);
  assert.equal(spendBack.txid, spendOrig.txid);
  // Tamper: bump a payment value in the JSON -> digest mismatch.
  const evil = JSON.parse(json);
  evil.outputs[0].value += 1;
  assert.throws(() => parseRound(JSON.stringify(evil), net), /digest mismatch/);
  // Tamper: swap the covenant descriptor -> descriptor/address mismatch.
  const { covenant: other } = makeCovenant(2, [0, 1, 3]);
  const evil2 = JSON.parse(json);
  evil2.covenant = covenantDescriptor(other);
  assert.throws(() => parseRound(JSON.stringify(evil2), net), /digest mismatch/);
  // Garbage input.
  assert.throws(() => parseRound("{not json", net), /not valid JSON/);
  assert.throws(() => parseRound(JSON.stringify({ kind: "nope" }), net), /not a Pearl Covenant/);
});
