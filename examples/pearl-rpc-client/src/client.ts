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
  }

  /** Low-level call for methods not wrapped below. */
  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${this.auth}`,
        },
        body: JSON.stringify({ jsonrpc: "1.0", id: ++this.id, method, params }),
      });
    } catch (err) {
      throw new PearlRpcError(
        `Cannot reach pearld at ${this.url}: ${(err as Error).message}. ` +
          `Is the node running with RPC enabled (rpcuser/rpcpass)?`
      );
    }
    if (!res.ok) {
      throw new PearlRpcError(
        `HTTP ${res.status} from pearld: ${(await res.text()).slice(0, 300)}`
      );
    }
    const data = (await res.json()) as { result?: T; error?: RpcErrorShape | null };
    if (data.error) {
      throw new PearlRpcError(
        `RPC error ${data.error.code}: ${data.error.message}`,
        data.error.code
      );
    }
    return data.result as T;
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
