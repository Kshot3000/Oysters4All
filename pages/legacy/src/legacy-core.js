/* Pearl Legacy core — dead-man's-switch PRL inheritance vaults.
 *
 * Pure ESM, zero build step for developers. The browser ships a committed
 * esbuild IIFE bundle (pearl-legacy.bundle.js); node runs this file directly
 * for the verification suite.
 *
 * Protocol: a two-leaf Taproot vault under a NUMS internal key (no keypath
 * bypass — keypath spends are impossible by construction, asserted in tests).
 *   Leaf A (owner heartbeat): <owner_xonly> OP_CHECKSIG
 *     The owner can ALWAYS spend (no timelock). Moving funds to a fresh
 *     Legacy vault with identical params = a heartbeat refresh that resets
 *     the inactivity clock.
 *   Leaf B (heir claim): <n> OP_CHECKSEQUENCEVERIFY OP_DROP <heir_xonly> OP_CHECKSIG
 *     The heir spends only when the vault UTXO is >= n blocks old (relative
 *     CSV timelock, BIP-68/112). The claim tx sets the spending input's
 *     nSequence = n exactly (disable flag cleared by construction: the
 *     builder takes no sequence parameter and hard-codes n, and n is
 *     restricted to 1..65535 so the BIP-68 16-bit field + block-type flag
 *     are both clean).
 *
 * Inactivity is measured in BLOCKS. Pearl's target block time is 194 s
 * (pearl-knowledge.md, node/chaincfg/params.go TargetTimePerBlock); the UI
 * shows day-estimates ONLY via that clearly-labeled constant — the chain
 * enforces blocks, never time. CSV caps n at 16 bits: 65535 blocks
 * (~147 days at 194 s/block). A "~1 year" setting is impossible and is
 * refused with an explanation, not silently truncated.
 *
 * NUMS internal key: H("PearlLegacyNUMS/v1" || leafAHash || leafBHash)
 * lifted to the curve (leaf order canonical: heartbeat first, heir second).
 * Nobody knows the discrete log, so keypath spending is impossible — coins
 * move only through the two script leaves. Deterministic: identical network,
 * owner key, heir key, and n ALWAYS produce the same vault address. The
 * owner's heartbeat refresh spends every vault UTXO and forges a FRESH
 * UTXO at that SAME address — a fresh coin with a fresh funding height is
 * what resets the inactivity clock, because heir maturity is measured per
 * UTXO from its own funding height.
 *
 * Shareable descriptor (compact, recomputable — NOT signed or authenticated):
 *   legacy:v1:<hrp>:<ownerXOnlyHex>:<heirXOnlyHex>:<n>
 * Parsing re-derives the ENTIRE contract from the keys + n and byte-compares
 * every field of a JSON spec. But a descriptor alone cannot prove it is the
 * descriptor that was published: editing n (or either key) yields a
 * different-but-valid descriptor for a different vault. The honest check is
 * verifyDescriptor(descriptor, network, expectedAddress): the recomputed
 * address MUST equal the separately-supplied claimed address, loudly
 * refusing otherwise.
 *
 * Crypto lineage: key derivation, TapTweak, bech32m, BIP-341 sighash, wire
 * serialization and the segwit tx parser are imported from the audited
 * files/pages/sign/src/crypto.js (verified byte-for-byte against Pearl's Go
 * reference node/txscript); script-path sighash/spend/fee helpers from
 * files/pages/escrow/src/escrow-core.js (themselves verified against the
 * consensus implementation). New here: only the two vault script templates,
 * the NUMS derivation, the vault spec/descriptor, the heir-claim and
 * owner-refresh spend builders (incl. the multi-input refresh composer), and
 * the vault-watch status classifier. The claim/refresh scripts use only
 * opcodes Pearl consensus supports (OP_CHECKSIG, OP_CHECKSEQUENCEVERIFY,
 * OP_DROP).
 */

import {
  taggedHash, tapLeafHash, encodeBech32m, decodeBech32m,
  schnorr, sha256, bytesToHex, hexToBytes, convertBits,
  varint, u32le, u64le, p2trScriptPubKey, txidLE, dblSha,
  DUST_GRAIN, GRAIN_PER_PRL, NETWORKS,
  walletFromMnemonic, walletFromWIF, walletFromPriv, walletToWIF, newMnemonic,
  fetchUtxos, fetchFeeRateGrainsPerVByte, broadcastTx, fetchTxStatus,
  tweakKeypath,
} from "../../sign/src/crypto.js";
import {
  partyKeyFromInput, parseXOnlyKey, scriptPathSigDigestEx,
  signForXOnly, verifySchnorrSig, buildScriptPathSpend,
  spendVBytes, addressToProgram, encodeScriptNum,
} from "../../escrow/src/escrow-core.js";
import { parseTx } from "../../swap/src/swap-core.js";
import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesToNumberBE, numberToBytesBE } from "@noble/curves/abstract/utils";

export {
  DUST_GRAIN, GRAIN_PER_PRL, NETWORKS,
  walletFromMnemonic, walletFromWIF, walletFromPriv, walletToWIF, newMnemonic,
  fetchUtxos, fetchFeeRateGrainsPerVByte, broadcastTx, fetchTxStatus,
  taggedHash, tapLeafHash, bytesToHex, hexToBytes, schnorr, sha256, dblSha, convertBits,
  encodeBech32m, decodeBech32m, p2trScriptPubKey, txidLE, tweakKeypath,
  partyKeyFromInput, parseXOnlyKey, addressToProgram, parseTx,
  verifySchnorrSig, signForXOnly, scriptPathSigDigestEx, buildScriptPathSpend,
  spendVBytes, encodeScriptNum,
};

const OP = {
  DROP: 0x75,
  CHECKSIG: 0xac,
  CSV: 0xb2,
};
const TAPLEAF_VERSION = 0xc0;
const EMPTY = new Uint8Array(0);

export const LEGACY_KIND = "pearl-legacy";
export const LEGACY_VERSION = 1;
export const DESCRIPTOR_PREFIX = "legacy:v1";
/** Pearl target block time in seconds (pearl-knowledge.md). Day-estimates
 *  shown in the UI are derived from this constant and labeled as such. */
export const PEARL_BLOCK_SECS = 194;
/** BIP-68: CSV sequence is a 16-bit value; bit 31 = disable flag, bit 22 =
 *  type flag (time vs blocks). We require 1..65535, so both flags are clear
 *  for every accepted n — nSequence = n exactly. */
export const MIN_CSV_BLOCKS = 1;
export const MAX_CSV_BLOCKS = 65535;
/** nSequence for spends with no relative timelock (owner refresh). */
export const FINAL_SEQUENCE = 0xfffffffe;

function constEq(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

function pushData(data) {
  const b = data instanceof Uint8Array ? data : Uint8Array.from(data);
  if (b.length === 0) return [0x00];
  if (b.length <= 75) return [b.length, ...b];
  if (b.length <= 255) return [0x4c, b.length, ...b];
  throw new Error("push exceeds 255 bytes");
}

/** Validate the inactivity period n (blocks). Refuses 0, negatives, and
 *  anything above the 16-bit CSV field — with the reason spelled out. */
export function checkInactivity(n) {
  if (!Number.isSafeInteger(n) || n < MIN_CSV_BLOCKS) {
    throw new Error("inactivity n must be at least 1 block");
  }
  if (n > MAX_CSV_BLOCKS) {
    throw new Error(
      `inactivity n = ${n} exceeds the CSV 16-bit limit (max ${MAX_CSV_BLOCKS} blocks, ` +
      `~${Math.round((MAX_CSV_BLOCKS * PEARL_BLOCK_SECS) / 86400)} days at ${PEARL_BLOCK_SECS}s/block). ` +
      "BIP-68 sequences are 16 bits wide — a longer single inactivity window is impossible; " +
      "refresh the vault (heartbeat) before the window lapses instead."
    );
  }
  return n;
}

/** Day-estimate for n blocks via the labeled 194s constant (UI only —
 *  the chain enforces blocks, never time). */
export function blocksToDays(n) {
  return (n * PEARL_BLOCK_SECS) / 86400;
}

/* ------------------------------------------------------------------ */
/* Script templates                                                    */
/* ------------------------------------------------------------------ */

/** Leaf A (owner heartbeat): <owner_xonly> OP_CHECKSIG.
 *  No timelock — the owner can always spend (heartbeat refresh). */
export function buildHeartbeatScript(ownerXOnly) {
  const owner = ownerXOnly instanceof Uint8Array ? ownerXOnly : parseXOnlyKey(ownerXOnly);
  if (owner.length !== 32) throw new Error("owner key must be 32 bytes");
  schnorr.utils.lift_x(bytesToNumberBE(owner));
  return Uint8Array.from([...pushData(owner), OP.CHECKSIG]);
}

/** Leaf B (heir claim): <n> OP_CHECKSEQUENCEVERIFY OP_DROP <heir_xonly> OP_CHECKSIG.
 *  Spendable by the heir's key only when the vault UTXO is >= n blocks old.
 *  The spending tx must carry input nSequence = n (disable flag cleared). */
export function buildHeirScript(heirXOnly, n) {
  const heir = heirXOnly instanceof Uint8Array ? heirXOnly : parseXOnlyKey(heirXOnly);
  if (heir.length !== 32) throw new Error("heir key must be 32 bytes");
  schnorr.utils.lift_x(bytesToNumberBE(heir));
  checkInactivity(n);
  return Uint8Array.from([...pushData(encodeScriptNum(n)), OP.CSV, OP.DROP, ...pushData(heir), OP.CHECKSIG]);
}

/** NUMS internal key: H("PearlLegacyNUMS/v1" || leafAHash || leafBHash)
 *  lifted to the curve (leaf order canonical: heartbeat, heir). Nobody
 *  knows the discrete log, so keypath spending is impossible — coins move
 *  only through the two script leaves. Deterministic: identical keys + n
 *  always produce the same internal key and the same vault address. The
 *  counter fallback exists only for the astronomically-unlikely x >= p case. */
export function numsInternalKey(leafAHash, leafBHash) {
  for (const h of [leafAHash, leafBHash]) {
    if (!(h instanceof Uint8Array) || h.length !== 32) throw new Error("leaf hash must be 32 bytes");
  }
  const base = Uint8Array.from([...leafAHash, ...leafBHash]);
  for (let c = 0; c < 256; c++) {
    const preimage = c === 0 ? base : Uint8Array.from([...base, c]);
    const h = taggedHash("PearlLegacyNUMS/v1", preimage);
    try {
      schnorr.utils.lift_x(bytesToNumberBE(h));
      return h;
    } catch { /* try next counter */ }
  }
  throw new Error("NUMS lift failed (unreachable in practice)");
}

function tapBranch(a, b) {
  const [x, y] = bytesToHex(a) <= bytesToHex(b) ? [a, b] : [b, a];
  return taggedHash("TapBranch", Uint8Array.from([...x, ...y]));
}

/** Two-leaf taptree under the NUMS internal key. Returns the vault address,
 *  spk, both control blocks (65 bytes each), and everything needed to
 *  re-derive the contract from the vault spec. Deterministic: the same
 *  keys + n always yield the same address. */
export function legacyTaptree(network, leafA, leafB) {
  if (!(leafA instanceof Uint8Array) || leafA.length === 0) throw new Error("bad heartbeat script");
  if (!(leafB instanceof Uint8Array) || leafB.length === 0) throw new Error("bad heir script");
  const leafHashes = [tapLeafHash(leafA), tapLeafHash(leafB)];
  const internalXOnly = numsInternalKey(leafHashes[0], leafHashes[1]);
  const root = tapBranch(leafHashes[0], leafHashes[1]);
  const t = taggedHash("TapTweak", Uint8Array.from([...internalXOnly, ...root]));
  const P = schnorr.utils.lift_x(bytesToNumberBE(internalXOnly));
  const Q = P.add(schnorr.Point.BASE.multiply(bytesToNumberBE(t)));
  const tweakedX = schnorr.utils.pointToBytes(Q);
  const parity = Q.toAffine().y & 1n ? 1 : 0;
  const controlBlocks = leafHashes.map((lh, i) =>
    Uint8Array.from([TAPLEAF_VERSION | parity, ...internalXOnly, ...leafHashes[1 - i]]));
  return {
    internalXOnly, leafHashes, root, tweak: t, tweakedX, parity,
    address: encodeBech32m(network.hrp, 1, tweakedX),
    spk: p2trScriptPubKey(tweakedX),
    controlBlocks, // [heartbeat control block, heir control block]
  };
}

/** Independently re-derive the tweaked key from a control block and check it
 *  matches — the same verification a wallet does before funding. */
export function verifyLegacyControlBlock(internalXOnly, leafScript, controlBlock, tweakedX) {
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

/* ------------------------------------------------------------------ */
/* Key inputs                                                          */
/* ------------------------------------------------------------------ */

/** x-only pubkey for a 32-byte private key (even-Y normalized, BIP-340). */
export function pubkeyFromPriv(priv) {
  const p = priv instanceof Uint8Array ? priv : hexToBytes(String(priv).trim());
  if (p.length !== 32) throw new Error("private key must be 32 bytes");
  const P = secp256k1.ProjectivePoint.fromPrivateKey(p);
  return bytesToHex(P.toRawBytes(true).slice(1));
}

/**
 * Owner key where the owner HOLDS the key: 64-hex private key, WIF, or
 * 12/24-word mnemonic (BIP-86 account key, same scheme as Pearl Sign).
 * Returns { priv, xonly, address, source }. The priv NEVER enters the vault
 * spec — planLegacy returns secrets separately, in memory only.
 */
export function ownerPrivFromInput(input, network) {
  const t = String(input || "").trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) return { ...walletFromPriv(hexToBytes(t.toLowerCase()), network), source: "hex private key" };
  if (/^[1-9A-HJ-NP-Za-km-z]{30,60}$/.test(t)) {
    try { return { ...walletFromWIF(t, network), source: "WIF" }; } catch { /* fall through */ }
  }
  const words = t.split(/\s+/);
  if (words.length === 12 || words.length === 24) {
    return { ...walletFromMnemonic(t, network), source: "mnemonic (BIP-86 m/86'/coin'/0'/0/0)" };
  }
  throw new Error("owner key must be a 32-byte hex private key, WIF, or a 12/24-word mnemonic");
}

/**
 * Heir identity: either a 64-hex x-only pubkey, or a prl1p address — in the
 * address case its 32 program bytes become the claim key (bech32m-validated
 * against the network; the heir must hold the corresponding private key —
 * documented loudly in the UI).
 */
export function heirKeyFromInput(input, network) {
  const t = String(input || "").trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) {
    return { xonly: bytesToHex(parseXOnlyKey(t)), source: "x-only pubkey" };
  }
  const { hrp, version, program } = decodeBech32m(t);
  if (hrp !== network.hrp) throw new Error(`heir address is for ${hrp}, not ${network.hrp}`);
  if (version !== 1 || program.length !== 32) throw new Error("heir must be a Taproot (v1, 32-byte) address");
  schnorr.utils.lift_x(bytesToNumberBE(program)); // x must be a valid curve x
  return { xonly: bytesToHex(program), source: `prl1p address (${t.slice(0, 12)}… — program bytes as claim key)` };
}

/* ------------------------------------------------------------------ */
/* Vault spec: plan / descriptor / shareable JSON                       */
/* ------------------------------------------------------------------ */

/**
 * Plan a Legacy vault. params:
 *   network: NETWORKS.mainnet | NETWORKS.testnet
 *   ownerKeyInput: hex priv / WIF / mnemonic (owner holds key) OR 64-hex
 *     x-only pubkey when mode === "watch" (watch-only: the owner publishes
 *     the vault without ever exposing a private key on this machine)
 *   ownerKeyMode: "priv" | "watch"
 *   heirKeyInput: 64-hex x-only pubkey or prl1p address
 *   n: inactivity blocks (1..65535)
 *
 * Guards: n range (CSV 16-bit limit, explained); owner == heir refused
 * (collapses the dead-man semantics — almost certainly a paste error).
 *
 * Returns { vault, secrets }: vault is fully serializable (safe to share);
 * secrets holds private keys IN MEMORY ONLY and never enters the JSON.
 */
export function planLegacy(params) {
  const { network, ownerKeyInput, ownerKeyMode, heirKeyInput, n } = params || {};
  if (!network || !network.hrp) throw new Error("bad network");
  checkInactivity(n);
  let ownerXOnly, ownerSource;
  const secrets = [];
  if (ownerKeyMode === "watch") {
    const k = parseXOnlyKey(String(ownerKeyInput || "").trim());
    ownerXOnly = bytesToHex(k);
    ownerSource = "watch-only x-only pubkey";
  } else if (!ownerKeyMode || ownerKeyMode === "priv") {
    const w = ownerPrivFromInput(ownerKeyInput, network);
    ownerXOnly = bytesToHex(w.internalXOnly);
    ownerSource = w.source;
    secrets.push({ xonly: ownerXOnly, priv: bytesToHex(w.priv), role: "owner" });
  } else {
    throw new Error('ownerKeyMode must be "priv" or "watch"');
  }
  const heir = heirKeyFromInput(heirKeyInput, network);
  const heirXOnly = heir.xonly;
  if (heirXOnly === ownerXOnly) {
    throw new Error("owner and heir keys must differ — the same key collapses the dead-man's-switch semantics");
  }

  const leafA = buildHeartbeatScript(hexToBytes(ownerXOnly));
  const leafB = buildHeirScript(hexToBytes(heirXOnly), n);
  const tree = legacyTaptree(network, leafA, leafB);
  for (const [script, cb] of [[leafA, tree.controlBlocks[0]], [leafB, tree.controlBlocks[1]]]) {
    if (!verifyLegacyControlBlock(tree.internalXOnly, script, cb, tree.tweakedX)) {
      throw new Error("internal control-block self-check failed");
    }
  }

  const vault = {
    kind: LEGACY_KIND,
    version: LEGACY_VERSION,
    network: network.id,
    hrp: network.hrp,
    ownerXOnly,
    heirXOnly,
    ownerKeySource: ownerSource,
    heirKeySource: heir.source,
    n,
    nDaysEstimate: +blocksToDays(n).toFixed(1),
    leafAScriptHex: bytesToHex(leafA),
    leafAAsm: legacyScriptAsm(leafA),
    leafBScriptHex: bytesToHex(leafB),
    leafBAsm: legacyScriptAsm(leafB),
    internalKeyHex: bytesToHex(tree.internalXOnly),
    tweakedHex: bytesToHex(tree.tweakedX),
    leafAControlBlockHex: bytesToHex(tree.controlBlocks[0]),
    leafBControlBlockHex: bytesToHex(tree.controlBlocks[1]),
    address: tree.address,
    spkHex: bytesToHex(tree.spk),
  };
  vault.descriptor = legacyDescriptor(vault);
  return { vault, secrets };
}

/** Compact, copy-pasteable descriptor (recomputable, NOT authenticated):
 *  legacy:v1:<hrp>:<ownerXOnlyHex>:<heirXOnlyHex>:<n>
 *  Editing any field yields a different-but-valid descriptor for a different
 *  vault — see verifyDescriptor for the honest check. */
export function legacyDescriptor(vault) {
  return `${DESCRIPTOR_PREFIX}:${vault.hrp}:${vault.ownerXOnly}:${vault.heirXOnly}:${vault.n}`;
}

/** Canonical JSON for a vault spec (shareable; carries no private keys). */
export function serializeVault(vault) {
  return JSON.stringify(vault);
}

/**
 * Parse + fully re-derive a vault spec: JSON shape, field validation, script
 * rebuild from keys+n, taptree re-derivation, control-block self-check, and
 * descriptor round-trip. Throws on anything unexpected — a tampered spec can
 * never produce a fundable address. Watch-only mode is assumed (no private
 * keys are needed or accepted here).
 */
export function parseVaultSpec(json, network) {
  let s;
  try {
    s = typeof json === "string" ? JSON.parse(json) : json;
  } catch {
    throw new Error("vault spec is not valid JSON");
  }
  if (!s || s.kind !== LEGACY_KIND || s.version !== LEGACY_VERSION) {
    throw new Error("not a Pearl Legacy spec (kind pearl-legacy, version 1)");
  }
  if (s.hrp !== network.hrp) throw new Error(`spec is for ${s.hrp}, not ${network.hrp}`);
  const { vault } = planLegacy({
    network,
    ownerKeyInput: s.ownerXOnly,
    ownerKeyMode: "watch",
    heirKeyInput: s.heirXOnly,
    n: s.n,
  });
  // Every re-derived field must match byte-for-byte — tampering with the
  // spec's keys, n, or network changes the contract or the descriptor, so a
  // modified spec can never pass as the original.
  for (const f of ["address", "spkHex", "leafAScriptHex", "leafBScriptHex",
    "internalKeyHex", "tweakedHex", "leafAControlBlockHex", "leafBControlBlockHex",
    "ownerXOnly", "heirXOnly", "descriptor"]) {
    if (vault[f] !== s[f]) throw new Error(`vault spec failed re-derivation check on ${f} — the spec was tampered with`);
  }
  if (vault.n !== s.n) {
    throw new Error("vault spec failed re-derivation check — the spec was tampered with");
  }
  // Return a normalized copy so downstream code never trusts raw input.
  return { ...vault, ownerKeySource: String(s.ownerKeySource || "watch-only"), heirKeySource: String(s.heirKeySource || "") };
}

/** Parse a compact descriptor back into its fields. Pair with the JSON spec
 *  (or verifyDescriptor) to re-derive the full contract — the descriptor
 *  alone carries no leaf hashes. */
export function parseDescriptor(descriptor) {
  const t = String(descriptor || "").trim();
  const parts = t.split(":");
  // legacy:v1:<hrp>:<ownerXOnly>:<heirXOnly>:<n>  →  6 parts
  if (parts.length !== 6 || parts[0] !== "legacy" || parts[1] !== "v1") {
    throw new Error("bad legacy descriptor (expected legacy:v1:<hrp>:<ownerXOnly>:<heirXOnly>:<n>)");
  }
  const [, , hrp, ownerXOnly, heirXOnly, nRaw] = parts;
  parseXOnlyKey(ownerXOnly); // throws on malformed key
  parseXOnlyKey(heirXOnly);
  const n = Number(nRaw);
  if (!Number.isSafeInteger(n)) throw new Error("bad legacy descriptor: n is not an integer");
  checkInactivity(n);
  if (ownerXOnly.toLowerCase() === heirXOnly.toLowerCase()) {
    throw new Error("bad legacy descriptor: owner and heir keys must differ");
  }
  return { hrp, ownerXOnly: ownerXOnly.toLowerCase(), heirXOnly: heirXOnly.toLowerCase(), n };
}

/**
 * Standalone verifier: paste a descriptor → recompute the address + leaf
 * hashes from the keys + n. LOUD REFUSAL (throw) on malformed input, on a
 * network mismatch, or when the recomputed address does NOT match the
 * expected address the descriptor claims to describe.
 *
 * Note on tampering: `legacy:v1:…:445` edited to `…:446` is a *self-consistent*
 * descriptor for a *different* vault — no parser can call it malformed. The
 * tamper check is the comparison: the recomputed address must equal the
 * address the descriptor was published with. The UI therefore always asks
 * for both.
 */
export function verifyDescriptor(descriptor, network, expectedAddress = null) {
  const f = parseDescriptor(descriptor);
  if (f.hrp !== network.hrp) {
    throw new Error(`LOUD REFUSAL — descriptor is for network ${f.hrp}, not ${network.hrp}`);
  }
  const { vault } = planLegacy({
    network,
    ownerKeyInput: f.ownerXOnly,
    ownerKeyMode: "watch",
    heirKeyInput: f.heirXOnly,
    n: f.n,
  });
  const expect = legacyDescriptor(vault);
  if (expect !== String(descriptor).trim()) {
    throw new Error("LOUD REFUSAL — descriptor fields are internally inconsistent: re-derivation mismatch");
  }
  if (expectedAddress !== null && String(expectedAddress).trim() !== vault.address) {
    throw new Error(
      `LOUD REFUSAL — this descriptor recomputes to ${vault.address}, ` +
      `NOT to the claimed address ${String(expectedAddress).trim()}. ` +
      `The descriptor was altered (or belongs to a different vault). Do not fund the claimed address.`
    );
  }
  return {
    vault,
    leafAHash: bytesToHex(tapLeafHash(hexToBytes(vault.leafAScriptHex))),
    leafBHash: bytesToHex(tapLeafHash(hexToBytes(vault.leafBScriptHex))),
    recomputed: expect,
  };
}

/** Human summary of a vault spec for the UI. */
export function describeVault(vault) {
  return {
    address: vault.address,
    owner: vault.ownerXOnly.slice(0, 16) + "…",
    heir: vault.heirXOnly.slice(0, 16) + "…",
    n: vault.n,
    daysEstimate: blocksToDays(vault.n),
    descriptor: vault.descriptor,
  };
}

/* ------------------------------------------------------------------ */
/* Script disassembly                                                  */
/* ------------------------------------------------------------------ */

/** Human-readable disassembly of the vault scripts (contract review screen). */
export function legacyScriptAsm(script) {
  const names = { 0x75: "OP_DROP", 0xac: "OP_CHECKSIG", 0xb2: "OP_CHECKSEQUENCEVERIFY" };
  const parts = [];
  let i = 0;
  while (i < script.length) {
    const op = script[i];
    if (op === 0x00) { parts.push("0"); i++; continue; }
    if (op >= 0x51 && op <= 0x60) { parts.push(String(op - 0x50)); i++; continue; }
    if (op <= 0x4b || op === 0x4c) {
      let len, hlen;
      if (op <= 0x4b) { len = op; hlen = 1; }
      else { len = script[i + 1]; hlen = 2; }
      const data = script.slice(i + hlen, i + hlen + len);
      if (len <= 5) {
        // small script number (the inactivity n) — decode it
        let v = 0;
        for (let k = data.length - 1; k >= 0; k--) v = v * 256 + data[k];
        parts.push(`<${v}>`);
      } else {
        parts.push(`<${bytesToHex(data).slice(0, 12)}…${data.length}B>`);
      }
      i += hlen + len;
      continue;
    }
    parts.push(names[op] || `0x${op.toString(16).padStart(2, "0")}`);
    i++;
  }
  return parts.join(" ");
}

/* ------------------------------------------------------------------ */
/* Multi-input script-path spends (owner refresh)                      */
/* ------------------------------------------------------------------ */

/** vBytes for a script-path tx with nIn inputs and nOut P2TR outputs, each
 *  input carrying its own script + control block + stack.
 *  perInput: [{ scriptLen, controlLen, stackLens }]. For nIn = 1 this must
 *  equal spendVBytes(...) exactly (asserted in tests). */
export function multiScriptPathVBytes({ nIn, nOut, perInput }) {
  if (!Number.isSafeInteger(nIn) || nIn < 1) throw new Error("bad nIn");
  if (!Number.isSafeInteger(nOut) || nOut < 1) throw new Error("bad nOut");
  if (!Array.isArray(perInput) || perInput.length !== nIn) throw new Error("bad perInput");
  const varintLen = (n) => (n < 0xfd ? 1 : n <= 0xffff ? 3 : n <= 0xffffffff ? 5 : 9);
  const base = 4 + varintLen(nIn) + 41 * nIn + varintLen(nOut) + 43 * nOut + 4;
  let wit = 0;
  for (const p of perInput) {
    const { scriptLen, controlLen, stackLens } = p;
    if (!Number.isSafeInteger(scriptLen) || scriptLen <= 0) throw new Error("bad scriptLen");
    if (!Number.isSafeInteger(controlLen) || controlLen <= 0) throw new Error("bad controlLen");
    if (!Array.isArray(stackLens) || stackLens.length === 0) throw new Error("bad stackLens");
    let w = varintLen(stackLens.length + 2); // witness item count
    for (const l of stackLens) w += varintLen(l) + l;
    w += varintLen(scriptLen) + scriptLen + varintLen(controlLen) + controlLen;
    wit += w;
  }
  return Math.ceil((base * 3 + (base + 2 + wit)) / 4);
}

/** Serialize a multi-input script-path spend.
 *  spends: [{ input {txid,vout,value,spk}, leafScript, controlBlock, stackItems }]
 *  outputs: [{ program, value }]; opts: { sequence (per-input), locktime }.
 *  Every input is signed individually (digests differ per input index); the
 *  caller supplies the stackItems (already-signed). Returns
 *  { txid, hex, digests[], vBytes, baseBytes, totalBytes }. */
export function buildMultiScriptPathSpend(network, spends, outputs, opts = {}) {
  const { sequence = 0xfffffffe, locktime = 0 } = opts;
  if (!Array.isArray(spends) || spends.length === 0) throw new Error("need at least one spend");
  for (const o of outputs) {
    if (!(o.program instanceof Uint8Array) || o.program.length !== 32) throw new Error("output program must be 32 bytes");
    if (!Number.isSafeInteger(o.value) || o.value < DUST_GRAIN) throw new Error(`output below dust (${DUST_GRAIN} grains)`);
  }
  const outs = [];
  for (const o of outputs) {
    const s = p2trScriptPubKey(o.program);
    outs.push(...u64le(o.value), ...varint(s.length), ...s);
  }
  const digests = spends.map((sp, i) => {
    if (!(sp.leafScript instanceof Uint8Array) || sp.leafScript.length === 0) throw new Error(`spend ${i}: bad leaf script`);
    if (!(sp.controlBlock instanceof Uint8Array) || (sp.controlBlock.length !== 33 && sp.controlBlock.length !== 65)) {
      throw new Error(`spend ${i}: bad control block`);
    }
    if ((sp.controlBlock[0] & 0xfe) !== TAPLEAF_VERSION) throw new Error(`spend ${i}: bad control block version`);
    if (!Array.isArray(sp.stackItems) || sp.stackItems.length === 0) throw new Error(`spend ${i}: bad stack items`);
    return scriptPathSigDigestEx(network, sp.input, outputs, sp.leafScript,
      { sequence, locktime, inputIdx: i });
  });

  const base = [...u32le(network.txVersion), ...varint(spends.length)];
  for (const sp of spends) base.push(...txidLE(sp.input.txid), ...u32le(sp.input.vout), ...varint(0), ...u32le(sequence));
  base.push(...varint(outputs.length), ...outs, ...u32le(locktime));
  const txid = bytesToHex(dblSha(Uint8Array.from(base)).reverse());

  const full = [...u32le(network.txVersion), 0x00, 0x01, ...varint(spends.length)];
  for (const sp of spends) full.push(...txidLE(sp.input.txid), ...u32le(sp.input.vout), ...varint(0), ...u32le(sequence));
  full.push(...varint(outputs.length), ...outs);
  for (const sp of spends) {
    const wit = [];
    for (const w of sp.stackItems) {
      const b = w instanceof Uint8Array ? w : hexToBytes(String(w));
      wit.push(...varint(b.length), ...b);
    }
    wit.push(...varint(sp.leafScript.length), ...sp.leafScript);
    wit.push(...varint(sp.controlBlock.length), ...sp.controlBlock);
    full.push(...varint(sp.stackItems.length + 2), ...wit);
  }
  full.push(...u32le(locktime));
  const vBytes = Math.ceil((base.length * 3 + full.length) / 4);
  return {
    txid, hex: bytesToHex(Uint8Array.from(full)),
    digests: digests.map(bytesToHex), vBytes, baseBytes: base.length, totalBytes: full.length,
  };
}

/* ------------------------------------------------------------------ */
/* Heir claim: script-path spend of leaf B, refused before maturity    */
/* ------------------------------------------------------------------ */

/** Exact worst-case vBytes for an heir claim (1 P2TR output). */
export function claimSpendVBytes(vault) {
  return spendVBytes({
    nOut: 1,
    scriptLen: vault.leafBScriptHex.length / 2,
    controlLen: 65,
    stackLens: [64], // heir_sig
  });
}

/**
 * Build the heir's claim spend: script-path spend of the heir leaf.
 * Guards:
 *  - currentHeight >= fundingHeight + n (refuse before maturity, with
 *    blocks-to-go — a claim broadcast early is invalid on-chain);
 *  - the signing key must be the heir's key from the spec (owner's key is
 *    refused for this leaf);
 *  - nSequence = n is hard-coded (the function takes NO sequence parameter —
 *    a 0xffffffff/disabled sequence can never be produced here).
 * The signature is re-verified before the witness is assembled.
 */
export function buildHeirClaim(network, vault, {
  utxo, heirPrivHex, destAddress, feeRateGrainsPerVByte, fundingHeight, currentHeight,
}) {
  if (!Number.isSafeInteger(fundingHeight) || fundingHeight <= 0) throw new Error("bad funding height");
  if (!Number.isSafeInteger(currentHeight) || currentHeight <= 0) throw new Error("bad current height");
  const claimHeight = fundingHeight + vault.n;
  if (currentHeight < claimHeight) {
    throw new Error(
      `heir claim not yet mature: vault UTXO is ${currentHeight - fundingHeight} blocks old, ` +
      `needs ${vault.n} — claimable at height ${claimHeight} (${claimHeight - currentHeight} blocks to go)`
    );
  }
  const heirXOnly = pubkeyFromPriv(heirPrivHex);
  if (heirXOnly !== vault.heirXOnly) {
    throw new Error("this key is not the heir's claim key for this vault — claim refused");
  }
  if (!/^[0-9a-f]{64}$/i.test(utxo?.txid || "")) throw new Error("bad utxo txid");
  if (!Number.isInteger(utxo?.vout) || utxo.vout < 0) throw new Error("bad utxo vout");
  if (!Number.isSafeInteger(utxo?.value) || utxo.value <= 0) throw new Error("bad utxo value");
  if (!Number.isFinite(feeRateGrainsPerVByte) || feeRateGrainsPerVByte <= 0) throw new Error("bad fee rate");
  const destProgram = addressToProgram(destAddress, network);
  const fee = Math.ceil(claimSpendVBytes(vault) * feeRateGrainsPerVByte);
  const value = utxo.value - fee;
  if (value < DUST_GRAIN) {
    throw new Error(`claim output ${value} grains is below dust after fees — UTXO too small`);
  }
  const heirScript = hexToBytes(vault.leafBScriptHex);
  const controlBlock = hexToBytes(vault.leafBControlBlockHex);
  const input = { txid: utxo.txid.toLowerCase(), vout: utxo.vout, value: utxo.value, spk: hexToBytes(vault.spkHex) };
  const outputs = [{ program: destProgram, value }];
  // nSequence = n (CSV): hard-coded, disable flag impossible.
  const digest = scriptPathSigDigestEx(network, input, outputs, heirScript, { sequence: vault.n });
  const sig = signForXOnly(hexToBytes(String(heirPrivHex).trim().toLowerCase()), digest);
  if (!verifySchnorrSig(sig, digest, hexToBytes(vault.heirXOnly))) {
    throw new Error("claim signature failed re-verification — refusing to build the tx");
  }
  const spend = buildScriptPathSpend(
    network, input, outputs, heirScript, controlBlock, [sig], { sequence: vault.n },
  );
  if (spend.digest !== bytesToHex(digest)) throw new Error("internal: claim digest mismatch");
  // Structural check on the wire bytes: nSequence == n, disable flag clear.
  const parsed = parseTx(spend.hex);
  const seq = parsed.inputs[0].sequence;
  if (seq !== vault.n) throw new Error("internal: claim nSequence != n");
  if ((seq & 0x80000000) !== 0) throw new Error("internal: CSV disable flag set");
  if ((seq & 0x00400000) !== 0) throw new Error("internal: unexpected time-based CSV type flag");
  return { ...spend, feeGrains: fee, claimHeight };
}

/* ------------------------------------------------------------------ */
/* Owner refresh: heartbeat — move everything to a FRESH vault         */
/* ------------------------------------------------------------------ */

/**
 * Build the owner's heartbeat refresh: script-path spends of leaf A for
 * EVERY vault UTXO, paying the total (minus exact fee) to the SAME vault
 * address as a single fresh UTXO. A fresh coin with a fresh funding height
 * is what resets the inactivity clock — heir maturity is measured per UTXO
 * from its own funding height, so the heir's window restarts from the
 * refresh's confirmation height. Identical network, owner key, heir key,
 * and n deterministically produce the same address; a different address
 * requires changing a committed parameter or key.
 *
 * Guards: the signing key must be the owner's key from the spec; every
 * input's spk is belong-checked against the vault spk; the single output
 * pays the vault's OWN scriptPubKey (byte-compared, same address). Each
 * per-input signature is re-verified before the hex is returned.
 *
 * Returns { ...spend, feeGrains, totalInGrains }.
 */
export function buildOwnerRefresh(network, vault, {
  utxos, ownerPrivHex, feeRateGrainsPerVByte,
}) {
  const ownerXOnly = pubkeyFromPriv(ownerPrivHex);
  if (ownerXOnly !== vault.ownerXOnly) {
    throw new Error("this key is not the owner's heartbeat key for this vault — refresh refused");
  }
  if (!Number.isFinite(feeRateGrainsPerVByte) || feeRateGrainsPerVByte <= 0) throw new Error("bad fee rate");
  if (!Array.isArray(utxos) || utxos.length === 0) throw new Error("need at least one vault UTXO");
  const vaultSpk = hexToBytes(vault.spkHex);
  const warnings = [];
  let totalIn = 0;
  const spends = utxos.map((u, i) => {
    if (!/^[0-9a-f]{64}$/i.test(u?.txid || "")) throw new Error(`utxo ${i}: bad txid`);
    if (!Number.isInteger(u?.vout) || u.vout < 0) throw new Error(`utxo ${i}: bad vout`);
    if (!Number.isSafeInteger(u?.value) || u.value <= 0) throw new Error(`utxo ${i}: bad value`);
    if (u.spkHex) {
      if (String(u.spkHex).trim().toLowerCase() !== vault.spkHex.toLowerCase()) {
        throw new Error(`utxo ${i}: scriptPubKey does not belong to the vault address — refusing`);
      }
    } else {
      warnings.push(`utxo ${i}: belonging not verifiable offline — confirm it belongs to the vault address`);
    }
    totalIn += u.value;
    return { txid: u.txid.toLowerCase(), vout: u.vout, value: u.value, spk: vaultSpk };
  });

  // The heartbeat: ONE output back to the vault's OWN address. The new UTXO
  // carries a fresh funding height, which is what restarts the heir's
  // inactivity clock (maturity is measured per UTXO from its own funding
  // height). Same keys + n re-derive the same address — that is the design.
  const ownProgram = hexToBytes(vault.tweakedHex);
  const leafA = hexToBytes(vault.leafAScriptHex);
  const controlBlock = hexToBytes(vault.leafAControlBlockHex);
  const perInput = spends.map(() => ({
    scriptLen: leafA.length, controlLen: 65, stackLens: [64],
  }));
  const fee = Math.ceil(
    multiScriptPathVBytes({ nIn: spends.length, nOut: 1, perInput }) * feeRateGrainsPerVByte
  );
  const value = totalIn - fee;
  if (value < DUST_GRAIN) {
    throw new Error(`refresh output ${value} grains is below dust after fees — vault balance too small to refresh`);
  }
  const outputs = [{ program: ownProgram, value }];

  // Sign each input against its own BIP-341 script-path digest, then
  // re-verify every signature before assembling.
  const priv = hexToBytes(String(ownerPrivHex).trim().toLowerCase());
  const stackItems = spends.map((inp, i) => {
    const digest = scriptPathSigDigestEx(network, inp, outputs, leafA,
      { sequence: FINAL_SEQUENCE, inputIdx: i });
    const sig = signForXOnly(priv, digest);
    if (!verifySchnorrSig(sig, digest, hexToBytes(vault.ownerXOnly))) {
      throw new Error(`refresh: input ${i} signature failed re-verification — refusing to build the tx`);
    }
    return [sig];
  });
  const spend = buildMultiScriptPathSpend(
    network,
    spends.map((inp, i) => ({ input: inp, leafScript: leafA, controlBlock, stackItems: stackItems[i] })),
    outputs,
    { sequence: FINAL_SEQUENCE },
  );
  // Wire-level structural checks: every input carries sequence 0xfffffffe,
  // witness layout [sig, leafA, controlBlock], output pays the vault's OWN
  // address (same-address heartbeat).
  const parsed = parseTx(spend.hex);
  if (parsed.locktime !== 0) throw new Error("internal: refresh locktime must be 0");
  parsed.inputs.forEach((pin, i) => {
    if (pin.sequence !== FINAL_SEQUENCE) throw new Error(`internal: refresh input ${i} sequence wrong`);
    if (pin.witness.length !== 3 || pin.witness[0].length !== 64) {
      throw new Error(`internal: refresh input ${i} witness layout wrong`);
    }
    if (bytesToHex(pin.witness[1]) !== vault.leafAScriptHex) throw new Error(`internal: refresh input ${i} leaf wrong`);
  });
  if (parsed.outputs.length !== 1 || parsed.outputs[0].value !== value ||
      bytesToHex(parsed.outputs[0].spk) !== vault.spkHex) {
    throw new Error("internal: refresh output does not pay the vault's own address");
  }
  return {
    ...spend, feeGrains: fee, totalInGrains: totalIn, warnings,
  };
}

/** Format grains as a PRL amount string (no unit suffix). Same arithmetic as
 *  the Sign lineage's formatter, kept local so Legacy has no new imports. */
export function fmtPRL(grains) {
  const g = BigInt(grains);
  const neg = g < 0n;
  const a = neg ? -g : g;
  const whole = a / BigInt(GRAIN_PER_PRL);
  const frac = (a % BigInt(GRAIN_PER_PRL)).toString().padStart(8, "0").replace(/0+$/, "");
  return (neg ? "-" : "") + whole.toString() + (frac ? "." + frac : "");
}

/* ------------------------------------------------------------------ */
/* Blockbook: GET-only watching                                        */
/* ------------------------------------------------------------------ */

/** GET-only JSON helper (same shape as crypto.js bbFetch; kept local so the
 *  watching path is self-contained and auditable). */
async function legacyGet(base, path) {
  const res = await fetch(String(base).replace(/\/$/, "") + path);
  if (!res.ok) throw new Error(`blockbook ${res.status} on ${path}`);
  const text = await res.text();
  try { return JSON.parse(text); } catch { throw new Error("blockbook returned non-JSON on " + path); }
}

/** Current chain tip height (GET /api/v2 → backend.blocks). */
export async function fetchBlockHeight(blockbookBase) {
  const j = await legacyGet(blockbookBase, "/api/v2");
  const h = j && j.backend && j.backend.blocks;
  if (!Number.isSafeInteger(h) || h < 0) throw new Error("blockbook returned a bad tip height");
  return h;
}

/** GET-only vault watch: UTXO list + per-funding-tx detail. Every UTXO's
 *  vout scriptPubKey is compared to the vault contract — a mismatch is
 *  NEVER believed (reported as scriptOk:false and dropped by the UI).
 *  Unconfirmed UTXOs come back with fundingHeight:null.
 *
 *  Returns [{ txid, vout, value, fundingHeight, confirmations, scriptOk }].
 */
export async function fetchLegacyUtxos(blockbookBase, vault) {
  if (!vault || !vault.spkHex || !vault.address) throw new Error("bad vault");
  const want = vault.spkHex.toLowerCase();
  const list = await legacyGet(blockbookBase, `/api/v2/utxo/${vault.address}`);
  if (!Array.isArray(list)) throw new Error("unexpected utxo response");
  const out = [];
  for (const u of list) {
    const txid = String(u.txid || "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(txid)) continue;
    const vout = Number(u.vout);
    const value = Number(u.value);
    if (!Number.isSafeInteger(vout) || vout < 0) continue;
    if (!Number.isSafeInteger(value) || value <= 0) continue;
    let scriptOk = false;
    let fundingHeight = null;
    try {
      const txj = await legacyGet(blockbookBase, `/api/v2/tx/${txid}`);
      const vo = txj && Array.isArray(txj.vout) ? txj.vout[vout] : null;
      const spk = vo && vo.scriptPubKey && vo.scriptPubKey.hex
        ? String(vo.scriptPubKey.hex).toLowerCase() : "";
      scriptOk = spk === want;
      if (txj && typeof txj.blockHeight === "number" && txj.blockHeight >= 0) {
        fundingHeight = txj.blockHeight;
      }
    } catch { /* tx lookup failed: scriptOk stays false */ }
    out.push({ txid, vout, value, fundingHeight, confirmations: u.confirmations ?? 0, scriptOk });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Watch: vault status classification                                  */
/* ------------------------------------------------------------------ */

/**
 * Classify one vault UTXO against a chain tip.
 *   fundingHeight: height the UTXO was created (Blockbook confirmations →
 *     tip - confirmations + 1, or the user's air-gapped entry)
 * Returns { age, claimHeight, blocksLeft, status, etaSecs } where status is
 *   "owner-active" | "heir-claimable".
 * A claim is valid only at broadcast height >= fundingHeight + n — the
 * countdown makes that explicit. Reorg note: treat a 1-2 block margin as
 * still-owner-active unless the user accepts the risk (the page shows the
 * exact claim height; it never broadcasts by itself).
 */
export function vaultUtxoStatus(vault, fundingHeight, tipHeight) {
  if (!Number.isSafeInteger(fundingHeight) || fundingHeight <= 0) throw new Error("bad funding height");
  if (!Number.isSafeInteger(tipHeight) || tipHeight <= 0) throw new Error("bad tip height");
  const age = Math.max(0, tipHeight - fundingHeight);
  const claimHeight = fundingHeight + vault.n;
  const blocksLeft = Math.max(0, claimHeight - tipHeight);
  const status = age >= vault.n ? "heir-claimable" : "owner-active";
  return {
    age, claimHeight, blocksLeft, status,
    etaSecs: blocksLeft * PEARL_BLOCK_SECS,
    reorgNote: blocksLeft === 0
      ? "matured — but a claim broadcast in the next block(s) can still lose a reorg race; confirm the tip is stable"
      : null,
  };
}
