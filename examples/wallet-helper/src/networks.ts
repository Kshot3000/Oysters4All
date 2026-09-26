/**
 * Pearl (PRL) network parameters.
 *
 * Sources (verified 2026-09-26 against upstream mirror
 * pearl-research-labs/pearl @ 3fe2267, master):
 * - Address HRPs:        node/chaincfg/params.go  `Bech32HRPSegwit`
 * - HD coin types:        node/chaincfg/params.go  `HDCoinTypePearl = 808276`,
 *                         `HDCoinTypeTestnet = 1` (all testnets, incl. testnet2,
 *                         regtest and simnet)
 * - pearld RPC/P2P ports: node/params.go, node/config.go
 * - Oyster legacy RPC:    wallet/config.go `LegacyRPCListeners`
 *                         ("default port: 44207, testnet: 44209, testnet2: 44211,
 *                         simnet: 18554, regtest: 18332")
 */

export interface PearlNetwork {
  /** e.g. "mainnet" */
  name: string;
  /** bech32 human-readable part, e.g. "prl" */
  hrp: string;
  /** BIP-44/86 coin type */
  coinType: number;
  /** pearld JSON-RPC port */
  pearldRpcPort: number;
  /** pearld P2P port */
  pearldP2pPort: number;
  /** Oyster wallet legacy JSON-RPC port (wallet/rpc/legacyrpc) */
  oysterLegacyRpcPort: number;
}

export const NETWORKS: Record<string, PearlNetwork> = {
  mainnet: {
    name: 'mainnet',
    hrp: 'prl',
    coinType: 808276,
    pearldRpcPort: 44107,
    pearldP2pPort: 44108,
    oysterLegacyRpcPort: 44207,
  },
  testnet: {
    name: 'testnet',
    hrp: 'tprl',
    coinType: 1,
    pearldRpcPort: 44109,
    pearldP2pPort: 44110,
    oysterLegacyRpcPort: 44209,
  },
  testnet2: {
    name: 'testnet2',
    hrp: 'tprl',
    coinType: 1,
    pearldRpcPort: 44109,
    pearldP2pPort: 44110,
    oysterLegacyRpcPort: 44211,
  },
  regtest: {
    name: 'regtest',
    hrp: 'rprl',
    coinType: 1,
    pearldRpcPort: 44109,
    pearldP2pPort: 44110,
    oysterLegacyRpcPort: 18332,
  },
  simnet: {
    name: 'simnet',
    hrp: 'rprl',
    coinType: 1,
    pearldRpcPort: 44109,
    pearldP2pPort: 44110,
    oysterLegacyRpcPort: 18554,
  },
};

export type NetworkName = keyof typeof NETWORKS;

/** Look up a network by name (case-insensitive) or by address HRP. */
export function getNetwork(nameOrHrp: string): PearlNetwork {
  const key = nameOrHrp.toLowerCase();
  if (key in NETWORKS) return NETWORKS[key];
  const byHrp = Object.values(NETWORKS).find((n) => n.hrp === key);
  if (byHrp) return byHrp;
  throw new Error(
    `unknown Pearl network "${nameOrHrp}" (expected one of: ${Object.keys(NETWORKS).join(', ')}, or an HRP like prl/tprl/rprl)`,
  );
}
