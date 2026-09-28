// wPRL bridge operator — main loop.
//
//   Pearl -> Base: poll pearld searchrawtransactions(vault) -> verifyDeposit()
//                  -> bridge.mintDeposit(user, wei, txid)   (OPERATOR_ROLE key)
//   Base -> Pearl: poll WithdrawRequested events -> Oyster sendtoaddress()
//
// Run:  npm start   (reads .env / environment)
// The operator is CUSTODIAL: whoever holds WPRL_OPERATOR_KEY can mint wPRL.
// Protect it like a vault key — env or secret manager, never a file in git.

import { ethers } from "ethers";
import { loadConfig, redactConfig } from "./config.js";
import { RpcClient, RpcError } from "./rpc.js";
import { PearlChain } from "./pearl.js";
import { OysterWallet } from "./oyster.js";
import { verifyDeposit } from "./deposit.js";
import { processWithdrawal, decodeWithdrawEvent } from "./withdraw.js";
import { StateStore } from "./state.js";
import { weiToGrains } from "./convert.js";

// Minimal ABI: only what the operator touches.
const BRIDGE_ABI = [
  "function mintDeposit(address user, uint256 amountWei, bytes32 pearlTxid)",
  "function usedPearlTxids(bytes32) view returns (bool)",
  "function BRIDGE_FEE_BPS() view returns (uint256)",
  "function BPS_DENOMINATOR() view returns (uint256)",
  "function WEI_PER_GRAIN() view returns (uint256)",
  "function feeRecipient() view returns (address)",
  "function wprl() view returns (address)",
  "function totalMinted() view returns (uint256)",
  "function totalBurned() view returns (uint256)",
  "function paused() view returns (bool)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "event WithdrawRequested(address indexed user, string prlRecipient, uint256 netWei, uint256 netGrains, uint256 feeWei, uint256 nonce)",
];

const log = (level, msg, extra = {}) => {
  const line = { ts: new Date().toISOString(), level, msg, ...extra };
  console.log(JSON.stringify(line));
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function createOperator(cfg, deps = {}) {
  const pearld = deps.pearld ?? new PearlChain(new RpcClient(cfg.pearldRpcUrl, { user: cfg.pearldRpcUser, pass: cfg.pearldRpcPass }));
  const oyster = deps.oyster ?? new OysterWallet(new RpcClient(cfg.oysterRpcUrl, { user: cfg.oysterRpcUser, pass: cfg.oysterRpcPass }));
  const provider = deps.provider ?? new ethers.JsonRpcProvider(cfg.baseRpcUrl);
  const wallet = deps.wallet ?? new ethers.Wallet(cfg.operatorKey, provider);
  const bridge = deps.bridge ?? new ethers.Contract(cfg.bridgeAddress, BRIDGE_ABI, wallet);
  const state = deps.state ?? new StateStore(cfg.stateFile);

  return { cfg, pearld, oyster, provider, wallet, bridge, state };
}

/** Startup self-checks. Throws on anything that would make operation unsafe. */
export async function startupChecks(op) {
  const { cfg, pearld, provider, bridge } = op;

  // 1. Base chain identity.
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== cfg.baseChainId) {
    throw new Error(`chain id mismatch: RPC reports ${net.chainId}, config wants ${cfg.baseChainId}`);
  }

  // 2. Contract constants match this operator's config (fee, recipients, token).
  const [feeBps, feeRecipient, wprlAddr, weiPerGrain, paused] = await Promise.all([
    bridge.BRIDGE_FEE_BPS(),
    bridge.feeRecipient(),
    bridge.wprl(),
    bridge.WEI_PER_GRAIN(),
    bridge.paused(),
  ]);
  if (Number(feeBps) !== cfg.feeBps) throw new Error(`fee mismatch: contract ${feeBps} bps vs config ${cfg.feeBps}`);
  if (feeRecipient.toLowerCase() !== cfg.evmFeeAddress.toLowerCase()) {
    throw new Error(`fee recipient mismatch: contract ${feeRecipient} vs config ${cfg.evmFeeAddress}`);
  }
  if (wprlAddr.toLowerCase() !== cfg.tokenAddress.toLowerCase()) {
    throw new Error(`token mismatch: bridge.wprl() ${wprlAddr} vs config ${cfg.tokenAddress}`);
  }
  if (weiPerGrain.toString() !== "10000000000") throw new Error(`WEI_PER_GRAIN mismatch: ${weiPerGrain}`);
  if (paused) throw new Error("bridge is PAUSED — operator refusing to run until unpaused");

  // 3. pearld must have --addrindex (deposit watcher depends on searchrawtransactions).
  try {
    await pearld.searchRawTransactions(cfg.vaultAddress, 0, 0);
  } catch (err) {
    if (err instanceof RpcError && /address index/i.test(err.message)) {
      throw new Error("pearld needs --addrindex (and --txindex) for the deposit watcher — refusing to start");
    }
    throw err;
  }

  // 4. Operator key must hold OPERATOR_ROLE on the bridge (mintDeposit would revert otherwise).
  const operatorRole = ethers.keccak256(ethers.toUtf8Bytes("OPERATOR_ROLE"));
  const canMint = await bridge.hasRole(operatorRole, op.wallet.address).catch((e) => {
    log("warn", "could not check OPERATOR_ROLE (continuing)", { error: e?.message });
    return null;
  });
  if (canMint === false) {
    throw new Error(`operator key ${op.wallet.address} lacks OPERATOR_ROLE on the bridge`);
  }

  log("info", "startup checks passed", {
    chainId: cfg.baseChainId.toString(),
    operator: op.wallet.address,
    vault: cfg.vaultAddress,
  });
}

/** One deposit-scan pass. Returns counts for logging. */
export async function scanDeposits(op) {
  const { cfg, pearld, bridge, state } = op;
  const BATCH = 100;
  let skip = Number(state.get("pearl:skip", 0));
  let scanned = 0, minted = 0, held = 0, skipped = 0, rechecked = 0;

  // 1. Re-check pending (previously too-young) txs by txid. A deposit that was
  //    unconfirmed at first sight must not be forgotten once it confirms.
  const pending = state.get("pearl:pending", {});
  for (const txid of Object.keys(pending)) {
    let tx;
    try {
      tx = await pearld.getRawTransaction(txid, 1);
    } catch (err) {
      // Dropped from mempool / reorged away: give up after 24h of trying.
      if (Date.now() - pending[txid].firstSeen > 24 * 3600 * 1000) {
        log("warn", "dropping pending deposit (tx vanished)", { txid });
        delete pending[txid];
      }
      continue;
    }
    rechecked++;
    const r = await handleDepositTx(op, tx, txid);
    if (r !== "too-young") {
      delete pending[txid];
      if (r === "minted") minted++;
      else if (r === "held") held++;
      else skipped++;
    }
  }
  state.set("pearl:pending", pending);

  // 2. Scan history newest-first (skip-paged; the list only grows at the front,
  //    so paging can't miss entries). Process oldest-first within each batch.
  for (;;) {
    const txs = await pearld.searchRawTransactions(cfg.vaultAddress, skip, BATCH);
    if (!txs || txs.length === 0) break;
    for (const tx of [...txs].reverse()) {
      const txid = tx.txid ?? tx.hash;
      scanned++;
      const r = await handleDepositTx(op, tx, txid);
      if (r === "minted") minted++;
      else if (r === "held") held++;
      else if (r === "too-young") {
        const p = state.get("pearl:pending", {});
        if (!p[txid]) {
          p[txid] = { firstSeen: Date.now() };
          state.set("pearl:pending", p);
        }
      } else skipped++;
    }
    skip += txs.length;
    state.set("pearl:skip", skip);
    if (txs.length < BATCH) break;
  }
  return { scanned, minted, held, skipped, rechecked };
}

/**
 * Handle one decoded deposit-candidate tx.
 * @returns "minted" | "held" | "skipped" | "too-young"
 */
async function handleDepositTx(op, tx, txid) {
  const { cfg, bridge, state } = op;
  const doneKey = `deposit:${txid}`;
  if (state.has(doneKey)) return "skipped";

  const verdict = verifyDeposit(tx, {
    vaultAddress: cfg.vaultAddress,
    prlFeeAddress: cfg.prlFeeAddress,
    minConfirmations: cfg.minConfirmations,
    minDepositGrains: cfg.minDepositGrains,
    feeBps: cfg.feeBps,
  });

  if (!verdict.ok) {
    if (verdict.manualReview) {
      state.set(`review:${txid}`, { reason: verdict.reason, at: new Date().toISOString() });
      state.set(doneKey, { status: "held", reason: verdict.reason });
      log("warn", "deposit held for manual review", { txid, reason: verdict.reason });
      return "held";
    }
    const tooYoung = /insufficient confirmations/.test(verdict.reason);
    if (tooYoung) return "too-young"; // NOT marked done — rechecked via pearl:pending
    state.set(doneKey, { status: "ignored", reason: verdict.reason });
    log("info", "ignoring non-deposit tx", { txid, reason: verdict.reason });
    return "skipped";
  }

  // On-chain replay protection (belt) + local state (suspenders).
  const txidBytes32 = "0x" + txid;
  const used = await bridge.usedPearlTxids(txidBytes32);
  if (used) {
    log("warn", "txid already used on-chain, marking done", { txid });
    state.set(doneKey, { status: "already-minted" });
    return "skipped";
  }
  log("info", "minting wPRL for verified deposit", {
    txid,
    user: verdict.user,
    depositGrains: verdict.depositGrains.toString(),
    feeGrains: verdict.feeGrains.toString(),
  });
  const receipt = await (await bridge.mintDeposit(verdict.user, verdict.mintWei, txidBytes32)).wait();
  state.set(doneKey, {
    status: "minted",
    user: verdict.user,
    depositGrains: verdict.depositGrains.toString(),
    mintWei: verdict.mintWei.toString(),
    baseTx: receipt?.hash,
    at: new Date().toISOString(),
  });
  return "minted";
}

/** One withdrawal-event pass. Returns counts for logging. */
export async function scanWithdrawals(op) {
  const { cfg, bridge, oyster, state, provider } = op;
  const iface = new ethers.Interface(BRIDGE_ABI);
  const fromBlock = Number(state.get("base:lastEventBlock", cfg.deployBlock));
  const latest = await provider.getBlockNumber();
  // Never scan (or advance the cursor into) the freshest blocks: a stale
  // block-number read could otherwise move the cursor past an event block and
  // lose the withdrawal forever. The 2-block margin also absorbs small reorgs;
  // per-nonce idempotency makes the overlap scan harmless.
  const REORG_MARGIN = 2;
  const safeLatest = latest - REORG_MARGIN;
  if (fromBlock > safeLatest) {
    return { events: 0, released: 0, skipped: 0, pendingBlocks: latest - fromBlock + 1 };
  }

  const CHUNK = 2000; // keep RPC queries bounded on public endpoints
  let cursor = fromBlock, events = 0, released = 0, skipped = 0;

  while (cursor <= safeLatest) {
    const to = Math.min(cursor + CHUNK - 1, safeLatest);
    const logs = await bridge.queryFilter(bridge.filters.WithdrawRequested(), cursor, to);
    for (const l of logs) {
      events++;
      const ev = decodeWithdrawEvent(l, iface);
      const res = await processWithdrawal(ev, oyster, state);
      if (res.skipped) {
        skipped++;
        log("info", "withdrawal already processed", { nonce: res.nonce });
      } else {
        released++;
        log("info", "released PRL for burn", {
          nonce: res.nonce,
          prlRecipient: res.prlRecipient,
          netGrains: res.netGrains.toString(),
          pearlTxid: res.pearlTxid,
        });
      }
    }
    cursor = to + 1;
    state.set("base:lastEventBlock", cursor);
  }
  return { events, released, skipped };
}

async function main() {
  const cfg = loadConfig();
  log("info", "wPRL bridge operator starting", redactConfig(cfg));
  const op = await createOperator(cfg);
  await startupChecks(op);

  let stopping = false;
  const stop = () => { stopping = true; };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  // Stagger the two loops so a slow Pearl scan can't starve withdrawals.
  let lastDepositScan = 0, lastWithdrawScan = 0;
  while (!stopping) {
    const now = Date.now();
    try {
      if (now - lastDepositScan >= cfg.pollSeconds * 1000) {
        lastDepositScan = now;
        const r = await scanDeposits(op);
        if (r.minted || r.held) log("info", "deposit scan", r);
      }
      if (now - lastWithdrawScan >= cfg.eventPollSeconds * 1000) {
        lastWithdrawScan = now;
        const r = await scanWithdrawals(op);
        if (r.events) log("info", "withdrawal scan", r);
      }
    } catch (err) {
      log("error", "loop error (will retry)", { error: err?.message ?? String(err) });
    }
    await sleep(5000);
  }
  log("info", "operator stopped");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: "fatal", error: err?.message ?? String(err) }));
    process.exit(1);
  });
}
