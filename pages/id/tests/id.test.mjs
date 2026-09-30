// Pearl ID core verification suite.
// Run: node --no-warnings --loader ./tests/loader.mjs --test tests/id.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import {
  NETWORKS,
  bytesToHex, hexToBytes, sha256, schnorr,
  newMnemonic, walletFromMnemonic,
  walletFromPriv, walletToWIF, tweakPrivKeypath, tweakKeypath,
  ID_PROTOCOL, ID_VERSION, SIGNED_KEYS, ENVELOPE_KEYS,
  MAX_LIFETIME_S,
  idPubkeyHex, idSigningKey, idKeyFromInput, addressFromXonly,
  validateUnsignedFields, canonicalCredential, credentialId, fingerprintOf,
  newChallengeHex, signCredential, verifyCredential, credentialJSON,
} from "../src/id-core.js";
import { numberToBytesBE } from "@noble/curves/abstract/utils";

// crypto.getRandomValues for newChallengeHex (node path)
if (!globalThis.crypto || typeof globalThis.crypto.getRandomValues !== "function") {
  globalThis.crypto = webcrypto;
}

const net = NETWORKS.mainnet;
const AUX = new Uint8Array(32).fill(7); // deterministic aux rand for test vectors

function testWallet(i) {
  return walletFromPriv(numberToBytesBE(BigInt(i), 32), net);
}
const W = [1, 2, 3, 4].map(testWallet);
const NOW = Math.floor(Date.now() / 1000);

function fields(over = {}) {
  const w = over._w || W[0];
  const xonly = idPubkeyHex(w.internalXOnly);
  return {
    domain: "example.com",
    address: addressFromXonly(xonly, net),
    xonly,
    challenge: "ab".repeat(32),
    issued_at: String(NOW - 60),
    expires_at: String(NOW + 240),
    ...over,
  };
}
function signed(over = {}, w = W[0], auxRand = AUX) {
  const f = fields({ ...over, _w: w });
  delete f._w;
  return signCredential({ fields: f, priv: w.priv, internalXOnly: w.internalXOnly, auxRand });
}
const fails = (v) => v.checks.filter((c) => c.status === "fail").map((c) => c.name);

/* ---------- identity: key <-> address binding ---------- */

test("tweaked xonly matches wallet address (identity = key)", () => {
  for (const w of W) {
    const xonly = idPubkeyHex(w.internalXOnly);
    assert.equal(addressFromXonly(xonly, net), w.address);
    assert.ok(w.address.startsWith("prl1p"), "Taproot address");
  }
});

test("idKeyFromInput detects hex, WIF, mnemonic", () => {
  const hex = bytesToHex(W[0].priv);
  const byHex = idKeyFromInput(hex);
  assert.equal(byHex.source, "hex private key");
  assert.equal(bytesToHex(byHex.priv), hex);
  const wif = walletToWIF(W[0].priv, net);
  const byWif = idKeyFromInput(wif);
  assert.equal(byWif.source, "WIF");
  assert.equal(bytesToHex(byWif.priv), hex);
  const mn = newMnemonic();
  const byMn = idKeyFromInput(mn);
  assert.match(byMn.source, /^mnemonic/);
  assert.equal(bytesToHex(byMn.priv), bytesToHex(walletFromMnemonic(mn, net).priv));
});

test("idKeyFromInput rejects garbage", () => {
  assert.throws(() => idKeyFromInput("not a key"), /identity key must be/);
  assert.throws(() => idKeyFromInput("ab".repeat(31)), /identity key must be/); // 62 hex, not 64
});

/* ---------- canonical encoding ---------- */

test("canonical bytes are deterministic and whitespace-insensitive", () => {
  const f1 = fields({ domain: "  Example.COM " });
  const f2 = fields({ domain: "example.com" });
  const n1 = validateUnsignedFields(f1).norm;
  const n2 = validateUnsignedFields(f2).norm;
  assert.equal(canonicalCredential(n1), canonicalCredential(n2));
  const keys = Object.keys(JSON.parse(canonicalCredential(n1)));
  assert.deepEqual(keys, SIGNED_KEYS);
  assert.ok(!canonicalCredential(n1).includes(" "), "no whitespace in canonical form");
});

test("credential id is SHA-256 of canonical bytes", () => {
  const norm = validateUnsignedFields(fields()).norm;
  const canon = canonicalCredential(norm);
  const expect = bytesToHex(sha256(new TextEncoder().encode(canon)));
  assert.equal(credentialId(canon), expect);
  assert.match(credentialId(canon), /^[0-9a-f]{64}$/);
});

test("fingerprint is 64-bit (16 hex chars)", () => {
  const norm = validateUnsignedFields(fields()).norm;
  const fp = fingerprintOf(canonicalCredential(norm));
  assert.match(fp, /^[0-9a-f]{16}$/);
});

/* ---------- sign -> verify roundtrip ---------- */

test("sign -> verify = VALID, envelope has all 11 keys", () => {
  const env = signed();
  assert.deepEqual(Object.keys(env).sort(), [...ENVELOPE_KEYS].sort());
  assert.equal(env.protocol, ID_PROTOCOL);
  assert.equal(env.version, ID_VERSION);
  const v = verifyCredential(env, { expectedDomain: "example.com", nowSec: NOW });
  assert.equal(v.verdict, "VALID");
  assert.equal(v.id, env.id);
  assert.ok(v.checks.every((c) => c.status === "pass"), "every check passes: " + JSON.stringify(v.checks.filter((c) => c.status !== "pass")));
});

test("credentialJSON parses back to the same envelope", () => {
  const env = signed();
  assert.deepEqual(JSON.parse(credentialJSON(env)), env);
});

/* ---------- tamper detection ---------- */

test("tampered domain -> INVALID", () => {
  const env = signed();
  env.domain = "evil.com";
  const v = verifyCredential(env, { expectedDomain: "evil.com", nowSec: NOW });
  assert.equal(v.verdict, "INVALID");
  assert.ok(fails(v).includes("id matches canonical bytes"));
});

test("tampered signature -> INVALID", () => {
  const env = signed();
  env.sig = "ff" + env.sig.slice(2);
  const v = verifyCredential(env, { nowSec: NOW });
  assert.equal(v.verdict, "INVALID");
  assert.ok(fails(v).includes("BIP-340 signature verifies"));
});

test("unknown field -> INVALID", () => {
  const env = signed();
  env.role = "admin";
  const v = verifyCredential(env, { nowSec: NOW });
  assert.equal(v.verdict, "INVALID");
  assert.ok(fails(v).includes("no unknown fields"));
});

test("swapped xonly (attacker's key, victim's address) -> INVALID", () => {
  const env = signed();
  const attackerXonly = idPubkeyHex(W[1].internalXOnly);
  env.xonly = attackerXonly; // id + sig now bind the wrong key; address no longer matches
  const v = verifyCredential(env, { nowSec: NOW });
  assert.equal(v.verdict, "INVALID");
  assert.ok(fails(v).includes("address belongs to xonly"));
});

/* ---------- loud refusals at signing ---------- */

test("signing for someone else's address -> loud refusal", () => {
  const victim = fields({ _w: W[1] });
  assert.throws(
    () => signCredential({ fields: victim, priv: W[0].priv, internalXOnly: W[0].internalXOnly, auxRand: AUX }),
    /LOUD REFUSAL/
  );
});

test("signing with mismatched xonly -> loud refusal", () => {
  const f = fields({ _w: W[0] });
  f.xonly = idPubkeyHex(W[1].internalXOnly);
  assert.throws(
    () => signCredential({ fields: f, priv: W[0].priv, internalXOnly: W[0].internalXOnly, auxRand: AUX }),
    /LOUD REFUSAL/
  );
});

/* ---------- freshness & lifetime ---------- */

test("expired credential -> INVALID", () => {
  const env = signed({ issued_at: String(NOW - 600), expires_at: String(NOW - 60) });
  const v = verifyCredential(env, { nowSec: NOW });
  assert.equal(v.verdict, "INVALID");
  assert.ok(fails(v).includes("not expired"));
});

test("expires_at <= issued_at rejected at signing", () => {
  const f = fields({ issued_at: String(NOW), expires_at: String(NOW) });
  assert.throws(() => signCredential({ fields: f, priv: W[0].priv, internalXOnly: W[0].internalXOnly, auxRand: AUX }), /expires_at must be strictly after/);
});

test("lifetime over 7 days rejected at signing", () => {
  const f = fields({ issued_at: String(NOW), expires_at: String(NOW + MAX_LIFETIME_S + 1) });
  assert.throws(() => signCredential({ fields: f, priv: W[0].priv, internalXOnly: W[0].internalXOnly, auxRand: AUX }), /exceeds 7 days/);
});

test("issued far in the future -> INVALID; slight skew -> VALID-WARN", () => {
  const far = signed({ issued_at: String(NOW + 25 * 3600), expires_at: String(NOW + 26 * 3600) });
  assert.equal(verifyCredential(far, { nowSec: NOW }).verdict, "INVALID");
  const skew = signed({ issued_at: String(NOW + 400), expires_at: String(NOW + 1000) });
  const v = verifyCredential(skew, { nowSec: NOW });
  assert.equal(v.verdict, "VALID-WARN");
  assert.ok(v.checks.some((c) => c.name === "issued_at sane" && c.status === "warn"));
});

/* ---------- domain binding ---------- */

test("expected domain mismatch -> INVALID; absent expected domain -> VALID-WARN", () => {
  const env = signed();
  const v1 = verifyCredential(env, { expectedDomain: "other.org", nowSec: NOW });
  assert.equal(v1.verdict, "INVALID");
  assert.ok(fails(v1).includes("domain matches"));
  const v2 = verifyCredential(env, { nowSec: NOW });
  assert.equal(v2.verdict, "VALID-WARN");
  assert.ok(v2.checks.some((c) => c.name === "domain binding" && c.status === "warn"));
});

test("bad domain / challenge rejected at signing", () => {
  const badDomain = fields({ domain: "not a domain!!" });
  assert.throws(() => signCredential({ fields: badDomain, priv: W[0].priv, internalXOnly: W[0].internalXOnly, auxRand: AUX }), /domain must be a valid hostname/);
  const badChal = fields({ challenge: "abcd" }); // 16 bits, not 128
  assert.throws(() => signCredential({ fields: badChal, priv: W[0].priv, internalXOnly: W[0].internalXOnly, auxRand: AUX }), /challenge must be 32 or 64/);
  const ok128 = fields({ challenge: "ab".repeat(16) }); // 128-bit accepted
  assert.doesNotThrow(() => signCredential({ fields: ok128, priv: W[0].priv, internalXOnly: W[0].internalXOnly, auxRand: AUX }));
});

/* ---------- challenge entropy ---------- */

test("newChallengeHex gives 256-bit fresh challenges", () => {
  const a = newChallengeHex(), b = newChallengeHex();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
});

/* ---------- replay property (documented, honest) ---------- */

test("a credential verifies twice — replayable until expiry (relying party must use single-use challenges)", () => {
  const env = signed();
  assert.equal(verifyCredential(env, { expectedDomain: "example.com", nowSec: NOW }).verdict, "VALID");
  assert.equal(verifyCredential(env, { expectedDomain: "example.com", nowSec: NOW + 60 }).verdict, "VALID");
});

/* ---------- malformed input ---------- */

test("garbage input -> INVALID, never throws", () => {
  for (const raw of ["{nope", "", null, 42, [], { protocol: "prl-id" }]) {
    const v = verifyCredential(raw, { nowSec: NOW });
    assert.equal(v.verdict, "INVALID", "input: " + JSON.stringify(raw));
  }
});
