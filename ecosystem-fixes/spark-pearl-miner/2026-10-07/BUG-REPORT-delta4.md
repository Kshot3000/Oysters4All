# Delta-scan #4 fix — xXGuilasXx/spark-pearl-miner, 4e37e58 → 062b0fc

- **Date:** 2026-10-07 (Pearl builder loop, upstream bug-hunt run)
- **PR opened:** https://github.com/xXGuilasXx/spark-pearl-miner/pull/3 (follows PRs #1/#2 from the 2026-09-26 scans, still open)
- **Branch:** `fix/kryptex-v2-ack-fallback` on Kshot3000/spark-pearl-miner, commit 8268452, base main @ 062b0fc
- **Patch:** `fix-kryptex-v2-ack-fallback.patch` (6 files, +69/−12)
- **Scan notes:** goal hidden_files/hunt-2026-10-07/spark-delta4/scan-notes.md (full delta audit incl. ruled-out areas)

## Bug 1 (MEDIUM) — Kryptex v2 session never falls back to plain proofs

Since bbb26f2, every `*.kryptex.network` host defaults to the KryptexV2 dialect (gzip proofs). The documented contract (spm-api config.rs `dialect_for_host`, MANUAL.md): the pool answers without `type` when it does not offer v2 and "the session falls back to plain proofs by itself". The ack handler in spm-proto client.rs only assigned an encoding on an explicit `"v2"`/`"plain"` answer; a no-type ack kept the pre-auth Gzip default, so every proof went out gzipped to a pool expecting raw bincode — rejected forever (the ProofFormatLearner only switches the proof *field*, never the encoding). The repo e2e can't catch it: spm-mockpool always echoes `type:"v2"` when v2 is requested.

Repro (real PoolSession vs hand-rolled TCP pool): ack None → GZIP (bug); `"v2"` → GZIP; `"plain"` → PLAIN. Fix: pure `encoding_after_auth()` in spm-proto (only explicit "v2" → Gzip, explicit "plain" → Plain, KryptexV2 + any other answer → Plain, other dialects unchanged) + unit tests. After fix, same harness: None → PLAIN, "v2" → GZIP, "plain" → PLAIN.

## Bug 2 (LOW-MEDIUM) — clock-cap detector confirms exceedance across a telemetry gap

spm-governor clockcap.rs measured the "3 s above cap without a break" run as `now − exceed_since` with no gap check (the loaded-time accumulator in the same function already discarded > MAX_SAMPLE_GAP intervals). Samples only at t=0 and t=10 (2400 MHz, cap 2000) confirmed `Uncapped` — the stuck "cap missing" banner class the transient fixes were eliminating. Fix: a gap > MAX_SAMPLE_GAP restarts the run; regression test `a_telemetry_gap_does_not_confirm_an_exceedance` (gap → not Uncapped; sustained run after the gap still confirms).

## Bug 3 (LOW) — GUI preset + docs still on Kryptex v1

webui/js/presets.js Kryptex preset still `dialect: 'kryptex'` (restore-defaults silently produced a v1 entry; `hasAdvanced()` flagged the untouched default row). CONFIGURATION dialect rows + GUI-preset tables (en + pt-BR) still described auto → v1 and v2 as "not confirmed live". All now `kryptex-v2`, matching `dialect_for_host` and the default pool (whose test asserts DialectSetting::KryptexV2).

## Verification

- `cargo test -p spm-proto -p spm-governor` PASS (incl. both new tests); `cargo test -p spm-api -p spm-pool -p spm-mockpool` PASS (11 suites, incl. the Kryptex v2 gzip e2e).
- End-to-end session harness re-run post-fix (results above). Binary crate not built (needs nvcc/CUDA 13, absent — same as scans #1–#3).
- Ruled out in the delta (scan notes): password never reaches any log site; login-change reconnect consistent; installer pipefail conversion complete; config round-trip holds; v2 wire format itself correct.
