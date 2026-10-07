# TEAM-HANDOFF.md — wPRL proposal for pearl-research-labs

**To the Pearl team.** This is a complete, tested, open-source starting
point for **wPRL — Wrapped Pearl (Pearl PoUW L1)**, an ERC-20 representation
of native PRL on Base. Built independently, offered to the ecosystem. Take
it, fork it, finish it — that's the ask.

## What wPRL is

Native PRL can't leave the Pearl L1 (bech32m `prl1…`, Taproot-only, no
smart contracts). wPRL is the wBTC-model answer: a custodian holds native
PRL in a vault and a bridge operator mints wPRL 1:1 on Base (8453). Target
venue for the wPRL/USDC pool is Aerodrome; Uniswap v3 second for aggregator
routing.

**Branding, stated everywhere:** "wPRL — Wrapped Pearl (Pearl PoUW L1)".
Not Oyster Pearl, not Perle on Solana, not any other "PRL". Copycat
disambiguation is baked into the site FAQ, the docs, and the contract
comments.

## What was built (all in this repo, `apps/wprl/`)

| Piece | What it is | Verification |
|---|---|---|
| `contracts/` | `WPRL.sol` (ERC-20, 18 dec, mint/burn → `MINTER_ROLE`) + `WPRLBridge.sol` (`mintDeposit` operator-only with per-txid replay protection, `requestWithdraw` with 0.25% on-chain fee + `prl1…` validation, admin `pause()`) | `npx hardhat test` — **23/23 green** |
| `backend/` | Node bridge operator: Pearl deposit watcher (vault output + 0.25% fee output + `wprl:<0x…>` OP_RETURN, ≥6 confs; malformed TXs held, never auto-minted), Base withdrawal watcher (2-block reorg margin), proof-of-reserves API, fee accounting, config-driven, secrets-from-env, fails closed | `npm test` — **41/41 green** + Hardhat e2e of the real operator against real compiled contracts (exact mints, idempotent re-scans, exact releases) |
| `web/` | Pearl-brand static bridge site (GitHub Pages): deposit instruction generator, withdraw planner, live proof-of-reserves dashboard (live / not-published / unreachable — never fake numbers), fee schedule, FAQ incl. custodial trust model | `node --test` **8/8** + headless-Chromium CDP QA **24/24**, zero JS errors |
| `docs/` | `01-architecture.md`, `02-trust-model.md` (plain-language custodial disclosure), `03-fee-economics.md`, `04-aerodrome-launch-plan.md` (pool, bribes flywheel, kill criteria), `05-audit-checklist.md` | — |

**Unit conversion, exact and documented:** 1 PRL = 10⁸ grains (verified
against upstream `node/btcutil/const.go`); 1 grain = 10¹⁰ wei; sub-grain
dust truncated by integer division. Shared helpers across
contracts-tests, backend, and web.

**Fees:** 0.25% each way (`BRIDGE_FEE_BPS = 25`, defined once), deposit fee
in PRL on the Pearl chain, withdrawal fee in wPRL on Base. Fee math is
identical in the contracts, the operator, and the UI — tested for parity.

**Testnet only.** Nothing is deployed to Base mainnet. No real funds have
moved. Base Sepolia is the target for the first live deploy.

## What "finish" means (the ask)

The code is the easy part. What the package needs from the team (or a joint
effort) before mainnet:

1. **Audit** — independent security audit of both contracts (checklist item
   C1). Non-negotiable gate.
2. **Custody** — replace bootstrap custody with a named custodian: vault
   keys in multisig (2-of-3 minimum), minting key in HSM/KMS, monitoring +
   alerting + key-compromise runbooks (B8–B11, O1–O4).
3. **Legal** — review of the wrapped-token + bridge-fee model in launch
   jurisdictions; ToS/risk disclosure on the site (L1–L3).
4. **Mainnet** — testnet soak ≥2 weeks on Base Sepolia, then mainnet deploy
   with verified sources on Basescan, seeded Aerodrome wPRL/USDC pool, and
   the bribe program per the launch plan.

The full gate list is `docs/05-audit-checklist.md` — mainnet is blocked on
C1, C8, C12, B8, B9, B10, B11, O1, L1. Everything else ✅ or explicitly
waived in writing.

## Trust model, stated plainly

wPRL is **custodial, like wBTC**. One operator custodies backing PRL;
redemption depends on that operator. The docs say this in plain language
(`02-trust-model.md`) and the site FAQ repeats it. If the team wants a
federation or threshold-signing design later, the architecture supports
swapping the operator leg — but today's model is one trusted operator, and
it's labeled as such everywhere.

## Suggested next steps

1. Review the code and docs in this repo (`apps/wprl/`).
2. Reply on the GitHub issue (link below) or reach out on X — let's talk
   custody design and audit scoping.
3. Decide together: team-run operator, joint multisig, or third-party
   custodian.

No strings attached to the code. If the team would rather build it
differently, the research (Aerodrome plan, fee economics, trust model) is
still useful.

---

## Attribution

Built by **@kshot9000** · PRL:
`prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d` · EVM
(Base): `0x4b6f3BC697D9dAF3e8dE182aEc56eD208B9087f1` ·
https://github.com/Kshot3000/Oysters4All
