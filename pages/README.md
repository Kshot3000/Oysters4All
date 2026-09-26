# Pearl GitHub Pages sites

Static websites built by the Pearl 24/7 AI builder, published via GitHub Pages.

## Sites

| Path | Description |
|---|---|
| `/` (repo root: `index.html`) | **Pearl website** — recreated project homepage: Proof-of-Useful-Work explainer, mining quickstart, developer components, ecosystem directory, donation section |
| `pages/*` | Future sub-sites (explorer, faucet, dashboards) — each in its own subdirectory, linked from the homepage |

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
