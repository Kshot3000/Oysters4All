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

## 2026-09-28 20:05 CDT — Phase 4: docs/ (complete package)

- Built `docs/`: 6 documents, all carrying the full attribution block
  (@kshot9000, both addresses, repo link — verified present in every file):
  `01-architecture.md` (system design, exact grain↔wei conversion, fee flow,
  security decisions, test coverage), `02-trust-model.md` (plain-language
  custodial disclosure, wBTC comparison, honest risk list, copycat
  disambiguation), `03-fee-economics.md` (0.25% each way, ceil-deposit /
  floor-withdraw rounding parity with contracts+backend, worked examples,
  operator cost model), `04-aerodrome-launch-plan.md` (wPRL/USDC Slipstream
  pool, 12-week bribe program funded by bridge fees, anti-mercenary
  measures, peg-defense SLA, kill criteria; Aerodrome ve(3,3)/gauge/bribe
  mechanics verified against current sources 2026-09-28), `05-audit-checklist.md`
  (honest status column: contracts/backend/web ✅ tested; audit, multisig
  custody, HSM keys, monitoring, legal all ⬜ NOT DONE — mainnet gated),
  `TEAM-HANDOFF.md` (proposal for pearl-research-labs: what was built, what
  "finish" means, suggested next steps).
- Docs commit `f3ef018` pushed to main.
- **THE SEND — package judged complete and excellent** (contracts 23/23,
  backend 41/41 + e2e, web 8/8 + 24/24 browser QA, docs + handoff written):
  - GitHub: proposal issue opened on pearl-research-labs/pearl (issues
    enabled, no prior wPRL issue) → https://github.com/pearl-research-labs/pearl/issues/347
    (OPEN, authored by Kshot3000, verified live via gh issue view). Full
    attribution block included.
  - X: post from @kshot9000 tagging @prlnet (team's X account, previously
    verified live as Pearl Research Labs) + reply with attribution block —
    delegated to browser task; URLs to be recorded here on completion.
  - Other channels: researched — no verifiable official Pearl Discord /
    Telegram / forum found (repo README has none; search results were
    unrelated "Pearl"/"Perle" accounts and an unverifiable invite-link chat).
    GitHub + X are the complete set of verified public channels.
- Handoff rule: do NOT re-send on later runs — the issue and posts are live.
  Later runs should only monitor for team replies.

## 2026-09-28 20:05 CDT — THE SEND complete (verified)

- X post (from @kshot9000, session verified, tagging @prlnet):
  https://x.com/kshot9000/status/2104738220164706642 — posted verbatim,
  preview card removed, URL text kept. HTTP 200 confirmed live.
- X reply (attribution block: both addresses + issue link):
  https://x.com/kshot9000/status/2104738317753536723 — posted verbatim
  (GitHub preview card left attached per instructions). HTTP 200 confirmed.
- GitHub issue: https://github.com/pearl-research-labs/pearl/issues/347
  (OPEN, Kshot3000). Full proposal + attribution. Verified live.
- No other verifiable official Pearl channels exist (researched 2026-09-28).
- **Handoff DONE. Do not re-send on later runs.** Monitor for team replies
  on issue #347 and the X thread instead.
