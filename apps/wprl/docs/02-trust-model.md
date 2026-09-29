# wPRL Trust Model

**wPRL — Wrapped Pearl (Pearl PoUW L1 → Base).** This document states, in
plain language, who you have to trust when you hold wPRL, what can go wrong,
and what the design does and doesn't protect you from. It is written to be
shown to users as-is.

## 1. The one-sentence trust model

**wPRL is custodial, like wBTC:** one operator custodies the native PRL
backing every wPRL, and redemption depends on that operator releasing your
PRL. If the custodian fails, wPRL can lose its backing. Do not use wPRL
unless you accept this.

## 2. Why it is custodial (and why that's honest)

Pearl L1 uses bech32m `prl1…` Taproot-only addresses and has **no smart
contracts**. A trustless on-chain light-client bridge is not possible on
Pearl today — there is nowhere on the Pearl chain for trustless logic to
live. The bridge is therefore an IOU model: the operator verifies your
deposit on the Pearl chain and mints wPRL on Base; on withdrawal it burns
your wPRL and releases PRL to your `prl1…` address.

This is not a flaw to hide — it's the same tradeoff wBTC made. But it must
never be marketed as trustless, decentralized, or permissionless.

## 3. Who the trusted parties are

| Party | Role | What they control |
|---|---|---|
| Bridge operator | Watches both chains, calls `mintDeposit`, releases PRL on withdrawal | Custodial PRL vault keys; minting on Base; proof-of-reserves API |
| Contract admin | Emergency `pause()`, role grants | Can halt the bridge; cannot mint directly (only `OPERATOR_ROLE` mints via the bridge) |
| wPRL token admin | `WPRL` access control | Grants/revokes `MINTER_ROLE`; post-deployment this is the bridge contract only |

**Initial custody:** the vault keys and operator are held by the builder
until the Pearl team (or a mutually agreed custodian) takes over. This is
explicitly a **bootstrap custodian**, not a final one — see TEAM-HANDOFF.md.

## 4. What the design protects against

- **Double-minting a deposit:** each Pearl txid is usable exactly once
  on-chain (`WPRLBridge` replay-protection mapping), and operator re-scans
  are idempotent (tested e2e).
- **Fee theft by users:** the deposit protocol requires the separate 0.25%
  fee output to the fee address plus the OP_RETURN memo; TXs missing them are
  held for manual review, never auto-minted.
- **Wrong-chain address mistakes:** `requestWithdraw` rejects EVM addresses
  in the `prlRecipient` field on-chain; the web UI rejects them before
  submission too.
- **Reorgs:** the Base event cursor keeps a 2-block safety margin; events
  are deferred, never lost or advanced past.
- **Operator runaway minting:** only `OPERATOR_ROLE` (one keyset) can call
  `mintDeposit`; the emergency `pause()` stops all bridging.
- **Silent under-collateralization:** the proof-of-reserves API publishes
  vault balance vs. wPRL `totalSupply` continuously; the website shows a
  FULLY BACKED / UNDER-COLLATERALIZED badge with an exact ratio.

## 5. What the design does NOT protect against (honest risks)

1. **Custodian compromise or misconduct.** If the vault keys are stolen or
   misused, backing PRL can be lost. Mitigations: multisig vault keys and a
   regulated custodian are the planned end state — not yet in place.
2. **Operator downtime.** Deposits/withdrawals are processed by an off-chain
   daemon; if it stops, bridging stops (no funds move, but nothing is
   lost). `pause()` is the deliberate form of this.
3. **Pearl chain risks.** Reorgs, 51% attacks, or consensus bugs on Pearl
   affect the vault like any other Pearl holder.
4. **Base / smart-contract risks.** Bugs in `WPRL.sol` / `WPRLBridge.sol`
   (pre-audit), Base chain incidents, or admin-key compromise.
5. **Fee-address compromise.** Fees route to public addresses controlled by
   the builder; verified on-chain, no obfuscation.
6. **Liquidity risk.** wPRL's market price can deviate from 1:1 with PRL if
   there is no deep pool — the Aerodrome launch plan (04) exists to address
   this, but it is not guaranteed.
7. **Regulatory risk.** A wrapped token plus bridge fees may be a regulated
   activity in some jurisdictions; legal review is a handoff requirement
   (05), not yet done.

## 6. What "decentralization later" could look like

Options the team can consider once the MVP proves out (not built yet):
- Federation of operators with threshold signing of mints.
- A Pearl-side covenant or drivechain mechanism if Pearl L1 ever supports
  covenant scripts (currently no smart contracts).
- Proof-of-reserves on-chain via an oracle feed instead of a hosted API.

None of these change today's model. Today's model is one trusted operator.

## 7. Copycat disambiguation (user safety)

There are tokens called "PRL" that are **not** this: Oyster Pearl (old
ERC-20), Perle on Solana, and scam copycats (the OctaSpace research pass
found the same pattern — scam "OCTA" tokens on Base with zero connection to
the real project). **wPRL wraps the native PRL of Pearl PoUW L1 only.**
Verify the contract address against the official deployment record before
interacting with anything named wPRL/PRL.

---

## Attribution

Built by **@kshot9000** · PRL:
`prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d` · EVM
(Base): `0x4b6f3BC697D9dAF3e8dE182aEc56eD208B9087f1` ·
https://github.com/Kshot3000/Pearl-Muse-24-7-Ai-builder
