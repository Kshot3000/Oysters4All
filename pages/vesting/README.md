# Pearl Vesting — timelocked PRL vesting schedules on Taproot

Non-custodial vesting for Pearl: a funder locks PRL for a beneficiary in
tranches, each with its own Taproot address and an absolute `OP_CHECKLOCKTIMEVERIFY`
claim leaf. No smart contracts (Pearl has none) — pure Taproot script trees,
signed locally in the browser.

Live: `https://kshot3000.github.io/Pearl-Muse-24-7-Ai-builder/pages/vesting/`

## How it works

**Forge** — funder picks a beneficiary (PRL address, raw x-only key, or
mnemonic-derived) and a funder key, chooses linear (total PRL, start, cliff,
vesting days, tranche count) or a custom dated schedule, and marks the schedule
revocable or not. The app derives one P2TR address per tranche. Each address
commits a two-leaf script tree:

- leaf A (claim): `<lock> OP_CHECKLOCKTIMEVERIFY OP_DROP <beneficiary-key> OP_CHECKSIG`
- leaf B (clawback, revocable schedules only):
  `<lock> OP_CHECKLOCKTIMEVERIFY OP_DROP <funder-key> OP_CHECKSIG`

The internal key is a nothing-up-my-sleeve point derived from the tranche's own
scripts — nobody controls it, so there is no keypath bypass; funds can only move
through the claim leaf (after the lock) or the clawback leaf (after the lock, if
revocable).

**Track** — paste a schedule descriptor (`vesting:v1:…`) to re-derive every
tranche address and scan Blockbook for funding and maturity.

**Claim** — beneficiary imports their secret (address-mode claims use the
BIP-86 keypath-tweaked private key behind a PRL address, raw-mode uses the
matching key/mnemonic). One transaction per matured tranche: single-input
script-path spend, exact vBytes fee math, dust refusal. The app signs locally
with Schnorr, **re-verifies every signature before showing any hex**, then you
broadcast through your own Blockbook endpoint.

**Clawback** — on revocable schedules, the funder reclaims still-unclaimed
matured tranches through the clawback leaf with their own mnemonic or WIF.
(Revocable means reclaim *after* maturity — never before.)

## Honest limits

- A forged schedule is only a plan until the funder actually sends PRL to each
  tranche address.
- Claim and clawback transactions move **one UTXO per transaction**; a tranche
  funded with multiple outputs is claimed one output at a time.
- Dust tranches (value ≤ spend cost) are refused rather than burned.
- Blockbook funding scans, chain time, fee rate, and broadcast all go through
  the endpoint you configure — no hosted backend, no keys ever leave the device.
- Testnet-first: the demo key generator is testnet only; never fund a schedule
  you cannot afford to lock.

## Verification

- `node --no-warnings --loader ./tests/loader.mjs tests/vesting.test.mjs` —
  15/15 core tests: locktime shapes, NUMS Taproot trees with independent
  control-block verification, revocable/non-revocable tranches, linear/custom
  planning, dust and tranche-count constraints, descriptor round trips and
  tampering, exact claim-sweep fee math, full beneficiary claim and funder
  clawback signing, wrong-key refusal, raw/address/mnemonic signer modes,
  exact PRL amount parsing (sub-grain and malformed amounts rejected, never
  silently rounded or truncated).
- `node --no-warnings --loader ./tests/loader.mjs tests/dom.test.mjs` —
  8/8 DOM integration tests against the real `index.html` + committed bundle:
  forge → track → claim error paths, step navigation, footer attribution,
  rejection of misparsed custom amounts and impossible calendar dates.

Crypto lineage: key derivation, TapTweak, bech32m, BIP-341 sighash and wire
serialization come from the audited `files/pages/sign/src/crypto.js`;
script-path spend, fee planning, and the CLTV script shape come from the audited
`files/pages/escrow/src/escrow-core.js`. No new cryptography invented.

Built by [@kshot9000](https://x.com/kshot9000) ·
donations: `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`
