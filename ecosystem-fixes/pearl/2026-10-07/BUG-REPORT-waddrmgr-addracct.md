# waddrmgr address-account index + account-key guards — PR #396 (2026-10-07, ~22:13 CDT run)

Follow-up to PRs #391/#394: completed the guard-table audit of
`wallet/waddrmgr/db.go` at master 2f8b770c. Two stored-data reads still
decoded a fixed-width account number with no length check, both verified
with own REDs in a real manager DB (setupManager):

1. **fetchAddrAccount (db.go:1816)** — only a nil check on the
   address-account index value; `binary.LittleEndian.Uint32(val)` panics
   for stored values of 1–3 bytes. Own RED: panic at db.go:1841
   (`[:4] with capacity 3`). Sole path is ScopedKeyManager.AddrAccount.
   Fix: len < 4 → existing ErrDatabase error; missing entry still
   returns ErrAddressNotFound (pinned by test).
2. **forEachAccount (db.go:987)** — decoded every account-bucket key
   unchecked; a key shorter than 4 bytes with a value panics. Own RED:
   panic at db.go:1010. Neighbours guard their keys (forEachKeyScope
   skips !=8, deleteBlockHashesFrom skips !=4). Fix: len != 4 →
   ErrDatabase (error chosen over skip so an account is never silently
   dropped from iteration; the choice is stated in the PR body for
   maintainers).

## Audited clean this run — checked and rejected (do not re-derive)
- Deserializer fixed headers: deserializeAccountRow (<5), deserialize-
  AddressRow (<18), deserializeDefaultAccountRow (<20 rawData),
  deserializeImportedAddress (<8), deserializeWitnessScriptAddress
  (minLength 10), deserializeChainedAddress (<8) all guard before their
  first fixed-width read — #391's interior prefix checks sit behind
  these, so no sub-header panic remains there.
- indexers/manager.go dbFetchIndexerTip guards len < HashSize+4.
- psbt ReadBip32Derivation guards len < 4 and len % 4.
- chainio / addrindex / ffldb deserializeBlockLoc / snacl: audited
  clean in the ~20:13 run, unchanged at this master.
- wallet/chain filterPeers Uint64 on hex-decoded peer services: the
  services string is produced by the local node's own getpeerinfo
  formatting (always 8 bytes); no reachable short input found — not
  shipped.

## Verification (commit 97dc3188, branch fix/waddrmgr-addracct-fetch)
- New wallet/waddrmgr/db_addracct_test.go: truncated index values
  (1/2/3 B) RED→GREEN, well-formed round-trip to account 7,
  missing-entry ErrAddressNotFound pin, short account key RED→GREEN
  with ErrDatabase assertion. (ManagerError is a value type — assert
  with waddrmgr.IsError, not a *ManagerError type assertion.)
- Full waddrmgr suite pass with -tags xmss (5.9s); new tests
  race-clean (1.5s); go build ./wallet/... pass; gofmt + go vet clean.
- PR #396 verified OPEN + MERGEABLE after opening.
- Patch: fix-pearl-waddrmgr-addracct-fetch.patch

## Watches this run
- wPRL issue #347: still OPEN, 0 comments — no Pearl-team reply.
- PR #336: still OPEN, MERGEABLE, BLOCKED (unchanged).
- PRs #390–#395: only Cursor summary comments since opening, no
  substantive bot findings to act on.
- No GitHub showcase comment, no X post (today's X slot already used
  by the two Nacre posts; a single follow-up guard PR is queue depth,
  not a digest-worthy event). 26 upstream PRs now open under Kyle.
