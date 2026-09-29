# Pearl Rain — Batch-Send PRL Airdrops

Rain PRL on many addresses in one transaction: a non-custodial batch-send /
airdrop tool for Pearl. Paste a funder key, paste a recipient list, plan the
exact fee, sign locally, broadcast once. All cryptography runs locally in the
browser — keys never leave the page.

Live: https://kshot3000.github.io/Pearl-Muse-24-7-Ai-builder/pages/rain/

## Flow

1. **Funder** — paste the funder secret (mnemonic / WIF / raw private key),
   then fetch its UTXOs from Blockbook or paste them manually for air-gapped
   use. Set the fee rate.
2. **Recipients** — paste one `<address> <amount>` per line (PRL, decimals
   allowed; CSV with commas works too), or import a CSV file. Every address
   is validated as a Pearl v1 Taproot address, every amount must clear the
   546-grain dust floor, and duplicate addresses merge into a single output.
3. **Plan** — exact fee math up front: `keypathTxVBytes(nIn, nOut)` × fee rate.
   Change returns to the funder; dust change is folded into the fee instead of
   creating a dust output. Insufficient funds are refused before anything is
   signed.
4. **Sign & Send** — build and Schnorr-sign the single transaction; every
   input signature is re-verified locally before the hex is exposed. Broadcast
   via Blockbook is an explicit, confirmed action.

## Crypto lineage (no new cryptography)

- Keys: `walletFromMnemonic` / `walletFromWIF` / `walletFromPriv` from the
  audited Pearl Sign crypto (`../sign/src/crypto.js`); mnemonics derive at
  BIP-86 `m/86'/coin'/0'/0/0` — the funder's ordinary wallet account.
- Transaction: `buildKeypathTxEx` + `verifySignedTx` from the audited Pearl
  Sign core (`../sign/src/sign-core.js`); plain SIGHASH_DEFAULT keypath
  spends, one transaction with N recipient outputs + change.
- `parseManualUtxos` keeps the trailing address on pasted UTXO lines so
  `assertUtxosBelong` can refuse foreign coins (mirrors the gift app's local
  parser — sign-core's `parseUtxoList` drops the address).

## Tests

- `tests/rain.test.mjs` — 9/9: funder known-answer vector + secret-form
  round-trips, recipient parsing (formats, units, merge, dust, rejects,
  250-output cap), sample CSV, exact plan fee math with change, dust-change
  absorption, insufficient-funds refusal, manual-UTXO parsing + belong-check,
  full build → sign → verify cycle with on-chain output accounting, wrong-key
  signatures failing verification against the funded UTXOs.
- `tests/dom.test.mjs` — 5/5: boots the committed bundle + real `index.html`
  + `app.js` in a DOM shim and drives funder → recipients → plan → sign
  (manual air-gapped UTXOs), plus hostile-`localStorage` fallback and
  footer-attribution checks.
- Real-browser QA (headless Chromium, `file://` + CDP): 29/29 checks green —
  full funder → recipients → plan → sign → stubbed-broadcast flow, sample CSV
  download, clear-secrets, zero console/page errors. No transaction was
  broadcast in testing.

Run: `node build.mjs` (committed bundle), then
`node --no-warnings --loader ./tests/loader.mjs tests/rain.test.mjs` and
`tests/dom.test.mjs`.

## Honest limits

- Broadcasting moves **real PRL** and cannot be reversed. Max 250 recipients
  per transaction.
- UTXO fetching and broadcast need a reachable Blockbook endpoint you
  configure (mainnet default `https://blockbook.pearlresearch.ai`); the manual
  paste mode works air-gapped until broadcast.
- No real PRL was moved in testing — transactions were built, signed, and
  verified locally against synthetic UTXOs, never broadcast.

Built by [@kshot9000](https://x.com/kshot9000) · tips: `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`
