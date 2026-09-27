# Pearl Pay — PRL Payment Toolkit

Accept Pearl (PRL) on any website. Payment buttons, shareable invoices, a
dependency-free merchant SDK, and a WooCommerce gateway plugin. Every invoice
gets a **fresh BIP-86 Taproot address** derived from your account xpub — your
keys never leave your wallet, and this page never sees them. Payments are
verified live against Blockbook.

**Live:** https://kshot3000.github.io/Pearl-Muse-24-7-Ai-builder/pages/pay/

No build step, no server. Open `index.html` directly (`file://`) or serve the
directory; it works as-is on GitHub Pages.

## 5-minute quickstart

1. Open the toolkit and go to **Merchant settings**.
2. Paste your **account xpub** (`m/86'/808276'/0'` on mainnet) and your
   Blockbook URL (default `https://blockbook.pearlresearch.ai`).
3. Go to **Invoices**, enter an amount (PRL or USD with live/manual rate),
   label, and expiry. The toolkit derives a **fresh address** (gap-limit aware)
   and gives you a shareable invoice link + QR.
4. Send the customer the link (`invoice.html?inv=<code>`). They scan, send the
   exact PRL amount, and watch states progress:
   `awaiting → partial → detected → confirmed` (or `expired`).
5. Only treat goods as shipped on **confirmed** with your required
   confirmations.

**Demo mode:** append `&demo=1` to any invoice link to simulate the full
payment flow with no chain activity.

## Payment button embed

Drop the SDK on any page — one `<script>` tag, no bundler:

```html
<script src="https://kshot3000.github.io/Pearl-Muse-24-7-Ai-builder/pages/pay/pearl-pay.js"></script>
<script>
  PearlPay.createButton(document.getElementById('pay'), {
    address: 'prl1p…',          // derive a FRESH address per order (see below)
    grains: '150000000',        // 1.5 PRL in grains (integer string)
    label: 'Order #123',
    blockbook: 'https://blockbook.pearlresearch.ai',
    expiryMinutes: 60,
    requiredConfirmations: 2,
    onState: (state, detail) => console.log(state, detail),
  });
</script>
```

The SDK also exposes `PearlPay.openCheckout`, `PearlPay.watchPayment`,
`PearlPay.drawQrCanvas`, `PearlPay.usdToGrains`, `PearlPay.formatPRL`, and
`PearlPay.classifyPayment` — all dependency-free, all in `pearl-pay.js`.

## Invoice links

Invoices are self-contained base64url codes — no database needed:

```
invoice.html?inv=<code>          # live invoice (QR, countdown, Blockbook polling)
invoice.html?inv=<code>&demo=1   # simulated payment, no chain activity
```

The code carries network, amount (grains), label, expiry, confirmations, and
either the merchant xpub + derivation index or a fixed address.

## xpub security notes (read before mainnet use)

- An **xpub is public data**: anyone who sees it can see all your invoice
  addresses. It can **never spend** funds. Still, keep your **seed offline**
  regardless — the xpub alone is enough to watch your income.
- **Derive a fresh address per invoice** (BIP-86 external chain). Never reuse
  one address across customers.
- Treat `detected` (0-conf) as "seen on the network" — fine for coffee, not
  for cars. **Require N confirmations before shipping goods** (the toolkit and
  the WooCommerce plugin both enforce your setting server-side/UI-side).
- Verify the Blockbook URL you configure; a malicious endpoint could lie
  about payments. `https://blockbook.pearlresearch.ai` is the default.
- The toolkit stores settings in `localStorage` (xpub, not keys). Anyone with
  your browser profile can see your xpub — that is expected, it is public.

## WooCommerce plugin

`woocommerce/pearl-gateway-for-woocommerce/` is a real installable plugin:

1. Zip the folder (or upload it) via **Plugins → Add New → Upload**, activate.
2. **WooCommerce → Settings → Payments** → enable **Pearl (PRL)**.
3. Paste pre-generated Taproot addresses (one per line) into **Address pool** —
   each order consumes the next address. Generate them with any BIP-86 wallet;
   keys never touch WordPress.
4. Set the PRL rate, required confirmations (2 recommended), and payment
   window. Orders go on-hold at checkout; the thank-you page shows QR + live
   states; the order completes only after **server-side** Blockbook
   confirmation (AJAX check + 5-minute cron sweep).

## Files

| File | Purpose |
|---|---|
| `index.html` / `styles.css` / `pay.css` / `app.js` | The toolkit UI (classic scripts, no modules) |
| `invoice.html` / `invoice.js` | Standalone invoice payment page |
| `pearl-pay-core.bundle.js` | Browser bundle of the crypto core (`window.PearlPayCore`), built with esbuild — committed so users never build |
| `pearl-pay-core.js` | ESM source of the core (bech32m, BIP-86, invoices, Blockbook) |
| `pearl-pay.js` | Dependency-free merchant SDK (`window.PearlPay`), hand-written IIFE — include with one script tag |
| `build.mjs` | Rebuilds `pearl-pay-core.bundle.js` (`node build.mjs`; needs esbuild) |
| `lib/` | Vendored ESM deps (`@scure/*`, `@noble/*`) for the source + tests |
| `importmap.json` | Import map for the ESM source (used by `tests/`) |
| `woocommerce/` | Installable WooCommerce gateway plugin (bundles `pearl-pay.js`) |
| `tests/verify.mjs` / `tests/verify-sdk.mjs` | 82-check verification suite |

## Verification

```sh
node --no-warnings --loader ./tests/loader.mjs ./tests/verify.mjs      # 63 checks
node --no-warnings --loader ./tests/loader.mjs ./tests/verify-sdk.mjs   # 19 checks
```

The suite cross-checks BIP-86 derivation against the audited `pearlpurse`
implementation, round-trips invoice encode/decode, validates exact QR payloads
against the vendored reference encoder, and drives the payment state machine
with mocked Blockbook responses.

---

Support Pearl development: `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d` · [@kshot9000](https://x.com/kshot9000)
