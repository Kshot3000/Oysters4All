# Pearl Burn — Provable-burn desk for PRL

Burn PRL to a provably-unspendable Taproot address, plan the exact unsigned
burn transaction, seal a tamper-evident burn certificate, and verify past
burns — on the certificate math alone (offline) or against Blockbook
(GET-only) for on-chain confirmation.

Live: `https://kshot3000.github.io/Oysters4All/pages/burn/`

## How a burn is provable

The burn internal key is NUMS-derived from a **public tag**:

```
internalKey = lift_x(SHA-256("PearlBurnNUMS/v1:" || tag))   (256-counter lift loop)
outputKey   = internalKey + TapTweak(internalKey)            (standard P2TR tweak)
address     = bech32m(hrp, 0x01, outputKey)
```

Because the internal key is a hash of public data, nobody knows its discrete
log — and the TapTweak adds only a public hash commitment, so the tweaked
output key is equally unspendable. **There is no private key to know, lose,
or leak.** Anyone can recompute tag → address and confirm it. The same tag
always yields the same address, which is what makes the burn verifiable.

## The four steps

1. **Generate** — enter a tag (cause, date, meme), get the burn address with
   its NUMS internal key, tweaked output key, TapTweak scalar, and a QR code.
2. **Plan** — enter the PRL amount, a funding UTXO (txid/vout/value), your
   P2TR change address, and a fee rate. The desk builds the **exact unsigned
   tx**: one P2TR burn output + one P2TR change output, real vByte fee math
   (154 vB for 2 outputs / 111 vB for 1 output — one P2TR keypath input).
   Burn outputs below the 546-grain dust floor are refused; a dust-valued
   change is refused loudly (sweep it into the burn instead). The unsigned
   hex is re-verified by decoding it before display.
3. **Certify** — seal a `pearl-burn:v1:<hrp>:<sha256>` certificate binding
   tag → address → amount → txid (`pending` until broadcast; re-seal with
   the real txid after confirmation).
4. **Verify** — paste any certificate for an offline PROVEN / NOT PROVEN
   verdict (every field recomputed; any tamper flips the verdict), or look
   up a txid on Blockbook (GET-only) to confirm the output value, address,
   block height and timestamp.

## Honest limits

- **Burns are irreversible.** Coins sent to a burn address can never be
  spent by anyone. That is the point — verify before you broadcast.
- **This page never holds your keys, never signs, never broadcasts.** The
  planner emits unsigned hex from a UTXO you paste; you sign in your own
  wallet and broadcast yourself.
- **A "pending" certificate proves the math, not the burn.** PROVEN means
  the seal recomputes and the address derives from the tag. Only a
  confirmed on-chain output proves coins actually burned.
- **On-chain confirmation needs a live Blockbook endpoint.** If the
  endpoint is down, certificate math still verifies offline; chain state
  is reported as unknown, never assumed.
- Burn/change addresses must be P2TR (`prl1p…` / `tprl1p…`) on the
  selected network.

## Crypto lineage

No new cryptography is invented. Key lifting, TapTweak, bech32m, SHA-256,
tx serialization helpers and the Blockbook GET helpers come from the
audited `pages/sign/src/crypto.js`; P2TR address parsing from the audited
`pages/escrow/src/escrow-core.js`; raw-tx decoding from
`pages/sign/src/sign-core.js`. The NUMS construction mirrors the audited
escrow/will derivations with a new domain — `PearlBurnNUMS/v1` — provably
distinct from `PearlEscrowNUMS/v1` and `PearlWillNUMS/v1` (asserted by test).

## Layout

- `index.html` / `styles.css` / `app.js` — the page (ember/ash volcanic theme)
- `src/burn-core.js` — pure-ESM core (node runs it directly for tests)
- `src/index.js` — browser entry (`window.PearlBurn`, explicit assignment)
- `pearl-burn.bundle.js` — committed esbuild IIFE bundle (built via `node build.mjs`)
- `qrcode.min.js` — vendored QR library (same copy as Pearl Will)
- `tests/burn.test.mjs` — 16 core tests (pinned vectors, tamper regressions, domain separation, exact fee math)
- `tests/dom.test.mjs` — 7 DOM/bundle tests (shipped bundle == tested core, HTML wiring, cache keys, attribution)
- `tests/loader.mjs` — node ESM loader shim (shared pattern)

Tests: `node --no-warnings --loader ./tests/loader.mjs --test tests/burn.test.mjs tests/dom.test.mjs`

## Attribution

Built by [@kshot9000](https://x.com/kshot9000) for the Pearl blockchain.
Tips: `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`
