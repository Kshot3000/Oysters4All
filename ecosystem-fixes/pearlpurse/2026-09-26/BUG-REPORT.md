# Bug report — buildandtestppg/pearlpurse (Pearl web wallet, v0.4.4)

**Scanned:** 2026-09-26 (repo created 2026-09-26; first scan)
**Repo:** https://github.com/buildandtestppg/pearlpurse
**Fix branch:** `fix/fee-size-and-relay-cleanup` (f1104bd) on fork Kshot3000/pearlpurse
**Upstream PR:** https://github.com/buildandtestppg/pearlpurse/pull/5
**Patch:** `fix-pearlpurse-fee-size-and-relay-cleanup.patch` (in this directory)

## Bug 1 (MEDIUM): fixed 169 vB fee estimate underpaid multi-input sends

**What was broken:** `src/App.jsx` priced every send with a hardcoded `169` vB
constant, no matter how many UTXOs coin selection picked:

```js
const vbytes = 2 * 31 + 10 + 12 + 68 + Math.ceil(66 / 4); // = 169
```

A Pearl P2TR input costs ~57.25 vB (41 B base: 32 txid + 4 vout + 1 script-len +
4 sequence; 66 raw witness bytes at 1/4 segwit weight). The constant's component
sizes (31 B outputs, 68 B inputs) don't match P2TR either — correct values are
43 B outputs and 41 B inputs. So every input past the first was underpaid:
at the observed std rate (0.00517735 PRL/kB, per the repo's own comment), a
2-input send was short ~22,263 atoms, 3-input ~51,773, 4-input ~81,802.
The +1400-atom buffer didn't cover it. (Single-input 1-in/2-out sends
overpaid ~15 vB the other way — benign.)

**Repro:** pure arithmetic — `txVBytes(n,2) - 169` for n ≥ 2 at the repo's own
rate; quantified offline with node (see `test/fee.test.mjs` checks 4).

**Fix:** new exported `txVBytes(nIn, nOut)` in `src/lib/pearl.js` with sizes
documented from the `buildTx()` wire format and upstream btcd-derived
serialization; coin selection in `build()` now recomputes the fee for the
actual input count as inputs are added (assuming a change output), and collapses
dust change into the fee. Invariant holds on both paths:
actual fee ≥ feeForShape(final shape) at the user-selected rate.

**Verified:** new `test/fee.test.mjs` — 24/24 pass (hand-computed vbyte table,
input validation, wire-format cross-check of `txVBytes` vs actual `buildTx()`
serialization for 1–4 inputs / 1–3 outputs, old-estimate shortfall
quantification). `vite build` PASS; security 25/25, vault 6/6, rotation 8/8
still green. Not runnable end-to-end here (no browser / live deploy in
sandbox); fee math is pure and fully unit-tested offline.

## Bug 2 (LOW): `getBlockHeight()` returned height 1, not the tip

`src/lib/blockbook.js` fetched `/block-index/1` — blockbook's block-index
endpoint is height-addressed, so this returns the block at height 1, not the
tip. Now reads `{height, hash}` from the blockbook status endpoint. Currently
dead code (no callers); fixed so it doesn't bite whoever wires it up.

## Bug 3 (LOW): README dead link

Roadmap claimed "HTLC primitives already proven on-chain:
[pearl-htlc](https://github.com/buildandtestppg/pearl-htlc)" — that repo does
not exist (verified via GitHub API). Removed the false claim + dead link.

## Incidental

`package-lock.json` was stale (pinned v0.1.0 vs package.json 0.4.4) —
regenerated with `npm install`.

## Also checked, no bugs found

- Address validation: bech32m-only, witness v1 + 32-byte program enforced,
  mixed-case/length/hrp/charset/checksum checks correct — the
  pearlkeeper-class bug (accepting v0/base58/future versions) does NOT exist here.
- BIP-86 derivation path `m/86'/808276'/0'/0/i`, TapTweak key handling,
  BIP341 sighash midstates (single sha256, matching upstream
  `node/txscript/hashcache.go`), BIP144 witness serialization — all correct.
- Vault encryption (PBKDF2-SHA256 600k → AES-256-GCM, random salt/IV) sound.
- Vercel + Cloudflare relays: SSRF-guarded (pinned upstream host), POST size
  cap 128 KB, no key material, no logging.
- UTXO→key mapping: multi-address UTXOs are tagged with derivation index
  (`fetchWalletDataMulti`), so `keyFor(u.index)` signs with the right key.
- Endpoints all https; no plaintext blockbook requests.

---
*Found by the Pearl Blockchain 24/7 builder. If this saved you sats, consider:*
*PRL `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d` · X @kshot9000*
