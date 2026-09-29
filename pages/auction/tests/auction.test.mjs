// Pearl Auction test suite.
// Run: node --no-warnings --loader ./tests/loader.mjs tests/auction.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  NETWORKS, GRAIN_PER_PRL, DUST_GRAIN,
  MAX_COMMITMENTS, MIN_REVEAL_GAP, MIN_COMMIT_LEAD, SALT_BYTES,
  genNonceHex, genSaltHex,
  validBidderAddress,
  canonicalItem, itemHashOf,
  parseDescriptor, forgeAuction,
  commitmentPreimage, makeCommitment, verifyCommitment,
  emptyLedger, recordCommitment, applyReveal,
  settleAuction, verifyAuction,
  paymentUri, settleCsv,
  fmtPRL, parsePRL,
} from "../src/auction-core.js";

const SELLER = "prl1pr6yuq8u2r95wjzzgpdy8cpnncpl7l8zgy6x5q0367pnc53s2famqg7pt74";
const B1 = "prl1p7dwp74zgd4te3mqr58d6x3p3t70jljmpe4auey8g824ra4x43tks3y4pr6";
const B2 = "prl1p5gfau0gepxzjkjyx9t88ewnhujrmpjqgqfh8v9vympjaz94x36jqpepvyt";

// --- pinned vectors, computed with an independent sha256 pass (node:crypto) ---
const PIN_DESC = "auction:v1:prl:6162a034fa55f223268e7d64b1eb358e7c937150950f46c7ad957be3a459a5fb:100000000:120100:120200:0011223344556677";
const PIN_DHASH = "2db556c9979be55466699a3f364bccf868687949131bf725dcff78761c5020a8";
const PIN_COMMIT = "de2df01ffcba4b284ac53b08a8323bb4b265639c79c3e3d67651e67c53af7b8f";

const baseForge = {
  network: NETWORKS.mainnet,
  name: "Hammer of the Mint",
  description: "test",
  imageUrl: "",
  seller: SELLER,
  minBidGrains: 100000000n,
  commitH: 120100,
  revealH: 120200,
  nonce: "0011223344556677",
  currentHeight: 120000,
};

test("genNonceHex / genSaltHex: CSPRNG lengths, unique", () => {
  assert.match(genNonceHex(), /^[0-9a-f]{16}$/);
  assert.match(genSaltHex(), /^[0-9a-f]{32}$/, "16 bytes = 32 hex chars");
  assert.notEqual(genSaltHex(), genSaltHex(), "salts differ");
});

test("validBidderAddress: v1-only, canonicalizes", () => {
  assert.equal(validBidderAddress(SELLER), SELLER);
  assert.throws(() => validBidderAddress("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"), /not a valid prl1/);
  assert.throws(() => validBidderAddress("notanaddress"), /not a valid prl1/);
  assert.throws(() => validBidderAddress("prl1" + "a".repeat(60)), /not a valid prl1/);
});

test("forgeAuction: builds the pinned descriptor", () => {
  const f = forgeAuction(baseForge);
  assert.equal(f.descriptor, PIN_DESC);
  assert.equal(f.descriptorHash, PIN_DHASH);
  assert.equal(f.itemHash, "6162a034fa55f223268e7d64b1eb358e7c937150950f46c7ad957be3a459a5fb");
  assert.equal(f.minBidGrains, 100000000n);
  assert.equal(f.commitH, 120100);
  assert.equal(f.revealH, 120200);
  const d = parseDescriptor(f.descriptor);
  assert.equal(d.descriptorHash, PIN_DHASH, "descriptor round-trips");
  // item tamper changes the hash
  const f2 = forgeAuction({ ...baseForge, description: "changed" });
  assert.notEqual(f2.itemHash, f.itemHash, "description change changes itemHash");
  assert.notEqual(f2.descriptor, f.descriptor);
  assert.ok(f.canonical.includes("Hammer of the Mint"));
});

test("forgeAuction: guards — dust min, tip, gap", () => {
  const e = { ...baseForge };
  assert.throws(() => forgeAuction({ ...e, minBidGrains: BigInt(DUST_GRAIN) - 1n }), /dust floor/);
  assert.doesNotThrow(() => forgeAuction({ ...e, minBidGrains: BigInt(DUST_GRAIN) }), "exact dust floor allowed");
  assert.throws(() => forgeAuction({ ...e, minBidGrains: 0n }), /positive/);
  assert.throws(() => forgeAuction({ ...e, commitH: 120000 }), /behind the chain tip/);
  assert.throws(() => forgeAuction({ ...e, commitH: 120000 }), /could not be committed/);
  assert.doesNotThrow(() => forgeAuction({ ...e, commitH: 120002, revealH: 120200 }), "commit lead of 2 allowed");
  assert.throws(() => forgeAuction({ ...e, commitH: 120001 }), /too near the tip/);
  assert.throws(() => forgeAuction({ ...e, revealH: 120100 }), /must be after the commit deadline/);
  assert.throws(() => forgeAuction({ ...e, revealH: 120101 }), /needs at least 3 blocks/, "1-block reveal window refused");
  assert.throws(() => forgeAuction({ ...e, revealH: 120102 }), /needs at least 3 blocks/, "2-block reveal window refused");
  assert.doesNotThrow(() => forgeAuction({ ...e, revealH: 120103 }), "3-block reveal window allowed");
  assert.throws(() => forgeAuction({ ...e, seller: "garbage" }), /not a valid prl1/);
  assert.throws(() => forgeAuction({ ...e, name: "  " }), /needs a name/);
  assert.throws(() => forgeAuction({ ...e, imageUrl: "ftp://x/y.png" }), /http/);
  assert.throws(() => forgeAuction({ ...e, nonce: "xyz" }), /nonce must be/);
  assert.throws(() => forgeAuction({ ...e, currentHeight: null }), /current chain height/);
});

test("makeCommitment: pinned vector + preimage shape", () => {
  const c = makeCommitment({ descriptorHash: PIN_DHASH, bidderAddr: B1, bidGrains: 150000000n, saltHex: "aa".repeat(16) });
  assert.equal(c.commitment, PIN_COMMIT);
  assert.equal(c.preimage, `pearl-auction-commit:v1:${PIN_DHASH}:${B1}:150000000:${"aa".repeat(16)}`);
  // bid changes -> different commitment (hiding property)
  const c2 = makeCommitment({ descriptorHash: PIN_DHASH, bidderAddr: B1, bidGrains: 160000000n, saltHex: "aa".repeat(16) });
  assert.notEqual(c2.commitment, c.commitment);
  const c3 = makeCommitment({ descriptorHash: PIN_DHASH, bidderAddr: B1, bidGrains: 150000000n, saltHex: "bb".repeat(16) });
  assert.notEqual(c3.commitment, c.commitment);
  assert.throws(() => makeCommitment({ descriptorHash: "zz", bidderAddr: B1, bidGrains: 1n, saltHex: "aa".repeat(16) }), /64 hex/);
  assert.throws(() => makeCommitment({ descriptorHash: PIN_DHASH, bidderAddr: B1, bidGrains: 0n, saltHex: "aa".repeat(16) }), /positive/);
  assert.throws(() => makeCommitment({ descriptorHash: PIN_DHASH, bidderAddr: B1, bidGrains: 1n, saltHex: "deadbeef" }), /salt must be/);
});

test("verifyCommitment: ok + LOUD REFUSAL", () => {
  const ok = verifyCommitment({ descriptorHash: PIN_DHASH, address: B1, commitmentHex: PIN_COMMIT, bidGrains: 150000000n, saltHex: "aa".repeat(16) });
  assert.equal(ok.commitment, PIN_COMMIT);
  assert.throws(
    () => verifyCommitment({ descriptorHash: PIN_DHASH, address: B1, commitmentHex: PIN_COMMIT, bidGrains: 160000000n, saltHex: "aa".repeat(16) }),
    /LOUD REFUSAL/,
    "wrong bid refused",
  );
  assert.throws(
    () => verifyCommitment({ descriptorHash: PIN_DHASH, address: B1, commitmentHex: PIN_COMMIT, bidGrains: 150000000n, saltHex: "bb".repeat(16) }),
    /LOUD REFUSAL/,
    "wrong salt refused",
  );
  assert.throws(
    () => verifyCommitment({ descriptorHash: PIN_DHASH, address: B2, commitmentHex: PIN_COMMIT, bidGrains: 150000000n, saltHex: "aa".repeat(16) }),
    /LOUD REFUSAL/,
    "wrong bidder refused",
  );
});

test("recordCommitment: late / duplicate / second-from-same refused", () => {
  const ledger = emptyLedger();
  const r = recordCommitment(ledger, { descriptor: PIN_DESC, address: B1, commitmentHex: PIN_COMMIT, tipHeight: 120050 });
  assert.equal(r.address, B1);
  assert.equal(ledger.commitments.length, 1);
  // late commit refused
  assert.throws(
    () => recordCommitment(ledger, { descriptor: PIN_DESC, address: B2, commitmentHex: "bb".repeat(32), tipHeight: 120100 }),
    /REFUSED.*BEFORE the commit deadline/,
    "at commitH = too late",
  );
  assert.throws(
    () => recordCommitment(ledger, { descriptor: PIN_DESC, address: B2, commitmentHex: "zz".repeat(32), tipHeight: 120099 }),
    /64 hex/,
    "garbage hash sanity",
  );
  // duplicate hash refused
  assert.throws(
    () => recordCommitment(ledger, { descriptor: PIN_DESC, address: B2, commitmentHex: PIN_COMMIT, tipHeight: 120050 }),
    /already recorded/,
  );
  // second commitment from same address refused (one bidder, one commitment)
  const other = makeCommitment({ descriptorHash: PIN_DHASH, bidderAddr: B1, bidGrains: 99999999n, saltHex: "cc".repeat(16) });
  assert.throws(
    () => recordCommitment(ledger, { descriptor: PIN_DESC, address: B1, commitmentHex: other.commitment, tipHeight: 120050 }),
    /one bidder, one commitment/,
  );
  assert.equal(ledger.commitments.length, 1, "ledger unchanged by refusals");
  assert.throws(
    () => recordCommitment(ledger, { descriptor: PIN_DESC, address: "garbage", commitmentHex: "dd".repeat(32), tipHeight: 120050 }),
    /not a valid prl1/,
  );
  assert.throws(
    () => recordCommitment(ledger, { descriptor: PIN_DESC, address: B2, commitmentHex: "dd".repeat(32), tipHeight: null }),
    /current chain height/,
  );
});

test("applyReveal: window + minimum + commitment checks", () => {
  const mk = () => {
    const ledger = emptyLedger();
    const c1 = makeCommitment({ descriptorHash: PIN_DHASH, bidderAddr: B1, bidGrains: 150000000n, saltHex: "aa".repeat(16) });
    recordCommitment(ledger, { descriptor: PIN_DESC, address: B1, commitmentHex: c1.commitment, tipHeight: 120050 });
    return { ledger, c1 };
  };
  // reveal before commit phase ends refused
  {
    const { ledger } = mk();
    assert.throws(() => applyReveal(ledger, { descriptor: PIN_DESC, address: B1, bidGrains: 150000000n, saltHex: "aa".repeat(16), tipHeight: 120050 }), /still open/);
  }
  // reveal after revealH refused
  {
    const { ledger } = mk();
    assert.throws(() => applyReveal(ledger, { descriptor: PIN_DESC, address: B1, bidGrains: 150000000n, saltHex: "aa".repeat(16), tipHeight: 120200 }), /reveal deadline/);
  }
  // below-minimum bid refused
  {
    const ledger = emptyLedger();
    const c = makeCommitment({ descriptorHash: PIN_DHASH, bidderAddr: B1, bidGrains: 99999999n, saltHex: "aa".repeat(16) });
    recordCommitment(ledger, { descriptor: PIN_DESC, address: B1, commitmentHex: c.commitment, tipHeight: 120050 });
    assert.throws(() => applyReveal(ledger, { descriptor: PIN_DESC, address: B1, bidGrains: 99999999n, saltHex: "aa".repeat(16), tipHeight: 120150 }), /below the auction minimum/);
  }
  // wrong salt -> LOUD REFUSAL
  {
    const { ledger } = mk();
    assert.throws(() => applyReveal(ledger, { descriptor: PIN_DESC, address: B1, bidGrains: 150000000n, saltHex: "bb".repeat(16), tipHeight: 120150 }), /LOUD REFUSAL/);
  }
  // unknown bidder refused
  {
    const { ledger } = mk();
    assert.throws(() => applyReveal(ledger, { descriptor: PIN_DESC, address: B2, bidGrains: 150000000n, saltHex: "aa".repeat(16), tipHeight: 120150 }), /no recorded commitment/);
  }
  // good reveal
  {
    const { ledger, c1 } = mk();
    const v = applyReveal(ledger, { descriptor: PIN_DESC, address: B1, bidGrains: 150000000n, saltHex: "aa".repeat(16), tipHeight: 120150 });
    assert.equal(v.address, B1);
    assert.equal(v.bidGrains, 150000000n);
    assert.equal(v.commitment, c1.commitment);
  }
});

test("settleAuction: winner, tie-break by earliest reveal, derivation", () => {
  const salt1 = "aa".repeat(16), salt2 = "bb".repeat(16);
  const c1 = makeCommitment({ descriptorHash: PIN_DHASH, bidderAddr: B1, bidGrains: 150000000n, saltHex: salt1 });
  const c2 = makeCommitment({ descriptorHash: PIN_DHASH, bidderAddr: B2, bidGrains: 150000000n, saltHex: salt2 });
  const commitments = [
    { address: B1, commitment: c1.commitment },
    { address: B2, commitment: c2.commitment },
  ];
  // reveal order: B2 first. Same bid -> B2 (earliest reveal) wins the tie.
  const res = settleAuction({
    descriptor: PIN_DESC,
    commitments,
    reveals: [
      { address: B2, bidGrains: 150000000n, saltHex: salt2 },
      { address: B1, bidGrains: 150000000n, saltHex: salt1 },
    ],
  });
  assert.equal(res.noSale, false);
  assert.equal(res.winner.address, B2, "tie broken by earliest reveal");
  assert.equal(res.winner.bidGrains, 150000000n);
  assert.equal(res.ranked.length, 2);
  assert.equal(res.ranked[1].address, B1);
  assert.ok(res.resultHash.match(/^[0-9a-f]{64}$/));
  assert.ok(res.resultRecord.includes("OUTCOME: SALE"));
  assert.ok(res.resultRecord.includes(B2));
  // derivation table has one row per reveal
  assert.equal(res.derivation.length, 2);
  assert.ok(res.derivation.every((r) => r.check.includes("✓")));
  // higher bid wins regardless of reveal order
  const c2b = makeCommitment({ descriptorHash: PIN_DHASH, bidderAddr: B2, bidGrains: 200000000n, saltHex: salt2 });
  const res2 = settleAuction({
    descriptor: PIN_DESC,
    commitments: [{ address: B1, commitment: c1.commitment }, { address: B2, commitment: c2b.commitment }],
    reveals: [
      { address: B1, bidGrains: 150000000n, saltHex: salt1 },
      { address: B2, bidGrains: 200000000n, saltHex: salt2 },
    ],
  });
  assert.equal(res2.winner.address, B2, "higher bid wins even when revealed later");
});

test("settleAuction: bad reveals excluded, valid ones still settle", () => {
  const c1 = makeCommitment({ descriptorHash: PIN_DHASH, bidderAddr: B1, bidGrains: 150000000n, saltHex: "aa".repeat(16) });
  const commitments = [
    { address: B1, commitment: c1.commitment },
    { address: B2, commitment: "cc".repeat(32) },
  ];
  const res = settleAuction({
    descriptor: PIN_DESC,
    commitments,
    reveals: [
      { address: B2, bidGrains: 90000000n, saltHex: "dd".repeat(16) }, // below minimum AND mismatched hash
      { address: B1, bidGrains: 150000000n, saltHex: "aa".repeat(16) },
    ],
  });
  assert.equal(res.winner.address, B1);
  assert.equal(res.validCount, 1);
  const bad = res.derivation.find((r) => r.address === B2);
  assert.equal(bad.ok, false);
  assert.ok(bad.check.startsWith("✗"), "mismatched reveal marked");
});

test("settleAuction: no sale when nothing valid meets the minimum", () => {
  const res = settleAuction({ descriptor: PIN_DESC, commitments: [], reveals: [] });
  assert.equal(res.noSale, true);
  assert.equal(res.winner, null);
  assert.equal(res.winningBidGrains, 0n);
  assert.ok(res.resultRecord.includes("OUTCOME: NO SALE"));
  // never-revealed commitments are listed
  const res2 = settleAuction({
    descriptor: PIN_DESC,
    commitments: [{ address: B1, commitment: PIN_COMMIT }],
    reveals: [],
  });
  assert.equal(res2.noSale, true);
  assert.ok(res2.derivation.some((r) => r.address === B1 && r.check.includes("never revealed")));
});

test("settleAuction: cheat rules — collision + double reveal exclude", () => {
  const c1 = makeCommitment({ descriptorHash: PIN_DHASH, bidderAddr: B1, bidGrains: 150000000n, saltHex: "aa".repeat(16) });
  const c3salt = "ee".repeat(16);
  // collision: same hash recorded for B1 and B2
  const res = settleAuction({
    descriptor: PIN_DESC,
    commitments: [
      { address: B1, commitment: c1.commitment },
      { address: B2, commitment: c1.commitment }, // copied hash
    ],
    reveals: [
      { address: B1, bidGrains: 150000000n, saltHex: "aa".repeat(16) },
      { address: B2, bidGrains: 150000000n, saltHex: c3salt },
    ],
  });
  assert.equal(res.noSale, true, "both colliders excluded -> no sale");
  assert.ok(res.derivation.every((r) => (r.excludeReason || "").includes("collision")));
  // double reveal from one address -> excluded
  const c2 = makeCommitment({ descriptorHash: PIN_DHASH, bidderAddr: B2, bidGrains: 180000000n, saltHex: "ff".repeat(16) });
  const res2 = settleAuction({
    descriptor: PIN_DESC,
    commitments: [
      { address: B1, commitment: c1.commitment },
      { address: B2, commitment: c2.commitment },
    ],
    reveals: [
      { address: B2, bidGrains: 180000000n, saltHex: "ff".repeat(16) },
      { address: B2, bidGrains: 190000000n, saltHex: "00".repeat(16) }, // second reveal, cheater
      { address: B1, bidGrains: 150000000n, saltHex: "aa".repeat(16) },
    ],
  });
  assert.equal(res2.winner.address, B1, "double-revealer excluded, honest bidder wins");
  const dr = res2.derivation.filter((r) => r.address === B2);
  assert.ok(dr.every((r) => (r.excludeReason || "").includes("two reveals")));
});

test("settleAuction: signed result record is deterministic", () => {
  const c1 = makeCommitment({ descriptorHash: PIN_DHASH, bidderAddr: B1, bidGrains: 150000000n, saltHex: "aa".repeat(16) });
  const args = {
    descriptor: PIN_DESC,
    commitments: [{ address: B1, commitment: c1.commitment }],
    reveals: [{ address: B1, bidGrains: 150000000n, saltHex: "aa".repeat(16) }],
  };
  const r1 = settleAuction(args);
  const r2 = settleAuction(args);
  assert.equal(r1.resultHash, r2.resultHash, "same input -> same result hash");
  assert.equal(r1.resultRecord, r2.resultRecord);
});

test("verifyAuction: standalone re-verification, tamper refused", () => {
  const c1 = makeCommitment({ descriptorHash: PIN_DHASH, bidderAddr: B1, bidGrains: 150000000n, saltHex: "aa".repeat(16) });
  const v = verifyAuction({
    descriptor: PIN_DESC,
    commitments: [{ address: B1, commitment: c1.commitment }],
    reveals: [{ address: B1, bidGrains: 150000000n, saltHex: "aa".repeat(16) }],
  });
  assert.equal(v.proven, true);
  assert.equal(v.winner.address, B1);
  // tampered reveal amount: commitment won't reproduce -> excluded (not winner)
  const v2 = verifyAuction({
    descriptor: PIN_DESC,
    commitments: [{ address: B1, commitment: c1.commitment }],
    reveals: [{ address: B1, bidGrains: 999000000n, saltHex: "aa".repeat(16) }],
  });
  assert.equal(v2.noSale, true, "tampered reveal amount is refused and excluded");
  // malformed descriptor refused
  assert.throws(() => verifyAuction({ descriptor: "auction:v1:bogus", commitments: [], reveals: [] }), /not an auction descriptor/);
  // bad commitment shape refused
  assert.throws(
    () => verifyAuction({ descriptor: PIN_DESC, commitments: [{ address: B1, commitment: "zz" }], reveals: [] }),
    /not 64 hex — input refused/,
  );
  // bad address refused
  assert.throws(
    () => verifyAuction({ descriptor: PIN_DESC, commitments: [{ address: "nope", commitment: c1.commitment }], reveals: [] }),
    /not a valid prl1 v1 address: nope/,
  );
});

test("parseDescriptor: malformed descriptors rejected", () => {
  assert.throws(() => parseDescriptor("auction:v1:prl:1"), /not an auction descriptor/);
  assert.throws(() => parseDescriptor(""), /not an auction descriptor/);
  assert.throws(() => parseDescriptor(PIN_DESC.replace(":prl:", ":xxx:")), /unknown network hrp/);
  const d = parseDescriptor(PIN_DESC.replace(":prl:", ":tprl:"));
  assert.equal(d.network.hrp, "tprl", "testnet descriptors parse");
});

test("paymentUri + settleCsv", () => {
  assert.equal(paymentUri(SELLER, 150000000n), `pearl:${SELLER}?amount=1.5`);
  const c1 = makeCommitment({ descriptorHash: PIN_DHASH, bidderAddr: B1, bidGrains: 150000000n, saltHex: "aa".repeat(16) });
  const res = settleAuction({
    descriptor: PIN_DESC,
    commitments: [{ address: B1, commitment: c1.commitment }],
    reveals: [{ address: B1, bidGrains: 150000000n, saltHex: "aa".repeat(16) }],
  });
  const csv = settleCsv(res);
  assert.ok(csv.startsWith("# Pearl Auction result\n"));
  assert.ok(csv.includes(`1,${B1},150000000,1.5,1,yes,`));
  assert.ok(csv.includes("rank,address,bid_grains,bid_prl,reveal_order,valid,note"));
});

test("units: parsePRL round-trip", () => {
  assert.equal(parsePRL("2.5"), 250000000n);
  assert.equal(fmtPRL(250000000n), "2.5");
  assert.throws(() => parsePRL("1.123456789"), /invalid PRL amount/);
});
