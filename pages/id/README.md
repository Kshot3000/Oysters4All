# Pearl ID — Sign-in with Pearl

Live: https://kshot3000.github.io/Oysters4All/pages/id/

Pearl has no accounts, usernames, or OAuth — so Pearl ID makes your
**BIP-86 key the account**. A relying party (any site or app) shows you a
domain + challenge; you sign it with a BIP-340 Schnorr signature from the
tweaked keypath key that also controls your `prl1…` address; the site
verifies. Your address is the username. There is no password to phish.

## The ceremony

1. **Keys** — mint or import a BIP-86 identity key (mnemonic / WIF / hex).
   The page shows your `prl1…` address (the username sites see) and the
   tweaked x-only pubkey (the signing identity).
2. **Sign in** — paste the site's domain + challenge (or generate a demo
   one), pick a lifetime, review the big domain confirmation, sign.
   You get a `prl-id` credential JSON with a 64-bit fingerprint.
3. **Verify** — standalone verifier: recomputes the canonical bytes,
   checks the fingerprint, verifies the BIP-340 signature, **recomputes
   the address from the key** (proving the username really is the key),
   checks domain binding + expiry. Rules VALID / VALID-WARN / INVALID
   with per-check rows.
4. **Integrate** — the 4-step relying-party protocol plus copy-paste
   verifier and issuer snippets.

## Protocol (`prl-id` v1)

Signed fields (canonical JSON, fixed order): `protocol`, `version`,
`domain`, `address`, `xonly`, `challenge`, `issued_at`, `expires_at`.
The credential id is SHA-256 of the canonical bytes; the id is signed
with the **tweaked keypath private key** — the same key that controls
the identity's PRL address, so one signature proves key control *and*
address ownership. Challenges must be ≥128-bit random, single-use,
short-lived (default demo lifetime: 5 minutes; max: 7 days).

## Honest limits

- A signature proves **control of a key** — not identity, trust, or humanity.
- A credential **replays until it expires**. Single-use challenges and
  short expiries are the relying party's job; the math can't enforce them.
- Read the domain line before signing. Signing moves no PRL and
  broadcasts nothing — but never sign a challenge from a site you don't trust.
- Keys live in page memory only; wipe on shared machines.
- The page never moves PRL, never broadcasts, never leaves the browser.

## Crypto

No new cryptography. Every primitive (SHA-256, BIP-340 Schnorr, BIP-86
derivation, BIP-341 keypath tweak, bech32m) is imported from the audited
`../sign/src/crypto.js` and bundled by `build.mjs` (esbuild) into the
committed `pearl-id.bundle.js` (`window.PearlID`).

## Files

- `index.html` / `styles.css` / `app.js` — the desk (`?v=2` cache keys; bundle stays `?v=1`)
- `src/id-core.js` — protocol core (canonicalization, sign, verify)
- `src/index.js` — bundle entry (`window.PearlID`)
- `build.mjs` — esbuild bundle script (resolves `../sign` import map)
- `pearl-id.bundle.js` — committed bundle (do not edit by hand)
- `tests/id.test.mjs` — 23 core tests · `tests/dom.test.mjs` — 8 DOM tests
- `tests/loader.mjs` — node ESM loader reusing `../sign` vendored libs

Run tests: `node --no-warnings --loader ./tests/loader.mjs --test tests/id.test.mjs tests/dom.test.mjs`
Real-browser QA: `node ../../../../hidden_files/qa-id-browser.mjs` — 40/40 checks green in headless Chromium 152 (file:// + CDP), zero console/page errors (2026-10-02)
Rebuild: `node build.mjs`

Built by [@kshot9000](https://x.com/kshot9000) · PRL tips: `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`
