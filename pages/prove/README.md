# Pearl Prove — Cryptographic Proof Desk for Pearl (PRL)

Live: https://kshot3000.github.io/Oysters4All/pages/prove/

Three tools, all 100% client-side:

1. **Inclusion proof** — prove a transaction is committed inside a Pearl block's
   merkle tree. Either fetch a block from a blockbook endpoint (height or hash)
   and let the page build + verify the path, or paste a proof (`L`/`R` + sibling
   hash per line, leaf up) and check it against the header's merkle root.
2. **Root builder** — paste an ordered txid list, compute the merkle root a block
   header must commit to, optionally emit the inclusion path for one txid.
3. **Header inspector** — paste an 80-byte raw header hex (from
   `prlctl getblockheader --verbose=false`), decode every field, recompute the
   block id (double-SHA256), and check proof-of-work against the nBits target.

## Crypto lineage

- Tree construction is Bitcoin-style: `dsha(left ‖ right)`, odd lone node
  duplicated. Verified against upstream `node/blockchain/merkle.go`
  (`HashMerkleBranches`, `BuildMerkleTreeStore`, master @ 3fe2267).
- Empirically confirmed: recomputing the root from all 40 txids of Pearl
  **mainnet block 120195** reproduces the chain's `merkleRoot` byte-for-byte
  (see `tests/fixture-120195.json`, fetched from blockbook.pearlresearch.ai).
- SHA-256 is vendored in `js/prove-core.js` (pure JS, no dependencies); the test
  suite cross-checks it against `node:crypto` on random inputs.
- Txids are display (big-endian) hex; hashing flips to internal byte order —
  the same convention as Bitcoin.

## Honest boundaries

- A valid inclusion proof shows a transaction is committed by a block header.
  It does **not** prove the header is on your chain — fetch headers from a
  blockbook or `pearld` node **you** trust, and confirm depth against your own tip.
- The fetch mode refuses blocks with > 5,000 transactions (browser would crawl)
  and shows explicit errors for unreachable endpoints / unknown blocks — no fake
  "verified" states.

## Tests

```sh
node --test tests/prove.test.cjs
```

15/15 green: SHA-256 FIPS vectors + node:crypto cross-check, strict input
validation, merkle vectors (1/2/odd/5-leaf with tamper cases), the real
block-120195 fixture (root recompute + mid-list proof + outsider rejection),
header decode round-trip, nBits target pass/fail, proof/txid-list parsers.

---

Built by [@kshot9000](https://x.com/kshot9000) ·
[Oysters4All](https://github.com/Kshot3000/Oysters4All)

Support the build — tip PRL: `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`
