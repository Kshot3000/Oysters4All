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
    let nl;
    while ((nl = w.buf.indexOf("\n")) >= 0) {
      const line = w.buf.slice(0, nl).trim();
      w.buf = w.buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
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
    // Round-robin, skipping dead workers (they are replaced async; pick any live one).
    for (let k = 0; k < this.workers.length; k++) {
      const w = this.workers[(this.next + k) % this.workers.length];
      if (!w.dead) { this.next = (this.next + k + 1) % this.workers.length; return w; }
    }
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
