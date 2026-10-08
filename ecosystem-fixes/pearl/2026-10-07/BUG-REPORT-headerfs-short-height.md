# Upstream fix — PR #406: spv/headerfs short stored-height panic (Pearl run ~04:13 CDT, 2026-10-08)

`getHeaderEntry` and `getHeaderEntryFallback` in spv/headerfs/index.go
nil-checked the stored height value but passed it straight to
`binary.BigEndian.Uint32`, which panics on <4 bytes. Both
`HeightFromHash` and `ChainTip` funnel through these readers, and
`chainTipWithTx` already maps a reader error to `ErrHeightNotFound` —
the error contract existed, the panic bypassed it. Odd-one-out tell:
the delete path in the same file already requires `len(...) == 4`
before treating a value as a height entry.

Own RED: new TestHeightFromHashShortStoredValue seeds a real bdb
index with a 3-byte sub-bucket value and a 1-byte root-bucket value —
panicked at index.go:414. Fix: `len != 4` → ErrHashNotFound in both
readers. GREEN, full headerfs suite pass, -race clean, vet clean.
Branch fix/headerfs-short-height-value, commit 9b2174ef, patch in
fix-pearl-headerfs-short-height.patch.

Also this run:
- wPRL #347: still 0 comments, no Pearl-team reply.
- PR #336: verified 0 behind / 2 ahead via explicit-SHA compare — no
  rebase needed (the bulk compare drift claim pattern from the
  2026-10-08 lesson did not apply).
- PRs #398–#405: Bugbot posted summaries only, no substantive
  inline findings to act on.
- Own audit of RPC slice-element params: gettxspendingprevout was
  the only []* handler param; createrawtransaction inputs are a
  value slice (null element → empty txid → clean decode error).
