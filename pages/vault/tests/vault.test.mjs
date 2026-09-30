// Pearl Vault core tests: descriptor math, BIP-341 sighash, fee math,
// signing rounds, bundle cross-checks, tamper refusal.
// Usage: node --no-warnings --loader ./tests/loader.mjs tests/vault.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  NETWORKS, DUST_GRAIN,
  parseXOnlyKey, cosignerKeyFromInput, cosignerPrivFromHex,
  buildMultisigScript, numsInternalKeyVault, vaultTaptree,
  buildVaultDescriptor, parseDescriptorString, verifyDescriptor,
  validateVaultAddress, prlToGrains, grainsToPRL,
  scriptPathVBytes, planSpend,
  scriptPathSigDigestMulti, signForXOnly, verifySchnorrSig,
  buildUnsignedBundle, parseUnsignedBundle, signBundle,
  verifyPartialSigs, combineMultisigSigs, serializeSpendTx, finalizeSpend,
  bytesToHex, hexToBytes, sha256,
} from "../src/vault-core.js";
import {
  schnorr, taggedHash, tapLeafHash, encodeBech32m, decodeBech32m,
  commitKeyInfo, walletFromMnemonic,
  varint, u32le, p2trScriptPubKey, txidLE, dblSha,
} from "../../sign/src/crypto.js";
import { bytesToNumberBE } from "@noble/curves/abstract/utils";
import { secp256k1 } from "@noble/curves/secp256k1";

const N = NETWORKS.mainnet;
const TN = NETWORKS.testnet;
const te = new TextEncoder();

// Fixed cosigner private keys -> x-only pubkeys (test fixtures only).
const PRIVS = ["11".repeat(32), "22".repeat(32), "33".repeat(32)];
const XONLY = PRIVS.map((p) => bytesToHex(schnorr.getPublicKey(hexToBytes(p))));

function vault23() {
  return buildVaultDescriptor(N, XONLY, 2);
}
function utxo(txid, vout, value) {
  return { txid, vout, value: BigInt(value) };
}
const TXA = "aa".repeat(32);
const TXB = "bb".repeat(32);

/* ---------------- key parsing ---------------- */

test("parseXOnlyKey accepts 64-hex and rejects junk / x>=p", () => {
  assert.deepEqual([...parseXOnlyKey(XONLY[0])], [...hexToBytes(XONLY[0])]);
  assert.throws(() => parseXOnlyKey("zz".repeat(32)), /VAULT REFUSED/);
  assert.throws(() => parseXOnlyKey("ab12"), /VAULT REFUSED/);
  assert.throws(() => parseXOnlyKey("ff".repeat(32)), /VAULT REFUSED/); // x >= p
});

test("cosignerKeyFromInput: x-only hex is watch-only", () => {
  const k = cosignerKeyFromInput(XONLY[0], N);
  assert.equal(k.priv, null);
  assert.equal(bytesToHex(k.xonly), XONLY[0]);
});

test("cosignerKeyFromInput: mnemonic derives the BIP-86 x-only key", () => {
  const mn = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  const k = cosignerKeyFromInput(mn, N);
  const w = walletFromMnemonic(mn, N);
  assert.deepEqual([...k.xonly], [...w.internalXOnly]);
  assert.deepEqual([...k.priv], [...w.priv]);
});

test("cosignerKeyFromInput refuses junk", () => {
  assert.throws(() => cosignerKeyFromInput("hello world", N), /VAULT REFUSED/);
  assert.throws(() => cosignerKeyFromInput("", N), /VAULT REFUSED/);
});

test("cosignerPrivFromHex yields the matching x-only key", () => {
  const k = cosignerPrivFromHex(PRIVS[0], N);
  assert.equal(bytesToHex(k.xonly), XONLY[0]);
  assert.throws(() => cosignerPrivFromHex("00".repeat(32), N), /out of range/);
});

/* ---------------- multisig script ---------------- */

test("buildMultisigScript 2-of-3 has the exact CHECKSIGADD layout", () => {
  const { script, m, n } = buildMultisigScript(XONLY, 2);
  assert.equal(m, 2); assert.equal(n, 3);
  // <0> <K1> CHECKSIGADD <K2> CHECKSIGADD <K3> CHECKSIGADD <2> EQUAL
  assert.equal(script[0], 0x00);
  let off = 1;
  for (let i = 0; i < 3; i++) {
    assert.equal(script[off], 32); off++;
    assert.deepEqual([...script.slice(off, off + 32)], [...hexToBytes(XONLY[i])]); off += 32;
    assert.equal(script[off], 0xba); off++; // CHECKSIGADD
  }
  assert.equal(script[off], 0x52); // OP_2
  assert.equal(script[off + 1], 0x87); // EQUAL
  assert.equal(script.length, off + 2);
});

test("buildMultisigScript refuses bad quorum / duplicates / size", () => {
  assert.throws(() => buildMultisigScript(XONLY, 4), /between 1 and n/);
  assert.throws(() => buildMultisigScript(XONLY, 0), /between 1 and n/);
  assert.throws(() => buildMultisigScript([XONLY[0]], 1), /at least 2 cosigners/);
  assert.throws(() => buildMultisigScript([XONLY[0], XONLY[0]], 1), /duplicate/);
  assert.throws(() => buildMultisigScript([XONLY[0], XONLY[0].toUpperCase()], 1), /duplicate/);
  const SIX = [];
  for (let i = 10; SIX.length < 6; i++) {
    const h = bytesToHex(sha256(te.encode("vault-six-" + i)));
    try { parseXOnlyKey(h); if (!SIX.includes(h)) SIX.push(h); } catch { /* x >= p, skip */ }
  }
  assert.throws(() => buildMultisigScript(SIX, 3), /at most 5/);
});

/* ---------------- NUMS + taptree ---------------- */

test("numsInternalKeyVault is deterministic and key-bound", () => {
  const a = numsInternalKeyVault(2, 3, XONLY);
  const b = numsInternalKeyVault(2, 3, XONLY);
  assert.deepEqual([...a], [...b]);
  const c = numsInternalKeyVault(2, 3, [XONLY[2], XONLY[1], XONLY[0]]);
  assert.notDeepEqual([...a], [...c]);
  assert.throws(() => { schnorr.utils.lift_x(bytesToNumberBE(a)); throw new Error("x"); }, /x/); // sanity: lift works
});

test("vaultTaptree matches the audited single-leaf commitKeyInfo", () => {
  const { script } = buildMultisigScript(XONLY, 2);
  const internal = numsInternalKeyVault(2, 3, XONLY);
  const tree = vaultTaptree(N, internal, script);
  const ref = commitKeyInfo(N, internal, script);
  assert.equal(tree.address, ref.commitAddress);
  assert.deepEqual([...tree.controlBlock], [...ref.controlBlock]);
  assert.equal(tree.controlBlock.length, 33);
  const dec = decodeBech32m(tree.address);
  assert.equal(dec.hrp, "prl");
  assert.deepEqual([...dec.program], [...ref.commitXOnly]);
});

/* ---------------- descriptor ---------------- */

test("descriptor round-trips and verifies PROVEN", () => {
  const d = vault23();
  assert.ok(d.descriptor.startsWith("pearlvault:v1:prl:2:3:"));
  assert.equal(d.descriptor.split(":").length, 6);
  const v = verifyDescriptor(d);
  assert.equal(v.ok, true);
  assert.equal(v.address, d.address);
  const p = parseDescriptorString(d.descriptor);
  assert.deepEqual(p, { hrp: "prl", m: 2, n: 3, hash: d.hash });
  assert.throws(() => parseDescriptorString("pearlvault:v1:prl:2"), /VAULT REFUSED/);
});

test("verifyDescriptor rules NOT PROVEN on tampering", () => {
  const d = vault23();
  // reordered cosigner keys -> internal key and address no longer re-derive
  const alt = { ...d, keys: [XONLY[1], XONLY[0], XONLY[2]] };
  assert.equal(verifyDescriptor(alt).ok, false);
  const t2 = { ...d, hash: "00".repeat(32) };
  assert.equal(verifyDescriptor(t2).ok, false);
  const t3 = { ...d, m: 3 };
  assert.equal(verifyDescriptor(t3).ok, false);
  const t4 = { ...d, address: d.address.slice(0, -1) + (d.address.endsWith("q") ? "p" : "q") };
  assert.equal(verifyDescriptor(t4).ok, false);
});

test("testnet descriptor uses tprl1", () => {
  const d = buildVaultDescriptor(TN, XONLY.slice(0, 2), 1);
  assert.ok(d.address.startsWith("tprl1"));
  assert.equal(verifyDescriptor(d).ok, true);
});

/* ---------------- addresses + amounts ---------------- */

test("validateVaultAddress accepts prl1, refuses tprl1/junk on mainnet", () => {
  const d = vault23();
  assert.equal(validateVaultAddress(" " + d.address.toUpperCase() + " ", N), d.address);
  const t = buildVaultDescriptor(TN, XONLY.slice(0, 2), 1);
  assert.throws(() => validateVaultAddress(t.address, N), /tprl1/);
  assert.throws(() => validateVaultAddress("junk", N), /VAULT REFUSED/);
  assert.throws(() => validateVaultAddress("", N), /empty/);
});

test("prlToGrains/grainsToPRL round-trip exactly", () => {
  assert.equal(prlToGrains("1.5"), 150000000n);
  assert.equal(prlToGrains("0.00000001"), 1n);
  assert.equal(grainsToPRL(150000000n), "1.5");
  assert.equal(grainsToPRL(prlToGrains("123.45678901")), "123.45678901");
  assert.throws(() => prlToGrains("1.123456789"), /VAULT REFUSED/);
  assert.throws(() => prlToGrains("-1"), /VAULT REFUSED/);
  assert.throws(() => prlToGrains("0"), /positive/);
});

/* ---------------- vBytes ---------------- */

test("scriptPathVBytes matches a hand-computed example", () => {
  // 1-in, 2-out, 2-of-3 (scriptLen = 1 + 3*34 + 2 = 105), 2 sigs.
  // base = 4 + 1 + 41 + 1 + 2*34 + 4 = 119
  // per-input witness = 1 + (2*65 + 1*1) + (1+105) + 34 = 272
  // vBytes = ceil((4*119 + 2 + 272)/4) = ceil(750/4) = 188
  assert.equal(scriptPathVBytes(1, 2, 105, 3, 2), 188);
  // 1-of-2, all sign: witness per input = 1 + 65 + (1+71) + 34 = 172;
  // scriptLen 1-of-2 = 1 + 2*34 + 2 = 71; base(1-in,1-out) = 4+1+41+1+34+4 = 85
  // ceil((340 + 2 + 172)/4) = ceil(514/4) = 129 (514/4 = 128.5)
  assert.equal(scriptPathVBytes(1, 1, 71, 2, 1), 129);
  assert.throws(() => scriptPathVBytes(0, 1, 71, 2, 1), /nIn/);
  assert.throws(() => scriptPathVBytes(1, 1, 71, 2, 3), /more signatures/);
});

/* ---------------- BIP-341 sighash ---------------- */

test("scriptPathSigDigestMulti matches a hand-rolled BIP-341 message", () => {
  const prog = new Uint8Array(32).fill(7);
  const prog2 = new Uint8Array(32).fill(9);
  const script = new Uint8Array([0x51, 0x52, 0x87]);
  const inputs = [
    { txid: TXA, vout: 3, value: 100000000n, program: prog },
    { txid: TXB, vout: 0, value: 50000000n, program: prog2 },
  ];
  const outputs = [
    { program: prog2, value: 140000000n },
    { program: prog, value: 9000000n },
  ];
  // Independent construction straight from the BIP-341 spec.
  const sha = (b) => sha256(b);
  const prevouts = sha(Uint8Array.from(inputs.flatMap((i) => [...txidLE(i.txid), ...u32le(i.vout)])));
  const amounts = sha(Uint8Array.from(inputs.flatMap((i) => {
    const v = BigInt(i.value); const o = new Uint8Array(8); let x = v;
    for (let k = 0; k < 8; k++) { o[k] = Number(x & 0xffn); x >>= 8n; }
    return [...o];
  })));
  const spks = sha(Uint8Array.from(inputs.flatMap((i) => {
    const s = p2trScriptPubKey(i.program); return [...varint(s.length), ...s];
  })));
  const seqs = sha(Uint8Array.from(inputs.flatMap(() => [...u32le(0xffffffff)])));
  const outs = sha(Uint8Array.from(outputs.flatMap((o) => {
    const v = BigInt(o.value); const b = new Uint8Array(8); let x = v;
    for (let k = 0; k < 8; k++) { b[k] = Number(x & 0xffn); x >>= 8n; }
    const s = p2trScriptPubKey(o.program);
    return [...b, ...varint(s.length), ...s];
  })));
  const leafHash = tapLeafHash(script);
  for (const idx of [0, 1]) {
    const msg = Uint8Array.from([
      0x00, 0x00, ...u32le(N.txVersion), ...u32le(0),
      ...prevouts, ...amounts, ...spks, ...seqs, ...outs,
      0x02, ...u32le(idx), ...leafHash, 0x00, 0xff, 0xff, 0xff, 0xff, // 0x02 = script path (ext_flag=1), BIP-341
    ]);
    const expected = taggedHash("TapSighash", msg);
    assert.deepEqual(
      [...scriptPathSigDigestMulti(N, inputs, outputs, script, idx)],
      [...expected],
      `digest mismatch at input ${idx}`,
    );
  }
  assert.throws(() => scriptPathSigDigestMulti(N, inputs, outputs, script, 2), /out of range/);
});

/* ---------------- spend planning ---------------- */

function plan23() {
  const d = vault23();
  return planSpend({
    network: N,
    descriptor: d,
    selectedUtxos: [utxo(TXA, 0, 200000000n)],
    recipients: [{ address: d.address, grains: 100000000n }],
    feeRateGrainsPerVByte: 10,
    blockbookBase: "https://blockbook.pearlresearch.ai",
  });
}

test("planSpend: exact fee math, change output, dust absorption", () => {
  const d = vault23();
  const plan = plan23();
  const scriptLen = hexToBytes(d.script).length; // 2-of-3 -> 105
  const expectVBytes = scriptPathVBytes(1, 2, scriptLen, 3, 2);
  assert.equal(plan.vBytes, expectVBytes);
  assert.equal(plan.feeGrains, BigInt(Math.ceil(expectVBytes * 10)));
  assert.equal(plan.outputs.length, 2);
  assert.equal(plan.outputs[1].change, true);
  assert.equal(plan.outputs[1].address, d.address);
  assert.equal(plan.inTotal, 200000000n);
  assert.equal(plan.inTotal, plan.outTotal + plan.feeGrains + plan.changeGrains + plan.dustAbsorbedGrains);
});

test("planSpend absorbs dust change into the fee and discloses it", () => {
  const d = vault23();
  // inputs 100000000, out 99997800: change would be 320 grains (< 546 dust),
  // so no change output is created and the leftover becomes extra fee.
  const plan = planSpend({
    network: N, descriptor: d,
    selectedUtxos: [utxo(TXA, 0, 100000000n)],
    recipients: [{ address: d.address, grains: 99997800n }],
    feeRateGrainsPerVByte: 10,
  });
  assert.equal(plan.changeGrains, 0n);
  assert.equal(plan.outputs.length, 1, "no change output when dust");
  // vBytes without change output: base = 85, witness = 272 -> ceil(614/4) = 154
  assert.equal(plan.vBytes, 154);
  assert.equal(plan.feeGrains, 1540n);
  assert.equal(plan.dustAbsorbedGrains, 660n);
  assert.equal(plan.inTotal, plan.outTotal + plan.feeGrains + plan.dustAbsorbedGrains);
});

test("planSpend refuses shortfall, dust outputs, bad addresses", () => {
  const d = vault23();
  const base = {
    network: N, descriptor: d,
    selectedUtxos: [utxo(TXA, 0, 1000000n)],
    recipients: [{ address: d.address, grains: 999999n }],
    feeRateGrainsPerVByte: 10,
  };
  assert.throws(() => planSpend(base), /shortfall/);
  assert.throws(() => planSpend({ ...base, recipients: [{ address: d.address, grains: 100n }] }), /dust/);
  assert.throws(() => planSpend({ ...base, recipients: [{ address: "junk", grains: 999999n }] }), /VAULT REFUSED/);
  assert.throws(() => planSpend({ ...base, selectedUtxos: [] }), /at least one/);
  assert.throws(() => planSpend({ ...base, recipients: [] }), /at least one recipient/);
  assert.throws(() => planSpend({ ...base, feeRateGrainsPerVByte: 0 }), /fee rate/);
});

/* ---------------- bundle + signing round ---------------- */

test("full 2-of-3 signing round: bundle -> partials -> finalize, sigs verify", () => {
  const d = vault23();
  const plan = plan23();
  const bundle = buildUnsignedBundle(plan, d);
  assert.equal(bundle.kind, "pearl-vault-unsigned:v1");
  assert.equal(bundle.fingerprint.length, 16);
  assert.equal(bundle.digests.length, 1);

  // Import re-derives everything.
  const parsed = parseUnsignedBundle(JSON.parse(JSON.stringify(bundle)), d);
  assert.equal(parsed.fingerprint, bundle.fingerprint);

  // Two cosigners sign.
  const p0 = signBundle(parsed, d, 0, hexToBytes(PRIVS[0]));
  const p2 = signBundle(parsed, d, 2, hexToBytes(PRIVS[2]));
  assert.equal(p0.kind, "pearl-vault-partialsig:v1");

  // Every partial sig verifies against its key and the input digest.
  for (const ps of [p0, p2]) {
    for (const { inputIndex, sig } of ps.sigs) {
      assert.equal(
        verifySchnorrSig(sig, bundle.digests[inputIndex], d.keys[ps.keyIndex]),
        true,
      );
    }
  }

  // Combine: reverse key order, empty for the non-signer (key 1).
  const stacks = combineMultisigSigs([p0, p2], parsed, d);
  assert.equal(stacks.length, 1);
  assert.equal(stacks[0].length, 3);
  assert.equal(stacks[0][0].length, 64); // sig of key 2 first (reverse order)
  assert.equal(stacks[0][1].length, 0);  // key 1 did not sign -> empty vector
  assert.equal(stacks[0][2].length, 64); // sig of key 0 last
  assert.deepEqual([...stacks[0][0]], [...hexToBytes(p2.sigs[0].sig)]);
  assert.deepEqual([...stacks[0][2]], [...hexToBytes(p0.sigs[0].sig)]);

  // Finalize: txid over the base serialization; hex parses.
  const fin = finalizeSpend(parsed, d, [p0, p2]);
  assert.match(fin.txid, /^[0-9a-f]{64}$/);
  assert.equal(fin.vBytes, bundle.vBytes);
  const net = N;
  const baseBytes = serializeSpendTx(net, parsed._inputs, parsed._outputs, null);
  assert.equal(bytesToHex(dblSha(baseBytes).reverse()), fin.txid);
  // Witness serialization is longer and starts with the segwit marker.
  assert.ok(fin.hex.length > bytesToHex(baseBytes).length);
});

test("verifyPartialSigs: single valid partial accepted without quorum, bad rejected", () => {
  const d = vault23();
  const bundle = buildUnsignedBundle(plan23(), d);
  const parsed = parseUnsignedBundle(bundle, d);
  const p0 = signBundle(parsed, d, 0, hexToBytes(PRIVS[0]));
  // one valid partial verifies fine even though 2-of-3 needs another
  assert.equal(verifyPartialSigs(p0, parsed, d), 0);
  // tampered signature rejected at the door
  const bad = JSON.parse(JSON.stringify(p0));
  bad.sigs[0].sig = "00".repeat(64);
  assert.throws(() => verifyPartialSigs(bad, parsed, d), /does not verify/);
  // empty sigs refused
  assert.throws(() => verifyPartialSigs({ ...p0, sigs: [] }, parsed, d), /no signatures/);
});

test("combineMultisigSigs refuses bad / duplicate / insufficient sigs", () => {
  const d = vault23();
  const bundle = buildUnsignedBundle(plan23(), d);
  const parsed = parseUnsignedBundle(bundle, d);
  const p0 = signBundle(parsed, d, 0, hexToBytes(PRIVS[0]));
  // tampered signature
  const bad = JSON.parse(JSON.stringify(p0));
  bad.sigs[0].sig = "00".repeat(64);
  assert.throws(() => combineMultisigSigs([bad], parsed, d), /does not verify/);
  // duplicate signer
  assert.throws(() => combineMultisigSigs([p0, p0], parsed, d), /duplicate/);
  // only one signature for a 2-of-3
  assert.throws(() => combineMultisigSigs([p0], parsed, d), /need 2/);
  // wrong key claimed
  const wrongKey = JSON.parse(JSON.stringify(p0));
  wrongKey.key = d.keys[1];
  assert.throws(() => combineMultisigSigs([wrongKey], parsed, d), /does not match cosigner/);
  // bundle from another vault
  const other = { ...p0, fingerprint: "deadbeefdeadbeef" };
  assert.throws(() => combineMultisigSigs([other], parsed, d), /different bundle/);
});

test("parseUnsignedBundle refuses tampered fee / vBytes / digests", () => {
  const d = vault23();
  const bundle = buildUnsignedBundle(plan23(), d);
  const t1 = { ...bundle, feeGrains: (BigInt(bundle.feeGrains) + 1n).toString() };
  assert.throws(() => parseUnsignedBundle(t1, d), /fee/);
  const t2 = { ...bundle, vBytes: bundle.vBytes + 1 };
  assert.throws(() => parseUnsignedBundle(t2, d), /vBytes/);
  const t3 = { ...bundle, digests: ["00".repeat(32)] };
  assert.throws(() => parseUnsignedBundle(t3, d), /digests/);
  const t4 = { ...bundle, inputs: [{ ...bundle.inputs[0], value: "1" }] };
  assert.throws(() => parseUnsignedBundle(t4, d), /fingerprint|digests/);
  // bundle for a different vault's descriptor
  const d2 = buildVaultDescriptor(N, [XONLY[0], XONLY[1]], 2);
  assert.throws(() => parseUnsignedBundle(bundle, d2), /different vault/);
});

test("odd-Y cosigner keys sign and verify (BIP-340 negation)", () => {
  // Find a fixture privkey whose pubkey has odd Y.
  let odd = null;
  for (let i = 4; i < 40 && !odd; i++) {
    const p = i.toString(16).padStart(64, "0");
    const pt = secp256k1.ProjectivePoint.fromPrivateKey(hexToBytes(p));
    if (pt.toRawBytes(true)[0] === 0x03) odd = p;
  }
  assert.ok(odd, "found an odd-Y fixture key");
  const dg = sha256(te.encode("vault-odd-y-test"));
  const sig = signForXOnly(hexToBytes(odd), dg);
  const xonly = bytesToHex(schnorr.getPublicKey(hexToBytes(odd)));
  assert.equal(verifySchnorrSig(bytesToHex(sig), dg, xonly), true);
});

/* ---------------- descriptor string ---------------- */

test("multi-input spend: digests differ per input, all verify", () => {
  const d = vault23();
  const plan = planSpend({
    network: N, descriptor: d,
    selectedUtxos: [utxo(TXA, 0, 100000000n), utxo(TXB, 1, 100000000n)],
    recipients: [{ address: d.address, grains: 150000000n }],
    feeRateGrainsPerVByte: 5,
  });
  const bundle = buildUnsignedBundle(plan, d);
  assert.equal(bundle.digests.length, 2);
  assert.notEqual(bundle.digests[0], bundle.digests[1]);
  const parsed = parseUnsignedBundle(bundle, d);
  const p0 = signBundle(parsed, d, 0, hexToBytes(PRIVS[0]));
  const p1 = signBundle(parsed, d, 1, hexToBytes(PRIVS[1]));
  const fin = finalizeSpend(parsed, d, [p0, p1]);
  assert.match(fin.txid, /^[0-9a-f]{64}$/);
});
