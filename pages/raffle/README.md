# Pearl Raffle — Provably-Fair PRL Raffle Manager

The lottery vault. A provably-fair raffle manager for the Pearl blockchain:
forge a tamper-evident raffle commitment, draw winners from a future block's
hash with a hand-verifiable SHA-256 derivation, verify anyone's draw standalone,
and export an exact payout plan.

**Honest scope: this page never moves PRL.** There are no smart contracts on
Pearl, so fairness here is an off-chain *commitment protocol* enforced by
public verification, not code. Prize custody and the actual sends stay with
the organizer's own wallet.

## The protocol

1. **Forge** — the organizer enters the prize (PRL), a settlement block height
   (a future block), and the weighted entry list (`<address> <tickets>`).
   Every address is validated as Pearl v1 Taproot. The app builds a
   tamper-evident descriptor

   ```
   raffle:v1:<hrp>:<prizeGrains>:<settleHeight>:<entriesHash>:<n>
   ```

   where `entriesHash = SHA-256` over the canonical sorted entry lines — any
   post-hoc edit changes the hash. Forge requires the current chain tip
   (Blockbook or manual) and refuses settlement heights that are past or
   within 3 blocks of the tip, so the commitment provably predates the beacon
   block. The **publishable commitment** (descriptor + descriptor hash) must
   be shared publicly *before* the settlement block is mined.
2. **Track** — reload a descriptor to re-derive it, re-check the entry
   commitment, and count down to the settlement block via a configurable
   Blockbook endpoint (default `https://blockbook.pearlresearch.ai`), or paste
   the block hash by hand for air-gapped use.
3. **Draw** — once the settlement block hash is available:

   ```
   winnerIndex = uint256(SHA-256("raffle-draw:v1:<descriptorHash>:<blockHash>:<round>")) mod totalTickets
   ```

   mapped onto the weighted ticket ranges of the sorted entries. 1–3 prize
   rounds; later rounds exclude earlier winners. The full derivation is shown
   so anyone can re-verify by hand with any SHA-256 tool.
4. **Verify** — standalone verifier: paste descriptor + entries + block hash
   and re-run the draw locally. A tampered entry list is refused loudly.
5. **Payout** — exact prize split across round winners (floor division, the
   remainder grains go to round 1; rows always sum to the prize), exported as
   CSV and as `pearl:` payment URIs with QR codes.

## Guarantees and limits

- No draw runs without the settlement block hash and an entry list that
  reproduces the descriptor's `entriesHash` — the app **refuses** rather than
  faking a winner.
- The beacon is only as unpredictable as the settlement block: use a block far
  enough out that no entrant (including the organizer) can influence its hash.
- Blockbook is a third-party read source; confirm the settlement block hash
  with your own `pearld` (`getblockhash`) for draws that decide real money.
- Countdowns assume the 194-second target block time; real block times vary.

## Files

- `index.html` — five-step UI (Forge / Track / Draw / Verify / Payout) +
  always-visible Honest limits panel
- `styles.css` — emerald/gold lottery-vault theme
- `app.js` — UI wiring (no crypto; calls into the bundle)
- `src/raffle-core.js` — entry parsing, descriptor forge/parse, draw,
  verifier, payout planner, Blockbook readers
- `src/index.js` — browser entry (`window.PearlRaffle`)
- `build.mjs` — esbuild bundle → `pearl-raffle.bundle.js` (committed; rebuild
  with `node build.mjs`)
- `qrcode.min.js` — vendored QR renderer (same copy as Pearl Stream)
- `tests/` — 12/12 unit tests + 7/7 DOM tests
  (`node --no-warnings --loader ./tests/loader.mjs tests/raffle.test.mjs`)
- real-browser QA (headless Chromium, file:// + CDP) — 22/22 checks green,
  zero console/page errors, plus a 375px mobile tab-sweep
  (`hidden_files/qa-raffle-browser.mjs`)

Reuses the audited Pearl Sign crypto (`../sign/src/crypto.js`, bech32m +
SHA-256, pearlpurse lineage) — no new cryptography is introduced.

Built by [@kshot9000](https://x.com/kshot9000) for the Pearl ecosystem.
Donations: `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`
