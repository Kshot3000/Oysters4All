# wPRL Fee Economics

**wPRL — Wrapped Pearl (Pearl PoUW L1 → Base).** Exact fee math, where fees
go, and what the bridge costs to run.

## 1. Fee schedule — 0.25% each way

Defined **once** as `BRIDGE_FEE_BPS = 25` (denominator 10,000). Every
surface — contracts, backend, web UI — reads the same value, so the fee the
UI quotes is the fee the chain charges.

| Leg | Fee | Direction |
|---|---|---|
| Deposit (PRL → wPRL) | 0.25% of deposited PRL | Paid on the Pearl chain, in PRL |
| Withdraw (wPRL → PRL) | 0.25% of burned wPRL | Paid on Base, in wPRL |

## 2. Exact rounding rules (tested)

Rounding is not a detail you can fudge — it determines who gets dust.

- **Deposit (backend, `deposit.js`):** fee = **ceil**(`depositGrains * 25 / 10000`).
  The user sends `deposit + fee` as two outputs: the full amount to the
  vault, the ceiling fee to the Pearl fee address. Ceil means the bridge
  never under-collects on tiny deposits.
- **Withdraw (on-chain, `WPRLBridge.requestWithdraw`):** fee = **floor**
  (`amountWei * 25 / 10000`), integer division on `uint256`. The fee is
  taken in wPRL to the EVM fee address; the remaining `amount - fee` is
  burned, and the operator releases that many PRL (via the grains→wei
  conversion, sub-grain dust truncated).
- **Web UI** mirrors both rules exactly (verified: 8/8 unit tests assert
  backend-parity on ceil and contract-parity on floor).

## 3. Worked examples

- Deposit **10 PRL** → fee **0.025 PRL** to the fee address, **10 wPRL**
  minted to your Base address. (Verified in browser QA.)
- Withdraw **5 wPRL** → fee **0.0125 wPRL** to the fee address, **4.9875
  PRL** released to your `prl1…` address. (Verified in browser QA.)
- E2E simulation: deposit 2.5 PRL → exact 2.5 wPRL minted; withdraw 1 wPRL
  → 0.9975 PRL release; final supply 1.5025 wPRL with the 0.0025 fee sitting
  in the fee address. (Verified in Hardhat e2e.)

## 4. Where fees go

| Leg | Fee asset | Recipient |
|---|---|---|
| Deposit | PRL | `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d` (builder's PRL fee address) |
| Withdraw | wPRL | `0x4b6f3BC697D9dAF3e8dE182aEc56eD208B9087f1` (builder's Base fee address) |

Fee addresses are public by design and shown on the website fee schedule.
They are plain EOAs/vault addresses today; moving them to a multisig or
treasury contract is a handoff item for the Pearl team.

## 5. Operator cost model (why 0.25% works)

At PRL ≈ $1.36 (2026-09-28 research):

- A 1,000 PRL deposit round-trips ≈ 1,000 PRL of volume → **5 PRL**
  (≈ $6.80) in fees for ~6 block-confirmation waits + two on-chain TXs.
- Operator running costs: one small VPS (the daemon + reserves API),
  Base gas for `mintDeposit` calls (cents on Base), Pearl TX fees for
  releases (PRL dust), and custody overhead (the real cost — multisig
  signing labor, not compute).
- Break-even is low: even a few thousand PRL/month of bridge volume covers
  infrastructure many times over. The fee is priced for **liquidity
  seeding and custody professionalism**, not to extract rent — 0.25% sits
  below typical CEX withdrawal fees.

## 6. What fees are NOT

- **Not** taken from the vault backing: fees are separate outputs, never
  drawn from custodied reserves. Backing stays 1:1.
- **Not** adjustable by the operator at runtime: the BPS value is a
  deployment constant (`BRIDGE_FEE_BPS`), changeable only by contract
  upgrade/redeploy — deliberate, so users can trust the quoted rate.
- **Not** revenue for LPs: bridge fees and DEX pool fees (04) are separate
  streams. Bridge fees pay for custody/operations; pool fees reward
  liquidity providers.

## 7. Anti-spam guards

- Minimum deposit **0.001 PRL** (100,000 grains); dust below it is rejected
  by the UI and held-not-minted by the operator.
- Minimum withdrawal enforced by gas economics — the on-chain function has
  no hard minimum, but the UI warns when the 0.25% fee rounds to zero on
  dust amounts (floor division), so users see the effective rate honestly.

---

## Attribution

Built by **@kshot9000** · PRL:
`prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d` · EVM
(Base): `0x4b6f3BC697D9dAF3e8dE182aEc56eD208B9087f1` ·
https://github.com/Kshot3000/Pearl-Muse-24-7-Ai-builder
