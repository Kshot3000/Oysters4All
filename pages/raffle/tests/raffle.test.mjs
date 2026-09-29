// Pearl Raffle test suite.
// Run: node --no-warnings --loader ./tests/loader.mjs tests/raffle.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  NETWORKS, GRAIN_PER_PRL, DUST_GRAIN,
  MAX_ENTRIES, MAX_ROUNDS, MIN_SETTLE_LEAD,
  parseEntries, sampleRaffleCsv, canonicalEntries, entriesHashOf,
  parseDescriptor, forgeRaffle,
  bytesToBigIntBE, drawRound, drawRaffle, verifyDraw,
  buildPayoutPlan, payoutCsv, paymentUri,
  fmtPRL, parsePRL,
} from "../src/raffle-core.js";

const A0 = "prl1pr6yuq8u2r95wjzzgpdy8cpnncpl7l8zgy6x5q0367pnc53s2famqg7pt74";
const R1 = "prl1p7dwp74zgd4te3mqr58d6x3p3t70jljmpe4auey8g824ra4x43tks3y4pr6";
const R2 = "prl1p5gfau0gepxzjkjyx9t88ewnhujrmpjqgqfh8v9vympjaz94x36jqpepvyt";
const BLOCK = "aa".repeat(32);

// --- pinned known-answer vector, computed independently with node:crypto ---
const PIN_DESC = "raffle:v1:prl:250000000:120500:dd49308dd9be23d6935380452aec46a51b2feb80b1a9b9e4a27f0db45b601e1a:3";
const PIN_DHASH = "ba629ed15677239e17c13a0e35dcb63cd2aaad4c4b310ef48cb3db6f3bf6dcc8";
const PIN_ROUNDS = [
  { draw: "775102a3bf756956de81605683f2ac91ba637b16135cfbb9b51ffd8815760dcf", total: 16n, idx: 15n, winner: A0 },
  { draw: "dc784fba36a07467f289bfcac941505a645d95c5637da728df67e7c4eccd5ea7", total: 6n, idx: 3n, winner: R1 },
  { draw: "4d1e7dddacdfa8f7e5ae07abf4bda28cac8a745e700e4c64233bce64ed08676a", total: 1n, idx: 0n, winner: R2 },
];

test("parseEntries: formats, merge, rejects", () => {
  const { entries, totalTickets, merged } = parseEntries(`${A0} 10\n${R1},5\n${R2} 1`, NETWORKS.mainnet);
  assert.equal(entries.length, 3); assert.equal(merged, 0);
  assert.equal(totalTickets, 16n);
  assert.equal(entries[0].address, A0);
  assert.equal(entries[0].tickets, 10n);

  const m = parseEntries(`${A0} 10\n# comment\n${R1} 5\n${A0} 2`, NETWORKS.mainnet);
  assert.equal(m.entries.length, 2);
  assert.equal(m.merged, 1);
  assert.equal(m.entries[0].tickets, 12n, "duplicate addresses merge");

  assert.throws(() => parseEntries(`${A0} 1.5`, NETWORKS.mainnet), /whole number/);
  assert.throws(() => parseEntries(`${A0} 0`, NETWORKS.mainnet), /positive/);
  assert.throws(() => parseEntries(`${A0}`, NETWORKS.mainnet), /need "<address> <tickets>"/);
  assert.throws(() => parseEntries(`bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4 1`, NETWORKS.mainnet), /not a valid prl1 address/);
  assert.throws(() => parseEntries(`notanaddress 1`, NETWORKS.mainnet), /not a valid prl1 address/);
  assert.throws(() => parseEntries(``, NETWORKS.mainnet), /no entries/);
  assert.throws(() => parseEntries(`${A0} 1 extra`, NETWORKS.mainnet), /too many fields/);

  const s = parseEntries(sampleRaffleCsv(), NETWORKS.mainnet);
  assert.equal(s.entries.length, 3);
  assert.equal(s.totalTickets, 16n);
});

test("canonicalEntries sorts + entriesHash is stable", () => {
  const a = parseEntries(`${A0} 10\n${R1} 5\n${R2} 1`, NETWORKS.mainnet);
  const b = parseEntries(`${R1} 5\n${R2} 1\n${A0} 10`, NETWORKS.mainnet);
  assert.equal(canonicalEntries(a.entries), canonicalEntries(b.entries), "ordering does not matter");
  assert.equal(entriesHashOf(a.entries), "dd49308dd9be23d6935380452aec46a51b2feb80b1a9b9e4a27f0db45b601e1a");
  // but changing a ticket changes the hash (tamper-evidence)
  const c = parseEntries(`${A0} 10\n${R1} 5\n${R2} 2`, NETWORKS.mainnet);
  assert.notEqual(entriesHashOf(c.entries), entriesHashOf(a.entries));
  assert.ok(canonicalEntries(a.entries).startsWith(R2 + " 1\n"), "sorted ascending by address");
});

test("forgeRaffle: builds the pinned descriptor", () => {
  const { entries } = parseEntries(`${A0} 10\n${R1} 5\n${R2} 1`, NETWORKS.mainnet);
  const f = forgeRaffle({
    network: NETWORKS.mainnet, prizeGrains: 250000000n,
    settleHeight: 120500, entries, currentHeight: 120000,
  });
  assert.equal(f.descriptor, PIN_DESC);
  assert.equal(f.descriptorHash, PIN_DHASH);
  assert.equal(f.n, 3);
  assert.equal(f.totalTickets, 16n);
  const d = parseDescriptor(f.descriptor);
  assert.equal(d.descriptorHash, PIN_DHASH, "descriptor round-trips");
  assert.equal(d.prizeGrains, 250000000n);
  assert.equal(d.settleHeight, 120500);
  assert.equal(d.n, 3);
});

test("forgeRaffle: guards — dust prize, past/too-near height, bad inputs", () => {
  const { entries } = parseEntries(`${A0} 10\n${R1} 5`, NETWORKS.mainnet);
  const base = { network: NETWORKS.mainnet, prizeGrains: 100000000n, settleHeight: 120500, entries, currentHeight: 120000 };
  assert.doesNotThrow(() => forgeRaffle(base));

  // dust prize refused
  assert.throws(() => forgeRaffle({ ...base, prizeGrains: BigInt(DUST_GRAIN) - 1n }), /dust floor/);
  assert.doesNotThrow(() => forgeRaffle({ ...base, prizeGrains: BigInt(DUST_GRAIN) }), "exact dust floor allowed");
  assert.throws(() => forgeRaffle({ ...base, prizeGrains: 0n }), /positive/);

  // settle height guards
  assert.throws(() => forgeRaffle({ ...base, settleHeight: 120000 }), /behind the chain tip/);
  assert.throws(() => forgeRaffle({ ...base, settleHeight: 119000 }), /behind the chain tip/);
  for (let lead = 1; lead <= MIN_SETTLE_LEAD; lead++) {
    assert.throws(
      () => forgeRaffle({ ...base, settleHeight: 120000 + lead }),
      /blocks? of lead/,
      `lead of ${lead} refused`,
    );
  }
  assert.doesNotThrow(() => forgeRaffle({ ...base, settleHeight: 120000 + MIN_SETTLE_LEAD + 1 }), "minimum lead allowed");
  assert.throws(() => forgeRaffle({ ...base, currentHeight: null }), /current chain height/);
  assert.throws(() => forgeRaffle({ ...base, entries: [] }), /no entries/);
});

test("drawRaffle: pinned 3-round vector", () => {
  const { entries } = parseEntries(`${A0} 10\n${R1} 5\n${R2} 1`, NETWORKS.mainnet);
  const drawn = drawRaffle({ descriptor: PIN_DESC, entries, blockHash: BLOCK, rounds: 3 });
  assert.equal(drawn.rounds.length, 3);
  drawn.rounds.forEach((r, i) => {
    const pin = PIN_ROUNDS[i];
    assert.equal(r.drawHex, pin.draw, `round ${i} draw bytes pinned`);
    assert.equal(r.preimage, `raffle-draw:v1:${PIN_DHASH}:${BLOCK}:${i}`, "preimage shape hand re-verifiable");
    assert.equal(r.index, pin.idx, `round ${i} index pinned`);
    assert.equal(r.totalTickets, pin.total, `round ${i} eligible tickets`);
    assert.equal(r.drawInt, bytesToBigIntBE(Buffer.from(pin.draw, "hex")), "drawInt = uint256BE(draw bytes)");
    assert.equal(r.index, r.drawInt % r.totalTickets);
    assert.equal(r.winner.address, pin.winner, `round ${i} winner pinned`);
    assert.ok(r.index >= r.winnerRange.lo && r.index < r.winnerRange.hi, "index inside winner range");
  });
  assert.deepEqual(drawn.winners.map((w) => w.address), [A0, R1, R2], "round 2 excludes round-1 winner");
});

test("drawRaffle: single round + 1-ticket edge", () => {
  const { entries } = parseEntries(`${A0} 1`, NETWORKS.mainnet);
  const f = forgeRaffle({ prizeGrains: 100000000n, settleHeight: 200, entries, currentHeight: 100 });
  const drawn = drawRaffle({ descriptor: f.descriptor, entries, blockHash: BLOCK, rounds: 1 });
  assert.equal(drawn.rounds[0].index, 0n, "1 ticket -> index 0");
  assert.equal(drawn.winners[0].address, A0);
});

test("drawRaffle: loud refusal on tampered entries", () => {
  const { entries } = parseEntries(`${A0} 10\n${R1} 5\n${R2} 1`, NETWORKS.mainnet);
  const tampered = parseEntries(`${A0} 10\n${R1} 5\n${R2} 99`, NETWORKS.mainnet);
  assert.throws(
    () => drawRaffle({ descriptor: PIN_DESC, entries: tampered.entries, blockHash: BLOCK, rounds: 1 }),
    /LOUD REFUSAL/,
  );
  // wrong entry count vs descriptor also refused
  assert.throws(
    () => drawRaffle({ descriptor: PIN_DESC, entries: entries.slice(0, 2), blockHash: BLOCK, rounds: 1 }),
    /commits to 3/,
  );
  // more rounds than entries refused
  assert.throws(
    () => drawRaffle({ descriptor: PIN_DESC, entries, blockHash: BLOCK, rounds: 0 }),
    /1–3/,
  );
  assert.doesNotThrow(
    () => drawRaffle({ descriptor: PIN_DESC, entries, blockHash: BLOCK, rounds: 3 }),
    "sanity: 3 rounds from 3 entries is fine",
  );
  const { entries: two } = parseEntries(`${A0} 10\n${R1} 5`, NETWORKS.mainnet);
  const f2 = forgeRaffle({ prizeGrains: 100000000n, settleHeight: 200, entries: two, currentHeight: 100 });
  assert.throws(
    () => drawRaffle({ descriptor: f2.descriptor, entries: two, blockHash: BLOCK, rounds: 3 }),
    /at least one entry per round/,
  );
  // bad block hash refused
  assert.throws(() => drawRaffle({ descriptor: PIN_DESC, entries, blockHash: "zz", rounds: 1 }), /64 hex/);
});

test("verifyDraw: standalone re-verification", () => {
  const csv = `${A0} 10\n${R1} 5\n${R2} 1`;
  const v = verifyDraw({ descriptor: PIN_DESC, entriesText: csv, blockHash: BLOCK, rounds: 3 });
  assert.equal(v.commitmentOk, true);
  assert.deepEqual(v.winners.map((w) => w.address), [A0, R1, R2]);
  assert.equal(v.totalTickets, 16n);
  assert.throws(
    () => verifyDraw({ descriptor: PIN_DESC, entriesText: `${A0} 10\n${R1} 5\n${R2} 99`, blockHash: BLOCK, rounds: 1 }),
    /LOUD REFUSAL/,
  );
});

test("parseDescriptor: malformed descriptors rejected", () => {
  assert.throws(() => parseDescriptor("raffle:v1:prl:1"), /not a raffle descriptor/);
  assert.throws(() => parseDescriptor(""), /not a raffle descriptor/);
  assert.throws(() => parseDescriptor(PIN_DESC.replace("prl", "xxx")), /unknown network hrp/);
  assert.throws(() => parseDescriptor("raffle:v1:prl:abc:120500:" + "ab".repeat(32) + ":3"), /not a raffle descriptor/);
  const d = parseDescriptor(PIN_DESC.replace(":prl:", ":tprl:"));
  assert.equal(d.network.hrp, "tprl", "testnet descriptors parse");
});

test("buildPayoutPlan: exact split, remainder to round 1", () => {
  const { entries } = parseEntries(`${A0} 10\n${R1} 5\n${R2} 1`, NETWORKS.mainnet);
  const drawn = drawRaffle({ descriptor: PIN_DESC, entries, blockHash: BLOCK, rounds: 3 });
  const plan = buildPayoutPlan({ winners: drawn.winners, prizeGrains: 250000000n, rounds: 3 });
  assert.equal(plan.rows.length, 3);
  // 250000000 / 3 = 83333333 rem 1 -> round 1 gets 83333334
  assert.equal(plan.rows[0].grains, 83333334n);
  assert.equal(plan.rows[1].grains, 83333333n);
  assert.equal(plan.rows[2].grains, 83333333n);
  assert.equal(plan.total, 250000000n);
  assert.equal(plan.rows[0].address, A0);
  assert.equal(plan.rows[0].prl, "0.83333334");

  const even = buildPayoutPlan({ winners: drawn.winners.slice(0, 1), prizeGrains: 100000000n, rounds: 1 });
  assert.equal(even.rows[0].grains, 100000000n, "1 round takes all");

  const csv = payoutCsv(plan);
  assert.ok(csv.startsWith("round,address,grains,prl\n"));
  assert.ok(csv.includes(`1,${A0},83333334,0.83333334`));
  assert.equal(paymentUri(A0, 83333334n), `pearl:${A0}?amount=0.83333334`);
  assert.throws(() => buildPayoutPlan({ winners: [], prizeGrains: 1n, rounds: 1 }), /no winners/);
});

test("bytesToBigIntBE", () => {
  assert.equal(bytesToBigIntBE(new Uint8Array([0x01, 0x00])), 256n);
  assert.equal(bytesToBigIntBE(new Uint8Array([0xff])), 255n);
});

test("units: GRAIN_PER_PRL + parsePRL", () => {
  assert.equal(GRAIN_PER_PRL, 100_000_000);
  assert.equal(parsePRL("2.5"), 250000000n);
  assert.equal(fmtPRL(250000000n), "2.5");
  assert.throws(() => parsePRL("1.123456789"), /invalid PRL amount/);
});
