# Upstream fix — dnsseeder addNa rejects port 65535 (Pearl run ~19:13 CDT)

Picked up from the remaining-leads list in BUG-REPORT-wtxmgr-truncated-values.md
("dnsseeder addNa boundary pair") and re-verified end to end against current
master (2f8b770c) before shipping. The pair splits in two:

## Bug (shipped): port 65535 rejected
`dnsseeder/seeder.go:360` (master):
```go
if nNa.Port <= minPort || nNa.Port >= maxPort {  // minPort=0, maxPort=65535
    return false
}
```
Port is a `uint16`; 65535 is the largest *valid* TCP port, not one past the
end. A node announcing port 65535 could never enter `theList`. The seeder's
own `getNonStdIP` already encodes port 65535 (`TestGetNonStdIP` covers it),
so the two halves of the same file disagreed about the boundary.

## Fix (PR #393, branch fix/dnsseeder-port-65535, commit d97e8343)
- One character: `>=` → `>` on the upper guard. Port 0 stays rejected.
- New `TestAddNaPortBoundaries` drives the real `addNa` with ports
  1 / 44112 / 65534 / 65535 (accepted) and 0 (rejected).
- Own RED: `addNa(10.0.0.4:65535) = false, want true` — the other four cases
  already behaved correctly pre-fix.
- GREEN: full dnsseeder suite pass; addNa tests `-race` clean; vet/gofmt clean.
- PR state verified OPEN + MERGEABLE, body verified (1690 chars, attributed
  footer with @kshot9000 + PRL address in the body only, never in code).
- Patch: fix-pearl-dnsseeder-port-65535.patch

## Deliberately NOT shipped: maxSize off-by-one
`addNa`'s capacity guard `len(s.theList) > s.maxSize` admits `maxSize + 1`
entries, but the existing `TestAddnNa` (maxSize: 1) encodes exactly that as
expected behaviour. Per the 18:13 lesson, a lead that contradicts the
project's own test is a question, not a patch — the observation is raised as
a question in PR #393's body instead of being bundled into the fix.

## Remaining leads (unchanged)
- dnsseeder getNonStdIP v6 encoding collision (crc16 over `To4()==nil` for
  real IPv6 → every v6 non-std node shares crc 0xffff) — needs a design
  decision from maintainers.
- dnsseeder crawler races — needs a -race repro construction.
- validateMsgTx length-mismatch panic — real but no production path.

## Watches this run
- wPRL issue #347: still OPEN, 0 comments — no Pearl-team reply, NOT re-sent.
- PR #336: still OPEN, MERGEABLE, BLOCKED; Cursor checks SUCCESS; no rebase
  needed (0 behind master at last check).
- Open fleet #370–#392 all MERGEABLE.
