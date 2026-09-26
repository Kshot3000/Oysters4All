# Pearl Mining Calculator — `pages/mining/`

Static, zero-dependency PRL mining profitability calculator + emission
schedule visualizer. Live at
https://kshot3000.github.io/Pearl-Muse-24-7-Ai-builder/pages/mining/

## What it does

- **Reward calculator** — enter a block height, your hashrate and the network
  hashrate (or pull them from your own `pearld` node), plus optional PRL price
  and power costs. Outputs: exact block subsidy at that height, your share of
  network useful work, expected PRL/day/week/30d/year, USD revenue, power cost,
  net profit and break-even PRL price.
- **Emission schedule** — canvas chart of the block-subsidy curve (log scale)
  and the cumulative-supply curve (of 2.1B max), with a milestone table. Every
  number is computed in-page from the exact formula below — nothing hardcoded.
- **Live node panel** — `getblockcount` + `getmininginfo` against any
  `pearld` JSON-RPC endpoint; endpoint + basic-auth persist in localStorage.
  Honest disconnected state; no fake data.
- **Mining primer** — PoUW/vLLM/NoisyGEMM overview, sm90 GPU requirement,
  salted-seed fork note (`requiredcertversion: 3` at/after mainnet height
  99000), quickstart from the upstream miner README.

## Emission math (verified against upstream)

Mirrors `CalcBlockSubsidy` in `node/blockchain/validate.go`
(pearl-research-labs/pearl @ 3fe2267) with exact BigInt integer arithmetic:

```
subsidy(h) = 2_100_000_000 PRL × 650226 / ((h + 650226) × (h − 1 + 650226))   [grains]
```

- `EMISSION_CONSTANT = (4·365·24·3600) / 194 = 650226` — 194 s is
  `TargetTimePerBlock` on all networks (`node/chaincfg/params.go`).
- `TOTAL_SUPPLY = 2_100_000_000 × 1e8` grains (`totalSupply`, validate.go).
- Verified against upstream `emission_test.go` expectations:
  h=1 → 3229.64134063 PRL · h=650226 → 807.41219776 PRL ·
  h=1300452 → 358.84977369 PRL · h=3251130 → 89.71242042 PRL.
- Cumulative supply uses the telescoping closed form from the same test file:
  `supply(h) = 2.1B × h / (h + 650226)`.

Pearl mining = Proof-of-Useful-Work via the vLLM miner plugin
(`miner/` in the monorepo: NoisyGEMM CUDA kernels, NVIDIA sm90/H100/H200).
Reward estimates assume your blocks-found share ≈ your share of network useful
work (`getmininginfo` → `networkhashps`). Difficulty retargets (WTEMA), the
subsidy decays every block, and tx fees are excluded — all stated on the page.

## Files

- `index.html` — page structure
- `styles.css` — dark + luminous theme, animated aurora background
- `app.js` — calculator, charts, RPC client (no libraries)

## Publish

This directory is served as-is by GitHub Pages from the repo root (`/`).
No build step. The page is linked from the site homepage nav + ecosystem card.

---

Built by [@kshot9000](https://x.com/kshot9000) for the Pearl community.
Donations: `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`
