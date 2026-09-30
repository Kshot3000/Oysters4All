// Pearl Oracle core verification suite.
// Run: node --no-warnings --loader ./tests/loader.mjs --test tests/oracle.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import {
  NETWORKS,
  bytesToHex, hexToBytes, sha256, schnorr,
  newMnemonic,
  walletFromMnemonic, walletFromWIF, walletFromPriv, walletToWIF,
  tweakPrivKeypath, tweakKeypath,
  ORACLE_PROTOCOL, ORACLE_VERSION, GENESIS_PREV, FEED_STORAGE_KEY,
  TS_SANITY_TOLERANCE_S, ASSET_PRESETS,
  oraclePubkeyHex, oracleSigningKey, oracleKeyFromInput, genNonceHex,
  validateUnsignedFields, validateFields, canonicalAttestation, attestationId,
  signAttestation, verifyAttestation, verifyFeedChain,
  loadFeed, saveFeed, nextChainDefaults,
  importFeedText, feedToJSON, feedToCSV, seriesForAsset, formatPrice,
} from "../src/oracle-core.js";
import { numberToBytesBE } from "@noble/curves/abstract/utils";
import { secp256k1 } from "@noble/curves/secp256k1";

// crypto.getRandomValues for genNonceHex (node path)
if (!globalThis.crypto || typeof globalThis.crypto.getRandomValues !== "function") {
  globalThis.crypto = webcrypto;
}

const net = NETWORKS.mainnet;
const AUX = new Uint8Array(32).fill(7); // deterministic aux rand for test vectors

// Deterministic test keys: priv 1..4 -> wallets
function testWallet(i) {
  return walletFromPriv(numberToBytesBE(BigInt(i), 32), net);
}
const W = [1, 2, 3, 4].map(testWallet);

const NOW = String(Math.floor(Date.now() / 1000));

function fields(over = {}) {
  return {
    asset: "PRL/USD", price: "41250", decimals: "2", ts: NOW, seq: "7",
    nonce: "ab".repeat(16), prev: "cd".repeat(32), source: "CoinGecko spot",
    ...over,
  };
}
function signed(over = {}, w = W[0], auxRand = AUX) {
  return signAttestation({ fields: fields(over), priv: w.priv, internalXOnly: w.internalXOnly, auxRand });
}

/* ---------- canonical determinism ---------- */

test("canonical: fixed key order, identical bytes regardless of JS key order", () => {
  const a = fields();
  const b = { source: a.source, prev: a.prev, nonce: a.nonce, seq: a.seq, ts: a.ts, decimals: a.decimals, price: a.price, asset: a.asset };
  const ca = canonicalAttestation(a), cb = canonicalAttestation(b);
  assert.equal(ca, cb);
  assert.match(ca, /^\{"p":"prl-oracle","v":1,"asset":"PRL\/USD","price":"41250","decimals":"2","ts":"\d+","seq":"7","nonce":"(ab){16}","prev":"(cd){32}","source":"CoinGecko spot"\}$/);
});

test("canonical: attestation id = SHA-256 of canonical bytes", () => {
  const c = canonicalAttestation(fields());
  const expected = bytesToHex(sha256(new TextEncoder().encode(c)));
  assert.equal(attestationId(c), expected);
});

test("canonical: float price / leading zeros / negative refused", () => {
  for (const bad of ["412.50", "41250.0", "041250", "-5", "0x1234", ""]) {
    const v = validateUnsignedFields(fields({ price: bad }));
    assert.equal(v.ok, false, `price ${JSON.stringify(bad)} should be refused`);
  }
  assert.equal(validateUnsignedFields(fields({ price: "0" })).ok, true);
});

/* ---------- sign → verify round trip ---------- */

test("sign→verify round trip: VALID, pub = tweaked keypath x-only", () => {
  const s = signed();
  const expectedPub = bytesToHex(tweakKeypath(W[0].internalXOnly).tweakedX);
  assert.equal(s.pub, expectedPub);
  assert.equal(oraclePubkeyHex(W[0].internalXOnly), expectedPub);
  const v = verifyAttestation(s);
  assert.equal(v.verdict, "VALID");
  assert.equal(v.checks.filter((c) => c.status === "fail").length, 0);
  assert.equal(v.id, attestationId(canonicalAttestation(fields())));
});

test("signature is BIP-340 over the attestation id", () => {
  const s = signed();
  const id = attestationId(canonicalAttestation(fields()));
  assert.ok(schnorr.verify(hexToBytes(s.sig), hexToBytes(id), hexToBytes(s.pub)));
});

test("oracle signing key = tweakPrivKeypath (same construction as Ballot)", () => {
  assert.deepEqual(
    bytesToHex(oracleSigningKey(W[0].priv, W[0].internalXOnly)),
    bytesToHex(tweakPrivKeypath(W[0].priv, W[0].internalXOnly))
  );
});

test("wrong-key sign is a LOUD refusal (mismatched priv/internal pair)", () => {
  assert.throws(
    () => signAttestation({ fields: fields(), priv: W[0].priv, internalXOnly: W[1].internalXOnly, auxRand: AUX }),
    /LOUD REFUSAL/
  );
});

test("tampered price invalidates the signature", () => {
  const s = signed();
  s.price = "41251";
  const v = verifyAttestation(s);
  assert.equal(v.verdict, "INVALID");
  assert.ok(v.checks.some((c) => c.name.includes("signature") && c.status === "fail"));
});

test("tampered source invalidates the signature", () => {
  const s = signed();
  s.source = "someone else";
  assert.equal(verifyAttestation(s).verdict, "INVALID");
});

test("wrong-key pub on an otherwise valid envelope → INVALID", () => {
  const s = signed({}, W[0]);
  s.pub = oraclePubkeyHex(W[1].internalXOnly);
  const v = verifyAttestation(s);
  assert.equal(v.verdict, "INVALID");
});

test("flipped signature byte → INVALID", () => {
  const s = signed();
  const b = hexToBytes(s.sig);
  b[0] ^= 1;
  s.sig = bytesToHex(b);
  assert.equal(verifyAttestation(s).verdict, "INVALID");
});

/* ---------- field validation edge cases ---------- */

test("float price refused", () => {
  assert.equal(verifyAttestation({ ...signed(), price: "412.50" }).verdict, "INVALID");
});

test("bad nonce refused (short / non-hex)", () => {
  assert.equal(verifyAttestation({ ...signed(), nonce: "abcd" }).verdict, "INVALID");
  assert.equal(verifyAttestation({ ...signed(), nonce: "zz".repeat(16) }).verdict, "INVALID");
});

test("empty source refused; >200 chars refused", () => {
  assert.throws(() => signed({ source: "" }), /cannot canonicalize/);
  assert.throws(() => signed({ source: "x".repeat(201) }), /cannot canonicalize/);
  // and a tampered-after-sign source also rules INVALID via the signature
  assert.equal(verifyAttestation({ ...signed(), source: "tampered" }).verdict, "INVALID");
  assert.equal(verifyAttestation(signed({ source: "x".repeat(200) })).verdict, "VALID");
  assert.equal(verifyAttestation(signed({ source: "x" })).verdict, "VALID");
});

test("future ts beyond ±24h → loud WARNING, still VALID", () => {
  const future = String(Math.floor(Date.now() / 1000) + TS_SANITY_TOLERANCE_S + 3600);
  const v = verifyAttestation(signed({ ts: future }));
  assert.equal(v.verdict, "VALID-WARN");
  assert.ok(v.checks.some((c) => c.name === "timestamp sanity" && c.status === "warn"));
});

test("past ts beyond 24h → warning; within tolerance → pass", () => {
  const past = String(Math.floor(Date.now() / 1000) - TS_SANITY_TOLERANCE_S - 1);
  assert.equal(verifyAttestation(signed({ ts: past })).verdict, "VALID-WARN");
  const near = String(Math.floor(Date.now() / 1000) - 60);
  const v = verifyAttestation(signed({ ts: near }));
  assert.equal(v.verdict, "VALID");
  assert.ok(v.checks.some((c) => c.name === "timestamp sanity" && c.status === "pass"));
});

test("unknown field rejected", () => {
  const s = signed();
  s.fork = "evil";
  const v = verifyAttestation(s);
  assert.equal(v.verdict, "INVALID");
  assert.ok(v.checks.some((c) => c.name === "no unknown fields" && c.status === "fail"));
});

test("missing sig → INVALID; malformed JSON → INVALID; non-object → INVALID", () => {
  const s = signed(); delete s.sig;
  assert.equal(verifyAttestation(s).verdict, "INVALID");
  assert.equal(verifyAttestation("{not json").verdict, "INVALID");
  assert.equal(verifyAttestation([1, 2]).verdict, "INVALID");
});

test("wrong protocol tag / version refused", () => {
  assert.equal(verifyAttestation({ ...signed(), p: "other" }).verdict, "INVALID");
  assert.equal(verifyAttestation({ ...signed(), v: 2 }).verdict, "INVALID");
});

test("bad pub (not a curve x) refused; bad prev length refused", () => {
  assert.equal(verifyAttestation({ ...signed(), pub: "ff".repeat(32) }).verdict, "INVALID");
  assert.equal(verifyAttestation({ ...signed(), prev: "ab".repeat(31) }).verdict, "INVALID");
});

test("asset name rules: empty rejected, custom text accepted", () => {
  assert.throws(() => signed({ asset: "" }), /cannot canonicalize/);
  assert.equal(verifyAttestation(signed({ asset: "PRL/USDT-perp" })).verdict, "VALID");
  assert.throws(() => signed({ asset: "PRL (fake!)" }), /cannot canonicalize/);
  assert.throws(() => signed({ asset: "x".repeat(65) }), /cannot canonicalize/);
});

/* ---------- feed chain verification ---------- */

function chain(n, w = W[0]) {
  const rows = [];
  let prev = GENESIS_PREV;
  for (let i = 0; i < n; i++) {
    const s = signAttestation({
      fields: fields({ seq: String(i), prev, price: String(40000 + i), ts: NOW }),
      priv: w.priv, internalXOnly: w.internalXOnly, auxRand: AUX,
    });
    rows.push(s);
    prev = attestationId(canonicalAttestation(s));
  }
  return rows;
}

test("valid chain of 3 verifies row-by-row", () => {
  const rows = chain(3);
  const r = verifyFeedChain(rows);
  assert.equal(r.ok, true);
  assert.equal(r.rows.length, 3);
  assert.ok(r.rows.every((x) => x.status === "VALID"));
  // prev linkage is the id of the previous canonical bytes
  assert.equal(rows[1].prev, attestationId(canonicalAttestation(rows[0])));
});

test("broken prev link detected", () => {
  const rows = chain(3);
  rows[2].prev = "ee".repeat(32);
  // re-sign would fix the sig; leave the old sig so sig check also fails
  const r = verifyFeedChain(rows);
  assert.equal(r.ok, false);
  assert.equal(r.rows[2].status, "INVALID");
  assert.ok(r.rows[2].errors.some((e) => e.includes("prev link broken")));
});

test("forked prev (points at wrong ancestor) detected", () => {
  const rows = chain(3);
  // fork: row 2 claims row 0 as parent instead of row 1 — prev doesn't match row 1 id
  const forked = signAttestation({
    fields: fields({ seq: "2", prev: attestationId(canonicalAttestation(rows[0])), price: "40002", ts: NOW }),
    priv: W[0].priv, internalXOnly: W[0].internalXOnly, auxRand: AUX,
  });
  rows[2] = forked;
  const r = verifyFeedChain(rows);
  assert.equal(r.ok, false);
  assert.ok(r.rows[2].errors.some((e) => e.includes("prev link broken")));
});

test("seq regression detected", () => {
  const rows = chain(3);
  const dup = signAttestation({
    fields: fields({ seq: "1", prev: attestationId(canonicalAttestation(rows[1])), price: "40005", ts: NOW }),
    priv: W[0].priv, internalXOnly: W[0].internalXOnly, auxRand: AUX,
  });
  rows[2] = dup;
  const r = verifyFeedChain(rows);
  assert.equal(r.ok, false);
  assert.ok(r.rows[2].errors.some((e) => e.includes("strictly increase")));
});

test("bad genesis prev detected", () => {
  const rows = chain(2);
  const bad = signAttestation({
    fields: fields({ seq: "0", prev: "11".repeat(32), price: "40000", ts: NOW }),
    priv: W[0].priv, internalXOnly: W[0].internalXOnly, auxRand: AUX,
  });
  rows[0] = bad;
  const r = verifyFeedChain(rows);
  assert.equal(r.ok, false);
  assert.ok(r.rows[0].errors.some((e) => e.includes("genesis prev")));
});

test("empty chain verifies", () => {
  const r = verifyFeedChain([]);
  assert.equal(r.ok, true);
  assert.equal(r.rows.length, 0);
});

/* ---------- key import / identity ---------- */

test("oracleKeyFromInput auto-detects hex / WIF / mnemonic", () => {
  const w = W[0];
  const fromHex = oracleKeyFromInput(bytesToHex(w.priv), net);
  assert.equal(fromHex.source, "hex private key");
  assert.equal(bytesToHex(fromHex.priv), bytesToHex(w.priv));
  const wif = walletToWIF(w.priv, net);
  const fromWif = oracleKeyFromInput(wif, net);
  assert.equal(fromWif.source, "WIF");
  assert.equal(bytesToHex(fromWif.priv), bytesToHex(w.priv));
  const mn = newMnemonic();
  const fromMn = oracleKeyFromInput(mn, net);
  assert.match(fromMn.source, /mnemonic/);
  assert.equal(fromMn.address, walletFromMnemonic(mn, net).address);
});

test("oracleKeyFromInput refuses garbage", () => {
  assert.throws(() => oracleKeyFromInput("not a key", net), /must be a 32-byte hex/);
});

test("oracle pubkey equals the PRL address program (same key controls the address)", () => {
  const w = W[0];
  assert.equal(oraclePubkeyHex(w.internalXOnly), bytesToHex(tweakKeypath(w.internalXOnly).tweakedX));
  // wallet address is built from the same tweaked x-only key (crypto.js walletFromPriv)
  assert.ok(w.address.startsWith("prl1p"));
});

test("genNonceHex: 16 CSPRNG bytes, 32 lowercase hex, unique", () => {
  const a = genNonceHex(), b = genNonceHex();
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, b);
});

/* ---------- export / import round trip ---------- */

test("export JSON → import round trip preserves the feed", () => {
  const rows = chain(2);
  const json = feedToJSON(rows);
  const back = importFeedText(json);
  assert.equal(back.length, 2);
  assert.deepEqual(back, rows);
});

test("import refuses a feed containing one INVALID row", () => {
  const rows = chain(2);
  const tampered = JSON.parse(JSON.stringify(rows));
  tampered[1].price = "99999";
  assert.throws(() => importFeedText(JSON.stringify(tampered)), /row 1 INVALID/);
});

test("import accepts a single envelope (non-array)", () => {
  const s = signed();
  const back = importFeedText(JSON.stringify(s));
  assert.equal(back.length, 1);
});

test("CSV export: header + one line per row, id first", () => {
  const rows = chain(2);
  const csv = feedToCSV(rows);
  const lines = csv.split("\n");
  assert.equal(lines.length, 3);
  assert.ok(lines[0].startsWith("id,p,v,asset,price,decimals,ts,seq,nonce,prev,source,pub,sig"));
  assert.ok(lines[1].startsWith(attestationId(canonicalAttestation(rows[0])) + ","));
});

/* ---------- chart series / formatting ---------- */

test("seriesForAsset: BigInt scaling, sorted by ts", () => {
  const rows = [
    signed({ asset: "PRL/USD", price: "41250", decimals: "2", ts: String(Number(NOW) + 60), seq: "1" }),
    signed({ asset: "PRL/USD", price: "41", decimals: "0", ts: NOW, seq: "0" }),
    signed({ asset: "PRL/BTC", price: "100", decimals: "0", ts: NOW, seq: "0" }),
  ];
  const s = seriesForAsset(rows, "PRL/USD");
  assert.equal(s.decimals, 2);
  assert.equal(s.points.length, 2);
  assert.ok(s.points[0].ts < s.points[1].ts);
  assert.equal(s.points[0].value, 4100); // 41 scaled to 2 decimals
  assert.equal(s.points[1].value, 41250);
});

test("formatPrice: pure string math, no floats", () => {
  assert.equal(formatPrice("41250", "2"), "412.50");
  assert.equal(formatPrice("41200", "2"), "412.00");
  assert.equal(formatPrice("5", "4"), "0.0005");
  assert.equal(formatPrice("123", "0"), "123");
  assert.equal(formatPrice("100000000", "8"), "1.00000000");
});

/* ---------- composer defaults ---------- */

test("nextChainDefaults: genesis, then chain continuation", () => {
  assert.deepEqual(nextChainDefaults([]), { prev: GENESIS_PREV, seq: "0" });
  const rows = chain(2);
  const d = nextChainDefaults(rows);
  assert.equal(d.prev, attestationId(canonicalAttestation(rows[1])));
  assert.equal(d.seq, "2");
});
