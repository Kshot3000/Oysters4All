# Upstream fix — connmgr TorLookupIP short reads (Pearl run ~18:13 CDT)

Picked up from the "remaining verified leads" list in
BUG-REPORT-waddrmgr-truncated-values.md (connmgr tor.go TorLookupIP short
read) and re-verified end to end against current master (2f8b770c, fetched
fresh this run — tor.go identical to the audited copy).

## Bug (node/connmgr/tor.go at master)
`TorLookupIP` read each fixed-size SOCKS response with a single
`conn.Read`, which is not guaranteed to fill the buffer on a TCP stream:
- the 2-byte auth response: a 1-byte read leaves buf[1] at its zero value,
  which is exactly the expected "no authentication" byte — the check passes
  on data never received;
- the 4-byte resolve header: a fragmented read mis-parses (own RED below);
- the 4-byte address read was the only one with a length check.

Own RED: a fake SOCKS proxy (local listener) that answers correctly but
drips every response byte-by-byte makes TorLookupIP fail with
"invalid proxy response" on master. Reachable in normal operation for
anyone resolving via --proxy / --onionproxy (node/config.go:1072/1118) —
Tor proxies are precisely the peers whose replies arrive slowly.

## Fix (PR #392, branch fix/connmgr-tor-short-read, commit 51c83740)
- All three reads use io.ReadFull; a short address read reports the
  existing ErrTorInvalidAddressResponse (same as the old bytes!=4 check).
- New node/connmgr/tor_test.go: fragmented-proxy test (RED → GREEN) and a
  truncated-response test pinning that a mid-response hangup errors rather
  than parsing zero padding. Full connmgr suite passes; new tests
  race-clean; gofmt + go vet clean. PR verified OPEN + MERGEABLE.
- Patch: fix-pearl-connmgr-tor-short-read.patch

## Remaining from the verified-leads list (future runs)
- dnsseeder addNa boundary pair — REFINED this run: the port half is clean
  (minPort=0/maxPort=65535 with `Port <= minPort || Port >= maxPort`
  rejects valid port 65535; getNonStdIP's own test table uses 65535 as a
  valid port). The maxSize half is NOT a drop-in fix: addNa's
  `len > maxSize` admits maxSize+1, but the existing TestAddnNa expects
  exactly that (maxSize=1, two successful adds) — shipping the >= change
  means also changing that test's expectation, which needs the
  maintainer's semantics call. Take the port half alone, or take both
  with the test change argued explicitly in the PR body.
- dnsseeder getNonStdIP v6 encoding collision (unmasked by #387) — needs a
  design decision.
- dnsseeder crawler races — needs -race repro construction.
- validateMsgTx length-mismatch panic — real but no production path.

## Watches this run
- wPRL issue #347: still OPEN, 0 comments — no Pearl-team reply.
- PR #336: still OPEN, MERGEABLE.
- No GitHub showcase comment, no X post (today's X slot already used by
  the two Nacre posts; a single connmgr fix is below the newsworthy gate).
