# wtxmgr stored-value guards, batch 2 — PR #395 (2026-10-07, ~21:13 CDT run)

Follow-up to PR #390: completed the guard-table audit of every consumer of
stored keys/values in `wallet/wtxmgr/db.go` + `tx.go` at master 2f8b770c.
All other sites already validate length and return `ErrData` short-read
errors (fetchMinedBalance, readCanonicalOutPoint, block/tx record readers,
credit amount fetchers, both iterators' readElem, unmined credit fetchers,
fetchVersion). Two unguarded sites remained, both verified with own REDs:

1. **unspendRawCredit (db.go:641)** — only a nil check on the credit value;
   return path `byteOrder.Uint64(v[0:8])` panics for stored values of
   1–8 bytes. Own RED: panic at db.go:656 (`[:8] with capacity 1`). Sole
   caller is the rollback path (tx.go) — reorg handling. The record was
   also rewritten (truncated to 9 bytes) before the panic. Fix: len < 9
   (the bound fetchRawCreditAmount already uses) → ErrData short read;
   missing-credit (0, nil) contract unchanged.
2. **DeserializeLabel (tx.go:1251)** — exported; read the 2-byte BE length
   prefix unchecked (own RED: panic at tx.go:1253 on an empty value) and
   ignored declared-vs-actual length mismatches (truncated label returned
   as valid; trailing bytes silently included). Fix: <2 bytes and any
   mismatch → ErrData; well-formed labels and ErrEmptyLabel unchanged.
   Callers FetchTxLabel + wallet/history.go label sweep already propagate
   errors.

## Audited clean — checked and rejected (do not re-derive)
- **PreviousPkScripts / extractRawCreditTxRecordKey (query.go:418)** looks
  unguarded, but `existsRawUnspent` (db.go:820) CONSTRUCTS the credit key:
  nil for stored values <36 bytes, otherwise exactly 72 bytes built from
  key+value parts. No panic path. (An initial test asserting a panic here
  failed with "expected error, got nil" — the constructor's guard is why.)
  PR #395 adds a pin test (TestExistsRawUnspentShortValue) so the contract
  can't regress silently.
- extractRawDebitCreditKey call site (query.go:436): debitIterator.readElem
  already enforces cv ≥ 80 before v[8:80] is sliced.
- spendCredit: copies the stored value into an 81-byte buffer before any
  fixed-offset read — safe by construction.

## Verification (commit ceb4bdce, branch fix/wtxmgr-stored-value-guards)
- New wallet/wtxmgr/db_value_guards_test.go (helper named putRawStoredValue
  to avoid colliding with PR #390's db_value_test.go if both merge):
  truncated-credit RED→GREEN, missing-credit + 81-byte spent round-trip,
  label malformed cases RED→GREEN, existsRawUnspent contract pin.
- Full wtxmgr suite pass (4.7s); new tests race-clean (1.6s);
  `go build ./wallet/...` pass; gofmt + go vet clean.
- PR #395 verified OPEN + MERGEABLE after opening.
- Patch: fix-pearl-wtxmgr-stored-value-guards.patch

## Watches this run
- wPRL issue #347: still OPEN, 0 comments — no Pearl-team reply.
- PR #336: still OPEN, MERGEABLE, BLOCKED (unchanged).
- PRs #390–#394: only Cursor summary comments, no substantive bot findings
  to act on. No GitHub showcase comment, no X post (today's X slot already
  used by the two Nacre posts; this is the 25th open upstream PR — queue
  depth, not a digest-worthy single event).
