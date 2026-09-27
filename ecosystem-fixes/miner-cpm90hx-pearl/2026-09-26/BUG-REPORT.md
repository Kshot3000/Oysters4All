# Bug Report — miner-cpm90hx-pearl (Chernukha-dev)

**Repo:** `Chernukha-dev/miner-cpm90hx-pearl` (Pearl PoUW miner for 2× NVIDIA CMP 90HX)
**Upstream base:** `05cdf5e` · **Date:** 2026-09-26
**Auditor:** Muse (Pearl blockchain developer), for Kyle Cox ([@kshot9000](https://x.com/kshot9000))

Six bugs confirmed by reproduction. All are fixed in the accompanying patch;
fixes were verified by rebuilding (`./build.sh --backend cpu`), running the
miner, and by a 14-assertion C harness linked against the real `cp_util.cpp`.

---

## B1 (critical) — Fallback share target 2³² too easy, saturates to accept-everything

**File:** `src/common/cp_util.cpp` — `cp_target_from_difficulty()`

The fallback pool target (used when a pool `notify` omits the target) was
computed as `2^(256-d+log2(rank·h·w))` while the scan bound multiplies the
pool target **again** by the jackpot factor `h·w·(k/r)·PENALTY_BASE_RANK` —
the rank terms were double-counted. At default difficulty 32 the bound came
out 2³²× too easy; the 256-bit product then overflowed and the old code
**saturated the bound to `U256::MAX`**, so *every* tile "beat" the target and
the miner would submit shares the pool rejects.

**Reproduction (before fix):** d=32 → pool target `2^238` → scaled bound
saturates to all-`FF`.

**Fix:** pool target is now `2^(256-d-log2(cp_jackpot_scale_factor()))`
(`cp_target_from_difficulty`), and the scaler (`cp_scale_target_le` /
`cp_scale_jackpot_target`, now returning `int`) builds the product into a
temp buffer: on overflow it **zeroes the bound and reports failure** instead
of saturating to `U256::MAX` — the same fail-closed philosophy as upstream
Pearl's `penalized_target_bound`. All CPU, OpenCL, and CUDA callers skip the
job loudly on failure.

**Verification:** 14-assertion harness against the real `cp_util.cpp`:
d=32 fallback = exactly `2^206`, scan bound = exactly `2^(256-32)` =
`2^224`; `2^240` pool target → overflow → return 0 + zeroed bound;
`U256::MAX` → rejected; `(2^238−1)·2^18` fits bit-exactly. **All pass.**

---

## B2 — Malformed `--pool` URI silently falls back to the default pool

**File:** `src/common/main.cpp`

`--pool` without `scheme://` or with a bad port was silently ignored (plus
`atoi` accepted garbage ports), so a typo could point the miner at the
wrong pool with no warning.

**Fix:** `--pool` now requires `scheme://host:port`, rejects empty/overlong
hosts and non-numeric/out-of-range ports via `strtol`, and exits(1) with an
explicit error instead of falling back silently.

**Verification:** `./cppminer --pool baduri` → error + exit 1 (was: silent
default-pool fallback).

---

## B3 — `--align-test` wrongly unavailable in CPU-only builds

**File:** `src/common/main.cpp`

`--align-test` refused to run on CPU-only builds even though
`pearl_run_alignment_tests()` is pure CPU (keyed-BLAKE3 noise derivation,
Merkle chunk roots, V3 salted-seed pinned vectors).

**Fix:** CPU builds now run the alignment tests (GPU device self-tests stay
conditional on a compiled GPU backend).

**Verification:** `./cppminer --align-test --backend cpu` →
`[align-test] all tests passed`.

---

## B4 — `scripts/plain_proof_host.py` shipped stale mining configs

The script's 52-byte configs encoded `k=4096`, `rank=256`; current code uses
`k=2048`, `rank=128` (the FFI rejects mismatched configs, so this was
latent, not live).

**Fix:** all three configs (scattered / contiguous / CUTLASS) regenerated
byte-identically from `src/common/cp_noise.c` by script (verified
`k=2048`, `rank=128` in the first 8 bytes of each).

---

## B5 — Stale docs: dimensions, work-per-tile, proof params

- `docs/hashrate_calculation.md`: `K_DIM` 4096 → **2048**;
  MACs/tile 524,288 → **262,144** (`8 × 16 × 2048`).
- `docs/proof.md`: dims `m=n=131072, k=4096, rank=256` →
  **`m=131072, n=262144, k=2048, rank=128`**; added the V3 (salted-seed)
  `cert_version=3` note that was missing.

---

## B6 — Vendored zk-pow missing upstream `check_declared_tree_sizes()`

**File:** `third_party/zk-pow/src/ffi/plain_proof.rs`

The vendored verifier lacked upstream's check pinning each committed Merkle
tree's `total_leaves` to the declared `m/n/k` dimensions — a divergence from
`pearl-research-labs/pearl` that could accept malformed dimension
interpretations.

**Fix:** ported upstream `expected_merkle_leaves()` +
`check_declared_tree_sizes()` verbatim (adapted to local `usize` types) and
wired it into `parse_proof()` before any expensive verification.

**Verification:** `cargo check` on the vendored `zk-pow` crate passes.

---

## Ruled out (checked, not bugs)

No dev fee or wallet substitution (`cp_fee` is a zero-fee passthrough; no
hardcoded Pearl wallet). V3 salted-seed vectors match upstream
byte-for-byte. CPU/CUDA jackpot folding and target endianness agree. The
real Rust proof FFI is linked in CPU builds (no stub). Job lifecycle,
stale-share handling, and Kryptex object-form `notify` parsing are sound.

## Not verifiable here

CUDA correctness (no GPU/nvcc on the audit machine — the `.cu` call-site
changes were reviewed by inspection only), and live Kryptex share acceptance
(no pool credentials). CUDA compile coverage of the edited `.cu` hunks
should be confirmed on a GPU box.

---

*Found something this missed? PRs welcome. Tips keep the audits running:*
`prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d` · [@kshot9000](https://x.com/kshot9000)
