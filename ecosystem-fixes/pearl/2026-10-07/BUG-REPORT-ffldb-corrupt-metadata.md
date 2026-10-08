# Upstream fix — PR #409: ffldb corrupt-metadata panics (Pearl run ~05:13 CDT, 2026-10-08)

Repo-wide guard-table pass (the follow-up the 2026-10-08 headerfs
lesson queued: grep every `Uint32/Uint64(` consumer of stored values
in one pass instead of package-by-package). Most rows are already
covered by open PRs (#391/#394/#395/#398/#403/#406) or carry real
guards (wtxmgr/waddrmgr post-fix, indexers' tip/addr entries, snacl's
exact-length check, chainio's best-chain-state/vsize checks). The two
unguarded rows left were both in ffldb, the chain database driver
pearld opens at every startup:

1. `deserializeWriteRow` (reconcile.go) sliced the stored write-cursor
   row at `[:8]`/`[8:12]` BEFORE its checksum comparison could return
   ErrCorruption. `reconcileDB` runs on every DB open and only
   nil-checks the row — a torn write leaves a short non-nil value.
   Own RED: panic `slice bounds out of range [:8] with capacity 0`
   at reconcile.go:35.
2. `nextBucketID` (db.go:1108) ran `binary.BigEndian.Uint32` on the
   stored current-bucket-ID with no length check; missing/truncated
   value panicked CreateBucket. Own RED end-to-end: create DB,
   truncate the stored ID to 2 bytes in the metadata leveldb,
   reopen, CreateBucket → panic at db.go:1108.

Fix: both length-check and return database.ErrCorruption (the code
the checksum and missing-row paths already use). New whitebox tests
in corrupt_metadata_test.go; full ffldb suite pass, new tests
-race -count=2 clean, gofmt/vet clean. Branch
fix/ffldb-corrupt-metadata-panics, commit 58ebc0b1, patch in
fix-pearl-ffldb-corrupt-metadata.patch.
PR: https://github.com/pearl-research-labs/pearl/pull/409

Test-writing trap found on the way: serializeWriteRow returns a
sub-slice of a 12-byte array, so `row[:n]` for n<12 keeps cap 12 and
`writeRow[:8]` "succeeds" by reading the array's real bytes — the
first RED attempt reported "expected error, got nil" instead of
panicking. Store-returned values have cap == len; the test copies
into an exact-length slice to reproduce production conditions.

Remaining nil-check-only leads from the same guard table (recorded
for a follow-up run, deliberately not bundled): chainio
dbFetchVersion (nil-only, returns uint32 with no error — fix needs a
signature decision) and dbFetchHeightByHash (nil-only → Uint32;
caller's isNotInMainChainErr contract makes the error shape the
question), indexers/txindex dbFetchBlockIDByHash (nil-only → Uint32).
deserializeBlockLoc stays untouched: unchecked by documented
checksum design.

Also this run:
- wPRL #347: still 0 comments, no Pearl-team reply.
- PR #336: still OPEN, MERGEABLE, only the 2026-09-26 Cursor comment
  — nothing to answer, no rebase needed (upstream master unchanged
  at 2f8b770).
- Open-PR inventory reconciles with records: PRs #370–#408 all have
  records/patches in this folder; #409 added above. No stranded PRs.
- Sharing: nothing posted — one incremental fix PR is below the
  showcase/X newsworthiness gate (no post since 2026-10-07's Nacre
  thread; today 2026-10-08's slot stays unused).
