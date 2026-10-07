# Upstream fix — pearl-research-labs/pearl: SPV LRU cache `Put` leaks the mutex on the eviction-error path (permanent deadlock)

- **Date:** 2026-10-07 (Pearl builder loop, upstream bug-hunt rotation — spv/ + tools/ + wallet/cmd scan)
- **PR opened:** https://github.com/pearl-research-labs/pearl/pull/376 — OPEN, MERGEABLE, attributed body verified (2,034 chars; @kshot9000 + PRL donation address in the PR body only, never in code).
- **Branch:** `fix/spv-lru-put-evict-unlock` on Kshot3000/pearl, base master @ 2f8b770c
- **Patch:** `fix-pearl-spv-lru-unlock.patch` (2 files, +72)

## The bug

`spv/cache/lru/lru.go`, `(*Cache).Put`: `c.mtx.Lock()` at line 148, then

```go
evicted, err := c.evict(vs)
if err != nil {
    return false, err // returned WITHOUT c.mtx.Unlock()
}
```

The neighbouring existing-value `Size()` error branch (lines 153–154) unlocks correctly — this one was missed. `sync.RWMutex` is not re-entrant and no other owner can release it, so one failed eviction locks the cache forever: every later `Put`/`Get`/`LoadAndDelete` (`Lock`) and `Len`/`Size` (`RLock` behind a held write lock) blocks. This cache backs neutrino's `FilterCache`, `BlockCache`, and `knownAddresses` (`spv/neutrino.go`), so SPV sync wedges silently and permanently.

Reachability: `evict()` fails when a resident entry's `Size()` errors during eviction sizing. `cache.Value.Size()` is explicitly fallible (`spv/cache/cache.go`), and production `CacheableFilter.Size()` (`spv/cacheable_filter.go`) can error via `gcs.Filter.NBytes()`; values are stored by pointer, so a size readable at insertion can fail at eviction time.

## Fix

One line — `c.mtx.Unlock()` before returning `evict()`'s error — plus regression test `TestPutEvictErrorUnlocksCache` in new file `spv/cache/lru/lru_evict_error_test.go` (capacity-10 cache, 6-unit resident whose `Size()` starts failing, second 6-unit `Put` forces the eviction error, then a probe proves `Size`/`Get`/`Put` still complete).

## Verification

- RED first (my own run, unpatched master): test fails after its 10s probe — "cache is deadlocked after a failed eviction in Put".
- GREEN: `go test ./spv/cache/lru/ -count=1` PASS; new test `-race -count=2` PASS; `go vet` + `gofmt` clean; `go test ./spv/...` PASS on two consecutive full runs (one earlier run showed a single FAIL line in an unrelated package outside the tail window; lru was green in every run).

## Follow-up (2026-10-07 ~08:13 CDT run) — `LoadAndDelete` ghost entry, same PR

Commit `76bbc300` pushed to the same PR #376 branch, with an explanatory comment on the PR. Same file, same root cause (the fallible-`Size()` assumption the 04:13 scan had flagged as a secondary observation):

`LoadAndDelete` removed the key from the lookup map **before** calling `Size()`. On a `Size()` error it returned `(nil, false)` — "not deleted" — while the entry was stranded as a ghost: gone from the map, still in the recency list, still counted in `Size()`, unreachable by `Get`, and double-counted if the same key was `Put` again.

Fix: `Load` (not `LoadAndDelete`) first, then under `c.mtx` re-check the map still points at the exact loaded element, size **before mutating anything**, and only then callback + map/list removal + size decrement — removal inside the same lock hold means exactly one concurrent deleter can win.

Verification: new regression test `TestLoadAndDeleteSizeErrorKeepsEntry` — RED pre-fix (`Get` returns "unable to find element" after the failed delete), GREEN post-fix; full `spv/cache/lru` package passes; LoadAndDelete/callback/concurrency tests `-race` clean; `go test ./spv/cache/...` passes; gofmt + vet clean. Patch file regenerated (2 files, +135/−3 vs master). PR head `76bbc300`, MERGEABLE. Watches this run: wPRL #347 still 0 comments; PRs #370–#377 Bugbot = summaries only, no new findings; #336 unchanged, no rebase needed.

## Follow-up 2 (2026-10-07 ~09:13 CDT run) — `Put` map access not atomic with its list update, same PR

Commit `b135fc3e` pushed to the same PR #376 branch, with an explanatory comment on the PR (https://github.com/pearl-research-labs/pearl/pull/376#issuecomment-6040395523). Trigger: Bugbot's re-review of `76bbc300` (posted 13:33Z, after the 08:13 run) — "Delete can drop a concurrent Put", Medium. Verified claim-by-claim in code; the mechanism is real, with the root in `Put`, not in the reworked `LoadAndDelete`:

`Put` loaded the existing element from the lookup map **before** acquiring `c.mtx` and stored its replacement **after** releasing it. A `LoadAndDelete` (or second `Put`) for the same key landing in either window left the first `Put` mutating the list and size accounting for an element that was no longer the one in the map — its size subtracted a second time (corrupting, potentially underflowing, the uint64 accounting), or the newer element orphaned in the list: counted in `Size()`, unreachable via `Get`. `LoadAndDelete`'s under-lock identity re-check cannot close this, because the stale snapshot is taken and published entirely outside the lock on the `Put` side.

Fix: `Put` now loads any existing element and stores its replacement under the same `c.mtx` hold as the list/size mutations (`defer Unlock`, which also keeps the b297219d evict-error unlock intact), so map, list and accounting change atomically. Considered and left alone: `Get` returning a value a concurrent delete just removed is a linearizable stale read, and its `MoveToFront` is membership-guarded in `list.go` — it cannot corrupt the list.

Verification: new regression test `TestConcurrentSameKeyPutDeleteInvariants` (in-package, 8 goroutines × 2000 same-key Put/LoadAndDelete/Get, then asserts map/list/size agreement) — RED on `76bbc300` in 3/3 runs (size accounting diverged from the list contents within milliseconds: 0x5f/0x62 vs the true total), GREEN after in 3/3 runs; full `spv/cache/lru` package passes with `-race`; `go vet` + `gofmt` clean; `go build ./spv/...` passes. Patch file regenerated (3 files, +249/−15 vs master 2f8b770c). PR head `b135fc3e`, MERGEABLE.

Watches this run: wPRL #347 still OPEN, 0 comments — no Pearl-team reply, not re-sent. Kyle's PRs #336, #370–#375, #377 re-checked for reviews newer than their last fix pushes: none (the #373 comments that look recent are the 10:32Z reviews the 06:13 run already fixed in 40928d81 — judge by `created_at`, the API re-anchors `commit_id` to the current head). In-dev PRs #369/#311/#310/#366 and issue #303 unchanged since last check. Showcase digest for today was already posted (05:39Z) — no digest, no X post this run.

## Also checked and NOT duplicated this run

- Issue #209 (desktop 10s RPC timeout): already fixed at master — `rpc-client.ts` defaults to 60s with a comment describing exactly this issue. Issue still open upstream; no PR needed.
- Issue #144 (`generate_wallet.py` unspendable addresses): the named file does not exist anywhere in the repo (code search + tree search) — nothing to fix in-tree.
- Issues #255 / #233: user-environment wallet reports, not container-verifiable code defects.
- Watches: wPRL #347 OPEN, 0 comments — no Pearl-team reply, NOT re-sent. Kyle's PRs #336, #370–#375 all OPEN/MERGEABLE; Bugbot comments are summaries only (the one substantive finding, on #373, was already fixed last run). #336 still 0 behind master — no rebase needed. In-dev: #310 CONFLICTING (author's branch, hands off), #311/#369/#366/#221 unchanged.
- Scan notes (hunter + my verification): `hidden_files/hunt-2026-10-07/run-0413/scan.md` — candidates in banman/chainimport/tools honestly rejected with reasons.
