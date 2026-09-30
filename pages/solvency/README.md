# Pearl Solvency — Proof-of-Reserves Desk for PRL

Live: https://kshot3000.github.io/Pearl-Muse-24-7-Ai-builder/pages/solvency/

Pearl has no smart contracts, so a proof of reserves can't be enforced on-chain.
Pearl Solvency enforces it the only way that works without contracts: a
**signed statement** plus **independent re-verification**. A custodian declares
liabilities and a list of addresses, proves control of every address by signing
a canonical challenge with the matching private key (BIP-340 Schnorr — the same
audited primitive Pearl Sign uses for transaction signatures; no new
cryptography), and publishes a tamper-evident bundle. Anyone can re-check every
signature and re-add the on-chain balances.

## The five steps: Custodian → Addresses → Prove → Bundle → Verify

1. **Custodian.** Name, challenge date, random nonce, declared liabilities
   (PRL, grain-exact), network, Blockbook API (GET-only reads; the page never
   broadcasts).
2. **Addresses.** Paste up to 250 `prl1p…`/`tprl1…` addresses. Each must be a v1
   Taproot address on the selected network; duplicates merge silently,
   everything else is rejected loudly.
3. **Prove.** Per address, enter the private key (WIF, 64-hex, or 12/24-word
   mnemonic, BIP-86 account 0). The page derives the keypath-tweaked address
   and **refuses any key that does not reproduce the listed address exactly**,
   then signs the canonical challenge
   `PearlSolvency/v1|{hrp}|{custodian}|{date}|{nonce}|{address}` with the
   tweaked key. Key inputs are wiped the moment signing finishes; keys are
   never stored. Air-gapped path: export the unsigned challenge bundle, sign
   offline, import the signatures (each re-verified before acceptance).
4. **Bundle.** Tamper-evident `pearl-solvency:v1` JSON with a 64-bit
   fingerprint (SHA-256 over canonical JSON). Editing any field — liabilities
   included — breaks the fingerprint. Copy or download; publish anywhere.
5. **Verify.** Paste any bundle. The page re-validates the fingerprint, checks
   **every** challenge signature, fetches confirmed UTXOs per address from
   Blockbook, byte-compares each funding output script against the address
   scriptPubKey (**foreign-script UTXOs are excluded, never trusted**), sums
   grains with BigInt, and stamps the verdict: **✓ Reserves proven**,
   **✗ Under-collateralized**, or a loud **BUNDLE TAMPERED** refusal.

## Honest limits (shown on the page, always)

- **Assets, not liabilities.** The desk proves the custodian controls on-chain
  PRL. Liabilities are self-declared — understating them makes anyone look solvent.
- **A snapshot, not an audit.** Balances move; a proof is true only for its
  challenge date.
- **Borrowed funds pass.** Nothing stops a custodian from borrowing PRL, proving
  reserves, and returning it.
- **Keypath P2TR only.** Script-path and multisig addresses cannot be proven
  this way — the key must derive the exact listed address.

## Verification

- 16/16 core tests (`node --loader ./tests/loader.mjs --test tests/solvency.test.mjs`):
  challenge canonicalization, key parsing, address-match guard, sign/verify
  round-trips, known-answer vector, bundle tamper-evidence, air-gap
  round-trips, grain-exact PRL math, script byte-comparison, verdict math,
  stubbed-fetch reserve summation.
- 3/3 DOM tests (`node --test tests/dom.test.mjs`): id cross-check, attribution
  check, full custodian→bundle UI flow in a stub DOM with real signing.
- 17/17 real-browser QA (headless Chromium 152, file:// + CDP, stubbed
  Blockbook, zero console/page errors): full wizard incl. wrong-key refusal,
  key wipe, end-to-end PROVEN verdict at 133.33%, tampered-bundle refusal.

Footer carries [@kshot9000](https://x.com/kshot9000) and the donation address
`prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`.
