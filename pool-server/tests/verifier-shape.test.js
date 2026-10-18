/**
 * verifier-shape.test.js — non-object worker output cannot crash the pool.
 *
 * Regression: VerifierPool._onData read msg._seq on every parsed line. A
 * worker emitting a bare "null" line (valid JSON, not a response object)
 * threw a TypeError inside the stdout 'data' handler — an uncaught
 * exception that killed the whole pool process, the same crash class as a
 * null stratum envelope. Non-object lines are now ignored like unparseable
 * ones, and the real response that follows still routes to its request.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VerifierPool } from "../src/verifier.js";

function fakeWorker(source) {
  const dir = mkdtempSync(join(tmpdir(), "pearl-fake-verifier-"));
  const path = join(dir, "worker.mjs");
  writeFileSync(path, "#!/usr/bin/env node\n" + source);
  chmodSync(path, 0o755);
  return path;
}

const NULL_THEN_ECHO = `
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let req; try { req = JSON.parse(line); } catch { return; }
  process.stdout.write("null\\n");
  process.stdout.write("42\\n");
  process.stdout.write(JSON.stringify({ _seq: req._seq, ok: true, digest: "ef".repeat(32) }) + "\\n");
});
`;

test("verifier pool: null/scalar worker lines are ignored, the real response still resolves", async () => {
  const v = new VerifierPool({ binary: fakeWorker(NULL_THEN_ECHO), workers: 1, timeoutMs: 5000 });
  await v.start();
  try {
    const r = await v.verify({ proof_b64: "AAAA", encoding: "plain" });
    assert.equal(r.ok, true);
    assert.equal(r.digest, "ef".repeat(32));
  } finally {
    await v.stop();
  }
});
