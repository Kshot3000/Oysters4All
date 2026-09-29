# Pearl Registry — Decentralized Handles on Pearl

Claim a human-readable handle (e.g. `satoshi`) on Pearl (PRL) with a Taproot
`prl-name` inscription. Three tabs:

1. **Directory** — scan a configured Pearlscriptions indexer API (GET-only,
   asc-ordered `/inscriptions`, 100/page, configurable cap), parse every
   `application/json` candidate against the `prl-name` schema, and resolve
   current owners by **first-seen consensus**: lowest inscription number wins,
   transfers only count from the current owner, releases free the handle for
   re-claim. Search box + handle→owner lookup + inscription cross-links to the
   verifier.
2. **Claim wizard** — 3 steps (handle → owner address → commit/reveal):
   handle validation + squatting guard against the last directory scan,
   bech32m `prl1`/`tprl1` owner validation, local WIF key entry with
   lock/wipe, exact grain fee math, dust refusal, double-confirm broadcast via
   Blockbook, plus a standalone commit/reveal-pair verifier that loudly refuses
   anything off.
3. **Verifier** — paste an inscription id; the page fetches inscription +
   content from the configured indexer, schema-validates, re-normalizes the
   handle, and confirms first-seen ownership against a **live directory
   re-scan** of that handle. Tampered or losing records are refused loudly with
   exact field-level reasons.

## Protocol (`prl-name`)

App-level convention — **not Pearl consensus**. Pearl has no smart contracts;
two indexers can disagree. Inscriptions follow the Pearlscriptions
commit/reveal envelope pattern with the `prl-name` protocol marker (distinct
from `prl-20` and `prl-notary`).

```json
claim:    {"p":"prl-name","op":"claim","handle":"satoshi","owner":"prl1…","ts":1759170000}
transfer: {"p":"prl-name","op":"transfer","handle":"satoshi","from":"prl1…","to":"prl1…","ts":1759170001}
release:  {"p":"prl-name","op":"release","handle":"satoshi","from":"prl1…","ts":1759170002}
```

- Handle rules: 1–32 chars, `[a-z0-9-]`, no leading/trailing/double hyphens;
  normalization = lowercase + trim (`Satoshi` ≡ `satoshi`).
- Consensus: first valid claim (lowest inscription number) owns the handle —
  later claims lose; `transfer` valid only from the current owner; `release`
  frees the handle for re-claim.
- Canonical JSON (fixed key order); unknown fields, non-canonical handles,
  and non-Taproot owner addresses are rejected loudly.

## Crypto lineage

No new cryptography. Envelope framing derives from the audited
`buildInscriptionScript` in `../sign/src/crypto.js` with a surgical,
assertion-guarded marker swap (`prl-20` → `prl-name`); commit/reveal
transaction building reuses `../etch/src/etch-core.js`
(`buildCommitTx` / `buildRevealTxSigned`); address validation reuses the
audited bech32m decoder from Sign core.

## Build & test

- `node build.mjs` — rebuilds the committed `pearl-registry.bundle.js`
  (esbuild IIFE, `window.PearlRegistry`) from `src/index.js`.
- `node --no-warnings --loader ./tests/loader.mjs tests/registry.test.mjs` —
  core suite: handle rules, schema, state machine, fee math, real commit/reveal
  pair (18 tests).
- `node --no-warnings --loader ./tests/loader.mjs tests/dom.test.mjs` —
  DOM suite booting the committed bundle + `app.js` against a DOM shim with a
  stubbed indexer/Blockbook.

## Honest limits

`prl-name` is an app-level convention, not Pearl consensus. Ownership =
first-seen per the configured indexer's ordering; the indexer is unconfigured
by default (supply your own, per Gallery precedent). Claiming costs real PRL
in chain fees. Never claim legal rights to a handle. No squatting protection
beyond first-seen.

Built by [@kshot9000](https://x.com/kshot9000) ·
PRL: `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`
