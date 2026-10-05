# Pearl Mesh — MuSig2 collaborative keypath signing desk for PRL

The weaver's loom for shared PRL custody: 2–7 members weave their keys into
one n-of-n aggregate Schnorr key. Funds sent to the woven address look
exactly like a single-key Taproot payment — no scripts, no on-chain marker
that the key is shared. Distinct from Pearl Quorum (script-path multisig);
Mesh is pure keypath MuSig2.

Live: `https://kshot3000.github.io/Pearl-Muse-24-7-Ai-builder/pages/mesh/`

## How it works

**1 · Setup** — add 2–7 members. Each member is a name plus an x-only public
key: paste one, or derive one from a local BIP-86 mnemonic wallet
(`m/86'/808276'/0'/0/i` — the Pearl BIP-86 path). Keys flagged `local` can
commit and sign on this device; everyone else works on their own machine and
pastes bundles back.

**2 · Aggregate** — the MuSig2 key aggregation: member keys sorted
lexicographically, hashed into the key-list hash `L`, each key weighted by
its own coefficient `a_i` (this is what makes MuSig2 secure against
rogue-key attacks), the weighted sum normalized to even-y (the aggregate
internal key `Q`), then TapTweaked into the final output key. The address is
a real bech32m P2TR `prl1…` address. The desk emits a sealed descriptor
`pearl-mesh:v1:<hrp>:<hash>` (SHA-256 over the canonical JSON descriptor) —
and **recompute & compare** re-derives everything from the pasted descriptor
and rules PROVEN / NOT PROVEN.

**3 · Fund** — the woven address with QR. Check its balance with GET-only
Blockbook calls, or paste air-gapped UTXOs (`txid:vout amount PRL address`)
for an offline tally. This page never builds transactions.

**4 · Sign** — the interactive ceremony, three rounds coordinated here:

1. every member commits a pair of public nonces (a bundle);
2. the coordinator aggregates them into one challenge;
3. every member signs locally with their secret key, and the coordinator
   aggregates the partials into one BIP-340 signature.

Local members commit and sign on this device with a loud **KEY REFUSED**
guard (the secret key must match the member's slot — wrong key, no
signature). A labeled demo-grade simulator runs the whole ceremony
in-page with throwaway keys, for learning the flow only.

**5 · Verify** — two standalone verifiers: paste a descriptor (re-derives
address, checks every field, re-checks the sealed hash) and paste a
signature + message + aggregate key (BIP-340 verify) → PROVEN / NOT PROVEN.

## Honest limits (also shown on the page)

- **n-of-n, not a threshold scheme.** Every member must take part in every
  signing ceremony. If one key is lost, the funds are locked. There is no
  k-of-n recovery path.
- **The ceremony is interactive.** Members exchange nonce bundles and
  partial signatures with the coordinator. Anyone who sees a member's
  *secret* nonce (not the bundle — the secret) alongside their partial can
  recover that member's private key. Keep secrets on-device; share only
  bundles and partials.
- **Simulation is demo-grade.** The in-page simulator uses throwaway keys
  and is for learning the flow only — it proves the math, not a real
  ceremony.
- **No interop claim.** The MuSig2 implementation follows the MuSig2 paper
  construction, but it has not been cross-tested against external MuSig2
  libraries — treat other implementations as incompatible until proven
  otherwise.
- **This page never moves PRL.** It builds keys, addresses, and signatures.
  It does not construct transactions, hold custody, or broadcast anything.

## Cryptography

`src/mesh-core.js` implements MuSig2 on the audited Pearl Sign primitives
(SHA-256, tagged hashes, secp256k1, BIP-340 Schnorr, bech32m) — no new
elliptic-curve code. Two parity normalizations are handled explicitly and
covered by tests:

- `gacc` — the even-y normalization of the aggregate internal key `Q`
  (each member's share is multiplied by `gacc`, like BIP-340 key tweaking);
- `pacc` — the even-y normalization of the tweaked key `Q*` (the coordinator
  adds `e · pacc · t` once when aggregating partials).

Nonces are two 32-byte scalars per member per message (MuSig2's `k1, k2`
construction, deterministic tagged-hash derivation with a zero-retry).
Aggregate nonces are combined with the `b` coefficient and normalized to
even-y R.

Pinned test vector (recorded 2026-10-01): members Ada / Bo / Cy with keys
`c6047f94…709ee5` / `f9308a01…036f9` / `8200cf0c…4499b` →
`prl1p3faqn7s30jk4qmz06309lyry3v7yjy34lglq22px3ypheykhyq0s23h6ky`,
sealed `pearl-mesh:v1:prl:6bac3d1db6e81bf04c56bd16c8fca636f28a981b4ffdd51ef1b1628de7edf5a9`.

## Tests

- `tests/mesh.test.mjs` — 30/30: pinned vector, determinism /
  order-independence, 2–7 bounds, duplicate / malformed / off-curve keys,
  Σa_iP_i == Q, gacc & pacc paths, tamper cases, full n-party ceremonies
  n=2..7 checked against independent BIP-340, KEY REFUSED, tampered /
  duplicate / non-member partials, message & salt mismatch, odd-R
  round-trips, simulation, UTXO parsing.
- `tests/dom.test.mjs` — 10/10: boot with hostile localStorage and no
  network, setup → pinned triple, recompute & compare, fund QR + UTXO
  tally, guided 2-local-key ceremony, demo-grade simulation, descriptor and
  signature verifiers, footer attribution.
- Real-browser QA: headless Chromium, file:// + CDP, zero console/page
  errors; full flow (setup → aggregate → fund → sign simulation →
  verify) driven over CDP, screenshots per step.

Run: `node tests/mesh.test.mjs`, `node tests/dom.test.mjs` (from this dir;
the DOM test uses a strict VM shim, no browser needed).

## Files

- `index.html` — five-step page (stepped nav), honest-limits panel, footer
  attribution.
- `styles.css` — weaver's-loom theme (dusk copper on deep indigo).
- `src/mesh-core.js` — the MuSig2 core (audited-Sign-primitives only).
- `src/index.js` — exports `window.PearlMesh`.
- `build.mjs` — esbuild IIFE (no `globalName`; `src/index.js` assigns
  `window.PearlMesh` explicitly).
- `pearl-mesh.bundle.js` — built bundle (regenerate with `node build.mjs`).
- `app.js` — page logic (ceremony coordination, verifiers, Blockbook
  GET-only balance, UTXO tally, QR).

Cache keys: `styles.css?v=7`, `qrcode.min.js?v=1`,
`pearl-mesh.bundle.js?v=1`, `app.js?v=3`.

---
Built by [@kshot9000](https://x.com/kshot9000) · tips:
`prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`
