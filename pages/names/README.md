# Pearl Names

Human-readable names for Pearl Taproot addresses. Bind a memorable `name.prl`
to your `prl1…` address by signing a canonical registration record with the
BIP-86 key that controls that address, then seal the record on-chain inside a
`prl-name` Taproot inscription envelope. Anyone can verify the binding with
the standalone verifier — no keys, no server.

Live: `https://kshot3000.github.io/Pearl-Muse-24-7-Ai-builder/pages/names/`

## Protocol

- **Name rules:** 3–63 chars, `a–z 0–9` and single hyphens, no leading/trailing
  hyphens, no consecutive hyphens, not all digits, never a reserved name
  (`pearl`, `prl`, `admin`, `root`, `wallet`, `miner`, `pool`, `team`,
  `official`, `faucet`, …). Displayed with the `.prl` suffix.
- **Canonical record** (fixed field order — never changes):
  `v, name, address, xonly, network, registered_at, expires_at`.
  The address is re-encoded from its decoded program, so mixed-case and
  wrong-HRP addresses are rejected at compose time.
- **Ownership proof:** the record is signed BIP-340 with the *tweaked keypath*
  private key of the claimed address. Signing loudly refuses when the loaded
  key derives a different address (wrong-key refusal), and the verifier
  re-derives the address from `xonly` before checking the signature.
- **Inscription envelope:** Pearlscriptions-style envelope with marker
  `prl-name` — deliberately **not** `prl-20`, so PRL-20 indexers never mistake
  it for a token operation. Commit → reveal via the audited Etch machinery.
- **Registration id:** SHA-256 of the canonical bytes; 64-bit fingerprint
  shown grouped (`abcd-1234-…`) for eyeball comparison.
- **Conflicts:** first-seen (`registered_at`) wins. The Directory resolves the
  local registry this way; later same-name claims are flagged *contested*.

## Tabs

1. **Register** — 4-step wizard: choose name → prove ownership (mnemonic / WIF /
   hex, demo-key button for testing) → plan inscription (grain-exact fee math,
   UTXO + fee rate + Blockbook) → build/sign commit+reveal, double-confirmed
   broadcast, name certificate.
2. **Directory** — local registry (localStorage, treated as hostile), search,
   import signed bindings, contested-claim list, clear.
3. **Verify** — standalone verifier for pasted signed bindings (VALID /
   VALID ⚠ expiring-soon / INVALID with per-check rows) and for raw reveal
   transaction hex.
4. **Export** — registry JSON download, inscription envelope JSON download.

## Honest limits

- The Directory is **local to this browser**. Global first-seen resolution
  needs a public `prl-name` indexer, which does not exist yet.
- A name proves **key control**, not identity or trustworthiness.
- Names do not replace addresses — always confirm the `prl1…` string before
  sending funds.
- Inscribing spends real PRL and cannot be undone. Testnet first.
- No broadcast or real inscription was executed during development (needs user
  funds + a live Blockbook); the commit→reveal→parse round-trip is proven in
  the test suite against the real envelope parser.

## Crypto lineage

No new cryptography. All key derivation (BIP-86 `m/86'/808276'/…`), TapTweak,
bech32m, BIP-341 sighash, envelope composition and wire serialization come
from the audited `pages/sign/src/crypto.js` (Pearl Sign) and
`pages/etch/src/etch-core.js` (Pearl Etch). This app adds only name rules,
canonical binding composition, the `prl-name` envelope, the plan wrapper, the
registry resolver, and the standalone verifier.

## Tests

- `node --no-warnings --loader ./tests/loader.mjs tests/names.test.mjs` — 25/25
  (name rules, canonical order, wrong-key refusal, tamper rejection, fee math,
  full commit→reveal→envelope→verify round-trip, first-seen resolution).
- `node tests/dom.test.mjs` — boots the committed bundle in a VM and drives
  the register wizard + verifier DOM flows.
- Real-browser QA (`hidden_files/qa-names-browser.mjs`): headless Chromium via
  `file://` + CDP — 46/46 checks green (2026-10-02): full name check →
  demo key → sign → plan → commit/reveal build → witness self-verify,
  zero console/page errors.

Built by [@kshot9000](https://x.com/kshot9000) for the Pearl blockchain.
Donations: `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`
