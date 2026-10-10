// Pearl Auction core: sealed-bid PRL auction manager with commit-reveal fairness.
//
// Pearl has NO smart contracts, so fairness here is an off-chain commitment
// protocol enforced by public verification — the same proven model as Pearl
// Raffle:
//
//   1. LIST (auctioneer): commits to the item terms, minimum bid, commit
//      deadline (block height) and reveal deadline (block height) in a
//      tamper-evident descriptor:
//        auction:v1:<hrp>:<itemHash>:<minBidGrains>:<commitH>:<revealH>:<nonce>
//      itemHash = SHA-256 over the canonical item terms. The descriptor must
//      be PUBLISHED before commitH.
//   2. COMMIT (bidders): each bidder locally computes
//        commitment = SHA-256("pearl-auction-commit:v1:<descriptorHash>:<bidderAddr>:<bidGrains>:<saltHex>")
//      (16-byte CSPRNG salt) and publishes ONLY the hash before commitH.
//      The bid and the salt stay secret.
//   3. REVEAL (bidders): before revealH each bidder submits (bid, salt);
//      the page re-derives the commitment. Mismatch = loud refusal.
//      Bid below minimum = refused. Second commitment from the same address
//      flags both as cheaters and excludes them. Tie = earliest reveal wins.
//   4. SETTLE: highest verified bid wins; full derivation table shown.
//      The winner pays the seller directly off-page — this page never moves
//      PRL, it only computes a payment plan (pearl: URI + QR + CSV).
//      No valid bid >= minimum -> "no sale" with a signed (hash-bound)
//      result record.
//   5. VERIFY (standalone): paste descriptor + commitments + reveals; the
//      page re-derives everything and refuses tampered input loudly.
//
// Rule stated at list time: one bidder, one commitment. A second commitment
// from the same address is flagged and BOTH are excluded from the auction.
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

/** Max commitments per auction (sanity bound). */
export const MAX_COMMITMENTS = 100000;

/** Reveal deadline must be at least this many blocks after the commit
 *  deadline (~10 minutes at the 194 s block target), giving every bidder a
 *  real reveal window. */
export const MIN_REVEAL_GAP = 3;

/** Commit deadline must be at least this many blocks ahead of the chain tip
 *  seen at list time, so bidders have a real commit window. */
export const MIN_COMMIT_LEAD = 1;

/** Pearl block target time, seconds (node/chaincfg/params.go). */
export const BLOCK_TARGET_S = 194;

/** Salt size for bid commitments, bytes. */
export const SALT_BYTES = 16;

const utf8 = (s) => new TextEncoder().encode(String(s));
const sha256Hex = (s) => bytesToHex(sha256(utf8(s)));

function randHex(bytes) {
  const c = (typeof globalThis !== "undefined" && globalThis.crypto) || null;
  if (!c || typeof c.getRandomValues !== "function") {
    throw new Error("no CSPRNG available — salts must come from crypto.getRandomValues");
  }
  const b = new Uint8Array(bytes);
  c.getRandomValues(b);
  return bytesToHex(b);
}

/** 8-byte nonce for the descriptor (uniqueness, not secrecy). */
export function genNonceHex() { return randHex(8); }

/** 16-byte CSPRNG salt for a bid commitment. Never published with the bid. */
export function genSaltHex() { return randHex(SALT_BYTES); }

/* ================= addresses ================= */

/** Validate + canonicalize a Pearl v1 (Taproot) address. Throws otherwise. */
export function validBidderAddress(addr, network = NETWORKS.mainnet) {
  const a = String(addr ?? "").trim();
  let dec;
  try { dec = decodeBech32m(a, network.hrp); }
  catch { throw new Error(`not a valid ${network.hrp}1 address: ${a}`); }
  if (dec.version !== 1 || dec.program.length !== 32) {
    throw new Error(`address must be a Pearl v1 (Taproot) address: ${a}`);
  }
  return encodeBech32m(network.hrp, 1, dec.program);
}

/* ================= item + descriptor ================= */

/** Canonical item terms. Changing any term changes the itemHash and therefore
 *  the descriptorHash — post-list edits are detectable. */
export function canonicalItem({ name, description, seller, minBidGrains, imageUrl }) {
  return [
    String(name).trim(),
    String(description ?? "").trim(),
    String(seller),
    BigInt(minBidGrains).toString(),
    String(imageUrl ?? "").trim(),
  ].join("\n");
}

export function itemHashOf(item) {
  return sha256Hex(canonicalItem(item));
}

const DESCRIPTOR_RE = /^auction:v1:([a-z0-9]+):([0-9a-f]{64}):(\d+):(\d+):(\d+):([0-9a-f]{16,64})$/;

/** Parse an auction descriptor. Throws on any malformed field. */
export function parseDescriptor(s) {
  const t = String(s ?? "").trim();
  const m = t.match(DESCRIPTOR_RE);
  if (!m) throw new Error("not an auction descriptor — expected auction:v1:<hrp>:<itemHash>:<minBidGrains>:<commitH>:<revealH>:<nonce>");
  const [, hrp, itemHash, minBidS, commitS, revealS, nonce] = m;
  const network = Object.values(NETWORKS).find((n) => n.hrp === hrp);
  if (!network) throw new Error(`unknown network hrp "${hrp}"`);
  const minBidGrains = BigInt(minBidS);
  const commitH = Number(commitS);
  const revealH = Number(revealS);
  if (minBidGrains <= 0n) throw new Error("minimum bid must be positive");
  if (!Number.isSafeInteger(commitH) || commitH <= 0) throw new Error("commit deadline must be a positive integer block height");
  if (!Number.isSafeInteger(revealH) || revealH <= 0) throw new Error("reveal deadline must be a positive integer block height");
  return {
    hrp, network, itemHash, minBidGrains, commitH, revealH, nonce,
    descriptor: t,
    descriptorHash: sha256Hex(t),
  };
}

function validImageUrl(u) {
  const s = String(u ?? "").trim();
  if (!s) return "";
  if (s.length > 512) throw new Error("image URL too long (max 512 chars)");
  if (!/^https?:\/\/[^\s]+$/i.test(s)) throw new Error("image URL must be an http(s) URL (or leave it empty)");
  return s;
}

/** Forge (list) an auction: validate everything and return the tamper-evident
 *  descriptor. Requires the current chain tip so the commit deadline is
 *  provably in the future. Throws instead of forging anything ambiguous. */
export function forgeAuction({
  network = NETWORKS.mainnet, name, description, imageUrl,
  seller, minBidGrains, commitH, revealH, nonce = null, currentHeight,
}) {
  const itemName = String(name ?? "").trim();
  if (!itemName) throw new Error("the item needs a name");
  if (itemName.length > 120) throw new Error("item name too long (max 120 chars)");
  const itemDesc = String(description ?? "").trim();
  if (itemDesc.length > 2000) throw new Error("item description too long (max 2000 chars)");
  const img = validImageUrl(imageUrl);
  const sellerAddr = validBidderAddress(seller, network);
  if (typeof minBidGrains !== "bigint") throw new Error("minimum bid must be a grain amount (BigInt)");
  if (minBidGrains <= 0n) throw new Error("minimum bid must be positive");
  if (minBidGrains < BigInt(DUST_GRAIN)) {
    throw new Error(`minimum bid of ${fmtPRL(minBidGrains)} PRL is below the ${fmtPRL(DUST_GRAIN)} PRL dust floor — a winning bid must be payable on-chain`);
  }
  if (!Number.isSafeInteger(commitH) || commitH <= 0) {
    throw new Error("commit deadline must be a positive integer block height");
  }
  if (!Number.isSafeInteger(revealH) || revealH <= 0) {
    throw new Error("reveal deadline must be a positive integer block height");
  }
  if (currentHeight == null) throw new Error("need the current chain height (Blockbook or manual) to prove the commit deadline is in the future");
  if (!Number.isSafeInteger(currentHeight) || currentHeight < 0) throw new Error("current height must be a non-negative integer");
  if (commitH <= currentHeight) {
    throw new Error(`commit deadline ${commitH} is at or behind the chain tip ${currentHeight} — bids could not be committed in time`);
  }
  if (commitH < currentHeight + MIN_COMMIT_LEAD + 1) {
    throw new Error(`commit deadline ${commitH} is too near the tip ${currentHeight} — needs at least ${MIN_COMMIT_LEAD + 1} blocks of lead so bidders have a commit window`);
  }
  if (revealH <= commitH) {
    throw new Error(`reveal deadline ${revealH} must be after the commit deadline ${commitH} — you cannot reveal while the commit phase is still open`);
  }
  if (revealH < commitH + MIN_REVEAL_GAP) {
    throw new Error(`reveal window is only ${revealH - commitH} block(s) — needs at least ${MIN_REVEAL_GAP} blocks so bidders can reveal`);
  }
  const nonceHex = nonce == null ? genNonceHex() : String(nonce).toLowerCase().trim();
  if (!/^[0-9a-f]{16,64}$/.test(nonceHex)) throw new Error("nonce must be 16–64 lowercase hex characters");
  const item = { name: itemName, description: itemDesc, seller: sellerAddr, minBidGrains, imageUrl: img };
  const ih = itemHashOf(item);
  const descriptor = `auction:v1:${network.hrp}:${ih}:${minBidGrains.toString()}:${commitH}:${revealH}:${nonceHex}`;
  const forged = parseDescriptor(descriptor); // re-parse to canonicalize
  return {
    ...forged,
    item, itemHash: ih,
    canonical: canonicalItem(item),
  };
}

/* ================= commit ================= */

/** The commitment preimage. The descriptorHash binds the commitment to THIS
 *  auction; the salt binds the bid to the bidder while keeping it hidden. */
export function commitmentPreimage(descriptorHash, bidderAddr, bidGrains, saltHex) {
  return `pearl-auction-commit:v1:${descriptorHash}:${bidderAddr}:${BigInt(bidGrains).toString()}:${saltHex.toLowerCase()}`;
}

export function makeCommitment({ descriptorHash, bidderAddr, bidGrains, saltHex }) {
  const dh = String(descriptorHash ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(dh)) throw new Error("descriptor hash must be 64 hex characters");
  const addr = String(bidderAddr ?? "").trim();
  const bid = BigInt(bidGrains);
  if (bid <= 0n) throw new Error("bid must be positive");
  const salt = String(saltHex ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(salt)) throw new Error("salt must be 16 bytes (32 hex chars) — generate it, never hand-pick it");
  return {
    commitment: sha256Hex(commitmentPreimage(dh, addr, bid, salt)),
    preimage: commitmentPreimage(dh, addr, bid, salt),
    descriptorHash: dh, bidderAddr: addr, bidGrains: bid, saltHex: salt,
  };
}

/** Verify a reveal against a recorded commitment. Throws LOUDLY on mismatch.
 *  Returns the verified reveal record. */
export function verifyCommitment({ descriptorHash, address, commitmentHex, bidGrains, saltHex }) {
  const expected = makeCommitment({ descriptorHash, bidderAddr: address, bidGrains, saltHex });
  if (expected.commitment !== String(commitmentHex ?? "").trim().toLowerCase()) {
    throw new Error("LOUD REFUSAL: the (bid, salt) pair does NOT reproduce the recorded commitment hash. The reveal was altered, or the bidder revealed with the wrong bid/salt. Bid REJECTED.");
  }
  return { address, bidGrains: BigInt(bidGrains), saltHex: String(saltHex).toLowerCase(), commitment: expected.commitment, preimage: expected.preimage };
}

/* ================= commitment ledger ================= */

export function emptyLedger() { return { commitments: [] }; }

/** Record a published commitment (organizer step). Refuses late commits
 *  (at/after commitH — the hash must be published BEFORE the commit
 *  deadline block), duplicate commitment hashes, and a second commitment
 *  from the same address (flagged: one bidder, one commitment). */
export function recordCommitment(ledger, { descriptor, address, commitmentHex, tipHeight }) {
  const d = typeof descriptor === "string" ? parseDescriptor(descriptor) : descriptor;
  const addr = validBidderAddress(address, d.network);
  const ch = String(commitmentHex ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(ch)) throw new Error("commitment must be 64 hex characters (SHA-256)");
  if (tipHeight == null || !Number.isSafeInteger(tipHeight) || tipHeight < 0) {
    throw new Error("need the current chain height to prove the commitment was published before the commit deadline");
  }
  if (tipHeight >= d.commitH) {
    throw new Error(`commitment REFUSED: chain tip ${tipHeight} is at/past the commit deadline block ${d.commitH} — publish hashes only BEFORE the commit deadline`);
  }
  if (ledger.commitments.some((c) => c.commitment === ch)) {
    throw new Error("this commitment hash is already recorded — duplicates are refused");
  }
  if (ledger.commitments.some((c) => c.address === addr)) {
    throw new Error(`second commitment from ${addr} — one bidder, one commitment. Per the published auction rules this bidder is FLAGGED and excluded; the commitment is not recorded`);
  }
  if (ledger.commitments.length >= MAX_COMMITMENTS) throw new Error(`too many commitments (max ${MAX_COMMITMENTS})`);
  const rec = { address: addr, commitment: ch, recordedAt: new Date().toISOString(), tipHeight };
  ledger.commitments.push(rec);
  return rec;
}

/* ================= reveal ================= */

/** Reveal a bid: the commit phase must be over (tip >= commitH), the reveal
 *  phase must still be open (tip < revealH), the bid must meet the minimum,
 *  and (bid, salt) must reproduce the recorded commitment. Returns the
 *  verified reveal record. */
export function applyReveal(ledger, { descriptor, address, bidGrains, saltHex, tipHeight }) {
  const d = typeof descriptor === "string" ? parseDescriptor(descriptor) : descriptor;
  const addr = validBidderAddress(address, d.network);
  if (tipHeight == null || !Number.isSafeInteger(tipHeight) || tipHeight < 0) {
    throw new Error("need the current chain height to check the reveal window");
  }
  if (tipHeight < d.commitH) {
    throw new Error(`reveal REFUSED: the commit phase is still open until block ${d.commitH} — bids cannot be revealed yet`);
  }
  if (tipHeight >= d.revealH) {
    throw new Error(`reveal REFUSED: the reveal deadline block ${d.revealH} has passed (tip ${tipHeight})`);
  }
  const bid = BigInt(bidGrains);
  if (bid <= 0n) throw new Error("bid must be positive");
  if (bid < d.minBidGrains) {
    throw new Error(`bid of ${fmtPRL(bid)} PRL is below the auction minimum of ${fmtPRL(d.minBidGrains)} PRL — refused`);
  }
  const rec = ledger.commitments.find((c) => c.address === addr);
  if (!rec) throw new Error(`no recorded commitment for ${addr} — only committed bidders may reveal`);
  const v = verifyCommitment({ descriptorHash: d.descriptorHash, address: addr, commitmentHex: rec.commitment, bidGrains: bid, saltHex });
  return { ...v, recordedAt: rec.recordedAt, tipHeight, revealedAt: new Date().toISOString() };
}

/* ================= settle ================= */

/** Canonical settle input: commitments + reveals, each on one line, sorted by
 *  address — used for the signed result record. */
function canonicalSettle(commitments, reveals) {
  const cs = [...commitments].sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
  const rs = [...reveals].sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
  return [
    ...cs.map((c) => `commit ${c.address} ${c.commitment}`),
    ...rs.map((r) => `reveal ${r.address} ${r.bidGrains.toString()} ${r.saltHex}`),
  ].join("\n");
}

/** Settle the auction. `reveals` must be in reveal order (earliest first) —
 *  ties on the bid are broken by earliest reveal. Every reveal is re-checked
 *  against its commitment; failures are LOUD but do not stop the settle of
 *  the valid bids.
 *
 *  Cheat detection:
 *   - commitment-hash collision: the same hash recorded for two different
 *     addresses -> both excluded;
 *   - address with two different reveals -> both excluded.
 *
 *  Returns the full result: winner (or noSale), ranking, derivation table,
 *  and a hash-bound result record. */
export function settleAuction({ descriptor, commitments, reveals }) {
  const d = typeof descriptor === "string" ? parseDescriptor(descriptor) : descriptor;
  if (!Array.isArray(commitments)) throw new Error("commitments must be a list");
  if (!Array.isArray(reveals)) throw new Error("reveals must be a list");

  // 1. commitment-hash collisions: same hash, different addresses -> exclude both
  const hashToAddrs = new Map();
  for (const c of commitments) {
    if (!hashToAddrs.has(c.commitment)) hashToAddrs.set(c.commitment, []);
    hashToAddrs.get(c.commitment).push(c.address);
  }
  const collided = new Set();
  for (const [h, addrs] of hashToAddrs) {
    const uniq = [...new Set(addrs)];
    if (uniq.length > 1) uniq.forEach((a) => collided.add(a));
  }

  // 2. address with two different reveals -> exclude both
  const addrReveals = new Map();
  reveals.forEach((r, i) => {
    if (!addrReveals.has(r.address)) addrReveals.set(r.address, []);
    addrReveals.get(r.address).push({ ...r, revealOrder: i });
  });
  const doubleReveal = new Set();
  for (const [addr, rs] of addrReveals) {
    if (rs.length > 1) doubleReveal.add(addr);
  }

  // 3. per-reveal verification against the recorded commitment
  const rows = [];
  const valid = [];
  const seenAddr = new Set();
  reveals.forEach((r, i) => {
    const row = { revealOrder: i + 1, address: r.address, bidGrains: null, saltHex: r.saltHex, check: "", ok: false, excludeReason: null, valid: false };
    seenAddr.add(r.address);
    if (collided.has(r.address)) {
      row.excludeReason = "commitment-hash collision: same hash recorded for two different addresses — both excluded";
    } else if (doubleReveal.has(r.address)) {
      row.excludeReason = "two reveals from one address — one bidder, one commitment; both excluded per the auction rules";
    } else {
      const c = commitments.find((x) => x.address === r.address);
      if (!c) {
        row.excludeReason = "no recorded commitment for this address";
      } else {
        const bid = BigInt(r.bidGrains);
        row.bidGrains = bid;
        try {
          if (bid < d.minBidGrains) throw new Error(`bid ${fmtPRL(bid)} PRL below minimum ${fmtPRL(d.minBidGrains)} PRL`);
          verifyCommitment({ descriptorHash: d.descriptorHash, address: r.address, commitmentHex: c.commitment, bidGrains: bid, saltHex: r.saltHex });
          row.check = "✓ (bid, salt) reproduces the recorded commitment; bid >= minimum";
          row.ok = true; row.valid = true;
          valid.push({ address: r.address, bidGrains: bid, saltHex: String(r.saltHex).toLowerCase(), commitment: c.commitment, revealOrder: i + 1 });
        } catch (e) {
          row.check = "✗ " + e.message.replace(/^LOUD REFUSAL: /, "");
        }
      }
    }
    rows.push(row);
  });

  // commitments with no reveal at all: shown as "never revealed" rows
  const neverRevealed = commitments
    .filter((c) => !seenAddr.has(c.address))
    .sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0))
    .map((c) => ({
      revealOrder: null, address: c.address, bidGrains: null, saltHex: null,
      check: "— commitment recorded but never revealed (bid stays hidden)", ok: false, excludeReason: null, valid: false,
    }));

  // 4. ranking: highest bid first; ties broken by earliest reveal
  const ranked = [...valid].sort((a, b) => {
    if (b.bidGrains !== a.bidGrains) return b.bidGrains > a.bidGrains ? 1 : -1;
    return a.revealOrder - b.revealOrder;
  });
  ranked.forEach((r, i) => { r.rank = i + 1; });

  const winner = ranked[0] || null;
  const noSale = winner == null;
  const derivation = [...rows, ...neverRevealed];
  const canon = canonicalSettle(commitments, valid.map((v) => ({ address: v.address, bidGrains: v.bidGrains, saltHex: v.saltHex })));
  const resultHash = sha256Hex(`pearl-auction-result:v1:${d.descriptorHash}:${canon}`);
  const result = {
    descriptor: d,
    winner,
    noSale,
    winningBidGrains: winner ? winner.bidGrains : 0n,
    ranked,
    derivation,
    validCount: valid.length,
    commitmentCount: commitments.length,
    canonicalSettle: canon,
    resultHash,
    resultRecord: `PEARL-AUCTION-RESULT:v1\n${d.descriptor}\nSHA-256(descriptor): ${d.descriptorHash}\n` +
      (noSale
        ? `OUTCOME: NO SALE — no valid bid at or above the ${fmtPRL(d.minBidGrains)} PRL minimum\n`
        : `OUTCOME: SALE\nwinner: ${winner.address}\nwinning bid: ${winner.bidGrains} grains (${fmtPRL(winner.bidGrains)} PRL)\nrank: 1 of ${valid.length} valid reveal(s)\n`) +
      `valid reveals: ${valid.length} · commitments: ${commitments.length}\nSHA-256(result): ${resultHash}`,
    settledAt: new Date().toISOString(),
  };
  return result;
}

/** Standalone verifier: same settle, but refuses tampered input. `input` is
 *  the published bundle { descriptor, commitments: [{address, commitment}],
 *  reveals: [{address, bidGrains, saltHex}] (reveal order) }. Returns the
 *  result with an explicit "proven" verdict. */
export function verifyAuction({ descriptor, commitments, reveals }) {
  const d = parseDescriptor(descriptor); // throws on malformed
  if (!Array.isArray(commitments)) throw new Error("commitments must be a list");
  if (!Array.isArray(reveals)) throw new Error("reveals must be a list");
  for (const c of commitments) {
    if (!/^[0-9a-f]{64}$/.test(String(c.commitment ?? "").trim().toLowerCase())) {
      throw new Error(`commitment for ${c.address} is not 64 hex — input refused`);
    }
    try { validBidderAddress(c.address, d.network); }
    catch { throw new Error(`commitment address is not a valid ${d.hrp}1 v1 address: ${c.address} — input refused`); }
  }
  for (const r of reveals) {
    try { validBidderAddress(r.address, d.network); }
    catch { throw new Error(`reveal address is not a valid ${d.hrp}1 v1 address: ${r.address} — input refused`); }
    if (!/^[0-9a-f]{32}$/.test(String(r.saltHex ?? "").trim().toLowerCase())) {
      throw new Error(`reveal for ${r.address} carries a bad salt — input refused`);
    }
    try { BigInt(r.bidGrains); }
    catch { throw new Error(`reveal for ${r.address} carries a bad bid amount — input refused`); }
  }
  const result = settleAuction({ descriptor: d, commitments, reveals });
  return { ...result, proven: true };
}

/* ================= settlement outputs ================= */

/** pearl: payment URI (BIP-21 style) for the winning bid, paid to the seller. */
export function paymentUri(address, grains) {
  return `pearl:${address}?amount=${fmtPRL(grains)}`;
}

/** CSV export of the full result. */
export function settleCsv(result) {
  const d = result.descriptor;
  const lines = [
    "# Pearl Auction result",
    `# descriptor: ${d.descriptor}`,
    `# outcome: ${result.noSale ? "NO SALE" : "SALE"}`,
    `# result hash: ${result.resultHash}`,
    "rank,address,bid_grains,bid_prl,reveal_order,valid,note",
  ];
  for (const r of result.ranked) {
    lines.push(`${r.rank},${r.address},${r.bidGrains.toString()},${fmtPRL(r.bidGrains)},${r.revealOrder},yes,`);
  }
  for (const row of result.derivation) {
    if (row.valid) continue;
    // Invalid rows are attacker-controlled (unvalidated reveal data): apply
    // the spreadsheet formula-injection guard (CWE-1236) — a cell beginning
    // with =, +, -, @, | or % executes as a formula in Excel/Sheets.
    const guard = (v) => {
      const s = String(v ?? "");
      return !/^-?\d+(\.\d+)?$/.test(s) && /^\s*[=+\-@|%]/.test(s) ? "'" + s : s;
    };
    const note = guard((row.excludeReason || row.check).replace(/,/g, ";"));
    lines.push(`-,${guard(row.address)},${row.bidGrains == null ? "" : row.bidGrains.toString()},,${row.revealOrder == null ? "" : row.revealOrder},no,${note}`);
  }
  return lines.join("\n") + "\n";
}

/** Downloadable sample commitment/reveal bundle for docs and tests. */
export function sampleAuctionJson() {
  return {
    _note: "Pearl Auction sample — replace the addresses with real prl1… v1 addresses",
    descriptor: "auction:v1:prl:ITEMHASH64HEX:100000000:120100:120200:NONCE16HEX",
    commitments: [
      { address: "prl1p… (bidder 1)", commitment: "64 hex commitment hash" },
      { address: "prl1p… (bidder 2)", commitment: "64 hex commitment hash" },
    ],
    reveals: [
      { address: "prl1p… (bidder 1)", bidGrains: "120000000", saltHex: "32 hex salt" },
    ],
  };
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

/** Fetch the auction record list (published commitments) — the organizer keeps
 *  their own ledger, but this re-checks a Blockbook for posted OP_RETURN
 *  commitments in the future. Currently a stub: commitments are recorded
 *  manually. Kept for API symmetry with raffle. */
export function explainCommitmentPosting() {
  return "Commitment hashes are published by the bidders themselves (X, Discord, the auction page, Nostr — anywhere public and timestamped). The organizer records (address, hash) pairs in the ledger. Pearl has no contract to read from; the ledger is the record, and the descriptor hash binds every commitment to this auction.";
}
