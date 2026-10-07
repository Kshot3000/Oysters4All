# Pearl Covenant — m-of-n Taproot Multisig Vaults for PRL

Forge **m-of-n Taproot multisig vaults** on Pearl and coordinate cosigner signing
rounds — fully client-side, no backend, no custody, no smart contracts (Pearl has none).

**Live:** https://kshot3000.github.io/Oysters4All/pages/covenant/

## How it works

1. **Forge the covenant** — enter 1–16 cosigner keys (64-hex x-only pubkey or
   12/24-word BIP-39 mnemonic, BIP-86 account key like Pearl Sign). Pick the threshold m.
   The app builds the leaf script
   `<0> <K1> CHECKSIGADD … <Kn> CHECKSIGADD <m> EQUAL`, commits it as a **single
   Taproot leaf under a NUMS internal key** (nothing-up-my-sleeve: `H("PearlCovenantNUMS/v1" || script)`
   lifted to the curve — nobody knows the discrete log, so there is **no keypath backdoor**),
   and derives the vault's `prl1p…` address. Cosigner keys are sorted
   (BIP-67 style), so the address never depends on entry order.
2. **Fund the vault** — the Vault tab shows the address + QR and lists UTXOs via
   Blockbook (or add one manually for air-gapped use).
3. **Build a signing round** — pick one UTXO, add payments, set the fee rate. The
   round is a **tamper-evident JSON payload** (unsigned spend + covenant descriptor +
   partial signatures) you pass to cosigners by copy/paste, QR, or file.
4. **Sign & finalize** — each cosigner verifies the round independently (the digest
   is recomputed from the descriptor and outputs — a forged round is rejected),
   signs locally, and imports the others' signatures. Every signature is
   Schnorr-verified against the round digest before it is accepted. The page
   always shows the round **with the signatures collected so far** (copy or
   download it to hand to the next cosigner). At m-of-n the round finalizes
   into a signed transaction, ready to broadcast via Blockbook.

## Crypto lineage

All primitives (BIP-86 derivation, TapTweak, bech32m, BIP-341 sighash, wire
serialization) are imported from the audited `../sign/src/crypto.js`; the
CHECKSIGADD stack mechanics mirror the audited `../escrow/src/escrow-core.js`
(the 2-of-3 script is asserted **byte-identical** to escrow's in the test suite).
This page adds only multisig composition + the coordinator — no new cryptography.

## Scope & honest limits

- **One UTXO per signing round (v1).** A vault holding several UTXOs is spent one
  UTXO at a time; each round is a complete, independently verifiable transaction.
- Fee is estimated on the worst-case witness (m × 64-byte sigs + (n−m) empty
  vectors), so the actual fee may be marginally lower — never higher.
- No real funds were moved in testing (needs user keys + live chain). Change
  always returns to the vault address.
- Secrets (mnemonics / private keys) live **in memory only** — they are never
  persisted, never enter a descriptor or a signing round.

## Files

- `index.html`, `styles.css`, `app.js` — the app (classic scripts, works from `file://`)
- `src/covenant-core.js` — pure-ESM core (node runs it directly for tests)
- `src/index.js` — bundle entry (`window.PearlCovenant`)
- `pearl-covenant.bundle.js` — committed esbuild IIFE bundle (rebuild: `node build.mjs`)
- `qrcode.min.js` — vendored QR library (offline)
- `tests/covenant.test.mjs` — 11 core tests ·
  `tests/dom.test.mjs` — 6 DOM integration tests ·
  `tests/loader.mjs` — import-map loader

Run tests: `node --no-warnings --loader ./tests/loader.mjs tests/covenant.test.mjs`
(and `tests/dom.test.mjs`).

Built by [@kshot9000](https://x.com/kshot9000) · tips: `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`
