/* Pearl Wallet core — ESM source (bundled to pearl-wallet.bundle.js via esbuild).
 *
 * Crypto lineage (do NOT reimplement):
 *  - src/pearl.js is the audited pearlpurse reference, verified byte-for-byte
 *    against Pearl's Go node (addresses, signatures, signed tx bytes, txids).
 *    We reuse: tweakXOnlyPub, tweakPriv, buildTx, txVBytes, decodeBech32m,
 *    convertBits, HDKey/schnorr plumbing.
 *  - BIP-39 via @scure/bip39, base58check via @scure/base, WIF/version bytes
 *    and network params match files/pages/prl20-launcher/pearl-inscribe.js.
 *
 * This module adds wallet-level logic on top: network-parameterized derivation
 * paths (m/86'/{coin}'/0'/0/{index}), network-parameterized bech32m encoding,
 * WIF import/export, coin selection, fee estimation, blockbook client,
 * AES-GCM vault (MetaMask/Phantom pattern), CoinGecko rate, Pearlscriptions
 * token balances.
 */

import * as P from "./pearl.js";
import { HDKey } from "@scure/bip32";
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { createBase58check } from "@scure/base";
import { sha256 } from "@noble/hashes/sha256";
import { schnorr } from "@noble/curves/secp256k1";

/* ---------------- chain params ---------------- */

export const GRAIN_PER_PRL = 100_000_000;
export const DUST_GRAIN = 546; // P2TR dust, matches upstream txrules / pearlpurse

export const NETWORKS = {
  mainnet: {
    id: "mainnet",
    label: "Mainnet",
    hrp: "prl",
    coinType: 808276,
    wifVersion: 0x80,
    blockbook: "https://blockbook.pearlresearch.ai",
    explorer: "https://blockbook.pearlresearch.ai",
  },
  testnet: {
    id: "testnet",
    label: "Testnet",
    hrp: "tprl",
    coinType: 1,
    wifVersion: 0xef,
    blockbook: "", // no verified public Pearl testnet blockbook — user supplies
    explorer: "",
  },
};

/* ---------------- bech32m (network-parameterized) ---------------- */

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32M_CONST = 0x2bc830a3;

function polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >>> i) & 1) chk ^= GEN[i];
  }
  return chk;
}
function hrpExpand(hrp) {
  const a = [];
  for (const c of hrp) a.push(c.charCodeAt(0) >>> 5);
  a.push(0);
  for (const c of hrp) a.push(c.charCodeAt(0) & 31);
  return a;
}

/** Encode a v1 (taproot) bech32m address for any Pearl HRP. */
export function encodeTaprootAddress(hrp, tweakedXOnly) {
  if (!(tweakedXOnly instanceof Uint8Array) || tweakedXOnly.length !== 32)
    throw new Error("program must be 32 bytes");
  const data5 = [1, ...P.convertBits([...tweakedXOnly], 8, 5, true)];
  const values = hrpExpand(hrp).concat(data5, [0, 0, 0, 0, 0, 0]);
  const mod = polymod(values) ^ BECH32M_CONST;
  const chk = [];
  for (let i = 0; i < 6; i++) chk.push((mod >>> (5 * (5 - i))) & 31);
  return hrp + "1" + data5.concat(chk).map((v) => CHARSET[v]).join("");
}

/**
 * Validate a user-entered recipient address for a network.
 * Returns { program } (32-byte tweaked x-only key). Throws with friendly errors.
 */
export function validateAddress(addr, network) {
  let d;
  try {
    d = P.decodeBech32m(addr);
  } catch (e) {
    throw new Error("Invalid address: " + e.message);
  }
  if (d.hrp !== network.hrp)
    throw new Error(
      `Wrong network: address is for '${d.hrp}', this wallet is on '${network.hrp}'`
    );
  return { program: d.program };
}

/* ---------------- keys ---------------- */

export function newMnemonic(strength = 128) {
  if (strength !== 128 && strength !== 256) throw new Error("strength must be 128 or 256");
  return generateMnemonic(wordlist, strength);
}

export function isValidMnemonic(mnemonic) {
  try {
    return validateMnemonic(String(mnemonic).trim().toLowerCase().replace(/\s+/g, " "), wordlist);
  } catch {
    return false;
  }
}

export function normalizeMnemonic(mnemonic) {
  return String(mnemonic).trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Derive a BIP-86 account key: m/86'/{coinType}'/0'/{chain}/{index}.
 * chain 0 = external (receive), 1 = internal (change).
 * Returns { priv, internalXOnly, tweakedX, address }.
 * passphrase is the optional BIP-39 passphrase ("" default).
 */
export function walletFromMnemonic(mnemonic, network, { index = 0, chain = 0, passphrase = "" } = {}) {
  const norm = normalizeMnemonic(mnemonic);
  if (!validateMnemonic(norm, wordlist)) throw new Error("Invalid recovery phrase");
  if (!Number.isInteger(index) || index < 0 || index > 0x7fffffff) throw new Error("bad index");
  if (chain !== 0 && chain !== 1) throw new Error("bad chain");
  const seed = mnemonicToSeedSync(norm, passphrase);
  try {
    const root = HDKey.fromMasterSeed(seed);
    const child = root.derive(`m/86'/${network.coinType}'/0'/${chain}/${index}`);
    if (!child.privateKey) throw new Error("derivation failed");
    return walletFromPriv(child.privateKey, network);
  } finally {
    seed.fill(0);
  }
}

export function walletFromPriv(priv, network) {
  const p = priv instanceof Uint8Array ? priv : hexToBytes(priv);
  if (p.length !== 32) throw new Error("private key must be 32 bytes");
  const internalXOnly = schnorr.getPublicKey(p);
  const { tweakedX } = P.tweakXOnlyPub(internalXOnly);
  return {
    priv: p,
    internalXOnly,
    tweakedX,
    address: encodeTaprootAddress(network.hrp, tweakedX),
    network,
  };
}

const b58check = createBase58check(sha256);

export function walletFromWIF(wif, network) {
  const raw = b58check.decode(String(wif).trim());
  if (raw.length < 33) throw new Error("Invalid WIF: bad payload length");
  if (raw[0] !== network.wifVersion)
    throw new Error(
      `Wrong network WIF (expected 0x${network.wifVersion.toString(16)}, got 0x${raw[0].toString(16)})`
    );
  let key = raw.slice(1);
  if (key.length === 33 && key[32] === 0x01) key = key.slice(0, 32);
  if (key.length !== 32) throw new Error("Invalid WIF: bad key length");
  return walletFromPriv(key, network);
}

export function privToWIF(priv, network) {
  const payload = new Uint8Array(34);
  payload[0] = network.wifVersion;
  payload.set(priv, 1);
  payload[33] = 0x01;
  return b58check.encode(payload);
}

function hexToBytes(hex) {
  const h = String(hex).replace(/^0x/, "");
  if (!/^[0-9a-fA-F]*$/.test(h) || h.length % 2) throw new Error("bad hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(b) {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/* ---------------- amounts ---------------- */

export function grainsToPRL(grains) {
  return Number(grains) / GRAIN_PER_PRL;
}

export function prlToGrains(prl) {
  const n = Number(prl);
  if (!Number.isFinite(n) || n < 0) throw new Error("bad amount");
  return Math.round(n * GRAIN_PER_PRL);
}

export function fmtPRL(grains, { trim = true } = {}) {
  const s = (Number(grains) / GRAIN_PER_PRL).toFixed(8);
  return (trim ? s.replace(/\.?0+$/, "") : s) || "0";
}

/* ---------------- fee estimation ---------------- */

/** vbytes via the audited pearl.js txVBytes (verified against wire format). */
export function estimateVBytes(nIn, nOut) {
  return P.txVBytes(nIn, nOut);
}

export function feeFor(nIn, nOut, grainsPerVByte) {
  return Math.ceil(estimateVBytes(nIn, nOut) * grainsPerVByte);
}

/* ---------------- coin selection ---------------- */
/**
 * Select UTXOs to cover targetGrains at feeRate grains/vB.
 * utxos: [{txid, vout, value}] (value in grains, number).
 * Strategy: largest-first accumulation with fee re-estimation; dust change is
 * folded into the fee (no uneconomic change output).
 * Returns { inputs, feeGrains, changeGrains, totalIn } or throws if insufficient.
 */
export function selectCoins(utxos, targetGrains, grainsPerVByte) {
  if (!Number.isSafeInteger(targetGrains) || targetGrains <= 0) throw new Error("bad target");
  if (!(grainsPerVByte > 0) || !Number.isFinite(grainsPerVByte)) throw new Error("bad fee rate");
  const sorted = [...utxos]
    .filter((u) => Number.isSafeInteger(u.value) && u.value > 0)
    .sort((a, b) => b.value - a.value);
  if (!sorted.length) throw new Error("No spendable funds");
  const inputs = [];
  let total = 0;
  for (const u of sorted) {
    inputs.push(u);
    total += u.value;
    const withChange = feeFor(inputs.length, 2, grainsPerVByte);
    if (total >= targetGrains + withChange) {
      let change = total - targetGrains - withChange;
      let fee = withChange;
      let nOut = 2;
      if (change > 0 && change < DUST_GRAIN) {
        // uneconomic change → drop the change output, fee absorbs it
        const noChange = feeFor(inputs.length, 1, grainsPerVByte);
        change = 0;
        fee = total - targetGrains; // == noChange + dust remainder; always >= noChange
        nOut = 1;
        if (fee < noChange) throw new Error("fee math error");
      }
      return { inputs, feeGrains: fee, changeGrains: change, totalIn: total, nOut };
    }
  }
  // not enough even ignoring change output
  const fee1 = feeFor(inputs.length, 1, grainsPerVByte);
  throw new Error(
    `Insufficient funds: need ${fmtPRL(targetGrains + fee1)} PRL (incl. fee), have ${fmtPRL(total)} PRL`
  );
}

/* ---------------- send transaction assembly ---------------- */
/**
 * Build + sign a P2TR keypath send.
 * opts: { utxos:[{txid,vout,value,priv,index}], recipientProgram (32B), amountGrains,
 *         changeAddress info {tweakedX}, feeRate }
 * Returns { txid, hex, feeGrains, changeGrains }.
 */
export function buildSendTx({ inputs, recipientProgram, amountGrains, changeTweakedX, feeRate }) {
  if (!(recipientProgram instanceof Uint8Array) || recipientProgram.length !== 32)
    throw new Error("bad recipient program");
  const sel = selectCoins(
    inputs.map((i) => ({ txid: i.txid, vout: i.vout, value: i.value })),
    amountGrains,
    feeRate
  );
  const byKey = new Map(inputs.map((i) => [i.txid + ":" + i.vout, i]));
  const txInputs = sel.inputs.map((u) => {
    const full = byKey.get(u.txid + ":" + u.vout);
    if (!full || !full.priv) throw new Error("missing private key for UTXO");
    return {
      txid: u.txid,
      vout: u.vout,
      value: u.value,
      priv: full.priv,
      xOnlyPub: full.internalXOnly,
    };
  });
  const outputs = [{ xOnlyPub: recipientProgram, value: amountGrains }];
  if (sel.changeGrains > 0) {
    if (!(changeTweakedX instanceof Uint8Array) || changeTweakedX.length !== 32)
      throw new Error("bad change key");
    outputs.push({ xOnlyPub: changeTweakedX, value: sel.changeGrains });
  }
  const built = P.buildTx(txInputs, outputs);
  return {
    txid: built.txid,
    hex: built.hex,
    feeGrains: sel.feeGrains,
    changeGrains: sel.changeGrains,
    nIn: txInputs.length,
    nOut: outputs.length,
  };
}

/* ---------------- blockbook client ---------------- */

function bbFetch(base) {
  const b = String(base).replace(/\/$/, "");
  if (!b) throw new Error("Blockbook URL not configured");
  return async (path, opts = {}) => {
    const r = await fetch(b + path, opts);
    if (!r.ok) {
      let detail = "";
      try {
        detail = JSON.stringify(await r.json()).slice(0, 200);
      } catch {
        try { detail = (await r.text()).slice(0, 200); } catch {}
      }
      throw new Error(`Blockbook ${path}: HTTP ${r.status} ${detail}`);
    }
    return r;
  };
}

/** Address info: { balance, unconfirmedBalance, txs[] } — values in grains (strings). */
export async function bbGetAddress(base, addr) {
  const f = bbFetch(base);
  const r = await f(`/api/v2/address/${addr}?details=txs`);
  return r.json();
}

export async function bbGetUtxos(base, addr) {
  const f = bbFetch(base);
  const r = await f(`/api/v2/utxo/${addr}`);
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error("unexpected UTXO response");
  return j
    .map((u) => ({
      txid: String(u.txid || "").toLowerCase(),
      vout: u.vout,
      value: Number(u.value),
      confirmations: u.confirmations ?? 0,
    }))
    .filter((u) => u.value > 0 && /^[0-9a-f]{64}$/.test(u.txid) && Number.isInteger(u.vout));
}

export async function bbGetTx(base, txid) {
  const f = bbFetch(base);
  const r = await f(`/api/v2/tx/${txid}`);
  return r.json();
}

/** Broadcast: POST {base}/api/sendtx/ with raw hex as text/plain. Returns txid. */
export async function bbBroadcast(base, hex) {
  const b = String(base).replace(/\/$/, "");
  if (!b) throw new Error("Blockbook URL not configured");
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2) throw new Error("bad tx hex");
  const r = await fetch(b + "/api/sendtx/", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: hex,
  });
  const text = await r.text();
  let j = {};
  try { j = JSON.parse(text); } catch {}
  if (!r.ok || j.error) throw new Error("Broadcast rejected: " + (j.error || `HTTP ${r.status}: ${text.slice(0, 160)}`));
  const txid = (j.result ?? j.txid ?? "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(txid)) throw new Error("Unexpected broadcast response: " + text.slice(0, 160));
  return txid;
}

/** Fee estimate: /api/v2/estimatefee/{blocks} returns PRL/kB → grains/vB. */
export async function bbEstimateFeeRate(base, blocks = 2) {
  const f = bbFetch(base);
  const r = await f(`/api/v2/estimatefee/${blocks}`);
  const j = await r.json();
  const perKB = Number(j.result ?? j);
  if (!Number.isFinite(perKB) || perKB <= 0) throw new Error("fee estimate unavailable");
  return (perKB * GRAIN_PER_PRL) / 1000;
}

export const explorerTx = (base, txid) => String(base).replace(/\/$/, "") + "/tx/" + txid;
export const explorerAddr = (base, addr) => String(base).replace(/\/$/, "") + "/address/" + addr;

/* ---------------- Pearlscriptions token balances ---------------- */
/** GET {indexer}/addresses/{addr}/balances → { address, prl, prls, tokens:{tick:amt} } */
export async function idxGetBalances(indexerBase, addr) {
  const b = String(indexerBase || "").replace(/\/$/, "");
  if (!b) return null;
  const r = await fetch(b + "/addresses/" + encodeURIComponent(addr) + "/balances", {
    headers: { Accept: "application/json" },
  });
  if (!r.ok) throw new Error(`indexer balances: HTTP ${r.status}`);
  return r.json();
}

/** GET {indexer}/tokens → { tokens:[{ticker, dec, ...}] } for decimal lookup. */
export async function idxGetTokens(indexerBase) {
  const b = String(indexerBase || "").replace(/\/$/, "");
  if (!b) return [];
  const r = await fetch(b + "/tokens", { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`indexer tokens: HTTP ${r.status}`);
  const j = await r.json();
  return j.tokens ?? j ?? [];
}

/* ---------------- fiat rate ---------------- */

const COINGECKO_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=pearl-2&vs_currencies=usd&include_24hr_change=true";
const FIAT_SYMBOLS = { USD: "$", EUR: "€", GBP: "£" };
const FX_RATES = { USD: 1, EUR: 0.92, GBP: 0.79 }; // labeled estimates, refreshed never — USD is live

export async function fetchPrlUsd() {
  const r = await fetch(COINGECKO_URL, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`CoinGecko: HTTP ${r.status}`);
  const j = await r.json();
  const usd = Number(j?.["pearl-2"]?.usd);
  if (!Number.isFinite(usd) || usd <= 0) throw new Error("CoinGecko: bad price payload");
  return { usd, at: Date.now(), source: "coingecko" };
}

export function fmtFiat(usdPerPrl, grains, currency = "USD") {
  const fx = FX_RATES[currency] ?? 1;
  const sym = FIAT_SYMBOLS[currency] ?? "$";
  const v = grainsToPRL(grains) * usdPerPrl * fx;
  return sym + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/* ---------------- encrypted vault (AES-GCM, MetaMask/Phantom pattern) ---------------- */

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const ub64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveVaultKey(password, salt, iterations) {
  const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/** Seal a mnemonic into an encrypted backup blob. Password never stored. */
export async function vaultSeal(mnemonic, password) {
  password = String(password).normalize("NFKC");
  if (password.length < 8) throw new Error("Password must be at least 8 characters");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveVaultKey(password, salt, 600_000);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(mnemonic)));
  return {
    v: 1,
    app: "pearl-wallet-pwa",
    kdf: "PBKDF2-SHA256",
    iter: 600000,
    salt: b64(salt),
    iv: b64(iv),
    ct: b64(ct),
  };
}

/** Unseal; throws on wrong password (GCM auth tag). */
export async function vaultUnseal(vault, password) {
  if (!vault || vault.v !== 1) throw new Error("Unknown backup version");
  password = String(password).normalize("NFKC");
  const key = await deriveVaultKey(password, ub64(vault.salt), vault.iter);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: ub64(vault.iv) }, key, ub64(vault.ct));
  return dec.decode(pt);
}

/* ---------------- gap-limit helpers ---------------- */

/** Derive receive addresses up to `limit` and return [{index, address, ...keys}]. */
export function deriveReceiveSet(mnemonic, network, { start = 0, count = 20, chain = 0, passphrase = "" } = {}) {
  const norm = normalizeMnemonic(mnemonic);
  if (!validateMnemonic(norm, wordlist)) throw new Error("Invalid recovery phrase");
  if (chain !== 0 && chain !== 1) throw new Error("bad chain");
  const seed = mnemonicToSeedSync(norm, passphrase);
  try {
    const root = HDKey.fromMasterSeed(seed);
    const out = [];
    for (let i = start; i < start + count; i++) {
      const child = root.derive(`m/86'/${network.coinType}'/0'/${chain}/${i}`);
      out.push({ index: i, chain, ...walletFromPriv(child.privateKey, network) });
    }
    return out;
  } finally {
    seed.fill(0);
  }
}

export { P as pearlAudited };
