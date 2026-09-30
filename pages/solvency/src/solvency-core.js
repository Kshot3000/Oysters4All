// Pearl Solvency — proof-of-reserves desk for PRL custodians.
//
// A custodian declares liabilities and a list of prl1p…/tprl1… addresses, then
// proves control of every address by signing a canonical challenge with the
// matching private key (BIP-340 Schnorr over a tagged hash — the same audited
// primitive the Pearl Sign core uses for transaction signatures; no new
// cryptography). A verifier re-checks every signature, fetches confirmed UTXOs
// per address from Blockbook (GET-only), byte-compares each funding output
// script against the address scriptPubKey (foreign-script UTXOs are excluded,
// never trusted), sums the grains with BigInt, and compares against the
// declared liabilities.
//
// Honest limits (shown on the page, always): this proves ASSETS, not
// liabilities — liabilities are self-declared by the custodian. A custodian
// can borrow funds to fake a snapshot. The proof is a point-in-time
// statement, not an audit.

import {
  NETWORKS,
  GRAIN_PER_PRL,
  DUST_GRAIN,
  decodeBech32m,
  encodeBech32m,
  bytesToHex,
  hexToBytes,
  sha256,
  schnorr,
  taggedHash,
  tweakKeypath,
  tweakPrivKeypath,
  walletFromMnemonic,
  walletFromWIF,
  walletFromPriv,
  p2trScriptPubKey,
} from "../../sign/src/crypto.js";
import { signForXOnly, verifySchnorrSig } from "../../escrow/src/escrow-core.js";

export const SOLVENCY_TAG = "PearlSolvency/v1";
export const BUNDLE_VERSION = "pearl-solvency:v1";
export const UNSIGNED_VERSION = "pearl-solvency-unsigned:v1";
export const MAX_ADDRESSES = 250;
export { NETWORKS, GRAIN_PER_PRL, DUST_GRAIN };

/* ---------------- canonical JSON + fingerprints ---------------- */

/** Deterministic JSON: object keys sorted recursively, no whitespace. */
export function canonicalJson(v) {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  if (typeof v === "object") {
    return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson(v[k])).join(",") + "}";
  }
  return JSON.stringify(v);
}

/** 64-bit fingerprint: first 16 hex chars of SHA-256 over the canonical JSON. */
export function fingerprintOf(obj) {
  return bytesToHex(sha256(new TextEncoder().encode(canonicalJson(obj)))).slice(0, 16);
}

/* ---------------- PRL <-> grains ---------------- */

export function parsePRLtoGrains(s) {
  const t = String(s ?? "").trim();
  if (!/^\d+(\.\d{1,8})?$/.test(t)) throw new Error("amount must be a non-negative number with at most 8 decimals");
  const [whole, frac = ""] = t.split(".");
  return BigInt(whole) * 100_000_000n + BigInt((frac + "00000000").slice(0, 8));
}

export function fmtPRL(grains) {
  const g = typeof grains === "bigint" ? grains : BigInt(grains);
  const neg = g < 0n;
  const a = neg ? -g : g;
  const whole = a / 100_000_000n;
  const frac = (a % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return (neg ? "-" : "") + whole.toString() + (frac ? "." + frac : "");
}

/* ---------------- addresses ---------------- */

/** Decode a PRL P2TR address to its 32-byte program (throws on anything else). */
export function addressToProgram(addr, network) {
  const { hrp, version, program } = decodeBech32m(String(addr).trim());
  if (hrp !== network.hrp) throw new Error(`wrong network HRP (expected ${network.hrp}, got ${hrp})`);
  if (version !== 1 || program.length !== 32) throw new Error("solvency proves P2TR (v1, 32-byte) addresses only");
  return program;
}

/** Parse a pasted address list. Returns {addresses, errors}; dedupes, caps at MAX_ADDRESSES. */
export function parseAddressList(text, network) {
  const lines = String(text ?? "").split(/[\s,;\n]+/).map((s) => s.trim()).filter(Boolean);
  const seen = new Set();
  const addresses = [];
  const errors = [];
  for (const line of lines) {
    if (addresses.length >= MAX_ADDRESSES) {
      errors.push(`address cap reached (${MAX_ADDRESSES}) — remaining lines ignored`);
      break;
    }
    const key = line.toLowerCase();
    if (seen.has(key)) continue; // silent dedupe
    try {
      addressToProgram(line, network);
      seen.add(key);
      addresses.push(line);
    } catch (e) {
      errors.push(`${line.slice(0, 24)}…: ${e.message}`);
    }
  }
  return { addresses, errors };
}

/* ---------------- custodian keys ---------------- */

/** Accept a signing key as WIF, 64-hex private key, or 12/24-word BIP-39 mnemonic.
 *
 *  A custodian's PRL address is the BIP-341 keypath-tweaked key Q, so the key
 *  that signs challenges must be the TWEAKED private key (audited
 *  tweakPrivKeypath — the same derivation Pearl Sign uses for keypath
 *  spending). The address-match guard below refuses any key that does not
 *  reproduce the listed address exactly.
 */
export function custodianKeyFromInput(input, network) {
  const t = String(input || "").trim();
  if (!t) throw new Error("empty key input");
  let w, source;
  if (/^[0-9a-fA-F]{64}$/.test(t)) {
    w = walletFromPriv(hexToBytes(t.toLowerCase()), network);
    source = "64-hex private key";
  } else {
    const words = t.split(/\s+/);
    if (words.length === 12 || words.length === 24) {
      w = walletFromMnemonic(t, network); // throws on bad mnemonic
      source = "mnemonic (BIP-86 m/86'/coin'/0'/0/0)";
    } else {
      try {
        w = walletFromWIF(t, network); // throws on bad WIF / wrong network
        source = "WIF";
      } catch {
        throw new Error("key must be WIF, 64-hex private key, or a 12/24-word mnemonic");
      }
    }
  }
  const tweakedPriv = tweakPrivKeypath(w.priv, w.internalXOnly);
  const { tweakedX } = tweakKeypath(w.internalXOnly);
  return {
    priv: w.priv,                 // raw internal key (kept in memory only)
    internalXOnly: w.internalXOnly,
    tweakedPriv,                  // signs challenges verifiable against the address
    tweakedXOnly: tweakedX,
    keypathAddress: encodeBech32m(network.hrp, 1, tweakedX),
    source,
  };
}

/** Address-match guard: the entered key must reproduce the listed address exactly. */
export function assertKeyMatchesAddress(keyInfo, address) {
  if (keyInfo.keypathAddress.toLowerCase() !== String(address).trim().toLowerCase()) {
    throw new Error(
      `key mismatch: this key controls ${keyInfo.keypathAddress}, not ${address}. ` +
      "Solvency proves keypath P2TR addresses only — the key must derive the exact listed address."
    );
  }
}

/* ---------------- challenges ---------------- */

function assertCleanField(name, v, maxLen) {
  const s = String(v ?? "").trim();
  if (!s) throw new Error(`${name} is required`);
  if (s.length > maxLen) throw new Error(`${name} is too long (max ${maxLen} chars)`);
  if (/[|]/.test(s)) throw new Error(`${name} must not contain '|'`);
  if (/[\u0000-\u001f\u007f]/.test(s)) throw new Error(`${name} must not contain control characters`);
  return s;
}

export function validateCustodian(name) { return assertCleanField("custodian name", name, 80); }
export function validateNonce(nonce) { return assertCleanField("nonce", nonce, 64); }

export function validateDateISO(dateISO) {
  const s = String(dateISO ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error("challenge date must be YYYY-MM-DD");
  const d = new Date(s + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) throw new Error("challenge date is not a real date");
  return s;
}

/** Canonical challenge string — every signature commits to custodian, date, nonce, and address. */
export function challengeString({ hrp, custodian, dateISO, nonce, address }) {
  const c = validateCustodian(custodian);
  const d = validateDateISO(dateISO);
  const n = validateNonce(nonce);
  const a = String(address).trim();
  if (!a) throw new Error("challenge address is required");
  return `${SOLVENCY_TAG}|${hrp}|${c}|${d}|${n}|${a}`;
}

/** BIP-340 digest of a challenge: tagged hash (same domain pattern as tx sighashes). */
export function challengeDigest(challengeStr) {
  return taggedHash(SOLVENCY_TAG, new TextEncoder().encode(challengeStr));
}

/** Sign a challenge with a 32-byte private key. Returns 64-byte hex signature. */
export function signChallenge(priv, challengeStr) {
  const sig = signForXOnly(priv, challengeDigest(challengeStr));
  return bytesToHex(sig);
}

/** Verify a challenge signature against an address's x-only program. */
export function verifyChallengeSig(sigHex, challengeStr, program) {
  const dg = challengeDigest(challengeStr);
  return verifySchnorrSig(sigHex, dg, program);
}

/* ---------------- proof bundles ---------------- */

/**
 * Build a tamper-evident proof bundle.
 * proofs: [{address, sig}] — sig is 64-byte hex over the canonical challenge.
 * The fingerprint commits to every field; any edit (liabilities included) breaks it.
 */
export function makeSolvencyBundle({ network, custodian, liabilitiesGrains, dateISO, nonce, proofs }) {
  const c = validateCustodian(custodian);
  const d = validateDateISO(dateISO);
  const n = validateNonce(nonce);
  const liab = typeof liabilitiesGrains === "bigint" ? liabilitiesGrains : BigInt(liabilitiesGrains);
  if (liab < 0n) throw new Error("liabilities cannot be negative");
  if (!Array.isArray(proofs) || proofs.length === 0) throw new Error("at least one signed proof is required");
  if (proofs.length > MAX_ADDRESSES) throw new Error(`too many proofs (max ${MAX_ADDRESSES})`);
  const clean = proofs.map((p, i) => {
    const address = String(p.address || "").trim();
    if (!address) throw new Error(`proof ${i}: address is required`);
    addressToProgram(address, network); // validates HRP/version/length
    const sig = String(p.sig || "").trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sig) && !/^[0-9a-f]{128}$/.test(sig)) throw new Error(`proof ${i}: signature must be 64 hex bytes`);
    return { address, sig };
  });
  // Deterministic order: sort by address so re-serialization is stable.
  clean.sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
  const body = {
    v: BUNDLE_VERSION,
    hrp: network.hrp,
    custodian: c,
    liabilities: liab.toString(), // grains, as decimal string (BigInt-safe)
    date: d,
    nonce: n,
    proofs: clean,
  };
  const fingerprint = fingerprintOf(body);
  const bundle = { ...body, fingerprint };
  return { bundle, fingerprint, json: JSON.stringify(bundle, null, 2) };
}

/** Parse + structural validation of a proof bundle. Throws loudly on tampering. */
export function parseSolvencyBundle(jsonText) {
  let o;
  try { o = JSON.parse(String(jsonText)); } catch { throw new Error("bundle is not valid JSON"); }
  if (!o || typeof o !== "object") throw new Error("bundle must be a JSON object");
  if (o.v !== BUNDLE_VERSION) throw new Error(`unsupported bundle version (expected ${BUNDLE_VERSION})`);
  if (typeof o.fingerprint !== "string" || !/^[0-9a-f]{16}$/.test(o.fingerprint)) {
    throw new Error("bundle fingerprint is missing or malformed");
  }
  const { fingerprint, ...body } = o;
  if (fingerprintOf(body) !== fingerprint) {
    throw new Error("BUNDLE TAMPERED: fingerprint does not match contents — liabilities, custodian, date, nonce, or proofs were edited after signing");
  }
  const network = Object.values(NETWORKS).find((nw) => nw.hrp === o.hrp);
  if (!network) throw new Error(`unknown network HRP '${o.hrp}'`);
  const custodian = validateCustodian(o.custodian);
  const dateISO = validateDateISO(o.date);
  const nonce = validateNonce(o.nonce);
  let liabilities;
  try { liabilities = BigInt(o.liabilities); } catch { throw new Error("liabilities must be a decimal grain count"); }
  if (liabilities < 0n) throw new Error("liabilities cannot be negative");
  if (!Array.isArray(o.proofs) || o.proofs.length === 0) throw new Error("bundle contains no proofs");
  if (o.proofs.length > MAX_ADDRESSES) throw new Error("bundle exceeds address cap");
  const proofs = o.proofs.map((p, i) => {
    const address = String(p?.address || "").trim();
    if (!address) throw new Error(`proof ${i}: address missing`);
    addressToProgram(address, network);
    const sig = String(p?.sig || "").trim().toLowerCase();
    if (!/^[0-9a-f]{128}$/.test(sig)) throw new Error(`proof ${i}: signature must be 128 hex chars`);
    return { address, sig };
  });
  return { network, custodian, liabilitiesGrains: liabilities, dateISO, nonce, proofs, fingerprint };
}

/** Verify every proof's signature against its address key. Returns [{address, ok}]. */
export function verifyBundleSignatures(parsed) {
  return parsed.proofs.map((p) => {
    const program = addressToProgram(p.address, parsed.network);
    const ch = challengeString({ hrp: parsed.network.hrp, custodian: parsed.custodian, dateISO: parsed.dateISO, nonce: parsed.nonce, address: p.address });
    return { address: p.address, ok: verifyChallengeSig(p.sig, ch, program) };
  });
}

/* ---------------- unsigned (air-gap) bundles ---------------- */

/** Export challenges for cold signing: no keys, no signatures. */
export function exportUnsignedBundle({ network, custodian, dateISO, nonce, addresses }) {
  const c = validateCustodian(custodian);
  const d = validateDateISO(dateISO);
  const n = validateNonce(nonce);
  if (!Array.isArray(addresses) || addresses.length === 0) throw new Error("no addresses to challenge");
  if (addresses.length > MAX_ADDRESSES) throw new Error("too many addresses");
  const items = addresses.map((a) => {
    addressToProgram(a, network);
    return { address: a, challenge: challengeString({ hrp: network.hrp, custodian: c, dateISO: d, nonce: n, address: a }) };
  });
  const body = { v: UNSIGNED_VERSION, hrp: network.hrp, custodian: c, date: d, nonce: n, items };
  return { json: JSON.stringify({ ...body, fingerprint: fingerprintOf(body) }, null, 2) };
}

/** Import signatures produced offline against an unsigned bundle. Returns [{address, sig}]. */
export function importSignedChallenges(unsignedJson, signedJson) {
  let u, s;
  try { u = JSON.parse(String(unsignedJson)); } catch { throw new Error("unsigned bundle is not valid JSON"); }
  try { s = JSON.parse(String(signedJson)); } catch { throw new Error("signed import is not valid JSON"); }
  if (u.v !== UNSIGNED_VERSION) throw new Error("not a pearl-solvency-unsigned:v1 bundle");
  const { fingerprint, ...ubody } = u;
  if (fingerprintOf(ubody) !== fingerprint) throw new Error("unsigned bundle was tampered with");
  const want = new Map(ubody.items.map((it) => [it.address, it.challenge]));
  const sigs = s.signatures ?? s.proofs;
  if (!Array.isArray(sigs) || sigs.length === 0) throw new Error("signed import contains no signatures");
  return sigs.map((p, i) => {
    const address = String(p?.address || "").trim();
    if (!want.has(address)) throw new Error(`signed import ${i}: address not in the unsigned bundle (or typo)`);
    const sig = String(p?.sig || "").trim().toLowerCase();
    if (!/^[0-9a-f]{128}$/.test(sig)) throw new Error(`signed import ${i}: signature must be 128 hex chars`);
    return { address, sig };
  });
}

/* ---------------- chain reads (GET-only) ---------------- */

async function bbGetJson(base, path) {
  const res = await fetch(base.replace(/\/$/, "") + path);
  if (!res.ok) throw new Error(`blockbook ${res.status} on ${path}`);
  const text = await res.text();
  try { return JSON.parse(text); } catch { throw new Error("blockbook returned non-JSON"); }
}

/**
 * Confirmed UTXOs for an address, values kept as BigInt grain strings.
 * (The audited fetchUtxos maps value through Number(), which is lossy past
 * 2^53 — total PRL supply is 2.1e17 grains — so we re-read the raw field.)
 */
export async function fetchUtxosBig(blockbookBase, address) {
  const list = await bbGetJson(blockbookBase, `/api/v2/utxo/${address}`);
  if (!Array.isArray(list)) throw new Error("unexpected utxo response");
  return list
    .filter((u) => u && /^[0-9a-f]{64}$/i.test(u.txid || "") && Number.isInteger(u.vout))
    .map((u) => ({
      txid: String(u.txid).toLowerCase(),
      vout: u.vout,
      valueGrains: BigInt(String(u.value)),
      confirmations: u.confirmations ?? 0,
    }))
    .filter((u) => u.valueGrains > 0n);
}

/** Full tx detail (for scriptPubKey byte-comparison of funding outputs). */
export async function fetchTxDetail(blockbookBase, txid) {
  return bbGetJson(blockbookBase, `/api/v2/tx/${txid}`);
}

/** Byte-compare a funding output's script against the address's P2TR scriptPubKey. */
export function fundingScriptMatches(txDetail, vout, program) {
  const outs = txDetail?.vout;
  if (!Array.isArray(outs)) return false;
  const o = outs.find((x) => x && x.n === vout);
  if (!o || typeof o.hex !== "string") return false;
  return o.hex.toLowerCase() === bytesToHex(p2trScriptPubKey(program)).toLowerCase();
}

/**
 * Sum confirmed reserves for one address.
 * Every UTXO's funding output script is byte-compared to the address
 * scriptPubKey; foreign-script UTXOs are flagged and EXCLUDED, never trusted.
 * Returns {confirmedGrains, unconfirmedGrains, checked, foreign}.
 */
export async function sumAddressReserves(blockbookBase, address, network, { verifyScripts = true } = {}) {
  const program = addressToProgram(address, network);
  const utxos = await fetchUtxosBig(blockbookBase, address);
  let confirmedGrains = 0n;
  let unconfirmedGrains = 0n;
  let checked = 0;
  const foreign = [];
  const scriptCache = new Map(); // txid -> txDetail (one fetch per funding tx)
  for (const u of utxos) {
    if (u.confirmations > 0) {
      let ok = true;
      if (verifyScripts) {
        let detail = scriptCache.get(u.txid);
        if (!detail) {
          detail = await fetchTxDetail(blockbookBase, u.txid);
          scriptCache.set(u.txid, detail);
        }
        ok = fundingScriptMatches(detail, u.vout, program);
        checked++;
      }
      if (ok) confirmedGrains += u.valueGrains;
      else foreign.push({ txid: u.txid, vout: u.vout, valueGrains: u.valueGrains.toString() });
    } else {
      unconfirmedGrains += u.valueGrains;
    }
  }
  return { confirmedGrains, unconfirmedGrains, checked, foreign };
}

/* ---------------- verdict ---------------- */

export function reserveVerdict(totalGrains, liabilitiesGrains) {
  const total = BigInt(totalGrains);
  const liab = BigInt(liabilitiesGrains);
  if (liab === 0n) return { verdict: total > 0n ? "PROVEN" : "EMPTY", ratio: null, shortfallGrains: 0n };
  const proven = total >= liab;
  // ratio as basis points for exact display (e.g. 10250 = 102.50%)
  const ratioBp = (total * 10000n) / liab;
  return {
    verdict: proven ? "PROVEN" : "SHORTFALL",
    ratioBp,
    shortfallGrains: proven ? 0n : liab - total,
  };
}

export function fmtRatioBp(bp) {
  if (bp === null || bp === undefined) return "n/a";
  const b = BigInt(bp);
  return (b / 100n).toString() + "." + (b % 100n).toString().padStart(2, "0") + "%";
}

export { bytesToHex, hexToBytes, sha256, schnorr, encodeBech32m, decodeBech32m, p2trScriptPubKey, taggedHash };
