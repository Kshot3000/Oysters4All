# Bug report — Pearls20bot/PRL20-Indexer does not compile as published

- **Repo:** https://github.com/Pearls20bot/PRL20-Indexer
- **Scanned:** 2026-09-26 (CDT) at commit `c555d09` (2026-05-30, single push)
- **Severity:** CRITICAL (repo cannot build at all)
- **Status:** confirmed, documented, not reconstructed (see note at end)

## What's broken

1. **No `go.mod`.** All imports are rooted at `pearlsbot/…`, implying module
   `pearlsbot`, but no module file exists. `go build ./...` fails immediately.
2. **`internal/blockbook/` missing.** Every blockbook call site dangles:
   `GetBestBlockCtx`, `GetBlockCtx`, `GetRawTxCtx`, `GetTxDetailCtx`,
   `GetAllTxids`, `IsRevealCandidate`, plus the `Block`/`Tx`/`Vout`/`TxDetail`
   types (used in `indexer/indexer/global.go` and `scanner.go`).
3. **`internal/config/` missing.** Dangling references: `config.IndexerDB`,
   `config.IndexerInterval`, `config.MaxScanTx`, `config.ScanWorkers`,
   `config.MaxMintsPerTx` (used in `global.go`, `scanner.go`, `cache.go`).
4. **`indexer/main.go` imports `pearlsbot/internal/indexer`, which doesn't
   exist.** The actual indexer package lives at `indexer/indexer/` (package
   `indexer`). The README's `go run ./cmd/indexer` path doesn't exist either.
5. **Unpinned external deps** (no `go.sum`): `github.com/btcsuite/btcd/wire`
   (scanner.go) and `go.etcd.io/bbolt` (db.go).

## Repro

```bash
git clone https://github.com/Pearls20bot/PRL20-Indexer.git
cd PRL20-Indexer
# go.mod does not exist; adding a scratch `module pearlsbot` module and running:
go build ./...
# → package pearlsbot/internal/indexer is not in std
# → package pearlsbot/internal/blockbook is not in std
# → package pearlsbot/internal/config is not in std
# → no required module provides package github.com/btcsuite/btcd/wire
# → no required module provides package go.etcd.io/bbolt
```

(Verified with Go 1.26.5 linux/amd64 in a scratch copy; the author's checkout
was not modified.)

## What's present and coherent

The code that IS there reads like a working indexer core: bbolt DB layer
(`db.go`), PRL-20/PRC-721 taproot envelope parser (`protocol.go`), parallel
block walker with witness fetching (`global.go`, `scanner.go`), LRU balance
cache (`cache.go`), JSON snapshot writer for a companion process
(`snapshot.go`). This looks like a fragment of a larger Telegram-bot project
(`Pearls20bot`) — roughly half the source was never uploaded.

## Why no fix was attempted

Reconstructing `internal/blockbook`, `internal/config`, `go.mod`, and the
binary layout from inferred API would be speculative invention, not a repair:
the repo is abandoned (one push on 2026-05-30, 0 stars, **no license file**),
and invented packages carry a high risk of API mismatch with the author's
unpublished code. If the project revives, the fix path is: add `go.mod`
(module `pearlsbot`), restore the two internal packages, move
`indexer/main.go` → `cmd/indexer/main.go` (importing the real
`indexer/indexer` package), and pin `btcsuite/btcd` + `bbolt` in `go.mod`.

---

Support Pearl: `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`
· [@kshot9000](https://x.com/kshot9000)
