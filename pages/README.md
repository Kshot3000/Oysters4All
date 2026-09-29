# Pearl GitHub Pages sites

Static websites built by the Pearl 24/7 AI builder, published via GitHub Pages.

## Sites

| Path | Description |
|---|---|
| `/` (repo root: `index.html`) | **Pearl website** — recreated project homepage: Proof-of-Useful-Work explainer, mining quickstart, developer components, ecosystem directory, donation section |
| `pages/explorer/` | **Pearl Explorer** — static block explorer: chain status + block/tx lookup against your own `pearld` JSON-RPC (mainnet port 44107). Settings persist in localStorage; zero dependencies |
| `pages/faucet/` | **Testnet Faucet** — static tPRL faucet frontend: bech32m address validation in-browser, drip requests to a configurable backend. Reference backend in `examples/faucet-backend/` (Node, zero deps; pays via Oyster `sendtoaddress`) |
| `pages/prl20/` | **PRL-20 Explorer** — static Pearlscriptions / PRL-20 dashboard: tokens with mint progress, inscription browser, operations feed, address balances/transfer-lots/UTXOs — all from a configurable public Pearlscriptions indexer API (`GET`-only, read-only) |
| `pages/mining/` | **Mining Calculator** — static PRL mining profitability calculator: exact upstream block-subsidy formula (BigInt), hashrate-share rewards, USD revenue vs. power cost, break-even price, emission-schedule charts, optional live `getmininginfo`/`getblockcount` from your own `pearld` node |
| `pages/rig/` | **Pearl Rig** — GPU mining profitability planner: wall-power fleet builder (sourced CMP 90HX preset), live PRL/USD price (CoinGecko default, CoinEx PEARLUSDT alternate via `proxy.mjs`), measured-output or TH/s-yield revenue models, pool fees, capex break-even, price-sensitivity table; exact upstream subsidy math (BigInt), 23/23 node tests |
| `pages/pulse/` | **Pearl Pulse** — watch-only PRL portfolio tracker + live network dashboard: address watchlist with in-browser bech32m validation, balances and tx history from the public blockbook API, live PRL/USDT price from CoinEx, chain status card; zero dependencies |
| `pages/sign/` | **Pearl Sign** — air-gapped Taproot transaction forge: BIP-86 key derivation, UTXO assembly (blockbook or pasted), exact vBytes fee math, BIP-341 keypath Schnorr signing (SIGHASH_DEFAULT + SINGLE\|ANYONECANPAY presign), local per-input signature re-verification, broadcast via blockbook or `pearld` `sendrawtransaction`; all crypto vendored, works offline once loaded; 16/16 node tests |
| `pages/prove/` | **Pearl Prove** — cryptographic proof desk: merkle inclusion proof verifier (fetch a block from blockbook or paste a path), merkle root builder, 80-byte block header decoder with nBits proof-of-work check; construction verified against upstream `node/blockchain/merkle.go` + real mainnet block 120195; 15/15 node tests |
| `pages/gallery/` | **Pearl Gallery** — Pearlscriptions inscription wall: latest-inscriptions grid with lazy previews, content-type filters, lookup by number/id, address collections, detail modal with full metadata; reads a configurable public Pearlscriptions indexer API (GET-only); HTML/SVG never rendered; 15/15 core + 2/2 DOM tests |
| `pages/etch/` | **Pearl Etch** — PRL-20 inscription composer: compose deploy/mint/transfer ops with strict spec validation, build + sign the Taproot commit/reveal pair locally (BIP-86 keys, BIP-341), batch envelopes, automatic PRLS launch-fee output, indexer-style witness self-verification; 13/13 node tests |
| `pages/escrow/` | **Pearl Escrow** — bonded 2-of-3 escrow: Taproot contract with OP_CHECKSIGADD release leaf (buyer/seller/arbiter) + CLTV timelocked refund leaf, NUMS internal key, local signing with per-signature verification, fee planning, Blockbook funding lookup + broadcast; 16/16 core + 6/6 DOM tests |
| `pages/notary/` | **Pearl Notary** — proof-of-existence timestamping: SHA-256 document fingerprint sealed in a Taproot `prl-notary` envelope via commit/reveal, 5-step wizard + printable seal certificate + standalone on-chain verifier; 16/16 core + 3/3 DOM tests |
| `pages/gift/` | **Pearl Gift** — printable PRL gift cards backed by real BIP-86 paper wallets (dedicated gift account `m/86'/coin'/1000'/0/0`), three card designs with the WIF hidden behind the fold, one-click redeem sweep with exact fee math + local signature re-verification; 7/7 core + 5/5 DOM tests, 13/13 real-browser QA |
| `pages/vesting/` | **Pearl Vesting** — non-custodial Taproot vesting schedules (linear or custom-dated tranches, one P2TR address per tranche, absolute CLTV claim leaf + optional funder clawback leaf after maturity, NUMS internal key, tamper-evident descriptors, Blockbook funding/maturity scans, one locally-signed + re-verified sweep tx per matured tranche, dust refusal); 14/14 core + 7/7 DOM tests, 28/28 real-browser QA |
| `pages/covenant/` | **Pearl Covenant** — m-of-n Taproot multisig vaults (1–16 cosigners, CHECKSIGADD script under a NUMS internal key, no keypath backdoor), tamper-evident JSON signing rounds, local signing + per-signature verification, quorum finalization, exact fee planning, Blockbook UTXO lookup + broadcast; 11/11 core + 6/6 DOM tests, 23/23 real-browser QA |
| `pages/stream/` | **Pearl Stream** — continuous PRL payment streaming: rate-based Taproot ticks (one P2TR address per tick, CLTV claim leaf + optional funder clawback leaf, NUMS internal key), live accrual dashboard (streamed/claimable/remaining), ONE multi-input batch-claim tx sweeping all matured ticks, funder cancel clawing back unmatured ticks, tamper-evident descriptors, exact fee math + per-signature re-verification, Blockbook scans + broadcast; 13/13 core + 8/8 DOM tests |
| `pages/rain/` | **Pearl Rain** — batch-send PRL airdrops: one funder key, one keypath transaction, up to 250 recipient outputs + change; recipient list paste/CSV import with Taproot address validation, duplicate merging, dust refusal, exact fee planning, local signing + per-signature re-verification, Blockbook UTXO lookup or air-gapped paste mode + broadcast; 9/9 core + 5/5 DOM tests, 29/29 real-browser QA |
| `pages/raffle/` | **Pearl Raffle** — provably-fair PRL raffles: tamper-evident `raffle:v1:` descriptors committing to prize + settlement block + weighted entries (SHA-256 entriesHash), publishable commitment, settlement countdown via Blockbook or manual block hash, winner draw `uint256(SHA-256("raffle-draw:v1:…")) mod totalTickets` over 1–3 rounds with full hand-verifiable derivation, standalone verifier with loud tamper refusal, exact payout plan (CSV + `pearl:` payment URIs/QR); page never moves PRL; 12/12 core + 7/7 DOM tests |
| `pages/swap/` | **Pearl Swap** — trustless PRL ⇄ BTC atomic-swap coordinator: Taproot HTLC script tree (claim leaf `OP_SHA256 <H> OP_EQUALVERIFY <bob> OP_CHECKSIG`, refund leaf `<T1> CLTV <alice> OP_CHECKSIG`) under a NUMS internal key, T1>T2 timelock hard guard + 144-block gap warning, shareable `swap:v1:` descriptors, local keypath lock tx with exact fee math + per-signature re-verification, Bob's script-path claim, Alice's CLTV refund (maturity + key guards), preimage extraction from claim witnesses, Blockbook track/scan + lifecycle classification, BTC mirror template (bc1p/tb1p, byte-identical claim leaf — page never builds Bitcoin txs); 18/18 core + 12/12 DOM tests, 27/27 real-browser QA |
| `pages/auction/` | **Pearl Auction** — sealed-bid PRL auction hall: tamper-evident `auction:v1:` descriptors (itemHash + min bid + commit/reveal block-height deadlines), sealed SHA-256 bid commitments (`pearl-auction-commit:v1:…`, 16-byte CSPRNG salt, publish-hash-only-before-commitH), loud refusal on reveal mismatch / late / duplicate / below-minimum, one-bidder-one-commitment rule with collision + double-reveal exclusion, highest-verified-bid-wins with earliest-reveal tie-break, full derivation table, winner-pays-seller-off-page `pearl:` payment URI + QR, CSV/JSON export, signed result record, standalone verifier with ✗ NOT PROVEN on tampered input, track countdowns; page never moves PRL; 17/17 core + 7/7 DOM tests, 21/21 real-browser QA |
| `pages/*` | Future sub-sites (dashboards) — each in its own subdirectory, linked from the homepage |

## Why this exists

The official monorepo README
([`pearl-research-labs/pearl`](https://github.com/pearl-research-labs/pearl))
lists `apps/` as holding "(website, desktop wallet)", but the website app is
missing from the repo — only `pearl-desktop-wallet` remains and no history of a
website was found on the `master` branch. This static site recreates it so the
project has a homepage again. It is community-built, not an official
pearl-research-labs property.

## Tech

Pure HTML + CSS + vanilla JS. **No build step, no dependencies** — GitHub Pages
serves the repo root as-is.

## Publish / update

GitHub Pages is configured on
[`Kshot3000/Pearl-Muse-24-7-Ai-builder`](https://github.com/Kshot3000/Pearl-Muse-24-7-Ai-builder)
with source **branch `main`, path `/`** (the only paths the Pages API allows
are `/` and `/docs`). Any push to `main` redeploys automatically — usually live
within a minute at:

https://kshot3000.github.io/Pearl-Muse-24-7-Ai-builder/

## Local preview

```bash
cd files   # repo root = site root
python3 -m http.server 8080
# open http://localhost:8080
```

## Conventions for new sites

- The Pearl website homepage lives at the repo root (`index.html`).
- Each new sub-site gets its own subdirectory under `pages/` (e.g.
  `pages/explorer/`, `pages/faucet/`) and is linked from the homepage's
  Ecosystem section.
- Every user-facing page must include the donation address and X account
  (see the homepage footer):
  - PRL: `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`
  - X: [@kshot9000](https://x.com/kshot9000)
