# Upstream fix — PR #410: chainio + txindex stored index values decoded unchecked (Pearl run ~06:13 CDT, 2026-10-08)

The follow-up the PR #409 record queued: the repo-wide guard table's
last mechanical rows, in the two main-chain index readers that
nil-check stored values but Uint32-decode them unchecked.

1. `dbFetchHeightByHash` (node/blockchain/chainio.go:894) — a 1–3 byte
   corrupt hash-index value panicked behind `BlockExists`
   (process.go:76), which every block-processing path consults.
   Own RED with the final test: panic `index out of range [3] with
   length 2` at chainio.go:894 → GREEN.
2. `dbFetchBlockIDByHash` (node/blockchain/indexers/txindex.go:142) —
   same shape on the ID-by-hash index; the address index calls it for
   every block it connects (addrindex.go ConnectBlock), so one corrupt
   entry would crash block connection repeatedly. Own RED: panic
   `index out of range [3] with length 3` at txindex.go:142 → GREEN.

Fix shape (deliberate): `len != 4` returns the package's existing
`errDeserialize`, NOT the missing-entry error. `BlockExists` treats
`errNotInMainChain` as "block is not in the main chain", so folding
corruption into it would silently misreport a main-chain block as
absent; same reasoning vs `errNoBlockIDEntry`. Both tests pin the
surviving contracts (valid entry decodes; missing entry keeps its
original error). Full indexers suite pass; full blockchain suite pass
except `TestCheckBlockSanity`, which fails identically on pristine
master here (`build with -tags zkpow` — environmental, verified
against the detached master worktree). New tests `-race -count=2`
clean both packages; gofmt/vet clean. Branch
fix/chainio-txindex-short-index-values, commit 2d41cd20, patch in
fix-pearl-chainio-txindex-short-values.patch (197 lines, three-dot,
generated post-commit per the empty-patch lesson).
PR: https://github.com/pearl-research-labs/pearl/pull/410

Left for maintainer direction, stated in the PR body: `dbFetchVersion`
(chainio) is the same nil-only decode but returns only `uint32` — no
error channel without a signature change (sole caller
`dbFetchOrCreateVersion` does return an error). Not bundled, per the
split-the-pair rule. `deserializeBlockLoc` stays untouched (documented
checksum design).

Test-authoring traps hit and fixed on the way (also in the day's
lessons): both packages' `byteOrder` is LittleEndian — build fixtures
with the package's own `byteOrder.PutUint32`, never hand-ordered bytes;
and `require.*` (FailNow → Goexit) inside a `db.View`/`Update` closure
skips ffldb's lock release and deadlocks the cleanup `Close` — assert
after the transaction returns.

Also this run:
- wPRL #347: still 0 comments, no Pearl-team reply (verified via API
  this run, comments=0).
- PR #336: still OPEN, MERGEABLE, BLOCKED — nothing to answer, no
  rebase needed (upstream master unchanged at 2f8b770).
- Open-PR inventory reconciles: PR #410 is the only new PR; records
  exist for #370–#410.
- Sharing: nothing posted — one incremental fix PR is below the
  showcase/X newsworthiness gate; today's X slot stays unused.
- Hermes: not touched this run (upstream fix was the higher-value
  unit); its tree was not checked this run.
