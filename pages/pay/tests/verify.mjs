// Pearl Pay verification suite.
// Usage (from the pay directory):
//   node --no-warnings --loader tests/loader.mjs tests/verify.mjs
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const payDir = resolvePath(here, "..");
const launcherIns = resolvePath(payDir, "..", "prl20-launcher", "pearl-inscribe.js");

import {
  NETWORKS, GRAIN_PER_PRL, DUST_GRAIN,
  encodeBech32m, decodeBech32m, isValidPearlAddress,
  tweakKeypath,
  parseAccountXpub, deriveInvoiceAddress, findNextUnusedIndex,
  encodeInvoice, decodeInvoice,
  classifyPayment, summarizeAddress, fetchAddressSummary, fetchConfirmationAwareSummary, watchPayment,
  fetchPrlUsd, usdToGrains, grainsToUsd, formatPRL, formatUSD, pearlUri,
  bytesToHex, hexToBytes,
} from "../pearl-pay-core.js";
import { HDKey } from "@scure/bip32";
import { schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
};

const MN = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

/* 1. bech32m known vector (Pearlscriptions release-manifest fee recipient) */
{
  const prog = hexToBytes("0effd3c4e44fd3886e8c1ebe943138fa6a944e21e4bbe7e2d9ab800b7f4c4ffa");
  const addr = encodeBech32m("prl", 1, prog);
  ok("bech32m known vector", addr === "prl1ppmla838yflfcsm5vr6lfgvfclf4fgn3puja70cke4wqqkl6vflaq3cn7ea", addr);
  ok("isValidPearlAddress mainnet", isValidPearlAddress(addr, "mainnet"));
  ok("isValidPearlAddress rejects wrong net", !isValidPearlAddress(addr, "testnet"));
  ok("isValidPearlAddress rejects garbage", !isValidPearlAddress("prl1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq", "mainnet"));
}

/* 2. xpub pipeline cross-check vs audited pearl-inscribe.js walletFromMnemonic */
let ref = null;
if (existsSync(launcherIns)) {
  ref = await import("file://" + launcherIns);
}
{
  const { mnemonicToSeedSync } = await import("@scure/bip39");
  const seed = mnemonicToSeedSync(MN);
  const acct = HDKey.fromMasterSeed(seed).derive("m/86'/808276'/0'");
  const xpub = acct.publicExtendedKey;
  ok("xpub starts with xpub", xpub.startsWith("xpub"));
  const parsed = parseAccountXpub(xpub, "mainnet");
  ok("parseAccountXpub depth 3, no warnings", parsed.depth === 3 && parsed.warnings.length === 0,
    JSON.stringify(parsed.warnings));
  ok("parseAccountXpub reports network id", parsed.network === "mainnet", String(parsed.network));
  ok("parseAccountXpub echoes xpub", parsed.xpub === xpub);
  if (ref) {
    for (const i of [0, 1, 2, 7, 100]) {
      const mine = deriveInvoiceAddress(xpub, i, "mainnet");
      const theirs = ref.walletFromMnemonic(MN, ref.NETWORKS.mainnet, 0, i).address;
      ok(`xpub-derived addr matches audited impl (index ${i})`, mine === theirs, `${mine} vs ${theirs}`);
    }
    // taproot tweak cross-check on random keys
    for (let k = 0; k < 3; k++) {
      const x = schnorr.getPublicKey(schnorr.utils.randomPrivateKey()); // x-only pubkey
      const a = bytesToHex(tweakKeypath(x));
      const b = bytesToHex(ref.tweakKeypath(x).tweakedX);
      ok(`tweakKeypath matches audited impl (#${k})`, a === b);
    }
  } else {
    console.log("skip cross-check: pearl-inscribe.js not found");
  }
  // PHP test vectors (paste into the WooCommerce plugin comments)
  console.log("--- PHP VECTORS (xpub -> addresses) ---");
  console.log("XPUB=" + xpub);
  for (const i of [0, 1, 2]) console.log(`ADDR${i}=` + deriveInvoiceAddress(xpub, i, "mainnet"));
}

/* 3. xpub validation negatives */
{
  const { mnemonicToSeedSync } = await import("@scure/bip39");
  const seed = mnemonicToSeedSync(MN);
  const xpub = HDKey.fromMasterSeed(seed).derive("m/86'/808276'/0'").publicExtendedKey;
  const xprv = HDKey.fromMasterSeed(seed).derive("m/86'/808276'/0'").privateExtendedKey;
  const TV = { private: 0x04358394, public: 0x043587cf }; // tprv / tpub
  const tpub = HDKey.fromMasterSeed(seed, TV).derive("m/86'/1'/0'").publicExtendedKey;
  const throws = (fn, frag) => {
    try { fn(); return false; } catch (e) { return (e.message || "").toLowerCase().includes(frag); }
  };
  ok("rejects xprv", throws(() => parseAccountXpub(xprv, "mainnet"), "private"));
  ok("rejects WIF-like private key", throws(() => parseAccountXpub("L" + "1".repeat(51), "mainnet"), "private"));
  ok("rejects garbage", throws(() => parseAccountXpub("notakey", "mainnet"), "invalid xpub"));
  ok("rejects tpub on mainnet", throws(() => parseAccountXpub(tpub, "mainnet"), "mismatch"));
  ok("accepts tpub on testnet", (() => { try { parseAccountXpub(tpub, "testnet"); return true; } catch { return false; } })());
  ok("rejects bad index", throws(() => deriveInvoiceAddress(xpub, -1, "mainnet"), "index"));
  const shallow = HDKey.fromMasterSeed(seed).derive("m/86'/808276'");
  const w = parseAccountXpub(shallow.publicExtendedKey, "mainnet").warnings;
  ok("warns on non-account depth", w.length === 1, JSON.stringify(w));
}

/* 4. invoice codec round-trip */
{
  const { mnemonicToSeedSync } = await import("@scure/bip39");
  const seed = mnemonicToSeedSync(MN);
  const xpub = HDKey.fromMasterSeed(seed).derive("m/86'/808276'/0'").publicExtendedKey;
  const code = encodeInvoice({
    net: "mainnet", grains: "150000000", label: "Order #123 — Widget",
    xpub, idx: 5, exp: Math.floor(Date.now() / 1000) + 3600, conf: 2,
  });
  ok("invoice code is url-safe", /^[A-Za-z0-9_-]+$/.test(code), code.slice(0, 40));
  const inv = decodeInvoice(code);
  ok("invoice round-trip fields",
    inv.grains === "150000000" && inv.label === "Order #123 — Widget" &&
    inv.idx === 5 && inv.conf === 2 && inv.net === "mainnet");
  ok("invoice address = derived address",
    inv.address === deriveInvoiceAddress(xpub, 5, "mainnet"), inv.address);
  // fixed-address invoice (proper testnet tpub -> tprl address)
  const TV = { private: 0x04358394, public: 0x043587cf };
  const txpub = HDKey.fromMasterSeed(seed, TV).derive("m/86'/1'/0'").publicExtendedKey;
  const taddr = deriveInvoiceAddress(txpub, 0, "testnet");
  ok("testnet addr uses tprl hrp", taddr.startsWith("tprl1p"));
  const code2 = encodeInvoice({ net: "testnet", grains: "1000000", label: "tip", addr: taddr, exp: 1893456000 });
  const inv2 = decodeInvoice(code2);
  ok("fixed-addr invoice round-trip", inv2.address === taddr);
  const bad = (fn) => { try { fn(); return true; } catch { return false; } };
  ok("rejects dust amount", !bad(() => encodeInvoice({ net: "mainnet", grains: "100", label: "x", addr: inv.address, exp: 1893456000 })));
  ok("rejects tampered code", !bad(() => decodeInvoice(code.slice(0, -4) + "AAAA")));
  ok("rejects unknown version", !bad(() => decodeInvoice(
    Buffer.from(JSON.stringify({ v: 99 })).toString("base64url"))));
}

/* 5. payment state machine */
{
  const now = Date.now(), exp = now + 3600000, past = now - 1000;
  const c = (o) => classifyPayment({ nowMs: now, expiryMs: exp, receivedGrains: "0", confirmedGrains: "0", requiredGrains: "1000000", ...o });
  ok("awaiting", c({}) === "awaiting");
  ok("partial", c({ receivedGrains: "500000" }) === "partial");
  ok("detected (0-conf)", c({ receivedGrains: "1000000", confirmedGrains: "0" }) === "detected");
  ok("detected (overpaid)", c({ receivedGrains: "1000001", confirmedGrains: "0" }) === "detected");
  ok("confirmed", c({ receivedGrains: "1000000", confirmedGrains: "1000000" }) === "confirmed");
  ok("expired beats partial", classifyPayment({ nowMs: now, expiryMs: past, receivedGrains: "500000", confirmedGrains: "0", requiredGrains: "1000000" }) === "expired");
  ok("confirmed beats expired", classifyPayment({ nowMs: now, expiryMs: past, receivedGrains: "1000000", confirmedGrains: "1000000", requiredGrains: "1000000" }) === "confirmed");
  ok("bigint-safe large amounts", c({ receivedGrains: "21000000000000000", confirmedGrains: "21000000000000000", requiredGrains: "21000000000000000" }) === "confirmed");
}

/* 6. summarizeAddress with mocked blockbook payloads */
{
  const s1 = summarizeAddress({ totalReceived: "150000000", totalSent: "0", unconfirmedBalance: "150000000", unconfirmedTxs: 1, txs: 1 });
  ok("0-conf summary", s1.received === "150000000" && s1.confirmedReceived === "0", JSON.stringify(s1));
  const s2 = summarizeAddress({ totalReceived: "150000000", totalSent: "0", unconfirmedBalance: "0", unconfirmedTxs: 0, txs: 2 });
  ok("confirmed summary", s2.confirmedReceived === "150000000", JSON.stringify(s2));
  const s3 = summarizeAddress({ totalReceived: "0", totalSent: "0", txs: 0 });
  ok("empty summary", s3.received === "0" && s3.txCount === 0);
  const s4 = summarizeAddress({ totalReceived: "200000000", totalSent: "0", unconfirmedBalance: "-50000000", txs: 3 });
  ok("negative unconfirmed clamped", s4.confirmedReceived === "200000000", JSON.stringify(s4));
}

/* 7. gap-limit scan with mocked blockbook */
{
  const { mnemonicToSeedSync } = await import("@scure/bip39");
  const seed = mnemonicToSeedSync(MN);
  const xpub = HDKey.fromMasterSeed(seed).derive("m/86'/808276'/0'").publicExtendedKey;
  const usedIdx = new Set([0, 2]); // index 1 and 3+ unused
  const addrs = new Map();
  for (let i = 0; i < 30; i++) addrs.set(deriveInvoiceAddress(xpub, i, "mainnet"), i);
  const mockFetch = async (url) => {
    const addr = url.split("/").pop();
    const i = addrs.get(addr);
    return { ok: true, json: async () => ({ txs: usedIdx.has(i) ? 1 : 0 }) };
  };
  const r = await findNextUnusedIndex(xpub, "mainnet", "https://blockbook.test", { fetchFn: mockFetch, gapLimit: 5 });
  // BIP-44 semantics: next = highest used index + 1 (index 1 may already be
  // handed to a customer, so it must NOT be reused even though it's empty).
  ok("gap scan returns lastUsed+1 (3)", r.index === 3 && r.used.join() === "0,2", JSON.stringify(r));
  const mockFetch2 = async (url) => {
    const addr = url.split("/").pop();
    const i = addrs.get(addr);
    return { ok: true, json: async () => ({ txs: i < 4 ? 1 : 0 }) }; // 0..3 used
  };
  const r2 = await findNextUnusedIndex(xpub, "mainnet", "https://blockbook.test", { fetchFn: mockFetch2, gapLimit: 5 });
  ok("gap scan skips used run (4)", r2.index === 4, JSON.stringify(r2));
}

/* 8. rate math + mocked coingecko */
{
  ok("usdToGrains", usdToGrains(1.46, 1.46) === String(GRAIN_PER_PRL));
  ok("usdToGrains fractional", usdToGrains(0.73, 1.46) === String(GRAIN_PER_PRL / 2));
  ok("grainsToUsd", Math.abs(grainsToUsd("100000000", 1.46) - 1.46) < 1e-9);
  ok("formatPRL", formatPRL("150000000") === "1.5" && formatPRL("100000000") === "1");
  ok("formatUSD", formatUSD(1.5) === "$1.50");
  ok("pearlUri", pearlUri("prl1abc", "250000000") === "pearl:prl1abc?amount=2.5");
  const mockCg = async () => ({ ok: true, json: async () => ({ "pearl-2": { usd: 2.0, usd_24h_change: 5 } }) });
  const q = await fetchPrlUsd(mockCg);
  ok("fetchPrlUsd mocked", q.usd === 2.0 && q.source === "coingecko" && q.change24h === 5);
  const mockBad = async () => ({ ok: true, json: async () => ({}) });
  let threw = false;
  try { await fetchPrlUsd(mockBad); } catch { threw = true; }
  ok("fetchPrlUsd rejects bad payload", threw);
}

/* 9. watchPayment drives the full state machine with a scripted mock */
{
  const script = [
    { totalReceived: "0", totalSent: "0", txs: 0 },                                            // awaiting
    { totalReceived: "400000", totalSent: "0", unconfirmedBalance: "400000", txs: 1 },          // partial
    { totalReceived: "1000000", totalSent: "0", unconfirmedBalance: "1000000", txs: 1 },         // detected
    { totalReceived: "1000000", totalSent: "0", unconfirmedBalance: "0", txs: 1 },              // confirmed
  ];
  let n = 0;
  const mockFetch = async () => ({ ok: true, json: async () => script[Math.min(n++, script.length - 1)] });
  const seen = [];
  await new Promise((resolve) => {
    const stop = watchPayment({
      blockbookBase: "https://x", address: "prl1test", requiredGrains: "1000000",
      expiryMs: Date.now() + 60000, reqConf: 1, intervalMs: 20, fetchFn: mockFetch,
      onEvent: (st) => { seen.push(st); if (st === "confirmed") { stop(); resolve(); } },
    });
    setTimeout(() => { stop(); resolve(); }, 3000);
  });
  ok("watchPayment: awaiting→partial→detected→confirmed",
    JSON.stringify(seen) === JSON.stringify(["awaiting", "partial", "detected", "confirmed"]),
    JSON.stringify(seen));
}

/* ---------- confirmation-aware accounting (reqConf enforcement) ---------- */
{
  const ADDR = "prl1testaddr";
  const tx = (conf, grains, addr = ADDR) => ({
    txid: "tx" + conf + "_" + grains, confirmations: conf,
    vout: [{ value: String(grains), addresses: [addr] }],
  });
  // mock blockbook: plain endpoint -> cheap summary; ?details=txs -> full txs
  const mock = (txs, unconf = "0") => async (url) => {
    const totalReceived = txs.reduce((a, t) => a + (t.vout ?? []).reduce((x, v) => { try { return x + BigInt(v.value); } catch { return x; } }, 0n), 0n);
    const body = {
      address: ADDR, totalReceived: totalReceived.toString(), totalSent: "0",
      unconfirmedBalance: unconf, txs: txs.length,
    };
    if (String(url).includes("details=txs")) body.txs = txs;
    return { ok: true, json: async () => body };
  };
  const stateOf = async (txs, reqConf, requiredGrains, expiryMs, unconf = "0") => {
    const s = await fetchConfirmationAwareSummary("https://x", ADDR, reqConf, mock(txs, unconf));
    return { state: classifyPayment({ nowMs: Date.now(), expiryMs, receivedGrains: s.received, confirmedGrains: s.confirmedReceived, requiredGrains }), s };
  };
  const future = Date.now() + 60000, past = Date.now() - 1000;
  const REQ = "1000000"; // 0.01 PRL

  // reqConf = 0: 0-conf counts as confirmed
  {
    const { state } = await stateOf([tx(0, 1000000)], 0, REQ, future, "1000000");
    ok("reqConf=0: 0-conf payment is confirmed", state === "confirmed", state);
  }
  // reqConf = 1: cheap path
  {
    const { state } = await stateOf([tx(0, 1000000)], 1, REQ, future, "1000000");
    ok("reqConf=1: 0-conf is detected, not confirmed", state === "detected", state);
  }
  {
    const { state } = await stateOf([tx(1, 1000000)], 1, REQ, future, "0");
    ok("reqConf=1: 1-conf is confirmed", state === "confirmed", state);
  }
  // reqConf = 2: per-tx depth accounting
  {
    const { state, s } = await stateOf([tx(3, 600000), tx(1, 600000)], 2, REQ, future);
    ok("reqConf=2: shallow tx does not count (detected)",
      state === "detected" && s.confirmedReceived === "600000", `${state}/${s.confirmedReceived}`);
  }
  {
    const { state } = await stateOf([tx(3, 600000), tx(2, 600000)], 2, REQ, future);
    ok("reqConf=2: split payments sum to confirmed", state === "confirmed", state);
  }
  {
    const { state } = await stateOf([tx(5, 1500000)], 2, REQ, future);
    ok("reqConf=2: overpayment confirms", state === "confirmed", state);
  }
  {
    const { state } = await stateOf([tx(5, 500000)], 2, REQ, future);
    ok("reqConf=2: underpayment stays partial", state === "partial", state);
  }
  {
    const { state } = await stateOf([tx(5, 500000)], 2, REQ, past);
    ok("expired beats partial", state === "expired", state);
  }
  {
    const { state } = await stateOf([tx(5, 1000000)], 2, REQ, past);
    ok("confirmed beats expired", state === "confirmed", state);
  }
  // outputs to other addresses + malformed txs are ignored
  {
    const weird = [
      { txid: "a", confirmations: 5, vout: [{ value: "999999", addresses: ["prl1someoneelse"] }] },
      { txid: "b", confirmations: 5 }, // no vout
      { txid: "c", confirmations: 5, vout: [{ value: "oops", addresses: [ADDR] }] }, // bad value
      { txid: "d", confirmations: -1, vout: [{ value: "1000000", addresses: [ADDR] }] }, // conflicted
      tx(5, 1000000),
    ];
    const { state, s } = await stateOf(weird, 2, REQ, future);
    ok("ignores foreign/malformed/conflicted outputs",
      state === "confirmed" && s.confirmedReceived === "1000000", `${state}/${s.confirmedReceived}`);
  }
  // watchPayment enforces reqConf end-to-end (mock: tx deepens over time)
  {
    let calls = 0;
    const evolving = async (url) => {
      calls++;
      const conf = calls < 3 ? 1 : 2; // deepens on 3rd poll
      return mock([tx(conf, 1000000)])(url);
    };
    const seen = [];
    await new Promise((resolve) => {
      const stop = watchPayment({
        blockbookBase: "https://x", address: ADDR, requiredGrains: REQ,
        expiryMs: Date.now() + 60000, reqConf: 2, intervalMs: 20, fetchFn: evolving,
        onEvent: (st) => { seen.push(st); if (st === "confirmed") { stop(); resolve(); } },
      });
      setTimeout(() => { stop(); resolve(); }, 3000);
    });
    ok("watchPayment: detected→confirmed only at depth 2",
      JSON.stringify(seen) === JSON.stringify(["detected", "confirmed"]), JSON.stringify(seen));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
