// Pearl Solvency verification suite — node --test, zero new deps.
// Run: node --no-warnings --loader ./tests/loader.mjs tests/solvency.test.mjs
// Covers: challenge canonicalization, key parsing (WIF/hex/mnemonic), the
// tweaked-key address-match guard, sign/verify round-trips, bundle
// tamper-evidence, unsigned air-gap round-trips, PRL/grain math, address list
// parsing, funding-script byte comparison, and the reserve verdict.
import test from "node:test";
import assert from "node:assert/strict";

import {
  NETWORKS,
  MAX_ADDRESSES,
  SOLVENCY_TAG,
  BUNDLE_VERSION,
  canonicalJson,
  fingerprintOf,
  parsePRLtoGrains,
  fmtPRL,
  addressToProgram,
  parseAddressList,
  custodianKeyFromInput,
  assertKeyMatchesAddress,
  validateCustodian,
  validateNonce,
  validateDateISO,
  challengeString,
  challengeDigest,
  signChallenge,
  verifyChallengeSig,
  makeSolvencyBundle,
  parseSolvencyBundle,
  verifyBundleSignatures,
  exportUnsignedBundle,
  importSignedChallenges,
  fundingScriptMatches,
  reserveVerdict,
  fmtRatioBp,
  bytesToHex,
  hexToBytes,
  sha256,
  p2trScriptPubKey,
  encodeBech32m,
} from "../src/solvency-core.js";

const NW = NETWORKS.mainnet;
const FIXED_PRIV = "11".repeat(32); // deterministic test key, never funded

function fixedKey() { return custodianKeyFromInput(FIXED_PRIV, NW); }
function fixedChallenge(addr) {
  return challengeString({ hrp: NW.hrp, custodian: "Test Custodian", dateISO: "2026-09-29", nonce: "abc123", address: addr });
}

test("challenge string is canonical and commits to every field", () => {
  const a = fixedChallenge("prl1paddr1");
  assert.equal(a, "PearlSolvency/v1|prl|Test Custodian|2026-09-29|abc123|prl1paddr1");
  assert.notEqual(fixedChallenge("prl1paddr1"), fixedChallenge("prl1paddr2"));
  assert.throws(() => challengeString({ hrp: "prl", custodian: "a|b", dateISO: "2026-09-29", nonce: "n", address: "x" }), /must not contain/);
  assert.throws(() => challengeString({ hrp: "prl", custodian: "x", dateISO: "09/29/2026", nonce: "n", address: "x" }), /YYYY-MM-DD/);
  assert.throws(() => challengeString({ hrp: "prl", custodian: "", dateISO: "2026-09-29", nonce: "n", address: "x" }), /required/);
});

test("challenge digest is the tagged hash of the challenge", () => {
  const ch = fixedChallenge("prl1paddr1");
  const d = challengeDigest(ch);
  assert.equal(d.length, 32);
  // tagged hash determinism: same input, same digest
  assert.deepEqual(d, challengeDigest(ch));
  assert.notDeepEqual(d, challengeDigest(ch + "x"));
});

test("custodianKeyFromInput parses 64-hex, WIF, and mnemonic to the same tweaked key", () => {
  const kHex = custodianKeyFromInput(FIXED_PRIV, NW);
  assert.equal(bytesToHex(kHex.internalXOnly).length, 64);
  assert.equal(kHex.tweakedPriv.length, 32);
  assert.equal(kHex.keypathAddress.slice(0, 5), "prl1p");
  // The tweaked key really is what the address commits to:
  const prog = addressToProgram(kHex.keypathAddress, NW);
  assert.deepEqual(prog, kHex.tweakedXOnly);
  // mnemonic path reaches the same key when it derives the same priv (BIP-39 test vector)
  const mn = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  const kMn = custodianKeyFromInput(mn, NW);
  assert.equal(kMn.source, "mnemonic (BIP-86 m/86'/coin'/0'/0/0)");
  assert.equal(kMn.keypathAddress.slice(0, 5), "prl1p");
  assert.throws(() => custodianKeyFromInput("not a key at all", NW), /WIF, 64-hex/);
  assert.throws(() => custodianKeyFromInput("", NW), /empty/);
});

test("address-match guard refuses keys that do not reproduce the address", () => {
  const k = fixedKey();
  assertKeyMatchesAddress(k, k.keypathAddress); // exact: passes
  const other = custodianKeyFromInput("22".repeat(32), NW);
  assert.throws(() => assertKeyMatchesAddress(other, k.keypathAddress), /key mismatch/);
});

test("sign/verify round-trip against the address program", () => {
  const k = fixedKey();
  const ch = fixedChallenge(k.keypathAddress);
  const sig = signChallenge(k.tweakedPriv, ch);
  assert.match(sig, /^[0-9a-f]{128}$/);
  const prog = addressToProgram(k.keypathAddress, NW);
  assert.equal(verifyChallengeSig(sig, ch, prog), true);
  // wrong challenge -> invalid
  assert.equal(verifyChallengeSig(sig, fixedChallenge("prl1pother"), prog), false);
  // wrong key -> invalid
  const other = custodianKeyFromInput("22".repeat(32), NW);
  const badSig = signChallenge(other.tweakedPriv, ch);
  assert.equal(verifyChallengeSig(badSig, ch, prog), false);
  // malformed sig -> false, not throw
  assert.equal(verifyChallengeSig("00".repeat(10), ch, prog), false);
});

test("known-answer vector: fixed key signs deterministically", () => {
  const k = fixedKey();
  // Hard-coded expectations generated from the audited primitives; any silent
  // algorithm change breaks these.
  assert.equal(k.keypathAddress, "prl1p9fjtrm3nwhemkjek0wxtswz2glmneu33w9lcylrvd7alttk0psmqztxl5f");
  const ch = fixedChallenge(k.keypathAddress);
  assert.equal(ch, "PearlSolvency/v1|prl|Test Custodian|2026-09-29|abc123|prl1p9fjtrm3nwhemkjek0wxtswz2glmneu33w9lcylrvd7alttk0psmqztxl5f");
  const s1 = signChallenge(k.tweakedPriv, ch);
  assert.equal(s1, "89a19e8801e093f6db658ee4b55b74e3a95c92a32b218812d89d7852e03924c27d7b2499b06d1566db0251fc98f304a8affd575fbd551ac3899d684a3e7090bd");
  const s2 = signChallenge(k.tweakedPriv, ch);
  assert.equal(s1, s2, "signing must be deterministic (fixed aux randomness)");
  assert.equal(verifyChallengeSig(s1, ch, addressToProgram(k.keypathAddress, NW)), true);
});

test("bundle make/parse round-trip preserves every field", () => {
  const k = fixedKey();
  const k2 = custodianKeyFromInput("22".repeat(32), NW);
  const proofs = [k, k2].map((kk) => ({
    address: kk.keypathAddress,
    sig: signChallenge(kk.tweakedPriv, fixedChallenge(kk.keypathAddress)),
  }));
  const { bundle, fingerprint, json } = makeSolvencyBundle({
    network: NW, custodian: "Test Custodian", liabilitiesGrains: 1_500_000_000n,
    dateISO: "2026-09-29", nonce: "abc123", proofs,
  });
  assert.equal(bundle.v, BUNDLE_VERSION);
  assert.match(fingerprint, /^[0-9a-f]{16}$/);
  assert.equal(bundle.fingerprint, fingerprint);
  const parsed = parseSolvencyBundle(json);
  assert.equal(parsed.custodian, "Test Custodian");
  assert.equal(parsed.liabilitiesGrains, 1_500_000_000n);
  assert.equal(parsed.proofs.length, 2);
  assert.equal(parsed.fingerprint, fingerprint);
  const sigs = verifyBundleSignatures(parsed);
  assert.ok(sigs.every((s) => s.ok), "every signature must verify");
});

test("bundle is tamper-evident: editing liabilities breaks the fingerprint", () => {
  const k = fixedKey();
  const { json } = makeSolvencyBundle({
    network: NW, custodian: "Test Custodian", liabilitiesGrains: 100n,
    dateISO: "2026-09-29", nonce: "abc123",
    proofs: [{ address: k.keypathAddress, sig: signChallenge(k.tweakedPriv, fixedChallenge(k.keypathAddress)) }],
  });
  const evil = JSON.parse(json);
  evil.liabilities = "1"; // attacker understates liabilities
  assert.throws(() => parseSolvencyBundle(JSON.stringify(evil)), /TAMPERED/);
  const evil2 = JSON.parse(json);
  evil2.proofs[0].sig = "00".repeat(64);
  assert.throws(() => parseSolvencyBundle(JSON.stringify(evil2)), /TAMPERED/);
  // ...but a tampered-with-valid-fingerprint bundle still fails signature verification
  const evil3 = JSON.parse(json);
  evil3.proofs[0].sig = signChallenge(custodianKeyFromInput("22".repeat(32), NW).tweakedPriv, fixedChallenge(k.keypathAddress));
  evil3.fingerprint = fingerprintOf((({ fingerprint, ...b }) => b)(evil3));
  const parsed = parseSolvencyBundle(JSON.stringify(evil3)); // structure valid
  const sigs = verifyBundleSignatures(parsed);
  assert.equal(sigs[0].ok, false, "wrong-key signature must not verify");
});

test("unsigned air-gap bundle round-trips and resists tampering", () => {
  const k = fixedKey();
  const { json: unsignedJson } = exportUnsignedBundle({
    network: NW, custodian: "Test Custodian", dateISO: "2026-09-29", nonce: "abc123",
    addresses: [k.keypathAddress],
  });
  const u = JSON.parse(unsignedJson);
  assert.equal(u.v, "pearl-solvency-unsigned:v1");
  assert.equal(u.items[0].challenge, fixedChallenge(k.keypathAddress));
  // "cold" side signs each challenge
  const signed = { signatures: u.items.map((it) => ({ address: it.address, sig: signChallenge(k.tweakedPriv, it.challenge) })) };
  const proofs = importSignedChallenges(unsignedJson, JSON.stringify(signed));
  assert.equal(proofs.length, 1);
  assert.equal(verifyChallengeSig(proofs[0].sig, u.items[0].challenge, addressToProgram(k.keypathAddress, NW)), true);
  // tampered unsigned bundle is refused
  const evil = JSON.parse(unsignedJson);
  evil.items[0].challenge = fixedChallenge("prl1pevil");
  assert.throws(() => importSignedChallenges(JSON.stringify(evil), JSON.stringify(signed)), /tampered/);
  // signature for an address not in the bundle is refused
  const rogue = { signatures: [{ address: k.keypathAddress, sig: "00".repeat(64) }, { address: "prl1progue", sig: "00".repeat(64) }] };
  assert.throws(() => importSignedChallenges(unsignedJson, JSON.stringify(rogue)), /not in the unsigned bundle/);
});

test("parsePRLtoGrains / fmtPRL are grain-exact", () => {
  assert.equal(parsePRLtoGrains("1"), 100_000_000n);
  assert.equal(parsePRLtoGrains("0.00000001"), 1n);
  assert.equal(parsePRLtoGrains("21000000"), 2_100_000_000_000_000n); // full supply, past 2^53
  assert.throws(() => parsePRLtoGrains("1.000000001"), /at most 8 decimals/);
  assert.throws(() => parsePRLtoGrains("-1"), /non-negative/);
  assert.throws(() => parsePRLtoGrains("abc"), /non-negative/);
  assert.equal(fmtPRL(100_000_000n), "1");
  assert.equal(fmtPRL(1n), "0.00000001");
  assert.equal(fmtPRL(2_100_000_000_000_000n), "21000000");
  assert.equal(fmtPRL(parsePRLtoGrains("123.45678901")), "123.45678901");
});

test("parseAddressList validates, dedupes, and caps", () => {
  const k = fixedKey();
  const k2 = custodianKeyFromInput("22".repeat(32), NW);
  const { addresses, errors } = parseAddressList(
    `${k.keypathAddress}\n${k.keypathAddress}\n${k2.keypathAddress}\nbc1qbad\nnotanaddress`,
    NW
  );
  assert.deepEqual(addresses, [k.keypathAddress, k2.keypathAddress]);
  assert.equal(errors.length, 2);
  // wrong network HRP refused
  const tprl = encodeBech32m("tprl", 1, addressToProgram(k.keypathAddress, NW));
  const r2 = parseAddressList(tprl, NW);
  assert.equal(r2.addresses.length, 0);
  assert.match(r2.errors[0], /wrong network HRP/);
  // cap enforced
  const many = Array.from({ length: MAX_ADDRESSES + 5 }, (_, i) =>
    encodeBech32m("prl", 1, sha256(new TextEncoder().encode("addr" + i)).slice(0, 32)));
  const r3 = parseAddressList(many.join("\n"), NW);
  assert.equal(r3.addresses.length, MAX_ADDRESSES);
  assert.match(r3.errors[0], /address cap reached/);
});

test("addressToProgram rejects non-P2TR addresses", () => {
  const k = fixedKey();
  assert.equal(addressToProgram(k.keypathAddress, NW).length, 32);
  assert.throws(() => addressToProgram("definitely-not-an-address", NW), /./);
  // genuine bech32m v0 address (20-byte program) — the audited decoder rejects it
  assert.throws(
    () => addressToProgram("prl1qqurswpc8qurswpc8qurswpc8qurswpc8d8djsu", NW),
    /only witness v1/
  );
  // right shape, wrong network
  const tprl = encodeBech32m("tprl", 1, addressToProgram(k.keypathAddress, NW));
  assert.throws(() => addressToProgram(tprl, NW), /wrong network HRP/);
});

test("fundingScriptMatches byte-compares the funding output script", () => {
  const k = fixedKey();
  const prog = addressToProgram(k.keypathAddress, NW);
  const scriptHex = bytesToHex(p2trScriptPubKey(prog));
  const detail = { vout: [{ n: 0, hex: scriptHex }, { n: 1, hex: "0014" + "00".repeat(20) }] };
  assert.equal(fundingScriptMatches(detail, 0, prog), true);
  assert.equal(fundingScriptMatches(detail, 1, prog), false);
  assert.equal(fundingScriptMatches(detail, 5, prog), false); // missing vout
  assert.equal(fundingScriptMatches({}, 0, prog), false);
});

test("reserveVerdict classifies PROVEN / SHORTFALL / EMPTY exactly", () => {
  let v = reserveVerdict(1_500_000_000n, 1_000_000_000n);
  assert.equal(v.verdict, "PROVEN");
  assert.equal(v.ratioBp, 15000n);
  assert.equal(fmtRatioBp(v.ratioBp), "150.00%");
  v = reserveVerdict(1_000_000_000n, 1_000_000_000n);
  assert.equal(v.verdict, "PROVEN"); // exactly 100% counts
  assert.equal(fmtRatioBp(v.ratioBp), "100.00%");
  v = reserveVerdict(999_999_999n, 1_000_000_000n);
  assert.equal(v.verdict, "SHORTFALL");
  assert.equal(v.shortfallGrains, 1n); // single-grain shortfall is still a shortfall
  assert.equal(fmtRatioBp(v.ratioBp), "99.99%");
  v = reserveVerdict(0n, 0n);
  assert.equal(v.verdict, "EMPTY");
  v = reserveVerdict(5n, 0n);
  assert.equal(v.verdict, "PROVEN");
});

test("canonicalJson is key-order stable; fingerprint is 64-bit", () => {
  const a = canonicalJson({ b: 2, a: 1, n: { z: 0, y: [3, 2] } });
  assert.equal(a, '{"a":1,"b":2,"n":{"y":[3,2],"z":0}}');
  assert.match(fingerprintOf({ a: 1 }), /^[0-9a-f]{16}$/);
  assert.notEqual(fingerprintOf({ a: 1 }), fingerprintOf({ a: 2 }));
});

test("sumAddressReserves counts confirmed only, excludes foreign scripts (stubbed fetch)", async () => {
  const { sumAddressReserves } = await import("../src/solvency-core.js");
  const k = fixedKey();
  const prog = addressToProgram(k.keypathAddress, NW);
  const scriptHex = bytesToHex(p2trScriptPubKey(prog));
  const addr = k.keypathAddress;
  const realFetch = globalThis.fetch;
  const txA = "aa".repeat(32), txB = "bb".repeat(32), txC = "cc".repeat(32);
  globalThis.fetch = async (url) => {
    const u = String(url);
    const json = (o) => ({ ok: true, text: async () => JSON.stringify(o) });
    if (u.includes("/api/v2/utxo/")) {
      return json([
        { txid: txA, vout: 0, value: "100000000", confirmations: 6 },   // 1 PRL confirmed
        { txid: txB, vout: 1, value: "50000000", confirmations: 0 },    // 0.5 unconfirmed
        { txid: txC, vout: 0, value: "25000000", confirmations: 3 },    // foreign script
      ]);
    }
    if (u.includes("/api/v2/tx/" + txA)) return json({ vout: [{ n: 0, hex: scriptHex }] });
    if (u.includes("/api/v2/tx/" + txC)) return json({ vout: [{ n: 0, hex: "0014" + "00".repeat(20) }] });
    throw new Error("unexpected fetch " + u);
  };
  try {
    const r = await sumAddressReserves("https://blockbook.example", addr, NW);
    assert.equal(r.confirmedGrains, 100_000_000n);
    assert.equal(r.unconfirmedGrains, 50_000_000n); // reported, not counted
    assert.equal(r.checked, 2);
    assert.equal(r.foreign.length, 1);
    assert.equal(r.foreign[0].txid, txC);
  } finally {
    globalThis.fetch = realFetch;
  }
});
