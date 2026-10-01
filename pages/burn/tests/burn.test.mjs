// Pearl Burn core tests — deterministic vectors, tamper regressions,
// domain separation, exact fee math. Usage:
//   node --no-warnings --loader ./tests/loader.mjs tests/burn.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import * as B from "../src/burn-core.js";
import { numsInternalKeyWill } from "../../will/src/will-core.js";

const TAG = "pearl-genesis-burn";
const PIN_INTERNAL = "00e03e501a56fc062929fe90fd449e0024190a63350c4bdc8b93cbf5e2fd2689";
const PIN_OUTPUT = "56bf9388dbc33b8449f91c55a08f56acab47e1f06022d5169f32620b58a68480";
const PIN_ADDR = "prl1p26le8zxmcvacgj0er326pr6k4j450c0svq3d295lxf3qkk9xsjqq69l057";
const PIN_SEAL = "pearl-burn:v1:prl:cb7946dc695c90a005ab5ed3a5b2b0efcab22c1857e3607afd2941fd0a87d04b";

test("pinned vector: tag -> NUMS internal key -> tweaked output key -> address", () => {
  const b = B.burnAddressForTag(TAG, "mainnet");
  assert.equal(b.internalKeyHex, PIN_INTERNAL);
  assert.equal(b.outputKeyHex, PIN_OUTPUT);
  assert.equal(b.address, PIN_ADDR);
  assert.equal(b.hrp, "prl");
  assert.equal(b.tag, TAG);
});

test("determinism: same tag -> same address; different tag -> different address", () => {
  const a1 = B.burnAddressForTag(TAG).address;
  const a2 = B.burnAddressForTag("  pearl-genesis-burn  ").address; // whitespace trimmed
  assert.equal(a1, a2);
  const a3 = B.burnAddressForTag("pearl-genesis-burn-2").address;
  assert.notEqual(a1, a3);
  assert.ok(a3.startsWith("prl1p"));
});

test("testnet uses tprl hrp", () => {
  const b = B.burnAddressForTag(TAG, "testnet");
  assert.ok(b.address.startsWith("tprl1p"));
  assert.notEqual(b.address, PIN_ADDR);
});

test("NUMS domain separation: Burn domain is distinct from Will and Escrow domains", () => {
  assert.equal(B.NUMS_DOMAIN, "PearlBurnNUMS/v1");
  assert.notEqual(B.NUMS_DOMAIN, "PearlWillNUMS/v1");
  assert.notEqual(B.NUMS_DOMAIN, "PearlEscrowNUMS/v1");
  // Functional: the Burn NUMS key for a tag can never collide with a Will
  // NUMS key (different preimage construction entirely).
  const burnKey = B.numsBurnKey("separation-probe");
  const leafO = B.hexToBytes("c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5");
  const leafH = B.hexToBytes("f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9");
  const willKey = numsInternalKeyWill(leafO, leafH);
  assert.notEqual(B.bytesToHex(burnKey), B.bytesToHex(willKey));
});

test("tag validation refuses empty / control / oversize tags", () => {
  assert.throws(() => B.burnAddressForTag("   "), /empty/);
  assert.throws(() => B.burnAddressForTag("bad\ntag"), /control/);
  assert.throws(() => B.burnAddressForTag("x".repeat(65)), /64 bytes/);
  assert.doesNotThrow(() => B.burnAddressForTag("x".repeat(64)));
});

test("pinned certificate seal", () => {
  const cert = B.formatCertificate({ tag: TAG, networkId: "mainnet", amountGrains: 100000000, txid: "pending" });
  assert.ok(cert.includes(`seal: ${PIN_SEAL}`), "seal must match pinned value");
  assert.ok(cert.includes(`address: ${PIN_ADDR}`));
  const r = B.verifyBurnSeal(cert);
  assert.equal(r.verdict, "PROVEN");
  assert.deepEqual(r.reasons, []);
});

test("certificate with real txid verifies PROVEN", () => {
  const txid = "a".repeat(64);
  const cert = B.formatCertificate({ tag: TAG, networkId: "mainnet", amountGrains: 546, txid });
  const r = B.verifyBurnSeal(cert);
  assert.equal(r.verdict, "PROVEN");
});

test("tamper regressions: any field change -> NOT PROVEN", () => {
  const cert = B.formatCertificate({ tag: TAG, networkId: "mainnet", amountGrains: 100000000, txid: "pending" });
  const tampered = [
    cert.replace("prl1p26le8zxmcvacgj0er326", "prl1p26me8zxmcvacgj0er326"),
    cert.replace("amount_grains: 100000000", "amount_grains: 100000001"),
    cert.replace("txid: pending", "txid: " + "b".repeat(64)),
    cert.replace("tag: pearl-genesis-burn", "tag: pearl-genesis-burn!"),
    cert.replace(PIN_SEAL, PIN_SEAL.replace(/.$/, PIN_SEAL.endsWith("0") ? "1" : "0")),
  ];
  for (const t of tampered) {
    const r = B.verifyBurnSeal(t);
    assert.equal(r.verdict, "NOT PROVEN", "tampered cert must NOT verify");
    assert.ok(r.reasons.length > 0);
  }
});

test("malformed certificates -> NOT PROVEN", () => {
  assert.equal(B.verifyBurnSeal("hello").verdict, "NOT PROVEN");
  assert.equal(B.verifyBurnSeal("").verdict, "NOT PROVEN");
  const cert = B.formatCertificate({ tag: TAG, networkId: "mainnet", amountGrains: 1000, txid: "pending" });
  const noSeal = cert.split("\n").filter((l) => !l.startsWith("seal:")).join("\n");
  assert.equal(B.verifyBurnSeal(noSeal).verdict, "NOT PROVEN");
});

test("burnVBytes: exact P2TR keypath sizes", () => {
  assert.equal(B.burnVBytes(2), 154);
  assert.equal(B.burnVBytes(1), 111);
  assert.throws(() => B.burnVBytes(0), /bad output count/);
});

const UTXO = { txid: "c".repeat(64), vout: 0, value: 100000000 };
const CHANGE = B.burnAddressForTag("burn-change-probe").address;

test("planBurnTx: exact fee math, 2 outputs", () => {
  const p = B.planBurnTx({
    networkId: "mainnet", utxo: UTXO, burnAddress: PIN_ADDR,
    amountGrains: 50000000, changeAddress: CHANGE, feeRateGrainsPerVByte: 10,
  });
  assert.equal(p.vBytes, 154);
  assert.equal(p.feeGrains, 1540);
  assert.equal(p.burnGrains, 50000000);
  assert.equal(p.changeGrains, 100000000 - 50000000 - 1540);
  assert.equal(p.outputs.length, 2);
  assert.equal(p.outputs[0].kind, "burn");
  assert.equal(p.outputs[1].kind, "change");
  assert.ok(/^[0-9a-f]+$/.test(p.unsignedHex));
});

test("planBurnTx: unsigned hex re-verifies from its decoded bytes", () => {
  const p = B.planBurnTx({
    networkId: "mainnet", utxo: UTXO, burnAddress: PIN_ADDR,
    amountGrains: 50000000, changeAddress: CHANGE, feeRateGrainsPerVByte: 10,
  });
  const dec = B.decodeRawTx(p.unsignedHex);
  assert.equal(dec.inputs.length, 1);
  assert.equal(dec.inputs[0].txid, UTXO.txid);
  assert.equal(dec.outputs.length, 2);
  assert.equal(dec.outputs[0].value, 50000000n);
  assert.equal(dec.outputs[1].value, BigInt(p.changeGrains));
});

test("planBurnTx: exact-fit single output (change folds into fee)", () => {
  // value = burn + 1540 (the 2-output fee) -> change2 == 0 -> 1 output
  const p = B.planBurnTx({
    networkId: "mainnet",
    utxo: { txid: "d".repeat(64), vout: 1, value: 50000000 + 1540 },
    burnAddress: PIN_ADDR, amountGrains: 50000000,
    changeAddress: CHANGE, feeRateGrainsPerVByte: 10,
  });
  assert.equal(p.outputs.length, 1);
  assert.equal(p.changeGrains, 0);
  assert.equal(p.feeGrains, 1540);
  assert.equal(p.vBytes, 111);
});

test("planBurnTx refusals: dust burn, overspend, dust change", () => {
  assert.throws(() => B.planBurnTx({
    networkId: "mainnet", utxo: UTXO, burnAddress: PIN_ADDR,
    amountGrains: 545, changeAddress: CHANGE, feeRateGrainsPerVByte: 10,
  }), /dust floor/);
  assert.throws(() => B.planBurnTx({
    networkId: "mainnet", utxo: UTXO, burnAddress: PIN_ADDR,
    amountGrains: 99999999, changeAddress: CHANGE, feeRateGrainsPerVByte: 10,
  }), /exceeds the input/);
  // change would be 100 grains -> dust refusal
  assert.throws(() => B.planBurnTx({
    networkId: "mainnet", utxo: UTXO, burnAddress: PIN_ADDR,
    amountGrains: 100000000 - 1540 - 100, changeAddress: CHANGE, feeRateGrainsPerVByte: 10,
  }), /dust floor/);
  // wrong-hrp burn address refused
  assert.throws(() => B.planBurnTx({
    networkId: "mainnet", utxo: UTXO,
    burnAddress: B.burnAddressForTag(TAG, "testnet").address,
    amountGrains: 50000000, changeAddress: CHANGE, feeRateGrainsPerVByte: 10,
  }), /wrong network HRP/);
});

test("reverifyUnsignedBurnHex catches a tampered output", () => {
  const p = B.planBurnTx({
    networkId: "mainnet", utxo: UTXO, burnAddress: PIN_ADDR,
    amountGrains: 50000000, changeAddress: CHANGE, feeRateGrainsPerVByte: 10,
  });
  const ok = B.reverifyUnsignedBurnHex(p.unsignedHex, {
    burnProgramHex: p.outputs[0].program, burnGrains: 50000000,
    changeProgramHex: p.outputs[1].program, changeGrains: p.changeGrains,
    feeGrains: p.feeGrains, inputValue: UTXO.value,
  });
  assert.ok(ok.ok);
  const bad = B.reverifyUnsignedBurnHex(p.unsignedHex, {
    burnProgramHex: p.outputs[0].program, burnGrains: 50000001,
    changeProgramHex: p.outputs[1].program, changeGrains: p.changeGrains,
    feeGrains: p.feeGrains, inputValue: UTXO.value,
  });
  assert.ok(!bad.ok);
});

test("PRL <-> grains conversions", () => {
  assert.equal(B.prlToGrains("1"), 100000000);
  assert.equal(B.prlToGrains("1.5"), 150000000);
  assert.equal(B.prlToGrains("0.00000546"), 546);
  assert.equal(B.grainsToPRL(150000000), "1.5");
  assert.equal(B.grainsToPRL(546), "0.00000546");
  assert.throws(() => B.prlToGrains("1.123456789"), /max 8 decimals/);
  assert.throws(() => B.prlToGrains("-1"), /must look like/);
});
