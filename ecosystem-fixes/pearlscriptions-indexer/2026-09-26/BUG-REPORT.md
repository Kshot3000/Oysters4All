# Bug report: stale Pearl node pin in operator guide

**Repo:** Pearlscriptions/indexer (https://github.com/Pearlscriptions/indexer)
**File:** `docs/operators.md` ("Requirements" section)
**Found:** 2026-09-26 by the Pearl 24/7 builder loop (bug-hunt mode)
**Severity:** low-medium (docs; misleads node operators, no consensus impact)
**Fix branch:** https://github.com/Kshot3000/indexer/tree/fix/stale-node-pin-operators-doc
**Pull request:** https://github.com/Pearlscriptions/indexer/pull/1
**Patch:** `fix-stale-node-pin-operators-doc.patch` (in this directory)

## What was broken

The operator guide pinned the "operator-tested Pearl node path" to the
`node/presync3` presync branch at commit `d5e5de77c3d48951ddb0d0c25a861d7627b9cab4`
(dated 2026-05-23). That pin is ~4 months old: it is 74 commits behind upstream
`main` (compare `d5e5de77...master` → `status: diverged, ahead_by: 74`) and has
been superseded by official releases — upstream pearl-research-labs/pearl is at
**v1.4.8** (published 2026-09-16, tag commit
`5b09d844e4069440933722c51495ac24a7bb4886`).

An operator following the guide would build and run a stale presync build
instead of a supported release. Notably, the guide's own text already said
"If upstream Pearl publishes a newer operator release, prefer that release and
record the exact commit you run" — the fix applies that guidance.

## Repro steps

1. Read `docs/operators.md`, "Requirements": `node/presync3` at `d5e5de77`.
2. `gh api repos/pearl-research-labs/pearl/compare/d5e5de77c3d48951ddb0d0c25a861d7627b9cab4...master`
   → `{"status":"diverged","ahead_by":74,"behind_by":24}`.
3. `gh api repos/pearl-research-labs/pearl/releases` → latest tag `v1.4.8`,
   published `2026-09-16T18:26:15Z`.

## The fix

Replaced the stale presync-branch pin with the official upstream release
`v1.4.8` (commit `5b09d844e4069440933722c51495ac24a7bb4886`, published
2026-09-16), noting it includes the MoE hard fork. The indexer requires
`pearld >= v1.1.0` on mainnet for the MoE canonical-checkpoint advisory
(`apps/indexer-api/src/config.js`, `persistent-indexer.js`), and v1.4.8
satisfies that. Docs-only change; no code touched.

## Verification

- `npm install && npm test` on the checkout: **124/124 pass** (unchanged before
  and after the edit).
- All external links in `docs/` + READMEs fetched live (curl): all HTTP 200,
  including https://www.pearlscriptions.com/indexers.
- Spot-scan (no bugs found, so no fix needed):
  - RPC methods the indexer calls (`getblockcount`, `getnetworkinfo`,
    `getblockhash`, `getblock` verbosity 2) all still exist in upstream
    `node/docs/json_rpc_api.md` — no RPC drift.
  - Full public API contract (`docs/api-contract.md`, incl. MoE advisory
    fields) is implemented by `read-api.js` + `routeSnapshot` in `indexer.js`
    — no endpoint drift.
  - Salted-seed fork height (mainnet 99000) and MoE fork height (71935) match
    upstream `node/chaincfg/params.go`.
  - `storage.js` uses parameterized queries (`$1` params); the one dynamic
    table name in `DELETE FROM ${table}` comes from internal hard-coded
    constants, not user input — no SQL injection.

## How to apply

If the upstream PR is not merged, apply the patch in this directory to a
checkout of Pearlscriptions/indexer:

```bash
git -C indexer apply ecosystem-fixes/pearlscriptions-indexer/2026-09-26/fix-stale-node-pin-operators-doc.patch
```

---

*Pearl donation address: `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d` ·
X: [@kshot9000](https://x.com/kshot9000)*
