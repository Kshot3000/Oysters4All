# Pearl Gift — Paper Wallets & Gift Cards for PRL

Create beautiful printable PRL gift cards backed by real BIP-86 paper wallets,
and redeem them with a one-click sweep. All cryptography runs locally in the
browser — keys never leave the page.

Live: https://kshot3000.github.io/Oysters4All/pages/gift/

## Flow

1. **Create** — generate a fresh gift wallet (or import a mnemonic / WIF / raw
   private key), pick one of three card designs, add To/From/Message.
2. **Load** — send PRL to the card's address from any wallet; check confirmed
   funding via Blockbook.
3. **Card** — print the card. Fold along the dashed line: the WIF private key
   hides inside the fold. Print, seal, give.
4. **Redeem** — paste the card's secret, fetch (or paste) its UTXOs, enter your
   address, and sweep every grain in one locally-signed Taproot keypath
   transaction. Signatures are re-verified locally before the hex is shown;
   only the finished transaction is broadcast.

## Builder tip (optional, disclosed)

Redeeming a gift is a sole-signer sweep of funds the card holder controls,
so Pearl Gift offers an **optional 1% builder tip** on the Redeem step —
off by default, never automatic. Tick the box (it names the 1% and the full
builder address) and `builderTipGrainsFor()` computes the tip as its own
output in the plan, before signing: the keypath sighash commits to every
output, so the tip cannot be added or skimmed after signing, and the plan
shows it as its own labeled line. It is waived on testnet and when 1% of
the swept total would fall below the 333-grain dust floor (never rounded
up). With the box off, the plan is identical to the pre-tip planner.
Recipient: `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`
(the same operator address in every Gift footer).

## Crypto lineage (no new cryptography)

- Keys: `walletFromMnemonic` / `walletFromWIF` / `walletFromPriv` from the
  audited Pearl Sign crypto (`../sign/src/crypto.js`), BIP-86
  `m/86'/coin'/1000'/0/0` — account **1000** is this app's convention for gift
  cards, so gift keys never collide with a creator's main wallet.
- Sweep: `buildKeypathTxEx` + `verifySignedTx` from the audited Pearl Sign
  core (`../sign/src/sign-core.js`); SIGHASH_DEFAULT keypath spends with exact
  `keypathTxVBytes` fee math and dust refusal.
- QR codes: vendored `qrcode.min.js` (offline, no CDN).

## Tests

- `tests/gift.test.mjs` — 9/9: gift-account known-answer vectors, WIF/hex
  round-trips, secret parsing, card-payload export/import + tamper detection,
  exact sweep fee math + dust/invalid-recipient refusals, full
  build → sign → verify cycle, tampered-amount rejection, wrong-key ownership
  guard, and the optional builder tip (exactness/waivers, tipped plan +
  signed conservation with the tip output exact on the wire, rerouted-tip
  refusal).
- `tests/dom.test.mjs` — 6/6: boots the committed bundle + real `index.html`
  + `app.js` in a DOM shim and drives create → load → card → redeem, plus
  hostile-`localStorage` fallback, footer-attribution checks, and the builder
  tip (checkbox unchecked by default, opt-in renders the tip line before
  signing, signed tx carries the tip output, opt-out restores the plan).
- Real-browser QA (headless Chromium 152, `file://` + CDP,
  `hidden_files/qa-gift-browser.mjs`): 75/75 checks green — boot/assets/?v=
  keys, step nav, create (fresh + WIF/hex/mnemonic imports, all import error
  paths), QR canvas+SVG rendering, design switch, live card preview, load +
  funding check (confirmed-only balance, unconfirmed/empty/down/404 paths),
  print CSS isolation, full redeem flow (derive → manual UTXOs → exact-fee
  plan → sign → independent signature re-verification → broadcast), footer
  attribution, 390px mobile overflow, zero page errors.

Run: `node build.mjs` (committed bundle), then
`node --no-warnings --loader ./tests/loader.mjs tests/gift.test.mjs` and
`tests/dom.test.mjs`.

## Honest limits

- Funding lookups and broadcast need a reachable Blockbook endpoint; the
  redeem step also works fully air-gapped with manually pasted UTXOs
  (signing stays offline, broadcast later from an online device).
- No real PRL was moved in testing — sweeps were built, signed, and verified
  locally against synthetic UTXOs, never broadcast.
- A paper wallet is a bearer instrument: whoever holds the WIF holds the
  funds. Print on a trusted printer; for maximum security generate offline.

Built by [@kshot9000](https://x.com/kshot9000) · tips: `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`
