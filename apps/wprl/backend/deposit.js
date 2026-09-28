// Deposit verification: Pearl chain -> wPRL mint authorization.
//
// DEPOSIT PROTOCOL (documented for users in docs/deposit-protocol.md):
//   A deposit tx MUST have:
//     1. One or more outputs to the operator's vault address, total D grains.
//     2. A separate output to the PRL fee address of >= ceil(D * 0.25%) grains.
//     3. An OP_RETURN (nulldata) output carrying `wprl:<evm-address>` in UTF-8,
//        telling the operator where to mint the wPRL.
//   The tx must have >= minConfirmations confirmations.
//
// verifyDeposit() is pure: it takes a verbose decoded tx (as returned by
// pearld getrawtransaction/searchrawtransactions) and returns a verdict.
// The operator then checks on-chain replay protection (usedPearlTxids) and
// calls bridge.mintDeposit(user, D * 1e10 wei, txid).

import {
  prlValueToGrains,
  grainsToWei,
  depositFeeGrains,
  isValidPrlAddress,
  isValidEvmAddress,
} from "./convert.js";

/** Extract the wPRL mint destination from an OP_RETURN output, or null. */
export function parseOpReturnDestination(vout) {
  const spk = vout?.scriptPubKey ?? {};
  if (spk.type !== "nulldata" || typeof spk.hex !== "string") return null;
  let text;
  try {
    // OP_RETURN hex = OP_RETURN opcode + pushdata; the payload is the trailing bytes.
    const bytes = Buffer.from(spk.hex, "hex");
    // Find the UTF-8 payload: strip leading OP_RETURN (0x6a) + push opcode(s).
    let i = 0;
    if (bytes[i] !== 0x6a) return null;
    i++;
    const push = bytes[i];
    if (push <= 0x4b) i++; // direct push
    else if (push === 0x4c) i += 2; // OP_PUSHDATA1
    else if (push === 0x4d) i += 3; // OP_PUSHDATA2
    else return null;
    text = bytes.subarray(i).toString("utf8");
  } catch {
    return null;
  }
  const m = /^wprl:(0x[0-9a-fA-F]{40})$/.exec(text.trim());
  if (!m) return null;
  return isValidEvmAddress(m[1]) ? m[1] : null;
}

/**
 * @param {object} tx    verbose decoded Pearl tx
 * @param {object} opts  { vaultAddress, prlFeeAddress, minConfirmations, minDepositGrains, feeBps }
 * @returns verdict { ok, txid, user?, depositGrains?, feeGrains?, mintWei?, reason? }
 */
export function verifyDeposit(tx, opts) {
  const {
    vaultAddress,
    prlFeeAddress,
    minConfirmations = 6,
    minDepositGrains = 0n,
    feeBps = 25n,
  } = opts;

  const txid = tx?.txid ?? tx?.hash ?? "unknown";

  if (!tx || !Array.isArray(tx.vout)) {
    return { ok: false, txid, reason: "malformed transaction" };
  }
  const confirmations = Number(tx.confirmations ?? 0);
  if (!Number.isFinite(confirmations) || confirmations < minConfirmations) {
    return {
      ok: false,
      txid,
      reason: `insufficient confirmations (${confirmations} < ${minConfirmations})`,
    };
  }

  let depositGrains = 0n;
  let feeGrains = 0n;
  let user = null;

  for (const vout of tx.vout) {
    const addrs = vout?.scriptPubKey?.addresses ?? [];
    if (addrs.length > 0) {
      let grains;
      try {
        grains = prlValueToGrains(vout.value);
      } catch {
        return { ok: false, txid, reason: `unparseable output value at vout ${vout.n}` };
      }
      if (addrs.includes(vaultAddress)) depositGrains += grains;
      else if (addrs.includes(prlFeeAddress)) feeGrains += grains;
    }
    const dest = parseOpReturnDestination(vout);
    if (dest && !user) user = dest;
  }

  if (depositGrains <= 0n) {
    return { ok: false, txid, reason: "no outputs to the vault address" };
  }
  if (depositGrains < BigInt(minDepositGrains)) {
    return {
      ok: false,
      txid,
      reason: `deposit ${depositGrains} grains below minimum ${minDepositGrains}`,
    };
  }
  if (!user) {
    return {
      ok: false,
      txid,
      reason: "missing or invalid wprl:<evm-address> OP_RETURN — held for manual review",
      manualReview: true,
      depositGrains,
      feeGrains,
    };
  }
  const requiredFee = depositFeeGrains(depositGrains, BigInt(feeBps));
  if (feeGrains < requiredFee) {
    return {
      ok: false,
      txid,
      reason:
        `fee output ${feeGrains} grains to ${prlFeeAddress} below required ` +
        `${requiredFee} grains (0.25% of ${depositGrains}) — held for manual review`,
      manualReview: true,
      depositGrains,
      feeGrains,
      user,
    };
  }

  return {
    ok: true,
    txid,
    user,
    depositGrains,
    feeGrains,
    mintWei: grainsToWei(depositGrains),
  };
}

/** Re-export for convenience. */
export { isValidPrlAddress };
