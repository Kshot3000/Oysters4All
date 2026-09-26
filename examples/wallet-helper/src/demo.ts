/**
 * Demo: derive Pearl addresses from a BIP-39 mnemonic and query an Oyster wallet.
 *
 * Usage:
 *   PRL_MNEMONIC="word word ... ..." npx tsx src/demo.ts [network] [index]
 *
 * The mnemonic is read from the PRL_MNEMONIC environment variable (never from
 * argv, so it doesn't land in shell history). Defaults to the BIP-86 test
 * mnemonic on testnet — safe to run, derives no real keys.
 */
import {
  deriveAddressFromMnemonic,
  getNetwork,
  isValidPearlAddress,
  OysterClient,
  type NetworkName,
} from './index.js';

const mnemonic =
  process.env.PRL_MNEMONIC ??
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const networkName = (process.argv[2] ?? 'testnet') as NetworkName;
const startIndex = parseInt(process.argv[3] ?? '0', 10);

const network = getNetwork(networkName);
console.log(`network: ${network.name} (hrp=${network.hrp}, coin=${network.coinType})`);
console.log(`path:    m/86'/${network.coinType}'/0'/0/{${startIndex}..${startIndex + 4}}`);
console.log();

for (let i = 0; i < 5; i++) {
  const d = deriveAddressFromMnemonic(mnemonic, { network, index: startIndex + i });
  console.log(`[${i}] ${d.address}`);
  console.log(`     output key: ${d.outputKey}`);
  console.log(`     valid: ${isValidPearlAddress(d.address, network)}`);
}

console.log();
console.log(`Oyster legacy RPC default: 127.0.0.1:${network.oysterLegacyRpcPort} (set OYSTER_USER/OYSTER_PASS to query)`);
if (process.env.OYSTER_USER) {
  const client = new OysterClient({
    network,
    username: process.env.OYSTER_USER,
    password: process.env.OYSTER_PASS,
    insecureTls: true,
  });
  try {
    const [balance, unconfirmed] = await Promise.all([client.getBalance(), client.getUnconfirmedBalance()]);
    console.log(`wallet balance: ${balance} PRL confirmed, ${unconfirmed} PRL unconfirmed`);
  } catch (err) {
    console.log(`wallet query failed: ${(err as Error).message}`);
  }
} else {
  console.log('(skipped wallet query — OYSTER_USER not set)');
}
