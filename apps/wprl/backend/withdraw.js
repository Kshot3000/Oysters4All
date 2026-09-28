// Withdrawal processing: Base burn events -> native PRL release.
//
// Flow:
//   1. User calls bridge.requestWithdraw(amountWei, prlRecipient) on Base.
//      The contract takes the 0.25% fee in wPRL (to Kyle's EVM address),
//      burns the net 99.75%, and emits WithdrawRequested(user, prlRecipient,
//      netWei, netGrains, feeWei, nonce).
//   2. The operator polls for WithdrawRequested events from the deploy block.
//   3. For each unprocessed nonce (idempotency via state.json), the operator
//      calls Oyster sendtoaddress(prlRecipient, netGrains) and records the
//      Pearl txid against the nonce.
//
// The contract already validated prlRecipient (`prl1…`); the wallet client
// re-validates before sending. The operator NEVER sends more than the event's
// netGrains.

import { weiToGrains, isValidPrlAddress } from "./convert.js";

export const WITHDRAW_REQUESTED_TOPIC =
  "WithdrawRequested(address,string,uint256,uint256,uint256,uint256)";

/**
 * Decode a WithdrawRequested log into a plain object.
 * Accepts an ethers-parsed log (bridge.filters / contract.queryFilter result).
 */
export function decodeWithdrawEvent(log, iface) {
  const parsed = iface.parseLog(log);
  if (!parsed || parsed.name !== "WithdrawRequested") {
    throw new Error("not a WithdrawRequested event");
  }
  const a = parsed.args;
  return {
    user: a.user,
    prlRecipient: a.prlRecipient,
    netWei: BigInt(a.netWei.toString()),
    netGrains: BigInt(a.netGrains.toString()),
    feeWei: BigInt(a.feeWei.toString()),
    nonce: BigInt(a.nonce.toString()),
    blockNumber: log.blockNumber,
    txHash: log.transactionHash,
  };
}

/** Sanity-check an event before any money moves. Throws on mismatch. */
export function validateWithdrawEvent(ev) {
  if (!isValidPrlAddress(ev.prlRecipient)) {
    throw new Error(`refusing withdrawal ${ev.nonce}: invalid prl recipient ${ev.prlRecipient}`);
  }
  if (ev.netGrains <= 0n) {
    throw new Error(`refusing withdrawal ${ev.nonce}: non-positive net amount`);
  }
  // On-chain invariant: netWei / 1e10 must equal netGrains (truncation-consistent).
  if (weiToGrains(ev.netWei) !== ev.netGrains) {
    throw new Error(
      `refusing withdrawal ${ev.nonce}: netWei/netGrains mismatch ` +
        `(${ev.netWei} wei -> ${weiToGrains(ev.netWei)} grains, event says ${ev.netGrains})`
    );
  }
}

/**
 * Process one withdrawal event: validate, send PRL, record.
 * @param {object} ev        decoded event
 * @param {object} oyster    OysterWallet (or test double with sendToAddress)
 * @param {object} state     StateStore (or test double)
 * @returns {Promise<{nonce, pearlTxid, prlRecipient, netGrains}|{skipped}>}
 */
export async function processWithdrawal(ev, oyster, state) {
  const nonceKey = `withdraw:${ev.nonce}`;
  if (state.has(nonceKey)) {
    return { skipped: true, nonce: ev.nonce.toString(), reason: "already processed" };
  }
  validateWithdrawEvent(ev);
  const pearlTxid = await oyster.sendToAddress(ev.prlRecipient, ev.netGrains);
  state.set(nonceKey, {
    nonce: ev.nonce.toString(),
    prlRecipient: ev.prlRecipient,
    netGrains: ev.netGrains.toString(),
    pearlTxid,
    baseTxHash: ev.txHash,
    processedAt: new Date().toISOString(),
  });
  return {
    nonce: ev.nonce.toString(),
    pearlTxid,
    prlRecipient: ev.prlRecipient,
    netGrains: ev.netGrains,
  };
}
