# Upstream fix — PR #416: dnsseeder web pages render crawled peer UserAgent unescaped (stored XSS) (Pearl run ~09:13 CDT, 2026-10-09)

New pattern class swept at master 2f8b770 after months of clean
verification-only runs: template rendering of peer-controlled
strings. The chain is fully remote: wire's validateUserAgent
checks UserAgent length only (≤256, no character restrictions);
dnsseeder/crawler.go:79 stores msg.UserAgent verbatim into the
crawl result; seeder.go:304 copies it into the node record. Both
web views rendered it through text/template (no escaping exists
in that package): nodeHandler's webtemplate.Strversion
("Remote SubVersion" cell) and statusHandler's statusCG summary,
where generateWebStatus Sprintf-interpolates v.strVersion into
the Value rendered as {{.Value}}. Any crawled peer — an attacker
just runs a node and gets crawled — could store a <script>
payload that executes for whoever views the seeder's status
pages. The same file escapes the operator-supplied seeder name
with html.EscapeString in writeHeader and the "No seeder found"
paths, and generateWebStatus's doc comment says its output is
"ready to be ranged over by an html/template" — the peer string
was the one that missed the file's own norm.

Own RED (new dnsseeder/http_useragent_test.go, real handlers via
httptest, node with UserAgent <script>alert(1)</script>): raw
payload present in BOTH statusCG and node page output. Fix:
http.go switches text/template -> html/template (every field
context-escaped by default); webstatus.Value becomes
template.HTML for the summary cell's intentional <b> markup,
and generateWebStatus now html.EscapeString's every dynamic
string it interpolates (strVersion, statusStr — crawl-error
text, dns2str) so nothing rides the template.HTML bypass raw.
Audited unchanged: txtHandler prints the UserAgent with %q
under text/plain (quoted, no HTML context); the archive-
extraction class swept in the same run is absent repo-wide
(no archive/tar|zip imports in Go, no zipfile/tarfile in
Python). GREEN: both new tests pass, full dnsseeder suite pass
+ -race -count=2, gofmt/vet clean, binary builds. Branch
fix/dnsseeder-useragent-xss, commit 97022cac, patch in
fix-pearl-dnsseeder-useragent-xss.patch. PR:
https://github.com/pearl-research-labs/pearl/pull/416

State re-verified this run: master unchanged at 2f8b770,
Kyle's open upstream PRs now 45 (newest #416), #347 still 0
comments, #336 OPEN/MERGEABLE/BLOCKED (no rebase needed),
in-dev #369/#311/#310/#366/#349/#330/#189/#221/#414 + issue
#303 + pips (4 open) all still OPEN — nothing landed.
Correction (same day, after the run's original state-check
batch landed): an earlier draft of this record claimed
`gh pr list` head OIDs disagreed with the pulls API — that was
wrong; the mismatched values came from an interleaved
background output that was not this run's query. The run's own
batch and a pulls-API recheck agree exactly (#415 0a5993ff,
#412 c26c6ee8, #413 a0ab6fc4, #411 aacc048d). Bugbot note: #415's
sole comment via pr view is the Cursor summary; its only
inline finding remains the known listreceivedbyaddress one,
already fixed at tip 0a5993ff and answered. Both Kyle repos
clean before this run's record commit (Oysters4All c2b3f91,
Hermes 9b688c9), hub live 200 with PRL donation address +
@kshot9000. No showcase digest, no X post — a single (real)
fix is below the newsworthy gate, consistent with prior runs.
