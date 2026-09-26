# Bug report — xXGuilasXx/spark-pearl-miner (delta-scan, 2nd fix batch)

**Repo:** https://github.com/xXGuilasXx/spark-pearl-miner
**Scanned range:** commits `6736152..1e6a370` (~38 commits, 93 files — the work
that landed after the first fix batch)
**Scan date:** 2026-09-26 ~18:30 CDT
**Upstream PR:** https://github.com/xXGuilasXx/spark-pearl-miner/pull/2
**Fork branch:** `Kshot3000:fix/worktree-buildrs-head-and-soak-keepalive`
**Patch:** `fix-spark-pearl-miner-worktree-buildrs-and-soak-keepalive.patch`
**Focus:** host-side Rust logic (daemon, hashrate window, version tracking,
supervisor, soak tooling). CUDA kernels were not audited (no GB10 GPU here).

## Bug 1 — `crates/spm/build.rs` watched the wrong HEAD in git worktrees

**Severity:** low-medium (stale version metadata in worktree builds).

**What was broken:** commit `a4cca36` ("o hash de commit acompanha o HEAD em
builds incrementais") added `rerun-if-changed` on HEAD so incremental builds
pick up the new commit. But `git_dir()` used `git rev-parse --git-common-dir`,
which resolves to the **main** checkout's `.git`. In a linked worktree the live
HEAD is `<common>/worktrees/<name>/HEAD`, so the build script watched a HEAD
file the worktree's own commits never touch: incremental builds inside a
worktree kept the previous `SPM_GIT_COMMIT` — the exact staleness the commit
set out to fix. The code comment even claimed it was "also right for
worktrees"; it was not.

**Repro:** in any linked worktree of this repo,
`git rev-parse --git-dir` → `…/.git/worktrees/<name>` (has its own `HEAD`)
while `git rev-parse --git-common-dir` → `…/.git` (the main checkout's
`HEAD`). Commit in the worktree, rebuild — the build script does not re-run.

**Fix:** use `--git-dir`, which equals the common dir in a plain checkout and
points at the worktree's own gitdir in a worktree.

**Verified:** compiled the build script standalone (`rustc --edition 2021`,
std-only) and ran it inside a real worktree: it now emits `rerun-if-changed`
for `…/.git/worktrees/<name>/HEAD` (+ `packed-refs` + the worktree's branch
ref), and `SPM_GIT_COMMIT` matches the worktree's HEAD (`1e6a370f4103`).
Unchanged behavior in a plain clone (`--git-dir` == `--git-common-dir`).

## Bug 2 — `bench/g1-soak.sh` sudo keepalive could be orphaned by SIGKILL

**Severity:** low (security hygiene: an orphaned loop refreshes the user's sudo
timestamp every 5 minutes indefinitely).

**What was broken:** commit `0fe06c7` added a background loop
`( while true; do sleep 300; sudo -n true …; done ) &` to keep sudo alive during
the soak. It is only stopped by the `trap cleanup EXIT INT TERM`. If the script
is SIGKILLed (OOM killer, `kill -9`), the trap cannot run and the orphan keeps
running `sudo -n true` forever.

**Repro:** run the script, `kill -9` the main shell, observe the background
loop surviving and refreshing the sudo timestamp.

**Fix:** the loop pins the script's identity — PID plus `/proc` process start
time (field 22 of `/proc/PID/stat`), which is immune to PID reuse — and exits
once that process is gone. A `kill -0 $PPID` guard would NOT work: an orphaned
loop is reparented to init, which always answers `kill -0`.

**Verified:** `bash -n` clean. A harness replicating the exact guard (2 s loop)
printed ticks while the parent lived and printed EXITED immediately after
`kill -9` of the parent, with no processes left behind. (An earlier attempt
based on ppid comparison was caught by testing and discarded: bash double-forks
`(...) &` in non-interactive shells, so the loop's immediate parent is an
intermediate fork, not the script — the ppid check exited on the first
iteration even in normal operation.)

## Ruled out (delta range)

- 60 s hashrate window (137c9df): no off-by-one (trim `>` + filter `<=`
  consistent; boundary test asserts 61 s → 0), no unit error (7.04e13
  MACs/attempt ÷ 10 s ÷ 1e12 = ±7 steps as documented), API/GUI/CLI/i18n all
  consistent. One noted semantic: the window under-reports during the first
  ~60 s of daemon uptime (divides by full window width) — same semantics as
  the old 10 s window, likely by design.
- Supervisor spawn-real-worker: args match the `Cmd::GpuWorker` clap
  definition; spawns `current_exe()`, never the standalone
  `spark-pearl-gpu-worker` binary that lacks `--sim`. Stale M5 alert fully
  removed. Daemon power/coexist wiring (`hold_reason`, `keep_context`,
  `reconcile_worker`, `effective_launch`) — no inverted conditions.
- `spm-worker` verify path (dedup, canary, `verify_v3` before send) and
  handshake atomic ACK writes are careful; all `unwrap()`s are in test code.
- Deps: `nvml-wrapper 0.13` and `rayon 1.12` new but current/maintained; no
  downgrades in `Cargo.lock`. crates.io yank status could not be checked from
  this host.
- Tests: `cargo test -p spm-api` 13/13 pass; `cargo test -p spm-governor
  -p spm-coexist` all 11 suites pass. `cargo test -p spark-pearl-miner` could
  not run: `spm-gpu`'s build.rs requires `nvcc` (absent here) — environment
  limitation, not a code failure.

---
Found by the Pearl 24/7 builder loop. If this saved you debugging time:
PRL `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d` ·
[@kshot9000](https://x.com/kshot9000)
