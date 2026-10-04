# Pearl Will — Taproot inheritance vaults for PRL

The testamentary vault for PRL: lock coins in a 2-leaf Taproot vault. The
**owner** can reclaim or move the funds at any time (no timelock); **m-of-n
heirs** can claim only at/after an **unlock block** (CLTV-gated, enforced by
consensus). No smart contracts — pure Pearl Taproot, like everything in this
family.

Live: `https://kshot3000.github.io/Pearl-Muse-24-7-Ai-builder/pages/will/`

## How it works

**1 · Draft** — owner x-only key (pasted, or derived from a fresh local BIP-86
mnemonic `m/86'/808276'/0'/0/0`), 1–5 heir x-only keys, threshold m, unlock
block height (or days → blocks at Pearl's ≈194 s target, labeled approximate).
The desk builds:

- leaf O (owner): `<owner> CHECKSIG` — spendable any time
- leaf H (heirs): `<unlock> CHECKLOCKTIMEVERIFY DROP <0> <h1> CHECKSIGADD … <hn> CHECKSIGADD <m> EQUAL` — m-of-n, CLTV-gated; heir keys sorted lexicographically so the vault is canonical (same descriptor → same address, byte for byte)
- NUMS internal key `lift_x(SHA-256("PearlWillNUMS/v1" || leafHashO || leafHashH))` — nobody's key, so **no keypath backdoor**: coins move only through the two leaves
- tamper-evident descriptor `pearl-will:v1:<hrp>:<m>-of-<n>:<owner>:<heirs…>:<unlock>:<label>` + sealed commitment `pearl-will:v1:<hrp>:<sha256(canonical)>`

**2 · Fund** — vault address + QR, GET-only Blockbook balance lookup, offline
air-gapped UTXO tally, and exact vByte fee previews for both claim paths.

**3 · Watch** — chain tip via GET-only Blockbook (or a pasted tip offline),
unlock countdown in blocks (≈days at ≈194 s/block — labeled approximate),
vault lifecycle (unfunded / funded / spent).

**4 · Claim** — two paths:
- *Owner reclaim*: paste the owner private key (WIF / 64-hex / mnemonic); the desk **refuses to sign** unless the key is the owner key of the loaded vault. Builds the script-path spend (final sequence, locktime 0), re-verifies it from the decoded hex, then double-confirmed broadcast.
- *Heir claim*: the **timelock gate runs first** — before any bytes are built, a claim before the unlock block is refused loudly with blocks + ≈days remaining. Heirs sign the shown digest locally (or paste 64-hex Schnorr sigs; empty slots = non-signers, reverse-key-order witness per the CHECKSIGADD convention); every signature is re-verified against its heir key before building; non-heir signature keys are refused. The spend carries `nLockTime = unlockHeight`, sequence `0xfffffffe`, and is re-verified from the decoded hex (structure, control block, sighash, every signature).

**5 · Verify** — standalone paste-descriptor verifier: re-derives scripts,
NUMS key, taptree, and address from the descriptor alone → **PROVEN** /
**NOT PROVEN**. Malformed input is a verdict, never a crash.

## Crypto lineage

No new cryptography. Key derivation, TapTweak, bech32m, taggedHash,
tapLeafHash, BIP-340/341 sighash, and wire serialization come from the audited
`files/pages/sign/src/crypto.js` (+ `decodeRawTx` from `sign-core.js`);
script-path sighash, signing, control-block verification, spend planning, and
dust math come from the audited `files/pages/escrow/src/escrow-core.js`
(the heir leaf's CLTV prologue is byte-shape-matched to escrow's audited
`buildRefundScript`, asserted by test). The NUMS derivation mirrors escrow's
`numsInternalKeyEscrow` with a different domain (`PearlWillNUMS/v1` — the
test suite asserts the two domains never collide). The bundle is built with
esbuild from `src/` (`node build.mjs`); the committed
`pearl-will.bundle.js` is what the page ships, and the DOM suite boots that
exact bundle in a VM.

## Honest limits (also shown on the page)

- The scripts enforce **routing, not intent** — who can move the coins and when. They cannot verify your heirs are the right people; key custody is on you.
- Unlock is a **block height, not a date**; the ≈days estimates drift with real block times.
- The owner can always move the funds until the heirs claim them — there is no on-chain dead-man's switch. Tell your heirs how to watch the vault.
- Not legal advice: a key-management tool, not a legal will.
- Keys live in page memory only (byte-wiped after signing where practical); nothing is sent anywhere except the double-confirmed Blockbook broadcast.

## Tests

- `tests/will.test.mjs` — 26/26 green (script construction + canonical key sort, CLTV prologue byte-match vs audited escrow, NUMS domain separation, vault determinism + pinned address/seal, descriptor PROVEN/NOT PROVEN incl. tamper cases, claim-gate refusals, full owner + 2-of-3 + 1-of-1 claim builds with independent hex-decode re-verification, tamper-caught regression, exact amount parser for the offline tally).
- `tests/dom.test.mjs` — 8/8 green (committed bundle boots in a VM and exposes the full surface; pinned bundle vault + PROVEN; pre-unlock refusal from shipped code; every `app.js` id wired in `index.html`; cache-busted assets; footer attribution; exact-parser wiring pins).
- Real-browser QA (headless Chromium 152, `file://` + CDP, zero console/page errors): full draft → fund → watch → claim (loud pre-unlock refusal) → verify flow driven in-page; see `hidden_files/qa-will-browser.mjs` (bookkeeping, not committed).

## Build

```sh
node build.mjs   # regenerates pearl-will.bundle.js (esbuild via ~/workspace/.build-tools)
```

Assets are served with `?v=1` cache keys; bump on every release that changes them.
