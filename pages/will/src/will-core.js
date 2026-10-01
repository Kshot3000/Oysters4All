/* Pearl Will core — Taproot inheritance vaults for PRL.
 *
 * Pure ESM, zero build step for developers. The browser ships a committed
 * esbuild IIFE bundle (pearl-will.bundle.js); node runs this file directly
 * for the verification suite.
 *
 * What this does:
 *   An owner locks PRL in a 2-leaf Taproot vault under a NUMS internal key
 *   derived from "PearlWillNUMS/v1":
 *     leaf O (owner):  <owner_xonly> OP_CHECKSIG
 *       the owner can reclaim or move the funds at any time (no timelock).
 *     leaf H (heirs):  <unlockHeight> OP_CHECKLOCKTIMEVERIFY OP_DROP
 *                      <0> <heirK1> CHECKSIGADD ... <heirKn> CHECKSIGADD <m> EQUAL
 *       m-of-n heirs (n = 1..5) can claim ONLY at/after the unlock block
 *       (tx locktime = unlockHeight, input sequence < 0xffffffff).
 *   There is NO keypath spend — the NUMS point is nobody's key, so funds
 *   move only through the two leaves. This kills the usual keypath backdoor
 *   where an internal-key holder could bypass the scripts.
 *
 *   A tamper-evident descriptor `pearl-will:v1:<hrp>:<m>-of-<n>:<owner>:
 *   <heir1>:...:<unlock>:<label>` fully determines the vault address; the
 *   sealed commitment `pearl-will:v1:<hrp>:<sha256(canonical)>` commits to
 *   the whole setup. Claim desks refuse loudly before the unlock block.
 *
 * Crypto lineage: key derivation, TapTweak, bech32m, taggedHash, tapLeafHash,
 * BIP-340/341 sighash, party-key parsing and wire serialization come from
 * the audited files/pages/sign/src/crypto.js; script-path sighash, signing,
 * control-block verification, spend planning and dust math come from the
 * audited files/pages/escrow/src/escrow-core.js (escrow's buildRefundScript
 * CLTV pattern is mirrored — the leaf is asserted byte-shape-compatible in
 * tests). The NUMS derivation mirrors escrow's numsInternalKeyEscrow with a
 * different domain ("PearlWillNUMS/v1"). No new cryptography is invented.
 */

import {
  taggedHash, tapLeafHash, encodeBech32m, decodeBech32m,
  schnorr, sha256, bytesToHex, hexToBytes, convertBits,
  varint, u32le, u64le, p2trScriptPubKey, txidLE,
  DUST_GRAIN, GRAIN_PER_PRL, NETWORKS,
  walletFromMnemonic, newMnemonic, walletFromWIF,
  tweakKeypath, tweakPrivKeypath,
  fetchUtxos, fetchFeeRateGrainsPerVByte, broadcastTx, fetchTxStatus,
} from "../../sign/src/crypto.js";
import {
  partyKeyFromInput, parseXOnlyKey, scriptPathSigDigestEx,
  signForXOnly, verifySchnorrSig, buildScriptPathSpend,
  spendVBytes, planSpend, addressToProgram, scriptAsm,
  encodeScriptNum, pushData, taptree2, verifyControlBlock,
} from "../../escrow/src/escrow-core.js";
import { decodeRawTx } from "../../sign/src/sign-core.js";
import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesToNumberBE, numberToBytesBE } from "@noble/curves/abstract/utils";

export {
  DUST_GRAIN, GRAIN_PER_PRL, NETWORKS,
  walletFromMnemonic, newMnemonic, walletFromWIF,
  tweakKeypath, tweakPrivKeypath,
  fetchUtxos, fetchFeeRateGrainsPerVByte, broadcastTx, fetchTxStatus,
  bytesToHex, hexToBytes, schnorr, sha256, taggedHash, convertBits,
  encodeBech32m, decodeBech32m, p2trScriptPubKey, txidLE,
  partyKeyFromInput, parseXOnlyKey, scriptAsm, addressToProgram,
  verifySchnorrSig, signForXOnly, scriptPathSigDigestEx,
  encodeScriptNum, pushData, spendVBytes, planSpend,
  buildScriptPathSpend, verifyControlBlock, decodeRawTx,
};

const TE = new TextEncoder();
const utf8 = (s) => TE.encode(s);

export const DESCRIPTOR_PREFIX = "pearl-will:v1";
export const BLOCK_SECONDS = 194; // Pearl target block time (approximate — always labeled as such)
export const MAX_HEIRS = 5;
export const MIN_UNLOCK_BLOCKS_AHEAD = 1;
const OP = {
  FALSE: 0x00,
  DROP: 0x75,
  EQUAL: 0x87,
  CHECKSIG: 0xac,
  CHECKSIGADD: 0xba,
  CLTV: 0xb1,
};
const TAPLEAF_VERSION = 0xc0;
const MAX_SEQ_NONFINAL = 0xfffffffe; // non-final (CLTV satisfied) + RBF-safe
const EXPIRY_MAX_HEIGHT = 500_000_000; // unlock is a block height

/** Owner leaf: <owner_xonly> OP_CHECKSIG — reclaimable by the owner at any
 *  time, with no timelock. */
export function buildOwnerScript(ownerXOnly) {
  let k;
  try {
    k = ownerXOnly instanceof Uint8Array ? ownerXOnly : parseXOnlyKey(ownerXOnly);
  } catch (e) {
    throw new Error("WILL REFUSED: bad owner key — " + e.message);
  }
  if (k.length !== 32) throw new Error("WILL REFUSED: owner key must be 32 bytes");
  try {
    schnorr.utils.lift_x(bytesToNumberBE(k)); // throws if not a curve x-coordinate
  } catch (e) {
    throw new Error("WILL REFUSED: owner key is not a curve x-coordinate — " + e.message);
  }
  return Uint8Array.from([...pushData(k), OP.CHECKSIG]);
}

/** Heir leaf: <unlockHeight> OP_CLTV OP_DROP <0> <K1> CHECKSIGADD ...
 *  <Kn> CHECKSIGADD <m> OP_EQUAL — m-of-n heirs, CLTV-gated.
 *  Witness: [sig..., <0>s for non-signers] in REVERSE key order (mirrors the
 *  escrow CHECKSIGADD stack convention: empty vector for non-signers, then
 *  the script, then the control block).
 *
 *  Sorted keys (lexicographic) so the descriptor is canonical: re-derived
 *  leaves from the descriptor must byte-match, byte for byte. */
export function buildHeirScript(heirKeys, m, unlockHeight) {
  if (!Array.isArray(heirKeys) || heirKeys.length < 1 || heirKeys.length > MAX_HEIRS) {
    throw new Error(`WILL REFUSED: need 1..${MAX_HEIRS} heir keys`);
  }
  if (!Number.isSafeInteger(m) || m < 1 || m > heirKeys.length) {
    throw new Error("WILL REFUSED: threshold m must satisfy 1 <= m <= n");
  }
  if (!Number.isSafeInteger(unlockHeight) || unlockHeight < 1 || unlockHeight >= EXPIRY_MAX_HEIGHT) {
    throw new Error("WILL REFUSED: unlock must be a block height in 1..499999999");
  }
  const keys = heirKeys.map((k) => {
    let b;
    try {
      b = k instanceof Uint8Array ? k : parseXOnlyKey(k);
    } catch (e) {
      throw new Error("WILL REFUSED: bad heir key — " + e.message);
    }
    if (b.length !== 32) throw new Error("WILL REFUSED: heir key must be 32 bytes");
    try {
      schnorr.utils.lift_x(bytesToNumberBE(b));
    } catch (e) {
      throw new Error("WILL REFUSED: heir key is not a curve x-coordinate — " + e.message);
    }
    return b;
  });
  keys.sort((a, b) => (bytesToHex(a) < bytesToHex(b) ? -1 : bytesToHex(a) > bytesToHex(b) ? 1 : 0));
  const s = [...pushData(encodeScriptNum(unlockHeight)), OP.CLTV, OP.DROP, OP.FALSE];
  for (const k of keys) s.push(...pushData(k), OP.CHECKSIGADD);
  s.push(0x50 + m, OP.EQUAL);
  return Uint8Array.from(s);
}

const NUMS_DOMAIN = "PearlWillNUMS/v1";

/** NUMS internal key: lift_x(SHA-256("PearlWillNUMS/v1" || leafHashO ||
 *  leafHashH)), with the same 256-counter lift loop as the audited escrow
 *  NUMS derivation (only the domain differs). Nobody knows the discrete
 *  log, so keypath spending is impossible. */
export function numsInternalKeyWill(leafO, leafH) {
  if (!(leafO instanceof Uint8Array) || leafO.length === 0) throw new Error("bad leaf O");
  if (!(leafH instanceof Uint8Array) || leafH.length === 0) throw new Error("bad leaf H");
  const preimage = Uint8Array.from([utf8(NUMS_DOMAIN), tapLeafHash(leafO), tapLeafHash(leafH)].flatMap((x) => [...x]));
  for (let counter = 0; counter < 256; counter++) {
    const pre = counter === 0 ? preimage : Uint8Array.from([...preimage, counter]);
    const h = sha256(pre);
    try {
      schnorr.utils.lift_x(bytesToNumberBE(h));
      return h;
    } catch { /* try next counter */ }
  }
  throw new Error("WILL REFUSED: NUMS lift failed (unreachable in practice)");
}

/** Build the vault from its full spec. Returns the scripts, the NUMS
 *  internal key, the taptree (address, spk, control blocks), and the
 *  canonical descriptor + sealed commitment. */
export function buildWillVault({ network, owner, heirs, m, unlockHeight, label = "" }) {
  const net = NETWORKS[network];
  if (!net) throw new Error("WILL REFUSED: network must be mainnet or testnet");
  const ownerScript = buildOwnerScript(owner);
  const heirScript = buildHeirScript(heirs, m, unlockHeight);
  const internal = numsInternalKeyWill(ownerScript, heirScript);
  const tree = taptree2(net, internal, ownerScript, heirScript);
  const heirKeysSorted = (Array.isArray(heirs) ? heirs : []).map((k) =>
    k instanceof Uint8Array ? bytesToHex(k) : String(k).trim().toLowerCase());
  heirKeysSorted.sort();
  const descriptor = [
    DESCRIPTOR_PREFIX, net.hrp, `${m}-of-${heirKeysSorted.length}`,
    owner instanceof Uint8Array ? bytesToHex(owner) : String(owner).trim().toLowerCase(),
    ...heirKeysSorted, String(unlockHeight),
    label.trim() ? label.trim().slice(0, 64) : "-",
  ].join(":");
  const sealed = `${DESCRIPTOR_PREFIX}:${net.hrp}:${bytesToHex(sha256(utf8(descriptor)))}`;
  return {
    network, net, ownerScript, heirScript, internalXOnly: internal,
    address: tree.address, spk: tree.spk, tweakedX: tree.tweakedX,
    controlBlocks: tree.controlBlocks, // [owner control block, heir control block]
    descriptor, sealed,
  };
}

/** Standalone descriptor verifier: re-derive EVERYTHING from the pasted
 *  descriptor and rule PROVEN / NOT PROVEN against the claimed address and
 *  (optionally) sealed commitment. Never throws on malformed input —
 *  malformed input is a NOT PROVEN verdict. */
export function verifyWillDescriptor(descriptor, claimedAddress, sealed = null) {
  const checks = [];
  const fail = (label, detail) => {
    checks.push({ label, ok: false, detail });
    return { verdict: "NOT PROVEN", checks };
  };
  let parts;
  try {
    parts = String(descriptor || "").trim().split(":");
    if (parts.length < 7) throw new Error("too few fields");
    if (parts[0] !== "pearl-will" || parts[1] !== "v1") throw new Error("bad prefix");
  } catch (e) {
    return fail("Descriptor parses", e.message);
  }
  const hrp = parts[2];
  const net = NETWORKS[hrp === "prl" ? "mainnet" : hrp === "tprl" ? "testnet" : null];
  if (!net) return fail("Network HRP", `unknown hrp '${hrp}' (want prl or tprl)`);
  checks.push({ label: "Network HRP", ok: true, detail: `${hrp} → ${net.name}` });
  const mofn = parts[3].match(/^(\d+)-of-(\d+)$/);
  if (!mofn) return fail("Threshold", `bad m-of-n '${parts[3]}'`);
  const m = Number(mofn[1]), n = Number(mofn[2]);
  checks.push({ label: "Threshold", ok: true, detail: `${m}-of-${n}` });
  const owner = parts[4], heirHexes = parts.slice(5, 5 + n), unlockS = parts[5 + n], label = parts[6 + n];
  if (heirHexes.length !== n || unlockS === undefined || label === undefined) {
    return fail("Field count", `expected ${7 + n} fields, descriptor has ${parts.length}`);
  }
  let vault;
  try {
    vault = buildWillVault({ network: hrp === "prl" ? "mainnet" : "testnet", owner, heirs: heirHexes, m, unlockHeight: Number(unlockS), label: label === "-" ? "" : label });
  } catch (e) {
    return fail("Vault re-derivation", e.message);
  }
  checks.push({ label: "Vault re-derivation", ok: true, detail: "scripts, NUMS key, taptree rebuilt" });
  const wantAddr = String(claimedAddress || "").trim();
  const addrOk = wantAddr.toLowerCase() === vault.address.toLowerCase();
  checks.push({ label: "Address match", ok: addrOk, detail: addrOk ? vault.address : `claimed ${wantAddr || "(none)"} ≠ derived ${vault.address}` });
  if (!addrOk) return { verdict: "NOT PROVEN", checks };
  const sealedOk = !sealed || sealed.trim().toLowerCase() === vault.sealed.toLowerCase();
  checks.push({ label: "Sealed commitment", ok: sealedOk, detail: sealedOk ? vault.sealed : `claimed ${sealed} ≠ ${vault.sealed}` });
  return { verdict: sealedOk ? "PROVEN" : "NOT PROVEN", checks };
}

/** Parse a descriptor into its vault (convenience for the claim tab). */
export function willFromDescriptor(descriptor) {
  const parts = String(descriptor || "").trim().split(":");
  if (parts.length < 7 || parts[0] !== "pearl-will" || parts[1] !== "v1") {
    throw new Error("WILL REFUSED: not a pearl-will:v1 descriptor");
  }
  const hrp = parts[2];
  const mofn = parts[3].match(/^(\d+)-of-(\d+)$/);
  if (!mofn) throw new Error("WILL REFUSED: bad m-of-n in descriptor");
  const n = Number(mofn[2]);
  const heirs = parts.slice(5, 5 + n);
  if (heirs.length !== n) throw new Error("WILL REFUSED: descriptor field count mismatch");
  return {
    vault: buildWillVault({
      network: hrp === "prl" ? "mainnet" : hrp === "tprl" ? "testnet" : (() => { throw new Error("WILL REFUSED: unknown hrp"); })(),
      owner: parts[4], heirs, m: Number(mofn[1]), unlockHeight: Number(parts[5 + n]),
      label: parts[6 + n] === "-" ? "" : parts[6 + n],
    }),
    m: Number(mofn[1]), n, unlockHeight: Number(parts[5 + n]),
  };
}

/** Refuse a claim attempt BEFORE any spend is built. Returns the lock status.
 *  chainTip: current block height (Blockbook tip or pasted). Throws loudly
 *  when the chain has not reached the unlock height — this is the honest
 *  gate, enforced on-chain by CLTV but checked here first. */
export function assertClaimable(unlockHeight, chainTip, who) {
  if (!Number.isSafeInteger(chainTip) || chainTip < 0) {
    throw new Error("WILL REFUSED: need a chain tip height to check the timelock (Blockbook or pasted)");
  }
  if (chainTip < unlockHeight) {
    const left = unlockHeight - chainTip;
    throw new Error(`WILL REFUSED: ${who} claim locked — unlock at block ${unlockHeight}, chain tip ${chainTip} (${left} blocks ≈ ${Math.round(left * BLOCK_SECONDS / 86400)} day(s) to go)`);
  }
  return true;
}

/** Owner reclaim: build a script-path spend through leaf O. sequence stays
 *  final, locktime 0 (no timelock on the owner path). */
export function buildOwnerClaim(vault, { input, payments, changeAddress, feeRateGrainsPerVByte, privOwner, signerXOnly }) {
  const stackLens = [64]; // one owner signature
  const ownerX = bytesToHex(vault.ownerScript.slice(1, 33));
  const sx = String(signerXOnly || "").trim().toLowerCase();
  if (sx !== ownerX) {
    throw new Error("WILL REFUSED: signer key is not the owner key of this vault — refusing to sign");
  }
  const changeProgram = addressToProgram(changeAddress, vault.net);
  const plan = planSpend({
    inputValue: input.value,
    payments: payments.map((p) => ({ program: addressToProgram(p.address, vault.net), value: p.value })),
    feeRateGrainsPerVByte, scriptLen: vault.ownerScript.length,
    controlLen: vault.controlBlocks[0].length, stackLens,
  });
  const outputs = plan.outputs.map((o) => ({
    program: o.program || changeProgram,
    value: o.value,
  }));
  const inputEx = { txid: input.txid, vout: input.vout, value: input.value, spk: vault.spk };
  const digest = scriptPathSigDigestEx(vault.net, inputEx, outputs, vault.ownerScript, { sequence: 0xffffffff, locktime: 0 });
  const sig = signForXOnly(privOwner, digest);
  if (!verifySchnorrSig(sig, digest, signerXOnly)) {
    throw new Error("WILL REFUSED: owner signature failed local re-verification — refusing to expose bad hex");
  }
  const built = buildScriptPathSpend(vault.net, inputEx, outputs, vault.ownerScript, vault.controlBlocks[0], [sig], { sequence: 0xffffffff, locktime: 0 });
  built.fee = input.value - outputs.reduce((a, o) => a + o.value, 0);
  return built;
}

/** Heir claim: m-of-n through leaf H. Asserts the timelock FIRST (loud
 *  refusal), then builds the spend with locktime = unlockHeight and a
 *  non-final sequence. signatures: array of {key, sig} in key order;
 *  witness order is REVERSE key order with empty vectors for non-signers
 *  (the escrow CHECKSIGADD stack convention).
 *
 *  `outputsOverride` (optional): the exact outputs the heir signatures were
 *  computed over (the Claim tab computes the digest first against a max-size
 *  witness assumption, then reuses those outputs here). When given, planSpend
 *  is skipped and these outputs are used verbatim — the digest the heirs
 *  signed MUST be the digest of the built tx. Each output is
 *  {program: Uint8Array(32), value}. */
export function buildHeirClaim(vault, heirHexes, m, unlockHeight, { input, payments, changeAddress, feeRateGrainsPerVByte, signatures, chainTip, outputsOverride = null }) {
  assertClaimable(unlockHeight, chainTip, "heir");
  const changeProgram = addressToProgram(changeAddress, vault.net);
  const n = heirHexes.length;
  const keys = heirHexes.map((h) => (h instanceof Uint8Array ? h : parseXOnlyKey(h)));
  const order = keys.map((k, i) => [bytesToHex(k), i]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const heirSet = new Set(order.map(([hx]) => hx));
  const byKey = new Map();
  for (const s of signatures) {
    const kh = String(s.key).trim().toLowerCase();
    if (!heirSet.has(kh)) {
      throw new Error(`WILL REFUSED: signature key ${kh.slice(0, 12)}… is not an heir of this vault — refusing`);
    }
    byKey.set(kh, s.sig);
  }
  const sigFor = (hexKey) => {
    const s = byKey.get(String(hexKey).trim().toLowerCase());
    if (!s) return null; // non-signer: empty vector
    const sig = s instanceof Uint8Array ? s : hexToBytes(String(s).trim());
    if (sig.length !== 64) throw new Error(`WILL REFUSED: signature for ${hexKey.slice(0, 12)}… must be 64 bytes`);
    return sig;
  };
  // Witness stack in reverse sorted-key order.
  const stack = [];
  for (let i = order.length - 1; i >= 0; i--) {
    const s = sigFor(order[i][0]);
    stack.push(s === null ? new Uint8Array(0) : s);
  }
  const stackLens = stack.map((w) => w.length);
  const inputEx = { txid: input.txid, vout: input.vout, value: input.value, spk: vault.spk };
  let outputs;
  if (outputsOverride) {
    outputs = outputsOverride.map((o) => {
      if (!(o.program instanceof Uint8Array) || o.program.length !== 32) {
        throw new Error("WILL REFUSED: override output program must be 32 bytes");
      }
      if (!Number.isSafeInteger(o.value) || o.value < DUST_GRAIN) {
        throw new Error(`WILL REFUSED: override output below dust (${DUST_GRAIN} grains)`);
      }
      return { program: o.program, value: o.value };
    });
  } else {
    const plan = planSpend({
      inputValue: input.value,
      payments: payments.map((p) => ({ program: addressToProgram(p.address, vault.net), value: p.value })),
      feeRateGrainsPerVByte, scriptLen: vault.heirScript.length,
      controlLen: vault.controlBlocks[1].length, stackLens,
    });
    outputs = plan.outputs.map((o) => ({ program: o.program || changeProgram, value: o.value }));
  }
  const digest = scriptPathSigDigestEx(vault.net, inputEx, outputs, vault.heirScript, { sequence: MAX_SEQ_NONFINAL, locktime: unlockHeight });
  // Verify every present signature against its key before building.
  let ok = 0;
  for (let i = order.length - 1; i >= 0; i--) {
    const [hexKey, origIdx] = order[i];
    const s = sigFor(hexKey);
    if (s === null) continue;
    if (!verifySchnorrSig(s, digest, hexKey)) {
      throw new Error(`WILL REFUSED: signature from heir ${origIdx + 1} (${hexKey.slice(0, 12)}…) failed local re-verification — refusing to expose bad hex`);
    }
    ok++;
  }
  if (ok < m) throw new Error(`WILL REFUSED: only ${ok} valid heir signature(s), need ${m} of ${n}`);
  const built = buildScriptPathSpend(vault.net, inputEx, outputs, vault.heirScript, vault.controlBlocks[1], stack, { sequence: MAX_SEQ_NONFINAL, locktime: unlockHeight });
  built.fee = input.value - outputs.reduce((a, o) => a + o.value, 0);
  return built;
}

/** Independently re-verify a built claim transaction from its hex alone:
 *  decode it, check structure (1 input, expected outpoint/sequence/locktime,
 *  decoded txid == reported txid), re-derive the control block against the
 *  vault (proving the witness commits to THIS vault's leaf), recompute the
 *  sighash from the DECODED outputs, and re-verify every witness signature
 *  against its key. Throws loudly on any mismatch. Returns {ok, sigs}.
 *
 *  opts: { leaf: "owner"|"heir", input, sequence, locktime, keys } where
 *  keys is [ownerXOnlyHex] for the owner path, or the sorted heir key hexes
 *  for the heir path (witness stack is reverse key order). */
export function reverifyClaimTx(vault, built, { leaf, input, sequence, locktime, keys }) {
  const leafScript = leaf === "owner" ? vault.ownerScript : vault.heirScript;
  if (!leafScript) throw new Error("WILL REFUSED: unknown leaf");
  let dec;
  try { dec = decodeRawTx(built.hex); }
  catch (e) { throw new Error("WILL REFUSED: built hex does not decode: " + e.message); }
  if (dec.txid !== String(built.txid).toLowerCase()) throw new Error("WILL REFUSED: decoded txid ≠ reported txid");
  if (dec.inputs.length !== 1) throw new Error("WILL REFUSED: expected exactly 1 input");
  const inp = dec.inputs[0];
  if (inp.txid !== String(input.txid).toLowerCase() || inp.vout !== input.vout) {
    throw new Error("WILL REFUSED: input outpoint mismatch in built tx");
  }
  if (inp.sequence !== sequence) throw new Error("WILL REFUSED: sequence mismatch in built tx");
  if (dec.locktime !== locktime) throw new Error("WILL REFUSED: locktime mismatch in built tx");
  const wit = dec.witness && dec.witness[0];
  if (!wit || wit.length < 3) throw new Error("WILL REFUSED: witness stack too short");
  const witScript = wit[wit.length - 2], witCb = wit[wit.length - 1];
  if (!u8eq(witScript, leafScript)) throw new Error("WILL REFUSED: witness script ≠ vault leaf");
  const cbIdx = leaf === "owner" ? 0 : 1;
  if (!u8eq(witCb, vault.controlBlocks[cbIdx])) throw new Error("WILL REFUSED: witness control block ≠ vault control block");
  if (!verifyControlBlock(vault.internalXOnly, leafScript, witCb, vault.tweakedX)) {
    throw new Error("WILL REFUSED: control block does not recompute to the vault address");
  }
  const outputs = dec.outputs.map((o) => {
    if (o.spk.length !== 34 || o.spk[0] !== 0x51 || o.spk[1] !== 0x20) {
      throw new Error("WILL REFUSED: non-P2TR output in built tx");
    }
    return { program: o.spk.slice(2), value: Number(o.value) };
  });
  const inputEx = { txid: input.txid, vout: input.vout, value: input.value, spk: vault.spk };
  const digest = scriptPathSigDigestEx(vault.net, inputEx, outputs, leafScript, { sequence, locktime });
  const stackItems = wit.slice(0, -2);
  let okSigs = 0;
  if (leaf === "owner") {
    if (stackItems.length !== 1 || stackItems[0].length !== 64) {
      throw new Error("WILL REFUSED: owner witness must carry exactly one 64-byte signature");
    }
    if (!verifySchnorrSig(stackItems[0], digest, keys[0])) {
      throw new Error("WILL REFUSED: owner signature invalid against the decoded tx");
    }
    okSigs = 1;
  } else {
    const n = keys.length;
    if (stackItems.length !== n) throw new Error("WILL REFUSED: heir witness must carry exactly n stack items");
    for (let i = 0; i < n; i++) {
      const item = stackItems[i];
      if (item.length === 0) continue; // non-signer
      if (item.length !== 64) throw new Error("WILL REFUSED: malformed heir witness item");
      const keyHex = keys[n - 1 - i]; // witness is reverse key order
      if (!verifySchnorrSig(item, digest, keyHex)) {
        throw new Error(`WILL REFUSED: heir signature at stack slot ${i} invalid against the decoded tx`);
      }
      okSigs++;
    }
  }
  return { ok: true, sigs: okSigs };
}

function u8eq(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

/** Fetch the chain tip height via GET-only Blockbook (for the unlock
 *  countdown and the claim gate). Throws honestly when unreachable. */
export async function fetchChainTip(blockbookUrl) {
  const u = String(blockbookUrl || "").replace(/\/+$/, "");
  if (!u) throw new Error("WILL REFUSED: no Blockbook URL configured");
  const r = await fetch(u + "/api/v2", { cache: "no-store" });
  if (!r.ok) throw new Error(`WILL REFUSED: Blockbook unreachable (HTTP ${r.status})`);
  const j = await r.json();
  if (!Number.isSafeInteger(j.blockbook?.bestHeight) && !Number.isSafeInteger(j.bestHeight)) {
    const h = j.blockbook?.bestHeight ?? j.bestHeight;
    throw new Error(`WILL REFUSED: Blockbook tip unreadable (${h})`);
  }
  return j.blockbook?.bestHeight ?? j.bestHeight;
}

/** Vault lifecycle via GET-only Blockbook (unfunded / funded / spent). */
export async function fetchVaultStatus(blockbookUrl, address) {
  const u = String(blockbookUrl || "").replace(/\/+$/, "");
  if (!u) throw new Error("WILL REFUSED: no Blockbook URL configured");
  const r = await fetch(`${u}/api/v2/address/${encodeURIComponent(address)}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`WILL REFUSED: Blockbook unreachable (HTTP ${r.status})`);
  const j = await r.json();
  const txs = Array.isArray(j.transactions) ? j.transactions : [];
  const confirmed = j.balance !== undefined ? Number(j.balance) : 0;
  return {
    balance: confirmed,
    unconfirmed: Number(j.unconfirmedBalance || 0),
    txCount: j.txApperances ?? txs.length,
    txs: txs.slice(0, 8).map((t) => ({
      txid: t.txid, confirmations: t.confirmations ?? 0,
      valueIn: t.valueIn, fees: t.fees,
    })),
  };
}
