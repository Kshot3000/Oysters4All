/* Pearl PSBT codec tests — compact uints, PSBT map round-trips,
 * create -> serialize -> parse byte-identity, malformed PSBT rejections,
 * strict bech32m address rules, grain-exact amounts, script assembler.
 * Run: node --no-warnings --loader ./tests/loader.mjs --test tests/
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as C from "../src/psbt-core.js";

function prog(seed) {
  return Uint8Array.from({ length: 32 }, (_, i) => (seed + i * 37) & 255);
}

/* ---------- compact uint boundaries ---------- */

test("compactUint boundary encodings", () => {
  assert.deepEqual(C.compactUint(0), [0x00]);
  assert.deepEqual(C.compactUint(0xfc), [0xfc]);
  assert.deepEqual(C.compactUint(0xfd), [0xfd, 0xfd, 0x00]);
  assert.deepEqual(C.compactUint(0xffff), [0xfd, 0xff, 0xff]);
  assert.deepEqual(C.compactUint(0x10000), [0xfe, 0x00, 0x00, 0x01, 0x00]);
  assert.deepEqual(C.compactUint(0xffffffff), [0xfe, 0xff, 0xff, 0xff, 0xff]);
  assert.deepEqual(C.compactUint(0x100000000n), [0xff, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00]);
  assert.deepEqual(C.compactUint(0xffffffffffffffffn),
    [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  assert.throws(() => C.compactUint(-1), /negative/);
  assert.throws(() => C.compactUint(0x10000000000000000n), /too large/);
});

test("u64le BigInt round-trip", () => {
  for (const v of [0n, 1n, 0xffffffffn, 0x100000000n, 21000000n * 100000000n]) {
    const b = C.u64le(v);
    assert.equal(b.length, 8);
    let back = 0n;
    for (let i = 7; i >= 0; i--) back = (back << 8n) | BigInt(b[i]);
    assert.equal(back, v);
  }
  assert.throws(() => C.u64le(-1n), /out of range/);
  assert.throws(() => C.u64le(0x10000000000000000n), /out of range/);
});

/* ---------- PSBT map codec ---------- */

test("magic + empty maps round-trip", () => {
  const unsignedTxBytes = C.serializeUnsignedTx({ version: 1, inputs: [], outputs: [], locktime: 0 });
  const psbt = {
    globalPairs: [{ key: new Uint8Array([0x00]), value: unsignedTxBytes }],
    unsignedTx: { version: 1, inputs: [], outputs: [], locktime: 0 },
    unsignedTxBytes,
    inputs: [], outputs: [],
  };
  const raw = C.serializePsbt(psbt);
  assert.equal(raw[0], 0x70); assert.equal(raw[1], 0x73);
  assert.equal(raw[2], 0x62); assert.equal(raw[3], 0x74); assert.equal(raw[4], 0xff);
  const back = C.parsePsbt(raw);
  assert.equal(back.globalPairs.length, 1);
  assert.deepEqual(back.globalPairs[0].key, new Uint8Array([0x00]));
  assert.deepEqual(back.globalPairs[0].value, unsignedTxBytes);
});

test("base64 round-trip preserves bytes", () => {
  const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
  assert.deepEqual(C.base64ToBytes(C.bytesToBase64(bytes)), bytes);
  assert.throws(() => C.base64ToBytes("!!!not-base64!!!"), /not valid base64/);
  assert.throws(() => C.base64ToBytes("abc"), /not valid base64/);
});

/* ---------- create -> serialize -> parse byte-identity ---------- */

test("create/serialize/parse is byte-identical", () => {
  const ex = C.buildExamplePsbt();
  const p = C.parsePsbtBase64(ex.base64);
  assert.equal(C.psbtToBase64(p), ex.base64, "parse->serialize must be byte-identical");
  assert.equal(p.unsignedTx.version, 1);
  assert.equal(p.unsignedTx.inputs.length, 2);
  assert.equal(p.unsignedTx.outputs.length, 2);
  assert.equal(p.unsignedTx.locktime, 0);
  // witness UTXOs carry the right amounts
  const prevouts = C.prevoutsFromPsbt(p);
  assert.equal(prevouts[0].amount, 250000000n);
  assert.equal(prevouts[1].amount, 100000000n);
  assert.equal(prevouts[0].spk.length, 34); // P2TR
  assert.equal(prevouts[0].spk[0], 0x51);
  // outputs: P2TR + OP_RETURN
  assert.equal(p.unsignedTx.outputs[0].value, 300000000n);
  assert.equal(p.unsignedTx.outputs[1].value, 0n);
  assert.equal(p.unsignedTx.outputs[1].script[0], 0x6a);
  // fee accounting is grain-exact
  assert.equal(ex.totalIn, 350000000n);
  assert.equal(ex.totalOut, 300000000n);
  assert.equal(ex.fee, 50000000n);
  // global map carries unsigned tx + modifiable flags
  const keys = p.globalPairs.map((x) => x.key[0]);
  assert.ok(keys.includes(0x00) && keys.includes(0xff));
  // input maps carry the taproot fields
  const in1keys = p.inputs[1].map((x) => x.key[0]);
  for (const k of [0x01, 0x17, 0x18, 0x15, 0x16]) assert.ok(in1keys.includes(k), `input1 has 0x${k.toString(16)}`);
  const in0keys = p.inputs[0].map((x) => x.key[0]);
  assert.ok(in0keys.includes(0x01) && in0keys.includes(0x17));
  assert.ok(!in0keys.includes(0x18), "keypath input has no merkle root");
});

test("create validates its inputs", () => {
  const good = C.exampleSpec();
  assert.throws(() => C.createPsbt({ ...good, inputs: [] }), /at least one input/);
  assert.throws(() => C.createPsbt({ ...good, outputs: [] }), /at least one output/);
  const badTxid = { ...good, inputs: [{ ...good.inputs[0], txid: "zz" }] };
  assert.throws(() => C.createPsbt(badTxid), /bad txid/);
  const badKey = { ...good, inputs: [{ ...good.inputs[0], internalKey: "00".repeat(31) }] };
  assert.throws(() => C.createPsbt(badKey), /32-byte/);
  const negFee = {
    ...good,
    outputs: [{ address: good.outputs[0].address, amount: 999999999999n }],
  };
  assert.throws(() => C.createPsbt(negFee), /exceed inputs/);
  const badOpReturn = { ...good, outputs: [{ opReturn: "ff".repeat(81), amount: 0n }] };
  assert.throws(() => C.createPsbt(badOpReturn), /> 80 bytes/);
  const badLocktime = { ...good, locktime: -1 };
  assert.throws(() => C.createPsbt(badLocktime), /uint32/);
});

/* ---------- malformed PSBT rejections ---------- */

test("bad magic rejected", () => {
  const badMagic = C.bytesToBase64(Uint8Array.from([0x70, 0x73, 0x62, 0x74, 0x00])); // "psbt\0"
  assert.throws(() => C.parsePsbtBase64(badMagic), /bad magic/);
  assert.throws(() => C.parsePsbtBase64(C.bytesToBase64(new TextEncoder().encode("xxxx\xff"))), /bad magic/);
});

test("truncated PSBT rejected", () => {
  const full = C.base64ToBytes(C.buildExamplePsbt().base64);
  for (const cut of [5, 10, full.length - 7]) {
    assert.throws(() => C.parsePsbt(full.slice(0, cut)), /truncated|bad magic/, `cut at ${cut}`);
  }
});

test("duplicate map key rejected", () => {
  const p = C.parsePsbtBase64(C.buildExamplePsbt().base64);
  p.inputs[0].push({ ...p.inputs[0][0] }); // duplicate WITNESS_UTXO key
  assert.throws(() => C.parsePsbt(C.serializePsbt(p)), /duplicate key/);
});

test("global count mismatch rejected", () => {
  const p = C.parsePsbtBase64(C.buildExamplePsbt().base64);
  p.globalPairs.push({ key: new Uint8Array([0xfd]), value: new Uint8Array([99]) });
  assert.throws(() => C.parsePsbt(C.serializePsbt(p)), /COUNT mismatch/);
});

test("missing unsigned tx rejected", () => {
  const p = C.parsePsbtBase64(C.buildExamplePsbt().base64);
  p.globalPairs = p.globalPairs.filter((x) => x.key[0] !== 0x00);
  assert.throws(() => C.parsePsbt(C.serializePsbt(p)), /missing PSBT_GLOBAL_UNSIGNED_TX/);
});

test("unknown sighash byte rejected", () => {
  assert.throws(() => C.sighashName(0x05), /unknown sighash/);
  assert.throws(() => C.sighashName(0xff), /unknown sighash/);
  const p = C.parsePsbtBase64(C.buildExamplePsbt().base64);
  const tx = p.unsignedTx, prevouts = C.prevoutsFromPsbt(p);
  assert.throws(() => C.taprootSighash({ tx, inputIndex: 0, prevouts, hashType: 0x05 }), /unknown sighash/);
});

/* ---------- strict bech32m ---------- */

test("bech32m: valid prl1 accepted, others rejected", () => {
  const good = C.xonlyToAddress(prog(7));
  assert.equal(C.validatePrlAddress(good).length, 32);
  // tampered checksum
  const bad = good.slice(0, -1) + (good.endsWith("q") ? "p" : "q");
  assert.throws(() => C.validatePrlAddress(bad), /bad checksum/);
  // wrong hrp (bitcoin)
  assert.throws(() => C.validatePrlAddress(good.replace("prl1", "bc1")), /wrong network/);
  // mixed case
  assert.throws(() => C.validatePrlAddress(good.toUpperCase().slice(0, 10) + good.slice(10)), /mixed case/);
  // non-canonical: a bad address must be rejected by Create
  assert.throws(() => C.createPsbt({
    inputs: C.exampleSpec().inputs.slice(0, 1),
    outputs: [{ address: "prl1junk", amount: 1000n }],
    locktime: 0,
  }), /address|separator|checksum/);
});

/* ---------- grain-exact amounts ---------- */

test("parseGrains is exact", () => {
  assert.equal(C.parseGrains("1"), 1n);
  assert.equal(C.parseGrains("100000000"), 100000000n);
  assert.equal(C.parseGrains("  42 "), 42n);
  assert.equal(C.grainsToPrl(1n), "0.00000001");
  assert.equal(C.grainsToPrl(150000000n), "1.5");
  assert.equal(C.grainsToPrl(100000000n), "1");
  assert.throws(() => C.parseGrains("1.5"), /whole number/);
  assert.throws(() => C.parseGrains("-1"), /whole number/);
  assert.throws(() => C.parseGrains("0"), /> 0/);
  assert.throws(() => C.parseGrains("abc"), /whole number/);
});

/* ---------- script assembler ---------- */

test("asm templates assemble correctly", () => {
  const pk = "11".repeat(32);
  const s1 = C.asmToScript(`<${pk}> OP_CHECKSIG`);
  assert.deepEqual(s1, Uint8Array.from([0x20, ...C.hexToBytes(pk), 0xac]));
  const s2 = C.asmToScript(`500000 OP_CHECKLOCKTIMEVERIFY OP_DROP <${pk}> OP_CHECKSIG`);
  // 500000 = 0x07a120 -> minimal LE [0x20,0xa1,0x07]
  assert.deepEqual(s2.slice(0, 4), Uint8Array.from([0x03, 0x20, 0xa1, 0x07]));
  assert.equal(s2[4], 0xb1); // OP_CHECKLOCKTIMEVERIFY
  assert.equal(s2[5], 0x75); // OP_DROP
  assert.throws(() => C.asmToScript("OP_NOPE"), /unknown token/);
  assert.throws(() => C.asmToScript("<zz>"), /unknown token|bad <hex>/);
  assert.throws(() => C.asmToScript(""), /empty script/);
  // hex input path
  const raw = C.parseLeafScript("ac".repeat(4));
  assert.deepEqual(raw, Uint8Array.from([0xac, 0xac, 0xac, 0xac]));
  // asm round-trip through the disassembler
  const asm = C.scriptToAsm(s2);
  assert.ok(asm.includes("OP_CHECKLOCKTIMEVERIFY") && asm.includes("OP_CHECKSIG"));
  const s2b = C.asmToScript(asm.replace(/<20a107>/, "500000"));
  assert.deepEqual(s2b, s2);
});

test("tapTweak / control block parity", () => {
  const internal = C.schnorr.getPublicKey(C.hexToBytes("03".padStart(64, "0")));
  const k1 = C.tapTweak(internal, null);
  assert.equal(k1.Q.length, 32);
  assert.ok(k1.parity === 0 || k1.parity === 1);
  const cb = C.controlBlockFor(internal, null);
  assert.equal(cb.length, 33);
  assert.equal(cb[0] & 0xfe, 0xc0);
  assert.equal(cb[0] & 0x01, k1.parity);
  assert.deepEqual(cb.slice(1), internal);
  // determinism
  assert.deepEqual(C.tapTweak(internal, null).Q, k1.Q);
});
