# Upstream fixes — hunter final reports batch (Pearl run ~14:13 CDT, late handoffs)

The two hunter subagents' FINAL reports arrived after the run's first report and were
far stronger than their garbled interim deliveries. Each claim below was re-verified
independently (source read + own RED test) before shipping.

## Shipped
- **PR #385 — wallet PSBT NonWitnessUtxo index panic.** wallet/wallet/psbt.go: PsbtPrevOutputFetcher + FinalizePsbt indexed NonWitnessUtxo.TxOut[prevIndex] unchecked; InputsReadyToSign only nil-checks, PInput.IsSane is a stub. Counterparty PSBT spending index 5 of a 1-output prev tx crashed the wallet. Sibling SumUtxoInputValues (btcutil/psbt/utils.go) has the exact check. Own RED (panic) → GREEN; Fund/Finalize tests pass. Patch: fix-pearl-wallet-psbt-nonwitness-index.patch
- **PR #386 — addrmgr reset() leaves stale nNew/nTried.** deserializePeers counts before sanity checks that can fail; loadPeers' reset() rebuilt buckets/index but not counters → NumAddresses phantom + GetAddress spins forever on empty buckets holding a.mtx. Own RED (NumAddresses=1 after failed load) → GREEN; full addrmgr suite pass. Patch: fix-pearl-addrmgr-reset-counters.patch
- **PR #387 — dnsseeder dns.go: IPv6 non-std nodes never published + zero-question panic.** Both updateDNS loops ranged slice INDICES (0..3) so dnsV6Non (4) never ran; handleDNS indexed r.Question[0] unchecked (QDCOUNT=0 → panic, remote-triggerable). Own REDs (panic; 0 AAAA records) → GREEN; full dnsseeder suite pass. Patch: fix-pearl-dnsseeder-dns-serving.patch
- **PR #388 — proxy jsonrpc cache key ignores params.** Lookup/singleflight/store keyed on method only; getblocktemplate (the module's headline cached method) is parameter-bearing (mode/capabilities/rules) → cross-caller response replay within TTL. Key = method + raw params. Own RED (proposal request got template-mode response, 1 backend call) → GREEN + race clean. Independent of #377; possible trivial rebase if #377 lands first (noted in PR body). Patch: fix-pearl-proxy-cache-key-params.patch

## Verified leads NOT shipped (for future runs)
- waddrmgr db.go deserializers (5 sites + fetchAccountName/fetchAccountByName): embedded length fields trusted after only a fixed minimum-length check → panics (and one up-to-4GiB alloc) on corrupt/truncated wallet DB rows; sibling deserializeWatchOnlyAccountRow uses bytes.Reader safely. Hunter run-verified 5 panics; fix surface is large — do as its own focused PR.
- wtxmgr db.go: deserializeLockedOutput needs 40 bytes, no length check (hunter run-verified panic on 3-byte value); fetchUnminedInputSpendTxHashes panics when stored length isn't a multiple of 32 (sibling deleteRawUnminedInput iterates len/32). Small, own RED still needed.
- dnsseeder addNa rejects port 65535 (`>= maxPort` with maxPort=65535) and admits maxSize+1 entries (`>` cap) — tiny boundary pair, same file as #387.
- dnsseeder getNonStdIP: crc16 over rip.To4() which is nil for real IPv6 → every v6 non-std node encodes to 255.255.<port> — collision NOW UNMASKED by #387 publishing v6non records. Needs a design decision (what should the v6 encoded record be?) — flag for maintainer input or careful PR.
- dnsseeder races: startCrawlers mutates node fields under RLock; crawler.go reads s.theList unlocked. Needs -race repro construction.
- connmgr tor.go TorLookupIP: bare conn.Read instead of io.ReadFull on the SOCKS greeting/resolve header (the address read in the same function does check the count — sibling proof). Drip-feed repro needed.
- validateMsgTx length-mismatch panic (from the earlier record): still a lead, no production path.

## Correction to the earlier same-day record
The BUG-REPORT-scriptclass-and-gwpass.md note calling the connmgr/addrmgr hunter's work
"fabricated" referred to its INTERIM delivery (whose quoted code indeed exists nowhere).
Its FINAL report was a different, largely accurate document — source of PRs #386/#387 above.
Lesson appended to hidden_files/lessons-2026-10-07.md.

## Follow-ups (2026-10-07 ~15:13 CDT run) — Bugbot rounds on #385 + #388, both verified + fixed

- **PR #385 follow-up 94e3a3c1:** Bugbot was RIGHT — the fetcher skipping a malformed input left a missing prevout, and `txscript.NewTxSigHashes` dereferences it (`hashcache.go:241`, `IsPayToTaproot` on nil), so `FinalizePsbt` still panicked before the signing loop's bounds check ran; the PR body's "fail cleanly downstream" claim was wrong for this caller. Own RED reproduced at the real entry point (panic in NewTxSigHashes via psbt.go:393). Fix: `FinalizePsbt` runs new `checkNonWitnessUtxoIndices` after `InputsReadyToSign`, returning the descriptive error before sighash construction. `TestFinalizePsbtMalformedNonWitnessIndex` RED→GREEN; Fund/Finalize pass; PR comment posted.
- **PR #388 follow-up dfccd291:** Bugbot + agentic security review were RIGHT — entries were never deleted (`fresh()` only skipped reuse, `clear()` only on Cleanup), so param-keyed entries (key + full body) accumulated for the process lifetime; unbounded growth by distinct-params minting. Fix: `get()` evicts expired on access, `set()` sweeps expired on insert (retained = TTL window only). `TestCacheEvictsExpiredEntries` RED→GREEN; full module suite green. Verified no hunk overlap with #377 (different functions); noted in PR comment.
