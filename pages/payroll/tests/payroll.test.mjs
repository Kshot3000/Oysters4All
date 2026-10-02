// Pearl Payroll core tests (node:test). Runs against src/ via the importmap
// loader hook — exercises the real audited Sign lineage, not the bundle.
// Usage: node --no-warnings --loader ./tests/loader.mjs tests/payroll.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "../../sign/lib/scure-bip39/index.js";
import {
  NETWORKS, GRAIN_PER_PRL, DUST_GRAIN, fmtPRL, parsePRL,
  decodeBech32m, encodeBech32m, walletFromMnemonic, walletFromPriv,
  walletToWIF, newMnemonic, keypathTxVBytes, hexToBytes, decodeRawTx,
  tweakKeypath,
  parsePayrollSecret, assertKeyControlsAddress, canonicalAddress,
  parseRoster, sampleRoster, rosterToCsv, rosterFromCsv,
  nextPayDates, msUntilPayday, fmtCountdown, PAY_PERIODS,
  planRun, autoSelectUtxos, estimateRunFee, runsCovered,
  buildUnsignedTx, buildDescriptor, exportUnsignedBundle, importUnsignedBundle,
  buildPayrollTx, recordPayrollRun, assertHistoryRecord, runsToCsv,
  perPayeeTotals, canonicalJson, descriptorFingerprint, historyStorageKey,
  PAYROLL_MAX_PAYEES, PAYROLL_DESCRIPTOR_KIND, PAYROLL_BUNDLE_KIND,
} from "../src/index.js";

const N = NETWORKS.mainnet;
const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const HEXKEY = "0f".repeat(32);

function senderOf(privHex) {
  const w = walletFromPriv(privHex, N);
  const { tweakedX } = tweakKeypath(w.internalXOnly);
  return encodeBech32m(N.hrp, 1, tweakedX);
}
const SENDER = senderOf(HEXKEY);

function recipAddr(seedHex) { return senderOf(seedHex); }
const A1 = recipAddr("aa".repeat(32));
const A2 = recipAddr("bb".repeat(32));
const A3 = recipAddr("cc".repeat(32));

const utxo = (txid, vout, value) => ({ txid, vout, value, confirmations: 6 });

/* ---------------- amounts ---------------- */

test("fmtPRL/parsePRL grain-exact round-trip", () => {
  assert.equal(parsePRL("1.25"), 125000000n);
  assert.equal(parsePRL("0.00000546"), 546n);
  assert.equal(fmtPRL(1125000005n), "11.25000005");
  assert.equal(fmtPRL(546n), "0.00000546");
  assert.throws(() => parsePRL("1.123456789"), /invalid PRL amount/);
});

/* ---------------- canonical JSON + fingerprint ---------------- */

test("canonicalJson sorts keys recursively", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 1 } }), '{"a":{"c":1,"d":2},"b":1}');
  assert.equal(canonicalJson([3, { z: 1, y: 2 }]), '[3,{"y":2,"z":1}]');
});

test("descriptorFingerprint: 16 hex chars, stable, tamper-sensitive", () => {
  const d = { kind: PAYROLL_DESCRIPTOR_KIND, a: 1 };
  const fp = descriptorFingerprint(d);
  assert.match(fp, /^[0-9a-f]{16}$/);
  assert.equal(descriptorFingerprint({ a: 1, kind: PAYROLL_DESCRIPTOR_KIND }), fp);
  const d2 = { kind: PAYROLL_DESCRIPTOR_KIND, a: 2 };
  assert.notEqual(descriptorFingerprint(d2), fp);
});

test("historyStorageKey per network", () => {
  assert.equal(historyStorageKey("mainnet"), "pearl-payroll:history:mainnet");
  assert.equal(historyStorageKey("testnet"), "pearl-payroll:history:testnet");
});

/* ---------------- sender secret ---------------- */

test("parsePayrollSecret: mnemonic -> BIP-86 address", () => {
  const s = parsePayrollSecret(MNEMONIC, N);
  assert.equal(s.kind, "mnemonic");
  const w = walletFromMnemonic(MNEMONIC, N, 0, 0);
  const { tweakedX } = tweakKeypath(w.internalXOnly);
  assert.equal(s.address, encodeBech32m(N.hrp, 1, tweakedX));
  assert.match(s.privHex, /^[0-9a-f]{64}$/);
});

test("parsePayrollSecret: hex + WIF agree on the address", () => {
  const hex = parsePayrollSecret(HEXKEY, N);
  const wif = parsePayrollSecret(walletToWIF(hexToBytes(HEXKEY), N), N);
  assert.equal(hex.kind, "hex");
  assert.equal(wif.kind, "wif");
  assert.equal(hex.address, SENDER);
  assert.equal(wif.address, SENDER);
});

test("parsePayrollSecret: xprv derived at m/86'/coin'/0'/0/0", () => {
  const seed = mnemonicToSeedSync(MNEMONIC);
  const root = HDKey.fromMasterSeed(seed);
  const xprv = root.toJSON().xpriv;
  const s = parsePayrollSecret(xprv, N);
  const expect = parsePayrollSecret(MNEMONIC, N);
  assert.equal(s.kind, "xprv");
  assert.equal(s.address, expect.address);
});

test("parsePayrollSecret: rejects garbage loudly", () => {
  assert.throws(() => parsePayrollSecret("", N), /paste the sender secret/);
  assert.throws(() => parsePayrollSecret("short words here only", N), /unrecognized secret/);
  assert.throws(() => parsePayrollSecret("abandon abandon abandon", N), /unrecognized secret/);
});

test("assertKeyControlsAddress: pass + loud failure", () => {
  const s = parsePayrollSecret(HEXKEY, N);
  assertKeyControlsAddress(s, SENDER);
  assertKeyControlsAddress(s, SENDER.toUpperCase());
  assert.throws(() => assertKeyControlsAddress(s, A1), /KEY DOES NOT CONTROL THE SENDER ADDRESS/);
});

test("canonicalAddress: validates prl1 Taproot, rejects junk", () => {
  assert.equal(canonicalAddress(" " + A1 + " ", N), A1);
  assert.throws(() => canonicalAddress("junk", N), /not a valid prl1 address/);
  assert.throws(() => canonicalAddress(A1, NETWORKS.testnet), /not a valid tprl1 address/);
});

/* ---------------- roster ---------------- */

test("parseRoster: sample roster exact totals", () => {
  const { payees, merged, total } = parseRoster(sampleRoster(), N);
  assert.equal(payees.length, 3);
  assert.equal(merged, 0);
  assert.equal(total, 125000000n + 546n + 1000000000n);
  assert.equal(payees[0].label, "Alice — senior dev");
  assert.equal(payees[1].amount, 546n); // grains unit, dust boundary
  assert.equal(payees[2].label, "Carol — ops retainer");
  for (const r of payees) assert.ok(r.program instanceof Uint8Array && r.program.length === 32);
});

test("parseRoster: whitespace format, label with spaces", () => {
  const { payees } = parseRoster(`${A1} 2.5 monthly retainer`, N);
  assert.equal(payees.length, 1);
  assert.equal(payees[0].amount, 250000000n);
  assert.equal(payees[0].label, "monthly retainer");
});

test("parseRoster: dust refused loudly, boundary accepted", () => {
  assert.throws(() => parseRoster(`${A1}, 0.00000545`, N), /dust floor/);
  assert.throws(() => parseRoster(`${A1}, 545 grains`, N), /dust floor/);
  const ok = parseRoster(`${A1}, 546 grains`, N);
  assert.equal(ok.payees[0].amount, 546n);
});

test("parseRoster: bad input refused", () => {
  assert.throws(() => parseRoster("junk, 1", N), /not a valid prl1 address/);
  assert.throws(() => parseRoster(`${A1}, 0`, N), /must be positive/);
  assert.throws(() => parseRoster(`${A1}\n`, N), /need "<address>, <amount>"/);
  assert.throws(() => parseRoster("", N), /no payees/);
  assert.throws(() => parseRoster("# only comments", N), /no payees/);
  assert.throws(() => parseRoster(`${A1}, 1, ${"x".repeat(65)}`, N), /longer than 64 chars/);
});

test("parseRoster: duplicates merge by default", () => {
  const { payees, merged, total } = parseRoster(`${A1}, 1\n${A2}, 2\n${A1}, 0.5, bonus`, N);
  assert.equal(payees.length, 2);
  assert.equal(merged, 1);
  assert.equal(payees[0].amount, 150000000n);
  assert.equal(payees[0].label, "bonus");
  assert.equal(total, 350000000n);
});

test("parseRoster: merge off refuses duplicates loudly", () => {
  assert.throws(
    () => parseRoster(`${A1}, 1\n${A2}, 2\n${A1}, 0.5`, N, { mergeDuplicates: false }),
    /merging is OFF/
  );
});

test("parseRoster: header line skipped, >250 payees refused", () => {
  const csv = `address,amount_prl,label\n${A1},1,Alice\n${A2},2,Bob`;
  const { payees, total } = parseRoster(csv, N);
  assert.equal(payees.length, 2);
  assert.equal(total, 300000000n);
  const many = Array.from({ length: PAYROLL_MAX_PAYEES + 1 }, (_, i) => `${recipAddr(((i + 1).toString(16).padStart(2, "0")).repeat(32))}, 1`).join("\n");
  assert.throws(() => parseRoster(many, N), /too many unique payees/);
});

test("rosterToCsv / rosterFromCsv round-trip", () => {
  const { payees } = parseRoster(`${A1}, 1.25, Alice — senior dev\n${A2}, 546 grains`, N);
  const csv = rosterToCsv(payees);
  assert.ok(csv.startsWith("address,amount_prl,label\n"));
  const back = rosterFromCsv(csv, N);
  assert.equal(back.payees.length, 2);
  assert.equal(back.payees[0].amount, 125000000n);
  assert.equal(back.payees[0].label, "Alice — senior dev");
  assert.equal(back.payees[1].amount, 546n);
  assert.equal(back.total, 125000546n);
});

test("rosterToCsv escapes commas in labels", () => {
  const { payees } = parseRoster(`${A1}, 1`, N);
  payees[0].label = 'Doe, Jane "JD"';
  const csv = rosterToCsv(payees);
  assert.match(csv, /"Doe, Jane ""JD"""/);
});

/* ---------------- schedule ---------------- */

test("nextPayDates: weekly from anchor, exact weekdays", () => {
  // 2026-10-01 is a Thursday.
  const ds = nextPayDates({ anchor: "2026-10-01", period: "weekly", count: 3, from: "2026-10-01" });
  assert.deepEqual(ds.map((d) => d.iso), ["2026-10-01", "2026-10-08", "2026-10-15"]);
  assert.deepEqual(ds.map((d) => d.dow), ["Thu", "Thu", "Thu"]);
  assert.deepEqual(ds.map((d) => d.index), [0, 1, 2]);
});

test("nextPayDates: past anchor advances to the next upcoming payday", () => {
  const ds = nextPayDates({ anchor: "2026-10-01", period: "biweekly", count: 2, from: "2026-10-20" });
  assert.deepEqual(ds.map((d) => d.iso), ["2026-10-29", "2026-11-12"]);
  assert.deepEqual(ds.map((d) => d.index), [2, 3]);
  assert.equal(ds.skippedPaydays, 2);
});

test("nextPayDates: skippedPaydays counts skipped runs (0 when anchor is current)", () => {
  const fresh = nextPayDates({ anchor: "2026-10-01", period: "weekly", count: 3, from: "2026-10-01" });
  assert.equal(fresh.skippedPaydays, 0);
  const stale = nextPayDates({ anchor: "2026-10-01", period: "weekly", count: 3, from: "2026-10-02" });
  assert.equal(stale.skippedPaydays, 1);
  assert.equal(stale[0].iso, "2026-10-08");
  // Jan 31 anchor, Mar 1 "today": Jan 31 + Feb 28 skipped (Feb 28 < Mar 1), Mar 31 first
  const monthly = nextPayDates({ anchor: "2026-01-31", period: "monthly", count: 3, from: "2026-03-01" });
  assert.deepEqual(monthly.map((d) => d.iso), ["2026-03-31", "2026-04-30", "2026-05-31"]);
  assert.equal(monthly.skippedPaydays, 2);
});

test("nextPayDates: monthly preserves day-of-month with clamping", () => {
  // Jan 31 2026 (Sat) -> Feb 28 (Sat, clamped, 2026 not a leap year) -> Mar 31
  const ds = nextPayDates({ anchor: "2026-01-31", period: "monthly", count: 3, from: "2026-01-31" });
  assert.deepEqual(ds.map((d) => d.iso), ["2026-01-31", "2026-02-28", "2026-03-31"]);
});

test("nextPayDates: custom days", () => {
  const ds = nextPayDates({ anchor: "2026-10-01", period: "custom", customDays: 10, count: 3, from: "2026-10-01" });
  assert.deepEqual(ds.map((d) => d.iso), ["2026-10-01", "2026-10-11", "2026-10-21"]);
  assert.throws(() => nextPayDates({ anchor: "2026-10-01", period: "custom", customDays: 0, from: "2026-10-01" }), /positive whole number/);
});

test("nextPayDates: rejects bad input", () => {
  assert.throws(() => nextPayDates({ anchor: "2026-10-01", period: "fortnightly", from: "2026-10-01" }), /unknown pay period/);
  assert.throws(() => nextPayDates({ anchor: "10/01/2026", period: "weekly", from: "2026-10-01" }), /YYYY-MM-DD/);
  assert.throws(() => nextPayDates({ anchor: "2026-02-30", period: "weekly", from: "2026-10-01" }), /not a real calendar date/);
  assert.throws(() => nextPayDates({ anchor: "2026-10-01", period: "weekly", count: 61, from: "2026-10-01" }), /count must be 1–60/);
});

test("fmtCountdown: days/hours/minutes/overdue", () => {
  assert.equal(fmtCountdown((2 * 1440 + 3 * 60 + 5) * 60000), "2d 3h 5m");
  assert.equal(fmtCountdown(3 * 3600000 + 120000), "3h 2m");
  assert.equal(fmtCountdown(45000), "0m");
  assert.equal(fmtCountdown(0), "due now");
  assert.equal(fmtCountdown(-1000), "overdue — run it now");
});

test("msUntilPayday: ms from now to first payday UTC midnight", () => {
  const ms = msUntilPayday([{ iso: "2030-01-01" }], Date.parse("2029-12-31T12:00:00Z"));
  assert.equal(ms, 12 * 3600000);
  assert.throws(() => msUntilPayday([], 0), /no pay dates/);
});

test("PAY_PERIODS lists all four", () => {
  assert.deepEqual(PAY_PERIODS, ["weekly", "biweekly", "monthly", "custom"]);
});

/* ---------------- fee / selection / planning ---------------- */

const PAYEES = () => [
  { address: A1, program: decodeBech32m(A1, N.hrp).program, amount: 125000000n, label: "Alice" },
  { address: A2, program: decodeBech32m(A2, N.hrp).program, amount: 546n, label: null },
  { address: A3, program: decodeBech32m(A3, N.hrp).program, amount: 1000000000n, label: "Carol" },
];
const SENDER_PROGRAM = () => decodeBech32m(SENDER, N.hrp).program;

test("autoSelectUtxos: largest-first covers payees + fee", () => {
  const us = [utxo("a".repeat(64), 0, 800000000), utxo("b".repeat(64), 1, 500000000), utxo("c".repeat(64), 2, 50000000)];
  const r = autoSelectUtxos(us, 1125000546n, 20, 3);
  assert.ok(r.selected.length >= 2);
  assert.ok(!r.changeDropped);
  assert.equal(r.fee, BigInt(keypathTxVBytes(r.selected.length, 4)) * 20n);
  assert.equal(r.change, r.selected.reduce((a, u) => a + BigInt(u.value), 0n) - 1125000546n - r.fee);
});

test("autoSelectUtxos: insufficient funds refused loudly", () => {
  assert.throws(
    () => autoSelectUtxos([utxo("a".repeat(64), 0, 1000)], 1125000546n, 20, 3),
    /insufficient funds/
  );
  assert.throws(() => autoSelectUtxos([], 1n, 20, 1), /no UTXOs/);
  assert.throws(() => autoSelectUtxos([utxo("a".repeat(64), 0, 1000)], 1n, 0, 1), /positive number of grains\/vB/);
});

test("planRun: totals balance grain-exact, change kept", () => {
  const us = [utxo("a".repeat(64), 0, 800000000), utxo("b".repeat(64), 1, 500000000)];
  const p = planRun({ utxos: us, payees: PAYEES(), senderProgram: SENDER_PROGRAM(), feeRateGrainsPerVByte: 20, network: N });
  assert.equal(p.total, p.sumOut + p.fee + p.change);
  assert.equal(p.changeDropped, false);
  assert.equal(p.nOut, 4); // 3 payees + change
  assert.equal(p.outputs[3].change, true);
  assert.equal(p.outputs[3].address, SENDER);
  assert.equal(p.vBytes, keypathTxVBytes(2, 4));
  assert.equal(p.fee, BigInt(p.vBytes) * 20n);
});

test("planRun: dust change absorbed into the fee, disclosed", () => {
  // with-change change would be 4300-4800 = -500 < 546 -> dropped;
  // actual fee = nominal 197*20=3940, absorbed bump 360 grains
  const us = [utxo("a".repeat(64), 0, 1125000546 + 4300)];
  const p = planRun({ utxos: us, payees: PAYEES(), senderProgram: SENDER_PROGRAM(), feeRateGrainsPerVByte: 20, network: N });
  assert.equal(p.changeDropped, true);
  assert.equal(p.change, 0n);
  assert.equal(p.nOut, 3); // no change output
  assert.equal(p.vBytes, keypathTxVBytes(1, 3));
  assert.equal(p.nominalFee, BigInt(p.vBytes) * 20n);
  assert.equal(p.changeBump, 360n);
  assert.equal(p.fee, p.nominalFee + p.changeBump);
  assert.equal(p.total, p.sumOut + p.fee);
});

test("planRun: insufficient funds refused loudly", () => {
  assert.throws(
    () => planRun({ utxos: [utxo("a".repeat(64), 0, 1000)], payees: PAYEES(), senderProgram: SENDER_PROGRAM(), feeRateGrainsPerVByte: 20, network: N }),
    /insufficient funds/
  );
  assert.throws(
    () => planRun({ utxos: [utxo("a".repeat(64), 0, 800000000)], payees: [], senderProgram: SENDER_PROGRAM(), feeRateGrainsPerVByte: 20, network: N }),
    /no payees/
  );
});

test("estimateRunFee + runsCovered", () => {
  const fee = estimateRunFee({ nPayees: 3, nIn: 1, feeRateGrainsPerVByte: 20 });
  assert.equal(fee, BigInt(keypathTxVBytes(1, 4)) * 20n);
  const per = 1125000546n + fee;
  assert.equal(runsCovered(per * 5n, 1125000546n, fee), 5);
  assert.equal(runsCovered(per * 5n - 1n, 1125000546n, fee), 4);
  assert.equal(runsCovered(0n, 1125000546n, fee), 0);
  assert.throws(() => runsCovered(100n, 0n, 0n), /run cost must be positive/);
});

/* ---------------- descriptor + bundle ---------------- */

function settled() {
  const us = [utxo("a".repeat(64), 0, 800000000), utxo("b".repeat(64), 1, 500000000)];
  const payees = PAYEES();
  const plan = planRun({ utxos: us, payees, senderProgram: SENDER_PROGRAM(), feeRateGrainsPerVByte: 20, network: N });
  return { us, payees, plan };
}

test("buildDescriptor: kind tag, schedule context, 16-hex fingerprint", () => {
  const { payees, plan } = settled();
  const { descriptor, fingerprint } = buildDescriptor({
    network: N, senderAddress: SENDER, payees, plan, feeRate: 20,
    period: "biweekly", payDate: "2026-10-15", runLabel: "Oct-15 run",
  });
  assert.equal(descriptor.kind, PAYROLL_DESCRIPTOR_KIND);
  assert.equal(descriptor.period, "biweekly");
  assert.equal(descriptor.payDate, "2026-10-15");
  assert.equal(descriptor.runLabel, "Oct-15 run");
  assert.equal(descriptor.payees[0].label, "Alice");
  assert.match(fingerprint, /^[0-9a-f]{16}$/);
  assert.equal(descriptor.totals.payeesGrains, "1125000546");
});

test("exportUnsignedBundle / importUnsignedBundle round-trip", () => {
  const { payees, plan } = settled();
  const b = exportUnsignedBundle({
    network: N, senderAddress: SENDER, payees, plan, feeRate: 20,
    period: "weekly", payDate: "2026-10-08", runLabel: "run 3",
  });
  assert.equal(b.bundle, PAYROLL_BUNDLE_KIND);
  assert.match(b.fingerprint, /^[0-9a-f]{16}$/);
  assert.match(b.unsignedTxid, /^[0-9a-f]{64}$/);
  assert.equal(b.feeGrains, plan.fee.toString());
  assert.equal(b.vBytes, plan.vBytes);
  const imp = importUnsignedBundle(JSON.parse(JSON.stringify(b)));
  assert.equal(imp.senderAddress, SENDER);
  assert.equal(imp.fingerprint, b.fingerprint);
  assert.equal(imp.payees.length, 3);
  assert.equal(imp.plan.fee, plan.fee);
  assert.equal(imp.period, "weekly");
  assert.equal(imp.payDate, "2026-10-08");
});

test("importUnsignedBundle: tamper on payee refused (fingerprint)", () => {
  const { payees, plan } = settled();
  const b = exportUnsignedBundle({ network: N, senderAddress: SENDER, payees, plan, feeRate: 20, period: "weekly", payDate: "2026-10-08", runLabel: "r" });
  const t = JSON.parse(JSON.stringify(b));
  t.descriptor.payees[0].amountGrains = "999999999";
  assert.throws(() => importUnsignedBundle(t), /FINGERPRINT MISMATCH/);
});

test("importUnsignedBundle: tamper on fee refused", () => {
  const { payees, plan } = settled();
  const b = exportUnsignedBundle({ network: N, senderAddress: SENDER, payees, plan, feeRate: 20, period: "weekly", payDate: "2026-10-08", runLabel: "r" });
  const t = JSON.parse(JSON.stringify(b));
  // recompute the fingerprint so the fingerprint check passes, then the fee check fires
  t.feeGrains = "123";
  const t2 = JSON.parse(JSON.stringify(b));
  t2.feeGrains = String(BigInt(b.feeGrains) + 1n);
  assert.throws(() => importUnsignedBundle(t2), /FEE MISMATCH/);
});

test("importUnsignedBundle: tamper on unsigned hex refused (wire digest)", () => {
  const { payees, plan } = settled();
  const b = exportUnsignedBundle({ network: N, senderAddress: SENDER, payees, plan, feeRate: 20, period: "weekly", payDate: "2026-10-08", runLabel: "r" });
  const t = JSON.parse(JSON.stringify(b));
  t.unsignedHex = t.unsignedHex.slice(0, -2) + (t.unsignedHex.slice(-2) === "00" ? "01" : "00");
  // hex changed but txid still the original -> digest/txid mismatch fires
  assert.throws(() => importUnsignedBundle(t), /DIGEST MISMATCH|WIRE DIGEST/);
});

test("importUnsignedBundle: wrong kind + bad JSON refused", () => {
  assert.throws(() => importUnsignedBundle({ bundle: "pearl-batch-unsigned:v1:" }), /not a Pearl Payroll unsigned bundle/);
  assert.throws(() => importUnsignedBundle("not json"), /Unexpected token/);
});

/* ---------------- sign ---------------- */

test("buildPayrollTx: signs and re-verifies; wrong key refused", () => {
  const { us, payees, plan } = settled();
  const secret = parsePayrollSecret(HEXKEY, N);
  const { txid, hex } = buildPayrollTx({ secret, senderAddress: SENDER, utxos: us, plan, network: N });
  assert.match(txid, /^[0-9a-f]{64}$/);
  assert.ok(hex.length > 400);
  // decoded wire parses and carries the payee outputs
  const dec = decodeRawTx(hex);
  assert.equal(dec.inputs.length, 2);
  assert.equal(dec.outputs.length, 4);
  assert.equal(dec.txid, txid);
  const wrong = parsePayrollSecret("ab".repeat(32), N);
  assert.throws(() => buildPayrollTx({ secret: wrong, senderAddress: SENDER, utxos: us, plan, network: N }), /KEY DOES NOT CONTROL/);
});

/* ---------------- history ---------------- */

function sampleRecord() {
  return recordPayrollRun({
    payDate: "2026-10-15", period: "biweekly", runLabel: "Oct-15 run",
    txid: "d".repeat(64),
    payees: [
      { address: A1, label: "Alice", grains: 125000000n },
      { address: A2, label: null, grains: 546n },
    ],
    feeGrains: 4400n, vBytes: 220,
    recordedAt: "2026-10-15T09:00:00.000Z",
  });
}

test("recordPayrollRun: shape + JSON-safe", () => {
  const r = sampleRecord();
  assertHistoryRecord(r);
  const back = JSON.parse(JSON.stringify(r));
  assert.equal(back.txid, "d".repeat(64));
  assert.equal(back.payees[0].grains, "125000000");
  assert.equal(back.feeGrains, "4400");
  assert.equal(back.version, 1);
  assert.throws(() => recordPayrollRun({ payDate: "x", period: "w", runLabel: "r", txid: "zz", payees: [{ address: A1, label: null, grains: 1n }], feeGrains: 1n, vBytes: 1 }), /bad txid/);
  assert.throws(() => assertHistoryRecord({ txid: "d".repeat(64), payees: [] }), /no payees/);
});

test("runsToCsv: header + one row per payee", () => {
  const csv = runsToCsv([sampleRecord(), sampleRecord()]);
  const lines = csv.trim().split("\n");
  assert.equal(lines[0], "pay_date,period,run_label,txid,payee_address,payee_label,grains,prl");
  assert.equal(lines.length, 1 + 2 * 2);
  assert.ok(lines[1].includes("2026-10-15,biweekly,Oct-15 run"));
  assert.ok(lines[1].includes(",125000000,1.25"));
  assert.ok(lines[2].includes(",546,0.00000546"));
});

test("perPayeeTotals: aggregates across runs", () => {
  const totals = perPayeeTotals([sampleRecord(), sampleRecord()]);
  assert.equal(totals.size, 2);
  const a = totals.get(A1.toLowerCase());
  assert.equal(a.totalGrains, 250000000n);
  assert.equal(a.runs, 2);
  assert.equal(a.label, "Alice");
  const b = totals.get(A2.toLowerCase());
  assert.equal(b.totalGrains, 1092n);
  assert.equal(b.runs, 2);
});

test("newMnemonic produces 12 words that parse", () => {
  const mn = newMnemonic();
  assert.equal(mn.split(" ").length, 12);
  const s = parsePayrollSecret(mn, N);
  assert.match(s.address, /^prl1/);
});
