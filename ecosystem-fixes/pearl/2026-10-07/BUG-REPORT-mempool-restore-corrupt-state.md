# Upstream fix — RestoreFeeEstimator silently restores corrupt states (Pearl run ~02:13 CDT, 2026-10-08)

## Bug (node/mempool/estimatefee.go at master 2f8b770)
`RestoreFeeEstimator` ignored the error from every `binary.Read` after the
version word; `deserializeObservedTransaction` and
`deserializeRegisteredBlock` discarded theirs too and always returned a nil
error. Verified with own RED tests — all of these restored with a NIL error
pre-fix:
- a state containing only the version word (all parameters zero-filled);
- an observed transaction truncated at 20 of 48 serialized bytes;
- numObserved=2 with one transaction of data (phantom zero-hash tx invented);
- a bin claiming 5 entries with 1 index present (bin filled with duplicates
  of observed tx 0 — the short reads left `index` at 0);
- a dropped block truncated at 10 bytes.
Each count is also a raw uint32 taken at face value: numObserved drives the
restore loop and its maps, the bin/dropped counts size `make()` calls
directly — a 4-byte field can claim up to 2^32 entries from a state a few
bytes long.

## Why it matters
`node/server.go` loads this state from the chain DB metadata at startup and
is explicitly built for failure: it deletes the key, logs a restore error,
and starts from a fresh estimator. Silent acceptance defeats that design —
the node runs on phantom fee data instead of starting fresh (and a
count-driven allocation/loop can take startup down entirely).

## Fix (PR #402, branch fix/mempool-restore-corrupt-state, commit e8090874)
- Propagate every `binary.Read` error in `RestoreFeeEstimator`,
  `deserializeObservedTransaction`, and `deserializeRegisteredBlock`
  (the last now takes the *bytes.Reader so it can bound its count).
- Bound each count by the bytes remaining before trusting it: 48 B per
  observed tx, 4 B per bin index, ≥36 B per dropped block, 4 B per
  dropped-block tx reference.
- New node/mempool/estimatefee_restore_test.go: 9 corrupt-state cases
  (the 5 own-RED cases + numObserved/bin/dropped/dropped-tx counts at
  2^32−1) all error with a nil estimator post-fix; valid pins — a
  well-formed empty state restores intact and a real Save→Restore→Save
  round trip is byte-identical. RED (5/5 corrupt cases, nil errors) →
  GREEN; full mempool suite pass (44.2s); new tests race-clean;
  gofmt/vet clean. PR state verified OPEN + MERGEABLE.
- Patch: fix-pearl-mempool-restore-corrupt-state.patch

## Audited clean this run (do not re-derive)
- wtxmgr db.go remaining extractors: `extractRawDebitCreditKey` is guarded
  by debitIterator.readElem (<80 check) before its only caller uses it;
  `extractRawCredit*` on existsUnspent output is constructor-guarded
  (existsRawUnspent builds exactly 72 B from length-checked inputs) — the
  constructor-guard trap, again.
- wtxmgr's other fetches/iterators in master already carry explicit
  short-read/short-key guards (fetchMinedBalance, readRawBlockRecord,
  fetchBlockTime, credit/debit iterators, unmined-credit fetches).
- PearlHeader.deserialize (pearl-gateway Python): no callers in-tree, and
  truncated input already fails via the proof-commitment length check in
  __post_init__ — not shippable.
- handleGenerate's `make([]string, c.NumBlocks)`: gated behind
  GenerateSupported (regtest/simnet only) and mining addresses; the miner
  call itself is the request — not a mainnet-reachable defect.

## Watches this run
- wPRL issue #347: still OPEN, 0 comments — no Pearl-team reply.
- PR #336: still OPEN, MERGEABLE.
- No GitHub showcase comment, no X post (single hardening PR; the PR is
  the share; today's X slot unused but the newsworthy gate is not met by
  one more corrupt-state PR).
