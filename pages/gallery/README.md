# Pearl Gallery — Pearlscriptions Inscription Wall

The gallery wall for [Pearlscriptions](https://www.pearlscriptions.com):
every inscription on the Pearl chain, hung on one wall — images, text,
audio and video — fetched live from a public
[Pearlscriptions indexer API](https://github.com/Pearlscriptions/indexer)
(`GET`-only, read-only) that you point the gallery at.

Live: https://kshot3000.github.io/Oysters4All/pages/gallery/

## Views

- **The wall** — latest inscriptions (`/inscriptions?order=desc`), lazily
  previewed as frames scroll into view (concurrency-capped), with content-type
  filters (All / Images / Text / Audio & video / Other) and paging.
- **Look up** — open one inscription by canonical number (`#42` pages the
  ordered list in 100s) or by inscription id (direct fetch).
- **Collection** — every inscription owned by an address
  (`/addresses/:address/inscriptions`).
- **Detail** — click any frame: full content render + metadata (number, id,
  content type, size, block, txid, owner, location).

## Content safety (the important part)

Inscription bodies are untrusted bytes from the chain. The gallery never
executes them:

- Only raster images (`png/jpeg/gif/webp/avif/bmp/apng`), audio and video
  are rendered inline, via validated `data:` URLs.
- **HTML and SVG are never rendered** — they show as escaped text or hex.
  (Scripts can hide in SVG/`data:` contexts; the allowlist in
  `js/gallery-core.js` refuses them.)
- Content-type values are strictly normalized before they reach a URL —
  hostile values (`image/png";…`) are rejected outright.
- Declared byte lengths are cross-checked against decoded bytes; oversize
  content (>8 MB) is never previewed.
- No wallet, no keys, no signing: the gallery only ever issues `GET`s.

## Contract

Endpoints used, verified against
[`Pearlscriptions/indexer` `docs/api-contract.md`](https://github.com/Pearlscriptions/indexer/blob/HEAD/docs/api-contract.md)
and cross-checked against `apps/indexer-api/src/indexer.js`
(`routeSnapshot`, `publicInscriptionRecord`) at release v1.3.1:

- `GET /health`, `GET /indexer/status`
- `GET /inscriptions` (`order=asc|desc`, `page`, `limit ≤ 100`)
- `GET /inscriptions/:id`
- `GET /inscriptions/:id/content` → `{ encoding: "base64", bodyBase64, … }`
- `GET /inscriptions/:id/location`
- `GET /addresses/:address/inscriptions`

The indexer base URL is typed into the "Indexer API" card and saved in
`localStorage` (`gallery.api`). Unconfigured or unreachable states render
honestly — nothing is bundled or faked.

## Files

- `index.html` — wall UI
- `styles.css` — gallery-wall identity: charcoal walls, brass frames, spotlight
- `js/gallery-core.js` — pure logic (classification, data-URL safety, query
  builders); shared browser/node, no DOM
- `app.js` — UI wiring
- `tests/gallery.test.cjs` — 15/15 node tests for the pure logic
- `tests/gallery-dom.test.cjs` — jsdom smoke tests against a stub indexer API
  (boot, connect, wall render, filter, detail modal, unconfigured state)

Run the tests:

```bash
node --test tests/gallery.test.cjs
npm i --no-save jsdom && node --test tests/gallery-dom.test.cjs
```

## Support the builder

Community-built by [@kshot9000](https://x.com/kshot9000). If the gallery saved
you time, tips in PRL are appreciated:
`prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`
