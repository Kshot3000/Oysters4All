/* Pearl Covenant core — m-of-n Taproot multisig vault + offline cosigner
 * signing-round coordinator for PRL.
 *
 * Pure ESM, zero build step for developers. The browser ships a committed
 * esbuild IIFE bundle (pearl-covenant.bundle.js); node runs this file
 * directly for the verification suite.
 *
 * What this does:
 *   1. Covenant: an m-of-n (1 <= m <= n <= 16) Taproot script
 *        <0> <K1> CHECKSIGADD <K2> CHECKSIGADD ... <Kn> CHECKSIGADD <m> EQUAL
 *      committed as a SINGLE leaf under a NUMS (nothing-up-my-sleeve)
 *      internal key, so the vault address is fully determined by the
 *      cosigner key set and m — no keypath bypass is possible.
 *   2. Signing rounds: a tamper-evident JSON payload (the "round") carrying
 *      the unsigned spend, the covenant descriptor, and collected partial
 *      Schnorr signatures. Cosigners pass the round around (copy/paste, QR,
 *      file) and sign locally; when m valid signatures are collected the
 *      round finalizes into a signed, broadcast-ready transaction.
 *   3. Spend planning with exact script-path vBytes, dust refusal, and
 *      change back to the vault.
 *
 * Crypto lineage: key derivation, TapTweak, bech32m, BIP-341 sighash and
 * wire serialization come from the audited files/pages/sign/src/crypto.js;
 * multisig script composition, NUMS internal key, and the coordinator
 * below are new, built on the same primitives. The CHECKSIGADD stack
 * mechanics mirror files/pages/escrow/src/escrow-core.js (verified there
 * against node/txscript/opcode.go):
 *   witness = signatures in REVERSE sorted-key order, empty vector for each
 *   key that did not sign; then the leaf script; then the control block.
 *
 * Scope (v1): one UTXO per signing round. A vault holding several UTXOs
 * is spent one UTXO at a time — each round is a complete, independently
 * verifiable transaction.
 */

import {
  taggedHash, tapLeafHash, encodeBech32m, decodeBech32m,
  schnorr, sha256, bytesToHex, hexToBytes, convertBits,
  varint, u32le, u64le, p2trScriptPubKey, txidLE, dblSha,
  DUST_GRAIN, GRAIN_PER_PRL, NETWORKS,
  walletFromMnemonic, newMnemonic,
  fetchUtxos, fetchFeeRateGrainsPerVByte, broadcastTx, fetchTxStatus,
} from "../../sign/src/crypto.js";
import {
  partyKeyFromInput, parseXOnlyKey, scriptPathSigDigestEx,
  signForXOnly, verifySchnorrSig, buildScriptPathSpend,
  spendVBytes, planSpend, addressToProgram, scriptAsm,
} from "../../escrow/src/escrow-core.js";
import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesToNumberBE, numberToBytesBE } from "@noble/curves/abstract/utils";

export {
  DUST_GRAIN, GRAIN_PER_PRL, NETWORKS,
  walletFromMnemonic, newMnemonic,
  fetchUtxos, fetchFeeRateGrainsPerVByte, broadcastTx, fetchTxStatus,
  bytesToHex, hexToBytes, schnorr, sha256, dblSha, convertBits,
  encodeBech32m, decodeBech32m, p2trScriptPubKey, txidLE,
  partyKeyFromInput, parseXOnlyKey, scriptAsm, addressToProgram,
  verifySchnorrSig, signForXOnly, scriptPathSigDigestEx,
};

const OP = {
  FALSE: 0x00,
  EQUAL: 0x87,
  CHECKSIGADD: 0xba,
};
const TAPLEAF_VERSION = 0xc0;
const EMPTY = new Uint8Array(0);
export const MAX_COSIGNERS = 16;
export const ROUND_KIND = "pearl-covenant-signing-round";
export const ROUND_VERSION = 1;
export const DESCRIPTOR_PREFIX = "covenant:v1";

function constEq(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

function pushData(data) {
  const b = data instanceof Uint8Array ? data : Uint8Array.from(data);
  if (b.length === 0) return [OP.FALSE];
  if (b.length <= 75) return [b.length, ...b];
  throw new Error("push exceeds 75 bytes");
}

function opN(n) {
  if (!Number.isInteger(n) || n < 1 || n > 16) throw new Error("OP_N out of range 1..16");
  return 0x50 + n;
}

/** Sort x-only keys lexicographically (BIP-67 style): the covenant address
 *  must not depend on the order cosigners were entered in. */
export function sortKeys(keys) {
  const ks = keys.map((k) => (k instanceof Uint8Array ? k : parseXOnlyKey(k)));
  const seen = new Set();
  for (const k of ks) {
    if (k.length !== 32) throw new Error("cosigner key must be 32 bytes");
    schnorr.utils.lift_x(bytesToNumberBE(k)); // rejects x >= p
    const h = bytesToHex(k);
    if (seen.has(h)) throw new Error("duplicate cosigner key");
    seen.add(h);
  }
  return ks.map(bytesToHex).sort().map(hexToBytes);
}

/** m-of-n multisig leaf script:
 *    <0> <K1> CHECKSIGADD <K2> CHECKSIGADD ... <Kn> CHECKSIGADD <m> EQUAL
 *  Keys must be pre-sorted (use sortKeys). */
export function buildMultisigScript(sortedKeys, m) {
  const n = sortedKeys.length;
  if (!Number.isInteger(m) || m < 1 || m > n) throw new Error(`m must be 1..n (got m=${m}, n=${n})`);
  if (n < 1 || n > MAX_COSIGNERS) throw new Error(`n must be 1..${MAX_COSIGNERS}`);
  const s = [OP.FALSE];
  for (const k of sortedKeys) s.push(...pushData(k), OP.CHECKSIGADD);
  s.push(opN(m), OP.EQUAL);
  return Uint8Array.from(s);
}

/** NUMS internal key: H("PearlCovenantNUMS/v1" || leafScript) lifted to the
 *  curve. Nobody knows the discrete log, so keypath spending is impossible —
 *  coins move only through the multisig leaf. Deterministic; the counter
 *  fallback exists only for the astronomically-unlikely x >= p case. */
export function numsInternalKey(leafScript) {
  if (!(leafScript instanceof Uint8Array) || leafScript.length === 0) throw new Error("bad leaf script");
  for (let c = 0; c < 256; c++) {
    const preimage = c === 0 ? leafScript : Uint8Array.from([...leafScript, c]);
    const h = taggedHash("PearlCovenantNUMS/v1", preimage);
    try {
      schnorr.utils.lift_x(bytesToNumberBE(h));
      return h;
    } catch { /* try next counter */ }
  }
  throw new Error("NUMS lift failed (unreachable in practice)");
}

/** Single-leaf taptree under a NUMS internal key. Returns address, spk,
 *  control block (33 bytes: [0xc0|parity, internalKey]) and the pieces
 *  needed to re-derive everything from the descriptor. */
export function covenantTaptree(network, leafScript) {
  const internalXOnly = numsInternalKey(leafScript);
  const leafHash = tapLeafHash(leafScript);
  const t = taggedHash("TapTweak", Uint8Array.from([...internalXOnly, ...leafHash]));
  const P = schnorr.utils.lift_x(bytesToNumberBE(internalXOnly));
  const Q = P.add(schnorr.Point.BASE.multiply(bytesToNumberBE(t)));
  const tweakedX = schnorr.utils.pointToBytes(Q);
  const parity = Q.toAffine().y & 1n ? 1 : 0;
  const controlBlock = Uint8Array.from([TAPLEAF_VERSION | parity, ...internalXOnly]);
  return {
    internalXOnly, leafHash, tweak: t, tweakedX, parity, controlBlock,
    address: encodeBech32m(network.hrp, 1, tweakedX),
    spk: p2trScriptPubKey(tweakedX),
  };
}

/** Re-derive the tweaked key from a 33-byte control block + leaf script and
 *  check it matches — the same verification a wallet does before funding. */
export function verifyCovenantControlBlock(internalXOnly, leafScript, controlBlock, tweakedX) {
  try {
    if (!(controlBlock instanceof Uint8Array) || controlBlock.length !== 33) return false;
    if ((controlBlock[0] & 0xfe) !== TAPLEAF_VERSION) return false;
    if (!constEq(controlBlock.slice(1, 33), internalXOnly)) return false;
    const leafHash = tapLeafHash(leafScript);
    const t = taggedHash("TapTweak", Uint8Array.from([...internalXOnly, ...leafHash]));
    const P = schnorr.utils.lift_x(bytesToNumberBE(internalXOnly));
    const Q = P.add(schnorr.Point.BASE.multiply(bytesToNumberBE(t)));
    const x = schnorr.utils.pointToBytes(Q);
    const parity = Q.toAffine().y & 1n ? 1 : 0;
    return constEq(x, tweakedX) && (controlBlock[0] & 0x01) === parity;
  } catch {
    return false;
  }
}

/**
 * Forge a covenant from cosigner key inputs.
 * keyInputs: array of strings — each a 64-hex x-only pubkey or a 12/24-word
 *   BIP-39 mnemonic (BIP-86 account key, same scheme as Pearl Sign).
 * Returns { covenant, secrets }: covenant is fully serializable (safe to
 * share); secrets holds private keys IN MEMORY ONLY and never enters a
 * descriptor or signing round.
 */
export function createCovenant({ m, keyInputs, network }) {
  if (!Array.isArray(keyInputs) || keyInputs.length === 0) throw new Error("need at least one cosigner key");
  if (keyInputs.length > MAX_COSIGNERS) throw new Error(`at most ${MAX_COSIGNERS} cosigners`);
  const parsed = keyInputs.map((inp) => partyKeyFromInput(inp, network));
  const sorted = sortKeys(parsed.map((p) => p.xonly));
  const sortedHex = sorted.map(bytesToHex);
  // Keep each party's metadata attached to its (sorted) key.
  const byKey = new Map(parsed.map((p) => [bytesToHex(p.xonly), p]));
  const keys = sortedHex.map((h) => {
    const p = byKey.get(h);
    return { xonly: h, source: p.source, hasPriv: !!p.priv };
  });
  const secrets = parsed
    .filter((p) => p.priv)
    .map((p) => ({ xonly: bytesToHex(p.xonly), priv: bytesToHex(p.priv) }));
  const script = buildMultisigScript(sorted, m);
  const tree = covenantTaptree(network, script);
  if (!verifyCovenantControlBlock(tree.internalXOnly, script, tree.controlBlock, tree.tweakedX)) {
    throw new Error("internal control-block self-check failed");
  }
  const covenant = {
    kind: "pearl-covenant",
    version: 1,
    network: network.id,
    hrp: network.hrp,
    m,
    n: sorted.length,
    keys,
    scriptHex: bytesToHex(script),
    scriptAsm: scriptAsm(script),
    internalKeyHex: bytesToHex(tree.internalXOnly),
    tweakedHex: bytesToHex(tree.tweakedX),
    controlBlockHex: bytesToHex(tree.controlBlock),
    address: tree.address,
    spkHex: bytesToHex(tree.spk),
  };
  return { covenant, secrets };
}

/** Compact, copy-pasteable descriptor: covenant:v1:<hrp>:<m>-of-<n>:<k1>:... */
export function covenantDescriptor(covenant) {
  const ks = covenant.keys.map((k) => k.xonly).join(":");
  return `${DESCRIPTOR_PREFIX}:${covenant.hrp}:${covenant.m}-of-${covenant.n}:${ks}`;
}

/** Rebuild + fully re-derive a covenant from its descriptor. Throws on any
 *  mismatch — a tampered descriptor can never produce a spendable address. */
export function covenantFromDescriptor(descriptor, network) {
  const t = String(descriptor || "").trim();
  const parts = t.split(":");
  if (parts.length < 5 || parts[0] !== "covenant" || parts[1] !== "v1") {
    throw new Error("bad covenant descriptor (expected covenant:v1:<hrp>:<m>-of-<n>:<keys...>)");
  }
  const hrp = parts[2];
  if (hrp !== network.hrp) throw new Error(`descriptor is for ${hrp}, not ${network.hrp}`);
  const mm = parts[3].match(/^(\d+)-of-(\d+)$/);
  if (!mm) throw new Error("bad m-of-n in descriptor");
  const m = parseInt(mm[1], 10);
  const keyHexes = parts.slice(4);
  if (keyHexes.length !== parseInt(mm[2], 10)) throw new Error("descriptor key count != n");
  const { covenant } = createCovenant({ m, keyInputs: keyHexes, network });
  if (covenantDescriptor(covenant) !== t) throw new Error("descriptor failed round-trip check");
  return covenant;
}

/** x-only pubkey for a 32-byte private key (even-Y normalized like BIP-340). */
export function pubkeyFromPriv(priv) {
  const p = priv instanceof Uint8Array ? priv : hexToBytes(String(priv).trim());
  if (p.length !== 32) throw new Error("private key must be 32 bytes");
  const P = secp256k1.ProjectivePoint.fromPrivateKey(p);
  const raw = P.toRawBytes(true); // compressed; x is the same for even/odd Y
  return bytesToHex(raw.slice(1));
}

/** Exact worst-case vBytes for a covenant spend with nOut P2TR outputs:
 *  m sigs (64B) + (n-m) empty vectors. */
export function covenantSpendVBytes(covenant, nOut) {
  const stackLens = [
    ...Array(covenant.m).fill(64),
    ...Array(covenant.n - covenant.m).fill(0),
  ];
  return spendVBytes({
    nOut,
    scriptLen: covenant.scriptHex.length / 2,
    controlLen: 33,
    stackLens,
  });
}

/**
 * Build a signing round spending ONE vault UTXO.
 * payments: [{ address, valueGrains }] (valueGrains >= dust).
 * Returns the round object (JSON-serializable). Change returns to the vault.
 */
export function buildSigningRound(covenant, network, { utxo, payments, feeRateGrainsPerVByte, memo }) {
  if (!/^[0-9a-f]{64}$/i.test(utxo?.txid || "")) throw new Error("bad utxo txid");
  if (!Number.isInteger(utxo?.vout) || utxo.vout < 0) throw new Error("bad utxo vout");
  if (!Number.isSafeInteger(utxo?.value) || utxo.value <= 0) throw new Error("bad utxo value");
  const outs = (payments || []).map((p) => ({
    program: addressToProgram(p.address, network),
    value: p.valueGrains,
    address: String(p.address).trim(),
  }));
  if (outs.length === 0) throw new Error("need at least one payment");
  const scriptLen = covenant.scriptHex.length / 2;
  const stackLens = [...Array(covenant.m).fill(64), ...Array(covenant.n - covenant.m).fill(0)];
  const plan = planSpend({
    inputValue: utxo.value,
    payments: outs.map((o) => ({ program: o.program, value: o.value })),
    feeRateGrainsPerVByte,
    scriptLen,
    controlLen: 33,
    stackLens,
  });
  const vaultProgram = hexToBytes(covenant.tweakedHex);
  const finalOutputs = plan.outputs.map((o) => ({
    program: o.program || vaultProgram,
    value: o.value,
    address: o.program ? outs.find((x) => constEq(x.program, o.program))?.address : covenant.address,
    change: !!o.change,
  }));
  if (finalOutputs.some((o) => !o.address)) throw new Error("internal: change address resolution failed");
  const input = { txid: utxo.txid.toLowerCase(), vout: utxo.vout, value: utxo.value, spk: hexToBytes(covenant.spkHex) };
  const leafScript = hexToBytes(covenant.scriptHex);
  const digest = scriptPathSigDigestEx(
    network, input,
    finalOutputs.map((o) => ({ program: o.program, value: o.value })),
    leafScript, {},
  );
  return {
    kind: ROUND_KIND,
    version: ROUND_VERSION,
    covenant: covenantDescriptor(covenant),
    input: { txid: input.txid, vout: input.vout, value: input.value },
    outputs: finalOutputs.map((o) => ({ address: o.address, value: o.value, change: !!o.change })),
    feeGrains: plan.fee,
    vBytes: plan.vBytes,
    feeRateGrainsPerVByte,
    digest: bytesToHex(digest),
    memo: memo ? String(memo).slice(0, 200) : "",
    partialSigs: [], // [{ key, sig }]
  };
}

/** Canonical JSON for a round (what gets copied / QR-encoded / saved). */
export function serializeRound(round) {
  return JSON.stringify(round);
}

/**
 * Parse + fully verify a round: JSON shape, covenant descriptor re-derivation,
 * output programs, and an independently recomputed sighash digest. Throws on
 * anything unexpected — a forged round cannot reach the signing step.
 */
export function parseRound(json, network) {
  let r;
  try {
    r = typeof json === "string" ? JSON.parse(json) : json;
  } catch {
    throw new Error("round is not valid JSON");
  }
  if (!r || r.kind !== ROUND_KIND || r.version !== ROUND_VERSION) throw new Error("not a Pearl Covenant signing round");
  const covenant = covenantFromDescriptor(r.covenant, network);
  if (!/^[0-9a-f]{64}$/.test(r.input?.txid || "")) throw new Error("round: bad input txid");
  if (!Number.isInteger(r.input?.vout) || r.input.vout < 0) throw new Error("round: bad input vout");
  if (!Number.isSafeInteger(r.input?.value) || r.input.value <= 0) throw new Error("round: bad input value");
  if (!Array.isArray(r.outputs) || r.outputs.length === 0) throw new Error("round: no outputs");
  const outputs = r.outputs.map((o) => {
    if (!Number.isSafeInteger(o?.value) || o.value < DUST_GRAIN) throw new Error("round: bad output value");
    return { program: addressToProgram(o.address, network), value: o.value };
  });
  const input = { txid: r.input.txid, vout: r.input.vout, value: r.input.value, spk: hexToBytes(covenant.spkHex) };
  const expected = bytesToHex(scriptPathSigDigestEx(
    network, input, outputs, hexToBytes(covenant.scriptHex), {},
  ));
  if (expected !== String(r.digest).toLowerCase()) throw new Error("round: digest mismatch — the spend was tampered with");
  if (!Array.isArray(r.partialSigs)) throw new Error("round: bad partialSigs");
  const seen = new Set();
  for (const ps of r.partialSigs) {
    const key = String(ps?.key || "").toLowerCase();
    const sig = String(ps?.sig || "").toLowerCase();
    if (!covenant.keys.some((k) => k.xonly === key)) throw new Error("round: signature from non-cosigner key");
    if (seen.has(key)) throw new Error("round: duplicate signer");
    seen.add(key);
    if (!/^[0-9a-f]{128}$/.test(sig)) throw new Error("round: bad signature encoding");
    if (!verifySchnorrSig(sig, r.digest, key)) throw new Error(`round: signature from ${key.slice(0, 12)}… does not verify`);
  }
  // Return a normalized copy so downstream code never trusts raw input.
  return {
    kind: ROUND_KIND, version: ROUND_VERSION,
    covenant: covenantDescriptor(covenant),
    input: { txid: r.input.txid.toLowerCase(), vout: r.input.vout, value: r.input.value },
    outputs: r.outputs.map((o) => ({ address: String(o.address), value: o.value, change: !!o.change })),
    feeGrains: r.feeGrains, vBytes: r.vBytes,
    feeRateGrainsPerVByte: r.feeRateGrainsPerVByte,
    digest: String(r.digest).toLowerCase(),
    memo: String(r.memo || ""),
    partialSigs: r.partialSigs.map((ps) => ({ key: String(ps.key).toLowerCase(), sig: String(ps.sig).toLowerCase() })),
  };
}

/** Sign the round's digest with a private key; the key must be a cosigner.
 *  The signature is verified against the digest before it is stored — a bad
 *  signature never enters the round. */
export function signRound(round, covenant, privHex) {
  const priv = hexToBytes(String(privHex).trim());
  if (priv.length !== 32) throw new Error("private key must be 32 bytes");
  const key = pubkeyFromPriv(priv);
  if (!covenant.keys.some((k) => k.xonly === key)) {
    throw new Error("this key is not a cosigner of the covenant");
  }
  return importSig(round, covenant, key, bytesToHex(signForXOnly(priv, round.digest)));
}

/** Import a cosigner's (key, sig) pair after full verification. */
export function importSig(round, covenant, keyHex, sigHex) {
  const key = String(keyHex).trim().toLowerCase();
  const sig = String(sigHex).trim().toLowerCase();
  if (!covenant.keys.some((k) => k.xonly === key)) throw new Error("key is not a cosigner of the covenant");
  if (round.partialSigs.some((ps) => ps.key === key)) throw new Error("this cosigner already signed");
  if (!/^[0-9a-f]{128}$/.test(sig)) throw new Error("signature must be 128 hex characters");
  if (!verifySchnorrSig(sig, round.digest, key)) {
    throw new Error("signature does not verify against the round digest");
  }
  round.partialSigs.push({ key, sig });
  return round;
}

/** Quorum status of a round. */
export function roundStatus(round, covenant) {
  const signers = round.partialSigs.map((ps) => ps.key);
  return {
    have: signers.length,
    need: covenant.m,
    signers,
    ready: signers.length >= covenant.m,
  };
}

/**
 * Finalize: require >= m valid signatures, assemble the witness
 * (reverse sorted-key order, empty vector for non-signers), and build the
 * signed transaction. Throws unless quorum is reached.
 */
export function finalizeRound(round, covenant, network) {
  const st = roundStatus(round, covenant);
  if (!st.ready) throw new Error(`quorum not reached: ${st.have} of ${st.need} signatures`);
  const sigByKey = new Map(round.partialSigs.map((ps) => [ps.key, hexToBytes(ps.sig)]));
  const sortedHex = covenant.keys.map((k) => k.xonly); // createCovenant stores sorted order
  // Sanity: stored order really is sorted (defense against hand-built objects).
  const check = [...sortedHex].sort();
  if (check.some((k, i) => k !== sortedHex[i])) throw new Error("covenant keys not in sorted order");
  const stackItems = [];
  for (let i = sortedHex.length - 1; i >= 0; i--) {
    stackItems.push(sigByKey.get(sortedHex[i]) || EMPTY);
  }
  // Use exactly m signatures: drop extras beyond quorum (lowest priority =
  // the highest-sorted keys first, deterministic).
  let drops = st.have - covenant.m;
  if (drops > 0) {
    for (let i = 0; i < stackItems.length && drops > 0; i++) {
      if (stackItems[i].length === 64) { stackItems[i] = EMPTY; drops--; }
    }
  }
  const outputs = round.outputs.map((o) => ({
    program: addressToProgram(o.address, network),
    value: o.value,
  }));
  const input = {
    txid: round.input.txid, vout: round.input.vout,
    value: round.input.value, spk: hexToBytes(covenant.spkHex),
  };
  const spend = buildScriptPathSpend(
    network, input, outputs,
    hexToBytes(covenant.scriptHex), hexToBytes(covenant.controlBlockHex),
    stackItems, {},
  );
  if (spend.digest !== round.digest) throw new Error("internal: digest mismatch at finalize");
  return spend; // { txid, hex, digest, vBytes, baseBytes, totalBytes }
}

/** Human summary of a round for the coordinator UI. */
export function describeRound(round, covenant) {
  const st = roundStatus(round, covenant);
  const totalOut = round.outputs.reduce((a, o) => a + o.value, 0);
  return {
    covenant: `${covenant.m}-of-${covenant.n}`,
    address: covenant.address,
    input: `${round.input.txid.slice(0, 12)}…:${round.input.vout} (${(round.input.value / GRAIN_PER_PRL).toFixed(8)} PRL)`,
    outputs: round.outputs.map((o) => ({
      address: o.address.length > 24 ? o.address.slice(0, 12) + "…" + o.address.slice(-8) : o.address,
      value: (o.value / GRAIN_PER_PRL).toFixed(8),
      change: o.change,
    })),
    totalOut: (totalOut / GRAIN_PER_PRL).toFixed(8),
    fee: (round.feeGrains / GRAIN_PER_PRL).toFixed(8),
    feeRate: round.feeRateGrainsPerVByte,
    quorum: `${st.have}/${st.need}`,
    ready: st.ready,
    signers: st.signers.map((s) => s.slice(0, 12) + "…"),
    memo: round.memo,
  };
}
