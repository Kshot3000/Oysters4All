# Pearl PSBT — the Taproot PSBT signing workbench

**Live:** https://kshot3000.github.io/Pearl-Muse-24-7-Ai-builder/pages/psbt/

A six-tab, client-side desk for the full PSBT lifecycle on Pearl's Taproot
rails: **Create → Inspect → Sign → Combine → Finalize → Method**.

## Tab tour

1. **Create** — draft an unsigned PSBT from UTXOs you control. Paste
   `txid:vout:amountGrains:internalKeyHex[:leafAsm]` lines for inputs and
   `prl1…:amountGrains` / `OP_RETURN:hexdata` lines for outputs. Amounts are
   whole grains (1 PRL = 10⁸ grains), exact BigInt math. A one-click
   **demo PSBT** ships with the page: 2 inputs (keypath + CLTV scriptpath),
   2 outputs (P2TR + OP_RETURN), built from deterministic test keys.
2. **Inspect** — paste any PSBT and read every byte before a key touches it:
   global fields, per-input witness UTXOs, sighash declarations, internal
   keys, tap leaves (with disassembly), partial signatures (with sighash
   names), BIP-32 derivations, per-output destinations — plus an issues list.
3. **Sign** — sign one input with a hex or WIF key. The desk computes the exact
   BIP-341 sighash (all 7 sighash types), signs BIP-340 Schnorr, and
   **re-verifies the signature before writing it into the PSBT**. Keys live in
   memory for one call, then are wiped. Keypath accepts the internal key (the
   desk applies the TapTweak) or an already-tweaked key; scriptpath requires
   the key as a 32-byte push in a declared leaf.
4. **Combine** — merge two co-signer PSBTs. Requires byte-identical unsigned
   transactions; rejects conflicting signatures and duplicate keys.
   Order-independent and idempotent.
5. **Finalize** — re-verifies **every** signature against its own sighash,
   strips partial-sig metadata per BIP-174, assembles witnesses
   (`[sig]` / `[sig, script, control block]`), and emits raw tx hex with the
   txid and vsize. Nothing is broadcast — broadcasting is your node's job.
6. **Method** — methodology, crypto lineage, and the honest-limits list.

## Crypto lineage

**No new cryptography.** Every primitive is vendored from the audited
`sign/src/crypto.js` core (pearlpurse lineage) via relative import — not
copied: SHA-256, tagged hashes, the TapTweak (`tapTweak` /
`tweakPrivKeypath`), BIP-340 Schnorr, and bech32m.

New code in `src/psbt-core.js`: the BIP-174 codec, the BIP-341 sighash message
layout (differentially pinned byte-equal against the audited
`keypathSigDigestEx` for SIGHASH_DEFAULT and SIGHASH_SINGLE|ANYONECANPAY),
the script assembler/disassembler, and witness construction.

## Tests

39 tests, 158 assertions — run from this directory:

```sh
node --no-warnings --loader ./tests/loader.mjs --test \
  tests/psbt-codec.test.mjs tests/psbt-sighash.test.mjs tests/psbt-flow.test.mjs
```

(`node --test tests/` alone doesn't work here — the directory import trips the
ESM loader hook, same as the sibling quorum/sign suites, which also require
their loader.)

Covers: compact-uint boundaries (0xfd/0xfe/0xff), map round-trips,
create→serialize→parse byte-identity, malformed-PSBT rejections, strict
bech32m accept/reject, grain-exact amounts, ASM templates, keypath/scriptpath
sign→verify, 1-bit sighash/signature tamper, wrong-key rejection, combine
merge + mismatch + conflict rejection, finalize→extract→re-parse with txid and
vsize checks, and the audited-core differential pinning.

## Build

```sh
node build.mjs   # → pearl-psbt.bundle.js (committed; page works from file://)
```

The bundle sets `window.PearlPSBT` at the end of `src/index.js` (never via
esbuild `globalName` — see the repo AGENTS.md lesson). Bare `@`-specifiers
resolve through `../sign/importmap.json` via the importmap plugin, same as the
Quorum desk.

Real-browser QA (headless Chromium, file:// + CDP) — 35/35 checks green,
zero console/page errors, plus a 375px mobile tab-sweep
(`hidden_files/qa-psbt-browser.mjs`). The sweep caught a real mobile
overflow: the footer donation `<code>` (62-char address, no wrap rule)
forced every tab to 566px at a 375px viewport — fixed with
`word-break: break-all` on `footer .donate code` (`styles.css?v=2`).

## Honest limits

- The desk **never broadcasts** — finalize hands you raw tx hex.
- Private keys are **in-memory only**, wiped after one signing call. A pasted
  key should be considered burned; prefer air-gapped signing.
- **No MuSig2** — multi-party signing is sequential combine, not interactive
  aggregation.
- Scriptpath finalize supports **single-leaf trees only** (what the desk
  creates); foreign multi-leaf PSBTs inspect fine but finalize may refuse.
- The demo PSBT uses **deterministic test keys** — never fund them.
- Working PSBTs persist in **localStorage only**; nothing leaves the browser.
