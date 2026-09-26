import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  basicAuth,
  parseRpcResponse,
  readConfig,
  rpc,
  rpcBody,
  rpcEndpoint,
} from "../src/lib.js";

describe("readConfig", () => {
  it("defaults to localhost mainnet RPC port 44107 with empty creds", () => {
    assert.deepEqual(readConfig({}), {
      host: "localhost",
      port: "44107",
      user: "",
      pass: "",
    });
  });

  it("reads PEARL_RPC* env vars", () => {
    assert.deepEqual(
      readConfig({
        PEARL_RPCHOST: "node.example.com",
        PEARL_RPCPORT: "44109",
        PEARL_RPCUSER: "alice",
        PEARL_RPCPASS: "s3cret",
      }),
      { host: "node.example.com", port: "44109", user: "alice", pass: "s3cret" }
    );
  });
});

describe("request builders", () => {
  it("basicAuth encodes user:pass as base64", () => {
    assert.equal(basicAuth("alice", "s3cret"), "Basic YWxpY2U6czNjcmV0");
  });

  it("rpcEndpoint builds an http URL with trailing slash", () => {
    assert.equal(rpcEndpoint("localhost", "44107"), "http://localhost:44107/");
    assert.equal(rpcEndpoint("node.example.com", 44109), "http://node.example.com:44109/");
  });

  it("rpcBody is JSON-RPC 1.0 with method, params and id", () => {
    const body = JSON.parse(rpcBody("getblockhash", [42], 7));
    assert.deepEqual(body, {
      jsonrpc: "1.0",
      id: 7,
      method: "getblockhash",
      params: [42],
    });
  });

  it("rpcBody defaults to empty params and id 1", () => {
    const body = JSON.parse(rpcBody("getblockcount"));
    assert.deepEqual(body.params, []);
    assert.equal(body.id, 1);
  });
});

describe("parseRpcResponse", () => {
  it("returns result when there is no error", () => {
    assert.equal(parseRpcResponse({ result: 123456, error: null }), 123456);
  });

  it("throws with code and message on RPC error", () => {
    assert.throws(
      () => parseRpcResponse({ error: { code: -5, message: "Block not found" } }),
      /RPC error -5: Block not found/
    );
  });
});

// --- integration: rpc() against a stub pearld over HTTP ---

const seen: { auth?: string; body?: string }[] = [];
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    seen.push({ auth: req.headers.authorization, body: raw });
    const { method } = JSON.parse(raw) as { method: string };
    res.setHeader("Content-Type", "application/json");
    if (method === "getblockcount") {
      res.end(JSON.stringify({ result: 123456, error: null, id: 1 }));
    } else if (method === "getbestblockhash") {
      res.end(
        JSON.stringify({ result: "00".repeat(32), error: null, id: 2 })
      );
    } else if (method === "boom") {
      res.statusCode = 403;
      res.end("forbidden");
    } else {
      res.end(
        JSON.stringify({
          result: null,
          error: { code: -32601, message: "Method not found" },
          id: 1,
        })
      );
    }
  });
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const stubUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
after(() => server.close());

describe("rpc() over HTTP", () => {
  it("posts getblockcount and returns the result", async () => {
    const n = await rpc<number>(stubUrl, "Basic dGVzdA==", "getblockcount", [], 1);
    assert.equal(n, 123456);
    const last = seen[seen.length - 1];
    assert.equal(last.auth, "Basic dGVzdA==");
    const body = JSON.parse(last.body as string);
    assert.equal(body.method, "getblockcount");
    assert.equal(body.jsonrpc, "1.0");
  });

  it("returns getbestblockhash as a string", async () => {
    const h = await rpc<string>(stubUrl, "Basic dGVzdA==", "getbestblockhash", [], 2);
    assert.equal(h, "00".repeat(32));
  });

  it("throws a typed error when pearld reports an RPC error", async () => {
    await assert.rejects(
      rpc(stubUrl, "Basic dGVzdA==", "nosuchmethod", [], 3),
      /RPC error -32601: Method not found/
    );
  });

  it("throws with the HTTP status on non-2xx responses", async () => {
    await assert.rejects(
      rpc(stubUrl, "Basic dGVzdA==", "boom", [], 4),
      /HTTP 403/
    );
  });

  it("throws a helpful error when the node is unreachable", async () => {
    await assert.rejects(
      rpc("http://127.0.0.1:1/", "Basic eA==", "getblockcount"),
      /Cannot reach pearld.*RPC enabled/
    );
  });
});
