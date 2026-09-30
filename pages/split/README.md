# Pearl Split — Group Expense Settlement Desk for PRL

The dark tavern-ledger desk for splitting group expenses in PRL: seat the
party, chalk up expenses, compute the minimal settlement transfers, have
each debtor sign their own payment locally, and record it all in a
local ledger book. Keys never leave the page.

Live: <https://kshot3000.github.io/Pearl-Muse-24-7-Ai-builder/pages/split/>

## What it does

Five steps: **Tab → Expenses → Settle → Pay → Ledger**.

1. **Tab** — name the occasion, seat members: a display name bound to a
   `prl1…`/`tprl1…` Taproot address, validated in-browser (bech32m, witness
   v1, correct network HRP). Bad addresses are refused before they can cost
   anyone. No keys are collected here — only public receiving addresses.
2. **Expenses** — chalk up expenses: description, amount (PRL, decimals
   allowed → integer grains), payer, and a split rule:
   - **Equal** — grains split evenly; leftover single grains go to the
     **first members by list order**, deterministically;
   - **Shares** — integer weights (e.g. 2 : 1), floored, remainder to first
     members by index;
   - **Percent** — percentages that must sum to **exactly 100**, floored,
     remainder to first members by index.
   Every split is grain-exact: the lines always sum to the total.
3. **Settle** — net balances are derived, then the desk matches the largest
   debtor against the largest creditor, greedily. Each transfer zeroes at
   least one party, so the set is the **minimal number of transfers** that
   clears the tab. The settlement is sealed in a tamper-evident
   `pearlsplit:v1:` descriptor with a 64-bit fingerprint (deterministic —
   the same tab always seals to the same fingerprint). Transfers below the
   546-grain dust floor **cannot** be chain outputs; they are refused
   loudly, with the fix spelled out (settle in person, or fold into another
   transfer).
4. **Pay** — each debtor settles their own debt in one transaction: UTXOs
   via Blockbook (GET-only) or pasted air-gapped; coin selection against
   creditors + the exact keypath fee; the debtor's key signs **locally**
   with the audited Schnorr machinery and is **wiped** the moment the hex
   exists; every signature is re-verified locally before the hex is shown;
   air-gapped unsigned bundles (`pearlsplit:v1:` descriptor,
   `pearl-split-unsigned:v1:` bundle kind) with full tamper-evidence;
   broadcast only behind an explicit double-confirm.
5. **Ledger** — settled tabs are recorded in localStorage (tab name and
   fingerprint, members, net balances, transfers, and each payment's txid),
   with CSV export for your own books.

## Honest scope

- Pearl has no smart contracts and no on-chain expense state. The desk
  knows only what you type: member addresses, expense amounts, and UTXOs
  are your word. A settlement is only as fair as the expenses you chalk up.
- Dust is real: a debt under 546 grains cannot be paid on-chain. The desk
  refuses it loudly and tells you how to clear it.
- Fees are estimates at signing time; a broadcast tx can linger if the
  mempool is hot.
- Keys: pasted secrets live in memory only and are wiped after signing.
  Prefer the air-gapped bundle flow for mainnet money.

## Architecture

No new cryptography anywhere. Everything cryptographic — address
validation, key derivation, transaction building, Schnorr signing and
re-verification, bundle sealing, coin selection — is reused verbatim from
the audited cores in `../sign/src/` and `../batch/src/`. The split-specific
logic is only: member validation, expense-share math, balance and
minimal-transfer computation, the dust policy, per-debtor planning,
`pearlsplit:v1:` descriptors, and the localStorage ledger helpers.

## Tests

- `node --no-warnings --loader ./tests/loader.mjs tests/split.test.mjs`
  — 25/25: member validation (v0/non-v1/bad-HRP rejection), equal/shares/
  percent split math with remainder distribution, grain-exactness,
  balance computation, greedy minimal-transfer optimality on fixtures
  (minimal transfer count), dust refusal, per-debtor funding
  (inputs == outputs + fee + change), bundle tamper-evidence, a full local
  sign with per-signature re-verification, wrong-key refusal, and ledger
  save/load + CSV.
- `node --no-warnings tests/dom.test.mjs` — 8/8: drives the real committed
  bundle through a vm DOM harness, Tab → Expenses → Settle → Pay (fund,
  wrong-key refusal, sign + key wipe, double-confirm broadcast via a
  stubbed fetch) → Ledger (record + CSV).
- `node tests/split.browser.qa.mjs` — 27/27 real-browser checks green in
  headless Chromium (file:// + CDP, Blockbook stubbed in-page, zero
  console/page errors, zero missing assets): full wizard flow, unsigned
  bundle kind tags, step navigation, footer donation address.

Rebuild the committed bundle after touching `src/`: `node build.mjs`
(esbuild resolved via `~/workspace/.build-tools`).
