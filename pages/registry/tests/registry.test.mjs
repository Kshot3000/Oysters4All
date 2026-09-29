// Pearl Registry verification suite — name-record state machine, schema,
// normalization, directory building and claim planning.
// Run: node --no-warnings --loader ./tests/loader.mjs tests/registry.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeHandle, validateHandle, validateOwnerAddress,
  validateNameJson, buildClaimJson, buildTransferJson, buildReleaseJson,
  parseNameRecord, newRegistryState, applyNameOp, buildDirectory,
  lookupHandle, buildNameEnvelopeScript, extractMarker, planNameClaim,
  assertSpendableCommitValue, inscriptionsQuery, isNameCandidate,
  clampMaxPages, formatPRL, NAME_PROTOCOL, DONATE_ADDRESS, X_HANDLE,
  NETWORKS,
} from "../src/registry-core.js";
import { utf8ToBytes } from "@noble/hashes/utils";
import {
  newMnemonic, walletFromWIF, walletFromMnemonic,
  buildCommitTx, buildRevealTxSigned,
} from "../../etch/src/etch-core.js";
import { decodeBech32m, DUST_GRAIN } from "../../sign/src/crypto.js";

const MAIN = NETWORKS.mainnet;
const OWNER_A = "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d";
const OWNER_B = walletFromMnemonic(newMnemonic(), MAIN).address;

test("attribution constants are exact", () => {
  assert.equal(DONATE_ADDRESS, "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d");
  assert.equal(X_HANDLE, "kshot9000");
  assert.equal(NAME_PROTOCOL, "prl-name");
});

test("normalizeHandle trims and lowercases", () => {
  assert.equal(normalizeHandle("  Satoshi  "), "satoshi");
  assert.equal(normalizeHandle("PEARL-1"), "pearl-1");
  assert.equal(normalizeHandle(null), "");
  assert.equal(normalizeHandle(""), "");
});

test("validateHandle: good handles pass", () => {
  for (const h of ["satoshi", "a", "pearl-1", "abc-def-123", "x".repeat(32)]) {
    const v = validateHandle(h);
    assert.ok(v.ok, `${h}: ${v.reasons.join(";")}`);
    assert.equal(v.handle, h);
  }
});

test("validateHandle: bad handles fail with reasons", () => {
  const cases = [
    ["", "empty"], ["-lead", "leading"], ["trail-", "trailing"],
    ["do--uble", "double"], ["under_score", "charset"],
    ["with space", "charset"], ["x".repeat(33), "long"],
  ];
  for (const [h, note] of cases) {
    const v = validateHandle(h);
    assert.equal(v.ok, false, `${h} (${note}) should fail`);
    assert.ok(v.reasons.length > 0);
  }
  // UPPER normalizes fine
  const u = validateHandle("UPPER");
  assert.ok(u.ok);
  assert.equal(u.handle, "upper");
});

test("validateOwnerAddress accepts prl1, rejects garbage", () => {
  const ok = validateOwnerAddress(OWNER_A);
  assert.ok(ok.ok, ok.reasons.join(";"));
  assert.equal(ok.hrp, "prl");
  assert.equal(ok.program.length, 32);
  const bad = validateOwnerAddress("bc1qnotpearl");
  assert.equal(bad.ok, false);
  const tprlAddr = walletFromMnemonic(newMnemonic(), NETWORKS.testnet).address;
  const tprl = validateOwnerAddress(tprlAddr, "testnet");
  assert.ok(tprl.ok, tprl.reasons.join(";"));
  assert.equal(tprl.hrp, "tprl");
  const wrongNet = validateOwnerAddress(OWNER_A, "testnet");
  assert.equal(wrongNet.ok, false);
});

test("validateNameJson: canonical claim passes", () => {
  const json = buildClaimJson({ handle: "satoshi", owner: OWNER_A, ts: 1759170000 });
  const v = validateNameJson(JSON.parse(json));
  assert.ok(v.ok, v.reasons.join(";"));
  assert.equal(v.record.op, "claim");
  assert.equal(v.record.handle, "satoshi");
  assert.equal(v.record.owner, OWNER_A);
});

test("validateNameJson rejects marker mismatch, unknown op, extra/missing fields", () => {
  const base = { p: "prl-name", op: "claim", handle: "satoshi", owner: OWNER_A, ts: 1 };
  assert.equal(validateNameJson({ ...base, p: "prl-20" }).ok, false);
  assert.equal(validateNameJson({ ...base, op: "steal" }).ok, false);
  assert.equal(validateNameJson({ ...base, evil: 1 }).ok, false);
  const { ts, ...noTs } = base;
  assert.equal(validateNameJson(noTs).ok, false);
  assert.equal(validateNameJson("nope").ok, false);
  assert.equal(validateNameJson(null).ok, false);
});

test("validateNameJson rejects non-canonical handle and bad ts", () => {
  const base = { p: "prl-name", op: "claim", handle: "Satoshi", owner: OWNER_A, ts: 1 };
  const v = validateNameJson(base);
  assert.equal(v.ok, false);
  assert.ok(v.reasons.some((r) => r.includes("canonical")));
  assert.equal(validateNameJson({ ...base, handle: "satoshi", ts: -5 }).ok, false);
  assert.equal(validateNameJson({ ...base, handle: "satoshi", ts: 1.5 }).ok, false);
  assert.equal(validateNameJson({ ...base, handle: "satoshi", owner: "garbage" }).ok, false);
});

test("transfer/release schemas", () => {
  const t = validateNameJson(JSON.parse(buildTransferJson({ handle: "satoshi", from: OWNER_A, to: OWNER_B, ts: 2 })));
  assert.ok(t.ok, t.reasons.join(";"));
  assert.equal(t.record.to, OWNER_B);
  const r = validateNameJson(JSON.parse(buildReleaseJson({ handle: "satoshi", from: OWNER_A, ts: 3 })));
  assert.ok(r.ok, r.reasons.join(";"));
});

test("parseNameRecord attaches provenance", () => {
  const p = parseNameRecord(buildClaimJson({ handle: "satoshi", owner: OWNER_A, ts: 1 }), 42, "deadbeef");
  assert.ok(p.ok);
  assert.equal(p.record.inscriptionNumber, 42);
  assert.equal(p.record.inscriptionId, "deadbeef");
  const bad = parseNameRecord("{not json", 1, "x");
  assert.equal(bad.ok, false);
});

test("state machine: claim -> transfer -> release -> re-claim", () => {
  const s = newRegistryState();
  const c = { op: "claim", handle: "satoshi", owner: OWNER_A, ts: 1, inscriptionNumber: 10, inscriptionId: "c1" };
  assert.ok(applyNameOp(s, c).accepted);
  assert.equal(s.entries.satoshi.owner, OWNER_A);

  const dup = { op: "claim", handle: "satoshi", owner: OWNER_B, ts: 2, inscriptionNumber: 11, inscriptionId: "c2" };
  const dupR = applyNameOp(s, dup);
  assert.equal(dupR.accepted, false);
  assert.ok(dupR.reasons[0].includes("already owned"));

  const wrongFrom = { op: "transfer", handle: "satoshi", from: OWNER_B, to: OWNER_B, ts: 3, inscriptionNumber: 12, inscriptionId: "t1" };
  const wf = applyNameOp(s, wrongFrom);
  assert.equal(wf.accepted, false);
  assert.ok(wf.reasons[0].includes("not the current owner"));

  const t = { op: "transfer", handle: "satoshi", from: OWNER_A, to: OWNER_B, ts: 4, inscriptionNumber: 13, inscriptionId: "t2" };
  assert.ok(applyNameOp(s, t).accepted);
  assert.equal(s.entries.satoshi.owner, OWNER_B);

  const rel = { op: "release", handle: "satoshi", from: OWNER_B, ts: 5, inscriptionNumber: 14, inscriptionId: "r1" };
  assert.ok(applyNameOp(s, rel).accepted);
  assert.equal(s.entries.satoshi.owner, null);

  const t2 = { op: "transfer", handle: "satoshi", from: OWNER_B, to: OWNER_A, ts: 6, inscriptionNumber: 15, inscriptionId: "t3" };
  assert.equal(applyNameOp(s, t2).accepted, false); // released -> no active registration

  const rc = { op: "claim", handle: "satoshi", owner: OWNER_A, ts: 7, inscriptionNumber: 16, inscriptionId: "c3" };
  assert.ok(applyNameOp(s, rc).accepted);
  assert.equal(s.entries.satoshi.owner, OWNER_A);
  assert.equal(s.entries.satoshi.history.length, 4);
});

test("buildDirectory: first-seen wins regardless of input order", () => {
  const recs = [
    { op: "claim", handle: "pearl", owner: OWNER_B, ts: 2, inscriptionNumber: 99, inscriptionId: "late" },
    { op: "claim", handle: "pearl", owner: OWNER_A, ts: 1, inscriptionNumber: 5, inscriptionId: "early" },
  ];
  const d = buildDirectory(recs);
  assert.equal(d.entries.pearl.owner, OWNER_A);
  assert.equal(d.accepted.length, 1);
  assert.equal(d.rejected.length, 1);
  assert.ok(d.rejected[0].reasons[0].includes("already owned"));
  assert.deepEqual(d.order, ["pearl"]);
});

test("lookupHandle normalizes before lookup", () => {
  const d = buildDirectory([{ op: "claim", handle: "satoshi", owner: OWNER_A, ts: 1, inscriptionNumber: 1, inscriptionId: "x" }]);
  assert.ok(lookupHandle(d, "  SATOSHI "));
  assert.equal(lookupHandle(d, "nobody"), null);
});

test("buildNameEnvelopeScript carries the prl-name marker", () => {
  const w = walletFromMnemonic(newMnemonic(), MAIN);
  const script = buildNameEnvelopeScript(w.internalXOnly, utf8ToBytes(buildClaimJson({ handle: "satoshi", owner: OWNER_A, ts: 1 })));
  assert.equal(extractMarker(script), "prl-name");
  assert.equal(script[script.length - 1], 0x68);
});

test("planNameClaim produces a reveal-compatible plan with exact fee math", () => {
  const w = walletFromMnemonic(newMnemonic(), MAIN);
  const json = buildClaimJson({ handle: "satoshi", owner: OWNER_A, ts: 1759170000 });
  const plan = planNameClaim({ network: MAIN, internalXOnly: w.internalXOnly, nameJson: json, feeRate: 5, changeAddress: w.address });
  assert.equal(plan.marker, "prl-name");
  assert.ok(plan.commitAddress.startsWith("prl1"));
  assert.equal(plan.ownerOutputs.length, 1);
  assert.equal(plan.ownerOutputs[0].value, 1000);
  assert.deepEqual(plan.feeOutputs, []);
  assert.ok(plan.commitValue > 1000, "commit value covers carrier + reveal fee");
  assert.ok(plan.revealFee > 0);
  assertSpendableCommitValue(plan.commitValue);
  assert.throws(() => assertSpendableCommitValue(DUST_GRAIN - 1), /dust/);
});

test("planNameClaim refuses invalid input loudly", () => {
  const w = walletFromMnemonic(newMnemonic(), MAIN);
  const json = buildClaimJson({ handle: "satoshi", owner: OWNER_A, ts: 1 });
  assert.throws(() => planNameClaim({ network: MAIN, internalXOnly: w.internalXOnly, nameJson: buildTransferJson({ handle: "satoshi", from: OWNER_A, to: OWNER_B, ts: 1 }), feeRate: 5, changeAddress: w.address }), /only plans claim/);
  assert.throws(() => planNameClaim({ network: MAIN, internalXOnly: w.internalXOnly, nameJson: "{bad", feeRate: 5, changeAddress: w.address }));
  assert.throws(() => planNameClaim({ network: MAIN, internalXOnly: new Uint8Array(31), nameJson: json, feeRate: 5, changeAddress: w.address }), /bad internal key/);
});

test("end-to-end: real commit + reveal pair for a claim (audited etch machinery)", () => {
  const w = walletFromMnemonic(newMnemonic(), MAIN);
  const json = buildClaimJson({ handle: "satoshi", owner: OWNER_A, ts: 1759170000 });
  const plan = planNameClaim({ network: MAIN, internalXOnly: w.internalXOnly, nameJson: json, feeRate: 5, changeAddress: w.address });
  const funding = [{ txid: "ab".repeat(32), vout: 0, value: plan.commitValue + 20000, priv: w.priv, internalXOnly: w.internalXOnly }];
  const commit = buildCommitTx({ network: MAIN, fundingInputs: funding, commitProgram: plan.commitProgram, commitValue: plan.commitValue, changeProgram: plan.changeProgram, feeRate: 5 });
  assert.ok(commit.txid.length === 64);
  const reveal = buildRevealTxSigned({ plan, commitTxid: commit.txid, commitVout: 0, internalPriv: w.priv, changeAddress: w.address });
  assert.ok(reveal.txid.length === 64);
  // fee accounting is exact: inputs == outputs + fees on both legs
  assert.equal(commit.fee + commit.change + plan.commitValue, funding[0].value);
  assert.equal(plan.commitValue - reveal.fee - reveal.change, plan.ownerOutputs[0].value);
});

test("inscription query helpers and candidates", () => {
  assert.equal(inscriptionsQuery({ order: "asc", page: 2, limit: 50 }), "?order=asc&page=2&limit=50");
  assert.equal(inscriptionsQuery({ limit: 999 }), "?order=asc&page=1&limit=100");
  assert.ok(isNameCandidate({ contentType: "application/json" }));
  assert.ok(isNameCandidate({ contentType: "application/json; charset=utf-8" }));
  assert.ok(!isNameCandidate({ contentType: "image/png" }));
  assert.ok(!isNameCandidate({}));
  assert.equal(clampMaxPages(0), 20); // 0/NaN falls back to default
  assert.equal(clampMaxPages(-5), 1);
  assert.equal(clampMaxPages(9999), 200);
  assert.equal(clampMaxPages(3), 3);
  assert.equal(formatPRL(100000000), "1 PRL");
  assert.equal(formatPRL(123456789), "1.23456789 PRL");
  assert.equal(formatPRL(546), "0.00000546 PRL");
});
