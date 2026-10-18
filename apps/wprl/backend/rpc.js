// Minimal JSON-RPC 2.0 client over HTTP(S) with basic auth.
// Used for both pearld (chain RPC, :44107) and Oyster (wallet RPC).
// pearld's RPC is TLS-enabled by default with a self-signed cert; the operator
// pins the configured CA or connects over localhost per the deployment guide.

import http from "node:http";
import https from "node:https";

// Hard cap on one RPC response body. The largest legitimate replies this
// client consumes (verbose blocks, listsinceblocks for the deposit
// scanner) are far below this; a daemon — or anything answering on its
// port — that streams without ending must not OOM the bridge process.
export const MAX_RPC_RESPONSE_BYTES = 16 * 1024 * 1024;

export class RpcError extends Error {
  constructor(code, message, data) {
    super(`RPC error ${code}: ${message}`);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}

export class RpcClient {
  /**
   * @param {string} url   e.g. "http://127.0.0.1:44107"
   * @param {object} opts  { user, pass, timeoutMs, agentOptions }
   */
  constructor(url, opts = {}) {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      throw new Error(`unsupported RPC protocol: ${u.protocol}`);
    }
    this.url = u;
    this.user = opts.user ?? "";
    this.pass = opts.pass ?? "";
    this.timeoutMs = opts.timeoutMs ?? 15000;
    this.maxResponseBytes =
      Number.isFinite(opts.maxResponseBytes) && opts.maxResponseBytes > 0
        ? Math.floor(opts.maxResponseBytes)
        : MAX_RPC_RESPONSE_BYTES;
    this.agentOptions = opts.agentOptions;
    this.id = 0;
  }

  async call(method, params = []) {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: ++this.id,
      method,
      params,
    });

    const headers = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    };
    if (this.user || this.pass) {
      headers.Authorization =
        "Basic " + Buffer.from(`${this.user}:${this.pass}`).toString("base64");
    }

    const lib = this.url.protocol === "https:" ? https : http;
    const options = {
      hostname: this.url.hostname,
      port: this.url.port,
      path: this.url.pathname || "/",
      method: "POST",
      headers,
      timeout: this.timeoutMs,
      ...(this.agentOptions ? { agent: new (lib.Agent)(this.agentOptions) } : {}),
    };

    const text = await new Promise((resolve, reject) => {
      const req = lib.request(options, (res) => {
        let data = "";
        let bytes = 0;
        let settled = false;
        res.on("data", (c) => {
          if (settled) return;
          bytes += c.length;
          if (bytes > this.maxResponseBytes) {
            settled = true;
            res.destroy();
            reject(new RpcError(-32000, `RPC response exceeded the ${this.maxResponseBytes}-byte limit`));
            return;
          }
          data += c;
        });
        res.on("end", () => {
          if (settled) return;
          settled = true;
          if (res.statusCode === 401 || res.statusCode === 403) {
            reject(new RpcError(-32000, `RPC auth failed (HTTP ${res.statusCode})`));
            return;
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new RpcError(-32000, `HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
            return;
          }
          resolve(data);
        });
      });
      req.on("timeout", () => req.destroy(new Error("RPC request timed out")));
      req.on("error", reject);
      req.write(body);
      req.end();
    });

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new RpcError(-32700, `invalid JSON response: ${text.slice(0, 200)}`);
    }
    if (json.error) {
      throw new RpcError(json.error.code ?? -32000, json.error.message ?? "unknown error", json.error.data);
    }
    return json.result;
  }
}
