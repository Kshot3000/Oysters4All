// Pearl Tax core tests (node --test). Pinned vectors for amount math, USD
// math, address validation, Blockbook normalization, price CSV, and the full
// FIFO ledger (gains, fees, gifts, transfers, mixed splits, refusals).
// Run: node --no-warnings --loader ./tests/loader.mjs --test tests/tax.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import * as R from "../src/tax-core.js";
import { walletFromMnemonic, NETWORKS } from "../../sign/src/crypto.js";

const MNEMO = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const A1 = walletFromMnemonic(MNEMO, NETWORKS.mainnet, 0, 0).address;
const A2 = walletFromMnemonic(MNEMO, NETWORKS.mainnet, 0, 1).address;
const EXT = "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d";

const PRICES = R.parsePriceCSV("2024-01-01,1.00\n2024-06-01,1.50\n2025-03-01,2.00\n");

const bbTx = (o) => ({
  txid: o.txid,
  blockHeight: o.height ?? 100,
  blockTime: o.time ?? 1700000000,
  fees: o.fees ?? "0",
  vin: o.vin ?? [],
  vout: o.vout ?? [],
});
const vin = (addr, v) => ({ addresses: [addr], value: String(v) });
const vout = (addr, v) => ({ value: String(v), addresses: [addr] });

/* ---------------- amount math ---------------- */

test("parsePRLToGrains / formatPRL round-trip", () => {
  assert.equal(R.parsePRLToGrains("1.5"), 150000000n);
  assert.equal(R.parsePRLToGrains("0.00000001"), 1n);
  assert.equal(R.formatPRL(150000000n), "1.5");
  assert.equal(R.formatPRL(100000000n), "1");
  assert.throws(() => R.parsePRLToGrains("1.000000001"), Error);
  assert.throws(() => R.parsePRLToGrains("-1"), Error);
});

test("parseUSDToCents rounds half-up", () => {
  assert.equal(R.parseUSDToCents("1.36"), 136n);
  assert.equal(R.parseUSDToCents("1.365"), 137n);
  assert.equal(R.parseUSDToCents("1.364"), 136n);
  assert.equal(R.parseUSDToCents("0.005"), 1n);
  assert.equal(R.parseUSDToCents("$2.5"), 250n);
  assert.equal(R.parseUSDToCents("100"), 10000n);
  assert.equal(R.formatUSD(123456n), "$1,234.56");
  assert.equal(R.formatUSD(-5n), "-$0.05");
  assert.throws(() => R.parseUSDToCents("abc"), Error);
});

test("grainsToCents is exact", () => {
  assert.equal(R.grainsToCents(100000000n, 136n), 136n);
  assert.equal(R.grainsToCents(50000000n, 100n), 50n);
  assert.equal(R.grainsToCents(1n, 100n), 0n); // sub-cent truncates down here by rounding
});

/* ---------------- addresses ---------------- */

test("validateWatchAddress accepts prl1/tprl1, rejects others", () => {
  assert.equal(R.validateWatchAddress(A1).hrp, "prl");
  assert.throws(() => R.validateWatchAddress("bc1p5cyxnuxmeuw8q2d6qss7l0hsn8ny7q4avh0hhs"), Error);
  assert.throws(() => R.validateWatchAddress(A1.toUpperCase().replace("PRL1", "prL1")), Error); // mixed case
  assert.throws(() => R.validateWatchAddress("not an address"), Error);
});

/* ---------------- normalization ---------------- */

test("normalize: receive / send / self / mixed", () => {
  const w = new Set([A1.toLowerCase()]);
  const rx = R.normalizeBlockbookTx(
    bbTx({ txid: "rx1", vin: [vin(EXT, 2e8)], vout: [vout(A1, 199999000), vout(EXT, 1000)], fees: "0" }),
    w
  );
  assert.equal(rx.kind, "receive");
  assert.equal(rx.deltaGrains, "199999000");

  const sx = R.normalizeBlockbookTx(
    bbTx({ txid: "sx1", vin: [vin(A1, 5e8)], vout: [vout(EXT, 499990000)], fees: "10000" }),
    w
  );
  assert.equal(sx.kind, "send");
  assert.equal(sx.deltaGrains, "-500000000");
  assert.equal(sx.feeGrains, "10000");

  const self = R.normalizeBlockbookTx(
    bbTx({ txid: "sf1", vin: [vin(A1, 1e8)], vout: [vout(A1, 99990000)], fees: "10000" }),
    w
  );
  assert.equal(self.kind, "self");
  assert.equal(self.deltaGrains, "-10000"); // consolidation: delta is exactly -fee

  const netSend = R.normalizeBlockbookTx(
    bbTx({ txid: "mx1", vin: [vin(A1, 1e8)], vout: [vout(A1, 2e7), vout(EXT, 7e7)], fees: "10000000" }),
    w
  );
  assert.equal(netSend.kind, "send"); // net-economic: change never left home
  assert.equal(netSend.deltaGrains, "-80000000");
  assert.equal(netSend.feeGrains, "10000000");

  const mixed = R.normalizeBlockbookTx(
    bbTx({
      txid: "mx2",
      vin: [vin(A1, 1e8), vin(EXT, 5e7)],
      vout: [vout(A1, 2e7), vout(EXT, 12e7)],
      fees: "10000000",
    }),
    w
  );
  assert.equal(mixed.kind, "mixed"); // outside money co-signed: genuinely ambiguous
  assert.ok(mixed.mixedFeeNote);
});

test("normalize: missing vin values -> UnresolvableTx", () => {
  const w = new Set([A1.toLowerCase()]);
  assert.throws(
    () =>
      R.normalizeBlockbookTx(
        bbTx({ txid: "bad1", vin: [{ addresses: [A1] }], vout: [vout(EXT, 1e8)] }),
        w
      ),
    R.UnresolvableTx
  );
});

/* ---------------- prices ---------------- */

test("parsePriceCSV: headers, comments, dedupe, errors", () => {
  const t = R.parsePriceCSV("# comment\ndate,price_usd\n2024-01-01,1.00\n2024-01-01,1.10\n2024-06-01,1.50\n");
  assert.equal(t.length, 2);
  assert.equal(t[0].cents, 110n); // last wins
  assert.throws(() => R.parsePriceCSV("nope"), Error);
  assert.throws(() => R.parsePriceCSV("2024-01-01,-1"), Error);
});

test("priceFor picks latest on-or-before", () => {
  assert.equal(R.priceFor(R.dateToUnix("2024-01-01"), PRICES).cents, 100n);
  assert.equal(R.priceFor(R.dateToUnix("2024-03-01"), PRICES).cents, 100n);
  assert.equal(R.priceFor(R.dateToUnix("2023-01-01"), PRICES), null);
});

/* ---------------- FIFO ledger ---------------- */

const W = () => new Set([A1.toLowerCase(), A2.toLowerCase()]);
const T = (y, m, d) => R.dateToUnix(`${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);

function ledgerFixture() {
  const w = W();
  const raws = [
    bbTx({ txid: "buy1", time: T(2024, 6, 1), vin: [vin(EXT, 100000000)], vout: [vout(A1, 100000000)] }),
    bbTx({
      txid: "sell1", time: T(2025, 3, 1), fees: "100000",
      vin: [vin(A1, 250000000)], vout: [vout(EXT, 249900000)],
    }),
  ];
  const txs = raws.map((r) => R.normalizeBlockbookTx(r, w));
  const cls = {
    buy1: { kind: "receive", sub: "buy" },
    sell1: { kind: "send", sub: "sell" },
  };
  const openingLots = [{ date: "2024-01-01", grains: "200000000", priceCents: "1.00" }];
  return { txs, cls, openingLots };
}

test("FIFO ledger: fee + principal split, pinned gains", () => {
  const { txs, cls, openingLots } = ledgerFixture();
  const L = R.runLedger({ txs, classifications: cls, priceTable: PRICES, openingLots });
  // fee 100000 grains disposed at zero proceeds from the opening lot
  assert.equal(L.feeEvents.length, 1);
  assert.equal(L.feeEvents[0].grains, 100000n);
  assert.equal(L.feeEvents[0].proceedsCents, 0n);
  // principal 249900000 grains sold @ $2.00; final row absorbs the proceeds remainder
  assert.equal(L.disposals.length, 2);
  const [r1, r2] = L.disposals;
  assert.equal(r1.grains, 199900000n);
  assert.equal(r1.proceedsCents, 399n);
  assert.equal(r1.basisCents, 200n); // fee ate 100k grains but 0c of basis (dust truncation)
  assert.equal(r1.gainCents, 199n);
  assert.equal(r1.longTerm, true); // 2024-01-01 -> 2025-03-01
  assert.equal(r2.grains, 50000000n);
  assert.equal(r2.proceedsCents, 101n); // 500 total - 399 allocated = 101
  assert.equal(r2.basisCents, 75n);
  assert.equal(r2.gainCents, 26n);
  assert.equal(r2.longTerm, false); // 2024-06-01 -> 2025-03-01 = 273d
  // rows sum exactly to the transaction totals — no dropped cent
  assert.equal(r1.proceedsCents + r2.proceedsCents, R.grainsToCents(249900000n, 200n));
  assert.equal(r1.basisCents + r2.basisCents, 275n);
  // leftover lot: half of buy1 remains
  assert.equal(L.lots.length, 1);
  assert.equal(L.lots[0].grains, 50000000n);
});

test("buildReport: 2025 totals split short/long, fees reduce the net", () => {
  const { txs, cls, openingLots } = ledgerFixture();
  const L = R.runLedger({ txs, classifications: cls, priceTable: PRICES, openingLots });
  const rep = R.buildReport(L, 2025);
  assert.equal(rep.totals.disposalCount, 2);
  assert.equal(BigInt(rep.totals.proceedsCents), 500n);
  assert.equal(BigInt(rep.totals.basisCents), 275n);
  assert.equal(BigInt(rep.totals.gainCents), 225n); // 199 + 26; fee basis here is 0c
  assert.equal(BigInt(rep.totals.longGainCents), 199n);
  assert.equal(BigInt(rep.totals.shortGainCents), 26n);
  const rep24 = R.buildReport(L, 2024);
  assert.equal(rep24.totals.disposalCount, 0);
});

test("fee basis is a real cost: nontrivial fee reduces net gain", () => {
  const w = W();
  const txs = [
    R.normalizeBlockbookTx(bbTx({ txid: "in1", time: T(2024, 6, 1), vin: [vin(EXT, 1e8)], vout: [vout(A1, 1e8)] }), w),
    R.normalizeBlockbookTx(
      bbTx({ txid: "sell1", time: T(2025, 3, 1), fees: "10000000", vin: [vin(A1, 510000000)], vout: [vout(EXT, 5e8)] }),
      w
    ),
  ];
  const L = R.runLedger({
    txs,
    classifications: { in1: { kind: "receive", sub: "buy" }, sell1: { kind: "send", sub: "sell" } },
    priceTable: PRICES,
    openingLots: [{ date: "2024-01-01", grains: "1000000000", priceCents: "1.00" }],
  });
  // fee 0.1 PRL from the opening lot @ $1.00 = 10c of real basis
  assert.equal(L.feeEvents.length, 1);
  assert.equal(L.feeEvents[0].basisCents, 10n);
  assert.equal(L.feeEvents[0].gainCents, -10n);
  assert.equal(L.feeEvents[0].longTerm, true);
  const rep = R.buildReport(L, 2025);
  assert.equal(BigInt(rep.totals.feeBasisCents), 10n);
  assert.equal(BigInt(rep.totals.feeGainCents), -10n);
  // principal: 5 PRL @ $2.00 = 1000c proceeds, 500c basis -> 500c gain; net 490c
  assert.equal(BigInt(rep.totals.gainCents), 490n);
  assert.equal(BigInt(rep.totals.longGainCents), 490n);
  assert.equal(BigInt(rep.totals.shortGainCents), 0n);
});

test("ledger refuses unclassified txs", () => {
  const { txs, openingLots } = ledgerFixture();
  assert.throws(
    () => R.runLedger({ txs, classifications: {}, priceTable: PRICES, openingLots }),
    (e) => e instanceof R.LedgerError && e.detail.unclassified.length === 2
  );
});

test("ledger refuses missing prices", () => {
  const { txs, cls, openingLots } = ledgerFixture();
  assert.throws(
    () => R.runLedger({ txs, classifications: cls, priceTable: [], openingLots }),
    (e) => e instanceof R.LedgerError && e.detail.missingPrices.length === 2
  );
});

test("ledger refuses when FIFO runs dry", () => {
  const { txs, cls } = ledgerFixture();
  assert.throws(
    () => R.runLedger({ txs, classifications: cls, priceTable: PRICES, openingLots: [] }),
    (e) => e instanceof R.LedgerError && /ran dry/.test(e.message)
  );
});

test("gift-out and transfer-out consume lots with no gain and no loss", () => {
  const w = W();
  const mk = (txid, sub) => {
    const txs = [
      R.normalizeBlockbookTx(bbTx({ txid: "in1", time: T(2024, 6, 1), vin: [vin(EXT, 1e8)], vout: [vout(A1, 1e8)] }), w),
      R.normalizeBlockbookTx(
        bbTx({ txid, time: T(2024, 7, 1), vin: [vin(A1, 1e8)], vout: [vout(EXT, 1e8)] }),
        w
      ),
    ];
    return R.runLedger({
      txs,
      classifications: { in1: { kind: "receive", sub: "buy" }, [txid]: { kind: "send", sub } },
      priceTable: PRICES,
    });
  };
  const g = mk("gift1", "gift");
  assert.equal(g.disposals.length, 0); // no taxable disposal: no gain, no loss
  assert.equal(g.nonTaxableOutflows.length, 1);
  assert.equal(g.nonTaxableOutflows[0].label, "gift");
  assert.equal(g.nonTaxableOutflows[0].grains, 100000000n);
  assert.equal(g.nonTaxableOutflows[0].basisCents, 150n); // full lot basis carried out
  assert.equal(g.lots.length, 0);
  const t = mk("xfer1", "transfer-out");
  assert.equal(t.disposals.length, 0);
  assert.equal(t.nonTaxableOutflows[0].label, "transfer-out");
  const l = mk("lost1", "lost");
  assert.equal(l.disposals.length, 1); // lost IS a capital loss
  assert.equal(l.disposals[0].label, "lost");
  assert.equal(l.disposals[0].proceedsCents, 0n);
  assert.equal(l.disposals[0].gainCents, -150n);
});

test("transfer-in honors the original acquisition date for holding period", () => {
  const w = W();
  const txs = [
    R.normalizeBlockbookTx(
      bbTx({ txid: "tin1", time: T(2025, 3, 1), vin: [vin(EXT, 1e8)], vout: [vout(A1, 1e8)] }),
      w
    ),
    R.normalizeBlockbookTx(
      bbTx({ txid: "sell1", time: T(2025, 4, 1), vin: [vin(A1, 1e8)], vout: [vout(EXT, 1e8)] }),
      w
    ),
  ];
  const L = R.runLedger({
    txs,
    classifications: {
      tin1: { kind: "receive", sub: "transfer-in", acquiredUnix: T(2023, 6, 1) },
      sell1: { kind: "send", sub: "sell" },
    },
    priceTable: PRICES,
  });
  assert.equal(L.disposals.length, 1);
  assert.equal(L.disposals[0].acquiredUnix, T(2023, 6, 1)); // original date, not receipt
  assert.equal(L.disposals[0].longTerm, true); // 2023-06-01 -> 2025-04-01
  assert.equal(L.disposals[0].basisCents, 200n); // receipt-date FMV ($2.00 on 2025-03-01)
});

test("send with change is netted: change keeps its original lots", () => {
  const w = W();
  const txs = [
    R.normalizeBlockbookTx(bbTx({ txid: "buy1", time: T(2024, 6, 1), vin: [vin(EXT, 25e7)], vout: [vout(A1, 25e7)] }), w),
    R.normalizeBlockbookTx(
      bbTx({
        txid: "spend1", time: T(2025, 3, 1), fees: "100000",
        vin: [vin(A1, 25e7)], vout: [vout(A1, 5e7), vout(EXT, 199900000)],
      }),
      w
    ),
  ];
  assert.equal(txs[1].kind, "send"); // not mixed
  const L = R.runLedger({
    txs,
    classifications: { buy1: { kind: "receive", sub: "buy" }, spend1: { kind: "send", sub: "spend" } },
    priceTable: PRICES,
  });
  // net outflow 2 PRL: fee 0.001 + principal 1.999 disposed; 0.5 PRL change untouched
  assert.equal(L.disposals.length, 1);
  assert.equal(L.disposals[0].grains, 199900000n);
  assert.equal(L.lots.length, 1);
  assert.equal(L.lots[0].grains, 50000000n); // change keeps original basis, no step-up
  assert.equal(L.lots[0].costCents, 76n); // 375 - 0 (fee dust) - 299 (principal)
});

test("mining receive books income at FMV", () => {
  const w = W();
  const txs = [
    R.normalizeBlockbookTx(bbTx({ txid: "mine1", time: T(2024, 6, 1), vin: [], vout: [vout(A1, 50000000)] }), w),
  ];
  const L = R.runLedger({
    txs,
    classifications: { mine1: { kind: "receive", sub: "mining" } },
    priceTable: PRICES,
  });
  assert.equal(L.incomeEvents.length, 1);
  assert.equal(L.incomeEvents[0].fmvCents, "75"); // 0.5 PRL @ $1.50
  assert.equal(L.lots.length, 1);
});

test("mixed tx (outside co-signer) splits into receive + send legs", () => {
  const w = W();
  const txs = [
    R.normalizeBlockbookTx(bbTx({ txid: "seed1", time: T(2024, 2, 1), vin: [vin(EXT, 2e8)], vout: [vout(A1, 2e8)] }), w),
    R.normalizeBlockbookTx(
      bbTx({
        txid: "mx1", time: T(2024, 6, 1), fees: "10000000",
        vin: [vin(A1, 1e8), vin(EXT, 5e7)], // outside money co-signs: genuinely ambiguous
        vout: [vout(A1, 2e7), vout(EXT, 12e7)],
      }),
      w
    ),
  ];
  assert.equal(txs[1].kind, "mixed");
  const L = R.runLedger({
    txs,
    classifications: {
      seed1: { kind: "receive", sub: "buy" },
      mx1: { kind: "mixed", recvSub: "transfer-in", recvAcquiredUnix: T(2024, 1, 15), sendSub: "spend" },
    },
    priceTable: PRICES,
  });
  assert.ok(L.disposals.length >= 1);
  assert.equal(L.lots.length, 2); // seed remainder + mixed receive leg
  const recvLeg = L.lots.find((l) => l.note.includes("transfer-in"));
  assert.ok(recvLeg);
  assert.equal(recvLeg.acquiredUnix, T(2024, 1, 15)); // mixed leg honors the date too
});

test("validateClassification rejects bad subs", () => {
  assert.throws(() => R.validateClassification({ kind: "receive", sub: "sell" }), Error);
  assert.throws(() => R.validateClassification({ kind: "mixed", recvSub: "buy", sendSub: "nope" }), Error);
  assert.doesNotThrow(() => R.validateClassification({ kind: "self", sub: "internal" }));
});

test("disposalsCSV + incomeCSV shape", () => {
  const { txs, cls, openingLots } = ledgerFixture();
  const L = R.runLedger({ txs, classifications: cls, priceTable: PRICES, openingLots });
  const rep = R.buildReport(L, 2025);
  const csv = R.disposalsCSV(rep);
  const lines = csv.split("\n");
  assert.equal(lines.length, 3);
  assert.ok(lines[0].startsWith("Date Acquired,Date Disposed"));
  assert.ok(lines[1].includes("2024-01-01,2025-03-01"));
  assert.ok(lines[1].includes("Long"));
  const inc = R.incomeCSV({ income: [] });
  assert.equal(inc.split("\n").length, 1);
});

test("isLongTerm boundary: 365d is short, 365d+1s is long", () => {
  const a = 1700000000;
  assert.equal(R.isLongTerm(a, a + 365 * 86400), false);
  assert.equal(R.isLongTerm(a, a + 365 * 86400 + 1), true);
  assert.equal(R.unixToDate(0), "1970-01-01");
});
