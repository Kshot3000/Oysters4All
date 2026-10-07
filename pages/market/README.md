# Pearl Bazaar — PRL-20 Marketplace

The trading venue for PRL-20 tokens on the Pearl blockchain. Sellers list
**transfer lots** (inscription UTXOs); buyers fill them with **atomic swaps**.
No escrow, no custody, no middlemen.

Live: <https://kshot3000.github.io/Oysters4All/pages/market/>

## How it works

A PRL-20 transfer inscription debits the sender's available token balance and
creates a **lot** — a quantity of tokens controlled by the inscription UTXO.
Moving that UTXO transfers the lot; ordinary PRL movement does not move PRL-20
balances. The marketplace is an application layer over these lots.

1. **List.** The seller picks a lot they own and signs a listing with
   `SIGHASH_SINGLE | ANYONECANPAY` (`0x83`). The presignature commits to the
   lot outpoint, the lot's PRL value, and exactly one output: the price paid to
   the seller. It cannot be altered or replayed onto a different lot.
2. **Fill.** Any buyer verifies the presignature locally, attaches their own
   PRL funding inputs (inscription-protected UTXOs are excluded), and
   broadcasts one transaction: input 0 spends the lot (carrying the seller's
   `sig || 0x83` witness element), the buyer's inputs are signed
   `SIGHASH_DEFAULT`, output 0 pays the seller the exact listed price, output 1
   moves the lot UTXO to the buyer.
3. **Settle.** The lot UTXO changes hands on Pearl. The Pearlscriptions indexer
   sees the move and credits the token balance to the buyer.

## The 0x83 signature model

- The seller presigns **before** any buyer exists: `ANYONECANPAY` means the
  signature covers only the lot input; the buyer appends their inputs later.
- `SINGLE` means the signature covers only output 0 (price → seller); the
  buyer adds the lot-transfer output and change afterward.
- The buyer **cannot** change the price or redirect it — that would invalidate
  the seller's signature. The seller **cannot** take the buyer's funds — the
  buyer's inputs are signed by the buyer's key only.
- The presignature does **not** commit to the off-chain `tick`/`amt` metadata.
  The UI therefore cross-checks ticker, amount, owner, outpoint, script and PRL
  value against the live indexer record before allowing a fill, and refuses to
  proceed on any mismatch.

## Repository layout

```
pages/market/
  index.html      token directory, top movers, featured listings, settings
  token.html      price chart, order book, trade tape, bids, fill flow
  portfolio.html  my listings / bids / trades (local board)
  list.html       4-step listing wizard (identity, lot, price, review+sign)
  app.js          page logic (classic script, uses window.PearlMarket)
  styles.css      Pearl brand base (shared family look)
  market.css      bazaar components (book, chart, wizard, cards)
  market.bundle.js  built bundle -> window.PearlMarket (esbuild IIFE)
  importmap.json  dev import map
  build.mjs       bundle builder (node build.mjs)
  src/
    crypto.js       audited launcher core: schnorr, taproot, sighash, wallets,
                    tx build/sign, inscription commit/reveal, blockbook client
    market-core.js  listings (make/sign/verify), fill assembly, coin selection,
                    listing codec, transfer-lot planner, indexer clients,
                    localStorage board/bids/trades/settings, demo data
    matching.js     price-time priority engine: exact BigInt compares, partial
                    fills, multi-level sweep, self-trade prevention, expiry
  lib/            vendored noble/* dependencies (file-safe bundling)
  tests/
    verify.mjs      99 core assertions (protocol, crypto, engine, board)
    smoke.mjs       50 headless UI assertions (jsdom, real pages+bundle)
    loader.mjs      test loader
  README.md       this file
```

## Local board vs demo vs live

- **Local board** (always on): listings, bids and trades you create are stored
  in this browser's `localStorage` only. *"Local board — listings are only
  visible in this browser; no listing relay configured."* Cancel/delist removes
  them from the board; the on-chain lot is untouched.
- **Demo mode** (on by default until you configure the indexer): deterministic
  simulated tokens, order books and trade tape. *"DEMO — simulated order book,
  no real funds."* Demo fills are simulated locally.
- **Live**: turn demo off and set the Pearlscriptions indexer base URL (and
  Blockbook for UTXOs/broadcast) in Settings. Listings are still local-only
  until a relay exists, but fills broadcast real transactions.

**No real trades were executed in testing.** Live trading requires your own
funds and a reachable indexer. Keys are memory-only: pasted mnemonics / WIF /
hex keys are never stored, never leave the page, and are wiped on reload.

## Build & test

```bash
cd pages/market
node build.mjs                                   # rebuild market.bundle.js
node --no-warnings --loader ./tests/loader.mjs ./tests/verify.mjs   # 99 core tests
node --no-warnings tests/smoke.mjs              # 50 headless UI tests (jsdom)
```

Both suites must pass before shipping.

## Threat model

- A malicious listing could lie about `tick`/`amt` (not covered by the 0x83
  signature). Mitigation: the fill flow verifies the presignature **and**
  cross-checks the lot against the indexer; mismatches block the fill.
- A seller could double-spend the lot after listing. Mitigation: the fill is
  atomic — either the whole swap confirms or nothing does. The UI re-checks
  the lot is still the seller's before signing.
- Buyer funding must never spend inscription UTXOs. Mitigation: UTXOs flagged
  `protected` by the indexer are excluded from coin selection.
- Never paste a key on a machine you don't trust. The wizard works with
  address-only mode until the signing step.

## Crypto lineage

`src/crypto.js` is derived from the audited PRL-20 launcher core, vendored
with its `noble-curves`, `noble-hashes`, `@noble/secp256k1` ecosystem
(`@noble/curves`, `@noble/hashes`, `@scure/base`, `@scure/bip32`,
`@scure/bip39`) under `lib/`. The BIP-341 keypath digest layout
(`keypathSigDigestEx`, including `SIGHASH_SINGLE | ANYONECANPAY`) was checked
against Pearl's Go consensus implementation
(`node/txscript/sighash.go`): for Taproot `ANYONECANPAY` the aggregate
prevout/amount/script/sequence hashes are omitted while the signed input's full
outpoint, amount, scriptPubKey and sequence are included; `SIGHASH_SINGLE`
appends the single output hash after the input-specific section.

## Support

Tips keep the 24/7 builder running —
`prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`
· [@kshot9000](https://x.com/kshot9000)
