/* Pearl Charity core — transparent PRL donation desk.
 *
 * Pure ESM, zero build step for developers. The browser ships a committed
 * esbuild IIFE bundle (pearl-charity.bundle.js); node runs this file directly
 * for the verification suite.
 *
 * Protocol: there is NO contract here. Donations go STRAIGHT to the charity's
 * own Taproot address (a plain bech32m prl1…/tprl1… address validated
 * in-browser). The page NEVER holds, moves, or broadcasts funds — every
 * chain read is GET-only Blockbook; every chain write happens in the donor's
 * own wallet. What the desk adds is tamper-evidence:
 *
 *   Campaign descriptor: pearl-charity:v1:<hrp>:<hash>:<goalGrains>[:<deadlineH>]
 *     hash = SHA-256 over the canonical campaign JSON (org name, recipient
 *     address, goal, deadline, description, contact, network). The recipient
 *     address is part of the hash, so a descriptor that was altered to point
 *     at an attacker's address NEVER verifies against the claimed address.
 *     64-bit fingerprint = first 16 hex chars of the descriptor hash.
 *
 *   Optional organizer authorship: the organizer signs the 32-byte
 *   descriptor hash locally with a BIP-86 key (hex/WIF/mnemonic, held in
 *   memory only, wiped by the UI after forging). The spec records the
 *   organizer's x-only key + 64-byte Schnorr signature. This proves the
 *   campaign was announced by the holder of that key — it does NOT make the
 *   recipient address trustworthy. Trust in the organizer is social.
 *
 *   Donor receipts: hash-bound records pearl-charity-receipt:v1: = SHA-256
 *   over canonical receipt JSON (campaign fingerprint, donor handle,
 *   txid, amountGrains, optional block height, recordedAt ISO). Receipts
 *   live in the browser's localStorage only — donor handles are
 *   self-declared. The optional live cross-check verifies the tx exists on
 *   Blockbook, pays the campaign address the recorded amount, and has >= 1
 *   confirmation.
 *
 * Crypto lineage: ALL cryptography comes from the audited Sign lineage —
 *   files/pages/sign/src/crypto.js (bech32m, sha256, schnorr, BIP-86
 *   wallets, DUST_GRAIN, GRAIN_PER_PRL, NETWORKS) and
 *   files/pages/escrow/src/escrow-core.js (parseXOnlyKey, signForXOnly,
 *   verifySchnorrSig, byte-identical to the escrow audit). No new
 *   cryptography exists in this file: only canonical-JSON hashing,
 *   descriptor shaping, amount parsing, lifecycle classification, and
 *   GET-only Blockbook reads.
 */

import {
  decodeBech32m, encodeBech32m,
  sha256, bytesToHex, hexToBytes, schnorr,
  DUST_GRAIN, GRAIN_PER_PRL, NETWORKS,
  walletFromMnemonic, walletFromWIF, walletFromPriv,
} from "../../sign/src/crypto.js";
import {
  parseXOnlyKey, signForXOnly, verifySchnorrSig,
} from "../../escrow/src/escrow-core.js";

export {
  DUST_GRAIN, GRAIN_PER_PRL, NETWORKS,
  decodeBech32m, encodeBech32m, sha256, bytesToHex, hexToBytes, schnorr,
  walletFromMnemonic, walletFromWIF, walletFromPriv,
  parseXOnlyKey, signForXOnly, verifySchnorrSig,
};

export const BLOCKBOOK_MAINNET = "https://blockbook.pearlresearch.ai";
export const BLOCKBOOK_TESTNET = ""; // no public Pearl testnet blockbook known — user configurable
/** Pearl target block time in seconds (pearl-knowledge.md, node/chaincfg).
 *  Day-estimates in the UI are derived from this constant and labeled. */
export const PEARL_BLOCK_SECS = 194;

export const CHARITY_KIND = "pearl-charity";
export const CHARITY_VERSION = 1;
export const DESCRIPTOR_PREFIX = "pearl-charity:v1";
export const RECEIPT_KIND = "pearl-charity-receipt";
export const MAX_ORG = 120;
export const MAX_DESC = 2000;
export const MAX_HANDLE = 64;

const TE = new TextEncoder();

function constEq(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

/* ------------------------------------------------------------------ */
/* Guards                                                              */
/* ------------------------------------------------------------------ */

/** Recipient: a valid bech32m v1 Taproot address on the campaign network.
 *  Returns the normalized (lowercase) address. */
export function checkRecipientAddress(addr, network) {
  const t = String(addr || "").trim();
  if (!t) throw new Error("a charity recipient address is required");
  let dec;
  try {
    dec = decodeBech32m(t, network.hrp);
  } catch (e) {
    throw new Error(`recipient address rejected (${e.message}) — it must be a valid ${network.hrp}1… Taproot address`);
  }
  if (dec.version !== 1) throw new Error("recipient address rejected — only witness v1 (Taproot) addresses are accepted");
  return t.toLowerCase();
}

/** Campaign goal in grains: positive, dust-floor, safe-integer. A charity
 *  goal below dust could never receive a spendable output, so it is refused. */
export function checkGoalGrains(g) {
  if (!Number.isSafeInteger(g) || g <= 0) throw new Error("goal must be a positive PRL amount");
  if (g < DUST_GRAIN) throw new Error(`goal ${g} grains is below the dust floor (${DUST_GRAIN} grains) — refused`);
  return g;
}

/** Optional absolute deadline (block height). null = no deadline. */
export function checkDeadlineHeight(h) {
  if (h === null || h === undefined || h === "") return null;
  if (!Number.isSafeInteger(h) || h <= 0) throw new Error("deadline must be a positive block height");
  if (h >= 500000000) throw new Error("deadline must be a block height (< 500000000), not a timestamp");
  if (h < 100000) throw new Error(`deadline ${h} is below any plausible Pearl chain height — refusing (likely a paste error)`);
  return h;
}

export function checkOrgName(name) {
  const t = String(name || "").trim();
  if (t.length === 0) throw new Error("give the campaign an organizer name");
  if (t.length > MAX_ORG) throw new Error(`organizer name is ${t.length} chars — keep it under ${MAX_ORG}`);
  return t;
}

/** Parse a PRL amount string ("1.5", "0.00000001") into grains. */
export function parsePRLToGrains(s) {
  const t = String(s || "").trim();
  if (!/^\d+(\.\d{1,8})?$/.test(t)) throw new Error(`"${t}" is not a PRL amount (up to 8 decimals)`);
  const [w, f = ""] = t.split(".");
  const g = Number(w) * GRAIN_PER_PRL + Number((f + "00000000").slice(0, 8));
  if (!Number.isSafeInteger(g)) throw new Error("amount out of range");
  return checkGoalGrains(g);
}

/** Format grains as a PRL amount string (no unit suffix). */
export function fmtPRL(grains) {
  const g = BigInt(grains);
  const neg = g < 0n;
  const a = neg ? -g : g;
  const whole = a / BigInt(GRAIN_PER_PRL);
  const frac = (a % BigInt(GRAIN_PER_PRL)).toString().padStart(8, "0").replace(/0+$/, "");
  return (neg ? "-" : "") + whole.toString() + (frac ? "." + frac : "");
}

/** Organizer key: 64-hex private key, WIF, or 12/24-word mnemonic (BIP-86
 *  account key, same scheme as Pearl Sign). Returns { priv, xonly, source }.
 *  Held in memory only; the UI wipes it after forging. */
export function organizerKeyFromInput(input, network) {
  const t = String(input || "").trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) {
    const w = walletFromPriv(hexToBytes(t.toLowerCase()), network);
    return { priv: bytesToHex(w.priv), xonly: bytesToHex(w.internalXOnly), source: "hex private key" };
  }
  if (/^[1-9A-HJ-NP-Za-km-z]{30,60}$/.test(t)) {
    try {
      const w = walletFromWIF(t, network);
      return { priv: bytesToHex(w.priv), xonly: bytesToHex(w.internalXOnly), source: "WIF" };
    } catch { /* fall through */ }
  }
  const words = t.split(/\s+/);
  if (words.length === 12 || words.length === 24) {
    const w = walletFromMnemonic(t, network);
    return { priv: bytesToHex(w.priv), xonly: bytesToHex(w.internalXOnly), source: "mnemonic (BIP-86 m/86'/coin'/0'/0/0)" };
  }
  throw new Error("organizer key must be a 32-byte hex private key, WIF, or a 12/24-word mnemonic");
}

/* ------------------------------------------------------------------ */
/* Campaign: forge / descriptor / parse / verify                        */
/* ------------------------------------------------------------------ */

/** Canonical campaign JSON — the exact bytes the descriptor hash commits
 *  to. Authorship fields (orgXOnly/orgSigHex) are deliberately EXCLUDED:
 *  the signature signs the hash, so it cannot be part of it. */
function canonicalCampaignJSON(c) {
  return JSON.stringify({
    kind: CHARITY_KIND,
    version: CHARITY_VERSION,
    network: c.network,
    hrp: c.hrp,
    orgName: c.orgName,
    recipient: c.recipient,
    goalGrains: c.goalGrains,
    deadlineHeight: c.deadlineHeight === null ? null : c.deadlineHeight,
    description: c.description,
    contact: c.contact,
  });
}

/** 32-byte descriptor hash of the canonical campaign JSON. */
export function campaignHash(campaign) {
  return sha256(TE.encode(canonicalCampaignJSON(campaign)));
}

/**
 * Forge a campaign. params:
 *   network: NETWORKS.mainnet | NETWORKS.testnet
 *   orgName, recipient (bech32m address on network), goalPRL ("1.5"),
 *   deadlineHeight: optional block height (null/"" = none),
 *   description: optional public text (<= 2000 chars),
 *   contact: optional public contact string (<= 200 chars),
 *   orgKeyInput + orgSignMode ("sign" | "nosign"): optional organizer
 *     authorship — sign the descriptor hash locally. The private key lives
 *     in memory only; the UI wipes it right after forging.
 *
 * Returns { campaign, secret }: campaign is fully serializable (safe to
 * share and publish); secret holds the organizer private key IN MEMORY ONLY
 * and never enters JSON.
 */
export function forgeCampaign(params) {
  const { network, orgName, recipient, goalPRL, deadlineHeight,
    description, contact, orgKeyInput, orgSignMode } = params || {};
  if (!network || !network.hrp) throw new Error("bad network");
  const cleanOrg = checkOrgName(orgName);
  const cleanRecipient = checkRecipientAddress(recipient, network);
  const goalGrains = parsePRLToGrains(goalPRL);
  const cleanDeadline = checkDeadlineHeight(deadlineHeight);
  const cleanDesc = String(description || "").trim().slice(0, MAX_DESC);
  const cleanContact = String(contact || "").trim().slice(0, 200);

  const campaign = {
    kind: CHARITY_KIND,
    version: CHARITY_VERSION,
    network: network.id,
    hrp: network.hrp,
    orgName: cleanOrg,
    recipient: cleanRecipient,
    goalGrains,
    goalPRL: fmtPRL(goalGrains),
    deadlineHeight: cleanDeadline,
    description: cleanDesc,
    contact: cleanContact,
    orgXOnly: null,
    orgKeySource: null,
    orgSigHex: null,
  };
  const hash = campaignHash(campaign);
  campaign.hashHex = bytesToHex(hash);

  let secret = null;
  if (orgSignMode === "sign") {
    const k = organizerKeyFromInput(orgKeyInput, network);
    campaign.orgXOnly = k.xonly;
    campaign.orgKeySource = k.source;
    const sig = signForXOnly(hexToBytes(k.priv), hash);
    if (!verifySchnorrSig(sig, hash, hexToBytes(k.xonly))) {
      throw new Error("organizer signature failed self-verification — refusing to forge");
    }
    campaign.orgSigHex = bytesToHex(sig);
    secret = { priv: k.priv, xonly: k.xonly, role: "organizer" };
  } else if (orgSignMode && orgSignMode !== "nosign") {
    throw new Error('orgSignMode must be "sign" or "nosign"');
  }

  campaign.descriptor = campaignDescriptor(campaign);
  campaign.fingerprint = descriptorFingerprint(campaign.descriptor);
  return { campaign, secret };
}

/** Compact descriptor: pearl-charity:v1:<hrp>:<hashHex>:<goalGrains>[:<deadlineH>].
 *  Recomputable from the campaign — NOT authenticated by itself. */
export function campaignDescriptor(campaign) {
  const base = `${DESCRIPTOR_PREFIX}:${campaign.hrp}:${campaign.hashHex}:${campaign.goalGrains}`;
  return campaign.deadlineHeight === null ? base : `${base}:${campaign.deadlineHeight}`;
}

/** 64-bit fingerprint of the descriptor (first 8 bytes of SHA-256, hex). */
export function descriptorFingerprint(descriptor) {
  return bytesToHex(sha256(TE.encode(String(descriptor).trim()))).slice(0, 16);
}

export function serializeCampaign(campaign) {
  return JSON.stringify(campaign);
}

/**
 * Parse + fully re-derive a campaign spec: JSON shape, field validation,
 * canonical-hash recomputation, fingerprint + descriptor round-trip.
 * Throws on anything unexpected — a tampered spec can never produce a
 * verifiable campaign. Unsigned (orgSigHex null) campaigns parse fine;
 * the verifier separately reports authorship state.
 */
export function parseCampaignSpec(json, network) {
  let s;
  try {
    s = typeof json === "string" ? JSON.parse(json) : json;
  } catch {
    throw new Error("campaign spec is not valid JSON");
  }
  if (!s || s.kind !== CHARITY_KIND || s.version !== CHARITY_VERSION) {
    throw new Error("not a Pearl Charity campaign spec (kind pearl-charity, version 1)");
  }
  if (s.hrp !== network.hrp) throw new Error(`spec is for ${s.hrp}, not ${network.hrp}`);
  const { campaign } = forgeCampaign({
    network,
    orgName: s.orgName,
    recipient: s.recipient,
    goalPRL: fmtPRL(checkGoalGrains(s.goalGrains)),
    deadlineHeight: s.deadlineHeight,
    description: s.description,
    contact: s.contact,
    orgSignMode: "nosign",
  });
  // Every tamper-evident field must re-derive byte-for-byte. Descriptive
  // metadata (description, contact) IS part of the hash here — unlike a
  // bounty spec, a charity campaign has no on-chain contract, so the whole
  // published description is committed to by the hash.
  for (const f of ["hashHex", "descriptor", "fingerprint", "recipient",
    "goalGrains", "deadlineHeight", "orgName", "description", "contact"]) {
    if (campaign[f] !== s[f]) throw new Error(`campaign spec failed re-derivation check on ${f} — the spec was tampered with`);
  }
  const out = { ...campaign };
  if (s.orgSigHex !== null && s.orgSigHex !== undefined) {
    if (!/^[0-9a-f]{128}$/.test(String(s.orgSigHex).toLowerCase())) throw new Error("orgSigHex malformed");
    const k = parseXOnlyKey(String(s.orgXOnly || ""));
    if (!verifySchnorrSig(hexToBytes(String(s.orgSigHex).toLowerCase()), hexToBytes(out.hashHex), k)) {
      throw new Error("LOUD REFUSAL — the recorded organizer signature does not verify against the campaign hash and recorded x-only key");
    }
    out.orgXOnly = bytesToHex(k);
    out.orgSigHex = String(s.orgSigHex).toLowerCase();
    out.orgKeySource = String(s.orgKeySource || "organizer key");
  }
  return out;
}

/** Parse a compact descriptor back into its fields. */
export function parseCampaignDescriptor(descriptor) {
  const t = String(descriptor || "").trim();
  const parts = t.split(":");
  if (parts.length < 5 || parts.length > 6 || parts[0] !== "pearl-charity" || parts[1] !== "v1") {
    throw new Error("bad campaign descriptor (expected pearl-charity:v1:<hrp>:<hashHex>:<goalGrains>[:<deadlineH>])");
  }
  const [, , hrp, hashHex, goalRaw, deadlineRaw] = parts;
  if (!/^[0-9a-f]{64}$/.test(hashHex.toLowerCase())) throw new Error("bad campaign descriptor: hash is not 64 hex chars");
  const goal = Number(goalRaw);
  if (!Number.isSafeInteger(goal)) throw new Error("bad campaign descriptor: goal is not an integer");
  checkGoalGrains(goal);
  let deadline = null;
  if (deadlineRaw !== undefined) {
    deadline = Number(deadlineRaw);
    if (!Number.isSafeInteger(deadline)) throw new Error("bad campaign descriptor: deadline is not an integer");
    checkDeadlineHeight(deadline);
  }
  return { hrp, hashHex: hashHex.toLowerCase(), goalGrains: goal, deadlineHeight: deadline };
}

/**
 * Standalone verifier: recompute the campaign from the spec's fields and
 * LOUDLY REFUSE on malformed input, network mismatch, descriptor/hash
 * mismatch, or when the recomputed recipient does not match the claimed
 * address. Also reports organizer authorship state.
 * Returns { campaign, descriptor, fingerprint, authorship } where authorship
 * is "signed+valid" | "unsigned" (sig invalid is impossible here — it throws).
 */
export function verifyDescriptor(descriptor, network, expectedAddress = null, specJson = null) {
  const f = parseCampaignDescriptor(descriptor);
  if (f.hrp !== network.hrp) {
    throw new Error(`LOUD REFUSAL — descriptor is for network ${f.hrp}, not ${network.hrp}`);
  }
  if (!specJson) {
    throw new Error("the descriptor commits to the full campaign — paste the campaign spec JSON alongside it to verify");
  }
  const campaign = parseCampaignSpec(specJson, network);
  if (campaign.descriptor !== String(descriptor).trim()) {
    throw new Error(
      "LOUD REFUSAL — this spec does not recompute to the given descriptor. " +
      "One of them was altered (recipient, goal, deadline, or text changed). Do not donate until they agree."
    );
  }
  if (expectedAddress !== null && String(expectedAddress).trim().toLowerCase() !== campaign.recipient) {
    throw new Error(
      `LOUD REFUSAL — the descriptor recomputes to recipient ${campaign.recipient}, ` +
      `NOT to the claimed address ${String(expectedAddress).trim()}. ` +
      `The claimed address was altered. Do not donate to the claimed address.`
    );
  }
  return {
    campaign,
    descriptor: campaign.descriptor,
    fingerprint: campaign.fingerprint,
    authorship: campaign.orgSigHex ? "signed+valid" : "unsigned",
  };
}

/* ------------------------------------------------------------------ */
/* Donor receipts: hash-bound records                                  */
/* ------------------------------------------------------------------ */

function canonicalReceiptJSON(r) {
  return JSON.stringify({
    kind: RECEIPT_KIND,
    version: CHARITY_VERSION,
    campaignFingerprint: r.campaignFingerprint,
    donor: r.donor,
    txid: r.txid,
    amountGrains: r.amountGrains,
    blockHeight: r.blockHeight === null ? null : r.blockHeight,
    recordedAt: r.recordedAt,
  });
}

/**
 * Record a donor receipt. Inputs:
 *   campaign (parsed campaign — binds the receipt to the fingerprint),
 *   donor: handle, optional/pseudonymous (blank → "anonymous"),
 *   txid: 64-hex donation transaction id (donor-declared),
 *   amountPRL: donor-declared amount (grain-exact, dust-floor refused),
 *   blockHeight: optional confirmation block,
 *   recordedAt: optional ISO timestamp (default now).
 * Returns the receipt with a SHA-256 hash binding every field.
 */
export function recordReceipt({ campaign, donor, txid, amountPRL, blockHeight = null, recordedAt = null }) {
  if (!campaign || !/^[0-9a-f]{16}$/.test(campaign.fingerprint || "")) throw new Error("bad campaign");
  const handle = String(donor || "").trim() || "anonymous";
  if (handle.length > MAX_HANDLE) throw new Error(`donor handle is ${handle.length} chars — keep it under ${MAX_HANDLE}`);
  const tx = String(txid || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(tx)) throw new Error("txid must be 64 hex characters");
  const amountGrains = parsePRLToGrains(amountPRL);
  let bh = null;
  if (blockHeight !== null && blockHeight !== undefined && blockHeight !== "") {
    bh = Number(blockHeight);
    if (!Number.isSafeInteger(bh) || bh <= 0) throw new Error("block height must be a positive integer");
  }
  const iso = recordedAt ? String(recordedAt) : new Date().toISOString();
  if (Number.isNaN(Date.parse(iso))) throw new Error("recordedAt is not a valid timestamp");
  const receipt = {
    kind: RECEIPT_KIND,
    version: CHARITY_VERSION,
    campaignFingerprint: campaign.fingerprint,
    donor: handle,
    txid: tx,
    amountGrains,
    amountPRL: fmtPRL(amountGrains),
    blockHeight: bh,
    recordedAt: iso,
  };
  receipt.hash = bytesToHex(sha256(TE.encode(canonicalReceiptJSON(receipt))));
  return receipt;
}

/** Recompute a receipt's hash. Loud boolean: true on match, false on any
 *  mismatch (throws only on malformed records). */
export function verifyReceiptHash(receipt) {
  const r = receipt && typeof receipt === "object" ? receipt : null;
  if (!r) throw new Error("receipt is not an object");
  if (r.kind !== RECEIPT_KIND || r.version !== CHARITY_VERSION) throw new Error("not a Pearl Charity receipt");
  if (!/^[0-9a-f]{64}$/.test(String(r.hash || "").toLowerCase())) throw new Error("receipt hash malformed");
  if (!/^[0-9a-f]{64}$/.test(String(r.txid || "").toLowerCase())) throw new Error("receipt txid malformed");
  return constEq(hexToBytes(String(r.hash).toLowerCase()), sha256(TE.encode(canonicalReceiptJSON(r))));
}

/* ------------------------------------------------------------------ */
/* Blockbook: GET-only reads                                           */
/* ------------------------------------------------------------------ */

async function charityGet(base, path) {
  const res = await fetch(String(base).replace(/\/$/, "") + path);
  if (!res.ok) throw new Error(`blockbook ${res.status} on ${path}`);
  const text = await res.text();
  try { return JSON.parse(text); } catch { throw new Error("blockbook returned non-JSON on " + path); }
}

/** Current chain tip height (GET /api/v2 → backend.blocks). */
export async function fetchTipHeight(blockbookBase) {
  const j = await charityGet(blockbookBase, "/api/v2");
  const h = j && j.backend && j.backend.blocks;
  if (!Number.isSafeInteger(h) || h < 0) throw new Error("blockbook returned a bad tip height");
  return h;
}

/**
 * GET-only campaign stats: address info + recent incoming payments.
 * Returns { address, receivedGrains, txCount, donations: [{ txid,
 * valueGrains, blockHeight, confirmations }] } — donations are the
 * Blockbook-reported txs that paid the campaign address (most recent first,
 * capped at pageSize). Unconfirmed (blockHeight < 0) donations are included
 * and flagged; the verifier requires >= 1 confirmation before PROVEN.
 */
export async function fetchCampaignStats(blockbookBase, address, pageSize = 20) {
  const addr = String(address || "").trim();
  if (!addr) throw new Error("bad address");
  const j = await charityGet(blockbookBase, `/api/v2/address/${addr}?details=txs&pageSize=${pageSize}`);
  const receivedGrains = Number(j.totalReceived);
  if (!Number.isSafeInteger(receivedGrains) || receivedGrains < 0) {
    throw new Error("blockbook returned a bad totalReceived");
  }
  const donations = [];
  for (const tx of (j.txs || [])) {
    const txid = String(tx.txid || "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(txid)) continue;
    let valueGrains = 0;
    for (const vo of (tx.vout || [])) {
      const addrs = (vo.scriptPubKey && vo.scriptPubKey.addresses) || [];
      if (addrs.map(String).some((a) => a.toLowerCase() === addr.toLowerCase())) {
        const v = Number(vo.value);
        if (Number.isSafeInteger(v) && v > 0) valueGrains += v;
      }
    }
    if (valueGrains <= 0) continue; // tx touched the address but paid nothing new
    const blockHeight = typeof tx.blockHeight === "number" ? tx.blockHeight : -1;
    donations.push({
      txid,
      valueGrains,
      blockHeight,
      confirmations: Number(tx.confirmations) || 0,
    });
  }
  return { address: addr, receivedGrains, txCount: donations.length, donations };
}

/** GET-only single tx lookup for receipt cross-check. */
export async function fetchTxForReceipt(blockbookBase, txid) {
  const tx = String(txid || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(tx)) throw new Error("txid must be 64 hex characters");
  return charityGet(blockbookBase, `/api/v2/tx/${tx}`);
}

/**
 * Optional live receipt cross-check: the tx exists on Blockbook, pays the
 * campaign address at least the recorded amount, and has >= 1 confirmation.
 * Returns { proven, reasons } — proven true only when every check passes.
 * Pure read; never throws on a failing check (reasons explain).
 */
export async function crossCheckReceipt(blockbookBase, receipt, campaign) {
  const reasons = [];
  if (!verifyReceiptHash(receipt)) {
    return { proven: false, reasons: ["receipt hash does not recompute — the record was altered"] };
  }
  let tx;
  try {
    tx = await fetchTxForReceipt(blockbookBase, receipt.txid);
  } catch (e) {
    return { proven: false, reasons: [`tx ${receipt.txid} not found on Blockbook (${e.message})`] };
  }
  const confs = Number(tx.confirmations) || 0;
  const bh = typeof tx.blockHeight === "number" ? tx.blockHeight : -1;
  if (!(bh >= 0 && confs >= 1)) {
    reasons.push(`tx is unconfirmed (blockHeight ${bh}, ${confs} confirmations) — NOT PROVEN until confirmed`);
  }
  let paidGrains = 0;
  for (const vo of (tx.vout || [])) {
    const addrs = (vo.scriptPubKey && vo.scriptPubKey.addresses) || [];
    if (addrs.map(String).some((a) => a.toLowerCase() === campaign.recipient.toLowerCase())) {
      const v = Number(vo.value);
      if (Number.isSafeInteger(v) && v > 0) paidGrains += v;
    }
  }
  if (paidGrains < receipt.amountGrains) {
    reasons.push(`tx pays the campaign address ${fmtPRL(paidGrains)} PRL, less than the recorded ${receipt.amountPRL} PRL`);
  }
  if (reasons.length === 0) {
    reasons.push(`tx ${receipt.txid} pays ${campaign.recipient} ${receipt.amountPRL} PRL with ${confs} confirmation(s)`);
  }
  return { proven: reasons.length === 1 && confs >= 1 && paidGrains >= receipt.amountGrains, reasons };
}

/* ------------------------------------------------------------------ */
/* Lifecycle classification                                            */
/* ------------------------------------------------------------------ */

/**
 * Classify a campaign against Blockbook stats and a chain tip.
 *   "unfunded"      — nothing received yet
 *   "funding"       — raised something, below goal
 *   "goal-met"      — raised >= goal
 *   "past-deadline" — tip >= deadline (takes precedence: funding may still
 *                     continue, but the window the organizer named is over)
 * Returns { status, raisedGrains, blocksLeft, approxCountdown, detail }.
 * blocksLeft is null when there is no deadline or no tip (tip optional).
 */
export function classifyCampaign(campaign, stats, tipHeight = null) {
  if (tipHeight !== null && (!Number.isSafeInteger(tipHeight) || tipHeight <= 0)) {
    throw new Error("bad tip height");
  }
  const raised = stats && Number.isSafeInteger(stats.receivedGrains) ? stats.receivedGrains : 0;
  const dl = campaign.deadlineHeight;
  const past = dl !== null && tipHeight !== null && tipHeight >= dl;
  const blocksLeft = dl !== null && tipHeight !== null ? Math.max(0, dl - tipHeight) : null;
  let status, detail;
  if (past) {
    status = "past-deadline";
    detail = `deadline height ${dl} reached (tip ${tipHeight}) — the named giving window is over; donations can still arrive`;
  } else if (raised >= campaign.goalGrains && campaign.goalGrains > 0) {
    status = "goal-met";
    detail = `goal met: ${fmtPRL(raised)} PRL raised of ${campaign.goalPRL} PRL`;
  } else if (raised > 0) {
    status = "funding";
    detail = `${fmtPRL(raised)} PRL raised of ${campaign.goalPRL} PRL so far`;
  } else {
    status = "unfunded";
    detail = "no donations seen at the campaign address yet";
  }
  return { status, raisedGrains: raised, blocksLeft, approxCountdown: formatDeadlineCountdown(blocksLeft), detail };
}

/** Block countdown → approximate days, labeled approximate, loudly. */
export function formatDeadlineCountdown(blocksLeft) {
  if (blocksLeft === null) return "no deadline set";
  if (blocksLeft <= 0) return "deadline reached";
  const days = (blocksLeft * PEARL_BLOCK_SECS) / 86400;
  const dayStr = days >= 10 ? Math.round(days).toString() : days.toFixed(1);
  return `≈ ${dayStr} days (${blocksLeft} blocks) — approximate; the chain decides, not the clock`;
}

/** Donor count from the local receipt ledger rows. */
export function countDonors(receipts) {
  const seen = new Set();
  for (const r of receipts || []) {
    if (r && r.donor) seen.add(String(r.donor));
  }
  return seen.size;
}
