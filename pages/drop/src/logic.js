/* Pearl Drop core — PRL-20 airdrop campaign desk logic.
 *
 * Pure ESM, zero build step for node tests. The browser ships a committed
 * esbuild IIFE bundle (pearl-drop.bundle.js) built from src/index.js.
 *
 * CRYPTO LINEAGE (no new cryptography):
 *  - SHA-256: byte-identical copy of `snipSha256Bytes` from
 *    files/pages/paywall/src/snippet-crypto.js, which is itself a mechanical
 *    minimization of the audited Sign-core lineage (@noble/hashes/sha256 used
 *    by files/pages/sign/src/crypto.js). The Paywall test suite differentially
 *    checks that implementation against the audited noble implementation on
 *    randomized inputs plus pinned vectors; this desk pins the known vectors
 *    again in tests/logic.test.mjs (sha256("abc") = ba7816bf…).
 *  - bech32m encode/decode: copied verbatim from files/pages/sign/src/crypto.js
 *    (audited, from pearlpurse). BIP-350 bech32m, HRP enforcement, v1-only,
 *    32-byte-program-only, canonical re-encode — all preserved.
 *
 * Protocol facts (verified, not from memory):
 *  - prl1… bech32m Taproot-only addresses; 1 PRL = 1e8 grains (smallest unit).
 *  - NO smart contracts on Pearl; distribution is a manual PRL-20 transfer.
 *    This desk never holds funds — allocations are pledged amounts only.
 */

/* ================= vendored SHA-256 (verbatim copy) ================= */

/** SHA-256 over a plain byte array. Returns a 32-byte plain array. */
function snipSha256Bytes(data) {
  var K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  function rotr(x, n) { return ((x >>> n) | (x << (32 - n))) | 0; }
  var bytes = data.slice();
  var bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  var hi = Math.floor(bitLen / 4294967296), lo = bitLen >>> 0;
  bytes.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255,
             (lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);
  var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  for (var off = 0; off < bytes.length; off += 64) {
    var w = new Array(64), i;
    for (i = 0; i < 16; i++) {
      w[i] = ((bytes[off + i * 4] << 24) | (bytes[off + i * 4 + 1] << 16) |
              (bytes[off + i * 4 + 2] << 8) | bytes[off + i * 4 + 3]) | 0;
    }
    for (i = 16; i < 64; i++) {
      var s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      var s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], hh = H[7];
    for (i = 0; i < 64; i++) {
      var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      var ch = (e & f) ^ (~e & g);
      var t1 = (hh + S1 + ch + K[i] + w[i]) | 0;
      var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      var maj = (a & b) ^ (a & c) ^ (b & c);
      var t2 = (S0 + maj) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + hh) | 0;
  }
  var out = [];
  for (i = 0; i < 8; i++) {
    out.push((H[i] >>> 24) & 255, (H[i] >>> 16) & 255, (H[i] >>> 8) & 255, H[i] & 255);
  }
  return out;
}

/** SHA-256 over a Uint8Array. Returns a 32-byte Uint8Array. */
export function sha256(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new Error("sha256 input must be a Uint8Array");
  return Uint8Array.from(snipSha256Bytes(Array.from(bytes)));
}

/** UTF-8 encode. */
export function utf8ToBytes(s) {
  return new TextEncoder().encode(s);
}

export function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(hex) {
  if (typeof hex !== "string" || !/^(?:[0-9a-fA-F]{2})+$/.test(hex))
    throw new Error("bad hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/* ================= vendored bech32m (verbatim from sign/src/crypto.js) ================= */

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32M_CONST = 0x2bc830a3;

function polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >>> i) & 1) chk ^= GEN[i];
  }
  return chk;
}
function hrpExpand(hrp) {
  const a = [];
  for (const c of hrp) a.push(c.charCodeAt(0) >>> 5);
  a.push(0);
  for (const c of hrp) a.push(c.charCodeAt(0) & 31);
  return a;
}
function checksum(hrp, data) {
  const values = hrpExpand(hrp).concat(data, [0, 0, 0, 0, 0, 0]);
  const mod = polymod(values) ^ BECH32M_CONST;
  const out = [];
  for (let i = 0; i < 6; i++) out.push((mod >>> (5 * (5 - i))) & 31);
  return out;
}
export function convertBits(data, fromBits, toBits, pad, strictPadding = false) {
  let acc = 0, bits = 0;
  const ret = [];
  const maxv = (1 << toBits) - 1;
  for (const value of data) {
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      ret.push((acc >>> bits) & maxv);
    }
  }
  if (pad && bits) ret.push((acc << (toBits - bits)) & maxv);
  if (!pad && bits) {
    if (strictPadding && (acc & ((1 << bits) - 1)) !== 0) throw new Error("invalid padding");
  }
  return ret;
}
export function encodeBech32m(hrp, version, program) {
  if (!(program instanceof Uint8Array) || program.length !== 32) throw new Error("program must be 32 bytes");
  if (version !== 1) throw new Error("only witness v1 (taproot) supported");
  const data5 = [version, ...convertBits([...program], 8, 5, true)];
  return hrp + "1" + data5.concat(checksum(hrp, data5)).map((v) => CHARSET[v]).join("");
}
export function decodeBech32m(addr, expectHrp = null) {
  if (typeof addr !== "string") throw new Error("address must be string");
  const raw = addr.trim();
  if (raw !== raw.toLowerCase() && raw !== raw.toUpperCase()) throw new Error("mixed case");
  addr = raw.toLowerCase();
  if (addr.length > 90) throw new Error("too long");
  const pos = addr.lastIndexOf("1");
  if (pos < 1 || addr.length - pos - 1 < 7) throw new Error("missing separator");
  const hrp = addr.slice(0, pos);
  if (!/^[a-z0-9]+$/.test(hrp)) throw new Error("bad hrp");
  if (expectHrp && hrp !== expectHrp) throw new Error(`wrong network: expected ${expectHrp}, got ${hrp}`);
  const data5 = [];
  for (const c of addr.slice(pos + 1)) {
    const v = CHARSET.indexOf(c);
    if (v === -1) throw new Error("invalid char");
    data5.push(v);
  }
  if (polymod(hrpExpand(hrp).concat(data5)) !== BECH32M_CONST) throw new Error("bad checksum");
  const payload = data5.slice(0, -6);
  if (payload[0] !== 1) throw new Error("only witness v1 (taproot) supported");
  const data8 = convertBits(payload.slice(1), 5, 8, false, true);
  if (data8.length !== 32) throw new Error("program must be 32 bytes (v1 taproot)");
  return { hrp, version: payload[0], program: Uint8Array.from(data8) };
}

/* ================= PRL / grains ================= */

export const GRAIN_PER_PRL = 100_000_000n;

/** Strict PRL decimal string → grains (BigInt). Rejects >8 decimals,
 *  negatives, empty, and non-numeric input. */
export function prlToGrains(raw) {
  if (typeof raw !== "string") throw new Error("amount must be a string");
  const s = raw.trim();
  const m = /^(\d+)(?:\.(\d{1,8}))?$/.exec(s);
  if (!m) throw new Error(`bad amount "${s}": use up to 8 decimals, no sign, no spaces`);
  const whole = BigInt(m[1]);
  const frac = (m[2] || "").padEnd(8, "0");
  return whole * GRAIN_PER_PRL + BigInt(frac);
}

/** Grains (BigInt) → canonical PRL decimal string (up to 8 decimals, trimmed). */
export function grainsToPrl(g) {
  if (typeof g !== "bigint" || g < 0n) throw new Error("grains must be a non-negative BigInt");
  const whole = g / GRAIN_PER_PRL;
  const frac = (g % GRAIN_PER_PRL).toString().padStart(8, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/* ================= address validation ================= */

/** Validate a Pearl mainnet drop address: bech32m, HRP prl, witness v1,
 *  32-byte program, canonical re-encode equality (BIP-350 rules).
 *  Returns the canonical lowercase address. Throws otherwise. */
export function validateDropAddress(addr) {
  const d = decodeBech32m(addr, "prl");
  if (d.version !== 1 || d.program.length !== 32)
    throw new Error("address is not a v1 taproot address");
  const canonical = encodeBech32m(d.hrp, 1, d.program);
  if (canonical !== String(addr).trim().toLowerCase())
    throw new Error("address is not in canonical form");
  return canonical;
}

/* ================= campaign ================= */

export const DROP_STATUSES = ["draft", "open", "closed", "sealed"];
export const TICK_RE = /^[A-Z0-9]{1,8}$/;

/** Compose the canonical campaign header (fixed field order — never change).
 *  Throws on any rule violation. */
export function composeCampaign({ name, tick, startsAt, endsAt, contact }) {
  if (typeof name !== "string" || !(name = name.trim()) || name.length > 80)
    throw new Error("campaign name must be 1–80 characters");
  if (!TICK_RE.test(String(tick || "").trim()))
    throw new Error("token tick must be 1–8 uppercase alphanumeric characters");
  const t = String(tick).trim();
  const ts = Date.parse(startsAt);
  const te = Date.parse(endsAt);
  if (!Number.isFinite(ts)) throw new Error("claim window start is not a valid date");
  if (!Number.isFinite(te)) throw new Error("claim window end is not a valid date");
  if (te <= ts) throw new Error("claim window end must be after start");
  const c = contact == null ? "" : String(contact);
  if (c.length > 200) throw new Error("operator contact must be ≤200 characters");
  const fields = {
    v: 1,
    name,
    tick: t,
    starts_at: new Date(ts).toISOString(),
    ends_at: new Date(te).toISOString(),
    contact: c.trim(),
  };
  const json = JSON.stringify(fields);
  return { json, fields };
}

/** SHA-256 campaign id (hex) over the canonical header bytes. */
export const campaignId = (headerJson) => bytesToHex(sha256(utf8ToBytes(headerJson)));

/** Lifecycle transitions. Throws on illegal moves. */
export function transitionStatus(current, action) {
  const moves = {
    open: { draft: "open" },
    close: { open: "closed" },
    reopen: { closed: "open" },
    seal: { closed: "sealed" },
  };
  const next = (moves[action] || {})[current];
  if (!next) throw new Error(`cannot ${action} a campaign in status "${current}"`);
  return next;
}

/* ================= recipient CSV ================= */

/**
 * Parse a pasted recipient CSV. Tolerant: blank lines skipped, `#` comments
 * skipped, an optional header row (first non-skipped line containing the word
 * "address") skipped, comma-separated `address,amount` pairs (extra columns
 * ignored), whitespace trimmed.
 * Amounts are parsed strict PRL → grains. Valid rows carry the canonical
 * address. Returns { rows, invalid }.
 */
export function parseDropCsv(text) {
  const rows = [];
  const invalid = [];
  const lines = String(text || "").split(/\r?\n/);
  let seenHeader = false;
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const raw = lines[i].trim();
    if (!raw || raw.startsWith("#")) continue;
    if (!seenHeader) {
      seenHeader = true;
      if (/address/i.test(raw)) continue; // header row
    }
    const cells = raw.split(",").map((c) => c.trim());
    if (cells.length < 2 || !cells[0] || !cells[1]) {
      invalid.push({ line: lineNo, raw, reason: "expected address,amount" });
      continue;
    }
    const [addrRaw, amtRaw] = cells;
    let address;
    try {
      address = validateDropAddress(addrRaw);
    } catch (e) {
      invalid.push({ line: lineNo, raw, reason: `bad address: ${e.message}` });
      continue;
    }
    let amountGrains;
    try {
      amountGrains = prlToGrains(amtRaw);
    } catch (e) {
      invalid.push({ line: lineNo, raw, reason: `bad amount: ${e.message}` });
      continue;
    }
    if (amountGrains <= 0n) {
      invalid.push({ line: lineNo, raw, reason: "amount must be > 0" });
      continue;
    }
    rows.push({ line: lineNo, address, amountGrains });
  }
  return { rows, invalid };
}

/** Dedupe by canonical address: first-seen wins, later repeats reported. */
export function dedupeRecipients(rows) {
  const seen = new Map();
  const recipients = [];
  const duplicates = [];
  for (const row of rows) {
    if (seen.has(row.address)) {
      duplicates.push({ line: row.line, address: row.address, reason: "duplicate address (first-seen kept)" });
      continue;
    }
    seen.set(row.address, recipients.length);
    recipients.push({ index: recipients.length, address: row.address, amountGrains: row.amountGrains });
  }
  return { recipients, duplicates };
}

/* ================= merkle tree ================= */

/** leaf = SHA-256 over canonical bytes `drop-v1:<index>:<address>:<amountGrains>`. */
export function dropLeafHash(index, address, amountGrains) {
  if (!Number.isInteger(index) || index < 0) throw new Error("leaf index must be a non-negative integer");
  if (typeof amountGrains !== "bigint" || amountGrains < 0n) throw new Error("leaf amount must be a non-negative BigInt");
  return sha256(utf8ToBytes(`drop-v1:${index}:${address}:${amountGrains.toString()}`));
}

function cmpBytes(a, b) {
  for (let i = 0; i < 32; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/** Sorted-pair hashing up the tree: hash(sorted(a,b)) at each level;
 *  duplicate the last leaf when a level is odd. */
export function buildDropTree(leaves) {
  if (!Array.isArray(leaves) || leaves.length === 0) throw new Error("need at least one leaf");
  for (const l of leaves) {
    if (!(l instanceof Uint8Array) || l.length !== 32) throw new Error("each leaf must be 32 bytes");
  }
  const layers = [leaves.map((l) => Uint8Array.from(l))];
  let cur = layers[0];
  let depth = 0;
  while (cur.length > 1) {
    const next = [];
    for (let i = 0; i < cur.length; i += 2) {
      const a = cur[i];
      const b = i + 1 < cur.length ? cur[i + 1] : cur[i]; // duplicate last if odd
      const lo = cmpBytes(a, b) <= 0 ? a : b;
      const hi = cmpBytes(a, b) <= 0 ? b : a;
      const both = new Uint8Array(64);
      both.set(lo, 0);
      both.set(hi, 32);
      next.push(sha256(both));
    }
    layers.push(next);
    cur = next;
    depth++;
  }
  return {
    root: layers[layers.length - 1][0],
    rootHex: bytesToHex(layers[layers.length - 1][0]),
    depth,
    leafCount: leaves.length,
    layers,
  };
}

/** Merkle proof for leaf `index`: array of { siblingHex, siblingOnLeft }. */
export function dropProof(tree, index) {
  if (!tree || !Array.isArray(tree.layers)) throw new Error("bad tree");
  if (!Number.isInteger(index) || index < 0 || index >= tree.layers[0].length)
    throw new Error("leaf index out of range");
  const proof = [];
  let idx = index;
  for (let level = 0; level < tree.layers.length - 1; level++) {
    const layer = tree.layers[level];
    const isRight = idx % 2 === 1;
    let sibIdx = isRight ? idx - 1 : idx + 1;
    if (sibIdx >= layer.length) sibIdx = layer.length - 1; // duplicated last leaf
    proof.push({
      siblingHex: bytesToHex(layer[sibIdx]),
      siblingOnLeft: isRight,
    });
    idx = Math.floor(idx / 2);
  }
  return proof;
}

/** Verify a proof against a root hex. */
export function verifyDropProof(leafHex, proof, rootHex) {
  try {
    let cur = hexToBytes(leafHex);
    for (const step of proof) {
      if (typeof step.siblingHex !== "string") return false;
      const sib = hexToBytes(step.siblingHex);
      const lo = cmpBytes(cur, sib) <= 0 ? cur : sib;
      const hi = cmpBytes(cur, sib) <= 0 ? sib : cur;
      const both = new Uint8Array(64);
      both.set(lo, 0);
      both.set(hi, 32);
      cur = sha256(both);
    }
    return bytesToHex(cur) === String(rootHex).toLowerCase();
  } catch {
    return false;
  }
}

/* ================= seal document ================= */

/** Compose the seal document. Canonical field order is fixed and never changes:
 *  v, campaign_id, tick, merkle_root, leaf_count, total_grains, sealed_at,
 *  campaign (the full canonical campaign header JSON, so a verifier can
 *  re-derive campaign_id without trusting it). */
export function composeSeal({ campaignJson, tick, rootHex, leafCount, totalGrains, sealedAtIso }) {
  if (typeof campaignJson !== "string" || !campaignJson) throw new Error("campaign header is required");
  const id = campaignId(campaignJson);
  const header = JSON.parse(campaignJson);
  if (header.tick !== tick) throw new Error("tick does not match the campaign header");
  if (!/^[0-9a-f]{64}$/.test(rootHex)) throw new Error("merkle root must be 64 hex chars");
  if (!Number.isInteger(leafCount) || leafCount <= 0) throw new Error("leaf count must be positive");
  if (typeof totalGrains !== "bigint" || totalGrains <= 0n) throw new Error("total grains must be positive");
  const sealedAt = sealedAtIso || new Date().toISOString();
  const fields = {
    v: 1,
    campaign_id: id,
    tick,
    merkle_root: rootHex.toLowerCase(),
    leaf_count: leafCount,
    total_grains: totalGrains.toString(),
    sealed_at: sealedAt,
    campaign: campaignJson,
  };
  const json = JSON.stringify(fields);
  return { json, fields, sealId: bytesToHex(sha256(utf8ToBytes(json))) };
}

/** The `prl-drop` inscription envelope body, ready to inscribe via Pearl Etch.
 *  Preparing this payload is the desk's job; commit/reveal is Etch's. */
export function dropEnvelopeBody(sealJson) {
  return {
    p: "prl-drop",
    op: "seal",
    body: sealJson,
  };
}

/** Standalone verifier: re-derives EVERYTHING from a pasted seal document +
 *  recipient CSV. Never throws — it rules PROVEN / NOT PROVEN via checks. */
export function verifySealPackage(sealJsonText, csvText) {
  const checks = [];
  const fail = (label, detail) => {
    checks.push({ label, detail, ok: false });
    return { ok: false, checks };
  };
  const pass = (label, detail) => checks.push({ label, detail, ok: true });
  let seal;
  try {
    seal = JSON.parse(String(sealJsonText || ""));
  } catch (e) {
    return fail("seal document parses", e.message);
  }
  pass("seal document parses", "valid JSON");
  if (!seal || typeof seal !== "object") return fail("seal shape", "seal must be an object");
  for (const f of ["v", "campaign_id", "tick", "merkle_root", "leaf_count", "total_grains", "sealed_at", "campaign"]) {
    if (seal[f] === undefined) return fail("seal shape", `missing field "${f}"`);
  }
  if (seal.v !== 1) return fail("seal version", "v must be 1");
  pass("seal shape", "all required fields present, v=1");
  // Re-derive campaign id from the embedded canonical header.
  let header;
  try {
    header = JSON.parse(seal.campaign);
  } catch {
    return fail("campaign header", "embedded campaign header is not valid JSON");
  }
  const reId = campaignId(seal.campaign);
  if (reId !== seal.campaign_id) return fail("campaign id", `re-derived ${reId} ≠ sealed ${seal.campaign_id}`);
  pass("campaign id", "SHA-256 over embedded header matches");
  if (header.tick !== seal.tick) return fail("tick", "header tick ≠ sealed tick");
  pass("tick", `${seal.tick} matches the header`);
  // Rebuild the tree from the recipient list.
  const { rows, invalid } = parseDropCsv(csvText);
  const { recipients, duplicates } = dedupeRecipients(rows);
  if (recipients.length === 0) return fail("recipient list", "no valid recipient rows after parsing");
  pass("recipient list", `${recipients.length} unique recipients (${invalid.length} invalid rows, ${duplicates.length} duplicates skipped)`);
  const leaves = recipients.map((r) => dropLeafHash(r.index, r.address, r.amountGrains));
  const tree = buildDropTree(leaves);
  if (tree.rootHex !== seal.merkle_root) return fail("merkle root", `rebuilt ${tree.rootHex} ≠ sealed ${seal.merkle_root}`);
  pass("merkle root", `rebuild matches (${tree.leafCount} leaves, depth ${tree.depth})`);
  if (tree.leafCount !== seal.leaf_count) return fail("leaf count", `${tree.leafCount} ≠ ${seal.leaf_count}`);
  pass("leaf count", `${seal.leaf_count}`);
  const total = recipients.reduce((a, r) => a + r.amountGrains, 0n);
  if (total.toString() !== String(seal.total_grains)) return fail("total grains", `${total} ≠ ${seal.total_grains}`);
  pass("total grains", `${total} grains = ${grainsToPrl(total)} PRL`);
  return { ok: true, checks, seal, recipients, tree };
}

/* ================= claim lookup ================= */

/** Look up one address in a sealed campaign (seal doc + recipient CSV):
 *  allocation + proof + recomputation to the root. Never throws. */
export function claimForAddress(sealJsonText, csvText, addressRaw) {
  const checks = [];
  const fail = (label, detail) => {
    checks.push({ label, detail, ok: false });
    return { ok: false, valid: false, checks };
  };
  let canonical;
  try {
    canonical = validateDropAddress(addressRaw);
  } catch (e) {
    return fail("address valid", e.message);
  }
  checks.push({ label: "address valid", detail: "bech32m v1 taproot, canonical", ok: true });
  const v = verifySealPackage(sealJsonText, csvText);
  for (const c of v.checks) checks.push(c);
  if (!v.ok) return { ok: false, valid: false, checks };
  const rec = v.recipients.find((r) => r.address === canonical);
  if (!rec) {
    checks.push({ label: "allocation found", detail: "address is not in this campaign", ok: false });
    return { ok: false, valid: false, checks };
  }
  const leafHex = bytesToHex(dropLeafHash(rec.index, rec.address, rec.amountGrains));
  const proof = dropProof(v.tree, rec.index);
  const recomputed = verifyDropProof(leafHex, proof, v.seal.merkle_root);
  checks.push({
    label: "proof recomputes to root",
    detail: recomputed ? `${proof.length} proof steps verify against the sealed root` : "PROOF FAILED — does not recompute to the sealed root",
    ok: recomputed,
  });
  if (!recomputed) return { ok: false, valid: false, checks };
  return {
    ok: true,
    valid: true,
    checks,
    address: canonical,
    index: rec.index,
    amountGrains: rec.amountGrains,
    amountPrl: grainsToPrl(rec.amountGrains),
    leafHex,
    proof,
    rootHex: v.seal.merkle_root,
    tick: v.seal.tick,
  };
}

/** 64-bit fingerprint of a hex id, grouped for reading. */
export const fingerprint = (idHex) =>
  `${idHex.slice(0, 4)}-${idHex.slice(4, 8)}-${idHex.slice(8, 12)}-${idHex.slice(12, 16)}`;
