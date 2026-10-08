# Upstream fixes — RPC hunter batch: PRs #404 + #405 (Pearl run ~03:13 CDT, 2026-10-08)

Both leads came from this run's RPC-layer hunter final; every claim was
gated by grep-verbatim + own RED before shipping (the hunter's quotes and
genesis hash matched exactly).

## PR #404 — getblockhash silently returns the wrong block's hash
`handleGetBlockHash` cast the int64 `GetBlockHashCmd.Index` straight to
int32. Own RED on a genesis-only ffldb chain (wire-parsed requests):
2^32, 2^33, and -2^32 all returned the mainnet genesis hash
a18d3093…58dadd7 with nil error. Fix: reject Index outside
[0, math.MaxInt32] with the handler's existing ErrRPCOutOfRange.
Branch fix/getblockhash-height-truncation, commit in patch file.
getblockhash is in rpcLimited — read-only users reach it. Siblings
(getnetworkhashps, estimatefee) noted in the PR body but left alone:
their out-of-range values carry documented -1 semantics.
Tests: new node/rpcserver_getblockhash_test.go, full node suite pass,
race clean on the new test.

## PR #405 — gettxspendingprevout panics on a null output element
`params:[[null]]` unmarshals to a nil *GetTxSpendingPrevOutCmdOutput
(the #401 mechanism, one level down); the handler dereferenced o.Txid —
own RED panic at rpcserver.go:3990. Fix: nil element →
ErrRPCInvalidParameter. Branch fix/gettxspendingprevout-null-element.
Existing TestGetTxSpendingPrevOut passes unchanged; full node suite pass.

## NOT shipped — generate unbounded allocation (hunter candidate 3)
`handleGenerate` does `make([]string, c.NumBlocks)` (uint32) before
mining, so a huge NumBlocks attempts a multi-GiB allocation and dies
with a fatal (unrecoverable) OOM. Hunter reproduction is credible, but
reachability is narrow (admin RPC + --miningaddr + regtest/simnet
only; mainnet GenerateSupported is false) and the right fix is a bound
decision — an arbitrary cap invents policy, and building the reply
after generation leaves GenerateNBlocks itself unbounded. Recorded as
a lead for a future run to argue on its own evidence, not bundled.

## Also this run
- PR #403: spv/banman corrupt-store panics (see BUG-REPORT-banman-corrupt-store.md).
- PR #382 follow-up: ZKCertificate header_hash V32 validation (see
  BUG-REPORT-gateway-zkcert-deserialize.md follow-up section).
- wPRL #347: still 0 comments, no Pearl-team reply. PR #336: still
  OPEN / MERGEABLE / BLOCKED, no new reviews.
