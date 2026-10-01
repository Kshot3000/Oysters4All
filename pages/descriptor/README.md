# Pearl Atlas — BIP-380 Output-Descriptor Desk for PRL

A cartographer's map-room for output descriptors on Pearl: parse, checksum,
derive, and verify descriptors exactly the way Bitcoin Core handles them,
adapted for Pearl's Taproot-only chain (`prl1…` / `tprl1…` bech32m addresses).

Live: `pages/descriptor/index.html` (served from the repo's GitHub Pages).

## What it does

- **Analyze** — pastes any descriptor and charts it: grammar parse, BIP-380
  checksum state, every key (origin, type, range), and the full Taproot tree
  (internal key, Merkle root, output key, per-leaf control blocks).
- **Checksum** — adds (`descAddChecksum`) or verifies BIP-380 checksums.
- **Derive** — derives addresses over an index range per BIP-386. Only `tr()`
  and `addr()` are Pearl-spendable; legacy types return their exact
  scriptPubKey with an honest "not a Taproot type" note.
- **Templates** — five charted shapes (BIP-86 receive/change, 2-of-3 Taproot
  multisig, timelocked vault leaf, hash-locked claim leaf). Placeholders must
  be replaced with real keys — the desk refuses to derive from them.
- **Verify** — runs the pinned self-test battery in the browser: official
  BIP-380/BIP-393 checksum vectors, a known-answer BIP-86 address, control
  block recomputation, BIP-389 multipath expansion.

## Crypto core (`src/descriptor-core.js`, ~60 KB, node-testable)

- BIP-380 checksum (polymod, verified against official vectors, incl. the
  BIP-393 `wpkh…#kf3v6fpx` vector).
- Recursive-descent grammar: `pk pkh wpkh sh wsh tr multi sortedmulti multi_a
  combo addr raw` + all Taproot script fragments (`pk_k pk_h older after
  sha256 hash256 ripemd160 hash160 and_v and_b andor or_b or_c or_d or_i
  thresh`), key origins, hardened markers, wildcards, multipath.
- Exact tapscript builders (BIP-342), Core-style pairwise-balanced taptrees
  (BIP-386), key tweaking, control blocks.
- Keys: WIF/hex, 33/65-byte pubkeys, xpub/tpub (+ypub/zpub/upub/vpub) via the
  vendored `@scure/bip32` HDKey. Hardened derivation from an xpub is refused
  loudly; private material never leaks into public derivation silently.
- Reuses the audited `files/pages/sign/src/crypto.js` (bech32m, tagged
  hashes) — no new crypto primitives.

## Honest limits

- Fully offline: no network calls, ever. Descriptors never leave the page.
- Descriptors are not wallets: the desk charts and derives; it does not sign,
  broadcast, or hold funds.
- Private keys stay in memory and are wiped via the Wipe button; a warning
  appears whenever private material is pasted.
- Checksums catch typos, not malice.

## Tests

```sh
node --no-warnings --loader ./tests/loader.mjs --test tests/*.test.mjs
node hidden_files/qa-tools/atlas-qa.cjs   # headless Chromium, file:// + CDP
```

33 unit tests + 31 DOM checks + 16/16 real-browser QA checks, zero console
errors.

## Files

- `index.html` / `styles.css` / `app.js` — the desk UI (map-room theme).
- `src/descriptor-core.js` — pure logic (importable in node).
- `src/index.js` — bundle entry → `window.PearlDescriptor`.
- `pearl-descriptor.bundle.js` — committed esbuild bundle (`node build.mjs`).
- `tests/descriptor.test.mjs`, `tests/dom.test.mjs`, `tests/loader.mjs`.

Built by [@kshot9000](https://x.com/kshot9000) ·
`prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`
