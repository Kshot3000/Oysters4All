/**
 * templates.js — block template providers for the pool.
 *
 * A template is the 76-byte IncompleteBlockHeader the pool hands to miners:
 *   version u32 LE | prev_block 32 (display/BE order) | merkle_root 32 (display/BE order)
 *   | timestamp u32 LE | nbits u32 LE
 * (Byte order verified against zk-pow's IncompleteBlockHeader::from_bytes, which
 * stores prev_block/merkle_root reversed — i.e. display order — in the wire form.)
 *
 * Two providers:
 *  - SyntheticProvider: fake-but-well-formed headers for testing and dashboard
 *    demos. ALWAYS labeled demo; never real blocks.
 *  - PearldProvider: polls a local pearld getblocktemplate (with the "coinbasetxn"
 *    capability so the node builds the coinbase paying --miningaddr, i.e. the pool
 *    wallet) and derives the header + merkle root from it.
 */
import { createHash } from "node:crypto";
import { compactToTarget, nowSec, randHex } from "./util.js";

export const HEADER_BYTES = 76;

/** Block subsidy in grains at height h (CalcBlockSubsidy, verified 2026-09-26). */
export function blockSubsidyGrains(height) {
  const E = 650226n;
  const h = BigInt(height);
  const total = 2100000000n * 100000000n; // 2.1e9 PRL in grains
  return (total * E) / ((h + E) * (h - 1n + E));
}

function sha256d(buf) {
  return createHash("sha256").update(createHash("sha256").update(buf).digest()).digest();
}

/**
 * Bitcoin-style merkle root over txids given in DISPLAY order (hex, BE).
 * Returns the root in DISPLAY order hex (what goes into the header bytes as-is).
 */
export function merkleRootDisplay(txidsDisplay) {
  if (txidsDisplay.length === 0) throw new Error("merkleRootDisplay: no transactions");
  let level = txidsDisplay.map((h) => Buffer.from(h, "hex").reverse()); // display -> internal
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : left;
      next.push(sha256d(Buffer.concat([left, right])));
    }
    level = next;
  }
  return level[0].reverse().toString("hex"); // internal -> display
}

/** Assemble the 76-byte header. prevHex/merkleHex are display-order (BE) hex. */
export function buildHeaderBytes({ version, prevHex, merkleHex, timestamp, nbits }) {
  const out = Buffer.alloc(HEADER_BYTES);
  out.writeUInt32LE(version >>> 0, 0);
  Buffer.from(prevHex, "hex").copy(out, 4);
  Buffer.from(merkleHex, "hex").copy(out, 36);
  out.writeUInt32LE(timestamp >>> 0, 68);
  out.writeUInt32LE(nbits >>> 0, 72);
  return out;
}

function headerToTemplate({ height, headerBuf, certVersion, coinbaseValueGrains, templateId, source }) {
  const nbits = headerBuf.readUInt32LE(72);
  return {
    height,
    headerHex: headerBuf.toString("hex"),
    certVersion,
    networkTarget: compactToTarget(nbits),
    nbits,
    coinbaseValueGrains,
    templateId,
    source,
  };
}

/* ---------------- synthetic provider (testing/demo only) ---------------- */

export class SyntheticProvider {
  /**
   * @param {object} opts
   * @param {number} [opts.networkDiff] network difficulty for block detection
   * @param {number} [opts.startHeight]
   * @param {number} [opts.certVersion]
   */
  constructor(opts = {}) {
    this.networkDiff = opts.networkDiff || 65536;
    this.height = opts.startHeight || 120000;
    this.certVersion = opts.certVersion ?? 3;
    this.prevHex = randHex(32);
    this.source = "synthetic-demo";
  }

  async getTemplate() {
    const nbits = targetToNbitsApprox(this.networkDiff);
    const header = buildHeaderBytes({
      version: 0x20000000,
      prevHex: this.prevHex,
      merkleHex: randHex(32),
      timestamp: nowSec(),
      nbits,
    });
    return headerToTemplate({
      height: this.height,
      headerBuf: header,
      certVersion: this.certVersion,
      coinbaseValueGrains: blockSubsidyGrains(this.height),
      templateId: `${this.height}:${this.prevHex.slice(0, 16)}`,
      source: this.source,
    });
  }

  /** Advance the chain (called when the pool "finds" a block in demo mode). */
  notifyBlockFound(headerHex) {
    // prev of the next template = hash of the found header (double-sha256, display order).
    const h = Buffer.from(headerHex, "hex");
    this.prevHex = sha256d(h).reverse().toString("hex");
    this.height += 1;
  }
}

function targetToNbitsApprox(diff) {
  // nbits whose target is closest to the pdiff target for diff (share nbits path
  // uses the same helper; fine for synthetic/demo use).
  const target = (0xffffn << 208n) / BigInt(Math.max(1, Math.floor(diff)));
  let size = 0;
  let tmp = target;
  while (tmp > 0n) { size++; tmp >>= 8n; }
  let word;
  if (size <= 3) word = Number(target << BigInt(8 * (3 - size)));
  else word = Number(target >> BigInt(8 * (size - 3)));
  if (word & 0x00800000) { word >>= 8; size++; }
  return ((size << 24) | (word & 0x007fffff)) >>> 0;
}

/* ---------------- pearld provider (live node) ---------------- */

export class PearldProvider {
  /**
   * @param {object} opts
   * @param {string} [opts.url] e.g. http://127.0.0.1:44107
   * @param {string} [opts.user]
   * @param {string} [opts.pass]
   * @param {number} [opts.pollSec]
   */
  constructor(opts = {}) {
    this.url = opts.url || "http://127.0.0.1:44107";
    this.user = opts.user || "";
    this.pass = opts.pass || "";
    this.pollSec = opts.pollSec || 20;
    this.source = "pearld";
    this._lastTemplateId = null;
    this._cached = null;
    this._lastPoll = 0;
  }

  async _rpc(method, params = []) {
    const body = JSON.stringify({ jsonrpc: "1.0", id: "pool", method, params });
    const headers = { "Content-Type": "application/json" };
    if (this.user) headers.Authorization = "Basic " + Buffer.from(`${this.user}:${this.pass}`).toString("base64");
    const res = await fetch(this.url, { method: "POST", headers, body, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`pearld HTTP ${res.status}`);
    // Cap the response body: a getblocktemplate reply is bounded by the
    // block it describes, and every other RPC client in this fleet caps
    // its body (wPRL 16 MiB, Hermes prl-cli 16 MiB, faucet 1 MiB) — an
    // unbounded res.json() let a spewing or compromised endpoint grow
    // pool memory without limit within the 15 s timeout window.
    const MAX_RPC_BODY_BYTES = 16 * 1024 * 1024;
    const chunks = [];
    let total = 0;
    for await (const chunk of res.body) {
      total += chunk.byteLength;
      if (total > MAX_RPC_BODY_BYTES) {
        throw new Error(`pearld ${method}: response exceeded the 16 MiB limit — refusing to buffer`);
      }
      chunks.push(chunk);
    }
    const j = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (j.error) throw new Error(`pearld ${method}: ${j.error.message || JSON.stringify(j.error)}`);
    return j.result;
  }

  /**
   * Fetch (and cache briefly) the current template. Requests the "coinbasetxn"
   * capability so the node builds the coinbase paying --miningaddr (the pool
   * wallet) — the pool never constructs the coinbase itself.
   */
  async getTemplate(force = false) {
    const now = Date.now();
    if (!force && this._cached && now - this._lastPoll < this.pollSec * 1000) return this._cached;
    const t = await this._rpc("getblocktemplate", [{ capabilities: ["coinbasetxn"] }]);
    // Validate the template's shape at this boundary. Every field below
    // feeds a conversion that throws a cryptic engine error — or worse,
    // silently corrupts — on a wrong shape: a non-hex txid was folded
    // into the merkle root as an empty buffer, a missing `bits` became
    // nbits 0, a float/string fee died in BigInt(), and a crafted height
    // (-650226, or "abc") died as a division-by-zero / NaN RangeError
    // inside blockSubsidyGrains. A bad template must fail HERE with a
    // named error the pool's poll loop can log and retry past.
    const bad = (what) => { throw new Error(`getblocktemplate: ${what}`); };
    if (!t || typeof t !== "object" || Array.isArray(t)) bad("result is not an object");
    const intField = (v, name, min) => {
      const n = typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : v;
      if (!Number.isSafeInteger(n) || n < min) bad(`${name} is not a safe integer >= ${min}`);
      return n;
    };
    const hex64 = (v, name) => {
      if (typeof v !== "string" || !/^[0-9a-fA-F]{64}$/.test(v)) bad(`${name} is not a 64-char hex string`);
      return v;
    };
    const height = intField(t.height, "height", 1);
    const version = intField(t.version, "version", 0);
    const curtime = intField(t.curtime, "curtime", 0);
    const certVersion = intField(t.requiredcertversion, "requiredcertversion", 0);
    if (typeof t.bits !== "string" || !/^[0-9a-fA-F]{1,8}$/.test(t.bits)) bad("bits is not a hex string");
    const prevHex = hex64(t.previousblockhash, "previousblockhash");
    if (t.transactions !== undefined && !Array.isArray(t.transactions)) bad("transactions is not an array");
    const txs = t.transactions || [];
    const txids = [];
    if (t.coinbasetxn !== undefined) {
      if (!t.coinbasetxn || typeof t.coinbasetxn !== "object") bad("coinbasetxn is not an object");
      txids.push(hex64(t.coinbasetxn.hash, "coinbasetxn.hash"));
    }
    for (const tx of txs) {
      if (!tx || typeof tx !== "object") bad("transaction entry is not an object");
      txids.push(hex64(tx.hash ?? tx.txid, "transaction hash"));
    }
    if (txids.length === 0) throw new Error("getblocktemplate returned no transactions");
    const merkleHex = merkleRootDisplay(txids);
    const nbits = parseInt(t.bits, 16) >>> 0;
    const header = buildHeaderBytes({
      version: version >>> 0,
      prevHex,
      merkleHex,
      timestamp: curtime,
      nbits,
    });
    // coinbasevalue isn't returned in coinbasetxn mode; derive from subsidy + fees.
    let fees = 0n;
    for (const tx of txs) {
      if (tx.fee === undefined || tx.fee === null) continue;
      if (Number.isSafeInteger(tx.fee) && tx.fee >= 0) fees += BigInt(tx.fee);
      else if (typeof tx.fee === "string" && /^\d+$/.test(tx.fee)) fees += BigInt(tx.fee);
      else bad("transaction fee is not a non-negative integer");
    }
    const coinbaseValueGrains = blockSubsidyGrains(height) + fees;
    const tpl = headerToTemplate({
      height,
      headerBuf: header,
      certVersion,
      coinbaseValueGrains,
      templateId: `${height}:${prevHex}`,
      source: this.source,
    });
    tpl.raw = t; // keep for block assembly / debugging
    this._cached = tpl;
    this._lastPoll = now;
    this._lastTemplateId = tpl.templateId;
    return tpl;
  }

  notifyBlockFound() {
    // Force a refresh on the next poll so miners move to the new tip fast.
    this._lastPoll = 0;
  }
}
