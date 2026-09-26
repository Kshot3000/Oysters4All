/* Pearl testnet faucet — reference backend. Node.js, zero dependencies.
 *
 * - Serves the static faucet frontend's API: GET /api/status, POST /api/drip
 * - Validates Pearl bech32 segwit addresses (tprl HRP on testnet/testnet2)
 * - Rate-limits: 1 drip per address per DRIP_COOLDOWN_HOURS, plus a rolling
 *   24h DAILY_CAP_PRL across all drips (tracked in STORE_FILE)
 * - Pays out via the Oyster wallet daemon's legacy JSON-RPC `sendtoaddress`
 *   (Oyster listens on 127.0.0.1:44209 testnet / 44211 testnet2 by default —
 *   see Oyster wallet/config.go `LegacyRPCListeners`).
 * - Honest failure modes: without OYSTER_RPC_USER configured it starts but
 *   reports walletConfigured:false and answers drips with HTTP 503. No fake
 *   txids are ever returned.
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

/* ---------- config ---------- */
const CFG = {
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT || 8090),
  network: (process.env.FAUCET_NETWORK || 'testnet').toLowerCase(),
  maxDripPRL: Number(process.env.MAX_DRIP_PRL || 1),
  cooldownHours: Number(process.env.DRIP_COOLDOWN_HOURS || 24),
  dailyCapPRL: Number(process.env.DAILY_CAP_PRL || 100),
  oysterUrl: (process.env.OYSTER_RPC_URL || 'http://127.0.0.1:44209').replace(/\/+$/, ''),
  oysterUser: process.env.OYSTER_RPC_USER || '',
  oysterPass: process.env.OYSTER_RPC_PASS || '',
  corsOrigin: process.env.CORS_ORIGIN || '*',
  storeFile: process.env.STORE_FILE || path.join(process.cwd(), 'drips.json'),
};
if (!['testnet', 'testnet2'].includes(CFG.network)) {
  console.error(`FAUCET_NETWORK must be testnet or testnet2 (got "${CFG.network}")`);
  process.exit(1);
}
const WALLET_CONFIGURED = CFG.oysterUser.length > 0;

/* ---------- bech32m (BIP-350) — same logic as pages/faucet/app.js ----------
 * Pearl addresses are bech32m, witness v1+ only (Taproot, P2MR); v0 rejected.
 * Source: upstream node/btcutil/address.go (decodeSegWitAddress). */
const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32M_CONST = 0x2bc830a3;
function bech32Polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >>> i) & 1) chk ^= GEN[i];
  }
  return chk;
}
function bech32HrpExpand(hrp) {
  const out = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >>> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}
function bech32Decode(addr) {
  if (typeof addr !== 'string') throw new Error('address must be a string');
  const s = addr.trim();
  if (s.length < 8 || s.length > 90) throw new Error('invalid length');
  if (s !== s.toLowerCase() && s !== s.toUpperCase()) throw new Error('mixed case not allowed');
  const lower = s.toLowerCase();
  const pos = lower.lastIndexOf('1');
  if (pos < 1 || pos + 7 > lower.length) throw new Error('missing separator');
  const hrp = lower.slice(0, pos);
  const data = [];
  for (const ch of lower.slice(pos + 1)) {
    const d = BECH32_CHARSET.indexOf(ch);
    if (d === -1) throw new Error('invalid bech32 character');
    data.push(d);
  }
  if (bech32Polymod(bech32HrpExpand(hrp).concat(data)) !== BECH32M_CONST) throw new Error('checksum mismatch (not valid bech32m)');
  const payload = data.slice(0, -6);
  if (payload.length < 1) throw new Error('empty payload');
  const version = payload[0];
  // Pearl rejects witness v0 entirely; only v1+ (Taproot, P2MR).
  if (version < 1 || version > 16) throw new Error('unsupported witness version (Pearl requires v1+)');
  let acc = 0, bits = 0;
  const program = [];
  for (let i = 1; i < payload.length; i++) {
    acc = (acc << 5) | payload[i];
    bits += 5;
    while (bits >= 8) { bits -= 8; program.push((acc >>> bits) & 0xff); }
  }
  if (bits >= 5 || ((acc << (8 - bits)) & 0xff) !== 0) throw new Error('invalid padding');
  if (program.length < 2 || program.length > 40) throw new Error('invalid program length');
  return { hrp, version, program };
}
function validatePearlAddress(addr) {
  // testnet and testnet2 both use the tprl HRP (node/chaincfg/params.go)
  const dec = bech32Decode(addr);
  if (dec.hrp !== 'tprl') throw new Error(`wrong prefix "${dec.hrp}": faucet only serves tprl testnet addresses`);
  return dec;
}

/* ---------- drip store (rate limiting) ---------- */
function loadStore() {
  try {
    const raw = fs.readFileSync(CFG.storeFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.drips)) return parsed;
  } catch { /* missing or corrupt -> start fresh */ }
  return { drips: [] };
}
function saveStore(store) {
  fs.writeFileSync(CFG.storeFile, JSON.stringify(store, null, 2) + '\n');
}
function rateLimitCheck(store, address) {
  const now = Date.now();
  const cooldownMs = CFG.cooldownHours * 3600 * 1000;
  const last = store.drips.filter((d) => d.address.toLowerCase() === address.toLowerCase()).pop();
  if (last && now - last.time < cooldownMs) {
    const waitH = Math.ceil((cooldownMs - (now - last.time)) / 3600000);
    return { ok: false, error: 'rate limited', detail: `this address already received a drip; try again in ~${waitH}h` };
  }
  const dayAgo = now - 24 * 3600 * 1000;
  const spent24h = store.drips.filter((d) => d.time > dayAgo).reduce((s, d) => s + d.amountPRL, 0);
  if (spent24h + CFG.maxDripPRL > CFG.dailyCapPRL) {
    return { ok: false, error: 'daily cap reached', detail: 'faucet daily budget exhausted; try again tomorrow' };
  }
  return { ok: true };
}

/* ---------- Oyster JSON-RPC ---------- */
function oysterRpc(method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '1.0', id: 'faucet', method, params });
    const url = new URL(CFG.oysterUrl);
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    };
    if (CFG.oysterUser) {
      headers.Authorization = 'Basic ' + Buffer.from(`${CFG.oysterUser}:${CFG.oysterPass}`).toString('base64');
    }
    const req = http.request(
      { host: url.hostname, port: url.port || 80, path: url.pathname || '/', method: 'POST', headers, timeout: 15000 },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
            else resolve(parsed.result);
          } catch (e) {
            reject(new Error(`bad RPC response (HTTP ${res.statusCode})`));
          }
        });
      }
    );
    req.on('timeout', () => { req.destroy(new Error('Oyster RPC timed out')); });
    req.on('error', reject);
    req.end(body);
  });
}

/* ---------- HTTP server ---------- */
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': CFG.corsOrigin,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 64 * 1024) req.destroy(new Error('body too large')); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') { sendJson(res, 204, {}); return; }

    if (req.method === 'GET' && req.url === '/api/status') {
      sendJson(res, 200, {
        ok: true,
        network: CFG.network,
        maxDripPRL: CFG.maxDripPRL,
        dripCooldownHours: CFG.cooldownHours,
        dailyCapPRL: CFG.dailyCapPRL,
        walletConfigured: WALLET_CONFIGURED,
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/drip') {
      const body = await readBody(req);
      let payload;
      try { payload = JSON.parse(body); }
      catch { sendJson(res, 400, { ok: false, error: 'invalid JSON body' }); return; }

      const address = (payload.address || '').trim();
      if (!address) { sendJson(res, 400, { ok: false, error: 'address is required' }); return; }
      try { validatePearlAddress(address); }
      catch (e) { sendJson(res, 400, { ok: false, error: 'invalid address', detail: e.message }); return; }

      const store = loadStore();
      const rl = rateLimitCheck(store, address);
      if (!rl.ok) { sendJson(res, 429, { ok: false, error: rl.error, detail: rl.detail }); return; }

      if (!WALLET_CONFIGURED) {
        sendJson(res, 503, {
          ok: false,
          error: 'faucet wallet not connected',
          detail: 'operator has not configured OYSTER_RPC_USER/OYSTER_RPC_PASS; no funds were moved',
        });
        return;
      }

      let txid;
      try {
        txid = await oysterRpc('sendtoaddress', [address, CFG.maxDripPRL]);
      } catch (e) {
        sendJson(res, 502, { ok: false, error: 'payout failed', detail: String(e.message || e) });
        return;
      }
      if (typeof txid !== 'string' || !/^[0-9a-f]{64}$/i.test(txid)) {
        sendJson(res, 502, { ok: false, error: 'payout failed', detail: 'Oyster returned an unexpected result' });
        return;
      }
      store.drips.push({ address, txid, amountPRL: CFG.maxDripPRL, network: CFG.network, time: Date.now() });
      saveStore(store);
      sendJson(res, 200, { ok: true, txid, amountPRL: CFG.maxDripPRL, network: CFG.network });
      return;
    }

    sendJson(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    sendJson(res, 500, { ok: false, error: 'internal error', detail: String(e.message || e) });
  }
});

server.listen(CFG.port, CFG.host, () => {
  console.log(`Pearl faucet backend on http://${CFG.host}:${CFG.port} (network=${CFG.network})`);
  console.log(`  max drip ${CFG.maxDripPRL} tPRL, cooldown ${CFG.cooldownHours}h, daily cap ${CFG.dailyCapPRL} tPRL`);
  console.log(`  Oyster RPC: ${CFG.oysterUrl} — wallet ${WALLET_CONFIGURED ? 'CONFIGURED' : 'NOT configured (drips will 503)'}`);
});
