# Upstream fix — PR #412: PSBT updater/finalizer index panics (Pearl run ~08:13 CDT, 2026-10-08)

New audit class for this run (the stored-value Uint32/Uint64 guard
table and the rpcserver narrowing-cast sweep are both closed): public
API index parameters whose only guard is `idx > len(x)-1` — a shape
that rejects past-the-end but not negative indexes — and its sibling
shape, no guard at all.

In `node/btcutil/psbt`, `AddInNonWitnessUtxo`/`AddInWitnessUtxo`
carried exactly that half-guard (returning the documented error for
past-the-end), while `AddInSighashType`, `AddInRedeemScript`,
`AddInWitnessScript`, `AddInBip32Derivation`,
`AddOutBip32Derivation`, `AddOutRedeemScript`,
`AddOutWitnessScript`, `Updater.Sign`, `MaybeFinalize` and
`Finalize` dereferenced `Inputs[inIndex]`/`Outputs[outIndex]`
unchecked.

Own RED (valid 2-in/2-out fixture from the package's own tests,
every call wrapped in a panic-recovering harness so the full table
reports): index -1 panicked in all 12 entry points; index 2 (== len)
panicked in 10 (only the two half-guarded Utxo methods errored).
Fix: range-check at the top of each entry point, returning each
function's existing error for this failure class
(ErrInvalidPsbtFormat; AddInNonWitnessUtxo keeps
ErrInvalidPrevOutNonWitnessTransaction); addPartialSignature gets
the same check as defence in depth behind Sign. GREEN: new
updater_index_test.go pass, full psbt suite pass, new test
-race -count=2 clean, gofmt/vet clean. The wider
`go test ./node/btcutil/...` shows one failure,
TestWriteTLSCertPair in the root btcutil package (file-perm
0644 expected vs 0640 under this container's umask 0007) —
verified identical on pristine master, pre-existing and unrelated.
Branch fix/psbt-updater-index-bounds, commit c26c6ee8, patch in
fix-pearl-psbt-updater-index.patch.
PR: https://github.com/pearl-research-labs/pearl/pull/412

Checked and not shipped this run: spv/banman decodeIPNet's single
r.Read calls (its only caller is in-memory buffers in tests — the
function has no production reader, so the short-read shape is not
reachable); node/v2transport HKDF reader Reads (deterministic
in-memory readers, not streams); wire CertificateV1/V2 Deserialize
(proof/public-data lengths already capped before make/ReadFull);
chainio dbFetchVersion (unchanged from the #409/#410 record — a
signature decision already posed to maintainers in #410's body).

Also this run:
- wPRL #347: still 0 comments, no Pearl-team reply.
- PR #336: still OPEN, MERGEABLE, BLOCKED, only the 2026-09-26
  Cursor comment — nothing to answer, upstream master unchanged
  at 2f8b770, no rebase needed.
- Open-PR inventory reconciles: 41 open before this run, all with
  records; #412 added above — no stranded PRs.
- Sharing: nothing posted — one incremental fix PR is below the
  showcase/X newsworthiness gate (today 2026-10-08's X slot unused).
