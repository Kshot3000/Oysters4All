/* Pearl Gallery — pure content-classification + rendering-safety logic.
 * Shared between the browser app (app.js) and the node test suite.
 * No DOM, no fetch, no side effects: every export is a pure function.
 *
 * Contract sources (verified, not assumed):
 *  - Pearlscriptions/indexer docs/api-contract.md:
 *      GET /inscriptions (order asc|desc, page, limit<=100)
 *      GET /inscriptions/:id
 *      GET /inscriptions/:id/content -> { id, inscriptionNumber, contentType,
 *        byteLength, encoding:"base64", bodyBase64, bodyHex, bodyText }
 *      GET /inscriptions/:id/location
 *      GET /addresses/:address/inscriptions
 *  - apps/indexer-api/src/indexer.js (routeSnapshot, publicInscriptionRecord):
 *      content endpoint returns encoding "base64" with bodyBase64 (+bodyHex,
 *      +safe bodyText only for text/plain|application/json|*+json or prl-20).
 */
"use strict";

const DONATE_ADDRESS = "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d";
const X_HANDLE = "kshot9000";

/** Max content bytes we will turn into an inline data URL preview. */
const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;

/** Renderable inline as <img>: raster image/* except svg/xhtml (script risk). */
const IMG_TYPES = new Set([
  "image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp",
  "image/avif", "image/bmp", "image/apng"
]);

const AUDIO_TYPES = new Set([
  "audio/mpeg", "audio/mp3", "audio/ogg", "audio/wav", "audio/webm",
  "audio/aac", "audio/flac", "audio/m4a", "audio/x-wav"
]);

const VIDEO_TYPES = new Set([
  "video/mp4", "video/webm", "video/ogg", "video/quicktime", "video/x-matroska"
]);

/** Renderable as escaped text: mirrors upstream isSafeTextContentType. */
function isSafeTextContentType(contentType) {
  const t = String(contentType ?? "").toLowerCase().split(";")[0].trim();
  return (
    t.startsWith("text/plain") ||
    t === "application/json" ||
    t.endsWith("+json")
  );
}

/**
 * Normalizes a raw content-type header value: strips parameters, lowercases,
 * and rejects anything that is not a plausible "type/subtype" token. Returns
 * the canonical "type/subtype" or "" when invalid. This is the allowlist gate
 * for every data: URL we build — a malicious content-type containing quotes or
 * semicolons can never reach the URL.
 */
function normalizeContentType(ct) {
  if (ct === null || ct === undefined) return "";
  const base = String(ct).split(";")[0].trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/.test(base)) return "";
  if (base.includes("..")) return "";
  return base;
}

/** Classify an inscription's content into a render bucket. */
function classifyContent(contentType, byteLength) {
  const t = normalizeContentType(contentType);
  if (!t) return { bucket: "unknown", type: "" };
  const [major] = t.split("/");
  const size = Number(byteLength ?? NaN);
  if (Number.isFinite(size) && size > MAX_PREVIEW_BYTES) {
    return { bucket: "too-large", type: t };
  }
  if (IMG_TYPES.has(t)) return { bucket: "image", type: t };
  if (AUDIO_TYPES.has(t)) return { bucket: "audio", type: t };
  if (VIDEO_TYPES.has(t)) return { bucket: "video", type: t };
  if (isSafeTextContentType(t)) return { bucket: "text", type: t };
  if (t.startsWith("image/") || t === "text/html" || t === "application/xhtml+xml") {
    // Deliberately NOT rendered: SVG/HTML can carry scripts even inside
    // <img>/data URLs in some contexts; show as text/hex instead.
    return { bucket: "not-rendered", type: t };
  }
  return { bucket: "binary", type: t };
}

/**
 * Decodes base64 strictly. Returns a Uint8Array or null. Throws nothing.
 * Rejects whitespace and non-alphabet characters (data URIs must not smuggle).
 */
function decodeBase64Strict(b64) {
  if (typeof b64 !== "string" || b64.length === 0) return null;
  const clean = b64.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) return null;
  if (clean.length % 4 === 1) return null; // impossible length
  try {
    const bin = (typeof atob === "function" ? atob : (s) => Buffer.from(s, "base64").toString("binary"))(clean);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/**
 * Builds a data: URL for inline preview. Returns "" unless EVERY gate passes:
 * content endpoint encoding is "base64", the content-type normalizes cleanly,
 * classification is a renderable bucket, and the bytes decode strictly.
 * Callers must still escape before inserting into HTML attributes.
 */
function buildDataUrl(content) {
  const c = content || {};
  if (c.encoding !== "base64" || typeof c.bodyBase64 !== "string") return "";
  const cls = classifyContent(c.contentType, c.byteLength);
  if (cls.bucket !== "image" && cls.bucket !== "audio" && cls.bucket !== "video") return "";
  const bytes = decodeBase64Strict(c.bodyBase64);
  if (!bytes || bytes.length === 0) return "";
  if (bytes.length > MAX_PREVIEW_BYTES) return "";
  const declared = Number(c.byteLength ?? NaN);
  if (Number.isFinite(declared) && declared !== bytes.length) return ""; // length lie -> refuse
  let b64;
  if (typeof btoa === "function") {
    let bin = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    b64 = btoa(bin);
  } else {
    b64 = Buffer.from(bytes).toString("base64");
  }
  return `data:${cls.type};base64,${b64}`;
}

/** Human-readable byte size. */
function fmtBytes(n) {
  if (n === null || n === undefined || n === "" || !Number.isFinite(Number(n))) return "—";
  const v = Number(n);
  if (v < 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0, x = v;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
  return (i === 0 ? x.toString() : x.toFixed(x < 10 ? 2 : 1)) + " " + units[i];
}

/** Shortens a long id/txid for display. */
function short(v, n = 12) {
  const s = String(v ?? "");
  if (s.length <= n * 2 + 1) return s;
  return s.slice(0, n) + "…" + s.slice(-n);
}

/**
 * Normalizes an inscription list record from GET /inscriptions into the
 * fields the wall card needs. Defensive: renders only what the API returns.
 */
function normalizeCard(rec) {
  const r = rec || {};
  const id = String(r.inscriptionId ?? r.id ?? "");
  const num = r.inscriptionNumber;
  const ct = String(r.contentType ?? r.content_type ?? "");
  return {
    id,
    inscriptionNumber: num === null || num === undefined ? null : Number(num),
    contentType: ct,
    byteLength: r.byteLength ?? r.byte_length ?? null,
    txid: String(r.txid ?? ""),
    blockHeight: r.blockHeight ?? r.block_height ?? null,
    protocolMarker: String(r.protocolMarker ?? r.marker ?? ""),
    ownerAddress: String(r.currentOwnerAddress ?? r.ownerAddress ?? ""),
    cls: classifyContent(ct, r.byteLength ?? r.byte_length),
  };
}

/**
 * Builds the query string for GET /inscriptions. order: "asc"|"desc",
 * page >= 1, limit clamped to 1..100 (contract max).
 */
function inscriptionsQuery({ order = "desc", page = 1, limit = 24 } = {}) {
  const o = order === "asc" ? "asc" : "desc";
  const p = Math.max(1, Math.floor(Number(page) || 1));
  const l = Math.min(100, Math.max(1, Math.floor(Number(limit) || 24)));
  return `?order=${o}&page=${p}&limit=${l}`;
}

/**
 * Decides whether a lookup string addresses an inscription by number or id.
 * Numbers are canonical zero-based integers; anything else is an id.
 */
function parseLookup(q) {
  const s = String(q ?? "").trim();
  if (s === "") return { kind: "empty" };
  if (/^\d+$/.test(s)) return { kind: "number", value: s };
  return { kind: "id", value: s };
}

/**
 * Finds an inscription with the given number inside a list-page payload
 * (used when the API has no direct by-number lookup: scan desc/asc pages).
 * Returns the record or null.
 */
function findByNumber(payload, number) {
  const items = (payload && (payload.inscriptions ?? payload.items)) || [];
  const n = Number(number);
  for (const it of items) {
    if (Number(it.inscriptionNumber) === n) return it;
  }
  return null;
}

const __galleryExports = {
  DONATE_ADDRESS, X_HANDLE, MAX_PREVIEW_BYTES,
  normalizeContentType, isSafeTextContentType, classifyContent,
  decodeBase64Strict, buildDataUrl, fmtBytes, short,
  normalizeCard, inscriptionsQuery, parseLookup, findByNumber,
};
if (typeof window !== "undefined") window.__galleryCore = __galleryExports;
if (typeof module !== "undefined" && module.exports) {
  module.exports = __galleryExports;
}
