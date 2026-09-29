// Pearl Vesting core verification suite.
// Run: node --no-warnings --loader ./tests/loader.mjs tests/vesting.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  NETWORKS, DUST_GRAIN, GRAIN_PER_PRL,
  bytesToHex, hexToBytes, schnorr,
  validateLocktime, buildCltvScript, numsInternalKeyVesting, taptreeN,
  forgeTranche, planSchedule, descriptorFor, parseDescriptor,
  scheduleFromDescriptor, isMature, planClaimSweep, buildClaimTx,
  expectedAddress, parseXOnlyKey, scriptAsm, addressToProgram,
  verifySchnorrSig, signForXOnly, scriptPathSigDigestEx, encodeScriptNum,
  beneficiaryKeyFromInput, beneficiarySignerFor,
  tweakKeypath, tweakPrivKeypath,
  walletFromMnemonic,
} from "../src/vesting-core.js";
import { verifyControlBlock } from "../../escrow/src/escrow-core.js";
import { verifyCovenantControlBlock } from "../../covenant/src/covenant-core.js";
import { bytesToNumberBE, numberToBytesBE } from "@noble/curves/abstract/utils";
import { secp256k1 } from "@noble/curves/secp256k1";

const net = NETWORKS.mainnet;

// Deterministic test keys: priv 1..4 (x-only keys, even-Y normalized).
function testKey(i) {
  const priv = numberToBytesBE(BigInt(i), 32);
  const P = secp256k1.ProjectivePoint.fromPrivateKey(priv);
  const raw = P.toRawBytes(true);
  const xonly = bytesToHex(raw.slice(1));
  const negated = raw[0] === 0x03 ? secp256k1.CURVE.n - BigInt(i) : BigInt(i);
  return { priv: bytesToHex(numberToBytesBE(negated, 32)), xonly };
}
const B = testKey(1); // beneficiary
const F = testKey(2); // funder

test("locktime validation: heights and timestamps", () => {
  assert.equal(validateLocktime(1), "height");
  assert.equal(validateLocktime(499_999_999), "height");
  assert.equal(validateLocktime(500_000_000), "time");
  assert.equal(validateLocktime(1_789_000_000), "time");
  assert.equal(validateLocktime(0xffffffff), "time");
  assert.throws(() => validateLocktime(0), /locktime/);
  assert.throws(() => validateLocktime(-5), /locktime/);
  assert.throws(() => validateLocktime(0x100000000), /locktime/);
  assert.throws(() => validateLocktime(1.5), /locktime/);
});

test("CLTV script shape: byte-exact for height and timestamp locks", () => {
  const keyBytes = hexToBytes(B.xonly);
  // height lock 500000 (< 500M): encodeScriptNum -> 3 bytes
  const s1 = buildCltvScript(keyBytes, 500_000);
  const asm1 = scriptAsm(s1);
  assert.match(asm1, /CLTV/);
  assert.equal(s1[s1.length - 1], 0xac); // CHECKSIG
  // <lock-push> CLTV DROP <32-push> CHECKSIG
  const lockLen = s1[0];
  assert.ok(lockLen >= 1 && lockLen <= 5);
  assert.equal(s1[1 + lockLen], 0xb1); // CLTV
  assert.equal(s1[2 + lockLen], 0x75); // DROP
  assert.equal(s1[3 + lockLen], 32);
  assert.deepEqual(s1.slice(4 + lockLen, 36 + lockLen), keyBytes);
  // timestamp lock: 4-byte push (1_800_000_000 = 0x6B49D200, high bit clear)
  const s2 = buildCltvScript(B.xonly, 1_800_000_000);
  assert.equal(s2[0], 4);
  assert.equal(s2[5], 0xb1);
  // bad key rejected
  assert.throws(() => buildCltvScript("00".repeat(31), 500_000), /64 hex/);
  assert.throws(() => buildCltvScript(B.xonly, 0), /locktime/);
});

test("forgeTranche: deterministic, NUMS internal key, control blocks verify", () => {
  const t1 = forgeTranche(net, B.xonly, F.xonly, 1_800_000_000, true);
  const t2 = forgeTranche(net, B.xonly, F.xonly, 1_800_000_000, true);
  assert.equal(t1.address, t2.address);
  assert.ok(t1.address.startsWith("prl1p"));
  assert.equal(t1.clawbackScript && true, true);
  assert.equal(t1.controlBlocks.length, 2);
  assert.equal(t1.controlBlocks[0].length, 65);
  assert.equal(t1.claimControlBlock.length, 65);
  // control block re-derives the tweaked key (independent audit path)
  assert.ok(verifyControlBlock(t1.internalXOnly, t1.claimScript, t1.claimControlBlock, t1.tweakedX));
  assert.ok(verifyControlBlock(t1.internalXOnly, t1.clawbackScript, t1.clawbackControlBlock, t1.tweakedX));
  // NUMS: internal key is nobody's key — no keypath backdoor
  assert.notEqual(bytesToHex(t1.internalXOnly), B.xonly);
  assert.notEqual(bytesToHex(t1.internalXOnly), F.xonly);
  // non-revocable: single leaf, 33-byte control block, no clawback
  const t3 = forgeTranche(net, B.xonly, F.xonly, 1_800_000_000, false);
  assert.equal(t3.clawbackScript, null);
  assert.equal(t3.controlBlocks.length, 1);
  assert.equal(t3.claimControlBlock.length, 33);
  assert.ok(verifyCovenantControlBlock(t3.internalXOnly, t3.claimScript, t3.claimControlBlock, t3.tweakedX));
  assert.notEqual(t1.address, t3.address);
  // different lock -> different address
  const t4 = forgeTranche(net, B.xonly, F.xonly, 1_800_000_001, true);
  assert.notEqual(t1.address, t4.address);
  // tweaked key equals spk program
  assert.deepEqual(t1.spk.slice(2), t1.tweakedX);
});

test("planSchedule linear: locks, amounts, dust rules", () => {
  const start = 1_790_000_000, cliff = 86_400 * 30, vest = 86_400 * 365;
  const { schedule, tranches } = planSchedule({
    network: net, beneficiaryXOnly: B.xonly, funderXOnly: F.xonly,
    totalGrains: 4 * GRAIN_PER_PRL, startTime: start,
    cliffSeconds: cliff, vestSeconds: vest, trancheCount: 4, revocable: true,
  });
  assert.equal(tranches.length, 4);
  assert.equal(tranches[0].lock, start + cliff);
  assert.equal(tranches[3].lock, start + vest);
  const sum = tranches.reduce((s, t) => s + t.amountGrains, 0);
  assert.equal(sum, 4 * GRAIN_PER_PRL);
  assert.equal(tranches[3].amountGrains - tranches[0].amountGrains, (4 * GRAIN_PER_PRL) % 4);
  assert.equal(schedule.totalGrains, 4 * GRAIN_PER_PRL);
  assert.ok(schedule.descriptor.startsWith("vesting:v1:prl:"));
  for (const t of tranches) {
    assert.ok(t.amountGrains >= DUST_GRAIN);
    assert.ok(t.address.startsWith("prl1p"));
  }
  // single tranche: lock = start + cliff
  const one = planSchedule({ network: net, beneficiaryXOnly: B.xonly, funderXOnly: F.xonly, totalGrains: GRAIN_PER_PRL, startTime: start, cliffSeconds: cliff, vestSeconds: vest, trancheCount: 1, revocable: false });
  assert.equal(one.tranches[0].lock, start + cliff);
  // dust refusal: total below dust per tranche
  assert.throws(() => planSchedule({ network: net, beneficiaryXOnly: B.xonly, funderXOnly: F.xonly, totalGrains: 1000, startTime: start, cliffSeconds: 0, vestSeconds: 100, trancheCount: 4 }), /dust/);
  assert.throws(() => planSchedule({ network: net, beneficiaryXOnly: B.xonly, funderXOnly: F.xonly, totalGrains: GRAIN_PER_PRL, startTime: start, cliffSeconds: 0, vestSeconds: 100, trancheCount: 65 }), /1..64/);
});

test("planSchedule custom tranches: sorted, validated, summed", () => {
  const now = 1_790_000_000;
  const { schedule, tranches } = planSchedule({
    network: net, beneficiaryXOnly: B.xonly, funderXOnly: F.xonly,
    totalGrains: 0, startTime: 0, cliffSeconds: 0, vestSeconds: 1,
    customTranches: [
      { lock: now + 300, amountGrains: 2000 },
      { lock: now + 100, amountGrains: 1000 },
    ],
  });
  assert.equal(tranches[0].lock, now + 100); // sorted by lock
  assert.equal(schedule.totalGrains, 3000);
  assert.throws(() => planSchedule({ network: net, beneficiaryXOnly: B.xonly, funderXOnly: F.xonly, totalGrains: 0, startTime: 0, cliffSeconds: 0, vestSeconds: 1, customTranches: [{ lock: now, amountGrains: 1000 }, { lock: now, amountGrains: 1000 }] }), /strictly increasing/);
  assert.throws(() => planSchedule({ network: net, beneficiaryXOnly: B.xonly, funderXOnly: F.xonly, totalGrains: 0, startTime: 0, cliffSeconds: 0, vestSeconds: 1, customTranches: [{ lock: now, amountGrains: 100 }] }), /dust/);
});

test("descriptor round-trip: re-derives identical addresses", () => {
  const start = 1_790_000_000;
  const { schedule, tranches } = planSchedule({
    network: net, beneficiaryXOnly: B.xonly, funderXOnly: F.xonly,
    totalGrains: 2 * GRAIN_PER_PRL, startTime: start,
    cliffSeconds: 0, vestSeconds: 86_400 * 90, trancheCount: 3, revocable: true,
  });
  const rt = scheduleFromDescriptor(schedule.descriptor, tranches.map((t) => t.amountGrains));
  assert.equal(rt.tranches.length, 3);
  rt.tranches.forEach((t, i) => assert.equal(t.address, tranches[i].address));
  assert.equal(rt.schedule.beneficiary, B.xonly.toLowerCase());
  assert.equal(rt.schedule.funder, F.xonly.toLowerCase());
  assert.equal(rt.schedule.revocable, true);
  // tampered locktime -> different addresses (tamper-evident): the funder
  // re-derives from the descriptor and spots the mismatch
  const evilLocks = schedule.descriptor.replace(String(tranches[0].lock), String(tranches[0].lock + 3600));
  const rt2 = scheduleFromDescriptor(evilLocks);
  assert.notEqual(rt2.tranches[0].address, tranches[0].address);
  // tampered key that is not a curve point -> rejected outright
  const evilKey = schedule.descriptor.replace(B.xonly.toLowerCase().slice(0, 8), "ff".repeat(4));
  assert.throws(() => scheduleFromDescriptor(evilKey));
  // malformed descriptors rejected
  assert.throws(() => parseDescriptor("vesting:v1:prl:xyz"), /vesting:v1/);
  assert.throws(() => parseDescriptor(schedule.descriptor.replace(":r:", ":x:")), /vesting:v1/);
});

test("isMature boundary", () => {
  assert.equal(isMature(1_800_000_000, 1_800_000_000), true);
  assert.equal(isMature(1_800_000_000, 1_799_999_999), false);
  assert.equal(isMature(500_000, 500_000), true);
});

test("planClaimSweep: exact fee math, dust refusal", () => {
  const t = forgeTranche(net, B.xonly, F.xonly, 1_800_000_000, true);
  const p = planClaimSweep({ inputValue: 100_000_000, feeRateGrainsPerVByte: 10, scriptLen: t.claimScript.length, controlLen: 65 });
  assert.equal(p.payment, 100_000_000 - p.fee);
  assert.ok(p.vBytes > 100 && p.vBytes < 300);
  assert.throws(() => planClaimSweep({ inputValue: 500, feeRateGrainsPerVByte: 10, scriptLen: t.claimScript.length, controlLen: 65 }), /insufficient funds/);
});

test("buildClaimTx: full sign cycle, nLockTime, sequence, wrong-key refusal", () => {
  const t = forgeTranche(net, B.xonly, F.xonly, 1_800_000_000, true);
  const utxo = { txid: "ab".repeat(32), vout: 0, value: 50_000_000 };
  // beneficiary payout: keypath P2TR to the beneficiary's own x-only key
  const destProgram = hexToBytes(B.xonly);
  const claim = buildClaimTx({
    network: net, utxo, tranche: t,
    leaf: t.claimScript, controlBlock: t.claimControlBlock,
    signerPriv: hexToBytes(B.priv), destinationProgram: destProgram,
    feeRateGrainsPerVByte: 10,
  });
  assert.equal(claim.locktime, 1_800_000_000);
  assert.equal(claim.sequence, 0xfffffffe);
  assert.equal(claim.payment + claim.fee, 50_000_000);
  assert.match(claim.scriptAsm, /CLTV/);
  // independent re-verification of the signature against the leaf key
  const digest = scriptPathSigDigestEx(net,
    { txid: utxo.txid, vout: 0, value: utxo.value, spk: t.spk },
    [{ program: destProgram, value: claim.payment }],
    t.claimScript, { sequence: 0xfffffffe, locktime: 1_800_000_000 });
  assert.equal(claim.digestHex, bytesToHex(digest));
  assert.ok(verifySchnorrSig(hexToBytes(claim.sigHex), digest, hexToBytes(B.xonly)));
  // serialized tx carries the right locktime + sequence
  const raw = hexToBytes(claim.hex);
  const lockLE = raw.slice(raw.length - 4);
  assert.equal(lockLE[0] | (lockLE[1] << 8) | (lockLE[2] << 16) | (lockLE[3] << 24), 1_800_000_000);
  // wrong signer (funder key on the beneficiary leaf) refused
  assert.throws(() => buildClaimTx({
    network: net, utxo, tranche: t, leaf: t.claimScript,
    controlBlock: t.claimControlBlock, signerPriv: hexToBytes(F.priv),
    destinationProgram: destProgram, feeRateGrainsPerVByte: 10,
  }), /does not match the key committed in this leaf/);
});

test("clawback: funder reclaims via clawback leaf on revocable schedule", () => {
  const t = forgeTranche(net, B.xonly, F.xonly, 1_800_000_000, true);
  const utxo = { txid: "cd".repeat(32), vout: 1, value: 25_000_000 };
  const destProgram = hexToBytes(F.xonly);
  const cb = buildClaimTx({
    network: net, utxo, tranche: t,
    leaf: t.clawbackScript, controlBlock: t.clawbackControlBlock,
    signerPriv: hexToBytes(F.priv), destinationProgram: destProgram,
    feeRateGrainsPerVByte: 10,
  });
  assert.equal(cb.locktime, 1_800_000_000);
  assert.equal(cb.payment + cb.fee, 25_000_000);
  // beneficiary cannot spend the clawback leaf
  assert.throws(() => buildClaimTx({
    network: net, utxo, tranche: t, leaf: t.clawbackScript,
    controlBlock: t.clawbackControlBlock, signerPriv: hexToBytes(B.priv),
    destinationProgram: destProgram, feeRateGrainsPerVByte: 10,
  }), /does not match/);
  // non-revocable tranche has no clawback leaf at all
  const nr = forgeTranche(net, B.xonly, F.xonly, 1_800_000_000, false);
  assert.equal(nr.clawbackScript, null);
});

test("beneficiaryKeyFromInput: x-only, address, mnemonic", () => {
  const raw = beneficiaryKeyFromInput(B.xonly, net);
  assert.equal(raw.mode, "raw");
  assert.equal(bytesToHex(raw.key), B.xonly);
  const w = walletFromMnemonic("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about", net);
  const addrMode = beneficiaryKeyFromInput(w.address, net);
  assert.equal(addrMode.mode, "address");
  assert.equal(bytesToHex(addrMode.key), bytesToHex(tweakKeypath(w.internalXOnly).tweakedX));
  const mn = beneficiaryKeyFromInput("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about", net);
  assert.equal(mn.mode, "address");
  assert.equal(bytesToHex(mn.key), bytesToHex(tweakKeypath(w.internalXOnly).tweakedX));
  assert.throws(() => beneficiaryKeyFromInput("not a key", net));
  assert.throws(() => beneficiaryKeyFromInput("bc1p" + "0".repeat(58), net), /bad checksum|wrong network HRP/);
});

test("beneficiarySignerFor: raw + tweaked signing paths", () => {
  const mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  const w = walletFromMnemonic(mnemonic, net);
  const tweaked = bytesToHex(tweakKeypath(w.internalXOnly).tweakedX);
  // raw mode
  const s1 = beneficiarySignerFor(mnemonic, net, bytesToHex(w.internalXOnly), "raw");
  assert.ok(verifySchnorrSig(signForXOnly(s1.priv, new Uint8Array(32).fill(7)), new Uint8Array(32).fill(7), s1.xonly));
  assert.throws(() => beneficiarySignerFor(mnemonic, net, tweaked, "raw"), /does not match/);
  // address (tweaked) mode: signer pubkey must equal the tweaked leaf key
  const s2 = beneficiarySignerFor(mnemonic, net, tweaked, "address");
  assert.equal(bytesToHex(s2.xonly).toLowerCase(), tweaked.toLowerCase());
  // garbage secret rejected
  assert.throws(() => beneficiarySignerFor("definitely not a secret", net, tweaked, "address"), /mnemonic or WIF/);
});

test("planSchedule with address-mode beneficiary: claim signs via tweaked key", () => {
  const mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  const w = walletFromMnemonic(mnemonic, net);
  const ben = beneficiaryKeyFromInput(w.address, net);
  assert.equal(ben.mode, "address");
  const { schedule, tranches } = planSchedule({
    network: net, beneficiary: ben, funderXOnly: F.xonly,
    totalGrains: GRAIN_PER_PRL, startTime: 1_790_000_000,
    cliffSeconds: 0, vestSeconds: 86_400, trancheCount: 2, revocable: false,
  });
  assert.equal(schedule.beneficiaryMode, "address");
  assert.ok(schedule.descriptor.includes(":n:addr:"));
  const t = tranches[0];
  const signer = beneficiarySignerFor(mnemonic, net, t.beneficiary, schedule.beneficiaryMode);
  const claim = buildClaimTx({
    network: net, utxo: { txid: "aa".repeat(32), vout: 0, value: 50_000_000 },
    tranche: t, leaf: t.claimScript, controlBlock: t.claimControlBlock,
    signerPriv: signer.priv, destinationProgram: signer.xonly,
    feeRateGrainsPerVByte: 10,
  });
  assert.equal(claim.payment + claim.fee, 50_000_000);
  // descriptor round-trip preserves mode
  const rt = scheduleFromDescriptor(schedule.descriptor, tranches.map((x) => x.amountGrains));
  assert.equal(rt.schedule.beneficiaryMode, "address");
  assert.equal(rt.tranches[0].address, t.address);
});

test("mnemonic beneficiary key end-to-end forge", () => {
  const mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  const w = walletFromMnemonic(mnemonic, net);
  const { tranches } = planSchedule({
    network: net, beneficiaryXOnly: bytesToHex(w.internalXOnly), funderXOnly: F.xonly,
    totalGrains: GRAIN_PER_PRL, startTime: 1_790_000_000,
    cliffSeconds: 0, vestSeconds: 86_400, trancheCount: 2, revocable: false,
  });
  assert.equal(tranches.length, 2);
  const t = tranches[0];
  const claim = buildClaimTx({
    network: net, utxo: { txid: "ef".repeat(32), vout: 0, value: GRAIN_PER_PRL / 2 },
    tranche: t, leaf: t.claimScript, controlBlock: t.claimControlBlock,
    signerPriv: w.priv, destinationProgram: w.internalXOnly,
    feeRateGrainsPerVByte: 10,
  });
  assert.ok(claim.hex.length > 200);
  assert.ok(verifySchnorrSig(hexToBytes(claim.sigHex), hexToBytes(claim.digestHex), w.internalXOnly));
});
