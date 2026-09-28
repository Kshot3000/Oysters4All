// Proof-of-reserves HTTP API (no framework — node:http only).
//
//   GET /reserves  -> vault PRL balance (grains) vs wPRL totalSupply (wei),
//                     backing ratio, counters, fee addresses, timestamps.
//   GET /health    -> liveness + dependency reachability.
//
// Run:  npm run api   (WPRL_API_PORT, default 8080)
// This is the data source for the Phase-3 web dashboard. It reports what the
// chains say; it never invents numbers.

import http from "node:http";
import { ethers } from "ethers";
import { loadConfig } from "./config.js";
import { RpcClient } from "./rpc.js";
import { OysterWallet } from "./oyster.js";
import { weiToGrains } from "./convert.js";

const BRIDGE_ABI = [
  "function totalSupply() view returns (uint256)", // on WPRL token
  "function totalMinted() view returns (uint256)",
  "function totalBurned() view returns (uint256)",
  "function BRIDGE_FEE_BPS() view returns (uint256)",
];

export function createApi(deps) {
  const { cfg, oyster, provider } = deps;
  // Contracts are injectable so tests can pass doubles (ethers.Contract needs a
  // real provider, which unit tests don't have).
  const token =
    deps.token ??
    new ethers.Contract(cfg.tokenAddress, ["function totalSupply() view returns (uint256)"], provider);
  const bridge = deps.bridge ?? new ethers.Contract(cfg.bridgeAddress, BRIDGE_ABI, provider);

  async function getReserves() {
    const checkedAt = new Date().toISOString();
    const [vaultGrains, totalSupplyWei, totalMinted, totalBurned, feeBps] = await Promise.all([
      oyster.getBalanceGrains(1),
      token.totalSupply(),
      bridge.totalMinted(),
      bridge.totalBurned(),
      bridge.BRIDGE_FEE_BPS(),
    ]);
    const supplyGrains = weiToGrains(BigInt(totalSupplyWei.toString()));
    // Backing ratio in basis points: 10000 = exactly 1:1. Reported as a number
    // with 2 decimals in `backingRatioPct`.
    const backingBps = supplyGrains === 0n ? null : Number((vaultGrains * 10000n) / supplyGrains);
    return {
      checkedAt,
      pearlChain: {
        vaultAddress: cfg.vaultAddress,
        vaultBalanceGrains: vaultGrains.toString(),
        vaultBalancePrl: `${vaultGrains / 100000000n}.${(vaultGrains % 100000000n).toString().padStart(8, "0")}`,
      },
      baseChain: {
        chainId: cfg.baseChainId,
        tokenAddress: cfg.tokenAddress,
        bridgeAddress: cfg.bridgeAddress,
        totalSupplyWei: totalSupplyWei.toString(),
        totalSupplyGrains: supplyGrains.toString(),
        totalMintedWei: totalMinted.toString(),
        totalBurnedWei: totalBurned.toString(),
      },
      backing: {
        // 1:1 target: vault grains should equal supply grains.
        targetGrains: supplyGrains.toString(),
        actualGrains: vaultGrains.toString(),
        backingBps,
        backingRatioPct: backingBps === null ? null : (backingBps / 100).toFixed(2),
        fullyBacked: backingBps !== null && backingBps >= 10000,
      },
      fees: {
        feeBps: Number(feeBps),
        prlFeeAddress: cfg.prlFeeAddress,
        evmFeeAddress: cfg.evmFeeAddress,
      },
    };
  }

  async function getHealth() {
    const out = { ok: true, checkedAt: new Date().toISOString(), deps: {} };
    try {
      await provider.getBlockNumber();
      out.deps.baseRpc = "ok";
    } catch (e) {
      out.deps.baseRpc = `error: ${e.message}`;
      out.ok = false;
    }
    try {
      await oyster.getBalanceGrains(1);
      out.deps.oysterRpc = "ok";
    } catch (e) {
      out.deps.oysterRpc = `error: ${e.message}`;
      out.ok = false;
    }
    return out;
  }

  const server = http.createServer(async (req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(obj, null, 2));
    };
    try {
      if (req.method === "GET" && req.url === "/reserves") return send(200, await getReserves());
      if (req.method === "GET" && req.url === "/health") {
        const h = await getHealth();
        return send(h.ok ? 200 : 503, h);
      }
      return send(404, { error: "not found" });
    } catch (err) {
      return send(500, { error: err?.message ?? String(err) });
    }
  });

  return { server, getReserves, getHealth };
}

async function main() {
  const cfg = loadConfig();
  const provider = new ethers.JsonRpcProvider(cfg.baseRpcUrl);
  const oyster = new OysterWallet(new RpcClient(cfg.oysterRpcUrl, { user: cfg.oysterRpcUser, pass: cfg.oysterRpcPass }));
  const { server } = createApi({ cfg, oyster, provider });
  server.listen(cfg.apiPort, () => {
    console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", msg: `reserves API on :${cfg.apiPort}` }));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err?.message ?? err);
    process.exit(1);
  });
}
