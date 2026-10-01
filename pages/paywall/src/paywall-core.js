/* Pearl Paywall core — content paywall desk for PRL. No accounts, no Stripe,
 * no server: a creator seals a tamper-evident paywall descriptor, buyers pay
 * the exact PRL price on-chain, then mint a Schnorr-signed access token with
 * the funding key. A standalone verifier (page tab or dependency-free embed
 * snippet) re-checks payment + signature against public Blockbook data.
 *
 * Pure ESM, zero build step for developers. The browser ships a committed
 * esbuild IIFE bundle (pearl-paywall.bundle.js); node runs this file directly
 * for the verification suite.
 *
 * Crypto lineage (NO new cryptography in the desk):
 *  - Descriptor hash: SHA-256 over canonical JSON (noble, audited).
 *  - Address validation: bech32m decode (audited sign/src/crypto.js).
 *  - Key import: WIF / hex / BIP-39 mnemonic -> BIP-86 wallet
 *    (audited walletFromWIF / walletFromPriv / walletFromMnemonic).
 *  - Token: BIP-340 Schnorr signature (audited noble schnorr) over
 *    SHA-256("PearlPaywallToken/v1" || descriptor || pubkey || txid), signed
 *    with the TWEAKED keypath key (tweakPrivKeypath, audited) so the token's
 *    x-only pubkey is exactly the P2TR program of the funding input address.
 *  - Amounts: grain-exact via parsePRL/fmtPRL (audited).
 *  - The ONLY minimized re-implementation is inside the creator embed snippet
 *    (src/snippet-crypto.js: sha256, bech32m-decode, BIP-340 verify), because
 *    the snippet must be dependency-free. The test suite differentially
 *    checks those three functions against the audited implementations on
 *    randomized inputs plus pinned vectors, and asserts the shipped snippet
 *    text inlines them verbatim.
 *
 * Protocol facts (verified, not from memory):
 *  - 1 PRL = 1e8 grains, P2TR dust 546 grains, bech32m HRPs prl/tprl:
 *    sign/src/crypto.js (from node/chaincfg + upstream txrules).
 *  - Blockbook mainnet: https://blockbook.pearlresearch.ai (verified live
 *    2026-09-26); GET-only reads, same as the invoice desk.
 */

import {
  sha256, bytesToHex, hexToBytes,
  encodeBech32m, decodeBech32m,
  walletFromMnemonic, walletFromWIF, walletFromPriv,
  tweakKeypath, tweakPrivKeypath,
  GRAIN_PER_PRL, DUST_GRAIN, NETWORKS,
  schnorr,
} from "../../sign/src/crypto.js";
import { utf8ToBytes } from "@noble/hashes/utils";
import { parsePRL, fmtPRL } from "../../sign/src/sign-core.js";
import { snipSha256Bytes, snipBech32mDecode, snipSchnorrVerify } from "./snippet-crypto.js";

export {
  GRAIN_PER_PRL, DUST_GRAIN, NETWORKS,
  walletFromMnemonic, walletFromWIF, walletFromPriv,
  tweakKeypath, tweakPrivKeypath,
  parsePRL, fmtPRL, sha256, bytesToHex, hexToBytes, utf8ToBytes,
  encodeBech32m, decodeBech32m, schnorr,
  snipSha256Bytes, snipBech32mDecode, snipSchnorrVerify,
};

export const PAYWALL_VERSION = 1;
export const TOKEN_DOMAIN = "PearlPaywallToken/v1";
export const MAX_PRICE_PRL = 21_000_000; // sanity cap, whole supply
export const DEFAULT_BLOCKBOOK = "https://blockbook.pearlresearch.ai";

const HEX64 = /^[0-9a-fA-F]{64}$/;
const HEX128 = /^[0-9a-fA-F]{128}$/;

export function networkForHrp(hrp) {
  if (hrp === "prl") return NETWORKS.mainnet;
  if (hrp === "tprl") return NETWORKS.testnet;
  throw new Error(`unsupported hrp "${hrp}" (want prl or tprl)`);
}

/* ---------------- paywall spec ---------------- */

/**
 * Validate creator input into a normalized spec.
 * {title, pricePRL (decimal string), address (prl1…), deliverable, expiry
 *  ("" or YYYY-MM-DD, must be future), hrp}
 */
export function validatePaywallSpec(input) {
  const title = String(input.title ?? "").trim();
  if (title.length < 1 || title.length > 120) throw new Error("title must be 1–120 characters");
  const priceGrains = parsePRL(String(input.pricePRL ?? "").trim()); // throws on bad input
  if (priceGrains <= 0n) throw new Error("price must be positive");
  if (priceGrains > BigInt(MAX_PRICE_PRL) * BigInt(GRAIN_PER_PRL)) {
    throw new Error(`price exceeds sanity cap of ${MAX_PRICE_PRL} PRL`);
  }
  const hrp = String(input.hrp ?? "prl").trim();
  const network = networkForHrp(hrp);
  const address = String(input.address ?? "").trim();
  let decoded;
  try {
    decoded = decodeBech32m(address, hrp);
  } catch (e) {
    throw new Error(`receiving address invalid for ${hrp}: ${e.message}`);
  }
  if (decoded.version !== 1 || decoded.program.length !== 32) {
    throw new Error("receiving address must be a P2TR (witness v1, 32-byte program) address");
  }
  const deliverable = String(input.deliverable ?? "").trim();
  if (deliverable.length < 1 || deliverable.length > 500) {
    throw new Error("deliverable description must be 1–500 characters");
  }
  let expiry = null;
  const expRaw = String(input.expiry ?? "").trim();
  if (expRaw !== "") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expRaw)) throw new Error("expiry must be YYYY-MM-DD or empty");
    const d = new Date(expRaw + "T00:00:00Z");
    if (Number.isNaN(d.getTime())) throw new Error("expiry is not a real date");
    // round-trip guard: 2026-02-30 must not silently become 2026-03-02
    if (d.toISOString().slice(0, 10) !== expRaw) throw new Error("expiry is not a real date");
    if (d.getTime() <= Date.now()) throw new Error("expiry must be in the future");
    expiry = expRaw;
  }
  return { v: PAYWALL_VERSION, title, priceGrains, address, deliverable, expiry, hrp, network };
}

/** Canonical JSON — fixed key order, the commitment the descriptor hashes. */
export function canonicalPaywallJSON(spec) {
  const o = {
    v: PAYWALL_VERSION,
    title: spec.title,
    priceGrains: String(spec.priceGrains),
    address: spec.address,
    deliverable: spec.deliverable,
    expiry: spec.expiry ?? null,
    hrp: spec.hrp,
  };
  return JSON.stringify(o);
}

export function descriptorHashHex(canonical) {
  return bytesToHex(sha256(utf8ToBytes(canonical)));
}

export function paywallDescriptor(hrp, hashHex) {
  return `pearl-paywall:v${PAYWALL_VERSION}:${hrp}:${hashHex.toLowerCase()}`;
}

export function sealPaywall(spec) {
  const canonical = canonicalPaywallJSON(spec);
  const hash = descriptorHashHex(canonical);
  return { canonical, hash, descriptor: paywallDescriptor(spec.hrp, hash) };
}

export function parseDescriptor(desc) {
  const m = /^pearl-paywall:v1:(prl|tprl):([0-9a-fA-F]{64})$/.exec(String(desc ?? "").trim());
  if (!m) throw new Error('descriptor must look like pearl-paywall:v1:<prl|tprl>:<64 hex>');
  return { hrp: m[1], hash: m[2].toLowerCase() };
}

/** BIP-21 style pearl: URI with the exact price. */
export function paymentURI(address, priceGrains) {
  return `pearl:${address}?amount=${fmtPRL(BigInt(priceGrains))}`;
}

/* ---------------- Blockbook (GET-only) ---------------- */

export function normalizeBlockbookBase(s) {
  const t = String(s ?? "").trim().replace(/\/$/, "");
  if (!/^https?:\/\//.test(t)) throw new Error("Blockbook URL must start with http(s)://");
  return t;
}

async function bbGet(fetcher, url) {
  let res;
  try {
    res = await fetcher(url);
  } catch (e) {
    throw new Error(`blockbook unreachable: ${e.message}`);
  }
  if (!res.ok) {
    if (res.status === 404) throw new Error(`blockbook 404 — not found: ${url}`);
    throw new Error(`blockbook ${res.status} on ${url}`);
  }
  return JSON.parse(await res.text());
}

export async function fetchTx(fetcher, blockbookBase, txid) {
  const id = String(txid ?? "").trim().toLowerCase();
  if (!HEX64.test(id)) throw new Error("txid must be 64 hex chars");
  const base = normalizeBlockbookBase(blockbookBase);
  return bbGet(fetcher, `${base}/api/v2/tx/${id}`);
}

/** Recent transactions touching an address (GET-only). */
export async function fetchAddressTxs(fetcher, blockbookBase, address, pageSize = 25) {
  const base = normalizeBlockbookBase(blockbookBase);
  const data = await bbGet(
    fetcher,
    `${base}/api/v2/address/${encodeURIComponent(address)}?details=txs&pageSize=${pageSize}`
  );
  return Array.isArray(data.txs) ? data.txs : [];
}

function voutAddresses(o) {
  const out = [];
  for (const a of o.addresses || []) out.push(String(a));
  const spk = o.scriptPubKey || {};
  for (const a of spk.addresses || []) out.push(String(a));
  return out;
}

/** Grain-exact payment analysis of ONE tx against the paywall address+price. */
export function analyzePayment(tx, address, priceGrains) {
  const addr = String(address).toLowerCase();
  const price = BigInt(priceGrains);
  let paid = 0n;
  for (const o of tx.vout || []) {
    if (voutAddresses(o).map((a) => a.toLowerCase()).includes(addr)) {
      paid += BigInt(String(o.value));
    }
  }
  const confirmations = Number(tx.confirmations ?? 0);
  return {
    txid: String(tx.txid || "").toLowerCase(),
    paid: paid >= price,
    paidGrains: paid,
    priceGrains: price,
    confirmations,
    unconfirmed: confirmations <= 0,
    overpaidGrains: paid > price ? paid - price : 0n,
    shortfallGrains: paid < price ? price - paid : 0n,
  };
}

/** P2TR input address programs of a tx (hex set), for token key matching. */
export function txInputPrograms(tx, hrp) {
  const programs = new Set();
  for (const vin of tx.vin || []) {
    for (const a of vin.addresses || []) {
      try {
        const d = decodeBech32m(String(a), hrp);
        if (d.version === 1 && d.program.length === 32) programs.add(bytesToHex(d.program));
      } catch { /* non-P2TR input — cannot mint against it */ }
    }
  }
  return programs;
}

/* ---------------- access tokens ---------------- */

/** Digest the token signature covers. All fields are ASCII. */
export function tokenDigestPreimage(descriptor, pubkeyHex, txid) {
  return `${TOKEN_DOMAIN}\n${descriptor}\n${pubkeyHex.toLowerCase()}\n${txid.toLowerCase()}`;
}

export function tokenDigest(descriptor, pubkeyHex, txid) {
  return sha256(utf8ToBytes(tokenDigestPreimage(descriptor, pubkeyHex, txid)));
}

/** Accept a funding key as WIF, 64-hex privkey, or 12/24-word mnemonic. */
export function walletFromKeyInput(input, network) {
  const t = String(input ?? "").trim();
  if (!t) throw new Error("funding key is empty");
  if (/^[0-9a-fA-F]{64}$/.test(t)) return { wallet: walletFromPriv(hexToBytes(t.toLowerCase()), network), source: "hex private key" };
  const words = t.split(/\s+/);
  if (words.length === 12 || words.length === 24) {
    return { wallet: walletFromMnemonic(t, network), network, source: "mnemonic (BIP-86 m/86'/coin'/0'/0/0)" };
  }
  try {
    return { wallet: walletFromWIF(t, network), source: "WIF" };
  } catch {
    throw new Error("funding key must be WIF, 64-hex private key, or a 12/24-word mnemonic");
  }
}

/**
 * Mint an access token. The funding key's TWEAKED keypath key must control one
 * of the paying tx's P2TR input addresses — otherwise LOUD refusal.
 * Returns {token, pubkeyHex, source}. Never persists the key.
 */
export async function mintToken({ descriptor, txid, keyInput, blockbookBase, fetcher, auxRand }) {
  const desc = parseDescriptor(descriptor); // throws on malformed
  const network = networkForHrp(desc.hrp);
  const { wallet, source } = walletFromKeyInput(keyInput, network);
  const tweakedX = tweakKeypath(wallet.internalXOnly).tweakedX;
  const pubkeyHex = bytesToHex(tweakedX);
  const tx = await fetchTx(fetcher, blockbookBase, txid);
  const programs = txInputPrograms(tx, desc.hrp);
  if (!programs.has(pubkeyHex)) {
    throw new Error(
      "KEY REFUSED — the funding key you entered does not control any P2TR input address of " +
      `this payment (derived ${pubkeyHex.slice(0, 16)}…; ${programs.size} P2TR input address(es) ` +
      "seen on the tx). The token signature must verify against an input address of the paying " +
      "txid: enter the key that funded the payment, as WIF, hex, or mnemonic."
    );
  }
  const digest = tokenDigest(descriptor.trim(), pubkeyHex, tx.txid || txid);
  const dTweak = tweakPrivKeypath(wallet.priv, wallet.internalXOnly);
  const sig = schnorr.sign(digest, dTweak, auxRand ?? undefined);
  const token = {
    v: 1,
    descriptor: descriptor.trim(),
    pubkey: pubkeyHex,
    txid: String(tx.txid || txid).toLowerCase(),
    sig: bytesToHex(sig),
  };
  return { token, pubkeyHex, source };
}

/** Shape-check a pasted token. */
export function parseToken(raw) {
  let t;
  try {
    t = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    throw new Error("token is not valid JSON");
  }
  if (!t || typeof t !== "object") throw new Error("token must be a JSON object");
  if (t.v !== 1) throw new Error("unsupported token version (want v:1)");
  parseDescriptor(t.descriptor); // throws on malformed
  if (!HEX64.test(String(t.pubkey || ""))) throw new Error("token pubkey must be 64 hex chars");
  if (!HEX64.test(String(t.txid || ""))) throw new Error("token txid must be 64 hex chars");
  if (!HEX128.test(String(t.sig || ""))) throw new Error("token sig must be 128 hex chars");
  return {
    v: 1,
    descriptor: String(t.descriptor).trim(),
    pubkey: String(t.pubkey).toLowerCase(),
    txid: String(t.txid).toLowerCase(),
    sig: String(t.sig).toLowerCase(),
  };
}

/**
 * Standalone verifier. Recomputes the descriptor from the canonical paywall
 * JSON, fetches the paying tx from Blockbook, confirms it paid >= price to the
 * paywall address, confirms the token pubkey is a paying input address, and
 * re-verifies the BIP-340 signature. Returns {proven, reasons[]}.
 */
export async function verifyToken({ descriptor, canonical, token: tokenRaw, blockbookBase, fetcher, nowMs }) {
  const reasons = [];
  const fail = (r) => ({ proven: false, reasons: [...reasons, r] });
  let tok;
  try {
    tok = parseToken(tokenRaw);
  } catch (e) {
    return fail(`token rejected: ${e.message}`);
  }
  let desc;
  try {
    desc = parseDescriptor(descriptor);
  } catch (e) {
    return fail(`descriptor rejected: ${e.message}`);
  }
  if (tok.descriptor !== descriptor.trim()) {
    return fail("token is bound to a different paywall descriptor");
  }
  // descriptor must recompute from the canonical paywall JSON
  let spec;
  try {
    const parsed = JSON.parse(canonical);
    spec = validatePaywallSpec({
      title: parsed.title,
      pricePRL: fmtPRL(BigInt(parsed.priceGrains)),
      address: parsed.address,
      deliverable: parsed.deliverable,
      expiry: parsed.expiry ?? "",
      hrp: parsed.hrp,
    });
    // expiry was validated as future at creation; re-check against now for old paywalls
    if (spec.expiry && new Date(spec.expiry + "T00:00:00Z").getTime() <= (nowMs ?? Date.now())) {
      return fail(`paywall expired on ${spec.expiry}`);
    }
  } catch (e) {
    return fail(`canonical paywall JSON rejected: ${e.message}`);
  }
  const recomputed = paywallDescriptor(spec.hrp, descriptorHashHex(canonicalPaywallJSON(spec)));
  if (recomputed !== descriptor.trim()) {
    return fail("descriptor does NOT match the canonical paywall JSON (tampered or mismatched)");
  }
  let tx;
  try {
    tx = await fetchTx(fetcher, blockbookBase, tok.txid);
  } catch (e) {
    return fail(`payment lookup failed: ${e.message}`);
  }
  const pay = analyzePayment(tx, spec.address, spec.priceGrains);
  if (!pay.paid) {
    return fail(
      `payment insufficient: tx paid ${fmtPRL(pay.paidGrains)} PRL to the paywall address, ` +
      `price is ${fmtPRL(pay.priceGrains)} PRL (shortfall ${fmtPRL(pay.shortfallGrains)} PRL)`
    );
  }
  reasons.push(`payment confirmed: ${fmtPRL(pay.paidGrains)} PRL to the paywall address in ${pay.txid.slice(0, 12)}… (${pay.confirmations} confirmation(s))`);
  if (pay.unconfirmed) reasons.push("note: payment is unconfirmed (0-conf) — treat as provisional");
  const programs = txInputPrograms(tx, spec.hrp);
  if (!programs.has(tok.pubkey)) {
    return fail("token pubkey is not among the paying transaction's P2TR input addresses");
  }
  reasons.push("token pubkey matches a P2TR input address of the paying transaction");
  const digest = tokenDigest(tok.descriptor, tok.pubkey, tok.txid);
  let sigOk = false;
  try {
    sigOk = schnorr.verify(hexToBytes(tok.sig), digest, hexToBytes(tok.pubkey));
  } catch {
    sigOk = false;
  }
  if (!sigOk) return fail("BIP-340 signature does NOT verify — token is forged or tampered");
  reasons.push("BIP-340 signature verifies against the token pubkey");
  return { proven: true, reasons };
}

/* ---------------- creator embed snippet ---------------- */

/**
 * Build the dependency-free creator embed snippet. The snippet inlines the
 * three snippet-crypto primitives VERBATIM via fn.toString() — the test suite
 * asserts the inlined source round-trips (evaluates cleanly and passes the
 * differential vectors).
 */
export function buildEmbedSnippet(config) {
  const cfg = {
    descriptor: String(config.descriptor || ""),
    address: String(config.address || ""),
    priceGrains: String(config.priceGrains || "0"),
    expiry: config.expiry ?? null,
    blockbook: normalizeBlockbookBase(config.blockbook || DEFAULT_BLOCKBOOK),
    contentId: String(config.contentId || "pw-content"),
    tokenInputId: String(config.tokenInputId || "pw-token"),
    verifyButtonId: String(config.verifyButtonId || "pw-verify"),
    resultId: String(config.resultId || "pw-result"),
  };
  if (!cfg.descriptor || !cfg.address) throw new Error("snippet config needs descriptor + address");
  const inline = (fn, name) => `var ${name} = ${fn.toString()};`;
  return `<script>
/* Pearl Paywall gate v1 — paste this snippet where your locked content lives.
 * Dependency-free: no external scripts, no build step. It fetches the token's
 * payment from public Blockbook, confirms it paid >= price to your paywall
 * address, confirms the token key is a paying input address, and verifies the
 * BIP-340 signature — then reveals your content. HONEST LIMITS: this is
 * snippet-level protection (view-source can find the hidden markup), strong
 * for soft/manual delivery (email lists, download links, community access),
 * not DRM. Keep this config as private as your use allows.
 * Built with the Pearl Paywall desk · @kshot9000 */
(function () {
  "use strict";
  var CONFIG = ${JSON.stringify(cfg)};
  ${inline(snipSha256Bytes, "snipSha256Bytes")}
  ${inline(snipBech32mDecode, "snipBech32mDecode")}
  ${inline(snipSchnorrVerify, "snipSchnorrVerify")}
  var TOKEN_DOMAIN = ${JSON.stringify(TOKEN_DOMAIN)};
  function h2b(hex) {
    var b = [], i;
    for (i = 0; i < hex.length; i += 2) b.push(parseInt(hex.slice(i, i + 2), 16));
    return b;
  }
  function b2h(bytes) {
    var s = "", i;
    for (i = 0; i < bytes.length; i++) s += ("0" + (bytes[i] & 255).toString(16)).slice(-2);
    return s;
  }
  function utf8Bytes(str) {
    var b = [], i, c;
    for (i = 0; i < str.length; i++) {
      c = str.charCodeAt(i);
      if (c < 128) b.push(c);
      else if (c < 2048) b.push(192 | (c >> 6), 128 | (c & 63));
      else b.push(224 | (c >> 12), 128 | ((c >> 6) & 63), 128 | (c & 63));
    }
    return b;
  }
  function tokenDigestHex(descriptor, pubkey, txid) {
    var pre = TOKEN_DOMAIN + "\\n" + descriptor + "\\n" + pubkey.toLowerCase() + "\\n" + txid.toLowerCase();
    return b2h(snipSha256Bytes(utf8Bytes(pre)));
  }
  function inputPrograms(tx, hrp) {
    var set = {}, i, j, a, d;
    for (i = 0; i < (tx.vin || []).length; i++) {
      for (j = 0; j < ((tx.vin[i] || {}).addresses || []).length; j++) {
        a = tx.vin[i].addresses[j];
        try {
          d = snipBech32mDecode(a);
          if (d.hrp === hrp && d.version === 1 && d.program.length === 32) set[b2h(d.program)] = 1;
        } catch (e) { /* non-P2TR input */ }
      }
    }
    return set;
  }
  function paidToAddress(tx, address, priceGrains) {
    var addr = String(address).toLowerCase(), paid = 0n, i, o, addrs, k;
    for (i = 0; i < (tx.vout || []).length; i++) {
      o = tx.vout[i] || {}; addrs = [];
      for (k = 0; k < (o.addresses || []).length; k++) addrs.push(String(o.addresses[k]).toLowerCase());
      var spk = o.scriptPubKey || {};
      for (k = 0; k < (spk.addresses || []).length; k++) addrs.push(String(spk.addresses[k]).toLowerCase());
      if (addrs.indexOf(addr) !== -1) paid += BigInt(String(o.value));
    }
    return paid >= BigInt(priceGrains) ? paid : null;
  }
  async function verifyToken(tokenText) {
    function fail(reason) { return { ok: false, reason: reason }; }
    var tok;
    try { tok = JSON.parse(tokenText); } catch (e) { return fail("token is not valid JSON"); }
    if (!tok || tok.v !== 1 || !tok.descriptor || !tok.pubkey || !tok.txid || !tok.sig) {
      return fail("token is malformed");
    }
    if (tok.descriptor !== CONFIG.descriptor) return fail("token is for a different paywall");
    if (CONFIG.expiry && Date.now() > new Date(CONFIG.expiry + "T00:00:00Z").getTime()) {
      return fail("this paywall expired on " + CONFIG.expiry);
    }
    var txid = String(tok.txid).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(txid)) return fail("token txid malformed");
    var res;
    try {
      res = await fetch(CONFIG.blockbook + "/api/v2/tx/" + txid);
    } catch (e) { return fail("blockbook unreachable: " + e.message); }
    if (!res.ok) return fail("payment not found on blockbook (status " + res.status + ")");
    var tx = await res.json();
    var paid = paidToAddress(tx, CONFIG.address, CONFIG.priceGrains);
    if (paid === null) return fail("that payment did not pay the price to this paywall address");
    var descM = /^pearl-paywall:v1:(prl|tprl):[0-9a-f]{64}$/.exec(CONFIG.descriptor);
    if (!descM) return fail("snippet config descriptor malformed");
    if (!inputPrograms(tx, descM[1])[String(tok.pubkey).toLowerCase()]) {
      return fail("token key is not an input address of the paying transaction");
    }
    var digest = h2b(tokenDigestHex(tok.descriptor, String(tok.pubkey), txid));
    var ok = snipSchnorrVerify(h2b(String(tok.sig)), digest, h2b(String(tok.pubkey)), snipSha256Bytes);
    if (!ok) return fail("token signature does not verify");
    return { ok: true, reason: "payment + signature verified", txid: txid };
  }
  function showResult(msg, good) {
    var r = document.getElementById(CONFIG.resultId);
    if (r) { r.textContent = msg; r.setAttribute("data-ok", good ? "1" : "0"); }
  }
  async function gate() {
    var input = document.getElementById(CONFIG.tokenInputId);
    var tokenText = input && "value" in input ? input.value : (input ? input.textContent : "");
    showResult("verifying…", true);
    var r = await verifyToken(tokenText || "");
    if (r.ok) {
      var c = document.getElementById(CONFIG.contentId);
      if (c) c.style.display = "";
      showResult("access granted — payment + signature verified.", true);
    } else {
      showResult("access denied: " + r.reason, false);
    }
    return r;
  }
  var btn = document.getElementById(CONFIG.verifyButtonId);
  if (btn) btn.addEventListener("click", gate);
  window.PearlPaywallGate = { verifyToken: verifyToken, gate: gate, CONFIG: CONFIG };
})();
</script>`;
}

