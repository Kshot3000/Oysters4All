/** Oyster legacy-RPC client tests against a stub HTTP server. */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  grainsToPrl,
  OysterClient,
  OysterRpcError,
  prlToGrains,
} from '../src/index.js';

describe('PRL ↔ grains conversion', () => {
  it('converts both ways without float error', () => {
    assert.equal(prlToGrains(1), 100_000_000n);
    assert.equal(prlToGrains('0.00000001'), 1n);
    assert.equal(prlToGrains('3229.64'), 322964000000n);
    assert.equal(grainsToPrl(100_000_000n), '1');
    assert.equal(grainsToPrl(1n), '0.00000001');
    assert.equal(grainsToPrl(322964000000n), '3229.64');
  });
});

describe('OysterClient', () => {
  let server: Server;
  let port: number;
  const seen: { method: string; params: unknown[]; auth?: string }[] = [];

  before(
    () =>
      new Promise<void>((resolve) => {
        server = createServer((req: IncomingMessage, res: ServerResponse) => {
          let body = '';
          req.on('data', (c) => (body += c));
          req.on('end', () => {
            const { method, params, id } = JSON.parse(body) as {
              method: string;
              params: unknown[];
              id: number;
            };
            seen.push({ method, params, auth: req.headers.authorization });
            const reply = (result: unknown, error: unknown = null) => {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ result, error, id }));
            };
            if (method === 'getbalance') reply(12.5);
            else if (method === 'listunspent')
              reply([{ txid: 'ab'.repeat(32), vout: 0, address: 'prl1p...', account: 'default', scriptPubKey: '5120' + 'ab'.repeat(32), amount: 12.5, confirmations: 6, spendable: true }]);
            else if (method === 'sendtoaddress') reply('cd'.repeat(32));
            else if (method === 'validateaddress')
              reply({ isvalid: true, ismine: false, iswitness: true, witness_version: 1 });
            else reply(null, { code: -32601, message: 'Method not found' });
          });
        });
        server.listen(0, '127.0.0.1', () => {
          port = (server.address() as { port: number }).port;
          resolve();
        });
      }),
  );

  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const client = () =>
    new OysterClient({ network: 'testnet', host: '127.0.0.1', port, username: 'u', password: 'p', tls: false });

  it('sends JSON-RPC with basic auth and returns the result', async () => {
    const balance = await client().getBalance();
    assert.equal(balance, 12.5);
    const last = seen[seen.length - 1];
    assert.equal(last.method, 'getbalance');
    assert.deepEqual(last.params, ['*', 1]);
    assert.equal(last.auth, 'Basic ' + Buffer.from('u:p').toString('base64'));
  });

  it('passes listunspent filters through', async () => {
    const utxos = await client().listUnspent(2, 100, ['prl1p...']);
    assert.equal(utxos.length, 1);
    assert.equal(utxos[0].amount, 12.5);
    assert.deepEqual(seen[seen.length - 1].params, [2, 100, ['prl1p...']]);
  });

  it('sendtoaddress returns the txid', async () => {
    const txid = await client().sendToAddress('prl1p...', 1.5, 0.0001);
    assert.equal(txid, 'cd'.repeat(32));
  });

  it('validateaddress returns the decoded result', async () => {
    const v = await client().validateAddress('prl1p...');
    assert.equal(v.isvalid, true);
    assert.equal(v.witness_version, 1);
  });

  it('surfaces RPC errors as OysterRpcError', async () => {
    // 'getinfo' is not implemented by the stub → JSON-RPC "Method not found".
    const err = await client().getInfo().then(
      () => null,
      (e) => e as OysterRpcError,
    );
    assert.ok(err instanceof OysterRpcError);
    assert.equal(err.code, -32601);
    assert.match(err.message, /Method not found/);
  });

  it('fails clearly when the wallet is unreachable', async () => {
    const dead = new OysterClient({ network: 'mainnet', host: '127.0.0.1', port: 1, tls: false, timeoutMs: 2000 });
    await assert.rejects(() => dead.getBalance(), /cannot reach Oyster/);
  });

  it('uses the network default legacy RPC port', () => {
    const c = new OysterClient({ network: 'testnet', tls: false });
    assert.equal((c as unknown as { url: string }).url, 'http://127.0.0.1:44209/');
    const m = new OysterClient({ network: 'mainnet', tls: false });
    assert.equal((m as unknown as { url: string }).url, 'http://127.0.0.1:44207/');
  });
});
