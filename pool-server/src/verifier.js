/**
 * verifier.js — manages a pool of pearl-pool-verifier worker processes.
 *
 * Each worker speaks line-delimited JSON on stdin/stdout (see verifier/src/main.rs).
 * Requests are round-robined across workers; each in-flight request resolves with
 * the parsed response object. If a worker dies it is respawned; in-flight requests
 * on a dead worker reject so the caller can fail the share safely (reject, not accept).
 */
import { spawn } from "node:child_process";
import { once } from "node:events";

const DEFAULT_BINARY =
  new URL("../verifier/target/release/pearl-pool-verifier", import.meta.url).pathname;

// A verifier response is one small line-delimited JSON object
// ({ _seq, ok, digest?, block?, error? }) — never a proof or a blob.
// Cap the per-worker line buffer so a malfunctioning or compromised
// worker that spews without a newline cannot grow pool memory without
// bound (the stratum server caps miner lines for the same reason);
// crossing the cap fails the worker like any other worker error.
const MAX_WORKER_BUF_BYTES = 1024 * 1024;

// Cap in-flight requests per worker. verify() otherwise accepts every
// call a stratum connection pipelines: each pending entry holds a
// request open for up to timeoutMs (60 s default), and the request lines
// themselves buffer in the worker's stdin — so an unbounded caller could
// grow pool memory and monopolize every worker with fabricated proofs
// that cost nothing to make and a full STARK verification to reject.
// The stratum layer caps each CONNECTION at 32 in flight; this is the
// pool-wide second layer, so no number of connections can exceed it.
// Past the cap, verify() rejects immediately ("verifier busy") and the
// share fails closed like any other verifier failure.
const MAX_PENDING_PER_WORKER = 256;

export class VerifierPool {
  /**
   * @param {object} opts
   * @param {string} [opts.binary] path to the verifier binary
   * @param {number} [opts.workers] number of worker processes
   * @param {number} [opts.timeoutMs] per-request timeout
   */
  constructor(opts = {}) {
    this.binary = opts.binary || process.env.PEARL_POOL_VERIFIER || DEFAULT_BINARY;
    this.nWorkers = Math.max(1, opts.workers || 2);
    this.timeoutMs = opts.timeoutMs || 60_000;
    this.workers = [];
    this.next = 0;
    this.started = false;
    this.stopping = false;
  }

  async start() {
    if (this.started) return;
    this.stopping = false;
    for (let i = 0; i < this.nWorkers; i++) this.workers.push(this._spawnWorker(i));
    this.started = true;
  }

  _spawnWorker(i) {
    const child = spawn(this.binary, [], { stdio: ["pipe", "pipe", "pipe"] });
    const w = { child, pending: new Map(), seq: 0, buf: "", dead: false, idx: i };
    child.on("error", (err) => this._onWorkerError(w, err));
    child.on("exit", () => this._onWorkerError(w, new Error("verifier worker exited")));
    child.stderr.on("data", () => { /* verifier is quiet; ignore */ });
    child.stdout.on("data", (chunk) => this._onData(w, chunk));
    return w;
  }

  _onWorkerError(w, err) {
    if (w.dead) return;
    w.dead = true;
    for (const [, p] of w.pending) p.reject(err);
    w.pending.clear();
    // Don't respawn while stopping/stopped — otherwise stop() can never end.
    if (this.stopping || !this.started) return;
    // Respawn after a short delay so a persistently failing binary (bad path,
    // missing libs) can't hot-loop and starve the event loop.
    const idx = w.idx;
    setTimeout(() => {
      if (this.stopping || !this.started) return;
      const cur = this.workers[idx];
      if (cur && !cur.dead) return; // already replaced
      this.workers[idx] = this._spawnWorker(idx);
    }, 1000).unref?.();
  }

  _onData(w, chunk) {
    w.buf += chunk.toString("utf8");
    if (w.buf.length > MAX_WORKER_BUF_BYTES) {
      w.buf = "";
      try { w.child.kill("SIGKILL"); } catch { /* already gone */ }
      this._onWorkerError(w, new Error("verifier worker output exceeded the 1 MiB line limit"));
      return;
    }
    let nl;
    while ((nl = w.buf.indexOf("\n")) >= 0) {
      const line = w.buf.slice(0, nl).trim();
      w.buf = w.buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      // A "null" (or bare scalar) line is valid JSON but not a response:
      // reading msg._seq on null throws inside this stdout 'data' handler,
      // an uncaught exception that kills the pool process — the same crash
      // class as a null stratum envelope. Ignore non-object lines like
      // unparseable ones.
      if (!msg || typeof msg !== "object") continue;
      const p = w.pending.get(msg._seq);
      if (p) { w.pending.delete(msg._seq); p.resolve(msg); }
    }
  }

  /**
   * Verify one share. Resolves { ok, digest?, block?, error? }.
   * Rejects only on worker failure/timeout (caller must treat as a reject, never an accept).
   */
  verify(req) {
    const w = this._pick();
    if (!w) return Promise.reject(new Error("verifier busy: too many shares in flight"));
    return new Promise((resolve, reject) => {
      const seq = ++w.seq;
      const timer = setTimeout(() => {
        w.pending.delete(seq);
        reject(new Error("verifier timeout"));
      }, this.timeoutMs);
      w.pending.set(seq, {
        resolve: (msg) => { clearTimeout(timer); const { _seq, ...rest } = msg; resolve(rest); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
      // Tag the request so responses route back; the worker ignores unknown fields.
      const line = JSON.stringify({ _seq: seq, ...req }) + "\n";
      w.child.stdin.write(line, (err) => {
        if (err) { w.pending.delete(seq); clearTimeout(timer); reject(err); }
      });
    });
  }

  _pick() {
    // Round-robin, skipping dead workers (they are replaced async; pick
    // any live one) AND workers already holding the pending cap.
    for (let k = 0; k < this.workers.length; k++) {
      const w = this.workers[(this.next + k) % this.workers.length];
      if (!w.dead && w.pending.size < MAX_PENDING_PER_WORKER) { this.next = (this.next + k + 1) % this.workers.length; return w; }
    }
    // A live worker exists but every one is saturated: report busy (null)
    // so verify() rejects instead of queueing past the cap.
    if (this.workers.some((w) => !w.dead)) return null;
    // All dead (respawning) — use slot 0; the write will fail and the caller rejects.
    return this.workers[0];
  }

  async stop() {
    this.stopping = true;
    for (const w of this.workers) {
      try { w.child.kill("SIGTERM"); } catch { /* ignore */ }
    }
    // 'close' (not 'exit') always fires, even when the spawn itself failed.
    const waitClose = (w) => Promise.race([
      once(w.child, "close").catch(() => {}),
      new Promise((r) => setTimeout(r, 5000)),
    ]);
    await Promise.allSettled(this.workers.map(waitClose));
    this.workers = [];
    this.started = false;
  }
}
