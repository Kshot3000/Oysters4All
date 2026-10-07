# Upstream fix — pearl-research-labs/pearl #297: getdata push helpers reimplement completion signaling; merkle case can strand it

- **Date:** 2026-10-07 (Pearl builder loop, upstream bug-hunt rotation)
- **Upstream issue:** https://github.com/pearl-research-labs/pearl/issues/297 — refactor proposal by jonathanMweiss: `pushInventory`/`pushTxMsg`/`pushBlockMsg`/`pushMerkleBlockMsg` each build + queue + hand-signal completion, upholding "exactly one signal per vector" by convention across six sites in node/server.go; nothing enforces it.
- **PR opened:** https://github.com/pearl-research-labs/pearl/pull/375 — implements the proposed refactor faithfully. OPEN after creation (attribution footer: @kshot9000 + PRL donation address in the PR body only, never in code).
- **Branch:** `fix/getdata-fetch-return` on Kshot3000/pearl, commit d39a2284, base master @ 2f8b770c
- **Patch:** `fix-pearl-getdata-fetch-297.patch` (2 files, +204/−107)

## Also checked and NOT duplicated this run

- Issue #364 (addnode remove reconnects): PR #365 by another contributor already implements the fix — skipped per the check-for-existing-PRs lesson.
- Issue #131 (addnode remove "-8: peer not found"): explained by-design behavior (remove only affects addnode-added persistent peers), confirmed by a commenter — not a bug.
- Kyle's open upstream PRs #336, #370–#374: all MERGEABLE with checks passing (Cursor Bugbot / Security Reviewer green). wPRL issue #347: no Pearl-team replies (0 comments).

## The latent bug inside the refactor

`pushMerkleBlockMsg` attached the done channel to the **last matched tx** but queued that message only inside the `txIndex < uint32(len(blkTransactions))` guard. If the guard failed on the last index, nothing signaled, `nil` was returned (so no `notfound` either), and `OnGetData` parked on `<-dc` until `sp.quit` — that peer's read loop stalled for the connection's lifetime. Indices come from `bloom.NewMerkleBlock` over the block's own txs, so the path should be unreachable; the guard nonetheless converted a would-be panic into a silent stall. In the new shape the case is inexpressible: a skipped index yields one fewer returned message, and the signal rides the real last message.

## Fix

- New `outbound{msg, enc}` type; `fetchInventory`/`fetchTx`/`fetchBlock`/`fetchMerkleBlock` only build `[]outbound` and return — they never queue, never signal.
- `OnGetData` owns queueing: attaches the vector's doneChan to the last returned message only; doneChans now tracks only vectors that actually queued messages.
- Three return shapes preserved exactly, as the issue specified: `(nil, err)` → notfound, no signal; `(nil, nil)` → deliberate no-reply (filtered block, no filter loaded), no notfound; `(msgs, nil)` → queue all, exactly one signal.
- Per-message encodings unchanged (block + matched txs: caller's encoding; continue-inv + merkleblock: BaseEncoding — verified `peer.QueueMessage` = BaseEncoding before assigning). `continueHash` check/clear side effect kept in `fetchBlock`. Nothing in `node/peer` touched (issue non-goal).
- Merkle assembly factored into pure `merkleOutbound(...)` — the seam that makes the out-of-range case testable at all, since `bloom.NewMerkleBlock` cannot produce out-of-range indices from a real block.

## Verification

- New `node/server_getdata_test.go`: `TestFetchInventoryShapes` (unknown type → (nil, err); filtered block + filtered witness block with unloaded filter → (nil, nil)) and `TestMerkleOutbound` (no matches / in-order matches / last index out of range / all indices out of range, message identity + encodings) — all PASS.
- Full existing suite untouched and green: `go test ./node/ -count=1` PASS; `gofmt` clean; `go vet ./node/` clean.
- Note: the first vet run reported a phantom `undefined: wire.WitnessEncoding` while a concurrent `go build` held the shared GOCACHE; re-running after the build finished was clean. The real test-file bug was mine: chainhash lives at `node/chaincfg/chainhash`, not `node/chainhash`.
