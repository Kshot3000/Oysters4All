// Pearl Oracle — signed price-feed ticker desk (core logic).
//
// A Pearl Oracle is a BIP-86 keyholder who publishes signed price
// attestations. Each attestation binds (asset, price-in-minor-units,
// decimals, unix ts, strictly increasing seq, nonce, hash-chain prev,
// free-text source) under a canonical JSON encoding; the attestation id
// is SHA-256 of the canonical bytes and the id is signed with a BIP-340
// Schnorr signature from the TWEAKED keypath private key — the exact
// same construction the Ballot/Solvency desks use (tweakPrivKeypath),
// verifiable against the tweaked x-only pubkey that also controls the
// oracle's prl1… address.
//
// NO new cryptography is introduced here: every primitive (sha256,
// schnorr, BIP-86 derivation, BIP-341 keypath tweak) is imported from
// the audited ../../sign/src/crypto.js.
//
// Honest limits (enforced by design, surfaced in the UI):
//  - A signature proves AUTHORSHIP, not truth. Prices are self-reported
//    by whoever holds the key; anyone can mint an oracle key.
//  - The feed is local-only: no listing relay, no shared network.
//  - Replay is stopped only inside a chain a consumer chooses to trust
//    (strictly increasing seq + prev hash links).
//  - Timestamps are asserted, not proven (±24h sanity is a warning).
//  - The page never moves PRL and never broadcasts anything.
import {
  NETWORKS, GRAIN_PER_PRL,
  sha256, bytesToHex, hexToBytes, schnorr,
  newMnemonic,
  walletFromMnemonic, walletFromWIF, walletFromPriv, walletToWIF,
  tweakPrivKeypath, tweakKeypath,
} from "../../sign/src/crypto.js";

export {
  NETWORKS, GRAIN_PER_PRL,
  sha256, bytesToHex, hexToBytes, schnorr,
  newMnemonic,
  walletFromMnemonic, walletFromWIF, walletFromPriv, walletToWIF,
  tweakPrivKeypath, tweakKeypath,
};

/* ---------------- protocol constants ---------------- */

/** Protocol tag embedded in every attestation. */
export const ORACLE_PROTOCOL = "prl-oracle";
/** Attestation format version. */
export const ORACLE_VERSION = 1;
/** Genesis prev: 64 zero hex chars (no previous attestation). */
export const GENESIS_PREV = "0".repeat(64);
/** localStorage key for the oracle's local hash-chained feed. */
export const FEED_STORAGE_KEY = "prl-oracle-feed-v1";
/** Max signed rows kept / verified in one pass (sanity bound). */
export const MAX_FEED_ROWS = 100000;
/** ts sanity tolerance, seconds (±24h). Beyond this → loud warning. */
export const TS_SANITY_TOLERANCE_S = 24 * 3600;
/** Built-in asset pairs offered in the composer. */
export const ASSET_PRESETS = ["PRL/USD", "PRL/BTC", "PRL/ETH"];

/* ---------------- key identity ---------------- */

/** Oracle identity: the TWEAKED keypath x-only pubkey — the same key
 *  that controls the oracle's PRL address (like the Ballot desk). */
export function oraclePubkeyHex(internalXOnly) {
  const x = internalXOnly instanceof Uint8Array ? internalXOnly : hexToBytes(internalXOnly);
  if (x.length !== 32) throw new Error("internalXOnly must be 32 bytes");
  return bytesToHex(tweakKeypath(x).tweakedX);
}

/** Tweaked keypath private key used to sign attestations. */
export function oracleSigningKey(priv, internalXOnly) {
  const p = priv instanceof Uint8Array ? priv : hexToBytes(priv);
  return tweakPrivKeypath(p, internalXOnly);
}

/** Auto-detect a secret: 64-hex private key, WIF, or 12/24-word
 *  mnemonic (same detection order as the Sign desk). Returns the wallet
 *  ({ priv, internalXOnly, address, network }) plus a `source` label. */
export function oracleKeyFromInput(input, network = NETWORKS.mainnet) {
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
  throw new Error("oracle key must be a 32-byte hex private key, WIF, or a 12/24-word mnemonic");
}

/* ---------------- field validation ---------------- */

const INT_STR = /^(0|[1-9][0-9]*)$/; // canonical integer string, no floats, no leading zeros
const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const ASSET_RE = /^[A-Za-z0-9][A-Za-z0-9 _\-./]{0,63}$/;

const normHex = (s) => String(s ?? "").trim().toLowerCase();

/** Validate the eight unsigned attestation fields (no p/v — the composer
 *  collects only the variable fields; p/v are protocol constants added
 *  at canonicalization). Returns { ok, errors[] }. */
export function validateUnsignedFields(f) {
  const errors = [];
  const bad = (m) => errors.push(m);
  if (!f || typeof f !== "object" || Array.isArray(f)) return { ok: false, errors: ["attestation must be a JSON object"] };
  const asset = String(f.asset ?? "");
  if (!ASSET_RE.test(asset)) bad("asset must be 1–64 chars: letters, digits, space, _ - . /");
  for (const k of ["price", "decimals", "ts", "seq"]) {
    if (typeof f[k] !== "string" || !INT_STR.test(f[k])) {
      bad(`${k} must be a non-negative integer as a string (no floats, no leading zeros) — got ${JSON.stringify(f[k])}`);
    }
  }
  const nonce = normHex(f.nonce);
  if (!HEX32.test(nonce)) bad("nonce must be 32 lowercase hex chars (16 CSPRNG bytes)");
  const prev = normHex(f.prev);
  if (!HEX64.test(prev)) bad("prev must be 64 lowercase hex chars (SHA-256 of previous canonical bytes, or 64 zeros for genesis)");
  const source = String(f.source ?? "");
  if (source.length < 1 || source.length > 200) bad("source must be 1–200 chars naming where the price came from (honest self-report)");
  if (/[\x00-\x1f\x7f]/.test(source)) bad("source must not contain control characters");
  return { ok: errors.length === 0, errors };
}

/** Validate a signed envelope's full field set (unsigned fields + p/v
 *  protocol tags; pub/sig are checked separately). */
export function validateFields(f) {
  const errors = [];
  if (!f || typeof f !== "object" || Array.isArray(f)) return { ok: false, errors: ["attestation must be a JSON object"] };
  if (f.p !== ORACLE_PROTOCOL) errors.push(`p must be "${ORACLE_PROTOCOL}"`);
  if (f.v !== ORACLE_VERSION) errors.push(`v must be ${ORACLE_VERSION}`);
  const u = validateUnsignedFields(f);
  return { ok: errors.length === 0 && u.ok, errors: errors.concat(u.errors) };
}

/* ---------------- canonical encoding ---------------- */

/** Canonical JSON of the unsigned attestation — fixed key order,
 *  JSON.stringify escaping (deterministic). price/decimals/ts/seq are
 *  already validated integer strings, so no float can ever appear. */
export function canonicalAttestation(f) {
  const v = validateUnsignedFields(f);
  if (!v.ok) throw new Error("cannot canonicalize: " + v.errors[0]);
  const parts = [
    `"p":"${ORACLE_PROTOCOL}"`,
    `"v":${ORACLE_VERSION}`,
    `"asset":${JSON.stringify(String(f.asset))}`,
    `"price":"${f.price}"`,
    `"decimals":"${f.decimals}"`,
    `"ts":"${f.ts}"`,
    `"seq":"${f.seq}"`,
    `"nonce":"${normHex(f.nonce)}"`,
    `"prev":"${normHex(f.prev)}"`,
    `"source":${JSON.stringify(String(f.source))}`,
  ];
  return `{${parts.join(",")}}`;
}

/** Attestation id = SHA-256 hex of the canonical bytes. */
export function attestationId(canonical) {
  return bytesToHex(sha256(new TextEncoder().encode(canonical)));
}

/* ---------------- signing ---------------- */

function randHex(bytes) {
  const c = (typeof globalThis !== "undefined" && globalThis.crypto) || null;
  if (!c || typeof c.getRandomValues !== "function") {
    throw new Error("no CSPRNG available — nonces must come from crypto.getRandomValues");
  }
  const b = new Uint8Array(bytes);
  c.getRandomValues(b);
  return bytesToHex(b);
}

/** 16-byte CSPRNG nonce, lowercase hex (uniqueness, not secrecy). */
export function genNonceHex() { return randHex(16); }

/** Sign an attestation locally.
 *  - fields: { asset, price, decimals, ts, seq, nonce, prev, source }
 *  - priv / internalXOnly: the oracle key (any accepted input form)
 *  - auxRand: optional 32 bytes for deterministic test vectors;
 *    production callers leave it random (BIP-340 aux randomness).
 *  The signature is re-verified against the tweaked oracle pubkey before
 *  returning — a wrong-key sign is a loud failure here, not downstream.
 *  Returns the signed envelope { p, v, asset, price, decimals, ts, seq,
 *  nonce, prev, source, pub, sig }. */
export function signAttestation({ fields, priv, internalXOnly, auxRand = undefined }) {
  const canonical = canonicalAttestation(fields);
  const id = attestationId(canonical);
  const privB = priv instanceof Uint8Array ? priv : hexToBytes(priv);
  const xB = internalXOnly instanceof Uint8Array ? internalXOnly : hexToBytes(internalXOnly);
  if (privB.length !== 32 || xB.length !== 32) throw new Error("priv and internalXOnly must be 32 bytes");
  const tweakedPriv = tweakPrivKeypath(privB, xB);
  const pub = bytesToHex(tweakKeypath(xB).tweakedX);
  const sig = schnorr.sign(hexToBytes(id), tweakedPriv, ...(auxRand === undefined ? [] : [auxRand]));
  // Re-verify against the oracle's tweaked pubkey (loud wrong-key refusal).
  if (!schnorr.verify(sig, hexToBytes(id), hexToBytes(pub))) {
    throw new Error("LOUD REFUSAL: the attestation signature does not verify against the oracle key — the signing key does not control this oracle identity. Attestation NOT signed.");
  }
  return {
    p: ORACLE_PROTOCOL, v: ORACLE_VERSION,
    asset: String(fields.asset), price: String(fields.price), decimals: String(fields.decimals),
    ts: String(fields.ts), seq: String(fields.seq),
    nonce: normHex(fields.nonce), prev: normHex(fields.prev), source: String(fields.source),
    pub, sig: bytesToHex(sig),
  };
}

/* ---------------- standalone verification ---------------- */

const SIGNED_KEYS = ["p", "v", "asset", "price", "decimals", "ts", "seq", "nonce", "prev", "source", "pub", "sig"];

/** Parse + verify a signed attestation envelope (object or JSON text).
 *  Returns { verdict: "VALID" | "VALID-WARN" | "INVALID", id, checks[] }
 *  where each check is { name, status: "pass"|"warn"|"fail", detail }.
 *  Never throws on malformed input — it rules INVALID with loud rows. */
export function verifyAttestation(raw) {
  const checks = [];
  const row = (name, status, detail) => checks.push({ name, status, detail });
  let a;
  try {
    a = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (e) {
    row("JSON parses", "fail", "not valid JSON: " + String(e.message || e).slice(0, 120));
    return { verdict: "INVALID", id: null, checks };
  }
  if (!a || typeof a !== "object" || Array.isArray(a)) {
    row("envelope is an object", "fail", "must be a JSON object");
    return { verdict: "INVALID", id: null, checks };
  }
  const unknown = Object.keys(a).filter((k) => !SIGNED_KEYS.includes(k));
  if (unknown.length) {
    row("no unknown fields", "fail", "rejected unknown field(s): " + unknown.join(", "));
  } else {
    row("no unknown fields", "pass", "exactly the 12 protocol fields");
  }
  const missing = SIGNED_KEYS.filter((k) => !(k in a));
  if (missing.length) row("all fields present", "fail", "missing: " + missing.join(", "));
  else row("all fields present", "pass", "p, v, asset, price, decimals, ts, seq, nonce, prev, source, pub, sig");
  const fv = validateFields(a);
  if (fv.ok) row("canonical field rules", "pass", "p/v tags, integer strings, 32-hex nonce, 64-hex prev, source 1–200 chars");
  else for (const e of fv.errors) row("canonical field rules", "fail", e);
  // pub must be a valid curve x-coordinate
  let pubBytes = null;
  const pubHex = normHex(a.pub);
  if (!HEX64.test(pubHex)) {
    row("pub is a valid x-only key", "fail", "pub must be 64 lowercase hex chars");
  } else {
    try { schnorr.utils.lift_x(BigInt("0x" + pubHex)); pubBytes = hexToBytes(pubHex); row("pub is a valid x-only key", "pass", "lifts to a curve point"); }
    catch { row("pub is a valid x-only key", "fail", "pub is not a valid secp256k1 x-coordinate"); }
  }
  const sigHex = normHex(a.sig);
  if (!HEX128.test(sigHex)) row("sig is 128 hex chars", "fail", "sig must be a 64-byte BIP-340 signature");
  else row("sig is 128 hex chars", "pass", "64-byte BIP-340 Schnorr signature");

  // attestation id recompute (needs valid fields)
  let id = null;
  if (fv.ok) {
    id = attestationId(canonicalAttestation(a));
    row("attestation id recomputes", "pass", "SHA-256(canonical bytes) = " + id.slice(0, 24) + "…");
  } else {
    row("attestation id recomputes", "fail", "cannot recompute: fields invalid");
  }
  // BIP-340 signature over the id, under the stated pub
  if (id && pubBytes && HEX128.test(sigHex)) {
    try {
      if (schnorr.verify(hexToBytes(sigHex), hexToBytes(id), pubBytes)) {
        row("BIP-340 signature verifies under pub", "pass", "signature covers exactly the attestation id");
      } else {
        row("BIP-340 signature verifies under pub", "fail", "signature does NOT verify — tampered fields or wrong key");
      }
    } catch (e) {
      row("BIP-340 signature verifies under pub", "fail", "verify threw: " + String(e.message || e).slice(0, 120));
    }
  } else {
    row("BIP-340 signature verifies under pub", "fail", "skipped: id/pub/sig unavailable");
  }
  // ts sanity — warning only, never a validity failure
  if (fv.ok && INT_STR.test(String(a.ts))) {
    const nowS = Math.floor(Date.now() / 1000);
    const drift = Number(BigInt(a.ts)) - nowS;
    if (Math.abs(drift) > TS_SANITY_TOLERANCE_S) {
      const dir = drift > 0 ? "in the future" : "in the past";
      row("timestamp sanity", "warn", `LOUD: ts is ${Math.abs(drift)} s ${dir} (>24h off now) — timestamps are asserted by the keyholder, not proven`);
    } else {
      row("timestamp sanity", "pass", `ts within ±24h of now (${drift >= 0 ? "+" : ""}${drift} s)`);
    }
  }
  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  const verdict = fails ? "INVALID" : warns ? "VALID-WARN" : "VALID";
  return { verdict, id, checks };
}

/* ---------------- feed chain verification ---------------- */

function rowObj(r) {
  if (typeof r === "string") { try { return JSON.parse(r); } catch { return null; } }
  return (r && typeof r === "object" && !Array.isArray(r)) ? r : null;
}

/** Verify a whole local feed: every row parses, every signature
 *  verifies, prev links form one hash chain, seq is strictly
 *  increasing, and the genesis row's prev is 64 zeros.
 *  Returns { ok, rows: [{ index, id, status, errors[] }] }. */
export function verifyFeedChain(rows) {
  const out = { ok: true, rows: [] };
  const list = Array.isArray(rows) ? rows : [];
  if (list.length > MAX_FEED_ROWS) {
    out.ok = false;
    out.rows.push({ index: -1, id: null, status: "INVALID", errors: [`feed too long (${list.length} > ${MAX_FEED_ROWS})`] });
    return out;
  }
  let prevId = null;
  let prevSeq = null;
  for (let i = 0; i < list.length; i++) {
    const errors = [];
    const v = verifyAttestation(list[i]);
    if (v.verdict === "INVALID") {
      for (const c of v.checks) if (c.status === "fail") errors.push(c.name + ": " + c.detail);
    }
    const a = rowObj(list[i]);
    if (a && v.id) {
      const prevHex = normHex(a.prev);
      if (i === 0) {
        if (prevHex !== GENESIS_PREV) errors.push(`genesis prev must be 64 zeros — got ${prevHex.slice(0, 16)}…`);
      } else if (prevHex !== prevId) {
        errors.push(`prev link broken: row ${i} prev ${prevHex.slice(0, 16)}… ≠ row ${i - 1} id ${String(prevId).slice(0, 16)}…`);
      }
      try {
        const s = BigInt(String(a.seq));
        if (prevSeq !== null && s <= prevSeq) errors.push(`seq must strictly increase: ${s} ≤ previous ${prevSeq}`);
        prevSeq = s;
      } catch { errors.push("seq is not an integer"); }
      prevId = v.id;
    }
    const status = errors.length ? "INVALID" : "VALID";
    if (errors.length) out.ok = false;
    out.rows.push({ index: i, id: v.id, status, errors });
  }
  return out;
}

/* ---------------- local feed store ---------------- */

function memStore() {
  let v = null;
  return { getItem: () => v, setItem: (_k, x) => { v = String(x); }, removeItem: () => { v = null; } };
}
let _store = null;
function store() {
  if (_store) return _store;
  try {
    const ls = globalThis.localStorage;
    if (ls && typeof ls.getItem === "function") { _store = ls; return _store; }
  } catch { /* fall through to memory */ }
  _store = memStore();
  return _store;
}

/** Load the local hash-chained feed (array of signed envelopes).
 *  Invalid stored rows are dropped loudly (returned in `dropped`). */
export function loadFeed() {
  const st = store();
  let raw = null;
  try { raw = st.getItem(FEED_STORAGE_KEY); } catch { raw = null; }
  if (!raw) return { rows: [], dropped: 0 };
  let arr;
  try { arr = JSON.parse(raw); } catch { return { rows: [], dropped: 1 }; }
  if (!Array.isArray(arr)) return { rows: [], dropped: 1 };
  const rows = [];
  let dropped = 0;
  for (const r of arr) {
    const v = verifyAttestation(r);
    if (v.verdict === "INVALID") { dropped++; continue; }
    rows.push(r);
  }
  return { rows, dropped };
}

/** Persist the local feed. Throws if any row is INVALID. */
export function saveFeed(rows) {
  const list = Array.isArray(rows) ? rows : [];
  for (let i = 0; i < list.length; i++) {
    const v = verifyAttestation(list[i]);
    if (v.verdict === "INVALID") throw new Error(`refusing to persist: row ${i} is INVALID`);
  }
  store().setItem(FEED_STORAGE_KEY, JSON.stringify(list));
  return list.length;
}

/** Next defaults for the composer: prev = last row id (or genesis),
 *  seq = last seq + 1 (or 0). */
export function nextChainDefaults(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return { prev: GENESIS_PREV, seq: "0" };
  const last = rowObj(list[list.length - 1]);
  const v = verifyAttestation(list[list.length - 1]);
  const seq = (() => { try { return (BigInt(String(last.seq)) + 1n).toString(); } catch { return "0"; } })();
  return { prev: v.id || GENESIS_PREV, seq };
}

/* ---------------- import / export ---------------- */

/** Parse an imported feed: JSON array (or single envelope). Every row
 *  must verify VALID/VALID-WARN or the whole import is refused. */
export function importFeedText(text) {
  let arr;
  try { arr = JSON.parse(String(text)); } catch (e) {
    throw new Error("import is not valid JSON: " + String(e.message || e).slice(0, 120));
  }
  if (!Array.isArray(arr)) arr = [arr];
  if (arr.length > MAX_FEED_ROWS) throw new Error(`import too long (${arr.length} > ${MAX_FEED_ROWS})`);
  const rows = [];
  for (let i = 0; i < arr.length; i++) {
    const v = verifyAttestation(arr[i]);
    if (v.verdict === "INVALID") {
      const first = v.checks.find((c) => c.status === "fail");
      throw new Error(`import refused: row ${i} INVALID — ${first ? first.name + ": " + first.detail : "failed checks"}`);
    }
    rows.push(arr[i]);
  }
  return rows;
}

export function feedToJSON(rows) {
  return JSON.stringify(Array.isArray(rows) ? rows : [], null, 2);
}

const csvCell = (v) => {
  let s = String(v ?? "");
  // Spreadsheet formula-injection guard (CWE-1236): a cell whose text begins
  // (after optional spaces) with =, +, -, @, | or % is executed as a formula
  // when the CSV is opened in Excel/Sheets — quoting does NOT prevent it.
  // Prefix such cells with an apostrophe so they open as text. Plain numbers
  // (including negative amounts) are data, not formulas, and pass untouched.
  if (!/^-?\d+(\.\d+)?$/.test(s) && /^\s*[=+\-@|%]/.test(s)) s = "'" + s;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** CSV export of the feed (envelope fields + id). */
export function feedToCSV(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const header = ["id", ...SIGNED_KEYS];
  const lines = [header.join(",")];
  for (const r of list) {
    const v = verifyAttestation(r);
    const a = rowObj(r) || {};
    lines.push([v.id || "", ...SIGNED_KEYS.map((k) => csvCell(a[k]))].join(","));
  }
  return lines.join("\n");
}

/** Series for the per-asset canvas chart: prices scaled to a common
 *  decimal base with BigInt (no float rounding), sorted by ts. */
export function seriesForAsset(rows, asset) {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => {
    const a = typeof r === "string" ? (() => { try { return JSON.parse(r); } catch { return null; } })() : r;
    return a && String(a.asset) === asset;
  });
  if (!list.length) return { asset, decimals: 0, points: [] };
  let maxDec = 0;
  const parsed = list.map((r) => {
    const a = typeof r === "string" ? JSON.parse(r) : r;
    const dec = Number(a.decimals);
    if (dec > maxDec) maxDec = dec;
    return { ts: Number(BigInt(a.ts)), price: BigInt(a.price), dec, id: verifyAttestation(r).id };
  });
  parsed.sort((x, y) => x.ts - y.ts);
  const points = parsed.map((p) => ({
    ts: p.ts,
    value: Number(p.price * (10n ** BigInt(maxDec - p.dec))), // display scaling only
    id: p.id,
  }));
  return { asset, decimals: maxDec, points };
}

/** Human display of a price: integer minor units → decimal string with
 *  exactly `decimals` fractional digits (trailing zeros kept — they are
 *  significant for minor-unit prices). Pure string math — no floats. */
export function formatPrice(priceStr, decimalsStr) {
  const dec = Number(decimalsStr);
  let p = String(priceStr);
  if (dec === 0) return p;
  while (p.length <= dec) p = "0" + p;
  return `${p.slice(0, p.length - dec)}.${p.slice(p.length - dec)}`;
}
