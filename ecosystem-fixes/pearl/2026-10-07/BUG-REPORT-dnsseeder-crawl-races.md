# Upstream fix — dnsseeder crawl-state data races (Pearl run ~01:13 CDT 2026-10-08)

Picked up the carried "dnsseeder crawler races — needs -race repro
construction" lead from BUG-REPORT-wtxmgr-truncated-values.md and built the
repro. Master unchanged at 2f8b770c.

## Bugs (both verified with the race detector)
1. **startCrawlers writes under a read lock (seeder.go)** — it held only
   `s.mtx.RLock()` while writing `nd.crawlActive = true` and
   `nd.crawlStart = time.Now()`. RLock does not exclude other RLock holders,
   and the HTTP node-details handler (`nodeHandler`, http.go) reads exactly
   those fields (Crawlactive / Crawlstart) under RLock. crawlStart is a
   multi-word time.Time, so the status page can also render a torn value.
   Every other node-state writer (processResult, auditNodes) takes Lock —
   startCrawlers was the odd one out.
2. **crawlIP reads theList unlocked (crawler.go)** — `len(s.theList)` on
   crawler goroutines with no lock, racing processResult→addNa map inserts
   and auditNodes deletes (concurrent map read/write can fatal).

## Repro / fix (PR #399, branch fix/dnsseeder-crawl-races, commit 36982101)
- New dnsseeder/race_test.go: 200 loopback nodes on a refused port (crawlers
  fail fast at dial), startCrawlers+processResult cycling against 4
  goroutines rendering nodes through the real nodeHandler.
- Own RED: two DATA RACE warnings — write seeder.go:215/216 (crawlActive /
  crawlStart) vs read http.go:388/396 (nodeHandler).
- Fix: startCrawlers RLock → Lock (nothing it calls takes s.mtx; no
  re-entry), crawlIP length read under RLock.
- GREEN: `go test -race -count=2` clean (12.3s), full dnsseeder suite pass,
  vet/gofmt clean. The crawlIP half is covered by lock audit, not the race
  test — reaching that line needs a completed peer handshake; stated
  honestly in the PR body.
- Patch: fix-pearl-dnsseeder-crawl-races.patch (155 lines, three-dot diff).

## Also this run
- Watches: wPRL #347 OPEN, 0 comments — no Pearl-team reply, NOT re-sent.
  PR #336 OPEN/MERGEABLE/BLOCKED, unchanged. Newest PRs #390–#398 carry
  only Cursor summary comments (verified per-PR via the REST API, not the
  bulk sweep) — no Bugbot findings, no human reviews. In-dev PRs
  #310/#311/#330/#349/#369 + issue #303 unchanged; #366 is CLOSED (merged
  upstream before this run).
- Hunter (Python gateway/py-pearl-mining/tools/proxy Python): CLEAN
  verdict — every wire parser length-checks or is length-prefixed, the
  zkcert-class slicing pattern appears nowhere else, the one suspicious
  consumer (stratum_client GetworkParser) is correct, `top_k` is
  operator config not wire data. NOT audited (future lead): the
  miner/pearl-gateway/pearl_gateway/*.py subpackage (coordinator, vllm
  miner, job tracker), proxy Go plugins beyond the JSON-RPC cache, spv/,
  apps/ TS, coredns-dnsseed plugin.
- Hunter (node RPC/btcjson): still out at record time.

## Remaining leads
- dnsseeder getNonStdIP v6 collision — design decision for maintainers
  (raised in #387's orbit; not a patch).
- pearl_gateway/*.py subpackage audit (new, from the clean hunter report).
- validateMsgTx — closed (no production path).
