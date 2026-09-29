# Pearl Stream — continuous PRL payment streaming

Payroll-style PRL streaming on Taproot: a funder streams PRL to a beneficiary at a fixed
rate, tick by tick. Each tick is its own P2TR address that unlocks at
`start + i × tickSeconds` (unix timestamps). The beneficiary sweeps **all matured ticks
in one multi-input batch-claim transaction**; the funder can cancel and claw back
unmatured ticks in one transaction.

**Live:** `pages/stream/` in this repo (GitHub Pages)

## How it works

1. **Forge** — funder sets beneficiary (PRL address, 64-hex x-only key, or mnemonic),
   rate (PRL per tick, ≥ dust), tick interval, start time, tick count (1–256), and whether
   the stream is revocable. Every tick gets its own Taproot address under a NUMS internal
   key committing a two-leaf tree:
   - leaf A (claim): `<lock> OP_CHECKLOCKTIMEVERIFY OP_DROP <beneficiary-key> OP_CHECKSIG`
   - leaf B (clawback, revocable only): `<lock> OP_CHECKLOCKTIMEVERIFY OP_DROP <funder-key> OP_CHECKSIG`

   The internal key is a nothing-up-my-sleeve point — no keypath backdoor. Each tick pays
   exactly the rate; the stream total is `rate × N` exactly.
2. **Track** — paste the stream descriptor (`stream:v1:<hrp>:<b>:<f>:<r|n>:<mode>:<rate>:<tick>:<start>:<N>`)
   to re-derive every tick address (tamper-evident), scan funding + maturity via Blockbook,
   and watch the live accrual dashboard: streamed-so-far / claimable-now / remaining.
3. **Claim** — the beneficiary imports their secret (mnemonic or WIF, never stored), ticks
   matured funded ticks, supplies each UTXO (Blockbook scan or manual paste), and builds
   **one** batch-claim transaction: n inputs, one P2TR output, `nLockTime` = max tick lock,
   every input sequence `0xfffffffe`. Exact multi-input vBytes fee math, dust refusal,
   and every Schnorr signature re-verified against its input's own BIP-341 digest before
   hex is exposed.
4. **Cancel** — on revocable streams the funder claws back **unmatured** ticks in one
   transaction (matured-but-unclaimed ticks stay claimable). The cancel tx carries
   `nLockTime` = the last selected tick's unlock, so it confirms only once that time
   passes — it pre-empts future claims, it does not claw back PRL today.

## Crypto notes

- Reuses the audited `pages/vesting` per-tick forge, beneficiary key handling, and
  maturity logic; BIP-341 sighash/serialization primitives from `pages/sign` and
  `pages/escrow`.
- The one new construction is the **n-input script-path sweep**: `batchScriptPathSigDigest`
  generalizes the sighash over all inputs (`sha_prevouts/amounts/scriptpubkeys/sequences`
  over every input; per-input message fixes the input index and that input's leaf hash).
  The serializer independently recomputes every digest and cross-checks the signer's.
- The test suite recomputes each input's digest with Node's `node:crypto` SHA-256
  (independent of the noble implementation used in core) and verifies every emitted
  signature against it.

## Honest limits

- Nothing streams until the funder actually sends PRL to each tick address.
- Maturity is read from Blockbook's latest block time (or your local clock, labeled).
- A claim broadcast before maturity is rejected by the network.
- Test on testnet first. Not legal or tax advice.

## Tests

- `node --no-warnings --loader ./tests/loader.mjs tests/stream.test.mjs` — 13 core tests
- `node --no-warnings --loader ./tests/loader.mjs tests/dom.test.mjs` — 8 DOM tests
  (real `index.html` + committed bundle + `app.js` against a minimal DOM shim, hostile localStorage)

Built by [@kshot9000](https://x.com/kshot9000) for the Pearl ecosystem.
Donations: `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`
