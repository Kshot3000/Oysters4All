/* Pearl Registry core — decentralized handle/name service for Pearl (PRL).
 *
 * Pure ESM: no DOM, no fetch, no side effects. The browser ships a committed
 * esbuild IIFE bundle (pearl-registry.bundle.js); node runs this file directly
 * for the verification suite.
 *
 * Protocol (app-level convention, NOT Pearl consensus — see honest limits):
 *  - Handles are claimed on Pearl via Taproot commit/reveal inscriptions
 *    following the Pearlscriptions commit/reveal envelope pattern, but with
 *    the `prl-name` protocol marker (distinct from `prl-20` and `prl-notary`).
 *  - Consensus rules (first-seen wins):
 *      claim    {p:"prl-name", op:"claim",    handle, owner, ts}
 *      transfer {p:"prl-name", op:"transfer", handle, from, to, ts}
 *      release  {p:"prl-name", op:"release",  handle, from, ts}
 *    The FIRST valid claim (lowest inscription number per the indexer) owns
 *    the handle; later claims lose. Transfers are valid only from the current
 *    owner. Release frees the handle for re-claim.
 *
 * Crypto lineage: no new cryptography. Envelope framing is derived from the
 * audited `buildInscriptionScript` in files/pages/sign/src/crypto.js with a
 * surgical, assertion-guarded marker swap (prl-20 -> prl-name); commit/reveal
 * transaction building reuses files/pages/etch/src/etch-core.js
 * (buildCommitTx / buildRevealTxSigned) via the browser bundle; address
 * validation reuses the audited bech32m decoder from Sign core.
 */
"use strict";

import { utf8ToBytes } from "@noble/hashes/utils";
import {
  NETWORKS, GRAIN_PER_PRL, DUST_GRAIN,
  buildInscriptionScript, commitKeyInfo, revealTxVBytes,
  tapLeafHash, decodeBech32m, bytesToHex, hexToBytes,
} from "../../sign/src/crypto.js";

export const NAME_PROTOCOL = "prl-name";
export const NAME_MARKER = "prl-name";
export const DONATE_ADDRESS = "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d";
export const X_HANDLE = "kshot9000";

/** Indexer API contract mirrors pages/gallery (Pearlscriptions indexer). */
export const INDEXER = Object.freeze({
  pageLimit: 100,          // contract max for /inscriptions
  defaultMaxPages: 20,     // 20 * 100 = 2,000 inscriptions per scan
  hardMaxPages: 200,
});

export { NETWORKS, GRAIN_PER_PRL, DUST_GRAIN, bytesToHex, hexToBytes };

/* ---------------- handle rules ---------------- */

const HANDLE_CHARSET = /^[a-z0-9-]+$/;

/** Normalization: trim + lowercase. Everything else is rejected. */
export function normalizeHandle(raw) {
  return String(raw ?? "").trim().toLowerCase();
}

/** Validate a handle. Returns { ok, handle, reasons[] }.
 *  Rules: 1-32 chars; [a-z0-9-]; no leading/trailing/double hyphens. */
export function validateHandle(raw) {
  const reasons = [];
  const handle = normalizeHandle(raw);
  if (handle.length === 0) reasons.push("handle is empty");
  if (handle.length > 32) reasons.push(`handle too long (${handle.length} > 32 chars)`);
  if (handle && !HANDLE_CHARSET.test(handle)) reasons.push("handle may only contain a-z, 0-9 and hyphen");
  if (handle.startsWith("-")) reasons.push("handle may not start with a hyphen");
  if (handle.endsWith("-")) reasons.push("handle may not end with a hyphen");
  if (handle.includes("--")) reasons.push("handle may not contain double hyphens");
  if (String(raw ?? "") !== String(raw ?? "").trim().toLowerCase() && handle) {
    // informational: normalization changed it; canonical form is what counts
  }
  return { ok: reasons.length === 0, handle, reasons };
}

/* ---------------- owner address ---------------- */

/** Validate a prl1/tprl1 owner address via the audited Sign core decoder.
 *  Returns { ok, address, hrp, program, reasons[] }. */
export function validateOwnerAddress(raw, networkId = "mainnet") {
  const reasons = [];
  let address = "";
  let hrp = "";
  let program = null;
  try {
    address = String(raw ?? "").trim();
    const d = decodeBech32m(address);
    hrp = d.hrp;
    if (d.version !== 1 || d.program.length !== 32) {
      reasons.push("address is not a v1 32-byte Taproot program");
    } else if (networkId === "mainnet" && hrp !== "prl") {
      reasons.push(`wrong network: expected a prl1… mainnet address, got ${hrp}1…`);
    } else if (networkId === "testnet" && hrp !== "tprl") {
      reasons.push(`wrong network: expected a tprl1… testnet address, got ${hrp}1…`);
    } else {
      program = d.program;
    }
  } catch (e) {
    reasons.push(`invalid address: ${e && e.message ? e.message : e}`);
  }
  return { ok: reasons.length === 0, address, hrp, program, reasons };
}

/* ---------------- prl-name JSON schema ---------------- */

const NAME_OPS = ["claim", "transfer", "release"];
const OP_FIELDS = {
  claim: ["p", "op", "handle", "owner", "ts"],
  transfer: ["p", "op", "handle", "from", "to", "ts"],
  release: ["p", "op", "handle", "from", "ts"],
};

function validTs(ts) {
  return Number.isInteger(ts) && ts >= 0 && ts <= 4102444800; // sane upper bound: 2100-01-01
}

/** Canonical JSON builders — key order fixed so the bytes are deterministic. */
export function buildClaimJson({ handle, owner, ts }) {
  return JSON.stringify({ p: NAME_PROTOCOL, op: "claim", handle, owner, ts });
}
export function buildTransferJson({ handle, from, to, ts }) {
  return JSON.stringify({ p: NAME_PROTOCOL, op: "transfer", handle, from, to, ts });
}
export function buildReleaseJson({ handle, from, ts }) {
  return JSON.stringify({ p: NAME_PROTOCOL, op: "release", handle, from, ts });
}

/** Strict schema validation. Returns { ok, record, reasons[] } where record
 *  is the normalized record { op, handle, owner?, from?, to?, ts }. */
export function validateNameJson(obj, networkId = "mainnet") {
  const reasons = [];
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return { ok: false, record: null, reasons: ["body is not a JSON object"] };
  }
  if (obj.p !== NAME_PROTOCOL) {
    return { ok: false, record: null, reasons: [`protocol marker mismatch: expected p:"${NAME_PROTOCOL}", got ${JSON.stringify(obj.p)}`] };
  }
  const op = obj.op;
  if (!NAME_OPS.includes(op)) {
    return { ok: false, record: null, reasons: [`unknown op ${JSON.stringify(op)}; expected one of claim|transfer|release`] };
  }
  const want = OP_FIELDS[op];
  const got = Object.keys(obj);
  for (const k of got) {
    if (!want.includes(k)) reasons.push(`unexpected field ${JSON.stringify(k)}`);
  }
  for (const k of want) {
    if (!(k in obj)) reasons.push(`missing field ${JSON.stringify(k)}`);
  }
  if (reasons.length > 0) return { ok: false, record: null, reasons };

  const hv = validateHandle(obj.handle);
  if (!hv.ok) reasons.push(...hv.reasons.map((r) => `handle: ${r}`));
  else if (obj.handle !== hv.handle) {
    reasons.push(`handle is not in canonical form: ${JSON.stringify(obj.handle)} — canonical form is ${JSON.stringify(hv.handle)}`);
  }
  if (!validTs(obj.ts)) reasons.push(`ts must be an integer unix timestamp, got ${JSON.stringify(obj.ts)}`);

  const addr = (v, label) => {
    const a = validateOwnerAddress(v, networkId);
    if (!a.ok) reasons.push(...a.reasons.map((r) => `${label}: ${r}`));
    else if (v !== a.address) reasons.push(`${label}: address is not canonical form ${JSON.stringify(a.address)}`);
    return a;
  };
  let owner = null, from = null, to = null;
  if (op === "claim") owner = addr(obj.owner, "owner");
  if (op === "transfer") { from = addr(obj.from, "from"); to = addr(obj.to, "to"); }
  if (op === "release") from = addr(obj.from, "from");

  if (reasons.length > 0) return { ok: false, record: null, reasons };
  const record = { op, handle: hv.handle, ts: obj.ts };
  if (owner) record.owner = owner.address;
  if (from) record.from = from.address;
  if (to) record.to = to.address;
  return { ok: true, record, reasons: [] };
}

/** Parse an inscription content body into a validated name record.
 *  Attaches provenance: inscriptionNumber + inscriptionId. */
export function parseNameRecord(bodyText, inscriptionNumber, inscriptionId, networkId = "mainnet") {
  let obj;
  try {
    obj = JSON.parse(bodyText);
  } catch (e) {
    return { ok: false, record: null, reasons: [`body is not valid JSON: ${e.message}`] };
  }
  const v = validateNameJson(obj, networkId);
  if (!v.ok) return v;
  return {
    ok: true,
    record: { ...v.record, inscriptionNumber, inscriptionId },
    reasons: [],
  };
}

/* ---------------- consensus state machine ---------------- */

/** Create an empty registry state. */
export function newRegistryState() {
  return { entries: {}, order: [] };
}

/** Apply ONE record to the state. First-seen ordering is the caller's job
 *  (buildDirectory sorts by inscriptionNumber ascending). Returns
 *  { accepted, reasons[] }. */
export function applyNameOp(state, rec) {
  const h = rec.handle;
  let entry = state.entries[h] || null;
  const reasons = [];
  const owned = entry && entry.owner !== null;

  if (rec.op === "claim") {
    if (owned) {
      return {
        accepted: false,
        reasons: [`handle "${h}" is already owned by ${entry.owner} (claimed at inscription #${entry.inscriptionNumber}); later claims lose`],
      };
    }
    if (!entry) {
      entry = { handle: h, owner: rec.owner, inscriptionNumber: rec.inscriptionNumber, inscriptionId: rec.inscriptionId, history: [] };
      state.entries[h] = entry;
      state.order.push(h);
    } else {
      // re-claim of a released handle: keep the full history, hand ownership over
      entry.owner = rec.owner;
    }
  } else if (rec.op === "transfer") {
    if (!owned) {
      reasons.push(`transfer rejected: handle "${h}" has no active registration${entry ? " (released)" : ""}`);
      return { accepted: false, reasons };
    }
    if (rec.from !== entry.owner) {
      reasons.push(`transfer rejected: "from" ${rec.from} is not the current owner ${entry.owner}`);
      return { accepted: false, reasons };
    }
    entry.owner = rec.to;
  } else if (rec.op === "release") {
    if (!owned) {
      reasons.push(`release rejected: handle "${h}" has no active registration${entry ? " (already released)" : ""}`);
      return { accepted: false, reasons };
    }
    if (rec.from !== entry.owner) {
      reasons.push(`release rejected: "from" ${rec.from} is not the current owner ${entry.owner}`);
      return { accepted: false, reasons };
    }
    entry.owner = null;
  } else {
    return { accepted: false, reasons: [`unknown op ${JSON.stringify(rec.op)}`] };
  }

  entry.history.push(rec);
  if (rec.op !== "claim") {
    // keep first-seen claim provenance; update latest event pointer
    entry.lastOp = rec.op;
    entry.lastInscriptionNumber = rec.inscriptionNumber;
    entry.lastInscriptionId = rec.inscriptionId;
  }
  return { accepted: true, reasons: [] };
}

/** Build the full directory from raw records: sort by inscriptionNumber
 *  ascending (first-seen wins), apply in order, collect rejections.
 *  Returns { entries, order, accepted, rejected } where rejected is a list
 *  of { record, reasons[] }. */
export function buildDirectory(records) {
  const sorted = [...records].sort((a, b) => {
    const n = Number(a.inscriptionNumber) - Number(b.inscriptionNumber);
    if (n !== 0) return n;
    return String(a.inscriptionId).localeCompare(String(b.inscriptionId));
  });
  const state = newRegistryState();
  const accepted = [];
  const rejected = [];
  for (const rec of sorted) {
    const r = applyNameOp(state, rec);
    if (r.accepted) accepted.push(rec);
    else rejected.push({ record: rec, reasons: r.reasons });
  }
  return { entries: state.entries, order: state.order, accepted, rejected, total: records.length };
}

/** Lookup a handle in a built directory. Returns the entry or null. */
export function lookupHandle(directory, raw) {
  const h = normalizeHandle(raw);
  return directory.entries[h] || null;
}

/* ---------------- inscription envelope (prl-name marker) ---------------- */

/** Decode ASCII bytes to string (marker only — never body). */
function asciiOf(bytes) {
  return String.fromCharCode(...bytes);
}

/** Build the Taproot inscription leaf for a prl-name body.
 *
 *  Reuses the audited buildInscriptionScript (exact Pearlscriptions envelope
 *  shape) and swaps the protocol marker prl-20 -> prl-name under loud
 *  structural assertions — so a future crypto.js change fails loudly instead
 *  of silently engraving the wrong marker. This is envelope framing, not
 *  cryptography: no new crypto is introduced here.
 */
export function buildNameEnvelopeScript(internalXOnly, jsonBytes) {
  const body = jsonBytes instanceof Uint8Array ? jsonBytes : utf8ToBytes(jsonBytes);
  const script = buildInscriptionScript(internalXOnly, body); // marker "prl-20"
  // Structural assertions (mirror etch-core's splitSingleScript):
  if (!(script instanceof Uint8Array) || script.length < 48) throw new Error("bad inscription script");
  if (script[0] !== 0x20) throw new Error("expected 32-byte key push at script start");
  if (script[33] !== 0xac) throw new Error("expected OP_CHECKSIG after key");
  if (script[34] !== 0x00 || script[35] !== 0x63) throw new Error("expected OP_FALSE OP_IF envelope start");
  const markerLen = script[36];
  if (markerLen > 75) throw new Error("expected small data push for protocol marker");
  const marker = asciiOf(script.slice(37, 37 + markerLen));
  if (marker !== "prl-20") throw new Error(`expected prl-20 marker, found ${JSON.stringify(marker)}`);
  if (script[script.length - 1] !== 0x68) throw new Error("expected OP_ENDIF at script end");

  const nm = utf8ToBytes(NAME_MARKER);
  const out = new Uint8Array(script.length - (1 + markerLen) + (1 + nm.length));
  out.set(script.slice(0, 36), 0);
  out[36] = nm.length;
  out.set(nm, 37);
  out.set(script.slice(37 + markerLen), 37 + nm.length);
  return out;
}

/** Extract the protocol marker from an inscription leaf (for the verifier). */
export function extractMarker(scriptBytes) {
  try {
    if (!(scriptBytes instanceof Uint8Array) || scriptBytes.length < 48) return null;
    if (scriptBytes[0] !== 0x20 || scriptBytes[33] !== 0xac) return null;
    if (scriptBytes[34] !== 0x00 || scriptBytes[35] !== 0x63) return null;
    const markerLen = scriptBytes[36];
    if (markerLen > 75) return null;
    return asciiOf(scriptBytes.slice(37, 37 + markerLen));
  } catch {
    return null;
  }
}

/* ---------------- claim planning (fee math) ---------------- */

export const CARRIER_VALUE_GRAINS = 1000; // owner output value, above 546 dust

/** Plan a claim inscription: envelope, reveal script, commit key info, fee
 *  math. Produces a plan object shaped for etch-core's buildRevealTxSigned
 *  ({ network, script, controlBlock, commitProgram, commitValue, ownerOutputs,
 *  feeOutputs, feeRate }). Reuses the audited crypto; adds no new crypto. */
export function planNameClaim({ network, internalXOnly, nameJson, feeRate, changeAddress }) {
  if (!(internalXOnly instanceof Uint8Array) || internalXOnly.length !== 32) throw new Error("bad internal key");
  const rate = Math.max(1, Math.ceil(Number(feeRate)));
  if (!Number.isFinite(rate)) throw new Error("bad fee rate");
  const v = validateNameJson(JSON.parse(nameJson));
  if (!v.ok) throw new Error(`cannot plan: invalid prl-name JSON (${v.reasons.join("; ")})`);
  if (v.record.op !== "claim") throw new Error("planNameClaim only plans claim operations");
  const owner = validateOwnerAddress(v.record.owner, network.id);
  if (!owner.ok) throw new Error(`cannot plan: ${owner.reasons.join("; ")}`);
  const change = validateOwnerAddress(changeAddress, network.id);
  if (!change.ok) throw new Error(`cannot plan: change address ${change.reasons.join("; ")}`);

  const script = buildNameEnvelopeScript(internalXOnly, utf8ToBytes(nameJson));
  const info = commitKeyInfo(network, internalXOnly, script);
  const ownerOutputs = [{ program: owner.program, value: CARRIER_VALUE_GRAINS }];
  const revealFee = revealTxVBytes(script.length, ownerOutputs.length + 1) * rate;
  const commitValue = CARRIER_VALUE_GRAINS + revealFee;

  return {
    network,
    script,
    scriptHex: bytesToHex(script),
    marker: extractMarker(script),
    leafHash: bytesToHex(tapLeafHash(script)),
    merkleRoot: bytesToHex(info.merkleRoot),
    commitAddress: info.commitAddress,
    commitProgram: info.commitXOnly,
    controlBlock: info.controlBlock,
    controlBlockHex: bytesToHex(info.controlBlock),
    ownerOutputs,
    feeOutputs: [],
    revealFee,
    commitValue,
    changeProgram: change.program,
    feeRate: rate,
    nameJson,
  };
}

/** Dust refusal: a commit value below dust can never be revealed. */
export function assertSpendableCommitValue(commitValue) {
  if (commitValue < DUST_GRAIN) {
    throw new Error(`commit value ${commitValue} grains is below dust (${DUST_GRAIN}) — refused`);
  }
}

/* ---------------- indexer query helpers ---------------- */

/** Build /inscriptions query strings (contract: order asc|desc, page, limit<=100). */
export function inscriptionsQuery({ order = "asc", page = 1, limit = INDEXER.pageLimit } = {}) {
  const o = order === "desc" ? "desc" : "asc";
  const p = Math.max(1, Math.floor(Number(page) || 1));
  const l = Math.min(INDEXER.pageLimit, Math.max(1, Math.floor(Number(limit) || INDEXER.pageLimit)));
  return `?order=${o}&page=${p}&limit=${l}`;
}

/** Decide whether a /inscriptions row is a prl-name candidate:
 *  content-type must be application/json. */
export function isNameCandidate(row) {
  const ct = String(row && row.contentType ? row.contentType : "").split(";")[0].trim().toLowerCase();
  return ct === "application/json";
}

/** Cap helper: clamp maxPages into the sane band. */
export function clampMaxPages(n) {
  const v = Math.floor(Number(n) || INDEXER.defaultMaxPages);
  return Math.min(INDEXER.hardMaxPages, Math.max(1, v));
}

/** Format grains -> PRL string (exact, no floats). */
export function formatPRL(grains) {
  const g = BigInt(grains);
  const neg = g < 0n ? "-" : "";
  const a = g < 0n ? -g : g;
  const whole = a / 100_000_000n;
  const frac = (a % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return `${neg}${whole.toString()}${frac ? "." + frac : ""} PRL`;
}

/** Shorten a long identifier for display. */
export function shortId(id, n = 12) {
  const s = String(id ?? "");
  if (s.length <= n * 2 + 3) return s;
  return `${s.slice(0, n)}…${s.slice(-n)}`;
}
