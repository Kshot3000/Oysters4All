# Pearl Paywall — put your content behind PRL

A content-paywall desk for Pearl (PRL) with **no accounts, no Stripe, no server**.
Creators seal a tamper-evident paywall descriptor, buyers pay the exact PRL price
on-chain, and buyers mint a Schnorr-signed access token with the funding key —
bound to that paywall and that payment only. Anyone can verify payment +
signature against public Blockbook data, or creators can paste a
dependency-free snippet on their own site.

Five steps: **Create → Pay → Token → Verify → Snippet**.

## The descriptor

```
pearl-paywall:v1:<hrp>:<hash>
```

`hash` = SHA-256 over the canonical paywall JSON (title, grain-exact price,
receiving P2TR address, deliverable description, expiry, network). Post the
descriptor *before* anyone pays; anyone can recompute it from the paywall JSON.
The Verify tab answers **PROVEN** or a loud **NOT PROVEN**.

## The access token

```json
{
  "v": 1,
  "descriptor": "pearl-paywall:v1:prl:…",
  "txid": "…paying txid…",
  "pubkey": "…x-only hex…",
  "sig": "…BIP-340 hex…"
}
```

`sig` signs `SHA-256("PearlPaywallToken/v1\n" + descriptor + "\n" + pubkeyHex +
"\n" + txid)` with the **tweaked keypath private key** of a funding input — so
the token pubkey equals the P2TR program of the input that funded the payment.
The desk **refuses loudly** (`KEY REFUSED`) unless the entered key controls a
P2TR input address of the paying txid. Keys live in memory only and are wiped
after every attempt.

## Crypto lineage — no new cryptography

- BIP-340 sign/verify, bech32m, SHA-256, and BIP-86 wallets are the audited
  Sign-core lineage (`../sign/src/crypto.js`, `../sign/src/sign-core.js`).
- The embed snippet carries three **mechanical minimizations**
  (`src/snippet-crypto.js`: sha256, bech32m decode, BIP-340 verify), inlined
  into the snippet text verbatim via `fn.toString()`. The test suite
  differentially checks all three against the audited implementations on
  randomized inputs plus pinned vectors, and asserts the snippet inlines them
  byte-identical.
- The desk itself always uses the audited noble implementations; the snippet
  path is the clearly-labeled, heavily-tested fallback for third-party pages.

## Honest limits (also shown on the page, always true)

- The embed snippet is **snippet-level protection** (view-source can find the
  hidden markup) — strong for soft/manual delivery (email lists, download-link
  rotation, community access), **not DRM**.
- Keep the snippet config as private as the use allows; Blockbook is a
  third-party read source.
- Buyers must control the funding key. A token is a backstage pass — it can be
  photocopied, so bind delivery to the buyer where it matters.
- Descriptors are commitments, not signatures: they prove what the paywall
  promised, not who promised it.
- The page never moves real PRL and never broadcasts anything.

## Run the tests

```bash
cd pages/paywall
node --no-warnings --loader ./tests/loader.mjs --test ./tests/paywall-core.test.mjs
node --no-warnings --loader ./tests/loader.mjs --test ./tests/dom.test.mjs
node build.mjs   # rebuild pearl-paywall.bundle.js after touching src/
```

## Files

- `index.html`, `styles.css`, `app.js` — the desk (velvet-rope backstage theme:
  deep plum/oxblood + gold foil, tabular numerals)
- `src/paywall-core.js` — pure-ESM core (node runs this directly in tests)
- `src/snippet-crypto.js` — the three dependency-free primitives inlined into
  the embed snippet
- `src/index.js` — `window.PearlPaywall` browser entry (plain IIFE, no `globalName`)
- `pearl-paywall.bundle.js` — committed esbuild bundle (`?v=1`)
- `qrcode.min.js` — vendored QR library (`?v=1`)
- `build.mjs` — esbuild with the sign importmap plugin
- `tests/` — core (17) + DOM (10) suites
