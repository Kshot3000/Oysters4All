# Upstream fix — waddrmgr scalar fetches panic on truncated values (Pearl run ~20:13 CDT)

Follow-up sweep after PR #391: audited every remaining `bucket.Get` consumer
in wallet/waddrmgr/db.go at master 2f8b770c. All scalar fetches length-check
their values (fetchWatchingOnly !=1, fetchLastAccount !=4, fetchBlockHash
!=32, fetchBirthday !=8, fetchSyncedTo <36, fetchStartBlock !=36,
FetchBirthdayBlock !=44) — except two that only nil-checked:

1. **fetchManagerVersion (db.go:416)** — `binary.LittleEndian.Uint32(verBytes)`
   on any non-nil value. Own RED: 1-byte stored version →
   `panic: index out of range [3] with length 1` at db.go:416. Called on every
   wallet open (loadManager, manager.go:1465) and by migrations (migrations.go:65).
2. **fetchBirthdayBlockVerification (db.go:2418)** —
   `binary.BigEndian.Uint16(verifiedValue)` on any non-nil value. Own RED:
   1-byte stored value → panic inside binary.BigEndian.Uint16 at db.go:2418.
   Reached via Manager.BirthdayBlock (sync.go:172) during sync setup.

## Fix (PR #394, branch fix/waddrmgr-scalar-fetch-panics, commit fb60c9b1)
- fetchManagerVersion: `len != 4` → existing ErrDatabase error
  ("malformed version number stored in database"), sibling style.
- fetchBirthdayBlockVerification: `len != 2` → false. The function returns
  only a bool and a missing value already means "not verified", so a
  malformed one fails safe identically — never panics, never claims
  verification the record doesn't prove.
- New wallet/waddrmgr/db_scalar_test.go: truncated values (1/2/3-byte version,
  1-byte verification) stored in a real manager DB — both panicked pre-fix,
  clean post-fix; well-formed values round-trip (version 7; verification
  true/false). RED → GREEN, new tests -race clean, full suite
  `go test -tags xmss ./wallet/waddrmgr/` pass (6.9s), gofmt/vet clean.
- Patch: fix-pearl-waddrmgr-scalar-fetches.patch

## Also audited this run, no bug (do not re-derive)
- node/blockchain chainio deserializers (spend journal, utxo entry, best
  chain state, block row): bounds-checked / error-returning.
- node/blockchain/indexers deserializeAddrIndexEntry: length-guarded.
- node/addrmgr deserializePeers: JSON into fixed-size bucket arrays — Go's
  json decoder discards excess array elements, no index panic.
- node/database/ffldb deserializeBlockLoc: unchecked BY DESIGN (doc comment:
  block index carries a checksum); not a finding.
- wallet/snacl SecretKey.Unmarshal: exact-length check before decoding.

## Watches this run
- wPRL issue #347: still OPEN, 0 comments — no Pearl-team reply, NOT re-sent.
- PR #336: OPEN, MERGEABLE, checks SUCCESS.
- PRs #390–#393: only Cursor summary comments since last run, no findings,
  no human reviews. #385/#388/#378 unchanged since their follow-ups.
- No GitHub showcase comment and no X post — today's slots were already used
  by the Nacre posts; PR #394 alone is not digest-worthy.
