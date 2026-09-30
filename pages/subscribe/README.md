# Pearl Subscribe — recurring PRL standing orders, no smart contracts

The chronometer desk: a recurring-payment protocol built from nothing but
Taproot keypath transactions, block-height locktimes, and honest paperwork.

**How it works.** The subscriber defines terms (merchant address, anchor
address, amount per period, period in blocks, start height, fee rate) and the
page produces a tamper-evident `pearl-sub:v1:` descriptor with a 64-bit
fingerprint. The subscriber then:

1. **Funds** — one transaction with one Taproot output per period, each output
   carrying that period's payment plus a fee reserve, signed locally.
2. **Pre-signs** — one payment per funding output: `nLockTime` = that period's
   maturity height, sequence `0xfffffffe`. The network refuses to confirm it
   early; a signed `pearl-sub-bundle:v1:` goes to the merchant.
3. The merchant **broadcasts** each payment when its period matures.
4. The subscriber **cancels** any not-yet-paid period by double-spending that
   funding output back to their anchor address — a race, stated honestly.
5. Anyone **verifies** the bundle: descriptor, locktimes, amounts, change
   outputs, sequences, and every BIP-341 signature re-checked.

**Honest limits (always visible in the UI):**

- The subscriber can always double-spend — a payment can fail. This is consent
  structure, not enforcement.
- The merchant can lose the signed set, so copies and expiry matter.
- Fees are fixed at signing time; a fee spike means a stuck payment.
- Maturity is enforced by the chain as block heights; dates are approximate
  (≈194 s/block).

**Security notes.** Keys are entered locally, the address-match guard refuses
any key that isn't the anchor's, keys are wiped the moment signing finishes,
and every signature is re-verified against the wire before anything is shown.
The page only ever reads the chain (GET) and broadcasts at your explicit click.

**Tests.** 21/21 core tests (`tests/subscribe.test.mjs`) — the locktime-aware
verifier is pinned two ways: byte-identical output to the audited
`buildKeypathTxEx` at locktime 0, and an independent Node `crypto` SHA-256
reconstruction of the BIP-341 digest at nonzero locktime. 4/4 DOM tests boot
the committed bundle and drive service → terms → fund → pre-sign → verify in a
stub DOM, including wrong-key refusal and tamper rejection.

Built by [@kshot9000](https://x.com/kshot9000) for the Pearl ecosystem.
