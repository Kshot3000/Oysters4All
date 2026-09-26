/* Integration tests for the faucet backend: boots the real server.js over
 * HTTP and drives /api/status + /api/drip end to end.
 *
 * Oyster is replaced by a tiny stub JSON-RPC server, so no real wallet or
 * node is needed. Store files live in os.tmpdir() and are removed after.
 *
 * Run: npm test   (node --test test/)
 */
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SERVER_JS = path.join(__dirname, '..', 'server.js');
const VALID_TPRL_V1 = 'tprl1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxq99uv3z';
const VALID_TPRL_V2 = 'tprl1z5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqdc9rlf';
const MAINNET_PRL = 'prl1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqw2cjwh';
const FAKE_TXID = 'ab'.repeat(32);

let nextPort = 18200 + (process.pid % 500);
const takePort = () => nextPort++;

/* Stub Oyster legacy JSON-RPC: answers sendtoaddress with a fake txid. */
function startStubOyster() {
  const port = takePort();
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let id = null, result = FAKE_TXID;
      try {
        const parsed = JSON.parse(body);
        id = parsed.id;
        if (parsed.method !== 'sendtoaddress') result = null;
      } catch { /* ignore */ }
      const out = JSON.stringify({ jsonrpc: '1.0', id, result, error: null });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(out);
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () =>
    resolve({ server, url: `http://127.0.0.1:${port}` })));
}

/* Boot server.js in a child process; resolves when /api/status answers. */
function startFaucet(extraEnv) {
  const port = takePort();
  const storeFile = path.join(os.tmpdir(), `faucet-int-${process.pid}-${port}.json`);
  const child = fork(SERVER_JS, [], {
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      FAUCET_NETWORK: 'testnet',
      STORE_FILE: storeFile,
      CORS_ORIGIN: '*',
      ...extraEnv,
    },
    silent: true,
  });
  child.stderr.on('data', (d) => process.stderr.write(`[faucet:${port}] ${d}`));
  const base = `http://127.0.0.1:${port}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`faucet on :${port} did not start`)), 8000);
    const poll = async () => {
      try {
        const r = await fetch(`${base}/api/status`);
        if (r.ok) { clearTimeout(timer); resolve({ child, base, storeFile, port }); return; }
      } catch { /* not up yet */ }
      setTimeout(poll, 100);
    };
    poll();
  });
}

function stopFaucet(h) {
  return new Promise((resolve) => {
    h.child.on('exit', () => {
      try { fs.unlinkSync(h.storeFile); } catch { /* ignore */ }
      resolve();
    });
    h.child.kill('SIGTERM');
    setTimeout(resolve, 3000); // never hang the suite
  });
}

async function postDrip(base, payload, raw = false) {
  const res = await fetch(`${base}/api/drip`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: raw ? payload : JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

describe('faucet backend (configured wallet)', { timeout: 30000 }, () => {
  let stub, faucet;
  before(async () => {
    stub = await startStubOyster();
    faucet = await startFaucet({
      OYSTER_RPC_URL: stub.url,
      OYSTER_RPC_USER: 'test',
      OYSTER_RPC_PASS: 'test',
      DAILY_CAP_PRL: '100',
    });
  });
  after(async () => {
    if (faucet) await stopFaucet(faucet);
    if (stub) await new Promise((r) => stub.server.close(r));
  });

  it('GET /api/status reports config honestly', async () => {
    const res = await fetch(`${faucet.base}/api/status`);
    assert.equal(res.status, 200);
    const s = await res.json();
    assert.equal(s.ok, true);
    assert.equal(s.network, 'testnet');
    assert.equal(s.walletConfigured, true);
    assert.equal(s.maxDripPRL, 1);
  });

  it('rejects malformed JSON with 400', async () => {
    const { status, body } = await postDrip(faucet.base, '{not json', true);
    assert.equal(status, 400);
    assert.equal(body.error, 'invalid JSON body');
  });

  it('rejects a missing address with 400', async () => {
    const { status, body } = await postDrip(faucet.base, {});
    assert.equal(status, 400);
    assert.equal(body.error, 'address is required');
  });

  it('rejects garbage addresses with 400', async () => {
    const { status, body } = await postDrip(faucet.base, { address: 'definitely-not-an-address' });
    assert.equal(status, 400);
    assert.equal(body.error, 'invalid address');
  });

  it('rejects mainnet prl addresses with 400', async () => {
    const { status, body } = await postDrip(faucet.base, { address: MAINNET_PRL });
    assert.equal(status, 400);
    assert.equal(body.error, 'invalid address');
    assert.match(body.detail, /wrong prefix "prl"/);
  });

  it('pays a valid tprl address and records the drip', async () => {
    const { status, body } = await postDrip(faucet.base, { address: VALID_TPRL_V1 });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.txid, FAKE_TXID);
    assert.equal(body.amountPRL, 1);
    const store = JSON.parse(fs.readFileSync(faucet.storeFile, 'utf8'));
    assert.equal(store.drips.length, 1);
    assert.equal(store.drips[0].address, VALID_TPRL_V1);
    assert.equal(store.drips[0].txid, FAKE_TXID);
  });

  it('rate-limits a second drip to the same address with 429', async () => {
    const { status, body } = await postDrip(faucet.base, { address: VALID_TPRL_V1 });
    assert.equal(status, 429);
    assert.equal(body.error, 'rate limited');
  });

  it('answers unknown routes with 404', async () => {
    const res = await fetch(`${faucet.base}/nope`);
    assert.equal(res.status, 404);
  });
});

describe('faucet backend daily cap', { timeout: 30000 }, () => {
  let stub, faucet;
  before(async () => {
    stub = await startStubOyster();
    faucet = await startFaucet({
      OYSTER_RPC_URL: stub.url,
      OYSTER_RPC_USER: 'test',
      OYSTER_RPC_PASS: 'test',
      MAX_DRIP_PRL: '1',
      DAILY_CAP_PRL: '1', // exactly one drip per 24h
    });
  });
  after(async () => {
    if (faucet) await stopFaucet(faucet);
    if (stub) await new Promise((r) => stub.server.close(r));
  });

  it('serves the first drip, then 429s with "daily cap reached"', async () => {
    const first = await postDrip(faucet.base, { address: VALID_TPRL_V1 });
    assert.equal(first.status, 200);
    const second = await postDrip(faucet.base, { address: VALID_TPRL_V2 });
    assert.equal(second.status, 429);
    assert.equal(second.body.error, 'daily cap reached');
  });
});

describe('faucet backend without wallet credentials', { timeout: 30000 }, () => {
  let faucet;
  before(async () => {
    faucet = await startFaucet({ DAILY_CAP_PRL: '100' }); // no OYSTER_RPC_USER
  });
  after(async () => { if (faucet) await stopFaucet(faucet); });

  it('reports walletConfigured:false and 503s drips honestly — no fake txids', async () => {
    const s = await (await fetch(`${faucet.base}/api/status`)).json();
    assert.equal(s.walletConfigured, false);
    const { status, body } = await postDrip(faucet.base, { address: VALID_TPRL_V1 });
    assert.equal(status, 503);
    assert.equal(body.error, 'faucet wallet not connected');
    assert.ok(!('txid' in body), 'must never return a txid when the wallet is not connected');
  });
});
