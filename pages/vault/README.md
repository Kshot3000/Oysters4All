# Pearl Vault — m-of-n Taproot Multisig Safe

The strongroom for PRL: forge an m-of-n (up to 5) Taproot multisig vault, fund it,
plan spends, coordinate unsigned signing bundles + partial Schnorr signatures across
cosigners, verify every signature locally, and broadcast via Blockbook.

## How it works

1. **Forge** — pick a quorum (m-of-n, 1 ≤ m ≤ n ≤ 5) and the cosigners' keys
   (x-only pubkey hex, private-key hex, WIF, or BIP-39 mnemonic). The page builds a single
   `CHECKSIGADD` script leaf:
   `<0> <K1> CHECKSIGADD … <Kn> CHECKSIGADD <m> EQUAL`
   under a NUMS internal key (`lift_x(SHA-256("PearlVaultNUMS/v1" || m || n || keys))`).
   Nobody knows the internal key's discrete log, so coins can **only** move through the
   multisig leaf — there is no keypath backdoor. The tamper-evident
   `pearlvault:v1:<hrp>:<m>:<n>:<hash>` descriptor (SHA-256 over canonical JSON) is the
   vault's identity.
2. **Fund** — deposit address + QR + `pearl:` URI; on-chain balance and UTXO list via
   GET-only Blockbook reads.
3. **Plan** — select UTXOs, recipients, fee rate (or Blockbook estimate). Exact
   script-path witness weight → exact vBytes → exact fee. Dust change (< 546 grains) is
   absorbed into the fee and disclosed, never stranded. Produces an unsigned bundle
   (`pearl-vault-unsigned:v1`) with per-input BIP-341 script-path digests and a 64-bit
   fingerprint.
4. **Sign** — cosigners import the bundle; the page re-derives fee, vBytes and every
   digest before anything is signed (a tampered bundle is refused loudly). Each cosigner
   signs locally and exports a partial (`pearl-vault-partialsig:v1`). The coordinator
   re-verifies every signature against the claimed key and digest on import, and finalizes
   once ≥ m distinct valid signatures exist per input. Witness order is reverse key order
   with empty vectors for non-signers (BIP-341 / CHECKSIGADD mechanics). Broadcast needs
   two explicit clicks.
5. **Track** — txid confirmation tracking via GET-only Blockbook reads.
6. **Verify** — standalone descriptor verifier: re-derives the vault address from the
   canonical JSON and rules **PROVEN** / **NOT PROVEN**. Verify before you fund a vault
   someone else forged.

## Honest limits

- The quorum is a chain rule (the Taproot script), not an app convention.
- Every partial signature is re-verified before acceptance; a bad signature never reaches the chain.
- Keys stay in page memory; wipe buttons included. The page never uploads keys anywhere.
- Blockbook reads are third-party data; unreachable Blockbook = loud refusal, never guesses.
- No new cryptography: the audited Sign core (`../sign/src/crypto.js`) does all hashing,
  bech32m, Taproot math and Schnorr; CHECKSIGADD mechanics follow the audited escrow app,
  NUMS derivation follows the audited fund app. New code is deterministic arithmetic only
  (multi-input BIP-341 sighash, script-path vBytes, descriptor canonicalization).

## Tests

- `node --no-warnings --loader ./tests/loader.mjs tests/vault.test.mjs` — 25/25 core tests
  (descriptor round-trip + tamper refusal, NUMS determinism, hand-rolled BIP-341 sighash
  vector, hand-computed vBytes, dust absorption, full 2-of-3 signing round with per-sig
  verification, witness ordering, odd-Y BIP-340 negation, bundle tamper refusal,
  verify-on-add partial acceptance without quorum).
- `node --no-warnings --loader ./tests/loader.mjs tests/vault.dom.test.mjs` — 14/14 DOM
  tests driving the real bundle + app.js (Forge → Fund → Plan → Sign → Coordinator →
  Broadcast → Track → Verify, plus junk-key / duplicate-key / dust / wrong-party-key
  refusals).
- `tests/vault.browser.qa.mjs` — real-browser QA (headless Chromium, `file://` + CDP,
  stubbed Blockbook): 26/26 checks green, zero console/page errors.

Rebuild the bundle after editing `src/`: `node build.mjs` (esbuild via `~/workspace/.build-tools`).
