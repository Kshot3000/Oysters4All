/**
 * Minimal JSON-RPC client for the Oyster wallet daemon's legacy RPC server
 * (wallet/rpc/legacyrpc).
 *
 * Method names, params and result shapes mirror upstream
 * `wallet/rpc/legacyrpc/methods.go` + `rpcserverhelp.go` (verified 2026-09-26
 * @ 3fe2267):
 *   getbalance, getunconfirmedbalance, getnewaddress, listunspent,
 *   getreceivedbyaddress, listreceivedbyaddress, sendtoaddress,
 *   validateaddress, getinfo, walletlock/unlock helpers omitted.
 *
 * Default ports come from wallet/config.go `LegacyRPCListeners`:
 *   mainnet 44207, testnet 44209, testnet2 44211, simnet 18554, regtest 18332.
 * The legacy server speaks HTTP(S) with basic auth (rpcuser/rpcpass from
 * oyster.conf); TLS uses the wallet's rpc.cert (self-signed by default), so
 * certificate verification is opt-out via `insecureTls: true`.
 */

import { getNetwork, type NetworkName, type PearlNetwork } from './networks.js';

/** 1 PRL = 100_000_000 grains (smallest unit; cf. btcutil.GrainPerPearl). */
export const GRAINS_PER_PRL = 100_000_000;

export function prlToGrains(prl: number | string): bigint {
  const [whole, frac = ''] = String(prl).split('.');
  const fracPadded = (frac + '00000000').slice(0, 8);
  const sign = String(prl).trim().startsWith('-') ? -1n : 1n;
  const abs = BigInt(whole.replace('-', '') || '0') * BigInt(GRAINS_PER_PRL) + BigInt(fracPadded);
  return sign * abs;
}

export function grainsToPrl(grains: bigint | number | string): string {
  const g = BigInt(grains);
  const sign = g < 0n ? '-' : '';
  const abs = g < 0n ? -g : g;
  const whole = abs / BigInt(GRAINS_PER_PRL);
  const frac = (abs % BigInt(GRAINS_PER_PRL)).toString().padStart(8, '0').replace(/0+$/, '');
  return sign + whole.toString() + (frac ? '.' + frac : '');
}

export interface OysterClientOptions {
  network: NetworkName | PearlNetwork;
  /** default 127.0.0.1 */
  host?: string;
  /** default: network's oysterLegacyRpcPort */
  port?: number;
  /** rpcuser from oyster.conf */
  username?: string;
  /** rpcpass from oyster.conf */
  password?: string;
  /** use https (Oyster serves TLS by default with rpc.cert). Default true. */
  tls?: boolean;
  /** skip TLS certificate verification (self-signed rpc.cert). Default false. */
  insecureTls?: boolean;
  /** request timeout ms. Default 30_000 */
  timeoutMs?: number;
}

export interface UnspentOutput {
  txid: string;
  vout: number;
  address: string;
  account: string;
  scriptPubKey: string;
  amount: number; // PRL
  confirmations: number;
  spendable: boolean;
}

export interface ValidateAddressResult {
  isvalid: boolean;
  address?: string;
  ismine?: boolean;
  iswatchonly?: boolean;
  isscript?: boolean;
  iswitness?: boolean;
  witness_version?: number;
  witness_program?: string;
  pubkey?: string;
}

export class OysterRpcError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(`Oyster RPC error ${code}: ${message}`);
    this.name = 'OysterRpcError';
    this.code = code;
  }
}

export class OysterClient {
  readonly network: PearlNetwork;
  private readonly url: string;
  private readonly authHeader?: string;
  private readonly insecureTls: boolean;
  private readonly timeoutMs: number;
  private id = 0;

  constructor(opts: OysterClientOptions) {
    this.network = typeof opts.network === 'string' ? getNetwork(opts.network) : opts.network;
    const host = opts.host ?? '127.0.0.1';
    const port = opts.port ?? this.network.oysterLegacyRpcPort;
    const tls = opts.tls ?? true;
    this.url = `${tls ? 'https' : 'http'}://${host}:${port}/`;
    if (opts.username) {
      this.authHeader =
        'Basic ' + Buffer.from(`${opts.username}:${opts.password ?? ''}`, 'utf8').toString('base64');
    }
    this.insecureTls = opts.insecureTls ?? false;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  private async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const body = JSON.stringify({ jsonrpc: '1.0', id: ++this.id, method, params });
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.authHeader) headers.Authorization = this.authHeader;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      // undici (Node's global fetch) accepts a custom dispatcher; use it to
      // allow the wallet's self-signed rpc.cert when insecureTls is set.
      const dispatcher = this.insecureTls
        ? new (await import('node:https')).Agent({ rejectUnauthorized: false })
        : undefined;
      res = await fetch(this.url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
        // @ts-expect-error undici dispatcher for custom TLS handling
        dispatcher,
      });
    } catch (err) {
      clearTimeout(timer);
      throw new Error(
        `cannot reach Oyster at ${this.url} — is the wallet running with legacy RPC enabled? (${(err as Error).message})`,
      );
    }
    clearTimeout(timer);
    if (!res.ok) {
      throw new Error(`Oyster HTTP ${res.status} ${res.statusText} at ${this.url}`);
    }
    const json = (await res.json()) as { result?: T; error?: { code: number; message: string } | null; id: number };
    if (json.error) throw new OysterRpcError(json.error.code, json.error.message);
    return json.result as T;
  }

  /** getbalance ("account" minconf=1) — confirmed balance in PRL. */
  getBalance(account = '*', minconf = 1): Promise<number> {
    return this.call<number>('getbalance', [account, minconf]);
  }

  /** getunconfirmedbalance — unconfirmed balance in PRL. */
  getUnconfirmedBalance(account = '*'): Promise<number> {
    return this.call<number>('getunconfirmedbalance', [account]);
  }

  /** getnewaddress — generate and return a new payment address. */
  getNewAddress(account = 'default'): Promise<string> {
    return this.call<string>('getnewaddress', [account]);
  }

  /** listunspent — UTXOs controlled by the wallet. */
  listUnspent(minconf = 1, maxconf = 9999999, addresses?: string[]): Promise<UnspentOutput[]> {
    const params: unknown[] = [minconf, maxconf];
    if (addresses) params.push(addresses);
    return this.call<UnspentOutput[]>('listunspent', params);
  }

  /** getreceivedbyaddress — total received by an address (minconf=1). */
  getReceivedByAddress(address: string, minconf = 1): Promise<number> {
    return this.call<number>('getreceivedbyaddress', [address, minconf]);
  }

  /** listreceivedbyaddress — per-address received totals. */
  listReceivedByAddress(minconf = 1, includeEmpty = false, includeWatchOnly = false): Promise<unknown[]> {
    return this.call<unknown[]>('listreceivedbyaddress', [minconf, includeEmpty, includeWatchOnly]);
  }

  /**
   * sendtoaddress — author, sign and broadcast a payment.
   * @param address destination Pearl address
   * @param amountPRL amount in PRL (converted to a JSON number as the RPC expects)
   * @param feeRatePerKb fee rate in PRL per kilobyte
   * @returns transaction hash
   */
  sendToAddress(address: string, amountPRL: number, feeRatePerKb: number): Promise<string> {
    return this.call<string>('sendtoaddress', [address, amountPRL, feeRatePerKb]);
  }

  /** validateaddress — decode/validate an address, report wallet ownership. */
  validateAddress(address: string): Promise<ValidateAddressResult> {
    return this.call<ValidateAddressResult>('validateaddress', [address]);
  }

  /** getinfo — wallet/node info snapshot. */
  getInfo(): Promise<Record<string, unknown>> {
    return this.call<Record<string, unknown>>('getinfo');
  }
}
