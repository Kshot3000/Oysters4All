# Pearlscriptions / PRL-20 Explorer (static)

Community-built static dashboard for Pearl **PRL-20 tokens** and **Pearlscriptions**
(Ordinals-style inscriptions). Fills the "no PRL-20 / inscription explorer
dashboard suitable for static hosting" gap in the ecosystem survey.

Live (once GitHub Pages picks it up):
`https://kshot3000.github.io/Pearl-Muse-24-7-Ai-builder/pages/prl20/`

## How it works

The page talks to a **public Pearlscriptions indexer API** — the GET-only,
read-only HTTP API from [`Pearlscriptions/indexer`](https://github.com/Pearlscriptions/indexer)
(MIT; `apps/indexer-api`, Node ≥ 22 + Postgres on the operator side).

- The API base URL is typed into the "Indexer API" card and saved in this
  browser's `localStorage` only (`prl20.api`). No keys, no wallet, nothing is
  sent anywhere except `GET` requests to that API.
- Connection & status — `GET /health` (liveness; the chain/service name is
  shown in the connection pill), `GET /indexer/status` and `GET /network`
  (indexed/best height, sync state, checkpoint — the Indexer status card).
- Tabs:
  - **Tokens** — `GET /tokens` (deployed PRL-20 summaries with mint progress),
    `GET /tokens/:ticker` (deploy/mint/holder state).
  - **Inscriptions** — `GET /inscriptions?order=desc`, `GET /inscriptions/:id`,
    `GET /inscriptions/:id/location`.
  - **Operations** — `GET /operations` (deploy/mint/transfer with validity flags).
  - **Address** — `GET /addresses/:address/balances`,
    `GET /addresses/:address/transfer-lots`, `GET /addresses/:address/utxos`,
    `GET /addresses/:address/inscriptions`.
- Every field is read defensively: the UI renders only what the API returns.
  If the API is unreachable or unconfigured, the page says so honestly — no
  bundled or fabricated data anywhere.

## API contract reference

- `Pearlscriptions/indexer` → `docs/api-contract.md` (frozen GET routes)
- `Pearlscriptions/indexer` → `docs/prl-20-v0-spec.md` (deploy/mint/transfer rules)

## Dev / verification

Zero dependencies, no build step. Serve locally and point it at a test API:

```sh
cd pages/prl20
python3 -m http.server 8080
# open http://127.0.0.1:8080/
```

To verify rendering without a live indexer, run any stub HTTP server that
returns the shapes from the API contract above on `/tokens`, `/inscriptions`,
`/operations`, and `/addresses/*` — the page is agnostic to the backend as
long as it follows the contract.

## Tests

`tests/prl20.test.mjs` (logic) pins the pure helpers and card builders —
HTML escaping, truncation, BigInt-exact number formatting, URL building,
the inscription-location guard, and token/inscription cards including
hostile and missing fields. `tests/dom.test.mjs` (wiring/docs) pins every
`$("id")` lookup against `index.html`, the `styles.css?v=4` / `app.js?v=4`
cache keys, attribution, the GET-only contract, and the exact endpoint
set above against the calls `app.js` actually makes.

```sh
cd pages/prl20
node --test tests/prl20.test.mjs tests/dom.test.mjs
```

## Credits

Community-built by [@kshot9000](https://x.com/kshot9000).
Donations: `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`
