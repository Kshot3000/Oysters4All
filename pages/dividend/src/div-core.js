/* Pearl Dividend core — PRL-20 holder dividend desk.
 *
 * A dividend on Pearl is honest work, and this file is honest about it:
 * Pearl has no smart contracts and the PRL-20 ledger lives in the
 * Pearlscriptions indexer, not in Pearl consensus. So this desk never claims
 * to pay "the on-chain holders" trustlessly. Instead it:
 *
 *   1. reads token metadata from a Pearlscriptions indexer YOU choose
 *      (GET-only), or from metadata you type by hand (labeled manual);
 *   2. takes YOUR holder snapshot as a CSV manifest (address, token balance)
 *      — exported from an indexer you run, or assembled by hand — validates
 *      every address in-browser, hashes the canonical list, and seals it in
 *      a tamper-evident `pearl-div-snapshot:v1` descriptor with a 64-bit
 *      fingerprint;
 *   3. derives per-holder PRL shares with grain-exact BigInt math
 *      (proportional / equal / fixed-per-holder), drops dust shares LOUDLY,
 *      accounts for every remainder grain, and chunks recipients into
 *      <=250-output transactions;
 *   4. funds each chunk from your key (GET-only Blockbook reads or an
 *      air-gapped paste), signs locally with per-input Schnorr
 *      re-verification;
 *   5. verifies: anyone recomputes the shares from the snapshot CSV plus the
 *      descriptor and audits every broadcast chunk against the chain.
 *
 * The payout transactions are plain keypath spends. ALL planning, signing,
 * and auditing machinery is reused verbatim from the audited batch and sign
 * cores — no new cryptography is introduced here. The dividend-specific
 * logic is only: token-unit parsing, snapshot validation, share derivation,
 * chunking, descriptors, and the standalone verifier.
 */

import {
  canonicalJson, descriptorFingerprint, buildUnsignedTx,
  parseBatchSecret, assertKeyControlsAddress, canonicalAddress,
  autoSelectUtxos, planDispatch, buildBatchTx, auditBatchTx,
  BATCH_MAX_OUTPUTS,
} from "../../batch/src/batch-core.js";
import {
  selectCoins, buildKeypathTxEx, verifySignedTx, decodeRawTx,
  fmtPRL, parsePRL, SIGHASH_DEFAULT,
} from "../../sign/src/sign-core.js";
import {
  taggedHash, encodeBech32m, decodeBech32m,
  schnorr, sha256, bytesToHex, hexToBytes,
  varint, u32le, u64le, p2trScriptPubKey, txidLE,
  DUST_GRAIN, GRAIN_PER_PRL, NETWORKS,
  walletFromMnemonic, walletFromPriv, walletFromWIF,
  fetchUtxos, fetchFeeRateGrainsPerVByte, broadcastTx, fetchTxStatus,
  keypathTxVBytes,
} from "../../sign/src/crypto.js";

export {
  DUST_GRAIN, GRAIN_PER_PRL, NETWORKS, fmtPRL, parsePRL,
  canonicalJson, descriptorFingerprint, buildUnsignedTx,
  parseBatchSecret, assertKeyControlsAddress, canonicalAddress,
  autoSelectUtxos, planDispatch, buildBatchTx, auditBatchTx,
  selectCoins, buildKeypathTxEx, verifySignedTx, decodeRawTx,
  walletFromMnemonic, walletFromPriv, walletFromWIF,
  fetchUtxos, fetchFeeRateGrainsPerVByte, broadcastTx, fetchTxStatus,
  keypathTxVBytes, bytesToHex, hexToBytes, sha256, schnorr,
  encodeBech32m, decodeBech32m,
};

export const DIV_ACCOUNT = 0; // same desk-account convention as batch/payroll
export const DIV_MAX_OUTPUTS = BATCH_MAX_OUTPUTS; // 250 recipients per chunk tx
export const DIV_MAX_CSV_HOLDERS = 100000;
export const DIV_MAX_DECIMALS = 18;
export const SNAPSHOT_DESCRIPTOR_KIND = "pearl-div-snapshot:v1";
export const DIV_DESCRIPTOR_KIND = "pearl-div:v1";
export const DIV_BUNDLE_KIND = "pearl-div-unsigned:v1:";

const utf8 = (s) => new TextEncoder().encode(s);
const isHex64 = (s) => /^[0-9a-fA-F]{64}$/.test(s);

/* ---------------- token units ---------------- */

/** Parse a human token amount ("1.5", "100") into base units (BigInt).
 *  decimals: token decimals (0..18). Strict: no signs, no exponents,
 *  fraction digits must fit the decimals. Throws loudly otherwise. */
export function parseTokenUnits(s, decimals) {
  const dec = Number(decimals);
  if (!Number.isInteger(dec) || dec < 0 || dec > DIV_MAX_DECIMALS) {
    throw new Error(`bad token decimals: ${decimals}`);
  }
  const t = String(s ?? "").trim();
  const m = /^(\d+)(?:\.(\d+))?$/.exec(t);
  if (!m) throw new Error(`bad token amount: ${String(s).slice(0, 40)}`);
  const frac = (m[2] || "").replace(/0+$/, "");
  if (frac.length > dec) {
    throw new Error(`amount ${t} has more fraction digits than the token's ${dec} decimals`);
  }
  const padded = (m[1] + frac.padEnd(dec, "0")).replace(/^0+(?=\d)/, "");
  return BigInt(padded === "" ? "0" : padded);
}

/** Format base-unit BigInt back to a human string, trimming trailing zeros. */
export function formatTokenUnits(units, decimals) {
  const dec = Number(decimals);
  const u = BigInt(units);
  if (u < 0n) throw new Error("negative token units");
  if (dec === 0) return u.toString();
  const s = u.toString().padStart(dec + 1, "0");
  const int = s.slice(0, -dec).replace(/^0+(?=\d)/, "");
  const frac = s.slice(-dec).replace(/0+$/, "");
  return frac ? `${int}.${frac}` : int;
}

/* ---------------- snapshot ---------------- */

/** Validate one holder address for the network; returns canonical form. */
export function validateHolderAddress(addr, network = NETWORKS.mainnet) {
  return canonicalAddress(addr, network); // v1 Taproot, 32-byte program, correct hrp
}

/** Parse a holder snapshot CSV. Accepted per line:
 *    address,amount        — amount in whole/fractional token units
 *  Blank lines and `#` comment lines are ignored. An optional header line
 *  starting with "address" is skipped. Amounts are parsed with parseTokenUnits
 *  and must be > 0. Returns { holders, errors, duplicates, totalUnits }.
 *  holders: [{ address, units (BigInt), line }]. Duplicates are NOT merged
 *  here — they are reported so the UI can offer merge-or-refuse. */
export function parseSnapshotCsv(text, { network = NETWORKS.mainnet, decimals = 8 } = {}) {
  const raw = String(text ?? "").split(/\r?\n/);
  const holders = [];
  const errors = [];
  const seen = new Map(); // canonical address -> first line
  const duplicates = [];
  let headerSkipped = false;
  for (let i = 0; i < raw.length; i++) {
    const lineNo = i + 1;
    let line = raw[i].trim();
    if (!line || line.startsWith("#")) continue;
    if (!headerSkipped && /^address\s*,/i.test(line)) { headerSkipped = true; continue; }
    headerSkipped = true;
    const comma = line.indexOf(",");
    if (comma < 0) { errors.push(`line ${lineNo}: expected "address,amount"`); continue; }
    let addr = line.slice(0, comma).trim().replace(/^"|"$/g, "");
    let amt = line.slice(comma + 1).trim().replace(/^"|"$/g, "");
    // tolerate a trailing comment after the amount
    const hashAt = amt.indexOf("#");
    if (hashAt >= 0) amt = amt.slice(0, hashAt).trim();
    let canon;
    try { canon = validateHolderAddress(addr, network); }
    catch (e) { errors.push(`line ${lineNo}: ${e.message}`); continue; }
    let units;
    try { units = parseTokenUnits(amt, decimals); }
    catch (e) { errors.push(`line ${lineNo}: ${e.message}`); continue; }
    if (units <= 0n) { errors.push(`line ${lineNo}: balance must be positive`); continue; }
    if (seen.has(canon)) {
      duplicates.push({ address: canon, line: lineNo, firstLine: seen.get(canon) });
      continue;
    }
    seen.set(canon, lineNo);
    holders.push({ address: canon, units, line: lineNo });
  }
  if (holders.length > DIV_MAX_CSV_HOLDERS) {
    throw new Error(`snapshot has ${holders.length} holders — cap is ${DIV_MAX_CSV_HOLDERS}`);
  }
  if (holders.length === 0) {
    throw new Error(
      "no valid holders in the snapshot" +
      (errors.length ? " — first problems: " + errors.slice(0, 3).join("; ") : "")
    );
  }
  const totalUnits = holders.reduce((a, h) => a + h.units, 0n);
  return { holders, errors, duplicates, totalUnits };
}

/** Merge duplicate holder rows by summing balances (first-seen order kept).
 *  Returns a new holder array. */
export function mergeDuplicateHolders(holders) {
  const map = new Map();
  const order = [];
  for (const h of holders) {
    if (!map.has(h.address)) { map.set(h.address, { ...h }); order.push(h.address); }
    else map.get(h.address).units += h.units;
  }
  return order.map((a) => map.get(a));
}

/** Deterministic, clearly-labeled sample snapshot for UI testing only.
 *  Addresses are derived from a fixed domain string — they are NOT real
 *  holders. The UI must label this as sample data. */
export function sampleSnapshotCsv(network = NETWORKS.mainnet, n = 8) {
  const lines = ["# SAMPLE SNAPSHOT — for UI testing only, not real holders", "address,balance"];
  for (let i = 0; i < n; i++) {
    const prog = sha256(utf8(`pearl-div-sample:${network.id}:${i}`));
    lines.push(`${encodeBech32m(network.hrp, 1, prog)},${(i + 1) * 100}`);
  }
  return lines.join("\n");
}

/* ---------------- snapshot descriptor ---------------- */

/** Seal a holder snapshot in a tamper-evident descriptor.
 *  holders must already be merged + validated. maxSupplyUnits may be null
 *  (unknown). indexerStatus: { height, ... } | null. manualMeta: true when
 *  the token metadata was typed by hand instead of read from an indexer. */
export function buildSnapshotDescriptor({
  network = NETWORKS.mainnet, tick, decimals, holders,
  maxSupplyUnits = null, indexerBase = null, indexerStatus = null,
  manualMeta = false, memo = "",
}) {
  const t = String(tick || "").toLowerCase().trim();
  if (!/^[a-z0-9]{1,16}$/.test(t)) throw new Error(`bad token ticker: ${tick}`);
  const dec = Number(decimals);
  if (!Number.isInteger(dec) || dec < 0 || dec > DIV_MAX_DECIMALS) throw new Error("bad decimals");
  if (!Array.isArray(holders) || holders.length === 0) throw new Error("no holders to seal");
  const sorted = [...holders]
    .map((h) => ({ address: validateHolderAddress(h.address, network), units: BigInt(h.units).toString() }))
    .sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
  const totalUnits = sorted.reduce((a, h) => a + BigInt(h.units), 0n);
  const maxU = maxSupplyUnits == null ? null : BigInt(maxSupplyUnits);
  const supplyCheck = maxU == null ? "UNKNOWN" : (totalUnits <= maxU ? "PASS" : "FAIL");
  const d = {
    kind: SNAPSHOT_DESCRIPTOR_KIND,
    network: network.id,
    tick: t,
    decimals: dec,
    holderCount: sorted.length,
    holders: sorted,
    totalUnits: totalUnits.toString(),
    maxSupplyUnits: maxU == null ? null : maxU.toString(),
    supplyCheck,
    indexerBase: indexerBase || null,
    indexerStatus: indexerStatus || null,
    manualMeta: !!manualMeta,
    memo: String(memo || "").slice(0, 280),
    createdAt: new Date().toISOString(),
  };
  // The fingerprint binds the holder list only (see snapshotContentFingerprint)
  // so the verifier can re-seal the bare CSV and reproduce it exactly.
  return { descriptor: d, fingerprint: snapshotContentFingerprint(d) };
}

/** Content fingerprint of a sealed snapshot: binds ONLY the holder list
 *  (kind/network/tick/decimals/count/holders/total). Indexer status, memo,
 *  supply-check outcome and createdAt are audit context carried in the
 *  descriptor but NOT fingerprint-bound, so anyone can re-seal the same CSV
 *  and reproduce the fingerprint exactly. */
export function snapshotContentFingerprint(d) {
  return descriptorFingerprint({
    kind: d.kind,
    network: d.network,
    tick: d.tick,
    decimals: d.decimals,
    holderCount: d.holderCount,
    holders: d.holders,
    totalUnits: d.totalUnits,
  });
}

/* ---------------- share derivation ---------------- */

/** Derive per-holder PRL shares from a sealed snapshot descriptor.
 *  Rules:
 *    proportional: share_i = floor(pool * units_i / totalEligibleUnits)
 *    equal:        share_i = floor(pool / n)
 *    fixed:        share_i = fixedGrains (refuses if n*fixed > pool)
 *  Shares below dustFloorGrains are DROPPED loudly (their grains return to
 *  the remainder — disclosed, never silent). remainder = pool - Σ paid.
 *  Returns { eligible, paid, droppedDust, excludedCount, belowMinCount,
 *  totalEligibleUnits, remainderGrains }. */
export function deriveShares({
  snapshot, // { descriptor } from buildSnapshotDescriptor
  poolGrains,
  rule = "proportional",
  fixedGrains = 0n,
  dustFloorGrains = BigInt(DUST_GRAIN),
  exclusions = [],
  minBalanceUnits = 0n,
}) {
  const d = snapshot.descriptor;
  if (!d || d.kind !== SNAPSHOT_DESCRIPTOR_KIND) throw new Error("not a pearl-div-snapshot:v1 descriptor");
  const network = NETWORKS[d.network];
  if (!network) throw new Error(`unknown network "${d.network}" in snapshot`);
  const pool = BigInt(poolGrains);
  if (pool <= 0n) throw new Error("dividend pool must be positive");
  const dustFloor = BigInt(dustFloorGrains);
  if (dustFloor < 0n) throw new Error("dust floor cannot be negative");
  const minBal = BigInt(minBalanceUnits);
  const excluded = new Set(exclusions.map((a) => String(a).trim().toLowerCase()));
  if (!["proportional", "equal", "fixed"].includes(rule)) throw new Error(`unknown rule "${rule}"`);

  const eligible = [];
  let excludedCount = 0, belowMinCount = 0;
  for (const h of d.holders) {
    const units = BigInt(h.units);
    if (excluded.has(h.address.toLowerCase())) { excludedCount++; continue; }
    if (units < minBal) { belowMinCount++; continue; }
    eligible.push({ address: h.address, units });
  }
  if (eligible.length === 0) throw new Error("no eligible holders after exclusions / minimum balance");
  const totalEligibleUnits = eligible.reduce((a, h) => a + h.units, 0n);

  const raw = new Map(); // address -> raw share
  if (rule === "proportional") {
    if (totalEligibleUnits <= 0n) throw new Error("total eligible balance is zero — nothing to weight by");
    for (const h of eligible) raw.set(h.address, (pool * h.units) / totalEligibleUnits);
  } else if (rule === "equal") {
    const share = pool / BigInt(eligible.length);
    for (const h of eligible) raw.set(h.address, share);
  } else {
    const fixed = BigInt(fixedGrains);
    if (fixed <= 0n) throw new Error("fixed rule needs a positive per-holder amount");
    if (fixed * BigInt(eligible.length) > pool) {
      throw new Error(
        `fixed payouts need ${fmtPRL(fixed * BigInt(eligible.length))} PRL for ${eligible.length} holders ` +
        `but the pool is ${fmtPRL(pool)} PRL — raise the pool or lower the fixed amount`
      );
    }
    for (const h of eligible) raw.set(h.address, fixed);
  }

  const paid = [];
  let dustCount = 0, dustGrains = 0n;
  for (const h of eligible) {
    const share = raw.get(h.address);
    if (share < dustFloor) { dustCount++; dustGrains += share; continue; }
    paid.push({ address: h.address, units: h.units, shareGrains: share });
  }
  if (paid.length === 0) {
    throw new Error(
      `every share is below the dust floor of ${fmtPRL(dustFloor)} PRL ` +
      `(${dustCount} holders) — raise the pool or lower the floor`
    );
  }
  const paidSum = paid.reduce((a, p) => a + p.shareGrains, 0n);
  const remainderGrains = pool - paidSum; // >= 0 by floored math (+ fixed-rule check)
  return {
    eligible, paid,
    droppedDust: { count: dustCount, grains: dustGrains },
    excludedCount, belowMinCount,
    totalEligibleUnits,
    remainderGrains,
    rule, poolGrains: pool, dustFloorGrains: dustFloor, minBalanceUnits: minBal,
  };
}

/* ---------------- dividend plan ---------------- */

/** Chunk paid recipients into <= maxOutputsPerTx groups and seal the full
 *  dividend plan in a tamper-evident `pearl-div:v1` descriptor.
 *  treasuryAddress: optional prl1/tprl1 address receiving the remainder as an
 *  explicit output in the last chunk (must be >= dust; otherwise the remainder
 *  returns to the funder as change — disclosed). Without a treasury, the
 *  remainder returns to the funder: as an explicit change output when >= dust,
 *  else folded into the last chunk's change (disclosed).
 *  Returns { descriptor, fingerprint, chunks, shares }. */
export function planDividend({
  network = NETWORKS.mainnet,
  snapshot,            // { descriptor, fingerprint } sealed snapshot
  snapshotFingerprint, // 64-bit fp of the snapshot (cross-checked)
  poolPRL,             // human PRL string, parsed to grains
  rule = "proportional",
  fixedPRL = "0",
  dustFloorPRL = null, // default DUST_GRAIN
  exclusions = [],
  minBalance = "0",    // human token units
  feeRate = 1,         // grains/vB (estimate; exact at sign time)
  maxOutputsPerTx = DIV_MAX_OUTPUTS,
  treasuryAddress = null,
  note = "",
}) {
  if (!snapshot || !snapshot.descriptor) throw new Error("seal a holder snapshot first");
  const fp = snapshotContentFingerprint(snapshot.descriptor);
  if (fp !== snapshotFingerprint) {
    throw new Error(`SNAPSHOT FINGERPRINT MISMATCH — stored ${snapshotFingerprint}, recomputed ${fp}. The snapshot changed; re-seal it.`);
  }
  const pool = BigInt(String(parsePRL(String(poolPRL))) );
  const dustFloor = dustFloorPRL == null ? BigInt(DUST_GRAIN) : BigInt(String(parsePRL(String(dustFloorPRL))));
  const fixed = BigInt(String(parsePRL(String(fixedPRL || "0"))));
  const minBal = parseTokenUnits(String(minBalance || "0"), snapshot.descriptor.decimals);
  const rate = Number(feeRate);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("fee rate must be a positive number of grains/vB");

  const shares = deriveShares({
    snapshot,
    poolGrains: pool,
    rule,
    fixedGrains: fixed,
    dustFloorGrains: dustFloor,
    exclusions,
    minBalanceUnits: minBal,
  });

  let treasury = null;
  if (treasuryAddress) {
    treasury = validateHolderAddress(treasuryAddress, network);
  }
  const R = shares.remainderGrains;
  // Remainder disposition: explicit output when >= dust, else funder change.
  const remainderTo = treasury && R >= BigInt(DUST_GRAIN) ? treasury
    : R >= BigInt(DUST_GRAIN) ? "funder-change-output" : "funder-change-folded";

  const perTx = Math.max(1, Math.min(DIV_MAX_OUTPUTS, Math.floor(Number(maxOutputsPerTx)) || DIV_MAX_OUTPUTS));
  const chunks = [];
  for (let i = 0; i < shares.paid.length; i += perTx) {
    const recips = shares.paid.slice(i, i + perTx);
    const last = i + perTx >= shares.paid.length;
    const outs = recips.map((r) => ({ address: r.address, shareGrains: r.shareGrains.toString() }));
    let extraOut = 0;
    if (last && treasury && R >= BigInt(DUST_GRAIN)) {
      outs.push({ address: treasury, shareGrains: R.toString(), treasury: true });
      extraOut = 1;
    } else if (last && R >= BigInt(DUST_GRAIN)) {
      outs.push({ address: null, shareGrains: R.toString(), remainder: true }); // funder change output, address filled at fund time
      extraOut = 1;
    }
    const outputsGrains = outs.reduce((a, o) => a + BigInt(o.shareGrains), 0n);
    const estFee = BigInt(Math.ceil(keypathTxVBytes(1, outs.length + 1) * rate));
    chunks.push({
      index: chunks.length,
      recipients: outs,
      recipientCount: outs.length,
      outputsGrains: outputsGrains.toString(),
      estFeeGrains: estFee.toString(),
      last,
    });
  }

  const recipientsGrains = shares.paid.reduce((a, p) => a + p.shareGrains, 0n);
  const estFeesGrains = chunks.reduce((a, c) => a + BigInt(c.estFeeGrains), 0n);
  const d = {
    kind: DIV_DESCRIPTOR_KIND,
    network: network.id,
    tick: snapshot.descriptor.tick,
    decimals: snapshot.descriptor.decimals,
    snapshotFingerprint: fp,
    rule,
    fixedGrains: rule === "fixed" ? fixed.toString() : null,
    poolGrains: pool.toString(),
    dustFloorGrains: dustFloor.toString(),
    minBalanceUnits: minBal.toString(),
    exclusions: [...new Set(exclusions.map((a) => String(a).trim().toLowerCase()))].sort(),
    feeRate: rate,
    maxOutputsPerTx: perTx,
    holderCount: snapshot.descriptor.holderCount,
    eligibleCount: shares.eligible.length,
    paidCount: shares.paid.length,
    dustDropped: { count: shares.droppedDust.count, grains: shares.droppedDust.grains.toString() },
    recipients: shares.paid.map((p) => ({
      address: p.address,
      units: p.units.toString(),
      shareGrains: p.shareGrains.toString(),
    })),
    chunks: chunks.map((c) => ({
      index: c.index,
      recipientCount: c.recipientCount,
      outputsGrains: c.outputsGrains,
      estFeeGrains: c.estFeeGrains,
      last: c.last,
      // full recipient list (address null = funder remainder output, resolved at fund time)
      recipients: c.recipients.map((r) => ({
        address: r.address,
        shareGrains: r.shareGrains,
        ...(r.treasury ? { treasury: true } : {}),
        ...(r.remainder ? { remainder: true } : {}),
      })),
    })),
    remainderGrains: R.toString(),
    remainderTo,
    totals: {
      recipientsGrains: recipientsGrains.toString(),
      estFeesGrains: estFeesGrains.toString(),
    },
    note: String(note || "").slice(0, 280),
    createdAt: new Date().toISOString(),
  };
  const fingerprint = descriptorFingerprint(d);
  return { descriptor: d, fingerprint, chunks, shares };
}

/* ---------------- funding ---------------- */

/** Assign UTXOs to each chunk (greedy, largest-first per chunk) and run the
 *  audited planDispatch per chunk. The last chunk's coin-selection target
 *  includes the remainder so it returns to the funder as change (or as the
 *  explicit remainder output the plan already placed).
 *  Returns { fundedChunks: [{ index, plan, recipients }], descriptor,
 *  fingerprint, funderAddress, feeRate }. */
export function fundDividend({ network = NETWORKS.mainnet, plan, utxos, funderAddress, feeRate = null }) {
  const { descriptor, fingerprint, chunks } = plan;
  if (!descriptor || descriptor.kind !== DIV_DESCRIPTOR_KIND) throw new Error("not a pearl-div:v1 plan");
  if (descriptorFingerprint(descriptor) !== fingerprint) {
    throw new Error(`DIVIDEND FINGERPRINT MISMATCH — stored ${fingerprint}, recomputed ${descriptorFingerprint(descriptor)}. The plan changed; re-plan.`);
  }
  const funder = validateHolderAddress(funderAddress, network);
  const funderDec = decodeBech32m(funder, network.hrp);
  const rate = feeRate == null ? descriptor.feeRate : Number(feeRate);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("fee rate must be positive");
  if (!Array.isArray(utxos) || utxos.length === 0) throw new Error("no UTXOs — fetch the funder's UTXOs or paste them first");

  const pool = [...utxos].sort((a, b) => Number(BigInt(b.value) - BigInt(a.value)));
  const fundedChunks = [];
  for (const c of chunks) {
    const recips = c.recipients.map((r) => {
      const address = r.remainder ? funder : r.address;
      const dec = decodeBech32m(address, network.hrp);
      return { address, program: dec.program, amount: BigInt(r.shareGrains), treasury: !!r.treasury, remainder: !!r.remainder };
    });
    const sumOut = recips.reduce((a, r) => a + r.amount, 0n);
    const nOut = recips.length;
    let sel;
    try {
      sel = autoSelectUtxos(pool, sumOut, rate, nOut);
    } catch (e) {
      throw new Error(`chunk #${c.index + 1}: ${e.message}`);
    }
    for (const u of sel.selected) {
      const i = pool.findIndex((p) => p.txid === u.txid && p.vout === u.vout);
      if (i >= 0) pool.splice(i, 1);
    }
    const dispatch = planDispatch({
      utxos: sel.selected, recipients: recips, senderProgram: funderDec.program,
      feeRateGrainsPerVByte: rate, network,
    });
    // planDispatch does not carry custom recipient flags — re-attach them so
    // bundles and the verifier can tell treasury/remainder outputs apart.
    const flagByKey = new Map(recips.map((r) => [`${r.address.toLowerCase()}:${r.amount}`, r]));
    for (const o of dispatch.outputs) {
      if (o.change) continue;
      const f = flagByKey.get(`${String(o.address).toLowerCase()}:${BigInt(o.value)}`);
      if (f) { o.treasury = !!f.treasury; o.remainder = !!f.remainder; }
    }
    fundedChunks.push({ index: c.index, plan: dispatch, recipients: recips, last: c.last });
  }
  return { fundedChunks, descriptor, fingerprint, funderAddress: funder, feeRate: rate, network };
}

/* ---------------- chunk unsigned bundles ---------------- */

/** Export one funded chunk as a tamper-evident unsigned bundle for air-gapped
 *  signing. Mirrors the batch bundle discipline: fingerprint + unsigned wire +
 *  digest/fee/vBytes cross-checks. */
export function exportChunkBundle({ network = NETWORKS.mainnet, funded, chunkIndex }) {
  const fc = funded.fundedChunks[chunkIndex];
  if (!fc) throw new Error(`no funded chunk #${chunkIndex}`);
  const { descriptor, fingerprint, funderAddress, feeRate } = funded;
  const unsigned = buildUnsignedTx(
    network,
    fc.plan.inputs.map((u) => ({ txid: String(u.txid).toLowerCase(), vout: u.vout })),
    fc.plan.outputs.map((o) => ({ program: o.program, value: o.value }))
  );
  const planJson = {
    inputs: fc.plan.inputs.map((u) => ({
      txid: String(u.txid).toLowerCase(), vout: u.vout,
      valueGrains: BigInt(u.value).toString(), confirmations: u.confirmations ?? 0,
    })),
    outputs: fc.plan.outputs.map((o) => ({
      address: o.address, valueGrains: BigInt(o.value).toString(),
      change: !!o.change, treasury: !!o.treasury, remainder: !!o.remainder,
    })),
    totals: {
      inputsGrains: fc.plan.total.toString(),
      recipientsGrains: fc.plan.sumOut.toString(),
      feeGrains: fc.plan.fee.toString(),
      changeGrains: fc.plan.change.toString(),
      vBytes: fc.plan.vBytes,
    },
  };
  return {
    bundle: DIV_BUNDLE_KIND,
    fingerprint,
    chunkIndex,
    descriptor,
    plan: planJson,
    funderAddress,
    feeRate,
    unsignedHex: unsigned.hex,
    unsignedTxid: unsigned.txid,
    wireDigest: bytesToHex(sha256(utf8(unsigned.hex))),
    feeGrains: fc.plan.fee.toString(),
    vBytes: fc.plan.vBytes,
  };
}

/** Import + fully re-verify a chunk bundle. Rebuilds the wire from the plan
 *  alone and cross-checks fingerprint, txid, digest, fee, vBytes. Throws
 *  loudly naming the exact mismatched field. Returns the signing-ready
 *  { network, funderAddress, plan, descriptor, fingerprint, feeRate }. */
export function importChunkBundle(bundle) {
  const b = typeof bundle === "string" ? JSON.parse(bundle) : bundle;
  if (!b || b.bundle !== DIV_BUNDLE_KIND) throw new Error("not a Pearl Dividend unsigned bundle — wrong 'bundle' kind tag");
  const d = b.descriptor;
  if (!d || d.kind !== DIV_DESCRIPTOR_KIND) throw new Error("bundle descriptor has a bad kind tag");
  const network = NETWORKS[d.network];
  if (!network) throw new Error(`unknown network "${d.network}" in bundle descriptor`);
  const wantFp = descriptorFingerprint(d);
  if (wantFp !== b.fingerprint) {
    throw new Error(
      `BUNDLE FINGERPRINT MISMATCH — the descriptor was tampered with (or corrupted): ` +
      `stored ${b.fingerprint}, recomputed ${wantFp}. Refusing to sign.`
    );
  }
  const p = b.plan;
  if (!p || !Array.isArray(p.inputs) || !Array.isArray(p.outputs)) throw new Error("bundle plan is malformed");
  const inputs = p.inputs.map((u) => {
    if (!isHex64(String(u.txid || ""))) throw new Error("bundle input has a bad txid");
    return { txid: String(u.txid).toLowerCase(), vout: u.vout, value: Number(BigInt(u.valueGrains)), confirmations: u.confirmations ?? 0 };
  });
  const funderDec = decodeBech32m(b.funderAddress, network.hrp);
  const recipients = p.outputs
    .filter((o) => !o.change)
    .map((o) => {
      const address = o.remainder ? b.funderAddress : canonicalAddress(o.address, network);
      const dec = decodeBech32m(address, network.hrp);
      const amount = BigInt(o.valueGrains);
      if (amount < BigInt(DUST_GRAIN)) throw new Error(`bundle output to ${address.slice(0, 18)}… is below dust — refusing`);
      return { address, program: dec.program, amount, treasury: !!o.treasury, remainder: !!o.remainder };
    });
  if (recipients.length === 0) throw new Error("bundle has no recipient outputs");
  if (recipients.length > DIV_MAX_OUTPUTS + 1) throw new Error("bundle exceeds the per-chunk recipient cap");
  const plan = planDispatch({
    utxos: inputs, recipients, senderProgram: funderDec.program,
    feeRateGrainsPerVByte: b.feeRate, network,
  });
  const unsigned = buildUnsignedTx(
    network,
    inputs.map((u) => ({ txid: u.txid, vout: u.vout })),
    plan.outputs.map((o) => ({ program: o.program, value: o.value }))
  );
  if (unsigned.txid !== b.unsignedTxid) {
    throw new Error(`BUNDLE DIGEST MISMATCH — rebuilt unsigned txid ${unsigned.txid} != stored ${b.unsignedTxid}. Refusing to sign.`);
  }
  if (b.unsignedHex !== unsigned.hex) {
    throw new Error("BUNDLE WIRE MISMATCH — stored unsigned hex does not match the wire rebuilt from the plan. Refusing to sign.");
  }
  if (bytesToHex(sha256(utf8(unsigned.hex))) !== b.wireDigest) {
    throw new Error("BUNDLE WIRE DIGEST MISMATCH — the unsigned hex was altered. Refusing to sign.");
  }
  if (plan.fee.toString() !== String(b.feeGrains)) {
    throw new Error(`BUNDLE FEE MISMATCH — recomputed ${plan.fee} grains != stored ${b.feeGrains}. Refusing to sign.`);
  }
  if (plan.vBytes !== b.vBytes) {
    throw new Error(`BUNDLE SIZE MISMATCH — recomputed ${plan.vBytes} vB != stored ${b.vBytes} vB. Refusing to sign.`);
  }
  return { network, funderAddress: b.funderAddress, plan, descriptor: d, fingerprint: b.fingerprint, feeRate: b.feeRate, chunkIndex: b.chunkIndex };
}

/** Sign one imported chunk with the funder's secret. The secret is parsed
 *  with the AUDITED batch secret parser (mnemonic / WIF / hex / xprv),
 *  the address-match guard runs first, and every signature is re-verified
 *  locally before the hex is returned. Returns { txid, hex, chunkIndex }. */
export function signChunk({ network = NETWORKS.mainnet, imported, secretText }) {
  const secret = parseBatchSecret(secretText, network); // audited lineage, no new crypto
  assertKeyControlsAddress(secret, imported.funderAddress);
  const { txid, hex } = buildBatchTx({
    secret, senderAddress: imported.funderAddress,
    utxos: imported.plan.inputs, plan: imported.plan, network,
  });
  // buildBatchTx re-verified every signature locally (throws on any failure).
  return {
    txid, hex, chunkIndex: imported.chunkIndex,
    fee: imported.plan.fee, inputCount: imported.plan.inputs.length,
    verifiedCount: imported.plan.inputs.length,
  };
}

/* ---------------- indexer (GET-only, injectable fetch) ---------------- */

async function getJson(fetchImpl, url) {
  let res;
  try { res = await fetchImpl(url, { headers: { Accept: "application/json" } }); }
  catch (e) { return { ok: false, error: "NETWORK: " + (e && e.message ? e.message : e) }; }
  if (!res.ok) return { ok: false, error: `HTTP_${res.status}` };
  try { return { ok: true, data: await res.json() }; }
  catch { return { ok: false, error: "BAD_JSON" }; }
}

/** GET {base}/tokens/{tick} — token metadata from a Pearlscriptions indexer. */
export async function fetchTokenMeta(fetchImpl, base, tick) {
  const t = String(tick || "").toLowerCase().trim();
  if (!t) throw new Error("ticker required");
  const b = String(base || "").replace(/\/+$/, "");
  if (!b) throw new Error("indexer base URL required");
  return getJson(fetchImpl, `${b}/tokens/${encodeURIComponent(t)}`);
}

/** GET {base}/indexer/status — pin the indexer height alongside the snapshot. */
export async function fetchIndexerStatus(fetchImpl, base) {
  const b = String(base || "").replace(/\/+$/, "");
  if (!b) throw new Error("indexer base URL required");
  return getJson(fetchImpl, `${b}/indexer/status`);
}

/** GET {base}/api/v2/tx/{txid} — fetch a payout tx for the verifier. */
export async function fetchPayoutTx(fetchImpl, blockbookBase, txid) {
  const b = String(blockbookBase || "").replace(/\/+$/, "");
  if (!b) throw new Error("blockbook base URL required");
  if (!isHex64(String(txid || ""))) throw new Error("bad txid");
  return getJson(fetchImpl, `${b}/api/v2/tx/${String(txid).toLowerCase()}`);
}

/** Map a raw indexer /tokens/{tick} body into the desk's token record.
 *  Indexer response shapes vary, so every field is picked defensively from
 *  common aliases and falls back to null ("unknown") rather than guessing.
 *  Supply figures are parsed as human token units with the record's decimals.
 *  Never throws on weird input — unknown stays unknown. */
export function normalizeTokenMeta(raw, { tick = "", indexerBase = null, indexerStatus = null, manualMeta = false } = {}) {
  const o = raw && typeof raw === "object" ? raw : {};
  const pick = (...keys) => {
    for (const k of keys) {
      const v = o[k];
      if (v != null && v !== "") return v;
    }
    return null;
  };
  const decRaw = pick("decimals", "dec", "decimal", "divisibility");
  const dec = Math.max(0, Math.min(18, decRaw == null ? 8 : (parseInt(decRaw, 10) || 0)));
  const unitsOf = (v) => {
    if (v == null || v === "") return null;
    try { return parseTokenUnits(String(v).trim(), dec); }
    catch { return null; }
  };
  const holderRaw = pick("holders", "holderCount", "holder_count", "addressCount");
  const holderCount = holderRaw == null ? null : Number(holderRaw);
  return {
    tick: String(pick("tick", "ticker", "symbol") ?? tick ?? "").toLowerCase().trim(),
    decimals: dec,
    maxSupplyUnits: unitsOf(pick("maxSupply", "max_supply", "max", "limit")),
    mintedUnits: unitsOf(pick("minted", "mintedSupply", "minted_supply", "totalMinted", "total_minted")),
    holderCount: Number.isFinite(holderCount) ? holderCount : null,
    indexerBase: indexerBase || null,
    indexerStatus: indexerStatus || null,
    manualMeta: !!manualMeta,
  };
}

/** Stable fingerprint of a normalized token record. Binds tick, decimals,
 *  supply figures and holder count — NOT the indexer height/status, which
 *  moves every block and would make every drift re-check scream. */
export function tokenMetaFingerprint(meta) {
  return descriptorFingerprint({
    kind: "pearl-div-token-meta:v1",
    tick: meta.tick,
    decimals: meta.decimals,
    maxSupplyUnits: meta.maxSupplyUnits == null ? null : BigInt(meta.maxSupplyUnits).toString(),
    mintedUnits: meta.mintedUnits == null ? null : BigInt(meta.mintedUnits).toString(),
    holderCount: meta.holderCount,
    manualMeta: !!meta.manualMeta,
  });
}

/* ---------------- standalone verifier ---------------- */

/** Verify a dividend end-to-end WITHOUT any secret:
 *    1. re-parse the snapshot CSV, re-seal it, compare snapshot fingerprints;
 *    2. re-derive every share from the dividend descriptor's rule and compare
 *       every recipient + share exactly;
 *    3. audit each payout tx (Blockbook /api/v2/tx/:txid JSON) — every planned
 *       recipient must be paid EXACTLY, and every non-recipient output must go
 *       to the funder or the treasury.
 *  payouts: [{ chunkIndex, txid, txJson }]. txJson may be omitted to skip the
 *  on-chain leg (reported, not failed).
 *  Returns { verdict: "PROVEN"|"NOT PROVEN", checks: [...] }. */
export function verifyDividend({ network = NETWORKS.mainnet, snapshotCsvText, dividendBundle, payouts = [] }) {
  const checks = [];
  const fail = (name, detail) => checks.push({ name, ok: false, detail });
  const pass = (name, detail) => checks.push({ name, ok: true, detail });

  const b = typeof dividendBundle === "string" ? JSON.parse(dividendBundle) : dividendBundle;
  const d = b.descriptor || b;
  if (!d || d.kind !== DIV_DESCRIPTOR_KIND) {
    fail("descriptor", "not a pearl-div:v1 dividend descriptor");
    return { verdict: "NOT PROVEN", checks };
  }
  const fp = descriptorFingerprint(d);
  if (b.fingerprint && b.fingerprint !== fp) fail("descriptor fingerprint", `stored ${b.fingerprint} != recomputed ${fp}`);
  else pass("descriptor fingerprint", `${fp.slice(0, 16)}… intact`);

  // 1. snapshot re-seal
  let resealed = null;
  try {
    const parsed = parseSnapshotCsv(snapshotCsvText, { network, decimals: d.decimals });
    if (parsed.duplicates.length || parsed.errors.length) {
      fail("snapshot parse", `${parsed.errors.length} bad lines, ${parsed.duplicates.length} duplicates — clean the CSV first`);
    } else {
      resealed = buildSnapshotDescriptor({
        network, tick: d.tick, decimals: d.decimals,
        holders: mergeDuplicateHolders(parsed.holders),
        maxSupplyUnits: null, memo: "",
      });
      if (resealed.fingerprint !== d.snapshotFingerprint) {
        fail("snapshot binding", `re-sealed snapshot fp ${resealed.fingerprint.slice(0, 16)}… != descriptor's ${String(d.snapshotFingerprint).slice(0, 16)}… — wrong CSV or tampered descriptor`);
      } else pass("snapshot binding", `${resealed.descriptor.holderCount} holders re-sealed to the same fingerprint`);
    }
  } catch (e) {
    fail("snapshot parse", e.message);
  }

  // 2. share re-derivation
  if (resealed) {
    try {
      const re = deriveShares({
        snapshot: resealed,
        poolGrains: BigInt(d.poolGrains),
        rule: d.rule,
        fixedGrains: BigInt(d.fixedGrains || "0"),
        dustFloorGrains: BigInt(d.dustFloorGrains),
        exclusions: d.exclusions || [],
        minBalanceUnits: BigInt(d.minBalanceUnits || "0"),
      });
      const want = new Map(d.recipients.map((r) => [r.address.toLowerCase(), BigInt(r.shareGrains)]));
      let mism = 0;
      for (const p of re.paid) {
        if (want.get(p.address.toLowerCase()) !== p.shareGrains) mism++;
        want.delete(p.address.toLowerCase());
      }
      mism += want.size;
      if (re.remainderGrains.toString() !== String(d.remainderGrains)) {
        fail("remainder", `recomputed ${re.remainderGrains} != descriptor ${d.remainderGrains}`);
      } else if (mism > 0) {
        fail("share math", `${mism} recipient/share mismatches vs the descriptor`);
      } else {
        pass("share math", `${re.paid.length} shares recomputed exactly; remainder ${fmtPRL(re.remainderGrains)} PRL; dust-dropped ${re.droppedDust.count}`);
      }
    } catch (e) {
      fail("share math", e.message);
    }
  }

  // 3. payout audits
  const funder = String(b.funderAddress || "").trim();
  const funderLower = funder.toLowerCase();
  for (const p of payouts) {
    const tag = `payout chunk #${Number(p.chunkIndex) + 1}`;
    const cc = d.chunks[Number(p.chunkIndex)];
    if (!cc) { fail(tag, `no chunk #${p.chunkIndex} in the dividend descriptor`); continue; }
    if (!p.txJson) { checks.push({ name: tag, ok: true, detail: "no tx JSON supplied — on-chain leg skipped" }); continue; }
    if (!funder) { checks.push({ name: tag, ok: true, detail: "funder address not supplied — on-chain leg skipped" }); continue; }
    const recips = cc.recipients.map((r) => ({
      address: r.remainder ? funder : r.address,
      amount: BigInt(r.shareGrains),
    }));
    if (recips.some((r) => !r.address)) { fail(tag, "descriptor chunk has an unresolvable recipient"); continue; }
    // Allowed output addresses: planned recipients + funder (change). Anything
    // else is unexpected — computed here because auditBatchTx only checks that
    // planned recipients were paid, not that nothing extra was paid.
    const allowed = new Set(recips.map((r) => String(r.address).toLowerCase()));
    allowed.add(funderLower);
    let audit;
    try {
      audit = auditBatchTx(p.txJson, { txid: p.txid, senderAddress: funder, recipients: recips }, network);
    } catch (e) {
      fail(tag, "audit crashed: " + e.message);
      continue;
    }
    const unexpected = new Set();
    for (const o of (p.txJson.vout || [])) {
      for (const a of (o.addresses || [])) {
        if (!allowed.has(String(a).toLowerCase())) unexpected.add(String(a));
      }
    }
    if (audit.missingRecipients.length === 0 && unexpected.size === 0 && audit.ok) {
      pass(tag, `${recips.length} outputs paid exactly; ${audit.confirmations ?? 0} confirmations; fee ${audit.feePRL} PRL`);
    } else {
      const bits = [];
      if (audit.missingRecipients.length) {
        bits.push("missing/underpaid: " + audit.missingRecipients.map((m) => String(m.address).slice(0, 14) + "\u2026").join(", "));
      }
      if (unexpected.size) bits.push("unexpected outputs to " + [...unexpected].slice(0, 3).join(", "));
      if (audit.notes.length) bits.push(audit.notes.slice(0, 2).join("; "));
      fail(tag, bits.join(" \u2014 ") || "audit failed");
    }
  }

  const bad = checks.filter((c) => !c.ok);
  return { verdict: bad.length ? "NOT PROVEN" : "PROVEN", checks };
}
