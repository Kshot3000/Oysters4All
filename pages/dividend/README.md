# Pearl Dividend — PRL-20 Holder Distribution Desk

The luminous transfer-agent / mint-hall desk for paying PRL-20 token holders:
seal a holder snapshot, compute grain-exact distribution shares, fund, sign,
and broadcast payouts — all in the browser, keys never leaving the page.

Live: <https://kshot3000.github.io/Pearl-Muse-24-7-Ai-builder/pages/dividend/>

## What it does

Six steps: **Token → Snapshot → Plan → Fund → Sign → Broadcast & Verify**.

1. **Token** — token metadata from the Pearlscriptions indexer (GET-only) or
   manual entry. The indexer only supplies metadata/status; it never supplies
   the holder list.
2. **Snapshot** — paste `address,balance` CSV. Duplicate addresses are summed
   (opt-in) or refused; a sealed snapshot carries a tamper-evident
   64-bit fingerprint.
3. **Plan** — distribution rule: **proportional** (by balance), **equal**,
   or **fixed per holder**. BigInt/grain-exact share math, explicit dust and
   remainder accounting, exclusions, minimum-balance filters, and payout
   chunking with a treasury/remainder receiver.
4. **Fund** — fetch funder UTXOs (GET-only Blockbook) or paste them; each
   chunk is funded with grain-exact change and fee math.
5. **Sign** — export an unsigned chunk bundle (air-gap friendly), re-import
   and tamper-check it, then sign locally with BIP-340 Schnorr. The secret
   is wiped from the page after signing. Wrong keys are refused.
6. **Broadcast & Verify** — double-confirm broadcast, confirmation tracking,
   and a standalone PROVEN / NOT PROVEN verifier that re-computes the
   snapshot fingerprint, the plan fingerprint, every share, and audits every
   payout transaction against the chunk list.

## Honest scope

- Pearl has no smart contracts; PRL-20 state comes from an indexer. This app
  does **not** claim automatic or trustless holder discovery — the holder set
  comes from your CSV, and the plan is only as honest as the snapshot you seal.
- Plan reproducibility (fingerprints recompute identically) is distinct from
  payout proof (transactions confirmed on-chain). The verifier distinguishes
  both: a plan without payout transactions is reported as plan-only, never as
  on-chain proof.
- The funding, signing, and broadcast code reuses the audited Pearl Batch and
  Pearl Sign implementations; no new cryptography was written.

## Build & tests

```bash
cd pages/dividend
node build.mjs              # emits pearl-dividend.bundle.js
node --no-warnings --loader ./tests/loader.mjs tests/div.test.mjs   # 19 core tests
node --no-warnings tests/dom.test.mjs                                # 9 DOM tests
```

No external packages. Fonts degrade gracefully when no network is available.
