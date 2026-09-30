# Pearl Fees — the fee-rate desk for PRL

**Live:** https://kshot3000.github.io/Pearl-Muse-24-7-Ai-builder/pages/fees/

The fee-rate desk for Pearl (PRL). Connect your own `pearld` node's RPC and it
reads the live mempool, ranks every transaction by **grains per vbyte**, and
tells you what to pay for next-block, ~10-minute, ~1-hour, or economy
confirmation. Also: a P2TR transaction-size estimator and a stuck-transaction
fee-bump planner (RBF / CPFP). **Read-only — keys never touch this page.**

## What it does

1. **Mempool** — `getmempoolinfo` + `getrawmempool(verbose=true)` from your node;
   fee-rate histogram (log scale), p10/p25/p50/p75/p90/p95 percentiles, and
   four recommendation bands with rough confirmation ETAs (~3m14s block target,
   ~1 MB `MaxBlockVsize` blocks, fee-rate-priority packing model).
2. **Size Estimator** — pick P2TR key-spend inputs/outputs (57.5 / 43 / 11 vB),
   choose a target speed or a custom rate, get the fee in grains and PRL.
3. **Bump Planner** — paste a stuck txid; the desk fetches the raw tx from your
   node, measures its exact vsize from the serialized bytes (no trust in claimed
   sizes), and computes what a replacement or CPFP child must pay — including
   whether the original signaled RBF (sequence check).
4. **Settings** — pearld RPC endpoint + basic auth, persisted in localStorage,
   optional 30s auto-refresh.

No node? The desk runs on clearly-labeled **sample data** — the estimator and
all math still work, and the badge always says which source you're looking at.

## Protocol facts used (verified against upstream `pearld`)

- 1 PRL = 10⁸ grains; fee rates in grains/vB
- `getrawmempool(verbose=true)` → `{ vsize, fee (PRL), … }`
- `MaxBlockVsize = 1_000_000` vB (`node/blockchain/vsize.go`)
- `TargetTimePerBlock = 3m14s` (`node/chaincfg/params.go`)
- P2TR key-path shapes: 57.5 vB/input, 43 vB/output, 11 vB overhead

## Build & test

```sh
node build.mjs                                  # esbuild -> pearl-fees.bundle.js
node --test tests/logic.test.mjs                # 14/14 unit tests
node ../../hidden_files/qa-fees-browser.mjs     # real-browser QA (headless Chromium)
```

Zero runtime dependencies. The committed `pearl-fees.bundle.js` is built, not
hand-edited.

## Honest limits

- No fee-market oracle exists on Pearl: rates are your own node's mempool (or
  labeled sample data).
- Confirmation ETAs are a rough model — miners may order however they like.
- The bump planner plans numbers only; it never signs or broadcasts. RBF needs
  the original to have signaled it and a node policy that accepts replacements.
- RPC creds live in this browser's localStorage only.

---

Built by [@kshot9000](https://x.com/kshot9000) for the Pearl (PRL) ecosystem.
Donations: `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`
