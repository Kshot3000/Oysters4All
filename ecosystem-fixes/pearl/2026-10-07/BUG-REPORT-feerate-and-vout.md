# Upstream fixes — oystercli fee-rate NaN/Inf bypass + desktop Activity vout dedup drop

- **Date:** 2026-10-07 (Pearl builder loop, upstream bug-hunt run — second batch, from the oystercli/desktop hunter's final report, both re-verified in source + repro before fixing)
- **PRs:** https://github.com/pearl-research-labs/pearl/pull/371 (fee rate) · https://github.com/pearl-research-labs/pearl/pull/372 (vout)
- **Branches:** `fix/oystercli-feerate-nonfinite` (33c3ca7e), `fix/desktop-activity-vout-rowkey` (4745f1d2), both on Kshot3000/pearl, base master @ 2f8b770c
- **Patches:** `fix-oystercli-feerate-nonfinite.patch`, `fix-desktop-activity-vout.patch`

## Bug 1 — oystercli Send accepts NaN/+Inf fee rates (PR #371)

`validateFeeRate`/`parseFeeRate` (wallet/cmd/oystercli/send.go) use `strconv.ParseFloat`, which accepts `NaN`/`Inf`/`+Inf`/`Infinity` without error; `NaN < floor` and `+Inf < floor` are both false, so they passed validation, rendered as "NaN PRL/kB" in the review box, and failed only after the user confirmed the broadcast — inside the RPC layer, `json: unsupported value: NaN`. Repro (functions copied verbatim from master): all five spellings bypass both gates and fail JSON marshaling. Fix: reject non-finite values in both functions; new test `TestParseAndValidateFeeRateRejectNonFinite` (6 spellings × both functions); full oystercli suite PASS, vet clean.

## Bug 2 — desktop wallet Activity drops a split-payment row (PR #372)

The daemon's `listtransactions` lists one entry per output, each with `vout` (`btcjson.ListTransactionsResult.Vout`), but the desktop app dropped the field: `RawTransaction`/`Transaction` had no `vout`, `formatTransaction` didn't copy it, and `usePagination`'s dedup `rowKey` (type_txid_address_amount) cannot distinguish two outputs of one tx paying the same address the same amount. Within one page both rows survive; straddling a page boundary (pageSize 20), the second is filtered as a duplicate after the offset already advanced — Load more can never surface it. Repro with shipped logic on a 21-row fixture: page 1 kept 0 of 1 — 20 shown, expected 21. Fix: carry `vout` through the formatter (the only `Transaction` constructor) into `Transaction.vout` and include it in `rowKey`; fixed-logic harness shows 21/21. Honest limit (stated in the PR): the app's tsc/build could not run in this container (pnpm deps not installable) — verified at logic level + full constructor audit; the PR's CI should typecheck it.
