/**
 * Pearl Rig — local CORS proxy (zero dependencies, Node 18+).
 *
 * Why this exists: the public Pearl blockbook API (blockbook.pearlresearch.ai)
 * sends no `Access-Control-Allow-Origin` headers, so browsers refuse to let a
 * static page read it directly (curl works fine — curl doesn't enforce CORS).
 * CoinGecko's API is CORS-open and works without this proxy.
 *
 * Run:  node proxy.mjs            (listens on http://127.0.0.1:8787)
 * Then in Pearl Rig → PRL price, set the proxy base to:
 *   http://127.0.0.1:8787
 *
 * Routes:
 *   /blockbook/* → https://blockbook.pearlresearch.ai/*
 *   /coinex/*    → https://api.coinex.com/*        (CORS-closed too)
 *   /coingecko/* → https://api.coingecko.com/*     (CORS-open; proxy optional)
 *
 * Everything stays on your machine: the proxy only forwards your own GET
 * requests and adds CORS headers to the responses.
 */
import http from 'node:http';

const PORT = Number(process.env.PORT) || 8787;
const HOST = '127.0.0.1';

const ROUTES = {
  '/blockbook/': 'https://blockbook.pearlresearch.ai',
  '/coinex/': 'https://api.coinex.com',
  '/coingecko/': 'https://api.coingecko.com',
};

const server = http.createServer(async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, OPTIONS');
  res.setHeader('access-control-allow-headers', 'Accept, Content-Type');
  res.setHeader('access-control-max-age', '86400');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method !== 'GET') {
    res.writeHead(405, { 'content-type': 'text/plain' });
    res.end('only GET is proxied');
    return;
  }

  const route = Object.keys(ROUTES).find((p) => req.url === p.slice(0, -1) || req.url.startsWith(p));
  if (!route) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('unknown route — use /blockbook/, /coinex/, or /coingecko/');
    return;
  }
  const target = ROUTES[route] + req.url.slice(route.length - 1);
  try {
    const upstream = await fetch(target, {
      headers: { accept: 'application/json', 'user-agent': 'pearl-pulse-proxy/1.0' },
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') || 'application/json',
    });
    res.end(buf);
    console.log(`${new Date().toISOString()} ${upstream.status} ${req.url}`);
  } catch (e) {
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('proxy upstream error: ' + e.message);
    console.error(`${new Date().toISOString()} 502 ${req.url} — ${e.message}`);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`pearl-pulse proxy listening on http://${HOST}:${PORT}`);
  console.log('  /blockbook/* → https://blockbook.pearlresearch.ai/*');
  console.log('  /coinex/*    → https://api.coinex.com/*');
  console.log('  /coingecko/* → https://api.coingecko.com/*');
});
