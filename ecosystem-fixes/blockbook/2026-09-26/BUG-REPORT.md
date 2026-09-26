# Bug report — pearl-research-labs/blockbook (`feat/pearl-coin-support`)

**Repo:** https://github.com/pearl-research-labs/blockbook · **Branch:** `feat/pearl-coin-support`
**Scanned:** 2026-09-26 (branch @ 81f52f21, 2026-08-11) · **Upstream PR:** https://github.com/pearl-research-labs/blockbook/pull/7
**Fix branch (fork Kshot3000/blockbook):** `fix/pearl-backend-config` (commit e80b36e1)
**Patch:** `fix-blockbook-pearl.patch` (in this directory; `git apply` on the branch tip)

## Bug 1 — HIGH: placeholder backend package for pearld (broken deploys)

**What was broken:** `configs/coins/pearl.json`, `pearl_testnet.json`, `pearl_testnet2.json`
shipped a template backend package:

- `version: "0.24.2"` — not a real pearld version
- `binary_url: "https://example.com/pearld.tar.gz"`
- a fabricated `verification_source` sha256

Anyone deploying a Pearl blockbook via the standard backend installer gets a 404/hash
mismatch — Pearl backend install was effectively broken.

**Repro:** open any of the three configs; `binary_url` points at `example.com`.
Compare with `configs/coins/bitcoin.json` which carries a real URL + sha256.

**Fix:** pointed all three at the real upstream release asset (v1.4.8, latest,
2026-09-16, post-salted-seed-fork):

- `binary_url: https://github.com/pearl-research-labs/pearl/releases/download/v1.4.8/pearl-linux-amd64-v1.4.8.tar.gz`
- `verification_source: 17af51da763fe4bfcb59498d922c1b73bcacc3b08fd3e8a8ef736b650e8d1be7`

**Verification (all real, 2026-09-26):**
- `gh release view v1.4.8` lists the asset; `checksums.txt` from the release gives
  the same sha256; a locally downloaded copy matches (`sha256sum`).
- Tarball layout (`./pearld` at archive root) matches the unchanged
  `extract_command` (`tar -C backend --strip 1 -xf`) and `exec_command_template`
  (`.../pearl/pearld`).
- RPC ports unchanged and verified against upstream `node/params.go`:
  mainnet 44107, testnet 44109, testnet2 44111.
- `python -m json.tool` parses all three files; no `example.com` backend URLs remain.

**Note for maintainer:** `package_maintainer`/`package_maintainer_email` still read
`User`/`user@example.com` — left for the team to fill in real contact details.

## Bug 2 — LOW: getinfo fallback decoded into the wrong result type

**What:** `GetChainInfo()` in `bchain/coins/pearl/pearlrpc.go` falls back to `getinfo`
(a **chain-server** command whose contract is `btcjson.InfoChainResult`) when
`getnetworkinfo` is unimplemented, but decoded the response into the **wallet-server**
`btcjson.InfoWalletResult`. The fields read (`version`, `protocolversion`,
`timeoffset`, `errors`) share identical JSON tags/Go types in both structs, so this
was latent — not a runtime bug — but the code decoded against the wrong contract.

**Fix:** decode into `btcjson.InfoChainResult` (verified present with identical
fields in the pinned pearl dep `v1.4.1-0.20260811101928-fadd42af05ad`).

## Bug 3 — LOW: wrong chain-name comment

**What:** `Initialize()` comment said "Pearl node uses 'main' / 'test' style chain
names". Upstream `chaincfg.Params.Name` values are `mainnet`/`testnet`/`testnet2`/
`regtest`/`signet`/`simnet` (verified in `node/chaincfg/params.go` @ master 3fe2267).
The `Contains()`-based matching in `NewPearlParser` handles both forms, so this was
comment-only.

**Fix:** corrected the comment.

## Dependency note (not a bug, FYI)

`go.mod` pins `github.com/pearl-research-labs/pearl` to `v1.4.1-0.20260811101928-fadd42af05ad`
(2026-08-11) — ~46 days behind upstream master (3fe2267, 2026-09-24), missing the
btcd-hardening (#324), checkpoint (#288), and DNS-seed-migration (#309) commits.
I diffed the `node/` API surface blockbook uses (txscript, wire, btcutil, btcjson,
blockchain, chaincfg) between the pin and master: no signature changes in any
function/type blockbook calls, so the pin is **not broken** — just stale. Bumping it
is a maintainer call (needs a full `go mod tidy` + CI); flagging here rather than
changing it blindly.

## Verification summary

- `go build ./bchain/coins/pearl/` — PASS (Go 1.26.5; installed libzmq3-dev for the
  pebbe/zmq4 CGO dep)
- `go test -tags unittest -count=1 ./bchain/coins/pearl/` — PASS (`ok`)
- `gofmt -l` — clean
- Not runnable end-to-end here (no live pearld node / no blockbook deploy env) —
  noted honestly.

---

Pearl donation address: `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`
Built by [@kshot9000](https://x.com/kshot9000) — Pearl 24/7 builder
