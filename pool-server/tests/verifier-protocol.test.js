import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { VerifierPool } from "../src/verifier.js";
import { buildHeaderBytes } from "../src/templates.js";
import { targetToCompact, targetForDiff } from "../src/util.js";

const BINARY = new URL("../verifier/target/release/pearl-pool-verifier", import.meta.url).pathname;
const HAS_BINARY = existsSync(BINARY);

// A structurally valid 76-byte header (nbits = share target for diff 1024).
function headerHex() {
  return buildHeaderBytes({
    version: 0x20000000,
    prevHex: "11".repeat(32),
    merkleHex: "22".repeat(32),
    timestamp: 1759000000,
    nbits: targetToCompact(targetForDiff(1024)),
  }).toString("hex");
}
const b64 = (buf) => Buffer.from(buf).toString("base64");
const req = (over = {}) => ({
  header: headerHex(),
  proof_b64: b64(Buffer.from("definitely-not-a-real-plainproof", "utf8")),
  encoding: "plain",
  nbits: targetToCompact(targetForDiff(1024)),
  cert_version: 3,
  ...over,
});

test("verifier: garbage proof is rejected as Invalid (negative vector)", { skip: !HAS_BINARY }, async () => {
  const v = new VerifierPool({ binary: BINARY, workers: 1 });
  await v.start();
  try {
    const r = await v.verify(req());
    assert.equal(r.ok, false);
    assert.match(r.error, /Invalid proof|deserialize/);
  } finally { await v.stop(); }
});

test("verifier: malformed requests fail cleanly, worker stays alive", { skip: !HAS_BINARY }, async () => {
  const v = new VerifierPool({ binary: BINARY, workers: 1 });
  await v.start();
  try {
    // Bad header hex.
    let r = await v.verify(req({ header: "zz" }));
    assert.equal(r.ok, false);
    assert.match(r.error, /header/);
    // Short header.
    r = await v.verify(req({ header: "00".repeat(70) }));
    assert.equal(r.ok, false);
    // Bad base64.
    r = await v.verify(req({ proof_b64: "!!!not-base64!!!" }));
    assert.equal(r.ok, false);
    // Unknown encoding.
    r = await v.verify(req({ encoding: "rot13" }));
    assert.equal(r.ok, false);
    assert.match(r.error, /unknown proof encoding/);
    // Unknown cert_version: with a garbage proof the worker fails closed at
    // deserialization first (ordering: header -> decode -> deserialize ->
    // cert_version -> verify), so no unknown version can ever reach verify.
    r = await v.verify(req({ cert_version: 99 }));
    assert.equal(r.ok, false);
    // Worker still serving after all that.
    r = await v.verify(req());
    assert.equal(r.ok, false);
    assert.match(r.error, /Invalid proof|deserialize/);
  } finally { await v.stop(); }
});

test("verifier: compressed bytes in plain_proof are rejected (sniff guard)", { skip: !HAS_BINARY }, async () => {
  const v = new VerifierPool({ binary: BINARY, workers: 1 });
  await v.start();
  try {
    const gz = gzipSync(Buffer.from("x".repeat(100)));
    assert.deepEqual([...gz.slice(0, 2)], [0x1f, 0x8b]); // gzip magic, sanity
    // Sent as "plain" -> must be rejected by the sniff guard.
    let r = await v.verify(req({ proof_b64: b64(gz), encoding: "plain" }));
    assert.equal(r.ok, false);
    assert.match(r.error, /compressed data in plain_proof/);
    // Sent as "gzip" -> decompresses, then fails at deserialization (not real proof).
    r = await v.verify(req({ proof_b64: b64(gz), encoding: "gzip" }));
    assert.equal(r.ok, false);
    assert.match(r.error, /deserialize|Invalid proof/);
  } finally { await v.stop(); }
});

test("verifier: oversized proof refused before inflation", { skip: !HAS_BINARY }, async () => {
  const v = new VerifierPool({ binary: BINARY, workers: 1 });
  await v.start();
  try {
    // base64 whose decoded length would exceed 16 MiB.
    const big = "A".repeat((17 * 1024 * 1024 / 3 * 4) | 0);
    const r = await v.verify(req({ proof_b64: big }));
    assert.equal(r.ok, false);
    assert.match(r.error, /exceed/);
  } finally { await v.stop(); }
});

test("verifier pool: round-robins workers and respawns dead ones", { skip: !HAS_BINARY }, async () => {
  const v = new VerifierPool({ binary: BINARY, workers: 2, timeoutMs: 5000 });
  await v.start();
  try {
    const rs = await Promise.all([v.verify(req()), v.verify(req()), v.verify(req()), v.verify(req())]);
    assert.ok(rs.every((r) => r.ok === false && /Invalid proof|deserialize/.test(r.error)));
    // Kill a worker; the pool must respawn and keep serving.
    v.workers[0].child.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 1500));
    const r = await v.verify(req());
    assert.equal(r.ok, false);
    assert.match(r.error, /Invalid proof|deserialize/);
  } finally { await v.stop(); }
});

test("verifier pool: missing binary fails closed at start", async () => {
  const v = new VerifierPool({ binary: "/nonexistent/pearl-pool-verifier", workers: 1 });
  await v.start();
  await new Promise((r) => setTimeout(r, 500));
  await assert.rejects(v.verify(req()), /verifier|ENOENT|exited|timeout|destroyed/i);
  await v.stop();
});
