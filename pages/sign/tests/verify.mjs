// Pearl Sign verification suite.
// Usage: node --no-warnings --loader tests/loader.mjs tests/verify.mjs
// (run from the sign directory)
//
// Covers: BIP-86 derivation known-answer vectors, bech32m round-trip,
// keypath tx build -> decode round-trip, local signature verification
// (DEFAULT + SINGLE|ANYONECANPAY), tamper detection, fee math, coin
// selection, amount parsing, UTXO list parsing, spk description.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  NETWORKS, GRAIN_PER_PRL, DUST_GRAIN,
  encodeBech32m, decodeBech32m, bytesToHex, hexToBytes,
  tweakKeypath, tweakPrivKeypath, p2trScriptPubKey,
  keypathTxVBytes,
  newMnemonic, walletFromMnemonic, walletFromWIF, walletToWIF,
} from "../src/crypto.js";

import {
  SIGHASH_DEFAULT, SIGHASH_SINGLE_ANYONECANPAY,
  fmtPRL, parsePRL,
  decodeRawTx, describeSpk,
  buildKeypathTxEx, verifySignedTx,
  selectCoins, parseUtxoList,
} from "../src/sign-core.js";

const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const VEC = {
  mainnet: {
    addr0: "prl1pr6yuq8u2r95wjzzgpdy8cpnncpl7l8zgy6x5q0367pnc53s2famqg7pt74",
    addr5: "prl1pe39xcj4w8p0w5hj80p053sr0s6qggkw2hzts424yu9vjce4q84fs4cy3fq",
    wif0: "L3g2TjAyBKhpG2qBb2m739hy3qvSgeD1C6HeMnXM9AQbZgSit17a",
  },
  testnet: {
    addr0: "tprl1p8wpt9v4frpf3tkn0srd97pksgsxc5hs52lafxwru9kgeephvs7rqm5v93u",
  },
};

test("derivation known-answer vectors (BIP-86, m/86'/coin'/0'/0/i)", () => {
  const m0 = walletFromMnemonic(MNEMONIC, NETWORKS.mainnet, 0, 0);
  assert.equal(m0.address, VEC.mainnet.addr0);
  const m5 = walletFromMnemonic(MNEMONIC, NETWORKS.mainnet, 0, 5);
  assert.equal(m5.address, VEC.mainnet.addr5);
  const t0 = walletFromMnemonic(MNEMONIC, NETWORKS.testnet, 0, 0);
  assert.equal(t0.address, VEC.testnet.addr0);
  assert.ok(t0.address.startsWith("tprl1p"));
});

test("WIF round-trip on the known key", () => {
  const w = walletFromMnemonic(MNEMONIC, NETWORKS.mainnet, 0, 0);
  assert.equal(walletToWIF(w.priv, NETWORKS.mainnet), VEC.mainnet.wif0);
  const back = walletFromWIF(VEC.mainnet.wif0, NETWORKS.mainnet);
  assert.equal(back.address, VEC.mainnet.addr0);
  assert.throws(() => walletFromWIF(VEC.mainnet.wif0, NETWORKS.testnet), /wrong WIF network version/);
});

test("bech32m decode round-trip + strictness", () => {
  const d = decodeBech32m(VEC.mainnet.addr0, "prl");
  assert.equal(d.version, 1);
  assert.equal(d.program.length, 32);
  assert.equal(encodeBech32m("prl", 1, d.program), VEC.mainnet.addr0);
  assert.throws(() => decodeBech32m(VEC.mainnet.addr0, "tprl"), /wrong network/);
  assert.throws(() => decodeBech32m("prl1q" + "0".repeat(52)), /bad checksum|only witness v1/);
  assert.throws(() => newMnemonic && walletFromMnemonic("abandon abandon", NETWORKS.mainnet), /invalid BIP-39/);
});

function fixtureTx(network, hashType = SIGHASH_DEFAULT) {
  // Two inputs from the known key (idx 0), one recipient (idx 5), change to idx 1.
  const w0 = walletFromMnemonic(MNEMONIC, network, 0, 0);
  const w1 = walletFromMnemonic(MNEMONIC, network, 0, 1);
  const w5 = walletFromMnemonic(MNEMONIC, network, 0, 5);
  const spk0 = p2trScriptPubKey(tweakKeypath(w0.internalXOnly).tweakedX);
  const inputs = [
    { txid: "aa".repeat(32), vout: 0, value: 100_000_000, spk: spk0, priv: w0.priv, internalXOnly: w0.internalXOnly },
    { txid: "bb".repeat(32), vout: 3, value: 50_000_000, spk: spk0, priv: w0.priv, internalXOnly: w0.internalXOnly },
  ];
  const p5 = decodeBech32m(w5.address, network.hrp).program;
  const p1 = decodeBech32m(w1.address, network.hrp).program;
  const outputs = [
    { program: p5, value: 120_000_000 },
    { program: p1, value: 29_900_000 }, // 100k grains fee
  ];
  const built = buildKeypathTxEx(network, inputs, outputs, hashType);
  return { network, inputs, outputs, built, prevouts: inputs.map((i) => ({ value: i.value, spk: i.spk })) };
}

test("build -> decode round-trip, txid agreement", () => {
  const { built } = fixtureTx(NETWORKS.mainnet);
  const dec = decodeRawTx(built.hex);
  assert.equal(dec.txid, built.txid);
  assert.equal(dec.version, 1);
  assert.equal(dec.inputs.length, 2);
  assert.equal(dec.inputs[0].txid, "aa".repeat(32));
  assert.equal(dec.inputs[1].vout, 3);
  assert.equal(dec.outputs.length, 2);
  assert.equal(dec.outputs[0].value, 120_000_000n);
  assert.equal(dec.witness.length, 2);
  assert.equal(dec.witness[0].length, 1);
  assert.equal(dec.witness[0][0].length, 64); // SIGHASH_DEFAULT: no type byte
});

test("local signature verification passes for both inputs (DEFAULT)", () => {
  const { network, built, prevouts } = fixtureTx(NETWORKS.mainnet);
  const res = verifySignedTx(network, built.hex, prevouts);
  assert.equal(res.length, 2);
  for (const r of res) assert.ok(r.ok, `input ${r.index}: ${r.reason}`);
});

test("SINGLE|ANYONECANPAY presign signs and verifies", () => {
  const { network, built, prevouts } = fixtureTx(NETWORKS.mainnet, SIGHASH_SINGLE_ANYONECANPAY);
  const dec = decodeRawTx(built.hex);
  assert.equal(dec.witness[0][0].length, 65);
  assert.equal(dec.witness[0][0][64], 0x83);
  const res = verifySignedTx(network, built.hex, prevouts);
  for (const r of res) assert.ok(r.ok, `input ${r.index}: ${r.reason}`);
});

test("tampered prevout value fails verification (DEFAULT commits all amounts)", () => {
  const { network, built, prevouts } = fixtureTx(NETWORKS.mainnet);
  const bad = prevouts.map((p, i) => (i === 0 ? { ...p, value: p.value + 1 } : p));
  const res = verifySignedTx(network, built.hex, bad);
  // SIGHASH_DEFAULT commits to sha_amounts over ALL inputs, so both fail.
  for (const r of res) assert.equal(r.ok, false);
});

test("tampered prevout value fails only that input under SINGLE|ANYONECANPAY", () => {
  const { network, built, prevouts } = fixtureTx(NETWORKS.mainnet, SIGHASH_SINGLE_ANYONECANPAY);
  const bad = prevouts.map((p, i) => (i === 0 ? { ...p, value: p.value + 1 } : p));
  const res = verifySignedTx(network, built.hex, bad);
  assert.equal(res[0].ok, false);
  assert.equal(res[1].ok, true); // ACP commits only the input's own prevout
});

test("same spk decodes to the other network's address under the wrong network", () => {
  const { network, prevouts } = fixtureTx(NETWORKS.mainnet);
  const d = describeSpk(prevouts[0].spk, NETWORKS.testnet);
  assert.equal(d.type, "P2TR");
  assert.ok(d.address.startsWith("tprl1p"), d.address);
  assert.notEqual(d.address, describeSpk(prevouts[0].spk, network).address);
});

test("decodeRawTx rejects garbage", () => {
  assert.throws(() => decodeRawTx("zz"), /not hex/);
  assert.throws(() => decodeRawTx("aabbcc"), /truncated|bad input/);
  const { built } = fixtureTx(NETWORKS.mainnet);
  assert.throws(() => decodeRawTx(built.hex + "00"), /trailing bytes/);
});

test("fee math matches the audited pearlpurse formula", () => {
  // base = 4+1+41 + 1+86+4 = 137; weight = 4*137 + 2 + 66 = 616; ceil = 154
  assert.equal(keypathTxVBytes(1, 2), 154);
  assert.equal(keypathTxVBytes(2, 2), 4 + 1 + 82 + 1 + 86 + 4 + Math.ceil(2 / 4) + 33); // 211
  assert.throws(() => keypathTxVBytes(0, 1), /positive integer/);
});

test("coin selection covers target + exact fee, dust goes to fee", () => {
  const utxos = [{ txid: "cc".repeat(32), vout: 0, value: 100_000_000 }];
  const r = selectCoins(utxos, 50_000_000n, 10, 1);
  const fee = BigInt(Math.ceil(keypathTxVBytes(1, 2) * 10));
  assert.equal(r.fee, fee);
  assert.equal(r.change, 100_000_000n - 50_000_000n - fee);
  // Dust change -> no change output, remainder becomes fee
  const tiny = selectCoins([{ txid: "dd".repeat(32), vout: 0, value: 50_000_000 + 1540 + 100 }], 50_000_000n, 10, 1);
  assert.equal(tiny.change, 0n);
  assert.throws(() => selectCoins(utxos, 200_000_000n, 10, 1), /insufficient funds/);
});

test("PRL amount parse/format round-trip", () => {
  assert.equal(parsePRL("1.5"), 150_000_000n);
  assert.equal(parsePRL("0.00000001"), 1n);
  assert.equal(parsePRL("2100000000"), 2100000000n * BigInt(GRAIN_PER_PRL));
  assert.equal(fmtPRL(150_000_000n), "1.5");
  assert.equal(fmtPRL(1n), "0.00000001");
  assert.equal(fmtPRL(0n), "0");
  assert.equal(fmtPRL(parsePRL("123.45678901")), "123.45678901");
  assert.throws(() => parsePRL("1.123456789"), /invalid/);
  assert.throws(() => parsePRL("abc"), /invalid/);
  assert.throws(() => parsePRL("-1"), /invalid/);
});

test("UTXO list parsing", () => {
  const list = parseUtxoList("# comment\n" + "aa".repeat(32) + ":0 100000000\n" + "bb".repeat(32) + ":3 1.5 prl");
  assert.equal(list.length, 2);
  assert.equal(list[0].value, 100_000_000);
  assert.equal(list[1].value, 150_000_000);
  assert.throws(() => parseUtxoList("nope"), /bad UTXO line/);
});

test("describeSpk identifies P2TR and recovers the address", () => {
  const w = walletFromMnemonic(MNEMONIC, NETWORKS.mainnet, 0, 0);
  const spk = p2trScriptPubKey(tweakKeypath(w.internalXOnly).tweakedX);
  const d = describeSpk(spk, NETWORKS.mainnet);
  assert.equal(d.type, "P2TR");
  assert.equal(d.address, w.address);
});

test("UTXO list with optional address decodes spk", async () => {
  const { parseUtxoList } = await import("../src/sign-core.js");
  const line = "aa".repeat(32) + ":0 1.5 prl " + VEC.mainnet.addr0;
  const [u] = parseUtxoList(line, NETWORKS.mainnet);
  assert.equal(u.value, 150_000_000);
  assert.ok(u.spk instanceof Uint8Array && u.spk.length === 34);
  const { describeSpk } = await import("../src/sign-core.js");
  assert.equal(describeSpk(u.spk, NETWORKS.mainnet).address, VEC.mainnet.addr0);
  assert.throws(() => parseUtxoList(line), /network needed/);
});

test("RPC helpers distinguish unreachable endpoints from rejections", async () => {
  const core = await import("../src/sign-core.js");
  await assert.rejects(
    () => core.fetchUtxos("http://127.0.0.1:1", "prl1pabc"),
    /unreachable/
  );
  await assert.rejects(
    () => core.broadcastViaBlockbook("http://127.0.0.1:1", "00"),
    /unreachable/
  );
  await assert.rejects(
    () => core.pearldRpc("http://127.0.0.1:1", "u", "p", "getblockcount"),
    /unreachable/
  );
});

// ------------------------------------------------- XSS hardening (app.js)
// Regression pins for the 2026-10-04 fleet XSS audit latent queue:
// renderSigResults interpolates r.reason into innerHTML; one reason path
// passes a caught error message through from verifying pasted tx data.
test("signature results escape r.reason before innerHTML", () => {
  const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(app, /function esc\(s\)/);
  assert.ok(app.includes("${esc(r.reason)}"), "reason escaped");
  assert.ok(!app.includes("— ${r.reason}"), "no raw reason interpolation remains");
  assert.ok(html.includes('app.js?v=5'), "cache key bumped");
});
