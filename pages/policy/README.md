# Pearl Policy — Taproot policy-tree builder & visualizer for PRL

The blueprint studio for Pearl Taproot: design a script tree from audited
templates, get the real P2TR address and spend-ready per-leaf control blocks,
verify any descriptor standalone, export it all. Fully offline — zero network
requests.

Live: `https://kshot3000.github.io/Pearl-Muse-24-7-Ai-builder/pages/policy/`

## How it works

**Design** — compose 1–8 leaves from audited templates ONLY (expert mode
allows raw script hex, with loud unreviewed warnings):

- `KeyLock`: `<xonly> OP_CHECKSIG` — byte-identical to the audited Pearl
  Bounty award leaf (asserted by test)
- `TimelockRefund`: `<height> OP_CHECKLOCKTIMEVERIFY OP_DROP <xonly> OP_CHECKSIG`
  — byte-identical to the audited Pearl Escrow refund leaf (asserted by test)
- `MultiSig`: `<0> <K1> CHECKSIGADD … <Kn> CHECKSIGADD <m> EQUAL` — the audited
  Pearl Covenant multisig pattern, keys sorted canonically (asserted by test)

The internal key is one of three sources: **NUMS** (recommended) —
`taggedHash("PearlPolicyNUMS/v1", sorted leaf hashes)` lifted to the curve with
a counter fallback, mirroring escrow's NUMS pattern, so the keypath is
intentionally unspendable; **BIP-86** — your own x-only key from a mnemonic
(keypath spendable by its holder); or a **pasted x-only key**.

Leaves are hashed with `TapLeaf`, sorted lexicographically, combined pairwise
per the BIP-341 reference pairing (odd leaf carried), the internal key is
tweaked by the merkle root, and the output key is encoded bech32m `prl1…`.
Each leaf gets a control block carrying its full merkle path — paste it into
Pearl Sign to spend via that leaf.

**Address** — the P2TR address, QR, scriptPubKey, internal key, merkle root,
tweak, the SVG tree, and every leaf's control block, each re-verified against
the tweaked key.

**Verify** — standalone: paste `pearl-policy:v1:<hrp>:<source>:<leaves>` +
the claimed address (+ optional sealed commitment) → recomputed from scratch →
**PROVEN** or loud **NOT PROVEN**. Any tampered leaf or parameter moves the
address.

**Export** — descriptor JSON download, shareable `#p=` URL (params in the
hash — nothing uploaded), markdown summary for docs.

**Learn** — what policy trees prove (authorization paths, deterministic
addresses, unspendable NUMS keypaths, tamper evidence) vs. what they don't
(the *why*, off-chain facts, custom-script safety, funding).

## Honest limits

- This page **never moves PRL and never broadcasts** — it computes addresses
  and data. Fund from Pearl Sign or your wallet.
- A NUMS internal key is intentionally unspendable on the keypath. Lose every
  leaf key and the funds are unspendable — treat that as permanent.
- Templates are authorization-only: they prove WHO can move coins, never WHY,
  never at what price, never any off-chain fact.
- Expert custom scripts are unreviewed — verify them yourself and test on
  testnet first.
- No new cryptography: BIP-340, BIP-341 digests, taggedHash, bech32m — all
  audited Sign/Escrow/Bounty/Covenant lineage.

## Verification

- `node --no-warnings --loader ./tests/loader.mjs --test tests/policy.test.mjs` — 25/25 core tests green
  (leaf byte-equality with audited lineage, pinned descriptor/address/control-block/tweak vectors, tamper cases).
- `node --no-warnings --loader ./tests/loader.mjs --test tests/dom.test.mjs` — 11/11 DOM tests green
  (real app.js + committed bundle against a strict shim; hostile localStorage).
- Real-browser QA: headless Chromium 152 via file:// + CDP, design → address →
  verify → export, zero console/page errors.
