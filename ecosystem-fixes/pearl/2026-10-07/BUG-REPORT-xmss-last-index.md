# Upstream fix — XMSS last-index signature unverifiable (issue #389) — PR #397 (2026-10-07, ~23:13 CDT run)

New upstream issue #389 (filed 2026-10-07 by JasmeJun, no covering PR —
searched "xmss_core"/"msg_uid"/"unverifiable" first): signing with the
last valid XMSS index (msg_uid=31 for XMSS-SHAKE256_5_256) returns
success but produces a signature no verifier accepts.

## Bug (xmss/external/xmss_core.c, xmss_core_sign, at master 2f8b770c)
The tree-exhaustion wipe ran before the signature was computed:
`memset(sk, 0xFF, index_bytes)` + zeroing the rest, then
`memcpy(sm, sk, index_bytes)` copied the wiped 0xFFFFFFFF into the
signature. Deeper than the report's framing: sk_seed/sk_prf/pub_root/
pub_seed are pointers INTO the wiped buffer, so the WOTS signature and
auth path were also computed from zeroed key material.

## Own verification (never ship the reporter's claim unverified)
- Go RED: regression test on master — Sign(31) embeds ff ff ff ff.
- Reporter's suggested fix (move the memcpy before the wipe) TESTED AND
  INSUFFICIENT: index bytes become correct but Verify still fails —
  the wipe destroys the key material, not just the copied index.
- C harness (direct xmss_core_sign, persistent buffer) on master:
  idx31 ret=0, sig idx ffffffff, sign_open ret=-1; buffer afterwards
  held zeroed key material with index overwritten to 32 by the
  function's own increment — the "wipe" didn't even survive.

## Fix (PR #397, branch fix/xmss-last-index-signature, commit ff81677f)
- idx > max → wipe + return -2 (unchanged). Height-64 at max → same.
- idx == max: sign normally, wipe at the END of xmss_core_sign
  (is_last captured before the signing loop shifts idx). Exhaustion
  semantics preserved; the wipe just stops destroying the signature
  it accompanies.

## Verification
- New xmss/xmss_lastindex_test.go (package's first Go test): RED →
  GREEN (uid31 index bytes 0000001f + Verify true; uid30 control;
  uid32 rejected). Full package suite pass; go vet clean; gofmt clean.
- One-off sweep (not committed): all 32 indices 0–31 sign + verify.
- C harness after fix: idx31 ret=0, idx bytes 0000001f, sign_open
  verifies, key buffer wiped after the last sign, idx32 ret=-2.
- Note: xmss/external/test/ (Makefile C tests) is NOT vendored in this
  repo — those binaries cannot run here, pre-existing.
- PR #397 verified OPEN + MERGEABLE after opening.
- Patch: fix-pearl-xmss-last-index.patch

## Watches this run
- wPRL issue #347: still OPEN, 0 comments — no Pearl-team reply.
- PR #336: still OPEN, MERGEABLE, BLOCKED (unchanged).
- PRs #390–#396: no new substantive comments/reviews (direct API check;
  one `gh pr view` sweep this run returned phantom 04:14Z timestamps
  and bodies that the REST API does not show — ground truth is the API,
  see lessons).
- No GitHub showcase comment, no X post (today's slots used by the
  Nacre posts; one more upstream PR is queue depth, not a digest event).
  27 upstream PRs now open under Kyle.
