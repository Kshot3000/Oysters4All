# wPRL — Wrapped Pearl (Pearl PoUW L1 → Base)

ERC-20 representation of native **PRL** (Pearl Proof-of-Useful-Work L1) for EVM
chains — starting with **Base** (chain id 8453). Custodial bridge, wBTC-style.

**Branding:** "wPRL — Wrapped Pearl (Pearl PoUW L1)". This wraps the native PRL
of the Pearl L1 (`pearl-research-labs/pearl`). It is **not** affiliated with any
other token using the "PRL" ticker (Oyster Pearl, Perle on Solana, copycats).
Always verify the contract address against the official deployment record.

## Unit conversion (exact)

Pearl's smallest unit is the **grain** (verified against upstream
`pearl-research-labs/pearl`, `node/btcutil/const.go`):

| | |
|---|---|
| 1 PRL | = 100,000,000 grains (`GrainPerPearl = 1e8`) |
| 1 wPRL | = 10¹⁸ wei (ERC-20, 18 decimals) |
| **1 grain** | **= 10¹⁰ wei** |

- `grains → wei`: `wei = grains * 1e10` (exact)
- `wei → grains`: `grains = wei / 1e10` (integer division — **sub-grain dust is truncated**)

The bridge exposes `grainsToWei()` / `weiToGrains()` pure helpers; both are
covered by tests.

## Contracts

- **`contracts/WPRL.sol`** — the wPRL ERC-20 (`"Wrapped Pearl"` / `"wPRL"`,
  18 decimals). `mint`/`burn` are restricted to `MINTER_ROLE`, held solely by
  the bridge contract after deployment.
- **`contracts/WPRLBridge.sol`** — the on-chain half of the bridge:
  - `mintDeposit(user, amountWei, pearlTxid)` — `OPERATOR_ROLE` only. Called
    after the operator verifies a native PRL deposit on the Pearl chain.
    Each Pearl txid is usable exactly once (replay protection).
  - `requestWithdraw(amountWei, prlRecipient)` — anyone holding wPRL. Takes
    the 0.25% fee **in wPRL** to the fee recipient, burns the remaining
    99.75%, and emits `WithdrawRequested`. The operator then releases the
    net PRL on the Pearl chain. `prlRecipient` must be a `prl1…` address
    (guards against pasting an EVM address).
  - Accounting invariant: `totalSupply() == totalMinted - totalBurned`
    (tested). Backing target: the Pearl vault's grain balance should equal
    `totalSupply() / 1e10` — checked by the off-chain proof-of-reserves
    dashboard (Phase 2).
  - `pause()` / `unpause()` — admin-only emergency brake.

## Fees — 0.25% each way

Defined once as `BRIDGE_FEE_BPS = 25` (denominator 10,000):

| Direction | How the fee is taken | Fee recipient |
|---|---|---|
| Pearl → Base (deposit) | User includes a 0.25% output to Kyle's PRL address **in the deposit tx** (enforced off-chain by the operator when verifying) | `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d` |
| Base → Pearl (withdraw) | Taken **on-chain in wPRL** by `requestWithdraw` | `0x4b6f3BC697D9dAF3e8dE182aEc56eD208B9087f1` (Kyle's EVM address, immutable) |

## Trust model (read before mainnet)

Custodial, wBTC-style — **not trustless**:
1. Native PRL backing is held off-chain in the operator's Pearl vault.
2. Users trust the operator to hold 1:1 backing and to release PRL on burns.
3. The operator (holder of `OPERATOR_ROLE`) can mint wPRL — it must only do
   so against verified Pearl deposits.

Mitigations: immutable fee recipient, replay protection, `prl1…` recipient
validation, admin pause, public proof-of-reserves dashboard (Phase 2),
multisig operator keys (recommended), professional audit before mainnet.

## Develop

```bash
npm install
npx hardhat compile
npx hardhat test        # 23 tests, all green on the in-process EVM
```

## Deployment (later, with Kyle — NOT done in Phase 1)

1. Deploy `WPRL` with admin = Kyle's EVM address.
2. Deploy `WPRLBridge(wprl, admin, feeRecipient=0x4b6f3BC697D9dAF3e8dE182aEc56eD208B9087f1)`.
3. On `WPRL`, `grantRole(MINTER_ROLE, bridgeAddress)` — the bridge becomes the
   sole minter.
4. Verify both contracts on Basescan; record addresses in the official
   deployment log before anyone is told to use them.

Testnet first (Base Sepolia), mainnet only after audit + legal review.
