/* Pearl Sign — air-gapped Taproot transaction forge.
 *
 * Pure ESM, zero build step for developers. Runs in the browser (bundled as
 * window.PearlSign via build.mjs) and in node (verification suite).
 *
 * Builds on the audited crypto lineage from pages/market/src/crypto.js
 * (pearlpurse ISC wallet core, verified byte-for-byte against Pearl's Go
 * reference node/txscript): bech32m, BIP-86 derivation, TapTweak, BIP-341
 * keypath sighash (SIGHASH_DEFAULT and SIGHASH_SINGLE|SIGHASH_ANYONECANPAY).
 *
 * This module adds: a full raw-tx decoder, local signature verification
 * (every signed input is re-verified against its tweaked output key before
 * broadcast), coin selection with exact vBytes fee math, and honest
 * pearld/blockbook RPC helpers.
 */

import {
  NETWORKS, GRAIN_PER_PRL, DUST_GRAIN,
  encodeBech32m, decodeBech32m, bytesToHex, hexToBytes,
  sha256, taggedHash, varint, u32le, u64le, txidLE,
  schnorr, tweakKeypath, tweakPrivKeypath, p2trScriptPubKey,
  keypathSigDigestEx, keypathTxVBytes,
  newMnemonic, walletFromMnemonic, walletFromPriv,
} from "./crypto.js";

export const SIGHASH_DEFAULT = 0x00;
export const SIGHASH_SINGLE_ANYONECANPAY = 0x83;

/* ---------------- formatting ---------------- */

export function fmtPRL(grains) {
  const g = BigInt(grains);
  const neg = g < 0n;
  const a = neg ? -g : g;
  const whole = a / BigInt(GRAIN_PER_PRL);
  const frac = (a % BigInt(GRAIN_PER_PRL)).toString().padStart(8, "0").replace(/0+$/, "");
  return (neg ? "-" : "") + whole.toString() + (frac ? "." + frac : "");
}

/** Parse a PRL amount string into grains (BigInt). Throws on bad input. */
export function parsePRL(s) {
  if (typeof s !== "string") throw new Error("amount must be a string");
  const m = s.trim().match(/^(\d+)(?:\.(\d{1,8}))?$/);
  if (!m) throw new Error(`invalid PRL amount: ${s}`);
  const whole = BigInt(m[1]) * BigInt(GRAIN_PER_PRL);
  const frac = m[2] ? BigInt(m[2].padEnd(8, "0")) : 0n;
  return whole + frac;
}

/* ---------------- raw-tx decoder ---------------- */

class Reader {
  constructor(bytes) { this.b = bytes; this.i = 0; }
  get left() { return this.b.length - this.i; }
  bytes(n) {
    if (this.left < n) throw new Error(`truncated tx (need ${n} bytes, have ${this.left})`);
    return this.b.slice(this.i, (this.i += n));
  }
  u32() {
    if (this.left < 4) throw new Error(`truncated tx (need 4 bytes, have ${this.left})`);
    const v = new DataView(this.b.buffer, this.b.byteOffset + this.i, 4).getUint32(0, true);
    this.i += 4;
    return v;
  }
  u64() {
    const lo = this.u32(), hi = this.u32();
    return BigInt(hi) * 0x100000000n + BigInt(lo);
  }
  varint() {
    const b0 = this.bytes(1)[0];
    if (b0 < 0xfd) return b0;
    if (b0 === 0xfd) { const v = this.u32() & 0xffff; return v; }
    if (b0 === 0xfe) return this.u32();
    const v = this.u64();
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("varint too large");
    return Number(v);
  }
  varbytes() { return this.bytes(this.varint()); }
}

/** Decode a raw transaction hex into {version, inputs, outputs, witness, locktime, txid}.
 *  inputs: [{txid, vout, scriptSig, sequence}]; outputs: [{value (BigInt), spk}];
 *  witness: per-input array of Uint8Array stack items. */
export function decodeRawTx(hex) {
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) throw new Error("not hex");
  const b = hexToBytes(hex.toLowerCase());
  const r = new Reader(b);
  const version = r.u32();
  let witness = null;
  if (r.left >= 2 && r.b[r.i] === 0x00 && r.b[r.i + 1] === 0x01) {
    r.i += 2;
    witness = [];
  }
  const nIn = r.varint();
  if (nIn === 0 || nIn > 100000) throw new Error("bad input count");
  const inputs = [];
  for (let k = 0; k < nIn; k++) {
    const txid = bytesToHex(r.bytes(32).slice().reverse());
    const vout = r.u32();
    const scriptSig = r.varbytes();
    const sequence = r.u32();
    inputs.push({ txid, vout, scriptSig, sequence });
  }
  const nOut = r.varint();
  if (nOut === 0 || nOut > 100000) throw new Error("bad output count");
  const outputs = [];
  for (let k = 0; k < nOut; k++) {
    const value = r.u64();
    const spk = r.varbytes();
    outputs.push({ value, spk });
  }
  if (witness) {
    for (let k = 0; k < nIn; k++) {
      const nItems = r.varint();
      if (nItems > 100) throw new Error("witness stack too large");
      const stack = [];
      for (let j = 0; j < nItems; j++) stack.push(r.varbytes());
      witness.push(stack);
    }
  }
  const locktime = r.u32();
  if (r.left !== 0) throw new Error(`${r.left} trailing bytes`);
  // txid = dbl-sha256 of the non-witness serialization
  const core = [...u32le(version), ...varint(nIn)];
  for (const inp of inputs) {
    core.push(...hexToBytes(inp.txid).reverse(), ...u32le(inp.vout), ...varint(inp.scriptSig.length), ...inp.scriptSig, ...u32le(inp.sequence));
  }
  core.push(...varint(nOut));
  for (const out of outputs) {
    const lo = Number(out.value & 0xffffffffn), hi = Number(out.value >> 32n);
    core.push(...u32le(lo), ...u32le(hi), ...varint(out.spk.length), ...out.spk);
  }
  core.push(...u32le(locktime));
  const txid = bytesToHex(sha256(sha256(Uint8Array.from(core))).reverse());
  return { version, inputs, outputs, witness, locktime, txid };
}

/** Best-effort scriptPubKey → human description + Pearl address. */
export function describeSpk(spk, network) {
  if (spk.length === 34 && spk[0] === 0x51 && spk[1] === 0x20) {
    const program = spk.slice(2);
    return { type: "P2TR", address: encodeBech32m(network.hrp, 1, program), program };
  }
  if (spk.length === 22 && spk[0] === 0x00 && spk[1] === 0x14) return { type: "P2WPKH(v0, non-Pearl)", address: null };
  if (spk.length === 25 && spk[0] === 0x76) return { type: "P2PKH (non-Pearl)", address: null };
  return { type: "unknown", address: null };
}

/* ---------------- generalized keypath build ---------------- */

/** Keypath P2TR tx with selectable sighash type.
 *  inputs: [{txid, vout, value, spk, priv, internalXOnly}]
 *    spk = prevout's full scriptPubKey (required for the digest).
 *  outputs: [{program: Uint8Array(32), value (grains, safe int)}]
 *  hashType: 0x00 (SIGHASH_DEFAULT) or 0x83 (SIGHASH_SINGLE|ANYONECANPAY).
 *  Returns {txid, hex}. Witness sigs carry the sighash byte for non-default. */
export function buildKeypathTxEx(network, inputs, outputs, hashType = SIGHASH_DEFAULT, sequence = 0xffffffff) {
  if (!inputs.length || !outputs.length) throw new Error("need inputs and outputs");
  if (hashType !== SIGHASH_DEFAULT && hashType !== SIGHASH_SINGLE_ANYONECANPAY) throw new Error("unsupported hash_type");
  for (const o of outputs) {
    if (!(o.program instanceof Uint8Array) || o.program.length !== 32) throw new Error("bad output program");
    if (!Number.isSafeInteger(o.value) || o.value <= 0) throw new Error("bad output value");
  }
  const inDigest = inputs.map((i) => {
    if (!(i.spk instanceof Uint8Array) || i.spk.length === 0) throw new Error("input needs spk");
    if (!Number.isSafeInteger(i.value) || i.value <= 0) throw new Error("bad input value");
    return { txid: i.txid, vout: i.vout, value: i.value, spk: i.spk };
  });

  const core = [...u32le(network.txVersion), ...varint(inputs.length)];
  for (const inp of inputs) core.push(...txidLE(inp.txid), ...u32le(inp.vout), ...varint(0), ...u32le(sequence));
  core.push(...varint(outputs.length));
  for (const out of outputs) {
    const s = p2trScriptPubKey(out.program);
    core.push(...u64le(out.value), ...varint(s.length), ...s);
  }
  core.push(...u32le(0));
  const txid = bytesToHex(sha256(sha256(Uint8Array.from(core))).reverse());

  const sigs = inputs.map((inp, i) => {
    const digest = keypathSigDigestEx(network, inDigest, outputs, sequence, i, hashType);
    const tweaked = tweakPrivKeypath(inp.priv, inp.internalXOnly);
    return schnorr.sign(digest, tweaked, new Uint8Array(32));
  });

  const full = [...u32le(network.txVersion), 0x00, 0x01, ...varint(inputs.length)];
  for (const inp of inputs) full.push(...txidLE(inp.txid), ...u32le(inp.vout), ...varint(0), ...u32le(sequence));
  full.push(...varint(outputs.length));
  for (const out of outputs) {
    const s = p2trScriptPubKey(out.program);
    full.push(...u64le(out.value), ...varint(s.length), ...s);
  }
  for (const sig of sigs) {
    const withType = hashType === SIGHASH_DEFAULT ? sig : Uint8Array.from([...sig, hashType]);
    full.push(...varint(1), ...varint(withType.length), ...withType);
  }
  full.push(...u32le(0));
  return { txid, hex: bytesToHex(Uint8Array.from(full)) };
}

/* ---------------- local signature verification ---------------- */

/** Verify every input witness signature of a signed raw tx.
 *  prevouts: array parallel to inputs of {value, spk} (the spent outputs).
 *  Returns [{index, ok, reason}]. Recomputes the BIP-341 digest from the
 *  decoded outputs, so a tampered amount/address fails verification. */
export function verifySignedTx(network, signedHex, prevouts) {
  const dec = decodeRawTx(signedHex);
  if (!dec.witness) throw new Error("no witness data — nothing to verify");
  if (prevouts.length !== dec.inputs.length) throw new Error("prevout count mismatch");
  const results = [];
  for (let i = 0; i < dec.inputs.length; i++) {
    const stack = dec.witness[i];
    if (stack.length !== 1) {
      results.push({ index: i, ok: false, reason: `expected 1 witness item (keypath), got ${stack.length}` });
      continue;
    }
    const wit = stack[0];
    let sig, hashType;
    if (wit.length === 64) { sig = wit; hashType = SIGHASH_DEFAULT; }
    else if (wit.length === 65) { sig = wit.slice(0, 64); hashType = wit[64]; }
    else { results.push({ index: i, ok: false, reason: `bad witness length ${wit.length}` }); continue; }
    try {
      const po = prevouts[i];
      const d = describeSpk(po.spk, network);
      if (d.type !== "P2TR") {
        results.push({ index: i, ok: false, reason: `prevout is ${d.type}, keypath verify needs P2TR` });
        continue;
      }
      const digest = keypathSigDigestEx(
        network,
        prevouts.map((p, k) => ({ txid: dec.inputs[k].txid, vout: dec.inputs[k].vout, value: p.value, spk: p.spk })),
        dec.outputs.map((o) => ({ program: describeSpk(o.spk, network).program ?? new Uint8Array(32), value: Number(o.value) })),
        dec.inputs[i].sequence,
        i,
        hashType
      );
      const ok = schnorr.verify(sig, digest, d.program);
      results.push({ index: i, ok, reason: ok ? "BIP-341 keypath signature valid" : "signature does NOT verify" });
    } catch (e) {
      results.push({ index: i, ok: false, reason: String(e.message || e) });
    }
  }
  return results;
}

/* ---------------- coin selection ---------------- */

/** Largest-first selection covering targetGrains + fee at feeRate (grains/vB).
 *  Returns {selected, fee, change} or throws if funds insufficient.
 *  change is omitted (null) when it would be dust — added to fee instead. */
export function selectCoins(utxos, targetGrains, feeRateGrainsPerVByte, nOut) {
  const target = BigInt(targetGrains);
  const sorted = [...utxos].sort((a, b) => Number(BigInt(b.value) - BigInt(a.value)));
  const selected = [];
  let total = 0n;
  for (const u of sorted) {
    selected.push(u);
    total += BigInt(u.value);
    const withChange = keypathTxVBytes(selected.length, nOut + 1);
    const feeWithChange = BigInt(Math.ceil(withChange * feeRateGrainsPerVByte));
    const change = total - target - feeWithChange;
    if (change >= BigInt(DUST_GRAIN)) {
      return { selected, fee: feeWithChange, change };
    }
    const noChange = keypathTxVBytes(selected.length, nOut);
    const feeNoChange = BigInt(Math.ceil(noChange * feeRateGrainsPerVByte));
    if (total >= target + feeNoChange) {
      return { selected, fee: total - target, change: 0n }; // remainder to fee
    }
  }
  throw new Error(`insufficient funds: have ${fmtPRL(total)} PRL, need ${fmtPRL(target)} PRL + fee`);
}

/* ---------------- RPC helpers ---------------- */

/** Minimal pearld JSON-RPC client (basic auth). Endpoint like http://127.0.0.1:44107 */
export async function pearldRpc(endpoint, user, pass, method, params = []) {
  let res;
  try {
    res = await fetch(endpoint.replace(/\/$/, ""), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Basic " + btoa(`${user}:${pass}`),
      },
      body: JSON.stringify({ jsonrpc: "1.0", id: "pearl-sign", method, params }),
    });
  } catch (e) {
    throw new Error(`pearld unreachable at ${endpoint} — is the node running with RPC enabled? (${e.message})`);
  }
  const j = await res.json().catch(() => ({}));
  if (j.error) throw new Error(`pearld ${method} rejected: ${j.error.message || JSON.stringify(j.error)}`);
  return j.result;
}

/** Broadcast via blockbook /api/sendtx/ (verified pattern from the market app).
 *  Network failures say "unreachable" so they can't be mistaken for a node rejection. */
export async function broadcastViaBlockbook(blockbookBase, hex) {
  const base = blockbookBase.replace(/\/$/, "");
  let res, text;
  try {
    res = await fetch(base + "/api/sendtx/", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: hex,
    });
    text = await res.text();
  } catch (e) {
    throw new Error(`blockbook unreachable at ${base} — check the URL and your network connection (${e.message})`);
  }
  let j = {};
  try { j = JSON.parse(text); } catch { /* non-JSON */ }
  if (!res.ok || j.error) throw new Error("node rejected the transaction: " + (j.error || `HTTP ${res.status}: ${text.slice(0, 160)}`));
  const txid = j.result ?? j.txid;
  if (!/^[0-9a-f]{64}$/i.test(txid || "")) throw new Error("unexpected broadcast response: " + text.slice(0, 160));
  return txid.toLowerCase();
}

/** Fetch UTXOs for an address from blockbook. */
export async function fetchUtxos(blockbookBase, address) {
  const base = blockbookBase.replace(/\/$/, "");
  let res;
  try {
    res = await fetch(base + `/api/v2/utxo/${address}`);
  } catch (e) {
    throw new Error(`blockbook unreachable at ${base} — check the URL and your network connection (${e.message})`);
  }
  if (!res.ok) throw new Error(`blockbook ${res.status} on /api/v2/utxo`);
  const list = await res.json();
  if (!Array.isArray(list)) throw new Error("unexpected utxo response");
  return list
    .map((u) => ({ txid: u.txid, vout: u.vout, value: Number(u.value), confirmations: u.confirmations ?? 0 }))
    .filter((u) => u.value > 0 && /^[0-9a-f]{64}$/i.test(u.txid || ""));
}

/** Fee rate in grains/vByte from blockbook estimatefee (PRL/kB → grains/vB). */
export async function fetchFeeRate(blockbookBase, blocks = 2) {
  const base = blockbookBase.replace(/\/$/, "");
  let res;
  try {
    res = await fetch(base + `/api/v2/estimatefee/${blocks}`);
  } catch (e) {
    throw new Error(`blockbook unreachable at ${base} — check the URL and your network connection (${e.message})`);
  }
  const r = await res.json().catch(() => ({}));
  const perKb = Number(r.result ?? r);
  if (!Number.isFinite(perKb) || perKb <= 0) throw new Error("fee estimate unavailable");
  return (perKb * GRAIN_PER_PRL) / 1000;
}

/** Parse a pasted UTXO list: lines of "txid:vout value [unit] [address]".
 *  value is grains, or PRL when followed by "prl". An optional trailing
 *  address is decoded (needs network) into the prevout spk — used by the
 *  standalone signature verifier. */
export function parseUtxoList(text, network = null) {
  const out = [];
  const lines = text.split(/\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  for (const line of lines) {
    const m = line.match(/^([0-9a-fA-F]{64}):(\d+)\s+(\S+)(?:\s+(prl|grains?))?(?:\s+([a-z0-9]+))?$/i);
    if (!m) throw new Error(`bad UTXO line: ${line}`);
    const grains = (m[4] || "grains").toLowerCase().startsWith("prl")
      ? parsePRL(m[3])
      : BigInt(m[3]);
    let spk = null;
    if (m[5]) {
      if (!network) throw new Error(`network needed to decode the address on line: ${line}`);
      spk = p2trScriptPubKey(decodeBech32m(m[5], network.hrp).program);
    }
    const value = Number(grains);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`bad UTXO value: ${line}`);
    out.push({ txid: m[1].toLowerCase(), vout: Number(m[2]), value, confirmations: 0, spk });
  }
  return out;
}
