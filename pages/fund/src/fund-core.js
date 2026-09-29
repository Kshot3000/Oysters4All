/* Pearl Fund core — refundable PRL crowdfunding on pure Taproot script.
 *
 * Pure ESM, zero build step for developers. The browser ships a committed
 * esbuild IIFE bundle (pearl-fund.bundle.js); node runs this file directly
 * for the verification suite.
 *
 * What this does: a campaign is a per-backer Taproot address holding that
 * backer's pledge as a UTXO. Every pledge address commits to TWO script
 * leaves under a NUMS (nothing-up-my-sleeve) internal key — no keypath
 * backdoor, so coins move only through the leaves:
 *   leaf 0 (release): <recipient_xonly> OP_CHECKSIGVERIFY <creator_xonly> OP_CHECKSIG
 *                     recipient + campaign creator co-sign to release funds.
 *   leaf 1 (refund):  <deadline_height> OP_CHECKLOCKTIMEVERIFY OP_DROP <backer_xonly> OP_CHECKSIG
 *                     the backer can unilaterally refund after the deadline.
 * NUMS internal key: lift_x(SHA-256("PearlFundNUMS/v1" || recipient_xonly
 *                     || creator_xonly || u64le(goal_grains) || u32le(deadline)
 *                     || backer_xonly)) — deterministic and recomputable from
 *                     the pledge descriptor, same counter-fallback idiom as
 *                     pages/covenant's NUMS derivation.
 *
 * Witness order for the release leaf: script keys are consumed top-of-stack
 * first, so the LAST witness element pairs with the FIRST script key:
 * witness = [sig_creator, sig_recipient] (script key order), then the leaf
 * script, then the control block. (For sequential CHECKSIGs — NOT the
 * reversed CHECKSIGADD order used by pages/escrow.)
 *
 * Descriptors (tamper-evident, round-trip byte-exact, loud refusal):
 *   campaign: pearlfund:v1:<hrp>:<recipient_addr>:<creator_xonly_hex>:<goal_grains>:<deadline_height>
 *   pledge:   <campaign descriptor>:<backer_xonly_hex>
 *
 * HONEST LIMIT (repeated in the UI's always-visible honest-limits panel):
 * the "goal met" condition is enforced socially/by the UI, NOT
 * cryptographically — recipient+creator could co-sign a release early if
 * both agree, and the creator could refuse to co-sign even when the goal
 * is met. Nobody can steal: if the release never happens, every backer can
 * still refund after the deadline. Never imply the goal is
 * cryptographically gated.
 *
 * Crypto lineage: key derivation, TapTweak, bech32m, BIP-341 sighash and
 * wire serialization come from the audited files/pages/sign/src/crypto.js;
 * script composition helpers (parseXOnlyKey, partyKeyFromInput,
 * buildRefundScript, taptree2, scriptPathSigDigestEx, signForXOnly,
 * verifySchnorrSig, buildScriptPathSpend, spendVBytes, planSpend,
 * addressToProgram) come from the audited
 * files/pages/escrow/src/escrow-core.js; the multi-input BIP-341 sighash
 * (batchScriptPathSigDigest) comes from the audited
 * files/pages/stream/src/stream-core.js. The release leaf template, NUMS
 * derivation, descriptors, and the two-party release-bundle coordinator
 * are new composition on those primitives — no new cryptography, no new
 * signature schemes.
 */

import {
  taggedHash, tapLeafHash, encodeBech32m, decodeBech32m,
  schnorr, sha256, bytesToHex, hexToBytes, convertBits,
  varint, u32le, u64le, p2trScriptPubKey, txidLE, dblSha,
  DUST_GRAIN, GRAIN_PER_PRL, NETWORKS,
  walletFromMnemonic, newMnemonic, walletFromWIF, walletFromPriv,
  fetchUtxos, fetchFeeRateGrainsPerVByte, broadcastTx, fetchTxStatus,
} from "../../sign/src/crypto.js";
import {
  partyKeyFromInput, parseXOnlyKey, encodeScriptNum, buildRefundScript,
  taptree2, verifyControlBlock, scriptPathSigDigestEx,
  signForXOnly, verifySchnorrSig, buildScriptPathSpend,
  spendVBytes, planSpend, addressToProgram, scriptAsm,
} from "../../escrow/src/escrow-core.js";
import {
  batchScriptPathSigDigest,
} from "../../stream/src/stream-core.js";
import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesToNumberBE, numberToBytesBE } from "@noble/curves/abstract/utils";

export {
  DUST_GRAIN, GRAIN_PER_PRL, NETWORKS,
  walletFromMnemonic, newMnemonic, walletFromWIF, walletFromPriv,
  fetchUtxos, fetchFeeRateGrainsPerVByte, broadcastTx, fetchTxStatus,
  bytesToHex, hexToBytes, schnorr, sha256, dblSha, convertBits,
  encodeBech32m, decodeBech32m, p2trScriptPubKey, txidLE,
  partyKeyFromInput, parseXOnlyKey, addressToProgram, scriptAsm,
  verifySchnorrSig, signForXOnly, scriptPathSigDigestEx,
  buildScriptPathSpend, spendVBytes, planSpend, buildRefundScript, encodeScriptNum,
};

const OP = {
  FALSE: 0x00,
  DROP: 0x75,
  CHECKSIG: 0xac,
  CHECKSIGVERIFY: 0xad,
  CLTV: 0xb1,
};
const TAPLEAF_VERSION = 0xc0;
const EMPTY = new Uint8Array(0);
const MAX_SEQ = 0xffffffff;
const NONFINAL_SEQ = 0xfffffffe;
const NUMS_DOMAIN = "PearlFundNUMS/v1";
export const DESCRIPTOR_KIND = "pearlfund";
export const DESCRIPTOR_VERSION = "v1";
export const RELEASE_BUNDLE_KIND = "pearl-fund-release-bundle";
export const RELEASE_BUNDLE_VERSION = 1;
export const MAX_RELEASE_INPUTS = 256;

/** Kyle's donation address, shown in the page footer (copy character-for-character). */
export const DONATE_ADDRESS = "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d";

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

function utf8(s) { return new TextEncoder().encode(s); }

function u64leBig(v) {
  let x = BigInt(v);
  if (x < 0n || x > 0xffffffffffffffffn) throw new Error("u64 out of range");
  const b = new Uint8Array(8);
  for (let i = 0; i < 8; i++) { b[i] = Number(x & 0xffn); x >>= 8n; }
  return b;
}

function u32leNum(n) {
  if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff) throw new Error("u32 out of range");
  return Uint8Array.from(u32le(n));
}

/** Release leaf: <recipient_xonly> OP_CHECKSIGVERIFY <creator_xonly> OP_CHECKSIG.
 *  Spendable only with BOTH signatures (recipient AND creator).
 *  Witness: [sig_creator, sig_recipient] (script key order), then the leaf
 *  script, then the control block. 68 bytes exactly. */
export function buildReleaseScript(recipientXOnly, creatorXOnly) {
  const r = recipientXOnly instanceof Uint8Array ? recipientXOnly : parseXOnlyKey(recipientXOnly);
  const c = creatorXOnly instanceof Uint8Array ? creatorXOnly : parseXOnlyKey(creatorXOnly);
  if (r.length !== 32 || c.length !== 32) throw new Error("release keys must be 32 bytes");
  schnorr.utils.lift_x(bytesToNumberBE(r));
  schnorr.utils.lift_x(bytesToNumberBE(c));
  if (constEq(r, c)) throw new Error("recipient and creator keys must differ");
  return Uint8Array.from([
    0x20, ...r, OP.CHECKSIGVERIFY,
    0x20, ...c, OP.CHECKSIG,
  ]);
}

/** NUMS internal key: lift_x(SHA-256("PearlFundNUMS/v1" || recipient_xonly
 *  || creator_xonly || u64le(goal_grains) || u32le(deadline_height)
 *  || backer_xonly)). Nobody knows the discrete log, so keypath spending is
 *  impossible — coins move only through the release/refund leaves.
 *  Deterministic and recomputable from the pledge descriptor; the counter
 *  fallback exists only for the astronomically-unlikely x >= p case. */
export function numsInternalKey({ recipientXOnly, creatorXOnly, goalGrains, deadlineHeight, backerXOnly }) {
  const r = recipientXOnly instanceof Uint8Array ? recipientXOnly : parseXOnlyKey(recipientXOnly);
  const c = creatorXOnly instanceof Uint8Array ? creatorXOnly : parseXOnlyKey(creatorXOnly);
  const b = backerXOnly instanceof Uint8Array ? backerXOnly : parseXOnlyKey(backerXOnly);
  const g = BigInt(goalGrains);
  if (g <= 0n) throw new Error("goal must be positive");
  const preimage = Uint8Array.from([
    ...utf8(NUMS_DOMAIN), ...r, ...c, ...u64leBig(g), ...u32leNum(deadlineHeight), ...b,
  ]);
  for (let counter = 0; counter < 256; counter++) {
    const pre = counter === 0 ? preimage : Uint8Array.from([...preimage, counter]);
    const h = sha256(pre);
    try {
      schnorr.utils.lift_x(bytesToNumberBE(h));
      return h;
    } catch { /* try next counter */ }
  }
  throw new Error("NUMS lift failed (unreachable in practice)");
}

/** Two-leaf taptree (release leaf + refund leaf) under the NUMS internal
 *  key. Returns the pledge address, spk, 65-byte control blocks, and every
 *  piece needed to re-derive the address from the descriptor. */
export function fundTaptree(network, internalXOnly, releaseScript, refundScript) {
  const tree = taptree2(network, internalXOnly, releaseScript, refundScript);
  return {
    ...tree,
    internalXOnly,
    releaseControlBlock: tree.controlBlocks[0],
    refundControlBlock: tree.controlBlocks[1],
  };
}

/** Independently re-derive the tweaked key from a 65-byte control block and
 *  check it matches — the same verification a wallet does before funding. */
export function verifyFundControlBlock(internalXOnly, leafScript, controlBlock, tweakedX) {
  return verifyControlBlock(internalXOnly, leafScript, controlBlock, tweakedX);
}

/** Exact decimal PRL string -> grains (BigInt). Rejects > 8 decimals,
 *  negatives, and non-numeric input. */
export function prlToGrains(s) {
  const t = String(s || "").trim();
  const m = t.match(/^(\d+)(?:\.(\d{1,8}))?$/);
  if (!m) throw new Error(`bad PRL amount: ${JSON.stringify(t.slice(0, 40))}`);
  const whole = BigInt(m[1]);
  const frac = m[2] ? BigInt(m[2].padEnd(8, "0")) : 0n;
  const g = whole * 100_000_000n + frac;
  if (g <= 0n) throw new Error("amount must be positive");
  return g;
}

export function grainsToPRL(g) {
  const x = BigInt(g);
  const neg = x < 0n;
  const ax = neg ? -x : x;
  const whole = ax / 100_000_000n;
  const frac = (ax % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return (neg ? "-" : "") + whole.toString() + (frac ? "." + frac : "");
}

/** Validate a deadline block height. currentHeight may be null when no
 *  Blockbook is configured — then only structural checks apply and the
 *  future-check is the UI's job (stated honestly there). */
export function validateDeadline(deadlineHeight, currentHeight = null) {
  if (!Number.isSafeInteger(deadlineHeight) || deadlineHeight <= 0 || deadlineHeight >= 500000000) {
    throw new Error("deadline must be a positive block height (< 500000000)");
  }
  if (currentHeight !== null) {
    if (!Number.isSafeInteger(currentHeight) || currentHeight < 0) throw new Error("bad current height");
    if (deadlineHeight <= currentHeight) {
      throw new Error(`deadline height ${deadlineHeight} is not in the future (chain is at ${currentHeight})`);
    }
  }
  return deadlineHeight;
}

/** Validate a campaign goal in grains. */
export function validateGoal(goalGrains) {
  const g = BigInt(goalGrains);
  if (g <= 0n) throw new Error("goal must be positive");
  if (g < BigInt(DUST_GRAIN)) throw new Error(`goal below dust (${DUST_GRAIN} grains)`);
  return g;
}

/** Validate a recipient address: bech32m, this network's HRP, P2TR v1. */
export function parseRecipientAddress(addr, network) {
  const t = String(addr || "").trim();
  const { hrp, version, program } = decodeBech32m(t);
  if (hrp !== network.hrp) throw new Error(`recipient is a ${hrp} address, not ${network.hrp}`);
  if (version !== 1 || program.length !== 32) throw new Error("recipient must be a P2TR (v1, 32-byte) address");
  return { address: t, xonly: program };
}

/**
 * Creator key at launch: 64-hex x-only pubkey, WIF, or 12/24-word mnemonic
 * (BIP-86 m/86'/coin'/0'/0/0). Private material (when given) is returned
 * IN MEMORY ONLY and never enters a descriptor.
 */
export function creatorKeyFromInput(input, network) {
  const t = String(input || "").trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) {
    return { xonly: parseXOnlyKey(t), priv: null, source: "x-only pubkey" };
  }
  const words = t.split(/\s+/);
  if (words.length === 12 || words.length === 24) {
    const w = walletFromMnemonic(t, network);
    return { xonly: w.internalXOnly, priv: w.priv, source: "mnemonic (BIP-86 m/86'/coin'/0'/0/0)" };
  }
  try {
    const w = walletFromWIF(t, network);
    return { xonly: w.internalXOnly, priv: w.priv, source: "WIF" };
  } catch {
    throw new Error("creator key must be a 64-hex x-only pubkey, WIF, or 12/24-word mnemonic");
  }
}

/**
 * Secret key in a SIGNING context (pledge refund, release co-sign):
 * 12/24-word mnemonic, WIF, or 64-hex PRIVATE key. A 64-hex value is ALWAYS
 * interpreted as a private key here (unlike launch, where it is a pubkey).
 */
export function secretKeyFromInput(input, network) {
  const t = String(input || "").trim();
  const words = t.split(/\s+/);
  if (words.length === 12 || words.length === 24) {
    const w = walletFromMnemonic(t, network);
    return { xonly: w.internalXOnly, priv: w.priv, source: "mnemonic (BIP-86 m/86'/coin'/0'/0/0)" };
  }
  if (/^[0-9a-fA-F]{64}$/.test(t)) {
    const w = walletFromPriv(hexToBytes(t.toLowerCase()), network);
    return { xonly: w.internalXOnly, priv: w.priv, source: "64-hex private key" };
  }
  try {
    const w = walletFromWIF(t, network);
    return { xonly: w.internalXOnly, priv: w.priv, source: "WIF" };
  } catch {
    throw new Error("key must be a 64-hex private key, WIF, or 12/24-word mnemonic");
  }
}

/**
 * Forge a campaign. Returns { campaign, secrets } — campaign is fully
 * serializable (safe to share); secrets holds private keys IN MEMORY ONLY.
 */
export function createCampaign({ network, recipientAddr, creatorKeyInput, goalPRL, deadlineHeight, currentHeight = null }) {
  const rec = parseRecipientAddress(recipientAddr, network);
  const creator = creatorKeyFromInput(creatorKeyInput, network);
  const goalGrains = validateGoal(prlToGrains(goalPRL));
  validateDeadline(deadlineHeight, currentHeight);
  const campaign = {
    kind: "pearl-fund-campaign",
    version: 1,
    network: network.id,
    hrp: network.hrp,
    recipientAddr: rec.address,
    recipientXOnlyHex: bytesToHex(rec.xonly),
    creatorXOnlyHex: bytesToHex(creator.xonly),
    creatorSource: creator.source,
    goalGrains: goalGrains.toString(),
    deadlineHeight,
    descriptor: campaignDescriptor(network, rec.address, creator.xonly, goalGrains, deadlineHeight),
  };
  const secrets = creator.priv ? [{ xonly: bytesToHex(creator.xonly), priv: bytesToHex(creator.priv) }] : [];
  return { campaign, secrets };
}

/** Campaign descriptor: pearlfund:v1:<hrp>:<recipient_addr>:<creator_xonly_hex>:<goal_grains>:<deadline_height> */
export function campaignDescriptor(network, recipientAddr, creatorXOnly, goalGrains, deadlineHeight) {
  const c = creatorXOnly instanceof Uint8Array ? bytesToHex(creatorXOnly) : String(creatorXOnly).toLowerCase();
  return `${DESCRIPTOR_KIND}:${DESCRIPTOR_VERSION}:${network.hrp}:${String(recipientAddr).trim()}:${c}:${BigInt(goalGrains).toString()}:${deadlineHeight}`;
}

/** Rebuild + fully re-derive a campaign from its descriptor. Throws on any
 *  mismatch — a tampered descriptor can never pass. */
export function campaignFromDescriptor(descriptor, network) {
  const t = String(descriptor || "").trim();
  const parts = t.split(":");
  if (parts.length !== 7 || parts[0] !== DESCRIPTOR_KIND || parts[1] !== DESCRIPTOR_VERSION) {
    throw new Error("bad campaign descriptor (expected pearlfund:v1:<hrp>:<recipient_addr>:<creator_xonly>:<goal_grains>:<deadline>)");
  }
  const [, , hrp, recipientAddr, creatorXOnlyHex, goalStr, deadlineStr] = parts;
  if (hrp !== network.hrp) throw new Error(`descriptor is for ${hrp}, not ${network.hrp}`);
  const rec = parseRecipientAddress(recipientAddr, network);
  const creatorXOnly = parseXOnlyKey(creatorXOnlyHex);
  if (!/^\d+$/.test(goalStr)) throw new Error("descriptor: bad goal");
  if (!/^\d+$/.test(deadlineStr)) throw new Error("descriptor: bad deadline");
  const goalGrains = validateGoal(BigInt(goalStr));
  const deadlineHeight = validateDeadline(parseInt(deadlineStr, 10));
  if (constEq(rec.xonly, creatorXOnly)) throw new Error("descriptor: recipient and creator keys must differ");
  const rebuilt = campaignDescriptor(network, rec.address, creatorXOnly, goalGrains, deadlineHeight);
  if (rebuilt !== t) throw new Error("campaign descriptor failed round-trip check — it was tampered with");
  return {
    kind: "pearl-fund-campaign", version: 1,
    network: network.id, hrp: network.hrp,
    recipientAddr: rec.address, recipientXOnlyHex: bytesToHex(rec.xonly),
    creatorXOnlyHex: bytesToHex(creatorXOnly),
    goalGrains: goalGrains.toString(), deadlineHeight,
    descriptor: t,
  };
}

/** Pledge descriptor: <campaign descriptor>:<backer_xonly_hex> */
export function pledgeDescriptorFor(campaign, backerXOnly) {
  const b = backerXOnly instanceof Uint8Array ? bytesToHex(backerXOnly) : String(backerXOnly).toLowerCase();
  parseXOnlyKey(b);
  return `${campaign.descriptor}:${b}`;
}

/**
 * Derive a backer's full pledge contract from campaign params + backer key.
 * Returns the pledge Taproot address, both leaf scripts, the NUMS internal
 * key, and 65-byte control blocks — everything a wallet needs to fund and
 * everything the signing flows need to spend.
 */
export function createPledge({ network, recipientAddr, creatorXOnly, goalGrains, deadlineHeight, backerXOnly }) {
  const rec = parseRecipientAddress(recipientAddr, network);
  const creator = creatorXOnly instanceof Uint8Array ? creatorXOnly : parseXOnlyKey(creatorXOnly);
  const backer = backerXOnly instanceof Uint8Array ? backerXOnly : parseXOnlyKey(backerXOnly);
  const goal = validateGoal(goalGrains);
  validateDeadline(deadlineHeight);
  const releaseScript = buildReleaseScript(rec.xonly, creator);
  const refundScript = buildRefundScript(backer, deadlineHeight);
  const internalXOnly = numsInternalKey({
    recipientXOnly: rec.xonly, creatorXOnly: creator,
    goalGrains: goal, deadlineHeight, backerXOnly: backer,
  });
  const tree = fundTaptree(network, internalXOnly, releaseScript, refundScript);
  if (!verifyFundControlBlock(tree.internalXOnly, releaseScript, tree.releaseControlBlock, tree.tweakedX)) {
    throw new Error("internal release control-block self-check failed");
  }
  if (!verifyFundControlBlock(tree.internalXOnly, refundScript, tree.refundControlBlock, tree.tweakedX)) {
    throw new Error("internal refund control-block self-check failed");
  }
  return {
    kind: "pearl-fund-pledge", version: 1,
    network: network.id, hrp: network.hrp,
    recipientAddr: rec.address, recipientXOnlyHex: bytesToHex(rec.xonly),
    creatorXOnlyHex: bytesToHex(creator),
    backerXOnlyHex: bytesToHex(backer),
    goalGrains: goal.toString(), deadlineHeight,
    releaseScriptHex: bytesToHex(releaseScript),
    releaseScriptAsm: scriptAsm(releaseScript),
    refundScriptHex: bytesToHex(refundScript),
    refundScriptAsm: scriptAsm(refundScript),
    internalKeyHex: bytesToHex(internalXOnly),
    tweakedHex: bytesToHex(tree.tweakedX),
    releaseControlBlockHex: bytesToHex(tree.releaseControlBlock),
    refundControlBlockHex: bytesToHex(tree.refundControlBlock),
    address: tree.address,
    spkHex: bytesToHex(tree.spk),
    descriptor: pledgeDescriptorFor(
      { descriptor: campaignDescriptor(network, rec.address, creator, goal, deadlineHeight) }, backer),
  };
}

/** Rebuild + fully re-derive a pledge from its pledge descriptor. Throws on
 *  any mismatch. */
export function pledgeFromDescriptor(descriptor, network) {
  const t = String(descriptor || "").trim();
  const parts = t.split(":");
  if (parts.length !== 8 || parts[0] !== DESCRIPTOR_KIND || parts[1] !== DESCRIPTOR_VERSION) {
    throw new Error("bad pledge descriptor (expected <campaign descriptor>:<backer_xonly>)");
  }
  const campaign = campaignFromDescriptor(parts.slice(0, 7).join(":"), network);
  const backer = parseXOnlyKey(parts[7]);
  const pledge = createPledge({
    network,
    recipientAddr: campaign.recipientAddr,
    creatorXOnly: campaign.creatorXOnlyHex,
    goalGrains: campaign.goalGrains,
    deadlineHeight: campaign.deadlineHeight,
    backerXOnly: backer,
  });
  if (pledge.descriptor !== t) throw new Error("pledge descriptor failed round-trip check — it was tampered with");
  return { campaign, pledge };
}

/** Verify a pledge descriptor against a claimed pledge address. Throws
 *  unless the re-derived address matches byte-for-byte — this is what makes
 *  value-tampering (e.g. a silently edited goal) LOUD: the address moves. */
export function verifyPledgeAddress(descriptor, expectedAddress, network) {
  const { pledge } = pledgeFromDescriptor(descriptor, network);
  if (pledge.address !== String(expectedAddress).trim()) {
    throw new Error(
      "pledge address mismatch: the descriptor does NOT re-derive to " +
      `${expectedAddress} (re-derived ${pledge.address}) — it was tampered with or belongs to a different campaign`);
  }
  return pledge;
}

/* ---------------- fee math ---------------- */

/** Exact vBytes for an n-input release spend: each input's witness is
 *  [sig, sig, 68-byte release script, 65-byte control block], one P2TR out. */
export function releaseSpendVBytes(nIn) {
  if (!Number.isSafeInteger(nIn) || nIn < 1 || nIn > MAX_RELEASE_INPUTS) {
    throw new Error(`release needs 1..${MAX_RELEASE_INPUTS} inputs`);
  }
  const varintLen = (n) => (n < 0xfd ? 1 : n <= 0xffff ? 3 : n <= 0xffffffff ? 5 : 9);
  // per input: item-count(4) + (1+64) + (1+64) + (1+68) + (1+65)
  const perIn = varintLen(4) + varintLen(64) + 64 + varintLen(64) + 64 + varintLen(68) + 68 + varintLen(65) + 65;
  const wit = nIn * perIn;
  const base = 4 + varintLen(nIn) + nIn * 41 + varintLen(1) + 43 + 4;
  return Math.ceil((base * 3 + (base + 2 + wit)) / 4);
}

/** Exact vBytes for a single-input refund spend via the refund leaf. */
export function refundSpendVBytes(refundScriptLen) {
  return spendVBytes({
    nOut: 1, scriptLen: refundScriptLen, controlLen: 65, stackLens: [64],
  });
}

/** Plan the release sweep: everything in, ONE output to the recipient.
 *  Throws when the payment would be dust (the pledge is uneconomic). */
export function planRelease({ inputValues, feeRateGrainsPerVByte }) {
  if (!Array.isArray(inputValues) || inputValues.length === 0) throw new Error("release needs at least one input");
  if (!Number.isFinite(feeRateGrainsPerVByte) || feeRateGrainsPerVByte <= 0) throw new Error("bad fee rate");
  let sum = 0;
  inputValues.forEach((v, i) => {
    if (!Number.isSafeInteger(v) || v <= 0) throw new Error(`input ${i}: bad value`);
    sum += v;
  });
  const vBytes = releaseSpendVBytes(inputValues.length);
  const fee = Math.ceil(vBytes * feeRateGrainsPerVByte);
  const payment = sum - fee;
  if (payment < DUST_GRAIN) {
    throw new Error(`release uneconomic: ${sum} grains in, ${fee}-grain fee leaves < dust (${DUST_GRAIN}) for the recipient`);
  }
  return { payment, fee, vBytes, inputSum: sum };
}

/** Plan a single-UTXO refund: input value minus fee, dust-refused. */
export function planRefund({ inputValue, feeRateGrainsPerVByte, refundScriptLen }) {
  if (!Number.isSafeInteger(inputValue) || inputValue <= 0) throw new Error("bad input value");
  if (!Number.isFinite(feeRateGrainsPerVByte) || feeRateGrainsPerVByte <= 0) throw new Error("bad fee rate");
  const vBytes = refundSpendVBytes(refundScriptLen);
  const fee = Math.ceil(vBytes * feeRateGrainsPerVByte);
  const payment = inputValue - fee;
  if (payment < DUST_GRAIN) {
    throw new Error(`refund uneconomic: ${inputValue} grains in, ${fee}-grain fee leaves < dust (${DUST_GRAIN})`);
  }
  return { payment, fee, vBytes };
}

/* ---------------- release bundle (two-party signing round) ---------------- */

/**
 * Build the UNSIGNED release bundle spending pledge UTXOs to the recipient.
 * pledges: [{ pledge (from createPledge/pledgeFromDescriptor), utxo: {txid,vout,value} }]
 * Anyone holding this JSON can re-derive everything and check it — nothing
 * secret is inside.
 */
export function buildReleaseBundle({ network, campaign, pledges, recipientAddr, feeRateGrainsPerVByte }) {
  if (!Array.isArray(pledges) || pledges.length === 0) throw new Error("release needs at least one funded pledge");
  if (pledges.length > MAX_RELEASE_INPUTS) throw new Error(`at most ${MAX_RELEASE_INPUTS} pledge inputs per release`);
  const rec = parseRecipientAddress(recipientAddr, network);
  if (bytesToHex(rec.xonly) !== campaign.recipientXOnlyHex) {
    throw new Error("recipient address does not match the campaign's recipient");
  }
  const plan = planRelease({
    inputValues: pledges.map((p) => p.utxo.value),
    feeRateGrainsPerVByte,
  });
  const outputs = [{ program: rec.xonly, value: plan.payment }];
  const releaseScript = buildReleaseScript(hexToBytes(campaign.recipientXOnlyHex), hexToBytes(campaign.creatorXOnlyHex));
  const inputs = pledges.map((p, i) => {
    const u = p.utxo || {};
    if (!/^[0-9a-f]{64}$/i.test(u.txid || "")) throw new Error(`pledge ${i}: bad utxo txid`);
    if (!Number.isInteger(u.vout) || u.vout < 0) throw new Error(`pledge ${i}: bad utxo vout`);
    if (!Number.isSafeInteger(u.value) || u.value <= 0) throw new Error(`pledge ${i}: bad utxo value`);
    // The pledge's own scripts must match the campaign — a pledge from a
    // different campaign can never enter this bundle.
    if (p.pledge.releaseScriptHex !== bytesToHex(releaseScript)) {
      throw new Error(`pledge ${i}: release leaf does not match this campaign`);
    }
    return {
      txid: u.txid.toLowerCase(), vout: u.vout, value: u.value,
      spk: hexToBytes(p.pledge.spkHex),
      pledgeDescriptor: p.pledge.descriptor,
      controlBlock: hexToBytes(p.pledge.releaseControlBlockHex),
    };
  });
  const digests = inputs.map((_, i) =>
    bytesToHex(batchScriptPathSigDigest(network, inputs, outputs, releaseScript, {
      sequence: MAX_SEQ, locktime: 0, inputIdx: i,
    })));
  return {
    kind: RELEASE_BUNDLE_KIND,
    version: RELEASE_BUNDLE_VERSION,
    campaign: campaign.descriptor,
    inputs: inputs.map((x) => ({
      pledge: x.pledgeDescriptor,
      txid: x.txid, vout: x.vout, value: x.value,
      controlBlock: bytesToHex(x.controlBlock),
    })),
    outputs: [{ address: rec.address, value: plan.payment }],
    feeGrains: plan.fee,
    vBytes: plan.vBytes,
    feeRateGrainsPerVByte,
    digests,
    // partialSigs: [{ key: xonlyHex, sigs: [sigHex per input] }]
    partialSigs: [],
  };
}

/** Canonical JSON for a bundle (what gets copied / QR-encoded / saved). */
export function serializeBundle(bundle) { return JSON.stringify(bundle); }

/**
 * Parse + fully verify a bundle: JSON shape, campaign descriptor
 * re-derivation, every pledge re-derivation (address + scripts), output
 * programs, independently recomputed per-input sighash digests, and every
 * collected partial signature. Throws on anything unexpected.
 */
export function parseReleaseBundle(json, network) {
  let b;
  try { b = typeof json === "string" ? JSON.parse(json) : json; }
  catch { throw new Error("bundle is not valid JSON"); }
  if (!b || b.kind !== RELEASE_BUNDLE_KIND || b.version !== RELEASE_BUNDLE_VERSION) {
    throw new Error("not a Pearl Fund release bundle");
  }
  const campaign = campaignFromDescriptor(b.campaign, network);
  if (!Array.isArray(b.inputs) || b.inputs.length === 0 || b.inputs.length > MAX_RELEASE_INPUTS) {
    throw new Error("bundle: bad inputs");
  }
  if (!Array.isArray(b.outputs) || b.outputs.length !== 1) throw new Error("bundle: release pays exactly one output");
  const out = b.outputs[0];
  const outProgram = parseRecipientAddress(out.address, network).xonly;
  if (bytesToHex(outProgram) !== campaign.recipientXOnlyHex) throw new Error("bundle: output is not the campaign recipient");
  if (!Number.isSafeInteger(out.value) || out.value < DUST_GRAIN) throw new Error("bundle: bad output value");
  const releaseScript = buildReleaseScript(hexToBytes(campaign.recipientXOnlyHex), hexToBytes(campaign.creatorXOnlyHex));
  const inputs = b.inputs.map((x, i) => {
    const { pledge } = pledgeFromDescriptor(x.pledge, network);
    if (pledge.releaseScriptHex !== bytesToHex(releaseScript)) throw new Error(`bundle: input ${i} pledge is not from this campaign`);
    if (!/^[0-9a-f]{64}$/.test(x.txid || "")) throw new Error(`bundle: input ${i} bad txid`);
    if (!Number.isInteger(x.vout) || x.vout < 0) throw new Error(`bundle: input ${i} bad vout`);
    if (!Number.isSafeInteger(x.value) || x.value <= 0) throw new Error(`bundle: input ${i} bad value`);
    const cb = hexToBytes(String(x.controlBlock || ""));
    if (cb.length !== 65 || (cb[0] & 0xfe) !== TAPLEAF_VERSION) throw new Error(`bundle: input ${i} bad control block`);
    if (!verifyFundControlBlock(hexToBytes(pledge.internalKeyHex), releaseScript, cb, hexToBytes(pledge.tweakedHex))) {
      throw new Error(`bundle: input ${i} control block does not match its pledge`);
    }
    return {
      txid: x.txid.toLowerCase(), vout: x.vout, value: x.value,
      spk: hexToBytes(pledge.spkHex), controlBlock: cb,
    };
  });
  const outputs = [{ program: outProgram, value: out.value }];
  const expected = inputs.map((_, i) =>
    bytesToHex(batchScriptPathSigDigest(network, inputs, outputs, releaseScript, {
      sequence: MAX_SEQ, locktime: 0, inputIdx: i,
    })));
  if (!Array.isArray(b.digests) || b.digests.length !== inputs.length) throw new Error("bundle: bad digests");
  for (let i = 0; i < inputs.length; i++) {
    if (String(b.digests[i]).toLowerCase() !== expected[i]) {
      throw new Error(`bundle: digest ${i} mismatch — the release was tampered with`);
    }
  }
  // Fee cross-check: the bundle's fee must equal the exact vBytes math.
  const plan = planRelease({ inputValues: inputs.map((x) => x.value), feeRateGrainsPerVByte: b.feeRateGrainsPerVByte });
  if (plan.fee !== b.feeGrains || plan.vBytes !== b.vBytes || plan.payment !== out.value) {
    throw new Error("bundle: fee math mismatch — the release was tampered with");
  }
  // Verify every collected partial signature against its input digests.
  if (!Array.isArray(b.partialSigs)) throw new Error("bundle: bad partialSigs");
  const seen = new Set();
  const allowed = new Set([campaign.recipientXOnlyHex, campaign.creatorXOnlyHex]);
  for (const ps of b.partialSigs) {
    const key = String(ps?.key || "").toLowerCase();
    if (!allowed.has(key)) throw new Error("bundle: signature from a key that is neither recipient nor creator");
    if (seen.has(key)) throw new Error("bundle: duplicate signer");
    seen.add(key);
    if (!Array.isArray(ps?.sigs) || ps.sigs.length !== inputs.length) throw new Error("bundle: bad sig list");
    ps.sigs.forEach((sig, i) => {
      const s = String(sig || "").toLowerCase();
      if (!/^[0-9a-f]{128}$/.test(s)) throw new Error(`bundle: input ${i} bad signature encoding`);
      if (!verifySchnorrSig(s, expected[i], key)) {
        throw new Error(`bundle: input ${i} signature from ${key.slice(0, 12)}… does not verify`);
      }
    });
  }
  return {
    kind: RELEASE_BUNDLE_KIND, version: RELEASE_BUNDLE_VERSION,
    campaign: campaign.descriptor,
    inputs: b.inputs.map((x) => ({
      pledge: String(x.pledge), txid: x.txid.toLowerCase(), vout: x.vout, value: x.value,
      controlBlock: String(x.controlBlock).toLowerCase(),
    })),
    outputs: [{ address: String(out.address), value: out.value }],
    feeGrains: b.feeGrains, vBytes: b.vBytes,
    feeRateGrainsPerVByte: b.feeRateGrainsPerVByte,
    digests: expected,
    partialSigs: b.partialSigs.map((ps) => ({
      key: String(ps.key).toLowerCase(),
      sigs: ps.sigs.map((s) => String(s).toLowerCase()),
    })),
  };
}

/** x-only pubkey for a 32-byte private key. */
export function pubkeyFromPriv(priv) {
  const p = priv instanceof Uint8Array ? priv : hexToBytes(String(priv).trim());
  if (p.length !== 32) throw new Error("private key must be 32 bytes");
  return bytesToHex(schnorr.getPublicKey(p));
}

/**
 * Sign every digest in the bundle with a private key. The key must be the
 * recipient's or the creator's. Each signature is re-verified against its
 * digest before it enters the bundle — a bad signature never does.
 */
export function signReleaseBundle(bundle, campaign, privHex) {
  const priv = hexToBytes(String(privHex).trim());
  if (priv.length !== 32) throw new Error("private key must be 32 bytes");
  const key = pubkeyFromPriv(priv);
  if (key !== campaign.recipientXOnlyHex && key !== campaign.creatorXOnlyHex) {
    throw new Error("this key is neither the campaign recipient nor the creator");
  }
  const existing = bundle.partialSigs.find((ps) => ps.key === key);
  if (existing) throw new Error("this key already signed the bundle");
  const sigs = bundle.digests.map((dg, i) => {
    const sig = bytesToHex(signForXOnly(priv, dg));
    if (!verifySchnorrSig(sig, dg, key)) {
      throw new Error(`input ${i}: local signature self-check failed — refusing to sign`);
    }
    return sig;
  });
  bundle.partialSigs.push({ key, sigs });
  return bundle;
}

/** Bundle signing status: which of the two required keys has signed. */
export function bundleStatus(bundle, campaign) {
  const signers = bundle.partialSigs.map((ps) => ps.key);
  return {
    signers,
    recipientSigned: signers.includes(campaign.recipientXOnlyHex),
    creatorSigned: signers.includes(campaign.creatorXOnlyHex),
    ready: signers.includes(campaign.recipientXOnlyHex) && signers.includes(campaign.creatorXOnlyHex),
  };
}

/**
 * Finalize: require both signatures per input, assemble each input's
 * witness ([sig_creator, sig_recipient], release leaf, control block), and
 * serialize the multi-input release transaction. Throws unless complete.
 */
export function finalizeReleaseBundle(bundle, campaign, network) {
  const st = bundleStatus(bundle, campaign);
  if (!st.ready) {
    const missing = [
      !st.recipientSigned && "recipient",
      !st.creatorSigned && "creator",
    ].filter(Boolean).join(" and ");
    throw new Error(`release not fully signed — still missing: ${missing}`);
  }
  const releaseScript = buildReleaseScript(hexToBytes(campaign.recipientXOnlyHex), hexToBytes(campaign.creatorXOnlyHex));
  const sigFor = (key, i) => {
    const ps = bundle.partialSigs.find((p) => p.key === key);
    const sig = ps && ps.sigs[i];
    if (!sig || !verifySchnorrSig(sig, bundle.digests[i], key)) {
      throw new Error(`input ${i}: ${key === campaign.recipientXOnlyHex ? "recipient" : "creator"} signature missing or invalid`);
    }
    return hexToBytes(sig);
  };
  const inputs = bundle.inputs.map((x) => ({
    txid: x.txid, vout: x.vout, value: x.value,
    spk: hexToBytes(pledgeSpkOf(x.pledge, network)),
  }));
  const outputs = bundle.outputs.map((o) => ({
    program: parseRecipientAddress(o.address, network).xonly, value: o.value,
  }));
  const stacks = inputs.map((_, i) => [
    sigFor(campaign.creatorXOnlyHex, i),
    sigFor(campaign.recipientXOnlyHex, i),
    releaseScript,
    hexToBytes(bundle.inputs[i].controlBlock),
  ]);
  const spend = buildReleaseSpend(network, inputs, outputs, stacks, { sequence: MAX_SEQ, locktime: 0 });
  // Cross-check: serializer digests must equal the bundle's signed digests.
  for (let i = 0; i < inputs.length; i++) {
    if (spend.digests[i] !== bundle.digests[i]) throw new Error(`input ${i}: sighash mismatch at finalize`);
  }
  if (spend.vBytes !== bundle.vBytes) {
    throw new Error(`vBytes mismatch: bundle ${bundle.vBytes} vs serializer ${spend.vBytes}`);
  }
  return spend; // { txid, hex, vBytes, baseBytes, totalBytes, digests }
}

/** Serialize a multi-input release spend. Each input's witness stack is
 *  supplied explicitly ([sig_creator, sig_recipient, releaseScript,
 *  controlBlock]); every input's sighash is recomputed and returned for the
 *  finalize cross-check. The sighash construction is byte-for-byte the
 *  audited stream-core batchScriptPathSigDigest. */
export function buildReleaseSpend(network, inputs, outputs, stacks, { sequence = MAX_SEQ, locktime = 0 } = {}) {
  const n = inputs.length;
  if (n === 0 || n > MAX_RELEASE_INPUTS) throw new Error("bad input count");
  if (stacks.length !== n) throw new Error("stacks must align with inputs");
  for (const x of inputs) {
    if (!/^[0-9a-f]{64}$/i.test(x.txid || "")) throw new Error("bad input txid");
    if (!Number.isInteger(x.vout) || x.vout < 0) throw new Error("bad input vout");
    if (!Number.isSafeInteger(x.value) || x.value <= 0) throw new Error("bad input value");
    if (!(x.spk instanceof Uint8Array) || x.spk.length === 0) throw new Error("bad input spk");
  }
  for (const o of outputs) {
    if (!(o.program instanceof Uint8Array) || o.program.length !== 32) throw new Error("output program must be 32 bytes");
    if (!Number.isSafeInteger(o.value) || o.value < DUST_GRAIN) throw new Error(`output below dust (${DUST_GRAIN} grains)`);
  }
  const releaseScriptCheck = stacks[0][2];
  if (!(releaseScriptCheck instanceof Uint8Array) || releaseScriptCheck.length === 0) throw new Error("bad release script");
  const digests = inputs.map((_, i) =>
    batchScriptPathSigDigest(network, inputs, outputs, stacks[i][2], { sequence, locktime, inputIdx: i }));
  const varintLen = (x) => (x < 0xfd ? 1 : x <= 0xffff ? 3 : x <= 0xffffffff ? 5 : 9);
  const outs = [];
  for (const o of outputs) {
    const s = p2trScriptPubKey(o.program);
    outs.push(...u64le(o.value), ...varint(s.length), ...s);
  }
  const inBytes = [];
  for (const x of inputs) {
    inBytes.push(...txidLE(x.txid), ...u32le(x.vout), ...varint(0), ...u32le(sequence));
  }
  const witBytes = [];
  for (let i = 0; i < n; i++) {
    const items = stacks[i];
    if (!Array.isArray(items) || items.length === 0) throw new Error(`input ${i}: empty witness stack`);
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
  return {
    txid, hex: bytesToHex(Uint8Array.from(full)),
    vBytes, baseBytes, totalBytes,
    digests: digests.map(bytesToHex),
  };
}

/** Helper: spk hex for a pledge descriptor (re-derives the pledge). */
function pledgeSpkOf(pledgeDescriptor, network) {
  return pledgeFromDescriptor(pledgeDescriptor, network).pledge.spkHex;
}

/* ---------------- refund ---------------- */

/**
 * Build + locally sign a backer's refund spend (single UTXO, refund leaf).
 * LOUDLY refuses when the chain has not reached the deadline: refunding
 * early is impossible by consensus (CLTV), so the page refuses to even
 * build the transaction. currentHeight must come from Blockbook — passing
 * null refuses with an honest "chain height unknown" error.
 */
export function buildRefundTx({ network, pledge, utxo, backerPriv, feeRateGrainsPerVByte, currentHeight }) {
  if (currentHeight === null || currentHeight === undefined) {
    throw new Error("chain height unknown — configure a Blockbook endpoint before building a refund");
  }
  if (!Number.isSafeInteger(currentHeight) || currentHeight < 0) throw new Error("bad current height");
  const deadline = pledge.deadlineHeight;
  if (currentHeight < deadline) {
    throw new Error(
      `REFUND NOT YET MATURE: deadline height ${deadline}, chain is at ${currentHeight} ` +
      `(${deadline - currentHeight} blocks to go). The refund leaf is unspendable until the deadline — ` +
      `consensus would reject this transaction. Wait for the tide to turn.`);
  }
  const priv = backerPriv instanceof Uint8Array ? backerPriv : hexToBytes(String(backerPriv).trim());
  if (priv.length !== 32) throw new Error("private key must be 32 bytes");
  const backerXOnly = pubkeyFromPriv(priv);
  if (backerXOnly !== pledge.backerXOnlyHex) {
    throw new Error("this key is not the backer of this pledge — refund refused");
  }
  if (!/^[0-9a-f]{64}$/i.test(utxo?.txid || "")) throw new Error("bad utxo txid");
  if (!Number.isInteger(utxo?.vout) || utxo.vout < 0) throw new Error("bad utxo vout");
  if (!Number.isSafeInteger(utxo?.value) || utxo.value <= 0) throw new Error("bad utxo value");
  const refundScript = hexToBytes(pledge.refundScriptHex);
  const plan = planRefund({
    inputValue: utxo.value,
    feeRateGrainsPerVByte,
    refundScriptLen: refundScript.length,
  });
  const outputs = [{ program: hexToBytes(pledge.backerXOnlyHex), value: plan.payment }];
  const input = { txid: utxo.txid.toLowerCase(), vout: utxo.vout, value: utxo.value, spk: hexToBytes(pledge.spkHex) };
  const digest = scriptPathSigDigestEx(network, input, outputs, refundScript, {
    sequence: NONFINAL_SEQ, locktime: deadline,
  });
  const sig = signForXOnly(priv, digest);
  if (!verifySchnorrSig(sig, digest, backerXOnly)) {
    throw new Error("local refund signature self-check failed — refusing to emit transaction hex");
  }
  const spend = buildScriptPathSpend(
    network, input, outputs, refundScript,
    hexToBytes(pledge.refundControlBlockHex),
    [sig],
    { sequence: NONFINAL_SEQ, locktime: deadline },
  );
  if (spend.digest !== bytesToHex(digest)) throw new Error("internal: refund digest mismatch");
  if (spend.vBytes !== plan.vBytes) {
    throw new Error(`refund vBytes mismatch: planner ${plan.vBytes} vs serializer ${spend.vBytes}`);
  }
  // The backer's refund pays to their raw x-only key (no tweak) — encode it.
  const refundAddr = encodeBech32m(network.hrp, 1, hexToBytes(pledge.backerXOnlyHex));
  return {
    txid: spend.txid, hex: spend.hex,
    digest: bytesToHex(digest),
    fee: plan.fee, vBytes: spend.vBytes, payment: plan.payment,
    locktime: deadline, sequence: NONFINAL_SEQ,
    refundAddress: refundAddr,
  };
}

/** Human summary of a release bundle for the coordinator UI. */
export function describeBundle(bundle, campaign) {
  const st = bundleStatus(bundle, campaign);
  return {
    inputs: bundle.inputs.length,
    totalIn: grainsToPRL(bundle.inputs.reduce((a, x) => a + x.value, 0)) + " PRL",
    recipient: bundle.outputs[0].address,
    payment: grainsToPRL(bundle.outputs[0].value) + " PRL",
    fee: grainsToPRL(bundle.feeGrains) + " PRL",
    vBytes: bundle.vBytes,
    feeRate: bundle.feeRateGrainsPerVByte,
    recipientSigned: st.recipientSigned,
    creatorSigned: st.creatorSigned,
    ready: st.ready,
  };
}

/* ---------------- track helpers ---------------- */

/** Fetch the chain tip height from Blockbook (honest error when unreachable). */
export async function fetchChainHeight(blockbookBase) {
  const base = String(blockbookBase || "").trim().replace(/\/+$/, "");
  if (!base) throw new Error("Blockbook endpoint is not configured");
  let r;
  try {
    r = await fetch(base + "/api/v2");
  } catch (e) {
    throw new Error(`Blockbook unreachable at ${base} (${e.message || e})`);
  }
  if (!r.ok) throw new Error(`Blockbook returned HTTP ${r.status}`);
  const j = await r.json();
  const h = j && j.blockbook && j.blockbook.bestHeight;
  if (!Number.isSafeInteger(h)) throw new Error("Blockbook did not report a chain height");
  return h;
}

/** Aggregate a track scan: per-pledge funding totals. */
export function summarizePledges(pledgeRows, goalGrains, deadlineHeight, chainHeight) {
  const goal = BigInt(goalGrains);
  let total = 0n;
  let funded = 0;
  const rows = pledgeRows.map((r) => {
    const sub = BigInt(r.totalValue);
    total += sub;
    if (sub > 0n) funded++;
    return { ...r, totalValue: sub.toString() };
  });
  const blocksLeft = deadlineHeight - chainHeight;
  return {
    rows,
    backerCount: rows.length,
    fundedCount: funded,
    totalGrains: total.toString(),
    totalPRL: grainsToPRL(total),
    goalGrains: goal.toString(),
    goalPRL: grainsToPRL(goal),
    goalMet: total >= goal,
    progressPct: goal > 0n ? Number((total * 10000n) / goal) / 100 : 0,
    chainHeight,
    deadlineHeight,
    blocksLeft,
    matured: blocksLeft <= 0,
  };
}
