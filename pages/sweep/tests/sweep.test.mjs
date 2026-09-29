// Pearl Sweep verification suite.
// Run: node --no-warnings --loader ./tests/loader.mjs tests/sweep.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseSweepAddress,
  parseFeeRate,
  feeForVBytes,
  formatRateMp,
  formatGrains,
  classifyUtxos,
  summarizeUtxos,
  futureSavingsGrains,
  planSweep,
  parseSweepKey,
  buildSweepTx,
  comparePostSweep,
  verifyConsolidationTx,
  fetchSweepUtxos,
  fetchFeeRateMp,
  broadcastSweepTx,
  decodeRawTx,
  INPUT_VBYTES,
  OUTPUT_VBYTES,
  SOLO_SPEND_VBYTES,
  DUST_GRAIN,
  GRAIN_PER_PRL,
  NETWORKS,
  walletFromPriv,
  walletToWIF,
  encodeBech32m,
  keypathTxVBytes,
  verifySignedTx,
  hexToBytes,
  bytesToHex,
} from "../src/sweep-core.js";
import { HDKey } from "@scure/bip32";

/* deterministic fixture key: 0x0f0f…0f (32 bytes) */
const PRIV_HEX = "0f".repeat(32);
const NET = NETWORKS.mainnet;
const W = walletFromPriv(PRIV_HEX, NET);
const ADDR = W.address; // prl1… address controlled by the fixture key
const PROGRAM = (() => {
  const p = parseSweepAddress(ADDR);
  assert.ok(!p.error, p.error);
  return p.program;
})();
const TNET_W = walletFromPriv(PRIV_HEX, NETWORKS.testnet);

function utxo(i, value, confirmations = 6) {
  return { txid: i.toString(16).padStart(64, "a"), vout: i, value, confirmations };
}

/* ---------- address parsing ---------- */

test("parseSweepAddress accepts prl1 and tprl1, rejects junk", () => {
  const a = parseSweepAddress("  " + ADDR + " ");
  assert.equal(a.error, undefined);
  assert.equal(a.address, ADDR.toLowerCase());
  assert.equal(a.network.hrp, "prl");
  assert.equal(a.program.length, 32);

  const t = parseSweepAddress(TNET_W.address);
  assert.equal(t.error, undefined);
  assert.equal(t.network.hrp, "tprl");

  assert.match(parseSweepAddress("").error, /Paste a prl1/);
  assert.match(parseSweepAddress("not an address").error, /Not a valid/);
  // wrong checksum
  const bad = ADDR.slice(0, -1) + (ADDR.endsWith("q") ? "p" : "q");
  assert.match(parseSweepAddress(bad).error, /Not a valid/);
  // non-Pearl network: valid bech32m with a foreign hrp
  assert.match(
    parseSweepAddress(encodeBech32m("bc", 1, PROGRAM)).error,
    /only handles prl1/
  );
  // mixed case rejected
  assert.match(parseSweepAddress(ADDR.toUpperCase().slice(0, 10) + ADDR.slice(10)).error, /Not a valid/);
});

/* ---------- fee rate ---------- */

test("parseFeeRate: decimals to milliGrains, rejects junk", () => {
  assert.equal(parseFeeRate("1").rateMp, 1000n);
  assert.equal(parseFeeRate("1.5").rateMp, 1500n);
  assert.equal(parseFeeRate("0.001").rateMp, 1n);
  assert.equal(parseFeeRate("12.345").rateMp, 12345n);
  assert.ok(parseFeeRate("0").error);
  assert.ok(parseFeeRate("-2").error);
  assert.ok(parseFeeRate("abc").error);
  assert.ok(parseFeeRate("1.2345").error); // >3 decimals
  assert.ok(parseFeeRate("99999").error); // absurd
  assert.equal(formatRateMp(1500n), "1.5");
  assert.equal(formatRateMp(1000n), "1");
  assert.equal(formatRateMp(1n), "0.001");
});

test("fee math constants: 58 vB/input, 43 vB/output, 111 vB solo", () => {
  assert.equal(INPUT_VBYTES, 58);
  assert.equal(OUTPUT_VBYTES, 43);
  assert.equal(SOLO_SPEND_VBYTES, 111);
  // ceil: 169 vB * 1.5 gr/vB = 253.5 -> 254
  assert.equal(feeForVBytes(169, 1500n), 254n);
  assert.equal(feeForVBytes(169, 1000n), 169n);
});

/* ---------- classification ---------- */

test("classifyUtxos: dust / uneconomic / healthy at a fixed rate", () => {
  const rateMp = 10000n; // 10 grains/vB -> solo cost 1110, marginal 580
  const cs = classifyUtxos(
    [utxo(1, 100n), utxo(2, 600n), utxo(3, 100000n)],
    rateMp
  );
  assert.equal(cs[0].dust, true);
  assert.equal(cs[0].uneconomic, false);
  assert.equal(cs[1].dust, false);
  assert.equal(cs[1].uneconomic, true); // 600 < 1110
  assert.equal(cs[2].healthy, true);
  assert.equal(cs[0].netNegative, true); // 100 < 580 marginal
  assert.equal(cs[2].netNegative, false);
  const s = summarizeUtxos(cs);
  assert.equal(s.count, 3);
  assert.equal(s.total, 100700n);
  assert.equal(s.dustCount, 1);
  assert.equal(s.dustValue, 100n);
  assert.equal(s.uneconomicCount, 1);
  assert.equal(s.healthyCount, 1);
  assert.equal(s.buckets[0].count, 1); // 100 -> dust bucket
  assert.equal(s.buckets[0].value, 100n);
  assert.equal(s.buckets[1].count, 1); // 600 -> 546–999
  assert.equal(s.buckets[1].value, 600n);
});

test("futureSavingsGrains: (n-1) marginal inputs", () => {
  assert.equal(futureSavingsGrains(1, 1000n), 0n);
  assert.equal(futureSavingsGrains(8, 1000n), 58n * 7n);
  assert.equal(formatGrains(58n * 7n), "0.00000406");
});

/* ---------- planning ---------- */

function classifiedFixture() {
  // At 20 grains/vB: solo-spend cost 2220, marginal input cost 1160.
  // dust: 100, 400 | uneconomic: 2000, 2100, 2150, 2200 (all < 2220, all > 1160)
  // healthy: 50000, 200000
  const rateMp = 20000n;
  const vals = [100n, 400n, 2000n, 2100n, 2150n, 2200n, 50000n, 200000n];
  return { cs: classifyUtxos(vals.map((v, i) => utxo(i + 1, v)), rateMp), rateMp };
}

test("planSweep: uneconomic strategy sweeps only dust+uneconomic, exact fee math", () => {
  const { cs, rateMp } = classifiedFixture();
  const plan = planSweep({
    classified: cs, strategy: "uneconomic", nOutputs: 1,
    targetProgram: PROGRAM, rateMp, network: NET,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.refused, false);
  assert.equal(plan.inputs.length, 6); // 100 + 400 + 2000 + 2100 + 2150 + 2200
  assert.equal(plan.total, 8950n);
  assert.equal(plan.vBytes, keypathTxVBytes(6, 1));
  assert.equal(plan.fee, feeForVBytes(plan.vBytes, rateMp));
  assert.equal(plan.netValue, plan.total - plan.fee);
  assert.equal(plan.outputs.length, 1);
  assert.equal(plan.outputs[0].value, plan.netValue);
  assert.equal(plan.targetAddress, ADDR.toLowerCase());
  // 100 and 400 are net-negative inclusions -> warning
  assert.ok(plan.warnings.some((w) => /cost.*more to include/.test(w)), plan.warnings.join(" | "));
});

test("planSweep: threshold strategy selects under-threshold only", () => {
  const { cs, rateMp } = classifiedFixture();
  const plan = planSweep({
    classified: cs, strategy: "threshold", thresholdGrains: 3000n, nOutputs: 1,
    targetProgram: PROGRAM, rateMp, network: NET,
  });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.inputs.map((u) => u.value), [100n, 400n, 2000n, 2100n, 2150n, 2200n]);
});

test("planSweep: all strategy with 2 outputs splits evenly, remainder to fee", () => {
  const { cs, rateMp } = classifiedFixture();
  const plan = planSweep({
    classified: cs, strategy: "all", nOutputs: 2,
    targetProgram: PROGRAM, rateMp, network: NET,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.inputs.length, 8);
  assert.equal(plan.outputs.length, 2);
  const net = plan.total - plan.fee;
  assert.equal(plan.outputs[0].value, net / 2n);
  assert.equal(plan.outputs[1].value, net / 2n);
  assert.equal(plan.outputs[0].value + plan.outputs[1].value + plan.fee + plan.feeRemainder, plan.total);
});

test("planSweep: LOUD refusal when fee >= recovered value, math shown", () => {
  const { cs } = classifiedFixture();
  const plan = planSweep({
    classified: cs, strategy: "uneconomic", nOutputs: 1,
    targetProgram: PROGRAM, rateMp: 10_000_000n, network: NET, // 10000 gr/vB
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.refused, true);
  assert.match(plan.refusal, /REFUSED/);
  assert.match(plan.refusal, /Fee .* ≥ swept value/);
  assert.match(plan.refusal, /vB × .* grains\/vB/);
});

test("planSweep: refusal on dust output and on empty selection", () => {
  const { cs, rateMp } = classifiedFixture();
  // 3 inputs at 10000 gr/vB: fee = 227*10000 = 2,270,000 >> 1400 -> fee refusal already
  const dustCase = planSweep({
    classified: classifyUtxos([utxo(9, 500n)], 1000n), strategy: "uneconomic",
    nOutputs: 1, targetProgram: PROGRAM, rateMp: 1000n, network: NET,
  });
  // 500 is dust; 500 - 111 = 389 < 546 dust floor -> dust-output refusal
  assert.equal(dustCase.refused, true);
  assert.match(dustCase.refusal, /dust output/i);

  const empty = planSweep({
    classified: classifyUtxos([utxo(4, 50000n)], rateMp), strategy: "uneconomic",
    nOutputs: 1, targetProgram: PROGRAM, rateMp, network: NET,
  });
  assert.equal(empty.refused, true);
  assert.match(empty.refusal, /selected 0 UTXOs/);
});

/* ---------- key parsing & signing ---------- */

test("parseSweepKey: WIF, xprv, hex all accepted; junk refused", () => {
  const wif = walletToWIF(hexToBytes(PRIV_HEX), NET);
  const wk = parseSweepKey(wif, NET);
  assert.equal(wk.error, undefined);
  assert.equal(wk.kind, "wif");
  assert.equal(wk.wallet.address, ADDR);

  const seed = new Uint8Array(64).fill(7);
  const root = HDKey.fromMasterSeed(seed);
  const xprv = root.toJSON().xpriv;
  const xk = parseSweepKey(xprv, NET);
  assert.equal(xk.error, undefined);
  assert.equal(xk.kind, "xprv");
  assert.equal(xk.wallet.priv.length, 32);

  const hk = parseSweepKey(PRIV_HEX, NET);
  assert.equal(hk.kind, "hex");
  assert.equal(hk.wallet.address, ADDR);

  assert.ok(parseSweepKey("garbage!!", NET).error);
  assert.ok(parseSweepKey("", NET).error);
});

test("buildSweepTx: signs real consolidation, every signature re-verified", () => {
  const wif = walletToWIF(hexToBytes(PRIV_HEX), NET);
  const { cs, rateMp } = classifiedFixture();
  const plan = planSweep({
    classified: cs, strategy: "all", nOutputs: 1,
    targetProgram: PROGRAM, rateMp, network: NET,
  });
  const signed = buildSweepTx({ network: NET, sweptAddress: ADDR, secretText: wif, plan });
  assert.equal(signed.checks.length, 8);
  assert.ok(signed.checks.every((c) => c.ok), JSON.stringify(signed.checks));
  assert.match(signed.txid, /^[0-9a-f]{64}$/);
  assert.ok(signed.hex.length > 100);
  // txid matches an independent raw decode of the produced hex
  const dec = decodeRawTx(signed.hex);
  assert.equal(dec.txid, signed.txid);
  assert.equal(dec.inputs.length, 8);
  assert.equal(dec.outputs.length, 1);
  assert.equal(dec.outputs[0].value, plan.outputs[0].value);
});

test("buildSweepTx: independent re-verification of the signed bytes", async () => {
  const wif = walletToWIF(hexToBytes(PRIV_HEX), NET);
  const { cs, rateMp } = classifiedFixture();
  const plan = planSweep({
    classified: cs, strategy: "all", nOutputs: 1,
    targetProgram: PROGRAM, rateMp, network: NET,
  });
  assert.equal(plan.ok, true);
  const signed = buildSweepTx({ network: NET, sweptAddress: ADDR, secretText: wif, plan });
  // verifySignedTx straight from the audited core on the raw hex
  const { p2trScriptPubKey: p2tr, tweakKeypath: tk } = await import("../../sign/src/crypto.js");
  const w = walletFromPriv(PRIV_HEX, NET);
  const spk = p2tr(tk(w.internalXOnly).tweakedX);
  const prevouts = plan.inputs.map((u) => ({ value: Number(u.value), spk }));
  const re = verifySignedTx(NET, signed.hex, prevouts);
  assert.ok(re.every((c) => c.ok));
  // tamper one output byte -> verification must fail
  const bytes = hexToBytes(signed.hex);
  const off = 4 + 2 + 1 + 41; // version + marker/flag + in-count + one input
  bytes[off] ^= 0x01; // flip a bit in output #0 value
  const tampered = bytesToHex(bytes);
  const re2 = verifySignedTx(NET, tampered, prevouts);
  assert.ok(re2.some((c) => !c.ok), "tampered tx must fail verification");
});

test("buildSweepTx: LOUD refusal when the key does not control the swept address", () => {
  const other = walletToWIF(hexToBytes("ab".repeat(32)), NET);
  const cs = classifyUtxos([utxo(1, 100n), utxo(2, 400n), utxo(3, 900n)], 1000n);
  const plan = planSweep({
    classified: cs, strategy: "all", nOutputs: 1,
    targetProgram: PROGRAM, rateMp: 1000n, network: NET,
  });
  assert.equal(plan.ok, true); // sane plan so the key check is what fires
  assert.throws(
    () => buildSweepTx({ network: NET, sweptAddress: ADDR, secretText: other, plan }),
    /KEY DOES NOT CONTROL THIS ADDRESS/
  );
});

/* ---------- verify step ---------- */

test("comparePostSweep: exact balance + count drop proves consolidation", () => {
  const preTotal = 251400n, fee = 2270n;
  const ok = comparePostSweep({
    preCount: 5, preTotal, fee,
    postUtxos: [{ txid: "b".repeat(64), vout: 0, value: preTotal - fee }],
    targetAddress: ADDR,
  });
  assert.equal(ok.ok, true);
  assert.match(ok.verdict, /CONSOLIDATION VERIFIED/);

  const badBalance = comparePostSweep({
    preCount: 5, preTotal, fee,
    postUtxos: [{ txid: "b".repeat(64), vout: 0, value: preTotal - fee - 1n }],
    targetAddress: ADDR,
  });
  assert.equal(badBalance.ok, false);
  assert.match(badBalance.verdict, /NOT VERIFIED/);

  const noDrop = comparePostSweep({
    preCount: 1, preTotal, fee,
    postUtxos: [{ txid: "b".repeat(64), vout: 0, value: preTotal - fee }],
    targetAddress: ADDR,
  });
  assert.equal(noDrop.ok, false); // count did not drop
});

test("verifyConsolidationTx: clean sweep verifies; foreign in/out refused loudly", () => {
  const tx = {
    txid: "c".repeat(64), confirmations: 3,
    vin: [
      { addresses: [ADDR], value: "1000" },
      { addresses: [ADDR], value: "2000" },
    ],
    vout: [{ addresses: [ADDR], value: "2700" }],
  };
  const ok = verifyConsolidationTx(tx, ADDR, ADDR);
  assert.equal(ok.ok, true);
  assert.equal(ok.fee, 300n);
  assert.equal(ok.nIn, 2);

  const foreignIn = verifyConsolidationTx(
    { ...tx, vin: [{ addresses: ["prl1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqnrql8a"], value: "1000" }] },
    ADDR, ADDR
  );
  assert.equal(foreignIn.ok, false);
  assert.match(foreignIn.refusal, /input #0 is not from the swept address/);

  const foreignOut = verifyConsolidationTx(
    { ...tx, vout: [{ addresses: ["prl1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqnrql8a"], value: "2700" }] },
    ADDR, ADDR
  );
  assert.equal(foreignOut.ok, false);
  assert.match(foreignOut.refusal, /output #0 does not pay the target/);
});

/* ---------- blockbook fetchers (mocked) ---------- */

function mockFetcher(routes) {
  return async (url, opts = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const hit = Object.keys(routes).find((k) => path.startsWith(k));
    if (!hit) return { ok: false, status: 404, text: async () => "not found" };
    const body = routes[hit](path, opts);
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
}

test("fetchSweepUtxos: parses rows, BigInt values, drops malformed rows", async () => {
  const f = mockFetcher({
    "/api/v2/utxo/": () => [
      { txid: "a".repeat(64), vout: 0, value: "12345", confirmations: 6 },
      { txid: "BAD", vout: 1, value: "999", confirmations: 1 }, // dropped
      { txid: "b".repeat(64), vout: -1, value: "5", confirmations: 0 }, // dropped
      { txid: "c".repeat(64), vout: 2, value: "0", confirmations: 0 }, // dropped
    ],
  });
  const us = await fetchSweepUtxos(f, "https://blockbook.pearlresearch.ai", ADDR);
  assert.equal(us.length, 1);
  assert.equal(us[0].value, 12345n);
  assert.equal(us[0].confirmations, 6);
  await assert.rejects(fetchSweepUtxos(mockFetcher({ "/api/v2/utxo/": () => ({ nope: 1 }) }), "https://x", ADDR));
});

test("fetchFeeRateMp: PRL/kB -> milliGrains/vB", async () => {
  const f = mockFetcher({ "/api/v2/estimatefee/": () => ({ result: "0.00001" }) });
  // 0.00001 PRL/kB = 1000 grains/kB = 1 grain/vB
  assert.equal(await fetchFeeRateMp(f, "https://x"), 1000n);
  const bad = mockFetcher({ "/api/v2/estimatefee/": () => ({ result: "-1" }) });
  await assert.rejects(fetchFeeRateMp(bad, "https://x"), /unavailable/);
});

test("broadcastSweepTx: posts text/plain, returns txid, surfaces rejection", async () => {
  const seen = {};
  const f = async (url, opts) => {
    seen.url = url; seen.ct = opts.headers["Content-Type"]; seen.body = opts.body;
    return { ok: true, status: 200, text: async () => JSON.stringify({ result: "d".repeat(64) }) };
  };
  const txid = await broadcastSweepTx(f, "https://blockbook.pearlresearch.ai/", "deadbeef");
  assert.equal(txid, "d".repeat(64));
  assert.ok(seen.url.endsWith("/api/sendtx/"));
  assert.equal(seen.ct, "text/plain");
  assert.equal(seen.body, "deadbeef");
  const rej = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ error: "dust" }) });
  await assert.rejects(broadcastSweepTx(rej, "https://x", "00"), /broadcast rejected: dust/);
});
