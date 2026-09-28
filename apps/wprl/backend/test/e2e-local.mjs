// End-to-end operator test: REAL operator.js code + REAL compiled contracts on a
// local Hardhat chain, with only the Pearl side (pearld/Oyster) faked.
// Proves: startup checks, deposit scan -> mint, withdrawal scan -> PRL release,
// idempotency across re-scans.
import { ethers } from "ethers";
import {
  createOperator, startupChecks, scanDeposits, scanWithdrawals,
} from "../operator.js";
import { StateStore } from "../state.js";
import wprlArtifact from "../../artifacts/contracts/WPRL.sol/WPRL.json" with { type: "json" };
import bridgeArtifact from "../../artifacts/contracts/WPRLBridge.sol/WPRLBridge.json" with { type: "json" };

const VAULT = "prl1vault0000000000000000000000000000000000000000"; // operator vault (distinct from fee addr)
const FEE = "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d"; // Kyle's PRL fee address
const USER_EVM = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"; // hardhat account #1
const PRL_RECIPIENT = "prl1qw9v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zwAA";

function opReturnHex(text) {
  const data = Buffer.from(text, "utf8");
  return "6a" + data.length.toString(16).padStart(2, "0") + data.toString("hex");
}
const depositTxFixture = {
  txid: "cc".repeat(32),
  confirmations: 10,
  vout: [
    { n: 0, value: 2.5, scriptPubKey: { addresses: [VAULT], type: "witness_v0_keyhash" } },
    { n: 1, value: 0.00625, scriptPubKey: { addresses: [FEE], type: "witness_v0_keyhash" } },
    { n: 2, value: 0, scriptPubKey: { hex: opReturnHex(`wprl:${USER_EVM}`), type: "nulldata" } },
  ],
};

// --- fakes for the Pearl side only ---
const fakePearld = {
  searchRawTransactions: async (addr, skip, count) => (count === 0 ? [] : [depositTxFixture]),
};
const oysterCalls = [];
const fakeOyster = {
  sendToAddress: async (addr, grains) => { oysterCalls.push([addr, grains]); return "pearl-release-txid"; },
};

const operatorKey = "0x" + "ac".repeat(32); // distinct key
const provider = new ethers.JsonRpcProvider("http://127.0.0.1:8546");
// Hardhat's default in-process accounts (mnemonic "test test ... junk").
const mnemonic = "test test test test test test test test test test test junk";
const deployerBase = ethers.HDNodeWallet.fromMnemonic(
  ethers.Mnemonic.fromPhrase(mnemonic), "m/44'/60'/0'/0/0"
).connect(provider);
// NonceManager: serialize nonces locally — ethers v6 + Hardhat automine can
// otherwise reuse a stale nonce on rapid sequential deploys.
const deployer = new ethers.NonceManager(deployerBase);
const DEPLOYER_ADDR = await deployer.getAddress();
const userBase = ethers.HDNodeWallet.fromMnemonic(
  ethers.Mnemonic.fromPhrase(mnemonic), "m/44'/60'/0'/0/1"
).connect(provider);
const user = new ethers.NonceManager(userBase);
const deployBlock = await provider.getBlockNumber();

const wprl = await new ethers.ContractFactory(wprlArtifact.abi, wprlArtifact.bytecode, deployer)
  .deploy(DEPLOYER_ADDR);
await wprl.waitForDeployment();
const bridge = await new ethers.ContractFactory(bridgeArtifact.abi, bridgeArtifact.bytecode, deployer)
  .deploy(await wprl.getAddress(), DEPLOYER_ADDR, "0x4b6f3BC697D9dAF3e8dE182aEc56eD208B9087f1");
await bridge.waitForDeployment();
await (await wprl.grantRole(await wprl.MINTER_ROLE(), await bridge.getAddress())).wait();

try { (await import("node:fs")).unlinkSync("/tmp/wprl-e2e-state.json"); } catch {}
const state = new StateStore("/tmp/wprl-e2e-state.json");
const cfg = {
  baseRpcUrl: "http://127.0.0.1:8546",
  bridgeAddress: await bridge.getAddress(),
  tokenAddress: await wprl.getAddress(),
  baseChainId: 31337,
  deployBlock,
  operatorKey,
  pearldRpcUrl: "http://127.0.0.1:9", pearldRpcUser: "", pearldRpcPass: "",
  oysterRpcUrl: "http://127.0.0.1:9", oysterRpcUser: "", oysterRpcPass: "",
  vaultAddress: VAULT,
  minConfirmations: 6,
  feeBps: 25,
  prlFeeAddress: FEE,
  evmFeeAddress: "0x4b6f3BC697D9dAF3e8dE182aEc56eD208B9087f1",
  minDepositGrains: 100000n,
  pollSeconds: 60, eventPollSeconds: 30,
  stateFile: "/tmp/wprl-e2e-state.json",
  apiPort: 18082,
};

const op = await createOperator(cfg, { pearld: fakePearld, oyster: fakeOyster, provider, state });
// Fund the operator key for gas (in production the operator wallet is kept funded).
await (await deployer.sendTransaction({ to: op.wallet.address, value: ethers.parseEther("1") })).wait();
// NOTE: op.wallet is derived from operatorKey (0xacac...) which has NO role;
// grant it OPERATOR_ROLE like the real deployment runbook does.
await (await bridge.grantRole(ethers.keccak256(ethers.toUtf8Bytes("OPERATOR_ROLE")), op.wallet.address)).wait();

await startupChecks(op);
console.log("E2E: startup checks passed");

// --- deposit leg ---
const d1 = await scanDeposits(op);
console.log("E2E: deposit scan 1 ->", JSON.stringify(d1, (_, v) => typeof v === "bigint" ? v.toString() : v));
const bal = await wprl.balanceOf(USER_EVM);
console.log("E2E: user wPRL balance =", bal.toString(), "(expect 2500000000000000000)");
if (bal !== 2_500_000_000_000_000_000n) throw new Error("MINT AMOUNT WRONG");

const d2 = await scanDeposits(op); // re-scan: must be idempotent
console.log("E2E: deposit scan 2 (idempotency) ->", JSON.stringify(d2));
if (d2.minted !== 0) throw new Error("DOUBLE MINT!");

// --- withdrawal leg --- (user = hardhat account #1, derived above)
const bridgeAsUser = new ethers.Contract(await bridge.getAddress(), bridgeArtifact.abi, user);
await (await wprl.connect(user).approve(await bridge.getAddress(), 2_500_000_000_000_000_000n)).wait();
const wr = await (await bridgeAsUser.requestWithdraw(1_000_000_000_000_000_000n, PRL_RECIPIENT)).wait();
console.log("E2E: requestWithdraw receipt status =", wr.status, "block =", wr.blockNumber, "logs =", wr.logs.length);
// Direct event query sanity check (bypasses scanWithdrawals):
const direct = await new ethers.Contract(await bridge.getAddress(), bridgeArtifact.abi, provider)
  .queryFilter("WithdrawRequested", deployBlock, "latest");
console.log("E2E: direct WithdrawRequested query ->", direct.length, "events");
// Mine past the operator's 2-block reorg margin so the event becomes scannable.
await provider.send("hardhat_mine", ["0x3"]);
const w1 = await scanWithdrawals(op);
console.log("E2E: withdrawal scan 1 ->", JSON.stringify(w1, (_, v) => typeof v === "bigint" ? v.toString() : v));
console.log("E2E: oyster calls =", JSON.stringify(oysterCalls, (_, v) => typeof v === "bigint" ? v.toString() : v));
if (oysterCalls.length !== 1 || oysterCalls[0][0] !== PRL_RECIPIENT || oysterCalls[0][1] !== 99750000n) {
  throw new Error("WITHDRAWAL RELEASE WRONG");
}
const w2 = await scanWithdrawals(op); // re-scan: must not double-send
console.log("E2E: withdrawal scan 2 (idempotency) ->", JSON.stringify(w2));
if (oysterCalls.length !== 1) throw new Error("DOUBLE SEND!");

const supply = await wprl.totalSupply();
// 2.5 minted - 0.9975 burned = 1.5025 (the 0.0025 wPRL fee stays in supply, paid to the fee recipient)
console.log("E2E: final totalSupply =", supply.toString(), "(expect 1502500000000000000)");
if (supply !== 1_502_500_000_000_000_000n) throw new Error("SUPPLY WRONG");
const feeBal = await wprl.balanceOf("0x4b6f3BC697D9dAF3e8dE182aEc56eD208B9087f1");
console.log("E2E: fee recipient wPRL =", feeBal.toString(), "(expect 2500000000000000)");
if (feeBal !== 2_500_000_000_000_000n) throw new Error("FEE WRONG");
console.log("E2E: ALL CHECKS PASSED");
process.exit(0);
