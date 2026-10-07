# Pearl Watch — PRL Watchtower & Alert Desk

The lighthouse: watch Taproot addresses over GET-only Blockbook reads, fire
alert rules on incoming payments, balance crossings and confirmation
milestones, and track any txid's confirmation progress. **Read-only — this
page never asks for keys, seeds, or passwords.**

Part of the [Pearl builder hub](https://kshot3000.github.io/Oysters4All/)
lineup. Built by [@kshot9000](https://x.com/kshot9000).

**Live:** https://kshot3000.github.io/Oysters4All/pages/watch/

## What it does

- **Watchlist** — add `prl1…`/`tprl1…` addresses with labels. Addresses are
  validated in-browser with the same rules `pearld` enforces (bech32m,
  witness v1 only, 32-byte program); junk, wrong-network, v0 and short-program
  addresses are refused loudly. Duplicates refused. Import/export JSON.
- **Beacon** — the sweeping light: GET-only polls (`/api/status` for the tip,
  `/api/v2/address/<addr>?details=txs` per watched address) on a 15s–5min
  cadence you set, or manual sweeps. Backend URL configurable (mainnet default
  `https://blockbook.pearlresearch.ai`).
- **Rules** — edge-triggered alert rules (fire once per crossing):
  - *Incoming ≥ amount* / *Outgoing ≥ amount* — new txs attributed per-address
    from Blockbook vin/vout lists (honestly labeled a heuristic).
  - *Balance crosses above/below* — re-arms after the balance moves back.
  - *Txid reaches N confirmations* — re-arms if a reorg drops it back.
  - History is not news: the first sweep marks existing txs as seen silently.
- **Events** — the keeper's journal: every firing with UTC time, kind, amount,
  confirmations and txid; filter by kind; CSV/JSON export. Browser
  notifications + sound ping are opt-in.
- **Track** — confirmation tracker for any txid: live progress bar to your
  target, honest unconfirmed/unknown states, auto-stops at the target.

## Tech

- `src/watch-core.js` — pure, node-testable logic (rule engine, diffs,
  confirmation math, CSV/CSV export, state validation). Zero new cryptography:
  bech32m validation + `fmtPRL`/`parsePRL` come from the audited Pearl Sign
  lineage (`../sign/src/`), bundled into `pearl-watch.bundle.js`
  (`window.PearlWatch`) via `node build.mjs` (esbuild). Rebuild the bundle
  after touching `src/` — never edit it by hand.
- `app.js` — classic-script page wiring (tabs, beacon timer, persistence).
- All Blockbook reads are GET; there is no POST path on this page.
- State (watchlist/rules/events/settings) persists in `localStorage` behind
  hostile-safe wrappers; snapshots live in page memory only.

## Tests

- `node --no-warnings --loader ./tests/loader.mjs --test tests/watch.test.mjs` — 29/29 core tests
- `node --no-warnings --loader ./tests/loader.mjs --test tests/watch.dom.test.mjs` — 9/9 DOM tests (real bundle + app.js in a vm DOM, stubbed Blockbook)
- Real-browser QA: 18/18 checks green (headless Chromium 152, `file://` + CDP,
  stubbed Blockbook, zero console/page errors). QA script lives in
  `hidden_files/qa-watch-browser.mjs` (bookkeeping, not committed).

## Honest limits

- Blockbook is a third-party service: balances/txs/confirmations are
  convenience data, not consensus. Verify anything that matters against your
  own `pearld`.
- Polling only — the page watches while the tab is open; a closed tab sees
  nothing, and it cannot push alerts to your phone.
- Incoming/outgoing attribution reads Blockbook's vin/vout address lists.
- No smart contracts on Pearl: rules fire in your browser; nothing on-chain
  enforces them.

## Attribution

Built by [@kshot9000](https://x.com/kshot9000) · tips: `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`
