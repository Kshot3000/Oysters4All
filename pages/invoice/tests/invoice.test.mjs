// Pearl Invoice core tests (node --test). Pinned vectors for descriptor
// hashing, dust refusal, partial-payment math, tamper verifier, URI, and
// BIP-86 derivation — all crypto comes from the audited Sign core.
// Run: node --no-warnings --loader ./tests/loader.mjs --test tests/invoice.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import * as R from "../src/invoice-core.js";

const ADDR = R.DONATE_ADDRESS;
const FIXTURE = () =>
  R.buildInvoice({
    invoicee: "Acme Studio",
    items: [
      { description: "Logo design", amountPRL: "1.5" },
      { description: "Revisions", amountPRL: "0.25" },
    ],
    dueUnix: 1767225600,
    memo: "test memo",
    address: ADDR,
    payerLabel: "Bob",
  });
const FIXTURE_HASH = "de7879e19a80baca2c997c3dfb2a3f73fc11bf193de28eff87b3eba5fe7393a4";
const FIXTURE_DESCRIPTOR = `pearl-invoice:v1:prl:${FIXTURE_HASH}:175000000:1767225600`;
const MNEMO = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

/* ---------------- grain-exact amount math ---------------- */

test("parsePRLToGrains: exact BigInt conversion", () => {
  assert.equal(R.parsePRLToGrains("1.5"), 150000000n);
  assert.equal(R.parsePRLToGrains("0.00000001"), 1n);
  assert.equal(R.parsePRLToGrains(" 2.25 "), 225000000n);
  assert.equal(R.parsePRLToGrains("2100000000"), 2100000000n * 100000000n);
});
test("parsePRLToGrains refuses bad input", () => {
  for (const bad of ["1.000000001", "abc", "0", "0.0", "-1", "1,5", "", "1.2.3"]) {
    assert.throws(() => R.parsePRLToGrains(bad), Error, bad);
  }
});
test("formatPRL round-trips", () => {
  assert.equal(R.formatPRL(150000000n), "1.5");
  assert.equal(R.formatPRL(1n), "0.00000001");
  assert.equal(R.formatPRL(100000000n), "1");
  assert.equal(R.parsePRLToGrains(R.formatPRL(12345678n)), 12345678n);
});

/* ---------------- address validation ---------------- */

test("validateInvoiceAddress accepts real prl1 address", () => {
  const v = R.validateInvoiceAddress(ADDR);
  assert.equal(v.hrp, "prl");
  assert.equal(v.network.id, "mainnet");
});
test("validateInvoiceAddress loudly refuses bad addresses", () => {
  assert.throws(() => R.validateInvoiceAddress("junk"), /Not a valid Pearl Taproot address/);
  assert.throws(() => R.validateInvoiceAddress("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"), /Not a valid Pearl Taproot address/);
  const badChecksum = ADDR.slice(0, -1) + (ADDR.endsWith("9") ? "8" : "9");
  assert.throws(() => R.validateInvoiceAddress(badChecksum), /Not a valid Pearl Taproot address/);
  assert.throws(() => R.validateInvoiceAddress(""), /Not a valid Pearl Taproot address/);
});

/* ---------------- invoice + descriptor (pinned) ---------------- */

test("fixture descriptor hash is pinned", () => {
  const d = R.buildDescriptor(FIXTURE());
  assert.equal(d.hash, FIXTURE_HASH);
  assert.equal(d.descriptor, FIXTURE_DESCRIPTOR);
  assert.equal(d.canonical, '{"v":1,"invoicee":"Acme Studio","payerLabel":"Bob","items":[{"description":"Logo design","grains":"150000000"},{"description":"Revisions","grains":"25000000"}],"totalGrains":"175000000","dueUnix":1767225600,"memo":"test memo","address":"' + ADDR + '","hrp":"prl"}');
});
test("descriptor without due date omits the last field", () => {
  const inv = R.buildInvoice({ invoicee: "X", items: [{ description: "a", amountPRL: "2" }], address: ADDR });
  const d = R.buildDescriptor(inv);
  assert.match(d.descriptor, /^pearl-invoice:v1:prl:[0-9a-f]{64}:\d+$/);
  const parsed = R.parseDescriptor(d.descriptor);
  assert.equal(parsed.dueUnix, null);
  const v = R.verifyInvoice(d.descriptor, d.canonical);
  assert.equal(v.proven, true);
});
test("empty line items are refused", () => {
  assert.throws(() => R.buildInvoice({ invoicee: "X", items: [], address: ADDR }), /at least one line item/);
});
test("sub-dust totals are refused", () => {
  assert.throws(
    () => R.buildInvoice({ invoicee: "X", items: [{ description: "tip", amountPRL: "0.00000001" }], address: ADDR }),
    /dust floor/
  );
  assert.throws(
    () => R.buildInvoice({ invoicee: "X", items: [{ description: "tip", amountPRL: "0.00000545" }], address: ADDR }),
    /dust floor/
  );
});
test("545 grains refused, 546 accepted", () => {
  const justDust = R.buildInvoice({ invoicee: "X", items: [{ description: "a", amountPRL: "0.00000546" }], address: ADDR });
  assert.equal(justDust.totalGrains, "546");
});
test("invalid address is loudly refused at build time", () => {
  assert.throws(
    () => R.buildInvoice({ invoicee: "X", items: [{ description: "a", amountPRL: "1" }], address: "junk" }),
    /Not a valid Pearl Taproot address/
  );
});
test("canonical JSON is order-independent across item order", () => {
  const a = R.buildInvoice({
    invoicee: "Y", items: [{ description: "b", amountPRL: "1" }, { description: "a", amountPRL: "2" }], address: ADDR,
  });
  const b = R.buildInvoice({
    invoicee: "Y", items: [{ description: "a", amountPRL: "2" }, { description: "b", amountPRL: "1" }], address: ADDR,
  });
  assert.equal(R.buildDescriptor(a).hash, R.buildDescriptor(b).hash);
});

/* ---------------- standalone verifier ---------------- */

test("verifyInvoice: PROVEN on the pinned fixture", () => {
  const inv = FIXTURE();
  const d = R.buildDescriptor(inv);
  const v = R.verifyInvoice(d.descriptor, d.canonical);
  assert.equal(v.proven, true);
  assert.equal(v.hash, FIXTURE_HASH);
});
test("verifyInvoice: LOUD NOT PROVEN on any tampering", () => {
  const inv = FIXTURE();
  const d = R.buildDescriptor(inv);
  const tampered = JSON.parse(d.canonical);
  tampered.memo = "test MEMO changed";
  const v = R.verifyInvoice(d.descriptor, JSON.stringify(tampered));
  assert.equal(v.proven, false);
  assert.match(v.reason, /hash mismatch/);
  // descriptor edited directly
  const evil = d.descriptor.replace(":175000000:", ":999000000:");
  const v2 = R.verifyInvoice(evil, d.canonical);
  assert.equal(v2.proven, false);
  assert.match(v2.reason, /total grains/);
  // swapped due date
  const inv2 = FIXTURE(); inv2.dueUnix = 1767225601;
  const d2 = R.buildDescriptor(inv2);
  const v3 = R.verifyInvoice(d2.descriptor, d.canonical);
  assert.equal(v3.proven, false);
});
test("verifyInvoice: malformed descriptor refused", () => {
  const v = R.verifyInvoice("garbage", "{}");
  assert.equal(v.proven, false);
  assert.match(v.reason, /malformed/);
});
test("verifyInvoice: descriptor from a different invoice is NOT PROVEN", () => {
  const d1 = R.buildDescriptor(FIXTURE());
  const other = R.buildInvoice({ invoicee: "Other", items: [{ description: "x", amountPRL: "3" }], address: ADDR });
  const d2 = R.buildDescriptor(other);
  const v = R.verifyInvoice(d1.descriptor, d2.canonical);
  assert.equal(v.proven, false);
});

/* ---------------- receipts ---------------- */

test("receipt round-trip + pinned values", () => {
  const r = R.buildReceipt(FIXTURE_HASH, "a".repeat(64), "175000000", 6);
  assert.equal(r.receipt, `pearl-invoice-receipt:v1:${FIXTURE_HASH}:${"a".repeat(64)}:175000000`);
  assert.equal(r.receiptHash, "7d033716db63609b986ba16ba080c3b0a93aa873dde5ff475924a9854399b3e7");
  const v = R.verifyReceipt(r.receipt, { invoiceHash: FIXTURE_HASH, txid: "a".repeat(64), paidGrains: "175000000" });
  assert.equal(v.proven, true);
});
test("receipt tampering is LOUD", () => {
  const r = R.buildReceipt(FIXTURE_HASH, "a".repeat(64), "175000000", 6);
  const v = R.verifyReceipt(r.receipt, { invoiceHash: FIXTURE_HASH, txid: "a".repeat(64), paidGrains: "175000001" });
  assert.equal(v.proven, false);
  assert.match(v.reason, /paid grains/);
  const v2 = R.verifyReceipt("junk", {});
  assert.equal(v2.proven, false);
});

/* ---------------- payment URI ---------------- */

test("paymentURI is BIP-21 style with exact amount", () => {
  assert.equal(R.paymentURI(ADDR, 175000000n), `pearl:${ADDR}?amount=1.75`);
});
test("paymentURI refuses bad address", () => {
  assert.throws(() => R.paymentURI("junk", 1n), /Not a valid Pearl Taproot address/);
});

/* ---------------- payment analysis ---------------- */

const TX = (txid, conf, vals) => ({
  txid,
  confirmations: conf,
  vout: vals.map((v) => ({ addresses: [ADDR], value: String(v) })),
});
test("analyzePayments: unpaid / partial / paid / overpaid", () => {
  const none = R.analyzePayments([], ADDR, 100000n);
  assert.equal(none.state, "unpaid");
  assert.equal(none.receivedGrains, "0");
  assert.equal(none.remainingGrains, "100000");
  const partial = R.analyzePayments([TX("a".repeat(64), 2, [30000])], ADDR, 100000n);
  assert.equal(partial.state, "partial");
  assert.equal(partial.receivedGrains, "30000");
  assert.equal(partial.remainingGrains, "70000");
  const paid = R.analyzePayments([TX("a".repeat(64), 2, [30000]), TX("b".repeat(64), 0, [70000])], ADDR, 100000n);
  assert.equal(paid.state, "paid");
  assert.equal(paid.remainingGrains, "0");
  assert.equal(paid.payments[1].confirmations, 0);
  const over = R.analyzePayments([TX("c".repeat(64), 5, [120000])], ADDR, 100000n);
  assert.equal(over.state, "overpaid");
  assert.equal(over.overpaidGrains, "20000");
});
test("analyzePayments ignores outputs to other addresses", () => {
  const tx = { txid: "d".repeat(64), confirmations: 3, vout: [{ addresses: ["prl1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"], value: "99999" }] };
  const a = R.analyzePayments([tx], ADDR, 100000n);
  assert.equal(a.state, "unpaid");
});

/* ---------------- Blockbook base + derivation ---------------- */

test("normalizeBlockbookBase strips slash, refuses bare host", () => {
  assert.equal(R.normalizeBlockbookBase("https://blockbook.pearlresearch.ai/"), "https://blockbook.pearlresearch.ai");
  assert.throws(() => R.normalizeBlockbookBase("blockbook.pearlresearch.ai"), /http\(s\)/);
});
test("deriveInvoiceAddress is pinned (BIP-86 account 9001)", () => {
  const w = R.deriveInvoiceAddress(MNEMO, "prl", 0);
  assert.equal(w.address, "prl1pj05kqvekpwaa6880l6fcr3sqzv4r7a65ms5pt3qmt6dpr92lj8hqnngdlv");
  assert.equal(w.path, "m/86'/808276'/9001'/0/0");
  const w1 = R.deriveInvoiceAddress(MNEMO, "prl", 1);
  assert.equal(w1.address, "prl1pywu4gy8u8p847wcufp4lwfwjc0lmshxm5n3sslwzw6fjeyv60k0stl2k8t");
  assert.throws(() => R.deriveInvoiceAddress("not a mnemonic", "prl", 0), /mnemonic/);
});

/* ---------------- exports ---------------- */

test("invoiceToCSV / JSON export carry invoice + descriptor + receipt", () => {
  const inv = FIXTURE();
  const d = R.buildDescriptor(inv);
  const r = R.buildReceipt(d.hash, "a".repeat(64), d.descriptor ? "175000000" : "0", 6);
  const csv = R.invoiceToCSV(inv, d, r);
  assert.match(csv, /Acme Studio/);
  assert.match(csv, /pearl-invoice-receipt:v1:/);
  const json = JSON.parse(R.invoiceToJSONExport(inv, d, r));
  assert.equal(json.descriptor, d.descriptor);
  assert.equal(json.receipt.receipt, r.receipt);
});
