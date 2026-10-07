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

## Follow-up (2026-10-07, Bugbot review on PR #378 — verified correct, fixed in 0787548f)

Making the limiter reachable exposed a side effect on the dry-run path:
`CheckMempoolAcceptance` (the `testmempoolaccept` RPC) holds only the
pool **read lock**, passes `rateLimit=true`, and never inserts the
transaction — but `validateRelayFeeMet` wrote `pennyTotal` /
`lastPennyUnix` there. Dry runs consumed the penny-flooding budget for
transactions never accepted, and concurrent dry runs raced on the
limiter state.

- Repro (red): 8 concurrent dry runs of one zero-fee tx left
  `pennyTotal=888` (8 × 111 bytes), nothing in the pool; `-race`
  reported data races on the limiter state.
- Fix: a `dryRun` flag threaded `CheckMempoolAcceptance` →
  `checkMempoolAcceptance` → `validateRelayFeeMet`. Dry runs evaluate
  the limiter against the decayed current budget (zero budget still
  rejects with the same rate-limiter error) but charge nothing and
  mutate nothing. Real acceptances under the write lock keep the exact
  previous semantics, including committing decay before the limit
  check.
- Green: `TestFreeTxRelayDryRunDoesNotConsumeBudget` passes with
  `-race` clean (state untouched, following real acceptance charged
  exactly once); full `node/mempool` + `node/mining` suites pass,
  `go build ./node/...` clean. PR comment:
  https://github.com/pearl-research-labs/pearl/pull/378#issuecomment-6042385473
- Lesson: a fix that makes a previously dead code path reachable must
  be audited against EVERY caller of that path — especially callers
  holding a weaker lock or with dry-run semantics. Test-fixture caveat:
  concurrent dry runs in one test must pre-warm `btcutil.Tx`'s lazily
  cached hashes (each RPC call decodes its own Tx; sharing an unwarmed
  one races in the fixture, not the pool).
- Patch: `fix-pearl-mempool-freerelay-dryrun.patch`.
