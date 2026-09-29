# Pearl Invoice — PRL Invoicing Studio

A receive-only invoicing studio for Pearl (PRL) freelancers and merchants:
compose line-item invoices, seal them into tamper-evident descriptors, share a
`pearl:` payment QR, watch for payment on-chain (GET-only Blockbook), and issue
hash-bound receipts — with a standalone verifier anyone can use.

Live: https://kshot3000.github.io/Pearl-Muse-24-7-Ai-builder/pages/invoice/

## The flow

1. **Compose** — invoicee name, 1–N line items (grain-exact BigInt PRL math),
   optional due date, memo, your own `prl1…`/`tprl1…` receiving address, optional
   payer label. Guards: empty line items refused, totals under the 546-grain
   dust floor refused, invalid addresses refused loudly.
2. **Descriptor** — tamper-evident
   `pearl-invoice:v1:<hrp>:<invoiceHash>:<totalGrains>[:<dueUnix>]` where
   `<invoiceHash>` is SHA-256 over the canonical invoice JSON. Copy/download the
   commitment, follow the publish checklist. Optional: derive a fresh per-invoice
   receiving address from your own BIP-86 mnemonic (account `9001`,
   `m/86'/{coin}'/9001'/0/<index>`) — keys stay in page memory with a wipe
   button; nothing is ever broadcast.
3. **Receive** — `pearl:` payment URI (`pearl:<addr>?amount=<exact PRL>`) + QR code
   for the exact total, with copy helpers.
4. **Watch** — GET-only Blockbook polling (configurable endpoint; mainnet default
   `https://blockbook.pearlresearch.ai`). States: **unpaid / partial** (exact
   grains remaining) / **paid / overpaid**, per-tx confirmation counts, manual
   refresh + 20s auto-refresh + an air-gapped paste-txid path. Unconfigured or
   unreachable endpoints are reported honestly — no fake data, no placeholders.
5. **Receipt** — on paid, issue a hash-bound
   `pearl-invoice-receipt:v1:<invoiceHash>:<txid>:<paidGrains>` record; CSV/JSON
   export of invoice + receipt.
6. **Verify** (standalone tab) — paste a descriptor + invoice JSON (+ receipt) →
   **PROVEN** or loud **NOT PROVEN** on any tampering.

## Crypto

None new. Address validation (bech32m, Taproot v1 only), SHA-256, and BIP-86
derivation all come from the audited Sign core (`../sign/src/crypto.js`) via the
shared importmap and the committed `pearl-invoice.bundle.js` (built with
`node build.mjs` — never edit the bundle by hand).

## Honest limits

- **Receive-only.** The page never spends PRL and never needs the invoicer's
  keys. The mnemonic tool only derives *receiving* addresses.
- **No custody, no escrow.** Payment is peer-to-peer on-chain. The descriptor
  proves the invoice existed — not that anyone was paid.
- **Watch ≠ settlement.** 0-confirmation payments are flagged ⚠ unconfirmed.
  Wait for 1+ confirmations before treating an invoice as settled.
- **Blockbook is a third party.** If it's down, stale, or lying, the page says
  so instead of inventing data.
- **Descriptors are commitments, not signatures.** They bind content to a hash;
  they don't prove who issued the invoice.
- **Due dates are advisory** — sealed into the descriptor, enforced by nothing.

## Tests

- `node --no-warnings --loader ./tests/loader.mjs --test tests/invoice.test.mjs` — 25 core tests (pinned descriptor hash, dust refusal, partial-payment math, tamper verifier, pinned BIP-86 vectors).
- `node --no-warnings --loader ./tests/loader.mjs --test tests/dom.test.mjs` — 13 DOM tests booting the real committed bundle via `vm`, driving the whole wizard against a stubbed Blockbook.

Built by [@kshot9000](https://x.com/kshot9000).
