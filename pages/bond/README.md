# Pearl Bond — the fixed-income desk for PRL

Issue fixed-income bonds on Pearl. A bond is a set of **pre-funded Taproot tranche outputs** — one per coupon plus principal at maturity. Each tranche pays its holder at its lock height. Fully collateralized by construction: no issuer credit risk, no smart contracts, no custodian.

Built by [@kshot9000](https://x.com/kshot9000) for the Pearl ecosystem. Donations: `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`

## How it works

**Term sheet → tranches.** You set face value, annual coupon rate, frequency (annual / semiannual / quarterly / monthly), number of periods, and issue height. The app computes a 30/360 coupon schedule and maps each payment date to a block height (chain target: 194 s/block).

**Two-leaf taptree per tranche** (NUMS internal key, domain `"PearlBondNUMS/v1"` — nobody knows the discrete log, so keypath spends are impossible):

- Leaf A (claim): `<lock> CLTV DROP <holderXOnly> CHECKSIG` — byte-identical in shape to the audited vesting claim leaf.
- Leaf B (transfer): `<holderXOnly> CHECKSIG` — lets the holder reassign the tranche pre-maturity (the secondary market).

**Funding.** The issuer sends exactly each tranche's amount to its address. Until those outputs confirm, the term sheet is just a plan — the schedule *is* the collateral.

**Redeem.** After maturity the holder signs a claim (SIGHASH_DEFAULT, script path) locally; the signature is re-verified in-page before the transaction is built. Broadcast with your own node/wallet — this page never broadcasts on its own.

**Secondary transfer (atomic).** The seller presigns one leg per tranche with `SIGHASH_SINGLE|ANYONECANPAY (0x83)`. The 0x83 presignature commits only to its own input↔output pair, so the buyer can safely verify the package and build a single fill transaction: tranche inputs (seller's 0x83 witnesses) at matching indexes, buyer's payment input signed SIGHASH_DEFAULT, seller's payment output, buyer's change. Neither side can steal from the other.

**Track.** Paste the bond descriptor; the app re-derives every tranche address and classifies each against Blockbook (unfunded / locked / claimable / spent).

## The one new cryptographic construction

Everything reuses the audited Sign/Escrow/Market lineage except `scriptPathSigDigest83()` in `src/bond-core.js`: the BIP-341 sighash for a script-path input with hash type `0x83`.

**Consensus cross-check (2026-09-30).** The digest was verified byte-for-byte against `pearld`'s `node/txscript` `CalcTapscriptSignaturehash` using a temporary Go harness (since removed to keep the upstream mirror clean). Two vectors are pinned in `tests/bond.test.mjs`:

- `6eb021de…b51e` — script-path `0x83` spend of the transfer leaf
- `8f24f032…0186` — script-path `SIGHASH_DEFAULT` spend of the claim leaf (via `escrow-core`'s `scriptPathSigDigestEx`)

That cross-check caught a genuine latent consensus bug: the JS lineage wrote `spend_type = 0x01` for script-path spends, but BIP-341 (and `pearld`) require `0x02` (`ext_flag=1`, no annex). Signatures built with `0x01` would be rejected by consensus. Fixed in `sign/src/crypto.js`, `escrow/src/escrow-core.js`, `market/src/crypto.js`, `stream/src/stream-core.js`, `vault/src/vault-core.js`, `quorum/src/quorum-core.js`, `prl20-launcher/pearl-inscribe.js`, and `bond/src/bond-core.js`; all affected bundles rebuilt; Go-pinned regression vectors added. Self-consistent sign/verify round-trips had masked the bug — only a consensus cross-check could catch it.

## Files

- `index.html` / `styles.css` / `app.js` — the 5-step wizard (Terms → Schedule & Fund → Redeem → Transfer → Verify & Track)
- `src/bond-core.js` — bond math, forging, signing, transfer packages (~700 lines)
- `src/index.js` — bundle entry (`window.PearlBond`)
- `pearl-bond.bundle.js` — committed esbuild bundle (rebuild with `node build.mjs`)
- `tests/bond.test.mjs` — 22 node tests incl. the Go-pinned vectors; `tests/dom.test.mjs` — UI smoke tests
- `tests/loader.mjs` — import-map loader for node

## Honest limits

- Nothing is locked until the issuer funds each tranche address on-chain.
- Coupon dates are block-height estimates (194 s target); real maturity follows the chain.
- Secondary transfers need the seller's cooperation to presign — no trustless listing or price discovery.
- Testnet has no public indexer wired in; live tracking is mainnet-only.
- Test on testnet first. A toolkit, not legal/tax/investment advice.
