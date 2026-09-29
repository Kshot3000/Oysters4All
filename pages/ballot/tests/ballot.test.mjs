// Pearl Ballot core test suite.
// Run: node --no-warnings --loader ./tests/loader.mjs tests/ballot.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  NETWORKS,
  parseDescriptor, forgeBallot,
  canonicalProposal, proposalHashOf, optionsHashOf,
  canonicalBallot, ballotHashOf,
  parseSignedBallot, signBallot, verifySignedBallot,
  tallyBallots, tallyWinner, resultRecord, tallyCsv,
  verifyBallotElection,
  fetchTipHeight, fetchAddressBalanceGrains,
  walletFromPriv, walletFromWIF, walletFromMnemonic, walletToWIF,
  ballotSigningKey, bytesToHex, hexToBytes,
} from "../src/ballot-core.js";

const net = NETWORKS.mainnet;

// --- pinned vectors (generated from the core, cross-checked with an
//     independent node:crypto sha256 pass) ---
const PIN_CANONICAL = '{"description":"Fund a community relay node for 12 months.","endH":120200,"options":["Yes, fund it","No, decline"],"snapshotH":120000,"startH":120100,"title":"Treasury grant: Harbor Node Relay"}';
const PIN_PROPOSAL_HASH = "9d5bc9f1fcfacc1f898d00be4b1782445df3d3ae119c54c93c529569181bca4b";
const PIN_OPTIONS_HASH = "aa03e90d8276a7557913ec29fd561eb9e2e47ad2cd113532714b4e97b3a90027";
const PIN_DESCRIPTOR = "pearl-ballot:v1:prl:9d5bc9f1fcfacc1f898d00be4b1782445df3d3ae119c54c93c529569181bca4b:120100:120200:120000:aa03e90d8276a7557913ec29fd561eb9e2e47ad2cd113532714b4e97b3a90027";
const PIN_DHASH = "9067b2e7e92ea84319f35a6984098a58322c762efa6cab04526e72cef6a7e4fb";
const PIN_VOTER = "prl1p37lywtprwyag26ensjx8m86nwltx9u2fvhse8f5ha9nvg4jgnapqwusg9f"; // walletFromPriv("0f"*32)
const PIN_BALLOT_HASH = "c4767a859349b671c0851f235bff76044783980328b802dc6eb3754c6fba74fc";
const PIN_SIGNATURE = "e215dde91a5e15dde0ceaab22fe6201748767f1f38b22c8769a37ac050ccfb0b672cd33ccd16a2d9b0ad9b136a2f03990fc7d727b95e55d1666b3a3916c6cbfe"; // zero auxRand

const baseForge = {
  network: net,
  title: "Treasury grant: Harbor Node Relay",
  description: "Fund a community relay node for 12 months.",
  options: ["Yes, fund it", "No, decline"],
  startH: 120100, endH: 120200, snapshotH: 120000,
  nonce: "0011223344556677", currentHeight: 120000,
};

function pinSigned(extra = {}) {
  const w = walletFromPriv("0f".repeat(32), net);
  return signBallot({
    tweakedPriv: ballotSigningKey(w),
    fields: {
      network: net, descriptorHash: PIN_DHASH, voter: w.address, choice: 0,
      weightGrains: 5000000n, snapshotH: 120000, nonce: "aabbccddeeff0011", ...extra,
    },
    auxRand: new Uint8Array(32),
  });
}

test("canonicalProposal: exact sorted-key JSON", () => {
  const c = canonicalProposal({
    title: baseForge.title, description: baseForge.description, options: baseForge.options,
    startH: 120100, endH: 120200, snapshotH: 120000,
  });
  assert.equal(c, PIN_CANONICAL);
  assert.equal(createHash("sha256").update(c, "utf8").digest("hex"), PIN_PROPOSAL_HASH, "independent sha256 of canonical proposal");
  assert.equal(proposalHashOf({ title: baseForge.title, description: baseForge.description, options: baseForge.options, startH: 120100, endH: 120200, snapshotH: 120000 }), PIN_PROPOSAL_HASH);
  assert.equal(optionsHashOf(baseForge.options), PIN_OPTIONS_HASH);
});

test("forgeBallot: builds the pinned descriptor", () => {
  const f = forgeBallot(baseForge);
  assert.equal(f.descriptor, PIN_DESCRIPTOR);
  assert.equal(f.descriptorHash, PIN_DHASH);
  assert.equal(f.proposalHash, PIN_PROPOSAL_HASH);
  assert.equal(f.optionsHash, PIN_OPTIONS_HASH);
  assert.equal(f.canonical, PIN_CANONICAL);
});

test("forgeBallot: dust/empty proposals refused", () => {
  assert.throws(() => forgeBallot({ ...baseForge, title: "   " }), /needs a title/);
  assert.throws(() => forgeBallot({ ...baseForge, description: "" }), /needs a description/);
  assert.throws(() => forgeBallot({ ...baseForge, options: ["Only one"] }), /at least 2 options/);
  assert.throws(() => forgeBallot({ ...baseForge, options: ["a", "b", "c", "d", "e", "f", "g", "h", "i"] }), /at most 8 options/);
  assert.throws(() => forgeBallot({ ...baseForge, options: ["Yes", "  "] }), /empty options/);
  assert.throws(() => forgeBallot({ ...baseForge, options: ["Yes", "yes"] }), /distinct/);
});

test("forgeBallot: window guards", () => {
  assert.throws(() => forgeBallot({ ...baseForge, startH: 119999 }), /published BEFORE/);
  assert.throws(() => forgeBallot({ ...baseForge, endH: 120100 }), /must be after the start/);
  assert.throws(() => forgeBallot({ ...baseForge, snapshotH: 120101 }), /at or before the voting window start/);
  assert.throws(() => forgeBallot({ ...baseForge, snapshotH: 120001 }), /cannot snapshot the future/);
  assert.throws(() => forgeBallot({ ...baseForge, currentHeight: undefined }), /need the current chain height/);
});

test("parseDescriptor: valid + malformed", () => {
  const d = parseDescriptor(PIN_DESCRIPTOR);
  assert.equal(d.descriptorHash, PIN_DHASH);
  assert.equal(d.startH, 120100); assert.equal(d.endH, 120200); assert.equal(d.snapshotH, 120000);
  assert.equal(d.proposalHash, PIN_PROPOSAL_HASH); assert.equal(d.optionsHash, PIN_OPTIONS_HASH);
  assert.throws(() => parseDescriptor("pearl-ballot:v1:prl:zz"), /not a ballot descriptor/);
  assert.throws(() => parseDescriptor("pearl-ballot:v1:xyz:9d5bc9f1fcfacc1f898d00be4b1782445df3d3ae119c54c93c529569181bca4b:120100:120200:120000:aa03e90d8276a7557913ec29fd561eb9e2e47ad2cd113532714b4e97b3a90027"), /unknown network hrp/);
});

test("signBallot: pinned ballot hash + signature (zero auxRand)", () => {
  const s = pinSigned();
  assert.equal(s.protocol, "pearl-ballot-ballot");
  assert.equal(s.version, 1);
  assert.equal(s.voter, PIN_VOTER);
  assert.equal(s.ballotHash, PIN_BALLOT_HASH);
  assert.equal(s.signature, PIN_SIGNATURE);
  assert.equal(createHash("sha256").update(canonicalBallot({ descriptorHash: PIN_DHASH, voter: PIN_VOTER, choice: 0, weightGrains: 5000000n, snapshotH: 120000, nonce: "aabbccddeeff0011" }), "utf8").digest("hex"), PIN_BALLOT_HASH, "independent sha256 of canonical ballot");
});

test("signBallot: wrong key -> LOUD REFUSAL (re-verify catches it)", () => {
  const other = walletFromPriv("ab".repeat(32), net);
  assert.throws(() => signBallot({
    tweakedPriv: ballotSigningKey(other),
    fields: { network: net, descriptorHash: PIN_DHASH, voter: PIN_VOTER, choice: 0, weightGrains: 1n, snapshotH: 120000, nonce: "aabbccddeeff0011" },
    auxRand: new Uint8Array(32),
  }), /LOUD REFUSAL/);
});

test("verifySignedBallot: valid + tamper refusals", () => {
  const s = pinSigned();
  const v = verifySignedBallot({ descriptor: PIN_DESCRIPTOR, signed: s });
  assert.equal(v.voter, PIN_VOTER);
  // tampered choice -> ballotHash mismatch -> LOUD REFUSAL
  assert.throws(() => verifySignedBallot({ descriptor: PIN_DESCRIPTOR, signed: { ...s, choice: 1 } }), /LOUD REFUSAL.*TAMPERED/);
  // tampered signature -> LOUD REFUSAL
  const badSig = { ...s, signature: "ff" + s.signature.slice(2) };
  assert.throws(() => verifySignedBallot({ descriptor: PIN_DESCRIPTOR, signed: badSig }), /LOUD REFUSAL/);
  // wrong poll descriptor -> LOUD REFUSAL
  const otherDesc = forgeBallot({ ...baseForge, title: "A different poll" });
  assert.throws(() => verifySignedBallot({ descriptor: otherDesc.descriptor, signed: s }), /wrong poll/);
  // snapshot height mismatch -> LOUD REFUSAL
  const shifted = pinSigned();
  shifted.snapshotH = 119999;
  const w = walletFromPriv("0f".repeat(32), net);
  const resigned = signBallot({ tweakedPriv: ballotSigningKey(w), fields: { network: net, descriptorHash: PIN_DHASH, voter: w.address, choice: 0, weightGrains: 5n, snapshotH: 119999, nonce: "aabbccddeeff0011" }, auxRand: new Uint8Array(32) });
  assert.throws(() => verifySignedBallot({ descriptor: PIN_DESCRIPTOR, signed: resigned }), /snapshot height/);
  assert.equal(shifted.snapshotH, 119999, "fixture sanity");
});

test("parseSignedBallot: malformed rejected", () => {
  assert.throws(() => parseSignedBallot(null), /must be a JSON object/);
  assert.throws(() => parseSignedBallot({ protocol: "pearl-ballot-ballot", version: 2 }), /unsupported ballot version/);
  assert.throws(() => parseSignedBallot({ ...pinSigned(), signature: "abcd" }), /128 hex chars/);
});

test("tallyBallots: per-option weight totals", () => {
  const w1 = walletFromPriv("0f".repeat(32), net);
  const w2 = walletFromPriv("1f".repeat(32), net);
  const mk = (w, choice, weight) => signBallot({
    tweakedPriv: ballotSigningKey(w),
    fields: { network: net, descriptorHash: PIN_DHASH, voter: w.address, choice, weightGrains: BigInt(weight), snapshotH: 120000, nonce: bytesToHex(crypto.getRandomValues(new Uint8Array(8))) },
  });
  const t = tallyBallots({ descriptor: PIN_DESCRIPTOR, signedBallots: [mk(w1, 0, 5000000), mk(w2, 1, 3000000)], optionCount: 2 });
  assert.equal(t.nVoters, 2);
  assert.equal(t.perOption[0], 5000000n);
  assert.equal(t.perOption[1], 3000000n);
  assert.equal(t.totalWeight, 8000000n);
  assert.equal(t.nRejected, 0);
});

test("tallyBallots: duplicate voter -> first valid wins, loud duplicate report", () => {
  const w = walletFromPriv("0f".repeat(32), net);
  const mk = (choice, weight, nonce) => signBallot({
    tweakedPriv: ballotSigningKey(w),
    fields: { network: net, descriptorHash: PIN_DHASH, voter: w.address, choice, weightGrains: BigInt(weight), snapshotH: 120000, nonce },
  });
  const t = tallyBallots({ descriptor: PIN_DESCRIPTOR, signedBallots: [mk(0, 5000000, "aabbccddeeff0011"), mk(1, 9000000, "aabbccddeeff0022")], optionCount: 2 });
  assert.equal(t.nVoters, 1);
  assert.equal(t.accepted[0].choice, 0);
  assert.equal(t.perOption[0], 5000000n);
  assert.equal(t.duplicates.length, 1);
  assert.match(t.rejected[0].reason, /DUPLICATE/);
});

test("tallyBallots: zero weight + unknown option + bad signature rejected", () => {
  const w = walletFromPriv("0f".repeat(32), net);
  const mk = (fields) => signBallot({ tweakedPriv: ballotSigningKey(w), fields: { network: net, descriptorHash: PIN_DHASH, voter: w.address, choice: 0, weightGrains: 1000n, snapshotH: 120000, nonce: bytesToHex(crypto.getRandomValues(new Uint8Array(8))), ...fields } });
  const t = tallyBallots({ descriptor: PIN_DESCRIPTOR, signedBallots: [mk({ weightGrains: 0n }), mk({ choice: 7 }), { ...mk({}), signature: "00".repeat(64) }], optionCount: 2 });
  assert.equal(t.nVoters, 0);
  assert.equal(t.nRejected, 3);
  assert.match(t.rejected[0].reason, /zero-weight/);
  assert.match(t.rejected[1].reason, /not an option/);
  assert.match(t.rejected[2].reason, /LOUD REFUSAL/);
});

test("tallyWinner: highest weight wins; ties -> TIE", () => {
  const w1 = walletFromPriv("0f".repeat(32), net);
  const w2 = walletFromPriv("1f".repeat(32), net);
  const mk = (w, choice, weight) => signBallot({
    tweakedPriv: ballotSigningKey(w),
    fields: { network: net, descriptorHash: PIN_DHASH, voter: w.address, choice, weightGrains: BigInt(weight), snapshotH: 120000, nonce: bytesToHex(crypto.getRandomValues(new Uint8Array(8))) },
  });
  const clear = tallyBallots({ descriptor: PIN_DESCRIPTOR, signedBallots: [mk(w1, 0, 5), mk(w2, 1, 3)], optionCount: 2 });
  assert.deepEqual(tallyWinner(clear), { winner: 0, tie: false });
  const tied = tallyBallots({ descriptor: PIN_DESCRIPTOR, signedBallots: [mk(w1, 0, 5), mk(w2, 1, 5)], optionCount: 2 });
  assert.deepEqual(tallyWinner(tied), { winner: -1, tie: true });
});

test("resultRecord: format + hash binds canonical tally", () => {
  const w1 = walletFromPriv("0f".repeat(32), net);
  const t = tallyBallots({
    descriptor: PIN_DESCRIPTOR,
    signedBallots: [signBallot({ tweakedPriv: ballotSigningKey(w1), fields: { network: net, descriptorHash: PIN_DHASH, voter: w1.address, choice: 0, weightGrains: 5000000n, snapshotH: 120000, nonce: "aabbccddeeff0011" } })],
    optionCount: 2, tipHeight: 120150, tipSource: "blockbook",
  });
  const r = resultRecord(t);
  assert.match(r.record, new RegExp(`^pearl-ballot-result:v1:${PIN_DHASH}:0:5000000:1:[0-9a-f]{64}$`));
  assert.equal(r.resultHash, createHash("sha256").update(r.canonical, "utf8").digest("hex"), "independent sha256 of canonical tally");
  assert.equal(r.winner, 0); assert.equal(r.tie, false);
});

test("tallyCsv: header + rows", () => {
  const t = tallyBallots({
    descriptor: PIN_DESCRIPTOR,
    signedBallots: [pinSigned()], optionCount: 2,
  });
  const csv = tallyCsv(t);
  const lines = csv.split("\n");
  assert.equal(lines[0], "voter,choice,weightGrains,ballotHash");
  assert.equal(lines.length, 2);
  assert.ok(lines[1].startsWith(`${PIN_VOTER},0,5000000,${PIN_BALLOT_HASH}`));
});

test("verifyBallotElection: proven + NOT PROVEN paths", () => {
  const proposal = JSON.stringify({
    title: baseForge.title, description: baseForge.description, options: baseForge.options,
    startH: 120100, endH: 120200, snapshotH: 120000,
  });
  const ballots = JSON.stringify([pinSigned()]);
  const ok = verifyBallotElection({ proposal, ballots, optionCount: 2 });
  assert.equal(ok.descriptor.descriptorHash, PIN_DHASH);
  assert.equal(ok.tally.nVoters, 1);
  assert.match(ok.result.record, /^pearl-ballot-result:v1:/);
  // tampered proposal -> NOT PROVEN
  const tampered = JSON.stringify({ ...JSON.parse(proposal), title: "Treasury grant: Harbor Node Relay (edited)" });
  assert.throws(() => verifyBallotElection({ proposal: tampered, ballots, optionCount: 2 }), /NOT PROVEN/);
  // mixed descriptors -> NOT PROVEN
  const otherDesc = forgeBallot({ ...baseForge, title: "A different poll" });
  const w2 = walletFromPriv("1f".repeat(32), net);
  const other = signBallot({ tweakedPriv: ballotSigningKey(w2), fields: { network: net, descriptorHash: otherDesc.descriptorHash, voter: w2.address, choice: 0, weightGrains: 1n, snapshotH: 120000, nonce: "bbccddeeff001122" } });
  assert.throws(() => verifyBallotElection({ proposal, ballots: JSON.stringify([pinSigned(), other]), optionCount: 2 }), /NOT PROVEN.*different descriptors/);
  // garbage input -> NOT PROVEN
  assert.throws(() => verifyBallotElection({ proposal: "nope", ballots, optionCount: 2 }), /NOT PROVEN/);
  assert.throws(() => verifyBallotElection({ proposal, ballots: "[]", optionCount: 2 }), /NOT PROVEN.*no ballots/);
});

test("walletFromWIF / walletFromMnemonic agree with walletFromPriv on the address key", () => {
  const w = walletFromPriv("0f".repeat(32), net);
  const fromWif = walletFromWIF(walletToWIF(hexToBytes("0f".repeat(32)), net), net);
  assert.equal(fromWif.address, w.address);
  const mn = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  const m1 = walletFromMnemonic(mn, net, 0, 0);
  const m2 = walletFromMnemonic(mn, net, 0, 0);
  assert.equal(m1.address, m2.address);
  assert.match(m1.address, /^prl1p/);
  // and a mnemonic key can sign a ballot that verifies against its address
  const s = signBallot({ tweakedPriv: ballotSigningKey(m1), fields: { network: net, descriptorHash: PIN_DHASH, voter: m1.address, choice: 1, weightGrains: 42n, snapshotH: 120000, nonce: "aabbccddeeff0011" } });
  const v = verifySignedBallot({ descriptor: PIN_DESCRIPTOR, signed: s });
  assert.equal(v.voter, m1.address);
});

test("fetchTipHeight / fetchAddressBalanceGrains with a stub fetcher", async () => {
  const stub = async (url) => {
    const body = (o) => ({ ok: true, status: 200, text: async () => JSON.stringify(o) });
    if (url.endsWith("/api/v2")) return body({ backend: { blocks: 120042 } });
    if (url.includes("/api/v2/address/")) return body({ balance: "250000000" });
    return { ok: false, status: 404, text: async () => "nf" };
  };
  assert.equal(await fetchTipHeight(stub, "https://blockbook.test"), 120042);
  assert.equal(await fetchAddressBalanceGrains(stub, "https://blockbook.test", PIN_VOTER), 250000000n);
  const bad = async () => ({ ok: false, status: 500, text: async () => "x" });
  await assert.rejects(() => fetchTipHeight(bad, "https://x"), /blockbook 500/);
});
