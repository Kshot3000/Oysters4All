# Pearl Charity — Transparent PRL Donation Desk

Launch tamper-evident PRL donation campaigns. Donations go **straight to the
charity's own Taproot address** — this page never holds, moves, or broadcasts
funds. Every chain read is GET-only Blockbook; every donation happens in the
donor's own wallet.

Live: https://kshot3000.github.io/Pearl-Muse-24-7-Ai-builder/pages/charity/

## How it works (five steps)

1. **Launch** — the organizer forges a campaign: org name, charity recipient
   address (bech32m `prl1…`/`tprl1…` validated in-browser), goal in PRL
   (> 0, dust floor refused), optional deadline block height, public
   description + contact. The page forges a tamper-evident descriptor
   `pearl-charity:v1:<hrp>:<hash>:<goalGrains>[:<deadlineH>]` where
   `hash` = SHA-256 over the canonical campaign JSON, plus a 64-bit
   fingerprint (first 16 hex of the descriptor hash). Optional organizer
   authorship: the descriptor hash is signed locally with a BIP-86 key
   (hex/WIF/mnemonic, in-memory only, wiped right after forging); the spec
   records the organizer x-only key + Schnorr signature. Output: the donation
   address (the charity address itself), descriptor, fingerprint, campaign
   spec JSON, and a publish checklist. The spec fans out to every other step.
2. **Fund** — GET-only Blockbook: load the spec, fetch address stats (total
   received grains, donation list) and the chain tip; lifecycle classification
   `unfunded` / `funding` / `goal-met` / `past-deadline`. Honest unconfigured /
   unreachable states (no public testnet Blockbook — bring your own base URL).
   An air-gapped path accepts manually pasted donation records (labeled
   clearly as unverified manual claims).
3. **Receipts** — donor receipt ledger: donor handle (optional, pseudonymous
   OK — blank = anonymous), donation txid (64 hex), amount in PRL
   (donor-declared, grain-exact). Each receipt is hash-bound:
   `pearl-charity-receipt:v1:` = SHA-256 over the canonical receipt JSON
   (campaign fingerprint, donor, txid, amount, optional block height,
   recordedAt ISO). Stored per-campaign-fingerprint in localStorage, with
   CSV/JSON export, a printable receipt view, and delete. Every hash is
   re-checked on render; a tampered record shows ✗ loudly.
4. **Track** — goal progress: raised vs goal with an animated % bar, donor
   count from the local ledger, deadline countdown (blocks → approximate days
   at 194 s/block, stated honestly as approximate), recent donations table.
5. **Verify** — standalone: (a) paste descriptor + spec + claimed address →
   recomputes hash/fingerprint/recipient → `DESCRIPTOR VERIFIED` (with funding
   guidance) or a loud `REFUSED` (incl. the optional Schnorr authorship check
   against the recorded organizer x-only key); (b) paste a receipt → recompute
   hash → `HASH MATCHES`, then an optional live Blockbook cross-check (tx
   exists, pays the campaign address the recorded amount, ≥ 1 confirmation)
   → `RECEIPT PROVEN` / `NOT PROVEN` with exact reasons.

## Crypto & safety

- **No new cryptography.** Everything cryptographic comes from the audited
  Sign lineage: bech32m, SHA-256, BIP-340 Schnorr, BIP-86 key derivation,
  dust constants (`DUST_GRAIN = 546`), `GRAIN_PER_PRL` — reused from
  `../sign/src/crypto.js` and `../escrow/src/escrow-core.js`. New in this app:
  only the canonical-JSON hashing, descriptor shaping, receipt records,
  lifecycle classification, and GET-only Blockbook readers.
- The page **never custody funds, never asks for a seed** (organizer key
  entry is optional, in-memory only, wiped after forging), and **never
  broadcasts**. Bad input is refused loudly: bad addresses, zero/dust goals,
  paste-error deadlines, malformed txids.
- Honest limits are always visible on the page: organizer-trusted (not
  trustless), receipts are self-declared, donor names are not identities,
  deadlines are heights (day estimates approximate), Blockbook can lag.

## Tests

- `node build.mjs` → committed `pearl-charity.bundle.js` (`window.PearlCharity`). Never hand-edit the bundle.
- `node --no-warnings --loader ./tests/loader.mjs --test tests/charity.test.mjs` — descriptor round-trip, pinned fixture descriptor, tamper refusal on every committed field, fingerprint format, receipt hash round-trip + tamper refusal, classification (unfunded/funding/goal-met/past-deadline), deadline countdown math, dust/zero-goal/bad-address refusals, organizer sign→verify, stubbed-fetch Blockbook parsing, receipt cross-check proven/not-proven.
- `node --test tests/dom.test.mjs` — drives the real `app.js` against the committed bundle in a vm with a strict DOM shim.
- `node ~/workspace/goals/pearl-blockchain-24-7-builder/hidden_files/qa-charity-browser.mjs` — real headless-Chromium QA (file:// + CDP, stubbed Blockbook), all five steps, zero console/page errors.

## Files

- `index.html` — the desk (five-step wizard)
- `styles.css` — lantern-of-giving theme (warm charcoal + candlelight gold)
- `app.js` — UI wiring (no crypto of its own)
- `src/charity-core.js` — protocol core (pure ESM)
- `src/index.js` — bundle entry (`window.PearlCharity` + `Sign` namespace)
- `build.mjs` — esbuild bundler → `pearl-charity.bundle.js` (committed)
- `tests/` — node suites (`loader.mjs` import-map hook)

---

Built by [@kshot9000](https://x.com/kshot9000) · tips:
`prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`

Pearl Charity — the page never holds or moves funds. Verify every address before you donate.
