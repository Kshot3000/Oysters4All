/* Pearl Bazaar — PRL-20 marketplace core (settlement, codec, indexer, board).
 *
 * ESM source. Runs in the browser (via the esbuild IIFE bundle
 * market.bundle.js -> window.PearlMarket) and in node (tests/).
 *
 * Crypto is vendored in ./crypto.js (from the prl20-launcher's audited
 * pearl-inscribe.js lineage: pearlpurse wallet core + Pearl node/txscript).
 *
 * Settlement model (Unisat-style atomic swap, adapted to Pearl Taproot
 * keypath):
 *  - A listing presigns a template tx with SIGHASH_SINGLE|ANYONECANPAY (0x83):
 *    input[0] = the seller's transfer-lot UTXO, output[0] = price -> seller.
 *    The 0x83 digest commits to the lot outpoint/value/spk/sequence and to
 *    output[0] only — the buyer later appends their own inputs and the
 *    lot/change outputs without invalidating the seller's signature.
 *  - The buyer verifies the presignature (verifyListing) BEFORE adding
 *    inputs, then builds the fill tx:
 *      in:  [lot (seller sig || 0x83), ...buyer PRL inputs (SIGHASH_DEFAULT)]
 *      out: [price -> seller, lotValue -> buyer, change -> buyer]
 *    Moving the lot UTXO to the buyer is what the Pearlscriptions indexer
 *    watches: the lot amount is credited to the new owner on confirmation.
 */

import {
  NETWORKS, GRAIN_PER_PRL, DUST_GRAIN,
  encodeBech32m, decodeBech32m,
  bytesToHex, hexToBytes,
  sha256, dblSha, taggedHash,
  varint, u32le, u64le, txidLE,
  schnorr,
  tweakKeypath, tweakPrivKeypath,
  p2trScriptPubKey, keypathTxVBytes,
  keypathSigDigestEx,
  newMnemonic, walletFromMnemonic, walletFromWIF, walletFromPriv, walletToWIF,
  buildInscriptionScript, commitKeyInfo, revealTxVBytes, buildRevealTx, buildKeypathTx,
  buildTransferJson, validatePrl20Json,
  fetchUtxos, fetchFeeRateGrainsPerVByte, broadcastTx,
} from "./crypto.js";

export { NETWORKS, GRAIN_PER_PRL, DUST_GRAIN };
export {
  encodeBech32m, decodeBech32m, bytesToHex, hexToBytes,
  newMnemonic, walletFromMnemonic, walletFromWIF, walletFromPriv, walletToWIF,
  tweakKeypath, p2trScriptPubKey,
  buildTransferJson, validatePrl20Json,
  fetchUtxos, fetchFeeRateGrainsPerVByte, broadcastTx,
};

/* ---------------- sighash types ---------------- */

export const SIGHASH_DEFAULT = 0x00;
export const SIGHASH_SINGLE = 0x03;
export const SIGHASH_ANYONECANPAY = 0x80;
/** SIGHASH_SINGLE | SIGHASH_ANYONECANPAY — the listing presignature type. */
export const SIGHASH_SINGLE_ANYONECANPAY = 0x83;

export const LISTING_VERSION = 1;
export const LISTING_SEQUENCE = 0xffffffff;
export const MAX_SAFE_PRICE_GRAINS = Number.MAX_SAFE_INTEGER;

/* ---------------- formatting helpers ---------------- */

export function fmtPRL(grains) {
  const g = typeof grains === "bigint" ? grains : BigInt(grains);
  const neg = g < 0n;
  const a = neg ? -g : g;
  const whole = a / BigInt(GRAIN_PER_PRL);
  const frac = (a % BigInt(GRAIN_PER_PRL)).toString().padStart(8, "0").replace(/0+$/, "");
  return (neg ? "-" : "") + whole.toString() + (frac ? "." + frac : "");
}

/** Parse "1.5" PRL -> 150000000n grains. Throws on bad input. */
export function parsePRL(str) {
  const m = /^\s*(\d+)(?:\.(\d{1,8}))?\s*$/.exec(String(str));
  if (!m) throw new Error(`bad PRL amount: ${str}`);
  return BigInt(m[1]) * BigInt(GRAIN_PER_PRL) + BigInt((m[2] ?? "").padEnd(8, "0") || "0");
}

export function fmtInt(v) {
  return BigInt(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Token base units -> display string given decimals. */
export function fmtTokens(baseUnits, decimals) {
  const b = BigInt(baseUnits);
  const d = Number(decimals || 0);
  if (d === 0) return fmtInt(b);
  const neg = b < 0n;
  const a = neg ? -b : b;
  const div = 10n ** BigInt(d);
  const frac = (a % div).toString().padStart(d, "0").replace(/0+$/, "");
  return (neg ? "-" : "") + fmtInt(a / div) + (frac ? "." + frac : "");
}

export function shortAddr(a, n = 10) {
  const s = String(a || "");
  return s.length > n + 6 ? s.slice(0, n) + "…" + s.slice(-6) : s;
}

export function timeAgo(ts, nowMs = Date.now()) {
  const s = Math.max(0, Math.floor((nowMs - Number(ts)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function expiryLabel(expiryMs, nowMs = Date.now()) {
  const ms = Number(expiryMs) - nowMs;
  if (ms <= 0) return "expired";
  const h = Math.floor(ms / 3600000);
  if (h < 48) return `expires in ${h}h`;
  return `expires in ${Math.floor(h / 24)}d`;
}

export const outpointStr = (txid, vout) => `${txid}:${vout}`;
export function parseOutpoint(s) {
  const m = /^([0-9a-f]{64}):(\d+)$/i.exec(String(s || "").trim());
  if (!m) throw new Error(`bad outpoint: ${s}`);
  return { txid: m[1].toLowerCase(), vout: Number(m[2]) };
}

/* ---------------- listing schema ---------------- */

const TICKER_RE = /^[a-z0-9]{1,16}$/;
const INT_RE = /^(0|[1-9][0-9]*)$/;

export function assertListingSchema(l, network, { checkExpiry = true } = {}) {
  if (!l || typeof l !== "object") throw new Error("listing must be an object");
  if (l.v !== LISTING_VERSION) throw new Error(`unsupported listing version: ${l.v}`);
  const tick = String(l.tick || "").toLowerCase();
  if (!TICKER_RE.test(tick)) throw new Error(`bad tick: ${l.tick}`);
  if (typeof l.amt !== "string" || !INT_RE.test(l.amt) || BigInt(l.amt) <= 0n)
    throw new Error("amt must be a canonical positive integer string");
  if (typeof l.priceGrains !== "string" || !INT_RE.test(l.priceGrains) || BigInt(l.priceGrains) <= 0n)
    throw new Error("priceGrains must be a canonical positive integer string");
  if (BigInt(l.priceGrains) > BigInt(MAX_SAFE_PRICE_GRAINS))
    throw new Error("priceGrains exceeds safe integer range");
  if (!/^[0-9a-f]{64}$/i.test(l.lotTxid || "")) throw new Error("bad lotTxid");
  if (!Number.isInteger(l.lotVout) || l.lotVout < 0) throw new Error("bad lotVout");
  if (!Number.isSafeInteger(l.lotValue) || l.lotValue < DUST_GRAIN) throw new Error("bad lotValue");
  if (!/^[0-9a-f]{68}$/i.test(l.lotSpkHex || "") || !l.lotSpkHex.toLowerCase().startsWith("5120"))
    throw new Error("lotSpkHex must be a 34-byte P2TR scriptPubKey");
  decodeBech32m(String(l.seller || ""), network.hrp); // throws on bad seller
  if (checkExpiry && (!Number.isFinite(Number(l.expiry)) || Number(l.expiry) <= Date.now()))
    throw new Error("listing expired");
  if (!/^[0-9a-f]{128}$/i.test(l.sig || "")) throw new Error("sig must be 64-byte hex");
  return {
    v: 1, tick, amt: String(l.amt), priceGrains: String(l.priceGrains),
    lotTxid: l.lotTxid.toLowerCase(), lotVout: l.lotVout, lotValue: l.lotValue,
    lotSpkHex: l.lotSpkHex.toLowerCase(), seller: String(l.seller),
    expiry: Number(l.expiry), created: Number(l.created || Date.now()),
    sig: l.sig.toLowerCase(),
  };
}

/** Unsigned listing skeleton (use signListing to attach the 0x83 presignature). */
export function makeListing({ tick, amt, lotTxid, lotVout, lotValue, lotSpkHex, priceGrains, seller, expiry, created }) {
  return {
    v: LISTING_VERSION,
    tick: String(tick).toLowerCase(),
    amt: String(amt),
    lotTxid: String(lotTxid).toLowerCase(),
    lotVout, lotValue,
    lotSpkHex: String(lotSpkHex).toLowerCase(),
    priceGrains: String(priceGrains),
    seller: String(seller),
    expiry: Number(expiry),
    created: Number(created ?? Date.now()),
    sig: "",
  };
}

/** The seller's template: input[0] = lot UTXO, output[0] = price -> seller.
 *  The lot spk must be the seller's own P2TR script (the lot is theirs). */
export function listingTemplateParts(listing, network) {
  const sellerProg = decodeBech32m(listing.seller, network.hrp).program;
  const lotSpk = hexToBytes(listing.lotSpkHex);
  const expected = p2trScriptPubKey(sellerProg);
  if (bytesToHex(lotSpk) !== bytesToHex(expected))
    throw new Error("lot spk does not match seller address");
  return {
    inputs: [{ txid: listing.lotTxid, vout: listing.lotVout, value: listing.lotValue, spk: lotSpk }],
    outputs: [{ program: sellerProg, value: Number(listing.priceGrains) }],
    sequence: LISTING_SEQUENCE,
  };
}

/** Seller presigns the listing template with SIGHASH_SINGLE|ANYONECANPAY.
 *  keys: { priv, internalXOnly } of the lot owner. Returns the signed listing. */
export function signListing(listing, { priv, internalXOnly }, network) {
  // Validate everything; the sig field is replaced below so a placeholder is OK.
  const norm = assertListingSchema({ ...listing, sig: "00".repeat(64) }, network);
  if (!priv || !internalXOnly) throw new Error("signing keys required");
  const { inputs, outputs, sequence } = listingTemplateParts(norm, network);
  const digest = keypathSigDigestEx(network, inputs, outputs, sequence, 0, SIGHASH_SINGLE_ANYONECANPAY);
  const sig = schnorr.sign(digest, tweakPrivKeypath(priv, internalXOnly), new Uint8Array(32));
  return { ...norm, sig: bytesToHex(sig) };
}

/** Buyer-side verification: recompute the 0x83 digest from the listing's own
 *  fields and check the Schnorr signature against the seller's tweaked key.
 *  MUST be called before adding buyer inputs. Returns {ok} or {ok, reason}. */
export function verifyListing(listing, network) {
  try {
    const norm = assertListingSchema(listing, network);
    const { inputs, outputs, sequence } = listingTemplateParts(norm, network);
    const digest = keypathSigDigestEx(network, inputs, outputs, sequence, 0, SIGHASH_SINGLE_ANYONECANPAY);
    const sellerProg = decodeBech32m(norm.seller, network.hrp).program;
    const ok = schnorr.verify(hexToBytes(norm.sig), digest, sellerProg);
    return ok ? { ok: true } : { ok: false, reason: "signature does not match the listing terms (price, lot, or seller was altered)" };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/** Per-token unit price of a listing as a rational string "num/den" grains. */
export function listingUnitPrice(listing) {
  const g = gcdBig(BigInt(listing.priceGrains), BigInt(listing.amt));
  return { num: (BigInt(listing.priceGrains) / g).toString(), den: (BigInt(listing.amt) / g).toString() };
}

function gcdBig(a, b) {
  a = a < 0n ? -a : a; b = b < 0n ? -b : b;
  while (b) { const t = a % b; a = b; b = t; }
  return a || 1n;
}

/* ---------------- fill transaction (buyer) ---------------- */

/** vBytes of a fill tx: 1 lot input (65-byte witness) + buyer inputs. */
export function fillTxVBytes(nBuyerInputs, nOut) {
  if (!Number.isInteger(nBuyerInputs) || nBuyerInputs < 1) throw new Error("need >= 1 buyer input");
  if (!Number.isInteger(nOut) || nOut < 2) throw new Error("need >= 2 outputs");
  const nIn = 1 + nBuyerInputs;
  const baseBytes = 4 + 1 + 41 * nIn + 1 + 43 * nOut + 4;
  const weight = 4 * baseBytes + 2 + 67 + 66 * nBuyerInputs; // lot witness = 65B sig
  return Math.ceil(weight / 4);
}

function serializeTxWithWitnesses(network, inputs, outputs, witnesses) {
  if (inputs.length !== witnesses.length) throw new Error("witness count mismatch");
  const core = [...u32le(network.txVersion), ...varint(inputs.length)];
  for (const inp of inputs)
    core.push(...txidLE(inp.txid), ...u32le(inp.vout), ...varint(0), ...u32le(inp.sequence ?? LISTING_SEQUENCE));
  core.push(...varint(outputs.length));
  for (const out of outputs) {
    const s = p2trScriptPubKey(out.program);
    core.push(...u64le(out.value), ...varint(s.length), ...s);
  }
  core.push(...u32le(0));
  const txid = bytesToHex(dblSha(Uint8Array.from(core)).reverse());

  const full = [...u32le(network.txVersion), 0x00, 0x01, ...varint(inputs.length)];
  for (const inp of inputs)
    full.push(...txidLE(inp.txid), ...u32le(inp.vout), ...varint(0), ...u32le(inp.sequence ?? LISTING_SEQUENCE));
  full.push(...varint(outputs.length));
  for (const out of outputs) {
    const s = p2trScriptPubKey(out.program);
    full.push(...u64le(out.value), ...varint(s.length), ...s);
  }
  for (const wit of witnesses) {
    full.push(...varint(wit.length));
    for (const el of wit) full.push(...varint(el.length), ...el);
  }
  full.push(...u32le(0));
  return { txid, hex: bytesToHex(Uint8Array.from(full)) };
}

/** Pick buyer PRL UTXOs to cover the listing price + fee (buyer pays fees).
 *  buyerUtxos: [{txid, vout, value}] (value grains, number). The lot input's
 *  own value cancels against the lot output, so selection targets the price. */
export function selectFillCoins({ buyerUtxos, priceGrains, feeRate }) {
  const price = Number(priceGrains);
  if (!Number.isSafeInteger(price) || price <= 0) throw new Error("bad priceGrains");
  if (!(feeRate > 0) || !Number.isFinite(feeRate)) throw new Error("bad fee rate");
  const sorted = [...(buyerUtxos || [])]
    .filter((u) => Number.isSafeInteger(u.value) && u.value > 0 && /^[0-9a-f]{64}$/i.test(u.txid || ""))
    .sort((a, b) => b.value - a.value);
  if (!sorted.length) throw new Error("buyer has no PRL UTXOs");
  const picked = [];
  let total = 0;
  for (const u of sorted) {
    picked.push(u);
    total += u.value;
    const fee3 = Math.ceil(fillTxVBytes(picked.length, 3) * feeRate);
    if (total < price + fee3) continue;
    const change = total - price - fee3;
    if (change === 0) {
      const fee2 = Math.ceil(fillTxVBytes(picked.length, 2) * feeRate);
      return { inputs: picked, feeGrains: fee2, changeGrains: 0, totalIn: total, nOut: 2 };
    }
    if (change >= DUST_GRAIN)
      return { inputs: picked, feeGrains: fee3, changeGrains: change, totalIn: total, nOut: 3 };
    // dust change: drop the change output, fee absorbs it
    const fee2 = Math.ceil(fillTxVBytes(picked.length, 2) * feeRate);
    const fee = total - price;
    if (fee < fee2) throw new Error("fee math error");
    return { inputs: picked, feeGrains: fee, changeGrains: 0, totalIn: total, nOut: 2 };
  }
  const fee1 = Math.ceil(fillTxVBytes(sorted.length, 2) * feeRate);
  throw new Error(
    `insufficient buyer funds: need ${fmtPRL(price + fee1)} PRL (price + fee), have ${fmtPRL(total)} PRL`
  );
}

/** Build + sign the buyer's fill transaction for a verified listing.
 *
 *  buyerUtxos: [{txid, vout, value, priv, internalXOnly}] — buyer PRL coins.
 *  The lot input carries the seller's 0x83 presignature as a 65-byte witness
 *  element (sig || 0x83); buyer inputs are signed SIGHASH_DEFAULT.
 *  Returns { txid, hex, feeGrains, changeGrains, priceGrains, lotValue, nIn, nOut }. */
export function buildFillTx({ network, listing, buyerUtxos, buyerAddress, feeRate }) {
  const v = verifyListing(listing, network);
  if (!v.ok) throw new Error("cannot fill: invalid listing (" + v.reason + ")");
  if (String(buyerAddress).toLowerCase() === String(listing.seller).toLowerCase())
    throw new Error("cannot fill your own listing");
  const price = Number(listing.priceGrains);
  const lotValue = listing.lotValue;
  const sellerProg = decodeBech32m(listing.seller, network.hrp).program;
  const buyerProg = decodeBech32m(String(buyerAddress), network.hrp).program;

  const sel = selectFillCoins({ buyerUtxos, priceGrains: price, feeRate });
  const byOutpoint = new Map((buyerUtxos || []).map((u) => [`${u.txid}:${u.vout}`, u]));

  const inputs = [{ txid: listing.lotTxid, vout: listing.lotVout, sequence: LISTING_SEQUENCE }];
  const digestInputs = [{
    txid: listing.lotTxid, vout: listing.lotVout, value: lotValue,
    spk: hexToBytes(listing.lotSpkHex),
  }];
  for (const u of sel.inputs) {
    const full = byOutpoint.get(`${u.txid}:${u.vout}`);
    if (!full || !full.priv || !full.internalXOnly) throw new Error("missing buyer key for selected UTXO");
    inputs.push({ txid: u.txid, vout: u.vout, sequence: LISTING_SEQUENCE });
    digestInputs.push({
      txid: u.txid, vout: u.vout, value: u.value,
      spk: p2trScriptPubKey(tweakKeypath(full.internalXOnly).tweakedX),
      _key: full,
    });
  }

  const outputs = [
    { program: sellerProg, value: price },      // [0] must equal the listing template
    { program: buyerProg, value: lotValue },   // [1] the lot moves to the buyer
  ];
  if (sel.changeGrains > 0) outputs.push({ program: buyerProg, value: sel.changeGrains });

  const digestInputsClean = digestInputs.map(({ _key, ...r }) => r);
  const witnesses = [[hexToBytes(listing.sig + "83")]]; // seller presig + hash type byte
  for (let k = 1; k < inputs.length; k++) {
    const key = digestInputs[k]._key;
    const digest = keypathSigDigestEx(network, digestInputsClean, outputs, LISTING_SEQUENCE, k, SIGHASH_DEFAULT);
    witnesses.push([schnorr.sign(digest, tweakPrivKeypath(key.priv, key.internalXOnly), new Uint8Array(32))]);
  }

  const { txid, hex } = serializeTxWithWitnesses(network, inputs, outputs, witnesses);
  return {
    txid, hex, feeGrains: sel.feeGrains, changeGrains: sel.changeGrains,
    priceGrains: price, lotValue, nIn: inputs.length, nOut: outputs.length,
  };
}

/* ---------------- listing codec (shareable order encoding) ---------------- */

const LISTING_FIELDS = ["v", "tick", "amt", "lotTxid", "lotVout", "lotValue", "lotSpkHex",
  "priceGrains", "seller", "expiry", "created", "sig"];

/** Canonical JSON encoding of a signed listing (stable key order). */
export function encodeListing(listing) {
  const o = {};
  for (const k of LISTING_FIELDS) {
    if (!(k in listing)) throw new Error(`encodeListing: missing field ${k}`);
    o[k] = listing[k];
  }
  return JSON.stringify(o);
}

/** Decode + schema-validate a listing (signature itself is checked by verifyListing). */
export function decodeListing(json) {
  let p;
  try { p = JSON.parse(String(json)); }
  catch { throw new Error("decodeListing: not valid JSON"); }
  if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error("decodeListing: must be an object");
  const extra = Object.keys(p).filter((k) => !LISTING_FIELDS.includes(k));
  if (extra.length) throw new Error(`decodeListing: unknown field ${extra[0]}`);
  for (const k of LISTING_FIELDS) {
    if (!(k in p)) throw new Error(`decodeListing: missing field ${k}`);
  }
  return {
    v: p.v, tick: String(p.tick), amt: String(p.amt),
    lotTxid: String(p.lotTxid), lotVout: p.lotVout, lotValue: p.lotValue,
    lotSpkHex: String(p.lotSpkHex), priceGrains: String(p.priceGrains),
    seller: String(p.seller), expiry: Number(p.expiry), created: Number(p.created),
    sig: String(p.sig),
  };
}

/* ---------------- simple coin selection (commit tx etc.) ---------------- */

/** Largest-first selection covering targetGrains at feeRate; dust change folds
 *  into the fee. Returns { inputs, feeGrains, changeGrains, totalIn, nOut }. */
export function selectCoinsSimple(utxos, targetGrains, feeRate, baseOuts) {
  if (!Number.isSafeInteger(targetGrains) || targetGrains <= 0) throw new Error("bad target");
  if (!(feeRate > 0) || !Number.isFinite(feeRate)) throw new Error("bad fee rate");
  const sorted = [...(utxos || [])]
    .filter((u) => Number.isSafeInteger(u.value) && u.value > 0 && /^[0-9a-f]{64}$/i.test(u.txid || ""))
    .sort((a, b) => b.value - a.value);
  if (!sorted.length) throw new Error("no spendable UTXOs");
  const picked = [];
  let total = 0;
  for (const u of sorted) {
    picked.push(u);
    total += u.value;
    const feeChange = Math.ceil(keypathTxVBytes(picked.length, baseOuts + 1) * feeRate);
    if (total < targetGrains + feeChange) continue;
    let change = total - targetGrains - feeChange;
    let nOut = baseOuts + 1;
    let fee = feeChange;
    if (change > 0 && change < DUST_GRAIN) { nOut = baseOuts; change = 0; fee = total - targetGrains; }
    return { inputs: picked, feeGrains: fee, changeGrains: change, totalIn: total, nOut };
  }
  throw new Error("insufficient funds for target + fee");
}

/* ---------------- transfer-lot creation (commit/reveal) ---------------- */

/** Plan the commit + reveal transactions that inscribe a transfer op,
 *  creating a new transfer lot owned by the wallet. Mirrors the launcher
 *  flow; the reveal's owner output (dust) becomes the lot UTXO. */
export function planTransferLot({ network, wallet, utxos, tick, amt, feeRate }) {
  if (!wallet || !wallet.priv || !wallet.internalXOnly) throw new Error("wallet keys required");
  const json = buildTransferJson({ tick, amt });
  const script = buildInscriptionScript(wallet.internalXOnly, json);
  const ci = commitKeyInfo(network, wallet.internalXOnly, script);
  const ownerProg = tweakKeypath(wallet.internalXOnly).tweakedX;
  const lotValue = DUST_GRAIN;
  const revealFee = Math.ceil(revealTxVBytes(script.length, 1) * feeRate);
  const sel = selectCoinsSimple(utxos, revealFee + lotValue, feeRate, 1);
  const commitInputs = sel.inputs.map((u) => ({
    txid: u.txid, vout: u.vout, value: u.value, priv: wallet.priv, internalXOnly: wallet.internalXOnly,
  }));
  const commitOutputs = [{ program: ci.commitXOnly, value: revealFee + lotValue }];
  if (sel.changeGrains > 0) commitOutputs.push({ program: ownerProg, value: sel.changeGrains });
  const commitTx = buildKeypathTx(network, commitInputs, commitOutputs);
  const revealTx = buildRevealTx(network, {
    commitTxid: commitTx.txid, commitVout: 0, commitValue: revealFee + lotValue,
    commitProgram: ci.commitXOnly, internalPriv: wallet.priv, script,
    controlBlock: ci.controlBlock,
    outputs: [{ program: ownerProg, value: lotValue }],
  });
  return {
    json,
    commitTx, revealTx,
    commitAddress: ci.commitAddress,
    lot: {
      txid: revealTx.txid, vout: 0, value: lotValue,
      spkHex: bytesToHex(p2trScriptPubKey(ownerProg)),
      tick: String(tick).toLowerCase(), amount: String(amt),
    },
    commitFeeGrains: sel.feeGrains, revealFeeGrains: revealFee,
  };
}

/* ---------------- Pearlscriptions indexer client ---------------- */

function needBase(base) {
  const b = String(base || "").replace(/\/$/, "");
  if (!b) throw new Error("indexer not configured — set the indexer base URL in Settings");
  return b;
}

async function idxFetch(base, path, fetchFn = fetch) {
  const b = needBase(base);
  let res;
  try {
    res = await fetchFn(b + path);
  } catch (e) {
    throw new Error(`indexer unreachable (${path}): ${e.message}`);
  }
  if (!res.ok) throw new Error(`indexer ${res.status} on ${path}`);
  return res.json();
}

/** GET /tokens -> { tokens, total }. Token summaries carry ticker,
 *  maxSupply, mintedSupply, decimals, holderCount, mintProgress... */
export async function idxGetTokens(base, fetchFn) {
  const j = await idxFetch(base, "/tokens", fetchFn);
  return { tokens: j.tokens ?? [], total: j.total ?? (j.tokens ?? []).length };
}

export async function idxGetToken(base, tick, fetchFn) {
  return idxFetch(base, `/tokens/${encodeURIComponent(String(tick).toLowerCase())}`, fetchFn);
}

/** GET /addresses/:address/balances */
export async function idxGetBalances(base, address, fetchFn) {
  return idxFetch(base, `/addresses/${encodeURIComponent(address)}/balances`, fetchFn);
}

/** GET /addresses/:address/transfer-lots -> { transferLots, tokens, total }.
 *  Each lot: { id, inscriptionId, ticker, amount, status, currentOutpoint
 *  ("txid:vout"), currentOwnerAddress, locationStatus... }. Note: the lot's
 *  PRL value is NOT included — join with idxGetUtxos on currentOutpoint. */
export async function idxGetTransferLots(base, address, fetchFn) {
  const j = await idxFetch(base, `/addresses/${encodeURIComponent(address)}/transfer-lots`, fetchFn);
  return { transferLots: j.transferLots ?? [], tokens: j.tokens ?? {}, total: j.total ?? 0 };
}

/** GET /addresses/:address/utxos -> { utxos: [{ outpoint, txid, vout,
 *  valueGrain, protected, transferLotId, ... }] } */
export async function idxGetUtxos(base, address, fetchFn) {
  const j = await idxFetch(base, `/addresses/${encodeURIComponent(address)}/utxos`, fetchFn);
  return j.utxos ?? [];
}

/* ---------------- local board + settings (localStorage) ---------------- */

const BOARD_KEY = "pearl-market-board-v1";
const SETTINGS_KEY = "pearl-market-settings-v1";

function storage() {
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch { /* fall through to memory */ }
  if (!globalThis.__pearlMarketMem) globalThis.__pearlMarketMem = new Map();
  const mem = globalThis.__pearlMarketMem;
  return {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  };
}

const blankBoard = () => ({ v: 1, listings: [], bids: [], trades: [], seq: 1 });

export function loadBoard() {
  try {
    const raw = storage().getItem(BOARD_KEY);
    if (!raw) return blankBoard();
    const b = JSON.parse(raw);
    if (!b || typeof b !== "object") return blankBoard();
    return {
      v: 1,
      listings: Array.isArray(b.listings) ? b.listings : [],
      bids: Array.isArray(b.bids) ? b.bids : [],
      trades: Array.isArray(b.trades) ? b.trades : [],
      seq: Number(b.seq) || 1,
    };
  } catch { return blankBoard(); }
}

export function saveBoard(b) {
  storage().setItem(BOARD_KEY, JSON.stringify(b));
}

export function boardAddListing(listing) {
  const b = loadBoard();
  const id = `L${b.seq++}`;
  b.listings.push({ ...listing, boardId: id, boardTs: Date.now() });
  saveBoard(b);
  return id;
}

export function boardCancelListing(boardId) {
  const b = loadBoard();
  const n = b.listings.length;
  b.listings = b.listings.filter((l) => l.boardId !== boardId);
  saveBoard(b);
  return n !== b.listings.length;
}

export function boardAddBid(bid) {
  const b = loadBoard();
  const id = `B${b.seq++}`;
  b.bids.push({ ...bid, boardId: id, boardTs: Date.now() });
  saveBoard(b);
  return id;
}

export function boardCancelBid(boardId) {
  const b = loadBoard();
  const n = b.bids.length;
  b.bids = b.bids.filter((x) => x.boardId !== boardId);
  saveBoard(b);
  return n !== b.bids.length;
}

export function boardAddTrade(trade) {
  const b = loadBoard();
  b.trades.push({ ...trade, ts: Number(trade.ts || Date.now()) });
  if (b.trades.length > 2000) b.trades = b.trades.slice(-2000);
  saveBoard(b);
}

export function loadSettings() {
  try {
    const raw = storage().getItem(SETTINGS_KEY);
    const s = raw ? JSON.parse(raw) : {};
    return {
      indexerBase: s.indexerBase || "",
      blockbookBase: s.blockbookBase || "https://blockbook.pearlresearch.ai",
      demo: s.demo !== false, // demo ON by default until the user configures
      address: s.address || "",
      networkId: s.networkId || "mainnet",
    };
  } catch {
    return { indexerBase: "", blockbookBase: "https://blockbook.pearlresearch.ai", demo: true, address: "", networkId: "mainnet" };
  }
}

export function saveSettings(s) {
  storage().setItem(SETTINGS_KEY, JSON.stringify(s));
}

/* ---------------- demo mode (deterministic, simulated) ---------------- */

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEMO_SELLERS = ["maker", "bazaar", "foundry", "vault", "pearldiver", "coral", "tidepool", "nacre"];

function demoAddress(rng, network, tag) {
  const seed = new Uint8Array(32);
  for (let i = 0; i < 32; i++) seed[i] = Math.floor(rng() * 256);
  const tagBytes = new TextEncoder().encode("pearl-bazaar-demo:" + tag);
  const both = new Uint8Array(tagBytes.length + 32);
  both.set(tagBytes); both.set(seed, tagBytes.length);
  const priv = sha256(both); // valid scalar w.h.p.
  const { tweakedX } = tweakKeypath(schnorr.getPublicKey(priv));
  return encodeBech32m(network.hrp, 1, tweakedX);
}

/** Deterministic demo token directory (labeled simulated in the UI). */
export function demoTokens(network = NETWORKS.mainnet) {
  void network;
  return [
    { ticker: "prls", displayTicker: "PRLS", maxSupply: "2100000000", mintedSupply: "412500000", decimals: 18, holderCount: 1284, mintProgress: 19.64, deployed: true, demo: true },
    { ticker: "pearl", displayTicker: "PEARL", maxSupply: "1000000000", mintedSupply: "880000000", decimals: 8, holderCount: 342, mintProgress: 88, deployed: true, demo: true },
    { ticker: "nacre", displayTicker: "NACRE", maxSupply: "21000000", mintedSupply: "21000000", decimals: 8, holderCount: 97, mintProgress: 100, deployed: true, demo: true },
    { ticker: "tide", displayTicker: "TIDE", maxSupply: "100000000", mintedSupply: "12500000", decimals: 6, holderCount: 58, mintProgress: 12.5, deployed: true, demo: true },
  ];
}

const DEMO_BASE_PRICE = { prls: 2500000n, pearl: 120000n, nacre: 88000000n, tide: 45000n }; // grains per whole token

/** Deterministic demo order book + trade tape. All funds simulated.
 *  Pass nowMs for deterministic output (defaults to Date.now()). */
export function demoBook(tick, network = NETWORKS.mainnet, seed = 1337, nowMs = Date.now()) {
  const t = String(tick).toLowerCase();
  const rng = mulberry32(seed ^ [...t].reduce((a, c) => a * 31 + c.charCodeAt(0) | 0, 7));
  const base = DEMO_BASE_PRICE[t] ?? 1000000n;
  const now = nowMs;
  const listings = [];
  for (let i = 0; i < 9; i++) {
    const seller = demoAddress(rng, network, DEMO_SELLERS[i % DEMO_SELLERS.length] + i);
    const prog = decodeBech32m(seller, network.hrp).program;
    const amt = [25000n, 50000n, 100000n, 200000n][Math.floor(rng() * 4)];
    const drift = 92 + Math.floor(rng() * 18); // 0.92x..1.09x
    const price = (amt * base * BigInt(drift)) / 100n;
    const lotTxid = [...Array(64)].map(() => "0123456789abcdef"[Math.floor(rng() * 16)]).join("");
    listings.push({
      v: 1, tick: t, amt: amt.toString(), lotTxid, lotVout: 0, lotValue: 546,
      lotSpkHex: bytesToHex(p2trScriptPubKey(prog)), priceGrains: price.toString(),
      seller, expiry: now + 7 * 86400000, created: now - Math.floor(rng() * 36) * 3600000,
      sig: [...Array(128)].map(() => "0123456789abcdef"[Math.floor(rng() * 16)]).join(""),
      demo: true, boardId: `demo-ask-${t}-${i}`,
    });
  }
  const bids = [];
  for (let i = 0; i < 6; i++) {
    const buyerAddress = demoAddress(rng, network, "bidder" + i);
    const amount = [10000n, 25000n, 50000n][Math.floor(rng() * 3)];
    const drift = 82 + Math.floor(rng() * 14);
    bids.push({
      tick: t, amount: amount.toString(), maxPrice: ((amount * base * BigInt(drift)) / 100n).toString(),
      buyerAddress, created: now - Math.floor(rng() * 20) * 3600000, demo: true, boardId: `demo-bid-${t}-${i}`,
    });
  }
  // 48h trade tape: random walk around base price
  const trades = [];
  let px = base;
  for (let i = 72; i >= 0; i--) {
    const n = 1 + Math.floor(rng() * 3);
    for (let k = 0; k < n; k++) {
      px = (px * BigInt(985 + Math.floor(rng() * 30))) / 1000n;
      if (px <= 0n) px = base;
      const amount = [5000n, 10000n, 25000n][Math.floor(rng() * 3)];
      trades.push({
        tick: t, amount: amount.toString(),
        priceGrains: ((amount * px) / (10n ** 0n)).toString(),
        pricePerTokenGrains: px.toString(),
        buyer: demoAddress(rng, network, "tb" + i + k), seller: demoAddress(rng, network, "ts" + i + k),
        ts: now - i * 3600000 - Math.floor(rng() * 3600000), demo: true,
      });
    }
  }
  trades.sort((a, b) => a.ts - b.ts);
  return { listings, bids, trades };
}

/** 24h mover stats from a trade tape: [{ tick, last, prev, changePct }]. */
export function tapeMovers(trades, ticks, nowMs = Date.now()) {
  const day = 86400000;
  return ticks.map((tick) => {
    const ts = trades.filter((t) => t.tick === tick && nowMs - t.ts < day)
      .sort((a, b) => a.ts - b.ts);
    if (ts.length < 2) return { tick, last: null, changePct: null, trades: ts.length };
    const price = (t) => Number(BigInt(t.pricePerTokenGrains ?? (BigInt(t.priceGrains) * 1n / BigInt(t.amount))));
    const last = price(ts[ts.length - 1]);
    const first = price(ts[0]);
    return { tick, last, changePct: first ? ((last - first) / first) * 100 : 0, trades: ts.length };
  });
}
