# Pearl Testnet Faucet (static frontend)

Zero-dependency static page that requests **tPRL** (testnet Pearl) from a
faucet backend you run yourself. Live once pushed to `main` (GitHub Pages serves
the repo root):

https://kshot3000.github.io/Oysters4All/pages/faucet/

## What it does

- Validates Pearl bech32m segwit addresses **locally in the browser**
  (BIP-350 checksum + witness v1+ rules; `tprl` HRP on testnet/testnet2 —
  verified against `node/btcutil/address.go` `decodeSegWitAddress` in the
  upstream mirror: Pearl rejects witness v0 entirely).
- POSTs `{ address, network }` to the configured faucet backend
  (`POST /api/drip`) and shows the real txid or the backend's real error.
- Polls `GET /api/status` for backend health (network, max drip, cooldown,
  wallet-connected state).
- Backend URL persists in `localStorage`; defaults to `http://127.0.0.1:8090`.

## What it does NOT do

- No keys, no signing, no custody — the page never touches private keys.
- No fake data: without a reachable backend every action shows an honest
  "backend unreachable / not configured" state. Mainnet `prl1…` addresses are
  rejected; this faucet is testnet-only by design.

## Backend

Reference implementation: `examples/faucet-backend/` (Node.js, zero
dependencies). It rate-limits drips and pays out via the **Oyster** wallet
daemon's legacy JSON-RPC (`sendtoaddress`; default listen `127.0.0.1:44209` on
testnet, `44211` on testnet2 — from Oyster's `wallet/config.go`).

## Local preview

```bash
cd <repo-root>          # files/ in the builder workspace
python3 -m http.server 8080
# open http://localhost:8080/pages/faucet/
# (optionally run examples/faucet-backend locally first)
```

## Tests

```bash
node --test tests/faucet.test.mjs  # 19: bech32m decode/validate — real mainnet
                                   # vector, independent-encoder tprl vectors,
                                   # v0/padding/length/case/tamper rejections,
                                   # esc() markup neutralization
node --test tests/dom.test.mjs     # 6: id wiring, ?v= pins, attribution,
                                   # testnet-only network select, backend-hint
                                   # escaping pin
```

## Standing requirements

Donation address and X account are in the page footer + donate section:
- PRL: `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`
- X: [@kshot9000](https://x.com/kshot9000)
