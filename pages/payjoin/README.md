# Pearl Payjoin

A **BIP-78 two-party transaction desk for PRL** — the lab where a receiver and a
sender build a payjoin together: one transaction, inputs from both wallets,
breaking the common-input-ownership heuristic on Pearl's Taproot rails.

## The five steps

1. **Receiver** — publishes the offer: amount, `prl1…` payment address, and fee
   terms (`maxadditionalfeecontribution`, `minfeerate`, output-substitution
   flag). Output: the template PSBT (zero inputs, one payment output), the
   offer envelope JSON, and the `?v=2&…` endpoint query string a real payjoin
   server would serve.
2. **Sender** — validates the template, funds it with their own UTXOs (manual
   entry or mnemonic-derived BIP-86 addresses with live blockbook lookup),
   pays an exact fee, and **signs + finalizes every input** (BIP-78's
   "the original").
3. **Proposal** — the receiver's turn: the desk re-verifies the sender's
   signatures, adds the receiver's input (signed + finalized), inserts it at a
   random position, and computes the exact fee split. Deductions from the
   payment output are bounded by `maxadditionalfeecontribution` — anything more
   is refused, loudly.
4. **Verify** — the sender's checklist: the full BIP-78 sender checklist as
   15 PASS/FAIL checks (fee not decreased, version/locktime/sequences
   unchanged, inputs preserved in order, sender inputs clean, receiver
   signatures re-verified, no non-witness UTXOs, no keypath metadata, outputs
   preserved, fee deduction within bounds, substitution rules, sane added
   outputs, minfeerate floor, structural validity). A failing proposal must
   never be signed.
5. **Sign** — re-verifies first (refuses to sign on any failure), re-signs the
   sender inputs with fresh SIGHASH_DEFAULT signatures, finalizes everything,
   and emits the broadcast-ready transaction hex + txid. Broadcast to Pearl
   mainnet via the public blockbook is double-gated behind an explicit
   confirmation checkbox.

A **lab self-test** button runs the whole protocol in-page with the public
BIP-39 test vectors — offer → original → proposal → 15 checks → sign → final
tx — then independently re-verifies every witness signature and recomputes the
txid.

## Crypto lineage (no new cryptography)

All cryptography comes from the audited siblings, verbatim:

- `../sign/src/crypto.js` — bech32m `prl1` addresses, BIP-86 derivation
  (`m/86'/808276'/0'/0/i`), BIP-340/341 keypath schnorr, `keypathTxVBytes` fee
  math, blockbook REST helpers.
- `../psbt/src/psbt-core.js` — the full BIP-174 v0 codec: parse/serialize,
  `signPsbtInput` (per-signature re-verification), `taprootSighash`,
  `finalizePsbtInput`, `extractTx`.

`src/payjoin-core.js` adds only the BIP-78 protocol layer: offer/template
building, the sender's funding flow, the receiver's proposal flow with exact
integer-grain fee policy, the 15-check verifier, and finalization. Protocol
behavior is grounded in BIP-78 (`bip-0078.mediawiki`).

## Build & test

```sh
node build.mjs   # -> pearl-payjoin.bundle.js (committed; plain IIFE, no globalName)
node --no-warnings --loader ./tests/loader.mjs --test 'tests/*.test.mjs'
```

- `tests/payjoin.test.mjs` — 43 tests: amount/rate parsing, `prl1` handling,
  offer + template validation, the full lab E2E with fixed test keys (fee math
  pinned to the grain: 308 → 510, deduction 0/148 cases), every tamper case
  failing its exact expected check, and the sign flow with per-input witness
  re-verification.
- `tests/dom.test.mjs` — 69 checks: bundle boots in a VM and exposes the full
  surface, the in-VM `labSelfTest()` runs green, HTML id coverage for
  `app.js`, 5 tabs + deep links, `?v=` cache-busters, honest-limits copy,
  footer attribution, and the teal/cyan duet theme.

## Honest limits

- A **lab, not a wallet and not a server**: exact protocol steps with real
  cryptography, but no payjoin endpoint here and no coin selection beyond what
  you enter.
- **Keys never leave the page.** Mnemonics are in-memory only; wipe buttons
  included; nothing is persisted (no localStorage, no cookies).
- **Network calls are opt-in and labeled** (UTXO lookups, fee estimates,
  broadcast via the public Pearl blockbook).
- **Broadcast is double-gated** behind an explicit confirmation checkbox.

Built by [@kshot9000](https://x.com/kshot9000) ·
`prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`
