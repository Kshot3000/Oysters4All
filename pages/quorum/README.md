# Pearl Quorum — n-of-m Taproot Multisig Shared-Custody Desk

The council chamber. Forge an m-of-n Taproot multisig vault (1–7 cosigners), fund it,
plan spends, collect Schnorr signatures from cosigners — including remote ones via
tamper-evident signature bundles — and broadcast with a double-confirm gate.

No smart contracts. No servers. Keys never leave the page, and the key field is wiped
after every signing.

**Live:** https://kshot3000.github.io/Oysters4All/pages/quorum/

## The six steps

1. **Vault** — enter 1–7 cosigner public keys (64-hex x-only or 66-hex compressed;
   each key is curve-validated). Pick the threshold m. The desk assembles the
   `<0> <K1> CHECKSIGADD … <Kn> CHECKSIGADD <m> EQUAL` leaf under a NUMS internal
   key, and derives the P2TR address. Export / import the tamper-evident
   `pearl-quorum:v1:` descriptor so every cosigner can verify the same address.
2. **Fund** — the vault address with a QR code, a recompute-and-compare address
   verifier (every cosigner should see the same address), Blockbook balance +
   UTXO reads (GET-only), or pasted air-gapped UTXOs. Tick the UTXOs to spend.
3. **Spend** — recipients, fee rate (with a one-tap Blockbook estimate), and an
   exact plan: grain-exact fee math, dust absorption disclosed out loud, one
   BIP-341 script-path sighash digest shown per input. Exports the
   `pearl-quorum-unsigned:v1:` bundle — import re-derives every digest, the fee,
   and the fingerprint, and REFUSES on any mismatch.
4. **Cosign** — the quorum ring fills as slots seal. Each cosigner verifies and
   loads the unsigned bundle, picks their slot, and signs locally: the desk
   checks the private key actually controls that slot's pubkey (KEY REFUSED
   otherwise), self-verifies every signature, then wipes the key field.
   Signature bundles (`pearl-quorum-sigs:v1:`) travel to the coordinator, where
   every signature is re-verified before counting. At m-of-n, finalize assembles
   the witness (reverse key order, empty vectors for non-signers — the same
   BIP-342 mechanics as the audited escrow leaf).
5. **Broadcast** — double-confirm gate, then POST to Blockbook `/api/sendtx`,
   with confirmation tracking.
6. **Ledger** — localStorage record of vaults and spends, with CSV export.

## Honest limits

- This is **script-path** multisig (CHECKSIGADD in a Taproot leaf), not MuSig /
  key aggregation. On-chain it looks like one leaf in one script tree.
- The desk cannot verify that the cosigner keys belong to *distinct real parties*.
  If one person holds all the keys, the "multisig" is theater. Verify the
  descriptor — and the address — independently with every cosigner before funding.
- The default internal key is a NUMS point (`PearlQuorumNUMS/v1`): nobody can
  spend via keypath. The optional *designated-cosigner internal key* mode re-enables
  a keypath spend by one cosigner and is stamped with a loud on-screen warning —
  use it only if you understand exactly what you're giving away.
- Blockbook reads and fee estimates are convenience data from a third party;
  pasted UTXOs are your own responsibility to get right.
- The automated tests perform no real broadcast and move no real PRL.

## Cryptography

No new cryptography was invented for this desk. Every primitive comes from the
audited cores already shipping in this repo: Schnorr signing/verification and
bech32m from `pages/sign/`, the script-path sighash and taptree leaf mechanics
from `pages/escrow/`, the canonical-JSON fingerprint from `pages/batch/`.

## Tests

```sh
cd pages/quorum
node build.mjs                                   # rebuild pearl-quorum.bundle.js
node --no-warnings --loader ./tests/loader.mjs tests/quorum.test.mjs   # 28/28 core
node --no-warnings tests/dom.test.mjs            # 8/8 UI (vm DOM harness, stubbed fetch)
node tests/quorum.browser.qa.mjs                 # 32/32 real-browser QA (headless Chromium, file:// + CDP, stubbed Blockbook, zero console/page errors)
```

## Attribution

Built by [@kshot9000](https://x.com/kshot9000) · `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`
