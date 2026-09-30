# Pearl Predict — prediction markets on Pearl Taproot

Prediction markets with **no smart contracts**. A market is a question with 2–4 named
outcomes. Each outcome gets **one deterministic Taproot funding address** holding a
2-leaf taptree:

- **Leaf A (award):** `<arbiter_xonly> OP_CHECKSIG` — byte-identical to the audited
  Pearl Bounty award leaf. The arbiter's signature authorizes the proportional payout.
- **Leaf B (refund):** `<resolveH> OP_CHECKLOCKTIMEVERIFY OP_DROP <refund_xonly> OP_CHECKSIG`
  — byte-identical to the audited Pearl Escrow refund leaf. After the resolution
  deadline the refund sweep key can return every funder's stake.

Traders fund their chosen outcome's address. After the trading deadline the arbiter
signs **one proportional-payout transaction** spending every tracked funding UTXO
(winners' and losers' pots alike); each winning-outcome funder receives
`stake × totalPot ÷ winningPot` minus the fee, grain-exact via largest-remainder.
If the market voids, the refund leaf sweeps each pot back to its recorded funder
(`nLockTime = resolveH`).

Five steps: **Create → Fund → Resolve → Track → Verify**.

## The descriptor

```
pearl-predict:v1:<hrp>:<marketHash>:<nOutcomes>:<tradeH>:<resolveH>
```

`marketHash` = SHA-256 over the canonical market JSON (question, outcomes, resolution
source, deadlines, arbiter x-only key, refund x-only key, network). Post the descriptor
*before* anyone funds; anyone can recompute it from the market JSON and re-derive
every funding address. The Verify tab answers **PROVEN** or a loud **NOT PROVEN**.

## Crypto lineage — no new cryptography

- Leaf A built with the audited `buildAwardScript` from `../bounty/src/bounty-core.js`;
  Leaf B built with the audited `buildRefundScript` from `../escrow/src/escrow-core.js`.
  The test suite asserts byte-equality with both audited functions.
- Taptree, control blocks, NUMS lift loop, BIP-340 sign/verify, bech32m, and the
  BIP-341 sighash shape are the audited escrow/sign lineage. The multi-input sighash
  is proven byte-equal to the audited single-input digest for the 1-input case.
- The **only** new local construction is the NUMS internal-key derivation with the
  `"PearlPredictNUMS/v1"` domain tag:
  `lift_x(SHA-256("PearlPredictNUMS/v1" ‖ marketHash ‖ u32le(outcomeIndex)))`,
  mirroring the escrow/bounty pattern. Nobody knows the discrete log, so keypath
  spending is impossible — coins move only through the two script leaves.

## Honest limits (also shown on the page, always visible)

- The **arbiter is trusted** to sign honest payouts. The scripts prove the arbiter
  *authorized* a payout — they cannot prove it was correct.
- Positions are **manually tracked** from txids you paste or import; the desk cannot
  see funding it was never told about.
- The refund sweep key (default: the arbiter) can sweep voided pots after `resolveH`;
  the void bundle returns each recorded funder their exact stake minus a pro-rata fee.
- No live market runs here — no order book, no odds feed, no automatic settlement.
- Blockbook (`https://blockbook.pearlresearch.ai` default) is a third-party read source.
- The page never moves real PRL without your keys and an explicit confirmation.
- Payout addresses are recorded per position and are **not** derivable from chain data —
  confirm them with each trader (the txid importer prefills from the funding input
  only as a best-effort hint).

## Run the tests

```bash
cd pages/predict
node --no-warnings --loader ./tests/loader.mjs --test ./tests/predict-core.test.mjs
node --no-warnings --loader ./tests/loader.mjs --test ./tests/dom.test.mjs
node build.mjs   # rebuild pearl-predict.bundle.js after touching src/
```

## Files

- `index.html`, `styles.css`, `app.js` — the desk (after-hours trading floor theme)
- `src/predict-core.js` — pure-ESM core (node runs this directly in tests)
- `src/index.js` — `window.PearlPredict` browser entry (plain IIFE, no `globalName`)
- `pearl-predict.bundle.js` — committed esbuild bundle (`?v=1`)
- `build.mjs` — esbuild with the sign importmap plugin
- `tests/` — core + DOM suites
