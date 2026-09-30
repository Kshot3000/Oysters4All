# Pearl Bounty — Bug-Bounty / Task-Bounty Desk

**Post bounties. Hunt them. Get paid on Taproot — no middleman, no escrow agent, no trust.**

A bounty is a 2-leaf Taproot contract under a NUMS internal key:

- **Leaf A — award:** `<poster_xonly> OP_CHECKSIG` — the poster's signature *is* the award decision.
- **Leaf B — reclaim:** `<deadline> OP_CHECKLOCKTIMEVERIFY OP_DROP <poster_xonly> OP_CHECKSIG` — byte-identical to the audited escrow `buildRefundScript`.

The poster funds the bounty address, hunters compete off-chain, and the poster
signs the award to the winner's address. If nobody earns it by the deadline,
the poster reclaims the funds. No smart contracts on Pearl — pure Taproot script.

Six steps, one page, zero build step:

1. **Post** — forge the bounty (network, reward, deadline height, contact, terms),
   get the bounty address, descriptor, funding plan, and both leaf scripts.
2. **Fund** — check the bounty address on Blockbook (GET-only) and classify its
   lifecycle: unfunded / funding / funded / spent.
3. **Hunt** — commit-reveal: hash your solution + handle + salt into a 64-hex
   commitment, record it on the local board, and let the poster verify your
   reveal later (tampered reveals are loudly rejected).
4. **Award** — the poster signs the winner's payout (double-confirm, per-signature
   Schnorr re-verification, key wipe). Wrong-key signing is refused.
5. **Reclaim** — after the deadline, the poster sweeps the funds back
   (nLockTime = deadline, pre-deadline attempts loudly refused with blocks-to-go).
6. **Verify** — descriptor tamper check (address recompute + fingerprint),
   standalone transaction conformance check for award/reclaim txs, and the
   honesty-limits note.

## Crypto & safety

- No new cryptography — everything rides on the audited `sign`/`escrow` lineage
  (`crypto.js`, `escrow-core.js` NUMS/taptree2/planSpend/spendVBytes/buildScriptPathSpend,
  `swap-core.js` parseTx). The only new construction is the NUMS internal key under
  domain `"PearlBountyNUMS/v1"` (nobody knows the discrete log → no keypath bypass).
- Tamper-evident `bounty:v1:` descriptors with 64-bit fingerprints; award/reclaim
  txs are verified input-by-input against the re-derived contract (script +
  control block re-derive the bounty address).
- Dust floor (546 grains), absolute-height deadline bounds, poster-key match on
  award/reclaim, double-confirm, key wipe, GET-only Blockbook reads.
- Hunter board is localStorage-only (public commitments, never solutions/salts)
  — no listing relay.

## Tests

- `node build.mjs` → `pearl-bounty.bundle.js` (`window.PearlBounty`).
- `node --test tests/bounty.test.mjs` — 16/16 core tests green
  (descriptor round-trip, reclaim-leaf byte-identity with the audited escrow,
  award/reclaim sign + verify, commit-reveal, deadline rules, fixture address pin).
- `node --test tests/dom.test.mjs` — 7/7 DOM tests green (real `app.js` driven
  against a strict DOM shim: forge → commit/reveal → award plan/sign →
  reclaim pre/post-deadline → verify).
- `node ../../hidden_files/qa-bounty-browser.mjs` — 43/43 real-browser QA green
  (headless Chromium, `file://` + CDP, stubbed Blockbook, zero console/page errors).

Built by [@kshot9000](https://x.com/kshot9000) · tips: `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`
