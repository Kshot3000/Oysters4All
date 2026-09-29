// Pearl Raffle core: provably-fair PRL raffle manager.
//
// There are NO smart contracts on Pearl, so fairness here is an off-chain
// commitment protocol, enforced by public verification rather than code:
//
//   1. Forge: the organizer commits to (prize, settlement block height,
//      entries) in a tamper-evident descriptor. entriesHash = SHA-256 over the
//      canonical sorted entry lines, so any post-hoc edit changes the hash.
//      The descriptor must be PUBLISHED before the settlement block.
//   2. Draw: once the settlement block exists, the winner is
//        winnerIndex = uint256(SHA-256("raffle-draw:v1:<descriptorHash>:<blockHash>:<round>"))
//                      mod totalTickets
//      mapped onto the weighted ticket ranges of the sorted entries.
//      The block hash is the unpredictable beacon; rounds re-draw excluding
//      prior winners.
//   3. Verify: anyone with (descriptor, entries, block hash) re-runs the
//      whole draw locally. A tampered entry list is refused loudly.
//   4. Payout: the organizer keeps custody; the app builds a payout plan
//      (winner address + exact grains), CSV export, and pearl: payment URIs
//      with QR codes. It never moves PRL itself.
//
// Reuses the audited Pearl Sign crypto (bech32m, sha256, PRL units) — no new
// cryptography is introduced here.
import {
  NETWORKS, GRAIN_PER_PRL, DUST_GRAIN,
  decodeBech32m, encodeBech32m,
  sha256, bytesToHex, hexToBytes,
} from "../../sign/src/crypto.js";
import { fmtPRL, parsePRL } from "../../sign/src/sign-core.js";

export {
  NETWORKS, GRAIN_PER_PRL, DUST_GRAIN,
  fmtPRL, parsePRL,
  decodeBech32m, encodeBech32m, bytesToHex, hexToBytes,
};

/** Max entries per raffle (sanity bound). */
export const MAX_ENTRIES = 100000;

/** Max prize rounds per draw. */
export const MAX_ROUNDS = 3;

/** Settlement height must be this many blocks above the chain tip seen at
 *  forge time (~10 minutes at the 194 s block target), so the commitment
 *  provably predates the beacon block. */
export const MIN_SETTLE_LEAD = 3;

/** Pearl block target time, seconds (node/chaincfg/params.go). */
export const BLOCK_TARGET_S = 194;

const utf8 = (s) => new TextEncoder().encode(String(s));
const sha256Hex = (s) => bytesToHex(sha256(utf8(s)));

/* ================= entries ================= */

function parseEntryLine(line, lineNo, network) {
  const parts = line.replace(/,/g, " ").split(/\s+/).filter(Boolean);
  if (parts.length < 2) throw new Error(`line ${lineNo}: need "<address> <tickets>", got: ${line}`);
  if (parts.length > 2) throw new Error(`line ${lineNo}: too many fields: ${line}`);
  const [addr, ticketsS] = parts;
  let dec;
  try { dec = decodeBech32m(addr, network.hrp); }
  catch { throw new Error(`line ${lineNo}: not a valid ${network.hrp}1 address: ${addr}`); }
  if (dec.version !== 1 || dec.program.length !== 32) {
    throw new Error(`line ${lineNo}: address must be a Pearl v1 (Taproot) address`);
  }
  if (!/^\d+$/.test(ticketsS)) throw new Error(`line ${lineNo}: tickets must be a positive whole number, got: ${ticketsS}`);
  const tickets = BigInt(ticketsS);
  if (tickets <= 0n) throw new Error(`line ${lineNo}: tickets must be positive`);
  const canonical = encodeBech32m(network.hrp, 1, dec.program);
  return { address: canonical, program: dec.program, tickets };
}

/** Parse an entry list (textarea paste or CSV import): one
 *  `<address> <tickets>` per line, comma- or whitespace-separated.
 *  Duplicate addresses merge (tickets summed). Returns
 *  { entries: [{address, program, tickets}], totalTickets, merged }. */
export function parseEntries(text, network = NETWORKS.mainnet) {
  const lines = String(text ?? "").split(/\r?\n/).map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  if (lines.length === 0) throw new Error("no entries — paste one \"<address> <tickets>\" per line, or import a CSV");
  if (lines.length > MAX_ENTRIES) throw new Error(`too many entry lines (max ${MAX_ENTRIES})`);
  const parsed = lines.map((l, i) => parseEntryLine(l, i + 1, network));
  const byAddr = new Map();
  let merged = 0;
  for (const e of parsed) {
    if (byAddr.has(e.address)) {
      byAddr.get(e.address).tickets += e.tickets;
      merged++;
    } else {
      byAddr.set(e.address, { address: e.address, program: e.program, tickets: e.tickets });
    }
  }
  const entries = [...byAddr.values()];
  const totalTickets = entries.reduce((a, e) => a + e.tickets, 0n);
  return { entries, totalTickets, merged };
}

/** Canonical commitment encoding: `address tickets` lines sorted ascending
 *  by address, joined with \n. Changing any entry, ticket count, or ordering
 *  changes the hash. */
export function canonicalEntries(entries) {
  const sorted = [...entries].sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
  return sorted.map((e) => `${e.address} ${e.tickets.toString()}`).join("\n");
}

export function entriesHashOf(entries) {
  return sha256Hex(canonicalEntries(entries));
}

/** Downloadable sample entry list (replace the addresses + tickets). */
export function sampleRaffleCsv() {
  return [
    "# Pearl Raffle sample — one \"<address> <tickets>\" per line",
    "# address = Pearl v1 (Taproot) prl1… address · tickets = whole entry counts",
    "# commas work too: <address>,<tickets> · lines starting with # are ignored",
    "# duplicates merge (tickets summed); ordering does not matter",
    "prl1pr6yuq8u2r95wjzzgpdy8cpnncpl7l8zgy6x5q0367pnc53s2famqg7pt74 10",
    "prl1p7dwp74zgd4te3mqr58d6x3p3t70jljmpe4auey8g824ra4x43tks3y4pr6 5",
    "prl1p5gfau0gepxzjkjyx9t88ewnhujrmpjqgqfh8v9vympjaz94x36jqpepvyt 1",
  ].join("\n") + "\n";
}

/* ================= descriptor ================= */

const DESCRIPTOR_RE = /^raffle:v1:([a-z0-9]+):(\d+):(\d+):([0-9a-f]{64}):(\d+)$/;

/** Parse a raffle descriptor. Throws on any malformed field. */
export function parseDescriptor(s) {
  const t = String(s ?? "").trim();
  const m = t.match(DESCRIPTOR_RE);
  if (!m) throw new Error("not a raffle descriptor — expected raffle:v1:<hrp>:<prizeGrains>:<settleHeight>:<entriesHash>:<n>");
  const [, hrp, prizeS, heightS, hash, nS] = m;
  const network = Object.values(NETWORKS).find((n) => n.hrp === hrp);
  if (!network) throw new Error(`unknown network hrp "${hrp}"`);
  const prizeGrains = BigInt(prizeS);
  const settleHeight = Number(heightS);
  const n = Number(nS);
  if (!Number.isSafeInteger(settleHeight) || settleHeight <= 0) throw new Error("settle height must be a positive integer");
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error("entry count must be a positive integer");
  return {
    hrp, network, prizeGrains, settleHeight,
    entriesHash: hash, n,
    descriptor: t,
    descriptorHash: sha256Hex(t),
  };
}

/** Forge a raffle: validate everything, commit to the entries, and return the
 *  descriptor. Requires the current chain tip (Blockbook or manual) so the
 *  settle height is provably in the future by at least MIN_SETTLE_LEAD.
 *  Throws instead of forging anything ambiguous. */
export function forgeRaffle({ network = NETWORKS.mainnet, prizeGrains, settleHeight, entries, currentHeight }) {
  if (typeof prizeGrains !== "bigint") throw new Error("prize must be a grain amount (BigInt)");
  if (prizeGrains <= 0n) throw new Error("prize must be positive");
  if (prizeGrains < BigInt(DUST_GRAIN)) {
    throw new Error(`prize of ${fmtPRL(prizeGrains)} PRL is below the ${fmtPRL(DUST_GRAIN)} PRL dust floor — a prize must be payable on-chain`);
  }
  if (!Number.isSafeInteger(settleHeight) || settleHeight <= 0) {
    throw new Error("settlement height must be a positive integer block height");
  }
  if (currentHeight == null) throw new Error("need the current chain height (Blockbook or manual) to prove the settlement block is in the future");
  if (!Number.isSafeInteger(currentHeight) || currentHeight < 0) throw new Error("current height must be a non-negative integer");
  if (settleHeight <= currentHeight) {
    throw new Error(`settlement height ${settleHeight} is at or behind the chain tip ${currentHeight} — the beacon block must be in the future`);
  }
  if (settleHeight <= currentHeight + MIN_SETTLE_LEAD) {
    throw new Error(`settlement height ${settleHeight} is only ${settleHeight - currentHeight} block(s) ahead of the tip — needs at least ${MIN_SETTLE_LEAD + 1} blocks of lead so the commitment provably predates the beacon`);
  }
  if (!Array.isArray(entries) || entries.length === 0) throw new Error("no entries to raffle");
  if (entries.length > MAX_ENTRIES) throw new Error(`too many entries (max ${MAX_ENTRIES})`);
  const totalTickets = entries.reduce((a, e) => a + e.tickets, 0n);
  if (totalTickets <= 0n) throw new Error("total tickets must be positive");
  const eh = entriesHashOf(entries);
  const n = entries.length;
  const descriptor = `raffle:v1:${network.hrp}:${prizeGrains.toString()}:${settleHeight}:${eh}:${n}`;
  return {
    descriptor,
    descriptorHash: sha256Hex(descriptor),
    entriesHash: eh,
    canonical: canonicalEntries(entries),
    prizeGrains, settleHeight, n, totalTickets,
    network,
  };
}

/* ================= draw ================= */

/** uint256 big-endian bytes -> BigInt. */
export function bytesToBigIntBE(b) {
  let v = 0n;
  for (const byte of b) v = (v << 8n) | BigInt(byte);
  return v;
}

/** Draw one round. Entries exclude prior winners; tickets are re-totaled.
 *  preimage = "raffle-draw:v1:<descriptorHash>:<blockHash>:<round>" (utf8).
 *  Returns { round, preimage, drawHex, drawInt, index, winner, totalTickets,
 *  eligible } — the full derivation, hand re-verifiable with any SHA-256. */
export function drawRound({ entries, descriptorHash, blockHash, round }) {
  const bh = String(blockHash ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(bh)) throw new Error("block hash must be 64 hex characters");
  if (!/^[0-9a-f]{64}$/.test(descriptorHash)) throw new Error("descriptor hash must be 64 hex characters");
  if (!Number.isInteger(round) || round < 0 || round >= MAX_ROUNDS) throw new Error(`round must be 0–${MAX_ROUNDS - 1}`);
  if (!Array.isArray(entries) || entries.length === 0) throw new Error("no eligible entries left to draw");
  const totalTickets = entries.reduce((a, e) => a + e.tickets, 0n);
  if (totalTickets <= 0n) throw new Error("no tickets left to draw");
  const preimage = `raffle-draw:v1:${descriptorHash}:${bh}:${round}`;
  const drawBytes = sha256(utf8(preimage));
  const drawHex = bytesToHex(drawBytes);
  const drawInt = bytesToBigIntBE(drawBytes);
  const index = drawInt % totalTickets;
  const sorted = [...entries].sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
  let lo = 0n, winner = null, range = null;
  for (const e of sorted) {
    const hi = lo + e.tickets;
    if (index >= lo && index < hi) { winner = e; range = { lo, hi }; break; }
    lo = hi;
  }
  if (!winner) throw new Error("draw mapping failed — this should never happen");
  return { round, preimage, drawHex, drawInt, index, winner, winnerRange: range, totalTickets, eligible: entries.length };
}

/** Full multi-round draw: rounds re-draw excluding prior winners.
 *  Returns { rounds: [drawRound…], winners: [entry…] }. */
export function drawRaffle({ descriptor, entries, blockHash, rounds = 1 }) {
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > MAX_ROUNDS) {
    throw new Error(`rounds must be 1–${MAX_ROUNDS}`);
  }
  const d = parseDescriptor(descriptor);
  if (entries.length !== d.n) {
    throw new Error(`entry list has ${entries.length} entries but the descriptor commits to ${d.n} — refused`);
  }
  if (entriesHashOf(entries) !== d.entriesHash) {
    throw new Error("LOUD REFUSAL: the entry list does not match the descriptor's entriesHash — the commitment was altered after forging. Will not draw.");
  }
  if (rounds > entries.length) {
    throw new Error(`cannot draw ${rounds} prize rounds from ${entries.length} entries — need at least one entry per round`);
  }
  const roundResults = [];
  const winners = [];
  let eligible = [...entries];
  for (let r = 0; r < rounds; r++) {
    const res = drawRound({ entries: eligible, descriptorHash: d.descriptorHash, blockHash, round: r });
    roundResults.push(res);
    winners.push(res.winner);
    eligible = eligible.filter((e) => e.address !== res.winner.address);
  }
  return { descriptor: d, rounds: roundResults, winners, prizeGrains: d.prizeGrains, settleHeight: d.settleHeight };
}

/** Standalone verifier: same as drawRaffle, but returns the full evidence
 *  bundle and never swallows a mismatch. */
export function verifyDraw({ descriptor, entriesText, blockHash, rounds = 1, network = NETWORKS.mainnet }) {
  const d = parseDescriptor(descriptor);
  const { entries, totalTickets } = parseEntries(entriesText, d.network);
  const drawn = drawRaffle({ descriptor: d.descriptor, entries, blockHash, rounds });
  return {
    descriptor: d,
    commitmentOk: true,
    canonical: canonicalEntries(entries),
    totalTickets,
    ...drawn,
  };
}

/* ================= payout ================= */

/** Split the prize across rounds: floor(prize/rounds) each; the remainder
 *  grains go to round 1. Exact accounting: rows sum to prizeGrains. */
export function buildPayoutPlan({ winners, prizeGrains, rounds }) {
  if (!Array.isArray(winners) || winners.length === 0) throw new Error("no winners — draw first");
  if (winners.length !== rounds) throw new Error(`winner count (${winners.length}) != rounds (${rounds})`);
  const perRound = prizeGrains / BigInt(rounds);
  const remainder = prizeGrains % BigInt(rounds);
  const rows = winners.map((w, i) => ({
    round: i + 1,
    address: w.address,
    grains: perRound + (i === 0 ? remainder : 0n),
    prl: fmtPRL(perRound + (i === 0 ? remainder : 0n)),
  }));
  const total = rows.reduce((a, r) => a + r.grains, 0n);
  if (total !== prizeGrains) throw new Error("payout accounting failed — this should never happen");
  return { rows, total, perRound, remainder };
}

export function payoutCsv(plan) {
  const lines = ["round,address,grains,prl"];
  for (const r of plan.rows) lines.push(`${r.round},${r.address},${r.grains.toString()},${r.prl}`);
  return lines.join("\n") + "\n";
}

/** pearl: payment URI (BIP-21 style) for one payout row. */
export function paymentUri(address, grains) {
  return `pearl:${address}?amount=${fmtPRL(grains)}`;
}

/* ================= blockbook (read-only chain data) ================= */

async function bbGet(base, path) {
  const r = await fetch(String(base).replace(/\/+$/, "") + path);
  if (!r.ok) throw new Error(`blockbook ${r.status} on ${path}`);
  return r.json();
}

/** Current chain tip height. */
export async function fetchTipHeight(blockbookBase) {
  const info = await bbGet(blockbookBase, "/api/v2");
  const h = info?.backend?.blocks ?? info?.blockbook?.bestHeight;
  if (!Number.isInteger(h) || h < 0) throw new Error("blockbook did not return a chain tip");
  return h;
}

/** Block hash at a mined height. Throws if the height is not mined yet. */
export async function fetchBlockHashAtHeight(blockbookBase, height) {
  const idx = await bbGet(blockbookBase, `/api/v2/block-index/${height}`);
  if (!idx?.blockHash) throw new Error(`no block at height ${height} — not mined yet or bad endpoint`);
  return String(idx.blockHash).toLowerCase();
}
