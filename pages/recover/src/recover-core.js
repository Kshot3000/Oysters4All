/* Pearl Recover core — in-browser PRL seed-recovery scanner.
 *
 * Pure ESM. The browser ships a committed esbuild IIFE bundle
 * (pearl-recover.bundle.js, entry src/index.js re-exporting this file);
 * node runs this file directly for the verification suite.
 *
 * Model: BIP-86 Taproot derivation m/86'/{coinType}'/{account}'/{change}/{index}
 * (coinType 808276 mainnet `prl`, 1 testnet `tprl`). Each child secret is fed
 * through the audited Pearl Sign construction walletFromPriv — internal x-only
 * key, BIP-341 keypath tweak, bech32m(hrp, v1, tweakedX) — exactly as
 * walletFromMnemonic does for change=0. Discovery only: this module never
 * signs and never broadcasts; it issues GET-only Blockbook reads.
 *
 * Scanning follows the BIP-44 gap-limit convention: walk change=0 and
 * change=1 for each account in order, stop a chain after `gapLimit`
 * consecutive unused addresses (Blockbook `txs` == 0), never past
 * `indexCap`. Concurrency: `concurrency` in-flight Blockbook reads.
 *
 * Crypto lineage: every key operation reuses the audited Pearl Sign core
 * (../../sign/src/crypto.js) and the vendored @scure/bip39 + @scure/bip32
 * HD derivation — no new cryptographic primitives are introduced here.
 */

import {
  NETWORKS,
  GRAIN_PER_PRL,
  walletFromPriv,
  walletFromMnemonic,
  bytesToHex,
  hexToBytes,
} from "../../sign/src/crypto.js";
import { HDKey } from "@scure/bip32";
import { validateMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist as englishWordlist } from "@scure/bip39/wordlists/english";

export { NETWORKS, GRAIN_PER_PRL, walletFromMnemonic, bytesToHex, hexToBytes };

/* ---------------- constants ---------------- */

export const DEFAULT_GAP_LIMIT = 20; // standard BIP-44 discovery gap
export const DEFAULT_INDEX_CAP = 1000; // hard stop per chain
export const DEFAULT_CONCURRENCY = 4; // in-flight Blockbook reads
export const DEFAULT_ACCOUNT_START = 0;
export const DEFAULT_ACCOUNT_END = 2;
export const MAX_ACCOUNTS = 10; // sanity bound on the account range

export const DONATE_ADDRESS = "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d";
export const BUILDER_X = "@kshot9000";

/* ---------------- mnemonic ---------------- */

/** Validate a BIP-39 mnemonic. Returns { words } or { error }. */
export function validateSeedPhrase(raw) {
  const words = String(raw ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length !== 12 && words.length !== 24) {
    return { error: `Enter a 12- or 24-word BIP-39 mnemonic (got ${words.length} words).` };
  }
  if (!validateMnemonic(words.join(" "), englishWordlist)) {
    return { error: "Mnemonic failed checksum validation — check the words and their order." };
  }
  return { words };
}

/** 64-byte BIP-39 seed from a validated mnemonic. Throws on invalid. */
export function seedFromMnemonic(mnemonic) {
  const v = validateSeedPhrase(mnemonic);
  if (v.error) throw new Error(v.error);
  return mnemonicToSeedSync(v.words.join(" "));
}

/* ---------------- derivation ---------------- */

/** Account node m/86'/{coinType}'/{account}' — hardened part derived once. */
export function accountNodeFromSeed(seedBytes, network, account) {
  if (!Number.isInteger(account) || account < 0 || account > 0x7fffffff) throw new Error("bad account");
  const root = HDKey.fromMasterSeed(seedBytes);
  const node = root.derive(`m/86'/${network.coinType}'/${account}'`);
  if (!node) throw new Error("derivation failed");
  return { node, network, account };
}

/**
 * Derive a recovery address at m/86'/{coinType}'/{account}'/{change}/{index}.
 * change 0 = external (receive), 1 = internal (change).
 * Uses the exact Sign construction (keypath tweak + bech32m), so for
 * change=0 the result is byte-identical to walletFromMnemonic(mnemonic, network, account, index).
 * Returns { address, path }.
 */
export function deriveAddress(mnemonic, network, account, change, index) {
  if (!network || !network.hrp) throw new Error("unknown network");
  if (change !== 0 && change !== 1) throw new Error("change must be 0 (external) or 1 (internal)");
  if (!Number.isInteger(index) || index < 0 || index > 0x7fffffff) throw new Error("bad index");
  const seed = seedFromMnemonic(mnemonic);
  const acct = accountNodeFromSeed(seed, network, account);
  const child = acct.node.deriveChild(change).deriveChild(index);
  if (!child.privateKey) throw new Error("derivation failed");
  const w = walletFromPriv(child.privateKey, network);
  // wipe the seed before returning — the caller keeps only the mnemonic string
  seed.fill(0);
  return {
    address: w.address,
    path: `m/86'/${network.coinType}'/${account}'/${change}/${index}`,
  };
}

/** Derive a batch of addresses for one chain. Returns [{ index, address, path }]. */
export function deriveBatch(mnemonic, network, account, change, startIndex, count) {
  const seed = seedFromMnemonic(mnemonic);
  const acct = accountNodeFromSeed(seed, network, account);
  const out = [];
  for (let i = 0; i < count; i++) {
    const index = startIndex + i;
    const child = acct.node.deriveChild(change).deriveChild(index);
    if (!child.privateKey) throw new Error("derivation failed");
    const w = walletFromPriv(child.privateKey, network);
    out.push({
      index,
      address: w.address,
      path: `m/86'/${network.coinType}'/${account}'/${change}/${index}`,
    });
  }
  seed.fill(0);
  return out;
}

/* ---------------- blockbook ---------------- */

function defaultFetcher(url, signal) {
  return fetch(url, { signal }).then((res) => {
    if (!res.ok) {
      // Blockbook returns 404 for some never-seen addresses — treat as unused.
      if (res.status === 404) return { balance: "0", txs: 0 };
      throw new Error(`blockbook ${res.status} on ${url}`);
    }
    return res.json();
  });
}

/**
 * GET-only read of one address: GET {base}/api/v2/address/<addr>.
 * Returns { address, balance: BigInt grains, txs: number }.
 * fetcher(url, signal) -> parsed JSON; inject a stub in tests.
 */
export async function scanAddress(fetcher, blockbookBase, address, signal) {
  const base = String(blockbookBase).replace(/\/$/, "");
  const f = fetcher || defaultFetcher;
  const r = await f(`${base}/api/v2/address/${address}`, signal);
  const txs = Number(r && r.txs ? r.txs : 0);
  let balance;
  try {
    balance = BigInt(r && r.balance != null ? r.balance : 0);
  } catch {
    throw new Error(`blockbook returned a non-integer balance for ${address}`);
  }
  if (balance < 0n) throw new Error(`blockbook returned a negative balance for ${address}`);
  return { address, balance, txs };
}

/* ---------------- gap-limit scanner ---------------- */

/**
 * Scan one chain (account, change) with the standard gap limit.
 * Batches of `concurrency` addresses are derived and scanned; the
 * consecutive-unused counter is evaluated in index order, so the stop
 * point is identical to a strictly serial scan.
 *
 * opts: { fetcher, blockbookBase, mnemonic, network, account, change,
 *         gapLimit=20, indexCap=1000, concurrency=4,
 *         onProgress({account, change, index, scanned, found}) ,
 *         shouldAbort() -> boolean }
 * Returns { found: [{account, change, index, address, path, txs, balance}],
 *           scanned, capped, aborted }.
 */
export async function scanChain(opts) {
  const {
    fetcher,
    blockbookBase,
    mnemonic,
    network,
    account,
    change,
    gapLimit = DEFAULT_GAP_LIMIT,
    indexCap = DEFAULT_INDEX_CAP,
    concurrency = DEFAULT_CONCURRENCY,
    onProgress,
    shouldAbort,
  } = opts;
  if (!network || !NETWORKS[network.id]) throw new Error("unknown network");
  if (change !== 0 && change !== 1) throw new Error("change must be 0 or 1");
  const gap = Number(gapLimit);
  const cap = Number(indexCap);
  const conc = Math.max(1, Math.floor(Number(concurrency) || 1));
  if (!Number.isInteger(gap) || gap < 1) throw new Error("gapLimit must be a positive integer");
  if (!Number.isInteger(cap) || cap < 1) throw new Error("indexCap must be a positive integer");

  const found = [];
  let scanned = 0;
  let unusedStreak = 0;
  let index = 0;
  let aborted = false;

  while (unusedStreak < gap && index < cap) {
    if (shouldAbort && shouldAbort()) { aborted = true; break; }
    const count = Math.min(conc, cap - index);
    const batch = deriveBatch(mnemonic, network, account, change, index, count);
    const results = await Promise.all(
      batch.map((b) => scanAddress(fetcher, blockbookBase, b.address).then((r) => ({ ...b, ...r })))
    );
    for (const r of results) {
      scanned++;
      if (r.txs > 0) {
        unusedStreak = 0;
        found.push({
          account,
          change,
          index: r.index,
          address: r.address,
          path: r.path,
          txs: r.txs,
          balance: r.balance,
        });
      } else {
        unusedStreak++;
      }
      if (onProgress) onProgress({ account, change, index: r.index, scanned, found: found.length });
      if (unusedStreak >= gap) break;
      if (shouldAbort && shouldAbort()) { aborted = true; break; }
    }
    index += results.length;
    if (aborted) break;
  }

  return { found, scanned, capped: index >= cap && unusedStreak < gap, aborted };
}

/** Validate an account range. Returns { start, end } or { error }. */
export function normalizeAccountRange(start, end) {
  const s = Number(start);
  const e = Number(end);
  if (!Number.isInteger(s) || s < 0) return { error: "Account start must be a non-negative integer." };
  if (!Number.isInteger(e) || e < 0) return { error: "Account end must be a non-negative integer." };
  if (s > e) return { error: "Account start must be ≤ account end." };
  if (e - s + 1 > MAX_ACCOUNTS) return { error: `Scan at most ${MAX_ACCOUNTS} accounts per run.` };
  return { start: s, end: e };
}

/**
 * Scan all accounts × both chains. opts as scanChain plus
 * { accountStart, accountEnd, onAddress(hit) }.
 * Returns { found, scanned, aborted, cappedChains }.
 */
export async function scanAccounts(opts) {
  const { accountStart, accountEnd, onAddress, onProgress } = opts;
  const range = normalizeAccountRange(accountStart, accountEnd);
  if (range.error) throw new Error(range.error);

  const found = [];
  let scanned = 0;
  let aborted = false;
  const cappedChains = [];

  for (let account = range.start; account <= range.end && !aborted; account++) {
    for (const change of [0, 1]) {
      const r = await scanChain({
        ...opts,
        account,
        change,
        onProgress: (p) => { if (onProgress) onProgress({ ...p, scannedTotal: scanned + p.scanned }); },
      });
      for (const hit of r.found) {
        found.push(hit);
        if (onAddress) onAddress(hit);
      }
      scanned += r.scanned;
      if (r.capped) cappedChains.push({ account, change });
      if (r.aborted) aborted = true;
      if (aborted) break;
    }
  }
  return { found, scanned, aborted, cappedChains };
}

/* ---------------- totals + export ---------------- */

/** Exact grain math: total grains (BigInt) and exact PRL string. */
export function summarize(found) {
  let totalGrains = 0n;
  const byAccount = {};
  for (const h of found) {
    totalGrains += h.balance;
    const k = `account ${h.account}`;
    if (!byAccount[k]) byAccount[k] = { grains: 0n, addresses: 0 };
    byAccount[k].grains += h.balance;
    byAccount[k].addresses += 1;
  }
  return {
    count: found.length,
    totalGrains,
    totalPrl: formatPrl(totalGrains),
    byAccount,
  };
}

/** Exact grains -> PRL decimal string (no float anywhere). */
export function formatPrl(grains) {
  const g = typeof grains === "bigint" ? grains : BigInt(grains);
  const whole = g / BigInt(GRAIN_PER_PRL);
  const frac = g % BigInt(GRAIN_PER_PRL);
  if (frac === 0n) return `${whole}`;
  return `${whole}.${frac.toString().padStart(8, "0").replace(/0+$/, "")}`;
}

const CSV_HEADER = "account,chain,index,address,txs,balance_grains,balance_prl";

/** CSV of every used address found. chain is "external"/"internal". */
export function toCsv(found) {
  const chainName = (c) => (c === 0 ? "external" : "internal");
  const lines = [CSV_HEADER];
  for (const h of found) {
    lines.push(
      [h.account, chainName(h.change), h.index, h.address, h.txs, h.balance.toString(), formatPrl(h.balance)].join(",")
    );
  }
  return lines.join("\n") + "\n";
}

/** One-line human summary. */
export function summaryLine(found, scanned) {
  const s = summarize(found);
  return `${s.count} used address${s.count === 1 ? "" : "es"} holding ${s.totalPrl} PRL (${s.totalGrains} grains), across ${scanned} scanned.`;
}
