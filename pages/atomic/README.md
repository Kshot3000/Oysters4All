# Pearl Atomic — cross-chain HTLC desk for PRL

A self-custody desk for hash-time-locked atomic swaps on Pearl. One party (the
**maker**) locks PRL into a Taproot HTLC that can be claimed by the counterparty
(**taker**) only with the secret preimage before a timeout, or refunded to the
maker after the timeout. The other chain's leg is tracked by reference — Pearl
has no smart contracts, so this desk structures and verifies the PRL side and
leaves the foreign leg to whatever HTLC-capable rails the counterparty uses.

Live: `https://kshot3000.github.io/Oysters4All/pages/atomic/`

## What it does

Six-step wizard (Deal → Contract → Fund → Track → Settle → Verify):

- Maker/taker role setup, local key generation, secret + hash-lock creation
- Two-leaf Taproot HTLC with a NUMS (nothing-up-my-sleeve) internal key —
  no party-controlled keypath, so neither side can bypass the script leaves
- Claim leaf: `SHA256 <hash> EQUALVERIFY <claimer> CHECKSIG`;
  refund leaf: `<timeout> CHECKLOCKTIMEVERIFY DROP <refundee> CHECKSIG`
- Tamper-evident `pearl-atomic:v1:` descriptors with 64-bit fingerprints —
  every field is re-derived from the contract on import
- Funding with live Blockbook reads plus a manual-outpoint path, and
  on-chain state tracking (funded / spent / unspent)
- Claim and refund planning with fee/vByte estimates, local Schnorr signing,
  air-gapped unsigned bundles, and a standalone verifier

All cryptography runs locally in your browser. The page only reads the chain
(GET) until you press **Broadcast**.

## Builder tip (optional, disclosed)

Settling a claim offers an **optional 1% builder tip** to the builder
address `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`:
the Settle step's Claim form has a checkbox (unchecked by default) that
adds the tip as its own output of the claim transaction, paid out of the
claimed amount — the claimer receives the HTLC value minus the network
fee and the tip, stated in those words next to the checkbox. The tip is
computed by `builderTipGrainsFor` (1% floor in BigInt, mainnet only,
waived when the 1% would fall below the 333-grain dust floor instead of
rounded up) and is added before signing, so the script-path sighash
commits to it — it cannot be added or skimmed afterwards, and assembly
re-derives the builder program from the address constant and refuses a
flagged tip that does not pay it exactly. With the box unchecked the
claim plan is identical to the pre-tip planner. **Refunds never carry a
tip** — the refund planner takes no tip parameter at all, since it
returns the maker's own locked funds.

## Run the tests

```bash
cd pages/atomic
node --no-warnings --loader ./tests/loader.mjs --test tests/atomic.test.mjs   # 19/19 core tests
node --no-warnings --test tests/dom.test.mjs               # 4/4 DOM tests: id cross-check + init smoke + tip wiring
```

Browser bundle is committed; rebuild it after editing `src/`:

```bash
node build.mjs
```

## Honest caveats

- **No real cross-chain swap has been executed against this build.** The
  machinery (scripts, signing, sighash, serialization, broadcast) is verified
  by test and in-browser QA, but end-to-end atomicity against a real
  counterparty on another chain has not been exercised with real funds.
- Blockbook servers are public infrastructure; chain reads can lag or fail —
  the desk surfaces failures rather than guessing.
- Atomicity is conditional, not magic: if the foreign leg is not also secured
  by the same hash lock and a compatible ordering, the PRL side cannot enforce
  it. The wizard warns about timeout ordering explicitly.
- The claimer and refundee keys must be real counterparty keys — the desk
  never supplies them for you.

## Attribution

Built by [@kshot9000](https://x.com/kshot9000). Tips: `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`
