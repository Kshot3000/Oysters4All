// Pearl Commons core tests.
// Run: node --no-warnings --loader tests/loader.mjs --test tests/commons-core.test.mjs
// (from the commons directory)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GRAIN_PER_PRL,
  COMMONS_VERSION,
  parsePRLtoGrains,
  formatPRL,
  validatePearlAddress,
  normalizeDonorLabel,
  createRound,
  roundStatus,
  canContribute,
  projectCategories,
  createProject,
  recordContribution,
  aggregateByDonor,
  qfDesiredMatch,
  computeResults,
  appendAuditEvent,
  verifyAuditChain,
  locateContributionOutput,
  sha256HexText,
} from "../src/commons-core.js";
import { encodeBech32m } from "../../sign/src/crypto.js";

const G = BigInt(GRAIN_PER_PRL);

// A deterministic valid mainnet Taproot address for tests (32-byte program).
// Minimal bech32m encoder (TEST-ONLY fixture code, never shipped) for crafting
// malformed addresses the production encoder rightly refuses to build.
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= GEN[i];
  }
  return chk;
}
function testEncodeBech32m(hrp, version, program) {
  const data = [version, ...convertBits(program, 8, 5, true)];
  const values = [...hrp].map((c) => c.charCodeAt(0) >> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31), ...data);
  const pm = polymod([...values, 0, 0, 0, 0, 0, 0]) ^ 0x2bc830a3;
  let ret = hrp + "1";
  for (const d of data) ret += CHARSET[d];
  for (let i = 0; i < 6; i++) ret += CHARSET[(pm >> (5 * (5 - i))) & 31];
  return ret;
}
function convertBits(data, from, to, pad) {
  let acc = 0, bits = 0;
  const out = [];
  for (const v of data) {
    acc = (acc << from) | v;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & ((1 << to) - 1));
    }
  }
  if (pad && bits) out.push((acc << (to - bits)) & ((1 << to) - 1));
  return out;
}
// A deterministic valid mainnet Taproot address for tests (32-byte program).
const PROG = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff);
const MALFORMED_V1_SHORT = testEncodeBech32m("prl", 1, new Uint8Array(20).fill(2));
const ADDR = encodeBech32m("prl", 1, PROG);
const ADDR2 = encodeBech32m("prl", 1, new Uint8Array(32).fill(9));

function mkRound(over = {}) {
  const now = Date.now();
  return createRound({
    name: "Commons Round One",
    description: "test round",
    matchingPoolPRL: "1000",
    minContributionPRL: "0.5",
    startsAt: new Date(now - 3600_000).toISOString(),
    endsAt: new Date(now + 7 * 24 * 3600_000).toISOString(),
    nowMs: now,
    ...over,
  });
}

test("parsePRLtoGrains accepts valid amounts", () => {
  assert.equal(parsePRLtoGrains("1"), G);
  assert.equal(parsePRLtoGrains("0.00000001"), 1n);
  assert.equal(parsePRLtoGrains("12.5"), 1_250_000_000n);
  assert.equal(parsePRLtoGrains("  3.25  "), 325_000_000n);
});

test("parsePRLtoGrains rejects junk", () => {
  for (const bad of ["", "abc", "-1", "0", "1.123456789", "1e3", "1,000", ".5", "5.", "NaN"]) {
    assert.throws(() => parsePRLtoGrains(bad), /./, `should reject ${JSON.stringify(bad)}`);
  }
  assert.throws(() => parsePRLtoGrains("2100000000.00000001"), /supply cap/);
});

test("formatPRL round-trips parse", () => {
  for (const s of ["1", "0.00000001", "12.5", "1000", "0.1"]) {
    assert.equal(formatPRL(parsePRLtoGrains(s)), s);
  }
  assert.equal(formatPRL(1_250_000_000n), "12.5");
  assert.equal(formatPRL(0n), "0");
});

test("validatePearlAddress accepts a real prl1 v1/32B address", () => {
  const v = validatePearlAddress(ADDR, "mainnet");
  assert.equal(v.canonical, ADDR);
  assert.equal(v.xonlyHex.length, 64);
  assert.equal(v.hrp, "prl");
});

test("validatePearlAddress rejects non-Pearl and wrong-shape addresses", () => {
  assert.throws(() => validatePearlAddress("", "mainnet"), /empty/);
  assert.throws(() => validatePearlAddress("bc1p" + "x".repeat(50), "mainnet"), /bech32m/);
  // wrong hrp
  const tprl = encodeBech32m("tprl", 1, PROG);
  assert.throws(() => validatePearlAddress(tprl, "mainnet"), /bech32m/);
  // v0 rejected (Bitcoin-style segwit must not pass as Pearl; hand-crafted)
  const v0 = testEncodeBech32m("prl", 0, new Uint8Array(20).fill(1));
  assert.throws(() => validatePearlAddress(v0, "mainnet"), /witness v1/);
  // 20-byte program rejected (hand-crafted: the real encoder refuses to build it)
  assert.throws(() => validatePearlAddress(MALFORMED_V1_SHORT, "mainnet"), /32 bytes/);
});

test("normalizeDonorLabel lowercases and collapses space", () => {
  assert.equal(normalizeDonorLabel("  Alice  Cooper "), "alice cooper");
  assert.throws(() => normalizeDonorLabel("   "), /empty/);
  assert.throws(() => normalizeDonorLabel("x".repeat(41)), /too long/);
  assert.throws(() => normalizeDonorLabel("bad<script>"), /characters/);
});

test("createRound validates its window", () => {
  const r = mkRound();
  assert.equal(r.v, COMMONS_VERSION);
  assert.equal(r.matchingPoolGrains, (1000n * G).toString());
  assert.equal(r.minContributionGrains, (G / 2n).toString());
  assert.equal(r.id.length, 64);
  const now = Date.now();
  assert.throws(
    () =>
      mkRound({ startsAt: new Date(now + 2 * 86400000).toISOString(), endsAt: new Date(now + 86400000).toISOString() }),
    /end after it starts/
  );
  assert.throws(() => mkRound({ endsAt: new Date(now - 1000).toISOString() }), /in the future/);
  assert.throws(() => mkRound({ name: "ab" }), /too short/);
});

test("roundStatus lifecycle", () => {
  const now = Date.now();
  const r = mkRound();
  assert.equal(roundStatus(r, now), "active");
  assert.equal(canContribute(r, now), true);
  const upcoming = mkRound({
    startsAt: new Date(now + 3600_000).toISOString(),
    endsAt: new Date(now + 7200_000).toISOString(),
  });
  assert.equal(roundStatus(upcoming, now), "upcoming");
  assert.equal(canContribute(upcoming, now), false);
  assert.equal(roundStatus(r, Date.parse(r.endsAt) + 1), "closed");
  const fin = { ...r, status: "finalized" };
  assert.equal(roundStatus(fin, now), "finalized");
});

test("createProject validates name/address/category", () => {
  const r = mkRound();
  const p = createProject({ roundId: r.id, name: "Pearl Docs", address: ADDR, category: "education" });
  assert.equal(p.address, ADDR);
  assert.equal(p.network, "mainnet");
  assert.ok(projectCategories().includes("education"));
  assert.throws(() => createProject({ roundId: r.id, name: "x", address: ADDR }), /too short/);
  assert.throws(() => createProject({ roundId: r.id, name: "ok name", address: "nope" }), /bech32m/);
  assert.throws(
    () => createProject({ roundId: r.id, name: "ok name", address: ADDR, category: "scam" }),
    /Unknown category/
  );
});

test("recordContribution enforces window, min, donor, txid", () => {
  const r = mkRound();
  const p = createProject({ roundId: r.id, name: "Pearl Docs", address: ADDR });
  const c = recordContribution({ round: r, project: p, donor: "Alice", amountPRL: "1" });
  assert.equal(c.amountGrains, G.toString());
  assert.equal(c.donor, "alice");
  assert.throws(
    () => recordContribution({ round: r, project: p, donor: "bob", amountPRL: "0.1" }),
    /below this round's minimum/
  );
  const closed = { ...r, endsAt: new Date(Date.now() - 1000).toISOString(), startsAt: new Date(Date.now() - 7200_000).toISOString() };
  assert.throws(() => recordContribution({ round: closed, project: p, donor: "bob", amountPRL: "1" }), /closed/);
  assert.throws(
    () => recordContribution({ round: r, project: p, donor: "bob", amountPRL: "1", txid: "zz" }),
    /64/
  );
  const withTx = recordContribution({ round: r, project: p, donor: "bob", amountPRL: "2", txid: "ab".repeat(32) });
  assert.equal(withTx.txid, "ab".repeat(32));
});

test("aggregateByDonor merges repeat donors", () => {
  const agg = aggregateByDonor([
    { projectId: "p1", donor: "alice", amountGrains: "100" },
    { projectId: "p1", donor: "alice", amountGrains: "300" },
    { projectId: "p1", donor: "bob", amountGrains: "100" },
  ]);
  assert.equal(agg.get("p1").get("alice"), 400n);
  assert.equal(agg.get("p1").get("bob"), 100n);
});

test("qfDesiredMatch known vectors (PRL space)", () => {
  // two donors of 1 PRL: (1+1)^2 - 2 = 2 PRL
  let m = qfDesiredMatch([G, G]);
  assert.equal(m.desiredMatchGrains, 2n * G);
  // 4,1,1 PRL: (2+1+1)^2 - 6 = 10 PRL
  m = qfDesiredMatch([4n * G, G, G]);
  assert.equal(m.desiredMatchGrains, 10n * G);
  // single donor: zero match (correct QF behavior)
  m = qfDesiredMatch([100n * G]);
  assert.equal(m.desiredMatchGrains, 0n);
  // no donors
  m = qfDesiredMatch([]);
  assert.equal(m.desiredMatchGrains, 0n);
  assert.equal(m.contributedGrains, 0n);
});

test("computeResults applies capital constraint honestly", () => {
  const r = mkRound({ matchingPoolPRL: "5" }); // tiny pool forces scaling
  const p1 = createProject({ roundId: r.id, name: "Docs", address: ADDR });
  const p2 = createProject({ roundId: r.id, name: "Wallet", address: ADDR2 });
  const now = Date.now();
  const cs = [
    recordContribution({ round: r, project: p1, donor: "a", amountPRL: "4", notedAtMs: now }),
    recordContribution({ round: r, project: p1, donor: "b", amountPRL: "1", notedAtMs: now }),
    recordContribution({ round: r, project: p1, donor: "c", amountPRL: "1", notedAtMs: now }),
    recordContribution({ round: r, project: p2, donor: "d", amountPRL: "100", notedAtMs: now }),
  ];
  const res = computeResults(r, [p1, p2], cs);
  const docs = res.projects.find((x) => x.name === "Docs");
  const wallet = res.projects.find((x) => x.name === "Wallet");
  assert.equal(docs.desiredMatchGrains, (10n * G).toString()); // 4,1,1 -> 10 PRL
  assert.equal(wallet.desiredMatchGrains, "0"); // single donor -> 0
  assert.equal(res.capitalConstrained, true); // 10 PRL desired > 5 PRL pool
  assert.equal(docs.matchGrains, (5n * G).toString()); // scaled to whole pool
  assert.equal(res.totals.matchGrains, (5n * G).toString());
  assert.equal(res.totals.remainderGrains, "0");
  assert.equal(res.totals.uniqueDonors, 4);
  // Docs outranks Wallet on total (6 contrib + 5 match > 100 contrib + 0 match? no: 106 > 11)
  assert.equal(res.projects[0].name, "Wallet"); // 100+0=100 > 6+5=11
});

test("computeResults without constraint pays full desired match", () => {
  const r = mkRound({ matchingPoolPRL: "1000" });
  const p1 = createProject({ roundId: r.id, name: "Docs", address: ADDR });
  const now = Date.now();
  const cs = [
    recordContribution({ round: r, project: p1, donor: "a", amountPRL: "1", notedAtMs: now }),
    recordContribution({ round: r, project: p1, donor: "b", amountPRL: "1", notedAtMs: now }),
  ];
  const res = computeResults(r, [p1], cs);
  assert.equal(res.capitalConstrained, false);
  assert.equal(res.projects[0].matchGrains, (2n * G).toString());
  assert.equal(res.totals.remainderGrains, (998n * G).toString());
  assert.equal(res.scaleK, 1);
});

test("audit chain verifies and detects tampering", () => {
  const log = [];
  appendAuditEvent(log, "round.created", { id: "r1" });
  appendAuditEvent(log, "contribution.recorded", { id: "c1" });
  const v = verifyAuditChain(log);
  assert.equal(v.ok, true);
  assert.equal(v.entries, 2);
  log[1].body.id = "c2"; // tamper
  const v2 = verifyAuditChain(log);
  assert.equal(v2.ok, false);
  assert.equal(v2.badSeq, 1);
});

test("locateContributionOutput finds the paying output", () => {
  const tx = {
    txid: "ab".repeat(32),
    confirmations: 3,
    outputs: [
      { addresses: ["prl1other"], valueGrains: "999999999" },
      { addresses: [ADDR, "prl1change"], valueGrains: (2n * G).toString() },
    ],
  };
  const hit = locateContributionOutput(tx, ADDR, G.toString());
  assert.ok(hit);
  assert.equal(hit.valueGrains, (2n * G).toString());
  assert.equal(locateContributionOutput(tx, ADDR, (3n * G).toString()), null); // too small
  assert.equal(locateContributionOutput(tx, ADDR2, G.toString()), null); // wrong addr
});

test("sha256HexText is deterministic", () => {
  assert.equal(sha256HexText("pearl"), sha256HexText("pearl"));
  assert.equal(sha256HexText("pearl").length, 64);
  assert.notEqual(sha256HexText("pearl"), sha256HexText("Pearl"));
});
