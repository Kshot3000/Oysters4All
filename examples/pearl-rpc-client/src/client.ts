import { Buffer } from "node:buffer";
import type {
  BlockHeader,
  BlockVerbose,
  ChainTip,
  MempoolInfo,
  MiningInfo,
  NodeInfo,
  PeerInfo,
  RawTransactionVerbose,
  RpcErrorShape,
  ValidateAddressResult,
} from "./types.js";

export * from "./types.js";

export interface PearlRpcOptions {
  host?: string;
  /** Pearl mainnet RPC port is 44107 (see node/params.go upstream). */
  port?: number;
  user?: string;
  pass?: string;
  /** Override from env: PEARL_RPCHOST / PEARL_RPCPORT / PEARL_RPCUSER / PEARL_RPCPASS */
  useEnv?: boolean;
  /** Whole-call timeout ms (headers AND body). Default 30_000. */
  timeoutMs?: number;
  /** Response body size cap in bytes. Default MAX_RPC_RESPONSE_BYTES. */
  maxResponseBytes?: number;
}

/** Largest RPC response this client will buffer: 16 MiB (the wPRL backend
 *  precedent — verbose blocks are the largest legitimate replies). A
 *  malfunctioning or compromised daemon must not be able to stream
 *  forever and OOM or hang the caller: every other RPC client in this
 *  repo caps its response (faucet 1 MiB, wPRL 16 MiB, wallet-helper
 *  16 MiB); this client previously had neither a cap nor a timeout. */
export const MAX_RPC_RESPONSE_BYTES = 16 * 1024 * 1024;

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
      throw new PearlRpcError(`RPC response exceeded the ${maxBytes}-byte limit`);
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
      throw new PearlRpcError(`RPC response exceeded the ${maxBytes}-byte limit`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export class PearlRpcError extends Error {
  code?: number;
  constructor(message: string, code?: number) {
    super(message);
    this.name = "PearlRpcError";
    this.code = code;
  }
}

/** Typed JSON-RPC client for a Pearl (pearld) node.
 *
 *  ```ts
 *  const pearl = new PearlRpcClient({ user: "rpcuser", pass: "rpcpass" });
 *  const height = await pearl.getBlockCount();
 *  const block = await pearl.getBlockByHeight(height);
 *  ```
 */
export class PearlRpcClient {
  private url: string;
  private auth: string;
  private timeoutMs: number;
  private maxResponseBytes: number;
  private id = 0;

  constructor(opts: PearlRpcOptions = {}) {
    const o = opts.useEnv === false ? opts : { ...readEnv(), ...opts };
    const host = o.host ?? "localhost";
    const port = o.port ?? 44107;
    const user = o.user ?? "";
    const pass = o.pass ?? "";
    if (!user || !pass) {
      throw new PearlRpcError(
        "RPC credentials required: pass { user, pass } or set PEARL_RPCUSER / PEARL_RPCPASS"
      );
    }
    this.url = `http://${host}:${port}/`;
    this.auth = Buffer.from(`${user}:${pass}`).toString("base64");
    this.timeoutMs = o.timeoutMs ?? 30_000;
    this.maxResponseBytes = o.maxResponseBytes ?? MAX_RPC_RESPONSE_BYTES;
  }

  /** Low-level call for methods not wrapped below. */
  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    // The timeout covers the WHOLE call — headers and body. Aborting
    // only the fetch would leave a slow-drip body unbounded (the
    // wallet-helper bug this same shape fixes there).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let res: Response;
      try {
        res = await fetch(this.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Basic ${this.auth}`,
          },
          body: JSON.stringify({ jsonrpc: "1.0", id: ++this.id, method, params }),
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted) {
          throw new PearlRpcError(
            `RPC request to pearld at ${this.url} timed out after ${this.timeoutMs} ms`
          );
        }
        throw new PearlRpcError(
          `Cannot reach pearld at ${this.url}: ${(err as Error).message}. ` +
            `Is the node running with RPC enabled (rpcuser/rpcpass)?`
        );
      }
      if (!res.ok) {
        const text = await readBodyCapped(res, this.maxResponseBytes, controller.signal);
        throw new PearlRpcError(`HTTP ${res.status} from pearld: ${text.slice(0, 300)}`);
      }
      const text = await readBodyCapped(res, this.maxResponseBytes, controller.signal);
      let data: { result?: T; error?: RpcErrorShape | null };
      try {
        data = JSON.parse(text) as { result?: T; error?: RpcErrorShape | null };
      } catch {
        throw new PearlRpcError("pearld returned a non-JSON response");
      }
      if (data.error) {
        throw new PearlRpcError(
          `RPC error ${data.error.code}: ${data.error.message}`,
          data.error.code
        );
      }
      return data.result as T;
    } catch (err) {
      if (controller.signal.aborted && !(err instanceof PearlRpcError)) {
        throw new PearlRpcError(
          `RPC request to pearld at ${this.url} timed out after ${this.timeoutMs} ms`
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- chain ----
  getBlockCount(): Promise<number> {
    return this.call<number>("getblockcount");
  }
  getBestBlockHash(): Promise<string> {
    return this.call<string>("getbestblockhash");
  }
  getBlockHash(height: number): Promise<string> {
    return this.call<string>("getblockhash", [height]);
  }
  /** Verbose block (verbosity=1). Pass verbosity=2 for full decoded transactions. */
  getBlock(hash: string, verbosity = 1): Promise<BlockVerbose> {
    return this.call<BlockVerbose>("getblock", [hash, verbosity]);
  }
  async getBlockByHeight(height: number): Promise<BlockVerbose> {
    const hash = await this.getBlockHash(height);
    return this.getBlock(hash);
  }
  getBlockHeader(hash: string, verbose = true): Promise<BlockHeader> {
    return this.call<BlockHeader>("getblockheader", [hash, verbose]);
  }
  getChainTips(): Promise<ChainTip[]> {
    return this.call<ChainTip[]>("getchaintips");
  }
  getDifficulty(): Promise<number> {
    return this.call<number>("getdifficulty");
  }
  getInfo(): Promise<NodeInfo> {
    return this.call<NodeInfo>("getinfo");
  }
  getMiningInfo(): Promise<MiningInfo> {
    return this.call<MiningInfo>("getmininginfo");
  }

  // ---- mempool / transactions ----
  getMempoolInfo(): Promise<MempoolInfo> {
    return this.call<MempoolInfo>("getmempoolinfo");
  }
  getRawMempool(verbose = false): Promise<string[] | Record<string, unknown>> {
    return this.call("getrawmempool", [verbose]);
  }
  getRawTransaction(txid: string, verbose = true): Promise<RawTransactionVerbose> {
    return this.call<RawTransactionVerbose>("getrawtransaction", [txid, verbose ? 1 : 0]);
  }
  decodeRawTransaction(hex: string): Promise<Record<string, unknown>> {
    return this.call("decoderawtransaction", [hex]);
  }
  sendRawTransaction(hex: string, allowHighFees = false): Promise<string> {
    return this.call<string>("sendrawtransaction", [hex, allowHighFees]);
  }

  // ---- network / wallet-adjacent ----
  getConnectionCount(): Promise<number> {
    return this.call<number>("getconnectioncount");
  }
  getPeerInfo(): Promise<PeerInfo[]> {
    return this.call<PeerInfo[]>("getpeerinfo");
  }
  validateAddress(address: string): Promise<ValidateAddressResult> {
    return this.call<ValidateAddressResult>("validateaddress", [address]);
  }
}

function readEnv(): PearlRpcOptions {
  return {
    host: process.env.PEARL_RPCHOST,
    port: process.env.PEARL_RPCPORT ? Number(process.env.PEARL_RPCPORT) : undefined,
    user: process.env.PEARL_RPCUSER,
    pass: process.env.PEARL_RPCPASS,
  };
}
