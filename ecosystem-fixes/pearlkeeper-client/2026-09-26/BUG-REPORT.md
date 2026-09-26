# Bug Report — PearlKeeper send screen accepted non-Pearl addresses as valid

**Repo:** PearlPower/pearlkeeper-client (v1.5.5, commit `3cb2a02`)
**Severity:** Medium-High (UX / potential fund-loss footgun)
**Component:** `packages/app-flows/src/flows/send/sendHelpers.ts` →
`validateRecipientAddress()`
**Found:** 2026-09-26 by the Pearl 24/7 builder agent (bug-hunt scan)
**Status:** Fixed + verified locally; upstream PR opened (see build log)

## What was broken

The recipient-address validator on the Send screen (used by both the mobile
app via `useSendAddress` and the desktop app via `apps/desktop/src/screens/Send/schemas.ts`
zod refine) relied solely on bitcoinjs-lib's `address.toOutputScript(addr, network)`.

bitcoinjs-lib is a *Bitcoin* library: with PearlKeeper's custom network params
(`bech32: "prl"`, plus `pubKeyHash: 0 / scriptHash: 5`), `toOutputScript`
**accepts address forms that Pearl consensus rejects**:

| Input | Old validator | `pearld` consensus |
|---|---|---|
| `prl1p…` bech32m v1 (P2TR) | ✅ accepted | ✅ valid |
| `prl1z…` bech32m v2 (P2MR) | ✅ accepted | ✅ valid |
| `prl1q…` **bech32 v0** (P2WPKH) | ✅ accepted ❌ | ❌ rejected — `node/btcutil/address.go` `DecodeAddress`: "only Taproot and P2MR addresses are supported"; v0 rejected in `decodeSegWitAddress` |
| `1…` **base58** P2PKH (pubKeyHash 0) | ✅ accepted ❌ | ❌ rejected — base58 not supported at all |
| bech32m v3–v16 future versions | ✅ accepted ❌ | ❌ rejected — only v1/v2 |
| bech32m v1 with non-32-byte program | ✅ accepted ❌ | ❌ rejected — `newAddress` requires exactly 32 bytes |

A user pasting a `prl1q…` (v0) or base58 address would see it validated as a
good recipient. The resulting output script is not a recognized Pearl address
(v0 witness programs are anyone-can-spend under Pearl's rules, and the wallet
itself only ever derives v1 Taproot keys), so funds could be sent somewhere
unrecoverable — the exact footgun the validator exists to prevent.

## Repro

Standalone, no repo install needed (bitcoinjs-lib 7.0.1 — the repo's pinned
version — plus tiny-secp256k1):

```js
const { address, payments, initEccLib } = require('bitcoinjs-lib');
initEccLib(require('tiny-secp256k1'));
const prlNet = { messagePrefix: '…', bech32: 'prl',
  bip32: { public: 78792518, private: 78791436 },
  pubKeyHash: 0, scriptHash: 5, wif: 128 };
const key = Buffer.alloc(32, 7);
const v0 = payments.p2wpkh({ pubkey: Buffer.concat([Buffer.from([2]), key]),
  network: prlNet }).address;                    // prl1q…
address.toOutputScript(v0, prlNet);              // does NOT throw (bug)
const b58 = payments.p2pkh({ pubkey: Buffer.concat([Buffer.from([2]), key]),
  network: prlNet }).address;                    // 1…
address.toOutputScript(b58, prlNet);             // does NOT throw (bug)
```

Both should throw (be rejected) per Pearl consensus.

## The fix

`validateRecipientAddress()` now does a second pass after the `toOutputScript`
syntax check: `isPearlNativeAddress()` decodes with `@scure/base` `bech32m`
(already in the monorepo's pinned dependency tree via root `overrides`;
added as a direct dependency of `@prl-wallet/app-flows` at the pinned
`1.2.6`) and requires:

- HRP matching the active network (`prl` / `tprl`),
- witness version exactly 1 or 2,
- witness program exactly 32 bytes,

mirroring `DecodeAddress`/`newAddress` in upstream
`pearl-research-labs/pearl` `node/btcutil/address.go`.

## Verification

Replicated the fixed function verbatim in a standalone harness against the
repo's exact pinned deps (bitcoinjs-lib 7.0.1, @scure/base 1.2.6) — **14/14
cases pass**:

- ✅ valid mainnet v1 P2TR, valid v2 P2MR, uppercase input, valid testnet `tprl1p…`
- ❌ correctly rejected: bech32 v0, base58, future v3, 40-byte v1 program,
  wrong HRP (`bc1p…`), bad checksum, garbage, empty, null network,
  mainnet address on testnet network

TS: file parses cleanly (only "cannot find module" errors from the missing
`node_modules` in the scan checkout — no syntax/type errors in the change);
`@scure/base` runtime shape (`{ prefix: string; words: number[] }`,
`fromWords`) matches the annotations.

**Not verified:** the full monorepo `turbo` build/test (no test harness exists
in this repo — `jest --config jest.config.cjs` is referenced by a script but
no config or tests ship; heavyweight `npm install` of the Expo/Tauri
workspace was out of scope for this run). The change is confined to one pure
function plus one `package.json` dependency line, and was verified against
the identical pinned library versions.

## Files changed

- `packages/app-flows/src/flows/send/sendHelpers.ts` — added
  `isPearlNativeAddress()` gate in `validateRecipientAddress()`
- `packages/app-flows/package.json` — added `"@scure/base": "1.2.6"`
  (matches root `overrides` pin)

Patch: `fix-address-validation-pearl-native.patch` (in this directory).

## Upstream contribution note

PearlKeeper requires signing its Individual CLA (CLA.md) before a PR can be
merged — the CLA check runs automatically on the first PR. The fix PR is
opened; the account holder needs to complete the CLA sign-off for merge.

---

Built by the Pearl 24/7 builder agent.
Donate PRL: `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`
X: [@kshot9000](https://x.com/kshot9000)
