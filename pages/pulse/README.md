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

| Feed | Endpoint | Used for |
|---|---|---|
| Blockbook | `https://blockbook.pearlresearch.ai/api/v2` | `/status`, `/address/<addr>?details=basic\|txs` |
| CoinEx | `https://api.coinex.com/v2/spot/ticker?market=PRLUSDT` | PRL/USDT price |

The CoinEx price is a **single-exchange** price, labeled as such — not a market
index. The UI stamps every card with its source and fetch time; unreachable
backends produce honest error states instead of invented numbers.

Address validation: Pearl addresses are **bech32m (BIP-350), witness v1+ only**
(verified against upstream `node/btcutil/address.go` `decodeSegWitAddress` —
v0 and non-bech32m encodings are rejected; HRPs `prl`/`tprl`/`rprl`).

## Security

Watch-only by design: the page never asks for private keys, seeds, or
signatures, and never broadcasts anything. `localStorage` holds only public
addresses, labels, and cached balances.

## Tests

`node --test tests/verify.mjs` — 25/25 green: address validation vectors
(valid mainnet P2TR, uppercase, whitespace, mixed-case, checksum mutation,
witness-v0 rejection, Bitcoin HRP rejection, base58 rejection, tprl/rprl,
oversize program), money formatting, `timeAgo`, live-captured blockbook
status/address fixtures (2026-09-27), live-captured CoinEx ticker fixture
(changePct math), per-address received/sent/net/direction, portfolio totals.

## Support the build

PRL: `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d` ·
X: [@kshot9000](https://x.com/kshot9000)

Community-built; not affiliated with pearl-research-labs. Feeds are live
third-party data — verify before acting.
