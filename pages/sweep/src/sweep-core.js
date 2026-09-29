/* Pearl Sweep core — UTXO consolidation optimizer for Pearl Taproot addresses.
 *
 * Pure ESM. The browser ships a committed esbuild IIFE bundle
 * (pearl-sweep.bundle.js, entry src/index.js re-exporting this file);
 * node runs this file directly for the verification suite.
 *
 * Model: analyze one prl1…/tprl1… address (GET-only Blockbook reads),
 * classify every UTXO (dust <546 grains / uneconomic / healthy), plan a
 * keypath consolidation under a user-set fee rate with loud breakeven
 * refusal, sign locally (WIF or xprv, in-memory only, address-match guard),
 * re-verify every Schnorr signature, track the consolidation txid, and
 * re-scan to prove the UTXO set shrank.
 *
 * Crypto lineage: NO new cryptography. Address validation (bech32m),
 * key handling (walletFromPriv/walletFromWIF), BIP-341 keypath sighash,
 * Schnorr signing and wire serialization all come from the audited Pearl
 * Sign core (../../sign/src/crypto.js + ../../sign/src/sign-core.js —
 * buildKeypathTxEx + verifySignedTx, the same pair Pearl Rain uses for its
 * batch signing). xprv entry only base58check-decodes the extended key and
 * uses its 32-byte secret directly — no new derivation. All value math is
 * grain-exact BigInt; fee rate is fixed-point milliGrains/vB.
 */

import {
  NETWORKS,
  GRAIN_PER_PRL,
  DUST_GRAIN,
  decodeBech32m,
  encodeBech32m,
  walletFromPriv,
  walletFromWIF,
  walletToWIF,
  keypathTxVBytes,
  p2trScriptPubKey,
  tweakKeypath,
  bytesToHex,
  hexToBytes,
} from "../../sign/src/crypto.js";
import {
  buildKeypathTxEx,
  verifySignedTx,
  decodeRawTx,
  describeSpk,
  SIGHASH_DEFAULT,
  fmtPRL,
} from "../../sign/src/sign-core.js";
import { createBase58check } from "@scure/base";
import { sha256 } from "@noble/hashes/sha256";

export {
  NETWORKS, GRAIN_PER_PRL, DUST_GRAIN, walletFromPriv, walletFromWIF, walletToWIF,
  keypathTxVBytes, bytesToHex, hexToBytes, fmtPRL, decodeRawTx, describeSpk,
  verifySignedTx, encodeBech32m,
};

export const DONATE_ADDRESS = "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d";

/* Fee-rate precision: milliGrains per vByte, as BigInt. */
export const FEE_RATE_SCALE = 1000n;

/* vBytes of one P2TR keypath input (audited keypathTxVBytes). */
export const INPUT_VBYTES = keypathTxVBytes(2, 1) - keypathTxVBytes(1, 1); // 58
export const OUTPUT_VBYTES = keypathTxVBytes(1, 2) - keypathTxVBytes(1, 1); // 43
export const SOLO_SPEND_VBYTES = keypathTxVBytes(1, 1); // 111

/* Standardness sanity: warn above this tx size (Pearl ~7KB txs observed). */
export const WARN_VBYTES = 100_000;
export const MAX_INPUTS = 500;
export const MAX_OUTPUTS = 16;

/* ---------------- formatting ---------------- */

export function formatGrains(grains) {
  return fmtPRL(BigInt(grains));
}

/* ---------------- address ---------------- */

/** Validate a Pearl Taproot address string. Returns {network, address, program}
 *  or {error}. The address is lowercased/normalized on success. */
export function parseSweepAddress(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return { error: "Paste a prl1… or tprl1… address first." };
  let dec;
  try {
    dec = decodeBech32m(raw);
  } catch (e) {
    return { error: "Not a valid Pearl Taproot address: " + (e.message || e) };
  }
  const network = Object.values(NETWORKS).find((n) => n.hrp === dec.hrp);
  if (!network) return { error: `Address is for network "${dec.hrp}" — this tool only handles prl1… (mainnet) and tprl1… (testnet).` };
  if (dec.version !== 1) return { error: "Only witness v1 (Taproot) addresses are supported." };
  return { network, address: raw.toLowerCase(), program: dec.program };
}

/* ---------------- fee rate ---------------- */

/** Parse a fee-rate string (grains/vByte, decimals allowed) into
 *  milliGrains/vByte BigInt. Returns {rateMp} or {error}. */
export function parseFeeRate(text) {
  const raw = String(text ?? "").trim();
  if (!/^\d+(\.\d{1,3})?$/.test(raw)) {
    return { error: "Fee rate must be a positive number with at most 3 decimals (grains/vByte)." };
  }
  const [whole, frac = ""] = raw.split(".");
  const rateMp = BigInt(whole) * FEE_RATE_SCALE + BigInt((frac + "000").slice(0, 3));
  if (rateMp <= 0n) return { error: "Fee rate must be greater than zero." };
  if (rateMp > 10_000n * FEE_RATE_SCALE) {
    return { error: `Fee rate ${raw} grains/vByte is absurdly high — refusing to plan at that rate.` };
  }
  return { rateMp };
}

/** Ceiling fee in grains for vBytes at rateMp (milliGrains/vB). */
export function feeForVBytes(vBytes, rateMp) {
  return (BigInt(vBytes) * BigInt(rateMp) + (FEE_RATE_SCALE - 1n)) / FEE_RATE_SCALE;
}

/* ---------------- blockbook (injectable fetcher) ---------------- */

const defaultFetcher = (url, opts) => fetch(url, opts);

async function bbJson(fetcher, url, opts) {
  const res = await fetcher(url, opts);
  if (!res.ok) throw new Error(`blockbook ${res.status} on ${url.replace(/^https?:\/\/[^/]+/, "")}`);
  const text = await res.text();
  try { return JSON.parse(text); } catch { throw new Error("blockbook returned non-JSON"); }
}

/** Fetch UTXOs for an address. Returns [{txid, vout, value: BigInt, confirmations}].
 *  Malformed rows are dropped; non-array responses throw. */
export async function fetchSweepUtxos(fetcher = defaultFetcher, blockbookBase, address) {
  const base = String(blockbookBase).replace(/\/$/, "");
  const list = await bbJson(fetcher, `${base}/api/v2/utxo/${address}`);
  if (!Array.isArray(list)) throw new Error("unexpected UTXO response from Blockbook");
  const out = [];
  for (const u of list) {
    try {
      const txid = String(u.txid || "").toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(txid)) continue;
      const vout = Number(u.vout);
      if (!Number.isInteger(vout) || vout < 0) continue;
      const value = BigInt(u.value);
      if (value <= 0n) continue;
      out.push({ txid, vout, value, confirmations: Number(u.confirmations ?? 0) || 0 });
    } catch { /* drop malformed rows */ }
  }
  return out;
}

/** Blockbook fee estimate (PRL/kB) -> milliGrains/vByte. Throws if unavailable. */
export async function fetchFeeRateMp(fetcher = defaultFetcher, blockbookBase, blocks = 2) {
  const base = String(blockbookBase).replace(/\/$/, "");
  const r = await bbJson(fetcher, `${base}/api/v2/estimatefee/${blocks}`);
  const perKb = Number(r.result ?? r);
  if (!Number.isFinite(perKb) || perKb <= 0) throw new Error("fee estimate unavailable from Blockbook");
  const grainsPerVb = (perKb * Number(GRAIN_PER_PRL)) / 1000;
  const mp = BigInt(Math.round(grainsPerVb * 1000));
  if (mp <= 0n) throw new Error("fee estimate unavailable from Blockbook");
  return mp;
}

/** Fetch a tx by id (for Track + the standalone verifier). */
export async function fetchSweepTx(fetcher = defaultFetcher, blockbookBase, txid) {
  const id = String(txid || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(id)) throw new Error("Not a valid txid (64 hex chars).");
  const base = String(blockbookBase).replace(/\/$/, "");
  return bbJson(fetcher, `${base}/api/v2/tx/${id}`);
}

/** Broadcast a signed raw tx via Blockbook v1 sendtx (text/plain body).
 *  Verified against https://blockbook.pearlresearch.ai by Pearl Sign. */
export async function broadcastSweepTx(fetcher = defaultFetcher, blockbookBase, hex) {
  const base = String(blockbookBase).replace(/\/$/, "");
  const res = await fetcher(`${base}/api/sendtx/`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: hex,
  });
  const text = await res.text();
  let j = {};
  try { j = JSON.parse(text); } catch { /* non-JSON body */ }
  if (!res.ok || j.error) {
    throw new Error("broadcast rejected: " + (j.error || `HTTP ${res.status}: ${text.slice(0, 160)}`));
  }
  const txid = (j.result ?? j.txid ?? "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(txid)) throw new Error("unexpected broadcast response: " + text.slice(0, 160));
  return txid;
}

/* ---------------- classification ---------------- */

export const BUCKETS = [
  { label: "< 546 (dust)", min: 0n, max: 545n },
  { label: "546 – 999", min: 546n, max: 999n },
  { label: "1k – 9,999", min: 1000n, max: 9999n },
  { label: "10k – 99,999", min: 10000n, max: 99999n },
  { label: "100k – 999,999", min: 100000n, max: 999999n },
  { label: "≥ 1M", min: 1000000n, max: null },
];

/** Classify each UTXO at the given fee rate.
 *  dust: value < 546 grains (unspendable as an output — protocol floor).
 *  uneconomic: value < solo-spend cost (spending it alone loses money).
 *  healthy: everything else.
 *  Also flags net-negative inclusions (value < marginal input cost). */
export function classifyUtxos(utxos, rateMp) {
  const dustFloor = BigInt(DUST_GRAIN);
  const soloCost = feeForVBytes(SOLO_SPEND_VBYTES, rateMp);
  const marginalCost = feeForVBytes(INPUT_VBYTES, rateMp);
  return utxos.map((u) => {
    const v = BigInt(u.value);
    const dust = v < dustFloor;
    const uneconomic = !dust && v < soloCost;
    return {
      ...u, value: v, dust, uneconomic,
      healthy: !dust && !uneconomic,
      netNegative: v < marginalCost, // including it costs more than it's worth
    };
  });
}

/** Dashboard summary of classified UTXOs. All values BigInt. */
export function summarizeUtxos(classified) {
  const s = {
    count: classified.length, total: 0n,
    dustCount: 0, dustValue: 0n,
    uneconomicCount: 0, uneconomicValue: 0n,
    healthyCount: 0, healthyValue: 0n,
    buckets: BUCKETS.map((b) => ({ label: b.label, count: 0, value: 0n })),
  };
  for (const u of classified) {
    s.total += u.value;
    if (u.dust) { s.dustCount++; s.dustValue += u.value; }
    else if (u.uneconomic) { s.uneconomicCount++; s.uneconomicValue += u.value; }
    else { s.healthyCount++; s.healthyValue += u.value; }
    const b = BUCKETS.find((bk) => u.value >= bk.min && (bk.max === null || u.value <= bk.max));
    const bi = BUCKETS.indexOf(b);
    s.buckets[bi].count++;
    s.buckets[bi].value += u.value;
  }
  return s;
}

/** Estimated grains saved per future spend after consolidating n UTXOs into 1:
 *  (n-1) marginal inputs × rate. 0 when n < 2. */
export function futureSavingsGrains(nInputs, rateMp) {
  if (nInputs < 2) return 0n;
  return feeForVBytes(INPUT_VBYTES, rateMp) * BigInt(nInputs - 1);
}

/* ---------------- planning ---------------- */

export const STRATEGIES = {
  uneconomic: "Sweep only uneconomic UTXOs (dust + uneconomic)",
  threshold: "Sweep everything under a threshold",
  all: "Consolidate everything into 1–N outputs",
};

/** Plan a consolidation.
 *  opts: { classified, strategy, thresholdGrains (BigInt, for "threshold"),
 *          nOutputs (1..MAX_OUTPUTS), targetProgram (Uint8Array 32),
 *          rateMp (BigInt), network }
 *  Returns {ok, refused, refusal?, inputs, outputs, total, fee, vBytes,
 *           rateMp, netValue, perOutput, feeRemainder, warnings[] }.
 *  Refusal is LOUD: refused=true with the exact math in `refusal`. */
export function planSweep(opts) {
  const { classified, strategy, thresholdGrains = 0n, nOutputs = 1, targetProgram, rateMp, network } = opts;
  const warnings = [];
  if (!STRATEGIES[strategy]) throw new Error("unknown strategy");
  if (!(targetProgram instanceof Uint8Array) || targetProgram.length !== 32) throw new Error("bad target program");
  if (rateMp <= 0n) throw new Error("fee rate must be positive");
  if (!Number.isInteger(nOutputs) || nOutputs < 1 || nOutputs > MAX_OUTPUTS) {
    throw new Error(`output count must be 1–${MAX_OUTPUTS}`);
  }
  if (!Array.isArray(classified) || classified.length === 0) {
    return { ok: false, refused: true, refusal: "No UTXOs to consolidate — analyze an address with a balance first.", warnings };
  }

  let pool = classified;
  if (strategy === "uneconomic") pool = classified.filter((u) => u.dust || u.uneconomic);
  else if (strategy === "threshold") pool = classified.filter((u) => u.value < BigInt(thresholdGrains));
  if (pool.length === 0) {
    return {
      ok: false, refused: true,
      refusal: `Strategy "${STRATEGIES[strategy]}" selected 0 UTXOs — nothing to consolidate. Loosen the strategy or threshold.`,
      warnings,
    };
  }
  if (pool.length > MAX_INPUTS) {
    return {
      ok: false, refused: true,
      refusal: `Selected ${pool.length} inputs exceeds the ${MAX_INPUTS}-input safety cap. Split the sweep into smaller batches (select fewer UTXOs).`,
      warnings,
    };
  }

  const inputs = [...pool].sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
  const total = inputs.reduce((a, u) => a + u.value, 0n);
  const vBytes = keypathTxVBytes(inputs.length, nOutputs);
  const fee = feeForVBytes(vBytes, rateMp);

  // Breakeven guard: consolidation must not destroy the value it recovers.
  if (fee >= total) {
    return {
      ok: false, refused: true, inputs, total, fee, vBytes, rateMp, warnings,
      refusal:
        `REFUSED — the fee eats everything. Fee ${formatGrains(fee)} PRL ` +
        `(${vBytes} vB × ${formatRateMp(rateMp)} grains/vB) ≥ swept value ${formatGrains(total)} PRL. ` +
        `Consolidating now destroys value; wait for a lower fee rate or leave these UTXOs alone.`,
    };
  }

  const netValue = total - fee;
  const perOutput = netValue / BigInt(nOutputs);
  const feeRemainder = netValue % BigInt(nOutputs); // absorbed into the fee, shown honestly
  const dustFloor = BigInt(DUST_GRAIN);
  if (perOutput < dustFloor) {
    return {
      ok: false, refused: true, inputs, total, fee, vBytes, rateMp, warnings,
      refusal:
        `REFUSED — dust output. After the ${formatGrains(fee)} PRL fee, each of the ${nOutputs} ` +
        `outputs would hold ${perOutput} grains — below the ${DUST_GRAIN}-grain dust floor. ` +
        `Use fewer outputs or sweep more value.`,
    };
  }

  const outputs = Array.from({ length: nOutputs }, (_, i) => ({
    index: i,
    program: targetProgram,
    value: perOutput,
  }));

  const netNegative = inputs.filter((u) => u.netNegative);
  if (netNegative.length) {
    warnings.push(
      `${netNegative.length} selected UTXO${netNegative.length > 1 ? "s" : ""} ` +
      `cost${netNegative.length > 1 ? "" : "s"} more to include (${formatGrains(feeForVBytes(INPUT_VBYTES, rateMp))} PRL ` +
      `marginal input fee) than ${netNegative.length > 1 ? "they're" : "it's"} worth — ` +
      `deselect ${netNegative.length > 1 ? "them" : "it"} to keep more of the recovered value.`
    );
  }
  if (vBytes > WARN_VBYTES) {
    warnings.push(
      `This transaction is ${vBytes.toLocaleString()} vBytes — unusually large. ` +
      `It may exceed relay standardness limits; consider sweeping in smaller batches.`
    );
  }
  if (strategy === "all" && classified.some((u) => !inputs.includes(u))) {
    warnings.push("Note: some UTXOs were filtered out by the selection — check the input list.");
  }

  return {
    ok: true, refused: false, inputs, outputs, total, fee, feeRemainder,
    vBytes, rateMp, netValue, perOutput, warnings,
    targetAddress: encodeBech32m(network.hrp, 1, targetProgram),
  };
}

/** Human fee-rate label: "1.5 grains/vB". */
export function formatRateMp(rateMp) {
  const whole = rateMp / FEE_RATE_SCALE;
  const frac = rateMp % FEE_RATE_SCALE;
  return frac === 0n ? whole.toString() : `${whole}.${frac.toString().padStart(3, "0").replace(/0+$/, "")}`;
}

/* ---------------- signing ---------------- */

const b58check = createBase58check(sha256);
const XPRV_VERSIONS = new Set([0x0488ade4, 0x043587cf]); // xprv / tprv

/** Parse a pasted secret: WIF, xprv/tprv, or raw 64-hex.
 *  The xprv's 32-byte secret is used DIRECTLY as the signing key (no new
 *  derivation) — labeled honestly in the returned `kind` note.
 *  Returns {wallet, kind, note} or {error}. The secret never leaves this call. */
export function parseSweepKey(text, network) {
  const raw = String(text ?? "").trim().replace(/\s+/g, "");
  if (!raw) return { error: "Paste the WIF or xprv controlling this address." };
  // 1. WIF (audited walletFromWIF, network-checked)
  try {
    const w = walletFromWIF(raw, network);
    return { wallet: w, kind: "wif", note: "WIF — single-key control of the address." };
  } catch { /* not WIF, keep trying */ }
  // 2. xprv/tprv: base58check-decode, take the 32-byte keydata
  try {
    const payload = b58check.decode(raw);
    if (payload.length === 78 && XPRV_VERSIONS.has(
      (payload[0] << 24) | (payload[1] << 16) | (payload[2] << 8) | payload[3]
    )) {
      const keydata = payload.slice(45, 78);
      if (keydata[0] !== 0x00) throw new Error("not a private extended key");
      const w = walletFromPriv(keydata.slice(1), network);
      return {
        wallet: w, kind: "xprv",
        note: "xprv key material used directly as the signing key (the extended key's own 32-byte secret — NOT a derived child). If your coins sit on derived child addresses (m/86'/…'/0/i), paste each child key's WIF instead.",
      };
    }
  } catch { /* not an xprv, keep trying */ }
  // 3. raw 64-hex private key
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    try {
      const w = walletFromPriv(raw, network);
      return { wallet: w, kind: "hex", note: "Raw private key (hex) — single-key control of the address." };
    } catch (e) {
      return { error: "Invalid private key: " + (e.message || e) };
    }
  }
  return { error: "Unrecognized key format — paste a WIF, xprv/tprv, or 64-char hex private key." };
}

/** Build + sign the consolidation tx and re-verify EVERY signature locally.
 *  Loud refusal unless the key's address exactly matches sweptAddress.
 *  opts: { network, sweptAddress, secretText, plan }
 *  Returns {txid, hex, checks, kind, note}. Never exposes hex when a check fails. */
export function buildSweepTx({ network, sweptAddress, secretText, plan }) {
  if (!plan || !plan.ok || plan.refused) throw new Error("No valid plan to sign — build a plan first.");
  const k = parseSweepKey(secretText, network);
  if (k.error) throw new Error(k.error);
  const w = k.wallet;
  if (w.address.toLowerCase() !== String(sweptAddress).toLowerCase()) {
    throw new Error(
      `KEY DOES NOT CONTROL THIS ADDRESS. The pasted key derives ${w.address} but the ` +
      `analyzed address is ${sweptAddress}. Consolidation refused — paste the key for the analyzed address.`
    );
  }
  const { tweakedX } = tweakKeypath(w.internalXOnly);
  const spk = p2trScriptPubKey(tweakedX);
  const inputs = plan.inputs.map((u) => {
    const value = Number(u.value);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("UTXO value out of safe range");
    return {
      txid: u.txid, vout: u.vout, value, spk,
      priv: w.priv, internalXOnly: w.internalXOnly,
    };
  });
  const outputs = plan.outputs.map((o) => {
    const value = Number(o.value);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("output value out of safe range");
    return { program: o.program, value };
  });
  const { txid, hex } = buildKeypathTxEx(network, inputs, outputs, SIGHASH_DEFAULT);
  const prevouts = inputs.map((i) => ({ value: i.value, spk: i.spk }));
  const checks = verifySignedTx(network, hex, prevouts);
  const bad = checks.filter((c) => !c.ok);
  if (bad.length || checks.length !== inputs.length) {
    throw new Error("LOCAL SIGNATURE VERIFICATION FAILED — the transaction was NOT produced: " +
      bad.map((b) => `#${b.index}: ${b.reason}`).join("; "));
  }
  return { txid, hex, checks, kind: k.kind, note: k.note, address: w.address };
}

/* ---------------- verify step ---------------- */

/** Compare a post-consolidation re-scan against the pre-sweep snapshot.
 *  opts: { preCount, preTotal (BigInt), fee (BigInt), postUtxos, targetAddress }
 *  Returns {ok, lines[]} — ok only when count dropped AND balance is exactly
 *  preTotal − fee. */
export function comparePostSweep({ preCount, preTotal, fee, postUtxos, targetAddress }) {
  preTotal = BigInt(preTotal); fee = BigInt(fee);
  const postCount = postUtxos.length;
  const postTotal = postUtxos.reduce((a, u) => a + BigInt(u.value), 0n);
  const expected = preTotal - fee;
  const lines = [
    { label: "UTXO count", before: String(preCount), after: String(postCount), ok: postCount < preCount },
    { label: "Balance", before: `${formatGrains(preTotal)} PRL`, after: `${formatGrains(postTotal)} PRL`, ok: postTotal === expected },
    { label: "Expected post-sweep balance", before: `${formatGrains(expected)} PRL`, after: "(pre-total − fee)", ok: postTotal === expected },
  ];
  const ok = lines.every((l) => l.ok);
  return {
    ok, lines, postCount, postTotal, expected,
    verdict: ok
      ? `CONSOLIDATION VERIFIED — ${preCount} UTXOs became ${postCount}, balance ${formatGrains(preTotal)} → ${formatGrains(postTotal)} PRL (fee ${formatGrains(fee)} PRL).`
      : "NOT VERIFIED — the re-scan does not match the expected post-sweep state. The consolidation may still be unconfirmed, or the address may have received new funds.",
    targetAddress,
  };
}

/** Standalone verifier: given a Blockbook tx JSON, prove it is a clean
 *  consolidation — every input from sweptAddress, every output to
 *  targetAddress. Returns {ok, fee, inTotal, outTotal, nIn, nOut, lines[]} or
 *  {ok:false, refusal}. Signature validity is assumed from network acceptance
 *  (stated honestly in the returned note). */
export function verifyConsolidationTx(txJson, sweptAddress, targetAddress) {
  const swept = String(sweptAddress).toLowerCase();
  const target = String(targetAddress).toLowerCase();
  const vin = txJson.vin || [];
  const vout = txJson.vout || [];
  if (!vin.length || !vout.length) {
    return { ok: false, refusal: "Transaction has no inputs or no outputs — nothing to verify." };
  }
  for (let i = 0; i < vin.length; i++) {
    const addrs = (vin[i].addresses || []).map((a) => String(a).toLowerCase());
    if (!addrs.includes(swept)) {
      return {
        ok: false,
        refusal: `REFUSED — input #${i} is not from the swept address. Found: ${(vin[i].addresses || []).join(", ") || "unknown"}. A clean consolidation spends ONLY ${sweptAddress}.`,
      };
    }
  }
  for (let i = 0; i < vout.length; i++) {
    const addrs = (vout[i].addresses || []).map((a) => String(a).toLowerCase());
    if (!addrs.includes(target)) {
      return {
        ok: false,
        refusal: `REFUSED — output #${i} does not pay the target address. Found: ${(vout[i].addresses || []).join(", ") || "unknown"}. A clean consolidation pays ONLY ${targetAddress}.`,
      };
    }
  }
  const inTotal = vin.reduce((a, v) => a + BigInt(v.value ?? 0), 0n);
  const outTotal = vout.reduce((a, v) => a + BigInt(v.value ?? 0), 0n);
  const fee = inTotal - outTotal;
  if (fee < 0n) return { ok: false, refusal: "Impossible transaction: outputs exceed inputs." };
  return {
    ok: true, nIn: vin.length, nOut: vout.length, inTotal, outTotal, fee,
    confirmations: txJson.confirmations ?? 0,
    note: "Signature validity is assumed from network acceptance — Blockbook served this transaction, so consensus already accepted its witnesses.",
  };
}
