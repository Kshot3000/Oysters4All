/* Pearl Treasury core — DAO/team treasury command-center logic for PRL.
 *
 * Pure ESM. The browser ships a committed esbuild IIFE bundle
 * (pearl-treasury.bundle.js); node runs this file directly for tests.
 *
 * What this does:
 *   1. Vaults: register m-of-n Taproot vaults via `covenant:v1:` descriptors
 *      (the audited covenant-core vault construction — NUMS internal key,
 *      CHECKSIGADD multisig leaf); GET-only Blockbook balance tracking with
 *      confirmed/unconfirmed lifecycle rows and PRL + grains totals.
 *   2. Proposals: tamper-evident spend proposals (SHA-256 id + 64-bit
 *      fingerprint over a canonical JSON body). Amounts use integer grain
 *      math only — never floats. Payees must be valid P2TR addresses.
 *   3. Sign: cosigner approval bridges a proposal into a covenant signing
 *      round; signatures are Schnorr-verified per signature against the
 *      round digest BEFORE storage; quorum is k-of-m; wrong keys are loudly
 *      refused. Key material is held in memory only and can be wiped.
 *   4. Disburse: at quorum, finalize the real Taproot script-path spend with
 *      exact vBytes fee planning and dust refusal; raw hex out; broadcast
 *      via Blockbook. Scheduled/recurring payouts are an honest schedule
 *      table (calendar dates, no on-chain enforcement — Pearl has no smart
 *      contracts).
 *   5. Audit: append-only, hash-chained local audit log of proposals,
 *      approvals, disbursements, and schedule events, with a tamper check
 *      and JSON/CSV export.
 *
 * Crypto lineage (NO new cryptography here): key derivation, TapTweak,
 * bech32m, BIP-341 sighash, wire serialization, fee math, and Blockbook
 * come from the audited files/pages/sign/src/crypto.js (+sign-core.js);
 * covenant vaults, descriptors, signing rounds, script-path spend planning
 * and finalization come from files/pages/covenant/src/covenant-core.js,
 * which itself builds on files/pages/escrow/src/escrow-core.js. The only
 * new code is orchestration: proposals, schedules, audit chaining, coin
 * selection over vault UTXOs, and memory key hygiene.
 */

import {
  covenantFromDescriptor, covenantDescriptor, createCovenant, buildSigningRound,
  parseRound, serializeRound, signRound, importSig, roundStatus, finalizeRound,
  describeRound, covenantSpendVBytes, pubkeyFromPriv,
  NETWORKS, GRAIN_PER_PRL, DUST_GRAIN,
  sha256, bytesToHex, hexToBytes,
  fetchUtxos, fetchFeeRateGrainsPerVByte, broadcastTx, fetchTxStatus,
  newMnemonic, walletFromMnemonic, addressToProgram,
} from "../../covenant/src/covenant-core.js";
import { walletFromPriv } from "../../sign/src/crypto.js";
import { parsePRL, fmtPRL } from "../../sign/src/sign-core.js";
import { walletFromWIF } from "../../sign/src/crypto.js";

export {
  NETWORKS, GRAIN_PER_PRL, DUST_GRAIN,
  sha256, bytesToHex, hexToBytes,
  fetchUtxos, fetchFeeRateGrainsPerVByte, broadcastTx, fetchTxStatus,
  newMnemonic, walletFromMnemonic, addressToProgram,
  covenantFromDescriptor, covenantDescriptor, createCovenant, buildSigningRound,
  parseRound, serializeRound, signRound, importSig, roundStatus, finalizeRound,
  describeRound, covenantSpendVBytes, pubkeyFromPriv,
  parsePRL, fmtPRL, walletFromPriv,
};

export const PROPOSAL_KIND = "pearl-treasury-proposal";
export const PROPOSAL_VERSION = 1;
export const AUDIT_VERSION = 1;
export const MEMO_MAX = 280;
export const LABEL_MAX = 64;
export const BLOCKBOOK_MAINNET = NETWORKS.mainnet.blockbook;

/* ---------------- canonical JSON + hashing (not cryptography: only used
 * for tamper-evident ids and the audit chain, on top of the audited
 * sha256) ---------------- */

function canon(v) {
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  if (v !== null && typeof v === "object") {
    return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
  }
  return JSON.stringify(v);
}

export function sha256HexBytes(bytes) {
  return bytesToHex(sha256(bytes));
}

export function sha256HexText(s) {
  return sha256HexBytes(new TextEncoder().encode(String(s)));
}

/** Stable SHA-256 id + 64-bit fingerprint for any canonical-JSON body. */
export function tamperId(body) {
  const id = sha256HexText(canon(body));
  return { id, fingerprint: id.slice(0, 16) };
}

/* ---------------- amounts: integer grain math, never floats ---------------- */

/** Parse a PRL decimal string into integer grains (Number, safe). Throws. */
export function prlToGrains(amountPRL) {
  const g = parsePRL(amountPRL); // BigInt, rejects >8 decimals and garbage
  if (g > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("amount exceeds safe integer range");
  const n = Number(g);
  if (n < DUST_GRAIN) throw new Error(`amount below dust floor (${DUST_GRAIN} grains)`);
  return n;
}

export function grainsToPRL(grains) {
  return fmtPRL(BigInt(grains));
}

/* ---------------- vaults ---------------- */

/**
 * Register a vault from a covenant:v1 descriptor (+ a human label). The
 * descriptor is fully re-derived and re-verified; a tampered descriptor
 * can never register. Returns a serializable vault record (no secrets).
 */
export function registerVault({ descriptor, label }, network) {
  const covenant = covenantFromDescriptor(descriptor, network);
  const lab = String(label || "").trim().slice(0, LABEL_MAX);
  if (!lab) throw new Error("vault needs a label");
  const { id } = tamperId({ kind: "pearl-treasury-vault", descriptor: covenantDescriptor(covenant) });
  return {
    kind: "pearl-treasury-vault",
    version: 1,
    id,
    label: lab,
    network: network.id,
    descriptor: covenantDescriptor(covenant),
    address: covenant.address,
    m: covenant.m,
    n: covenant.n,
    keys: covenant.keys.map((k) => k.xonly),
    registeredAt: new Date().toISOString(),
    balance: { confirmed: 0, unconfirmed: 0, utxoCount: 0, refreshedAt: null },
  };
}

/** Generate a fresh demo m-of-n vault in memory. The mnemonics are shown to
 *  the user ONCE; only the descriptor registers. For testing only — the
 *  app labels demo vaults loudly. */
export function generateDemoVault({ m, n, network, label }) {
  if (!Number.isInteger(m) || !Number.isInteger(n) || m < 1 || m > n || n > 16) {
    throw new Error("demo vault needs 1 <= m <= n <= 16");
  }
  const mnemonics = Array.from({ length: n }, () => newMnemonic());
  const { covenant, secrets } = createCovenant({ m, keyInputs: mnemonics, network });
  const vault = registerVault({ descriptor: covenantDescriptor(covenant), label }, network);
  vault.demo = true;
  return { vault, mnemonics, secrets };
}

/**
 * GET-only Blockbook balance read for a vault address. Returns per-vault
 * lifecycle: confirmed vs unconfirmed grains, UTXO count, refresh time.
 * The raw UTXOs ride along for coin selection (caller decides what to show).
 */
export async function fetchVaultBalance(blockbookBase, vault) {
  if (!blockbookBase) throw new Error("no blockbook URL for this network");
  const utxos = await fetchUtxos(blockbookBase, vault.address);
  let confirmed = 0, unconfirmed = 0;
  for (const u of utxos) {
    if (u.confirmations > 0) confirmed += u.value;
    else unconfirmed += u.value;
  }
  return {
    confirmed,
    unconfirmed,
    utxoCount: utxos.length,
    refreshedAt: new Date().toISOString(),
    utxos: utxos.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, confirmations: u.confirmations })),
  };
}

/** Sum confirmed/unconfirmed across a vault list (integer grain math). */
export function vaultTotals(vaults) {
  let confirmed = 0, unconfirmed = 0, count = 0;
  for (const v of vaults) {
    confirmed += v.balance?.confirmed || 0;
    unconfirmed += v.balance?.unconfirmed || 0;
    count += 1;
  }
  return { confirmed, unconfirmed, total: confirmed + unconfirmed, count };
}

/* ---------------- proposals ---------------- */

const PROPOSAL_TRANSITIONS = {
  open: ["quorum", "disbursed", "cancelled"],
  quorum: ["disbursed", "cancelled"],
  disbursed: [],
  cancelled: [],
};

export function assertProposalTransition(from, to) {
  if (!(PROPOSAL_TRANSITIONS[from] || []).includes(to)) {
    throw new Error(`illegal proposal transition ${from} -> ${to}`);
  }
}

/**
 * Create a tamper-evident spend proposal. amountPRL is a decimal string
 * parsed with integer grain math; payee must be a valid P2TR address for
 * the network. The id/fingerprint cover the immutable intent only.
 */
export function createProposal({ vault, payee, amountPRL, memo, dueDateISO, recurrence, createdBy }, network) {
  if (!vault?.descriptor) throw new Error("proposal needs a registered vault");
  covenantFromDescriptor(vault.descriptor, network); // re-verify vault
  const to = String(payee || "").trim();
  addressToProgram(to, network); // throws on wrong HRP / non-P2TR
  const amountGrains = prlToGrains(amountPRL);
  const mem = String(memo || "").trim().slice(0, MEMO_MAX);
  const by = String(createdBy || "").trim().slice(0, LABEL_MAX) || "treasury";
  let due = null;
  if (dueDateISO) {
    const t = new Date(String(dueDateISO)).getTime();
    if (!Number.isFinite(t)) throw new Error("bad due date");
    due = new Date(t).toISOString();
  }
  const rec = recurrence ? validateRecurrence(recurrence) : null;
  const body = {
    kind: PROPOSAL_KIND,
    version: PROPOSAL_VERSION,
    vault: vault.descriptor,
    payee: to,
    amountGrains,
    memo: mem,
    dueDate: due,
    recurrence: rec,
    createdBy: by,
    createdAt: new Date().toISOString(),
  };
  const { id, fingerprint } = tamperId(body);
  return { ...body, id, fingerprint, status: "open", roundDigests: [], txids: [] };
}

/** Re-verify a proposal: recompute the id/fingerprint and re-validate the
 *  vault, payee, and amount. Returns the proposal unchanged; throws on any
 *  tampering. */
export function verifyProposal(proposal, network) {
  if (!proposal || proposal.kind !== PROPOSAL_KIND || proposal.version !== PROPOSAL_VERSION) {
    throw new Error("not a Pearl Treasury proposal");
  }
  const { id, fingerprint, status, roundDigests, txids, ...body } = proposal;
  const again = tamperId(body);
  if (again.id !== id || again.fingerprint !== fingerprint) {
    throw new Error("proposal id mismatch — the proposal was tampered with");
  }
  covenantFromDescriptor(proposal.vault, network);
  addressToProgram(proposal.payee, network);
  if (!Number.isSafeInteger(proposal.amountGrains) || proposal.amountGrains < DUST_GRAIN) {
    throw new Error("proposal amount invalid");
  }
  if (!Object.keys(PROPOSAL_TRANSITIONS).includes(status)) throw new Error("proposal has bad status");
  return proposal;
}

/** Serialize a proposal for copy/paste sharing between cosigners. */
export function serializeProposal(proposal) {
  return JSON.stringify(proposal);
}

export function parseProposal(json, network) {
  let p;
  try {
    p = typeof json === "string" ? JSON.parse(json) : json;
  } catch {
    throw new Error("proposal is not valid JSON");
  }
  return verifyProposal(p, network);
}

/* ---------------- proposal -> covenant signing round bridge ---------------- */

/**
 * Pick the smallest vault UTXO that covers amount + exact planned fee.
 * Uses covenantSpendVBytes (worst-case witness: m sigs + n-m empties) for
 * exact vBytes fee planning. Throws on insufficient funds.
 */
export function selectUtxoForProposal(covenant, utxos, amountGrains, feeRateGrainsPerVByte) {
  if (!Number.isFinite(feeRateGrainsPerVByte) || feeRateGrainsPerVByte <= 0) {
    throw new Error("bad fee rate");
  }
  const vBytes2 = covenantSpendVBytes(covenant, 2); // payment + change
  const vBytes1 = covenantSpendVBytes(covenant, 1); // payment, no change
  const fee2 = Math.ceil(vBytes2 * feeRateGrainsPerVByte);
  const fee1 = Math.ceil(vBytes1 * feeRateGrainsPerVByte);
  const cand = (utxos || [])
    .filter((u) => Number.isSafeInteger(u.value) && u.value > 0 && /^[0-9a-f]{64}$/i.test(u.txid || ""))
    .sort((a, b) => a.value - b.value);
  for (const u of cand) {
    if (u.value >= amountGrains + fee2) return { utxo: u, vBytes: vBytes2, fee: fee2 };
    if (u.value >= amountGrains + fee1) return { utxo: u, vBytes: vBytes1, fee: fee1 };
  }
  throw new Error(`insufficient funds: no vault UTXO covers ${grainsToPRL(amountGrains)} PRL + fee`);
}

/**
 * Build the covenant signing round for a proposal (one UTXO, one payee
 * payment, change back to the vault). Re-verifies the proposal first, so a
 * tampered proposal can never reach signing.
 */
export function buildProposalRound(vault, proposal, network, { utxo, feeRateGrainsPerVByte, memo }) {
  verifyProposal(proposal, network);
  const covenant = covenantFromDescriptor(vault.descriptor, network);
  if (proposal.vault !== covenantDescriptor(covenant)) {
    throw new Error("proposal vault does not match this vault");
  }
  const round = buildSigningRound(covenant, network, {
    utxo: { txid: utxo.txid, vout: utxo.vout, value: utxo.value },
    payments: [{ address: proposal.payee, valueGrains: proposal.amountGrains }],
    feeRateGrainsPerVByte,
    memo: memo ?? proposal.memo,
  });
  proposal.roundDigests.push(round.digest);
  return { round, covenant };
}

/** Check that a parsed round actually spends the proposal's intent: same
 *  vault, same payee, same amount, exactly the planSpend outputs. */
export function roundMatchesProposal(proposal, round, covenant, network) {
  if (round.covenant !== proposal.vault) return { ok: false, why: "round is for a different vault" };
  const pay = round.outputs.filter((o) => !o.change);
  if (pay.length !== 1) return { ok: false, why: "round has unexpected payment outputs" };
  const [p] = pay;
  if (p.address !== proposal.payee) return { ok: false, why: "round payee differs from proposal" };
  if (p.value !== proposal.amountGrains) return { ok: false, why: "round amount differs from proposal" };
  const ch = round.outputs.filter((o) => o.change);
  if (ch.length > 1) return { ok: false, why: "round has too many change outputs" };
  if (ch.length === 1) {
    const cprog = addressToProgram(ch[0].address, network);
    const vprog = addressToProgram(covenant.address, network);
    if (bytesToHex(cprog) !== bytesToHex(vprog)) return { ok: false, why: "round change goes to a foreign address" };
  }
  return { ok: true };
}

/**
 * Finalize a quorum-reached round into a broadcast-ready tx. Requires the
 * round to match the proposal (intent check) and m-of-n quorum.
 */
export function finalizeProposalSpend(proposal, round, covenant, network) {
  const match = roundMatchesProposal(proposal, round, covenant, network);
  if (!match.ok) throw new Error("refusing to finalize: " + match.why);
  return finalizeRound(round, covenant, network); // { txid, hex, digest, vBytes, ... }
}

/* ---------------- in-memory key vault (keys never touch localStorage) ---------------- */

export function createKeyVault() {
  const keys = new Map(); // label -> { priv: Uint8Array, xonly: hex }
  return {
    set(label, privBytes, xonlyHex) {
      const p = privBytes instanceof Uint8Array ? privBytes.slice() : hexToBytes(String(privBytes).trim());
      if (p.length !== 32) throw new Error("private key must be 32 bytes");
      keys.set(String(label), { priv: p, xonly: String(xonlyHex).toLowerCase() });
    },
    get(label) {
      return keys.get(String(label)) || null;
    },
    labels() {
      return [...keys.keys()];
    },
    has(label) {
      return keys.has(label);
    },
    /** Overwrite every key with zeros and drop all references. */
    wipe() {
      for (const k of keys.values()) k.priv.fill(0);
      keys.clear();
    },
  };
}

/** Parse a cosigner key input (64-hex priv | WIF | 12/24-word mnemonic) into
 *  { priv: Uint8Array, xonly: hex }. 64-hex here is a PRIVATE key — unlike
 *  partyKeyFromInput (x-only pubkey), this is the signing path. */
export function cosignerKeyFromInput(input, network) {
  const t = String(input || "").trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) {
    const priv = hexToBytes(t);
    return { priv, xonly: pubkeyFromPriv(priv) };
  }
  if (/^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{40,60}$/.test(t)) {
    // WIF — validated by walletFromWIF (network version checked there)
    const w = walletFromWIF(t, network);
    return { priv: w.priv, xonly: bytesToHex(w.internalXOnly) };
  }
  const words = t.split(/\s+/);
  if (words.length === 12 || words.length === 24) {
    const w = walletFromMnemonic(t, network);
    return { priv: w.priv, xonly: bytesToHex(w.internalXOnly) };
  }
  throw new Error("cosigner key must be 64-hex private key, WIF, or a 12/24-word mnemonic");
}

/* ---------------- recurring schedules (honest calendar table) ---------------- */

export const RECURRENCE_UNITS = ["days", "weeks", "months"];

export function validateRecurrence(rec) {
  if (!rec) return null;
  const unit = String(rec.unit || "").toLowerCase();
  const every = Number(rec.every);
  if (!RECURRENCE_UNITS.includes(unit)) throw new Error("recurrence unit must be days, weeks, or months");
  if (!Number.isInteger(every) || every < 1 || every > 120) throw new Error("recurrence 'every' must be 1..120");
  return { unit, every };
}

/** Next due date strictly after `afterISO` for a start + recurrence. Pure
 *  calendar math — nothing here touches the chain. */
export function nextDueISO(startISO, recurrence, afterISO) {
  const start = new Date(startISO).getTime();
  const after = new Date(afterISO ?? new Date().toISOString()).getTime();
  if (!Number.isFinite(start)) throw new Error("bad schedule start");
  if (!recurrence) return new Date(start).toISOString();
  const { unit, every } = validateRecurrence(recurrence);
  const d = new Date(start);
  let guard = 0;
  while (d.getTime() <= after && guard++ < 5000) {
    if (unit === "days") d.setUTCDate(d.getUTCDate() + every);
    else if (unit === "weeks") d.setUTCDate(d.getUTCDate() + 7 * every);
    else d.setUTCMonth(d.getUTCMonth() + every);
  }
  if (guard >= 5000) throw new Error("schedule runaway");
  return d.toISOString();
}

/* ---------------- audit log: append-only, hash-chained ---------------- */

export function auditAppend(log, { kind, actor, detail }) {
  const arr = Array.isArray(log) ? log : [];
  const prev = arr.length ? arr[arr.length - 1].hash : "GENESIS";
  const entry = {
    version: AUDIT_VERSION,
    seq: arr.length,
    ts: new Date().toISOString(),
    kind: String(kind || "note"),
    actor: String(actor || "treasury").slice(0, LABEL_MAX),
    detail: String(detail || "").slice(0, 1000),
    prev,
  };
  entry.hash = sha256HexText(prev + canon(entry));
  arr.push(entry);
  return entry;
}

/** Verify the whole chain: seq order, prev linkage, hash recompute. */
export function verifyAuditChain(log) {
  const arr = Array.isArray(log) ? log : [];
  let prev = "GENESIS";
  for (let i = 0; i < arr.length; i++) {
    const e = arr[i];
    if (e.seq !== i) return { ok: false, badSeq: i, why: `seq out of order at index ${i}` };
    if (e.prev !== prev) return { ok: false, badSeq: i, why: `prev link broken at seq ${i}` };
    const { hash, ...body } = e;
    if (sha256HexText(e.prev + canon(body)) !== hash) {
      return { ok: false, badSeq: i, why: `hash mismatch at seq ${i} — entry tampered` };
    }
    prev = hash;
  }
  return { ok: true, entries: arr.length, head: prev };
}

function csvCell(s) {
  let t = String(s ?? "");
  // Spreadsheet formula-injection guard (CWE-1236): a cell whose text begins
  // (after optional spaces) with =, +, -, @, | or % is executed as a formula
  // when the CSV is opened in Excel/Sheets — quoting does NOT prevent it.
  // Prefix such cells with an apostrophe so they open as text. Plain numbers
  // (including negative amounts) are data, not formulas, and pass untouched.
  if (!/^-?\d+(\.\d+)?$/.test(t) && /^\s*[=+\-@|%]/.test(t)) t = "'" + t;
  return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
}

export function exportAuditJSON(log) {
  return JSON.stringify(log || [], null, 2);
}

export function exportAuditCSV(log) {
  const rows = [["seq", "ts", "kind", "actor", "detail", "prev", "hash"]];
  for (const e of log || []) {
    rows.push([e.seq, e.ts, e.kind, e.actor, e.detail, e.prev, e.hash].map(csvCell));
  }
  return rows.map((r) => r.join(",")).join("\n") + "\n";
}
