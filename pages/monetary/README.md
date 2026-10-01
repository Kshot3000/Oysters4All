# Pearl Monetary — the PRL issuance & halving desk

The central-bank desk for Pearl (PRL): exact block-subsidy math, the full
issuance curve, the era schedule, and explorer tools. Client-side only — no
backend, no wallet, no keys.

## What it does

- **Overview** — current era, live block height (Blockbook probe with a dated,
  honestly-labeled stale-snapshot fallback), current block subsidy, next
  decay-milestone countdown (blocks + estimated date at 194 s/block), issued
  supply, era progress.
- **Issuance chart** — SVG supply curve (% of 2.1B PRL) + subsidy decay curve
  (log PRL/block) from genesis to full emission, with a "you are here" marker.
- **Schedule** — era table: era n is heights (n·650,226, (n+1)·650,226]; subsidy
  at era start, % issued during the era, cumulative at era end.
- **Tools** — height→reward lookup, date→estimated height/reward, PRL↔grains
  converter, coinbase maturity explainer (100 blocks).
- **Methodology** — the formula, the upstream sources, and every honesty caveat.

## The math (exact upstream port)

`src/logic.js` ports `CalcBlockSubsidy` from `node/blockchain/validate.go`
grain-for-grain using BigInt (big.Int division truncates — so does BigInt):

```
subsidy(h) = ⌊ 2.1e9·1e8 · 650226 / ((h+650226)·(h−1+650226)) ⌋  grains, h ≥ 1
subsidy(0) = 0
```

Pearl has no hard halving: each era issues `100/((n+1)(n+2))%` of supply
(50%, 16.67%, 8.33%, …). Cumulative supply uses the closed form
`⌊S·h/(h+C)⌋`, exact to within one grain per block of truncation.

Test vectors pinned to `node/blockchain/emission_test.go`:
h=1 → 3229.641 PRL, h=650226 → 807.412, h=1300452 → 358.850,
h=1950678 → 201.853, h=3251130 → 89.712, h=6502260 → 26.691,
h=32511300 → 1.242.

## Build & test

```bash
node build.mjs                        # emits pearl-monetary.bundle.js (committed)
node --test tests/logic.test.mjs      # 12 unit tests
```

## Sources

- `node/blockchain/validate.go` — `CalcBlockSubsidy`
- `node/blockchain/emission_test.go` — test vectors
- `node/chaincfg/params.go` — `TargetTimePerBlock` = 194 s, `CoinbaseMaturity` = 100
- `node/btcutil/const.go` — `GrainPerPearl = 1e8`
- Live height: `GET https://blockbook.pearlresearch.ai/api/v2` → `blockbook.bestHeight`

Built by [@kshot9000](https://x.com/kshot9000).
Donate PRL: `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`
