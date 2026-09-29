# Pearl Tax — PRL Capital-Gains Desk

Read-only PRL tax bookkeeping: import your transaction history, classify every
movement, supply your own PRL/USD prices, and get a grain-exact FIFO
capital-gains report with CSV/JSON export.

**Live:** https://kshot3000.github.io/Pearl-Muse-24-7-Ai-builder/pages/tax/

## What it does

Six steps — **Addresses → Import → Classify → Prices → Report → Export**:

1. **Addresses** — watch `prl1…`/`tprl1…` addresses (in-browser bech32m validation).
2. **Import** — GET-only Blockbook reads (`/api/v2/address/…?details=txs`, paged),
   with automatic fallback to the full `/api/v2/tx/…` detail when input values
   are missing; plus an air-gapped paste-JSON path. Opening-balance lots for
   coins held before the imported history starts. Pure consolidations are
   detected (`inputs == outputs + fee`) and treated as fee-only.
3. **Classify** — every movement needs a kind: receives (`buy`, `mining`,
   `income`, `gift`, `transfer-in`), sends (`sell`, `spend`, `gift`,
   `transfer-out`, `lost`), mixed txs split into a receive leg + a send leg.
4. **Prices** — your PRL/USD table (manual or `date,price_usd` CSV); the engine
   uses the latest price on or before each tx.
5. **Report** — FIFO matching, grain-exact BigInt math, cent-exact USD math,
   short/long-term split at 365 days, income at FMV, fees disposed at zero
   proceeds (added to cost basis).
6. **Export** — disposals CSV, income CSV, full JSON, portable state
   export/import, and a wipe button. Everything lives in localStorage.

## Honesty rules (enforced, not suggested)

- **The report refuses to run** while any tx is unclassified or any needed
  price is missing — the exact gaps are listed, nothing is guessed.
- **FIFO only.** No HIFO/LIFO/specific-ID.
- **Fees add to cost basis**, not as a separate deduction.
- **Gifts simplified:** received at FMV basis; given with no gain recognized.
- **Transfer-ins** book at receipt FMV unless you set the original acquisition
  date (preserves the holding period).
- **Mixed txs** are modeled as two legs — review both.
- **Unconfirmed txs excluded** from the ledger.
- **Read-only:** no keys, no signing, no broadcasting. Not tax advice.

## Build & test

- `node build.mjs` — rebuilds `pearl-tax.bundle.js` (esbuild IIFE,
  `window.PearlTax`; crypto resolves through `../sign/importmap.json`).
- `node --no-warnings --loader ./tests/loader.mjs --test tests/tax.test.mjs` —
  core engine tests (19/19).
- `node --no-warnings --loader ./tests/loader.mjs --test tests/dom.test.mjs` —
  DOM integration tests against the real `index.html` + bundle + `app.js`.

No new cryptography: address validation comes from the audited Sign core
(`../sign/src/crypto.js`).

Built by [@kshot9000](https://x.com/kshot9000). Donations:
`prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`
