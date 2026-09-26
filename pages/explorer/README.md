# Pearl Block Explorer (static)

A zero-dependency static block explorer for Pearl (PRL) that talks directly to a
`pearld` JSON-RPC endpoint. No server, no build step.

- Live at: https://kshot9000.github.io/Pearl-Muse-24-7-Ai-builder/pages/explorer/
  (GitHub Pages serves this repo's root; `pages/` is a static subdirectory)
- Source: `pages/explorer/` — `index.html`, `styles.css`, `app.js`

## Features

- **Chain status**: best height, best hash, chain, difficulty, connections, headers
  (via `getblockchaininfo` / `getblockcount`)
- **Block lookup** by height or hash (via `getblockhash` / `getblock`), with
  coinbase-marked transaction list
- **RPC settings**: endpoint URL + optional basic-auth credentials, persisted in
  `localStorage` (never leaves the browser except as RPC calls to your endpoint)
- **Donate footer** with the Pearl donation address and copy button

## RPC methods used (all standard pearld/btcd methods)

| Method            | Purpose                          |
|-------------------|----------------------------------|
| `getblockchaininfo` | chain, blocks, headers, difficulty |
| `getblockcount`     | fallback best height             |
| `getblockhash`      | height → hash                     |
| `getblock <hash> 1` | full block with txids              |

Addresses on Pearl use the `prl1` bech32 prefix (Taproot-only, like the
`pearld` node from pearl-research-labs/pearl). Default RPC host in the
node's client examples is `127.0.0.1:8332`.

## Running locally

```sh
cd pages/explorer
python3 -m http.server 8080
# open http://127.0.0.1:8080
```

## Connecting a node

Browsers enforce CORS, so `pearld` (or its proxy sidecar, `node/proxy` in the
upstream monorepo) must return `Access-Control-Allow-Origin` for this page's
origin. Options:

1. Serve the explorer page **from the same origin** as the RPC endpoint
   (e.g. behind a Caddy reverse proxy) — no CORS needed.
2. Enable CORS headers on the RPC terminator for the explorer's origin.
3. Run a local CORS-anywhere style dev proxy (not for production).

RPC auth is HTTP Basic. Credentials stay in `localStorage` of the browser that
enters them.

## Publishing

GitHub Pages is already serving the repo root (`/`). This subdirectory is
published automatically on every push — no extra config needed. If you fork this
page into its own repo, enable Pages on that repo (branch `main`, path `/`).

---

Built by [@kshot9000](https://x.com/kshot9000) for the Pearl community.
Donate PRL: `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`
