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
| `examples/hello-pearl` | ✅ scaffolded | Minimal TypeScript JSON-RPC client — your first `pearld` connection |
| `pearl-rpc-client` | 🔲 queued | Fuller typed RPC client library |
| `wallet-helper` | 🔲 queued | Address generation & balance lookup helpers |
| `block-explorer-stub` | 🔲 queued | Static explorer page querying a local node |

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
