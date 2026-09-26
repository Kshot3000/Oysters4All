# Bug report — rizkir443/pearl-indexer: broken Termux launch scripts

**Repo:** https://github.com/rizkir443/pearl-indexer
**Scanned:** 2026-09-26 · **Fixed in:** branch `fix/termux-scripts` (patch: `fix-termux-scripts.patch`)
**Fix PR:** https://github.com/rizkir443/pearl-indexer/pull/1 (opened 2026-09-26 from Kshot3000 fork)

## Originality verdict
This repo is a copy of **Pearlscriptions/indexer v1.1.2** (2026-05-29; upstream is now
v1.3.1) with Termux/Android deployment scripts added (`start-pearl.sh`,
`stop-pearl.sh`, `fix-push.sh`, `push-github.sh`). The MIT license still carries
"Copyright (c) 2026 Pearlscriptions", and package names still read
`pearlscriptions-indexer` — so it is a legal copy, not original work. Bugs in the
*copied* indexer code belong upstream in Pearlscriptions/indexer (already scanned
2026-09-26; fix PR https://github.com/Pearlscriptions/indexer/pull/1). The bugs
below are in the repo's **own added scripts** — the only code unique to this repo —
so they were fixed here.

## Bugs found (all in `start-pearl.sh` / helper scripts)

### 1. Tunnel URL detection regex never matches (high — breaks the whole script's purpose)
- Line 43 was: `grep -oP 'https://[a-z0-9-]+\\.trycloudflare\\.com'`
- Inside single quotes, `\\.` reaches PCRE as "literal backslash + any char".
  Real cloudflared quick-tunnel log lines contain no backslashes, so
  `TUNNEL_URL` was **always empty** → the script always printed "Could not
  detect tunnel URL" and `PRL20_OPERATOR_PUBLIC_URL` was never updated in `.env`.
- **Fix:** `grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com'` (POSIX ERE; `-E`
  is also safer on Termux grep builds than `-P`).

### 2. Wrong checkout path (high — script aborts under `set -e`)
- `start-pearl.sh` used `cd ~/indexer` and `$HOME/indexer/.env`, but
  `push-github.sh` clones the repo to **`~/pearl-indexer`**. On a normal setup
  the `cd` fails and `set -e` kills the script mid-run (after the tunnel was
  already started), or the `.env` update silently targets the wrong directory.
- **Fix:** single `INDEXER_DIR="$HOME/pearl-indexer"` variable used for both
  `cd` sites and the `.env` path, plus a clear early error if the checkout is
  missing.

### 3. Helper scripts not executable (low)
- `fix-push.sh` and `push-github.sh` were committed mode `100644`, so
  `./fix-push.sh` fails with "Permission denied".
- **Fix:** committed as `100755` (`start-pearl.sh`/`stop-pearl.sh` already were).

## How the fix was verified
- `bash -n` clean on all four scripts.
- Reproduced bug #1: ran the **old** pattern against a real-format cloudflared
  log line (`... |  https://abc-def-123.trycloudflare.com  |`) → no match. Ran
  the **new** pattern → matches and extracts the URL.
- Reproduced/verified bug #2 by inspection: `push-github.sh` clones to
  `~/pearl-indexer`; `start-pearl.sh` referenced `~/indexer` in 3 places —
  now all three resolve through `INDEXER_DIR`.
- Verified the `.env` update snippet end-to-end: simulated `.env` with an old
  `PRL20_OPERATOR_PUBLIC_URL`, ran the script's python3 one-liner → URL
  replaced correctly, other vars untouched.
- Verified `npm run indexer:serve` resolves: the **root** `package.json`
  defines `indexer:serve` → `npm run serve --workspace @pearlscriptions/indexer-api`,
  so the command is valid when run from the repo root (which the fixed `cd`
  now guarantees).
- **Not verified:** actual execution on a Termux/Android device (no Android
  hardware here) — the cloudflared + `termux-wake-lock` steps are Termux-only.

## Apply instructions
```bash
git clone https://github.com/rizkir443/pearl-indexer.git
cd pearl-indexer
git apply /path/to/fix-termux-scripts.patch   # or: git am < fix-termux-scripts.patch
```

## Notes for the maintainer
- The copied indexer is **v1.1.2** (May 2026) while Pearlscriptions/indexer is at
  v1.3.1 — consider rebasing onto upstream to pick up the operator registry
  hardening, incremental-ingest tests, and newer docs.
- None of the Markdown docs mention the Termux scripts, even though Termux/Android
  is this repo's stated purpose — a short "Running on Termux" section in the
  README would help users find `start-pearl.sh`/`stop-pearl.sh`.
