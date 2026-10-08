# Upstream fix — PR #413: txscript sighash index check panics on negative indexes (Pearl run ~09:13 CDT, 2026-10-08)

Continuation of the half-guard audit class opened by PR #412
(`idx > len(x)-1` rejects past-the-end but not negatives): a
repo-wide `> len(` grep over node/wallet/spv left exactly two
unguarded-negative rows outside psbt — both in
`node/txscript/sighash.go`, and both are the *sighash* functions
every downstream signer calls.

`calcWitnessSignatureHashRaw` (:61) and
`calcTaprootSignatureHashRaw` (:308) sanity-check the input index
with `idx > len(tx.TxIn)-1` and then dereference `tx.TxIn[idx]`
(:99 / :360). The exported entry points `CalcWitnessSigHash`,
`CalcTaprootSignatureHash`, and `CalcTapscriptSignaturehash`
therefore panic on idx == -1 instead of returning the
`idx %d but %d txins` error the check exists to produce.

Own RED (new sighash_index_test.go, panic-recovering harness, one
1-in fixture): idx == -1 panicked in all three entry points with
`index out of range [-1]`; idx == len already errored (pinned).
Fix: `idx < 0 ||` added to both guards — two lines. GREEN: new
test pass, full txscript suite pass (7.4s), new test -race clean,
gofmt/vet clean. Branch fix/txscript-sighash-negative-index,
commit a0ab6fc4, patch in
fix-pearl-txscript-sighash-negative-index.patch.
PR: https://github.com/pearl-research-labs/pearl/pull/413

Checked and not shipped this run: rpcserver.go:1299 is
handleGetBlockHash itself (already PR #404), not a new site; the
getnetworkhashps casts (:2546/:2560) remain as flagged in #411's
body (no distinguishing fixture on a genesis-only chain);
mempool/estimatefee.go bare binary.Read sites are the master
state of what PR #402 already fixes; legacyrpc MinConf int32
casts are confirm-count semantics with documented -1-style
ranges, not the wrap class.

Also this run:
- wPRL #347: still 0 comments, no Pearl-team reply.
- PR #336: still OPEN, MERGEABLE, BLOCKED — nothing new to
  answer; upstream master unchanged at 2f8b770, no rebase needed.
- Open-PR inventory reconciles: 42 open before this run, all with
  records; #413 added above — no stranded PRs.
- Sharing: nothing posted — one incremental fix PR is below the
  showcase/X newsworthiness gate (today 2026-10-08's X slot unused).
