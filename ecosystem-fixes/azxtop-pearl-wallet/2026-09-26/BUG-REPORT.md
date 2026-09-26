# Bug report — azxtop/pearl-wallet (Android/Capacitor wallet), scanned 2026-09-26

Upstream repo: https://github.com/azxtop/pearl-wallet (branch `main`, commit `b7bc97e`, v0.2.10)
Fork: https://github.com/Kshot3000/pearl-wallet · fix branch `fix/stale-pending-lock-and-server-corrections`
Pull request: https://github.com/azxtop/pearl-wallet/pull/1
Patch: `fix-azxtop-pearl-wallet.patch` (this directory — applies cleanly to upstream `main` @ `b7bc97e`)

## What was scanned

Full local checkout: wallet crypto (`src/lib/pearl.ts`, `src/lib/send.ts`,
`src/crypto/wallet-worker.ts`, `src/lib/keystore.ts`, `src/crypto/client.ts`),
chain backends (`src/lib/rpc.ts`, `src/lib/blockbook.ts`, `src/lib/explorer.ts`),
sync/failover (`src/lib/wallet-sync.ts`), pending-outgoing accounting
(`src/lib/pending-outgoing.ts`), snapshot cache, profiles, update manifest +
Android `UpdateInstallerPlugin.java` (redirect host allowlist, SHA-256 verify),
and the SafeTrade backend (`server/index.mjs`, `server/market.mjs`).

## BUG 1 (MEDIUM) — stale pending-outgoing records permanently lock their UTXOs

**File:** `src/lib/pending-outgoing.ts` → `projectWalletSnapshot()`

**What was broken:** when a broadcast transaction never confirms (dropped from the
mempool, never relayed), its record stays in local storage forever —
`reconcilePendingOutgoing()` only evicts records that are *confirmed* with all
owned outputs indexed. In `projectWalletSnapshot()`, the record's inputs were
added to the `spent` set **before** the 48-hour staleness check, so the inputs
were excluded from `availableUtxos` permanently. `availableUtxos` feeds the send
preview (`App.tsx` `prepareSend(projected?.availableUtxos …)`) and the "可用余额"
available-balance display, so after one failed broadcast the user could never
re-spend those UTXOs in the app — no in-app recourse, funds effectively locked
in the UI.

**Repro:**
1. Broadcast a send; the tx never confirms (indexer never lists it).
2. Wait 48h+ (or observe `staleTxids` → UI labels it "待核对").
3. The inputs remain excluded from `availableUtxos` forever — the send preview
   cannot select them and the available balance stays reduced.

The repo's own test (`pending-outgoing.test.ts`, "stops estimating an unresolved
transfer after 48 hours") encoded this behavior: it asserted `availableUtxos`
was `[]` for a stale record.

**Fix:** the staleness check now runs *before* inputs are marked spent — a record
older than 48h still shows as "待核对" (needs verification) in Activity, but its
inputs become spendable again. Fresh unconfirmed records still lock their inputs
(double-spend protection preserved). The test was updated to assert the fixed
behavior and a new case asserts fresh records still lock.

**Verified:** the new regression test FAILS on the pre-fix code (1 failed, 9
passed — confirmed by stashing the fix) and the full suite passes with the fix:
`npx vitest run src` → 32/32, `node --test server/market.test.mjs` → 5/5,
`npx tsc --noEmit` clean.

## BUG 2 (LOW) — `/api/safetrade` 24h `changePercent` could span minutes, not a day

**File:** `server/index.mjs` (SafeTrade market backend)

**What was broken:** `changePercent` was computed as
`(last24hPrice / first24h - 1) * 100` where `first24h` is the *first trade inside*
the trailing 24h window. On a low-volume pair whose only recent trades happened
minutes apart, the "24h change" actually measured a ~1-hour window — misleading
market data served to the app's SafeTrade tab.

**Repro (with the repo's own SQLite schema):** one trade yesterday @ 1.20, two
trades in the last hour @ 1.00 → 1.50. Old code reported **+50.00%**; the true
24h change is **+25.00%**.

**Fix:** the reference price is now the last trade *before* the window (the
already-prepared `priorTrade` statement, previously only used for candle
`previousClose`), falling back to the first in-window trade only when no earlier
trade exists. The computation was extracted to an exported `stats24h()` in
`server/market.mjs` so it is unit-testable; response shape (`stats24h: { high,
low, volume, turnover, changePercent }`) is unchanged.

**Verified:** 2 new tests in `server/market.test.mjs` pass (5/5); end-to-end repro
script against the real SQLite statements confirms old +50.00% → new +25.00%.

## BUG 3 (LOW, hardening) — `/api/safetrade` auth silently disabled when token unset

**File:** `server/index.mjs`

**What was broken:** `if (readToken && request.headers.authorization !== …)` —
when the `PEARL_READ_TOKEN` env var was missing, the check was skipped entirely
and the read-only market/account endpoint served without any auth. (Caught and
fixed during this scan; the fail-closed one-line change was already present in
the working tree from the scan pass and is included in this PR.)

**Fix:** `if (!readToken || request.headers.authorization !== \`Bearer
${readToken}\`)` — a missing token now denies every request instead of
disabling auth. (The separate `/api/update` endpoint stays public by design.)

**Verified:** `node --check server/index.mjs` clean; logic reviewed — no behavior
change when the token is set.

## BUG 4 (LOW, hardening) — keystore AAD address check accepted malformed strings

**File:** `src/lib/keystore.ts` → `encryptMnemonic()`

**What was broken:** the wallet address is bound into the AES-256-GCM associated
data, but it was validated with `address.startsWith("prl1p")` — any string with
that prefix passed, including malformed addresses.

**Fix:** replaced with the full `isValidPearlAddress()` (bech32m, v1, 32-byte
program). No import cycle (`pearl.ts` does not import `keystore.ts`).

**Verified:** `npx tsc --noEmit` clean; all keystore call sites pass derived
(valid) addresses, so no behavior change on the happy path.

## Verified working (no bug — ruled out)

- **Taproot signing:** `wallet-worker.ts` `signSend()` calls `tx.signIdx()` with
  the *untweaked* child private key while the input carries `tapInternalKey`.
  This is correct: `@scure/btc-signer` v1.4.0 auto-tweaks the key
  (`getTaprootKeys`, `esm/transaction.js` L705–717). Proven by the new permanent
  regression test `src/crypto/taproot-signing.test.ts`: the produced 64-byte
  Schnorr signature verifies with `@noble/curves` `schnorr.verify()` against
  the *tweaked* output key taken from the P2TR scriptPubKey, using the exact
  BIP-341 sighash preimage the tx was signed with.
- **Address derivation:** BIP-86 `m/86'/808276'/0'/0/i`, TapTweak, bech32m v1,
  32-byte program — `isValidPearlAddress()` rejects v0/base58/future versions
  (no pearlkeeper-class bug). Matches upstream `node/btcutil/address.go` policy.
- **Fee estimation (`send.ts`):** `(11 + 58·in + 43·out) × 2 grains/vB` —
  P2TR-correct (input ≈ 57.25 vB), dust 546 grains, MAX_FEE 1 PRL guard, and the
  dust-folding path re-checks `fee > MAX_FEE`.
- **Keystore crypto:** PBKDF2-SHA256 600k iterations, AES-256-GCM with AAD-bound
  address, memory zeroing.
- **Biometric vault (Android):** AndroidKeyStore AES/GCM,
  `setUserAuthenticationRequired(true)`,
  `setInvalidatedByBiometricEnrollment(true)`.
- **APK update flow:** strict URL regexes, redirect host allowlist
  (github.com / release-assets.githubusercontent.com), SHA-256 verification
  before install; `isNewerVersion()` semver compare correct.
- **Sync/failover (`wallet-sync.ts`):** exponential backoff, pearlchain →
  pearlresearch fallback, fingerprint-based change detection — reviewed, no bug.
- **Test suite:** 32/32 vitest + 5/5 node tests green, `tsc --noEmit` clean.

## Not runnable here (noted honestly)

- Android build (`./gradlew`) and on-device flows — no Android SDK/device in
  this environment. The Java plugin code was reviewed by reading only.
- Live chain behavior (broadcast of a real mainnet tx, 48h mempool drop) — the
  pending-outgoing fix is verified by unit tests against the exact projection
  logic the UI consumes, not by a live broadcast.

## Apply instructions

From upstream `main` @ `b7bc97e`: `git apply fix-azxtop-pearl-wallet.patch`,
then `npm test` (vitest) and `node --test server/market.test.mjs`.

---

*Pearl donation address: `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d` · Built by [@kshot9000](https://x.com/kshot9000)*
