// Pearl Swap core verification suite.
// Run: node --no-warnings --loader ./tests/loader.mjs tests/swap.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  NETWORKS, DUST_GRAIN, GRAIN_PER_PRL,
  bytesToHex, hexToBytes, sha256, schnorr,
  buildClaimScript, buildRefundScript, encodeScriptNum,
  numsInternalKey, swapTaptree, verifySwapControlBlock,
  generatePreimage, secretHashOf, parsePreimage, pubkeyFromPriv,
  proposeSwap, swapDescriptor, parseDescriptor, serializeSwap, parseSwapSpec, describeSwap,
  swapScriptAsm,
  funderKeyFromInput, funderSpkHex, buildLockTx,
  claimSpendVBytes, buildClaimSpend,
  refundSpendVBytes, buildRefundSpend, REFUND_SEQUENCE,
  parseTx, extractPreimage, classifySwapState, swapCountdown,
  btcMirrorTemplate,
  partyKeyFromInput, parseXOnlyKey, addressToProgram,
  verifySchnorrSig, signForXOnly, scriptPathSigDigestEx, buildScriptPathSpend,
  walletFromMnemonic, walletToWIF,
  SWAP_KIND, SWAP_VERSION, PEARL_BLOCK_SECS, MIN_T1_T2_GAP,
} from "../src/swap-core.js";
import { bytesToNumberBE, numberToBytesBE } from "@noble/curves/abstract/utils";
import { secp256k1 } from "@noble/curves/secp256k1";

const net = NETWORKS.mainnet;

// Deterministic test keys: priv 1..6 (x-only keys derived, even-Y normalized).
function testKey(i) {
  const priv = numberToBytesBE(BigInt(i), 32);
  const P = secp256k1.ProjectivePoint.fromPrivateKey(priv);
  return { priv: bytesToHex(priv), xonly: bytesToHex(P.toRawBytes(true).slice(1)) };
}
const K = [1, 2, 3, 4, 5, 6].map(testKey);

// Known-answer vector: preimage 00..1f -> SHA-256 (computed with node:crypto).
const KAV_PREIMAGE = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const KAV_HASH = "630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd";

function makeSwap(over = {}) {
  const { swap } = proposeSwap({
    role: "alice",
    network: net,
    prlGrains: 1_000_000_00, // 1 PRL
    btcSats: 5_000_000,      // 0.05 BTC
    preimageHex: KAV_PREIMAGE,
    aliceKeyInput: K[0].xonly,
    bobKeyInput: K[1].xonly,
    t1: 121000,
    t2: 120500,
    feeRateGrainsPerVByte: 5,
    ...over,
  });
  return swap;
}

test("preimage/hash known-answer vector", () => {
  assert.equal(bytesToHex(secretHashOf(hexToBytes(KAV_PREIMAGE))), KAV_HASH);
  assert.equal(bytesToHex(secretHashOf(KAV_PREIMAGE)), KAV_HASH);
  assert.throws(() => parsePreimage("abcd"), /64 hex/);
  const p = generatePreimage();
  assert.equal(p.length, 32);
  assert.notDeepEqual(generatePreimage(), generatePreimage()); // fresh randomness
});

test("claim script is the exact expected byte vector", () => {
  const H = hexToBytes(KAV_HASH);
  const script = buildClaimScript(H, K[1].xonly);
  // a8 20 <H:32> 88 20 <bob:32> ac
  const expect = "a8" + "20" + KAV_HASH + "88" + "20" + K[1].xonly + "ac";
  assert.equal(bytesToHex(script), expect);
  assert.equal(script.length, 69);
  assert.equal(swapScriptAsm(script),
    `OP_SHA256 <${KAV_HASH.slice(0, 12)}…32B> OP_EQUALVERIFY <${K[1].xonly.slice(0, 12)}…32B> OP_CHECKSIG`);
  assert.throws(() => buildClaimScript("abcd", K[1].xonly), /32 bytes/);
  assert.throws(() => buildClaimScript(H, "zzzz"), /64 hex/);
});

test("refund script is the exact expected byte vector", () => {
  const script = buildRefundScript(K[0].xonly, 120000);
  // encodeScriptNum(120000) = c0 d4 01 (3 bytes); push -> 03 c0 d4 01, b1 75, 20 <alice>, ac
  const expect = "03c0d401" + "b1" + "75" + "20" + K[0].xonly + "ac";
  assert.equal(bytesToHex(script), expect);
  assert.ok(swapScriptAsm(script).includes("OP_CHECKLOCKTIMEVERIFY"));
  assert.ok(swapScriptAsm(script).includes("<120000>"));
  assert.throws(() => buildRefundScript(K[0].xonly, 0), /positive block height/);
  assert.throws(() => buildRefundScript(K[0].xonly, 500000000), /positive block height/);
});

test("NUMS internal key is deterministic, binds both leaves, is nobody's key", () => {
  const k1 = numsInternalKey(hexToBytes("aa".repeat(32)), hexToBytes("bb".repeat(32)));
  const k2 = numsInternalKey(hexToBytes("aa".repeat(32)), hexToBytes("bb".repeat(32)));
  assert.deepEqual(k1, k2); // deterministic
  const k3 = numsInternalKey(hexToBytes("bb".repeat(32)), hexToBytes("aa".repeat(32)));
  assert.notDeepEqual(k1, k3); // leaf order matters (canonical: claim, refund)
  assert.notDeepEqual(k1, hexToBytes(K[0].xonly));
  assert.notDeepEqual(k1, hexToBytes(K[1].xonly));
  // 32-byte x on the curve
  schnorr.utils.lift_x(bytesToNumberBE(k1));
});

test("taptree: address is prl1p, control blocks re-derive, tamper fails", () => {
  const swap = makeSwap();
  assert.ok(swap.address.startsWith("prl1p"), swap.address);
  const okClaim = verifySwapControlBlock(
    hexToBytes(swap.internalKeyHex), hexToBytes(swap.claimScriptHex),
    hexToBytes(swap.claimControlBlockHex), hexToBytes(swap.tweakedHex));
  const okRefund = verifySwapControlBlock(
    hexToBytes(swap.internalKeyHex), hexToBytes(swap.refundScriptHex),
    hexToBytes(swap.refundControlBlockHex), hexToBytes(swap.tweakedHex));
  assert.equal(okClaim, true);
  assert.equal(okRefund, true);
  assert.equal(hexToBytes(swap.claimControlBlockHex).length, 65);
  // control blocks must differ (different leaves)
  assert.notEqual(swap.claimControlBlockHex, swap.refundControlBlockHex);
  // tampered control block fails
  const bad = hexToBytes(swap.claimControlBlockHex);
  bad[10] ^= 1;
  assert.equal(verifySwapControlBlock(
    hexToBytes(swap.internalKeyHex), hexToBytes(swap.claimScriptHex), bad, hexToBytes(swap.tweakedHex)), false);
  // internal key is nobody's key
  assert.notEqual(swap.internalKeyHex, K[0].xonly);
  assert.notEqual(swap.internalKeyHex, K[1].xonly);
});

test("propose guards: role, amounts, keys, heights", () => {
  assert.throws(() => makeSwap({ role: "carol" }), /role must be/);
  assert.throws(() => makeSwap({ prlGrains: DUST_GRAIN - 1 }), /dust/);
  assert.throws(() => makeSwap({ btcSats: 0 }), /positive/);
  assert.throws(() => makeSwap({ aliceKeyInput: K[1].xonly }), /different keys/);
  assert.throws(() => makeSwap({ preimageHex: null, secretHashHex: null }), /preimage/);
  // preimage/hash mismatch refused
  assert.throws(() => makeSwap({ secretHashHex: "ff".repeat(32) }), /does not hash/);
  // T1 <= T2 refused
  assert.throws(() => makeSwap({ t1: 120500, t2: 120500 }), /must be greater than T2/);
  assert.throws(() => makeSwap({ t1: 120000, t2: 120500 }), /must be greater than T2/);
  // tight gap warns but does not refuse
  const tight = makeSwap({ t1: 120600, t2: 120500 });
  assert.equal(tight.warnings.length, 1);
  assert.ok(tight.warnings[0].includes("safety margin"));
  // comfortable gap: no warnings
  const comfy = makeSwap();
  assert.deepEqual(comfy.warnings, []);
  assert.ok(comfy.descriptor.startsWith("swap:v1:prl:alice:100000000:5000000:"));
});

test("bob can propose from the secret hash alone (no preimage)", () => {
  const { swap, secrets } = proposeSwap({
    role: "bob", network: net,
    prlGrains: 100000000, btcSats: 5000000,
    secretHashHex: KAV_HASH,
    aliceKeyInput: K[0].xonly, bobKeyInput: K[1].xonly,
    t1: 121000, t2: 120500, feeRateGrainsPerVByte: 5,
  });
  assert.equal(swap.hasPreimage, false);
  assert.equal(swap.secretHashHex, KAV_HASH);
  assert.equal(swap.address, makeSwap().address); // same contract, different role
  assert.ok(swap.descriptor.includes(":bob:"));
  assert.deepEqual(secrets, []); // pubkey-only inputs -> no secrets
});

test("descriptor parses; JSON round-trips; tampering is caught", () => {
  const swap = makeSwap();
  const d = swapDescriptor(swap);
  assert.equal(d, `swap:v1:prl:alice:100000000:5000000:${KAV_HASH}:121000:120500`);
  const pf = parseDescriptor(d);
  assert.deepEqual(pf, {
    hrp: "prl", role: "alice", prlGrains: 100000000, btcSats: 5000000,
    secretHashHex: KAV_HASH, t1: 121000, t2: 120500,
  });
  assert.throws(() => parseDescriptor("swap:v1:prl:alice"), /bad swap descriptor/);

  const json = serializeSwap(swap);
  const back = parseSwapSpec(json, net);
  assert.equal(back.address, swap.address);
  assert.equal(back.descriptor, swap.descriptor);

  // tamper with the amount -> re-derivation mismatch
  const evil = JSON.parse(json);
  evil.prlGrains += 1;
  assert.throws(() => parseSwapSpec(JSON.stringify(evil), net), /tampered/);
  // tamper with T1 -> re-derivation mismatch
  const evil2 = JSON.parse(json);
  evil2.t1 += 10;
  assert.throws(() => parseSwapSpec(JSON.stringify(evil2), net), /tampered/);
  // tamper with a key -> re-derivation mismatch
  const evil3 = JSON.parse(json);
  evil3.bobXOnly = K[2].xonly;
  assert.throws(() => parseSwapSpec(JSON.stringify(evil3), net), /tampered/);
  // tamper with the embedded descriptor -> mismatch
  const evil4 = JSON.parse(json);
  evil4.descriptor = evil4.descriptor.replace("alice", "bob");
  assert.throws(() => parseSwapSpec(JSON.stringify(evil4), net), /tampered/);
  // garbage
  assert.throws(() => parseSwapSpec("{nope", net), /not valid JSON/);
  assert.throws(() => parseSwapSpec(JSON.stringify({ kind: "nope" }), net), /not a Pearl Swap/);
  // wrong network
  assert.throws(() => parseSwapSpec(json, NETWORKS.testnet), /not tprl/);
});

test("mnemonic key inputs yield in-memory secrets, never in the JSON", () => {
  const MN = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  const { swap, secrets } = proposeSwap({
    role: "alice", network: net, prlGrains: 100000000, btcSats: 5000000,
    preimageHex: KAV_PREIMAGE, aliceKeyInput: MN, bobKeyInput: K[1].xonly,
    t1: 121000, t2: 120500, feeRateGrainsPerVByte: 5,
  });
  assert.equal(secrets.length, 1);
  assert.equal(secrets[0].role, "alice");
  assert.equal(secrets[0].xonly, swap.aliceXOnly);
  assert.equal(pubkeyFromPriv(secrets[0].priv), swap.aliceXOnly);
  const json = serializeSwap(swap);
  assert.ok(!json.includes(secrets[0].priv), "private key must never enter the JSON");
  assert.ok(!json.includes(MN), "mnemonic must never enter the JSON");
});

test("funder key inputs: hex, WIF, mnemonic; priv/pub mismatch refused", () => {
  const MN = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  const w = walletFromMnemonic(MN, net);
  const hex = funderKeyFromInput(bytesToHex(w.priv), net);
  assert.equal(hex.address, w.address);
  const mn = funderKeyFromInput(MN, net);
  assert.equal(mn.address, w.address);
  const wif = walletToWIF(w.priv, net);
  const wf = funderKeyFromInput(wif, net);
  assert.equal(wf.address, w.address);
  assert.throws(() => funderKeyFromInput("not a key", net), /funder key must be/);
  // privkey that does not match the claimed internal key
  assert.throws(() => buildLockTx(net, {
    funderPriv: K[2].priv, funderInternalXOnly: w.internalXOnly,
    utxos: [{ txid: "ab".repeat(32), vout: 0, value: 2e8 }],
    swapProgram: hexToBytes(makeSwap().tweakedHex),
    prlGrains: 1e8, feeRateGrainsPerVByte: 5,
  }), /does not match/);
});

function funderWallet() {
  const MN = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  return walletFromMnemonic(MN, net);
}

test("lock tx: belong-check, exact fee math, per-signature re-verification", () => {
  const swap = makeSwap();
  const w = funderWallet();
  const spkHex = funderSpkHex(w.internalXOnly);
  const utxo = { txid: "ab".repeat(32), vout: 0, value: 2 * GRAIN_PER_PRL, spkHex };
  const lock = buildLockTx(net, {
    funderPriv: w.priv, funderInternalXOnly: w.internalXOnly,
    utxos: [utxo],
    swapProgram: hexToBytes(swap.tweakedHex),
    prlGrains: swap.prlGrains, feeRateGrainsPerVByte: 5,
  });
  assert.ok(/^[0-9a-f]{64}$/.test(lock.txid));
  assert.ok(lock.hex.length > 200);
  assert.ok(lock.feeGrains > 0);
  assert.ok(lock.changeGrains >= 0);
  // the swap output pays exactly prlGrains to the swap program
  const parsed = parseTx(lock.hex);
  assert.equal(parsed.outputs[0].value, swap.prlGrains);
  assert.equal(bytesToHex(parsed.outputs[0].spk), swap.spkHex);
  // belong-check: wrong spk is refused
  assert.throws(() => buildLockTx(net, {
    funderPriv: w.priv, funderInternalXOnly: w.internalXOnly,
    utxos: [{ txid: "ab".repeat(32), vout: 0, value: 2e8, spkHex: "76".repeat(34) }],
    swapProgram: hexToBytes(swap.tweakedHex), prlGrains: 1e8, feeRateGrainsPerVByte: 5,
  }), /does not belong/);
  // no spk: accepted with a warning
  const warn = buildLockTx(net, {
    funderPriv: w.priv, funderInternalXOnly: w.internalXOnly,
    utxos: [{ txid: "ab".repeat(32), vout: 0, value: 2e8 }],
    swapProgram: hexToBytes(swap.tweakedHex), prlGrains: 1e8, feeRateGrainsPerVByte: 5,
  });
  assert.equal(warn.warnings.length, 1);
  assert.ok(warn.warnings[0].includes("not verifiable"));
  // insufficient funds refused
  assert.throws(() => buildLockTx(net, {
    funderPriv: w.priv, funderInternalXOnly: w.internalXOnly,
    utxos: [{ txid: "ab".repeat(32), vout: 0, value: 1e8, spkHex }],
    swapProgram: hexToBytes(swap.tweakedHex), prlGrains: 1e8, feeRateGrainsPerVByte: 5,
  }), /insufficient funds/);
  // dust lock amount refused
  assert.throws(() => buildLockTx(net, {
    funderPriv: w.priv, funderInternalXOnly: w.internalXOnly,
    utxos: [utxo],
    swapProgram: hexToBytes(swap.tweakedHex), prlGrains: 100, feeRateGrainsPerVByte: 5,
  }), /dust/);
});

test("full lock -> claim flow with synthetic UTXOs; preimage extraction round-trips", () => {
  const swap = makeSwap();
  const w = funderWallet();
  const spkHex = funderSpkHex(w.internalXOnly);
  const lock = buildLockTx(net, {
    funderPriv: w.priv, funderInternalXOnly: w.internalXOnly,
    utxos: [{ txid: "ab".repeat(32), vout: 0, value: 2 * GRAIN_PER_PRL, spkHex }],
    swapProgram: hexToBytes(swap.tweakedHex),
    prlGrains: swap.prlGrains, feeRateGrainsPerVByte: 5,
  });
  // the swap UTXO: vout 0 of the lock tx
  const swapUtxo = { txid: lock.txid, vout: 0, value: swap.prlGrains };
  // Bob's destination: a fresh 1-of-1 covenant address (any P2TR works)
  const dest = walletFromMnemonic(
    "legal winner thank year wave sausage worth useful legal winner thank yellow", net);

  // sighash cross-check: buildScriptPathSpend's digest == independent scriptPathSigDigestEx
  const claimScript = hexToBytes(swap.claimScriptHex);
  const input = { txid: swapUtxo.txid, vout: 0, value: swapUtxo.value, spk: hexToBytes(swap.spkHex) };
  const fee = Math.ceil(claimSpendVBytes(swap) * 5);
  const outputs = [{ program: addressToProgram(dest.address, net), value: swapUtxo.value - fee }];
  const digest = scriptPathSigDigestEx(net, input, outputs, claimScript, {});
  const sig = signForXOnly(hexToBytes(K[1].priv), digest);
  assert.equal(verifySchnorrSig(sig, digest, hexToBytes(swap.bobXOnly)), true);
  const manual = buildScriptPathSpend(net, input, outputs, claimScript,
    hexToBytes(swap.claimControlBlockHex), [sig, hexToBytes(KAV_PREIMAGE)], {});
  assert.equal(manual.digest, bytesToHex(digest));

  const claim = buildClaimSpend(net, swap, {
    utxo: swapUtxo, preimageHex: KAV_PREIMAGE, bobPrivHex: K[1].priv,
    destAddress: dest.address, feeRateGrainsPerVByte: 5,
  });
  assert.ok(/^[0-9a-f]{64}$/.test(claim.txid));
  assert.equal(claim.preimageHex, KAV_PREIMAGE);
  assert.equal(claim.digest, manual.digest); // identical spend
  // witness layout: [bob_sig, preimage, claimScript, controlBlock]
  const parsed = parseTx(claim.hex);
  const wit = parsed.inputs[0].witness;
  assert.equal(wit.length, 4);
  assert.equal(wit[0].length, 64);
  assert.equal(bytesToHex(wit[1]), KAV_PREIMAGE);
  assert.equal(bytesToHex(wit[2]), swap.claimScriptHex);
  assert.equal(bytesToHex(wit[3]), swap.claimControlBlockHex);
  // Alice extracts the preimage from Bob's claim tx
  assert.equal(extractPreimage(claim.hex, swap.secretHashHex), KAV_PREIMAGE);
  // extraction from an unrelated tx fails loudly
  assert.throws(() => extractPreimage(lock.hex, swap.secretHashHex), /no preimage revealed/);
});

test("claim guards: wrong preimage, wrong key, dust output", () => {
  const swap = makeSwap();
  const dest = walletFromMnemonic(
    "legal winner thank year wave sausage worth useful legal winner thank yellow", net);
  const utxo = { txid: "ab".repeat(32), vout: 0, value: swap.prlGrains };
  const base = { utxo, preimageHex: KAV_PREIMAGE, bobPrivHex: K[1].priv, destAddress: dest.address, feeRateGrainsPerVByte: 5 };
  assert.throws(() => buildClaimSpend(net, swap, { ...base, preimageHex: "ff".repeat(32) }),
    /does not hash to the swap's secret hash/);
  assert.throws(() => buildClaimSpend(net, swap, { ...base, bobPrivHex: K[2].priv }),
    /not Bob's claim key/);
  assert.throws(() => buildClaimSpend(net, swap, { ...base, destAddress: "prl1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqnrql8a" }),
    /bad checksum|P2TR/);
  // tiny UTXO -> dust output refused
  assert.throws(() => buildClaimSpend(net, swap, {
    ...base, utxo: { txid: "ab".repeat(32), vout: 0, value: 600 },
  }), /below dust/);
});

test("full lock -> refund flow; maturity + wire-structure guards", () => {
  const swap = makeSwap();
  const dest = walletFromMnemonic(
    "letter advice cage absurd amount doctor acoustic avoid letter advice cage above", net);
  const utxo = { txid: "cd".repeat(32), vout: 0, value: swap.prlGrains };
  const base = { utxo, alicePrivHex: K[0].priv, destAddress: dest.address, feeRateGrainsPerVByte: 5 };
  // before maturity: loud refusal with blocks-to-go
  assert.throws(() => buildRefundSpend(net, swap, { ...base, currentHeight: swap.t1 - 1 }),
    new RegExp(`refund not yet mature.*${swap.t1 - 1}.*${swap.t1}`));
  // wrong key refused
  assert.throws(() => buildRefundSpend(net, swap, { ...base, currentHeight: swap.t1, alicePrivHex: K[1].priv }),
    /not Alice's refund key/);
  // at/after maturity: builds; wire bytes carry nLockTime=T1, sequence=0xfffffffe
  const refund = buildRefundSpend(net, swap, { ...base, currentHeight: swap.t1 });
  assert.ok(/^[0-9a-f]{64}$/.test(refund.txid));
  const parsed = parseTx(refund.hex);
  assert.equal(parsed.locktime, swap.t1);
  assert.equal(parsed.inputs[0].sequence, REFUND_SEQUENCE);
  assert.notEqual(parsed.inputs[0].sequence, 0xffffffff);
  const wit = parsed.inputs[0].witness;
  assert.equal(wit.length, 3); // [alice_sig, refundScript, controlBlock]
  assert.equal(wit[0].length, 64);
  assert.equal(bytesToHex(wit[1]), swap.refundScriptHex);
  // sighash commits the locktime: a different locktime gives a different digest
  const input = { txid: utxo.txid, vout: 0, value: utxo.value, spk: hexToBytes(swap.spkHex) };
  const outputs = [{ program: addressToProgram(dest.address, net), value: utxo.value - refund.feeGrains }];
  const d1 = bytesToHex(scriptPathSigDigestEx(net, input, outputs,
    hexToBytes(swap.refundScriptHex), { sequence: REFUND_SEQUENCE, locktime: swap.t1 }));
  const d2 = bytesToHex(scriptPathSigDigestEx(net, input, outputs,
    hexToBytes(swap.refundScriptHex), { sequence: REFUND_SEQUENCE, locktime: swap.t1 + 1 }));
  assert.notEqual(d1, d2);
  assert.equal(refund.digest, d1);
});

test("classifySwapState walks the full lifecycle", () => {
  const swap = makeSwap();
  assert.deepEqual(classifySwapState(swap, { fundingSeen: false, spends: [] }).state, "awaiting-funding");
  assert.deepEqual(classifySwapState(swap, { fundingSeen: true, spends: [] }).state, "locked");
  // build a real claim tx and a real refund tx, then classify
  const dest = walletFromMnemonic(
    "legal winner thank year wave sausage worth useful legal winner thank yellow", net);
  const utxo = { txid: "ab".repeat(32), vout: 0, value: swap.prlGrains };
  const claim = buildClaimSpend(net, swap, {
    utxo, preimageHex: KAV_PREIMAGE, bobPrivHex: K[1].priv,
    destAddress: dest.address, feeRateGrainsPerVByte: 5,
  });
  const st1 = classifySwapState(swap, { fundingSeen: true, spends: [{ txid: claim.txid, hex: claim.hex }] });
  assert.equal(st1.state, "claimed");
  assert.equal(st1.preimageHex, KAV_PREIMAGE);
  const refund = buildRefundSpend(net, swap, {
    utxo, alicePrivHex: K[0].priv, destAddress: dest.address,
    feeRateGrainsPerVByte: 5, currentHeight: swap.t1,
  });
  const st2 = classifySwapState(swap, { fundingSeen: true, spends: [{ txid: refund.txid, hex: refund.hex }] });
  assert.equal(st2.state, "refunded");
});

test("swapCountdown math", () => {
  const swap = makeSwap();
  const cd = swapCountdown(swap, 120000);
  assert.equal(cd.blocksToT1, 1000);
  assert.equal(cd.blocksToT2, 500);
  assert.equal(cd.etaSecsToT1, 1000 * PEARL_BLOCK_SECS);
  assert.equal(cd.t1Mature, false);
  const cd2 = swapCountdown(swap, 121000);
  assert.equal(cd2.t1Mature, true);
  assert.equal(cd2.blocksToT1, 0);
});

test("BTC mirror template: exact scripts, bc1p address, honest notes", () => {
  const swap = makeSwap();
  // without tips: no height suggestion, conversion formula shown
  const t0 = btcMirrorTemplate(swap, {});
  assert.equal(t0.suggestedBtcRefundHeight, null);
  assert.equal(t0.address, null);
  assert.ok(t0.conversionNote.includes("Convert T2 yourself"));
  assert.equal(t0.claimScriptHex, swap.claimScriptHex); // byte-identical claim leaf
  assert.ok(t0.honestNote.includes("does not build or sign Bitcoin transactions"));
  assert.equal(t0.steps.length, 8);
  // with tips: suggested height + real bc1p/tb1p addresses, control blocks re-derive
  const t1 = btcMirrorTemplate(swap, { btcNetwork: "mainnet", btcTip: 870000, pearlTip: 120000 });
  const expectH = 870000 + Math.ceil((500 * PEARL_BLOCK_SECS) / 600) + 6;
  assert.equal(t1.suggestedBtcRefundHeight, expectH);
  assert.ok(t1.address.startsWith("bc1p"), t1.address);
  assert.ok(t1.conversionNote.includes(String(expectH)));
  // both BTC control blocks re-derive against the tweaked key
  assert.equal(verifySwapControlBlock(
    hexToBytes(t1.internalKeyHex), hexToBytes(t1.claimScriptHex),
    hexToBytes(t1.controlBlocksHex[0]), hexToBytes(t1.tweakedHex)), true);
  assert.equal(verifySwapControlBlock(
    hexToBytes(t1.internalKeyHex), hexToBytes(t1.refundScriptHex),
    hexToBytes(t1.controlBlocksHex[1]), hexToBytes(t1.tweakedHex)), true);
  const t2 = btcMirrorTemplate(swap, { btcNetwork: "testnet", btcTip: 870000, pearlTip: 120000 });
  assert.ok(t2.address.startsWith("tb1p"), t2.address);
  assert.notEqual(t1.address, t2.address); // hrp differs
  // refund leaf pays Bob's key on the BTC side
  assert.ok(t2.refundAsm.includes("OP_CHECKLOCKTIMEVERIFY"));
});

test("describeSwap is human-readable", () => {
  const d = describeSwap(makeSwap());
  assert.ok(d.role.includes("Alice"));
  assert.equal(d.prl, "1.00000000");
  assert.equal(d.btc, "0.05000000 BTC");
  assert.equal(d.gap, 500);
  assert.ok(d.descriptor.startsWith("swap:v1:"));
});
