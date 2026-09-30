// Pearl Vault core — m-of-n Taproot multisig safe (pure logic, no DOM).
//
// Design: a single CHECKSIGADD script leaf under a NUMS (nothing-up-my-sleeve)
// internal key, so coins can ONLY move through the multisig leaf — there is
// no keypath backdoor. Cosigners coordinate through unsigned JSON bundles and
// partial-signature JSON; every partial signature is re-verified against the
// claimed cosigner key and the exact per-input BIP-341 script-path digest
// before it is accepted.
//
// NO NEW CRYPTOGRAPHY: all hashing, bech32m, Taproot math, Schnorr signing
// and Blockbook I/O comes from the audited Sign core
// (../../sign/src/crypto.js). The CHECKSIGADD script mechanics and the
// BIP-340 odd-Y negation follow the escrow app's audited escrow-core.js
// verbatim; the NUMS internal-key derivation follows the fund app's audited
// fund-core.js. The only new code is deterministic arithmetic: the
// multi-input BIP-341 sighash generalization, the script-path vBytes formula,
// and descriptor canonicalization — all pinned by tests below.
//
// CHECKSIGADD stack mechanics (from node/txscript/opcode.go, verified in the
// escrow app): the script pushes <0> then each key, so per key the stack
// triple is [sig, 0, K] -> CHECKSIGADD -> [count+1]. Because the LAST witness
// element is consumed FIRST, the witness must list the m signatures in
// REVERSE script-key order, with an empty vector for each key that did not
// sign.
//
// Protocol facts (verified against upstream, not from memory):
//  - P2TR dust 546 grains, tx version 1, bech32m HRPs prl/tprl,
//    BIP-86 coin types 808276 (mainnet) / 1 (testnet).
//  - TapLeaf/TapBranch/TapTweak tags + branch sort: BIP-341; the single-leaf
//    case matches commitKeyInfo() in sign/src/crypto.js.
//  - SIGHASH_DEFAULT for script path: BIP-341 (0x00 spend byte, no annex).
import {
  taggedHash, tapLeafHash, encodeBech32m, decodeBech32m, commitKeyInfo,
  schnorr, sha256, bytesToHex, hexToBytes,
  varint, u32le, u64le, p2trScriptPubKey, txidLE, dblSha,
  DUST_GRAIN, GRAIN_PER_PRL, NETWORKS,
  walletFromMnemonic, walletFromWIF, walletFromPriv,
  fetchUtxos, fetchFeeRateGrainsPerVByte, broadcastTx,
} from "../../sign/src/crypto.js";
import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesToNumberBE, numberToBytesBE } from "@noble/curves/abstract/utils";

export {
  DUST_GRAIN, GRAIN_PER_PRL, NETWORKS,
  fetchUtxos, fetchFeeRateGrainsPerVByte, broadcastTx,
  bytesToHex, hexToBytes, sha256, schnorr,
  encodeBech32m, decodeBech32m, commitKeyInfo,
};

/** Normalize a Blockbook base URL (same rule as the watch app). */
export function normalizeBlockbookBase(s) {
  const t = String(s ?? "").trim().replace(/\/$/, "");
  if (!t) throw new Error("VAULT REFUSED: Blockbook URL is empty — set one or stay offline");
  if (!/^https?:\/\//.test(t)) throw new Error("VAULT REFUSED: Blockbook URL must start with http(s)://");
  return t;
}

const OP = {
  FALSE: 0x00,
  CHECKSIGADD: 0xba,
  EQUAL: 0x87,
};
const OP_1 = 0x51;
const TAPLEAF_VERSION = 0xc0;
const EMPTY = new Uint8Array(0);
const MAX_SEQ = 0xffffffff;
const MAX_COSIGNERS = 5;
const NUMS_DOMAIN = "PearlVaultNUMS/v1";
const DESCRIPTOR_PREFIX = "pearlvault:v1";

const te = new TextEncoder();
const utf8 = (s) => te.encode(s);

function pushData(data) {
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

function varintLen(n) {
  if (n < 0xfd) return 1;
  if (n <= 0xffff) return 3;
  if (n <= 0xffffffff) return 5;
  return 9;
}

/** u64 little-endian that accepts BigInt (sign core's u64le takes Number). */
function u64leBig(n) {
  const v = BigInt(n);
  if (v < 0n || v >= 1n << 64n) throw new Error("VAULT REFUSED: u64 value out of range");
  const out = new Uint8Array(8);
  let x = v;
  for (let i = 0; i < 8; i++) { out[i] = Number(x & 0xffn); x >>= 8n; }
  return out;
}

/* ---------------- cosigner keys ---------------- */

/** Validate a 64-hex-char x-only pubkey (also rejects x >= field prime). */
export function parseXOnlyKey(hex) {
  if (typeof hex !== "string" || !/^[0-9a-fA-F]{64}$/.test(hex.trim())) {
    throw new Error("VAULT REFUSED: x-only pubkey must be 64 hex characters");
  }
  const b = hexToBytes(hex.trim().toLowerCase());
  assertXOnly(b);
  return b;
}

/** lift_x check with a loud VAULT REFUSED error (x >= p is not a key). */
function assertXOnly(b) {
  try {
    schnorr.utils.lift_x(bytesToNumberBE(b));
  } catch {
    throw new Error("VAULT REFUSED: not a valid secp256k1 x-coordinate (x >= field prime)");
  }
}

/**
 * Accept a cosigner key as:
 *   - 64-hex x-only pubkey (watch-only; cannot sign),
 *   - 64-hex private key (local signing key),
 *   - 12/24-word BIP-39 mnemonic (BIP-86 account key, local),
 *   - WIF (local).
 * Returns { xonly, priv|null, source }. priv is null for watch-only keys.
 */
export function cosignerKeyFromInput(input, network) {
  const t = String(input || "").trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) {
    // Ambiguous: 64 hex could be a private key OR an x-only pubkey. A pubkey
    // that is also a valid scalar is astronomically unlikely to be meant as
    // a privkey, but guessing is not allowed: the UI passes an explicit
    // `kind` hint; here bare 64-hex means x-only pubkey (watch-only).
    return { xonly: parseXOnlyKey(t), priv: null, source: "x-only pubkey (watch-only)" };
  }
  if (/^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{50,53}$/.test(t)) {
    try {
      const w = walletFromWIF(t, network);
      return { xonly: w.internalXOnly, priv: w.priv, source: "WIF (local signing key)" };
    } catch (e) {
      throw new Error(`VAULT REFUSED: bad WIF (${e.message})`);
    }
  }
  const words = t.split(/\s+/);
  if (words.length === 12 || words.length === 24) {
    try {
      const w = walletFromMnemonic(t, network);
      return { xonly: w.internalXOnly, priv: w.priv, source: "mnemonic BIP-86 (local signing key)" };
    } catch (e) {
      throw new Error(`VAULT REFUSED: bad mnemonic (${e.message})`);
    }
  }
  throw new Error("VAULT REFUSED: cosigner key must be a 64-hex x-only pubkey, 64-hex private key, WIF, or a 12/24-word mnemonic");
}

/** Explicit private-key entry (64 hex) — never guessed from bare input. */
export function cosignerPrivFromHex(hex, network) {
  const t = String(hex || "").trim();
  if (!/^[0-9a-fA-F]{64}$/.test(t)) throw new Error("VAULT REFUSED: private key must be 64 hex characters");
  const p = hexToBytes(t.toLowerCase());
  const d = bytesToNumberBE(p);
  if (d <= 0n || d >= secp256k1.CURVE.n) throw new Error("VAULT REFUSED: private key out of range");
  const w = walletFromPriv(p, network);
  return { xonly: w.internalXOnly, priv: p, source: "private key hex (local signing key)" };
}

/* ---------------- multisig script ---------------- */

/**
 * m-of-n CHECKSIGADD script:
 *   <0> <K1> CHECKSIGADD <K2> CHECKSIGADD ... <Kn> CHECKSIGADD <m> EQUAL
 * Witness: the m signatures in REVERSE key order, empty vector per
 * non-signing key, then the script, then the control block.
 */
export function buildMultisigScript(keys, m) {
  const ks = keys.map((k) => (k instanceof Uint8Array ? k : parseXOnlyKey(k)));
  const n = ks.length;
  if (!Number.isInteger(m) || m < 1 || m > n) throw new Error("VAULT REFUSED: m must be between 1 and n");
  if (n < 2) throw new Error("VAULT REFUSED: a vault needs at least 2 cosigners (use Pearl Sign for single-key)");
  if (n > MAX_COSIGNERS) throw new Error(`VAULT REFUSED: at most ${MAX_COSIGNERS} cosigners`);
  for (const k of ks) {
    if (k.length !== 32) throw new Error("VAULT REFUSED: cosigner key must be 32 bytes");
    assertXOnly(k);
  }
  const seen = new Set(ks.map((k) => bytesToHex(k)));
  if (seen.size !== n) throw new Error("VAULT REFUSED: duplicate cosigner key — every cosigner must be unique");
  const s = [OP.FALSE];
  for (const k of ks) s.push(...pushData(k), OP.CHECKSIGADD);
  s.push(OP_1 + m - 1, OP.EQUAL);
  return { script: Uint8Array.from(s), keys: ks, m, n };
}

/* ---------------- NUMS internal key ---------------- */

/**
 * NUMS internal key: lift_x(SHA-256("PearlVaultNUMS/v1" || m || n || K1..Kn)).
 * Nobody knows the discrete log, so keypath spending is impossible — coins
 * move only through the multisig leaf. Deterministic and recomputable from
 * the descriptor; the counter fallback exists only for the
 * astronomically-unlikely x >= p case.
 */
export function numsInternalKeyVault(m, n, keys) {
  const ks = keys.map((k) => (k instanceof Uint8Array ? k : parseXOnlyKey(k)));
  const preimage = Uint8Array.from([utf8(NUMS_DOMAIN), Uint8Array.of(m, n), ...ks].flatMap((x) => [...x]));
  for (let counter = 0; counter < 256; counter++) {
    const pre = counter === 0 ? preimage : Uint8Array.from([...preimage, counter]);
    const h = sha256(pre);
    try {
      schnorr.utils.lift_x(bytesToNumberBE(h));
      return h;
    } catch { /* try next counter */ }
  }
  throw new Error("VAULT REFUSED: NUMS lift failed (unreachable in practice)");
}

/* ---------------- vault taptree (single leaf) ---------------- */

/**
 * Single-leaf taptree under the NUMS internal key. Returns the vault address,
 * 33-byte control block, tweaked x-only key and scriptPubKey.
 * Matches commitKeyInfo() in sign/src/crypto.js (BIP-341 single-leaf case).
 */
export function vaultTaptree(network, internalXOnly, script) {
  const info = commitKeyInfo(network, internalXOnly, script);
  return {
    address: info.commitAddress,
    controlBlock: info.controlBlock, // 33 bytes: header + internal key (empty path)
    tweakedX: info.commitXOnly,
    spk: p2trScriptPubKey(info.commitXOnly),
    merkleRoot: info.merkleRoot,
    internalXOnly,
    script,
  };
}

/* ---------------- descriptor ---------------- */

function canonicalVaultJson(o) {
  // Canonical form: fixed key order, no whitespace. The hash commits to this.
  return JSON.stringify({
    kind: "pearl-vault-descriptor:v1",
    network: o.network,
    m: o.m,
    n: o.n,
    keys: o.keys,
    internalXOnly: o.internalXOnly,
    address: o.address,
    script: o.script,
    controlBlock: o.controlBlock,
  });
}

/**
 * Build the full vault descriptor from cosigner inputs. Throws loudly on
 * any invalid input — a descriptor is only ever built from valid keys.
 */
export function buildVaultDescriptor(network, keyInputs, m) {
  const parsed = keyInputs.map((inp) => cosignerKeyFromInput(inp, network));
  const { script, keys, m: mm, n } = buildMultisigScript(parsed.map((p) => p.xonly), m);
  const internalXOnly = numsInternalKeyVault(mm, n, keys);
  const tree = vaultTaptree(network, internalXOnly, script);
  const body = {
    network: network.id,
    m: mm,
    n,
    keys: keys.map((k) => bytesToHex(k)),
    internalXOnly: bytesToHex(internalXOnly),
    address: tree.address,
    script: bytesToHex(script),
    controlBlock: bytesToHex(tree.controlBlock),
  };
  const canonical = canonicalVaultJson(body);
  const hash = bytesToHex(sha256(utf8(canonical)));
  return {
    ...body,
    canonical,
    hash,
    descriptor: `${DESCRIPTOR_PREFIX}:${network.hrp}:${mm}:${n}:${hash}`,
    tweakedX: bytesToHex(tree.tweakedX),
    spk: bytesToHex(tree.spk),
    merkleRoot: bytesToHex(tree.merkleRoot),
  };
}

/** Parse a `pearlvault:v1:<hrp>:<m>:<n>:<hash>` descriptor string. */
export function parseDescriptorString(s) {
  const t = String(s || "").trim();
  const m = t.match(/^pearlvault:v1:([a-z0-9]+):(\d+):(\d+):([0-9a-f]{64})$/);
  if (!m) throw new Error("VAULT REFUSED: not a pearlvault:v1 descriptor string");
  return { hrp: m[1], m: Number(m[2]), n: Number(m[3]), hash: m[4] };
}

/**
 * Standalone verifier: re-derive the vault address from a descriptor's
 * canonical JSON and rule PROVEN or NOT PROVEN. Takes the parsed descriptor
 * object (as produced by buildVaultDescriptor / JSON download).
 */
export function verifyDescriptor(d) {
  const fail = (reason) => ({ ok: false, reason });
  try {
    if (!d || d.network == null || !Number.isInteger(d.m) || !Number.isInteger(d.n)) {
      return fail("descriptor is missing network/m/n");
    }
    const network = Object.values(NETWORKS).find((x) => x.id === d.network);
    if (!network) return fail(`unknown network ${JSON.stringify(String(d.network).slice(0, 20))}`);
    if (!Array.isArray(d.keys) || d.keys.length !== d.n) return fail("keys array does not match n");
    const { script, keys } = buildMultisigScript(d.keys, d.m); // re-validates keys, m, n, uniqueness
    const internalXOnly = numsInternalKeyVault(d.m, d.n, keys);
    if (bytesToHex(internalXOnly) !== String(d.internalXOnly).toLowerCase()) {
      return fail("internal key does not re-derive — descriptor tampered");
    }
    const tree = vaultTaptree(network, internalXOnly, script);
    if (tree.address !== d.address) return fail("address does not re-derive — descriptor tampered");
    if (bytesToHex(tree.controlBlock) !== String(d.controlBlock).toLowerCase()) {
      return fail("control block does not re-derive — descriptor tampered");
    }
    if (bytesToHex(script) !== String(d.script).toLowerCase()) return fail("script does not re-derive — descriptor tampered");
    const canonical = canonicalVaultJson({
      network: d.network, m: d.m, n: d.n, keys: keys.map((k) => bytesToHex(k)),
      internalXOnly: bytesToHex(internalXOnly), address: tree.address,
      script: bytesToHex(script), controlBlock: bytesToHex(tree.controlBlock),
    });
    if (bytesToHex(sha256(utf8(canonical))) !== String(d.hash).toLowerCase()) {
      return fail("descriptor hash does not match canonical JSON — descriptor tampered");
    }
    return { ok: true, address: tree.address, m: d.m, n: d.n, network: network.id };
  } catch (e) {
    return fail(`verification error: ${e.message}`);
  }
}

/* ---------------- vault state (GET-only) ---------------- */

/**
 * Read the vault's on-chain state: confirmed balance + UTXO list.
 * GET-only Blockbook reads; the page never needs keys.
 */
export async function fetchVaultState(blockbookBase, address) {
  const base = normalizeBlockbookBase(blockbookBase);
  let res;
  try {
    res = await fetch(`${base}/api/v2/address/${encodeURIComponent(address)}`);
  } catch (e) {
    throw new Error(`VAULT REFUSED: blockbook unreachable (${e.message})`);
  }
  if (!res.ok) throw new Error(`VAULT REFUSED: blockbook ${res.status} on address lookup`);
  const data = JSON.parse(await res.text());
  const utxos = await fetchUtxos(base, address);
  return {
    address,
    balance: BigInt(String(data.balance ?? "0")),
    totalReceived: BigInt(String(data.totalReceived ?? "0")),
    txCount: Number(data.txCount ?? 0),
    utxos: utxos.map((u) => ({
      txid: u.txid, vout: u.vout,
      value: BigInt(String(u.value)),
      confirmations: u.confirmations ?? 0,
    })),
  };
}

/* ---------------- address validation ---------------- */

/** Validate a prl1/tprl1 recipient address for the vault's network. */
export function validateVaultAddress(address, network) {
  const t = String(address || "").trim().toLowerCase();
  if (!t) throw new Error("VAULT REFUSED: address is empty");
  let dec;
  try {
    dec = decodeBech32m(t);
  } catch (e) {
    throw new Error(`VAULT REFUSED: not a valid bech32m address (${e.message})`);
  }
  if (dec.hrp !== network.hrp) {
    throw new Error(`VAULT REFUSED: address is ${dec.hrp}1…, this vault is ${network.hrp}1 (${network.id})`);
  }
  if (dec.version !== 1 || dec.program.length !== 32) {
    throw new Error("VAULT REFUSED: Pearl addresses are witness v1 with a 32-byte program");
  }
  return t;
}

/** Exact decimal PRL string -> grains (BigInt). */
export function prlToGrains(s) {
  const t = String(s || "").trim();
  const m = t.match(/^(\d+)(?:\.(\d{1,8}))?$/);
  if (!m) throw new Error(`VAULT REFUSED: bad PRL amount ${JSON.stringify(t.slice(0, 40))}`);
  const g = BigInt(m[1]) * 100_000_000n + (m[2] ? BigInt(m[2].padEnd(8, "0")) : 0n);
  if (g <= 0n) throw new Error("VAULT REFUSED: amount must be positive");
  return g;
}

export function grainsToPRL(g) {
  const x = BigInt(g);
  const neg = x < 0n;
  const ax = neg ? -x : x;
  const whole = ax / 100_000_000n;
  const frac = (ax % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return (neg ? "-" : "") + whole.toString() + (frac ? "." + frac : "");
}

/* ---------------- script-path vBytes ---------------- */

/**
 * Exact vBytes of a script-path multisig spend.
 * Non-witness bytes: ver(4) + vin count + nIn*41 + vout count + nOut*34 + locktime(4).
 * Per input witness: stack-count(1) + per cosigner (65B signed / 1B empty) +
 *   script push (varint + script) + control block push (1 + 33).
 * Segwit weight: 4*base + 2 (marker+flag) + witness; vBytes = ceil(weight/4).
 */
export function scriptPathVBytes(nIn, nOut, scriptLen, nCosigners, nSigs) {
  if (!Number.isInteger(nIn) || nIn < 1) throw new Error("VAULT REFUSED: nIn must be >= 1");
  if (!Number.isInteger(nOut) || nOut < 1) throw new Error("VAULT REFUSED: nOut must be >= 1");
  if (nSigs > nCosigners) throw new Error("VAULT REFUSED: more signatures than cosigners");
  const base = 4 + varintLen(nIn) + nIn * 41 + varintLen(nOut) + nOut * 34 + 4;
  const perInputWitness = 1 + (nSigs * 65 + (nCosigners - nSigs) * 1)
    + (varintLen(scriptLen) + scriptLen) + (1 + 33);
  return Math.ceil((4 * base + 2 + nIn * perInputWitness) / 4);
}

/* ---------------- spend planning ---------------- */

/**
 * Plan a vault spend. selectedUtxos: [{txid, vout, value(BigInt-like)}].
 * recipients: [{address, grains(BigInt-like)}].
 * Returns the plan with exact fee math; throws loudly on any shortfall.
 * Dust change (< 546 gr) is absorbed into the fee and disclosed.
 */
export function planSpend({ network, descriptor, selectedUtxos, recipients, feeRateGrainsPerVByte, blockbookBase }) {
  if (!descriptor || !descriptor.address) throw new Error("VAULT REFUSED: no vault descriptor loaded");
  const utxos = (selectedUtxos || []).map((u) => ({
    txid: String(u.txid).toLowerCase(), vout: Number(u.vout), value: BigInt(u.value),
  }));
  if (utxos.length === 0) throw new Error("VAULT REFUSED: select at least one vault UTXO");
  for (const u of utxos) {
    if (!/^[0-9a-f]{64}$/.test(u.txid)) throw new Error("VAULT REFUSED: malformed UTXO txid");
    if (!Number.isInteger(u.vout) || u.vout < 0) throw new Error("VAULT REFUSED: malformed UTXO vout");
    if (u.value <= 0n) throw new Error("VAULT REFUSED: UTXO value must be positive");
  }
  const outs = (recipients || []).map((r) => {
    const address = validateVaultAddress(r.address, network);
    const grains = BigInt(r.grains);
    if (grains < BigInt(DUST_GRAIN)) {
      throw new Error(`VAULT REFUSED: output ${grains} grains is dust (< ${DUST_GRAIN})`);
    }
    const program = decodeBech32m(address).program;
    return { address, grains, program };
  });
  if (outs.length === 0) throw new Error("VAULT REFUSED: add at least one recipient");
  const rate = Number(feeRateGrainsPerVByte);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("VAULT REFUSED: fee rate must be positive");
  const scriptLen = hexToBytes(descriptor.script).length;
  // vBytes depend on output count; change output may or may not exist. Plan
  // with change, then re-check without it if change would be dust.
  let vBytes = scriptPathVBytes(utxos.length, outs.length + 1, scriptLen, descriptor.n, descriptor.m);
  let fee = BigInt(Math.ceil(vBytes * rate));
  const inTotal = utxos.reduce((a, u) => a + u.value, 0n);
  const outTotal = outs.reduce((a, o) => a + o.grains, 0n);
  let change = inTotal - outTotal - fee;
  let dustAbsorbed = 0n;
  if (change < 0n) throw new Error(`VAULT REFUSED: shortfall of ${grainsToPRL(-change)} PRL (inputs cover outputs + fee of ${grainsToPRL(fee)} PRL)`);
  if (change > 0n && change < BigInt(DUST_GRAIN)) {
    // Recompute without the change output: vBytes shrink, fee shrinks.
    const vBytes2 = scriptPathVBytes(utxos.length, outs.length, scriptLen, descriptor.n, descriptor.m);
    const fee2 = BigInt(Math.ceil(vBytes2 * rate));
    dustAbsorbed = inTotal - outTotal - fee2;
    if (dustAbsorbed < 0n) throw new Error(`VAULT REFUSED: shortfall of ${grainsToPRL(-dustAbsorbed)} PRL`);
    vBytes = vBytes2; fee = fee2; change = 0n;
  }
  const finalOutputs = outs.map((o) => ({ address: o.address, grains: o.grains, program: o.program }));
  if (change >= BigInt(DUST_GRAIN)) {
    finalOutputs.push({ address: descriptor.address, grains: change, program: decodeBech32m(descriptor.address).program, change: true });
  }
  return {
    network: network.id,
    descriptorHash: descriptor.hash,
    inputs: utxos,
    outputs: finalOutputs,
    feeRate: rate,
    vBytes,
    feeGrains: fee,
    inTotal, outTotal,
    changeGrains: change,
    dustAbsorbedGrains: dustAbsorbed,
    blockbookBase: blockbookBase || "",
  };
}

/* ---------------- BIP-341 script-path sighash (multi-input) ---------------- */

/**
 * BIP-341 script-path sighash digest for input `inputIdx` of a multi-input
 * spend. Generalizes the audited single-input scriptPathSigDigest in
 * sign/src/crypto.js: prevouts/amounts/scriptPubKeys/sequences are hashed
 * over ALL inputs; outputs over ALL outputs. SIGHASH_DEFAULT (0x00),
 * no annex, key version 0x00, codesep 0xffffffff.
 */
export function scriptPathSigDigestMulti(network, inputs, outputs, script, inputIdx, sequence = MAX_SEQ) {
  const sha = (b) => sha256(b);
  if (!Number.isInteger(inputIdx) || inputIdx < 0 || inputIdx >= inputs.length) {
    throw new Error("VAULT REFUSED: inputIdx out of range");
  }
  const prevouts = sha(Uint8Array.from(inputs.flatMap((i) => [...txidLE(i.txid), ...u32le(i.vout)])));
  const amounts = sha(Uint8Array.from(inputs.flatMap((i) => [...u64leBig(i.value)])));
  const spks = sha(Uint8Array.from(inputs.flatMap((i) => {
    const s = p2trScriptPubKey(i.program);
    return [...varint(s.length), ...s];
  })));
  const seqs = sha(Uint8Array.from(inputs.flatMap((i) => [...u32le(i.sequence ?? sequence)])));
  const outs = sha(Uint8Array.from(outputs.flatMap((o) => {
    const s = p2trScriptPubKey(o.program);
    return [...u64leBig(o.value), ...varint(s.length), ...s];
  })));
  const leafHash = tapLeafHash(script);
  const msg = Uint8Array.from([
    0x00, 0x00, ...u32le(network.txVersion), ...u32le(0),
    ...prevouts, ...amounts, ...spks, ...seqs, ...outs,
    0x02, // spend_type: script path (ext_flag=1), no annex
    ...u32le(inputIdx),
    ...leafHash, 0x00, 0xff, 0xff, 0xff, 0xff, // leaf hash, key version, codesep 0xffffffff
  ]);
  return taggedHash("TapSighash", msg);
}

/* ---------------- signing ---------------- */

/** BIP-340 sign a 32-byte digest with a privkey whose x-only key appears in
 *  the leaf script. Negates the scalar when the pubkey has odd Y (BIP-340),
 *  mirroring tweakPrivKeypath() in sign/src/crypto.js and signForXOnly in
 *  the escrow app. */
export function signForXOnly(priv, digest) {
  const p = priv instanceof Uint8Array ? priv : hexToBytes(String(priv));
  const dg = digest instanceof Uint8Array ? digest : hexToBytes(String(digest));
  if (p.length !== 32) throw new Error("VAULT REFUSED: private key must be 32 bytes");
  if (dg.length !== 32) throw new Error("VAULT REFUSED: digest must be 32 bytes");
  let d = bytesToNumberBE(p);
  if (d <= 0n || d >= secp256k1.CURVE.n) throw new Error("VAULT REFUSED: private key out of range");
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

/* ---------------- unsigned bundle ---------------- */

function canonicalBundleJson(b) {
  return JSON.stringify({
    kind: b.kind,
    network: b.network,
    descriptorHash: b.descriptorHash,
    inputs: b.inputs.map((i) => ({ txid: i.txid, vout: i.vout, value: i.value })),
    outputs: b.outputs.map((o) => ({ address: o.address, value: o.value })),
    feeRate: b.feeRate,
    feeGrains: b.feeGrains,
    vBytes: b.vBytes,
    digests: b.digests,
  });
}

/**
 * Build the unsigned signing bundle: everything a cosigner needs to verify
 * the spend and sign their inputs — plus nothing else. The 64-bit
 * fingerprint binds every later partial signature to this exact plan.
 */
export function buildUnsignedBundle(plan, descriptor) {
  const network = Object.values(NETWORKS).find((x) => x.id === plan.network);
  if (!network) throw new Error("VAULT REFUSED: unknown network in plan");
  if (plan.descriptorHash !== descriptor.hash) throw new Error("VAULT REFUSED: plan/descriptor mismatch");
  const script = hexToBytes(descriptor.script);
  const inputs = plan.inputs.map((u) => ({
    txid: u.txid, vout: u.vout, value: u.value.toString(),
    program: decodeBech32m(descriptor.address).program,
    sequence: MAX_SEQ,
  }));
  const outputs = plan.outputs.map((o) => ({
    address: o.address, value: o.grains.toString(), program: o.program, change: !!o.change,
  }));
  const digests = inputs.map((_, idx) =>
    bytesToHex(scriptPathSigDigestMulti(network, inputs, outputs, script, idx)));
  const bundle = {
    kind: "pearl-vault-unsigned:v1",
    network: plan.network,
    descriptorHash: descriptor.hash,
    inputs,
    outputs,
    feeRate: plan.feeRate,
    feeGrains: plan.feeGrains.toString(),
    vBytes: plan.vBytes,
    changeGrains: plan.changeGrains.toString(),
    dustAbsorbedGrains: plan.dustAbsorbedGrains.toString(),
    digests,
  };
  bundle.fingerprint = bytesToHex(sha256(utf8(canonicalBundleJson(bundle)))).slice(0, 16);
  return bundle;
}

/**
 * Import an unsigned bundle: structural validation + independent re-derivation
 * of the fee, vBytes and every digest from the descriptor. A bundle that
 * fails any cross-check is refused loudly — cosigners never sign blind.
 */
export function parseUnsignedBundle(json, descriptor) {
  let b;
  try {
    b = typeof json === "string" ? JSON.parse(json) : json;
  } catch {
    throw new Error("VAULT REFUSED: bundle is not valid JSON");
  }
  if (!b || b.kind !== "pearl-vault-unsigned:v1") throw new Error("VAULT REFUSED: not a pearl-vault-unsigned:v1 bundle");
  if (b.descriptorHash !== descriptor.hash) throw new Error("VAULT REFUSED: bundle is for a different vault (descriptor hash mismatch)");
  const network = Object.values(NETWORKS).find((x) => x.id === b.network);
  if (!network) throw new Error("VAULT REFUSED: unknown network in bundle");
  if (!Array.isArray(b.inputs) || b.inputs.length === 0) throw new Error("VAULT REFUSED: bundle has no inputs");
  if (!Array.isArray(b.outputs) || b.outputs.length === 0) throw new Error("VAULT REFUSED: bundle has no outputs");
  const script = hexToBytes(descriptor.script);
  const scriptLen = script.length;
  const expectVBytes = scriptPathVBytes(b.inputs.length, b.outputs.length, scriptLen, descriptor.n, descriptor.m);
  if (expectVBytes !== b.vBytes) {
    throw new Error(`VAULT REFUSED: bundle vBytes ${b.vBytes} != re-derived ${expectVBytes}`);
  }
  const expectFee = BigInt(Math.ceil(expectVBytes * Number(b.feeRate)));
  if (expectFee !== BigInt(b.feeGrains)) {
    throw new Error(`VAULT REFUSED: bundle fee ${b.feeGrains} != re-derived ${expectFee}`);
  }
  const inputs = b.inputs.map((i) => ({
    txid: String(i.txid).toLowerCase(), vout: Number(i.vout), value: BigInt(i.value).toString(),
    program: decodeBech32m(descriptor.address).program, sequence: MAX_SEQ,
  }));
  const outputs = b.outputs.map((o) => ({
    address: String(o.address), value: BigInt(o.value).toString(),
    program: decodeBech32m(String(o.address)).program,
  }));
  const expectDigests = inputs.map((_, idx) =>
    bytesToHex(scriptPathSigDigestMulti(network, inputs, outputs, script, idx)));
  if (expectDigests.length !== b.digests.length || !expectDigests.every((d, i) => d === b.digests[i])) {
    throw new Error("VAULT REFUSED: bundle digests do not re-derive — bundle tampered");
  }
  const fp = bytesToHex(sha256(utf8(canonicalBundleJson(b)))).slice(0, 16);
  if (fp !== b.fingerprint) throw new Error("VAULT REFUSED: bundle fingerprint does not match — bundle tampered");
  return { ...b, _network: network, _inputs: inputs, _outputs: outputs, _script: script };
}

/* ---------------- partial signatures ---------------- */

/** Build a cosigner's partial-signature JSON for an imported bundle. */
export function signBundle(bundle, descriptor, keyIndex, priv) {
  const parsed = bundle._inputs ? bundle : parseUnsignedBundle(bundle, descriptor);
  if (!Number.isInteger(keyIndex) || keyIndex < 0 || keyIndex >= descriptor.n) {
    throw new Error("VAULT REFUSED: keyIndex out of range");
  }
  const sigs = parsed._inputs.map((inp, idx) => {
    const digest = hexToBytes(parsed.digests[idx]);
    const sig = signForXOnly(priv, digest);
    return { inputIndex: idx, sig: bytesToHex(sig) };
  });
  return {
    kind: "pearl-vault-partialsig:v1",
    fingerprint: parsed.fingerprint,
    keyIndex,
    key: descriptor.keys[keyIndex],
    sigs,
  };
}

/**
 * Verify ONE partial's signatures against the claimed cosigner key and the
 * exact per-input digests — no quorum requirement. Used when a partial
 * arrives, so a bad signature is rejected immediately, long before finalize.
 * Returns the verified keyIndex.
 */
export function verifyPartialSigs(ps, bundle, descriptor) {
  const parsed = bundle._inputs ? bundle : parseUnsignedBundle(bundle, descriptor);
  if (!ps || ps.kind !== "pearl-vault-partialsig:v1") throw new Error("VAULT REFUSED: not a pearl-vault-partialsig:v1 payload");
  if (ps.fingerprint !== parsed.fingerprint) throw new Error("VAULT REFUSED: partial signature is for a different bundle");
  const ki = ps.keyIndex;
  if (!Number.isInteger(ki) || ki < 0 || ki >= descriptor.n) throw new Error("VAULT REFUSED: partial sig keyIndex out of range");
  if (String(ps.key || "").toLowerCase() !== descriptor.keys[ki]) {
    throw new Error(`VAULT REFUSED: partial sig key does not match cosigner ${ki}`);
  }
  const key = hexToBytes(descriptor.keys[ki]);
  if (!Array.isArray(ps.sigs) || ps.sigs.length === 0) throw new Error("VAULT REFUSED: partial has no signatures");
  for (const { inputIndex, sig } of ps.sigs) {
    if (!Number.isInteger(inputIndex) || inputIndex < 0 || inputIndex >= parsed._inputs.length) {
      throw new Error("VAULT REFUSED: partial sig inputIndex out of range");
    }
    const digest = hexToBytes(parsed.digests[inputIndex]);
    if (!verifySchnorrSig(sig, digest, key)) {
      throw new Error(`VAULT REFUSED: signature from cosigner ${ki} does not verify on input ${inputIndex}`);
    }
  }
  return ki;
}

/**
 * Combine partial signatures into per-input witness stacks. EVERY signature
 * is re-verified (see verifyPartialSigs) before acceptance — a bad signature
 * never reaches the chain. Requires at least m DISTINCT valid signers per
 * input. Witness order: reverse key order, empty vector for non-signers.
 */
export function combineMultisigSigs(partials, bundle, descriptor) {
  const parsed = bundle._inputs ? bundle : parseUnsignedBundle(bundle, descriptor);
  const nInputs = parsed._inputs.length;
  const perInput = Array.from({ length: nInputs }, () => new Map());
  const seenCosigners = new Set();
  for (const ps of partials || []) {
    const ki = verifyPartialSigs(ps, parsed, descriptor);
    if (seenCosigners.has(ki)) throw new Error(`VAULT REFUSED: duplicate partial from cosigner ${ki}`);
    seenCosigners.add(ki);
    for (const { inputIndex, sig } of ps.sigs) {
      perInput[inputIndex].set(ki, sig instanceof Uint8Array ? sig : hexToBytes(String(sig)));
    }
  }
  return perInput.map((m, idx) => {
    if (m.size < descriptor.m) {
      throw new Error(`VAULT REFUSED: input ${idx} has ${m.size} valid signatures, need ${descriptor.m}`);
    }
    const stack = [];
    for (let k = descriptor.n - 1; k >= 0; k--) stack.push(m.get(k) || EMPTY); // reverse key order
    return stack;
  });
}

/* ---------------- serialization + finalize ---------------- */

/** Serialize the multisig spend.
 *  witnesses: per-input witness stacks (sig items only), or null for the
 *  base (non-witness) serialization used for the txid.
 *  script/controlBlock: appended to every input's witness automatically. */
export function serializeSpendTx(network, inputs, outputs, witnesses, script, controlBlock) {
  const out = [];
  out.push(...u32le(network.txVersion));
  const withWitness = Array.isArray(witnesses) && witnesses.some((w) => w !== null);
  if (withWitness) {
    if (!(script instanceof Uint8Array) || !(controlBlock instanceof Uint8Array)) {
      throw new Error("VAULT REFUSED: script + control block required for witness serialization");
    }
    out.push(0x00, 0x01);
  }
  out.push(...varint(inputs.length));
  for (const i of inputs) {
    out.push(...txidLE(i.txid), ...u32le(i.vout), ...varint(0), ...u32le(i.sequence ?? MAX_SEQ));
  }
  out.push(...varint(outputs.length));
  for (const o of outputs) {
    const s = p2trScriptPubKey(o.program);
    out.push(...u64leBig(o.value), ...varint(s.length), ...s);
  }
  out.push(...u32le(0)); // locktime
  if (withWitness) {
    for (let idx = 0; idx < inputs.length; idx++) {
      const stack = witnesses[idx] || [];
      const items = [...stack, script, controlBlock];
      out.push(...varint(items.length));
      for (const it of items) out.push(...varint(it.length), ...it);
    }
  }
  return Uint8Array.from(out);
}

/**
 * Finalize: combine verified partials into witnesses, serialize, compute txid.
 * The txid is hashed over the BASE (non-witness) serialization, per consensus.
 */
export function finalizeSpend(bundle, descriptor, partials) {
  const parsed = bundle._inputs ? bundle : parseUnsignedBundle(bundle, descriptor);
  const network = parsed._network;
  const script = parsed._script;
  const controlBlock = hexToBytes(descriptor.controlBlock);
  const witnessStacks = combineMultisigSigs(partials, parsed, descriptor);
  const fullBytes = serializeSpendTx(network, parsed._inputs, parsed._outputs, witnessStacks, script, controlBlock);
  const baseBytes = serializeSpendTx(network, parsed._inputs, parsed._outputs, null);
  const txid = bytesToHex(dblSha(baseBytes).reverse());
  return { hex: bytesToHex(fullBytes), txid, vBytes: parsed.vBytes, feeGrains: parsed.feeGrains };
}

/* ---------------- misc ---------------- */

/** Track a txid's confirmations (GET-only). */
export async function fetchTxConfirmations(blockbookBase, txid) {
  if (!/^[0-9a-fA-F]{64}$/.test(String(txid))) throw new Error("VAULT REFUSED: txid must be 64 hex chars");
  const base = normalizeBlockbookBase(blockbookBase);
  let res;
  try {
    res = await fetch(`${base}/api/v2/tx/${String(txid).toLowerCase()}`);
  } catch (e) {
    throw new Error(`VAULT REFUSED: blockbook unreachable (${e.message})`);
  }
  if (!res.ok) throw new Error(`VAULT REFUSED: blockbook ${res.status} on tx lookup`);
  const data = JSON.parse(await res.text());
  return {
    txid: String(txid).toLowerCase(),
    confirmations: Number(data.confirmations ?? 0),
    blockHeight: data.blockHeight ?? null,
  };
}
