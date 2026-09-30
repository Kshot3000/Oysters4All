# Pearl Lend — Collateralized PRL Loans on Taproot Script

The counting-house desk: overcollateralized peer-to-peer PRL loans with **no smart contracts**.
Pearl has no covenants and no oracles, so a Pearl loan is a pawn-shop loan and this desk is honest
about it.

## How it works

1. **Offer** — lender and borrower agree terms: principal P, APR, term (blocks), grace (blocks),
   collateral ratio. Interest is grain-exact integer math, computed once:
   `interest = floor(P · aprBps · termBlocks · 194 / (10_000 · 31_556_952))`.
2. **Lock** — the borrower locks collateral C in a 2-leaf Taproot vault. Collateral must cover the
   **full repayment** *and* the chosen ratio (default 150%).
3. **Fund** — the lender sends P to the borrower's payout address (normal PRL payment).
4. **Track** — read-only Blockbook view: chain height, vault status, blocks to maturity/default.
5. **Repay** — the borrower proposes a repayment (lender gets exactly P+interest, borrower keeps the
   change), signs it, and sends the package to the lender. The lender's desk re-derives the digest
   and re-verifies the borrower's Schnorr signature **before** co-signing. Assembly refuses on any
   bad signature.
6. **Close** — broadcast the repayment; or the lender sweeps via the CSV default leaf after
   term+ grace; or both sign any agreed split (mutual close). A standalone verifier gives
   PROVEN / NOT PROVEN for any descriptor + signed tx.

## The script

Collateral vault: 2-leaf P2TR under a NUMS internal key (`pearl-lend/nums/v1` — keypath spending
is impossible).

- **Repay leaf** (2-of-2): `<borrower> OP_CHECKSIGVERIFY <lender> OP_CHECKSIG`.
  Witness: `[lenderSig, borrowerSig, script, control]` (reverse script-key order).
- **Default leaf** (lender-only after delay): `<termBlocks+graceBlocks> OP_CHECKSEQUENCEVERIFY OP_DROP <lender> OP_CHECKSIG`.
  The input sequence on the claim must equal the committed delay (BIP-68, 1–65535 blocks).

## Crypto lineage

No new cryptography. Key handling, TapTweak, bech32m, BIP-341 sighash and wire serialization come
from the audited `files/pages/sign/src/crypto.js`; the 2-leaf taptree, NUMS construction, digests,
Schnorr sign/verify, witness assembly and vByte math from `files/pages/escrow/src/escrow-core.js`;
coin selection and keypath payments from `files/pages/sign/src/sign-core.js`. The two script
templates are new composition only — `OP_CHECKSIGVERIFY` (0xad) and `OP_CHECKSEQUENCEVERIFY` (0xb2)
verified in `node/txscript/opcode.go`; CSV rules per BIP-68.

## Honest limits

- No oracle by design: principal and collateral are both PRL. Cross-asset loans are out of scope.
- The lender's protection is overcollateralization, not legal recourse.
- CSV maturity is measured from the lock transaction's confirmation height.
- Manual coordination: no messaging, order book, or watchtower. The desk verifies; it does not vouch.
- Keys live in memory only and are wiped after signing.

## Tests

- `node --no-warnings --loader ./tests/loader.mjs tests/lend.test.mjs` — 15 core tests.
- `node --no-warnings tests/dom.test.mjs` — full wizard flow in a stub DOM.
- `node tests/lend.browser.qa.mjs` — real headless-Chromium QA (file:// + CDP).

## Build

`node build.mjs` regenerates `pearl-lend.bundle.js` (`window.PearlLend`) from `src/`.

---

Built for the Pearl blockchain (PRL) · [@kshot9000](https://x.com/kshot9000) ·
`prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`
