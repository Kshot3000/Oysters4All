# Upstream fix — pearl-research-labs/pearl #301: node wedges indefinitely when no connected peer is a sync candidate

- **Date:** 2026-10-07 (Pearl builder loop, upstream bug-hunt run — the run queued in BUG-REPORT-302.md's triage notes)
- **Upstream issue:** https://github.com/pearl-research-labs/pearl/issues/301 — a fully-synced mainnet node sat 34h / 622 blocks behind with all 8 outbound slots held by peers behind it (five parked at 98999, one below SaltedSeedForkHeight); restart fixed it instantly. Issue proposes: (1) drop/relax the IsCurrent gate, (2) disconnect below-height outbound peers after N candidate-less samples, (3) re-query DNS seeds, (4) de-prioritise far-behind addresses.
- **PR opened:** https://github.com/pearl-research-labs/pearl/pull/373 — implements proposed items 1 + 2. Verified OPEN + MERGEABLE after creation.
- **Branch:** `fix/netsync-no-candidate-rotation` on Kshot3000/pearl, commit d2678ba0, base master @ 2f8b770c
- **Patch:** `fix-pearl-netsync-301.patch` (2 files, +144/−3)

## Bug (verified at master 2f8b770c, node/netsync/manager.go handleStallSample)

1. The `syncPeer == nil` branch only called `startSync()` when `!chain.IsCurrent()`; `isCurrent` needs a tip timestamp <24h old, so a node that loses its sync peer at tip never re-selects for ~24h.
2. Even then, `startSync`/`pickSyncCandidate` only consider connected peers and skip any at/below our height — with an all-behind peer set there is no candidate, forever. `shouldDCStalledSyncPeer` only acts when a sync peer exists. Nothing disconnects a below-height outbound peer or frees a slot for connmgr (TargetOutbound=8) to refill.

## Fix

- `handleStallSample`: selection retried on every stall sample whenever `syncPeer == nil`, regardless of `IsCurrent` (startSync already skips candidates with nothing new, so the at-tip retry is cheap).
- New counter `noSyncPeerSamples` (blockHandler thread only, reset whenever a sync peer exists). After `noSyncPeerRotateSamples = 10` consecutive candidate-less samples (5 min at the 30s stall interval), `handleNoSyncPeer` disconnects one outbound peer per sample via `pickStaleOutboundPeer`: strictly below our height, lowest first. Peers at our height are never rotated (may be waiting for the same next block — the distinction the reporter's own workaround makes); inbound peers never (frees no outbound slot).

## Verification

- Tests written first: on master they do not build (the rotated-selection behavior does not exist); with the fix, `TestPickStaleOutboundPeer` (selection: outbound-only, strictly-below, lowest-first; at-height and inbound excluded) and `TestHandleStallSampleNoSyncPeer` (per-sample retry, streak counting past the threshold, at-height peer never disconnected, streak reset) PASS.
- `go test ./node/netsync/ -count=1` PASS (full suite), `go build ./node/...` PASS, `go vet ./node/netsync/` PASS, `gofmt` clean.
- Honest limitation (also stated in the PR): the in-process test chain is genesis-only (height 0), so no test peer can be strictly below the tip in-process — the `Disconnect()` call is exercised by construction, while selection + accounting are fully pinned by tests.

## Watches this run

- wPRL #347: still OPEN, 0 comments — no Pearl-team reply; not re-sent.
- Kyle's PR #336: still OPEN / MERGEABLE / BLOCKED, CI green (Cursor Bugbot SUCCESS) — no reviewer action to answer, no rebase needed (mergeable).
- Kyle's upstream PRs now open: #336, #370 (#302), #371 (oystercli fee-rate), #372 (desktop vout), #373 (#301).
- Showcase digest: already posted twice today by earlier runs (03:27Z, 05:39Z) — at/over the 1-per-day gate, so no digest and no X post this run.
- Environment: /tmp (512M tmpfs) is 100% full (stale go-build caches from concurrent loops) — git SSH signing and file writes to /tmp fail with ENOSPC. Workaround used all run: `TMPDIR=~/.cache/chrome-tmp` + `GOCACHE=~/.cache/go-build` (same class as the 2026-09-30 AGENTS.md lesson).
