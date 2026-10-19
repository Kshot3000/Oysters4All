/**
 * verifier-buffer.test.js — the VerifierPool line buffer is capped.
 *
 * Regression: _onData appended worker stdout to w.buf with no bound, so
 * a worker spewing without a newline grew pool memory without limit
 * (15.7 MB in 2 s from a spewing fake worker) while the request it was
 * answering stayed pending until the per-request timeout. A worker
 * crossing the cap must fail like any other worker error: pending
 * requests reject, the worker is killed and respawned.
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

const SPEW = `
const chunk = "x".repeat(65536);
setInterval(() => { process.stdout.write(chunk); }, 5);
process.stdin.resume();
`;

const ECHO = `
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let req; try { req = JSON.parse(line); } catch { return; }
  process.stdout.write(JSON.stringify({ _seq: req._seq, ok: true, digest: "ab".repeat(32) }) + "\\n");
});
`;

test("verifier pool: worker spewing without a newline is capped, killed and its request rejects", async () => {
  const v = new VerifierPool({ binary: fakeWorker(SPEW), workers: 1, timeoutMs: 30000 });
  await v.start();
  try {
    await assert.rejects(v.verify({ proof_b64: "AAAA", encoding: "plain" }), /line limit/);
    const w = v.workers[0];
    assert.ok(w.buf.length <= 1024 * 1024, `buffer stayed bounded, got ${w.buf.length}`);
    assert.equal(w.dead, true);
  } finally {
    await v.stop();
  }
});

test("verifier pool: well-behaved worker still round-trips a verify", async () => {
  const v = new VerifierPool({ binary: fakeWorker(ECHO), workers: 1, timeoutMs: 5000 });
  await v.start();
  try {
    const r = await v.verify({ proof_b64: "AAAA", encoding: "plain" });
    assert.equal(r.ok, true);
    assert.equal(r.digest, "ab".repeat(32));
  } finally {
    await v.stop();
  }
});

const NEVER = `
process.stdin.resume();
`;

test("verifier pool: pending requests per worker are capped, excess verify() rejects busy", async () => {
  const v = new VerifierPool({ binary: fakeWorker(NEVER), workers: 1, timeoutMs: 300 });
  await v.start();
  try {
    // Fire 300 verifies at a worker that never answers. On the old code all
    // 300 sat in w.pending until their timeouts; the cap must hold pending
    // at 256 and refuse the remaining 44 immediately as verifier-busy.
    const promises = [];
    for (let i = 0; i < 300; i++) promises.push(v.verify({ proof_b64: "AAAA", encoding: "plain" }));
    assert.equal(v.workers[0].pending.size, 256, `pending must be capped at 256, got ${v.workers[0].pending.size}`);
    const results = await Promise.allSettled(promises);
    const busy = results.filter((r) => r.status === "rejected" && /busy/.test(r.reason.message));
    const timedOut = results.filter((r) => r.status === "rejected" && /timeout/.test(r.reason.message));
    assert.equal(busy.length, 44, `expected 44 busy rejections, got ${busy.length}`);
    assert.equal(timedOut.length, 256, `expected 256 timeout rejections, got ${timedOut.length}`);
  } finally {
    await v.stop();
  }
});
