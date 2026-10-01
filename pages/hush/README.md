# Pearl Hush

A **BIP-352 silent payments desk** for the Pearl blockchain (PRL). One static
`sp1…` address; every payment lands on a fresh, unlinkable taproot output that
only the recipient can find. Five tabs — Setup → Send → Scan → Labels → Verify —
on a midnight-indigo "hush" theme (nocturnal, soft glow, quiet).

## What it does

- **Setup** — generate a scan secret + spend secret locally
  (`crypto.getRandomValues`, nothing leaves the page), derive the silent-payment
  address, QR code, and the scan/spend public keys.
- **Send** — paste the inputs you will spend from (this desk derives only from
  taproot key-path inputs) and the recipient `sp1…` address(es); the desk runs
  the BIP-352 sender math and returns the exact taproot output keys plus their
  `prl1…` Pearl addresses to include in your transaction. Input secrets are
  wiped from the form after deriving.
- **Scan** — paste a transaction's inputs and taproot outputs plus your secrets;
  the desk replays the receiver scan, finds every output meant for you
  (including labeled ones — `m = 0` change is always checked), and derives the
  spend key for each.
- **Labels** — derive a labeled sub-address
  `B_m = B_spend + Hash_BIP0352/Label(b_scan ‖ m)·G` for any label `m`
  (0 = change), with QR and the label tweak.
- **Verify** — decode any silent-payment address to inspect its components, or
  run a **pinned official BIP-352 vector** through this very page
  (send → exact output key; receive → exact `priv_key_tweak`; address round-trip)
  for a byte-exact **PROVEN / FAILED** verdict.

## Provenance & correctness

- Formulas re-verified against the canonical BIP-352 text
  (`bip-0352.mediawiki`, fetched 2026-10-01) and cross-checked against the
  BIP's own `reference.py` and its test harness.
- The shipped bundle (`pearl-hush.bundle.js`) is **code-only** — the official
  `vectors-bip352.json` never ships to the browser. All 28 official vectors
  pass in the repo's node suite (`tests/hush.test.mjs`, 342/342): sending
  output-sets vs candidates, shared secrets, input sums/pubkeys byte-exact;
  receiving address re-encoding, found-output sets, shared secret/tweak/input-sum
  pins, vector schnorr signatures re-verified under derived spend keys,
  Kmax stop at 2323.
- The page's Verify tab embeds one official vector verbatim so the *deployed
  page* proves its own math in-browser.

## Honest caveats

- **Forward-looking standards desk, not a wallet.** BIP-352 is not yet
  supported by Pearl wallet software (Oyster). This page implements the
  published BIP-352 math byte-exact so the ecosystem has a correct reference
  when support lands.
- **Derived `prl1…` outputs are valid Pearl Taproot addresses** (well-formed
  bech32m v1 32-byte) for manual sweeping — but this page never signs and
  never broadcasts. Moving funds is on you, with a real wallet.
- **Silent-payment addresses use `sp1…`/`tsp1…`** exactly as published in
  BIP-352. No Pearl-specific HRP was invented.
- **Keys live in page memory only** and the Send tab wipes pasted input secrets
  after deriving. A "wipe all pasted keys" button sits in the Honest Limits
  panel. Anyone watching your screen or with access to the browser session sees
  them.
- **Deliberate deviations from the BIP reference** (all fail loudly, never
  silently): zero eligible inputs, an all-zero input secret, and
  outputs-exceeding-Kmax throw a visible refusal instead of a silent skip
  (BIP says "fail"; this desk fails out loud). The Send tab additionally
  refuses non-taproot inputs loudly — this desk only derives from taproot
  key-path inputs — while eligible-input classification otherwise follows the
  reference (ineligible inputs are skipped, not failed).
- **No CoinGecko, no network at all.** Pure client-side math; QR comes from the
  vendored `qrcode.min.js`.

## Files

- `index.html`, `styles.css`, `app.js` — the page (script/style URLs carry
  `?v=` cache keys, bumped on every change).
- `src/` — `hush-core.js` (the BIP-352 engine), `index.js`, `vectors-bip352.json`
  (official vectors, test-only — never bundled), `build.mjs`.
- `tests/hush.test.mjs` — 342 vector/property tests; `tests/dom.test.mjs` —
  76 bundle-boot/wiring tests.
- `pearl-hush.bundle.js` — the built code-only bundle.
- `qrcode.min.js` — vendored QR generator.

## Running the tests

```sh
node --loader ./tests/loader.mjs --test tests/hush.test.mjs   # 342/342
node --no-warnings --loader ./tests/loader.mjs tests/dom.test.mjs  # 76/76
```
