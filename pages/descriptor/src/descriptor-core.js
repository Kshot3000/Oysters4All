// Pearl Atlas — BIP-380 output descriptor desk for PRL.
// descriptor-core.js: pure, node-testable descriptor logic. No DOM, no network.
//
// Implements:
//  - BIP-380 descriptor checksum (descsum) — add / verify, with the exact
//    INPUT_CHARSET + polymod from the BIP.
//  - BIP-380/381/382/383/384/386/387/389 grammar parsing: pk, pkh, wpkh,
//    sh, wsh, tr, multi, sortedmulti, multi_a, combo, addr, raw, plus the
//    Taproot script fragments allowed inside tr() (pk_k, pk_h, older, after,
//    sha256, hash256, ripemd160, hash160, and_v, and_b, andor, or_b, or_c,
//    or_d, or_i, thresh), key origin info [fp/path], hardened + wildcard
//    steps, and multipath <a;b>.
//  - Key handling: raw pubkeys (compressed/uncompressed/x-only), WIF/hex
//    private keys, xpub/tpub-style extended keys (alt version bytes mapped),
//    BIP-32 derivation with hardened-from-xpub refusal.
//  - Script building: exact tapscript for tr() fragments, Core-style
//    pairwise-balanced taptree (BIP-386), scriptPubKeys for the address
//    types, prl1/tprl1 bech32m address derivation.
//  - BIP-386 range discipline: one shared index across every wildcard in a
//    descriptor (Core's rule); multipath expands to separate descriptors.
//
// Crypto primitives come from the audited files/pages/sign/src/crypto.js and
// the vendored @noble/* + @scure/* libs. Nothing here is new cryptography:
// bech32m, tagged hashes, tapleaf/tapbranch, keypath tweaks are all reused.
//
// Pearl is Taproot-only: only tr() keypath/script-path and addr() produce
// prl1 addresses. Other script types still get exact scriptPubKey bytes, but
// the desk labels them honestly as non-Pearl script types.

import { HDKey } from "@scure/bip32";
import { base58 } from "@scure/base";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { ripemd160 } from "@noble/hashes/ripemd160.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";
import {
  encodeBech32m, decodeBech32m, taggedHash, tapLeafHash, varint, NETWORKS,
} from "../../sign/src/crypto.js";

// ---------------------------------------------------------------------------
// BIP-380 checksum
// ---------------------------------------------------------------------------

export const INPUT_CHARSET =
  "0123456789()[],'/*abcdefgh@:$%{}IJKLMNOPQRSTUVWXYZ&+-.;<=>?!^_|~" +
  "ijklmnopqrstuvwxyzABCDEFGH`#\"\\ ";
export const CHECKSUM_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

const DESCSUM_GEN = [0xf5dee51989n, 0xa9fdca3312n, 0x1bab10e32dn, 0x3706b1677an, 0x644d626ffdn];

function descsumPolymod(symbols) {
  let chk = 1n;
  for (const v of symbols) {
    const top = chk >> 35n;
    chk = ((chk & 0x7ffffffffn) << 5n) ^ BigInt(v);
    for (let i = 0; i < 5; i++) {
      if ((top >> BigInt(i)) & 1n) chk ^= DESCSUM_GEN[i];
    }
  }
  return chk;
}

function descsumExpand(s) {
  const groups = [];
  const symbols = [];
  for (const c of s) {
    const v = INPUT_CHARSET.indexOf(c);
    if (v < 0) return null;
    symbols.push(v & 31);
    groups.push(v >> 5);
    if (groups.length === 3) {
      symbols.push(groups[0] * 9 + groups[1] * 3 + groups[2]);
      groups.length = 0;
    }
  }
  if (groups.length === 1) symbols.push(groups[0]);
  else if (groups.length === 2) symbols.push(groups[0] * 3 + groups[1]);
  return symbols;
}

/** Compute the 8-char BIP-380 checksum for a descriptor body, or null. */
export function descChecksum(body) {
  const symbols = descsumExpand(body);
  if (symbols === null) return null;
  const chk = descsumPolymod([...symbols, 0, 0, 0, 0, 0, 0, 0, 0]) ^ 1n;
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += CHECKSUM_CHARSET[Number((chk >> BigInt(5 * (7 - i))) & 31n)];
  }
  return out;
}

/** Append the BIP-380 checksum: "body" -> "body#checksum". */
export function descAddChecksum(body) {
  const c = descChecksum(body);
  if (c === null) throw new Error("descriptor contains characters outside the BIP-380 input set");
  return body + "#" + c;
}

/**
 * Verify a (possibly checksummed) descriptor string.
 * Returns { ok, body, checksum, require, reason }.
 */
export function descCheckChecksum(str, { require = false } = {}) {
  const hashIdx = str.lastIndexOf("#");
  if (hashIdx < 0) {
    return require
      ? { ok: false, body: str, checksum: null, reason: "missing checksum (expected # + 8 chars)" }
      : { ok: true, body: str, checksum: null, reason: "no checksum present (optional)" };
  }
  const body = str.slice(0, hashIdx);
  const sum = str.slice(hashIdx + 1);
  if (body.includes("#")) return { ok: false, body, checksum: sum, reason: "more than one # separator" };
  if (sum.length !== 8) {
    return { ok: false, body, checksum: sum, reason: `checksum must be exactly 8 chars, got ${sum.length}` };
  }
  for (const c of sum) {
    if (!CHECKSUM_CHARSET.includes(c)) {
      return { ok: false, body, checksum: sum, reason: `checksum char '${c}' not in checksum charset` };
    }
  }
  const expected = descChecksum(body);
  if (expected === null) {
    return { ok: false, body, checksum: sum, reason: "descriptor body has characters outside the BIP-380 input set" };
  }
  if (sum !== expected) {
    return { ok: false, body, checksum: sum, reason: `checksum mismatch — expected #${expected}` };
  }
  return { ok: true, body, checksum: sum, reason: "valid BIP-380 checksum" };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class DescError extends Error {
  constructor(message, pos = -1) {
    super(pos >= 0 ? `${message} (at char ${pos})` : message);
    this.name = "DescError";
    this.pos = pos;
  }
}

// ---------------------------------------------------------------------------
// Parser — recursive descent over the BIP-380 expression grammar
// ---------------------------------------------------------------------------

const MAX_DESC_LEN = 100000;

export function parseDescriptor(input) {
  const check = descCheckChecksum(input.trim(), { require: false });
  const body = check.body;
  if (body.length === 0) throw new DescError("empty descriptor");
  if (body.length > MAX_DESC_LEN) throw new DescError(`descriptor longer than ${MAX_DESC_LEN} chars`);
  const p = new Parser(body);
  const ast = p.parseTop();
  p.expectEnd();
  ast.checksum = check.ok ? check.checksum : null;
  ast.checksumInfo = check;
  return ast;
}

class Parser {
  constructor(s) {
    this.s = s;
    this.i = 0;
  }
  peek() { return this.s[this.i]; }
  eof() { return this.i >= this.s.length; }
  error(msg) { throw new DescError(msg, this.i); }
  expect(ch) {
    if (this.s[this.i] !== ch) this.error(`expected '${ch}', found '${this.s[this.i] ?? "end"}'`);
    this.i++;
  }
  expectEnd() {
    if (!this.eof()) this.error(`trailing characters '${this.s.slice(this.i, this.i + 12)}'`);
  }
  parseName() {
    const m = /^[a-z][a-z0-9_]*/.exec(this.s.slice(this.i));
    if (!m) this.error("expected function name");
    this.i += m[0].length;
    return m[0];
  }
  parseArgs() {
    const args = [];
    this.expect("(");
    if (this.peek() === ")") { this.i++; return args; }
    for (;;) {
      args.push(this.parseExpr());
      if (this.peek() === ",") { this.i++; continue; }
      if (this.peek() === ")") { this.i++; return args; }
      this.error(`expected ',' or ')', found '${this.peek() ?? "end"}'`);
    }
  }
  // A "leaf": function call, or a bare key/value literal.
  parseExpr() {
    const c = this.peek();
    if (c >= "a" && c <= "z") {
      const save = this.i;
      const name = this.parseName();
      if (this.peek() === "(") {
        return this.buildNode(name, this.parseArgs());
      }
      this.i = save; // bare literal (key data, number, hex)
    }
    return this.parseLiteral();
  }
  parseLiteral() {
    let j = this.i;
    if (this.s[j] === "[") {
      // Key origin prefix: consume through the closing bracket so the whole
      // "[fp/path]xkey..." stays one literal for parseKeyExpression.
      const close = this.s.indexOf("]", j);
      if (close < 0) this.error("unterminated key origin [...]");
      j = close + 1;
    }
    while (j < this.s.length && ![",", ")", "]"].includes(this.s[j])) j++;
    const lit = this.s.slice(this.i, j);
    if (!lit) this.error("expected expression");
    this.i = j;
    return { kind: "literal", text: lit };
  }
  parseTop() {
    const node = this.parseExpr();
    const t = node.kind;
    const TOP = ["pk", "pkh", "wpkh", "sh", "wsh", "tr", "multi", "sortedmulti", "combo", "addr", "raw"];
    if (!TOP.includes(t)) this.error(`'${t}' cannot be a top-level descriptor`);
    return node;
  }
  buildNode(name, args) {
    switch (name) {
      case "pk": return this.reqArgs(name, args, 1, 1, (a) => ({ kind: "pk", key: this.parseKeyArg(a[0]) }));
      case "pkh": return this.reqArgs(name, args, 1, 1, (a) => ({ kind: "pkh", key: this.parseKeyArg(a[0]) }));
      case "wpkh": return this.reqArgs(name, args, 1, 1, (a) => ({ kind: "wpkh", key: this.parseKeyArg(a[0]) }));
      case "sh": return this.reqArgs(name, args, 1, 1, (a) => ({ kind: "sh", script: this.asScript(a[0], name) }));
      case "wsh": return this.reqArgs(name, args, 1, 1, (a) => ({ kind: "wsh", script: this.asScript(a[0], name) }));
      case "tr": {
        if (args.length < 1) this.error("tr() needs an internal key");
        const key = this.parseKeyArg(args[0]);
        const scripts = args.slice(1).map((a) => this.asTapScript(a));
        return { kind: "tr", key, scripts };
      }
      case "multi": return this.parseMulti(name, args, false);
      case "sortedmulti": return this.parseMulti(name, args, true);
      case "multi_a": {
        if (args.length < 2) this.error("multi_a() needs k and at least one key");
        const k = this.parseNum(args[0], "multi_a k");
        if (args[0].kind !== "literal") this.error("multi_a k must be a number");
        const keys = args.slice(1).map((a) => this.parseKeyArg(a));
        return { kind: "multi_a", k, keys, n: keys.length };
      }
      case "combo": return this.reqArgs(name, args, 1, 1, (a) => ({ kind: "combo", key: this.parseKeyArg(a[0]) }));
      case "addr": return this.reqArgs(name, args, 1, 1, (a) => {
        if (a[0].kind !== "literal") this.error("addr() takes an address string");
        return { kind: "addr", address: a[0].text };
      });
      case "raw": return this.reqArgs(name, args, 1, 1, (a) => {
        if (a[0].kind !== "literal" || !/^[0-9a-fA-F]*$/.test(a[0].text) || a[0].text.length % 2 !== 0)
          this.error("raw() takes hex (even-length hex string)");
        return { kind: "raw", hex: a[0].text };
      });
      // ---- Taproot script fragments (BIP-342), valid inside tr() ----
      case "pk_k": return this.reqArgs(name, args, 1, 1, (a) => ({ kind: "frag", frag: "pk_k", key: this.parseKeyArg(a[0]) }));
      case "pk_h": return this.reqArgs(name, args, 1, 1, (a) => ({ kind: "frag", frag: "pk_h", key: this.parseKeyArg(a[0]) }));
      case "older": return this.reqArgs(name, args, 1, 1, (a) => {
        const n = this.parseNum(a[0], "older");
        if (n <= 0 || n >= 0x80000000) this.error("older() needs 0 < n < 2^31 (like Core)");
        return { kind: "frag", frag: "older", n };
      });
      case "after": return this.reqArgs(name, args, 1, 1, (a) => {
        const n = this.parseNum(a[0], "after");
        if (n >= 0x80000000) this.error("after() needs 0 <= n < 2^31 (like Core)");
        return { kind: "frag", frag: "after", n };
      });
      case "sha256": return this.reqArgs(name, args, 1, 1, (a) => ({ kind: "frag", frag: "sha256", h: this.parseHex(a[0], 32, "sha256") }));
      case "hash256": return this.reqArgs(name, args, 1, 1, (a) => ({ kind: "frag", frag: "hash256", h: this.parseHex(a[0], 32, "hash256") }));
      case "ripemd160": return this.reqArgs(name, args, 1, 1, (a) => ({ kind: "frag", frag: "ripemd160", h: this.parseHex(a[0], 20, "ripemd160") }));
      case "hash160": return this.reqArgs(name, args, 1, 1, (a) => ({ kind: "frag", frag: "hash160", h: this.parseHex(a[0], 20, "hash160") }));
      case "and_v": return this.reqArgs(name, args, 2, 2, (a) => ({ kind: "frag", frag: "and_v", x: this.asTapScript(a[0]), y: this.asTapScript(a[1]) }));
      case "and_b": return this.reqArgs(name, args, 3, 3, (a) => ({ kind: "frag", frag: "and_b", k: this.asTapScript(a[0]), x: this.asTapScript(a[1]), y: this.asTapScript(a[2]) }));
      case "andor": return this.reqArgs(name, args, 3, 3, (a) => ({ kind: "frag", frag: "andor", x: this.asTapScript(a[0]), y: this.asTapScript(a[1]), z: this.asTapScript(a[2]) }));
      case "or_b": return this.reqArgs(name, args, 3, 3, (a) => ({ kind: "frag", frag: "or_b", x: this.asTapScript(a[0]), z: this.asTapScript(a[1]), w: this.asTapScript(a[2]) }));
      case "or_c": return this.reqArgs(name, args, 2, 2, (a) => ({ kind: "frag", frag: "or_c", x: this.asTapScript(a[0]), z: this.asTapScript(a[1]) }));
      case "or_d": return this.reqArgs(name, args, 2, 2, (a) => ({ kind: "frag", frag: "or_d", x: this.asTapScript(a[0]), z: this.asTapScript(a[1]) }));
      case "or_i": return this.reqArgs(name, args, 2, 2, (a) => ({ kind: "frag", frag: "or_i", x: this.asTapScript(a[0]), z: this.asTapScript(a[1]) }));
      case "thresh": {
        if (args.length < 3) this.error("thresh() needs k and at least two fragments");
        const k = this.parseNum(args[0], "thresh k");
        const subs = args.slice(1).map((a) => this.asTapScript(a));
        return { kind: "frag", frag: "thresh", k, subs };
      }
      default: this.error(`unknown descriptor function '${name}'`);
    }
  }
  reqArgs(name, args, lo, hi, fn) {
    if (args.length < lo || args.length > hi) this.error(`${name}() takes ${lo === hi ? lo : lo + "-" + hi} argument(s), got ${args.length}`);
    return fn(args);
  }
  parseMulti(name, args, sorted) {
    if (args.length < 2) this.error(`${name}() needs k and at least one key`);
    if (args[0].kind !== "literal") this.error(`${name} k must be a number`);
    const k = this.parseNum(args[0], name + " k");
    const keys = args.slice(1).map((a) => this.parseKeyArg(a));
    return { kind: name, k, keys, n: keys.length, sorted };
  }
  parseNum(lit, what) {
    if (lit.kind !== "literal" || !/^\d+$/.test(lit.text)) this.error(`${what} must be a non-negative integer`);
    const n = Number(lit.text);
    if (!Number.isSafeInteger(n)) this.error(`${what} out of range`);
    return n;
  }
  parseHex(lit, len, what) {
    if (lit.kind !== "literal" || !/^[0-9a-fA-F]+$/.test(lit.text) || lit.text.length !== len * 2) {
      this.error(`${what} must be ${len * 2} hex chars`);
    }
    return lit.text.toLowerCase();
  }
  // An argument position that must hold a script (for sh/wsh/tr script args):
  // either a nested script function, a bare key (pk), or a fragment.
  asScript(node, ctx) {
    if (node.kind === "literal") return { kind: "pk", key: this.parseKeyArg(node) };
    const ok = ["pk", "pkh", "wpkh", "wsh", "multi", "sortedmulti", "raw", "addr"];
    if (node.kind === "frag") return node;
    if (node.kind === "sh" && ctx !== "sh") this.error("sh() cannot be nested inside " + ctx);
    if (node.kind === "tr") this.error("tr() cannot be nested");
    if (!ok.includes(node.kind) && node.kind !== "sh") this.error(`'${node.kind}' is not a valid script inside ${ctx}()`);
    return node;
  }
  asTapScript(node) {
    if (node.kind === "literal") {
      // bare key inside tr() scripts means pk(...)
      if (/^[0-9a-fA-F]+$/.test(node.text)) return { kind: "frag", frag: "pk", key: this.parseKeyArg(node) };
      return { kind: "frag", frag: "pk", key: this.parseKeyArg(node) };
    }
    if (node.kind === "frag" || node.kind === "multi_a" || node.kind === "pk" || node.kind === "raw") return node;
    this.error(`'${node.kind}' is not a valid Taproot script fragment (only pk/pk_k/pk_h/multi_a/timelock/hash fragments/and/or/thresh/raw)`);
  }
  parseKeyArg(node) {
    if (node.kind !== "literal") this.error("expected a key expression");
    return parseKeyExpression(node.text);
  }
}

// ---------------------------------------------------------------------------
// Key expressions: [origin]xkey[/path][*] etc.
// ---------------------------------------------------------------------------

const HARDENED_RE = /^(0|[1-9]\d*)(h|')$/;

export function parseKeyExpression(text) {
  let s = text;
  let origin = null;
  if (s.startsWith("[")) {
    const close = s.indexOf("]");
    if (close < 0) throw new DescError("unterminated key origin [...]");
    origin = parseOrigin(s.slice(1, close));
    s = s.slice(close + 1);
  }
  // Multipath <a;b;...> may wrap the derivation section.
  let multipath = null;
  const mpOpen = s.indexOf("<");
  if (mpOpen >= 0) {
    const mpClose = s.indexOf(">", mpOpen);
    if (mpClose < 0) throw new DescError("unterminated multipath <...>");
    const inner = s.slice(mpOpen + 1, mpClose);
    multipath = inner.split(";").map((p) => parseDerivPath(p === "" ? "" : "/" + p));
    s = s.slice(0, mpOpen) + s.slice(mpClose + 1);
    if (s.includes("<") || s.includes(">")) throw new DescError("nested multipath not allowed");
  }
  let wildcard = false;
  if (s.endsWith("*")) {
    wildcard = true;
    s = s.slice(0, -1);
    if (s.endsWith("/")) s = s.slice(0, -1); // the '/' separating path from '*'
  } else if (s.endsWith("*'") || s.endsWith("*h")) {
    throw new DescError("hardened wildcard not allowed");
  }
  const slash = s.search(/(?<!^)\//); // first '/' not at position 0
  let keyData, pathStr;
  if (slash >= 0) { keyData = s.slice(0, slash); pathStr = s.slice(slash); }
  else { keyData = s; pathStr = ""; }
  if (!keyData) throw new DescError("empty key in key expression");
  const path = pathStr ? parseDerivPath(pathStr) : [];
  const key = parseKeyData(keyData);
  return { kind: "key", origin, key, path, multipath, wildcard, text };
}

function parseOrigin(s) {
  if (s.length === 0) throw new DescError("empty key origin");
  const parts = s.split("/");
  const fp = parts[0];
  if (!/^[0-9a-fA-F]{8}$/.test(fp)) throw new DescError("origin fingerprint must be 8 hex chars");
  const path = parseDerivPath(parts.length > 1 ? "/" + parts.slice(1).join("/") : "");
  return { fingerprint: fp.toLowerCase(), path };
}

function parseDerivPath(s) {
  if (!s) return [];
  if (!s.startsWith("/")) throw new DescError("derivation path must start with /");
  return s.slice(1).split("/").map((step) => {
    if (step === "") throw new DescError("empty derivation step");
    const m = HARDENED_RE.exec(step);
    if (m) return { index: Number(m[1]), hardened: true };
    if (!/^(0|[1-9]\d*)$/.test(step)) throw new DescError(`bad derivation step '${step}'`);
    const index = Number(step);
    if (index > 0x7fffffff) throw new DescError("derivation index out of range");
    return { index, hardened: false };
  });
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function isBase58(s) { return s.length > 0 && [...s].every((c) => B58.includes(c)); }
function isHex(s) { return s.length > 0 && /^[0-9a-fA-F]+$/.test(s); }

// Extended-key version bytes we accept; alt versions are normalized to
// xpub/tpub form before parsing (payload is identical).
const ALT_XPUB_VERSIONS = {
  "049d7cb2": "0488b21e", // ypub -> xpub
  "04b24746": "0488b21e", // zpub -> xpub
  "0295b43f": "0488b21e", // Ypub -> xpub
  "02f5b3f6": "0488b21e", // Zpub -> xpub
  "044a5262": "0488b21e", // upub -> xpub
  "045f1cf6": "0488b21e", // vpub -> xpub
  "043587cf": "043587cf", // tpub (kept)
  "044a4e28": "043587cf", // upub-test -> tpub
  "045f18bc": "043587cf", // vpub-test -> tpub
};
const XPRV_VERSIONS = {
  "0488ade4": "0488ade4", "04358394": "04358394", // xprv, tprv
  "049d7878": "0488ade4", "04b2430c": "0488ade4", // yprv, zprv -> xprv
};

export function parseKeyData(s) {
  // WIF (51/52 base58 chars starting with 5/K/L/c/...)
  if (/^[5KLc][1-9A-HJ-NP-Za-km-z]{50,51}$/.test(s) && isBase58(s)) {
    return { type: "wif", wif: s };
  }
  if (isHex(s)) {
    const h = s.toLowerCase();
    if (h.length === 64) {
      // 32 bytes: x-only pubkey OR raw private key — ambiguous until used.
      return { type: "xonly_or_priv", hex: h };
    }
    if (h.length === 66 && (h.startsWith("02") || h.startsWith("03"))) {
      return { type: "pubkey33", hex: h };
    }
    if (h.length === 130 && h.startsWith("04")) {
      return { type: "pubkey65", hex: h };
    }
    throw new DescError("hex key must be 32 bytes (x-only/priv), 33-byte compressed, or 65-byte uncompressed");
  }
  if (isBase58(s) && s.length >= 100 && s.length <= 120) {
    // Extended key — normalize alt version bytes, then let scure-bip32 parse.
    try {
      const raw = base58Decode(s);
      if (raw.length === 82 && raw.slice(-4).every((b, i) => b === dblSha(raw.slice(0, 78))[i])) {
        const ver = bytesToHex(raw.slice(0, 4));
        const isPriv = XPRV_VERSIONS[ver] !== undefined;
        const mapped = ALT_XPUB_VERSIONS[ver];
        if (mapped) {
          const norm = base58Encode(Uint8Array.from([...hexToBytes(mapped), ...raw.slice(4, 78), ...dblSha(Uint8Array.from([...hexToBytes(mapped), ...raw.slice(4, 78)])).slice(0, 4)]));
          const hd = HDKey.fromExtendedKey(norm);
          return { type: isPriv ? "xprv" : "xpub", hd, version: ver, text: s };
        }
        if (ver === "0488b21e" || ver === "043587cf" || isPriv) {
          const hd = HDKey.fromExtendedKey(s);
          return { type: isPriv ? "xprv" : "xpub", hd, version: ver, text: s };
        }
      }
    } catch (e) {
      if (e instanceof DescError) throw e;
      throw new DescError("invalid extended key: " + e.message);
    }
    throw new DescError("invalid extended key (bad version or checksum)");
  }
  throw new DescError("unrecognized key data (need WIF, hex pubkey/privkey, or extended key)");
}

function dblSha(b) { return sha256(sha256(b)); }

// Synchronous base58 via the vendored @scure/base codec.
function base58Decode(s) { return base58.decode(s); }
function base58Encode(b) { return base58.encode(b); }

// ---------------------------------------------------------------------------
// Key resolution — turn a parsed key expression into concrete keys at index i
// ---------------------------------------------------------------------------

const SECP_N = secp256k1.CURVE.n;

function liftX(xonly) {
  return schnorr.utils.lift_x(bytesToNum(xonly));
}
function bytesToNum(b) {
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  return n;
}
function numToBytes(n, len) {
  const out = new Uint8Array(len);
  for (let i = len - 1; i >= 0; i--) { out[i] = Number(n & 0xffn); n >>= 8n; }
  return out;
}
function pubkey33ToXonly(p33) {
  if (p33.length !== 33 || (p33[0] !== 0x02 && p33[0] !== 0x03)) {
    throw new DescError("expected 33-byte compressed pubkey");
  }
  const P = secp256k1.ProjectivePoint.fromHex(p33);
  return schnorr.utils.pointToBytes(P); // x-only
}
function privToXonly(priv) {
  if (priv.length !== 32 || bytesToNum(priv) === 0n || bytesToNum(priv) >= SECP_N) {
    throw new DescError("invalid private key");
  }
  return schnorr.getPublicKey(priv); // 32-byte x-only Uint8Array
}
function wifToPriv(wif) {
  const raw = base58Decode(wif);
  if (raw.length !== 37 && raw.length !== 38) throw new DescError("bad WIF length");
  if (raw[0] !== 0x80) throw new DescError("WIF must start with version 0x80");
  const body = raw.slice(0, -4);
  const check = raw.slice(-4);
  const h = dblSha(body);
  for (let i = 0; i < 4; i++) if (h[i] !== check[i]) throw new DescError("bad WIF checksum");
  const priv = body.slice(1, 33);
  if (body.length === 34 && body[33] !== 0x01) throw new DescError("bad WIF compression flag");
  return priv;
}

/**
 * Resolve a key expression to a 32-byte x-only pubkey for derivation index i
 * (ignored when the expression has no wildcard). Also returns metadata.
 * asPriv=true resolves raw private material (WIF/hex/xprv) for signing UIs.
 */
export function resolveKey(expr, index = 0, { asPriv = false } = {}) {
  if (expr.kind !== "key") throw new DescError("not a key expression");
  if (expr.multipath) throw new DescError("resolve one multipath branch at a time (use expandMultipath)");
  if (expr.wildcard && !Number.isInteger(index)) throw new DescError("wildcard key needs an index");
  const { key } = expr;
  const hardenedInPath = expr.path.some((s) => s.hardened);

  if (key.type === "xpub" || key.type === "xprv") {
    const hd = key.hd;
    if (hardenedInPath && !hd.privateKey && key.type === "xpub") {
      throw new DescError("cannot do hardened derivation from an xpub (no private key)");
    }
    let node = hd;
    for (const s of expr.path) {
      const childNum = s.hardened ? s.index + 0x80000000 : s.index;
      node = node.deriveChild(childNum);
      if (!node) throw new DescError("BIP-32 derivation failed");
    }
    if (expr.wildcard) {
      node = node.deriveChild(index);
      if (!node) throw new DescError("BIP-32 wildcard derivation failed");
    }
    if (asPriv) {
      if (!node.privateKey) throw new DescError("extended key has no private part");
      return { xonly: privToXonly(node.privateKey), priv: node.privateKey.slice(), kind: "xprv-child" };
    }
    if (!node.publicKey) throw new DescError("no public key at this derivation");
    return { xonly: pubkey33ToXonly(node.publicKey), kind: key.type + "-child" };
  }
  if (expr.path.length > 0 || expr.wildcard) {
    throw new DescError("derivation path/wildcard on a non-extended key");
  }
  if (key.type === "wif") {
    const priv = wifToPriv(key.wif);
    const xonly = privToXonly(priv);
    return asPriv ? { xonly, priv, kind: "wif" } : { xonly, kind: "wif" };
  }
  if (key.type === "xonly_or_priv") {
    const b = hexToBytes(key.hex);
    // Try as x-only pubkey first (must lift to the curve); else as privkey.
    try {
      liftX(b);
      if (asPriv) throw new DescError("32-byte hex is a public key, not a private key");
      return { xonly: b, kind: "xonly" };
    } catch { /* fall through to privkey */ }
    const xonly = privToXonly(b);
    return asPriv ? { xonly, priv: b.slice(), kind: "hexpriv" } : { xonly, kind: "hexpriv-pub" };
  }
  if (key.type === "pubkey33") {
    if (asPriv) throw new DescError("33-byte hex is a public key, not a private key");
    return { xonly: pubkey33ToXonly(hexToBytes(key.hex)), kind: "pubkey33" };
  }
  if (key.type === "pubkey65") {
    if (asPriv) throw new DescError("65-byte hex is a public key, not a private key");
    const P = secp256k1.ProjectivePoint.fromHex(hexToBytes(key.hex));
    return { xonly: schnorr.utils.pointToBytes(P), kind: "pubkey65" };
  }
  throw new DescError("cannot resolve key type " + key.type);
}

/** Expand multipath <a;b;...> into one key-expression per branch. */
export function expandMultipath(expr) {
  if (expr.kind !== "key" || !expr.multipath) return [expr];
  return expr.multipath.map((branch) => ({
    ...expr,
    path: [...expr.path, ...branch],
    multipath: null,
  }));
}

/** Does this key expression vary with the derivation index? */
export function isRanged(expr) {
  return expr.kind === "key" && (expr.wildcard || (expr.multipath && expr.multipath.some((b) => b.length)));
}

// ---------------------------------------------------------------------------
// Tapscript fragment builders (exact BIP-342 constructions)
// ---------------------------------------------------------------------------

const OP = {
  CHECKSIG: 0xac, CHECKSIGADD: 0xba, CHECKMULTISIG: 0xae,
  DUP: 0x76, HASH160: 0xa9, EQUALVERIFY: 0x88, EQUAL: 0x87,
  SIZE: 0x82, SHA256: 0xa8, HASH256: 0xaa, RIPEMD160: 0xa6,
  CHECKSEQUENCEVERIFY: 0xb2, CHECKLOCKTIMEVERIFY: 0xb1,
  BOOLAND: 0x9a, BOOLOR: 0x9b, NOTIF: 0x64, ENDIF: 0x68, IF: 0x63, ELSE: 0x67,
  IFDUP: 0x73, ADD: 0x93, NUMEQUAL: 0x9c, DROP: 0x75, VERIFY: 0x69,
  PUSHDATA1: 0x4c, PUSHDATA2: 0x4d,
};

function push(data) {
  if (!(data instanceof Uint8Array)) data = Uint8Array.from(data);
  if (data.length === 0) return Uint8Array.from([0x00]);
  if (data.length === 1 && data[0] >= 1 && data[0] <= 16) return Uint8Array.from([0x50 + data[0]]);
  if (data.length < 0x4c) return Uint8Array.from([data.length, ...data]);
  if (data.length <= 0xff) return Uint8Array.from([OP.PUSHDATA1, data.length, ...data]);
  if (data.length <= 0xffff) {
    return Uint8Array.from([OP.PUSHDATA2, data.length & 0xff, (data.length >> 8) & 0xff, ...data]);
  }
  throw new DescError("push too large");
}

/** Minimal script-number encoding (BIP-62 rule). */
export function scriptNum(n) {
  if (!Number.isSafeInteger(n) || n < 0) throw new DescError("script number must be a non-negative safe integer");
  if (n === 0) return new Uint8Array(0);
  const out = [];
  while (n > 0) { out.push(n & 0xff); n = Math.floor(n / 256); }
  if (out[out.length - 1] & 0x80) out.push(0x00);
  return Uint8Array.from(out);
}

function concat(...parts) {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Build the exact tapscript for a fragment AST at derivation index i. */
export function buildTapscript(node, index = 0, depth = 0) {
  if (depth > 32) throw new DescError("script nesting too deep");
  const rk = (k) => resolveKey(k, index).xonly;
  switch (node.kind) {
    case "frag": {
      const f = node.frag;
      if (f === "pk" || f === "pk_k") return concat(push(rk(node.key)), Uint8Array.from([OP.CHECKSIG]));
      if (f === "pk_h") {
        const h = ripemd160(sha256(rk(node.key)));
        return concat(
          Uint8Array.from([OP.DUP, OP.HASH160]), push(h),
          Uint8Array.from([OP.EQUALVERIFY, OP.CHECKSIG]),
        );
      }
      if (f === "older") return concat(push(scriptNum(node.n)), Uint8Array.from([OP.CHECKSEQUENCEVERIFY]));
      if (f === "after") return concat(push(scriptNum(node.n)), Uint8Array.from([OP.CHECKLOCKTIMEVERIFY]));
      if (f === "sha256") return concat(
        Uint8Array.from([OP.SIZE]), push(scriptNum(32)), Uint8Array.from([OP.EQUALVERIFY, OP.SHA256]),
        push(hexToBytes(node.h)), Uint8Array.from([OP.EQUAL]),
      );
      if (f === "hash256") return concat(
        Uint8Array.from([OP.SIZE]), push(scriptNum(32)), Uint8Array.from([OP.EQUALVERIFY, OP.HASH256]),
        push(hexToBytes(node.h)), Uint8Array.from([OP.EQUAL]),
      );
      if (f === "ripemd160") return concat(
        Uint8Array.from([OP.SIZE]), push(scriptNum(32)), Uint8Array.from([OP.EQUALVERIFY, OP.RIPEMD160]),
        push(hexToBytes(node.h)), Uint8Array.from([OP.EQUAL]),
      );
      if (f === "hash160") return concat(
        Uint8Array.from([OP.SIZE]), push(scriptNum(32)), Uint8Array.from([OP.EQUALVERIFY, OP.HASH160]),
        push(hexToBytes(node.h)), Uint8Array.from([OP.EQUAL]),
      );
      if (f === "and_v") return concat(buildTapscript(node.x, index, depth + 1), buildTapscript(node.y, index, depth + 1));
      if (f === "and_b") {
        return concat(
          buildTapscript(node.k, index, depth + 1), buildTapscript(node.x, index, depth + 1),
          buildTapscript(node.y, index, depth + 1), Uint8Array.from([OP.BOOLAND]),
        );
      }
      if (f === "andor") {
        return concat(
          buildTapscript(node.x, index, depth + 1), Uint8Array.from([OP.NOTIF]),
          buildTapscript(node.z, index, depth + 1), Uint8Array.from([OP.ELSE]),
          buildTapscript(node.y, index, depth + 1), Uint8Array.from([OP.ENDIF]),
        );
      }
      if (f === "or_b") {
        return concat(
          buildTapscript(node.x, index, depth + 1), buildTapscript(node.z, index, depth + 1),
          buildTapscript(node.w, index, depth + 1), Uint8Array.from([OP.BOOLOR]),
        );
      }
      if (f === "or_c") {
        return concat(
          buildTapscript(node.x, index, depth + 1), Uint8Array.from([OP.NOTIF]),
          buildTapscript(node.z, index, depth + 1), Uint8Array.from([OP.ENDIF]),
        );
      }
      if (f === "or_d") {
        return concat(
          buildTapscript(node.x, index, depth + 1), Uint8Array.from([OP.IFDUP, OP.NOTIF]),
          buildTapscript(node.z, index, depth + 1), Uint8Array.from([OP.ENDIF]),
        );
      }
      if (f === "or_i") {
        return concat(
          Uint8Array.from([OP.IF]), buildTapscript(node.x, index, depth + 1),
          Uint8Array.from([OP.ELSE]), buildTapscript(node.z, index, depth + 1),
          Uint8Array.from([OP.ENDIF]),
        );
      }
      if (f === "thresh") {
        if (node.k < 1 || node.k > node.subs.length) throw new DescError("thresh k out of range");
        const parts = node.subs.map((s) => buildTapscript(s, index, depth + 1));
        const adds = [];
        for (let j = 0; j < parts.length - 1; j++) adds.push(Uint8Array.from([OP.ADD]));
        return concat(...parts, ...adds, push(scriptNum(node.k)), Uint8Array.from([OP.NUMEQUAL]));
      }
      throw new DescError("unknown fragment " + f);
    }
    case "multi_a": {
      if (node.k < 1 || node.k > node.keys.length) throw new DescError("multi_a k out of range");
      if (node.keys.length > 999) throw new DescError("multi_a with more than 999 keys");
      const parts = node.keys.map((k) => concat(push(rk(k)), Uint8Array.from([OP.CHECKSIG])));
      const adds = [];
      for (let j = 0; j < parts.length - 1; j++) adds.push(Uint8Array.from([OP.CHECKSIGADD]));
      return concat(...parts, ...adds, push(scriptNum(node.k)), Uint8Array.from([OP.NUMEQUAL]));
    }
    case "pk": return concat(push(rk(node.key)), Uint8Array.from([OP.CHECKSIG]));
    case "raw": return hexToBytes(node.hex);
    default: throw new DescError(`cannot build tapscript for '${node.kind}'`);
  }
}

// ---------------------------------------------------------------------------
// Top-level script builders (non-Taproot types — informational on Pearl)
// ---------------------------------------------------------------------------

export function buildTopScript(node, index = 0) {
  switch (node.kind) {
    case "pk": {
      const k = resolveKey(node.key, index);
      const p33 = xonlyTo33(k.xonly, node.key, index);
      return concat(push(p33), Uint8Array.from([OP.CHECKSIG]));
    }
    case "pkh": {
      const k = resolveKey(node.key, index);
      const p33 = xonlyTo33(k.xonly, node.key, index);
      return concat(Uint8Array.from([OP.DUP, OP.HASH160]), push(ripemd160(sha256(p33))),
        Uint8Array.from([OP.EQUALVERIFY, OP.CHECKSIG]));
    }
    case "wpkh": {
      const k = resolveKey(node.key, index);
      const p33 = xonlyTo33(k.xonly, node.key, index);
      return concat(Uint8Array.from([0x00]), push(ripemd160(sha256(p33))));
    }
    case "sh": {
      const redeem = buildRedeem(node.script, index);
      return concat(Uint8Array.from([OP.HASH160]), push(ripemd160(sha256(redeem))), Uint8Array.from([OP.EQUAL]));
    }
    case "wsh": {
      const witnessScript = buildRedeem(node.script, index);
      return concat(Uint8Array.from([0x00]), push(sha256(witnessScript)));
    }
    case "multi":
    case "sortedmulti": {
      const keys = node.keys.map((k) => xonlyTo33(resolveKey(k, index).xonly, k));
      if (node.k < 1 || node.k > keys.length || keys.length > 20) throw new DescError("multi k/n out of range");
      const sorted = node.sorted ? [...keys].sort((a, b) => (bytesToHex(a) < bytesToHex(b) ? -1 : 1)) : keys;
      return concat(push(scriptNum(node.k)), ...sorted.map((p) => push(p)),
        push(scriptNum(sorted.length)), Uint8Array.from([OP.CHECKMULTISIG]));
    }
    case "combo": {
      // combo() is an alias; expose the four scripts honestly.
      const inner = { kind: "pk", key: node.key };
      return {
        combo: true,
        scripts: [
          ["pk", buildTopScript(inner, index)],
          ["pkh", buildTopScript({ kind: "pkh", key: node.key }, index)],
          ["wpkh", buildTopScript({ kind: "wpkh", key: node.key }, index)],
          ["sh(wpkh)", buildTopScript({ kind: "sh", script: { kind: "wpkh", key: node.key } }, index)],
        ],
      };
    }
    case "raw": return hexToBytes(node.hex);
    default: throw new DescError(`no top-level script for '${node.kind}'`);
  }
}

/** Recover a 33-byte compressed pubkey from an x-only key for legacy scripts. */
function xonlyTo33(xonly, keyExpr, index = 0) {
  // x-only alone is ambiguous about parity. For legacy script types we need
  // the full key: if the original key material had it, use it.
  const kd = keyExpr && keyExpr.key;
  if (kd && kd.type === "pubkey33") return hexToBytes(kd.hex);
  if (kd && kd.type === "pubkey65") {
    const P = secp256k1.ProjectivePoint.fromHex(hexToBytes(kd.hex));
    const aff = P.toAffine();
    const out = new Uint8Array(33);
    out[0] = aff.y & 1n ? 0x03 : 0x02;
    out.set(xonly, 1);
    return out;
  }
  if (kd && (kd.type === "xpub" || kd.type === "xprv" || kd.type === "wif" || kd.type === "xonly_or_priv")) {
    const full = resolveFull33(keyExpr, index);
    if (full) return full;
  }
  // Last resort: even-y assumption, labeled honestly by the caller.
  const out = new Uint8Array(33);
  out[0] = 0x02;
  out.set(xonly, 1);
  return out;
}

function resolveFull33(expr, index = 0) {
  try {
    const { key } = expr;
    if (key.type === "xpub" || key.type === "xprv") {
      let node = key.hd;
      for (const s of expr.path) node = node.deriveChild(s.hardened ? s.index + 0x80000000 : s.index);
      if (expr.wildcard) {
        node = node.deriveChild(index);
        if (!node || !node.publicKey) return null;
        return Uint8Array.from(node.publicKey);
      }
      return node.publicKey ? Uint8Array.from(node.publicKey) : null;
    }
    if (key.type === "wif") {
      return Uint8Array.from(secp256k1.getPublicKey(wifToPriv(key.wif))); // 33-byte compressed
    }
  } catch { /* fall through */ }
  return null;
}

function buildRedeem(node, index) {
  if (node.kind === "pk" || node.kind === "pkh" || node.kind === "wpkh" ||
      node.kind === "multi" || node.kind === "sortedmulti" || node.kind === "raw") {
    const s = buildTopScript(node, index);
    if (s && s.combo) throw new DescError("combo() cannot nest");
    return s;
  }
  if (node.kind === "wsh") return buildRedeem(node.script, index);
  if (node.kind === "sh") return buildRedeem(node.script, index);
  throw new DescError(`cannot use '${node.kind}' as a redeem/witness script`);
}

// ---------------------------------------------------------------------------
// Taproot tree (Core-style: leaves combine pairwise, left to right) + tweaks
// ---------------------------------------------------------------------------

export const TAPLEAF_VERSION = 0xc0;

function tapBranch(a, b) {
  const [x, y] = bytesToHex(a) <= bytesToHex(b) ? [a, b] : [b, a];
  return taggedHash("TapBranch", Uint8Array.from([...x, ...y]));
}

/**
 * Build a Core-style taptree from leaf scripts.
 * Returns { root, leaves: [{ script, leafHash, controlBlock }] } or null when
 * there are no scripts (key-only).
 */
export function buildTaptree(internalXOnly, leafScripts) {
  if (leafScripts.length === 0) return null;
  for (const s of leafScripts) {
    if (s.length > 10000) throw new DescError("tapscript leaf exceeds 10,000 bytes");
  }
  // Tree nodes: { hash, leafIndex|null, left, right }. Leaves pair up
  // left-to-right; an odd trailing node moves up alone (Core's algorithm).
  let level = leafScripts.map((script, i) => ({
    hash: tapLeafHash(script), leafIndex: i, left: null, right: null, script,
  }));
  let depth = 0;
  while (level.length > 1) {
    if (++depth > 128) throw new DescError("taptree too deep");
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 === level.length) { next.push(level[i]); continue; }
      const left = level[i], right = level[i + 1];
      next.push({ hash: tapBranch(left.hash, right.hash), leafIndex: null, left, right, script: null });
    }
    level = next;
  }
  const root = level[0];
  const leaves = leafScripts.map((script, i) => {
    // Walk from root to this leaf, collecting siblings.
    const path = [];
    const find = (node) => {
      if (node.leafIndex === i) return true;
      if (node.left && find(node.left)) { path.push(node.right.hash); return true; }
      if (node.right && find(node.right)) { path.push(node.left.hash); return true; }
      return false;
    };
    if (!find(root)) throw new DescError("taptree internal error");
    return { script, leafHash: tapLeafHash(script), path };
  });
  // Control blocks need the tweaked-key parity, computed below by the caller.
  return { root: root.hash, leaves, _root: root };
}

export function taprootTweak(internalXOnly, merkleRoot) {
  if (internalXOnly.length !== 32) throw new DescError("internal key must be 32 bytes");
  const preimage = merkleRoot && merkleRoot.length
    ? Uint8Array.from([...internalXOnly, ...merkleRoot])
    : internalXOnly;
  const t = taggedHash("TapTweak", preimage);
  const P = liftX(internalXOnly);
  const Q = P.add(secp256k1.ProjectivePoint.BASE.multiply(bytesToNum(t)));
  const aff = Q.toAffine();
  return {
    tweak: t,
    tweakedX: schnorr.utils.pointToBytes(Q),
    parity: (aff.y & 1n) === 1n ? 1 : 0,
    merkleRoot: merkleRoot && merkleRoot.length ? merkleRoot : null,
  };
}

export function controlBlock(internalXOnly, parity, path) {
  return Uint8Array.from([TAPLEAF_VERSION | parity, ...internalXOnly, ...path.flatMap((h) => [...h])]);
}

function collectKeys(node, out) {
  if (!node || typeof node !== "object") return;
  if (node.kind === "key") { out.push(node); return; }
  for (const v of Object.values(node)) {
    if (Array.isArray(v)) v.forEach((x) => collectKeys(x, out));
    else collectKeys(v, out);
  }
}

/** Flat array of every key expression in a descriptor AST (stable UI shape). */
export function listKeys(input) {
  const ast = typeof input === "string" ? parseDescriptor(input) : input;
  const out = [];
  collectKeys(ast, out);
  return out.map((k) => ({
    origin: k.origin, path: k.path, multipath: k.multipath, wildcard: k.wildcard,
    text: k.text, kind: k.key.type, label: keyKindLabel(k.key),
  }));
}

/** True when any key expression uses BIP-389 multipath <a;b>. */
export function hasMultipath(input) {
  return listKeys(input).some((k) => k.multipath && k.multipath.length > 0);
}

/**
 * Enforce BIP-386 range discipline: every wildcard in the descriptor steps
 * together at one shared index. Multipath <a;b> must be expanded first via
 * expandDescriptorMultipath() — mixing raw multipath into derivation is
 * refused loudly rather than guessed.
 */
export function validateRanges(ast) {
  const keyExprs = [];
  collectKeys(ast, keyExprs);
  const ranged = keyExprs.filter((k) => k.wildcard);
  const multipathed = keyExprs.filter((k) => k.multipath);
  if (multipathed.length > 0) {
    throw new DescError(
      "multipath <a;b> keys must be expanded first — call expandDescriptorMultipath() to get one descriptor per branch"
    );
  }
  return { ranged: ranged.length, total: keyExprs.length };
}

/** Expand every multipath key into per-branch descriptors (BIP-389).
 *  Done textually: each <a;b;...> span is replaced by its b-th option, in
 *  order, so every branch stays a parseable descriptor. All multipath spans
 *  must offer the same number of options (BIP-389 rule). */
export function expandDescriptorMultipath(input) {
  const check = descCheckChecksum(String(input).trim(), { require: false });
  const body = check.body;
  const spans = [...body.matchAll(/<[^<>]*>/g)];
  if (spans.length === 0) return [check.checksum ? body + "#" + check.checksum : body];
  const options = spans.map((m) => m[0].slice(1, -1).split(";"));
  const n = options[0].length;
  if (!options.every((o) => o.length === n)) {
    throw new DescError("multipath branches must all have the same number of paths");
  }
  if (n < 2) throw new DescError("multipath <> needs at least two paths");
  const out = [];
  for (let b = 0; b < n; b++) {
    let bi = 0;
    const expanded = body.replace(/<[^<>]*>/g, () => "/" + options[bi++][b].replace(/^\//, ""));
    parseDescriptor(expanded); // validate that the expansion parses cleanly
    out.push(expanded);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Derivation — descriptor string -> addresses / scripts at index i
// ---------------------------------------------------------------------------

export const PEARL_HRPS = { mainnet: "prl", testnet: "tprl", regtest: "prlrt" };

/**
 * Derive everything for one descriptor at one index.
 * Returns a rich result object; throws DescError on any rule violation.
 */
export function deriveDescriptor(input, { hrp = "prl", index = 0 } = {}) {
  const ast = typeof input === "string" ? parseDescriptor(input) : input;
  validateRanges(ast);
  const i = index;
  switch (ast.kind) {
    case "tr": {
      const internal = resolveKey(ast.key, i).xonly;
      // Expand multipath script args? Scripts don't take multipath in Core;
      // keys inside scripts may each be multipath — expand per branch is out
      // of scope: we refuse mixed multipath loudly (validateRanges).
      const leafScripts = ast.scripts.map((s) => buildTapscript(s, i));
      const tree = buildTaptree(internal, leafScripts);
      const tw = taprootTweak(internal, tree ? tree.root : null);
      const leaves = tree ? tree.leaves.map((l) => ({
        scriptHex: bytesToHex(l.script),
        leafHash: bytesToHex(tapLeafHash(l.script)),
        controlBlock: bytesToHex(controlBlock(internal, tw.parity, l.path)),
      })) : [];
      return {
        kind: "tr", hrp, index: i,
        internalXOnly: bytesToHex(internal),
        tweakedXOnly: bytesToHex(tw.tweakedX),
        merkleRoot: tw.merkleRoot ? bytesToHex(tw.merkleRoot) : null,
        scriptPath: leafScripts.length > 0,
        address: encodeBech32m(hrp, 1, tw.tweakedX),
        spk: bytesToHex(Uint8Array.from([0x51, 0x20, ...tw.tweakedX])),
        leaves,
        pearlSpendable: true,
      };
    }
    case "addr": {
      const info = decodeAddressAny(ast.address);
      return {
        kind: "addr", hrp, index: i, address: ast.address,
        spk: info.spk, witness: info.witness,
        pearlSpendable: info.hrp === hrp,
        note: info.hrp === hrp ? "address as given" : `address is for hrp '${info.hrp}', not '${hrp}'`,
      };
    }
    case "raw": {
      const bytes = hexToBytes(ast.hex);
      return { kind: "raw", hrp, index: i, spk: bytesToHex(bytes), pearlSpendable: false, note: "raw script — no address" };
    }
    default: {
      const built = buildTopScript(ast, i);
      if (built && built.combo) {
        return {
          kind: "combo", hrp, index: i, pearlSpendable: false,
          note: "combo() is not a Pearl script type — the four scripts are shown for reference",
          scripts: built.scripts.map(([name, bytes]) => ({ name, spk: bytesToHex(bytes) })),
        };
      }
      return {
        kind: ast.kind, hrp, index: i,
        spk: bytesToHex(built),
        pearlSpendable: false,
        note: `${ast.kind}() is not a Taproot script type — shown for reference; Pearl needs tr() or addr()`,
      };
    }
  }
}

function decodeAddressAny(address) {
  // Pearl is Taproot-only, so decodeBech32m's v1-only rule is exactly right.
  let dec;
  try {
    dec = decodeBech32m(address);
  } catch (e) {
    throw new DescError("addr() is not a valid Taproot bech32m address: " + e.message);
  }
  const spk = Uint8Array.from([0x51, 0x20, ...dec.program]);
  return { hrp: dec.hrp, spk: bytesToHex(spk), witness: { version: dec.version, program: bytesToHex(dec.program) } };
}

// ---------------------------------------------------------------------------
// Canonical rendering + human description
// ---------------------------------------------------------------------------

function renderKey(k) {
  let s = "";
  if (k.origin) {
    s += "[" + k.origin.fingerprint + k.origin.path.map((st) => "/" + st.index + (st.hardened ? "h" : "")).join("") + "]";
  }
  s += keyDataText(k.key);
  if (k.multipath) s += "<" + k.multipath.map((b) => b.map((st) => st.index + (st.hardened ? "h" : "")).join("/")).join(";") + ">";
  else if (k.path.length) s += k.path.map((st) => "/" + st.index + (st.hardened ? "h" : "")).join("");
  if (k.wildcard) s += "/*";
  return s;
}
function keyDataText(kd) {
  if (kd.type === "wif") return kd.wif;
  if (kd.type === "xpub" || kd.type === "xprv") return kd.text;
  return kd.hex;
}
function renderNode(node) {
  switch (node.kind) {
    case "pk": case "pkh": case "wpkh": case "combo":
      return `${node.kind}(${renderKey(node.key)})`;
    case "sh": case "wsh": return `${node.kind}(${renderNode(node.script)})`;
    case "tr": return `tr(${renderKey(node.key)}${node.scripts.map((s) => "," + renderNode(s)).join("")})`;
    case "multi": case "sortedmulti":
      return `${node.kind}(${node.k},${node.keys.map(renderKey).join(",")})`;
    case "multi_a": return `multi_a(${node.k},${node.keys.map(renderKey).join(",")})`;
    case "addr": return `addr(${node.address})`;
    case "raw": return `raw(${node.hex})`;
    case "frag": {
      const f = node.frag;
      if (f === "pk" || f === "pk_k" || f === "pk_h") return `${f}(${renderKey(node.key)})`;
      if (f === "older" || f === "after") return `${f}(${node.n})`;
      if (["sha256", "hash256", "ripemd160", "hash160"].includes(f)) return `${f}(${node.h})`;
      if (f === "thresh") return `thresh(${node.k},${node.subs.map(renderNode).join(",")})`;
      if (f === "and_v" || f === "or_c" || f === "or_d" || f === "or_i") {
        return `${f}(${renderNode(node.x)},${renderNode(node.y ?? node.z)})`;
      }
      if (f === "and_b") return `and_b(${renderNode(node.k)},${renderNode(node.x)},${renderNode(node.y)})`;
      if (f === "andor") return `andor(${renderNode(node.x)},${renderNode(node.y)},${renderNode(node.z)})`;
      if (f === "or_b") return `or_b(${renderNode(node.x)},${renderNode(node.z)},${renderNode(node.w)})`;
      return `${f}(?)`;
    }
    default: return "?";
  }
}

/** Canonical body (no checksum) re-rendered from the AST. */
export function canonicalBody(input) {
  const ast = typeof input === "string" ? parseDescriptor(input) : input;
  return renderNode(ast);
}

/** Human-readable summary lines for the Analyze tab. */
export function describe(input) {
  const ast = typeof input === "string" ? parseDescriptor(input) : input;
  const lines = [];
  const keyExprs = [];
  collectKeys(ast, keyExprs);
  const typeName = {
    pk: "P2PK · pay to public key", pkh: "P2PKH · pay to pubkey hash",
    wpkh: "P2WPKH · native segwit v0", sh: "P2SH · script hash",
    wsh: "P2WSH · native segwit v0 script", tr: "P2TR · Taproot (Pearl-native)",
    multi: "bare multisig (CHECKMULTISIG)", sortedmulti: "sorted bare multisig",
    multi_a: "Taproot multisig (CHECKSIGADD)", combo: "combo alias (4 scripts)",
    addr: "fixed address", raw: "raw script",
  };
  lines.push({ k: "Type", v: typeName[ast.kind] || ast.kind });
  if (ast.kind === "tr") {
    lines.push({ k: "Spending paths", v: ast.scripts.length === 0
      ? "key path only — the internal key alone can spend"
      : `key path + ${ast.scripts.length} script ${ast.scripts.length === 1 ? "leaf" : "leaves"}` });
  }
  if (ast.kind === "multi" || ast.kind === "sortedmulti" || ast.kind === "multi_a") {
    lines.push({ k: "Quorum", v: `${ast.k}-of-${ast.n}` });
  }
  lines.push({ k: "Keys", v: String(keyExprs.length) });
  keyExprs.forEach((k, i) => {
    const bits = [];
    if (k.origin) bits.push(`origin ${k.origin.fingerprint}${k.origin.path.map((s) => "/" + s.index + (s.hardened ? "h" : "")).join("")}`);
    bits.push(keyKindLabel(k.key));
    if (k.path.length) bits.push("path " + k.path.map((s) => (s.hardened ? s.index + "h" : s.index)).join("/"));
    if (k.multipath) bits.push(`multipath ×${k.multipath.length}`);
    if (k.wildcard) bits.push("ranged *");
    lines.push({ k: `Key ${i + 1}`, v: bits.join(" · ") });
  });
  if (ast.checksum) lines.push({ k: "Checksum", v: "#" + ast.checksum + " (valid BIP-380)" });
  else lines.push({ k: "Checksum", v: "none — add one before sharing" });
  return lines;
}

function keyKindLabel(kd) {
  switch (kd.type) {
    case "xpub": return "extended public key";
    case "xprv": return "extended PRIVATE key — handle with care";
    case "wif": return "WIF private key — handle with care";
    case "xonly_or_priv": return "32-byte hex (x-only pubkey or private key)";
    case "pubkey33": return "33-byte compressed pubkey";
    case "pubkey65": return "65-byte uncompressed pubkey";
    default: return kd.type;
  }
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export const TEMPLATES = [
  {
    name: "BIP-86 single-sig (receive)",
    desc: "The standard Pearl wallet layout: one account xpub, external chain.",
    body: "tr([fingerprint/86h/coin_typeh/0h]xpub…/0/*)",
  },
  {
    name: "BIP-86 single-sig (change)",
    desc: "Internal chain of the same account — paste the same xpub.",
    body: "tr([fingerprint/86h/coin_typeh/0h]xpub…/1/*)",
  },
  {
    name: "2-of-3 Taproot multisig",
    desc: "Three cosigner xpubs, any two can spend via the multi_a leaf.",
    body: "tr(xpubA/0/*,multi_a(2,xpubA/0/*,xpubB/0/*,xpubC/0/*))",
  },
  {
    name: "Timelocked vault leaf",
    desc: "Owner key path + a CSV-delayed recovery leaf for a second key.",
    body: "tr(xpubOwner/0/*,and_v(pk(xpubRecovery/0/*),older(52560)))",
  },
  {
    name: "Hash-locked claim leaf",
    desc: "Claim with preimage + key, or the owner alone after a timeout.",
    body: "tr(xpubOwner/0/*,or_d(pk(xpubOwner/0/*),and_v(pk(xpubClaim/0/*),sha256(ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff))))",
  },
];
