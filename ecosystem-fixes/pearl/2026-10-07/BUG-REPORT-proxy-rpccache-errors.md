# Upstream fix — pearl-research-labs/pearl proxy: caddy-jsonrpc-cache caches JSON-RPC error responses

- **Date:** 2026-10-07 (Pearl builder loop, upstream bug-hunt rotation)
- **Found by:** code audit of `proxy/caddy-jsonrpc-cache/handler.go` at master 2f8b770c (no filed issue; the proxy is Kyle's mining/datacenter surface — the shipped `proxy/Caddyfile` caches `getblocktemplate`).
- **PR opened:** https://github.com/pearl-research-labs/pearl/pull/377 — production fix + regression test. Attribution footer (@kshot9000 + PRL donation address) in the PR body only, never in code.
- **Branch:** `fix/proxy-jsonrpc-cache-errors` on Kshot3000/pearl, commit b151ad50, base master @ 2f8b770c
- **Patch:** `fix-pearl-proxy-rpccache-errors.patch` (2 files, +75/−1)

## Bug (verified at master 2f8b770c, proxy/caddy-jsonrpc-cache/handler.go)

`fetchFromUpstream` stored every upstream response with HTTP status 200. pearld reports RPC failures as HTTP 200 with an `error` field in the JSON-RPC body (e.g. `-28 "Loading block index..."` during warmup). The status check therefore cannot keep failures out of the cache: one transient error was stored and replayed to every caller for the whole TTL — with the shipped `getblocktemplate` rule, miners kept receiving a stale warmup error after the node had recovered.

**Reproduced red before fixing** — new `TestErrorResponsesNotCached` against the unmodified handler: a backend that fails once with an HTTP-200 JSON-RPC error and then succeeds was never called a second time; the cached error was served instead (backend call count stayed 1).

## Fix

- `fetchFromUpstream` stores the response only when `rec.statusCode == 200 && !isJSONRPCError(body)`.
- `isJSONRPCError`: body parses as a JSON-RPC response and its `error` field is present and non-`null`. Unparseable bodies keep the old behaviour (not treated as errors); non-200 responses were already not cached.
- The caller that triggered the fetch still receives the live error unchanged — it is just never written to the cache, so the next request retries upstream.

## Verification

- `go test ./...` in `proxy/caddy-jsonrpc-cache`: PASS (all pre-existing tests + the new one), also PASS with `-race`. `gofmt` clean, `go vet` clean.
- Post-fix test flow: error not replayed (2nd request reaches the recovered backend), successful response cached as before (3rd request is a HIT).

## Also checked this run, no action

- PR #373 Bugbot trail: every inline finding is anchored to commits ≤ 7b34b152 and was already addressed by 40928d81 (pushed earlier today); Bugbot has not yet re-reviewed the new head. Nothing new to fix.
- PR #336: base == current master head (2f8b770c), MERGEABLE/BLOCKED — no rebase needed; blocked is the fork-workflow-approval state, as before.
- Issue #146 (empty zk-pow README / missing dnsseed README / stale pearl-website refs): still live in the tree, but fully covered by open PRs #147 (the issue author's own), #158 and #160 — a duplicate PR would be spam. Skipped.
- Issue #347 (wPRL): still 0 comments — no Pearl-team reply to report.
- `go test ./spv/...`: all packages PASS at master.

## Follow-up (same PR #377, commit 1ef9c76c, 2026-10-07 ~10:13 CDT run)

Sibling defect in the same handler, found by auditing what else the
recorder captured but the serve path discarded:

- `fetchFromUpstream` recorded the upstream status code, but
  `ServeHTTP`/`writeCachedResponse` unconditionally answered HTTP 200. A
  non-200 upstream response for a cacheable method — operationally, the
  `reverse_proxy` 502 with a plain-text body while pearld restarts — was
  rewritten to **200 OK** with the non-JSON body labelled
  `application/json`. Miners and health checks saw a successful call
  during an outage.
- RED: `TestUpstreamErrorStatusPreserved` against the #377 head —
  backend returns 502 "upstream unavailable", client got HTTP 200.
- Fix: `cacheEntry` carries the upstream `statusCode` + `contentType`;
  `writeCachedResponse` replays non-200 responses verbatim (no ID
  rewrite). Non-200 responses were already never stored, so cache hits
  are unaffected; the regression test also asserts the next request
  retries upstream and succeeds.
- GREEN: full package suite PASS, `-race` clean on the cache tests,
  `go vet`/`gofmt` clean. Patch: `fix-pearl-proxy-rpccache-status.patch`.
  PR comment: https://github.com/pearl-research-labs/pearl/pull/377#issuecomment-6040928586
