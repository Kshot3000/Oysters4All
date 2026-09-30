/* Pearl Predict core — prediction markets on Pearl Taproot, no smart contracts.
 *
 * Pure ESM, zero build step for developers. The browser ships a committed
 * esbuild IIFE bundle (pearl-predict.bundle.js); node runs this file directly
 * for the verification suite.
 *
 * What this does: a market is a question with 2-4 named outcomes. Each outcome
 * gets ONE deterministic Taproot funding address holding a 2-leaf taptree:
 *   Leaf A (award):  <arbiter_xonly> OP_CHECKSIG
 *   Leaf B (refund): <resolveH> OP_CHECKLOCKTIMEVERIFY OP_DROP <refund_xonly> OP_CHECKSIG
 * Traders fund their chosen outcome's address. After the trading deadline the
 * arbiter signs a proportional-payout bundle (winners split the whole pot
 * pro-rata to their winning-outcome stake). If the market voids, the refund
 * leaf sweeps each pot back to its recorded funders after resolveH.
 *
 * Crypto lineage (NO new cryptography):
 *  - Leaf A is built with the audited Pearl Bounty award-leaf builder
 *    (bounty/src/bounty-core.js buildAwardScript) — the test suite asserts
 *    byte-equality with the audited function.
 *  - Leaf B is built with the audited Pearl Escrow refund-leaf builder
 *    (escrow/src/escrow-core.js buildRefundScript) — the test suite asserts
 *    byte-equality with the audited function.
 *  - Taptree, control blocks, NUMS lift loop, BIP-340 sign/verify, bech32m,
 *    and the BIP-341 sighash shape are the audited escrow/sign lineage.
 *  - The ONLY new local construction is the NUMS internal-key derivation
 *    with the "PearlPredictNUMS/v1" domain tag, mirroring the escrow/bounty
 *    pattern (domain || marketHash || u32le(outcomeIndex), counter-loop lift).
 *  - Multi-input script-path spends generalize the audited single-input
 *    digest: the test suite asserts byte-equality with the audited
 *    scriptPathSigDigestEx for the 1-input case.
 *
 * Protocol facts (verified, not from memory):
 *  - TapLeaf/TapBranch/TapTweak tags + branch sort order: BIP-341 (same as
 *    the audited escrow taptree2 this file reuses).
 *  - P2TR dust 546 grains, 1 PRL = 1e8 grains, bech32m HRPs prl/tprl:
 *    sign/src/crypto.js (from node/chaincfg + upstream txrules).
 *  - CLTV lock heights < 500000000 are block heights (BIP-65).
 *  - Pearl block target ~194 s (matches the fees desk).
 */

import {
  taggedHash, tapLeafHash, encodeBech32m, decodeBech32m,
  schnorr, sha256, bytesToHex, hexToBytes, dblSha,
  varint, u32le, u64le, p2trScriptPubKey, txidLE,
  DUST_GRAIN, GRAIN_PER_PRL, NETWORKS,
  walletFromMnemonic, walletFromWIF, walletFromPriv, newMnemonic,
  fetchUtxos, fetchFeeRateGrainsPerVByte, fetchTxStatus,
} from "../../sign/src/crypto.js";
import {
  parseXOnlyKey, partyKeyFromInput, addressToProgram,
  buildRefundScript, signForXOnly, verifySchnorrSig,
  scriptPathSigDigestEx, spendVBytes, taptree2, verifyControlBlock,
} from "../../escrow/src/escrow-core.js";
import { buildAwardScript } from "../../bounty/src/bounty-core.js";
import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesToNumberBE } from "@noble/curves/abstract/utils";

export {
  DUST_GRAIN, GRAIN_PER_PRL, NETWORKS,
  walletFromMnemonic, walletFromWIF, walletFromPriv, newMnemonic,
  fetchUtxos, fetchFeeRateGrainsPerVByte, fetchTxStatus,
  bytesToHex, hexToBytes, schnorr, sha256, dblSha,
  encodeBech32m, decodeBech32m, p2trScriptPubKey, txidLE,
  parseXOnlyKey, partyKeyFromInput, addressToProgram,
  signForXOnly, verifySchnorrSig, buildRefundScript, buildAwardScript,
};

export const PREDICT_VERSION = "v1";
export const BLOCK_TARGET_SECONDS = 194; // Pearl block target (matches fees desk)
export const MAX_CLTV_HEIGHT = 500_000_000; // BIP-65: below this = block height
const TE = new TextEncoder();
const utf8 = (s) => TE.encode(s);
const NUMS_DOMAIN = "PearlPredictNUMS/v1";
const MAX_SEQ = 0xffffffff;
const REFUND_SEQ = 0xfffffffe; // < 0xffffffff so CLTV is enforced

/* ------------------------------------------------------------------ */
/* Market spec                                                         */
/* ------------------------------------------------------------------ */

/** Validate + normalize a market spec. Throws loudly on any violation.
 *  spec = { question, outcomes[2..4], source, tradeH, resolveH,
 *           arbiterKeyInput (64-hex x-only OR 12/24-word BIP-86 mnemonic),
 *           refundKeyInput? (defaults to the arbiter key),
 *           hrp: "prl" | "tprl" }
 *  tipHeight (optional): live Blockbook tip or air-gapped manual tip — both
 *  deadlines must be provably in the future when provided. */
export function validateMarketSpec(spec, tipHeight = null) {
  if (!spec || typeof spec !== "object") throw new Error("market spec must be an object");
  const network = spec.hrp === "tprl" ? NETWORKS.testnet : spec.hrp === "prl" ? NETWORKS.mainnet : null;
  if (!network) throw new Error('hrp must be "prl" or "tprl"');

  const question = String(spec.question || "").trim();
  if (question.length < 8 || question.length > 200) {
    throw new Error("question must be 8-200 characters");
  }
  if (!Array.isArray(spec.outcomes)) throw new Error("outcomes must be an array");
  const outcomes = spec.outcomes.map((o) => String(o || "").trim()).filter((o) => o.length > 0);
  if (outcomes.length < 2 || outcomes.length > 4) {
    throw new Error("market needs 2-4 non-empty named outcomes");
  }
  for (const o of outcomes) {
    if (o.length > 40) throw new Error(`outcome name too long (max 40): "${o.slice(0, 40)}…"`);
  }
  if (new Set(outcomes.map((o) => o.toLowerCase())).size !== outcomes.length) {
    throw new Error("outcome names must be unique (case-insensitive)");
  }
  const source = String(spec.source || "").trim();
  if (source.length < 8 || source.length > 300) {
    throw new Error("resolution source description must be 8-300 characters");
  }

  const tradeH = spec.tradeH;
  const resolveH = spec.resolveH;
  for (const [name, h] of [["tradeH", tradeH], ["resolveH", resolveH]]) {
    if (!Number.isSafeInteger(h) || h <= 0 || h >= MAX_CLTV_HEIGHT) {
      throw new Error(`${name} must be a block height (1-${MAX_CLTV_HEIGHT - 1})`);
    }
  }
  if (resolveH <= tradeH) throw new Error("resolution deadline must be AFTER the trading deadline");
  if (tipHeight !== null && tipHeight !== undefined) {
    if (!Number.isSafeInteger(tipHeight) || tipHeight <= 0) throw new Error("bad tip height");
    if (tradeH <= tipHeight) {
      throw new Error(`trading deadline (${tradeH}) is not in the future (tip ${tipHeight})`);
    }
    if (resolveH <= tipHeight) {
      throw new Error(`resolution deadline (${resolveH}) is not in the future (tip ${tipHeight})`);
    }
  }

  const arbiter = partyKeyFromInput(spec.arbiterKeyInput, network); // {xonly, priv, source}
  let refundXOnly = arbiter.xonly;
  let refundSource = arbiter.source + " (default)";
  if (spec.refundKeyInput && String(spec.refundKeyInput).trim().length > 0) {
    const r = partyKeyFromInput(spec.refundKeyInput, network);
    refundXOnly = r.xonly;
    refundSource = r.source;
  }

  return {
    question, outcomes, source, tradeH, resolveH,
    hrp: network.hrp,
    arbiterXOnly: bytesToHex(arbiter.xonly),
    arbiterSource: arbiter.source,
    refundXOnly: bytesToHex(refundXOnly),
    refundSource,
    network: network.id,
  };
}

/** Canonical market JSON — stable key order; this exact byte string is what
 *  marketHash commits to. NEVER includes key material (mnemonics/WIF). */
export function canonicalMarketJSON(norm) {
  const obj = {
    arbiter: norm.arbiterXOnly,
    hrp: norm.hrp,
    outcomes: norm.outcomes,
    question: norm.question,
    refund: norm.refundXOnly,
    resolveH: norm.resolveH,
    source: norm.source,
    tradeH: norm.tradeH,
  };
  return JSON.stringify(obj);
}

/** marketHash = SHA-256 over the canonical market JSON (hex). */
export function marketHashHex(norm) {
  return bytesToHex(sha256(utf8(canonicalMarketJSON(norm))));
}

/** pearl-predict:v1:<hrp>:<marketHash>:<nOutcomes>:<tradeH>:<resolveH> */
export function marketDescriptor(norm) {
  return `pearl-predict:${PREDICT_VERSION}:${norm.hrp}:${marketHashHex(norm)}:${norm.outcomes.length}:${norm.tradeH}:${norm.resolveH}`;
}

/** Parse a descriptor; throws on malformed input. */
export function parseMarketDescriptor(desc) {
  const m = /^pearl-predict:v1:(prl|tprl):([0-9a-f]{64}):([2-4]):([1-9][0-9]*):([1-9][0-9]*)$/.exec(String(desc || "").trim());
  if (!m) throw new Error("bad pearl-predict descriptor");
  const [, hrp, hash, nOutcomes, tradeH, resolveH] = m;
  const tH = Number(tradeH), rH = Number(resolveH);
  if (rH <= tH) throw new Error("descriptor has resolveH <= tradeH");
  return { hrp, marketHash: hash, nOutcomes: Number(nOutcomes), tradeH: tH, resolveH: rH };
}

/** Recompute the descriptor from a normalized spec and compare. */
export function verifyMarketDescriptor(norm, desc) {
  const failures = [];
  let parsed = null;
  try { parsed = parseMarketDescriptor(desc); }
  catch (e) { failures.push("descriptor malformed: " + e.message); }
  if (parsed) {
    const want = marketDescriptor(norm);
    if (want !== String(desc).trim()) failures.push("descriptor does not match recomputed market commitment");
    if (parsed.marketHash !== marketHashHex(norm)) failures.push("marketHash mismatch — market JSON was tampered with");
    if (parsed.nOutcomes !== norm.outcomes.length) failures.push("outcome count mismatch");
    if (parsed.tradeH !== norm.tradeH || parsed.resolveH !== norm.resolveH) failures.push("deadline mismatch");
    if (parsed.hrp !== norm.hrp) failures.push("network HRP mismatch");
  }
  return { ok: failures.length === 0, failures, recomputed: marketDescriptor(norm) };
}

/* ------------------------------------------------------------------ */
/* NUMS internal key + outcome contracts                               */
/* ------------------------------------------------------------------ */

/** NUMS internal key: lift_x(SHA-256("PearlPredictNUMS/v1" || marketHash ||
 *  u32le(outcomeIndex))). Nobody knows the discrete log, so keypath spending
 *  is impossible — coins move only through the two script leaves.
 *  Deterministic and recomputable from the descriptor + outcome index.
 *  Mirrors the audited escrow/bounty NUMS construction (distinct domain). */
export function numsInternalKeyPredict(marketHashHexStr, outcomeIndex) {
  if (!/^[0-9a-f]{64}$/i.test(marketHashHexStr || "")) throw new Error("bad market hash");
  if (!Number.isInteger(outcomeIndex) || outcomeIndex < 0 || outcomeIndex > 3) {
    throw new Error("outcomeIndex must be 0-3");
  }
  const preimage = Uint8Array.from([
    ...utf8(NUMS_DOMAIN), ...hexToBytes(marketHashHexStr), ...u32le(outcomeIndex),
  ]);
  for (let counter = 0; counter < 256; counter++) {
    const pre = counter === 0 ? preimage : Uint8Array.from([...preimage, counter]);
    const h = sha256(pre);
    try {
      schnorr.utils.lift_x(bytesToNumberBE(h));
      return h;
    } catch { /* try next counter */ }
  }
  throw new Error("PREDICT REFUSED: NUMS lift failed (unreachable in practice)");
}

/** Full outcome contract: 2-leaf taptree under the NUMS internal key.
 *  Leaf A (award)  = buildAwardScript(arbiter)      — byte-identical to the
 *    audited Pearl Bounty award leaf.
 *  Leaf B (refund) = buildRefundScript(refund, resolveH) — byte-identical to
 *    the audited Pearl Escrow refund leaf. */
export function outcomeContract(norm, outcomeIndex) {
  if (!Number.isInteger(outcomeIndex) || outcomeIndex < 0 || outcomeIndex >= norm.outcomes.length) {
    throw new Error("outcomeIndex out of range");
  }
  const network = norm.hrp === "tprl" ? NETWORKS.testnet : NETWORKS.mainnet;
  const hash = marketHashHex(norm);
  const leafA = buildAwardScript(hexToBytes(norm.arbiterXOnly));
  const leafB = buildRefundScript(hexToBytes(norm.refundXOnly), norm.resolveH);
  const internalXOnly = numsInternalKeyPredict(hash, outcomeIndex);
  const tree = taptree2(network, internalXOnly, leafA, leafB);
  // Belt-and-braces: the same verification a funding wallet performs.
  for (const [script, cb, name] of [
    [leafA, tree.controlBlocks[0], "award"],
    [leafB, tree.controlBlocks[1], "refund"],
  ]) {
    if (!verifyControlBlock(internalXOnly, script, cb, tree.tweakedX)) {
      throw new Error(`internal ${name} control-block self-check failed`);
    }
  }
  return {
    outcomeIndex, outcomeName: norm.outcomes[outcomeIndex],
    marketHash: hash, internalXOnly, leafA, leafB,
    ...tree, // address, spk, tweakedX, controlBlocks, leafHashes, root, tweak, parity
  };
}

/** All outcome contracts for a market (cached by callers if hot). */
export function allOutcomeContracts(norm) {
  return norm.outcomes.map((_, i) => outcomeContract(norm, i));
}

/* ------------------------------------------------------------------ */
/* Fee math                                                            */
/* ------------------------------------------------------------------ */

/** vBytes for a multi-input script-path spend with per-input script length.
 *  Same weight arithmetic as the audited escrow spendVBytes, generalized to
 *  nIn inputs (stack: [sig] + script + control block per input). */
export function scriptPathVBytes({ nIn, nOut, scriptLen, controlLen = 65, stackLens = [64] }) {
  if (!Number.isSafeInteger(nIn) || nIn < 1) throw new Error("bad nIn");
  if (!Number.isSafeInteger(nOut) || nOut < 1) throw new Error("bad nOut");
  if (!Number.isSafeInteger(scriptLen) || scriptLen <= 0) throw new Error("bad scriptLen");
  const varintLen = (n) => (n < 0xfd ? 1 : n <= 0xffff ? 3 : n <= 0xffffffff ? 5 : 9);
  let wit = 0;
  for (let i = 0; i < nIn; i++) {
    wit += varintLen(stackLens.length + 2); // witness item count
    for (const l of stackLens) wit += varintLen(l) + l;
    wit += varintLen(scriptLen) + scriptLen + varintLen(controlLen) + controlLen;
  }
  const base = 4 + 1 + nIn * 41 + 1 + nOut * 43 + 4;
  return Math.ceil((base * 3 + (base + 2 + wit)) / 4);
}

/** Fee in grains for vBytes at a (possibly fractional) grains/vB rate. */
export function feeForVBytes(vBytes, rateGrainsPerVByte) {
  if (!Number.isSafeInteger(vBytes) || vBytes <= 0) throw new Error("bad vBytes");
  const r = Number(rateGrainsPerVByte);
  if (!Number.isFinite(r) || r <= 0) throw new Error("fee rate must be positive");
  return Math.ceil(vBytes * r);
}

/* ------------------------------------------------------------------ */
/* Positions + payout planning                                         */
/* ------------------------------------------------------------------ */

/** Validate a tracked position. position = { outcomeIndex, txid, vout,
 *  value (grains), funderAddr (P2TR payout address), label? } */
export function validatePosition(norm, pos) {
  if (!pos || typeof pos !== "object") throw new Error("position must be an object");
  if (!Number.isInteger(pos.outcomeIndex) || pos.outcomeIndex < 0 || pos.outcomeIndex >= norm.outcomes.length) {
    throw new Error("position outcomeIndex out of range");
  }
  if (!/^[0-9a-f]{64}$/i.test(pos.txid || "")) throw new Error("position txid must be 64 hex");
  if (!Number.isInteger(pos.vout) || pos.vout < 0) throw new Error("bad position vout");
  if (!Number.isSafeInteger(pos.value) || pos.value < DUST_GRAIN) {
    throw new Error(`position value must be >= dust (${DUST_GRAIN} grains)`);
  }
  const network = norm.hrp === "tprl" ? NETWORKS.testnet : NETWORKS.mainnet;
  addressToProgram(pos.funderAddr, network); // throws on wrong network / non-P2TR
  return {
    outcomeIndex: pos.outcomeIndex,
    txid: pos.txid.toLowerCase(), vout: pos.vout, value: pos.value,
    funderAddr: pos.funderAddr.trim(), label: String(pos.label || "").trim().slice(0, 60),
  };
}

/** Largest-remainder distribution of `total` grains across weights (BigInt).
 *  Guarantees sum(out) === total and every out >= 0. */
export function largestRemainder(weights, total) {
  const W = weights.map((w) => BigInt(w));
  const T = BigInt(total);
  const sumW = W.reduce((a, b) => a + b, 0n);
  if (sumW <= 0n) throw new Error("weights must sum positive");
  if (T < 0n) throw new Error("total must be non-negative");
  const floors = W.map((w) => (w * T) / sumW);
  const used = floors.reduce((a, b) => a + b, 0n);
  let rest = T - used;
  const order = W.map((w, i) => [((w * T) % sumW), i])
    .sort((a, b) => (b[0] === a[0] ? a[1] - b[1] : (b[0] > a[0] ? 1 : -1)))
    .map((x) => x[1]);
  const out = floors.map((f) => Number(f));
  for (const i of order) {
    if (rest <= 0n) break;
    out[i] += 1;
    rest -= 1n;
  }
  return out;
}

/** Plan the arbiter award payout.
 *  Every input (winning AND losing pots) is spent via the arbiter's Leaf A;
 *  winners split the whole pot pro-rata: share_i = stake_i * totalPot / winningPot.
 *  Fee is deducted from the pot before distribution. Largest-remainder keeps
 *  outputs grain-exact. Any payout below dust -> LOUD refusal. */
export function planAwardPayout({ norm, contracts, positions, winIndex, feeRateGrainsPerVByte }) {
  if (!Number.isInteger(winIndex) || winIndex < 0 || winIndex >= norm.outcomes.length) {
    throw new Error("winIndex out of range");
  }
  const ps = positions.map((p) => validatePosition(norm, p));
  if (ps.length === 0) throw new Error("no positions tracked — nothing to pay out");
  const seen = new Set();
  for (const p of ps) {
    const k = `${p.txid}:${p.vout}`;
    if (seen.has(k)) throw new Error(`duplicate position input ${k}`);
    seen.add(k);
  }
  const winners = ps.filter((p) => p.outcomeIndex === winIndex);
  if (winners.length === 0) throw new Error("no positions on the winning outcome — cannot pay out");
  const totalPot = ps.reduce((a, p) => a + BigInt(p.value), 0n);
  const winningPot = winners.reduce((a, p) => a + BigInt(p.value), 0n);

  const awardScriptLen = contracts[winIndex].leafA.length;
  const vB = scriptPathVBytes({ nIn: ps.length, nOut: winners.length, scriptLen: awardScriptLen });
  const fee = BigInt(feeForVBytes(vB, feeRateGrainsPerVByte));
  const distributable = totalPot - fee;
  if (distributable <= 0n) {
    throw new Error(`fee (${fee} grains) consumes the whole pot (${totalPot} grains) — payout refused`);
  }
  const shares = largestRemainder(winners.map((w) => w.value), distributable);
  for (let i = 0; i < shares.length; i++) {
    if (shares[i] < DUST_GRAIN) {
      throw new Error(`PAYOUT REFUSED: winner ${winners[i].funderAddr} share ${shares[i]} grains is below dust (${DUST_GRAIN}) — raise the pot or the fee rate is too high`);
    }
  }
  const network = norm.hrp === "tprl" ? NETWORKS.testnet : NETWORKS.mainnet;
  const outputs = winners.map((w, i) => ({
    address: w.funderAddr,
    program: addressToProgram(w.funderAddr, network),
    value: shares[i],
    stake: w.value,
  }));
  const inputs = ps.map((p) => {
    const c = contracts[p.outcomeIndex];
    return {
      txid: p.txid, vout: p.vout, value: p.value,
      outcomeIndex: p.outcomeIndex, outcomeName: norm.outcomes[p.outcomeIndex],
      spk: c.spk, leafScript: c.leafA, controlBlock: c.controlBlocks[0],
    };
  });
  return {
    kind: "award", winIndex, winName: norm.outcomes[winIndex],
    feeRateGrainsPerVByte,
    inputs, outputs, vBytes: vB, fee: Number(fee),
    totalPot: Number(totalPot), winningPot: Number(winningPot),
    distributable: Number(distributable),
  };
}

/** Plan the void refund: every funder gets their exact stake back, minus a
 *  pro-rata fee share. Spent via Leaf B with nLockTime = resolveH. */
export function planVoidRefund({ norm, contracts, positions, feeRateGrainsPerVByte }) {
  const ps = positions.map((p) => validatePosition(norm, p));
  if (ps.length === 0) throw new Error("no positions tracked — nothing to refund");
  const seen = new Set();
  for (const p of ps) {
    const k = `${p.txid}:${p.vout}`;
    if (seen.has(k)) throw new Error(`duplicate position input ${k}`);
    seen.add(k);
  }
  const totalPot = ps.reduce((a, p) => a + BigInt(p.value), 0n);
  const refundScriptLen = Math.max(...contracts.map((c) => c.leafB.length));
  const vB = scriptPathVBytes({ nIn: ps.length, nOut: ps.length, scriptLen: refundScriptLen });
  const fee = BigInt(feeForVBytes(vB, feeRateGrainsPerVByte));
  if (fee >= totalPot) throw new Error(`fee (${fee}) consumes the whole pot — refund refused`);
  const feeShares = largestRemainder(ps.map((p) => p.value), fee);
  const network = norm.hrp === "tprl" ? NETWORKS.testnet : NETWORKS.mainnet;
  const outputs = ps.map((p, i) => {
    const value = p.value - feeShares[i];
    if (value < DUST_GRAIN) {
      throw new Error(`REFUND REFUSED: ${p.funderAddr} would receive ${value} grains (< dust) — fee too high for this pot`);
    }
    return {
      address: p.funderAddr,
      program: addressToProgram(p.funderAddr, network),
      value, stake: p.value, feeShare: feeShares[i],
    };
  });
  const inputs = ps.map((p) => {
    const c = contracts[p.outcomeIndex];
    return {
      txid: p.txid, vout: p.vout, value: p.value,
      outcomeIndex: p.outcomeIndex, outcomeName: norm.outcomes[p.outcomeIndex],
      spk: c.spk, leafScript: c.leafB, controlBlock: c.controlBlocks[1],
    };
  });
  return {
    kind: "void", feeRateGrainsPerVByte,
    inputs, outputs, vBytes: vB, fee: Number(fee),
    totalPot: Number(totalPot), locktime: norm.resolveH,
  };
}

/* ------------------------------------------------------------------ */
/* Multi-input script-path sighash + bundle building                   */
/* ------------------------------------------------------------------ */

/** BIP-341 script-path sighash for input `inputIdx` of a MULTI-input tx.
 *  Identical message shape to the audited escrow scriptPathSigDigestEx, but
 *  the prevouts/amounts/spks/sequences hashes cover ALL inputs (BIP-341).
 *  inputs: [{txid, vout, value, spk, sequence}], outputs: [{program, value}].
 *  The test suite asserts byte-equality with the audited single-input
 *  digest when inputs.length === 1. */
export function tapSighashMulti(network, inputs, outputs, inputIdx, leafScript, opts = {}) {
  const { locktime = 0 } = opts;
  if (!Array.isArray(inputs) || inputs.length === 0) throw new Error("need at least one input");
  if (!Number.isInteger(inputIdx) || inputIdx < 0 || inputIdx >= inputs.length) throw new Error("bad inputIdx");
  for (const inp of inputs) {
    if (!/^[0-9a-f]{64}$/i.test(inp.txid || "")) throw new Error("bad input txid");
    if (!Number.isInteger(inp.vout) || inp.vout < 0) throw new Error("bad input vout");
    if (!Number.isSafeInteger(inp.value) || inp.value <= 0) throw new Error("bad input value");
    if (!(inp.spk instanceof Uint8Array) || inp.spk.length === 0) throw new Error("bad input spk");
    if (!Number.isInteger(inp.sequence)) throw new Error("bad input sequence");
  }
  for (const o of outputs) {
    if (!(o.program instanceof Uint8Array) || o.program.length !== 32) throw new Error("output program must be 32 bytes");
    if (!Number.isSafeInteger(o.value) || o.value < DUST_GRAIN) throw new Error(`output below dust (${DUST_GRAIN} grains)`);
  }
  const sha = (b) => sha256(b);
  const prevouts = sha(Uint8Array.from(inputs.flatMap((i) => [...txidLE(i.txid), ...u32le(i.vout)])));
  const amounts = sha(Uint8Array.from(inputs.flatMap((i) => [...u64le(i.value)])));
  const spks = sha(Uint8Array.from(inputs.flatMap((i) => [...varint(i.spk.length), ...i.spk])));
  const seqs = sha(Uint8Array.from(inputs.flatMap((i) => [...u32le(i.sequence)])));
  const outs = sha(Uint8Array.from(outputs.flatMap((o) => {
    const s = p2trScriptPubKey(o.program);
    return [...u64le(o.value), ...varint(s.length), ...s];
  })));
  const leafHash = tapLeafHash(leafScript);
  const msg = Uint8Array.from([
    0x00, 0x00, ...u32le(network.txVersion), ...u32le(locktime),
    ...prevouts, ...amounts, ...spks, ...seqs, ...outs,
    0x02, // spend_type: script path (ext_flag=1), no annex
    ...u32le(inputIdx),
    ...leafHash, 0x00, 0xff, 0xff, 0xff, 0xff, // leaf hash, key version 0, codesep 0xffffffff
  ]);
  return taggedHash("TapSighash", msg);
}

/** Serialize a multi-input script-path spend. Each input carries its own
 *  leaf script + control block + signature stack items. */
export function buildMultiInputScriptPathSpend(network, inputs, outputs, opts = {}) {
  const { locktime = 0 } = opts;
  if (!Array.isArray(inputs) || inputs.length === 0) throw new Error("need at least one input");
  if (!Array.isArray(outputs) || outputs.length === 0) throw new Error("need at least one output");
  const digests = [];
  for (let i = 0; i < inputs.length; i++) {
    const inp = inputs[i];
    if (!(inp.leafScript instanceof Uint8Array) || inp.leafScript.length === 0) throw new Error("bad leaf script");
    if (!(inp.controlBlock instanceof Uint8Array) || (inp.controlBlock.length !== 33 && inp.controlBlock.length !== 65)) {
      throw new Error("bad control block");
    }
    digests.push(tapSighashMulti(network, inputs, outputs, i, inp.leafScript, { locktime }));
  }
  const outs = [];
  for (const o of outputs) {
    const s = p2trScriptPubKey(o.program);
    outs.push(...u64le(o.value), ...varint(s.length), ...s);
  }
  const base = [...u32le(network.txVersion), ...varint(inputs.length)];
  for (const inp of inputs) {
    base.push(...txidLE(inp.txid), ...u32le(inp.vout), ...varint(0), ...u32le(inp.sequence));
  }
  base.push(...varint(outputs.length), ...outs, ...u32le(locktime));

  const full = [...u32le(network.txVersion), 0x00, 0x01, ...varint(inputs.length)];
  for (const inp of inputs) {
    full.push(...txidLE(inp.txid), ...u32le(inp.vout), ...varint(0), ...u32le(inp.sequence));
  }
  full.push(...varint(outputs.length), ...outs);
  for (const inp of inputs) {
    const items = [...(inp.stackItems || []), inp.leafScript, inp.controlBlock];
    full.push(...varint(items.length));
    for (const w of items) {
      const b = w instanceof Uint8Array ? w : hexToBytes(String(w));
      full.push(...varint(b.length), ...b);
    }
  }
  full.push(...u32le(locktime));

  const txid = bytesToHex(dblSha(Uint8Array.from(base)).reverse());
  const baseBytes = base.length;
  const totalBytes = full.length;
  const vBytes = Math.ceil((baseBytes * 3 + totalBytes) / 4);
  return {
    txid, hex: bytesToHex(Uint8Array.from(full)),
    digests: digests.map(bytesToHex), vBytes, baseBytes, totalBytes,
  };
}

/** Sign every input of a plan with the arbiter/refund privkey and build the
 *  final transaction. EVERY signature is re-verified against the signing
 *  x-only key before it enters the bundle — a bad signature never ships. */
export function signBundle({ norm, plan, privHex, signingXOnlyHex, kind }) {
  const network = norm.hrp === "tprl" ? NETWORKS.testnet : NETWORKS.mainnet;
  const priv = privHex instanceof Uint8Array ? privHex : hexToBytes(String(privHex).trim());
  if (priv.length !== 32) throw new Error("signing key must be 32 bytes");
  const signingXOnly = signingXOnlyHex instanceof Uint8Array ? signingXOnlyHex : hexToBytes(String(signingXOnlyHex).trim());
  if (signingXOnly.length !== 32) throw new Error("signing x-only key must be 32 bytes");

  const locktime = kind === "void" ? norm.resolveH : 0;
  const inputs = plan.inputs.map((inp) => ({
    txid: inp.txid, vout: inp.vout, value: inp.value, spk: inp.spk,
    sequence: kind === "void" ? REFUND_SEQ : MAX_SEQ,
    leafScript: inp.leafScript, controlBlock: inp.controlBlock,
    stackItems: [],
  }));
  const outputs = plan.outputs.map((o) => ({ program: o.program, value: o.value }));

  const sigs = [];
  for (let i = 0; i < inputs.length; i++) {
    const digest = tapSighashMulti(network, inputs, outputs, i, inputs[i].leafScript, { locktime });
    const sig = signForXOnly(priv, digest);
    if (!verifySchnorrSig(sig, digest, signingXOnly)) {
      throw new Error(`PAYOUT REFUSED: signature ${i} failed re-verification — signing key does not match the committed ${kind === "void" ? "refund" : "arbiter"} key`);
    }
    sigs.push(bytesToHex(sig));
    inputs[i].stackItems = [sig];
  }
  const built = buildMultiInputScriptPathSpend(network, inputs, outputs, { locktime });
  return {
    kind,
    descriptor: marketDescriptor(norm),
    marketHash: marketHashHex(norm),
    feeRate: plan.feeRateGrainsPerVByte,
    winIndex: plan.kind === "award" ? plan.winIndex : null,
    signingXOnly: bytesToHex(signingXOnly),
    locktime,
    vBytes: built.vBytes,
    fee: plan.fee,
    totalIn: plan.inputs.reduce((a, x) => a + x.value, 0),
    inputs: plan.inputs.map((inp, i) => ({
      txid: inp.txid, vout: inp.vout, value: inp.value,
      outcomeIndex: inp.outcomeIndex, outcomeName: inp.outcomeName,
      sig: sigs[i],
    })),
    outputs: plan.outputs.map((o) => ({ address: o.address, value: o.value, stake: o.stake })),
    txid: built.txid,
    hex: built.hex,
  };
}

/* ------------------------------------------------------------------ */
/* Standalone verifier                                                  */
/* ------------------------------------------------------------------ */

/** Verify a payout bundle against a descriptor + canonical market JSON.
 *  Returns { proven, failures[], warnings[], summary } — PROVEN only when
 *  every check passes; any tampering yields a loud NOT PROVEN. */
export function verifyBundle({ descriptor, marketJSON, bundle }) {
  const failures = [];
  const warnings = [];
  let norm = null;
  try {
    const parsed = JSON.parse(marketJSON);
    norm = validateMarketSpec({
      question: parsed.question, outcomes: parsed.outcomes, source: parsed.source,
      tradeH: parsed.tradeH, resolveH: parsed.resolveH,
      arbiterKeyInput: parsed.arbiter, refundKeyInput: parsed.refund, hrp: parsed.hrp,
    });
  } catch (e) {
    failures.push("market JSON invalid: " + e.message);
  }
  let d = null;
  try { d = parseMarketDescriptor(descriptor); }
  catch (e) { failures.push("descriptor malformed: " + e.message); }

  if (norm && d) {
    const dv = verifyMarketDescriptor(norm, descriptor);
    if (!dv.ok) failures.push(...dv.failures);
  }
  if (!bundle || typeof bundle !== "object") {
    failures.push("bundle missing or not an object");
    return { proven: false, failures, warnings, summary: "NOT PROVEN" };
  }
  if (norm && bundle.descriptor !== marketDescriptor(norm)) {
    failures.push("bundle descriptor does not match the market descriptor");
  }
  if (norm && bundle.marketHash !== marketHashHex(norm)) {
    failures.push("bundle marketHash does not match the market");
  }

  if (norm) {
    const contracts = allOutcomeContracts(norm);
    const network = norm.hrp === "tprl" ? NETWORKS.testnet : NETWORKS.mainnet;
    // Arbiter/refund key match + per-outcome address recompute
    const expectSigner = bundle.kind === "void" ? norm.refundXOnly : norm.arbiterXOnly;
    if (bundle.signingXOnly !== expectSigner) {
      failures.push(`bundle signing key does not match the market's ${bundle.kind === "void" ? "refund" : "arbiter"} key`);
    }
    const spkByOutcome = contracts.map((c) => bytesToHex(c.spk));
    const inputs = Array.isArray(bundle.inputs) ? bundle.inputs : [];
    const outputs = Array.isArray(bundle.outputs) ? bundle.outputs : [];
    if (inputs.length === 0) failures.push("bundle has no inputs");
    if (outputs.length === 0) failures.push("bundle has no outputs");
    const seenIn = new Set();
    for (const inp of inputs) {
      const k = `${inp.txid}:${inp.vout}`;
      if (seenIn.has(k)) failures.push(`duplicate bundle input ${k}`);
      seenIn.add(k);
      if (!Number.isInteger(inp.outcomeIndex) || inp.outcomeIndex < 0 || inp.outcomeIndex >= contracts.length) {
        failures.push(`input ${k} has out-of-range outcomeIndex`);
        continue;
      }
    }
    // Proportionality within dust: recompute the plan from the bundle's own
    // inputs and compare against the bundle's outputs.
    try {
      const positions = inputs.map((inp) => {
        const c = contracts[inp.outcomeIndex];
        // recover funder address: not in bundle inputs — use outputs' addresses
        // mapped by position order? Instead: re-derive plan outputs keyed by
        // stake; match bundle outputs to recomputed ones by value multiset.
        return { outcomeIndex: inp.outcomeIndex, txid: inp.txid, vout: inp.vout, value: inp.value, funderAddr: outputs[0].address };
      });
      // NOTE: funder addresses are not committed per-input in the bundle, so
      // the proportionality check compares the VALUE multiset only.
      let expected;
      if (bundle.kind === "award") {
        expected = planAwardPayout({ norm, contracts, positions, winIndex: bundle.winIndex, feeRateGrainsPerVByte: bundle.feeRate });
      } else if (bundle.kind === "void") {
        expected = planVoidRefund({ norm, contracts, positions, feeRateGrainsPerVByte: bundle.feeRate });
      } else {
        failures.push("bundle kind must be award or void");
      }
      if (expected) {
        const expVals = expected.outputs.map((o) => o.value).sort((a, b) => a - b);
        const gotVals = outputs.map((o) => o.value).sort((a, b) => a - b);
        if (expVals.length !== gotVals.length) {
          failures.push(`output count mismatch: bundle has ${gotVals.length}, recomputed ${expVals.length}`);
        } else {
          let maxDelta = 0;
          for (let i = 0; i < expVals.length; i++) {
            maxDelta = Math.max(maxDelta, Math.abs(expVals[i] - gotVals[i]));
          }
          if (maxDelta > DUST_GRAIN) {
            failures.push(`payout proportionality violated: max deviation ${maxDelta} grains exceeds dust (${DUST_GRAIN})`);
          } else if (maxDelta > 0) {
            warnings.push(`payouts deviate up to ${maxDelta} grains from exact pro-rata (within dust)`);
          }
        }
        // output addresses must be P2TR on the right network
        for (const o of outputs) {
          try { addressToProgram(o.address, network); }
          catch (e) { failures.push(`bad payout address ${o.address}: ${e.message}`); }
          if (!Number.isSafeInteger(o.value) || o.value < DUST_GRAIN) {
            failures.push(`payout output below dust: ${o.value}`);
          }
        }
        const sumOut = outputs.reduce((a, o) => a + o.value, 0);
        const sumIn = inputs.reduce((a, x) => a + x.value, 0);
        if (sumIn - sumOut !== bundle.fee) {
          failures.push(`fee mismatch: inputs-outputs = ${sumIn - sumOut}, bundle claims ${bundle.fee}`);
        }
      }
    } catch (e) {
      failures.push("payout recomputation failed: " + e.message);
    }
    // Signature validity: recompute every input digest and verify.
    try {
      const locktime = bundle.kind === "void" ? norm.resolveH : 0;
      const seqFor = (bundle.kind === "void" ? REFUND_SEQ : MAX_SEQ);
      const sigInputs = inputs.map((inp) => {
        const c = contracts[inp.outcomeIndex];
        const leafScript = bundle.kind === "void" ? c.leafB : c.leafA;
        const controlBlock = bundle.kind === "void" ? c.controlBlocks[1] : c.controlBlocks[0];
        return {
          txid: inp.txid, vout: inp.vout, value: inp.value, spk: c.spk,
          sequence: seqFor, leafScript, controlBlock, stackItems: [],
        };
      });
      const sigOutputs = outputs.map((o) => ({ program: addressToProgram(o.address, network), value: o.value }));
      const signer = bundle.kind === "void" ? norm.refundXOnly : norm.arbiterXOnly;
      inputs.forEach((inp, i) => {
        const digest = tapSighashMulti(network, sigInputs, sigOutputs, i, sigInputs[i].leafScript, { locktime });
        if (!verifySchnorrSig(inp.sig, digest, signer)) {
          failures.push(`input ${i} (${inp.txid.slice(0, 12)}…:${inp.vout}) signature INVALID against the market ${bundle.kind === "void" ? "refund" : "arbiter"} key`);
        }
      });
    } catch (e) {
      failures.push("signature verification crashed: " + e.message);
    }
    // txid self-consistency: re-serialize and compare
    try {
      const locktime = bundle.kind === "void" ? norm.resolveH : 0;
      const seqFor = (bundle.kind === "void" ? REFUND_SEQ : MAX_SEQ);
      const sInputs = inputs.map((inp) => {
        const c = contracts[inp.outcomeIndex];
        const leafScript = bundle.kind === "void" ? c.leafB : c.leafA;
        const controlBlock = bundle.kind === "void" ? c.controlBlocks[1] : c.controlBlocks[0];
        return {
          txid: inp.txid, vout: inp.vout, value: inp.value, spk: c.spk,
          sequence: seqFor, leafScript, controlBlock, stackItems: [hexToBytes(inp.sig)],
        };
      });
      const sOutputs = outputs.map((o) => ({ program: addressToProgram(o.address, network), value: o.value }));
      const rebuilt = buildMultiInputScriptPathSpend(network, sInputs, sOutputs, { locktime });
      if (rebuilt.txid !== bundle.txid) failures.push("bundle txid does not match re-serialized transaction — tampered");
      if (rebuilt.hex !== bundle.hex) failures.push("bundle raw hex does not match re-serialized transaction — tampered");
    } catch (e) {
      failures.push("tx re-serialization failed: " + e.message);
    }
  }
  const proven = failures.length === 0;
  return {
    proven, failures, warnings,
    summary: proven ? "PROVEN" : "NOT PROVEN",
  };
}

/* ------------------------------------------------------------------ */
/* Formatting helpers                                                  */
/* ------------------------------------------------------------------ */

/** BigInt grains -> "1.23456789" PRL string. */
export function fmtPRL(grains) {
  const g = BigInt(grains);
  const neg = g < 0n;
  const a = neg ? -g : g;
  const G = BigInt(GRAIN_PER_PRL);
  const whole = a / G;
  const frac = (a % G).toString().padStart(8, "0").replace(/0+$/, "") || "0";
  return (neg ? "-" : "") + whole.toString() + "." + frac;
}

/** "1.5" -> 150000000n grains. */
export function parsePRLToGrains(s) {
  const t = String(s || "").trim();
  const m = /^(\d+)(?:\.(\d{1,8}))?$/.exec(t);
  if (!m) throw new Error("bad PRL amount");
  return BigInt(m[1]) * BigInt(GRAIN_PER_PRL) + BigInt((m[2] || "").padEnd(8, "0") || "0");
}

/** Blocks remaining -> human countdown using the 194 s block target. */
export function blocksToCountdown(blocks) {
  const b = Number(blocks);
  if (!Number.isFinite(b) || b <= 0) return "closed";
  const secs = Math.round(b * BLOCK_TARGET_SECONDS);
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Implied probabilities from per-outcome pot totals. */
export function impliedProbabilities(potTotals) {
  const pots = potTotals.map(Number);
  const total = pots.reduce((a, b) => a + b, 0);
  if (total <= 0) return pots.map(() => 0);
  return pots.map((p) => p / total);
}
