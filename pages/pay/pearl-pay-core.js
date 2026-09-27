/* Pearl Pay — core payment logic.
 *
 * Pure ESM, zero build step, no DOM. Runs in the browser (via import map)
 * and in node (for the verification test suite).
 *
 * Crypto lineage (attribution):
 *  - bech32m, TapTweak keypath tweak and BIP-86 derivation approach follow the
 *    audited pearlpurse wallet core (buildandtestppg/pearlpurse src/lib/pearl.js,
 *    ISC), itself verified byte-for-byte against Pearl's Go reference
 *    (node/txscript), via the PRL-20 launcher's pearl-inscribe.js in this repo.
 *  - Vendored deps: @scure/* + @noble/*, MIT (c) paulmillr.com — see lib/.
 *
 * Protocol facts (verified, not from memory):
 *  - Pearl addresses: bech32m (BIP-350), witness v1+, 32-byte programs;
 *    HRP prl (mainnet) / tprl (testnet) / rprl (regtest)
 *    (node/chaincfg/params.go Bech32HRPSegwit; node/btcutil/address.go).
 *  - BIP-86 account path m/86'/coin'/acct'; coin type 808276 (mainnet),
 *    1 (testnet) — matches pearlkeeper-client + upstream params.
 *  - xpub version bytes: 0x0488B21E (mainnet), tpub 0x043587CF (testnet) —
 *    standard BIP-32 version bytes.
 *  - Blockbook: https://blockbook.pearlresearch.ai (verified live 2026-09-26).
 *  - PRL price: CoinGecko coin id "pearl-2"
 *    (https://api.coingecko.com/api/v3/simple/price?ids=pearl-2&vs_currencies=usd),
 *    verified live 2026-09-26 ($1.46).
 */

import { HDKey } from "@scure/bip32";
import { schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";
import { bytesToNumberBE } from "@noble/curves/abstract/utils";

/* ---------------- chain params ---------------- */

export const GRAIN_PER_PRL = 100_000_000;
export const DUST_GRAIN = 546; // P2TR dust, matches upstream txrules / pearlpurse
export const GAP_LIMIT_DEFAULT = 20;
export const COINGECKO_PRICE_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=pearl-2&vs_currencies=usd&include_24hr_change=true";

export const NETWORKS = {
  mainnet: {
    id: "mainnet",
    label: "Mainnet",
    hrp: "prl",
    coinType: 808276,
    xpubVersions: { private: 0x0488ade4, public: 0x0488b21e }, // xprv / xpub
    blockbook: "https://blockbook.pearlresearch.ai",
  },
  testnet: {
    id: "testnet",
    label: "Testnet",
    hrp: "tprl",
    coinType: 1,
    xpubVersions: { private: 0x04358394, public: 0x043587cf }, // tprv / tpub
    blockbook: "", // no public Pearl testnet blockbook known — user configurable
  },
};

export function getNetwork(id) {
  const n = NETWORKS[id];
  if (!n) throw new Error(`unknown network "${id}" (expected mainnet|testnet)`);
  return n;
}

/* ---------------- bech32m (from pearlpurse lineage) ---------------- */

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32M_CONST = 0x2bc830a3;

function polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= GEN[i];
  }
  return chk;
}
function hrpExpand(hrp) {
  const out = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}
function checksum(hrp, data) {
  const pm = polymod([...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ BECH32M_CONST;
  const out = [];
  for (let i = 0; i < 6; i++) out.push((pm >> (5 * (5 - i))) & 31);
  return out;
}
export function convertBits(data, fromBits, toBits, pad, strictPadding = false) {
  let acc = 0, bits = 0;
  const out = [];
  const maxv = (1 << toBits) - 1;
  for (const value of data) {
    if (value < 0 || value >> fromBits !== 0) throw new Error("convertBits: invalid value");
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (toBits - bits)) & maxv);
  } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv)) {
    throw new Error("convertBits: invalid padding");
  }
  void strictPadding;
  return out;
}
export function encodeBech32m(hrp, version, program) {
  if (!(program instanceof Uint8Array) || program.length !== 32)
    throw new Error("encodeBech32m: program must be 32 bytes");
  if (version < 1 || version > 16) throw new Error("encodeBech32m: Pearl needs witness v1+");
  const data = [version, ...convertBits(program, 8, 5, true)];
  const combined = [...data, ...checksum(hrp, data)];
  return hrp + "1" + combined.map((c) => CHARSET[c]).join("");
}
export function decodeBech32m(addr, expectHrp = null) {
  const s = addr.toLowerCase();
  if (addr !== addr.toLowerCase() && addr !== addr.toUpperCase())
    throw new Error("decodeBech32m: mixed case");
  const pos = s.lastIndexOf("1");
  if (pos < 1 || pos + 7 > s.length) throw new Error("decodeBech32m: bad separator");
  const hrp = s.slice(0, pos);
  if (expectHrp && hrp !== expectHrp) throw new Error(`decodeBech32m: expected hrp ${expectHrp}`);
  const data = [];
  for (const c of s.slice(pos + 1)) {
    const i = CHARSET.indexOf(c);
    if (i < 0) throw new Error("decodeBech32m: bad charset char");
    data.push(i);
  }
  if (polymod([...hrpExpand(hrp), ...data]) !== BECH32M_CONST)
    throw new Error("decodeBech32m: bad bech32m checksum");
  const version = data[0];
  const program = new Uint8Array(convertBits(data.slice(1, -6), 5, 8, false));
  return { hrp, version, program };
}
export function isValidPearlAddress(addr, networkId) {
  try {
    const n = getNetwork(networkId);
    const d = decodeBech32m(addr, n.hrp);
    return d.version >= 1 && d.version <= 16 && d.program.length === 32;
  } catch {
    return false;
  }
}

/* ---------------- taproot ---------------- */

function taggedHash(tag, msg) {
  const tagHash = sha256(utf8ToBytes(tag));
  const pre = new Uint8Array(tagHash.length * 2 + msg.length);
  pre.set(tagHash);
  pre.set(tagHash, tagHash.length);
  pre.set(msg, tagHash.length * 2);
  return sha256(pre);
}
/** BIP-341 keypath tweak (empty merkle root): Q = P + H_TapTweak(P)*G */
export function tweakKeypath(internalXOnly) {
  const t = taggedHash("TapTweak", internalXOnly);
  const P = schnorr.utils.lift_x(bytesToNumberBE(internalXOnly));
  const Q = P.add(schnorr.Point.BASE.multiply(bytesToNumberBE(t)));
  return schnorr.utils.pointToBytes(Q); // 32-byte x-only tweaked key
}

/* ---------------- xpub handling ---------------- */

/**
 * Parse + validate a BIP-86 *account* extended public key.
 * NEVER accepts private extended keys (xprv/tprv) — the toolkit must never
 * see private key material. Returns { hdkey, depth, fingerprint, warnings }.
 */
export function parseAccountXpub(xpubStr, networkId) {
  const net = getNetwork(networkId);
  const s = String(xpubStr || "").trim();
  if (!s) throw new Error("xpub is empty");
  if (/^[5KL][1-9A-HJ-NP-Za-km-z]{50,51}$/.test(s))
    throw new Error("that looks like a private key (WIF), not an xpub — never paste private keys here");
  let hdkey;
  try {
    hdkey = HDKey.fromExtendedKey(s, net.xpubVersions);
  } catch (e) {
    // Distinguish "wrong network version" from garbage.
    const msg = e && e.message ? e.message : String(e);
    if (/version mismatch/i.test(msg))
      throw new Error(
        `xpub version mismatch: this key is not a ${net.id} xpub ` +
        `(expected ${net.id === "mainnet" ? "xpub…" : "tpub…"})`
      );
    throw new Error("invalid xpub: " + msg);
  }
  if (hdkey.privateKey || hdkey.privKey)
    throw new Error("refusing extended PRIVATE key — paste the account xpub (public), never an xprv");
  const warnings = [];
  if (hdkey.depth !== 3)
    warnings.push(
      `xpub depth is ${hdkey.depth}, expected 3 for a BIP-86 account key ` +
      `(m/86'/${net.coinType}'/acct'). Derivation will still work, but confirm ` +
      `your wallet exported the account-level xpub.`
    );
  return {
    hdkey,
    depth: hdkey.depth,
    fingerprint: bytesToHex(new Uint8Array([
      (hdkey.parentFingerprint >>> 24) & 0xff, (hdkey.parentFingerprint >>> 16) & 0xff,
      (hdkey.parentFingerprint >>> 8) & 0xff, hdkey.parentFingerprint & 0xff,
    ])),
    warnings,
  };
}

/** Derive the P2TR address at external-chain index from an account xpub. */
export function deriveInvoiceAddress(xpubStr, index, networkId) {
  const net = getNetwork(networkId);
  if (!Number.isInteger(index) || index < 0 || index > 0x7fffffff)
    throw new Error("index must be an integer 0..2^31-1");
  const { hdkey } = parseAccountXpub(xpubStr, networkId);
  const child = hdkey.derive(`m/0/${index}`); // external chain, non-hardened
  if (!child.publicKey) throw new Error("derivation failed");
  const internalXOnly = child.publicKey.slice(1); // 32-byte x-only
  const tweaked = tweakKeypath(internalXOnly);
  return encodeBech32m(net.hrp, 1, tweaked);
}

/**
 * Gap-limit-aware scan: find the first unused external-chain index.
 * Checks blockbook for each derived address (batched sequentially; stops at
 * the first index with no history, honoring the gap limit).
 * `fetchFn` is injectable for tests (defaults to global fetch).
 */
export async function findNextUnusedIndex(xpubStr, networkId, blockbookBase, opts = {}) {
  const net = getNetwork(networkId);
  const startIndex = opts.startIndex ?? 0;
  const gapLimit = opts.gapLimit ?? GAP_LIMIT_DEFAULT;
  const fetchFn = opts.fetchFn ?? fetch;
  if (!blockbookBase) throw new Error("blockbook base URL is required");
  const base = blockbookBase.replace(/\/+$/, "");
  let index = startIndex;
  let gap = 0;
  const used = [];
  while (gap < gapLimit) {
    const addr = deriveInvoiceAddress(xpubStr, index, networkId);
    let txs = 0;
    try {
      const r = await fetchFn(`${base}/api/v2/address/${addr}`);
      if (!r.ok) throw new Error(`blockbook ${r.status}`);
      const j = await r.json();
      txs = Number(j.txs || 0);
    } catch (e) {
      throw new Error(`blockbook lookup failed at index ${index}: ${e.message}`);
    }
    if (txs > 0) { used.push(index); gap = 0; }
    else gap++;
    index++;
    void net;
  }
  return { index: index - gapLimit, scanned: index - startIndex, used };
}

/* ---------------- base64url (no Buffer dependency) ---------------- */

function b64urlEncode(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const b64 = typeof btoa === "function"
    ? btoa(bin)
    : Buffer.from(bin, "binary").toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const bin = typeof atob === "function"
    ? atob(b64 + pad)
    : Buffer.from(b64 + pad, "base64").toString("binary");
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ---------------- invoice codec ---------------- */

export const INVOICE_VERSION = 1;

/**
 * Invoice payload (all amounts in grains, as decimal strings — never floats):
 * { v, net, grains, label, xpub?, addr?, idx?, exp (unix sec), conf }
 * Either (xpub + idx) for derived addresses, or a fixed addr.
 */
export function encodeInvoice(inv) {
  const net = getNetwork(inv.net);
  const grains = String(inv.grains);
  if (!/^[1-9][0-9]*$/.test(grains)) throw new Error("grains must be a positive integer string");
  if (BigInt(grains) < BigInt(DUST_GRAIN)) throw new Error(`amount below dust (${DUST_GRAIN} grains)`);
  const label = String(inv.label || "").slice(0, 140);
  const exp = Number(inv.exp);
  if (!Number.isInteger(exp) || exp <= 0) throw new Error("exp must be a unix timestamp");
  const conf = Number(inv.conf ?? 1);
  if (!Number.isInteger(conf) || conf < 0 || conf > 100) throw new Error("conf must be 0..100");
  const out = { v: INVOICE_VERSION, net: net.id, grains, label, exp, conf };
  if (inv.xpub) {
    parseAccountXpub(inv.xpub, net.id); // validate now, fail fast
    const idx = Number(inv.idx ?? 0);
    if (!Number.isInteger(idx) || idx < 0 || idx > 0x7fffffff) throw new Error("bad idx");
    out.xpub = String(inv.xpub).trim();
    out.idx = idx;
  } else if (inv.addr) {
    if (!isValidPearlAddress(inv.addr, net.id)) throw new Error("invalid fixed address for " + net.id);
    out.addr = inv.addr;
  } else {
    throw new Error("invoice needs either xpub (+idx) or a fixed addr");
  }
  return b64urlEncode(utf8ToBytes(JSON.stringify(out)));
}

export function decodeInvoice(code) {
  let obj;
  try {
    obj = JSON.parse(new TextDecoder().decode(b64urlDecode(String(code).trim())));
  } catch {
    throw new Error("invoice code is not valid base64url JSON");
  }
  if (obj.v !== INVOICE_VERSION) throw new Error(`unsupported invoice version ${obj.v}`);
  const net = getNetwork(obj.net);
  if (!/^[1-9][0-9]*$/.test(String(obj.grains))) throw new Error("invoice: bad grains");
  if (typeof obj.label !== "string") throw new Error("invoice: bad label");
  if (!Number.isInteger(obj.exp)) throw new Error("invoice: bad exp");
  const conf = Number(obj.conf ?? 1);
  if (obj.xpub) {
    parseAccountXpub(obj.xpub, net.id);
    if (!Number.isInteger(obj.idx) || obj.idx < 0) throw new Error("invoice: bad idx");
    obj.address = deriveInvoiceAddress(obj.xpub, obj.idx, net.id);
  } else if (obj.addr) {
    if (!isValidPearlAddress(obj.addr, net.id)) throw new Error("invoice: bad addr");
    obj.address = obj.addr;
  } else {
    throw new Error("invoice: neither xpub nor addr");
  }
  obj.network = net;
  obj.conf = conf;
  return obj;
}

/* ---------------- payment state machine ---------------- */

export const PAY_STATES = ["awaiting", "partial", "detected", "confirmed", "expired"];

/**
 * Pure state classifier. All amounts in grains (BigInt-safe: accepts
 * number|string|bigint, compared as BigInt).
 *  - awaiting: nothing received yet, not expired
 *  - partial: something received but < required, not expired
 *  - detected: full amount seen, confirmations < required (0-conf counts)
 *  - confirmed: confirmations >= required
 *  - expired: deadline passed and not confirmed
 */
export function classifyPayment({ nowMs, expiryMs, receivedGrains, confirmedGrains, requiredGrains }) {
  const req = BigInt(requiredGrains);
  const rec = BigInt(receivedGrains);
  const conf = BigInt(confirmedGrains);
  if (conf >= req) return "confirmed";
  if (Number(nowMs) >= Number(expiryMs)) return "expired";
  if (rec >= req) return "detected";
  if (rec > 0n) return "partial";
  return "awaiting";
}

/**
 * Normalize a blockbook /api/v2/address response into received/confirmed
 * grain totals for a fresh invoice address (totalSent is expected to be 0;
 * if the address was reused, we count net received).
 */
export function summarizeAddress(bb) {
  const totalReceived = BigInt(bb.totalReceived ?? 0);
  const totalSent = BigInt(bb.totalSent ?? 0);
  // unconfirmedBalance may be negative (unconfirmed spends); clamp at 0 for
  // a receive-only invoice address.
  let unconf = 0n;
  try { unconf = BigInt(bb.unconfirmedBalance ?? 0); } catch { unconf = 0n; }
  if (unconf < 0n) unconf = 0n;
  const received = totalReceived > totalSent ? totalReceived - totalSent : 0n;
  const confirmedReceived = received > unconf ? received - unconf : 0n;
  return {
    received: received.toString(),
    confirmedReceived: confirmedReceived.toString(),
    txCount: Number(bb.txs ?? 0),
    unconfirmedTxs: Number(bb.unconfirmedTxs ?? 0),
  };
}

export async function fetchAddressSummary(blockbookBase, address, fetchFn = fetch) {
  const base = blockbookBase.replace(/\/+$/, "");
  const r = await fetchFn(`${base}/api/v2/address/${address}`);
  if (!r.ok) throw new Error(`blockbook ${r.status} for ${address}`);
  return summarizeAddress(await r.json());
}

/**
 * Confirmation-aware payment summary.
 *  - reqConf <= 0: 0-conf counts — confirmedReceived = total received.
 *  - reqConf === 1: confirmedReceived = received minus unconfirmed (cheap path).
 *  - reqConf > 1: fetches ?details=txs and sums only outputs whose transaction
 *    has >= reqConf confirmations. This is the only correct way to enforce
 *    N confirmations; the cheap address totals cannot express depth.
 * Returns the summarizeAddress() shape with confirmedReceived redefined as
 * "received with at least reqConf confirmations".
 */
export async function fetchConfirmationAwareSummary(blockbookBase, address, reqConf = 1, fetchFn = fetch) {
  const base = blockbookBase.replace(/\/+$/, "");
  if (reqConf <= 0) {
    const s = await fetchAddressSummary(base, address, fetchFn);
    return { ...s, confirmedReceived: s.received, reqConf };
  }
  if (reqConf === 1) {
    const s = await fetchAddressSummary(base, address, fetchFn);
    return { ...s, reqConf };
  }
  const r = await fetchFn(`${base}/api/v2/address/${address}?details=txs`);
  if (!r.ok) throw new Error(`blockbook ${r.status} for ${address}`);
  const j = await r.json();
  const s = summarizeAddress(j);
  let deep = 0n;
  const txs = Array.isArray(j.txs) ? j.txs : [];
  for (const tx of txs) {
    const conf = Number(tx?.confirmations ?? 0);
    if (!(conf >= reqConf)) continue; // skips 0-conf, negative (conflicted), and shallow
    for (const vout of tx.vout ?? []) {
      const addrs = vout?.addresses ?? vout?.scriptPubKey?.addresses ?? [];
      if (Array.isArray(addrs) && addrs.includes(address)) {
        try { deep += BigInt(vout.value ?? 0); } catch { /* ignore malformed */ }
      }
    }
  }
  return { ...s, confirmedReceived: deep.toString(), reqConf };
}

/**
 * Poll blockbook until the payment confirms / expires / is stopped.
 * reqConf is ENFORCED: confirmedReceived counts only outputs whose transaction
 * has at least reqConf confirmations (via ?details=txs when reqConf > 1).
 * onEvent(state, detail) fires on every state change (and once at start).
 * Returns a stop() function.
 */
export function watchPayment({ blockbookBase, address, requiredGrains, expiryMs, reqConf = 1, intervalMs = 15000, onEvent = () => {}, fetchFn = fetch }) {
  let stopped = false;
  let lastState = null;
  const stop = () => { stopped = true; if (timer) clearInterval(timer); };
  const check = async () => {
    if (stopped) return;
    try {
      const s = await fetchConfirmationAwareSummary(blockbookBase, address, reqConf, fetchFn);
      const state = classifyPayment({
        nowMs: Date.now(), expiryMs,
        receivedGrains: s.received, confirmedGrains: s.confirmedReceived,
        requiredGrains,
      });
      if (state !== lastState) { lastState = state; onEvent(state, s); }
      if (state === "confirmed" || state === "expired") stop();
    } catch (e) {
      onEvent("error", { message: e.message, lastState });
    }
  };
  const timer = setInterval(check, intervalMs);
  check();
  return stop;
}

/* ---------------- exchange rate ---------------- */

export async function fetchPrlUsd(fetchFn = fetch) {
  const r = await fetchFn(COINGECKO_PRICE_URL, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`coingecko ${r.status}`);
  const j = await r.json();
  const usd = Number(j?.["pearl-2"]?.usd);
  if (!Number.isFinite(usd) || usd <= 0) throw new Error("coingecko: bad price payload");
  return {
    usd,
    change24h: Number(j["pearl-2"].usd_24h_change ?? NaN),
    at: Date.now(),
    source: "coingecko",
  };
}

/** USD → grains at a given rate (rounds to whole grains). */
export function usdToGrains(usd, rateUsd) {
  const u = Number(usd), r = Number(rateUsd);
  if (!Number.isFinite(u) || u <= 0) throw new Error("usd must be > 0");
  if (!Number.isFinite(r) || r <= 0) throw new Error("rate must be > 0");
  return BigInt(Math.round((u / r) * GRAIN_PER_PRL)).toString();
}
export function grainsToUsd(grains, rateUsd) {
  const g = Number(grains), r = Number(rateUsd);
  if (!Number.isFinite(g) || g < 0) throw new Error("grains must be >= 0");
  if (!Number.isFinite(r) || r <= 0) throw new Error("rate must be > 0");
  return (g / GRAIN_PER_PRL) * r;
}
export function formatPRL(grains) {
  const g = BigInt(grains);
  const whole = g / BigInt(GRAIN_PER_PRL);
  const frac = (g % BigInt(GRAIN_PER_PRL)).toString().padStart(8, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}
export function formatUSD(usd) {
  return Number(usd).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/** Payment URI proposal: pearl:<address>?amount=<prl> (documented as a proposal). */
export function pearlUri(address, grains) {
  return `pearl:${address}?amount=${formatPRL(grains)}`;
}

export { bytesToHex, hexToBytes };
