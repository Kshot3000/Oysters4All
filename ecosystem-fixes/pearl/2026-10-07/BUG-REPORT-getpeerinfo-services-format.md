# Upstream fix — getpeerinfo services format mismatch panics the wallet's pruned block dispatcher (Pearl run ~00:13 CDT, 2026-10-08)

Found by the fixed-width-decode guard-table sweep (the method behind
#394/#396): one unguarded `binary.BigEndian.Uint64` remained outside the
wallet DB packages, at `wallet/chain/pruned_block_dispatcher.go:423`.
Reading both sides of the RPC boundary showed it was not just unguarded —
the two sides disagree on the format itself.

## Bug
- Server: `node/rpcserver.go` `handleGetPeerInfo` emits services as a
  **decimal** string: `fmt.Sprintf("%08d", uint64(statsSnap.Services))`.
  A segwit full node (SFNodeNetwork|SFNodeWitness = 9) → `"00000009"`.
- Wallet: `filterPeers` does `hex.DecodeString(peer.Services)` then
  `binary.BigEndian.Uint64(rawServices)`. Decimal digits are valid hex,
  so `"00000009"` decodes to 4 bytes and `Uint64` **panics**. Larger
  flag sets produce odd-length strings and an error instead. No services
  value works end to end: `PrunedBlockDispatcher.connectToPeers` can
  never get a peer list from a real pearld, and the common case crashes
  the wallet from its peer-manager goroutine.
- The existing dispatcher tests mask it: the harness encodes services as
  `hex.EncodeToString` of an 8-byte big-endian array — the wallet's
  assumption, not the server's output.

## Fix (PR #398, branch fix/getpeerinfo-services-format)
- `node/rpcserver.go`: `%08d` → `%016x` — matches `LocalServices`
  (`%016x`) in the same file, the wallet consumer, the test harness,
  and Bitcoin Core's getpeerinfo shape.
- `wallet/chain/pruned_block_dispatcher.go`: defence in depth — a
  decoded services value that is not exactly 8 bytes now returns a
  descriptive error instead of panicking (the value originates in a
  remote peer's version message relayed by the backend's RPC).
- New `TestFilterPeersServicesFormats`: 6 cases pinning the contract.

## Verification
- Own RED at master 2f8b770: the new test feeding today's real pearld
  output (`"00000009"`) panics in `binary.BigEndian.Uint64` at
  pruned_block_dispatcher.go:423.
- GREEN after the fix; full `wallet/chain` suite pass (9.9s); new test +
  dispatcher tests `-race` clean on re-run (one combined -race run hit
  the known dispatcher-harness flake class from #296/#374; both halves
  and the combined set pass on re-run); `go vet` clean on node +
  wallet/chain; gofmt clean.
- PR: https://github.com/pearl-research-labs/pearl/pull/398

## Also checked this run (no action)
- wPRL thread pearl#347: still 0 comments — no Pearl-team reply.
- PR #336: verified 0 behind / 2 ahead of master (2f8b770) via the
  compare API with explicit SHAs and local git — NOT drifted. (A
  `master...Kshot3000:branch` compare misleadingly reported behind_by
  63; trust explicit-SHA compares.)
- Bugbot comments on PRs #390–#397: summaries only, no new findings;
  no new inline review comments on #373/#376/#378/#385/#388/#397.
- In-development watch: #369 (FP16), #311 (FP8 cert-v4), #310 (metrics),
  #366 (BlockStamp) all still open; #366's only comment remains the
  Oct 4 Bugbot summary — nothing requiring a response.
