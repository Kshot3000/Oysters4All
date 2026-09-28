import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig, loadEnvFile, redactConfig } from "../config.js";

const BASE = {
  WPRL_BASE_RPC_URL: "https://sepolia.base.org",
  WPRL_BRIDGE_ADDRESS: "0x1111111111111111111111111111111111111111",
  WPRL_TOKEN_ADDRESS: "0x2222222222222222222222222222222222222222",
  WPRL_DEPLOY_BLOCK: "100",
  WPRL_OPERATOR_KEY: "0x" + "ab".repeat(32),
  WPRL_VAULT_ADDRESS: "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d",
};

test("loads defaults and validates a complete config", () => {
  const cfg = loadConfig(BASE);
  assert.equal(cfg.baseChainId, 11155111);
  assert.equal(cfg.pearldRpcUrl, "http://127.0.0.1:44107");
  assert.equal(cfg.oysterRpcUrl, "http://127.0.0.1:44207");
  assert.equal(cfg.feeBps, 25);
  assert.equal(cfg.minDepositGrains, 100000n);
  assert.equal(cfg.pollSeconds, 60);
});

test("missing required values throw with the variable name", () => {
  assert.throws(() => loadConfig({}), /WPRL_BASE_RPC_URL/);
  assert.throws(() => loadConfig({ ...BASE, WPRL_BRIDGE_ADDRESS: "" }), /WPRL_BRIDGE_ADDRESS/);
  assert.throws(() => loadConfig({ ...BASE, WPRL_DEPLOY_BLOCK: "" }), /WPRL_DEPLOY_BLOCK/);
});

test("invalid addresses and keys are rejected", () => {
  assert.throws(() => loadConfig({ ...BASE, WPRL_BRIDGE_ADDRESS: "not-an-address" }), /valid EVM address/);
  assert.throws(() => loadConfig({ ...BASE, WPRL_VAULT_ADDRESS: "0x1234" }), /prl1/);
  assert.throws(() => loadConfig({ ...BASE, WPRL_OPERATOR_KEY: "secret" }), /32-byte hex/);
  assert.throws(() => loadConfig({ ...BASE, WPRL_MIN_CONFIRMATIONS: "-1" }), /non-negative integer/);
});

test("Base mainnet is refused without Kyle's explicit approval flag", () => {
  assert.throws(
    () => loadConfig({ ...BASE, WPRL_BASE_CHAIN_ID: "8453" }),
    /refusing Base MAINNET/
  );
  const cfg = loadConfig({ ...BASE, WPRL_BASE_CHAIN_ID: "8453", WPRL_MAINNET_APPROVED: "kyle-approved" });
  assert.equal(cfg.baseChainId, 8453);
});

test("redactConfig never leaks the operator key or RPC passwords", () => {
  const cfg = loadConfig({ ...BASE, WPRL_PEARLD_RPC_PASS: "s3cret", WPRL_OYSTER_RPC_PASS: "s3cret2" });
  const red = redactConfig(cfg);
  const dumped = JSON.stringify(red);
  assert.ok(!dumped.includes("s3cret"));
  assert.ok(!dumped.includes(cfg.operatorKey.slice(2, 10)));
  assert.equal(red.operatorKey, "<redacted>");
});

test("loadEnvFile parses KEY=VALUE and ignores comments", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const f = path.join(os.tmpdir(), `wprl-env-test-${process.pid}.env`);
  fs.writeFileSync(f, "# comment\nA=1\nB=\"two\"\nC='three'\n\nD=\n");
  try {
    const env = loadEnvFile(f);
    assert.equal(env.A, "1");
    assert.equal(env.B, "two");
    assert.equal(env.C, "three");
    assert.equal(env.D, "");
  } finally {
    fs.unlinkSync(f);
  }
  assert.deepEqual(loadEnvFile("/nonexistent-path-xyz.env"), {});
});
