# Upstream fix — pearl-research-labs/pearl mempool: free-relay rate limiter is dead code

- **Date:** 2026-10-07 (Pearl builder loop, upstream bug-hunt rotation)
- **Found by:** hunter scan of `node/mempool` + `node/mining` (hidden_files/hunt-2026-10-07/run-1013-mempool/scan.md), then independently re-verified in source + own RED run before fixing.
- **PR opened:** https://github.com/pearl-research-labs/pearl/pull/378 — production fix + regression test. Attribution footer (@kshot9000 + PRL donation address) in the PR body only, never in code.
- **Branch:** `fix/mempool-freerelay-dead-limiter` on Kshot3000/pearl, commit c750f47f, base master @ 2f8b770c
- **Patch:** `fix-pearl-mempool-freerelay.patch` (2 files, +81/−7)

## Bug (verified at master 2f8b770c, node/mempool/mempool.go:1598–1610)

`validateRelayFeeMet` rejects every transaction with `txFee < minFee` up
front; the next branch returns nil for `txFee >= minFee`. Together they
cover all inputs, so the penny-flooding rate limiter below
(`pennyTotal`/`lastPennyUnix` decay budget) is unreachable dead code and
the `isNew`/`rateLimit` parameters are ignored. This contradicts the
repo's own documented contract in three places: `Policy.FreeTxRelayLimit`
("transactions with no fee are rate limited to" X KB/min),
`Policy.DisableRelayPriority` (presupposes free/low-fee relay exists),
and `--limitfreerelay` (node/config.go:130, default 15.0, wired into the
pool in server.go:3089–3091) — the flag was completely inert. Root
cause: the priority machinery the rejection used to be gated on was
removed in the port, leaving the rejection unconditional.

**Reproduced red** (own run): a valid signed zero-fee tx through the
normal relay entry point at default policy was blanket-rejected —
"has 0 fees which is under the required amount of 111".

## Fix

Delete the unconditional rejection (7 lines). The surviving flow is
what the code below already describes: fee-met exit, not-new/
not-rate-limited exit, then the penny-flooding limiter admits free
transactions against the decaying budget and rejects once exhausted.

Deliberately NOT done: wiring `DisableRelayPriority` — its Policy doc
and the `--norelaypriority` flag description pull in different
directions, so no polarity was invented; the PR body asks maintainers
which direction they intend.

## Verification

- New `TestFreeTxRelayRateLimiter`: case 1 zero-fee tx admitted + in
  pool + `pennyTotal` charged at the default 15.0 limit; case 2 with
  limit 0 rejected specifically by the rate limiter. RED before, GREEN
  after, `-race` clean.
- `go test ./node/mempool/ ./node/mining/...` PASS; `go vet` + `gofmt`
  clean.
- Also scanned clean this hunt (no repro, not counted): fee_heap,
  trimToSize accounting, RBF replacement/descendants, orphan handling,
  estimatefee, dust math, mining NewBlockTemplate, cpuminer locking —
  details in the hunter scan.md.
