// Pearl Node — local CORS relay for pearld JSON-RPC.
// Why this exists: browsers refuse to call pearld directly — pearld sends no
// CORS headers and serves RPC over TLS with a self-signed certificate by
// default. Run this on the same machine as pearld, point the Pearl Node page
// at http://127.0.0.1:44120/rpc (the default), and the page's read-only RPC
// calls get proxied with CORS headers added.
//
// Zero dependencies. Only binds to 127.0.0.1 — never expose this to a LAN
// without adding your own auth: it forwards RPC credentials you configure.
//
// Usage:
//   PEARLD_RPC=http://127.0.0.1:44107 PEARLD_USER=me PEARLD_PASS=secret node relay.mjs
// Environment:
//   PEARLD_RPC   pearld JSON-RPC URL (default http://127.0.0.1:44107)
//   PEARLD_USER  rpcuser (default: empty)
//   PEARLD_PASS  rpcpass (default: empty)
//   RELAY_PORT   listen port (default 44120)
//   PEARLD_NOTLS=1  if you run pearld with --notls (then use http:// URL)
import http from "node:http";
import https from "node:https";

const PEARLD_RPC = process.env.PEARLD_RPC || "http://127.0.0.1:44107";
const PEARLD_USER = process.env.PEARLD_USER || "";
const PEARLD_PASS = process.env.PEARLD_PASS || "";
const PORT = Number(process.env.RELAY_PORT || 44120);

const target = new URL(PEARLD_RPC);
const transport = target.protocol === "https:" ? https : http;

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "pearl-node-relay", upstream: PEARLD_RPC }));
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "POST JSON-RPC to / or /rpc" }));
    return;
  }
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    // Only allow the six read-only methods the console uses.
    let method = "";
    try { method = JSON.parse(body).method || ""; } catch { /* fall through */ }
    const allowed = ["getinfo", "getmininginfo", "getmempoolinfo", "getpeerinfo", "getnettotals", "getchaintips"];
    if (!allowed.includes(method)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `method ${method || "?"} not proxied — read-only relay` }));
      return;
    }
    const headers = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) };
    if (PEARLD_USER) headers["Authorization"] = "Basic " + Buffer.from(`${PEARLD_USER}:${PEARLD_PASS}`).toString("base64");
    const up = transport.request({
      hostname: target.hostname,
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      path: target.pathname || "/",
      method: "POST",
      headers,
      // pearld's default RPC cert is self-signed; the relay runs on the node
      // operator's own machine, so we accept it here (the browser never sees it).
      rejectUnauthorized: false,
    }, (upRes) => {
      res.writeHead(upRes.statusCode || 502, { "Content-Type": "application/json" });
      upRes.pipe(res);
    });
    up.on("error", (e) => {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `upstream unreachable: ${e.message}` }));
    });
    up.end(body);
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`pearl-node-relay listening on http://127.0.0.1:${PORT} -> ${PEARLD_RPC} (read-only methods only)`);
});
