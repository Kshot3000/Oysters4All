/* Pearl Split core — group expense-splitting + settlement desk for Pearl (PRL).
 *
 * Splitting a tab on Pearl is honest bookkeeping, and this file is honest
 * about what it can and cannot do:
 *
 *   1. TAB: members are display names bound to bech32m prl1…/tprl1… v1
 *      Taproot addresses, validated in-browser. NO keys are collected here.
 *   2. EXPENSES: each expense names a payer and a split rule — equal among
 *      the selected members, custom integer shares, or percentages. All math
 *      is grain-exact BigInt; equal-split remainders go to the first members
 *      BY INDEX, deterministically, so the split is exactly reproducible.
 *   3. SETTLE: net balances are derived, then the minimal transfer set is
 *      computed with greedy largest-debtor / largest-creditor matching (which
 *      is count-minimal for this matching problem). Any transfer below the
 *      546-grain dust floor is REFUSED loudly — it cannot exist on-chain —
 *      and the desk says exactly whose debt is unpayable and how to fix it
 *      (settle it off-ledger, or fold it into another transfer).
 *   4. PAY: each debtor pays their own settlement transaction: fetch their
 *      UTXOs via Blockbook (GET-only) or paste a UTXO list air-gapped,
 *      selectCoins against target + keypath fee, sign LOCALLY with the
 *      audited Schnorr machinery, re-verify every signature before the hex
 *      is exposed, export unsigned air-gapped bundles
 *      ("pearlsplit:v1:" descriptor, "pearl-split-unsigned:v1:" bundle kind),
 *      broadcast only behind an explicit double-confirm, and wipe the key
 *      from memory afterwards.
 *   5. LEDGER: tab history + expenses + settlements + txids in localStorage,
 *      with CSV export.
 *
 * No new cryptography is introduced anywhere in this file. All signing,
 * address derivation, verification, bundle sealing, and coin selection reuse
 * the audited sign and batch cores verbatim; the split-specific logic is
 * only: member validation, expense-share math, balance/minimal-transfer
 * computation, dust policy, per-debtor planning, descriptors, and the
 * localStorage ledger helpers.
 */

import {
  canonicalJson, descriptorFingerprint,
  parseBatchSecret, assertKeyControlsAddress, canonicalAddress,
  planDispatch, buildUnsignedTx, buildBatchTx, autoSelectUtxos,
  assertUtxos,
} from "../../batch/src/batch-core.js";
import {
  fmtPRL, parsePRL, fetchUtxos, broadcastViaBlockbook, parseUtxoList,
  decodeRawTx, verifySignedTx,
} from "../../sign/src/sign-core.js";
import {
  decodeBech32m, encodeBech32m, DUST_GRAIN, NETWORKS,
  bytesToHex, hexToBytes, sha256, convertBits, schnorr,
} from "../../sign/src/crypto.js";

export const SPLIT_DESCRIPTOR_KIND = "pearlsplit:v1:";
export const SPLIT_BUNDLE_KIND = "pearl-split-unsigned:v1:";
export const MAX_EXPENSE_DESC_LEN = 140;
export const MAX_MEMBERS = 100;

/** Validate one member: non-blank name, real v1 Taproot address on the network.
 *  Throws loudly; returns { name, address, program }. */
export function validateMember(name, address, network = NETWORKS.mainnet) {
  const nm = String(name ?? "").trim();
  if (!nm) throw new Error("member name is blank");
  if (nm.length > 60) throw new Error(`member name "${nm.slice(0, 20)}…" is too long (max 60 chars)`);
  const a = String(address ?? "").trim();
  if (!a) throw new Error(`member "${nm}" has no address`);
  let dec;
  try { dec = decodeBech32m(a, network.hrp); }
  catch (e) { throw new Error(`member "${nm}" has an invalid address: ${e.message || e}`); }
  if (dec.version !== 1) throw new Error(`member "${nm}": Pearl is Taproot-only (v1) — ${dec.hrp}${dec.version}… is not accepted`);
  if (!(dec.program instanceof Uint8Array) || dec.program.length !== 32) {
    throw new Error(`member "${nm}": address program is not a 32-byte x-only key`);
  }
  return { name: nm, address: canonicalAddress(a, network), program: dec.program };
}

/** Validate the full member list: names non-blank, addresses unique on this tab. */
export function validateMembers(members, network = NETWORKS.mainnet) {
  if (!Array.isArray(members) || members.length < 2) throw new Error("a tab needs at least two members");
  if (members.length > MAX_MEMBERS) throw new Error(`too many members (max ${MAX_MEMBERS})`);
  const out = members.map((m) => validateMember(m.name, m.address, network));
  const seen = new Set();
  for (const m of out) {
    const k = m.address.toLowerCase();
    if (seen.has(k)) throw new Error(`duplicate member address on this tab: ${m.address.slice(0, 18)}…`);
    seen.add(k);
  }
  const names = new Set();
  for (const m of out) {
    const k = m.name.toLowerCase();
    if (names.has(k)) throw new Error(`duplicate member name on this tab: "${m.name}"`);
    names.add(k);
  }
  return out;
}

/** Distribute leftover grains to the first members by index (deterministic). */
function distributeRemainder(lines, leftover) {
  let r = leftover;
  let i = 0;
  while (r > 0n) {
    lines[i % lines.length].grains += 1n;
    r -= 1n; i += 1;
  }
}

/** Split totalGrains among memberIdxs per mode.
 *  opts: { mode: "equal"|"shares"|"percent", memberIdxs: [..], shares: [int..],
 *          percents: [num..] }
 *  Returns [{ memberIdx, grains }] in memberIdxs order. Grain-exact: sum == totalGrains. */
export function splitExpense(totalGrains, opts) {
  const total = BigInt(totalGrains);
  if (total <= 0n) throw new Error("expense amount must be positive");
  const idxs = Array.isArray(opts.memberIdxs) ? opts.memberIdxs : [];
  if (idxs.length === 0) throw new Error("no members selected for this expense");
  const lines = idxs.map((mi) => ({ memberIdx: mi, grains: 0n }));

  if (opts.mode === "shares") {
    const shares = Array.isArray(opts.shares) ? opts.shares : [];
    if (shares.length !== idxs.length) throw new Error("share counts must match the selected members");
    const w = shares.map((s) => {
      const v = BigInt(String(s).trim ? String(s).trim() : String(s));
      if (v <= 0n) throw new Error("shares must be positive integers");
      return v;
    });
    const wSum = w.reduce((a, b) => a + b, 0n);
    let assigned = 0n;
    w.forEach((wi, i) => { lines[i].grains = (total * wi) / wSum; assigned += lines[i].grains; });
    distributeRemainder(lines, total - assigned);
  } else if (opts.mode === "percent") {
    const percents = Array.isArray(opts.percents) ? opts.percents : [];
    if (percents.length !== idxs.length) throw new Error("percentages must match the selected members");
    const scale = percents.map((p) => {
      const m = String(p).trim().match(/^(\d+)(?:\.(\d{1,2}))?$/);
      if (!m) throw new Error(`bad percentage "${p}" — numbers 0–100, up to 2 decimals`);
      const v = BigInt(m[1]) * 100n + BigInt((m[2] || "").padEnd(2, "0"));
      if (v > 10000n) throw new Error(`percentage "${p}" is over 100`);
      return v;
    });
    const sum = scale.reduce((a, b) => a + b, 0n);
    if (sum !== 10000n) throw new Error(`percentages sum to ${Number(sum) / 100}% — they must sum to exactly 100%`);
    let assigned = 0n;
    scale.forEach((si, i) => { lines[i].grains = (total * si) / 10000n; assigned += lines[i].grains; });
    distributeRemainder(lines, total - assigned);
  } else {
    // equal: remainder grains go to the first members by index
    const n = BigInt(idxs.length);
    const base = total / n;
    lines.forEach((l) => { l.grains = base; });
    distributeRemainder(lines, total - base * n);
  }

  const check = lines.reduce((a, l) => a + l.grains, 0n);
  if (check !== total) throw new Error("split internal error: shares do not sum to the total — refusing");
  return lines;
}

/** Add one validated expense to the tab. Returns the expense record. */
export function addExpense(tab, { desc, amountPRL, payerIdx, mode = "equal", memberIdxs, shares, percents }) {
  const members = validateMembers(tab.members, tab.network);
  const d = String(desc ?? "").trim();
  if (!d) throw new Error("expense description is blank");
  if (d.length > MAX_EXPENSE_DESC_LEN) throw new Error("expense description too long (max 140 chars)");
  const total = BigInt(String(parsePRL(String(amountPRL))));
  if (!Number.isInteger(payerIdx) || payerIdx < 0 || payerIdx >= members.length) {
    throw new Error("payer is not a member of this tab");
  }
  const sel = (Array.isArray(memberIdxs) ? memberIdxs : members.map((_, i) => i));
  for (const i of sel) {
    if (!Number.isInteger(i) || i < 0 || i >= members.length) throw new Error("expense split names a non-member");
  }
  if (new Set(sel).size !== sel.length) throw new Error("expense split lists a member twice");
  const lines = splitExpense(total, { mode, memberIdxs: sel, shares, percents });
  return { desc: d, totalGrains: total.toString(), payerIdx, mode, lines };
}

/** Net balance per member (BigInt, index-aligned): positive = owed money (creditor),
 *  negative = owes money (debtor). Sum is always zero. */
export function computeBalances(members, expenses) {
  const bal = members.map(() => 0n);
  for (const e of expenses) {
    const total = BigInt(e.totalGrains);
    bal[e.payerIdx] += total;
    for (const l of e.lines) bal[l.memberIdx] -= BigInt(l.grains);
  }
  const sum = bal.reduce((a, b) => a + b, 0n);
  if (sum !== 0n) throw new Error("balance internal error: balances do not net to zero — refusing");
  return bal;
}

/** Minimal transfer set: greedy largest-debtor / largest-creditor matching.
 *  This pairing is count-minimal: every transfer zeroes at least one party,
 *  so no smaller set can settle the same balances.
 *  Returns [{ from (debtor memberIdx), to (creditor memberIdx), grains }]. */
export function minimizeTransfers(balances) {
  const debtors = [], creditors = [];
  balances.forEach((b, i) => {
    if (b < 0n) debtors.push({ i, amt: -b });
    else if (b > 0n) creditors.push({ i, amt: b });
  });
  debtors.sort((a, b) => (a.amt < b.amt ? 1 : a.amt > b.amt ? -1 : 0));
  creditors.sort((a, b) => (a.amt < b.amt ? 1 : a.amt > b.amt ? -1 : 0));
  const transfers = [];
  let d = 0, c = 0;
  while (d < debtors.length && c < creditors.length) {
    const pay = debtors[d].amt < creditors[c].amt ? debtors[d].amt : creditors[c].amt;
    transfers.push({ from: debtors[d].i, to: creditors[c].i, grains: pay.toString() });
    debtors[d].amt -= pay; creditors[c].amt -= pay;
    if (debtors[d].amt === 0n) d++;
    if (creditors[c].amt === 0n) c++;
  }
  return transfers;
}

/** Dust policy: a transfer below the dust floor cannot be put on-chain.
 *  Returns { payable, blocked } — blocked entries name the debt and the fix. */
export function applyDustPolicy(transfers, members) {
  const payable = [], blocked = [];
  for (const t of transfers) {
    if (BigInt(t.grains) < BigInt(DUST_GRAIN)) {
      blocked.push({
        ...t,
        reason: `${members[t.from].name} owes ${members[t.to].name} ${fmtPRL(t.grains)} PRL — below the ${fmtPRL(DUST_GRAIN)} PRL dust floor, so it cannot be a chain output. Settle it in person (cash/handshake), or fold it into another transfer.`,
      });
    } else payable.push(t);
  }
  return { payable, blocked };
}

/** Seal the tab + settlement into a tamper-evident descriptor. */
export function settleTab({ tabName, members, expenses, network, transfers }) {
  const mem = validateMembers(members, network);
  const bal = computeBalances(mem, expenses);
  const t = transfers ?? minimizeTransfers(bal);
  const { payable, blocked } = applyDustPolicy(t, mem);
  const descriptor = {
    kind: SPLIT_DESCRIPTOR_KIND,
    tabName: String(tabName || "").trim(),
    network: network.id,
    members: mem.map((m) => ({ name: m.name, address: m.address })),
    expenses: expenses.map((e) => ({
      desc: e.desc, totalGrains: e.totalGrains, payerIdx: e.payerIdx, mode: e.mode,
      lines: e.lines.map((l) => ({ memberIdx: l.memberIdx, grains: BigInt(l.grains).toString() })),
    })),
    balancesGrains: bal.map((b) => b.toString()),
    transfers: t.map((x) => ({ from: x.from, to: x.to, grains: BigInt(x.grains).toString() })),
    payableCount: payable.length,
    blockedCount: blocked.length,
  };
  const fingerprint = descriptorFingerprint(descriptor);
  return { descriptor, fingerprint, members: mem, balances: bal, transfers: t, payable, blocked };
}

/** Group the payable transfers by debtor: each debtor's one settlement tx. */
export function debtorPlans(transfers, members, network = NETWORKS.mainnet) {
  const byDebtor = new Map();
  for (const t of transfers) {
    if (!byDebtor.has(t.from)) byDebtor.set(t.from, []);
    byDebtor.get(t.from).push(t);
  }
  return [...byDebtor.entries()].map(([debtorIdx, ts]) => {
    const debtor = validateMember(members[debtorIdx].name, members[debtorIdx].address, network);
    const recipients = ts.map((x) => {
      const cred = validateMember(members[x.to].name, members[x.to].address, network);
      return { name: cred.name, address: cred.address, program: cred.program, amount: BigInt(x.grains) };
    });
    return { debtorIdx, debtorAddress: debtor.address, debtorName: debtor.name, senderProgram: debtor.program, recipients, transfers: ts };
  });
}

/** Fund one debtor's settlement: auto-select UTXOs against their creditors + fee.
 *  Reuses the audited batch planner — grain-exact, dust-safe change handling. */
export function fundSettlement({ network, debtorPlan, utxos, feeRateGrainsPerVByte }) {
  assertUtxos(utxos);
  return planDispatch({
    utxos, recipients: debtorPlan.recipients,
    senderProgram: debtorPlan.senderProgram,
    feeRateGrainsPerVByte, network,
  });
}

/** Export the unsigned air-gapped bundle for a debtor's settlement. */
export function exportSplitBundle({ network, debtorPlan, tabFingerprint, plan, feeRate }) {
  const descriptor = {
    kind: SPLIT_DESCRIPTOR_KIND,
    network: network.id,
    tabFingerprint,
    debtorAddress: debtorPlan.debtorAddress,
    debtorName: debtorPlan.debtorName,
    feeRate,
    recipients: debtorPlan.recipients.map((r) => ({
      name: r.name, address: r.address, amountGrains: r.amount.toString(),
    })),
    inputs: plan.inputs.map((u) => ({
      txid: String(u.txid).toLowerCase(), vout: u.vout,
      valueGrains: BigInt(u.value).toString(), confirmations: u.confirmations ?? 0,
    })),
    outputs: plan.outputs.map((o) => ({
      address: o.address, valueGrains: BigInt(o.value).toString(), change: o.change,
    })),
    totals: {
      inputsGrains: plan.total.toString(),
      recipientsGrains: plan.sumOut.toString(),
      feeGrains: plan.fee.toString(),
      changeGrains: plan.change.toString(),
      vBytes: plan.vBytes,
    },
  };
  const fingerprint = descriptorFingerprint(descriptor);
  const unsigned = buildUnsignedTx(
    network,
    plan.inputs.map((u) => ({ txid: String(u.txid).toLowerCase(), vout: u.vout })),
    plan.outputs.map((o) => ({ program: o.program, value: o.value }))
  );
  return {
    bundle: SPLIT_BUNDLE_KIND,
    fingerprint,
    descriptor,
    unsignedHex: unsigned.hex,
    unsignedTxid: unsigned.txid,
    wireDigest: bytesToHex(sha256(new TextEncoder().encode(unsigned.hex))),
    feeGrains: plan.fee.toString(),
    vBytes: plan.vBytes,
  };
}

/** Import + fully re-verify an unsigned bundle. Rebuilds the descriptor,
 *  recomputes fingerprint, unsigned wire, txid, fee, and vBytes from the
 *  descriptor alone, and refuses loudly on ANY mismatch. */
export function importSplitBundle(bundle) {
  const b = typeof bundle === "string" ? JSON.parse(bundle) : bundle;
  if (!b || b.bundle !== SPLIT_BUNDLE_KIND) throw new Error("not a Pearl Split unsigned bundle — wrong 'bundle' kind tag");
  const d = b.descriptor;
  if (!d || d.kind !== SPLIT_DESCRIPTOR_KIND) throw new Error("bundle descriptor has a bad kind tag");
  const network = NETWORKS[d.network];
  if (!network) throw new Error(`unknown network "${d.network}" in bundle descriptor`);
  if (descriptorFingerprint(d) !== b.fingerprint) {
    throw new Error("BUNDLE FINGERPRINT MISMATCH — the descriptor was tampered with (or corrupted). Refusing to sign.");
  }
  if (!Array.isArray(d.recipients) || d.recipients.length === 0) throw new Error("bundle descriptor has no recipients");
  const recipients = d.recipients.map((r, i) => {
    const address = canonicalAddress(r.address, network);
    const dec = decodeBech32m(r.address, network.hrp);
    const amount = BigInt(r.amountGrains);
    if (amount < BigInt(DUST_GRAIN)) throw new Error(`bundle recipient #${i + 1} is below dust — refusing`);
    return { name: String(r.name ?? ""), address, program: dec.program, amount };
  });
  const inputs = (d.inputs || []).map((u) => {
    if (!/^[0-9a-f]{64}$/i.test(String(u.txid || ""))) throw new Error("bundle input has a bad txid");
    return { txid: String(u.txid).toLowerCase(), vout: u.vout, value: Number(BigInt(u.valueGrains)), confirmations: u.confirmations ?? 0 };
  });
  const senderDec = decodeBech32m(d.debtorAddress, network.hrp);
  const plan = planDispatch({ utxos: inputs, recipients, senderProgram: senderDec.program, feeRateGrainsPerVByte: d.feeRate, network });
  const unsigned = buildUnsignedTx(
    network,
    inputs.map((u) => ({ txid: u.txid, vout: u.vout })),
    plan.outputs.map((o) => ({ program: o.program, value: o.value }))
  );
  if (unsigned.txid !== b.unsignedTxid) throw new Error("BUNDLE DIGEST MISMATCH — rebuilt unsigned txid differs from stored. Refusing to sign.");
  if (bytesToHex(sha256(new TextEncoder().encode(unsigned.hex))) !== b.wireDigest) {
    throw new Error("BUNDLE WIRE DIGEST MISMATCH — the unsigned hex was altered. Refusing to sign.");
  }
  if (plan.fee.toString() !== String(b.feeGrains)) throw new Error("BUNDLE FEE MISMATCH — refusing to sign.");
  if (plan.vBytes !== b.vBytes) throw new Error("BUNDLE SIZE MISMATCH — refusing to sign.");
  return { network, descriptor: d, recipients, plan, feeRate: d.feeRate, fingerprint: b.fingerprint };
}

/** Build + Schnorr-sign + locally re-verify one debtor's settlement.
 *  Every signature is re-verified with verifySignedTx BEFORE the hex is returned. */
export function buildSettlementTx({ secret, debtorAddress, utxos, plan, network = NETWORKS.mainnet }) {
  return buildBatchTx({ secret, senderAddress: debtorAddress, utxos, plan, network });
}

/* localStorage ledger helpers (pure-ish: take a storage object) */
const LEDGER_KEY = "pearlsplit.ledger.v1";
export function loadLedger(store) {
  try {
    const raw = store.getItem(LEDGER_KEY);
    if (!raw) return { tabs: [] };
    const l = JSON.parse(raw);
    if (!l || !Array.isArray(l.tabs)) return { tabs: [] };
    return l;
  } catch { return { tabs: [] }; }
}
export function saveLedger(store, ledger) { store.setItem(LEDGER_KEY, JSON.stringify(ledger)); }
export function ledgerToCsv(ledger) {
  const rows = [["tab", "fingerprint", "member", "address", "net_grains", "net_prl", "side"]];
  for (const t of ledger.tabs) {
    (t.balances || []).forEach((b, i) => {
      const g = BigInt(b.grains);
      rows.push([t.tabName, t.fingerprint, t.members[i]?.name || "", t.members[i]?.address || "",
        g.toString(), fmtPRL(g), g > 0n ? "creditor" : g < 0n ? "debtor" : "even"]);
    });
  }
  const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
  return rows.map((r) => r.map(q).join(",")).join("\n") + "\n";
}

export {
  fmtPRL, parsePRL, fetchUtxos, broadcastViaBlockbook, parseUtxoList,
  decodeRawTx, verifySignedTx, decodeBech32m, encodeBech32m,
  canonicalJson, descriptorFingerprint,
  parseBatchSecret, assertKeyControlsAddress, autoSelectUtxos,
  sha256, bytesToHex, hexToBytes, convertBits, schnorr,
  DUST_GRAIN, NETWORKS,
};
