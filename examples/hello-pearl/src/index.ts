import { Buffer } from "node:buffer";

const HOST = process.env.PEARL_RPCHOST ?? "localhost";
const PORT = process.env.PEARL_RPCPORT ?? "44107";
const USER = process.env.PEARL_RPCUSER ?? "";
const PASS = process.env.PEARL_RPCPASS ?? "";

if (!USER || !PASS) {
  console.error("Set PEARL_RPCUSER and PEARL_RPCPASS before running.");
  process.exit(1);
}

const auth = Buffer.from(`${USER}:${PASS}`).toString("base64");

let id = 0;

/** Minimal JSON-RPC call to pearld. */
async function rpc<T>(method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(`http://${HOST}:${PORT}/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${auth}`,
    },
    body: JSON.stringify({ jsonrpc: "1.0", id: ++id, method, params }),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as { result?: T; error?: unknown };
  if (data.error) {
    throw new Error(`RPC error: ${JSON.stringify(data.error)}`);
  }
  return data.result as T;
}

async function main() {
  console.log(`Connected to pearld @ ${HOST}:${PORT}`);
  const blockCount = await rpc<number>("getblockcount");
  console.log(`Block count: ${blockCount}`);
  const bestHash = await rpc<string>("getbestblockhash");
  console.log(`Best block hash: ${bestHash}`);
}

main().catch((err) => {
  console.error("Failed:", (err as Error).message);
  process.exit(1);
});
