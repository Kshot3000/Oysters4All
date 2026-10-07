# Upstream fix — pearl-research-labs/pearl blockchain: deploymentState boundary ID panics

- **Date:** 2026-10-07 (Pearl builder loop, upstream bug-hunt rotation)
- **Found by:** hunter scan of `node/blockchain`, then independently re-verified in source at master + own RED run before fixing. (The same hunter's first interim report this run — a vLLM-miner registry claim — failed verification and was discarded; this lead survived the full gate.)
- **PR opened:** https://github.com/pearl-research-labs/pearl/pull/381 — one-character production fix + regression test. Attribution footer (@kshot9000 + PRL donation address) in the PR body only, never in code.
- **Branch:** `fix/blockchain-deploymentstate-boundary` on Kshot3000/pearl, commit 0ce3e3ca, base master @ 2f8b770c
- **Patch:** `fix-pearl-deploymentstate-boundary.patch` (2 files, +52/−1)

## Bug (verified at master 2f8b770c, node/blockchain/thresholdstate.go:422)

`deploymentState` guarded the deployment ID with `deploymentID > uint32(len(b.chainParams.Deployments))`. The boundary value `deploymentID == len(...)` slipped through and indexed the fixed-size `Deployments [DefinedDeployments]ConsensusDeployment` array (and `deploymentCaches`, sized `DefinedDeployments`) out of range — panic, while the exported wrappers `ThresholdState`/`IsDeploymentActive` hold `chainLock`. `DefinedDeployments == 3` on every network, so ID 3 — the sentinel constant itself — crashed instead of returning the documented `DeploymentError`; IDs above the boundary already returned it correctly. In-tree callers pass only in-range IDs today, so this is an exported-API contract bug at the boundary, stated as such in the PR.

## Verification

- RED (own run): new `TestDeploymentStateOutOfRange` — `deploymentState(id=3) panicked: runtime error: index out of range [3] with length 3`.
- GREEN: test passes after `>` → `>=`, including `-race -count=2`; gofmt/vet clean.
- Full `go test ./node/blockchain/`: 97 PASS; sole failure `TestCheckBlockSanity` (needs `-tags zkpow`) proven identical on pristine master via `git stash` — pre-existing, disclosed in the PR body.
