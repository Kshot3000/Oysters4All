/**
 * pool.js — the mining pool core: job board, vardiff, share pipeline, stats.
 *
 * Dialect-agnostic: stratum.js owns sockets and normalizes miner messages into
 * the calls below. Share validation itself runs in the Rust verifier subprocess
 * (verifier.js) — the same verify_plain_proof path the reference pools use.
 *
 * Vardiff model (matches observed pool behavior): difficulty rides on the job —
 * each job carries its own target and job_id (`<8hex>_<diff>`), and miners get a
 * fresh job when their difficulty changes. The captured Pearl clients do not
 * implement mining.set_difficulty, so we retarget via jobs (LuckyPool-style).
 */
import { targetForDiff, targetToCompact, targetToHexBE, nowSec } from "./util.js";

const DEFAULTS = {
  initialDiff: 2097152,   // HeroMiners/LuckyPool starting share difficulty
  minDiff: 1024,          // floor (CPU test ports go ~26000; allow lower for tests)
  maxDiff: 2 ** 40,
  vardiffTargetSec: 15,   // aim for one share per ~15 s per miner
  vardiffWindow: 8,       // shares per retarget evaluation
  jobIntervalSec: 25,     // fresh job cadence (observed pools: ~21-35 s)
  jobHistory: 64,         // late-submit window
  certVersion: 3,         // advertised cert_version (post salted-seed fork)
};

export class Pool {
  constructor(opts = {}) {
    this.cfg = { ...DEFAULTS, ...opts };
    this.templates = opts.templateProvider;   // TemplateProvider
    this.verifier = opts.verifierPool;         // VerifierPool
    this.payouts = opts.payouts;               // Payouts (PPLNS)
    this.networkId = opts.networkId || "mainnet";

    this.miners = new Map();        // sessionId -> miner record
    this.jobsByDiff = new Map();    // diff -> current job
    this.jobHistory = new Map();    // jobId -> job (bounded)
    this.jobCounter = 0;
    this.seenDigests = new Set();   // dup-share detection (bounded below)
    this.blockCandidates = [];      // archived block-winning shares

    this.stats = {
      startedAt: Date.now(),
      connections: 0,
      sharesValid: 0,
      sharesInvalid: 0,
      sharesStale: 0,
      sharesDuplicate: 0,
      blocksFound: 0,
      templateSource: null,
      height: null,
    };
    this._jobTimer = null;
    this._onBlock = opts.onBlock || null;
  }

  async start() {
    await this.verifier.start();
    await this._refreshTemplate(true);
    this._jobTimer = setInterval(() => this._tickJobs().catch(() => {}), 5000);
  }

  async stop() {
    clearInterval(this._jobTimer);
    await this.verifier.stop();
  }

  /* ---------------- template / jobs ---------------- */

  async _refreshTemplate(force = false) {
    const tpl = await this.templates.getTemplate(force);
    const changed = tpl.templateId !== this._templateId;
    this._templateId = tpl.templateId;
    this._template = tpl;
    this.stats.templateSource = tpl.source;
    this.stats.height = tpl.height;
    if (changed) this._issueJobs("template");
    return changed;
  }

  async _tickJobs() {
    const changed = await this._refreshTemplate(false).catch(() => false);
    if (changed) return; // _refreshTemplate already issued jobs
    const now = nowSec();
    if (!this._lastJobAt || now - this._lastJobAt >= this.cfg.jobIntervalSec) {
      this._issueJobs("interval");
    }
  }

  _activeDiffs() {
    const diffs = new Set();
    for (const m of this.miners.values()) if (m.authorized) diffs.add(m.diff);
    if (diffs.size === 0) diffs.add(this.cfg.initialDiff);
    return [...diffs];
  }

  _issueJobs(reason) {
    const tpl = this._template;
    if (!tpl) return;
    const ts = nowSec();
    const headerBuf = Buffer.from(tpl.headerHex, "hex");
    headerBuf.writeUInt32LE(ts >>> 0, 68); // bump job timestamp
    const headerHex = headerBuf.toString("hex");
    for (const diff of this._activeDiffs()) {
      const jobId = `${(this.jobCounter++ >>> 0).toString(16).padStart(8, "0")}_${diff}`;
      const target = targetForDiff(diff);
      const job = {
        jobId, headerHex, target,
        targetHex: targetToHexBE(target),
        nbits: targetToCompact(target),
        height: tpl.height,
        certVersion: tpl.certVersion ?? this.cfg.certVersion,
        diff,
        templateId: tpl.templateId,
        networkTarget: tpl.networkTarget,
        createdAt: ts,
        reason,
      };
      this.jobsByDiff.set(diff, job);
      this.jobHistory.set(jobId, job);
      while (this.jobHistory.size > this.cfg.jobHistory) {
        const oldest = this.jobHistory.keys().next().value;
        this.jobHistory.delete(oldest);
      }
      // Push to miners on this difficulty.
      for (const m of this.miners.values()) {
        if (m.authorized && m.diff === diff && m.sendJob) m.sendJob(job);
      }
    }
    this._lastJobAt = ts;
  }

  /** Current job for a miner's difficulty (issues one if missing). */
  jobFor(miner) {
    let job = this.jobsByDiff.get(miner.diff);
    if (!job || job.templateId !== this._templateId) {
      this._issueJobs("demand");
      job = this.jobsByDiff.get(miner.diff);
    }
    return job;
  }

  /* ---------------- miners ---------------- */

  addMiner(session) {
    const miner = {
      id: session.id,
      wallet: session.wallet,
      worker: session.worker || "",
      solo: !!session.solo,
      dialect: session.dialect,
      diff: session.staticDiff || this.cfg.initialDiff,
      staticDiff: !!session.staticDiff,
      authorized: true,
      connectedAt: Date.now(),
      lastShareAt: 0,
      sharesValid: 0,
      sharesInvalid: 0,
      shareTimes: [],
      work: 0, // sum of accepted share difficulties (for hashrate estimate)
      sendJob: session.sendJob || null,
    };
    this.miners.set(session.id, miner);
    this.stats.connections++;
    // Make sure a job exists at this difficulty and push it.
    const job = this.jobFor(miner);
    if (miner.sendJob && job) miner.sendJob(job);
    return miner;
  }

  removeMiner(id) {
    this.miners.delete(id);
  }

  getMiner(id) {
    return this.miners.get(id);
  }

  /* ---------------- vardiff ---------------- */

  _retarget(miner) {
    if (miner.staticDiff) return;
    const times = miner.shareTimes;
    if (times.length < this.cfg.vardiffWindow) return;
    // 1 ms floor: shares arriving in the same millisecond are "infinitely fast".
    const span = Math.max(1, times[times.length - 1] - times[0]) / 1000;
    const avg = span / (times.length - 1 || 1);
    if (avg <= 0) return;
    const want = this.cfg.vardiffTargetSec;
    // Only move when clearly off-target (hysteresis avoids flapping).
    if (avg < want * 0.6 || avg > want * 1.8) {
      let nd = Math.round(miner.diff * (want / avg));
      nd = Math.min(this.cfg.maxDiff, Math.max(this.cfg.minDiff, nd));
      if (nd !== miner.diff && Math.abs(nd - miner.diff) / miner.diff > 0.2) {
        miner.diff = nd;
        miner.shareTimes = [];
        const job = this.jobFor(miner);
        if (miner.sendJob && job) miner.sendJob(job);
      }
    }
    if (times.length > this.cfg.vardiffWindow * 2) {
      miner.shareTimes = times.slice(-this.cfg.vardiffWindow);
    }
  }

  /* ---------------- share pipeline ---------------- */

  /**
   * Handle a normalized submit: { jobId, field, proofB64, encoding }.
   * Returns { ok, code?, message?, stale? }. Codes mirror the reference pools:
   * 20 invalid share, 21 job not found, 22 duplicate, 24 unauthorized.
   */
  async submitShare(minerId, submit) {
    const miner = this.miners.get(minerId);
    if (!miner || !miner.authorized) return { ok: false, code: 24, message: "Unauthorized worker" };

    const job = this.jobHistory.get(submit.jobId);
    if (!job) return { ok: false, code: 21, message: "Job not found" };

    const field = submit.field;
    if (field !== "plain_proof" && field !== "plain_proof_zst") {
      return { ok: false, code: 20, message: `bad proof format: field ${field} not supported` };
    }

    const stale = job.jobId !== this.jobsByDiff.get(miner.diff)?.jobId;
    const now = Date.now();

    // Verify with the real zk-pow verifier (never accept on infra failure).
    let vr;
    try {
      vr = await this.verifier.verify({
        header: job.headerHex,
        proof_b64: submit.proofB64,
        encoding: submit.encoding || (field === "plain_proof_zst" ? "zstd" : "plain"),
        nbits: job.nbits,
        cert_version: job.certVersion,
      });
    } catch (e) {
      miner.sharesInvalid++;
      this.stats.sharesInvalid++;
      return { ok: false, code: 20, message: `verifier unavailable: ${e.message}` };
    }
    if (!vr.ok) {
      miner.sharesInvalid++;
      this.stats.sharesInvalid++;
      return { ok: false, code: 20, message: `Invalid proof: ${vr.error}` };
    }
    if (this.seenDigests.has(vr.digest)) {
      miner.sharesInvalid++;
      this.stats.sharesDuplicate++;
      return { ok: false, code: 22, message: "Duplicate share" };
    }
    this.seenDigests.add(vr.digest);
    if (this.seenDigests.size > 200000) {
      // Bound memory: drop the oldest half (digests are ~in arrival order).
      const arr = [...this.seenDigests];
      this.seenDigests = new Set(arr.slice(arr.length / 2));
    }

    // Accept.
    miner.sharesValid++;
    miner.lastShareAt = now;
    miner.work += job.diff;
    miner.shareTimes.push(now);
    this.stats.sharesValid++;
    if (stale) this.stats.sharesStale++;
    this._retarget(miner);

    // Accounting (stale shares are validated but earn no PPLNS weight — documented).
    if (this.payouts && !stale) {
      this.payouts.addShare({
        wallet: miner.wallet, worker: miner.worker, diff: job.diff,
        solo: miner.solo, height: job.height, jobId: job.jobId, at: now,
      });
    }

    // Block?!
    let block = false;
    if (vr.block) {
      block = true;
      this._onBlockFound(miner, job, submit, vr);
    }
    return { ok: true, stale, block };
  }

  _onBlockFound(miner, job, submit, vr) {
    this.stats.blocksFound++;
    const candidate = {
      at: new Date().toISOString(),
      height: job.height,
      jobId: job.jobId,
      headerHex: job.headerHex,
      finder: miner.wallet,
      worker: miner.worker,
      solo: miner.solo,
      digest: vr.digest,
      proofB64: submit.proofB64,
      templateId: job.templateId,
      // NOTE: assembling a submittable block requires the winning certificate
      // (full STARK proof), which only a proving miner can produce. The candidate
      // is archived here for the operator; see README "Block found flow".
      submittable: false,
    };
    this.blockCandidates.push(candidate);
    if (this.blockCandidates.length > 100) this.blockCandidates.shift();
    if (this.payouts) {
      this.payouts.creditBlock({
        height: job.height,
        rewardGrains: this._template?.coinbaseValueGrains ?? 0n,
        finderWallet: miner.wallet,
        solo: miner.solo,
        at: Date.now(),
      });
    }
    if (this.templates.notifyBlockFound) {
      try { this.templates.notifyBlockFound(job.headerHex); } catch { /* ignore */ }
    }
    // New template ASAP so everyone moves to the next height.
    this._refreshTemplate(true).catch(() => {});
    if (this._onBlock) { try { this._onBlock(candidate); } catch { /* ignore */ } }
  }

  /* ---------------- stats ---------------- */

  poolStats() {
    const miners = [...this.miners.values()].map((m) => ({
      wallet: m.wallet, worker: m.worker, solo: m.solo, dialect: m.dialect,
      diff: m.diff, sharesValid: m.sharesValid, sharesInvalid: m.sharesInvalid,
      lastShareAt: m.lastShareAt, connectedAt: m.connectedAt,
      estHashrate: this._estRate(m),
    }));
    const windowSec = 600;
    const cutoff = Date.now() - windowSec * 1000;
    let work = 0;
    for (const m of this.miners.values()) work += m.work; // cumulative; API refines
    void cutoff; void work;
    return {
      ...this.stats,
      uptimeSec: Math.floor((Date.now() - this.stats.startedAt) / 1000),
      minersOnline: this.miners.size,
      activeDiffs: [...this.jobsByDiff.keys()],
      certVersion: this.cfg.certVersion,
      network: this.networkId,
      miners,
    };
  }

  _estRate(miner) {
    // Share-difficulty per second over the miner's recent window, scaled to
    // proof-work units. Labeled clearly in the API as an estimate.
    const times = miner.shareTimes;
    if (times.length < 2) return 0;
    const spanSec = (times[times.length - 1] - times[0]) / 1000;
    if (spanSec < 1) return 0;
    return (miner.diff * (times.length - 1)) / spanSec;
  }
}
