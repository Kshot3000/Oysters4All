import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Pool } from "../src/pool.js";
import { Payouts } from "../src/payouts.js";
import { SyntheticProvider } from "../src/templates.js";
import { targetForDiff, targetToHexBE } from "../src/util.js";

const WALLET = "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d";
const PROOF_B64 = Buffer.from("fake-proof-bytes-for-mock-verifier").toString("base64");

/** Simulates the Rust verifier's contract (accept/reject/block per test config). */
function mockVerifier(behavior = {}) {
  return {
    started: false,
    async start() { this.started = true; },
    async stop() { this.started = false; },
    async verify(req) {
      if (behavior.throw) throw new Error("boom");
      // Structural checks the real worker also performs.
      if (!/^[0-9a-f]{152}$/.test(req.header)) return { ok: false, error: "bad job header" };
      let raw;
      try { raw = Buffer.from(req.proof_b64, "base64"); }
      catch { return { ok: false, error: "base64" }; }
      if (raw.length === 0) return { ok: false, error: "empty proof" };
      if (behavior.reject) return { ok: false, error: "Invalid proof: does not meet target" };
      const digest = createHash("sha256").update(raw).digest("hex");
      return { ok: true, digest, block: !!behavior.block };
    },
  };
}

async function makePool(verifierBehavior = {}, poolOpts = {}) {
  const provider = new SyntheticProvider({ networkDiff: 1024, startHeight: 5000 });
  const verifier = mockVerifier(verifierBehavior);
  const payouts = new Payouts({ stateFile: null, windowShares: 50 });
  const pool = new Pool({
    templateProvider: provider, verifierPool: verifier, payouts,
    initialDiff: 1024, minDiff: 64, jobIntervalSec: 3600, // no timer-driven jobs in tests
    ...poolOpts,
  });
  await pool.start();
  return { pool, provider, verifier, payouts };
}

function addMiner(pool, wallet = WALLET, opts = {}) {
  const jobs = [];
  const miner = pool.addMiner({
    id: "sess-" + Math.random().toString(36).slice(2),
    wallet, worker: opts.worker || "w1", solo: !!opts.solo,
    dialect: "hero", staticDiff: opts.staticDiff || null,
    sendJob: (job) => jobs.push(job),
  });
  return { miner, jobs };
}

const submit = (proofB64 = PROOF_B64) => ({ jobId: null, field: "plain_proof", proofB64, encoding: "plain" });

test("pool issues jobs whose target matches the miner difficulty", async () => {
  const { pool } = await makePool();
  const { miner, jobs } = addMiner(pool);
  assert.equal(jobs.length, 1);
  const job = jobs[0];
  assert.match(job.jobId, /^[0-9a-f]{8}_1024$/);
  assert.equal(job.targetHex, targetToHexBE(targetForDiff(1024)));
  assert.equal(job.headerHex.length, 152);
  assert.equal(job.certVersion, 3);
  assert.equal(miner.diff, 1024);
  await pool.stop();
});

test("share pipeline: unauthorized, unknown job, bad field", async () => {
  const { pool } = await makePool();
  const { miner, jobs } = addMiner(pool);
  const s = submit(); s.jobId = jobs[0].jobId;
  assert.deepEqual(await pool.submitShare("nope", s), { ok: false, code: 24, message: "Unauthorized worker" });
  assert.match((await pool.submitShare(miner.id, { ...s, jobId: "deadbeef_1024" })).message, /Job not found/);
  assert.match((await pool.submitShare(miner.id, { ...s, field: "nope" })).message, /not supported/);
  await pool.stop();
});

test("share pipeline: verifier reject -> code 20 and invalid stats", async () => {
  const { pool } = await makePool({ reject: true });
  const { miner, jobs } = addMiner(pool);
  const s = submit(); s.jobId = jobs[0].jobId;
  const r = await pool.submitShare(miner.id, s);
  assert.equal(r.ok, false);
  assert.equal(r.code, 20);
  assert.match(r.message, /Invalid proof/);
  assert.equal(pool.stats.sharesInvalid, 1);
  assert.equal(miner.sharesInvalid, 1);
  await pool.stop();
});

test("share pipeline: verifier outage never accepts", async () => {
  const { pool } = await makePool({ throw: true });
  const { miner, jobs } = addMiner(pool);
  const s = submit(); s.jobId = jobs[0].jobId;
  const r = await pool.submitShare(miner.id, s);
  assert.equal(r.ok, false);
  assert.match(r.message, /verifier unavailable/);
  await pool.stop();
});

test("share pipeline: accept -> stats, vardiff data, PPLNS weight", async () => {
  const { pool, payouts } = await makePool();
  const { miner, jobs } = addMiner(pool);
  const s = submit(); s.jobId = jobs[0].jobId;
  const r = await pool.submitShare(miner.id, s);
  assert.deepEqual(r, { ok: true, stale: false, block: false });
  assert.equal(pool.stats.sharesValid, 1);
  assert.equal(miner.sharesValid, 1);
  assert.equal(payouts.window.length, 1);
  assert.equal(payouts.window[0].wallet, WALLET);
  await pool.stop();
});

test("share pipeline: duplicate proof digest rejected with code 22", async () => {
  const { pool } = await makePool();
  const { miner, jobs } = addMiner(pool);
  const s = submit(); s.jobId = jobs[0].jobId;
  assert.ok((await pool.submitShare(miner.id, s)).ok);
  const r2 = await pool.submitShare(miner.id, s);
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 22);
  assert.equal(pool.stats.sharesDuplicate, 1);
  await pool.stop();
});

test("share pipeline: stale job accepted but flagged and excluded from PPLNS", async () => {
  const { pool, payouts } = await makePool();
  const { miner, jobs } = addMiner(pool);
  const oldJob = jobs[0];
  pool._issueJobs("test"); // rotate jobs
  const s = submit(); s.jobId = oldJob.jobId;
  const r = await pool.submitShare(miner.id, s);
  assert.equal(r.ok, true);
  assert.equal(r.stale, true);
  assert.equal(pool.stats.sharesStale, 1);
  assert.equal(payouts.window.length, 0, "stale shares earn no PPLNS weight");
  await pool.stop();
});

test("share pipeline: block candidate archived and round credited", async () => {
  const { pool, payouts } = await makePool({ block: true });
  const { miner, jobs } = addMiner(pool);
  const s = submit(); s.jobId = jobs[0].jobId;
  const r = await pool.submitShare(miner.id, s);
  assert.equal(r.block, true);
  assert.equal(pool.stats.blocksFound, 1);
  assert.equal(pool.blockCandidates.length, 1);
  const c = pool.blockCandidates[0];
  assert.equal(c.finder, WALLET);
  assert.equal(c.submittable, false);
  assert.ok(c.headerHex.length === 152);
  assert.equal(payouts.blocksFound, 1);
  assert.equal(payouts.rounds.length, 1);
  await pool.stop();
});

test("vardiff raises difficulty for fast miners via a fresh job", async () => {
  const { pool } = await makePool({}, { vardiffTargetSec: 15, vardiffWindow: 4 });
  const jobs = [];
  const miner = pool.addMiner({
    id: "fast", wallet: WALLET, worker: "w", solo: false, dialect: "hero",
    staticDiff: null, sendJob: (j) => jobs.push(j),
  });
  const job = jobs[0];
  // Submit shares back-to-back (way faster than the 15 s target).
  for (let i = 0; i < 4; i++) {
    const s = submit(Buffer.from("proof-" + i + "-" + miner.diff).toString("base64"));
    s.jobId = pool.jobsByDiff.get(miner.diff).jobId;
    const r = await pool.submitShare(miner.id, s);
    assert.ok(r.ok);
  }
  assert.ok(miner.diff > 1024, `vardiff should raise diff, got ${miner.diff}`);
  assert.ok(jobs.length >= 2, "miner must receive a fresh job at the new difficulty");
  assert.equal(jobs[jobs.length - 1].diff, miner.diff);
  await pool.stop();
});

test("vardiff disabled for static-difficulty miners", async () => {
  const { pool } = await makePool({}, { vardiffWindow: 4 });
  const jobs = [];
  const miner = pool.addMiner({
    id: "static", wallet: WALLET, worker: "w", solo: false, dialect: "hero",
    staticDiff: 2048, sendJob: (j) => jobs.push(j),
  });
  for (let i = 0; i < 6; i++) {
    const s = submit(Buffer.from("sproof-" + i).toString("base64"));
    s.jobId = pool.jobsByDiff.get(miner.diff).jobId;
    await pool.submitShare(miner.id, s);
  }
  assert.equal(miner.diff, 2048);
  await pool.stop();
});
