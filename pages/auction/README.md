# Pearl Auction — Sealed-Bid PRL Auction Hall

Live: https://kshot3000.github.io/Oysters4All/pages/auction/

Pearl has no smart contracts, so a sealed-bid auction can't be enforced on-chain.
Pearl Auction makes it fair anyway: an off-chain **commit-reveal protocol** with a
tamper-evident descriptor, enforced by public verification — the same proven model
as [Pearl Raffle](../raffle/).

## The five steps: List → Commit → Reveal → Settle → Verify (+ Track)

1. **List (auctioneer).** Name, description, optional image URL, seller `prl1…` address,
   minimum bid (PRL, decimals ok), commit deadline + reveal deadline as block heights.
   Forge guards: dust minimum refusal (< 546 grains), commit deadline must be provably in
   the future (live Blockbook tip via configurable endpoint, default
   `https://blockbook.pearlresearch.ai`, or air-gapped manual tip entry), reveal deadline
   after the commit deadline with a ≥ 3-block gap. Descriptor:
   `auction:v1:<hrp>:<itemHash>:<minBidGrains>:<commitH>:<revealH>:<nonce>` —
   `itemHash` = SHA-256 of the canonical item terms. Publish the descriptor
   **before** the commit deadline.
2. **Commit (bidders).** Each bidder generates locally: address + bid + a 16-byte
   CSPRNG salt → `commitment = SHA-256("pearl-auction-commit:v1:<descriptorHash>:<bidderAddr>:<bidGrains>:<saltHex>")`.
   They publish **only the hash** before the commit deadline — never the bid or the salt.
   The organizer records (address, hash) pairs; the page refuses late commits, duplicate
   hashes, and a second commitment from the same address (one bidder, one commitment).
3. **Reveal (bidders).** After the commit deadline and before the reveal deadline, each
   bidder submits bid + salt; the page re-derives the commitment. Mismatch = loud refusal,
   bid rejected. Bids below the minimum are refused. Reveals are processed in order;
   **ties are broken by earliest reveal**.
4. **Settle.** Every commitment re-checked, every reveal re-verified, cheaters excluded
   (commitment-hash collisions and double reveals both exclude *both* sides), ranking =
   highest verified bid first. The winner pays the seller **directly, off-page** — the
   page never moves PRL; it produces a `pearl:` payment URI + QR for the winning bid and
   a CSV/JSON export. No valid bid ≥ minimum → "no sale" with a hash-signed result record.
5. **Verify (standalone).** Paste the published descriptor + commitments + reveals (reveal
   order); the page re-derives everything and refuses tampered input with a loud
   ✗ NOT PROVEN.
6. **Track.** Descriptor reload, commitment/reveal counts (unrevealed bids stay hidden),
   commit/reveal deadline countdowns at 194 s/block via Blockbook or manual height.

## Crypto lineage

All cryptography is the audited Pearl Sign core (`../sign/src/crypto.js`): SHA-256,
bech32m, PRL grain units. No new cryptography was introduced — only a new commitment
protocol on top of it.

## Tests

```sh
node --no-warnings --loader ./tests/loader.mjs --test tests/auction.test.mjs   # 17/17
node --no-warnings --loader ./tests/loader.mjs --test tests/dom.test.mjs       # 7/7
node ../../../../hidden_files/qa-auction-browser.mjs                            # 21/21 real-browser QA (hidden_files, not committed)
```

## Honest caveats

- No real auction has run through this page; test vectors and browser-QA bids are synthetic.
- Fairness is a commitment protocol, not code: nothing on-chain enforces the auction.
  The descriptor must be published before the commit deadline or the auction proves nothing.
- The commitment ledger is manual — bidders publish hashes publicly; the organizer records them.
  For real money, cross-check the ledger against those public posts.
- One person can still bid under two different addresses. Know your bidders.
- Blockbook is a third-party read source; for real-money deadlines confirm heights with your
  own `pearld` node. Countdowns assume the 194 s block target.

Built by [@kshot9000](https://x.com/kshot9000) for the Pearl ecosystem.
