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

## Follow-up — Bugbot security review addressed (2026-10-07 ~05:13 CDT run)

- **Trigger:** Cursor Bugbot's reviews on PR #373 — the 06:20Z "stale heights" finding (partially fixed same-day by 8dc50056, the announced-tip exemption) plus two Agentic Security Reviews (06:23Z MEDIUM, 08:33Z HIGH ×2) posted against the current head. Each claim was re-verified against the code before acting; all three substantive points checked out.
- **Fix pushed:** commit `7b34b152` on `fix/netsync-no-candidate-rotation` (PR head now 7b34b152); explanation comment: https://github.com/pearl-research-labs/pearl/pull/373#issuecomment-6035922996
  1. **Rotation gated on stranded state:** `handleNoSyncPeer(isCurrent bool)` returns immediately (streak reset) while `chain.IsCurrent()` — at a fresh tip, no-sync-peer is the normal steady state and advertised heights lag by construction, so rotation there only churned healthy connections. The #301 incident state (stale tip, 34h) still rotates.
  2. **At-tip promotion guard:** `startSync` refuses a candidate whose only claim is its version-message `LastBlock` while the chain is current (promotion flipped `current()` false → `handleInvMsg` dropped other peers' announcements until the stall timer). Announced-unknown-block candidates still promote at tip; height claims still promote while not current.
  3. **"No candidate" no longer decided by one random pick:** rotation stands down while any connected peer announced a block we don't have (`anyPeerAnnouncedUnknownBlock`) — `pickSyncCandidate` returns one random candidate per sample, so a skipped pick never proved no candidate existed.
- **Deliberately not changed (stated on the PR):** persistent/addnode-peer exemption — `peer.Peer` carries no persistent flag (tracked server-side in `persistentPeers`), so it needs `peer.Config` plumbing; bounded harm (connmgr redials) and now gated on `!IsCurrent()`. Victim ranking stays lowest-first *inside the stranded state only* (selection vs eviction distinction explained on the PR).
- **Verification:** new tests `TestHandleNoSyncPeerAtTip`, `TestAnyPeerAnnouncedUnknownBlock`, `TestStartSyncPromotesHeightClaimWhenNotCurrent` PASS; full `go test ./node/netsync/ -count=1` PASS; race clean on the rotation/promotion tests; `go vet` + `gofmt` clean. Honest limitation (also on the PR): genesis-only test chain is never current, so at-tip branches are posed via the explicit `isCurrent` parameter (same pattern as `pickStaleOutboundPeer`'s explicit tip height).
- **Watches this run:** wPRL #347 still 0 comments. PRs #336, #370–#376: no human reviews; only Cursor summaries (all benign) besides the #373 findings above. Upstream master unchanged at 2f8b770c — #336 needs no rebase. In-dev PRs #369/#366/#311 open unchanged; #310 (metrics) updated 03:27Z. Oysters4All + Hermes trees clean. Patch snapshot `fix-pearl-netsync-301.patch` regenerated for the full branch diff (358 lines).

## Follow-up 2 — Bugbot re-review of 7b34b152 addressed (2026-10-07 ~06:13 CDT run)

- **Trigger:** Cursor Bugbot re-reviewed the NEW head 7b34b152 (10:31Z "Unknown invs freeze peer rotation" MEDIUM + 10:32Z Agentic Security Reviews HIGH ×2). Per the standing lesson, bot reviews are re-checked after every follow-up push. Each claim was re-verified against the code before acting; all three checked out, tracing to two roots.
- **Fix pushed:** commit `40928d81` on `fix/netsync-no-candidate-rotation` (PR head now 40928d81); explanation comment: https://github.com/pearl-research-labs/pearl/pull/373#issuecomment-6036856414
  1. **Stand-down gated on eligible announcers:** `anyPeerAnnouncedUnknownBlock` counted EVERY connected peer, but `LastAnnouncedBlock` is written from an unauthenticated inv before any quality gate and only cleared when a matching block is accepted — one fake inv from an inbound/low-quality peer (never promotable while outbound candidates exist) froze rotation indefinitely. Now only outbound, high-quality sync candidates not in post-stall cooldown count; a promoted announcer that stalls lands in cooldown and its stale announcement stops standing rotation down, so the stand-down is bounded, not permanent.
  2. **At-tip promotion can no longer flip `current()`:** the announced-block exception let a fake inv hash + inflated version height promote while current, flipping `current()` false and silencing other peers' invs until the stall timer. Factored into `atTipSyncPromotionBlocked(isCurrent, announced, peerHeight, bestHeight)`: at tip, an announced-unknown candidate promotes only when its advertised height does not exceed ours (the honest next-block announcer's shape by construction — its `LastBlock` only advances on blocks we accepted). A skipped candidate's block is still fetched directly by `handleInvMsg` while there is no sync peer.
- **Verification:** RED→GREEN — new `TestAnyPeerAnnouncedUnknownBlockEligibility` FAILS on the pre-fix tree (all four exclusion cases) and passes with the fix; `TestAtTipSyncPromotionBlocked` pins the promotion matrix through the factored helper (in-process chain is never current — same honest seam as before, stated on the PR). Full `go test ./node/netsync/ -count=1` PASS; targeted tests PASS under `-race`; `gofmt` + `go vet` clean.
- **Watches this run:** wPRL #347 still OPEN, 0 comments — no Pearl-team reply, not re-sent. Kyle's PRs #336, #370–#376 all OPEN + MERGEABLE, no human reviews; Bugbot comments on the others are summaries only (checked #336, #370–#372, #375, #376 this run). Showcase digest already used today (05:39Z) — no digest, no X post. Issue #364 already has PR #365 (Alonmw) — no duplicate. A Bugbot re-review of the new head 40928d81 is expected (~10 min cadence observed) and is the next run's first check.
