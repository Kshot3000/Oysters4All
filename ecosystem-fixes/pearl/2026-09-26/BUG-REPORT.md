# Bug report — pearl-research-labs/pearl `apps/` (desktop wallet + address-validation)

**Date:** 2026-09-26
**Upstream commit scanned:** `3fe2267` (master, 2026-09-24)
**Upstream PR:** https://github.com/pearl-research-labs/pearl/pull/336
**Fork branch:** `Kshot3000/pearl` → `fix/apps-wallet-hardening`
**Patch:** `fix-pearl-apps-wallet-hardening.patch` (this directory)

## Bug 1 (MEDIUM — security hardening): desktop wallet fee estimates over plaintext HTTP

**File:** `apps/apps/pearl-desktop-wallet/src/main/clients/blockbook-client.ts`

**What was broken:** `BlockbookBaseUrlMap` hardcoded `http://` URLs for
`blockbook.pearlresearch.ai` and `blockbook.testnet.pearlresearch.ai`.
Both hosts answer with a `301 Moved Permanently` to the https equivalents,
so the wallet's first request went out unencrypted before following the
redirect.

**Repro:**
```
$ curl -sI http://blockbook.pearlresearch.ai/api/v1/estimatefee/6
HTTP/1.1 301 Moved Permanently
Location: https://blockbook.pearlresearch.ai:443/api/v1/estimatefee/6
```
(2026-09-26; the https endpoint itself returns 200 with `{"result":"0.00002"}`.)

**Why it matters:** fee-estimate requests are metadata about wallet
activity; a MITM on the initial plaintext hop could observe them or serve
a forged estimate before the redirect is followed.

**Fix:** request the `https://` endpoints directly (2 lines + comment).

**Verification:** `electron-vite build` passes; the production main bundle
(`out/main/index.js`) was grepped — contains only the https URLs, zero
plaintext `http://blockbook` occurrences. The wallet's Electron
single-instance test could not run here (the Electron binary is not
downloadable in this sandbox — environmental, unrelated to the change).

## Bug 2 (MEDIUM): `@pearl/pearl-address-validation` broken as published

**Files:** `apps/packages/pearl-address-validation/{src/index.ts, tests/index.spec.ts, README.md, package.json}`, `apps/pnpm-lock.yaml`

**What was broken:**
1. **Failing test suite (reproduced):** the published tests used
   `dup`/`td`/`duprt`/`sd` HRPs that the implementation rejects
   (`parseBech32` requires `prl1p`/`tprl1p`/`rprl1p`). Running `vitest run`
   on the pristine checkout: **9 of 17 tests failed**.
2. **Base58 false-positives:** `validate()` accepted base58 P2PKH/P2SH
   addresses using *Bitcoin* version bytes (0x00/0x6f/0x05/0xc4). Pearl is
   Taproot-only — `node/btcutil/address.go` `decodeSegWitAddress` accepts
   only bech32m witness v1+ with 32-byte programs, and Pearl has never had
   base58 addresses — so e.g. the Bitcoin address
   `17VZNX1SN5NtKa8UQFxwQbFeFc3iqRYhem` validated as a "valid Pearl
   address". (The package is currently imported by nothing in the monorepo,
   so no live wallet was affected — but its contract was wrong.)
3. **Wrong docs:** the README showed Bitcoin-style base58 examples and a
   `signet` network the code does not implement.

**Fix:**
- Removed the base58 branch (legacy `AddressType` enum members kept for
  API compatibility, now never returned); removed the unused `base58-js`
  and `sha256-uint8array` dependencies (lockfile updated).
- Rewrote the test suite with real `prl`/`tprl`/`rprl` bech32m vectors —
  the mainnet vector is a known-good Pearl address, the testnet/simnet
  vectors were re-encoded from the same 32-byte program with a
  self-checking BIP-350 codec — plus regression cases: v0 rejected, v2
  rejected, 20-byte program rejected, bad checksum rejected, wrong HRP
  (`bc1p…`) rejected, base58 rejected, mixed-case rejected, uppercase
  accepted, testnet→regtest casting.
- Rewrote the README with correct Pearl examples and the networks the
  code actually implements.

**Verification:** `vitest run` → **19/19 pass**; `tsc --noEmit` clean;
`prettier --check` clean.

## Notes for maintainer
- The desktop wallet uses Oyster-port 8335 for both mainnet and testnet
  (`network-config.ts`) rather than Oyster's defaults (44207/44209/44211).
  Internally consistent (the wallet passes `--rpclisten` explicitly), but
  the shared port means only one network's daemon can run at a time and
  `killExistingWalletProcesses` (lsof :8335) will reap the other network's
  daemon. Left as-is — worth a look.
- The wallet's "testnet" entry actually targets `--testnet2` (data subdir
  `testnet2`, HRP `tprl`). Naming quirk, not changed.

---
Found and fixed by the Pearl 24/7 builder for @kshot9000.
Support Pearl development: `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`
