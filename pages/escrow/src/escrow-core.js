/* Pearl Escrow core — bonded Taproot 2-of-3 escrow for PRL.
 *
 * Pure ESM, zero build step for developers. The browser ships a committed
 * esbuild IIFE bundle (pearl-escrow.bundle.js); node runs this file directly
 * for the verification suite.
 *
 * What this does: build a 2-leaf Taproot escrow contract —
 *   leaf 0 (release):  2-of-3 CHECKSIGADD over buyer/seller/arbiter keys
 *   leaf 1 (refund):   <lockHeight> CHECKLOCKTIMEVERIFY DROP <refundKey> CHECKSIG
 * derive the escrow P2TR address, then build / sign / verify / broadcast
 * script-path spends for both leaves. All signing is local; nothing secret
 * ever leaves the machine.
 *
 * Crypto lineage: key derivation, TapTweak, bech32m, BIP-341 sighash and
 * wire serialization are imported from the audited files/pages/sign/src/crypto.js
 * (itself verified byte-for-byte against Pearl's Go reference
 * node/txscript). This file adds only escrow composition — the new script
 * templates below are verified against the consensus implementation in
 * node/txscript/opcode.go (opcodeCheckSigAdd) and against the BIP-341
 * taptree/tweak construction used by commitKeyInfo.
 *
 * CHECKSIGADD stack mechanics (from node/txscript/opcode.go):
 *   pops pubkey (top), n, sig — i.e. bottom-up the triple is [sig, n, pubkey].
 *   The witness supplies the sigs at the bottom of the stack; the script
 *   pushes <0> then each key, so per key: [sig, 0, K] -> CHECKSIGADD -> [n+1].
 *   Because the LAST witness element is consumed FIRST, the witness must
 *   list the signatures in REVERSE script-key order, with an empty vector
 *   for each key that did not sign.
 *
 * Protocol facts (verified, not from memory):
 *  - TapLeaf/TapBranch/TapTweak tags + branch sort order: BIP-341, and the
 *    single-leaf case matches commitKeyInfo() in sign/src/crypto.js.
 *  - P2TR dust 546 grains, tx version 1, bech32m HRPs prl/tprl/rprl,
 *    BIP-86 coin type 808276/1: pearl-knowledge.md (from node/chaincfg).
 *  - CLTV lock heights < 500000000 are block heights (BIP-65); the refund
 *    leaf needs tx locktime >= height and input sequence < 0xffffffff.
 */

import {
  taggedHash, tapLeafHash, encodeBech32m, decodeBech32m,
  schnorr, sha256, bytesToHex, hexToBytes, convertBits,
  varint, u32le, u64le, p2trScriptPubKey, txidLE, dblSha,
  DUST_GRAIN, GRAIN_PER_PRL, NETWORKS,
  walletFromMnemonic, newMnemonic,
  fetchUtxos, fetchFeeRateGrainsPerVByte, broadcastTx, fetchTxStatus,
  buildRevealTx,
} from "../../sign/src/crypto.js";
import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesToNumberBE, numberToBytesBE } from "@noble/curves/abstract/utils";

export {
  DUST_GRAIN, GRAIN_PER_PRL, NETWORKS,
  walletFromMnemonic, newMnemonic,
  fetchUtxos, fetchFeeRateGrainsPerVByte, broadcastTx, fetchTxStatus,
  bytesToHex, hexToBytes, schnorr, sha256, dblSha, convertBits,
  encodeBech32m, decodeBech32m, p2trScriptPubKey, txidLE,
};

const OP = {
  FALSE: 0x00,
  TWO: 0x52,
  DROP: 0x75,
  EQUAL: 0x87,
  CHECKSIG: 0xac,
  CHECKSIGADD: 0xba,
  CLTV: 0xb1,
};
const TAPLEAF_VERSION = 0xc0;
const EMPTY = new Uint8Array(0);
const MAX_SEQ = 0xffffffff;

export function pushData(data) {
  const b = data instanceof Uint8Array ? data : Uint8Array.from(data);
  if (b.length === 0) return [OP.FALSE];
  if (b.length <= 75) return [b.length, ...b];
  if (b.length <= 255) return [0x4c, b.length, ...b];
  if (b.length <= 520) return [0x4d, b.length & 0xff, (b.length >> 8) & 0xff, ...b];
  throw new Error("push exceeds 520 bytes");
}

function constEq(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

/** Validate a 64-hex-char x-only pubkey (also rejects x >= field prime). */
export function parseXOnlyKey(hex) {
  if (typeof hex !== "string" || !/^[0-9a-fA-F]{64}$/.test(hex.trim())) {
    throw new Error("x-only pubkey must be 64 hex characters");
  }
  const b = hexToBytes(hex.trim().toLowerCase());
  schnorr.utils.lift_x(bytesToNumberBE(b)); // throws if x >= p
  return b;
}

/** Accept a party key as 64-hex x-only, or a BIP-39 mnemonic (BIP-86 account key). */
export function partyKeyFromInput(input, network) {
  const t = String(input || "").trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) return { xonly: parseXOnlyKey(t), priv: null, source: "x-only pubkey" };
  const words = t.split(/\s+/);
  if (words.length === 12 || words.length === 24) {
    const w = walletFromMnemonic(t, network); // throws on bad mnemonic
    return { xonly: w.internalXOnly, priv: w.priv, source: "mnemonic (BIP-86 m/86'/coin'/0'/0/0)" };
  }
  throw new Error("party key must be a 64-hex x-only pubkey or a 12/24-word mnemonic");
}

/** Release leaf: 2-of-3 over keys [buyer, seller, arbiter] (script order = role order).
 *  <0> <K1> CHECKSIGADD <K2> CHECKSIGADD <K3> CHECKSIGADD <2> EQUAL
 *  Witness: [sig_K3, sig_K2, sig_K1] (reverse key order; empty for non-signers),
 *  then the script, then the control block. */
export function buildReleaseScript(k1, k2, k3) {
  const keys = [k1, k2, k3].map((k) => (k instanceof Uint8Array ? k : parseXOnlyKey(k)));
  for (const k of keys) {
    if (k.length !== 32) throw new Error("party key must be 32 bytes");
    schnorr.utils.lift_x(bytesToNumberBE(k));
  }
  const s = [OP.FALSE];
  for (const k of keys) s.push(...pushData(k), OP.CHECKSIGADD);
  s.push(OP.TWO, OP.EQUAL);
  return Uint8Array.from(s);
}

/** Minimal script-number encoding (non-negative). */
export function encodeScriptNum(n) {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("script number must be a non-negative safe integer");
  if (n === 0) return new Uint8Array([OP.FALSE]);
  const out = [];
  let v = n;
  while (v > 0) { out.push(v & 0xff); v = Math.floor(v / 256); }
  if (out[out.length - 1] & 0x80) out.push(0x00);
  return Uint8Array.from(out);
}

/** Refund leaf: <lockHeight> CHECKLOCKTIMEVERIFY DROP <refundKey> CHECKSIG.
 *  Spendable only by refundKey once chain height >= lockHeight
 *  (tx locktime set to lockHeight, input sequence < 0xffffffff). */
export function buildRefundScript(refundXOnly, lockHeight) {
  const rk = refundXOnly instanceof Uint8Array ? refundXOnly : parseXOnlyKey(refundXOnly);
  if (rk.length !== 32) throw new Error("refund key must be 32 bytes");
  schnorr.utils.lift_x(bytesToNumberBE(rk));
  if (!Number.isSafeInteger(lockHeight) || lockHeight <= 0 || lockHeight >= 500000000) {
    throw new Error("lockHeight must be a positive block height (< 500000000)");
  }
  const h = encodeScriptNum(lockHeight);
  return Uint8Array.from([...pushData(h), OP.CLTV, OP.DROP, ...pushData(rk), OP.CHECKSIG]);
}

function tapBranch(a, b) {
  const [x, y] = bytesToHex(a) <= bytesToHex(b) ? [a, b] : [b, a];
  return taggedHash("TapBranch", Uint8Array.from([...x, ...y]));
}

const TE = new TextEncoder();
const utf8 = (s) => TE.encode(s);
const NUMS_DOMAIN = "PearlEscrowNUMS/v1";

/** NUMS internal key: lift_x(SHA-256("PearlEscrowNUMS/v1" || leafHashA || leafHashB)).
 *  Nobody knows the discrete log, so keypath spending is impossible — coins
 *  move only through the two script leaves. Deterministic and recomputable
 *  from the scripts. The counter loop is REQUIRED, not a formality: only
 *  about half of all 32-byte strings are valid x-coordinates on secp256k1
 *  (x^3+7 must be a quadratic residue), so the first hash usually fails to
 *  lift and the search continues.
 *
 *  SECURITY (2026-09-29 fix): this replaces the previous construction that
 *  passed a party key as the internal key. A party-controlled internal key
 *  leaves a keypath backdoor — the key holder can compute the tweaked
 *  private key (d + TapTweak scalar) and spend unilaterally, bypassing every
 *  script. The shipped README always documented a NUMS internal key; the
 *  code now matches it. */
export function numsInternalKeyEscrow(leafA, leafB) {
  if (!(leafA instanceof Uint8Array) || leafA.length === 0) throw new Error("bad leaf A");
  if (!(leafB instanceof Uint8Array) || leafB.length === 0) throw new Error("bad leaf B");
  const preimage = Uint8Array.from([utf8(NUMS_DOMAIN), tapLeafHash(leafA), tapLeafHash(leafB)].flatMap((x) => [...x]));
  for (let counter = 0; counter < 256; counter++) {
    const pre = counter === 0 ? preimage : Uint8Array.from([...preimage, counter]);
    const h = sha256(pre);
    try {
      schnorr.utils.lift_x(bytesToNumberBE(h));
      return h;
    } catch { /* try next counter */ }
  }
  throw new Error("ESCROW REFUSED: NUMS lift failed (unreachable in practice)");
}

/** Two-leaf taptree. Callers MUST pass a NUMS internal key (see
 *  numsInternalKeyEscrow) — a party-controlled internal key would leave a
 *  keypath backdoor, since the key holder can compute the tweaked private
 *  key (d + TapTweak scalar) and spend unilaterally. */
export function taptree2(network, internalXOnly, releaseScript, refundScript) {
  if (!(internalXOnly instanceof Uint8Array) || internalXOnly.length !== 32) {
    throw new Error("internal key must be 32 bytes");
  }
  const leafHashes = [releaseScript, refundScript].map(tapLeafHash);
  const root = tapBranch(leafHashes[0], leafHashes[1]);
  const t = taggedHash("TapTweak", Uint8Array.from([...internalXOnly, ...root]));
  const P = schnorr.utils.lift_x(bytesToNumberBE(internalXOnly));
  const Q = P.add(schnorr.Point.BASE.multiply(bytesToNumberBE(t)));
  const tweakedX = schnorr.utils.pointToBytes(Q);
  const parity = Q.toAffine().y & 1n ? 1 : 0;
  const controlBlocks = leafHashes.map((lh, i) =>
    Uint8Array.from([TAPLEAF_VERSION | parity, ...internalXOnly, ...leafHashes[1 - i]]));
  return {
    leafHashes, root, tweak: t, tweakedX, parity,
    address: encodeBech32m(network.hrp, 1, tweakedX),
    spk: p2trScriptPubKey(tweakedX),
    controlBlocks, // [release control block, refund control block]
  };
}

/** Independently re-derive the tweaked key from a control block and check it
 *  matches — the same verification a wallet does before funding. */
export function verifyControlBlock(internalXOnly, leafScript, controlBlock, tweakedX) {
  try {
    if (!(controlBlock instanceof Uint8Array) || controlBlock.length !== 65) return false;
    if ((controlBlock[0] & 0xfe) !== TAPLEAF_VERSION) return false;
    if (!constEq(controlBlock.slice(1, 33), internalXOnly)) return false;
    const leafHash = tapLeafHash(leafScript);
    const sibling = controlBlock.slice(33, 65);
    const root = tapBranch(leafHash, sibling);
    const t = taggedHash("TapTweak", Uint8Array.from([...internalXOnly, ...root]));
    const P = schnorr.utils.lift_x(bytesToNumberBE(internalXOnly));
    const Q = P.add(schnorr.Point.BASE.multiply(bytesToNumberBE(t)));
    const x = schnorr.utils.pointToBytes(Q);
    const parity = Q.toAffine().y & 1n ? 1 : 0;
    return constEq(x, tweakedX) && (controlBlock[0] & 0x01) === parity;
  } catch {
    return false;
  }
}

/** BIP-341 script-path sighash, generalized (locktime + input index are params).
 *  Mirrors the private scriptPathSigDigest() in sign/src/crypto.js — the test
 *  suite asserts byte-equality against buildRevealTx's digest. */
export function scriptPathSigDigestEx(network, input, outputs, leafScript, opts = {}) {
  const { sequence = MAX_SEQ, locktime = 0, inputIdx = 0 } = opts;
  if (!/^[0-9a-f]{64}$/i.test(input.txid || "")) throw new Error("bad input txid");
  if (!Number.isInteger(input.vout) || input.vout < 0) throw new Error("bad input vout");
  if (!Number.isSafeInteger(input.value) || input.value <= 0) throw new Error("bad input value");
  if (!(input.spk instanceof Uint8Array) || input.spk.length === 0) throw new Error("bad input spk");
  for (const o of outputs) {
    if (!(o.program instanceof Uint8Array) || o.program.length !== 32) throw new Error("output program must be 32 bytes");
    if (!Number.isSafeInteger(o.value) || o.value < DUST_GRAIN) throw new Error(`output below dust (${DUST_GRAIN} grains)`);
  }
  const sha = (b) => sha256(b);
  const prevouts = sha(Uint8Array.from([...txidLE(input.txid), ...u32le(input.vout)]));
  const amounts = sha(Uint8Array.from(u64le(input.value)));
  const spks = sha(Uint8Array.from([...varint(input.spk.length), ...input.spk]));
  const seqs = sha(Uint8Array.from(u32le(sequence)));
  const outs = sha(Uint8Array.from(outputs.flatMap((o) => {
    const s = p2trScriptPubKey(o.program);
    return [...u64le(o.value), ...varint(s.length), ...s];
  })));
  const leafHash = tapLeafHash(leafScript);
  const msg = Uint8Array.from([
    0x00, 0x00, ...u32le(network.txVersion), ...u32le(locktime),
    ...prevouts, ...amounts, ...spks, ...seqs, ...outs,
    0x01, // spend_type: script path, no annex
    ...u32le(inputIdx),
    ...leafHash, 0x00, 0xff, 0xff, 0xff, 0xff, // leaf hash, key version 0, codesep 0xffffffff
  ]);
  return taggedHash("TapSighash", msg);
}

/** BIP-340 sign a 32-byte digest with a privkey whose x-only key appears in
 *  the leaf script. Negates the scalar when the pubkey has odd Y (BIP-340),
 *  mirroring tweakPrivKeypath() in sign/src/crypto.js. */
export function signForXOnly(priv, digest) {
  const p = priv instanceof Uint8Array ? priv : hexToBytes(String(priv));
  const dg = digest instanceof Uint8Array ? digest : hexToBytes(String(digest));
  if (p.length !== 32) throw new Error("private key must be 32 bytes");
  if (dg.length !== 32) throw new Error("digest must be 32 bytes");
  let d = bytesToNumberBE(p);
  if (d <= 0n || d >= secp256k1.CURVE.n) throw new Error("private key out of range");
  const P = secp256k1.ProjectivePoint.fromPrivateKey(numberToBytesBE(d, 32));
  if (P.toRawBytes(true)[0] === 0x03) d = secp256k1.CURVE.n - d;
  return schnorr.sign(dg, numberToBytesBE(d, 32), new Uint8Array(32));
}

export function verifySchnorrSig(sig, digest, xonly) {
  try {
    const s = sig instanceof Uint8Array ? sig : hexToBytes(String(sig));
    const dg = digest instanceof Uint8Array ? digest : hexToBytes(String(digest));
    const k = xonly instanceof Uint8Array ? xonly : hexToBytes(String(xonly));
    if (s.length !== 64 || dg.length !== 32 || k.length !== 32) return false;
    return schnorr.verify(s, dg, k);
  } catch {
    return false;
  }
}

/** Combine exactly 2 verified signatures into the release-leaf witness stack
 *  (reverse key order; empty vector for the non-signer). Throws unless both
 *  signatures are valid for their claimed keys — a bad sig never reaches
 *  the chain. */
export function combineReleaseSigs(signatures, digest, keys) {
  if (!Array.isArray(signatures) || signatures.length !== 2) {
    throw new Error("release needs exactly 2 of the 3 party signatures");
  }
  const seen = new Set();
  const stack = [null, null, null];
  for (const { keyIndex, sig } of signatures) {
    if (!Number.isInteger(keyIndex) || keyIndex < 0 || keyIndex > 2) throw new Error("keyIndex must be 0, 1 or 2");
    if (seen.has(keyIndex)) throw new Error("duplicate signer");
    seen.add(keyIndex);
    if (!verifySchnorrSig(sig, digest, keys[keyIndex])) {
      throw new Error(`signature ${keyIndex} does not verify against party key ${keyIndex}`);
    }
    stack[keyIndex] = sig instanceof Uint8Array ? sig : hexToBytes(String(sig));
  }
  return [stack[2] || EMPTY, stack[1] || EMPTY, stack[0] || EMPTY]; // reverse key order
}

/** Serialize a single-input script-path spend. stackItems are the witness
 *  stack elements before the script (sigs / empty vectors); the leaf script
 *  and control block are appended automatically. */
export function buildScriptPathSpend(network, input, outputs, leafScript, controlBlock, stackItems, opts = {}) {
  const { sequence = MAX_SEQ, locktime = 0 } = opts;
  if (!(leafScript instanceof Uint8Array) || leafScript.length === 0) throw new Error("bad leaf script");
  if (!(controlBlock instanceof Uint8Array) || (controlBlock.length !== 33 && controlBlock.length !== 65)) {
    throw new Error("bad control block");
  }
  if ((controlBlock[0] & 0xfe) !== TAPLEAF_VERSION) throw new Error("bad control block version");
  const digest = scriptPathSigDigestEx(network, input, outputs, leafScript, { sequence, locktime });
  const outs = [];
  for (const o of outputs) {
    const s = p2trScriptPubKey(o.program);
    outs.push(...u64le(o.value), ...varint(s.length), ...s);
  }
  const wit = [];
  for (const w of stackItems) {
    const b = w instanceof Uint8Array ? w : hexToBytes(String(w));
    wit.push(...varint(b.length), ...b);
  }
  wit.push(...varint(leafScript.length), ...leafScript);
  wit.push(...varint(controlBlock.length), ...controlBlock);

  const base = [...u32le(network.txVersion), ...varint(1),
    ...txidLE(input.txid), ...u32le(input.vout), ...varint(0), ...u32le(sequence),
    ...varint(outputs.length), ...outs, ...u32le(locktime)];
  const txid = bytesToHex(dblSha(Uint8Array.from(base)).reverse());
  const full = [...u32le(network.txVersion), 0x00, 0x01, ...varint(1),
    ...txidLE(input.txid), ...u32le(input.vout), ...varint(0), ...u32le(sequence),
    ...varint(outputs.length), ...outs,
    ...varint(stackItems.length + 2), ...wit, ...u32le(locktime)];
  const baseBytes = base.length;
  const totalBytes = full.length;
  const vBytes = Math.ceil((baseBytes * 3 + totalBytes) / 4);
  return { txid, hex: bytesToHex(Uint8Array.from(full)), digest: bytesToHex(digest), vBytes, baseBytes, totalBytes };
}

/** vBytes for a single-input script-path spend with nOut P2TR outputs.
 *  Same weight arithmetic the test suite checks against the built tx. */
export function spendVBytes({ nOut, scriptLen, controlLen, stackLens }) {
  if (!Number.isSafeInteger(nOut) || nOut < 1) throw new Error("bad nOut");
  if (!Number.isSafeInteger(scriptLen) || scriptLen <= 0) throw new Error("bad scriptLen");
  if (!Number.isSafeInteger(controlLen) || controlLen <= 0) throw new Error("bad controlLen");
  if (!Array.isArray(stackLens) || stackLens.length === 0) throw new Error("bad stackLens");
  const varintLen = (n) => (n < 0xfd ? 1 : n <= 0xffff ? 3 : n <= 0xffffffff ? 5 : 9);
  let wit = varintLen(stackLens.length + 2); // witness item count
  for (const l of stackLens) wit += varintLen(l) + l;
  wit += varintLen(scriptLen) + scriptLen + varintLen(controlLen) + controlLen;
  const base = 4 + 1 + 41 + 1 + nOut * 43 + 4; // ver+count+1in+count+outs+locktime
  return Math.ceil((base * 3 + (base + 2 + wit)) / 4);
}

/** Plan a spend: pick outputs, compute fee from the real witness size, and
 *  fold dust change into the fee. Throws on insufficient funds. */
export function planSpend({ inputValue, payments, feeRateGrainsPerVByte, scriptLen, controlLen, stackLens }) {
  if (!Number.isSafeInteger(inputValue) || inputValue <= 0) throw new Error("bad input value");
  if (!Array.isArray(payments) || payments.length === 0) throw new Error("need at least one payment");
  let paySum = 0;
  for (const p of payments) {
    if (!(p.program instanceof Uint8Array) || p.program.length !== 32) throw new Error("payment program must be 32 bytes");
    if (!Number.isSafeInteger(p.value) || p.value < DUST_GRAIN) throw new Error(`payment below dust (${DUST_GRAIN} grains)`);
    paySum += p.value;
  }
  if (!Number.isFinite(feeRateGrainsPerVByte) || feeRateGrainsPerVByte <= 0) throw new Error("bad fee rate");
  const vbytes = (nOut) => spendVBytes({ nOut, scriptLen, controlLen, stackLens });
  const feeFor = (nOut) => Math.ceil(vbytes(nOut) * feeRateGrainsPerVByte);
  const need = (f) => paySum + f;
  // Try with a change output first.
  let fee = feeFor(payments.length + 1);
  let change = inputValue - need(fee);
  let outputs = payments.map((p) => ({ program: p.program, value: p.value }));
  if (change >= DUST_GRAIN) {
    outputs.push({ program: null, value: change, change: true });
  } else {
    // No change output: re-estimate the smaller tx, fold any dust remainder in.
    fee = feeFor(payments.length);
    change = inputValue - need(fee);
    if (change < 0) throw new Error(`insufficient funds: need ${need(fee)} grains, have ${inputValue}`);
    if (change > 0) { fee += change; change = 0; }
  }
  if (change < 0) throw new Error(`insufficient funds: need ${need(fee)} grains, have ${inputValue}`);
  return { outputs, fee, vBytes: vbytes(outputs.length), change };
}

/** Human-readable script disassembly (for the contract review screen). */
export function scriptAsm(script) {
  const names = { 0x52: "2", 0x75: "DROP", 0x87: "EQUAL", 0x88: "EQUALVERIFY", 0xa8: "SHA256", 0xac: "CHECKSIG", 0xba: "CHECKSIGADD", 0xb1: "CLTV" };
  const parts = [];
  let i = 0;
  while (i < script.length) {
    const op = script[i];
    if (op === 0x00) { parts.push("0"); i++; continue; }
    if (op >= 0x51 && op <= 0x60) { parts.push(String(op - 0x50)); i++; continue; }
    if (op <= 0x4b || op === 0x4c || op === 0x4d) {
      let len, hlen;
      if (op <= 0x4b) { len = op; hlen = 1; }
      else if (op === 0x4c) { len = script[i + 1]; hlen = 2; }
      else { len = script[i + 1] | (script[i + 2] << 8); hlen = 3; }
      const data = script.slice(i + hlen, i + hlen + len);
      parts.push(`<${bytesToHex(data).slice(0, 16)}…${data.length}B>`);
      i += hlen + len;
      continue;
    }
    parts.push(names[op] || `0x${op.toString(16).padStart(2, "0")}`);
    i++;
  }
  return parts.join(" ");
}

/** Decode a PRL P2TR address to its 32-byte program (throws on non-P2TR). */
export function addressToProgram(addr, network) {
  const { hrp, version, program } = decodeBech32m(addr.trim());
  if (hrp !== network.hrp) throw new Error(`wrong network HRP (expected ${network.hrp})`);
  if (version !== 1 || program.length !== 32) throw new Error("escrow pays to P2TR (v1, 32-byte) addresses only");
  return program;
}

export { buildRevealTx }; // re-exported for the sighash cross-check test
