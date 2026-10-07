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

## Also checked and NOT duplicated this run

- Issue #209 (desktop 10s RPC timeout): already fixed at master — `rpc-client.ts` defaults to 60s with a comment describing exactly this issue. Issue still open upstream; no PR needed.
- Issue #144 (`generate_wallet.py` unspendable addresses): the named file does not exist anywhere in the repo (code search + tree search) — nothing to fix in-tree.
- Issues #255 / #233: user-environment wallet reports, not container-verifiable code defects.
- Watches: wPRL #347 OPEN, 0 comments — no Pearl-team reply, NOT re-sent. Kyle's PRs #336, #370–#375 all OPEN/MERGEABLE; Bugbot comments are summaries only (the one substantive finding, on #373, was already fixed last run). #336 still 0 behind master — no rebase needed. In-dev: #310 CONFLICTING (author's branch, hands off), #311/#369/#366/#221 unchanged.
- Scan notes (hunter + my verification): `hidden_files/hunt-2026-10-07/run-0413/scan.md` — candidates in banman/chainimport/tools honestly rejected with reasons.
