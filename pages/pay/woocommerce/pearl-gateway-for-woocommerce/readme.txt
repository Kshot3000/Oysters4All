=== Pearl Gateway for WooCommerce ===
Contributors: Kshot3000
Tags: woocommerce, payment gateway, crypto, pearl, prl
Requires at least: 6.0
Tested up to: 6.8
Requires PHP: 7.4
Stable tag: 1.0.0
License: GPLv3 or later
License URI: https://www.gnu.org/licenses/gpl-3.0.html

Accept Pearl (PRL) in WooCommerce. Fresh Taproot address per order, live Blockbook verification, no custody.

== Description ==

Pearl Gateway adds a **Pearl (PRL)** payment method to WooCommerce checkout.

* Each order is assigned a **fresh Pearl Taproot address** from your pre-generated address pool — customers never reuse addresses.
* The thank-you page shows a **QR code, exact amount, and live payment states** (awaiting → detected → confirmed) powered by the bundled PearlPay JS SDK.
* Orders are marked paid **only by server-side Blockbook checks** (thank-you page AJAX + a 5-minute cron sweep) once your required confirmations are reached.
* **No custody, no server, no keys in WordPress** — you generate addresses offline with any BIP-86 wallet and paste the public addresses into the pool.

Support Pearl development: `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d` · [@kshot9000](https://x.com/kshot9000)

== Installation ==

1. Upload the `pearl-gateway-for-woocommerce` folder to `/wp-content/plugins/` and activate it (or install the zip via Plugins → Add New → Upload).
2. Go to **WooCommerce → Settings → Payments** and enable **Pearl (PRL)**.
3. Generate receive addresses with any BIP-86 Pearl wallet (the [Pearl Pay toolkit](https://kshot3000.github.io/Oysters4All/pages/pay/) can do this) and paste one per line into **Address pool**. Your seed/private keys never leave your wallet.
4. Set the **PRL rate** (manual rate always works; CoinGecko auto mode works for USD stores with manual fallback).
5. Choose **required confirmations** (2 recommended) and the **payment window**.

== Frequently Asked Questions ==

= Do customers need a Pearl wallet? =
Yes — they pay from any Pearl wallet by scanning the QR or copying the address and sending the exact PRL amount.

= Is the address pool safe to paste into WordPress? =
Yes. These are public receive addresses; they can never spend funds. Keep your seed offline as usual.

= What if a customer underpays? =
The order stays on-hold and the UI shows "partial". Top up the same address within the payment window, or the merchant refunds/handles it manually.

= Does it work on testnet? =
Yes — set Network to testnet and use `tprl1p…` addresses plus a testnet Blockbook.

== Changelog ==

= 1.0.0 =
* Initial release: gateway settings, per-order Taproot addresses from a pool, QR + live states on the thank-you page, server-side Blockbook confirmation (AJAX + cron), expiry sweep.
