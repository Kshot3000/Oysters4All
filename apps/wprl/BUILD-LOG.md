# wPRL Build Log

Timestamped record of every build/test/verify step. Times in America/Chicago.

## 2026-09-28 17:16 CDT — Phase 1: contracts

- Wrote `contracts/WPRL.sol` ("Wrapped Pearl"/"wPRL", 18 decimals, mint/burn behind
  MINTER_ROLE) and `contracts/WPRLBridge.sol` (operator `mintDeposit` with Pearl
  txid replay protection; user `requestWithdraw` with on-chain 0.25% fee to
  Kyle's EVM address `0x4b6f3BC697D9dAF3e8dE182aEc56eD208B9087f1`; `prl1…`
  recipient validation; pause; 1:1 accounting counters).
- Exact grain conversion documented + tested: 1 PRL = 1e8 grains (upstream
  `node/btcutil/const.go`), 1 grain = 1e10 wei, sub-grain dust truncates.
- `npx hardhat test`: **23/23 green** on the in-process EVM (access control,
  fee math, invariants, edge cases, role revocation).
- Committed as `70e95b5`. No deployments — testnet deploys happen later with Kyle.

## 2026-09-28 18:10 CDT — Phase 2: bridge operator backend

- Built `backend/`: Node operator that watches Pearl deposits → mints wPRL on
  Base, watches Base burns → releases PRL via Oyster, serves proof-of-reserves.
- Verified the real RPC surface against the upstream mirror
  (`hidden_files/upstream`, pearl-research-labs/pearl): pearld `:44107` has
  `searchrawtransactions` (needs `--addrindex`) and `getrawtransaction`
  (needs `--txindex`); wallet RPCs (`getbalance`/`sendtoaddress`/`listunspent`)
  are refused by pearld with "ask a connected instance of Oyster" — they go to
  the Oyster daemon (sample conf hints default listen `:44207`).
- Deposit protocol: vault output(s) + separate 0.25% fee output to Kyle's PRL
  address + `wprl:<evm-address>` OP_RETURN; deposits missing fee/OP_RETURN are
  held for manual review, never auto-minted.
- Bugs caught by tests (all fixed, all covered):
  1. `prlValueToGrains` threw on scientific-notation floats (`String(0.0000005)
     === "5e-7"`) — real RPC JSON numbers can arrive this way. Added
     `expandScientific`.
  2. `redactConfig` output wasn't JSON-serializable (BigInt) — would have
     crashed the operator's startup log line. Now stringifies BigInts.
  3. Too-young deposits were marked done and never rechecked — added the
     `pearl:pending` recheck-by-txid path.
  4. Base event cursor could advance past an unscanned block on a stale block
     number — added a 2-block reorg/safety margin; events are deferred, never lost.
- `npm test`: **41/41 green** (convert, deposit verify, withdraw process,
  config incl. mainnet guard, RPC client, reserves API, operator scan loops).
- Smoke tests: operator with no config exits 1 naming the missing var; API with
  dead backends returns 503 with honest per-dependency errors.
- `test/e2e-local.mjs`: full run of the real `operator.js` + real compiled
  contracts on a local Hardhat chain (Pearl side faked) — **all checks passed**:
  startup checks, deposit scan → exact 2.5 wPRL mint, re-scan idempotent (no
  double mint), `requestWithdraw`(1 wPRL) → exact 0.9975 PRL release call, no
  double-send, final supply 1.5025 wPRL with the 0.0025 fee in Kyle's address.
- Committed + pushed to main. No mainnet activity; testnet deploy still pending
  with Kyle.

## 2026-09-28 19:35 CDT — Phase 3: bridge website (web/)

- Built `web/`: static Pearl-brand bridge site (dark, luminous pearl-glow,
  animated particle canvas) — `index.html`, `styles.css`, `config.js` (public
  config, placeholders, zero secrets), `app.js`, `test/app.test.mjs`.
- Deposit tab: instruction generator — enter Base 0x address + PRL amount →
  exact two-output breakdown (vault amount + ceil(0.25%) fee to Kyle's PRL
  address), `wprl:<0x…>` OP_RETURN memo, copy buttons, 6-confirmation note,
  min 0.001 PRL, dust rejected. Vault address shows honest "not published
  yet" until the operator is configured.
- Withdraw tab: unwrap planner — wPRL amount + prl1… recipient → on-chain fee
  (floor, exactly the contract's integer division), net PRL, EVM-address
  rejection in the prl1 field. Contract call (`requestWithdraw` via ethers)
  renders only when a bridge address is configured; otherwise an honest
  "not deployed yet" panel. No dead buttons.
- Proof-of-reserves dashboard: fetches operator `/reserves` → vault PRL,
  wPRL supply, backing ratio + bar, FULLY BACKED/UNDER-COLLATERALIZED badge,
  fee addresses. Three honest states: live / not-published-yet /
  unreachable — never fake numbers; auto-refresh 60s.
- Fee schedule (0.25% each way, both fee addresses), FAQ (custodial trust
  model, which-PRL disambiguation, testnet-only, deposit-protocol edge cases),
  footer with full attribution (@kshot9000, both addresses, repo link).
- `node --test web/test/`: **8/8 green** (exact fee math matches backend
  deposit.js ceil + WPRLBridge floor; validation mirrors contract).
- Real-browser QA via CDP (headless Chromium): **24/24 PASS** — deposit math
  (10 PRL → 0.025 fee, 10.025 total, correct memo), dust rejection, withdraw
  quote (5 wPRL → 4.9875 PRL net), EVM-in-prl1 rejection, reserves live
  (25 PRL / 25 wPRL / 100.00% / FULLY BACKED) against a stub API, honest
  offline state without it. Zero JS errors from our code (only 2 sandbox
  CDN-load failures for ethers — no direct egress here; page degrades
  gracefully, loads fine in production).
- Screenshots verified visually (hero, bridge, reserves).
- Still pending: `docs/` (architecture, trust model, fee economics, Aerodrome
  plan, audit checklist, TEAM-HANDOFF.md) — next phase. No outreach sent
  (package not yet complete per the handoff rule).
