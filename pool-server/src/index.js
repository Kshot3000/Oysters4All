#!/usr/bin/env node
/**
 * index.js — pearl-pool entry point.
 *
 * Wires up: template provider (pearld or synthetic demo) -> Pool -> StratumServer
 * (+ optional TLS) + HTTP API. State persists under data/.
 *
 * Config: config.json next to this file (see config.example.json), or
 * PEARL_POOL_CONFIG=/path/to/config.json.
 */
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cpus } from "node:os";

import { Pool } from "./pool.js";
import { StratumServer } from "./stratum.js";
import { ApiServer } from "./api.js";
import { VerifierPool } from "./verifier.js";
import { Payouts } from "./payouts.js";
import { SyntheticProvider, PearldProvider } from "./templates.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.PEARL_POOL_CONFIG || join(ROOT, "..", "config.json");

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    console.error(`[pool] no config at ${CONFIG_PATH} — copy config.example.json to config.json`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
}

const log = (...a) => console.log(new Date().toISOString(), "[pool]", ...a);

async function main() {
  const config = loadConfig();
  mkdirSync(join(ROOT, "..", "data"), { recursive: true });

  // 1. Template provider: live pearld, or synthetic demo headers.
  let provider;
  if (config.template?.mode === "pearld") {
    provider = new PearldProvider({
      url: config.template.url,
      user: config.template.user,
      pass: config.template.pass,
      pollSec: config.template.pollSec || 20,
    });
    log("template source: pearld", config.template.url);
  } else {
    provider = new SyntheticProvider({
      networkDiff: config.template?.networkDiff || 65536,
      startHeight: config.template?.startHeight || 120000,
      certVersion: config.template?.certVersion ?? 3,
    });
    log("template source: SYNTHETIC DEMO (not real blocks)");
  }

  // 2. Verifier workers (real zk-pow verification, one process per worker).
  const verifier = new VerifierPool({
    binary: config.verifier?.binary,
    workers: config.verifier?.workers || Math.max(2, Math.min(8, cpus().length - 1)),
    timeoutMs: config.verifier?.timeoutMs || 60000,
  });

  // 3. PPLNS books.
  const payouts = new Payouts({
    windowShares: config.payouts?.windowShares ?? 1000000,
    poolFeePct: config.payouts?.poolFeePct ?? 1.0,
    finderBonusPct: config.payouts?.finderBonusPct ?? 0.0,
    stateFile: join(ROOT, "..", "data", "payouts.json"),
  });

  // 4. Pool core.
  const pool = new Pool({
    templateProvider: provider,
    verifierPool: verifier,
    payouts,
    networkId: config.networkId || "mainnet",
    initialDiff: config.pool?.initialDiff ?? 2097152,
    minDiff: config.pool?.minDiff ?? 1024,
    maxDiff: config.pool?.maxDiff ?? 2 ** 40,
    vardiffTargetSec: config.pool?.vardiffTargetSec ?? 15,
    jobIntervalSec: config.pool?.jobIntervalSec ?? 25,
    certVersion: config.pool?.certVersion ?? 3,
    onBlock: (c) => log(`BLOCK candidate at height ${c.height} by ${c.finder.slice(0, 16)}... (archived, see README)`),
  });

  // 5. Stratum (+TLS if configured) and the dashboard API.
  const stratum = new StratumServer({
    pool,
    host: config.stratum?.host || "0.0.0.0",
    port: config.stratum?.port || 3333,
    tls: config.stratum?.tls || null,
    networkId: config.networkId || "mainnet",
    log,
  });
  const api = new ApiServer({
    pool, payouts, config,
    host: config.api?.host || "127.0.0.1",
    port: config.api?.port || 8888,
    log,
  });

  const shutdown = async (sig) => {
    log(`received ${sig}, shutting down...`);
    try { await stratum.stop(); } catch { /* ignore */ }
    try { await api.stop(); } catch { /* ignore */ }
    try { await pool.stop(); } catch { /* ignore */ }
    try { payouts.save(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await pool.start();
  await stratum.start();
  await api.start();
  log("pearl-pool up. Stratum miners -> port", config.stratum?.port || 3333);
}

main().catch((e) => { console.error("[pool] fatal:", e); process.exit(1); });
