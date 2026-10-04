// Pearl Subscribe — standing orders for PRL.
//
// Recurring PRL payments built from pre-signed nLockTime Taproot transactions.
// Pearl has no smart contracts, so a subscription is a *consent structure*,
// not on-chain enforcement:
//
//   1. Subscriber and merchant agree on terms (merchant, amount/period, period
//      length in blocks, number of periods, first-payment height, fee rate).
//   2. Subscriber funds ONE transaction with N outputs — one per period —
//      each worth (amount + fee reserve), all to the subscriber's own Taproot
//      keypath address (the "anchor").
//   3. Subscriber locally signs N payment transactions, one per funding
//      output: input = funding output i, outputs = [merchant amount, change ->
//      anchor], nLockTime = startHeight + i*periodBlocks, sequence =
//      0xfffffffe (so the locktime is consensus-enforced). Keys are wiped.
//   4. The signed bundle goes to the merchant, who broadcasts payment i once
//      its locktime passes.
//   5. Cancel: the subscriber double-spends any not-yet-due funding output
//      back to themselves — the pre-signed payment can never confirm.
//
// Crypto note: keypath signing reuses the audited Pearl Sign primitives
// (BIP-340 Schnorr, BIP-341 keypath sighash, bech32m, BIP-86 keys). The one
// mechanical extension is threading nLockTime through the audited keypath
// builder — `buildKeypathTxLocktime` is a verbatim copy of audited
// `buildKeypathTxEx` with the hardcoded `u32le(0)` locktime replaced by a
// validated parameter in the three places consensus touches it (txid preimage,
// TapSighash message, wire serialization). It is pinned by tests: at
// locktime=0 it must be byte-identical to the audited builder, and the test
// suite independently re-derives the TapSighash digest from the documented
// BIP-341 field layout with node:crypto and checks the emitted signature
// against it.

import {
  NETWORKS,
  GRAIN_PER_PRL,
  DUST_GRAIN,
  decodeBech32m,
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
  keypathTxVBytes,
  u32le,
  u64le,
  varint,
  txidLE,
} from "../../sign/src/crypto.js";
import {
  fetchUtxos,
  fetchFeeRateGrainsPerVByte,
  broadcastTx,
} from "../../sign/src/crypto.js";
import {
  SIGHASH_DEFAULT,
  buildKeypathTxEx,
  verifySignedTx,
  describeSpk,
  parseUtxoList,
  selectCoins,
  decodeRawTx,
  parsePRL,
  fmtPRL,
} from "../../sign/src/sign-core.js";

export { NETWORKS, GRAIN_PER_PRL, DUST_GRAIN, parsePRL, fmtPRL, selectCoins, verifySignedTx, decodeRawTx, buildKeypathTxEx, fetchUtxos, fetchFeeRateGrainsPerVByte, broadcastTx, parseUtxoList, describeSpk, p2trScriptPubKey, tweakKeypath, bytesToHex, hexToBytes };

export const DESCRIPTOR_VERSION = "pearl-sub:v1";
export const BUNDLE_VERSION = "pearl-sub-bundle:v1";
export const BLOCK_TIME_S = 194; // upstream node/chaincfg/params.go TargetTimePerBlock
export const MAX_PERIODS = 60;
export const MIN_PERIOD_BLOCKS = 144; // ~7.75h at 194s/block
export const LOCKTIME_SEQ = 0xfffffffe; // < 0xffffffff: nLockTime is enforced
export const FINAL_SEQ = 0xffffffff;
export const MAX_LOCKTIME = 500_000_000; // below this = block height

export const PERIOD_PRESETS = [
  { key: "weekly", label: "Weekly", blocks: 3118, approx: "≈ 7 days" },
  { key: "biweekly", label: "Every 2 weeks", blocks: 6236, approx: "≈ 14 days" },
  { key: "monthly", label: "Monthly", blocks: 13361, approx: "≈ 30 days" },
];
// blocks/day = 86400/194 = 445.36 → weekly 3117.5→3118, biweekly 6235→6236, monthly(30d) 13360.8→13361

/* ---------------- canonical JSON + fingerprints (not crypto) ---------------- */

export function canonicalJson(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number" || typeof v === "boolean") return JSON.stringify(v);
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  const keys = Object.keys(v).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(v[k])).join(",") + "}";
}

/** 64-bit fingerprint: first 8 bytes of SHA-256 over the canonical form. */
export function fingerprintOf(canonical) {
  const h = sha256(new TextEncoder().encode(canonical));
  return bytesToHex(h.slice(0, 8));
}

/* ---------------- address helpers ---------------- */

export function addressToProgram(addr, network) {
  const d = decodeBech32m(addr, network.hrp);
  if (d.version !== 1) throw new Error(`not a Taproot (v1) address: ${addr.slice(0, 18)}…`);
  if (d.program.length !== 32) throw new Error("bad Taproot program length");
  return d.program;
}

/* ---------------- subscriber key handling ---------------- */

export function subscriberKeyFromInput(secret, network) {
  const s = String(secret || "").trim();
  if (!s) throw new Error("key is empty");
  let w;
  if (/^[0-9a-fA-F]{64}$/.test(s)) w = walletFromPriv(hexToBytes(s.toLowerCase()), network);
  else if (s.split(/\s+/).length >= 12) w = walletFromMnemonic(s, network);
  else {
    try { w = walletFromWIF(s, network); }
    catch { throw new Error("key not recognized: paste 64-hex, a BIP-39 mnemonic, or WIF"); }
  }
  return { priv: w.priv, internalXOnly: w.internalXOnly, keypathAddress: w.address };
}

export function assertKeyMatchesAnchor(key, anchor, network) {
  const prog = addressToProgram(anchor, network);
  const tweaked = tweakKeypath(key.internalXOnly).tweakedX;
  if (bytesToHex(tweaked) !== bytesToHex(prog)) {
    throw new Error("KEY MISMATCH: this key does not control the anchor address — refusing to sign");
  }
}

export function wipeKey(key) {
  if (key && key.priv) key.priv.fill(0);
}

/* ---------------- terms validation ---------------- */

export function validateLocktime(h) {
  if (!Number.isInteger(h) || h < 1 || h >= MAX_LOCKTIME) {
    throw new Error(`locktime must be a block height in 1..${MAX_LOCKTIME - 1}`);
  }
}

export function validateTerms(t) {
  const errs = [];
  const network = NETWORKS[t.network] || null;
  if (!network) errs.push(`unknown network "${t.network}" (expected "mainnet" or "testnet")`);
  let merchantProg = null, anchorProg = null;
  if (network) {
    try { merchantProg = addressToProgram(t.merchant, network); }
    catch (e) { errs.push("merchant address: " + e.message); }
    try { anchorProg = addressToProgram(t.anchor, network); }
    catch (e) { errs.push("subscriber (anchor) address: " + e.message); }
    if (merchantProg && anchorProg && bytesToHex(merchantProg) === bytesToHex(anchorProg)) {
      errs.push("merchant and subscriber anchor are the same address — a subscription must pay someone else");
    }
  }
  if (!Number.isSafeInteger(t.amountGrains) || t.amountGrains < DUST_GRAIN) {
    errs.push(`amount must be ≥ dust (${DUST_GRAIN} grains ≈ ${fmtPRL(BigInt(DUST_GRAIN))} PRL)`);
  }
  if (!Number.isInteger(t.periodBlocks) || t.periodBlocks < MIN_PERIOD_BLOCKS) {
    errs.push(`period must be ≥ ${MIN_PERIOD_BLOCKS} blocks (≈ ${(MIN_PERIOD_BLOCKS * BLOCK_TIME_S / 3600).toFixed(1)}h)`);
  }
  if (!Number.isInteger(t.periods) || t.periods < 1 || t.periods > MAX_PERIODS) {
    errs.push(`periods must be 1..${MAX_PERIODS}`);
  }
  try { validateLocktime(t.startHeight); } catch (e) { errs.push("start height: " + e.message); }
  if (!Number.isInteger(t.feeRate) || t.feeRate < 1 || t.feeRate > 10000) {
    errs.push("fee rate must be an integer 1..10000 grains/vB");
  }
  if (errs.length) throw new Error("invalid terms:\n- " + errs.join("\n- "));
  return { network, merchantProg, anchorProg };
}

export function periodLocktimes(startHeight, periodBlocks, periods) {
  const out = [];
  for (let i = 0; i < periods; i++) {
    const h = startHeight + i * periodBlocks;
    if (h >= MAX_LOCKTIME) throw new Error(`period ${i + 1} locktime ${h} exceeds height-locktime range`);
    out.push(h);
  }
  return out;
}

/* ---------------- descriptor (tamper-evident terms) ---------------- */

export function makeDescriptor(raw) {
  const t = {
    network: raw.network, merchant: raw.merchant, anchor: raw.anchor,
    amountGrains: raw.amountGrains, periodBlocks: raw.periodBlocks,
    periods: raw.periods, startHeight: raw.startHeight, feeRate: raw.feeRate,
  };
  const { network } = validateTerms(t);
  const canonical = canonicalJson({ v: DESCRIPTOR_VERSION, ...t });
  const fingerprint = fingerprintOf(canonical);
  return {
    descriptor: { v: DESCRIPTOR_VERSION, ...t, fingerprint },
    canonical, fingerprint, network,
    schedule: periodLocktimes(t.startHeight, t.periodBlocks, t.periods),
  };
}

export function parseDescriptor(input) {
  let obj;
  try { obj = typeof input === "string" ? JSON.parse(input) : input; }
  catch { throw new Error("descriptor is not valid JSON"); }
  if (!obj || obj.v !== DESCRIPTOR_VERSION) throw new Error(`not a ${DESCRIPTOR_VERSION} descriptor`);
  const { fingerprint, ...rest } = obj;
  const canonical = canonicalJson({ v: DESCRIPTOR_VERSION, ...rest });
  if (fingerprintOf(canonical) !== fingerprint) {
    throw new Error("DESCRIPTOR TAMPERED: fingerprint mismatch — these terms were altered after signing");
  }
  const { network } = validateTerms(rest);
  return { descriptor: obj, canonical, fingerprint, network, schedule: periodLocktimes(rest.startHeight, rest.periodBlocks, rest.periods) };
}

/* ---------------- fee + funding plan ---------------- */

export function paymentVBytes() { return keypathTxVBytes(1, 2); } // 1 in, 2 out: merchant + change
export function cancelVBytes() { return keypathTxVBytes(1, 1); }  // 1 in, 1 out: reclaim

/** Exact grains reserved per period output to cover the future payment fee. */
export function feeReserveGrains(feeRate) {
  return BigInt(paymentVBytes()) * BigInt(feeRate);
}

/** The N funding outputs: each = amount + fee reserve, all to the anchor. */
export function planFunding(terms) {
  validateTerms(terms);
  const reserve = feeReserveGrains(terms.feeRate);
  const perOutput = BigInt(terms.amountGrains) + reserve;
  const outputs = [];
  for (let i = 0; i < terms.periods; i++) outputs.push({ vout: i, address: terms.anchor, value: perOutput });
  return {
    outputs,
    perOutputGrains: perOutput,
    feeReserveGrains: reserve,
    paymentVBytes: paymentVBytes(),
    totalGrains: perOutput * BigInt(terms.periods),
  };
}

/* ---------------- keypath builder with nLockTime ----------------
 * Mechanical generalization of audited buildKeypathTxEx: the hardcoded
 * u32le(0) locktime becomes a validated parameter everywhere consensus
 * touches it (txid preimage, TapSighash message, wire serialization).
 * Pinned by byte-equality with the audited builder at locktime=0. */

function keypathSigDigestLocktime(network, inputs, outputs, sequence, locktime, idx, hashType = SIGHASH_DEFAULT) {
  const sha = (b) => sha256(b);
  if (!Number.isInteger(locktime) || locktime < 0 || locktime > 0xffffffff) throw new Error("bad locktime");
  if (!Number.isInteger(idx) || idx < 0 || idx >= inputs.length) throw new Error("bad input index");
  if (hashType !== SIGHASH_DEFAULT) throw new Error("unsupported hash_type (only SIGHASH_DEFAULT)");
  for (const i of inputs) {
    if (!/^[0-9a-f]{64}$/i.test(i.txid || "")) throw new Error("bad input txid");
    if (!Number.isInteger(i.vout) || i.vout < 0) throw new Error("bad input vout");
    if (!Number.isSafeInteger(i.value) || i.value <= 0) throw new Error("bad input value");
    if (!(i.spk instanceof Uint8Array) || i.spk.length === 0) throw new Error("bad input spk");
  }
  const msg = [0x00, hashType, ...u32le(network.txVersion), ...u32le(locktime)];
  msg.push(...sha(Uint8Array.from(inputs.flatMap((i) => [...txidLE(i.txid), ...u32le(i.vout)]))));
  msg.push(...sha(Uint8Array.from(inputs.flatMap((i) => u64le(i.value)))));
  msg.push(...sha(Uint8Array.from(inputs.flatMap((i) => [...varint(i.spk.length), ...i.spk]))));
  msg.push(...sha(Uint8Array.from(inputs.flatMap(() => u32le(sequence)))));
  msg.push(...sha(Uint8Array.from(outputs.flatMap((o) => {
    const s = p2trScriptPubKey(o.program);
    return [...u64le(o.value), ...varint(s.length), ...s];
  }))));
  msg.push(0x00); // spend_type: keypath, no annex
  msg.push(...u32le(idx));
  return taggedHash("TapSighash", Uint8Array.from(msg));
}

/** Build + keypath-sign a tx with explicit nLockTime.
 *  inputs: [{txid, vout, value, priv, internalXOnly}]; outputs: [{program, value}]. */
export function buildKeypathTxLocktime(network, inputs, outputs, { locktime = 0, sequence = FINAL_SEQ } = {}) {
  if (!Number.isInteger(locktime) || locktime < 0 || locktime > 0xffffffff) throw new Error("bad locktime");
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > 0xffffffff) throw new Error("bad sequence");
  if (!inputs.length || !outputs.length) throw new Error("need inputs and outputs");
  for (const o of outputs) {
    if (!(o.program instanceof Uint8Array) || o.program.length !== 32) throw new Error("bad output program");
    if (!Number.isSafeInteger(o.value) || o.value <= 0) throw new Error("bad output value");
  }
  const inDigest = inputs.map((i) => {
    if (!(i.priv instanceof Uint8Array) || i.priv.length !== 32) throw new Error("input needs 32-byte priv");
    if (!(i.internalXOnly instanceof Uint8Array) || i.internalXOnly.length !== 32) throw new Error("input needs internalXOnly");
    return {
      txid: i.txid, vout: i.vout, value: i.value,
      spk: p2trScriptPubKey(tweakKeypath(i.internalXOnly).tweakedX),
    };
  });
  const core = [...u32le(network.txVersion), ...varint(inputs.length)];
  for (const inp of inputs) core.push(...txidLE(inp.txid), ...u32le(inp.vout), ...varint(0), ...u32le(sequence));
  core.push(...varint(outputs.length));
  for (const out of outputs) {
    const s = p2trScriptPubKey(out.program);
    core.push(...u64le(out.value), ...varint(s.length), ...s);
  }
  core.push(...u32le(locktime));
  const txid = bytesToHex(sha256(sha256(Uint8Array.from(core))).reverse());

  const sigs = inputs.map((inp, i) => {
    const digest = keypathSigDigestLocktime(network, inDigest, outputs, sequence, locktime, i);
    const tweaked = tweakPrivKeypath(inp.priv, inp.internalXOnly);
    return schnorr.sign(digest, tweaked, new Uint8Array(32));
  });

  const full = [...u32le(network.txVersion), 0x00, 0x01, ...varint(inputs.length)];
  for (const inp of inputs) full.push(...txidLE(inp.txid), ...u32le(inp.vout), ...varint(0), ...u32le(sequence));
  full.push(...varint(outputs.length));
  for (const out of outputs) {
    const s = p2trScriptPubKey(out.program);
    full.push(...u64le(out.value), ...varint(s.length), ...s);
  }
  for (const sig of sigs) full.push(...varint(1), ...varint(sig.length), ...sig);
  full.push(...u32le(locktime));
  return { txid, hex: bytesToHex(Uint8Array.from(full)) };
}

/* ---------------- locktime-aware signature verification ----------------
 * Mechanical generalization of audited verifySignedTx: the audited verifier
 * reads sequence and hash_type from the wire but hardcodes nLockTime=0 in the
 * recomputed digest. This variant reads nLockTime from the wire too and
 * recomputes the digest with it — verifying the signature against what the
 * transaction actually commits to. Pinned by tests: at locktime=0 it must
 * agree with the audited verifier on every input. */

export function verifySignedTxLocktime(network, signedHex, prevouts) {
  const dec = decodeRawTx(signedHex);
  if (!dec.witness) throw new Error("no witness data — nothing to verify");
  if (prevouts.length !== dec.inputs.length) throw new Error("prevout count mismatch");
  const results = [];
  for (let i = 0; i < dec.inputs.length; i++) {
    const stack = dec.witness[i];
    if (stack.length !== 1) {
      results.push({ index: i, ok: false, reason: `expected 1 witness item (keypath), got ${stack.length}` });
      continue;
    }
    const wit = stack[0];
    let sig, hashType;
    if (wit.length === 64) { sig = wit; hashType = SIGHASH_DEFAULT; }
    else if (wit.length === 65) { sig = wit.slice(0, 64); hashType = wit[64]; }
    else { results.push({ index: i, ok: false, reason: `bad witness length ${wit.length}` }); continue; }
    try {
      const po = prevouts[i];
      const d = describeSpk(po.spk, network);
      if (d.type !== "P2TR") {
        results.push({ index: i, ok: false, reason: `prevout is ${d.type}, keypath verify needs P2TR` });
        continue;
      }
      const digestInputs = prevouts.map((p, k) => ({
        txid: dec.inputs[k].txid, vout: dec.inputs[k].vout, value: p.value, spk: p.spk,
      }));
      const digestOutputs = dec.outputs.map((o) => ({
        program: describeSpk(o.spk, network).program ?? new Uint8Array(32),
        value: Number(o.value),
      }));
      const digest = keypathSigDigestLocktime(
        network, digestInputs, digestOutputs, dec.inputs[i].sequence, dec.locktime, i, hashType
      );
      const ok = schnorr.verify(sig, digest, d.program);
      results.push({ index: i, ok, reason: ok ? "BIP-341 keypath signature valid" : "signature does NOT verify" });
    } catch (e) {
      results.push({ index: i, ok: false, reason: String(e.message || e) });
    }
  }
  return results;
}

/* ---------------- payment transactions ---------------- */

/** Unsigned payment plan for period i (txid is witness-independent). */
export function paymentTxPlan(terms, fundingTxid, i) {
  validateTerms(terms);
  if (!/^[0-9a-f]{64}$/i.test(fundingTxid || "")) throw new Error("bad funding txid");
  if (!Number.isInteger(i) || i < 0 || i >= terms.periods) throw new Error("bad period index");
  const { network, merchantProg, anchorProg } = validateTerms(terms);
  const reserve = feeReserveGrains(terms.feeRate);
  const inputValue = Number(BigInt(terms.amountGrains) + reserve);
  const fee = paymentVBytes() * terms.feeRate;
  let change = Number(reserve) - fee;
  let dustAbsorbed = 0;
  if (change > 0 && change < DUST_GRAIN) { dustAbsorbed = change; change = 0; }
  const locktime = terms.startHeight + i * terms.periodBlocks;
  validateLocktime(locktime);
  const outputs = [{ program: merchantProg, value: terms.amountGrains }];
  if (change > 0) outputs.push({ program: anchorProg, value: change });
  // witness-independent txid via the audited-shape preimage
  const core = [...u32le(network.txVersion), ...varint(1),
    ...txidLE(fundingTxid), ...u32le(i), ...varint(0), ...u32le(LOCKTIME_SEQ),
    ...varint(outputs.length)];
  for (const o of outputs) {
    const s = p2trScriptPubKey(o.program);
    core.push(...u64le(o.value), ...varint(s.length), ...s);
  }
  core.push(...u32le(locktime));
  const txid = bytesToHex(sha256(sha256(Uint8Array.from(core))).reverse());
  return {
    period: i + 1, vout: i, locktime, sequence: LOCKTIME_SEQ,
    inputValue, feeGrains: fee + dustAbsorbed, dustAbsorbedGrains: dustAbsorbed,
    merchantValue: terms.amountGrains, changeValue: change,
    txid,
    outputs: outputs.map((o) => ({ address: o.program === merchantProg ? terms.merchant : terms.anchor, value: o.value })),
  };
}

/** Sign every period payment locally. Returns {payments: [{period, locktime, txid, hex}]}. Key wiped. */
export function signPaymentTxs(terms, fundingTxid, key) {
  const { network } = makeDescriptor(terms); // validates terms + descriptor shape
  const { merchantProg, anchorProg } = validateTerms(terms);
  assertKeyMatchesAnchor(key, terms.anchor, network);
  const payments = [];
  const anchorSpk = p2trScriptPubKey(anchorProg);
  for (let i = 0; i < terms.periods; i++) {
    const plan = paymentTxPlan(terms, fundingTxid, i);
    const outs = [{ program: merchantProg, value: plan.merchantValue }];
    if (plan.changeValue > 0) outs.push({ program: anchorProg, value: plan.changeValue });
    const built = buildKeypathTxLocktime(network, [{
      txid: fundingTxid, vout: i, value: plan.inputValue,
      priv: key.priv, internalXOnly: key.internalXOnly,
    }], outs, { locktime: plan.locktime, sequence: LOCKTIME_SEQ });
    if (built.txid !== plan.txid) throw new Error(`period ${i + 1}: signed txid mismatch — refusing`);
    // per-signature re-verification against the independently decoded wire
    const vr = verifySignedTxLocktime(network, built.hex, [{ value: plan.inputValue, spk: anchorSpk }]);
    if (!vr.every((r) => r.ok)) throw new Error(`period ${i + 1}: signature failed re-verification — refusing`);
    payments.push({ period: i + 1, locktime: plan.locktime, txid: built.txid, hex: built.hex, feeGrains: plan.feeGrains });
  }
  wipeKey(key);
  return { payments };
}

/** Signed bundle handed to the merchant: descriptor + funding txid + signed payments. */
export function makeSignedBundle(terms, fundingTxid, payments) {
  const { descriptor, fingerprint } = makeDescriptor(terms);
  const bundle = {
    v: BUNDLE_VERSION, descriptor, fundingTxid,
    payments: payments.map((p) => ({ period: p.period, locktime: p.locktime, txid: p.txid, hex: p.hex })),
  };
  const canonical = canonicalJson(bundle);
  return { bundle, fingerprint: fingerprintOf(canonical), json: JSON.stringify(bundle, null, 2) };
}

export function parseSignedBundle(input) {
  let b;
  try { b = typeof input === "string" ? JSON.parse(input) : input; }
  catch { throw new Error("bundle is not valid JSON"); }
  if (!b || b.v !== BUNDLE_VERSION) throw new Error(`not a ${BUNDLE_VERSION} bundle`);
  if (!/^[0-9a-f]{64}$/i.test(b.fundingTxid || "")) throw new Error("bundle has bad funding txid");
  if (!Array.isArray(b.payments) || !b.payments.length) throw new Error("bundle has no payments");
  return b;
}

/** Full standalone verification of a signed bundle. Returns {ok, checks[], failures[]}. */
export function verifySignedBundle(input) {
  const failures = [];
  const checks = [];
  const b = parseSignedBundle(input);
  let desc;
  try {
    desc = parseDescriptor(b.descriptor);
    checks.push("descriptor fingerprint valid (terms untampered)");
  } catch (e) { failures.push("descriptor: " + e.message); return { ok: false, checks, failures }; }
  const terms = desc.descriptor;
  const { network, merchantProg, anchorProg } = validateTerms(terms);
  const anchorSpk = p2trScriptPubKey(anchorProg);
  if (b.payments.length !== terms.periods) failures.push(`bundle has ${b.payments.length} payments, terms say ${terms.periods}`);
  const seenTxids = new Set();
  let prevLock = 0;
  for (let pi = 0; pi < b.payments.length; pi++) {
    const p = b.payments[pi];
    // p.period comes from pasted, counterparty-supplied JSON and flows into
    // the check/failure strings the page renders — never interpolate it
    // before proving it is a plain integer (a markup string here was an
    // innerHTML injection into the verifier; app.js also escapes on render).
    if (!p || !Number.isInteger(p.period) || p.period < 1) { failures.push(`payment ${pi + 1}: bad period (not a positive integer)`); continue; }
    const tag = `period ${p.period}`;
    if (!/^[0-9a-f]{64}$/.test(p.txid || "") || !/^[0-9a-f]+$/.test(p.hex || "")) { failures.push(`${tag}: malformed txid/hex`); continue; }
    if (seenTxids.has(p.txid)) { failures.push(`${tag}: duplicate txid`); continue; }
    seenTxids.add(p.txid);
    let dec;
    try { dec = decodeRawTx(p.hex); } catch (e) { failures.push(`${tag}: undecodable — ${e.message}`); continue; }
    if (dec.txid !== p.txid.toLowerCase()) { failures.push(`${tag}: stated txid != wire txid`); continue; }
    if (dec.locktime !== p.locktime) { failures.push(`${tag}: stated locktime != wire locktime`); continue; }
    const plan = paymentTxPlan(terms, b.fundingTxid, p.period - 1);
    if (dec.locktime !== plan.locktime) { failures.push(`${tag}: locktime ${dec.locktime} != schedule ${plan.locktime}`); continue; }
    if (dec.locktime <= prevLock) { failures.push(`${tag}: locktimes not strictly increasing`); continue; }
    prevLock = dec.locktime;
    if (dec.inputs.length !== 1) { failures.push(`${tag}: expected 1 input, got ${dec.inputs.length}`); continue; }
    const inp = dec.inputs[0];
    if (inp.txid !== b.fundingTxid.toLowerCase() || inp.vout !== p.period - 1) { failures.push(`${tag}: input is not funding output ${p.period - 1}`); continue; }
    if (inp.sequence !== LOCKTIME_SEQ) { failures.push(`${tag}: sequence ${inp.sequence.toString(16)} != 0xfffffffe — locktime not enforced`); continue; }
    const vr = verifySignedTxLocktime(network, p.hex, [{ value: plan.inputValue, spk: anchorSpk }]);
    if (!vr.every((r) => r.ok)) { failures.push(`${tag}: signature invalid (${vr.map((r) => r.reason).join("; ")})`); continue; }
    // outputs: merchant gets exactly the amount; change (if any) goes to anchor
    const outs = dec.outputs;
    if (outs.length < 1 || outs.length > 2) { failures.push(`${tag}: expected 1-2 outputs, got ${outs.length}`); continue; }
    const mOut = outs.find((o) => bytesToHex(o.spk) === bytesToHex(p2trScriptPubKey(merchantProg)));
    if (!mOut || Number(mOut.value) !== terms.amountGrains) { failures.push(`${tag}: merchant output != ${fmtPRL(BigInt(terms.amountGrains))} PRL`); continue; }
    const others = outs.filter((o) => o !== mOut);
    if (others.some((o) => bytesToHex(o.spk) !== bytesToHex(anchorSpk))) { failures.push(`${tag}: non-merchant output not to anchor`); continue; }
    if (others.some((o) => Number(o.value) < DUST_GRAIN)) { failures.push(`${tag}: dust change output`); continue; }
    checks.push(`${tag}: locktime ${dec.locktime}, merchant ${fmtPRL(BigInt(terms.amountGrains))} PRL, signature valid`);
  }
  return { ok: failures.length === 0, checks, failures };
}

/* ---------------- cancel ---------------- */

/** Build + sign a cancel tx: reclaim one unspent funding output to the anchor. */
export function buildCancelTx(terms, fundingTxid, periodIndex, key) {
  const { network, anchorProg } = validateTerms(terms);
  assertKeyMatchesAnchor(key, terms.anchor, network);
  const reserve = feeReserveGrains(terms.feeRate);
  const value = Number(BigInt(terms.amountGrains) + reserve);
  const fee = cancelVBytes() * terms.feeRate;
  const out = value - fee;
  if (out < DUST_GRAIN) throw new Error("cancel output would be dust — fee rate too high for this amount");
  const built = buildKeypathTxEx(network, [{
    txid: fundingTxid, vout: periodIndex, value,
    priv: key.priv, internalXOnly: key.internalXOnly,
    spk: p2trScriptPubKey(tweakKeypath(key.internalXOnly).tweakedX),
  }], [{ program: anchorProg, value: out }], SIGHASH_DEFAULT, FINAL_SEQ);
  const vr = verifySignedTxLocktime(network, built.hex, [{ value, spk: p2trScriptPubKey(anchorProg) }]);
  if (!vr.every((r) => r.ok)) throw new Error("cancel signature failed re-verification");
  wipeKey(key);
  return { txid: built.txid, hex: built.hex, feeGrains: fee, reclaimedGrains: out };
}

/* ---------------- chain reads (GET-only) ---------------- */

export async function fetchBlockbookTip(blockbookBase) {
  const r = await fetch(`${blockbookBase.replace(/\/+$/, "")}/api/v2/api`);
  if (!r.ok) throw new Error(`blockbook status ${r.status}`);
  const j = await r.json();
  // blockbook /api/v2/api returns { blockbook: {...}, backend: { blocks, ... } }
  const blocks = j?.backend?.blocks ?? j?.blockbook?.bestHeight;
  if (!Number.isInteger(blocks)) throw new Error("could not read tip height from blockbook");
  return blocks;
}

export async function fetchTxDetail(blockbookBase, txid) {
  const r = await fetch(`${blockbookBase.replace(/\/+$/, "")}/api/v2/tx/${txid}`);
  if (!r.ok) throw new Error(`blockbook tx ${r.status}`);
  return r.json();
}

/** Per-period on-chain status from the funding tx detail. */
export function periodStatuses(terms, fundingDetail, tipHeight, expectedTxids) {
  const vouts = new Map((fundingDetail?.vout || []).map((o) => [o.n, o]));
  return periodLocktimes(terms.startHeight, terms.periodBlocks, terms.periods).map((locktime, i) => {
    const v = vouts.get(i);
    if (!v) return { period: i + 1, locktime, state: "unknown", note: "funding output not found" };
    let state, note;
    if (v.spent) {
      const spentBy = (v.spentTxId || "").toLowerCase();
      if (expectedTxids && expectedTxids[i] && spentBy === expectedTxids[i].toLowerCase()) {
        state = "paid"; note = "spent by the pre-signed payment";
      } else {
        state = "cancelled"; note = `spent by ${spentBy.slice(0, 12)}… (not the pre-signed payment)`;
      }
    } else if (tipHeight >= locktime) { state = "due"; note = "locktime passed — merchant may broadcast"; }
    else { state = "upcoming"; note = `${locktime - tipHeight} blocks to go`; }
    return { period: i + 1, locktime, state, note };
  });
}

export function approxDateForHeight(tipHeight, tipTimeMs, height) {
  const ms = tipTimeMs + (height - tipHeight) * BLOCK_TIME_S * 1000;
  return new Date(ms);
}
