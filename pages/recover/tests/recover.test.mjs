// Pearl Recover verification suite.
// Run: node --no-warnings --loader ./tests/loader.mjs tests/recover.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  validateSeedPhrase,
  seedFromMnemonic,
  deriveAddress,
  deriveBatch,
  scanAddress,
  scanChain,
  scanAccounts,
  normalizeAccountRange,
  summarize,
  formatPrl,
  toCsv,
  summaryLine,
  DEFAULT_GAP_LIMIT,
  DEFAULT_INDEX_CAP,
  DEFAULT_CONCURRENCY,
  NETWORKS,
  GRAIN_PER_PRL,
  walletFromMnemonic,
} from "../src/recover-core.js";

const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const MNEMONIC_24 =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon " +
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

/* deterministic mock Blockbook fetcher: used = Map(address -> {balance, txs}) */
function mockFetcher(used, onCall) {
  return async (url) => {
    const addr = String(url).split("/api/v2/address/")[1];
    if (onCall) onCall(addr);
    const u = used.get(addr);
    return u ? { balance: String(u.balance), txs: u.txs } : { balance: "0", txs: 0 };
  };
}

function deriveUsed(account, change, indices, balances = {}) {
  const m = new Map();
  const batch = deriveBatch(MNEMONIC, NETWORKS.mainnet, account, change, 0, Math.max(...indices) + 1);
  for (const i of indices) {
    m.set(batch[i].address, { balance: balances[i] ?? 100_000_000, txs: 1 });
  }
  return m;
}

test("validateSeedPhrase accepts 12/24 words, rejects bad input", () => {
  assert.equal(validateSeedPhrase(MNEMONIC).words.length, 12);
  assert.equal(validateSeedPhrase(MNEMONIC_24).words.length, 24);
  assert.equal(validateSeedPhrase("  " + MNEMONIC + "\n").words.length, 12); // whitespace tolerated
  assert.match(validateSeedPhrase("abandon abandon about").error, /12- or 24-word/);
  assert.match(
    validateSeedPhrase("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon").error,
    /checksum/
  );
  const seed = seedFromMnemonic(MNEMONIC);
  assert.equal(seed.length, 64);
  assert.throws(() => seedFromMnemonic("nope nope nope"), /12- or 24-word/);
});

test("cross-check: change=0 derivation is byte-identical to walletFromMnemonic", () => {
  for (const account of [0, 1]) {
    for (const index of [0, 1, 7, 42]) {
      const mine = deriveAddress(MNEMONIC, NETWORKS.mainnet, account, 0, index);
      const ref = walletFromMnemonic(MNEMONIC, NETWORKS.mainnet, account, index);
      assert.equal(mine.address, ref.address, `account ${account} index ${index}`);
      assert.equal(mine.path, `m/86'/808276'/${account}'/0/${index}`);
    }
  }
  // network switch changes the hrp
  const t = deriveAddress(MNEMONIC, NETWORKS.testnet, 0, 0, 0);
  assert.ok(t.address.startsWith("tprl1p"), t.address);
  assert.equal(t.path, "m/86'/1'/0'/0/0");
});

test("change=1 derives distinct, well-formed addresses", () => {
  const ext = deriveAddress(MNEMONIC, NETWORKS.mainnet, 0, 0, 3);
  const int = deriveAddress(MNEMONIC, NETWORKS.mainnet, 0, 1, 3);
  assert.notEqual(int.address, ext.address);
  assert.ok(int.address.startsWith("prl1p"), int.address);
  assert.equal(int.path, "m/86'/808276'/0'/1/3");
  // same index in different accounts differs
  assert.notEqual(deriveAddress(MNEMONIC, NETWORKS.mainnet, 1, 0, 3).address, ext.address);
  assert.throws(() => deriveAddress(MNEMONIC, NETWORKS.mainnet, 0, 2, 0), /change/);
  assert.throws(() => deriveAddress(MNEMONIC, null, 0, 0, 0), /unknown network/);
});

test("scanAddress parses Blockbook JSON; 404 means unused", async () => {
  const used = new Map([["prl1paddr", { balance: "150000000", txs: 2 }]]);
  const f = mockFetcher(used);
  const r = await f("https://x/api/v2/address/prl1paddr");
  const hit = await scanAddress(f, "https://x", "prl1paddr");
  assert.equal(hit.balance, 150000000n);
  assert.equal(hit.txs, 2);
  const miss = await scanAddress(f, "https://x/", "prl1punknown");
  assert.equal(miss.balance, 0n);
  assert.equal(miss.txs, 0);
  // fetcher-level 404 passthrough via the default fetcher (null fetcher + stubbed global fetch)
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 404 });
  try {
    const z = await scanAddress(null, "https://x", "prl1pnever");
    assert.equal(z.balance, 0n);
    assert.equal(z.txs, 0);
  } finally {
    globalThis.fetch = origFetch;
  }
  // bad balance is a loud error, not silent zero
  await assert.rejects(
    () => scanAddress(async () => ({ balance: "abc", txs: 0 }), "https://x", "a"),
    /non-integer balance/
  );
});

test("gap limit: stops after 20 consecutive unused", async () => {
  const used = deriveUsed(0, 0, [0, 1], { 0: 150_000_000, 1: 50_000_000 });
  const r = await scanChain({
    fetcher: mockFetcher(used),
    blockbookBase: "https://x",
    mnemonic: MNEMONIC,
    network: NETWORKS.mainnet,
    account: 0,
    change: 0,
    gapLimit: DEFAULT_GAP_LIMIT,
    indexCap: DEFAULT_INDEX_CAP,
    concurrency: DEFAULT_CONCURRENCY,
  });
  assert.equal(r.found.length, 2);
  assert.equal(r.scanned, 2 + DEFAULT_GAP_LIMIT, `scanned=${r.scanned}`);
  assert.equal(r.found[0].index, 0);
  assert.equal(r.found[1].index, 1);
  assert.equal(r.found[0].balance, 150_000_000n);
  assert.equal(r.aborted, false);
  assert.equal(r.capped, false);
});

test("gap limit is configurable; late activity restarts the streak", async () => {
  // used at 0 and 6 with gap 7 -> the index-6 hit resets the streak;
  // scans 0..6 then 7 unused after it (7..13), stopping at 14 scanned
  const used = deriveUsed(0, 0, [0, 6]);
  const r = await scanChain({
    fetcher: mockFetcher(used),
    blockbookBase: "https://x",
    mnemonic: MNEMONIC,
    network: NETWORKS.mainnet,
    account: 0,
    change: 0,
    gapLimit: 7,
    indexCap: 1000,
    concurrency: 4,
  });
  assert.equal(r.found.length, 2);
  assert.equal(r.scanned, 14);
  assert.deepEqual(r.found.map((h) => h.index), [0, 6]);
  // and with gap 5 the chain stops at the first 5-unused run, never reaching index 6
  const r5 = await scanChain({
    fetcher: mockFetcher(used),
    blockbookBase: "https://x",
    mnemonic: MNEMONIC,
    network: NETWORKS.mainnet,
    account: 0,
    change: 0,
    gapLimit: 5,
    indexCap: 1000,
    concurrency: 4,
  });
  assert.equal(r5.found.length, 1);
  assert.equal(r5.scanned, 6); // idx 0 used + 5 unused
});

test("indexCap bounds a fully-used chain", async () => {
  const indices = Array.from({ length: 10 }, (_, i) => i);
  const batch = deriveBatch(MNEMONIC, NETWORKS.mainnet, 0, 0, 0, 10);
  const used = new Map(batch.map((b) => [b.address, { balance: 1000, txs: 1 }]));
  let calls = 0;
  const r = await scanChain({
    fetcher: mockFetcher(used, () => calls++),
    blockbookBase: "https://x",
    mnemonic: MNEMONIC,
    network: NETWORKS.mainnet,
    account: 0,
    change: 0,
    gapLimit: 20,
    indexCap: 10,
    concurrency: 4,
  });
  assert.equal(r.scanned, 10);
  assert.equal(calls, 10);
  assert.equal(r.capped, true);
  assert.equal(r.found.length, 10);
});

test("abort stops the scan promptly", async () => {
  let batches = 0;
  const r = await scanChain({
    fetcher: mockFetcher(new Map()),
    blockbookBase: "https://x",
    mnemonic: MNEMONIC,
    network: NETWORKS.mainnet,
    account: 0,
    change: 0,
    gapLimit: 20,
    indexCap: 1000,
    concurrency: 4,
    shouldAbort: () => ++batches > 3,
  });
  assert.equal(r.aborted, true);
  assert.ok(r.scanned <= 4 * 4, `scanned=${r.scanned}`);
});

test("scanAccounts walks accounts x both chains; normalizeAccountRange guards", () => {
  assert.deepEqual(normalizeAccountRange(0, 2), { start: 0, end: 2 });
  assert.match(normalizeAccountRange(3, 1).error, /≤/);
  assert.match(normalizeAccountRange(0, 99).error, /at most 10/);
});

test("scanAccounts: multi-account discovery + progress + totals", async () => {
  const used = new Map([
    ...deriveUsed(0, 0, [2], { 2: 200_000_000 }),
    ...deriveUsed(0, 1, [0], { 0: 75_000_000 }),
  ]);
  const seen = [];
  const r = await scanAccounts({
    fetcher: mockFetcher(used),
    blockbookBase: "https://x",
    mnemonic: MNEMONIC,
    network: NETWORKS.mainnet,
    accountStart: 0,
    accountEnd: 1,
    gapLimit: 20,
    indexCap: 1000,
    concurrency: 4,
    onAddress: (h) => seen.push(h),
    onProgress: () => {},
  });
  assert.equal(r.aborted, false);
  // a0c0: 3 used-ish..unused(20) = 23; a0c1: 1+20 = 21; a1c0/a1c1: 20 each
  assert.equal(r.scanned, 23 + 21 + 20 + 20, `scanned=${r.scanned}`);
  assert.equal(r.found.length, 2);
  assert.deepEqual(seen.map((h) => [h.account, h.change, h.index]), [[0, 0, 2], [0, 1, 0]]);
  const s = summarize(r.found);
  assert.equal(s.totalGrains, 275_000_000n);
  assert.equal(s.totalPrl, "2.75");
  assert.equal(s.count, 2);
});

test("formatPrl is exact — no floats", () => {
  assert.equal(GRAIN_PER_PRL, 100_000_000);
  assert.equal(formatPrl(0n), "0");
  assert.equal(formatPrl(1n), "0.00000001");
  assert.equal(formatPrl(100_000_000n), "1");
  assert.equal(formatPrl(150_000_000n), "1.5");
  assert.equal(formatPrl(123456789n), "1.23456789");
  assert.equal(formatPrl(275_000_000n), "2.75");
  assert.equal(formatPrl(10_000_000_000_000_000n), "100000000");
});

test("toCsv: exact header, grain + PRL columns", () => {
  const found = [
    { account: 0, change: 0, index: 2, address: "prl1paaa", path: "m/x", txs: 3, balance: 150_000_000n },
    { account: 0, change: 1, index: 0, address: "prl1pbbb", path: "m/x", txs: 1, balance: 1n },
  ];
  const csv = toCsv(found);
  const lines = csv.trim().split("\n");
  assert.equal(lines[0], "account,chain,index,address,txs,balance_grains,balance_prl");
  assert.equal(lines[1], "0,external,2,prl1paaa,3,150000000,1.5");
  assert.equal(lines[2], "0,internal,0,prl1pbbb,1,1,0.00000001");
  assert.equal(lines.length, 3);
  assert.ok(csv.endsWith("\n"));
});

test("summaryLine reads naturally", () => {
  const found = [{ account: 0, change: 0, index: 0, address: "a", path: "m", txs: 1, balance: 100_000_000n }];
  assert.equal(summaryLine(found, 21), "1 used address holding 1 PRL (100000000 grains), across 21 scanned.");
  assert.equal(summaryLine([], 40), "0 used addresses holding 0 PRL (0 grains), across 40 scanned.");
});

test("scanChain validates inputs", async () => {
  const base = {
    fetcher: mockFetcher(new Map()),
    blockbookBase: "https://x",
    mnemonic: MNEMONIC,
    network: NETWORKS.mainnet,
    account: 0,
    change: 0,
  };
  await assert.rejects(() => scanChain({ ...base, gapLimit: 0 }), /gapLimit/);
  await assert.rejects(() => scanChain({ ...base, indexCap: -1 }), /indexCap/);
  await assert.rejects(() => scanChain({ ...base, change: 2 }), /change/);
  await assert.rejects(() => scanChain({ ...base, mnemonic: "abandon abandon" }), /12- or 24-word/);
});
