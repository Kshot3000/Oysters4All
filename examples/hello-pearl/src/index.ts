import { basicAuth, readConfig, rpc, rpcEndpoint } from "./lib.js";

const cfg = readConfig(process.env);

if (!cfg.user || !cfg.pass) {
  console.error("Set PEARL_RPCUSER and PEARL_RPCPASS before running.");
  process.exit(1);
}

const endpoint = rpcEndpoint(cfg.host, cfg.port);
const auth = basicAuth(cfg.user, cfg.pass);

async function main() {
  console.log(`Connected to pearld @ ${cfg.host}:${cfg.port}`);
  const blockCount = await rpc<number>(endpoint, auth, "getblockcount", [], 1);
  console.log(`Block count: ${blockCount}`);
  const bestHash = await rpc<string>(endpoint, auth, "getbestblockhash", [], 2);
  console.log(`Best block hash: ${bestHash}`);
}

main().catch((err) => {
  console.error("Failed:", (err as Error).message);
  process.exit(1);
});
