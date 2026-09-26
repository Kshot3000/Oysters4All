# hello-pearl

The smallest possible program that talks to a **Pearl** node (`pearld`) over its
JSON-RPC API. It asks the node for the current block count and best block hash —
a smoke test that your node is up and reachable.

## Prerequisites

- Node.js 18+
- A running `pearld` with RPC enabled. In your `pearl.conf`:
  ```
  rpcuser=youruser
  rpcpass=yourpass
  ```
- Default RPC ports: mainnet **44107**, testnet **18334**

## Setup

```bash
npm install
```

## Run

```bash
PEARL_RPCUSER=youruser PEARL_RPCPASS=yourpass PEARL_RPCHOST=localhost PEARL_RPCPORT=44107 npm start
```

Expected output:

```
Connected to pearld @ localhost:44107
Block count: 123456
Best block hash: 00000000...
```

## How it works

Pearl's RPC API mirrors Bitcoin's JSON-RPC: every call is an HTTP POST with a
JSON body `{ jsonrpc, method, params, id }`, authenticated with HTTP Basic Auth
(rpcuser / rpcpass). `src/index.ts` wraps that in a tiny `rpc()` helper, then
calls `getblockcount` and `getbestblockhash`. See the full method list in the
upstream docs: `hidden_files/upstream/node/docs/json_rpc_api.md`.
