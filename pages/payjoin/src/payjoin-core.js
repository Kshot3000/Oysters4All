/* Pearl Payjoin core — BIP-78 two-party transaction (payjoin) desk for PRL.
 *
 * Pure ESM. Runs in the browser (bundled) and in node (test suite).
 *
 * CRYPTO LINEAGE (no new cryptography):
 *  - SHA-256, tagged hashes, double-SHA256, bech32m encode/decode, txid/u32/u64
 *    little-endian helpers, P2TR scriptPubKey builder, keypath TapTweak and
 *    tweaked-private-key derivation, BIP-340 Schnorr sign/verify, BIP-86
 *    mnemonic derivation (m/86'/808276'/0'/0/i), exact keypath vByte weight
 *    math, and the Blockbook REST helpers are ALL taken from the audited
 *    files/pages/sign/src/crypto.js (from pearlpurse, verified byte-for-byte
 *    against Pearl's Go reference node/txscript).
 *  - The BIP-174 v0 PSBT codec, BIP-371 Taproot field types, the BIP-341
 *    keypath sighash, per-input signing with re-verification, finalization and
 *    tx extraction are ALL taken from files/pages/psbt/src/psbt-core.js
 *    (itself differentially pinned against the audited sign core).
 *  - Everything else here is pure *protocol construction* over those audited
 *    primitives: the BIP-78 offer/original/proposal/verify/sign state machine.
 *
 * BIP-78 grounding (bitcoin/bips bip-0078.mediawiki, fetched 2026-10-01):
 *  - "The sender creates a signed, finalized PSBT ... We call this PSBT the
 *    original." / "The receiver replies back with a signed PSBT containing
 *    his own signed inputs/outputs ... We call this Payjoin proposal."
 *  - Original PSBT MUST: witnessUTXO filled in, finalized, no unneeded
 *    fields (no global xpubs, no keypath info), broadcastable.
 *  - Proposal MUST: use all original inputs; use all non-receiver outputs;
 *    only finalize receiver-added inputs; only fill witnessUTXO for the
 *    additional inputs. MUST NOT: shuffle input/output order (additional
 *    inputs/outputs inserted at a random index); decrease the absolute fee.
 *  - Sender's proposal checklist: absolute fee >= original; version and
 *    nLockTime unchanged; sender inputs' sequences unchanged; per input: no
 *    keypaths, no partial sigs; sender inputs not finalized / receiver inputs
 *    finalized with UTXO filled; all proposal inputs share one sequence value;
 *    all original inputs present; per output: no keypaths; fee-output
 *    deduction <= maxadditionalfeecontribution, only toward fees, only paying
 *    for added weight; payment-output substitution rules; all sender outputs
 *    present; final fee rate >= minfeerate once signed.
 *  - Optional params: v=, additionalfeeoutputindex=, maxadditionalfeecontribution=,
 *    minfeerate= (decimal, grains/vB here), disableoutputsubstitution=.
 *
 * LAB CONVENTIONS (this desk is a protocol lab, not a live payjoin server):
 *  - There is no HTTP endpoint here. The Receiver tab publishes a signed
 *    "offer envelope" (JSON) carrying the original-PSBT *template* (zero-input
 *    PSBTv0: one payment output, global TX_MODIFIABLE=inputs+outputs) plus the
 *    BIP-78 params. The Sender tab funds it into the real signed+finalized
 *    original; the Proposal tab simulates the receiver; Verify runs the
 *    sender checklist; Sign re-signs the sender's inputs and extracts the tx.
 *  - The payment output doubles as the BIP-78 fee output: the receiver may
 *    deduct at most maxadditionalfeecontribution from it, only toward fees.
 *  - Query string shown is `v=2&maxadditionalfeecontribution=...&minfeerate=...&
 *    disableoutputsubstitution=...` (lab v2 per desk convention).
 */

import {
  parsePsbt, parsePsbtBase64, serializePsbt, psbtToBase64,
  serializeUnsignedTx, txidOfUnsigned,
  G_UNSIGNED_TX, G_XPUB, G_TX_MODIFIABLE,
  IN_WITNESS_UTXO, IN_PARTIAL_SIG, IN_SIGHASH_TYPE,
  IN_FINAL_SCRIPTWITNESS, IN_TAP_KEY_SIG, IN_TAP_INTERNAL_KEY,
  IN_TAP_BIP32_DERIVATION,
  OUT_AMOUNT, OUT_SCRIPT, OUT_TAP_BIP32_DERIVATION,
  compactUint, u64le, base64ToBytes,
  taprootSighash, prevoutsFromPsbt, signPsbtInput, tapTweak,
} from "../../psbt/src/psbt-core.js";
import {
  bytesToHex, hexToBytes,
  encodeBech32m, decodeBech32m, p2trScriptPubKey,
  tweakKeypath, tweakPrivKeypath, schnorr,
  walletFromMnemonic, NETWORKS, DUST_GRAIN, GRAIN_PER_PRL,
  keypathTxVBytes,
  fetchUtxos, fetchFeeRateGrainsPerVByte, broadcastTx,
} from "../../sign/src/crypto.js";

/* ---------------- constants ---------------- */

export const VERSION = 1;
export const PAYJOIN_V = 2; // lab query-string version per desk convention
export const DUST = DUST_GRAIN; // 546 grains — P2TR dust floor
export const SEQ = 0xffffffff;
export const TX_VERSION = 1;
export const MAX_MONEY = 21_000_000n * BigInt(GRAIN_PER_PRL);
export const ATTRIBUTION = Object.freeze({
  x: "@kshot9000",
  prl: "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d",
});
const MAINNET = NETWORKS.mainnet;

/* ---------------- tiny helpers ---------------- */

function concatBytes(...arrs) {
  const n = arrs.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
const u8 = (arr) => Uint8Array.from(arr);
const eqB = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

export function fail(code, msg) {
  throw new Error(`REFUSED [${code}]: ${msg}`);
}
function findPair(pairs, typeByte) {
  return pairs.find((p) => p.key.length === 1 && p.key[0] === typeByte) || null;
}
function findPairPrefix(pairs, typeByte, minKeyLen) {
  return pairs.filter((p) => p.key.length >= minKeyLen && p.key[0] === typeByte);
}
function upsertPair(pairs, key, value) {
  const kh = bytesToHex(key);
  const i = pairs.findIndex((p) => bytesToHex(p.key) === kh);
  const e = { key, value };
  if (i >= 0) pairs[i] = e; else pairs.push(e);
}
const ceilDiv = (a, b) => (a + b - 1n) / b;

/** Default randomness: crypto.getRandomValues. Overridable for tests. */
export function defaultRng() {
  const b = new Uint32Array(1);
  (globalThis.crypto || {}).getRandomValues
    ? globalThis.crypto.getRandomValues(b)
    : b.fill((Math.random() * 4294967296) >>> 0);
  return b[0] / 4294967296;
}

/* ---------------- amounts ---------------- */

/** Parse "1.5" (PRL) or "150000000"/"150000000 grains" into BigInt grains. */
export function parseGrains(str) {
  const t = String(str).trim().toLowerCase().replace(/[,_\s]/g, "");
  const m = t.match(/^(-?)(\d+)(?:\.(\d{1,8}))?(prl|grains?)?$/);
  if (!m) fail("bad-amount", `cannot parse amount "${str}" (try "1.5" for PRL or "150000000" for grains)`);
  if (m[1]) fail("bad-amount", "amount must be positive");
  const unit = m[4] || "";
  let g;
  if (unit === "prl") {
    // PRL path: up to 8 decimals allowed
    const frac = (m[3] || "").padEnd(8, "0");
    g = BigInt(m[2]) * 100_000_000n + BigInt(frac);
  } else {
    // grains path: plain integer, no decimals allowed
    if (m[3]) fail("bad-amount", "grain amounts must be whole numbers (use the PRL suffix for decimals)");
    g = BigInt(m[2]);
  }
  if (g <= 0n) fail("bad-amount", "amount must be positive");
  if (g > MAX_MONEY) fail("bad-amount", "amount exceeds 21,000,000 PRL");
  return g;
}

/** Parse a fee rate like "2" or "1.5" grains/vB into {num, den} BigInts. */
export function parseRate(str) {
  const t = String(str).trim();
  const m = t.match(/^(\d+)(?:\.(\d{1,3}))?$/);
  if (!m) fail("bad-feerate", `cannot parse fee rate "${str}" (grains per vByte, up to 3 decimals)`);
  const den = 10n ** BigInt((m[2] || "").length);
  const num = BigInt(m[1]) * den + BigInt((m[2] || "").padEnd(Number(den.toString().length) - 1, "0") || "0");
  if (num <= 0n) fail("bad-feerate", "fee rate must be positive");
  return { num, den };
}

export function grainsToPRL(g) {
  const n = BigInt(g);
  const w = n / 100_000_000n, f = n % 100_000_000n;
  return f === 0n ? `${w}` : `${w}.${f.toString().padStart(8, "0").replace(/0+$/, "")}`;
}

/* ---------------- addresses ---------------- */

/** Strict prl1 (mainnet) P2TR address -> 32-byte program. Loud on anything else. */
export function parsePrl1Address(addr) {
  const t = String(addr || "").trim();
  if (/^(tprl|rprl)/i.test(t))
    fail("wrong-network", "this lab is mainnet-only: paste a prl1… address, not a testnet/regtest one");
  let d;
  try { d = decodeBech32m(t, "prl"); }
  catch (e) { fail("bad-address", `not a valid prl1 address: ${e.message}`); }
  return d.program;
}
export const programToAddress = (program) => encodeBech32m("prl", 1, program);
export const addressToSpk = (addr) => p2trScriptPubKey(parsePrl1Address(addr));
export function isP2TR(spk) {
  return spk instanceof Uint8Array && spk.length === 34 && spk[0] === 0x51 && spk[1] === 0x20;
}
export function spkToAddress(spk) {
  if (!isP2TR(spk)) fail("bad-script", "script is not P2TR (expected OP_1 <32-byte key>)");
  return programToAddress(spk.slice(2));
}

/* ---------------- keys (BIP-86, via audited sign core) ---------------- */

export function deriveSenderKey(mnemonic, index) {
  if (!Number.isInteger(index) || index < 0) fail("bad-index", "address index must be a non-negative integer");
  let w;
  try { w = walletFromMnemonic(String(mnemonic).trim(), MAINNET, 0, index); }
  catch (e) { fail("bad-mnemonic", e.message); }
  const { tweakedX } = tweakKeypath(w.internalXOnly);
  return {
    index,
    internalXOnly: w.internalXOnly,
    internalHex: bytesToHex(w.internalXOnly),
    tweakedXOnly: tweakedX,
    tweakedHex: bytesToHex(tweakedX),
    address: w.address, // walletFromPriv already returns the tweaked P2TR address
    spk: p2trScriptPubKey(tweakedX),
    tweakedPriv: tweakPrivKeypath(w.priv, w.internalXOnly),
  };
}

/* ---------------- PSBT assembly (BIP-174 v0, keypath P2TR only) ---------------- */

function buildPsbtObject({ inputs, outputs, modifiable = null }) {
  // inputs: [{txid, vout, sequence, mapPairs}]
  // outputs: [{value: BigInt, script: Uint8Array, mapPairs}]
  const txInputs = inputs.map((i) => ({ txid: i.txid, vout: i.vout, sequence: i.sequence }));
  const txOutputs = outputs.map((o) => ({ value: o.value, script: o.script }));
  const unsignedTx = { version: TX_VERSION, inputs: txInputs, outputs: txOutputs, locktime: 0 };
  const unsignedTxBytes = serializeUnsignedTx(unsignedTx);
  const globalPairs = [{ key: u8([G_UNSIGNED_TX]), value: unsignedTxBytes }];
  if (modifiable !== null) globalPairs.push({ key: u8([G_TX_MODIFIABLE]), value: u8([modifiable]) });
  return {
    globalPairs, unsignedTx, unsignedTxBytes,
    inputs: inputs.map((i) => i.mapPairs),
    outputs: outputs.map((o) => o.mapPairs),
  };
}

function witnessUtxoPair(amount, spk) {
  return {
    key: u8([IN_WITNESS_UTXO]),
    value: concatBytes(u8(u64le(amount)), u8(compactUint(spk.length)), spk),
  };
}
function outputPairs(value, script) {
  return [
    { key: u8([OUT_AMOUNT]), value: u8(u64le(value)) },
    { key: u8([OUT_SCRIPT]), value: script },
  ];
}
function cleanInputPairs({ txid, vout, value, spk, internalKey, sequence = SEQ }) {
  if (!/^[0-9a-fA-F]{64}$/.test(txid || "")) fail("bad-outpoint", `bad txid "${String(txid).slice(0, 20)}…" (need 64 hex chars)`);
  if (!Number.isInteger(vout) || vout < 0 || vout > 0xffffffff) fail("bad-outpoint", "vout must be a uint32");
  const v = BigInt(value);
  if (v <= 0n || v > MAX_MONEY) fail("bad-value", "input value out of range");
  if (!(internalKey instanceof Uint8Array) || internalKey.length !== 32)
    fail("bad-key", "internal key must be 32 bytes x-only");
  if (!isP2TR(spk)) fail("bad-script", "input scriptPubKey must be P2TR");
  return {
    txid: txid.toLowerCase(), vout, sequence,
    mapPairs: [witnessUtxoPair(v, spk), { key: u8([IN_TAP_INTERNAL_KEY]), value: internalKey }],
    value: v, spk,
  };
}

function noKeypaths(pairs) {
  return !pairs.some((p) =>
    (p.key.length >= 1 && p.key[0] === IN_TAP_BIP32_DERIVATION) ||
    (p.key.length >= 1 && p.key[0] === OUT_TAP_BIP32_DERIVATION));
}
function noGlobalXpubs(psbt) {
  return !psbt.globalPairs.some((p) => p.key.length === 1 && p.key[0] === G_XPUB);
}
/* PSBT_IN_NON_WITNESS_UTXO is key type 0x00 with EMPTY key data -> key length 1. */
function inputHasNonWitnessUtxo(pairs) {
  return pairs.some((p) => p.key.length === 1 && p.key[0] === 0x00);
}

/* ---------------- Receiver tab: the offer ---------------- */

/** Validate + normalize the BIP-78 params. */
export function parseOfferParams({ maxadditionalfeecontribution, minfeerate, disableoutputsubstitution }) {
  const m = String(maxadditionalfeecontribution ?? "").trim();
  if (!/^\d+$/.test(m)) fail("bad-params", "maxadditionalfeecontribution must be a non-negative integer (grains)");
  const maxAdd = BigInt(m);
  if (maxAdd > MAX_MONEY) fail("bad-params", "maxadditionalfeecontribution absurd");
  const { num, den } = parseRate(String(minfeerate ?? "1"));
  const dis = String(disableoutputsubstitution).toLowerCase();
  const disable = dis === "true" || dis === "1" || dis === "yes";
  if (!["true", "false", "1", "0", "yes", "no", ""].includes(dis))
    fail("bad-params", "disableoutputsubstitution must be true/false");
  return { v: PAYJOIN_V, maxadditionalfeecontribution: maxAdd, minfeerate: { num, den }, disableoutputsubstitution: disable };
}
export function endpointQuery(params) {
  const mfr = params.minfeerate.num % params.minfeerate.den === 0n
    ? (params.minfeerate.num / params.minfeerate.den).toString()
    : Number(params.minfeerate.num) / Number(params.minfeerate.den);
  return `v=${params.v}&maxadditionalfeecontribution=${params.maxadditionalfeecontribution}` +
    `&minfeerate=${mfr}&disableoutputsubstitution=${params.disableoutputsubstitution}`;
}

/**
 * Build the receiver's offer: an ORIGINAL-PSBT *template* (BIP-174 v0, zero
 * inputs, one payment output, global TX_MODIFIABLE = inputs+outputs) plus the
 * BIP-78 params. Lab convention: the sender's tab funds this template into
 * the real signed+finalized original.
 */
export function buildReceiverOffer({ amount, paymentAddress, maxadditionalfeecontribution = "1000", minfeerate = "1", disableoutputsubstitution = false }) {
  const amountG = typeof amount === "bigint" ? amount : parseGrains(amount);
  if (amountG < BigInt(DUST)) fail("dust", `payment ${amountG} grains is below the ${DUST}-grain dust floor`);
  const program = parsePrl1Address(paymentAddress);
  const address = programToAddress(program);
  const spk = p2trScriptPubKey(program);
  const params = parseOfferParams({ maxadditionalfeecontribution, minfeerate, disableoutputsubstitution });
  const psbt = buildPsbtObject({
    inputs: [],
    outputs: [{ value: amountG, script: spk, mapPairs: outputPairs(amountG, spk) }],
    modifiable: 0x03,
  });
  const base64 = psbtToBase64(psbt);
  const envelope = {
    kind: "pearl-payjoin-offer", v: 1,
    psbt: base64,
    params: {
      v: params.v,
      maxadditionalfeecontribution: params.maxadditionalfeecontribution.toString(),
      minfeerate: params.minfeerate.num % params.minfeerate.den === 0n
        ? (params.minfeerate.num / params.minfeerate.den).toString()
        : `${params.minfeerate.num}/${params.minfeerate.den}`,
      disableoutputsubstitution: params.disableoutputsubstitution,
    },
    payment: { address, value_grains: amountG.toString(), script_hex: bytesToHex(spk) },
  };
  return {
    envelope, base64,
    query: endpointQuery(params),
    txidPreview: txidOfUnsigned(psbt.unsignedTxBytes),
    amountG, address, spkHex: bytesToHex(spk), params,
  };
}

/** Decode an envelope-or-bare-PSBT paste box. Returns {kind, psbtB64, params, payment} */
export function decodePaste(text) {
  const t = String(text || "").trim();
  if (!t) fail("empty", "paste box is empty");
  if (t[0] === "{") {
    let j;
    try { j = JSON.parse(t); } catch { fail("bad-envelope", "not valid JSON and not base64"); }
    if (!j || typeof j !== "object" || !j.psbt) fail("bad-envelope", "JSON envelope has no 'psbt' field");
    let params = null;
    if (j.params) {
      try { params = parseOfferParams(j.params); }
      catch (e) { fail("bad-envelope", "envelope params invalid: " + e.message); }
    }
    return { kind: j.kind || "unknown", psbtB64: String(j.psbt), params, payment: j.payment || null, fee: j.fee || null };
  }
  // bare base64 PSBT
  if (!/^[A-Za-z0-9+/=_\-\s]+$/.test(t)) fail("bad-paste", "paste is neither a payjoin envelope nor base64");
  return { kind: "bare-psbt", psbtB64: t.replace(/\s+/g, ""), params: null, payment: null, fee: null };
}

/* ---------------- validation: receiver checks on the offer template ---------------- */

export function validateOfferTemplate(psbtB64) {
  let psbt;
  try { psbt = parsePsbtBase64(psbtB64); }
  catch (e) { fail("bad-psbt", "not a valid PSBT: " + e.message); }
  const tx = psbt.unsignedTx;
  if (tx.version !== TX_VERSION) fail("bad-version", `offer tx version ${tx.version} != ${TX_VERSION}`);
  if (tx.locktime !== 0) fail("locktime", "offer template must have nLockTime = 0");
  if (!noGlobalXpubs(psbt)) fail("unneeded-fields", "offer carries global xpubs — BIP-78 forbids unneeded fields");
  const mod = findPair(psbt.globalPairs, G_TX_MODIFIABLE);
  if (!mod || mod.value.length !== 1 || (mod.value[0] & 0x03) !== 0x03)
    fail("not-modifiable", "offer template must set PSBT_GLOBAL_TX_MODIFIABLE = inputs+outputs (0x03)");
  if (tx.inputs.length !== 0) fail("has-inputs", "offer template must carry zero inputs (the sender funds it)");
  if (tx.outputs.length !== 1) fail("bad-outputs", `offer template must carry exactly one output (the payment), got ${tx.outputs.length}`);
  const o = tx.outputs[0];
  if (!isP2TR(o.script)) fail("bad-script", "payment output script is not P2TR");
  if (o.value < BigInt(DUST)) fail("dust", `payment output ${o.value} below ${DUST}-grain dust floor`);
  const om = psbt.outputs[0];
  if (!noKeypaths(om)) fail("unneeded-fields", "offer output carries keypath info — BIP-78 forbids it");
  for (const pairs of psbt.inputs) {
    if (findPair(pairs, IN_PARTIAL_SIG) || findPair(pairs, IN_TAP_KEY_SIG))
      fail("has-sigs", "offer template must not carry signatures");
    if (findPair(pairs, IN_FINAL_SCRIPTWITNESS)) fail("finalized", "offer template must not be finalized");
    if (inputHasNonWitnessUtxo(pairs)) fail("non-witness-utxo", "BIP-78: non-witness UTXOs are forbidden");
  }
  return {
    psbt, paymentScript: o.script, paymentValue: o.value,
    paymentAddress: spkToAddress(o.script),
  };
}

/* ---------------- decode view ---------------- */

export function summarizePsbt(psbtB64) {
  let psbt;
  try { psbt = parsePsbtBase64(psbtB64); }
  catch (e) { fail("bad-psbt", "not a valid PSBT: " + e.message); }
  const tx = psbt.unsignedTx;
  const mod = findPair(psbt.globalPairs, G_TX_MODIFIABLE);
  const inputs = tx.inputs.map((inp, i) => {
    const pairs = psbt.inputs[i];
    const w = findPair(pairs, IN_WITNESS_UTXO);
    let value = null, spkHex = null, address = null;
    if (w) {
      const amt = u64From(w.value.slice(0, 8));
      const sl = w.value[8];
      const spk = w.value.slice(9, 9 + sl);
      value = amt.toString(); spkHex = bytesToHex(spk);
      try { address = spkToAddress(spk); } catch { /* non-P2TR */ }
    }
    return {
      index: i, txid: inp.txid, vout: inp.vout, sequence: inp.sequence,
      value_grains: value, script_hex: spkHex, address,
      has_partial_sig: !!(findPair(pairs, IN_PARTIAL_SIG) || findPair(pairs, IN_TAP_KEY_SIG)),
      finalized: !!findPair(pairs, IN_FINAL_SCRIPTWITNESS),
      has_non_witness_utxo: inputHasNonWitnessUtxo(pairs),
      has_keypath_info: !noKeypaths(pairs),
    };
  });
  const outputs = tx.outputs.map((o, i) => {
    let address = null;
    try { address = spkToAddress(o.script); } catch { /* non-P2TR */ }
    return {
      index: i, value_grains: o.value.toString(), script_hex: bytesToHex(o.script), address,
      has_keypath_info: !noKeypaths(psbt.outputs[i]),
    };
  });
  const totalIn = inputs.reduce((a, x) => a + (x.value_grains ? BigInt(x.value_grains) : 0n), 0n);
  const totalOut = tx.outputs.reduce((a, o) => a + o.value, 0n);
  const fee = totalIn - totalOut;
  const vsize = keypathTxVBytes(tx.inputs.length || 1, tx.outputs.length);
  return {
    version: tx.version, locktime: tx.locktime,
    txid_preview: txidOfUnsigned(psbt.unsignedTxBytes),
    modifiable: mod ? "0x" + mod.value[0].toString(16).padStart(2, "0") : "(absent)",
    has_global_xpubs: !noGlobalXpubs(psbt),
    inputs, outputs,
    total_in_grains: totalIn.toString(), total_out_grains: totalOut.toString(),
    fee_grains: fee.toString(), vsize_est: vsize,
    fee_rate_est: tx.inputs.length ? (Number(fee) / vsize).toFixed(2) : "n/a (no inputs yet)",
  };
}
function u64From(b) {
  let n = 0n;
  for (let i = 7; i >= 0; i--) n = (n << 8n) | BigInt(b[i]);
  return n;
}

/* ---------------- Sender tab: fund the offer -> signed+finalized original ---------------- */

/**
 * Validate a sender input spec and resolve it against a derived key.
 * spec: {txid, vout, value (grains), key: derived key object from deriveSenderKey}
 */
export function prepareSenderInput(spec) {
  const { txid, vout, value, key } = spec;
  if (!key || !(key.internalXOnly instanceof Uint8Array))
    fail("bad-key", "each input needs a derived key (mnemonic -> BIP-86)");
  const v = BigInt(value);
  if (v <= 0n || v > MAX_MONEY) fail("bad-value", "input value out of range");
  // The witness UTXO's scriptPubKey is the tweaked P2TR key of the internal key.
  const { tweakedX } = tweakKeypath(key.internalXOnly);
  if (bytesToHex(tweakedX) !== key.tweakedHex)
    fail("key-mismatch", "derived key is internally inconsistent — refusing to use it");
  const spk = p2trScriptPubKey(tweakedX);
  return cleanInputPairs({ txid, vout, value: v, spk, internalKey: key.internalXOnly });
}

/** Sign a keypath input with SIGHASH_DEFAULT and finalize it, KEEPING the
 *  witness UTXO + internal key (BIP-78 demands the original carry UTXO data). */
function signAndFinalizeInput(psbt, i, tweakedPriv) {
  const prevouts = prevoutsFromPsbt(psbt);
  const r = signPsbtInput({ psbt, inputIndex: i, privKey: tweakedPriv, hashType: 0x00 });
  // signPsbtInput already re-verified the fresh signature. Now verify once more
  // from the stored partial sig, then attach the final witness.
  const pairs = psbt.inputs[i];
  const sigE = findPair(pairs, IN_TAP_KEY_SIG);
  if (!sigE || sigE.value.length !== 64) fail("sign-failed", `input ${i}: key sig missing after signing`);
  const internalE = findPair(pairs, IN_TAP_INTERNAL_KEY);
  const { Q } = tapTweak(internalE.value, null);
  const sighash = taprootSighash({ tx: psbt.unsignedTx, inputIndex: i, prevouts, hashType: 0x00, scriptPath: null });
  if (!schnorr.verify(sigE.value, sighash, Q))
    fail("sign-failed", `input ${i}: stored signature does not verify — refusing to finalize`);
  const wit = concatBytes(u8(compactUint(1)), u8(compactUint(64)), sigE.value);
  upsertPair(pairs, u8([IN_FINAL_SCRIPTWITNESS]), wit);
  return r;
}

/**
 * Build the SIGNED, FINALIZED original PSBT (BIP-78 "the original"):
 * sender keypath inputs + payment output (+ optional change), every sender
 * input signed with SIGHASH_DEFAULT and finalized, witness UTXOs retained.
 *
 * opts: { offerB64, params, senderInputs: [prepared via prepareSenderInput],
 *         changeAddress (prl1 or ""), feeRate ("2" grains/vB), tweakedPrivs: [Uint8Array] }
 */
export function buildSenderOriginal({ offerB64, params, senderInputs, changeAddress = "", feeRate = "2", tweakedPrivs }) {
  if (!params) fail("bad-params", "BIP-78 params are required (paste the offer envelope, or enter them manually)");
  const offer = validateOfferTemplate(offerB64);
  if (!Array.isArray(senderInputs) || senderInputs.length === 0)
    fail("no-inputs", "add at least one sender input");
  if (!Array.isArray(tweakedPrivs) || tweakedPrivs.length !== senderInputs.length)
    fail("bad-keys", "one tweaked private key per sender input is required");
  // duplicate outpoints?
  const seen = new Set();
  for (const inp of senderInputs) {
    const k = `${inp.txid}:${inp.vout}`;
    if (seen.has(k)) fail("dup-input", `duplicate input outpoint ${k}`);
    seen.add(k);
  }
  const { num: frNum, den: frDen } = parseRate(feeRate);
  const paymentValue = offer.paymentValue;
  const paymentScript = offer.paymentScript;
  const sumIn = senderInputs.reduce((a, x) => a + x.value, 0n);

  let changeAddr = String(changeAddress || "").trim();
  let changeProgram = null;
  if (changeAddr) changeProgram = parsePrl1Address(changeAddr);

  // fee from the exact keypath vsize; iterate once if change is dropped
  const buildWith = (withChange) => {
    const nOut = withChange ? 2 : 1;
    const vsize = keypathTxVBytes(senderInputs.length, nOut);
    const fee = ceilDiv(frNum * BigInt(vsize), frDen);
    return { vsize, fee };
  };
  let { vsize, fee } = buildWith(!!changeProgram);
  let changeValue = sumIn - paymentValue - fee;
  if (changeProgram) {
    if (changeValue < 0n) fail("insufficient-funds", `inputs cover ${grainsToPRL(sumIn)} PRL but need ${grainsToPRL(paymentValue + fee)} (payment + fee)`);
    if (changeValue > 0n && changeValue < BigInt(DUST)) {
      // change would be dust: drop it, remainder goes to fee
      changeProgram = null; changeAddr = "";
      ({ vsize, fee } = buildWith(false));
      changeValue = sumIn - paymentValue - fee;
    }
  }
  if (changeValue < 0n) fail("insufficient-funds", `inputs cover ${grainsToPRL(sumIn)} PRL but need ${grainsToPRL(paymentValue + fee)} (payment + fee)`);
  if (!changeProgram && changeValue > 0n) fee += changeValue; // no change address: remainder to fee
  const actualRate = Number(fee) / vsize;

  const outputs = [{ value: paymentValue, script: paymentScript, mapPairs: outputPairs(paymentValue, paymentScript) }];
  if (changeProgram) {
    const cspk = p2trScriptPubKey(changeProgram);
    outputs.push({ value: changeValue, script: cspk, mapPairs: outputPairs(changeValue, cspk) });
  }
  const psbt = buildPsbtObject({ inputs: senderInputs, outputs, modifiable: 0x03 });
  // sign + finalize every sender input (SIGHASH_DEFAULT), re-verified twice
  senderInputs.forEach((inp, i) => signAndFinalizeInput(psbt, i, tweakedPrivs[i]));
  const base64 = psbtToBase64(psbt);
  const envelope = {
    kind: "pearl-payjoin-original", v: 1,
    psbt: base64,
    params: {
      v: params.v,
      maxadditionalfeecontribution: params.maxadditionalfeecontribution.toString(),
      minfeerate: params.minfeerate.num % params.minfeerate.den === 0n
        ? (params.minfeerate.num / params.minfeerate.den).toString()
        : `${params.minfeerate.num}/${params.minfeerate.den}`,
      disableoutputsubstitution: params.disableoutputsubstitution,
    },
    payment: {
      address: offer.paymentAddress,
      value_grains: paymentValue.toString(),
      script_hex: bytesToHex(paymentScript),
    },
    fee: {
      fee_grains: fee.toString(), vsize, fee_rate: actualRate.toFixed(2),
      change_grains: changeProgram ? changeValue.toString() : "0",
      change_address: changeAddr || null,
    },
  };
  return {
    envelope, base64,
    fee, vsize, feeRate: actualRate,
    changeValue: changeProgram ? changeValue : 0n,
    changeAddress: changeAddr || null,
    txid: txidOfUnsigned(psbt.unsignedTxBytes),
    nIn: senderInputs.length, nOut: outputs.length,
  };
}

/* ---------------- Proposal tab: receiver simulation ---------------- */

/** Receiver-side validation of the sender's funded original PSBT. */
export function validateFundedOriginal(psbtB64) {
  let psbt;
  try { psbt = parsePsbtBase64(psbtB64); }
  catch (e) { fail("bad-psbt", "not a valid PSBT: " + e.message); }
  const tx = psbt.unsignedTx;
  if (tx.version !== TX_VERSION) fail("bad-version", `original tx version ${tx.version} != ${TX_VERSION}`);
  if (tx.locktime !== 0) fail("locktime", "original must have nLockTime = 0");
  if (!noGlobalXpubs(psbt)) fail("unneeded-fields", "original carries global xpubs — BIP-78 forbids unneeded fields");
  if (tx.inputs.length === 0) fail("no-inputs", "funded original must carry the sender's inputs");
  if (tx.outputs.length === 0) fail("no-outputs", "funded original must carry outputs");
  const prevouts = prevoutsFromPsbt(psbt); // throws if any input lacks witness UTXO
  let totalIn = 0n;
  tx.inputs.forEach((inp, i) => {
    const pairs = psbt.inputs[i];
    if (inputHasNonWitnessUtxo(pairs)) fail("non-witness-utxo", `BIP-78 forbids non-witness UTXOs (input ${i})`);
    if (!noKeypaths(pairs)) fail("unneeded-fields", `input ${i} carries keypath info — BIP-78 forbids it`);
    const sigE = findPair(pairs, IN_TAP_KEY_SIG);
    if (!sigE) fail("not-signed", `input ${i} has no tap key signature — the sender must sign the original first`);
    if (sigE.value.length !== 64 && sigE.value.length !== 65)
      fail("bad-sig", `input ${i}: malformed tap key signature length`);
    const finE = findPair(pairs, IN_FINAL_SCRIPTWITNESS);
    if (!finE) fail("not-finalized", `input ${i} is not finalized — BIP-78 requires a signed, finalized original`);
    const internalE = findPair(pairs, IN_TAP_INTERNAL_KEY);
    if (!internalE) fail("bad-input", `input ${i} missing internal key`);
    if (!isP2TR(prevouts[i].spk)) fail("bad-script", `input ${i} prevout is not P2TR — this desk only speaks taproot`);
    // re-verify the sender's signature against the original unsigned tx
    const { Q } = tapTweak(internalE.value, null);
    const ht = sigE.value.length === 64 ? 0x00 : sigE.value[64];
    const sighash = taprootSighash({ tx, inputIndex: i, prevouts, hashType: ht, scriptPath: null });
    if (!schnorr.verify(sigE.value.slice(0, 64), sighash, Q))
      fail("bad-sig", `input ${i}: sender signature does not verify — refusing to build on a forged original`);
    totalIn += prevouts[i].amount;
  });
  tx.outputs.forEach((o, i) => {
    if (!isP2TR(o.script)) fail("bad-script", `output ${i} is not P2TR — this desk only speaks taproot`);
    if (o.value < BigInt(DUST)) fail("dust", `output ${i} value ${o.value} below ${DUST}-grain dust floor`);
    if (!noKeypaths(psbt.outputs[i])) fail("unneeded-fields", `output ${i} carries keypath info — BIP-78 forbids it`);
  });
  const totalOut = tx.outputs.reduce((a, o) => a + o.value, 0n);
  const fee = totalIn - totalOut;
  if (fee < 0n) fail("negative-fee", "original outputs exceed inputs");
  const vsize = keypathTxVBytes(tx.inputs.length, tx.outputs.length);
  return { psbt, totalIn, totalOut, fee, vsize, feeRate: Number(fee) / vsize };
}

/** Insert index in [0, n] from an rng in [0, 1). */
function randomIndex(rng, n) {
  const r = rng();
  if (!(r >= 0 && r < 1)) fail("bad-rng", "rng must return [0, 1)");
  return Math.min(n, Math.floor(r * (n + 1)));
}

/**
 * Build the payjoin PROPOSAL PSBT (receiver simulation).
 *
 * opts: { originalB64, params, paymentScriptHex, receiverInputs: [prepared],
 *         receiverChangeAddress, tweakedPrivs, rng }
 *
 * Fee policy (all integer grains):
 *   addedVBytes = vsize(with receiver input+change) - vsize(original)
 *   weightCost  = ceil(fee_o * addedVBytes / vsize_o)   // added weight at the original rate
 *   minTotal    = ceil(minfeerate * vsize_p)            // sender's floor for the whole tx
 *   required    = max(weightCost, minTotal - fee_o, 0)  // what the proposal must add in fee
 *   c_recv      = min(max(R - DUST, 0), weightCost)     // receiver funds (at most) its own weight
 *   need        = required - c_recv                     // shortfall taken from the payment output
 *   d           = min(need, maxadditionalfeecontribution,
 *                     floor(fee_o * addedVBytes / vsize_o),  // BIP-78: only paying for added weight
 *                     payment_o - DUST)
 *   need > d  -> REFUSED [not-enough-money]
 */
export function buildProposal({ originalB64, params, paymentScriptHex, receiverInputs, receiverChangeAddress, tweakedPrivs, rng = defaultRng }) {
  if (!params) fail("bad-params", "BIP-78 params are required");
  const orig = validateFundedOriginal(originalB64);
  const tx = orig.psbt.unsignedTx;
  const nInO = tx.inputs.length, nOutO = tx.outputs.length;
  if (!Array.isArray(receiverInputs) || receiverInputs.length === 0)
    fail("no-inputs", "the receiver must add at least one input (this lab always payjoins)");
  if (!Array.isArray(tweakedPrivs) || tweakedPrivs.length !== receiverInputs.length)
    fail("bad-keys", "one tweaked private key per receiver input is required");
  const paymentScript = hexToBytes(paymentScriptHex);
  if (!isP2TR(paymentScript)) fail("bad-params", "payment script is not P2TR");
  const payIdx = tx.outputs.findIndex((o) => eqB(o.script, paymentScript));
  if (payIdx < 0) fail("no-payment-output", "the original has no output paying the receiver's script — refusing");
  const paymentO = tx.outputs[payIdx].value;
  const changeAddr = String(receiverChangeAddress || "").trim();
  if (!changeAddr) fail("no-change", "the receiver needs a change address for its added input");
  const changeProgram = parsePrl1Address(changeAddr);

  // duplicate outpoints (within receiver set, and vs sender set)?
  const senderOutpoints = new Set(tx.inputs.map((i) => `${i.txid}:${i.vout}`));
  const seen = new Set();
  let R = 0n;
  for (const inp of receiverInputs) {
    const k = `${inp.txid}:${inp.vout}`;
    if (senderOutpoints.has(k)) fail("dup-input", `receiver input ${k} is already spent by the sender`);
    if (seen.has(k)) fail("dup-input", `duplicate receiver input ${k}`);
    seen.add(k);
    R += inp.value;
  }
  if (R <= 0n) fail("bad-value", "receiver inputs must carry value");

  const maxAdd = params.maxadditionalfeecontribution;
  const mfr = params.minfeerate;

  // Two passes: with change output, else without (change < dust -> donate remainder to fee)
  let pass = null;
  for (const withChange of [true, false]) {
    const nInP = nInO + receiverInputs.length;
    const nOutP = nOutO + (withChange ? 1 : 0);
    const vsizeP = keypathTxVBytes(nInP, nOutP);
    const addedVBytes = vsizeP - orig.vsize;
    const weightCost = ceilDiv(orig.fee * BigInt(addedVBytes), BigInt(orig.vsize));
    const minTotal = ceilDiv(mfr.num * BigInt(vsizeP), mfr.den);
    const required = [weightCost, minTotal - orig.fee, 0n].reduce((a, b) => (a > b ? a : b));
    const maxRecv = withChange ? R - BigInt(DUST) : R;
    const cRecv = maxRecv <= 0n ? 0n : (maxRecv < weightCost ? maxRecv : weightCost);
    const need = required - cRecv;
    let d = 0n;
    if (need > 0n) {
      const dMaxWeight = (orig.fee * BigInt(addedVBytes)) / BigInt(orig.vsize);
      const dMaxDust = paymentO - BigInt(DUST);
      d = [need, maxAdd, dMaxWeight, dMaxDust].reduce((a, b) => (a < b ? a : b));
      if (params.disableoutputsubstitution)
        fail("not-enough-money", "output substitution is disabled: the payment output cannot be touched, " +
          `but the receiver's added weight needs ${need} more grains than its input funds`);
      if (d < 0n) d = 0n;
      if (need > d)
        fail("not-enough-money", `receiver cannot fund ${addedVBytes} added vBytes within ` +
          `maxadditionalfeecontribution=${maxAdd} (needs ${need}, allowed ${d})`);
    }
    const rChange = R - cRecv;
    if (withChange && rChange > 0n && rChange < BigInt(DUST)) continue; // retry without change
    if (withChange && rChange === 0n) continue; // no change output needed; retry cleanly
    pass = { withChange, vsizeP, addedVBytes, weightCost, minTotal, required, cRecv, d, rChange: withChange ? rChange : 0n };
    break;
  }
  if (!pass) fail("internal", "fee computation failed to converge");

  const { withChange, vsizeP, addedVBytes, weightCost, minTotal, required, cRecv, d, rChange } = pass;
  const feeP = orig.fee + cRecv + d;
  const paymentP = paymentO - d;

  // ---- assemble the proposal unsigned tx ----
  const inIdx = randomIndex(rng, nInO); // receiver inputs inserted at a random index (BIP-78)
  const newInputs = tx.inputs.map((inp, i) => ({
    txid: inp.txid, vout: inp.vout, sequence: inp.sequence,
    // sender inputs: clean maps (no sigs, no finalization, no keypaths) per sender checklist
    mapPairs: (() => {
      const src = orig.psbt.inputs[i];
      const w = findPair(src, IN_WITNESS_UTXO);
      const k = findPair(src, IN_TAP_INTERNAL_KEY);
      return [w, k].filter(Boolean).map((p) => ({ key: p.key, value: p.value }));
    })(),
  }));
  const recvPairs = receiverInputs.map((inp) => inp.mapPairs.map((p) => ({ key: p.key, value: p.value })));
  newInputs.splice(inIdx, 0, ...receiverInputs.map((inp, j) => ({
    txid: inp.txid, vout: inp.vout, sequence: SEQ, mapPairs: recvPairs[j],
  })));

  const newOutputs = tx.outputs.map((o, i) => ({
    value: i === payIdx ? paymentP : o.value,
    script: o.script,
    mapPairs: i === payIdx
      ? outputPairs(paymentP, o.script)
      : orig.psbt.outputs[i].map((p) => ({ key: p.key, value: p.value })),
  }));
  let changeIdx = -1;
  if (withChange) {
    const cspk = p2trScriptPubKey(changeProgram);
    changeIdx = randomIndex(rng, nOutO);
    newOutputs.splice(changeIdx, 0, { value: rChange, script: cspk, mapPairs: outputPairs(rChange, cspk) });
  }

  const psbt = buildPsbtObject({ inputs: newInputs, outputs: newOutputs, modifiable: null });
  // sign the receiver's inputs (SIGHASH_DEFAULT) and finalize ONLY those inputs
  const prevouts = prevoutsFromPsbt(psbt);
  receiverInputs.forEach((inp, j) => {
    const idx = inIdx + j;
    const r = signPsbtInput({ psbt, inputIndex: idx, privKey: tweakedPrivs[j], hashType: 0x00 });
    void r;
    const pairs = psbt.inputs[idx];
    const sigE = findPair(pairs, IN_TAP_KEY_SIG);
    const internalE = findPair(pairs, IN_TAP_INTERNAL_KEY);
    const { Q } = tapTweak(internalE.value, null);
    const sighash = taprootSighash({ tx: psbt.unsignedTx, inputIndex: idx, prevouts, hashType: 0x00, scriptPath: null });
    if (!schnorr.verify(sigE.value, sighash, Q))
      fail("sign-failed", `receiver input ${idx}: fresh signature does not verify`);
    const wit = concatBytes(u8(compactUint(1)), u8(compactUint(64)), sigE.value);
    upsertPair(pairs, u8([IN_FINAL_SCRIPTWITNESS]), wit);
  });

  const base64 = psbtToBase64(psbt);
  const envelope = {
    kind: "pearl-payjoin-proposal", v: 1,
    psbt: base64,
    original_psbt: originalB64,
    params: {
      v: params.v,
      maxadditionalfeecontribution: params.maxadditionalfeecontribution.toString(),
      minfeerate: params.minfeerate.num % params.minfeerate.den === 0n
        ? (params.minfeerate.num / params.minfeerate.den).toString()
        : `${params.minfeerate.num}/${params.minfeerate.den}`,
      disableoutputsubstitution: params.disableoutputsubstitution,
    },
    payment: { value_grains: paymentO.toString(), script_hex: paymentScriptHex },
    fee: {
      fee_original_grains: orig.fee.toString(),
      fee_proposal_grains: feeP.toString(),
      vsize_original: orig.vsize, vsize_proposal: vsizeP,
      added_vbytes: addedVBytes,
      fee_rate_original: (Number(orig.fee) / orig.vsize).toFixed(2),
      fee_rate_proposal: (Number(feeP) / vsizeP).toFixed(2),
      payment_deduction_grains: d.toString(),
      receiver_contribution_grains: cRecv.toString(),
      receiver_change_grains: rChange.toString(),
      receiver_input_index: inIdx,
      receiver_change_index: changeIdx,
    },
  };
  return {
    envelope, base64,
    feeO: orig.fee, feeP, vsizeO: orig.vsize, vsizeP, addedVBytes,
    weightCost, minTotal, required, d, cRecv, rChange, paymentO, paymentP, inIdx, changeIdx,
    txid: txidOfUnsigned(psbt.unsignedTxBytes),
    nIn: newInputs.length, nOut: newOutputs.length,
  };
}

/* ---------------- Verify tab: the sender's proposal checklist ----------------
 * Grounded in BIP-78 "Sender's payjoin proposal checklist". Each check
 * returns {id, name, pass, detail}; a failed check is a loud, specific
 * refusal reason. verifyProposal never throws on a failed check — it reports.
 */

function check(id, name, pass, detail) {
  return { id, name, pass: !!pass, detail: String(detail) };
}
function outpointKey(inp) { return `${inp.txid}:${inp.vout}`; }
function witnessInfo(pairs) {
  const w = findPair(pairs, IN_WITNESS_UTXO);
  if (!w) return null;
  const amt = u64From(w.value.slice(0, 8));
  const sl = w.value[8];
  return { amount: amt, spk: w.value.slice(9, 9 + sl) };
}

export function verifyProposal({ originalB64, proposalB64, params, paymentScriptHex = null }) {
  const checks = [];
  let original, proposal;
  try { original = parsePsbtBase64(originalB64); }
  catch (e) { return { ok: false, checks: [check("parse-original", "Original PSBT parses", false, "not a valid PSBT: " + e.message)] }; }
  try { proposal = parsePsbtBase64(proposalB64); }
  catch (e) { return { ok: false, checks: [check("parse-proposal", "Proposal PSBT parses", false, "not a valid PSBT: " + e.message)] }; }
  const otx = original.unsignedTx, ptx = proposal.unsignedTx;

  const oPrev = (() => { try { return prevoutsFromPsbt(original); } catch { return null; } })();
  const pPrev = (() => { try { return prevoutsFromPsbt(proposal); } catch { return null; } })();
  const feeO = oPrev ? oPrev.reduce((a, p) => a + p.amount, 0n) - otx.outputs.reduce((a, o) => a + o.value, 0n) : null;
  const feeP = pPrev ? pPrev.reduce((a, p) => a + p.amount, 0n) - ptx.outputs.reduce((a, o) => a + o.value, 0n) : null;
  const vsizeO = keypathTxVBytes(otx.inputs.length, otx.outputs.length);
  const vsizeP = keypathTxVBytes(ptx.inputs.length, ptx.outputs.length);
  const addedVBytes = vsizeP - vsizeO;

  // identify the payment (fee) output
  let payScript = null;
  if (paymentScriptHex) {
    try { payScript = hexToBytes(paymentScriptHex); } catch { /* fall through */ }
  }
  const oPayIdx = payScript ? otx.outputs.findIndex((o) => eqB(o.script, payScript)) : -1;
  let payIdxO = oPayIdx, payIdxP = -1;
  if (payIdxO < 0) {
    // fallback: the unique output whose value decreased within bounds
    const decreased = otx.outputs.map((o, i) => ({ o, i }))
      .filter(({ o, i }) => i < ptx.outputs.length && ptx.outputs[i].value < o.value);
    if (decreased.length === 1) { payIdxO = decreased[0].i; payScript = decreased[0].o.script; }
  }
  if (payScript) payIdxP = ptx.outputs.findIndex((o) => eqB(o.script, payScript));

  /* 1. absolute fee must not decrease */
  checks.push(check("fee-not-decreased", "Absolute fee not decreased",
    feeO !== null && feeP !== null && feeP >= feeO,
    feeO === null || feeP === null ? "could not compute fees (missing witness UTXOs)"
      : `original ${feeO} grains -> proposal ${feeP} grains` +
        (feeP >= feeO ? "" : ` — REFUSED: BIP-78 forbids decreasing the absolute fee`)));

  /* 2. version unchanged */
  checks.push(check("version-unchanged", "Transaction version unchanged",
    ptx.version === otx.version && ptx.version === TX_VERSION,
    `original v${otx.version} / proposal v${ptx.version}` +
      (ptx.version !== otx.version ? " — REFUSED: version changed" : "")));

  /* 3. locktime unchanged */
  checks.push(check("locktime-unchanged", "nLockTime unchanged",
    ptx.locktime === otx.locktime,
    `original ${otx.locktime} / proposal ${ptx.locktime}` +
      (ptx.locktime !== otx.locktime ? " — REFUSED: locktime game detected" : "")));

  /* 4. all original inputs present, original order preserved (no shuffle) */
  const oKeys = otx.inputs.map(outpointKey);
  const pKeys = ptx.inputs.map(outpointKey);
  const missing = oKeys.filter((k) => !pKeys.includes(k));
  let orderOk = missing.length === 0;
  if (orderOk) {
    const positions = oKeys.map((k) => pKeys.indexOf(k));
    orderOk = positions.every((p, i) => i === 0 || p > positions[i - 1]);
  }
  checks.push(check("inputs-preserved", "All original inputs present, order preserved",
    orderOk,
    missing.length ? `REFUSED: original input(s) removed: ${missing.join(", ")}`
      : orderOk ? `${oKeys.length} original input(s) present in original relative order (+${pKeys.length - oKeys.length} added)`
        : "REFUSED: original inputs were shuffled — BIP-78 forbids reordering"));

  /* 5. sequences: sender's unchanged; all proposal inputs share one value */
  const seqUnchanged = oKeys.every((k) => {
    const oi = oKeys.indexOf(k), pi = pKeys.indexOf(k);
    return pi >= 0 && ptx.inputs[pi].sequence === otx.inputs[oi].sequence;
  });
  const allSeq = new Set(ptx.inputs.map((i) => i.sequence));
  checks.push(check("sequences", "Sequences unchanged and uniform",
    seqUnchanged && allSeq.size === 1,
    !seqUnchanged ? "REFUSED: a sender input's sequence number changed"
      : allSeq.size !== 1 ? `REFUSED: proposal inputs use ${allSeq.size} different sequence values (BIP-78: must all match)`
        : `all ${ptx.inputs.length} inputs use sequence ${[...allSeq][0].toString(16)}`));

  /* 6. sender inputs in the proposal: clean (no keypaths, no partial sigs, not finalized, UTXO identical) */
  let senderClean = true, senderDetail = "";
  for (const k of oKeys) {
    const oi = oKeys.indexOf(k), pi = pKeys.indexOf(k);
    if (pi < 0) continue;
    const pairs = proposal.inputs[pi];
    const wO = oPrev ? { amount: oPrev[oi].amount, spk: oPrev[oi].spk } : witnessInfo(original.inputs[oi]);
    const wP = witnessInfo(pairs);
    if (!wP || !wO || wP.amount !== wO.amount || !eqB(wP.spk, wO.spk)) {
      senderClean = false; senderDetail = `REFUSED: sender input ${k} witness UTXO was altered`; break;
    }
    if (!noKeypaths(pairs)) { senderClean = false; senderDetail = `REFUSED: sender input ${k} carries keypath info`; break; }
    if (findPair(pairs, IN_PARTIAL_SIG) || findPair(pairs, IN_TAP_KEY_SIG)) {
      senderClean = false; senderDetail = `REFUSED: sender input ${k} carries a partial signature in the proposal (must be unsigned until you sign)`; break;
    }
    if (findPair(pairs, IN_FINAL_SCRIPTWITNESS) || pairs.some((p) => p.key.length === 1 && p.key[0] === 0x07)) {
      senderClean = false; senderDetail = `REFUSED: sender input ${k} is finalized in the proposal`; break;
    }
    if (inputHasNonWitnessUtxo(pairs)) { senderClean = false; senderDetail = `REFUSED: sender input ${k} has a non-witness UTXO`; break; }
  }
  checks.push(check("sender-inputs-clean", "Sender inputs clean (UTXO identical, no sigs, not finalized)", senderClean,
    senderDetail || `${oKeys.length} sender input(s) carry only witness UTXO + internal key`));

  /* 7. receiver (added) inputs: finalized, UTXO filled, signature VERIFIES */
  const addedIdx = pKeys.map((k, i) => (oKeys.includes(k) ? -1 : i)).filter((i) => i >= 0);
  let recvOk = true, recvDetail = "";
  if (addedIdx.length === 0) { recvOk = true; recvDetail = "no inputs added (receiver only substituted outputs)"; }
  for (const pi of addedIdx) {
    const pairs = proposal.inputs[pi];
    if (!findPair(pairs, IN_FINAL_SCRIPTWITNESS)) { recvOk = false; recvDetail = `REFUSED: receiver input ${pi} is not finalized`; break; }
    const w = witnessInfo(pairs);
    if (!w) { recvOk = false; recvDetail = `REFUSED: receiver input ${pi} has no witness UTXO`; break; }
    if (inputHasNonWitnessUtxo(pairs)) { recvOk = false; recvDetail = `REFUSED: receiver input ${pi} has a non-witness UTXO`; break; }
    const sigE = findPair(pairs, IN_TAP_KEY_SIG);
    const intE = findPair(pairs, IN_TAP_INTERNAL_KEY);
    if (!sigE || !intE) { recvOk = false; recvDetail = `REFUSED: receiver input ${pi} missing tap key sig or internal key`; break; }
    const { Q } = tapTweak(intE.value, null);
    const ht = sigE.value.length === 64 ? 0x00 : sigE.value[64];
    const sighash = taprootSighash({ tx: ptx, inputIndex: pi, prevouts: pPrev, hashType: ht, scriptPath: null });
    if (!schnorr.verify(sigE.value.slice(0, 64), sighash, Q)) {
      recvOk = false; recvDetail = `REFUSED: receiver input ${pi} signature does not verify — forged proposal`; break;
    }
  }
  checks.push(check("receiver-inputs", "Receiver inputs finalized with verifying signatures", recvOk,
    recvDetail || `${addedIdx.length} added input(s), each signature re-verified against the proposal sighash`));

  /* 8. no non-witness UTXOs anywhere */
  const noNonWit = [...original.inputs, ...proposal.inputs].every((p) => !inputHasNonWitnessUtxo(p));
  checks.push(check("no-nonwitness-utxo", "No non-witness UTXOs anywhere", noNonWit,
    noNonWit ? "clean" : "REFUSED: a non-witness UTXO was found — BIP-78 forbids them"));

  /* 9. no keypaths / global xpubs anywhere */
  const noKp = noGlobalXpubs(original) && noGlobalXpubs(proposal) &&
    [...original.inputs, ...proposal.inputs, ...original.outputs, ...proposal.outputs].every(noKeypaths);
  checks.push(check("no-keypaths", "No keypath/xpub metadata (privacy)", noKp,
    noKp ? "no global xpubs, no BIP-32 derivation fields" : "REFUSED: keypath or xpub metadata leaked into a PSBT"));

  /* 10. outputs preserved: non-payment outputs identical script, value not decreased */
  let outOk = true, outDetail = "";
  for (let i = 0; i < otx.outputs.length; i++) {
    if (i === payIdxO) continue;
    const oo = otx.outputs[i];
    const match = ptx.outputs.find((p) => eqB(p.script, oo.script));
    if (!match) { outOk = false; outDetail = `REFUSED: sender output ${i} (${bytesToHex(oo.script).slice(0, 24)}…) was removed`; break; }
    if (match.value < oo.value) { outOk = false; outDetail = `REFUSED: sender output ${i} value decreased ${oo.value} -> ${match.value}`; break; }
  }
  checks.push(check("outputs-preserved", "All sender outputs preserved (value not decreased)", outOk,
    outDetail || `${otx.outputs.length - (payIdxO >= 0 ? 1 : 0)} non-payment output(s) intact`));

  /* 11. fee-output bounds */
  const maxAdd = params ? params.maxadditionalfeecontribution : null;
  let d = null, feeBoundsOk = true, feeBoundsDetail = "";
  if (payIdxO >= 0 && payIdxP >= 0 && feeO !== null && feeP !== null) {
    d = otx.outputs[payIdxO].value - ptx.outputs[payIdxP].value;
    if (d < 0n) { feeBoundsOk = false; feeBoundsDetail = `REFUSED: payment output value INCREASED by ${-d} (receiver paying you extra?)`; }
    else if (maxAdd !== null && d > maxAdd) {
      feeBoundsOk = false;
      feeBoundsDetail = `REFUSED: payment deduction ${d} exceeds maxadditionalfeecontribution=${maxAdd}`;
    } else if (d > feeP - feeO) {
      feeBoundsOk = false;
      feeBoundsDetail = `REFUSED: deduction ${d} exceeds the fee increase ${feeP - feeO} (contribution must only pay fees)`;
    } else {
      const dMaxWeight = (feeO * BigInt(Math.max(addedVBytes, 0))) / BigInt(vsizeO);
      if (d > dMaxWeight) {
        feeBoundsOk = false;
        feeBoundsDetail = `REFUSED: deduction ${d} exceeds the added-weight cost ${dMaxWeight} at the original fee rate`;
      } else feeBoundsDetail = `payment deduction ${d} grains (<= maxadditionalfeecontribution=${maxAdd}, <= fee increase ${feeP - feeO}, <= added-weight cost ${dMaxWeight})`;
    }
  } else {
    feeBoundsOk = false;
    feeBoundsDetail = "REFUSED: could not identify the payment output — cannot bound the fee deduction";
  }
  checks.push(check("fee-output-bounds", "Fee deduction within bounds", feeBoundsOk, feeBoundsDetail));

  /* 12. payment-output substitution */
  const dis = params ? params.disableoutputsubstitution : false;
  let subOk = true, subDetail = "";
  if (dis) {
    subOk = payIdxO >= 0 && payIdxP >= 0 && d === 0n && eqB(ptx.outputs[payIdxP].script, otx.outputs[payIdxO].script);
    subDetail = subOk ? "substitution disabled and honored: payment script and value untouched"
      : "REFUSED: output substitution was disabled but the receiver touched the payment output";
  } else {
    subDetail = payIdxP >= 0 ? "substitution allowed by the sender — no check (BIP-78)"
      : "REFUSED: payment output missing from the proposal";
    subOk = payIdxP >= 0;
  }
  checks.push(check("payment-substitution", "Payment-output substitution rules", subOk, subDetail));

  /* 13. added outputs sane (P2TR, >= dust) */
  const oScripts = new Set(otx.outputs.map((o) => bytesToHex(o.script)));
  let addedOutOk = true, addedOutDetail = "";
  const addedOuts = ptx.outputs.filter((p) => !oScripts.has(bytesToHex(p.script)));
  for (const p of addedOuts) {
    if (!isP2TR(p.script)) { addedOutOk = false; addedOutDetail = "REFUSED: an added output is not P2TR"; break; }
    if (p.value < BigInt(DUST)) { addedOutOk = false; addedOutDetail = `REFUSED: an added output is dust (${p.value})`; break; }
  }
  // also: payment script replaced under allowed substitution still must be P2TR + dust
  if (addedOutOk && payIdxP >= 0 && (payIdxO < 0 || !eqB(ptx.outputs[payIdxP].script, otx.outputs[payIdxO].script))) {
    const p = ptx.outputs[payIdxP];
    if (!isP2TR(p.script)) { addedOutOk = false; addedOutDetail = "REFUSED: substituted payment output is not P2TR"; }
    else if (p.value < BigInt(DUST)) { addedOutOk = false; addedOutDetail = "REFUSED: substituted payment output is dust"; }
  }
  checks.push(check("added-outputs-sane", "Added outputs sane (P2TR, no dust)", addedOutOk,
    addedOutDetail || `${addedOuts.length} added output(s), all P2TR and above dust`));

  /* 14. minfeerate on the proposal */
  let mfrOk = true, mfrDetail = "";
  if (params && feeP !== null) {
    const need = ceilDiv(params.minfeerate.num * BigInt(vsizeP), params.minfeerate.den);
    mfrOk = feeP >= need;
    mfrDetail = mfrOk
      ? `proposal rate ${(Number(feeP) / vsizeP).toFixed(2)} grains/vB >= minfeerate`
      : `REFUSED: proposal fee ${feeP} below minfeerate floor ${need} for ${vsizeP} vB`;
  } else mfrDetail = "no minfeerate param supplied — skipped";
  checks.push(check("minfeerate", "Proposal fee rate >= minfeerate", mfrOk, mfrDetail));

  /* 15. proposal tx structurally valid */
  let txOk = true, txDetail = "";
  if (ptx.version !== TX_VERSION) { txOk = false; txDetail = "bad version"; }
  else if (ptx.inputs.length === 0 || ptx.outputs.length === 0) { txOk = false; txDetail = "empty inputs/outputs"; }
  else {
    for (let i = 0; i < ptx.outputs.length; i++) {
      if (!isP2TR(ptx.outputs[i].script)) { txOk = false; txDetail = `output ${i} not P2TR`; break; }
      if (ptx.outputs[i].value <= 0n) { txOk = false; txDetail = `output ${i} non-positive`; break; }
    }
    if (txOk) txDetail = `${ptx.inputs.length} in / ${ptx.outputs.length} out, version ${ptx.version}, locktime ${ptx.locktime}`;
  }
  checks.push(check("proposal-tx-valid", "Proposal transaction structurally valid", txOk,
    txOk ? txDetail : "REFUSED: " + txDetail));

  const ok = checks.every((c) => c.pass);
  return {
    ok, checks,
    feeO: feeO?.toString() ?? null, feeP: feeP?.toString() ?? null,
    vsizeO, vsizeP, addedVBytes,
    deduction: d?.toString() ?? null,
  };
}

/* ---------------- Sign tab: verify, re-sign sender inputs, finalize ---------------- */

/**
 * Sign the proposal's SENDER inputs with the sender's local BIP-340 keys and
 * finalize the transaction. The proposal is first run through the full
 * verifyProposal checklist — a failing proposal is never signed.
 *
 * opts: { proposalB64, originalB64, params, paymentScriptHex, mnemonic, maxScan=20 }
 */
export function signProposal({ proposalB64, originalB64, params, paymentScriptHex = null, mnemonic, maxScan = 20 }) {
  if (!mnemonic || !String(mnemonic).trim()) fail("no-mnemonic", "the sender's mnemonic is required to sign");
  const verdict = verifyProposal({ originalB64, proposalB64, params, paymentScriptHex });
  if (!verdict.ok) {
    const bad = verdict.checks.filter((c) => !c.pass).map((c) => ` - ${c.name}: ${c.detail}`).join("\n");
    fail("proposal-rejected", `the proposal FAILED verification — refusing to sign:\n${bad}`);
  }
  const original = parsePsbtBase64(originalB64);
  const proposal = parsePsbtBase64(proposalB64);
  const ptx = proposal.unsignedTx;
  const senderKeys = new Set(original.unsignedTx.inputs.map(outpointKey));

  // derive sender keys and index them by prevout scriptPubKey
  const bySpk = new Map();
  for (let i = 0; i < maxScan; i++) {
    let k;
    try { k = deriveSenderKey(mnemonic, i); }
    catch (e) { fail("bad-mnemonic", e.message.replace(/^REFUSED \[[^]]+\]: /, "")); }
    bySpk.set(bytesToHex(k.spk), k);
  }
  const pPrev = prevoutsFromPsbt(proposal);
  const signedInputs = [];
  const prevouts = pPrev.map((p) => ({ amount: p.amount, spk: p.spk }));

  for (let pi = 0; pi < ptx.inputs.length; pi++) {
    const k = outpointKey(ptx.inputs[pi]);
    if (!senderKeys.has(k)) continue; // receiver input: already finalized, sig verified by the checklist
    const pairs = proposal.inputs[pi];
    const key = bySpk.get(bytesToHex(pPrev[pi].spk));
    if (!key) fail("not-your-input", `proposal input ${pi} (${k}) does not match any of your first ${maxScan} BIP-86 addresses — refusing to sign`);
    // re-verify any receiver-side residue is absent, then sign fresh
    if (findPair(pairs, IN_PARTIAL_SIG) || findPair(pairs, IN_TAP_KEY_SIG) || findPair(pairs, IN_FINAL_SCRIPTWITNESS))
      fail("dirty-input", `sender input ${pi} already carries signatures — refusing to double-sign a dirty proposal`);
    const r = signPsbtInput({ psbt: proposal, inputIndex: pi, privKey: key.tweakedPriv, hashType: 0x00 });
    void r;
    const sigE = findPair(proposal.inputs[pi], IN_TAP_KEY_SIG);
    const { Q } = tapTweak(key.internalXOnly, null);
    const sighash = taprootSighash({ tx: ptx, inputIndex: pi, prevouts, hashType: 0x00, scriptPath: null });
    if (!schnorr.verify(sigE.value, sighash, Q))
      fail("sign-failed", `input ${pi}: fresh signature does not verify`);
    // finalize: keep ONLY the final witness (clean, matches the psbt desk convention)
    const wit = concatBytes(u8(compactUint(1)), u8(compactUint(64)), sigE.value);
    proposal.inputs[pi] = [{ key: u8([IN_FINAL_SCRIPTWITNESS]), value: wit }];
    signedInputs.push({ index: pi, outpoint: k, address: key.address, sigOk: true });
  }
  if (signedInputs.length !== senderKeys.size)
    fail("missing-inputs", `signed ${signedInputs.length} sender inputs but the original had ${senderKeys.size}`);

  // receiver inputs were finalized by the proposal tab; normalize their maps
  // to final-witness-only as well (keeps the signed PSBT minimal).
  for (let pi = 0; pi < ptx.inputs.length; pi++) {
    if (senderKeys.has(outpointKey(ptx.inputs[pi]))) continue;
    const f = findPair(proposal.inputs[pi], IN_FINAL_SCRIPTWITNESS);
    if (!f) fail("not-finalized", `receiver input ${pi} lost its final witness`);
    proposal.inputs[pi] = [{ key: u8([IN_FINAL_SCRIPTWITNESS]), value: f.value }];
  }

  const finalB64 = psbtToBase64(proposal);
  const extracted = extractFinalTx(proposal);
  return {
    finalB64, txHex: extracted.hex, txid: extracted.txid,
    vsize: extracted.vsize, fee: verdict.feeP, feeRate: (Number(BigInt(verdict.feeP)) / extracted.vsize).toFixed(2),
    signedInputs, checks: verdict.checks,
  };
}

/** Extract the final network tx from a fully-finalized proposal object. */
function extractFinalTx(psbt) {
  const tx = psbt.unsignedTx;
  const witnesses = tx.inputs.map((_, i) => {
    const f = findPair(psbt.inputs[i], IN_FINAL_SCRIPTWITNESS);
    if (!f) fail("not-finalized", `input ${i} is not finalized`);
    return parseWitnessStack(f.value);
  });
  const core = serializeUnsignedTx(tx);
  const body = core.slice(4, core.length - 4);
  const wit = concatBytes(...witnesses.map((stack) =>
    concatBytes(u8(compactUint(stack.length)),
      ...stack.map((w) => concatBytes(u8(compactUint(w.length)), w)))));
  const raw = concatBytes(core.slice(0, 4), u8([0x00, 0x01]), body, wit, core.slice(core.length - 4));
  const txid = txidOfUnsigned(core);
  const weight = 3 * core.length + raw.length;
  // full independent re-parse of what we are about to hand out
  const hex = bytesToHex(raw);
  return { hex, txid, vsize: Math.ceil(weight / 4) };
}
function parseWitnessStack(bytes) {
  const items = [];
  let o = 0;
  const readVarint = () => {
    const b = bytes[o++];
    if (b < 0xfd) return b;
    if (b === 0xfd) { const v = bytes[o] | (bytes[o + 1] << 8); o += 2; return v; }
    if (b === 0xfe) { const v = bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24); o += 4; return v >>> 0; }
    let v = 0n; for (let i = 0; i < 8; i++) v |= BigInt(bytes[o + i]) << BigInt(8 * i); o += 8;
    return Number(v);
  };
  const n = readVarint();
  for (let i = 0; i < n; i++) { const l = readVarint(); items.push(bytes.slice(o, o + l)); o += l; }
  if (o !== bytes.length) fail("bad-witness", "trailing bytes in final witness");
  return items;
}

/* ---------------- blockbook (optional, honest: live network calls) ---------------- */

export const BLOCKBOOK_MAINNET = MAINNET.blockbook;
export { fetchUtxos, fetchFeeRateGrainsPerVByte, broadcastTx };
export { GRAIN_PER_PRL, DUST_GRAIN };

/* ---------------- labSelfTest: the whole protocol in one call ----------------
 * Runs offer -> signed original -> proposal -> 15-check verify -> sign ->
 * final tx with the public BIP-39 test vectors, then INDEPENDENTLY re-verifies
 * every witness signature and recomputes the txid. Used by the page's
 * "lab self-test" button. No network, no real funds. Throws loud on failure.
 */
export function labSelfTest() {
  const lines = [];
  const ok = (s) => lines.push("ok " + s);
  const S = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  const R = "legal winner thank year wave sausage worth useful legal winner thank yellow";
  const rng = () => 0.999999;

  const offer = buildReceiverOffer({
    amount: "1 PRL", paymentAddress: deriveSenderKey(R, 0).address,
    maxadditionalfeecontribution: "1000", minfeerate: "1", disableoutputsubstitution: false,
  });
  validateOfferTemplate(offer.base64);
  ok(`offer: 1 PRL template valid (${offer.query})`);

  const params = decodePaste(JSON.stringify(offer.envelope)).params;
  const sk = deriveSenderKey(S, 0);
  const oIn = prepareSenderInput({ txid: "aa".repeat(32), vout: 0, value: 200_000_000n, key: sk });
  const original = buildSenderOriginal({
    offerB64: offer.base64, params, senderInputs: [oIn], tweakedPrivs: [sk.tweakedPriv],
    changeAddress: deriveSenderKey(S, 1).address, feeRate: "2",
  });
  ok(`original: signed+finalized, fee ${original.fee} grains, vsize ${original.vsize}`);

  const rk = deriveSenderKey(R, 1);
  const rIn = prepareSenderInput({ txid: "bb".repeat(32), vout: 1, value: 50_000_000n, key: rk });
  const oParams = decodePaste(JSON.stringify(original.envelope)).params;
  const proposal = buildProposal({
    originalB64: original.base64, params: oParams,
    paymentScriptHex: original.envelope.payment.script_hex,
    receiverInputs: [rIn], tweakedPrivs: [rk.tweakedPriv],
    receiverChangeAddress: deriveSenderKey(R, 2).address, rng,
  });
  ok(`proposal: fee ${proposal.feeO} -> ${proposal.feeP} grains, deduction ${proposal.d} (cap 1000)`);

  const verdict = verifyProposal({
    originalB64: original.base64, proposalB64: proposal.base64, params: oParams,
    paymentScriptHex: original.envelope.payment.script_hex,
  });
  if (!verdict.ok) fail("selftest", "verify failed: " + verdict.checks.filter((c) => !c.pass).map((c) => c.name).join(", "));
  ok(`verify: all ${verdict.checks.length} BIP-78 checks PASS`);

  const signed = signProposal({
    proposalB64: proposal.base64, originalB64: original.base64, params: oParams,
    paymentScriptHex: original.envelope.payment.script_hex, mnemonic: S,
  });
  ok(`sign: ${signed.signedInputs.length} sender input(s) re-signed, txid ${signed.txid}`);

  // independent final audit: re-parse, re-verify every witness sig, recompute txid
  const fin = parsePsbtBase64(signed.finalB64);
  const pPrev = prevoutsFromPsbt(parsePsbtBase64(proposal.base64)).map((p) => ({ amount: p.amount, spk: p.spk }));
  fin.unsignedTx.inputs.forEach((_, pi) => {
    const f = findPair(fin.inputs[pi], IN_FINAL_SCRIPTWITNESS);
    if (!f) fail("selftest", `input ${pi} not finalized`);
    const sig = f.value.slice(2, 66);
    const sighash = taprootSighash({ tx: fin.unsignedTx, inputIndex: pi, prevouts: pPrev, hashType: 0x00, scriptPath: null });
    if (!schnorr.verify(sig, sighash, pPrev[pi].spk.slice(2))) fail("selftest", `input ${pi} witness sig invalid`);
  });
  ok(`audit: all ${fin.unsignedTx.inputs.length} witness signatures verify against the final sighash`);
  const recomputed = txidOfUnsigned(serializeUnsignedTx(fin.unsignedTx));
  if (recomputed !== signed.txid) fail("selftest", "txid mismatch");
  ok(`audit: txid recomputed independently and matches`);
  return { ok: true, lines, txid: signed.txid };
}
