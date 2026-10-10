// Pearl Pact core — Discreet Log Contract (DLC) desk for PRL (pure logic, no DOM).
//
// What a pact is: two parties lock collateral into a 2-of-2 Taproot funding
// output. For every possible outcome of an agreed event, a Contract Execution
// Transaction (CET) is pre-built that splits the collateral per the payout
// map. Each party pre-signs every CET with a Schnorr *adaptor signature*
// encrypted to the oracle's per-outcome announcement point T_o. When the
// oracle attests to outcome w, it reveals the outcome secret t_w (proving it
// matches the committed T_w and signing the attestation); either party can
// then decrypt the counterparty's CET_w signature and broadcast it. A
// timelocked refund transaction, signed by both parties up front, is the
// insurance leg if the oracle never attests.
//
// Cryptography lineage (no new primitives — only new composition):
//   - Schnorr/BIP-340, Taproot tweaks, bech32m, tagged hashes: audited
//     sign/src/crypto.js (pearlpurse lineage, verified against Pearl's Go).
//   - 2-of-2 CHECKSIGADD script, NUMS internal key, BIP-341 script-path
//     sighash, script-path vBytes: audited vault/src/vault-core.js.
//   - Adaptor signatures: the standard Schnorr adaptor construction
//     (encrypt: e = H(R'||P||m), s* = k + e*d with R' = R + T even-Y;
//     verify: s*.G + T == R' + e.P; decrypt: s = s* + t). The decrypted
//     signature is a plain BIP-340 signature verifiable by any node.
//   - Oracle outcome secrets are deterministic:
//     t_o = H("PearlPactOutcomeSecret/v1" || x_oracle || eventId || o) mod n,
//     so the oracle operator re-derives them at attestation time.
//
// Honest boundaries, enforced in code:
//   - The page never broadcasts anything by itself; hex is copied out and
//     broadcast by the user (Blockbook button included, double-confirmed).
//   - The oracle is trusted to attest truthfully: it cannot steal (it never
//     holds a key that can move funds), but it alone picks the winner.
//   - CETs are only valid after the funding output confirms; the refund leg
//     only becomes valid after its nLockTime.
//
// Protocol facts (verified against upstream, not from memory):
//   - P2TR dust 546 grains, tx version 1, bech32m HRPs prl/tprl,
//     BIP-86 coin types 808276 (mainnet) / 1 (testnet).
//   - TapLeaf/TapBranch/TapTweak tags: BIP-341.
import {
  taggedHash, encodeBech32m, decodeBech32m, commitKeyInfo,
  p2trScriptPubKey, tapLeafHash, varint, u32le, u64le, txidLE, dblSha,
  sha256, schnorr, bytesToHex, hexToBytes,
  DUST_GRAIN, GRAIN_PER_PRL, NETWORKS, tweakKeypath,
  keypathTxVBytes, keypathSigDigestEx,
  fetchUtxos, fetchFeeRateGrainsPerVByte, broadcastTx,
} from "../../sign/src/crypto.js";
import {
  cosignerKeyFromInput, cosignerPrivFromHex,
  scriptPathSigDigestMulti, scriptPathVBytes, verifySchnorrSig,
} from "../../vault/src/vault-core.js";
import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesToNumberBE, numberToBytesBE } from "@noble/curves/abstract/utils";
import { randomBytes } from "@noble/hashes/utils";

export {
  DUST_GRAIN, GRAIN_PER_PRL, NETWORKS,
  fetchUtxos, fetchFeeRateGrainsPerVByte, broadcastTx,
  bytesToHex, hexToBytes, sha256, schnorr, encodeBech32m, decodeBech32m,
};

const N = secp256k1.CURVE.n;
const G = secp256k1.ProjectivePoint.BASE;
const MAX_SEQ = 0xffffffff;
const REFUND_SEQ = 0xfffffffe;

export const NUMS_DOMAIN = "PearlPactNUMS/v1";
const OUTCOME_SECRET_TAG = "PearlPactOutcomeSecret/v1";
const ATTEST_PREFIX = "PearlPactAttestation/v1:";
const DESCRIPTOR_KIND = "pearl-pact:v1";
const SEALED_KIND = "pearl-pact-sealed:v1";
const DONATION_ADDRESS = "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d";
const X_HANDLE = "@kshot9000";

const refuse = (msg) => { throw new Error("PACT REFUSED: " + msg); };
const utf8 = (s) => new TextEncoder().encode(s);
const concat = (...arrs) => {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
};
const xOnlyOf = (point) => point.toRawBytes(true).slice(1); // 32B x of compressed point
const liftX = (xBytes) => schnorr.utils.lift_x(bytesToNumberBE(xBytes));

function assertXOnlyHex(hex, what) {
  const t = String(hex || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(t)) refuse(`${what} must be 64 hex characters`);
  try { liftX(hexToBytes(t)); } catch { refuse(`${what} is not a valid secp256k1 x-coordinate`); }
  return t;
}
function assertPrivHex(hex, what) {
  const t = String(hex || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(t)) refuse(`${what} must be 64 hex characters`);
  const d = bytesToNumberBE(hexToBytes(t));
  if (d <= 0n || d >= N) refuse(`${what} out of range`);
  return t;
}
/** BIP-340 key negation: return the scalar whose pubkey has even Y. */
function evenYScalar(privBytes) {
  let d = bytesToNumberBE(privBytes);
  const P = secp256k1.ProjectivePoint.fromPrivateKey(numberToBytesBE(d, 32));
  if (P.toRawBytes(true)[0] === 0x03) d = N - d;
  return d;
}
function drawScalar() {
  for (;;) {
    const k = bytesToNumberBE(randomBytes(32)) % N;
    if (k !== 0n) return k;
  }
}

/* ================= Schnorr adaptor signatures =================
 * Encrypt(d, m, T): pick k, R = kG, R' = R + T (retry until even Y),
 *   e = int(H_BIP0340/challenge(R'x || P || m)), s* = k + e*d.
 * Verify(R'x, s*, P, m, T): e as above; accept iff s*.G + T == R' + e.P.
 * Decrypt(s*, t): s = s* + t', where t' is the even-Y-normalized outcome
 *   secret (x-only announcement points imply even Y per BIP-340; t and n-t
 *   share the x-only point, so the page normalizes the revealed secret).
 */
export function adaptorEncrypt(privHex, digestHex, adaptorPointXHex) {
  const d = evenYScalar(hexToBytes(assertPrivHex(privHex, "private key")));
  const dt = String(digestHex || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(dt)) refuse("digest must be 64 hex characters");
  const dg = hexToBytes(dt);
  const Px = xOnlyOf(secp256k1.ProjectivePoint.fromPrivateKey(numberToBytesBE(d, 32)));
  const T = liftX(hexToBytes(assertXOnlyHex(adaptorPointXHex, "adaptor point")));
  for (let attempt = 0; attempt < 128; attempt++) {
    const k = drawScalar();
    const Rp = G.multiply(k).add(T);
    if (Rp.toRawBytes(true)[0] === 0x03) continue; // need even-Y R' for x-only verify
    const Rpx = xOnlyOf(Rp);
    const e = bytesToNumberBE(taggedHash("BIP0340/challenge", concat(Rpx, Px, dg))) % N;
    const sStar = (k + e * d) % N;
    if (sStar === 0n) continue;
    return { RprimeX: bytesToHex(Rpx), sStar: bytesToHex(numberToBytesBE(sStar, 32)) };
  }
  refuse("adaptor encryption failed to find even-Y R' (unreachable in practice)");
}

export function adaptorVerify(RprimeXHex, sStarHex, pubkeyXHex, digestHex, adaptorPointXHex) {
  try {
    const RpxHex = assertXOnlyHex(RprimeXHex, "R'");
    const sStar = bytesToNumberBE(hexToBytes(assertPrivHex(sStarHex, "s*")));
    const pubHex = assertXOnlyHex(pubkeyXHex, "pubkey");
    const dt = String(digestHex || "").trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(dt)) return false;
    const dg = hexToBytes(dt);
    const T = liftX(hexToBytes(assertXOnlyHex(adaptorPointXHex, "adaptor point")));
    const Rp = liftX(hexToBytes(RpxHex));
    const P = liftX(hexToBytes(pubHex));
    const e = bytesToNumberBE(taggedHash("BIP0340/challenge", concat(hexToBytes(RpxHex), hexToBytes(pubHex), dg))) % N;
    const lhs = G.multiply(sStar).add(T);
    const rhs = Rp.add(P.multiply(e));
    return lhs.equals(rhs);
  } catch {
    return false;
  }
}

/** Normalize a secret scalar to the even-Y representative of its x-only point
 *  (BIP-340 convention: x-only keys imply even Y). The oracle reveals t with
 *  x(t.G) == T_x, but t.G itself may have odd Y while encryption used
 *  lift_x(T_x); n-t has the same x-only point and the even-Y representative. */
function evenYSecret(tHex) {
  const t = bytesToNumberBE(hexToBytes(assertPrivHex(tHex, "outcome secret")));
  const Pt = G.multiply(t);
  const te = Pt.toRawBytes(true)[0] === 0x03 ? (N - t) % N : t;
  return bytesToHex(numberToBytesBE(te, 32));
}

/** Decrypt an adaptor signature with the revealed outcome secret t. */
export function adaptorDecrypt(sStarHex, tHex) {
  const sStar = bytesToNumberBE(hexToBytes(assertPrivHex(sStarHex, "s*")));
  const t = bytesToNumberBE(hexToBytes(evenYSecret(tHex)));
  return bytesToHex(numberToBytesBE((sStar + t) % N, 32));
}

/* ================= oracle ================= */

/** Mint a fresh oracle keypair (local only). */
export function mintOracleKey() {
  for (;;) {
    const priv = randomBytes(32);
    const d = bytesToNumberBE(priv);
    if (d > 0n && d < N) {
      return {
        privHex: bytesToHex(priv),
        pubXOnlyHex: bytesToHex(xOnlyOf(secp256k1.ProjectivePoint.fromPrivateKey(priv))),
      };
    }
  }
}

/** Deterministic per-outcome secret: t_o = H(tag || x_oracle || eventId || o) mod n. */
export function oracleOutcomeSecret(oraclePrivHex, eventId, index) {
  const priv = hexToBytes(assertPrivHex(oraclePrivHex, "oracle private key"));
  const eid = String(eventId || "");
  if (!eid) refuse("event id is empty");
  if (!Number.isInteger(index) || index < 0) refuse("outcome index out of range");
  const msg = concat(priv, utf8(OUTCOME_SECRET_TAG), utf8(eid), u32le(index));
  let t = bytesToNumberBE(taggedHash(OUTCOME_SECRET_TAG, msg)) % N;
  if (t === 0n) t = 1n; // unreachable in practice; keep the math total
  return {
    tHex: bytesToHex(numberToBytesBE(t, 32)),
    pointXHex: bytesToHex(xOnlyOf(G.multiply(t))),
  };
}

/** The oracle's public announcement set: one committed point per outcome. */
export function oracleAnnouncements(oraclePrivHex, eventId, nOutcomes) {
  assertOutcomeCount(nOutcomes);
  const out = [];
  for (let i = 0; i < nOutcomes; i++) {
    const { pointXHex } = oracleOutcomeSecret(oraclePrivHex, eventId, i);
    out.push({ index: i, pointXHex });
  }
  return out;
}

function assertOutcomeCount(n) {
  if (!Number.isInteger(n) || n < 2 || n > 8) refuse("a pact needs 2–8 outcomes");
}

function attestationMessage(eventId, index) {
  return utf8(ATTEST_PREFIX + eventId + ":" + index);
}

/** Oracle attests to outcome `index`: reveals t plus a Schnorr signature. */
export function oracleAttest(oraclePrivHex, eventId, index) {
  const { tHex } = oracleOutcomeSecret(oraclePrivHex, eventId, index);
  const priv = hexToBytes(assertPrivHex(oraclePrivHex, "oracle private key"));
  const sig = schnorr.sign(attestationMessage(String(eventId), index), priv, randomBytes(32));
  return { outcomeIndex: index, tHex, sigHex: bytesToHex(sig) };
}

/** Verify an attestation against the committed announcement point. */
export function verifyAttestation({ oraclePubXOnlyHex, eventId, outcomeIndex, tHex, sigHex, committedPointXHex }) {
  const reasons = [];
  const pubHex = (() => { try { return assertXOnlyHex(oraclePubXOnlyHex, "oracle pubkey"); } catch (e) { reasons.push(e.message); return null; } })();
  const commitHex = (() => { try { return assertXOnlyHex(committedPointXHex, "committed announcement point"); } catch (e) { reasons.push(e.message); return null; } })();
  let t = null;
  try { t = bytesToNumberBE(hexToBytes(assertPrivHex(tHex, "outcome secret"))); }
  catch (e) { reasons.push(e.message); }
  if (!Number.isInteger(outcomeIndex) || outcomeIndex < 0) reasons.push("outcome index out of range");
  if (!eventId) reasons.push("event id is empty");
  let sig = null;
  try {
    const st = String(sigHex || "").trim().toLowerCase();
    if (!/^[0-9a-f]{128}$/.test(st)) throw new Error("attestation signature must be 128 hex characters");
    sig = hexToBytes(st);
  } catch (e) { reasons.push(e.message); }
  if (reasons.length) return { ok: false, reasons };
  // 1. the revealed secret must match the committed announcement point
  const gotPointX = bytesToHex(xOnlyOf(G.multiply(t)));
  if (gotPointX !== commitHex) {
    return { ok: false, reasons: [`revealed secret does not match the committed announcement point for outcome ${outcomeIndex} — wrong outcome or forged attestation`] };
  }
  // 2. the oracle's signature must verify over the canonical attestation message
  let sigOk = false;
  try { sigOk = schnorr.verify(sig, attestationMessage(String(eventId), outcomeIndex), hexToBytes(pubHex)); }
  catch { sigOk = false; }
  if (!sigOk) return { ok: false, reasons: ["oracle attestation signature does not verify under the oracle pubkey"] };
  return { ok: true, reasons: [] };
}

/* ================= party keys ================= */

/**
 * Parse a party key with an explicit kind (never guessed):
 *   "xonly"  — 64-hex x-only pubkey (watch-only, cannot sign)
 *   "priv"   — 64-hex private key (local signing key)
 *   "wif"    — WIF (local signing key)
 *   "mnemonic" — 12/24-word BIP-39 mnemonic, BIP-86 account key (local)
 */
export function partyKeyFromInput(input, kind, network) {
  const net = typeof network === "string" ? networkOf(network) : network;
  if (!net || !net.id) refuse(`unknown network "${network}"`);
  const t = String(input || "").trim();
  if (!t) refuse("party key is empty");
  if (kind === "priv") return { ...cosignerPrivFromHex(t, net), kind };
  if (kind === "xonly") {
    const k = cosignerKeyFromInput(t, net);
    if (k.priv) refuse("expected an x-only pubkey for watch-only kind");
    return { ...k, kind };
  }
  // wif / mnemonic flow through the vault parser, then assert the source
  const k = cosignerKeyFromInput(t, net);
  if (!k.priv) refuse(`expected a ${kind} with signing capability`);
  return { ...k, kind };
}

function networkOf(id) {
  const net = Object.values(NETWORKS).find((x) => x.id === id);
  if (!net) refuse(`unknown network "${id}"`);
  return net;
}

/** A party's plain keypath P2TR payout address (for CET/refund outputs). */
export function partyPayoutAddress(xonlyHex, networkId) {
  const net = networkOf(networkId);
  const x = hexToBytes(assertXOnlyHex(xonlyHex, "party key"));
  const { tweakedX } = tweakKeypath(x);
  return encodeBech32m(net.hrp, 1, tweakedX);
}

/* ================= draft: terms, funding script, descriptor ================= */

const OP = { FALSE: 0x00, CHECKSIGADD: 0xba, EQUAL: 0x87, NUM2: 0x52 };
function pushData(b) {
  if (b.length > 75) refuse("push too large");
  return [b.length, ...b];
}

/** 2-of-2 CHECKSIGADD leaf, keys sorted lexicographically (BIP-67 style). */
export function buildFundingScript(aliceXOnlyHex, bobXOnlyHex) {
  const ka = hexToBytes(assertXOnlyHex(aliceXOnlyHex, "alice key"));
  const kb = hexToBytes(assertXOnlyHex(bobXOnlyHex, "bob key"));
  if (bytesToHex(ka) === bytesToHex(kb)) refuse("alice and bob must use different keys");
  const [k1, k2] = [ka, kb].sort((a, b) => {
    for (let i = 0; i < 32; i++) { if (a[i] !== b[i]) return a[i] - b[i]; }
    return 0;
  });
  const script = Uint8Array.from([OP.FALSE, ...pushData(k1), OP.CHECKSIGADD, ...pushData(k2), OP.CHECKSIGADD, OP.NUM2, OP.EQUAL]);
  return { script, keyOrder: [bytesToHex(k1), bytesToHex(k2)] };
}

/** NUMS internal key: nobody knows the discrete log — no keypath backdoor. */
export function numsInternalKeyPact(script) {
  const preimage = concat(utf8(NUMS_DOMAIN), script);
  for (let counter = 0; counter < 256; counter++) {
    const pre = counter === 0 ? preimage : concat(preimage, Uint8Array.of(counter));
    const h = sha256(pre);
    try { liftX(h); return h; } catch { /* next counter */ }
  }
  refuse("NUMS lift failed (unreachable in practice)");
}

function assertGrains(v, what, { min = DUST_GRAIN } = {}) {
  const n = typeof v === "bigint" ? v : BigInt(Math.trunc(Number(v)));
  if (!Number.isSafeInteger(Number(n)) || n < BigInt(min)) refuse(`${what} must be at least ${min} grains`);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) refuse(`${what} exceeds safe integer range`);
  return Number(n);
}
function assertFeeRate(v, what) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1 || n > 100000) refuse(`${what} must be between 1 and 100000 grains/vB`);
  return n;
}

function canonicalTermsJson(t) {
  return JSON.stringify({
    kind: DESCRIPTOR_KIND,
    network: t.networkId,
    title: t.title,
    alice: { name: t.alice.name, xonly: t.alice.xonly },
    bob: { name: t.bob.name, xonly: t.bob.xonly },
    keyOrder: t.keyOrder,
    oracle: { name: t.oracle.name, pubkey: t.oracle.pubkey, eventId: t.oracle.eventId, commits: t.oracle.commits },
    outcomes: t.outcomes.map((o) => ({ label: o.label, aliceGrains: o.aliceGrains, bobGrains: o.bobGrains })),
    collateralAlice: t.collateralAlice,
    collateralBob: t.collateralBob,
    fundingFeeRate: t.fundingFeeRate,
    cetFeeRate: t.cetFeeRate,
    cetFeeGrains: t.cetFeeGrains,
    cetVBytes: t.cetVBytes,
    refundLockHeight: t.refundLockHeight,
    refundFeeRate: t.refundFeeRate,
    internalXOnly: t.internalXOnly,
    address: t.address,
    script: t.script,
    controlBlock: t.controlBlock,
  });
}

/**
 * Draft the pact terms. Validates everything, derives the 2-of-2 funding
 * taptree, and seals a tamper-evident descriptor.
 *
 * outcomes: [{label, aliceGrains, bobGrains}] — each row must sum to
 *   (collateralAlice + collateralBob - cetFeeGrains).
 * oracle: {name, pubkey (x-only hex), eventId, commits: [pointXHex...]}
 *   commits must have exactly outcomes.length entries.
 */
export function buildPactTerms({
  networkId = "mainnet", title,
  aliceName, aliceKey, aliceKind, bobName, bobKey, bobKind,
  oracleName, oraclePubkey, eventId, oracleCommits,
  outcomes, collateralAlice, collateralBob,
  fundingFeeRate, cetFeeRate, refundFeeRate, refundLockHeight,
}) {
  const net = networkOf(networkId);
  const cleanTitle = String(title || "").trim();
  if (!cleanTitle || cleanTitle.length > 80) refuse("title must be 1–80 characters");
  const aName = String(aliceName || "Alice").trim().slice(0, 40) || "Alice";
  const bName = String(bobName || "Bob").trim().slice(0, 40) || "Bob";
  const oName = String(oracleName || "Oracle").trim().slice(0, 40) || "Oracle";
  const eid = String(eventId || "").trim();
  if (!eid || eid.length > 120) refuse("event id must be 1–120 characters");

  const alice = partyKeyFromInput(aliceKey, aliceKind, net);
  const bob = partyKeyFromInput(bobKey, bobKind, net);
  const oraclePub = assertXOnlyHex(oraclePubkey, "oracle pubkey");

  const collA = assertGrains(collateralAlice, "alice collateral");
  const collB = assertGrains(collateralBob, "bob collateral");
  const total = collA + collB;

  if (!Array.isArray(outcomes)) refuse("outcomes must be a list");
  assertOutcomeCount(outcomes.length);
  const seen = new Set();
  const rows = outcomes.map((o, i) => {
    const label = String(o.label || "").trim();
    if (!label || label.length > 60) refuse(`outcome ${i}: label must be 1–60 characters`);
    if (seen.has(label.toLowerCase())) refuse(`outcome ${i}: duplicate label "${label}"`);
    seen.add(label.toLowerCase());
    const ag = assertGrains(o.aliceGrains, `outcome "${label}" alice share`);
    const bg = assertGrains(o.bobGrains, `outcome "${label}" bob share`);
    return { label, aliceGrains: ag, bobGrains: bg };
  });

  if (!Array.isArray(oracleCommits) || oracleCommits.length !== rows.length) {
    refuse(`oracle must commit exactly ${rows.length} announcement points (one per outcome)`);
  }
  const commits = oracleCommits.map((c, i) => assertXOnlyHex(c, `oracle announcement point ${i}`));
  if (new Set(commits).size !== commits.length) refuse("oracle announcement points must be distinct per outcome");

  const { script, keyOrder } = buildFundingScript(bytesToHex(alice.xonly), bytesToHex(bob.xonly));
  const internalXOnly = bytesToHex(numsInternalKeyPact(script));
  const info = commitKeyInfo(net, hexToBytes(internalXOnly), script);

  const cetVBytes = scriptPathVBytes(1, 2, script.length, 2, 2);
  const fr = assertFeeRate(fundingFeeRate, "funding fee rate");
  const cr = assertFeeRate(cetFeeRate, "CET fee rate");
  const rr = assertFeeRate(refundFeeRate, "refund fee rate");
  const cetFeeGrains = Math.ceil(cetVBytes * cr);
  const distributable = total - cetFeeGrains;
  if (distributable < 2 * DUST_GRAIN) refuse(`collateral ${total} grains cannot cover the CET fee of ${cetFeeGrains} grains plus dust floors`);
  rows.forEach((r) => {
    if (r.aliceGrains + r.bobGrains !== distributable) {
      refuse(`outcome "${r.label}": shares sum to ${r.aliceGrains + r.bobGrains} grains but must equal exactly ${distributable} (collateral ${total} − CET fee ${cetFeeGrains})`);
    }
  });

  const lockH = Number(refundLockHeight);
  if (!Number.isSafeInteger(lockH) || lockH < 1 || lockH > 0xffffffff) refuse("refund lock height must be a positive block height");

  const terms = {
    networkId: net.id,
    title: cleanTitle,
    alice: { name: aName, xonly: bytesToHex(alice.xonly), hasPriv: !!alice.priv },
    bob: { name: bName, xonly: bytesToHex(bob.xonly), hasPriv: !!bob.priv },
    keyOrder,
    oracle: { name: oName, pubkey: oraclePub, eventId: eid, commits },
    outcomes: rows,
    collateralAlice: collA,
    collateralBob: collB,
    totalCollateral: total,
    fundingFeeRate: fr,
    cetFeeRate: cr,
    refundFeeRate: rr,
    cetFeeGrains,
    cetVBytes,
    refundLockHeight: lockH,
    internalXOnly,
    address: info.commitAddress,
    script: bytesToHex(script),
    controlBlock: bytesToHex(info.controlBlock),
    merkleRoot: bytesToHex(info.merkleRoot),
    tweakedX: bytesToHex(info.commitXOnly),
    alicePayout: partyPayoutAddress(bytesToHex(alice.xonly), net.id),
    bobPayout: partyPayoutAddress(bytesToHex(bob.xonly), net.id),
  };
  const canonical = canonicalTermsJson(terms);
  terms.descriptorHash = bytesToHex(sha256(utf8(canonical)));
  terms.descriptor = `${DESCRIPTOR_KIND}:${net.hrp}:${terms.descriptorHash}`;
  terms._canonical = canonical;
  return terms;
}

/** Standalone verifier: paste exported terms JSON; the seal is recomputed. */
export function verifyPactDescriptor(text) {
  const raw = String(text || "").trim();
  if (!raw) return { verdict: "NOT PROVEN", reasons: ["nothing pasted"], terms: null };
  if (!raw.startsWith("{")) {
    return {
      verdict: "NOT PROVEN",
      reasons: ["a bare descriptor string cannot be verified alone — paste the exported pact terms JSON (it carries the descriptor seal)"],
      terms: null,
    };
  }
  try {
    const t = importTerms(raw);
    return {
      verdict: "PROVEN",
      reasons: [
        `Funding address ${t.address} recomputed from the 2-of-2 script tree under the NUMS internal key.`,
        `Oracle commitments (${t.oracle.commits.length} announcement points) and payout maps recompute exactly.`,
        `Seal ${t.descriptor} matches: nothing was altered after drafting.`,
      ],
      terms: t,
    };
  } catch (e) {
    return { verdict: "NOT PROVEN", reasons: [String(e.message || e).replace(/^PACT REFUSED: /, "")], terms: null };
  }
}

/** Export/import the sealed terms (private keys are NEVER included). */
export function exportTerms(terms) {
  const o = JSON.parse(terms._canonical);
  o.descriptor = terms.descriptor;
  return JSON.stringify(o, null, 2);
}
export function importTerms(text) {
  let o;
  try { o = JSON.parse(String(text)); } catch { refuse("terms JSON is not valid JSON"); }
  if (o.kind !== DESCRIPTOR_KIND) refuse("not a pearl-pact terms object");
  const t = buildPactTerms({
    networkId: o.network, title: o.title,
    aliceName: o.alice?.name, aliceKey: o.alice?.xonly, aliceKind: "xonly",
    bobName: o.bob?.name, bobKey: o.bob?.xonly, bobKind: "xonly",
    oracleName: o.oracle?.name, oraclePubkey: o.oracle?.pubkey,
    eventId: o.oracle?.eventId, oracleCommits: o.oracle?.commits,
    outcomes: o.outcomes, collateralAlice: o.collateralAlice, collateralBob: o.collateralBob,
    fundingFeeRate: o.fundingFeeRate, cetFeeRate: o.cetFeeRate,
    refundFeeRate: o.refundFeeRate ?? o.cetFeeRate, refundLockHeight: o.refundLockHeight,
  });
  if (o.descriptor && o.descriptor !== t.descriptor) refuse("terms seal broken — descriptor hash mismatch");
  return t;
}

/* ================= wire serialization ================= */

/**
 * Serialize a script-path spend with explicit locktime + per-input sequence.
 * witnesses: per-input arrays of signature items (Uint8Array), or null for
 * the base (non-witness) serialization used for txids.
 */
export function serializeScriptPathTx(network, inputs, outputs, { locktime = 0, witnesses = null, script = null, controlBlock = null } = {}) {
  const net = networkOf(network.id || network);
  const out = [];
  out.push(...u32le(net.txVersion));
  const withWitness = Array.isArray(witnesses) && witnesses.some((w) => w !== null);
  if (withWitness) {
    if (!(script instanceof Uint8Array) || !(controlBlock instanceof Uint8Array)) refuse("script + control block required for witness serialization");
    out.push(0x00, 0x01);
  }
  out.push(...varint(inputs.length));
  for (const i of inputs) {
    out.push(...txidLE(i.txid), ...u32le(i.vout), ...varint(0), ...u32le(i.sequence ?? MAX_SEQ));
  }
  out.push(...varint(outputs.length));
  for (const o of outputs) {
    const s = p2trScriptPubKey(o.program);
    out.push(...u64le(o.value), ...varint(s.length), ...s);
  }
  out.push(...u32le(locktime));
  if (withWitness) {
    for (let idx = 0; idx < inputs.length; idx++) {
      const stack = witnesses[idx] || [];
      const items = [...stack, script, controlBlock];
      out.push(...varint(items.length));
      for (const it of items) out.push(...varint(it.length), ...it);
    }
  }
  return Uint8Array.from(out);
}

function txidOf(baseBytes) {
  return bytesToHex(dblSha(baseBytes).reverse());
}

function parseUtxoLine(line, owner) {
  const t = String(line || "").trim();
  if (!t) return null;
  const m = t.match(/^([0-9a-fA-F]{64}):(\d+):(\d+)$/);
  if (!m) refuse(`UTXO line "${t}" must look like txid:vout:value-grains`);
  return { txid: m[1].toLowerCase(), vout: Number(m[2]), value: Number(m[3]), owner };
}

/* ================= funding transaction ================= */

/**
 * Plan the funding tx: both parties' keypath inputs -> the 2-of-2 funding
 * output (+ per-party change). Fee is split evenly; dust change is absorbed
 * into the fee and disclosed. Returns the unsigned hex + plan details.
 */
export function planFundingTx({ networkId = "mainnet", terms, aliceUtxoText, bobUtxoText, fundingFeeRate }) {
  const net = networkOf(networkId);
  if (!terms || !terms.address) refuse("no pact terms loaded");
  const rate = assertFeeRate(fundingFeeRate ?? terms.fundingFeeRate, "funding fee rate");
  const aUtxos = String(aliceUtxoText || "").split("\n").map((l) => parseUtxoLine(l, "alice")).filter(Boolean);
  const bUtxos = String(bobUtxoText || "").split("\n").map((l) => parseUtxoLine(l, "bob")).filter(Boolean);
  if (!aUtxos.length) refuse("alice has no UTXOs listed");
  if (!bUtxos.length) refuse("bob has no UTXOs listed");

  const fundingProgram = hexToBytes(terms.tweakedX);
  const aliceProg = decodeBech32m(terms.alicePayout, net.hrp).program;
  const bobProg = decodeBech32m(terms.bobPayout, net.hrp).program;

  const sumIn = (us) => us.reduce((n, u) => n + u.value, 0);
  const aIn = sumIn(aUtxos), bIn = sumIn(bUtxos);
  const nIn = aUtxos.length + bUtxos.length;

  // iterate: assume 3 outputs (funding + 2 change), drop change outputs that
  // would be dust, recompute until stable.
  let nOut = 3, fee = 0, changeA = 0, changeB = 0;
  for (let round = 0; round < 4; round++) {
    const vBytes = keypathTxVBytes(nIn, nOut);
    fee = Math.ceil(vBytes * rate);
    const feeA = Math.ceil(fee / 2), feeB = fee - feeA;
    changeA = aIn - terms.collateralAlice - feeA;
    changeB = bIn - terms.collateralBob - feeB;
    if (changeA < 0) refuse(`alice's UTXOs cover ${aIn} grains but she owes ${terms.collateralAlice} collateral + ~${feeA} fee share`);
    if (changeB < 0) refuse(`bob's UTXOs cover ${bIn} grains but he owes ${terms.collateralBob} collateral + ~${feeB} fee share`);
    let next = 1;
    if (changeA >= DUST_GRAIN) next++;
    if (changeB >= DUST_GRAIN) next++;
    if (next === nOut) break;
    nOut = next;
  }
  const absorbedA = changeA > 0 && changeA < DUST_GRAIN ? changeA : 0;
  const absorbedB = changeB > 0 && changeB < DUST_GRAIN ? changeB : 0;
  const vBytes = keypathTxVBytes(nIn, nOut);
  fee = Math.ceil(vBytes * rate) + absorbedA + absorbedB;

  const outputs = [{ program: fundingProgram, value: terms.totalCollateral, label: "pact funding (2-of-2)" }];
  if (changeA >= DUST_GRAIN) outputs.push({ program: aliceProg, value: changeA, label: `${terms.alice.name} change` });
  if (changeB >= DUST_GRAIN) outputs.push({ program: bobProg, value: changeB, label: `${terms.bob.name} change` });

  const inputs = [...aUtxos, ...bUtxos].map((u) => ({
    txid: u.txid, vout: u.vout, value: u.value, owner: u.owner, sequence: MAX_SEQ,
    spk: p2trScriptPubKey(u.owner === "alice" ? aliceProg : bobProg),
  }));
  const core = [...u32le(net.txVersion), ...varint(inputs.length)];
  for (const i of inputs) core.push(...txidLE(i.txid), ...u32le(i.vout), ...varint(0), ...u32le(MAX_SEQ));
  core.push(...varint(outputs.length));
  for (const o of outputs) {
    const s = p2trScriptPubKey(o.program);
    core.push(...u64le(o.value), ...varint(s.length), ...s);
  }
  core.push(...u32le(0));
  const baseBytes = Uint8Array.from(core);
  const txid = txidOf(baseBytes);
  return {
    networkId: net.id, txid, unsignedHex: bytesToHex(baseBytes),
    vBytes, feeGrains: fee, feeRate: rate,
    fundingValue: terms.totalCollateral, fundingVout: 0,
    inputs: inputs.map((i) => ({ txid: i.txid, vout: i.vout, value: i.value, owner: i.owner })),
    outputs: outputs.map((o) => ({ address: encodeBech32m(net.hrp, 1, o.program), value: o.value, label: o.label })),
    changeA: changeA >= DUST_GRAIN ? changeA : 0,
    changeB: changeB >= DUST_GRAIN ? changeB : 0,
    absorbedDust: absorbedA + absorbedB,
  };
}

/**
 * Sign the funding tx locally (both parties' keys present). Each input is a
 * keypath spend from its owner's own P2TR address.
 */
export function signFundingTx({ networkId = "mainnet", plan, terms, alicePrivHex, bobPrivHex }) {
  const net = networkOf(networkId);
  if (!plan || !plan.inputs) refuse("no funding plan to sign");
  const aliceProg = decodeBech32m(terms.alicePayout, net.hrp).program;
  const bobProg = decodeBech32m(terms.bobPayout, net.hrp).program;
  const keys = {
    alice: alicePrivHex ? hexToBytes(assertPrivHex(alicePrivHex, "alice private key")) : null,
    bob: bobPrivHex ? hexToBytes(assertPrivHex(bobPrivHex, "bob private key")) : null,
  };
  const internals = {
    alice: hexToBytes(assertXOnlyHex(terms.alice.xonly, "alice key")),
    bob: hexToBytes(assertXOnlyHex(terms.bob.xonly, "bob key")),
  };
  const inputs = plan.inputs.map((p) => ({
    txid: p.txid, vout: p.vout, value: p.value,
    spk: p2trScriptPubKey(p.owner === "alice" ? aliceProg : bobProg),
  }));
  const outputs = plan.outputs.map((o) => ({ program: decodeBech32m(o.address, net.hrp).program, value: o.value }));
  const sigs = inputs.map((inp, idx) => {
    const owner = plan.inputs[idx].owner;
    const priv = keys[owner];
    if (!priv) refuse(`${owner} has no local private key — sign that input in their own wallet`);
    const digest = keypathSigDigestEx(net, inputs, outputs, MAX_SEQ, idx, 0x00);
    const tweaked = tweakPrivKeypathCompat(priv, internals[owner]);
    return schnorr.sign(digest, tweaked, randomBytes(32));
  });
  // wire: version, marker, flag, vin, vout, locktime, then per-input 1-item witness
  const out = [...u32le(net.txVersion), 0x00, 0x01, ...varint(inputs.length)];
  for (const i of inputs) out.push(...txidLE(i.txid), ...u32le(i.vout), ...varint(0), ...u32le(MAX_SEQ));
  out.push(...varint(outputs.length));
  for (const o of outputs) {
    const s = p2trScriptPubKey(o.program);
    out.push(...u64le(o.value), ...varint(s.length), ...s);
  }
  for (const s of sigs) out.push(...varint(1), ...varint(s.length), ...s);
  out.push(...u32le(0));
  const full = Uint8Array.from(out);
  // re-verify every signature against its digest before returning
  inputs.forEach((inp, idx) => {
    const owner = plan.inputs[idx].owner;
    const digest = keypathSigDigestEx(net, inputs, outputs, MAX_SEQ, idx, 0x00);
    const tweakedPub = tweakKeypath(internals[owner]).tweakedX;
    if (!verifySchnorrSig(sigs[idx], digest, tweakedPub)) refuse(`funding signature ${idx} failed re-verification`);
  });
  return { hex: bytesToHex(full), txid: plan.txid, vBytes: plan.vBytes, feeGrains: plan.feeGrains };
}

/** tweakPrivKeypath without importing the non-exported helper: mirror the audited math. */
function tweakPrivKeypathCompat(priv, internalXOnly) {
  let d = bytesToNumberBE(priv);
  const P = secp256k1.ProjectivePoint.fromPrivateKey(numberToBytesBE(d, 32));
  if (P.toRawBytes(true)[0] === 0x03) d = N - d;
  const t = bytesToNumberBE(taggedHash("TapTweak", internalXOnly));
  return numberToBytesBE((d + t) % N, 32);
}

/* ================= Contract Execution Transactions ================= */

function cetInput(terms, fundingTxid, fundingVout, sequence = MAX_SEQ) {
  return {
    txid: fundingTxid, vout: fundingVout, value: terms.totalCollateral,
    program: hexToBytes(terms.tweakedX), sequence,
  };
}

/**
 * Build every CET: spends the funding output via the 2-of-2 script path,
 * pays each party its outcome share. Returns digests + unsigned base hex +
 * txids (txids are signature-independent, so they are final already).
 */
export function buildCets({ networkId = "mainnet", terms, fundingTxid, fundingVout = 0 }) {
  const net = networkOf(networkId);
  if (!terms || !terms.script) refuse("no pact terms loaded");
  const ftx = String(fundingTxid || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(ftx)) refuse("funding txid must be 64 hex characters");
  if (!Number.isInteger(fundingVout) || fundingVout < 0) refuse("funding vout out of range");
  const script = hexToBytes(terms.script);
  const controlBlock = hexToBytes(terms.controlBlock);
  const aliceProg = decodeBech32m(terms.alicePayout, net.hrp).program;
  const bobProg = decodeBech32m(terms.bobPayout, net.hrp).program;
  const cets = terms.outcomes.map((o, index) => {
    const inputs = [cetInput(terms, ftx, fundingVout)];
    const outputs = [
      { program: aliceProg, value: o.aliceGrains },
      { program: bobProg, value: o.bobGrains },
    ];
    const digest = bytesToHex(scriptPathSigDigestMulti(net, inputs, outputs, script, 0, MAX_SEQ));
    const base = serializeScriptPathTx(net, inputs, outputs, { locktime: 0, witnesses: null });
    return {
      index, label: o.label,
      aliceGrains: o.aliceGrains, bobGrains: o.bobGrains,
      feeGrains: terms.cetFeeGrains, vBytes: terms.cetVBytes,
      digest, unsignedBaseHex: bytesToHex(base), txid: txidOf(base),
      oraclePointX: terms.oracle.commits[index],
    };
  });
  return {
    networkId: net.id, fundingTxid: ftx, fundingVout,
    script: terms.script, controlBlock: terms.controlBlock,
    cets,
  };
}

/**
 * The sealing ceremony: each party adaptor-encrypts their signature on every
 * CET to that outcome's oracle announcement point. Returns the sealed bundle.
 */
export function sealPact({ networkId = "mainnet", terms, cets, alicePrivHex, bobPrivHex }) {
  const net = networkOf(networkId);
  if (!cets || !cets.cets || !cets.cets.length) refuse("no CETs built");
  const aPriv = assertPrivHex(alicePrivHex, "alice private key");
  const bPriv = assertPrivHex(bobPrivHex, "bob private key");
  // sanity: privkeys must match the pact's party keys
  const aX = bytesToHex(xOnlyOf(secp256k1.ProjectivePoint.fromPrivateKey(hexToBytes(aPriv))));
  const bX = bytesToHex(xOnlyOf(secp256k1.ProjectivePoint.fromPrivateKey(hexToBytes(bPriv))));
  const parties = new Set([terms.alice.xonly, terms.bob.xonly]);
  if (!parties.has(aX) || !parties.has(bX) || aX === bX) refuse("signing keys do not match the pact's two party keys");
  const outcomes = cets.cets.map((c) => {
    const T = c.oraclePointX;
    const alice = adaptorEncrypt(aPriv, c.digest, T);
    const bob = adaptorEncrypt(bPriv, c.digest, T);
    // verify immediately — an encryption that doesn't verify is refused, loudly
    const aPub = terms.alice.xonly, bPub = terms.bob.xonly;
    if (!adaptorVerify(alice.RprimeX, alice.sStar, aPub, c.digest, T)) refuse(`alice adaptor signature failed self-verification (outcome "${c.label}")`);
    if (!adaptorVerify(bob.RprimeX, bob.sStar, bPub, c.digest, T)) refuse(`bob adaptor signature failed self-verification (outcome "${c.label}")`);
    return { index: c.index, label: c.label, digest: c.digest, txid: c.txid, alice, bob };
  });
  const bundle = {
    kind: SEALED_KIND,
    descriptor: terms.descriptor,
    fundingTxid: cets.fundingTxid,
    fundingVout: cets.fundingVout,
    outcomes,
  };
  bundle.fingerprint = bytesToHex(sha256(utf8(JSON.stringify(bundle)))).slice(0, 16);
  return bundle;
}

/** Re-verify a sealed bundle against terms: digests, adaptor sigs, descriptor. */
export function verifySealedPact({ networkId = "mainnet", terms, sealed }) {
  const failures = [];
  try {
    if (!sealed || sealed.kind !== SEALED_KIND) refuse("not a pearl-pact sealed bundle");
    if (sealed.descriptor !== terms.descriptor) failures.push("sealed bundle descriptor does not match the loaded pact terms");
    const rebuilt = buildCets({ networkId, terms, fundingTxid: sealed.fundingTxid, fundingVout: sealed.fundingVout });
    if (rebuilt.cets.length !== sealed.outcomes.length) failures.push("outcome count mismatch");
    for (const s of sealed.outcomes) {
      const c = rebuilt.cets[s.index];
      if (!c) { failures.push(`unknown outcome index ${s.index}`); continue; }
      if (c.digest !== s.digest || c.txid !== s.txid) {
        failures.push(`outcome "${s.label}": digest/txid do not recompute — CET was altered`);
        continue;
      }
      const T = terms.oracle.commits[s.index];
      if (!adaptorVerify(s.alice.RprimeX, s.alice.sStar, terms.alice.xonly, s.digest, T)) {
        failures.push(`outcome "${s.label}": alice's encrypted signature does not verify`);
      }
      if (!adaptorVerify(s.bob.RprimeX, s.bob.sStar, terms.bob.xonly, s.digest, T)) {
        failures.push(`outcome "${s.label}": bob's encrypted signature does not verify`);
      }
    }
  } catch (e) {
    failures.push(String(e.message || e).replace(/^PACT REFUSED: /, ""));
  }
  return { ok: failures.length === 0, failures };
}

export function exportSealed(sealed) { return JSON.stringify(sealed, null, 2); }
export function importSealed(text) {
  let o;
  try { o = JSON.parse(String(text)); } catch { refuse("sealed bundle is not valid JSON"); }
  if (!o || o.kind !== SEALED_KIND) refuse("not a pearl-pact sealed bundle");
  return o;
}

/* ================= refund (insurance leg) ================= */

/**
 * Build the timelocked refund: returns each party's collateral minus half the
 * fee. nLockTime = refundLockHeight, input sequence 0xfffffffe.
 */
export function buildRefundTx({ networkId = "mainnet", terms, fundingTxid, fundingVout = 0 }) {
  const net = networkOf(networkId);
  if (!terms || !terms.script) refuse("no pact terms loaded");
  const ftx = String(fundingTxid || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(ftx)) refuse("funding txid must be 64 hex characters");
  const script = hexToBytes(terms.script);
  const vBytes = scriptPathVBytes(1, 2, script.length, 2, 2);
  const fee = Math.ceil(vBytes * terms.refundFeeRate);
  const feeA = Math.floor(fee / 2), feeB = fee - feeA;
  const aVal = terms.collateralAlice - feeA, bVal = terms.collateralBob - feeB;
  if (aVal < DUST_GRAIN || bVal < DUST_GRAIN) refuse("collateral cannot cover the refund fee plus dust floors");
  const aliceProg = decodeBech32m(terms.alicePayout, net.hrp).program;
  const bobProg = decodeBech32m(terms.bobPayout, net.hrp).program;
  const inputs = [cetInput(terms, ftx, fundingVout, REFUND_SEQ)];
  const outputs = [
    { program: aliceProg, value: aVal },
    { program: bobProg, value: bVal },
  ];
  const digest = bytesToHex(scriptPathSigDigestMulti(net, inputs, outputs, script, 0, REFUND_SEQ));
  const base = serializeScriptPathTx(net, inputs, outputs, { locktime: terms.refundLockHeight, witnesses: null });
  return {
    networkId: net.id, fundingTxid: ftx, fundingVout,
    lockHeight: terms.refundLockHeight, sequence: REFUND_SEQ,
    aliceGrains: aVal, bobGrains: bVal, feeGrains: fee, vBytes,
    digest, unsignedBaseHex: bytesToHex(base), txid: txidOf(base),
  };
}

/** Both parties sign the refund digest with plain (non-adaptor) Schnorr sigs. */
export function signRefundTx({ networkId = "mainnet", terms, refund, alicePrivHex, bobPrivHex }) {
  const net = networkOf(networkId);
  const script = hexToBytes(terms.script);
  const controlBlock = hexToBytes(terms.controlBlock);
  const dg = hexToBytes(refund.digest);
  const sigFor = (privHex, xonlyHex, who) => {
    const d = evenYScalar(hexToBytes(assertPrivHex(privHex, `${who} private key`)));
    const P = secp256k1.ProjectivePoint.fromPrivateKey(numberToBytesBE(d, 32));
    if (bytesToHex(xOnlyOf(P)) !== xonlyHex.toLowerCase()) refuse(`${who}'s key does not match the pact party key`);
    return schnorr.sign(dg, numberToBytesBE(d, 32), randomBytes(32));
  };
  const sigA = sigFor(alicePrivHex, terms.alice.xonly, "alice");
  const sigB = sigFor(bobPrivHex, terms.bob.xonly, "bob");
  if (!verifySchnorrSig(sigA, dg, terms.alice.xonly)) refuse("alice refund signature failed re-verification");
  if (!verifySchnorrSig(sigB, dg, terms.bob.xonly)) refuse("bob refund signature failed re-verification");
  // witness: signatures in REVERSE key order (vault/audited convention)
  const order = terms.keyOrder; // [k1, k2] ascending
  const sigByKey = { [terms.alice.xonly]: sigA, [terms.bob.xonly]: sigB };
  const stack = [sigByKey[order[1]], sigByKey[order[0]]];
  const aliceProg = decodeBech32m(terms.alicePayout, net.hrp).program;
  const bobProg = decodeBech32m(terms.bobPayout, net.hrp).program;
  const inputs = [{
    txid: refund.fundingTxid, vout: refund.fundingVout, value: terms.totalCollateral,
    program: hexToBytes(terms.tweakedX), sequence: REFUND_SEQ,
  }];
  const outputs = [
    { program: aliceProg, value: refund.aliceGrains },
    { program: bobProg, value: refund.bobGrains },
  ];
  const full = serializeScriptPathTx(net, inputs, outputs, {
    locktime: refund.lockHeight, witnesses: [stack], script, controlBlock,
  });
  return { hex: bytesToHex(full), txid: refund.txid };
}

/* ================= execute: oracle attests, CET decrypts ================= */

/**
 * Execute the winning outcome: verify the sealed bundle, verify the oracle
 * attestation, decrypt both adaptor signatures with the revealed outcome
 * secret, re-verify the plain Schnorr signatures, and emit the final CET.
 */
export function executePact({ networkId = "mainnet", terms, sealed, attestation }) {
  const net = networkOf(networkId);
  const sv = verifySealedPact({ networkId, terms, sealed });
  if (!sv.ok) refuse("sealed bundle failed verification: " + sv.failures.join(" | "));
  const idx = attestation?.outcomeIndex;
  if (!Number.isInteger(idx) || idx < 0 || idx >= terms.outcomes.length) refuse("attestation outcome index out of range");
  const av = verifyAttestation({
    oraclePubXOnlyHex: terms.oracle.pubkey,
    eventId: terms.oracle.eventId,
    outcomeIndex: idx,
    tHex: attestation.tHex,
    sigHex: attestation.sigHex,
    committedPointXHex: terms.oracle.commits[idx],
  });
  if (!av.ok) refuse("oracle attestation failed: " + av.reasons.join(" | "));

  const s = sealed.outcomes[idx];
  const t = bytesToHex(hexToBytes(assertPrivHex(attestation.tHex, "outcome secret")));
  const sA = adaptorDecrypt(s.alice.sStar, t);
  const sB = adaptorDecrypt(s.bob.sStar, t);
  const dg = hexToBytes(s.digest);
  // the decrypted (R'x, s) pairs must verify as plain BIP-340 signatures
  const sigBytesA = concat(hexToBytes(s.alice.RprimeX), hexToBytes(sA));
  const sigBytesB = concat(hexToBytes(s.bob.RprimeX), hexToBytes(sB));
  if (!verifySchnorrSig(sigBytesA, dg, terms.alice.xonly)) refuse("decrypted alice signature does not verify — aborting");
  if (!verifySchnorrSig(sigBytesB, dg, terms.bob.xonly)) refuse("decrypted bob signature does not verify — aborting");
  // BIP-340 full verification as a second, independent check
  let okA = false, okB = false;
  try {
    okA = schnorr.verify(sigBytesA, dg, hexToBytes(terms.alice.xonly));
    okB = schnorr.verify(sigBytesB, dg, hexToBytes(terms.bob.xonly));
  } catch { /* leave false */ }
  if (!okA || !okB) refuse("independent BIP-340 verification of the decrypted CET signatures failed");

  const script = hexToBytes(terms.script);
  const controlBlock = hexToBytes(terms.controlBlock);
  const order = terms.keyOrder;
  const sigByKey = { [terms.alice.xonly]: sigBytesA, [terms.bob.xonly]: sigBytesB };
  const stack = [sigByKey[order[1]], sigByKey[order[0]]]; // reverse key order
  const aliceProg = decodeBech32m(terms.alicePayout, net.hrp).program;
  const bobProg = decodeBech32m(terms.bobPayout, net.hrp).program;
  const c = terms.outcomes[idx];
  const inputs = [cetInput(terms, sealed.fundingTxid, sealed.fundingVout)];
  const outputs = [
    { program: aliceProg, value: c.aliceGrains },
    { program: bobProg, value: c.bobGrains },
  ];
  const full = serializeScriptPathTx(net, inputs, outputs, { locktime: 0, witnesses: [stack], script, controlBlock });
  // final self-check: re-derive the digest from the serialized tx and confirm
  const checkDigest = bytesToHex(scriptPathSigDigestMulti(net, inputs, outputs, script, 0, MAX_SEQ));
  if (checkDigest !== s.digest) refuse("final CET digest mismatch — serialization diverged from the sealed plan");
  return {
    hex: bytesToHex(full),
    txid: s.txid,
    outcomeIndex: idx,
    label: c.label,
    aliceGrains: c.aliceGrains,
    bobGrains: c.bobGrains,
    attestationVerified: true,
  };
}

/* ================= guided demo ================= */

/**
 * Mint a complete demo pact (fresh local keys for both parties + oracle).
 * Everything is real cryptography; the keys are throwaway and labeled DEMO.
 */
export function mintDemoPact(networkId = "mainnet") {
  const oracle = mintOracleKey();
  const alice = mintOracleKey(); // any fresh keypair works as a party key
  const bob = mintOracleKey();
  const eventId = "demo/pact-" + bytesToHex(randomBytes(4));
  // CET fee is deterministic from the script shape — compute it up front so
  // the payout rows sum exactly to collateral − fee.
  const { script } = buildFundingScript(alice.pubXOnlyHex, bob.pubXOnlyHex);
  const cetFeeGrains = Math.ceil(scriptPathVBytes(1, 2, script.length, 2, 2) * 5);
  const distributable = 200_000_000 - cetFeeGrains;
  const commits = oracleAnnouncements(oracle.privHex, eventId, 2).map((a) => a.pointXHex);
  const terms = buildPactTerms({
    networkId,
    title: "Demo pact — oracle coin flip",
    aliceName: "Alice (demo)", aliceKey: alice.privHex, aliceKind: "priv",
    bobName: "Bob (demo)", bobKey: bob.privHex, bobKind: "priv",
    oracleName: "Demo Oracle", oraclePubkey: oracle.pubXOnlyHex,
    eventId, oracleCommits: commits,
    outcomes: [
      { label: "heads — Alice wins", aliceGrains: distributable - DUST_GRAIN, bobGrains: DUST_GRAIN },
      { label: "tails — Bob wins", aliceGrains: DUST_GRAIN, bobGrains: distributable - DUST_GRAIN },
    ],
    collateralAlice: 100_000_000, collateralBob: 100_000_000, // 1 PRL each
    fundingFeeRate: 5, cetFeeRate: 5, refundFeeRate: 5,
    refundLockHeight: 950000,
  });
  if (terms.cetFeeGrains !== cetFeeGrains) refuse("demo fee math diverged (unreachable)");
  return {
    terms,
    keys: { alicePriv: alice.privHex, bobPriv: bob.privHex, oraclePriv: oracle.privHex, oraclePub: oracle.pubXOnlyHex },
    eventId,
    note: "DEMO keys — never fund with real PRL",
  };
}

export const ATTRIBUTION = { x: X_HANDLE, donation: DONATION_ADDRESS };
export function grainsToPRL(g) { return (Number(g) / GRAIN_PER_PRL).toFixed(8).replace(/\.?0+$/, ""); }
export function prlToGrains(s) {
  const t = String(s || "").trim();
  if (!/^\d+(\.\d{1,8})?$/.test(t)) refuse(`"${s}" is not a PRL amount`);
  const [w, f = ""] = t.split(".");
  const grains = BigInt(w) * BigInt(GRAIN_PER_PRL) + BigInt((f + "00000000").slice(0, 8));
  // Number(grains) is exact only up to MAX_SAFE_INTEGER: refuse the
  // inexact band instead of silently dropping grains (100000000.00000001
  // PRL came back as 10000000000000000 grains, −1). Fleet standard.
  if (grains > BigInt(Number.MAX_SAFE_INTEGER)) refuse(`"${s}" is out of range`);
  return Number(grains);
}
