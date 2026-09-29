/* Pearl Swap bundle (window.PearlSwap) — built with esbuild from src/index.js. Do not edit by hand; run `node build.mjs`. */
var PearlSwap = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod2) => __copyProps(__defProp({}, "__esModule", { value: true }), mod2);

  // src/index.js
  var index_exports = {};
  __export(index_exports, {
    BTC_BLOCK_SECS: () => BTC_BLOCK_SECS,
    DESCRIPTOR_PREFIX: () => DESCRIPTOR_PREFIX,
    DUST_GRAIN: () => DUST_GRAIN,
    GRAIN_PER_PRL: () => GRAIN_PER_PRL,
    MIN_T1_T2_GAP: () => MIN_T1_T2_GAP,
    MIN_TIP_CLEARANCE: () => MIN_TIP_CLEARANCE,
    NETWORKS: () => NETWORKS,
    PEARL_BLOCK_SECS: () => PEARL_BLOCK_SECS,
    PREIMAGE_LEN: () => PREIMAGE_LEN,
    REFUND_SEQUENCE: () => REFUND_SEQUENCE,
    SWAP_KIND: () => SWAP_KIND,
    SWAP_VERSION: () => SWAP_VERSION,
    addressToProgram: () => addressToProgram,
    broadcastTx: () => broadcastTx,
    btcMirrorTemplate: () => btcMirrorTemplate,
    buildClaimScript: () => buildClaimScript,
    buildClaimSpend: () => buildClaimSpend,
    buildKeypathTx: () => buildKeypathTx,
    buildLockTx: () => buildLockTx,
    buildRefundScript: () => buildRefundScript,
    buildRefundSpend: () => buildRefundSpend,
    buildScriptPathSpend: () => buildScriptPathSpend,
    bytesToHex: () => bytesToHex,
    claimSpendVBytes: () => claimSpendVBytes,
    classifySwapState: () => classifySwapState,
    convertBits: () => convertBits,
    dblSha: () => dblSha,
    decodeBech32m: () => decodeBech32m,
    describeSwap: () => describeSwap,
    encodeBech32m: () => encodeBech32m,
    encodeScriptNum: () => encodeScriptNum,
    extractPreimage: () => extractPreimage,
    fetchFeeRateGrainsPerVByte: () => fetchFeeRateGrainsPerVByte,
    fetchTxStatus: () => fetchTxStatus,
    fetchUtxos: () => fetchUtxos,
    funderKeyFromInput: () => funderKeyFromInput,
    funderSpkHex: () => funderSpkHex,
    generatePreimage: () => generatePreimage,
    hexToBytes: () => hexToBytes,
    keypathSigDigestEx: () => keypathSigDigestEx,
    keypathTxVBytes: () => keypathTxVBytes,
    newMnemonic: () => newMnemonic,
    numsInternalKey: () => numsInternalKey,
    p2trScriptPubKey: () => p2trScriptPubKey,
    parseDescriptor: () => parseDescriptor,
    parsePreimage: () => parsePreimage,
    parseSwapSpec: () => parseSwapSpec,
    parseTx: () => parseTx,
    parseXOnlyKey: () => parseXOnlyKey,
    partyKeyFromInput: () => partyKeyFromInput,
    proposeSwap: () => proposeSwap,
    pubkeyFromPriv: () => pubkeyFromPriv,
    refundSpendVBytes: () => refundSpendVBytes,
    schnorr: () => schnorr,
    scriptPathSigDigestEx: () => scriptPathSigDigestEx,
    secretHashOf: () => secretHashOf,
    serializeSwap: () => serializeSwap,
    sha256: () => sha2562,
    signForXOnly: () => signForXOnly,
    swapCountdown: () => swapCountdown,
    swapDescriptor: () => swapDescriptor,
    swapScriptAsm: () => swapScriptAsm,
    swapTaptree: () => swapTaptree,
    tweakKeypath: () => tweakKeypath,
    txidLE: () => txidLE,
    verifySchnorrSig: () => verifySchnorrSig,
    verifySwapControlBlock: () => verifySwapControlBlock,
    walletFromMnemonic: () => walletFromMnemonic,
    walletFromPriv: () => walletFromPriv,
    walletFromWIF: () => walletFromWIF,
    walletToWIF: () => walletToWIF
  });

  // ../sign/lib/noble-hashes/crypto.js
  var crypto = typeof globalThis === "object" && "crypto" in globalThis ? globalThis.crypto : void 0;

  // ../sign/lib/noble-hashes/utils.js
  function isBytes(a) {
    return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array";
  }
  function anumber(n) {
    if (!Number.isSafeInteger(n) || n < 0)
      throw new Error("positive integer expected, got " + n);
  }
  function abytes(b, ...lengths) {
    if (!isBytes(b))
      throw new Error("Uint8Array expected");
    if (lengths.length > 0 && !lengths.includes(b.length))
      throw new Error("Uint8Array expected of length " + lengths + ", got length=" + b.length);
  }
  function ahash(h) {
    if (typeof h !== "function" || typeof h.create !== "function")
      throw new Error("Hash should be wrapped by utils.createHasher");
    anumber(h.outputLen);
    anumber(h.blockLen);
  }
  function aexists(instance, checkFinished = true) {
    if (instance.destroyed)
      throw new Error("Hash instance has been destroyed");
    if (checkFinished && instance.finished)
      throw new Error("Hash#digest() has already been called");
  }
  function aoutput(out, instance) {
    abytes(out);
    const min = instance.outputLen;
    if (out.length < min) {
      throw new Error("digestInto() expects output buffer of length at least " + min);
    }
  }
  function clean(...arrays) {
    for (let i = 0; i < arrays.length; i++) {
      arrays[i].fill(0);
    }
  }
  function createView(arr) {
    return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
  }
  function rotr(word, shift) {
    return word << 32 - shift | word >>> shift;
  }
  function rotl(word, shift) {
    return word << shift | word >>> 32 - shift >>> 0;
  }
  var hasHexBuiltin = /* @__PURE__ */ (() => (
    // @ts-ignore
    typeof Uint8Array.from([]).toHex === "function" && typeof Uint8Array.fromHex === "function"
  ))();
  var hexes = /* @__PURE__ */ Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
  function bytesToHex(bytes) {
    abytes(bytes);
    if (hasHexBuiltin)
      return bytes.toHex();
    let hex = "";
    for (let i = 0; i < bytes.length; i++) {
      hex += hexes[bytes[i]];
    }
    return hex;
  }
  var asciis = { _0: 48, _9: 57, A: 65, F: 70, a: 97, f: 102 };
  function asciiToBase16(ch) {
    if (ch >= asciis._0 && ch <= asciis._9)
      return ch - asciis._0;
    if (ch >= asciis.A && ch <= asciis.F)
      return ch - (asciis.A - 10);
    if (ch >= asciis.a && ch <= asciis.f)
      return ch - (asciis.a - 10);
    return;
  }
  function hexToBytes(hex) {
    if (typeof hex !== "string")
      throw new Error("hex string expected, got " + typeof hex);
    if (hasHexBuiltin)
      return Uint8Array.fromHex(hex);
    const hl = hex.length;
    const al = hl / 2;
    if (hl % 2)
      throw new Error("hex string expected, got unpadded hex of length " + hl);
    const array = new Uint8Array(al);
    for (let ai = 0, hi = 0; ai < al; ai++, hi += 2) {
      const n1 = asciiToBase16(hex.charCodeAt(hi));
      const n2 = asciiToBase16(hex.charCodeAt(hi + 1));
      if (n1 === void 0 || n2 === void 0) {
        const char = hex[hi] + hex[hi + 1];
        throw new Error('hex string expected, got non-hex character "' + char + '" at index ' + hi);
      }
      array[ai] = n1 * 16 + n2;
    }
    return array;
  }
  function utf8ToBytes(str) {
    if (typeof str !== "string")
      throw new Error("string expected");
    return new Uint8Array(new TextEncoder().encode(str));
  }
  function toBytes(data) {
    if (typeof data === "string")
      data = utf8ToBytes(data);
    abytes(data);
    return data;
  }
  function kdfInputToBytes(data) {
    if (typeof data === "string")
      data = utf8ToBytes(data);
    abytes(data);
    return data;
  }
  function concatBytes(...arrays) {
    let sum = 0;
    for (let i = 0; i < arrays.length; i++) {
      const a = arrays[i];
      abytes(a);
      sum += a.length;
    }
    const res = new Uint8Array(sum);
    for (let i = 0, pad = 0; i < arrays.length; i++) {
      const a = arrays[i];
      res.set(a, pad);
      pad += a.length;
    }
    return res;
  }
  function checkOpts(defaults, opts) {
    if (opts !== void 0 && {}.toString.call(opts) !== "[object Object]")
      throw new Error("options should be object or undefined");
    const merged = Object.assign(defaults, opts);
    return merged;
  }
  var Hash = class {
  };
  function createHasher(hashCons) {
    const hashC = (msg) => hashCons().update(toBytes(msg)).digest();
    const tmp = hashCons();
    hashC.outputLen = tmp.outputLen;
    hashC.blockLen = tmp.blockLen;
    hashC.create = () => hashCons();
    return hashC;
  }
  function randomBytes(bytesLength = 32) {
    if (crypto && typeof crypto.getRandomValues === "function") {
      return crypto.getRandomValues(new Uint8Array(bytesLength));
    }
    if (crypto && typeof crypto.randomBytes === "function") {
      return Uint8Array.from(crypto.randomBytes(bytesLength));
    }
    throw new Error("crypto.getRandomValues must be defined");
  }

  // ../sign/lib/noble-curves/utils.js
  var _0n = /* @__PURE__ */ BigInt(0);
  var _1n = /* @__PURE__ */ BigInt(1);
  function _abool2(value, title = "") {
    if (typeof value !== "boolean") {
      const prefix = title && `"${title}"`;
      throw new Error(prefix + "expected boolean, got type=" + typeof value);
    }
    return value;
  }
  function _abytes2(value, length, title = "") {
    const bytes = isBytes(value);
    const len = value?.length;
    const needsLen = length !== void 0;
    if (!bytes || needsLen && len !== length) {
      const prefix = title && `"${title}" `;
      const ofLen = needsLen ? ` of length ${length}` : "";
      const got = bytes ? `length=${len}` : `type=${typeof value}`;
      throw new Error(prefix + "expected Uint8Array" + ofLen + ", got " + got);
    }
    return value;
  }
  function numberToHexUnpadded(num2) {
    const hex = num2.toString(16);
    return hex.length & 1 ? "0" + hex : hex;
  }
  function hexToNumber(hex) {
    if (typeof hex !== "string")
      throw new Error("hex string expected, got " + typeof hex);
    return hex === "" ? _0n : BigInt("0x" + hex);
  }
  function bytesToNumberBE(bytes) {
    return hexToNumber(bytesToHex(bytes));
  }
  function bytesToNumberLE(bytes) {
    abytes(bytes);
    return hexToNumber(bytesToHex(Uint8Array.from(bytes).reverse()));
  }
  function numberToBytesBE(n, len) {
    return hexToBytes(n.toString(16).padStart(len * 2, "0"));
  }
  function numberToBytesLE(n, len) {
    return numberToBytesBE(n, len).reverse();
  }
  function ensureBytes(title, hex, expectedLength) {
    let res;
    if (typeof hex === "string") {
      try {
        res = hexToBytes(hex);
      } catch (e) {
        throw new Error(title + " must be hex string or Uint8Array, cause: " + e);
      }
    } else if (isBytes(hex)) {
      res = Uint8Array.from(hex);
    } else {
      throw new Error(title + " must be hex string or Uint8Array");
    }
    const len = res.length;
    if (typeof expectedLength === "number" && len !== expectedLength)
      throw new Error(title + " of length " + expectedLength + " expected, got " + len);
    return res;
  }
  var isPosBig = (n) => typeof n === "bigint" && _0n <= n;
  function inRange(n, min, max) {
    return isPosBig(n) && isPosBig(min) && isPosBig(max) && min <= n && n < max;
  }
  function aInRange(title, n, min, max) {
    if (!inRange(n, min, max))
      throw new Error("expected valid " + title + ": " + min + " <= n < " + max + ", got " + n);
  }
  function bitLen(n) {
    let len;
    for (len = 0; n > _0n; n >>= _1n, len += 1)
      ;
    return len;
  }
  var bitMask = (n) => (_1n << BigInt(n)) - _1n;
  function createHmacDrbg(hashLen, qByteLen, hmacFn) {
    if (typeof hashLen !== "number" || hashLen < 2)
      throw new Error("hashLen must be a number");
    if (typeof qByteLen !== "number" || qByteLen < 2)
      throw new Error("qByteLen must be a number");
    if (typeof hmacFn !== "function")
      throw new Error("hmacFn must be a function");
    const u8n = (len) => new Uint8Array(len);
    const u8of = (byte) => Uint8Array.of(byte);
    let v = u8n(hashLen);
    let k = u8n(hashLen);
    let i = 0;
    const reset = () => {
      v.fill(1);
      k.fill(0);
      i = 0;
    };
    const h = (...b) => hmacFn(k, v, ...b);
    const reseed = (seed = u8n(0)) => {
      k = h(u8of(0), seed);
      v = h();
      if (seed.length === 0)
        return;
      k = h(u8of(1), seed);
      v = h();
    };
    const gen = () => {
      if (i++ >= 1e3)
        throw new Error("drbg: tried 1000 values");
      let len = 0;
      const out = [];
      while (len < qByteLen) {
        v = h();
        const sl = v.slice();
        out.push(sl);
        len += v.length;
      }
      return concatBytes(...out);
    };
    const genUntil = (seed, pred) => {
      reset();
      reseed(seed);
      let res = void 0;
      while (!(res = pred(gen())))
        reseed();
      reset();
      return res;
    };
    return genUntil;
  }
  function _validateObject(object, fields, optFields = {}) {
    if (!object || typeof object !== "object")
      throw new Error("expected valid options object");
    function checkField(fieldName, expectedType, isOpt) {
      const val = object[fieldName];
      if (isOpt && val === void 0)
        return;
      const current = typeof val;
      if (current !== expectedType || val === null)
        throw new Error(`param "${fieldName}" is invalid: expected ${expectedType}, got ${current}`);
    }
    Object.entries(fields).forEach(([k, v]) => checkField(k, v, false));
    Object.entries(optFields).forEach(([k, v]) => checkField(k, v, true));
  }
  function memoized(fn) {
    const map = /* @__PURE__ */ new WeakMap();
    return (arg, ...args) => {
      const val = map.get(arg);
      if (val !== void 0)
        return val;
      const computed = fn(arg, ...args);
      map.set(arg, computed);
      return computed;
    };
  }

  // ../sign/lib/noble-curves/abstract/modular.js
  var _0n2 = BigInt(0);
  var _1n2 = BigInt(1);
  var _2n = /* @__PURE__ */ BigInt(2);
  var _3n = /* @__PURE__ */ BigInt(3);
  var _4n = /* @__PURE__ */ BigInt(4);
  var _5n = /* @__PURE__ */ BigInt(5);
  var _7n = /* @__PURE__ */ BigInt(7);
  var _8n = /* @__PURE__ */ BigInt(8);
  var _9n = /* @__PURE__ */ BigInt(9);
  var _16n = /* @__PURE__ */ BigInt(16);
  function mod(a, b) {
    const result = a % b;
    return result >= _0n2 ? result : b + result;
  }
  function pow2(x, power, modulo) {
    let res = x;
    while (power-- > _0n2) {
      res *= res;
      res %= modulo;
    }
    return res;
  }
  function invert(number, modulo) {
    if (number === _0n2)
      throw new Error("invert: expected non-zero number");
    if (modulo <= _0n2)
      throw new Error("invert: expected positive modulus, got " + modulo);
    let a = mod(number, modulo);
    let b = modulo;
    let x = _0n2, y = _1n2, u = _1n2, v = _0n2;
    while (a !== _0n2) {
      const q = b / a;
      const r = b % a;
      const m = x - u * q;
      const n = y - v * q;
      b = a, a = r, x = u, y = v, u = m, v = n;
    }
    const gcd2 = b;
    if (gcd2 !== _1n2)
      throw new Error("invert: does not exist");
    return mod(x, modulo);
  }
  function assertIsSquare(Fp, root, n) {
    if (!Fp.eql(Fp.sqr(root), n))
      throw new Error("Cannot find square root");
  }
  function sqrt3mod4(Fp, n) {
    const p1div4 = (Fp.ORDER + _1n2) / _4n;
    const root = Fp.pow(n, p1div4);
    assertIsSquare(Fp, root, n);
    return root;
  }
  function sqrt5mod8(Fp, n) {
    const p5div8 = (Fp.ORDER - _5n) / _8n;
    const n2 = Fp.mul(n, _2n);
    const v = Fp.pow(n2, p5div8);
    const nv = Fp.mul(n, v);
    const i = Fp.mul(Fp.mul(nv, _2n), v);
    const root = Fp.mul(nv, Fp.sub(i, Fp.ONE));
    assertIsSquare(Fp, root, n);
    return root;
  }
  function sqrt9mod16(P) {
    const Fp_ = Field(P);
    const tn = tonelliShanks(P);
    const c1 = tn(Fp_, Fp_.neg(Fp_.ONE));
    const c2 = tn(Fp_, c1);
    const c3 = tn(Fp_, Fp_.neg(c1));
    const c4 = (P + _7n) / _16n;
    return (Fp, n) => {
      let tv1 = Fp.pow(n, c4);
      let tv2 = Fp.mul(tv1, c1);
      const tv3 = Fp.mul(tv1, c2);
      const tv4 = Fp.mul(tv1, c3);
      const e1 = Fp.eql(Fp.sqr(tv2), n);
      const e2 = Fp.eql(Fp.sqr(tv3), n);
      tv1 = Fp.cmov(tv1, tv2, e1);
      tv2 = Fp.cmov(tv4, tv3, e2);
      const e3 = Fp.eql(Fp.sqr(tv2), n);
      const root = Fp.cmov(tv1, tv2, e3);
      assertIsSquare(Fp, root, n);
      return root;
    };
  }
  function tonelliShanks(P) {
    if (P < _3n)
      throw new Error("sqrt is not defined for small field");
    let Q = P - _1n2;
    let S = 0;
    while (Q % _2n === _0n2) {
      Q /= _2n;
      S++;
    }
    let Z = _2n;
    const _Fp = Field(P);
    while (FpLegendre(_Fp, Z) === 1) {
      if (Z++ > 1e3)
        throw new Error("Cannot find square root: probably non-prime P");
    }
    if (S === 1)
      return sqrt3mod4;
    let cc = _Fp.pow(Z, Q);
    const Q1div2 = (Q + _1n2) / _2n;
    return function tonelliSlow(Fp, n) {
      if (Fp.is0(n))
        return n;
      if (FpLegendre(Fp, n) !== 1)
        throw new Error("Cannot find square root");
      let M = S;
      let c = Fp.mul(Fp.ONE, cc);
      let t = Fp.pow(n, Q);
      let R = Fp.pow(n, Q1div2);
      while (!Fp.eql(t, Fp.ONE)) {
        if (Fp.is0(t))
          return Fp.ZERO;
        let i = 1;
        let t_tmp = Fp.sqr(t);
        while (!Fp.eql(t_tmp, Fp.ONE)) {
          i++;
          t_tmp = Fp.sqr(t_tmp);
          if (i === M)
            throw new Error("Cannot find square root");
        }
        const exponent = _1n2 << BigInt(M - i - 1);
        const b = Fp.pow(c, exponent);
        M = i;
        c = Fp.sqr(b);
        t = Fp.mul(t, c);
        R = Fp.mul(R, b);
      }
      return R;
    };
  }
  function FpSqrt(P) {
    if (P % _4n === _3n)
      return sqrt3mod4;
    if (P % _8n === _5n)
      return sqrt5mod8;
    if (P % _16n === _9n)
      return sqrt9mod16(P);
    return tonelliShanks(P);
  }
  var FIELD_FIELDS = [
    "create",
    "isValid",
    "is0",
    "neg",
    "inv",
    "sqrt",
    "sqr",
    "eql",
    "add",
    "sub",
    "mul",
    "pow",
    "div",
    "addN",
    "subN",
    "mulN",
    "sqrN"
  ];
  function validateField(field) {
    const initial = {
      ORDER: "bigint",
      MASK: "bigint",
      BYTES: "number",
      BITS: "number"
    };
    const opts = FIELD_FIELDS.reduce((map, val) => {
      map[val] = "function";
      return map;
    }, initial);
    _validateObject(field, opts);
    return field;
  }
  function FpPow(Fp, num2, power) {
    if (power < _0n2)
      throw new Error("invalid exponent, negatives unsupported");
    if (power === _0n2)
      return Fp.ONE;
    if (power === _1n2)
      return num2;
    let p = Fp.ONE;
    let d = num2;
    while (power > _0n2) {
      if (power & _1n2)
        p = Fp.mul(p, d);
      d = Fp.sqr(d);
      power >>= _1n2;
    }
    return p;
  }
  function FpInvertBatch(Fp, nums, passZero = false) {
    const inverted = new Array(nums.length).fill(passZero ? Fp.ZERO : void 0);
    const multipliedAcc = nums.reduce((acc, num2, i) => {
      if (Fp.is0(num2))
        return acc;
      inverted[i] = acc;
      return Fp.mul(acc, num2);
    }, Fp.ONE);
    const invertedAcc = Fp.inv(multipliedAcc);
    nums.reduceRight((acc, num2, i) => {
      if (Fp.is0(num2))
        return acc;
      inverted[i] = Fp.mul(acc, inverted[i]);
      return Fp.mul(acc, num2);
    }, invertedAcc);
    return inverted;
  }
  function FpLegendre(Fp, n) {
    const p1mod2 = (Fp.ORDER - _1n2) / _2n;
    const powered = Fp.pow(n, p1mod2);
    const yes = Fp.eql(powered, Fp.ONE);
    const zero = Fp.eql(powered, Fp.ZERO);
    const no = Fp.eql(powered, Fp.neg(Fp.ONE));
    if (!yes && !zero && !no)
      throw new Error("invalid Legendre symbol result");
    return yes ? 1 : zero ? 0 : -1;
  }
  function nLength(n, nBitLength) {
    if (nBitLength !== void 0)
      anumber(nBitLength);
    const _nBitLength = nBitLength !== void 0 ? nBitLength : n.toString(2).length;
    const nByteLength = Math.ceil(_nBitLength / 8);
    return { nBitLength: _nBitLength, nByteLength };
  }
  function Field(ORDER, bitLenOrOpts, isLE = false, opts = {}) {
    if (ORDER <= _0n2)
      throw new Error("invalid field: expected ORDER > 0, got " + ORDER);
    let _nbitLength = void 0;
    let _sqrt = void 0;
    let modFromBytes = false;
    let allowedLengths = void 0;
    if (typeof bitLenOrOpts === "object" && bitLenOrOpts != null) {
      if (opts.sqrt || isLE)
        throw new Error("cannot specify opts in two arguments");
      const _opts = bitLenOrOpts;
      if (_opts.BITS)
        _nbitLength = _opts.BITS;
      if (_opts.sqrt)
        _sqrt = _opts.sqrt;
      if (typeof _opts.isLE === "boolean")
        isLE = _opts.isLE;
      if (typeof _opts.modFromBytes === "boolean")
        modFromBytes = _opts.modFromBytes;
      allowedLengths = _opts.allowedLengths;
    } else {
      if (typeof bitLenOrOpts === "number")
        _nbitLength = bitLenOrOpts;
      if (opts.sqrt)
        _sqrt = opts.sqrt;
    }
    const { nBitLength: BITS, nByteLength: BYTES } = nLength(ORDER, _nbitLength);
    if (BYTES > 2048)
      throw new Error("invalid field: expected ORDER of <= 2048 bytes");
    let sqrtP;
    const f = Object.freeze({
      ORDER,
      isLE,
      BITS,
      BYTES,
      MASK: bitMask(BITS),
      ZERO: _0n2,
      ONE: _1n2,
      allowedLengths,
      create: (num2) => mod(num2, ORDER),
      isValid: (num2) => {
        if (typeof num2 !== "bigint")
          throw new Error("invalid field element: expected bigint, got " + typeof num2);
        return _0n2 <= num2 && num2 < ORDER;
      },
      is0: (num2) => num2 === _0n2,
      // is valid and invertible
      isValidNot0: (num2) => !f.is0(num2) && f.isValid(num2),
      isOdd: (num2) => (num2 & _1n2) === _1n2,
      neg: (num2) => mod(-num2, ORDER),
      eql: (lhs, rhs) => lhs === rhs,
      sqr: (num2) => mod(num2 * num2, ORDER),
      add: (lhs, rhs) => mod(lhs + rhs, ORDER),
      sub: (lhs, rhs) => mod(lhs - rhs, ORDER),
      mul: (lhs, rhs) => mod(lhs * rhs, ORDER),
      pow: (num2, power) => FpPow(f, num2, power),
      div: (lhs, rhs) => mod(lhs * invert(rhs, ORDER), ORDER),
      // Same as above, but doesn't normalize
      sqrN: (num2) => num2 * num2,
      addN: (lhs, rhs) => lhs + rhs,
      subN: (lhs, rhs) => lhs - rhs,
      mulN: (lhs, rhs) => lhs * rhs,
      inv: (num2) => invert(num2, ORDER),
      sqrt: _sqrt || ((n) => {
        if (!sqrtP)
          sqrtP = FpSqrt(ORDER);
        return sqrtP(f, n);
      }),
      toBytes: (num2) => isLE ? numberToBytesLE(num2, BYTES) : numberToBytesBE(num2, BYTES),
      fromBytes: (bytes, skipValidation = true) => {
        if (allowedLengths) {
          if (!allowedLengths.includes(bytes.length) || bytes.length > BYTES) {
            throw new Error("Field.fromBytes: expected " + allowedLengths + " bytes, got " + bytes.length);
          }
          const padded = new Uint8Array(BYTES);
          padded.set(bytes, isLE ? 0 : padded.length - bytes.length);
          bytes = padded;
        }
        if (bytes.length !== BYTES)
          throw new Error("Field.fromBytes: expected " + BYTES + " bytes, got " + bytes.length);
        let scalar = isLE ? bytesToNumberLE(bytes) : bytesToNumberBE(bytes);
        if (modFromBytes)
          scalar = mod(scalar, ORDER);
        if (!skipValidation) {
          if (!f.isValid(scalar))
            throw new Error("invalid field element: outside of range 0..ORDER");
        }
        return scalar;
      },
      // TODO: we don't need it here, move out to separate fn
      invertBatch: (lst) => FpInvertBatch(f, lst),
      // We can't move this out because Fp6, Fp12 implement it
      // and it's unclear what to return in there.
      cmov: (a, b, c) => c ? b : a
    });
    return Object.freeze(f);
  }
  function getFieldBytesLength(fieldOrder) {
    if (typeof fieldOrder !== "bigint")
      throw new Error("field order must be bigint");
    const bitLength = fieldOrder.toString(2).length;
    return Math.ceil(bitLength / 8);
  }
  function getMinHashLength(fieldOrder) {
    const length = getFieldBytesLength(fieldOrder);
    return length + Math.ceil(length / 2);
  }
  function mapHashToField(key, fieldOrder, isLE = false) {
    const len = key.length;
    const fieldLen = getFieldBytesLength(fieldOrder);
    const minLen = getMinHashLength(fieldOrder);
    if (len < 16 || len < minLen || len > 1024)
      throw new Error("expected " + minLen + "-1024 bytes of input, got " + len);
    const num2 = isLE ? bytesToNumberLE(key) : bytesToNumberBE(key);
    const reduced = mod(num2, fieldOrder - _1n2) + _1n2;
    return isLE ? numberToBytesLE(reduced, fieldLen) : numberToBytesBE(reduced, fieldLen);
  }

  // ../sign/lib/noble-hashes/_md.js
  function setBigUint64(view, byteOffset, value, isLE) {
    if (typeof view.setBigUint64 === "function")
      return view.setBigUint64(byteOffset, value, isLE);
    const _32n2 = BigInt(32);
    const _u32_max = BigInt(4294967295);
    const wh = Number(value >> _32n2 & _u32_max);
    const wl = Number(value & _u32_max);
    const h = isLE ? 4 : 0;
    const l = isLE ? 0 : 4;
    view.setUint32(byteOffset + h, wh, isLE);
    view.setUint32(byteOffset + l, wl, isLE);
  }
  function Chi(a, b, c) {
    return a & b ^ ~a & c;
  }
  function Maj(a, b, c) {
    return a & b ^ a & c ^ b & c;
  }
  var HashMD = class extends Hash {
    constructor(blockLen, outputLen, padOffset, isLE) {
      super();
      this.finished = false;
      this.length = 0;
      this.pos = 0;
      this.destroyed = false;
      this.blockLen = blockLen;
      this.outputLen = outputLen;
      this.padOffset = padOffset;
      this.isLE = isLE;
      this.buffer = new Uint8Array(blockLen);
      this.view = createView(this.buffer);
    }
    update(data) {
      aexists(this);
      data = toBytes(data);
      abytes(data);
      const { view, buffer, blockLen } = this;
      const len = data.length;
      for (let pos = 0; pos < len; ) {
        const take = Math.min(blockLen - this.pos, len - pos);
        if (take === blockLen) {
          const dataView = createView(data);
          for (; blockLen <= len - pos; pos += blockLen)
            this.process(dataView, pos);
          continue;
        }
        buffer.set(data.subarray(pos, pos + take), this.pos);
        this.pos += take;
        pos += take;
        if (this.pos === blockLen) {
          this.process(view, 0);
          this.pos = 0;
        }
      }
      this.length += data.length;
      this.roundClean();
      return this;
    }
    digestInto(out) {
      aexists(this);
      aoutput(out, this);
      this.finished = true;
      const { buffer, view, blockLen, isLE } = this;
      let { pos } = this;
      buffer[pos++] = 128;
      clean(this.buffer.subarray(pos));
      if (this.padOffset > blockLen - pos) {
        this.process(view, 0);
        pos = 0;
      }
      for (let i = pos; i < blockLen; i++)
        buffer[i] = 0;
      setBigUint64(view, blockLen - 8, BigInt(this.length * 8), isLE);
      this.process(view, 0);
      const oview = createView(out);
      const len = this.outputLen;
      if (len % 4)
        throw new Error("_sha2: outputLen should be aligned to 32bit");
      const outLen = len / 4;
      const state = this.get();
      if (outLen > state.length)
        throw new Error("_sha2: outputLen bigger than state");
      for (let i = 0; i < outLen; i++)
        oview.setUint32(4 * i, state[i], isLE);
    }
    digest() {
      const { buffer, outputLen } = this;
      this.digestInto(buffer);
      const res = buffer.slice(0, outputLen);
      this.destroy();
      return res;
    }
    _cloneInto(to) {
      to || (to = new this.constructor());
      to.set(...this.get());
      const { blockLen, buffer, length, finished, destroyed, pos } = this;
      to.destroyed = destroyed;
      to.finished = finished;
      to.length = length;
      to.pos = pos;
      if (length % blockLen)
        to.buffer.set(buffer);
      return to;
    }
    clone() {
      return this._cloneInto();
    }
  };
  var SHA256_IV = /* @__PURE__ */ Uint32Array.from([
    1779033703,
    3144134277,
    1013904242,
    2773480762,
    1359893119,
    2600822924,
    528734635,
    1541459225
  ]);
  var SHA512_IV = /* @__PURE__ */ Uint32Array.from([
    1779033703,
    4089235720,
    3144134277,
    2227873595,
    1013904242,
    4271175723,
    2773480762,
    1595750129,
    1359893119,
    2917565137,
    2600822924,
    725511199,
    528734635,
    4215389547,
    1541459225,
    327033209
  ]);

  // ../sign/lib/noble-hashes/_u64.js
  var U32_MASK64 = /* @__PURE__ */ BigInt(2 ** 32 - 1);
  var _32n = /* @__PURE__ */ BigInt(32);
  function fromBig(n, le = false) {
    if (le)
      return { h: Number(n & U32_MASK64), l: Number(n >> _32n & U32_MASK64) };
    return { h: Number(n >> _32n & U32_MASK64) | 0, l: Number(n & U32_MASK64) | 0 };
  }
  function split(lst, le = false) {
    const len = lst.length;
    let Ah = new Uint32Array(len);
    let Al = new Uint32Array(len);
    for (let i = 0; i < len; i++) {
      const { h, l } = fromBig(lst[i], le);
      [Ah[i], Al[i]] = [h, l];
    }
    return [Ah, Al];
  }
  var shrSH = (h, _l, s) => h >>> s;
  var shrSL = (h, l, s) => h << 32 - s | l >>> s;
  var rotrSH = (h, l, s) => h >>> s | l << 32 - s;
  var rotrSL = (h, l, s) => h << 32 - s | l >>> s;
  var rotrBH = (h, l, s) => h << 64 - s | l >>> s - 32;
  var rotrBL = (h, l, s) => h >>> s - 32 | l << 64 - s;
  function add(Ah, Al, Bh, Bl) {
    const l = (Al >>> 0) + (Bl >>> 0);
    return { h: Ah + Bh + (l / 2 ** 32 | 0) | 0, l: l | 0 };
  }
  var add3L = (Al, Bl, Cl) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0);
  var add3H = (low, Ah, Bh, Ch) => Ah + Bh + Ch + (low / 2 ** 32 | 0) | 0;
  var add4L = (Al, Bl, Cl, Dl) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0) + (Dl >>> 0);
  var add4H = (low, Ah, Bh, Ch, Dh) => Ah + Bh + Ch + Dh + (low / 2 ** 32 | 0) | 0;
  var add5L = (Al, Bl, Cl, Dl, El) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0) + (Dl >>> 0) + (El >>> 0);
  var add5H = (low, Ah, Bh, Ch, Dh, Eh) => Ah + Bh + Ch + Dh + Eh + (low / 2 ** 32 | 0) | 0;

  // ../sign/lib/noble-hashes/sha2.js
  var SHA256_K = /* @__PURE__ */ Uint32Array.from([
    1116352408,
    1899447441,
    3049323471,
    3921009573,
    961987163,
    1508970993,
    2453635748,
    2870763221,
    3624381080,
    310598401,
    607225278,
    1426881987,
    1925078388,
    2162078206,
    2614888103,
    3248222580,
    3835390401,
    4022224774,
    264347078,
    604807628,
    770255983,
    1249150122,
    1555081692,
    1996064986,
    2554220882,
    2821834349,
    2952996808,
    3210313671,
    3336571891,
    3584528711,
    113926993,
    338241895,
    666307205,
    773529912,
    1294757372,
    1396182291,
    1695183700,
    1986661051,
    2177026350,
    2456956037,
    2730485921,
    2820302411,
    3259730800,
    3345764771,
    3516065817,
    3600352804,
    4094571909,
    275423344,
    430227734,
    506948616,
    659060556,
    883997877,
    958139571,
    1322822218,
    1537002063,
    1747873779,
    1955562222,
    2024104815,
    2227730452,
    2361852424,
    2428436474,
    2756734187,
    3204031479,
    3329325298
  ]);
  var SHA256_W = /* @__PURE__ */ new Uint32Array(64);
  var SHA256 = class extends HashMD {
    constructor(outputLen = 32) {
      super(64, outputLen, 8, false);
      this.A = SHA256_IV[0] | 0;
      this.B = SHA256_IV[1] | 0;
      this.C = SHA256_IV[2] | 0;
      this.D = SHA256_IV[3] | 0;
      this.E = SHA256_IV[4] | 0;
      this.F = SHA256_IV[5] | 0;
      this.G = SHA256_IV[6] | 0;
      this.H = SHA256_IV[7] | 0;
    }
    get() {
      const { A, B, C, D, E, F, G, H } = this;
      return [A, B, C, D, E, F, G, H];
    }
    // prettier-ignore
    set(A, B, C, D, E, F, G, H) {
      this.A = A | 0;
      this.B = B | 0;
      this.C = C | 0;
      this.D = D | 0;
      this.E = E | 0;
      this.F = F | 0;
      this.G = G | 0;
      this.H = H | 0;
    }
    process(view, offset) {
      for (let i = 0; i < 16; i++, offset += 4)
        SHA256_W[i] = view.getUint32(offset, false);
      for (let i = 16; i < 64; i++) {
        const W15 = SHA256_W[i - 15];
        const W2 = SHA256_W[i - 2];
        const s0 = rotr(W15, 7) ^ rotr(W15, 18) ^ W15 >>> 3;
        const s1 = rotr(W2, 17) ^ rotr(W2, 19) ^ W2 >>> 10;
        SHA256_W[i] = s1 + SHA256_W[i - 7] + s0 + SHA256_W[i - 16] | 0;
      }
      let { A, B, C, D, E, F, G, H } = this;
      for (let i = 0; i < 64; i++) {
        const sigma1 = rotr(E, 6) ^ rotr(E, 11) ^ rotr(E, 25);
        const T1 = H + sigma1 + Chi(E, F, G) + SHA256_K[i] + SHA256_W[i] | 0;
        const sigma0 = rotr(A, 2) ^ rotr(A, 13) ^ rotr(A, 22);
        const T2 = sigma0 + Maj(A, B, C) | 0;
        H = G;
        G = F;
        F = E;
        E = D + T1 | 0;
        D = C;
        C = B;
        B = A;
        A = T1 + T2 | 0;
      }
      A = A + this.A | 0;
      B = B + this.B | 0;
      C = C + this.C | 0;
      D = D + this.D | 0;
      E = E + this.E | 0;
      F = F + this.F | 0;
      G = G + this.G | 0;
      H = H + this.H | 0;
      this.set(A, B, C, D, E, F, G, H);
    }
    roundClean() {
      clean(SHA256_W);
    }
    destroy() {
      this.set(0, 0, 0, 0, 0, 0, 0, 0);
      clean(this.buffer);
    }
  };
  var K512 = /* @__PURE__ */ (() => split([
    "0x428a2f98d728ae22",
    "0x7137449123ef65cd",
    "0xb5c0fbcfec4d3b2f",
    "0xe9b5dba58189dbbc",
    "0x3956c25bf348b538",
    "0x59f111f1b605d019",
    "0x923f82a4af194f9b",
    "0xab1c5ed5da6d8118",
    "0xd807aa98a3030242",
    "0x12835b0145706fbe",
    "0x243185be4ee4b28c",
    "0x550c7dc3d5ffb4e2",
    "0x72be5d74f27b896f",
    "0x80deb1fe3b1696b1",
    "0x9bdc06a725c71235",
    "0xc19bf174cf692694",
    "0xe49b69c19ef14ad2",
    "0xefbe4786384f25e3",
    "0x0fc19dc68b8cd5b5",
    "0x240ca1cc77ac9c65",
    "0x2de92c6f592b0275",
    "0x4a7484aa6ea6e483",
    "0x5cb0a9dcbd41fbd4",
    "0x76f988da831153b5",
    "0x983e5152ee66dfab",
    "0xa831c66d2db43210",
    "0xb00327c898fb213f",
    "0xbf597fc7beef0ee4",
    "0xc6e00bf33da88fc2",
    "0xd5a79147930aa725",
    "0x06ca6351e003826f",
    "0x142929670a0e6e70",
    "0x27b70a8546d22ffc",
    "0x2e1b21385c26c926",
    "0x4d2c6dfc5ac42aed",
    "0x53380d139d95b3df",
    "0x650a73548baf63de",
    "0x766a0abb3c77b2a8",
    "0x81c2c92e47edaee6",
    "0x92722c851482353b",
    "0xa2bfe8a14cf10364",
    "0xa81a664bbc423001",
    "0xc24b8b70d0f89791",
    "0xc76c51a30654be30",
    "0xd192e819d6ef5218",
    "0xd69906245565a910",
    "0xf40e35855771202a",
    "0x106aa07032bbd1b8",
    "0x19a4c116b8d2d0c8",
    "0x1e376c085141ab53",
    "0x2748774cdf8eeb99",
    "0x34b0bcb5e19b48a8",
    "0x391c0cb3c5c95a63",
    "0x4ed8aa4ae3418acb",
    "0x5b9cca4f7763e373",
    "0x682e6ff3d6b2b8a3",
    "0x748f82ee5defb2fc",
    "0x78a5636f43172f60",
    "0x84c87814a1f0ab72",
    "0x8cc702081a6439ec",
    "0x90befffa23631e28",
    "0xa4506cebde82bde9",
    "0xbef9a3f7b2c67915",
    "0xc67178f2e372532b",
    "0xca273eceea26619c",
    "0xd186b8c721c0c207",
    "0xeada7dd6cde0eb1e",
    "0xf57d4f7fee6ed178",
    "0x06f067aa72176fba",
    "0x0a637dc5a2c898a6",
    "0x113f9804bef90dae",
    "0x1b710b35131c471b",
    "0x28db77f523047d84",
    "0x32caab7b40c72493",
    "0x3c9ebe0a15c9bebc",
    "0x431d67c49c100d4c",
    "0x4cc5d4becb3e42b6",
    "0x597f299cfc657e2a",
    "0x5fcb6fab3ad6faec",
    "0x6c44198c4a475817"
  ].map((n) => BigInt(n))))();
  var SHA512_Kh = /* @__PURE__ */ (() => K512[0])();
  var SHA512_Kl = /* @__PURE__ */ (() => K512[1])();
  var SHA512_W_H = /* @__PURE__ */ new Uint32Array(80);
  var SHA512_W_L = /* @__PURE__ */ new Uint32Array(80);
  var SHA512 = class extends HashMD {
    constructor(outputLen = 64) {
      super(128, outputLen, 16, false);
      this.Ah = SHA512_IV[0] | 0;
      this.Al = SHA512_IV[1] | 0;
      this.Bh = SHA512_IV[2] | 0;
      this.Bl = SHA512_IV[3] | 0;
      this.Ch = SHA512_IV[4] | 0;
      this.Cl = SHA512_IV[5] | 0;
      this.Dh = SHA512_IV[6] | 0;
      this.Dl = SHA512_IV[7] | 0;
      this.Eh = SHA512_IV[8] | 0;
      this.El = SHA512_IV[9] | 0;
      this.Fh = SHA512_IV[10] | 0;
      this.Fl = SHA512_IV[11] | 0;
      this.Gh = SHA512_IV[12] | 0;
      this.Gl = SHA512_IV[13] | 0;
      this.Hh = SHA512_IV[14] | 0;
      this.Hl = SHA512_IV[15] | 0;
    }
    // prettier-ignore
    get() {
      const { Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl } = this;
      return [Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl];
    }
    // prettier-ignore
    set(Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl) {
      this.Ah = Ah | 0;
      this.Al = Al | 0;
      this.Bh = Bh | 0;
      this.Bl = Bl | 0;
      this.Ch = Ch | 0;
      this.Cl = Cl | 0;
      this.Dh = Dh | 0;
      this.Dl = Dl | 0;
      this.Eh = Eh | 0;
      this.El = El | 0;
      this.Fh = Fh | 0;
      this.Fl = Fl | 0;
      this.Gh = Gh | 0;
      this.Gl = Gl | 0;
      this.Hh = Hh | 0;
      this.Hl = Hl | 0;
    }
    process(view, offset) {
      for (let i = 0; i < 16; i++, offset += 4) {
        SHA512_W_H[i] = view.getUint32(offset);
        SHA512_W_L[i] = view.getUint32(offset += 4);
      }
      for (let i = 16; i < 80; i++) {
        const W15h = SHA512_W_H[i - 15] | 0;
        const W15l = SHA512_W_L[i - 15] | 0;
        const s0h = rotrSH(W15h, W15l, 1) ^ rotrSH(W15h, W15l, 8) ^ shrSH(W15h, W15l, 7);
        const s0l = rotrSL(W15h, W15l, 1) ^ rotrSL(W15h, W15l, 8) ^ shrSL(W15h, W15l, 7);
        const W2h = SHA512_W_H[i - 2] | 0;
        const W2l = SHA512_W_L[i - 2] | 0;
        const s1h = rotrSH(W2h, W2l, 19) ^ rotrBH(W2h, W2l, 61) ^ shrSH(W2h, W2l, 6);
        const s1l = rotrSL(W2h, W2l, 19) ^ rotrBL(W2h, W2l, 61) ^ shrSL(W2h, W2l, 6);
        const SUMl = add4L(s0l, s1l, SHA512_W_L[i - 7], SHA512_W_L[i - 16]);
        const SUMh = add4H(SUMl, s0h, s1h, SHA512_W_H[i - 7], SHA512_W_H[i - 16]);
        SHA512_W_H[i] = SUMh | 0;
        SHA512_W_L[i] = SUMl | 0;
      }
      let { Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl } = this;
      for (let i = 0; i < 80; i++) {
        const sigma1h = rotrSH(Eh, El, 14) ^ rotrSH(Eh, El, 18) ^ rotrBH(Eh, El, 41);
        const sigma1l = rotrSL(Eh, El, 14) ^ rotrSL(Eh, El, 18) ^ rotrBL(Eh, El, 41);
        const CHIh = Eh & Fh ^ ~Eh & Gh;
        const CHIl = El & Fl ^ ~El & Gl;
        const T1ll = add5L(Hl, sigma1l, CHIl, SHA512_Kl[i], SHA512_W_L[i]);
        const T1h = add5H(T1ll, Hh, sigma1h, CHIh, SHA512_Kh[i], SHA512_W_H[i]);
        const T1l = T1ll | 0;
        const sigma0h = rotrSH(Ah, Al, 28) ^ rotrBH(Ah, Al, 34) ^ rotrBH(Ah, Al, 39);
        const sigma0l = rotrSL(Ah, Al, 28) ^ rotrBL(Ah, Al, 34) ^ rotrBL(Ah, Al, 39);
        const MAJh = Ah & Bh ^ Ah & Ch ^ Bh & Ch;
        const MAJl = Al & Bl ^ Al & Cl ^ Bl & Cl;
        Hh = Gh | 0;
        Hl = Gl | 0;
        Gh = Fh | 0;
        Gl = Fl | 0;
        Fh = Eh | 0;
        Fl = El | 0;
        ({ h: Eh, l: El } = add(Dh | 0, Dl | 0, T1h | 0, T1l | 0));
        Dh = Ch | 0;
        Dl = Cl | 0;
        Ch = Bh | 0;
        Cl = Bl | 0;
        Bh = Ah | 0;
        Bl = Al | 0;
        const All = add3L(T1l, sigma0l, MAJl);
        Ah = add3H(All, T1h, sigma0h, MAJh);
        Al = All | 0;
      }
      ({ h: Ah, l: Al } = add(this.Ah | 0, this.Al | 0, Ah | 0, Al | 0));
      ({ h: Bh, l: Bl } = add(this.Bh | 0, this.Bl | 0, Bh | 0, Bl | 0));
      ({ h: Ch, l: Cl } = add(this.Ch | 0, this.Cl | 0, Ch | 0, Cl | 0));
      ({ h: Dh, l: Dl } = add(this.Dh | 0, this.Dl | 0, Dh | 0, Dl | 0));
      ({ h: Eh, l: El } = add(this.Eh | 0, this.El | 0, Eh | 0, El | 0));
      ({ h: Fh, l: Fl } = add(this.Fh | 0, this.Fl | 0, Fh | 0, Fl | 0));
      ({ h: Gh, l: Gl } = add(this.Gh | 0, this.Gl | 0, Gh | 0, Gl | 0));
      ({ h: Hh, l: Hl } = add(this.Hh | 0, this.Hl | 0, Hh | 0, Hl | 0));
      this.set(Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl);
    }
    roundClean() {
      clean(SHA512_W_H, SHA512_W_L);
    }
    destroy() {
      clean(this.buffer);
      this.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    }
  };
  var sha256 = /* @__PURE__ */ createHasher(() => new SHA256());
  var sha512 = /* @__PURE__ */ createHasher(() => new SHA512());

  // ../sign/lib/noble-hashes/hmac.js
  var HMAC = class extends Hash {
    constructor(hash, _key) {
      super();
      this.finished = false;
      this.destroyed = false;
      ahash(hash);
      const key = toBytes(_key);
      this.iHash = hash.create();
      if (typeof this.iHash.update !== "function")
        throw new Error("Expected instance of class which extends utils.Hash");
      this.blockLen = this.iHash.blockLen;
      this.outputLen = this.iHash.outputLen;
      const blockLen = this.blockLen;
      const pad = new Uint8Array(blockLen);
      pad.set(key.length > blockLen ? hash.create().update(key).digest() : key);
      for (let i = 0; i < pad.length; i++)
        pad[i] ^= 54;
      this.iHash.update(pad);
      this.oHash = hash.create();
      for (let i = 0; i < pad.length; i++)
        pad[i] ^= 54 ^ 92;
      this.oHash.update(pad);
      clean(pad);
    }
    update(buf) {
      aexists(this);
      this.iHash.update(buf);
      return this;
    }
    digestInto(out) {
      aexists(this);
      abytes(out, this.outputLen);
      this.finished = true;
      this.iHash.digestInto(out);
      this.oHash.update(out);
      this.oHash.digestInto(out);
      this.destroy();
    }
    digest() {
      const out = new Uint8Array(this.oHash.outputLen);
      this.digestInto(out);
      return out;
    }
    _cloneInto(to) {
      to || (to = Object.create(Object.getPrototypeOf(this), {}));
      const { oHash, iHash, finished, destroyed, blockLen, outputLen } = this;
      to = to;
      to.finished = finished;
      to.destroyed = destroyed;
      to.blockLen = blockLen;
      to.outputLen = outputLen;
      to.oHash = oHash._cloneInto(to.oHash);
      to.iHash = iHash._cloneInto(to.iHash);
      return to;
    }
    clone() {
      return this._cloneInto();
    }
    destroy() {
      this.destroyed = true;
      this.oHash.destroy();
      this.iHash.destroy();
    }
  };
  var hmac = (hash, key, message) => new HMAC(hash, key).update(message).digest();
  hmac.create = (hash, key) => new HMAC(hash, key);

  // ../sign/lib/noble-curves/abstract/curve.js
  var _0n3 = BigInt(0);
  var _1n3 = BigInt(1);
  function negateCt(condition, item) {
    const neg = item.negate();
    return condition ? neg : item;
  }
  function normalizeZ(c, points) {
    const invertedZs = FpInvertBatch(c.Fp, points.map((p) => p.Z));
    return points.map((p, i) => c.fromAffine(p.toAffine(invertedZs[i])));
  }
  function validateW(W, bits) {
    if (!Number.isSafeInteger(W) || W <= 0 || W > bits)
      throw new Error("invalid window size, expected [1.." + bits + "], got W=" + W);
  }
  function calcWOpts(W, scalarBits) {
    validateW(W, scalarBits);
    const windows = Math.ceil(scalarBits / W) + 1;
    const windowSize = 2 ** (W - 1);
    const maxNumber = 2 ** W;
    const mask = bitMask(W);
    const shiftBy = BigInt(W);
    return { windows, windowSize, mask, maxNumber, shiftBy };
  }
  function calcOffsets(n, window, wOpts) {
    const { windowSize, mask, maxNumber, shiftBy } = wOpts;
    let wbits = Number(n & mask);
    let nextN = n >> shiftBy;
    if (wbits > windowSize) {
      wbits -= maxNumber;
      nextN += _1n3;
    }
    const offsetStart = window * windowSize;
    const offset = offsetStart + Math.abs(wbits) - 1;
    const isZero = wbits === 0;
    const isNeg = wbits < 0;
    const isNegF = window % 2 !== 0;
    const offsetF = offsetStart;
    return { nextN, offset, isZero, isNeg, isNegF, offsetF };
  }
  function validateMSMPoints(points, c) {
    if (!Array.isArray(points))
      throw new Error("array expected");
    points.forEach((p, i) => {
      if (!(p instanceof c))
        throw new Error("invalid point at index " + i);
    });
  }
  function validateMSMScalars(scalars, field) {
    if (!Array.isArray(scalars))
      throw new Error("array of scalars expected");
    scalars.forEach((s, i) => {
      if (!field.isValid(s))
        throw new Error("invalid scalar at index " + i);
    });
  }
  var pointPrecomputes = /* @__PURE__ */ new WeakMap();
  var pointWindowSizes = /* @__PURE__ */ new WeakMap();
  function getW(P) {
    return pointWindowSizes.get(P) || 1;
  }
  function assert0(n) {
    if (n !== _0n3)
      throw new Error("invalid wNAF");
  }
  var wNAF = class {
    // Parametrized with a given Point class (not individual point)
    constructor(Point2, bits) {
      this.BASE = Point2.BASE;
      this.ZERO = Point2.ZERO;
      this.Fn = Point2.Fn;
      this.bits = bits;
    }
    // non-const time multiplication ladder
    _unsafeLadder(elm, n, p = this.ZERO) {
      let d = elm;
      while (n > _0n3) {
        if (n & _1n3)
          p = p.add(d);
        d = d.double();
        n >>= _1n3;
      }
      return p;
    }
    /**
     * Creates a wNAF precomputation window. Used for caching.
     * Default window size is set by `utils.precompute()` and is equal to 8.
     * Number of precomputed points depends on the curve size:
     * 2^(𝑊−1) * (Math.ceil(𝑛 / 𝑊) + 1), where:
     * - 𝑊 is the window size
     * - 𝑛 is the bitlength of the curve order.
     * For a 256-bit curve and window size 8, the number of precomputed points is 128 * 33 = 4224.
     * @param point Point instance
     * @param W window size
     * @returns precomputed point tables flattened to a single array
     */
    precomputeWindow(point, W) {
      const { windows, windowSize } = calcWOpts(W, this.bits);
      const points = [];
      let p = point;
      let base = p;
      for (let window = 0; window < windows; window++) {
        base = p;
        points.push(base);
        for (let i = 1; i < windowSize; i++) {
          base = base.add(p);
          points.push(base);
        }
        p = base.double();
      }
      return points;
    }
    /**
     * Implements ec multiplication using precomputed tables and w-ary non-adjacent form.
     * More compact implementation:
     * https://github.com/paulmillr/noble-secp256k1/blob/47cb1669b6e506ad66b35fe7d76132ae97465da2/index.ts#L502-L541
     * @returns real and fake (for const-time) points
     */
    wNAF(W, precomputes, n) {
      if (!this.Fn.isValid(n))
        throw new Error("invalid scalar");
      let p = this.ZERO;
      let f = this.BASE;
      const wo = calcWOpts(W, this.bits);
      for (let window = 0; window < wo.windows; window++) {
        const { nextN, offset, isZero, isNeg, isNegF, offsetF } = calcOffsets(n, window, wo);
        n = nextN;
        if (isZero) {
          f = f.add(negateCt(isNegF, precomputes[offsetF]));
        } else {
          p = p.add(negateCt(isNeg, precomputes[offset]));
        }
      }
      assert0(n);
      return { p, f };
    }
    /**
     * Implements ec unsafe (non const-time) multiplication using precomputed tables and w-ary non-adjacent form.
     * @param acc accumulator point to add result of multiplication
     * @returns point
     */
    wNAFUnsafe(W, precomputes, n, acc = this.ZERO) {
      const wo = calcWOpts(W, this.bits);
      for (let window = 0; window < wo.windows; window++) {
        if (n === _0n3)
          break;
        const { nextN, offset, isZero, isNeg } = calcOffsets(n, window, wo);
        n = nextN;
        if (isZero) {
          continue;
        } else {
          const item = precomputes[offset];
          acc = acc.add(isNeg ? item.negate() : item);
        }
      }
      assert0(n);
      return acc;
    }
    getPrecomputes(W, point, transform) {
      let comp = pointPrecomputes.get(point);
      if (!comp) {
        comp = this.precomputeWindow(point, W);
        if (W !== 1) {
          if (typeof transform === "function")
            comp = transform(comp);
          pointPrecomputes.set(point, comp);
        }
      }
      return comp;
    }
    cached(point, scalar, transform) {
      const W = getW(point);
      return this.wNAF(W, this.getPrecomputes(W, point, transform), scalar);
    }
    unsafe(point, scalar, transform, prev) {
      const W = getW(point);
      if (W === 1)
        return this._unsafeLadder(point, scalar, prev);
      return this.wNAFUnsafe(W, this.getPrecomputes(W, point, transform), scalar, prev);
    }
    // We calculate precomputes for elliptic curve point multiplication
    // using windowed method. This specifies window size and
    // stores precomputed values. Usually only base point would be precomputed.
    createCache(P, W) {
      validateW(W, this.bits);
      pointWindowSizes.set(P, W);
      pointPrecomputes.delete(P);
    }
    hasCache(elm) {
      return getW(elm) !== 1;
    }
  };
  function mulEndoUnsafe(Point2, point, k1, k2) {
    let acc = point;
    let p1 = Point2.ZERO;
    let p2 = Point2.ZERO;
    while (k1 > _0n3 || k2 > _0n3) {
      if (k1 & _1n3)
        p1 = p1.add(acc);
      if (k2 & _1n3)
        p2 = p2.add(acc);
      acc = acc.double();
      k1 >>= _1n3;
      k2 >>= _1n3;
    }
    return { p1, p2 };
  }
  function pippenger(c, fieldN, points, scalars) {
    validateMSMPoints(points, c);
    validateMSMScalars(scalars, fieldN);
    const plength = points.length;
    const slength = scalars.length;
    if (plength !== slength)
      throw new Error("arrays of points and scalars must have equal length");
    const zero = c.ZERO;
    const wbits = bitLen(BigInt(plength));
    let windowSize = 1;
    if (wbits > 12)
      windowSize = wbits - 3;
    else if (wbits > 4)
      windowSize = wbits - 2;
    else if (wbits > 0)
      windowSize = 2;
    const MASK = bitMask(windowSize);
    const buckets = new Array(Number(MASK) + 1).fill(zero);
    const lastBits = Math.floor((fieldN.BITS - 1) / windowSize) * windowSize;
    let sum = zero;
    for (let i = lastBits; i >= 0; i -= windowSize) {
      buckets.fill(zero);
      for (let j = 0; j < slength; j++) {
        const scalar = scalars[j];
        const wbits2 = Number(scalar >> BigInt(i) & MASK);
        buckets[wbits2] = buckets[wbits2].add(points[j]);
      }
      let resI = zero;
      for (let j = buckets.length - 1, sumI = zero; j > 0; j--) {
        sumI = sumI.add(buckets[j]);
        resI = resI.add(sumI);
      }
      sum = sum.add(resI);
      if (i !== 0)
        for (let j = 0; j < windowSize; j++)
          sum = sum.double();
    }
    return sum;
  }
  function createField(order, field, isLE) {
    if (field) {
      if (field.ORDER !== order)
        throw new Error("Field.ORDER must match order: Fp == p, Fn == n");
      validateField(field);
      return field;
    } else {
      return Field(order, { isLE });
    }
  }
  function _createCurveFields(type, CURVE, curveOpts = {}, FpFnLE) {
    if (FpFnLE === void 0)
      FpFnLE = type === "edwards";
    if (!CURVE || typeof CURVE !== "object")
      throw new Error(`expected valid ${type} CURVE object`);
    for (const p of ["p", "n", "h"]) {
      const val = CURVE[p];
      if (!(typeof val === "bigint" && val > _0n3))
        throw new Error(`CURVE.${p} must be positive bigint`);
    }
    const Fp = createField(CURVE.p, curveOpts.Fp, FpFnLE);
    const Fn = createField(CURVE.n, curveOpts.Fn, FpFnLE);
    const _b = type === "weierstrass" ? "b" : "d";
    const params = ["Gx", "Gy", "a", _b];
    for (const p of params) {
      if (!Fp.isValid(CURVE[p]))
        throw new Error(`CURVE.${p} must be valid field element of CURVE.Fp`);
    }
    CURVE = Object.freeze(Object.assign({}, CURVE));
    return { CURVE, Fp, Fn };
  }

  // ../sign/lib/noble-curves/abstract/weierstrass.js
  var divNearest = (num2, den) => (num2 + (num2 >= 0 ? den : -den) / _2n2) / den;
  function _splitEndoScalar(k, basis, n) {
    const [[a1, b1], [a2, b2]] = basis;
    const c1 = divNearest(b2 * k, n);
    const c2 = divNearest(-b1 * k, n);
    let k1 = k - c1 * a1 - c2 * a2;
    let k2 = -c1 * b1 - c2 * b2;
    const k1neg = k1 < _0n4;
    const k2neg = k2 < _0n4;
    if (k1neg)
      k1 = -k1;
    if (k2neg)
      k2 = -k2;
    const MAX_NUM = bitMask(Math.ceil(bitLen(n) / 2)) + _1n4;
    if (k1 < _0n4 || k1 >= MAX_NUM || k2 < _0n4 || k2 >= MAX_NUM) {
      throw new Error("splitScalar (endomorphism): failed, k=" + k);
    }
    return { k1neg, k1, k2neg, k2 };
  }
  function validateSigFormat(format) {
    if (!["compact", "recovered", "der"].includes(format))
      throw new Error('Signature format must be "compact", "recovered", or "der"');
    return format;
  }
  function validateSigOpts(opts, def) {
    const optsn = {};
    for (let optName of Object.keys(def)) {
      optsn[optName] = opts[optName] === void 0 ? def[optName] : opts[optName];
    }
    _abool2(optsn.lowS, "lowS");
    _abool2(optsn.prehash, "prehash");
    if (optsn.format !== void 0)
      validateSigFormat(optsn.format);
    return optsn;
  }
  var DERErr = class extends Error {
    constructor(m = "") {
      super(m);
    }
  };
  var DER = {
    // asn.1 DER encoding utils
    Err: DERErr,
    // Basic building block is TLV (Tag-Length-Value)
    _tlv: {
      encode: (tag, data) => {
        const { Err: E } = DER;
        if (tag < 0 || tag > 256)
          throw new E("tlv.encode: wrong tag");
        if (data.length & 1)
          throw new E("tlv.encode: unpadded data");
        const dataLen = data.length / 2;
        const len = numberToHexUnpadded(dataLen);
        if (len.length / 2 & 128)
          throw new E("tlv.encode: long form length too big");
        const lenLen = dataLen > 127 ? numberToHexUnpadded(len.length / 2 | 128) : "";
        const t = numberToHexUnpadded(tag);
        return t + lenLen + len + data;
      },
      // v - value, l - left bytes (unparsed)
      decode(tag, data) {
        const { Err: E } = DER;
        let pos = 0;
        if (tag < 0 || tag > 256)
          throw new E("tlv.encode: wrong tag");
        if (data.length < 2 || data[pos++] !== tag)
          throw new E("tlv.decode: wrong tlv");
        const first = data[pos++];
        const isLong = !!(first & 128);
        let length = 0;
        if (!isLong)
          length = first;
        else {
          const lenLen = first & 127;
          if (!lenLen)
            throw new E("tlv.decode(long): indefinite length not supported");
          if (lenLen > 4)
            throw new E("tlv.decode(long): byte length is too big");
          const lengthBytes = data.subarray(pos, pos + lenLen);
          if (lengthBytes.length !== lenLen)
            throw new E("tlv.decode: length bytes not complete");
          if (lengthBytes[0] === 0)
            throw new E("tlv.decode(long): zero leftmost byte");
          for (const b of lengthBytes)
            length = length << 8 | b;
          pos += lenLen;
          if (length < 128)
            throw new E("tlv.decode(long): not minimal encoding");
        }
        const v = data.subarray(pos, pos + length);
        if (v.length !== length)
          throw new E("tlv.decode: wrong value length");
        return { v, l: data.subarray(pos + length) };
      }
    },
    // https://crypto.stackexchange.com/a/57734 Leftmost bit of first byte is 'negative' flag,
    // since we always use positive integers here. It must always be empty:
    // - add zero byte if exists
    // - if next byte doesn't have a flag, leading zero is not allowed (minimal encoding)
    _int: {
      encode(num2) {
        const { Err: E } = DER;
        if (num2 < _0n4)
          throw new E("integer: negative integers are not allowed");
        let hex = numberToHexUnpadded(num2);
        if (Number.parseInt(hex[0], 16) & 8)
          hex = "00" + hex;
        if (hex.length & 1)
          throw new E("unexpected DER parsing assertion: unpadded hex");
        return hex;
      },
      decode(data) {
        const { Err: E } = DER;
        if (data[0] & 128)
          throw new E("invalid signature integer: negative");
        if (data[0] === 0 && !(data[1] & 128))
          throw new E("invalid signature integer: unnecessary leading zero");
        return bytesToNumberBE(data);
      }
    },
    toSig(hex) {
      const { Err: E, _int: int, _tlv: tlv } = DER;
      const data = ensureBytes("signature", hex);
      const { v: seqBytes, l: seqLeftBytes } = tlv.decode(48, data);
      if (seqLeftBytes.length)
        throw new E("invalid signature: left bytes after parsing");
      const { v: rBytes, l: rLeftBytes } = tlv.decode(2, seqBytes);
      const { v: sBytes, l: sLeftBytes } = tlv.decode(2, rLeftBytes);
      if (sLeftBytes.length)
        throw new E("invalid signature: left bytes after parsing");
      return { r: int.decode(rBytes), s: int.decode(sBytes) };
    },
    hexFromSig(sig) {
      const { _tlv: tlv, _int: int } = DER;
      const rs = tlv.encode(2, int.encode(sig.r));
      const ss = tlv.encode(2, int.encode(sig.s));
      const seq = rs + ss;
      return tlv.encode(48, seq);
    }
  };
  var _0n4 = BigInt(0);
  var _1n4 = BigInt(1);
  var _2n2 = BigInt(2);
  var _3n2 = BigInt(3);
  var _4n2 = BigInt(4);
  function _normFnElement(Fn, key) {
    const { BYTES: expected } = Fn;
    let num2;
    if (typeof key === "bigint") {
      num2 = key;
    } else {
      let bytes = ensureBytes("private key", key);
      try {
        num2 = Fn.fromBytes(bytes);
      } catch (error) {
        throw new Error(`invalid private key: expected ui8a of size ${expected}, got ${typeof key}`);
      }
    }
    if (!Fn.isValidNot0(num2))
      throw new Error("invalid private key: out of range [1..N-1]");
    return num2;
  }
  function weierstrassN(params, extraOpts = {}) {
    const validated = _createCurveFields("weierstrass", params, extraOpts);
    const { Fp, Fn } = validated;
    let CURVE = validated.CURVE;
    const { h: cofactor, n: CURVE_ORDER } = CURVE;
    _validateObject(extraOpts, {}, {
      allowInfinityPoint: "boolean",
      clearCofactor: "function",
      isTorsionFree: "function",
      fromBytes: "function",
      toBytes: "function",
      endo: "object",
      wrapPrivateKey: "boolean"
    });
    const { endo } = extraOpts;
    if (endo) {
      if (!Fp.is0(CURVE.a) || typeof endo.beta !== "bigint" || !Array.isArray(endo.basises)) {
        throw new Error('invalid endo: expected "beta": bigint and "basises": array');
      }
    }
    const lengths = getWLengths(Fp, Fn);
    function assertCompressionIsSupported() {
      if (!Fp.isOdd)
        throw new Error("compression is not supported: Field does not have .isOdd()");
    }
    function pointToBytes2(_c, point, isCompressed) {
      const { x, y } = point.toAffine();
      const bx = Fp.toBytes(x);
      _abool2(isCompressed, "isCompressed");
      if (isCompressed) {
        assertCompressionIsSupported();
        const hasEvenY = !Fp.isOdd(y);
        return concatBytes(pprefix(hasEvenY), bx);
      } else {
        return concatBytes(Uint8Array.of(4), bx, Fp.toBytes(y));
      }
    }
    function pointFromBytes(bytes) {
      _abytes2(bytes, void 0, "Point");
      const { publicKey: comp, publicKeyUncompressed: uncomp } = lengths;
      const length = bytes.length;
      const head = bytes[0];
      const tail = bytes.subarray(1);
      if (length === comp && (head === 2 || head === 3)) {
        const x = Fp.fromBytes(tail);
        if (!Fp.isValid(x))
          throw new Error("bad point: is not on curve, wrong x");
        const y2 = weierstrassEquation(x);
        let y;
        try {
          y = Fp.sqrt(y2);
        } catch (sqrtError) {
          const err = sqrtError instanceof Error ? ": " + sqrtError.message : "";
          throw new Error("bad point: is not on curve, sqrt error" + err);
        }
        assertCompressionIsSupported();
        const isYOdd = Fp.isOdd(y);
        const isHeadOdd = (head & 1) === 1;
        if (isHeadOdd !== isYOdd)
          y = Fp.neg(y);
        return { x, y };
      } else if (length === uncomp && head === 4) {
        const L = Fp.BYTES;
        const x = Fp.fromBytes(tail.subarray(0, L));
        const y = Fp.fromBytes(tail.subarray(L, L * 2));
        if (!isValidXY(x, y))
          throw new Error("bad point: is not on curve");
        return { x, y };
      } else {
        throw new Error(`bad point: got length ${length}, expected compressed=${comp} or uncompressed=${uncomp}`);
      }
    }
    const encodePoint = extraOpts.toBytes || pointToBytes2;
    const decodePoint = extraOpts.fromBytes || pointFromBytes;
    function weierstrassEquation(x) {
      const x2 = Fp.sqr(x);
      const x3 = Fp.mul(x2, x);
      return Fp.add(Fp.add(x3, Fp.mul(x, CURVE.a)), CURVE.b);
    }
    function isValidXY(x, y) {
      const left = Fp.sqr(y);
      const right = weierstrassEquation(x);
      return Fp.eql(left, right);
    }
    if (!isValidXY(CURVE.Gx, CURVE.Gy))
      throw new Error("bad curve params: generator point");
    const _4a3 = Fp.mul(Fp.pow(CURVE.a, _3n2), _4n2);
    const _27b2 = Fp.mul(Fp.sqr(CURVE.b), BigInt(27));
    if (Fp.is0(Fp.add(_4a3, _27b2)))
      throw new Error("bad curve params: a or b");
    function acoord(title, n, banZero = false) {
      if (!Fp.isValid(n) || banZero && Fp.is0(n))
        throw new Error(`bad point coordinate ${title}`);
      return n;
    }
    function aprjpoint(other) {
      if (!(other instanceof Point2))
        throw new Error("ProjectivePoint expected");
    }
    function splitEndoScalarN(k) {
      if (!endo || !endo.basises)
        throw new Error("no endo");
      return _splitEndoScalar(k, endo.basises, Fn.ORDER);
    }
    const toAffineMemo = memoized((p, iz) => {
      const { X, Y, Z } = p;
      if (Fp.eql(Z, Fp.ONE))
        return { x: X, y: Y };
      const is0 = p.is0();
      if (iz == null)
        iz = is0 ? Fp.ONE : Fp.inv(Z);
      const x = Fp.mul(X, iz);
      const y = Fp.mul(Y, iz);
      const zz = Fp.mul(Z, iz);
      if (is0)
        return { x: Fp.ZERO, y: Fp.ZERO };
      if (!Fp.eql(zz, Fp.ONE))
        throw new Error("invZ was invalid");
      return { x, y };
    });
    const assertValidMemo = memoized((p) => {
      if (p.is0()) {
        if (extraOpts.allowInfinityPoint && !Fp.is0(p.Y))
          return;
        throw new Error("bad point: ZERO");
      }
      const { x, y } = p.toAffine();
      if (!Fp.isValid(x) || !Fp.isValid(y))
        throw new Error("bad point: x or y not field elements");
      if (!isValidXY(x, y))
        throw new Error("bad point: equation left != right");
      if (!p.isTorsionFree())
        throw new Error("bad point: not in prime-order subgroup");
      return true;
    });
    function finishEndo(endoBeta, k1p, k2p, k1neg, k2neg) {
      k2p = new Point2(Fp.mul(k2p.X, endoBeta), k2p.Y, k2p.Z);
      k1p = negateCt(k1neg, k1p);
      k2p = negateCt(k2neg, k2p);
      return k1p.add(k2p);
    }
    class Point2 {
      /** Does NOT validate if the point is valid. Use `.assertValidity()`. */
      constructor(X, Y, Z) {
        this.X = acoord("x", X);
        this.Y = acoord("y", Y, true);
        this.Z = acoord("z", Z);
        Object.freeze(this);
      }
      static CURVE() {
        return CURVE;
      }
      /** Does NOT validate if the point is valid. Use `.assertValidity()`. */
      static fromAffine(p) {
        const { x, y } = p || {};
        if (!p || !Fp.isValid(x) || !Fp.isValid(y))
          throw new Error("invalid affine point");
        if (p instanceof Point2)
          throw new Error("projective point not allowed");
        if (Fp.is0(x) && Fp.is0(y))
          return Point2.ZERO;
        return new Point2(x, y, Fp.ONE);
      }
      static fromBytes(bytes) {
        const P = Point2.fromAffine(decodePoint(_abytes2(bytes, void 0, "point")));
        P.assertValidity();
        return P;
      }
      static fromHex(hex) {
        return Point2.fromBytes(ensureBytes("pointHex", hex));
      }
      get x() {
        return this.toAffine().x;
      }
      get y() {
        return this.toAffine().y;
      }
      /**
       *
       * @param windowSize
       * @param isLazy true will defer table computation until the first multiplication
       * @returns
       */
      precompute(windowSize = 8, isLazy = true) {
        wnaf.createCache(this, windowSize);
        if (!isLazy)
          this.multiply(_3n2);
        return this;
      }
      // TODO: return `this`
      /** A point on curve is valid if it conforms to equation. */
      assertValidity() {
        assertValidMemo(this);
      }
      hasEvenY() {
        const { y } = this.toAffine();
        if (!Fp.isOdd)
          throw new Error("Field doesn't support isOdd");
        return !Fp.isOdd(y);
      }
      /** Compare one point to another. */
      equals(other) {
        aprjpoint(other);
        const { X: X1, Y: Y1, Z: Z1 } = this;
        const { X: X2, Y: Y2, Z: Z2 } = other;
        const U1 = Fp.eql(Fp.mul(X1, Z2), Fp.mul(X2, Z1));
        const U2 = Fp.eql(Fp.mul(Y1, Z2), Fp.mul(Y2, Z1));
        return U1 && U2;
      }
      /** Flips point to one corresponding to (x, -y) in Affine coordinates. */
      negate() {
        return new Point2(this.X, Fp.neg(this.Y), this.Z);
      }
      // Renes-Costello-Batina exception-free doubling formula.
      // There is 30% faster Jacobian formula, but it is not complete.
      // https://eprint.iacr.org/2015/1060, algorithm 3
      // Cost: 8M + 3S + 3*a + 2*b3 + 15add.
      double() {
        const { a, b } = CURVE;
        const b3 = Fp.mul(b, _3n2);
        const { X: X1, Y: Y1, Z: Z1 } = this;
        let X3 = Fp.ZERO, Y3 = Fp.ZERO, Z3 = Fp.ZERO;
        let t0 = Fp.mul(X1, X1);
        let t1 = Fp.mul(Y1, Y1);
        let t2 = Fp.mul(Z1, Z1);
        let t3 = Fp.mul(X1, Y1);
        t3 = Fp.add(t3, t3);
        Z3 = Fp.mul(X1, Z1);
        Z3 = Fp.add(Z3, Z3);
        X3 = Fp.mul(a, Z3);
        Y3 = Fp.mul(b3, t2);
        Y3 = Fp.add(X3, Y3);
        X3 = Fp.sub(t1, Y3);
        Y3 = Fp.add(t1, Y3);
        Y3 = Fp.mul(X3, Y3);
        X3 = Fp.mul(t3, X3);
        Z3 = Fp.mul(b3, Z3);
        t2 = Fp.mul(a, t2);
        t3 = Fp.sub(t0, t2);
        t3 = Fp.mul(a, t3);
        t3 = Fp.add(t3, Z3);
        Z3 = Fp.add(t0, t0);
        t0 = Fp.add(Z3, t0);
        t0 = Fp.add(t0, t2);
        t0 = Fp.mul(t0, t3);
        Y3 = Fp.add(Y3, t0);
        t2 = Fp.mul(Y1, Z1);
        t2 = Fp.add(t2, t2);
        t0 = Fp.mul(t2, t3);
        X3 = Fp.sub(X3, t0);
        Z3 = Fp.mul(t2, t1);
        Z3 = Fp.add(Z3, Z3);
        Z3 = Fp.add(Z3, Z3);
        return new Point2(X3, Y3, Z3);
      }
      // Renes-Costello-Batina exception-free addition formula.
      // There is 30% faster Jacobian formula, but it is not complete.
      // https://eprint.iacr.org/2015/1060, algorithm 1
      // Cost: 12M + 0S + 3*a + 3*b3 + 23add.
      add(other) {
        aprjpoint(other);
        const { X: X1, Y: Y1, Z: Z1 } = this;
        const { X: X2, Y: Y2, Z: Z2 } = other;
        let X3 = Fp.ZERO, Y3 = Fp.ZERO, Z3 = Fp.ZERO;
        const a = CURVE.a;
        const b3 = Fp.mul(CURVE.b, _3n2);
        let t0 = Fp.mul(X1, X2);
        let t1 = Fp.mul(Y1, Y2);
        let t2 = Fp.mul(Z1, Z2);
        let t3 = Fp.add(X1, Y1);
        let t4 = Fp.add(X2, Y2);
        t3 = Fp.mul(t3, t4);
        t4 = Fp.add(t0, t1);
        t3 = Fp.sub(t3, t4);
        t4 = Fp.add(X1, Z1);
        let t5 = Fp.add(X2, Z2);
        t4 = Fp.mul(t4, t5);
        t5 = Fp.add(t0, t2);
        t4 = Fp.sub(t4, t5);
        t5 = Fp.add(Y1, Z1);
        X3 = Fp.add(Y2, Z2);
        t5 = Fp.mul(t5, X3);
        X3 = Fp.add(t1, t2);
        t5 = Fp.sub(t5, X3);
        Z3 = Fp.mul(a, t4);
        X3 = Fp.mul(b3, t2);
        Z3 = Fp.add(X3, Z3);
        X3 = Fp.sub(t1, Z3);
        Z3 = Fp.add(t1, Z3);
        Y3 = Fp.mul(X3, Z3);
        t1 = Fp.add(t0, t0);
        t1 = Fp.add(t1, t0);
        t2 = Fp.mul(a, t2);
        t4 = Fp.mul(b3, t4);
        t1 = Fp.add(t1, t2);
        t2 = Fp.sub(t0, t2);
        t2 = Fp.mul(a, t2);
        t4 = Fp.add(t4, t2);
        t0 = Fp.mul(t1, t4);
        Y3 = Fp.add(Y3, t0);
        t0 = Fp.mul(t5, t4);
        X3 = Fp.mul(t3, X3);
        X3 = Fp.sub(X3, t0);
        t0 = Fp.mul(t3, t1);
        Z3 = Fp.mul(t5, Z3);
        Z3 = Fp.add(Z3, t0);
        return new Point2(X3, Y3, Z3);
      }
      subtract(other) {
        return this.add(other.negate());
      }
      is0() {
        return this.equals(Point2.ZERO);
      }
      /**
       * Constant time multiplication.
       * Uses wNAF method. Windowed method may be 10% faster,
       * but takes 2x longer to generate and consumes 2x memory.
       * Uses precomputes when available.
       * Uses endomorphism for Koblitz curves.
       * @param scalar by which the point would be multiplied
       * @returns New point
       */
      multiply(scalar) {
        const { endo: endo2 } = extraOpts;
        if (!Fn.isValidNot0(scalar))
          throw new Error("invalid scalar: out of range");
        let point, fake;
        const mul = (n) => wnaf.cached(this, n, (p) => normalizeZ(Point2, p));
        if (endo2) {
          const { k1neg, k1, k2neg, k2 } = splitEndoScalarN(scalar);
          const { p: k1p, f: k1f } = mul(k1);
          const { p: k2p, f: k2f } = mul(k2);
          fake = k1f.add(k2f);
          point = finishEndo(endo2.beta, k1p, k2p, k1neg, k2neg);
        } else {
          const { p, f } = mul(scalar);
          point = p;
          fake = f;
        }
        return normalizeZ(Point2, [point, fake])[0];
      }
      /**
       * Non-constant-time multiplication. Uses double-and-add algorithm.
       * It's faster, but should only be used when you don't care about
       * an exposed secret key e.g. sig verification, which works over *public* keys.
       */
      multiplyUnsafe(sc) {
        const { endo: endo2 } = extraOpts;
        const p = this;
        if (!Fn.isValid(sc))
          throw new Error("invalid scalar: out of range");
        if (sc === _0n4 || p.is0())
          return Point2.ZERO;
        if (sc === _1n4)
          return p;
        if (wnaf.hasCache(this))
          return this.multiply(sc);
        if (endo2) {
          const { k1neg, k1, k2neg, k2 } = splitEndoScalarN(sc);
          const { p1, p2 } = mulEndoUnsafe(Point2, p, k1, k2);
          return finishEndo(endo2.beta, p1, p2, k1neg, k2neg);
        } else {
          return wnaf.unsafe(p, sc);
        }
      }
      multiplyAndAddUnsafe(Q, a, b) {
        const sum = this.multiplyUnsafe(a).add(Q.multiplyUnsafe(b));
        return sum.is0() ? void 0 : sum;
      }
      /**
       * Converts Projective point to affine (x, y) coordinates.
       * @param invertedZ Z^-1 (inverted zero) - optional, precomputation is useful for invertBatch
       */
      toAffine(invertedZ) {
        return toAffineMemo(this, invertedZ);
      }
      /**
       * Checks whether Point is free of torsion elements (is in prime subgroup).
       * Always torsion-free for cofactor=1 curves.
       */
      isTorsionFree() {
        const { isTorsionFree } = extraOpts;
        if (cofactor === _1n4)
          return true;
        if (isTorsionFree)
          return isTorsionFree(Point2, this);
        return wnaf.unsafe(this, CURVE_ORDER).is0();
      }
      clearCofactor() {
        const { clearCofactor } = extraOpts;
        if (cofactor === _1n4)
          return this;
        if (clearCofactor)
          return clearCofactor(Point2, this);
        return this.multiplyUnsafe(cofactor);
      }
      isSmallOrder() {
        return this.multiplyUnsafe(cofactor).is0();
      }
      toBytes(isCompressed = true) {
        _abool2(isCompressed, "isCompressed");
        this.assertValidity();
        return encodePoint(Point2, this, isCompressed);
      }
      toHex(isCompressed = true) {
        return bytesToHex(this.toBytes(isCompressed));
      }
      toString() {
        return `<Point ${this.is0() ? "ZERO" : this.toHex()}>`;
      }
      // TODO: remove
      get px() {
        return this.X;
      }
      get py() {
        return this.X;
      }
      get pz() {
        return this.Z;
      }
      toRawBytes(isCompressed = true) {
        return this.toBytes(isCompressed);
      }
      _setWindowSize(windowSize) {
        this.precompute(windowSize);
      }
      static normalizeZ(points) {
        return normalizeZ(Point2, points);
      }
      static msm(points, scalars) {
        return pippenger(Point2, Fn, points, scalars);
      }
      static fromPrivateKey(privateKey) {
        return Point2.BASE.multiply(_normFnElement(Fn, privateKey));
      }
    }
    Point2.BASE = new Point2(CURVE.Gx, CURVE.Gy, Fp.ONE);
    Point2.ZERO = new Point2(Fp.ZERO, Fp.ONE, Fp.ZERO);
    Point2.Fp = Fp;
    Point2.Fn = Fn;
    const bits = Fn.BITS;
    const wnaf = new wNAF(Point2, extraOpts.endo ? Math.ceil(bits / 2) : bits);
    Point2.BASE.precompute(8);
    return Point2;
  }
  function pprefix(hasEvenY) {
    return Uint8Array.of(hasEvenY ? 2 : 3);
  }
  function getWLengths(Fp, Fn) {
    return {
      secretKey: Fn.BYTES,
      publicKey: 1 + Fp.BYTES,
      publicKeyUncompressed: 1 + 2 * Fp.BYTES,
      publicKeyHasPrefix: true,
      signature: 2 * Fn.BYTES
    };
  }
  function ecdh(Point2, ecdhOpts = {}) {
    const { Fn } = Point2;
    const randomBytes_ = ecdhOpts.randomBytes || randomBytes;
    const lengths = Object.assign(getWLengths(Point2.Fp, Fn), { seed: getMinHashLength(Fn.ORDER) });
    function isValidSecretKey(secretKey) {
      try {
        return !!_normFnElement(Fn, secretKey);
      } catch (error) {
        return false;
      }
    }
    function isValidPublicKey(publicKey, isCompressed) {
      const { publicKey: comp, publicKeyUncompressed } = lengths;
      try {
        const l = publicKey.length;
        if (isCompressed === true && l !== comp)
          return false;
        if (isCompressed === false && l !== publicKeyUncompressed)
          return false;
        return !!Point2.fromBytes(publicKey);
      } catch (error) {
        return false;
      }
    }
    function randomSecretKey(seed = randomBytes_(lengths.seed)) {
      return mapHashToField(_abytes2(seed, lengths.seed, "seed"), Fn.ORDER);
    }
    function getPublicKey(secretKey, isCompressed = true) {
      return Point2.BASE.multiply(_normFnElement(Fn, secretKey)).toBytes(isCompressed);
    }
    function keygen(seed) {
      const secretKey = randomSecretKey(seed);
      return { secretKey, publicKey: getPublicKey(secretKey) };
    }
    function isProbPub(item) {
      if (typeof item === "bigint")
        return false;
      if (item instanceof Point2)
        return true;
      const { secretKey, publicKey, publicKeyUncompressed } = lengths;
      if (Fn.allowedLengths || secretKey === publicKey)
        return void 0;
      const l = ensureBytes("key", item).length;
      return l === publicKey || l === publicKeyUncompressed;
    }
    function getSharedSecret(secretKeyA, publicKeyB, isCompressed = true) {
      if (isProbPub(secretKeyA) === true)
        throw new Error("first arg must be private key");
      if (isProbPub(publicKeyB) === false)
        throw new Error("second arg must be public key");
      const s = _normFnElement(Fn, secretKeyA);
      const b = Point2.fromHex(publicKeyB);
      return b.multiply(s).toBytes(isCompressed);
    }
    const utils2 = {
      isValidSecretKey,
      isValidPublicKey,
      randomSecretKey,
      // TODO: remove
      isValidPrivateKey: isValidSecretKey,
      randomPrivateKey: randomSecretKey,
      normPrivateKeyToScalar: (key) => _normFnElement(Fn, key),
      precompute(windowSize = 8, point = Point2.BASE) {
        return point.precompute(windowSize, false);
      }
    };
    return Object.freeze({ getPublicKey, getSharedSecret, keygen, Point: Point2, utils: utils2, lengths });
  }
  function ecdsa(Point2, hash, ecdsaOpts = {}) {
    ahash(hash);
    _validateObject(ecdsaOpts, {}, {
      hmac: "function",
      lowS: "boolean",
      randomBytes: "function",
      bits2int: "function",
      bits2int_modN: "function"
    });
    const randomBytes2 = ecdsaOpts.randomBytes || randomBytes;
    const hmac2 = ecdsaOpts.hmac || ((key, ...msgs) => hmac(hash, key, concatBytes(...msgs)));
    const { Fp, Fn } = Point2;
    const { ORDER: CURVE_ORDER, BITS: fnBits } = Fn;
    const { keygen, getPublicKey, getSharedSecret, utils: utils2, lengths } = ecdh(Point2, ecdsaOpts);
    const defaultSigOpts = {
      prehash: false,
      lowS: typeof ecdsaOpts.lowS === "boolean" ? ecdsaOpts.lowS : false,
      format: void 0,
      //'compact' as ECDSASigFormat,
      extraEntropy: false
    };
    const defaultSigOpts_format = "compact";
    function isBiggerThanHalfOrder(number) {
      const HALF = CURVE_ORDER >> _1n4;
      return number > HALF;
    }
    function validateRS(title, num2) {
      if (!Fn.isValidNot0(num2))
        throw new Error(`invalid signature ${title}: out of range 1..Point.Fn.ORDER`);
      return num2;
    }
    function validateSigLength(bytes, format) {
      validateSigFormat(format);
      const size = lengths.signature;
      const sizer = format === "compact" ? size : format === "recovered" ? size + 1 : void 0;
      return _abytes2(bytes, sizer, `${format} signature`);
    }
    class Signature {
      constructor(r, s, recovery) {
        this.r = validateRS("r", r);
        this.s = validateRS("s", s);
        if (recovery != null)
          this.recovery = recovery;
        Object.freeze(this);
      }
      static fromBytes(bytes, format = defaultSigOpts_format) {
        validateSigLength(bytes, format);
        let recid;
        if (format === "der") {
          const { r: r2, s: s2 } = DER.toSig(_abytes2(bytes));
          return new Signature(r2, s2);
        }
        if (format === "recovered") {
          recid = bytes[0];
          format = "compact";
          bytes = bytes.subarray(1);
        }
        const L = Fn.BYTES;
        const r = bytes.subarray(0, L);
        const s = bytes.subarray(L, L * 2);
        return new Signature(Fn.fromBytes(r), Fn.fromBytes(s), recid);
      }
      static fromHex(hex, format) {
        return this.fromBytes(hexToBytes(hex), format);
      }
      addRecoveryBit(recovery) {
        return new Signature(this.r, this.s, recovery);
      }
      recoverPublicKey(messageHash) {
        const FIELD_ORDER = Fp.ORDER;
        const { r, s, recovery: rec } = this;
        if (rec == null || ![0, 1, 2, 3].includes(rec))
          throw new Error("recovery id invalid");
        const hasCofactor = CURVE_ORDER * _2n2 < FIELD_ORDER;
        if (hasCofactor && rec > 1)
          throw new Error("recovery id is ambiguous for h>1 curve");
        const radj = rec === 2 || rec === 3 ? r + CURVE_ORDER : r;
        if (!Fp.isValid(radj))
          throw new Error("recovery id 2 or 3 invalid");
        const x = Fp.toBytes(radj);
        const R = Point2.fromBytes(concatBytes(pprefix((rec & 1) === 0), x));
        const ir = Fn.inv(radj);
        const h = bits2int_modN(ensureBytes("msgHash", messageHash));
        const u1 = Fn.create(-h * ir);
        const u2 = Fn.create(s * ir);
        const Q = Point2.BASE.multiplyUnsafe(u1).add(R.multiplyUnsafe(u2));
        if (Q.is0())
          throw new Error("point at infinify");
        Q.assertValidity();
        return Q;
      }
      // Signatures should be low-s, to prevent malleability.
      hasHighS() {
        return isBiggerThanHalfOrder(this.s);
      }
      toBytes(format = defaultSigOpts_format) {
        validateSigFormat(format);
        if (format === "der")
          return hexToBytes(DER.hexFromSig(this));
        const r = Fn.toBytes(this.r);
        const s = Fn.toBytes(this.s);
        if (format === "recovered") {
          if (this.recovery == null)
            throw new Error("recovery bit must be present");
          return concatBytes(Uint8Array.of(this.recovery), r, s);
        }
        return concatBytes(r, s);
      }
      toHex(format) {
        return bytesToHex(this.toBytes(format));
      }
      // TODO: remove
      assertValidity() {
      }
      static fromCompact(hex) {
        return Signature.fromBytes(ensureBytes("sig", hex), "compact");
      }
      static fromDER(hex) {
        return Signature.fromBytes(ensureBytes("sig", hex), "der");
      }
      normalizeS() {
        return this.hasHighS() ? new Signature(this.r, Fn.neg(this.s), this.recovery) : this;
      }
      toDERRawBytes() {
        return this.toBytes("der");
      }
      toDERHex() {
        return bytesToHex(this.toBytes("der"));
      }
      toCompactRawBytes() {
        return this.toBytes("compact");
      }
      toCompactHex() {
        return bytesToHex(this.toBytes("compact"));
      }
    }
    const bits2int = ecdsaOpts.bits2int || function bits2int_def(bytes) {
      if (bytes.length > 8192)
        throw new Error("input is too large");
      const num2 = bytesToNumberBE(bytes);
      const delta = bytes.length * 8 - fnBits;
      return delta > 0 ? num2 >> BigInt(delta) : num2;
    };
    const bits2int_modN = ecdsaOpts.bits2int_modN || function bits2int_modN_def(bytes) {
      return Fn.create(bits2int(bytes));
    };
    const ORDER_MASK = bitMask(fnBits);
    function int2octets(num2) {
      aInRange("num < 2^" + fnBits, num2, _0n4, ORDER_MASK);
      return Fn.toBytes(num2);
    }
    function validateMsgAndHash(message, prehash) {
      _abytes2(message, void 0, "message");
      return prehash ? _abytes2(hash(message), void 0, "prehashed message") : message;
    }
    function prepSig(message, privateKey, opts) {
      if (["recovered", "canonical"].some((k) => k in opts))
        throw new Error("sign() legacy options not supported");
      const { lowS, prehash, extraEntropy } = validateSigOpts(opts, defaultSigOpts);
      message = validateMsgAndHash(message, prehash);
      const h1int = bits2int_modN(message);
      const d = _normFnElement(Fn, privateKey);
      const seedArgs = [int2octets(d), int2octets(h1int)];
      if (extraEntropy != null && extraEntropy !== false) {
        const e = extraEntropy === true ? randomBytes2(lengths.secretKey) : extraEntropy;
        seedArgs.push(ensureBytes("extraEntropy", e));
      }
      const seed = concatBytes(...seedArgs);
      const m = h1int;
      function k2sig(kBytes) {
        const k = bits2int(kBytes);
        if (!Fn.isValidNot0(k))
          return;
        const ik = Fn.inv(k);
        const q = Point2.BASE.multiply(k).toAffine();
        const r = Fn.create(q.x);
        if (r === _0n4)
          return;
        const s = Fn.create(ik * Fn.create(m + r * d));
        if (s === _0n4)
          return;
        let recovery = (q.x === r ? 0 : 2) | Number(q.y & _1n4);
        let normS = s;
        if (lowS && isBiggerThanHalfOrder(s)) {
          normS = Fn.neg(s);
          recovery ^= 1;
        }
        return new Signature(r, normS, recovery);
      }
      return { seed, k2sig };
    }
    function sign(message, secretKey, opts = {}) {
      message = ensureBytes("message", message);
      const { seed, k2sig } = prepSig(message, secretKey, opts);
      const drbg = createHmacDrbg(hash.outputLen, Fn.BYTES, hmac2);
      const sig = drbg(seed, k2sig);
      return sig;
    }
    function tryParsingSig(sg) {
      let sig = void 0;
      const isHex = typeof sg === "string" || isBytes(sg);
      const isObj = !isHex && sg !== null && typeof sg === "object" && typeof sg.r === "bigint" && typeof sg.s === "bigint";
      if (!isHex && !isObj)
        throw new Error("invalid signature, expected Uint8Array, hex string or Signature instance");
      if (isObj) {
        sig = new Signature(sg.r, sg.s);
      } else if (isHex) {
        try {
          sig = Signature.fromBytes(ensureBytes("sig", sg), "der");
        } catch (derError) {
          if (!(derError instanceof DER.Err))
            throw derError;
        }
        if (!sig) {
          try {
            sig = Signature.fromBytes(ensureBytes("sig", sg), "compact");
          } catch (error) {
            return false;
          }
        }
      }
      if (!sig)
        return false;
      return sig;
    }
    function verify(signature, message, publicKey, opts = {}) {
      const { lowS, prehash, format } = validateSigOpts(opts, defaultSigOpts);
      publicKey = ensureBytes("publicKey", publicKey);
      message = validateMsgAndHash(ensureBytes("message", message), prehash);
      if ("strict" in opts)
        throw new Error("options.strict was renamed to lowS");
      const sig = format === void 0 ? tryParsingSig(signature) : Signature.fromBytes(ensureBytes("sig", signature), format);
      if (sig === false)
        return false;
      try {
        const P = Point2.fromBytes(publicKey);
        if (lowS && sig.hasHighS())
          return false;
        const { r, s } = sig;
        const h = bits2int_modN(message);
        const is = Fn.inv(s);
        const u1 = Fn.create(h * is);
        const u2 = Fn.create(r * is);
        const R = Point2.BASE.multiplyUnsafe(u1).add(P.multiplyUnsafe(u2));
        if (R.is0())
          return false;
        const v = Fn.create(R.x);
        return v === r;
      } catch (e) {
        return false;
      }
    }
    function recoverPublicKey(signature, message, opts = {}) {
      const { prehash } = validateSigOpts(opts, defaultSigOpts);
      message = validateMsgAndHash(message, prehash);
      return Signature.fromBytes(signature, "recovered").recoverPublicKey(message).toBytes();
    }
    return Object.freeze({
      keygen,
      getPublicKey,
      getSharedSecret,
      utils: utils2,
      lengths,
      Point: Point2,
      sign,
      verify,
      recoverPublicKey,
      Signature,
      hash
    });
  }
  function _weierstrass_legacy_opts_to_new(c) {
    const CURVE = {
      a: c.a,
      b: c.b,
      p: c.Fp.ORDER,
      n: c.n,
      h: c.h,
      Gx: c.Gx,
      Gy: c.Gy
    };
    const Fp = c.Fp;
    let allowedLengths = c.allowedPrivateKeyLengths ? Array.from(new Set(c.allowedPrivateKeyLengths.map((l) => Math.ceil(l / 2)))) : void 0;
    const Fn = Field(CURVE.n, {
      BITS: c.nBitLength,
      allowedLengths,
      modFromBytes: c.wrapPrivateKey
    });
    const curveOpts = {
      Fp,
      Fn,
      allowInfinityPoint: c.allowInfinityPoint,
      endo: c.endo,
      isTorsionFree: c.isTorsionFree,
      clearCofactor: c.clearCofactor,
      fromBytes: c.fromBytes,
      toBytes: c.toBytes
    };
    return { CURVE, curveOpts };
  }
  function _ecdsa_legacy_opts_to_new(c) {
    const { CURVE, curveOpts } = _weierstrass_legacy_opts_to_new(c);
    const ecdsaOpts = {
      hmac: c.hmac,
      randomBytes: c.randomBytes,
      lowS: c.lowS,
      bits2int: c.bits2int,
      bits2int_modN: c.bits2int_modN
    };
    return { CURVE, curveOpts, hash: c.hash, ecdsaOpts };
  }
  function _ecdsa_new_output_to_legacy(c, _ecdsa) {
    const Point2 = _ecdsa.Point;
    return Object.assign({}, _ecdsa, {
      ProjectivePoint: Point2,
      CURVE: Object.assign({}, c, nLength(Point2.Fn.ORDER, Point2.Fn.BITS))
    });
  }
  function weierstrass(c) {
    const { CURVE, curveOpts, hash, ecdsaOpts } = _ecdsa_legacy_opts_to_new(c);
    const Point2 = weierstrassN(CURVE, curveOpts);
    const signs = ecdsa(Point2, hash, ecdsaOpts);
    return _ecdsa_new_output_to_legacy(c, signs);
  }

  // ../sign/lib/noble-curves/_shortw_utils.js
  function createCurve(curveDef, defHash) {
    const create = (hash) => weierstrass({ ...curveDef, hash });
    return { ...create(defHash), create };
  }

  // ../sign/lib/noble-curves/abstract/hash-to-curve.js
  var _DST_scalar = utf8ToBytes("HashToScalar-");

  // ../sign/lib/noble-curves/secp256k1.js
  var secp256k1_CURVE = {
    p: BigInt("0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f"),
    n: BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141"),
    h: BigInt(1),
    a: BigInt(0),
    b: BigInt(7),
    Gx: BigInt("0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"),
    Gy: BigInt("0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8")
  };
  var secp256k1_ENDO = {
    beta: BigInt("0x7ae96a2b657c07106e64479eac3434e99cf0497512f58995c1396c28719501ee"),
    basises: [
      [BigInt("0x3086d221a7d46bcde86c90e49284eb15"), -BigInt("0xe4437ed6010e88286f547fa90abfe4c3")],
      [BigInt("0x114ca50f7a8e2f3f657c1108d9d44cfd8"), BigInt("0x3086d221a7d46bcde86c90e49284eb15")]
    ]
  };
  var _0n5 = /* @__PURE__ */ BigInt(0);
  var _1n5 = /* @__PURE__ */ BigInt(1);
  var _2n3 = /* @__PURE__ */ BigInt(2);
  function sqrtMod(y) {
    const P = secp256k1_CURVE.p;
    const _3n3 = BigInt(3), _6n = BigInt(6), _11n = BigInt(11), _22n = BigInt(22);
    const _23n = BigInt(23), _44n = BigInt(44), _88n = BigInt(88);
    const b2 = y * y * y % P;
    const b3 = b2 * b2 * y % P;
    const b6 = pow2(b3, _3n3, P) * b3 % P;
    const b9 = pow2(b6, _3n3, P) * b3 % P;
    const b11 = pow2(b9, _2n3, P) * b2 % P;
    const b22 = pow2(b11, _11n, P) * b11 % P;
    const b44 = pow2(b22, _22n, P) * b22 % P;
    const b88 = pow2(b44, _44n, P) * b44 % P;
    const b176 = pow2(b88, _88n, P) * b88 % P;
    const b220 = pow2(b176, _44n, P) * b44 % P;
    const b223 = pow2(b220, _3n3, P) * b3 % P;
    const t1 = pow2(b223, _23n, P) * b22 % P;
    const t2 = pow2(t1, _6n, P) * b2 % P;
    const root = pow2(t2, _2n3, P);
    if (!Fpk1.eql(Fpk1.sqr(root), y))
      throw new Error("Cannot find square root");
    return root;
  }
  var Fpk1 = Field(secp256k1_CURVE.p, { sqrt: sqrtMod });
  var secp256k1 = createCurve({ ...secp256k1_CURVE, Fp: Fpk1, lowS: true, endo: secp256k1_ENDO }, sha256);
  var TAGGED_HASH_PREFIXES = {};
  function taggedHash(tag, ...messages) {
    let tagP = TAGGED_HASH_PREFIXES[tag];
    if (tagP === void 0) {
      const tagH = sha256(utf8ToBytes(tag));
      tagP = concatBytes(tagH, tagH);
      TAGGED_HASH_PREFIXES[tag] = tagP;
    }
    return sha256(concatBytes(tagP, ...messages));
  }
  var pointToBytes = (point) => point.toBytes(true).slice(1);
  var Pointk1 = /* @__PURE__ */ (() => secp256k1.Point)();
  var hasEven = (y) => y % _2n3 === _0n5;
  function schnorrGetExtPubKey(priv) {
    const { Fn, BASE } = Pointk1;
    const d_ = _normFnElement(Fn, priv);
    const p = BASE.multiply(d_);
    const scalar = hasEven(p.y) ? d_ : Fn.neg(d_);
    return { scalar, bytes: pointToBytes(p) };
  }
  function lift_x(x) {
    const Fp = Fpk1;
    if (!Fp.isValidNot0(x))
      throw new Error("invalid x: Fail if x \u2265 p");
    const xx = Fp.create(x * x);
    const c = Fp.create(xx * x + BigInt(7));
    let y = Fp.sqrt(c);
    if (!hasEven(y))
      y = Fp.neg(y);
    const p = Pointk1.fromAffine({ x, y });
    p.assertValidity();
    return p;
  }
  var num = bytesToNumberBE;
  function challenge(...args) {
    return Pointk1.Fn.create(num(taggedHash("BIP0340/challenge", ...args)));
  }
  function schnorrGetPublicKey(secretKey) {
    return schnorrGetExtPubKey(secretKey).bytes;
  }
  function schnorrSign(message, secretKey, auxRand = randomBytes(32)) {
    const { Fn } = Pointk1;
    const m = ensureBytes("message", message);
    const { bytes: px, scalar: d } = schnorrGetExtPubKey(secretKey);
    const a = ensureBytes("auxRand", auxRand, 32);
    const t = Fn.toBytes(d ^ num(taggedHash("BIP0340/aux", a)));
    const rand = taggedHash("BIP0340/nonce", t, px, m);
    const { bytes: rx, scalar: k } = schnorrGetExtPubKey(rand);
    const e = challenge(rx, px, m);
    const sig = new Uint8Array(64);
    sig.set(rx, 0);
    sig.set(Fn.toBytes(Fn.create(k + e * d)), 32);
    if (!schnorrVerify(sig, m, px))
      throw new Error("sign: Invalid signature produced");
    return sig;
  }
  function schnorrVerify(signature, message, publicKey) {
    const { Fn, BASE } = Pointk1;
    const sig = ensureBytes("signature", signature, 64);
    const m = ensureBytes("message", message);
    const pub = ensureBytes("publicKey", publicKey, 32);
    try {
      const P = lift_x(num(pub));
      const r = num(sig.subarray(0, 32));
      if (!inRange(r, _1n5, secp256k1_CURVE.p))
        return false;
      const s = num(sig.subarray(32, 64));
      if (!inRange(s, _1n5, secp256k1_CURVE.n))
        return false;
      const e = challenge(Fn.toBytes(r), pointToBytes(P), m);
      const R = BASE.multiplyUnsafe(s).add(P.multiplyUnsafe(Fn.neg(e)));
      const { x, y } = R.toAffine();
      if (R.is0() || !hasEven(y) || x !== r)
        return false;
      return true;
    } catch (error) {
      return false;
    }
  }
  var schnorr = /* @__PURE__ */ (() => {
    const size = 32;
    const seedLength = 48;
    const randomSecretKey = (seed = randomBytes(seedLength)) => {
      return mapHashToField(seed, secp256k1_CURVE.n);
    };
    secp256k1.utils.randomSecretKey;
    function keygen(seed) {
      const secretKey = randomSecretKey(seed);
      return { secretKey, publicKey: schnorrGetPublicKey(secretKey) };
    }
    return {
      keygen,
      getPublicKey: schnorrGetPublicKey,
      sign: schnorrSign,
      verify: schnorrVerify,
      Point: Pointk1,
      utils: {
        randomSecretKey,
        randomPrivateKey: randomSecretKey,
        taggedHash,
        // TODO: remove
        lift_x,
        pointToBytes,
        numberToBytesBE,
        bytesToNumberBE,
        mod
      },
      lengths: {
        secretKey: size,
        publicKey: size,
        publicKeyHasPrefix: false,
        signature: size * 2,
        seed: seedLength
      }
    };
  })();

  // ../sign/lib/noble-hashes/legacy.js
  var Rho160 = /* @__PURE__ */ Uint8Array.from([
    7,
    4,
    13,
    1,
    10,
    6,
    15,
    3,
    12,
    0,
    9,
    5,
    2,
    14,
    11,
    8
  ]);
  var Id160 = /* @__PURE__ */ (() => Uint8Array.from(new Array(16).fill(0).map((_, i) => i)))();
  var Pi160 = /* @__PURE__ */ (() => Id160.map((i) => (9 * i + 5) % 16))();
  var idxLR = /* @__PURE__ */ (() => {
    const L = [Id160];
    const R = [Pi160];
    const res = [L, R];
    for (let i = 0; i < 4; i++)
      for (let j of res)
        j.push(j[i].map((k) => Rho160[k]));
    return res;
  })();
  var idxL = /* @__PURE__ */ (() => idxLR[0])();
  var idxR = /* @__PURE__ */ (() => idxLR[1])();
  var shifts160 = /* @__PURE__ */ [
    [11, 14, 15, 12, 5, 8, 7, 9, 11, 13, 14, 15, 6, 7, 9, 8],
    [12, 13, 11, 15, 6, 9, 9, 7, 12, 15, 11, 13, 7, 8, 7, 7],
    [13, 15, 14, 11, 7, 7, 6, 8, 13, 14, 13, 12, 5, 5, 6, 9],
    [14, 11, 12, 14, 8, 6, 5, 5, 15, 12, 15, 14, 9, 9, 8, 6],
    [15, 12, 13, 13, 9, 5, 8, 6, 14, 11, 12, 11, 8, 6, 5, 5]
  ].map((i) => Uint8Array.from(i));
  var shiftsL160 = /* @__PURE__ */ idxL.map((idx, i) => idx.map((j) => shifts160[i][j]));
  var shiftsR160 = /* @__PURE__ */ idxR.map((idx, i) => idx.map((j) => shifts160[i][j]));
  var Kl160 = /* @__PURE__ */ Uint32Array.from([
    0,
    1518500249,
    1859775393,
    2400959708,
    2840853838
  ]);
  var Kr160 = /* @__PURE__ */ Uint32Array.from([
    1352829926,
    1548603684,
    1836072691,
    2053994217,
    0
  ]);
  function ripemd_f(group, x, y, z) {
    if (group === 0)
      return x ^ y ^ z;
    if (group === 1)
      return x & y | ~x & z;
    if (group === 2)
      return (x | ~y) ^ z;
    if (group === 3)
      return x & z | y & ~z;
    return x ^ (y | ~z);
  }
  var BUF_160 = /* @__PURE__ */ new Uint32Array(16);
  var RIPEMD160 = class extends HashMD {
    constructor() {
      super(64, 20, 8, true);
      this.h0 = 1732584193 | 0;
      this.h1 = 4023233417 | 0;
      this.h2 = 2562383102 | 0;
      this.h3 = 271733878 | 0;
      this.h4 = 3285377520 | 0;
    }
    get() {
      const { h0, h1, h2, h3, h4 } = this;
      return [h0, h1, h2, h3, h4];
    }
    set(h0, h1, h2, h3, h4) {
      this.h0 = h0 | 0;
      this.h1 = h1 | 0;
      this.h2 = h2 | 0;
      this.h3 = h3 | 0;
      this.h4 = h4 | 0;
    }
    process(view, offset) {
      for (let i = 0; i < 16; i++, offset += 4)
        BUF_160[i] = view.getUint32(offset, true);
      let al = this.h0 | 0, ar = al, bl = this.h1 | 0, br = bl, cl = this.h2 | 0, cr = cl, dl = this.h3 | 0, dr = dl, el = this.h4 | 0, er = el;
      for (let group = 0; group < 5; group++) {
        const rGroup = 4 - group;
        const hbl = Kl160[group], hbr = Kr160[group];
        const rl = idxL[group], rr = idxR[group];
        const sl = shiftsL160[group], sr = shiftsR160[group];
        for (let i = 0; i < 16; i++) {
          const tl = rotl(al + ripemd_f(group, bl, cl, dl) + BUF_160[rl[i]] + hbl, sl[i]) + el | 0;
          al = el, el = dl, dl = rotl(cl, 10) | 0, cl = bl, bl = tl;
        }
        for (let i = 0; i < 16; i++) {
          const tr = rotl(ar + ripemd_f(rGroup, br, cr, dr) + BUF_160[rr[i]] + hbr, sr[i]) + er | 0;
          ar = er, er = dr, dr = rotl(cr, 10) | 0, cr = br, br = tr;
        }
      }
      this.set(this.h1 + cl + dr | 0, this.h2 + dl + er | 0, this.h3 + el + ar | 0, this.h4 + al + br | 0, this.h0 + bl + cr | 0);
    }
    roundClean() {
      clean(BUF_160);
    }
    destroy() {
      this.destroyed = true;
      clean(this.buffer);
      this.set(0, 0, 0, 0, 0);
    }
  };
  var ripemd160 = /* @__PURE__ */ createHasher(() => new RIPEMD160());

  // ../sign/lib/scure-base/index.js
  function isBytes2(a) {
    return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array";
  }
  function isArrayOf(isString, arr) {
    if (!Array.isArray(arr))
      return false;
    if (arr.length === 0)
      return true;
    if (isString) {
      return arr.every((item) => typeof item === "string");
    } else {
      return arr.every((item) => Number.isSafeInteger(item));
    }
  }
  function afn(input) {
    if (typeof input !== "function")
      throw new Error("function expected");
    return true;
  }
  function astr(label, input) {
    if (typeof input !== "string")
      throw new Error(`${label}: string expected`);
    return true;
  }
  function anumber2(n) {
    if (!Number.isSafeInteger(n))
      throw new Error(`invalid integer: ${n}`);
  }
  function aArr(input) {
    if (!Array.isArray(input))
      throw new Error("array expected");
  }
  function astrArr(label, input) {
    if (!isArrayOf(true, input))
      throw new Error(`${label}: array of strings expected`);
  }
  function anumArr(label, input) {
    if (!isArrayOf(false, input))
      throw new Error(`${label}: array of numbers expected`);
  }
  // @__NO_SIDE_EFFECTS__
  function chain(...args) {
    const id = (a) => a;
    const wrap = (a, b) => (c) => a(b(c));
    const encode = args.map((x) => x.encode).reduceRight(wrap, id);
    const decode = args.map((x) => x.decode).reduce(wrap, id);
    return { encode, decode };
  }
  // @__NO_SIDE_EFFECTS__
  function alphabet(letters) {
    const lettersA = typeof letters === "string" ? letters.split("") : letters;
    const len = lettersA.length;
    astrArr("alphabet", lettersA);
    const indexes = new Map(lettersA.map((l, i) => [l, i]));
    return {
      encode: (digits) => {
        aArr(digits);
        return digits.map((i) => {
          if (!Number.isSafeInteger(i) || i < 0 || i >= len)
            throw new Error(`alphabet.encode: digit index outside alphabet "${i}". Allowed: ${letters}`);
          return lettersA[i];
        });
      },
      decode: (input) => {
        aArr(input);
        return input.map((letter) => {
          astr("alphabet.decode", letter);
          const i = indexes.get(letter);
          if (i === void 0)
            throw new Error(`Unknown letter: "${letter}". Allowed: ${letters}`);
          return i;
        });
      }
    };
  }
  // @__NO_SIDE_EFFECTS__
  function join(separator = "") {
    astr("join", separator);
    return {
      encode: (from) => {
        astrArr("join.decode", from);
        return from.join(separator);
      },
      decode: (to) => {
        astr("join.decode", to);
        return to.split(separator);
      }
    };
  }
  // @__NO_SIDE_EFFECTS__
  function padding(bits, chr = "=") {
    anumber2(bits);
    astr("padding", chr);
    return {
      encode(data) {
        astrArr("padding.encode", data);
        while (data.length * bits % 8)
          data.push(chr);
        return data;
      },
      decode(input) {
        astrArr("padding.decode", input);
        let end = input.length;
        if (end * bits % 8)
          throw new Error("padding: invalid, string should have whole number of bytes");
        for (; end > 0 && input[end - 1] === chr; end--) {
          const last = end - 1;
          const byte = last * bits;
          if (byte % 8 === 0)
            throw new Error("padding: invalid, string has too much padding");
        }
        return input.slice(0, end);
      }
    };
  }
  function convertRadix(data, from, to) {
    if (from < 2)
      throw new Error(`convertRadix: invalid from=${from}, base cannot be less than 2`);
    if (to < 2)
      throw new Error(`convertRadix: invalid to=${to}, base cannot be less than 2`);
    aArr(data);
    if (!data.length)
      return [];
    let pos = 0;
    const res = [];
    const digits = Array.from(data, (d) => {
      anumber2(d);
      if (d < 0 || d >= from)
        throw new Error(`invalid integer: ${d}`);
      return d;
    });
    const dlen = digits.length;
    while (true) {
      let carry = 0;
      let done = true;
      for (let i = pos; i < dlen; i++) {
        const digit = digits[i];
        const fromCarry = from * carry;
        const digitBase = fromCarry + digit;
        if (!Number.isSafeInteger(digitBase) || fromCarry / from !== carry || digitBase - digit !== fromCarry) {
          throw new Error("convertRadix: carry overflow");
        }
        const div = digitBase / to;
        carry = digitBase % to;
        const rounded = Math.floor(div);
        digits[i] = rounded;
        if (!Number.isSafeInteger(rounded) || rounded * to + carry !== digitBase)
          throw new Error("convertRadix: carry overflow");
        if (!done)
          continue;
        else if (!rounded)
          pos = i;
        else
          done = false;
      }
      res.push(carry);
      if (done)
        break;
    }
    for (let i = 0; i < data.length - 1 && data[i] === 0; i++)
      res.push(0);
    return res.reverse();
  }
  var gcd = (a, b) => b === 0 ? a : gcd(b, a % b);
  var radix2carry = /* @__NO_SIDE_EFFECTS__ */ (from, to) => from + (to - gcd(from, to));
  var powers = /* @__PURE__ */ (() => {
    let res = [];
    for (let i = 0; i < 40; i++)
      res.push(2 ** i);
    return res;
  })();
  function convertRadix2(data, from, to, padding2) {
    aArr(data);
    if (from <= 0 || from > 32)
      throw new Error(`convertRadix2: wrong from=${from}`);
    if (to <= 0 || to > 32)
      throw new Error(`convertRadix2: wrong to=${to}`);
    if (/* @__PURE__ */ radix2carry(from, to) > 32) {
      throw new Error(`convertRadix2: carry overflow from=${from} to=${to} carryBits=${/* @__PURE__ */ radix2carry(from, to)}`);
    }
    let carry = 0;
    let pos = 0;
    const max = powers[from];
    const mask = powers[to] - 1;
    const res = [];
    for (const n of data) {
      anumber2(n);
      if (n >= max)
        throw new Error(`convertRadix2: invalid data word=${n} from=${from}`);
      carry = carry << from | n;
      if (pos + from > 32)
        throw new Error(`convertRadix2: carry overflow pos=${pos} from=${from}`);
      pos += from;
      for (; pos >= to; pos -= to)
        res.push((carry >> pos - to & mask) >>> 0);
      const pow = powers[pos];
      if (pow === void 0)
        throw new Error("invalid carry");
      carry &= pow - 1;
    }
    carry = carry << to - pos & mask;
    if (!padding2 && pos >= from)
      throw new Error("Excess padding");
    if (!padding2 && carry > 0)
      throw new Error(`Non-zero padding: ${carry}`);
    if (padding2 && pos > 0)
      res.push(carry >>> 0);
    return res;
  }
  // @__NO_SIDE_EFFECTS__
  function radix(num2) {
    anumber2(num2);
    const _256 = 2 ** 8;
    return {
      encode: (bytes) => {
        if (!isBytes2(bytes))
          throw new Error("radix.encode input should be Uint8Array");
        return convertRadix(Array.from(bytes), _256, num2);
      },
      decode: (digits) => {
        anumArr("radix.decode", digits);
        return Uint8Array.from(convertRadix(digits, num2, _256));
      }
    };
  }
  // @__NO_SIDE_EFFECTS__
  function radix2(bits, revPadding = false) {
    anumber2(bits);
    if (bits <= 0 || bits > 32)
      throw new Error("radix2: bits should be in (0..32]");
    if (/* @__PURE__ */ radix2carry(8, bits) > 32 || /* @__PURE__ */ radix2carry(bits, 8) > 32)
      throw new Error("radix2: carry overflow");
    return {
      encode: (bytes) => {
        if (!isBytes2(bytes))
          throw new Error("radix2.encode input should be Uint8Array");
        return convertRadix2(Array.from(bytes), 8, bits, !revPadding);
      },
      decode: (digits) => {
        anumArr("radix2.decode", digits);
        return Uint8Array.from(convertRadix2(digits, bits, 8, revPadding));
      }
    };
  }
  function checksum(len, fn) {
    anumber2(len);
    afn(fn);
    return {
      encode(data) {
        if (!isBytes2(data))
          throw new Error("checksum.encode: input should be Uint8Array");
        const sum = fn(data).slice(0, len);
        const res = new Uint8Array(data.length + len);
        res.set(data);
        res.set(sum, data.length);
        return res;
      },
      decode(data) {
        if (!isBytes2(data))
          throw new Error("checksum.decode: input should be Uint8Array");
        const payload = data.slice(0, -len);
        const oldChecksum = data.slice(-len);
        const newChecksum = fn(payload).slice(0, len);
        for (let i = 0; i < len; i++)
          if (newChecksum[i] !== oldChecksum[i])
            throw new Error("Invalid checksum");
        return payload;
      }
    };
  }
  var utils = {
    alphabet,
    chain,
    checksum,
    convertRadix,
    convertRadix2,
    radix,
    radix2,
    join,
    padding
  };
  var genBase58 = /* @__NO_SIDE_EFFECTS__ */ (abc) => /* @__PURE__ */ chain(/* @__PURE__ */ radix(58), /* @__PURE__ */ alphabet(abc), /* @__PURE__ */ join(""));
  var base58 = /* @__PURE__ */ genBase58("123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz");
  var createBase58check = (sha2563) => /* @__PURE__ */ chain(checksum(4, (data) => sha2563(sha2563(data))), base58);

  // ../sign/lib/scure-bip32/index.js
  var Point = secp256k1.ProjectivePoint;
  var base58check = createBase58check(sha256);
  function bytesToNumber(bytes) {
    abytes(bytes);
    const h = bytes.length === 0 ? "0" : bytesToHex(bytes);
    return BigInt("0x" + h);
  }
  function numberToBytes(num2) {
    if (typeof num2 !== "bigint")
      throw new Error("bigint expected");
    return hexToBytes(num2.toString(16).padStart(64, "0"));
  }
  var MASTER_SECRET = utf8ToBytes("Bitcoin seed");
  var BITCOIN_VERSIONS = { private: 76066276, public: 76067358 };
  var HARDENED_OFFSET = 2147483648;
  var hash160 = (data) => ripemd160(sha256(data));
  var fromU32 = (data) => createView(data).getUint32(0, false);
  var toU32 = (n) => {
    if (!Number.isSafeInteger(n) || n < 0 || n > 2 ** 32 - 1) {
      throw new Error("invalid number, should be from 0 to 2**32-1, got " + n);
    }
    const buf = new Uint8Array(4);
    createView(buf).setUint32(0, n, false);
    return buf;
  };
  var HDKey = class _HDKey {
    get fingerprint() {
      if (!this.pubHash) {
        throw new Error("No publicKey set!");
      }
      return fromU32(this.pubHash);
    }
    get identifier() {
      return this.pubHash;
    }
    get pubKeyHash() {
      return this.pubHash;
    }
    get privateKey() {
      return this.privKeyBytes || null;
    }
    get publicKey() {
      return this.pubKey || null;
    }
    get privateExtendedKey() {
      const priv = this.privateKey;
      if (!priv) {
        throw new Error("No private key");
      }
      return base58check.encode(this.serialize(this.versions.private, concatBytes(new Uint8Array([0]), priv)));
    }
    get publicExtendedKey() {
      if (!this.pubKey) {
        throw new Error("No public key");
      }
      return base58check.encode(this.serialize(this.versions.public, this.pubKey));
    }
    static fromMasterSeed(seed, versions = BITCOIN_VERSIONS) {
      abytes(seed);
      if (8 * seed.length < 128 || 8 * seed.length > 512) {
        throw new Error("HDKey: seed length must be between 128 and 512 bits; 256 bits is advised, got " + seed.length);
      }
      const I = hmac(sha512, MASTER_SECRET, seed);
      return new _HDKey({
        versions,
        chainCode: I.slice(32),
        privateKey: I.slice(0, 32)
      });
    }
    static fromExtendedKey(base58key, versions = BITCOIN_VERSIONS) {
      const keyBuffer = base58check.decode(base58key);
      const keyView = createView(keyBuffer);
      const version = keyView.getUint32(0, false);
      const opt = {
        versions,
        depth: keyBuffer[4],
        parentFingerprint: keyView.getUint32(5, false),
        index: keyView.getUint32(9, false),
        chainCode: keyBuffer.slice(13, 45)
      };
      const key = keyBuffer.slice(45);
      const isPriv = key[0] === 0;
      if (version !== versions[isPriv ? "private" : "public"]) {
        throw new Error("Version mismatch");
      }
      if (isPriv) {
        return new _HDKey({ ...opt, privateKey: key.slice(1) });
      } else {
        return new _HDKey({ ...opt, publicKey: key });
      }
    }
    static fromJSON(json) {
      return _HDKey.fromExtendedKey(json.xpriv);
    }
    constructor(opt) {
      this.depth = 0;
      this.index = 0;
      this.chainCode = null;
      this.parentFingerprint = 0;
      if (!opt || typeof opt !== "object") {
        throw new Error("HDKey.constructor must not be called directly");
      }
      this.versions = opt.versions || BITCOIN_VERSIONS;
      this.depth = opt.depth || 0;
      this.chainCode = opt.chainCode || null;
      this.index = opt.index || 0;
      this.parentFingerprint = opt.parentFingerprint || 0;
      if (!this.depth) {
        if (this.parentFingerprint || this.index) {
          throw new Error("HDKey: zero depth with non-zero index/parent fingerprint");
        }
      }
      if (opt.publicKey && opt.privateKey) {
        throw new Error("HDKey: publicKey and privateKey at same time.");
      }
      if (opt.privateKey) {
        if (!secp256k1.utils.isValidPrivateKey(opt.privateKey)) {
          throw new Error("Invalid private key");
        }
        this.privKey = typeof opt.privateKey === "bigint" ? opt.privateKey : bytesToNumber(opt.privateKey);
        this.privKeyBytes = numberToBytes(this.privKey);
        this.pubKey = secp256k1.getPublicKey(opt.privateKey, true);
      } else if (opt.publicKey) {
        this.pubKey = Point.fromHex(opt.publicKey).toRawBytes(true);
      } else {
        throw new Error("HDKey: no public or private key provided");
      }
      this.pubHash = hash160(this.pubKey);
    }
    derive(path) {
      if (!/^[mM]'?/.test(path)) {
        throw new Error('Path must start with "m" or "M"');
      }
      if (/^[mM]'?$/.test(path)) {
        return this;
      }
      const parts = path.replace(/^[mM]'?\//, "").split("/");
      let child = this;
      for (const c of parts) {
        const m = /^(\d+)('?)$/.exec(c);
        const m1 = m && m[1];
        if (!m || m.length !== 3 || typeof m1 !== "string")
          throw new Error("invalid child index: " + c);
        let idx = +m1;
        if (!Number.isSafeInteger(idx) || idx >= HARDENED_OFFSET) {
          throw new Error("Invalid index");
        }
        if (m[2] === "'") {
          idx += HARDENED_OFFSET;
        }
        child = child.deriveChild(idx);
      }
      return child;
    }
    deriveChild(index) {
      if (!this.pubKey || !this.chainCode) {
        throw new Error("No publicKey or chainCode set");
      }
      let data = toU32(index);
      if (index >= HARDENED_OFFSET) {
        const priv = this.privateKey;
        if (!priv) {
          throw new Error("Could not derive hardened child key");
        }
        data = concatBytes(new Uint8Array([0]), priv, data);
      } else {
        data = concatBytes(this.pubKey, data);
      }
      const I = hmac(sha512, this.chainCode, data);
      const childTweak = bytesToNumber(I.slice(0, 32));
      const chainCode = I.slice(32);
      if (!secp256k1.utils.isValidPrivateKey(childTweak)) {
        throw new Error("Tweak bigger than curve order");
      }
      const opt = {
        versions: this.versions,
        chainCode,
        depth: this.depth + 1,
        parentFingerprint: this.fingerprint,
        index
      };
      try {
        if (this.privateKey) {
          const added = mod(this.privKey + childTweak, secp256k1.CURVE.n);
          if (!secp256k1.utils.isValidPrivateKey(added)) {
            throw new Error("The tweak was out of range or the resulted private key is invalid");
          }
          opt.privateKey = added;
        } else {
          const added = Point.fromHex(this.pubKey).add(Point.fromPrivateKey(childTweak));
          if (added.equals(Point.ZERO)) {
            throw new Error("The tweak was equal to negative P, which made the result key invalid");
          }
          opt.publicKey = added.toRawBytes(true);
        }
        return new _HDKey(opt);
      } catch (err) {
        return this.deriveChild(index + 1);
      }
    }
    sign(hash) {
      if (!this.privateKey) {
        throw new Error("No privateKey set!");
      }
      abytes(hash, 32);
      return secp256k1.sign(hash, this.privKey).toCompactRawBytes();
    }
    verify(hash, signature) {
      abytes(hash, 32);
      abytes(signature, 64);
      if (!this.publicKey) {
        throw new Error("No publicKey set!");
      }
      let sig;
      try {
        sig = secp256k1.Signature.fromCompact(signature);
      } catch (error) {
        return false;
      }
      return secp256k1.verify(sig, hash, this.publicKey);
    }
    wipePrivateData() {
      this.privKey = void 0;
      if (this.privKeyBytes) {
        this.privKeyBytes.fill(0);
        this.privKeyBytes = void 0;
      }
      return this;
    }
    toJSON() {
      return {
        xpriv: this.privateExtendedKey,
        xpub: this.publicExtendedKey
      };
    }
    serialize(version, key) {
      if (!this.chainCode) {
        throw new Error("No chainCode set");
      }
      abytes(key, 33);
      return concatBytes(toU32(version), new Uint8Array([this.depth]), toU32(this.parentFingerprint), toU32(this.index), this.chainCode, key);
    }
  };

  // ../sign/lib/noble-hashes/pbkdf2.js
  function pbkdf2Init(hash, _password, _salt, _opts) {
    ahash(hash);
    const opts = checkOpts({ dkLen: 32, asyncTick: 10 }, _opts);
    const { c, dkLen, asyncTick } = opts;
    anumber(c);
    anumber(dkLen);
    anumber(asyncTick);
    if (c < 1)
      throw new Error("iterations (c) should be >= 1");
    const password = kdfInputToBytes(_password);
    const salt = kdfInputToBytes(_salt);
    const DK = new Uint8Array(dkLen);
    const PRF = hmac.create(hash, password);
    const PRFSalt = PRF._cloneInto().update(salt);
    return { c, dkLen, asyncTick, DK, PRF, PRFSalt };
  }
  function pbkdf2Output(PRF, PRFSalt, DK, prfW, u) {
    PRF.destroy();
    PRFSalt.destroy();
    if (prfW)
      prfW.destroy();
    clean(u);
    return DK;
  }
  function pbkdf2(hash, password, salt, opts) {
    const { c, dkLen, DK, PRF, PRFSalt } = pbkdf2Init(hash, password, salt, opts);
    let prfW;
    const arr = new Uint8Array(4);
    const view = createView(arr);
    const u = new Uint8Array(PRF.outputLen);
    for (let ti = 1, pos = 0; pos < dkLen; ti++, pos += PRF.outputLen) {
      const Ti = DK.subarray(pos, pos + PRF.outputLen);
      view.setInt32(0, ti, false);
      (prfW = PRFSalt._cloneInto(prfW)).update(arr).digestInto(u);
      Ti.set(u.subarray(0, Ti.length));
      for (let ui = 1; ui < c; ui++) {
        PRF._cloneInto(prfW).update(u).digestInto(u);
        for (let i = 0; i < Ti.length; i++)
          Ti[i] ^= u[i];
      }
    }
    return pbkdf2Output(PRF, PRFSalt, DK, prfW, u);
  }

  // ../sign/lib/scure-bip39/index.js
  var isJapanese = (wordlist2) => wordlist2[0] === "\u3042\u3044\u3053\u304F\u3057\u3093";
  function nfkd(str) {
    if (typeof str !== "string")
      throw new TypeError("invalid mnemonic type: " + typeof str);
    return str.normalize("NFKD");
  }
  function normalize(str) {
    const norm = nfkd(str);
    const words = norm.split(" ");
    if (![12, 15, 18, 21, 24].includes(words.length))
      throw new Error("Invalid mnemonic");
    return { nfkd: norm, words };
  }
  function aentropy(ent) {
    abytes(ent, 16, 20, 24, 28, 32);
  }
  function generateMnemonic(wordlist2, strength = 128) {
    anumber(strength);
    if (strength % 32 !== 0 || strength > 256)
      throw new TypeError("Invalid entropy");
    return entropyToMnemonic(randomBytes(strength / 8), wordlist2);
  }
  var calcChecksum = (entropy) => {
    const bitsLeft = 8 - entropy.length / 4;
    return new Uint8Array([sha256(entropy)[0] >> bitsLeft << bitsLeft]);
  };
  function getCoder(wordlist2) {
    if (!Array.isArray(wordlist2) || wordlist2.length !== 2048 || typeof wordlist2[0] !== "string")
      throw new Error("Wordlist: expected array of 2048 strings");
    wordlist2.forEach((i) => {
      if (typeof i !== "string")
        throw new Error("wordlist: non-string element: " + i);
    });
    return utils.chain(utils.checksum(1, calcChecksum), utils.radix2(11, true), utils.alphabet(wordlist2));
  }
  function mnemonicToEntropy(mnemonic, wordlist2) {
    const { words } = normalize(mnemonic);
    const entropy = getCoder(wordlist2).decode(words);
    aentropy(entropy);
    return entropy;
  }
  function entropyToMnemonic(entropy, wordlist2) {
    aentropy(entropy);
    const words = getCoder(wordlist2).encode(entropy);
    return words.join(isJapanese(wordlist2) ? "\u3000" : " ");
  }
  function validateMnemonic(mnemonic, wordlist2) {
    try {
      mnemonicToEntropy(mnemonic, wordlist2);
    } catch (e) {
      return false;
    }
    return true;
  }
  var psalt = (passphrase) => nfkd("mnemonic" + passphrase);
  function mnemonicToSeedSync(mnemonic, passphrase = "") {
    return pbkdf2(sha512, normalize(mnemonic).nfkd, psalt(passphrase), { c: 2048, dkLen: 64 });
  }

  // ../sign/lib/scure-bip39/wordlists/english.js
  var wordlist = `abandon
ability
able
about
above
absent
absorb
abstract
absurd
abuse
access
accident
account
accuse
achieve
acid
acoustic
acquire
across
act
action
actor
actress
actual
adapt
add
addict
address
adjust
admit
adult
advance
advice
aerobic
affair
afford
afraid
again
age
agent
agree
ahead
aim
air
airport
aisle
alarm
album
alcohol
alert
alien
all
alley
allow
almost
alone
alpha
already
also
alter
always
amateur
amazing
among
amount
amused
analyst
anchor
ancient
anger
angle
angry
animal
ankle
announce
annual
another
answer
antenna
antique
anxiety
any
apart
apology
appear
apple
approve
april
arch
arctic
area
arena
argue
arm
armed
armor
army
around
arrange
arrest
arrive
arrow
art
artefact
artist
artwork
ask
aspect
assault
asset
assist
assume
asthma
athlete
atom
attack
attend
attitude
attract
auction
audit
august
aunt
author
auto
autumn
average
avocado
avoid
awake
aware
away
awesome
awful
awkward
axis
baby
bachelor
bacon
badge
bag
balance
balcony
ball
bamboo
banana
banner
bar
barely
bargain
barrel
base
basic
basket
battle
beach
bean
beauty
because
become
beef
before
begin
behave
behind
believe
below
belt
bench
benefit
best
betray
better
between
beyond
bicycle
bid
bike
bind
biology
bird
birth
bitter
black
blade
blame
blanket
blast
bleak
bless
blind
blood
blossom
blouse
blue
blur
blush
board
boat
body
boil
bomb
bone
bonus
book
boost
border
boring
borrow
boss
bottom
bounce
box
boy
bracket
brain
brand
brass
brave
bread
breeze
brick
bridge
brief
bright
bring
brisk
broccoli
broken
bronze
broom
brother
brown
brush
bubble
buddy
budget
buffalo
build
bulb
bulk
bullet
bundle
bunker
burden
burger
burst
bus
business
busy
butter
buyer
buzz
cabbage
cabin
cable
cactus
cage
cake
call
calm
camera
camp
can
canal
cancel
candy
cannon
canoe
canvas
canyon
capable
capital
captain
car
carbon
card
cargo
carpet
carry
cart
case
cash
casino
castle
casual
cat
catalog
catch
category
cattle
caught
cause
caution
cave
ceiling
celery
cement
census
century
cereal
certain
chair
chalk
champion
change
chaos
chapter
charge
chase
chat
cheap
check
cheese
chef
cherry
chest
chicken
chief
child
chimney
choice
choose
chronic
chuckle
chunk
churn
cigar
cinnamon
circle
citizen
city
civil
claim
clap
clarify
claw
clay
clean
clerk
clever
click
client
cliff
climb
clinic
clip
clock
clog
close
cloth
cloud
clown
club
clump
cluster
clutch
coach
coast
coconut
code
coffee
coil
coin
collect
color
column
combine
come
comfort
comic
common
company
concert
conduct
confirm
congress
connect
consider
control
convince
cook
cool
copper
copy
coral
core
corn
correct
cost
cotton
couch
country
couple
course
cousin
cover
coyote
crack
cradle
craft
cram
crane
crash
crater
crawl
crazy
cream
credit
creek
crew
cricket
crime
crisp
critic
crop
cross
crouch
crowd
crucial
cruel
cruise
crumble
crunch
crush
cry
crystal
cube
culture
cup
cupboard
curious
current
curtain
curve
cushion
custom
cute
cycle
dad
damage
damp
dance
danger
daring
dash
daughter
dawn
day
deal
debate
debris
decade
december
decide
decline
decorate
decrease
deer
defense
define
defy
degree
delay
deliver
demand
demise
denial
dentist
deny
depart
depend
deposit
depth
deputy
derive
describe
desert
design
desk
despair
destroy
detail
detect
develop
device
devote
diagram
dial
diamond
diary
dice
diesel
diet
differ
digital
dignity
dilemma
dinner
dinosaur
direct
dirt
disagree
discover
disease
dish
dismiss
disorder
display
distance
divert
divide
divorce
dizzy
doctor
document
dog
doll
dolphin
domain
donate
donkey
donor
door
dose
double
dove
draft
dragon
drama
drastic
draw
dream
dress
drift
drill
drink
drip
drive
drop
drum
dry
duck
dumb
dune
during
dust
dutch
duty
dwarf
dynamic
eager
eagle
early
earn
earth
easily
east
easy
echo
ecology
economy
edge
edit
educate
effort
egg
eight
either
elbow
elder
electric
elegant
element
elephant
elevator
elite
else
embark
embody
embrace
emerge
emotion
employ
empower
empty
enable
enact
end
endless
endorse
enemy
energy
enforce
engage
engine
enhance
enjoy
enlist
enough
enrich
enroll
ensure
enter
entire
entry
envelope
episode
equal
equip
era
erase
erode
erosion
error
erupt
escape
essay
essence
estate
eternal
ethics
evidence
evil
evoke
evolve
exact
example
excess
exchange
excite
exclude
excuse
execute
exercise
exhaust
exhibit
exile
exist
exit
exotic
expand
expect
expire
explain
expose
express
extend
extra
eye
eyebrow
fabric
face
faculty
fade
faint
faith
fall
false
fame
family
famous
fan
fancy
fantasy
farm
fashion
fat
fatal
father
fatigue
fault
favorite
feature
february
federal
fee
feed
feel
female
fence
festival
fetch
fever
few
fiber
fiction
field
figure
file
film
filter
final
find
fine
finger
finish
fire
firm
first
fiscal
fish
fit
fitness
fix
flag
flame
flash
flat
flavor
flee
flight
flip
float
flock
floor
flower
fluid
flush
fly
foam
focus
fog
foil
fold
follow
food
foot
force
forest
forget
fork
fortune
forum
forward
fossil
foster
found
fox
fragile
frame
frequent
fresh
friend
fringe
frog
front
frost
frown
frozen
fruit
fuel
fun
funny
furnace
fury
future
gadget
gain
galaxy
gallery
game
gap
garage
garbage
garden
garlic
garment
gas
gasp
gate
gather
gauge
gaze
general
genius
genre
gentle
genuine
gesture
ghost
giant
gift
giggle
ginger
giraffe
girl
give
glad
glance
glare
glass
glide
glimpse
globe
gloom
glory
glove
glow
glue
goat
goddess
gold
good
goose
gorilla
gospel
gossip
govern
gown
grab
grace
grain
grant
grape
grass
gravity
great
green
grid
grief
grit
grocery
group
grow
grunt
guard
guess
guide
guilt
guitar
gun
gym
habit
hair
half
hammer
hamster
hand
happy
harbor
hard
harsh
harvest
hat
have
hawk
hazard
head
health
heart
heavy
hedgehog
height
hello
helmet
help
hen
hero
hidden
high
hill
hint
hip
hire
history
hobby
hockey
hold
hole
holiday
hollow
home
honey
hood
hope
horn
horror
horse
hospital
host
hotel
hour
hover
hub
huge
human
humble
humor
hundred
hungry
hunt
hurdle
hurry
hurt
husband
hybrid
ice
icon
idea
identify
idle
ignore
ill
illegal
illness
image
imitate
immense
immune
impact
impose
improve
impulse
inch
include
income
increase
index
indicate
indoor
industry
infant
inflict
inform
inhale
inherit
initial
inject
injury
inmate
inner
innocent
input
inquiry
insane
insect
inside
inspire
install
intact
interest
into
invest
invite
involve
iron
island
isolate
issue
item
ivory
jacket
jaguar
jar
jazz
jealous
jeans
jelly
jewel
job
join
joke
journey
joy
judge
juice
jump
jungle
junior
junk
just
kangaroo
keen
keep
ketchup
key
kick
kid
kidney
kind
kingdom
kiss
kit
kitchen
kite
kitten
kiwi
knee
knife
knock
know
lab
label
labor
ladder
lady
lake
lamp
language
laptop
large
later
latin
laugh
laundry
lava
law
lawn
lawsuit
layer
lazy
leader
leaf
learn
leave
lecture
left
leg
legal
legend
leisure
lemon
lend
length
lens
leopard
lesson
letter
level
liar
liberty
library
license
life
lift
light
like
limb
limit
link
lion
liquid
list
little
live
lizard
load
loan
lobster
local
lock
logic
lonely
long
loop
lottery
loud
lounge
love
loyal
lucky
luggage
lumber
lunar
lunch
luxury
lyrics
machine
mad
magic
magnet
maid
mail
main
major
make
mammal
man
manage
mandate
mango
mansion
manual
maple
marble
march
margin
marine
market
marriage
mask
mass
master
match
material
math
matrix
matter
maximum
maze
meadow
mean
measure
meat
mechanic
medal
media
melody
melt
member
memory
mention
menu
mercy
merge
merit
merry
mesh
message
metal
method
middle
midnight
milk
million
mimic
mind
minimum
minor
minute
miracle
mirror
misery
miss
mistake
mix
mixed
mixture
mobile
model
modify
mom
moment
monitor
monkey
monster
month
moon
moral
more
morning
mosquito
mother
motion
motor
mountain
mouse
move
movie
much
muffin
mule
multiply
muscle
museum
mushroom
music
must
mutual
myself
mystery
myth
naive
name
napkin
narrow
nasty
nation
nature
near
neck
need
negative
neglect
neither
nephew
nerve
nest
net
network
neutral
never
news
next
nice
night
noble
noise
nominee
noodle
normal
north
nose
notable
note
nothing
notice
novel
now
nuclear
number
nurse
nut
oak
obey
object
oblige
obscure
observe
obtain
obvious
occur
ocean
october
odor
off
offer
office
often
oil
okay
old
olive
olympic
omit
once
one
onion
online
only
open
opera
opinion
oppose
option
orange
orbit
orchard
order
ordinary
organ
orient
original
orphan
ostrich
other
outdoor
outer
output
outside
oval
oven
over
own
owner
oxygen
oyster
ozone
pact
paddle
page
pair
palace
palm
panda
panel
panic
panther
paper
parade
parent
park
parrot
party
pass
patch
path
patient
patrol
pattern
pause
pave
payment
peace
peanut
pear
peasant
pelican
pen
penalty
pencil
people
pepper
perfect
permit
person
pet
phone
photo
phrase
physical
piano
picnic
picture
piece
pig
pigeon
pill
pilot
pink
pioneer
pipe
pistol
pitch
pizza
place
planet
plastic
plate
play
please
pledge
pluck
plug
plunge
poem
poet
point
polar
pole
police
pond
pony
pool
popular
portion
position
possible
post
potato
pottery
poverty
powder
power
practice
praise
predict
prefer
prepare
present
pretty
prevent
price
pride
primary
print
priority
prison
private
prize
problem
process
produce
profit
program
project
promote
proof
property
prosper
protect
proud
provide
public
pudding
pull
pulp
pulse
pumpkin
punch
pupil
puppy
purchase
purity
purpose
purse
push
put
puzzle
pyramid
quality
quantum
quarter
question
quick
quit
quiz
quote
rabbit
raccoon
race
rack
radar
radio
rail
rain
raise
rally
ramp
ranch
random
range
rapid
rare
rate
rather
raven
raw
razor
ready
real
reason
rebel
rebuild
recall
receive
recipe
record
recycle
reduce
reflect
reform
refuse
region
regret
regular
reject
relax
release
relief
rely
remain
remember
remind
remove
render
renew
rent
reopen
repair
repeat
replace
report
require
rescue
resemble
resist
resource
response
result
retire
retreat
return
reunion
reveal
review
reward
rhythm
rib
ribbon
rice
rich
ride
ridge
rifle
right
rigid
ring
riot
ripple
risk
ritual
rival
river
road
roast
robot
robust
rocket
romance
roof
rookie
room
rose
rotate
rough
round
route
royal
rubber
rude
rug
rule
run
runway
rural
sad
saddle
sadness
safe
sail
salad
salmon
salon
salt
salute
same
sample
sand
satisfy
satoshi
sauce
sausage
save
say
scale
scan
scare
scatter
scene
scheme
school
science
scissors
scorpion
scout
scrap
screen
script
scrub
sea
search
season
seat
second
secret
section
security
seed
seek
segment
select
sell
seminar
senior
sense
sentence
series
service
session
settle
setup
seven
shadow
shaft
shallow
share
shed
shell
sheriff
shield
shift
shine
ship
shiver
shock
shoe
shoot
shop
short
shoulder
shove
shrimp
shrug
shuffle
shy
sibling
sick
side
siege
sight
sign
silent
silk
silly
silver
similar
simple
since
sing
siren
sister
situate
six
size
skate
sketch
ski
skill
skin
skirt
skull
slab
slam
sleep
slender
slice
slide
slight
slim
slogan
slot
slow
slush
small
smart
smile
smoke
smooth
snack
snake
snap
sniff
snow
soap
soccer
social
sock
soda
soft
solar
soldier
solid
solution
solve
someone
song
soon
sorry
sort
soul
sound
soup
source
south
space
spare
spatial
spawn
speak
special
speed
spell
spend
sphere
spice
spider
spike
spin
spirit
split
spoil
sponsor
spoon
sport
spot
spray
spread
spring
spy
square
squeeze
squirrel
stable
stadium
staff
stage
stairs
stamp
stand
start
state
stay
steak
steel
stem
step
stereo
stick
still
sting
stock
stomach
stone
stool
story
stove
strategy
street
strike
strong
struggle
student
stuff
stumble
style
subject
submit
subway
success
such
sudden
suffer
sugar
suggest
suit
summer
sun
sunny
sunset
super
supply
supreme
sure
surface
surge
surprise
surround
survey
suspect
sustain
swallow
swamp
swap
swarm
swear
sweet
swift
swim
swing
switch
sword
symbol
symptom
syrup
system
table
tackle
tag
tail
talent
talk
tank
tape
target
task
taste
tattoo
taxi
teach
team
tell
ten
tenant
tennis
tent
term
test
text
thank
that
theme
then
theory
there
they
thing
this
thought
three
thrive
throw
thumb
thunder
ticket
tide
tiger
tilt
timber
time
tiny
tip
tired
tissue
title
toast
tobacco
today
toddler
toe
together
toilet
token
tomato
tomorrow
tone
tongue
tonight
tool
tooth
top
topic
topple
torch
tornado
tortoise
toss
total
tourist
toward
tower
town
toy
track
trade
traffic
tragic
train
transfer
trap
trash
travel
tray
treat
tree
trend
trial
tribe
trick
trigger
trim
trip
trophy
trouble
truck
true
truly
trumpet
trust
truth
try
tube
tuition
tumble
tuna
tunnel
turkey
turn
turtle
twelve
twenty
twice
twin
twist
two
type
typical
ugly
umbrella
unable
unaware
uncle
uncover
under
undo
unfair
unfold
unhappy
uniform
unique
unit
universe
unknown
unlock
until
unusual
unveil
update
upgrade
uphold
upon
upper
upset
urban
urge
usage
use
used
useful
useless
usual
utility
vacant
vacuum
vague
valid
valley
valve
van
vanish
vapor
various
vast
vault
vehicle
velvet
vendor
venture
venue
verb
verify
version
very
vessel
veteran
viable
vibrant
vicious
victory
video
view
village
vintage
violin
virtual
virus
visa
visit
visual
vital
vivid
vocal
voice
void
volcano
volume
vote
voyage
wage
wagon
wait
walk
wall
walnut
want
warfare
warm
warrior
wash
wasp
waste
water
wave
way
wealth
weapon
wear
weasel
weather
web
wedding
weekend
weird
welcome
west
wet
whale
what
wheat
wheel
when
where
whip
whisper
wide
width
wife
wild
will
win
window
wine
wing
wink
winner
winter
wire
wisdom
wise
wish
witness
wolf
woman
wonder
wood
wool
word
work
world
worry
worth
wrap
wreck
wrestle
wrist
write
wrong
yard
year
yellow
you
young
youth
zebra
zero
zone
zoo`.split("\n");

  // ../sign/lib/noble-hashes/sha256.js
  var sha2562 = sha256;

  // ../sign/lib/noble-curves/abstract/utils.js
  var bytesToNumberBE2 = bytesToNumberBE;
  var numberToBytesBE2 = numberToBytesBE;

  // ../sign/src/crypto.js
  var GRAIN_PER_PRL = 1e8;
  var DUST_GRAIN = 546;
  var NETWORKS = {
    mainnet: {
      id: "mainnet",
      label: "Mainnet",
      hrp: "prl",
      coinType: 808276,
      wifVersion: 128,
      txVersion: 1,
      blockbook: "https://blockbook.pearlresearch.ai"
    },
    testnet: {
      id: "testnet",
      label: "Testnet",
      hrp: "tprl",
      coinType: 1,
      wifVersion: 239,
      txVersion: 1,
      blockbook: ""
      // no public Pearl testnet blockbook known — user configurable
    }
  };
  var PRLS = Object.freeze({
    tick: "prls",
    max: "2100000000",
    lim: "100000",
    dec: "18",
    mintFeeGrain: 1e8
  });
  var CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  var BECH32M_CONST = 734539939;
  function polymod(values) {
    const GEN = [996825010, 642813549, 513874426, 1027748829, 705979059];
    let chk = 1;
    for (const v of values) {
      const b = chk >>> 25;
      chk = (chk & 33554431) << 5 ^ v;
      for (let i = 0; i < 5; i++) if (b >>> i & 1) chk ^= GEN[i];
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
  function checksum2(hrp, data) {
    const values = hrpExpand(hrp).concat(data, [0, 0, 0, 0, 0, 0]);
    const mod2 = polymod(values) ^ BECH32M_CONST;
    const out = [];
    for (let i = 0; i < 6; i++) out.push(mod2 >>> 5 * (5 - i) & 31);
    return out;
  }
  function convertBits(data, fromBits, toBits, pad, strictPadding = false) {
    let acc = 0, bits = 0;
    const ret = [];
    const maxv = (1 << toBits) - 1;
    for (const value of data) {
      acc = acc << fromBits | value;
      bits += fromBits;
      while (bits >= toBits) {
        bits -= toBits;
        ret.push(acc >>> bits & maxv);
      }
    }
    if (pad && bits) ret.push(acc << toBits - bits & maxv);
    if (!pad && bits) {
      if (strictPadding && (acc & (1 << bits) - 1) !== 0) throw new Error("invalid padding");
    }
    return ret;
  }
  function encodeBech32m(hrp, version, program) {
    if (!(program instanceof Uint8Array) || program.length !== 32) throw new Error("program must be 32 bytes");
    if (version !== 1) throw new Error("only witness v1 (taproot) supported");
    const data5 = [version, ...convertBits([...program], 8, 5, true)];
    return hrp + "1" + data5.concat(checksum2(hrp, data5)).map((v) => CHARSET[v]).join("");
  }
  function decodeBech32m(addr, expectHrp = null) {
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
  function taggedHash2(tag, msg) {
    const tagHash = sha2562(utf8ToBytes(tag));
    const pre = new Uint8Array(tagHash.length * 2 + msg.length);
    pre.set(tagHash);
    pre.set(tagHash, tagHash.length);
    pre.set(msg, tagHash.length * 2);
    return sha2562(pre);
  }
  var dblSha = (b) => sha2562(sha2562(b));
  function newMnemonic() {
    return generateMnemonic(wordlist, 128);
  }
  function walletFromMnemonic(mnemonic, network, account = 0, index = 0) {
    if (!validateMnemonic(mnemonic, wordlist)) throw new Error("invalid BIP-39 mnemonic");
    if (!Number.isInteger(account) || account < 0 || account > 2147483647) throw new Error("bad account");
    if (!Number.isInteger(index) || index < 0 || index > 2147483647) throw new Error("bad index");
    const seed = mnemonicToSeedSync(mnemonic);
    const root = HDKey.fromMasterSeed(seed);
    const child = root.derive(`m/86'/${network.coinType}'/${account}'/0/${index}`);
    if (!child.privateKey) throw new Error("derivation failed");
    return walletFromPriv(child.privateKey, network);
  }
  var b58check = createBase58check(sha2562);
  function walletFromWIF(wif, network) {
    const raw = b58check.decode(wif.trim());
    if (raw.length < 33) throw new Error("invalid WIF payload length");
    if (raw[0] !== network.wifVersion) throw new Error(`wrong WIF network version (expected 0x${network.wifVersion.toString(16)})`);
    let key = raw.slice(1);
    if (key.length === 33 && key[32] === 1) key = key.slice(0, 32);
    if (key.length !== 32) throw new Error("invalid WIF key length");
    return walletFromPriv(key, network);
  }
  function walletToWIF(priv, network) {
    const payload = new Uint8Array(34);
    payload[0] = network.wifVersion;
    payload.set(priv, 1);
    payload[33] = 1;
    return b58check.encode(payload);
  }
  function walletFromPriv(priv, network) {
    const p = priv instanceof Uint8Array ? priv : hexToBytes(priv);
    if (p.length !== 32) throw new Error("private key must be 32 bytes");
    const internalXOnly = schnorr.getPublicKey(p);
    const { tweakedX } = tweakKeypath(internalXOnly);
    return {
      priv: p,
      internalXOnly,
      address: encodeBech32m(network.hrp, 1, tweakedX),
      network
    };
  }
  function tweakKeypath(internalXOnly) {
    const t = taggedHash2("TapTweak", internalXOnly);
    const P = schnorr.utils.lift_x(bytesToNumberBE2(internalXOnly));
    const Q = P.add(schnorr.Point.BASE.multiply(bytesToNumberBE2(t)));
    return { tweakedX: schnorr.utils.pointToBytes(Q), t };
  }
  function tweakPrivKeypath(priv, internalXOnly) {
    let d = bytesToNumberBE2(priv);
    const P = secp256k1.ProjectivePoint.fromPrivateKey(numberToBytesBE2(d, 32));
    if (P.toRawBytes(true)[0] === 3) d = secp256k1.CURVE.n - d;
    const { t } = tweakKeypath(internalXOnly);
    return numberToBytesBE2((d + bytesToNumberBE2(t)) % secp256k1.CURVE.n, 32);
  }
  function varint(n) {
    if (n < 253) return [n];
    if (n <= 65535) return [253, n & 255, n >> 8 & 255];
    if (n <= 4294967295) return [254, ...u32le(n)];
    return [255, ...u64le(n)];
  }
  function u32le(n) {
    return [n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24 & 255];
  }
  function u64le(n) {
    const lo = n % 4294967296;
    const hi = Math.floor(n / 4294967296);
    return [...u32le(lo), ...u32le(hi)];
  }
  function p2trScriptPubKey(xOnlyPub) {
    return Uint8Array.from([81, 32, ...xOnlyPub]);
  }
  var txidLE = (txidHex) => {
    if (!/^[0-9a-f]{64}$/i.test(txidHex)) throw new Error("bad txid");
    return hexToBytes(txidHex).reverse();
  };
  function keypathTxVBytes(nIn, nOut) {
    if (!Number.isInteger(nIn) || nIn < 1) throw new Error("nIn must be a positive integer");
    if (!Number.isInteger(nOut) || nOut < 1) throw new Error("nOut must be a positive integer");
    const baseBytes = 4 + 1 + 41 * nIn + 1 + 43 * nOut + 4;
    const weight = 4 * baseBytes + 2 + 66 * nIn;
    return Math.ceil(weight / 4);
  }
  function buildKeypathTx(network, inputs, outputs, sequence = 4294967295) {
    if (!inputs.length || !outputs.length) throw new Error("need inputs and outputs");
    for (const o of outputs) {
      if (!(o.program instanceof Uint8Array) || o.program.length !== 32) throw new Error("bad output program");
      if (!Number.isSafeInteger(o.value) || o.value <= 0) throw new Error("bad output value");
    }
    const core = [...u32le(network.txVersion), ...varint(inputs.length)];
    for (const inp of inputs) core.push(...txidLE(inp.txid), ...u32le(inp.vout), ...varint(0), ...u32le(sequence));
    core.push(...varint(outputs.length));
    for (const out of outputs) {
      const s = p2trScriptPubKey(out.program);
      core.push(...u64le(out.value), ...varint(s.length), ...s);
    }
    core.push(...u32le(0));
    const txid = bytesToHex(dblSha(Uint8Array.from(core)).reverse());
    const sigs = inputs.map((inp, i) => {
      const digest = keypathSigDigest(network, inputs, outputs, sequence, i);
      const tweaked = tweakPrivKeypath(inp.priv, inp.internalXOnly);
      return schnorr.sign(digest, tweaked, new Uint8Array(32));
    });
    const full = [...u32le(network.txVersion), 0, 1, ...varint(inputs.length)];
    for (const inp of inputs) full.push(...txidLE(inp.txid), ...u32le(inp.vout), ...varint(0), ...u32le(sequence));
    full.push(...varint(outputs.length));
    for (const out of outputs) {
      const s = p2trScriptPubKey(out.program);
      full.push(...u64le(out.value), ...varint(s.length), ...s);
    }
    for (const sig of sigs) full.push(...varint(1), ...varint(sig.length), ...sig);
    full.push(...u32le(0));
    return { txid, hex: bytesToHex(Uint8Array.from(full)) };
  }
  function keypathSigDigestEx(network, inputs, outputs, sequence, idx, hashType = 0) {
    const sha = (b) => sha2562(b);
    if (!Number.isInteger(idx) || idx < 0 || idx >= inputs.length) throw new Error("bad input index");
    if (hashType !== 0 && hashType !== 131) throw new Error("unsupported hash_type (only 0x00 and 0x83)");
    const acp = (hashType & 128) !== 0;
    const base = hashType & 3;
    for (const i of inputs) {
      if (!/^[0-9a-f]{64}$/i.test(i.txid || "")) throw new Error("bad input txid");
      if (!Number.isInteger(i.vout) || i.vout < 0) throw new Error("bad input vout");
      if (!Number.isSafeInteger(i.value) || i.value <= 0) throw new Error("bad input value");
      if (!(i.spk instanceof Uint8Array) || i.spk.length === 0) throw new Error("bad input spk");
    }
    const msg = [0, hashType, ...u32le(network.txVersion), ...u32le(0)];
    if (!acp) {
      msg.push(...sha(Uint8Array.from(inputs.flatMap((i) => [...txidLE(i.txid), ...u32le(i.vout)]))));
      msg.push(...sha(Uint8Array.from(inputs.flatMap((i) => u64le(i.value)))));
      msg.push(...sha(Uint8Array.from(inputs.flatMap((i) => [...varint(i.spk.length), ...i.spk]))));
      msg.push(...sha(Uint8Array.from(inputs.flatMap(() => u32le(sequence)))));
    }
    if (base !== 3 && base !== 2) {
      msg.push(...sha(Uint8Array.from(outputs.flatMap((o) => {
        const s = p2trScriptPubKey(o.program);
        return [...u64le(o.value), ...varint(s.length), ...s];
      }))));
    }
    msg.push(0);
    const inp = inputs[idx];
    if (acp) {
      msg.push(
        ...txidLE(inp.txid),
        ...u32le(inp.vout),
        ...u64le(inp.value),
        ...varint(inp.spk.length),
        ...inp.spk,
        ...u32le(sequence)
      );
    } else {
      msg.push(...u32le(idx));
    }
    if (base === 3) {
      if (idx >= outputs.length) throw new Error("SIGHASH_SINGLE: no output at input index");
      const o = outputs[idx];
      const s = p2trScriptPubKey(o.program);
      msg.push(...sha(Uint8Array.from([...u64le(o.value), ...varint(s.length), ...s])));
    }
    return taggedHash2("TapSighash", Uint8Array.from(msg));
  }
  function keypathSigDigest(network, inputs, outputs, sequence, idx) {
    return keypathSigDigestEx(
      network,
      inputs.map((i) => ({
        txid: i.txid,
        vout: i.vout,
        value: i.value,
        spk: p2trScriptPubKey(tweakKeypath(i.internalXOnly).tweakedX)
      })),
      outputs,
      sequence,
      idx,
      0
    );
  }
  var TAPLEAF_VERSION = 192;
  function tapLeafHash(script) {
    const pre = Uint8Array.from([TAPLEAF_VERSION, ...varint(script.length), ...script]);
    return taggedHash2("TapLeaf", pre);
  }
  async function bbFetch(base, path, opts = {}) {
    const res = await fetch(base.replace(/\/$/, "") + path, opts);
    if (!res.ok) throw new Error(`blockbook ${res.status} on ${path}`);
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  async function fetchUtxos(blockbookBase, address) {
    const list = await bbFetch(blockbookBase, `/api/v2/utxo/${address}`);
    if (!Array.isArray(list)) throw new Error("unexpected utxo response");
    return list.map((u) => ({
      txid: u.txid,
      vout: u.vout,
      value: Number(u.value),
      // grains (satoshis field)
      confirmations: u.confirmations ?? 0
    })).filter((u) => u.value > 0 && /^[0-9a-f]{64}$/i.test(u.txid));
  }
  async function fetchFeeRateGrainsPerVByte(blockbookBase, blocks = 2) {
    const r = await bbFetch(blockbookBase, `/api/v2/estimatefee/${blocks}`);
    const perKb = Number(r.result ?? r);
    if (!Number.isFinite(perKb) || perKb <= 0) throw new Error("fee estimate unavailable");
    return perKb * GRAIN_PER_PRL / 1e3;
  }
  async function broadcastTx(blockbookBase, hex) {
    const base = blockbookBase.replace(/\/$/, "");
    const res = await fetch(base + "/api/sendtx/", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: hex
    });
    const text = await res.text();
    let j = {};
    try {
      j = JSON.parse(text);
    } catch {
    }
    if (!res.ok || j.error) {
      throw new Error("broadcast rejected: " + (j.error || `HTTP ${res.status}: ${text.slice(0, 160)}`));
    }
    const txid = j.result ?? j.txid;
    if (!/^[0-9a-f]{64}$/i.test(txid || "")) throw new Error("unexpected broadcast response: " + text.slice(0, 160));
    return txid.toLowerCase();
  }
  async function fetchTxStatus(blockbookBase, txid) {
    return bbFetch(blockbookBase, `/api/v2/tx/${txid}`);
  }

  // ../escrow/src/escrow-core.js
  var TAPLEAF_VERSION2 = 192;
  var EMPTY = new Uint8Array(0);
  var MAX_SEQ = 4294967295;
  function parseXOnlyKey(hex) {
    if (typeof hex !== "string" || !/^[0-9a-fA-F]{64}$/.test(hex.trim())) {
      throw new Error("x-only pubkey must be 64 hex characters");
    }
    const b = hexToBytes(hex.trim().toLowerCase());
    schnorr.utils.lift_x(bytesToNumberBE2(b));
    return b;
  }
  function partyKeyFromInput(input, network) {
    const t = String(input || "").trim();
    if (/^[0-9a-fA-F]{64}$/.test(t)) return { xonly: parseXOnlyKey(t), priv: null, source: "x-only pubkey" };
    const words = t.split(/\s+/);
    if (words.length === 12 || words.length === 24) {
      const w = walletFromMnemonic(t, network);
      return { xonly: w.internalXOnly, priv: w.priv, source: "mnemonic (BIP-86 m/86'/coin'/0'/0/0)" };
    }
    throw new Error("party key must be a 64-hex x-only pubkey or a 12/24-word mnemonic");
  }
  function scriptPathSigDigestEx(network, input, outputs, leafScript, opts = {}) {
    const { sequence = MAX_SEQ, locktime = 0, inputIdx = 0 } = opts;
    if (!/^[0-9a-f]{64}$/i.test(input.txid || "")) throw new Error("bad input txid");
    if (!Number.isInteger(input.vout) || input.vout < 0) throw new Error("bad input vout");
    if (!Number.isSafeInteger(input.value) || input.value <= 0) throw new Error("bad input value");
    if (!(input.spk instanceof Uint8Array) || input.spk.length === 0) throw new Error("bad input spk");
    for (const o of outputs) {
      if (!(o.program instanceof Uint8Array) || o.program.length !== 32) throw new Error("output program must be 32 bytes");
      if (!Number.isSafeInteger(o.value) || o.value < DUST_GRAIN) throw new Error(`output below dust (${DUST_GRAIN} grains)`);
    }
    const sha = (b) => sha2562(b);
    const prevouts = sha(Uint8Array.from([...txidLE(input.txid), ...u32le(input.vout)]));
    const amounts = sha(Uint8Array.from(u64le(input.value)));
    const spks = sha(Uint8Array.from([...varint(input.spk.length), ...input.spk]));
    const seqs = sha(Uint8Array.from(u32le(sequence)));
    const outs = sha(Uint8Array.from(outputs.flatMap((o) => {
      const s = p2trScriptPubKey(o.program);
      return [...u64le(o.value), ...varint(s.length), ...s];
    })));
    const leafHash = tapLeafHash(leafScript);
    const msg = Uint8Array.from([
      0,
      0,
      ...u32le(network.txVersion),
      ...u32le(locktime),
      ...prevouts,
      ...amounts,
      ...spks,
      ...seqs,
      ...outs,
      1,
      // spend_type: script path, no annex
      ...u32le(inputIdx),
      ...leafHash,
      0,
      255,
      255,
      255,
      255
      // leaf hash, key version 0, codesep 0xffffffff
    ]);
    return taggedHash2("TapSighash", msg);
  }
  function signForXOnly(priv, digest) {
    const p = priv instanceof Uint8Array ? priv : hexToBytes(String(priv));
    const dg = digest instanceof Uint8Array ? digest : hexToBytes(String(digest));
    if (p.length !== 32) throw new Error("private key must be 32 bytes");
    if (dg.length !== 32) throw new Error("digest must be 32 bytes");
    let d = bytesToNumberBE2(p);
    if (d <= 0n || d >= secp256k1.CURVE.n) throw new Error("private key out of range");
    const P = secp256k1.ProjectivePoint.fromPrivateKey(numberToBytesBE2(d, 32));
    if (P.toRawBytes(true)[0] === 3) d = secp256k1.CURVE.n - d;
    return schnorr.sign(dg, numberToBytesBE2(d, 32), new Uint8Array(32));
  }
  function verifySchnorrSig(sig, digest, xonly) {
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
  function buildScriptPathSpend(network, input, outputs, leafScript, controlBlock, stackItems, opts = {}) {
    const { sequence = MAX_SEQ, locktime = 0 } = opts;
    if (!(leafScript instanceof Uint8Array) || leafScript.length === 0) throw new Error("bad leaf script");
    if (!(controlBlock instanceof Uint8Array) || controlBlock.length !== 33 && controlBlock.length !== 65) {
      throw new Error("bad control block");
    }
    if ((controlBlock[0] & 254) !== TAPLEAF_VERSION2) throw new Error("bad control block version");
    const digest = scriptPathSigDigestEx(network, input, outputs, leafScript, { sequence, locktime });
    const outs = [];
    for (const o of outputs) {
      const s = p2trScriptPubKey(o.program);
      outs.push(...u64le(o.value), ...varint(s.length), ...s);
    }
    const wit = [];
    for (const w of stackItems) {
      const b = w instanceof Uint8Array ? w : hexToBytes(String(w));
      wit.push(...varint(b.length), ...b);
    }
    wit.push(...varint(leafScript.length), ...leafScript);
    wit.push(...varint(controlBlock.length), ...controlBlock);
    const base = [
      ...u32le(network.txVersion),
      ...varint(1),
      ...txidLE(input.txid),
      ...u32le(input.vout),
      ...varint(0),
      ...u32le(sequence),
      ...varint(outputs.length),
      ...outs,
      ...u32le(locktime)
    ];
    const txid = bytesToHex(dblSha(Uint8Array.from(base)).reverse());
    const full = [
      ...u32le(network.txVersion),
      0,
      1,
      ...varint(1),
      ...txidLE(input.txid),
      ...u32le(input.vout),
      ...varint(0),
      ...u32le(sequence),
      ...varint(outputs.length),
      ...outs,
      ...varint(stackItems.length + 2),
      ...wit,
      ...u32le(locktime)
    ];
    const baseBytes = base.length;
    const totalBytes = full.length;
    const vBytes = Math.ceil((baseBytes * 3 + totalBytes) / 4);
    return { txid, hex: bytesToHex(Uint8Array.from(full)), digest: bytesToHex(digest), vBytes, baseBytes, totalBytes };
  }
  function spendVBytes({ nOut, scriptLen, controlLen, stackLens }) {
    if (!Number.isSafeInteger(nOut) || nOut < 1) throw new Error("bad nOut");
    if (!Number.isSafeInteger(scriptLen) || scriptLen <= 0) throw new Error("bad scriptLen");
    if (!Number.isSafeInteger(controlLen) || controlLen <= 0) throw new Error("bad controlLen");
    if (!Array.isArray(stackLens) || stackLens.length === 0) throw new Error("bad stackLens");
    const varintLen = (n) => n < 253 ? 1 : n <= 65535 ? 3 : n <= 4294967295 ? 5 : 9;
    let wit = varintLen(stackLens.length + 2);
    for (const l of stackLens) wit += varintLen(l) + l;
    wit += varintLen(scriptLen) + scriptLen + varintLen(controlLen) + controlLen;
    const base = 4 + 1 + 41 + 1 + nOut * 43 + 4;
    return Math.ceil((base * 3 + (base + 2 + wit)) / 4);
  }
  function addressToProgram(addr, network) {
    const { hrp, version, program } = decodeBech32m(addr.trim());
    if (hrp !== network.hrp) throw new Error(`wrong network HRP (expected ${network.hrp})`);
    if (version !== 1 || program.length !== 32) throw new Error("escrow pays to P2TR (v1, 32-byte) addresses only");
    return program;
  }

  // src/swap-core.js
  var OP = {
    FALSE: 0,
    DROP: 117,
    EQUALVERIFY: 136,
    SHA256: 168,
    CHECKSIG: 172,
    CLTV: 177
  };
  var TAPLEAF_VERSION3 = 192;
  var EMPTY2 = new Uint8Array(0);
  var MAX_SEQ2 = 4294967295;
  var SWAP_KIND = "pearl-swap";
  var SWAP_VERSION = 1;
  var DESCRIPTOR_PREFIX = "swap:v1";
  var PEARL_BLOCK_SECS = 194;
  var BTC_BLOCK_SECS = 600;
  var REFUND_SEQUENCE = 4294967294;
  var MIN_T1_T2_GAP = 144;
  var MIN_TIP_CLEARANCE = 6;
  var PREIMAGE_LEN = 32;
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
    if (b.length <= 255) return [76, b.length, ...b];
    throw new Error("push exceeds 255 bytes");
  }
  function encodeScriptNum(n) {
    if (!Number.isSafeInteger(n) || n < 0) throw new Error("script number must be a non-negative safe integer");
    if (n === 0) return new Uint8Array([OP.FALSE]);
    const out = [];
    let v = n;
    while (v > 0) {
      out.push(v & 255);
      v = Math.floor(v / 256);
    }
    if (out[out.length - 1] & 128) out.push(0);
    return Uint8Array.from(out);
  }
  function checkHeight(h, name) {
    if (!Number.isSafeInteger(h) || h <= 0 || h >= 5e8) {
      throw new Error(`${name} must be a positive block height (< 500000000)`);
    }
    return h;
  }
  function buildClaimScript(secretHash, bobXOnly) {
    const h = secretHash instanceof Uint8Array ? secretHash : hexToBytes(String(secretHash).trim().toLowerCase());
    if (h.length !== 32) throw new Error("secret hash must be 32 bytes");
    const bob = bobXOnly instanceof Uint8Array ? bobXOnly : parseXOnlyKey(bobXOnly);
    if (bob.length !== 32) throw new Error("bob key must be 32 bytes");
    schnorr.utils.lift_x(bytesToNumberBE2(bob));
    return Uint8Array.from([
      OP.SHA256,
      ...pushData(h),
      OP.EQUALVERIFY,
      ...pushData(bob),
      OP.CHECKSIG
    ]);
  }
  function buildRefundScript(aliceXOnly, t1) {
    const alice = aliceXOnly instanceof Uint8Array ? aliceXOnly : parseXOnlyKey(aliceXOnly);
    if (alice.length !== 32) throw new Error("alice key must be 32 bytes");
    schnorr.utils.lift_x(bytesToNumberBE2(alice));
    checkHeight(t1, "T1");
    return Uint8Array.from([
      ...pushData(encodeScriptNum(t1)),
      OP.CLTV,
      OP.DROP,
      ...pushData(alice),
      OP.CHECKSIG
    ]);
  }
  function numsInternalKey(claimLeafHash, refundLeafHash) {
    for (const h of [claimLeafHash, refundLeafHash]) {
      if (!(h instanceof Uint8Array) || h.length !== 32) throw new Error("leaf hash must be 32 bytes");
    }
    const base = Uint8Array.from([...claimLeafHash, ...refundLeafHash]);
    for (let c = 0; c < 256; c++) {
      const preimage = c === 0 ? base : Uint8Array.from([...base, c]);
      const h = taggedHash2("PearlSwapNUMS/v1", preimage);
      try {
        schnorr.utils.lift_x(bytesToNumberBE2(h));
        return h;
      } catch {
      }
    }
    throw new Error("NUMS lift failed (unreachable in practice)");
  }
  function tapBranch(a, b) {
    const [x, y] = bytesToHex(a) <= bytesToHex(b) ? [a, b] : [b, a];
    return taggedHash2("TapBranch", Uint8Array.from([...x, ...y]));
  }
  function swapTaptree(network, claimScript, refundScript) {
    if (!(claimScript instanceof Uint8Array) || claimScript.length === 0) throw new Error("bad claim script");
    if (!(refundScript instanceof Uint8Array) || refundScript.length === 0) throw new Error("bad refund script");
    const leafHashes = [tapLeafHash(claimScript), tapLeafHash(refundScript)];
    const internalXOnly = numsInternalKey(leafHashes[0], leafHashes[1]);
    const root = tapBranch(leafHashes[0], leafHashes[1]);
    const t = taggedHash2("TapTweak", Uint8Array.from([...internalXOnly, ...root]));
    const P = schnorr.utils.lift_x(bytesToNumberBE2(internalXOnly));
    const Q = P.add(schnorr.Point.BASE.multiply(bytesToNumberBE2(t)));
    const tweakedX = schnorr.utils.pointToBytes(Q);
    const parity = Q.toAffine().y & 1n ? 1 : 0;
    const controlBlocks = leafHashes.map((lh, i) => Uint8Array.from([TAPLEAF_VERSION3 | parity, ...internalXOnly, ...leafHashes[1 - i]]));
    return {
      internalXOnly,
      leafHashes,
      root,
      tweak: t,
      tweakedX,
      parity,
      address: encodeBech32m(network.hrp, 1, tweakedX),
      spk: p2trScriptPubKey(tweakedX),
      controlBlocks
      // [claim control block, refund control block]
    };
  }
  function verifySwapControlBlock(internalXOnly, leafScript, controlBlock, tweakedX) {
    try {
      if (!(controlBlock instanceof Uint8Array) || controlBlock.length !== 65) return false;
      if ((controlBlock[0] & 254) !== TAPLEAF_VERSION3) return false;
      if (!constEq(controlBlock.slice(1, 33), internalXOnly)) return false;
      const leafHash = tapLeafHash(leafScript);
      const sibling = controlBlock.slice(33, 65);
      const root = tapBranch(leafHash, sibling);
      const t = taggedHash2("TapTweak", Uint8Array.from([...internalXOnly, ...root]));
      const P = schnorr.utils.lift_x(bytesToNumberBE2(internalXOnly));
      const Q = P.add(schnorr.Point.BASE.multiply(bytesToNumberBE2(t)));
      const x = schnorr.utils.pointToBytes(Q);
      const parity = Q.toAffine().y & 1n ? 1 : 0;
      return constEq(x, tweakedX) && (controlBlock[0] & 1) === parity;
    } catch {
      return false;
    }
  }
  function generatePreimage() {
    const c = globalThis.crypto;
    if (!c || typeof c.getRandomValues !== "function") throw new Error("no CSPRNG available");
    const p = new Uint8Array(PREIMAGE_LEN);
    c.getRandomValues(p);
    return p;
  }
  function secretHashOf(preimage) {
    const p = preimage instanceof Uint8Array ? preimage : hexToBytes(String(preimage).trim().toLowerCase());
    if (p.length !== PREIMAGE_LEN) throw new Error("preimage must be 32 bytes");
    return sha2562(p);
  }
  function parsePreimage(hex) {
    const t = String(hex || "").trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(t)) throw new Error("preimage must be 64 hex characters (32 bytes)");
    return hexToBytes(t);
  }
  function pubkeyFromPriv(priv) {
    const p = priv instanceof Uint8Array ? priv : hexToBytes(String(priv).trim());
    if (p.length !== 32) throw new Error("private key must be 32 bytes");
    const P = secp256k1.ProjectivePoint.fromPrivateKey(p);
    return bytesToHex(P.toRawBytes(true).slice(1));
  }
  function proposeSwap(params) {
    const {
      role,
      network,
      prlGrains,
      btcSats,
      preimageHex,
      secretHashHex,
      aliceKeyInput,
      bobKeyInput,
      t1,
      t2,
      feeRateGrainsPerVByte
    } = params || {};
    if (role !== "alice" && role !== "bob") throw new Error('role must be "alice" or "bob"');
    if (!network || !network.hrp) throw new Error("bad network");
    if (!Number.isSafeInteger(prlGrains) || prlGrains < DUST_GRAIN) {
      throw new Error(`PRL amount must be >= dust (${DUST_GRAIN} grains)`);
    }
    if (!Number.isSafeInteger(btcSats) || btcSats <= 0) throw new Error("BTC amount must be a positive number of sats");
    let preimage = null;
    let secretHash;
    if (preimageHex) {
      preimage = parsePreimage(preimageHex);
      secretHash = secretHashOf(preimage);
      if (secretHashHex && bytesToHex(secretHash) !== String(secretHashHex).trim().toLowerCase()) {
        throw new Error("preimage does not hash to the given secret hash");
      }
    } else if (secretHashHex) {
      const t = String(secretHashHex).trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(t)) throw new Error("secret hash must be 64 hex characters");
      secretHash = hexToBytes(t);
    } else {
      throw new Error("need either the preimage (Alice) or the secret hash (Bob)");
    }
    checkHeight(t1, "T1");
    checkHeight(t2, "T2");
    if (t1 <= t2) {
      throw new Error(`T1 (${t1}) must be greater than T2 (${t2}): Alice's PRL refund must expire after Bob's BTC refund deadline`);
    }
    const warnings = [];
    if (t1 - t2 < MIN_T1_T2_GAP) {
      warnings.push(`T1 - T2 = ${t1 - t2} blocks is below the ${MIN_T1_T2_GAP}-block safety margin \u2014 Alice's refund window is tight`);
    }
    if (!Number.isFinite(feeRateGrainsPerVByte) || feeRateGrainsPerVByte <= 0) throw new Error("bad fee rate");
    const alice = partyKeyFromInput(aliceKeyInput, network);
    const bob = partyKeyFromInput(bobKeyInput, network);
    const aliceXOnly = bytesToHex(alice.xonly);
    const bobXOnly = bytesToHex(bob.xonly);
    if (aliceXOnly === bobXOnly) throw new Error("Alice and Bob must use different keys");
    const claimScript = buildClaimScript(secretHash, bob.xonly);
    const refundScript = buildRefundScript(alice.xonly, t1);
    const tree = swapTaptree(network, claimScript, refundScript);
    for (const [script, cb] of [[claimScript, tree.controlBlocks[0]], [refundScript, tree.controlBlocks[1]]]) {
      if (!verifySwapControlBlock(tree.internalXOnly, script, cb, tree.tweakedX)) {
        throw new Error("internal control-block self-check failed");
      }
    }
    const secrets = [];
    if (alice.priv) secrets.push({ xonly: aliceXOnly, priv: bytesToHex(alice.priv), role: "alice" });
    if (bob.priv) secrets.push({ xonly: bobXOnly, priv: bytesToHex(bob.priv), role: "bob" });
    const swap = {
      kind: SWAP_KIND,
      version: SWAP_VERSION,
      role,
      network: network.id,
      hrp: network.hrp,
      prlGrains,
      btcSats,
      secretHashHex: bytesToHex(secretHash),
      hasPreimage: !!preimage,
      // preimage itself NEVER enters the spec
      t1,
      t2,
      aliceXOnly,
      bobXOnly,
      aliceKeySource: alice.source,
      bobKeySource: bob.source,
      feeRateGrainsPerVByte,
      claimScriptHex: bytesToHex(claimScript),
      claimAsm: swapScriptAsm(claimScript),
      refundScriptHex: bytesToHex(refundScript),
      refundAsm: swapScriptAsm(refundScript),
      internalKeyHex: bytesToHex(tree.internalXOnly),
      tweakedHex: bytesToHex(tree.tweakedX),
      claimControlBlockHex: bytesToHex(tree.controlBlocks[0]),
      refundControlBlockHex: bytesToHex(tree.controlBlocks[1]),
      address: tree.address,
      spkHex: bytesToHex(tree.spk),
      warnings
    };
    swap.descriptor = swapDescriptor(swap);
    return { swap, secrets };
  }
  function swapDescriptor(swap) {
    return `${DESCRIPTOR_PREFIX}:${swap.hrp}:${swap.role}:${swap.prlGrains}:${swap.btcSats}:${swap.secretHashHex}:${swap.t1}:${swap.t2}`;
  }
  function serializeSwap(swap) {
    return JSON.stringify(swap);
  }
  function parseSwapSpec(json, network) {
    let s;
    try {
      s = typeof json === "string" ? JSON.parse(json) : json;
    } catch {
      throw new Error("swap spec is not valid JSON");
    }
    if (!s || s.kind !== SWAP_KIND || s.version !== SWAP_VERSION) {
      throw new Error("not a Pearl Swap spec (kind pearl-swap, version 1)");
    }
    if (s.hrp !== network.hrp) throw new Error(`spec is for ${s.hrp}, not ${network.hrp}`);
    const { swap } = proposeSwap({
      role: s.role,
      network,
      prlGrains: s.prlGrains,
      btcSats: s.btcSats,
      secretHashHex: s.secretHashHex,
      aliceKeyInput: s.aliceXOnly,
      bobKeyInput: s.bobXOnly,
      t1: s.t1,
      t2: s.t2,
      feeRateGrainsPerVByte: s.feeRateGrainsPerVByte
    });
    for (const f of [
      "address",
      "spkHex",
      "claimScriptHex",
      "refundScriptHex",
      "internalKeyHex",
      "tweakedHex",
      "claimControlBlockHex",
      "refundControlBlockHex",
      "aliceXOnly",
      "bobXOnly",
      "secretHashHex",
      "descriptor"
    ]) {
      if (swap[f] !== s[f]) throw new Error(`swap spec failed re-derivation check on ${f} \u2014 the spec was tampered with`);
    }
    if (swap.prlGrains !== s.prlGrains || swap.btcSats !== s.btcSats || swap.t1 !== s.t1 || swap.t2 !== s.t2 || swap.role !== s.role) {
      throw new Error("swap spec failed re-derivation check \u2014 the spec was tampered with");
    }
    return { ...swap, warnings: Array.isArray(s.warnings) ? s.warnings.map(String) : [] };
  }
  function parseDescriptor(descriptor) {
    const t = String(descriptor || "").trim();
    const parts = t.split(":");
    if (parts.length !== 9 || parts[0] !== "swap" || parts[1] !== "v1") {
      throw new Error("bad swap descriptor (expected swap:v1:<hrp>:<role>:<prlGrains>:<btcSats>:<H>:<T1>:<T2>)");
    }
    const prlGrains = Number(parts[4]);
    const btcSats = Number(parts[5]);
    const t1 = Number(parts[7]);
    const t2 = Number(parts[8]);
    if (!Number.isSafeInteger(prlGrains) || !Number.isSafeInteger(btcSats) || !Number.isSafeInteger(t1) || !Number.isSafeInteger(t2)) {
      throw new Error("bad swap descriptor: amounts/heights are not integers");
    }
    if (!/^[0-9a-f]{64}$/i.test(parts[6] || "")) throw new Error("bad swap descriptor: secret hash");
    return {
      hrp: parts[2],
      role: parts[3],
      prlGrains,
      btcSats,
      secretHashHex: parts[6].toLowerCase(),
      t1,
      t2
    };
  }
  function describeSwap(swap) {
    const who = swap.role === "alice" ? "Alice (PRL side, initiator)" : "Bob (BTC side)";
    return {
      role: who,
      address: swap.address,
      prl: (swap.prlGrains / GRAIN_PER_PRL).toFixed(8),
      btc: (swap.btcSats / 1e8).toFixed(8) + " BTC",
      secretHash: swap.secretHashHex,
      t1: swap.t1,
      t2: swap.t2,
      gap: swap.t1 - swap.t2,
      alice: swap.aliceXOnly.slice(0, 16) + "\u2026",
      bob: swap.bobXOnly.slice(0, 16) + "\u2026",
      descriptor: swap.descriptor,
      warnings: swap.warnings || []
    };
  }
  function swapScriptAsm(script) {
    const names = {
      117: "OP_DROP",
      135: "OP_EQUAL",
      136: "OP_EQUALVERIFY",
      168: "OP_SHA256",
      172: "OP_CHECKSIG",
      177: "OP_CHECKLOCKTIMEVERIFY"
    };
    const parts = [];
    let i = 0;
    while (i < script.length) {
      const op = script[i];
      if (op === 0) {
        parts.push("0");
        i++;
        continue;
      }
      if (op >= 81 && op <= 96) {
        parts.push(String(op - 80));
        i++;
        continue;
      }
      if (op <= 75 || op === 76) {
        let len, hlen;
        if (op <= 75) {
          len = op;
          hlen = 1;
        } else {
          len = script[i + 1];
          hlen = 2;
        }
        const data = script.slice(i + hlen, i + hlen + len);
        if (len <= 5) {
          let v = 0;
          for (let k = data.length - 1; k >= 0; k--) v = v * 256 + data[k];
          parts.push(`<${v}>`);
        } else {
          parts.push(`<${bytesToHex(data).slice(0, 12)}\u2026${data.length}B>`);
        }
        i += hlen + len;
        continue;
      }
      parts.push(names[op] || `0x${op.toString(16).padStart(2, "0")}`);
      i++;
    }
    return parts.join(" ");
  }
  function funderKeyFromInput(input, network) {
    const t = String(input || "").trim();
    if (/^[0-9a-fA-F]{64}$/.test(t)) return walletFromPriv(hexToBytes(t.toLowerCase()), network);
    if (/^[1-9A-HJ-NP-Za-km-z]{30,60}$/.test(t)) {
      try {
        return walletFromWIF(t, network);
      } catch {
      }
    }
    const words = t.split(/\s+/);
    if (words.length === 12 || words.length === 24) return walletFromMnemonic(t, network);
    throw new Error("funder key must be a 32-byte hex private key, WIF, or a 12/24-word mnemonic");
  }
  function funderSpkHex(internalXOnly) {
    const { tweakedX } = tweakKeypath(internalXOnly);
    return bytesToHex(p2trScriptPubKey(tweakedX));
  }
  function buildLockTx(network, {
    funderPriv,
    funderInternalXOnly,
    utxos,
    swapProgram,
    prlGrains,
    feeRateGrainsPerVByte
  }) {
    const priv = funderPriv instanceof Uint8Array ? funderPriv : hexToBytes(String(funderPriv).trim().toLowerCase());
    if (priv.length !== 32) throw new Error("funder private key must be 32 bytes");
    const internalXOnly = funderInternalXOnly instanceof Uint8Array ? funderInternalXOnly : hexToBytes(String(funderInternalXOnly).trim().toLowerCase());
    const derived = pubkeyFromPriv(priv);
    if (derived !== bytesToHex(internalXOnly)) {
      throw new Error("funder private key does not match the funder public key");
    }
    if (!(swapProgram instanceof Uint8Array) || swapProgram.length !== 32) {
      throw new Error("swap program must be 32 bytes");
    }
    if (!Number.isSafeInteger(prlGrains) || prlGrains < DUST_GRAIN) {
      throw new Error(`lock amount below dust (${DUST_GRAIN} grains)`);
    }
    if (!Number.isFinite(feeRateGrainsPerVByte) || feeRateGrainsPerVByte <= 0) throw new Error("bad fee rate");
    if (!Array.isArray(utxos) || utxos.length === 0) throw new Error("need at least one funder UTXO");
    const funderSpk = p2trScriptPubKey(tweakKeypath(internalXOnly).tweakedX);
    const funderSpkHex2 = bytesToHex(funderSpk);
    const warnings = [];
    let totalIn = 0;
    const inputs = utxos.map((u, i) => {
      if (!/^[0-9a-f]{64}$/i.test(u?.txid || "")) throw new Error(`utxo ${i}: bad txid`);
      if (!Number.isInteger(u?.vout) || u.vout < 0) throw new Error(`utxo ${i}: bad vout`);
      if (!Number.isSafeInteger(u?.value) || u.value <= 0) throw new Error(`utxo ${i}: bad value`);
      if (u.spkHex) {
        if (String(u.spkHex).trim().toLowerCase() !== funderSpkHex2) {
          throw new Error(`utxo ${i}: scriptPubKey does not belong to the funder address \u2014 refusing`);
        }
      } else {
        warnings.push(`utxo ${i}: belonging not verifiable offline \u2014 confirm it belongs to the funder address`);
      }
      totalIn += u.value;
      return { txid: u.txid.toLowerCase(), vout: u.vout, value: u.value, priv, internalXOnly };
    });
    const changeProgram = tweakKeypath(internalXOnly).tweakedX;
    let nOut = 2;
    let fee = Math.ceil(keypathTxVBytes(inputs.length, nOut) * feeRateGrainsPerVByte);
    let change = totalIn - prlGrains - fee;
    let outputs;
    if (change >= DUST_GRAIN) {
      outputs = [
        { program: swapProgram, value: prlGrains },
        { program: changeProgram, value: change }
      ];
    } else {
      nOut = 1;
      fee = Math.ceil(keypathTxVBytes(inputs.length, nOut) * feeRateGrainsPerVByte);
      change = totalIn - prlGrains - fee;
      if (change < 0) throw new Error(`insufficient funds: need ${prlGrains + fee} grains, have ${totalIn}`);
      if (change > 0) {
        fee += change;
        change = 0;
      }
      outputs = [{ program: swapProgram, value: prlGrains }];
    }
    if (change < 0) throw new Error(`insufficient funds: need ${prlGrains + fee} grains, have ${totalIn}`);
    const built = buildKeypathTx(network, inputs, outputs);
    const parsed = parseTx(built.hex);
    const { tweakedX } = tweakKeypath(internalXOnly);
    const digestInputs = inputs.map((inp) => ({ txid: inp.txid, vout: inp.vout, value: inp.value, spk: funderSpk }));
    parsed.inputs.forEach((pin, i) => {
      if (pin.witness.length !== 1 || pin.witness[0].length !== 64) {
        throw new Error(`lock tx: input ${i} witness is not a single 64-byte signature`);
      }
      const digest = keypathSigDigestEx(network, digestInputs, outputs, MAX_SEQ2, i, 0);
      if (!verifySchnorrSig(pin.witness[0], digest, tweakedX)) {
        throw new Error(`lock tx: input ${i} signature failed re-verification \u2014 refusing to expose the hex`);
      }
    });
    return {
      txid: built.txid,
      hex: built.hex,
      feeGrains: fee,
      vBytes: keypathTxVBytes(inputs.length, nOut),
      changeGrains: change,
      warnings
    };
  }
  function claimSpendVBytes(swap) {
    return spendVBytes({
      nOut: 1,
      scriptLen: swap.claimScriptHex.length / 2,
      controlLen: 65,
      stackLens: [64, PREIMAGE_LEN]
      // bob_sig + preimage
    });
  }
  function buildClaimSpend(network, swap, {
    utxo,
    preimageHex,
    bobPrivHex,
    destAddress,
    feeRateGrainsPerVByte
  }) {
    const preimage = parsePreimage(preimageHex);
    if (bytesToHex(secretHashOf(preimage)) !== swap.secretHashHex) {
      throw new Error("preimage does not hash to the swap's secret hash \u2014 claim refused");
    }
    const bobXOnly = pubkeyFromPriv(bobPrivHex);
    if (bobXOnly !== swap.bobXOnly) {
      throw new Error("this key is not Bob's claim key for this swap \u2014 claim refused");
    }
    if (!/^[0-9a-f]{64}$/i.test(utxo?.txid || "")) throw new Error("bad utxo txid");
    if (!Number.isInteger(utxo?.vout) || utxo.vout < 0) throw new Error("bad utxo vout");
    if (!Number.isSafeInteger(utxo?.value) || utxo.value <= 0) throw new Error("bad utxo value");
    if (!Number.isFinite(feeRateGrainsPerVByte) || feeRateGrainsPerVByte <= 0) throw new Error("bad fee rate");
    const destProgram = addressToProgram(destAddress, network);
    const fee = Math.ceil(claimSpendVBytes(swap) * feeRateGrainsPerVByte);
    const value = utxo.value - fee;
    if (value < DUST_GRAIN) {
      throw new Error(`claim output ${value} grains is below dust after fees \u2014 UTXO too small`);
    }
    const claimScript = hexToBytes(swap.claimScriptHex);
    const controlBlock = hexToBytes(swap.claimControlBlockHex);
    const input = { txid: utxo.txid.toLowerCase(), vout: utxo.vout, value: utxo.value, spk: hexToBytes(swap.spkHex) };
    const outputs = [{ program: destProgram, value }];
    const digest = scriptPathSigDigestEx(network, input, outputs, claimScript, {});
    const sig = signForXOnly(hexToBytes(String(bobPrivHex).trim().toLowerCase()), digest);
    if (!verifySchnorrSig(sig, digest, hexToBytes(swap.bobXOnly))) {
      throw new Error("claim signature failed re-verification \u2014 refusing to build the tx");
    }
    const spend = buildScriptPathSpend(
      network,
      input,
      outputs,
      claimScript,
      controlBlock,
      [sig, preimage],
      {}
    );
    if (spend.digest !== bytesToHex(digest)) throw new Error("internal: claim digest mismatch");
    return { ...spend, feeGrains: fee, preimageHex: bytesToHex(preimage) };
  }
  function refundSpendVBytes(swap) {
    return spendVBytes({
      nOut: 1,
      scriptLen: swap.refundScriptHex.length / 2,
      controlLen: 65,
      stackLens: [64]
      // alice_sig
    });
  }
  function buildRefundSpend(network, swap, {
    utxo,
    alicePrivHex,
    destAddress,
    feeRateGrainsPerVByte,
    currentHeight
  }) {
    if (!Number.isSafeInteger(currentHeight) || currentHeight < 0) throw new Error("bad current height");
    if (currentHeight < swap.t1) {
      throw new Error(`refund not yet mature: chain height ${currentHeight} < T1 ${swap.t1} (${swap.t1 - currentHeight} blocks to go)`);
    }
    const aliceXOnly = pubkeyFromPriv(alicePrivHex);
    if (aliceXOnly !== swap.aliceXOnly) {
      throw new Error("this key is not Alice's refund key for this swap \u2014 refund refused");
    }
    if (!/^[0-9a-f]{64}$/i.test(utxo?.txid || "")) throw new Error("bad utxo txid");
    if (!Number.isInteger(utxo?.vout) || utxo.vout < 0) throw new Error("bad utxo vout");
    if (!Number.isSafeInteger(utxo?.value) || utxo.value <= 0) throw new Error("bad utxo value");
    if (!Number.isFinite(feeRateGrainsPerVByte) || feeRateGrainsPerVByte <= 0) throw new Error("bad fee rate");
    const destProgram = addressToProgram(destAddress, network);
    const fee = Math.ceil(refundSpendVBytes(swap) * feeRateGrainsPerVByte);
    const value = utxo.value - fee;
    if (value < DUST_GRAIN) {
      throw new Error(`refund output ${value} grains is below dust after fees \u2014 UTXO too small`);
    }
    const refundScript = hexToBytes(swap.refundScriptHex);
    const controlBlock = hexToBytes(swap.refundControlBlockHex);
    const input = { txid: utxo.txid.toLowerCase(), vout: utxo.vout, value: utxo.value, spk: hexToBytes(swap.spkHex) };
    const outputs = [{ program: destProgram, value }];
    const digest = scriptPathSigDigestEx(
      network,
      input,
      outputs,
      refundScript,
      { sequence: REFUND_SEQUENCE, locktime: swap.t1 }
    );
    const sig = signForXOnly(hexToBytes(String(alicePrivHex).trim().toLowerCase()), digest);
    if (!verifySchnorrSig(sig, digest, hexToBytes(swap.aliceXOnly))) {
      throw new Error("refund signature failed re-verification \u2014 refusing to build the tx");
    }
    const spend = buildScriptPathSpend(
      network,
      input,
      outputs,
      refundScript,
      controlBlock,
      [sig],
      { sequence: REFUND_SEQUENCE, locktime: swap.t1 }
    );
    if (spend.digest !== bytesToHex(digest)) throw new Error("internal: refund digest mismatch");
    const parsed = parseTx(spend.hex);
    if (parsed.locktime !== swap.t1) throw new Error("internal: refund locktime != T1");
    if (parsed.inputs[0].sequence !== REFUND_SEQUENCE) throw new Error("internal: refund sequence != 0xfffffffe");
    return { ...spend, feeGrains: fee };
  }
  function parseTx(txHex) {
    const raw = hexToBytes(String(txHex).trim().toLowerCase());
    if (raw.length < 10) throw new Error("tx too short");
    let o = 0;
    const read = (n) => {
      if (o + n > raw.length) throw new Error("tx truncated");
      const s = raw.slice(o, o + n);
      o += n;
      return s;
    };
    const readU32 = () => {
      const b = read(4);
      return (b[0] | b[1] << 8 | b[2] << 16 | b[3] << 24) >>> 0;
    };
    const readU64 = () => {
      const b = read(8);
      let v = 0n;
      for (let i = 7; i >= 0; i--) v = v << 8n | BigInt(b[i]);
      if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("value out of range");
      return Number(v);
    };
    const readVarint = () => {
      const f = read(1)[0];
      if (f < 253) return f;
      if (f === 253) {
        const b = read(2);
        return b[0] | b[1] << 8;
      }
      if (f === 254) return readU32();
      throw new Error("64-bit varint unsupported");
    };
    const version = readU32();
    let segwit = false;
    if (raw[o] === 0 && raw[o + 1] === 1) {
      segwit = true;
      o += 2;
    }
    const nIn = readVarint();
    if (nIn === 0) throw new Error("tx has no inputs");
    const inputs = [];
    for (let i = 0; i < nIn; i++) {
      const prev = read(32);
      const txid = bytesToHex(Uint8Array.from(prev).reverse());
      const vout = readU32();
      const slen = readVarint();
      const scriptSig = read(slen);
      const sequence = readU32();
      inputs.push({ txid, vout, sequence, scriptSig, witness: [] });
    }
    const nOut = readVarint();
    const outputs = [];
    for (let i = 0; i < nOut; i++) {
      const value = readU64();
      const slen = readVarint();
      const spk = read(slen);
      outputs.push({ value, spk });
    }
    if (segwit) {
      for (const inp of inputs) {
        const n = readVarint();
        for (let i = 0; i < n; i++) {
          const l = readVarint();
          inp.witness.push(read(l));
        }
      }
    }
    const locktime = readU32();
    if (o !== raw.length) throw new Error("tx has trailing bytes");
    return { version, inputs, outputs, locktime, segwit };
  }
  function extractPreimage(claimTxHex, secretHashHex) {
    const H = String(secretHashHex).trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(H)) throw new Error("bad secret hash");
    const tx = parseTx(claimTxHex);
    for (const inp of tx.inputs) {
      for (const item of inp.witness) {
        if (item.length === PREIMAGE_LEN && bytesToHex(sha2562(item)) === H) {
          return bytesToHex(item);
        }
      }
    }
    throw new Error("no preimage revealed in this transaction's witnesses \u2014 is this Bob's claim tx?");
  }
  function classifySwapState(swap, { fundingSeen, spends }) {
    const list = Array.isArray(spends) ? spends : [];
    for (const s of list) {
      let tx;
      try {
        tx = parseTx(s.hex);
      } catch {
        continue;
      }
      let preimage = null;
      for (const inp of tx.inputs) {
        for (const item of inp.witness) {
          if (item.length === PREIMAGE_LEN && bytesToHex(sha2562(item)) === swap.secretHashHex) {
            preimage = bytesToHex(item);
          }
        }
      }
      if (preimage) return { state: "claimed", txid: s.txid, preimageHex: preimage };
      if (tx.locktime >= swap.t1) return { state: "refunded", txid: s.txid };
      return { state: "spent-unknown", txid: s.txid };
    }
    return { state: fundingSeen ? "locked" : "awaiting-funding" };
  }
  function swapCountdown(swap, tipHeight) {
    const toGo = (h) => Math.max(0, h - tipHeight);
    return {
      tipHeight,
      blocksToT1: toGo(swap.t1),
      blocksToT2: toGo(swap.t2),
      etaSecsToT1: toGo(swap.t1) * PEARL_BLOCK_SECS,
      etaSecsToT2: toGo(swap.t2) * PEARL_BLOCK_SECS,
      t1Mature: tipHeight >= swap.t1,
      t2Reached: tipHeight >= swap.t2
    };
  }
  function btcMirrorTemplate(swap, opts = {}) {
    const btcNetwork = opts.btcNetwork === "testnet" ? "testnet" : "mainnet";
    const hrp = btcNetwork === "mainnet" ? "bc" : "tb";
    const secretHash = hexToBytes(swap.secretHashHex);
    const bobXOnly = hexToBytes(swap.bobXOnly);
    const claimScript = buildClaimScript(secretHash, bobXOnly);
    let t2Btc = null;
    let conversionNote;
    if (Number.isSafeInteger(opts.btcTip) && Number.isSafeInteger(opts.pearlTip)) {
      const pearlSecsToT2 = Math.max(0, swap.t2 - opts.pearlTip) * PEARL_BLOCK_SECS;
      const btcBlocks = Math.ceil(pearlSecsToT2 / BTC_BLOCK_SECS);
      t2Btc = opts.btcTip + btcBlocks + MIN_TIP_CLEARANCE;
      conversionNote = `T2 (Pearl height ${swap.t2}) is ~${Math.round(pearlSecsToT2 / 3600)}h after Pearl tip ${opts.pearlTip}; +${btcBlocks} Bitcoin blocks from tip ${opts.btcTip}, plus ${MIN_TIP_CLEARANCE} safety blocks \u2192 suggested Bitcoin refund height ${t2Btc}. Recompute from live tips before funding.`;
    } else {
      conversionNote = `No chain tips supplied, so no Bitcoin height is suggested. Convert T2 yourself: btcHeight = btcTip + ceil(((T2 - pearlTip) * ${PEARL_BLOCK_SECS}) / ${BTC_BLOCK_SECS}) + ${MIN_TIP_CLEARANCE}. Example: Pearl tip 120000, T2 ${swap.t2} \u2192 ${(swap.t2 - 12e4) * PEARL_BLOCK_SECS / 3600 >= 0 ? "~" + Math.round((swap.t2 - 12e4) * PEARL_BLOCK_SECS / 3600) + "h" : "in the past"}; at Bitcoin tip 870000 that is height ${87e4 + Math.ceil(Math.max(0, swap.t2 - 12e4) * PEARL_BLOCK_SECS / BTC_BLOCK_SECS) + MIN_TIP_CLEARANCE}.`;
    }
    const refundScript = t2Btc === null ? null : buildRefundScript(bobXOnly, t2Btc);
    let address = null, tweakedHex = null, internalKeyHex = null, controlBlocksHex = null, refundScriptHex = null, refundAsm = null;
    if (refundScript) {
      const tree = swapTaptree({ hrp }, claimScript, refundScript);
      address = tree.address;
      tweakedHex = bytesToHex(tree.tweakedX);
      internalKeyHex = bytesToHex(tree.internalXOnly);
      controlBlocksHex = tree.controlBlocks.map(bytesToHex);
      refundScriptHex = bytesToHex(refundScript);
      refundAsm = swapScriptAsm(refundScript);
      for (const [script, cb] of [[claimScript, tree.controlBlocks[0]], [refundScript, tree.controlBlocks[1]]]) {
        if (!verifySwapControlBlock(tree.internalXOnly, script, cb, tree.tweakedX)) {
          throw new Error("internal BTC mirror control-block self-check failed");
        }
      }
    }
    const steps = [
      `1. Confirm the secret hash H = ${swap.secretHashHex} matches what Alice published (SHA-256 of her preimage).`,
      `2. Reproduce the HTLC scripts below with your own Bitcoin tooling \u2014 the claim leaf is byte-identical on both chains.`,
      `3. Derive the ${hrp === "bc" ? "mainnet bc1p" : "testnet tb1p"} address from the scripts (NUMS internal key H("PearlSwapNUMS/v1" || claimLeafHash || refundLeafHash), BIP-341 taptree, bech32m). The page computed ${address || "(address needs live chain tips \u2014 see conversion note)"} \u2014 verify it independently before funding.`,
      `4. Fund the BTC address with exactly ${swap.btcSats} sats (${(swap.btcSats / 1e8).toFixed(8)} BTC) and wait for confirmations.`,
      `5. Verify Alice's PRL lock is confirmed at the Pearl swap address ${swap.address} before considering the swap live.`,
      `6. To claim the PRL: sign a Pearl script-path spend of the claim leaf revealing the preimage (Bob's key + preimage witness). Your claim tx reveals the preimage on Pearl \u2014 Alice then uses it to claim the BTC.`,
      `7. If Alice never locks (or you abort): after Bitcoin height ${t2Btc === null ? "(compute from live chain tips first)" : t2Btc} (your refund timeout), refund the BTC with nLockTime = that height and input sequence 0xfffffffe.`,
      `8. NEVER reuse a preimage across swaps. Clear secrets after the swap settles.`
    ];
    return {
      btcNetwork,
      hrp,
      claimScriptHex: bytesToHex(claimScript),
      claimAsm: swapScriptAsm(claimScript),
      refundScriptHex,
      refundAsm,
      suggestedBtcRefundHeight: t2Btc,
      conversionNote,
      address,
      tweakedHex,
      internalKeyHex,
      controlBlocksHex,
      steps,
      honestNote: "Pearl Swap does not build or sign Bitcoin transactions. The BTC HTLC above must be assembled, funded, and spent with the counterparty's own Bitcoin wallet or tooling \u2014 this template gives the exact scripts and parameters so any implementation reproduces the same address."
    };
  }
  return __toCommonJS(index_exports);
})();
/*! noble-hashes - MIT License (c) 2022 Paul Miller (paulmillr.com) */
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
/*! scure-base - MIT License (c) 2022 Paul Miller (paulmillr.com) */
/*! scure-bip32 - MIT License (c) 2022 Patricio Palladino, Paul Miller (paulmillr.com) */
/*! scure-bip39 - MIT License (c) 2022 Patricio Palladino, Paul Miller (paulmillr.com) */
