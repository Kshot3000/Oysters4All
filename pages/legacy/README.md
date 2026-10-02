# Pearl Legacy — PRL Inheritance Vault (Dead-Man's Switch)

Live: https://kshot3000.github.io/Pearl-Muse-24-7-Ai-builder/pages/legacy/

Pearl has no smart contracts, so an inheritance vault can't be enforced by
on-chain code. Pearl Legacy enforces it with pure Bitcoin-style Taproot
script instead: a two-leaf taptree where the **owner can always spend** via
a heartbeat leaf, and the **heir can spend only after n blocks of inactivity**
via a timelocked CSV leaf. No oracle, no custodian, no multisig ceremony —
just script, and a page that builds every transaction locally.

## The contract

Two Taproot script leaves under a NUMS (nothing-up-my-sleeve) internal key,
so keypath spending is impossible — coins move only through the scripts:

**Leaf A — owner heartbeat** (always spendable by the owner):
```
<owner_xonly> OP_CHECKSIG
```

**Leaf B — heir claim** (spendable by the heir only after `n` blocks since
the spent UTXO's funding height):
```
<n> OP_CHECKSEQUENCEVERIFY OP_DROP <heir_xonly> OP_CHECKSIG
```

Exact example (owner priv `11…11`, heir priv `22…22`, n = 445, mainnet):

- Descriptor: `legacy:v1:prl:4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa:466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27:445`
- Vault address: `prl1p7fnyrvqn9wptzsz4gz2esfhzt83r0v4ynqgtry422zzlz40w8n3qmqh4dg`
- Leaf A: `204f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aaac`
- Leaf B: `02bd01b27520466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27ac`
- scriptPubKey: `5120f26641b0132b82b1405540959826e259e237b2a49810b192aa5085f155ee3ce2`

## The five steps: Plan → Vault → Watch → Claim/Refresh → Verify

1. **Plan.** Owner key (mnemonic, WIF, or hex private key — auto-detected) or
   watch-only x-only pubkey; heir as x-only pubkey or `prl1p…` address;
   inactivity `n` in blocks (1–65535, see below). The page forges the vault,
   shows the address + QR, the descriptor, and a JSON spec. Private keys are
   wiped from the form the moment the plan is forged.
2. **Vault.** Load the JSON spec; the page re-derives the entire contract
   from the keys + n and byte-compares every field — a tampered spec is
   refused loudly. Shows the address, descriptor, leaf scripts, and what
   each key can do.
3. **Watch.** GET-only Blockbook watching (tip, address UTXOs, per-UTXO
   transaction detail). Every returned UTXO's funding transaction is fetched
   and its output script is byte-compared against the vault scriptPubKey —
   **foreign-script UTXOs are flagged and excluded**, never trusted. Shows
   confirmed balance, the oldest UTXO's age, per-UTXO maturity state, and a
   countdown to heir-claim eligibility. Manual height entry for air-gapped
   use. This is read-only: nothing is signed or broadcast here.
4. **Claim / Refresh.**
   - *Heir claim:* single UTXO, heir key, destination address, fee rate.
     Guards: per-UTXO maturity (`currentHeight − fundingHeight ≥ n`;
     one block early = loud refusal naming the exact blocks-to-go),
     the signing key must match the heir key in the spec, destination must
     be a valid Pearl address, output above dust. nSequence is exactly `n`,
     locktime 0, witness `[sig, heirScript, controlBlock]`. The signature
     is re-verified against the heir key before the hex is shown.
   - *Owner refresh (heartbeat):* spends **every** vault UTXO via the
     heartbeat leaf and forges a single fresh UTXO at the **same vault
     address**. Multi-input, each input signed against its own BIP-341
     script-path digest and re-verified. See "The heartbeat" below.
   - *Broadcast:* the page never broadcasts on its own. Broadcast requires
     two explicit confirmations, then the page asks you to paste back the
     txid from the Blockbook response as proof it landed.
5. **Verify (standalone).** Paste a descriptor **and** the address it claims
   to describe. The page recomputes the contract and refuses loudly on any
   mismatch. No keys needed. See "Descriptor honesty" below.

## The heartbeat (same address, fresh UTXO)

Identical network, owner key, heir key, and `n` **deterministically produce
the same vault address** — there is no epoch, no salt, no randomness in the
derivation. The owner's heartbeat refresh spends all vault UTXOs and pays
the total (minus the exact fee) back to that same address as one fresh UTXO.
What resets the inactivity clock is the fresh coin's fresh funding height:
heir maturity is measured *per UTXO* from its own funding height, so the
heir's `n`-block window restarts at the refresh's confirmation height. A
different vault address requires changing a committed parameter or key —
there is no in-protocol way to "rotate" the address while keeping the same
contract.

## Limits the chain sets (not the page)

- **194-second block time is an estimate.** Pearl's target block time is
  194 s (`pearl-knowledge.md`, `node/chaincfg/params.go TargetTimePerBlock`);
  the chain enforces *blocks*, never time. Every day-count on the page is
  labeled as an estimate derived from that constant.
- **n is capped at 65535 blocks** (~147 days at 194 s/block). BIP-68
  sequences are 16 bits wide — a longer single inactivity window is
  impossible in one CSV leaf. Larger n is refused with an explanation, never
  silently truncated. For longer horizons, refresh (heartbeat) before the
  window lapses.
- **Inactivity is per UTXO.** The heir's clock for each coin starts at that
  coin's funding height. A vault with UTXOs of different ages matures them
  independently; the watch tab shows each one.

## Descriptor honesty

The descriptor `legacy:v1:<hrp>:<ownerXOnlyHex>:<heirXOnlyHex>:<n>` is
compact and recomputable, but it is **not signed or authenticated**. Editing
`n` (or either key) yields a different-but-valid descriptor for a different
vault — no parser can call it malformed. The honest check is therefore
always two-sided: the verifier recomputes the address from the descriptor
and requires it to **equal the claimed address supplied separately**,
refusing loudly otherwise. Share the descriptor with the heir alongside the
address it was published with, from a channel you trust. The JSON spec, by
contrast, is self-checking: loading re-derives every field from the spec's
own keys + n and byte-compares, so a modified spec cannot pass as the
original.

## Risks, stated plainly

- **Broadcast risk.** A signed transaction is final once broadcast. The page
  shows the full hex, the txid, and the exact fee before you confirm, and
  nothing is broadcast without your two explicit confirmations — but review
  the destination address yourself; the page cannot recall a broadcast.
- **Owner key loss.** If the owner loses the heartbeat key, they can no
  longer refresh. After `n` blocks of inactivity the heir can claim — that
  is the dead-man's switch working as designed, not a bug.
- **Heir key loss.** If the heir loses their key, nobody can ever claim via
  leaf B. The owner can still move funds via the heartbeat leaf at any time,
  so coins are recoverable by the owner — but the inheritance path is gone.
- **Both keys lost.** The coins are unspendable forever: the internal key is
  NUMS-derived (nobody knows it), so there is no keypath backdoor.
- **No real vault has been funded through this page.** All vectors and QA
  flows are synthetic. Before funding real PRL, verify the contract on
  testnet and have the heir independently re-derive the address from the
  descriptor.

## Crypto lineage

All cryptography is the audited Pearl Sign core (`../sign/src/crypto.js`):
SHA-256, bech32m, Schnorr, BIP-341 sighash, wire serialization, and the
segwit transaction parser. Multi-input signing reuses the proven
multi-input BIP-341 pattern from `../stream/src/stream-core.js` — each input
signed against its own script-path digest over the shared prevout/output
commitments. No new cryptography was introduced — only the two-leaf
covenant-style contract on top of it.

## Tests

```sh
node --no-warnings --loader ./tests/loader.mjs --test tests/legacy.test.mjs   # 18/18
node --no-warnings --loader ./tests/loader.mjs --test tests/dom.test.mjs       # 6/6
node ../../../../hidden_files/qa-legacy-browser.mjs                            # real-browser QA (hidden_files, not committed) — 47/47 checks green (2026-10-02)
```

Core tests cover: exact leaf byte vectors, NUMS internal-key properties,
taptree control-block re-derivation and tamper failure, address
determinism (same params → same address; any param change → different
address), descriptor round-trip and tamper-vs-claimed-address refusal,
spec re-derivation, heir-claim maturity/key/dust guards, owner-refresh
same-address heartbeat with exact fee math, per-input signature
re-verification, foreign-spk refusal, and the vault UTXO classifier.
DOM tests drive the real page (bundle + app.js) in a VM: plan → vault →
watch (stubbed Blockbook, impostor UTXO excluded) → claim (immature
refused, mature built) → refresh (same address, all inputs spent) →
verifier (good/tampered/malformed) → footer attribution.

---

Built by [@kshot9000](https://x.com/kshot9000) · tips: `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`
