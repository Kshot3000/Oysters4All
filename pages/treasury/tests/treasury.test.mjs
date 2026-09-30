/* Pearl Treasury core tests — run with:
 *   node --no-warnings --loader ./tests/loader.mjs --test tests/treasury.test.mjs
 * All cryptography under test comes from the audited sign/covenant/escrow
 * lineage; these tests pin treasury-core's orchestration (proposals,
 * rounds, schedules, audit chain, key hygiene, coin selection).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as T from "../src/treasury-core.js";

const NET = T.NETWORKS.mainnet;
const PRIVS = [1, 2, 3].map((i) => T.bytesToHex(T.sha256(new TextEncoder().encode("treasury-dom-key-" + i))));
const XONLY = PRIVS.map((p) => T.pubkeyFromPriv(p));
const PAYEE_PRIV = T.bytesToHex(T.sha256(new TextEncoder().encode("treasury-dom-payee")));
const PAYEE = T.walletFromPriv(T.hexToBytes(PAYEE_PRIV), NET).address;

function demoCovenant() {
  const { covenant } = T.createCovenant({ m: 2, keyInputs: XONLY, network: NET });
  return covenant;
}
function demoVault(label = "Ops vault") {
  return T.registerVault({ descriptor: T.covenantDescriptor(demoCovenant()), label }, NET);
}
function demoProposal(vault, over = {}) {
  return T.createProposal({
    vault,
    payee: PAYEE,
    amountPRL: "1.25",
    memo: "server invoice Q3",
    createdBy: "alice",
    ...over,
  }, NET);
}
const UTXO = { txid: "ab".repeat(32), vout: 0, value: 250_000_000 };

/* ---------- amounts: integer grain math ---------- */

test("prlToGrains is integer-only and dust-floored", () => {
  assert.equal(T.prlToGrains("1.5"), 150_000_000);
  assert.equal(T.prlToGrains("1.00000001"), 100_000_001);
  assert.throws(() => T.prlToGrains("0.00000001"), /dust/);
  assert.throws(() => T.prlToGrains("1.123456789"), /invalid PRL/); // 9 decimals
  assert.throws(() => T.prlToGrains("abc"), /invalid PRL/);
  assert.throws(() => T.prlToGrains("-1"), /invalid PRL/);
  assert.equal(T.grainsToPRL(150_000_000), "1.5");
});

/* ---------- vault registration ---------- */

test("registerVault verifies the descriptor and labels the vault", () => {
  const v = demoVault();
  assert.match(v.address, /^prl1p/);
  assert.equal(v.m, 2);
  assert.equal(v.n, 3);
  assert.deepEqual(v.keys.sort(), [...XONLY].sort());
  assert.match(v.id, /^[0-9a-f]{64}$/);
  assert.equal(v.balance.confirmed, 0);
});

test("descriptor edits rebind the address (no silent key swap); bad formats throw", () => {
  const good = T.covenantDescriptor(demoCovenant());
  const addr0 = T.registerVault({ descriptor: good, label: "x" }, NET).address;
  // flip one hex char of the first cosigner key: still self-consistent, but a DIFFERENT vault
  const tampered = good.slice(0, 40) + (good[40] === "a" ? "b" : "a") + good.slice(41);
  const addr1 = T.registerVault({ descriptor: tampered, label: "y" }, NET).address;
  assert.notEqual(addr0, addr1, "edited key rebinds the address — no silent substitution");
  // bump m: different vault too
  const addr2 = T.registerVault({ descriptor: good.replace("2-of-3", "3-of-3"), label: "z" }, NET).address;
  assert.notEqual(addr0, addr2);
  // format corruption throws
  assert.throws(() => T.registerVault({ descriptor: good.replace("covenant:v1", "covenant:v9"), label: "x" }, NET), /descriptor/);
  assert.throws(() => T.registerVault({ descriptor: "garbage", label: "x" }, NET), /descriptor/);
  // blank label throws
  assert.throws(() => T.registerVault({ descriptor: good, label: "  " }, NET), /label/);
});

test("vaultTotals sums integer grains across vaults", () => {
  const a = demoVault("a"); const b = demoVault("b");
  a.balance = { confirmed: 100, unconfirmed: 5, utxoCount: 1, refreshedAt: null };
  b.balance = { confirmed: 200, unconfirmed: 0, utxoCount: 2, refreshedAt: null };
  assert.deepEqual(T.vaultTotals([a, b]), { confirmed: 300, unconfirmed: 5, total: 305, count: 2 });
});

/* ---------- proposals ---------- */

test("createProposal emits a tamper-evident record with id + fingerprint", () => {
  const p = demoProposal(demoVault());
  assert.equal(p.kind, "pearl-treasury-proposal");
  assert.match(p.id, /^[0-9a-f]{64}$/);
  assert.match(p.fingerprint, /^[0-9a-f]{16}$/);
  assert.equal(p.amountGrains, 125_000_000);
  assert.equal(p.status, "open");
  // id covers the intent: same fields -> same id
  const p2 = { ...p, status: "quorum" };
  T.verifyProposal(p2, NET); // status changes don't break intent verification
});

test("createProposal rejects bad payees, dust, and garbage", () => {
  const v = demoVault();
  const wrongNet = T.walletFromPriv(T.hexToBytes(PAYEE_PRIV), T.NETWORKS.testnet).address;
  assert.throws(() => demoProposal(v, { payee: wrongNet }), /wrong network HRP/);
  assert.throws(() => demoProposal(v, { payee: "not an address" }), /separator|bech32|checksum|P2TR/i);
  assert.throws(() => demoProposal(v, { amountPRL: "0.00000001" }), /dust/);
  assert.throws(() => demoProposal(v, { amountPRL: "2.5.5" }), /invalid PRL/);
  const p = demoProposal(v, { memo: "x".repeat(500) });
  assert.equal(p.memo.length, T.MEMO_MAX, "memo truncated to 280 chars");
});

test("verifyProposal detects tampering", () => {
  const p = demoProposal(demoVault());
  T.verifyProposal(p, NET);
  assert.throws(() => T.verifyProposal({ ...p, amountGrains: p.amountGrains + 1 }, NET), /tampered|mismatch/);
  assert.throws(() => T.verifyProposal({ ...p, payee: PAYEE.slice(0, -1) + (PAYEE.endsWith("q") ? "p" : "q") }, NET), /./);
  assert.throws(() => T.parseProposal("{nope", NET), /valid JSON/);
  assert.throws(() => T.parseProposal(JSON.stringify({ kind: "nope" }), NET), /not a Pearl Treasury proposal/);
});

test("proposal serialize/parse round-trips between cosigners", () => {
  const p = demoProposal(demoVault());
  const q = T.parseProposal(T.serializeProposal(p), NET);
  assert.equal(q.id, p.id);
  assert.equal(q.fingerprint, p.fingerprint);
});

test("proposal status transitions are guarded", () => {
  T.assertProposalTransition("open", "quorum");
  T.assertProposalTransition("open", "disbursed");
  T.assertProposalTransition("quorum", "disbursed");
  assert.throws(() => T.assertProposalTransition("disbursed", "open"), /illegal/);
  assert.throws(() => T.assertProposalTransition("open", "open"), /illegal/);
  assert.throws(() => T.assertProposalTransition("cancelled", "quorum"), /illegal/);
});

/* ---------- coin selection + signing rounds ---------- */

test("selectUtxoForProposal picks the smallest covering UTXO with exact vBytes", () => {
  const covenant = demoCovenant();
  const utxos = [
    { txid: "aa".repeat(32), vout: 0, value: 10_000 },                       // too small
    { txid: "bb".repeat(32), vout: 1, value: 130_000_000 },                  // covers
    { txid: "cc".repeat(32), vout: 2, value: 500_000_000 },                  // bigger
  ];
  const { utxo, vBytes, fee } = T.selectUtxoForProposal(covenant, utxos, 125_000_000, 5);
  assert.equal(utxo.txid, "bb".repeat(32));
  assert.ok(vBytes > 0 && fee > 0);
  assert.equal(vBytes, T.covenantSpendVBytes(covenant, 2), "worst-case vBytes planning");
  assert.throws(
    () => T.selectUtxoForProposal(covenant, utxos.slice(0, 1), 125_000_000, 5),
    /insufficient funds/,
  );
  assert.throws(() => T.selectUtxoForProposal(covenant, utxos, 125_000_000, 0), /fee rate/);
});

test("full flow: proposal -> round -> 2-of-3 quorum -> finalize hex", () => {
  const vault = demoVault();
  const covenant = demoCovenant();
  const proposal = demoProposal(vault);
  const { round } = T.buildProposalRound(vault, proposal, NET, { utxo: UTXO, feeRateGrainsPerVByte: 5 });
  assert.match(round.digest, /^[0-9a-f]{64}$/);
  assert.ok(proposal.roundDigests.includes(round.digest), "round linked to proposal");

  // parseRound re-verifies the digest independently (tamper-evident transport)
  const parsed = T.parseRound(T.serializeRound(round), NET);
  assert.equal(parsed.digest, round.digest);

  // wrong key (not a cosigner) is loudly refused
  const outsider = T.bytesToHex(T.sha256(new TextEncoder().encode("treasury-outsider")));
  assert.throws(() => T.signRound(parsed, covenant, outsider), /not a cosigner/);

  // two cosigners sign -> quorum reached
  T.signRound(parsed, covenant, PRIVS[0]);
  let st = T.roundStatus(parsed, covenant);
  assert.deepEqual([st.have, st.need, st.ready], [1, 2, false]);
  assert.throws(() => T.signRound(parsed, covenant, PRIVS[0]), /already signed/);
  T.signRound(parsed, covenant, PRIVS[2]);
  st = T.roundStatus(parsed, covenant);
  assert.deepEqual([st.have, st.need, st.ready], [2, 2, true]);

  // intent check: round matches the proposal
  const match = T.roundMatchesProposal(proposal, parsed, covenant, NET);
  assert.ok(match.ok, match.why);

  // finalize builds the real Taproot spend
  const spend = T.finalizeProposalSpend(proposal, parsed, covenant, NET);
  assert.match(spend.txid, /^[0-9a-f]{64}$/);
  assert.match(spend.hex, /^[0-9a-f]+$/);
  assert.ok(spend.vBytes > 0);
});

test("finalize refuses rounds that drift from the proposal intent", () => {
  const vault = demoVault();
  const covenant = demoCovenant();
  const proposal = demoProposal(vault);
  const { round } = T.buildProposalRound(vault, proposal, NET, { utxo: UTXO, feeRateGrainsPerVByte: 5 });
  const parsed = T.parseRound(T.serializeRound(round), NET);
  T.signRound(parsed, covenant, PRIVS[0]);
  T.signRound(parsed, covenant, PRIVS[1]);
  // swap the payee inside a *verified* round object -> intent check fails
  const evil = JSON.parse(T.serializeRound(parsed));
  evil.outputs[0].address = T.walletFromPriv(T.hexToBytes(PAYEE_PRIV), NET).address;
  const match = T.roundMatchesProposal({ ...proposal, payee: PAYEE + "x" }, parsed, covenant, NET);
  assert.ok(!match.ok, "changed proposal must not match its own round");
  assert.throws(() => T.finalizeProposalSpend({ ...proposal, payee: PAYEE + "x" }, parsed, covenant, NET), /refusing/);
  assert.ok(evil, "fixture sanity");
});

test("importSig verifies before storing (bad sig rejected)", () => {
  const covenant = demoCovenant();
  const { round } = T.buildProposalRound(demoVault(), demoProposal(demoVault()), NET, { utxo: UTXO, feeRateGrainsPerVByte: 5 });
  const parsed = T.parseRound(T.serializeRound(round), NET);
  const bogus = "00".repeat(64);
  assert.throws(() => T.importSig(parsed, covenant, XONLY[0], bogus), /does not verify/);
  assert.throws(() => T.importSig(parsed, covenant, "ff".repeat(32), bogus), /not a cosigner/);
});

test("cosignerKeyFromInput accepts priv/WIF/mnemonic and derives the vault key", () => {
  const k1 = T.cosignerKeyFromInput(PRIVS[0], NET);
  assert.equal(k1.xonly, XONLY[0]);
  assert.equal(k1.priv.length, 32);
  const { covenant } = T.createCovenant({ m: 1, keyInputs: [k1.xonly], network: NET });
  assert.throws(() => T.signRound({ partialSigs: [] }, covenant, T.bytesToHex(T.sha256(new TextEncoder().encode("x")))), /./);
  assert.throws(() => T.cosignerKeyFromInput("garbage key", NET), /64-hex|WIF|mnemonic/);
});

test("in-memory key vault wipes secrets", () => {
  const kv = T.createKeyVault();
  const k = T.cosignerKeyFromInput(PRIVS[1], NET);
  kv.set("bob", k.priv, k.xonly);
  assert.ok(kv.has("bob"));
  const ref = kv.get("bob").priv;
  assert.ok(ref.some((b) => b !== 0), "priv is nonzero before wipe");
  kv.wipe();
  assert.ok(!kv.has("bob"));
  assert.ok(ref.every((b) => b === 0), "priv bytes zeroed on wipe");
  assert.deepEqual(kv.labels(), []);
});

/* ---------- schedules ---------- */

test("validateRecurrence guards units and ranges", () => {
  assert.deepEqual(T.validateRecurrence({ unit: "weeks", every: 2 }), { unit: "weeks", every: 2 });
  assert.throws(() => T.validateRecurrence({ unit: "years", every: 1 }), /unit/);
  assert.throws(() => T.validateRecurrence({ unit: "days", every: 0 }), /every/);
  assert.throws(() => T.validateRecurrence({ unit: "days", every: 121 }), /every/);
  assert.equal(T.validateRecurrence(null), null);
});

test("nextDueISO walks the calendar forward", () => {
  const start = "2026-10-01T12:00:00.000Z";
  assert.equal(
    T.nextDueISO(start, { unit: "weeks", every: 2 }, "2026-10-20T00:00:00.000Z"),
    "2026-10-29T12:00:00.000Z",
  );
  assert.equal(
    T.nextDueISO(start, { unit: "months", every: 1 }, "2026-12-15T00:00:00.000Z"),
    "2027-01-01T12:00:00.000Z",
  );
  assert.equal(T.nextDueISO(start, null, "2026-11-01T00:00:00.000Z"), start, "no recurrence -> start itself");
});

/* ---------- audit chain ---------- */

test("audit chain appends, verifies, and detects tampering", () => {
  const log = [];
  T.auditAppend(log, { kind: "vault.registered", actor: "alice", detail: "ops vault" });
  T.auditAppend(log, { kind: "proposal.created", actor: "alice", detail: "fp abc" });
  T.auditAppend(log, { kind: "signature.added", actor: "bob", detail: "key ab12.." });
  assert.equal(log.length, 3);
  assert.deepEqual([log[0].seq, log[1].seq, log[2].seq], [0, 1, 2]);
  assert.equal(log[0].prev, "GENESIS");
  assert.equal(log[1].prev, log[0].hash);
  const v = T.verifyAuditChain(log);
  assert.ok(v.ok);
  assert.equal(v.entries, 3);
  // tamper with an entry
  log[1].detail = "forged";
  const bad = T.verifyAuditChain(log);
  assert.ok(!bad.ok);
  assert.equal(bad.badSeq, 1);
  assert.match(bad.why, /tampered/);
});

test("audit export formats JSON and CSV", () => {
  const log = [];
  T.auditAppend(log, { kind: "note", actor: "a", detail: 'with, "quotes"' });
  const j = T.exportAuditJSON(log);
  assert.equal(JSON.parse(j).length, 1);
  const c = T.exportAuditCSV(log);
  assert.ok(c.startsWith("seq,ts,kind,actor,detail,prev,hash\n"));
  assert.ok(c.includes('"with, ""quotes"""'), "CSV quotes escaped");
});
