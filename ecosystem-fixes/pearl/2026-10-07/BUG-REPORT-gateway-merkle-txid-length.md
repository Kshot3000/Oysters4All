# Upstream fix — PR #407: gateway merkle root silently accepts non-32-byte txids (Pearl run ~04:13 CDT, 2026-10-08, late addendum)

Source: the Python hunter's FINAL report, delivered after this run's
first report. (Its earlier interim delivery was garbled/invented and
was discarded at the time — the final was a different, line-anchored
document; see the interim-vs-final rule in lessons-2026-10-07.)

`calculate_merkle_root` (miner/pearl-gateway blockchain_utils.py:25)
fed GBT txids — `BlockTemplateTx.txid` is an unconstrained str — into
pair hashing with no length check. Own RED (verbatim extraction):
1-byte, empty, 31-byte, and 33-byte txids all accepted alongside a
valid one, each producing a plausible 32-byte root (1-byte case:
ce764b10…, matching the hunter's number); a single short txid was
returned reversed and un-hashed as the root. The wrong root passes
the Rust header constructor's 32-byte check, so the gateway would
mine on a bad root with no error.

Fix: validate each decoded txid is exactly 32 bytes in
calculate_merkle_root, raise ValueError. Five regression tests in
test_transaction_merkle_tree.py. Verified GREEN via the real module
with bitcoinutils stubbed (not installed here) + known-answer checks
for valid inputs unchanged. Branch fix/gateway-merkle-txid-length,
commit 72cf5590, patch in fix-pearl-gateway-merkle-txid-length.patch.

The final's two LOW items were not bundled (stated in the PR body):
MiningJob.from_dict any-length incomplete_header_bytes (fail-closed
downstream) and PearlHeader.deserialize trailing bytes (no caller).
The Go hunter's final, by contrast, failed the gate on its first
claim (all quoted symbols absent from the tree) and stayed discarded.
