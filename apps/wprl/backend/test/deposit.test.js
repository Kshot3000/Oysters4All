import test from "node:test";
import assert from "node:assert/strict";
import { verifyDeposit, parseOpReturnDestination } from "../deposit.js";

const VAULT = "prl1vault000000000000000000000000000000000000";
const FEE = "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d";
const EVM_USER = "0x4b6f3BC697D9dAF3e8dE182aEc56eD208B9087f1";

// OP_RETURN hex for `wprl:0x4b6f...f1`: 6a (OP_RETURN) + push len + utf8 bytes.
function opReturnHex(text) {
  const data = Buffer.from(text, "utf8");
  if (data.length > 75) throw new Error("too long for direct push");
  return "6a" + data.length.toString(16).padStart(2, "0") + data.toString("hex");
}

const OPTS = {
  vaultAddress: VAULT,
  prlFeeAddress: FEE,
  minConfirmations: 6,
  minDepositGrains: 100000n,
  feeBps: 25,
};

function depositTx({ confirmations = 10, vaultValue = 1.0, feeValue = 0.0025, opReturn = `wprl:${EVM_USER}` } = {}) {
  return {
    txid: "aa".repeat(32),
    confirmations,
    vout: [
      { n: 0, value: vaultValue, scriptPubKey: { addresses: [VAULT], type: "witness_v0_keyhash" } },
      { n: 1, value: feeValue, scriptPubKey: { addresses: [FEE], type: "witness_v0_keyhash" } },
      { n: 2, value: 0, scriptPubKey: { hex: opReturnHex(opReturn), type: "nulldata" } },
    ],
  };
}

test("valid deposit verifies with exact mint amount", () => {
  const v = verifyDeposit(depositTx(), OPTS);
  assert.equal(v.ok, true);
  assert.equal(v.user, EVM_USER);
  assert.equal(v.depositGrains, 100_000_000n);
  assert.equal(v.feeGrains, 250_000n);
  assert.equal(v.mintWei, 1_000_000_000_000_000_000n); // 1 wPRL
});

test("under-confirmed deposit is rejected", () => {
  const v = verifyDeposit(depositTx({ confirmations: 3 }), OPTS);
  assert.equal(v.ok, false);
  assert.match(v.reason, /confirmations/);
  assert.equal(v.manualReview, undefined); // not held — just too young
});

test("missing fee output -> held for manual review", () => {
  const v = verifyDeposit(depositTx({ feeValue: 0.0001 }), OPTS);
  assert.equal(v.ok, false);
  assert.equal(v.manualReview, true);
  assert.match(v.reason, /fee output/);
  assert.equal(v.user, EVM_USER); // user known, so a human can decide
});

test("fee paid to the WRONG address does not count", () => {
  const tx = depositTx();
  tx.vout[1].scriptPubKey.addresses = ["prl1attacker0000000000000000000000000000"];
  const v = verifyDeposit(tx, OPTS);
  assert.equal(v.ok, false);
  assert.equal(v.manualReview, true);
});

test("missing OP_RETURN -> held for manual review (funds safe in vault)", () => {
  const tx = depositTx();
  tx.vout.pop();
  const v = verifyDeposit(tx, OPTS);
  assert.equal(v.ok, false);
  assert.equal(v.manualReview, true);
  assert.match(v.reason, /OP_RETURN/);
  assert.equal(v.depositGrains, 100_000_000n); // recorded for the human reviewer
});

test("malformed OP_RETURN destination is rejected", () => {
  const v = verifyDeposit(depositTx({ opReturn: "wprl:not-an-address" }), OPTS);
  assert.equal(v.ok, false);
  assert.equal(v.manualReview, true);
});

test("dust deposit below minimum is rejected", () => {
  const v = verifyDeposit(depositTx({ vaultValue: 0.0000005 }), OPTS); // 50 grains
  assert.equal(v.ok, false);
  assert.match(v.reason, /below minimum/);
});

test("multiple vault outputs are summed", () => {
  const tx = depositTx({ vaultValue: 0.6 });
  tx.vout.unshift({ n: 3, value: 0.4, scriptPubKey: { addresses: [VAULT], type: "witness_v0_keyhash" } });
  const v = verifyDeposit(tx, OPTS);
  assert.equal(v.ok, true);
  assert.equal(v.depositGrains, 100_000_000n);
});

test("fee requirement scales with deposit size (ceil)", () => {
  // 0.00000401 PRL = 401 grains -> fee ceil(401*25/10000) = 2 grains = 0.00000002 PRL
  const v = verifyDeposit(
    depositTx({ vaultValue: 0.00000401, feeValue: 0.00000002, opReturn: `wprl:${EVM_USER}` }),
    { ...OPTS, minDepositGrains: 1n }
  );
  assert.equal(v.ok, true);
  assert.equal(v.feeGrains, 2n);
});

test("parseOpReturnDestination handles push opcodes and garbage", () => {
  assert.equal(
    parseOpReturnDestination({ scriptPubKey: { type: "nulldata", hex: opReturnHex(`wprl:${EVM_USER}`) } }),
    EVM_USER
  );
  assert.equal(parseOpReturnDestination({ scriptPubKey: { type: "nulldata", hex: "6a" } }), null);
  assert.equal(parseOpReturnDestination({ scriptPubKey: { type: "nulldata", hex: "zzzz" } }), null);
  assert.equal(parseOpReturnDestination({ scriptPubKey: { type: "witness_v0_keyhash", hex: "0014" + "ab".repeat(20) } }), null);
  assert.equal(parseOpReturnDestination({}), null);
});
