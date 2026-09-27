# Pearl Foundry — open-source PRL mining pool

A real, working stratum mining pool for [Pearl Blockchain](https://github.com/pearl-research-labs/pearl)
(PRL). Not a mock: every share is verified with the official `zk-pow` verifier — the same
`verify_plain_proof` code path the reference pools use — running in sandboxed Rust worker
processes. Job distribution, vardiff, stale/duplicate handling, PPLNS accounting and a live
dashboard API are all implemented against the pool dialects captured from live traffic on
2026-09-26.

## Architecture

```
miners --stratum--> src/stratum.js --+
                                     v
                              src/pool.js  (job board, vardiff, share pipeline, stats)
                                |        \
                 src/verifier.js \        \ src/payouts.js (PPLNS books, data/payouts.json)
                  (worker pool)   \        \
                                   v        v
                    verifier/ (Rust: official zk-pow verify_plain_proof)
                                     ^
                              src/templates.js (pearld getblocktemplate | synthetic demo)
                                     |
                              src/api.js (dashboard HTTP API, 127.0.0.1:8888)
```

## Quick start

```bash
cd files/pool-server
cp config.example.json config.json   # edit to taste
# build the verifier (needs Rust; cargo 1.9x)
(cd verifier && cargo build --release)
node src/index.js
```

* Stratum: `stratum+tcp://your-host:3333`
* Dashboard API: `http://127.0.0.1:8888/api/stats`
* Dashboard page: `files/pages/pool/index.html` (point it at the API with `?api=`)

`npm test` runs the suite (`node --test tests/`). The verifier-protocol tests skip
gracefully if the Rust binary hasn't been built yet.

## Miner compatibility

The stratum server speaks the three dialects documented in the live captures:

| Dialect | Handshake | Proof field |
|---|---|---|
| HeroMiners / LuckyPool | object `mining.authorize` `{wallet, worker, agent}` | `plain_proof` (or `plain_proof_zst`) |
| Kryptex | silent object `mining.subscribe`, then array `mining.authorize` `["wallet.worker","x"]` | `plain_proof` |
| Kryptex v2 | object authorize with `"type":"v2"` | `plain_proof` = base64(gzip(bincode)) |

* `job_id` is `<8-hex counter>_<difficulty>`; each job carries its own 64-hex big-endian
  `target`, `header` (152-hex / 76-byte `IncompleteBlockHeader`), `height`, `cert_version`.
* Difficulty retargeting is **job-based** (LuckyPool-style): a fresh `mining.notify` arrives at
  the new difficulty. Starting difficulty 2,097,152; vardiff targets one share per ~15 s.
* Password `d=<N>` selects a static difficulty (Kryptex-style, minimum 2,097,152).
* `solo:<address>` mines solo: no PPLNS weight, a solo block pays the finder directly.
* Stale-share abuse: >30% stale after 1000 shares → 3600 s ban (HeroMiners-style tier).
* Stratum replies use the reference-pool framing and codes:
  `20` invalid share, `21` job not found, `22` duplicate share, `24` unauthorized.

TLS: set `stratum.tls = {"key": "...", "cert": "..."}` in `config.json` (Kryptex and
LuckyPool miners expect TLS in practice).

## Share verification (the important part)

`verifier/src/main.rs` is a thin worker around the **vendored official zk-pow verifier**
(`third_party/zk-pow`, same source the open-source miners build against):

1. 152-hex job header → `IncompleteBlockHeader::from_bytes` (layout + roundtrip check)
2. base64 decode (+ zstd/gzip decompression), 16 MiB inflation cap, compressed-bytes-in-`plain_proof` sniff guard
3. `PlainProof::deserialize_compat`
4. `check_cert_version_eligible` (advertised `cert_version`, default 3 = salted seeds)
5. `verify_plain_proof(header, proof, Some(share_nbits), Salted)` — jackpot recomputed and
   checked against the **pool share target**
6. `verify_plain_proof(header, proof, None, Salted)` — block detection against the header's
   network nbits

Node.js round-robins requests across worker processes over NDJSON. If a worker dies or
times out, the share is **rejected** — never accepted on infrastructure failure. Duplicate
proofs are rejected by SHA-256 digest of the decoded bytes.

## Templates: `pearld` vs synthetic

* `"template": {"mode": "pearld", "url": "http://127.0.0.1:44107", "user": "…", "pass": "…"}`
  polls `getblocktemplate` with the `coinbasetxn` capability. The node builds the coinbase
  paying `--miningaddr` (the pool wallet); the pool derives the merkle root and the 76-byte
  header from the template. `requiredcertversion` from the node is authoritative.
* `"mode": "synthetic"` generates well-formed fake headers for testing and dashboard demos.
  **These are never real blocks** — the dashboard labels them demo.

## Block-found flow (read this before mainnet)

When a share also meets the header's network nbits, the pool:

1. archives the candidate (header, proof, finder) in memory + the API (`/api/blocks`),
2. credits the PPLNS round / solo finder in `data/payouts.json`,
3. refreshes the template so miners move to the new tip.

**What the pool does NOT do yet:** assemble and `submitblock` a full block. A submittable
Pearl block needs the complete certificate for the winning proof, which only a proving
miner can produce — the pool verifies shares, it doesn't hold proving keys. The candidate
archive gives the operator everything needed to coordinate submission with the finding
miner. This is an honest v1 boundary, documented in the code (`submittable: false`).

## Payouts

* Scheme: **PPLNS** over the trailing `windowShares` shares (default 1,000,000), weight =
  share difficulty. Stale shares earn no weight. Exact-grain accounting (1 PRL = 1e8
  grains) with largest-remainder splitting — the books always balance.
* `poolFeePct` (default 1.0), optional `finderBonusPct`, `minPayoutPRL` (default "1").
* `GET /api/payouts/due?min=<grains>` lists wallets above threshold; the operator pays from
  the pool wallet and records it with `payouts.markPaid(wallet, grains, txid)` (Node REPL
  or the operator script — coin movement is always the operator's keys, never the pool's).

## Operator checklist for mainnet

1. Run `pearld` with `--miningaddr=<pool wallet>` and RPC credentials.
2. `config.json`: `template.mode = "pearld"`, real `networkId`, TLS certs for stratum.
3. Open firewall for the stratum port; keep the API on 127.0.0.1 behind a reverse proxy.
4. Back up `data/payouts.json` — it is the books.
5. Point the dashboard at the public API URL (`?api=https://…`).

## Limitations (honest)

* Full positive verification of a real miner proof needs a live miner: no real proof
  vectors were available for unit tests, so the verifier is tested on negative vectors
  (malformed headers/proofs rejected, compression guards, size caps, worker lifecycle).
  The accept path is the official `verify_plain_proof`, identical to the reference pools'.
* `submitblock` assembly is not implemented (see Block-found flow).
* The dashboard API has no auth — bind it to localhost / proxy it.
* `mining.set_difficulty` / `client.reconnect` are not implemented (the captured Pearl
  clients don't use them; difficulty rides on jobs).

⛏️ Donations: `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d` ·
[@kshot9000](https://x.com/kshot9000)
