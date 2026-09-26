/** Typed result shapes for the Pearl (pearld) JSON-RPC API.
 *  Fields follow upstream docs: hidden_files/upstream/node/docs/json_rpc_api.md
 *  (btcd-style API; pearld has NO getblockchaininfo — use getinfo). */

export interface NodeInfo {
  version: number;
  protocolversion: number;
  blocks: number;
  timeoffset: number;
  connections: number;
  proxy: string;
  difficulty: number;
  testnet: boolean;
  relayfee: number;
}

export interface BlockVerbose {
  hash: string;
  confirmations: number;
  strippedsize?: number;
  vsize?: number;
  size?: number;
  height: number;
  version: number;
  merkleroot: string;
  /** verbosity=1: transaction hashes */
  tx: string[];
  time: number;
  nonce: number;
  bits: string;
  difficulty: number;
  previousblockhash: string;
  nextblockhash?: string;
}

export interface BlockHeader {
  hash: string;
  confirmations: number;
  height: number;
  version: number;
  merkleroot: string;
  time: number;
  nonce: number;
  bits: string;
  difficulty: number;
  previousblockhash: string;
  nextblockhash?: string;
}

export interface MempoolInfo {
  size: number;
  bytes: number;
}

export interface MiningInfo {
  blocks: number;
  currentblocksize: number;
  currentblocktx: number;
  difficulty: number;
  genproclimit?: number;
  networkhashps: number;
  pooledtx: number;
  testnet: boolean;
  chain: string;
}

export interface RawTransactionVerbose {
  hex: string;
  txid: string;
  version: number;
  locktime: number;
  vin: Array<Record<string, unknown>>;
  vout: Array<Record<string, unknown>>;
  blockhash?: string;
  confirmations?: number;
  time?: number;
  blocktime?: number;
}

export interface ValidateAddressResult {
  isvalid: boolean;
  address?: string;
  ismine?: boolean;
  iswatchonly?: boolean;
  isscript?: boolean;
  script?: string;
  pubkey?: string;
  iscompressed?: boolean;
  account?: string;
}

export interface ChainTip {
  height: number;
  hash: string;
  branchlen: number;
  status: string;
}

export interface PeerInfo {
  addr: string;
  services: string;
  lastsend: number;
  lastrecv: number;
  bytessent: number;
  bytesrecv: number;
  conntime: number;
  version: number;
  subver: string;
  inbound: boolean;
  startingheight: number;
  banscore: number;
}

export interface RpcErrorShape {
  code: number;
  message: string;
}
