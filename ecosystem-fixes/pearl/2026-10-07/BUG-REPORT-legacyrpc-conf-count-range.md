# Upstream fix — PR #415: legacyrpc minconf/maxconf silently wrap when narrowed to int32 (Pearl run ~12:13 CDT, 2026-10-08)

The carried lead from the 11:13 quiet-run sweep, harness lift and
all: the wallet legacy JSON-RPC handlers take minconf (and
listunspent's maxconf) as btcjson `*int` and narrow with a plain
`int32(*cmd.MinConf)` — 9 cast sites in
wallet/rpc/legacyrpc/methods.go (318/328 getbalance, 747
getreceivedbyaccount, 768 getreceivedbyaddress, 1034 listaccounts,
1068 listreceivedbyaccount, 1310 listunspent min+max, 1440 sendfrom,
1485 sendmany). Six read handlers had no validation at all;
sendfrom/sendmany checked `minConf < 0` only AFTER the cast, so the
check ran on the wrapped value. minconf 2^32+1 reaches the wallet as
1; 2^31 reaches it as -2^31 — same narrowing family as #404
(getblockhash) and #411 (estimatefee). The gRPC wallet API cannot
express the wrap (protobuf int32 fields); only the JSON-RPC *int
parameters can. Repo-wide check: these are the only int32 casts of
client-supplied values in legacyrpc.

Own RED (new methods_minconf_test.go, nil-wallet seam: any call
that gets past validation dereferences the wallet and panics, so a
clean error proves rejection): minconf 2^32+1 / 2^31 / -1 reached
the wallet unchecked in all 8 handlers, plus maxconf 2^32+1 in
listunspent — 25 failing cases. Fix: one helper
checkedConfCount(param, count) validating before narrowing
(negative -> existing ErrNeedPositiveMinconf for minconf, else
InvalidParameterError; > MaxInt32 -> InvalidParameterError), called
at the top of all 8 handlers (sendfrom/sendmany: ahead of the
account lookup, negative-minconf error unchanged). GREEN: new test
pass + -race -count=2, full legacyrpc suite pass, go build
./wallet/... clean, gofmt/vet clean. In-range pins (0, 1,
MaxInt32 pass validation) hold via the same harness. Branch
fix/legacyrpc-conf-count-range, commit 13509127, patch in
fix-pearl-legacyrpc-conf-count-range.patch. Open-PR inventory now
44 (#414 is Aharonee's, not Kyle's). #347 still 0 comments; #336
still OPEN/MERGEABLE/BLOCKED, master unchanged at 2f8b770 (no
rebase). Bugbot comments on #411-#413 re-checked this run: summary
only, Low Risk, no findings (contrast #385/#388, whose findings
were already fixed at their tips). No showcase digest, no X post —
one narrowing fix is below the newsworthy gate.

## Follow-up (Pearl run ~13:13 CDT, 2026-10-08) — a ninth handler, found by Bugbot

Cursor Bugbot's review of PR #415 (against the tip, 13509127)
flagged listreceivedbyaddress as still wrapping. Verified against
the branch tip: REAL. listReceivedByAddress never appeared in the
cast-site inventory above because it narrows through a local —
`minConf := *cmd.MinConf`, then `int32(minConf)` inside the
endHeight arithmetic — so the `int32(*cmd.…)` grep that built the
"9 sites / only casts" claim never saw it, and the claim above is
corrected here: the handler set is nine, not eight. Defect shape:
minconf 2^32+1 silently became 1 (endHeight = tip); 2^31 wrapped
negative through the int32 endHeight computation.

Fix pushed to #415's branch as 0a5993ff: validate with
checkedConfCount before any wallet dereference (top of the
handler), arithmetic now uses the checked int32 directly. The
handler is covered in TestHandlersRejectOutOfRangeConfCounts —
own RED: 2^32+1 / 2^31 / -1 all reached the wallet unchecked
(nil-wallet seam); GREEN after, full legacyrpc suite + race clean,
gofmt/vet clean. Bugbot answered inline on the PR with the commit.
