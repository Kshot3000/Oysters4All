# Pearl Sighash Studio

An interactive **BIP-342 Taproot sighash digest explorer** for the Pearl blockchain (PRL).
Five tabs — Build → Anatomy → Compare → Sign → Verify — on a blueprint /
engineering-drafting theme (cyan drafting ink on deep-blue grid paper).

## What it does

- **Build** — draft an N-in/M-out spending scenario: inputs (txid, vout, amount in
  grains, scriptPubKey, nSequence), outputs, the input being signed, key-path or
  script-path spend (leaf script, key version, codesep position), an optional
  0x50-prefixed annex, and one of the 7 sighash flags. Computes the exact
  BIP-341/BIP-342 signature message and its `taggedHash("TapSighash", ·)` digest.
- **Anatomy** — the full walkthrough: every intermediate hash in preimage order
  (epoch, hash_type, nVersion, nLockTime, sha_prevouts, sha_amounts,
  sha_scriptpubkeys, sha_sequences, sha_outputs, spend_type, input_data,
  sha_annex, tapscript_ext, sha_single_output, final digest), each with its exact
  preimage bytes and the hash step applied. Omitted components are shown
  struck-through — ANYONECANPAY and NONE *drop* fields, they never zero them.
- **Compare** — two flags side by side on one scenario, with per-component
  "why" strings (DEFAULT vs ALL differ only in the hash_type byte; NONE omits
  sha_outputs; ANYONECANPAY swaps the four all-input hashes for this input's own
  data), plus a 7-digest matrix.
- **Sign** — BIP-340 Schnorr key generation, signing of the scenario digest, and
  signature verification. Keys live in page memory only; a wipe button clears them.
- **Verify** — a live replay of the **official BIP-341 wallet test vectors**
  (all 7 hash types, byte-exact preimages AND digests), and a sealed-descriptor
  verifier: paste a `pearl-sighash:v1` descriptor, get a **PROVEN / NOT PROVEN /
  UNSEALED** tri-state verdict with loud tamper detection.

## Honest caveats

- **Educational reference implementation, not consensus code.** The digest math is
  real and pinned byte-for-byte against the official BIP-341 wallet test vectors
  (all 7 sighash flags) and the full 19-row BIP-340 vector set, and cross-checked
  against the audited `pages/sign/src/crypto.js` keypath digest — but this page is
  not pearld and makes no claim of interop with it. Review `src/sighash-core.js`
  before trusting it with real money.
- **Demo values are labeled demo.** The built-in scenario uses invented txids and
  keys; nothing here touches a chain, a wallet, or a node — every digest is
  computed locally from what you type.
- **SIGHASH_SINGLE is refused loudly** when the input index has no corresponding
  output — consensus would fail that signature too.
- **Annexes are exotic** (spend_type low bit, sha_annex) — implemented per
  BIP-341, but no mainstream wallet produces annexes yet.
- **Pearl has no smart contracts** — this is pure Taproot digest math, same as
  Bitcoin's; the PRL angle is the currency unit (grains = 1e-8 PRL) and the
  Pearl builder ecosystem it ships in.

## Files

- `index.html` — the five-tab desk (deep links `#build` `#anatomy` `#compare` `#sign` `#verify`)
- `styles.css` — blueprint theme (`?v=1`)
- `app.js` — DOM wiring, classic script (`?v=1`)
- `pearl-sighash.bundle.js` — committed esbuild IIFE bundle (`?v=1`; built by `node build.mjs`, no `globalName` — see AGENTS.md)
- `src/sighash-core.js` — the digest engine + BIP-340 + sealed descriptors
- `src/vectors-bip341.js`, `src/vectors-bip340.js` — transcribed official test vectors
- `tests/sighash.test.mjs` — 84 core tests (`node --no-warnings --loader ./tests/loader.mjs tests/sighash.test.mjs`)
- `tests/dom.test.mjs` — 56 wiring tests (bundle surface, id coverage, `?v=` keys, footer attribution)

## Verification

- 84/84 core tests, 57/57 DOM tests.
- 31/31 real-browser QA checks in headless Chromium 152 (file:// + CDP),
  zero console/page errors — harness at
  `~/workspace/goals/pearl-blockchain-24-7-builder/hidden_files/qa-sighash-browser.mjs`
  (not committed). The 375px mobile tab-sweep caught two real overflows:
  the Compare verdict line (two unbroken 64-char digests in `.meta`,
  549px) — fixed with `overflow-wrap: anywhere` on `.meta`
  (`styles.css?v=2`) — and the Verify tab's JS-built vectors table
  (514px), which was appended without the `.table-wrap` scroll wrapper
  every static table uses — now wrapped in `app.js` (`app.js?v=2`).
- Rebuild the bundle after touching `src/`: `node build.mjs`.

## Attribution

Built by the Pearl 24/7 builder — [@kshot9000](https://x.com/kshot9000) ·
`prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`
