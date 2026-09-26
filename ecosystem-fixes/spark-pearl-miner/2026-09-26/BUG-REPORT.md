# Bug report — xXGuilasXx/spark-pearl-miner

**Repo:** https://github.com/xXGuilasXx/spark-pearl-miner
**Scanned:** 2026-09-26 · upstream base `6736152` ("Merge chore/merge-check")
**Scan notes:** `hidden_files/spark-pearl-miner-scan-notes.md` (in the builder workspace)
**Patch:** `fix-spark-pearl-miner-cert-version-none.patch` (this directory; also upstream PR below)
**Upstream PR:** https://github.com/xXGuilasXx/spark-pearl-miner/pull/1
**Severity:** B1 medium-low (latent — no live pool omits `cert_version` today); B2 low (docs)

## B1 — Pool accepted jobs with omitted `cert_version` as V3 while the rest of the stack refused them

Three layers disagreed on a `mining.notify` without `cert_version` (`None`):

- `crates/spm-proto/src/lib.rs:71-97` — `Job.cert_version: Option<u32>` documented as
  "treated as unknown and refuses the job"; `Job::requires_update()` returns `true` for `None`.
- `crates/spm-work/src/lib.rs:126-130` — `WorkUnit::build` rejects `None` with
  `WorkError::UpdateRequired(None)` ("this build mines only 3").
- `crates/spm-pool/src/lib.rs:1203` (pre-fix) — `cert_version.unwrap_or(SUPPORTED_CERT_VERSION)`
  silently treated `None` as V3 and **accepted** the job.

**Repro / observed behavior** (traced against the real crates):

1. Daemon `on_slot → SessionEvent::JobReceived` (`crates/spm/src/daemon.rs:1074-1082`) records an
   `update_required` error in `slot.last_error` **but still stores the job and steps the pool event**.
2. `spm-pool` `on_job` accepted it as V3 (slot promoted Active, GPU target set).
3. Daemon `drive_target → book.bind` then failed in `WorkUnit::build` → `on_bind_error`
   (`daemon.rs:1006`) emitted "job refused: network upgrade – update required (pool sent
   cert_version None…)" and the GPU idled.
4. Every subsequent `mining.notify` repeated steps 1–3: the pool kept the session "active",
   binds kept failing, and the "update required" pause (`PauseReason::UnsupportedScheme`,
   `enter_pause`) never engaged. Contradictory errors, no failover, no hashing.

All three documented pools (HeroMiners, LuckyPool, Kryptex) send `cert_version: 3` today, so this
is latent — it fires the day a pool omits the field.

**Fix** (`crates/spm-pool/src/lib.rs`): `on_job` now uses
`if cert_version != Some(SUPPORTED_CERT_VERSION)`, routing `None` to `on_unsupported` — the same
update-required alert + `UnsupportedScheme` pause path as `cert_version >= 4` — matching the
`spm-proto` docs and `spm-work`. Docstring on the `JobReceived` event updated.

**Tests:**
- New `cert_version_omitted_pauses_with_update_required` in `crates/spm-pool/tests/scenarios.rs`:
  FAILS on pre-fix code, PASSES after.
- `crates/spm-pool/tests/invariants.rs` explorer: the `AwaitingJob` arm no longer generates `None`
  as a routine job variant (it now means "unsupported", which would burn the slot and starve the
  coverage targets); `None` is still generated via raw `JobReceived` events, so the unsupported path
  stays in the random model.
- Full suite green: `cargo test -p spm-pool -p spm-proto -p spm-work` —
  spm-pool 5 unit + 3 invariants + 43 scenarios, spm-proto 22+2+9, spm-work 9. All pass.

## B2 — VIABILITY.md forward subsidy projections ~1–9% high

`docs/en/VIABILITY.md` (and the pt-BR twin `docs/pt-BR/VIABILIDADE.md`) claimed
"~2,206 PRL in 1 month, ~1,794 in 6 months, ~1,435 in 12 months". Recomputed from upstream
`node/blockchain/validate.go` `CalcBlockSubsidy` (subsidy(h) = 2.1e9·E / ((h+E)·(h−1+E)), E = 650226)
at snapshot height 119,365 with the 194 s/block target:
**~2,228 / ~1,891 / ~1,579 PRL**. Fixed in both languages with the formula + snapshot height cited.

## Ruled out (checked, no bug)

- V3 salted-seed certificate correctness: commitment chain, noise model, tile transcripts, and
  `try_mine_one` are **bit-exact** against upstream `zk-pow` @ `3fe2267` (7 reference tests);
  `check_cert_version_eligible` semantics, `verify_v3` Salted assertion, and the `>= 4` pause all
  match upstream. No FP8/V4 at this rev.
- Dev fee: 2% disclosed (README banner == `spm_fee::banner()`), compile-time constants with a
  pinned-hash tripwire, no setter/override path, GUI/API reject fee keys with 422, auto-off when
  mining wallet == fee wallet. No bypass found.
- API security: loopback-only bind (LAN refused), token auth, path-traversal guard, TLS
  never downgrades on certificate errors.
- Address validation: bech32m, HRP `prl`, witness v1, 32-byte program — correct.
- Deps current (rustls 0.23.45, axum 0.8.9, tokio 1.53.1, bech32 0.11.1).

## Not verifiable here

- CUDA kernel bit-exactness (needs GB10/DGX Spark hardware; x86_64 sandbox has no GPU).
- Live pool captures in `docs/protocol/` re-verified against code only, not live.

---
Found by the Pearl Blockchain 24/7 builder (bug-hunt mode).
Pearl donation address: `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`
X: [@kshot9000](https://x.com/kshot9000)
