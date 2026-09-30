// Pearl Quorum core tests: cosigner-key parsing/normalization, m-of-n
// CHECKSIGADD script assembly (1-of-1/2-of-3/5-of-5), a pinned 2-of-3 address
// vector derived from BIP-340 test keys, single-leaf NUMS taptree + control
// block verification, descriptor export/import tamper-evidence, multi-input
// BIP-341 sighash (byte-equal to the audited escrow digest for one input),
// grain-exact spend planning with dust absorption, unsigned-bundle
// tamper-evidence, local slot signing with key/slot guards, signature
// collection with re-verification, threshold enforcement (m-1 refused, m
// accepted), witness reverse-key order, and exact vBytes cross-checks.
// Usage: node --no-warnings --loader ./tests/loader.mjs tests/quorum.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import * as Q from "../src/quorum-core.js";

const NET = Q.NETWORKS.mainnet;
const TNET = Q.NETWORKS.testnet;

/* BIP-340 test secret keys 0x01..0x05 -> x-only pubkeys (0x03 matches the
 * well-known BIP-340 vector F9308A01…). */
const SKS = ["01", "02", "03", "04", "05"].map((x) => x.padStart(64, "0"));
const PKS = SKS.map((sk) => Q.bytesToHex(Q.schnorr.getPublicKey(Q.hexToBytes(sk))));

const PINNED = {
  name: "Council of Three",
  pubkeys: PKS.slice(0, 3),
  address: "prl1prezcf44wk98k0hfp4j8uvx2yzj8eykke0vgym4tadpdqlu464urszd0hvu",
  fingerprint: "080265f131a1a568",
};

const mkVault = (m, n, network = NET) =>
  Q.createVault({ name: `v-${m}-of-${n}`, network, m, keys: PKS.slice(0, n) });

const fakeUtxo = (vault, i, value) => ({
  txid: String(i).padStart(64, "0").replace(/0/g, (c, idx) => "abcdef0123456789"[idx % 16]),
  vout: i,
  value,
  spkHex: vault.spkHex,
});
const destAddr = (tag) => Q.encodeBech32m("prl", 1, Q.sha256(new TextEncoder().encode(tag)));

/* ---------- cosigner key parsing ---------- */

test("parseCosignerKey accepts 64-hex x-only", () => {
  const k = Q.parseCosignerKey(PKS[0]);
  assert.equal(k.hex, PKS[0]);
  assert.equal(k.compressed, false);
});

test("parseCosignerKey normalizes 66-hex compressed keys", () => {
  const comp = "02" + PKS[0];
  const k = Q.parseCosignerKey(comp);
  assert.equal(k.hex, PKS[0]);
  assert.equal(k.compressed, true);
  assert.equal(Q.bytesToHex(k.xonly), PKS[0]);
});

test("parseCosignerKey refuses garbage", () => {
  assert.throws(() => Q.parseCosignerKey("xyz"), /64-hex/);
  assert.throws(() => Q.parseCosignerKey(PKS[0].slice(0, 62)), /64-hex/);
  assert.throws(() => Q.parseCosignerKey("04" + PKS[0]), /64-hex|compressed/);
  // x = field prime (not a valid coordinate)
  assert.throws(() => Q.parseCosignerKey("fffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f"), /./);
});

test("parseCosignerSet refuses duplicates, empties, oversize", () => {
  assert.throws(() => Q.parseCosignerSet([]), /at least one/);
  assert.throws(() => Q.parseCosignerSet([PKS[0], PKS[0]]), /duplicate/);
  assert.throws(() => Q.parseCosignerSet([...PKS, PKS[0]]), /at most 5/);
});

/* ---------- script assembly ---------- */

test("buildQuorumScript 1-of-1 exact bytes", () => {
  const s = Q.buildQuorumScript([Q.hexToBytes(PKS[0])], 1);
  const expect = [0x00, 0x20, ...Q.hexToBytes(PKS[0]), 0xba, 0x51, 0x87];
  assert.deepEqual([...s], expect);
});

test("buildQuorumScript 2-of-3 and 5-of-5 shapes", () => {
  const s3 = Q.buildQuorumScript(PKS.slice(0, 3).map(Q.hexToBytes), 2);
  assert.equal(s3[0], 0x00);
  assert.equal(s3[s3.length - 2], 0x52); // OP_2
  assert.equal(s3[s3.length - 1], 0x87); // EQUAL
  assert.equal(s3.length, 1 + 3 * (1 + 32 + 1) + 2);
  const asm = Q.scriptAsm(s3);
  assert.match(asm, /CHECKSIGADD.*CHECKSIGADD.*CHECKSIGADD 2 EQUAL/);
  const s5 = Q.buildQuorumScript(PKS.map(Q.hexToBytes), 5);
  assert.equal(s5[s5.length - 2], 0x55); // OP_5
});

test("buildQuorumScript refuses m > n and m = 0", () => {
  assert.throws(() => Q.buildQuorumScript([Q.hexToBytes(PKS[0])], 2), /threshold/);
  assert.throws(() => Q.buildQuorumScript([Q.hexToBytes(PKS[0])], 0), /threshold/);
});

/* ---------- pinned vault vector ---------- */

test("pinned 2-of-3 vault address + fingerprint from BIP-340 test keys", () => {
  const v = Q.createVault({ name: PINNED.name, network: NET, m: 2, keys: PINNED.pubkeys });
  assert.equal(v.address, PINNED.address);
  assert.equal(v.fingerprint, PINNED.fingerprint);
  assert.equal(v.internalKeyMode, "nums");
  assert.equal(v.backdoorWarning, null);
});

test("vault fingerprint is stable across identical forges", () => {
  const a = mkVault(2, 3);
  const b = mkVault(2, 3);
  assert.equal(a.fingerprint, b.fingerprint);
  assert.equal(a.address, b.address);
  const c = Q.createVault({ name: "v-2-of-3", network: NET, m: 3, keys: PKS.slice(0, 3) });
  assert.notEqual(a.fingerprint, c.fingerprint);
});

test("single-leaf control block verifies; tampered does not", () => {
  const v = mkVault(2, 3);
  const ok = Q.verifyQuorumControlBlock(
    Q.hexToBytes(v.internalXOnlyHex), Q.hexToBytes(v.scriptHex),
    Q.hexToBytes(v.controlBlockHex), Q.hexToBytes(v.spkHex).slice(2));
  assert.equal(ok, true);
  const bad = Q.hexToBytes(v.controlBlockHex);
  bad[5] ^= 0x01;
  assert.equal(Q.verifyQuorumControlBlock(
    Q.hexToBytes(v.internalXOnlyHex), Q.hexToBytes(v.scriptHex), bad,
    Q.hexToBytes(v.spkHex).slice(2)), false);
});

test("designated-cosigner internal key stamps the backdoor warning", () => {
  const v = Q.createVault({ name: "risky", network: NET, m: 2, keys: PKS.slice(0, 3), internalKeyMode: "cosigner", internalKeySlot: 1 });
  assert.match(v.backdoorWarning, /KEYPATH BACKDOOR/);
  assert.equal(v.internalXOnlyHex, PKS[1]);
  assert.notEqual(v.address, mkVault(2, 3).address);
});

/* ---------- descriptor export/import ---------- */

test("descriptor text round-trips; tampered address refused", () => {
  const v = mkVault(2, 3);
  const text = Q.exportDescriptorText(v);
  assert.match(text, /^pearl-quorum:v1:/m);
  const back = Q.importDescriptorText(text);
  assert.equal(back.address, v.address);
  assert.equal(back.fingerprint, v.fingerprint);
  const tampered = text.replace(v.address, destAddr("evil"));
  assert.throws(() => Q.importDescriptorText(tampered), /REFUSED/);
  assert.throws(() => Q.importDescriptorText("garbage"), /pearl-quorum/);
});

/* ---------- sighash ---------- */

test("quorumSigDigest equals audited escrow digest for a single input", () => {
  const v = mkVault(2, 3);
  const inp = { txid: "a".repeat(64), vout: 0, value: 100000000, spk: Q.hexToBytes(v.spkHex) };
  const outs = [{ program: Q.hexToBytes(v.spkHex).slice(2), value: 99900000 }];
  const leaf = Q.hexToBytes(v.scriptHex);
  const a = Q.quorumSigDigest(NET, [inp], 0, outs, leaf, { sequences: [0xffffffff], locktime: 0 });
  const b = Q.scriptPathSigDigestEx(NET, inp, outs, leaf, { sequence: 0xffffffff, locktime: 0 });
  assert.deepEqual([...a], [...b]);
});

test("sighash is deterministic and input-index sensitive", () => {
  const v = mkVault(2, 3);
  const ins = [0, 1].map((i) => ({ txid: String(i + 1).repeat(64), vout: i, value: 50000000, spk: Q.hexToBytes(v.spkHex) }));
  const outs = [{ program: Q.hexToBytes(v.spkHex).slice(2), value: 99000000 }];
  const leaf = Q.hexToBytes(v.scriptHex);
  const d0a = Q.quorumSigDigest(NET, ins, 0, outs, leaf);
  const d0b = Q.quorumSigDigest(NET, ins, 0, outs, leaf);
  const d1 = Q.quorumSigDigest(NET, ins, 1, outs, leaf);
  assert.deepEqual([...d0a], [...d0b]);
  assert.notDeepEqual([...d0a], [...d1]);
});

/* ---------- spend planning ---------- */

function plan23() {
  const v = mkVault(2, 3);
  const ins = [fakeUtxo(v, 0, 200000000), fakeUtxo(v, 1, 150000000)];
  return Q.planQuorumSpend({
    vault: v, inputs: ins,
    payments: [{ address: destAddr("alice"), grains: 300000000 }],
    feeRateGrainsPerVByte: 2,
  });
}

test("plan is grain-exact: inputs == outputs + fee + change", () => {
  const p = plan23();
  const inSum = p.inputs.reduce((a, u) => a + u.value, 0);
  const outSum = p.outputs.reduce((a, o) => a + o.grains, 0);
  assert.equal(inSum, outSum + p.feeGrains);
  assert.equal(p.digests.length, 2);
  assert.equal(p.m, 2);
  assert.ok(p.vBytes > 0);
});

test("dust change is absorbed into the fee and disclosed", () => {
  const v = mkVault(2, 3);
  const ins = [fakeUtxo(v, 0, 100000000)];
  // Craft payment so change lands sub-dust: compute plan vBytes first.
  const scriptLen = Q.hexToBytes(v.scriptHex).length;
  const vb = Q.quorumTxVBytes({ nIn: 1, nOut: 2, scriptLen, m: 2, n: 3 });
  const fee = Math.ceil(vb * 2);
  const pay = 100000000 - fee - 100; // 100 grains of change -> dust
  const p = Q.planQuorumSpend({ vault: v, inputs: ins, payments: [{ address: destAddr("bob"), grains: pay }], feeRateGrainsPerVByte: 2 });
  assert.equal(p.outputs.length, 1); // no change output
  assert.equal(p.dustAbsorbedGrains > 0, true);
  assert.equal(p.dustAbsorbedGrains < Q.DUST_GRAIN + vb * 2, true);
  const inSum = p.inputs.reduce((a, u) => a + u.value, 0);
  assert.equal(inSum, p.outputs[0].grains + p.feeGrains);
});

test("plan refuses insufficient funds, dust payments, foreign inputs", () => {
  const v = mkVault(2, 3);
  const ins = [fakeUtxo(v, 0, 100000)];
  assert.throws(() => Q.planQuorumSpend({
    vault: v, inputs: ins, payments: [{ address: destAddr("x"), grains: 99999999 }], feeRateGrainsPerVByte: 2,
  }), /insufficient funds/);
  assert.throws(() => Q.planQuorumSpend({
    vault: v, inputs: ins, payments: [{ address: destAddr("x"), grains: 100 }], feeRateGrainsPerVByte: 2,
  }), /dust/);
  const foreign = { txid: "b".repeat(64), vout: 0, value: 100000000, spkHex: "51" + "20" + "00".repeat(32) };
  assert.throws(() => Q.planQuorumSpend({
    vault: v, inputs: [foreign], payments: [{ address: destAddr("x"), grains: 50000000 }], feeRateGrainsPerVByte: 2,
  }), /foreign/);
});

/* ---------- bundle tamper-evidence ---------- */

test("unsigned bundle export/import round-trips; tampering refused", () => {
  const p = plan23();
  const text = Q.exportUnsignedBundle(p);
  assert.ok(text.startsWith("pearl-quorum-unsigned:v1:"), "kind tag is a text prefix");
  const b = Q.importUnsignedBundle(text);
  assert.equal(b.fingerprint, p.fingerprint);
  const j = JSON.parse(text.slice("pearl-quorum-unsigned:v1:".length));
  j.digests[0] = "00".repeat(32);
  assert.throws(() => Q.importUnsignedBundle("pearl-quorum-unsigned:v1:" + JSON.stringify(j)), /REFUSED/);
  const j2 = JSON.parse(text.slice("pearl-quorum-unsigned:v1:".length));
  j2.feeGrains += 1;
  assert.throws(() => Q.importUnsignedBundle("pearl-quorum-unsigned:v1:" + JSON.stringify(j2)), /REFUSED/);
  assert.throws(() => Q.importUnsignedBundle("pearl-quorum-unsigned:v1:not json"), /valid JSON/);
  assert.throws(() => Q.importUnsignedBundle(JSON.stringify(j2)), /missing kind prefix/);
});

test("sig bundle text round-trips with its kind prefix", () => {
  const { sb0 } = signedPair();
  const text = Q.exportSigBundleText(sb0);
  assert.ok(text.startsWith("pearl-quorum-sigs:v1:"), "sig kind tag is a text prefix");
  const back = Q.importSigBundleText(text);
  assert.equal(back.slot, 0);
  assert.deepEqual(back.sigs, sb0.sigs);
  assert.throws(() => Q.importSigBundleText(JSON.stringify(sb0)), /missing kind prefix/);
});

/* ---------- cosigning ---------- */

function signedPair() {
  const p = plan23();
  const bundle = Q.importUnsignedBundle(Q.exportUnsignedBundle(p));
  const sb0 = Q.signSlot({ bundle, slot: 0, privHex: SKS[0] });
  const sb2 = Q.signSlot({ bundle, slot: 2, privHex: SKS[2] });
  return { bundle, sb0, sb2 };
}

test("signSlot emits per-input signatures, all self-verified", () => {
  const { bundle, sb0 } = signedPair();
  assert.equal(sb0.slot, 0);
  assert.equal(sb0.sigs.length, bundle.digests.length);
  for (let i = 0; i < bundle.digests.length; i++) {
    assert.equal(Q.verifySchnorrSig(sb0.sigs[i], bundle.digests[i], bundle.pubkeys[0]), true);
  }
});

test("signSlot refuses wrong key for the slot", () => {
  const { bundle } = signedPair();
  assert.throws(() => Q.signSlot({ bundle, slot: 0, privHex: SKS[1] }), /KEY REFUSED/);
  assert.throws(() => Q.signSlot({ bundle, slot: 9, privHex: SKS[0] }), /slot/);
  assert.throws(() => Q.signSlot({ bundle, slot: 0, privHex: "zz" }), /hex string expected|private key must be 32/);
});

test("collectSigs: m-1 collected -> quorum not reached; bad sig reported", () => {
  const { bundle, sb0, sb2 } = signedPair();
  const c1 = Q.collectSigs(bundle, [sb0]);
  assert.equal(c1.quorumReached, false);
  assert.deepEqual(c1.slots, [0]);
  const evil = JSON.parse(JSON.stringify(sb2));
  evil.sigs[0] = "11".repeat(64);
  const c2 = Q.collectSigs(bundle, [sb0, evil]);
  assert.equal(c2.quorumReached, false);
  assert.deepEqual(c2.slots, [0]);
  assert.match(c2.problems.join(";"), /does NOT verify/);
});

test("collectSigs: duplicate slot and foreign-spend bundles refused", () => {
  const { bundle, sb0, sb2 } = signedPair();
  const dup = Q.collectSigs(bundle, [sb0, sb0]);
  assert.match(dup.problems.join(";"), /duplicate/);
  // A genuinely different spend (different payment) -> different fingerprint.
  const v = Q.createVault({ name: "v-2-of-3", network: Q.NETWORKS.mainnet, m: 2, keys: PKS.slice(0, 3) });
  const otherPlan = Q.planQuorumSpend({
    vault: v,
    inputs: [{ txid: "c".repeat(64), vout: 0, value: 200000000, spkHex: v.spkHex }],
    payments: [{ address: destAddr("zed"), grains: 199000000 }],
    feeRateGrainsPerVByte: 2,
  });
  const otherB = Q.importUnsignedBundle(Q.exportUnsignedBundle(otherPlan));
  assert.notEqual(otherB.fingerprint, bundle.fingerprint);
  const sbOther = Q.signSlot({ bundle: otherB, slot: 1, privHex: SKS[1] });
  const c = Q.collectSigs(bundle, [sb0, sbOther]);
  assert.match(c.problems.join(";"), /DIFFERENT spend/);
  assert.deepEqual(c.slots, [0]);
});

/* ---------- finalize ---------- */

function parseWitnesses(hex, nIn, nOut) {
  // Minimal segwit parser for the quorum tx shape (P2TR outputs only).
  const b = Q.hexToBytes(hex);
  let o = 0;
  const u32 = () => { const v = b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24); o += 4; return v >>> 0; };
  const vi = () => { const v = b[o++]; if (v < 0xfd) return v; throw new Error("big varint in test parser"); };
  u32(); // version
  assert.equal(b[o++], 0x00); assert.equal(b[o++], 0x01); // marker + flag
  const ni = vi(); assert.equal(ni, nIn);
  o += nIn * 41;
  const no = vi(); assert.equal(no, nOut);
  o += nOut * 43;
  u32(); // locktime
  const witnesses = [];
  for (let i = 0; i < nIn; i++) {
    const n = vi();
    const items = [];
    for (let j = 0; j < n; j++) { const l = vi(); items.push(b.slice(o, o + l)); o += l; }
    witnesses.push(items);
  }
  return witnesses;
}

test("finalizeSpend refuses below threshold, accepts at threshold", () => {
  const { bundle, sb0 } = signedPair();
  assert.throws(() => Q.finalizeSpend(bundle, [sb0]), /quorum not reached/);
  const sb2 = Q.signSlot({ bundle, slot: 2, privHex: SKS[2] });
  const f = Q.finalizeSpend(bundle, [sb0, sb2]);
  assert.match(f.txid, /^[0-9a-f]{64}$/);
  assert.equal(f.vBytes, bundle.vBytes);
  assert.equal(f.feeGrains, bundle.feeGrains);
  assert.deepEqual(f.slots, [0, 2]);
});

test("witness is reverse key order with empty vectors for non-signers", () => {
  const { bundle, sb0, sb2 } = signedPair();
  const f = Q.finalizeSpend(bundle, [sb0, sb2]);
  const w = parseWitnesses(f.hex, bundle.inputs.length, bundle.outputs.length);
  assert.equal(w.length, bundle.inputs.length);
  for (let i = 0; i < w.length; i++) {
    const items = w[i];
    assert.equal(items.length, bundle.n + 2); // n sig slots + script + control block
    // reverse key order: slot 2, slot 1 (empty), slot 0
    assert.equal(Q.bytesToHex(items[0]), sb2.sigs[i]);
    assert.equal(items[1].length, 0);
    assert.equal(Q.bytesToHex(items[2]), sb0.sigs[i]);
    assert.equal(Q.bytesToHex(items[3]), bundle.scriptHex);
    assert.equal(Q.bytesToHex(items[4]), bundle.controlBlockHex);
  }
});

test("quorumTxVBytes matches the actually-built tx", () => {
  const v = mkVault(3, 5);
  const ins = [fakeUtxo(v, 0, 500000000)];
  const p = Q.planQuorumSpend({
    vault: v, inputs: ins, payments: [{ address: destAddr("carol"), grains: 400000000 }], feeRateGrainsPerVByte: 3,
  });
  const b = Q.importUnsignedBundle(Q.exportUnsignedBundle(p));
  const sbs = [0, 2, 4].map((slot) => Q.signSlot({ bundle: b, slot, privHex: SKS[slot] }));
  const f = Q.finalizeSpend(b, sbs);
  const expect = Q.quorumTxVBytes({ nIn: 1, nOut: b.outputs.length, scriptLen: Q.hexToBytes(v.scriptHex).length, m: 3, n: 5 });
  assert.equal(f.vBytes, expect);
  assert.equal(f.vBytes, b.vBytes);
});

test("finalize re-verifies every signature (defense in depth)", () => {
  const { bundle, sb0, sb2 } = signedPair();
  const tampered = JSON.parse(JSON.stringify(sb2));
  tampered.sigs[1] = sb0.sigs[1]; // slot-2 bundle carrying slot-0's signature
  assert.throws(() => Q.finalizeSpend(bundle, [sb0, tampered]), /REFUSED/);
});

/* ---------- ledger helpers ---------- */

test("ledger CSV helpers escape and line up", () => {
  const v = mkVault(2, 3);
  const csv = Q.vaultToCSV([{ name: 'A "quoted" vault', network: v.network, m: v.m, n: v.n, address: v.address, fingerprint: v.fingerprint, internalKeyMode: v.internalKeyMode }]);
  assert.match(csv, /"A ""quoted"" vault"/);
  const scsv = Q.spendsToCSV([{ at: "2026-09-30T00:00:00Z", vault: "v", txid: "a".repeat(64), inputs: 2, outputsGrains: 1, feeGrains: 2, slots: [0, 2] }]);
  assert.match(scsv, /"0\+2"/);
});
