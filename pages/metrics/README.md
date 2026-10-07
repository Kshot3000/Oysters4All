# Pearl Metrics — pearld Prometheus Dashboard

Browser-local dashboard for `pearld`'s Prometheus metrics endpoint: chain-tip
freshness, peer health, wire traffic by P2P command, per-method RPC latency
from the real histogram buckets, mempool pressure, and per-second counter
rates between scrapes. No build step — open `index.html` directly or serve
the folder.

**Live:** https://kshot3000.github.io/Oysters4All/pages/metrics/

## Status of the endpoint (important)

The `/metrics` endpoint comes from upstream
[pearl-research-labs/pearl PR #310](https://github.com/pearl-research-labs/pearl/pull/310)
(`--metricslisten`, default port 9105, `/metrics` + `/healthz`), which is
**not yet in a released pearld** as of 2026-10-06. This dashboard is built
against that PR's published metric catalogue (`node/metrics/README.md` and
`node/metrics/collector.go` / `metrics.go` on the `feat/pearld-metrics`
branch — every `pearld_*` name is copied from there, none invented), so it
works today against a pearld built from that branch and is ready the day
the PR lands. Until then the page also ships a clearly-labelled sample
scrape in the exact PR format so the dashboard can be evaluated.

The endpoint is **unauthenticated** — upstream's own guidance is to bind it
to loopback or a firewalled private address, never the public internet.

## What it does

- **Fetch or paste** a `/metrics` scrape (fetch from a loopback/local page,
  or `curl -s 127.0.0.1:9105/metrics` and paste). Auto-refresh every 15 s
  when fetch works. Only the endpoint URL is persisted (localStorage);
  scrape contents are never uploaded anywhere.
- **Summary** — node identity (`pearld_info` labels), chain tip + age,
  peer in/out + connects/disconnects/bans/rejection reasons, net totals,
  mempool transactions/bytes/utilization vs its configured limit.
- **RPC table** — requests, errors and error rate per method; latency mean
  is exact (histogram sum ÷ count) and p95 is approximated by interpolation
  inside its bucket, hidden when the rank falls in the +Inf bucket (never
  presented as exact).
- **Wire table** — messages and bytes per P2P command and direction.
- **Rates** — on the second and later scrapes, per-second rates for RPC
  requests, blocks connected, and net bytes; counters that move backwards
  (node restart) suppress rates instead of showing negatives.
- **Health notes** — heuristics, labelled as such: syncing state, stale
  tip (>~3 blocks at Pearl's 194 s target; >1 h = stall), zero peers,
  mempool ≥90%/100% of limit, RPC auth failures, RPC error rate >5%.
- **All series** — searchable table of every series in the scrape,
  including the standard `go_*` / `process_*` series.

All scrape-derived strings (label values are node-controlled) are rendered
through an `esc()` helper — the fleet XSS rule.

## How it differs from Pearl Node

[ Pearl Node ](../node/) polls JSON-RPC for live state. Metrics reads the
Prometheus endpoint, which carries what RPC doesn't publish: cumulative
per-method RPC latency, auth failures, wire bytes per command, bans and
rejection reasons, and block connect/disconnect counters.

## Tests

- `node --test tests/metrics.test.mjs` — parser (labels, escapes, +Inf/NaN,
  malformed lines), summary, health heuristics, histogram quantile, rates.
- `node --test tests/dom.test.mjs` — id wiring, `?v=` pins, attribution,
  pre-release honesty pins, esc() rendering pins, PR #310 catalogue pins.

---

Built by [@kshot9000](https://x.com/kshot9000) · tips:
`prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`
