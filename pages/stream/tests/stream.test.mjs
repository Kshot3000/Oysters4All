// Pearl Stream core verification suite.
// Run: node --no-warnings --loader ./tests/loader.mjs tests/stream.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  NETWORKS, DUST_GRAIN, GRAIN_PER_PRL,
  bytesToHex, hexToBytes, schnorr, sha256,
  forgeTranche, forgeTick, planStream, descriptorForStream, parseDescriptor,
  scheduleFromDescriptor, streamState,
  batchScriptPathSigDigest, batchClaimVBytes, planBatchClaim,
  buildBatchClaimTx, buildBatchScriptPathSpend, committedLeafKey, tickLeafFor,
  beneficiaryKeyFromInput, beneficiarySignerFor, isMature,
  parsePRLToGrains,
  partyKeyFromInput, parseXOnlyKey, scriptAsm, addressToProgram,
  verifySchnorrSig, signForXOnly, encodeScriptNum,
  tweakKeypath, walletFromMnemonic,
} from "../src/stream-core.js";
import { verifyControlBlock } from "../../escrow/src/escrow-core.js";
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
const NOW = 1_790_000_000; // fixed "past" reference time for maturity tests

function planTestStream(over = {}) {
  return planStream({
    network: net, beneficiaryXOnly: B.xonly, funderXOnly: F.xonly,
    rateGrainsPerTick: 10_000_000, tickSeconds: 86_400,
    startTime: NOW - 10 * 86_400, tickCount: 12, revocable: true,
    ...over,
  });
}

test("planStream: tick-lock math, rate*N total, validation errors", () => {
  const { schedule, ticks } = planTestStream();
  assert.equal(ticks.length, 12);
  ticks.forEach((t, i) => {
    assert.equal(t.lock, NOW - 10 * 86_400 + i * 86_400, "tick " + i + " lock");
    assert.equal(t.amountGrains, 10_000_000);
    assert.equal(t.lockKind, "time");
    assert.ok(t.address.startsWith("prl1p"));
  });
  assert.equal(schedule.totalGrains, 10_000_000 * 12); // rate*N exactly
  assert.equal(schedule.rateGrainsPerTick, 10_000_000);
  assert.equal(schedule.tickSeconds, 86_400);
  assert.ok(schedule.descriptor.startsWith("stream:v1:prl:"));
  const base = { network: net, beneficiaryXOnly: B.xonly, funderXOnly: F.xonly, tickSeconds: 60, startTime: NOW, tickCount: 4 };
  assert.throws(() => planStream({ ...base, rateGrainsPerTick: 545 }), /dust/);
  assert.throws(() => planStream({ ...base, rateGrainsPerTick: 1.5 }), /integer/);
  assert.throws(() => planStream({ ...base, rateGrainsPerTick: 1000, tickCount: 0 }), /1\.\.256/);
  assert.throws(() => planStream({ ...base, rateGrainsPerTick: 1000, tickCount: 257 }), /1\.\.256/);
  assert.throws(() => planStream({ ...base, rateGrainsPerTick: 1000, startTime: 499_999_999 }), /unix timestamp/);
  assert.throws(() => planStream({ ...base, rateGrainsPerTick: 1000, tickSeconds: 0 }), /positive integer/);
  assert.throws(() => planStream({ ...base, rateGrainsPerTick: 1000, startTime: 0xffffffff, tickCount: 2, tickSeconds: 1 }), /maximum locktime/);
  assert.throws(() => planStream({ ...base, rateGrainsPerTick: 1000, tickCount: 2, funderXOnly: "zz" }), /64 hex/);
});

test("forgeTick: deterministic, NUMS internal key, timestamp-only, control blocks verify", () => {
  const t1 = forgeTick(net, B.xonly, F.xonly, NOW, true);
  const t2 = forgeTick(net, B.xonly, F.xonly, NOW, true);
  assert.equal(t1.address, t2.address);
  assert.notEqual(t1.address, forgeTick(net, B.xonly, F.xonly, NOW + 60, true).address);
  assert.notEqual(bytesToHex(t1.internalXOnly), B.xonly);
  assert.notEqual(bytesToHex(t1.internalXOnly), F.xonly);
  assert.equal(t1.controlBlocks.length, 2);
  assert.ok(verifyControlBlock(t1.internalXOnly, t1.claimScript, t1.claimControlBlock, t1.tweakedX));
  assert.ok(verifyControlBlock(t1.internalXOnly, t1.clawbackScript, t1.clawbackControlBlock, t1.tweakedX));
  // matches vesting forgeTranche exactly (same construction)
  const v = forgeTranche(net, B.xonly, F.xonly, NOW, true);
  assert.equal(t1.address, v.address);
  assert.deepEqual(t1.claimScript, v.claimScript);
  // non-revocable: no clawback leaf
  const nr = forgeTick(net, B.xonly, F.xonly, NOW, false);
  assert.equal(nr.clawbackScript, null);
  assert.equal(nr.claimControlBlock.length, 33);
  // height locks rejected (timestamps only)
  assert.throws(() => forgeTick(net, B.xonly, F.xonly, 500_000, true), /unix timestamps/);
  // leaf shapes
  assert.match(scriptAsm(t1.claimScript), /CLTV/);
  assert.deepEqual(committedLeafKey(t1.claimScript), hexToBytes(B.xonly));
  assert.deepEqual(committedLeafKey(t1.clawbackScript), hexToBytes(F.xonly));
  assert.throws(() => tickLeafFor(nr, "clawback"), /not revocable/);
  assert.throws(() => tickLeafFor(t1, "bogus"), /role/);
});

test("descriptor round-trip: re-derives identical ticks, tamper-evidence", () => {
  const { schedule, ticks } = planTestStream();
  const rt = scheduleFromDescriptor(schedule.descriptor);
  assert.equal(rt.ticks.length, ticks.length);
  rt.ticks.forEach((t, i) => assert.equal(t.address, ticks[i].address));
  assert.equal(rt.schedule.rateGrainsPerTick, 10_000_000);
  assert.equal(rt.schedule.tickCount, 12);
  assert.equal(rt.schedule.revocable, true);
  assert.equal(rt.schedule.beneficiaryMode, "raw");
  // tampered start -> re-derived addresses differ (the funder spots it)
  const tampered = schedule.descriptor.replace(String(NOW - 10 * 86_400), String(NOW - 10 * 86_400 + 1));
  const rt2 = scheduleFromDescriptor(tampered);
  assert.notEqual(rt2.ticks[0].address, ticks[0].address);
  // tampered rate changes expected amounts -> funding check catches it
  const tamperedRate = schedule.descriptor.replace(":10000000:", ":20000000:");
  const rt3 = scheduleFromDescriptor(tamperedRate);
  assert.equal(rt3.schedule.rateGrainsPerTick, 20_000_000);
  assert.notEqual(rt3.schedule.totalGrains, schedule.totalGrains);
  // tampered key off the curve -> rejected outright
  const evilKey = schedule.descriptor.replace(B.xonly.slice(0, 8), "ff".repeat(4));
  assert.throws(() => scheduleFromDescriptor(evilKey));
  // malformed rejected
  assert.throws(() => parseDescriptor("stream:v1:prl:garbage"), /stream:v1/);
  assert.throws(() => parseDescriptor(schedule.descriptor.replace(":r:", ":x:")), /stream:v1/);
  assert.throws(() => parseDescriptor(schedule.descriptor.replace(":raw:", ":x:")), /stream:v1/);
  // unknown hrp rejected
  assert.throws(() => parseDescriptor(schedule.descriptor.replace(":prl:", ":xxl:")), /unknown network/);
  // rate below dust in descriptor rejected
  assert.throws(() => parseDescriptor(schedule.descriptor.replace(":10000000:", ":1:")), /dust/);
  // hand-edited string that does not regenerate itself -> rejected
  // (uppercase hex parses case-insensitively but regenerates lowercase)
  const upper = schedule.descriptor.replace(schedule.beneficiary, schedule.beneficiary.toUpperCase());
  assert.throws(() => scheduleFromDescriptor(upper), /self-consistency/);
});

test("streamState: accrual math", () => {
  const { ticks } = planTestStream();
  // fund ticks 0..4, scan at a time when ticks 0..2 have matured
  const chainTime = NOW - 10 * 86_400 + 2 * 86_400;
  ticks.forEach((t, i) => { t.funded = i < 5; });
  const st = streamState(ticks, chainTime);
  assert.equal(st.tickCount, 12);
  assert.equal(st.totalGrains, 12 * 10_000_000);
  assert.equal(st.streamedGrains, 3 * 10_000_000); // ticks 0,1,2 matured+funded
  assert.equal(st.claimableGrains, st.streamedGrains);
  assert.equal(st.remainingGrains, 9 * 10_000_000);
  assert.equal(st.percentStreamed, 25);
  st.ticks.forEach((r, i) => {
    assert.equal(r.matured, i <= 2, "tick " + i + " matured");
    assert.equal(r.funded, i < 5, "tick " + i + " funded");
    assert.equal(r.amount, 10_000_000);
    assert.equal(r.lock, NOW - 10 * 86_400 + i * 86_400);
  });
  // all matured, all funded -> 100%
  ticks.forEach((t) => { t.funded = true; });
  const full = streamState(ticks, NOW + 365 * 86_400);
  assert.equal(full.streamedGrains, full.totalGrains);
  assert.equal(full.remainingGrains, 0);
  assert.equal(full.percentStreamed, 100);
  assert.throws(() => streamState([], 1), /ticks required/);
});

test("isMature boundaries (chain-time gating)", () => {
  assert.equal(isMature(NOW, NOW), true);
  assert.equal(isMature(NOW, NOW - 1), false);
  assert.equal(isMature(500_000_000, 500_000_000), true);
  assert.throws(() => isMature(0, NOW), /locktime/);
});

function syntheticInputs(ticks, values) {
  return ticks.map((t, i) => ({
    txid: (i + 1).toString(16).padStart(64, "ab"[i % 2] === "a" ? "a" : "c").slice(0, 64).padEnd(64, "0"),
    vout: i, value: values[i], tick: t,
  }));
}

test("batch claim full cycle: 3 ticks -> one sweep, sigs verify, hex parses", () => {
  const { ticks } = planTestStream({ tickCount: 3 });
  const inputs = syntheticInputs(ticks, [50_000_000, 60_000_000, 70_000_000]);
  const dest = hexToBytes(B.xonly);
  const built = buildBatchClaimTx({
    network: net, inputs, role: "claim",
    signerPriv: hexToBytes(B.priv), destinationProgram: dest,
    feeRateGrainsPerVByte: 10,
  });
  assert.equal(built.inputCount, 3);
  assert.equal(built.inputSum, 180_000_000);
  assert.equal(built.payment + built.fee, 180_000_000);
  assert.ok(built.payment >= DUST_GRAIN);
  assert.equal(built.locktime, ticks[2].lock); // max lock
  assert.equal(built.sequence, 0xfffffffe);
  assert.equal(built.sigsHex.length, 3);
  assert.equal(built.digestsHex.length, 3);
  // independent re-verification of every signature against its own digest
  built.digestsHex.forEach((dh, i) => {
    const dg = hexToBytes(dh);
    assert.ok(verifySchnorrSig(hexToBytes(built.sigsHex[i]), dg, hexToBytes(B.xonly)), "sig " + i + " verifies");
    assert.equal(dg.length, 32);
  });
  // digests differ per input (input index + leaf hash feed the message)
  assert.equal(new Set(built.digestsHex).size, 3);
  // parse the built hex: version, segwit marker/flag, input count, locktime, sequences
  const raw = hexToBytes(built.hex);
  assert.equal(raw[0], 1); // tx version
  assert.equal(raw[4], 0x00); // segwit marker
  assert.equal(raw[5], 0x01); // segwit flag
  assert.equal(raw[6], 3); // varint input count
  const seqOff = 7 + 2 * 41; // version+marker+flag+count, inputs 0..1 (41B each), third input starts here
  const seq3 = raw[seqOff + 32 + 4 + 1] | (raw[seqOff + 32 + 4 + 2] << 8) | (raw[seqOff + 32 + 4 + 3] << 16) | (raw[seqOff + 32 + 4 + 4] << 24) >>> 0;
  assert.equal(seq3 >>> 0, 0xfffffffe);
  const lockLE = raw.slice(raw.length - 4);
  const lock = (lockLE[0] | (lockLE[1] << 8) | (lockLE[2] << 16) | (lockLE[3] << 24)) >>> 0;
  assert.equal(lock, ticks[2].lock);
});

test("independent sighash cross-check: node:crypto sha256 recomputation", () => {
  // Recompute each input's BIP-341 digest from scratch with node:crypto
  // (NOT the noble sha256 the core uses) and byte-compare with the core.
  const sha = (b) => createHash("sha256").update(b).digest();
  const tagged = (tag, data) => sha(Buffer.concat([sha(Buffer.from(tag, "utf8")), sha(Buffer.from(tag, "utf8")), data]));
  const { ticks } = planTestStream({ tickCount: 2 });
  const inputs = syntheticInputs(ticks, [40_000_000, 55_000_000]);
  const dest = hexToBytes(B.xonly);
  const built = buildBatchClaimTx({
    network: net, inputs, role: "claim",
    signerPriv: hexToBytes(B.priv), destinationProgram: dest,
    feeRateGrainsPerVByte: 10,
  });
  const txidLE = (h) => Buffer.from(h, "hex").reverse();
  const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const varint = (n) => {
    if (n < 0xfd) return Buffer.from([n]);
    if (n <= 0xffff) { const b = Buffer.alloc(3); b[0] = 0xfd; b.writeUInt16LE(n, 1); return b; }
    throw new Error("varint too large for test");
  };
  const specs = inputs.map((x) => ({ txid: x.txid, vout: x.vout, value: x.value, spk: Buffer.from(ticks.find((t) => t === x.tick).spk) }));
  const outputs = [{ program: dest, value: built.payment }];
  const tapLeafHash = (script) => tagged("TapLeaf", Buffer.concat([Buffer.from([0xc0]), varint(script.length), Buffer.from(script)]));
  const prevouts = sha(Buffer.concat(specs.flatMap((x) => [txidLE(x.txid), u32le(x.vout)])));
  const amounts = sha(Buffer.concat(specs.map((x) => u64le(x.value))));
  const spks = sha(Buffer.concat(specs.flatMap((x) => [varint(x.spk.length), x.spk])));
  const seqs = sha(Buffer.concat(specs.map(() => u32le(0xfffffffe))));
  const outs = sha(Buffer.concat(outputs.flatMap((o) => {
    const s = Buffer.concat([Buffer.from([0x51, 0x20]), Buffer.from(o.program)]);
    return [u64le(o.value), varint(s.length), s];
  })));
  specs.forEach((_, i) => {
    const leafHash = tapLeafHash(ticks[i].claimScript);
    const msg = Buffer.concat([
      Buffer.from([0x00, 0x00]), u32le(net.txVersion), u32le(ticks[1].lock),
      prevouts, amounts, spks, seqs, outs,
      Buffer.from([0x02]), u32le(i), leafHash, Buffer.from([0x00, 0xff, 0xff, 0xff, 0xff]), // 0x02 = script path (ext_flag=1), BIP-341
    ]);
    const independent = tagged("TapSighash", msg);
    assert.equal(independent.toString("hex"), built.digestsHex[i], "input " + i + " digest byte-equality");
    // verify the emitted signature against the INDEPENDENT digest
    assert.ok(schnorr.verify(hexToBytes(built.sigsHex[i]), new Uint8Array(independent), hexToBytes(B.xonly)), "sig " + i + " verifies on independent digest");
  });
});

test("wrong-signer-key refusal for a mismatched leaf", () => {
  const { ticks } = planTestStream({ tickCount: 2 });
  const inputs = syntheticInputs(ticks, [50_000_000, 50_000_000]);
  // funder key on beneficiary claim leaves -> refused
  assert.throws(() => buildBatchClaimTx({
    network: net, inputs, role: "claim",
    signerPriv: hexToBytes(F.priv), destinationProgram: hexToBytes(F.xonly),
    feeRateGrainsPerVByte: 10,
  }), /does not match the key committed in this leaf/);
  // beneficiary key on funder clawback leaves -> refused
  assert.throws(() => buildBatchClaimTx({
    network: net, inputs, role: "clawback",
    signerPriv: hexToBytes(B.priv), destinationProgram: hexToBytes(B.xonly),
    feeRateGrainsPerVByte: 10,
  }), /does not match the key committed in this leaf/);
});

test("dust-payment refusal and fee cross-check (planner vBytes == serializer vBytes)", () => {
  const { ticks } = planTestStream({ tickCount: 2 });
  const scriptLens = ticks.map((t) => t.claimScript.length);
  const controlLens = ticks.map((t) => t.claimControlBlock.length);
  // tiny inputs: fee eats everything -> dust refusal (fee ~2230 grains at 10 gr/vB)
  assert.throws(() => planBatchClaim({
    inputs: [{ value: 500 }, { value: 500 }],
    scriptLens, controlLens, feeRateGrainsPerVByte: 10,
  }), /insufficient funds/);
  assert.throws(() => buildBatchClaimTx({
    network: net,
    inputs: syntheticInputs(ticks, [500, 500]),
    role: "claim", signerPriv: hexToBytes(B.priv),
    destinationProgram: hexToBytes(B.xonly), feeRateGrainsPerVByte: 10,
  }), /insufficient funds/);
  // planner vBytes == buildBatchScriptPathSpend vBytes == batchClaimVBytes
  const inputs = syntheticInputs(ticks, [50_000_000, 50_000_000]);
  const plan = planBatchClaim({ inputs, scriptLens, controlLens, feeRateGrainsPerVByte: 10 });
  const expected = batchClaimVBytes({ nIn: 2, scriptLens, controlLens });
  assert.equal(plan.vBytes, expected);
  const built = buildBatchClaimTx({
    network: net, inputs, role: "claim",
    signerPriv: hexToBytes(B.priv), destinationProgram: hexToBytes(B.xonly),
    feeRateGrainsPerVByte: 10,
  });
  assert.equal(built.vBytes, plan.vBytes);
  // serializer cross-check fires on tampered digests
  const specs = inputs.map((x) => ({ txid: x.txid, vout: x.vout, value: x.value, spk: x.tick.spk }));
  const leaves = ticks.map((t) => t.claimScript);
  const controls = ticks.map((t) => t.claimControlBlock);
  const dg = specs.map((_, i) => batchScriptPathSigDigest(net, specs, [{ program: hexToBytes(B.xonly), value: plan.payment }], leaves[i], { sequence: 0xfffffffe, locktime: ticks[1].lock, inputIdx: i }));
  const sigs = dg.map((d) => signForXOnly(hexToBytes(B.priv), d));
  assert.throws(() => buildBatchScriptPathSpend(net, specs, [{ program: hexToBytes(B.xonly), value: plan.payment }], leaves, controls, sigs, {
    sequence: 0xfffffffe, locktime: ticks[1].lock,
    expectedDigests: dg.map(() => "00".repeat(32)),
  }), /sighash mismatch/);
});

test("cancel-clawback full cycle with funder key", () => {
  // unmatured ticks (locks in the future): cancel sweeps clawback leaves
  const start = NOW + 30 * 86_400;
  const { ticks } = planStream({
    network: net, beneficiaryXOnly: B.xonly, funderXOnly: F.xonly,
    rateGrainsPerTick: 10_000_000, tickSeconds: 86_400,
    startTime: start, tickCount: 4, revocable: true,
  });
  const inputs = syntheticInputs(ticks, [50_000_000, 50_000_000, 50_000_000, 50_000_000]);
  const built = buildBatchClaimTx({
    network: net, inputs, role: "clawback",
    signerPriv: hexToBytes(F.priv), destinationProgram: hexToBytes(F.xonly),
    feeRateGrainsPerVByte: 10,
  });
  assert.equal(built.role, "clawback");
  assert.equal(built.locktime, start + 3 * 86_400); // max lock of inputs
  assert.equal(built.inputCount, 4);
  assert.equal(built.payment + built.fee, 200_000_000);
  built.digestsHex.forEach((dh, i) => {
    assert.ok(verifySchnorrSig(hexToBytes(built.sigsHex[i]), hexToBytes(dh), hexToBytes(F.xonly)), "clawback sig " + i);
  });
  // non-revocable stream cannot be cancelled
  const nr = planStream({
    network: net, beneficiaryXOnly: B.xonly, funderXOnly: F.xonly,
    rateGrainsPerTick: 10_000_000, tickSeconds: 86_400,
    startTime: start, tickCount: 2, revocable: false,
  });
  assert.throws(() => buildBatchClaimTx({
    network: net, inputs: syntheticInputs(nr.ticks, [50_000_000, 50_000_000]),
    role: "clawback", signerPriv: hexToBytes(F.priv),
    destinationProgram: hexToBytes(F.xonly), feeRateGrainsPerVByte: 10,
  }), /not revocable/);
});

test("address-mode beneficiary: mnemonic -> tweaked key signs the batch", () => {
  const mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  const w = walletFromMnemonic(mnemonic, net);
  const ben = beneficiaryKeyFromInput(w.address, net);
  assert.equal(ben.mode, "address");
  const { schedule, ticks } = planStream({
    network: net, beneficiary: ben, funderXOnly: F.xonly,
    rateGrainsPerTick: 10_000_000, tickSeconds: 86_400,
    startTime: NOW - 5 * 86_400, tickCount: 2, revocable: true,
  });
  assert.equal(schedule.beneficiaryMode, "address");
  assert.ok(schedule.descriptor.includes(":r:addr:"));
  const tweaked = bytesToHex(tweakKeypath(w.internalXOnly).tweakedX);
  assert.equal(schedule.beneficiary.toLowerCase(), tweaked.toLowerCase());
  const signer = beneficiarySignerFor(mnemonic, net, schedule.beneficiary, "address");
  const built = buildBatchClaimTx({
    network: net, inputs: syntheticInputs(ticks, [50_000_000, 50_000_000]),
    role: "claim", signerPriv: signer.priv,
    destinationProgram: signer.xonly, feeRateGrainsPerVByte: 10,
  });
  assert.equal(built.payment + built.fee, 100_000_000);
  built.digestsHex.forEach((dh, i) => {
    assert.ok(verifySchnorrSig(hexToBytes(built.sigsHex[i]), hexToBytes(dh), signer.xonly), "sig " + i);
  });
  const rt = scheduleFromDescriptor(schedule.descriptor);
  assert.equal(rt.schedule.beneficiaryMode, "address");
  assert.equal(rt.ticks[0].address, ticks[0].address);
});

test("single-tick batch == per-tick sweep sanity (amounts, locktime, sequence)", () => {
  const { ticks } = planTestStream({ tickCount: 1 });
  const built = buildBatchClaimTx({
    network: net, inputs: syntheticInputs(ticks, [25_000_000]),
    role: "claim", signerPriv: hexToBytes(B.priv),
    destinationProgram: hexToBytes(B.xonly), feeRateGrainsPerVByte: 10,
  });
  assert.equal(built.locktime, ticks[0].lock);
  assert.equal(built.payment + built.fee, 25_000_000);
  assert.ok(verifySchnorrSig(hexToBytes(built.sigsHex[0]), hexToBytes(built.digestsHex[0]), hexToBytes(B.xonly)));
  // destination must be a 32-byte program
  assert.throws(() => buildBatchClaimTx({
    network: net, inputs: syntheticInputs(ticks, [25_000_000]),
    role: "claim", signerPriv: hexToBytes(B.priv),
    destinationProgram: hexToBytes("00".repeat(20)), feeRateGrainsPerVByte: 10,
  }), /32 bytes/);
});

test("beneficiaryKeyFromInput reuse: x-only, address, mnemonic", () => {
  const raw = beneficiaryKeyFromInput(B.xonly, net);
  assert.equal(raw.mode, "raw");
  const w = walletFromMnemonic("legal winner thank year wave sausage worth useful legal winner thank yellow", net);
  const addr = beneficiaryKeyFromInput(w.address, net);
  assert.equal(addr.mode, "address");
  assert.throws(() => beneficiaryKeyFromInput("nope", net));
  const pk = partyKeyFromInput(F.xonly, net);
  assert.equal(bytesToHex(pk.xonly).toLowerCase(), F.xonly.toLowerCase());
  assert.throws(() => parseXOnlyKey("00".repeat(31)), /64 hex/);
  const prog = addressToProgram(w.address, net);
  assert.equal(prog.length, 32);
});

test("parsePRLToGrains: exact decimal parsing, strict rejection (float-parse regression)", () => {
  assert.equal(parsePRLToGrains("1"), 100_000_000);
  assert.equal(parsePRLToGrains("0.5"), 50_000_000);
  assert.equal(parsePRLToGrains("0.00000001"), 1);
  assert.equal(parsePRLToGrains("25.12345678"), 2_512_345_678);
  assert.equal(parsePRLToGrains("90071992.54740991"), Number.MAX_SAFE_INTEGER);
  // the old Math.round(parseFloat(x) * 1e8) silently mangled 1.5 grains to 1
  assert.throws(() => parsePRLToGrains("0.000000015"), /invalid PRL amount/);
  assert.throws(() => parsePRLToGrains("1.2.3"), /invalid PRL amount/);
  for (const bad of ["", ".5", "1.", "1e3", "1,000", "-1", "abc", "10 PRL"]) {
    assert.throws(() => parsePRLToGrains(bad), /invalid PRL amount/, JSON.stringify(bad));
  }
  assert.throws(() => parsePRLToGrains("90071992.54740992"), /out of range/);
  assert.throws(() => parsePRLToGrains(5), /must be a string/);
});
