# Pearl Recover — PRL Seed Recovery Scanner

Lost track of which addresses your seed touched? **Pearl Recover** scans a
BIP-39 seed across the standard BIP-86 Taproot derivation paths and lists
every address that ever saw activity — with transaction counts and balances.

## How it works

- Paste a 12- or 24-word BIP-39 mnemonic (validated client-side, checksum included).
- The page derives `m/86'/{coinType}'/{account}'/{change}/{index}` — coin type
  `808276` on mainnet (`prl1…`), `1` on testnet (`tprl1…`) — using the exact
  audited Pearl Sign construction (BIP-341 keypath tweak, bech32m). The
  change=0 path is byte-identical to `walletFromMnemonic` in the Sign core.
- Each address is checked with **GET-only** Blockbook reads
  (`/api/v2/address/<addr>`, default `https://blockbook.pearlresearch.ai`).
- Scanning follows the **BIP-44 gap-limit convention**: a chain stops after
  20 consecutive unused addresses (configurable), never past the index cap
  (default 1000). Accounts 0–2 × external + internal chains are scanned by
  default, 4 concurrent reads.
- Totals use exact integer-grain math (BigInt) — no floats anywhere.
- Results export to CSV: `account,chain,index,address,txs,balance_grains,balance_prl`.

## Honest limits

- **Discovery only.** This page never signs, never builds transactions, never
  broadcasts. To move found funds, import the seed into
  [Pearl Sign](../sign/) and spend from there.
- The seed lives in page memory only — never saved to disk, never put in a
  URL, never sent anywhere. The **🔒 Lock** button wipes it instantly.
- BIP-39 passphrases are not scanned (plain mnemonic only).
- Funds past an unusually long gap of unused addresses won't be seen — raise
  the gap limit and re-scan if in doubt. Chains that hit the index cap are
  flagged in the status line.

## Files

- `index.html` / `styles.css` / `app.js` — the page (loads
  `pearl-recover.bundle.js?v=1` + `app.js?v=1`)
- `src/recover-core.js` — pure logic (node-testable)
- `src/index.js` — bundle entry (re-exports the core as `window.PearlRecover`)
- `tests/recover.test.mjs` + `tests/loader.mjs` — verification suite
- `pearl-recover.bundle.js` — committed esbuild IIFE bundle (rebuild with
  `node build.mjs`)

## Verify

```sh
cd pages/recover
node --no-warnings --loader ./tests/loader.mjs tests/recover.test.mjs  # 14/14
node build.mjs  # rebuild the bundle
```

- Real-browser QA (headless Chromium, file:// + CDP) — 17/17 checks green,
  zero console/page errors, plus a 375px mobile sweep
  (`hidden_files/qa-recover-browser.mjs`). The sweep caught a real mobile
  overflow (382px): the unbroken `.mono` derivation-path string in the
  BIP-39 note stretched the page — fixed with `overflow-wrap: anywhere`
  on `.mono` (`styles.css?v=2`).

Crypto is vendored — every key operation reuses `../sign/src/crypto.js`
(`NETWORKS`, `walletFromPriv`, `encodeBech32m`, `GRAIN_PER_PRL`) and the
vendored `@scure/bip39` / `@scure/bip32` HD derivation. No new cryptographic
primitives.

Built by the Pearl 24/7 builder · [@kshot9000](https://x.com/kshot9000) ·
donations: `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`
