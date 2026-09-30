# Pearl Boost — Stuck-Transaction Accelerator Desk for PRL

The launchpad: diagnose a stuck PRL transaction, then accelerate it with **CPFP**
(child-pays-for-parent) or **BIP-125 RBF** (replace-by-fee) — pure Taproot, no smart
contracts (Pearl has none), all signing local with per-signature re-verification.

Live: `pages/boost/` (GitHub Pages). Five tabs: **Diagnose → CPFP → RBF → Track → Verify**,
plus an always-visible Honest Limits panel.

## What it does

- **Diagnose** — paste a txid; GET-only Blockbook reads report confirmations, fee paid,
  computed vBytes, effective feerate, and whether any input signals BIP-125 RBF
  (`nSequence ≤ 0xfffffffd`, the rule straight out of pearld's `node/mempool/mempool.go`
  `MaxRBFSequence`). Air-gapped fallback: paste a Blockbook `/api/v2/tx` JSON.
- **CPFP** — pick an output you control, enter its WIF (in-memory only, wipe button),
  set a target *package* feerate. The desk builds the child with exact vBytes math
  (1 P2TR keypath in + 1 out = 111 vB), shows the combined package feerate
  `(parentFee + childFee) / (parentVSize + childVSize)`, signs locally, re-verifies
  every signature, and double-confirms before broadcast via Blockbook `/api/sendtx`
  (plus a `pearld sendrawtransaction` curl one-liner).
- **RBF** — for signaling transactions where you hold the input keys: builds a
  same-input replacement with the fee bumped by trimming one output you choose.
  Enforces pearld's three `validateReplacement` rules before signing: strictly higher
  feerate, absolute fee > old fee + min-relay fee (mirrors `calcMinRequiredTxRelayFee`
  in `node/mempool/policy.go`; DefaultMinRelayTxFee = 1000 grains/kB), dust floor honored.
- **Track** — confirmation polling for a txid. **Verify** — standalone paste-txid
  package-feerate verifier ruling **PROVEN / NOT PROVEN** with full derivation.
- Loud refusals: unreachable backend, already-confirmed tx, non-signaling RBF attempt,
  key↔address mismatch (byte-level scriptPubKey comparison), dust outputs.

## Honest caveats

- **No confirmation is guaranteed.** Boosting only makes a transaction more attractive
  to miners; it cannot force inclusion.
- **RBF acceptance is node policy, not consensus.** pearld implements BIP-125 (verified
  in `node/mempool/mempool.go`), but operators may set `rejectreplacement`, and the
  Blockbook relay may refuse replacements. A rejected broadcast is not a math bug.
- **CPFP needs package-aware miners.** The child is worthless until the parent confirms;
  if the parent is double-spent, the child dies with it.
- This page sees Blockbook's view of the mempool, never the mempool directly.
- Never paste a key you can't afford to lose into any website — ideally use a dedicated
  boosting key. Keys are wiped after broadcast.

## Build & test

- `node build.mjs` → committed `pearl-boost.bundle.js` (`window.PearlBoost`), bundling
  `src/boost-core.js` + the audited Sign core (`../sign/src/*`, vendored libs).
  No new cryptography anywhere in this app.
- `node --no-warnings --loader ./tests/loader.mjs tests/boost.test.mjs` — 26/26 core tests
  (pinned package-feerate vector, BIP-125 sequence boundary, exact CPFP/RBF fee math,
  real Schnorr sign + re-verify round-trip with tamper check).
- `node --no-warnings tests/dom.test.mjs` — 12/12 DOM tests driving the real bundle.
- Real-browser QA: `hidden_files/qa-boost-browser.mjs` (headless Chromium 152, file:// + CDP,
  Blockbook stubbed at fetch, zero console/page errors) — not committed.

Theme: launchpad ignition — deep navy + ignition orange.
