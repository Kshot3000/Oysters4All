# Pearl Ballot — Off-Chain DAO Governance with Schnorr-Signed Ballots

Live: https://kshot3000.github.io/Pearl-Muse-24-7-Ai-builder/pages/ballot/

Pearl has no smart contracts, so a vote can't be enforced on-chain.
Pearl Ballot makes governance fair anyway: an off-chain **signed-ballot
protocol** with a tamper-evident descriptor, enforced by public verification —
the same proven model as [Pearl Auction](../auction/) and [Pearl Raffle](../raffle/).

## The five steps: Draft → Publish → Vote → Tally → Verify

1. **Draft (organizer).** Proposal title, description, 2–8 options, voting
   window (start/end block heights), snapshot height for voting weight.
   Forge guards: empty/dust proposals refused, startH must be provably in
   the future (live Blockbook tip via configurable endpoint, default
   `https://blockbook.pearlresearch.ai`, or air-gapped manual tip), endH
   after startH, snapshotH ≤ startH and ≤ current tip. Descriptor:
   `pearl-ballot:v1:<hrp>:<proposalHash>:<startH>:<endH>:<snapshotH>:<optionsHash>` —
   `proposalHash` = SHA-256 of the canonical proposal JSON. Publish the
   descriptor **before the voting window opens**.
2. **Publish (organizer).** Tamper-evident commitment panel: the descriptor,
   `descriptorHash`, `proposalHash`, `optionsHash`, window + snapshot
   heights, and the proposal JSON — copy/download, with a publish checklist.
3. **Vote (voters).** Paste the descriptor + proposal JSON (the page
   re-hashes the proposal against the descriptor before it lets you vote),
   enter your `prl1…`/`tprl1…` address + choice. Your ballot — canonical
   JSON `{descriptorHash, voter, choice, weightGrains, snapshotH, nonce}` —
   is signed **locally** with your key (BIP-86 via the audited Sign core:
   WIF/hex/mnemonic entry, in-memory only, wipe button). The page refuses
   unless the key derives *exactly* the voter address, refuses votes before
   startH / after endH (live tip or manual tip), and fetches your voting
   weight as the current confirmed PRL balance (honestly labeled — see
   below). The signature is re-verified against your address key before the
   ballot is shown. You publish the signed ballot JSON publicly; the
   organizer collects ballots into the Tally step.
4. **Tally (organizer).** Import ballot JSONs (paste/file); the page
   re-verifies EVERY signature against the descriptor + voter key and
   loudly refuses wrong-descriptor, duplicate-voter (first valid wins, with
   a loud duplicate report), unknown-option, and zero-weight ballots. The
   hand-verifiable derivation is shown step-by-step: per-ballot table,
   per-option weighted totals, and the hash-bound result record
   `pearl-ballot-result:v1:<descriptorHash>:<winner>:<totalWeight>:<nVoters>:<resultHash>`
   (`resultHash` = SHA-256 over the canonical tally). Exact ties are
   reported as a TIE — the page refuses to pick a winner out of thin air.
   CSV + JSON export.
5. **Verify (standalone).** Paste the published proposal JSON + the ballots;
   the page re-derives the descriptor from the proposal, re-verifies every
   signature, and re-tallies. Tampered input gets a loud ✗ NOT PROVEN.

## Crypto lineage

All cryptography is the audited Pearl Sign core (`../sign/src/crypto.js`):
SHA-256, bech32m, BIP-86 key derivation, BIP-340 Schnorr signing via the
voter's tweaked keypath key (`tweakPrivKeypath` — the same key the P2TR
address commits to, so the signature verifies against the address's
32-byte x-only key). No new cryptography was introduced — only a new
signed-ballot protocol on top of it.

## Tests

```sh
node --no-warnings --loader ./tests/loader.mjs --test tests/ballot.test.mjs   # 18/18 (pinned vectors, incl. a pinned BIP-340 ballot signature)
node --no-warnings --loader ./tests/loader.mjs --test tests/dom.test.mjs     # 7/7
node ../../../../hidden_files/qa-ballot-browser.mjs                          # 22/22 real-browser QA (hidden_files, not committed)
```

## Honest caveats

- No real vote has been conducted through this page; test ballots and browser-QA votes use synthetic keys.
- Governance results are social consensus, not on-chain execution: nothing on-chain enforces the outcome.
- Voting weight is the **current confirmed balance** from Blockbook, not a read at the snapshot height — Blockbook does not expose historical address balances. Snapshot-height enforcement is the organizer's job; the claimed snapshot height is recorded inside every signed ballot for cross-checking.
- Ballot relay is manual; the page cannot prove *when* a pasted ballot was created. In-page signing refuses out-of-window votes; pasted ballots rely on the organizer's honest collection.
- One address, one ballot — but nothing stops one person from voting under two different addresses. Know your voters.
- Blockbook is a third-party read source; for polls that decide real money, confirm heights and balances with your own `pearld` node. Countdowns assume the 194 s block target.

Built by [@kshot9000](https://x.com/kshot9000) for the Pearl ecosystem.
