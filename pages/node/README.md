# Pearl Node — pearld Operator Console

Read-only mission-control console for your own `pearld` node: chain status,
peer table, mempool depth, and mining telemetry over JSON-RPC. No build step —
open `index.html` directly or serve the folder.

**Live:** https://kshot3000.github.io/Oysters4All/pages/node/

## What it does

Five tabs, all read-only:

- **Overview** — node health notes (errors, isolation, forks, stale peers,
  clock offset), plus cards for block height, difficulty, network hashrate,
  peers, mempool, version, bandwidth, and best-block tip.
- **Peers** — sortable `getpeerinfo` table (ping, direction, height, conn age,
  bytes, user agent) with SYNC / IN / OUT / STALE badges.
- **Mempool** — `getmempoolinfo` depth + average tx size, `pooledtx`
  cross-check against `getmininginfo`, min relay fee.
- **Mining** — `getmininginfo` telemetry: networkhashps, difficulty, generate,
  own hashespersec, proc limit, pooled tx, last-block size/tx count.
- **Settings** — relay endpoint, RPC credentials, network preset, poll
  interval, plus the relay and `pearl.conf` setup guides.

The page only ever calls six RPC methods: `getinfo`, `getmininginfo`,
`getmempoolinfo`, `getpeerinfo`, `getnettotals`, `getchaintips`. Method names
and result fields verified against upstream
`node/docs/json_rpc_api.md` (pearl-research-labs/pearl @ 3fe2267).

## Connecting a node

Browsers cannot call `pearld` directly (no CORS headers; TLS with a
self-signed cert by default). Run the bundled zero-dependency relay on the
node machine:

```sh
PEARLD_RPC=http://127.0.0.1:44107 \
PEARLD_USER=your-rpcuser PEARLD_PASS=your-rpcpass \
node relay.mjs
```

Then point the console at `http://127.0.0.1:44120/rpc` (the default). The
relay forwards only the six read-only methods, binds to 127.0.0.1, and
accepts the node's self-signed cert on your behalf. `pearld` RPC must be
enabled first (`rpcuser` + `rpcpass` in `pearl.conf`).

## Honest limits

- Read-only: the console cannot stop the node, change config, or move funds.
- Health notes are heuristics, not consensus.
- Testnet is flagged from `getinfo.testnet`; a settings/network mismatch
  raises a loud warning.
- Credentials are stored in the browser's localStorage as typed — treat the
  browser profile as holding a credential.
- No fee histogram exists: `pearld` exposes mempool size/bytes only.

## Tests

- `node --test tests/node.test.mjs` — 14 core tests (formatters, settings
  validation, RPC classification, peer/health logic).
- `node --test tests/dom.test.mjs` — 9 DOM tests driving the real `app.js`
  against a strict shim with canned RPC.
- `node ~/workspace/goals/pearl-blockchain-24-7-builder/hidden_files/qa-node-browser.mjs`
  — real-browser QA (headless Chromium, stubbed fetch, zero console errors).

Rebuild the bundle after editing `src/`: `node build.mjs` (esbuild).

---

Built by [@kshot9000](https://x.com/kshot9000) · tips:
`prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`
