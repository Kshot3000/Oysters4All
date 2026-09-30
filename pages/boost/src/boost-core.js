/* Pearl Boost core — stuck-transaction accelerator math for PRL.
 *
 * Pure Taproot, no smart contracts (Pearl has none). All crypto (key
 * derivation, BIP-341 digests, Schnorr signing, signature re-verification,
 * vBytes math) is the audited Sign core — imported by the bundle as the
 * `Sign` namespace, never re-implemented here.
 *
 * Policy facts are taken from pearld's mempool source
 * (node/mempool/mempool.go, node/mempool/policy.go):
 *   - MaxRBFSequence = 0xfffffffd: a tx explicitly signals BIP-125
 *     replaceability when ANY input has sequence <= 0xfffffffd. Inherited
 *     signaling applies while an unconfirmed ancestor signals.
 *   - validateReplacement requires: replacement fee RATE strictly greater
 *     than every conflict's fee rate, absolute fee > sum(conflicts fee) +
 *     min-relay fee for its size, <= 100 evicted descendants, no spending
 *     outputs of evicted conflicts, no new unconfirmed inputs.
 *   - DefaultMinRelayTxFee = 1000 grains/kB (~1 grain/vB).
 *
 * Fee units: everything in grains (1 PRL = 1e8 grains). Feerates in
 * grains per virtual byte.
 */

export const MAX_RBF_SEQUENCE = 0xfffffffd; // pearld MaxRBFSequence
export const NON_RBF_SEQUENCE = 0xfffffffe; // "no RBF signal" opt-out
export const FINAL_SEQUENCE = 0xffffffff;
export const MIN_RELAY_PER_KB_GRAINS = 1000; // pearld DefaultMinRelayTxFee
export const DUST_GRAINS = 546; // P2TR dust, matches upstream txrules / pearlpurse
export const MAX_REPLACEMENT_EVICTIONS = 100; // pearld MaxReplacementEvictions

export const BLOCKBOOK_MAINNET = "https://blockbook.pearlresearch.ai";

/* ---------------- RBF signaling ---------------- */

/** True when any input sequence signals explicit BIP-125 replaceability
 *  (pearld: txIn.Sequence <= MaxRBFSequence). Boundary pinned by tests:
 *  0xfffffffd signals, 0xfffffffe and 0xffffffff do not. */
export function signalsRbf(sequences) {
  if (!Array.isArray(sequences) || sequences.length === 0) return false;
  return sequences.some((s) => Number(s) <= MAX_RBF_SEQUENCE);
}

/* ---------------- min-relay fee estimate ---------------- */

/** Mirror of pearld's calcMinRequiredTxRelayFee (node/mempool/policy.go):
 *  fee = floor(size * minRelayTxFee / 1000); if 0, fee = minRelayTxFee.
 *  Kept as an ESTIMATE because it uses vSize in place of serialized size
 *  and assumes the node's default minrelaytxfee — the connected node's
 *  config (RejectReplacement / minrelaytxfee) is what actually decides. */
export function estimateMinRelayFee(vSize, minRelayPerKb = MIN_RELAY_PER_KB_GRAINS) {
  const size = Math.floor(vSize);
  let fee = Math.floor((size * minRelayPerKb) / 1000);
  if (fee === 0 && minRelayPerKb > 0) fee = minRelayPerKb;
  return fee;
}

/* ---------------- package feerate ---------------- */

/** Combined package feerate in grains/vB.
 *  Returns { rate, num, den } where rate = num/den as float. */
export function packageFeeRate(parentFeeGrains, parentVBytes, childFeeGrains, childVBytes) {
  const num = BigInt(parentFeeGrains) + BigInt(childFeeGrains);
  const den = BigInt(parentVBytes) + BigInt(childVBytes);
  if (den <= 0n) throw new Error("package vsize must be positive");
  if (num < 0n) throw new Error("package fee cannot be negative");
  return { rate: Number(num) / Number(den), num, den };
}

/* ---------------- diagnose ---------------- */

/** Normalize a Blockbook /api/v2/tx/{txid} payload into a diagnosis.
 *  vSize preference: tx.vsize > decoded hex > per-input/output estimate
 *  (estimate is flagged). Throws loud, inspectable errors on bad input. */
export function diagnoseTx(bbTx, rawHex = null) {
  if (!bbTx || typeof bbTx !== "object") throw new Error("no tx data — backend gave nothing usable");
  const confirmations = Number(bbTx.confirmations ?? 0);
  const vin = Array.isArray(bbTx.vin) ? bbTx.vin : [];
  const vout = Array.isArray(bbTx.vout) ? bbTx.vout : [];
  const feeGrains = Number(bbTx.fees);
  if (!Number.isSafeInteger(feeGrains) || feeGrains < 0) {
    throw new Error("backend tx has no usable fee field — cannot compute feerate");
  }

  let vSize = null;
  let vSizeSource = null;
  if (bbTx.vsize != null && Number(bbTx.vsize) > 0) {
    vSize = Number(bbTx.vsize);
    vSizeSource = "blockbook";
  } else if (rawHex) {
    vSize = vSizeFromRawHex(rawHex);
    vSizeSource = "decoded raw tx";
  }
  let estimated = false;
  if (vSize == null) {
    // P2TR keypath: 41 vB per input, 43 vB per output, 10 vB overhead —
    // matches the audited keypathTxVBytes() helper exactly.
    vSize = 10 + 41 * vin.length + 43 * vout.length;
    vSizeSource = "estimate (P2TR keypath shape)";
    estimated = true;
  }

  const rate = feeGrains / vSize;
  const sequences = vin.map((i) => Number(i.sequence ?? FINAL_SEQUENCE));
  const rbfSignaled = signalsRbf(sequences);
  const confirmed = confirmations > 0;

  return {
    txid: bbTx.txid || null,
    confirmations,
    confirmed,
    feeGrains,
    vSize,
    vSizeSource,
    vSizeEstimated: estimated,
    feeRate: rate,
    rbfSignaled,
    nIn: vin.length,
    nOut: vout.length,
    sequences,
    vout: vout.map((o) => ({
      n: Number(o.n),
      value: Number(o.value),
      spent: !!o.spent,
      addresses: Array.isArray(o.addresses) ? o.addresses : [],
    })),
    vin: vin.map((i) => ({
      n: Number(i.n),
      txid: i.txid || null,
      vout: i.vout == null ? null : Number(i.vout),
      sequence: Number(i.sequence ?? FINAL_SEQUENCE),
      value: i.value == null ? null : Number(i.value),
      addresses: Array.isArray(i.addresses) ? i.addresses : [],
    })),
  };
}

/** vSize of a raw tx hex (unsigned or signed, witness or not).
 *  weight = baseSize*3 + totalSize; vsize = ceil(weight/4). */
export function vSizeFromRawHex(hex) {
  const bytes = hexToBytesLocal(hex);
  let i = 0;
  const u32 = () => {
    if (i + 4 > bytes.length) throw new Error("truncated tx");
    const v = new DataView(bytes.buffer, bytes.byteOffset + i, 4).getUint32(0, true);
    i += 4;
    return v;
  };
  const varint = () => {
    if (i >= bytes.length) throw new Error("truncated tx");
    const b0 = bytes[i++];
    if (b0 < 0xfd) return b0;
    if (b0 === 0xfd) return u32() & 0xffff;
    if (b0 === 0xfe) return u32();
    throw new Error("64-bit varint not supported");
  };
  const skip = (n) => {
    if (i + n > bytes.length) throw new Error("truncated tx");
    i += n;
  };
  u32(); // version
  let hasWitness = false;
  if (bytes[i] === 0x00 && bytes[i + 1] === 0x01) { hasWitness = true; i += 2; }
  const nIn = varint();
  for (let k = 0; k < nIn; k++) { skip(36); const sl = varint(); skip(sl); u32(); }
  const nOut = varint();
  for (let k = 0; k < nOut; k++) { skip(8); const sl = varint(); skip(sl); }
  // For a witness tx the base stops here (locktime is still base, but the
  // weight formula handles it: base is everything except witness bytes,
  // and locktime is base either way). Compute base without witnesses:
  const baseBeforeWitness = i;
  if (hasWitness) {
    for (let k = 0; k < nIn; k++) { const c = varint(); for (let j = 0; j < c; j++) { const l = varint(); skip(l); } }
  }
  u32(); // locktime
  if (i !== bytes.length) throw new Error("trailing bytes in raw tx");
  const baseSize = hasWitness ? baseBeforeWitness + 4 : bytes.length; // +4 locktime counted as base
  const weight = baseSize * 3 + bytes.length;
  return Math.ceil(weight / 4);
}

function hexToBytesLocal(hex) {
  const h = String(hex).trim();
  if (!/^[0-9a-fA-F]*$/.test(h) || h.length % 2 !== 0 || h.length === 0) {
    throw new Error("invalid tx hex");
  }
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/* ---------------- CPFP planning ---------------- */

/** Plan a child-pays-for-parent transaction.
 *  parentFeeGrains / parentVBytes: the stuck tx (diagnosed).
 *  targetRate: desired PACKAGE feerate in grains/vB.
 *  childVBytes: exact vBytes of the child we will build (1 keypath in,
 *    1 keypath out = keypathTxVBytes(1,1)).
 *  spendValueGrains: value of the stuck output we spend.
 *  Returns { childFee, childOutValue, packageRate, parentFee, parentVBytes,
 *            childVBytes, targetRate } or throws a loud refusal.
 *  childFee = ceil(targetRate * (parentV + childV)) - parentFee.
 *  Refuses when: target <= current effective rate (bump of zero or less),
 *  or the child output would be dust. */
export function planCpfp({ parentFeeGrains, parentVBytes, targetRate, childVBytes, spendValueGrains }) {
  for (const [k, v] of Object.entries({ parentFeeGrains, parentVBytes, targetRate, childVBytes, spendValueGrains })) {
    if (!Number.isFinite(v) || v <= 0) throw new Error(`cpfp: ${k} must be a positive number`);
  }
  if (!Number.isSafeInteger(Math.round(parentFeeGrains)) || !Number.isSafeInteger(Math.round(spendValueGrains))) {
    throw new Error("cpfp: fees/values must be whole grains");
  }
  const packageV = parentVBytes + childVBytes;
  const packageFeeNeeded = Math.ceil(targetRate * packageV);
  const childFee = packageFeeNeeded - parentFeeGrains;
  if (childFee <= 0) {
    throw new Error(
      `cpfp refused: target ${targetRate} gr/vB is already met by the parent alone ` +
      `(parent pays ${parentFeeGrains} grains over ${parentVBytes} vB). No bump possible — raise the target or accept the current rate.`
    );
  }
  const childOut = Math.round(spendValueGrains) - childFee;
  if (childOut < DUST_GRAINS) {
    throw new Error(
      `cpfp refused: child output would be ${childOut} grains — below the ${DUST_GRAINS}-grain P2TR dust floor. ` +
      `The stuck output is too small to carry a ${targetRate} gr/vB package bump.`
    );
  }
  const pkg = packageFeeRate(parentFeeGrains, parentVBytes, childFee, childVBytes);
  return {
    childFee, childOutValue: childOut, childVBytes,
    parentFee: Math.round(parentFeeGrains), parentVBytes,
    targetRate, packageRate: pkg.rate, packageFeeNum: pkg.num, packageFeeDen: pkg.den,
  };
}

/* ---------------- RBF planning ---------------- */

/** Plan a BIP-125 replacement of the stuck tx (same inputs/outputs shape,
 *  fee bumped by trimming the designated fee-source output).
 *  oldFeeGrains / oldVBytes: the stuck tx. targetRate: new feerate (grains/vB),
 *  must STRICTLY exceed the old rate (pearld validateReplacement).
 *  feeSourceValue: current value of the output that absorbs the bump.
 *  Returns plan or throws a loud refusal (pearld rules cited in messages). */
export function planRbf({ oldFeeGrains, oldVBytes, targetRate, feeSourceValue }) {
  for (const [k, v] of Object.entries({ oldFeeGrains, oldVBytes, targetRate, feeSourceValue })) {
    if (!Number.isFinite(v) || v <= 0) throw new Error(`rbf: ${k} must be a positive number`);
  }
  const oldRate = oldFeeGrains / oldVBytes;
  if (!(targetRate > oldRate)) {
    throw new Error(
      `rbf refused: replacement feerate ${targetRate} gr/vB must be STRICTLY greater than the ` +
      `current ${oldRate.toFixed(3)} gr/vB — pearld rejects replacements that do not beat every ` +
      `conflict's fee rate (node/mempool/mempool.go validateReplacement).`
    );
  }
  const newFee = Math.ceil(targetRate * oldVBytes);
  const feeDelta = newFee - oldFeeGrains;
  const minRelay = estimateMinRelayFee(oldVBytes);
  if (newFee <= oldFeeGrains + minRelay) {
    throw new Error(
      `rbf refused: replacement fee ${newFee} grains must exceed old fee ${oldFeeGrains} + min-relay ` +
      `${minRelay} grains (pearld validateReplacement; DefaultMinRelayTxFee = 1000 grains/kB). ` +
      `Raise the target feerate.`
    );
  }
  const newFeeSource = Math.round(feeSourceValue) - feeDelta;
  if (newFeeSource < DUST_GRAINS) {
    throw new Error(
      `rbf refused: trimming ${feeDelta} grains would leave the fee-source output at ${newFeeSource} grains — ` +
      `below the ${DUST_GRAINS}-grain P2TR dust floor. Pick a smaller bump or a larger fee-source output.`
    );
  }
  return {
    oldFee: Math.round(oldFeeGrains), oldVBytes, oldRate,
    targetRate, newFee, feeDelta, newFeeSourceValue: newFeeSource,
    minRelayEstimate: minRelay,
  };
}

/* ---------------- standalone package verifier ---------------- */

/** Rule PROVEN / NOT PROVEN on a claimed package feerate.
 *  parent/child: { feeGrains, vBytes }. claimedRate: grains/vB claimed.
 *  PROVEN when computed package rate >= claimed rate (tiny epsilon for
 *  float dust). Returns the full derivation for display. */
export function verifyPackageClaim(parent, child, claimedRate) {
  if (!Number.isFinite(claimedRate) || claimedRate < 0) throw new Error("claimed feerate must be a non-negative number");
  const pkg = packageFeeRate(parent.feeGrains, parent.vBytes, child.feeGrains, child.vBytes);
  const proven = pkg.rate + 1e-9 >= claimedRate;
  return {
    proven,
    verdict: proven ? "PROVEN" : "NOT PROVEN",
    computedRate: pkg.rate,
    claimedRate,
    num: pkg.num,
    den: pkg.den,
    parentFee: BigInt(parent.feeGrains),
    parentV: BigInt(parent.vBytes),
    childFee: BigInt(child.feeGrains),
    childV: BigInt(child.vBytes),
  };
}

/* ---------------- Blockbook fetch helpers (GET only) ---------------- */

export async function blockbookGet(base, path) {
  const url = base.replace(/\/+$/, "") + path;
  let res;
  try {
    res = await fetch(url, { headers: { accept: "application/json" } });
  } catch (e) {
    throw new Error(`backend unreachable: ${base} — ${e.message || e}. Check the backend URL or your connection.`);
  }
  if (!res.ok) {
    if (res.status === 404) throw new Error(`tx not found on ${base} (404). It may be unpropagated, expired from the mempool, or the txid is wrong.`);
    throw new Error(`backend error ${res.status} on ${base}${path}.`);
  }
  return res.json();
}

export const fetchTxDetail = (base, txid) => blockbookGet(base, `/api/v2/tx/${txid}`);

/** POST a raw tx hex via Blockbook /api/sendtx. Returns the resulting txid. */
export async function broadcastViaBlockbook(base, hex) {
  const url = base.replace(/\/+$/, "") + "/api/sendtx";
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hex }),
    });
  } catch (e) {
    throw new Error(`broadcast failed: backend unreachable (${e.message || e})`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`broadcast rejected (${res.status}): ${body.error || body.message || JSON.stringify(body).slice(0, 200)}`);
  }
  const txid = body.result || body.txid;
  if (!txid) throw new Error("broadcast returned no txid — treat as unconfirmed, do not rebroadcast blindly");
  return String(txid);
}

/** pearld one-liner for manual broadcast (air-gapped fallback). */
export function pearldBroadcastCmd(hex) {
  return `curl -s --user <rpcuser>:<rpcpass> --data-binary '{"jsonrpc":"1.0","id":"boost","method":"sendrawtransaction","params":["${hex}"]}' -H 'content-type: text/plain;' http://127.0.0.1:44107/`;
}
