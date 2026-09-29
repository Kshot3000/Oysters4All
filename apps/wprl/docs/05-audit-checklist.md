# wPRL Audit Checklist

**wPRL — Wrapped Pearl (Pearl PoUW L1 → Base).** What must be true before
mainnet. Status column is honest as of 2026-09-28 — most items are
explicitly **not done yet**, and that's the point of this list.

## 1. Smart contracts (`contracts/`)

| # | Item | Status |
|---|---|---|
| C1 | Independent security audit of `WPRL.sol` + `WPRLBridge.sol` by a reputable firm | ⬜ NOT DONE — required before mainnet |
| C2 | `mintDeposit` access control: only `OPERATOR_ROLE` can mint | ✅ Implemented + tested (23/23) |
| C3 | Replay protection: each Pearl txid usable once | ✅ Implemented + tested |
| C4 | `requestWithdraw` fee math: floor division, exact recipient split | ✅ Implemented + tested |
| C5 | `prlRecipient` validation rejects non-`prl1` addresses | ✅ Implemented + tested |
| C6 | `pause()`/`unpause()` restricted to admin; pause blocks mint+withdraw | ✅ Implemented + tested |
| C7 | Supply invariant `totalSupply == totalMinted - totalBurned` under all paths | ✅ Tested |
| C8 | Role-admin hygiene: deployer renounces or transfers admin to multisig post-deploy | ⬜ Planned — deployment procedure (README) targets a multisig |
| C9 | Upgradeability decision documented (currently non-upgradeable — deliberate) | ⬜ Document explicitly pre-mainnet |
| C10 | Fuzz testing on fee math + conversion helpers (grain↔wei edge cases) | ⬜ Recommended addition |
| C11 | Verified source on Basescan for both contracts | ⬜ At deploy time |
| C12 | Testnet soak: ≥2 weeks on Base Sepolia with real deposit/withdraw cycles | ⬜ Testnet deploy pending Kyle's go-ahead |

## 2. Bridge operator (`backend/`)

| # | Item | Status |
|---|---|---|
| B1 | Deposit verification: vault output + fee output + OP_RETURN memo + 6 confs | ✅ Implemented + tested (41/41 + e2e) |
| B2 | Malformed deposits held for manual review, never auto-minted | ✅ Implemented + tested |
| B3 | Idempotent re-scans (no double mint) | ✅ Implemented + tested |
| B4 | Base reorg margin (2-block cursor lag), events deferred not lost | ✅ Implemented + tested |
| B5 | Mainnet guard: refuses to run against mainnet without explicit config | ✅ Implemented + tested |
| B6 | Secrets from env only; no secrets in repo/config; startup fails closed | ✅ Implemented + tested |
| B7 | Proof-of-reserves API returns honest 503 when backends unreachable | ✅ Implemented + tested |
| B8 | Operator key management: minting key in HSM/KMS, not a hot env var | ⬜ NOT DONE — required before mainnet |
| B9 | Vault (Pearl side) keys in multisig (2-of-3 minimum) | ⬜ NOT DONE — required before mainnet |
| B10 | Monitoring + alerting: daemon liveness, reserves divergence, failed releases | ⬜ NOT DONE — build before mainnet |
| B11 | Disaster recovery: documented key-compromise and chain-halt runbooks | ⬜ NOT DONE — write before mainnet |
| B12 | Load/chaos test: RPC outages, reorgs, duplicate events, clock skew | ⬜ Recommended |

## 3. Web (`web/`)

| # | Item | Status |
|---|---|---|
| W1 | Fee math in UI matches contracts/backend exactly (ceil deposit, floor withdraw) | ✅ Tested (8/8) + browser QA (24/24) |
| W2 | No mock data presented as real; three honest reserves states | ✅ Implemented + browser-verified |
| W3 | Contract calls render only when a bridge address is configured | ✅ Implemented + verified |
| W4 | Content Security Policy + no inline secrets on the Pages deployment | ⬜ At deploy time |
| W5 | Accessibility pass (keyboard, contrast, screen reader) on bridge flows | ⬜ Recommended |

## 4. Custody & operations

| # | Item | Status |
|---|---|---|
| O1 | Named custodian (team multisig or regulated custodian) replaces bootstrap custody | ⬜ NOT DONE — handoff item |
| O2 | Proof-of-reserves published on a schedule the team commits to (target: continuous, alert on divergence >0.1%) | ⬜ API built; schedule is a team commitment |
| O3 | Incident response contacts + public status channel | ⬜ NOT DONE |
| O4 | Insurance or reserve buffer policy for operational errors | ⬜ Team decision |

## 5. Legal & compliance

| # | Item | Status |
|---|---|---|
| L1 | Legal review of wrapped-token + bridge-fee model in launch jurisdictions | ⬜ NOT DONE — required before mainnet |
| L2 | Terms of service / risk disclosure on the bridge site | ⬜ Draft from 02-trust-model.md before mainnet |
| L3 | Copycat-token monitoring process (scam "wPRL"/"PRL" on Base) | ⬜ Team process |

## 6. Launch gates

Mainnet deploy is gated on: **C1, C8, C12, B8, B9, B10, B11, O1, L1** —
all must be ✅. Everything else should be ✅ or explicitly waived in
writing by whoever holds the admin keys at launch. No exceptions, no
"we'll audit after launch."

---

## Attribution

Built by **@kshot9000** · PRL:
`prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d` · EVM
(Base): `0x4b6f3BC697D9dAF3e8dE182aEc56eD208B9087f1` ·
https://github.com/Kshot3000/Pearl-Muse-24-7-Ai-builder
