/* Pearl Vanity core — in-browser PRL Taproot vanity address grinding.
 *
 * Pure ESM. The browser ships committed esbuild IIFE bundles
 * (pearl-vanity.bundle.js for the page, pearl-vanity-grind.bundle.js +
 * grind-worker.js for the Web Worker pool); node runs this file directly
 * for the verification suite.
 *
 * Model: a vanity address IS the x-only public key — address =
 * bech32m(hrp, v1, xonly(priv)). No TapTweak, no script: the private key
 * signs keypath Schnorr spends directly (SIGHASH_DEFAULT). This is the
 * standard vanity model (cf. Bitcoin vanity P2PKH): whoever holds the
 * 32-byte secret controls the coins, full stop.
 *
 * Two grind modes:
 *   - "random": each attempt draws a fresh 32-byte secret from the caller's
 *     RNG (browser: crypto.getRandomValues). The found key is NOT part of
 *     any seed — back it up or lose the coins.
 *   - "bip86": attempts walk m/86'/coinType'/account'/0/index derived from
 *     a caller-supplied seed (BIP-39). The found key IS recoverable from the
 *     seed + account + index, which the result panel reports.
 *
 * Crypto lineage: secp256k1 / bech32m / WIF reuse the audited Pearl Sign
 * core (../../sign/src/crypto.js), itself verified byte-for-byte against
 * Pearl's Go reference (node/txscript). No new cryptography is introduced
 * here — only key generation loops and prefix matching.
 */

import {
  encodeBech32m,
  decodeBech32m,
  walletToWIF,
  NETWORKS,
  bytesToHex,
  hexToBytes,
  schnorr,
} from "../../sign/src/crypto.js";
import { HDKey } from "@scure/bip32";
import { generateMnemonic, validateMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist as englishWordlist } from "@scure/bip39/wordlists/english";
import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesToNumberBE } from "@noble/curves/abstract/utils";

export { NETWORKS, bytesToHex, hexToBytes, schnorr };

/* ---------------- prefix ---------------- */

// bech32 data charset (BIP-173): 32 chars; excludes 1 b i o.
export const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
export const MAX_PREFIX_LEN = 5; // 32^5 = 33.5M expected attempts; beyond this is not a browser job
export const MIN_PREFIX_LEN = 1;

/** Normalize + validate a user-typed prefix (the part after "prl1p").
 *  Returns { prefix } or { error }. */
export function normalizePrefix(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  if (s.length < MIN_PREFIX_LEN) return { error: `Type at least ${MIN_PREFIX_LEN} character.` };
  if (s.length > MAX_PREFIX_LEN)
    return { error: `Keep it to ${MAX_PREFIX_LEN} characters — 32^${s.length} combinations is not a browser job.` };
  for (const ch of s) {
    if (!BECH32_CHARSET.includes(ch)) {
      const hint =
        ch === "1"
          ? " — '1' is the bech32 separator and can never appear in the data part"
          : "bii o".includes(ch) && "bio".includes(ch)
            ? " — bech32 drops b, i, o to avoid look-alikes"
            : "";
      return { error: `Character '${ch}' is not in the bech32 alphabet${hint}.` };
    }
  }
  return { prefix: s };
}

/** Expected number of attempts to hit a prefix of length n: 32^n (BigInt). */
export function expectedAttempts(prefixLen) {
  return 32n ** BigInt(prefixLen);
}

/** Probability of having found it after k attempts (BigInt-safe). */
export function hitProbability(attempts, prefixLen) {
  const p = 1 / Number(expectedAttempts(prefixLen));
  const k = Number(attempts);
  if (!Number.isFinite(k) || k < 0) return 0;
  return 1 - Math.exp(-k * p); // Poisson approximation, accurate for tiny p
}

export function formatBig(n) {
  const s = n.toString();
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return "—";
  if (seconds < 1) return "< 1 second";
  const units = [
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
    ["second", 1],
  ];
  const parts = [];
  let rem = Math.floor(seconds);
  for (const [name, size] of units) {
    const v = Math.floor(rem / size);
    if (v > 0) { parts.push(`${v} ${name}${v > 1 ? "s" : ""}`); rem -= v * size; }
    if (parts.length === 2) break;
  }
  return parts.join(" ") || "< 1 second";
}

/* ---------------- keys ---------------- */

/** Draw a uniform secret scalar in [1, n-1] from rng(nBytes)->Uint8Array. */
export function randomScalar(rng) {
  const n = secp256k1.CURVE.n;
  for (;;) {
    const b = rng(32);
    if (!(b instanceof Uint8Array) || b.length !== 32) throw new Error("rng must return 32 bytes");
    let zero = true;
    for (let i = 0; i < 32; i++) if (b[i] !== 0) { zero = false; break; }
    if (zero) continue;
    if (bytesToNumberBE(b) >= n) continue;
    return b;
  }
}

/** Vanity wallet from a 32-byte secret: address = bech32m(hrp, v1, xonly).
 *  No tweak — the secret IS the keypath spend key. */
export function vanityFromPriv(priv, network) {
  const p = priv instanceof Uint8Array ? priv : hexToBytes(priv);
  if (p.length !== 32) throw new Error("private key must be 32 bytes");
  const xonly = schnorr.getPublicKey(p); // 32-byte x-only, throws on invalid scalar
  return {
    priv: p,
    xonly,
    address: encodeBech32m(network.hrp, 1, xonly),
    network,
  };
}

export function vanityToWIF(priv, network) {
  const p = priv instanceof Uint8Array ? priv : hexToBytes(priv);
  return walletToWIF(p, network);
}

export function vanityFromWIF(wif, network) {
  // WIF here wraps the RAW spend secret (no tweak), unlike BIP-86 wallets.
  return vanityFromPriv(decodeRawWIF(wif, network), network);
}

// base58check decode (same construction walletFromWIF in the Sign core uses)
import { createBase58check } from "@scure/base";
import { sha256 } from "@noble/hashes/sha256";
function decodeRawWIF(wif, network) {
  const b58check = createBase58check(sha256);
  const raw = b58check.decode(String(wif).trim());
  if (raw.length < 33) throw new Error("invalid WIF payload length");
  if (raw[0] !== network.wifVersion) throw new Error("wrong WIF network version");
  let key = raw.slice(1);
  if (key.length === 33 && key[32] === 0x01) key = key.slice(0, 32);
  if (key.length !== 32) throw new Error("invalid WIF key length");
  return key;
}

/** Validate a BIP-39 mnemonic and return the 64-byte seed. Throws on invalid. */
export function seedFromMnemonic(mnemonic) {
  const words = String(mnemonic ?? "").trim().split(/\s+/);
  if (words.length !== 12 && words.length !== 24) throw new Error("Enter a 12- or 24-word BIP-39 mnemonic.");
  if (!validateMnemonic(words.join(" "), englishWordlist)) throw new Error("Mnemonic failed checksum validation — check the words.");
  return mnemonicToSeedSync(words.join(" "));
}

/** Generate a fresh 12-word mnemonic (for users without a seed). */
export function newVanityMnemonic() {
  return generateMnemonic(englishWordlist, 128);
}

/** Cacheable BIP-86 account node: m/86'/coinType'/account' (hardened part done once). */
export function bip86AccountNode(seedBytes, network, account) {
  if (!Number.isInteger(account) || account < 0 || account > 0x7fffffff) throw new Error("bad account");
  const root = HDKey.fromMasterSeed(seedBytes);
  return {
    node: root.derive(`m/86'/${network.coinType}'/${account}'`),
    account,
    network,
  };
}

/** Child secret at m/86'/coinType'/account'/0/index (non-hardened, cheap). */
export function bip86ChildPriv(accountNode, index) {
  if (!Number.isInteger(index) || index < 0 || index > 0x7fffffff) throw new Error("bad index");
  const child = accountNode.node.deriveChild(0).deriveChild(index);
  if (!child.privateKey) throw new Error("derivation failed");
  return { priv: child.privateKey, path: `m/86'/${accountNode.network.coinType}'/${accountNode.account}'/0/${index}` };
}

export function fullTarget(networkId, prefix) {
  const hrp = NETWORKS[networkId].hrp;
  return `${hrp}1p${prefix}`;
}

export function addressMatches(address, networkId, prefix) {
  return address.startsWith(fullTarget(networkId, prefix));
}

/* ---------------- grinding ---------------- */

/**
 * Grind one batch of attempts. Pure + synchronous (worker calls it in a loop).
 *   { prefix, networkId, mode: 'random'|'bip86', accountNode?, startIndex, batchSize,
 *     rng }  — rng: (n)->Uint8Array, only used in 'random' mode.
 * Returns { found: null | {address, privHex, wif, mode, path, index}, scanned }.
 */
export function grindBatch(opts) {
  const { prefix, networkId, mode, startIndex, batchSize, rng } = opts;
  const network = NETWORKS[networkId];
  if (!network) throw new Error("unknown network");
  const norm = normalizePrefix(prefix);
  if (norm.error) throw new Error(norm.error);
  const want = fullTarget(networkId, norm.prefix);
  let scanned = 0;
  for (let i = 0; i < batchSize; i++) {
    let priv, path = null, index = null;
    if (mode === "random") {
      priv = randomScalar(rng);
    } else if (mode === "bip86") {
      if (!opts.accountNode) throw new Error("bip86 mode needs accountNode");
      index = startIndex + i * (opts.stride || 1);
      const c = bip86ChildPriv(opts.accountNode, index);
      priv = c.priv; path = c.path;
    } else {
      throw new Error("unknown grind mode");
    }
    const w = vanityFromPriv(priv, network);
    scanned++;
    if (w.address.startsWith(want)) {
      return {
        scanned,
        found: {
          address: w.address,
          xonlyHex: bytesToHex(w.xonly),
          privHex: bytesToHex(w.priv),
          wif: vanityToWIF(w.priv, network),
          mode,
          path,
          index,
          networkId,
        },
      };
    }
  }
  return { scanned, found: null };
}

/** Re-derive + re-match a found result (integrity check before display/export). */
export function verifyFound(found, prefix) {
  const network = NETWORKS[found.networkId];
  if (!network) return { ok: false, error: "unknown network" };
  const norm = normalizePrefix(prefix);
  if (norm.error) return { ok: false, error: norm.error };
  const w = vanityFromPriv(hexToBytes(found.privHex), network);
  if (w.address !== found.address) return { ok: false, error: "address does not re-derive from the private key" };
  if (!w.address.startsWith(fullTarget(found.networkId, norm.prefix)))
    return { ok: false, error: "address does not match the requested prefix" };
  return { ok: true, xonlyHex: bytesToHex(w.xonly) };
}

/** Prove the found secret controls the address: keypath Schnorr sign/verify round-trip. */
export function proveKeyControl(privHex, messageBytes) {
  const priv = hexToBytes(privHex);
  const xonly = schnorr.getPublicKey(priv);
  const sig = schnorr.sign(messageBytes, priv);
  const ok = schnorr.verify(sig, messageBytes, xonly);
  return { ok, sigHex: bytesToHex(sig), xonlyHex: bytesToHex(xonly) };
}

/** Sanity: decode a vanity address back to its x-only program (must be v1, 32 bytes). */
export function decodeVanityAddress(address, networkId) {
  const network = NETWORKS[networkId];
  const d = decodeBech32m(address, network.hrp);
  if (d.version !== 1) throw new Error("not a v1 (Taproot) address");
  if (d.program.length !== 32) throw new Error("program is not 32 bytes");
  return bytesToHex(d.program);
}
