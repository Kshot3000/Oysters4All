# Pearl-Muse-24-7-Ai-builder

Autonomous builder workspace for the **Pearl Blockchain** — maintained 24/7 by Muse.

> Tagging the Pearl team: @pearl-research-labs — this repo is 50+ open-source apps
> and tools built for the Pearl (PRL) ecosystem. Team feedback and corrections welcome.

## What is Pearl?

Pearl (PRL) is a Layer-1 blockchain using **Proof-of-Useful-Work (PoUW)**. Instead of
Bitcoin-style hash puzzles, miners perform matrix multiplication — the same
computation GPUs use for AI inference — so the work that secures the chain can
simultaneously serve real AI compute demand. It is a Bitcoin fork (UTXO model,
longest-chain rule) with Taproot-only addresses, post-quantum signature opcodes,
and Plonky2 zk-SNARK block certificates.

- Official code: https://github.com/pearl-research-labs/pearl
- This builder repo: https://github.com/Kshot3000/Pearl-Muse-24-7-Ai-builder

## Planned apps (in progress)

| App | Status | Description |
|---|---|---|
| `index.html` (Pearl website) | ✅ live | Recreated project homepage — PoUW explainer, mining quickstart, dev docs, ecosystem. Served via GitHub Pages |
| `examples/hello-pearl` | ✅ scaffolded | Minimal TypeScript JSON-RPC client — your first `pearld` connection |
| `pearl-rpc-client` | ✅ built | Fuller typed TypeScript RPC client library (20+ methods; typechecked + built) |
| `wallet-helper` | ✅ built | BIP-39/32/86 Taproot address derivation + Oyster wallet JSON-RPC helpers (27 tests, incl. official BIP-86 vectors) |
| `pages/explorer/` | ✅ built | Static block explorer querying a `pearld` RPC node |
| `pages/faucet/` | ✅ built | Static testnet faucet frontend (bech32m validation) + reference Node backend paying via Oyster `sendtoaddress` |
| `pages/prl20/` | ✅ built | Static Pearlscriptions / PRL-20 dashboard reading a configurable public indexer API |
| `pages/mining/` | ✅ built | PRL mining profitability calculator: exact upstream emission formula, hashrate-share rewards, emission-schedule charts, optional live node data |
| `guides/rpc-cheatsheet.md` | ✅ done | `pearld` JSON-RPC cheatsheet with `curl` examples, verified against upstream docs |
| `guides/running-pearld.md` | ✅ done | Running a Pearl node: prebuilt installer vs source build, first sync, networks + ports, enabling RPC, connectivity, Oyster wallet, mining hookup — all facts verified against upstream docs |
| `pages/psbt/` | ✅ built | Taproot PSBT signing workbench — create/inspect/sign/combine/finalize BIP-174 PSBTs with exact BIP-341 sighashes (keypath + scriptpath); crypto vendored from the audited sign core, 39 tests / 158 assertions |

## How the 24/7 builder loop works

1. **Every 2 hours** the builder wakes up and syncs the upstream Pearl mirror
   (kept in the goal workspace, never pushed).
2. It works the prioritized queue: fix broken builds → scaffold apps → improve docs.
3. Each run appends to `hidden_files/build-log.md` so you can see exactly what
   changed and why.
4. Finished work is **committed and pushed to `main`** automatically every run.

## Accessibility

Every form control in every app carries a programmatic label (a `<label for>`
association or an `aria-label`), so the fleet works with screen readers and
voice control. Audited fleet-wide on 2026-10-02: 152 previously unlabeled
controls across 43 apps were fixed; 0 unlabeled controls remain. The same
audit's second pass fixed document structure: every page now has exactly one
`<h1>` (the multi-step wizards in Gift, Rain, and Wallet demoted their later
step headings to styled `<h2>`s) and a `<main>` landmark (added to Legacy,
Names, Pool, and Vanity). A third pass the same day fixed the heading
outline: no page skips a heading level anymore (the honest-limits panels in
Burn, Hush, Mesh, Pact, Sighash, and Will are now `<h2>`s, and six panel
sub-headings in Auction, Ballot, Policy, and Raffle were promoted from
`<h4>` to `<h3>`), with computed styles verified identical in a real
browser — the outline changed, the pixels didn't. A fourth pass the same day
gave every page a visible keyboard-focus ring: a global `:focus-visible`
outline (2px, offset 2px) in each app's own accent color on buttons, links,
tabs, and cards — previously only 3 of 77 pages defined one, so keyboard
users relied on the browser default, which is easy to lose against the
fleet's dark, glowing surfaces. Verified in a real browser on all 77 pages:
the first focusable element on every page matches `:focus-visible` and
renders the ring, with zero console errors. A fifth pass the same day added
a skip-to-main-content link as the first Tab stop on every page: parked
off-screen until keyboard focus reveals it as a dark chip in the app's own
accent, it jumps straight to the `<main>` landmark — which now carries
`tabindex="-1"` so focus, not just scroll position, moves with it — and
keyboard users no longer tab through the full header and step-nav on all
81 pages. The two pages in the companion Hermes repo (landing page and
live dashboard) received the same skip link plus the focus ring they had
missed. Verified in a real browser on all 81 pages here and both Hermes
pages: the first Tab reveals the link at AA contrast, Enter lands focus
on `<main>`, zero console errors. (Pearl Wallet's `<main>` sits inside its
app view, so while its onboarding or lock view is showing, the link lands
focus on that visible view instead; Batch and Payroll no longer scroll to
their first panel on load, which had moved the first Tab stop past the
link.) A sixth pass the same day made the fleet respect
`prefers-reduced-motion`: most apps animate — fade-in panels, pulsing
status lamps, drifting glows, marquee tapes — and scroll smoothly, but
only a handful honored the OS reduced-motion setting that users with
vestibular disorders rely on. Every stylesheet now carries a universal
reduced-motion block: animation and transition durations collapse to
near-zero (deliberately not `animation: none`, so fade-ins still land on
their end state and no content can be stranded invisible),
infinite animations run a single iteration, and smooth scrolling turns
off; the hub, Pay, and Wallet pages' earlier hand-tuned rules (Pay's
payment-status text still settles on its final state) are completed by
the same block, and Pool plus the two Hermes pages carry it inline. The
21 places in 20 apps that forced `behavior: "smooth"` from JavaScript —
which the CSS setting cannot reach — now check `matchMedia` and scroll
instantly under reduced motion instead. Verified in a real browser with
reduced motion emulated on all 82 pages (80 here, both Hermes pages):
every computed animation and transition duration is near-zero, every
iteration count is 1, computed scroll behavior is `auto`, and the one
element the sweep found at opacity 0 is Wallet's toast, which is hidden
until shown by design; with the preference off, motion is untouched
(Auction's 22-second glow drift still runs). All 127 test suites match
their pre-pass results exactly, and every changed stylesheet and script
carries a bumped `?v=` cache key. A seventh pass the same day fixed color
contrast fleet-wide: 4,425 text elements were probed in a real browser and
every one of the 264 that fell short of WCAG AA (4.5:1 for text, 3:1 for
large text) was brought up to standard — muted text colors brightened with
their hue preserved, gradient button stops deepened where white or dark
text sat on them, and the one light-themed app (Pearl Prove) darkened
instead. An eighth pass the same day fixed touch-target size (WCAG 2.5.8):
1,633 interactive elements were measured in a real browser at a phone
viewport, and all 61 standalone targets under the 24px minimum were padded
or sized up to it — header nav links in Faucet, Mining, PRL-20 Launcher,
Prove, Rig, and Sign, Bond's copy buttons, Invoice's row-remove buttons,
the Hermes landing page's card links, and every native checkbox and radio
in the fleet (previously 13–18px, now 24px). Links inside a sentence keep
their inline size, which 2.5.8 explicitly allows. Re-probed after the fix:
0 standalone targets under 24px remain, and every changed stylesheet
carries a bumped `?v=` cache key.

## Support this work

If this builder saved you time, donations are welcome:

**PRL:** `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`

**X:** [@kshot9000](https://x.com/kshot9000)

## Quick start

```bash
# 1. Build and run a pearld node (from the upstream mirror)
task build:pearld

# 2. Try the hello-pearl RPC example
cd files/examples/hello-pearl
npm install
PEARL_RPCUSER=youruser PEARL_RPCPASS=yourpass npm start
```

See `examples/hello-pearl/README.md` for details.
