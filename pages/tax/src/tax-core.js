// Pearl Tax core — PRL capital-gains & tax desk engine.
//
// Read-only: the page never holds keys, never signs, never broadcasts.
// It imports transaction history with GET-only Blockbook reads (or pasted
// JSON / CSV), you classify every movement, you supply the PRL/USD prices,
// and the engine computes a FIFO cost-basis ledger with grain-exact BigInt
// math and cent-exact USD math. Unclassified movements or missing prices
// LOUDLY block the report — nothing is ever guessed.
//
// NO new cryptography: address validation comes from the audited Sign core
// (../../sign/src/crypto.js) via the shared importmap.
import {
  decodeBech32m,
  NETWORKS,
  GRAIN_PER_PRL,
} from "../../sign/src/crypto.js";

export const DONATE_ADDRESS = "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d";
export const X_ACCOUNT = "https://x.com/kshot9000";
export const DEFAULT_BLOCKBOOK = NETWORKS.mainnet.blockbook;
export const VERSION = "v1";
export const LONG_TERM_SECONDS = 365 * 86400;
const GPR = BigInt(GRAIN_PER_PRL);
const DAY = 86400;

/* ---------------- amount math (BigInt, grain-exact) ---------------- */

export function parsePRLToGrains(s) {
  if (typeof s !== "string") throw new Error("amount must be text");
  const t = s.trim();
  if (!/^\d+(\.\d{1,8})?$/.test(t)) throw new Error(`bad PRL amount "${t}": up to 8 decimals`);
  const [w, f = ""] = t.split(".");
  const grains = BigInt(w) * GPR + BigInt((f + "00000000").slice(0, 8));
  if (grains <= 0n) throw new Error("amount must be greater than zero");
  return grains;
}

export function formatPRL(grains) {
  const g = BigInt(grains);
  const w = g / GPR;
  let f = (g % GPR).toString().padStart(8, "0").replace(/0+$/, "");
  return f ? `${w}.${f}` : String(w);
}

export function parseUSDToCents(s) {
  if (typeof s !== "string") throw new Error("price must be text");
  const t = s.trim().replace(/^\$/, "");
  if (!/^\d+(\.\d{1,4})?$/.test(t)) throw new Error(`bad USD price "${t}": up to 4 decimals`);
  const [w, f = ""] = t.split(".");
  // exact: pad the fraction to 4 digits, keep 2, round half-up from the rest
  const frac4 = (f + "0000").slice(0, 4);
  const round = Number(frac4.slice(2, 4)) >= 50 ? 1n : 0n;
  return BigInt(w) * 100n + BigInt(frac4.slice(0, 2)) + round;
}

export function formatUSD(cents) {
  const c = BigInt(cents);
  const neg = c < 0n;
  const a = neg ? -c : c;
  const w = (a / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const f = (a % 100n).toString().padStart(2, "0");
  return `${neg ? "-" : ""}$${w}.${f}`;
}

/** grains * priceCentsPerPRL / 1e8, rounded half-up to the cent. */
export function grainsToCents(grains, priceCents) {
  const g = BigInt(grains);
  const p = BigInt(priceCents);
  if (g < 0n || p < 0n) throw new Error("grainsToCents: negative input");
  return (g * p + GPR / 2n) / GPR;
}

/* ---------------- dates ---------------- */

export function unixToDate(unix) {
  const d = new Date(Number(unix) * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function dateToUnix(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) throw new Error(`bad date "${dateStr}": want YYYY-MM-DD`);
  const t = Date.parse(dateStr + "T00:00:00Z");
  if (!Number.isFinite(t)) throw new Error(`bad date "${dateStr}"`);
  return Math.floor(t / 1000);
}

export function isLongTerm(acquiredUnix, disposedUnix) {
  return Number(disposedUnix) - Number(acquiredUnix) > LONG_TERM_SECONDS;
}

/* ---------------- address validation (audited bech32m, v1 only) ---------------- */

export function validateWatchAddress(addr) {
  let d;
  try {
    d = decodeBech32m(addr);
  } catch (e) {
    throw new Error(`Not a valid Pearl Taproot address: ${e.message}`);
  }
  const network =
    d.hrp === "prl" ? NETWORKS.mainnet : d.hrp === "tprl" ? NETWORKS.testnet : null;
  if (!network)
    throw new Error(`Not a Pearl address: unsupported hrp "${d.hrp}" (want prl1… or tprl1…)`);
  return { hrp: d.hrp, networkId: network.id, address: addr.trim().toLowerCase() };
}

/* ---------------- Blockbook normalization ----------------
 * Input: one raw tx object from /api/v2/address/{a}?details=txs or /api/v2/tx/{id}.
 * Output: per-watched-address movements + fee attribution. Throws
 * UnresolvableTx when input values are missing (caller should fetch the full
 * /api/v2/tx/ detail, which always carries vin values).
 */

export class UnresolvableTx extends Error {
  constructor(txid, why) {
    super(`tx ${txid}: ${why}`);
    this.txid = txid;
  }
}

const val = (v) => {
  if (v === undefined || v === null || v === "") return null;
  return BigInt(String(v));
};

export function normalizeBlockbookTx(raw, watched) {
  const watchedSet = watched instanceof Set ? watched : new Set(watched);
  const txid = String(raw.txid || raw.hash || "");
  if (!txid) throw new Error("tx has no txid");
  const height = Number(raw.blockHeight ?? -1);
  const time = Number(raw.blockTime ?? 0);
  const feeGrains = val(raw.fees) ?? 0n;

  let ourInputs = 0n;
  let ourOutputs = 0n;
  const perAddress = new Map(); // address -> delta grains
  let missingInputValues = false;
  let externalInputs = false; // some vin value came from an unwatched address

  for (const vin of raw.vin || []) {
    const addrs = vin.addresses || (vin.addr ? [vin.addr] : []);
    const hit = addrs.some((a) => watchedSet.has(String(a).toLowerCase()));
    const v = val(vin.value);
    if (!hit) {
      if (v !== null) externalInputs = true;
      continue;
    }
    if (v === null) {
      missingInputValues = true;
    } else {
      ourInputs += v;
      for (const a of addrs) {
        const k = String(a).toLowerCase();
        if (watchedSet.has(k)) perAddress.set(k, (perAddress.get(k) ?? 0n) - v);
      }
    }
  }
  for (const vout of raw.vout || []) {
    const addrs = vout.addresses || (vout.scriptPubKey && vout.scriptPubKey.addresses) || [];
    const v = val(vout.value);
    if (v === null) continue;
    for (const a of addrs) {
      const k = String(a).toLowerCase();
      if (watchedSet.has(k)) {
        ourOutputs += v;
        perAddress.set(k, (perAddress.get(k) ?? 0n) + v);
      }
    }
  }

  if (missingInputValues) {
    throw new UnresolvableTx(
      txid,
      "input values missing in address-index view — fetch the full /api/v2/tx/ detail or paste the tx JSON"
    );
  }

  const delta = ourOutputs - ourInputs;
  let kind;
  let ourFee = 0n;
  let mixedFeeNote = null;
  if (ourInputs > 0n && ourOutputs > 0n) {
    if (ourInputs - ourOutputs === feeGrains && feeGrains >= 0n) {
      kind = "self"; // pure consolidation: inputs == outputs + fee
      ourFee = feeGrains;
    } else if (externalInputs) {
      // Genuinely ambiguous: outside money co-signed this tx, so per-leg
      // attribution is a judgment call. Split into receive + send legs and
      // let the user classify each; the fee is assigned to the send leg.
      kind = "mixed";
      mixedFeeNote =
        "outside inputs co-sign this tx — leg attribution is ambiguous; the fee is assigned to the send leg. Review both legs.";
      ourFee = feeGrains;
    } else {
      // Net-economic: the change output never left home, so only the net
      // movement is modeled. Change keeps its original lots (no basis step-up).
      const net = ourOutputs - ourInputs;
      if (net < 0n) {
        kind = "send";
        ourFee = feeGrains;
      } else {
        kind = "receive";
        ourFee = 0n; // fee attribution unclear on net receipts — not modeled
      }
    }
  } else if (delta > 0n) {
    kind = "receive";
  } else if (delta < 0n) {
    kind = "send";
    ourFee = feeGrains;
  } else if (ourInputs > 0n || ourOutputs > 0n) {
    kind = "self";
    ourFee = feeGrains;
  } else {
    throw new UnresolvableTx(txid, "touches none of the watched addresses");
  }

  return {
    txid,
    height,
    time,
    unconfirmed: height < 0,
    kind,
    ourInputs: ourInputs.toString(),
    ourOutputs: ourOutputs.toString(),
    deltaGrains: delta.toString(),
    feeGrains: ourFee.toString(),
    mixedFeeNote,
    movements: [...perAddress.entries()].map(([address, d]) => ({
      address,
      deltaGrains: d.toString(),
    })),
  };
}

/** Suggested high-level kind for a normalized tx (UI pre-selects this). */
export function suggestKind(norm) {
  return norm.kind; // receive | send | self | mixed
}

/* ---------------- classification vocabulary ---------------- */

export const RECEIVE_SUBS = Object.freeze({
  buy: "Buy (exchange / OTC purchase)",
  mining: "Mining income (PoUW block reward)",
  income: "Other income (paid in PRL)",
  gift: "Gift received (simplified: FMV basis at receipt)",
  "transfer-in": "Transfer in (own wallet — basis carried)",
});
export const SEND_SUBS = Object.freeze({
  sell: "Sell (exchange / OTC sale)",
  spend: "Spend (goods / services)",
  gift: "Gift given (no gain recognized — simplified)",
  "transfer-out": "Transfer out (own wallet — basis carried)",
  lost: "Lost / stolen (loss at zero proceeds)",
});
export const SELF_SUB = "internal"; // consolidation: fee only, no gain

export function validateClassification(c) {
  if (!c || typeof c !== "object") throw new Error("classification is required");
  const { kind, sub } = c;
  if (kind === "receive") {
    if (!RECEIVE_SUBS[sub]) throw new Error(`bad receive sub "${sub}"`);
  } else if (kind === "send") {
    if (!SEND_SUBS[sub]) throw new Error(`bad send sub "${sub}"`);
  } else if (kind === "self") {
    if (sub !== SELF_SUB) throw new Error(`self txs are always "${SELF_SUB}"`);
  } else if (kind === "mixed") {
    if (!RECEIVE_SUBS[c.recvSub]) throw new Error(`bad mixed receive sub "${c.recvSub}"`);
    if (!SEND_SUBS[c.sendSub]) throw new Error(`bad mixed send sub "${c.sendSub}"`);
    if (c.recvAcquiredUnix !== undefined && !(Number.isInteger(c.recvAcquiredUnix) && c.recvAcquiredUnix > 0))
      throw new Error("bad mixed receive acquisition date");
  } else {
    throw new Error(`bad kind "${kind}"`);
  }
  return true;
}

/* ---------------- price table ---------------- */

export function parsePriceCSV(text) {
  const rows = [];
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/[,\t;]/).map((s) => s.trim());
    if (parts[0].toLowerCase() === "date") continue; // header
    if (parts.length < 2) throw new Error(`price CSV line ${i + 1}: want "YYYY-MM-DD,price_usd"`);
    const unix = dateToUnix(parts[0]);
    const cents = parseUSDToCents(parts[1]);
    if (cents <= 0n) throw new Error(`price CSV line ${i + 1}: price must be positive`);
    rows.push({ date: parts[0], unix, cents });
  }
  rows.sort((a, b) => a.unix - b.unix);
  // de-dupe: last wins
  const out = [];
  for (const r of rows) {
    if (out.length && out[out.length - 1].date === r.date) out[out.length - 1] = r;
    else out.push(r);
  }
  if (!out.length) throw new Error("price CSV has no usable rows");
  return out;
}

/** Latest price on or before unix; null when none. */
export function priceFor(unix, table) {
  let hit = null;
  for (const r of table) {
    if (r.unix <= unix) hit = r;
    else break;
  }
  return hit;
}

/* ---------------- FIFO ledger ---------------- */

export class LedgerError extends Error {
  constructor(message, detail) {
    super(message);
    this.detail = detail;
  }
}

/**
 * Run the full ledger.
 * txs: normalized txs (normalizeBlockbookTx output), confirmed only.
 * classifications: { txid: {kind, sub, recvSub?, sendSub?, acquiredUnix?} }
 * priceTable: parsePriceCSV output.
 * openingLots: [{date: "YYYY-MM-DD", grains: "123" | BigInt, priceCents: BigInt | "12.34"}]
 *   — balances you held before the imported history starts.
 */
export function runLedger({ txs, classifications, priceTable, openingLots = [] }) {
  const unclassified = [];
  const missingPrices = [];
  const lots = []; // FIFO queue: {txid, acquiredUnix, grains, costCents, note}
  const disposals = [];
  const incomeEvents = [];
  const feeEvents = [];
  const nonTaxableOutflows = []; // gift-out / transfer-out: lots left, no gain/loss

  for (const o of openingLots) {
    const unix = dateToUnix(o.date);
    const grains = BigInt(o.grains);
    if (grains <= 0n) throw new LedgerError("opening lot must be positive");
    const cents = typeof o.priceCents === "bigint" ? o.priceCents : parseUSDToCents(String(o.priceCents));
    lots.push({
      txid: "opening-balance",
      acquiredUnix: unix,
      grains,
      costCents: grainsToCents(grains, cents),
      note: "opening balance (user-supplied)",
    });
  }

  const sorted = [...txs].filter((t) => !t.unconfirmed).sort((a, b) => a.time - b.time || (a.txid < b.txid ? -1 : 1));

  const needPrice = (tx, why) => {
    const p = priceFor(tx.time, priceTable);
    if (!p) missingPrices.push({ txid: tx.txid, date: unixToDate(tx.time), why });
    return p;
  };

  const dispose = ({ grains, proceedsCents, txid, disposedUnix, label }) => {
    let remaining = BigInt(grains);
    if (remaining <= 0n) return [];
    const total = BigInt(grains);
    const totalProceeds = BigInt(proceedsCents);
    let allocProceeds = 0n;
    const rows = [];
    while (remaining > 0n) {
      const lot = lots[0];
      if (!lot) {
        throw new LedgerError(
          `FIFO ran dry disposing ${formatPRL(grains)} PRL in ${txid}`,
          "Your history starts after you acquired these coins. Add an opening-balance lot (Export tab → opening lots) dated before this tx."
        );
      }
      const take = remaining < lot.grains ? remaining : lot.grains;
      const fullLot = take === lot.grains;
      const lastRow = take === remaining;
      // Fully consuming a lot takes its entire remaining cost — no dust
      // costCents stranded by repeated pro-rata truncation.
      const basis = fullLot ? lot.costCents : (BigInt(lot.costCents) * take) / lot.grains;
      // The final row absorbs the proceeds remainder so the rows sum to the
      // transaction total exactly (no dropped cent).
      const proceeds = lastRow ? totalProceeds - allocProceeds : (totalProceeds * take) / total;
      rows.push({
        txid,
        label,
        disposedUnix,
        acquiredUnix: lot.acquiredUnix,
        grains: take,
        proceedsCents: proceeds,
        basisCents: basis,
        gainCents: proceeds - basis,
        longTerm: isLongTerm(lot.acquiredUnix, disposedUnix),
        lotNote: lot.note || "",
      });
      allocProceeds += proceeds;
      lot.grains -= take;
      lot.costCents -= basis;
      if (lot.grains === 0n) lots.shift();
      remaining -= take;
    }
    return rows;
  };

  // FIFO consume with NO taxable disposal (gift-out, transfer-out): the coins
  // leave this wallet's books without proceeds and without a recognized loss.
  // Returns consumed rows for the audit trail (not part of disposals).
  const consumeLots = (tx, grains, label) => {
    let remaining = BigInt(grains);
    if (remaining <= 0n) return [];
    const rows = [];
    while (remaining > 0n) {
      const lot = lots[0];
      if (!lot) {
        throw new LedgerError(
          `FIFO ran dry moving ${formatPRL(grains)} PRL in ${tx.txid}`,
          "Your history starts after you acquired these coins. Add an opening-balance lot (Export tab → opening lots) dated before this tx."
        );
      }
      const take = remaining < lot.grains ? remaining : lot.grains;
      const basis = take === lot.grains ? lot.costCents : (BigInt(lot.costCents) * take) / lot.grains;
      rows.push({
        txid: tx.txid,
        label,
        movedUnix: tx.time,
        acquiredUnix: lot.acquiredUnix,
        grains: take,
        basisCents: basis,
        lotNote: lot.note || "",
      });
      lot.grains -= take;
      lot.costCents -= basis;
      if (lot.grains === 0n) lots.shift();
      remaining -= take;
    }
    return rows;
  };

  const addLot = ({ txid, acquiredUnix, grains, priceCents, note }) => {
    lots.push({
      txid,
      acquiredUnix,
      grains: BigInt(grains),
      costCents: grainsToCents(grains, priceCents),
      note: note || "",
    });
  };

  const processReceive = (tx, sub, grains, acquiredUnix) => {
    const price = needPrice(tx, `receive (${sub})`);
    if (!price) return;
    const g = BigInt(grains);
    if (sub === "buy" || sub === "mining" || sub === "income") {
      addLot({ txid: tx.txid, acquiredUnix, grains: g, priceCents: price.cents, note: sub });
      if (sub === "mining" || sub === "income") {
        incomeEvents.push({
          txid: tx.txid,
          date: unixToDate(tx.time),
          unix: tx.time,
          type: sub,
          grains: g.toString(),
          fmvCents: grainsToCents(g, price.cents).toString(),
        });
      }
    } else if (sub === "gift") {
      addLot({ txid: tx.txid, acquiredUnix, grains: g, priceCents: price.cents, note: "gift-in (simplified FMV basis — see limits)" });
    } else if (sub === "transfer-in") {
      addLot({ txid: tx.txid, acquiredUnix, grains: g, priceCents: price.cents, note: "transfer-in (FMV at receipt; set original date to preserve holding period)" });
    }
  };

  const processSend = (tx, sub, principalGrains, feeGrains) => {
    const fee = BigInt(feeGrains);
    if (fee > 0n) {
      const rows = dispose({ grains: fee, proceedsCents: 0n, txid: tx.txid, disposedUnix: tx.time, label: "network fee" });
      for (const r of rows) feeEvents.push({ ...r, date: unixToDate(tx.time) });
    }
    const p = BigInt(principalGrains);
    if (p <= 0n) return;
    if (sub === "sell" || sub === "spend") {
      const price = needPrice(tx, `send (${sub})`);
      if (!price) return;
      const proceeds = grainsToCents(p, price.cents);
      const rows = dispose({ grains: p, proceedsCents: proceeds, txid: tx.txid, disposedUnix: tx.time, label: sub });
      for (const r of rows) disposals.push({ ...r, date: unixToDate(tx.time) });
    } else if (sub === "gift" || sub === "transfer-out") {
      // No gain recognized, no loss claimed: the lots leave this wallet's
      // books silently (a transfer-out carries its basis to the other wallet).
      const rows = consumeLots(tx, p, sub);
      for (const r of rows) nonTaxableOutflows.push({ ...r, date: unixToDate(tx.time) });
    } else {
      // lost / stolen: zero proceeds — a real capital loss.
      const rows = dispose({ grains: p, proceedsCents: 0n, txid: tx.txid, disposedUnix: tx.time, label: sub });
      for (const r of rows) disposals.push({ ...r, date: unixToDate(tx.time) });
    }
  };

  for (const tx of sorted) {
    const c = classifications[tx.txid];
    if (!c) {
      unclassified.push(tx.txid);
      continue;
    }
    validateClassification(c);
    const delta = BigInt(tx.deltaGrains);
    const fee = BigInt(tx.feeGrains);
    if (tx.kind === "receive") {
      // transfer-in may carry its original acquisition date to preserve the holding period
      processReceive(tx, c.sub, delta, c.acquiredUnix || tx.time);
    } else if (tx.kind === "send") {
      const outflow = -delta; // includes fee
      const feePart = fee < outflow ? fee : outflow;
      processSend(tx, c.sub, outflow - feePart, feePart);
    } else if (tx.kind === "self") {
      if (fee > 0n) {
        const rows = dispose({ grains: fee, proceedsCents: 0n, txid: tx.txid, disposedUnix: tx.time, label: "network fee (consolidation)" });
        for (const r of rows) feeEvents.push({ ...r, date: unixToDate(tx.time) });
      }
    } else if (tx.kind === "mixed") {
      // Split into two legs: receive(ourOutputs) then send(ourInputs + fee).
      processReceive(tx, c.recvSub, BigInt(tx.ourOutputs), c.recvAcquiredUnix || tx.time);
      const inflow = BigInt(tx.ourInputs);
      const feePart = fee < inflow ? fee : inflow;
      processSend(tx, c.sendSub, inflow - feePart, feePart);
    }
  }

  if (unclassified.length || missingPrices.length) {
    const bits = [];
    if (unclassified.length) bits.push(`${unclassified.length} unclassified tx(s): ${unclassified.slice(0, 8).join(", ")}${unclassified.length > 8 ? "…" : ""}`);
    if (missingPrices.length)
      bits.push(
        `${missingPrices.length} tx(s) missing a PRL/USD price: ${missingPrices
          .slice(0, 8)
          .map((m) => `${m.txid.slice(0, 12)}… (${m.date}, ${m.why})`)
          .join("; ")}${missingPrices.length > 8 ? "…" : ""}`
      );
    throw new LedgerError(`refused: the ledger is incomplete — ${bits.join(" · ")}`, {
      unclassified,
      missingPrices,
    });
  }

  return { lots, disposals, incomeEvents, feeEvents, nonTaxableOutflows };
}

/* ---------------- report ---------------- */

export function buildReport(ledger, year) {
  const y = Number(year);
  if (!Number.isInteger(y) || y < 2009 || y > 2100) throw new Error("bad report year");
  const inYear = (unix) => new Date(Number(unix) * 1000).getUTCFullYear() === y;

  const disposals = ledger.disposals.filter((d) => inYear(d.disposedUnix));
  const income = ledger.incomeEvents.filter((e) => inYear(e.unix));
  const fees = ledger.feeEvents.filter((e) => inYear(e.disposedUnix));

  const sum = (rows, k) => rows.reduce((a, r) => a + BigInt(r[k]), 0n);
  const proceeds = sum(disposals, "proceedsCents");
  const basis = sum(disposals, "basisCents");
  // Network fees are zero-proceeds disposals: their basis is a real economic
  // cost, so fee gains (negative) reduce the net — per the honest-limits promise.
  const feeGain = sum(fees, "gainCents");
  const gain = sum(disposals, "gainCents") + feeGain;
  const shortGain =
    disposals.filter((d) => !d.longTerm).reduce((a, r) => a + BigInt(r.gainCents), 0n) +
    fees.filter((f) => !f.longTerm).reduce((a, r) => a + BigInt(r.gainCents), 0n);
  const longGain =
    disposals.filter((d) => d.longTerm).reduce((a, r) => a + BigInt(r.gainCents), 0n) +
    fees.filter((f) => f.longTerm).reduce((a, r) => a + BigInt(r.gainCents), 0n);
  const incomeTotal = income.reduce((a, e) => a + BigInt(e.fmvCents), 0n);
  const feeBasis = sum(fees, "basisCents");

  return {
    year: y,
    disposals,
    income,
    fees,
    totals: {
      proceedsCents: proceeds.toString(),
      basisCents: basis.toString(),
      gainCents: gain.toString(),
      shortGainCents: shortGain.toString(),
      longGainCents: longGain.toString(),
      incomeCents: incomeTotal.toString(),
      feeBasisCents: feeBasis.toString(),
      feeGainCents: feeGain.toString(),
      disposalCount: disposals.length,
      incomeCount: income.length,
      nonTaxableCount: (ledger.nonTaxableOutflows || []).filter((e) => inYear(e.movedUnix)).length,
    },
  };
}

/* ---------------- exports ---------------- */

const csvCell = (v) => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function disposalsCSV(report) {
  const head = ["Date Acquired", "Date Disposed", "Description", "Proceeds (USD)", "Cost Basis (USD)", "Gain/Loss (USD)", "Term", "Txid"];
  const lines = [head.join(",")];
  for (const d of report.disposals) {
    lines.push(
      [
        unixToDate(d.acquiredUnix),
        unixToDate(d.disposedUnix),
        `${d.label} ${formatPRL(d.grains)} PRL`,
        (BigInt(d.proceedsCents) / 100n).toString() + "." + (BigInt(d.proceedsCents) % 100n).toString().padStart(2, "0"),
        (BigInt(d.basisCents) / 100n).toString() + "." + (BigInt(d.basisCents) % 100n).toString().padStart(2, "0"),
        (d.gainCents < 0n ? "-" : "") + (BigInt(d.gainCents < 0n ? -d.gainCents : d.gainCents) / 100n).toString() + "." + (BigInt(d.gainCents < 0n ? -d.gainCents : d.gainCents) % 100n).toString().padStart(2, "0"),
        d.longTerm ? "Long" : "Short",
        d.txid,
      ]
        .map(csvCell)
        .join(",")
    );
  }
  return lines.join("\n");
}

export function incomeCSV(report) {
  const head = ["Date", "Type", "Amount (PRL)", "FMV (USD)", "Txid"];
  const lines = [head.join(",")];
  for (const e of report.income) {
    const c = BigInt(e.fmvCents);
    lines.push(
      [e.date, e.type, formatPRL(e.grains), (c / 100n).toString() + "." + (c % 100n).toString().padStart(2, "0"), e.txid]
        .map(csvCell)
        .join(",")
    );
  }
  return lines.join("\n");
}

export function priceTableCSV(table) {
  const lines = ["date,price_usd"];
  for (const r of table) {
    const c = BigInt(r.cents);
    lines.push(`${r.date},${(c / 100n).toString()}.${(c % 100n).toString().padStart(2, "0")}`);
  }
  return lines.join("\n");
}

/* ---------------- Blockbook fetch helpers (GET-only) ---------------- */

export async function fetchAddressTxs({ blockbook, address, fetchImpl = fetch, pageSize = 1000, maxPages = 20 }) {
  const base = String(blockbook).replace(/\/$/, "");
  let page = 1;
  const seen = new Map();
  let total = Infinity;
  while (page <= maxPages && seen.size < total) {
    const url = `${base}/api/v2/address/${encodeURIComponent(address)}?details=txs&page=${page}&pageSize=${pageSize}`;
    let res;
    try {
      res = await fetchImpl(url);
    } catch (e) {
      throw new Error(`Blockbook unreachable at ${base}: ${e.message}`);
    }
    if (!res.ok) throw new Error(`Blockbook ${res.status} at ${base} (address ${address.slice(0, 16)}…)`);
    const j = await res.json();
    total = Number(j.totalTxs ?? (j.txs || []).length);
    for (const t of j.txs || []) seen.set(String(t.txid), t);
    if ((j.txs || []).length < pageSize) break;
    page++;
  }
  return { txs: [...seen.values()], totalTxs: total, capped: seen.size < total };
}

export async function fetchTxDetail({ blockbook, txid, fetchImpl = fetch }) {
  const base = String(blockbook).replace(/\/$/, "");
  const url = `${base}/api/v2/tx/${encodeURIComponent(txid)}`;
  let res;
  try {
    res = await fetchImpl(url);
  } catch (e) {
    throw new Error(`Blockbook unreachable at ${base}: ${e.message}`);
  }
  if (!res.ok) throw new Error(`Blockbook ${res.status} fetching tx ${txid.slice(0, 16)}…`);
  return res.json();
}
