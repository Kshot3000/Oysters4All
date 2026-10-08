# Upstream fix — spv/banman fetchStatus panics on corrupt ban-store values (Pearl run ~03:13 CDT, 2026-10-08)

## Bug (spv/banman/store.go at master 2f8b770)
`fetchStatus` read two stored values with no length checks:
- `reasonIndex.Get(ipNetKey)[0]` (store.go:237) — a ban entry whose reason
  entry is missing/empty panics `index out of range [0] with length 0`
  (own RED, verified).
- `byteOrder.Uint64(v)` (store.go:238) — only a nil check guarded the
  ban-index value, so a truncated expiration panics inside
  `binary.BigEndian.Uint64`: `index out of range [7] with length 3`
  (own RED, verified).

Reachability: `Status` is consulted by `ChainService.IsBanned`
(spv/neutrino.go) on peer paths, so one damaged record crashes every ban
check and recurs on every restart — the entry is never removed. Found by
grep'ing every `Uint32/Uint64([` consumer in spv/ + blockchain indexers
and tracing each one's guard; banman was the unguarded outlier (addrindex,
txindex, indexer-tip, and best-chain-state deserializers all length-check
first; chainio scalar fetches were already recorded audited-clean).

## Fix (PR #403, branch fix/spv-banman-corrupt-store-panics, commit b62372a9)
- Ban-index value that isn't exactly 8 bytes reads as no ban; the caller
  already deletes zero-expiration entries, so the corrupt record heals on
  first read.
- Missing/empty reason degrades to the zero reason ("unknown reason");
  the ban itself still applies — reason is informational, expiration is
  the enforcement data.

## Tests
New `spv/banman/store_corrupt_test.go` (`TestBanStoreCorruptValues`): bans
via the public API in a real bdb store, then damages the raw buckets —
truncated expiration (RED panic at :238 → not-banned + entry removed) and
deleted reason (RED panic at :237 → banned, reason 0, real expiration).
Full `spv/...` suite passes; `spv/banman` clean under `-race`. Patch:
`fix-pearl-spv-banman-corrupt-store.patch`. PR body:
hidden_files/hunt-2026-10-07/pr-body-banman.md.
