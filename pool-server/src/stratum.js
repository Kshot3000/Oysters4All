/**
 * stratum.js — TCP stratum server speaking the documented Pearl pool dialects.
 *
 * Grounded in the live captures (docs/protocol/{herominers,kryptex,luckypool}.md,
 * 2026-09-26) and the spm-mockpool reference implementation:
 *
 *  HeroMiners / LuckyPool (authorize-first, object params):
 *    -> {"id":1,"method":"mining.authorize","params":{"wallet":"prl1...","worker":"w","agent":"miner/1.0"}}
 *    <- {"id":1,"error":null,"result":true[, "type":"plain"]}   (type = expected proof encoding)
 *  Kryptex:
 *    -> {"id":1,"jsonrpc":"2.0","method":"mining.subscribe","params":["miner/1.0"]}   (silent, no reply)
 *    -> {"id":2,"jsonrpc":"2.0","method":"mining.authorize","params":["prl1....worker","x"|"d=2097152"]}
 *    <- {"id":2,"result":true,"error":null}
 *  Kryptex v2:
 *    -> {"method":"mining.authorize","params":{"wallet":"prl1....worker","agent":"..","type":"v2"}}
 *    <- {"id":..,"error":null,"result":true,"type":"v2"}   (submits = base64(gzip(bincode)) in plain_proof)
 *
 *  Job (mining.notify, params object):
 *    {"id":null,"method":"mining.notify","params":{"job_id":"<8hex>_<diff>","header":"<152 hex>",
 *     "target":"<64 hex BE>","height":N,"cert_version":3,"diff":N}}
 *  Share (mining.submit, params object):
 *    {"id":N,"method":"mining.submit","params":{"job_id":"..","plain_proof":"<b64>"}}
 *    6block's miner uses the field "plain_proof_zst" (zstd). v2 sessions gzip "plain_proof".
 *
 * Replies follow the mockpool framing:
 *    ok:  {"id":N,"error":null,"result":true}
 *    err: {"id":N,"result":null,"error":{"code":C,"message":"M"}}
 * Codes: 20 invalid share, 21 job not found, 22 duplicate share, 24 unauthorized.
 *
 * Difficulty retargeting is job-based (LuckyPool-style): each job carries its own
 * target; the captured clients don't implement mining.set_difficulty.
 */
import { createServer as createTcpServer } from "node:net";
import { createServer as createTlsServer } from "node:tls";
import { readFileSync } from "node:fs";
import { isValidPearlAddress, splitLogin, nowSec, randHex } from "./util.js";

const BAN_AFTER_SHARES = 1000;
const BAN_STALE_RATE = 0.30;
const BAN_SECONDS = 3600;
// Identity strings are labels, not payloads. The 64 MiB line cap exists for
// proof submissions; without a field cap, one unauthenticated authorize or
// subscribe could make the pool retain a megabyte-long worker/agent string
// for the life of the session and repeat the worker in every stats reply.
const MAX_WORKER_LENGTH = 256;
const MAX_AGENT_LENGTH = 256;

export class StratumServer {
  /**
   * @param {object} opts
   * @param {Pool} opts.pool
   * @param {number} [opts.port]
   * @param {string} [opts.host]
   * @param {object} [opts.tls] { key, cert } file paths — enables TLS (Kryptex/LuckyPool need it)
   * @param {string} [opts.networkId]
   * @param {function} [opts.log]
   */
  constructor(opts) {
    this.pool = opts.pool;
    this.port = opts.port ?? 3333;
    this.host = opts.host || "0.0.0.0";
    this.tls = opts.tls || null;
    this.networkId = opts.networkId || "mainnet";
    this.log = opts.log || (() => {});
    this.server = null;
    this.conns = new Set();
    this.bans = new Map();       // wallet -> bannedUntilSec
    this.walletStats = new Map(); // wallet -> { shares, stale }
  }

  async start() {
    const onConn = (sock) => this._onConnection(sock);
    this.server = this.tls
      ? createTlsServer({ key: readFileSync(this.tls.key), cert: readFileSync(this.tls.cert) }, onConn)
      : createTcpServer(onConn);
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, () => { this.server.off("error", reject); resolve(); });
    });
    this.log(`stratum listening on ${this.tls ? "tls://" : ""}${this.host}:${this.port}`);
  }

  async stop() {
    for (const c of this.conns) { try { c.sock.destroy(); } catch { /* ignore */ } }
    this.conns.clear();
    if (this.server) await new Promise((r) => this.server.close(r));
  }

  _onConnection(sock) {
    const conn = {
      sock,
      id: randHex(8),
      buf: "",
      dialect: null,      // 'hero' | 'kryptex' | 'kryptex-v2'
      sessionId: null,
      agent: "",
      gzip: false,
    };
    this.conns.add(conn);
    sock.setEncoding("utf8");
    sock.setTimeout(10 * 60 * 1000);
    sock.on("data", (d) => this._onData(conn, d));
    sock.on("close", () => this._onClose(conn));
    sock.on("timeout", () => { try { sock.destroy(); } catch { /* ignore */ } });
    sock.on("error", () => { /* close follows */ });
  }

  _onClose(conn) {
    this.conns.delete(conn);
    if (conn.sessionId) this.pool.removeMiner(conn.sessionId);
  }

  _send(conn, obj) {
    try { conn.sock.write(JSON.stringify(obj) + "\n"); return true; }
    catch { return false; }
  }

  _replyOk(conn, id, extra) {
    const o = { id: id ?? null, error: null, result: true };
    if (extra) Object.assign(o, extra);
    this._send(conn, o);
  }

  _replyErr(conn, id, code, message) {
    this._send(conn, { id: id ?? null, result: null, error: { code, message } });
  }

  _onData(conn, data) {
    conn.buf += data;
    // Guard against absurd lines (mockpool faults.oversized_line analogue).
    if (conn.buf.length > 64 * 1024 * 1024) { try { conn.sock.destroy(); } catch { /* ignore */ } return; }
    let nl;
    while ((nl = conn.buf.indexOf("\n")) >= 0) {
      const line = conn.buf.slice(0, nl).trim();
      conn.buf = conn.buf.slice(nl + 1);
      if (line) this._onLine(conn, line);
    }
  }

  _onLine(conn, line) {
    let msg;
    try { msg = JSON.parse(line); }
    catch {
      this._replyErr(conn, null, -32700, "Malformed JSON");
      return;
    }
    // Tolerate raw stratum-v1 envelope arrays: ["method", params, id].
    if (Array.isArray(msg)) {
      const [method, params, id] = msg;
      msg = { jsonrpc: "2.0", id: id ?? null, method, params };
    }
    // Any other non-object envelope (null, a bare number/string/boolean) is
    // an invalid request, not a method call. `null` is the dangerous one:
    // it is valid JSON, but reading msg.id on it throws — and this handler
    // runs on the socket 'data' event with no enclosing try/catch, so the
    // TypeError was an uncaught exception that killed the whole pool
    // process. One unauthenticated "null" line must never do that.
    if (!msg || typeof msg !== "object") {
      this._replyErr(conn, null, -32600, "Invalid Request");
      return;
    }
    const id = msg.id ?? null;
    const method = msg.method;
    const params = msg.params;
    if (method === "mining.subscribe") {
      // Kryptex: silent. Just note the dialect + agent.
      if (conn.dialect === null && Array.isArray(params)) conn.dialect = "kryptex";
      if (Array.isArray(params) && typeof params[0] === "string") conn.agent = params[0].slice(0, MAX_AGENT_LENGTH);
      return; // no reply
    }
    if (method === "mining.authorize") return void this._onAuthorize(conn, id, params);
    if (method === "mining.submit") return void this._onSubmit(conn, id, params);
    this._replyErr(conn, id, -32601, "Method not found");
  }

  _parseLogin(params) {
    // Returns { login, password, agent, wantsV2 } or throws.
    if (Array.isArray(params)) {
      // Kryptex: ["<wallet>.<worker>", "x"|"d=N"]
      return { login: String(params[0] || ""), password: String(params[1] || "x"), agent: "", wantsV2: false };
    }
    if (params && typeof params === "object") {
      const p = params;
      const login = p.wallet ? String(p.wallet) : "";
      const worker = p.worker ? String(p.worker) : "";
      const combined = worker && !login.includes(".") ? `${login}.${worker}` : login;
      return {
        login: combined,
        password: String(p.password || p.pass || "x"),
        agent: String(p.agent || ""),
        wantsV2: p.type === "v2",
      };
    }
    throw new Error("bad authorize params");
  }

  _staticDiff(password) {
    const m = /(?:^|[,\s])d=(\d+)/i.exec(String(password || ""));
    if (!m) return null;
    // Kryptex documents a 2,097,152 minimum for password-set difficulty.
    // Clamp BOTH ends. The password is unauthenticated remote input:
    // parseInt of a long digit run is Infinity (400 nines) and a merely
    // huge finite value (20 nines -> 1e20) sailed past the pool's own
    // maxDiff. Infinity flowed through addMiner into targetForDiff's
    // BigInt(...) conversion, which throws RangeError — uncaught in the
    // socket handler, it killed the whole pool process from a single
    // authorize line. Clamping to the pool's maxDiff (the same bound
    // vardiff enforces) makes every d= value a usable difficulty.
    const cap = this.pool?.cfg?.maxDiff ?? 2 ** 40;
    return Math.min(cap, Math.max(2097152, parseInt(m[1], 10)));
  }

  _onAuthorize(conn, id, params) {
    let login;
    try {
      login = this._parseLogin(params);
    } catch {
      this._replyErr(conn, id, 24, "Unauthorized worker");
      return;
    }
    const { wallet, worker, solo } = splitLogin(login.login);
    if (login.agent) conn.agent = login.agent.slice(0, MAX_AGENT_LENGTH);

    const fail = (message) => this._replyErr(conn, id, 24, message);
    if (!wallet) return fail("Unauthorized worker");
    // Reject rather than truncate: the worker name is an identity label in
    // miner stats and block candidates, so silently shortening it could
    // merge two distinct workers into one apparent identity.
    if (worker.length > MAX_WORKER_LENGTH) return fail("Unauthorized worker: worker name too long");
    // Ban check (stale-share abuse tier).
    const bannedUntil = this.bans.get(wallet);
    if (bannedUntil && nowSec() < bannedUntil) return fail("Banned: stale share rate exceeded");
    if (!isValidPearlAddress(wallet, this.networkId)) return fail("Unauthorized worker: invalid wallet address");

    // Dialect + proof encoding.
    let dialect, ackType;
    if (login.wantsV2) { dialect = "kryptex-v2"; ackType = "v2"; conn.gzip = true; }
    else if (Array.isArray(params)) { dialect = "kryptex"; ackType = "plain"; }
    else { dialect = "hero"; ackType = "plain"; }
    conn.dialect = dialect;

    const staticDiff = this._staticDiff(login.password);
    const sessionId = randHex(8);
    conn.sessionId = sessionId;
    // Ack first, then the job (matches the documented pool order: authorize
    // reply immediately followed by mining.notify).
    this._replyOk(conn, id, { type: ackType });
    // Fail closed per-connection: addMiner issues a job synchronously, and
    // any unexpected throw there must never escape into the socket 'data'
    // handler as an uncaught exception that kills the pool (the crash
    // class the null-envelope and _onSubmit guards already close).
    let miner;
    try {
      miner = this.pool.addMiner({
        id: sessionId,
        wallet, worker, solo, dialect,
        staticDiff,
        sendJob: (job) => this._sendJob(conn, job),
      });
    } catch {
      conn.sessionId = null;
      try { this.pool.removeMiner(sessionId); } catch { /* ignore */ }
      this._replyErr(conn, id, 24, "Unauthorized worker");
      return;
    }
    void miner;
    this.log(`auth ${dialect} wallet=${wallet.slice(0, 12)}... worker=${worker || "-"} solo=${solo} diff=${staticDiff || "vardiff"}`);
  }

  _sendJob(conn, job) {
    this._send(conn, {
      id: null,
      method: "mining.notify",
      params: {
        job_id: job.jobId,
        header: job.headerHex,
        target: job.targetHex,
        height: job.height,
        cert_version: job.certVersion,
        diff: job.diff,
      },
    });
  }

  async _onSubmit(conn, id, params) {
    const p = (params && typeof params === "object" && !Array.isArray(params)) ? params : {};
    if (!conn.sessionId) { this._replyErr(conn, id, 24, "Unauthorized worker"); return; }
    const jobId = p.job_id ? String(p.job_id) : "";
    let field = null;
    if (typeof p.plain_proof === "string") field = "plain_proof";
    else if (typeof p.plain_proof_zst === "string") field = "plain_proof_zst";
    if (!jobId || !field) {
      this._replyErr(conn, id, 20, `bad proof format: field ${field || "?"} not supported`);
      return;
    }
    const proofB64 = field === "plain_proof" ? p.plain_proof : p.plain_proof_zst;
    const encoding = conn.gzip ? "gzip" : field === "plain_proof_zst" ? "zstd" : "plain";
    // submitShare converts verifier failures to a verdict, but an unexpected
    // throw anywhere in the pipeline must still fail THIS share closed —
    // as an unhandled rejection from the socket handler it would kill the
    // process (same crash class as the null-envelope deref above).
    let res;
    try {
      res = await this.pool.submitShare(conn.sessionId, { jobId, field, proofB64, encoding });
    } catch {
      this._replyErr(conn, id, 20, "Invalid share");
      return;
    }
    if (res.ok) {
      this._trackShare(conn, res.stale);
      this._replyOk(conn, id);
    } else {
      this._replyErr(conn, id, res.code || 20, res.message || "Invalid share");
    }
  }

  _trackShare(conn, stale) {
    const miner = this.pool.getMiner(conn.sessionId);
    if (!miner) return;
    let ws = this.walletStats.get(miner.wallet);
    if (!ws) { ws = { shares: 0, stale: 0 }; this.walletStats.set(miner.wallet, ws); }
    ws.shares++;
    if (stale) ws.stale++;
    // HeroMiners-style abuse tier: >30% stale after 1000 shares -> 3600 s ban.
    if (ws.shares >= BAN_AFTER_SHARES && ws.stale / ws.shares > BAN_STALE_RATE) {
      this.bans.set(miner.wallet, nowSec() + BAN_SECONDS);
      ws.shares = 0; ws.stale = 0;
      this.log(`ban wallet=${miner.wallet.slice(0, 12)}... stale rate exceeded`);
    }
  }
}
