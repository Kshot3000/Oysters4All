# Pearl Rig — GPU Mining Profitability Planner

A single-page planner for Pearl (PRL) GPU mining economics: rig wall power,
electricity rate and pool fees priced against the **exact** upstream
block-subsidy formula and the live PRL/USD market. Zero dependencies —
plain HTML/CSS/JS, works from any static host.

Live: https://kshot3000.github.io/Pearl-Muse-24-7-Ai-builder/pages/rig/

## What it does

- **Live PRL price** — CoinGecko `pearl-2` (aggregated, CORS-open) by default;
  CoinEx `PEARLUSDT` alternate via the bundled `proxy.mjs`; manual override.
- **Exact emission math** — `js/rig-core.js` replicates upstream
  `CalcBlockSubsidy` (`node/blockchain/validate.go` @ 3fe2267) with BigInt
  integer division, verified against upstream `emission_test.go` vectors.
- **Fleet builder** — per-GPU wall power, with a sourced CMP 90HX preset
  (180 W measured, from `docs/rig-benchmarks.md` in
  chernuha-dev/miner-cpm90hx-pearl, 2026-09-27).
- **Two revenue modes** — measured pool output (recommended) or
  TH/s × community yield factor (0.0241 PRL/TH/day preset from
  spark-pearl-miner `docs/en/VIABILITY.md`, 2026-09-26 snapshot).
- **Results** — gross/net per day, pool fees, power cost, margin, monthly/yearly
  net, break-even on hardware capex, and a price-sensitivity table.
- All state in `localStorage`; nothing is signed or broadcast.

## Price sources

| Source | Endpoint | Notes |
|---|---|---|
| CoinGecko (default) | `https://api.coingecko.com/api/v3/coins/pearl-2` | PRL/USD aggregate ✅ CORS-open |
| CoinEx (alternate) | `https://api.coinex.com/v2/spot/ticker?market=PEARLUSDT` | ❌ no CORS headers — needs `proxy.mjs` |

> **Market-name trap:** Pearl (the L1) trades on CoinEx as **PEARLUSDT** —
> `PRLUSDT` is a different token.

For the CoinEx source:

```sh
cd pages/rig
node proxy.mjs          # listens on http://127.0.0.1:8787
```

Then set **proxy base** in the app to `http://127.0.0.1:8787` (routes
`/coinex/* → https://api.coinex.com/*` with CORS headers added).

## Tests

```sh
cd pages/rig
node --test tests/rig.test.mjs   # 20/20: subsidy vectors, plan math, parsers, formatters
node --test tests/dom.test.mjs    # 3/3: id wiring, attribution, cache keys
node --check js/rig-core.js && node --check js/app.js
```

The subsidy tests pin the upstream formula at heights 1 / 650,226 / 1,300,452 /
3,251,130 against the documented 3229.64 / 807.41 / 358.85 / 89.71 PRL vectors.

## Honest limits

- No network-hashrate/difficulty feed is modeled; **measured pool output beats
  every estimate**. Short-window share counts are noisy (the cited rig benchmark
  says so explicitly).
- Yield factors drift with difficulty and the decaying subsidy — the planner
  snapshots today; recalibrate from your pool.
- Planning aid, not financial advice.

---
Built for the Pearl (PRL) community · [@kshot9000](https://x.com/kshot9000) ·
donations: `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`
