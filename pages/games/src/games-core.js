/* Pearl Games core — provably-fair commit-reveal games (coin flip + dice) on
 * pure Taproot script. Pearl has no smart contracts, so the game is enforced
 * by cryptography + coordination instead of on-chain code:
 *
 *   1. SETUP — dealer and player agree on game, bet, stakes, timeout; each
 *      gets a tamper-evident `pearlgames:v1:` descriptor (SHA-256 over the
 *      canonical string, 64-bit fingerprint, loud refusal on tamper).
 *   2. COMMIT — the dealer generates a 32-byte secret and publishes
 *      sha256(secret). The player must see the commitment BEFORE funding.
 *   3. FUND — each party funds their OWN Taproot escrow address with exactly
 *      their stake. The two escrow addresses share the same settle leaf
 *      (2-of-2: <dealer> CHECKSIGVERIFY <player> CHECKSIG) but bind the
 *      depositor into the NUMS internal key AND give each depositor their own
 *      CLTV refund leaf — so a deposit can only ever go to its depositor
 *      (refund) or to the 2-of-2 settle. Nobody can touch the other's coins.
 *   4. REVEAL — the dealer reveals the secret; anyone verifies it against
 *      the commitment, then derives the outcome deterministically:
 *      outcomeSeed = sha256(secret || roundId); flip = LSB parity,
 *      dice = (first u16 % 6) + 1.
 *   5. SETTLE — the loser co-signs a 2-input settle tx paying the whole pot
 *      (minus exact fee) to the winner, coordinated as an unsigned JSON
 *      bundle with per-input BIP-341 digests and a 64-bit fingerprint.
 *      The importer re-verifies the outcome, the math, and every signature.
 *      Double-confirm before broadcast.
 *   REFUND — after the timeout height, each party can unilaterally refund
 *      their own deposit via their CLTV leaf (tx nLockTime = timeout).
 *      Loud refusal before maturity; wrong-depositor guard included.
 *
 * Stakes: even-money games (flip, dice hi/lo) — both post X, winner takes 2X.
 *   Dice exact (5:1) — the player posts X, the dealer posts 5X, winner takes
 *   6X. The page computes the required stakes from the bet type; funding a
 *   wrong amount is refused loudly because the settle math would break.
 *
 * Solo practice mode runs the same commit→reveal→verify protocol against a
 * local dealer with no funding and no broadcast — a protocol demo, never
 * presented as a real-money game.
 *
 * HONEST LIMITS (also in the UI's always-visible panel):
 * - Two-player mode needs a live counterparty running this protocol. The page
 *   coordinates via shareable bundles but cannot force anyone to reveal or
 *   co-sign. A sore loser can stall the settle until the timeout — then each
 *   side refunds its own deposit (minus fees already paid). Never bet what
 *   you can't afford to have locked until the timeout.
 * - The dealer's commitment binds the outcome, but the dealer chooses the
 *   secret. "Provably fair" means the outcome is fixed before you bet and
 *   verifiable after — not that the dealer can't get lucky.
 * - Timeout is an absolute block height. Pick it with the ~194s Pearl block
 *   time in mind; the page shows the wall-clock estimate but the chain
 *   decides.
 *
 * Crypto lineage: key derivation, TapTweak, bech32m, BIP-341 sighash and wire
 * serialization come from the audited files/pages/sign/src/crypto.js; script
 * composition helpers (partyKeyFromInput, parseXOnlyKey, encodeScriptNum,
 * buildRefundScript, taptree2, verifyControlBlock, signForXOnly,
 * verifySchnorrSig, spendVBytes, addressToProgram, scriptAsm) come from the
 * audited files/pages/escrow/src/escrow-core.js; the multi-input BIP-341
 * sighash (batchScriptPathSigDigest) comes from the audited
 * files/pages/stream/src/stream-core.js. The game protocol, outcome
 * derivation, per-depositor escrow binding, settle/refund coordinators and
 * descriptors are new composition on those primitives — no new cryptography,
 * no new signature schemes.
 */

import {
  taggedHash, tapLeafHash, encodeBech32m, decodeBech32m,
  schnorr, sha256, bytesToHex, hexToBytes, convertBits,
  varint, u32le, u64le, p2trScriptPubKey, txidLE, dblSha,
  DUST_GRAIN, GRAIN_PER_PRL, NETWORKS,
  walletFromMnemonic, newMnemonic, walletFromWIF, walletFromPriv,
  fetchUtxos, fetchFeeRateGrainsPerVByte, broadcastTx, fetchTxStatus,
  tweakKeypath,
} from "../../sign/src/crypto.js";
import {
  partyKeyFromInput, parseXOnlyKey, encodeScriptNum, buildRefundScript,
  taptree2, verifyControlBlock, signForXOnly, verifySchnorrSig,
  spendVBytes, addressToProgram, scriptAsm,
} from "../../escrow/src/escrow-core.js";
import {
  batchScriptPathSigDigest,
} from "../../stream/src/stream-core.js";
import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesToNumberBE } from "@noble/curves/abstract/utils";

export {
  DUST_GRAIN, GRAIN_PER_PRL, NETWORKS,
  walletFromMnemonic, newMnemonic, walletFromWIF, walletFromPriv,
  fetchUtxos, fetchFeeRateGrainsPerVByte, broadcastTx, fetchTxStatus,
  bytesToHex, hexToBytes, schnorr, sha256, dblSha, convertBits,
  encodeBech32m, decodeBech32m, p2trScriptPubKey, txidLE,
  partyKeyFromInput, parseXOnlyKey, addressToProgram, scriptAsm,
  verifySchnorrSig, signForXOnly, batchScriptPathSigDigest,
  buildRefundScript, encodeScriptNum, verifyControlBlock,
  tweakKeypath,
};

const OP = {
  FALSE: 0x00,
  DROP: 0x75,
  CHECKSIG: 0xac,
  CHECKSIGVERIFY: 0xad,
  CLTV: 0xb1,
};
const MAX_SEQ = 0xffffffff;
const NONFINAL_SEQ = 0xfffffffe;
const NUMS_DOMAIN = "PearlGamesNUMS/v1";
export const DESCRIPTOR_KIND = "pearlgames";
export const DESCRIPTOR_VERSION = "v1";
export const SETTLE_BUNDLE_KIND = "pearl-games-settle-bundle";
export const SETTLE_BUNDLE_VERSION = 1;

/** Kyle's donation address, shown in the page footer (copy character-for-character). */
export const DONATE_ADDRESS = "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d";

/** P2TR address for a wallet x-only key (BIP-86 keypath-tweaked). */
export function walletAddress(network, xonlyHex) {
  const t = tweakKeypath(hexToBytes(xonlyHex));
  return encodeBech32m(network.hrp, 1, t.tweakedX);
}

/* ------------------------------------------------------------------ */
/* Game definitions                                                     */
/* ------------------------------------------------------------------ */

/** Game catalogue. payoutMultiple: winner's gross multiple of the pot share. */
export const GAMES = {
  flip: {
    id: "flip",
    name: "Coin Flip",
    evenMoney: true,
    bets: ["heads", "tails"],
    describe: "Heads or tails. Winner takes the whole pot.",
  },
  "dice-exact": {
    id: "dice-exact",
    name: "Dice — Exact",
    evenMoney: false,
    payoutMultiple: 5,
    bets: ["1", "2", "3", "4", "5", "6"],
    describe: "Call the exact die face. 5:1 — the dealer posts 5× your stake.",
  },
  "dice-hilo": {
    id: "dice-hilo",
    name: "Dice — Hi/Lo",
    evenMoney: true,
    bets: ["low", "high"],
    describe: "Low wins on 1–3, high wins on 4–6. Even money.",
  },
};

export function parseGame(id) {
  const g = GAMES[String(id || "").trim()];
  if (!g) throw new Error(`unknown game ${JSON.stringify(String(id).slice(0, 24))} — pick flip, dice-exact or dice-hilo`);
  return g;
}

export function parseBet(gameId, bet) {
  const g = parseGame(gameId);
  const b = String(bet || "").trim().toLowerCase();
  if (!g.bets.includes(b)) throw new Error(`bad bet ${JSON.stringify(b.slice(0, 24))} for ${g.name} — one of: ${g.bets.join(", ")}`);
  return b;
}

/** Required stakes in grains for each side, from the player's base stake. */
export function stakesFor(gameId, playerStakeGrains) {
  const g = parseGame(gameId);
  const x = BigInt(playerStakeGrains);
  if (x <= 0n) throw new Error("stake must be positive");
  if (x < BigInt(DUST_GRAIN)) throw new Error(`stake below dust (${DUST_GRAIN} grains)`);
  if (g.evenMoney) return { dealer: x, player: x };
  const d = x * BigInt(g.payoutMultiple);
  return { dealer: d, player: x };
}

export function validateTimeout(timeoutHeight, currentHeight = null) {
  // Structural: an absolute block height below the 500M locktime threshold.
  if (!Number.isSafeInteger(timeoutHeight) || timeoutHeight <= 0 || timeoutHeight >= 500000000) {
    throw new Error("timeout must be a positive block height (< 500000000)");
  }
  if (currentHeight === null) return timeoutHeight;
  // With the chain tip known, enforce the escape-hatch distance: far enough to
  // be safe (144 blocks) but not absurdly far (52560 ≈ 4 months at 194s/block).
  if (!Number.isSafeInteger(currentHeight) || currentHeight < 0) throw new Error("bad current height");
  if (timeoutHeight <= currentHeight) {
    throw new Error(`timeout height ${timeoutHeight} is not in the future (chain is at ${currentHeight})`);
  }
  const delta = timeoutHeight - currentHeight;
  if (delta < 144) throw new Error(`timeout only ${delta} blocks ahead — needs at least 144`);
  if (delta > 52560) throw new Error(`timeout ${delta} blocks ahead — above 52560 (~4 months), refusing`);
  return timeoutHeight;
}

/* ------------------------------------------------------------------ */
/* Small utilities                                                      */
/* ------------------------------------------------------------------ */

function constEq(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
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

function pushData(data) {
  const b = data instanceof Uint8Array ? data : Uint8Array.from(data);
  if (b.length === 0) return new Uint8Array([OP.FALSE]);
  if (b.length <= 75) return Uint8Array.from([b.length, ...b]);
  throw new Error("push exceeds 75 bytes");
}

/** Exact decimal PRL string -> grains (BigInt). */
export function prlToGrains(s) {
  const t = String(s || "").trim();
  const m = t.match(/^(\d+)(?:\.(\d{1,8}))?$/);
  if (!m) throw new Error(`bad PRL amount: ${JSON.stringify(t.slice(0, 40))}`);
  const g = BigInt(m[1]) * 100_000_000n + (m[2] ? BigInt(m[2].padEnd(8, "0")) : 0n);
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

/** x-only pubkey for a 32-byte private key. */
export function pubkeyFromPriv(priv) {
  const p = priv instanceof Uint8Array ? priv : hexToBytes(String(priv).trim());
  if (p.length !== 32) throw new Error("private key must be 32 bytes");
  return bytesToHex(schnorr.getPublicKey(p));
}

/** Accept x-only hex, 12/24-word mnemonic, or WIF -> {xonly(hex), priv(Uint8Array|null), source}. */
export function gameKeyFromInput(input, network) {
  const t = String(input || "").trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) {
    return { xonly: bytesToHex(parseXOnlyKey(t)), priv: null, source: "x-only pubkey" };
  }
  const words = t.split(/\s+/);
  if (words.length === 12 || words.length === 24) {
    const w = walletFromMnemonic(t, network);
    return { xonly: bytesToHex(w.internalXOnly), priv: w.priv, source: "mnemonic (BIP-86 m/86'/coin'/0'/0/0)" };
  }
  // WIF (base58check) — walletFromWIF throws on anything else.
  try {
    const w = walletFromWIF(t, network);
    return { xonly: bytesToHex(w.internalXOnly), priv: w.priv, source: "WIF" };
  } catch {
    throw new Error("key must be a 64-hex x-only pubkey, a 12/24-word mnemonic, or WIF");
  }
}

/* ------------------------------------------------------------------ */
/* Commit–reveal protocol                                               */
/* ------------------------------------------------------------------ */

/** Fresh 32-byte dealer secret, hex. */
export function newSecret() {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return bytesToHex(b);
}

/** Commitment = sha256(secret bytes), hex. Published BEFORE the player bets. */
export function commitmentFor(secretHex) {
  const s = String(secretHex || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(s)) throw new Error("secret must be 32 bytes hex");
  return bytesToHex(sha256(hexToBytes(s)));
}

/** Verify a revealed secret against a published commitment (constant-time). */
export function verifyReveal(secretHex, commitmentHex) {
  const s = String(secretHex || "").trim().toLowerCase();
  const c = String(commitmentHex || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(s) || !/^[0-9a-f]{64}$/.test(c)) return false;
  return constEq(sha256(hexToBytes(s)), hexToBytes(c));
}

/** Deterministic outcome from the revealed secret + game round id. */
export function outcomeFor({ secretHex, roundId, game }) {
  const g = parseGame(game);
  const s = String(secretHex || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(s)) throw new Error("bad secret");
  const r = String(roundId || "");
  if (!/^[0-9a-f]{1,32}$/.test(r)) throw new Error("bad round id");
  const h = sha256(Uint8Array.from([...hexToBytes(s), ...utf8(r)]));
  if (g.id === "flip") return (h[0] & 1) ? "tails" : "heads";
  return ((h[0] << 8) | h[1]) % 6 + 1; // dice: 1..6
}

/** 'dealer' | 'player' — who won given the game, the player's bet and the outcome. */
export function winnerFor({ game, bet, outcome }) {
  const g = parseGame(game);
  const b = parseBet(game, bet);
  let playerWins;
  if (g.id === "flip") playerWins = b === outcome;
  else if (g.id === "dice-exact") playerWins = b === String(outcome);
  else playerWins = (b === "low" && outcome <= 3) || (b === "high" && outcome >= 4);
  return playerWins ? "player" : "dealer";
}

/** Full verified reveal: checks the commitment, derives and returns the outcome + winner. */
export function revealAndScore({ secretHex, commitmentHex, roundId, game, bet }) {
  if (!verifyReveal(secretHex, commitmentHex)) {
    throw new Error("NOT PROVEN — the revealed secret does not match the dealer's commitment. Do not settle.");
  }
  const outcome = outcomeFor({ secretHex, roundId, game });
  return { outcome, winner: winnerFor({ game, bet, outcome }) };
}

/* ------------------------------------------------------------------ */
/* Game descriptors (tamper-evident, round-trip byte-exact)              */
/* ------------------------------------------------------------------ */

/** 64-bit fingerprint of a descriptor string (first 8 bytes of sha256, hex). */
export function descriptorFingerprint(descriptor) {
  return bytesToHex(sha256(utf8(String(descriptor)))).slice(0, 16);
}

/**
 * Create a game: validates everything, assigns a random round id, and returns
 * the canonical descriptor plus derived parameters.
 */
export function createGame({ network, game, bet, dealerXOnly, playerXOnly, playerStakePRL, timeoutHeight, currentHeight = null }) {
  const g = parseGame(game);
  const b = parseBet(game, bet);
  const dX = bytesToHex(parseXOnlyKey(dealerXOnly));
  const pX = bytesToHex(parseXOnlyKey(playerXOnly));
  if (dX === pX) throw new Error("dealer and player keys must differ");
  const playerStake = prlToGrains(playerStakePRL);
  const stakes = stakesFor(g.id, playerStake);
  const timeout = validateTimeout(timeoutHeight, currentHeight);
  const rb = new Uint8Array(4);
  globalThis.crypto.getRandomValues(rb);
  const roundId = bytesToHex(rb);
  const descriptor = [
    DESCRIPTOR_KIND, DESCRIPTOR_VERSION, network.hrp, g.id, b,
    dX, pX, stakes.dealer.toString(), stakes.player.toString(),
    String(timeout), roundId,
  ].join(":");
  const params = gameFromDescriptor(descriptor, network); // self-check round-trip
  return {
    descriptor,
    fingerprint: descriptorFingerprint(descriptor),
    ...params,
  };
}

/** Parse + fully validate a descriptor; throws loudly on any tampering. */
export function gameFromDescriptor(descriptor, network) {
  const t = String(descriptor || "").trim();
  const parts = t.split(":");
  if (parts.length !== 11 || parts[0] !== DESCRIPTOR_KIND || parts[1] !== DESCRIPTOR_VERSION) {
    throw new Error("bad game descriptor — expected pearlgames:v1:<hrp>:<game>:<bet>:<dealerX>:<playerX>:<stakeD>:<stakeP>:<timeout>:<roundId>");
  }
  const [, , hrp, gameId, bet, dealerX, playerX, stakeDS, stakePS, timeoutS, roundId] = parts;
  if (hrp !== network.hrp) throw new Error(`descriptor is for ${hrp}, this page is on ${network.hrp}`);
  const g = parseGame(gameId);
  const b = parseBet(gameId, bet);
  const dX = bytesToHex(parseXOnlyKey(dealerX));
  const pX = bytesToHex(parseXOnlyKey(playerX));
  if (dX === pX) throw new Error("descriptor: dealer and player keys identical");
  let stakeD, stakeP;
  try { stakeD = BigInt(stakeDS); stakeP = BigInt(stakePS); }
  catch { throw new Error("descriptor: bad stake encoding"); }
  const expect = stakesFor(g.id, stakeP);
  if (expect.dealer !== stakeD || expect.player !== stakeP) {
    throw new Error("descriptor: stakes do not match the game's payout rules — refusing");
  }
  const timeout = validateTimeout(Number(timeoutS));
  if (!/^[0-9a-f]{8}$/.test(roundId)) throw new Error("descriptor: bad round id");
  // Byte-exact canonical re-encoding: any cosmetic tampering is caught here.
  const canonical = [DESCRIPTOR_KIND, DESCRIPTOR_VERSION, hrp, g.id, b, dX, pX, stakeD.toString(), stakeP.toString(), String(timeout), roundId].join(":");
  if (canonical !== t) throw new Error("descriptor tampered — canonical re-encoding differs. Refusing.");
  return {
    descriptor: canonical, fingerprint: descriptorFingerprint(canonical),
    network: network.id, hrp, game: g.id, gameName: g.name, bet: b,
    dealerXOnly: dX, playerXOnly: pX,
    stakeDealerGrains: stakeD, stakePlayerGrains: stakeP,
    timeoutHeight: timeout, roundId,
  };
}

/* ------------------------------------------------------------------ */
/* Escrow addresses — one per depositor, same settle leaf                */
/* ------------------------------------------------------------------ */

/** Settle leaf: 2-of-2 — loser co-signs the winner's payout.
 *  Witness order (sequential CHECKSIGs): [sig_dealer, sig_player]. */
export function buildSettleScript(dealerXOnly, playerXOnly) {
  const d = parseXOnlyKey(dealerXOnly);
  const p = parseXOnlyKey(playerXOnly);
  return Uint8Array.from([
    ...pushData(d), OP.CHECKSIGVERIFY, ...pushData(p), OP.CHECKSIG,
  ]);
}

/** NUMS internal key, bound to the depositor role so each escrow address is
 *  unique per depositor. Counter-fallback idiom mirrors fund-core. */
export function numsInternalKey({ dealerXOnly, playerXOnly, game, bet, stakeDealerGrains, stakePlayerGrains, timeoutHeight, roundId, depositor }) {
  if (depositor !== "dealer" && depositor !== "player") throw new Error("depositor must be 'dealer' or 'player'");
  const d = parseXOnlyKey(dealerXOnly);
  const p = parseXOnlyKey(playerXOnly);
  const preimage = Uint8Array.from([
    ...utf8(NUMS_DOMAIN), ...d, ...p,
    ...utf8(`${parseGame(game).id}:${parseBet(game, bet)}`),
    ...u64leBig(stakeDealerGrains), ...u64leBig(stakePlayerGrains),
    ...u32leNum(validateTimeout(timeoutHeight)), ...utf8(roundId),
    ...utf8(depositor === "dealer" ? "D" : "P"),
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

/** Full escrow derivation for one depositor's address. */
export function escrowFor({ network, dealerXOnly, playerXOnly, game, bet, stakeDealerGrains, stakePlayerGrains, timeoutHeight, roundId, depositor }) {
  const g = parseGame(game);
  const b = parseBet(game, bet);
  const dX = bytesToHex(parseXOnlyKey(dealerXOnly));
  const pX = bytesToHex(parseXOnlyKey(playerXOnly));
  const internalXOnly = numsInternalKey({
    dealerXOnly: dX, playerXOnly: pX, game: g.id, bet: b,
    stakeDealerGrains: BigInt(stakeDealerGrains), stakePlayerGrains: BigInt(stakePlayerGrains),
    timeoutHeight, roundId, depositor,
  });
  const settleScript = buildSettleScript(dX, pX);
  const depositorX = depositor === "dealer" ? dX : pX;
  const refundScript = buildRefundScript(depositorX, timeoutHeight);
  const tree = taptree2(network, internalXOnly, settleScript, refundScript);
  return {
    depositor, game: g.id, bet: b, roundId,
    address: tree.address,
    spkHex: bytesToHex(tree.spk),
    internalKeyHex: bytesToHex(internalXOnly),
    tweakedHex: bytesToHex(tree.tweakedX),
    settleScriptHex: bytesToHex(settleScript),
    refundScriptHex: bytesToHex(refundScript),
    settleControlBlockHex: bytesToHex(tree.controlBlocks[0]),
    refundControlBlockHex: bytesToHex(tree.controlBlocks[1]),
    stakeGrains: (depositor === "dealer" ? BigInt(stakeDealerGrains) : BigInt(stakePlayerGrains)).toString(),
    timeoutHeight,
  };
}

/** Re-derive and check a funded escrow address before anyone sends coins. */
export function verifyEscrowAddress(escrow) {
  const ok = verifyControlBlock(
    hexToBytes(escrow.internalKeyHex),
    hexToBytes(escrow.settleScriptHex),
    hexToBytes(escrow.settleControlBlockHex),
    hexToBytes(escrow.tweakedHex),
  );
  if (!ok) throw new Error("escrow control block does not re-derive — refusing to fund");
  return true;
}

/* ------------------------------------------------------------------ */
/* Settle planning — exact vBytes, grain-exact fee                      */
/* ------------------------------------------------------------------ */

/** vBytes for the 2-input settle spend (script path, 1 P2TR output).
 *  Each input carries its own witness: [sig_dealer, sig_player] + leaf + control. */
export function settleSpendVBytes({ settleScriptLen, controlLen }) {
  const varintLen = (n) => (n < 0xfd ? 1 : n <= 0xffff ? 3 : n <= 0xffffffff ? 5 : 9);
  const stackLens = [64, 64];
  let witPerInput = varintLen(stackLens.length + 2); // witness item count
  for (const l of stackLens) witPerInput += varintLen(l) + l;
  witPerInput += varintLen(settleScriptLen) + settleScriptLen + varintLen(controlLen) + controlLen;
  const base = 4 + 1 + 2 * 41 + 1 + 1 * 43 + 4; // ver+count+2ins+count+1out+locktime
  const total = base + 2 + 2 * witPerInput; // + segwit marker/flag
  return Math.ceil((base * 3 + total) / 4);
}

/** Plan the settle: pot, exact fee, winner payout. Loud refusal on uneconomics. */
export function planSettle({ stakeDealerGrains, stakePlayerGrains, settleScriptLen, controlLen, feeRateGrainsPerVByte }) {
  const pot = BigInt(stakeDealerGrains) + BigInt(stakePlayerGrains);
  if (pot <= 0n) throw new Error("bad pot");
  const rate = Number(feeRateGrainsPerVByte);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("bad fee rate");
  const vBytes = settleSpendVBytes({ settleScriptLen, controlLen });
  const fee = BigInt(Math.ceil(vBytes * rate));
  const payout = pot - fee;
  if (payout < BigInt(DUST_GRAIN)) {
    throw new Error(`settle uneconomic: ${pot} grains in, ${fee}-grain fee leaves < dust (${DUST_GRAIN}) for the winner`);
  }
  return { pot, fee, payout, vBytes, feeRateGrainsPerVByte: rate };
}

/* ------------------------------------------------------------------ */
/* Settle bundle — unsigned JSON coordination between winner and loser  */
/* ------------------------------------------------------------------ */

function canonicalBundle(b) {
  return JSON.stringify({
    kind: SETTLE_BUNDLE_KIND, version: SETTLE_BUNDLE_VERSION,
    descriptor: b.descriptor,
    commitment: b.commitment, secret: b.secret || null,
    game: b.game, bet: b.bet, roundId: b.roundId,
    winner: b.winner, winnerAddress: b.winnerAddress,
    winnerProgramHex: b.winnerProgramHex,
    inputs: b.inputs, outputs: b.outputs,
    feeGrains: b.feeGrains, vBytes: b.vBytes,
    feeRateGrainsPerVByte: b.feeRateGrainsPerVByte,
    timeoutHeight: b.timeoutHeight,
  });
}

export function settleBundleFingerprint(b) {
  return bytesToHex(sha256(utf8(canonicalBundle(b)))).slice(0, 16);
}

/**
 * Build the unsigned settle bundle. The winner (or anyone) proposes; the
 * loser imports, re-verifies everything independently, then signs.
 */
export function buildSettleBundle({
  network, gameParams, commitmentHex, secretHex,
  fundingDealer, fundingPlayer, winnerAddress, feeRateGrainsPerVByte,
}) {
  const gp = gameParams;
  const dealerEscrow = escrowFor({ network, dealerXOnly: gp.dealerXOnly, playerXOnly: gp.playerXOnly,
    game: gp.game, bet: gp.bet, stakeDealerGrains: gp.stakeDealerGrains,
    stakePlayerGrains: gp.stakePlayerGrains, timeoutHeight: gp.timeoutHeight,
    roundId: gp.roundId, depositor: "dealer" });
  const playerEscrow = escrowFor({ network, dealerXOnly: gp.dealerXOnly, playerXOnly: gp.playerXOnly,
    game: gp.game, bet: gp.bet, stakeDealerGrains: gp.stakeDealerGrains,
    stakePlayerGrains: gp.stakePlayerGrains, timeoutHeight: gp.timeoutHeight,
    roundId: gp.roundId, depositor: "player" });
  const fd = fundingDealer, fp = fundingPlayer;
  for (const [f, esc, role, stake] of [
    [fd, dealerEscrow, "dealer", gp.stakeDealerGrains],
    [fp, playerEscrow, "player", gp.stakePlayerGrains],
  ]) {
    if (!/^[0-9a-f]{64}$/i.test(f?.txid || "")) throw new Error(`settle: bad ${role} funding txid`);
    if (!Number.isInteger(f?.vout) || f.vout < 0) throw new Error(`settle: bad ${role} funding vout`);
    if (!f?._skipAddr && String(f?.address || "").trim() !== esc.address) {
      throw new Error(`settle: ${role} funding address does not match the re-derived escrow address — refusing`);
    }
    if (BigInt(f.value) !== BigInt(stake)) {
      throw new Error(`settle: ${role} funded ${f.value} grains but the stake is ${stake} — refusing (settle math would break)`);
    }
  }
  // The winner must be whoever the revealed secret actually scores.
  const scored = revealAndScore({
    secretHex, commitmentHex, roundId: gp.roundId, game: gp.game, bet: gp.bet,
  });
  const winnerProgram = addressToProgram(winnerAddress, network);
  const plan = planSettle({
    stakeDealerGrains: gp.stakeDealerGrains, stakePlayerGrains: gp.stakePlayerGrains,
    settleScriptLen: hexToBytes(dealerEscrow.settleScriptHex).length,
    controlLen: 65, feeRateGrainsPerVByte,
  });
  const inputs = [
    { depositor: "dealer", txid: fd.txid.toLowerCase(), vout: fd.vout, value: Number(gp.stakeDealerGrains), spkHex: dealerEscrow.spkHex, controlBlockHex: dealerEscrow.settleControlBlockHex },
    { depositor: "player", txid: fp.txid.toLowerCase(), vout: fp.vout, value: Number(gp.stakePlayerGrains), spkHex: playerEscrow.spkHex, controlBlockHex: playerEscrow.settleControlBlockHex },
  ];
  const outputs = [{ program: winnerProgram, value: Number(plan.payout) }];
  const settleScript = hexToBytes(dealerEscrow.settleScriptHex);
  const digests = inputs.map((inp, i) => bytesToHex(batchScriptPathSigDigest(
    network,
    inputs.map((x) => ({ txid: x.txid, vout: x.vout, value: x.value, spk: hexToBytes(x.spkHex) })),
    outputs, settleScript, { inputIdx: i },
  )));
  const bundle = {
    kind: SETTLE_BUNDLE_KIND, version: SETTLE_BUNDLE_VERSION,
    descriptor: gp.descriptor,
    commitment: String(commitmentHex).toLowerCase(),
    secret: String(secretHex).toLowerCase(),
    game: gp.game, bet: gp.bet, roundId: gp.roundId,
    outcome: scored.outcome, winner: scored.winner,
    winnerAddress, winnerProgramHex: bytesToHex(winnerProgram),
    inputs, digests,
    outputs: [{ address: winnerAddress, value: Number(plan.payout) }],
    feeGrains: Number(plan.fee), vBytes: plan.vBytes,
    feeRateGrainsPerVByte: plan.feeRateGrainsPerVByte,
    timeoutHeight: gp.timeoutHeight,
    partialSigs: [],
  };
  bundle.fingerprint = settleBundleFingerprint(bundle);
  return bundle;
}

/** Parse + fully re-verify an imported bundle. Returns the canonical bundle. */
export function parseSettleBundle(json, network) {
  let b;
  try { b = JSON.parse(String(json)); }
  catch { throw new Error("settle bundle is not valid JSON"); }
  if (b?.kind !== SETTLE_BUNDLE_KIND || b?.version !== SETTLE_BUNDLE_VERSION) {
    throw new Error("not a pearl-games settle bundle (kind/version mismatch)");
  }
  const gp = gameFromDescriptor(b.descriptor, network);
  if (settleBundleFingerprint(b) !== String(b.fingerprint || "").toLowerCase()) {
    throw new Error("settle bundle fingerprint mismatch — tampered or corrupted. Refusing.");
  }
  // Re-derive the escrow addresses and re-check every funding input.
  const rebuilt = buildSettleBundle({
    network, gameParams: gp,
    commitmentHex: b.commitment, secretHex: b.secret,
    fundingDealer: { txid: b.inputs[0].txid, vout: b.inputs[0].vout, value: b.inputs[0].value, address: null, _skipAddr: true },
    fundingPlayer: { txid: b.inputs[1].txid, vout: b.inputs[1].vout, value: b.inputs[1].value, address: null, _skipAddr: true },
    winnerAddress: b.winnerAddress, feeRateGrainsPerVByte: b.feeRateGrainsPerVByte,
  });
  // Compare the security-critical fields (funding address check is skipped on
  // rebuild because the bundle carries the already-verified inputs verbatim).
  const norm = (x) => JSON.stringify(x);
  for (const k of ["descriptor", "commitment", "secret", "game", "bet", "roundId", "outcome", "winner", "winnerAddress", "feeGrains", "vBytes", "feeRateGrainsPerVByte", "timeoutHeight"]) {
    if (norm(b[k]) !== norm(rebuilt[k])) throw new Error(`settle bundle: field ${k} does not re-derive — refusing`);
  }
  if (norm(b.digests) !== norm(rebuilt.digests)) throw new Error("settle bundle: sighash digests do not re-derive — refusing");
  // Winner sanity: the scored winner must match.
  if (b.winner !== rebuilt.winner) throw new Error("settle bundle: winner contradicts the revealed secret — refusing");
  // Verify every collected partial signature against its input digests.
  const allowed = new Set([gp.dealerXOnly, gp.playerXOnly]);
  const seen = new Set();
  for (const ps of b.partialSigs || []) {
    const key = String(ps?.key || "").toLowerCase();
    if (!allowed.has(key)) throw new Error("settle bundle: signature from a key that is neither dealer nor player");
    if (seen.has(key)) throw new Error("settle bundle: duplicate signer");
    seen.add(key);
    if (!Array.isArray(ps?.sigs) || ps.sigs.length !== 2) throw new Error("settle bundle: bad sig list");
    ps.sigs.forEach((sig, i) => {
      const s = String(sig || "").toLowerCase();
      if (!/^[0-9a-f]{128}$/.test(s)) throw new Error(`settle bundle: input ${i} bad signature encoding`);
      if (!verifySchnorrSig(s, b.digests[i], key)) {
        throw new Error(`settle bundle: input ${i} signature from ${key.slice(0, 12)}… does not verify`);
      }
    });
  }
  return { ...b, fingerprint: String(b.fingerprint).toLowerCase(), _gameParams: gp };
}

/** Sign both settle digests with the dealer's or the player's private key.
 *  Each signature is re-verified before it enters the bundle. */
export function signSettleBundle(bundle, gameParams, privHex) {
  const priv = hexToBytes(String(privHex).trim());
  if (priv.length !== 32) throw new Error("private key must be 32 bytes");
  const key = pubkeyFromPriv(priv);
  const role = key === gameParams.dealerXOnly ? "dealer"
    : key === gameParams.playerXOnly ? "player" : null;
  if (!role) throw new Error("this key is neither the dealer nor the player");
  const existing = (bundle.partialSigs || []).find((ps) => ps.key === key);
  if (existing) throw new Error("this key already signed the settle bundle");
  const sigs = bundle.digests.map((dg, i) => {
    const sig = bytesToHex(signForXOnly(priv, hexToBytes(dg)));
    if (!verifySchnorrSig(sig, dg, key)) {
      throw new Error(`input ${i}: local signature self-check failed — refusing to sign`);
    }
    return sig;
  });
  bundle.partialSigs.push({ key, role, sigs });
  return bundle;
}

/** Signing status: which of the two required keys has signed. */
export function settleBundleStatus(bundle, gameParams) {
  const signers = (bundle.partialSigs || []).map((ps) => ps.key);
  return {
    signers,
    dealerSigned: signers.includes(gameParams.dealerXOnly),
    playerSigned: signers.includes(gameParams.playerXOnly),
    ready: signers.includes(gameParams.dealerXOnly) && signers.includes(gameParams.playerXOnly),
  };
}

/** Serialize the fully-signed 2-input settle tx. Mirrors the audited
 *  buildScriptPathSpend field order, generalized to two inputs. */
export function buildSettleSpend({ network, bundle, gameParams }) {
  const st = settleBundleStatus(bundle, gameParams);
  if (!st.ready) throw new Error("settle bundle needs both signatures before finalizing");
  const dealerSig = bundle.partialSigs.find((ps) => ps.key === gameParams.dealerXOnly).sigs;
  const playerSig = bundle.partialSigs.find((ps) => ps.key === gameParams.playerXOnly).sigs;
  const escD = escrowFor({ network, dealerXOnly: gameParams.dealerXOnly, playerXOnly: gameParams.playerXOnly,
    game: gameParams.game, bet: gameParams.bet, stakeDealerGrains: gameParams.stakeDealerGrains,
    stakePlayerGrains: gameParams.stakePlayerGrains, timeoutHeight: gameParams.timeoutHeight,
    roundId: gameParams.roundId, depositor: "dealer" });
  const escP = escrowFor({ network, dealerXOnly: gameParams.dealerXOnly, playerXOnly: gameParams.playerXOnly,
    game: gameParams.game, bet: gameParams.bet, stakeDealerGrains: gameParams.stakeDealerGrains,
    stakePlayerGrains: gameParams.stakePlayerGrains, timeoutHeight: gameParams.timeoutHeight,
    roundId: gameParams.roundId, depositor: "player" });
  const leafScript = hexToBytes(escD.settleScriptHex);
  const inputs = bundle.inputs.map((inp, i) => ({
    ...inp,
    spk: hexToBytes(inp.spkHex),
    controlBlock: hexToBytes(i === 0 ? escD.settleControlBlockHex : escP.settleControlBlockHex),
    // Witness order for <D> CHECKSIGVERIFY <P> CHECKSIG: [sig_dealer, sig_player].
    stack: [hexToBytes(dealerSig[i]), hexToBytes(playerSig[i])],
  }));
  const outputs = [{ program: hexToBytes(bundle.winnerProgramHex), value: bundle.outputs[0].value }];
  const outs = [];
  for (const o of outputs) {
    const s = p2trScriptPubKey(o.program);
    outs.push(...u64le(o.value), ...varint(s.length), ...s);
  }
  const witSection = [];
  for (const inp of inputs) {
    const items = [...inp.stack, leafScript, inp.controlBlock];
    witSection.push(...varint(items.length));
    for (const it of items) witSection.push(...varint(it.length), ...it);
  }
  const fullTx = [
    ...u32le(network.txVersion), 0x00, 0x01, ...varint(inputs.length),
    ...inputs.flatMap((inp) => [...txidLE(inp.txid), ...u32le(inp.vout), ...varint(0), ...u32le(MAX_SEQ)]),
    ...varint(outputs.length), ...outs,
    ...witSection, ...u32le(0),
  ];
  const base = [
    ...u32le(network.txVersion), ...varint(inputs.length),
    ...inputs.flatMap((inp) => [...txidLE(inp.txid), ...u32le(inp.vout), ...varint(0), ...u32le(MAX_SEQ)]),
    ...varint(outputs.length), ...outs, ...u32le(0),
  ];
  const txid = bytesToHex(dblSha(Uint8Array.from(base)).reverse());
  const vBytes = Math.ceil((base.length * 3 + fullTx.length) / 4);
  if (vBytes !== bundle.vBytes) {
    throw new Error(`settle vBytes mismatch: planner ${bundle.vBytes} vs serializer ${vBytes} — refusing`);
  }
  // Re-derive every digest from the canonical helper and cross-check.
  inputs.forEach((inp, i) => {
    const dg = bytesToHex(batchScriptPathSigDigest(
      network,
      inputs.map((x) => ({ txid: x.txid, vout: x.vout, value: x.value, spk: x.spk })),
      outputs, leafScript, { inputIdx: i },
    ));
    if (dg !== bundle.digests[i].toLowerCase()) throw new Error(`settle: input ${i} digest mismatch on finalize — refusing`);
  });
  return { txid, hex: bytesToHex(Uint8Array.from(fullTx)), vBytes };
}

/* ------------------------------------------------------------------ */
/* Funding — each party pays exactly their stake into their own escrow  */
/* ------------------------------------------------------------------ */

/**
 * Build a keypath funding tx from the party's own wallet UTXO to their
 * escrow address. `utxo` = {txid, vout, value, spkHex} from Blockbook (the
 * party's own P2TR UTXO); `key` = gameKeyFromInput result with priv.
 * Change returns to the party's own address; dust change is absorbed into
 * the fee and disclosed (same honesty rule as the other builder apps).
 */
export function buildFundingTx({ network, utxo, key, escrow, feeRateGrainsPerVByte }) {
  if (!key.priv) throw new Error("funding needs the private key (mnemonic/WIF) — an x-only pubkey cannot sign");
  verifyEscrowAddress(escrow);
  const stake = BigInt(escrow.stakeGrains);
  const rate = Number(feeRateGrainsPerVByte);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("bad fee rate");
  const inVal = BigInt(utxo.value);
  // 1-in, up-to-2-out keypath: fee from the audited keypathTxVBytes.
  const vBytes2 = keypathTxVBytes(1, 2);
  const vBytes1 = keypathTxVBytes(1, 1);
  let fee = BigInt(Math.ceil(vBytes2 * rate));
  let change = inVal - stake - fee;
  let nOut = 2;
  if (change < BigInt(DUST_GRAIN)) {
    // Dust change absorbed into the fee — disclosed, never silently dropped.
    fee = inVal - stake;
    change = 0n;
    nOut = 1;
  }
  if (fee <= 0n || inVal < stake + fee) {
    throw new Error(`funding uneconomic: UTXO ${inVal} grains cannot cover the ${stake}-grain stake plus fee`);
  }
  const escrowProgram = hexToBytes(escrow.spkHex).slice(2); // strip 0x5120
  const ownProgram = hexToBytes(key.xonly);
  const outputs = [{ program: escrowProgram, value: Number(stake) }];
  if (nOut === 2) outputs.push({ program: ownProgram, value: Number(change) });
  const spend = buildKeypathTx(network, [{
    txid: utxo.txid, vout: utxo.vout, value: Number(inVal),
    priv: key.priv, internalXOnly: hexToBytes(key.xonly),
  }], outputs);
  const expectVBytes = nOut === 2 ? vBytes2 : vBytes1;
  // keypathTxVBytes is exact for this shape; cross-check the serializer.
  return {
    txid: spend.txid, hex: spend.hex,
    feeGrains: Number(fee), changeGrains: Number(change),
    dustAbsorbed: nOut === 1,
    escrowAddress: escrow.address, stakeGrains: stake.toString(),
  };
}

/* ------------------------------------------------------------------ */
/* Refund — unilateral post-timeout claim of your own deposit           */
/* ------------------------------------------------------------------ */

/** vBytes for a single-input refund spend via the refund leaf. */
export function refundSpendVBytes({ refundScriptLen, controlLen }) {
  const stackLens = [64]; // sig
  const varintLen = (n) => (n < 0xfd ? 1 : n <= 0xffff ? 3 : n <= 0xffffffff ? 5 : 9);
  let wit = varintLen(stackLens.length + 2);
  for (const l of stackLens) wit += varintLen(l) + l;
  wit += varintLen(refundScriptLen) + refundScriptLen + varintLen(controlLen) + controlLen;
  const base = 4 + 1 + 41 + 1 + 1 * 43 + 4;
  return Math.ceil((base * 3 + (base + 2 + wit)) / 4);
}

/**
 * Build + sign a unilateral refund of the depositor's own deposit.
 * Refuses loudly before the timeout; refuses if the funding address is not
 * the depositor's own re-derived escrow address (wrong-depositor guard).
 */
export function buildRefundTx({ network, gameParams, depositor, funding, depositorAddress, privHex, feeRateGrainsPerVByte, tipHeight }) {
  const gp = gameParams;
  if (depositor !== "dealer" && depositor !== "player") throw new Error("depositor must be 'dealer' or 'player'");
  if (!Number.isSafeInteger(tipHeight) || tipHeight < 0) throw new Error("need the chain tip height to check maturity");
  if (tipHeight < gp.timeoutHeight) {
    throw new Error(`refund not mature: timeout is block ${gp.timeoutHeight}, chain is at ${tipHeight}. Refusing.`);
  }
  const escrow = escrowFor({ network, dealerXOnly: gp.dealerXOnly, playerXOnly: gp.playerXOnly,
    game: gp.game, bet: gp.bet, stakeDealerGrains: gp.stakeDealerGrains,
    stakePlayerGrains: gp.stakePlayerGrains, timeoutHeight: gp.timeoutHeight,
    roundId: gp.roundId, depositor });
  verifyEscrowAddress(escrow);
  if (String(funding.address || "").trim() !== escrow.address) {
    throw new Error("refund: this funding does not belong to your escrow address — refusing (wrong-depositor guard)");
  }
  const stake = BigInt(depositor === "dealer" ? gp.stakeDealerGrains : gp.stakePlayerGrains);
  if (BigInt(funding.value) !== stake) throw new Error("refund: funding value does not match the stake — refusing");
  const priv = hexToBytes(String(privHex).trim());
  if (priv.length !== 32) throw new Error("private key must be 32 bytes");
  const key = pubkeyFromPriv(priv);
  const expectX = depositor === "dealer" ? gp.dealerXOnly : gp.playerXOnly;
  if (key !== expectX) throw new Error("this key is not the depositor's key — refusing");
  const refundScript = hexToBytes(escrow.refundScriptHex);
  const vBytes = refundSpendVBytes({ refundScriptLen: refundScript.length, controlLen: 65 });
  const fee = BigInt(Math.ceil(vBytes * Number(feeRateGrainsPerVByte)));
  const payment = stake - fee;
  if (payment < BigInt(DUST_GRAIN)) {
    throw new Error(`refund uneconomic: ${stake} grains in, ${fee}-grain fee leaves < dust (${DUST_GRAIN})`);
  }
  const program = addressToProgram(depositorAddress, network);
  const outputs = [{ program, value: Number(payment) }];
  const input = { txid: funding.txid.toLowerCase(), vout: funding.vout, value: Number(stake), spk: hexToBytes(escrow.spkHex) };
  const digest = batchScriptPathSigDigest(
    network, [input], outputs, refundScript, { inputIdx: 0, sequence: NONFINAL_SEQ, locktime: gp.timeoutHeight },
  );
  const sig = bytesToHex(signForXOnly(priv, digest));
  if (!verifySchnorrSig(sig, bytesToHex(digest), key)) {
    throw new Error("local refund signature self-check failed — refusing to emit transaction hex");
  }
  // Serialize: single input, witness [sig, refundScript, controlBlock].
  const controlBlock = hexToBytes(escrow.refundControlBlockHex);
  const s = p2trScriptPubKey(program);
  const witItems = [hexToBytes(sig), refundScript, controlBlock];
  const witSection = [...varint(witItems.length)];
  for (const it of witItems) witSection.push(...varint(it.length), ...it);
  const base = [
    ...u32le(network.txVersion), ...varint(1),
    ...txidLE(input.txid), ...u32le(input.vout), ...varint(0), ...u32le(NONFINAL_SEQ),
    ...varint(1), ...u64le(Number(payment)), ...varint(s.length), ...s,
    ...u32le(gp.timeoutHeight),
  ];
  const fullTx = [
    ...u32le(network.txVersion), 0x00, 0x01, ...varint(1),
    ...txidLE(input.txid), ...u32le(input.vout), ...varint(0), ...u32le(NONFINAL_SEQ),
    ...varint(1), ...u64le(Number(payment)), ...varint(s.length), ...s,
    ...witSection, ...u32le(gp.timeoutHeight),
  ];
  const serVBytes = Math.ceil((base.length * 3 + fullTx.length) / 4);
  if (serVBytes !== vBytes) throw new Error(`refund vBytes mismatch: planner ${vBytes} vs serializer ${serVBytes} — refusing`);
  return {
    txid: bytesToHex(dblSha(Uint8Array.from(base)).reverse()),
    hex: bytesToHex(Uint8Array.from(fullTx)),
    fee: Number(fee), vBytes, payment: Number(payment),
    locktime: gp.timeoutHeight, depositor,
    refundAddress: depositorAddress,
  };
}

/* ------------------------------------------------------------------ */
/* Solo practice — the full protocol against a local dealer, no PRL     */
/* ------------------------------------------------------------------ */

/** One practice round: commit -> bet -> reveal -> verify, all local. */
export function practiceRound({ game, bet }) {
  const g = parseGame(game);
  const b = parseBet(game, bet);
  const rb = new Uint8Array(4);
  globalThis.crypto.getRandomValues(rb);
  const roundId = bytesToHex(rb);
  const secret = newSecret();
  const commitment = commitmentFor(secret);
  // The "dealer" has now committed. The player bets (already chosen).
  const scored = revealAndScore({ secretHex: secret, commitmentHex: commitment, roundId, game: g.id, bet: b });
  return {
    game: g.id, gameName: g.name, bet: b, roundId,
    secret, commitment,
    commitmentVerified: true,
    outcome: scored.outcome, winner: scored.winner,
    note: "Practice round — local dealer, no PRL moved. The commitment was fixed before the bet and verified after.",
  };
}

/** Standalone verifier: PROVEN or loud NOT PROVEN. */
export function verifyGameTranscript({ descriptor, commitmentHex, secretHex }) {
  const problems = [];
  let gp = null;
  try { gp = gameFromDescriptor(descriptor, NETWORKS.mainnet); }
  catch (e) { try { gp = gameFromDescriptor(descriptor, NETWORKS.testnet); } catch { problems.push("descriptor: " + e.message); } }
  if (gp && !verifyReveal(secretHex, commitmentHex)) {
    problems.push("the revealed secret does not match the dealer's commitment");
  }
  if (problems.length) return { proven: false, problems, game: gp };
  const outcome = outcomeFor({ secretHex, roundId: gp.roundId, game: gp.game });
  return {
    proven: true, game: gp, outcome,
    winner: winnerFor({ game: gp.game, bet: gp.bet, outcome }),
    problems: [],
  };
}

/* ------------------------------------------------------------------ */
/* Blockbook helpers (GET-only)                                         */
/* ------------------------------------------------------------------ */

/** Find the funding UTXO(s) paying exactly the stake into an escrow address. */
export async function findFunding({ blockbookUrl, escrow, stakeGrains }) {
  const url = `${String(blockbookUrl).replace(/\/+$/, "")}/api/v2/address/${escrow.address}?details=txs`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`blockbook address lookup failed (HTTP ${res.status})`);
  const data = await res.json();
  const stake = BigInt(stakeGrains);
  const hits = [];
  for (const tx of data.transactions || []) {
    const vout = (tx.vout || []).findIndex((o) => o?.addresses?.includes(escrow.address) && BigInt(o.value || 0) === stake);
    if (vout >= 0) hits.push({ txid: tx.txid, vout, value: stake.toString(), confirmations: tx.confirmations ?? 0 });
  }
  return hits;
}

/** Current chain tip height via GET-only Blockbook status. */
export async function fetchTipHeight(blockbookUrl) {
  const url = `${String(blockbookUrl).replace(/\/+$/, "")}/api/status`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`blockbook status failed (HTTP ${res.status})`);
  const data = await res.json();
  const h = data?.backend?.blocks;
  if (!Number.isSafeInteger(h)) throw new Error("blockbook did not report a tip height");
  return h;
}
