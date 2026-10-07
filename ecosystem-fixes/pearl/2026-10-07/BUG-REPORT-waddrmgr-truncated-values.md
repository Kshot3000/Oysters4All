# Upstream fix — waddrmgr truncated-value panics (Pearl run ~17:13 CDT)

Picked up from the "remaining verified leads" list in
BUG-REPORT-wtxmgr-truncated-values.md (waddrmgr deserializers — the biggest
remaining item) and re-verified end to end against current master (2f8b770c)
before shipping. This is the waddrmgr counterpart to PR #390 (wtxmgr).

## Bugs (all in wallet/waddrmgr/db.go at master; every one own-RED panicked)
1. **deserializeAccountRow (panic db.go:717)** — rdlen unchecked before
   `serializedAccount[5:5+rdlen]`.
2. **deserializeDefaultAccountRow (panic db.go:761)** — pubLen/privLen/nameLen
   walked with unchecked offsets; a pubkey length consuming the whole record
   also panics on the privkey-length read past the end.
3. **deserializeAddressRow (panic db.go:1354)** — rdlen unchecked vs the
   18-byte header's stored remainder.
4. **deserializeImportedAddress (panic db.go:1446)** — pubLen/privLen unchecked.
5. **deserializeWitnessScriptAddress (panic db.go:1505)** — hashLen/scriptLen
   unchecked.
6. **fetchAccountName (panic db.go:1048)** — name-length read on a value
   shorter than 4 bytes + nameLen unchecked; **fetchAccountByName** —
   `binary.LittleEndian.Uint32(val)` on a value shorter than 4 bytes.
Safe sibling (contrast, not touched): deserializeWatchOnlyAccountRow already
parses via bytes.Reader + binary.Read. deserializeChainedAddress uses fixed
offsets + rest-of-slice only — safe.

## Fix (PR #391, branch fix/waddrmgr-corrupt-db-panics, commit ea00c517)
- Every length prefix checked against the bytes actually remaining before
  slicing or allocating; shortfalls return the existing ErrDatabase
  "malformed serialized …" error each function already used for its
  minimum-length check. No signature changes; well-formed records parse
  exactly as before (also removes the unbounded make([]byte, rdlen)
  allocation on corrupt data).
- New wallet/waddrmgr/db_value_test.go: truncated/lying-length cases for all
  five deserializers, a 2-byte corrupt value in both account index buckets
  through a real manager DB for fetchAccountName/fetchAccountByName, and
  serialize→deserialize round-trips pinning the unchanged contract.
- RED (6 panics, lines above) → GREEN; full waddrmgr suite passes with
  `-tags xmss` (6.7s; untagged run fails only the pre-existing xmss-tag
  tests — environmental, needs `make -C xmss lib` + the tag in this
  worktree); new tests race-clean. PR verified OPEN + MERGEABLE.
- Patch: fix-pearl-waddrmgr-corrupt-db-panics.patch

## Remaining from the verified-leads list (future runs)
- dnsseeder addNa boundary pair (port 65535 rejected, maxSize+1 admitted) —
  tiny, same area as #387.
- dnsseeder getNonStdIP v6 encoding collision (unmasked by #387) — needs a
  design decision.
- dnsseeder crawler races — needs -race repro construction.
- connmgr tor.go TorLookupIP short read (bare conn.Read vs io.ReadFull).
- validateMsgTx length-mismatch panic — real but no production path.

## Watches this run
- wPRL issue #347: still OPEN, 0 comments — no Pearl-team reply.
- PR #336: still OPEN, MERGEABLE.
- No GitHub showcase comment, no X post (today's X slot already used by the
  two Nacre posts; a single hardening PR is below the newsworthy gate).
