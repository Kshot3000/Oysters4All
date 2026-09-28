# Pearl Escrow

Bonded 2-of-3 escrow on Pearl's Taproot rails — buyer, seller, and arbiter
agree on release; the buyer keeps a timelocked refund path if the deal dies.

**Live:** `pages/escrow/` · [Pearl Escrow](https://kshot3000.github.io/Pearl-Muse-24-7-Ai-builder/pages/escrow/)

## The contract

Two Taproot leaves under a NUMS internal key (no keypath spending possible):

| Leaf | Script | Spends when |
|---|---|---|
| Release | `0 <K1> CHECKSIGADD <K2> CHECKSIGADD <K3> CHECKSIGADD 2 EQUAL` | any **2 of 3** (buyer / seller / arbiter) sign |
| Refund | `<height> CHECKLOCKTIMEVERIFY DROP <R> CHECKSIG` | block height ≥ `<height>` **and** the refund key signs |

`OP_CHECKSIGADD` accumulation is Pearl's native 2-of-3: exactly two valid
signatures, one per key slot, in reverse CHECKSIGADD order in the witness.
The internal key is `H("PearlEscrowNUMS/v1" ‖ leaf hashes)` lifted to the
curve — a nothing-up-my-sleeve point, so nobody can bypass the scripts via
keypath spending. See `src/escrow-core.js` for the construction and
`tests/escrow.test.mjs` for the proof that it is independent of all party keys.

## What the app does

1. **Parties** — paste each party's x-only pubkey, 64-hex privkey, or BIP-39
   mnemonic (a fresh mnemonic can be generated per party). The refund key
   defaults to the buyer. Set the refund unlock height (one-click: current
   height + ~1 week, 3120 Pearl blocks).
2. **Contract** — derives the Taproot escrow address, shows both scripts
   disassembled, the 65-byte control blocks, and a QR for funding. Checks
   the address for confirmed funding via the Blockbook API (unconfirmed
   UTXOs are hidden — spending one would let a funder double-spend the
   deposit). A manual UTXO entry exists for air-gapped setups.
3. **Spend** — release mode pays the seller and returns change to the buyer;
   refund mode pays everything to the refund destination (minus fee) once the
   timelock opens. Each signature slot signs the exact sighash locally with a
   pasted mnemonic/privkey, or accepts a pasted 128-hex signature which is
   **verified against the party's contract key before assembly** — a bad or
   duplicate signature aborts the build.
4. **Broadcast** — copy the raw hex or broadcast through Blockbook.

Keys and mnemonics live in memory only — they are never persisted, never
sent anywhere, and signing never touches the network.

## Verification

- `tests/escrow.test.mjs` — 16/16: exact script bytes, script-number
  vectors, Taproot address/control-block derivation, leaf-order
  independence, sighash byte-equality with the audited Pearl Sign
  `buildRevealTx` digest, odd-Y BIP-340 signing, full 2-of-3 release flow,
  quorum/wrong-signature rejection, CLTV refund flow, fee/dust handling,
  `spendVBytes` weight match, NUMS internal-key independence.
- `tests/dom.test.mjs` — 6/6: page boots against the real bundle, all UI
  element ids resolve, full wizard (parties → contract → release plan →
  two local signatures → assembled tx), refund blocked while timelocked,
  tampered signature refused at assembly.
- No real-browser pass was possible on the builder VM (no Chromium
  available); compensated with the committed-bundle DOM harness above.

## Honest caveats

- Broadcasts are real PRL transactions — test on Pearl testnet first.
- The app has never been funded with real PRL; the flows above are
  cryptographically verified offline but no live escrow has settled.
- Fee estimates come from the configured Blockbook; the refund path uses a
  fixed 5 grains/vB.
- The arbiter cannot steal: release needs 2 of 3, so the arbiter must collude
  with buyer *or* seller to move funds.

## Protocol lineage

- Tapscript `OP_CHECKSIGADD` semantics: Pearl `node/txscript/opcode.go`
  (verified against upstream `3fe22676`).
- BIP-340 / BIP-341: signature, sighash, and control-block construction
  follow the Bitcoin reference; Pearl uses `prl` HRP bech32m addresses.

Built for the Pearl ecosystem. Tips: `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d` · [@kshot9000](https://x.com/kshot9000)
