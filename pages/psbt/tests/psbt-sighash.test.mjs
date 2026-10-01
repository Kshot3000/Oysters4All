/* Pearl PSBT sighash tests — BIP-341 construction, determinism,
 * differential pinning against the audited sign core, sign/verify
 * round-trips (keypath + scriptpath), tamper resistance, sighash-type rules.
 * Run: node --no-warnings --loader ./tests/loader.mjs --test tests/
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as C from "../src/psbt-core.js";
import {
  keypathSigDigestEx, commitKeyInfo, NETWORKS, p2trScriptPubKey,
  tweakPrivKeypath, walletToWIF, bytesToHex, hexToBytes, schnorr, sha256,
} from "../../sign/src/crypto.js";

const NET = NETWORKS.mainnet;
const ZERO_AUX = new Uint8Array(32);

function prog(seed) {
  return Uint8Array.from({ length: 32 }, (_, i) => (seed + i * 37) & 255);
}
/* two deterministic keypairs (BIP-340-style test keys) */
const SK1 = "01".padStart(64, "0"), SK2 = "02".padStart(64, "0");
const PK1 = schnorr.getPublicKey(hexToBytes(SK1));
const PK2 = schnorr.getPublicKey(hexToBytes(SK2));

/* Build a small unsigned tx + prevouts usable by both implementations. */
function fixtureTx() {
  const q1 = C.tapTweak(PK1, null).Q;
  const q2 = C.tapTweak(PK2, null).Q;
  const spk1 = p2trScriptPubKey(q1), spk2 = p2trScriptPubKey(q2);
  const tx = {
    version: 1,
    inputs: [
      { txid: bytesToHex(sha256(new TextEncoder().encode("sighash-in-1"))), vout: 0, sequence: 0xffffffff },
      { txid: bytesToHex(sha256(new TextEncoder().encode("sighash-in-2"))), vout: 3, sequence: 0xfffffffe },
    ],
    outputs: [
      { value: 150000000n, script: p2trScriptPubKey(prog(21)) },
      { value: 49000000n, script: p2trScriptPubKey(prog(22)) },
    ],
    locktime: 0,
  };
  const prevouts = [
    { amount: 120000000n, spk: spk1 },
    { amount: 80000000n, spk: spk2 },
  ];
  return { tx, prevouts };
}
/* ---------- differential pinning vs the audited sign core ----------
 * The second test below is the real pinning: uniform per-input sequences so
 * the audited keypathSigDigestEx (single sequence arg) is directly comparable.
 * DEFAULT and SINGLE|ANYONECANPAY cover both the plain and the annex-free
 * ANYONECANPAY preimage layouts. */

test("keypath sighash byte-equal with uniform sequences (DEFAULT + SINGLE|ACP)", () => {
  const { prevouts } = fixtureTx();
  const txu = {
    version: 1,
    inputs: [
      { txid: bytesToHex(sha256(new TextEncoder().encode("sighash-in-1"))), vout: 0, sequence: 0xffffffff },
      { txid: bytesToHex(sha256(new TextEncoder().encode("sighash-in-2"))), vout: 3, sequence: 0xffffffff },
    ],
    outputs: [
      { value: 150000000n, script: p2trScriptPubKey(prog(21)) },
      { value: 49000000n, script: p2trScriptPubKey(prog(22)) },
    ],
    locktime: 0,
  };
  const inputs = txu.inputs.map((inp, i) => ({
    txid: inp.txid, vout: inp.vout, value: Number(prevouts[i].amount), spk: prevouts[i].spk,
  }));
  const outputs = txu.outputs.map((o) => ({ program: o.script.slice(2), value: Number(o.value) }));
  for (const ht of [0x00, 0x83]) {
    for (const idx of [0, 1]) {
      const mine = C.taprootSighash({ tx: txu, inputIndex: idx, prevouts, hashType: ht });
      const theirs = keypathSigDigestEx(NET, inputs, outputs, 0xffffffff, idx, ht);
      assert.deepEqual(mine, theirs, `sighash byte-equal for hashType 0x${ht.toString(16)} input ${idx}`);
    }
  }
});

test("control block matches audited commitKeyInfo", () => {
  const script = C.asmToScript(`<${bytesToHex(PK1)}> OP_CHECKSIG`);
  const info = commitKeyInfo(NET, PK2, script);
  const root = C.tapLeafHash(script);
  assert.deepEqual(root, info.merkleRoot);
  assert.deepEqual(C.controlBlockFor(PK2, root), info.controlBlock);
  assert.deepEqual(C.tapTweak(PK2, root).Q, info.commitXOnly);
});

/* ---------- determinism + type coverage ---------- */

test("sighash is deterministic across all 7 types", () => {
  const { tx, prevouts } = fixtureTx();
  for (const ht of C.SIGHASH_OPTIONS) {
    const a = C.taprootSighash({ tx, inputIndex: 0, prevouts, hashType: ht });
    const b = C.taprootSighash({ tx, inputIndex: 0, prevouts, hashType: ht });
    assert.deepEqual(a, b, `deterministic for 0x${ht.toString(16)}`);
    assert.equal(a.length, 32);
  }
  // different types -> different sighashes (type byte commits)
  const h00 = C.taprootSighash({ tx, inputIndex: 0, prevouts, hashType: 0x00 });
  const h01 = C.taprootSighash({ tx, inputIndex: 0, prevouts, hashType: 0x01 });
  assert.ok(!h00.every((v, i) => v === h01[i]), "DEFAULT != ALL preimage");
});

test("SIGHASH_SINGLE out-of-range input rejected", () => {
  const { tx, prevouts } = fixtureTx();
  const txOneOut = { ...tx, outputs: tx.outputs.slice(0, 1) };
  assert.throws(
    () => C.taprootSighash({ tx: txOneOut, inputIndex: 1, prevouts, hashType: 0x03 }),
    /SIGHASH_SINGLE/);
});

test("sighash commits to prevout data (changing amount changes hash)", () => {
  const { tx, prevouts } = fixtureTx();
  const h1 = C.taprootSighash({ tx, inputIndex: 0, prevouts, hashType: 0x00 });
  const prevouts2 = [{ ...prevouts[0], amount: prevouts[0].amount + 1n }, prevouts[1]];
  const h2 = C.taprootSighash({ tx, inputIndex: 0, prevouts: prevouts2, hashType: 0x00 });
  assert.ok(!h1.every((v, i) => v === h2[i]));
});

/* ---------- keypath sign -> verify round-trip ---------- */

function keypathPsbt() {
  const { tx, prevouts } = fixtureTx();
  const mkIn = (internal, amount) => {
    const { Q } = C.tapTweak(internal, null);
    const wspk = p2trScriptPubKey(Q);
    return [
      { key: new Uint8Array([0x01]), value: new Uint8Array([...C.u64le(amount), wspk.length, ...wspk]) },
      { key: new Uint8Array([0x17]), value: internal },
    ];
  };
  const unsignedTxBytes = C.serializeUnsignedTx(tx);
  return {
    globalPairs: [{ key: new Uint8Array([0x00]), value: unsignedTxBytes }],
    unsignedTx: tx, unsignedTxBytes,
    inputs: [mkIn(PK1, prevouts[0].amount), mkIn(PK2, prevouts[1].amount)],
    outputs: [],
  };
}

test("keypath sign/verify round-trip (internal-key path)", () => {
  const psbt = keypathPsbt();
  const r = C.signPsbtInput({
    psbt, inputIndex: 0, privKey: hexToBytes(SK1), hashType: 0x00, auxRand: ZERO_AUX,
  });
  assert.equal(r.mode, "keypath");
  assert.match(r.keyNote, /TapTweak/);
  assert.equal(r.sigHex.length, 128, "DEFAULT sig is 64 bytes, no suffix");
  const sighash = hexToBytes(r.sighashHex);
  const Q = C.tapTweak(PK1, null).Q;
  assert.ok(schnorr.verify(hexToBytes(r.sigHex), sighash, Q), "sig verifies against Q");
  // PSBT now carries PSBT_IN_TAP_KEY_SIG
  const e = psbt.inputs[0].find((p) => p.key.length === 1 && p.key[0] === 0x13);
  assert.ok(e, "tap key sig inserted");
});

test("keypath accepts an already-tweaked key", () => {
  const psbt = keypathPsbt();
  const tweakedPriv = tweakPrivKeypath(hexToBytes(SK1), PK1);
  const { Q } = C.tapTweak(PK1, null);
  assert.deepEqual(schnorr.getPublicKey(tweakedPriv), Q, "tweaked privkey matches Q");
  const r = C.signPsbtInput({
    psbt, inputIndex: 0, privKey: tweakedPriv, hashType: 0x01, auxRand: ZERO_AUX,
  });
  assert.match(r.keyNote, /tweaked keypath key/);
  assert.equal(r.sigHex.length, 130, "ALL sig is 65 bytes with suffix");
  assert.ok(r.sigHex.endsWith("01"), "sighash byte appended");
  const sighash = hexToBytes(r.sighashHex);
  assert.ok(schnorr.verify(hexToBytes(r.sigHex).slice(0, 64), sighash, Q));
});

test("keypath rejects a wrong key loudly", () => {
  const psbt = keypathPsbt();
  assert.throws(() => C.signPsbtInput({
    psbt, inputIndex: 0, privKey: hexToBytes(SK2), hashType: 0x00, auxRand: ZERO_AUX,
  }), /wrong key or wrong input/);
});

test("flipping one bit of the sighash breaks verification", () => {
  const psbt = keypathPsbt();
  const r = C.signPsbtInput({
    psbt, inputIndex: 1, privKey: hexToBytes(SK2), hashType: 0x00, auxRand: ZERO_AUX,
  });
  const sighash = hexToBytes(r.sighashHex);
  const Q = C.tapTweak(PK2, null).Q;
  const sig = hexToBytes(r.sigHex);
  assert.ok(schnorr.verify(sig, sighash, Q));
  const tampered = Uint8Array.from(sighash);
  tampered[7] ^= 0x01; // flip one bit of the sighash
  assert.ok(!schnorr.verify(sig, tampered, Q), "tampered sighash must not verify");
  const tampered2 = Uint8Array.from(sig);
  tampered2[0] ^= 0x01; // flip one bit of the signature
  assert.ok(!schnorr.verify(tampered2, sighash, Q), "tampered sig must not verify");
});

/* ---------- scriptpath sign -> verify round-trip ---------- */

function scriptpathPsbt() {
  const script = C.asmToScript(`<${bytesToHex(PK1)}> OP_CHECKSIG`);
  const leafHash = C.tapLeafHash(script);
  const { Q } = C.tapTweak(PK2, leafHash);
  const wspk = p2trScriptPubKey(Q);
  const cb = C.controlBlockFor(PK2, leafHash);
  const tx = {
    version: 1,
    inputs: [{ txid: bytesToHex(sha256(new TextEncoder().encode("sp-in"))), vout: 0, sequence: 0xffffffff }],
    outputs: [{ value: 50000000n, script: p2trScriptPubKey(prog(31)) }],
    locktime: 0,
  };
  const amount = 60000000n;
  const unsignedTxBytes = C.serializeUnsignedTx(tx);
  const pairs = [
    { key: new Uint8Array([0x01]), value: new Uint8Array([...C.u64le(amount), wspk.length, ...wspk]) },
    { key: new Uint8Array([0x17]), value: PK2 },
    { key: new Uint8Array([0x18]), value: leafHash },
    { key: new Uint8Array([0x15, ...cb]), value: script },
  ];
  return { psbt: { globalPairs: [{ key: new Uint8Array([0x00]), value: unsignedTxBytes }], unsignedTx: tx, unsignedTxBytes, inputs: [pairs], outputs: [] }, script, leafHash };
}

test("scriptpath sign/verify round-trip", () => {
  const { psbt, leafHash } = scriptpathPsbt();
  const r = C.signPsbtInput({
    psbt, inputIndex: 0, privKey: hexToBytes(SK1), hashType: 0x00, auxRand: ZERO_AUX,
  });
  assert.equal(r.mode, "scriptpath");
  assert.equal(r.leafHashHex, bytesToHex(leafHash));
  const sighash = hexToBytes(r.sighashHex);
  assert.ok(schnorr.verify(hexToBytes(r.sigHex), sighash, PK1), "leaf sig verifies against leaf pubkey");
  const e = psbt.inputs[0].find((p) => p.key.length === 65 && p.key[0] === 0x14);
  assert.ok(e, "tap script sig inserted");
  assert.deepEqual(e.key.slice(1, 33), PK1);
  assert.deepEqual(e.key.slice(33, 65), leafHash);
  // scriptpath sighash commits to the leaf hash: differs from keypath sighash
  const prevouts = C.prevoutsFromPsbt(psbt);
  const kp = C.taprootSighash({ tx: psbt.unsignedTx, inputIndex: 0, prevouts, hashType: 0x00 });
  assert.ok(!kp.every((v, i) => v === sighash[i]), "scriptpath commits to leaf hash");
});

test("scriptpath rejects a non-signer key", () => {
  const { psbt } = scriptpathPsbt();
  assert.throws(() => C.signPsbtInput({
    psbt, inputIndex: 0, privKey: hexToBytes(SK2), hashType: 0x00, auxRand: ZERO_AUX,
  }), /not a 32-byte push in the chosen leaf/);
});

/* ---------- privkey parsing ---------- */

test("parsePrivKey accepts hex and WIF", () => {
  assert.deepEqual(C.parsePrivKey(SK1), hexToBytes(SK1));
  assert.deepEqual(C.parsePrivKey(SK1.toUpperCase()), hexToBytes(SK1));
  const wif = walletToWIF(hexToBytes(SK2), NET);
  assert.deepEqual(C.parsePrivKey(wif), hexToBytes(SK2));
  assert.throws(() => C.parsePrivKey("deadbeef"), /hex or mainnet WIF/);
  assert.throws(() => C.parsePrivKey(""), /hex or mainnet WIF/);
});
