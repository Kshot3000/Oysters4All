# Bug Report — oystercli renders transaction history oldest-first (pearl-research-labs/pearl#321)

**Repo:** https://github.com/pearl-research-labs/pearl
**Upstream issue:** https://github.com/pearl-research-labs/pearl/issues/321
**Upstream PR (fix):** https://github.com/pearl-research-labs/pearl/pull/338
**Fix branch (fork Kshot3000/pearl):** `fix/oystercli-tx-order-321` (commit `3b548659`)
**Severity:** Low-Medium (UX correctness — no funds at risk)
**Status:** Fixed + verified; PR open, awaiting maintainer review.
**Found by:** Pearl 24/7 builder loop, 2026-09-26 (issue-triage of the 92 open upstream issues)

## What was broken

`oystercli` (the interactive terminal client for the Oyster wallet) assumed the
`listtransactions` RPC returns **oldest-first** and reversed every page before
rendering. The wallet actually returns **newest-first**:

- `wallet/wallet/wallet.go` — `Wallet.ListTransactions` iterates
  `TxStore.RangeTransactions(txmgrNs, -1, 0, …)`, i.e. from mempool height down
  to the genesis block, with the comment *"Return newer results first"*. Mined
  entries within a block are emitted in reverse (newest-of-block first) order.
- `wallet/rpc/legacyrpc/methods.go` — the `listtransactions` handler returns
  `w.ListTransactions(*cmd.From, *cmd.Count)` with no re-sorting.

So the reversal flipped the true order: the **Transactions** screen
(`wallet/cmd/oystercli/transactions.go:45-47`) and the Overview **"Recent
activity"** list (`wallet/cmd/oystercli/overview.go:62-64`) both showed the
oldest entry of the page at the top and buried the newest — including any
pending unconfirmed send — at the bottom, just above "→ Older transactions".
Present since oystercli was added in #244.

The bug was also internally inconsistent with the rest of the UI: the
"→ Older transactions" / "← Newer transactions" paging (`offset += txPageSize`
goes older) and the comment "Default to the first row (the newest
transaction)" both assumed newest-first pages — the reversal made the default
cursor land on the *oldest* row.

## Reproduction

Code-level (no live node needed — the defect is in the row-building loop):

1. Take a page exactly as `Wallet.ListTransactions` returns it — newest first,
   e.g. `[pending (0 conf), one-conf, two-conf]`.
2. Run the old loop verbatim:
   `for i := len(page) - 1; i >= 0; i-- { opts = append(opts, …page[i]…) }`.
3. The first rendered row is the two-conf (oldest) tx; the pending send is last.

Verified with a temporary Go test replicating the old loop: it confirmed
`order[0] == "two-conf-tx"` and `order[last] == "pending-tx"` (test removed
after verification; the permanent regression tests below replace it).

## Fix

- `wallet/cmd/oystercli/transactions.go` — dropped the reverse loop in
  `transactionsScreen`; corrected the stale "listtransactions returns oldest
  first" comment. Row building extracted into `txPageOptions()` so the
  newest-first contract is unit-testable.
- `wallet/cmd/oystercli/overview.go` — same change in `overviewScreen` ("Recent
  activity"); row building extracted into `recentActivityRows()`.
- `wallet/cmd/oystercli/txorder_test.go` (new) —
  `TestTxPageOptionsPreservesNewestFirst` and
  `TestRecentActivityRowsPreservesNewestFirst` assert the newest (pending) tx
  is the first row, guarding against CLI/RPC contract drift.

Patch: `fix-pearl-oystercli-txorder-321.patch` (in this directory).

## Verification

- `go test ./wallet/cmd/oystercli/ -count=1` — **39 pass** (incl. the 2 new
  tests), 1 pre-existing skip (`TestAutoProvisionTightensPermsBeforeAppendingCreds`
  skips when run as root — environmental, unrelated).
- `gofmt -l` clean; `go vet ./wallet/cmd/oystercli/` clean.
- Not verifiable end-to-end here: no live wallet with history in the sandbox
  (would need `oyster` + `pearld` on simnet). The row-ordering logic is fully
  covered by the new unit tests.

## Notes

- Triaged alongside this fix: upstream issue #144 (`generate_wallet.py`
  creates unspendable addresses) is **stale** — the script no longer exists in
  the tree at master @ 3fe2267, and the only other bech32m usage in `miner/`
  (`pearl-gateway/blockchain_utils.py`) is address *validation* (witness v1 +
  32-byte + bech32m enforced), not address generation. No fix warranted.
- Issue #322 (NeutrinoClient `BlockStamp` stale after restart) is a real,
  deeper wallet bug — queued for a future run (needs simnet node + wallet to
  reproduce properly).

---
Pearl donation address: `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`
X: [@kshot9000](https://x.com/kshot9000)
