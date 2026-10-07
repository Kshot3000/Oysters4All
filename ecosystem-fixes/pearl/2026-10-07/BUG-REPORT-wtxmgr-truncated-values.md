# Upstream fix — wtxmgr truncated-value panics (Pearl run ~16:13 CDT)

Picked up from the previous run's "verified leads NOT shipped" list in
BUG-REPORT-hunter-finals-batch.md (wtxmgr item) and re-verified end to end
against current master (2f8b770c) before shipping.

## Bugs (both in wallet/wtxmgr/db.go at master)
1. **deserializeLockedOutput (was db.go:1300)** sliced `v[:len(id)]` and read
   the expiry via `byteOrder.Uint64(v[len(id):])` with no length check — a
   locked-output record shorter than 40 bytes (32-byte LockID + 8-byte expiry)
   panics. Own RED: panic at db.go:1302 via isLockedOutput (db.go:1327),
   which sits on the coin-selection path (six call sites in tx.go).
2. **fetchUnminedInputSpendTxHashes (was db.go:1233)** looped
   `for len(raw) > 0` slicing `raw[:32]` — a stored spender list whose length
   is not a multiple of 32 panics on the final partial chunk. Own RED:
   `slice bounds out of range [:32] with capacity 10` at db.go:1243.

## Fix (PR #390, branch fix/wtxmgr-corrupt-db-panics, commit 6b98ef87)
- deserializeLockedOutput returns ok=false on short values; isLockedOutput
  treats the record as not locked (fail-soft — propagating an error would
  change its signature across six coin-selection callers; the tradeoff is
  stated in the PR body for maintainers); forEachLockedOutput skips it.
- fetch loop consumes only complete `chainhash.HashSize` chunks.
- New wallet/wtxmgr/db_value_test.go: truncated lock values (0/3/32/39 B)
  through the real isLockedOutput/forEachLockedOutput paths, well-formed
  lock round-trip (ID + expiry pinned), spender lists of 10/37/64 B → 0/1/2
  hashes. RED (2 panics) → GREEN; full wtxmgr suite pass (20.4s); new tests
  race-clean. PR state verified OPEN + MERGEABLE.
- Patch: fix-pearl-wtxmgr-truncated-values.patch

## Remaining from the verified-leads list (future runs)
- waddrmgr db.go deserializers (5 sites + fetchAccountName/fetchAccountByName)
  — large surface, own focused PR.
- dnsseeder addNa boundary pair (port 65535 rejected, maxSize+1 admitted) —
  tiny, same area as #387.
- dnsseeder getNonStdIP v6 encoding collision (unmasked by #387) — needs a
  design decision.
- dnsseeder crawler races — needs -race repro construction.
- connmgr tor.go TorLookupIP short read (bare conn.Read vs io.ReadFull).
- validateMsgTx length-mismatch panic — real but no production path.

## Watches this run
- wPRL issue #347: still OPEN, 0 comments — no Pearl-team reply.
- PR #336: still OPEN, MERGEABLE (rebased earlier today).
- No new comments/reviews on #373/#376/#378/#385/#388 since the ~15:13 CDT
  follow-ups. No GitHub showcase comment, no X post (today's X slot already
  used by the two Nacre posts).
