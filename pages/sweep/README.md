# Pearl Sweep — UTXO Consolidation Optimizer

The tidal refinery: analyze a Pearl Taproot address's UTXO health, plan a
dust/uneconomic-UTXO consolidation with grain-exact fee math, sign it locally,
track the consolidation, and prove the sweep worked.

**Live:** https://kshot3000.github.io/Pearl-Muse-24-7-Ai-builder/pages/sweep/

## The five steps

1. **Analyze** — paste a `prl1…`/`tprl1…` address (bech32m-validated, network
   auto-detected) or watch one. GET-only Blockbook reads fetch the UTXO set;
   the dashboard shows total balance, UTXO count, a value-distribution
   histogram, and each UTXO classified as **dust** (< 546 grains), **uneconomic**
   (spending it alone costs more than it's worth at your fee rate), or
   **healthy** — plus a "consolidation saves you" estimate per future spend.
2. **Plan** — three strategies: sweep only uneconomic UTXOs, sweep everything
   under a threshold you set, or consolidate everything into 1–16 outputs.
   Fee math is exact: audited P2TR keypath vBytes (58/input, 43/output),
   your fee rate, dust-output refusal, and a **breakeven guard that loudly
   refuses** any plan whose fee eats the recovered value — with the math shown.
   Inputs can be deselected one by one; output target defaults to the analyzed
   address or any fresh address you paste.
3. **Sign** — paste the WIF, xprv/tprv, or raw hex key that controls the
   address (in-memory only, wipe button). The page refuses unless the key
   derives *exactly* the analyzed address, then builds the keypath
   consolidation and **re-verifies every Schnorr signature locally** before
   showing the txid + raw hex. Broadcasting is a separate, double-confirmed
   action.
4. **Track** — paste the consolidation txid; the page polls Blockbook
   (GET-only, 15 s) for confirmations, block height, and the exact fee paid.
5. **Verify** — re-scan the address and prove the sweep: UTXO count must drop
   and the balance must equal the pre-sweep total minus the exact fee. A
   standalone verifier also checks any pasted txid: every input from the swept
   address, every output to the target, fee recomputed.

## Cryptography

No new cryptography. Address validation (bech32m), key handling
(`walletFromPriv`/`walletFromWIF`), BIP-341 keypath sighash, Schnorr signing,
and wire serialization all come from the audited Pearl Sign core
(`../sign/src/crypto.js` + `../sign/src/sign-core.js` — `buildKeypathTxEx` +
`verifySignedTx`, the same pair Pearl Rain uses). The xprv entry only
base58check-decodes the extended key and uses its 32-byte secret directly —
no new derivation. All value math is grain-exact `BigInt`; fee rates are
fixed-point milliGrains/vByte.

## Honest limits

- The page can only spend what the pasted key controls; a key/address
  mismatch is a loud refusal, not a warning.
- Consolidation is final once broadcast — check the txid, outputs, and fee
  on the Sign step before confirming.
- "Uneconomic" is computed against the fee rate you set; raise the rate and
  more UTXOs count as uneconomic.
- Blockbook is a third-party read source; balances and fee estimates come
  from the endpoint you configure.
- **The builder never executed a live mainnet consolidation.** All signing
  and broadcast paths were exercised in tests and in headless-Chromium QA
  against stubbed Blockbook responses; no real funds were moved.

## Tests

- `node --no-warnings --loader ./tests/loader.mjs tests/sweep.test.mjs` — 19 core tests
- `node --no-warnings --loader ./tests/loader.mjs tests/dom.test.mjs` — 10 DOM tests (real index.html + committed bundle + app.js in a DOM shim, stubbed Blockbook)
- Real-browser QA: `hidden_files/qa-sweep-browser.mjs` (not committed) — 25 checks green in headless Chromium 152 via file:// + CDP, zero console/page errors
- Rebuild the bundle after touching `src/`: `node build.mjs`

Built by the Pearl 24/7 builder · [@kshot9000](https://x.com/kshot9000) ·
donations: `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`
