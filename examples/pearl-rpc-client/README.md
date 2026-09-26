# pearl-rpc-client

A small, fully typed TypeScript JSON-RPC client for a **Pearl** node (`pearld`).
Built by [@kshot9000](https://x.com/kshot9000) for the Pearl community.

If `hello-pearl` is the smoke test, this is the real toolkit: 20 typed methods
covering chain data, blocks, mempool, transactions and peers — no `any`, no
guessing at response shapes.

## Install

```bash
npm install
npm run build   # typecheck + emit dist/
```

## Use

```ts
import { PearlRpcClient } from "./dist/index.js";

const pearl = new PearlRpcClient({
  host: "localhost",
  port: 44107,            // Pearl mainnet default RPC port
  user: "rpcuser",
  pass: "rpcpass",
});

const height = await pearl.getBlockCount();
const block  = await pearl.getBlockByHeight(height);
console.log(block.hash, block.tx.length, "txs");

const mempool = await pearl.getMempoolInfo();
console.log(mempool.size, "txs waiting");
```

Credentials can also come from env vars (`PEARL_RPCHOST`, `PEARL_RPCPORT`,
`PEARL_RPCUSER`, `PEARL_RPCPASS`); explicit options win.

## Demo

```bash
PEARL_RPCUSER=rpcuser PEARL_RPCPASS=rpcpass npm run demo
```

Prints chain status, difficulty, mempool size and a summary of the latest block.

## Methods

| Group | Methods |
|---|---|
| Chain | `getBlockCount`, `getBestBlockHash`, `getBlockHash`, `getBlock`, `getBlockByHeight`, `getBlockHeader`, `getChainTips`, `getDifficulty`, `getInfo`, `getMiningInfo` |
| Mempool / tx | `getMempoolInfo`, `getRawMempool`, `getRawTransaction`, `decodeRawTransaction`, `sendRawTransaction` |
| Network | `getConnectionCount`, `getPeerInfo`, `validateAddress` |
| Escape hatch | `call(method, params)` for anything else |

Note: pearld is btcd-style — it exposes **both** `getinfo` and
`getblockchaininfo` (verified against upstream `node/rpcserver.go`: both are
registered; `getblockchaininfo` returns the Bitcoin-style `Chain` / `Blocks` /
`Headers` / `BestBlockHash` / `Difficulty` field set).
Result shapes were taken from the upstream API docs
(`pearl-research-labs/pearl`, `node/docs/json_rpc_api.md`).

## Tests

Zero new dependencies — plain `node:test` run through `tsx`, with `fetch`
stubbed (no live node needed):

```bash
npm test        # 15 tests: constructor/env, wire format, error handling, wrappers
npm run typecheck
npm run build   # emits dist/
```

## Support this work

💠 Donate PRL: `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`
