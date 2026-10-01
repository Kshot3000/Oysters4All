/* Pearl PSBT flow tests — combine (merge + mismatch + conflict), finalize
 * (sig re-verification, witness assembly), extract (txid, vsize, re-parse).
 * Run: node --no-warnings --loader ./tests/loader.mjs --test tests/
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as C from "../src/psbt-core.js";

const ZERO_AUX = new Uint8Array(32);
const keys = C.examplePrivkeys();

/* two signer PSBTs: A signed input 0 (keypath), B signed input 1 (scriptpath) */
function signerA() {
  const p = C.parsePsbtBase64(C.buildExamplePsbt().base64);
  C.signPsbtInput({ psbt: p, inputIndex: 0, privKey: C.hexToBytes(keys.keypath), hashType: 0x00, auxRand: ZERO_AUX });
  return C.psbtToBase64(p);
}
function signerB() {
  const p = C.parsePsbtBase64(C.buildExamplePsbt().base64);
  C.signPsbtInput({ psbt: p, inputIndex: 1, privKey: C.hexToBytes(keys.scriptpath), hashType: 0x01, auxRand: new Uint8Array(32).fill(7) });
  return C.psbtToBase64(p);
}

test("combine merges sigs from two PSBTs", () => {
  const merged = C.parsePsbtBase64(C.combinePsbts(signerA(), signerB()));
  const d = C.describePsbt(merged);
  assert.ok(d.inputs[0].keySig, "input 0 keypath sig present");
  assert.equal(d.inputs[1].scriptSigs.length, 1, "input 1 script sig present");
  assert.equal(d.inputs[0].keySig.sighash, "DEFAULT");
  assert.equal(d.inputs[1].scriptSigs[0].sighash, "ALL");
  assert.ok(d.inputs[1].scriptSigs[0].leafKnown, "script sig leaf is among declared leaves");
});

test("combine is order-independent and idempotent", () => {
  const a = signerA(), b = signerB();
  const ab = C.parsePsbtBase64(C.combinePsbts(a, b));
  const ba = C.parsePsbtBase64(C.combinePsbts(b, a));
  assert.equal(C.psbtToBase64(ab), C.psbtToBase64(ba), "combine order does not matter");
  const aa = C.parsePsbtBase64(C.combinePsbts(a, a));
  const da = C.describePsbt(aa);
  assert.ok(da.inputs[0].keySig && da.inputs[1].scriptSigs.length === 0);
});

test("combine rejects a different unsigned tx", () => {
  const a = signerA();
  const spec = C.exampleSpec();
  spec.locktime = 999; // same fields, different unsigned tx
  const ex2 = C.createPsbt(spec);
  assert.throws(() => C.combinePsbts(a, ex2.base64), /unsigned transactions differ/);
});

test("combine rejects conflicting sigs", () => {
  const p1 = C.parsePsbtBase64(C.buildExamplePsbt().base64);
  const p2 = C.parsePsbtBase64(C.buildExamplePsbt().base64);
  C.signPsbtInput({ psbt: p1, inputIndex: 0, privKey: C.hexToBytes(keys.keypath), hashType: 0x00, auxRand: ZERO_AUX });
  C.signPsbtInput({ psbt: p2, inputIndex: 0, privKey: C.hexToBytes(keys.keypath), hashType: 0x01, auxRand: ZERO_AUX });
  assert.throws(
    () => C.combinePsbts(C.psbtToBase64(p1), C.psbtToBase64(p2)),
    /conflict/);
});

test("combine detects a lying input count", () => {
  const p = C.parsePsbtBase64(signerA());
  // declare the count explicitly, then sneak in an extra input map
  p.globalPairs.push({ key: new Uint8Array([0xfd]), value: new Uint8Array([2]) });
  p.inputs.push([]);
  // the extra map is rejected (either by the count check or as trailing bytes)
  assert.throws(() => C.parsePsbt(C.serializePsbt(p)), /COUNT mismatch|trailing bytes/);
});

test("finalize re-verifies sigs and assembles witnesses", () => {
  const merged = C.combinePsbts(signerA(), signerB());
  const fin = C.finalizePsbt(merged);
  assert.equal(fin.results.length, 2);
  assert.ok(fin.results.every((r) => r.ok), "both inputs finalize");
  assert.match(fin.results[0].desc, /keypath/);
  assert.match(fin.results[1].desc, /scriptpath/);
  const p = C.parsePsbtBase64(fin.base64);
  const d = C.describePsbt(p);
  assert.ok(d.inputs[0].finalized && d.inputs[1].finalized);
  // finalized input keeps no stray partial-sig maps
  assert.equal(p.inputs[0].filter((x) => x.key[0] === 0x13).length, 0);
});

test("finalize refuses an unsigned input", () => {
  const unsigned = C.buildExamplePsbt().base64;
  assert.throws(() => C.finalizePsbt(unsigned), /no signature/);
});

test("finalize detects a swapped-in bad signature", () => {
  const merged = C.parsePsbtBase64(C.combinePsbts(signerA(), signerB()));
  // tamper: replace input 0's valid sig with garbage of the right length
  const idx = merged.inputs[0].findIndex((p) => p.key.length === 1 && p.key[0] === 0x13);
  merged.inputs[0][idx] = { key: merged.inputs[0][idx].key, value: new Uint8Array(64).fill(9) };
  assert.throws(() => C.finalizePsbt(C.psbtToBase64(merged)), /does not verify/);
});

test("extract yields a valid final tx (txid == unsigned preview)", () => {
  const merged = C.combinePsbts(signerA(), signerB());
  const fin = C.finalizePsbt(merged);
  const ext = C.extractTx(fin.base64);
  assert.equal(ext.hex.length % 2, 0);
  const expectedTxid = C.txidOfUnsigned(C.parsePsbtBase64(merged).unsignedTxBytes);
  assert.equal(ext.txid, expectedTxid, "final txid equals unsigned-tx preview");
  const raw = C.hexToBytes(ext.hex);
  assert.equal(raw[0], 0x01); // version
  assert.equal(raw[4], 0x00); // segwit marker
  assert.equal(raw[5], 0x01); // segwit flag
});

test("vsize follows weight/4 ceiling", () => {
  const merged = C.combinePsbts(signerA(), signerB());
  const ext = C.extractTx(C.finalizePsbt(merged).base64);
  const raw = C.hexToBytes(ext.hex);
  const tx = C.parseFinalTx(ext.hex);
  const noWit = C.serializeUnsignedTx({ version: tx.version, inputs: tx.inputs, outputs: tx.outputs, locktime: tx.locktime });
  const weight = noWit.length * 3 + raw.length;
  assert.equal(ext.vsize, Math.ceil(weight / 4), `vsize ${ext.vsize} == ceil(${weight}/4)`);
});

test("re-parsed final tx has the expected witnesses", () => {
  const merged = C.combinePsbts(signerA(), signerB());
  const fin = C.finalizePsbt(merged);
  const before = C.parsePsbtBase64(merged);
  const sigA = before.inputs[0].find((p) => p.key.length === 1 && p.key[0] === 0x13).value;
  const sigB = before.inputs[1].find((p) => p.key.length === 65 && p.key[0] === 0x14).value;
  const leaf = before.inputs[1].find((p) => p.key.length > 33 && p.key[0] === 0x15);
  const ext = C.extractTx(fin.base64);
  const tx = C.parseFinalTx(ext.hex);
  assert.equal(tx.inputs.length, 2);
  assert.equal(tx.outputs.length, 2);
  assert.equal(tx.witnesses.length, 2);
  assert.equal(tx.witnesses[0].length, 1, "keypath witness = [sig]");
  assert.deepEqual(tx.witnesses[0][0], sigA);
  assert.equal(tx.witnesses[1].length, 3, "scriptpath witness = [sig, script, control block]");
  assert.deepEqual(tx.witnesses[1][0], sigB);
  assert.deepEqual(tx.witnesses[1][1], leaf.value, "leaf script present");
  assert.deepEqual(tx.witnesses[1][2], leaf.key.slice(1), "control block present");
});

test("createPsbt reports input/output counts for the UI stats (regression: demo stats rendered 'undefined')", () => {
  const ex = C.buildExamplePsbt();
  assert.equal(ex.inputCount, 2);
  assert.equal(ex.outputCount, 2);
});
