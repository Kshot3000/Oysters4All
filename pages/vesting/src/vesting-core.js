/* Pearl Vesting core — timelocked PRL vesting schedules on Taproot.
 *
 * Pure ESM, zero build step for developers. The browser ships a committed
 * esbuild IIFE bundle (pearl-vesting.bundle.js); node runs this file
 * directly for the verification suite.
 *
 * What this does:
 *   1. Schedule: a funder (f) locks PRL for a beneficiary (b) in N tranches.
 *      Each tranche i gets its own P2TR address committing a script tree:
 *        leaf A (claim):    <L_i> OP_CHECKLOCKTIMEVERIFY OP_DROP <b> OP_CHECKSIG
 *        leaf B (clawback, only when revocable):
 *                           <L_i> OP_CHECKLOCKTIMEVERIFY OP_DROP <f> OP_CHECKSIG
 *      The internal key is a nothing-up-my-sleeve point derived from the
 *      tranche's own scripts — nobody controls it, so there is no keypath
 *      bypass: funds can only move through leaf A (after L_i) or leaf B
 *      (after L_i, if revocable).
 *      Locktimes L_i may be unix timestamps (>= 500_000_000, the UI default
 *      for calendar dates) or block heights (< 500_000_000). The claim tx
 *      sets nLockTime = L_i and sequence 0xfffffffe (non-final, RBF-safe),
 *      so CLTV is satisfied exactly.
 *   2. Claim: the beneficiary imports their key, the app fetches each funded
 *      tranche's UTXOs from Blockbook, builds ONE transaction per matured
 *      tranche (single-input script-path spend, exact vBytes fee math, dust
 *      refusal), signs locally with Schnorr, RE-VERIFIES every signature
 *      before exposing hex, then broadcasts.
 *   3. Clawback (revocable schedules): the funder reclaims still-unclaimed
 *      matured tranches through leaf B with their own key.
 *   4. Descriptor: `vesting:v1:<hrp>:<b>:<f>:<r|n>:<raw|addr>:<N>:<lock0,lock1,...>`
 *      fully determines every tranche address; anyone can re-derive the
 *      schedule from the descriptor and verify the funder funded the right
 *      addresses — tamper-evident handoff (copy/paste, QR, file).
 *
 * Crypto lineage: key derivation, TapTweak, bech32m, BIP-341 sighash and
 * wire serialization come from the audited files/pages/sign/src/crypto.js;
 * script-path spend, fee planning, and the CLTV script shape come from the
 * audited files/pages/escrow/src/escrow-core.js (their refund leaf is
 * <lock> CLTV DROP <key> CHECKSIG; this file generalizes it to timestamps
 * and adds the NUMS-internal-key tree). No new cryptography is invented.
 *
 * Scope (v1): one transaction per claimed tranche. A schedule holding
 * several matured tranches is claimed one tranche at a time — each claim
 * is a complete, independently verifiable transaction.
 */

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
  partyKeyFromInput, parseXOnlyKey, scriptPathSigDigestEx,
  signForXOnly, verifySchnorrSig, buildScriptPathSpend,
  spendVBytes, planSpend, addressToProgram, scriptAsm,
  encodeScriptNum,
} from "../../escrow/src/escrow-core.js";
import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesToNumberBE, numberToBytesBE } from "@noble/curves/abstract/utils";

export {
  DUST_GRAIN, GRAIN_PER_PRL, NETWORKS,
  walletFromMnemonic, newMnemonic, walletFromWIF,
  tweakKeypath, tweakPrivKeypath,
  fetchUtxos, fetchFeeRateGrainsPerVByte, broadcastTx, fetchTxStatus,
  bytesToHex, hexToBytes, schnorr, sha256, dblSha, convertBits,
  encodeBech32m, decodeBech32m, p2trScriptPubKey, txidLE,
  partyKeyFromInput, parseXOnlyKey, scriptAsm, addressToProgram,
  verifySchnorrSig, signForXOnly, scriptPathSigDigestEx,
  encodeScriptNum, spendVBytes, planSpend,
};

const OP = {
  FALSE: 0x00,
  DROP: 0x75,
  CHECKSIG: 0xac,
  CLTV: 0xb1,
};
const TAPLEAF_VERSION = 0xc0;
const LOCKTIME_THRESHOLD = 500_000_000; // >= threshold: unix timestamp; < threshold: block height
const MAX_LOCKTIME = 0xffffffff;
const MAX_SEQ_NONFINAL = 0xfffffffe; // non-final (CLTV satisfied) + RBF-safe
export const MAX_TRANCHES = 64;
export const DESCRIPTOR_PREFIX = "vesting:v1";

function constEq(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

function pushData(data) {
  const b = data instanceof Uint8Array ? data : Uint8Array.from(data);
  if (b.length === 0) return [OP.FALSE];
  if (b.length <= 75) return [b.length, ...b];
  throw new Error("push exceeds 75 bytes");
}

/** Resolve the beneficiary's leaf key from funder-supplied input.
 *  - 64-hex x-only pubkey: used raw (mode 'raw') — the beneficiary signs
 *    with the matching private key / mnemonic.
 *  - PRL address (prl1p…): its 32-byte program is used as the leaf key
 *    (mode 'address') — the beneficiary later signs with their
 *    keypath-tweaked private key (standard for BIP-86 wallets).
 *  - 12/24-word mnemonic: the internal key is tweaked to its keypath
 *    address program (mode 'address').
 *  Returns { key, mode, internalXOnly?, source }. Private keys are never
 *  returned here; the claim step re-derives them from the beneficiary's
 *  own import. */
export function beneficiaryKeyFromInput(input, network) {
  const t = String(input || "").trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) {
    return { key: parseXOnlyKey(t), mode: "raw", source: "x-only pubkey" };
  }
  const words = t.split(/\s+/);
  if (words.length === 12 || words.length === 24) {
    const w = walletFromMnemonic(t, network);
    const { tweakedX } = tweakKeypath(w.internalXOnly);
    return { key: tweakedX, mode: "address", internalXOnly: w.internalXOnly, source: "mnemonic (keypath-tweaked)" };
  }
  const program = addressToProgram(t, network); // throws on bad address/hrp/version
  return { key: program, mode: "address", source: "PRL address" };
}

/** Derive the beneficiary's signer private key for a claim.
 *  secretInput: the beneficiary's mnemonic or WIF (never persisted by callers).
 *  Throws unless the derived key matches the leaf key for the given mode. */
export function beneficiarySignerFor(secretInput, network, leafKeyHex, mode) {
  const t = String(secretInput || "").trim();
  let w;
  const words = t.split(/\s+/);
  if (words.length === 12 || words.length === 24) {
    w = walletFromMnemonic(t, network);
  } else {
    try {
      w = walletFromWIF(t, network);
    } catch {
      throw new Error("beneficiary secret must be a 12/24-word mnemonic or WIF private key");
    }
  }
  if (mode === "raw") {
    if (bytesToHex(w.internalXOnly).toLowerCase() !== String(leafKeyHex).toLowerCase()) {
      throw new Error("this key does not match the beneficiary key in the schedule");
    }
    return { priv: w.priv, xonly: w.internalXOnly };
  }
  const { tweakedX } = tweakKeypath(w.internalXOnly);
  if (bytesToHex(tweakedX).toLowerCase() !== String(leafKeyHex).toLowerCase()) {
    throw new Error("this key does not match the beneficiary address in the schedule");
  }
  const priv = tweakPrivKeypath(w.priv, w.internalXOnly);
  return { priv, xonly: tweakedX };
}

/** Validate a locktime. Accepts block heights (< 500_000_000) and unix
 *  timestamps (>= 500_000_000). Throws on anything consensus-invalid. */
export function validateLocktime(lock) {
  if (!Number.isSafeInteger(lock) || lock <= 0 || lock > MAX_LOCKTIME) {
    throw new Error("locktime must be an integer in 1..4294967295");
  }
  return lock >= LOCKTIME_THRESHOLD ? "time" : "height";
}

/** CLTV leaf: <lock> OP_CHECKLOCKTIMEVERIFY OP_DROP <xonly> OP_CHECKSIG.
 *  Spendable by `key` once the tx nLockTime reaches `lock` (same type). */
export function buildCltvScript(xonly, lock) {
  const k = xonly instanceof Uint8Array ? xonly : parseXOnlyKey(xonly);
  if (k.length !== 32) throw new Error("party key must be 32 bytes");
  schnorr.utils.lift_x(bytesToNumberBE(k)); // rejects x >= p
  validateLocktime(lock);
  const l = encodeScriptNum(lock);
  return Uint8Array.from([...pushData(l), OP.CLTV, OP.DROP, ...pushData(k), OP.CHECKSIG]);
}

/** NUMS internal key bound to this tranche's scripts. Derived as
 *  H("PearlVestingNUMS/v1" || scripts...) lifted to the curve — a point
 *  nobody controls, so keypath spending is impossible and the address is
 *  fully determined by the scripts. */
export function numsInternalKeyVesting(scripts) {
  if (!Array.isArray(scripts) || scripts.length < 1 || scripts.length > 2) {
    throw new Error("need 1..2 leaf scripts");
  }
  const preimage = Uint8Array.from(scripts.flatMap((s) => [...s]));
  for (let ctr = 0; ; ctr++) {
    const h = taggedHash("PearlVestingNUMS/v1", Uint8Array.from([...preimage, ctr]));
    try {
      return schnorr.utils.pointToBytes(schnorr.utils.lift_x(bytesToNumberBE(h)));
    } catch {
      continue; // hash lands off-curve — practically unreachable, re-hash with counter
    }
  }
}

function tapBranch(a, b) {
  const [x, y] = bytesToHex(a) <= bytesToHex(b) ? [a, b] : [b, a];
  return taggedHash("TapBranch", Uint8Array.from([...x, ...y]));
}

/** 1- or 2-leaf taptree under a given internal key. Returns address, spk,
 *  tweaked key, parity, per-leaf control blocks (33 bytes for one leaf,
 *  65 bytes for two leaves). */
export function taptreeN(network, internalXOnly, scripts) {
  if (!(internalXOnly instanceof Uint8Array) || internalXOnly.length !== 32) {
    throw new Error("internal key must be 32 bytes");
  }
  if (!Array.isArray(scripts) || scripts.length < 1 || scripts.length > 2) {
    throw new Error("need 1..2 leaf scripts");
  }
  const leafHashes = scripts.map(tapLeafHash);
  const root = leafHashes.length === 1 ? leafHashes[0] : tapBranch(leafHashes[0], leafHashes[1]);
  const t = taggedHash("TapTweak", Uint8Array.from([...internalXOnly, ...root]));
  const P = schnorr.utils.lift_x(bytesToNumberBE(internalXOnly));
  const Q = P.add(schnorr.Point.BASE.multiply(bytesToNumberBE(t)));
  const tweakedX = schnorr.utils.pointToBytes(Q);
  const parity = Q.toAffine().y & 1n ? 1 : 0;
  const controlBlocks = leafHashes.map((lh, i) => {
    const parts = [TAPLEAF_VERSION | parity, ...internalXOnly];
    if (leafHashes.length === 2) parts.push(...leafHashes[1 - i]);
    return Uint8Array.from(parts);
  });
  return {
    leafHashes, root, tweak: t, tweakedX, parity,
    internalXOnly,
    address: encodeBech32m(network.hrp, 1, tweakedX),
    spk: p2trScriptPubKey(tweakedX),
    controlBlocks,
  };
}

/** Forge one tranche: claim leaf (beneficiary) + optional clawback leaf
 *  (funder), under a NUMS internal key. Returns everything the UI needs. */
export function forgeTranche(network, beneficiaryXOnly, funderXOnly, lock, revocable) {
  const b = beneficiaryXOnly instanceof Uint8Array ? beneficiaryXOnly : parseXOnlyKey(beneficiaryXOnly);
  const f = funderXOnly instanceof Uint8Array ? funderXOnly : parseXOnlyKey(funderXOnly);
  const claimScript = buildCltvScript(b, lock);
  const clawbackScript = revocable ? buildCltvScript(f, lock) : null;
  const scripts = clawbackScript ? [claimScript, clawbackScript] : [claimScript];
  const internalXOnly = numsInternalKeyVesting(scripts);
  const tree = taptreeN(network, internalXOnly, scripts);
  return {
    lock, lockKind: validateLocktime(lock),
    beneficiary: bytesToHex(b), funder: bytesToHex(f), revocable: !!revocable,
    claimScript, clawbackScript,
    internalXOnly, tweakedX: tree.tweakedX, parity: tree.parity,
    address: tree.address, spk: tree.spk,
    controlBlocks: tree.controlBlocks, // [claim, clawback?]
    claimControlBlock: tree.controlBlocks[0],
    clawbackControlBlock: clawbackScript ? tree.controlBlocks[1] : null,
  };
}

/** Parse a PRL amount string into grains (Number, exact). Fleet-standard
 *  strict form — digits with an optional fraction of at most 8 decimal
 *  places, computed in BigInt and range-checked to a safe integer. This
 *  replaces the UI's old float parse (Math.round(parseFloat(x) * 1e8)),
 *  which silently truncated "1.2.3" to 1.2 PRL and silently rounded
 *  sub-grain inputs like "25.123456789" instead of rejecting them: in a
 *  schedule forge the parsed amount is locked into timelocked tranches,
 *  so a misparse is a wrong-amount schedule, not a display glitch.
 *  Throws on bad input. */
export function parsePRLToGrains(s) {
  if (typeof s !== "string") throw new Error("amount must be a string");
  const t = s.trim();
  const m = /^(\d+)(?:\.(\d{1,8}))?$/.exec(t);
  if (!m) throw new Error(`invalid PRL amount: ${t.slice(0, 40)}`);
  const grains = BigInt(m[1]) * BigInt(GRAIN_PER_PRL) + (m[2] ? BigInt(m[2].padEnd(8, "0")) : 0n);
  if (grains > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`PRL amount out of range: ${t.slice(0, 40)}`);
  }
  return Number(grains);
}

/** Split totalGrains into `count` tranches: floor each, remainder to the
 *  last tranche. Every tranche must clear dust. */
function splitAmounts(totalGrains, count) {
  if (!Number.isSafeInteger(totalGrains) || totalGrains <= 0) throw new Error("total must be a positive integer of grains");
  if (!Number.isInteger(count) || count < 1 || count > MAX_TRANCHES) {
    throw new Error(`tranche count must be an integer in 1..${MAX_TRANCHES}`);
  }
  const base = Math.floor(totalGrains / count);
  if (base < DUST_GRAIN) {
    throw new Error(`each tranche would be ${base} grains — below dust (${DUST_GRAIN}); raise the total or reduce tranches`);
  }
  const amounts = new Array(count).fill(base);
  amounts[count - 1] += totalGrains - base * count;
  return amounts;
}

/** Plan a linear schedule: tranche i unlocks at
 *  startTime + cliff + round(remaining * i / (N-1)).
 *  Or pass customTranches: [{lock, amountGrains}] sorted by lock.
 *  `beneficiary` may be a raw x-only key (hex/Uint8Array, mode 'raw') or a
 *  { key, mode } object from beneficiaryKeyFromInput(). */
export function planSchedule({ network, beneficiary, beneficiaryXOnly, funderXOnly, totalGrains, startTime, cliffSeconds, vestSeconds, trancheCount, revocable = true, customTranches = null }) {
  if (!network || !network.hrp) throw new Error("network required");
  let bmode = "raw";
  let bkey = beneficiaryXOnly;
  if (beneficiary && typeof beneficiary === "object" && beneficiary.key) {
    bkey = beneficiary.key;
    bmode = beneficiary.mode === "address" ? "address" : "raw";
  }
  const b = bkey instanceof Uint8Array ? bkey : parseXOnlyKey(bkey);
  const f = funderXOnly instanceof Uint8Array ? funderXOnly : parseXOnlyKey(funderXOnly);
  let trancheSpecs;
  if (customTranches) {
    if (!Array.isArray(customTranches) || customTranches.length === 0 || customTranches.length > MAX_TRANCHES) {
      throw new Error(`custom tranches must be a non-empty list of at most ${MAX_TRANCHES}`);
    }
    trancheSpecs = customTranches.map((t, i) => {
      validateLocktime(t.lock);
      if (!Number.isSafeInteger(t.amountGrains) || t.amountGrains < DUST_GRAIN) {
        throw new Error(`tranche ${i + 1}: amount must be a positive integer >= dust (${DUST_GRAIN} grains)`);
      }
      return { lock: t.lock, amountGrains: t.amountGrains };
    });
    trancheSpecs.sort((a, z) => a.lock - z.lock);
    for (let i = 1; i < trancheSpecs.length; i++) {
      if (trancheSpecs[i].lock <= trancheSpecs[i - 1].lock) {
        throw new Error("custom tranche locktimes must be strictly increasing");
      }
    }
    totalGrains = trancheSpecs.reduce((s, t) => s + t.amountGrains, 0);
  } else {
    if (!Number.isSafeInteger(startTime) || startTime < 0) throw new Error("start time must be a non-negative unix timestamp");
    if (!Number.isSafeInteger(cliffSeconds) || cliffSeconds < 0) throw new Error("cliff must be a non-negative number of seconds");
    if (!Number.isSafeInteger(vestSeconds) || vestSeconds <= 0) throw new Error("vest period must be a positive number of seconds");
    if (!Number.isInteger(trancheCount) || trancheCount < 1 || trancheCount > MAX_TRANCHES) {
      throw new Error(`tranche count must be an integer in 1..${MAX_TRANCHES}`);
    }
    const amounts = splitAmounts(totalGrains, trancheCount);
    const remaining = vestSeconds - Math.min(cliffSeconds, vestSeconds);
    trancheSpecs = amounts.map((amountGrains, i) => {
      const lock = trancheCount === 1
        ? startTime + cliffSeconds
        : startTime + cliffSeconds + Math.round(remaining * (i / (trancheCount - 1)));
      validateLocktime(lock);
      return { lock, amountGrains };
    });
  }
  const seen = new Set();
  for (const t of trancheSpecs) {
    const k = `${t.lock}`;
    if (seen.has(k)) throw new Error("two tranches share the same locktime — merge them");
    seen.add(k);
  }
  const tranches = trancheSpecs.map((spec, i) => {
    const forge = forgeTranche(network, b, f, spec.lock, revocable);
    return {
      index: i, ...forge,
      amountGrains: spec.amountGrains,
      lockDateISO: new Date(spec.lock * 1000).toISOString(),
    };
  });
  const schedule = {
    kind: "pearl-vesting-schedule", version: 1,
    networkHrp: network.hrp,
    beneficiary: bytesToHex(b), beneficiaryMode: bmode,
    funder: bytesToHex(f),
    revocable: !!revocable, totalGrains,
    locks: tranches.map((t) => t.lock),
    descriptor: descriptorFor(network, b, f, revocable, bmode, tranches.map((t) => t.lock)),
  };
  return { schedule, tranches };
}

/** Deterministic descriptor: everything needed to re-derive the schedule.
 *  The mode bit ('raw' vs 'addr') tells the claim step how the beneficiary
 *  key must sign; it does not change any address. */
export function descriptorFor(network, beneficiaryXOnly, funderXOnly, revocable, mode, locks) {
  if (Array.isArray(mode)) { locks = mode; mode = "raw"; } // backwards-tolerant
  const b = bytesToHex(beneficiaryXOnly instanceof Uint8Array ? beneficiaryXOnly : parseXOnlyKey(beneficiaryXOnly));
  const f = bytesToHex(funderXOnly instanceof Uint8Array ? funderXOnly : parseXOnlyKey(funderXOnly));
  const m = mode === "address" ? "addr" : "raw";
  if (!Array.isArray(locks) || locks.length === 0) throw new Error("locks required");
  for (const l of locks) validateLocktime(l);
  return `${DESCRIPTOR_PREFIX}:${network.hrp}:${b}:${f}:${revocable ? "r" : "n"}:${m}:${locks.length}:${locks.join(",")}`;
}

/** Parse a descriptor string into its components. */
export function parseDescriptor(descriptor) {
  const m = /^vesting:v1:([a-z0-9]{2,8}):([0-9a-f]{64}):([0-9a-f]{64}):([rn]):(raw|addr):(\d+):(\d+(?:,\d+)*)$/i.exec(String(descriptor || "").trim());
  if (!m) throw new Error("descriptor must look like vesting:v1:<hrp>:<b>:<f>:<r|n>:<raw|addr>:<N>:<lock0,lock1,...>");
  const locks = m[7].split(",").map(Number);
  if (locks.length !== Number(m[6])) throw new Error("descriptor tranche count does not match its lock list");
  for (const l of locks) validateLocktime(l);
  const net = Object.values(NETWORKS).find((n) => n.hrp === m[1].toLowerCase());
  if (!net) throw new Error("unknown network hrp '" + m[1] + "' (expected prl/tprl/rprl)");
  return { network: net, beneficiary: m[2].toLowerCase(), funder: m[3].toLowerCase(), revocable: m[4] === "r", mode: m[5] === "addr" ? "address" : "raw", locks };
}

/** Re-derive a schedule from a descriptor + per-tranche expected amounts.
 *  Throws if recomputation does not reproduce the descriptor (tampered). */
export function scheduleFromDescriptor(descriptor, amounts = null) {
  const p = parseDescriptor(descriptor);
  const tranches = p.locks.map((lock, i) => {
    const forge = forgeTranche(p.network, p.beneficiary, p.funder, lock, p.revocable);
    return { index: i, ...forge, amountGrains: amounts && amounts[i] != null ? amounts[i] : 0, lockDateISO: new Date(lock * 1000).toISOString() };
  });
  const recomputed = descriptorFor(p.network, p.beneficiary, p.funder, p.revocable, p.mode, p.locks);
  if (recomputed !== String(descriptor).trim()) throw new Error("descriptor failed self-consistency check");
  return {
    schedule: { kind: "pearl-vesting-schedule", version: 1, networkHrp: p.network.hrp, beneficiary: p.beneficiary, beneficiaryMode: p.mode, funder: p.funder, revocable: p.revocable, locks: p.locks, descriptor: recomputed },
    tranches,
  };
}

/** Tranche is spendable (via claim) once chain time >= lock. */
export function isMature(lock, chainTime) {
  validateLocktime(lock);
  return Number.isSafeInteger(chainTime) && chainTime >= lock;
}

/** Best-effort chain time from Blockbook: latest block's timestamp.
 *  Returns unix seconds, or null when unreachable. */
export async function fetchChainTime(blockbookBase) {
  try {
    const base = String(blockbookBase || "").replace(/\/+$/, "");
    if (!base) return null;
    const s = await (await fetch(`${base}/api/v2`)).json();
    const h = s && s.blockbook && s.blockbook.bestHeight;
    if (!Number.isInteger(h)) return null;
    const b = await (await fetch(`${base}/api/v2/block/${h}`)).json();
    return Number.isInteger(b.time) ? b.time : null;
  } catch {
    return null;
  }
}

/** Exact sweep plan for a single-input, single-output claim: the beneficiary
 *  receives everything minus the exact fee. Throws when the remainder
 *  would be dust (the funder must top the tranche up instead). */
export function planClaimSweep({ inputValue, feeRateGrainsPerVByte, scriptLen, controlLen }) {
  if (!Number.isSafeInteger(inputValue) || inputValue <= 0) throw new Error("bad input value");
  if (!Number.isFinite(feeRateGrainsPerVByte) || feeRateGrainsPerVByte <= 0) throw new Error("bad fee rate");
  const vBytes = spendVBytes({ nOut: 1, scriptLen, controlLen, stackLens: [64] });
  const fee = Math.ceil(vBytes * feeRateGrainsPerVByte);
  const payment = inputValue - fee;
  if (payment < DUST_GRAIN) {
    throw new Error(`insufficient funds: ${inputValue} grains covers the ${fee}-grain fee but leaves < dust (${DUST_GRAIN}); top the tranche up`);
  }
  return { payment, fee, vBytes };
}

/** Build, sign, and locally re-verify a single-tranche claim (or clawback)
 *  transaction. One UTXO in, ONE sweep output to `destinationProgram`.
 *  nLockTime = tranche.lock, sequence = 0xfffffffe (non-final so CLTV is
 *  satisfied; RBF still signalled). The returned hex is only produced
 *  after the signature verifies. */
export function buildClaimTx({ network, utxo, tranche, leaf, controlBlock, signerPriv, destinationProgram, feeRateGrainsPerVByte }) {
  if (!network || !network.hrp) throw new Error("network required");
  if (!utxo || !/^[0-9a-f]{64}$/i.test(utxo.txid || "")) throw new Error("utxo.txid required");
  if (!Number.isInteger(utxo.vout) || utxo.vout < 0) throw new Error("utxo.vout required");
  if (!Number.isSafeInteger(utxo.value) || utxo.value <= 0) throw new Error("utxo.value required");
  if (!(leaf instanceof Uint8Array) || leaf.length === 0) throw new Error("leaf script required");
  if (!(controlBlock instanceof Uint8Array) || (controlBlock.length !== 33 && controlBlock.length !== 65)) {
    throw new Error("control block required");
  }
  if (!(destinationProgram instanceof Uint8Array) || destinationProgram.length !== 32) {
    throw new Error("destination program must be 32 bytes");
  }
  const locktime = tranche.lock;
  validateLocktime(locktime);
  const input = { txid: utxo.txid, vout: utxo.vout, value: utxo.value, spk: tranche.spk };
  const sweep = planClaimSweep({
    inputValue: utxo.value,
    feeRateGrainsPerVByte,
    scriptLen: leaf.length,
    controlLen: controlBlock.length,
  });
  const outputs = [{ program: destinationProgram, value: sweep.payment }];
  const digest = scriptPathSigDigestEx(network, input, outputs, leaf, { sequence: MAX_SEQ_NONFINAL, locktime });
  // The signer must be the key committed in this leaf — a signature from any
  // other key verifies locally yet fails consensus. Parse the leaf shape:
  // <lock-push> CLTV DROP <32-byte-key-push> CHECKSIG.
  const leafKey = (() => {
    const lockLen = leaf[0];
    if (!Number.isInteger(lockLen) || lockLen < 1 || lockLen > 5) throw new Error("unexpected leaf shape");
    const p = 1 + lockLen; // p: CLTV, p+1: DROP, p+2: <32>, p+3..p+34: key, p+35: CHECKSIG
    if (leaf.length !== p + 36) throw new Error("unexpected leaf shape");
    if (leaf[p] !== 0xb1 || leaf[p + 1] !== 0x75 || leaf[p + 2] !== 32 || leaf[p + 35] !== 0xac) {
      throw new Error("unexpected leaf shape");
    }
    return leaf.slice(p + 3, p + 35);
  })();
  const sig = signForXOnly(signerPriv, digest);
  const signerX = (() => {
    const d = bytesToNumberBE(signerPriv instanceof Uint8Array ? signerPriv : hexToBytes(String(signerPriv)));
    const P = secp256k1.ProjectivePoint.fromPrivateKey(numberToBytesBE(d, 32));
    return schnorr.utils.pointToBytes(P);
  })();
  if (!constEq(signerX, leafKey)) {
    throw new Error("signer key does not match the key committed in this leaf — wrong key imported");
  }
  if (!verifySchnorrSig(sig, digest, signerX)) {
    throw new Error("local signature self-check failed — refusing to emit transaction hex");
  }
  const spend = buildScriptPathSpend(network, input, outputs, leaf, controlBlock, [sig], {
    sequence: MAX_SEQ_NONFINAL, locktime,
  });
  // Cross-check: builder's digest must equal ours.
  if (spend.digest !== bytesToHex(digest)) throw new Error("sighash mismatch between planner and serializer");
  return {
    txid: spend.txid, hex: spend.hex,
    fee: sweep.fee, vBytes: spend.vBytes, payment: sweep.payment,
    sigHex: bytesToHex(sig), digestHex: bytesToHex(digest),
    locktime, sequence: MAX_SEQ_NONFINAL,
    scriptAsm: scriptAsm(leaf),
  };
}

/** Expected tranche address recomputation — the audit one-liner. */
export function expectedAddress(network, beneficiaryXOnly, funderXOnly, lock, revocable) {
  return forgeTranche(network, beneficiaryXOnly, funderXOnly, lock, revocable).address;
}
