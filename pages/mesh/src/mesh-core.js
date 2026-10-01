/* Pearl Mesh core — MuSig2 collaborative keypath signing desk for PRL.
 *
 * Pure ESM, zero build step for developers. The browser ships a committed
 * esbuild IIFE bundle (pearl-mesh.bundle.js); node runs this file directly
 * for the verification suite.
 *
 * What this does:
 *   1. Members: 2-7 participants, each identified by a 32-byte x-only
 *      pubkey (BIP-86 wallet locally, or a pasted key).
 *   2. Key aggregation (BIP-327, the MuSig2 key-aggregation construction):
 *      keys sorted lexicographically by x-only bytes, L = sha256("KeyAgg
 *      list" || sorted keys), per-key coefficients
 *      a_i = int(tagged_hash("KeyAgg coefficient", L || P_i)) mod n,
 *      aggregate internal key Q = sum(a_i * P_i). Q is parity-normalized to
 *      even y (gacc = 1 or n-1 recorded), then TapTweaked with the EMPTY
 *      merkle root (tweakKeypath, the audited Sign core primitive):
 *      Q* = Q + H_TapTweak(Q)*G. Funds sent to the P2TR address look like a
 *      single-key Taproot address — there is no script leaf at all.
 *   3. Tamper-evident descriptor: canonical JSON of the sorted member list
 *      plus L, coefficients, and the tweaked address, sealed as
 *      pearl-mesh:v1:<hrp>:<sha256(canonical)>.
 *   4. Nonce ceremony (BIP-327 nonce aggregation, interactive by design):
 *        k1i, k2i = deterministic tagged-hash nonces from
 *          (session salt || member secret || agg key || L || message)
 *        each member publishes R1i = k1i*G, R2i = k2i*G
 *        coordinator: R1 = sum R1i, R2 = sum R2i,
 *          b = int(tagged_hash("MuSig/noncecoef", L || R1 || R2 || Q || m)),
 *          R = R1 + b*R2 (negated to even y when needed; parity is shipped
 *          in the agg-R bundle so signers negate their nonces identically)
 *        each member: e = int(tagged_hash("BIP0340/challenge", R || Q* || m)),
 *          s_i = k1i' + b*k2i' + e*(gacc*a_i*d_i + t) mod n
 *        coordinator: s = sum s_i; final sig (R || s) verifies as a plain
 *          BIP-340 Schnorr signature under the tweaked aggregate key Q*.
 *   5. KEY REFUSED guards: a member may sign only with the secret whose
 *      x-only pubkey occupies their slot.
 *
 * NO new cryptography on the wire format: BIP-340 Schnorr, BIP-341
 * taggedHash/TapTweak, bech32m, lift_x, BIP-86 derivation all come from the
 * audited files/pages/sign/src/crypto.js lineage. The MuSig2 arithmetic
 * above is implemented from the BIP-327 construction (coefficients,
 * nonce aggregation, partial-signature equation); it is self-consistent
 * and verified by round-trip tests (aggregate partials -> final BIP-340
 * sig verifies against the tweaked aggregate key), NOT by byte-interop
 * with an external MuSig2 implementation. The deterministic-nonce domain
 * strings are Pearl-Mesh's own ("PearlMesh/nonce1", "PearlMesh/nonce2");
 * the MuSig2* tags ("KeyAgg list", "KeyAgg coefficient", "MuSig/noncecoef",
 * "BIP0340/challenge") follow BIP-327 exactly.
 *
 * Honest limits, stated everywhere it matters:
 *   - MuSig2 is n-of-n. There is no threshold variant: every member must
 *     take part in the nonce ceremony and sign. Lose one key and the
 *     aggregate key is unspendable — treat that as permanent.
 *   - The nonce ceremony is interactive: remote members must honestly
 *     generate fresh nonces. A member who reuses a nonce across sessions
 *     (or leaks one) leaks their key share. The desk generates a fresh
 *     random session salt per ceremony; members must not reuse bundles.
 *   - Simulation mode (one browser holds all keys) is demo-grade: it
 *     exercises the math, not the distributed trust.
 *   - This page NEVER moves PRL and NEVER broadcasts a transaction. It
 *     computes addresses, bundles, and signatures on digests you supply.
 *     Spending from a mesh address means signing the real BIP-341 sighash
 *     of a real transaction — do that deliberately, on mainnet, with
 *     everyone watching.
 */

import {
  taggedHash, encodeBech32m, decodeBech32m,
  schnorr, sha256, bytesToHex, hexToBytes,
  tweakKeypath, NETWORKS, GRAIN_PER_PRL, DUST_GRAIN,
  newMnemonic, walletFromMnemonic, walletFromPriv,
} from "../../sign/src/crypto.js";
import { secp256k1 } from "@noble/curves/secp256k1";
import {
  fmtPRL, parsePRL, fetchUtxos, parseUtxoList,
} from "../../sign/src/sign-core.js";
import { bytesToNumberBE, numberToBytesBE } from "@noble/curves/abstract/utils";

export {
  NETWORKS, GRAIN_PER_PRL, DUST_GRAIN, bytesToHex, hexToBytes, schnorr,
  sha256, taggedHash, encodeBech32m, decodeBech32m, tweakKeypath,
  newMnemonic, walletFromMnemonic, walletFromPriv, fmtPRL, parsePRL,
  fetchUtxos, parseUtxoList,
};

export const DESCRIPTOR_PREFIX = "pearl-mesh:v1";
export const MIN_MEMBERS = 2;
export const MAX_MEMBERS = 7;

/** Derive `count` BIP-86 member keys from a mnemonic at
 *  m/86'/808276'/0'/0/<startIndex+i> (Pearl's BIP-86 coin type on mainnet;
 *  member keys are network-agnostic). Returns [{priv, pub, path}] with the
 *  32-byte x-only pubkey. Throws on an invalid mnemonic. */
export function deriveBip86Keys(mnemonic, startIndex, count) {
  if (!Number.isInteger(startIndex) || startIndex < 0) throw new Error("bad key index");
  if (!Number.isInteger(count) || count < 1) throw new Error("bad key count");
  const out = [];
  for (let k = 0; k < count; k++) {
    const i = startIndex + k;
    const w = walletFromMnemonic(mnemonic, NETWORKS.mainnet, 0, i);
    out.push({ priv: w.priv, pub: w.internalXOnly, path: `m/86'/808276'/0'/0/${i}` });
  }
  return out;
}

const N = secp256k1.CURVE.n;
const G = schnorr.Point.BASE;
const liftX = (x) => schnorr.utils.lift_x(bytesToNumberBE(x));
const xOnly = (P) => schnorr.utils.pointToBytes(P);
const mod = (v) => ((v % N) + N) % N;
const num = (bytes) => bytesToNumberBE(bytes);
const scalar = (v) => numberToBytesBE(mod(v), 32);

/* ---------------- parsing ---------------- */

/** Parse and validate an x-only pubkey (64 hex). Returns 32 bytes.
 *  Curve validity is checked via lift_x (rejects x >= p). */
export function parseXOnlyKey(hex, what = "x-only pubkey") {
  if (typeof hex !== "string") throw new Error(`${what} must be a string`);
  const h = hex.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(h)) throw new Error(`${what} must be 64 hex chars`);
  const b = hexToBytes(h);
  liftX(b); // throws when x is not a valid curve coordinate
  return b;
}

/** Normalize a member secret to the even-y convention: returns {d, pub}
 *  with d*G == lift_x(pub) and pub the x-only key. */
export function memberFromPriv(priv) {
  const p = priv instanceof Uint8Array ? priv : hexToBytes(String(priv).trim());
  if (p.length !== 32) throw new Error("private key must be 32 bytes");
  let d = num(p);
  if (d === 0n || d >= N) throw new Error("private key out of range");
  const P = G.multiply(d);
  if ((P.toAffine().y & 1n) === 1n) d = N - d;
  const pub = xOnly(P); // x is unchanged by negation
  return { d, pub };
}

/* ---------------- key aggregation (BIP-327) ---------------- */

/** Aggregate n x-only pubkeys (Uint8Array(32) each).
 *  Returns {sorted, L, coefficients, aggX, gacc} where:
 *    sorted       — the keys sorted lexicographically by x-only bytes
 *    L            — sha256("KeyAgg list" || sorted keys...) (32 bytes)
 *    coefficients — a_i = int(tagged_hash("KeyAgg coefficient", L || P_i)) mod n
 *    aggX         — x-only aggregate internal key Q, EVEN y (negated when needed)
 *    gacc         — 1n when Q had even y, N-1n when it was negated
 *  Throws on duplicates, wrong count, or a non-curve key. */
export function musigKeyAgg(pubkeys) {
  if (!Array.isArray(pubkeys)) throw new Error("pubkeys must be an array");
  if (pubkeys.length < MIN_MEMBERS || pubkeys.length > MAX_MEMBERS)
    throw new Error(`mesh needs ${MIN_MEMBERS}-${MAX_MEMBERS} members, got ${pubkeys.length}`);
  const keys = pubkeys.map((k, i) => {
    const b = k instanceof Uint8Array && k.length === 32 ? k : parseXOnlyKey(k, `member ${i + 1} key`);
    liftX(b);
    return b;
  });
  const sorted = [...keys].sort((a, b) => {
    for (let i = 0; i < 32; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return 0;
  });
  for (let i = 1; i < sorted.length; i++)
    if (bytesToHex(sorted[i]) === bytesToHex(sorted[i - 1])) throw new Error("duplicate member keys are not allowed");
  const L = sha256(Uint8Array.from([...utf8("KeyAgg list"), ...sorted.flatMap((k) => [...k])]));
  const coefficients = sorted.map((P) => mod(num(taggedHash("KeyAgg coefficient", Uint8Array.from([...L, ...P])))));
  if (coefficients.some((a) => a === 0n)) throw new Error("degenerate MuSig2 coefficient (hash to zero)");
  let Q = null;
  for (let i = 0; i < sorted.length; i++) {
    const term = liftX(sorted[i]).multiply(coefficients[i]);
    Q = Q ? Q.add(term) : term;
  }
  let gacc = 1n;
  if ((Q.toAffine().y & 1n) === 1n) { Q = Q.negate(); gacc = N - 1n; }
  return { sorted, L, coefficients, aggX: xOnly(Q), gacc };
}

function utf8(s) {
  const out = [];
  for (const c of s) out.push(c.charCodeAt(0));
  return Uint8Array.from(out);
}

/** TapTweak the aggregate internal key (empty merkle root, keypath-only).
 *  Returns {tweakedX, t, pacc}: Q* = Q + t*G, t = int(tagged_hash("TapTweak", Q)).
 *  Reuses the audited crypto.js tweakKeypath (which expects even-y input).
 *
 *  Parity: Q* itself can land on odd y. BIP-340 signs against lift_x(Q*_x)
 *  (the even-y point), so the whole aggregate secret is negated when Q*
 *  is odd: pacc = 1 or N-1. Members fold pacc into their shares and the
 *  coordinator into the tweak term (see signShare / aggregatePartials).
 *
 *  Tweak accounting (MuSig2 paper, plain tweaking): each member signs with
 *  the UNtweaked share sk_i = pacc*gacc*a_i*d_i, and the coordinator adds
 *  e*pacc*t ONCE to the aggregate s. (Adding t inside every member's share
 *  would add n*t — the tweak belongs to the aggregate, not to each share.) */
export function musigTweak(aggX) {
  const { tweakedX, t } = tweakKeypath(aggX);
  const tNum = num(t);
  const Qstar = liftX(aggX).add(G.multiply(tNum));
  const pacc = (Qstar.toAffine().y & 1n) === 1n ? N - 1n : 1n;
  return { tweakedX, t: tNum, pacc };
}

/** The member's signing share: sk_i = pacc*gacc*a_i*d_i mod n, where d_i is
 *  the even-y-normalized secret (d_i*G == lift_x(pub_i)).
 *  Invariant: with the coordinator adding e*pacc*t once,
 *  s = sum(s_i) + e*pacc*t satisfies s*G == R + e*Q*_eff, where Q*_eff =
 *  pacc*Q* is the even-y point behind the tweaked x-only key. */
export function signShare(d, a, gacc, pacc) {
  return mod(pacc * gacc * a * d);
}

/* ---------------- descriptor ---------------- */

/** Canonical mesh descriptor. members: [{name, pubkey(64hex)}] in ANY order —
 *  the canonical form sorts by pubkey. Returns the full descriptor object
 *  {kind, v, network, members, L, coefficients, agg, tweak, address, sealed}. */
export function buildMeshDescriptor(networkId, members) {
  const network = NETWORKS[networkId];
  if (!network) throw new Error(`unknown network: ${networkId}`);
  if (!Array.isArray(members) || members.length < MIN_MEMBERS || members.length > MAX_MEMBERS)
    throw new Error(`mesh needs ${MIN_MEMBERS}-${MAX_MEMBERS} members`);
  const clean = members.map((m, i) => {
    const name = String(m.name ?? "").trim().slice(0, 40) || `Member ${i + 1}`;
    const pubkey = bytesToHex(parseXOnlyKey(m.pubkey, `member "${name}" key`));
    return { name, pubkey };
  });
  clean.sort((a, b) => (a.pubkey < b.pubkey ? -1 : a.pubkey > b.pubkey ? 1 : 0));
  for (let i = 1; i < clean.length; i++)
    if (clean[i].pubkey === clean[i - 1].pubkey) throw new Error("duplicate member keys are not allowed");
  const agg = musigKeyAgg(clean.map((m) => hexToBytes(m.pubkey)));
  const { tweakedX, t, pacc } = musigTweak(agg.aggX);
  const address = encodeBech32m(network.hrp, 1, tweakedX);
  // canonical JSON: fixed key order, no whitespace
  const canon = (o) => JSON.stringify(o);
  const paccStr = pacc === 1n ? "1" : "n-1";
  const descriptor = canon({
    kind: "pearl-mesh", v: 1, network: networkId,
    members: clean,
    L: bytesToHex(agg.L),
    coefficients: agg.coefficients.map((a) => bytesToHex(scalar(a))),
    agg: bytesToHex(agg.aggX),
    tweak: bytesToHex(scalar(t)),
    pacc: paccStr,
    address,
  });
  const sealed = `${DESCRIPTOR_PREFIX}:${network.hrp}:${bytesToHex(sha256(utf8(descriptor)))}`;
  return {
    kind: "pearl-mesh", v: 1, network: networkId, members: clean,
    L: bytesToHex(agg.L),
    coefficients: agg.coefficients.map((a) => bytesToHex(scalar(a))),
    agg: bytesToHex(agg.aggX),
    tweak: bytesToHex(scalar(t)),
    gacc: agg.gacc === 1n ? "1" : "n-1",
    pacc: paccStr,
    address,
    descriptor,
    sealed,
  };
}

/** Parse a canonical mesh descriptor JSON string. */
export function parseMeshDescriptor(text) {
  let o;
  try { o = JSON.parse(String(text)); } catch { throw new Error("descriptor is not valid JSON"); }
  if (!o || o.kind !== "pearl-mesh" || o.v !== 1) throw new Error("not a pearl-mesh v1 descriptor");
  if (!NETWORKS[o.network]) throw new Error(`unknown network: ${o.network}`);
  if (!Array.isArray(o.members)) throw new Error("descriptor has no members");
  return o;
}

/** Standalone verifier: recompute from the descriptor's member list and rule.
 *  Returns {verdict: "PROVEN"|"NOT PROVEN", checks:[{label, ok, detail}], address}. */
export function verifyMeshDescriptor(text, claimedAddress, claimedSealed = null) {
  const checks = [];
  const fail = (label, detail) => ({ label, ok: false, detail });
  let o;
  try { o = parseMeshDescriptor(text); }
  catch (e) { return { verdict: "NOT PROVEN", checks: [fail("descriptor parses", e.message)], address: null }; }
  checks.push({ label: "descriptor parses (pearl-mesh v1)", ok: true, detail: `${o.members.length} members, network ${o.network}` });
  let rebuilt = null, rebuildErr = null;
  try {
    rebuilt = buildMeshDescriptor(o.network, o.members);
  } catch (e) {
    rebuildErr = e.message;
  }
  checks.push({
    label: "members re-aggregate",
    ok: !rebuildErr,
    detail: rebuildErr ? rebuildErr : `${rebuilt.members.length} member keys aggregated (BIP-327)`,
  });
  if (rebuildErr) {
    checks.push({ label: "address re-derives from member keys", ok: false, detail: "no address: " + rebuildErr });
    return { verdict: "NOT PROVEN", checks, address: null, sealed: null };
  }
  const canonicalMatch = rebuilt.descriptor === JSON.stringify(oCanonicalFields(o));
  checks.push({
    label: "descriptor is canonical (sorted, exact fields)",
    ok: canonicalMatch,
    detail: canonicalMatch ? "byte-identical canonical form" : "descriptor differs from canonical — re-export it",
  });
  const addrOk = rebuilt.address === String(claimedAddress || "").trim().toLowerCase();
  checks.push({
    label: "address re-derives from member keys",
    ok: addrOk,
    detail: addrOk ? rebuilt.address : `recomputed ${rebuilt.address}`,
  });
  if (claimedSealed) {
    const sealOk = rebuilt.sealed === String(claimedSealed).trim();
    checks.push({
      label: "sealed commitment matches",
      ok: sealOk,
      detail: sealOk ? rebuilt.sealed : `recomputed ${rebuilt.sealed}`,
    });
  }
  const verdict = checks.every((c) => c.ok) ? "PROVEN" : "NOT PROVEN";
  return { verdict, checks, address: rebuilt.address, sealed: rebuilt.sealed };
}

function oCanonicalFields(o) {
  return {
    kind: o.kind, v: o.v, network: o.network, members: o.members,
    L: o.L, coefficients: o.coefficients, agg: o.agg, tweak: o.tweak,
    pacc: o.pacc, address: o.address,
  };
}

/* ---------------- nonce ceremony (BIP-327) ---------------- */

/** 32 fresh random bytes for a ceremony salt (browser/node). */
export function newSalt() {
  const b = new Uint8Array(32);
  const c = globalThis.crypto;
  if (c && c.getRandomValues) c.getRandomValues(b);
  else throw new Error("no secure randomness available");
  return b;
}

/** Deterministic nonce pair for a member:
 *    k1 = int(tagged_hash("PearlMesh/nonce1", salt||sec||Q||L||msg)) mod n
 *    k2 = int(tagged_hash("PearlMesh/nonce2", salt||sec||Q||L||msg)) mod n
 *  sec must be the even-y-normalized secret (memberFromPriv). A zero draw
 *  re-hashes with a counter byte — k is never 0.
 *  Returns {k1, k2, R1i, R2i} (scalars + x-only hex commitments). */
export function memberNoncePair({ sec, aggX, L, msg, salt }) {
  const secB = scalar(sec);
  const pre = Uint8Array.from([...salt, ...secB, ...aggX, ...L, ...msg]);
  const draw = (tag, ctr) => mod(num(taggedHash(tag, Uint8Array.from([...pre, ctr]))));
  let k1 = draw("PearlMesh/nonce1", 0), ctr = 1;
  while (k1 === 0n) k1 = draw("PearlMesh/nonce1", ctr++);
  let k2 = draw("PearlMesh/nonce2", 0); ctr = 1;
  while (k2 === 0n) k2 = draw("PearlMesh/nonce2", ctr++);
  return {
    k1, k2,
    R1i: bytesToHex(xOnly(G.multiply(k1))),
    R2i: bytesToHex(xOnly(G.multiply(k2))),
  };
}

/** A member's exportable nonce-commitment bundle (public part only). */
export function nonceCommitBundle({ memberName, pubkey, R1i, R2i, msg, salt }) {
  return JSON.stringify({
    kind: "pearl-mesh-nonce", v: 1,
    member: memberName, pubkey,
    R1: R1i, R2: R2i,
    msg: bytesToHex(msg), salt: bytesToHex(salt),
  });
}

export function parseNonceBundle(text) {
  let o;
  try { o = JSON.parse(String(text)); } catch { throw new Error("nonce bundle is not valid JSON"); }
  if (!o || o.kind !== "pearl-mesh-nonce" || o.v !== 1) throw new Error("not a pearl-mesh-nonce v1 bundle");
  const R1 = parseXOnlyKey(o.R1, "bundle R1");
  const R2 = parseXOnlyKey(o.R2, "bundle R2");
  const pubkey = bytesToHex(parseXOnlyKey(o.pubkey, "bundle member pubkey"));
  if (!/^[0-9a-f]{64}$/.test(String(o.msg || ""))) throw new Error("bundle msg must be 32 bytes hex");
  if (!/^[0-9a-f]{64}$/.test(String(o.salt || ""))) throw new Error("bundle salt must be 32 bytes hex");
  return { member: String(o.member ?? ""), pubkey, R1, R2, msg: hexToBytes(o.msg), salt: hexToBytes(o.salt) };
}

/** Coordinator: aggregate the members' nonce bundles.
 *  Every bundle must carry the SAME msg and salt, and each bundle's pubkey
 *  must occupy a slot of the mesh (by sorted index). Returns the agg-R
 *  bundle object {kind, v, R, odd, b, R1, R2, L, Q, msg} — exportable. */
export function aggregateNonces({ bundles, descriptor, msg }) {
  if (!descriptor || !descriptor.members) throw new Error("mesh descriptor required");
  const msgB = msg instanceof Uint8Array ? msg : hexToBytes(String(msg).trim());
  if (msgB.length !== 32) throw new Error("message must be a 32-byte digest");
  if (!Array.isArray(bundles) || bundles.length !== descriptor.members.length)
    throw new Error(`need ${descriptor.members.length} nonce bundles, got ${bundles ? bundles.length : 0}`);
  const slots = descriptor.members.map((m) => m.pubkey);
  const seen = new Set();
  const msgHex = bytesToHex(msgB);
  let saltHex = null;
  let R1 = null, R2 = null;
  const aggX = hexToBytes(descriptor.agg);
  const L = hexToBytes(descriptor.L);
  for (const text of bundles) {
    const b = parseNonceBundle(text);
    if (bytesToHex(b.msg) !== msgHex) throw new Error(`bundle from "${b.member}" signs a different message`);
    if (saltHex === null) saltHex = bytesToHex(b.salt);
    else if (bytesToHex(b.salt) !== saltHex) throw new Error(`bundle from "${b.member}" uses a different session salt`);
    if (!slots.includes(b.pubkey)) throw new Error(`bundle from "${b.member}" is not a mesh member`);
    if (seen.has(b.pubkey)) throw new Error(`duplicate nonce bundle for member "${b.member}"`);
    seen.add(b.pubkey);
    R1 = R1 ? R1.add(liftX(b.R1)) : liftX(b.R1);
    R2 = R2 ? R2.add(liftX(b.R2)) : liftX(b.R2);
  }
  const R1x = xOnly(R1), R2x = xOnly(R2);
  const bCoef = mod(num(taggedHash("MuSig/noncecoef", Uint8Array.from([...L, ...R1x, ...R2x, ...aggX, ...msgB]))));
  let R = R1.add(R2.multiply(bCoef));
  let odd = (R.toAffine().y & 1n) === 1n;
  if (odd) R = R.negate();
  return {
    kind: "pearl-mesh-aggnonce", v: 1,
    R: bytesToHex(xOnly(R)), odd,
    b: bytesToHex(scalar(bCoef)),
    R1: bytesToHex(R1x), R2: bytesToHex(R2x),
    L: bytesToHex(L), Q: bytesToHex(aggX),
    msg: msgHex, salt: saltHex,
    members: slots,
  };
}

export function parseAggNonceBundle(text) {
  let o;
  try { o = JSON.parse(String(text)); } catch { throw new Error("agg-nonce bundle is not valid JSON"); }
  if (!o || o.kind !== "pearl-mesh-aggnonce" || o.v !== 1) throw new Error("not a pearl-mesh-aggnonce v1 bundle");
  for (const f of ["R", "b", "R1", "R2", "L", "Q", "msg"]) parseXOnlyKey(o[f], `agg-nonce ${f}`);
  if (typeof o.odd !== "boolean") throw new Error("agg-nonce bundle missing parity flag");
  return o;
}

/** A member's partial signature. KEY REFUSED unless `priv` controls the
 *  pubkey in `slotPubkey`. `nonce` is the member's secret pair from
 *  memberNoncePair. Returns the exportable partial bundle {kind, v, member,
 *  pubkey, s} plus the raw scalar (for the coordinator's local use). */
export function memberPartialSign({ priv, slotPubkey, descriptor, aggBundle, nonce, memberName }) {
  const { d, pub } = memberFromPriv(priv);
  const slotHex = bytesToHex(parseXOnlyKey(slotPubkey, "slot pubkey"));
  if (bytesToHex(pub) !== slotHex)
    throw new Error(`KEY REFUSED: this key does not control slot ${slotHex.slice(0, 16)}…`);
  const idx = descriptor.members.findIndex((m) => m.pubkey === slotHex);
  if (idx < 0) throw new Error("slot is not a mesh member");
  const a = num(hexToBytes(descriptor.coefficients[idx]));
  const gacc = descriptor.gacc === "n-1" ? N - 1n : 1n;
  const pacc = descriptor.pacc === "n-1" ? N - 1n : 1n;
  const QtweakX = decodeBech32m(descriptor.address, NETWORKS[descriptor.network].hrp).program;
  const Rx = hexToBytes(aggBundle.R);
  const bCoef = num(hexToBytes(aggBundle.b));
  const msg = hexToBytes(aggBundle.msg);
  const e = mod(num(taggedHash("BIP0340/challenge", Uint8Array.from([...Rx, ...QtweakX, ...msg]))));
  // Nonce normalization: the coordinator sums lift_x(R1i)/lift_x(R2i)
  // (even-y lifts), so the member must use the same convention — negate
  // each secret nonce whose public point has odd y. Then negate both when
  // the aggregate nonce R was normalized to even y (parity ships in the
  // agg-R bundle, so both sides agree).
  const r1p = G.multiply(nonce.k1), r2p = G.multiply(nonce.k2);
  let k1 = (r1p.toAffine().y & 1n) === 1n ? N - nonce.k1 : nonce.k1;
  let k2 = (r2p.toAffine().y & 1n) === 1n ? N - nonce.k2 : nonce.k2;
  if (aggBundle.odd) { k1 = mod(N - k1); k2 = mod(N - k2); }
  const sk = signShare(d, a, gacc, pacc);
  const s = mod(k1 + bCoef * k2 + e * sk);
  const bundle = JSON.stringify({
    kind: "pearl-mesh-partial", v: 1,
    member: memberName || descriptor.members[idx].name,
    pubkey: slotHex, s: bytesToHex(scalar(s)),
    R: aggBundle.R, msg: aggBundle.msg,
  });
  return { bundle, s };
}

/** Verify one partial signature against its member's nonce commitment.
 *  Checks s_i*G == R1i' + b*R2i' + e*pacc*gacc*a_i*P_i (the member signs with
 *  the UNtweaked share; the coordinator adds the e*pacc*t tweak term once
 *  at aggregation). */
export function verifyPartial({ partial, nonceBundleText, descriptor, aggBundle }) {
  let p;
  try { p = JSON.parse(String(partial)); } catch { return { ok: false, reason: "partial is not valid JSON" }; }
  if (!p || p.kind !== "pearl-mesh-partial" || p.v !== 1) return { ok: false, reason: "not a pearl-mesh-partial v1 bundle" };
  let nb;
  try { nb = parseNonceBundle(nonceBundleText); }
  catch (e) { return { ok: false, reason: "bad nonce bundle: " + e.message }; }
  if (p.pubkey !== nb.pubkey) return { ok: false, reason: "partial pubkey does not match the nonce bundle" };
  if (p.R !== aggBundle.R || p.msg !== aggBundle.msg) return { ok: false, reason: "partial references a different aggregate nonce/message" };
  const idx = descriptor.members.findIndex((m) => m.pubkey === p.pubkey);
  if (idx < 0) return { ok: false, reason: "signer is not a mesh member" };
  if (!/^[0-9a-f]{64}$/.test(String(p.s || ""))) return { ok: false, reason: "partial s is not 32 bytes hex" };
  const s = num(hexToBytes(p.s));
  if (s === 0n || s >= N) return { ok: false, reason: "partial s out of range" };
  const a = num(hexToBytes(descriptor.coefficients[idx]));
  const gacc = descriptor.gacc === "n-1" ? N - 1n : 1n;
  const pacc = descriptor.pacc === "n-1" ? N - 1n : 1n;
  const QtweakX = decodeBech32m(descriptor.address, NETWORKS[descriptor.network].hrp).program;
  const Rx = hexToBytes(aggBundle.R);
  const bCoef = num(hexToBytes(aggBundle.b));
  const msg = hexToBytes(aggBundle.msg);
  const e = mod(num(taggedHash("BIP0340/challenge", Uint8Array.from([...Rx, ...QtweakX, ...msg]))));
  const flip = aggBundle.odd;
  const R1i = liftX(nb.R1), R2i = liftX(nb.R2);
  const Ri = (flip ? R1i.negate() : R1i).add((flip ? R2i.negate() : R2i).multiply(bCoef));
  const Pi = liftX(hexToBytes(p.pubkey));
  const rhs = Ri.add(Pi.multiply(pacc).multiply(gacc).multiply(a).multiply(e));
  const ok = G.multiply(s).equals(rhs);
  return { ok, reason: ok ? "partial signature valid" : "partial signature does NOT verify — do not aggregate it" };
}

/** Coordinator: collect partials, verify each against its nonce bundle,
 *  aggregate s (adding the e*pacc*t tweak term ONCE — the tweak belongs to
 *  the aggregate key, not to each share), and verify the final BIP-340
 *  signature. partials: [{partial, nonceBundle}] in ANY order. */
export function aggregatePartials({ partials, descriptor, aggBundle }) {
  if (!Array.isArray(partials) || partials.length !== descriptor.members.length)
    throw new Error(`need ${descriptor.members.length} partials`);
  let s = 0n;
  const seen = new Set();
  for (const { partial, nonceBundle } of partials) {
    const v = verifyPartial({ partial, nonceBundleText: nonceBundle, descriptor, aggBundle });
    if (!v.ok) throw new Error(`partial rejected: ${v.reason}`);
    const p = JSON.parse(partial);
    if (seen.has(p.pubkey)) throw new Error(`duplicate partial from ${p.member}`);
    seen.add(p.pubkey);
    s = mod(s + num(hexToBytes(p.s)));
  }
  const Rx = hexToBytes(aggBundle.R);
  const QtweakX = decodeBech32m(descriptor.address, NETWORKS[descriptor.network].hrp).program;
  const msg = hexToBytes(aggBundle.msg);
  const e = mod(num(taggedHash("BIP0340/challenge", Uint8Array.from([...Rx, ...QtweakX, ...msg]))));
  const t = num(hexToBytes(descriptor.tweak));
  const pacc = descriptor.pacc === "n-1" ? N - 1n : 1n;
  s = mod(s + e * pacc * t); // the TapTweak, applied once to the aggregate
  const sig = Uint8Array.from([...Rx, ...scalar(s)]);
  const ok = schnorr.verify(sig, msg, QtweakX);
  return {
    sig: bytesToHex(sig), R: aggBundle.R, s: bytesToHex(scalar(s)),
    ok,
    reason: ok ? "final BIP-340 signature verifies against the tweaked aggregate key"
      : "aggregated signature does NOT verify — do not use it",
  };
}

/* ---------------- standalone signature verifier ---------------- */

/** Verify a final mesh signature: sig (128hex) over msg (32 bytes) under an
 *  aggregate key (x-only 64hex or a full mesh descriptor/address). */
export function verifyMeshSignature({ sig, msg, aggKey }) {
  const fail = (reason) => ({ ok: false, reason });
  if (!/^[0-9a-f]{128}$/i.test(String(sig || "").trim())) return fail("signature must be 128 hex chars (R || s)");
  const sigB = hexToBytes(String(sig).trim().toLowerCase());
  let msgB;
  try {
    msgB = msg instanceof Uint8Array ? msg : hexToBytes(String(msg).trim());
  } catch { return fail("message must be 32 bytes hex"); }
  if (msgB.length !== 32) return fail("message must be a 32-byte digest");
  let keyX;
  const k = String(aggKey || "").trim();
  try {
    if (k.startsWith("{")) {
      const d = parseMeshDescriptor(k);
      keyX = decodeBech32m(d.address, NETWORKS[d.network].hrp).program;
    } else if (k.toLowerCase().startsWith("prl1") || k.toLowerCase().startsWith("tprl1")) {
      const hrp = k.toLowerCase().startsWith("tprl1") ? "tprl" : "prl";
      keyX = decodeBech32m(k, hrp).program;
    } else {
      keyX = parseXOnlyKey(k, "aggregate key");
    }
  } catch (e) { return fail("bad aggregate key: " + e.message); }
  let ok = false;
  try { ok = schnorr.verify(sigB, msgB, keyX); }
  catch (e) { return fail("verification error: " + e.message); }
  return { ok, reason: ok ? "BIP-340 signature PROVEN against the aggregate key" : "signature does NOT verify against this key/message" };
}

/* ---------------- message digests ---------------- */

/** The 32-byte digest the ceremony signs: 64-hex passthrough, or
 *  sha256(utf8(text)) for arbitrary text. */
export function digestForSigning(text) {
  const t = String(text ?? "").trim();
  if (/^[0-9a-f]{64}$/i.test(t)) return hexToBytes(t.toLowerCase());
  if (!t) throw new Error("enter a message or a 64-hex digest");
  return sha256(utf8(t));
}

/* ---------------- local simulation (demo-grade) ---------------- */

/** Run the whole ceremony in-memory for n private keys. DEMO-GRADE: it
 *  exercises the math, not the distributed trust. Never use it with keys
 *  that protect real funds on more than one machine — the point of MuSig2
 *  is that secrets never meet. */
export function runSimulation({ privs, msg, networkId, names }) {
  const members = privs.map((p, i) => {
    const { pub } = memberFromPriv(p);
    return { name: (names && names[i]) || `Member ${i + 1}`, pubkey: bytesToHex(pub) };
  });
  const descriptor = buildMeshDescriptor(networkId, members);
  const msgB = msg instanceof Uint8Array ? msg : hexToBytes(String(msg).trim());
  if (msgB.length !== 32) throw new Error("message must be a 32-byte digest");
  const salt = newSalt();
  const aggX = hexToBytes(descriptor.agg);
  const L = hexToBytes(descriptor.L);
  // each member commits nonces
  const commits = privs.map((p, i) => {
    const { d, pub } = memberFromPriv(p);
    const nonce = memberNoncePair({ sec: d, aggX, L, msg: msgB, salt });
    return {
      i, d, pub: bytesToHex(pub),
      name: members[i].name, nonce,
      nonceText: nonceCommitBundle({
        memberName: members[i].name, pubkey: bytesToHex(pub),
        R1i: nonce.R1i, R2i: nonce.R2i, msg: msgB, salt,
      }),
    };
  });
  const aggBundle = aggregateNonces({ bundles: commits.map((c) => c.nonceText), descriptor, msg: msgB });
  const partials = commits.map((c) => {
    const { bundle } = memberPartialSign({
      priv: scalar(c.d), slotPubkey: c.pub, descriptor, aggBundle,
      nonce: c.nonce, memberName: c.name,
    });
    return { partial: bundle, nonceBundle: c.nonceText };
  });
  const fin = aggregatePartials({ partials, descriptor, aggBundle });
  return { descriptor, aggBundle, partials, ...fin, msg: bytesToHex(msgB) };
}
