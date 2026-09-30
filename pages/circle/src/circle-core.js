/* Pearl Circle core — rotating savings club (ROSCA) desk for PRL.
 *
 * N members each contribute C PRL per round, for N rounds. Each round exactly
 * one member takes the whole pot (N x C). The payout order is decided by a
 * commit-reveal lottery nobody can game: every member commits sha256(secret),
 * then reveals; the order is the members sorted by
 *   sha256(secret_0 || ... || secret_{n-1} || u32le(memberIndex))
 * Anyone with the commitments + reveals re-derives the same order.
 *
 * The lottery runs BEFORE funding: the setup descriptor is forged first,
 * commitments bind to it, the order is computed, and only then are the
 * per-round Taproot escrow addresses derived — each round's leaf A pays the
 * round's winner, so the addresses genuinely cannot exist until the order
 * is known. No smart contracts (Pearl has none), no new cryptography.
 *
 * Per round, a 2-leaf taptree under a NUMS internal key
 * (domain "PearlCircleNUMS/v1", same lift_x construction as the audited
 * escrow NUMS — nobody knows the discrete log, so keypath spending is
 * impossible):
 *   leaf A (winner claim): <winnerXOnly> CHECKSIG  (byte-identical shape to
 *                            the audited bond transfer leaf)
 *   leaf B (timeout refund): <lock> CLTV DROP <0> <K1> CHECKSIGADD ...
 *                            <Kn> CHECKSIGADD <m> EQUAL
 *                            (m-of-n over ALL member keys, sorted — same
 *                            multisig script as the audited covenant leaf,
 *                            prefixed with the CLTV guard)
 * Members fund the round address with exactly C each. The winner claims via
 * leaf A (no timelock — claimable as soon as the pot is full). If the winner
 * never claims, any m members cooperatively refund after the round's lock
 * height: the pot is split back C each to the members' registered refund
 * addresses (minus an equal fee share).
 *
 * Money math: grain-exact BigInt-free integer grains (safe-integer checked),
 * dust floor 546, block target 194 s (node/chaincfg/params.go TargetTimePerBlock).
 * Cryptography: the audited Sign/Escrow/Games/Bond/Covenant lineage —
 * taggedHash, tapLeafHash, taptree2, BIP-341 script-path sighash (SIGHASH_DEFAULT),
 * BIP-340 Schnorr, bech32m, BIP-86 wallets. The ONLY local construction is
 * the NUMS internal key, which mirrors escrow's numsInternalKeyEscrow
 * field-for-field with the circle domain tag.
 */

import {
  taggedHash, tapLeafHash, encodeBech32m, decodeBech32m,
  schnorr, sha256, bytesToHex, hexToBytes,
  varint, u32le, u64le, p2trScriptPubKey, txidLE, dblSha,
  DUST_GRAIN, GRAIN_PER_PRL, NETWORKS,
  walletFromMnemonic, newMnemonic, walletFromWIF, walletFromPriv,
  fetchFeeRateGrainsPerVByte, broadcastTx,
} from "../../sign/src/crypto.js";
import {
  fmtPRL, parsePRL,
} from "../../sign/src/sign-core.js";
import {
  partyKeyFromInput, parseXOnlyKey, scriptPathSigDigestEx,
  signForXOnly, verifySchnorrSig,
  buildScriptPathSpend, spendVBytes,
  addressToProgram, scriptAsm, encodeScriptNum, pushData, taptree2,
} from "../../escrow/src/escrow-core.js";
import {
  newSecret, commitmentFor, verifyReveal, descriptorFingerprint,
} from "../../games/src/games-core.js";
import { buildTransferScript } from "../../bond/src/bond-core.js";
import { buildMultisigScript } from "../../covenant/src/covenant-core.js";
import { bytesToNumberBE } from "@noble/curves/abstract/utils";

export {
  DUST_GRAIN, GRAIN_PER_PRL, NETWORKS,
  walletFromMnemonic, newMnemonic, walletFromWIF, walletFromPriv,
  fetchFeeRateGrainsPerVByte, broadcastTx,
  bytesToHex, hexToBytes, schnorr, sha256, dblSha,
  encodeBech32m, decodeBech32m, p2trScriptPubKey, txidLE,
  partyKeyFromInput, parseXOnlyKey, scriptAsm, addressToProgram,
  verifySchnorrSig, signForXOnly, scriptPathSigDigestEx,
  encodeScriptNum, pushData, spendVBytes, fmtPRL, parsePRL,
  newSecret, commitmentFor, verifyReveal, descriptorFingerprint,
  buildMultisigScript,
};

export const BLOCKBOOK_MAINNET = "https://blockbook.pearlresearch.ai";
export const BLOCK_TIME_SEC = 194; // node/chaincfg/params.go TargetTimePerBlock
export const MAX_MEMBERS = 16;     // covenant's CHECKSIGADD ceiling
export const MIN_MEMBERS = 2;
export const DESCRIPTOR_PREFIX = "pearlcircle:v1";
export const NUMS_DOMAIN = "PearlCircleNUMS/v1";
export const SEQ_NONFINAL = 0xfffffffe; // CLTV-safe, RBF-opt-in
export const SEQ_FINAL = 0xffffffff;
const OP = { DROP: 0x75, CLTV: 0xb1 };
const LOCKTIME_THRESHOLD = 500_000_000;

/* ---------------- member + terms parsing ---------------- */

/** Parse one member input: bech32m prl1/tprl1 P2TR address, 64-hex x-only key,
 *  or BIP-39 mnemonic (BIP-86 account key) — the audited escrow key handling,
 *  extended with address inputs. Returns { name, xonly (hex), refundAddress }.
 *  An address input must match the circle's network; its own address becomes
 *  the member's refund address. */
export function parseMember(input, name, network, index) {
  const label = `member ${index + 1}${name ? ` (${name})` : ""}`;
  const cleanName = String(name ?? "").trim().slice(0, 32) || `Member ${index + 1}`;
  const t = String(input || "").trim();
  if (!t) throw new Error(`${label}: empty key`);
  let xonlyHex, refundAddress;
  let asAddr = null;
  try { asAddr = addressToProgram(t, network); } catch { /* not an address for this network */ }
  if (asAddr) {
    xonlyHex = bytesToHex(asAddr);
    refundAddress = t;
  } else {
    const pk = partyKeyFromInput(t, network); // 64-hex x-only or mnemonic
    xonlyHex = bytesToHex(pk.xonly);
    refundAddress = encodeBech32m(network.hrp, 1, pk.xonly);
  }
  return { name: cleanName, xonly: xonlyHex, refundAddress };
}

/** Parse + validate circle terms. Throws with a human message on bad input. */
export function parseCircleTerms(t, network) {
  if (!t || typeof t !== "object") throw new Error("terms required");
  if (!network || !network.hrp) throw new Error("network required");
  const name = String(t.name ?? "").trim().slice(0, 48) || "Unnamed circle";
  const rawMembers = Array.isArray(t.members) ? t.members : [];
  if (rawMembers.length < MIN_MEMBERS) throw new Error(`need at least ${MIN_MEMBERS} members`);
  if (rawMembers.length > MAX_MEMBERS) throw new Error(`at most ${MAX_MEMBERS} members`);
  const members = rawMembers.map((m, i) =>
    parseMember(m && m.input !== undefined ? m.input : m, m && m.name, network, i));
  const seen = new Set();
  for (const m of members) {
    if (seen.has(m.xonly)) throw new Error(`duplicate member key (${m.name}) — each member must be distinct`);
    seen.add(m.xonly);
  }
  const contributionGrains = toGrains(t.contributionPRL, "contribution");
  if (contributionGrains < DUST_GRAIN) throw new Error(`contribution below dust (${DUST_GRAIN} grains)`);
  const roundBlocks = toInt(t.roundBlocks, "round length (blocks)", 1, 525_600);
  const startHeight = toInt(t.startHeight, "start height", 0, 10_000_000);
  const graceBlocks = toInt(t.graceBlocks ?? 144, "refund grace (blocks)", 0, 525_600);
  const lock1 = startHeight + roundBlocks + graceBlocks;
  if (lock1 >= LOCKTIME_THRESHOLD) throw new Error("round-1 refund lock exceeds locktime height range");
  const m = toInt(t.m ?? members.length - 1, "refund threshold m", 1, members.length);
  return {
    name, network: network.id, contributionGrains, roundBlocks,
    startHeight, graceBlocks, m, members,
  };
}

function toInt(v, label, min, max) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label} must be an integer in ${min}..${max}`);
  return n;
}

function toGrains(prl, label) {
  const g = BigInt(parsePRL(String(prl)));
  if (g > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label} too large`);
  const n = Number(g);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${label} must be a positive PRL amount`);
  return n;
}

/** Pot paid out each round: N x C grains. */
export function potGrains(terms) {
  return terms.members.length * terms.contributionGrains;
}

/** Refund lock height for round r (1-based): funding opens at
 *  startHeight + (r-1)*roundBlocks; the refund leaf unlocks graceBlocks
 *  after the NEXT round opens. */
export function lockHeightForRound(terms, r) {
  const h = terms.startHeight + r * terms.roundBlocks + terms.graceBlocks;
  if (h >= LOCKTIME_THRESHOLD) throw new Error("refund lock exceeds locktime height range");
  return h;
}

/* ---------------- commit-reveal lottery ---------------- */

/** Deterministic payout order from verified reveals.
 *  reveals: [{ memberIndex, secretHex }]; every member must reveal exactly
 *  once, and each secret must verify against its published commitment
 *  (checked here — constant-time, from the audited games lineage).
 *  Order = members sorted ascending by
 *    sha256(secret_0 || ... || secret_{n-1} || u32le(memberIndex)).
 *  Returns the order as an array of member indices (round r pays order[r-1]). */
export function payoutOrderFor({ setupHash, commitments, reveals, n }) {
  if (!/^[0-9a-f]{64}$/i.test(String(setupHash || ""))) throw new Error("bad setup hash");
  const comms = new Map();
  for (const c of commitments || []) {
    const i = Number(c.memberIndex);
    if (!Number.isInteger(i) || i < 0 || i >= n) throw new Error("commitment has bad member index");
    if (comms.has(i)) throw new Error(`member ${i + 1} committed twice`);
    const cm = String(c.commitment || "").trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(cm)) throw new Error(`member ${i + 1}: bad commitment`);
    comms.set(i, cm);
  }
  if (comms.size !== n) throw new Error(`need all ${n} commitments before the reveal (have ${comms.size})`);
  const seen = new Set();
  const secrets = new Array(n);
  for (const r of reveals || []) {
    const i = Number(r.memberIndex);
    if (!Number.isInteger(i) || i < 0 || i >= n) throw new Error("reveal has bad member index");
    if (seen.has(i)) throw new Error(`member ${i + 1} revealed twice`);
    seen.add(i);
    const s = String(r.secretHex || "").trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(s)) throw new Error(`member ${i + 1}: bad secret`);
    if (!verifyReveal(s, comms.get(i))) {
      throw new Error(`member ${i + 1}: secret does NOT match the published commitment — lottery is void, do not fund`);
    }
    secrets[i] = hexToBytes(s);
  }
  if (seen.size !== n) {
    const missing = [];
    for (let i = 0; i < n; i++) if (!seen.has(i)) missing.push(i + 1);
    throw new Error(`lottery incomplete: member(s) ${missing.join(", ")} have not revealed — the order cannot be computed and no round may be funded (abort path: refund any funded rounds via the timeout leaf)`);
  }
  const preimage = Uint8Array.from(secrets.flatMap((s) => [...s]));
  const scored = [];
  for (let i = 0; i < n; i++) {
    const h = sha256(Uint8Array.from([...preimage, ...u32le(i)]));
    scored.push({ i, score: bytesToHex(h) });
  }
  scored.sort((a, b) => (a.score < b.score ? -1 : a.score > b.score ? 1 : a.i - b.i));
  return scored.map((s) => s.i);
}

/** One member's lottery certificate entry (what gets published). */
export function memberCommitment(memberIndex, secretHex) {
  return { memberIndex, commitment: commitmentFor(secretHex) };
}

/* ---------------- taproot round forging ---------------- */

/** NUMS internal key: lift_x(sha256("PearlCircleNUMS/v1" || leafHashA ||
 *  leafHashB)) with the counter fallback — the same construction as the
 *  audited escrow NUMS, only the domain tag differs. Nobody knows the
 *  discrete log, so keypath spending is impossible. */
export function numsInternalKeyCircle(leafA, leafB) {
  if (!(leafA instanceof Uint8Array) || leafA.length === 0) throw new Error("bad leaf A");
  if (!(leafB instanceof Uint8Array) || leafB.length === 0) throw new Error("bad leaf B");
  const TE = new TextEncoder();
  const preimage = Uint8Array.from([TE.encode(NUMS_DOMAIN), tapLeafHash(leafA), tapLeafHash(leafB)]
    .flatMap((x) => [...x]));
  for (let counter = 0; counter < 256; counter++) {
    const pre = counter === 0 ? preimage : Uint8Array.from([...preimage, counter]);
    const h = sha256(pre);
    try {
      schnorr.utils.lift_x(bytesToNumberBE(h));
      return h;
    } catch { /* try next counter */ }
  }
  throw new Error("CIRCLE REFUSED: NUMS lift failed (unreachable in practice)");
}

/** leaf B (timeout refund): <lock> CLTV DROP <0> <K1> CHECKSIGADD ...
 *  <Kn> CHECKSIGADD <m> EQUAL — the audited covenant multisig leaf over ALL
 *  member keys (sorted), guarded by the round's lock height. */
export function buildRefundScriptCircle(sortedKeys, m, lock) {
  if (!Number.isInteger(lock) || lock < 1 || lock >= LOCKTIME_THRESHOLD) {
    throw new Error("lock must be a block height in 1..499999999");
  }
  const multi = buildMultisigScript(sortedKeys, m); // audited covenant leaf
  return Uint8Array.from([
    ...pushData(encodeScriptNum(lock)), OP.CLTV, OP.DROP, ...multi,
  ]);
}

/** Forge round r (1-based) of a circle with a known payout order.
 *  order: permutation of 0..n-1 from payoutOrderFor(). */
export function forgeRound(network, terms, order, r) {
  const n = terms.members.length;
  if (!Array.isArray(order) || order.length !== n) throw new Error("payout order required to forge rounds");
  const perm = [...order].sort((a, b) => a - b);
  if (perm.some((v, i) => v !== i)) throw new Error("payout order must be a permutation of the members");
  if (!Number.isInteger(r) || r < 1 || r > n) throw new Error(`round must be 1..${n}`);
  const winnerIndex = order[r - 1];
  const winner = terms.members[winnerIndex];
  const winnerXOnly = parseXOnlyKey(winner.xonly);
  const claimScript = buildTransferScript(winnerXOnly); // audited bond leaf shape
  const sortedKeys = terms.members.map((m) => parseXOnlyKey(m.xonly))
    .map(bytesToHex).sort().map(hexToBytes);
  const lock = lockHeightForRound(terms, r);
  const refundScript = buildRefundScriptCircle(sortedKeys, terms.m, lock);
  const internalXOnly = numsInternalKeyCircle(claimScript, refundScript);
  const tree = taptree2(network, internalXOnly, claimScript, refundScript); // audited 2-leaf taptree
  return {
    index: r, winnerIndex, winnerName: winner.name, winnerXOnly: winner.xonly,
    lockHeight: lock, potGrains: potGrains(terms),
    fundingOpensHeight: terms.startHeight + (r - 1) * terms.roundBlocks,
    claimScript, refundScript, internalXOnly,
    address: tree.address, spk: tree.spk,
    claimControlBlock: tree.controlBlocks[0], refundControlBlock: tree.controlBlocks[1],
    claimAsm: scriptAsm(claimScript), refundAsm: scriptAsm(refundScript),
  };
}

/** Forge every round of a circle. */
export function forgeCircle(network, terms, order) {
  if (!network || !network.hrp) throw new Error("network required");
  const rounds = [];
  for (let r = 1; r <= terms.members.length; r++) rounds.push(forgeRound(network, terms, order, r));
  const setupHash = circleSetupHash(terms);
  return {
    terms, order: [...order], setupHash,
    descriptor: encodeCircleDescriptor(terms),
    rounds, potGrains: potGrains(terms),
    totalPerMemberGrains: terms.members.length * terms.contributionGrains,
  };
}

/* ---------------- tamper-evident descriptor ---------------- */

const NET_LETTER = { mainnet: "m", testnet: "t", regtest: "r" };
const LETTER_NET = { m: "mainnet", t: "testnet", r: "regtest" };

function b64urlEncode(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = typeof btoa === "function"
    ? btoa(bin)
    : Buffer.from(bin, "binary").toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s) {
  const b64 = String(s).replace(/-/g, "+").replace(/_/g, "/");
  const bin = typeof atob === "function"
    ? atob(b64)
    : Buffer.from(b64, "base64").toString("binary");
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Canonical setup JSON — key order fixed so the hash is stable. */
export function canonicalSetupJson(terms) {
  return JSON.stringify({
    v: 1,
    net: NET_LETTER[terms.network] || "m",
    name: terms.name,
    c: terms.contributionGrains,
    rb: terms.roundBlocks,
    sh: terms.startHeight,
    tb: terms.graceBlocks,
    m: terms.m,
    members: terms.members.map((mem) => ({ n: mem.name, k: mem.xonly, r: mem.refundAddress })),
  });
}

/** SHA-256 of the canonical setup JSON (hex) — the lottery binds to this. */
export function circleSetupHash(terms) {
  return bytesToHex(sha256(new TextEncoder().encode(canonicalSetupJson(terms))));
}

/** Shareable descriptor: anyone with it re-derives every round address once
 *  the payout order is known. */
export function encodeCircleDescriptor(terms) {
  return `${DESCRIPTOR_PREFIX}:` + b64urlEncode(new TextEncoder().encode(canonicalSetupJson(terms)));
}

export function decodeCircleDescriptor(desc, networks = NETWORKS) {
  if (typeof desc !== "string") throw new Error("descriptor must be a string");
  const p = desc.trim().split(":");
  if (p.length !== 3 || `${p[0]}:${p[1]}` !== DESCRIPTOR_PREFIX) {
    throw new Error("bad circle descriptor — expected pearlcircle:v1:<payload>");
  }
  let json;
  try {
    json = JSON.parse(new TextDecoder().decode(b64urlDecode(p[2])));
  } catch {
    throw new Error("circle descriptor payload is not valid JSON");
  }
  if (json.v !== 1) throw new Error("unsupported circle descriptor version");
  const netName = LETTER_NET[json.net];
  if (!netName || !networks[netName]) throw new Error("bad network in descriptor");
  const network = networks[netName];
  const terms = parseCircleTerms({
    name: json.name, contributionPRL: (json.c / GRAIN_PER_PRL).toFixed(8),
    roundBlocks: json.rb, startHeight: json.sh, graceBlocks: json.tb, m: json.m,
    members: (json.members || []).map((mm) => ({ name: mm.n, input: mm.k })),
  }, network);
  // refund addresses are pinned by the descriptor — do not re-derive them
  const want = (json.members || []).map((mm) => String(mm.r || ""));
  terms.members.forEach((mem, i) => {
    if (want[i] && want[i] !== mem.refundAddress) {
      throw new Error(`refund address mismatch for ${mem.name} — descriptor tampered`);
    }
    if (want[i]) mem.refundAddress = want[i];
  });
  return { network, terms };
}

/** Re-derive everything from a descriptor + payout order (the audit one-liner). */
export function verifyDescriptor(desc, order) {
  const { network, terms } = decodeCircleDescriptor(desc);
  const circle = forgeCircle(network, terms, order);
  return {
    network: network.id, terms, order: circle.order, setupHash: circle.setupHash,
    fingerprint: descriptorFingerprint(circle.descriptor),
    descriptor: circle.descriptor,
    rounds: circle.rounds.map((r) => ({
      index: r.index, winnerName: r.winnerName, lockHeight: r.lockHeight,
      address: r.address, spkHex: bytesToHex(r.spk), potGrains: r.potGrains,
    })),
  };
}

/* ---------------- funding plan ---------------- */

/** Per-member funding checklist: N rounds x C, plus a fee estimate.
 *  Funding spends are ordinary keypath P2TR inputs (each member's wallet):
 *  vBytes = ceil(10.5 + 57.25*nIn + 43*nOut) — the Pearl Sign estimator. */
export function fundingPlan(circle, feeRateGrainsPerVByte) {
  if (!Number.isFinite(feeRateGrainsPerVByte) || feeRateGrainsPerVByte <= 0) {
    throw new Error("fee rate must be positive");
  }
  const n = circle.terms.members.length;
  const fundVBytes = Math.ceil(10.5 + 57.25 + 43); // 1 keypath in, 1 P2TR out
  const fundFee = Math.ceil(fundVBytes * feeRateGrainsPerVByte);
  return {
    rounds: circle.rounds.map((r) => ({
      index: r.index, address: r.address, amountGrains: circle.terms.contributionGrains,
      winnerName: r.winnerName, fundingOpensHeight: r.fundingOpensHeight,
      lockHeight: r.lockHeight, potGrains: r.potGrains,
    })),
    perMember: circle.terms.members.map((m) => ({
      name: m.name, contributionGrains: circle.terms.contributionGrains,
      rounds: n, totalGrains: circle.totalPerMemberGrains,
      estFundingFeesGrains: n * fundFee,
      grandTotalGrains: circle.totalPerMemberGrains + n * fundFee,
    })),
    estFeePerFundingGrains: fundFee, estFeePerFundingVBytes: fundVBytes,
    feeRateGrainsPerVByte,
  };
}

/* ---------------- winner claim (leaf A) ---------------- */

function validOutpoint(txid, vout) {
  const t = String(txid || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(t)) throw new Error("funding txid must be 64 hex characters");
  if (!Number.isInteger(vout) || vout < 0) throw new Error("vout must be a non-negative integer");
  return t;
}

/** Plan the winner's claim: whole pot (minus fee) to destProgram, no change.
 *  Signature re-verified before anything is built. */
export function planClaim(network, round, outpoint, destProgram, feeRateGrainsPerVByte) {
  if (!(destProgram instanceof Uint8Array) || destProgram.length !== 32) {
    throw new Error("destination program must be 32 bytes");
  }
  if (!Number.isFinite(feeRateGrainsPerVByte) || feeRateGrainsPerVByte <= 0) {
    throw new Error("fee rate must be positive");
  }
  const txid = validOutpoint(outpoint.txid, outpoint.vout);
  const value = outpoint.value;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("bad round value");
  const input = { txid, vout: outpoint.vout, value, spk: round.spk };
  const vBytes = spendVBytes({
    nOut: 1, scriptLen: round.claimScript.length,
    controlLen: round.claimControlBlock.length, stackLens: [64],
  });
  const fee = Math.ceil(vBytes * feeRateGrainsPerVByte);
  const payValue = value - fee;
  if (payValue < DUST_GRAIN) throw new Error(`round value ${value} cannot cover the claim fee ${fee}`);
  return {
    input, outputs: [{ program: destProgram, value: payValue }],
    fee, vBytes, roundIndex: round.index, winnerName: round.winnerName,
  };
}

/** Sign a planned claim with the winner's 32-byte privkey. */
export function signClaim(network, round, planned, winnerPriv) {
  if (!(winnerPriv instanceof Uint8Array) || winnerPriv.length !== 32) {
    throw new Error("winner privkey must be 32 bytes");
  }
  const digest = scriptPathSigDigestEx(network, planned.input, planned.outputs, round.claimScript, {
    sequence: SEQ_FINAL, locktime: 0,
  });
  const sig = signForXOnly(winnerPriv, digest);
  if (!verifySchnorrSig(sig, digest, round.winnerXOnly)) {
    throw new Error("claim signature failed local re-verification — refusing to build");
  }
  const built = buildScriptPathSpend(network, planned.input, planned.outputs,
    round.claimScript, round.claimControlBlock, [sig],
    { sequence: SEQ_FINAL, locktime: 0 });
  return { ...built, sig: bytesToHex(sig) };
}

/* ---------------- timeout refund (leaf B, m-of-n) ---------------- */

/** Build the unsigned refund template for one round: the pot is split back
 *  C-per-member (minus an equal fee share) to the registered refund
 *  addresses. Requires the chain to be at/past the round's lock height. */
export function planRefund(network, circle, round, outpoint, feeRateGrainsPerVByte, currentHeight) {
  const n = circle.terms.members.length;
  if (!Number.isInteger(currentHeight) || currentHeight < 0) throw new Error("current height required");
  if (currentHeight < round.lockHeight) {
    throw new Error(`round ${round.index} refund locked until height ${round.lockHeight} (chain at ${currentHeight})`);
  }
  if (!Number.isFinite(feeRateGrainsPerVByte) || feeRateGrainsPerVByte <= 0) {
    throw new Error("fee rate must be positive");
  }
  const txid = validOutpoint(outpoint.txid, outpoint.vout);
  const value = outpoint.value;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("bad round value");
  const input = { txid, vout: outpoint.vout, value, spk: round.spk };
  // Witness: m 64-byte sigs + (n-m) empty vectors + script + control block.
  const stackLens = [...Array(circle.terms.m).fill(64), ...Array(n - circle.terms.m).fill(0)];
  const vBytes = spendVBytes({
    nOut: n, scriptLen: round.refundScript.length,
    controlLen: round.refundControlBlock.length, stackLens,
  });
  const fee = Math.ceil(vBytes * feeRateGrainsPerVByte);
  const c = circle.terms.contributionGrains;
  const feeEach = Math.floor(fee / n);
  const feeRem = fee - feeEach * n;
  const outputs = circle.terms.members.map((m, i) => {
    const v = c - feeEach - (i === 0 ? feeRem : 0);
    if (v < DUST_GRAIN) throw new Error(`refund share for ${m.name} (${v} grains) below dust — pot cannot cover the fee`);
    return { program: addressToProgram(m.refundAddress, network), value: v, name: m.name };
  });
  const totalOut = outputs.reduce((a, o) => a + o.value, 0);
  if (totalOut !== value - fee) throw new Error("internal: refund fee split mismatch");
  const digest = scriptPathSigDigestEx(network, input, outputs, round.refundScript, {
    sequence: SEQ_NONFINAL, locktime: round.lockHeight,
  });
  return {
    input, outputs: outputs.map((o) => ({ program: o.program, value: o.value })),
    memberNames: outputs.map((o) => o.name),
    fee, vBytes, roundIndex: round.index, lockHeight: round.lockHeight,
    sequence: SEQ_NONFINAL, digestHex: bytesToHex(digest),
    need: circle.terms.m, of: n,
  };
}

/** One member signs the refund template. The signature is re-verified
 *  against their registered key before it is accepted. */
export function signRefund(network, circle, template, memberIndex, memberPriv) {
  const n = circle.terms.members.length;
  if (!Number.isInteger(memberIndex) || memberIndex < 0 || memberIndex >= n) {
    throw new Error("bad member index");
  }
  if (!(memberPriv instanceof Uint8Array) || memberPriv.length !== 32) {
    throw new Error("member privkey must be 32 bytes");
  }
  const member = circle.terms.members[memberIndex];
  const digest = scriptPathSigDigestEx(network, template.input,
    template.outputs, circle.rounds[template.roundIndex - 1].refundScript, {
      sequence: SEQ_NONFINAL, locktime: template.lockHeight,
    });
  if (bytesToHex(digest) !== template.digestHex.toLowerCase()) {
    throw new Error("refund template changed since it was built — refusing to sign");
  }
  const sig = signForXOnly(memberPriv, digest);
  if (!verifySchnorrSig(sig, digest, member.xonly)) {
    throw new Error(`refund signature failed local re-verification for ${member.name} — refusing to record`);
  }
  return { memberIndex, name: member.name, xonly: member.xonly, sig: bytesToHex(sig) };
}

/** Assemble the final refund tx once >= m valid signatures are collected.
 *  Witness = signatures in REVERSE sorted-key order (EMPTY for missing),
 *  exactly m sigs — the covenant CHECKSIGADD convention. */
export function finalizeRefund(network, circle, template, partialSigs) {
  const round = circle.rounds[template.roundIndex - 1];
  const sortedHex = circle.terms.members.map((m) => m.xonly).sort();
  const sigByKey = new Map();
  for (const ps of partialSigs || []) {
    const x = String(ps.xonly || "").toLowerCase();
    const s = String(ps.sig || "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(x) || !/^[0-9a-f]{128}$/.test(s)) {
      throw new Error("bad partial signature entry");
    }
    const digest = hexToBytes(template.digestHex);
    if (!verifySchnorrSig(hexToBytes(s), digest, x)) {
      throw new Error(`partial signature from ${ps.name || x.slice(0, 12)} is INVALID — refusing to finalize`);
    }
    if (!sortedHex.includes(x)) throw new Error("signature from a non-member key — refusing to finalize");
    sigByKey.set(x, hexToBytes(s));
  }
  if (sigByKey.size < template.need) {
    throw new Error(`quorum not reached: ${sigByKey.size} of ${template.need} signatures`);
  }
  const EMPTY = new Uint8Array(0);
  const stackItems = [];
  for (let i = sortedHex.length - 1; i >= 0; i--) {
    stackItems.push(sigByKey.get(sortedHex[i]) || EMPTY);
  }
  // Exactly m signatures: drop extras (highest-sorted keys first, deterministic).
  let drops = sigByKey.size - template.need;
  for (let i = 0; i < stackItems.length && drops > 0; i++) {
    if (stackItems[i].length === 64) { stackItems[i] = EMPTY; drops--; }
  }
  const spend = buildScriptPathSpend(network, template.input, template.outputs,
    round.refundScript, round.refundControlBlock, stackItems,
    { sequence: SEQ_NONFINAL, locktime: template.lockHeight });
  if (spend.digest !== template.digestHex.toLowerCase()) {
    throw new Error("internal: refund digest mismatch at finalize");
  }
  return { ...spend, sigsUsed: template.need };
}

/* ---------------- tracking ---------------- */

/** Classify each round against chain state.
 *  chainState: { height, info: { [address]: { balance, txs } } } */
export function classifyRounds(circle, chainState) {
  const height = chainState && Number.isInteger(chainState.height) ? chainState.height : null;
  const info = (chainState && chainState.info) || {};
  return circle.rounds.map((r) => {
    const st = info[r.address] || { balance: 0, txs: 0 };
    const funded = st.balance >= r.potGrains;
    const refundable = height === null ? null : height >= r.lockHeight;
    let status = "unfunded";
    if (funded) status = "pot-full";
    else if (st.balance === 0 && st.txs > 0) status = "spent";
    else if (st.txs > 0 || st.balance > 0) status = "funding";
    return {
      index: r.index, address: r.address, winnerName: r.winnerName,
      potGrains: r.potGrains, lockHeight: r.lockHeight,
      fundingOpensHeight: r.fundingOpensHeight,
      balance: st.balance, txs: st.txs, funded, refundable, status,
    };
  });
}
