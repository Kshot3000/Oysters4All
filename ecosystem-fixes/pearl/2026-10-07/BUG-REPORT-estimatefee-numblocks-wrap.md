# Upstream fix — PR #411: estimatefee uint32 wrap (Pearl run ~07:13 CDT, 2026-10-08)

The `estimatefee` sibling flagged in PR #404's body, given its own look
this run (a full narrowing-cast sweep of `node/rpcserver.go`).

`handleEstimateFee` checked `NumBlocks <= 0` in the int64 domain, then
cast straight to the fee estimator's uint32. Counts congruent to 1–25
mod 2^32 wrapped into the estimator's valid range and returned an
estimate for a completely different count with no error, while a plain
26 was correctly rejected for exceeding the estimator depth (25).

Own RED (wire-parsed requests through `btcjson.UnmarshalCmd`, handler
backed by `mempool.NewFeeEstimator(2, 0)` so an in-range query returns
a zero estimate and a wrapped query is distinguishable by the error
alone): 2^32+1 → result 0, nil error; 2^32+25 → result 0, nil;
2^33+3 → result 0, nil. Pins 1/25 succeed and 26/0/-5 error on both
sides. Fix: reject `NumBlocks > math.MaxUint32` with
ErrRPCInvalidParameter before the cast — a representation bound, not a
policy cap; in-range counts still go to the estimator's own depth
check. GREEN: new test pass, `-race -count=2` clean, full node suite
(`go test -tags xmss -count=1 ./node/`) pass, gofmt/vet clean. Branch
fix/estimatefee-numblocks-wrap, commit aacc048d, patch in
fix-pearl-estimatefee-numblocks-wrap.patch.
PR: https://github.com/pearl-research-labs/pearl/pull/411

Rest of the rpcserver.go narrowing sweep, audited and NOT shipped:
- createrawtransaction LockTime (*int64 → uint32): LOOKED like the
  same bug from the cast line, but the handler already range-checks
  LockTime in the int64 domain at its top ("Locktime out of range",
  bound wire.MaxTxInSequenceNum) — the cast is safe. (Constructor-
  guard trap again: read above the cast before writing a RED.)
- node disconnect/remove peer ID: ParseUint(..., 32) bounds the value;
  a wrapped negative int32 can never match a real peer ID, so the
  error path fires — safe by construction.
- setgenerate GenProcLimit (int → int32): admin command with
  documented -1 semantics; left alone (same restraint as #404).
- getnetworkhashps Height/Blocks and searchrawtransactions Skip:
  same cast shape, but on the available fixtures (genesis-only chain,
  empty address index) every wrapped value coincides with a legitimate
  result, so no distinguishing regression test could be written.
  Flagged in #411's body as follow-ups needing multi-block /
  populated-index harnesses rather than shipped untested.

Also this run:
- wPRL #347: still 0 comments, no Pearl-team reply.
- PR #336: still OPEN, MERGEABLE, BLOCKED, only the 2026-09-26 Cursor
  comment — nothing to answer, no rebase needed (upstream master
  unchanged at 2f8b770).
- Open-PR inventory: 40 open before this run, all with records;
  #411 added above — no stranded PRs.
- Sharing: nothing posted — one incremental fix PR is below the
  showcase/X newsworthiness gate (today 2026-10-08's X slot unused).
