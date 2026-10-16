# Pearl Hedge — Taproot options desk for PRL

Covered calls and protective puts on Pearl, built from pure Taproot script.
Pearl has no smart contracts, so the option is a two-leaf script tree — the
script enforces **collateral routing only**; everything economic is verified
off-chain and stated honestly.

Live: `https://kshot3000.github.io/Oysters4All/pages/hedge/`

## How it works

**Write** — the writer (covered call) or the put holder (protective put) locks
`qty` PRL in a vault committing two leaves under a nothing-up-my-sleeve
internal key derived from `taggedHash("PearlHedgeNUMS/v1", leafE || leafX)`:

- leaf E (exercise): `<expiry> OP_CHECKLOCKTIMEVERIFY OP_DROP <lockHash> OP_EQUALVERIFY <buyer_xonly> OP_CHECKSIG`
- leaf X (refund): `<expiry> OP_CHECKLOCKTIMEVERIFY OP_DROP <writer_xonly> OP_CHECKSIG`

The buyer reveals a 32-byte preimage (`sha256(preimage) == lockHash`) and
signs at/after the expiry block to take the collateral. The writer reclaims
after expiry. Nobody controls the internal key, so there is no keypath bypass.
A protective put is the same vault with the roles labeled swapped (the put
holder locks their underlying; the put writer holds the exercise right).

**Fund** — the canonical descriptor
`pearl-hedge:v1:<hrp>:<C|P>:<writer>:<buyer>:<lockHash>:<qty>:<strike>:<expiry>:<premium>`
(all integers in grains, expiry a block height) re-derives the vault address
deterministically; the sealed commitment `pearl-hedge:v1:<hrp>:<sha256(descriptor)>`
binds every term. Exact vBytes fee math for both spends; 333-grain dust floor.

**Exercise** — buyer side. The desk *first* verifies the strike payment via
Blockbook (GET-only): the txid must pay `strikeGrains` to the writer's address
with ≥1 confirmation. Underpayment is refused loudly with the shortfall shown
in grains. Then the buyer imports their secret (mnemonic/WIF, in-memory only,
wiped after use), reveals the preimage (checked against the lock hash), and the
desk builds a script-path spend (`nLockTime = expiry`, witness
`<sig> <preimage>`), re-verifying the Schnorr signature before exposing hex.

## Builder tip (optional, disclosed)

The buyer exercise form offers an **optional 1% builder tip** to
`prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`: off by
default, disclosed next to its checkbox, and — when the buyer opts in — paid
as its own output out of the exercise (the buyer receives the collateral
minus the fee and the tip), committed by the buyer's signature before
signing. It is waived on testnet and below the 333-grain dust floor. The
writer refund takes no tip parameter at all — it returns the writer's own
locked collateral, so a tip there is impossible by construction.

**Track** — Blockbook lifecycle: unfunded / funded / expired-funded / spent,
plus an expiry countdown in blocks (~194 s/block, labeled approximate).

**Verify** — standalone paste-descriptor verifier: re-derives the vault from
scratch and rules PROVEN / NOT PROVEN (optionally cross-checking a sealed
commitment).

## Honest limits

- Pearl script cannot atomically verify the buyer's off-chain strike payment
  on-chain. The desk verifies the strike txid on Blockbook before the buyer's
  exercise tx is built; the script guarantees only that collateral can go to
  buyer-with-preimage-at/after-expiry or writer-after-expiry.
- No real options were exercised in testing — all exercise/refund flows were
  verified against synthetic UTXOs in a real browser.
- Premiums are pledged off-chain payments the desk never escrows.
- Exercise before the expiry block is impossible on-chain (CLTV); refunds
  before expiry are refused. After expiry there is a race — the writer should
  confirm no buyer exercise before refunding.
- Not financial advice. Test on testnet first.

## Verification

- `node --no-warnings --loader ./tests/loader.mjs tests/hedge.test.mjs` —
  22/22 core tests: pinned canonical vector (descriptor → address → sealed
  hash), refund leaf byte-identical to the audited escrow
  `buildRefundScript`, exercise leaf byte-shape + parser round-trip, control
  blocks verified against the tweaked key, descriptor tamper semantics
  (script fields move the address; economic terms break the seal),
  expiry days→blocks math, dust/economics refusals, full buyer exercise and
  writer refund signing with per-signature re-verification, wrong-preimage /
  pre-expiry / wrong-key / underfunded refusals, strike-payment verification
  (paid, underpaid shortfall in grains, unconfirmed, bad txid), lifecycle
  classification.
- `node --no-warnings --loader ./tests/loader.mjs tests/dom.test.mjs` —
  13/13 DOM tests: page boots with zero console errors under hostile
  localStorage, full write→fund→exercise→verify flow, put role-label swap,
  honest refusals, PROVEN/NOT PROVEN verdicts, @kshot9000 + donation address
  in the footer.
- Real-browser QA (`hidden_files/qa-hedge-browser.mjs`): 44/44 checks green
  in headless Chromium 152 (file:// + CDP), zero console/page errors
  (2026-10-02).

## Crypto lineage

No new cryptography. Key derivation, TapTweak, bech32m, taggedHash,
tapLeafHash, BIP-340/341 sighash come from the audited
`files/pages/sign/src/crypto.js`; script-path spend planning, signing, and
verification come from the audited `files/pages/escrow/src/escrow-core.js`.
The exercise leaf adds `OP_EQUALVERIFY` over a sha256 preimage — a standard
hashlock, not a new primitive.
