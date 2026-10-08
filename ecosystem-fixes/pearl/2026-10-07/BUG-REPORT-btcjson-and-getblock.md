# Upstream fixes — btcjson unchecked assertions (PR #400) + getblock null verbosity (PR #401)

Recorded 2026-10-08 ~02:13 CDT by the Pearl builder loop. Both PRs were
shipped by the ~01:13 CDT run's hunter continuation (created 06:26Z /
06:29Z) after that run's report was written; their patches were missing
from this folder, so this run re-verified the PR state (both OPEN +
MERGEABLE, only Cursor summary comments, no findings) and backfilled the
patch files from the worktrees (three-dot diffs against origin/master —
144 and 170 lines, non-empty).

## PR #400 — fix(btcjson): malformed scriptPubKey / scanning values panic the unmarshalers
Branch fix/btcjson-unchecked-assertions, commit 108c7d05.
- `ScriptPubKey.UnmarshalJSON` (node/btcjson/walletsvrcmds.go) asserted
  `v["address"].(string)` unchecked — a missing/non-string address panics
  during `parseCmd`, reachable by any authenticated RPC client via
  `importmulti` before handler dispatch; no recover() on the HTTP path.
- `ScanningOrFalse.UnmarshalJSON` (walletsvrresults.go) asserted
  `duration`/`progress` as float64 unchecked — crashes RPC clients (e.g.
  rpcclient getwalletinfo) parsing a malformed server response.
- Fix: comma-ok assertions with an error return — the pattern the
  neighboring `DescriptorRange.UnmarshalJSON` already uses. New
  unmarshal_assert_test.go: malformed payloads panicked at
  walletsvrcmds.go:875 / walletsvrresults.go:186 pre-fix, error post-fix;
  valid pins parse identically; full btcjson suite pass.
- Patch: fix-pearl-btcjson-unchecked-assertions.patch

## PR #401 — fix(rpcserver): getblock with explicit null verbosity panics
Branch fix/getblock-null-verbosity, commit f0002fa8.
- `GetBlockCmd.Verbosity` is `*int` with jsonrpcdefault "1", but btcjson
  fills defaults only for parameters beyond the supplied count — an
  explicit JSON `null` unmarshals to a nil pointer. handleGetBlock
  guarded the verbosity==0 branch but dereferenced `*c.Verbosity`
  unguarded in the verbosity==1 branch (rpcserver.go ~1125): any
  authenticated RPC client sending `getblock <hash> null` panics the
  handler once the block loads. The only unconditional dereference of an
  optional command pointer in rpcserver.go.
- Fix: resolve verbosity once at handler entry (nil → documented
  default 1) via a handler-local helper; populateDefaults deliberately
  untouched (other commands distinguish nil intentionally).
- New rpcserver_getblock_test.go: wire pin (null → nil pointer, omitted
  → default filled), resolution table, and an end-to-end handler test
  over a temp ffldb genesis chain — panicked at rpcserver.go:1125
  pre-fix, returns the verbosity-1 result post-fix.
- Patch: fix-pearl-getblock-null-verbosity.patch
