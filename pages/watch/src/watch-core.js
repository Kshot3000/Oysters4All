// Pearl Watch core: the lighthouse watchtower for PRL.
//
// Watch-only, read-only alerting desk: track bech32m addresses over GET-only
// Blockbook reads, evaluate user alert rules against fresh snapshots, log
// edge-triggered events, and track any txid's confirmation progress.
//
// Crypto policy: NO new cryptography. Address validation reuses the audited
// Pearl Sign lineage (../../sign/src/crypto.js: decodeBech32m, NETWORKS — the
// same rules pearld's DecodeAddress enforces: bech32m, witness v1+ only, 32-byte
// program). Amount formatting reuses audited fmtPRL/parsePRL from sign-core.
// Everything else here is bookkeeping: diffing, rule evaluation, CSV export.
//
// Protocol facts (do not re-derive): bech32m prl1.../tprl1... Taproot-only;
// NO smart contracts on Pearl; 1 PRL = 1e8 grains; Blockbook is a third-party
// service — its data is convenience, not consensus.
import {
  NETWORKS, GRAIN_PER_PRL,
  decodeBech32m, encodeBech32m, sha256,
} from "../../sign/src/crypto.js";
import { fmtPRL, parsePRL } from "../../sign/src/sign-core.js";

export { NETWORKS, GRAIN_PER_PRL, fmtPRL, parsePRL, decodeBech32m, encodeBech32m, sha256 };

export const WATCH_VERSION = 1;
export const MAX_WATCHED = 250;       // sanity cap, matches Batch's recipient cap
export const MAX_RULES = 100;
export const MAX_EVENTS = 2000;       // ring-buffered in storage
export const MIN_POLL_MS = 15000;
export const DEFAULT_POLL_MS = 60000;

/* ---------------- address validation ---------------- */

/**
 * Validate an address for the watchlist. Throws loudly on anything pearld
 * would reject: wrong HRP, non-bech32m, witness v0, wrong program length.
 * Returns the normalized (lower-cased, checksummed) address.
 */
export function validateWatchAddress(address, network) {
  if (typeof address !== "string" || !address.trim()) {
    throw new Error("address is empty");
  }
  const addr = address.trim();
  let d;
  try {
    d = decodeBech32m(addr, network.hrp);
  } catch (e) {
    throw new Error(`WATCH REFUSED: not a valid ${network.label} Taproot address — ${e.message}`);
  }
  if (d.version !== 1) {
    throw new Error(`WATCH REFUSED: witness v${d.version} rejected — Pearl is Taproot-only (v1)`);
  }
  if (d.program.length !== 32) {
    throw new Error(`WATCH REFUSED: v1 program must be 32 bytes, got ${d.program.length}`);
  }
  return encodeBech32m(network.hrp, 1, d.program); // canonical lowercase
}

export function networkForHrp(hrp) {
  for (const n of Object.values(NETWORKS)) if (n.hrp === hrp) return n;
  throw new Error(`unsupported hrp "${hrp}"`);
}

/* ---------------- small pure helpers ---------------- */

/**
 * Coerce a grains value (BigInt, integer number, numeric string, or the
 * "123n"-suffixed strings serializeWatchState emits) to BigInt. Throws on
 * anything else — never silently truncates.
 */
export function parseGrains(v, what = "grains") {
  if (typeof v === "bigint") {
    if (v < 0n) throw new Error(`RULE REFUSED: ${what} must be a non-negative integer number of grains`);
    return v;
  }
  if (typeof v === "number") {
    if (!Number.isInteger(v) || v < 0) throw new Error(`RULE REFUSED: ${what} must be a non-negative integer number of grains`);
    return BigInt(v);
  }
  const m = String(v).trim().match(/^(\d+)n?$/);
  if (!m) throw new Error(`RULE REFUSED: ${what} must be a non-negative integer number of grains`);
  return BigInt(m[1]);
}

export function shortAddr(a) {
  return a && a.length > 22 ? a.slice(0, 14) + "…" + a.slice(-6) : String(a);
}
export function shortTxid(t) {
  return t && t.length > 18 ? t.slice(0, 10) + "…" + t.slice(-6) : String(t);
}
export function fmtTime(ms) {
  const d = new Date(Number(ms));
  return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}
export function fmtAge(ms, nowMs) {
  const s = Math.max(0, Math.floor((Number(nowMs) - Number(ms)) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
export function uid(prefix) {
  const r = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
  return `${prefix}-${Date.now().toString(36)}-${r}`;
}

/* ---------------- Blockbook reads (GET-only) ---------------- */

export function normalizeBlockbookBase(s) {
  const t = String(s ?? "").trim().replace(/\/$/, "");
  if (!t) throw new Error("Blockbook URL is empty — set one or stay offline");
  if (!/^https?:\/\//.test(t)) throw new Error("Blockbook URL must start with http(s)://");
  return t;
}

/**
 * GET {base}/api/v2/address/<addr>?details=txs&pageSize=25
 * Returns { balance, totalReceived, totalSent, txs, txCount } with grain BigInts.
 * NOTE: Blockbook's `balance` is a decimal string of grains. txs entries carry
 * txid, blockHeight, confirmations, valueIn, value, fees (grains, strings).
 */
export async function fetchAddressSnapshot(fetcher, blockbookBase, address) {
  const base = normalizeBlockbookBase(blockbookBase);
  const url = `${base}/api/v2/address/${encodeURIComponent(address)}?details=txs&pageSize=25`;
  let res;
  try {
    res = await fetcher(url);
  } catch (e) {
    throw new Error(`blockbook unreachable: ${e.message}`);
  }
  if (!res.ok) throw new Error(`blockbook ${res.status} on ${url}`);
  const data = JSON.parse(await res.text());
  const big = (v) => (v == null ? 0n : BigInt(String(v)));
  const txs = Array.isArray(data.transactions) ? data.transactions
    : Array.isArray(data.txs) ? data.txs : [];
  return {
    address,
    fetchedAt: Date.now(),
    balance: big(data.balance),
    totalReceived: big(data.totalReceived),
    totalSent: big(data.totalSent),
    txCount: Number(data.txCount ?? txs.length ?? 0),
    txs: txs.map((t) => ({
      txid: String(t.txid || t),
      blockHeight: t.blockHeight == null ? null : Number(t.blockHeight),
      confirmations: t.confirmations == null ? null : Number(t.confirmations),
      valueIn: t.valueIn != null ? big(t.valueIn) : null,
      value: t.value != null ? big(t.value) : null,
      fees: t.fees != null ? big(t.fees) : null,
    })),
  };
}

export async function fetchTxDetail(fetcher, blockbookBase, txid) {
  if (!/^[0-9a-fA-F]{64}$/.test(String(txid))) throw new Error("txid must be 64 hex chars");
  const base = normalizeBlockbookBase(blockbookBase);
  const url = `${base}/api/v2/tx/${String(txid).toLowerCase()}`;
  let res;
  try {
    res = await fetcher(url);
  } catch (e) {
    throw new Error(`blockbook unreachable: ${e.message}`);
  }
  if (!res.ok) throw new Error(`blockbook ${res.status} on ${url}`);
  return JSON.parse(await res.text());
}

/** GET {base}/api/status — returns chain tip height (backend.blocks). */
export async function fetchTipHeight(fetcher, blockbookBase) {
  const base = normalizeBlockbookBase(blockbookBase);
  const url = `${base}/api/status`;
  let res;
  try {
    res = await fetcher(url);
  } catch (e) {
    throw new Error(`blockbook unreachable: ${e.message}`);
  }
  if (!res.ok) throw new Error(`blockbook ${res.status} on ${url}`);
  const data = JSON.parse(await res.text());
  const h = Number(data?.backend?.blocks);
  if (!Number.isFinite(h)) throw new Error("blockbook /api/status returned no backend.blocks");
  return h;
}

/**
 * Per-address summary of one full tx: grains received by and sent from the
 * watched address, via Blockbook's vin/vout address attribution. Labeled a
 * heuristic honestly — Blockbook attribution is third-party data.
 */
export function summarizeTxForAddress(tx, address) {
  const addr = String(address).toLowerCase();
  let received = 0n, sent = 0n;
  for (const o of tx?.vout || []) {
    const addrs = (o.addresses || []).map((a) => String(a).toLowerCase());
    if (addrs.includes(addr)) received += BigInt(String(o.value));
  }
  for (const i of tx?.vin || []) {
    const addrs = (i.addresses || []).map((a) => String(a).toLowerCase());
    if (addrs.includes(addr)) sent += BigInt(String(i.value));
  }
  const blockHeight = tx?.blockHeight == null ? null : Number(tx.blockHeight);
  const confirmations = tx?.confirmations == null ? null : Number(tx.confirmations);
  return {
    txid: String(tx?.txid ?? ""),
    received, sent, net: received - sent,
    blockHeight, confirmations,
    unconfirmed: blockHeight == null || blockHeight < 0,
  };
}

/** Confirmations for a tx given tip height (Blockbook value wins when present). */
export function txConfirmations(tx, tipHeight) {
  if (tx?.confirmations != null && Number.isFinite(Number(tx.confirmations))) {
    return Math.max(0, Number(tx.confirmations));
  }
  if (tx?.blockHeight == null || Number(tx.blockHeight) < 0) return 0;
  if (!Number.isFinite(Number(tipHeight))) return 0;
  return Math.max(0, Number(tipHeight) - Number(tx.blockHeight) + 1);
}

export function confirmationProgress(tx, tipHeight, target) {
  const conf = txConfirmations(tx, tipHeight);
  const t = Math.max(1, Number(target) | 0);
  return { confirmations: conf, target: t, remaining: Math.max(0, t - conf), done: conf >= t };
}

/* ---------------- snapshots & diffs ---------------- */

/** Diff a previous address snapshot against a fresh one. Pure. */
export function diffSnapshots(prev, next) {
  const prevTxids = new Set((prev?.txs || []).map((t) => t.txid));
  const newTxids = (next?.txs || []).map((t) => t.txid).filter((id) => !prevTxids.has(id));
  const balanceDelta = (next?.balance ?? 0n) - (prev?.balance ?? 0n);
  return { newTxids, balanceDelta, firstSeen: !prev };
}

/* ---------------- alert rules ---------------- */

export const RULE_KINDS = Object.freeze({
  incoming: "incoming ≥ amount",        // any new incoming tx with received >= minGrains
  outgoing: "outgoing ≥ amount",        // any new outgoing tx with sent >= minGrains
  "balance-above": "balance crosses above", // edge: prev < threshold <= next
  "balance-below": "balance crosses below", // edge: prev > threshold >= next
  "tx-confirmed": "txid reaches N confirmations", // specific txid
});

const RULE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Validate + normalize a rule. Throws loudly on bad config (bad address,
 * non-positive amount, unknown kind, txid malformed).
 * rule: { id?, kind, address (required except tx-confirmed), txid?, minGrains?, thresholdGrains?, target?, label?, enabled }
 */
export function normalizeRule(rule, network) {
  if (!rule || typeof rule !== "object") throw new Error("rule must be an object");
  const kind = rule.kind;
  if (!RULE_KINDS[kind]) throw new Error(`unknown rule kind "${kind}"`);
  const id = rule.id || uid("rule");
  if (!RULE_ID_RE.test(id)) throw new Error("rule id malformed");
  const out = {
    id, kind,
    label: String(rule.label || "").slice(0, 120),
    enabled: rule.enabled !== false,
    address: null, txid: null, minGrains: null, thresholdGrains: null, target: null,
    state: { ...(rule.state || {}) }, // edge-trigger memory (persisted)
  };
  if (kind === "tx-confirmed") {
    if (!/^[0-9a-fA-F]{64}$/.test(String(rule.txid || ""))) {
      throw new Error("RULE REFUSED: tx-confirmed needs a 64-hex-char txid");
    }
    out.txid = String(rule.txid).toLowerCase();
    const t = Number(rule.target);
    if (!Number.isInteger(t) || t < 1 || t > 100000) throw new Error("RULE REFUSED: target must be 1..100000 confirmations");
    out.target = t;
  } else {
    if (!rule.address) throw new Error("RULE REFUSED: rule needs a watched address");
    out.address = validateWatchAddress(rule.address, network);
    if (kind === "incoming" || kind === "outgoing") {
      out.minGrains = parseGrains(rule.minGrains ?? 0n, "amount");
    } else {
      out.thresholdGrains = parseGrains(rule.thresholdGrains ?? 0n, "threshold");
    }
  }
  return out;
}

function ruleEvent(rule, kind, fields, nowMs) {
  return {
    id: uid("ev"),
    ts: nowMs,
    ruleId: rule.id,
    ruleLabel: rule.label || "",
    kind, // incoming | outgoing | balance-above | balance-below | tx-confirmed
    address: fields.address || null,
    txid: fields.txid || null,
    grains: fields.grains != null ? String(fields.grains) : null,
    confirmations: fields.confirmations ?? null,
    message: fields.message || "",
  };
}

/**
 * Evaluate enabled rules against fresh snapshots.
 *   snapshots: Map address -> fresh snapshot (from fetchAddressSnapshot)
 *   prev:      Map address -> previous snapshot (may be missing)
 *   rules:     array of normalized rules (their .state is mutated/persisted)
 *   newTxDetails: Map txid -> full tx detail (for incoming/outgoing attribution)
 *   txDetails: Map txid -> full tx detail (for tx-confirmed rules)
 *   tipHeight: number|null
 * Returns { events, rules } — rules carry updated .state (persist it).
 * Pure apart from rule.state mutation, which callers persist.
 */
export function evaluateRules({ snapshots, prev, rules, newTxDetails, txDetails, tipHeight, nowMs }) {
  const now = Number(nowMs ?? Date.now());
  const events = [];
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const st = (rule.state = rule.state || {});
    try {
      if (rule.kind === "incoming" || rule.kind === "outgoing") {
        const snap = snapshots.get(rule.address);
        const p = prev.get(rule.address);
        if (!snap) continue;
        if (!p) {
          // First sight: history is not news. Silently mark current txids as
          // seen so only genuinely new txs fire events on later sweeps.
          st.seenTxids = (snap.txs || []).map((t) => t.txid).slice(-500);
          continue;
        }
        const { newTxids } = diffSnapshots(p || null, snap);
        for (const txid of newTxids) {
          if (st.seenTxids && st.seenTxids.includes(txid)) continue;
          const detail = newTxDetails.get(txid);
          if (!detail) continue; // unattributed without the full tx — skip honestly
          const sum = summarizeTxForAddress(detail, rule.address);
          const amt = rule.kind === "incoming" ? sum.received : sum.sent;
          if (amt >= rule.minGrains && amt > 0n) {
            events.push(ruleEvent(rule, rule.kind, {
              address: rule.address, txid,
              grains: amt,
              confirmations: txConfirmations(detail, tipHeight),
              message: `${rule.kind === "incoming" ? "Received" : "Sent"} ${fmtPRL(amt)} PRL ${rule.kind === "incoming" ? "to" : "from"} ${shortAddr(rule.address)}`,
            }, now));
          }
          (st.seenTxids = st.seenTxids || []).push(txid);
          if (st.seenTxids.length > 500) st.seenTxids = st.seenTxids.slice(-500);
        }
      } else if (rule.kind === "balance-above" || rule.kind === "balance-below") {
        const snap = snapshots.get(rule.address);
        const p = prev.get(rule.address);
        if (!snap || !p || p.balance == null) continue;
        const th = rule.thresholdGrains;
        const crossed = rule.kind === "balance-above"
          ? (p.balance < th && snap.balance >= th)
          : (p.balance > th && snap.balance <= th);
        const key = `crossed:${rule.kind}`;
        if (crossed && !st[key]) {
          st[key] = true;
          events.push(ruleEvent(rule, rule.kind, {
            address: rule.address,
            grains: snap.balance,
            message: `Balance ${rule.kind === "balance-above" ? "rose above" : "fell below"} ${fmtPRL(th)} PRL — now ${fmtPRL(snap.balance)} PRL (${shortAddr(rule.address)})`,
          }, now));
        } else if (!crossed) {
          // re-arm when the balance moves back across (hysteresis edge reset)
          st[key] = false;
        }
      } else if (rule.kind === "tx-confirmed") {
        const detail = txDetails.get(rule.txid);
        if (!detail) continue;
        const conf = txConfirmations(detail, tipHeight);
        if (conf >= rule.target && !st.fired) {
          st.fired = true;
          events.push(ruleEvent(rule, "tx-confirmed", {
            txid: rule.txid,
            confirmations: conf,
            message: `${shortTxid(rule.txid)} reached ${conf} confirmation${conf === 1 ? "" : "s"} (target ${rule.target})`,
          }, now));
        } else if (conf < rule.target) {
          st.fired = false; // re-arm if a reorg drops it back (honest re-arm)
        }
      }
    } catch (e) {
      events.push(ruleEvent(rule, "rule-error", {
        message: `rule ${rule.id} evaluation failed: ${e.message}`,
      }, now));
    }
  }
  return { events, rules };
}

/* ---------------- event log / export ---------------- */

export function eventsToCSV(events) {
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = ["ts_utc,kind,rule_id,rule_label,address,txid,grains,confirmations,message"];
  for (const e of events) {
    rows.push([
      new Date(Number(e.ts)).toISOString(), e.kind, e.ruleId, q(e.ruleLabel),
      e.address || "", e.txid || "", e.grains || "",
      e.confirmations ?? "", q(e.message),
    ].join(","));
  }
  return rows.join("\n");
}

export function serializeWatchState(state) {
  const ser = (v) => JSON.parse(JSON.stringify(v, (k, x) => typeof x === "bigint" ? x.toString() + "n" : x));
  return JSON.stringify(ser(state), null, 2);
}

export function deserializeWatchState(json, network) {
  const raw = JSON.parse(String(json));
  if (!raw || typeof raw !== "object") throw new Error("watch state must be an object");
  const watched = [];
  for (const w of raw.watched || []) {
    watched.push({
      address: validateWatchAddress(w.address, network),
      label: String(w.label || "").slice(0, 80),
      addedAt: Number(w.addedAt) || Date.now(),
    });
  }
  const seen = new Set();
  for (const w of watched) {
    if (seen.has(w.address)) throw new Error(`duplicate watched address ${shortAddr(w.address)}`);
    seen.add(w.address);
  }
  if (watched.length > MAX_WATCHED) throw new Error(`too many watched addresses (max ${MAX_WATCHED})`);
  const rules = [];
  for (const r of raw.rules || []) rules.push(normalizeRule(r, network));
  if (rules.length > MAX_RULES) throw new Error(`too many rules (max ${MAX_RULES})`);
  const events = Array.isArray(raw.events) ? raw.events.slice(-MAX_EVENTS) : [];
  return {
    version: WATCH_VERSION,
    network: network.id,
    watched, rules, events,
    blockbook: String(raw.blockbook || ""),
    pollMs: Number(raw.pollMs) || DEFAULT_POLL_MS,
    notify: !!raw.notify,
    sound: !!raw.sound,
  };
}

export function defaultWatchState(network) {
  return {
    version: WATCH_VERSION,
    network: network.id,
    watched: [],
    rules: [],
    events: [],
    blockbook: network.blockbook || "",
    pollMs: DEFAULT_POLL_MS,
    notify: false,
    sound: false,
  };
}
