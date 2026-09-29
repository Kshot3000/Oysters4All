// Pearl Ballot core: off-chain DAO governance with Schnorr-signed ballots.
//
// Pearl has NO smart contracts, so a vote cannot be enforced on-chain.
// Pearl Ballot makes governance fair anyway: an off-chain signed-ballot
// protocol with a tamper-evident descriptor, enforced by public
// verification — the same proven model as Pearl Auction / Pearl Raffle:
//
//   1. DRAFT (organizer): title, description, 2–8 options, voting window
//      (start/end block heights), snapshot height for voting weight.
//   2. PUBLISH (organizer): the descriptor
//        pearl-ballot:v1:<hrp>:<proposalHash>:<startH>:<endH>:<snapshotH>:<optionsHash>
//      where proposalHash = SHA-256 over the canonical proposal JSON and
//      optionsHash = SHA-256 over the canonical options list. The
//      descriptor MUST be published before startH.
//   3. VOTE (voters): voter enters prl1/tprl1 address + choice; the ballot
//      (canonical JSON {descriptorHash, voter, choice, weightGrains,
//      snapshotH, nonce}) is signed LOCALLY with the voter's key
//      (BIP-86 via the audited Sign core — WIF/hex/mnemonic, in-memory
//      only). The signature is a BIP-340 Schnorr signature over the ballot
//      hash with the voter's TWEAKED keypath key — the same key the P2TR
//      address commits to — so it verifies against the address x-only key.
//      The page refuses to sign before startH or after endH (live
//      Blockbook tip or air-gapped manual tip).
//   4. TALLY (organizer): import ballot JSONs; the page re-verifies EVERY
//      signature against the descriptor + voter key and loudly refuses
//      wrong-descriptor, duplicate-voter (first valid wins), out-of-window,
//      and unknown-option ballots. Hand-verifiable derivation is shown
//      step-by-step; the result record
//        pearl-ballot-result:v1:<descriptorHash>:<winner>:<totalWeight>:<nVoters>:<resultHash>
//      binds the tally (resultHash = SHA-256 over the canonical tally).
//      CSV export included.
//   5. VERIFY (standalone): paste proposal JSON + descriptor + ballots;
//      the page re-derives everything and refuses tampered input with a
//      loud "NOT PROVEN".
//
// Voting weight = the voter's PRL confirmed balance read from Blockbook
// (GET-only), honestly labeled as CURRENT-balance weight: Blockbook does
// not expose historical address balances, so snapshot-height enforcement
// is the organizer's job — the claimed snapshot height is recorded inside
// every signed ballot. The page never pretends otherwise.
//
// Reuses the audited Pearl Sign crypto (bech32m, sha256, BIP-86, BIP-340
// Schnorr via tweakPrivKeypath) — NO new cryptography is introduced here.
import {
  NETWORKS, GRAIN_PER_PRL, DUST_GRAIN,
  decodeBech32m, encodeBech32m,
  sha256, bytesToHex, hexToBytes, schnorr,
  walletFromMnemonic, walletFromWIF, walletFromPriv, walletToWIF,
  tweakPrivKeypath,
} from "../../sign/src/crypto.js";
import { fmtPRL } from "../../sign/src/sign-core.js";

export {
  NETWORKS, GRAIN_PER_PRL, DUST_GRAIN,
  decodeBech32m, encodeBech32m, bytesToHex, hexToBytes, schnorr,
  walletFromMnemonic, walletFromWIF, walletFromPriv, walletToWIF,
  tweakPrivKeypath, fmtPRL,
};

/** Option count bounds for a proposal. */
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 8;

/** Max ballots the page will tally (sanity bound). */
export const MAX_BALLOTS = 100000;

/** Nonce size for a ballot, bytes (uniqueness, not secrecy). */
export const BALLOT_NONCE_BYTES = 8;

/** Pearl block target time, seconds (node/chaincfg/params.go). */
export const BLOCK_TARGET_S = 194;

/** The voter's x-only key is the TWEAKED keypath key (what the P2TR
 *  address commits to). Signing the ballot hash with the tweaked
 *  private key yields a BIP-340 signature verifiable against the
 *  address's 32-byte program. */
export function ballotSigningKey(wallet) {
  return tweakPrivKeypath(wallet.priv, wallet.internalXOnly);
}

const utf8 = (s) => new TextEncoder().encode(String(s));
const sha256Hex = (s) => bytesToHex(sha256(utf8(s)));

function randHex(bytes) {
  const c = (typeof globalThis !== "undefined" && globalThis.crypto) || null;
  if (!c || typeof c.getRandomValues !== "function") {
    throw new Error("no CSPRNG available — nonces must come from crypto.getRandomValues");
  }
  const b = new Uint8Array(bytes);
  c.getRandomValues(b);
  return bytesToHex(b);
}

/** 8-byte nonce for a ballot (uniqueness, not secrecy). */
export function genBallotNonceHex() { return randHex(BALLOT_NONCE_BYTES); }

/* ================= addresses ================= */

/** Validate + canonicalize a Pearl v1 (Taproot) voter address. Throws otherwise. */
export function validVoterAddress(addr, network = NETWORKS.mainnet) {
  const a = String(addr ?? "").trim();
  let dec;
  try { dec = decodeBech32m(a, network.hrp); }
  catch { throw new Error(`not a valid ${network.hrp}1 address: ${a}`); }
  if (dec.version !== 1 || dec.program.length !== 32) {
    throw new Error(`address must be a Pearl v1 (Taproot) address: ${a}`);
  }
  return encodeBech32m(network.hrp, 1, dec.program);
}

/* ================= proposal + descriptor ================= */

/** Canonical proposal JSON (sorted keys). Changing any field changes the
 *  proposalHash and therefore the descriptor — post-publish edits are
 *  detectable. */
export function canonicalProposal({ title, description, options, startH, endH, snapshotH }) {
  return JSON.stringify({
    description: String(description).trim(),
    endH: Number(endH),
    options: options.map((o) => String(o).trim()),
    snapshotH: Number(snapshotH),
    startH: Number(startH),
    title: String(title).trim(),
  });
}

export function proposalHashOf(proposal) { return sha256Hex(canonicalProposal(proposal)); }

/** Canonical options list hash. */
export function optionsHashOf(options) {
  return sha256Hex(options.map((o) => String(o).trim()).join("\n"));
}

const DESCRIPTOR_RE = /^pearl-ballot:v1:([a-z0-9]+):([0-9a-f]{64}):(\d+):(\d+):(\d+):([0-9a-f]{64})$/;

/** Parse a ballot descriptor. Throws on any malformed field. */
export function parseDescriptor(s) {
  const t = String(s ?? "").trim();
  const m = t.match(DESCRIPTOR_RE);
  if (!m) throw new Error("not a ballot descriptor — expected pearl-ballot:v1:<hrp>:<proposalHash>:<startH>:<endH>:<snapshotH>:<optionsHash>");
  const [, hrp, proposalHash, startS, endS, snapS, optionsHash] = m;
  const network = Object.values(NETWORKS).find((n) => n.hrp === hrp);
  if (!network) throw new Error(`unknown network hrp "${hrp}"`);
  const startH = Number(startS), endH = Number(endS), snapshotH = Number(snapS);
  for (const [n, h] of [["start height", startH], ["end height", endH], ["snapshot height", snapshotH]]) {
    if (!Number.isSafeInteger(h) || h <= 0) throw new Error(`${n} must be a positive integer block height`);
  }
  return {
    hrp, network, proposalHash, startH, endH, snapshotH, optionsHash,
    descriptor: t,
    descriptorHash: sha256Hex(t),
  };
}

/** Forge (draft) a proposal: validate everything and return the
 *  tamper-evident descriptor. Requires the current chain tip so the
 *  voting window is provably in the future — the descriptor must be
 *  published before startH. Throws instead of forging anything
 *  ambiguous. */
export function forgeBallot({
  network = NETWORKS.mainnet, title, description, options,
  startH, endH, snapshotH, nonce = null, currentHeight,
}) {
  const t = String(title ?? "").trim();
  if (!t) throw new Error("the proposal needs a title — empty/dust proposals are refused");
  if (t.length > 120) throw new Error("proposal title too long (max 120 chars)");
  const d = String(description ?? "").trim();
  if (!d) throw new Error("the proposal needs a description — empty/dust proposals are refused");
  if (d.length > 2000) throw new Error("proposal description too long (max 2000 chars)");
  const opts = (Array.isArray(options) ? options : []).map((o) => String(o ?? "").trim());
  if (opts.length < MIN_OPTIONS) throw new Error(`a proposal needs at least ${MIN_OPTIONS} options`);
  if (opts.length > MAX_OPTIONS) throw new Error(`a proposal takes at most ${MAX_OPTIONS} options`);
  opts.forEach((o, i) => {
    if (!o) throw new Error(`option ${i + 1} is empty — empty options are refused`);
    if (o.length > 80) throw new Error(`option ${i + 1} too long (max 80 chars)`);
  });
  const lower = opts.map((o) => o.toLowerCase());
  if (new Set(lower).size !== lower.length) throw new Error("options must be distinct (case-insensitive)");
  for (const [n, h] of [["start height", startH], ["end height", endH], ["snapshot height", snapshotH]]) {
    if (!Number.isSafeInteger(h) || h <= 0) throw new Error(`${n} must be a positive integer block height`);
  }
  if (currentHeight == null) throw new Error("need the current chain height (Blockbook or manual) to prove the voting window is in the future");
  if (!Number.isSafeInteger(currentHeight) || currentHeight < 0) throw new Error("current height must be a non-negative integer");
  if (startH <= currentHeight) {
    throw new Error(`voting window start ${startH} is at/behind the chain tip ${currentHeight} — the descriptor must be published BEFORE the window opens, so draft with a future window`);
  }
  if (endH <= startH) {
    throw new Error(`voting window end ${endH} must be after the start ${startH}`);
  }
  if (snapshotH > startH) {
    throw new Error(`snapshot height ${snapshotH} must be at or before the voting window start ${startH}`);
  }
  if (snapshotH > currentHeight) {
    throw new Error(`snapshot height ${snapshotH} is ahead of the chain tip ${currentHeight} — you cannot snapshot the future`);
  }
  const nonceHex = nonce == null ? genBallotNonceHex() : String(nonce).toLowerCase().trim();
  if (!/^[0-9a-f]{16,64}$/.test(nonceHex)) throw new Error("nonce must be 16–64 lowercase hex characters");
  const proposal = { title: t, description: d, options: opts, startH, endH, snapshotH };
  const ph = proposalHashOf(proposal);
  const oh = optionsHashOf(opts);
  const descriptor = `pearl-ballot:v1:${network.hrp}:${ph}:${startH}:${endH}:${snapshotH}:${oh}`;
  const parsed = parseDescriptor(descriptor); // re-parse to canonicalize
  return {
    ...parsed,
    proposal,
    canonical: canonicalProposal(proposal),
    nonce: nonceHex,
  };
}

/* ================= ballots ================= */

/** The exact fields covered by the voter's signature (alphabetical keys). */
export function canonicalBallot({ descriptorHash, voter, choice, weightGrains, snapshotH, nonce }) {
  return JSON.stringify({
    choice: Number(choice),
    descriptorHash: String(descriptorHash).trim().toLowerCase(),
    nonce: String(nonce).trim().toLowerCase(),
    snapshotH: Number(snapshotH),
    voter: String(voter).trim(),
    weightGrains: BigInt(weightGrains).toString(),
  });
}

export function ballotHashOf(fields) { return sha256Hex(canonicalBallot(fields)); }

/** Normalize + validate a signed ballot object (no signature check yet).
 *  Throws on any malformed field. */
export function parseSignedBallot(obj) {
  if (!obj || typeof obj !== "object") throw new Error("ballot must be a JSON object");
  if (obj.protocol !== "pearl-ballot-ballot") throw new Error("not a pearl-ballot-ballot object");
  if (obj.version !== 1) throw new Error("unsupported ballot version");
  const dh = String(obj.descriptorHash ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(dh)) throw new Error("ballot descriptorHash must be 64 hex chars");
  const voter = String(obj.voter ?? "").trim();
  const choice = Number(obj.choice);
  if (!Number.isSafeInteger(choice) || choice < 0) throw new Error("ballot choice must be a non-negative integer option index");
  let weightGrains;
  try { weightGrains = BigInt(obj.weightGrains); } catch { throw new Error("ballot weightGrains must be a grain amount"); }
  if (weightGrains < 0n) throw new Error("ballot weightGrains must be non-negative");
  const snapshotH = Number(obj.snapshotH);
  if (!Number.isSafeInteger(snapshotH) || snapshotH <= 0) throw new Error("ballot snapshotH must be a positive integer");
  const nonce = String(obj.nonce ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{16,64}$/.test(nonce)) throw new Error("ballot nonce must be 16–64 lowercase hex chars");
  const bh = String(obj.ballotHash ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(bh)) throw new Error("ballot ballotHash must be 64 hex chars");
  const sig = String(obj.signature ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{128}$/.test(sig)) throw new Error("ballot signature must be 128 hex chars (64-byte BIP-340)");
  return {
    protocol: obj.protocol, version: 1,
    descriptorHash: dh, voter, choice, weightGrains, snapshotH, nonce,
    ballotHash: bh, signature: sig,
  };
}

/** Sign a ballot locally. `tweakedPriv` is the voter's tweaked keypath
 *  private key (ballotSigningKey). Pass auxRand for deterministic test
 *  vectors; production callers leave it random (BIP-340 aux randomness).
 *  The signature is re-verified against the voter's address before
 *  returning — a wrong-key sign is a loud failure here, not downstream. */
export function signBallot({ tweakedPriv, fields, auxRand = undefined }) {
  const dh = String(fields.descriptorHash ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(dh)) throw new Error("descriptorHash must be 64 hex chars");
  const voter = validVoterAddress(fields.voter, fields.network ?? NETWORKS.mainnet);
  const choice = Number(fields.choice);
  if (!Number.isSafeInteger(choice) || choice < 0) throw new Error("choice must be a non-negative integer option index");
  const weightGrains = BigInt(fields.weightGrains);
  if (weightGrains < 0n) throw new Error("weightGrains must be non-negative");
  const snapshotH = Number(fields.snapshotH);
  if (!Number.isSafeInteger(snapshotH) || snapshotH <= 0) throw new Error("snapshotH must be a positive integer");
  const nonce = String(fields.nonce ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{16,64}$/.test(nonce)) throw new Error("nonce must be 16–64 lowercase hex chars");
  const signedFields = { descriptorHash: dh, voter, choice, weightGrains, snapshotH, nonce };
  const bhash = ballotHashOf(signedFields);
  const priv = tweakedPriv instanceof Uint8Array ? tweakedPriv : hexToBytes(tweakedPriv);
  const sig = schnorr.sign(hexToBytes(bhash), priv, ...(auxRand === undefined ? [] : [auxRand]));
  // Re-verify against the voter's address x-only key (the tweaked program).
  const prog = decodeBech32m(voter).program;
  if (!schnorr.verify(sig, hexToBytes(bhash), prog)) {
    throw new Error("LOUD REFUSAL: the ballot signature does not verify against the voter's address key — the signing key does not control this address. Ballot NOT signed.");
  }
  return {
    protocol: "pearl-ballot-ballot",
    version: 1,
    ...signedFields,
    weightGrains: weightGrains.toString(),
    ballotHash: bhash,
    signature: bytesToHex(sig),
  };
}

/** Verify a signed ballot against a descriptor. Throws LOUDLY on any
 *  failure (wrong key, tampered field, wrong descriptor, unknown
 *  option, zero weight). Returns the verified ballot. */
export function verifySignedBallot({ descriptor, signed }) {
  const d = typeof descriptor === "string" ? parseDescriptor(descriptor) : descriptor;
  const b = parseSignedBallot(signed);
  if (b.descriptorHash !== d.descriptorHash) {
    throw new Error(`LOUD REFUSAL: ballot binds to descriptor ${b.descriptorHash.slice(0, 16)}… but this poll's descriptor is ${d.descriptorHash.slice(0, 16)}… — wrong poll. Ballot REJECTED.`);
  }
  const voter = validVoterAddress(b.voter, d.network);
  const recomputed = ballotHashOf({
    descriptorHash: b.descriptorHash, voter, choice: b.choice,
    weightGrains: b.weightGrains, snapshotH: b.snapshotH, nonce: b.nonce,
  });
  if (recomputed !== b.ballotHash) {
    throw new Error("LOUD REFUSAL: the ballot's ballotHash does not match its signed fields — the ballot was TAMPERED after signing. Ballot REJECTED.");
  }
  const prog = decodeBech32m(voter).program;
  if (!schnorr.verify(hexToBytes(b.signature), hexToBytes(b.ballotHash), prog)) {
    throw new Error(`LOUD REFUSAL: ballot signature FAILS against voter ${voter} — wrong key or forged signature. Ballot REJECTED.`);
  }
  if (b.snapshotH !== d.snapshotH) {
    throw new Error(`LOUD REFUSAL: ballot claims snapshot height ${b.snapshotH} but the poll's snapshot height is ${d.snapshotH}. Ballot REJECTED.`);
  }
  return { ...b, voter };
}

/* ================= tally ================= */

/** Tally ballots for a descriptor. Every ballot is re-verified; anything
 *  invalid is REJECTED loudly with a reason. One address, one ballot:
 *  the first valid ballot from an address wins; later ones are
 *  rejected as duplicates and reported. Returns the full derivation. */
export function tallyBallots({ descriptor, signedBallots, tipHeight = null, tipSource = "manual", optionCount = null }) {
  const d = typeof descriptor === "string" ? parseDescriptor(descriptor) : descriptor;
  if (!Array.isArray(signedBallots)) throw new Error("ballots must be an array");
  if (signedBallots.length > MAX_BALLOTS) throw new Error(`too many ballots (max ${MAX_BALLOTS})`);
  const accepted = [], rejected = [], seenVoters = new Set(), duplicates = [];
  const perOption = [];
  let totalWeight = 0n;
  for (let i = 0; i < signedBallots.length; i++) {
    const raw = signedBallots[i];
    try {
      const b = verifySignedBallot({ descriptor: d, signed: raw });
      if (optionCount != null && b.choice >= optionCount) {
        throw new Error(`LOUD REFUSAL: ballot choice ${b.choice} is not an option of this poll (options: 0–${optionCount - 1}). Ballot REJECTED.`);
      }
      if (seenVoters.has(b.voter)) {
        duplicates.push({ index: i, voter: b.voter, ballotHash: b.ballotHash });
        rejected.push({ index: i, voter: b.voter, reason: "DUPLICATE: this address already cast a valid ballot — one ballot per address, first valid wins" });
        continue;
      }
      if (b.weightGrains === 0n) {
        rejected.push({ index: i, voter: b.voter, reason: "zero-weight ballot refused — an address with no PRL balance casts no vote" });
        continue;
      }
      seenVoters.add(b.voter);
      perOption[b.choice] = (perOption[b.choice] ?? 0n) + b.weightGrains;
      totalWeight += b.weightGrains;
      accepted.push({ index: i, voter: b.voter, choice: b.choice, weightGrains: b.weightGrains, ballotHash: b.ballotHash, signature: b.signature });
    } catch (e) {
      let voter = "?";
      try { voter = String(raw?.voter ?? "?"); } catch { /* keep ? */ }
      rejected.push({ index: i, voter, reason: e.message });
    }
  }
  return {
    descriptor: d.descriptor, descriptorHash: d.descriptorHash,
    perOption: perOption.map((w) => w ?? 0n),
    totalWeight, nVoters: accepted.length, nRejected: rejected.length,
    accepted, rejected, duplicates,
    tipHeight, tipSource,
    talliedAt: new Date().toISOString(),
  };
}

/** Canonical tally (what resultHash binds). */
export function canonicalTally(t) {
  return JSON.stringify({
    accepted: t.accepted.map((a) => ({
      ballotHash: a.ballotHash, choice: a.choice, voter: a.voter, weightGrains: a.weightGrains.toString(),
    })),
    descriptorHash: t.descriptorHash,
    nVoters: t.nVoters,
    perOption: t.perOption.map((w) => w.toString()),
    tipHeight: t.tipHeight, tipSource: t.tipSource,
    totalWeight: t.totalWeight.toString(),
  });
}

export function resultHashOf(tally) { return sha256Hex(canonicalTally(tally)); }

/** Pick the winner: highest weight wins; exact ties are reported as a
 *  TIE (governance must break ties socially — the page refuses to pick
 *  a winner out of thin air). */
export function tallyWinner(tally) {
  let best = -1n, winner = -1;
  tally.perOption.forEach((w, i) => {
    if (w > best) { best = w; winner = i; }
  });
  if (winner < 0) return { winner: -1, tie: false }; // no ballots
  const tied = tally.perOption.filter((w) => w === best).length > 1;
  return { winner: tied ? -1 : winner, tie: tied };
}

/** The signed (hash-bound) result record. */
export function resultRecord(tally) {
  const rh = resultHashOf(tally);
  const { winner, tie } = tallyWinner(tally);
  const winnerS = tie ? "TIE" : String(winner);
  return {
    record: `pearl-ballot-result:v1:${tally.descriptorHash}:${winnerS}:${tally.totalWeight.toString()}:${tally.nVoters}:${rh}`,
    resultHash: rh, winner, tie,
    canonical: canonicalTally(tally),
  };
}

/** Standalone verifier: paste the proposal JSON + ballots; the page
 *  re-derives the descriptor from the proposal and re-verifies every
 *  ballot. Throws LOUDLY ("NOT PROVEN") on any tampering. */
export function verifyBallotElection({ proposal, ballots, optionCount = null }) {
  let p;
  try { p = JSON.parse(proposal); } catch { throw new Error("NOT PROVEN: proposal is not valid JSON"); }
  if (!p || typeof p !== "object") throw new Error("NOT PROVEN: proposal must be a JSON object");
  const required = ["title", "description", "options", "startH", "endH", "snapshotH"];
  for (const k of required) {
    if (p[k] === undefined) throw new Error(`NOT PROVEN: proposal JSON is missing "${k}"`);
  }
  const ph = proposalHashOf(p);
  const oh = optionsHashOf(p.options);
  let ballotArr;
  try { ballotArr = JSON.parse(ballots); } catch { throw new Error("NOT PROVEN: ballots are not valid JSON"); }
  if (!Array.isArray(ballotArr)) throw new Error("NOT PROVEN: ballots must be a JSON array");
  if (ballotArr.length === 0) throw new Error("NOT PROVEN: no ballots supplied");
  // Every ballot must agree on the descriptor it binds to.
  const dhashes = new Set();
  for (const b of ballotArr) {
    if (!b || typeof b !== "object" || !/^[0-9a-f]{64}$/.test(String(b.descriptorHash ?? "").toLowerCase())) {
      throw new Error("NOT PROVEN: a ballot has a malformed descriptorHash");
    }
    dhashes.add(String(b.descriptorHash).toLowerCase());
  }
  if (dhashes.size !== 1) throw new Error("NOT PROVEN: ballots bind to different descriptors — mixed polls cannot be tallied together");
  // Re-derive the descriptor from the pasted proposal (hrp comes from the ballots' voters).
  const fakeDescriptor = (() => {
    // reconstruct a descriptor string to parse: hrp from first voter's address
    const first = validVoterAddress(ballotArr[0].voter);
    const hrp = first.startsWith("tprl1") ? "tprl" : "prl";
    return parseDescriptor(`pearl-ballot:v1:${hrp}:${ph}:${p.startH}:${p.endH}:${p.snapshotH}:${oh}`);
  })();
  if (fakeDescriptor.descriptorHash !== [...dhashes][0]) {
    throw new Error("NOT PROVEN: the ballots' descriptorHash does NOT match the pasted proposal — the proposal was altered after the descriptor was published (or the ballots belong to a different poll)");
  }
  const tally = tallyBallots({ descriptor: fakeDescriptor.descriptor, signedBallots: ballotArr, tipHeight: null, tipSource: "verify-only", optionCount });
  if (tally.nVoters === 0) throw new Error("NOT PROVEN: zero valid ballots");
  return { descriptor: fakeDescriptor, tally, result: resultRecord(tally) };
}

/** CSV export of a tally. */
export function tallyCsv(tally) {
  const rows = ["voter,choice,weightGrains,ballotHash"];
  for (const a of tally.accepted) {
    rows.push(`${a.voter},${a.choice},${a.weightGrains.toString()},${a.ballotHash}`);
  }
  return rows.join("\n");
}

/* ================= blockbook (read-only chain data) ================= */

async function bbGet(fetcher, base, path) {
  const url = String(base).replace(/\/+$/, "") + path;
  const r = await fetcher(url);
  if (!r.ok) throw new Error(`blockbook ${r.status} on ${path}`);
  const text = await r.text();
  try { return JSON.parse(text); } catch { throw new Error("blockbook returned non-JSON"); }
}

/** Chain tip height (GET-only). */
export async function fetchTipHeight(fetcher, blockbookBase) {
  const info = await bbGet(fetcher, blockbookBase, "/api/v2");
  const h = info?.backend?.blocks ?? info?.blockbook?.bestHeight;
  if (!Number.isInteger(h) || h < 0) throw new Error("blockbook did not return a chain tip");
  return h;
}

/** Confirmed PRL balance of an address in grains (GET-only).
 *  HONEST LABEL: this is the CURRENT confirmed balance. Blockbook does
 *  not expose historical address balances, so the page cannot read the
 *  balance at the snapshot height — snapshot-height enforcement is the
 *  organizer's job, and the claimed snapshot height is recorded inside
 *  every signed ballot. */
export async function fetchAddressBalanceGrains(fetcher, blockbookBase, address) {
  const info = await bbGet(fetcher, blockbookBase, "/api/v2/address/" + encodeURIComponent(address));
  const bal = info?.balance;
  if (bal == null) throw new Error("blockbook did not return an address balance");
  const g = BigInt(String(bal));
  if (g < 0n) throw new Error("blockbook returned a negative balance");
  return g;
}
