# Pearl Sign — Air-gapped Taproot Transaction Forge

A five-step workbench for Pearl (PRL) Taproot transactions: **Key → Coins → Build → Sign → Broadcast**.

Live: https://kshot3000.github.io/Pearl-Muse-24-7-Ai-builder/pages/sign/

## What it does

1. **Key** — derive BIP-86 Taproot keys (`m/86'/808276'/0'/0/i` mainnet, coin `1` testnet) from a
   BIP-39 mnemonic, load a WIF, or go **watch-only** (address only, no signing in this browser).
2. **Coins** — fetch UTXOs from a configurable blockbook, or paste `txid:vout value` lines
   (grains, or `1.5 prl`; optional trailing address for the standalone verifier).
3. **Build** — recipients, fee rate (grains/vB, with blockbook estimate fetch), change address.
   Exact vBytes via the audited P2TR size formula; dust outputs refused; unsigned hex + decoded view.
4. **Sign** — BIP-341 keypath Schnorr per input, `SIGHASH_DEFAULT` or `SIGHASH_SINGLE|ANYONECANPAY`
   (the Bazaar atomic-swap presign format). Every signature is **re-verified locally** against its
   tweaked output key before broadcast. A standalone panel verifies any pasted signed hex.
5. **Broadcast** — blockbook `/api/sendtx/` or your own `pearld` `sendrawtransaction` (JSON-RPC,
   credentials in localStorage like the explorer page).

## Offline / air-gapped

All crypto is vendored under `lib/` (the same `@scure/*` + `@noble/*` set audited in the
Pearl Bazaar build) — no CDN, no network calls except the endpoints *you* configure.
Save the page to a USB stick, open it on an offline machine, and carry unsigned/signed
hex back and forth. The signing key never has to touch a networked device.

## Crypto lineage

Key derivation, TapTweak, bech32m, BIP-341 keypath sighash and wire serialization come from
`pages/market/src/crypto.js` (audited pearlpurse ISC wallet core, verified byte-for-byte
against Pearl's Go reference `node/txscript`). This app adds: a full raw-tx decoder,
generalized sighash-type signing, local signature verification, coin selection with exact
fee math, and the RPC helpers.

## Tests

```sh
node --no-warnings --loader ./tests/loader.mjs --test ./tests/verify.mjs
```

16/16 green: derivation known-answer vectors, WIF round-trip, bech32m strictness,
build→decode round-trip, local verification (DEFAULT + 0x83), tamper detection
(DEFAULT fails all inputs — amounts are committed globally; 0x83 fails only the
tampered input), fee math vs the audited formula, coin selection, amount parsing,
UTXO parsing with address→spk decoding, spk→address recovery.

## Build

The committed `pearl-sign.bundle.js` is built from `src/` with esbuild:

```sh
node build.mjs
```

(esbuild resolved via `~/workspace/.build-tools`, same pattern as the Bazaar/Wallet pages.)

## Honest limits

- Keypath spends only — P2TR addresses. No script-path, no multisig in this version.
- A "verified" signature proves the math against the prevouts you supplied; it can't prove
  those prevouts are real or unspent. Confirm UTXOs against your own node before moving
  serious money.
- Pasting a mnemonic/WIF into any browser makes it a hot key. For large amounts, use the
  air-gapped flow: watch-only build here, sign offline.

---

Built for the Pearl (PRL) ecosystem · [@kshot9000](https://x.com/kshot9000) ·
Tip the forge: `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`
