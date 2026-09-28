# Pearl Notary — Proof-of-Existence Timestamping on Pearl

Seal any document's SHA-256 fingerprint into the Pearl blockchain with a
Taproot inscription. Later, anyone can re-hash the document and verify it
against the on-chain envelope — the chain is the witness.

Live: https://kshot3000.github.io/Pearl-Muse-24-7-Ai-builder/pages/notary/

## How it works

1. **Document** — drop a file or paste text. The SHA-256 fingerprint is
   computed on your machine; the document itself never leaves the browser.
   A notary record is composed:
   `{"p":"prl-notary","v":1,"algo":"sha256","hash":"…","filename":"…","size":…,"ts":"…","title":"…","by":"…"}`
   with strict validation (64-char lowercase hex, UTC ISO-8601 timestamp,
   field length caps, no unknown fields).
2. **Key** — BIP-86 key, generated or imported (mnemonic/WIF).
3. **Commit** — the record is sealed in a Taproot envelope (marker
   `prl-notary`, content-type `application/json`) and committed to via a
   Taproot commit transaction. The envelope marker is deliberately distinct
   from `prl-20` so PRL-20 indexers never mistake it for a token operation.
4. **Reveal** — the commit output is spent via the script path, publishing
   the envelope on-chain. The witness is parsed exactly like an indexer
   would parse it, and the fingerprint is re-checked.
5. **Seal** — a certificate of existence: fingerprint, envelope, commit and
   reveal txids, confirmation height — copyable, downloadable, printable.

A separate **Verify** tab re-hashes a document, fetches the reveal tx from
blockbook, parses its witness, and returns a match/mismatch verdict.

## Crypto lineage (no new crypto)

- All key derivation, TapTweak, bech32m, BIP-341 sighash and wire
  serialization: `../sign/src/crypto.js` (audited).
- Commit/reveal construction and indexer-style witness parsing:
  `../etch/src/etch-core.js` (exercised by its own suite). **2026-09-28 fix:**
  the envelope tokenizer decoded OP_PUSHDATA4 lengths with a signed JS
  `<< 24`, which wrapped negative on high-bit lengths occurring naturally
  inside random Schnorr signatures and looped forever (OOM). Now decodes
  unsigned and refuses corrupt pushes. Regression tests in both suites.

## Tests

- `tests/notary.test.mjs` — 16/16: SHA-256 vectors, record validation
  matrix, envelope structure (marker ≠ prl-20), 520-byte chunking,
  commit/reveal planning + exact fee accounting, full sign cycle with
  Schnorr verification, indexer-style witness round-trip, match/mismatch
  verification, non-notary rejection, seal certificate shape.
- `tests/dom.test.mjs` — 3/3: boots the real `index.html` + committed
  `pearl-notary.bundle.js` + `app.js` in a DOM shim and drives the full
  wizard (document → key → commit → reveal → seal), the hostile-bytes
  tokenizer case through the shipped bundle, and the footer donation/X links.

Run: `node --no-warnings --loader ./tests/loader.mjs tests/notary.test.mjs`
(and `tests/dom.test.mjs`). Zero new dependencies.

## Honest limits

- No real notarization was executed in testing (needs user funds + a live
  indexer/node); commit must confirm before the reveal is valid.
- The app is a timestamping tool, not legal notarization — nothing here is
  legal advice.

---
Built by [@kshot9000](https://x.com/kshot9000) for the Pearl ecosystem.
Donations: `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`
