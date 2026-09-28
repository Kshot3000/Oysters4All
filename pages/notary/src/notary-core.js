/* Pearl Notary core — proof-of-existence timestamping on Pearl.
 *
 * Pure ESM, zero build step for developers. The browser ships a committed
 * esbuild IIFE bundle (pearl-notary.bundle.js); node runs this file directly
 * for the verification suite.
 *
 * What this does: hash a document (SHA-256), seal the digest into a
 * Pearlscription-style envelope (marker "prl-notary" — deliberately NOT
 * "prl-20" so PRL-20 indexers never mistake it for a token op), and anchor
 * it on-chain with the audited Taproot commit/reveal machinery. Later, anyone
 * can re-hash the document and compare against the on-chain envelope.
 *
 * Crypto lineage: ALL key derivation, TapTweak, bech32m, BIP-341 sighash and
 * wire serialization come from the audited files/pages/sign/src/crypto.js.
 * Commit/reveal construction and indexer-style witness parsing are re-exported
 * from files/pages/etch/src/etch-core.js (first exercised by its own suite).
 * This file adds only: notary envelope composition + validation, the
 * commit/reveal plan for a single envelope, SHA-256 document hashing, and the
 * verify/certificate helpers. No new crypto.
 *
 * Protocol facts (verified, not from memory):
 *  - Envelope shape (OP_FALSE OP_IF marker ctype empty body… OP_ENDIF):
 *    Pearlscriptions/indexer docs/prl-20-v0-spec.md, mirrored by
 *    crypto.js buildInscriptionScript and etch-core extractEnvelopes.
 *  - Pearl chain params: bech32m HRPs prl/tprl, BIP-86 coin 808276/1,
 *    P2TR dust 546 grains (see hidden_files/pearl-knowledge.md).
 */

import {
  NETWORKS, GRAIN_PER_PRL, DUST_GRAIN,
  tapLeafHash, commitKeyInfo, revealTxVBytes,
  decodeBech32m, bytesToHex, hexToBytes, sha256, schnorr,
  newMnemonic, walletFromMnemonic, walletFromWIF,
  fetchUtxos, fetchFeeRateGrainsPerVByte, broadcastTx,
} from "../../sign/src/crypto.js";
import {
  buildCommitTx, buildRevealTxSigned,
  extractEnvelopes, verifyRevealWitness,
} from "../../etch/src/etch-core.js";
import { utf8ToBytes } from "@noble/hashes/utils";

export {
  NETWORKS, GRAIN_PER_PRL, DUST_GRAIN,
  newMnemonic, walletFromMnemonic, walletFromWIF,
  fetchUtxos, fetchFeeRateGrainsPerVByte, broadcastTx,
  buildCommitTx, buildRevealTxSigned,
  extractEnvelopes, verifyRevealWitness,
  bytesToHex, hexToBytes, sha256, schnorr,
};

/* ---------------- document hashing ---------------- */

/** SHA-256 of a document. Accepts Uint8Array, ArrayBuffer, or string. */
export function hashDocument(data) {
  let bytes;
  if (data instanceof Uint8Array) bytes = data;
  else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
  else if (typeof data === "string") bytes = utf8ToBytes(data);
  else throw new Error("hashDocument needs Uint8Array, ArrayBuffer, or string");
  return bytesToHex(sha256(bytes));
}

/* ---------------- notary envelope composition ---------------- */

export const NOTARY_MARKER = "prl-notary";
export const NOTARY_VERSION = 1;
const MAX_FILENAME = 200, MAX_TITLE = 120, MAX_BY = 80;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

const hasControl = (s) => [...s].some((c) => c < " " || c === "\u007f");

/** Canonical notary record. Throws on any rule violation.
 *  Returns { json, bytes, fields } with fields in canonical order. */
export function composeNotarization({ hash, filename, size, ts, title, by }) {
  if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash))
    throw new Error("hash must be 64 lowercase hex chars (SHA-256)");
  if (typeof filename !== "string" || filename.length === 0 || filename.length > MAX_FILENAME)
    throw new Error(`filename must be 1–${MAX_FILENAME} chars`);
  if (hasControl(filename)) throw new Error("filename must not contain control characters");
  if (!Number.isInteger(size) || size < 0 || size > Number.MAX_SAFE_INTEGER)
    throw new Error("size must be a non-negative integer");
  if (typeof ts !== "string" || !ISO_RE.test(ts)) throw new Error("ts must be UTC ISO-8601 (…Z)");
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) throw new Error("ts does not parse");
  if (t > Date.now() + 86400000) throw new Error("ts is in the future");
  if (t < Date.UTC(2009, 0, 3)) throw new Error("ts predates blockchains");
  if (title !== undefined && title !== null && title !== "") {
    if (typeof title !== "string" || title.length > MAX_TITLE) throw new Error(`title must be ≤ ${MAX_TITLE} chars`);
    if (hasControl(title)) throw new Error("title must not contain control characters");
  }
  if (by !== undefined && by !== null && by !== "") {
    if (typeof by !== "string" || by.length > MAX_BY) throw new Error(`by must be ≤ ${MAX_BY} chars`);
    if (hasControl(by)) throw new Error("by must not contain control characters");
  }
  const fields = { p: "prl-notary", v: NOTARY_VERSION, algo: "sha256", hash, filename, size, ts };
  if (title) fields.title = title;
  if (by) fields.by = by;
  const json = JSON.stringify(fields);
  return { json, bytes: utf8ToBytes(json), fields };
}

/** Strict validation of a parsed envelope body (for the verifier). */
export function validateNotaryRecord(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("record must be an object");
  const keys = Object.keys(obj);
  const allowed = ["p", "v", "algo", "hash", "filename", "size", "ts", "title", "by"];
  for (const k of keys) if (!allowed.includes(k)) throw new Error("unknown field: " + k);
  if (obj.p !== "prl-notary") throw new Error('p must be "prl-notary"');
  if (obj.v !== 1) throw new Error("v must be 1");
  if (obj.algo !== "sha256") throw new Error('algo must be "sha256"');
  // Reuse the composer as the single source of truth for field rules.
  composeNotarization(obj);
  return obj;
}

/* ---------------- envelope script ----------------
 * Same construction as crypto.js buildInscriptionScript, but the envelope
 * marker is "prl-notary" instead of "prl-20". pushData mirrors crypto.js
 * semantics (empty → OP_FALSE) so the indexer-style parser reads it back. */

const OP_CHECKSIG = 0xac, OP_FALSE = 0x00, OP_IF = 0x63, OP_ENDIF = 0x68;

function pushData(data) {
  const b = data instanceof Uint8Array ? data : utf8ToBytes(String(data));
  if (b.length === 0) return [OP_FALSE];
  if (b.length <= 75) return [b.length, ...b];
  if (b.length <= 0xff) return [0x4c, b.length, ...b];
  if (b.length <= 0xffff) return [0x4d, b.length & 0xff, (b.length >> 8) & 0xff, ...b];
  return [0x4e, b.length & 0xff, (b.length >> 8) & 0xff, (b.length >> 16) & 0xff, (b.length >> 24) & 0xff, ...b];
}

/** <key> OP_CHECKSIG OP_FALSE OP_IF "prl-notary" "application/json" <empty>
 *  <body chunks ≤520B> OP_ENDIF */
export function buildNotaryScript(internalXOnly, bodyBytes) {
  if (!(internalXOnly instanceof Uint8Array) || internalXOnly.length !== 32)
    throw new Error("internal key must be 32 bytes");
  const body = bodyBytes instanceof Uint8Array ? bodyBytes : utf8ToBytes(String(bodyBytes));
  if (body.length === 0) throw new Error("empty notary body");
  const script = [
    ...pushData(internalXOnly), OP_CHECKSIG, OP_FALSE, OP_IF,
    ...pushData(utf8ToBytes(NOTARY_MARKER)),
    ...pushData(utf8ToBytes("application/json")),
    ...pushData(new Uint8Array(0)),
  ];
  for (let i = 0; i < body.length; i += 520) script.push(...pushData(body.slice(i, i + 520)));
  script.push(OP_ENDIF);
  return Uint8Array.from(script);
}

/** Decode a user-supplied address to its 32-byte taproot program, enforcing HRP. */
export function addressToProgram(address, network) {
  const d = decodeBech32m(address, network.hrp);
  if (d.version !== 1 || d.program.length !== 32) throw new Error("address is not a v1 taproot address");
  return d.program;
}

/* ---------------- commit/reveal plan ---------------- */

export const CARRIER_VALUE_GRAINS = 1000; // inscribed owner output value (above 546 dust)

/** Plan the notarization: envelope → script → commit key → reveal outputs →
 *  fees. Single-envelope: one owner output carrying the inscription.
 *  Returns a plan shaped exactly like etch-core's planInscription output
 *  (ownerOutputs, feeOutputs: [], script, commitProgram, commitValue,
 *  feeRate, network) so etch-core's buildCommitTx/buildRevealTxSigned apply. */
export function planNotarization({ network, internalXOnly, notary, ownerAddress, changeAddress, feeRate }) {
  if (!(internalXOnly instanceof Uint8Array) || internalXOnly.length !== 32) throw new Error("bad internal key");
  const rate = Math.max(1, Math.ceil(Number(feeRate)));
  if (!Number.isFinite(rate)) throw new Error("bad fee rate");
  const composed = typeof notary === "string" ? { json: notary, bytes: utf8ToBytes(notary) } : notary;
  if (!composed || !(composed.bytes instanceof Uint8Array)) throw new Error("bad notarization");

  const script = buildNotaryScript(internalXOnly, composed.bytes);
  const info = commitKeyInfo(network, internalXOnly, script);
  const ownerProgram = addressToProgram(ownerAddress, network);
  const changeProgram = addressToProgram(changeAddress, network);

  const ownerOutputs = [{ program: ownerProgram, value: CARRIER_VALUE_GRAINS }];
  const feeOutputs = [];
  const outSum = CARRIER_VALUE_GRAINS;
  const revealFee = revealTxVBytes(script.length, ownerOutputs.length + 1) * rate;
  const commitValue = outSum + revealFee;

  return {
    network, envelope: composed, script, scriptHex: bytesToHex(script),
    leafHash: bytesToHex(tapLeafHash(script)),
    merkleRoot: bytesToHex(info.merkleRoot),
    commitAddress: info.commitAddress, commitProgram: info.commitXOnly,
    controlBlock: info.controlBlock, controlBlockHex: bytesToHex(info.controlBlock),
    ownerOutputs, feeOutputs,
    revealFee, commitValue, changeProgram, feeRate: rate,
  };
}

/* ---------------- verification ---------------- */

/** Parse a reveal tx's witness, find the prl-notary envelope, and check the
 *  document hash against it. revealHex: serialized reveal tx.
 *  Returns { record, hash, match, marker }. Throws if no notary envelope. */
export function verifyNotarizationWitness(revealHex, documentBytes) {
  const envs = verifyRevealWitness(revealHex);
  const env = envs.find((e) => e.marker === NOTARY_MARKER);
  if (!env) throw new Error("no prl-notary envelope in this reveal");
  const record = validateNotaryRecord(env.parsed);
  const hash = hashDocument(documentBytes);
  return { record, hash, match: hash === record.hash, marker: env.marker };
}

/** Fetch a reveal tx from blockbook and verify the document against it.
 *  Returns { record, hash, match, txid, blockHeight, blockTime }. */
export async function verifyNotarizationOnChain(blockbookUrl, revealTxid, documentBytes) {
  if (!/^[0-9a-f]{64}$/i.test(revealTxid || "")) throw new Error("bad reveal txid");
  const base = String(blockbookUrl).replace(/\/+$/, "");
  const r = await fetch(`${base}/api/v2/tx/${revealTxid.toLowerCase()}`);
  if (!r.ok) throw new Error(`blockbook tx lookup failed: HTTP ${r.status}`);
  const tx = await r.json();
  if (!tx.hex) throw new Error("blockbook did not return raw tx hex");
  const v = verifyNotarizationWitness(tx.hex, documentBytes);
  return { ...v, txid: tx.txid, blockHeight: tx.blockHeight ?? null, blockTime: tx.blockTime ?? null, confirmations: tx.confirmations ?? 0 };
}

/* ---------------- seal certificate ---------------- */

/** Build the human-readable seal certificate object (JSON-serializable). */
export function buildSealCertificate({ plan, commitTxid, revealTxid, blockHeight, blockTime }) {
  const rec = plan.envelope.fields || validateNotaryRecord(JSON.parse(plan.envelope.json));
  return {
    app: "Pearl Notary",
    network: plan.network.label,
    record: rec,
    envelope: { marker: NOTARY_MARKER, contentType: "application/json", leafHash: plan.leafHash, merkleRoot: plan.merkleRoot },
    commit: { txid: commitTxid, address: plan.commitAddress },
    reveal: { txid: revealTxid, blockHeight: blockHeight ?? null, blockTime: blockTime ?? null },
    verify: "Re-hash the document with SHA-256 and compare to record.hash; fetch the reveal tx and check the prl-notary envelope.",
    issuedAt: new Date().toISOString(),
  };
}
