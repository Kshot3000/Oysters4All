// Operator configuration: env-driven, validated, no hardcoded secrets.
//
// Load order: process.env, then .env in the backend dir (simple KEY=VALUE parser,
// no external dependency). Missing required values throw with a clear message.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isValidPrlAddress, isValidEvmAddress } from "./convert.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Minimal .env loader: KEY=VALUE lines, ignores comments/blank lines, no interpolation. */
export function loadEnvFile(file = path.join(__dirname, ".env")) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
  const out = {};
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function str(env, key, fallback = "") {
  const v = env[key];
  return v === undefined || v === "" ? fallback : v;
}

function int(env, key, fallback) {
  const raw = str(env, key, "");
  if (raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`WPRL config: ${key} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  return n;
}

function required(env, key) {
  const v = str(env, key, "");
  if (!v) throw new Error(`WPRL config: ${key} is required (see .env.example)`);
  return v;
}

export function loadConfig(overrides = {}) {
  const fileEnv = loadEnvFile();
  const env = { ...fileEnv, ...process.env, ...overrides };

  const cfg = {
    // Base chain
    baseRpcUrl: required(env, "WPRL_BASE_RPC_URL"),
    bridgeAddress: required(env, "WPRL_BRIDGE_ADDRESS"),
    tokenAddress: required(env, "WPRL_TOKEN_ADDRESS"),
    baseChainId: int(env, "WPRL_BASE_CHAIN_ID", 11155111),
    deployBlock: int(env, "WPRL_DEPLOY_BLOCK", -1),
    operatorKey: required(env, "WPRL_OPERATOR_KEY"),

    // Pearl chain
    pearldRpcUrl: str(env, "WPRL_PEARLD_RPC_URL", "http://127.0.0.1:44107"),
    pearldRpcUser: str(env, "WPRL_PEARLD_RPC_USER", ""),
    pearldRpcPass: str(env, "WPRL_PEARLD_RPC_PASS", ""),

    // Oyster wallet
    oysterRpcUrl: str(env, "WPRL_OYSTER_RPC_URL", "http://127.0.0.1:44207"),
    oysterRpcUser: str(env, "WPRL_OYSTER_RPC_USER", ""),
    oysterRpcPass: str(env, "WPRL_OYSTER_RPC_PASS", ""),
    vaultAddress: required(env, "WPRL_VAULT_ADDRESS"),

    // Economics
    minConfirmations: int(env, "WPRL_MIN_CONFIRMATIONS", 6),
    feeBps: int(env, "WPRL_FEE_BPS", 25),
    prlFeeAddress: str(env, "WPRL_PRL_FEE_ADDRESS", "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d"),
    evmFeeAddress: str(env, "WPRL_EVM_FEE_ADDRESS", "0x4b6f3BC697D9dAF3e8dE182aEc56eD208B9087f1"),
    minDepositGrains: BigInt(int(env, "WPRL_MIN_DEPOSIT_GRAINS", 100000)),

    // Behavior
    pollSeconds: int(env, "WPRL_POLL_SECONDS", 60),
    eventPollSeconds: int(env, "WPRL_EVENT_POLL_SECONDS", 30),
    stateFile: str(env, "WPRL_STATE_FILE", "./state.json"),
    apiPort: int(env, "WPRL_API_PORT", 8080),
  };

  // ---- validation ----
  if (!isValidEvmAddress(cfg.bridgeAddress)) throw new Error(`WPRL config: WPRL_BRIDGE_ADDRESS is not a valid EVM address`);
  if (!isValidEvmAddress(cfg.tokenAddress)) throw new Error(`WPRL config: WPRL_TOKEN_ADDRESS is not a valid EVM address`);
  if (!isValidEvmAddress(cfg.evmFeeAddress)) throw new Error(`WPRL config: WPRL_EVM_FEE_ADDRESS is not a valid EVM address`);
  if (!isValidPrlAddress(cfg.vaultAddress)) throw new Error(`WPRL config: WPRL_VAULT_ADDRESS must be a prl1… address`);
  if (!isValidPrlAddress(cfg.prlFeeAddress)) throw new Error(`WPRL config: WPRL_PRL_FEE_ADDRESS must be a prl1… address`);
  if (cfg.deployBlock < 0) throw new Error(`WPRL config: WPRL_DEPLOY_BLOCK is required (event scan start)`);
  if (!/^0x[0-9a-fA-F]{64}$/.test(cfg.operatorKey)) {
    throw new Error(`WPRL config: WPRL_OPERATOR_KEY must be a 0x-prefixed 32-byte hex key`);
  }
  if (cfg.baseChainId === 8453) {
    // Hard guard: mainnet deploys need Kyle's explicit written go-ahead.
    const ok = str(env, "WPRL_MAINNET_APPROVED", "") === "kyle-approved";
    if (!ok) {
      throw new Error(
        "WPRL config: refusing Base MAINNET (chain 8453) without Kyle's written approval " +
          "(set WPRL_MAINNET_APPROVED=kyle-approved only after his explicit go-ahead)"
      );
    }
  }

  return cfg;
}

/** Never log the raw config object — the operator key is in it.
 *  BigInts are stringified so the result is always JSON-safe. */
export function redactConfig(cfg) {
  const { operatorKey, pearldRpcPass, oysterRpcPass, ...rest } = cfg;
  const safe = JSON.parse(
    JSON.stringify(rest, (_, v) => (typeof v === "bigint" ? v.toString() : v))
  );
  return {
    ...safe,
    operatorKey: "<redacted>",
    pearldRpcPass: pearldRpcPass ? "<set>" : "<empty>",
    oysterRpcPass: oysterRpcPass ? "<set>" : "<empty>",
  };
}
