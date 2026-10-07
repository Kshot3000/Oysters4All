# Pearl Batch — PRL Batch Payments Studio

A freight-terminal dispatch studio for sending one Pearl transaction to many
recipients. Paste a manifest, fund it from the sender's UTXOs, review the
grain-exact bill of lading, seal it with a local Schnorr signature, and
broadcast — or run the whole thing air-gapped with an unsigned bundle.

**Live:** https://kshot3000.github.io/Oysters4All/pages/batch/

## What it does

Five steps — **Recipients → Fund → Review → Sign → Broadcast**:

1. **Recipients** — paste one `<address>, <amount>` per line (or import a CSV).
   Every address is bech32m/Taproot-validated (`prl1…`/`tprl1…`), every amount is
   dust-checked (546-grain floor, refused — never rounded), memos are off-chain
   labels only. Duplicate addresses merge into one output when merging is on;
   with merging off, duplicates refuse loudly.
2. **Fund** — fetch the sender's UTXOs over GET-only Blockbook
   (`/api/v2/utxo/…`), or paste them air-gapped. Automatic largest-first coin
   selection, or tick UTXOs manually. Coverage is checked grain-exact:
   inputs = recipients + fee + change, or the dispatch is refused.
3. **Review** — the bill of lading: every recipient, every input, vBytes via
   the audited `keypathTxVBytes`, fee = vBytes × rate (grain-exact BigInt).
   Dust change is never created as an output — it is absorbed into the miner
   fee and disclosed (`fee` is the actual fee, `changeBump` shows the dust
   portion). Nothing seals until you check the confirmation box.
4. **Sign** — export the unsigned JSON bundle (canonical JSON + 64-bit
   SHA-256 fingerprint + unsigned txid + wire digest). Import it on the
   signing machine: fingerprint, txid, digest, fee, and vBytes are all
   re-derived and cross-checked before the key is touched. The address-match
   guard refuses keys that don't control the sender address. Every input's
   Schnorr signature is re-verified with `verifySignedTx` before the hex is
   shown; the key is wiped from memory and the input afterwards.
5. **Broadcast** — double-confirm gate, then POST to Blockbook `/api/sendtx/`,
   or copy the `pearld sendrawtransaction` curl for the terminal. Post-broadcast
   tracking polls `/api/v2/tx/:txid`, and the standalone verifier audits any
   txid against any manifest independently.

## Honest limits (always on screen)

- No smart contracts on Pearl — one plain P2TR transaction, max 250 recipients.
- Dust (< 546 grains) is refused everywhere; dust change becomes miner fee, disclosed.
- Blockbook reads are GET-only and trust-minimized: every signed tx is locally verified.
- Keys never leave the browser; there is no server, no account, no recovery.
- Estimates only: fee rate is a guess until the tx confirms.
- This is not financial advice. Verify the txid on an independent explorer.

## Build & test

- `node build.mjs` — rebuilds `pearl-batch.bundle.js` (esbuild IIFE,
  `window.PearlBatch`; crypto reuses the audited `../sign` modules — no new cryptography).
- `node --no-warnings --loader ./tests/loader.mjs tests/batch.test.mjs` —
  core engine tests (32/32): parsing, dust, duplicates ± merge, fee/change math
  incl. dust-absorption, bundle round-trip + tamper refusal, signing, audit.
- `node --no-warnings --loader ./tests/loader.mjs tests/batch.dom.test.mjs` —
  DOM integration tests driving the real `pearl-batch.bundle.js` + `app.js`
  with a stubbed Blockbook (16/16): full 5-step wizard, manual/auto selection,
  bundle export/import, wrong-key refusal, key wipe, broadcast POST, tracking,
  standalone verifier.
- `node ~/workspace/goals/pearl-blockchain-24-7-builder/hidden_files/qa-batch-browser.mjs` —
  headless-Chromium browser QA (file:// + CDP, stubbed Blockbook), 42/42 checks
  green, zero console/page errors.

All JS/CSS references carry `?v=1` cache keys.

## Attribution

Built by [@kshot9000](https://x.com/kshot9000). Donations:
`prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`
