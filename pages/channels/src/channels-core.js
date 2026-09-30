/* Pearl Channels core — off-chain PRL payment channels on Taproot script.
 *
 * Pearl has no smart contracts, so a payment channel is enforced with pure
 * Bitcoin-style Taproot script, exactly the way Lightning does it on Bitcoin:
 *
 *   FUNDING OUTPUT (the channel): a single-leaf P2TR output under a NUMS
 *   (nothing-up-my-sleeve) internal key. The leaf is a 2-of-2 CHECKSIGADD
 *   over the two parties' x-only keys. Keypath spending is impossible —
 *   coins move only through the funding script.
 *
 *   COMMITMENT TRANSACTION (one per channel state, two mirror copies): spends
 *   the funding output via the 2-of-2 leaf and splits the capacity into
 *     to_local  — the broadcaster's balance, P2TR under a NUMS key with two
 *                  leaves: a CSV-delayed self-claim leaf
 *                    <csv> OP_CHECKSEQUENCEVERIFY OP_DROP <owner> OP_CHECKSIG
 *                  and a penalty leaf anyone holding the revocation secret
 *                  can use:
 *                    OP_HASH160 <revoke_hash160> OP_EQUALVERIFY <peer> OP_CHECKSIG
 *     to_remote — the counterparty's balance, paid straight to their prl1
 *                  payout address (immediate, no delay).
 *   Each state update builds a fresh pair; both parties sign both; the old
 *   state's revocation secrets are revealed so a revoked broadcast can be
 *   penalized. State exchange between parties is manual (export/import JSON)
 *   — there is no gossip network here.
 *
 *   COOPERATIVE CLOSE: spends the funding output via the 2-of-2 leaf with
 *   immediate outputs to both payout addresses. No CSV delay.
 *
 *   UNILATERAL CLOSE: broadcast your latest fully-signed commitment tx, wait
 *   out the CSV delay, then claim to_local via the delay leaf.
 *
 * Crypto lineage: key handling, TapTweak, bech32m, BIP-341 sighash and wire
 * serialization come from the audited files/pages/sign/src/crypto.js and the
 * script-path helpers from files/pages/escrow/src/escrow-core.js (2-leaf
 * taptrees, BIP-341 digests, Schnorr sign/verify, vByte math). The script
 * templates below are new composition only — opcode semantics verified
 * against node/txscript/opcode.go (CHECKSIGADD stack order, CSV, CLTV
 * disabled here by design) and BIP-341/BIP-68 for sequence/locktime rules.
 *
 * Protocol facts (verified, not from memory):
 *  - P2TR dust 546 grains; tx version from network.txVersion (pearld = 1);
 *    bech32m HRPs prl/tprl/rprl; BIP-68 CSV block delays use sequences
 *    1..65535 with the type flag clear.
 */

import {
  taggedHash, tapLeafHash, encodeBech32m, decodeBech32m, commitKeyInfo,
  schnorr, sha256, bytesToHex, hexToBytes,
  varint, u32le, u64le, p2trScriptPubKey, txidLE, dblSha, tweakKeypath,
  DUST_GRAIN, GRAIN_PER_PRL, NETWORKS,
  walletFromMnemonic, newMnemonic, walletFromPriv,
  fetchUtxos, fetchFeeRateGrainsPerVByte, broadcastTx, fetchTxStatus,
} from "../../sign/src/crypto.js";
import { ripemd160 } from "@noble/hashes/ripemd160.js";
import {
  pushData, parseXOnlyKey, partyKeyFromInput, encodeScriptNum,
  taptree2, verifyControlBlock,
  scriptPathSigDigestEx, signForXOnly, verifySchnorrSig,
  buildScriptPathSpend, spendVBytes, scriptAsm, addressToProgram,
} from "../../escrow/src/escrow-core.js";
import {
  selectCoins, buildKeypathTxEx, verifySignedTx, decodeRawTx,
  fmtPRL, parsePRL, SIGHASH_DEFAULT,
} from "../../sign/src/sign-core.js";

export {
  DUST_GRAIN, GRAIN_PER_PRL, NETWORKS, fmtPRL, parsePRL,
  walletFromMnemonic, newMnemonic, walletFromPriv, fetchUtxos, fetchFeeRateGrainsPerVByte,
  broadcastTx, fetchTxStatus, bytesToHex, hexToBytes, schnorr, sha256,
  encodeBech32m, decodeBech32m, p2trScriptPubKey, selectCoins,
  buildKeypathTxEx, verifySignedTx, decodeRawTx, tweakKeypath,
  verifyControlBlock, scriptAsm, addressToProgram, partyKeyFromInput,
};

const OP = {
  FALSE: 0x00,
  TWO: 0x52,
  DROP: 0x75,
  EQUAL: 0x87,
  EQUALVERIFY: 0x88,
  CHECKSIG: 0xac,
  CHECKSIGADD: 0xba,
  CSV: 0xb2,
  HASH160: 0xa9,
};
const TAPLEAF_VERSION = 0xc0;
const EMPTY = new Uint8Array(0);
const FINAL_SEQ = 0xffffffff;
const BIP68_SEQ = 0xfffffffd;
const MAX_CSV_BLOCKS = 65535;
const NUMS_DOMAIN = "pearl-channels/nums/v1";
const DESCRIPTOR_KIND = "pearl-channel-descriptor:v1";
const FP_DOMAIN = "pearl-channels/fingerprint/v1";

const utf8 = (s) => new TextEncoder().encode(s);
function constEq(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
function assertHex64(s, what) {
  if (typeof s !== "string" || !/^[0-9a-fA-F]{64}$/.test(s.trim())) throw new Error(`${what} must be 64 hex characters`);
  return s.trim().toLowerCase();
}
function assertSigHex(s, what) {
  if (typeof s !== "string" || !/^[0-9a-fA-F]{128}$/.test(s.trim())) throw new Error(`${what} must be 128 hex characters (64-byte Schnorr signature)`);
  return s.trim().toLowerCase();
}
export function newRevocationSecret() {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return b;
}
export function revocationHash160(secret) {
  if (!(secret instanceof Uint8Array) || secret.length !== 32) throw new Error("revocation secret must be 32 bytes");
  return ripemd160(sha256(secret));
}

/* ---------------- script templates ---------------- */

/** Funding leaf: 2-of-2 CHECKSIGADD over [A, B] (script order = role order).
 *  <0> <A> CHECKSIGADD <B> CHECKSIGADD <2> EQUAL
 *  Witness: [sigB, sigA, script, controlBlock] (reverse script-key order). */
export function buildFundingScript(aXOnly, bXOnly) {
  const keys = [aXOnly, bXOnly].map((k) => (k instanceof Uint8Array ? k : parseXOnlyKey(k)));
  for (const k of keys) if (k.length !== 32) throw new Error("party key must be 32 bytes");
  const s = [OP.FALSE];
  for (const k of keys) s.push(...pushData(k), OP.CHECKSIGADD);
  s.push(OP.TWO, OP.EQUAL);
  return Uint8Array.from(s);
}
export const FUNDING_SCRIPT_LEN = 71; // 1 + 33 + 1 + 33 + 1 + 1 + 1

/** Delay leaf for a to_local output: <csv> CSV DROP <owner> CHECKSIG. */
export function buildDelayLeaf(csvBlocks, ownerXOnly) {
  if (!Number.isInteger(csvBlocks) || csvBlocks < 1 || csvBlocks > MAX_CSV_BLOCKS) {
    throw new Error(`CSV delay must be 1..${MAX_CSV_BLOCKS} blocks`);
  }
  const owner = ownerXOnly instanceof Uint8Array ? ownerXOnly : parseXOnlyKey(ownerXOnly);
  return Uint8Array.from([...pushData(encodeScriptNum(csvBlocks)), OP.CSV, OP.DROP, ...pushData(owner), OP.CHECKSIG]);
}

/** Penalty leaf for a to_local output: HASH160 <revokeHash160> EQUALVERIFY <peer> CHECKSIG. */
export function buildPenaltyLeaf(revokeHash160, peerXOnly) {
  if (!(revokeHash160 instanceof Uint8Array) || revokeHash160.length !== 20) {
    throw new Error("revocation hash must be 20 bytes (hash160)");
  }
  const peer = peerXOnly instanceof Uint8Array ? peerXOnly : parseXOnlyKey(peerXOnly);
  return Uint8Array.from([OP.HASH160, ...pushData(revokeHash160), OP.EQUALVERIFY, ...pushData(peer), OP.CHECKSIG]);
}

/* ---------------- NUMS internal keys ---------------- */

/** NUMS internal key bound to the channel parameters. Same hash-to-curve
 *  attempt-loop construction as the audited escrow NUMS, with a
 *  channels-specific domain so keys can never collide across apps. */
export function numsInternalKeyChannel(fundingScript, aX, bX, csvBlocks) {
  if (!(fundingScript instanceof Uint8Array) || fundingScript.length === 0) throw new Error("bad funding script");
  const csvBytes = encodeScriptNum(csvBlocks);
  const preimage = Uint8Array.from([
    ...utf8(NUMS_DOMAIN), ...tapLeafHash(fundingScript), ...aX, ...bX, ...csvBytes,
  ]);
  for (let counter = 0; counter < 256; counter++) {
    const pre = counter === 0 ? preimage : Uint8Array.from([...preimage, counter]);
    const h = sha256(pre);
    try {
      const { bytesToNumberBE } = { bytesToNumberBE: (x) => BigInt("0x" + bytesToHex(x)) };
      schnorr.utils.lift_x(bytesToNumberBE(h));
      return h;
    } catch { /* try next counter */ }
  }
  throw new Error("CHANNEL REFUSED: NUMS lift failed (unreachable in practice)");
}

/** NUMS internal key for a to_local output, bound to both of its leaves. */
export function numsInternalKeyToLocal(delayLeaf, penaltyLeaf) {
  const preimage = Uint8Array.from([
    ...utf8(NUMS_DOMAIN + "/tolocal"), ...tapLeafHash(delayLeaf), ...tapLeafHash(penaltyLeaf),
  ]);
  for (let counter = 0; counter < 256; counter++) {
    const pre = counter === 0 ? preimage : Uint8Array.from([...preimage, counter]);
    const h = sha256(pre);
    try {
      schnorr.utils.lift_x(BigInt("0x" + bytesToHex(h)));
      return h;
    } catch { /* try next counter */ }
  }
  throw new Error("CHANNEL REFUSED: to_local NUMS lift failed (unreachable in practice)");
}

/** Independently verify a 33-byte single-leaf control block against the
 *  tweaked output key — the same check a wallet does before funding.
 *  (The audited escrow verifyControlBlock only handles 2-leaf trees.) */
export function verifyControlBlockSingle(internalXOnly, leafScript, controlBlock, tweakedX) {
  try {
    if (!(controlBlock instanceof Uint8Array) || controlBlock.length !== 33) return false;
    if ((controlBlock[0] & 0xfe) !== TAPLEAF_VERSION) return false;
    if (!constEq(controlBlock.slice(1, 33), internalXOnly)) return false;
    const root = tapLeafHash(leafScript); // single leaf: merkle root = leaf hash
    const t = taggedHash("TapTweak", Uint8Array.from([...internalXOnly, ...root]));
    const P = schnorr.utils.lift_x(BigInt("0x" + bytesToHex(internalXOnly)));
    const Q = P.add(schnorr.Point.BASE.multiply(BigInt("0x" + bytesToHex(t))));
    const x = schnorr.utils.pointToBytes(Q);
    const parity = Q.toAffine().y & 1n ? 1 : 0;
    return constEq(x, tweakedX) && (controlBlock[0] & 0x01) === parity;
  } catch {
    return false;
  }
}

/* ---------------- channel open ---------------- */

export function validateCsvDelay(n) {
  if (!Number.isInteger(n) || n < 1 || n > MAX_CSV_BLOCKS) {
    throw new Error(`CSV delay must be an integer 1..${MAX_CSV_BLOCKS} blocks`);
  }
  return n;
}

function resolveNetwork(netId) {
  const n = NETWORKS[netId] || Object.values(NETWORKS).find((x) => x.id === netId);
  if (!n) throw new Error(`unknown network ${netId}`);
  return n;
}

/**
 * Open a channel: validate everything, derive the funding address.
 * params: { myKeyInput, peerXOnlyHex, peerPayoutAddr, myCapacityGrains,
 *           peerCapacityGrains, csvDelay, networkId }
 */
export function openChannel(params) {
  const network = resolveNetwork(params.networkId || "mainnet");
  const me = partyKeyFromInput(params.myKeyInput, network);
  const peerX = parseXOnlyKey(params.peerXOnlyHex);
  if (constEq(me.xonly, peerX)) throw new Error("peer key must differ from your key");
  const peerPayoutProg = payoutProgram(params.peerPayoutAddr, network);
  const myCap = BigInt(params.myCapacityGrains);
  const peerCap = BigInt(params.peerCapacityGrains);
  if (myCap < 0n || peerCap < 0n) throw new Error("capacities must be non-negative");
  const capacity = myCap + peerCap;
  if (capacity <= 0n) throw new Error("channel capacity must be positive");
  if (capacity > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("capacity exceeds safe integer range");
  const csvDelay = validateCsvDelay(params.csvDelay);

  const fundingScript = buildFundingScript(me.xonly, peerX);
  if (fundingScript.length !== FUNDING_SCRIPT_LEN) throw new Error("funding script length drift — refusing");
  const internalXOnly = numsInternalKeyChannel(fundingScript, me.xonly, peerX, csvDelay);
  const info = commitKeyInfo(network, internalXOnly, fundingScript);
  // The tweaked key must NOT be spendable by either party alone: internal key
  // is NUMS (nobody knows the discrete log), so only the script path works.
  return {
    kind: DESCRIPTOR_KIND,
    network: network.id,
    csvDelay,
    aXOnly: bytesToHex(me.xonly), // you (role order fixed: you first)
    bXOnly: bytesToHex(peerX),    // peer
    peerPayoutAddr: params.peerPayoutAddr,
    myCapacity: myCap.toString(),
    peerCapacity: peerCap.toString(),
    capacity: capacity.toString(),
    fundingScript: bytesToHex(fundingScript),
    internalXOnly: bytesToHex(internalXOnly),
    address: info.commitAddress,
    controlBlock: bytesToHex(info.controlBlock),
    tweakedX: bytesToHex(info.commitXOnly),
    spk: bytesToHex(p2trScriptPubKey(info.commitXOnly)),
    myKeySource: me.source,
  };
}

/** Decode a prl1/tprl1/rprl1 payout address to its 32-byte P2TR program. */
export function payoutProgram(addr, network) {
  const t = String(addr || "").trim();
  let dec;
  try {
    dec = decodeBech32m(t);
  } catch {
    throw new Error("payout address is not a valid bech32m address");
  }
  if (dec.hrp !== network.hrp) throw new Error(`payout address HRP ${dec.hrp} does not match network ${network.hrp}`);
  if (dec.version !== 1 || dec.program.length !== 32) {
    throw new Error("payout address must be a v1 32-byte (P2TR) Pearl address");
  }
  return dec.program;
}

function canonicalChannelJson(c) {
  return JSON.stringify({
    kind: DESCRIPTOR_KIND,
    network: c.network,
    csvDelay: c.csvDelay,
    aXOnly: c.aXOnly,
    bXOnly: c.bXOnly,
    peerPayoutAddr: c.peerPayoutAddr,
    myCapacity: c.myCapacity,
    peerCapacity: c.peerCapacity,
    capacity: c.capacity,
    fundingScript: c.fundingScript,
    internalXOnly: c.internalXOnly,
    address: c.address,
    controlBlock: c.controlBlock,
    tweakedX: c.tweakedX,
    spk: c.spk,
  });
}

/** Tamper-evident short descriptor: chan:v1:<net>:<scriptHash16>:<csv>:<a16>:<b16>:<capacity> */
export function shortDescriptor(chan) {
  const h = bytesToHex(sha256(hexToBytes(chan.fundingScript))).slice(0, 16);
  return `chan:v1:${chan.network}:${h}:${chan.csvDelay}:${chan.aXOnly.slice(0, 16)}:${chan.bXOnly.slice(0, 16)}:${chan.capacity}`;
}

/** 64-bit channel fingerprint over the canonical descriptor. */
export function channelFingerprint(chan) {
  return bytesToHex(sha256(Uint8Array.from([...utf8(FP_DOMAIN), ...utf8(canonicalChannelJson(chan))] ))).slice(0, 16);
}

/** Re-derive the channel from untrusted JSON and report every mismatch. */
export function verifyChannelDescriptor(raw) {
  const failures = [];
  const checks = [];
  let c;
  try {
    c = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return { ok: false, failures: ["descriptor is not valid JSON"], checks };
  }
  if (!c || c.kind !== DESCRIPTOR_KIND) {
    return { ok: false, failures: [`descriptor kind must be ${DESCRIPTOR_KIND}`], checks };
  }
  const need = ["network", "csvDelay", "aXOnly", "bXOnly", "peerPayoutAddr", "myCapacity", "peerCapacity",
    "fundingScript", "internalXOnly", "address", "controlBlock", "tweakedX", "spk"];
  for (const k of need) if (c[k] === undefined) failures.push(`descriptor missing field: ${k}`);
  if (failures.length) return { ok: false, failures, checks };
  try {
    const network = resolveNetwork(c.network);
    const aX = parseXOnlyKey(c.aXOnly);
    const bX = parseXOnlyKey(c.bXOnly);
    payoutProgram(c.peerPayoutAddr, network);
    validateCsvDelay(c.csvDelay);
    const script = buildFundingScript(aX, bX);
    if (bytesToHex(script) !== c.fundingScript.toLowerCase()) {
      failures.push("fundingScript does not match the two party keys");
    } else {
      checks.push("funding script matches party keys (2-of-2 CHECKSIGADD)");
    }
    const internal = numsInternalKeyChannel(script, aX, bX, c.csvDelay);
    if (!constEq(internal, hexToBytes(c.internalXOnly))) {
      failures.push("internal key is not the NUMS key for these parameters — keypath backdoor possible");
    } else {
      checks.push("internal key is the NUMS key (no keypath backdoor)");
    }
    const info = commitKeyInfo(network, internal, script);
    if (info.commitAddress !== c.address) failures.push(`address mismatch: derived ${info.commitAddress}`);
    else checks.push("channel address re-derives exactly");
    if (bytesToHex(info.controlBlock) !== c.controlBlock.toLowerCase()) failures.push("control block mismatch");
    else checks.push("control block re-derives exactly");
    if (!verifyControlBlockSingle(internal, script, hexToBytes(c.controlBlock), hexToBytes(c.tweakedX))) {
      failures.push("control block fails independent re-verification");
    } else {
      checks.push("control block passes independent verification");
    }
    const cap = BigInt(c.myCapacity) + BigInt(c.peerCapacity);
    if (cap.toString() !== BigInt(c.capacity).toString() && c.capacity !== undefined) {
      failures.push("capacity field inconsistent with party capacities");
    }
  } catch (e) {
    failures.push(`descriptor parse error: ${e.message}`);
  }
  return { ok: failures.length === 0, failures, checks };
}

/* ---------------- commitment transactions ---------------- */

/** Build the to_local output scripts for a commitment owner.
 *  Returns { delayLeaf, penaltyLeaf, internalXOnly, tree } where tree is the
 *  2-leaf taptree (taptree2 from the audited escrow core). */
export function toLocalOutput(network, csvDelay, ownerXOnlyHex, peerXOnlyHex, revokeHash160) {
  const owner = parseXOnlyKey(ownerXOnlyHex);
  const peer = parseXOnlyKey(peerXOnlyHex);
  if (!(revokeHash160 instanceof Uint8Array) || revokeHash160.length !== 20) {
    throw new Error("revocation hash160 must be 20 bytes");
  }
  const delayLeaf = buildDelayLeaf(csvDelay, owner);
  const penaltyLeaf = buildPenaltyLeaf(revokeHash160, peer);
  const internalXOnly = numsInternalKeyToLocal(delayLeaf, penaltyLeaf);
  const tree = taptree2(network, internalXOnly, delayLeaf, penaltyLeaf);
  return {
    delayLeaf, penaltyLeaf, internalXOnly,
    address: tree.address,
    program: decodeBech32m(tree.address).program,
    spk: tree.spk,
    controlBlocks: tree.controlBlocks, // [delay control, penalty control]
    delayScript: bytesToHex(delayLeaf),
    penaltyScript: bytesToHex(penaltyLeaf),
  };
}

/** vBytes for a commitment / cooperative-close spend of the funding output. */
export function fundingSpendVBytes(nOut) {
  return spendVBytes({ nOut, scriptLen: FUNDING_SCRIPT_LEN, controlLen: 33, stackLens: [64, 64] });
}

function fundingInput(chan, fundingTxid, fundingVout) {
  return {
    txid: assertHex64(fundingTxid, "funding txid"),
    vout: fundingVout,
    value: Number(BigInt(chan.capacity)),
    spk: hexToBytes(chan.spk),
  };
}

function serializeUnsignedTx(network, input, outputs, sequence, locktime) {
  const outs = [];
  for (const o of outputs) {
    const s = p2trScriptPubKey(o.program);
    outs.push(...u64le(o.value), ...varint(s.length), ...s);
  }
  const core = [
    ...u32le(network.txVersion), ...varint(1),
    ...txidLE(input.txid), ...u32le(input.vout), ...varint(0), ...u32le(sequence),
    ...varint(outputs.length), ...outs, ...u32le(locktime),
  ];
  const txid = bytesToHex(dblSha(Uint8Array.from(core)).reverse());
  return { txid, hex: bytesToHex(Uint8Array.from(core)) };
}

/**
 * Build one side of a commitment pair (unsigned template).
 * side: "mine" — your commitment tx: to_local pays YOU (CSV-delayed, peer can
 * penalize with YOUR revocation secret), to_remote pays the peer immediately.
 * Balances are pre-fee; the commitment fee is deducted from to_local.
 */
export function buildCommitmentTx(networkId, chan, fundingTxid, fundingVout, side, state, feeRateGrainsPerVByte) {
  const network = resolveNetwork(networkId);
  if (side !== "mine" && side !== "theirs") throw new Error('side must be "mine" or "theirs"');
  const version = state.version;
  if (!Number.isInteger(version) || version < 0) throw new Error("bad state version");
  const myBal = BigInt(state.myBal);
  const peerBal = BigInt(state.peerBal);
  if (myBal < 0n || peerBal < 0n) throw new Error("balances must be non-negative");
  const capacity = BigInt(chan.capacity);
  if (myBal + peerBal !== capacity) {
    throw new Error(`balances must conserve capacity: ${myBal} + ${peerBal} != ${capacity}`);
  }
  if (!Number.isFinite(feeRateGrainsPerVByte) || feeRateGrainsPerVByte <= 0) throw new Error("bad fee rate");

  const ownerX = side === "mine" ? chan.aXOnly : chan.bXOnly;
  const peerX = side === "mine" ? chan.bXOnly : chan.aXOnly;
  const ownerBal = side === "mine" ? myBal : peerBal;
  const remoteBal = side === "mine" ? peerBal : myBal;
  const revokeHash160 = side === "mine" ? state.myRevokeHash160 : state.peerRevokeHash160;
  if (!revokeHash160) throw new Error(`missing ${side === "mine" ? "your" : "peer"} revocation hash for this state`);

  const toLocal = toLocalOutput(network, chan.csvDelay, ownerX, peerX, hexToBytes(revokeHash160));
  const remoteProg = side === "mine"
    ? payoutProgram(chan.peerPayoutAddr, network)
    : payoutProgram(state.myPayoutAddr, network); // your payout address for their copy

  // Fee from the real witness size; the broadcaster (owner) pays it.
  let nOut = 2;
  let fee = BigInt(Math.ceil(fundingSpendVBytes(nOut) * feeRateGrainsPerVByte));
  let toLocalValue = ownerBal - fee;
  const notes = [];
  if (toLocalValue < BigInt(DUST_GRAIN)) {
    throw new Error(
      `state ${version}: ${side === "mine" ? "your" : "peer"} balance ${ownerBal} cannot cover the ${fee}-grain commitment fee — fund more or receive before paying`
    );
  }
  let toRemoteValue = remoteBal;
  if (toRemoteValue > 0n && toRemoteValue < BigInt(DUST_GRAIN)) {
    // Dust remote output: drop it, fold into the fee, say so loudly.
    notes.push(`remote balance ${toRemoteValue} grains is dust — dropped into the commitment fee`);
    toRemoteValue = 0n;
    fee += remoteBal;
    nOut = 1;
    fee = BigInt(Math.ceil(fundingSpendVBytes(nOut) * feeRateGrainsPerVByte)) + remoteBal;
    toLocalValue = ownerBal - fee;
    if (toLocalValue < BigInt(DUST_GRAIN)) throw new Error("dust absorption left to_local below dust — refusing");
  }
  const outputs = [{ program: toLocal.program, value: Number(toLocalValue), kind: "to_local" }];
  if (toRemoteValue > 0n) outputs.push({ program: remoteProg, value: Number(toRemoteValue), kind: "to_remote" });

  const input = fundingInput(chan, fundingTxid, fundingVout);
  const fundingScript = hexToBytes(chan.fundingScript);
  const digest = scriptPathSigDigestEx(network, input, outputs, fundingScript, { sequence: FINAL_SEQ, locktime: 0 });
  const { txid, hex } = serializeUnsignedTx(network, input, outputs, FINAL_SEQ, 0);
  const fp = bytesToHex(sha256(Uint8Array.from([...utf8(FP_DOMAIN + "/commitment"), ...hexToBytes(txid)]))).slice(0, 16);
  return {
    kind: "pearl-channel-commitment:v1",
    side, version, txid, unsignedHex: hex,
    digest: bytesToHex(digest),
    fingerprint: fp,
    fundingTxid: input.txid, fundingVout: input.vout,
    sequence: FINAL_SEQ, locktime: 0,
    fee: fee.toString(),
    vBytes: fundingSpendVBytes(nOut),
    outputs: outputs.map((o) => ({ kind: o.kind, value: o.value.toString(), program: bytesToHex(o.program) })),
    toLocal: {
      address: toLocal.address,
      delayScript: toLocal.delayScript,
      penaltyScript: toLocal.penaltyScript,
      controlDelay: bytesToHex(toLocal.controlBlocks[0]),
      controlPenalty: bytesToHex(toLocal.controlBlocks[1]),
    },
    notes,
  };
}

/** Build both mirror copies of a commitment pair for one state. */
export function buildCommitmentPair(networkId, chan, fundingTxid, fundingVout, state, feeRateGrainsPerVByte) {
  return {
    mine: buildCommitmentTx(networkId, chan, fundingTxid, fundingVout, "mine", state, feeRateGrainsPerVByte),
    theirs: buildCommitmentTx(networkId, chan, fundingTxid, fundingVout, "theirs", state, feeRateGrainsPerVByte),
  };
}

/** Sign a commitment/close digest with a 64-hex private key. */
export function signChannelDigest(privHex, digestHex) {
  return bytesToHex(signForXOnly(assertHex64(privHex, "private key"), hexToBytes(assertHex64(digestHex, "digest"))));
}

/** Verify one Schnorr signature against an x-only key for a digest. Throws on failure. */
export function assertChannelSig(sigHex, digestHex, xonlyHex, who) {
  const ok = verifySchnorrSig(hexToBytes(assertSigHex(sigHex, "signature")), hexToBytes(assertHex64(digestHex, "digest")), parseXOnlyKey(xonlyHex));
  if (!ok) throw new Error(`${who} signature does not verify`);
  return true;
}

/**
 * Assemble a fully-signed funding spend (commitment or cooperative close).
 * Verifies BOTH signatures against the two party keys before assembling —
 * a bad peer signature is refused, never silently included.
 */
export function assembleFundingSpend(networkId, chan, template, sigAHex, sigBHex) {
  const network = resolveNetwork(networkId);
  assertChannelSig(sigAHex, template.digest, chan.aXOnly, "party A");
  assertChannelSig(sigBHex, template.digest, chan.bXOnly, "party B");
  const fundingScript = hexToBytes(chan.fundingScript);
  const controlBlock = hexToBytes(chan.controlBlock);
  const input = fundingInput(chan, template.fundingTxid, template.fundingVout);
  const outputs = template.outputs.map((o) => ({ program: hexToBytes(o.program), value: Number(BigInt(o.value)) }));
  // Witness order is reverse script-key order: [sigB, sigA, script, control].
  const built = buildScriptPathSpend(network, input, outputs, fundingScript, controlBlock,
    [hexToBytes(sigBHex), hexToBytes(sigAHex)], { sequence: template.sequence, locktime: template.locktime });
  if (built.digest !== template.digest.toLowerCase()) {
    throw new Error("rebuilt digest mismatch — template was tampered with");
  }
  return { hex: built.hex, txid: built.txid, vBytes: built.vBytes };
}

/* ---------------- cooperative close ---------------- */

/** Cooperative close: immediate outputs to both payout addresses, fee split. */
export function buildCoopClose(networkId, chan, fundingTxid, fundingVout, myPayoutAddr, state, feeRateGrainsPerVByte) {
  const network = resolveNetwork(networkId);
  const myBal = BigInt(state.myBal);
  const peerBal = BigInt(state.peerBal);
  const capacity = BigInt(chan.capacity);
  if (myBal + peerBal !== capacity) throw new Error("close balances must conserve capacity");
  if (!Number.isFinite(feeRateGrainsPerVByte) || feeRateGrainsPerVByte <= 0) throw new Error("bad fee rate");
  const myProg = payoutProgram(myPayoutAddr, network);
  const peerProg = payoutProgram(chan.peerPayoutAddr, network);

  let fee = BigInt(Math.ceil(fundingSpendVBytes(2) * feeRateGrainsPerVByte));
  const notes = [];
  let myOut = myBal - fee / 2n - (fee % 2n); // you take the odd grain
  let peerOut = peerBal - fee / 2n;
  const outs = [];
  if (myOut >= BigInt(DUST_GRAIN)) outs.push({ program: myProg, value: Number(myOut), kind: "coop_you" });
  else { notes.push(`your close output ${myOut} grains is dust — folded into the fee`); fee += myOut; }
  if (peerOut >= BigInt(DUST_GRAIN)) outs.push({ program: peerProg, value: Number(peerOut), kind: "coop_peer" });
  else { notes.push(`peer close output ${peerOut} grains is dust — folded into the fee`); fee += peerOut; }
  if (!outs.length) throw new Error("both close outputs are dust — refusing");
  // Re-estimate with the real output count; surplus goes to the fee.
  const realFee = BigInt(Math.ceil(fundingSpendVBytes(outs.length) * feeRateGrainsPerVByte));
  fee = myBal + peerBal - outs.reduce((s, o) => s + BigInt(o.value), 0n);
  if (fee < realFee) throw new Error("close fee under-estimated — refusing");

  const input = fundingInput(chan, fundingTxid, fundingVout);
  const fundingScript = hexToBytes(chan.fundingScript);
  const digest = scriptPathSigDigestEx(network, input, outs, fundingScript, { sequence: FINAL_SEQ, locktime: 0 });
  const { txid, hex } = serializeUnsignedTx(network, input, outs, FINAL_SEQ, 0);
  return {
    kind: "pearl-channel-coopclose:v1",
    version: state.version, txid, unsignedHex: hex,
    digest: bytesToHex(digest),
    fundingTxid: assertHex64(fundingTxid, "funding txid"), fundingVout,
    sequence: FINAL_SEQ, locktime: 0,
    fee: fee.toString(),
    vBytes: fundingSpendVBytes(outs.length),
    outputs: outs.map((o) => ({ kind: o.kind, value: o.value.toString(), program: bytesToHex(o.program) })),
    fingerprint: bytesToHex(sha256(Uint8Array.from([...utf8(FP_DOMAIN + "/coopclose"), ...hexToBytes(txid)]))).slice(0, 16),
    notes,
  };
}

/* ---------------- unilateral claim (after CSV matures) ---------------- */

/** Claim tx: spends YOUR to_local output from your latest commitment tx via
 *  the CSV delay leaf. Input sequence = csvDelay (BIP-68, block units).
 *  Returns the unsigned template; sign with signChannelDigest + assembleClaim. */
export function buildClaimTx(networkId, chan, commitment, myPayoutAddr, feeRateGrainsPerVByte) {
  const network = resolveNetwork(networkId);
  const csvDelay = validateCsvDelay(chan.csvDelay);
  const toLocalOut = commitment.outputs.find((o) => o.kind === "to_local");
  if (!toLocalOut) throw new Error("commitment has no to_local output");
  const toLocalValue = BigInt(toLocalOut.value);
  const myProg = payoutProgram(myPayoutAddr, network);
  const delayLeaf = hexToBytes(commitment.toLocal.delayScript);
  const toLocalSpk = p2trScriptPubKey(hexToBytes(toLocalOut.program));
  if (!Number.isFinite(feeRateGrainsPerVByte) || feeRateGrainsPerVByte <= 0) throw new Error("bad fee rate");

  const vBytes = spendVBytes({ nOut: 1, scriptLen: delayLeaf.length, controlLen: 65, stackLens: [64] });
  const fee = BigInt(Math.ceil(vBytes * feeRateGrainsPerVByte));
  const out = toLocalValue - fee;
  if (out < BigInt(DUST_GRAIN)) throw new Error("claim output would be dust — to_local value too small for this fee rate");
  const input = { txid: commitment.txid, vout: 0, value: Number(toLocalValue), spk: toLocalSpk };
  const outputs = [{ program: myProg, value: Number(out) }];
  const digest = scriptPathSigDigestEx(network, input, outputs, delayLeaf, { sequence: csvDelay, locktime: 0 });
  const { txid, hex } = serializeUnsignedTx(network, input, outputs, csvDelay, 0);
  return {
    kind: "pearl-channel-claim:v1",
    version: commitment.version, txid, unsignedHex: hex,
    digest: bytesToHex(digest),
    sequence: csvDelay, locktime: 0,
    fee: fee.toString(), vBytes,
    maturesAfterBlocks: csvDelay,
    delayScriptHex: bytesToHex(delayLeaf),
    toLocalRef: {
      commitTxid: commitment.txid, vout: 0,
      value: toLocalValue.toString(), program: bytesToHex(hexToBytes(toLocalOut.program)),
      controlDelay: commitment.toLocal.controlDelay,
    },
    outputs: [{ kind: "claim", value: out.toString(), program: bytesToHex(myProg) }],
    fingerprint: bytesToHex(sha256(Uint8Array.from([...utf8(FP_DOMAIN + "/claim"), ...hexToBytes(txid)]))).slice(0, 16),
  };
}

/** Assemble a signed claim: verifies YOUR signature against your key first. */
export function assembleClaimTx(networkId, chan, template, sigHex) {
  const network = resolveNetwork(networkId);
  assertChannelSig(sigHex, template.digest, chan.aXOnly, "your");
  const delayLeaf = delayLeafFromTemplate(template);
  const toLocalOut = template.toLocalRef;
  const input = {
    txid: toLocalOut.commitTxid, vout: toLocalOut.vout,
    value: Number(BigInt(toLocalOut.value)), spk: p2trScriptPubKey(hexToBytes(toLocalOut.program)),
  };
  const outputs = template.outputs.map((o) => ({ program: hexToBytes(o.program), value: Number(BigInt(o.value)) }));
  const built = buildScriptPathSpend(network, input, outputs, delayLeaf, hexToBytes(toLocalOut.controlDelay),
    [hexToBytes(sigHex)], { sequence: template.sequence, locktime: 0 });
  if (built.digest !== template.digest.toLowerCase()) throw new Error("rebuilt claim digest mismatch — template tampered");
  return { hex: built.hex, txid: built.txid, vBytes: built.vBytes };
}

function delayLeafFromTemplate(template) {
  // The claim template is always built by buildClaimTx, which stores the
  // delay script hex on the sibling commitment; the page passes it through.
  if (!template.delayScriptHex) throw new Error("claim template missing delayScriptHex");
  return hexToBytes(template.delayScriptHex);
}

/* ---------------- funding transaction ---------------- */

/** Build + sign the funding tx: your wallet UTXOs -> channel address (+ change).
 *  walletKey: { priv: Uint8Array(32), internalXOnly: Uint8Array(32) }. */
export function planChannelFunding(networkId, chan, utxos, walletKey, feeRateGrainsPerVByte) {
  const network = resolveNetwork(networkId);
  if (!(walletKey.priv instanceof Uint8Array) || walletKey.priv.length !== 32) {
    throw new Error("funding needs your private key (x-only peer keys cannot fund)");
  }
  if (!(walletKey.internalXOnly instanceof Uint8Array) || walletKey.internalXOnly.length !== 32) {
    throw new Error("wallet key missing internal x-only key");
  }
  if (!Number.isFinite(feeRateGrainsPerVByte) || feeRateGrainsPerVByte <= 0) throw new Error("bad fee rate");
  const capacity = BigInt(chan.capacity);
  const clean = utxos.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value }));
  const sel = selectCoins(clean, capacity, feeRateGrainsPerVByte, 1);
  const myTweaked = tweakKeypath(walletKey.internalXOnly).tweakedX;
  const inputs = sel.selected.map((u) => ({
    txid: u.txid, vout: u.vout, value: Number(BigInt(u.value)),
    priv: walletKey.priv, internalXOnly: walletKey.internalXOnly,
    spk: p2trScriptPubKey(myTweaked),
  }));
  const chanProg = decodeBech32m(chan.address).program;
  const outputs = [{ program: chanProg, value: Number(capacity) }];
  if (sel.change >= BigInt(DUST_GRAIN)) outputs.push({ program: myTweaked, value: Number(sel.change) });
  const built = buildKeypathTxEx(network, inputs, outputs, SIGHASH_DEFAULT, FINAL_SEQ);
  const prevouts = inputs.map((i) => ({ value: i.value, spk: i.spk }));
  const vr = verifySignedTx(network, built.hex, prevouts);
  if (!vr.every((r) => r.ok)) throw new Error("funding signature failed re-verification — refusing to hand you this tx");
  return {
    txid: built.txid, hex: built.hex,
    fee: sel.fee.toString(), change: sel.change.toString(),
    inputs: inputs.length, vBytes: built.vBytes || null,
  };
}

/* ---------------- state bundles (peer exchange) ---------------- */

export const STATE_BUNDLE_KIND = "pearl-channel-state:v1";

/** Export a state for the peer: descriptor + both unsigned commitments +
 *  your revocation hash + your signatures so far. No private keys, ever. */
export function exportStateBundle(chan, fundingTxid, fundingVout, state, pair, mySigs) {
  const bundle = {
    kind: STATE_BUNDLE_KIND,
    shortDescriptor: shortDescriptor(chan),
    fingerprint: channelFingerprint(chan),
    descriptor: JSON.parse(canonicalChannelJson(chan)),
    fundingTxid: assertHex64(fundingTxid, "funding txid"),
    fundingVout,
    version: state.version,
    myBal: state.myBal.toString(),
    peerBal: state.peerBal.toString(),
    myPayoutAddr: state.myPayoutAddr,
    myRevokeHash160: state.myRevokeHash160,
    peerRevokeHash160: state.peerRevokeHash160 || null,
    commitments: {
      mine: { ...pair.mine, fundingTxid: pair.mine.fundingTxid || assertHex64(fundingTxid, "funding txid"), fundingVout, sequence: FINAL_SEQ, locktime: 0 },
      theirs: { ...pair.theirs, fundingTxid: pair.theirs.fundingTxid || assertHex64(fundingTxid, "funding txid"), fundingVout, sequence: FINAL_SEQ, locktime: 0 },
    },
    mySigs: { mine: mySigs.mine || null, theirs: mySigs.theirs || null },
    revokedSecrets: state.revokedSecrets || { mine: [], theirs: [] },
    exportedAt: new Date().toISOString(),
  };
  return JSON.stringify(bundle, null, 2);
}

/** Import + validate a peer's state bundle. Re-derives the descriptor. */
export function importStateBundle(json) {
  let b;
  try {
    b = typeof json === "string" ? JSON.parse(json) : json;
  } catch {
    throw new Error("bundle is not valid JSON");
  }
  if (!b || b.kind !== STATE_BUNDLE_KIND) throw new Error(`bundle kind must be ${STATE_BUNDLE_KIND}`);
  const vr = verifyChannelDescriptor(b.descriptor);
  if (!vr.ok) throw new Error(`bundle descriptor failed verification: ${vr.failures.join("; ")}`);
  if (!Number.isInteger(b.version) || b.version < 0) throw new Error("bundle has bad version");
  const myBal = BigInt(b.myBal), peerBal = BigInt(b.peerBal);
  if (myBal + peerBal !== BigInt(b.descriptor.capacity)) throw new Error("bundle balances do not conserve capacity");
  assertHex64(b.fundingTxid, "bundle funding txid");
  for (const side of ["mine", "theirs"]) {
    const c = b.commitments?.[side];
    if (!c || c.kind !== "pearl-channel-commitment:v1") throw new Error(`bundle missing ${side} commitment`);
    if (c.version !== b.version) throw new Error(`bundle ${side} commitment version mismatch`);
  }
  return b;
}

/* ---------------- channel transaction verifier ---------------- */

/**
 * Verify a signed channel transaction against the descriptor + expected state.
 * Rebuilds the expected commitment pair / cooperative close from the same
 * inputs and compares txids — then re-verifies every signature. Returns
 * { ok, kind, checks[], failures[] }.
 */
export function verifyChannelTx(networkId, chan, txHex, fundingTxid, fundingVout, state, myPayoutAddr, feeRateGrainsPerVByte) {
  const checks = [], failures = [];
  const fail = (m) => failures.push(m);
  const ok = (m) => checks.push(m);
  let kind = "unknown";
  try {
    // Decode and check the funding spend directly.
    const dec = decodeRawTx(txHex);
    if (dec.inputs.length !== 1) fail(`expected 1 input, found ${dec.inputs.length}`);
    else {
      const inp = dec.inputs[0];
      if (inp.txid !== assertHex64(fundingTxid, "funding txid")) fail("input does not spend the funding txid");
      else ok("input spends the channel funding outpoint");
      if (inp.vout !== fundingVout) fail("input vout is not the funding vout");
      const rawWit = (dec.witness && dec.witness[0]) || [];
      const wit = rawWit.map((w) => bytesToHex(w));
      if (wit.length !== 4) fail(`expected 4 witness items [sigB, sigA, script, control], found ${wit.length}`);
      else {
        const [sigBHex, sigAHex, scriptHex, controlHex] = wit;
        const fundingScript = hexToBytes(chan.fundingScript);
        if (scriptHex.toLowerCase() !== chan.fundingScript.toLowerCase()) fail("witness script is not the funding script");
        else ok("witness script is the 2-of-2 funding leaf");
        if (controlHex.toLowerCase() !== chan.controlBlock.toLowerCase()) fail("witness control block mismatch");
        else ok("witness control block matches the channel");
        const network = resolveNetwork(networkId);
        const outputs = dec.outputs.map((o) => {
          const prog = o.spk.length === 34 && o.spk[0] === 0x51 && o.spk[1] === 0x20 ? o.spk.slice(2) : null;
          return { program: prog, value: Number(o.value) };
        });
        if (outputs.some((o) => !o.program)) fail("a tx output is not P2TR — channel spends must be P2TR");
        else {
          const input = { txid: assertHex64(fundingTxid, "funding txid"), vout: fundingVout, value: Number(BigInt(chan.capacity)), spk: hexToBytes(chan.spk) };
          const digest = scriptPathSigDigestEx(network, input, outputs, fundingScript, { sequence: inp.sequence, locktime: dec.locktime });
          const digestHex = bytesToHex(digest);
          try { assertChannelSig(sigAHex, digestHex, chan.aXOnly, "party A"); ok("party A signature verifies"); }
          catch (e) { fail(e.message); }
          try { assertChannelSig(sigBHex, digestHex, chan.bXOnly, "party B"); ok("party B signature verifies"); }
          catch (e) { fail(e.message); }
          // Classify: match outputs against the expected templates.
          const outKey = outputs.map((o) => `${bytesToHex(o.program)}:${o.value}`).sort().join("|");
          const match = (t) => t.outputs.map((o) => `${o.program}:${o.value}`).sort().join("|") === outKey;
          // Rebuild the commitment templates when the state carries enough to do
          // so (version + both revocation hashes); otherwise match closes only.
          let pair2 = null;
          try {
            pair2 = buildCommitmentPair(networkId, chan, fundingTxid, fundingVout, state, feeRateGrainsPerVByte);
            for (const c of [pair2.mine, pair2.theirs]) { c.fundingTxid = assertHex64(fundingTxid, "funding txid"); c.fundingVout = fundingVout; }
          } catch (e) { ok(`commitment templates not rebuildable (${e.message}) — matching closes only`); }
          if (pair2 && match(pair2.mine)) { kind = "commitment (yours)"; ok(`outputs match your commitment tx for state ${state.version}`); }
          else if (pair2 && match(pair2.theirs)) { kind = "commitment (theirs)"; ok(`outputs match the peer's commitment tx for state ${state.version}`); }
          else {
            const coop2 = buildCoopClose(networkId, chan, fundingTxid, fundingVout, myPayoutAddr, state, feeRateGrainsPerVByte);
            if (match(coop2)) { kind = "cooperative close"; ok("outputs match the cooperative close for this state"); }
            else fail("outputs match neither commitment nor cooperative close for the expected state");
          }
          const dust = outputs.filter((o) => BigInt(o.value) < BigInt(DUST_GRAIN));
          if (dust.length) fail(`${dust.length} output(s) below dust`);
          else ok("all outputs above dust");
          const spent = outputs.reduce((s, o) => s + BigInt(o.value), 0n);
          if (spent > BigInt(chan.capacity)) fail("outputs exceed channel capacity");
          else ok(`outputs conserve capacity (fee ${(BigInt(chan.capacity) - spent).toString()} grains)`);
        }
      }
    }
  } catch (e) {
    fail(`verifier error: ${e.message}`);
  }
  return { ok: failures.length === 0, kind, checks, failures };
}

/** Wipe a private key object in place. */
export function wipeKey(k) {
  try {
    if (k && k.priv instanceof Uint8Array) k.priv.fill(0);
    if (k && k.internalPriv instanceof Uint8Array) k.internalPriv.fill(0);
  } catch { /* best effort */ }
}
