import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { PearlRpcClient, PearlRpcError } from "../src/client.js";

interface SeenCall {
  url: string;
  init: RequestInit;
}

let calls: SeenCall[] = [];
let handler: (url: string, init: RequestInit) => Response | Promise<Response>;
const realFetch = globalThis.fetch;

function ok(result: unknown, id = 1): Response {
  return new Response(JSON.stringify({ result, error: null, id }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  calls = [];
  handler = () => ok(null);
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function lastBody(): { jsonrpc: string; id: number; method: string; params: unknown[] } {
  return JSON.parse(calls[calls.length - 1].init.body as string);
}

function client(opts: Record<string, unknown> = {}) {
  return new PearlRpcClient({ useEnv: false, user: "u", pass: "p", ...opts });
}

describe("constructor", () => {
  it("throws PearlRpcError when credentials are missing", () => {
    assert.throws(
      () => new PearlRpcClient({ useEnv: false }),
      (e) => e instanceof PearlRpcError && /RPC credentials required/.test(e.message)
    );
  });

  it("PearlRpcError carries name and code", () => {
    const e = new PearlRpcError("x", -5);
    assert.equal(e.name, "PearlRpcError");
    assert.equal(e.code, -5);
  });

  it("defaults to http://localhost:44107/ (pearld mainnet RPC)", () => {
    client();
    assert.equal(calls.length, 0); // no calls yet
  });

  it("reads PEARL_RPC* env vars by default", () => {
    process.env.PEARL_RPCHOST = "envhost";
    process.env.PEARL_RPCPORT = "44109";
    process.env.PEARL_RPCUSER = "envu";
    process.env.PEARL_RPCPASS = "envp";
    try {
      const c = new PearlRpcClient();
      return c.getBlockCount().then(() => {
        assert.equal(calls[0].url, "http://envhost:44109/");
        assert.ok(
          (calls[0].init.headers as Record<string, string>).Authorization.startsWith("Basic ")
        );
      });
    } finally {
      delete process.env.PEARL_RPCHOST;
      delete process.env.PEARL_RPCPORT;
      delete process.env.PEARL_RPCUSER;
      delete process.env.PEARL_RPCPASS;
    }
  });

  it("explicit opts override env; useEnv:false ignores env", () => {
    process.env.PEARL_RPCUSER = "envu";
    process.env.PEARL_RPCPASS = "envp";
    try {
      const c = new PearlRpcClient({ useEnv: false, user: "u", pass: "p" });
      return c.getBlockCount().then(() => {
        const auth = (calls[0].init.headers as Record<string, string>).Authorization;
        assert.equal(auth, `Basic ${Buffer.from("u:p").toString("base64")}`);
      });
    } finally {
      delete process.env.PEARL_RPCUSER;
      delete process.env.PEARL_RPCPASS;
    }
  });
});

describe("call() wire format", () => {
  it("POSTs JSON-RPC 1.0 with method, params and incrementing ids", async () => {
    const c = client({ host: "node.example.com", port: 44109 });
    await c.call("getblockhash", [42]);
    await c.call("getblockcount");
    assert.equal(calls[0].url, "http://node.example.com:44109/");
    assert.equal(calls[0].init.method, "POST");
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers["Content-Type"], "application/json");
    assert.equal(headers.Authorization, `Basic ${Buffer.from("u:p").toString("base64")}`);
    assert.deepEqual(JSON.parse(calls[0].init.body as string), { jsonrpc: "1.0", id: 1, method: "getblockhash", params: [42] });
    assert.deepEqual(JSON.parse(calls[1].init.body as string).id, 2);
  });

  it("defaults params to []", async () => {
    const c = client();
    await c.call("getblockcount");
    assert.deepEqual(lastBody().params, []);
  });
});

describe("call() error handling", () => {
  it("wraps connection failures in a helpful PearlRpcError", async () => {
    handler = () => {
      throw new Error("ECONNREFUSED");
    };
    const c = client();
    await assert.rejects(
      c.getBlockCount(),
      (e) => e instanceof PearlRpcError && /Cannot reach pearld.*RPC enabled/.test(e.message)
    );
  });

  it("throws PearlRpcError with the HTTP status on non-2xx", async () => {
    handler = () => new Response("forbidden", { status: 403 });
    const c = client();
    await assert.rejects(c.getBlockCount(), /HTTP 403.*forbidden/);
  });

  it("throws PearlRpcError carrying the RPC error code", async () => {
    handler = () =>
      new Response(
        JSON.stringify({ result: null, error: { code: -5, message: "Block not found" }, id: 1 }),
        { status: 200 }
      );
    const c = client();
    await assert.rejects(
      c.getBlock("nope"),
      (e) =>
        e instanceof PearlRpcError &&
        e.code === -5 &&
        /RPC error -5: Block not found/.test(e.message)
    );
  });
});

describe("typed wrappers send the right method + params", () => {
  it("getBlockCount", async () => {
    handler = () => ok(123456);
    const c = client();
    assert.equal(await c.getBlockCount(), 123456);
    assert.equal(lastBody().method, "getblockcount");
  });

  it("getBlockByHeight chains getblockhash then getblock", async () => {
    const block = { hash: "ab", height: 42 };
    handler = (url, init) => {
      const body = JSON.parse(init.body as string);
      return ok(body.method === "getblockhash" ? "ab" : block, body.id);
    };
    const c = client();
    assert.deepEqual(await c.getBlockByHeight(42), block);
    assert.equal(calls.length, 2);
    assert.deepEqual(JSON.parse(calls[0].init.body as string), {
      jsonrpc: "1.0",
      id: 1,
      method: "getblockhash",
      params: [42],
    });
    assert.deepEqual(JSON.parse(calls[1].init.body as string), {
      jsonrpc: "1.0",
      id: 2,
      method: "getblock",
      params: ["ab", 1],
    });
  });

  it("getRawTransaction maps verbose to 1/0", async () => {
    handler = () => ok({ txid: "t" });
    const c = client();
    await c.getRawTransaction("t");
    assert.deepEqual(lastBody().params, ["t", 1]);
    await c.getRawTransaction("t", false);
    assert.deepEqual(lastBody().params, ["t", 0]);
  });

  it("sendRawTransaction passes allowHighFees through", async () => {
    handler = () => ok("txid");
    const c = client();
    await c.sendRawTransaction("deadbeef");
    assert.deepEqual(lastBody(), {
      jsonrpc: "1.0",
      id: 1,
      method: "sendrawtransaction",
      params: ["deadbeef", false],
    });
    await c.sendRawTransaction("deadbeef", true);
    assert.deepEqual(JSON.parse(calls[1].init.body as string).params, ["deadbeef", true]);
  });

  it("getBlockHeader, getRawMempool, validateAddress", async () => {
    handler = () => ok(null);
    const c = client();
    await c.getBlockHeader("h");
    assert.deepEqual(lastBody().params, ["h", true]);
    await c.getRawMempool();
    assert.deepEqual(lastBody(), {
      jsonrpc: "1.0",
      id: 2,
      method: "getrawmempool",
      params: [false],
    });
    await c.validateAddress("prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d");
    assert.deepEqual(JSON.parse(calls[2].init.body as string).params, [
      "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d",
    ]);
  });
});
