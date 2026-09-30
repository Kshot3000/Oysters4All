# Pearl Oracle — Signed Price-Feed Ticker Desk

Mint an oracle key, publish BIP-340 Schnorr-signed price attestations in a
local hash chain, and verify anyone's feed — authorship is proven, truth is
self-reported. The page never moves PRL and never broadcasts anything.

Live: `pages/oracle/` (GitHub Pages) · Theme: **signal-beacon** (deep violet + signal amber)

## How it works

**Tabs: Identity → Publish → Feed → Verify**, plus an always-visible
**Honest Limits** panel.

1. **Identity** — generate a fresh 12-word BIP-86 oracle key, or import an
   existing one (mnemonic 12/24, WIF, or hex private key — auto-detected,
   same as the Sign desk). The oracle's identity is the **tweaked keypath
   x-only pubkey** — the same key that controls its `prl1…` address
   (Ballot-desk construction). Keys live in page memory only; a wipe
   button clears them.
2. **Publish** — compose an attestation: asset pair (`PRL/USD`, `PRL/BTC`,
   `PRL/ETH`, or custom text), price as an **integer in minor units** with
   a decimals field (`"41250"` + `"2"` = $412.50 — floats never touch the
   wire), unix timestamp (defaults to now), strictly increasing sequence
   (defaults to last local seq + 1), 16-byte CSPRNG nonce (hex), `prev` =
   SHA-256 of the previous attestation's canonical bytes (genesis = 64
   zeros), and a required free-text **source** label naming where the
   price came from. The canonical preview shows the exact bytes that get
   hashed and signed. Signing happens locally; the signed attestation is
   appended to the local hash-chained feed in `localStorage`.
3. **Feed** — the local chain: per-row VALID badges, a per-asset price
   chart on canvas, copy/download, CSV + JSON export, row deletion, and a
   **whole-chain tamper check** (every signature re-verified, every prev
   link checked, seq strictly increasing, genesis prev = 64 zeros). Paste
   or drop a file to import and audit *someone else's* oracle feed —
   every imported row must verify or the whole import is refused.
4. **Verify** — standalone verifier: paste any signed attestation and get
   a VALID / VALID ⚠ / INVALID verdict with per-check rows. No key needed,
   no network, no trust.

## The attestation format

Unsigned canonical JSON (fixed key order — hand-built, never
`JSON.stringify` of a reordered object):

```json
{"p":"prl-oracle","v":1,"asset":"PRL/USD","price":"41250","decimals":"2","ts":"1727695200","seq":"7","nonce":"…32 hex…","prev":"…64 hex…","source":"CoinGecko spot"}
```

- **Attestation id** = SHA-256 of the canonical bytes (lowercase hex).
- **Signature** = BIP-340 Schnorr over the id, made with the **tweaked
  keypath private key** (`tweakPrivKeypath`), verifiable against the
  oracle's x-only pubkey — the same audited construction the
  Solvency/Ballot desks use. The signer re-verifies against the tweaked
  pubkey before returning: a wrong-key sign is a loud refusal, not a
  silent bad signature.
- The signed envelope appends `"pub"` (x-only hex) and `"sig"` (64-byte
  hex) after `"source"`. `prev` commits to the previous attestation's
  **id** (= hash of its canonical bytes).

Field rules (enforced at sign time, re-checked by every verifier):

| field | rule |
|---|---|
| `p` / `v` | exactly `"prl-oracle"` / `1` |
| `asset` | 1–64 chars: letters, digits, space, `_ - . /` |
| `price`, `decimals`, `ts`, `seq` | **strings** of canonical non-negative integers (`/^(0\|[1-9][0-9]*)$/`) — floats, negatives, leading zeros refused |
| `nonce` | 32 lowercase hex (16 CSPRNG bytes) |
| `prev` | 64 lowercase hex (genesis = 64 zeros) |
| `source` | 1–200 chars, no control chars |
| `pub` | 64 hex, must lift to a secp256k1 point |
| `sig` | 128 hex |
| unknown fields | rejected, loudly |

The verifier additionally warns (never fails) when `ts` is more than
±24h from now — timestamps are asserted by the keyholder, not proven.

## Crypto lineage

**No new cryptography.** Every primitive comes from the audited
`../sign/src/crypto.js` (itself a reimplementation of the pearlpurse
wallet core, verified byte-for-byte against Pearl's Go reference):

- `sha256`, `schnorr` (BIP-340), `bytesToHex`/`hexToBytes`
- `newMnemonic`, `walletFromMnemonic`, `walletFromWIF`, `walletFromPriv`, `walletToWIF` (BIP-86)
- `tweakKeypath`, `tweakPrivKeypath` (BIP-341 keypath tweak)

`oracle-core.js` adds only encoding, validation, chaining, and
import/export logic on top. The ESM sources bundle via `node build.mjs`
(esbuild) into the committed `pearl-oracle.bundle.js` IIFE
(`window.PearlOracle`) so the page works from `file://` and GitHub Pages
with zero build step.

## Honest limits

A signature proves **authorship**, not truth — prices are self-reported
by whoever holds the key, and anyone can mint an oracle key. The feed is
local-only (no listing relay, no shared network); replay is stopped only
inside a chain a consumer chooses to trust; timestamps are asserted, not
proven. This page never moves PRL and never broadcasts anything.

## Tests

```sh
node --no-warnings --loader ./tests/loader.mjs --test tests/oracle.test.mjs  # 38/38
node --no-warnings --loader ./tests/loader.mjs --test tests/dom.test.mjs      # 15/15
```

Core tests cover: canonical determinism (key-order independence),
sign→verify round trip, BIP-340-over-id property, tweaked-keypath
construction parity with Ballot, wrong-key loud refusal, tampered
price/source/sig/pub → INVALID, field-rule edge cases (float price,
leading zeros, bad nonce, empty/overlong source, unknown field,
malformed JSON, bad pub, bad prev, asset rules), ±24h ts warnings,
chain verification (valid chain, broken link, forked prev, seq
regression, bad genesis), key auto-detect (hex/WIF/12/24-word),
BigInt chart scaling, float-free `formatPrice`, and export/import round
trips. DOM tests drive the real page (bundle + app.js) in a VM:
identity → publish → chained second tick → feed tamper check →
import (good + tampered) → verify (good/tampered/malformed/unknown-field/
future-ts) → footer-attribution checks.

Real-browser QA: `hidden_files/qa-oracle-browser.mjs` (headless Chromium
152, file:// + CDP, zero console/page errors required) — bookkeeping,
not committed.

---
Built by [@kshot9000](https://x.com/kshot9000) · PRL tips: `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`
