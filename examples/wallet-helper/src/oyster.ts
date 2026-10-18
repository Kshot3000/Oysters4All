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

import { Buffer } from 'node:buffer';
import { getNetwork, type NetworkName, type PearlNetwork } from './networks.js';

/** 1 PRL = 100_000_000 grains (smallest unit; cf. btcutil.GrainPerPearl). */
export const GRAINS_PER_PRL = 100_000_000;

export function prlToGrains(prl: number | string): bigint {
  // Exact parser (fleet standard — same shape as the Pearl wallet core and
  // the pool's parsePRL): the old split-and-pad version silently
  // mis-converted malformed amounts instead of refusing them — fractions
  // past 8 decimals were truncated ("0.000000001" became 0 grains,
  // "1.123456789" lost its last digit), extra segments were dropped
  // ("1.5.2" became 1.5 PRL), "" became 0, and "0x10" became 16 PRL via
  // BigInt's hex parsing. A misparse here is a wrong-amount conversion,
  // not a display glitch, so anything that is not a canonical decimal
  // with at most 8 decimal places (1 grain = 0.00000001 PRL) is refused.
  // Number inputs are stringified first, so values whose shortest form
  // is scientific notation (e.g. 1e-8) refuse too — pass a string for
  // grain-exact amounts.
  const s = String(prl).trim();
  const m = /^(-?)(\d+)(?:\.(\d{1,8}))?$/.exec(s);
  if (!m) throw new Error(`prlToGrains: bad amount "${s}"`);
  const grains = BigInt(m[2]) * BigInt(GRAINS_PER_PRL) + BigInt((m[3] || '').padEnd(8, '0'));
  return m[1] ? -grains : grains;
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
  /** response body size cap in bytes. Default MAX_RPC_RESPONSE_BYTES */
  maxResponseBytes?: number;
}

/** Largest RPC response OysterClient will buffer: 16 MiB (the wPRL
 *  backend precedent). The response cap pairs with the whole-call
 *  timeout below: previously the timer was cleared as soon as response
 *  HEADERS arrived, so the body read that followed was unbounded in
 *  both time and size — a malfunctioning or compromised daemon could
 *  stream forever and OOM or hang the caller. */
export const MAX_RPC_RESPONSE_BYTES = 16 * 1024 * 1024;

/** Read a response body with a hard byte cap, streaming so the cap is
 *  enforced as bytes arrive rather than after the whole body buffered.
 *  Falls back to text()+length check for stub responses without a
 *  readable stream body. */
async function readBodyCapped(
  res: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  const body = res.body as ReadableStream<Uint8Array> | null;
  if (!body || typeof body.getReader !== 'function') {
    const text = await res.text();
    if (Buffer.byteLength(text) > maxBytes) {
      throw new Error(`Oyster RPC response exceeded the ${maxBytes}-byte limit`);
    }
    return text;
  }
  const reader = body.getReader();
  // Race each read against the caller's abort: a body stream that never
  // settles (slow-drip daemon, or a fetch implementation that does not
  // tie the stream to the signal) must not outlive the call timeout.
  const abortP = signal
    ? new Promise<never>((_, rej) => {
        if (signal.aborted) rej(new Error('RPC call aborted'));
        else
          signal.addEventListener('abort', () => rej(new Error('RPC call aborted')), {
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
      throw new Error(`Oyster RPC response exceeded the ${maxBytes}-byte limit`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
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
  private readonly maxResponseBytes: number;
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
    this.maxResponseBytes = opts.maxResponseBytes ?? MAX_RPC_RESPONSE_BYTES;
  }

  private async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const body = JSON.stringify({ jsonrpc: '1.0', id: ++this.id, method, params });
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.authHeader) headers.Authorization = this.authHeader;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
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
        if (controller.signal.aborted) {
          throw new Error(`Oyster RPC request to ${this.url} timed out after ${this.timeoutMs} ms`);
        }
        throw new Error(
          `cannot reach Oyster at ${this.url} — is the wallet running with legacy RPC enabled? (${(err as Error).message})`,
        );
      }
      if (!res.ok) {
        throw new Error(`Oyster HTTP ${res.status} ${res.statusText} at ${this.url}`);
      }
      // The timer stays armed until the body is fully read and parsed:
      // clearing it at headers (the old shape) left this read unbounded.
      const text = await readBodyCapped(res, this.maxResponseBytes, controller.signal);
      let json: { result?: T; error?: { code: number; message: string } | null; id: number };
      try {
        json = JSON.parse(text) as typeof json;
      } catch {
        throw new Error(`Oyster at ${this.url} returned a non-JSON response`);
      }
      if (json.error) throw new OysterRpcError(json.error.code, json.error.message);
      return json.result as T;
    } catch (err) {
      if (
        controller.signal.aborted &&
        !/timed out|byte limit/.test((err as Error).message)
      ) {
        throw new Error(`Oyster RPC request to ${this.url} timed out after ${this.timeoutMs} ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
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
