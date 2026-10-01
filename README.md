# Pearl-Muse-24-7-Ai-builder

Autonomous builder workspace for the **Pearl Blockchain** — maintained 24/7 by Muse.

## What is Pearl?

Pearl (PRL) is a Layer-1 blockchain using **Proof-of-Useful-Work (PoUW)**. Instead of
Bitcoin-style hash puzzles, miners perform matrix multiplication — the same
computation GPUs use for AI inference — so the work that secures the chain can
simultaneously serve real AI compute demand. It is a Bitcoin fork (UTXO model,
longest-chain rule) with Taproot-only addresses, post-quantum signature opcodes,
and Plonky2 zk-SNARK block certificates.

- Official code: https://github.com/pearl-research-labs/pearl
- This builder repo: https://github.com/Kshot3000/Pearl-Muse-24-7-Ai-builder

## Planned apps (in progress)

| App | Status | Description |
|---|---|---|
| `index.html` (Pearl website) | ✅ live | Recreated project homepage — PoUW explainer, mining quickstart, dev docs, ecosystem. Served via GitHub Pages |
| `examples/hello-pearl` | ✅ scaffolded | Minimal TypeScript JSON-RPC client — your first `pearld` connection |
| `pearl-rpc-client` | ✅ built | Fuller typed TypeScript RPC client library (20+ methods; typechecked + built) |
| `wallet-helper` | ✅ built | BIP-39/32/86 Taproot address derivation + Oyster wallet JSON-RPC helpers (27 tests, incl. official BIP-86 vectors) |
| `pages/explorer/` | ✅ built | Static block explorer querying a `pearld` RPC node |
| `pages/faucet/` | ✅ built | Static testnet faucet frontend (bech32m validation) + reference Node backend paying via Oyster `sendtoaddress` |
| `pages/prl20/` | ✅ built | Static Pearlscriptions / PRL-20 dashboard reading a configurable public indexer API |
| `pages/mining/` | ✅ built | PRL mining profitability calculator: exact upstream emission formula, hashrate-share rewards, emission-schedule charts, optional live node data |
| `guides/rpc-cheatsheet.md` | ✅ done | `pearld` JSON-RPC cheatsheet with `curl` examples, verified against upstream docs |
| `guides/running-pearld.md` | ✅ done | Running a Pearl node: prebuilt installer vs source build, first sync, networks + ports, enabling RPC, connectivity, Oyster wallet, mining hookup — all facts verified against upstream docs |
| `pages/psbt/` | ✅ built | Taproot PSBT signing workbench — create/inspect/sign/combine/finalize BIP-174 PSBTs with exact BIP-341 sighashes (keypath + scriptpath); crypto vendored from the audited sign core, 39 tests / 158 assertions |

## How the 24/7 builder loop works

1. **Every 2 hours** the builder wakes up and syncs the upstream Pearl mirror
   (kept in the goal workspace, never pushed).
2. It works the prioritized queue: fix broken builds → scaffold apps → improve docs.
3. Each run appends to `hidden_files/build-log.md` so you can see exactly what
   changed and why.
4. Finished work is **committed and pushed to `main`** automatically every run.

## Support this work

If this builder saved you time, donations are welcome:

**PRL:** `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`

**X:** [@kshot9000](https://x.com/kshot9000)

## Quick start

```bash
# 1. Build and run a pearld node (from the upstream mirror)
task build:pearld

# 2. Try the hello-pearl RPC example
cd files/examples/hello-pearl
npm install
PEARL_RPCUSER=youruser PEARL_RPCPASS=yourpass npm start
```

See `examples/hello-pearl/README.md` for details.
