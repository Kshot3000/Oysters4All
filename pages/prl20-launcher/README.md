# PRL-20 Token Launcher

Design, validate, and inscribe **PRL-20** deploy and mint operations on the Pearl
blockchain — entirely in the browser. No build step, no server, no custody.

Open `index.html` directly (`file://`) or serve the directory; it also works as-is
on GitHub Pages.

## What it does

- **Deploy designer** — ticker, max supply, decimals, per-mint limit, with live
  validation against the exact on-chain PRL-20 rules. Token *name* is kept as an
  off-chain label (PRL-20 has no name field); *premine* is planned as follow-up
  mint inscriptions (PRL-20 has no premine field).
- **Mint designer** — custom tickers plus curated examples. PRLS mints lock the
  fixed `100000` amount and require the operator's fee-recipient address for the
  1 PRL launch fee (never guessed — you paste it from your indexer operator).
- **Wallet** — BIP-39 mnemonic → BIP-86 (`m/86'/coin'/0'/0/0`) Taproot wallet,
  address QR, WIF import. Keys live in memory only and are never persisted.
- **Launch** — fetches UTXOs from your Blockbook, estimates fees from real
  serialized sizes, builds the **commit** (keypath) and **reveal** (script-path
  inscription) transactions, shows raw hex + txids, and broadcasts them one at a
  time with explicit confirmation. The reveal unlocks after the commit confirms
  (optional 0-conf override).
- **Directory** — live token list from your Pearlscriptions indexer (`GET /tokens`,
  read-only), with supply progress and per-token detail.
- **Learn** — why commit→reveal exists and how fees work.

## Protocol notes

- Inscription envelope (executed Taproot script-path leaf):
  `<32-byte key> OP_CHECKSIG OP_FALSE OP_IF "prl-20" "application/json" 0x00 <JSON ≤520B pushes> OP_ENDIF`
- Deploy: `{"p":"prl-20","op":"deploy","tick":"…","max":"…","lim":"…","dec":"…"}`
- Mint: `{"p":"prl-20","op":"mint","tick":"…","amt":"…"}`
- Numeric fields are canonical non-negative integer strings; tickers are
  `^[a-z0-9]{1,16}$`; first valid deploy wins the ticker.
- PRLS: fixed deploy `max 2100000000 / lim 100000 / dec 18`, fixed mint
  `amt 100000`, 1 PRL fee per credited mint to the operator-configured recipient.

## Files

| File | Purpose |
|---|---|
| `index.html` / `styles.css` / `app.js` | The launcher UI (classic scripts, no modules) |
| `pearl-bundle.js` | Browser bundle of the crypto core (`window.PearlInscribe`), built with esbuild — committed so users never build |
| `pearl-inscribe.js` | Audited ESM source of the core (bech32m, BIP-39/86, Taproot commit/reveal, PRL-20 JSON, Blockbook REST) |
| `lib/` | Vendored ESM dependencies (`@scure/*`, `@noble/*`) for the source + tests |
| `importmap.json` | Import map for the ESM source (used by `tests/`) |
| `qrcode.min.js` | Vendored QR generator (classic script) |
| `tests/verify.mjs` | 49-check verification suite |
| `tests/loader.mjs` | Node ESM loader applying `importmap.json` for the suite |

Rebuild the bundle after editing the core:

```bash
npx esbuild pearl-inscribe.js --bundle --format=iife --global-name=PearlInscribe \
  --minify --alias:@noble/curves=./lib/noble-curves --alias:@noble/hashes=./lib/noble-hashes \
  --alias:@scure/base=./lib/scure-base --alias:@scure/bip32=./lib/scure-bip32 \
  --alias:@scure/bip39=./lib/scure-bip39 --outfile=pearl-bundle.js
```

Run the verification suite:

```bash
node --no-warnings --loader ./tests/loader.mjs ./tests/verify.mjs
```

The suite cross-checks against the Pearlscriptions indexer's own parser
(`extractTaprootInscriptionsFromRawTxHex`), `prl20-core`'s PRL-20 validator, the
indexer's mint-fee matcher, and pearlpurse's audited BIP-86 derivation when those
checkouts are present; otherwise those sections are skipped.

## Settings

- **Network**: mainnet (`prl`) or testnet (`tprl`). Mainnet default Blockbook is
  `https://blockbook.pearlresearch.ai` (verified live). There is no verified public
  testnet Blockbook — testnet users must supply their own endpoint.
- **Indexer URL**: your Pearlscriptions indexer API base URL (token directory only).
- Settings persist in `localStorage`; secrets never do.

## Security

- Private keys and mnemonics never leave the page and are never stored.
  Reloading wipes the wallet from memory.
- Building signs locally; broadcasting is always a separate explicit click per
  transaction, with the amounts shown before you confirm.
- The app makes no network calls except the Blockbook/indexer reads and
  broadcasts you trigger.

## Donations

`prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`

Built by [@kshot9000](https://x.com/kshot9000) for the Pearl community.
