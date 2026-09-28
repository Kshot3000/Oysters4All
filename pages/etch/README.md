# Pearl Etch — PRL-20 Inscription Composer

Engrave PRL-20 `deploy`, `mint` and `transfer` inscriptions into the Pearl
blockchain. A 5-step wizard — **Compose → Key → Commit → Reveal → Done** —
builds the Taproot commit/reveal transaction pair, signs both legs locally,
and broadcasts. Your key never leaves the page.

Live: https://kshot3000.github.io/Pearl-Muse-24-7-Ai-builder/pages/etch/

## How it works

1. **Compose** — build one or more PRL-20 operations. Every field is
   validated against the PRL-20 v0 spec (canonical integer strings, ticker
   rules, no duplicate fields, `dec` 0–18, exact PRLS launch params).
2. **Key** — generate a fresh BIP-39/BIP-86 key or import mnemonic/WIF.
   Mainnet (`prl…`) or testnet (`tprl…`).
3. **Commit** — Etch derives the Taproot commit address from your key and
   the inscription script, then builds + signs the funding transaction.
4. **Reveal** — once the commit confirms, Etch builds + signs the
   script-path reveal that publishes the envelopes on-chain. A
   "Parse like an indexer" button round-trip-verifies the witness with the
   same envelope-parsing rules the Pearlscriptions indexer uses.
5. **Done** — summary with links to Pearl Gallery and the block explorer.

## Protocol facts (verified, not from memory)

- Envelope shape and PRL-20 v0 JSON rules:
  `Pearlscriptions/indexer` `docs/prl-20-v0-spec.md`
- Taproot script-path reveal construction:
  `docs/pearl-taproot-inscription-proof.md`
- Multi-envelope batches: one leaf, envelopes in script order; pure mint
  batches share one owner output, mixed batches map one owner output per
  envelope (spec, "Batch Envelopes").
- PRLS launch: 1 PRL fee per credited mint to
  `prl1ppmla838yflfcsm5vr6lfgvfclf4fgn3puja70cke4wqqkl6vflaq3cn7ea`
  (`release-manifest.example.json`); Etch adds the fee output automatically
  on mainnet and warns on testnet.
- Signing/keys/fees: audited `pages/sign/src/crypto.js` (BIP-86, BIP-341,
  exact vBytes math) — Etch adds composition only, no new crypto.

## Honest limits

- You need a funded Pearl address and a reachable blockbook (default: the
  public `https://blockbook.pearlresearch.ai`) — or paste UTXOs manually.
- The commit must confirm before the reveal is valid; Etch can detect the
  commit UTXO from the commit address.
- No real inscriptions were published during testing (would require user
  funds); the full cycle is proven by the test suite below.

## Tests

13/13 pass (`node --no-warnings --loader ./tests/loader.mjs --test tests/etch.test.mjs`):
spec JSON rule matrix, batch script byte-identity with the audited single
builder, commit-address derivation, full commit→reveal cycle with Schnorr
signature verification, indexer-style witness round-trip, exact vBytes
accounting, PRLS fee program vs the release manifest.

## Development

- `src/etch-core.js` — pure composer core (imports crypto from
  `../sign/src/crypto.js`)
- `pearl-etch.bundle.js` — committed esbuild IIFE bundle (`node build.mjs`
  to rebuild); loaded with `?v=` cache-busting
- `app.js` — UI wiring; `styles.css` — engraved-copper-on-obsidian theme

---

Tip the build: `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d` ·
[@kshot9000](https://x.com/kshot9000)
