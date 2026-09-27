# Bug Report — pearl-research-labs/pearl issue #322

**Upstream issue:** https://github.com/pearl-research-labs/pearl/issues/322
**Upstream PR (fix):** https://github.com/pearl-research-labs/pearl/pull/339
**Fix branch:** `fix/neutrino-blockstamp-live-tip` (commit `62da9c56`),
pushed to `Kshot3000/pearl` fork.
**Date:** 2026-09-26 · **Severity:** Medium-High (wallet UX / fund-access scare)

## What was broken

After restarting `oyster` in SPV mode against a synced chain, the first
`sendmany` failed with

```
insufficient funds available to construct transaction
```

even though `listunspent` showed spendable, mature UTXOs and
`getsyncprogress` reported `synced: true`. Mining one more block (any
`BlockConnected` notification) made the same send succeed.

## Root cause

`NeutrinoClient.notificationHandler` (`wallet/chain/neutrino.go`) snapshotted
the best block **once at startup** via `GetBestBlock()` and refreshed the
cached `bs` only when a `BlockConnected` notification was dequeued.
`BlockStamp()` served that cached value through the `currentBlock` channel.

But `onBlockConnected` only enqueues `BlockConnected` for blocks whose
timestamps are at/after the wallet birthday — pre-birthday blocks during the
initial sync only produce `RescanProgress` (every 100 blocks), which never
updated `bs`. So whenever the tip advanced without a `BlockConnected`
(pre-birthday-only sync, or filter headers still catching up when the
snapshot was taken), `BlockStamp()` served a stale height indefinitely.

Coin selection (`wallet/wallet/createtx.go:169`, `findEligibleOutputs`) counts
confirmations and coinbase maturity against that stamp, so every UTXO was
filtered out — a misleading error, since the wallet's own `SyncedTo()` (what
`getsyncprogress` reports as `block_height`) was already at the tip.

## Reproduction

Deterministic unit-level repro: `TestNeutrinoClientBlockStampTracksChainService`
(`wallet/chain/neutrino_test.go`) starts a `NeutrinoClient` against a mock
chain service, advances the mock tip with **no** `BlockConnected` enqueued,
and asserts `BlockStamp()` tracks it. **Fails before the fix** (serves the
stale startup snapshot), **passes after**.

A full live simnet run (pearld + oyster `--usespv`, 105 blocks, restart) was
also performed: with persisted chain data the startup snapshot happened to
be correct, so the live run did not trigger the stale path — the unit test
above is the reliable repro of the mechanism.

## Fix

`BlockStamp()` now consults `CS.BestBlock()` (min of header/filter-header tip)
directly on every call, keeping the existing shutdown semantics via `s.quit`
(returns `disconnected` after `Stop()`). This is also more accurate for
confirmation counting: the wallet only selects from UTXOs it has already
scanned, so the chain-service tip can only make the minconf/coinbase-maturity
math correct, never looser. The now-dead snapshot machinery (`currentBlock`
channel, the `bs` seed/update/serve in the handler) was removed.

## Verification

- New regression test: fails pre-fix, passes post-fix; also covers the
  disconnected-after-`Stop()` case.
- `go test ./wallet/chain/` — full package green.
- `go test -race -run TestNeutrinoClient ./wallet/chain/` — clean.
- `go vet`, `gofmt` — clean. `go build ./wallet/...` — clean.
- Live simnet regression: built `oyster` with the fix, restarted against a
  synced simnet chain at height 105 with mature coinbases — `sendmany`
  succeeds post-restart (no regression), and again after mining one block.

## Notes

- The issue's secondary suggestion (clearer error from `findEligibleOutputs`
  when all UTXOs are height-filtered while synced) was left as a follow-up;
  with this fix the stale-stamp path can no longer produce that state via
  `BlockStamp()`.
- Patch: `fix-pearl-neutrino-blockstamp-322.patch` (applies to upstream
  `master` @ `3fe22676`).

---
Donate PRL: `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`
X: [@kshot9000](https://x.com/kshot9000)
