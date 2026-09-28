# wPRL Bridge Operator (backend)

The off-chain half of the custodial wPRL bridge. Watches the Pearl chain for
deposits, mints wPRL on Base; watches Base for burns, releases native PRL.
Serves the proof-of-reserves API.

## What it does

| Component | File | Job |
|---|---|---|
| Deposit watcher | `operator.js` → `scanDeposits` | Polls `pearld` `searchrawtransactions(vault)` (needs `--addrindex` + `--txindex`), verifies each new tx with `deposit.js`, calls `bridge.mintDeposit(user, wei, txid)` |
| Withdrawal watcher | `operator.js` → `scanWithdrawals` | Polls `WithdrawRequested` events from the deploy block, calls Oyster `sendtoaddress(prlRecipient, netGrains)` exactly once per nonce |
| Proof-of-reserves API | `reserves-api.js` | `GET /reserves` — vault grain balance vs wPRL totalSupply, backing ratio, fee addresses; `GET /health` — dependency liveness |
| Unit conversion | `convert.js` | Exact BigInt math: 1 grain = 1e10 wei; decimal-string parsing (never floats) for RPC amounts |

## Deposit protocol (what users must do)

A Pearl deposit tx is honored **only if** it has all three:

1. Output(s) to the operator's **vault address**, total `D` grains (≥ `WPRL_MIN_DEPOSIT_GRAINS`).
2. A **separate fee output** to the PRL fee address (`prl1p62v09…9d`) of at least
   `ceil(D × 0.25%)` grains.
3. An **OP_RETURN** output carrying `wprl:<0x-evm-address>` (UTF-8) — the
   address that receives the minted wPRL.

The tx needs `WPRL_MIN_CONFIRMATIONS` (default 6) confirmations. Deposits
missing the fee or the OP_RETURN are **not auto-minted** — they're logged under
`review:<txid>` in `state.json` for manual handling (funds stay safe in the
vault; the custodian can refund).

The operator checks the contract's `usedPearlTxids` before every mint, so a
Pearl txid can never mint twice even across restarts.

## Setup

```bash
cd apps/wprl/backend
npm install
cp .env.example .env   # then fill in: RPC URLs, contract addresses, operator key
npm test               # 38 unit tests, all offline (mocked RPCs)
npm start              # the operator loop
npm run api            # proof-of-reserves API on :8080 (separate process)
```

**pearld requirements:** run with `--addrindex` and `--txindex`, or the
operator refuses to start (the deposit watcher needs `searchrawtransactions`).
Wallet RPCs (`getbalance`, `sendtoaddress`) go to the **Oyster** daemon —
`pearld` itself answers them with "ask a connected instance of Oyster"
(verified in upstream `node/rpcserver.go`: `rpcAskWallet`).

**Secrets:** `WPRL_OPERATOR_KEY`, RPC passwords — environment or secret manager
only. Never commit `.env` (gitignored). Startup logs a redacted config.

**Safety rails:**
- `WPRL_BASE_CHAIN_ID=8453` (Base mainnet) is **refused** unless
  `WPRL_MAINNET_APPROVED=kyle-approved` is set — which only happens after
  Kyle's explicit written go-ahead.
- At startup the operator cross-checks the deployed bridge: chain id, fee bps,
  fee recipient, token address, `WEI_PER_GRAIN`, paused state, and that the
  operator key holds `OPERATOR_ROLE`. Any mismatch = refuse to start.
- `pearld` must run with `--addrindex` + `--txindex` — verified at startup via
  a `searchrawtransactions` probe; without it the operator refuses to start.
- Withdrawals re-validate the event (`prl1…` recipient, `netWei/1e10 ==
  netGrains`) and are idempotent per nonce — a restart can never double-send.
- A deposit seen with too few confirmations is parked in `pearl:pending` and
  re-checked by txid until it confirms — it is never silently dropped.
- The Base event cursor never advances into the freshest 2 blocks (reorg
  margin); an event is deferred, never lost, and the overlap re-scan is safe
  because withdrawal processing is idempotent per nonce.

## Testing

```bash
npm test              # 41 unit tests, all offline (mocked RPCs)
```

`test/e2e-local.mjs` is a full end-to-end run of the **real** `operator.js`
against the **real compiled contracts** on a local Hardhat chain (only the
Pearl side is faked). Needs a node first:

```bash
cd apps/wprl && npx hardhat node --port 8546   # terminal 1
cd apps/wprl/backend && node test/e2e-local.mjs  # terminal 2
```

It proves: startup checks, deposit scan → exact mint (2.5 PRL → 2.5 wPRL),
re-scan idempotency (no double mint), `requestWithdraw` → exact PRL release
call (0.9975 PRL for a 1 wPRL burn), no double-send, and correct final
accounting (fee stays in supply, paid to the fee recipient).

## Proof-of-reserves

`GET /reserves` returns e.g.:

```json
{
  "checkedAt": "2026-09-28T23:00:00.000Z",
  "pearlChain": { "vaultAddress": "prl1…", "vaultBalanceGrains": "100000000", "vaultBalancePrl": "1.00000000" },
  "baseChain": { "chainId": 11155111, "totalSupplyGrains": "100000000", "totalMintedWei": "…", "totalBurnedWei": "…" },
  "backing": { "backingBps": 10000, "backingRatioPct": "100.00", "fullyBacked": true },
  "fees": { "feeBps": 25, "prlFeeAddress": "prl1…", "evmFeeAddress": "0x…" }
}
```

`backingBps = vaultGrains × 10000 / supplyGrains` — 10000 is exactly 1:1.
Under-collateralization is reported as-is (`fullyBacked: false`); the API never
invents numbers.

## Files

- `operator.js` — main loop (deposit + withdrawal scans, startup checks)
- `reserves-api.js` — HTTP API (`/reserves`, `/health`), no framework
- `pearl.js` — pearld chain-RPC client (`searchrawtransactions`, `getrawtransaction`, `getblockcount`)
- `oyster.js` — Oyster wallet-RPC client (`getbalance`, `listunspent`, `sendtoaddress`)
- `rpc.js` — minimal JSON-RPC client with basic auth
- `deposit.js` — pure deposit verification + OP_RETURN parsing
- `withdraw.js` — event decode/validate/process (idempotent)
- `convert.js` — exact BigInt unit + fee math
- `config.js` — env loading + validation (+ mainnet guard)
- `state.js` — atomic JSON cursor store
- `test/` — 38 unit tests (`node --test`), zero network
