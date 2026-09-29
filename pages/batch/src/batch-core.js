// Pearl Batch core: non-custodial PRL batch-payments studio ("the freight
// terminal"). One keypath-Schnorr transaction pays N recipients + change back
// to the sender. Five-stage workflow: Manifest -> Freight -> Review ->
// Sign -> Broadcast, with unsigned-bundle export/import (tamper-evident,
// 64-bit fingerprint, digest/fee cross-checks) for air-gapped signing rounds.
//
// Crypto policy: every cryptographic operation reuses the audited Pearl Sign
// lineage (../../sign/src/crypto.js + sign-core.js) or the vendored
// @scure/bip32 already used by that lineage (xprv import only). NO new
// cryptography is introduced here: bech32m validation, BIP-86 derivation,
// TapTweak, BIP-341 keypath sighash, Schnorr signing, and per-signature
// re-verification all come from the Sign core. The only new code is wire
// serialization (same helpers sign-core itself uses) and bookkeeping.
//
// Protocol facts (do not re-derive): bech32m prl1.../tprl1... Taproot-only
// addresses; NO smart contracts on Pearl; 1 PRL = 1e8 grains; P2TR vB math
// via keypathTxVBytes (58 vB/input + 43 vB/output + witness discount, as in
// Pearl Sweep); dust floor 546 grains; fee math grain-exact BigInt.
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

/** Maximum recipients per batch transaction (relay standardness headroom). */
export const BATCH_MAX_OUTPUTS = 250;
/** Hard vB ceiling for a single dispatch (Bitcoin-like standardness margin). */
export const BATCH_MAX_VBYTES = 99000;
/** BIP-86 account the sender's mnemonic is derived under (m/86'/coin'/0'/0/0). */
export const BATCH_ACCOUNT = 0;
/** Tamper-evident descriptor / bundle kind prefixes. */
export const BATCH_DESCRIPTOR_KIND = "pearlbatch:v1:";
export const BATCH_BUNDLE_KIND = "pearl-batch-unsigned:v1:";
export const MAX_MEMO_LEN = 140;

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
 *  Uses ONLY the audited Sign lineage (walletFrom* / scure-bip32 HDKey,
 *  already vendored and used by the audited mnemonic path).
 *  Returns { kind, mnemonic|null, privHex, internalXOnlyHex, address, program, network }. */
export function parseBatchSecret(text, network = NETWORKS.mainnet) {
  const t = String(text ?? "").trim();
  if (!t) throw new Error("paste the sender secret — a 12/24-word mnemonic, a WIF key, a 64-hex private key, or an xprv/tprv");
  const words = t.split(/\s+/);
  let w, mnemonic = null, kind;
  if (words.length === 12 || words.length === 24) {
    kind = "mnemonic";
    try { w = walletFromMnemonic(words.join(" "), network, BATCH_ACCOUNT, 0); }
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
    const child = root.derive(`m/86'/${network.coinType}'/${BATCH_ACCOUNT}'/0/0`);
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
      `but the dispatch spends from ${senderAddress}. Signing with this key would fail or ` +
      `spend someone else's coins; fix the address or use the correct key.`
    );
  }
}

/* ---------------- recipient manifest ---------------- */

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

/** Parse one manifest line. Formats accepted:
 *    address, amount[, memo]      — amount in PRL (decimals ok)
 *    address amount [grains] [memo...]
 *  A bare `grains` token switches the amount to grains; remaining tokens are
 *  the memo (off-chain label, never on-chain). Lines starting with # ignored
 *  upstream. Returns { address, program, amount (BigInt), memo|null }. */
function parseManifestLine(line, lineNo, network) {
  const comma = line.includes(",");
  const parts = comma ? line.split(",").map((p) => p.trim()).filter((p) => p !== "")
                      : line.split(/\s+/).filter(Boolean);
  if (parts.length < 2) throw new Error(`line ${lineNo}: need "<address>, <amount>", got: ${line.slice(0, 60)}`);
  const [addrS, amountField, ...tail] = parts;
  const address = canonicalAddress(addrS, network);
  const dec = decodeBech32m(addrS, network.hrp);
  // The amount field may itself carry the unit ("0.5 grains" in comma form).
  const fieldToks = amountField.split(/\s+/).filter(Boolean);
  const amountS = fieldToks[0];
  const rest = [...fieldToks.slice(1), ...tail];
  let unit = "prl";
  const memoTokens = [];
  for (const tok of rest) {
    if (/^grains?$/i.test(tok)) unit = "grains";
    else if (/^prl$/i.test(tok)) unit = "prl";
    else memoTokens.push(tok);
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
      `raise it or drop the line. Dust outputs are refused, never rounded up.`
    );
  }
  const memo = memoTokens.join(comma ? ", " : " ").trim();
  if (memo.length > MAX_MEMO_LEN) throw new Error(`line ${lineNo}: memo longer than ${MAX_MEMO_LEN} chars (memos are off-chain labels)`);
  return { address, program: dec.program, amount, memo: memo || null };
}

/** Parse a recipient manifest (paste or CSV import).
 *  Returns { recipients: [{address, program, amount, memo}], merged: number,
 *  total: BigInt } — duplicate addresses merge into one output (amounts
 *  summed; memos joined with "; "). Loud refusal on dust, bad addresses,
 *  or >250 unique recipients. */
export function parseRecipients(text, network = NETWORKS.mainnet, opts = {}) {
  const mergeDuplicates = opts.mergeDuplicates !== false; // default: merge, preserving historic behavior
  const t = String(text ?? "");
  const lines = t.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  if (lines.length === 0) throw new Error("no recipients — paste one \"<address>, <amount>\" per line, or import a CSV");
  if (lines.length > BATCH_MAX_OUTPUTS * 4) throw new Error(`too many lines (max ${BATCH_MAX_OUTPUTS} recipients — duplicates merge down)`);
  const parsed = lines.map((l, i) => parseManifestLine(l, i + 1, network));
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
      if (r.memo) e.memo = e.memo ? e.memo + "; " + r.memo : r.memo;
      merged++;
    } else {
      byAddr.set(r.address, { address: r.address, program: r.program, amount: r.amount, memo: r.memo });
    }
  }
  const recipients = [...byAddr.values()];
  if (recipients.length > BATCH_MAX_OUTPUTS) {
    throw new Error(`too many unique recipients (${recipients.length}) — max ${BATCH_MAX_OUTPUTS} per dispatch; split the batch`);
  }
  const total = recipients.reduce((a, r) => a + r.amount, 0n);
  return { recipients, merged, total };
}

/** Downloadable sample manifest. */
export function sampleManifest() {
  return [
    "# Pearl Batch sample manifest — one recipient per line",
    "# <address>, <amount>[, memo] · amount in PRL (decimals ok), or \"N grains\"",
    "# commas or whitespace both work · # lines ignored · duplicates merge",
    "# memos are OFF-CHAIN labels only — they never appear on-chain",
    "prl1pr6yuq8u2r95wjzzgpdy8cpnncpl7l8zgy6x5q0367pnc53s2famqg7pt74, 1.25, Q3 vendor payout",
    "prl1p7dwp74zgd4te3mqr58d6x3p3t70jljmpe4auey8g824ra4x43tks3y4pr6, 546 grains",
    "prl1p5gfau0gepxzjkjyx9t88ewnhujrmpjqgqfh8v9vympjaz94x36jqpepvyt 10 contractor bonus",
  ].join("\n") + "\n";
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
    `insufficient funds: have ${fmtPRL(total)} PRL, need ${fmtPRL(sumOut)} PRL for recipients ` +
    `+ ~${fmtPRL(BigInt(best) * BigInt(rate))} PRL fee. Add inputs or reduce recipients.`
  );
}

/** Plan the dispatch from an EXPLICITLY selected input set (manual control).
 *  Fee = keypathTxVBytes(nIn, nOut[+1]) * rate, grain-exact BigInt.
 *  When the change output would be dust it is dropped and absorbed into the
 *  fee: plan.fee is then the ACTUAL fee (total - sumOut), plan.nominalFee the
 *  vBytes*rate figure, and plan.changeBump = actual - nominal, disclosed.
 *  Returns { total, sumOut, fee, change, changeDropped, outputs, vBytes,
 *  feeRate, nIn, nOut, changeBump, nominalFee } — throws loudly on shortfall.
 *  Invariant: total === sumOut + fee + change, always. */
export function planDispatch({ utxos, recipients, senderProgram, feeRateGrainsPerVByte, network = NETWORKS.mainnet }) {
  assertUtxos(utxos);
  if (!Array.isArray(recipients) || recipients.length === 0) throw new Error("no recipients in the manifest");
  if (recipients.length > BATCH_MAX_OUTPUTS) throw new Error(`too many recipients (max ${BATCH_MAX_OUTPUTS})`);
  if (!(senderProgram instanceof Uint8Array) || senderProgram.length !== 32) throw new Error("bad sender program");
  const rate = Math.ceil(Number(feeRateGrainsPerVByte));
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("fee rate must be a positive number of grains/vB");
  for (const r of recipients) {
    if (r.amount < BigInt(DUST_GRAIN)) throw new Error(`recipient ${r.address.slice(0, 18)}… is below dust — re-validate the manifest`);
    if (!(r.program instanceof Uint8Array) || r.program.length !== 32) throw new Error(`recipient ${r.address.slice(0, 18)}… has a bad program`);
  }
  const total = utxos.reduce((a, u) => a + BigInt(u.value), 0n);
  const sumOut = recipients.reduce((a, r) => a + BigInt(r.amount), 0n);
  const nIn = utxos.length, n = recipients.length;

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
  if (vBytes > BATCH_MAX_VBYTES) {
    throw new Error(`dispatch too large: ${vBytes} vB exceeds the ${BATCH_MAX_VBYTES} vB ceiling — split the batch`);
  }
  const minNeed = sumOut + fee;
  if (total < minNeed) {
    throw new Error(
      `insufficient funds: inputs hold ${fmtPRL(total)} PRL, need ${fmtPRL(minNeed)} PRL ` +
      `(${fmtPRL(sumOut)} to recipients + ${fmtPRL(fee)} fee at ${rate} gr/vB over ${vBytes} vB). ` +
      `Add inputs, drop recipients, or lower the fee rate.`
    );
  }
  const leftover = total - sumOut - fee;
  const outputs = recipients.map((r) => ({
    address: r.address, program: r.program, value: Number(r.amount), memo: r.memo ?? null, change: false,
  }));
  if (!changeDropped) {
    outputs.push({
      address: encodeBech32m(network.hrp, 1, senderProgram),
      program: senderProgram, value: Number(leftover), memo: null, change: true,
    });
  }
  // Actual fee: when dust change is dropped there is no change output, so every
  // grain not paid to recipients is fee by consensus. changeBump discloses how
  // much of the fee is absorbed dust (actualFee - nominal vBytes fee).
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

/** Build the non-witness serialization of the dispatch (inputs/outputs only).
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

/* ---------------- dispatch descriptor + unsigned bundle ---------------- */

/** Build the tamper-evident dispatch descriptor from a settled plan.
 *  Memos are included (off-chain labels); the fingerprint covers everything. */
export function buildDescriptor({ network, senderAddress, recipients, plan, feeRate }) {
  const d = {
    kind: BATCH_DESCRIPTOR_KIND,
    network: network.id,
    senderAddress,
    feeRate,
    recipients: recipients.map((r) => ({
      address: r.address,
      amountGrains: r.amount.toString(),
      memo: r.memo ?? null,
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
      recipientsGrains: plan.sumOut.toString(),
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
export function exportUnsignedBundle({ network, senderAddress, recipients, plan, feeRate }) {
  const { descriptor, fingerprint } = buildDescriptor({ network, senderAddress, recipients, plan, feeRate });
  const unsigned = buildUnsignedTx(
    network,
    plan.inputs.map((u) => ({ txid: String(u.txid).toLowerCase(), vout: u.vout })),
    plan.outputs.map((o) => ({ program: o.program, value: o.value }))
  );
  return {
    bundle: BATCH_BUNDLE_KIND,
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
 *  { network, senderAddress, recipients, plan, feeRate, fingerprint }.
 *  Throws loudly naming the exact mismatched field. */
export function importUnsignedBundle(bundle) {
  const b = typeof bundle === "string" ? JSON.parse(bundle) : bundle;
  if (!b || b.bundle !== BATCH_BUNDLE_KIND) throw new Error("not a Pearl Batch unsigned bundle — wrong 'bundle' kind tag");
  const d = b.descriptor;
  if (!d || d.kind !== BATCH_DESCRIPTOR_KIND) throw new Error("bundle descriptor has a bad kind tag");
  const network = NETWORKS[d.network];
  if (!network) throw new Error(`unknown network "${d.network}" in bundle descriptor`);

  const wantFp = descriptorFingerprint(d);
  if (wantFp !== b.fingerprint) {
    throw new Error(
      `BUNDLE FINGERPRINT MISMATCH — the descriptor was tampered with (or corrupted): ` +
      `stored ${b.fingerprint}, recomputed ${wantFp}. Refusing to sign.`
    );
  }
  // Structural sanity + dust guards on the descriptor itself.
  if (!Array.isArray(d.recipients) || d.recipients.length === 0) throw new Error("bundle descriptor has no recipients");
  if (d.recipients.length > BATCH_MAX_OUTPUTS) throw new Error("bundle descriptor exceeds the recipient cap");
  const recipients = d.recipients.map((r, i) => {
    const address = canonicalAddress(r.address, network);
    const dec = decodeBech32m(r.address, network.hrp);
    const amount = BigInt(r.amountGrains);
    if (amount < BigInt(DUST_GRAIN)) throw new Error(`bundle recipient #${i + 1} is below dust — refusing`);
    const memo = r.memo == null ? null : String(r.memo);
    if (memo && memo.length > MAX_MEMO_LEN) throw new Error(`bundle recipient #${i + 1} memo too long`);
    return { address, program: dec.program, amount, memo };
  });
  const inputs = (d.inputs || []).map((u) => {
    if (!/^[0-9a-f]{64}$/i.test(String(u.txid || ""))) throw new Error("bundle input has a bad txid");
    return { txid: String(u.txid).toLowerCase(), vout: u.vout, value: Number(BigInt(u.valueGrains)), confirmations: u.confirmations ?? 0 };
  });
  const senderDec = decodeBech32m(d.senderAddress, network.hrp);
  const senderProgram = senderDec.program;
  const plan = planDispatch({ utxos: inputs, recipients, senderProgram, feeRateGrainsPerVByte: d.feeRate, network });

  // Digest cross-check: rebuild the unsigned wire and compare.
  const unsigned = buildUnsignedTx(
    network,
    inputs.map((u) => ({ txid: u.txid, vout: u.vout })),
    plan.outputs.map((o) => ({ program: o.program, value: o.value }))
  );
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
  return { network, senderAddress: d.senderAddress, recipients, plan, feeRate: d.feeRate, fingerprint: b.fingerprint };
}

/* ---------------- build + sign + verify ---------------- */

/** Build + Schnorr-sign + locally re-verify the dispatch.
 *  Every input is the sender's keypath spend; each signature is re-verified
 *  with verifySignedTx BEFORE the hex is returned. Returns { txid, hex, plan }.
 *  Throws (and never exposes hex) if any local verification fails. */
export function buildBatchTx({ secret, senderAddress, utxos, plan, network = NETWORKS.mainnet }) {
  assertKeyControlsAddress(secret, senderAddress);
  const w = walletFromPriv(secret.privHex, network);
  const { tweakedX } = tweakKeypath(w.internalXOnly);
  const spk = p2trScriptPubKey(tweakedX);
  const derived = encodeBech32m(network.hrp, 1, tweakedX);
  if (derived.toLowerCase() !== String(senderAddress).toLowerCase()) {
    throw new Error("derived sender address does not match the manifest sender — refusing to sign");
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

/* ---------------- standalone tx audit (post-broadcast / verifier) ---------------- */

/** Pure audit of a Blockbook /api/v2/tx/:txid body against the expected batch.
 *  expected: { txid, senderAddress, recipients: [{address, amount (BigInt)}] }.
 *  Returns { ok, confirmations, blockHeight, fee (BigInt), feePRL, nIn, nOut,
 *  missingRecipients, extraOutputs, notes }. Never throws on weird chain data —
 *  it reports. */
export function auditBatchTx(txJson, expected, network = NETWORKS.mainnet) {
  const notes = [];
  const vin = txJson?.vin ?? [];
  const vout = txJson?.vout ?? [];
  const gotTxid = String(txJson?.txid || "").toLowerCase();
  if (gotTxid !== String(expected.txid).toLowerCase()) {
    notes.push(`txid mismatch: chain returned ${gotTxid.slice(0, 16)}…`);
  }
  const senderLower = String(expected.senderAddress).toLowerCase();
  const vinHasSender = vin.some((i) => (i.addresses || []).some((a) => String(a).toLowerCase() === senderLower));
  if (!vinHasSender) notes.push("no input spends from the sender address");
  let vinSum = 0n;
  for (const i of vin) { try { vinSum += BigInt(i.value ?? 0); } catch { notes.push("unparseable input value"); } }
  let voutSum = 0n;
  const addrTotals = new Map();
  for (const o of vout) {
    try { voutSum += BigInt(o.value ?? 0); } catch { notes.push("unparseable output value"); }
    for (const a of (o.addresses || [])) {
      const k = String(a).toLowerCase();
      addrTotals.set(k, (addrTotals.get(k) ?? 0n) + BigInt(o.value ?? 0));
    }
  }
  const missingRecipients = [];
  for (const r of expected.recipients) {
    const got = addrTotals.get(String(r.address).toLowerCase()) ?? 0n;
    if (got < BigInt(r.amount)) missingRecipients.push({ address: r.address, expected: r.amount.toString(), found: got.toString() });
  }
  const fee = vinSum - voutSum;
  const conf = Number(txJson?.confirmations ?? 0);
  const ok = notes.length === 0 && missingRecipients.length === 0 && fee >= 0n;
  return {
    ok, confirmations: conf, blockHeight: txJson?.blockHeight ?? null,
    fee, feePRL: fmtPRL(fee), nIn: vin.length, nOut: vout.length,
    missingRecipients, notes,
    verdict: ok ? "BATCH VERIFIED — every recipient output is on-chain for the exact amount" : "BATCH NOT VERIFIED — see notes",
  };
}
