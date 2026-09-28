// Pearl Escrow verification suite — node --test, zero new deps.
// Run: node --no-warnings --loader ./tests/loader.mjs tests/escrow.test.mjs
// Exercises the full escrow pipeline: script templates, taptree construction,
// sighash cross-check against the audited buildRevealTx, the 2-of-3 release
// flow (sign -> combine -> build -> verify), the CLTV refund flow, fee
// planning, and the negative cases (bad sigs, tampered outputs, dust).
import test from "node:test";
import assert from "node:assert/strict";

import {
  NETWORKS, DUST_GRAIN, GRAIN_PER_PRL,
  parseXOnlyKey, partyKeyFromInput,
  buildReleaseScript, buildRefundScript, encodeScriptNum, scriptAsm,
  taptree2, verifyControlBlock,
  scriptPathSigDigestEx, signForXOnly, verifySchnorrSig,
  combineReleaseSigs, buildScriptPathSpend, planSpend, spendVBytes,
  addressToProgram,
  bytesToHex, hexToBytes, schnorr, sha256, dblSha, convertBits,
  encodeBech32m, decodeBech32m, p2trScriptPubKey, txidLE,
  walletFromMnemonic, newMnemonic,
} from "../src/escrow-core.js";
import {
  buildRevealTx, buildInscriptionScript, commitKeyInfo, tapLeafHash,
} from "../../sign/src/crypto.js";
import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesToNumberBE } from "@noble/curves/abstract/utils";
import { bech32m } from "@scure/base";

const net = NETWORKS.mainnet;
// Three fixed BIP-39 test mnemonics (never funded; test-only).
const MNEMONICS = [
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  "legal winner thank year wave sausage worth useful legal winner thank yellow",
  "letter advice cage absurd amount doctor acoustic avoid letter advice cage above",
];
const wallets = [
  walletFromMnemonic(MNEMONICS[0], net, 0, 1), // index 1: odd-Y key (exercises BIP-340 negation)
  walletFromMnemonic(MNEMONICS[1], net),
  walletFromMnemonic(MNEMONICS[2], net),
];
const KEYS = wallets.map((w) => w.internalXOnly);
const PRIVS = wallets.map((w) => w.priv);

const isOddY = (priv) =>
  secp256k1.ProjectivePoint.fromPrivateKey(priv).toRawBytes(true)[0] === 0x03;

test("at least one test key has odd Y (parity-negation path is exercised)", () => {
  assert.ok(PRIVS.some(isOddY), "expected an odd-Y key among the fixtures");
});

test("buildReleaseScript: exact byte layout", () => {
  const s = buildReleaseScript(KEYS[0], KEYS[1], KEYS[2]);
  const expect =
    "00" + "20" + bytesToHex(KEYS[0]) + "ba" +
    "20" + bytesToHex(KEYS[1]) + "ba" +
    "20" + bytesToHex(KEYS[2]) + "ba" + "5287";
  assert.equal(bytesToHex(s), expect);
  assert.equal(s.length, 105);
  // asm sanity
  const asm = scriptAsm(s);
  assert.ok(asm.startsWith("0 <"), asm);
  assert.ok(asm.includes("CHECKSIGADD"), asm);
  assert.ok(asm.endsWith("2 EQUAL"), asm);
});

test("buildReleaseScript rejects bad keys", () => {
  assert.throws(() => buildReleaseScript("zz", KEYS[1], KEYS[2]), /64 hex/);
  assert.throws(() => buildReleaseScript(KEYS[0], KEYS[1]), /64 hex/);
  // x >= field prime is not a valid x-only key
  assert.throws(() => parseXOnlyKey("f".repeat(64)), /./);
});

test("encodeScriptNum: minimal-encoding vectors", () => {
  assert.equal(bytesToHex(encodeScriptNum(0)), "00");
  assert.equal(bytesToHex(encodeScriptNum(1)), "01");
  assert.equal(bytesToHex(encodeScriptNum(16)), "10");
  assert.equal(bytesToHex(encodeScriptNum(17)), "11");
  assert.equal(bytesToHex(encodeScriptNum(127)), "7f");
  assert.equal(bytesToHex(encodeScriptNum(128)), "8000");
  assert.equal(bytesToHex(encodeScriptNum(130000)), "d0fb01"); // 0x1FBD0 LE
  assert.equal(bytesToHex(encodeScriptNum(500000)), "20a107");
  assert.throws(() => encodeScriptNum(-1), /non-negative/);
  // (the <500000000 CLTV consensus rule is enforced by buildRefundScript, not here)
});

test("buildRefundScript: exact byte layout + CLTV guards", () => {
  const s = buildRefundScript(KEYS[0], 130000);
  const expect = "03" + "d0fb01" + "b1" + "75" + "20" + bytesToHex(KEYS[0]) + "ac";
  assert.equal(bytesToHex(s), expect);
  assert.equal(s.length, 40);
  const asm = scriptAsm(s);
  assert.ok(asm.includes("CLTV") && asm.includes("DROP") && asm.includes("CHECKSIG"), asm);
  assert.throws(() => buildRefundScript(KEYS[0], 0), /positive block height/);
  assert.throws(() => buildRefundScript(KEYS[0], 500000000), /positive block height/);
});

test("taptree2: address, control blocks, order-independence", () => {
  const rel = buildReleaseScript(KEYS[0], KEYS[1], KEYS[2]);
  const ref = buildRefundScript(KEYS[0], 130000);
  const t = taptree2(net, KEYS[0], rel, ref);
  assert.equal(t.controlBlocks.length, 2);
  assert.equal(t.controlBlocks[0].length, 65);
  assert.ok(verifyControlBlock(KEYS[0], rel, t.controlBlocks[0], t.tweakedX));
  assert.ok(verifyControlBlock(KEYS[0], ref, t.controlBlocks[1], t.tweakedX));
  // tampered control block / wrong leaf must fail
  const bad = Uint8Array.from(t.controlBlocks[0]);
  bad[40] ^= 0x01;
  assert.equal(verifyControlBlock(KEYS[0], rel, bad, t.tweakedX), false);
  assert.equal(verifyControlBlock(KEYS[0], ref, t.controlBlocks[0], t.tweakedX), false);
  // leaf order must not change the contract
  const t2 = taptree2(net, KEYS[0], ref, rel);
  assert.equal(bytesToHex(t2.tweakedX), bytesToHex(t.tweakedX));
  assert.equal(t2.address, t.address);
  // address is a valid P2TR bech32m address
  const dec = decodeBech32m(t.address);
  assert.equal(dec.hrp, net.hrp);
  assert.equal(dec.version, 1);
  assert.equal(dec.program.length, 32);
  assert.equal(bytesToHex(dec.program), bytesToHex(t.tweakedX));
});

test("scriptPathSigDigestEx: byte-equal to audited buildRevealTx digest", () => {
  const w = wallets[0];
  const json = new TextEncoder().encode('{"p":"prl-20","op":"mint","tick":"test","amt":"1"}');
  const script = buildInscriptionScript(w.internalXOnly, json);
  const info = commitKeyInfo(net, w.internalXOnly, script);
  const commitTxid = "11".repeat(32);
  const commitValue = 100000;
  const outputs = [{ program: wallets[1].internalXOnly, value: 90000 }];
  const sequence = 0xfffffffe;
  const built = buildRevealTx(net, {
    commitTxid, commitVout: 0, commitValue, commitProgram: info.commitXOnly,
    internalPriv: w.priv, script, controlBlock: info.controlBlock, outputs, sequence,
  });
  const mine = scriptPathSigDigestEx(
    net,
    { txid: commitTxid, vout: 0, value: commitValue, spk: p2trScriptPubKey(info.commitXOnly) },
    outputs,
    script,
    { sequence, locktime: 0, inputIdx: 0 },
  );
  assert.equal(bytesToHex(mine), built.digest);
});

test("signForXOnly: BIP-340 round trip incl. odd-Y keys", () => {
  const digest = sha256(new TextEncoder().encode("pearl-escrow-test"));
  PRIVS.forEach((priv, i) => {
    const sig = signForXOnly(priv, digest);
    assert.equal(sig.length, 64);
    assert.ok(verifySchnorrSig(sig, digest, KEYS[i]), `key ${i} (oddY=${isOddY(priv)})`);
    // cross-key must fail
    assert.equal(verifySchnorrSig(sig, digest, KEYS[(i + 1) % 3]), false);
  });
  // tampered digest must fail
  const sig = signForXOnly(PRIVS[0], digest);
  const bad = Uint8Array.from(digest); bad[0] ^= 1;
  assert.equal(verifySchnorrSig(sig, bad, KEYS[0]), false);
});

test("full 2-of-3 release flow: sign -> combine -> build -> parse -> verify", () => {
  const rel = buildReleaseScript(KEYS[0], KEYS[1], KEYS[2]);
  const ref = buildRefundScript(KEYS[0], 130000);
  const tree = taptree2(net, KEYS[0], rel, ref);
  const fundTxid = "ab".repeat(32);
  const fundValue = 5 * GRAIN_PER_PRL; // 5 PRL
  const input = { txid: fundTxid, vout: 0, value: fundValue, spk: tree.spk };

  const sellerPay = { program: wallets[1].internalXOnly, value: 4 * GRAIN_PER_PRL };
  const plan = planSpend({
    inputValue: fundValue,
    payments: [sellerPay],
    feeRateGrainsPerVByte: 5,
    scriptLen: rel.length, controlLen: 65, stackLens: [64, 0, 64],
  });
  // change output present (buyer = KEYS[0])
  plan.outputs.find((o) => o.change).program = KEYS[0];

  // buyer (key 0) and arbiter (key 2) sign
  const digest = scriptPathSigDigestEx(net, input, plan.outputs, rel, {});
  const sig0 = signForXOnly(PRIVS[0], digest);
  const sig2 = signForXOnly(PRIVS[2], digest);
  const stack = combineReleaseSigs(
    [{ keyIndex: 0, sig: sig0 }, { keyIndex: 2, sig: sig2 }],
    digest, KEYS,
  );
  // witness order: reverse key order -> [sig_K3, empty, sig_K1]
  assert.equal(stack.length, 3);
  assert.equal(bytesToHex(stack[0]), bytesToHex(sig2));
  assert.equal(stack[1].length, 0);
  assert.equal(bytesToHex(stack[2]), bytesToHex(sig0));

  const spend = buildScriptPathSpend(net, input, plan.outputs, rel, tree.controlBlocks[0], stack, {});
  assert.equal(spend.vBytes, plan.vBytes, "built tx vBytes must match the plan");
  assert.equal(spend.digest, bytesToHex(digest));

  // parse the witness back out of the raw tx and re-verify every element
  const wit = parseWitness(spend.hex);
  assert.equal(wit.length, 5);
  assert.equal(bytesToHex(wit[0]), bytesToHex(sig2));
  assert.equal(wit[1].length, 0);
  assert.equal(bytesToHex(wit[2]), bytesToHex(sig0));
  assert.equal(bytesToHex(wit[3]), bytesToHex(rel));
  assert.equal(bytesToHex(wit[4]), bytesToHex(tree.controlBlocks[0]));
  // each non-empty sig verifies against the digest and its key
  assert.ok(verifySchnorrSig(wit[0], digest, KEYS[2]));
  assert.ok(verifySchnorrSig(wit[2], digest, KEYS[0]));
  // txid is the double-sha256 of the base serialization
  assert.equal(spend.txid, txidOfBase(spend.hex));
  // outputs: seller paid, buyer got change minus fee
  const outs = parseOutputs(spend.hex);
  assert.equal(outs.length, 2);
  assert.equal(outs[0].value, 4 * GRAIN_PER_PRL);
  assert.ok(outs[1].value >= DUST_GRAIN);
  assert.equal(outs[0].value + outs[1].value + plan.fee, fundValue);
});

test("combineReleaseSigs: quorum enforcement", () => {
  const rel = buildReleaseScript(KEYS[0], KEYS[1], KEYS[2]);
  const tree = taptree2(net, KEYS[0], rel, buildRefundScript(KEYS[0], 130000));
  const input = { txid: "ab".repeat(32), vout: 0, value: 100000, spk: tree.spk };
  const outputs = [{ program: KEYS[1], value: 90000 }];
  const digest = scriptPathSigDigestEx(net, input, outputs, rel, {});
  const sig0 = signForXOnly(PRIVS[0], digest);
  // single signature is not a quorum
  assert.throws(() => combineReleaseSigs([{ keyIndex: 0, sig: sig0 }], digest, KEYS), /exactly 2/);
  // three signatures would break <2> EQUAL
  const sig1 = signForXOnly(PRIVS[1], digest);
  const sig2 = signForXOnly(PRIVS[2], digest);
  assert.throws(
    () => combineReleaseSigs(
      [{ keyIndex: 0, sig: sig0 }, { keyIndex: 1, sig: sig1 }, { keyIndex: 2, sig: sig2 }],
      digest, KEYS,
    ),
    /exactly 2/,
  );
  // wrong-key signature is rejected before it can reach the chain
  const otherDigest = scriptPathSigDigestEx(net, { ...input, value: 99999 }, outputs, rel, {});
  const wrongSig = signForXOnly(PRIVS[1], otherDigest);
  assert.throws(
    () => combineReleaseSigs([{ keyIndex: 0, sig: sig0 }, { keyIndex: 1, sig: wrongSig }], digest, KEYS),
    /does not verify/,
  );
  // tampering with an output invalidates both signatures (digest commits to outputs)
  const evil = [{ program: KEYS[1], value: 89000 }]; // 1000 grains skimmed
  const evilDigest = scriptPathSigDigestEx(net, input, evil, rel, {});
  assert.notEqual(bytesToHex(evilDigest), bytesToHex(digest));
  assert.equal(verifySchnorrSig(sig0, evilDigest, KEYS[0]), false);
});

test("refund flow: CLTV leaf digest, locktime, sequence, single-key sign", () => {
  const rel = buildReleaseScript(KEYS[0], KEYS[1], KEYS[2]);
  const lockHeight = 130000;
  const ref = buildRefundScript(KEYS[0], lockHeight);
  const tree = taptree2(net, KEYS[0], rel, ref);
  const input = { txid: "cd".repeat(32), vout: 1, value: 200000, spk: tree.spk };
  const outputs = [{ program: KEYS[0], value: 190000 }];
  const sequence = 0xfffffffe;
  const digest = scriptPathSigDigestEx(net, input, outputs, ref, { sequence, locktime: lockHeight });
  // refund digest differs from the release digest over the same coins
  const relDigest = scriptPathSigDigestEx(net, input, outputs, rel, { sequence, locktime: lockHeight });
  assert.notEqual(bytesToHex(digest), bytesToHex(relDigest));
  const sig = signForXOnly(PRIVS[0], digest);
  assert.ok(verifySchnorrSig(sig, digest, KEYS[0]));
  const spend = buildScriptPathSpend(net, input, outputs, ref, tree.controlBlocks[1], [sig], { sequence, locktime: lockHeight });
  const wit = parseWitness(spend.hex);
  assert.equal(wit.length, 3);
  assert.equal(bytesToHex(wit[0]), bytesToHex(sig));
  assert.equal(bytesToHex(wit[1]), bytesToHex(ref));
  assert.equal(bytesToHex(wit[2]), bytesToHex(tree.controlBlocks[1]));
  // locktime + sequence are consensus-visible in the raw tx
  const raw = hexToBytes(spend.hex);
  assert.equal(readU32LE(raw, raw.length - 4), lockHeight);
  assert.equal(readU32LE(raw, 4 + 1 + 1 + 1 + 32 + 4 + 1), sequence); // input sequence field
});

test("planSpend: fee math, dust folding, insufficient funds", () => {
  const base = {
    payments: [{ program: KEYS[1], value: 100000 }],
    feeRateGrainsPerVByte: 10,
    scriptLen: 105, controlLen: 65, stackLens: [64, 0, 64],
  };
  const p = planSpend({ ...base, inputValue: 200000 });
  assert.ok(p.fee > 0 && p.vBytes > 0);
  assert.equal(p.outputs.length, 2); // payment + change
  assert.ok(p.change >= DUST_GRAIN);
  assert.equal(p.outputs[0].value + p.outputs[1].value + p.fee, 200000);
  // dust change folds into the fee (no change output, change == 0)
  const p2 = planSpend({ ...base, inputValue: 100000 + 2000 });
  assert.equal(p2.outputs.length, 1);
  assert.equal(p2.change, 0);
  assert.equal(100000 + p2.fee, 100000 + 2000);
  // insufficient funds
  assert.throws(() => planSpend({ ...base, inputValue: 50000 }), /insufficient funds/);
  // dust payment refused
  assert.throws(
    () => planSpend({ ...base, inputValue: 200000, payments: [{ program: KEYS[1], value: 100 }] }),
    /dust/,
  );
});

test("partyKeyFromInput: hex and mnemonic inputs", () => {
  const hex = bytesToHex(KEYS[1]);
  const a = partyKeyFromInput(hex, net);
  assert.equal(bytesToHex(a.xonly), hex);
  assert.equal(a.priv, null);
  const b = partyKeyFromInput(MNEMONICS[2], net);
  assert.equal(bytesToHex(b.xonly), bytesToHex(KEYS[2]));
  assert.ok(b.priv && b.priv.length === 32);
  assert.throws(() => partyKeyFromInput("not a key", net), /x-only pubkey or a 12\/24-word mnemonic/);
  assert.throws(() => partyKeyFromInput("abandon abandon about", net), /x-only pubkey or a 12\/24-word mnemonic/);
});

test("addressToProgram: P2TR only, network-checked", () => {
  const addr = encodeBech32m(net.hrp, 1, KEYS[0]);
  assert.equal(bytesToHex(addressToProgram(addr, net)), bytesToHex(KEYS[0]));
  // a v0 (non-taproot) address is refused — crafted with raw bech32m words
  const words = [0, ...convertBits([...new Uint8Array(20).fill(7)], 8, 5, true)];
  const v0addr = bech32m.encode(net.hrp, words);
  assert.throws(() => addressToProgram(v0addr, net), /v1/);
  assert.throws(() => addressToProgram(encodeBech32m("tprl", 1, KEYS[0]), net), /wrong network HRP/);
  assert.throws(() => addressToProgram("not an address", net), /./);
});

test("spendVBytes: matches built-tx weight for both leaves", () => {
  const rel = buildReleaseScript(KEYS[0], KEYS[1], KEYS[2]);
  const ref = buildRefundScript(KEYS[0], 130000);
  const tree = taptree2(net, KEYS[0], rel, ref);
  const mk = (leaf, cb, stack) => {
    const input = { txid: "ab".repeat(32), vout: 0, value: 1000000, spk: tree.spk };
    const outputs = [{ program: KEYS[1], value: 900000 }];
    return buildScriptPathSpend(net, input, outputs, leaf, cb, stack, {});
  };
  const r = mk(rel, tree.controlBlocks[0], [new Uint8Array(64), new Uint8Array(0), new Uint8Array(64)]);
  assert.equal(r.vBytes, spendVBytes({ nOut: 1, scriptLen: rel.length, controlLen: 65, stackLens: [64, 0, 64] }));
  const f = mk(ref, tree.controlBlocks[1], [new Uint8Array(64)]);
  assert.equal(f.vBytes, spendVBytes({ nOut: 1, scriptLen: ref.length, controlLen: 65, stackLens: [64] }));
});

test("newMnemonic produces usable party keys", () => {
  const m = newMnemonic();
  assert.equal(m.trim().split(/\s+/).length, 12);
  const k = partyKeyFromInput(m, net);
  assert.equal(k.xonly.length, 32);
});

/* ---------- minimal tx parsers used by the tests ---------- */

function readVarint(b, off) {
  const f = b[off];
  if (f < 0xfd) return [f, 1];
  if (f === 0xfd) return [b[off + 1] | (b[off + 2] << 8), 3];
  if (f === 0xfe) return [b[off + 1] | (b[off + 2] << 8) | (b[off + 3] << 16) | (b[off + 4] << 24), 5];
  throw new Error("64-bit varint unsupported");
}
function readU32LE(b, off) {
  return (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0;
}
function readU64LE(b, off) {
  let v = 0n;
  for (let i = 0; i < 8; i++) v |= BigInt(b[off + i]) << BigInt(8 * i);
  return v;
}
function parseWitness(hex) {
  const b = hexToBytes(hex);
  let o = 4; // version
  assert.equal(b[o], 0x00); o++; // marker
  assert.equal(b[o], 0x01); o++; // flag
  const [nIn, l1] = readVarint(b, o); o += l1;
  assert.equal(nIn, 1);
  o += 32 + 4 + 1 + 4; // txid + vout + script len(0) + sequence
  const [nOut, l2] = readVarint(b, o); o += l2;
  for (let i = 0; i < nOut; i++) { o += 8; const [sl, l3] = readVarint(b, o); o += l3 + sl; }
  const [nWit, l4] = readVarint(b, o); o += l4;
  const items = [];
  for (let i = 0; i < nWit; i++) { const [l, ll] = readVarint(b, o); o += ll; items.push(b.slice(o, o + l)); o += l; }
  return items;
}
function parseOutputs(hex) {
  const b = hexToBytes(hex);
  let o = 4 + 2; // version + marker/flag
  const [nIn, l1] = readVarint(b, o); o += l1;
  o += 32 + 4 + 1 + 4;
  const [nOut, l2] = readVarint(b, o); o += l2;
  const outs = [];
  for (let i = 0; i < nOut; i++) {
    const value = readU64LE(b, o); o += 8;
    const [sl, l3] = readVarint(b, o); o += l3;
    const spk = b.slice(o, o + sl); o += sl;
    outs.push({ value: Number(value), spk });
  }
  return outs;
}
function txidOfBase(hex) {
  const b = hexToBytes(hex);
  const witStart = 4 + 2; // version + marker/flag
  let o = witStart;
  const [, l1] = readVarint(b, o); o += l1; // input count
  o += 32 + 4 + 1 + 4; // one input (txid + vout + empty script + sequence)
  const [nOut, l2] = readVarint(b, o); o += l2;
  for (let i = 0; i < nOut; i++) { o += 8; const [sl, l3] = readVarint(b, o); o += l3 + sl; }
  const witEnd = o; // witness starts here
  const [nWit, l4] = readVarint(b, o); o += l4;
  for (let i = 0; i < nWit; i++) { const [l, ll] = readVarint(b, o); o += ll + l; }
  // base = version + inputs + outputs + locktime (marker/flag + witness stripped)
  const base = Uint8Array.from([...b.slice(0, 4), ...b.slice(witStart, witEnd), ...b.slice(o, o + 4)]);
  return bytesToHex(dblSha(base).reverse());
}
