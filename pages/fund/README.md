# Pearl Fund — Refundable PRL Crowdfunding

Built by [@kshot9000](https://x.com/kshot9000) for the Pearl ecosystem. Donations: `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`

Refundable crowdfunding for PRL on pure Taproot script — Pearl has no smart
contracts. A campaign gives every backer their own per-backer Taproot pledge
address. Funds release only when the recipient and the creator co-sign, and
every backer keeps a unilateral refund after the deadline. All crypto runs
locally in your browser.

Open `index.html` directly (`file://`) or serve the directory; it also works
as-is on GitHub Pages.

## How it works

Five steps: **Launch → Pledge → Track → Release → Refund**.

Each pledge address is a 2-leaf taptree under a NUMS (nothing-up-my-sleeve)
internal key — no keypath backdoor, so coins move only through the leaves:

- **Release leaf** — `<recipient_xonly> OP_CHECKSIGVERIFY <creator_xonly>
  OP_CHECKSIG`: recipient + campaign creator co-sign to release the pledge.
- **Refund leaf** — `<deadline_height> OP_CHECKLOCKTIMEVERIFY OP_DROP
  <backer_xonly> OP_CHECKSIG`: the backer alone reclaims their pledge once
  the chain reaches the deadline height.

The NUMS key is `lift_x(SHA-256("PearlFundNUMS/v1" ‖ recipient ‖ creator ‖
goal_grains ‖ deadline ‖ backer))` — deterministic and recomputable from the
pledge descriptor. Descriptors are tamper-evident and round-trip byte-exact:

- campaign: `pearlfund:v1:<hrp>:<recipient_addr>:<creator_xonly_hex>:<goal_grains>:<deadline_height>`
- pledge: the campaign descriptor + `:<backer_xonly_hex>`

Crypto lineage: key derivation, TapTweak, bech32m, BIP-341 sighash and wire
serialization come from the audited Pearl Sign core (`pages/sign/src/crypto.js`);
no new cryptography.

## Honest limits

- **"Goal met" is a social rule, not a cryptographic one.** The release leaf
  is spendable the moment recipient + creator both sign — even before the
  goal is reached. The page's UI enforces the goal; the script cannot.
- **The creator can refuse after the goal is met.** Release needs the
  creator's signature too. If they withhold it, funds stay locked until the
  deadline — then every backer can refund unilaterally.
- **Refunds are unstoppable after the deadline.** Any backer can take their
  pledge back alone with their own key; nobody can block or veto a refund.
- **Descriptors have no checksum.** A single flipped character can silently
  describe a different campaign — always pair a descriptor with its 64-bit
  fingerprint (shown on every card); the verifier refuses loudly on mismatch.
- **Needs live Blockbook + real funds for the real thing.** Funding scans,
  chain height, fee estimates and broadcast go through the Blockbook endpoint
  you configure. No real campaigns were funded in testing.
- **Secrets stay in this page.** Keys are kept in page memory only and wiped
  with the lock button. Verify every address and amount out of band before
  funding.

## Tests

- `tests/fund.test.mjs` — 34/34: campaign/pledge descriptor round-trips +
  tamper refusal, NUMS + leaf construction, release/refund signing flows,
  deadline gating, funding classification.

Run: `node --no-warnings --loader ./tests/loader.mjs --test tests/fund.test.mjs`
Build the bundle: `node build.mjs` (committed as `pearl-fund.bundle.js`).
