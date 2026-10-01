# Pearl Pact — Discreet Log Contract desk for PRL

Two parties lock PRL in a 2-of-2 Taproot funding output; an oracle's attestation
decides how it pays out. One page, five steps: **Draft → Fund → Seal → Execute → Refund**.

## How it works (the DLC idea in one paragraph)

Alice and Bob each lock collateral in a joint Taproot output. Before funding, they
build one Contract Execution Transaction (CET) per possible outcome and pre-sign
them — but each signature is **adaptor-encrypted** to that outcome's oracle
announcement point, so it's worthless until the oracle reveals the outcome
secret. When the oracle attests outcome *i*, the secret decrypts both signatures
and the winning CET becomes spendable. The oracle cannot steal (it holds no
spending key); it can only pick the winner. A timelocked refund leg returns
collateral if the oracle never attests.

## The crypto

- **Schnorr adaptor signatures** (`adaptorEncrypt` / `adaptorVerify` / `adaptorDecrypt`):
  `s* = s − t` where `T = t·G` is the outcome's announcement point; encryption is
  verifiable, decryption needs the revealed secret, and the result re-verifies as
  a plain BIP-340 signature. x-only/BIP-340 parity convention: encryption uses the
  even-Y `lift_x` point, so the page normalizes the revealed secret's parity
  before decrypting.
- **Deterministic oracle secrets**: `t_o = H("PearlPactOutcomeSecret/v1" ‖ x ‖ eventId ‖ o)` —
  the demo oracle derives attestations this way; real oracles bring their own keys
  and just publish x-only announcement points.
- **Funding script**: `2-of-2 CHECKSIGADD` under a **NUMS internal key**
  (`H("PearlPactNUMS/v1" ‖ script)`) — the keypath is cryptographically
  unspendable, so keypath-only witnesses are rejected by policy.
- **Tamper-evident descriptors**: `pearl-pact:v1:<hrp>:<sha256(canonical terms)>`.
- Reuses the audited Taproot/sighash machinery from `pages/sign/src/crypto.js` and
  `pages/vault/src/vault-core.js`; adaptor glue is new and test-pinned.

## Scripts

- `node build.mjs` — bundle `src/` → `pearl-pact.bundle.js`
- `node tests/pact.test.mjs` — 10 core tests (adaptor round-trip, attestation,
  funding planner fee math, full sealing ceremony, execution, refund)
- `node tests/dom.test.mjs` — bundle surface + HTML wiring checks
- `node ../../hidden_files/qa-pact-browser.mjs` — 32 headless-Chromium checks

## Honest limits

- Trust the oracle, not the math, for the outcome.
- The page never broadcasts on its own; every broadcast double-confirms.
- CETs are worthless until the funding output confirms.
- The refund is only valid after its `nLockTime`.
- Keys live in page memory only; wipe them when done.

Built by [@kshot9000](https://x.com/kshot9000) for the Pearl ecosystem.
PRL donations: `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`
