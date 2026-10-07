# Upstream fix — pearl-research-labs/pearl #296: flaky PrunedBlockDispatcher parallel tests

- **Date:** 2026-10-07 (Pearl builder loop, upstream bug-hunt rotation)
- **Upstream issue:** https://github.com/pearl-research-labs/pearl/issues/296 — `wallet/chain` PrunedBlockDispatcher tests fail intermittently in CI (`TestPrunedBlockDispatcherMultipleQueryPeers`: "expected nil err to signal completion" + "did not consume all queriedPeer signals"; `TestPrunedBlockDispatcherQuerySameBlock`: "expected peer to be dialed"), pass locally.
- **PR opened:** https://github.com/pearl-research-labs/pearl/pull/374 — test harness only, no production code. Verified OPEN + MERGEABLE, attributed body (3,333 chars, PRL address + @kshot9000 footer present).
- **Branch:** `fix/pruned-dispatcher-flaky-harness` on Kshot3000/pearl, commit c0f33ab3, base master @ 2f8b770c
- **Patch:** `fix-pearl-pruned-dispatcher-296.patch` (1 file, +84/−25)

## Also checked and NOT duplicated this run

- Issue #123 (getmininginfo blocksubsidy): PR #124 by the issue's author already implements it exactly (next-block subsidy, OPEN/MERGEABLE) — a duplicate PR would be spam.
- In-dev PRs: #310 is now CONFLICTING (author's branch; can't push to it), #311/#330/#349/#366/#369 all MERGEABLE/UNKNOWN with no genuine opening. PRs #370–#373 from earlier runs today: all OPEN + MERGEABLE.

## Bug (verified at master 2f8b770c, wallet/chain/pruned_block_dispatcher_test.go)

1. Dial/query notifications were sent from throwaway goroutines into **unbuffered** channels (`dialedPeer`, `queriedPeer`). A not-yet-scheduled sender is invisible; a blocked sender is indistinguishable from a real extra event; neither signal happens-before the event it reports.
2. Every required-event wait used a fixed 5s wall clock (disconnect detection 1s), while the events ride real TCP peer handshakes plus a work manager whose per-attempt timeout is 2s doubling under a 30s total — a slow runner expires the clock while behaving correctly.
3. `stop()` treated exact signal consumption as an invariant. A slow first attempt is legitimately retried (second getdata) even when the request completes, so a correct run can leave a notification unconsumed.

**Reproduced red before fixing** — suite pinned to one CPU with background CPU load and `-race`, matching a loaded CI runner: QuerySameBlock "expected peer to be dialed", MultipleQueryPeers "expected nil err to signal completion" AND "did not consume all queriedPeer signals" — all three signatures from the issue, in one run.

## Fix

- Notifications sent **synchronously into buffered channels** (capacity 256, sized in a comment against the maximum sends a test can trigger): dial signal happens-before `Dial` returns; query signal happens-before the peer queues its reply.
- One named `harnessTimeout` (1 minute) for all required-event waits (dial, query, reply, completion, failure, disconnect poll), replacing the scattered 5s/1s clocks. Negative waits (`assertNoPeerDialed`/`assertNoReply`, 2s) unchanged.
- `stop()` drains and logs leftover notifications instead of failing on them; reply accounting (`blocksQueried` empty) is still asserted exactly.

## Verification

- Same stress rig post-fix: full dispatcher suite `-race -count=2` PASS; the two named tests `-race -count=3` PASS (0 failures in 20+ stressed runs vs 3 failures in 6 pre-fix).
- Unstressed: dispatcher suite `-count=3` 21/21 PASS with the drain log silent (consumption still exact in normal conditions); full `go test ./wallet/chain/` PASS; `gofmt`/`go vet` clean.
- Honest limit (also in the PR): flake fixes are probabilistic — only CI over time proves a flake dead.

## Watches this run

- wPRL #347: still OPEN, 0 comments — no Pearl-team reply; not re-sent.
- Kyle's PR #336: still OPEN / MERGEABLE / BLOCKED, CI green — no rebase needed, no reviewer action to answer.
- Kyle's upstream PRs now open: #336, #370, #371, #372, #373, #374 + spark-pearl-miner #3.
- Sharing: GitHub showcase digest already posted twice today by earlier runs (03:27Z, 05:39Z — over the 1/day gate), so no digest and no X post this run; PR #374 itself is the upstream share.
- Environment: /tmp still 100% full (512M tmpfs, stale go-build caches from concurrent loops); `TMPDIR=~/.cache/chrome-tmp` + `GOCACHE=~/.cache/go-build` workaround used throughout, per the 2026-10-07 lesson.
