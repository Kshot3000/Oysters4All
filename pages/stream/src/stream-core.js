/* Pearl Stream core — continuous PRL payment streaming (payroll-style) on Taproot.
 *
 * Pure ESM, zero build step for developers. The browser ships a committed
 * esbuild IIFE bundle (pearl-stream.bundle.js); node runs this file directly
 * for the verification suite.
 *
 * What this does:
 *   1. Stream: a funder streams PRL to a beneficiary at a fixed rate. Tick i
 *      (i = 0..N-1, max 256) gets its own P2TR address under a NUMS internal
 *      key committing a two-leaf tree:
 *        leaf A (claim):    <lock_i> OP_CHECKLOCKTIMEVERIFY OP_DROP <b> OP_CHECKSIG
 *        leaf B (clawback): <lock_i> OP_CHECKLOCKTIMEVERIFY OP_DROP <f> OP_CHECKSIG
 *      Ticks unlock at startTime + i*tickSeconds (unix timestamps only,
 *      >= 500_000_000). Each tick pays exactly rateGrainsPerTick (>= dust);
 *      the stream total is rate*N exactly. Same per-tick forge as
 *      pages/vesting (forgeTranche) — the difference is the rate-based plan,
 *      the fine-grained tick schedule, the live accrual dashboard, ONE
 *      multi-input batch-claim transaction sweeping all matured ticks, and
 *      funder cancel (clawbacks all unmatured ticks in one multi-input tx;
 *      matured-but-unclaimed ticks stay claimable).
 *   2. Batch claim: the beneficiary builds ONE transaction with n inputs
 *      (each a different funded tick UTXO with its own leaf script + control
 *      block; all leaves share the signer key) and a single P2TR output.
 *      nLockTime = max(lock of inputs), every input sequence = 0xfffffffe
 *      (non-final so CLTV holds; RBF still signalled). Fee from exact vBytes,
 *      dust refusal, per-input leaf-key check + Schnorr re-verification
 *      before hex exposure, sighash cross-check between signer and
 *      serializer. Cancel reuses the same builder with clawback leaves and
 *      the funder signer.
 *   3. Descriptor: `stream:v1:<hrp>:<b>:<f>:<r|n>:<mode>:<rate>:<tick>:<start>:<N>`
 *      fully determines every tick address — tamper-evident handoff.
 *
 * Crypto lineage: per-tick forge, beneficiary key handling, maturity and
 * chain-time come from the audited pages/vesting/src/vesting-core.js;
 * key derivation, TapTweak, bech32m, BIP-341 leaf hashing and wire
 * serialization come from the audited pages/sign/src/crypto.js; script-path
 * sighash/signing/verification primitives come from the audited
 * pages/escrow/src/escrow-core.js. The ONE new construction here is the
 * n-input script-path sweep (batchScriptPathSigDigest generalizes escrow's
 * single-input helper to n inputs; escrow's helper cannot be used for this)
 * and its exact multi-input weight math. No other new cryptography.
 *
 * Scope (v1): cancel sweeps only unmatured ticks (matured-but-unclaimed
 * ticks stay claimable by the beneficiary). A cancel tx carries
 * nLockTime = the last selected tick's unlock, so it confirms only once
 * that time passes — the funder pre-empts the beneficiary's future claims,
 * they do not claw back PRL today.
 */

import {
  forgeTranche, beneficiaryKeyFromInput, beneficiarySignerFor,
  isMature, fetchChainTime,
} from "../../vesting/src/vesting-core.js";
import {
  taggedHash, tapLeafHash, encodeBech32m, decodeBech32m,
  schnorr, sha256, bytesToHex, hexToBytes, convertBits,
  varint, u32le, u64le, p2trScriptPubKey, txidLE, dblSha,
  DUST_GRAIN, GRAIN_PER_PRL, NETWORKS,
  walletFromMnemonic, newMnemonic, walletFromWIF,
  tweakKeypath, tweakPrivKeypath,
  fetchUtxos, fetchFeeRateGrainsPerVByte, broadcastTx, fetchTxStatus,
} from "../../sign/src/crypto.js";
import {
  signForXOnly, verifySchnorrSig, partyKeyFromInput, parseXOnlyKey,
  scriptAsm, addressToProgram, encodeScriptNum,
} from "../../escrow/src/escrow-core.js";
import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesToNumberBE, numberToBytesBE } from "@noble/curves/abstract/utils";

export {
  forgeTranche, beneficiaryKeyFromInput, beneficiarySignerFor,
  isMature, fetchChainTime,
  DUST_GRAIN, GRAIN_PER_PRL, NETWORKS,
  walletFromMnemonic, newMnemonic, walletFromWIF,
  tweakKeypath, tweakPrivKeypath,
  fetchUtxos, fetchFeeRateGrainsPerVByte, broadcastTx, fetchTxStatus,
  bytesToHex, hexToBytes, schnorr, sha256, dblSha, convertBits,
  encodeBech32m, decodeBech32m, p2trScriptPubKey, txidLE,
  partyKeyFromInput, parseXOnlyKey, scriptAsm, addressToProgram,
  verifySchnorrSig, signForXOnly, encodeScriptNum,
};

export const MAX_TICKS = 256;
export const DESCRIPTOR_PREFIX = "stream:v1";
const LOCKTIME_THRESHOLD = 500_000_000; // stream locks are unix timestamps only
const MAX_LOCKTIME = 0xffffffff;
const MAX_SEQ_NONFINAL = 0xfffffffe; // non-final (CLTV satisfied) + RBF-safe
const TAPLEAF_VERSION = 0xc0;

function constEq(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

/** Forge one stream tick: same per-address construction as a vesting
 *  tranche (claim leaf for the beneficiary, optional clawback leaf for the
 *  funder, NUMS internal key — no keypath backdoor). Stream locks are unix
 *  timestamps only (>= 500_000_000). */
export function forgeTick(network, beneficiaryXOnly, funderXOnly, lock, revocable) {
  if (!Number.isSafeInteger(lock) || lock < LOCKTIME_THRESHOLD || lock > MAX_LOCKTIME) {
    throw new Error("stream tick locks are unix timestamps in 500000000..4294967295");
  }
  const t = forgeTranche(network, beneficiaryXOnly, funderXOnly, lock, revocable);
  return { ...t, lockKind: "time" };
}

function validateRate(rateGrainsPerTick) {
  if (!Number.isSafeInteger(rateGrainsPerTick) || rateGrainsPerTick < DUST_GRAIN) {
    throw new Error(`rate must be an integer >= dust (${DUST_GRAIN} grains per tick)`);
  }
  return rateGrainsPerTick;
}

function validateTickPlan(tickSeconds, startTime, tickCount) {
  if (!Number.isSafeInteger(tickSeconds) || tickSeconds < 1) {
    throw new Error("tick interval must be a positive integer of seconds");
  }
  if (!Number.isSafeInteger(startTime) || startTime < LOCKTIME_THRESHOLD || startTime > MAX_LOCKTIME) {
    throw new Error("stream start must be a unix timestamp (>= 500000000)");
  }
  if (!Number.isInteger(tickCount) || tickCount < 1 || tickCount > MAX_TICKS) {
    throw new Error(`tick count must be an integer in 1..${MAX_TICKS}`);
  }
  const lastLock = startTime + (tickCount - 1) * tickSeconds;
  if (lastLock > MAX_LOCKTIME) {
    throw new Error("last tick unlock exceeds the maximum locktime (4294967295) — shorten the stream");
  }
  return lastLock;
}

/** Plan a rate-based stream. Tick i unlocks at startTime + i*tickSeconds and
 *  pays exactly rateGrainsPerTick; the stream total is rate*tickCount exactly.
 *  `beneficiary` may be a raw x-only key (hex/Uint8Array, mode 'raw') or a
 *  { key, mode } object from beneficiaryKeyFromInput(). */
export function planStream({ network, beneficiary, beneficiaryXOnly, funderXOnly, rateGrainsPerTick, tickSeconds, startTime, tickCount, revocable = true }) {
  if (!network || !network.hrp) throw new Error("network required");
  let bmode = "raw";
  let bkey = beneficiaryXOnly;
  if (beneficiary && typeof beneficiary === "object" && beneficiary.key) {
    bkey = beneficiary.key;
    bmode = beneficiary.mode === "address" ? "address" : "raw";
  }
  const b = bkey instanceof Uint8Array ? bkey : parseXOnlyKey(bkey);
  const f = funderXOnly instanceof Uint8Array ? funderXOnly : parseXOnlyKey(funderXOnly);
  validateRate(rateGrainsPerTick);
  validateTickPlan(tickSeconds, startTime, tickCount);
  const totalGrains = rateGrainsPerTick * tickCount;
  const ticks = [];
  for (let i = 0; i < tickCount; i++) {
    const lock = startTime + i * tickSeconds;
    const forged = forgeTick(network, b, f, lock, revocable);
    ticks.push({
      index: i, ...forged,
      amountGrains: rateGrainsPerTick,
      lockDateISO: new Date(lock * 1000).toISOString(),
    });
  }
  const schedule = {
    kind: "pearl-stream-schedule", version: 1,
    networkHrp: network.hrp,
    beneficiary: bytesToHex(b), beneficiaryMode: bmode,
    funder: bytesToHex(f),
    revocable: !!revocable,
    rateGrainsPerTick, tickSeconds, startTime, tickCount,
    totalGrains,
    descriptor: descriptorForStream(network, b, f, revocable, bmode, rateGrainsPerTick, tickSeconds, startTime, tickCount),
  };
  return { schedule, ticks };
}

/** Deterministic descriptor: everything needed to re-derive the stream.
 *  The mode bit ('raw' vs 'addr') tells the claim step how the beneficiary
 *  key must sign; it does not change any address. */
export function descriptorForStream(network, beneficiaryXOnly, funderXOnly, revocable, mode, rate, tick, start, N) {
  const b = bytesToHex(beneficiaryXOnly instanceof Uint8Array ? beneficiaryXOnly : parseXOnlyKey(beneficiaryXOnly));
  const f = bytesToHex(funderXOnly instanceof Uint8Array ? funderXOnly : parseXOnlyKey(funderXOnly));
  const m = mode === "address" ? "addr" : "raw";
  validateRate(rate);
  validateTickPlan(tick, start, N);
  return `${DESCRIPTOR_PREFIX}:${network.hrp}:${b}:${f}:${revocable ? "r" : "n"}:${m}:${rate}:${tick}:${start}:${N}`;
}

/** Parse a stream descriptor string into its components. */
export function parseDescriptor(descriptor) {
  const m = /^stream:v1:([a-z0-9]{2,8}):([0-9a-f]{64}):([0-9a-f]{64}):([rn]):(raw|addr):(\d+):(\d+):(\d+):(\d+)$/i.exec(String(descriptor || "").trim());
  if (!m) throw new Error("descriptor must look like stream:v1:<hrp>:<b>:<f>:<r|n>:<raw|addr>:<rate>:<tick>:<start>:<N>");
  const net = Object.values(NETWORKS).find((n) => n.hrp === m[1].toLowerCase());
  if (!net) throw new Error("unknown network hrp '" + m[1] + "' (expected prl/tprl/rprl)");
  const rate = Number(m[6]), tick = Number(m[7]), start = Number(m[8]), N = Number(m[9]);
  validateRate(rate);
  validateTickPlan(tick, start, N);
  return {
    network: net,
    beneficiary: m[2].toLowerCase(), funder: m[3].toLowerCase(),
    revocable: m[4] === "r", mode: m[5] === "addr" ? "address" : "raw",
    rateGrainsPerTick: rate, tickSeconds: tick, startTime: start, tickCount: N,
  };
}

/** Re-derive a stream from a descriptor. Throws if recomputation does not
 *  reproduce the descriptor (tampered) or the derived addresses mismatch. */
export function scheduleFromDescriptor(descriptor) {
  const p = parseDescriptor(descriptor);
  const { schedule, ticks } = planStream({
    network: p.network,
    beneficiary: { key: p.beneficiary, mode: p.mode },
    funderXOnly: p.funder,
    rateGrainsPerTick: p.rateGrainsPerTick, tickSeconds: p.tickSeconds,
    startTime: p.startTime, tickCount: p.tickCount, revocable: p.revocable,
  });
  if (schedule.descriptor !== String(descriptor).trim()) {
    throw new Error("descriptor failed self-consistency check");
  }
  return { schedule, ticks };
}

/** Accrual dashboard state. `funded` must be set on each tick by the caller
 *  from Blockbook scans before calling (defaults to false = unfunded).
 *  streamedGrains: funded ticks that have matured (PRL released so far).
 *  claimableGrains: same gross figure — the caller subtracts UTXOs already
 *  claimed when building a batch claim. remainingGrains: everything not yet
 *  streamed, funded or not. */
export function streamState(ticks, chainTime) {
  if (!Array.isArray(ticks) || ticks.length === 0) throw new Error("ticks required");
  const rows = ticks.map((t, i) => {
    const matured = isMature(t.lock, chainTime);
    const funded = !!t.funded;
    return { index: t.index != null ? t.index : i, lock: t.lock, amount: t.amountGrains, matured, funded };
  });
  const total = rows.reduce((s, r) => s + r.amount, 0);
  const streamedGrains = rows.filter((r) => r.funded && r.matured).reduce((s, r) => s + r.amount, 0);
  return {
    ticks: rows,
    tickCount: rows.length,
    totalGrains: total,
    streamedGrains,
    claimableGrains: streamedGrains,
    remainingGrains: total - streamedGrains,
    percentStreamed: total > 0 ? (streamedGrains / total) * 100 : 0,
  };
}

/* ------------------------------------------------------------------ */
/* n-input script-path sweep                                          */
/* ------------------------------------------------------------------ */

/** Pick the leaf + control block for a role on a forged tick. */
export function tickLeafFor(tick, role) {
  if (role === "clawback") {
    if (!tick.clawbackScript) throw new Error("this stream is not revocable — no clawback leaf");
    return { leaf: tick.clawbackScript, controlBlock: tick.clawbackControlBlock };
  }
  if (role !== "claim") throw new Error("role must be 'claim' or 'clawback'");
  return { leaf: tick.claimScript, controlBlock: tick.claimControlBlock };
}

/** Extract the 32-byte key committed in a CLTV leaf of shape
 *  <lock-push> CLTV DROP <32-byte-key-push> CHECKSIG. Same parsing as
 *  vesting-core's buildClaimTx. */
export function committedLeafKey(leaf) {
  if (!(leaf instanceof Uint8Array)) throw new Error("unexpected leaf shape");
  const lockLen = leaf[0];
  if (!Number.isInteger(lockLen) || lockLen < 1 || lockLen > 5) throw new Error("unexpected leaf shape");
  const p = 1 + lockLen; // p: CLTV, p+1: DROP, p+2: <32>, p+3..p+34: key, p+35: CHECKSIG
  if (leaf.length !== p + 36) throw new Error("unexpected leaf shape");
  if (leaf[p] !== 0xb1 || leaf[p + 1] !== 0x75 || leaf[p + 2] !== 32 || leaf[p + 35] !== 0xac) {
    throw new Error("unexpected leaf shape");
  }
  return leaf.slice(p + 3, p + 35);
}

function validateBatchInput(inp, i) {
  if (!inp || !/^[0-9a-f]{64}$/i.test(inp.txid || "")) throw new Error(`input ${i}: bad txid`);
  if (!Number.isInteger(inp.vout) || inp.vout < 0) throw new Error(`input ${i}: bad vout`);
  if (!Number.isSafeInteger(inp.value) || inp.value <= 0) throw new Error(`input ${i}: bad value`);
  if (!inp.tick || !(inp.tick.spk instanceof Uint8Array) || inp.tick.spk.length === 0) throw new Error(`input ${i}: tick with spk required`);
  if (!Number.isSafeInteger(inp.tick.lock)) throw new Error(`input ${i}: tick lock required`);
}

/** BIP-341 script-path sighash, generalized to n inputs. sha_prevouts,
 *  sha_amounts, sha_scriptpubkeys and sha_sequences are computed over ALL
 *  inputs; the per-input message fixes the input index and that input's
 *  leaf hash. escrow's scriptPathSigDigestEx hashes only a single input —
 *  it cannot be used here. */
export function batchScriptPathSigDigest(network, inputs, outputs, leafScript, opts = {}) {
  const { sequence = MAX_SEQ_NONFINAL, locktime = 0, inputIdx = 0 } = opts;
  if (!Array.isArray(inputs) || inputs.length === 0) throw new Error("inputs required");
  if (!Number.isInteger(inputIdx) || inputIdx < 0 || inputIdx >= inputs.length) throw new Error("bad inputIdx");
  const sha = (b) => sha256(b);
  const prevouts = sha(Uint8Array.from(inputs.flatMap((x) => {
    if (!/^[0-9a-f]{64}$/i.test(x.txid || "")) throw new Error("bad input txid");
    if (!Number.isInteger(x.vout) || x.vout < 0) throw new Error("bad input vout");
    return [...txidLE(x.txid), ...u32le(x.vout)];
  })));
  const amounts = sha(Uint8Array.from(inputs.flatMap((x) => {
    if (!Number.isSafeInteger(x.value) || x.value <= 0) throw new Error("bad input value");
    return [...u64le(x.value)];
  })));
  const spks = sha(Uint8Array.from(inputs.flatMap((x) => {
    if (!(x.spk instanceof Uint8Array) || x.spk.length === 0) throw new Error("bad input spk");
    return [...varint(x.spk.length), ...x.spk];
  })));
  const seqs = sha(Uint8Array.from(inputs.flatMap(() => [...u32le(sequence)])));
  for (const o of outputs) {
    if (!(o.program instanceof Uint8Array) || o.program.length !== 32) throw new Error("output program must be 32 bytes");
    if (!Number.isSafeInteger(o.value) || o.value < DUST_GRAIN) throw new Error(`output below dust (${DUST_GRAIN} grains)`);
  }
  const outs = sha(Uint8Array.from(outputs.flatMap((o) => {
    const s = p2trScriptPubKey(o.program);
    return [...u64le(o.value), ...varint(s.length), ...s];
  })));
  if (!(leafScript instanceof Uint8Array) || leafScript.length === 0) throw new Error("bad leaf script");
  const leafHash = tapLeafHash(leafScript);
  const msg = Uint8Array.from([
    0x00, 0x00, ...u32le(network.txVersion), ...u32le(locktime),
    ...prevouts, ...amounts, ...spks, ...seqs, ...outs,
    0x01, // spend_type: script path, no annex
    ...u32le(inputIdx),
    ...leafHash, 0x00, 0xff, 0xff, 0xff, 0xff, // leaf hash, key version 0, codesep 0xffffffff
  ]);
  return taggedHash("TapSighash", msg);
}

/** Exact vBytes for an n-input script-path sweep with one P2TR output.
 *  Each input contributes a witness of [64-byte sig, leaf script, control
 *  block]; base = version + counts + n*41 + output + locktime. */
export function batchClaimVBytes({ nIn, scriptLens, controlLens }) {
  const varintLen = (n) => (n < 0xfd ? 1 : n <= 0xffff ? 3 : n <= 0xffffffff ? 5 : 9);
  if (!Number.isInteger(nIn) || nIn < 1) throw new Error("bad nIn");
  if (!Array.isArray(scriptLens) || scriptLens.length !== nIn) throw new Error("scriptLens must have one entry per input");
  if (!Array.isArray(controlLens) || controlLens.length !== nIn) throw new Error("controlLens must have one entry per input");
  let wit = 0;
  for (let i = 0; i < nIn; i++) {
    const sl = scriptLens[i], cl = controlLens[i];
    if (!Number.isSafeInteger(sl) || sl <= 0) throw new Error(`input ${i}: bad script length`);
    if (!Number.isSafeInteger(cl) || cl <= 0) throw new Error(`input ${i}: bad control length`);
    wit += varintLen(3) + varintLen(64) + 64 + varintLen(sl) + sl + varintLen(cl) + cl;
  }
  const base = 4 + varintLen(nIn) + nIn * 41 + varintLen(1) + 43 + 4;
  return Math.ceil((base * 3 + (base + 2 + wit)) / 4);
}

/** Exact sweep plan for a batch claim: everything in, one output, fee from
 *  the real multi-input witness size. Throws when the payment would be dust. */
export function planBatchClaim({ inputs, scriptLens, controlLens, feeRateGrainsPerVByte }) {
  if (!Array.isArray(inputs) || inputs.length === 0) throw new Error("inputs required");
  if (!Number.isFinite(feeRateGrainsPerVByte) || feeRateGrainsPerVByte <= 0) throw new Error("bad fee rate");
  let sum = 0;
  inputs.forEach((x, i) => {
    if (!Number.isSafeInteger(x.value) || x.value <= 0) throw new Error(`input ${i}: bad value`);
    sum += x.value;
  });
  const vBytes = batchClaimVBytes({ nIn: inputs.length, scriptLens, controlLens });
  const fee = Math.ceil(vBytes * feeRateGrainsPerVByte);
  const payment = sum - fee;
  if (payment < DUST_GRAIN) {
    throw new Error(`insufficient funds: ${sum} grains covers the ${fee}-grain fee but leaves < dust (${DUST_GRAIN}); top the ticks up`);
  }
  return { payment, fee, vBytes, inputSum: sum };
}

function signerXOnly(signerPriv) {
  const p = signerPriv instanceof Uint8Array ? signerPriv : hexToBytes(String(signerPriv));
  if (p.length !== 32) throw new Error("private key must be 32 bytes");
  const d = bytesToNumberBE(p);
  if (d <= 0n || d >= secp256k1.CURVE.n) throw new Error("private key out of range");
  const P = secp256k1.ProjectivePoint.fromPrivateKey(numberToBytesBE(d, 32));
  return schnorr.utils.pointToBytes(P); // x-only; BIP-340 negation handled by signForXOnly
}

/** Serialize the n-input script-path sweep. Recomputes every input's sighash
 *  digest independently and asserts it matches the signing digest (cross-check).
 *  Returns { txid, hex, vBytes, digests } — hex is only produced after the
 *  cross-check passes. */
export function buildBatchScriptPathSpend(network, inputSpecs, outputs, leaves, controlBlocks, sigs, { sequence = MAX_SEQ_NONFINAL, locktime = 0, expectedDigests = null }) {
  const n = inputSpecs.length;
  if (leaves.length !== n || controlBlocks.length !== n || sigs.length !== n) {
    throw new Error("inputs, leaves, control blocks and signatures must align");
  }
  const digests = inputSpecs.map((_, i) => {
    if ((controlBlocks[i][0] & 0xfe) !== TAPLEAF_VERSION) throw new Error(`input ${i}: bad control block version`);
    return batchScriptPathSigDigest(network, inputSpecs, outputs, leaves[i], { sequence, locktime, inputIdx: i });
  });
  if (expectedDigests) {
    for (let i = 0; i < n; i++) {
      if (bytesToHex(digests[i]) !== String(expectedDigests[i]).toLowerCase()) {
        throw new Error(`input ${i}: sighash mismatch between signer and serializer`);
      }
    }
  }
  const outs = [];
  for (const o of outputs) {
    const s = p2trScriptPubKey(o.program);
    outs.push(...u64le(o.value), ...varint(s.length), ...s);
  }
  const inBytes = [];
  for (const x of inputSpecs) {
    inBytes.push(...txidLE(x.txid), ...u32le(x.vout), ...varint(0), ...u32le(sequence));
  }
  const witBytes = [];
  for (let i = 0; i < n; i++) {
    const items = [sigs[i], leaves[i], controlBlocks[i]];
    witBytes.push(...varint(items.length));
    for (const w of items) {
      const b = w instanceof Uint8Array ? w : hexToBytes(String(w));
      witBytes.push(...varint(b.length), ...b);
    }
  }
  const base = [...u32le(network.txVersion), ...varint(n), ...inBytes, ...varint(outputs.length), ...outs, ...u32le(locktime)];
  const txid = bytesToHex(dblSha(Uint8Array.from(base)).reverse());
  const full = [...u32le(network.txVersion), 0x00, 0x01, ...varint(n), ...inBytes, ...varint(outputs.length), ...outs, ...witBytes, ...u32le(locktime)];
  const baseBytes = base.length, totalBytes = full.length;
  const vBytes = Math.ceil((baseBytes * 3 + totalBytes) / 4);
  return { txid, hex: bytesToHex(Uint8Array.from(full)), vBytes, baseBytes, totalBytes, digests: digests.map(bytesToHex) };
}

/** Build, sign and locally re-verify a batch-claim (or cancel/clawback)
 *  sweep: n funded tick UTXOs in, ONE sweep output to `destinationProgram`.
 *  role 'claim' spends each input's claim leaf with the beneficiary key;
 *  role 'clawback' spends each input's clawback leaf with the funder key
 *  (cancel). nLockTime = max(lock of inputs), every input sequence =
 *  0xfffffffe. The returned hex is only produced after EVERY signature is
 *  re-verified against its input's digest and the signer matches the key
 *  committed in every leaf. */
export function buildBatchClaimTx({ network, inputs, role = "claim", signerPriv, destinationProgram, feeRateGrainsPerVByte }) {
  if (!network || !network.hrp) throw new Error("network required");
  if (!Array.isArray(inputs) || inputs.length === 0) throw new Error("inputs required");
  if (inputs.length > MAX_TICKS) throw new Error(`at most ${MAX_TICKS} inputs per sweep`);
  if (!(destinationProgram instanceof Uint8Array) || destinationProgram.length !== 32) {
    throw new Error("destination program must be 32 bytes");
  }
  const signerX = signerXOnly(signerPriv);
  const leaves = [], controls = [];
  let locktime = 0;
  const specs = inputs.map((inp, i) => {
    validateBatchInput(inp, i);
    const { leaf, controlBlock } = tickLeafFor(inp.tick, role);
    if (!(controlBlock instanceof Uint8Array) || (controlBlock.length !== 33 && controlBlock.length !== 65)) {
      throw new Error(`input ${i}: bad control block`);
    }
    // The signer must be the key committed in THIS leaf — a signature from
    // any other key verifies locally yet fails consensus.
    const leafKey = committedLeafKey(leaf);
    if (!constEq(signerX, leafKey)) {
      throw new Error(`input ${i}: signer key does not match the key committed in this leaf — wrong key imported`);
    }
    if (inp.tick.lock > locktime) locktime = inp.tick.lock;
    leaves.push(leaf); controls.push(controlBlock);
    return { txid: inp.txid, vout: inp.vout, value: inp.value, spk: inp.tick.spk };
  });
  const plan = planBatchClaim({
    inputs: specs,
    scriptLens: leaves.map((l) => l.length),
    controlLens: controls.map((c) => c.length),
    feeRateGrainsPerVByte,
  });
  const outputs = [{ program: destinationProgram, value: plan.payment }];
  const digests = specs.map((_, i) =>
    batchScriptPathSigDigest(network, specs, outputs, leaves[i], { sequence: MAX_SEQ_NONFINAL, locktime, inputIdx: i }));
  const sigs = digests.map((dg, i) => {
    const sig = signForXOnly(signerPriv, dg);
    if (!verifySchnorrSig(sig, dg, signerX)) {
      throw new Error(`input ${i}: local signature self-check failed — refusing to emit transaction hex`);
    }
    return sig;
  });
  const spend = buildBatchScriptPathSpend(network, specs, outputs, leaves, controls, sigs, {
    sequence: MAX_SEQ_NONFINAL, locktime,
    expectedDigests: digests.map(bytesToHex),
  });
  // Fee cross-check: planner vBytes must equal serializer vBytes.
  if (spend.vBytes !== plan.vBytes) {
    throw new Error(`vBytes mismatch: planner ${plan.vBytes} vs serializer ${spend.vBytes}`);
  }
  return {
    txid: spend.txid, hex: spend.hex,
    fee: plan.fee, vBytes: spend.vBytes, payment: plan.payment,
    inputSum: plan.inputSum, inputCount: inputs.length,
    sigsHex: sigs.map(bytesToHex), digestsHex: spend.digests,
    locktime, sequence: MAX_SEQ_NONFINAL, role,
  };
}
