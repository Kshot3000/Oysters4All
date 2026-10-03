# Pearl Foundry — Open-Source PRL Mining Pool (dashboard)

Built by [@kshot9000](https://x.com/kshot9000) for the Pearl ecosystem. Donations: `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`

This page is the live dashboard for **Pearl Foundry**, the open-source stratum
mining pool for Pearl Blockchain (PRL). The pool server itself lives in
[`files/pool-server/`](../../pool-server/) — a real, working pool: it speaks
the dialects real miners use (HeroMiners, LuckyPool and Kryptex handshakes),
verifies every share with the official `zk-pow` verifier, retargets difficulty
per miner (vardiff), and pays PPLNS to the grain.

Open `index.html` directly (`file://`) or serve the directory; it also works
as-is on GitHub Pages.

## What the page shows

- Pool status: miners online, recent blocks & rounds, PPLNS rounds paid per
  block found, payout balances awaiting the payout threshold.
- Connect-your-miner instructions for each supported dialect, including solo
  mining (`solo:` login prefix) and static difficulty (`d=` password).
- A configurable backend API URL ("Use this backend") stored in localStorage —
  point it at your own Foundry server's dashboard API (default
  `127.0.0.1:8888`).

## Dashboard API

On every refresh (and every 10 seconds) the page reads exactly four
endpoints from the configured backend — all GET, `cache: no-store`:

- `/api/stats` — pool + payout summary (status cards and rounds)
- `/api/miners` — connected miners
- `/api/balances` — payout balances
- `/api/config` — public pool config (stratum port for the connect panel)

Every value those endpoints return is treated as untrusted display data:
wallet and worker strings come straight from miner logins, so `app.js`
HTML-escapes every backend-supplied string before it reaches the page, and
round rewards/fees (integer grains, 1 PRL = 1e8 grains) are formatted
exactly with BigInt rather than lossy floats.

## Honest limits

- **Demo mode is loud, never disguised.** When no pool backend is reachable
  at the configured API URL, the page shows a DEMO MODE banner and all
  figures are illustrative samples, not live pool data.
- **Stratum endpoints on the page are examples.** `pool.example.com:3333`
  is a placeholder — an operator substitutes their own host before miners
  can connect.
- The page is read-only: it never touches miner, wallet, or pool-server
  state; payouts are the server's job (PPLNS books in `pool-server`).

## Tests

The dashboard logic lives in `app.js` (extracted from its old inline
script so it can be tested in Node) and has its own suites in `tests/` —
28 logic tests (escaping of hostile API strings, grain-exact `fmtPRL`,
`timeAgo`/`hashrate`, API-base resolution, miner filtering, the section
builders) and 7 DOM/docs tests (every `$('id')` lookup resolves, the
`app.js?v=1` cache pin, attribution, and the exact four-endpoint contract
above, pinned against the code so docs and code cannot drift apart):

Run: `node --test tests/pool.test.mjs` and `node --test tests/dom.test.mjs`
(per-file — the bare directory form fails on Node 24).

The pool server it displays is covered by `files/pool-server` tests —
48/48 pass (stratum dialects, share pipeline, vardiff, PPLNS payouts,
templates, verifier protocol):

Run: `cd files/pool-server && node --test tests/*.js` (per-file glob — the
bare directory form fails on Node 24).
