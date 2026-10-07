# Upstream fix — pearl-research-labs/pearl pearl-gateway: ZKCertificate.deserialize accepted truncated / length-lying wire data

- **Date:** 2026-10-07 (Pearl builder loop, upstream bug-hunt rotation)
- **Found by:** hunter scan of `miner/pearl-gateway` (its interim status said "failed"; the final report was substantive), then independently re-verified in source at master + own RED run with a stub-bindings harness before fixing.
- **PR opened:** https://github.com/pearl-research-labs/pearl/pull/382 — deserialize length validation + construction-side public-data size validation + new test file. Attribution footer (@kshot9000 + PRL donation address) in the PR body only, never in code.
- **Branch:** `fix/gateway-zkcert-deserialize-lengths` on Kshot3000/pearl, commit da94f11a, base master @ 2f8b770c
- **Patch:** `fix-pearl-gateway-zkcert-deserialize.patch` (2 files, +197/−1)

## Bug (verified at master 2f8b770c, miner/pearl-gateway/src/pearl_gateway/blockchain_utils/zk_certificate.py)

`deserialize` never checked declared lengths against the bytes present; Python slicing silently shortens. Dense cert truncated in the proof (declares 100, carries 90) deserialized to a 90-byte proof and re-serialized to a different, shorter blob; a declared `proof_data_len=60000` with 100 present was accepted; the MoE/V3 branch had the same flaw for public_data and proof_data and no cap checks. The Go wire readers it mirrors (`node/wire/certificate_v1.go`/`certificate_v2.go`) use `io.ReadFull` and reject proofLen > MaxZKProofSize (60000) and PublicDataLen > PublicDataMaxSizeV2 (4807). Mirror flaw in `serialize`: the dense numpy fixed-size field zero-padded/truncated public_data while `get_proof_commitment()` hashed the original bytes — wire cert disagreed with its own commitment (reproduced: 100- and 200-byte public_data both round-tripped to a padded/truncated 164 bytes with a mismatched commitment).

## Verification

- Own RED (stub `pearl_mining`/`bitcoinutils` harness in /tmp, real gateway parsing code): 4 malformed cases accepted pre-fix.
- GREEN post-fix: all malformed cases raise ValueError, including hand-crafted blobs bypassing the constructor and oversized declared lengths with all bytes present (matching Go); valid v1/v2/v3 certs round-trip byte-for-byte; trailing bytes still tolerated (stream semantics).
- Environment limit, disclosed in the PR: `pearl_mining` bindings and pytest are not installable in this container, so the repo pytest suite could not be run here; the new `tests/test_zk_certificate.py` is included for CI, `py_compile` clean, ruff line-length (100) respected.
