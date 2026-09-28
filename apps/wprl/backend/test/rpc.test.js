import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { RpcClient, RpcError } from "../rpc.js";

/** Spin up a tiny JSON-RPC server with scripted behavior. */
function scriptedServer(handler) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { method, params, id } = JSON.parse(body);
      const reply = (result, error) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result, error }));
      };
      handler({ req, method, params, reply, res });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

test("successful call returns result", async () => {
  const server = await scriptedServer(({ method, reply }) => {
    assert.equal(method, "getblockcount");
    reply(1234567, null);
  });
  try {
    const c = new RpcClient(`http://127.0.0.1:${server.address().port}`);
    assert.equal(await c.call("getblockcount"), 1234567);
  } finally {
    server.close();
  }
});

test("RPC errors surface as RpcError with code", async () => {
  const server = await scriptedServer(({ reply }) => {
    reply(null, { code: -5, message: "No information available about transaction" });
  });
  try {
    const c = new RpcClient(`http://127.0.0.1:${server.address().port}`);
    await assert.rejects(c.call("getrawtransaction", ["deadbeef"]), (e) => {
      assert.ok(e instanceof RpcError);
      assert.equal(e.code, -5);
      return true;
    });
  } finally {
    server.close();
  }
});

test("basic auth is sent when user/pass configured", async () => {
  const server = await scriptedServer(({ req, reply }) => {
    const expected = "Basic " + Buffer.from("rpcuser:s3cret").toString("base64");
    assert.equal(req.headers.authorization, expected);
    reply("ok", null);
  });
  try {
    const c = new RpcClient(`http://127.0.0.1:${server.address().port}`, { user: "rpcuser", pass: "s3cret" });
    assert.equal(await c.call("getblockcount"), "ok");
  } finally {
    server.close();
  }
});

test("HTTP 401 becomes an auth RpcError", async () => {
  const server = await scriptedServer(({ res }) => {
    res.writeHead(401);
    res.end("unauthorized");
  });
  try {
    const c = new RpcClient(`http://127.0.0.1:${server.address().port}`, { user: "u", pass: "wrong" });
    await assert.rejects(c.call("getblockcount"), /auth failed/);
  } finally {
    server.close();
  }
});

test("non-JSON response becomes an RpcError", async () => {
  const server = await scriptedServer(({ res }) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("not json");
  });
  try {
    const c = new RpcClient(`http://127.0.0.1:${server.address().port}`);
    await assert.rejects(c.call("getblockcount"), /invalid JSON/);
  } finally {
    server.close();
  }
});

test("unsupported protocol is rejected at construction", () => {
  assert.throws(() => new RpcClient("ftp://example.com"), /unsupported RPC protocol/);
});
