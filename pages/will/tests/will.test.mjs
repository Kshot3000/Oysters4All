// Pearl Will core tests: node --no-warnings --loader ./tests/loader.mjs tests/will.test.mjs
// Covers: script construction (owner + heir CLTV/CHECKSIGADD), NUMS internal
// key lineage, vault determinism, descriptor seal + verifier, claim gates,
// owner/heir claim builds, and independent re-verification from decoded hex.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import * as W from "../src/will-core.js";
import { numsInternalKeyEscrow, buildRefundScript } from "../../escrow/src/escrow-core.js";

const H = (b) => W.bytesToHex(b);

// ---- deterministic-ish key material (random privs, derived x-only pubs) ----
function freshKey() {
  for (;;) {
    const priv = randomBytes(32);
    try {
      const xonly = W.schnorr.getPublicKey(priv); // throws if d out of range
      return { priv, xonly: H(xonly) };
    } catch { /* retry */ }
  }
}
const OWNER = freshKey();
const HEIRS = [freshKey(), freshKey(), freshKey()];
const NET = "mainnet";
const net = W.NETWORKS[NET];
const UNLOCK = 240000;

function vaultFixture(m = 2) {
  return W.buildWillVault({
    network: NET, owner: OWNER.xonly,
    heirs: HEIRS.map((h) => h.xonly), m, unlockHeight: UNLOCK, label: "test vault",
  });
}
function p2trOf(xonlyHex) {
  return W.encodeBech32m(net.hrp, 1, W.hexToBytes(xonlyHex));
}
// derive a tweaked P2TR program for payments: use a fresh key's tweaked x-only
function payProgram() {
  const k = freshKey();
  return W.tweakKeypath(W.hexToBytes(k.xonly)).tweakedX;
}
function fakeUtxo(value) {
  return { txid: "ab".repeat(32), vout: 0, value };
}

// ================= owner leaf =================
test("owner leaf: <owner> CHECKSIG, 34 bytes", () => {
  const s = W.buildOwnerScript(OWNER.xonly);
  assert.equal(s.length, 34);
  assert.equal(s[0], 0x20);
  assert.equal(H(s.slice(1, 33)), OWNER.xonly);
  assert.equal(s[33], 0xac);
  assert.ok(W.scriptAsm(s).includes("CHECKSIG"));
});

test("owner leaf refuses non-curve keys", () => {
  assert.throws(() => W.buildOwnerScript("ff".repeat(32)), /WILL REFUSED|lift/);
  assert.throws(() => W.buildOwnerScript("zz"), /x-only pubkey/);
});

// ================= heir leaf =================
test("heir leaf: CLTV-gated m-of-n CHECKSIGADD", () => {
  const s = W.buildHeirScript(HEIRS.map((h) => h.xonly), 2, UNLOCK);
  const asm = W.scriptAsm(s);
  assert.ok(asm.includes("CLTV"), "must include CLTV");
  assert.ok(asm.includes("DROP"));
  // Count CHECKSIGADD opcodes structurally (a raw 0xba byte can randomly
  // appear inside a 32-byte key push — never count raw bytes).
  let adds = 0, i = 0;
  while (i < s.length) {
    const op = s[i];
    if (op <= 0x4b) { i += 1 + op; continue; }
    if (op === 0xba) adds++;
    i++;
  }
  assert.equal(adds, 3, "n CHECKSIGADD for n=3");
  assert.equal(s[s.length - 2], 0x52, "threshold 2 encoded as OP_2");
  assert.equal(s[s.length - 1], 0x87, "ends OP_EQUAL");
  assert.equal(s[0], 0x03, "unlock height 240000 encodes as 3-byte push");
});

test("heir leaf sorts keys canonically (order-independent)", () => {
  const a = W.buildHeirScript(HEIRS.map((h) => h.xonly), 2, UNLOCK);
  const b = W.buildHeirScript([...HEIRS].reverse().map((h) => h.xonly), 2, UNLOCK);
  assert.ok(H(a) === H(b), "same vault regardless of paste order");
});

test("heir leaf refuses bad threshold / count / unlock / keys", () => {
  const ks = HEIRS.map((h) => h.xonly);
  assert.throws(() => W.buildHeirScript(ks, 0, UNLOCK), /WILL REFUSED/);
  assert.throws(() => W.buildHeirScript(ks, 4, UNLOCK), /WILL REFUSED/);
  assert.throws(() => W.buildHeirScript([], 1, UNLOCK), /WILL REFUSED/);
  assert.throws(() => W.buildHeirScript([...ks, ...ks, ...ks], 2, UNLOCK), /WILL REFUSED/);
  assert.throws(() => W.buildHeirScript(ks, 2, 0), /WILL REFUSED/);
  assert.throws(() => W.buildHeirScript(ks, 2, 500_000_000), /WILL REFUSED/);
  assert.throws(() => W.buildHeirScript(["ff".repeat(32)], 1, UNLOCK), /WILL REFUSED/);
});

test("heir leaf CLTV prefix byte-shape matches escrow refund-leaf pattern", () => {
  // Escrow's audited buildRefundScript is <h> CLTV DROP <k> CHECKSIG for the same height.
  const ref = buildRefundScript(HEIRS[0].xonly, UNLOCK);
  const ours = W.buildHeirScript([HEIRS[0].xonly], 1, UNLOCK);
  // Same CLTV prologue: <h> CLTV DROP
  assert.ok(H(ours).startsWith(H(ref).slice(0, 12)), "CLTV prologue must match the audited refund leaf");
});

// ================= NUMS internal key =================
test("NUMS internal key: 32 bytes, deterministic, lifts to the curve", () => {
  const v = vaultFixture();
  const k = W.numsInternalKeyWill(v.ownerScript, v.heirScript);
  assert.equal(k.length, 32);
  W.schnorr.utils.lift_x(W.hexToBytes(H(k)).reduce((a, b) => a * 256n + BigInt(b), 0n));
  const k2 = W.numsInternalKeyWill(v.ownerScript, v.heirScript);
  assert.equal(H(k), H(k2), "deterministic");
});

test("NUMS domain differs from escrow (no cross-protocol key reuse)", () => {
  const v = vaultFixture();
  const esc = numsInternalKeyEscrow(v.ownerScript, v.heirScript);
  const will = W.numsInternalKeyWill(v.ownerScript, v.heirScript);
  assert.notEqual(H(esc), H(will), "different NUMS domains must give different internal keys");
});

// ================= vault =================
test("vault: real bech32m prl1 address, deterministic, sealed descriptor", () => {
  const v1 = vaultFixture(), v2 = vaultFixture();
  assert.equal(v1.address, v2.address, "deterministic address");
  assert.ok(v1.address.startsWith("prl1"), "mainnet HRP");
  assert.equal(v1.sealed, v2.sealed, "deterministic seal");
  assert.ok(v1.sealed.startsWith("pearl-will:v1:prl:"), "sealed prefix");
  assert.ok(v1.descriptor.startsWith("pearl-will:v1:prl:2-of-3:"), "descriptor prefix");
  assert.equal(v1.controlBlocks.length, 2, "two control blocks");
  assert.ok(v1.controlBlocks.every((c) => c.length === 65), "65-byte control blocks");
});

test("vault: testnet HRP", () => {
  const v = W.buildWillVault({ network: "testnet", owner: OWNER.xonly, heirs: [HEIRS[0].xonly], m: 1, unlockHeight: UNLOCK });
  assert.ok(v.address.startsWith("tprl1"), "testnet HRP");
});

test("vault refuses unknown network and bad labels are normalized", () => {
  assert.throws(() => W.buildWillVault({ network: "bogus", owner: OWNER.xonly, heirs: [HEIRS[0].xonly], m: 1, unlockHeight: UNLOCK }), /WILL REFUSED/);
  const v = W.buildWillVault({ network: NET, owner: OWNER.xonly, heirs: [HEIRS[0].xonly], m: 1, unlockHeight: UNLOCK, label: "  spaced  " });
  assert.ok(v.descriptor.endsWith(":spaced"), "label trimmed");
});

// ================= descriptor verifier =================
test("verifier: PROVEN on the true descriptor", () => {
  const v = vaultFixture();
  const r = W.verifyWillDescriptor(v.descriptor, v.address, v.sealed);
  assert.equal(r.verdict, "PROVEN");
  assert.ok(r.checks.every((c) => c.ok), "all checks pass");
});

test("verifier: NOT PROVEN on tampered address / seal / descriptor", () => {
  const v = vaultFixture();
  const other = p2trOf(OWNER.xonly);
  const r1 = W.verifyWillDescriptor(v.descriptor, other, v.sealed);
  assert.equal(r1.verdict, "NOT PROVEN");
  assert.ok(r1.checks.some((c) => c.label === "Address match" && !c.ok));
  const r2 = W.verifyWillDescriptor(v.descriptor, v.address, "pearl-will:v1:prl:" + "00".repeat(32));
  assert.equal(r2.verdict, "NOT PROVEN");
  const tampered = v.descriptor.replace(/:2-of-3:/, ":1-of-3:");
  const r3 = W.verifyWillDescriptor(tampered, v.address, v.sealed);
  assert.equal(r3.verdict, "NOT PROVEN");
});

test("verifier: malformed input is NOT PROVEN, never throws", () => {
  for (const d of ["", "pearl-hedge:v1:prl:x", "pearl-will:v1:zzz:1-of-1:aa:bb:1:-", null]) {
    const r = W.verifyWillDescriptor(d, "prl1xxxx");
    assert.equal(r.verdict, "NOT PROVEN", "input: " + JSON.stringify(d));
  }
});

test("willFromDescriptor round-trips the vault", () => {
  const v = vaultFixture();
  const { vault, m, n, unlockHeight } = W.willFromDescriptor(v.descriptor);
  assert.equal(m, 2); assert.equal(n, 3); assert.equal(unlockHeight, UNLOCK);
  assert.equal(vault.address, v.address);
  assert.throws(() => W.willFromDescriptor("garbage"), /WILL REFUSED/);
});

// ================= claim gate =================
test("assertClaimable: loud refusal before unlock, pass at/after", () => {
  assert.throws(() => W.assertClaimable(UNLOCK, UNLOCK - 1, "heir"), /WILL REFUSED.*heir claim locked/);
  assert.doesNotThrow(() => W.assertClaimable(UNLOCK, UNLOCK, "heir"));
  assert.doesNotThrow(() => W.assertClaimable(UNLOCK, UNLOCK + 100, "heir"));
  assert.throws(() => W.assertClaimable(UNLOCK, -1, "heir"), /need a chain tip/);
  assert.throws(() => W.assertClaimable(UNLOCK, NaN, "heir"), /need a chain tip/);
});

// ================= owner claim =================
test("owner claim: builds, signs, re-verifies from decoded hex", () => {
  const v = vaultFixture();
  const dest = payProgram(), change = payProgram();
  const destAddr = W.encodeBech32m(net.hrp, 1, dest);
  const changeAddr = W.encodeBech32m(net.hrp, 1, change);
  const input = fakeUtxo(2_000_000_00); // 2 PRL
  const feeEst = Math.ceil(W.spendVBytes({ nOut: 2, scriptLen: v.ownerScript.length, controlLen: v.controlBlocks[0].length, stackLens: [64] }) * 10);
  const built = W.buildOwnerClaim(v, {
    input,
    payments: [{ address: destAddr, value: input.value - feeEst }],
    changeAddress: changeAddr, feeRateGrainsPerVByte: 10,
    privOwner: OWNER.priv, signerXOnly: OWNER.xonly,
  });
  assert.ok(/^[0-9a-f]{64}$/.test(built.txid));
  assert.ok(built.fee > 0 && built.fee < input.value);
  const rv = W.reverifyClaimTx(v, built, {
    leaf: "owner", input, sequence: 0xffffffff, locktime: 0, keys: [OWNER.xonly],
  });
  assert.equal(rv.ok, true); assert.equal(rv.sigs, 1);
});

test("owner claim refuses the wrong key", () => {
  const v = vaultFixture();
  const dest = payProgram(), change = payProgram();
  const input = fakeUtxo(2_000_000_00);
  assert.throws(() => W.buildOwnerClaim(v, {
    input,
    payments: [{ address: W.encodeBech32m(net.hrp, 1, dest), value: input.value - 5000 }],
    changeAddress: W.encodeBech32m(net.hrp, 1, change), feeRateGrainsPerVByte: 10,
    privOwner: HEIRS[0].priv, signerXOnly: HEIRS[0].xonly,
  }), /WILL REFUSED/);
});

test("owner claim refuses underfunded UTXO", () => {
  const v = vaultFixture();
  const dest = payProgram(), change = payProgram();
  assert.throws(() => W.buildOwnerClaim(v, {
    input: fakeUtxo(600),
    payments: [{ address: W.encodeBech32m(net.hrp, 1, dest), value: 100 }],
    changeAddress: W.encodeBech32m(net.hrp, 1, change), feeRateGrainsPerVByte: 10,
    privOwner: OWNER.priv, signerXOnly: OWNER.xonly,
  }), /insufficient funds|below dust|WILL REFUSED/);
});

// ================= heir claim =================
function signHeirDigest(v, outputs, heirPrivs) {
  const input = fakeUtxo(2_000_000_00);
  const inputEx = { txid: input.txid, vout: input.vout, value: input.value, spk: v.spk };
  const digest = W.scriptPathSigDigestEx(net, inputEx, outputs, v.heirScript, { sequence: 0xfffffffe, locktime: UNLOCK });
  const sigs = heirPrivs.map(({ priv, xonly }) => {
    const sig = W.signForXOnly(priv, digest);
    assert.ok(W.verifySchnorrSig(sig, digest, xonly), "local sig must verify");
    return { key: xonly, sig: H(sig) };
  });
  return { input, digest, sigs };
}

test("heir claim: 2-of-3 builds, both sigs re-verify from decoded hex", () => {
  const v = vaultFixture(2);
  const dest = payProgram(), change = payProgram();
  const sorted = HEIRS.map((h) => h.xonly).sort();
  const feeRate = 10;
  const stackLens = [64, 64, 64];
  const plan = W.planSpend({
    inputValue: 2_000_000_00,
    payments: [{ program: dest, value: 1_900_000_00 }],
    feeRateGrainsPerVByte: feeRate, scriptLen: v.heirScript.length,
    controlLen: v.controlBlocks[1].length, stackLens,
  });
  const outputs = plan.outputs.map((o) => ({ program: o.program || change, value: o.value }));
  const input = fakeUtxo(2_000_000_00);
  const inputEx = { txid: input.txid, vout: input.vout, value: input.value, spk: v.spk };
  const digest = W.scriptPathSigDigestEx(net, inputEx, outputs, v.heirScript, { sequence: 0xfffffffe, locktime: UNLOCK });
  // heirs 1 and 3 sign (skip heir 2 — non-signer empty vector)
  const sigs = [HEIRS[0], HEIRS[2]].map(({ priv, xonly }) => ({ key: xonly, sig: H(W.signForXOnly(priv, digest)) }));
  const built = W.buildHeirClaim(v, sorted, 2, UNLOCK, {
    input,
    payments: [{ address: W.encodeBech32m(net.hrp, 1, dest), value: 1_900_000_00 }],
    changeAddress: W.encodeBech32m(net.hrp, 1, change),
    feeRateGrainsPerVByte: feeRate, signatures: sigs,
    chainTip: UNLOCK, outputsOverride: outputs,
  });
  assert.ok(/^[0-9a-f]{64}$/.test(built.txid));
  // locktime + sequence honored in the built tx
  const dec = W.decodeRawTx(built.hex);
  assert.equal(dec.locktime, UNLOCK);
  assert.equal(dec.inputs[0].sequence, 0xfffffffe);
  const rv = W.reverifyClaimTx(v, built, {
    leaf: "heir", input, sequence: 0xfffffffe, locktime: UNLOCK, keys: sorted,
  });
  assert.equal(rv.ok, true); assert.equal(rv.sigs, 2);
});

test("heir claim refuses before the unlock block (even with valid sigs)", () => {
  const v = vaultFixture(2);
  const dest = payProgram(), change = payProgram();
  const sorted = HEIRS.map((h) => h.xonly).sort();
  const input = fakeUtxo(2_000_000_00);
  const { digest, sigs } = signHeirDigest(v,
    [{ program: dest, value: 1_900_000_00 }], [HEIRS[0], HEIRS[1]]);
  void digest;
  assert.throws(() => W.buildHeirClaim(v, sorted, 2, UNLOCK, {
    input,
    payments: [{ address: W.encodeBech32m(net.hrp, 1, dest), value: 1_900_000_00 }],
    changeAddress: W.encodeBech32m(net.hrp, 1, change),
    feeRateGrainsPerVByte: 10, signatures: sigs, chainTip: UNLOCK - 1,
  }), /WILL REFUSED.*heir claim locked/);
});

test("heir claim refuses with fewer than m valid signatures", () => {
  const v = vaultFixture(2);
  const dest = payProgram(), change = payProgram();
  const sorted = HEIRS.map((h) => h.xonly).sort();
  const input = fakeUtxo(2_000_000_00);
  const outputs = [{ program: dest, value: 1_900_000_00 }];
  const { digest, sigs } = signHeirDigest(v, outputs, [HEIRS[0]]);
  void digest;
  assert.throws(() => W.buildHeirClaim(v, sorted, 2, UNLOCK, {
    input,
    payments: [{ address: W.encodeBech32m(net.hrp, 1, dest), value: 1_900_000_00 }],
    changeAddress: W.encodeBech32m(net.hrp, 1, change),
    feeRateGrainsPerVByte: 10, signatures: sigs, chainTip: UNLOCK,
    outputsOverride: outputs,
  }), /WILL REFUSED.*only 1 valid heir signature/);
});

test("heir claim refuses a signature from a non-heir key", () => {
  const v = vaultFixture(2);
  const dest = payProgram(), change = payProgram();
  const sorted = HEIRS.map((h) => h.xonly).sort();
  const input = fakeUtxo(2_000_000_00);
  const inputEx = { txid: input.txid, vout: input.vout, value: input.value, spk: v.spk };
  const outputs = [{ program: dest, value: 1_900_000_00 }];
  const digest = W.scriptPathSigDigestEx(net, inputEx, outputs, v.heirScript, { sequence: 0xfffffffe, locktime: UNLOCK });
  const rogue = { key: OWNER.xonly, sig: H(W.signForXOnly(OWNER.priv, digest)) };
  const legit = { key: HEIRS[0].xonly, sig: H(W.signForXOnly(HEIRS[0].priv, digest)) };
  assert.throws(() => W.buildHeirClaim(v, sorted, 2, UNLOCK, {
    input,
    payments: [{ address: W.encodeBech32m(net.hrp, 1, dest), value: 1_900_000_00 }],
    changeAddress: W.encodeBech32m(net.hrp, 1, change),
    feeRateGrainsPerVByte: 10, signatures: [rogue, legit], chainTip: UNLOCK,
  }), /WILL REFUSED/);
});

test("reverifyClaimTx catches a tampered witness script", () => {
  const v = vaultFixture();
  const dest = payProgram(), change = payProgram();
  const input = fakeUtxo(2_000_000_00);
  const feeEst = Math.ceil(W.spendVBytes({ nOut: 2, scriptLen: v.ownerScript.length, controlLen: v.controlBlocks[0].length, stackLens: [64] }) * 10);
  const built = W.buildOwnerClaim(v, {
    input,
    payments: [{ address: W.encodeBech32m(net.hrp, 1, dest), value: input.value - feeEst }],
    changeAddress: W.encodeBech32m(net.hrp, 1, change), feeRateGrainsPerVByte: 10,
    privOwner: OWNER.priv, signerXOnly: OWNER.xonly,
  });
  // Flip one byte inside the witness script region of the hex.
  const bytes = W.hexToBytes(built.hex);
  bytes[bytes.length - 70] ^= 0x01;
  const tampered = { ...built, hex: H(bytes) };
  assert.throws(() => W.reverifyClaimTx(v, tampered, {
    leaf: "owner", input, sequence: 0xffffffff, locktime: 0, keys: [OWNER.xonly],
  }), /WILL REFUSED/);
});

test("1-of-1 heir vault works end to end", () => {
  const v = W.buildWillVault({ network: NET, owner: OWNER.xonly, heirs: [HEIRS[0].xonly], m: 1, unlockHeight: UNLOCK });
  const dest = payProgram(), change = payProgram();
  const input = fakeUtxo(2_000_000_00);
  const outputs = [{ program: dest, value: 1_900_000_00 }];
  const inputEx = { txid: input.txid, vout: input.vout, value: input.value, spk: v.spk };
  const digest = W.scriptPathSigDigestEx(net, inputEx, outputs, v.heirScript, { sequence: 0xfffffffe, locktime: UNLOCK });
  const sigs = [{ key: HEIRS[0].xonly, sig: H(W.signForXOnly(HEIRS[0].priv, digest)) }];
  const built = W.buildHeirClaim(v, [HEIRS[0].xonly], 1, UNLOCK, {
    input,
    payments: [{ address: W.encodeBech32m(net.hrp, 1, dest), value: 1_900_000_00 }],
    changeAddress: W.encodeBech32m(net.hrp, 1, change),
    feeRateGrainsPerVByte: 10, signatures: sigs, chainTip: UNLOCK, outputsOverride: outputs,
  });
  const rv = W.reverifyClaimTx(v, built, {
    leaf: "heir", input, sequence: 0xfffffffe, locktime: UNLOCK, keys: [HEIRS[0].xonly],
  });
  assert.equal(rv.ok, true); assert.equal(rv.sigs, 1);
});

test("parsePRLToGrains: exact parser rejects the float-parse class (offline tally)", () => {
  assert.equal(W.parsePRLToGrains("1.50000000"), 150_000_000);
  assert.equal(W.parsePRLToGrains("0.00000001"), 1);
  assert.equal(W.parsePRLToGrains(" 2.25 "), 225_000_000);
  assert.equal(W.parsePRLToGrains("90071992.54740991"), Number.MAX_SAFE_INTEGER);
  assert.equal(W.parsePRLToGrains("0"), 0); // zero parses; the tally refuses it as a UTXO amount
  for (const bad of ["1.000000005", "1.2.3", "10abc", "0x10", "1e3", "1,000", ".5", "5.", "-5", "", "  ", "NaN", "Infinity"]) {
    assert.throws(() => W.parsePRLToGrains(bad), /invalid PRL amount/, bad);
  }
  assert.throws(() => W.parsePRLToGrains("90071992.54740992"), /out of range/);
  assert.throws(() => W.parsePRLToGrains(1.5), /must be a string/);
});
