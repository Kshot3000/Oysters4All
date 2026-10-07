# Upstream fix — pearl-research-labs/pearl waddrmgr: extendAddresses watchOnly inverted

- **Date:** 2026-10-07 (Pearl builder loop, upstream bug-hunt rotation)
- **Found by:** hunter scan of `wallet/wtxmgr` + `wallet/waddrmgr` (hidden_files/hunt-2026-10-07/run-1013-wallet/scan.md), then independently re-verified in source + own RED run before fixing.
- **PR opened:** https://github.com/pearl-research-labs/pearl/pull/379 — one-line production fix + 2 regression tests. Attribution footer (@kshot9000 + PRL donation address) in the PR body only, never in code.
- **Branch:** `fix/waddrmgr-extend-watchonly` on Kshot3000/pearl, commit 9935f39e, base master @ 2f8b770c
- **Patch:** `fix-pearl-waddrmgr-extend-watchonly.patch` (2 files, +123/−1)

## Bug (verified at master 2f8b770c, wallet/waddrmgr/scoped_manager.go:1480)

`extendAddresses` computed `watchOnly := s.rootManager.WatchOnly() ||
acctInfo.acctKeyPriv != nil`. `loadAccountInfo` populates `acctKeyPriv`
precisely when the wallet is unlocked and not watch-only, so the flag
was true exactly when it should be false (the sibling `nextAddresses`
at line 1240 uses the correct `len(acctInfo.acctKeyEncrypted) == 0`).

Consequences, both reproduced red:
1. Every address created by `ExtendExternalAddresses` /
   `ExtendInternalAddresses` on an unlocked wallet was built from the
   public account key — no private key in the cached managed address,
   `PrivKey()` returns ErrWatchingOnly ("address manager is
   watching-only"), and no `deriveOnUnlock` queueing applies (manager
   not locked). Production path: wallet recovery —
   `wallet.extendFoundAddresses` extends addresses found on chain
   during rescan (wallet/wallet/wallet.go:1180).
2. With `includePQTapscript=true`, `maybeDeriveTapscriptRoot` skips
   derivation for public keys, so Extend produced the plain BIP-86
   address while Next/DeriveFromKeyPath produced the XMSS-committed
   address for the same index — two addresses for one derivation path.

## Fix

One line: mirror `nextAddresses` —
`watchOnly := s.rootManager.WatchOnly() || len(acctInfo.acctKeyEncrypted) == 0`.
Locked wallets still derive from the public key + queue deriveOnUnlock;
watch-only accounts (no encrypted account key) unaffected.

## Verification

- `TestExtendExternalUnlockedHasPrivKey`: RED "watching-only" → GREEN.
- `TestExtendExternalPQMatchesDeriveFromKeyPath` (-tags xmss): RED
  (extended root empty, plain BIP-86 address) → GREEN (roots match,
  a9f604ab…).
- `go test -tags xmss ./wallet/waddrmgr/ ./wallet/wtxmgr/` PASS;
  vet/gofmt clean. Pre-existing no-tag failure
  `TestManagedAddressValidation/wrong_priv_key` fails identically on
  unpatched master — unrelated, disclosed in the PR.
- Also scanned clean in the same hunt (no repro, not counted):
  wtxmgr kahnsort duplicate-edge wart (output-equivalent),
  DeserializeLabel length handling (DB-internal only), balance/
  rollback accounting, waddrmgr sync/birthday, XMSS seed derivation —
  details in the hunter scan.md.
