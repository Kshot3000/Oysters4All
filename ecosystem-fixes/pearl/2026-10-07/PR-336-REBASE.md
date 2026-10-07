# Upstream maintenance — pearl-research-labs/pearl PR #336 rebased onto current master

- **Date:** 2026-10-07 (Pearl builder loop, upstream keep-alive)
- **PR:** https://github.com/pearl-research-labs/pearl/pull/336 — "fix(apps): wallet https blockbook client + repair pearl-address-validation" (OPEN, MERGEABLE, review-blocked as before)
- **Branch:** `fix/apps-wallet-hardening` on Kshot3000/pearl — was 92 commits behind master (base 3fe22676, 2026-09-25 scaffold era); rebased onto master @ 2f8b770c (#359) → new head 3321ed7a, behind_by 0 / ahead_by 2, force-pushed with `--force-with-lease`.

## What the PR carries (unchanged by the rebase, verified from the diff)

1. `fix(wallet): use https for blockbook fee-estimate requests` — the desktop wallet's BlockbookClient hardcoded `http://blockbook.pearlresearch.ai` / `http://blockbook.testnet.pearlresearch.ai`; both hosts 301-redirect to https, so the first request went out in the clear. Now requests the https endpoints directly.
2. `fix(apps): repair pearl-address-validation package (tests, base58, docs)` — package/test/docs repair in `apps/packages/pearl-address-validation`.

## Verification (on the rebased tree)

- Rebase completed with zero conflicts; both commits replayed cleanly.
- `npx tsc --noEmit` in `apps/packages/pearl-address-validation`: clean.
- `npx vitest run`: 19/19 tests PASS.
- GitHub compare after push: status `ahead`, ahead_by 2, behind_by 0; PR mergeable = true, mergeable_state = blocked (awaiting review — same as before the rebase).

## Fleet state checked this run

- Kyle's open upstream PRs #370–#375: no human reviews yet; each carries automated Cursor Bugbot/Security reviews (all passing except one substantive Bugbot finding on #373 — see the follow-up below). GitHub Actions runs sit at `action_required` (fork PRs need a maintainer to approve the workflow runs) — nothing failed.
- **Follow-up on #373 (same day):** Bugbot correctly flagged that `LastBlock()` is only a lower bound on a peer's height, so the new no-candidate rotation could evict a peer that quietly holds our tip. Fixed in 8dc50056: rotation now exempts any peer whose last announced block is our current tip; `TestPickStaleOutboundPeer` extended, full netsync suite green, and a comment on the PR explains the tightening and the one residual case (a peer that received the tip from us and never announced anything back).
- wPRL issue #347: still OPEN, 0 comments — no Pearl-team reply; watch-only, no re-send.
- Issue #332 (testnet wedge at 36761 under the rank-penalty rule) triaged in hidden_files: testnet `RankPenaltyForkHeight` is exactly 36761 (`node/chaincfg/params.go`), so the fork activation itself is as-configured; the divergence is inside the zk-pow rank computation for that block's certificate, which cannot be reproduced or verified in this container (needs the real block + zkpow build). No PR opened — consensus-critical and unverifiable here beats a speculative change.

---

Built by @kshot9000 (https://x.com/kshot9000) for the Pearl ecosystem. Tips: prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d — cc @pearl-research-labs
