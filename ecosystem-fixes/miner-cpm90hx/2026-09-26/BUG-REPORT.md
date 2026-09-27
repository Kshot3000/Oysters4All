# Bug report — chernuha-dev/miner-cpm90hx-pearl

**Repo:** https://github.com/chernuha-dev/miner-cpm90hx-pearl
(Open-source Pearl (PRL) CUDA miner for 2× NVIDIA CMP 90HX (sm_86);
fork of `1640675651/CPPminer` @ 6785ad349a33f7bebb3ffe1dc1ad876b56d66ef8, MIT; "no dev fee".)

**Scanned commit:** `05cdf5e` ("fix: select supported NVCC unroll pragmas", 2026-09-26)
**Scan date:** 2026-09-26 · full local build + source audit of all 65 C++/CUDA sources,
stratum client, V3 proof encoding, fee interface, and docs.
**Build verified:** `./build.sh --backend cpu` completes on Linux (cargo 1.98.1);
the binary links the real Rust `cp-proof-ffi` (symbols `cp_proof_build`,
`cp_proof_verify`, `cp_proof_encode_kryptex` present — no stub fallback).
**Fix status:** all 6 confirmed bugs fixed, fixes verified (see each item).
Upstream PR: https://github.com/chernuha-dev/miner-cpm90hx-pearl/pull/1
Fix branch: `Kshot3000/miner-cpm90hx-pearl` → `fix/target-overflow-cli-and-docs`

---

## B1. Difficulty-fallback share target saturates to "accept everything" (HIGH)

**Files:** `src/common/cp_util.cpp:305` (`cp_target_from_difficulty`),
`src/common/cp_util.cpp:375` (`cp_scale_target_le`), callers
`src/common/cp_pool.cpp:203-209`, `src/common/main.cpp:152-159`,
`src/cpu/cp_cpu_worker.cpp`, `src/cuda/cp_gpu.cu`, `src/opencl/cp_opencl_worker.cpp`.

**What was broken:** when a `mining.notify` carries no `target`, the miner
derives the pool target from `set_difficulty` d as
`pool_tgt = 2^(256 - d + log2(R_RANK*h*w))`. The scanner then scales it by the
jackpot factor `h*w*(k/r)*128` = 262,144 = 2^18 (`cp_scale_jackpot_target`).
For the default `d = 32`: `pool_tgt = 2^238`, and `2^238 * 2^18` overflows
256 bits. The old `cp_scale_target_le` saturated to all-`0xFF` on carry, so the
scan bound became `U256::MAX` and **every tile beat the target** — the miner
would "find" and submit a share on the first tile of the first nonce, and every
share would be pool-invalid. The formula double-counts: `R_RANK*h*w` is added
in the exponent while the scanner applies `h*w*(k/r)*128` again (2^32 off).

**Repro (verified numerically pre-fix):** d=32 → `exp = 256-32+log2(128·8·16) = 238.0`,
bound/2^256 = 1.0 → saturates to `U256::MAX`; bound is 2^32 (= 4,294,967,296×)
easier than the difficulty-implied `2^(256-d)`.

**Fix:**
- `cp_target_from_difficulty` now computes `exp = 256 - d - log2(cp_jackpot_scale_factor())`,
  so the post-scale scan bound equals the difficulty-implied `2^(256-d)`.
- `cp_scale_target_le` / `cp_scale_jackpot_target` now return `int` (1/0) and,
  on 256-bit overflow, **zero the bound and return 0** instead of saturating to
  `U256::MAX` — mirroring upstream pearl zk-pow's `penalized_target_bound`,
  which returns `None` ("a miner scaling a share target must be told the target
  is unusable rather than handed `U256::MAX`, which every hash satisfies").
- All four scan call sites (CPU, CUDA ×2, OpenCL) check the return value and
  skip the job with a loud stderr message.

**Verified:** post-fix harness on the fixed code — d=32 → `exp = 206.0`,
`pool_tgt = 2^206`, scaled bound = `2^224 = 2^(256-32)` exactly; an overflow
case now returns 0 with a zeroed bound (fail-closed: no tile digest can beat
it). `./build.sh --backend cpu` rebuilds clean.

**Reachability note:** Kryptex `notify` includes `target`, so the fallback is
not hit there; it affects pools that omit `target`. Even on the normal
`target` path, a pool target > 2^238 would previously have saturated.

---

## B2. `--pool` with a malformed URI is silently ignored (MEDIUM)

**File:** `src/common/main.cpp:256-267`.

**What was broken:** the `--pool` value was only honored if it contained
`"://"`, and host/port were only set if a `:` followed. If either was missing,
`pool_host`/`pool_port` kept their compiled-in defaults with **no warning** —
the miner happily mined to the default pool while the user believed they had
pointed it elsewhere. `pool_port = atoi(colon+1)` had no numeric/range
validation (`--pool stratum+tcp://host:abc` → port 0 → connect fails →
reconnect loop).

**Fix:** strict validation — missing scheme, missing host, host too long, or
non-numeric/out-of-range port (1–65535) now print an error and exit(1)
("refusing to silently fall back to the default pool").

**Verified:** code inspection + build; `--pool example.com:3370` now errors
instead of silently mining to the default pool.

---

## B3. `--align-test` unreachable on CPU-only builds despite pure-CPU tests (LOW)

**Files:** `src/common/main.cpp:587` and `:673`.

**What was broken:** the CLI refused `--align-test` with
"--align-test requires CUDA or OpenCL backend" unless a GPU backend was
compiled in, but `pearl_run_alignment_tests()` is backend-independent CPU
code: keyed-BLAKE3 noise derivation vs the upstream formula, Merkle chunk
roots, and the V3 salted-seed pinned vectors. CPU-only users (and CI) could
not run the protocol self-tests through the CLI.

**Fix:** `--align-test` now runs the CPU alignment tests whenever they are
compiled in (device selection and GEMM layout flags only apply when a GPU
backend is present); GPU device self-tests are skipped on CPU-only builds.

**Verified:** `./cppminer --align-test` on the `--backend cpu` build now runs
and passes; the pinned V3 salted-seed vectors match the vendored zk-pow
`commitment_hash_pinned_vectors` byte-for-byte (field-by-field extraction).

---

## B4. `scripts/plain_proof_host.py` hardcoded stale mining configs (k=4096, rank=256) (LOW)

**File:** `scripts/plain_proof_host.py:26-53`.

**What was broken:** the Python constants encoded `k=4096, rank=256`; the
miner's C configs (`src/common/cp_noise.c`, `PEARL_*_CONFIG`) and the Rust FFI
(`rust/cp-proof-ffi/src/lib.rs`) use `k=2048, rank=128` (`K_DIM 2048`,
`R_RANK 128` in `include/cp_config.h`). The script's comment ("match
cp_noise.c / GPU job_key") was false.

**Impact (bounded):** fail-closed — `cp_proof_build` rejects a config that
doesn't match `mining_config_bytes(k, rank, …)`, so the script would error
loudly, not mint bad proofs. The bridge path (`cp_run_python`) is currently
dead code; proof building goes through the in-process FFI. Latent landmine
for anyone re-enabling the bridge or using the script standalone.

**Fix:** all three config blobs regenerated from the actual
`src/common/cp_noise.c` constants — byte-identical now (verified by
programmatic comparison: 52/52 bytes each).

**Verified:** `python3 -c` byte comparison of `SCATTERED_CONFIG`,
`CONTIGUOUS_CONFIG`, `CUTLASS_CONFIG` against `PEARL_SCATTERED_CONFIG` /
`PEARL_CONTIGUOUS_CONFIG` / `PEARL_CUTLASS_CONFIG` — all match.

---

## B5. Docs overstated per-tile work 2× and carried stale protocol dimensions (LOW)

**Files:** `docs/hashrate_calculation.md:15-16`, `docs/proof.md:5,88-89`.

**What was broken:**
- `hashrate_calculation.md` claimed `K_DIM = 4096` and 524,288 MACs/hash
  tile; the code (`include/cp_config.h`) has `K_DIM 2048` → one tile is
  `8 × 16 × 2048` = **262,144** MACs. Any hand-derived hashrate was overstated
  by exactly 2×.
- `proof.md` claimed production `m = n = 131072`, `k = 4096`, `rank = 256`.
  Code: `M_DIM 131072`, `N_DIM 262144`, `K_DIM 2048`, `R_RANK 128` — and the
  document never mentioned `cert_version`/V3, the central post-fork protocol
  fact (salted-seed hard fork, mainnet height 99000).

**Fix:** both documents corrected to the compiled-in constants; `proof.md`
now documents V3 (salted-seed) certificates as the default.

---

## B6. Vendored zk-pow omitted upstream's `check_declared_tree_sizes` (LOW)

**File:** `third_party/zk-pow/src/ffi/plain_proof.rs` vs upstream
`pearl-research-labs/pearl` `zk-pow/src/ffi/plain_proof.rs` (pinned @ 3fe2267).

**What was broken:** upstream's `parse_proof` calls
`check_declared_tree_sizes()` to reject proofs whose declared `dim_a/dim_b`
disagree with the Merkle tree sizes; the vendored copy lacked the function
and the call (all other examined files — `api/seed.rs`, `api/sanity_checks.rs`,
jackpot/noise modules — are byte-identical to upstream apart from
formatting/compiler-compat tweaks).

**Impact (bounded):** the miner only ever locally verifies proofs it built
itself (well-formed), via `--verify`/`--dry-run`; a malformed proof would fail
at the pool, not locally. Confirmed divergence, low practical impact here.

**Fix:** ported upstream's `expected_merkle_leaves` + `check_declared_tree_sizes`
verbatim (logic identical to upstream lines 418–471) and wired the call into
`parse_proof` at the same position as upstream (before expensive checks).

**Verified:** Rust FFI crate compiles clean (`cargo` via CMake build);
the port is a logic-identical copy of the upstream function.

---

## Ruled out (checked, not bugs)

- **No dev fee / no wallet substitution.** `include/cp_fee.h` + `src/common/cp_fee.cpp`
  are a zero-fee passthrough; repo-wide grep found no hardcoded `prl1`/`tprl1`
  wallets. README's "no developer fee" claim holds.
- **V3 salted-seed derivation matches upstream** (pinned vectors byte-identical
  to vendored zk-pow `api/seed.rs`, which is byte-identical to upstream pearl).
- **CPU/CUDA jackpot folding consistent** (16 words + rotate-left 13 on both
  paths); target comparison as little-endian limbs, highest limb first, both sides.
- **Noise random-hash matches upstream** (`(1+index)` LE i32 prepend, seed in
  bytes 32..63, keyed BLAKE3).
- **Rust stub fallback is loud and was not taken** (real FFI symbols linked).
- **Zero-B shared-buffer race:** `h_BpT_global` is never index-written during mining.
- **Mining-config/job_key consistency** across layouts (CPU contiguous,
  CUDA scattered, CUTLASS fused).
- **Target endianness conversion** round-trips correctly.
- **Notify parsing** (Kryptex object-form + array-form), job lifecycle
  (pending-job queueing, cancel on new notify, double stale-share checks), and
  OpenCL CLI flags all verified.

## Unverifiable here (documented honestly)

- CUDA kernel correctness (no nvcc / no GPU on this host).
- End-to-end share acceptance by the Kryptex pool (needs live pool + wallet).
- plonky2 / MoE proof paths (not exercised by the dense-proof flow).
- Benchmarked hashrate numbers.
- Suspected items S1–S5 (blocking `connect()` with no timeout; naive JSON brace
  counting; duplicate-notify key ignoring target changes; array-form notify
  ignoring a possible `cert_version` element; object-form `set_difficulty`
  ignored) need live-pool or adversarial-network conditions to reproduce.

---

*Fixes prepared by the Pearl 24/7 builder. Patch: `fix-miner-cpm90hx-*.patch`.*

---
Built for the Pearl (PRL) ecosystem by [@kshot9000](https://x.com/kshot9000) ·
Pearl donations: `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`
