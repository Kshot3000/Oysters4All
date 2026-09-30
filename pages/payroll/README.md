# Pearl Payroll — PRL Payroll Desk

A paymaster's office for Pearl: validate a roster of `prl1…` payees, plan paydays
(weekly, biweekly, monthly, or custom), fund a run from a Taproot address, review a
grain-exact plan, sign it in the air-gapped signer, and broadcast the signed run.
Every payday is a **manual signed dispatch** — the app never auto-pays.

Live: https://kshot3000.github.io/Pearl-Muse-24-7-Ai-builder/pages/payroll/

Built by [@kshot9000](https://x.com/kshot9000) · tips: `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`

## The six steps

1. **Roster** — paste or type payees as `address, amount, label` lines, import a
   CSV, or use the sample roster. Amounts accept `PRL` decimals or `grains`.
   Invalid lines are **refused loudly** with the exact line number; duplicate
   addresses are merged when merging is on (the merge count is disclosed) and
   refused when it's off. Any line below the 546-grain dust floor is refused.
   Rows can be added, edited, and removed after validation.
2. **Schedule** — pick weekly, biweekly, monthly, or a custom day count, set an
   anchor payday and an optional run label. The planner shows the next **12 pay
   dates** plus a countdown to the next payday. Schedules are planners only —
   each date still needs a fresh signed dispatch through steps 3–6.
3. **Fund** — paste the sender `prl1…` address and fetch its UTXOs from Blockbook
   (GET-only), or paste `txid:vout grains` lines for an air-gapped run. Auto mode
   selects the fewest largest-first UTXOs that cover the run; manual mode lets
   you pick UTXOs one by one, with exact balance math shown live
   (inputs = payees + fee + change). A shortfall is refused before review. A
   warning fires when the balance covers fewer than two full runs.
4. **Review** — grain-exact breakdown: per-payee rows, per-input rows, fee math
   (vBytes × fee rate, computed via `keypathTxVBytes`), the run fingerprint, the
   unsigned txid, and the dust-change absorption note when change is below dust.
   A double-confirmation gate must be checked before moving on. The unsigned
   bundle (`pearl-payroll-unsigned:v1:`) can be exported to the signer as JSON.
5. **Sign** — the bundle can be imported on a signing device; the fingerprint is
   compared and the stored unsigned hex is **recomputed and cross-checked**
   before anything is accepted — a tampered bundle is refused. Paste a mnemonic,
   WIF, hex, or xprv; a key that doesn't control the sender address is refused
   before signing. 2/2 Schnorr signatures are re-verified locally, then the key
   is wiped from memory. The signed hex and txid are shown with a `pearld`
   one-liner for the air-gapped path.
6. **Broadcast** — a second double-confirmation gate, then the signed hex goes
   to Blockbook's `/api/sendtx/` as a single explicit POST. The run is recorded
   in the **History** ledger (localStorage, this browser only) with the run
   label, pay date, all payees, fee, txid, and timestamp.

**History** — every broadcast run is logged with a per-payee lifetime-totals
table. CSV export per run, full CSV export, and a clear button.

## Honest limits (always visible in the app)

- No auto-pay — ever. No background jobs, no cron, no smart contracts.
- Blockbook only reads UTXOs and broadcasts; it never sees your key.
- This browser tab has no memory of the future — nothing executes on payday.
- Keys live in page memory between entry and signing, then are wiped; they are
  never written to disk, never in a URL, never sent anywhere.
- Broadcast is a single explicit POST behind a double-confirmation checkbox.
- Review math is exact to the grain; fees come from the fee-rate box.
- Imported unsigned bundles are fully re-validated before use; imported history
  records are validated before display.
- Dust rule: below-546-grain lines are refused; dust change is absorbed into
  the fee with the amount disclosed.

## Build & test

```bash
cd files/pages/payroll
node build.mjs                                   # rebuilds pearl-payroll.bundle.js
node --no-warnings --loader ./tests/loader.mjs tests/payroll.test.mjs      # 44 core tests
node --no-warnings --loader ./tests/loader.mjs tests/payroll.dom.test.mjs  # 14 DOM tests
```

Protocol facts reused from the audited Pearl Sign lineage: bech32m `prl1…`/
`tprl1…` Taproot-only addresses, `1 PRL = 1e8 grains`, 546-grain dust floor,
fee sizing through `keypathTxVBytes`. No new cryptography.

## Attribution

Built by [@kshot9000](https://x.com/kshot9000) ·
`prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`
