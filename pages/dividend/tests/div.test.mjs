// Pearl Dividend core tests: token-unit math, snapshot parsing/sealing,
// share derivation (proportional/equal/fixed), dust + remainder accounting,
// chunking, funding, bundle export/import tamper-evidence, local signing,
// and the standalone verifier.
// Usage: node --no-warnings --loader ./tests/loader.mjs tests/div.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import * as D from "../src/div-core.js";

const NET = D.NETWORKS.mainnet;
const addr = (tag) => D.encodeBech32m("prl", 1, D.sha256(new TextEncoder().encode(tag)));
const A1 = addr("div-holder-1"), A2 = addr("div-holder-2"), A3 = addr("div-holder-3");
const A4 = addr("div-holder-4"), A5 = addr("div-holder-5"), A6 = addr("div-holder-6");

const FUNDER_PRIV = "ab".repeat(32);
const funderSecret = D.parseBatchSecret(FUNDER_PRIV, NET);
const FUNDER = funderSecret.address;

function snapshot(holders, over = {}) {
  // holders: [[addr, unitsBigInt]]
  return D.buildSnapshotDescriptor({
    network: NET, tick: "pearl", decimals: 8,
    holders: holders.map(([a, u]) => ({ address: a, units: u })),
    maxSupplyUnits: 21_000_000n * 100_000_000n,
    ...over,
  });
}
const H = () => [[A1, 100n * 100_000_000n], [A2, 300n * 100_000_000n], [A3, 600n * 100_000_000n]];

function plan(over = {}) {
  const s = snapshot(H());
  return D.planDividend({
    network: NET, snapshot: s, snapshotFingerprint: s.fingerprint,
    poolPRL: "1", rule: "proportional", feeRate: 2, ...over,
  });
}
function utxos(n, each) {
  return Array.from({ length: n }, (_, i) => ({
    txid: D.bytesToHex(D.sha256(new TextEncoder().encode("div-utxo-" + i))),
    vout: 0, value: each, confirmations: 10,
  }));
}

test("parseTokenUnits is strict and exact", () => {
  assert.equal(D.parseTokenUnits("1.5", 8), 150000000n);
  assert.equal(D.parseTokenUnits("0.00000001", 8), 1n);
  assert.equal(D.parseTokenUnits("100", 0), 100n);
  assert.equal(D.formatTokenUnits(150000000n, 8), "1.5");
  assert.equal(D.formatTokenUnits(100n, 0), "100");
  assert.equal(D.formatTokenUnits(D.parseTokenUnits("123.456", 8), 8), "123.456");
  assert.throws(() => D.parseTokenUnits("1.000000001", 8), /fraction digits/);
  assert.throws(() => D.parseTokenUnits("-1", 8), /bad token amount/);
  assert.throws(() => D.parseTokenUnits("1e3", 8), /bad token amount/);
  assert.throws(() => D.parseTokenUnits("1.5", 0), /fraction digits/);
});

test("parseSnapshotCsv validates, skips header/comments, reports dups", () => {
  const csv = `# comment\naddress,balance\n${A1},100.5\n${A2},200\nnotanaddress,10\n${A1},50\n${A3},0\n`;
  const r = D.parseSnapshotCsv(csv, { network: NET, decimals: 8 });
  assert.equal(r.holders.length, 2);
  assert.equal(r.holders[0].units, 10050000000n);
  assert.equal(r.errors.length, 2); // bad address + zero balance
  assert.equal(r.duplicates.length, 1);
  assert.equal(r.duplicates[0].address, A1);
  assert.equal(r.totalUnits, 10050000000n + 20000000000n);
  const merged = D.mergeDuplicateHolders([...r.holders, { address: A1, units: 5000000000n, line: 9 }]);
  assert.equal(merged.length, 2);
  assert.equal(merged.find((h) => h.address === A1).units, 15050000000n);
  assert.throws(() => D.parseSnapshotCsv("# nothing\n", { network: NET, decimals: 8 }), /no valid holders/);
});

test("sample snapshot is labeled and parses clean", () => {
  const csv = D.sampleSnapshotCsv(NET, 5);
  assert.match(csv, /SAMPLE SNAPSHOT/);
  const r = D.parseSnapshotCsv(csv, { network: NET, decimals: 8 });
  assert.equal(r.holders.length, 5);
  assert.equal(r.errors.length, 0);
  assert.equal(r.duplicates.length, 0);
});

test("normalizeTokenMeta maps defensively and fingerprints stably", () => {
  const raw = { ticker: "DIVT", decimals: 8, max_supply: "21000000", minted_supply: "1000.5", holder_count: 42 };
  const m = D.normalizeTokenMeta(raw, { tick: "divt", indexerBase: "https://idx.example" });
  assert.equal(m.tick, "divt");
  assert.equal(m.decimals, 8);
  assert.equal(m.maxSupplyUnits, 21000000n * 10n ** 8n);
  assert.equal(m.mintedUnits, 100050000000n);
  assert.equal(m.holderCount, 42);
  assert.equal(m.manualMeta, false);
  const m2 = D.normalizeTokenMeta(null, { tick: "divt" });
  assert.equal(m2.maxSupplyUnits, null);
  assert.equal(m2.holderCount, null);
  assert.equal(m2.decimals, 8);
  const fp1 = D.tokenMetaFingerprint(m);
  const fp2 = D.tokenMetaFingerprint(D.normalizeTokenMeta(raw, { tick: "divt", indexerBase: "https://idx.example" }));
  assert.equal(fp1, fp2, "fingerprint stable across re-normalization");
  assert.match(fp1, /^[0-9a-f]{16}$/);
  assert.notEqual(fp1, D.tokenMetaFingerprint(m2), "different metadata -> different fingerprint");
  // height moves must NOT change the fingerprint (drift check would scream every block)
  const m3 = D.normalizeTokenMeta(raw, { tick: "divt", indexerBase: "https://idx.example", indexerStatus: { height: 999999 } });
  assert.equal(D.tokenMetaFingerprint(m3), fp1);
  // manual metadata is fingerprinted distinctly
  const m4 = D.normalizeTokenMeta({ tick: "divt", decimals: 8, maxSupply: "21000000" }, { tick: "divt", manualMeta: true });
  assert.equal(m4.manualMeta, true);
  assert.notEqual(D.tokenMetaFingerprint(m4), fp1);
});

test("snapshot descriptor: stable fingerprint + supply check", () => {
  const s1 = snapshot(H());
  const s2 = snapshot(H());
  assert.equal(s1.fingerprint, s2.fingerprint);
  assert.equal(s1.descriptor.supplyCheck, "PASS");
  const over = snapshot([[A1, 30_000_000n * 100_000_000n]]);
  assert.equal(over.descriptor.supplyCheck, "FAIL");
  const unk = snapshot(H(), { maxSupplyUnits: null });
  assert.equal(unk.descriptor.supplyCheck, "UNKNOWN");
  assert.equal(s1.descriptor.holders[0].address < s1.descriptor.holders[1].address, true); // canonical sort
});

test("deriveShares proportional is grain-exact", () => {
  const s = snapshot(H());
  const r = D.deriveShares({ snapshot: s, poolGrains: 1_000_000_000n, rule: "proportional", dustFloorGrains: 0n });
  const byA = new Map(r.paid.map((p) => [p.address, p.shareGrains]));
  assert.equal(byA.get(A1), 100_000_000n); // 10% of 10 PRL
  assert.equal(byA.get(A2), 300_000_000n);
  assert.equal(byA.get(A3), 600_000_000n);
  assert.equal(r.remainderGrains, 0n);
});

test("deriveShares equal floors and the remainder is exact", () => {
  const s = snapshot(H());
  const r = D.deriveShares({ snapshot: s, poolGrains: 1000n, rule: "equal", dustFloorGrains: 0n });
  assert.deepEqual(r.paid.map((p) => p.shareGrains), [333n, 333n, 333n]);
  assert.equal(r.remainderGrains, 1n);
  assert.equal(r.paid.reduce((a, p) => a + p.shareGrains, 0n) + r.remainderGrains, 1000n);
});

test("deriveShares fixed refuses an oversized promise", () => {
  const s = snapshot(H());
  assert.throws(
    () => D.deriveShares({ snapshot: s, poolGrains: 250n, rule: "fixed", fixedGrains: 100n, dustFloorGrains: 0n }),
    /raise the pool/
  );
  const r = D.deriveShares({ snapshot: s, poolGrains: 500n, rule: "fixed", fixedGrains: 100n, dustFloorGrains: 0n });
  assert.deepEqual(r.paid.map((p) => p.shareGrains), [100n, 100n, 100n]);
  assert.equal(r.remainderGrains, 200n);
});

test("dust shares are dropped loudly and accounted", () => {
  const s = snapshot(H());
  // pool 1000 grains, proportional: A1 gets 100, A2 300, A3 600; floor 333 drops A1+A2
  const r = D.deriveShares({ snapshot: s, poolGrains: 1000n, rule: "proportional", dustFloorGrains: 333n });
  assert.equal(r.paid.length, 1);
  assert.equal(r.paid[0].address, A3);
  assert.equal(r.droppedDust.count, 2);
  assert.equal(r.droppedDust.grains, 400n);
  assert.equal(r.paid[0].shareGrains + r.remainderGrains, 1000n);
  // floor above everything -> loud refusal, not a silent empty plan
  assert.throws(
    () => D.deriveShares({ snapshot: s, poolGrains: 1000n, rule: "proportional", dustFloorGrains: 10_000n }),
    /below the dust floor/
  );
});

test("exclusions and minimum balance filter before math", () => {
  const s = snapshot(H());
  const r = D.deriveShares({
    snapshot: s, poolGrains: 900n, rule: "equal", dustFloorGrains: 0n,
    exclusions: [A1], minBalanceUnits: 200n * 100_000_000n,
  });
  assert.equal(r.excludedCount, 1);
  assert.equal(r.belowMinCount, 0);
  assert.equal(r.paid.length, 2); // A2, A3
  assert.deepEqual(r.paid.map((p) => p.shareGrains), [450n, 450n]);
});

test("planDividend chunks and seals the plan", () => {
  const holders = [A1, A2, A3, A4, A5, A6].map((a, i) => [a, BigInt(i + 1) * 100_000_000n]);
  const s = snapshot(holders);
  const p = D.planDividend({
    network: NET, snapshot: s, snapshotFingerprint: s.fingerprint,
    poolPRL: "2", rule: "proportional", feeRate: 2, maxOutputsPerTx: 2,
  });
  assert.equal(p.chunks.length, 3);
  assert.equal(p.descriptor.kind, "pearl-div:v1");
  assert.equal(p.descriptor.paidCount, 6);
  assert.equal(p.fingerprint, D.descriptorFingerprint(p.descriptor));
  const paidSum = p.descriptor.recipients.reduce((a, r) => a + BigInt(r.shareGrains), 0n);
  assert.equal(paidSum + BigInt(p.descriptor.remainderGrains), 200_000_000n);
  // remainder is 2 grains (< dust) -> folded into funder change, disclosed
  const last = p.chunks[2];
  assert.equal(last.last, true);
  assert.equal(p.descriptor.remainderGrains, "2");
  assert.equal(p.descriptor.remainderTo, "funder-change-folded");
  // tampered snapshot fingerprint refuses
  assert.throws(
    () => D.planDividend({ network: NET, snapshot: s, snapshotFingerprint: "00".repeat(8), poolPRL: "2", rule: "proportional" }),
    /SNAPSHOT FINGERPRINT MISMATCH/
  );
});

test("decimal fee rate: sealed estimate is exact and funding charges that same rate", () => {
  // Regression (two layers): the sealed estimate used float
  // Math.ceil(670 * 1.1) = 738 where the exact fee is 737, and funding —
  // which re-plans through the batch planner — used to ceil the RATE
  // itself (1.1 -> 2) and charge 1340 for the same chunk.
  assert.equal(D.ceilFeeGrains(670, 1.1), 737n);
  assert.equal(D.ceilFeeGrains(670, "1.1"), 737n);
  assert.throws(() => D.ceilFeeGrains(670, "abc"), /finite decimal/);
  const holders = Array.from({ length: 13 }, (_, i) => [addr("div-dec-" + i), 100n * 100_000_000n]);
  const s = snapshot(holders);
  const p = D.planDividend({
    network: NET, snapshot: s, snapshotFingerprint: s.fingerprint,
    poolPRL: "1", rule: "equal", feeRate: 1.1,
  });
  assert.equal(p.chunks.length, 1);
  assert.equal(p.chunks[0].recipientCount, 13);
  assert.equal(p.chunks[0].estFeeGrains, "737"); // keypathTxVBytes(1, 14) = 670 vB at 1.1 g/vB
  assert.equal(p.descriptor.totals.estFeesGrains, "737");
  const funded = D.fundDividend({ network: NET, plan: p, utxos: utxos(1, 200000000), funderAddress: FUNDER });
  const fc = funded.fundedChunks[0];
  assert.equal(fc.plan.vBytes, 670);
  assert.equal(fc.plan.feeRate, 1.1);
  assert.equal(fc.plan.fee, 737n); // estimate and charge agree, at the typed rate
  assert.equal(fc.plan.total, fc.plan.sumOut + fc.plan.fee + fc.plan.change);
});

test("planDividend emits an explicit remainder output when >= dust", () => {
  const p = plan({ rule: "fixed", fixedPRL: "0.3" }); // 3 holders x 0.3 PRL, pool 1 PRL -> remainder 0.1 PRL
  assert.equal(p.descriptor.remainderGrains, "10000000");
  assert.equal(p.descriptor.remainderTo, "funder-change-output");
  const last = p.chunks[p.chunks.length - 1];
  const rem = last.recipients.find((r) => r.remainder);
  assert.ok(rem, "last chunk carries the remainder pseudo-recipient");
  assert.equal(rem.address, null);
  assert.equal(BigInt(rem.shareGrains), 10000000n);
});

test("planDividend treasury takes the remainder explicitly", () => {
  const T = addr("div-treasury");
  const p = plan({ treasuryAddress: T, rule: "fixed", fixedPRL: "0.3" }); // 0.1 PRL remainder
  assert.equal(p.descriptor.remainderTo, T);
  const last = p.chunks[p.chunks.length - 1];
  const tr = last.recipients.find((r) => r.treasury);
  assert.ok(tr);
  assert.equal(tr.address, T);
  assert.equal(BigInt(tr.shareGrains), BigInt(p.descriptor.remainderGrains));
});

test("fundDividend assigns coins per chunk and refuses shortfall", () => {
  const p = plan({ maxOutputsPerTx: 2, rule: "fixed", fixedPRL: "0.3" }); // 3 holders -> 2 chunks, 0.1 PRL remainder output
  const funded = D.fundDividend({ network: NET, plan: p, utxos: utxos(4, 50000000), funderAddress: FUNDER });
  assert.equal(funded.fundedChunks.length, 2);
  for (const fc of funded.fundedChunks) {
    const pl = fc.plan;
    assert.equal(pl.total, pl.sumOut + pl.fee + pl.change); // invariant
    assert.ok(pl.fee > 0n);
  }
  // every planned recipient output exists on the funded plans
  const allOut = funded.fundedChunks.flatMap((fc) => fc.plan.outputs.filter((o) => !o.change));
  assert.equal(allOut.length, p.descriptor.recipients.length + 1); // + remainder output
  assert.throws(
    () => D.fundDividend({ network: NET, plan: p, utxos: utxos(1, 1000), funderAddress: FUNDER }),
    /chunk #1: insufficient funds/
  );
  assert.throws(
    () => D.fundDividend({ network: NET, plan: p, utxos: utxos(2, 50000000), funderAddress: "prl1invalid" }),
    /not a valid prl1 address/
  );
});

test("chunk bundle export/import round-trips and refuses tampering", () => {
  const p = plan({ maxOutputsPerTx: 2 });
  const funded = D.fundDividend({ network: NET, plan: p, utxos: utxos(4, 50000000), funderAddress: FUNDER });
  const b0 = D.exportChunkBundle({ network: NET, funded, chunkIndex: 0 });
  assert.equal(b0.bundle, "pearl-div-unsigned:v1:");
  assert.equal(b0.fingerprint, p.fingerprint);
  const imp = D.importChunkBundle(b0);
  assert.equal(imp.funderAddress, FUNDER);
  assert.equal(imp.plan.fee.toString(), b0.feeGrains);
  // tamper the descriptor -> fingerprint mismatch
  const bad1 = JSON.parse(JSON.stringify(b0));
  bad1.descriptor.poolGrains = "99999999999";
  assert.throws(() => D.importChunkBundle(bad1), /FINGERPRINT MISMATCH/);
  // tamper the fee -> fee mismatch
  const bad2 = JSON.parse(JSON.stringify(b0));
  bad2.feeGrains = (BigInt(bad2.feeGrains) + 1n).toString();
  assert.throws(() => D.importChunkBundle(bad2), /FEE MISMATCH/);
  // tamper the wire -> digest mismatch
  const bad3 = JSON.parse(JSON.stringify(b0));
  bad3.unsignedHex = bad3.unsignedHex.slice(0, -2) + "ff";
  assert.throws(() => D.importChunkBundle(bad3), /DIGEST MISMATCH|WIRE MISMATCH/);
  // tamper a plan output -> rebuilt wire digest mismatch
  const bad4 = JSON.parse(JSON.stringify(b0));
  bad4.plan.outputs[0].valueGrains = (BigInt(bad4.plan.outputs[0].valueGrains) + 1n).toString();
  assert.throws(() => D.importChunkBundle(bad4), /DIGEST MISMATCH/);
});

test("signChunk signs locally and re-verifies every signature", () => {
  const p = plan({ maxOutputsPerTx: 3 });
  const funded = D.fundDividend({ network: NET, plan: p, utxos: utxos(3, 80000000), funderAddress: FUNDER });
  const b0 = D.exportChunkBundle({ network: NET, funded, chunkIndex: 0 });
  const imp = D.importChunkBundle(b0);
  const signed = D.signChunk({ network: NET, imported: imp, secretText: FUNDER_PRIV });
  assert.match(signed.txid, /^[0-9a-f]{64}$/);
  assert.ok(signed.hex.length > 100);
  // wrong key -> address-match guard fires before any signing
  const other = D.parseBatchSecret("cd".repeat(32), NET);
  assert.throws(
    () => D.signChunk({ network: NET, imported: imp, secretText: "cd".repeat(32) }),
    /KEY DOES NOT CONTROL/
  );
  void other;
});

function fakePayoutTxJson({ txid, funder, inputs, outputs, confirmations = 3 }) {
  return {
    txid, confirmations, blockHeight: 999999,
    vin: inputs.map((v) => ({ addresses: [funder], value: v })),
    vout: outputs.map((o) => ({ value: Number(o.value), addresses: [o.address] })),
  };
}

test("verifyDividend PROVEN on the honest flow", () => {
  const p = plan({ maxOutputsPerTx: 3 });
  const funded = D.fundDividend({ network: NET, plan: p, utxos: utxos(3, 80000000), funderAddress: FUNDER });
  const csv = `${A1},100\n${A2},300\n${A3},600`;
  const payouts = funded.fundedChunks.map((fc, i) => {
    const bnd = D.exportChunkBundle({ network: NET, funded, chunkIndex: i });
    const signed = D.signChunk({ network: NET, imported: D.importChunkBundle(bnd), secretText: FUNDER_PRIV });
    const txJson = fakePayoutTxJson({
      txid: signed.txid, funder: FUNDER,
      inputs: fc.plan.inputs.map((u) => u.value),
      outputs: fc.plan.outputs.map((o) => ({ value: BigInt(o.value), address: o.address })),
    });
    return { chunkIndex: i, txid: signed.txid, txJson };
  });
  const v = D.verifyDividend({
    network: NET, snapshotCsvText: csv,
    dividendBundle: { descriptor: p.descriptor, fingerprint: p.fingerprint, funderAddress: FUNDER },
    payouts,
  });
  assert.equal(v.verdict, "PROVEN");
  assert.ok(v.checks.every((c) => c.ok), JSON.stringify(v.checks.filter((c) => !c.ok)));
});

test("verifyDividend NOT PROVEN on tampered plan or payouts", () => {
  const p = plan({ maxOutputsPerTx: 3 });
  const csv = `${A1},100\n${A2},300\n${A3},600`;
  const good = { descriptor: p.descriptor, fingerprint: p.fingerprint, funderAddress: FUNDER };
  // tamper one share in the descriptor
  const badD = JSON.parse(JSON.stringify(p.descriptor));
  badD.recipients[0].shareGrains = (BigInt(badD.recipients[0].shareGrains) + 1n).toString();
  const v1 = D.verifyDividend({ network: NET, snapshotCsvText: csv, dividendBundle: { descriptor: badD, fingerprint: p.fingerprint, funderAddress: FUNDER }, payouts: [] });
  assert.equal(v1.verdict, "NOT PROVEN");
  // tamper a payout: underpay one recipient
  const funded = D.fundDividend({ network: NET, plan: p, utxos: utxos(3, 80000000), funderAddress: FUNDER });
  const fc = funded.fundedChunks[0];
  const outs = fc.plan.outputs.map((o) => ({ value: BigInt(o.value), address: o.address }));
  outs[0] = { value: outs[0].value - 1n, address: outs[0].address };
  const txJson = fakePayoutTxJson({ txid: "00".repeat(32), funder: FUNDER, inputs: fc.plan.inputs.map((u) => u.value), outputs: outs });
  const v2 = D.verifyDividend({ network: NET, snapshotCsvText: csv, dividendBundle: good, payouts: [{ chunkIndex: 0, txid: "00".repeat(32), txJson }] });
  assert.equal(v2.verdict, "NOT PROVEN");
  // unexpected extra output
  const outs2 = [...fc.plan.outputs.map((o) => ({ value: BigInt(o.value), address: o.address })), { value: 1000n, address: addr("div-attacker") }];
  const txJson2 = fakePayoutTxJson({ txid: "11".repeat(32), funder: FUNDER, inputs: fc.plan.inputs.map((u) => u.value), outputs: outs2 });
  const v3 = D.verifyDividend({ network: NET, snapshotCsvText: csv, dividendBundle: good, payouts: [{ chunkIndex: 0, txid: "11".repeat(32), txJson: txJson2 }] });
  assert.equal(v3.verdict, "NOT PROVEN");
  // wrong snapshot CSV
  const v4 = D.verifyDividend({ network: NET, snapshotCsvText: `${A1},999\n${A2},300\n${A3},600`, dividendBundle: good, payouts: [] });
  assert.equal(v4.verdict, "NOT PROVEN");
});

test("builderTipGrainsFor: exactness and waivers", () => {
  assert.equal(D.BUILDER_TIP_ADDRESS, "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d");
  assert.equal(D.builderTipGrainsFor(100_000_000n, NET, true), 1_000_000n); // 1% of 1 PRL
  assert.equal(D.builderTipGrainsFor(123_456_789n, NET, true), 1_234_567n); // floored
  assert.equal(D.builderTipGrainsFor(100_000_000n, NET, false), 0n); // off
  assert.equal(D.builderTipGrainsFor(100_000_000n, NET, "yes"), 0n); // only === true counts
  assert.equal(D.builderTipGrainsFor(100_000_000n, D.NETWORKS.testnet, true), 0n); // testnet waived
  assert.equal(D.builderTipGrainsFor(25_000n, NET, true), 0n); // 250 grains < dust — waived, never rounded up
  assert.equal(D.builderTipGrainsFor(33_300n, NET, true), 333n); // exactly at the dust floor — charged
});

test("builder tip sits ON TOP of the pool — holder shares unchanged", () => {
  const plain = plan();
  const tipped = plan({ builderTipEnabled: true });
  assert.equal(tipped.descriptor.builderTipGrains, "1000000"); // 1% of the 1 PRL pool
  assert.equal(tipped.descriptor.builderTipAddress, D.BUILDER_TIP_ADDRESS);
  assert.equal(tipped.descriptor.totals.builderTipGrains, "1000000");
  // every holder share and the remainder are identical to the untipped plan
  assert.deepEqual(tipped.descriptor.recipients, plain.descriptor.recipients);
  assert.equal(tipped.descriptor.remainderGrains, plain.descriptor.remainderGrains);
  assert.equal(tipped.descriptor.totals.recipientsGrains, plain.descriptor.totals.recipientsGrains);
  // exactly one tip output, in the last chunk, at the exact amount
  const last = tipped.chunks[tipped.chunks.length - 1];
  const tips = last.recipients.filter((r) => r.builderTip);
  assert.equal(tips.length, 1);
  assert.equal(tips[0].address, D.BUILDER_TIP_ADDRESS);
  assert.equal(BigInt(tips[0].shareGrains), 1_000_000n);
  const dtips = tipped.descriptor.chunks.flatMap((c) => c.recipients.filter((r) => r.builderTip));
  assert.equal(dtips.length, 1);
  // off by default: no tip fields set, no tip output
  assert.equal(plain.descriptor.builderTipGrains, "0");
  assert.equal(plain.descriptor.builderTipAddress, null);
  assert.equal(plain.chunks.flatMap((c) => c.recipients.filter((r) => r.builderTip)).length, 0);
  // testnet: enabled still waives
  const TNET = D.NETWORKS.testnet;
  const taddr = (tag) => D.encodeBech32m("tprl", 1, D.sha256(new TextEncoder().encode(tag)));
  const ts = D.buildSnapshotDescriptor({
    network: TNET, tick: "pearl", decimals: 8,
    holders: [{ address: taddr("div-th-1"), units: 100n * 100_000_000n }],
    maxSupplyUnits: null,
  });
  const tp = D.planDividend({
    network: TNET, snapshot: ts, snapshotFingerprint: ts.fingerprint,
    poolPRL: "1", rule: "proportional", feeRate: 2, builderTipEnabled: true,
  });
  assert.equal(tp.descriptor.builderTipGrains, "0");
  assert.equal(tp.descriptor.builderTipAddress, null);
});

test("builder tip + remainder reserve room in the final chunk", () => {
  const holders = [A1, A2, A3, A4, A5, A6].map((a, i) => [a, BigInt(i + 1) * 100_000_000n]);
  const s = snapshot(holders);
  const p = D.planDividend({
    network: NET, snapshot: s, snapshotFingerprint: s.fingerprint,
    poolPRL: "1", rule: "fixed", fixedPRL: "0.1", feeRate: 2,
    maxOutputsPerTx: 3, builderTipEnabled: true,
  });
  // 6 paid shares, remainder 0.4 PRL (>= dust) AND a 0.01 PRL tip both belong
  // to the last chunk: no chunk may exceed the 3-output cap.
  for (const c of p.chunks) assert.ok(c.recipients.length <= 3, `chunk ${c.index} has ${c.recipients.length} outputs`);
  const last = p.chunks[p.chunks.length - 1];
  assert.equal(last.recipients.filter((r) => r.builderTip).length, 1);
  assert.equal(last.recipients.filter((r) => r.remainder).length, 1);
  const paidOuts = p.chunks.flatMap((c) => c.recipients.filter((r) => !r.remainder && !r.builderTip));
  assert.equal(paidOuts.length, 6);
});

test("tipped dividend funds, signs, and the signed wire carries the tip exact", () => {
  const p = plan({ builderTipEnabled: true }); // 1 chunk, remainder 0
  const funded = D.fundDividend({ network: NET, plan: p, utxos: utxos(3, 80_000_000), funderAddress: FUNDER });
  const fc = funded.fundedChunks[funded.fundedChunks.length - 1];
  const tipOut = fc.plan.outputs.find((o) => o.builderTip);
  assert.ok(tipOut, "funded plan carries the flagged tip output");
  assert.equal(tipOut.address, D.BUILDER_TIP_ADDRESS);
  assert.equal(BigInt(tipOut.value), 1_000_000n);
  // conservation: inputs = holders + tip + fee + change
  assert.equal(fc.plan.total, fc.plan.sumOut + fc.plan.fee + fc.plan.change);
  assert.equal(fc.plan.sumOut, 100_000_000n + 1_000_000n);
  const b = D.exportChunkBundle({ network: NET, funded, chunkIndex: fc.index });
  const imp = D.importChunkBundle(b);
  const signed = D.signChunk({ network: NET, imported: imp, secretText: FUNDER_PRIV });
  const dec = D.decodeRawTx(signed.hex);
  const builderProg = D.decodeBech32m(D.BUILDER_TIP_ADDRESS, "prl").program;
  const builderSpk = "5120" + D.bytesToHex(builderProg);
  const wireTip = dec.outputs.filter((o) => D.bytesToHex(o.spk) === builderSpk);
  assert.equal(wireTip.length, 1, "exactly one builder output on the wire");
  assert.equal(BigInt(wireTip[0].value), 1_000_000n);
  // tampered descriptor tip amount refuses at funding (fingerprint mismatch)
  const badPlan = JSON.parse(JSON.stringify(p.descriptor));
  badPlan.builderTipGrains = "2000000";
  assert.throws(
    () => D.fundDividend({ network: NET, plan: { descriptor: badPlan, fingerprint: p.fingerprint, chunks: p.chunks }, utxos: utxos(3, 80_000_000), funderAddress: FUNDER }),
    /FINGERPRINT MISMATCH/
  );
});

test("chunk bundle refuses a rerouted builder-tip flag on import", () => {
  const p = plan({ builderTipEnabled: true });
  const funded = D.fundDividend({ network: NET, plan: p, utxos: utxos(3, 80_000_000), funderAddress: FUNDER });
  const b = D.exportChunkBundle({ network: NET, funded, chunkIndex: 0 });
  // flag a HOLDER output as the tip instead — the flag is a trust claim
  const bad = JSON.parse(JSON.stringify(b));
  const holderOut = bad.plan.outputs.find((o) => !o.change && !o.builderTip);
  holderOut.builderTip = true;
  assert.throws(() => D.importChunkBundle(bad), /flagged as the builder tip pays/);
  // shrink the real tip output — amount must match the sealed plan
  const bad2 = JSON.parse(JSON.stringify(b));
  const tipOut = bad2.plan.outputs.find((o) => o.builderTip);
  tipOut.valueGrains = "999999";
  assert.throws(() => D.importChunkBundle(bad2), /builder-tip amount does not match|DIGEST MISMATCH/);
});

test("verifyDividend recomputes the builder tip", () => {
  const p = plan({ builderTipEnabled: true });
  const csv = `${A1},100\n${A2},300\n${A3},600`;
  const funded = D.fundDividend({ network: NET, plan: p, utxos: utxos(3, 80_000_000), funderAddress: FUNDER });
  const payouts = funded.fundedChunks.map((fc, i) => {
    const bnd = D.exportChunkBundle({ network: NET, funded, chunkIndex: i });
    const signed = D.signChunk({ network: NET, imported: D.importChunkBundle(bnd), secretText: FUNDER_PRIV });
    const txJson = fakePayoutTxJson({
      txid: signed.txid, funder: FUNDER,
      inputs: fc.plan.inputs.map((u) => u.value),
      outputs: fc.plan.outputs.map((o) => ({ value: BigInt(o.value), address: o.address })),
    });
    return { chunkIndex: i, txid: signed.txid, txJson };
  });
  const v = D.verifyDividend({
    network: NET, snapshotCsvText: csv,
    dividendBundle: { descriptor: p.descriptor, fingerprint: p.fingerprint, funderAddress: FUNDER },
    payouts,
  });
  assert.equal(v.verdict, "PROVEN", JSON.stringify(v.checks.filter((c) => !c.ok)));
  const tipCheck = v.checks.find((c) => c.name === "builder tip");
  assert.ok(tipCheck && tipCheck.ok, "tip leg passes on the honest tipped flow");
  // tamper the sealed tip (fingerprint recomputed so ONLY the tip leg can fail)
  const badD = JSON.parse(JSON.stringify(p.descriptor));
  badD.builderTipGrains = "500000";
  const badFp = D.descriptorFingerprint(badD);
  const v2 = D.verifyDividend({
    network: NET, snapshotCsvText: csv,
    dividendBundle: { descriptor: badD, fingerprint: badFp, funderAddress: FUNDER },
    payouts: [],
  });
  assert.equal(v2.verdict, "NOT PROVEN");
  const tc2 = v2.checks.find((c) => c.name === "builder tip");
  assert.ok(tc2 && !tc2.ok, "tip leg fails on a tampered tip amount");
});

test("indexer fetchers handle ok / 404 / network failure", async () => {
  const okFetch = async (url) => ({
    ok: true, json: async () => url.includes("/tokens/") ? { ticker: "pearl", holderCount: 42 } : { height: 123 },
  });
  const r1 = await D.fetchTokenMeta(okFetch, "https://idx.example", "PEARL");
  assert.equal(r1.ok, true);
  assert.equal(r1.data.holderCount, 42);
  const r2 = await D.fetchIndexerStatus(okFetch, "https://idx.example/");
  assert.equal(r2.data.height, 123);
  const notFound = async () => ({ ok: false, status: 404 });
  const r3 = await D.fetchTokenMeta(notFound, "https://idx.example", "nope");
  assert.equal(r3.ok, false);
  assert.equal(r3.error, "HTTP_404");
  const down = async () => { throw new Error("boom"); };
  const r4 = await D.fetchTokenMeta(down, "https://idx.example", "pearl");
  assert.equal(r4.ok, false);
  assert.match(r4.error, /NETWORK/);
  await assert.rejects(D.fetchTokenMeta(okFetch, "", "pearl"), /indexer base URL required/);
});
