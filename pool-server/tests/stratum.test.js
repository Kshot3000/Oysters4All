import { test } from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { createHash } from "node:crypto";
import { Pool } from "../src/pool.js";
import { StratumServer } from "../src/stratum.js";
import { Payouts } from "../src/payouts.js";
import { SyntheticProvider } from "../src/templates.js";
import { VerifierPool } from "../src/verifier.js";

const WALLET = "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d";

function mockVerifier() {
  return {
    async start() {}, async stop() {},
    async verify(req) {
      if (!/^[0-9a-f]{152}$/.test(req.header)) return { ok: false, error: "bad header" };
      const digest = createHash("sha256").update(Buffer.from(req.proof_b64, "base64")).digest("hex");
      return { ok: true, digest, block: false };
    },
  };
}

async function makeServer() {
  const provider = new SyntheticProvider({ networkDiff: 1024, startHeight: 5000 });
  const pool = new Pool({
    templateProvider: provider, verifierPool: mockVerifier(),
    payouts: new Payouts({ stateFile: null }),
    initialDiff: 1024, minDiff: 64, jobIntervalSec: 3600,
  });
  await pool.start();
  const srv = new StratumServer({ pool, host: "127.0.0.1", port: 0, networkId: "mainnet", log: () => {} });
  await srv.start();
  const port = srv.server.address().port;
  return { pool, srv, port };
}

/** Line-delimited JSON client. */
function client(port) {
  const sock = connect(port, "127.0.0.1");
  const c = { sock, buf: "", queue: [], waiters: [] };
  sock.setEncoding("utf8");
  sock.on("data", (d) => {
    c.buf += d;
    let nl;
    while ((nl = c.buf.indexOf("\n")) >= 0) {
      const line = c.buf.slice(0, nl).trim();
      c.buf = c.buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const w = c.waiters.shift();
      if (w) w(msg); else c.queue.push(msg);
    }
  });
  c.send = (obj) => sock.write(JSON.stringify(obj) + "\n");
  c.next = (ms = 3000) => new Promise((resolve, reject) => {
    if (c.queue.length) return resolve(c.queue.shift());
    const waiter = (m) => { clearTimeout(t); resolve(m); };
    const t = setTimeout(() => {
      const i = c.waiters.indexOf(waiter);
      if (i >= 0) c.waiters.splice(i, 1);
      reject(new Error("timeout waiting for message"));
    }, ms);
    c.waiters.push(waiter);
  });
  c.close = () => sock.destroy();
  return c;
}

/** Run fn with a live server; always tears down (even on assertion failure). */
async function withServer(fn) {
  const ctx = await makeServer();
  const clients = [];
  try {
    await fn(ctx, (port) => { const c = client(port); clients.push(c); return c; });
  } finally {
    for (const c of clients) c.close();
    await ctx.srv.stop();
    await ctx.pool.stop();
  }
}

test("hero dialect: object authorize -> ack with type plain, then job", async () => {
  await withServer(async (ctx, mk) => {
    const c = mk(ctx.port);
    c.send({ id: 1, method: "mining.authorize", params: { wallet: WALLET, worker: "w1", agent: "test/1.0" } });
    const ack = await c.next();
    assert.equal(ack.id, 1);
    assert.equal(ack.error, null);
    assert.equal(ack.result, true);
    assert.equal(ack.type, "plain");
    const notify = await c.next();
    assert.equal(notify.method, "mining.notify");
    assert.match(notify.params.job_id, /^[0-9a-f]{8}_1024$/);
    assert.equal(notify.params.header.length, 152);
    assert.equal(notify.params.target.length, 64);
    assert.equal(notify.params.cert_version, 3);
  });
});

test("kryptex dialect: silent subscribe, array authorize, job", async () => {
  await withServer(async (ctx, mk) => {
    const c = mk(ctx.port);
    c.send({ id: 1, jsonrpc: "2.0", method: "mining.subscribe", params: ["test/1.0"] });
    // Silent: nothing should arrive within 300 ms.
    await assert.rejects(c.next(300), /timeout/);
    c.send({ id: 2, jsonrpc: "2.0", method: "mining.authorize", params: [`${WALLET}.w2`, "x"] });
    const ack = await c.next();
    assert.equal(ack.id, 2);
    assert.equal(ack.result, true);
    assert.equal(ack.error, null);
    const notify = await c.next();
    assert.equal(notify.method, "mining.notify");
    assert.match(notify.params.job_id, /^[0-9a-f]{8}_1024$/);
  });
});

test("kryptex password d=N selects static difficulty", async () => {
  await withServer(async (ctx, mk) => {
    const c = mk(ctx.port);
    c.send({ id: 2, method: "mining.authorize", params: [`${WALLET}.w3`, "d=4194304"] });
    await c.next(); // ack
    const notify = await c.next();
    assert.match(notify.params.job_id, /^[0-9a-f]{8}_4194304$/);
    const miners = [...ctx.pool.miners.values()];
    assert.equal(miners[0].diff, 4194304);
    assert.equal(miners[0].staticDiff, true);
  });
});

test("kryptex password d=<huge> clamps to the pool maxDiff and the server survives", async () => {
  await withServer(async (ctx, mk) => {
    // 400 nines: parseInt is Infinity, which used to flow into
    // targetForDiff's BigInt() and kill the whole pool process with an
    // uncaught RangeError from a single unauthenticated authorize line.
    const c1 = mk(ctx.port);
    c1.send({ id: 2, method: "mining.authorize", params: [`${WALLET}.evil`, "d=" + "9".repeat(400)] });
    const ack = await c1.next();
    assert.equal(ack.result, true);
    const notify = await c1.next();
    assert.match(notify.params.job_id, /^[0-9a-f]{8}_1099511627776$/); // 2**40 = cfg.maxDiff
    // 20 nines: finite (1e20) but still far above maxDiff — same clamp.
    const c2 = mk(ctx.port);
    c2.send({ id: 3, method: "mining.authorize", params: [`${WALLET}.evil2`, "d=" + "9".repeat(20)] });
    await c2.next();
    const notify2 = await c2.next();
    assert.match(notify2.params.job_id, /^[0-9a-f]{8}_1099511627776$/);
    const miners = [...ctx.pool.miners.values()];
    assert.equal(miners.length, 2);
    assert.ok(miners.every((m) => m.diff === 2 ** 40 && m.staticDiff));
    // A normal authorize still works afterwards on a fresh connection.
    const c3 = mk(ctx.port);
    c3.send({ id: 4, method: "mining.authorize", params: { wallet: WALLET, worker: "w" } });
    const ack3 = await c3.next();
    assert.equal(ack3.result, true);
    await c3.next(); // job
  });
});

test("oversized worker names are refused and agent strings are bounded", async () => {
  await withServer(async (ctx, mk) => {
    // The 64 MiB line cap exists for proof submissions, but identity labels
    // were retained unbounded: one unauthenticated authorize stored a
    // megabyte worker string in the miner record (repeated by every stats
    // reply), and subscribe stored a megabyte agent string per connection.
    const longWorker = "w".repeat(257);
    const c1 = mk(ctx.port);
    c1.send({ id: 1, method: "mining.authorize", params: { wallet: WALLET, worker: longWorker } });
    const r1 = await c1.next();
    assert.equal(r1.result, null);
    assert.equal(r1.error.code, 24);
    assert.equal(ctx.pool.miners.size, 0);

    const c2 = mk(ctx.port);
    c2.send({ id: 2, method: "mining.authorize", params: [`${WALLET}.${longWorker}`, "x"] });
    const r2 = await c2.next();
    assert.equal(r2.result, null);
    assert.equal(r2.error.code, 24);
    assert.equal(ctx.pool.miners.size, 0);

    // Agent is informational only: it is capped on storage, not a reason to
    // refuse an otherwise valid miner or subscriber.
    const c3 = mk(ctx.port);
    c3.send({ id: 3, method: "mining.subscribe", params: ["a".repeat(100000)] });
    await new Promise((r) => setTimeout(r, 100));
    const conn3 = [...ctx.srv.conns].find((conn) => conn.agent.length > 0);
    assert.equal(conn3.agent.length, 256);

    const c4 = mk(ctx.port);
    c4.send({ id: 4, method: "mining.authorize", params: { wallet: WALLET, worker: "w", agent: "b".repeat(100000) } });
    const ack4 = await c4.next();
    assert.equal(ack4.result, true);
    await c4.next(); // job
    const conn4 = [...ctx.srv.conns].find((conn) => conn.agent.startsWith("b"));
    assert.equal(conn4.agent.length, 256);
    assert.equal([...ctx.pool.miners.values()][0].worker, "w");
  });
});

test("kryptex v2: object authorize with type v2 -> ack echoes v2", async () => {
  await withServer(async (ctx, mk) => {
    const c = mk(ctx.port);
    c.send({ id: 5, method: "mining.authorize", params: { wallet: `${WALLET}.w4`, agent: "test/1.0", type: "v2" } });
    const ack = await c.next();
    assert.equal(ack.result, true);
    assert.equal(ack.type, "v2");
    await c.next(); // job
  });
});

test("invalid wallet rejected with code 24", async () => {
  await withServer(async (ctx, mk) => {
    const c = mk(ctx.port);
    c.send({ id: 1, method: "mining.authorize", params: { wallet: "not-an-address", worker: "w" } });
    const ack = await c.next();
    assert.equal(ack.result, null);
    assert.equal(ack.error.code, 24);
  });
});

test("solo: prefix selects solo mode", async () => {
  await withServer(async (ctx, mk) => {
    const c = mk(ctx.port);
    c.send({ id: 1, method: "mining.authorize", params: { wallet: `solo:${WALLET}`, worker: "s" } });
    await c.next();
    await c.next();
    const miners = [...ctx.pool.miners.values()];
    assert.equal(miners[0].solo, true);
    assert.equal(miners[0].wallet, WALLET);
  });
});

test("submit accepted end-to-end over the wire", async () => {
  await withServer(async (ctx, mk) => {
    const c = mk(ctx.port);
    c.send({ id: 1, method: "mining.authorize", params: { wallet: WALLET, worker: "w" } });
    await c.next();
    const notify = await c.next();
    const proof = Buffer.from("wire-proof-" + Date.now()).toString("base64");
    c.send({ id: 9, method: "mining.submit", params: { job_id: notify.params.job_id, plain_proof: proof } });
    const res = await c.next();
    assert.equal(res.id, 9);
    assert.equal(res.error, null);
    assert.equal(res.result, true);
    assert.equal(ctx.pool.stats.sharesValid, 1);
  });
});

test("submit before authorize -> 24; unknown method -> -32601; bad JSON -> -32700", async () => {
  await withServer(async (ctx, mk) => {
    const c = mk(ctx.port);
    c.send({ id: 1, method: "mining.submit", params: { job_id: "x", plain_proof: "eA==" } });
    const r1 = await c.next();
    assert.equal(r1.error.code, 24);
    c.send({ id: 2, method: "mining.bogus", params: {} });
    const r2 = await c.next();
    assert.equal(r2.error.code, -32601);
    c.sock.write("{not json\n");
    const r3 = await c.next();
    assert.equal(r3.error.code, -32700);
  });
});

test("raw stratum-v1 array envelopes are tolerated", async () => {
  await withServer(async (ctx, mk) => {
    const c = mk(ctx.port);
    c.sock.write(JSON.stringify(["mining.authorize", { wallet: WALLET, worker: "w" }, 7]) + "\n");
    const ack = await c.next();
    assert.equal(ack.id, 7);
    assert.equal(ack.result, true);
  });
});

test("null and scalar envelopes -> -32600, connection and server survive", async () => {
  await withServer(async (ctx, mk) => {
    const c = mk(ctx.port);
    // "null" is valid JSON but its .id deref used to throw uncaught in the
    // socket data handler and kill the whole pool process (unauthenticated
    // remote DoS). Scalars took the same unguarded path.
    c.sock.write("null\n");
    const r0 = await c.next();
    assert.equal(r0.error.code, -32600);
    c.sock.write("123\n");
    const r1 = await c.next();
    assert.equal(r1.error.code, -32600);
    c.sock.write('"hi"\n');
    const r2 = await c.next();
    assert.equal(r2.error.code, -32600);
    // The same connection still authorizes and receives a job afterwards.
    c.send({ id: 3, method: "mining.authorize", params: { wallet: WALLET, worker: "w" } });
    const ack = await c.next();
    assert.equal(ack.result, true);
    const notify = await c.next();
    assert.equal(notify.method, "mining.notify");
  });
});

// Keep the import used (real VerifierPool is covered in verifier-protocol.test.js).
void VerifierPool;
