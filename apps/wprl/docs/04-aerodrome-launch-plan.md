# wPRL Aerodrome Liquidity Launch Plan

**wPRL — Wrapped Pearl (Pearl PoUW L1 → Base).** How wPRL gets deep, honest
liquidity on Base. Primary venue: **Aerodrome** (Base's dominant DEX,
ve(3,3) model). Secondary: Uniswap v3 for aggregator routing.

## 1. Venue choice rationale

- Aerodrome is the liquidity layer of Base — where Base-native token
  launches happen, where veAERO voters direct AERO emissions, and where
  aggregators (1inch, Odos, Base's own routing) source depth.
- Uniswap v3 second: no incentives program needed, pure aggregator flow.
  Launch there in parallel with a narrow-range position seeded from the
  treasury.

## 2. The pool

- **Pair:** wPRL / USDC (native USDC on Base).
- **Type:** Aerodrome Slipstream **concentrated-liquidity** pool. wPRL is a
  volatile asset against USDC; a volatile-type pool is the honest choice —
  no stable-pool pretense.
- **Fee tier:** 0.30% (standard volatile tier; revisit after 30 days of
  volume data).
- Anyone can permissionlessly create the pool; LPs in non-gauge pools earn
  100% of swap fees directly (no AERO emissions until gauge approval).

## 3. Seed liquidity (protocol-owned)

Target at launch: **$50k–$100k TVL** in wPRL/USDC, seeded by the team
treasury (bridge fees + a dedicated liquidity allocation — **not** from
custodied user backing; backing PRL never leaves the vault for LP).

- Split: ~60% full-range Slipstream position (passive, always in range),
  ~40% concentrated around the CEX-anchored PRL price ±30% (capital
  efficient, actively managed weekly).
- LP tokens: **lock or burn the seed LP** to prove no rug — locked LP is
  the standard credible signal.

## 4. The incentives flywheel

Aerodrome's weekly epoch cycle:

1. **Token listing:** wPRL must be listed (Aerodrome's listing process)
   before the pool can receive a gauge and AERO emissions. Start the
   listing application the week of mainnet launch.
2. **Gauge:** once listed, the pool gets a gauge contract. LPs stake LP
   tokens in the gauge to earn AERO emissions + swap fees.
3. **Bribes:** the flywheel. Each epoch, deposit bribes (USDC or wPRL) on
   the pool's bribe contract *before* the epoch vote. veAERO holders vote
   where AERO emissions go; bribes buy their votes. Rule of thumb from
   observed markets: **$1 of bribe returns $1.50–$3 of AERO emissions**
   directed at your gauge (varies by epoch competitiveness — measure weekly,
   adjust).
4. **Flywheel:** bribes → votes → AERO emissions → LPs attracted → deeper
   pool → tighter spreads → more volume → more swap fees → LP stickiness
   beyond emissions.

**Budget guidance (12-week bootstrap):** $2k–$5k/week in bribes, remeasured
each epoch. Fund from bridge fee revenue (03) — the bridge literally pays
for its own liquidity. Stop or taper when organic volume sustains >50% of
target APR without bribes.

**Anti-mercenary measures:** locked seed LP (can't leave), protocol-owned
liquidity share ≥30% of pool at all times, and bribe tapering tied to
volume — mercenary LPs leave when emissions stop; POL doesn't.

## 5. Price anchoring & peg defense

wPRL should trade ≈ PRL (CEX price on SafeTrade/BigONE/CoinEx, ≈ $1.36 at
research time). The bridge itself is the peg mechanism: anyone can mint at
1:1 (minus 0.25%) or redeem at 1:1 (minus 0.25%), so persistent deviations
beyond ~0.5% are arbitraged away — **as long as the operator processes
mints/redeems promptly**. Operator SLA target: mint within 30 min of 6
confs; release within 2 hours of `WithdrawRequested`.

The proof-of-reserves dashboard (live on the bridge site) is the
credibility anchor — arbitrageurs check backing before they arb.

## 6. What NOT to do

- **No fake volume / wash trading.** Ever. It poisons aggregator routing
  data and destroys trust permanently.
- **No incentivizing with unbacked wPRL.** LP rewards paid in wPRL must be
  bought from the market or come from fee revenue — never minted against
  nothing. `mintDeposit` is operator-only and 1:1 against real deposits;
  keep it that way.
- **No "guaranteed APY" marketing.** Quote measured trailing APRs only.
- **No stable-pool pairing** wPRL/USDC — it's a volatile asset; mislabeled
  pools mislead LPs about impermanent loss.

## 7. Sequencing

| Week | Action |
|---|---|
| 0 (testnet) | Deploy on Base Sepolia; no liquidity needed beyond test swaps |
| Mainnet −4 | Finalize contracts, audit in progress, treasury LP allocation set |
| Mainnet −1 | Create wPRL/USDC Slipstream pool; seed POL; lock LP |
| Mainnet +0 | Bridge site live; reserves dashboard live; announce |
| Mainnet +1 | Submit Aerodrome token listing application |
| Mainnet +2..4 | Gauge live → begin bribe program; measure $/vote weekly |
| Mainnet +12 | Review: taper bribes if organic volume sustains; add Uniswap v3 position if aggregator share lags |

## 8. Kill criteria (honest)

If after 12 weeks: TVL < $25k sustained, or bribe ROI < $1 emissions per $1
bribed for 4 consecutive epochs — pause the bribe program, keep POL, and
reassess. Throwing fee revenue at a pool nobody trades in is worse than a
small honest pool.

---

## Attribution

Built by **@kshot9000** · PRL:
`prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d` · EVM
(Base): `0x4b6f3BC697D9dAF3e8dE182aEc56eD208B9087f1` ·
https://github.com/Kshot3000/Oysters4All
