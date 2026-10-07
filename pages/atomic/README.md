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

## Run the tests

```bash
cd pages/atomic
node --no-warnings --loader ./tests/loader.mjs --test tests/atomic.test.mjs   # 15/15 core tests
node --no-warnings --test tests/dom.test.mjs               # DOM/id cross-check + init smoke
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
