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
- Default RPC ports: mainnet **44107**, testnet **44109** (testnet2 **44111**;
  regtest **18334**). Source: upstream `node/params.go`.

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
(rpcuser / rpcpass). `src/lib.ts` holds the pure, testable helpers (`readConfig`, `basicAuth`,
`rpcEndpoint`, `rpcBody`, `parseRpcResponse`, `rpc`); `src/index.ts` is the thin
CLI that wires them together.

## Tests

Zero new dependencies — plain `node:test` run through `tsx`:

```bash
npm test        # 13 tests: config/env, request builders, stub-server RPC calls
npm run typecheck
```

See the full method list in the
upstream docs: `hidden_files/upstream/node/docs/json_rpc_api.md`.

## Support this work

Built by [@kshot9000](https://x.com/kshot9000) for the Pearl community.

💠 Donate PRL: `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`
