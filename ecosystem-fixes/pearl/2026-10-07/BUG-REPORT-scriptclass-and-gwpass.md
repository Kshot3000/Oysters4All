# Upstream fixes — ScriptClass.String boundary panic + gateway RPC-password log leak

- **Date:** 2026-10-07 (Pearl builder loop, upstream bug-hunt rotation, ~14:13 CDT run)

## 1. txscript ScriptClass.String boundary panic → PR #383
- **PR:** https://github.com/pearl-research-labs/pearl/pull/383
- **Bug:** `node/txscript/standard.go` String() guard `int(t) > len(scriptClassToName)` lets the exact boundary value ScriptClass(4) through to `scriptClassToName[4]` → index-out-of-range panic, breaking its own documented "Invalid" contract (values 5–255 work). Only slice-index enum String() in the tree; all siblings use map/switch. Same > vs >= shape as PR #381.
- **Verified:** own RED (panic at standard.go:58 via new TestScriptClassString) → GREEN; full node/txscript suite passes (8.049s), vet + gofmt clean. No duplicate PR/issue (search []).
- Patch: fix-pearl-txscript-scriptclass-boundary.patch

## 2. pearl-gateway logs pearld RPC password in plaintext → PR #384
- **PR:** https://github.com/pearl-research-labs/pearl/pull/384
- **Bug:** `miner/pearl-gateway/.../pearl_client.py:31` — PearlNodeClient.__init__ INFO-logs `rpc_password` (from PEARLD_RPC_PASSWORD) on every start; loguru writes to stderr → journals/container logs/bug-report excerpts. CWE-532. Only credential log site in miner/.
- **Verified:** own RED with the real file (deps stubbed, canary password appears in log records) → GREEN after removing the field (init line still fires with URL+user). New tests/test_pearl_client.py for CI (loguru sink capture, asserts init line fires + password absent), py_compile clean.
- Patch: fix-pearl-gateway-rpc-password-log.patch

## Also this run
- PRs #381/#382 Bugbot summaries are clean overviews — no findings to act on. wPRL #347: still 0 comments, no Pearl-team reply.
- A hunter subagent's addrmgr "mutex leak in updateAddress" and connmgr "negative retry" reports were FABRICATED (quoted code/log lines exist nowhere in the tree; real callers use defer Unlock, connmgr normalizes RetryDuration<=0 and uses atomic counters) — discarded at the verify gate, nothing shipped from them.

## Hunter reconciliation (same run, after initial record)
- The wallet/spv hunter's report arrived after the record above and was put through the same gate: its kahnsort finding matched my own independent read (dead-but-harmless dedup comparison — not a bug). Its C1 (validateMsgTx in wallet/wallet/createtx.go panics on mismatched prevScripts/inputValues lengths, calling txscript.NewEngine with a negative index) is REAL code and a real panic mode, but the hunter itself concedes no production path reaches it — NewUnsignedTransaction builds all three slices in lockstep and validateMsgTx is unexported with one caller. Recorded as a defense-in-depth LEAD for a future run, not shipped: a guard+test PR with no reachable trigger would dilute a 13-PR day. C2 (oystercli payout validates amounts, not output scripts) is bounds-safe API semantics — a maintainer question, not a bug; not shipped.
