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

/** One JSON-RPC call against pearld. Uses the global `fetch`, so tests can
 *  stub it (or point `endpoint` at a local stub HTTP server). */
export async function rpc<T>(
  endpoint: string,
  auth: string,
  method: string,
  params: unknown[] = [],
  id = 1
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: rpcBody(method, params, id),
    });
  } catch (err) {
    throw new Error(
      `Cannot reach pearld at ${endpoint}: ${(err as Error).message}. ` +
        `Is the node running with RPC enabled (rpcuser/rpcpass)?`
    );
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return parseRpcResponse<T>((await res.json()) as RpcResponse<T>);
}
