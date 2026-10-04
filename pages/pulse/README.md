# Pearl Pulse — Live PRL Portfolio & Network Dashboard

Watch-only, read-only Pearl (PRL) portfolio tracker + live network dashboard.
Part of the [Pearl builder hub](https://kshot3000.github.io/Pearl-Muse-24-7-Ai-builder/)
lineup (Token Studio · Pearl Pay · Pearl Foundry · Pearl Vault · Pearl Bazaar · **Pulse**).

**Live:** https://kshot3000.github.io/Pearl-Muse-24-7-Ai-builder/pages/pulse/

## What it does

- **Portfolio card** — total PRL + USD value across every watched address.
- **Market card** — live PRL/USDT price (last, 24h change, high/low, volume) from
  the public CoinEx ticker.
- **Network card** — chain tip height, sync state, mempool size, last-block age,
  backend version from the public blockbook API.
- **Watchlist** — add any `prl1…` address (validated in-browser: bech32m, witness
  v1+ — the same rules `pearld` enforces); per-address balance, total
  received/sent, transaction count; balances cached in `localStorage`.
- **Transactions** — click "txs" on a watched address for its latest 25
  transactions with per-address received/sent/net/fee/confirmations and
  blockbook deep links.
- **Settings** — configurable blockbook + CoinEx base URLs, auto-refresh
  interval, demo mode (fixtures, clearly labeled), JSON export, one-click clear.

## Tech

Pure HTML + CSS + vanilla JS ES modules. **Zero dependencies, zero build step.**
The pure logic lives in `js/pulse-core.js` and is shared with the node test
suite — no placeholders.

## Data sources (all GET, read-only, unauthenticated)

| Feed | Endpoint | Used for | In-browser? |
|---|---|---|---|
| CoinGecko | `https://api.coingecko.com/api/v3/coins/pearl-2` (id `pearl-2`, symbol PRL) | PRL/USD price, 24h change/high/low/volume, mcap rank | ✅ CORS-open, works directly |
| Blockbook | `https://blockbook.pearlresearch.ai/api/v2` | `/status`, `/address/<addr>?details=basic\|txs` | ❌ no CORS headers — needs `proxy.mjs` |
| CoinEx (alternate) | `https://api.coinex.com/v2/spot/ticker?market=PEARLUSDT` | PRL/USDT single-exchange price | ❌ no CORS headers — needs `proxy.mjs` |

> **Market-name trap:** Pearl (the L1) trades on CoinEx as **PEARLUSDT** —
> `PRLUSDT` is a different token (this was caught and fixed after real-browser
> QA: the first version briefly priced the wrong market). CoinGecko aggregates
> across exchanges (SafeTrade, BigONE, CoinEx…) and is the default source.

The CoinGecko price is an **aggregate**, labeled as such. The UI stamps every
card with its source and fetch time; unreachable backends produce honest error
states instead of invented numbers.

Address validation: Pearl addresses are **bech32m (BIP-350), witness v1+ only**
(verified against upstream `node/btcutil/address.go` `decodeSegWitAddress` —
v0 and non-bech32m encodings are rejected; HRPs `prl`/`tprl`/`rprl`).

## Live chain data in your browser (CORS)

The blockbook API and CoinEx ticker don't send CORS headers, so browsers refuse
direct reads (server-side tools like `curl` work fine — they don't enforce
CORS). Two options:

1. **Price only:** the default CoinGecko source works with zero setup.
2. **Full live data (chain status, balances, transactions):** run the bundled
   zero-dependency proxy, then point the blockbook base URL at it:

   ```sh
   cd pages/pulse
   node proxy.mjs          # listens on http://127.0.0.1:8787
   ```

   In Pearl Pulse → Settings set **Blockbook API base** to
   `http://127.0.0.1:8787/blockbook` (and optionally the CoinEx base to
   `http://127.0.0.1:8787/coinex` for the alternate price source). Save — the
   app fetches through the proxy with CORS headers added. Everything stays on
   your machine; the proxy only forwards your own GET requests.

## Security

Watch-only by design: the page never asks for private keys, seeds, or
signatures, and never broadcasts anything. `localStorage` holds only public
addresses, labels, and cached balances.

## Tests

`node --test tests/verify.mjs` — 33/33 green: address validation vectors
(valid mainnet P2TR, uppercase, whitespace, mixed-case, checksum mutation,
witness-v0 rejection, Bitcoin HRP rejection, base58 rejection, tprl/rprl,
oversize program), money formatting, `timeAgo`, live-captured blockbook
status/address fixtures (2026-09-27), live-captured CoinEx **PEARLUSDT** ticker
fixture (changePct math) and CoinGecko `pearl-2` fixture, per-address
received/sent/net/direction, portfolio totals. Five source pins cover the
2026-10-04 XSS hardening: backend-supplied txids/confirmations and
persisted watchlist addresses are escaped before every `innerHTML`
render, and persisted watchlist entries are re-validated (bech32m,
mainnet) on load. Plus `node proxy.mjs`
smoke-tested locally (blockbook status/address + CoinEx through the proxy,
`access-control-allow-origin: *` present).

## Support the build

PRL: `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d` ·
X: [@kshot9000](https://x.com/kshot9000)

Community-built; not affiliated with pearl-research-labs. Feeds are live
third-party data — verify before acting.
