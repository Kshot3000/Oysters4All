# wPRL Architecture

**wPRL — Wrapped Pearl (Pearl PoUW L1 → Base).** ERC-20 representation of
native **PRL** (Pearl Proof-of-Useful-Work L1, `pearl-research-labs/pearl`) on
EVM chains, starting with Base (8453). Custodial bridge, wBTC-style.

> **Not** Oyster Pearl, **not** Perle on Solana, **not** any other "PRL"
> ticker. Always verify the contract address against the official deployment
> record.

## 1. Why a custodial design

Pearl L1 addresses are bech32m `prl1…`, Taproot-only, and the chain has **no
smart contracts**. A trustless on-chain light-client bridge is not possible
today. The bridge therefore follows the wBTC model: a single custodian holds
native PRL in a vault and a bridge operator mints wPRL 1:1 on Base. This is
documented honestly everywhere (site FAQ, docs, handoff) — it is not
trustless, and it should never be described as such.

## 2. Components

```
┌──────────── Pearl L1 (pearld RPC :44107) ────────────┐
│  Vault address (prl1…)                                │
│   ├── deposit TXs: vault output + fee output         │
│   │   + `wprl:<0x…>` OP_RETURN memo, ≥6 confs        │
│   └── withdrawal releases → prl1 recipient           │
└────────────┬─────────────────────────────┬──────────┘
             │                             │
┌────────────▼──────────┐      ┌───────────▼───────────┐
│  bridge operator      │      │  WPRLBridge.sol        │
│  (Node, backend/)     │      │  (Base; OPERATOR_ROLE) │
│  - deposit watcher    │─────►│  mintDeposit(user,     │
│  - withdrawal watcher │      │    amountWei, pearlTxid)│
│  - proof-of-reserves  │      │  (txid usable once)    │
│    API (/reserves)    │      │                        │
│  - fee accounting     │◄─────│  requestWithdraw(      │
└───────────────────────┘      │    amountWei, prlRecip)│
                               └───────────┬───────────┘
                                           │ MINTER_ROLE
                                           ▼
                               WPRL.sol — wPRL ERC-20 (18 dec)
```

### 2a. On-chain: `contracts/WPRL.sol`
- Standard ERC-20 ("Wrapped Pearl" / "wPRL"), 18 decimals, OpenZeppelin base.
- `mint`/`burn` restricted to `MINTER_ROLE` — held solely by the bridge
  contract after deployment. Admin starts as the deployer (Kyle's EVM
  address in the deployment procedure).

### 2b. On-chain: `contracts/WPRLBridge.sol`
- `mintDeposit(user, amountWei, pearlTxid)` — `OPERATOR_ROLE` only. Called
  after the operator verifies a native PRL deposit. Each Pearl txid usable
  **exactly once** (replay protection mapping).
- `requestWithdraw(amountWei, prlRecipient)` — callable by any wPRL holder.
  Takes the 0.25% fee **in wPRL** to the fee recipient, burns the remaining
  99.75%, emits `WithdrawRequested`. The operator then releases net PRL on
  the Pearl chain. `prlRecipient` must be a `prl1…` address — EVM addresses
  are rejected on-chain (guards against a pasted 0x address).
- `pause()` / `unpause()` — admin-only emergency brake.
- Accounting invariant: `totalSupply() == totalMinted - totalBurned`.

### 2c. Off-chain: `backend/` (Node operator)
- **Deposit watcher**: scans Pearl chain via pearld/Oyster RPC for outputs to
  the vault address. A valid deposit TX must contain: (1) a vault output,
  (2) a separate 0.25% fee output to Kyle's PRL fee address (ceil rounding),
  (3) an OP_RETURN `wprl:<evm-address>` memo. ≥6 confirmations required.
  Non-conforming TXs are **held for manual review, never auto-minted**.
- **Withdrawal watcher**: scans Base for `WithdrawRequested` events with a
  2-block reorg safety margin, then releases net PRL on the Pearl chain.
- **Proof-of-reserves API**: `GET /reserves` → vault PRL balance, wPRL
  `totalSupply`, backing ratio, fee addresses. Feeds the website dashboard.
- Config-driven (`config.js` / env); secrets only from env, never committed.
  Startup fails closed (exits non-zero naming the missing var); the API
  returns honest 503 with per-dependency errors instead of fake numbers.

### 2d. Frontend: `web/` (static, GitHub Pages)
- Deposit tab: instruction generator (amount → exact two-output breakdown,
  OP_RETURN memo, copy buttons, dust guard at 0.001 PRL).
- Withdraw tab: unwrap planner (fee math mirrors the contract's floor
  division exactly); on-chain `requestWithdraw` renders only when a bridge
  address is configured — otherwise an honest "not deployed yet" panel.
- Proof-of-reserves dashboard: three honest states (live / not published
  yet / unreachable), 60s auto-refresh, never fake numbers.

## 3. Unit conversion (exact)

Pearl's smallest unit is the **grain** (verified against upstream
`pearl-research-labs/pearl`, `node/btcutil/const.go`): 1 PRL = 10⁸ grains.
wPRL is 18-decimal: 1 wPRL = 10¹⁸ wei. Therefore:

- **1 grain = 10¹⁰ wei** (exact)
- `grains → wei`: `wei = grains * 1e10`
- `wei → grains`: `grains = wei / 1e10` (integer division — **sub-grain dust
  is truncated**)

Pure `grainsToWei()` / `weiToGrains()` helpers are shared across
contracts-tests, backend, and web so the UI can never disagree with the chain.

## 4. Fee flow

Fee = **0.25% each way** (`BRIDGE_FEE_BPS = 25`, defined once in config):
- **Deposit**: user sends 100.25 PRL — 100 PRL to the vault, 0.25 PRL (ceil)
  to Kyle's PRL fee address. wPRL minted 1:1 against the vault amount.
- **Withdraw**: user burns 100 wPRL — 0.25 wPRL (floor) to Kyle's EVM fee
  address on-chain, 99.75 PRL released to the recipient on Pearl.

## 5. Security-relevant decisions

- Replay protection: Pearl txids are single-use on-chain.
- Held-not-minted: malformed deposits never auto-mint.
- Reorg margin: Base event cursor lags 2 blocks; events deferred, never lost.
- Pause: admin emergency brake on both contracts.
- No secrets in the repo; `.env` is gitignored and `redactConfig` stringifies
  BigInts so the startup log line can't crash.
- Testnet-first: Base Sepolia deploy happens before any mainnet discussion,
  and mainnet only after audit + legal review + Kyle's explicit written
  go-ahead.

## 6. Test coverage

- Contracts: `npx hardhat test` — **23/23 green** (access control, exact fee
  math, replay protection, pause, supply invariant).
- Backend: `npm test` — **41/41 green** (conversion incl. scientific-notation
  edge, deposit verify, withdrawal processing, config incl. mainnet guard,
  RPC client, reserves API, operator scan loops) + Hardhat e2e of the real
  `operator.js` against real compiled contracts (deposit → exact mint,
  idempotent re-scan, withdrawal → exact release, fee in fee address).
- Web: `node --test web/test/` — **8/8 green**; real-browser CDP QA —
  **24/24 pass**, zero JS errors from our code.

---

## Attribution

Built by **@kshot9000** · PRL:
`prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d` · EVM
(Base): `0x4b6f3BC697D9dAF3e8dE182aEc56eD208B9087f1` ·
https://github.com/Kshot3000/Oysters4All
