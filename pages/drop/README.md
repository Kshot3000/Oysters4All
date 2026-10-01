# Pearl Drop — the PRL-20 airdrop campaign desk

The raindrop-storm desk for Pearl (PRL) airdrops: define a campaign, paste a
recipient list, hash it into a Merkle tree, seal a tamper-evident drop
descriptor, and let anyone verify their claim — all client-side.

**Six tabs:** Campaign → Recipients → Merkle → Seal → Claim → Method.

## How it works

1. **Campaign** — name, PRL-20 token tick (1–8 uppercase alnum), claim window
   dates, optional self-declared operator contact. Composing freezes the
   canonical header JSON (fixed field order `v,name,tick,starts_at,ends_at,contact`)
   and its SHA-256 campaign id. Lifecycle: `draft → open → closed → sealed`.
2. **Recipients** — paste `address,amount` CSV (tolerant of header rows, blank
   lines, `#` comments). Every `prl1…` address is validated with the vendored
   bech32m decoder; dedupe is first-seen-wins with duplicates reported. Amounts
   go PRL → grains exact (BigInt, ≤8 decimals, negatives rejected).
3. **Merkle** — leaf *i* = SHA-256 over canonical bytes
   `drop-v1:<index>:<address>:<amountGrains>` (0-based after dedupe). Parents are
   `SHA-256(min‖max)` over the sorted child pair; odd levels duplicate the last
   leaf. Computing the root **locks** the campaign and recipient list. Per-address
   proof lookup + full proof-bundle export.
4. **Seal** — the seal document (`v, campaign_id, tick, merkle_root, leaf_count,
   total_grains, sealed_at, campaign`) gets a SHA-256 seal id, plus a `prl-drop`
   inscription envelope body ready to inscribe via Pearl Etch (preparing the
   payload is this desk's job; commit/reveal is Etch's). The Verify panel
   re-derives everything from a pasted seal + CSV and rules PROVEN / NOT PROVEN.
5. **Claim** — paste any campaign's seal + recipient CSV, enter an address: looks
   up the allocation, rebuilds the Merkle proof, recomputes it to the sealed
   root → VALID (green, amount + proof) or INVALID (red, loud).
6. **Method** — leaf format, pair-sorting convention, BIP-350 validation rules,
   crypto lineage, and the honest limits.

## Honest limits (always visible in the page footer)

- This desk **never holds funds**. Allocations are pledged amounts; distribution
  is a manual PRL-20 transfer by the operator — Pearl has no smart contracts.
- State lives in **localStorage only**; nothing is published or shared.
- **No public `prl-drop` claim indexer exists yet** — redemptions are verified off-chain.
- Names, addresses and the operator contact are **self-declared**; a valid proof
  shows list membership, not identity.

## Crypto lineage

No new cryptography. This desk uses the **audited sign/names crypto core**:
SHA-256 is the byte-identical `snipSha256Bytes` from the Paywall desk (a
mechanical minimization of the audited Sign-core `@noble/hashes/sha256`,
differentially tested there and pinned to known vectors here); bech32m
encode/decode are copied verbatim from the audited `sign/src/crypto.js`
(from pearlpurse). See `src/logic.js` for the lineage comments.

## Files

- `index.html` — the desk (references `styles.css?v=1`, `pearl-drop.bundle.js?v=1`)
- `styles.css` — raindrop-storm theme (deep navy + luminous cyan/teal)
- `src/logic.js` — pure core: crypto, grains, campaign, CSV, merkle, seal, claim
- `src/index.js` — DOM wiring (sets `window.PearlDrop` at the end)
- `build.mjs` — esbuild IIFE bundle, no `globalName` (see AGENTS.md esbuild lesson)
- `pearl-drop.bundle.js` — committed bundle (rebuild with `node build.mjs`)
- `tests/logic.test.mjs` — `node tests/logic.test.mjs` (93/93 green)

Pure client-side — no network calls, no keys, never moves PRL.

Built by [@kshot9000](https://x.com/kshot9000) · donate PRL:
`prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`
