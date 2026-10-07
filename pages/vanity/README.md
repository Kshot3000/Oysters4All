# Pearl Vanity — Forge Your Own `prl1p…` Address

Grind a custom Pearl Taproot vanity address entirely in your browser. Pick a
prefix, light the forge across up to 8 CPU threads (Web Workers), and claim a
real keypair whose address opens with `prl1p` + your prefix. Keys never leave
the page.

Live: https://kshot3000.github.io/Oysters4All/pages/vanity/

## The model

A vanity address **is** the x-only public key:

```
address = bech32m(hrp, v1, xonly(priv))
```

No TapTweak, no script tree. The 32-byte secret signs keypath Schnorr spends
directly (the standard vanity model, cf. Bitcoin vanity P2PKH). Whoever holds
the secret controls the coins — full stop. The claim screen proves it with a
live Schnorr sign/verify round-trip against the found address.

## Two key sources

- **Fresh random key** (default): every attempt draws a new secret from
  `crypto.getRandomValues`. The found key exists nowhere else — back it up or
  lose the coins.
- **From my seed (BIP-86)**: grind inside your own wallet. Attempts walk
  `m/86'/coinType'/account'/0/index` derived from your BIP-39 mnemonic
  (validated in-page; only the 64-byte seed crosses into the workers, never
  the words). The found key is recoverable from seed + account + index, which
  the result panel reports. The hardened prefix `m/86'/coin'/account'` is
  derived once per worker; per-attempt child derivation is non-hardened and
  cheap.

## The math (shown live in the forge)

Expected attempts for an *n*-character prefix: **32ⁿ**. Measured ~1.4k
addresses/sec per core in this container's JS engine (your browser will
differ — the grind screen shows your live rate):

| prefix | expected attempts | feel |
|---|---|---|
| 1 | 32 | instant |
| 2 | 1,024 | seconds |
| 3 | 32,768 | under a minute on a few threads |
| 4 | ~1M | minutes — grab coffee |
| 5 | ~33.5M | overnight job |

Prefixes are capped at 5 characters: beyond that is not a browser job, and
the page says so instead of pretending. The grind screen shows attempts,
live rate, elapsed time, expected attempts, your luck so far
(`1 − e^(−k/32ⁿ)`), and ETA at your measured rate.

## Integrity

- Every found key is **re-derived from the secret and re-matched against
  the prefix** before anything is displayed (`verifyFound`); a mismatch is a
  loud failure, never a silent display.
- `randomScalar` rejects zero and ≥ curve-order draws.
- WIF export wraps the *raw* spend secret (no tweak) — round-trip tested.
- Bech32 input is strict: only `qpzry9x8gf2tvdw0s3jn54khce6mua7l`, with
  specific errors for `1` (the separator) and `b`/`i`/`o` (excluded
  look-alikes).

## Files

| File | What |
|---|---|
| `index.html` | Forge → Grind → Claim wizard |
| `styles.css` | Forge/ember theme |
| `app.js` | Page wiring: worker pool, stats, claim, export |
| `pearl-vanity.bundle.js` | Built page bundle (`window.PearlVanity`), embeds the worker source |
| `pearl-vanity-grind.bundle.js` | Built grind core (`window.PearlVanityGrind`) |
| `grind-worker.js` | Standalone worker script (grind bundle + driver) |
| `qrcode.min.js` | QR rendering (vendored) |
| `src/vanity-core.js` | Pure logic: prefix validation, difficulty math, key gen, grind loop |
| `src/grind-entry.js`, `src/index.js` | Bundle entry points |
| `src/worker-driver.js` | Classic-worker driver (cooperative, `setTimeout(0)` yields) |
| `src/worker-src.js` | Generated: worker source embedded as a string |
| `build.mjs` | `node build.mjs` rebuilds all bundles (esbuild via `~/workspace/.build-tools`) |
| `tests/vanity.test.mjs` | 11 core tests (node) |
| `tests/dom.test.mjs` | 5 DOM integration tests (fake Blob-URL worker, real crypto) |
| `tests/loader.mjs` | ESM loader mapping bare `@…` imports to `../sign/lib/` |

Crypto lineage: secp256k1, bech32m, WIF, and BIP-86 derivation reuse the
audited Pearl Sign core (`../sign/src/crypto.js`), verified byte-for-byte
against Pearl's Go reference. No new cryptography here — only
key-generation loops and prefix matching.

## Tests

```bash
node build.mjs   # rebuild bundles
node --no-warnings --loader ./tests/loader.mjs tests/vanity.test.mjs   # 11/11
node --no-warnings --loader ./tests/loader.mjs tests/dom.test.mjs       # 5/5
```

Real-browser QA (headless Chromium, `file://` + CDP): 24/24 green —
invalid-prefix rejection (`b`, `1`, empty), difficulty panel, real Blob-URL
workers finding a 1-char prefix, claim integrity re-check, QR, attempts
counter, Schnorr key-control proof + address re-derivation, secret reveal,
export button, BIP-86 seed-box validation, fresh-seed generation, stop
halting an active grind, footer attribution, honest limits, zero
console/page errors.

## Honest limits

- Grinding is pure chance; the forge gets lucky, not smart.
- A vanity address is exactly as secure as a random one — the prefix buys
  memorability, nothing else.
- Browser grinding is slow next to GPU rigs; this forge is for short, fun
  prefixes.
- Send a tiny test amount first and spend it back before trusting the key
  with real funds.

---

Built by the Pearl 24/7 builder · [@kshot9000](https://x.com/kshot9000) ·
Donate PRL: `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`
