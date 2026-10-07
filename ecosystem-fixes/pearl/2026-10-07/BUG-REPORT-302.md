# Upstream fix — pearl-research-labs/pearl #302: pruned node drops the whole headers batch

- **Date:** 2026-10-07 (Pearl builder loop, upstream bug-hunt run)
- **Upstream issue:** https://github.com/pearl-research-labs/pearl/issues/302 — "Prune mode drops certificates needed to verify headers" (filed by the Pearl team; proposes, in order: service advertisement, refuse-what-we-can't-serve in OnGetHeaders, an error-returning LocateHeaders API, non-prunable cert storage)
- **PR opened:** https://github.com/pearl-research-labs/pearl/pull/370 — implements proposed items 2 + 3
- **Branch:** `fix/locate-headers-error-302` on Kshot3000/pearl, commit f68270af, base master @ 2f8b770c
- **Patch:** `fix-pearl-locate-headers-302.patch` (5 files, +121/−16)

## Bug (verified at master 2f8b770c)

Certificates live only inside ffldb block files; pruning deletes those files while headers survive in the block index. On a `getheaders` range reaching a pruned block, `dbFetchCertificate` fails (`ErrBlockNotFound`), `locateHeaders` (node/blockchain/chain.go) logged the error and returned nil — the **entire batch** dropped. `OnGetHeaders` then queued an empty `MsgHeaders` (read by the requester as "you are synced" → stall → disconnect of the pruned node), and the `getheaders` RPC returned an empty list indistinguishable from "no headers after your locator".

## Reproduction (red)

New harness state replicating pruning exactly: a block whose header/status/vsize are stored via `dbStoreBlockHeader`/`dbStoreBlockStatus`/`dbStoreBlockVsize` but whose block data is never stored, followed by two normally-stored blocks, locator = genesis.

- Against the old API: `LocateHeaders(locator, zero, includeCerts=true)` returned **0 headers, no signal** (test failed as designed); `includeCerts=false` returned all 3 headers — only the certificate read fails.
- After the fix (`TestLocateHeadersPrunedBlock`): certs case returns the error and nil headers; no-certs case still serves all 3.

## Fix

- `locateHeaders`/`LocateHeaders` return `([]wire.MsgHeader, error)` and propagate the read failure.
- `OnGetHeaders`: on error, log at debug and ignore the request — no misleading empty batch.
- `handleGetHeaders` (RPC): returns `ErrRPCDatabase` ("Failed to get block headers: …").
- `rpcSyncMgr.LocateHeaders` + `rpcserverSyncManager` interface updated.
- Existing tests `TestLocateInventory`, `TestLocateHeadersCertificateFiltering` updated to the new signature.

## Verification

- `go build ./node/...` PASS, `go vet ./node/...` PASS, `gofmt` clean.
- `go test ./node/` PASS. Locate tests (incl. new regression) PASS.
- Full `go test ./node/blockchain/`: only failure is `TestCheckBlockSanity`, which fails **identically on unmodified master** in this container (needs `-tags zkpow` native lib) — pre-existing/environmental.
- PR #370 verified OPEN + MERGEABLE with the full description and attribution footer after creation.

## Also hunted this run (no PR — verified clean or not actionable)

- Fresh wallet code from #265/#349/#352/#317 (`Wallet.ListTransactions` paging, `newestFirst`, `pending.go` ancestry/rebroadcast, oystercli page planner): read line-by-line + existing suites (blockchain 30, oystercli 291, legacyrpc 87 tests pass) — no bug confirmed. One subagent report claiming a `listtransactions` default-count bug was **fabricated** (the described code does not exist at master; its scratch dir was empty) — discarded after direct source verification.
- spark-pearl-miner delta-scan #4 (36 commits past 4e37e58: Kryptex v2 gzip sessions, per-pool login, clock-cap detector): 549-test workspace baseline green, delta test files pass, password non-disclosure asserted by a dedicated harness — NO BUGS FOUND.
- Issue triage: #301 (netsync wedge) still present at master, fix sketched (rotate a below-tip outbound peer when stalled-not-current and no sync candidate exists) — larger change, queued for a future run. #131 is correct-behavior/already answered in-thread (overlaps open PR #365 — do not duplicate). #354 resolved by its reporter; not reproducible.
- Watches: wPRL #347 still OPEN, 0 comments (no Pearl-team reply; not re-sent). Kyle's PR #336 still OPEN / MERGEABLE / BLOCKED, CI green. PR #310 (metrics) now shows CONFLICTING after master moved (its commits unchanged since 2026-09-02) — the author's to rebase, not Kyle's.
