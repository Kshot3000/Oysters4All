// Pearl Invoice core — receive-only PRL invoicing studio.
//
// Five steps: Compose → Descriptor → Receive → Watch → Receipt, plus a
// standalone Verify tab. NO new cryptography: address validation, SHA-256,
// and BIP-86 derivation all come from the audited Sign core
// (../../sign/src/crypto.js) via the shared importmap.
//
// Grain-exact: all PRL amounts are BigInt grains (1 PRL = 1e8 grains).
import {
  decodeBech32m,
  encodeBech32m,
  NETWORKS,
  GRAIN_PER_PRL,
  walletFromMnemonic,
  walletFromPriv,
} from "../../sign/src/crypto.js";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";

export const DONATE_ADDRESS = "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d";
export const INVOICE_ACCOUNT = 9001; // invoicing account: m/86'/{coin}'/9001'/0/<index>
export const MIN_TOTAL_GRAINS = 546n; // sub-dust totals refused (Pearl dust relay floor)
export const VERSION = "v1";
export const DESCRIPTOR_PREFIX = "pearl-invoice";
export const RECEIPT_PREFIX = "pearl-invoice-receipt";

/* ---------------- amount math (BigInt, grain-exact) ---------------- */

export function parsePRLToGrains(s) {
  if (typeof s !== "string") throw new Error("amount must be text");
  const t = s.trim();
  if (!/^\d+(\.\d{1,8})?$/.test(t)) throw new Error(`bad PRL amount "${t}": up to 8 decimals`);
  const [w, f = ""] = t.split(".");
  const grains = BigInt(w) * BigInt(GRAIN_PER_PRL) + BigInt((f + "00000000").slice(0, 8));
  if (grains <= 0n) throw new Error("amount must be greater than zero");
  return grains;
}

export function formatPRL(grains) {
  const g = BigInt(grains);
  const GPR = BigInt(GRAIN_PER_PRL);
  const w = g / GPR;
  let f = (g % GPR).toString().padStart(8, "0").replace(/0+$/, "");
  return f ? `${w}.${f}` : String(w);
}

/* ---------------- address validation (audited bech32m, v1 only) ---------------- */

export function validateInvoiceAddress(addr) {
  let d;
  try {
    d = decodeBech32m(addr);
  } catch (e) {
    throw new Error(`Not a valid Pearl Taproot address: ${e.message}`);
  }
  const network = d.hrp === "prl" ? NETWORKS.mainnet : d.hrp === "tprl" ? NETWORKS.testnet : null;
  if (!network) throw new Error(`Not a valid Pearl Taproot address: unsupported hrp "${d.hrp}" (want prl1… or tprl1…)`);
  return { hrp: d.hrp, network, address: addr.trim().toLowerCase() };
}

/* ---------------- invoice model ---------------- */

export function buildInvoice({ invoicee, items, dueUnix = null, memo = "", address, payerLabel = "" }) {
  if (!invoicee || !String(invoicee).trim()) throw new Error("invoicee name is required");
  if (!Array.isArray(items) || items.length === 0) throw new Error("refused: at least one line item is required");
  const cleanItems = items.map((it, i) => {
    const desc = String(it.description ?? "").trim();
    if (!desc) throw new Error(`line item ${i + 1}: description is required`);
    const grains = parsePRLToGrains(String(it.amountPRL));
    return { description: desc, grains: grains.toString() };
  });
  const totalGrains = cleanItems.reduce((a, it) => a + BigInt(it.grains), 0n);
  if (totalGrains < MIN_TOTAL_GRAINS) {
    throw new Error(`refused: invoice total ${formatPRL(totalGrains)} PRL is below the dust floor (${MIN_TOTAL_GRAINS} grains)`);
  }
  const { hrp, address: norm } = validateInvoiceAddress(address);
  if (dueUnix != null && dueUnix !== "") {
    dueUnix = Math.floor(Number(dueUnix));
    if (!Number.isFinite(dueUnix) || dueUnix <= 0) throw new Error("due date is not a valid date");
  } else {
    dueUnix = null;
  }
  return {
    v: 1,
    invoicee: String(invoicee).trim(),
    payerLabel: String(payerLabel ?? "").trim(),
    items: cleanItems,
    totalGrains: totalGrains.toString(),
    dueUnix,
    memo: String(memo ?? "").trim(),
    address: norm,
    hrp,
  };
}

/** Deterministic canonical serialization — hash input for the descriptor. */
export function canonicalInvoiceJSON(inv) {
  const items = inv.items
    .map((it) => ({ description: it.description, grains: String(BigInt(it.grains)) }))
    .sort((a, b) => (a.description < b.description ? -1 : a.description > b.description ? 1 : 0));
  return JSON.stringify({
    v: 1,
    invoicee: inv.invoicee,
    payerLabel: inv.payerLabel || "",
    items,
    totalGrains: String(BigInt(inv.totalGrains)),
    dueUnix: inv.dueUnix == null ? null : Number(inv.dueUnix),
    memo: inv.memo || "",
    address: inv.address,
    hrp: inv.hrp,
  });
}

export function invoiceHash(canonicalJSON) {
  return bytesToHex(sha256(utf8ToBytes(canonicalJSON)));
}

/* ---------------- descriptor ---------------- */

export function buildDescriptor(inv) {
  const canonical = canonicalInvoiceJSON(inv);
  const hash = invoiceHash(canonical);
  let d = `${DESCRIPTOR_PREFIX}:${VERSION}:${inv.hrp}:${hash}:${BigInt(inv.totalGrains).toString()}`;
  if (inv.dueUnix != null) d += `:${Number(inv.dueUnix)}`;
  return { descriptor: d, hash, canonical };
}

const DESCRIPTOR_RE = /^pearl-invoice:v1:(prl|tprl):([0-9a-f]{64}):(\d+)(?::(\d+))?$/;

export function parseDescriptor(s) {
  const t = String(s ?? "").trim();
  const m = DESCRIPTOR_RE.exec(t);
  if (!m) throw new Error("descriptor does not match pearl-invoice:v1:<hrp>:<hash>:<totalGrains>[:<dueUnix>]");
  return { hrp: m[1], hash: m[2], totalGrains: m[3], dueUnix: m[4] == null ? null : Number(m[4]) };
}

/**
 * Standalone verifier: recompute the hash over the supplied invoice JSON and
 * cross-check every descriptor field. Loud on ANY tampering.
 */
export function verifyInvoice(descriptorStr, invoiceJSONStr) {
  let d;
  try {
    d = parseDescriptor(descriptorStr);
  } catch (e) {
    return { proven: false, reason: `descriptor malformed: ${e.message}` };
  }
  let inv;
  try {
    inv = JSON.parse(invoiceJSONStr);
  } catch (e) {
    return { proven: false, reason: "invoice JSON does not parse" };
  }
  let canonical;
  try {
    canonical = canonicalInvoiceJSON(inv);
  } catch (e) {
    return { proven: false, reason: `invoice JSON invalid: ${e.message}` };
  }
  const recomputed = invoiceHash(canonical);
  if (recomputed !== d.hash) {
    return { proven: false, reason: `hash mismatch — invoice content was altered (descriptor ${d.hash.slice(0, 12)}… vs recomputed ${recomputed.slice(0, 12)}…)` };
  }
  if (String(BigInt(inv.totalGrains)) !== String(BigInt(d.totalGrains))) {
    return { proven: false, reason: "total grains in descriptor do not match invoice JSON" };
  }
  if (inv.hrp !== d.hrp) return { proven: false, reason: `network hrp mismatch: descriptor says ${d.hrp}, invoice says ${inv.hrp}` };
  if ((inv.dueUnix == null) !== (d.dueUnix == null) || (inv.dueUnix != null && Number(inv.dueUnix) !== d.dueUnix)) {
    return { proven: false, reason: "due date in descriptor does not match invoice JSON" };
  }
  return { proven: true, reason: "descriptor hash, totals, network, and due date all match the invoice JSON", hash: d.hash };
}

/* ---------------- receipt ---------------- */

export function buildReceipt(invoiceHashHex, txid, paidGrains, confirmations) {
  if (!/^[0-9a-fA-F]{64}$/.test(txid)) throw new Error("txid must be 64 hex chars");
  const g = String(BigInt(paidGrains));
  const record = `${RECEIPT_PREFIX}:${VERSION}:${invoiceHashHex}:${txid.toLowerCase()}:${g}`;
  return { receipt: record, receiptHash: invoiceHash(record), confirmations: Number(confirmations) };
}

export function verifyReceipt(receiptStr, { invoiceHash: ih, txid, paidGrains } = {}) {
  const m = /^pearl-invoice-receipt:v1:([0-9a-f]{64}):([0-9a-f]{64}):(\d+)$/.exec(String(receiptStr ?? "").trim());
  if (!m) return { proven: false, reason: "receipt does not match pearl-invoice-receipt:v1:<hash>:<txid>:<paidGrains>" };
  if (ih && m[1] !== ih.toLowerCase()) return { proven: false, reason: "receipt invoice hash does not match the expected invoice" };
  if (txid && m[2] !== txid.toLowerCase()) return { proven: false, reason: "receipt txid does not match" };
  if (paidGrains != null && String(BigInt(m[3])) !== String(BigInt(paidGrains))) {
    return { proven: false, reason: "receipt paid grains do not match" };
  }
  return { proven: true, reason: "receipt format valid and fields match the claimed invoice/txid/amount" };
}

/* ---------------- payment URI ---------------- */

/** BIP-21 style pearl: URI with exact amount. */
export function paymentURI(address, totalGrains) {
  const { address: norm } = validateInvoiceAddress(address);
  return `pearl:${norm}?amount=${formatPRL(BigInt(totalGrains))}`;
}

/* ---------------- fresh per-invoice address (BIP-86, audited core) ---------------- */

export function deriveInvoiceAddress(mnemonic, hrp, index) {
  const network = hrp === "prl" ? NETWORKS.mainnet : hrp === "tprl" ? NETWORKS.testnet : null;
  if (!network) throw new Error(`unsupported hrp "${hrp}"`);
  if (!Number.isInteger(index) || index < 0 || index > 0x7fffffff) throw new Error("index must be a non-negative integer");
  const w = walletFromMnemonic(mnemonic, network, INVOICE_ACCOUNT, index);
  return { address: w.address, path: `m/86'/${network.coinType}'/${INVOICE_ACCOUNT}'/0/${index}` };
}

/* ---------------- Blockbook watch (GET-only) ---------------- */

export function normalizeBlockbookBase(s) {
  const t = String(s ?? "").trim().replace(/\/$/, "");
  if (!/^https?:\/\//.test(t)) throw new Error("Blockbook URL must start with http(s)://");
  return t;
}

/**
 * GET-only read of payments: GET {base}/api/v2/address/<addr>?details=txs.
 * Returns raw tx objects (with details=txs they are full objects; if the
 * backend only returned txids, callers fall back to fetchTx per id).
 */
export async function fetchAddressActivity(fetcher, blockbookBase, address, pageSize = 50) {
  const base = normalizeBlockbookBase(blockbookBase);
  const url = `${base}/api/v2/address/${encodeURIComponent(address)}?details=txs&pageSize=${pageSize}`;
  let res;
  try {
    res = await fetcher(url);
  } catch (e) {
    throw new Error(`blockbook unreachable: ${e.message}`);
  }
  if (!res.ok) throw new Error(`blockbook ${res.status} on ${url}`);
  const data = JSON.parse(await res.text());
  const txs = Array.isArray(data.txs) ? data.txs : [];
  return { txs, totalReceived: data.totalReceived != null ? BigInt(String(data.totalReceived)) : null };
}

export async function fetchTx(fetcher, blockbookBase, txid) {
  if (!/^[0-9a-fA-F]{64}$/.test(txid)) throw new Error("txid must be 64 hex chars");
  const base = normalizeBlockbookBase(blockbookBase);
  const url = `${base}/api/v2/tx/${txid.toLowerCase()}`;
  let res;
  try {
    res = await fetcher(url);
  } catch (e) {
    throw new Error(`blockbook unreachable: ${e.message}`);
  }
  if (!res.ok) throw new Error(`blockbook ${res.status} on ${url}`);
  return JSON.parse(await res.text());
}

/**
 * Grain-exact payment state for an invoice from tx objects.
 * tx: { txid, confirmations, vout: [{ addresses: [..], value: "grains" }] }.
 */
export function analyzePayments(txs, address, totalGrains) {
  const total = BigInt(totalGrains);
  const addr = address.toLowerCase();
  const perTx = [];
  for (const tx of txs) {
    let toInvoice = 0n;
    for (const o of tx.vout || []) {
      const addrs = (o.addresses || []).map((a) => String(a).toLowerCase());
      if (addrs.includes(addr)) toInvoice += BigInt(String(o.value));
    }
    if (toInvoice > 0n) {
      perTx.push({
        txid: String(tx.txid),
        grains: toInvoice.toString(),
        confirmations: Number(tx.confirmations ?? 0),
      });
    }
  }
  const received = perTx.reduce((a, t) => a + BigInt(t.grains), 0n);
  const remaining = total - received;
  const state = received <= 0n ? "unpaid" : remaining > 0n ? "partial" : received === total ? "paid" : "overpaid";
  return {
    state,
    receivedGrains: received.toString(),
    remainingGrains: (remaining > 0n ? remaining : 0n).toString(),
    overpaidGrains: remaining < 0n ? (-remaining).toString() : "0",
    payments: perTx,
  };
}

/* ---------------- exports ---------------- */

export function invoiceToJSONExport(inv, descriptorObj, receiptObj = null) {
  return JSON.stringify(
    { kind: "pearl-invoice-export", v: 1, invoice: inv, descriptor: descriptorObj.descriptor, invoiceHash: descriptorObj.hash, receipt: receiptObj },
    null,
    2
  );
}

export function invoiceToCSV(inv, descriptorObj, receiptObj = null) {
  // Spreadsheet formula-injection guard (CWE-1236): a cell whose text begins
  // (after optional spaces) with =, +, -, @, | or % is executed as a formula
  // when the CSV is opened in Excel/Sheets — quoting does NOT prevent it.
  // Prefix such cells with an apostrophe so they open as text. Plain numbers
  // (including negative amounts) are data, not formulas, and pass untouched.
  const q = (s) => {
    let v = String(s);
    if (!/^-?\d+(\.\d+)?$/.test(v) && /^\s*[=+\-@|%]/.test(v)) v = "'" + v;
    return `"${v.replace(/"/g, '""')}"`;
  };
  const lines = ["section,key,value"];
  lines.push(`invoice,invoicee,${q(inv.invoicee)}`);
  lines.push(`invoice,payerLabel,${q(inv.payerLabel || "")}`);
  lines.push(`invoice,address,${q(inv.address)}`);
  lines.push(`invoice,totalGrains,${q(inv.totalGrains)}`);
  lines.push(`invoice,totalPRL,${q(formatPRL(inv.totalGrains))}`);
  lines.push(`invoice,dueUnix,${q(inv.dueUnix ?? "")}`);
  lines.push(`invoice,memo,${q(inv.memo || "")}`);
  inv.items.forEach((it, i) => {
    lines.push(`item${i + 1},description,${q(it.description)}`);
    lines.push(`item${i + 1},grains,${q(it.grains)}`);
    lines.push(`item${i + 1},prl,${q(formatPRL(it.grains))}`);
  });
  lines.push(`descriptor,descriptor,${q(descriptorObj.descriptor)}`);
  lines.push(`descriptor,hash,${q(descriptorObj.hash)}`);
  if (receiptObj) {
    lines.push(`receipt,receipt,${q(receiptObj.receipt)}`);
    lines.push(`receipt,hash,${q(receiptObj.receiptHash)}`);
  }
  return lines.join("\n");
}

// Re-export the audited Sign-core pieces the page/app reuses (no new crypto).
export { decodeBech32m, encodeBech32m, NETWORKS, GRAIN_PER_PRL, walletFromMnemonic, walletFromPriv };
