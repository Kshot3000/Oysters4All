# Pearl Circle — Rotating Savings Club (ROSCA) Desk for PRL

Built by [@kshot9000](https://x.com/kshot9000) for the Pearl ecosystem. Donations: `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`

N members each contribute C PRL per round, for N rounds. Each round exactly one
member takes the whole pot (N×C). The payout order is drawn by a commit-reveal
lottery nobody can game; each round's pot sits in a Taproot escrow with a
winner-claim leaf and an m-of-n timeout-refund leaf. Pure Taproot — Pearl has
no smart contracts — and no new cryptography.

## How it works

1. **Found** — the organizer defines members (bech32m `prl1…`/`tprl1…` P2TR
   addresses, 64-hex x-only keys, or BIP-39 mnemonics converted locally),
   the per-round contribution (grain-exact), the round length in blocks, the
   start height, the refund grace period, and the refund threshold m. This
   produces a tamper-evident setup descriptor `pearlcircle:v1:<payload>` with
   a 64-bit fingerprint.
2. **Lottery** — each member generates a random 32-byte secret and publishes
   `sha256(secret)`. Once all commitments are public, secrets are revealed and
   the payout order is computed as members sorted by
   `sha256(secret_0‖…‖secret_{n-1}‖u32le(memberIndex))`. Anyone with the
   commitments + reveals re-derives the same order. The lottery runs *before*
   funding: round addresses commit to each round's winner, so they cannot be
   derived until the order exists.
3. **Fund** — each round's address is a 2-leaf taptree under a NUMS internal
   key (domain `PearlCircleNUMS/v1` — nobody knows the discrete log, so
   keypath spending is impossible):
   - leaf A (winner claim): `<winnerXOnly> CHECKSIG` — byte-identical shape to the audited Pearl Bond transfer leaf;
   - leaf B (timeout refund): `<lock> CLTV DROP <0> <K1> CHECKSIGADD … <Kn> CHECKSIGADD <m> EQUAL` — the audited Pearl Covenant multisig leaf over all member keys (sorted), guarded by the round's lock height.
   
   Every member sends exactly C to each round address.
4. **Claim & Refund** — the winner claims the full pot via leaf A (no timelock;
   claimable as soon as the pot is full). Signing is double-confirmed, the
   Schnorr signature is re-verified locally before the tx is built, and keys
   are wiped after use. If a round stalls, any m members sign one refund
   template via leaf B after the lock height; the pot splits back C each to
   the registered refund addresses (minus an equal fee share). Every partial
   signature is re-verified against the member's registered key; the witness
   uses the covenant CHECKSIGADD convention (signatures in reverse
   sorted-key order, exactly m sigs).
5. **Track** — paste a descriptor + payout order to re-derive every round
   address and classify it against Blockbook:
   `unfunded` / `funding` / `pot-full` (claimable by the winner) / `spent`,
   plus whether the refund leaf has unlocked.

## Cryptography lineage

Everything is the audited Sign / Escrow / Games / Bond / Covenant lineage:
BIP-340 Schnorr, BIP-341 script-path sighash (`SIGHASH_DEFAULT`), taggedHash,
`tapLeafHash`, the escrow 2-leaf `taptree2`, the games commit-reveal
(`newSecret`/`commitmentFor`/`verifyReveal`), bond's `buildTransferScript`,
covenant's `buildMultisigScript`. The only local construction is
`numsInternalKeyCircle`, which mirrors escrow's `numsInternalKeyEscrow`
field-for-field with the `PearlCircleNUMS/v1` domain tag. Tests assert the
leaves are byte-identical to the audited originals.

## Honest limits

- **Contributions are voluntary.** This page cannot force any member to fund a round.
- **The lottery needs all reveals.** If a member withholds theirs, the order cannot be computed and no round may be funded. The abort path: refund funded rounds through the timeout leaf after its lock height.
- **Round/lock times are block-height estimates** (~194 s/block). The chain decides.
- **Blockbook is third-party** (https://blockbook.pearlresearch.ai) — it can lag or be wrong. The page sees that an address holds funds, never *who* sent them.
- **Refund threshold m is a real tradeoff:** with m < n a coalition can refund early; with m = n one uncooperative member blocks refunds. Default is n−1.
- **No real funds were moved in testing.** All signing tests use fixture keys; the page never broadcasts unless you press Broadcast.

## Tests

- `tests/circle.test.mjs` — 13/13: terms/member validation, pinned setup hash / fingerprint / payout order / round addresses / claim txid / refund txid, lottery tamper paths, leaf byte-equality with the audited lineage, descriptor round-trip + tamper detection, funding plan, claim/refund signing round-trips, classification.
- `tests/dom.test.mjs` — 8/8: drives the real `app.js` against a strict DOM shim through found → lottery → fund → claim (double-confirm + wipe) → refund → track.
- Real-browser QA (`hidden_files/qa-circle-browser.mjs`): headless Chromium 152 via file:// + CDP, stubbed Blockbook, zero console/page errors — 37/37 green.

Run: `node --no-warnings --loader ./tests/loader.mjs --test tests/circle.test.mjs`
Build the bundle: `node build.mjs` (committed as `pearl-circle.bundle.js`).
