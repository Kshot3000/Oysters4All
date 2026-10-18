import { Buffer } from "node:buffer";

export interface RpcConfig {
  host: string;
  port: string;
  user: string;
  pass: string;
}

/** Read pearld connection config from the environment (PEARL_RPC*).
 *
 *  Defaults match a local pearld: localhost, mainnet RPC port 44107
 *  (see node/params.go upstream).
 */
export function readConfig(env: Record<string, string | undefined>): RpcConfig {
  return {
    host: env.PEARL_RPCHOST ?? "localhost",
    port: env.PEARL_RPCPORT ?? "44107",
    user: env.PEARL_RPCUSER ?? "",
    pass: env.PEARL_RPCPASS ?? "",
  };
}

/** HTTP Basic auth header value for an rpcuser/rpcpass pair. */
export function basicAuth(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}

/** pearld JSON-RPC endpoint URL. */
export function rpcEndpoint(host: string, port: string | number): string {
  return `http://${host}:${port}/`;
}

/** JSON-RPC 1.0 request body (btcd/pearld style). */
export function rpcBody(method: string, params: unknown[] = [], id = 1): string {
  return JSON.stringify({ jsonrpc: "1.0", id, method, params });
}

export interface RpcResponse<T> {
  result?: T;
  error?: { code?: number; message?: string } | null;
}

/** Unwrap a parsed JSON-RPC response: throw on `error`, return `result`. */
export function parseRpcResponse<T>(data: RpcResponse<T>): T {
  if (data.error) {
    throw new Error(
      `RPC error ${data.error.code ?? "?"}: ${data.error.message ?? "unknown"}`
    );
  }
  return data.result as T;
}

/** Largest RPC response rpc() will buffer: 16 MiB (the wPRL backend
 *  precedent — verbose blocks are the largest legitimate replies).
 *  Every other RPC client in this repo caps its response and times the
 *  whole call out (faucet 15 s / 1 MiB, wPRL 15 s / 16 MiB,
 *  wallet-helper 30 s / 16 MiB); rpc() previously had neither, so a
 *  malfunctioning or compromised daemon could stream forever and OOM
 *  or hang the caller. */
export const MAX_RPC_RESPONSE_BYTES = 16 * 1024 * 1024;

export interface RpcCallOptions {
  /** Whole-call timeout ms (headers AND body). Default 30_000. */
  timeoutMs?: number;
  /** Response body size cap in bytes. Default MAX_RPC_RESPONSE_BYTES. */
  maxResponseBytes?: number;
}

/** Read a response body with a hard byte cap, streaming so the cap is
 *  enforced as bytes arrive rather than after the whole body buffered.
 *  Falls back to text()+length check for stub responses without a
 *  readable stream body. */
async function readBodyCapped(
  res: Response,
  maxBytes: number,
  signal?: AbortSignal
): Promise<string> {
  const body = res.body as ReadableStream<Uint8Array> | null;
  if (!body || typeof body.getReader !== "function") {
    const text = await res.text();
    if (Buffer.byteLength(text) > maxBytes) {
      throw new Error(`RPC response exceeded the ${maxBytes}-byte limit`);
    }
    return text;
  }
  const reader = body.getReader();
  // Race each read against the caller's abort: a body stream that never
  // settles (slow-drip daemon, or a fetch implementation that does not
  // tie the stream to the signal) must not outlive the call timeout.
  const abortP = signal
    ? new Promise<never>((_, rej) => {
        if (signal.aborted) rej(new Error("RPC call aborted"));
        else
          signal.addEventListener("abort", () => rej(new Error("RPC call aborted")), {
            once: true,
          });
      })
    : null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = abortP
      ? await Promise.race([reader.read(), abortP])
      : await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`RPC response exceeded the ${maxBytes}-byte limit`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** One JSON-RPC call against pearld. Uses the global `fetch`, so tests can
 *  stub it (or point `endpoint` at a local stub HTTP server). */
export async function rpc<T>(
  endpoint: string,
  auth: string,
  method: string,
  params: unknown[] = [],
  id = 1,
  opts: RpcCallOptions = {}
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxResponseBytes = opts.maxResponseBytes ?? MAX_RPC_RESPONSE_BYTES;
  // The timeout covers the WHOLE call — headers and body.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: auth },
        body: rpcBody(method, params, id),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(`RPC request to pearld at ${endpoint} timed out after ${timeoutMs} ms`);
      }
      throw new Error(
        `Cannot reach pearld at ${endpoint}: ${(err as Error).message}. ` +
          `Is the node running with RPC enabled (rpcuser/rpcpass)?`
      );
    }
    if (!res.ok) {
      const text = await readBodyCapped(res, maxResponseBytes, controller.signal);
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    const text = await readBodyCapped(res, maxResponseBytes, controller.signal);
    let data: RpcResponse<T>;
    try {
      data = JSON.parse(text) as RpcResponse<T>;
    } catch {
      throw new Error("pearld returned a non-JSON response");
    }
    return parseRpcResponse<T>(data);
  } catch (err) {
    if (controller.signal.aborted && !/timed out|byte limit/.test((err as Error).message)) {
      throw new Error(`RPC request to pearld at ${endpoint} timed out after ${timeoutMs} ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
