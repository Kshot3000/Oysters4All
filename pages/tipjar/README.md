# Pearl Tipjar — PRL Donation Widget Generator

The tip-jar forge: configure an embeddable PRL tip jar (recipient address,
title, 1–4 amount presets, optional PRL goal, visual theme), preview it live,
and copy one self-contained snippet onto your own website. The widget does
GET-only Blockbook polling of the address and renders an animated glass jar
that fills with glowing grains as tips arrive, confetti bursts on new tips, a
recent-tips feed, goal progress, and a `pearl:` payment URI + QR for the
active preset amount. The generator page also has a **Listen mode** — watch
any configured address live with jar animation, tip feed, totals, goal
progress, and CSV export.

## How it works

- **Wizard** — recipient `prl1…`/`tprl1…` address (validated bech32m,
  witness v1, 32-byte program via the audited Pearl Sign core — no new
  crypto), title, presets, goal, one of 3 themes, poll cadence, Blockbook URL.
- **Live preview** — the real widget mounts immediately and starts polling;
  the preview and the snippet share byte-identical runtime logic (serialized
  from the bundle).
- **Snippet** — a single copy-paste block: mount `<div>`, jar config as an
  `application/json` block (with pre-rendered QR SVG art per preset), and the
  inline widget script. No external JS/CSS — only the configured Blockbook
  base URL is fetched at runtime. Verified working when pasted into a blank
  HTML file.
- **Tamper-evident descriptor** — `tipjar:v1:<hrp>:<sha256(canonical config
  JSON)>`. The standalone verifier re-canonicalizes and re-hashes; any
  alteration is **loudly refused**.
- **Listen mode** — start/stop live watching of the current jar config, CSV
  export of detected tips (`txid,received_grains,received_prl,confirmations`).

## Themes

- **Harbor Lantern** — amber glass glow
- **Deep Abyss** — indigo / teal bioluminescence
- **Ember Forge** — crimson / charcoal sparks

## Honest limits

- **Read-only, always.** The widget and this page issue GET-only Blockbook
  reads. Neither can move funds, sign, or broadcast — tipping happens in the
  visitor's own wallet via the `pearl:` URI / QR.
- **Tips count at 1+ confirmations.** Unconfirmed mempool transactions are not
  shown as tips.
- **Dust is not a tip.** Outputs below 1,000 grains (0.00001 PRL) are
  ignored — they're uneconomical to ever spend and would let anyone spam the
  jar feed for free.
- **Polling cadence** defaults to 30s, configurable 15–300s. The widget
  pauses while the tab is hidden.
- **No background notifications** — polling stops when the tab/page closes.
- **New-tip detection is per page load** (seen txids tracked in page
  memory). The first successful poll is a silent baseline (history shown, no
  confetti); only later tips burst.
- **Descriptor ≠ signature** — it proves the config wasn't altered after
  forging, not who forged it.

## Files

- `index.html` / `styles.css` / `app.js` — the generator page (loads
  `pearl-tipjar.bundle.js?v=1` + `qrcode.min.js?v=1` + `app.js?v=1`)
- `src/tipjar-core.js` — pure logic + the serialized widget runtime
  (`WIDGET_RUNTIME`) + snippet builder (node-testable)
- `src/index.js` — bundle entry (re-exports the core as `window.PearlTipjar`)
- `tests/tipjar.test.mjs` + `tests/loader.mjs` — verification suite
- `qrcode.min.js` — vendored QR lib (copied from the Pay app; used only by
  the generator to pre-render QR art into snippets)
- `pearl-tipjar.bundle.js` — committed esbuild IIFE bundle (rebuild with
  `node build.mjs`)

## Verify

```sh
cd pages/tipjar
node --no-warnings --loader ./tests/loader.mjs tests/tipjar.test.mjs  # 20/20
node build.mjs  # rebuild the bundle
```
