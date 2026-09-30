# Pearl Games

Provably-fair commit-reveal betting games on Pearl Taproot — no smart contracts, no casino
custody, no app that "holds your money." Just math you can check yourself.

**Live:** `pages/games/` — pure client-side, keys never leave the device.

## Games

| Game | Bet | Fairness |
|---|---|---|
| **Coin Flip** | heads / tails | commit-reveal, dealer stakes 1×, player stakes 1×, winner takes 2× |
| **Dice Exact** | face 1–6 | dealer stakes 5×, player stakes 1× — winner takes 6× |
| **Dice Hi/Lo** | low (1–3) / high (4–6) | dealer stakes 1×, player stakes 1×, winner takes 2× |

## Protocol (five steps)

1. **Setup** — both parties paste their keys (WIF / mnemonic / xpub / x-only, dealer or player
   role is implicit). A game descriptor is generated with a **player-side random round ID**.
   Each side gets its own Taproot escrow address binding: `commitment ‖ depositor ‖ round ‖ amounts ‖ timeout`.
2. **Commit** — the dealer generates a 32-byte secret and publishes `sha256(secret)`.
   The player locks that commitment. **Order matters:** the commitment must be locked
   before the round ID is finalized, so the dealer cannot shop for a secret that wins.
3. **Fund** — dealer and player fund their own escrow addresses with the exact stake.
4. **Reveal** — the dealer publishes the secret. `outcome = sha256(secret ‖ roundId) mod outcomes`;
   anyone can verify commitment, outcome and winner from the public transcript.
5. **Settle or Refund** — the winner (and loser) co-sign a 2-of-2 script-path spend that pays
   the whole pot to the winner. If the reveal never comes, each side can unilaterally reclaim
   its stake after the timeout via its own CLTV refund leaf.

## Escrow construction

Each escrow is a two-leaf Taproot tree:

- **Settle leaf (shared):** `<dealer> CHECKSIGVERIFY <player> CHECKSIG`
  (witness stack: player sig, dealer sig)
- **Refund leaf (per depositor):** `<timeout> CHECKLOCKTIMEVERIFY DROP <depositor> CHECKSIG`

The tweaked output key commits to the tree, so neither party can spend the other's way.

## Key facts

- **No new cryptography.** All Taproot primitives (`taggedHash`, `tapLeafHash`, BIP-341
  digests, Schnorr, `p2trScriptPubKey`) come from the audited `files/pages/sign/src/crypto.js`,
  Taproot script helpers from `files/pages/escrow/src/escrow-core.js`, and the multi-input
  digest from `files/pages/stream/src/stream-core.js`.
- **Grain-exact.** 1 PRL = 10⁸ grains; payouts computed in integer grains, fee subtracted
  once from the pot at a declared grains/vByte rate.
- **Testnet-first.** Point the Blockbook URL at a Pearl testnet instance to practice.
  Mainnet moves real PRL — every broadcast needs two confirmations.
- **Browser only.** `pearl-games.bundle.js` is built with esbuild from `src/index.js`;
  rebuild with `node build.mjs`. Tests: `node --no-warnings --loader ./tests/loader.mjs --test tests/games.test.mjs`.

## Honest limitations

- The dealer reveals the secret voluntarily — there is no on-chain force-reveal. If they
  never reveal, refunds are the only exit (this is a coordinator, not a casino).
- Funding transactions need a UTXO covering the stake; the builder picks the smallest
  sufficient one and returns change to your keypath-tweaked P2TR address.
- Refunds require the timeout to have passed on-chain; the UI checks tip height first.

Built by **@kshot9000** · PRL: `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`
