# Pearl Block Explorer (static)

A zero-dependency static block explorer for Pearl (PRL) that talks directly to a
`pearld` JSON-RPC endpoint. No server, no build step.

- Live at: https://kshot9000.github.io/Oysters4All/pages/explorer/
  (GitHub Pages serves this repo's root; `pages/` is a static subdirectory)
- Source: `pages/explorer/` — `index.html`, `styles.css`, `app.js`

## Features

- **Chain status**: best height (via `getblockcount`), best block hash
  (via `getbestblockhash`), and chain, difficulty, connections and protocol
  version (via `getinfo`)
- **Block lookup** by height or hash (via `getblockhash` / `getblock`), with
  coinbase-marked transaction list
- **RPC settings**: endpoint URL + optional basic-auth credentials, persisted in
  `localStorage` (never leaves the browser except as RPC calls to your endpoint)
- **Donate footer** with the Pearl donation address and copy button

## RPC methods used (all standard pearld/btcd methods)

| Method            | Purpose                          |
|-------------------|----------------------------------|
| `getinfo`         | chain (testnet flag), difficulty, connections, protocol version |
| `getblockcount`   | best block height                |
| `getbestblockhash` | hash of the best block          |
| `getblockhash`    | height → hash                    |
| `getblock <hash> 1` | full block with txids          |

Addresses on Pearl use the `prl1` bech32m prefix (Taproot-only, like the
`pearld` node from pearl-research-labs/pearl). The pearld JSON-RPC port is
`44107` on mainnet.

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

## Tests

```sh
cd pages/explorer
node --test tests/explorer.test.mjs   # pure helpers: fmtTime/fmtNum/escapeHtml,
                                      # height-vs-hash split, JSON-RPC envelope
node --test tests/dom.test.mjs        # id wiring, cache pins, attribution, and
                                      # docs naming exactly the RPC methods
                                      # app.js calls (no more, no fewer)
```

`app.js` exports its pure helpers to Node when no DOM is present; the browser
path is unchanged.

## Publishing

GitHub Pages is already serving the repo root (`/`). This subdirectory is
published automatically on every push — no extra config needed. If you fork this
page into its own repo, enable Pages on that repo (branch `main`, path `/`).

---

Built by [@kshot9000](https://x.com/kshot9000) for the Pearl community.
Donate PRL: `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`
