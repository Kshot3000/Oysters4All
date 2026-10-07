# Pearl Commons — quadratic funding rounds for PRL

**Live:** https://kshot3000.github.io/Oysters4All/pages/commons/

The quadratic funding desk for the Pearl ecosystem (commons-hearth theme: deep
walnut, candlelight amber, parchment). Run a funding round with a fixed PRL
matching pool: projects register, donors contribute, and the desk computes each
project's match with open, auditable math.

Six tabs: **Rounds → Projects → Contribute → Results → Audit → Settings**.

## How it works

1. **Rounds** — create a round: name, matching pool (PRL), minimum contribution,
   contribution window. Rounds move `upcoming → active → closed`; the operator
   can **finalize** a closed round, which computes results, hashes them into the
   audit log, and locks the round forever.
2. **Projects** — register a project with a Pearl Taproot payout address. Every
   address is validated against chain policy (bech32m, witness v1, 32-byte
   program) and re-encoded to canonical form before it is stored.
3. **Contribute** — log a contribution (donor label, PRL amount, optional txid).
   Paste a txid and hit *Verify txid on Blockbook*: the desk reads the
   transaction GET-only and auto-fills the amount from the output paying the
   project's address.
4. **Results** — the QF table. Per project: donors, contributed, desired match,
   match paid, total — plus pool/donor/match/remainder stats, a bar chart, and
   JSON/CSV export.
5. **Audit** — every event (round created/finalized, project registered,
   contribution recorded, settings changed) is appended to a hash-chained log
   (SHA-256, each entry commits to the previous). One-click chain verification.
6. **Settings** — network (mainnet `prl1…` / testnet `tprl1…`) for address
   validation, Blockbook URL for txid lookups, wipe-all danger zone.

## The math (deterministic, documented)

Buterin–Hitzig–Weyl liberal radicalism with a capital constraint, computed per
project *p* over per-donor aggregates *cᵢ* (repeat donations from one donor
label to one project are summed first):

```
desired_p = (Σᵢ √cᵢ)² − Σᵢ cᵢ
```

- A single-donor project gets **zero** match — correct QF behavior (matching
  rewards breadth of support).
- If Σ desired exceeds the pool, every match is scaled by
  `k = pool / Σ desired` and floored to whole grains; the leftover is reported
  as the **pool remainder** (it stays in the pool).
- The square-root leg runs in floating point on PRL-denominated values and is
  floored back to grains; the convention is pinned by unit tests with known
  vectors ([1,1]→2 · [4,1,1]→10 · single-donor→0).

## Honest limits (also on the page, always visible)

- The matching pool is a **pledged number you type in** — the desk does not
  escrow it and cannot move it. Paying matches is a manual on-chain transfer.
- Donor labels are self-declared; the desk cannot prove two labels are two
  humans. Results are **best-effort, not sybil-proof**.
- Contributions are logged from what you enter; the Blockbook txid check is a
  convenience read, not a proof of intent.
- All data lives in this browser's localStorage — export the round JSON before
  wiping. Keys never touch this page; nothing is signed or broadcast.

## Tech

- `src/commons-core.js` — pure logic (rounds, projects, contributions, QF,
  audit chain, Blockbook client). **No new cryptography**: `sha256`,
  `decodeBech32m`/`encodeBech32m`, `GRAIN_PER_PRL` come from the audited
  Pearl Sign core (`../sign/src/crypto.js`, vendored `@noble` deps).
- `src/index.js` — UI, exposes `window.PearlCommons` (`core` + `ui`).
- `build.mjs` — esbuild → committed `pearl-commons.bundle.js` (IIFE, no
  `globalName`; explicit `window.PearlCommons` assignment — see AGENTS.md).
- Tests: `node --no-warnings --loader ./tests/loader.mjs ./tests/commons-core.test.mjs`
  — 17/17 green (amount parsing, address policy incl. v0/short-program
  rejection, round lifecycle, QF known vectors, capital-constraint scaling,
  audit tamper detection).
- Real-browser QA: `hidden_files/qa-commons-browser.mjs` — 19/19 green
  (headless Chromium 152, file:// + CDP, full round→projects→contributions→
  results→audit→reload flow, zero console/page errors).

Assets are `?v=1` cache-busted. Footer carries
[@kshot9000](https://x.com/kshot9000) and
`prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`.
