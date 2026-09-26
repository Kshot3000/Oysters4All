# Pearl testnet faucet — reference backend

Zero-dependency Node.js backend for the static faucet frontend at
`pages/faucet/`. It rate-limits drip requests and pays out **tPRL** from your
own funded **Oyster** wallet on the Pearl testnet.

Live frontend (after push to `main`):
https://kshot3000.github.io/Pearl-Muse-24-7-Ai-builder/pages/faucet/

## How it works

- `GET /api/status` → `{ network, maxDripPRL, dripCooldownHours, dailyCapPRL, walletConfigured }`
- `POST /api/drip` with `{ "address": "tprl1…", "network": "testnet" }` →
  validates the bech32m address locally, enforces 1 drip / address / 24h plus a
  rolling 24h daily cap (recorded in `drips.json`), then calls the Oyster wallet
  daemon's legacy JSON-RPC **`sendtoaddress`** and returns the real txid.

Protocol facts used here were verified against the upstream mirror
(`pearl-research-labs/pearl`, master @ `3fe2267`):

- testnet and testnet2 both use the `tprl` bech32 HRP
  (`node/chaincfg/params.go` `Bech32HRPSegwit`)
- Oyster legacy JSON-RPC listen defaults: `127.0.0.1:44209` (testnet),
  `44211` (testnet2), `44207` (mainnet) — `wallet/config.go`
  `LegacyRPCListeners`; wallet RPC methods include `sendtoaddress`
  (`wallet/btcwallet.go`)

## Run it

```bash
cd examples/faucet-backend
cp .env.example .env
# edit .env: set OYSTER_RPC_USER and OYSTER_RPC_PASS to your Oyster
# wallet daemon's RPC credentials (--rpcuser/--rpcpass or oyster.conf)
node server.js
# → Pearl faucet backend on http://127.0.0.1:8090 (network=testnet)
```

Prerequisites: a `pearld` testnet node and a funded **Oyster** wallet on testnet
(see the upstream `wallet/README.md`: build with `task build:blockchain`, create
the wallet with `oystercli`, fund it from mining or another faucet).

Without wallet credentials the server still starts, but `GET /api/status`
reports `walletConfigured: false` and every drip is refused with HTTP 503 —
**no fake txids are ever returned.**

## Configuration (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | `8090` / `127.0.0.1` | HTTP listen address |
| `FAUCET_NETWORK` | `testnet` | `testnet` or `testnet2` (both `tprl`) |
| `MAX_DRIP_PRL` | `1` | tPRL per drip |
| `DRIP_COOLDOWN_HOURS` | `24` | per-address cooldown |
| `DAILY_CAP_PRL` | `100` | rolling 24h payout cap |
| `OYSTER_RPC_URL` | `http://127.0.0.1:44209` | Oyster legacy JSON-RPC |
| `OYSTER_RPC_USER` / `OYSTER_RPC_PASS` | — | required for payouts |
| `CORS_ORIGIN` | `*` | allowed browser origin |
| `STORE_FILE` | `./drips.json` | drip history (rate limiting) |

## Tests

Zero dependencies — the suite uses only Node's built-in test runner:

```bash
npm test        # 31 tests: unit + integration
npm run check   # node --check on server.js, lib.js, and both test files
```

- `test/unit.test.js` — pure-function tests for `lib.js`: bech32m decoding,
  Pearl address policy (v1+ only, `tprl` HRP), per-address cooldown and the
  rolling 24h daily cap. Address vectors are independently generated from the
  official BIP-86 known-answer output key.
- `test/integration.test.js` — boots the real `server.js` over HTTP with a
  stub Oyster JSON-RPC and drives `/api/status` + `/api/drip` end to end:
  malformed input (400s), cooldown 429, daily-cap 429, the honest 503 when no
  wallet is configured (no fake txids), and drip persistence to the store file.

## Operating notes

- Keep `OYSTER_RPC_*` and `drips.json` private; never commit a filled-in `.env`.
- The faucet wallet should hold only what you are willing to give away.
  Sweep excess funds back to cold storage regularly.
- Put the backend behind HTTPS (e.g. the upstream `proxy/` Caddy sidecar) before
  pointing the public Pages frontend at it; set `CORS_ORIGIN` to the Pages URL.

## Standing requirements

- Donations: `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`
- Built by [@kshot9000](https://x.com/kshot9000)
