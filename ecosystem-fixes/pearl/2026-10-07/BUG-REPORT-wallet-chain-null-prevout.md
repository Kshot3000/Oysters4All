# Upstream fix — PR #408: wallet/chain null gettxspendingprevout result panic (Pearl run ~04:13 CDT, 2026-10-08, late addendum 2)

Source: the Go hunter's FINAL report, also delivered after this
run's first report (like the Python hunter's final — both interims
were garbled, both finals were line-anchored; the mid-run "both
fabricated" note covered the interims and a preliminary read, and
is corrected here and in lessons-2026-10-08).

wallet/chain getTxSpendingPrevOut (btcd.go) len-checked the
gettxspendingprevout response but dereferenced prevoutResps[0]
unchecked. rpcclient decodes into []*btcjson...Result, so a JSON
[null] reply yields a nil element with no error. Own RED: real
rpcclient against an httptest backend returning getinfo + [null] —
panic at btcd.go:602, the hunter's claimed line. Fix: nil element →
(Hash{}, false), matching the function's fail-soft contract.
GREEN, full wallet/chain suite pass, -race + vet clean. Branch
fix/wallet-chain-null-prevout-result, commit 3cdb56fc, patch in
fix-pearl-wallet-chain-null-prevout.patch.

Honest scope (stated in the PR body): stock pearld never emits a
null element here; the trigger is a compatible-fork/buggy backend,
which rpcclient explicitly supports. Severity accordingly lower
than #398/#405. The final's CLEAN list (rpcclient notify parsers,
spv blockmanager/query, chainimport) was spot-checked at its
baseline item (#398's two halves still in master, as it said).
