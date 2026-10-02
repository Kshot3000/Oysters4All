// Pearl Payroll core: the PRL payroll desk ("the paymaster's office").
// A recurring-payments studio for Pearl: maintain a payee roster, plan a pay
// schedule (weekly/biweekly/monthly/custom — a PLANNER, never auto-pay), fund
// a pay run from the sender's UTXOs, review the grain-exact manifest, sign
// locally with one keypath-Schnorr transaction, broadcast once, and keep a
// local history of past runs with per-payee totals + CSV export.
//
// Crypto policy: every cryptographic operation reuses the audited Pearl Sign
// lineage (../../sign/src/crypto.js + sign-core.js) exactly as the Batch app
// does: bech32m validation, BIP-86 derivation, TapTweak, BIP-341 keypath
// sighash, Schnorr signing, and per-signature re-verification all come from
// the Sign core. The only new code is payroll bookkeeping (roster parsing,
// pay-date planning, CSV serializers, history records) and the same wire
// serialization helpers sign-core itself uses. NO new cryptography.
//
// Protocol facts (do not re-derive): bech32m prl1.../tprl1... Taproot-only
// addresses; NO smart contracts on Pearl; 1 PRL = 1e8 grains; P2TR vB math
// via keypathTxVBytes (58 vB/input + 43 vB/output); dust floor 546 grains;
// fee math grain-exact BigInt.
import { HDKey } from "@scure/bip32";
import {
  NETWORKS, GRAIN_PER_PRL, DUST_GRAIN,
  newMnemonic, walletFromMnemonic, walletFromWIF, walletToWIF, walletFromPriv,
  decodeBech32m, encodeBech32m, tweakKeypath, p2trScriptPubKey,
  keypathTxVBytes, bytesToHex, hexToBytes, sha256,
  u32le, u64le, varint, txidLE,
} from "../../sign/src/crypto.js";
import {
  SIGHASH_DEFAULT, fmtPRL, parsePRL,
  buildKeypathTxEx, verifySignedTx, decodeRawTx, parseUtxoList,
  fetchUtxos, fetchFeeRate, broadcastViaBlockbook,
} from "../../sign/src/sign-core.js";

export {
  NETWORKS, GRAIN_PER_PRL, DUST_GRAIN,
  fmtPRL, parsePRL,
  fetchUtxos, fetchFeeRate, broadcastViaBlockbook, decodeRawTx, parseUtxoList,
  verifySignedTx, SIGHASH_DEFAULT,
  tweakKeypath, p2trScriptPubKey, decodeBech32m, encodeBech32m,
  bytesToHex, hexToBytes, keypathTxVBytes,
  newMnemonic, walletFromMnemonic, walletFromWIF, walletToWIF, walletFromPriv,
};

/** Maximum payees per pay run (relay standardness headroom). */
export const PAYROLL_MAX_PAYEES = 250;
/** Hard vB ceiling for a single pay run (Bitcoin-like standardness margin). */
export const PAYROLL_MAX_VBYTES = 99000;
/** BIP-86 account the sender's mnemonic is derived under (m/86'/coin'/0'/0/0). */
export const PAYROLL_ACCOUNT = 0;
/** Tamper-evident descriptor / bundle kind prefixes. */
export const PAYROLL_DESCRIPTOR_KIND = "pearlpayroll:v1:";
export const PAYROLL_BUNDLE_KIND = "pearl-payroll-unsigned:v1:";
/** Payee labels are off-chain bookkeeping (max 64 chars). */
export const MAX_LABEL_LEN = 64;
/** localStorage key for run history, per network id. */
export const historyStorageKey = (networkId) => `pearl-payroll:history:${networkId}`;

const isHex64 = (s) => /^[0-9a-fA-F]{64}$/.test(s);
const isXprvLike = (s) => /^[xt]prv[1-9A-HJ-NP-Za-km-z]{100,120}$/.test(s);
const isWifLike = (s) => /^[1-9A-HJ-NP-Za-km-z]{40,80}$/.test(s);

/* ---------------- canonical JSON + fingerprints ---------------- */

/** Deterministic canonical JSON: object keys sorted recursively, no whitespace. */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  return "{" + Object.keys(value).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",") + "}";
}

/** 64-bit descriptor fingerprint: first 8 bytes of SHA-256 over canonical JSON, hex. */
export function descriptorFingerprint(descriptorObj) {
  const h = sha256(new TextEncoder().encode(canonicalJson(descriptorObj)));
  return bytesToHex(h.slice(0, 8));
}

/* ---------------- sender secret ---------------- */

/** Accept a sender secret: 12/24-word mnemonic (BIP-86 account 0/0/0),
 *  WIF, 64-hex private key, or xprv/tprv (treated as master, derived at
 *  m/86'/{coinType}'/0'/0/0 — same convention as the mnemonic path).
 *  Uses ONLY the audited Sign lineage. Returns
 *  { kind, mnemonic|null, privHex, internalXOnlyHex, address, program, network }. */
export function parsePayrollSecret(text, network = NETWORKS.mainnet) {
  const t = String(text ?? "").trim();
  if (!t) throw new Error("paste the sender secret — a 12/24-word mnemonic, a WIF key, a 64-hex private key, or an xprv/tprv");
  const words = t.split(/\s+/);
  let w, mnemonic = null, kind;
  if (words.length === 12 || words.length === 24) {
    kind = "mnemonic";
    try { w = walletFromMnemonic(words.join(" "), network, PAYROLL_ACCOUNT, 0); }
    catch (e) { throw new Error("that mnemonic is not valid BIP-39 (" + (e.message || e) + ")"); }
    mnemonic = words.join(" ");
  } else if (isHex64(t)) {
    kind = "hex";
    try { w = walletFromPriv(t.toLowerCase(), network); }
    catch (e) { throw new Error("that hex key is not valid (" + (e.message || e) + ")"); }
  } else if (isXprvLike(t)) {
    kind = "xprv";
    let root;
    try { root = HDKey.fromExtendedKey(t); }
    catch (e) { throw new Error("that extended key is not valid (" + (e.message || e) + ")"); }
    if (!root.privateKey) throw new Error("that extended key has no private part — paste the xprv, not the xpub");
    const child = root.derive(`m/86'/${network.coinType}'/${PAYROLL_ACCOUNT}'/0/0`);
    if (!child.privateKey) throw new Error("derivation failed");
    w = walletFromPriv(child.privateKey, network);
  } else if (isWifLike(t)) {
    kind = "wif";
    try { w = walletFromWIF(t, network); }
    catch (e) { throw new Error("that WIF is not valid (" + (e.message || e) + ")"); }
  } else {
    throw new Error("unrecognized secret — paste a 12/24-word mnemonic, a WIF key, a 64-hex private key, or an xprv/tprv");
  }
  const { tweakedX } = tweakKeypath(w.internalXOnly);
  return {
    kind, mnemonic, network,
    privHex: bytesToHex(w.priv),
    wif: walletToWIF(w.priv, network),
    internalXOnlyHex: bytesToHex(w.internalXOnly),
    address: encodeBech32m(network.hrp, 1, tweakedX),
    program: tweakedX,
  };
}

/** Guard: the signing key MUST control the sender address. Throws loudly. */
export function assertKeyControlsAddress(secret, senderAddress) {
  if (secret.address.toLowerCase() !== String(senderAddress).toLowerCase()) {
    throw new Error(
      `KEY DOES NOT CONTROL THE SENDER ADDRESS — the secret derives ${secret.address} ` +
      `but the pay run spends from ${senderAddress}. Signing with this key would fail or ` +
      `spend someone else's coins; fix the address or use the correct key.`
    );
  }
}

/* ---------------- address validation ---------------- */

/** Validate + canonicalize one Pearl v1 address for the given network. */
export function canonicalAddress(addr, network) {
  const s = String(addr ?? "").trim();
  let dec;
  try { dec = decodeBech32m(s, network.hrp); }
  catch { throw new Error(`not a valid ${network.hrp}1 address: ${s.slice(0, 40)}`); }
  if (dec.version !== 1 || dec.program.length !== 32) {
    throw new Error(`address must be a Pearl v1 (Taproot) address: ${s.slice(0, 40)}`);
  }
  return encodeBech32m(network.hrp, 1, dec.program);
}

/* ---------------- payee roster ---------------- */

/** Parse one roster line. Formats accepted:
 *    address, amount[, label]      — amount in PRL (decimals ok)
 *    address amount [grains] [label...]
 *  A bare `grains` token switches the amount to grains; remaining tokens are
 *  the label (OFF-CHAIN bookkeeping — never on-chain). Lines starting with #
 *  ignored upstream; a header line starting with "address," is skipped.
 *  Returns { address, program, amount (BigInt), label|null }. */
function parseRosterLine(line, lineNo, network) {
  const comma = line.includes(",");
  const parts = comma ? line.split(",").map((p) => p.trim()).filter((p) => p !== "")
                      : line.split(/\s+/).filter(Boolean);
  if (parts.length < 2) throw new Error(`line ${lineNo}: need "<address>, <amount>", got: ${line.slice(0, 60)}`);
  const [addrS, amountField, ...tail] = parts;
  const address = canonicalAddress(addrS, network);
  const dec = decodeBech32m(addrS, network.hrp);
  const fieldToks = amountField.split(/\s+/).filter(Boolean);
  const amountS = fieldToks[0];
  const rest = [...fieldToks.slice(1), ...tail];
  let unit = "prl";
  const labelTokens = [];
  for (const tok of rest) {
    if (/^grains?$/i.test(tok)) unit = "grains";
    else if (/^prl$/i.test(tok)) unit = "prl";
    else labelTokens.push(tok);
  }
  let amount;
  if (unit === "prl") {
    try { amount = parsePRL(amountS); }
    catch { throw new Error(`line ${lineNo}: invalid PRL amount: ${amountS}`); }
  } else {
    if (!/^\d+$/.test(amountS)) throw new Error(`line ${lineNo}: invalid grains amount: ${amountS}`);
    amount = BigInt(amountS);
  }
  if (amount <= 0n) throw new Error(`line ${lineNo}: amount must be positive`);
  if (amount < BigInt(DUST_GRAIN)) {
    throw new Error(
      `line ${lineNo}: ${fmtPRL(amount)} PRL is below the dust floor of ${fmtPRL(DUST_GRAIN)} PRL — ` +
      `raise it or drop the line. Dust payees are refused, never rounded up.`
    );
  }
  const label = labelTokens.join(comma ? ", " : " ").trim();
  if (label.length > MAX_LABEL_LEN) throw new Error(`line ${lineNo}: label longer than ${MAX_LABEL_LEN} chars (labels are off-chain bookkeeping)`);
  return { address, program: dec.program, amount, label: label || null };
}

/** Parse a payee roster (paste or CSV import).
 *  Returns { payees: [{address, program, amount, label}], merged: number,
 *  total: BigInt } — duplicate addresses merge into one payee (amounts
 *  summed; labels joined with "; "). Loud refusal on dust, bad addresses,
 *  or >250 unique payees. */
export function parseRoster(text, network = NETWORKS.mainnet, opts = {}) {
  const mergeDuplicates = opts.mergeDuplicates !== false;
  const t = String(text ?? "");
  let lines = t.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  // Skip a CSV header line ("address,amount,label" or similar).
  if (lines.length > 0 && /^address\s*[,;\t]/i.test(lines[0])) lines = lines.slice(1);
  if (lines.length === 0) throw new Error("no payees — paste one \"<address>, <amount>[, label]\" per line, or import a CSV");
  if (lines.length > PAYROLL_MAX_PAYEES * 4) throw new Error(`too many lines (max ${PAYROLL_MAX_PAYEES} payees — duplicates merge down)`);
  const parsed = lines.map((l, i) => parseRosterLine(l, i + 1, network));
  const byAddr = new Map();
  let merged = 0;
  for (let i = 0; i < parsed.length; i++) {
    const r = parsed[i];
    if (byAddr.has(r.address)) {
      if (!mergeDuplicates) {
        throw new Error(
          `duplicate address ${r.address.slice(0, 24)}… on line ${i + 1} — merging is OFF: ` +
          `remove the repeat line or enable "Merge duplicate addresses"`
        );
      }
      const e = byAddr.get(r.address);
      e.amount += r.amount;
      if (r.label) e.label = e.label ? e.label + "; " + r.label : r.label;
      merged++;
    } else {
      byAddr.set(r.address, { address: r.address, program: r.program, amount: r.amount, label: r.label });
    }
  }
  const payees = [...byAddr.values()];
  if (payees.length > PAYROLL_MAX_PAYEES) {
    throw new Error(`too many unique payees (${payees.length}) — max ${PAYROLL_MAX_PAYEES} per run; split the payroll`);
  }
  const total = payees.reduce((a, r) => a + r.amount, 0n);
  return { payees, merged, total };
}

/** Downloadable sample roster. */
export function sampleRoster() {
  return [
    "# Pearl Payroll sample roster — one payee per line",
    "# <address>, <amount per period>[, label] · amount in PRL (decimals ok), or \"N grains\"",
    "# commas or whitespace both work · # lines ignored · duplicates merge",
    "# labels are OFF-CHAIN bookkeeping only — they never appear on-chain",
    "prl1pr6yuq8u2r95wjzzgpdy8cpnncpl7l8zgy6x5q0367pnc53s2famqg7pt74, 1.25, Alice — senior dev",
    "prl1p7dwp74zgd4te3mqr58d6x3p3t70jljmpe4auey8g824ra4x43tks3y4pr6, 546 grains, Bob — bug bounty",
    "prl1p5gfau0gepxzjkjyx9t88ewnhujrmpjqgqfh8v9vympjaz94x36jqpepvyt 10 Carol — ops retainer",
  ].join("\n") + "\n";
}

/* ---------------- roster CSV import/export ---------------- */

function csvCell(s) {
  const v = String(s ?? "");
  return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

/** Serialize a roster to CSV (header + one row per payee; amounts in PRL). */
export function rosterToCsv(payees) {
  const rows = ["address,amount_prl,label"];
  for (const r of payees) {
    rows.push([csvCell(r.address), csvCell(fmtPRL(r.amount)), csvCell(r.label ?? "")].join(","));
  }
  return rows.join("\n") + "\n";
}

/** Parse a roster CSV previously produced by rosterToCsv (header optional).
 *  Returns the same shape as parseRoster. */
export function rosterFromCsv(text, network = NETWORKS.mainnet, opts = {}) {
  return parseRoster(String(text ?? ""), network, opts);
}

/* ---------------- pay schedule ---------------- */

export const PAY_PERIODS = ["weekly", "biweekly", "monthly", "custom"];

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function parseAnchor(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? "").trim());
  if (!m) throw new Error("anchor date must be YYYY-MM-DD");
  const y = Number(m[1]), mo = Number(m[2]) - 1, d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo || dt.getUTCDate() !== d) {
    throw new Error(`anchor date ${s} is not a real calendar date`);
  }
  return { y, mo, d };
}

function addMonthsUtc(y, mo, d, n) {
  const nm = mo + n;
  const ny = y + Math.floor(nm / 12);
  const mo2 = ((nm % 12) + 12) % 12;
  const dim = new Date(Date.UTC(ny, mo2 + 1, 0)).getUTCDate();
  return { y: ny, mo: mo2, d: Math.min(d, dim) };
}

function utcDayNumber(y, mo, d) {
  return Date.UTC(y, mo, d) / 86400000;
}

function dayNumberToYmd(n) {
  const dt = new Date(n * 86400000);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dt.getUTCDate()).padStart(2, "0");
  return { iso: `${y}-${m}-${d}`, dow: DOW[dt.getUTCDay()] };
}

/** Plan the next `count` pay dates from an anchor payday.
 *  { anchor: "YYYY-MM-DD", period: "weekly"|"biweekly"|"monthly"|"custom",
 *    customDays, count = 12, from = today (YYYY-MM-DD) }.
 *  The anchor is a reference payday; dates strictly before `from` are
 *  skipped, so the table always shows upcoming paydays. Monthly preserves
 *  the anchor's day-of-month (clamped: Jan 31 -> Feb 28).
 *  Returns [{ index, iso, dow }] — index is the run number from the anchor.
 *  The returned array also carries `skippedPaydays` = the number of run
 *  indices skipped because they fell before `from` (0 when the anchor is
 *  today or in the future). Callers MUST surface this: a skipped payday is
 *  a pay run the operator may owe. */
export function nextPayDates({ anchor, period, customDays = 0, count = 12, from = null }) {
  if (!PAY_PERIODS.includes(period)) throw new Error(`unknown pay period "${period}" — pick weekly, biweekly, monthly, or custom`);
  if (!Number.isInteger(count) || count < 1 || count > 60) throw new Error("count must be 1–60");
  let stepDays = 0;
  if (period === "weekly") stepDays = 7;
  else if (period === "biweekly") stepDays = 14;
  else if (period === "custom") {
    stepDays = Math.floor(Number(customDays));
    if (!Number.isFinite(stepDays) || stepDays < 1) throw new Error("custom period needs a positive whole number of days");
    if (stepDays > 365) throw new Error("custom period is capped at 365 days");
  }
  const a = parseAnchor(anchor);
  const fromStr = from || new Date().toISOString().slice(0, 10);
  const fromN = utcDayNumber(...fromStr.split("-").map(Number).map((v, i) => i === 1 ? v - 1 : v));
  const anchorN = utcDayNumber(a.y, a.mo, a.d);
  let n = 0; // run index from anchor
  if (anchorN < fromN) {
    if (period === "monthly") {
      // walk months forward until at/after `from`
      let probe = { ...a };
      while (utcDayNumber(probe.y, probe.mo, probe.d) < fromN) {
        probe = addMonthsUtc(a.y, a.mo, a.d, ++n);
      }
    } else {
      n = Math.ceil((fromN - anchorN) / stepDays);
    }
  }
  const dates = [];
  for (let i = 0; i < count; i++) {
    const k = n + i;
    let ymd;
    if (period === "monthly") {
      const p = addMonthsUtc(a.y, a.mo, a.d, k);
      ymd = { iso: `${p.y}-${String(p.mo + 1).padStart(2, "0")}-${String(p.d).padStart(2, "0")}` };
      ymd.dow = DOW[new Date(Date.UTC(p.y, p.mo, p.d)).getUTCDay()];
    } else {
      const dn = anchorN + k * stepDays;
      ymd = dayNumberToYmd(dn);
    }
    dates.push({ index: k, iso: ymd.iso, dow: ymd.dow });
  }
  dates.skippedPaydays = n; // runs 0..n-1 fell before `from` — surfaced by the UI
  return dates;
}

/** Milliseconds until the first date in `dates` (UTC midnight), for countdown. */
export function msUntilPayday(dates, nowMs = Date.now()) {
  if (!dates.length) throw new Error("no pay dates planned");
  const first = dates[0].iso;
  const t = Date.parse(first + "T00:00:00Z");
  return t - nowMs;
}

/** Human countdown: "6d 3h 12m" style (or "due now"/"overdue"). */
export function fmtCountdown(ms) {
  if (ms < 0) return "overdue — run it now";
  if (ms === 0) return "due now";
  const m = Math.floor(ms / 60000);
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  if (d > 0) return `${d}d ${h}h ${mm}m`;
  if (h > 0) return `${h}h ${mm}m`;
  return `${mm}m`;
}

/* ---------------- UTXO selection ---------------- */

/** Validate UTXO list shape. Values are grains (safe ints). */
export function assertUtxos(utxos) {
  if (!Array.isArray(utxos) || utxos.length === 0) throw new Error("no UTXOs — fetch the sender's UTXOs or paste them first");
  for (const u of utxos) {
    if (!/^[0-9a-f]{64}$/i.test(String(u.txid || ""))) throw new Error("bad utxo txid");
    if (!Number.isInteger(u.vout) || u.vout < 0) throw new Error("bad utxo vout");
    if (!Number.isSafeInteger(u.value) || u.value <= 0) throw new Error("bad utxo value (grains, positive safe int)");
  }
}

/** Largest-first auto-selection covering sumOut + fee at feeRate grains/vB.
 *  Returns { selected, fee (BigInt), change (BigInt), changeDropped, vBytes }.
 *  Change below dust is absorbed into the fee (disclosed, never silent). */
export function autoSelectUtxos(utxos, sumOut, feeRateGrainsPerVByte, nOut) {
  assertUtxos(utxos);
  const rate = Math.ceil(Number(feeRateGrainsPerVByte));
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("fee rate must be a positive number of grains/vB");
  const sorted = [...utxos].sort((a, b) => b.value - a.value);
  const selected = [];
  let total = 0n;
  for (const u of sorted) {
    selected.push(u);
    total += BigInt(u.value);
    const withChange = keypathTxVBytes(selected.length, nOut + 1);
    const feeWithChange = BigInt(withChange) * BigInt(rate);
    if (total - sumOut - feeWithChange >= BigInt(DUST_GRAIN)) {
      return { selected, fee: feeWithChange, change: total - sumOut - feeWithChange, changeDropped: false, vBytes: withChange };
    }
    const noChange = keypathTxVBytes(selected.length, nOut);
    const feeNoChange = BigInt(noChange) * BigInt(rate);
    if (total >= sumOut + feeNoChange) {
      return { selected, fee: total - sumOut, change: 0n, changeDropped: true, vBytes: noChange };
    }
  }
  const best = keypathTxVBytes(selected.length, nOut);
  throw new Error(
    `insufficient funds: have ${fmtPRL(total)} PRL, need ${fmtPRL(sumOut)} PRL for payees ` +
    `+ ~${fmtPRL(BigInt(best) * BigInt(rate))} PRL fee. Add inputs or reduce payees.`
  );
}

/** Estimate the fee of one pay run BEFORE inputs are chosen (nIn assumed).
 *  Used by the coverage check on step 3. */
export function estimateRunFee({ nPayees, nIn = 1, feeRateGrainsPerVByte }) {
  const rate = Math.ceil(Number(feeRateGrainsPerVByte));
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("fee rate must be a positive number of grains/vB");
  if (!Number.isInteger(nPayees) || nPayees < 1) throw new Error("need at least one payee");
  return BigInt(keypathTxVBytes(nIn, nPayees + 1)) * BigInt(rate);
}

/** How many full upcoming pay runs the balance covers (run total + fee each).
 *  Returns a whole number >= 0. */
export function runsCovered(balanceGrains, runTotalGrains, feeGrains) {
  const b = BigInt(balanceGrains), t = BigInt(runTotalGrains), f = BigInt(feeGrains);
  const per = t + f;
  if (per <= 0n) throw new Error("run cost must be positive");
  if (b <= 0n) return 0;
  return Number(b / per);
}

/* ---------------- pay-run planning ---------------- */

/** Plan one pay run from an EXPLICITLY selected input set (manual control).
 *  Fee = keypathTxVBytes(nIn, nOut[+1]) * rate, grain-exact BigInt.
 *  When the change output would be dust it is dropped and absorbed into the
 *  fee: plan.fee is then the ACTUAL fee (total - sumOut), plan.nominalFee the
 *  vBytes*rate figure, and plan.changeBump = actual - nominal, disclosed.
 *  Returns { total, sumOut, fee, change, changeDropped, inputs, outputs,
 *  vBytes, feeRate, nIn, nOut, changeBump, nominalFee } — throws loudly on
 *  shortfall. Invariant: total === sumOut + fee + change, always. */
export function planRun({ utxos, payees, senderProgram, feeRateGrainsPerVByte, network = NETWORKS.mainnet }) {
  assertUtxos(utxos);
  if (!Array.isArray(payees) || payees.length === 0) throw new Error("no payees in the roster");
  if (payees.length > PAYROLL_MAX_PAYEES) throw new Error(`too many payees (max ${PAYROLL_MAX_PAYEES})`);
  if (!(senderProgram instanceof Uint8Array) || senderProgram.length !== 32) throw new Error("bad sender program");
  const rate = Math.ceil(Number(feeRateGrainsPerVByte));
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("fee rate must be a positive number of grains/vB");
  for (const r of payees) {
    if (r.amount < BigInt(DUST_GRAIN)) throw new Error(`payee ${r.address.slice(0, 18)}… is below dust — re-validate the roster`);
    if (!(r.program instanceof Uint8Array) || r.program.length !== 32) throw new Error(`payee ${r.address.slice(0, 18)}… has a bad program`);
  }
  const total = utxos.reduce((a, u) => a + BigInt(u.value), 0n);
  const sumOut = payees.reduce((a, r) => a + BigInt(r.amount), 0n);
  const nIn = utxos.length, n = payees.length;

  let vBytes = keypathTxVBytes(nIn, n + 1);
  let fee = BigInt(vBytes) * BigInt(rate);
  let change = total - sumOut - fee;
  let changeDropped = false;
  if (change >= BigInt(DUST_GRAIN)) {
    // keep change
  } else {
    changeDropped = true; // dust change -> absorbed into the fee, disclosed loudly
    vBytes = keypathTxVBytes(nIn, n);
    fee = BigInt(vBytes) * BigInt(rate);
    change = 0n;
  }
  if (vBytes > PAYROLL_MAX_VBYTES) {
    throw new Error(`pay run too large: ${vBytes} vB exceeds the ${PAYROLL_MAX_VBYTES} vB ceiling — split the payroll`);
  }
  const minNeed = sumOut + fee;
  if (total < minNeed) {
    throw new Error(
      `insufficient funds: inputs hold ${fmtPRL(total)} PRL, need ${fmtPRL(minNeed)} PRL ` +
      `(${fmtPRL(sumOut)} to payees + ${fmtPRL(fee)} fee at ${rate} gr/vB over ${vBytes} vB). ` +
      `Add inputs, drop payees, or lower the fee rate.`
    );
  }
  const leftover = total - sumOut - fee;
  const outputs = payees.map((r) => ({
    address: r.address, program: r.program, value: Number(r.amount), label: r.label ?? null, change: false,
  }));
  if (!changeDropped) {
    outputs.push({
      address: encodeBech32m(network.hrp, 1, senderProgram),
      program: senderProgram, value: Number(leftover), label: null, change: true,
    });
  }
  const nominalFee = fee;
  const actualFee = changeDropped ? total - sumOut : fee;
  return {
    total, sumOut, fee: actualFee, change: changeDropped ? 0n : leftover,
    inputs: utxos, outputs, vBytes, feeRate: rate, nIn, nOut: outputs.length, changeDropped,
    changeBump: changeDropped ? leftover : 0n,
    nominalFee,
  };
}

/* ---------------- unsigned wire (for bundles) ---------------- */

/** Build the non-witness serialization of the pay run (inputs/outputs only).
 *  Serialization reuses the audited helpers (u32le/varint/u64le/txidLE/
 *  p2trScriptPubKey/sha256) with the exact layout sign-core's buildKeypathTxEx
 *  uses — no new wire format is invented. Returns { hex, txid } (the
 *  unsigned txid = dbl-sha256 of the non-witness serialization). */
export function buildUnsignedTx(network, inputs, outputs) {
  if (!inputs.length || !outputs.length) throw new Error("need inputs and outputs");
  const core = [...u32le(network.txVersion), ...varint(inputs.length)];
  for (const inp of inputs) core.push(...txidLE(inp.txid), ...u32le(inp.vout), ...varint(0), ...u32le(0xffffffff));
  core.push(...varint(outputs.length));
  for (const out of outputs) {
    const s = p2trScriptPubKey(out.program);
    const v = BigInt(out.value);
    if (v <= 0n || v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("bad output value");
    const lo = Number(v & 0xffffffffn), hi = Number(v >> 32n);
    core.push(...u32le(lo), ...u32le(hi), ...varint(s.length), ...s);
  }
  core.push(...u32le(0));
  const bytes = Uint8Array.from(core);
  return { hex: bytesToHex(bytes), txid: bytesToHex(sha256(sha256(bytes)).reverse()) };
}

/* ---------------- run descriptor + unsigned bundle ---------------- */

/** Build the tamper-evident pay-run descriptor from a settled plan.
 *  Labels are included (off-chain bookkeeping); the fingerprint covers
 *  everything. The descriptor records the schedule context (period, payDate,
 *  runLabel) so a signed bundle cannot be silently re-pointed at another run. */
export function buildDescriptor({ network, senderAddress, payees, plan, feeRate, period, payDate, runLabel }) {
  const d = {
    kind: PAYROLL_DESCRIPTOR_KIND,
    network: network.id,
    senderAddress,
    feeRate,
    period: period ?? null,
    payDate: payDate ?? null,
    runLabel: runLabel ?? null,
    payees: payees.map((r) => ({
      address: r.address,
      amountGrains: r.amount.toString(),
      label: r.label ?? null,
    })),
    inputs: plan.inputs.map((u) => ({
      txid: String(u.txid).toLowerCase(),
      vout: u.vout,
      valueGrains: BigInt(u.value).toString(),
      confirmations: u.confirmations ?? 0,
    })),
    outputs: plan.outputs.map((o) => ({
      address: o.address,
      valueGrains: BigInt(o.value).toString(),
      change: o.change,
    })),
    totals: {
      inputsGrains: plan.total.toString(),
      payeesGrains: plan.sumOut.toString(),
      feeGrains: plan.fee.toString(),
      changeGrains: plan.change.toString(),
      vBytes: plan.vBytes,
    },
  };
  return { descriptor: d, fingerprint: descriptorFingerprint(d) };
}

/** Export an unsigned bundle: descriptor + fingerprint + unsigned wire +
 *  digest/fee/vBytes cross-check fields. Import rebuilds everything and
 *  refuses loudly on ANY mismatch. */
export function exportUnsignedBundle({ network, senderAddress, payees, plan, feeRate, period, payDate, runLabel }) {
  const { descriptor, fingerprint } = buildDescriptor({ network, senderAddress, payees, plan, feeRate, period, payDate, runLabel });
  const unsigned = buildUnsignedTx(
    network,
    plan.inputs.map((u) => ({ txid: String(u.txid).toLowerCase(), vout: u.vout })),
    plan.outputs.map((o) => ({ program: o.program, value: o.value }))
  );
  return {
    bundle: PAYROLL_BUNDLE_KIND,
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
 *  descriptor alone, and cross-checks every stored value. Returns
 *  { network, senderAddress, payees, plan, feeRate, period, payDate,
 *    runLabel, fingerprint }. Throws loudly naming the exact mismatch. */
export function importUnsignedBundle(bundle) {
  const b = typeof bundle === "string" ? JSON.parse(bundle) : bundle;
  if (!b || b.bundle !== PAYROLL_BUNDLE_KIND) throw new Error("not a Pearl Payroll unsigned bundle — wrong 'bundle' kind tag");
  const d = b.descriptor;
  if (!d || d.kind !== PAYROLL_DESCRIPTOR_KIND) throw new Error("bundle descriptor has a bad kind tag");
  const network = NETWORKS[d.network];
  if (!network) throw new Error(`unknown network "${d.network}" in bundle descriptor`);

  const wantFp = descriptorFingerprint(d);
  if (wantFp !== b.fingerprint) {
    throw new Error(
      `BUNDLE FINGERPRINT MISMATCH — the descriptor was tampered with (or corrupted): ` +
      `stored ${b.fingerprint}, recomputed ${wantFp}. Refusing to sign.`
    );
  }
  if (!Array.isArray(d.payees) || d.payees.length === 0) throw new Error("bundle descriptor has no payees");
  if (d.payees.length > PAYROLL_MAX_PAYEES) throw new Error("bundle descriptor exceeds the payee cap");
  const payees = d.payees.map((r, i) => {
    const address = canonicalAddress(r.address, network);
    const dec = decodeBech32m(r.address, network.hrp);
    const amount = BigInt(r.amountGrains);
    if (amount < BigInt(DUST_GRAIN)) throw new Error(`bundle payee #${i + 1} is below dust — refusing`);
    const label = r.label == null ? null : String(r.label);
    if (label && label.length > MAX_LABEL_LEN) throw new Error(`bundle payee #${i + 1} label too long`);
    return { address, program: dec.program, amount, label };
  });
  const inputs = (d.inputs || []).map((u) => {
    if (!/^[0-9a-f]{64}$/i.test(String(u.txid || ""))) throw new Error("bundle input has a bad txid");
    return { txid: String(u.txid).toLowerCase(), vout: u.vout, value: Number(BigInt(u.valueGrains)), confirmations: u.confirmations ?? 0 };
  });
  const senderDec = decodeBech32m(d.senderAddress, network.hrp);
  const senderProgram = senderDec.program;
  const plan = planRun({ utxos: inputs, payees, senderProgram, feeRateGrainsPerVByte: d.feeRate, network });

  const unsigned = buildUnsignedTx(
    network,
    inputs.map((u) => ({ txid: u.txid, vout: u.vout })),
    plan.outputs.map((o) => ({ program: o.program, value: o.value }))
  );
  if (unsigned.hex !== String(b.unsignedHex).toLowerCase()) {
    throw new Error("BUNDLE WIRE DIGEST MISMATCH — the unsigned hex does not rebuild from the descriptor. Refusing to sign.");
  }
  if (unsigned.txid !== b.unsignedTxid) {
    throw new Error(`BUNDLE DIGEST MISMATCH — rebuilt unsigned txid ${unsigned.txid} != stored ${b.unsignedTxid}. Refusing to sign.`);
  }
  const wantDigest = bytesToHex(sha256(new TextEncoder().encode(unsigned.hex)));
  if (wantDigest !== b.wireDigest) throw new Error("BUNDLE WIRE DIGEST MISMATCH — the unsigned hex was altered. Refusing to sign.");
  if (plan.fee.toString() !== String(b.feeGrains)) {
    throw new Error(`BUNDLE FEE MISMATCH — recomputed ${plan.fee} grains != stored ${b.feeGrains}. Refusing to sign.`);
  }
  if (plan.vBytes !== b.vBytes) {
    throw new Error(`BUNDLE SIZE MISMATCH — recomputed ${plan.vBytes} vB != stored ${b.vBytes} vB. Refusing to sign.`);
  }
  return {
    network, senderAddress: d.senderAddress, payees, plan, feeRate: d.feeRate,
    period: d.period, payDate: d.payDate, runLabel: d.runLabel, fingerprint: b.fingerprint,
  };
}

/* ---------------- build + sign + verify ---------------- */

/** Build + Schnorr-sign + locally re-verify the pay run.
 *  Every input is the sender's keypath spend; each signature is re-verified
 *  with verifySignedTx BEFORE the hex is returned. Returns { txid, hex, plan }.
 *  Throws (and never exposes hex) if any local verification fails. */
export function buildPayrollTx({ secret, senderAddress, utxos, plan, network = NETWORKS.mainnet }) {
  assertKeyControlsAddress(secret, senderAddress);
  const w = walletFromPriv(secret.privHex, network);
  const { tweakedX } = tweakKeypath(w.internalXOnly);
  const spk = p2trScriptPubKey(tweakedX);
  const derived = encodeBech32m(network.hrp, 1, tweakedX);
  if (derived.toLowerCase() !== String(senderAddress).toLowerCase()) {
    throw new Error("derived sender address does not match the roster sender — refusing to sign");
  }
  const inputs = utxos.map((u) => ({
    txid: String(u.txid).toLowerCase(), vout: u.vout, value: u.value,
    spk, priv: w.priv, internalXOnly: w.internalXOnly,
  }));
  const outputs = plan.outputs.map((o) => ({ program: o.program, value: o.value }));
  const { txid, hex } = buildKeypathTxEx(network, inputs, outputs, SIGHASH_DEFAULT);
  const prevouts = inputs.map((i) => ({ value: i.value, spk: i.spk }));
  const checks = verifySignedTx(network, hex, prevouts);
  const bad = checks.filter((c) => !c.ok);
  if (bad.length || checks.length !== inputs.length) {
    throw new Error("local signature verification failed: " + bad.map((x) => `#${x.index}: ${x.reason}`).join("; "));
  }
  return { txid, hex, plan, senderAddress };
}

/* ---------------- run history ---------------- */

/** Build a run-history record. payees: [{address, label, grains (BigInt)}].
 *  All values are plain JSON (grains as strings). */
export function recordPayrollRun({ payDate, period, runLabel, txid, payees, feeGrains, vBytes, recordedAt = null }) {
  if (!/^[0-9a-f]{64}$/i.test(String(txid || ""))) throw new Error("bad txid for history record");
  if (!Array.isArray(payees) || payees.length === 0) throw new Error("history record needs at least one payee");
  return {
    version: 1,
    recordedAt: recordedAt || new Date().toISOString(),
    payDate: String(payDate || ""),
    period: String(period || ""),
    runLabel: String(runLabel || ""),
    txid: String(txid).toLowerCase(),
    feeGrains: BigInt(feeGrains).toString(),
    vBytes: Number(vBytes),
    payees: payees.map((p) => ({
      address: String(p.address),
      label: p.label == null ? null : String(p.label),
      grains: BigInt(p.grains).toString(),
    })),
  };
}

/** Validate a parsed history record (defensive — localStorage can hold anything). */
export function assertHistoryRecord(r) {
  if (!r || typeof r !== "object") throw new Error("bad history record");
  if (!/^[0-9a-f]{64}$/i.test(String(r.txid || ""))) throw new Error("history record has a bad txid");
  if (!Array.isArray(r.payees) || r.payees.length === 0) throw new Error("history record has no payees");
  for (const p of r.payees) {
    if (!p.address) throw new Error("history payee missing address");
    BigInt(p.grains); // throws on garbage
  }
  return r;
}

/** Serialize run records to CSV: one row per payee per run. */
export function runsToCsv(runs) {
  const rows = ["pay_date,period,run_label,txid,payee_address,payee_label,grains,prl"];
  for (const r of runs) {
    for (const p of r.payees) {
      rows.push([
        csvCell(r.payDate), csvCell(r.period), csvCell(r.runLabel), csvCell(r.txid),
        csvCell(p.address), csvCell(p.label ?? ""), csvCell(p.grains), csvCell(fmtPRL(BigInt(p.grains))),
      ].join(","));
    }
  }
  return rows.join("\n") + "\n";
}

/** Per-payee totals across runs: Map keyed by address ->
 *  { address, label, totalGrains (BigInt), runs (number) }. */
export function perPayeeTotals(runs) {
  const byAddr = new Map();
  for (const r of runs) {
    for (const p of r.payees) {
      const k = String(p.address).toLowerCase();
      if (!byAddr.has(k)) byAddr.set(k, { address: p.address, label: p.label, totalGrains: 0n, runs: 0 });
      const e = byAddr.get(k);
      e.totalGrains += BigInt(p.grains);
      e.runs += 1;
      if (!e.label && p.label) e.label = p.label;
    }
  }
  return byAddr;
}
