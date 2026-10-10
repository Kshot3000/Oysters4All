// Pearl Split core tests: member validation, expense split math (equal /
// shares / percent, grain-exact with deterministic remainder), balance
// computation, greedy minimal-transfer optimality, dust refusal, per-debtor
// funding (grain-exact: inputs == outputs + fee + change), bundle
// export/import tamper-evidence, and a full local sign + Schnorr
// re-verification of a debtor settlement.
// Usage: node --no-warnings --loader ./tests/loader.mjs tests/split.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import * as S from "../src/split-core.js";

const NET = S.NETWORKS.mainnet;
const addr = (tag) => S.encodeBech32m("prl", 1, S.sha256(new TextEncoder().encode(tag)));
const A = ["split-a", "split-b", "split-c", "split-d", "split-e"].map(addr);
const NAMES = ["Hank", "Jolene", "Marv", "Polly", "Bea"];
const members = (n = 3) => NAMES.slice(0, n).map((name, i) => ({ name, address: A[i] }));
const tab = (n = 3) => ({ members: members(n), network: NET });
const G = (prl) => S.parsePRL(String(prl));

/* Raw bech32m encoder without the v1-only guard (crafts a witness-v0 address
 * the app must refuse). Mirrors the audited checksum math from crypto.js —
 * test helper only, not app cryptography. */
function encodeBech32mRaw(hrp, version, program) {
  const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  const hrpX = [];
  for (const c of hrp) hrpX.push(c.charCodeAt(0) >>> 5);
  hrpX.push(0);
  for (const c of hrp) hrpX.push(c.charCodeAt(0) & 31);
  const words = S.convertBits([version, ...program], 8, 5, true);
  let chk = 1;
  for (const v of [...hrpX, ...words, 0, 0, 0, 0, 0, 0]) {
    const b = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >>> i) & 1) chk ^= GEN[i];
  }
  const mod = chk ^ 0x2bc830a3;
  const cs = [];
  for (let i = 0; i < 6; i++) cs.push((mod >>> (5 * (5 - i))) & 31);
  return hrp + "1" + [...words, ...cs].map((v) => CHARSET[v]).join("");
}

/* ---------- member validation ---------- */

test("validateMember accepts a real v1 Taproot address", () => {
  const m = S.validateMember("Hank", A[0], NET);
  assert.equal(m.name, "Hank");
  assert.equal(m.address, A[0]);
  assert.equal(m.program.length, 32);
});

test("validateMember rejects blank names, dupes handled by validateMembers", () => {
  assert.throws(() => S.validateMember("", A[0], NET), /blank/);
});

test("validateMember rejects non-v1 / bad-hrp addresses", () => {
  assert.throws(() => S.validateMember("Hank", "notanaddress", NET), /invalid address/i);
  const v0addr = encodeBech32mRaw("prl", 0, S.sha256(new TextEncoder().encode("x")));
  assert.throws(() => S.validateMember("Hank", v0addr, NET), /taproot/i);
  const tprl = S.encodeBech32m("tprl", 1, S.sha256(new TextEncoder().encode("x")));
  assert.throws(() => S.validateMember("Hank", tprl, NET), /invalid address/i);
});

test("validateMembers refuses duplicates and short tabs", () => {
  assert.throws(() => S.validateMembers([{ name: "A", address: A[0] }], NET), /at least two members/);
  assert.throws(() => S.validateMembers([{ name: "A", address: A[0] }, { name: "B", address: A[0] }], NET), /duplicate member address/);
  assert.throws(() => S.validateMembers([{ name: "A", address: A[0] }, { name: "a", address: A[1] }], NET), /duplicate member name/);
});

/* ---------- expense split math ---------- */

test("equal split: remainder grains go to the first members by index, grain-exact", () => {
  // 100 grains among 3 → 34, 33, 33
  const lines = S.splitExpense(100n, { mode: "equal", memberIdxs: [0, 1, 2] });
  assert.deepEqual(lines.map((l) => l.grains), [34n, 33n, 33n]);
  assert.equal(lines.reduce((a, l) => a + l.grains, 0n), 100n);
});

test("equal split on a selected subset only", () => {
  const lines = S.splitExpense(10n, { mode: "equal", memberIdxs: [1, 2] });
  assert.deepEqual(lines.map((l) => [l.memberIdx, l.grains]), [[1, 5n], [2, 5n]]);
});

test("shares split: weighted, floored, remainder to first members by index", () => {
  // 100 grains, shares 2:1 → floor: 66, 33, leftover 1 → first member
  const lines = S.splitExpense(100n, { mode: "shares", memberIdxs: [0, 1], shares: ["2", "1"] });
  assert.deepEqual(lines.map((l) => l.grains), [67n, 33n]);
  assert.throws(() => S.splitExpense(100n, { mode: "shares", memberIdxs: [0, 1], shares: ["2"] }), /must match/);
  assert.throws(() => S.splitExpense(100n, { mode: "shares", memberIdxs: [0, 1], shares: ["0", "1"] }), /positive/);
});

test("percent split: exact-100 enforced, remainder to first members by index", () => {
  // 101 grains at 60/40 → 60.6, 40.4 floored: 60, 40, leftover 1 → first
  const lines = S.splitExpense(101n, { mode: "percent", memberIdxs: [0, 1], percents: ["60", "40"] });
  assert.deepEqual(lines.map((l) => l.grains), [61n, 40n]);
  assert.throws(() => S.splitExpense(100n, { mode: "percent", memberIdxs: [0, 1], percents: ["60", "30"] }), /exactly 100/);
  assert.throws(() => S.splitExpense(100n, { mode: "percent", memberIdxs: [0, 1], percents: ["110", "-10"] }), /bad percentage|over 100/);
});

test("addExpense wires members + payer + grain-exactness together", () => {
  const e = S.addExpense(tab(), {
    desc: "Steakhouse bill", amountPRL: "0.00001", payerIdx: 0,
    mode: "equal", memberIdxs: [0, 1, 2],
  });
  assert.equal(e.desc, "Steakhouse bill");
  assert.equal(BigInt(e.totalGrains), G("0.00001"));
  assert.equal(e.lines.reduce((a, l) => a + l.grains, 0n), G("0.00001"));
  // first member by index gets the remainder grain
  assert.equal(e.lines[0].grains, 334n);
  assert.throws(() => S.addExpense(tab(), { desc: "x", amountPRL: "1", payerIdx: 9, mode: "equal", memberIdxs: [0, 1] }), /not a member/);
  assert.throws(() => S.addExpense(tab(), { desc: "x", amountPRL: "0", payerIdx: 0, mode: "equal", memberIdxs: [0, 1] }), /positive/);
  assert.throws(() => S.addExpense(tab(), { desc: "x", amountPRL: "1", payerIdx: 0, mode: "equal", memberIdxs: [0, 0] }), /twice/);
});

/* ---------- balances + minimal transfers ---------- */

function expensesFixture() {
  const t = tab(3);
  return [
    S.addExpense(t, { desc: "dinner", amountPRL: "1", payerIdx: 0, mode: "equal", memberIdxs: [0, 1, 2] }),
    S.addExpense(t, { desc: "taxi", amountPRL: "0.6", payerIdx: 2, mode: "shares", memberIdxs: [0, 1, 2], shares: ["1", "1", "2"] }),
  ];
}

test("computeBalances nets expenses exactly and sums to zero", () => {
  const bal = S.computeBalances(members(3), expensesFixture());
  assert.equal(bal.reduce((a, b) => a + b, 0n), 0n);
  // dinner 1 PRL equal: A1 +66666667, A2 -33333333, A3 -33333333 (1 PRL = 100000000 grains)
  // taxi 0.6 PRL shares 1:1:2 (60000000 grains): floored 15000000,15000000,30000000 exact
  // A1: +100000000 - 33333334 - 15000000 = 51666666
  // A2: -33333333 - 15000000 = -48333333
  // A3: +60000000 - 33333333 - 30000000 = -3333333
  assert.deepEqual(bal, [51666666n, -48333333n, -3333333n]);
});

test("minimizeTransfers is count-minimal on the fixture (2 debtors, 1 creditor)", () => {
  const bal = S.computeBalances(members(3), expensesFixture());
  const ts = S.minimizeTransfers(bal);
  assert.equal(ts.length, 2, "two debtors can only be cleared with two transfers");
  const check = new Map();
  for (const t of ts) {
    assert.ok(t.grains > 0n, "transfer amounts positive");
    check.set(t.from, (check.get(t.from) ?? 0n) + BigInt(t.grains));
  }
  assert.deepEqual([...check.entries()].sort(), [[1, 48333333n], [2, 3333333n]]);
  assert.equal(ts.filter((t) => t.to === 0).reduce((a, t) => a + BigInt(t.grains), 0n), 51666666n);
});

test("minimizeTransfers on a 5-member ring needs exactly 4 transfers", () => {
  // 4 debtors owe 1 grain-net pair: balances [100, -25, -25, -25, -25] grains
  const ts = S.minimizeTransfers([100n, -25n, -25n, -25n, -25n]);
  assert.equal(ts.length, 4);
  const paid = ts.reduce((a, t) => a + BigInt(t.grains), 0n);
  assert.equal(paid, 100n);
  // every transfer zeroes a debtor (count-minimal: each transfer clears exactly one debtor)
  const debtors = new Set(ts.map((t) => t.from));
  assert.equal(debtors.size, 4);
});

test("minimizeTransfers handles empty balances (tab nets to zero)", () => {
  assert.deepEqual(S.minimizeTransfers([0n, 0n]), []);
});

/* ---------- dust refusal ---------- */

test("dust policy refuses sub-546-grain transfers loudly", () => {
  const t = S.settleTab({
    tabName: "tiny", members: members(2), network: NET,
    expenses: [S.addExpense(tab(2), { desc: "coffee", amountPRL: "0.000005", payerIdx: 0, mode: "equal", memberIdxs: [0, 1] })],
  });
  // 500 grains total, 250/250 split → both balances ±250, transfer = 250 grains < 546
  assert.equal(t.blocked.length, 1);
  assert.equal(t.payable.length, 0);
  assert.ok(t.blocked[0].reason.includes("dust floor"));
});

test("dust policy passes honest-sized transfers", () => {
  const t = S.settleTab({ tabName: "steak", members: members(2), network: NET,
    expenses: [S.addExpense(tab(2), { desc: "steak", amountPRL: "0.001", payerIdx: 0, mode: "equal", memberIdxs: [0, 1] })] });
  assert.equal(t.blocked.length, 0);
  assert.equal(t.payable.length, 1);
  assert.equal(t.payable[0].grains, "50000");
  assert.equal(t.fingerprint.length, 16);
  assert.equal(t.descriptor.kind, "pearlsplit:v1:");
});

/* ---------- settlement end-to-end + descriptor determinism ---------- */

test("settleTab is deterministic: same input → same fingerprint", () => {
  const mk = () => S.settleTab({ tabName: "steak night", members: members(3), network: NET, expenses: expensesFixture() });
  assert.equal(mk().fingerprint, mk().fingerprint);
});

/* ---------- per-debtor funding: grain-exactness ---------- */

const DEBTOR_PRIV = "cd".repeat(32);

test("funding is grain-exact: inputs == outputs + fee + change", () => {
  const debtorSecret = S.parseBatchSecret(DEBTOR_PRIV, NET);
  const members2 = [
    { name: "Deb", address: debtorSecret.address },
    { name: "Cred", address: A[1] },
  ];
  const transfers = [{ from: 0, to: 1, grains: String(G("0.01")) }];
  const plans = S.debtorPlans(transfers, members2, NET);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].debtorAddress, debtorSecret.address);
  const utxos = [{ txid: "ab".repeat(32), vout: 0, value: Number(G("0.05")), confirmations: 3 }];
  const plan = S.fundSettlement({ network: NET, debtorPlan: plans[0], utxos, feeRateGrainsPerVByte: 2 });
  assert.equal(plan.total, plan.sumOut + plan.fee + plan.change);
  assert.equal(plan.fee, BigInt(plan.vBytes) * 2n);
  const recipients = plan.outputs.filter((o) => !o.change);
  assert.equal(recipients.length, 1);
  assert.equal(recipients[0].address, A[1]);
});

test("funding refuses loudly on short funds", () => {
  const debtorSecret = S.parseBatchSecret(DEBTOR_PRIV, NET);
  const plans = S.debtorPlans(
    [{ from: 0, to: 1, grains: String(G("1")) }],
    [{ name: "Deb", address: debtorSecret.address }, { name: "Cred", address: A[1] }], NET);
  const utxos = [{ txid: "ab".repeat(32), vout: 0, value: Number(G("0.001")), confirmations: 0 }];
  assert.throws(() => S.fundSettlement({ network: NET, debtorPlan: plans[0], utxos, feeRateGrainsPerVByte: 2 }), /insufficient funds/);
});

/* ---------- bundle export/import + tamper evidence ---------- */

test("bundle round-trips and imports cleanly", () => {
  const debtorSecret = S.parseBatchSecret(DEBTOR_PRIV, NET);
  const plans = S.debtorPlans(
    [{ from: 0, to: 1, grains: String(G("0.01")) }],
    [{ name: "Deb", address: debtorSecret.address }, { name: "Cred", address: A[1] }], NET);
  const utxos = [{ txid: "ab".repeat(32), vout: 0, value: Number(G("0.05")), confirmations: 3 }];
  const plan = S.fundSettlement({ network: NET, debtorPlan: plans[0], utxos, feeRateGrainsPerVByte: 2 });
  const bundle = S.exportSplitBundle({ network: NET, debtorPlan: plans[0], tabFingerprint: "aa".repeat(8), plan, feeRate: 2 });
  assert.equal(bundle.bundle, "pearl-split-unsigned:v1:");
  const imp = S.importSplitBundle(bundle);
  assert.equal(imp.fingerprint, bundle.fingerprint);
  assert.equal(imp.plan.total, plan.total);
});

test("bundle import refuses tampered descriptors", () => {
  const debtorSecret = S.parseBatchSecret(DEBTOR_PRIV, NET);
  const plans = S.debtorPlans(
    [{ from: 0, to: 1, grains: String(G("0.01")) }],
    [{ name: "Deb", address: debtorSecret.address }, { name: "Cred", address: A[1] }], NET);
  const utxos = [{ txid: "ab".repeat(32), vout: 0, value: Number(G("0.05")), confirmations: 3 }];
  const plan = S.fundSettlement({ network: NET, debtorPlan: plans[0], utxos, feeRateGrainsPerVByte: 2 });
  const bundle = S.exportSplitBundle({ network: NET, debtorPlan: plans[0], tabFingerprint: "aa".repeat(8), plan, feeRate: 2 });
  const evil = JSON.parse(JSON.stringify(bundle));
  evil.descriptor.recipients[0].amountGrains = String(Number(evil.descriptor.recipients[0].amountGrains) + 1);
  assert.throws(() => S.importSplitBundle(evil), /FINGERPRINT MISMATCH/);
});

test("bundle import refuses wrong kind tags", () => {
  assert.throws(() => S.importSplitBundle({ bundle: "pearl-batch-unsigned:v1:" }), /not a Pearl Split unsigned bundle/);
});

/* ---------- full sign flow: real Schnorr + local re-verification ---------- */

test("buildSettlementTx signs with per-signature local re-verification", () => {
  const debtorSecret = S.parseBatchSecret(DEBTOR_PRIV, NET);
  const plans = S.debtorPlans(
    [{ from: 0, to: 1, grains: String(G("0.01")) }, { from: 0, to: 2, grains: String(G("0.02")) }],
    [{ name: "Deb", address: debtorSecret.address }, { name: "C1", address: A[1] }, { name: "C2", address: A[2] }], NET);
  const utxos = [{ txid: "ab".repeat(32), vout: 0, value: Number(G("0.05")), confirmations: 3 }];
  const plan = S.fundSettlement({ network: NET, debtorPlan: plans[0], utxos, feeRateGrainsPerVByte: 2 });
  const { txid, hex } = S.buildSettlementTx({ secret: debtorSecret, debtorAddress: debtorSecret.address, utxos, plan, network: NET });
  assert.match(txid, /^[0-9a-f]{64}$/);
  assert.ok(hex.length > 100);
  // every signature re-verifies locally before the hex is exposed (buildBatchTx throws otherwise)
  const dec = S.decodeRawTx(hex);
  const spk = (() => { const h = new Uint8Array(34); h[0] = 0x51; h[1] = 0x20; h.set(plans[0].senderProgram, 2); return h; })();
  const checks = S.verifySignedTx(NET, hex, [{ value: Number(G("0.05")), spk }]);
  assert.equal(checks.length, 1);
  assert.ok(checks.every((c) => c.ok));
  const outSum = dec.outputs.reduce((a, o) => a + o.value, 0n);
  assert.equal(BigInt(utxos[0].value), outSum + plan.fee, "sum of outputs + fee == sum of inputs");
});

test("buildSettlementTx refuses a key that does not control the debtor address", () => {
  const debtorSecret = S.parseBatchSecret(DEBTOR_PRIV, NET);
  const other = S.parseBatchSecret("ef".repeat(32), NET);
  const plans = S.debtorPlans(
    [{ from: 0, to: 1, grains: String(G("0.01")) }],
    [{ name: "Deb", address: debtorSecret.address }, { name: "C1", address: A[1] }], NET);
  const utxos = [{ txid: "ab".repeat(32), vout: 0, value: Number(G("0.05")), confirmations: 3 }];
  const plan = S.fundSettlement({ network: NET, debtorPlan: plans[0], utxos, feeRateGrainsPerVByte: 2 });
  assert.throws(() => S.buildSettlementTx({ secret: other, debtorAddress: debtorSecret.address, utxos, plan, network: NET }), /DOES NOT CONTROL/);
});

/* ---------- ledger helpers ---------- */

test("ledger save/load round-trips and CSV exports balances", () => {
  const mem = {};
  const store = { getItem: (k) => mem[k] ?? null, setItem: (k, v) => { mem[k] = v; } };
  const l = S.loadLedger(store);
  assert.deepEqual(l, { tabs: [] });
  l.tabs.push({
    tabName: "steak night", fingerprint: "ff".repeat(8), network: "mainnet",
    members: [{ name: "A", address: A[0] }, { name: "B", address: A[1] }],
    expenses: [], balances: [{ member: "A", grains: "100" }, { member: "B", grains: "-100" }],
    transfers: [],
  });
  S.saveLedger(store, l);
  assert.equal(S.loadLedger(store).tabs.length, 1);
  const csv = S.ledgerToCsv(S.loadLedger(store));
  assert.ok(csv.includes("steak night") && csv.includes("creditor") && csv.includes("debtor"));
});

test("ledger load tolerates corrupt storage", () => {
  const store = { getItem: () => "not json{", setItem: () => {} };
  assert.deepEqual(S.loadLedger(store), { tabs: [] });
});

test("ledgerToCsv: spreadsheet formula-injection guard (CWE-1236)", () => {
  const csv = S.ledgerToCsv({ tabs: [{ tabName: "=2+2", fingerprint: "ff", members: [{ name: "@evil", address: "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d" }], balances: [{ grains: "-100" }] }] });
  assert.ok(csv.includes("\"'=2+2\""), "tab name formula cell prefixed");
  assert.ok(csv.includes("\"'@evil\""), "member name formula cell prefixed");
  assert.ok(csv.includes("\"-100\""), "plain negative balance untouched");
});
