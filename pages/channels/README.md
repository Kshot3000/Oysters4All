# Pearl Channels — Off-Chain PRL Payment Channels

**Live:** https://kshot3000.github.io/Pearl-Muse-24-7-Ai-builder/pages/channels/
**By [@kshot9000](https://x.com/kshot9000)** · PRL tips: `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`

Two parties lock PRL into a 2-of-2 Taproot output and exchange **signed commitment
transactions off-chain**. Each payment is a new state; the old state is revoked with
revocation secrets. Close cooperatively (immediate) or unilaterally (CSV-delayed
self-claim). No smart contracts — pure Taproot script, exactly the Lightning model,
adapted to Pearl's `prl1` bech32m rails.

## The six steps

1. **Open** — enter your key + peer key + capacities + CSV delay → channel address,
   descriptor, 64-bit fingerprint.
2. **Fund** — scan UTXOs via Blockbook (GET-only) or paste them; build + sign the
   funding tx, broadcast with double-confirmation (or mark funded manually).
3. **State** — propose a payment, sign both commitment copies, export/import state
   bundles with your peer, assemble both fully-signed commitments, activate the new
   state and revoke the old one (reveal secrets both ways).
4. **Close** — cooperative close (both signatures, immediate) or unilateral close
   (broadcast your commitment, claim after the CSV delay).
5. **Track** — GET-only Blockbook reads: funding confirmations, address activity,
   active state, claim status.
6. **Verify** — standalone verifier: descriptor re-derivation + full signed-tx
   verification with PROVEN / NOT PROVEN verdicts. No keys needed.

## Honest limits (shown on the page)

- No routing, no multi-hop, no invoices — one channel, one peer, fixed capacity.
- State exchange is manual (export/import JSON bundles).
- This page is **not a watchtower** — if you go offline, a peer can broadcast a
  revoked state. Use Pearl Watch for monitoring.
- Unilateral-close fees are fixed at signing; if chain fees spike, closing can get
  expensive.
- Broadcasting a revoked state lets your peer take your whole `to_local` output.

## Security model

- Keys live in memory only and are wiped after each signing operation
  (`beforeunload` wipes too). Descriptors and non-secret state persist in
  `localStorage` — never keys.
- Every signature is verified against the correct party key **before** a
  transaction is assembled.
- Descriptors re-derive byte-for-byte from the keys; tampered bundles are refused.
- Broadcast actions require double confirmation.

## Files

- `index.html` — the six-step wizard
- `styles.css` — switchboard theme (dark harbor navy, signal cyan, copper)
- `app.js` — UI logic (classic script, no build step)
- `pearl-channels.bundle.js` — built from `src/` via `node build.mjs` (esbuild)
- `src/channels-core.js` — channel cryptography: NUMS funding output, commitment
  pairs, revocation/penalty leaves, cooperative close, CSV claims, state bundles
- `tests/channels.test.mjs` — 16 core crypto tests (run with node)
- `tests/dom.test.mjs` — headless-Chromium UI tests

## Tests

```sh
node --test tests/channels.test.mjs        # core, 16/16
node tests/dom.test.mjs                    # UI in headless Chromium
node build.mjs                             # rebuild the bundle after src changes
```
