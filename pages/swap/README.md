# Pearl Swap — trustless PRL ⇄ BTC Taproot HTLC atomic-swap coordinator

Trustless cross-chain atomic swap coordination between Pearl (PRL) and Bitcoin
(BTC). Alice locks PRL in a Taproot HTLC; Bob mirrors it with a BTC HTLC using
the *byte-identical* claim leaf; Bob claims the PRL by revealing the preimage
on-chain; Alice reads the preimage from Bob's claim witness and claims the BTC.
If the swap aborts, each side refunds after its own timelock.

**Honest limits (also shown on the page):**
- No real swaps were executed in testing — every flow was verified with
  synthetic UTXOs only. The cryptography is real; the mainnet miles are not.
- The Bitcoin side is built by the counterparty's own tooling. This page never
  builds or signs Bitcoin transactions — it exports the exact BTC mirror
  template (scripts, parameters, step-by-step instructions) for independent
  reproduction.
- UTXO lookup, fee estimates, tip height, and broadcast need a live Blockbook
  endpoint (configurable, defaults per network).
- The preimage is the money: whoever reveals it claims the PRL.

## How it works

Script tree (two Taproot leaves under a deterministic NUMS internal key
`H("PearlSwapNUMS/v1" || claimLeafHash || refundLeafHash)`):

- **Claim leaf:** `OP_SHA256 <H> OP_EQUALVERIFY <bob_xonly> OP_CHECKSIG`
  — Bob claims with the 32-byte preimage + his Schnorr signature.
- **Refund leaf:** `<T1> OP_CHECKLOCKTIMEVERIFY OP_DROP <alice_xonly> OP_CHECKSIG`
  — Alice refunds after Pearl height T1, with `nLockTime = T1` and input
  sequence `0xfffffffe`.

Rules: **T1 (PRL refund) must be strictly greater than T2 (BTC refund
deadline)** — hard guard at proposal time, plus a warning when the gap is
below 144 blocks. The BTC mirror derives a suggested Bitcoin refund height
from live Pearl/Bitcoin tips (194s vs 600s block pacing).

## Page steps

1. **Propose** — Alice generates the preimage (CSPRNG) or pastes it; Bob can
   join with the secret hash alone. Emits the swap address, compact
   descriptor (`swap:v1:…`), shareable JSON, and QR.
2. **Lock** — funder key from mnemonic/WIF/hex → UTXO select (Blockbook or
   manual) → local keypath lock tx build with exact fee accounting, change,
   per-signature re-verification, optional broadcast. Includes the Bitcoin
   mirror template (bc1p/tb1p address derivation, scripts, instructions).
3. **Track** — Blockbook scan: funding state, lifecycle classification
   (awaiting funding / locked / claimed / refunded / unknown spend),
   timelock countdowns, and manual tx-hex classification.
4. **Claim** — Bob builds the script-path claim (preimage + key guards, local
   sign + verify), broadcasts; Alice extracts the preimage from Bob's claim
   witness and gets BTC-side follow-up steps.
5. **Refund** — Alice builds the CLTV refund; refused before T1, refuses Bob's
   key, hard-codes `nLockTime = T1`.

Keys never leave the browser (in-memory only; secret fields are cleared after
use). Every built transaction is signed and re-verified locally.

## Files

- `index.html` — the app (references `styles.css?v=1`, `qrcode.min.js?v=1`,
  `pearl-swap.bundle.js?v=1`, `app.js?v=1`)
- `styles.css` — "collision chamber" theme (deep-space navy, PRL-cyan vs
  BTC-magenta particle streams)
- `app.js` — UI wiring for all five steps
- `src/swap-core.js` — protocol core (scripts, taptree, sighash, spends,
  mirror template); reuses audited crypto from `../sign` and `../escrow`
- `build.mjs` — esbuild bundling into `pearl-swap.bundle.js`
- `qrcode.min.js` — vendored QR renderer (copied from sibling page)
- `tests/swap.test.mjs` — core tests · `tests/dom.test.mjs` — real-HTML DOM tests

## Tests (2026-09-29)

- Core: **18/18** — script byte vectors, NUMS determinism, control-block
  verification, known-answer SHA-256, descriptor round-trip + tamper
  detection, timelock guards, wrong-preimage/wrong-key refusals, lock tx +
  sig re-verification, synthetic lock→claim and lock→refund flows, sighash
  cross-checks, preimage extraction, lifecycle classification, BTC mirror.
- DOM: **12/12** — boots real index.html + bundle + app.js in a VM harness;
  propose→lock→track→claim→refund, guard refusals, attribution.
- Real Chromium (headless, CDP, stubbed Blockbook): **27/27** checks, zero
  console/page errors — full flow incl. QR render, BC1P mirror, preimage
  extraction, maturity guard.

---

Built by [@kshot9000](https://x.com/kshot9000) ·
`prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`
