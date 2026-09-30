// Pearl ID — Sign-in with Pearl (core logic).
//
// Pearl has no accounts, usernames, or OAuth. Your BIP-86 key IS your
// account: the prl1… address derived from it is the username, and a
// BIP-340 Schnorr signature over a relying party's challenge is the
// login — one that can't be phished into a password database, because
// every challenge is bound to a single domain and expires.
//
// Ceremony:
//   1. Relying party (any site/app) shows the user a domain + challenge.
//      The challenge MUST be >= 128-bit random, single-use, short-lived.
//   2. The user signs (domain, address, xonly, challenge, issued_at,
//      expires_at) with the TWEAKED keypath private key — the same key
//      that controls the identity's prl1… address.
//   3. The relying party verifies: recompute canonical bytes -> id,
//      BIP-340 verify against xonly, address recomputed from xonly
//      equals the claimed address, domain matches, not expired.
//
// NO new cryptography is introduced here: every primitive (sha256,
// schnorr, BIP-86 derivation, BIP-341 keypath tweak, bech32m) is
// imported from the audited ../../sign/src/crypto.js.
//
// Honest limits (enforced by design, surfaced in the UI):
//  - A signature proves CONTROL OF A KEY — not a real-world identity,
//    not trustworthiness, not humanity.
//  - A credential is replayable by anyone who sees it until it expires.
//    Single-use challenges + short expiries are the RELYING PARTY's job;
//    the math cannot enforce them. Default demo expiry is 5 minutes.
//  - The page never moves PRL, never broadcasts, never leaves the browser.
//  - Keys live in page memory only. Wipe on shared machines.
import {
  NETWORKS,
  sha256, bytesToHex, hexToBytes, schnorr,
  newMnemonic,
  walletFromMnemonic, walletFromWIF, walletFromPriv, walletToWIF,
  tweakPrivKeypath, tweakKeypath, encodeBech32m, decodeBech32m,
} from "../../sign/src/crypto.js";

export {
  NETWORKS,
  sha256, bytesToHex, hexToBytes, schnorr,
  newMnemonic,
  walletFromMnemonic, walletFromWIF, walletFromPriv, walletToWIF,
  tweakPrivKeypath, tweakKeypath, encodeBech32m, decodeBech32m,
};

/* ---------------- protocol constants ---------------- */

/** Protocol tag embedded in every credential. */
export const ID_PROTOCOL = "prl-id";
/** Credential format version. */
export const ID_VERSION = 1;
/** Fields covered by the signature, in canonical order. */
export const SIGNED_KEYS = ["protocol", "version", "domain", "address", "xonly", "challenge", "issued_at", "expires_at"];
/** Full envelope keys (signed fields + id + fingerprint + sig). */
export const ENVELOPE_KEYS = [...SIGNED_KEYS, "id", "fingerprint", "sig"];
/** Minimum challenge size: 128 bits (32 hex chars). 256-bit preferred. */
export const CHALLENGE_MIN_HEX = 32;
/** Maximum credential lifetime: 7 days. Longer -> INVALID. */
export const MAX_LIFETIME_S = 7 * 24 * 3600;
/** issued_at more than this far in the future -> INVALID (clock nonsense). */
export const ISSUED_FUTURE_TOLERANCE_S = 24 * 3600;
/** issued_at more than this far in the future -> VALID-WARN (clock skew). */
export const ISSUED_SKEW_WARN_S = 300;

/* ---------------- key identity ---------------- */

/** Identity pubkey: the TWEAKED keypath x-only pubkey — the same key
 *  that controls the identity's prl1… address. */
export function idPubkeyHex(internalXOnly) {
  const x = internalXOnly instanceof Uint8Array ? internalXOnly : hexToBytes(internalXOnly);
  if (x.length !== 32) throw new Error("internalXOnly must be 32 bytes");
  return bytesToHex(tweakKeypath(x).tweakedX);
}

/** Tweaked keypath private key used to sign credentials. */
export function idSigningKey(priv, internalXOnly) {
  const p = priv instanceof Uint8Array ? priv : hexToBytes(priv);
  return tweakPrivKeypath(p, internalXOnly);
}

/** Auto-detect a secret: 64-hex private key, WIF, or 12/24-word
 *  mnemonic (same detection order as the Sign desk). */
export function idKeyFromInput(input, network = NETWORKS.mainnet) {
  const t = String(input || "").trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) {
    return { ...walletFromPriv(hexToBytes(t.toLowerCase()), network), source: "hex private key" };
  }
  if (/^[1-9A-HJ-NP-Za-km-z]{30,60}$/.test(t)) {
    try { return { ...walletFromWIF(t, network), source: "WIF" }; } catch { /* fall through */ }
  }
  const words = t.split(/\s+/);
  if (words.length === 12 || words.length === 24) {
    return { ...walletFromMnemonic(t, network), source: "mnemonic (BIP-86 m/86'/coin'/0'/0/0)" };
  }
  throw new Error("identity key must be a 32-byte hex private key, WIF, or a 12/24-word mnemonic");
}

/** Recompute the prl1…/tprl1… address for a tweaked x-only pubkey. */
export function addressFromXonly(xonlyHex, network = NETWORKS.mainnet) {
  const x = xonlyHex instanceof Uint8Array ? xonlyHex : hexToBytes(String(xonlyHex).toLowerCase());
  if (x.length !== 32) throw new Error("xonly must be 32 bytes");
  return encodeBech32m(network.hrp, 1, x);
}

/* ---------------- field validation ---------------- */

const INT_STR = /^(0|[1-9][0-9]*)$/; // canonical integer string: no floats, no leading zeros
const HEX64 = /^[0-9a-f]{64}$/;
const HEX32OR64 = /^([0-9a-f]{32}|[0-9a-f]{64})$/;
const DOMAIN_RE = /^(?!-)[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})*$/; // hostname-ish, lowercase

function normHex(v) { return String(v || "").trim().toLowerCase(); }

/** Validate the unsigned (signable) fields; returns { ok, errors, norm }.
 *  norm holds the canonical values used for signing. */
export function validateUnsignedFields(f) {
  const errors = [];
  const norm = {};
  const g = (k) => (f && f[k] !== undefined && f[k] !== null ? String(f[k]) : "");

  // domain
  const domain = g("domain").trim().toLowerCase();
  if (!domain) errors.push("domain is required");
  else if (domain.length > 253) errors.push("domain too long (max 253 chars)");
  else if (!DOMAIN_RE.test(domain) || domain.includes("..")) errors.push("domain must be a valid hostname (lowercase letters, digits, dots, hyphens)");
  norm.domain = domain;

  // address: must be a decodable bech32m v1 prl1…/tprl1… address
  const address = g("address").trim();
  let addrNet = null;
  if (!address) errors.push("address is required");
  else {
    const hrp = address.startsWith("tprl1") ? "tprl" : address.startsWith("prl1") ? "prl" : null;
    if (!hrp) errors.push("address must start with prl1 or tprl1");
    else {
      try {
        const d = decodeBech32m(address, hrp);
        if (d.version !== 1) errors.push("address must be a witness-v1 (Taproot) address");
        else if (d.program.length !== 32) errors.push("address program must be 32 bytes (P2TR)");
        else addrNet = hrp === "prl" ? NETWORKS.mainnet : NETWORKS.testnet;
      } catch (e) {
        errors.push("address is not valid bech32m: " + String(e.message || e).slice(0, 80));
      }
    }
  }
  norm.address = address;
  norm._network = addrNet;

  // xonly
  const xonly = normHex(g("xonly"));
  if (!HEX64.test(xonly)) errors.push("xonly must be 64 lowercase hex chars");
  norm.xonly = xonly;

  // challenge: 128–256 bits
  const challenge = normHex(g("challenge"));
  if (!HEX32OR64.test(challenge)) errors.push("challenge must be 32 or 64 lowercase hex chars (128–256 bits of randomness)");
  norm.challenge = challenge;

  // timestamps: canonical integer strings
  for (const k of ["issued_at", "expires_at"]) {
    const v = g(k).trim();
    if (!INT_STR.test(v)) errors.push(k + " must be a canonical unix-timestamp integer string");
    else if (v.length > 12) errors.push(k + " is absurdly far in the future");
    norm[k] = v;
  }
  if (INT_STR.test(norm.issued_at) && INT_STR.test(norm.expires_at)) {
    const i = BigInt(norm.issued_at), e = BigInt(norm.expires_at);
    if (e <= i) errors.push("expires_at must be strictly after issued_at");
    if (e - i > BigInt(MAX_LIFETIME_S)) errors.push("credential lifetime exceeds 7 days (relying parties should use minutes, not days)");
  }
  return { ok: errors.length === 0, errors, norm };
}

/** Canonical bytes: JSON of the signed fields in fixed order, no whitespace. */
export function canonicalCredential(norm) {
  const o = {};
  for (const k of SIGNED_KEYS) o[k] = k === "version" ? ID_VERSION : k === "protocol" ? ID_PROTOCOL : norm[k];
  return JSON.stringify(o);
}

/** Credential id: SHA-256 of the canonical bytes (this is what gets signed). */
export function credentialId(canonical) {
  return bytesToHex(sha256(new TextEncoder().encode(canonical)));
}

/** 64-bit tamper-evident fingerprint: first 16 hex chars of SHA-256(canonical). */
export function fingerprintOf(canonical) {
  return bytesToHex(sha256(new TextEncoder().encode("prl-id-fingerprint:" + canonical))).slice(0, 16);
}

/** Fresh 256-bit challenge hex (crypto.getRandomValues). */
export function newChallengeHex() {
  const c = globalThis.crypto;
  if (!c || typeof c.getRandomValues !== "function") {
    throw new Error("no secure randomness available in this environment");
  }
  return bytesToHex(c.getRandomValues(new Uint8Array(32)));
}

/* ---------------- signing ---------------- */

/** Sign a login credential. fields: { domain, address, xonly, challenge,
 *  issued_at, expires_at }. priv/internalXOnly: the identity key.
 *  Loudly refuses when the key does not match the claimed address/xonly.
 *  Returns the shareable envelope. */
export function signCredential({ fields, priv, internalXOnly, auxRand = undefined }) {
  const fv = validateUnsignedFields(fields);
  if (!fv.ok) throw new Error("credential fields invalid: " + fv.errors.join("; "));
  const norm = fv.norm;
  const privB = priv instanceof Uint8Array ? priv : hexToBytes(priv);
  const xB = internalXOnly instanceof Uint8Array ? internalXOnly : hexToBytes(internalXOnly);
  if (privB.length !== 32 || xB.length !== 32) throw new Error("priv and internalXOnly must be 32 bytes");

  // The key must actually be the claimed identity — no signing for strangers.
  const derivedXonly = idPubkeyHex(xB);
  if (derivedXonly !== norm.xonly) {
    throw new Error("LOUD REFUSAL: this key's tweaked pubkey does not match the claimed xonly — the key does not control this identity. Credential NOT signed.");
  }
  const derivedAddr = addressFromXonly(derivedXonly, norm._network || NETWORKS.mainnet);
  if (derivedAddr !== norm.address) {
    throw new Error("LOUD REFUSAL: this key's address does not match the claimed address. Credential NOT signed.");
  }

  const canonical = canonicalCredential({ ...norm, protocol: ID_PROTOCOL, version: ID_VERSION });
  const id = credentialId(canonical);
  const tweakedPriv = idSigningKey(privB, xB);
  const sig = schnorr.sign(hexToBytes(id), tweakedPriv, ...(auxRand === undefined ? [] : [auxRand]));
  // Self-verify (loud wrong-key refusal).
  if (!schnorr.verify(sig, hexToBytes(id), hexToBytes(derivedXonly))) {
    throw new Error("LOUD REFUSAL: the credential signature does not verify against the identity key. Credential NOT signed.");
  }
  return {
    protocol: ID_PROTOCOL, version: ID_VERSION,
    domain: norm.domain, address: norm.address, xonly: norm.xonly,
    challenge: norm.challenge, issued_at: norm.issued_at, expires_at: norm.expires_at,
    id, fingerprint: fingerprintOf(canonical), sig: bytesToHex(sig),
  };
}

/** Pretty shareable text of an envelope. */
export function credentialJSON(env) {
  return JSON.stringify(env, null, 2);
}

/* ---------------- standalone verification ---------------- */

/** Verify a credential envelope. opts: { expectedDomain, nowSec }.
 *  Returns { verdict: "VALID"|"VALID-WARN"|"INVALID", id, credential, checks }.
 *  checks: [{ name, status: "pass"|"warn"|"fail", detail }]. */
export function verifyCredential(raw, opts = {}) {
  const checks = [];
  const row = (name, status, detail) => checks.push({ name, status, detail });
  const nowSec = Number.isFinite(opts.nowSec) ? Math.floor(opts.nowSec) : Math.floor(Date.now() / 1000);
  const fail = (name, detail) => { row(name, "fail", detail); };

  let c;
  try {
    c = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (e) {
    fail("JSON parses", "not valid JSON: " + String(e.message || e).slice(0, 120));
    return { verdict: "INVALID", id: null, credential: null, checks };
  }
  if (!c || typeof c !== "object" || Array.isArray(c)) {
    fail("envelope is an object", "must be a JSON object");
    return { verdict: "INVALID", id: null, credential: null, checks };
  }
  row("JSON parses", "pass", "envelope is a JSON object");

  const unknown = Object.keys(c).filter((k) => !ENVELOPE_KEYS.includes(k));
  if (unknown.length) fail("no unknown fields", "rejected unknown field(s): " + unknown.join(", "));
  else row("no unknown fields", "pass", "exactly the 11 protocol fields");
  const missing = ENVELOPE_KEYS.filter((k) => !(k in c));
  if (missing.length) fail("all fields present", "missing: " + missing.join(", "));
  else row("all fields present", "pass", ENVELOPE_KEYS.join(", "));

  if (c.protocol !== ID_PROTOCOL) fail("protocol tag", "expected " + JSON.stringify(ID_PROTOCOL));
  else row("protocol tag", "pass", JSON.stringify(ID_PROTOCOL));
  if (c.version !== ID_VERSION) fail("version", "expected " + ID_VERSION + ", credential says " + JSON.stringify(c.version));
  else row("version", "pass", "v" + ID_VERSION);

  const fv = validateUnsignedFields(c);
  if (fv.ok) row("canonical field rules", "pass", "domain, address, xonly, challenge, timestamps all well-formed");
  else for (const e of fv.errors) fail("canonical field rules", e);
  const norm = fv.norm;

  let canonical = null, id = null;
  if (fv.ok) {
    canonical = canonicalCredential({ ...norm, protocol: ID_PROTOCOL, version: ID_VERSION });
    id = credentialId(canonical);
    if (c.id !== id) fail("id matches canonical bytes", "recomputed " + String(id).slice(0, 16) + "… ≠ claimed " + String(c.id).slice(0, 16) + "…");
    else row("id matches canonical bytes", "pass", "SHA-256(canonical) = " + id.slice(0, 16) + "…");
    const fp = fingerprintOf(canonical);
    if (c.fingerprint !== fp) fail("fingerprint matches", "tamper-evident fingerprint mismatch");
    else row("fingerprint matches", "pass", "64-bit fingerprint " + fp);
  }

  // xonly must be a real curve point
  let pubBytes = null;
  if (HEX64.test(norm.xonly || "")) {
    try { schnorr.utils.lift_x(BigInt("0x" + norm.xonly)); pubBytes = hexToBytes(norm.xonly); row("xonly is a valid key", "pass", "lifts to a curve point"); }
    catch { fail("xonly is a valid key", "not on the secp256k1 curve"); }
  }

  // address MUST be the Taproot address of xonly — this binds "username" to key
  if (pubBytes && norm._network) {
    const recomputed = addressFromXonly(norm.xonly, norm._network);
    if (recomputed !== norm.address) fail("address belongs to xonly", "address is not the Taproot address of this key");
    else row("address belongs to xonly", "pass", "address recomputed from the key — the username IS the key");
  }

  // signature over the id
  const sigHex = normHex(c.sig);
  if (!/^[0-9a-f]{128}$/.test(sigHex)) fail("signature is well-formed", "must be 128 lowercase hex chars (64-byte BIP-340)");
  else if (pubBytes && id) {
    let ok = false;
    try { ok = schnorr.verify(hexToBytes(sigHex), hexToBytes(id), pubBytes); } catch { ok = false; }
    if (!ok) fail("BIP-340 signature verifies", "signature does not verify against xonly");
    else row("BIP-340 signature verifies", "pass", "signed by the tweaked keypath key that controls " + (norm.address || "the address"));
  } else {
    row("BIP-340 signature verifies", "warn", "skipped — earlier checks failed");
  }

  // domain binding
  const expected = opts.expectedDomain ? String(opts.expectedDomain).trim().toLowerCase() : "";
  if (expected) {
    if (norm.domain !== expected) fail("domain matches", "credential is for " + (norm.domain || "?") + ", expected " + expected);
    else row("domain matches", "pass", "bound to " + expected);
  } else if (norm.domain) {
    row("domain binding", "warn", "credential names " + norm.domain + " — no expected domain supplied, so this check was not enforced");
  }

  // freshness
  if (INT_STR.test(norm.issued_at || "") && INT_STR.test(norm.expires_at || "")) {
    const i = Number(norm.issued_at), e = Number(norm.expires_at);
    if (i > nowSec + ISSUED_FUTURE_TOLERANCE_S) fail("issued_at sane", "issued more than 24h in the future — clock nonsense");
    else if (i > nowSec + ISSUED_SKEW_WARN_S) row("issued_at sane", "warn", "issued " + Math.round((i - nowSec) / 60) + " min in the future (clock skew?)");
    else row("issued_at sane", "pass", "not from the future");
    if (!(e > i)) fail("expiry after issue", "expires_at must be after issued_at");
    else row("expiry after issue", "pass", "lifetime " + Math.round((e - i) / 60) + " min");
    if (nowSec >= e) fail("not expired", "expired " + Math.round((nowSec - e) / 60) + " min ago — credentials are replayable until expiry, then dead");
    else row("not expired", "pass", "valid for another " + Math.round((e - nowSec) / 60) + " min");
    if (e - i > 24 * 3600) row("short lifetime", "warn", "lifetime over 24h — relying parties should prefer minutes; a leaked credential replays until expiry");
  }

  const fails = checks.filter((x) => x.status === "fail").length;
  const warns = checks.filter((x) => x.status === "warn").length;
  const verdict = fails ? "INVALID" : warns ? "VALID-WARN" : "VALID";
  return { verdict, id, credential: c, checks };
}
