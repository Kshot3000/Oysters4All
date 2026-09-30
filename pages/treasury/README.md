# Pearl Treasury — DAO / Team Treasury Command Center for PRL

**The vault ledger for teams and DAOs holding PRL in m-of-n Taproot vaults.**

Five tabs, one page, zero build step:

1. **Vaults** — register m-of-n Taproot vaults with a
   `covenant:v1:<hrp>:<m>-of-<n>:<keys…>` descriptor. The vault address is fully
   determined by the cosigner set under a NUMS internal key — no keypath bypass
   is possible. Live confirmed/unconfirmed balance tracking per vault via
   Blockbook (GET-only), with lifecycle rows and treasury totals in PRL + grains.
   Includes a one-click **demo 2-of-3 vault** generator for testing (mnemonics
   shown once, loudly labeled demo).
2. **Proposals** — spend proposals with tamper-evident ids: the SHA-256 of the
   proposal's canonical JSON plus a 64-bit fingerprint. Payees must be valid
   P2TR addresses; amounts use **integer grain math only** (never floats);
   memos are capped at 280 chars. Optional due dates and recurrence
   (daily/weekly/monthly).
3. **Sign** — cosigner approval: a proposal becomes a real covenant signing
   round; cosigners sign the sighash locally with a BIP-86 key (64-hex priv,
   WIF, or mnemonic — **in memory only**). Every signature is Schnorr-verified
   against the round digest *before* storage; quorum progress is k-of-m; a key
   that isn't a cosigner is loudly refused; a wipe button zeroes all key
   material. Signing is double-confirmed (review → confirm).
4. **Disburse** — at quorum, the round is checked against the proposal intent
   (payee, amount, change-back-to-vault) and finalized into a real Taproot
   script-path spend with exact vBytes fee planning and dust refusal. Raw hex
   is shown for inspection and broadcast through Blockbook (explicit,
   double-confirmed). Scheduled/recurring payouts live in an honest calendar
   table — nothing on-chain enforces timing; each payout is a manual quorum
   spend when due.
5. **Audit** — append-only, hash-chained log of every vault registration,
   proposal, signature, disbursement, and schedule event, with a one-click
   tamper check and JSON/CSV export.

## Crypto & safety — no new cryptography

Everything rides on the audited sibling lineage; treasury-core is orchestration
only (proposals, schedules, audit chaining, coin selection, key hygiene):

- `../sign/src/crypto.js` + `../sign/src/sign-core.js` — bech32m, BIP-86 key
  derivation, Schnorr, BIP-341 sighash, wire serialization, `parsePRL`/`fmtPRL`
  integer grain math, Blockbook helpers (`fetchUtxos`,
  `fetchFeeRateGrainsPerVByte`, `broadcastTx`), `NETWORKS`, `DUST_GRAIN`.
- `../covenant/src/covenant-core.js` — vault forging (`createCovenant`,
  `covenantDescriptor`, `covenantFromDescriptor`), NUMS internal key,
  CHECKSIGADD multisig leaf, signing rounds (`buildSigningRound`,
  `parseRound`, `signRound`, `importSig`, `roundStatus`, `finalizeRound`,
  `describeRound`), exact script-path vBytes planning
  (`covenantSpendVBytes`), `pubkeyFromPriv`.
- `../escrow/src/escrow-core.js` (via covenant) — `planSpend`/`spendVBytes`
  fee math, `addressToProgram` payee validation, `partyKeyFromInput`.

New in treasury-core: canonical-JSON proposal ids (SHA-256 from the audited
`sha256`), hash-chained audit entries, smallest-covering-UTXO selection over
vault UTXOs, calendar schedule math, and an in-memory key vault with
zero-on-wipe. None of it is cryptography — it only arranges the audited
primitives.

## Honest limits

- Pearl has **no smart contracts**: this desk coordinates **off-chain**.
  Proposals and signatures are local records until a quorum-signed transaction
  is broadcast — the chain only ever sees the final Taproot spend.
- Balances and fee estimates read **Blockbook, a third-party indexer** — it can
  lag or be wrong. The UTXO pasted for a disbursement is your responsibility
  to confirm.
- Private keys live **in memory only**, never in localStorage. Vault
  descriptors, proposals, schedules, and the audit log are public metadata and
  do persist locally.
- Recurring schedules are a **calendar table in this browser** — nothing
  on-chain enforces timing; each payout is a manual quorum spend when due.
- **No real funds were moved in testing** — disbursement hex is real
  transaction construction; verify it before you broadcast.

## Build & tests

- `node build.mjs` → `pearl-treasury.bundle.js` (`window.PearlTreasury`).
  esbuild resolved via `~/workspace/.build-tools`, with the same importmap
  plugin the bounty app uses (bare `@…` specifiers → `../sign/lib/`).
- `node --no-warnings --loader ./tests/loader.mjs --test tests/treasury.test.mjs`
  — 19/19 core tests green (descriptor rebind semantics, proposal
  tamper-evidence, dust/integer amount rules, 2-of-3 round → quorum →
  finalize hex, intent-drift refusal, audit-chain tamper detection, schedule
  math, key wipe zeroing).
- `node --test tests/dom.test.mjs` — 14/14 DOM tests green (real `app.js`
  driven against a strict DOM shim booting the committed bundle via `vm`:
  vault register → proposal → wrong-key refusal → 2-key quorum → disburse
  finalize → audit verify; fetch stubbed offline).
- `node ../../hidden_files/qa-treasury-browser.mjs` — real-browser QA
  (headless Chromium, `file://` + CDP): register vault, create proposal, sign
  with 2 keys to quorum, build disbursement hex — zero console/page errors.

Built by [@kshot9000](https://x.com/kshot9000) · tips: `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`
