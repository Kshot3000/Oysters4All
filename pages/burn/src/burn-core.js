/* Pearl Burn core — provable-burn desk for PRL.
 *
 * Pure ESM, zero build step for developers. The browser ships a committed
 * esbuild IIFE bundle (pearl-burn.bundle.js); node runs this file directly
 * for the verification suite.
 *
 * What this does:
 *   (1) Burn address generator — derive provably-unspendable Taproot burn
 *       addresses from a user-supplied tag, NUMS-style:
 *         internalKey = lift_x(SHA-256("PearlBurnNUMS/v1:" || tag))
 *       with a 256-counter lift loop (same construction as the audited
 *       escrow/will NUMS derivations, only the domain differs). Because the
 *       internal key is the hash of a public tag, nobody knows its discrete
 *       log; the TapTweak commit Q = P + t*G is then equally unspendable, so
 *       the P2TR output Q can never be spent. Burns are provable *by
 *       construction* — anyone can recompute tag -> address and confirm.
 *   (2) Burn planner — exact unsigned burn tx: one P2TR output to the burn
 *       address plus one P2TR change output, dust floor 546 grains, real
 *       vByte fee math (P2TR keypath input: 154 vB with 2 outputs, 111 vB
 *       with 1 output). The page never holds keys and never signs.
 *   (3) Burn certificate — a sealed `pearl-burn:v1:<hrp>:<sha256>` descriptor
 *       binding tag -> address -> amount -> txid, with a standalone Verify
 *       tab that recomputes everything and returns PROVEN / NOT PROVEN.
 *   (4) Blockbook verification — GET-only txid lookup confirms the on-chain
 *       output value, address, block height and timestamp.
 *
 * Crypto lineage: key lifting, TapTweak, bech32m, sha256, hex helpers,
 * varint/u32le/u64le, txidLE and the Blockbook GET helpers come from the
 * audited files/pages/sign/src/crypto.js; P2TR address parsing comes from
 * the audited files/pages/escrow/src/escrow-core.js; raw-tx decoding comes
 * from files/pages/sign/src/sign-core.js. The NUMS domain
 * "PearlBurnNUMS/v1" is provably distinct from the escrow ("PearlEscrowNUMS/
 * v1") and will ("PearlWillNUMS/v1") domains — asserted by test. No new
 * cryptography is invented.
 */

import {
  encodeBech32m, decodeBech32m, schnorr, sha256, bytesToHex, hexToBytes,
  varint, u32le, u64le, p2trScriptPubKey, txidLE,
  DUST_GRAIN, GRAIN_PER_PRL, NETWORKS, tweakKeypath, fetchTxStatus,
} from "../../sign/src/crypto.js";
import { addressToProgram } from "../../escrow/src/escrow-core.js";
import { decodeRawTx } from "../../sign/src/sign-core.js";
import { bytesToNumberBE } from "@noble/curves/abstract/utils";

export {
  DUST_GRAIN, GRAIN_PER_PRL, NETWORKS, tweakKeypath, fetchTxStatus,
  bytesToHex, hexToBytes, schnorr, sha256, encodeBech32m, decodeBech32m,
  addressToProgram, decodeRawTx,
};

const TE = new TextEncoder();
const utf8 = (s) => TE.encode(s);

export const SEAL_PREFIX = "pearl-burn:v1";
export const NUMS_DOMAIN = "PearlBurnNUMS/v1";
export const MAX_TAG_BYTES = 64;
export const BURN_DUST_GRAIN = DUST_GRAIN; // 546 grains — Pearl P2TR dust floor

/** Normalize and validate a user-supplied burn tag. Tags are public — they
 *  go into the burn address derivation and the certificate. */
export function normalizeTag(tag) {
  if (typeof tag !== "string") throw new Error("BURN REFUSED: tag must be a string");
  const t = tag.trim();
  if (t.length === 0) throw new Error("BURN REFUSED: tag is empty");
  if (/[\x00-\x1f\x7f]/.test(t)) throw new Error("BURN REFUSED: tag contains control characters");
  if (utf8(t).length > MAX_TAG_BYTES) throw new Error(`BURN REFUSED: tag longer than ${MAX_TAG_BYTES} bytes`);
  return t;
}

/** NUMS internal key: lift_x(SHA-256("PearlBurnNUMS/v1:" || tag)), with the
 *  same 256-counter lift loop as the audited escrow/will NUMS derivations
 *  (only the domain differs). By construction nobody knows the discrete
 *  log of this key — there is no private key to lose or leak. */
export function numsBurnKey(tag) {
  const t = normalizeTag(tag);
  const preimage = utf8(`${NUMS_DOMAIN}:${t}`);
  for (let counter = 0; counter < 256; counter++) {
    const pre = counter === 0 ? preimage : Uint8Array.from([...preimage, counter]);
    const h = sha256(pre);
    try {
      schnorr.utils.lift_x(bytesToNumberBE(h));
      return h;
    } catch { /* try next counter */ }
  }
  throw new Error("BURN REFUSED: NUMS lift failed (unreachable in practice)");
}

/** Derive the full burn address package for a tag on a network.
 *  Returns { tag, internalKeyHex, outputKeyHex, tweakHex, address, hrp }.
 *  The output key Q = internalKey + TapTweak(internalKey): since nobody
 *  knows dlog(internalKey), nobody knows dlog(Q) either — the address is
 *  provably unspendable by construction. */
export function burnAddressForTag(tag, networkId = "mainnet") {
  const net = NETWORKS[networkId];
  if (!net) throw new Error("BURN REFUSED: unknown network");
  const internal = numsBurnKey(tag);
  const { tweakedX, t } = tweakKeypath(internal);
  const address = encodeBech32m(net.hrp, 1, tweakedX);
  return {
    tag: normalizeTag(tag),
    internalKeyHex: bytesToHex(internal),
    outputKeyHex: bytesToHex(tweakedX),
    tweakHex: bytesToHex(t),
    address,
    hrp: net.hrp,
  };
}

/** Format a grains value as a human PRL string (8 decimals, trimmed). */
export function grainsToPRL(grains) {
  if (!Number.isSafeInteger(grains) || grains < 0) throw new Error("bad grains");
  const whole = Math.floor(grains / GRAIN_PER_PRL);
  const frac = String(grains % GRAIN_PER_PRL).padStart(8, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** Parse a PRL amount string ("1.5", "0.00001") into integer grains. */
export function prlToGrains(s) {
  if (typeof s !== "string") throw new Error("BURN REFUSED: amount must be text");
  const m = s.trim().match(/^(\d+)(?:\.(\d{1,8}))?$/);
  if (!m) throw new Error("BURN REFUSED: amount must look like 1.5 (max 8 decimals)");
  const grains = Number(m[1]) * GRAIN_PER_PRL + Number((m[2] || "").padEnd(8, "0"));
  if (!Number.isSafeInteger(grains) || grains <= 0) throw new Error("BURN REFUSED: amount must be positive");
  return grains;
}

// ---------------------------------------------------------------------------
// Burn certificate
// ---------------------------------------------------------------------------

/** Build the certificate text binding tag -> address -> amount -> txid.
 *  txid is "pending" until the burn tx is broadcast. */
export function formatCertificate({ tag, networkId = "mainnet", amountGrains, txid = "pending" }) {
  const b = burnAddressForTag(tag, networkId);
  if (!Number.isSafeInteger(amountGrains) || amountGrains < BURN_DUST_GRAIN) {
    throw new Error(`BURN REFUSED: burn amount below dust floor (${BURN_DUST_GRAIN} grains)`);
  }
  const tid = txid === "pending" ? "pending" : txid.trim().toLowerCase();
  if (tid !== "pending" && !/^[0-9a-f]{64}$/.test(tid)) {
    throw new Error("BURN REFUSED: txid must be 64-hex or omitted");
  }
  const canonical = `${SEAL_PREFIX}:${b.hrp}:${b.tag}:${b.address}:${amountGrains}:${tid}`;
  const seal = `${SEAL_PREFIX}:${b.hrp}:${bytesToHex(sha256(utf8(canonical)))}`;
  return [
    "pearl-burn:v1 certificate",
    `tag: ${b.tag}`,
    `hrp: ${b.hrp}`,
    `address: ${b.address}`,
    `amount_grains: ${amountGrains}`,
    `txid: ${tid}`,
    `seal: ${seal}`,
  ].join("\n");
}

/** Parse a certificate into fields; throws on malformed input. */
export function parseCertificate(text) {
  if (typeof text !== "string") throw new Error("BURN REFUSED: certificate must be text");
  const fields = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([a-z_]+):\s*(.*)$/);
    if (m) fields[m[1]] = m[2].trim();
  }
  for (const k of ["tag", "hrp", "address", "amount_grains", "txid", "seal"]) {
    if (!fields[k]) throw new Error(`BURN REFUSED: certificate missing field "${k}"`);
  }
  return fields;
}

/** Standalone verifier: recompute tag -> address, re-hash the canonical
 *  string, and return PROVEN only if every field checks out. Any tamper —
 *  tag, address, amount, txid or seal — flips the verdict to NOT PROVEN
 *  with the reasons listed. */
export function verifyBurnSeal(text) {
  const reasons = [];
  let fields;
  try {
    fields = parseCertificate(text);
  } catch (e) {
    return { verdict: "NOT PROVEN", reasons: [e.message] };
  }
  const net = Object.values(NETWORKS).find((n) => n.hrp === fields.hrp);
  if (!net) reasons.push(`unknown hrp "${fields.hrp}"`);
  let recomputed = null;
  if (net) {
    try {
      recomputed = burnAddressForTag(fields.tag, net.id);
      if (recomputed.address !== fields.address) {
        reasons.push("address does not match the tag (address tampered or wrong tag)");
      }
    } catch (e) {
      reasons.push("tag invalid: " + e.message);
    }
  }
  if (!/^\d+$/.test(fields.amount_grains) || Number(fields.amount_grains) < BURN_DUST_GRAIN) {
    reasons.push("amount_grains missing, non-numeric, or below dust floor");
  }
  if (fields.txid !== "pending" && !/^[0-9a-f]{64}$/.test(fields.txid)) {
    reasons.push("txid is neither \"pending\" nor 64-hex");
  }
  const canonical = `${SEAL_PREFIX}:${fields.hrp}:${fields.tag}:${fields.address}:${fields.amount_grains}:${fields.txid}`;
  const expectedSeal = `${SEAL_PREFIX}:${fields.hrp}:${bytesToHex(sha256(utf8(canonical)))}`;
  if (fields.seal !== expectedSeal) reasons.push("seal hash does not match the certificate contents (tampered)");
  return { verdict: reasons.length === 0 ? "PROVEN" : "NOT PROVEN", reasons, recomputed };
}

// ---------------------------------------------------------------------------
// Burn planner: exact unsigned burn tx
// ---------------------------------------------------------------------------

/** Exact vBytes for a P2TR keypath spend of 1 input with nOut P2TR outputs.
 *  Base: 4 (version) + 1 (in count) + 41 (outpoint+seq) + 1 (out count) +
 *  nOut*43 (8 value + 1 scriptlen + 34 script) + 4 (locktime).
 *  Witness: 2 (marker+flag) + 1 (item count) + 1+64 (sig push).
 *  nOut=2 -> 154 vB; nOut=1 -> 111 vB. */
export function burnVBytes(nOut) {
  if (!Number.isSafeInteger(nOut) || nOut < 1) throw new Error("BURN REFUSED: bad output count");
  const base = 4 + 1 + 41 + 1 + nOut * 43 + 4;
  const wit = 1 + (1 + 64);
  return Math.ceil((base * 3 + (base + 2 + wit)) / 4);
}

function parseBurnUtxo(utxo) {
  if (!utxo || typeof utxo !== "object") throw new Error("BURN REFUSED: utxo required");
  const txid = String(utxo.txid || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(txid)) throw new Error("BURN REFUSED: utxo.txid must be 64-hex");
  const vout = Number(utxo.vout);
  if (!Number.isSafeInteger(vout) || vout < 0) throw new Error("BURN REFUSED: utxo.vout must be a non-negative integer");
  const value = Number(utxo.value);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("BURN REFUSED: utxo.value must be positive grains");
  return { txid, vout, value };
}

/** Build the exact unsigned burn transaction.
 *  One P2TR input, one burn output (amountGrains to burnAddress), and one
 *  P2TR change output — unless the change would be dust, in which case the
 *  caller must either raise the burn amount (sweep the change into the
 *  burn) or refuse. Refuses loudly: burn below dust, burn above
 *  input-minus-fee, change in (0, dust), non-P2TR addresses, bad network.
 *  Returns { vBytes, feeGrains, burnGrains, changeGrains, unsignedHex,
 *  inputs, outputs } and re-verifies the hex by decoding it. */
export function planBurnTx({ networkId = "mainnet", utxo, burnAddress, amountGrains, changeAddress, feeRateGrainsPerVByte }) {
  const net = NETWORKS[networkId];
  if (!net) throw new Error("BURN REFUSED: unknown network");
  const { txid, vout, value } = parseBurnUtxo(utxo);
  const burnProgram = addressToProgram(burnAddress, net); // enforces P2TR + HRP
  const changeProgram = addressToProgram(changeAddress, net);
  if (!Number.isSafeInteger(amountGrains) || amountGrains < BURN_DUST_GRAIN) {
    throw new Error(`BURN REFUSED: burn amount below dust floor (${BURN_DUST_GRAIN} grains)`);
  }
  const feeRate = Number(feeRateGrainsPerVByte);
  if (!(feeRate > 0) || !Number.isFinite(feeRate)) throw new Error("BURN REFUSED: fee rate must be a positive number");
  const vBytes1 = burnVBytes(1);
  const fee1 = Math.ceil(vBytes1 * feeRate);
  const change1 = value - amountGrains - fee1;
  if (change1 < 0) throw new Error("BURN REFUSED: burn amount + fee exceeds the input value");
  const vBytes2 = burnVBytes(2);
  const fee2 = Math.ceil(vBytes2 * feeRate);
  const change2 = value - amountGrains - fee2;
  let nOut, vBytes, fee, change;
  if (change1 === 0) {
    nOut = 1; vBytes = vBytes1; fee = fee1; change = 0;
  } else if (change2 === 0) {
    nOut = 1; vBytes = vBytes1; fee = fee2; change = 0; // exact fit: dust folded into fee, no change output
  } else if (change2 >= BURN_DUST_GRAIN) {
    nOut = 2; vBytes = vBytes2; fee = fee2; change = change2;
  } else {
    throw new Error(
      `BURN REFUSED: change would be ${Math.max(change2, 0)} grains (below the ${BURN_DUST_GRAIN}-grain dust floor). ` +
      "Raise the burn amount to sweep the change into the burn, or pick a bigger input."
    );
  }
  const outputs = [{ program: burnProgram, grains: amountGrains, kind: "burn" }];
  if (nOut === 2) outputs.push({ program: changeProgram, grains: change, kind: "change" });
  const unsignedHex = buildUnsignedBurnTx({ networkId, utxo: { txid, vout, value }, outputs });
  const rechecked = reverifyUnsignedBurnHex(unsignedHex, {
    burnProgramHex: bytesToHex(burnProgram),
    burnGrains: amountGrains,
    changeProgramHex: nOut === 2 ? bytesToHex(changeProgram) : null,
    changeGrains: nOut === 2 ? change : null,
    feeGrains: fee,
    inputValue: value,
  });
  if (!rechecked.ok) throw new Error("BURN REFUSED: internal re-verification failed — " + rechecked.reasons.join("; "));
  return {
    networkId, vBytes, feeGrains: fee, burnGrains: amountGrains,
    changeGrains: nOut === 2 ? change : 0, unsignedHex,
    inputs: [{ txid, vout, value }],
    outputs: outputs.map((o) => ({ ...o, program: bytesToHex(o.program) })),
  };
}

/** Serialize the unsigned tx: version 1, one input (empty scriptSig,
 *  sequence 0xfffffffd — RBF-safe, no timelock), P2TR outputs, locktime 0.
 *  The tx is UNSIGNED: witness is absent; sign it in your wallet, then
 *  broadcast. */
export function buildUnsignedBurnTx({ networkId = "mainnet", utxo, outputs }) {
  const net = NETWORKS[networkId];
  if (!net) throw new Error("BURN REFUSED: unknown network");
  if (!Array.isArray(outputs) || outputs.length === 0) throw new Error("BURN REFUSED: outputs required");
  const bytes = [];
  const push = (...xs) => bytes.push(...xs);
  push(...u32le(net.txVersion));
  push(...varint(1));
  push(...txidLE(utxo.txid), ...u32le(utxo.vout), ...varint(0), ...u32le(0xfffffffd));
  push(...varint(outputs.length));
  for (const o of outputs) {
    if (!(o.program instanceof Uint8Array) || o.program.length !== 32) throw new Error("BURN REFUSED: output program must be 32 bytes");
    if (!Number.isSafeInteger(o.grains) || o.grains < BURN_DUST_GRAIN) throw new Error("BURN REFUSED: output below dust floor");
    const spk = p2trScriptPubKey(o.program);
    push(...u64le(o.grains), ...varint(spk.length), ...spk);
  }
  push(...u32le(0));
  return bytesToHex(Uint8Array.from(bytes));
}

/** Re-verify an unsigned burn hex against the plan: decode it and check the
 *  output programs, values and implied fee. */
export function reverifyUnsignedBurnHex(hex, expected) {
  const reasons = [];
  let dec;
  try {
    dec = decodeRawTx(hex);
  } catch (e) {
    return { ok: false, reasons: ["cannot decode tx hex: " + e.message] };
  }
  const outs = dec.outputs || [];
  const nOut = expected.changeProgramHex ? 2 : 1;
  if (outs.length !== nOut) reasons.push(`expected ${nOut} outputs, decoded ${outs.length}`);
  const outsHex = outs.map((o) => bytesToHex(o.spk || new Uint8Array()));
  const burnSpk = bytesToHex(p2trScriptPubKey(hexToBytes(expected.burnProgramHex)));
  const i = outsHex.indexOf(burnSpk);
  if (i < 0) reasons.push("burn output script not found in decoded tx");
  else if (outs[i].value !== BigInt(expected.burnGrains)) reasons.push("burn output value mismatch");
  if (expected.changeProgramHex) {
    const chSpk = bytesToHex(p2trScriptPubKey(hexToBytes(expected.changeProgramHex)));
    const j = outsHex.indexOf(chSpk);
    if (j < 0) reasons.push("change output script not found in decoded tx");
    else if (outs[j].value !== BigInt(expected.changeGrains)) reasons.push("change output value mismatch");
  }
  const totalOut = outs.reduce((a, o) => a + o.value, 0n);
  const impliedFee = BigInt(expected.inputValue) - totalOut;
  if (impliedFee !== BigInt(expected.feeGrains)) reasons.push(`implied fee ${impliedFee} != planned ${expected.feeGrains}`);
  return { ok: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// On-chain confirmation (Blockbook, GET-only)
// ---------------------------------------------------------------------------

/** Look up a burn tx on Blockbook (GET-only) and confirm it paid
 *  amountGrains to address. Returns { found, valueGrains, height, time,
 *  confirmations }. Throws on network errors — the caller surfaces them
 *  honestly. */
export async function verifyBurnTx(blockbookBase, { txid, address, amountGrains }) {
  if (!/^[0-9a-f]{64}$/.test(String(txid || "").trim().toLowerCase())) {
    throw new Error("BURN REFUSED: txid must be 64-hex");
  }
  const tx = await fetchTxStatus(blockbookBase, txid.trim().toLowerCase());
  const vouts = tx.vout || tx.vouts || [];
  let hit = null;
  for (const v of vouts) {
    const addrs = v.addresses || (v.scriptPubKey && v.scriptPubKey.addresses) || [];
    const val = v.valueSat ?? v.value;
    if (addrs.includes(address) && String(val) === String(amountGrains)) {
      hit = v;
      break;
    }
  }
  return {
    found: !!hit,
    valueGrains: hit ? Number(hit.valueSat ?? hit.value) : 0,
    height: tx.blockHeight ?? null,
    time: tx.blockTime ?? null,
    confirmations: tx.confirmations ?? 0,
  };
}
