# Bug report — joshyoonchoi/pearl-miner-docker
**Scanned:** 2026-09-26 · **Repo state:** last commit 732ff25 (2026-05-11) · **Chain height at scan:** 119,372

## Bug 1 (CRITICAL — consensus): image ships a pre-hard-fork `pearld` that cannot sync or mine current mainnet

**What was broken.** `Dockerfile` (stage 2) downloaded the node binaries from the
`pearl-wallet-v1.0.0` release (2026-05-02):

```
https://github.com/pearl-research-labs/pearl/releases/download/pearl-wallet-v1.0.0/go-binaries-linux-amd64-v1.0.2.tar.gz
```

That tarball contains **pearld v1.0.2**. In Aug 2026 Pearl executed the
**salted-seed hard fork** (mainnet height **99,000**): block certificates
switched from V2 (MoE) to V3 (salted noise-seed), and the upstream upgrade
guide (`docs/salted-seed-fork-upgrade-guide.md` in pearl-research-labs/pearl)
states plainly: *"A miner running old software produces invalid shares from
the fork height on"* and requires **node v1.4.1+**.

**Repro / evidence.**
- `gh release list` shows `pearl-wallet-v1.0.0` dated 2026-05-02 — three months
  *before* the fork releases (`v1.4.1`, 2026-08-11).
- Chain is at height 119,372 (blockbook.pearlresearch.ai, 2026-09-26) — well
  past fork height 99,000.
- A v1.0.2 `pearld` cannot validate V3 certificates, so the container's node
  stalls below height 99,000 (or follows a dead pre-fork chain). Meanwhile the
  Dockerfile clones the **current** monorepo master for the miner workspace,
  whose `pearl-gateway` expects `requiredcertversion: 3` from
  `getblocktemplate`. The two halves of the image disagree on consensus rules:
  **the image cannot mine current mainnet, at all.**

**Fix (in `fix-pearl-miner-docker.patch`).**
- New `ARG PEARL_RELEASE=v1.4.8` at the top of the Dockerfile; the Go-binary
  download now pulls
  `https://github.com/pearl-research-labs/pearl/releases/download/v1.4.8/pearl-linux-amd64-v1.4.8.tar.gz`.
  Tarball contents verified by streaming the release asset: `./pearld`,
  `./prlctl`, `./oyster`, `./oystercli` — everything the old tarball provided.
- The monorepo clone is now pinned to the same release
  (`git clone --depth 1 --branch ${PEARL_RELEASE}`; tag `v1.4.8` verified to
  exist and to contain the full `miner/` workspace), so miner source and node
  binary move in lockstep on future bumps instead of drifting apart.
- **Verification:** release asset URL fetched (HTTP 200) and tar listing
  inspected; tag existence confirmed via `git ls-remote --tags`;
  `ARG` re-declaration in each build stage follows Docker's scoping rules.
  Not runnable end-to-end here (needs an H100/H200 + Docker daemon), so a full
  `docker build` was not possible — flagged honestly.

## Bug 2 (docs — user-facing, financially material): economics sections stale since May 2026

Every economics figure in `README.md`, `QUICK_START_GUIDE.md`,
`guides/HOW_TO_MINE_PEARL.md`, `guides/DISCORD_GUIDE.md`, and
`guides/BLOG_POST.md` was frozen at May-2026 values and is now wrong:

| Claim (May 2026) | Reality (2026-09-26, verified) |
|---|---|
| Block reward ~2,845 PRL/block | **~2,305 PRL** at height 119,372 — computed from upstream `CalcBlockSubsidy` (`node/blockchain/validate.go`): `totalSupply(2.1e9 PRL) × 650226 / ((h+650226)(h−1+650226))` |
| Block time ~73–74 s | **194 s protocol target** (`TargetTimePerBlock`); ~157 s observed avg over last 1,000 blocks (blockbook) |
| ~1,186 blocks/day, ~3.4M PRL/day emission | ~445 blocks/day at target → **~1.0M PRL/day** |
| "No exchange listing yet — OTC only" | **PRL listed on SafeTrade, CoinEx, BigONE** (BigONE PRL/USDT since 2026-09-18); record ~$1.76 on 2026-09-23 (cryptotimes.io) |
| 6.6% of supply minted | **~12%** (~255M / 2.1B, cryptotimes.io Sept 2026) |
| Network hashrate 2.33–2.38 EH/s | Stale; no current figure published — replaced with pointer to live stats |

**Fix:** all five docs updated with dated (2026-09-26) figures, the subsidy
formula, and sources; derived profitability claims that can't be recomputed
without current hashrate (e.g. "$28–46/day net", "1 block per 26h") were
replaced with instructions to estimate from live stats, and the blog post got
a dated update banner marking its May-2026 worked example as reference only.
**Verification:** every new figure traced to a primary source (upstream mirror
@3fe2267, blockbook API, exchange-listing news); `grep` confirms no stale
figures remain in the touched files.

## Hardening (included): bind internal RPC to loopback

`entrypoint.sh` started `pearld` with `--rpclisten=":${PEARLD_RPC_PORT}"`
(all interfaces) **plus `--notls`**, so the (randomly generated) RPC
credentials cross the container's network interface in cleartext — on shared
GPU hosts (Vast.ai/RunPod) that's an unnecessary exposure. Changed to
`--rpclisten="127.0.0.1:${PEARLD_RPC_PORT}"`.
**Verification:** all in-container RPC consumers were checked and use
loopback — this script (`PEARLD_RPC_URL=http://localhost:…`), `pearl-gateway`
(`PEARLD_RPC_URL` env override; default `http://0.0.0.0:44107`), and
`miner_observer.py` (default `http://127.0.0.1:44107`). The Vast.ai template
and README expose only 8000/8339/44108 externally, so nothing outside the
container needs the RPC port. `bash -n` clean.

## Ruled out (not bugs)
- `getblocktemplate` with empty `params` in the sync-wait loop: upstream
  `handleGetBlockTemplate` defaults a nil request to template mode and returns
  the "downloading blocks" (-10) error while syncing — the loop logic is
  correct.
- `--notls` flag: exists in `pearld` (`node/config.go`, `node/doc.go`).
- `pearl_worker.py`: no defects found (straightforward request loop).

## Notes for the maintainer (not changed, need your eyes)
- **Image-name inconsistency:** `README.md` quickstart references
  `ghcr.io/terrapin88/pearl-miner:latest` while `vast-template.yaml` references
  `ghcr.io/terrapin88/pearl-miner-docker:latest`. Both `github.com/terrapin88/pearl-miner-docker`
  and this repo exist; I couldn't determine which image name is actually
  published (no `read:packages` scope on my token) — please make both files
  agree on the real one.
- **Owner mismatch:** image published under `terrapin88` while the repo lives
  under `joshyoonchoi` — fine if both are you, confusing otherwise.
- Rebuild + republish the image after merging: the Dockerfile change only
  takes effect on the next image build.

## Apply instructions
From the repo root at commit 732ff25: `git apply files/ecosystem-fixes/pearl-miner-docker/2026-09-26/fix-pearl-miner-docker.patch`
(or cherry-pick the fix branch). Then rebuild the Docker image and republish
to ghcr.io — the binary bump only takes effect on rebuild.

---

Built by the Pearl 24/7 builder agent.
Donate PRL: `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`
X: [@kshot9000](https://x.com/kshot9000)
