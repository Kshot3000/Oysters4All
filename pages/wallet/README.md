# Pearl Wallet — Self-Custody PRL Vault

Built by [@kshot9000](https://x.com/kshot9000) for the Pearl ecosystem. Donations: `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`

A self-custody PRL wallet on Taproot rails that runs entirely in your
browser — no accounts, no tracking, no servers holding keys. Installable as
a PWA (manifest + service worker, offline shell): on iPhone, Share → Add to
Home Screen; on Android/desktop, use the install prompt.

Open `index.html` directly (`file://`) or serve the directory; it also works
as-is on GitHub Pages.

## What it does

- **Create or import a vault** — new BIP-39 recovery phrase (12 or 24 words,
  optional BIP-39 passphrase) with a tap-in-order backup quiz, or import an
  existing phrase / WIF private key.
- **Encrypted on-device backup** — the vault is encrypted with your password
  (AES-GCM, MetaMask/Phantom pattern). The password can't be recovered;
  the only escape is wipe & restore from your phrase.
- **Send & receive** — balances and history from Blockbook, live fee tiers
  (slow/normal/fast) with exact vByte math, full review screen before
  anything broadcasts; receive with QR code and address rotation.
- **PRL-20 tokens** — token balances appear once the Pearlscriptions indexer
  is reachable.
- **Auto-lock** — keys live only in this device's memory and are wiped on
  lock. Nothing is sent anywhere except the Pearl network when you transact.

## Crypto lineage

`src/pearl.js` is the audited pearlpurse reference implementation, verified
byte-for-byte against Pearl's Go node (addresses, signatures, signed tx
bytes, txids). The wallet core adds network-parameterized BIP-86 derivation
(`m/86'/{coin}'/0'/0/{index}`), bech32m encoding, WIF import/export, coin
selection, fee estimation, the Blockbook client, and the AES-GCM vault.
No new cryptography was invented for this app.

## Honest limits

- **You are the bank.** Lose your recovery phrase and your PRL is gone
  forever — there is no reset, no support desk, no custodian.
- Chain data comes from the public Blockbook endpoint
  (`blockbook.pearlresearch.ai`) and prices from CoinGecko — both are
  third-party and can lag or be unreachable; the wallet says so instead of
  inventing figures.

## Tests

- `tests/verify.mjs` — 66/66 crypto checks: derivation, addresses, signing,
  transaction bytes and txids against known-answer vectors.
- `tests/smoke.mjs` — full-flow jsdom drive of the real page (onboarding →
  quiz → password → home → send validation → receive rotation → settings →
  backup export → lock → unlock); requires `jsdom` resolvable.

Run: `node --no-warnings --loader ./tests/loader.mjs tests/verify.mjs`
Build the bundle: `node build.mjs` (committed as `pearl-wallet.bundle.js`).
