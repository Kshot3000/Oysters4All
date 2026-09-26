/** Demo: prints chain status + the latest block using the typed client. */
import { PearlRpcClient } from "./index.js";

async function main() {
  const pearl = new PearlRpcClient(); // reads PEARL_RPC* env vars
  const [height, bestHash, info, difficulty, mempool] = await Promise.all([
    pearl.getBlockCount(),
    pearl.getBestBlockHash(),
    pearl.getInfo(),
    pearl.getDifficulty(),
    pearl.getMempoolInfo(),
  ]);
  console.log(`pearld @ ${info.version} · protocol ${info.protocolversion}`);
  console.log(`network: ${info.testnet ? "testnet" : "mainnet"} · peers: ${info.connections}`);
  console.log(`height: ${height} · difficulty: ${difficulty}`);
  console.log(`best hash: ${bestHash}`);
  console.log(`mempool: ${mempool.size} txs (${mempool.bytes} bytes)`);

  const block = await pearl.getBlock(bestHash);
  console.log(`\nlatest block #${block.height}:`);
  console.log(`  time: ${new Date(block.time * 1000).toISOString()}`);
  console.log(`  txs: ${block.tx.length} · merkle: ${block.merkleroot.slice(0, 32)}…`);
  console.log(`  prev: ${block.previousblockhash.slice(0, 32)}…`);
}

main().catch((err) => {
  console.error("Failed:", (err as Error).message);
  process.exit(1);
});
