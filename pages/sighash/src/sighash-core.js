/* Pearl Sighash Studio — BIP-341/BIP-342 Taproot sighash digest core.
 *
 * Pure ESM, zero build step for the logic itself (bundled for the browser via
 * build.mjs). Implements the full BIP-341 "Common signature message" plus the
 * BIP-342 tapscript extension, exposing every intermediate hash for the
 * "digest anatomy" walkthrough.
 *
 * Spec lineage (verified against the actual BIP texts, not from memory):
 *  - BIP-341 "Common signature message": epoch(0x00) || hash_type || nVersion ||
 *    nLockTime || [sha_prevouts || sha_amounts || sha_scriptpubkeys ||
 *    sha_sequences] (omitted — not zeroed — under ANYONECANPAY) ||
 *    [sha_outputs | sha_single_output] || spend_type || (outpoint || amount ||
 *    spk || nSequence  [ACP]  |  input_index) || [sha_annex]  (+ BIP-342 ext:
 *    tapleaf_hash || key_version || codesep_pos)
 *  - sha_annex = SHA256(compact_size(len(annex)) || annex), annex keeps its
 *    mandatory 0x50 prefix (BIP-341 § Common signature message).
 *  - Final digest = taggedHash("TapSighash", 0x00 || SigMsg || ext).
 *  - The 7 valid hash_type bytes: 0x00, 0x01, 0x02, 0x03, 0x81, 0x82, 0x83.
 *  - SIGHASH_SINGLE with input index >= nOutputs is a consensus failure.
 *  - A 65-byte signature may not carry hash_type 0x00 (malleation rule);
 *    64-byte signatures imply SIGHASH_DEFAULT.
 *
 * External pins (see src/vectors-bip341.js, src/vectors-bip340.js):
 *  - bitcoin/bips bip-0341/wallet-test-vectors.json keyPathSpending[0]:
 *    all 7 hash types, byte-exact sigMsg preimages + sigHash digests.
 *  - bitcoin/bips bip-0340/test-vectors.csv: all 19 Schnorr vectors.
 *
 * Honest scope: this is an educational reference implementation of the
 * digest math. It is NOT consensus code and makes no claim of interop
 * with pearld — it is pinned against the published BIP vectors instead.
 */

import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1";

export const VERSION = 1;
export const SEAL_DOMAIN = "pearl-sighash:v1";
export const GRAIN_PER_PRL = 100_000_000n;
export const MAX_GRAINS = 21_000_000n * GRAIN_PER_PRL;
export const ATTRIBUTION = {
  x: "@kshot9000",
  xUrl: "https://x.com/kshot9000",
  prl: "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d",
};

/* ---------------- sighash flag table ---------------- */

export const SIGHASH_FLAGS = Object.freeze({
  0x00: { name: "DEFAULT", label: "SIGHASH_DEFAULT · 0x00", acp: false, base: "ALL",
    blurb: "The default: commits to every input and every output. A 64-byte (sighash-byte-less) signature implies this mode." },
  0x01: { name: "ALL", label: "SIGHASH_ALL · 0x01", acp: false, base: "ALL",
    blurb: "Commits to every input (outpoints, amounts, scripts, sequences) and every output. Identical coverage to DEFAULT; only the hash_type byte differs." },
  0x02: { name: "NONE", label: "SIGHASH_NONE · 0x02", acp: false, base: "NONE",
    blurb: "Commits to every input but to NO outputs — sha_outputs is omitted entirely. Anyone can attach any outputs later." },
  0x03: { name: "SINGLE", label: "SIGHASH_SINGLE · 0x03", acp: false, base: "SINGLE",
    blurb: "Commits to every input but only the single output at the input's own index (sha_single_output). Invalid when that output does not exist." },
  0x81: { name: "ALL|ANYONECANPAY", label: "SIGHASH_ALL | ANYONECANPAY · 0x81", acp: true, base: "ALL",
    blurb: "Commits to all outputs, but only THIS input: the four all-input hashes are replaced by this input's outpoint, amount, scriptPubKey and sequence." },
  0x82: { name: "NONE|ANYONECANPAY", label: "SIGHASH_NONE | ANYONECANPAY · 0x82", acp: true, base: "NONE",
    blurb: "Commits to this input alone and to no outputs — the minimal commitment. Crowdfunding-friendly: others may add inputs and outputs freely." },
  0x83: { name: "SINGLE|ANYONECANPAY", label: "SIGHASH_SINGLE | ANYONECANPAY · 0x83", acp: true, base: "SINGLE",
    blurb: "Commits to this input plus only the output at its index. The atomic-swap presign workhorse (see Pearl Bond's transfer legs)." },
});
export const VALID_HASH_TYPES = Object.freeze(Object.keys(SIGHASH_FLAGS).map(Number));

export function flagInfo(hashType) {
  const f = SIGHASH_FLAGS[hashType];
  if (!f) throw new Error(`unknown hash_type 0x${Number(hashType).toString(16).padStart(2, "0")} — valid: 00 01 02 03 81 82 83`);
  return f;
}

/* ---------------- byte helpers ---------------- */

export function u32le(n) {
  n = BigInt(n);
  const b = new Uint8Array(4);
  for (let i = 0; i < 4; i++) b[i] = Number((n >> BigInt(8 * i)) & 0xffn);
  return b;
}
export function u64le(n) {
  n = BigInt(n);
  const b = new Uint8Array(8);
  for (let i = 0; i < 8; i++) b[i] = Number((n >> BigInt(8 * i)) & 0xffn);
  return b;
}
export function varint(n) {
  n = BigInt(n);
  if (n < 0xfdn) return Uint8Array.of(Number(n));
  if (n <= 0xffffn) return Uint8Array.of(0xfd, Number(n & 0xffn), Number((n >> 8n) & 0xffn));
  if (n <= 0xffffffffn) { const b = Uint8Array.of(0xfe, 0, 0, 0, 0); const l = u32le(n); b.set(l, 1); return b; }
  const b = Uint8Array.of(0xff, 0, 0, 0, 0, 0, 0, 0, 0); b.set(u64le(n), 1); return b;
}
export function concat(...parts) {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
/** BIP-340 tagged hash: SHA256(SHA256(tag)||SHA256(tag)||data). */
export function taggedHash(tag, data) {
  const tagHash = sha256(new TextEncoder().encode(tag));
  return sha256(concat(tagHash, tagHash, data));
}
export function parseHex(hex, what, exactLen = null) {
  if (typeof hex !== "string" || !/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0)
    throw new Error(`bad ${what}: not hex`);
  const b = hexToBytes(hex.toLowerCase());
  if (exactLen !== null && b.length !== exactLen)
    throw new Error(`bad ${what}: need ${exactLen} bytes, got ${b.length}`);
  return b;
}
export function parseGrains(v, what) {
  let g;
  try { g = BigInt(String(v).trim()); } catch { throw new Error(`bad ${what}: not an integer number of grains`); }
  if (g < 0n) throw new Error(`bad ${what}: negative amount`);
  if (g > MAX_GRAINS) throw new Error(`bad ${what}: exceeds 21M PRL money supply`);
  return g;
}
/** txid in display (big-endian) hex -> little-endian bytes for the outpoint. */
export function txidToLE(txidHex) {
  const b = parseHex(txidHex, "txid", 32);
  return Uint8Array.from(b).reverse();
}
export function grainsToPRL(g) {
  g = BigInt(g);
  const whole = g / GRAIN_PER_PRL, frac = g % GRAIN_PER_PRL;
  return whole.toString() + "." + frac.toString().padStart(8, "0");
}

/* ---------------- scenario normalization ---------------- */

function normInput(inp, i) {
  if (typeof inp !== "object" || inp === null) throw new Error(`input ${i}: not an object`);
  const txid = String(inp.txid || "");
  const txidLE = txidToLE(txid);
  const vout = BigInt(inp.vout ?? 0);
  if (vout < 0n || vout > 0xffffffffn) throw new Error(`input ${i}: bad vout`);
  const value = parseGrains(inp.valueGrains ?? inp.value ?? 0, `input ${i} amount`);
  const spk = parseHex(String(inp.spk || ""), `input ${i} scriptPubKey`);
  if (spk.length === 0 || spk.length > 10000) throw new Error(`input ${i}: scriptPubKey length out of range`);
  const sequence = BigInt(inp.sequence ?? 0xffffffff);
  if (sequence < 0n || sequence > 0xffffffffn) throw new Error(`input ${i}: bad sequence`);
  return { txid, txidLE, vout, value, spk, sequence };
}
function normOutput(out, i) {
  if (typeof out !== "object" || out === null) throw new Error(`output ${i}: not an object`);
  const value = parseGrains(out.valueGrains ?? out.value ?? 0, `output ${i} amount`);
  const spk = parseHex(String(out.spk || ""), `output ${i} scriptPubKey`);
  if (spk.length === 0 || spk.length > 10000) throw new Error(`output ${i}: scriptPubKey length out of range`);
  return { value, spk };
}
function serOutpoint(inp) { return concat(inp.txidLE, u32le(inp.vout)); }
function serCTxOut(out) { return concat(u64le(out.value), varint(out.spk.length), out.spk); }

/* ---------------- the digest, with full anatomy ----------------
 *
 * params:
 *   version, locktime (numbers), inputs[], outputs[] (see normInput/normOutput),
 *   inputIndex, hashType (one of the 7),
 *   spend: { scriptPath: false } |
 *          { scriptPath: true, leafScript: <hex>, keyVersion: 0x00, codeseedPos: 0xffffffff|n }
 *   annex: <hex, 0x50-prefixed> | null
 *
 * Returns { digestHex, preimageHex, hashType, spendType, intermediates[] }.
 * Each intermediate: { id, label, present, preimageHex, method, valueHex, note }
 *   method: "raw" | "sha256" | "tagged" | "omitted"
 */
export function tapSighashAnatomy(params) {
  const version = BigInt(params.version ?? 2);
  const locktime = BigInt(params.locktime ?? 0);
  if (version < 0n || version > 0xffffffffn) throw new Error("bad nVersion");
  if (locktime < 0n || locktime > 0xffffffffn) throw new Error("bad nLockTime");
  const inputs = (params.inputs || []).map(normInput);
  const outputs = (params.outputs || []).map(normOutput);
  if (inputs.length === 0) throw new Error("need at least one input");
  const inputIndex = Number(params.inputIndex ?? 0);
  if (!Number.isInteger(inputIndex) || inputIndex < 0 || inputIndex >= inputs.length)
    throw new Error(`bad input index ${params.inputIndex}`);
  const hashType = Number(params.hashType ?? 0x00);
  const flag = flagInfo(hashType);
  const acp = flag.acp, base = flag.base;

  const spend = params.spend || { scriptPath: false };
  const extFlag = spend.scriptPath ? 1 : 0;
  let leafScript = null, leafHash = null, keyVersion = 0x00, codeseedPos = 0xffffffff;
  if (extFlag) {
    leafScript = parseHex(String(spend.leafScript || ""), "tapleaf script");
    if (leafScript.length === 0 || leafScript.length > 10000) throw new Error("bad tapleaf script length");
    leafHash = taggedHash("TapLeaf", concat(Uint8Array.of(0xc0), varint(leafScript.length), leafScript));
    keyVersion = Number(spend.keyVersion ?? 0x00);
    if (!Number.isInteger(keyVersion) || keyVersion < 0 || keyVersion > 255) throw new Error("bad key version");
    codeseedPos = BigInt(spend.codeseedPos ?? 0xffffffff);
    if (codeseedPos < 0n || codeseedPos > 0xffffffffn) throw new Error("bad codeseed position");
  }

  let annex = null;
  if (params.annex != null && String(params.annex).trim() !== "") {
    annex = parseHex(String(params.annex).trim(), "annex");
    if (annex[0] !== 0x50) throw new Error("bad annex: must carry the mandatory 0x50 prefix");
  }
  const annexPresent = annex ? 1 : 0;

  if (base === "SINGLE" && inputIndex >= outputs.length) {
    throw new Error(
      `SIGHASH_SINGLE refused: input index ${inputIndex} has no corresponding output ` +
      `(transaction has ${outputs.length} output${outputs.length === 1 ? "" : "s"}) — consensus would fail this signature`);
  }

  const intermediates = [];
  const msg = [];
  const pushRaw = (id, label, bytes, note = "") => {
    intermediates.push({ id, label, present: true, preimageHex: bytesToHex(bytes), method: "raw", valueHex: bytesToHex(bytes), note });
    msg.push(bytes);
  };
  const pushHash = (id, label, preimage, note = "") => {
    const h = sha256(preimage);
    intermediates.push({ id, label, present: true, preimageHex: bytesToHex(preimage), method: "sha256", valueHex: bytesToHex(h), note });
    msg.push(h);
    return h;
  };
  const pushOmitted = (id, label, note) => {
    intermediates.push({ id, label, present: false, preimageHex: "", method: "omitted", valueHex: "", note });
  };

  /* Control */
  pushRaw("epoch", "epoch", Uint8Array.of(0x00), "Sighash epoch — the TapSighash tagged hash is namespaced for future signature algorithms.");
  pushRaw("hash_type", "hash_type", Uint8Array.of(hashType), `${flag.name}: ${flag.blurb}`);

  /* Transaction data */
  pushRaw("nVersion", "nVersion", u32le(version), "Transaction version, 4 bytes little-endian.");
  pushRaw("nLockTime", "nLockTime", u32le(locktime), "Transaction lock time, 4 bytes little-endian.");

  if (!acp) {
    pushHash("sha_prevouts", "sha_prevouts",
      concat(...inputs.map(serOutpoint)),
      `SHA256 over all ${inputs.length} outpoints (txid LE || vout LE). Commits to exactly which coins are spent.`);
    pushHash("sha_amounts", "sha_amounts",
      concat(...inputs.map((i) => u64le(i.value))),
      `SHA256 over all ${inputs.length} input amounts (8-byte LE grains). Offline signers verify the fee from this.`);
    pushHash("sha_scriptpubkeys", "sha_scriptpubkeys",
      concat(...inputs.map((i) => concat(varint(i.spk.length), i.spk))),
      `SHA256 over all spent scriptPubKeys (varint length + script, CTxOut style).`);
    pushHash("sha_sequences", "sha_sequences",
      concat(...inputs.map((i) => u32le(i.sequence))),
      `SHA256 over all ${inputs.length} nSequence values (4-byte LE).`);
  } else {
    const why = "ANYONECANPAY drops the four all-input hashes — other inputs may be added or removed freely.";
    pushOmitted("sha_prevouts", "sha_prevouts", why);
    pushOmitted("sha_amounts", "sha_amounts", why);
    pushOmitted("sha_scriptpubkeys", "sha_scriptpubkeys", why);
    pushOmitted("sha_sequences", "sha_sequences", why);
  }

  if (base === "NONE") {
    pushOmitted("sha_outputs", "sha_outputs", "SIGHASH_NONE commits to no outputs — sha_outputs is omitted, not zeroed.");
  } else if (base === "SINGLE") {
    pushOmitted("sha_outputs", "sha_outputs", "SIGHASH_SINGLE replaces sha_outputs with sha_single_output (hashed later, under \u201cdata about this output\u201d).");
  } else {
    pushHash("sha_outputs", "sha_outputs",
      concat(...outputs.map(serCTxOut)),
      `SHA256 over all ${outputs.length} outputs in CTxOut format (amount LE || varint script len || script).`);
  }

  /* Data about this input */
  const spendType = extFlag * 2 + annexPresent;
  pushRaw("spend_type", "spend_type", Uint8Array.of(spendType),
    `ext_flag (${extFlag}) × 2 + annex_present (${annexPresent}) = ${spendType} — ` +
    (extFlag ? "script-path spend (BIP-342 extension follows)." : "key-path spend, no extension.") +
    (annexPresent ? " Annex present: sha_annex follows." : ""));
  const me = inputs[inputIndex];
  if (acp) {
    const single = concat(serOutpoint(me), u64le(me.value), varint(me.spk.length), me.spk, u32le(me.sequence));
    pushRaw("input_data", "this input (outpoint || amount || scriptPubKey || nSequence)", single,
      "ANYONECANPAY: only the input being signed is committed — outpoint (36) || amount (8) || varint-prefixed scriptPubKey || nSequence (4).");
  } else {
    pushRaw("input_data", "input_index", u32le(inputIndex),
      "The signed input is identified by its index; its outpoint/amount/script are already committed via the four all-input hashes.");
  }
  if (annexPresent) {
    const annexPre = concat(varint(annex.length), annex);
    const h = sha256(annexPre);
    intermediates.push({ id: "sha_annex", label: "sha_annex", present: true,
      preimageHex: bytesToHex(annexPre), method: "sha256", valueHex: bytesToHex(h),
      note: "SHA256 of (compact_size(len) || annex) — the length prefix IS hashed (BIP-341). The annex keeps its mandatory 0x50 prefix." });
    msg.push(h);
  } else {
    pushOmitted("sha_annex", "sha_annex", "No annex: annex_present = 0, nothing appended.");
  }

  /* BIP-342 extension */
  if (extFlag) {
    const leafPre = concat(Uint8Array.of(0xc0), varint(leafScript.length), leafScript);
    intermediates.push({ id: "tapleaf_hash", label: "tapleaf_hash", present: true,
      preimageHex: bytesToHex(leafPre),
      method: "tagged", valueHex: bytesToHex(leafHash),
      note: "taggedHash(\"TapLeaf\", 0xc0 || compact_size(script len) || leaf script) — the leaf version byte 0xc0 commits to tapscript semantics." });
    const ext = concat(leafHash, Uint8Array.of(keyVersion), u32le(codeseedPos));
    pushRaw("ext", "tapscript extension (tapleaf_hash || key_version || codesep_pos)", ext,
      `BIP-342 extension: 32-byte leaf hash || key_version 0x${keyVersion.toString(16).padStart(2, "0")} || codesep_pos ` +
      (codeseedPos === 0xffffffffn ? "0xffffffff (no OP_CODESEPARATOR executed)." : `${codeseedPos} LE.`));
  } else {
    pushOmitted("tapscript_ext", "tapscript extension", "Key-path spend: ext_flag = 0, no extension bytes.");
  }

  /* Data about this output (BIP-341: after the input data, before the digest) */
  if (base === "SINGLE") {
    pushHash("sha_single_output", "sha_single_output",
      serCTxOut(outputs[inputIndex]),
      `SHA256 of the single CTxOut at the input's own index (${inputIndex}): amount LE || varint script len || script. ` +
      `Note its position: after the input data, not with the other output hashes.`);
  } else {
    pushOmitted("sha_single_output", "sha_single_output",
      base === "NONE" ? "n/a under SIGHASH_NONE (no outputs committed)." : "n/a outside SIGHASH_SINGLE.");
  }

  const preimage = concat(...msg);
  const digest = taggedHash("TapSighash", preimage);
  intermediates.push({ id: "digest", label: "digest = taggedHash(\"TapSighash\", preimage)", present: true,
    preimageHex: bytesToHex(preimage), method: "tagged", valueHex: bytesToHex(digest),
    note: "BIP-340 tagged hash: SHA256(SHA256(\"TapSighash\") || SHA256(\"TapSighash\") || preimage). This 32-byte digest is what the Schnorr signature covers." });

  return {
    digestHex: bytesToHex(digest),
    preimageHex: bytesToHex(preimage),
    preimageLen: preimage.length,
    hashType, flagName: flag.name, spendType, annexPresent: !!annexPresent,
    intermediates,
  };
}

/* ---------------- compare mode ----------------
 *
 * compareFlags(params, flagA, flagB): run the digest under two hash types and
 * diff every intermediate. The educational centerpiece: shows exactly which
 * components differ, which are dropped, and why.
 */
const WHY = {
  inputHashes: "ANYONECANPAY drops the four all-input hashes — they are replaced by this input's own outpoint, amount, scriptPubKey and sequence.",
  noOutputs: "SIGHASH_NONE commits to no outputs — sha_outputs is omitted entirely, not zeroed.",
  singleOutput: "SIGHASH_SINGLE replaces sha_outputs with sha_single_output: only the CTxOut at the input's own index is committed.",
  same: "Identical — this flag pair does not touch this component.",
  hashTypeByte: "The hash_type byte itself differs, so the tagged digests can never collide even when coverage is identical (DEFAULT vs ALL).",
  ext: "The BIP-342 script-path extension (tapleaf hash + key version + codesep position) is part of the preimage only for script-path spends.",
};

export function compareFlags(params, flagA, flagB) {
  const a = tapSighashAnatomy({ ...params, hashType: flagA });
  const b = tapSighashAnatomy({ ...params, hashType: flagB });
  const infoA = flagInfo(flagA), infoB = flagInfo(flagB);
  const rows = [];
  const byId = (r, id) => r.intermediates.find((x) => x.id === id);
  const ids = ["epoch", "hash_type", "nVersion", "nLockTime",
    "sha_prevouts", "sha_amounts", "sha_scriptpubkeys", "sha_sequences",
    "sha_outputs",
    "spend_type", "input_data", "sha_annex", "tapscript_ext",
    "sha_single_output", "digest"];
  for (const id of ids) {
    const x = byId(a, id), y = byId(b, id);
    if (!x || !y) continue;
    const same = x.present === y.present && x.valueHex === y.valueHex;
    let why = WHY.same;
    if (!same) {
      if (id === "hash_type") why = WHY.hashTypeByte;
      else if (["sha_prevouts", "sha_amounts", "sha_scriptpubkeys", "sha_sequences"].includes(id)) why = WHY.inputHashes;
      else if (id === "sha_outputs" || id === "sha_single_output") {
        why = (infoA.base === "NONE" || infoB.base === "NONE") ? WHY.noOutputs : WHY.singleOutput;
      } else if (id === "input_data") why = WHY.inputHashes;
      else if (id === "tapscript_ext") why = WHY.ext;
      else if (id === "digest") why = "The tagged TapSighash digest commits to the whole preimage — any differing byte above changes it.";
    }
    rows.push({ id, label: x.label, aPresent: x.present, bPresent: y.present,
      aValue: x.valueHex || (x.present ? "" : "— omitted —"),
      bValue: y.valueHex || (y.present ? "" : "— omitted —"),
      same, why, aPreimage: x.preimageHex, bPreimage: y.preimageHex });
  }
  return { flagA: infoA, flagB: infoB, digestA: a.digestHex, digestB: b.digestHex,
    digestsEqual: a.digestHex === b.digestHex, rows };
}

/** 7×7 matrix of digest equality for a fixed scenario (used by tests + UI). */
export function flagDigestMatrix(params) {
  const digests = {};
  for (const ht of VALID_HASH_TYPES) digests[ht] = tapSighashAnatomy({ ...params, hashType: ht }).digestHex;
  return digests;
}

/* ---------------- BIP-340 sign / verify ---------------- */

export function bip340Sign(msgHex, privHex, auxHex = "00".repeat(32)) {
  const msg = parseHex(msgHex, "message");
  const priv = parseHex(privHex, "private key", 32);
  const aux = parseHex(auxHex, "aux randomness", 32);
  if (!secp256k1.utils.isValidSecretKey(priv)) throw new Error("bad private key: not in 1..n-1");
  return bytesToHex(schnorr.sign(msg, priv, aux));
}
export function bip340Verify(msgHex, sigHex, pubHex) {
  let msg, sig, pub;
  try {
    msg = parseHex(msgHex, "message");
    sig = parseHex(sigHex, "signature", 64);
    pub = parseHex(pubHex, "public key", 32);
  } catch { return false; }
  try { return schnorr.verify(sig, msg, pub); } catch { return false; }
}
export function bip340Pubkey(privHex) {
  const priv = parseHex(privHex, "private key", 32);
  if (!secp256k1.utils.isValidSecretKey(priv)) throw new Error("bad private key: not in 1..n-1");
  return bytesToHex(schnorr.getPublicKey(priv));
}
export function randomPrivkey() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return bytesToHex(b);
}

/* ---------------- unsigned-tx parser ---------------- */

function readVarint(bytes, off) {
  const first = bytes[off];
  if (first < 0xfd) return { value: BigInt(first), size: 1 };
  if (first === 0xfd) return { value: BigInt(bytes[off + 1] | (bytes[off + 2] << 8)), size: 3 };
  if (first === 0xfe) {
    const v = new DataView(bytes.buffer, bytes.byteOffset + off + 1, 4).getUint32(0, true);
    return { value: BigInt(v), size: 5 };
  }
  const v = new DataView(bytes.buffer, bytes.byteOffset + off + 1, 8).getBigUint64(0, true);
  return { value: v, size: 9 };
}
function readU32(bytes, off) { return new DataView(bytes.buffer, bytes.byteOffset + off, 4).getUint32(0, true); }
function readU64(bytes, off) { return new DataView(bytes.buffer, bytes.byteOffset + off, 8).getBigUint64(0, true); }

/** Parse a legacy-format unsigned tx (no witness) into { version, locktime, inputs[], outputs[] }. */
export function parseUnsignedTx(hex) {
  const bytes = parseHex(hex, "transaction hex");
  let off = 0;
  const need = (n, what) => { if (off + n > bytes.length) throw new Error(`truncated tx at ${what}`); };
  need(4, "version"); const version = readU32(bytes, off); off += 4;
  need(1, "input count"); const nIn = readVarint(bytes, off); off += nIn.size;
  if (nIn.value > 100000n) throw new Error("absurd input count");
  const inputs = [];
  for (let i = 0; i < Number(nIn.value); i++) {
    need(36, `input ${i} outpoint`);
    const txidLE = bytes.slice(off, off + 32); off += 32;
    const vout = readU32(bytes, off); off += 4;
    need(1, `input ${i} script len`); const sl = readVarint(bytes, off); off += sl.size;
    need(Number(sl.value), `input ${i} scriptSig`); off += Number(sl.value);
    need(4, `input ${i} sequence`); const sequence = readU32(bytes, off); off += 4;
    inputs.push({ txid: bytesToHex(Uint8Array.from(txidLE).reverse()), vout, sequence });
  }
  need(1, "output count"); const nOut = readVarint(bytes, off); off += nOut.size;
  if (nOut.value > 100000n) throw new Error("absurd output count");
  const outputs = [];
  for (let i = 0; i < Number(nOut.value); i++) {
    need(8, `output ${i} value`); const value = readU64(bytes, off); off += 8;
    need(1, `output ${i} script len`); const sl = readVarint(bytes, off); off += sl.size;
    need(Number(sl.value), `output ${i} script`); const spk = bytes.slice(off, off + Number(sl.value)); off += Number(sl.value);
    outputs.push({ valueGrains: value.toString(), spk: bytesToHex(spk) });
  }
  need(4, "locktime"); const locktime = readU32(bytes, off); off += 4;
  return { version, locktime, inputs, outputs };
}

/* ---------------- sealed descriptors ---------------- */

/** Seal a full parameter set: canonical JSON + sha256 fingerprint. */
export function sealScenario(params) {
  const canon = {
    domain: SEAL_DOMAIN,
    version: params.version ?? 2,
    locktime: params.locktime ?? 0,
    inputs: params.inputs,
    outputs: params.outputs,
    inputIndex: params.inputIndex ?? 0,
    hashType: params.hashType ?? 0x00,
    spend: params.spend || { scriptPath: false },
    annex: params.annex || null,
  };
  const body = JSON.stringify(canon);
  const anatomy = tapSighashAnatomy(canon); // throws loudly on bad params — sealing garbage is refused
  const fingerprint = bytesToHex(sha256(new TextEncoder().encode(body)));
  return { sealed: JSON.stringify({ ...canon, digest: anatomy.digestHex, fingerprint }, null, 1), ...canon, digest: anatomy.digestHex, fingerprint };
}

/** Verify a sealed descriptor (or any pasted full parameter set).
 *  Returns { verdict: "PROVEN" | "NOT PROVEN" | "UNSEALED", errors[], digest, fingerprint, checks[] }.
 *  A raw parameter set without a seal is UNSEALED: the digest is recomputed and
 *  shown, but nothing is claimed about it. */
export function verifySealed(input) {
  let obj;
  try { obj = typeof input === "string" ? JSON.parse(input) : input; }
  catch { return { verdict: "NOT PROVEN", proven: false, errors: ["not valid JSON"], digest: null, fingerprint: null, checks: [] }; }
  if (typeof obj !== "object" || obj === null) return { verdict: "NOT PROVEN", proven: false, errors: ["not an object"], digest: null, fingerprint: null, checks: [] };
  const errors = [];
  const sealed = obj.domain === SEAL_DOMAIN;
  const checks = [{ name: "seal domain pearl-sighash:v1", ok: sealed,
    detail: sealed ? "descriptor claims a seal" : "no seal — raw parameter set" }];
  let recomputed = null;
  try { recomputed = tapSighashAnatomy(obj); }
  catch (e) { errors.push("recomputation failed: " + e.message); }
  if (recomputed && sealed) {
    const { digest: _d, fingerprint: _f, ...canon } = obj;
    const want = obj.fingerprint
      ? bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(canon))))
      : null;
    if (obj.digest && String(obj.digest).toLowerCase() !== recomputed.digestHex)
      errors.push(`digest mismatch — tampered: sealed ${String(obj.digest).slice(0, 16)}… vs recomputed ${recomputed.digestHex.slice(0, 16)}…`);
    if (want) {
      if (want !== String(obj.fingerprint).toLowerCase()) errors.push("fingerprint mismatch — parameters were altered after sealing");
    } else {
      errors.push("sealed descriptor is missing its fingerprint");
    }
    const fpOk = !!want && want === String(obj.fingerprint).toLowerCase();
    const digestOk = !obj.digest || String(obj.digest).toLowerCase() === recomputed.digestHex;
    checks.push({ name: "fingerprint binds all parameters", ok: fpOk,
      detail: fpOk ? "sha256 of the canonical parameter JSON matches" : "fingerprint does not cover the pasted parameters" });
    checks.push({ name: "sealed digest matches recomputation", ok: digestOk,
      detail: digestOk ? recomputed.digestHex.slice(0, 32) + "…" : "recomputed digest differs — data was tampered with" });
  }
  const verdict = !sealed ? "UNSEALED" : (errors.length === 0 ? "PROVEN" : "NOT PROVEN");
  if (!sealed) errors.push("no seal domain — pasted a raw parameter set; digest recomputed for reference only");
  return { verdict, proven: verdict === "PROVEN", errors,
    digest: recomputed ? recomputed.digestHex : null,
    fingerprint: obj.fingerprint || null, checks };
}

/* ---------------- demo scenario ---------------- */

const DEMO_XONLY_A = "d6889cb081036e0faefa3a35157ad71086b123b2b144b649798b494c300a961d"; // BIP-341 vector internal key (demo bytes)
const DEMO_XONLY_B = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"; // secp256k1 G x-coord (demo bytes)
export function p2trSpk(xonlyHex) { return "5120" + xonlyHex.toLowerCase(); }

/** A small honest 2-in/2-out demo scenario (clearly labeled demo in the UI). */
export function demoScenario() {
  return {
    version: 2, locktime: 0,
    inputs: [
      { txid: "a".repeat(64), vout: 0, valueGrains: "500000000", spk: p2trSpk(DEMO_XONLY_A), sequence: 0xfffffffd },
      { txid: "b".repeat(64), vout: 1, valueGrains: "250000000", spk: p2trSpk(DEMO_XONLY_B), sequence: 0xffffffff },
    ],
    outputs: [
      { valueGrains: "600000000", spk: p2trSpk(DEMO_XONLY_B) },
      { valueGrains: "149990000", spk: p2trSpk(DEMO_XONLY_A) },
    ],
    inputIndex: 0,
    hashType: 0x00,
    spend: { scriptPath: false },
    annex: null,
  };
}

export { sha256, bytesToHex, hexToBytes };
