/* Pearl Quorum core — an n-of-m Taproot multisig shared-custody desk for Pearl (PRL).
 *
 * The council chamber: no single key moves alone. A vault is forged from m
 * of n cosigner keys behind ONE CHECKSIGADD tapscript leaf, sealed under a
 * NUMS internal key (no keypath backdoor — nobody knows the internal key's
 * discrete log, so coins move only through the quorum script). Cosigners
 * coordinate signing rounds as tamper-evident JSON bundles: each cosigner
 * signs the SAME per-input BIP-341 script-path sighash with their own key,
 * every collected signature is re-verified before it counts, and the witness
 * is assembled only when m of n valid signatures are present per input.
 *
 * HONEST CAVEATS (also stated in the README and the page's Honest limits):
 *   - This is SCRIPT-PATH multisig (OP_CHECKSIGADD), not MuSig key
 *     aggregation. The witness carries m signatures + the full script, so a
 *     quorum spend is LARGER (more vBytes, more fee) than a MuSig keypath
 *     spend. The upside: no interactive key-setup ceremony and no new
 *     cryptography — every signer independently signs the same sighash.
 *   - A designated-cosigner internal key (optional) is a KEYPATH BACKDOOR:
 *     whoever holds that key can compute the tweaked private key and spend
 *     unilaterally, bypassing the quorum entirely. The desk refuses to forge
 *     silently in that mode — it stamps the descriptor and every screen
 *     with the warning. NUMS (the default) has no backdoor.
 *   - Cosigners must be real, distinct parties who hold their own keys.
 *     The desk cannot tell whether two "cosigners" are the same person.
 *
 * NO NEW CRYPTOGRAPHY anywhere in this file. All signing, verification,
 * hashing, address derivation, taproot tweaking, sighash construction, and
 * bundle sealing reuse the audited sign and escrow cores verbatim; the
 * quorum-specific logic is only: cosigner-key parsing/normalization, m-of-n
 * CHECKSIGADD script assembly, single-leaf taptree + NUMS derivation,
 * multi-input BIP-341 sighash digests, witness assembly in reverse key
 * order, fee planning, descriptors/bundles, and the localStorage ledger
 * helpers.
 */

import {
  canonicalJson, descriptorFingerprint,
} from "../../batch/src/batch-core.js";
import {
  fmtPRL, parsePRL, fetchUtxos, fetchFeeRate, broadcastViaBlockbook,
  parseUtxoList, verifySignedTx,
} from "../../sign/src/sign-core.js";
import {
  scriptPathSigDigestEx, signForXOnly, verifySchnorrSig, pushData,
  parseXOnlyKey, scriptAsm,
} from "../../escrow/src/escrow-core.js";
import {
  decodeBech32m, encodeBech32m, DUST_GRAIN, GRAIN_PER_PRL, NETWORKS,
  bytesToHex, hexToBytes, sha256, taggedHash, tapLeafHash, schnorr,
  p2trScriptPubKey, txidLE, u32le, u64le, varint, dblSha, fetchTxStatus,
} from "../../sign/src/crypto.js";
import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesToNumberBE } from "@noble/curves/abstract/utils";

export const QUORUM_DESCRIPTOR_KIND = "pearl-quorum:v1:";
export const QUORUM_BUNDLE_KIND = "pearl-quorum-unsigned:v1:";
export const QUORUM_SIGBUNDLE_KIND = "pearl-quorum-sigs:v1:";
export const MAX_COSIGNERS = 5;
export const MAX_VAULT_NAME_LEN = 80;
export const NUMS_DOMAIN = "PearlQuorumNUMS/v1";
export const DEFAULT_BLOCKBOOK = NETWORKS.mainnet.blockbook; // https://blockbook.pearlresearch.ai

const TE = new TextEncoder();
const EMPTY = new Uint8Array(0);
const MAX_SEQ = 0xffffffff;
const TAPLEAF_VERSION = 0xc0;

const OP = {
  FALSE: 0x00,
  CHECKSIGADD: 0xba,
  EQUAL: 0x87,
};

export {
  DUST_GRAIN, GRAIN_PER_PRL, NETWORKS, fmtPRL, parsePRL,
  bytesToHex, hexToBytes, sha256, schnorr, encodeBech32m, decodeBech32m,
  fetchUtxos, fetchFeeRate, broadcastViaBlockbook, parseUtxoList,
  verifySignedTx, canonicalJson, descriptorFingerprint,
  signForXOnly, verifySchnorrSig, parseXOnlyKey, scriptAsm, scriptPathSigDigestEx,
  fetchTxStatus,
};

/* ---------------- cosigner keys ---------------- */

/** Parse one cosigner key: 64-hex x-only, or 66-hex compressed (02/03 prefix,
 *  normalized to x-only by dropping the prefix byte). Refuses garbage, wrong
 *  lengths, and x-coordinates that are not on secp256k1. */
export function parseCosignerKey(text) {
  const t = String(text ?? "").trim().toLowerCase();
  if (/^[0-9a-f]{64}$/.test(t)) {
    return { xonly: parseXOnlyKey(t), hex: t, compressed: false };
  }
  if (/^0[23][0-9a-f]{64}$/.test(t)) {
    const x = t.slice(2);
    schnorr.utils.lift_x(bytesToNumberBE(hexToBytes(x))); // throws if x >= p / not on curve
    return { xonly: hexToBytes(x), hex: x, compressed: true };
  }
  throw new Error("cosigner key must be 64-hex x-only or 66-hex compressed (02/03…), got something else");
}

/** Normalize + validate the full cosigner set: 1..5 distinct keys. */
export function parseCosignerSet(keys) {
  if (!Array.isArray(keys) || keys.length < 1) throw new Error("a vault needs at least one cosigner");
  if (keys.length > MAX_COSIGNERS) throw new Error(`at most ${MAX_COSIGNERS} cosigners`);
  const out = keys.map((k, i) => {
    try { return parseCosignerKey(k); }
    catch (e) { throw new Error(`cosigner ${i + 1}: ${e.message}`); }
  });
  const seen = new Set();
  for (const k of out) {
    if (seen.has(k.hex)) throw new Error(`duplicate cosigner key: ${k.hex.slice(0, 12)}… appears twice — cosigners must be distinct`);
    seen.add(k.hex);
  }
  return out;
}

/* ---------------- m-of-n CHECKSIGADD script ---------------- */

/** Build the quorum leaf script for m-of-n:
 *    <0> <K1> CHECKSIGADD <K2> CHECKSIGADD … <Kn> CHECKSIGADD <m> EQUAL
 *  Script order is the cosigner order given (slot i = cosigner i). Witness
 *  order is REVERSE key order with empty vectors for non-signers, exactly
 *  like the audited escrow release leaf. */
export function buildQuorumScript(xonlyKeys, m) {
  const keys = (xonlyKeys || []).map((k) => (k instanceof Uint8Array ? k : hexToBytes(String(k))));
  const n = keys.length;
  if (n < 1 || n > MAX_COSIGNERS) throw new Error(`need 1..${MAX_COSIGNERS} cosigner keys`);
  if (!Number.isInteger(m) || m < 1 || m > n) throw new Error(`threshold m must be 1..${n} (got ${m})`);
  for (const k of keys) {
    if (!(k instanceof Uint8Array) || k.length !== 32) throw new Error("cosigner key must be 32 bytes");
    schnorr.utils.lift_x(bytesToNumberBE(k));
  }
  const s = [OP.FALSE];
  for (const k of keys) s.push(...pushData(k), OP.CHECKSIGADD);
  s.push(0x50 + m, OP.EQUAL);
  return Uint8Array.from(s);
}

/* ---------------- NUMS internal key (single leaf) ---------------- */

/** NUMS internal key: lift_x(SHA-256("PearlQuorumNUMS/v1" || leafHash || ctr)).
 *  Domain-separated from the escrow NUMS. Nobody knows the discrete log, so
 *  keypath spending is impossible — coins move only through the quorum leaf.
 *  The counter loop is REQUIRED: only ~half of 32-byte strings are valid
 *  x-coordinates on secp256k1. */
export function numsInternalKeyQuorum(leafScript) {
  if (!(leafScript instanceof Uint8Array) || leafScript.length === 0) throw new Error("bad leaf script");
  const preimage = Uint8Array.from([...TE.encode(NUMS_DOMAIN), ...tapLeafHash(leafScript)]);
  for (let counter = 0; counter < 256; counter++) {
    const pre = counter === 0 ? preimage : Uint8Array.from([...preimage, counter]);
    const h = sha256(pre);
    try {
      schnorr.utils.lift_x(bytesToNumberBE(h));
      return h;
    } catch { /* try next counter */ }
  }
  throw new Error("QUORUM REFUSED: NUMS lift failed (unreachable in practice)");
}

/** Single-leaf taptree. For one leaf the Merkle root IS the leaf hash (no
 *  branch hashing — BIP-341), so the control block is 33 bytes: no path. */
export function quorumTaptree(network, internalXOnly, leafScript) {
  if (!(internalXOnly instanceof Uint8Array) || internalXOnly.length !== 32) {
    throw new Error("internal key must be 32 bytes");
  }
  const root = tapLeafHash(leafScript); // single leaf: root == leaf hash
  const t = taggedHash("TapTweak", Uint8Array.from([...internalXOnly, ...root]));
  const P = schnorr.utils.lift_x(bytesToNumberBE(internalXOnly));
  const Q = P.add(schnorr.Point.BASE.multiply(bytesToNumberBE(t)));
  const tweakedX = schnorr.utils.pointToBytes(Q);
  const parity = Q.toAffine().y & 1n ? 1 : 0;
  return {
    leafHash: root,
    tweak: t,
    tweakedX,
    parity,
    address: encodeBech32m(network.hrp, 1, tweakedX),
    spk: p2trScriptPubKey(tweakedX),
    controlBlock: Uint8Array.from([TAPLEAF_VERSION | parity, ...internalXOnly]), // 33 bytes
  };
}

/** Independently re-derive the tweaked key from a 33-byte single-leaf
 *  control block and check it matches — the same check a wallet does. */
export function verifyQuorumControlBlock(internalXOnly, leafScript, controlBlock, tweakedX) {
  try {
    if (!(controlBlock instanceof Uint8Array) || controlBlock.length !== 33) return false;
    if ((controlBlock[0] & 0xfe) !== TAPLEAF_VERSION) return false;
    for (let i = 0; i < 32; i++) if (controlBlock[1 + i] !== internalXOnly[i]) return false;
    const root = tapLeafHash(leafScript);
    const t = taggedHash("TapTweak", Uint8Array.from([...internalXOnly, ...root]));
    const P = schnorr.utils.lift_x(bytesToNumberBE(internalXOnly));
    const Q = P.add(schnorr.Point.BASE.multiply(bytesToNumberBE(t)));
    const x = schnorr.utils.pointToBytes(Q);
    if (x.length !== tweakedX.length) return false;
    for (let i = 0; i < x.length; i++) if (x[i] !== tweakedX[i]) return false;
    return (controlBlock[0] & 0x01) === (Q.toAffine().y & 1n ? 1 : 0);
  } catch {
    return false;
  }
}

/* ---------------- vault ---------------- */

/** Forge a vault. internalKeyMode "nums" (default, no keypath backdoor) or
 *  "cosigner" (internal key = cosigner slot `internalKeySlot`'s key — LOUD
 *  keypath-backdoor warning stamped on the descriptor). */
export function createVault({ name, network = NETWORKS.mainnet, m, keys, internalKeyMode = "nums", internalKeySlot = 0 }) {
  const net = typeof network === "string" ? NETWORKS[network] : network;
  if (!net || (net.id !== "mainnet" && net.id !== "testnet")) throw new Error("unknown network");
  const vname = String(name ?? "").trim();
  if (!vname) throw new Error("vault name is blank");
  if (vname.length > MAX_VAULT_NAME_LEN) throw new Error(`vault name too long (max ${MAX_VAULT_NAME_LEN})`);
  const cosigners = parseCosignerSet(keys);
  const n = cosigners.length;
  const th = Number(m);
  if (!Number.isInteger(th) || th < 1 || th > n) throw new Error(`threshold m must be 1..${n} (got ${m})`);
  const script = buildQuorumScript(cosigners.map((c) => c.xonly), th);
  let internalXOnly, backdoor = null;
  if (internalKeyMode === "nums") {
    internalXOnly = numsInternalKeyQuorum(script);
  } else if (internalKeyMode === "cosigner") {
    const slot = Number(internalKeySlot);
    if (!Number.isInteger(slot) || slot < 0 || slot >= n) throw new Error("internal-key slot out of range");
    internalXOnly = cosigners[slot].xonly;
    backdoor = `KEYPATH BACKDOOR: internal key is cosigner ${slot + 1}'s key — that cosigner can compute the tweaked private key and spend UNILATERALLY, bypassing the ${th}-of-${n} quorum. Use NUMS unless you understand this.`;
  } else {
    throw new Error("internalKeyMode must be \"nums\" or \"cosigner\"");
  }
  const tree = quorumTaptree(net, internalXOnly, script);
  const descriptor = {
    kind: QUORUM_DESCRIPTOR_KIND,
    name: vname,
    network: net.id,
    hrp: net.hrp,
    m: th,
    n,
    pubkeys: cosigners.map((c) => c.hex),
    internalKeyMode,
    backdoorWarning: backdoor,
    scriptHex: bytesToHex(script),
    scriptAsm: scriptAsm(script),
    internalXOnlyHex: bytesToHex(internalXOnly),
    address: tree.address,
    spkHex: bytesToHex(tree.spk),
    controlBlockHex: bytesToHex(tree.controlBlock),
  };
  descriptor.fingerprint = descriptorFingerprint({
    kind: descriptor.kind, name: descriptor.name, network: descriptor.network,
    m: descriptor.m, n: descriptor.n, pubkeys: descriptor.pubkeys,
    internalKeyMode: descriptor.internalKeyMode, scriptHex: descriptor.scriptHex,
  });
  return descriptor;
}

/** Text descriptor export — human-readable, copy/pasteable. */
export function exportDescriptorText(v) {
  const lines = [
    QUORUM_DESCRIPTOR_KIND,
    `name: ${v.name}`,
    `network: ${v.network}`,
    `m: ${v.m}`,
    `n: ${v.n}`,
    `internal-key: ${v.internalKeyMode}`,
    ...v.pubkeys.map((k, i) => `pubkey[${i}]: ${k}`),
    `address: ${v.address}`,
    `fingerprint: ${v.fingerprint}`,
  ];
  return lines.join("\n");
}

/** Import a text (or JSON) descriptor: re-validates every key, re-derives the
 *  script + address, and REFUSES loudly on any mismatch or tampering. */
export function importDescriptorText(text) {
  const t = String(text ?? "").trim();
  if (!t) throw new Error("descriptor is empty");
  let fields = {};
  if (t.startsWith("{")) {
    const j = JSON.parse(t);
    if (j.kind !== QUORUM_DESCRIPTOR_KIND) throw new Error("not a pearl-quorum descriptor");
    fields = { name: j.name, network: j.network, m: j.m, n: j.n, internalKeyMode: j.internalKeyMode, pubkeys: j.pubkeys, address: j.address, fingerprint: j.fingerprint };
  } else {
    const lines = t.split(/\n/).map((l) => l.trim()).filter(Boolean);
    if (lines[0] !== QUORUM_DESCRIPTOR_KIND) throw new Error("not a pearl-quorum descriptor (first line must be pearl-quorum:v1:)");
    for (const line of lines.slice(1)) {
      const mm = line.match(/^(name|network|m|n|internal-key|address|fingerprint):\s*(.+)$/);
      const pm = line.match(/^pubkey\[(\d+)\]:\s*([0-9a-fA-F]+)$/i);
      if (mm) fields[mm[1].replace("internal-key", "internalKeyMode")] = mm[2];
      else if (pm) { (fields.pubkeys = fields.pubkeys || [])[Number(pm[1])] = pm[2].toLowerCase(); }
      else throw new Error(`unparseable descriptor line: ${line.slice(0, 40)}`);
    }
  }
  const v = createVault({
    name: fields.name, network: fields.network, m: Number(fields.m),
    keys: fields.pubkeys || [], internalKeyMode: fields.internalKeyMode || "nums",
    internalKeySlot: 0,
  });
  if (fields.address && fields.address !== v.address) {
    throw new Error(`DESCRIPTOR REFUSED: claimed address ${fields.address} does not match the re-derived ${v.address} — tampered descriptor`);
  }
  if (fields.fingerprint && fields.fingerprint !== v.fingerprint) {
    throw new Error("DESCRIPTOR REFUSED: fingerprint mismatch — tampered descriptor");
  }
  return v;
}

/* ---------------- multi-input BIP-341 script-path sighash ---------------- */

/** BIP-341 script-path sighash generalized to multiple inputs. For a single
 *  input the bytes MUST equal escrow's scriptPathSigDigestEx — the test
 *  suite asserts that. */
export function quorumSigDigest(network, inputs, idx, outputs, leafScript, opts = {}) {
  const optSeqs = opts.sequences || null;
  const locktime = opts.locktime || 0;
  if (!Array.isArray(inputs) || inputs.length === 0) throw new Error("need at least one input");
  if (!Number.isInteger(idx) || idx < 0 || idx >= inputs.length) throw new Error("bad input index");
  if (!Number.isSafeInteger(locktime) || locktime < 0) throw new Error("bad locktime");
  const seqs = inputs.map((_, i) => (optSeqs ? optSeqs[i] : MAX_SEQ));
  for (const s of seqs) if (!Number.isInteger(s) || s < 0 || s > MAX_SEQ) throw new Error("bad sequence");
  for (const inp of inputs) {
    if (!/^[0-9a-f]{64}$/i.test(inp.txid || "")) throw new Error("bad input txid");
    if (!Number.isInteger(inp.vout) || inp.vout < 0) throw new Error("bad input vout");
    if (!Number.isSafeInteger(inp.value) || inp.value <= 0) throw new Error("bad input value");
    if (!(inp.spk instanceof Uint8Array) || inp.spk.length === 0) throw new Error("bad input spk");
  }
  for (const o of outputs) {
    if (!(o.program instanceof Uint8Array) || o.program.length !== 32) throw new Error("output program must be 32 bytes");
    if (!Number.isSafeInteger(o.value) || o.value < DUST_GRAIN) throw new Error(`output below dust (${DUST_GRAIN} grains)`);
  }
  const sha = (b) => sha256(b);
  const prevouts = sha(Uint8Array.from(inputs.flatMap((i) => [...txidLE(i.txid), ...u32le(i.vout)])));
  const amounts = sha(Uint8Array.from(inputs.flatMap((i) => [...u64le(i.value)])));
  const spks = sha(Uint8Array.from(inputs.flatMap((i) => [...varint(i.spk.length), ...i.spk])));
  const sequences = sha(Uint8Array.from(seqs.flatMap((s) => [...u32le(s)])));
  const outs = sha(Uint8Array.from(outputs.flatMap((o) => {
    const s = p2trScriptPubKey(o.program);
    return [...u64le(o.value), ...varint(s.length), ...s];
  })));
  const leafHash = tapLeafHash(leafScript);
  const msg = Uint8Array.from([
    0x00, 0x00, ...u32le(network.txVersion), ...u32le(locktime),
    ...prevouts, ...amounts, ...spks, ...sequences, ...outs,
    0x01, // spend_type: script path, no annex
    ...u32le(idx),
    ...leafHash, 0x00, 0xff, 0xff, 0xff, 0xff, // leaf hash, key version 0, codesep 0xffffffff
  ]);
  return taggedHash("TapSighash", msg);
}

/* ---------------- vBytes + fee planning ---------------- */

const varintLen = (n) => (n < 0xfd ? 1 : n <= 0xffff ? 3 : n <= 0xffffffff ? 5 : 9);

/** Exact vBytes for an m-of-n quorum spend: every input carries n witness
 *  slots (m 64-byte signatures + (n-m) empty vectors for non-signers) + the
 *  script + the 33-byte single-leaf control block. The test suite
 *  cross-checks this against the actually-built tx. */
export function quorumTxVBytes({ nIn, nOut, scriptLen, m, n }) {
  if (!Number.isSafeInteger(nIn) || nIn < 1) throw new Error("bad nIn");
  if (!Number.isSafeInteger(nOut) || nOut < 1) throw new Error("bad nOut");
  if (!Number.isSafeInteger(scriptLen) || scriptLen <= 0) throw new Error("bad scriptLen");
  if (!Number.isSafeInteger(m) || m < 1) throw new Error("bad m");
  if (!Number.isSafeInteger(n) || n < m) throw new Error("bad n");
  const controlLen = 33;
  let wit = varintLen(n + 2); // witness item count per input
  wit += m * (varintLen(64) + 64);
  wit += (n - m) * varintLen(0); // empty vector per non-signer
  wit += varintLen(scriptLen) + scriptLen + varintLen(controlLen) + controlLen;
  const base = 4 + varintLen(nIn) + nIn * 41 + varintLen(nOut) + nOut * 43 + 4;
  return Math.ceil((base * 3 + (base + 2 + wit * nIn)) / 4);
}

/** Validate one funding input against the vault (script byte-comparison —
 *  foreign scripts are refused, like the audited solvency core). */
export function assertVaultInput(vault, input) {
  if (!/^[0-9a-f]{64}$/i.test(input.txid || "")) throw new Error("bad input txid");
  if (!Number.isInteger(input.vout) || input.vout < 0) throw new Error("bad input vout");
  if (!Number.isSafeInteger(input.value) || input.value <= 0) throw new Error("bad input value");
  const spk = input.spk instanceof Uint8Array ? input.spk : hexToBytes(String(input.spkHex || ""));
  const want = hexToBytes(vault.spkHex);
  if (spk.length !== want.length) throw new Error("input script is not the vault script — foreign input refused");
  for (let i = 0; i < want.length; i++) {
    if (spk[i] !== want[i]) throw new Error("input script is not the vault script — foreign input refused");
  }
  return { txid: input.txid.toLowerCase(), vout: input.vout, value: input.value, spk: want };
}

/** Plan a quorum spend: coin math is grain-exact; change returns to the vault
 *  address; dust change is absorbed into the fee and DISCLOSED. */
export function planQuorumSpend({ vault, inputs, payments, feeRateGrainsPerVByte, feeRateSource = "manual" }) {
  const net = NETWORKS[vault.network];
  if (!net) throw new Error("unknown vault network");
  if (!Array.isArray(inputs) || inputs.length === 0) throw new Error("no inputs selected");
  if (!Array.isArray(payments) || payments.length === 0) throw new Error("no payments");
  const rate = Number(feeRateGrainsPerVByte);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("fee rate must be positive");
  const ins = inputs.map((u) => assertVaultInput(vault, u));
  const outs = payments.map((p, i) => {
    let program;
    try {
      const d = decodeBech32m(String(p.address || "").trim(), net.hrp);
      if (d.version !== 1 || d.program.length !== 32) throw new Error("not a v1 Taproot address");
      program = d.program;
    } catch (e) { throw new Error(`payment ${i + 1}: invalid address — ${e.message || e}`); }
    const value = Number(p.grains);
    if (!Number.isSafeInteger(value) || value < DUST_GRAIN) throw new Error(`payment ${i + 1}: below dust floor (${DUST_GRAIN} grains)`);
    return { program, value };
  });
  const scriptLen = hexToBytes(vault.scriptHex).length;
  // Candidate A: with a change output. Candidate B: without (dust absorbed).
  const vBytesC = quorumTxVBytes({ nIn: ins.length, nOut: outs.length + 1, scriptLen, m: vault.m, n: vault.n });
  const feeC = Math.ceil(vBytesC * rate);
  const inSum = ins.reduce((a, u) => a + u.value, 0);
  const paySum = outs.reduce((a, o) => a + o.value, 0);
  const changeA = inSum - paySum - feeC;
  if (changeA < 0) throw new Error(`insufficient funds: inputs ${fmtPRL(inSum)} < payments ${fmtPRL(paySum)} + fee ${fmtPRL(feeC)} — add inputs or lower the fee rate`);
  const vaultProgram = hexToBytes(vault.spkHex).slice(2); // strip 0x5120
  let finalOuts, vBytes, fee, change = 0, dustAbsorbed = 0;
  if (changeA >= DUST_GRAIN) {
    finalOuts = outs.concat([{ program: vaultProgram, value: changeA, isChange: true }]);
    vBytes = vBytesC;
    fee = feeC;
    change = changeA;
  } else {
    // No change output: everything left after payments + the no-change fee is
    // absorbed into the fee. Disclosed exactly — never silently pocketed.
    const vBytesNC = quorumTxVBytes({ nIn: ins.length, nOut: outs.length, scriptLen, m: vault.m, n: vault.n });
    const feeNC = Math.ceil(vBytesNC * rate);
    const leftover = inSum - paySum - feeNC; // >= changeA >= 0
    finalOuts = outs.slice();
    vBytes = vBytesNC;
    dustAbsorbed = leftover;
    fee = feeNC + leftover; // == inSum - paySum: outputs + fee balance exactly
  }
  const digests = ins.map((_, i) => bytesToHex(quorumSigDigest(net, ins, i, finalOuts, hexToBytes(vault.scriptHex))));
  const plan = {
    bundle: QUORUM_BUNDLE_KIND,
    vaultFingerprint: vault.fingerprint,
    vaultName: vault.name,
    network: vault.network,
    m: vault.m,
    n: vault.n,
    pubkeys: vault.pubkeys,
    internalKeyMode: vault.internalKeyMode,
    internalXOnlyHex: vault.internalXOnlyHex,
    address: vault.address,
    spkHex: vault.spkHex,
    scriptHex: vault.scriptHex,
    controlBlockHex: vault.controlBlockHex,
    inputs: ins.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, spkHex: bytesToHex(u.spk) })),
    outputs: finalOuts.map((o) => ({ address: encodeBech32m(net.hrp, 1, o.program), grains: o.value, ...(o.isChange ? { isChange: true } : {}) })),
    feeRateGrainsPerVByte: rate,
    feeRateSource,
    feeGrains: fee,
    changeGrains: change,
    dustAbsorbedGrains: dustAbsorbed,
    vBytes,
    digests,
  };
  plan.fingerprint = descriptorFingerprint(plan);
  return plan;
}

/* ---------------- unsigned bundle export/import ---------------- */

/** Serialize a spend plan as a tamper-evident text bundle: the kind tag is a
 *  TEXT PREFIX (not just a JSON field), so a bundle pasted into the wrong
 *  field — or a JSON blob masquerading as a bundle — is refused on sight. */
export function exportUnsignedBundle(plan) {
  if (!plan || plan.bundle !== QUORUM_BUNDLE_KIND) throw new Error("not a quorum spend plan");
  const { fingerprint, ...rest } = plan;
  const fp = descriptorFingerprint(rest);
  if (fp !== fingerprint) throw new Error("plan fingerprint mismatch — refusing to export a tampered plan");
  return QUORUM_BUNDLE_KIND + canonicalJson(plan);
}

/** Import + re-derive: recomputes vBytes, fee, change, and every input digest
 *  from the bundle's own fields and REFUSES on any mismatch. */
export function importUnsignedBundle(text) {
  const t = String(text ?? "");
  if (!t.startsWith(QUORUM_BUNDLE_KIND)) {
    throw new Error("not a pearl-quorum-unsigned:v1: bundle (missing kind prefix — refusing to parse bare JSON)");
  }
  let b;
  try { b = JSON.parse(t.slice(QUORUM_BUNDLE_KIND.length)); }
  catch { throw new Error("bundle is not valid JSON"); }
  if (!b || b.bundle !== QUORUM_BUNDLE_KIND) throw new Error("not a pearl-quorum-unsigned:v1: bundle");
  const vault = importDescriptorFromBundle(b);
  // The change output (flagged isChange) is not a payment — strip it before
  // re-planning so the re-derivation matches the original plan exactly.
  const plan = planQuorumSpend({
    vault,
    inputs: b.inputs,
    payments: b.outputs.filter((o) => !o.isChange).map((o) => ({ address: o.address, grains: o.grains })),
    feeRateGrainsPerVByte: b.feeRateGrainsPerVByte,
    feeRateSource: b.feeRateSource || "bundle",
  });
  // The re-derived plan must match the bundle field-for-field on the
  // security-critical values (digests, fee, fingerprint).
  for (let i = 0; i < plan.digests.length; i++) {
    if (plan.digests[i] !== b.digests[i]) throw new Error(`BUNDLE REFUSED: digest ${i} does not re-derive — tampered bundle`);
  }
  if (plan.feeGrains !== b.feeGrains) throw new Error("BUNDLE REFUSED: fee does not re-derive — tampered bundle");
  if (plan.fingerprint !== b.fingerprint) throw new Error("BUNDLE REFUSED: fingerprint mismatch — tampered bundle");
  return b;
}

/** Rebuild the vault object from a bundle's embedded vault fields (the bundle
 *  carries everything needed; createVault re-derives and cross-checks). */
function importDescriptorFromBundle(b) {
  let slot = 0;
  if ((b.internalKeyMode || "nums") === "cosigner") {
    slot = (b.pubkeys || []).findIndex((k) => String(k).toLowerCase() === String(b.internalXOnlyHex || "").toLowerCase());
    if (slot < 0) throw new Error("BUNDLE REFUSED: cannot locate the designated internal key among the cosigner keys");
  }
  const v = createVault({
    name: b.vaultName || "imported vault",
    network: b.network,
    m: b.m,
    keys: b.pubkeys,
    internalKeyMode: b.internalKeyMode || "nums",
    internalKeySlot: slot,
  });
  if (v.address !== b.address) throw new Error("BUNDLE REFUSED: vault address does not re-derive");
  if (v.spkHex !== b.spkHex) throw new Error("BUNDLE REFUSED: vault script does not re-derive");
  if (b.vaultFingerprint && v.fingerprint !== b.vaultFingerprint) throw new Error("BUNDLE REFUSED: vault fingerprint mismatch");
  return v;
}

/* ---------------- cosigning ---------------- */

/** Local sign: cosigner `slot` signs EVERY input digest with their private
 *  key. The key's x-only pubkey MUST equal the slot's vault key (loud refusal
 *  otherwise). Every signature is re-verified before it is emitted. Returns
 *  a signature bundle for that slot. */
export function signSlot({ bundle, slot, privHex }) {
  if (!bundle || bundle.bundle !== QUORUM_BUNDLE_KIND) throw new Error("not a quorum unsigned bundle");
  const s = Number(slot);
  if (!Number.isInteger(s) || s < 0 || s >= bundle.n) throw new Error(`slot must be 0..${bundle.n - 1}`);
  const p = hexToBytes(String(privHex || "").trim());
  if (p.length !== 32) throw new Error("private key must be 32 hex bytes");
  const d = bytesToNumberBE(p);
  if (d <= 0n || d >= secp256k1.CURVE.n) throw new Error("private key out of range");
  const pub = bytesToHex(schnorr.getPublicKey(p)); // 32-byte x-only
  if (pub !== bundle.pubkeys[s].toLowerCase()) {
    throw new Error(`KEY REFUSED: this key's pubkey ${pub.slice(0, 12)}… is not cosigner slot ${s + 1} (${bundle.pubkeys[s].slice(0, 12)}…) — wrong slot or wrong key`);
  }
  const sigs = bundle.digests.map((dg, i) => {
    const sig = bytesToHex(signForXOnly(p, hexToBytes(dg)));
    if (!verifySchnorrSig(sig, dg, pub)) throw new Error(`self-check failed on input ${i} — refusing to emit a bad signature`);
    return sig;
  });
  const sigBundle = {
    bundle: QUORUM_SIGBUNDLE_KIND,
    fingerprint: bundle.fingerprint,
    vaultFingerprint: bundle.vaultFingerprint,
    slot: s,
    pubkey: pub,
    sigs,
  };
  sigBundle.sigFingerprint = descriptorFingerprint(sigBundle);
  return sigBundle;
}

/** Signature bundles travel as text too: kind tag as TEXT PREFIX, same as the
 *  unsigned bundle. collectSigs still takes parsed objects. */
export function exportSigBundleText(sb) {
  if (!sb || sb.bundle !== QUORUM_SIGBUNDLE_KIND) throw new Error("not a quorum signature bundle");
  return QUORUM_SIGBUNDLE_KIND + canonicalJson(sb);
}
export function importSigBundleText(text) {
  const t = String(text ?? "");
  if (!t.startsWith(QUORUM_SIGBUNDLE_KIND)) {
    throw new Error("not a pearl-quorum-sigs:v1: bundle (missing kind prefix — refusing to parse bare JSON)");
  }
  let sb;
  try { sb = JSON.parse(t.slice(QUORUM_SIGBUNDLE_KIND.length)); }
  catch { throw new Error("signature bundle is not valid JSON"); }
  if (!sb || sb.bundle !== QUORUM_SIGBUNDLE_KIND) throw new Error("not a pearl-quorum-sigs:v1: bundle");
  return sb;
}

/** Collect + verify signature bundles against the unsigned bundle. Every
 *  signature is re-verified with the audited Schnorr verifier before it
 *  counts; a bad signature is reported, never counted. */
export function collectSigs(bundle, sigBundles) {
  if (!bundle || bundle.bundle !== QUORUM_BUNDLE_KIND) throw new Error("not a quorum unsigned bundle");
  const perSlot = new Map(); // slot -> sigBundle
  const problems = [];
  for (const sb of sigBundles || []) {
    try {
      if (!sb || sb.bundle !== QUORUM_SIGBUNDLE_KIND) throw new Error("not a pearl-quorum-sigs:v1: bundle");
      if (sb.fingerprint !== bundle.fingerprint) throw new Error("signature bundle is for a DIFFERENT spend (fingerprint mismatch)");
      const s = Number(sb.slot);
      if (!Number.isInteger(s) || s < 0 || s >= bundle.n) throw new Error(`slot ${sb.slot} out of range`);
      if (perSlot.has(s)) throw new Error(`duplicate signatures from slot ${s + 1} — first valid set wins`);
      if (!Array.isArray(sb.sigs) || sb.sigs.length !== bundle.digests.length) throw new Error("signature count does not match input count");
      if (String(sb.pubkey || "").toLowerCase() !== bundle.pubkeys[s].toLowerCase()) throw new Error("claimed pubkey does not match the vault key for this slot");
      for (let i = 0; i < sb.sigs.length; i++) {
        if (!verifySchnorrSig(sb.sigs[i], bundle.digests[i], bundle.pubkeys[s])) {
          throw new Error(`signature for input ${i + 1} does NOT verify against slot ${s + 1}'s key`);
        }
      }
      perSlot.set(s, sb);
    } catch (e) {
      problems.push(e.message);
    }
  }
  const counts = bundle.digests.map((_, i) => perSlot.size); // all inputs share the same slots
  return {
    slots: [...perSlot.keys()].sort((a, b) => a - b),
    perSlot,
    problems,
    counts,
    thresholdMet: bundle.digests.map(() => perSlot.size >= bundle.m),
    quorumReached: perSlot.size >= bundle.m,
  };
}

/** Assemble + serialize the fully-signed quorum spend. Refuses unless every
 *  input has m of n VALID signatures. Witness: reverse key order with empty
 *  vectors for non-signers (BIP-342 CHECKSIGADD stack mechanics, same as the
 *  audited escrow leaf). */
export function finalizeSpend(bundle, sigBundles, opts = {}) {
  const net = NETWORKS[bundle.network];
  if (!net) throw new Error("unknown bundle network");
  const collected = collectSigs(bundle, sigBundles);
  if (collected.problems.length) throw new Error(`FINALIZE REFUSED: ${collected.problems[0]}`);
  if (!collected.quorumReached) {
    throw new Error(`FINALIZE REFUSED: ${collected.slots.length} of ${bundle.m} required signatures collected — quorum not reached`);
  }
  const leafScript = hexToBytes(bundle.scriptHex);
  const controlBlock = hexToBytes(bundle.controlBlockHex);
  const spk = hexToBytes(bundle.spkHex);
  const outputs = bundle.outputs.map((o) => {
    const d = decodeBech32m(o.address, net.hrp);
    return { program: d.program, value: o.grains };
  });
  const sequences = opts.sequences || bundle.inputs.map(() => MAX_SEQ);
  const locktime = opts.locktime || 0;
  const nIn = bundle.inputs.length, nOut = outputs.length;
  const base = [...u32le(net.txVersion), ...varint(nIn)];
  for (let i = 0; i < nIn; i++) {
    const u = bundle.inputs[i];
    base.push(...txidLE(u.txid), ...u32le(u.vout), 0x00, ...u32le(sequences[i]));
  }
  base.push(...varint(nOut));
  for (const o of outputs) {
    const s = p2trScriptPubKey(o.program);
    base.push(...u64le(o.value), ...varint(s.length), ...s);
  }
  base.push(...u32le(locktime));
  const baseBytes = Uint8Array.from(base);
  // Witnesses: per input, sigs in REVERSE key order, empty vector for non-signers.
  const wit = [];
  for (let i = 0; i < nIn; i++) {
    const items = [];
    for (let slot = bundle.n - 1; slot >= 0; slot--) {
      const sb = collected.perSlot.get(slot);
      items.push(sb ? hexToBytes(sb.sigs[i]) : EMPTY);
    }
    wit.push(...varint(items.length + 2));
    for (const it of items) wit.push(...varint(it.length), ...it);
    wit.push(...varint(leafScript.length), ...leafScript);
    wit.push(...varint(controlBlock.length), ...controlBlock);
  }
  const full = Uint8Array.from([...u32le(net.txVersion), 0x00, 0x01, ...base.slice(4), ...wit]);
  const vBytes = Math.ceil((baseBytes.length * 3 + full.length) / 4);
  if (vBytes !== bundle.vBytes) throw new Error(`FINALIZE REFUSED: rebuilt vBytes ${vBytes} != planned ${bundle.vBytes}`);
  const txid = bytesToHex(dblSha(baseBytes).reverse());
  const hex = bytesToHex(full);
  // Defense in depth: every emitted signature re-verified one last time.
  for (const slot of collected.slots) {
    const sb = collected.perSlot.get(slot);
    for (let i = 0; i < nIn; i++) {
      if (!verifySchnorrSig(sb.sigs[i], bundle.digests[i], bundle.pubkeys[slot])) {
        throw new Error(`FINALIZE REFUSED: slot ${slot + 1} input ${i + 1} signature failed final re-verification`);
      }
    }
  }
  return { txid, hex, vBytes, feeGrains: bundle.feeGrains, slots: collected.slots };
}

/* ---------------- history ledger (localStorage-backed; pure helpers here) ---------------- */

export function vaultToCSV(vaults) {
  const rows = [["name", "network", "m", "n", "address", "fingerprint", "internal_key_mode"]];
  for (const v of vaults || []) rows.push([v.name, v.network, v.m, v.n, v.address, v.fingerprint, v.internalKeyMode]);
  return rows.map((r) => r.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
}

export function spendsToCSV(spends) {
  const rows = [["at", "vault", "txid", "inputs", "outputs_grains", "fee_grains", "slots"]];
  for (const s of spends || []) {
    rows.push([s.at, s.vault, s.txid, s.inputs, s.outputsGrains, s.feeGrains, (s.slots || []).join("+")]);
  }
  return rows.map((r) => r.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
}
