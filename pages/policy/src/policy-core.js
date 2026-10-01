/* Pearl Policy core — Taproot policy-tree blueprint studio for PRL.
 *
 * Pure ESM, zero build step for developers. The browser ships a committed
 * esbuild IIFE bundle (pearl-policy.bundle.js); node runs this file directly
 * for the verification suite.
 *
 * What this does:
 *   1. Design: the user composes a taptree of 1-8 leaves from audited
 *      templates ONLY (expert mode: raw script hex, with loud warnings):
 *        keylock:    <xonly> OP_CHECKSIG
 *                      byte-identical to the audited Pearl Bounty award leaf
 *        timelock:   <height> OP_CHECKLOCKTIMEVERIFY OP_DROP <xonly> OP_CHECKSIG
 *                      byte-identical to the audited Pearl Escrow refund leaf
 *        multisig:   <0> <K1> CHECKSIGADD <K2> CHECKSIGADD ... <Kn> CHECKSIGADD <m> EQUAL
 *                      the audited Pearl Covenant multisig script pattern
 *      The internal key is one of:
 *        nums:   nothing-up-my-sleeve point under the domain tag
 *                "PearlPolicyNUMS/v1", mirroring escrow's NUMS pattern
 *                (taggedHash of the leaf hashes, lift_x, counter fallback).
 *                Nobody's key — the keypath is intentionally unspendable.
 *        bip86:  x-only key derived from a BIP-86 mnemonic (user's key —
 *                keypath spends ARE possible by whoever holds the mnemonic).
 *        key:    a pasted x-only public key (spendable by its holder).
 *   2. Address: taptree assembled per BIP-341 (leaf hashes sorted
 *      lexicographically, pairwise TapBranch combining, odd leaf carried —
 *      the Bitcoin Core reference pairing), internal key tweaked by the
 *      merkle root, bech32m prl1... P2TR address, and a per-leaf control
 *      block carrying the full merkle path (spend-ready for Pearl Sign).
 *   3. Verify: standalone paste-descriptor verifier — recomputes the whole
 *      tree and rules PROVEN / NOT PROVEN against the claimed address
 *      (tampering any leaf or parameter moves the address, loudly).
 *   4. Export: descriptor JSON, shareable #p= URL, markdown summary.
 *   5. Learn: honest explainer of what policy trees prove vs. what they don't.
 *
 * NO new cryptography. Every primitive is the audited lineage:
 *   BIP-340 Schnorr + BIP-341 taggedHash/TapLeafHash/TapTweak/TapBranch +
 *   bech32m + lift_x come from files/pages/sign/src/crypto.js;
 *   the leaf templates are the audited builders from bounty-core
 *   (buildAwardScript), escrow-core (buildRefundScript, scriptAsm,
 *   encodeScriptNum, pushData, partyKeyFromInput) and covenant-core
 *   (buildMultisigScript, sortKeys); the TapBranch sorted-pair hash and
 *   control-block verification mirror files/pages/escrow/src/escrow-core.js
 *   (tapBranch/verifyControlBlock), generalized to n leaves exactly as
 *   BIP-341's reference pairing requires. Tests assert every leaf is
 *   byte-equal to its audited lineage and pin descriptor/address/control
 *   block/tweak vectors.
 *
 * Honest limits, stated everywhere it matters:
 *   - This page NEVER moves PRL and never broadcasts a transaction.
 *   - The NUMS keypath is intentionally unspendable: coins sent here can
 *     move ONLY through the script leaves. Lose every leaf key and the
 *     funds are unspendable — treat that as permanent.
 *   - Templates are authorization-only: scripts prove WHO can move coins,
 *     never WHY, never at what price, never any off-chain fact.
 *   - Expert custom scripts are UNREVIEWED — verify them yourself.
 */

import {
  taggedHash, tapLeafHash, encodeBech32m, decodeBech32m,
  schnorr, sha256, bytesToHex, hexToBytes,
  p2trScriptPubKey, NETWORKS,
  walletFromMnemonic, newMnemonic,
} from "../../sign/src/crypto.js";
import {
  partyKeyFromInput, parseXOnlyKey, scriptAsm,
  encodeScriptNum, buildRefundScript,
} from "../../escrow/src/escrow-core.js";
import { buildAwardScript } from "../../bounty/src/bounty-core.js";
import { buildMultisigScript, sortKeys } from "../../covenant/src/covenant-core.js";
import { bytesToNumberBE } from "@noble/curves/abstract/utils";

export {
  NETWORKS, bytesToHex, hexToBytes, schnorr, sha256, taggedHash,
  tapLeafHash, encodeBech32m, decodeBech32m, p2trScriptPubKey,
  walletFromMnemonic, newMnemonic,
  partyKeyFromInput, parseXOnlyKey, scriptAsm,
  buildAwardScript, buildRefundScript, buildMultisigScript, sortKeys,
};

export const DESCRIPTOR_PREFIX = "pearl-policy:v1";
export const SEALED_PREFIX = "pearl-policy:v1";
export const MAX_LEAVES = 8;
export const NUMS_DOMAIN = "PearlPolicyNUMS/v1";
const TAPLEAF_VERSION = 0xc0; // BIP-341 leaf version
const MAX_CUSTOM_SCRIPT_BYTES = 10000; // same as Bitcoin Core script limit
const LEAF_KINDS = ["keylock", "timelock", "multisig", "custom"];

function constEq(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

/* ---------- leaf templates (audited lineage, asserted byte-equal by test) ---------- */

/** Resolve a leaf/internal key from free-form input: 64-hex x-only pubkey,
 *  12/24-word mnemonic (BIP-86 account 0 — the wallet's x-only key), or a
 *  prl1... P2TR address (its 32-byte program). Audited partyKeyFromInput +
 *  decodeBech32m; no new cryptography. */
export function policyKeyFromInput(input, network) {
  const t = String(input || "").trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) {
    return { xonly: parseXOnlyKey(t), source: "x-only pubkey" };
  }
  const words = t.split(/\s+/);
  if (words.length === 12 || words.length === 24) {
    const w = walletFromMnemonic(t, network);
    return { xonly: w.internalXOnly, source: "mnemonic (BIP-86 account 0)" };
  }
  const dec = decodeBech32m(t, network.hrp); // throws on bad address
  if (dec.version !== 1 || dec.program.length !== 32) throw new Error("address is not a P2TR (v1, 32-byte) address");
  return { xonly: dec.program, source: "PRL address (program)" };
}

/** KeyLock leaf: <xonly> OP_CHECKSIG — byte-identical to the audited
 *  Pearl Bounty award leaf (buildAwardScript). */
export function templateKeylock(xonlyHex) {
  return buildAwardScript(parseXOnlyKey(xonlyHex));
}

/** TimelockRefund leaf: <height> OP_CHECKLOCKTIMEVERIFY OP_DROP <xonly>
 *  OP_CHECKSIG — byte-identical to the audited Pearl Escrow refund leaf
 *  (buildRefundScript). */
export function templateTimelock(xonlyHex, height) {
  return buildRefundScript(parseXOnlyKey(xonlyHex), height);
}

/** MultiSig leaf: <0> <K1> CHECKSIGADD ... <Kn> CHECKSIGADD <m> EQUAL —
 *  the audited Pearl Covenant multisig script pattern
 *  (sortKeys + buildMultisigScript). */
export function templateMultisig(keyHexes, m) {
  const parsed = keyHexes.map((k) => parseXOnlyKey(k));
  return buildMultisigScript(sortKeys(parsed), m);
}

/* ---------- internal key sources ---------- */

const TE = new TextEncoder();
const utf8 = (s) => TE.encode(s);

/** NUMS internal key: taggedHash("PearlPolicyNUMS/v1",
 *  sorted(tapLeafHash(leaf1)) || ... || sorted(tapLeafHash(leafN))) lifted to
 *  the curve, counter fallback included. Mirrors escrow's NUMS pattern
 *  (PearlEscrowNUMS/v1 over the leaf hashes with a lift counter): nobody
 *  knows the discrete log, so the keypath is intentionally unspendable. */
export function numsInternalKeyPolicy(leafScripts) {
  if (!Array.isArray(leafScripts) || leafScripts.length < 1 || leafScripts.length > MAX_LEAVES) {
    throw new Error(`need 1..${MAX_LEAVES} leaf scripts`);
  }
  const hashes = leafScripts.map(tapLeafHash).map(bytesToHex).sort().map(hexToBytes);
  for (let c = 0; c < 256; c++) {
    const preimage = c === 0 ? hashes : [...hashes, new Uint8Array([c])];
    const h = taggedHash(NUMS_DOMAIN, Uint8Array.from(preimage.flatMap((x) => [...x])));
    try {
      schnorr.utils.lift_x(bytesToNumberBE(h));
      return h;
    } catch { /* try next counter */ }
  }
  throw new Error("POLICY REFUSED: NUMS lift failed (unreachable in practice)");
}

/** BIP-86 mnemonic-derived x-only key (user's own key — keypath spendable
 *  by whoever holds the mnemonic). Audited walletFromMnemonic. */
export function bip86InternalKey(mnemonic, network, account = 86, index = 0) {
  const w = walletFromMnemonic(mnemonic, network, account, index);
  return { xonly: w.internalXOnly, address: w.address };
}

/* ---------- n-leaf BIP-341 taptree ---------- */

/** Sorted-pair TapBranch — mirrors escrow-core's tapBranch one-liner
 *  (BIP-341: siblings are hashed in lexicographic order). */
function tapBranch(a, b) {
  const [x, y] = bytesToHex(a) <= bytesToHex(b) ? [a, b] : [b, a];
  return taggedHash("TapBranch", Uint8Array.from([...x, ...y]));
}

/** General n-leaf taptree. Leaf hashes are sorted lexicographically, then
 *  combined pairwise (odd leaf carried) exactly like the BIP-341 reference
 *  pairing; each leaf's control block carries its full merkle path.
 *  For 2 leaves this reduces to escrow's taptree2. */
export function taptreeN(network, internalXOnly, leafScripts) {
  if (!(internalXOnly instanceof Uint8Array) || internalXOnly.length !== 32) {
    throw new Error("internal key must be 32 bytes");
  }
  if (!Array.isArray(leafScripts) || leafScripts.length < 1 || leafScripts.length > MAX_LEAVES) {
    throw new Error(`need 1..${MAX_LEAVES} leaf scripts`);
  }
  // Canonical leaf order: sorted by leaf hash (deterministic tree).
  const leaves = leafScripts
    .map((script) => ({ script, hash: tapLeafHash(script) }))
    .sort((a, b) => (bytesToHex(a.hash) < bytesToHex(b.hash) ? -1 : 1));
  // Pairwise levels; track each leaf's merkle path.
  let level = leaves.map((l, i) => ({ hash: l.hash, leafIndices: [i] }));
  const levels = [level.map((n) => ({ ...n }))]; // for the visualizer
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) {
        const h = tapBranch(level[i].hash, level[i + 1].hash);
        // record each covered leaf's sibling
        for (const li of level[i].leafIndices) (leaves[li].path ??= []).push(level[i + 1].hash);
        for (const li of level[i + 1].leafIndices) (leaves[li].path ??= []).push(level[i].hash);
        next.push({ hash: h, leafIndices: [...level[i].leafIndices, ...level[i + 1].leafIndices] });
      } else {
        next.push({ hash: level[i].hash, leafIndices: level[i].leafIndices });
      }
    }
    levels.push(next.map((n) => ({ ...n })));
    level = next;
  }
  const root = level[0].hash;
  const t = taggedHash("TapTweak", Uint8Array.from([...internalXOnly, ...root]));
  const P = schnorr.utils.lift_x(bytesToNumberBE(internalXOnly));
  const Q = P.add(schnorr.Point.BASE.multiply(bytesToNumberBE(t)));
  const tweakedX = schnorr.utils.pointToBytes(Q);
  const parity = Q.toAffine().y & 1n ? 1 : 0;
  const controlBlocks = leaves.map((l) =>
    Uint8Array.from([
      TAPLEAF_VERSION | parity,
      ...internalXOnly,
      ...(l.path ?? []).flatMap((h) => [...h]),
    ])
  );
  return {
    leaves, // [{script, hash, path}] in canonical (sorted) order
    levels,
    root,
    tweak: t,
    tweakedX,
    parity,
    address: encodeBech32m(network.hrp, 1, tweakedX),
    spk: p2trScriptPubKey(tweakedX),
    controlBlocks,
  };
}

/** Verify a control block against the tweaked key — generalizes escrow's
 *  verifyControlBlock to n-leaf trees by walking the full merkle path. */
export function verifyPolicyControlBlock(internalXOnly, leafScript, controlBlock, tweakedX) {
  try {
    // 33-byte header+key, plus one 32-byte sibling per merkle level (1-leaf
    // trees have zero siblings, so 33 is valid).
    if (!(controlBlock instanceof Uint8Array) || controlBlock.length < 33) return false;
    if ((controlBlock.length - 33) % 32 !== 0) return false;
    if ((controlBlock[0] & 0xfe) !== TAPLEAF_VERSION) return false;
    if (!constEq(controlBlock.slice(1, 33), internalXOnly)) return false;
    let h = tapLeafHash(leafScript);
    for (let i = 33; i < controlBlock.length; i += 32) {
      h = tapBranch(h, controlBlock.slice(i, i + 32));
    }
    const t = taggedHash("TapTweak", Uint8Array.from([...internalXOnly, ...h]));
    const P = schnorr.utils.lift_x(bytesToNumberBE(internalXOnly));
    const Q = P.add(schnorr.Point.BASE.multiply(bytesToNumberBE(t)));
    const x = schnorr.utils.pointToBytes(Q);
    const parity = Q.toAffine().y & 1n ? 1 : 0;
    return constEq(x, tweakedX) && (controlBlock[0] & 0x01) === parity;
  } catch {
    return false;
  }
}

/* ---------- leaf spec (descriptor encoding) ---------- */

/** Canonical leaf encodings:
 *    keylock:  k:<xonly64>
 *    timelock: t:<height>:<xonly64>
 *    multisig: m:<m>of<n>:<k1>:<k2>:...   (keys sorted lexicographically)
 *    custom:   x:<hex>
 */
export function parseLeafSpec(spec) {
  if (typeof spec !== "string" || !spec.length) throw new Error("empty leaf spec");
  const kind = spec[0];
  const rest = spec.slice(2);
  if (!spec.startsWith(kind + ":")) throw new Error(`bad leaf spec: ${spec.slice(0, 24)}`);
  if (kind === "k") {
    if (!/^[0-9a-f]{64}$/.test(rest)) throw new Error("keylock key must be 64-hex");
    return { kind: "keylock", xonly: rest, script: templateKeylock(rest) };
  }
  if (kind === "t") {
    const parts = rest.split(":");
    if (parts.length !== 2 || !/^[1-9][0-9]*$/.test(parts[0]) || !/^[0-9a-f]{64}$/.test(parts[1])) {
      throw new Error("timelock spec must be t:<height>:<xonly64>");
    }
    const height = Number(parts[0]);
    if (!Number.isSafeInteger(height) || height >= 500000000) throw new Error("timelock height must be a positive block height (< 500000000)");
    return { kind: "timelock", height, xonly: parts[1], script: templateTimelock(parts[1], height) };
  }
  if (kind === "m") {
    const parts = rest.split(":");
    const mOfN = parts[0].match(/^([1-9][0-9]*)of([1-9][0-9]*)$/);
    if (!mOfN) throw new Error("multisig spec must be m:<m>of<n>:<keys...>");
    const m = Number(mOfN[1]), n = Number(mOfN[2]);
    const keys = parts.slice(1);
    if (keys.length !== n) throw new Error(`multisig declared ${n} keys but has ${keys.length}`);
    if (m > n) throw new Error("multisig m cannot exceed n");
    if (!keys.every((k) => /^[0-9a-f]{64}$/.test(k))) throw new Error("multisig keys must be 64-hex");
    return { kind: "multisig", m, n, keys, script: templateMultisig(keys, m) };
  }
  if (kind === "x") {
    if (!/^[0-9a-f]+$/.test(rest) || rest.length % 2 !== 0) throw new Error("custom script must be hex");
    const script = hexToBytes(rest);
    if (script.length === 0 || script.length > MAX_CUSTOM_SCRIPT_BYTES) {
      throw new Error(`custom script must be 1..${MAX_CUSTOM_SCRIPT_BYTES} bytes`);
    }
    return { kind: "custom", scriptHex: rest, script };
  }
  throw new Error(`unknown leaf kind '${kind}' (k/t/m/x only)`);
}

export function leafToSpec(leaf) {
  if (leaf.kind === "keylock") return `k:${leaf.xonly}`;
  if (leaf.kind === "timelock") return `t:${leaf.height}:${leaf.xonly}`;
  if (leaf.kind === "multisig") return `m:${leaf.m}of${leaf.n}:${leaf.keys.join(":")}`;
  if (leaf.kind === "custom") return `x:${bytesToHex(leaf.script)}`;
  throw new Error(`unknown leaf kind ${leaf.kind}`);
}

/* ---------- canonical descriptor ---------- */

/** Canonical descriptor:
 *    pearl-policy:v1:<hrp>:<isrc>:<leaf1>;<leaf2>;...
 *  <isrc> is one of: `nums` (NUMS internal key, recommended), `bip86`
 *  (mnemonic-derived), or `key:<xonly64>` (pasted key).
 *  Every parameter that moves the address is in here; everything else
 *  (labels, notes) is metadata the descriptor does not cover. */
export function policyDescriptor({ network, internalSource, leafSpecs }) {
  if (!["nums", "bip86", "key"].includes(internalSource.mode)) throw new Error("bad internal source mode");
  let isrc = internalSource.mode;
  if (internalSource.mode === "key") {
    const k = parseXOnlyKey(internalSource.xonly);
    isrc = `key:${bytesToHex(k)}`;
  }
  if (!Array.isArray(leafSpecs) || leafSpecs.length < 1 || leafSpecs.length > MAX_LEAVES) {
    throw new Error(`need 1..${MAX_LEAVES} leaf specs`);
  }
  const parsed = leafSpecs.map((s) => (typeof s === "string" ? parseLeafSpec(s) : s));
  const seen = new Set();
  for (const l of parsed) {
    const hx = bytesToHex(l.script);
    if (seen.has(hx)) throw new Error("duplicate leaf script — leaves must differ");
    seen.add(hx);
  }
  return `${DESCRIPTOR_PREFIX}:${network.hrp}:${isrc}:${parsed.map(leafToSpec).join(";")}`;
}

export function sealedCommitment(descriptor) {
  return `${SEALED_PREFIX}:${descriptor.split(":")[2]}:${bytesToHex(sha256(utf8(descriptor)))}`;
}

/** Parse a descriptor and fully recompute the tree — throws loudly on any
 *  tamper or inconsistency. Returns the full blueprint. */
export function policyFromDescriptor(descriptor, internalParams = {}) {
  if (typeof descriptor !== "string") throw new Error("descriptor must be text");
  const parts = descriptor.split(":");
  if (parts.length < 5 || parts[0] !== "pearl-policy" || parts[1] !== "v1") {
    throw new Error("bad policy descriptor (expected pearl-policy:v1:<hrp>:<isrc>:<leaves>)");
  }
  const hrp = parts[2];
  const network = Object.values(NETWORKS).find((n) => n.hrp === hrp);
  if (!network) throw new Error(`unknown network hrp '${hrp}'`);
  // isrc may itself contain a colon ("key:<xonly64>")
  let isrc = parts[3];
  let leafStart = 4;
  if (isrc === "key") {
    if (parts.length < 6) throw new Error("bad policy descriptor (expected pearl-policy:v1:<hrp>:<isrc>:<leaves>)");
    isrc = parts[3] + ":" + parts[4];
    leafStart = 5;
  }
  const leafText = parts.slice(leafStart).join(":");
  const leafSpecs = leafText.split(";");
  const leaves = leafSpecs.map(parseLeafSpec);
  const scripts = leaves.map((l) => l.script);
  let internalXOnly, internalLabel;
  if (isrc === "nums") {
    internalXOnly = numsInternalKeyPolicy(scripts);
    internalLabel = "NUMS — nobody's key (keypath intentionally unspendable)";
  } else if (isrc === "bip86") {
    if (!internalParams.mnemonic) throw new Error("bip86 descriptor needs the mnemonic to derive the internal key");
    internalXOnly = bip86InternalKey(internalParams.mnemonic, network).xonly;
    internalLabel = "BIP-86 mnemonic-derived key (keypath spendable by the mnemonic holder)";
  } else if (isrc.startsWith("key:")) {
    internalXOnly = parseXOnlyKey(isrc.slice(4));
    internalLabel = "pasted x-only key (keypath spendable by its holder)";
  } else {
    throw new Error(`bad internal-key source '${isrc.slice(0, 16)}'`);
  }
  const tree = taptreeN(network, internalXOnly, scripts);
  // canonicalize: the descriptor must be the canonical form (round-trip)
  const rebuilt = policyDescriptor({
    network,
    internalSource: isrc === "nums" ? { mode: "nums" }
      : isrc === "bip86" ? { mode: "bip86" }
      : { mode: "key", xonly: bytesToHex(internalXOnly) },
    leafSpecs: leaves,
  });
  if (rebuilt !== descriptor) throw new Error("descriptor is not canonical — re-derived form differs");
  return {
    descriptor,
    sealed: sealedCommitment(descriptor),
    network,
    internalSourceMode: isrc.startsWith("key:") ? "key" : isrc,
    internalXOnly,
    internalLabel,
    address: tree.address,
    spk: tree.spk,
    root: tree.root,
    tweak: tree.tweak,
    tweakedX: tree.tweakedX,
    parity: tree.parity,
    levels: tree.levels,
    leaves: tree.leaves.map((l, i) => ({
      index: i,
      kind: leaves.find((pl) => constEq(pl.script, l.script)).kind,
      script: l.script,
      scriptHex: bytesToHex(l.script),
      asm: scriptAsm(l.script),
      leafHash: bytesToHex(l.hash),
      controlBlock: bytesToHex(tree.controlBlocks[i]),
      controlValid: verifyPolicyControlBlock(internalXOnly, l.script, tree.controlBlocks[i], tree.tweakedX),
      path: (l.path ?? []).map(bytesToHex),
      depth: (l.path ?? []).length,
    })),
  };
}

/* ---------- forge (UI entry) ---------- */

/** Build a policy blueprint from UI inputs. internalSource:
 *   { mode: "nums" }
 *   { mode: "bip86", mnemonic }
 *   { mode: "key", xonly }   (hex, PRL address, or mnemonic via partyKeyFromInput)
 *  leafInputs: [{ kind:"keylock", xonly }, { kind:"timelock", xonly, height },
 *               { kind:"multisig", m, keys:[...] }, { kind:"custom", hex }] */
export function forgePolicy({ network, internalSource, leafInputs }) {
  if (!Object.values(NETWORKS).includes(network)) throw new Error("bad network");
  if (!Array.isArray(leafInputs) || leafInputs.length < 1 || leafInputs.length > MAX_LEAVES) {
    throw new Error(`need 1..${MAX_LEAVES} leaves`);
  }
  const leafSpecs = leafInputs.map((li, i) => {
    try {
      if (li.kind === "keylock") {
        const { xonly } = policyKeyFromInput(li.xonly, network);
        return { kind: "keylock", xonly: bytesToHex(xonly), script: templateKeylock(bytesToHex(xonly)) };
      }
      if (li.kind === "timelock") {
        const { xonly } = policyKeyFromInput(li.xonly, network);
        const height = Number(li.height);
        if (!Number.isSafeInteger(height) || height <= 0 || height >= 500000000) {
          throw new Error("timelock height must be a positive block height (< 500000000)");
        }
        return { kind: "timelock", height, xonly: bytesToHex(xonly), script: templateTimelock(bytesToHex(xonly), height) };
      }
      if (li.kind === "multisig") {
        const keys = li.keys.map((k) => bytesToHex(policyKeyFromInput(k, network).xonly));
        const m = Number(li.m);
        return { kind: "multisig", m, n: keys.length, keys: [...new Set(keys)].sort(), script: templateMultisig(keys, m) };
      }
      if (li.kind === "custom") {
        return parseLeafSpec(`x:${String(li.hex).trim().toLowerCase().replace(/^0x/, "")}`);
      }
      throw new Error(`unknown leaf kind '${li.kind}'`);
    } catch (e) {
      throw new Error(`leaf ${i + 1}: ${e.message}`);
    }
  });
  let isrc;
  if (internalSource.mode === "nums") isrc = { mode: "nums" };
  else if (internalSource.mode === "bip86") {
    if (!internalSource.mnemonic || !internalSource.mnemonic.trim()) throw new Error("BIP-86 needs a mnemonic");
    isrc = { mode: "bip86" };
  } else if (internalSource.mode === "key") {
    isrc = { mode: "key", xonly: bytesToHex(policyKeyFromInput(internalSource.xonly, network).xonly) };
  } else throw new Error("bad internal source mode");
  const descriptor = policyDescriptor({ network, internalSource: isrc, leafSpecs });
  return policyFromDescriptor(
    descriptor,
    isrc.mode === "bip86" ? { mnemonic: internalSource.mnemonic } : {}
  );
}

/* ---------- standalone verifier ---------- */

/** verifyPolicy(descriptor, claimedAddress, sealed?)
 *  PROVEN only when: the descriptor parses strictly, round-trips canonical,
 *  the recomputed address equals the claimed address, and (if given) the
 *  sealed commitment equals sha256(descriptor). Anything else is loud
 *  NOT PROVEN with the reason. */
export function verifyPolicy(descriptor, claimedAddress, sealed) {
  const clean = String(descriptor || "").trim();
  try {
    const bp = policyFromDescriptor(clean);
    const claimed = String(claimedAddress || "").trim();
    let claimedProgram = null;
    try {
      const dec = decodeBech32m(claimed);
      claimedProgram = dec.program;
      if (dec.version !== 1 || dec.program.length !== 32) throw new Error("not a v1 32-byte program");
      if (dec.hrp !== bp.network.hrp) throw new Error(`claimed address is ${dec.hrp}, descriptor is ${bp.network.hrp}`);
    } catch (e) {
      return { proven: false, reason: `claimed address does not parse as this network's P2TR address: ${e.message}` };
    }
    if (!constEq(claimedProgram, bp.tweakedX)) {
      return {
        proven: false,
        reason: "address mismatch — the claimed address does not match the descriptor. A tampered leaf, parameter, or internal key source moves the address.",
        recomputedAddress: bp.address,
      };
    }
    if (sealed && sealed.trim() !== "") {
      const s = sealed.trim();
      if (s !== bp.sealed) {
        return {
          proven: false,
          reason: `sealed commitment does not match — expected ${bp.sealed}`,
          recomputedAddress: bp.address,
        };
      }
    }
    return { proven: true, reason: "descriptor is canonical and re-derives the claimed address exactly", blueprint: bp };
  } catch (e) {
    return { proven: false, reason: e.message };
  }
}

/* ---------- export ---------- */

export function shareUrl(descriptor) {
  return `${location.origin}${location.pathname}#p=${encodeURIComponent(descriptor)}`;
}

export function exportJson(blueprint) {
  return JSON.stringify(
    {
      app: "Pearl Policy",
      version: 1,
      descriptor: blueprint.descriptor,
      sealed: blueprint.sealed,
      network: blueprint.network.hrp,
      internalSource: blueprint.internalSourceMode,
      internalXOnly: bytesToHex(blueprint.internalXOnly),
      address: blueprint.address,
      scriptPubKey: bytesToHex(blueprint.spk),
      merkleRoot: bytesToHex(blueprint.root),
      tweak: bytesToHex(blueprint.tweak),
      leaves: blueprint.leaves.map((l) => ({
        kind: l.kind,
        asm: l.asm,
        scriptHex: l.scriptHex,
        leafHash: l.leafHash,
        controlBlock: l.controlBlock,
        controlBlockVerified: l.controlValid,
      })),
      honestLimits: [
        "This descriptor never moves PRL and never broadcasts.",
        "NUMS internal key: keypath intentionally unspendable; only the script leaves can spend.",
        "Templates are authorization-only: they prove WHO can move coins, never WHY.",
      ],
    },
    null,
    2
  );
}

export function exportMarkdown(blueprint) {
  const lines = [
    `# Pearl Policy blueprint`,
    ``,
    `- Network: ${blueprint.network.name} (${blueprint.network.hrp})`,
    `- Internal key: ${blueprint.internalSourceMode} — ${blueprint.internalLabel}`,
    `- Address: \`${blueprint.address}\``,
    `- scriptPubKey: \`${bytesToHex(blueprint.spk)}\``,
    `- Merkle root: \`${bytesToHex(blueprint.root)}\``,
    `- Descriptor: \`${blueprint.descriptor}\``,
    `- Sealed: \`${blueprint.sealed}\``,
    ``,
    `## Leaves (${blueprint.leaves.length})`,
  ];
  for (const l of blueprint.leaves) {
    lines.push(``, `### Leaf ${l.index + 1} — ${l.kind}`, ``, `\`\`\``, `${l.asm}`, `\`\`\``, ``, `- leaf hash: \`${l.leafHash}\``, `- control block: \`${l.controlBlock}\` (verified: ${l.controlValid})`);
  }
  lines.push(``, `## Honest limits`, ``, `- This page never moves PRL and never broadcasts.`, `- NUMS keypath is intentionally unspendable.`, `- Scripts prove authorization paths, not economic facts.`);
  return lines.join("\n");
}

export { constEq };
