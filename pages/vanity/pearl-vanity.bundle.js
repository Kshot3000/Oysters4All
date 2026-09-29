/* Pearl Vanity bundle (window.PearlVanity) — built with esbuild from src/index.js. Do not edit by hand; run `node build.mjs`. */
var PearlVanity = (() => {
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
    BECH32_CHARSET: () => BECH32_CHARSET,
    MAX_PREFIX_LEN: () => MAX_PREFIX_LEN,
    MIN_PREFIX_LEN: () => MIN_PREFIX_LEN,
    NETWORKS: () => NETWORKS,
    WORKER_SRC: () => WORKER_SRC,
    addressMatches: () => addressMatches,
    bip86AccountNode: () => bip86AccountNode,
    bip86ChildPriv: () => bip86ChildPriv,
    bytesToHex: () => bytesToHex,
    decodeVanityAddress: () => decodeVanityAddress,
    expectedAttempts: () => expectedAttempts,
    formatBig: () => formatBig,
    formatDuration: () => formatDuration,
    fullTarget: () => fullTarget,
    grindBatch: () => grindBatch,
    hexToBytes: () => hexToBytes,
    hitProbability: () => hitProbability,
    newVanityMnemonic: () => newVanityMnemonic,
    normalizePrefix: () => normalizePrefix,
    proveKeyControl: () => proveKeyControl,
    randomScalar: () => randomScalar,
    schnorr: () => schnorr,
    seedFromMnemonic: () => seedFromMnemonic,
    vanityFromPriv: () => vanityFromPriv,
    vanityFromWIF: () => vanityFromWIF,
    vanityToWIF: () => vanityToWIF,
    verifyFound: () => verifyFound
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

  // ../sign/src/crypto.js
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
  var b58check = createBase58check(sha2562);
  function walletToWIF(priv, network) {
    const payload = new Uint8Array(34);
    payload[0] = network.wifVersion;
    payload.set(priv, 1);
    payload[33] = 1;
    return b58check.encode(payload);
  }

  // src/vanity-core.js
  var BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  var MAX_PREFIX_LEN = 5;
  var MIN_PREFIX_LEN = 1;
  function normalizePrefix(raw) {
    const s = String(raw ?? "").trim().toLowerCase();
    if (s.length < MIN_PREFIX_LEN) return { error: `Type at least ${MIN_PREFIX_LEN} character.` };
    if (s.length > MAX_PREFIX_LEN)
      return { error: `Keep it to ${MAX_PREFIX_LEN} characters \u2014 32^${s.length} combinations is not a browser job.` };
    for (const ch of s) {
      if (!BECH32_CHARSET.includes(ch)) {
        const hint = ch === "1" ? " \u2014 '1' is the bech32 separator and can never appear in the data part" : "bii o".includes(ch) && "bio".includes(ch) ? " \u2014 bech32 drops b, i, o to avoid look-alikes" : "";
        return { error: `Character '${ch}' is not in the bech32 alphabet${hint}.` };
      }
    }
    return { prefix: s };
  }
  function expectedAttempts(prefixLen) {
    return 32n ** BigInt(prefixLen);
  }
  function hitProbability(attempts, prefixLen) {
    const p = 1 / Number(expectedAttempts(prefixLen));
    const k = Number(attempts);
    if (!Number.isFinite(k) || k < 0) return 0;
    return 1 - Math.exp(-k * p);
  }
  function formatBig(n) {
    const s = n.toString();
    return s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }
  function formatDuration(seconds) {
    if (!Number.isFinite(seconds)) return "\u2014";
    if (seconds < 1) return "< 1 second";
    const units = [
      ["day", 86400],
      ["hour", 3600],
      ["minute", 60],
      ["second", 1]
    ];
    const parts = [];
    let rem = Math.floor(seconds);
    for (const [name, size] of units) {
      const v = Math.floor(rem / size);
      if (v > 0) {
        parts.push(`${v} ${name}${v > 1 ? "s" : ""}`);
        rem -= v * size;
      }
      if (parts.length === 2) break;
    }
    return parts.join(" ") || "< 1 second";
  }
  function randomScalar(rng) {
    const n = secp256k1.CURVE.n;
    for (; ; ) {
      const b = rng(32);
      if (!(b instanceof Uint8Array) || b.length !== 32) throw new Error("rng must return 32 bytes");
      let zero = true;
      for (let i = 0; i < 32; i++) if (b[i] !== 0) {
        zero = false;
        break;
      }
      if (zero) continue;
      if (bytesToNumberBE2(b) >= n) continue;
      return b;
    }
  }
  function vanityFromPriv(priv, network) {
    const p = priv instanceof Uint8Array ? priv : hexToBytes(priv);
    if (p.length !== 32) throw new Error("private key must be 32 bytes");
    const xonly = schnorr.getPublicKey(p);
    return {
      priv: p,
      xonly,
      address: encodeBech32m(network.hrp, 1, xonly),
      network
    };
  }
  function vanityToWIF(priv, network) {
    const p = priv instanceof Uint8Array ? priv : hexToBytes(priv);
    return walletToWIF(p, network);
  }
  function vanityFromWIF(wif, network) {
    return vanityFromPriv(decodeRawWIF(wif, network), network);
  }
  function decodeRawWIF(wif, network) {
    const b58check2 = createBase58check(sha2562);
    const raw = b58check2.decode(String(wif).trim());
    if (raw.length < 33) throw new Error("invalid WIF payload length");
    if (raw[0] !== network.wifVersion) throw new Error("wrong WIF network version");
    let key = raw.slice(1);
    if (key.length === 33 && key[32] === 1) key = key.slice(0, 32);
    if (key.length !== 32) throw new Error("invalid WIF key length");
    return key;
  }
  function seedFromMnemonic(mnemonic) {
    const words = String(mnemonic ?? "").trim().split(/\s+/);
    if (words.length !== 12 && words.length !== 24) throw new Error("Enter a 12- or 24-word BIP-39 mnemonic.");
    if (!validateMnemonic(words.join(" "), wordlist)) throw new Error("Mnemonic failed checksum validation \u2014 check the words.");
    return mnemonicToSeedSync(words.join(" "));
  }
  function newVanityMnemonic() {
    return generateMnemonic(wordlist, 128);
  }
  function bip86AccountNode(seedBytes, network, account) {
    if (!Number.isInteger(account) || account < 0 || account > 2147483647) throw new Error("bad account");
    const root = HDKey.fromMasterSeed(seedBytes);
    return {
      node: root.derive(`m/86'/${network.coinType}'/${account}'`),
      account,
      network
    };
  }
  function bip86ChildPriv(accountNode, index) {
    if (!Number.isInteger(index) || index < 0 || index > 2147483647) throw new Error("bad index");
    const child = accountNode.node.deriveChild(0).deriveChild(index);
    if (!child.privateKey) throw new Error("derivation failed");
    return { priv: child.privateKey, path: `m/86'/${accountNode.network.coinType}'/${accountNode.account}'/0/${index}` };
  }
  function fullTarget(networkId, prefix) {
    const hrp = NETWORKS[networkId].hrp;
    return `${hrp}1p${prefix}`;
  }
  function addressMatches(address, networkId, prefix) {
    return address.startsWith(fullTarget(networkId, prefix));
  }
  function grindBatch(opts) {
    const { prefix, networkId, mode, startIndex, batchSize, rng } = opts;
    const network = NETWORKS[networkId];
    if (!network) throw new Error("unknown network");
    const norm = normalizePrefix(prefix);
    if (norm.error) throw new Error(norm.error);
    const want = fullTarget(networkId, norm.prefix);
    let scanned = 0;
    for (let i = 0; i < batchSize; i++) {
      let priv, path = null, index = null;
      if (mode === "random") {
        priv = randomScalar(rng);
      } else if (mode === "bip86") {
        if (!opts.accountNode) throw new Error("bip86 mode needs accountNode");
        index = startIndex + i * (opts.stride || 1);
        const c = bip86ChildPriv(opts.accountNode, index);
        priv = c.priv;
        path = c.path;
      } else {
        throw new Error("unknown grind mode");
      }
      const w = vanityFromPriv(priv, network);
      scanned++;
      if (w.address.startsWith(want)) {
        return {
          scanned,
          found: {
            address: w.address,
            xonlyHex: bytesToHex(w.xonly),
            privHex: bytesToHex(w.priv),
            wif: vanityToWIF(w.priv, network),
            mode,
            path,
            index,
            networkId
          }
        };
      }
    }
    return { scanned, found: null };
  }
  function verifyFound(found, prefix) {
    const network = NETWORKS[found.networkId];
    if (!network) return { ok: false, error: "unknown network" };
    const norm = normalizePrefix(prefix);
    if (norm.error) return { ok: false, error: norm.error };
    const w = vanityFromPriv(hexToBytes(found.privHex), network);
    if (w.address !== found.address) return { ok: false, error: "address does not re-derive from the private key" };
    if (!w.address.startsWith(fullTarget(found.networkId, norm.prefix)))
      return { ok: false, error: "address does not match the requested prefix" };
    return { ok: true, xonlyHex: bytesToHex(w.xonly) };
  }
  function proveKeyControl(privHex, messageBytes) {
    const priv = hexToBytes(privHex);
    const xonly = schnorr.getPublicKey(priv);
    const sig = schnorr.sign(messageBytes, priv);
    const ok = schnorr.verify(sig, messageBytes, xonly);
    return { ok, sigHex: bytesToHex(sig), xonlyHex: bytesToHex(xonly) };
  }
  function decodeVanityAddress(address, networkId) {
    const network = NETWORKS[networkId];
    const d = decodeBech32m(address, network.hrp);
    if (d.version !== 1) throw new Error("not a v1 (Taproot) address");
    if (d.program.length !== 32) throw new Error("program is not 32 bytes");
    return bytesToHex(d.program);
  }

  // src/worker-src.js
  var WORKER_SRC = '/* Pearl Vanity worker (grind-worker.js) \u2014 grind bundle + driver, generated by `node build.mjs`. Do not edit by hand. */\n/* Pearl Vanity bundle (window.PearlVanityGrind) \u2014 built with esbuild from src/grind-entry.js. Do not edit by hand; run `node build.mjs`. */\nvar PearlVanityGrind = (() => {\n  var __defProp = Object.defineProperty;\n  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;\n  var __getOwnPropNames = Object.getOwnPropertyNames;\n  var __hasOwnProp = Object.prototype.hasOwnProperty;\n  var __export = (target, all) => {\n    for (var name in all)\n      __defProp(target, name, { get: all[name], enumerable: true });\n  };\n  var __copyProps = (to, from, except, desc) => {\n    if (from && typeof from === "object" || typeof from === "function") {\n      for (let key of __getOwnPropNames(from))\n        if (!__hasOwnProp.call(to, key) && key !== except)\n          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });\n    }\n    return to;\n  };\n  var __toCommonJS = (mod2) => __copyProps(__defProp({}, "__esModule", { value: true }), mod2);\n\n  // src/grind-entry.js\n  var grind_entry_exports = {};\n  __export(grind_entry_exports, {\n    BECH32_CHARSET: () => BECH32_CHARSET,\n    MAX_PREFIX_LEN: () => MAX_PREFIX_LEN,\n    MIN_PREFIX_LEN: () => MIN_PREFIX_LEN,\n    NETWORKS: () => NETWORKS,\n    addressMatches: () => addressMatches,\n    bip86AccountNode: () => bip86AccountNode,\n    bip86ChildPriv: () => bip86ChildPriv,\n    bytesToHex: () => bytesToHex,\n    decodeVanityAddress: () => decodeVanityAddress,\n    expectedAttempts: () => expectedAttempts,\n    formatBig: () => formatBig,\n    formatDuration: () => formatDuration,\n    fullTarget: () => fullTarget,\n    grindBatch: () => grindBatch,\n    hexToBytes: () => hexToBytes,\n    hitProbability: () => hitProbability,\n    newVanityMnemonic: () => newVanityMnemonic,\n    normalizePrefix: () => normalizePrefix,\n    proveKeyControl: () => proveKeyControl,\n    randomScalar: () => randomScalar,\n    schnorr: () => schnorr,\n    seedFromMnemonic: () => seedFromMnemonic,\n    vanityFromPriv: () => vanityFromPriv,\n    vanityFromWIF: () => vanityFromWIF,\n    vanityToWIF: () => vanityToWIF,\n    verifyFound: () => verifyFound\n  });\n\n  // ../sign/lib/noble-hashes/crypto.js\n  var crypto = typeof globalThis === "object" && "crypto" in globalThis ? globalThis.crypto : void 0;\n\n  // ../sign/lib/noble-hashes/utils.js\n  function isBytes(a) {\n    return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array";\n  }\n  function anumber(n) {\n    if (!Number.isSafeInteger(n) || n < 0)\n      throw new Error("positive integer expected, got " + n);\n  }\n  function abytes(b, ...lengths) {\n    if (!isBytes(b))\n      throw new Error("Uint8Array expected");\n    if (lengths.length > 0 && !lengths.includes(b.length))\n      throw new Error("Uint8Array expected of length " + lengths + ", got length=" + b.length);\n  }\n  function ahash(h) {\n    if (typeof h !== "function" || typeof h.create !== "function")\n      throw new Error("Hash should be wrapped by utils.createHasher");\n    anumber(h.outputLen);\n    anumber(h.blockLen);\n  }\n  function aexists(instance, checkFinished = true) {\n    if (instance.destroyed)\n      throw new Error("Hash instance has been destroyed");\n    if (checkFinished && instance.finished)\n      throw new Error("Hash#digest() has already been called");\n  }\n  function aoutput(out, instance) {\n    abytes(out);\n    const min = instance.outputLen;\n    if (out.length < min) {\n      throw new Error("digestInto() expects output buffer of length at least " + min);\n    }\n  }\n  function clean(...arrays) {\n    for (let i = 0; i < arrays.length; i++) {\n      arrays[i].fill(0);\n    }\n  }\n  function createView(arr) {\n    return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);\n  }\n  function rotr(word, shift) {\n    return word << 32 - shift | word >>> shift;\n  }\n  function rotl(word, shift) {\n    return word << shift | word >>> 32 - shift >>> 0;\n  }\n  var hasHexBuiltin = /* @__PURE__ */ (() => (\n    // @ts-ignore\n    typeof Uint8Array.from([]).toHex === "function" && typeof Uint8Array.fromHex === "function"\n  ))();\n  var hexes = /* @__PURE__ */ Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));\n  function bytesToHex(bytes) {\n    abytes(bytes);\n    if (hasHexBuiltin)\n      return bytes.toHex();\n    let hex = "";\n    for (let i = 0; i < bytes.length; i++) {\n      hex += hexes[bytes[i]];\n    }\n    return hex;\n  }\n  var asciis = { _0: 48, _9: 57, A: 65, F: 70, a: 97, f: 102 };\n  function asciiToBase16(ch) {\n    if (ch >= asciis._0 && ch <= asciis._9)\n      return ch - asciis._0;\n    if (ch >= asciis.A && ch <= asciis.F)\n      return ch - (asciis.A - 10);\n    if (ch >= asciis.a && ch <= asciis.f)\n      return ch - (asciis.a - 10);\n    return;\n  }\n  function hexToBytes(hex) {\n    if (typeof hex !== "string")\n      throw new Error("hex string expected, got " + typeof hex);\n    if (hasHexBuiltin)\n      return Uint8Array.fromHex(hex);\n    const hl = hex.length;\n    const al = hl / 2;\n    if (hl % 2)\n      throw new Error("hex string expected, got unpadded hex of length " + hl);\n    const array = new Uint8Array(al);\n    for (let ai = 0, hi = 0; ai < al; ai++, hi += 2) {\n      const n1 = asciiToBase16(hex.charCodeAt(hi));\n      const n2 = asciiToBase16(hex.charCodeAt(hi + 1));\n      if (n1 === void 0 || n2 === void 0) {\n        const char = hex[hi] + hex[hi + 1];\n        throw new Error(\'hex string expected, got non-hex character "\' + char + \'" at index \' + hi);\n      }\n      array[ai] = n1 * 16 + n2;\n    }\n    return array;\n  }\n  function utf8ToBytes(str) {\n    if (typeof str !== "string")\n      throw new Error("string expected");\n    return new Uint8Array(new TextEncoder().encode(str));\n  }\n  function toBytes(data) {\n    if (typeof data === "string")\n      data = utf8ToBytes(data);\n    abytes(data);\n    return data;\n  }\n  function kdfInputToBytes(data) {\n    if (typeof data === "string")\n      data = utf8ToBytes(data);\n    abytes(data);\n    return data;\n  }\n  function concatBytes(...arrays) {\n    let sum = 0;\n    for (let i = 0; i < arrays.length; i++) {\n      const a = arrays[i];\n      abytes(a);\n      sum += a.length;\n    }\n    const res = new Uint8Array(sum);\n    for (let i = 0, pad = 0; i < arrays.length; i++) {\n      const a = arrays[i];\n      res.set(a, pad);\n      pad += a.length;\n    }\n    return res;\n  }\n  function checkOpts(defaults, opts) {\n    if (opts !== void 0 && {}.toString.call(opts) !== "[object Object]")\n      throw new Error("options should be object or undefined");\n    const merged = Object.assign(defaults, opts);\n    return merged;\n  }\n  var Hash = class {\n  };\n  function createHasher(hashCons) {\n    const hashC = (msg) => hashCons().update(toBytes(msg)).digest();\n    const tmp = hashCons();\n    hashC.outputLen = tmp.outputLen;\n    hashC.blockLen = tmp.blockLen;\n    hashC.create = () => hashCons();\n    return hashC;\n  }\n  function randomBytes(bytesLength = 32) {\n    if (crypto && typeof crypto.getRandomValues === "function") {\n      return crypto.getRandomValues(new Uint8Array(bytesLength));\n    }\n    if (crypto && typeof crypto.randomBytes === "function") {\n      return Uint8Array.from(crypto.randomBytes(bytesLength));\n    }\n    throw new Error("crypto.getRandomValues must be defined");\n  }\n\n  // ../sign/lib/noble-curves/utils.js\n  var _0n = /* @__PURE__ */ BigInt(0);\n  var _1n = /* @__PURE__ */ BigInt(1);\n  function _abool2(value, title = "") {\n    if (typeof value !== "boolean") {\n      const prefix = title && `"${title}"`;\n      throw new Error(prefix + "expected boolean, got type=" + typeof value);\n    }\n    return value;\n  }\n  function _abytes2(value, length, title = "") {\n    const bytes = isBytes(value);\n    const len = value?.length;\n    const needsLen = length !== void 0;\n    if (!bytes || needsLen && len !== length) {\n      const prefix = title && `"${title}" `;\n      const ofLen = needsLen ? ` of length ${length}` : "";\n      const got = bytes ? `length=${len}` : `type=${typeof value}`;\n      throw new Error(prefix + "expected Uint8Array" + ofLen + ", got " + got);\n    }\n    return value;\n  }\n  function numberToHexUnpadded(num2) {\n    const hex = num2.toString(16);\n    return hex.length & 1 ? "0" + hex : hex;\n  }\n  function hexToNumber(hex) {\n    if (typeof hex !== "string")\n      throw new Error("hex string expected, got " + typeof hex);\n    return hex === "" ? _0n : BigInt("0x" + hex);\n  }\n  function bytesToNumberBE(bytes) {\n    return hexToNumber(bytesToHex(bytes));\n  }\n  function bytesToNumberLE(bytes) {\n    abytes(bytes);\n    return hexToNumber(bytesToHex(Uint8Array.from(bytes).reverse()));\n  }\n  function numberToBytesBE(n, len) {\n    return hexToBytes(n.toString(16).padStart(len * 2, "0"));\n  }\n  function numberToBytesLE(n, len) {\n    return numberToBytesBE(n, len).reverse();\n  }\n  function ensureBytes(title, hex, expectedLength) {\n    let res;\n    if (typeof hex === "string") {\n      try {\n        res = hexToBytes(hex);\n      } catch (e) {\n        throw new Error(title + " must be hex string or Uint8Array, cause: " + e);\n      }\n    } else if (isBytes(hex)) {\n      res = Uint8Array.from(hex);\n    } else {\n      throw new Error(title + " must be hex string or Uint8Array");\n    }\n    const len = res.length;\n    if (typeof expectedLength === "number" && len !== expectedLength)\n      throw new Error(title + " of length " + expectedLength + " expected, got " + len);\n    return res;\n  }\n  var isPosBig = (n) => typeof n === "bigint" && _0n <= n;\n  function inRange(n, min, max) {\n    return isPosBig(n) && isPosBig(min) && isPosBig(max) && min <= n && n < max;\n  }\n  function aInRange(title, n, min, max) {\n    if (!inRange(n, min, max))\n      throw new Error("expected valid " + title + ": " + min + " <= n < " + max + ", got " + n);\n  }\n  function bitLen(n) {\n    let len;\n    for (len = 0; n > _0n; n >>= _1n, len += 1)\n      ;\n    return len;\n  }\n  var bitMask = (n) => (_1n << BigInt(n)) - _1n;\n  function createHmacDrbg(hashLen, qByteLen, hmacFn) {\n    if (typeof hashLen !== "number" || hashLen < 2)\n      throw new Error("hashLen must be a number");\n    if (typeof qByteLen !== "number" || qByteLen < 2)\n      throw new Error("qByteLen must be a number");\n    if (typeof hmacFn !== "function")\n      throw new Error("hmacFn must be a function");\n    const u8n = (len) => new Uint8Array(len);\n    const u8of = (byte) => Uint8Array.of(byte);\n    let v = u8n(hashLen);\n    let k = u8n(hashLen);\n    let i = 0;\n    const reset = () => {\n      v.fill(1);\n      k.fill(0);\n      i = 0;\n    };\n    const h = (...b) => hmacFn(k, v, ...b);\n    const reseed = (seed = u8n(0)) => {\n      k = h(u8of(0), seed);\n      v = h();\n      if (seed.length === 0)\n        return;\n      k = h(u8of(1), seed);\n      v = h();\n    };\n    const gen = () => {\n      if (i++ >= 1e3)\n        throw new Error("drbg: tried 1000 values");\n      let len = 0;\n      const out = [];\n      while (len < qByteLen) {\n        v = h();\n        const sl = v.slice();\n        out.push(sl);\n        len += v.length;\n      }\n      return concatBytes(...out);\n    };\n    const genUntil = (seed, pred) => {\n      reset();\n      reseed(seed);\n      let res = void 0;\n      while (!(res = pred(gen())))\n        reseed();\n      reset();\n      return res;\n    };\n    return genUntil;\n  }\n  function _validateObject(object, fields, optFields = {}) {\n    if (!object || typeof object !== "object")\n      throw new Error("expected valid options object");\n    function checkField(fieldName, expectedType, isOpt) {\n      const val = object[fieldName];\n      if (isOpt && val === void 0)\n        return;\n      const current = typeof val;\n      if (current !== expectedType || val === null)\n        throw new Error(`param "${fieldName}" is invalid: expected ${expectedType}, got ${current}`);\n    }\n    Object.entries(fields).forEach(([k, v]) => checkField(k, v, false));\n    Object.entries(optFields).forEach(([k, v]) => checkField(k, v, true));\n  }\n  function memoized(fn) {\n    const map = /* @__PURE__ */ new WeakMap();\n    return (arg, ...args) => {\n      const val = map.get(arg);\n      if (val !== void 0)\n        return val;\n      const computed = fn(arg, ...args);\n      map.set(arg, computed);\n      return computed;\n    };\n  }\n\n  // ../sign/lib/noble-curves/abstract/modular.js\n  var _0n2 = BigInt(0);\n  var _1n2 = BigInt(1);\n  var _2n = /* @__PURE__ */ BigInt(2);\n  var _3n = /* @__PURE__ */ BigInt(3);\n  var _4n = /* @__PURE__ */ BigInt(4);\n  var _5n = /* @__PURE__ */ BigInt(5);\n  var _7n = /* @__PURE__ */ BigInt(7);\n  var _8n = /* @__PURE__ */ BigInt(8);\n  var _9n = /* @__PURE__ */ BigInt(9);\n  var _16n = /* @__PURE__ */ BigInt(16);\n  function mod(a, b) {\n    const result = a % b;\n    return result >= _0n2 ? result : b + result;\n  }\n  function pow2(x, power, modulo) {\n    let res = x;\n    while (power-- > _0n2) {\n      res *= res;\n      res %= modulo;\n    }\n    return res;\n  }\n  function invert(number, modulo) {\n    if (number === _0n2)\n      throw new Error("invert: expected non-zero number");\n    if (modulo <= _0n2)\n      throw new Error("invert: expected positive modulus, got " + modulo);\n    let a = mod(number, modulo);\n    let b = modulo;\n    let x = _0n2, y = _1n2, u = _1n2, v = _0n2;\n    while (a !== _0n2) {\n      const q = b / a;\n      const r = b % a;\n      const m = x - u * q;\n      const n = y - v * q;\n      b = a, a = r, x = u, y = v, u = m, v = n;\n    }\n    const gcd2 = b;\n    if (gcd2 !== _1n2)\n      throw new Error("invert: does not exist");\n    return mod(x, modulo);\n  }\n  function assertIsSquare(Fp, root, n) {\n    if (!Fp.eql(Fp.sqr(root), n))\n      throw new Error("Cannot find square root");\n  }\n  function sqrt3mod4(Fp, n) {\n    const p1div4 = (Fp.ORDER + _1n2) / _4n;\n    const root = Fp.pow(n, p1div4);\n    assertIsSquare(Fp, root, n);\n    return root;\n  }\n  function sqrt5mod8(Fp, n) {\n    const p5div8 = (Fp.ORDER - _5n) / _8n;\n    const n2 = Fp.mul(n, _2n);\n    const v = Fp.pow(n2, p5div8);\n    const nv = Fp.mul(n, v);\n    const i = Fp.mul(Fp.mul(nv, _2n), v);\n    const root = Fp.mul(nv, Fp.sub(i, Fp.ONE));\n    assertIsSquare(Fp, root, n);\n    return root;\n  }\n  function sqrt9mod16(P) {\n    const Fp_ = Field(P);\n    const tn = tonelliShanks(P);\n    const c1 = tn(Fp_, Fp_.neg(Fp_.ONE));\n    const c2 = tn(Fp_, c1);\n    const c3 = tn(Fp_, Fp_.neg(c1));\n    const c4 = (P + _7n) / _16n;\n    return (Fp, n) => {\n      let tv1 = Fp.pow(n, c4);\n      let tv2 = Fp.mul(tv1, c1);\n      const tv3 = Fp.mul(tv1, c2);\n      const tv4 = Fp.mul(tv1, c3);\n      const e1 = Fp.eql(Fp.sqr(tv2), n);\n      const e2 = Fp.eql(Fp.sqr(tv3), n);\n      tv1 = Fp.cmov(tv1, tv2, e1);\n      tv2 = Fp.cmov(tv4, tv3, e2);\n      const e3 = Fp.eql(Fp.sqr(tv2), n);\n      const root = Fp.cmov(tv1, tv2, e3);\n      assertIsSquare(Fp, root, n);\n      return root;\n    };\n  }\n  function tonelliShanks(P) {\n    if (P < _3n)\n      throw new Error("sqrt is not defined for small field");\n    let Q = P - _1n2;\n    let S = 0;\n    while (Q % _2n === _0n2) {\n      Q /= _2n;\n      S++;\n    }\n    let Z = _2n;\n    const _Fp = Field(P);\n    while (FpLegendre(_Fp, Z) === 1) {\n      if (Z++ > 1e3)\n        throw new Error("Cannot find square root: probably non-prime P");\n    }\n    if (S === 1)\n      return sqrt3mod4;\n    let cc = _Fp.pow(Z, Q);\n    const Q1div2 = (Q + _1n2) / _2n;\n    return function tonelliSlow(Fp, n) {\n      if (Fp.is0(n))\n        return n;\n      if (FpLegendre(Fp, n) !== 1)\n        throw new Error("Cannot find square root");\n      let M = S;\n      let c = Fp.mul(Fp.ONE, cc);\n      let t = Fp.pow(n, Q);\n      let R = Fp.pow(n, Q1div2);\n      while (!Fp.eql(t, Fp.ONE)) {\n        if (Fp.is0(t))\n          return Fp.ZERO;\n        let i = 1;\n        let t_tmp = Fp.sqr(t);\n        while (!Fp.eql(t_tmp, Fp.ONE)) {\n          i++;\n          t_tmp = Fp.sqr(t_tmp);\n          if (i === M)\n            throw new Error("Cannot find square root");\n        }\n        const exponent = _1n2 << BigInt(M - i - 1);\n        const b = Fp.pow(c, exponent);\n        M = i;\n        c = Fp.sqr(b);\n        t = Fp.mul(t, c);\n        R = Fp.mul(R, b);\n      }\n      return R;\n    };\n  }\n  function FpSqrt(P) {\n    if (P % _4n === _3n)\n      return sqrt3mod4;\n    if (P % _8n === _5n)\n      return sqrt5mod8;\n    if (P % _16n === _9n)\n      return sqrt9mod16(P);\n    return tonelliShanks(P);\n  }\n  var FIELD_FIELDS = [\n    "create",\n    "isValid",\n    "is0",\n    "neg",\n    "inv",\n    "sqrt",\n    "sqr",\n    "eql",\n    "add",\n    "sub",\n    "mul",\n    "pow",\n    "div",\n    "addN",\n    "subN",\n    "mulN",\n    "sqrN"\n  ];\n  function validateField(field) {\n    const initial = {\n      ORDER: "bigint",\n      MASK: "bigint",\n      BYTES: "number",\n      BITS: "number"\n    };\n    const opts = FIELD_FIELDS.reduce((map, val) => {\n      map[val] = "function";\n      return map;\n    }, initial);\n    _validateObject(field, opts);\n    return field;\n  }\n  function FpPow(Fp, num2, power) {\n    if (power < _0n2)\n      throw new Error("invalid exponent, negatives unsupported");\n    if (power === _0n2)\n      return Fp.ONE;\n    if (power === _1n2)\n      return num2;\n    let p = Fp.ONE;\n    let d = num2;\n    while (power > _0n2) {\n      if (power & _1n2)\n        p = Fp.mul(p, d);\n      d = Fp.sqr(d);\n      power >>= _1n2;\n    }\n    return p;\n  }\n  function FpInvertBatch(Fp, nums, passZero = false) {\n    const inverted = new Array(nums.length).fill(passZero ? Fp.ZERO : void 0);\n    const multipliedAcc = nums.reduce((acc, num2, i) => {\n      if (Fp.is0(num2))\n        return acc;\n      inverted[i] = acc;\n      return Fp.mul(acc, num2);\n    }, Fp.ONE);\n    const invertedAcc = Fp.inv(multipliedAcc);\n    nums.reduceRight((acc, num2, i) => {\n      if (Fp.is0(num2))\n        return acc;\n      inverted[i] = Fp.mul(acc, inverted[i]);\n      return Fp.mul(acc, num2);\n    }, invertedAcc);\n    return inverted;\n  }\n  function FpLegendre(Fp, n) {\n    const p1mod2 = (Fp.ORDER - _1n2) / _2n;\n    const powered = Fp.pow(n, p1mod2);\n    const yes = Fp.eql(powered, Fp.ONE);\n    const zero = Fp.eql(powered, Fp.ZERO);\n    const no = Fp.eql(powered, Fp.neg(Fp.ONE));\n    if (!yes && !zero && !no)\n      throw new Error("invalid Legendre symbol result");\n    return yes ? 1 : zero ? 0 : -1;\n  }\n  function nLength(n, nBitLength) {\n    if (nBitLength !== void 0)\n      anumber(nBitLength);\n    const _nBitLength = nBitLength !== void 0 ? nBitLength : n.toString(2).length;\n    const nByteLength = Math.ceil(_nBitLength / 8);\n    return { nBitLength: _nBitLength, nByteLength };\n  }\n  function Field(ORDER, bitLenOrOpts, isLE = false, opts = {}) {\n    if (ORDER <= _0n2)\n      throw new Error("invalid field: expected ORDER > 0, got " + ORDER);\n    let _nbitLength = void 0;\n    let _sqrt = void 0;\n    let modFromBytes = false;\n    let allowedLengths = void 0;\n    if (typeof bitLenOrOpts === "object" && bitLenOrOpts != null) {\n      if (opts.sqrt || isLE)\n        throw new Error("cannot specify opts in two arguments");\n      const _opts = bitLenOrOpts;\n      if (_opts.BITS)\n        _nbitLength = _opts.BITS;\n      if (_opts.sqrt)\n        _sqrt = _opts.sqrt;\n      if (typeof _opts.isLE === "boolean")\n        isLE = _opts.isLE;\n      if (typeof _opts.modFromBytes === "boolean")\n        modFromBytes = _opts.modFromBytes;\n      allowedLengths = _opts.allowedLengths;\n    } else {\n      if (typeof bitLenOrOpts === "number")\n        _nbitLength = bitLenOrOpts;\n      if (opts.sqrt)\n        _sqrt = opts.sqrt;\n    }\n    const { nBitLength: BITS, nByteLength: BYTES } = nLength(ORDER, _nbitLength);\n    if (BYTES > 2048)\n      throw new Error("invalid field: expected ORDER of <= 2048 bytes");\n    let sqrtP;\n    const f = Object.freeze({\n      ORDER,\n      isLE,\n      BITS,\n      BYTES,\n      MASK: bitMask(BITS),\n      ZERO: _0n2,\n      ONE: _1n2,\n      allowedLengths,\n      create: (num2) => mod(num2, ORDER),\n      isValid: (num2) => {\n        if (typeof num2 !== "bigint")\n          throw new Error("invalid field element: expected bigint, got " + typeof num2);\n        return _0n2 <= num2 && num2 < ORDER;\n      },\n      is0: (num2) => num2 === _0n2,\n      // is valid and invertible\n      isValidNot0: (num2) => !f.is0(num2) && f.isValid(num2),\n      isOdd: (num2) => (num2 & _1n2) === _1n2,\n      neg: (num2) => mod(-num2, ORDER),\n      eql: (lhs, rhs) => lhs === rhs,\n      sqr: (num2) => mod(num2 * num2, ORDER),\n      add: (lhs, rhs) => mod(lhs + rhs, ORDER),\n      sub: (lhs, rhs) => mod(lhs - rhs, ORDER),\n      mul: (lhs, rhs) => mod(lhs * rhs, ORDER),\n      pow: (num2, power) => FpPow(f, num2, power),\n      div: (lhs, rhs) => mod(lhs * invert(rhs, ORDER), ORDER),\n      // Same as above, but doesn\'t normalize\n      sqrN: (num2) => num2 * num2,\n      addN: (lhs, rhs) => lhs + rhs,\n      subN: (lhs, rhs) => lhs - rhs,\n      mulN: (lhs, rhs) => lhs * rhs,\n      inv: (num2) => invert(num2, ORDER),\n      sqrt: _sqrt || ((n) => {\n        if (!sqrtP)\n          sqrtP = FpSqrt(ORDER);\n        return sqrtP(f, n);\n      }),\n      toBytes: (num2) => isLE ? numberToBytesLE(num2, BYTES) : numberToBytesBE(num2, BYTES),\n      fromBytes: (bytes, skipValidation = true) => {\n        if (allowedLengths) {\n          if (!allowedLengths.includes(bytes.length) || bytes.length > BYTES) {\n            throw new Error("Field.fromBytes: expected " + allowedLengths + " bytes, got " + bytes.length);\n          }\n          const padded = new Uint8Array(BYTES);\n          padded.set(bytes, isLE ? 0 : padded.length - bytes.length);\n          bytes = padded;\n        }\n        if (bytes.length !== BYTES)\n          throw new Error("Field.fromBytes: expected " + BYTES + " bytes, got " + bytes.length);\n        let scalar = isLE ? bytesToNumberLE(bytes) : bytesToNumberBE(bytes);\n        if (modFromBytes)\n          scalar = mod(scalar, ORDER);\n        if (!skipValidation) {\n          if (!f.isValid(scalar))\n            throw new Error("invalid field element: outside of range 0..ORDER");\n        }\n        return scalar;\n      },\n      // TODO: we don\'t need it here, move out to separate fn\n      invertBatch: (lst) => FpInvertBatch(f, lst),\n      // We can\'t move this out because Fp6, Fp12 implement it\n      // and it\'s unclear what to return in there.\n      cmov: (a, b, c) => c ? b : a\n    });\n    return Object.freeze(f);\n  }\n  function getFieldBytesLength(fieldOrder) {\n    if (typeof fieldOrder !== "bigint")\n      throw new Error("field order must be bigint");\n    const bitLength = fieldOrder.toString(2).length;\n    return Math.ceil(bitLength / 8);\n  }\n  function getMinHashLength(fieldOrder) {\n    const length = getFieldBytesLength(fieldOrder);\n    return length + Math.ceil(length / 2);\n  }\n  function mapHashToField(key, fieldOrder, isLE = false) {\n    const len = key.length;\n    const fieldLen = getFieldBytesLength(fieldOrder);\n    const minLen = getMinHashLength(fieldOrder);\n    if (len < 16 || len < minLen || len > 1024)\n      throw new Error("expected " + minLen + "-1024 bytes of input, got " + len);\n    const num2 = isLE ? bytesToNumberLE(key) : bytesToNumberBE(key);\n    const reduced = mod(num2, fieldOrder - _1n2) + _1n2;\n    return isLE ? numberToBytesLE(reduced, fieldLen) : numberToBytesBE(reduced, fieldLen);\n  }\n\n  // ../sign/lib/noble-hashes/_md.js\n  function setBigUint64(view, byteOffset, value, isLE) {\n    if (typeof view.setBigUint64 === "function")\n      return view.setBigUint64(byteOffset, value, isLE);\n    const _32n2 = BigInt(32);\n    const _u32_max = BigInt(4294967295);\n    const wh = Number(value >> _32n2 & _u32_max);\n    const wl = Number(value & _u32_max);\n    const h = isLE ? 4 : 0;\n    const l = isLE ? 0 : 4;\n    view.setUint32(byteOffset + h, wh, isLE);\n    view.setUint32(byteOffset + l, wl, isLE);\n  }\n  function Chi(a, b, c) {\n    return a & b ^ ~a & c;\n  }\n  function Maj(a, b, c) {\n    return a & b ^ a & c ^ b & c;\n  }\n  var HashMD = class extends Hash {\n    constructor(blockLen, outputLen, padOffset, isLE) {\n      super();\n      this.finished = false;\n      this.length = 0;\n      this.pos = 0;\n      this.destroyed = false;\n      this.blockLen = blockLen;\n      this.outputLen = outputLen;\n      this.padOffset = padOffset;\n      this.isLE = isLE;\n      this.buffer = new Uint8Array(blockLen);\n      this.view = createView(this.buffer);\n    }\n    update(data) {\n      aexists(this);\n      data = toBytes(data);\n      abytes(data);\n      const { view, buffer, blockLen } = this;\n      const len = data.length;\n      for (let pos = 0; pos < len; ) {\n        const take = Math.min(blockLen - this.pos, len - pos);\n        if (take === blockLen) {\n          const dataView = createView(data);\n          for (; blockLen <= len - pos; pos += blockLen)\n            this.process(dataView, pos);\n          continue;\n        }\n        buffer.set(data.subarray(pos, pos + take), this.pos);\n        this.pos += take;\n        pos += take;\n        if (this.pos === blockLen) {\n          this.process(view, 0);\n          this.pos = 0;\n        }\n      }\n      this.length += data.length;\n      this.roundClean();\n      return this;\n    }\n    digestInto(out) {\n      aexists(this);\n      aoutput(out, this);\n      this.finished = true;\n      const { buffer, view, blockLen, isLE } = this;\n      let { pos } = this;\n      buffer[pos++] = 128;\n      clean(this.buffer.subarray(pos));\n      if (this.padOffset > blockLen - pos) {\n        this.process(view, 0);\n        pos = 0;\n      }\n      for (let i = pos; i < blockLen; i++)\n        buffer[i] = 0;\n      setBigUint64(view, blockLen - 8, BigInt(this.length * 8), isLE);\n      this.process(view, 0);\n      const oview = createView(out);\n      const len = this.outputLen;\n      if (len % 4)\n        throw new Error("_sha2: outputLen should be aligned to 32bit");\n      const outLen = len / 4;\n      const state = this.get();\n      if (outLen > state.length)\n        throw new Error("_sha2: outputLen bigger than state");\n      for (let i = 0; i < outLen; i++)\n        oview.setUint32(4 * i, state[i], isLE);\n    }\n    digest() {\n      const { buffer, outputLen } = this;\n      this.digestInto(buffer);\n      const res = buffer.slice(0, outputLen);\n      this.destroy();\n      return res;\n    }\n    _cloneInto(to) {\n      to || (to = new this.constructor());\n      to.set(...this.get());\n      const { blockLen, buffer, length, finished, destroyed, pos } = this;\n      to.destroyed = destroyed;\n      to.finished = finished;\n      to.length = length;\n      to.pos = pos;\n      if (length % blockLen)\n        to.buffer.set(buffer);\n      return to;\n    }\n    clone() {\n      return this._cloneInto();\n    }\n  };\n  var SHA256_IV = /* @__PURE__ */ Uint32Array.from([\n    1779033703,\n    3144134277,\n    1013904242,\n    2773480762,\n    1359893119,\n    2600822924,\n    528734635,\n    1541459225\n  ]);\n  var SHA512_IV = /* @__PURE__ */ Uint32Array.from([\n    1779033703,\n    4089235720,\n    3144134277,\n    2227873595,\n    1013904242,\n    4271175723,\n    2773480762,\n    1595750129,\n    1359893119,\n    2917565137,\n    2600822924,\n    725511199,\n    528734635,\n    4215389547,\n    1541459225,\n    327033209\n  ]);\n\n  // ../sign/lib/noble-hashes/_u64.js\n  var U32_MASK64 = /* @__PURE__ */ BigInt(2 ** 32 - 1);\n  var _32n = /* @__PURE__ */ BigInt(32);\n  function fromBig(n, le = false) {\n    if (le)\n      return { h: Number(n & U32_MASK64), l: Number(n >> _32n & U32_MASK64) };\n    return { h: Number(n >> _32n & U32_MASK64) | 0, l: Number(n & U32_MASK64) | 0 };\n  }\n  function split(lst, le = false) {\n    const len = lst.length;\n    let Ah = new Uint32Array(len);\n    let Al = new Uint32Array(len);\n    for (let i = 0; i < len; i++) {\n      const { h, l } = fromBig(lst[i], le);\n      [Ah[i], Al[i]] = [h, l];\n    }\n    return [Ah, Al];\n  }\n  var shrSH = (h, _l, s) => h >>> s;\n  var shrSL = (h, l, s) => h << 32 - s | l >>> s;\n  var rotrSH = (h, l, s) => h >>> s | l << 32 - s;\n  var rotrSL = (h, l, s) => h << 32 - s | l >>> s;\n  var rotrBH = (h, l, s) => h << 64 - s | l >>> s - 32;\n  var rotrBL = (h, l, s) => h >>> s - 32 | l << 64 - s;\n  function add(Ah, Al, Bh, Bl) {\n    const l = (Al >>> 0) + (Bl >>> 0);\n    return { h: Ah + Bh + (l / 2 ** 32 | 0) | 0, l: l | 0 };\n  }\n  var add3L = (Al, Bl, Cl) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0);\n  var add3H = (low, Ah, Bh, Ch) => Ah + Bh + Ch + (low / 2 ** 32 | 0) | 0;\n  var add4L = (Al, Bl, Cl, Dl) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0) + (Dl >>> 0);\n  var add4H = (low, Ah, Bh, Ch, Dh) => Ah + Bh + Ch + Dh + (low / 2 ** 32 | 0) | 0;\n  var add5L = (Al, Bl, Cl, Dl, El) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0) + (Dl >>> 0) + (El >>> 0);\n  var add5H = (low, Ah, Bh, Ch, Dh, Eh) => Ah + Bh + Ch + Dh + Eh + (low / 2 ** 32 | 0) | 0;\n\n  // ../sign/lib/noble-hashes/sha2.js\n  var SHA256_K = /* @__PURE__ */ Uint32Array.from([\n    1116352408,\n    1899447441,\n    3049323471,\n    3921009573,\n    961987163,\n    1508970993,\n    2453635748,\n    2870763221,\n    3624381080,\n    310598401,\n    607225278,\n    1426881987,\n    1925078388,\n    2162078206,\n    2614888103,\n    3248222580,\n    3835390401,\n    4022224774,\n    264347078,\n    604807628,\n    770255983,\n    1249150122,\n    1555081692,\n    1996064986,\n    2554220882,\n    2821834349,\n    2952996808,\n    3210313671,\n    3336571891,\n    3584528711,\n    113926993,\n    338241895,\n    666307205,\n    773529912,\n    1294757372,\n    1396182291,\n    1695183700,\n    1986661051,\n    2177026350,\n    2456956037,\n    2730485921,\n    2820302411,\n    3259730800,\n    3345764771,\n    3516065817,\n    3600352804,\n    4094571909,\n    275423344,\n    430227734,\n    506948616,\n    659060556,\n    883997877,\n    958139571,\n    1322822218,\n    1537002063,\n    1747873779,\n    1955562222,\n    2024104815,\n    2227730452,\n    2361852424,\n    2428436474,\n    2756734187,\n    3204031479,\n    3329325298\n  ]);\n  var SHA256_W = /* @__PURE__ */ new Uint32Array(64);\n  var SHA256 = class extends HashMD {\n    constructor(outputLen = 32) {\n      super(64, outputLen, 8, false);\n      this.A = SHA256_IV[0] | 0;\n      this.B = SHA256_IV[1] | 0;\n      this.C = SHA256_IV[2] | 0;\n      this.D = SHA256_IV[3] | 0;\n      this.E = SHA256_IV[4] | 0;\n      this.F = SHA256_IV[5] | 0;\n      this.G = SHA256_IV[6] | 0;\n      this.H = SHA256_IV[7] | 0;\n    }\n    get() {\n      const { A, B, C, D, E, F, G, H } = this;\n      return [A, B, C, D, E, F, G, H];\n    }\n    // prettier-ignore\n    set(A, B, C, D, E, F, G, H) {\n      this.A = A | 0;\n      this.B = B | 0;\n      this.C = C | 0;\n      this.D = D | 0;\n      this.E = E | 0;\n      this.F = F | 0;\n      this.G = G | 0;\n      this.H = H | 0;\n    }\n    process(view, offset) {\n      for (let i = 0; i < 16; i++, offset += 4)\n        SHA256_W[i] = view.getUint32(offset, false);\n      for (let i = 16; i < 64; i++) {\n        const W15 = SHA256_W[i - 15];\n        const W2 = SHA256_W[i - 2];\n        const s0 = rotr(W15, 7) ^ rotr(W15, 18) ^ W15 >>> 3;\n        const s1 = rotr(W2, 17) ^ rotr(W2, 19) ^ W2 >>> 10;\n        SHA256_W[i] = s1 + SHA256_W[i - 7] + s0 + SHA256_W[i - 16] | 0;\n      }\n      let { A, B, C, D, E, F, G, H } = this;\n      for (let i = 0; i < 64; i++) {\n        const sigma1 = rotr(E, 6) ^ rotr(E, 11) ^ rotr(E, 25);\n        const T1 = H + sigma1 + Chi(E, F, G) + SHA256_K[i] + SHA256_W[i] | 0;\n        const sigma0 = rotr(A, 2) ^ rotr(A, 13) ^ rotr(A, 22);\n        const T2 = sigma0 + Maj(A, B, C) | 0;\n        H = G;\n        G = F;\n        F = E;\n        E = D + T1 | 0;\n        D = C;\n        C = B;\n        B = A;\n        A = T1 + T2 | 0;\n      }\n      A = A + this.A | 0;\n      B = B + this.B | 0;\n      C = C + this.C | 0;\n      D = D + this.D | 0;\n      E = E + this.E | 0;\n      F = F + this.F | 0;\n      G = G + this.G | 0;\n      H = H + this.H | 0;\n      this.set(A, B, C, D, E, F, G, H);\n    }\n    roundClean() {\n      clean(SHA256_W);\n    }\n    destroy() {\n      this.set(0, 0, 0, 0, 0, 0, 0, 0);\n      clean(this.buffer);\n    }\n  };\n  var K512 = /* @__PURE__ */ (() => split([\n    "0x428a2f98d728ae22",\n    "0x7137449123ef65cd",\n    "0xb5c0fbcfec4d3b2f",\n    "0xe9b5dba58189dbbc",\n    "0x3956c25bf348b538",\n    "0x59f111f1b605d019",\n    "0x923f82a4af194f9b",\n    "0xab1c5ed5da6d8118",\n    "0xd807aa98a3030242",\n    "0x12835b0145706fbe",\n    "0x243185be4ee4b28c",\n    "0x550c7dc3d5ffb4e2",\n    "0x72be5d74f27b896f",\n    "0x80deb1fe3b1696b1",\n    "0x9bdc06a725c71235",\n    "0xc19bf174cf692694",\n    "0xe49b69c19ef14ad2",\n    "0xefbe4786384f25e3",\n    "0x0fc19dc68b8cd5b5",\n    "0x240ca1cc77ac9c65",\n    "0x2de92c6f592b0275",\n    "0x4a7484aa6ea6e483",\n    "0x5cb0a9dcbd41fbd4",\n    "0x76f988da831153b5",\n    "0x983e5152ee66dfab",\n    "0xa831c66d2db43210",\n    "0xb00327c898fb213f",\n    "0xbf597fc7beef0ee4",\n    "0xc6e00bf33da88fc2",\n    "0xd5a79147930aa725",\n    "0x06ca6351e003826f",\n    "0x142929670a0e6e70",\n    "0x27b70a8546d22ffc",\n    "0x2e1b21385c26c926",\n    "0x4d2c6dfc5ac42aed",\n    "0x53380d139d95b3df",\n    "0x650a73548baf63de",\n    "0x766a0abb3c77b2a8",\n    "0x81c2c92e47edaee6",\n    "0x92722c851482353b",\n    "0xa2bfe8a14cf10364",\n    "0xa81a664bbc423001",\n    "0xc24b8b70d0f89791",\n    "0xc76c51a30654be30",\n    "0xd192e819d6ef5218",\n    "0xd69906245565a910",\n    "0xf40e35855771202a",\n    "0x106aa07032bbd1b8",\n    "0x19a4c116b8d2d0c8",\n    "0x1e376c085141ab53",\n    "0x2748774cdf8eeb99",\n    "0x34b0bcb5e19b48a8",\n    "0x391c0cb3c5c95a63",\n    "0x4ed8aa4ae3418acb",\n    "0x5b9cca4f7763e373",\n    "0x682e6ff3d6b2b8a3",\n    "0x748f82ee5defb2fc",\n    "0x78a5636f43172f60",\n    "0x84c87814a1f0ab72",\n    "0x8cc702081a6439ec",\n    "0x90befffa23631e28",\n    "0xa4506cebde82bde9",\n    "0xbef9a3f7b2c67915",\n    "0xc67178f2e372532b",\n    "0xca273eceea26619c",\n    "0xd186b8c721c0c207",\n    "0xeada7dd6cde0eb1e",\n    "0xf57d4f7fee6ed178",\n    "0x06f067aa72176fba",\n    "0x0a637dc5a2c898a6",\n    "0x113f9804bef90dae",\n    "0x1b710b35131c471b",\n    "0x28db77f523047d84",\n    "0x32caab7b40c72493",\n    "0x3c9ebe0a15c9bebc",\n    "0x431d67c49c100d4c",\n    "0x4cc5d4becb3e42b6",\n    "0x597f299cfc657e2a",\n    "0x5fcb6fab3ad6faec",\n    "0x6c44198c4a475817"\n  ].map((n) => BigInt(n))))();\n  var SHA512_Kh = /* @__PURE__ */ (() => K512[0])();\n  var SHA512_Kl = /* @__PURE__ */ (() => K512[1])();\n  var SHA512_W_H = /* @__PURE__ */ new Uint32Array(80);\n  var SHA512_W_L = /* @__PURE__ */ new Uint32Array(80);\n  var SHA512 = class extends HashMD {\n    constructor(outputLen = 64) {\n      super(128, outputLen, 16, false);\n      this.Ah = SHA512_IV[0] | 0;\n      this.Al = SHA512_IV[1] | 0;\n      this.Bh = SHA512_IV[2] | 0;\n      this.Bl = SHA512_IV[3] | 0;\n      this.Ch = SHA512_IV[4] | 0;\n      this.Cl = SHA512_IV[5] | 0;\n      this.Dh = SHA512_IV[6] | 0;\n      this.Dl = SHA512_IV[7] | 0;\n      this.Eh = SHA512_IV[8] | 0;\n      this.El = SHA512_IV[9] | 0;\n      this.Fh = SHA512_IV[10] | 0;\n      this.Fl = SHA512_IV[11] | 0;\n      this.Gh = SHA512_IV[12] | 0;\n      this.Gl = SHA512_IV[13] | 0;\n      this.Hh = SHA512_IV[14] | 0;\n      this.Hl = SHA512_IV[15] | 0;\n    }\n    // prettier-ignore\n    get() {\n      const { Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl } = this;\n      return [Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl];\n    }\n    // prettier-ignore\n    set(Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl) {\n      this.Ah = Ah | 0;\n      this.Al = Al | 0;\n      this.Bh = Bh | 0;\n      this.Bl = Bl | 0;\n      this.Ch = Ch | 0;\n      this.Cl = Cl | 0;\n      this.Dh = Dh | 0;\n      this.Dl = Dl | 0;\n      this.Eh = Eh | 0;\n      this.El = El | 0;\n      this.Fh = Fh | 0;\n      this.Fl = Fl | 0;\n      this.Gh = Gh | 0;\n      this.Gl = Gl | 0;\n      this.Hh = Hh | 0;\n      this.Hl = Hl | 0;\n    }\n    process(view, offset) {\n      for (let i = 0; i < 16; i++, offset += 4) {\n        SHA512_W_H[i] = view.getUint32(offset);\n        SHA512_W_L[i] = view.getUint32(offset += 4);\n      }\n      for (let i = 16; i < 80; i++) {\n        const W15h = SHA512_W_H[i - 15] | 0;\n        const W15l = SHA512_W_L[i - 15] | 0;\n        const s0h = rotrSH(W15h, W15l, 1) ^ rotrSH(W15h, W15l, 8) ^ shrSH(W15h, W15l, 7);\n        const s0l = rotrSL(W15h, W15l, 1) ^ rotrSL(W15h, W15l, 8) ^ shrSL(W15h, W15l, 7);\n        const W2h = SHA512_W_H[i - 2] | 0;\n        const W2l = SHA512_W_L[i - 2] | 0;\n        const s1h = rotrSH(W2h, W2l, 19) ^ rotrBH(W2h, W2l, 61) ^ shrSH(W2h, W2l, 6);\n        const s1l = rotrSL(W2h, W2l, 19) ^ rotrBL(W2h, W2l, 61) ^ shrSL(W2h, W2l, 6);\n        const SUMl = add4L(s0l, s1l, SHA512_W_L[i - 7], SHA512_W_L[i - 16]);\n        const SUMh = add4H(SUMl, s0h, s1h, SHA512_W_H[i - 7], SHA512_W_H[i - 16]);\n        SHA512_W_H[i] = SUMh | 0;\n        SHA512_W_L[i] = SUMl | 0;\n      }\n      let { Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl } = this;\n      for (let i = 0; i < 80; i++) {\n        const sigma1h = rotrSH(Eh, El, 14) ^ rotrSH(Eh, El, 18) ^ rotrBH(Eh, El, 41);\n        const sigma1l = rotrSL(Eh, El, 14) ^ rotrSL(Eh, El, 18) ^ rotrBL(Eh, El, 41);\n        const CHIh = Eh & Fh ^ ~Eh & Gh;\n        const CHIl = El & Fl ^ ~El & Gl;\n        const T1ll = add5L(Hl, sigma1l, CHIl, SHA512_Kl[i], SHA512_W_L[i]);\n        const T1h = add5H(T1ll, Hh, sigma1h, CHIh, SHA512_Kh[i], SHA512_W_H[i]);\n        const T1l = T1ll | 0;\n        const sigma0h = rotrSH(Ah, Al, 28) ^ rotrBH(Ah, Al, 34) ^ rotrBH(Ah, Al, 39);\n        const sigma0l = rotrSL(Ah, Al, 28) ^ rotrBL(Ah, Al, 34) ^ rotrBL(Ah, Al, 39);\n        const MAJh = Ah & Bh ^ Ah & Ch ^ Bh & Ch;\n        const MAJl = Al & Bl ^ Al & Cl ^ Bl & Cl;\n        Hh = Gh | 0;\n        Hl = Gl | 0;\n        Gh = Fh | 0;\n        Gl = Fl | 0;\n        Fh = Eh | 0;\n        Fl = El | 0;\n        ({ h: Eh, l: El } = add(Dh | 0, Dl | 0, T1h | 0, T1l | 0));\n        Dh = Ch | 0;\n        Dl = Cl | 0;\n        Ch = Bh | 0;\n        Cl = Bl | 0;\n        Bh = Ah | 0;\n        Bl = Al | 0;\n        const All = add3L(T1l, sigma0l, MAJl);\n        Ah = add3H(All, T1h, sigma0h, MAJh);\n        Al = All | 0;\n      }\n      ({ h: Ah, l: Al } = add(this.Ah | 0, this.Al | 0, Ah | 0, Al | 0));\n      ({ h: Bh, l: Bl } = add(this.Bh | 0, this.Bl | 0, Bh | 0, Bl | 0));\n      ({ h: Ch, l: Cl } = add(this.Ch | 0, this.Cl | 0, Ch | 0, Cl | 0));\n      ({ h: Dh, l: Dl } = add(this.Dh | 0, this.Dl | 0, Dh | 0, Dl | 0));\n      ({ h: Eh, l: El } = add(this.Eh | 0, this.El | 0, Eh | 0, El | 0));\n      ({ h: Fh, l: Fl } = add(this.Fh | 0, this.Fl | 0, Fh | 0, Fl | 0));\n      ({ h: Gh, l: Gl } = add(this.Gh | 0, this.Gl | 0, Gh | 0, Gl | 0));\n      ({ h: Hh, l: Hl } = add(this.Hh | 0, this.Hl | 0, Hh | 0, Hl | 0));\n      this.set(Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl);\n    }\n    roundClean() {\n      clean(SHA512_W_H, SHA512_W_L);\n    }\n    destroy() {\n      clean(this.buffer);\n      this.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);\n    }\n  };\n  var sha256 = /* @__PURE__ */ createHasher(() => new SHA256());\n  var sha512 = /* @__PURE__ */ createHasher(() => new SHA512());\n\n  // ../sign/lib/noble-hashes/hmac.js\n  var HMAC = class extends Hash {\n    constructor(hash, _key) {\n      super();\n      this.finished = false;\n      this.destroyed = false;\n      ahash(hash);\n      const key = toBytes(_key);\n      this.iHash = hash.create();\n      if (typeof this.iHash.update !== "function")\n        throw new Error("Expected instance of class which extends utils.Hash");\n      this.blockLen = this.iHash.blockLen;\n      this.outputLen = this.iHash.outputLen;\n      const blockLen = this.blockLen;\n      const pad = new Uint8Array(blockLen);\n      pad.set(key.length > blockLen ? hash.create().update(key).digest() : key);\n      for (let i = 0; i < pad.length; i++)\n        pad[i] ^= 54;\n      this.iHash.update(pad);\n      this.oHash = hash.create();\n      for (let i = 0; i < pad.length; i++)\n        pad[i] ^= 54 ^ 92;\n      this.oHash.update(pad);\n      clean(pad);\n    }\n    update(buf) {\n      aexists(this);\n      this.iHash.update(buf);\n      return this;\n    }\n    digestInto(out) {\n      aexists(this);\n      abytes(out, this.outputLen);\n      this.finished = true;\n      this.iHash.digestInto(out);\n      this.oHash.update(out);\n      this.oHash.digestInto(out);\n      this.destroy();\n    }\n    digest() {\n      const out = new Uint8Array(this.oHash.outputLen);\n      this.digestInto(out);\n      return out;\n    }\n    _cloneInto(to) {\n      to || (to = Object.create(Object.getPrototypeOf(this), {}));\n      const { oHash, iHash, finished, destroyed, blockLen, outputLen } = this;\n      to = to;\n      to.finished = finished;\n      to.destroyed = destroyed;\n      to.blockLen = blockLen;\n      to.outputLen = outputLen;\n      to.oHash = oHash._cloneInto(to.oHash);\n      to.iHash = iHash._cloneInto(to.iHash);\n      return to;\n    }\n    clone() {\n      return this._cloneInto();\n    }\n    destroy() {\n      this.destroyed = true;\n      this.oHash.destroy();\n      this.iHash.destroy();\n    }\n  };\n  var hmac = (hash, key, message) => new HMAC(hash, key).update(message).digest();\n  hmac.create = (hash, key) => new HMAC(hash, key);\n\n  // ../sign/lib/noble-curves/abstract/curve.js\n  var _0n3 = BigInt(0);\n  var _1n3 = BigInt(1);\n  function negateCt(condition, item) {\n    const neg = item.negate();\n    return condition ? neg : item;\n  }\n  function normalizeZ(c, points) {\n    const invertedZs = FpInvertBatch(c.Fp, points.map((p) => p.Z));\n    return points.map((p, i) => c.fromAffine(p.toAffine(invertedZs[i])));\n  }\n  function validateW(W, bits) {\n    if (!Number.isSafeInteger(W) || W <= 0 || W > bits)\n      throw new Error("invalid window size, expected [1.." + bits + "], got W=" + W);\n  }\n  function calcWOpts(W, scalarBits) {\n    validateW(W, scalarBits);\n    const windows = Math.ceil(scalarBits / W) + 1;\n    const windowSize = 2 ** (W - 1);\n    const maxNumber = 2 ** W;\n    const mask = bitMask(W);\n    const shiftBy = BigInt(W);\n    return { windows, windowSize, mask, maxNumber, shiftBy };\n  }\n  function calcOffsets(n, window, wOpts) {\n    const { windowSize, mask, maxNumber, shiftBy } = wOpts;\n    let wbits = Number(n & mask);\n    let nextN = n >> shiftBy;\n    if (wbits > windowSize) {\n      wbits -= maxNumber;\n      nextN += _1n3;\n    }\n    const offsetStart = window * windowSize;\n    const offset = offsetStart + Math.abs(wbits) - 1;\n    const isZero = wbits === 0;\n    const isNeg = wbits < 0;\n    const isNegF = window % 2 !== 0;\n    const offsetF = offsetStart;\n    return { nextN, offset, isZero, isNeg, isNegF, offsetF };\n  }\n  function validateMSMPoints(points, c) {\n    if (!Array.isArray(points))\n      throw new Error("array expected");\n    points.forEach((p, i) => {\n      if (!(p instanceof c))\n        throw new Error("invalid point at index " + i);\n    });\n  }\n  function validateMSMScalars(scalars, field) {\n    if (!Array.isArray(scalars))\n      throw new Error("array of scalars expected");\n    scalars.forEach((s, i) => {\n      if (!field.isValid(s))\n        throw new Error("invalid scalar at index " + i);\n    });\n  }\n  var pointPrecomputes = /* @__PURE__ */ new WeakMap();\n  var pointWindowSizes = /* @__PURE__ */ new WeakMap();\n  function getW(P) {\n    return pointWindowSizes.get(P) || 1;\n  }\n  function assert0(n) {\n    if (n !== _0n3)\n      throw new Error("invalid wNAF");\n  }\n  var wNAF = class {\n    // Parametrized with a given Point class (not individual point)\n    constructor(Point2, bits) {\n      this.BASE = Point2.BASE;\n      this.ZERO = Point2.ZERO;\n      this.Fn = Point2.Fn;\n      this.bits = bits;\n    }\n    // non-const time multiplication ladder\n    _unsafeLadder(elm, n, p = this.ZERO) {\n      let d = elm;\n      while (n > _0n3) {\n        if (n & _1n3)\n          p = p.add(d);\n        d = d.double();\n        n >>= _1n3;\n      }\n      return p;\n    }\n    /**\n     * Creates a wNAF precomputation window. Used for caching.\n     * Default window size is set by `utils.precompute()` and is equal to 8.\n     * Number of precomputed points depends on the curve size:\n     * 2^(\u{1D44A}\u22121) * (Math.ceil(\u{1D45B} / \u{1D44A}) + 1), where:\n     * - \u{1D44A} is the window size\n     * - \u{1D45B} is the bitlength of the curve order.\n     * For a 256-bit curve and window size 8, the number of precomputed points is 128 * 33 = 4224.\n     * @param point Point instance\n     * @param W window size\n     * @returns precomputed point tables flattened to a single array\n     */\n    precomputeWindow(point, W) {\n      const { windows, windowSize } = calcWOpts(W, this.bits);\n      const points = [];\n      let p = point;\n      let base = p;\n      for (let window = 0; window < windows; window++) {\n        base = p;\n        points.push(base);\n        for (let i = 1; i < windowSize; i++) {\n          base = base.add(p);\n          points.push(base);\n        }\n        p = base.double();\n      }\n      return points;\n    }\n    /**\n     * Implements ec multiplication using precomputed tables and w-ary non-adjacent form.\n     * More compact implementation:\n     * https://github.com/paulmillr/noble-secp256k1/blob/47cb1669b6e506ad66b35fe7d76132ae97465da2/index.ts#L502-L541\n     * @returns real and fake (for const-time) points\n     */\n    wNAF(W, precomputes, n) {\n      if (!this.Fn.isValid(n))\n        throw new Error("invalid scalar");\n      let p = this.ZERO;\n      let f = this.BASE;\n      const wo = calcWOpts(W, this.bits);\n      for (let window = 0; window < wo.windows; window++) {\n        const { nextN, offset, isZero, isNeg, isNegF, offsetF } = calcOffsets(n, window, wo);\n        n = nextN;\n        if (isZero) {\n          f = f.add(negateCt(isNegF, precomputes[offsetF]));\n        } else {\n          p = p.add(negateCt(isNeg, precomputes[offset]));\n        }\n      }\n      assert0(n);\n      return { p, f };\n    }\n    /**\n     * Implements ec unsafe (non const-time) multiplication using precomputed tables and w-ary non-adjacent form.\n     * @param acc accumulator point to add result of multiplication\n     * @returns point\n     */\n    wNAFUnsafe(W, precomputes, n, acc = this.ZERO) {\n      const wo = calcWOpts(W, this.bits);\n      for (let window = 0; window < wo.windows; window++) {\n        if (n === _0n3)\n          break;\n        const { nextN, offset, isZero, isNeg } = calcOffsets(n, window, wo);\n        n = nextN;\n        if (isZero) {\n          continue;\n        } else {\n          const item = precomputes[offset];\n          acc = acc.add(isNeg ? item.negate() : item);\n        }\n      }\n      assert0(n);\n      return acc;\n    }\n    getPrecomputes(W, point, transform) {\n      let comp = pointPrecomputes.get(point);\n      if (!comp) {\n        comp = this.precomputeWindow(point, W);\n        if (W !== 1) {\n          if (typeof transform === "function")\n            comp = transform(comp);\n          pointPrecomputes.set(point, comp);\n        }\n      }\n      return comp;\n    }\n    cached(point, scalar, transform) {\n      const W = getW(point);\n      return this.wNAF(W, this.getPrecomputes(W, point, transform), scalar);\n    }\n    unsafe(point, scalar, transform, prev) {\n      const W = getW(point);\n      if (W === 1)\n        return this._unsafeLadder(point, scalar, prev);\n      return this.wNAFUnsafe(W, this.getPrecomputes(W, point, transform), scalar, prev);\n    }\n    // We calculate precomputes for elliptic curve point multiplication\n    // using windowed method. This specifies window size and\n    // stores precomputed values. Usually only base point would be precomputed.\n    createCache(P, W) {\n      validateW(W, this.bits);\n      pointWindowSizes.set(P, W);\n      pointPrecomputes.delete(P);\n    }\n    hasCache(elm) {\n      return getW(elm) !== 1;\n    }\n  };\n  function mulEndoUnsafe(Point2, point, k1, k2) {\n    let acc = point;\n    let p1 = Point2.ZERO;\n    let p2 = Point2.ZERO;\n    while (k1 > _0n3 || k2 > _0n3) {\n      if (k1 & _1n3)\n        p1 = p1.add(acc);\n      if (k2 & _1n3)\n        p2 = p2.add(acc);\n      acc = acc.double();\n      k1 >>= _1n3;\n      k2 >>= _1n3;\n    }\n    return { p1, p2 };\n  }\n  function pippenger(c, fieldN, points, scalars) {\n    validateMSMPoints(points, c);\n    validateMSMScalars(scalars, fieldN);\n    const plength = points.length;\n    const slength = scalars.length;\n    if (plength !== slength)\n      throw new Error("arrays of points and scalars must have equal length");\n    const zero = c.ZERO;\n    const wbits = bitLen(BigInt(plength));\n    let windowSize = 1;\n    if (wbits > 12)\n      windowSize = wbits - 3;\n    else if (wbits > 4)\n      windowSize = wbits - 2;\n    else if (wbits > 0)\n      windowSize = 2;\n    const MASK = bitMask(windowSize);\n    const buckets = new Array(Number(MASK) + 1).fill(zero);\n    const lastBits = Math.floor((fieldN.BITS - 1) / windowSize) * windowSize;\n    let sum = zero;\n    for (let i = lastBits; i >= 0; i -= windowSize) {\n      buckets.fill(zero);\n      for (let j = 0; j < slength; j++) {\n        const scalar = scalars[j];\n        const wbits2 = Number(scalar >> BigInt(i) & MASK);\n        buckets[wbits2] = buckets[wbits2].add(points[j]);\n      }\n      let resI = zero;\n      for (let j = buckets.length - 1, sumI = zero; j > 0; j--) {\n        sumI = sumI.add(buckets[j]);\n        resI = resI.add(sumI);\n      }\n      sum = sum.add(resI);\n      if (i !== 0)\n        for (let j = 0; j < windowSize; j++)\n          sum = sum.double();\n    }\n    return sum;\n  }\n  function createField(order, field, isLE) {\n    if (field) {\n      if (field.ORDER !== order)\n        throw new Error("Field.ORDER must match order: Fp == p, Fn == n");\n      validateField(field);\n      return field;\n    } else {\n      return Field(order, { isLE });\n    }\n  }\n  function _createCurveFields(type, CURVE, curveOpts = {}, FpFnLE) {\n    if (FpFnLE === void 0)\n      FpFnLE = type === "edwards";\n    if (!CURVE || typeof CURVE !== "object")\n      throw new Error(`expected valid ${type} CURVE object`);\n    for (const p of ["p", "n", "h"]) {\n      const val = CURVE[p];\n      if (!(typeof val === "bigint" && val > _0n3))\n        throw new Error(`CURVE.${p} must be positive bigint`);\n    }\n    const Fp = createField(CURVE.p, curveOpts.Fp, FpFnLE);\n    const Fn = createField(CURVE.n, curveOpts.Fn, FpFnLE);\n    const _b = type === "weierstrass" ? "b" : "d";\n    const params = ["Gx", "Gy", "a", _b];\n    for (const p of params) {\n      if (!Fp.isValid(CURVE[p]))\n        throw new Error(`CURVE.${p} must be valid field element of CURVE.Fp`);\n    }\n    CURVE = Object.freeze(Object.assign({}, CURVE));\n    return { CURVE, Fp, Fn };\n  }\n\n  // ../sign/lib/noble-curves/abstract/weierstrass.js\n  var divNearest = (num2, den) => (num2 + (num2 >= 0 ? den : -den) / _2n2) / den;\n  function _splitEndoScalar(k, basis, n) {\n    const [[a1, b1], [a2, b2]] = basis;\n    const c1 = divNearest(b2 * k, n);\n    const c2 = divNearest(-b1 * k, n);\n    let k1 = k - c1 * a1 - c2 * a2;\n    let k2 = -c1 * b1 - c2 * b2;\n    const k1neg = k1 < _0n4;\n    const k2neg = k2 < _0n4;\n    if (k1neg)\n      k1 = -k1;\n    if (k2neg)\n      k2 = -k2;\n    const MAX_NUM = bitMask(Math.ceil(bitLen(n) / 2)) + _1n4;\n    if (k1 < _0n4 || k1 >= MAX_NUM || k2 < _0n4 || k2 >= MAX_NUM) {\n      throw new Error("splitScalar (endomorphism): failed, k=" + k);\n    }\n    return { k1neg, k1, k2neg, k2 };\n  }\n  function validateSigFormat(format) {\n    if (!["compact", "recovered", "der"].includes(format))\n      throw new Error(\'Signature format must be "compact", "recovered", or "der"\');\n    return format;\n  }\n  function validateSigOpts(opts, def) {\n    const optsn = {};\n    for (let optName of Object.keys(def)) {\n      optsn[optName] = opts[optName] === void 0 ? def[optName] : opts[optName];\n    }\n    _abool2(optsn.lowS, "lowS");\n    _abool2(optsn.prehash, "prehash");\n    if (optsn.format !== void 0)\n      validateSigFormat(optsn.format);\n    return optsn;\n  }\n  var DERErr = class extends Error {\n    constructor(m = "") {\n      super(m);\n    }\n  };\n  var DER = {\n    // asn.1 DER encoding utils\n    Err: DERErr,\n    // Basic building block is TLV (Tag-Length-Value)\n    _tlv: {\n      encode: (tag, data) => {\n        const { Err: E } = DER;\n        if (tag < 0 || tag > 256)\n          throw new E("tlv.encode: wrong tag");\n        if (data.length & 1)\n          throw new E("tlv.encode: unpadded data");\n        const dataLen = data.length / 2;\n        const len = numberToHexUnpadded(dataLen);\n        if (len.length / 2 & 128)\n          throw new E("tlv.encode: long form length too big");\n        const lenLen = dataLen > 127 ? numberToHexUnpadded(len.length / 2 | 128) : "";\n        const t = numberToHexUnpadded(tag);\n        return t + lenLen + len + data;\n      },\n      // v - value, l - left bytes (unparsed)\n      decode(tag, data) {\n        const { Err: E } = DER;\n        let pos = 0;\n        if (tag < 0 || tag > 256)\n          throw new E("tlv.encode: wrong tag");\n        if (data.length < 2 || data[pos++] !== tag)\n          throw new E("tlv.decode: wrong tlv");\n        const first = data[pos++];\n        const isLong = !!(first & 128);\n        let length = 0;\n        if (!isLong)\n          length = first;\n        else {\n          const lenLen = first & 127;\n          if (!lenLen)\n            throw new E("tlv.decode(long): indefinite length not supported");\n          if (lenLen > 4)\n            throw new E("tlv.decode(long): byte length is too big");\n          const lengthBytes = data.subarray(pos, pos + lenLen);\n          if (lengthBytes.length !== lenLen)\n            throw new E("tlv.decode: length bytes not complete");\n          if (lengthBytes[0] === 0)\n            throw new E("tlv.decode(long): zero leftmost byte");\n          for (const b of lengthBytes)\n            length = length << 8 | b;\n          pos += lenLen;\n          if (length < 128)\n            throw new E("tlv.decode(long): not minimal encoding");\n        }\n        const v = data.subarray(pos, pos + length);\n        if (v.length !== length)\n          throw new E("tlv.decode: wrong value length");\n        return { v, l: data.subarray(pos + length) };\n      }\n    },\n    // https://crypto.stackexchange.com/a/57734 Leftmost bit of first byte is \'negative\' flag,\n    // since we always use positive integers here. It must always be empty:\n    // - add zero byte if exists\n    // - if next byte doesn\'t have a flag, leading zero is not allowed (minimal encoding)\n    _int: {\n      encode(num2) {\n        const { Err: E } = DER;\n        if (num2 < _0n4)\n          throw new E("integer: negative integers are not allowed");\n        let hex = numberToHexUnpadded(num2);\n        if (Number.parseInt(hex[0], 16) & 8)\n          hex = "00" + hex;\n        if (hex.length & 1)\n          throw new E("unexpected DER parsing assertion: unpadded hex");\n        return hex;\n      },\n      decode(data) {\n        const { Err: E } = DER;\n        if (data[0] & 128)\n          throw new E("invalid signature integer: negative");\n        if (data[0] === 0 && !(data[1] & 128))\n          throw new E("invalid signature integer: unnecessary leading zero");\n        return bytesToNumberBE(data);\n      }\n    },\n    toSig(hex) {\n      const { Err: E, _int: int, _tlv: tlv } = DER;\n      const data = ensureBytes("signature", hex);\n      const { v: seqBytes, l: seqLeftBytes } = tlv.decode(48, data);\n      if (seqLeftBytes.length)\n        throw new E("invalid signature: left bytes after parsing");\n      const { v: rBytes, l: rLeftBytes } = tlv.decode(2, seqBytes);\n      const { v: sBytes, l: sLeftBytes } = tlv.decode(2, rLeftBytes);\n      if (sLeftBytes.length)\n        throw new E("invalid signature: left bytes after parsing");\n      return { r: int.decode(rBytes), s: int.decode(sBytes) };\n    },\n    hexFromSig(sig) {\n      const { _tlv: tlv, _int: int } = DER;\n      const rs = tlv.encode(2, int.encode(sig.r));\n      const ss = tlv.encode(2, int.encode(sig.s));\n      const seq = rs + ss;\n      return tlv.encode(48, seq);\n    }\n  };\n  var _0n4 = BigInt(0);\n  var _1n4 = BigInt(1);\n  var _2n2 = BigInt(2);\n  var _3n2 = BigInt(3);\n  var _4n2 = BigInt(4);\n  function _normFnElement(Fn, key) {\n    const { BYTES: expected } = Fn;\n    let num2;\n    if (typeof key === "bigint") {\n      num2 = key;\n    } else {\n      let bytes = ensureBytes("private key", key);\n      try {\n        num2 = Fn.fromBytes(bytes);\n      } catch (error) {\n        throw new Error(`invalid private key: expected ui8a of size ${expected}, got ${typeof key}`);\n      }\n    }\n    if (!Fn.isValidNot0(num2))\n      throw new Error("invalid private key: out of range [1..N-1]");\n    return num2;\n  }\n  function weierstrassN(params, extraOpts = {}) {\n    const validated = _createCurveFields("weierstrass", params, extraOpts);\n    const { Fp, Fn } = validated;\n    let CURVE = validated.CURVE;\n    const { h: cofactor, n: CURVE_ORDER } = CURVE;\n    _validateObject(extraOpts, {}, {\n      allowInfinityPoint: "boolean",\n      clearCofactor: "function",\n      isTorsionFree: "function",\n      fromBytes: "function",\n      toBytes: "function",\n      endo: "object",\n      wrapPrivateKey: "boolean"\n    });\n    const { endo } = extraOpts;\n    if (endo) {\n      if (!Fp.is0(CURVE.a) || typeof endo.beta !== "bigint" || !Array.isArray(endo.basises)) {\n        throw new Error(\'invalid endo: expected "beta": bigint and "basises": array\');\n      }\n    }\n    const lengths = getWLengths(Fp, Fn);\n    function assertCompressionIsSupported() {\n      if (!Fp.isOdd)\n        throw new Error("compression is not supported: Field does not have .isOdd()");\n    }\n    function pointToBytes2(_c, point, isCompressed) {\n      const { x, y } = point.toAffine();\n      const bx = Fp.toBytes(x);\n      _abool2(isCompressed, "isCompressed");\n      if (isCompressed) {\n        assertCompressionIsSupported();\n        const hasEvenY = !Fp.isOdd(y);\n        return concatBytes(pprefix(hasEvenY), bx);\n      } else {\n        return concatBytes(Uint8Array.of(4), bx, Fp.toBytes(y));\n      }\n    }\n    function pointFromBytes(bytes) {\n      _abytes2(bytes, void 0, "Point");\n      const { publicKey: comp, publicKeyUncompressed: uncomp } = lengths;\n      const length = bytes.length;\n      const head = bytes[0];\n      const tail = bytes.subarray(1);\n      if (length === comp && (head === 2 || head === 3)) {\n        const x = Fp.fromBytes(tail);\n        if (!Fp.isValid(x))\n          throw new Error("bad point: is not on curve, wrong x");\n        const y2 = weierstrassEquation(x);\n        let y;\n        try {\n          y = Fp.sqrt(y2);\n        } catch (sqrtError) {\n          const err = sqrtError instanceof Error ? ": " + sqrtError.message : "";\n          throw new Error("bad point: is not on curve, sqrt error" + err);\n        }\n        assertCompressionIsSupported();\n        const isYOdd = Fp.isOdd(y);\n        const isHeadOdd = (head & 1) === 1;\n        if (isHeadOdd !== isYOdd)\n          y = Fp.neg(y);\n        return { x, y };\n      } else if (length === uncomp && head === 4) {\n        const L = Fp.BYTES;\n        const x = Fp.fromBytes(tail.subarray(0, L));\n        const y = Fp.fromBytes(tail.subarray(L, L * 2));\n        if (!isValidXY(x, y))\n          throw new Error("bad point: is not on curve");\n        return { x, y };\n      } else {\n        throw new Error(`bad point: got length ${length}, expected compressed=${comp} or uncompressed=${uncomp}`);\n      }\n    }\n    const encodePoint = extraOpts.toBytes || pointToBytes2;\n    const decodePoint = extraOpts.fromBytes || pointFromBytes;\n    function weierstrassEquation(x) {\n      const x2 = Fp.sqr(x);\n      const x3 = Fp.mul(x2, x);\n      return Fp.add(Fp.add(x3, Fp.mul(x, CURVE.a)), CURVE.b);\n    }\n    function isValidXY(x, y) {\n      const left = Fp.sqr(y);\n      const right = weierstrassEquation(x);\n      return Fp.eql(left, right);\n    }\n    if (!isValidXY(CURVE.Gx, CURVE.Gy))\n      throw new Error("bad curve params: generator point");\n    const _4a3 = Fp.mul(Fp.pow(CURVE.a, _3n2), _4n2);\n    const _27b2 = Fp.mul(Fp.sqr(CURVE.b), BigInt(27));\n    if (Fp.is0(Fp.add(_4a3, _27b2)))\n      throw new Error("bad curve params: a or b");\n    function acoord(title, n, banZero = false) {\n      if (!Fp.isValid(n) || banZero && Fp.is0(n))\n        throw new Error(`bad point coordinate ${title}`);\n      return n;\n    }\n    function aprjpoint(other) {\n      if (!(other instanceof Point2))\n        throw new Error("ProjectivePoint expected");\n    }\n    function splitEndoScalarN(k) {\n      if (!endo || !endo.basises)\n        throw new Error("no endo");\n      return _splitEndoScalar(k, endo.basises, Fn.ORDER);\n    }\n    const toAffineMemo = memoized((p, iz) => {\n      const { X, Y, Z } = p;\n      if (Fp.eql(Z, Fp.ONE))\n        return { x: X, y: Y };\n      const is0 = p.is0();\n      if (iz == null)\n        iz = is0 ? Fp.ONE : Fp.inv(Z);\n      const x = Fp.mul(X, iz);\n      const y = Fp.mul(Y, iz);\n      const zz = Fp.mul(Z, iz);\n      if (is0)\n        return { x: Fp.ZERO, y: Fp.ZERO };\n      if (!Fp.eql(zz, Fp.ONE))\n        throw new Error("invZ was invalid");\n      return { x, y };\n    });\n    const assertValidMemo = memoized((p) => {\n      if (p.is0()) {\n        if (extraOpts.allowInfinityPoint && !Fp.is0(p.Y))\n          return;\n        throw new Error("bad point: ZERO");\n      }\n      const { x, y } = p.toAffine();\n      if (!Fp.isValid(x) || !Fp.isValid(y))\n        throw new Error("bad point: x or y not field elements");\n      if (!isValidXY(x, y))\n        throw new Error("bad point: equation left != right");\n      if (!p.isTorsionFree())\n        throw new Error("bad point: not in prime-order subgroup");\n      return true;\n    });\n    function finishEndo(endoBeta, k1p, k2p, k1neg, k2neg) {\n      k2p = new Point2(Fp.mul(k2p.X, endoBeta), k2p.Y, k2p.Z);\n      k1p = negateCt(k1neg, k1p);\n      k2p = negateCt(k2neg, k2p);\n      return k1p.add(k2p);\n    }\n    class Point2 {\n      /** Does NOT validate if the point is valid. Use `.assertValidity()`. */\n      constructor(X, Y, Z) {\n        this.X = acoord("x", X);\n        this.Y = acoord("y", Y, true);\n        this.Z = acoord("z", Z);\n        Object.freeze(this);\n      }\n      static CURVE() {\n        return CURVE;\n      }\n      /** Does NOT validate if the point is valid. Use `.assertValidity()`. */\n      static fromAffine(p) {\n        const { x, y } = p || {};\n        if (!p || !Fp.isValid(x) || !Fp.isValid(y))\n          throw new Error("invalid affine point");\n        if (p instanceof Point2)\n          throw new Error("projective point not allowed");\n        if (Fp.is0(x) && Fp.is0(y))\n          return Point2.ZERO;\n        return new Point2(x, y, Fp.ONE);\n      }\n      static fromBytes(bytes) {\n        const P = Point2.fromAffine(decodePoint(_abytes2(bytes, void 0, "point")));\n        P.assertValidity();\n        return P;\n      }\n      static fromHex(hex) {\n        return Point2.fromBytes(ensureBytes("pointHex", hex));\n      }\n      get x() {\n        return this.toAffine().x;\n      }\n      get y() {\n        return this.toAffine().y;\n      }\n      /**\n       *\n       * @param windowSize\n       * @param isLazy true will defer table computation until the first multiplication\n       * @returns\n       */\n      precompute(windowSize = 8, isLazy = true) {\n        wnaf.createCache(this, windowSize);\n        if (!isLazy)\n          this.multiply(_3n2);\n        return this;\n      }\n      // TODO: return `this`\n      /** A point on curve is valid if it conforms to equation. */\n      assertValidity() {\n        assertValidMemo(this);\n      }\n      hasEvenY() {\n        const { y } = this.toAffine();\n        if (!Fp.isOdd)\n          throw new Error("Field doesn\'t support isOdd");\n        return !Fp.isOdd(y);\n      }\n      /** Compare one point to another. */\n      equals(other) {\n        aprjpoint(other);\n        const { X: X1, Y: Y1, Z: Z1 } = this;\n        const { X: X2, Y: Y2, Z: Z2 } = other;\n        const U1 = Fp.eql(Fp.mul(X1, Z2), Fp.mul(X2, Z1));\n        const U2 = Fp.eql(Fp.mul(Y1, Z2), Fp.mul(Y2, Z1));\n        return U1 && U2;\n      }\n      /** Flips point to one corresponding to (x, -y) in Affine coordinates. */\n      negate() {\n        return new Point2(this.X, Fp.neg(this.Y), this.Z);\n      }\n      // Renes-Costello-Batina exception-free doubling formula.\n      // There is 30% faster Jacobian formula, but it is not complete.\n      // https://eprint.iacr.org/2015/1060, algorithm 3\n      // Cost: 8M + 3S + 3*a + 2*b3 + 15add.\n      double() {\n        const { a, b } = CURVE;\n        const b3 = Fp.mul(b, _3n2);\n        const { X: X1, Y: Y1, Z: Z1 } = this;\n        let X3 = Fp.ZERO, Y3 = Fp.ZERO, Z3 = Fp.ZERO;\n        let t0 = Fp.mul(X1, X1);\n        let t1 = Fp.mul(Y1, Y1);\n        let t2 = Fp.mul(Z1, Z1);\n        let t3 = Fp.mul(X1, Y1);\n        t3 = Fp.add(t3, t3);\n        Z3 = Fp.mul(X1, Z1);\n        Z3 = Fp.add(Z3, Z3);\n        X3 = Fp.mul(a, Z3);\n        Y3 = Fp.mul(b3, t2);\n        Y3 = Fp.add(X3, Y3);\n        X3 = Fp.sub(t1, Y3);\n        Y3 = Fp.add(t1, Y3);\n        Y3 = Fp.mul(X3, Y3);\n        X3 = Fp.mul(t3, X3);\n        Z3 = Fp.mul(b3, Z3);\n        t2 = Fp.mul(a, t2);\n        t3 = Fp.sub(t0, t2);\n        t3 = Fp.mul(a, t3);\n        t3 = Fp.add(t3, Z3);\n        Z3 = Fp.add(t0, t0);\n        t0 = Fp.add(Z3, t0);\n        t0 = Fp.add(t0, t2);\n        t0 = Fp.mul(t0, t3);\n        Y3 = Fp.add(Y3, t0);\n        t2 = Fp.mul(Y1, Z1);\n        t2 = Fp.add(t2, t2);\n        t0 = Fp.mul(t2, t3);\n        X3 = Fp.sub(X3, t0);\n        Z3 = Fp.mul(t2, t1);\n        Z3 = Fp.add(Z3, Z3);\n        Z3 = Fp.add(Z3, Z3);\n        return new Point2(X3, Y3, Z3);\n      }\n      // Renes-Costello-Batina exception-free addition formula.\n      // There is 30% faster Jacobian formula, but it is not complete.\n      // https://eprint.iacr.org/2015/1060, algorithm 1\n      // Cost: 12M + 0S + 3*a + 3*b3 + 23add.\n      add(other) {\n        aprjpoint(other);\n        const { X: X1, Y: Y1, Z: Z1 } = this;\n        const { X: X2, Y: Y2, Z: Z2 } = other;\n        let X3 = Fp.ZERO, Y3 = Fp.ZERO, Z3 = Fp.ZERO;\n        const a = CURVE.a;\n        const b3 = Fp.mul(CURVE.b, _3n2);\n        let t0 = Fp.mul(X1, X2);\n        let t1 = Fp.mul(Y1, Y2);\n        let t2 = Fp.mul(Z1, Z2);\n        let t3 = Fp.add(X1, Y1);\n        let t4 = Fp.add(X2, Y2);\n        t3 = Fp.mul(t3, t4);\n        t4 = Fp.add(t0, t1);\n        t3 = Fp.sub(t3, t4);\n        t4 = Fp.add(X1, Z1);\n        let t5 = Fp.add(X2, Z2);\n        t4 = Fp.mul(t4, t5);\n        t5 = Fp.add(t0, t2);\n        t4 = Fp.sub(t4, t5);\n        t5 = Fp.add(Y1, Z1);\n        X3 = Fp.add(Y2, Z2);\n        t5 = Fp.mul(t5, X3);\n        X3 = Fp.add(t1, t2);\n        t5 = Fp.sub(t5, X3);\n        Z3 = Fp.mul(a, t4);\n        X3 = Fp.mul(b3, t2);\n        Z3 = Fp.add(X3, Z3);\n        X3 = Fp.sub(t1, Z3);\n        Z3 = Fp.add(t1, Z3);\n        Y3 = Fp.mul(X3, Z3);\n        t1 = Fp.add(t0, t0);\n        t1 = Fp.add(t1, t0);\n        t2 = Fp.mul(a, t2);\n        t4 = Fp.mul(b3, t4);\n        t1 = Fp.add(t1, t2);\n        t2 = Fp.sub(t0, t2);\n        t2 = Fp.mul(a, t2);\n        t4 = Fp.add(t4, t2);\n        t0 = Fp.mul(t1, t4);\n        Y3 = Fp.add(Y3, t0);\n        t0 = Fp.mul(t5, t4);\n        X3 = Fp.mul(t3, X3);\n        X3 = Fp.sub(X3, t0);\n        t0 = Fp.mul(t3, t1);\n        Z3 = Fp.mul(t5, Z3);\n        Z3 = Fp.add(Z3, t0);\n        return new Point2(X3, Y3, Z3);\n      }\n      subtract(other) {\n        return this.add(other.negate());\n      }\n      is0() {\n        return this.equals(Point2.ZERO);\n      }\n      /**\n       * Constant time multiplication.\n       * Uses wNAF method. Windowed method may be 10% faster,\n       * but takes 2x longer to generate and consumes 2x memory.\n       * Uses precomputes when available.\n       * Uses endomorphism for Koblitz curves.\n       * @param scalar by which the point would be multiplied\n       * @returns New point\n       */\n      multiply(scalar) {\n        const { endo: endo2 } = extraOpts;\n        if (!Fn.isValidNot0(scalar))\n          throw new Error("invalid scalar: out of range");\n        let point, fake;\n        const mul = (n) => wnaf.cached(this, n, (p) => normalizeZ(Point2, p));\n        if (endo2) {\n          const { k1neg, k1, k2neg, k2 } = splitEndoScalarN(scalar);\n          const { p: k1p, f: k1f } = mul(k1);\n          const { p: k2p, f: k2f } = mul(k2);\n          fake = k1f.add(k2f);\n          point = finishEndo(endo2.beta, k1p, k2p, k1neg, k2neg);\n        } else {\n          const { p, f } = mul(scalar);\n          point = p;\n          fake = f;\n        }\n        return normalizeZ(Point2, [point, fake])[0];\n      }\n      /**\n       * Non-constant-time multiplication. Uses double-and-add algorithm.\n       * It\'s faster, but should only be used when you don\'t care about\n       * an exposed secret key e.g. sig verification, which works over *public* keys.\n       */\n      multiplyUnsafe(sc) {\n        const { endo: endo2 } = extraOpts;\n        const p = this;\n        if (!Fn.isValid(sc))\n          throw new Error("invalid scalar: out of range");\n        if (sc === _0n4 || p.is0())\n          return Point2.ZERO;\n        if (sc === _1n4)\n          return p;\n        if (wnaf.hasCache(this))\n          return this.multiply(sc);\n        if (endo2) {\n          const { k1neg, k1, k2neg, k2 } = splitEndoScalarN(sc);\n          const { p1, p2 } = mulEndoUnsafe(Point2, p, k1, k2);\n          return finishEndo(endo2.beta, p1, p2, k1neg, k2neg);\n        } else {\n          return wnaf.unsafe(p, sc);\n        }\n      }\n      multiplyAndAddUnsafe(Q, a, b) {\n        const sum = this.multiplyUnsafe(a).add(Q.multiplyUnsafe(b));\n        return sum.is0() ? void 0 : sum;\n      }\n      /**\n       * Converts Projective point to affine (x, y) coordinates.\n       * @param invertedZ Z^-1 (inverted zero) - optional, precomputation is useful for invertBatch\n       */\n      toAffine(invertedZ) {\n        return toAffineMemo(this, invertedZ);\n      }\n      /**\n       * Checks whether Point is free of torsion elements (is in prime subgroup).\n       * Always torsion-free for cofactor=1 curves.\n       */\n      isTorsionFree() {\n        const { isTorsionFree } = extraOpts;\n        if (cofactor === _1n4)\n          return true;\n        if (isTorsionFree)\n          return isTorsionFree(Point2, this);\n        return wnaf.unsafe(this, CURVE_ORDER).is0();\n      }\n      clearCofactor() {\n        const { clearCofactor } = extraOpts;\n        if (cofactor === _1n4)\n          return this;\n        if (clearCofactor)\n          return clearCofactor(Point2, this);\n        return this.multiplyUnsafe(cofactor);\n      }\n      isSmallOrder() {\n        return this.multiplyUnsafe(cofactor).is0();\n      }\n      toBytes(isCompressed = true) {\n        _abool2(isCompressed, "isCompressed");\n        this.assertValidity();\n        return encodePoint(Point2, this, isCompressed);\n      }\n      toHex(isCompressed = true) {\n        return bytesToHex(this.toBytes(isCompressed));\n      }\n      toString() {\n        return `<Point ${this.is0() ? "ZERO" : this.toHex()}>`;\n      }\n      // TODO: remove\n      get px() {\n        return this.X;\n      }\n      get py() {\n        return this.X;\n      }\n      get pz() {\n        return this.Z;\n      }\n      toRawBytes(isCompressed = true) {\n        return this.toBytes(isCompressed);\n      }\n      _setWindowSize(windowSize) {\n        this.precompute(windowSize);\n      }\n      static normalizeZ(points) {\n        return normalizeZ(Point2, points);\n      }\n      static msm(points, scalars) {\n        return pippenger(Point2, Fn, points, scalars);\n      }\n      static fromPrivateKey(privateKey) {\n        return Point2.BASE.multiply(_normFnElement(Fn, privateKey));\n      }\n    }\n    Point2.BASE = new Point2(CURVE.Gx, CURVE.Gy, Fp.ONE);\n    Point2.ZERO = new Point2(Fp.ZERO, Fp.ONE, Fp.ZERO);\n    Point2.Fp = Fp;\n    Point2.Fn = Fn;\n    const bits = Fn.BITS;\n    const wnaf = new wNAF(Point2, extraOpts.endo ? Math.ceil(bits / 2) : bits);\n    Point2.BASE.precompute(8);\n    return Point2;\n  }\n  function pprefix(hasEvenY) {\n    return Uint8Array.of(hasEvenY ? 2 : 3);\n  }\n  function getWLengths(Fp, Fn) {\n    return {\n      secretKey: Fn.BYTES,\n      publicKey: 1 + Fp.BYTES,\n      publicKeyUncompressed: 1 + 2 * Fp.BYTES,\n      publicKeyHasPrefix: true,\n      signature: 2 * Fn.BYTES\n    };\n  }\n  function ecdh(Point2, ecdhOpts = {}) {\n    const { Fn } = Point2;\n    const randomBytes_ = ecdhOpts.randomBytes || randomBytes;\n    const lengths = Object.assign(getWLengths(Point2.Fp, Fn), { seed: getMinHashLength(Fn.ORDER) });\n    function isValidSecretKey(secretKey) {\n      try {\n        return !!_normFnElement(Fn, secretKey);\n      } catch (error) {\n        return false;\n      }\n    }\n    function isValidPublicKey(publicKey, isCompressed) {\n      const { publicKey: comp, publicKeyUncompressed } = lengths;\n      try {\n        const l = publicKey.length;\n        if (isCompressed === true && l !== comp)\n          return false;\n        if (isCompressed === false && l !== publicKeyUncompressed)\n          return false;\n        return !!Point2.fromBytes(publicKey);\n      } catch (error) {\n        return false;\n      }\n    }\n    function randomSecretKey(seed = randomBytes_(lengths.seed)) {\n      return mapHashToField(_abytes2(seed, lengths.seed, "seed"), Fn.ORDER);\n    }\n    function getPublicKey(secretKey, isCompressed = true) {\n      return Point2.BASE.multiply(_normFnElement(Fn, secretKey)).toBytes(isCompressed);\n    }\n    function keygen(seed) {\n      const secretKey = randomSecretKey(seed);\n      return { secretKey, publicKey: getPublicKey(secretKey) };\n    }\n    function isProbPub(item) {\n      if (typeof item === "bigint")\n        return false;\n      if (item instanceof Point2)\n        return true;\n      const { secretKey, publicKey, publicKeyUncompressed } = lengths;\n      if (Fn.allowedLengths || secretKey === publicKey)\n        return void 0;\n      const l = ensureBytes("key", item).length;\n      return l === publicKey || l === publicKeyUncompressed;\n    }\n    function getSharedSecret(secretKeyA, publicKeyB, isCompressed = true) {\n      if (isProbPub(secretKeyA) === true)\n        throw new Error("first arg must be private key");\n      if (isProbPub(publicKeyB) === false)\n        throw new Error("second arg must be public key");\n      const s = _normFnElement(Fn, secretKeyA);\n      const b = Point2.fromHex(publicKeyB);\n      return b.multiply(s).toBytes(isCompressed);\n    }\n    const utils2 = {\n      isValidSecretKey,\n      isValidPublicKey,\n      randomSecretKey,\n      // TODO: remove\n      isValidPrivateKey: isValidSecretKey,\n      randomPrivateKey: randomSecretKey,\n      normPrivateKeyToScalar: (key) => _normFnElement(Fn, key),\n      precompute(windowSize = 8, point = Point2.BASE) {\n        return point.precompute(windowSize, false);\n      }\n    };\n    return Object.freeze({ getPublicKey, getSharedSecret, keygen, Point: Point2, utils: utils2, lengths });\n  }\n  function ecdsa(Point2, hash, ecdsaOpts = {}) {\n    ahash(hash);\n    _validateObject(ecdsaOpts, {}, {\n      hmac: "function",\n      lowS: "boolean",\n      randomBytes: "function",\n      bits2int: "function",\n      bits2int_modN: "function"\n    });\n    const randomBytes2 = ecdsaOpts.randomBytes || randomBytes;\n    const hmac2 = ecdsaOpts.hmac || ((key, ...msgs) => hmac(hash, key, concatBytes(...msgs)));\n    const { Fp, Fn } = Point2;\n    const { ORDER: CURVE_ORDER, BITS: fnBits } = Fn;\n    const { keygen, getPublicKey, getSharedSecret, utils: utils2, lengths } = ecdh(Point2, ecdsaOpts);\n    const defaultSigOpts = {\n      prehash: false,\n      lowS: typeof ecdsaOpts.lowS === "boolean" ? ecdsaOpts.lowS : false,\n      format: void 0,\n      //\'compact\' as ECDSASigFormat,\n      extraEntropy: false\n    };\n    const defaultSigOpts_format = "compact";\n    function isBiggerThanHalfOrder(number) {\n      const HALF = CURVE_ORDER >> _1n4;\n      return number > HALF;\n    }\n    function validateRS(title, num2) {\n      if (!Fn.isValidNot0(num2))\n        throw new Error(`invalid signature ${title}: out of range 1..Point.Fn.ORDER`);\n      return num2;\n    }\n    function validateSigLength(bytes, format) {\n      validateSigFormat(format);\n      const size = lengths.signature;\n      const sizer = format === "compact" ? size : format === "recovered" ? size + 1 : void 0;\n      return _abytes2(bytes, sizer, `${format} signature`);\n    }\n    class Signature {\n      constructor(r, s, recovery) {\n        this.r = validateRS("r", r);\n        this.s = validateRS("s", s);\n        if (recovery != null)\n          this.recovery = recovery;\n        Object.freeze(this);\n      }\n      static fromBytes(bytes, format = defaultSigOpts_format) {\n        validateSigLength(bytes, format);\n        let recid;\n        if (format === "der") {\n          const { r: r2, s: s2 } = DER.toSig(_abytes2(bytes));\n          return new Signature(r2, s2);\n        }\n        if (format === "recovered") {\n          recid = bytes[0];\n          format = "compact";\n          bytes = bytes.subarray(1);\n        }\n        const L = Fn.BYTES;\n        const r = bytes.subarray(0, L);\n        const s = bytes.subarray(L, L * 2);\n        return new Signature(Fn.fromBytes(r), Fn.fromBytes(s), recid);\n      }\n      static fromHex(hex, format) {\n        return this.fromBytes(hexToBytes(hex), format);\n      }\n      addRecoveryBit(recovery) {\n        return new Signature(this.r, this.s, recovery);\n      }\n      recoverPublicKey(messageHash) {\n        const FIELD_ORDER = Fp.ORDER;\n        const { r, s, recovery: rec } = this;\n        if (rec == null || ![0, 1, 2, 3].includes(rec))\n          throw new Error("recovery id invalid");\n        const hasCofactor = CURVE_ORDER * _2n2 < FIELD_ORDER;\n        if (hasCofactor && rec > 1)\n          throw new Error("recovery id is ambiguous for h>1 curve");\n        const radj = rec === 2 || rec === 3 ? r + CURVE_ORDER : r;\n        if (!Fp.isValid(radj))\n          throw new Error("recovery id 2 or 3 invalid");\n        const x = Fp.toBytes(radj);\n        const R = Point2.fromBytes(concatBytes(pprefix((rec & 1) === 0), x));\n        const ir = Fn.inv(radj);\n        const h = bits2int_modN(ensureBytes("msgHash", messageHash));\n        const u1 = Fn.create(-h * ir);\n        const u2 = Fn.create(s * ir);\n        const Q = Point2.BASE.multiplyUnsafe(u1).add(R.multiplyUnsafe(u2));\n        if (Q.is0())\n          throw new Error("point at infinify");\n        Q.assertValidity();\n        return Q;\n      }\n      // Signatures should be low-s, to prevent malleability.\n      hasHighS() {\n        return isBiggerThanHalfOrder(this.s);\n      }\n      toBytes(format = defaultSigOpts_format) {\n        validateSigFormat(format);\n        if (format === "der")\n          return hexToBytes(DER.hexFromSig(this));\n        const r = Fn.toBytes(this.r);\n        const s = Fn.toBytes(this.s);\n        if (format === "recovered") {\n          if (this.recovery == null)\n            throw new Error("recovery bit must be present");\n          return concatBytes(Uint8Array.of(this.recovery), r, s);\n        }\n        return concatBytes(r, s);\n      }\n      toHex(format) {\n        return bytesToHex(this.toBytes(format));\n      }\n      // TODO: remove\n      assertValidity() {\n      }\n      static fromCompact(hex) {\n        return Signature.fromBytes(ensureBytes("sig", hex), "compact");\n      }\n      static fromDER(hex) {\n        return Signature.fromBytes(ensureBytes("sig", hex), "der");\n      }\n      normalizeS() {\n        return this.hasHighS() ? new Signature(this.r, Fn.neg(this.s), this.recovery) : this;\n      }\n      toDERRawBytes() {\n        return this.toBytes("der");\n      }\n      toDERHex() {\n        return bytesToHex(this.toBytes("der"));\n      }\n      toCompactRawBytes() {\n        return this.toBytes("compact");\n      }\n      toCompactHex() {\n        return bytesToHex(this.toBytes("compact"));\n      }\n    }\n    const bits2int = ecdsaOpts.bits2int || function bits2int_def(bytes) {\n      if (bytes.length > 8192)\n        throw new Error("input is too large");\n      const num2 = bytesToNumberBE(bytes);\n      const delta = bytes.length * 8 - fnBits;\n      return delta > 0 ? num2 >> BigInt(delta) : num2;\n    };\n    const bits2int_modN = ecdsaOpts.bits2int_modN || function bits2int_modN_def(bytes) {\n      return Fn.create(bits2int(bytes));\n    };\n    const ORDER_MASK = bitMask(fnBits);\n    function int2octets(num2) {\n      aInRange("num < 2^" + fnBits, num2, _0n4, ORDER_MASK);\n      return Fn.toBytes(num2);\n    }\n    function validateMsgAndHash(message, prehash) {\n      _abytes2(message, void 0, "message");\n      return prehash ? _abytes2(hash(message), void 0, "prehashed message") : message;\n    }\n    function prepSig(message, privateKey, opts) {\n      if (["recovered", "canonical"].some((k) => k in opts))\n        throw new Error("sign() legacy options not supported");\n      const { lowS, prehash, extraEntropy } = validateSigOpts(opts, defaultSigOpts);\n      message = validateMsgAndHash(message, prehash);\n      const h1int = bits2int_modN(message);\n      const d = _normFnElement(Fn, privateKey);\n      const seedArgs = [int2octets(d), int2octets(h1int)];\n      if (extraEntropy != null && extraEntropy !== false) {\n        const e = extraEntropy === true ? randomBytes2(lengths.secretKey) : extraEntropy;\n        seedArgs.push(ensureBytes("extraEntropy", e));\n      }\n      const seed = concatBytes(...seedArgs);\n      const m = h1int;\n      function k2sig(kBytes) {\n        const k = bits2int(kBytes);\n        if (!Fn.isValidNot0(k))\n          return;\n        const ik = Fn.inv(k);\n        const q = Point2.BASE.multiply(k).toAffine();\n        const r = Fn.create(q.x);\n        if (r === _0n4)\n          return;\n        const s = Fn.create(ik * Fn.create(m + r * d));\n        if (s === _0n4)\n          return;\n        let recovery = (q.x === r ? 0 : 2) | Number(q.y & _1n4);\n        let normS = s;\n        if (lowS && isBiggerThanHalfOrder(s)) {\n          normS = Fn.neg(s);\n          recovery ^= 1;\n        }\n        return new Signature(r, normS, recovery);\n      }\n      return { seed, k2sig };\n    }\n    function sign(message, secretKey, opts = {}) {\n      message = ensureBytes("message", message);\n      const { seed, k2sig } = prepSig(message, secretKey, opts);\n      const drbg = createHmacDrbg(hash.outputLen, Fn.BYTES, hmac2);\n      const sig = drbg(seed, k2sig);\n      return sig;\n    }\n    function tryParsingSig(sg) {\n      let sig = void 0;\n      const isHex = typeof sg === "string" || isBytes(sg);\n      const isObj = !isHex && sg !== null && typeof sg === "object" && typeof sg.r === "bigint" && typeof sg.s === "bigint";\n      if (!isHex && !isObj)\n        throw new Error("invalid signature, expected Uint8Array, hex string or Signature instance");\n      if (isObj) {\n        sig = new Signature(sg.r, sg.s);\n      } else if (isHex) {\n        try {\n          sig = Signature.fromBytes(ensureBytes("sig", sg), "der");\n        } catch (derError) {\n          if (!(derError instanceof DER.Err))\n            throw derError;\n        }\n        if (!sig) {\n          try {\n            sig = Signature.fromBytes(ensureBytes("sig", sg), "compact");\n          } catch (error) {\n            return false;\n          }\n        }\n      }\n      if (!sig)\n        return false;\n      return sig;\n    }\n    function verify(signature, message, publicKey, opts = {}) {\n      const { lowS, prehash, format } = validateSigOpts(opts, defaultSigOpts);\n      publicKey = ensureBytes("publicKey", publicKey);\n      message = validateMsgAndHash(ensureBytes("message", message), prehash);\n      if ("strict" in opts)\n        throw new Error("options.strict was renamed to lowS");\n      const sig = format === void 0 ? tryParsingSig(signature) : Signature.fromBytes(ensureBytes("sig", signature), format);\n      if (sig === false)\n        return false;\n      try {\n        const P = Point2.fromBytes(publicKey);\n        if (lowS && sig.hasHighS())\n          return false;\n        const { r, s } = sig;\n        const h = bits2int_modN(message);\n        const is = Fn.inv(s);\n        const u1 = Fn.create(h * is);\n        const u2 = Fn.create(r * is);\n        const R = Point2.BASE.multiplyUnsafe(u1).add(P.multiplyUnsafe(u2));\n        if (R.is0())\n          return false;\n        const v = Fn.create(R.x);\n        return v === r;\n      } catch (e) {\n        return false;\n      }\n    }\n    function recoverPublicKey(signature, message, opts = {}) {\n      const { prehash } = validateSigOpts(opts, defaultSigOpts);\n      message = validateMsgAndHash(message, prehash);\n      return Signature.fromBytes(signature, "recovered").recoverPublicKey(message).toBytes();\n    }\n    return Object.freeze({\n      keygen,\n      getPublicKey,\n      getSharedSecret,\n      utils: utils2,\n      lengths,\n      Point: Point2,\n      sign,\n      verify,\n      recoverPublicKey,\n      Signature,\n      hash\n    });\n  }\n  function _weierstrass_legacy_opts_to_new(c) {\n    const CURVE = {\n      a: c.a,\n      b: c.b,\n      p: c.Fp.ORDER,\n      n: c.n,\n      h: c.h,\n      Gx: c.Gx,\n      Gy: c.Gy\n    };\n    const Fp = c.Fp;\n    let allowedLengths = c.allowedPrivateKeyLengths ? Array.from(new Set(c.allowedPrivateKeyLengths.map((l) => Math.ceil(l / 2)))) : void 0;\n    const Fn = Field(CURVE.n, {\n      BITS: c.nBitLength,\n      allowedLengths,\n      modFromBytes: c.wrapPrivateKey\n    });\n    const curveOpts = {\n      Fp,\n      Fn,\n      allowInfinityPoint: c.allowInfinityPoint,\n      endo: c.endo,\n      isTorsionFree: c.isTorsionFree,\n      clearCofactor: c.clearCofactor,\n      fromBytes: c.fromBytes,\n      toBytes: c.toBytes\n    };\n    return { CURVE, curveOpts };\n  }\n  function _ecdsa_legacy_opts_to_new(c) {\n    const { CURVE, curveOpts } = _weierstrass_legacy_opts_to_new(c);\n    const ecdsaOpts = {\n      hmac: c.hmac,\n      randomBytes: c.randomBytes,\n      lowS: c.lowS,\n      bits2int: c.bits2int,\n      bits2int_modN: c.bits2int_modN\n    };\n    return { CURVE, curveOpts, hash: c.hash, ecdsaOpts };\n  }\n  function _ecdsa_new_output_to_legacy(c, _ecdsa) {\n    const Point2 = _ecdsa.Point;\n    return Object.assign({}, _ecdsa, {\n      ProjectivePoint: Point2,\n      CURVE: Object.assign({}, c, nLength(Point2.Fn.ORDER, Point2.Fn.BITS))\n    });\n  }\n  function weierstrass(c) {\n    const { CURVE, curveOpts, hash, ecdsaOpts } = _ecdsa_legacy_opts_to_new(c);\n    const Point2 = weierstrassN(CURVE, curveOpts);\n    const signs = ecdsa(Point2, hash, ecdsaOpts);\n    return _ecdsa_new_output_to_legacy(c, signs);\n  }\n\n  // ../sign/lib/noble-curves/_shortw_utils.js\n  function createCurve(curveDef, defHash) {\n    const create = (hash) => weierstrass({ ...curveDef, hash });\n    return { ...create(defHash), create };\n  }\n\n  // ../sign/lib/noble-curves/abstract/hash-to-curve.js\n  var _DST_scalar = utf8ToBytes("HashToScalar-");\n\n  // ../sign/lib/noble-curves/secp256k1.js\n  var secp256k1_CURVE = {\n    p: BigInt("0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f"),\n    n: BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141"),\n    h: BigInt(1),\n    a: BigInt(0),\n    b: BigInt(7),\n    Gx: BigInt("0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"),\n    Gy: BigInt("0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8")\n  };\n  var secp256k1_ENDO = {\n    beta: BigInt("0x7ae96a2b657c07106e64479eac3434e99cf0497512f58995c1396c28719501ee"),\n    basises: [\n      [BigInt("0x3086d221a7d46bcde86c90e49284eb15"), -BigInt("0xe4437ed6010e88286f547fa90abfe4c3")],\n      [BigInt("0x114ca50f7a8e2f3f657c1108d9d44cfd8"), BigInt("0x3086d221a7d46bcde86c90e49284eb15")]\n    ]\n  };\n  var _0n5 = /* @__PURE__ */ BigInt(0);\n  var _1n5 = /* @__PURE__ */ BigInt(1);\n  var _2n3 = /* @__PURE__ */ BigInt(2);\n  function sqrtMod(y) {\n    const P = secp256k1_CURVE.p;\n    const _3n3 = BigInt(3), _6n = BigInt(6), _11n = BigInt(11), _22n = BigInt(22);\n    const _23n = BigInt(23), _44n = BigInt(44), _88n = BigInt(88);\n    const b2 = y * y * y % P;\n    const b3 = b2 * b2 * y % P;\n    const b6 = pow2(b3, _3n3, P) * b3 % P;\n    const b9 = pow2(b6, _3n3, P) * b3 % P;\n    const b11 = pow2(b9, _2n3, P) * b2 % P;\n    const b22 = pow2(b11, _11n, P) * b11 % P;\n    const b44 = pow2(b22, _22n, P) * b22 % P;\n    const b88 = pow2(b44, _44n, P) * b44 % P;\n    const b176 = pow2(b88, _88n, P) * b88 % P;\n    const b220 = pow2(b176, _44n, P) * b44 % P;\n    const b223 = pow2(b220, _3n3, P) * b3 % P;\n    const t1 = pow2(b223, _23n, P) * b22 % P;\n    const t2 = pow2(t1, _6n, P) * b2 % P;\n    const root = pow2(t2, _2n3, P);\n    if (!Fpk1.eql(Fpk1.sqr(root), y))\n      throw new Error("Cannot find square root");\n    return root;\n  }\n  var Fpk1 = Field(secp256k1_CURVE.p, { sqrt: sqrtMod });\n  var secp256k1 = createCurve({ ...secp256k1_CURVE, Fp: Fpk1, lowS: true, endo: secp256k1_ENDO }, sha256);\n  var TAGGED_HASH_PREFIXES = {};\n  function taggedHash(tag, ...messages) {\n    let tagP = TAGGED_HASH_PREFIXES[tag];\n    if (tagP === void 0) {\n      const tagH = sha256(utf8ToBytes(tag));\n      tagP = concatBytes(tagH, tagH);\n      TAGGED_HASH_PREFIXES[tag] = tagP;\n    }\n    return sha256(concatBytes(tagP, ...messages));\n  }\n  var pointToBytes = (point) => point.toBytes(true).slice(1);\n  var Pointk1 = /* @__PURE__ */ (() => secp256k1.Point)();\n  var hasEven = (y) => y % _2n3 === _0n5;\n  function schnorrGetExtPubKey(priv) {\n    const { Fn, BASE } = Pointk1;\n    const d_ = _normFnElement(Fn, priv);\n    const p = BASE.multiply(d_);\n    const scalar = hasEven(p.y) ? d_ : Fn.neg(d_);\n    return { scalar, bytes: pointToBytes(p) };\n  }\n  function lift_x(x) {\n    const Fp = Fpk1;\n    if (!Fp.isValidNot0(x))\n      throw new Error("invalid x: Fail if x \\u2265 p");\n    const xx = Fp.create(x * x);\n    const c = Fp.create(xx * x + BigInt(7));\n    let y = Fp.sqrt(c);\n    if (!hasEven(y))\n      y = Fp.neg(y);\n    const p = Pointk1.fromAffine({ x, y });\n    p.assertValidity();\n    return p;\n  }\n  var num = bytesToNumberBE;\n  function challenge(...args) {\n    return Pointk1.Fn.create(num(taggedHash("BIP0340/challenge", ...args)));\n  }\n  function schnorrGetPublicKey(secretKey) {\n    return schnorrGetExtPubKey(secretKey).bytes;\n  }\n  function schnorrSign(message, secretKey, auxRand = randomBytes(32)) {\n    const { Fn } = Pointk1;\n    const m = ensureBytes("message", message);\n    const { bytes: px, scalar: d } = schnorrGetExtPubKey(secretKey);\n    const a = ensureBytes("auxRand", auxRand, 32);\n    const t = Fn.toBytes(d ^ num(taggedHash("BIP0340/aux", a)));\n    const rand = taggedHash("BIP0340/nonce", t, px, m);\n    const { bytes: rx, scalar: k } = schnorrGetExtPubKey(rand);\n    const e = challenge(rx, px, m);\n    const sig = new Uint8Array(64);\n    sig.set(rx, 0);\n    sig.set(Fn.toBytes(Fn.create(k + e * d)), 32);\n    if (!schnorrVerify(sig, m, px))\n      throw new Error("sign: Invalid signature produced");\n    return sig;\n  }\n  function schnorrVerify(signature, message, publicKey) {\n    const { Fn, BASE } = Pointk1;\n    const sig = ensureBytes("signature", signature, 64);\n    const m = ensureBytes("message", message);\n    const pub = ensureBytes("publicKey", publicKey, 32);\n    try {\n      const P = lift_x(num(pub));\n      const r = num(sig.subarray(0, 32));\n      if (!inRange(r, _1n5, secp256k1_CURVE.p))\n        return false;\n      const s = num(sig.subarray(32, 64));\n      if (!inRange(s, _1n5, secp256k1_CURVE.n))\n        return false;\n      const e = challenge(Fn.toBytes(r), pointToBytes(P), m);\n      const R = BASE.multiplyUnsafe(s).add(P.multiplyUnsafe(Fn.neg(e)));\n      const { x, y } = R.toAffine();\n      if (R.is0() || !hasEven(y) || x !== r)\n        return false;\n      return true;\n    } catch (error) {\n      return false;\n    }\n  }\n  var schnorr = /* @__PURE__ */ (() => {\n    const size = 32;\n    const seedLength = 48;\n    const randomSecretKey = (seed = randomBytes(seedLength)) => {\n      return mapHashToField(seed, secp256k1_CURVE.n);\n    };\n    secp256k1.utils.randomSecretKey;\n    function keygen(seed) {\n      const secretKey = randomSecretKey(seed);\n      return { secretKey, publicKey: schnorrGetPublicKey(secretKey) };\n    }\n    return {\n      keygen,\n      getPublicKey: schnorrGetPublicKey,\n      sign: schnorrSign,\n      verify: schnorrVerify,\n      Point: Pointk1,\n      utils: {\n        randomSecretKey,\n        randomPrivateKey: randomSecretKey,\n        taggedHash,\n        // TODO: remove\n        lift_x,\n        pointToBytes,\n        numberToBytesBE,\n        bytesToNumberBE,\n        mod\n      },\n      lengths: {\n        secretKey: size,\n        publicKey: size,\n        publicKeyHasPrefix: false,\n        signature: size * 2,\n        seed: seedLength\n      }\n    };\n  })();\n\n  // ../sign/lib/noble-hashes/legacy.js\n  var Rho160 = /* @__PURE__ */ Uint8Array.from([\n    7,\n    4,\n    13,\n    1,\n    10,\n    6,\n    15,\n    3,\n    12,\n    0,\n    9,\n    5,\n    2,\n    14,\n    11,\n    8\n  ]);\n  var Id160 = /* @__PURE__ */ (() => Uint8Array.from(new Array(16).fill(0).map((_, i) => i)))();\n  var Pi160 = /* @__PURE__ */ (() => Id160.map((i) => (9 * i + 5) % 16))();\n  var idxLR = /* @__PURE__ */ (() => {\n    const L = [Id160];\n    const R = [Pi160];\n    const res = [L, R];\n    for (let i = 0; i < 4; i++)\n      for (let j of res)\n        j.push(j[i].map((k) => Rho160[k]));\n    return res;\n  })();\n  var idxL = /* @__PURE__ */ (() => idxLR[0])();\n  var idxR = /* @__PURE__ */ (() => idxLR[1])();\n  var shifts160 = /* @__PURE__ */ [\n    [11, 14, 15, 12, 5, 8, 7, 9, 11, 13, 14, 15, 6, 7, 9, 8],\n    [12, 13, 11, 15, 6, 9, 9, 7, 12, 15, 11, 13, 7, 8, 7, 7],\n    [13, 15, 14, 11, 7, 7, 6, 8, 13, 14, 13, 12, 5, 5, 6, 9],\n    [14, 11, 12, 14, 8, 6, 5, 5, 15, 12, 15, 14, 9, 9, 8, 6],\n    [15, 12, 13, 13, 9, 5, 8, 6, 14, 11, 12, 11, 8, 6, 5, 5]\n  ].map((i) => Uint8Array.from(i));\n  var shiftsL160 = /* @__PURE__ */ idxL.map((idx, i) => idx.map((j) => shifts160[i][j]));\n  var shiftsR160 = /* @__PURE__ */ idxR.map((idx, i) => idx.map((j) => shifts160[i][j]));\n  var Kl160 = /* @__PURE__ */ Uint32Array.from([\n    0,\n    1518500249,\n    1859775393,\n    2400959708,\n    2840853838\n  ]);\n  var Kr160 = /* @__PURE__ */ Uint32Array.from([\n    1352829926,\n    1548603684,\n    1836072691,\n    2053994217,\n    0\n  ]);\n  function ripemd_f(group, x, y, z) {\n    if (group === 0)\n      return x ^ y ^ z;\n    if (group === 1)\n      return x & y | ~x & z;\n    if (group === 2)\n      return (x | ~y) ^ z;\n    if (group === 3)\n      return x & z | y & ~z;\n    return x ^ (y | ~z);\n  }\n  var BUF_160 = /* @__PURE__ */ new Uint32Array(16);\n  var RIPEMD160 = class extends HashMD {\n    constructor() {\n      super(64, 20, 8, true);\n      this.h0 = 1732584193 | 0;\n      this.h1 = 4023233417 | 0;\n      this.h2 = 2562383102 | 0;\n      this.h3 = 271733878 | 0;\n      this.h4 = 3285377520 | 0;\n    }\n    get() {\n      const { h0, h1, h2, h3, h4 } = this;\n      return [h0, h1, h2, h3, h4];\n    }\n    set(h0, h1, h2, h3, h4) {\n      this.h0 = h0 | 0;\n      this.h1 = h1 | 0;\n      this.h2 = h2 | 0;\n      this.h3 = h3 | 0;\n      this.h4 = h4 | 0;\n    }\n    process(view, offset) {\n      for (let i = 0; i < 16; i++, offset += 4)\n        BUF_160[i] = view.getUint32(offset, true);\n      let al = this.h0 | 0, ar = al, bl = this.h1 | 0, br = bl, cl = this.h2 | 0, cr = cl, dl = this.h3 | 0, dr = dl, el = this.h4 | 0, er = el;\n      for (let group = 0; group < 5; group++) {\n        const rGroup = 4 - group;\n        const hbl = Kl160[group], hbr = Kr160[group];\n        const rl = idxL[group], rr = idxR[group];\n        const sl = shiftsL160[group], sr = shiftsR160[group];\n        for (let i = 0; i < 16; i++) {\n          const tl = rotl(al + ripemd_f(group, bl, cl, dl) + BUF_160[rl[i]] + hbl, sl[i]) + el | 0;\n          al = el, el = dl, dl = rotl(cl, 10) | 0, cl = bl, bl = tl;\n        }\n        for (let i = 0; i < 16; i++) {\n          const tr = rotl(ar + ripemd_f(rGroup, br, cr, dr) + BUF_160[rr[i]] + hbr, sr[i]) + er | 0;\n          ar = er, er = dr, dr = rotl(cr, 10) | 0, cr = br, br = tr;\n        }\n      }\n      this.set(this.h1 + cl + dr | 0, this.h2 + dl + er | 0, this.h3 + el + ar | 0, this.h4 + al + br | 0, this.h0 + bl + cr | 0);\n    }\n    roundClean() {\n      clean(BUF_160);\n    }\n    destroy() {\n      this.destroyed = true;\n      clean(this.buffer);\n      this.set(0, 0, 0, 0, 0);\n    }\n  };\n  var ripemd160 = /* @__PURE__ */ createHasher(() => new RIPEMD160());\n\n  // ../sign/lib/scure-base/index.js\n  function isBytes2(a) {\n    return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array";\n  }\n  function isArrayOf(isString, arr) {\n    if (!Array.isArray(arr))\n      return false;\n    if (arr.length === 0)\n      return true;\n    if (isString) {\n      return arr.every((item) => typeof item === "string");\n    } else {\n      return arr.every((item) => Number.isSafeInteger(item));\n    }\n  }\n  function afn(input) {\n    if (typeof input !== "function")\n      throw new Error("function expected");\n    return true;\n  }\n  function astr(label, input) {\n    if (typeof input !== "string")\n      throw new Error(`${label}: string expected`);\n    return true;\n  }\n  function anumber2(n) {\n    if (!Number.isSafeInteger(n))\n      throw new Error(`invalid integer: ${n}`);\n  }\n  function aArr(input) {\n    if (!Array.isArray(input))\n      throw new Error("array expected");\n  }\n  function astrArr(label, input) {\n    if (!isArrayOf(true, input))\n      throw new Error(`${label}: array of strings expected`);\n  }\n  function anumArr(label, input) {\n    if (!isArrayOf(false, input))\n      throw new Error(`${label}: array of numbers expected`);\n  }\n  // @__NO_SIDE_EFFECTS__\n  function chain(...args) {\n    const id = (a) => a;\n    const wrap = (a, b) => (c) => a(b(c));\n    const encode = args.map((x) => x.encode).reduceRight(wrap, id);\n    const decode = args.map((x) => x.decode).reduce(wrap, id);\n    return { encode, decode };\n  }\n  // @__NO_SIDE_EFFECTS__\n  function alphabet(letters) {\n    const lettersA = typeof letters === "string" ? letters.split("") : letters;\n    const len = lettersA.length;\n    astrArr("alphabet", lettersA);\n    const indexes = new Map(lettersA.map((l, i) => [l, i]));\n    return {\n      encode: (digits) => {\n        aArr(digits);\n        return digits.map((i) => {\n          if (!Number.isSafeInteger(i) || i < 0 || i >= len)\n            throw new Error(`alphabet.encode: digit index outside alphabet "${i}". Allowed: ${letters}`);\n          return lettersA[i];\n        });\n      },\n      decode: (input) => {\n        aArr(input);\n        return input.map((letter) => {\n          astr("alphabet.decode", letter);\n          const i = indexes.get(letter);\n          if (i === void 0)\n            throw new Error(`Unknown letter: "${letter}". Allowed: ${letters}`);\n          return i;\n        });\n      }\n    };\n  }\n  // @__NO_SIDE_EFFECTS__\n  function join(separator = "") {\n    astr("join", separator);\n    return {\n      encode: (from) => {\n        astrArr("join.decode", from);\n        return from.join(separator);\n      },\n      decode: (to) => {\n        astr("join.decode", to);\n        return to.split(separator);\n      }\n    };\n  }\n  // @__NO_SIDE_EFFECTS__\n  function padding(bits, chr = "=") {\n    anumber2(bits);\n    astr("padding", chr);\n    return {\n      encode(data) {\n        astrArr("padding.encode", data);\n        while (data.length * bits % 8)\n          data.push(chr);\n        return data;\n      },\n      decode(input) {\n        astrArr("padding.decode", input);\n        let end = input.length;\n        if (end * bits % 8)\n          throw new Error("padding: invalid, string should have whole number of bytes");\n        for (; end > 0 && input[end - 1] === chr; end--) {\n          const last = end - 1;\n          const byte = last * bits;\n          if (byte % 8 === 0)\n            throw new Error("padding: invalid, string has too much padding");\n        }\n        return input.slice(0, end);\n      }\n    };\n  }\n  function convertRadix(data, from, to) {\n    if (from < 2)\n      throw new Error(`convertRadix: invalid from=${from}, base cannot be less than 2`);\n    if (to < 2)\n      throw new Error(`convertRadix: invalid to=${to}, base cannot be less than 2`);\n    aArr(data);\n    if (!data.length)\n      return [];\n    let pos = 0;\n    const res = [];\n    const digits = Array.from(data, (d) => {\n      anumber2(d);\n      if (d < 0 || d >= from)\n        throw new Error(`invalid integer: ${d}`);\n      return d;\n    });\n    const dlen = digits.length;\n    while (true) {\n      let carry = 0;\n      let done = true;\n      for (let i = pos; i < dlen; i++) {\n        const digit = digits[i];\n        const fromCarry = from * carry;\n        const digitBase = fromCarry + digit;\n        if (!Number.isSafeInteger(digitBase) || fromCarry / from !== carry || digitBase - digit !== fromCarry) {\n          throw new Error("convertRadix: carry overflow");\n        }\n        const div = digitBase / to;\n        carry = digitBase % to;\n        const rounded = Math.floor(div);\n        digits[i] = rounded;\n        if (!Number.isSafeInteger(rounded) || rounded * to + carry !== digitBase)\n          throw new Error("convertRadix: carry overflow");\n        if (!done)\n          continue;\n        else if (!rounded)\n          pos = i;\n        else\n          done = false;\n      }\n      res.push(carry);\n      if (done)\n        break;\n    }\n    for (let i = 0; i < data.length - 1 && data[i] === 0; i++)\n      res.push(0);\n    return res.reverse();\n  }\n  var gcd = (a, b) => b === 0 ? a : gcd(b, a % b);\n  var radix2carry = /* @__NO_SIDE_EFFECTS__ */ (from, to) => from + (to - gcd(from, to));\n  var powers = /* @__PURE__ */ (() => {\n    let res = [];\n    for (let i = 0; i < 40; i++)\n      res.push(2 ** i);\n    return res;\n  })();\n  function convertRadix2(data, from, to, padding2) {\n    aArr(data);\n    if (from <= 0 || from > 32)\n      throw new Error(`convertRadix2: wrong from=${from}`);\n    if (to <= 0 || to > 32)\n      throw new Error(`convertRadix2: wrong to=${to}`);\n    if (/* @__PURE__ */ radix2carry(from, to) > 32) {\n      throw new Error(`convertRadix2: carry overflow from=${from} to=${to} carryBits=${/* @__PURE__ */ radix2carry(from, to)}`);\n    }\n    let carry = 0;\n    let pos = 0;\n    const max = powers[from];\n    const mask = powers[to] - 1;\n    const res = [];\n    for (const n of data) {\n      anumber2(n);\n      if (n >= max)\n        throw new Error(`convertRadix2: invalid data word=${n} from=${from}`);\n      carry = carry << from | n;\n      if (pos + from > 32)\n        throw new Error(`convertRadix2: carry overflow pos=${pos} from=${from}`);\n      pos += from;\n      for (; pos >= to; pos -= to)\n        res.push((carry >> pos - to & mask) >>> 0);\n      const pow = powers[pos];\n      if (pow === void 0)\n        throw new Error("invalid carry");\n      carry &= pow - 1;\n    }\n    carry = carry << to - pos & mask;\n    if (!padding2 && pos >= from)\n      throw new Error("Excess padding");\n    if (!padding2 && carry > 0)\n      throw new Error(`Non-zero padding: ${carry}`);\n    if (padding2 && pos > 0)\n      res.push(carry >>> 0);\n    return res;\n  }\n  // @__NO_SIDE_EFFECTS__\n  function radix(num2) {\n    anumber2(num2);\n    const _256 = 2 ** 8;\n    return {\n      encode: (bytes) => {\n        if (!isBytes2(bytes))\n          throw new Error("radix.encode input should be Uint8Array");\n        return convertRadix(Array.from(bytes), _256, num2);\n      },\n      decode: (digits) => {\n        anumArr("radix.decode", digits);\n        return Uint8Array.from(convertRadix(digits, num2, _256));\n      }\n    };\n  }\n  // @__NO_SIDE_EFFECTS__\n  function radix2(bits, revPadding = false) {\n    anumber2(bits);\n    if (bits <= 0 || bits > 32)\n      throw new Error("radix2: bits should be in (0..32]");\n    if (/* @__PURE__ */ radix2carry(8, bits) > 32 || /* @__PURE__ */ radix2carry(bits, 8) > 32)\n      throw new Error("radix2: carry overflow");\n    return {\n      encode: (bytes) => {\n        if (!isBytes2(bytes))\n          throw new Error("radix2.encode input should be Uint8Array");\n        return convertRadix2(Array.from(bytes), 8, bits, !revPadding);\n      },\n      decode: (digits) => {\n        anumArr("radix2.decode", digits);\n        return Uint8Array.from(convertRadix2(digits, bits, 8, revPadding));\n      }\n    };\n  }\n  function checksum(len, fn) {\n    anumber2(len);\n    afn(fn);\n    return {\n      encode(data) {\n        if (!isBytes2(data))\n          throw new Error("checksum.encode: input should be Uint8Array");\n        const sum = fn(data).slice(0, len);\n        const res = new Uint8Array(data.length + len);\n        res.set(data);\n        res.set(sum, data.length);\n        return res;\n      },\n      decode(data) {\n        if (!isBytes2(data))\n          throw new Error("checksum.decode: input should be Uint8Array");\n        const payload = data.slice(0, -len);\n        const oldChecksum = data.slice(-len);\n        const newChecksum = fn(payload).slice(0, len);\n        for (let i = 0; i < len; i++)\n          if (newChecksum[i] !== oldChecksum[i])\n            throw new Error("Invalid checksum");\n        return payload;\n      }\n    };\n  }\n  var utils = {\n    alphabet,\n    chain,\n    checksum,\n    convertRadix,\n    convertRadix2,\n    radix,\n    radix2,\n    join,\n    padding\n  };\n  var genBase58 = /* @__NO_SIDE_EFFECTS__ */ (abc) => /* @__PURE__ */ chain(/* @__PURE__ */ radix(58), /* @__PURE__ */ alphabet(abc), /* @__PURE__ */ join(""));\n  var base58 = /* @__PURE__ */ genBase58("123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz");\n  var createBase58check = (sha2563) => /* @__PURE__ */ chain(checksum(4, (data) => sha2563(sha2563(data))), base58);\n\n  // ../sign/lib/scure-bip32/index.js\n  var Point = secp256k1.ProjectivePoint;\n  var base58check = createBase58check(sha256);\n  function bytesToNumber(bytes) {\n    abytes(bytes);\n    const h = bytes.length === 0 ? "0" : bytesToHex(bytes);\n    return BigInt("0x" + h);\n  }\n  function numberToBytes(num2) {\n    if (typeof num2 !== "bigint")\n      throw new Error("bigint expected");\n    return hexToBytes(num2.toString(16).padStart(64, "0"));\n  }\n  var MASTER_SECRET = utf8ToBytes("Bitcoin seed");\n  var BITCOIN_VERSIONS = { private: 76066276, public: 76067358 };\n  var HARDENED_OFFSET = 2147483648;\n  var hash160 = (data) => ripemd160(sha256(data));\n  var fromU32 = (data) => createView(data).getUint32(0, false);\n  var toU32 = (n) => {\n    if (!Number.isSafeInteger(n) || n < 0 || n > 2 ** 32 - 1) {\n      throw new Error("invalid number, should be from 0 to 2**32-1, got " + n);\n    }\n    const buf = new Uint8Array(4);\n    createView(buf).setUint32(0, n, false);\n    return buf;\n  };\n  var HDKey = class _HDKey {\n    get fingerprint() {\n      if (!this.pubHash) {\n        throw new Error("No publicKey set!");\n      }\n      return fromU32(this.pubHash);\n    }\n    get identifier() {\n      return this.pubHash;\n    }\n    get pubKeyHash() {\n      return this.pubHash;\n    }\n    get privateKey() {\n      return this.privKeyBytes || null;\n    }\n    get publicKey() {\n      return this.pubKey || null;\n    }\n    get privateExtendedKey() {\n      const priv = this.privateKey;\n      if (!priv) {\n        throw new Error("No private key");\n      }\n      return base58check.encode(this.serialize(this.versions.private, concatBytes(new Uint8Array([0]), priv)));\n    }\n    get publicExtendedKey() {\n      if (!this.pubKey) {\n        throw new Error("No public key");\n      }\n      return base58check.encode(this.serialize(this.versions.public, this.pubKey));\n    }\n    static fromMasterSeed(seed, versions = BITCOIN_VERSIONS) {\n      abytes(seed);\n      if (8 * seed.length < 128 || 8 * seed.length > 512) {\n        throw new Error("HDKey: seed length must be between 128 and 512 bits; 256 bits is advised, got " + seed.length);\n      }\n      const I = hmac(sha512, MASTER_SECRET, seed);\n      return new _HDKey({\n        versions,\n        chainCode: I.slice(32),\n        privateKey: I.slice(0, 32)\n      });\n    }\n    static fromExtendedKey(base58key, versions = BITCOIN_VERSIONS) {\n      const keyBuffer = base58check.decode(base58key);\n      const keyView = createView(keyBuffer);\n      const version = keyView.getUint32(0, false);\n      const opt = {\n        versions,\n        depth: keyBuffer[4],\n        parentFingerprint: keyView.getUint32(5, false),\n        index: keyView.getUint32(9, false),\n        chainCode: keyBuffer.slice(13, 45)\n      };\n      const key = keyBuffer.slice(45);\n      const isPriv = key[0] === 0;\n      if (version !== versions[isPriv ? "private" : "public"]) {\n        throw new Error("Version mismatch");\n      }\n      if (isPriv) {\n        return new _HDKey({ ...opt, privateKey: key.slice(1) });\n      } else {\n        return new _HDKey({ ...opt, publicKey: key });\n      }\n    }\n    static fromJSON(json) {\n      return _HDKey.fromExtendedKey(json.xpriv);\n    }\n    constructor(opt) {\n      this.depth = 0;\n      this.index = 0;\n      this.chainCode = null;\n      this.parentFingerprint = 0;\n      if (!opt || typeof opt !== "object") {\n        throw new Error("HDKey.constructor must not be called directly");\n      }\n      this.versions = opt.versions || BITCOIN_VERSIONS;\n      this.depth = opt.depth || 0;\n      this.chainCode = opt.chainCode || null;\n      this.index = opt.index || 0;\n      this.parentFingerprint = opt.parentFingerprint || 0;\n      if (!this.depth) {\n        if (this.parentFingerprint || this.index) {\n          throw new Error("HDKey: zero depth with non-zero index/parent fingerprint");\n        }\n      }\n      if (opt.publicKey && opt.privateKey) {\n        throw new Error("HDKey: publicKey and privateKey at same time.");\n      }\n      if (opt.privateKey) {\n        if (!secp256k1.utils.isValidPrivateKey(opt.privateKey)) {\n          throw new Error("Invalid private key");\n        }\n        this.privKey = typeof opt.privateKey === "bigint" ? opt.privateKey : bytesToNumber(opt.privateKey);\n        this.privKeyBytes = numberToBytes(this.privKey);\n        this.pubKey = secp256k1.getPublicKey(opt.privateKey, true);\n      } else if (opt.publicKey) {\n        this.pubKey = Point.fromHex(opt.publicKey).toRawBytes(true);\n      } else {\n        throw new Error("HDKey: no public or private key provided");\n      }\n      this.pubHash = hash160(this.pubKey);\n    }\n    derive(path) {\n      if (!/^[mM]\'?/.test(path)) {\n        throw new Error(\'Path must start with "m" or "M"\');\n      }\n      if (/^[mM]\'?$/.test(path)) {\n        return this;\n      }\n      const parts = path.replace(/^[mM]\'?\\//, "").split("/");\n      let child = this;\n      for (const c of parts) {\n        const m = /^(\\d+)(\'?)$/.exec(c);\n        const m1 = m && m[1];\n        if (!m || m.length !== 3 || typeof m1 !== "string")\n          throw new Error("invalid child index: " + c);\n        let idx = +m1;\n        if (!Number.isSafeInteger(idx) || idx >= HARDENED_OFFSET) {\n          throw new Error("Invalid index");\n        }\n        if (m[2] === "\'") {\n          idx += HARDENED_OFFSET;\n        }\n        child = child.deriveChild(idx);\n      }\n      return child;\n    }\n    deriveChild(index) {\n      if (!this.pubKey || !this.chainCode) {\n        throw new Error("No publicKey or chainCode set");\n      }\n      let data = toU32(index);\n      if (index >= HARDENED_OFFSET) {\n        const priv = this.privateKey;\n        if (!priv) {\n          throw new Error("Could not derive hardened child key");\n        }\n        data = concatBytes(new Uint8Array([0]), priv, data);\n      } else {\n        data = concatBytes(this.pubKey, data);\n      }\n      const I = hmac(sha512, this.chainCode, data);\n      const childTweak = bytesToNumber(I.slice(0, 32));\n      const chainCode = I.slice(32);\n      if (!secp256k1.utils.isValidPrivateKey(childTweak)) {\n        throw new Error("Tweak bigger than curve order");\n      }\n      const opt = {\n        versions: this.versions,\n        chainCode,\n        depth: this.depth + 1,\n        parentFingerprint: this.fingerprint,\n        index\n      };\n      try {\n        if (this.privateKey) {\n          const added = mod(this.privKey + childTweak, secp256k1.CURVE.n);\n          if (!secp256k1.utils.isValidPrivateKey(added)) {\n            throw new Error("The tweak was out of range or the resulted private key is invalid");\n          }\n          opt.privateKey = added;\n        } else {\n          const added = Point.fromHex(this.pubKey).add(Point.fromPrivateKey(childTweak));\n          if (added.equals(Point.ZERO)) {\n            throw new Error("The tweak was equal to negative P, which made the result key invalid");\n          }\n          opt.publicKey = added.toRawBytes(true);\n        }\n        return new _HDKey(opt);\n      } catch (err) {\n        return this.deriveChild(index + 1);\n      }\n    }\n    sign(hash) {\n      if (!this.privateKey) {\n        throw new Error("No privateKey set!");\n      }\n      abytes(hash, 32);\n      return secp256k1.sign(hash, this.privKey).toCompactRawBytes();\n    }\n    verify(hash, signature) {\n      abytes(hash, 32);\n      abytes(signature, 64);\n      if (!this.publicKey) {\n        throw new Error("No publicKey set!");\n      }\n      let sig;\n      try {\n        sig = secp256k1.Signature.fromCompact(signature);\n      } catch (error) {\n        return false;\n      }\n      return secp256k1.verify(sig, hash, this.publicKey);\n    }\n    wipePrivateData() {\n      this.privKey = void 0;\n      if (this.privKeyBytes) {\n        this.privKeyBytes.fill(0);\n        this.privKeyBytes = void 0;\n      }\n      return this;\n    }\n    toJSON() {\n      return {\n        xpriv: this.privateExtendedKey,\n        xpub: this.publicExtendedKey\n      };\n    }\n    serialize(version, key) {\n      if (!this.chainCode) {\n        throw new Error("No chainCode set");\n      }\n      abytes(key, 33);\n      return concatBytes(toU32(version), new Uint8Array([this.depth]), toU32(this.parentFingerprint), toU32(this.index), this.chainCode, key);\n    }\n  };\n\n  // ../sign/lib/noble-hashes/pbkdf2.js\n  function pbkdf2Init(hash, _password, _salt, _opts) {\n    ahash(hash);\n    const opts = checkOpts({ dkLen: 32, asyncTick: 10 }, _opts);\n    const { c, dkLen, asyncTick } = opts;\n    anumber(c);\n    anumber(dkLen);\n    anumber(asyncTick);\n    if (c < 1)\n      throw new Error("iterations (c) should be >= 1");\n    const password = kdfInputToBytes(_password);\n    const salt = kdfInputToBytes(_salt);\n    const DK = new Uint8Array(dkLen);\n    const PRF = hmac.create(hash, password);\n    const PRFSalt = PRF._cloneInto().update(salt);\n    return { c, dkLen, asyncTick, DK, PRF, PRFSalt };\n  }\n  function pbkdf2Output(PRF, PRFSalt, DK, prfW, u) {\n    PRF.destroy();\n    PRFSalt.destroy();\n    if (prfW)\n      prfW.destroy();\n    clean(u);\n    return DK;\n  }\n  function pbkdf2(hash, password, salt, opts) {\n    const { c, dkLen, DK, PRF, PRFSalt } = pbkdf2Init(hash, password, salt, opts);\n    let prfW;\n    const arr = new Uint8Array(4);\n    const view = createView(arr);\n    const u = new Uint8Array(PRF.outputLen);\n    for (let ti = 1, pos = 0; pos < dkLen; ti++, pos += PRF.outputLen) {\n      const Ti = DK.subarray(pos, pos + PRF.outputLen);\n      view.setInt32(0, ti, false);\n      (prfW = PRFSalt._cloneInto(prfW)).update(arr).digestInto(u);\n      Ti.set(u.subarray(0, Ti.length));\n      for (let ui = 1; ui < c; ui++) {\n        PRF._cloneInto(prfW).update(u).digestInto(u);\n        for (let i = 0; i < Ti.length; i++)\n          Ti[i] ^= u[i];\n      }\n    }\n    return pbkdf2Output(PRF, PRFSalt, DK, prfW, u);\n  }\n\n  // ../sign/lib/scure-bip39/index.js\n  var isJapanese = (wordlist2) => wordlist2[0] === "\\u3042\\u3044\\u3053\\u304F\\u3057\\u3093";\n  function nfkd(str) {\n    if (typeof str !== "string")\n      throw new TypeError("invalid mnemonic type: " + typeof str);\n    return str.normalize("NFKD");\n  }\n  function normalize(str) {\n    const norm = nfkd(str);\n    const words = norm.split(" ");\n    if (![12, 15, 18, 21, 24].includes(words.length))\n      throw new Error("Invalid mnemonic");\n    return { nfkd: norm, words };\n  }\n  function aentropy(ent) {\n    abytes(ent, 16, 20, 24, 28, 32);\n  }\n  function generateMnemonic(wordlist2, strength = 128) {\n    anumber(strength);\n    if (strength % 32 !== 0 || strength > 256)\n      throw new TypeError("Invalid entropy");\n    return entropyToMnemonic(randomBytes(strength / 8), wordlist2);\n  }\n  var calcChecksum = (entropy) => {\n    const bitsLeft = 8 - entropy.length / 4;\n    return new Uint8Array([sha256(entropy)[0] >> bitsLeft << bitsLeft]);\n  };\n  function getCoder(wordlist2) {\n    if (!Array.isArray(wordlist2) || wordlist2.length !== 2048 || typeof wordlist2[0] !== "string")\n      throw new Error("Wordlist: expected array of 2048 strings");\n    wordlist2.forEach((i) => {\n      if (typeof i !== "string")\n        throw new Error("wordlist: non-string element: " + i);\n    });\n    return utils.chain(utils.checksum(1, calcChecksum), utils.radix2(11, true), utils.alphabet(wordlist2));\n  }\n  function mnemonicToEntropy(mnemonic, wordlist2) {\n    const { words } = normalize(mnemonic);\n    const entropy = getCoder(wordlist2).decode(words);\n    aentropy(entropy);\n    return entropy;\n  }\n  function entropyToMnemonic(entropy, wordlist2) {\n    aentropy(entropy);\n    const words = getCoder(wordlist2).encode(entropy);\n    return words.join(isJapanese(wordlist2) ? "\\u3000" : " ");\n  }\n  function validateMnemonic(mnemonic, wordlist2) {\n    try {\n      mnemonicToEntropy(mnemonic, wordlist2);\n    } catch (e) {\n      return false;\n    }\n    return true;\n  }\n  var psalt = (passphrase) => nfkd("mnemonic" + passphrase);\n  function mnemonicToSeedSync(mnemonic, passphrase = "") {\n    return pbkdf2(sha512, normalize(mnemonic).nfkd, psalt(passphrase), { c: 2048, dkLen: 64 });\n  }\n\n  // ../sign/lib/scure-bip39/wordlists/english.js\n  var wordlist = `abandon\nability\nable\nabout\nabove\nabsent\nabsorb\nabstract\nabsurd\nabuse\naccess\naccident\naccount\naccuse\nachieve\nacid\nacoustic\nacquire\nacross\nact\naction\nactor\nactress\nactual\nadapt\nadd\naddict\naddress\nadjust\nadmit\nadult\nadvance\nadvice\naerobic\naffair\nafford\nafraid\nagain\nage\nagent\nagree\nahead\naim\nair\nairport\naisle\nalarm\nalbum\nalcohol\nalert\nalien\nall\nalley\nallow\nalmost\nalone\nalpha\nalready\nalso\nalter\nalways\namateur\namazing\namong\namount\namused\nanalyst\nanchor\nancient\nanger\nangle\nangry\nanimal\nankle\nannounce\nannual\nanother\nanswer\nantenna\nantique\nanxiety\nany\napart\napology\nappear\napple\napprove\napril\narch\narctic\narea\narena\nargue\narm\narmed\narmor\narmy\naround\narrange\narrest\narrive\narrow\nart\nartefact\nartist\nartwork\nask\naspect\nassault\nasset\nassist\nassume\nasthma\nathlete\natom\nattack\nattend\nattitude\nattract\nauction\naudit\naugust\naunt\nauthor\nauto\nautumn\naverage\navocado\navoid\nawake\naware\naway\nawesome\nawful\nawkward\naxis\nbaby\nbachelor\nbacon\nbadge\nbag\nbalance\nbalcony\nball\nbamboo\nbanana\nbanner\nbar\nbarely\nbargain\nbarrel\nbase\nbasic\nbasket\nbattle\nbeach\nbean\nbeauty\nbecause\nbecome\nbeef\nbefore\nbegin\nbehave\nbehind\nbelieve\nbelow\nbelt\nbench\nbenefit\nbest\nbetray\nbetter\nbetween\nbeyond\nbicycle\nbid\nbike\nbind\nbiology\nbird\nbirth\nbitter\nblack\nblade\nblame\nblanket\nblast\nbleak\nbless\nblind\nblood\nblossom\nblouse\nblue\nblur\nblush\nboard\nboat\nbody\nboil\nbomb\nbone\nbonus\nbook\nboost\nborder\nboring\nborrow\nboss\nbottom\nbounce\nbox\nboy\nbracket\nbrain\nbrand\nbrass\nbrave\nbread\nbreeze\nbrick\nbridge\nbrief\nbright\nbring\nbrisk\nbroccoli\nbroken\nbronze\nbroom\nbrother\nbrown\nbrush\nbubble\nbuddy\nbudget\nbuffalo\nbuild\nbulb\nbulk\nbullet\nbundle\nbunker\nburden\nburger\nburst\nbus\nbusiness\nbusy\nbutter\nbuyer\nbuzz\ncabbage\ncabin\ncable\ncactus\ncage\ncake\ncall\ncalm\ncamera\ncamp\ncan\ncanal\ncancel\ncandy\ncannon\ncanoe\ncanvas\ncanyon\ncapable\ncapital\ncaptain\ncar\ncarbon\ncard\ncargo\ncarpet\ncarry\ncart\ncase\ncash\ncasino\ncastle\ncasual\ncat\ncatalog\ncatch\ncategory\ncattle\ncaught\ncause\ncaution\ncave\nceiling\ncelery\ncement\ncensus\ncentury\ncereal\ncertain\nchair\nchalk\nchampion\nchange\nchaos\nchapter\ncharge\nchase\nchat\ncheap\ncheck\ncheese\nchef\ncherry\nchest\nchicken\nchief\nchild\nchimney\nchoice\nchoose\nchronic\nchuckle\nchunk\nchurn\ncigar\ncinnamon\ncircle\ncitizen\ncity\ncivil\nclaim\nclap\nclarify\nclaw\nclay\nclean\nclerk\nclever\nclick\nclient\ncliff\nclimb\nclinic\nclip\nclock\nclog\nclose\ncloth\ncloud\nclown\nclub\nclump\ncluster\nclutch\ncoach\ncoast\ncoconut\ncode\ncoffee\ncoil\ncoin\ncollect\ncolor\ncolumn\ncombine\ncome\ncomfort\ncomic\ncommon\ncompany\nconcert\nconduct\nconfirm\ncongress\nconnect\nconsider\ncontrol\nconvince\ncook\ncool\ncopper\ncopy\ncoral\ncore\ncorn\ncorrect\ncost\ncotton\ncouch\ncountry\ncouple\ncourse\ncousin\ncover\ncoyote\ncrack\ncradle\ncraft\ncram\ncrane\ncrash\ncrater\ncrawl\ncrazy\ncream\ncredit\ncreek\ncrew\ncricket\ncrime\ncrisp\ncritic\ncrop\ncross\ncrouch\ncrowd\ncrucial\ncruel\ncruise\ncrumble\ncrunch\ncrush\ncry\ncrystal\ncube\nculture\ncup\ncupboard\ncurious\ncurrent\ncurtain\ncurve\ncushion\ncustom\ncute\ncycle\ndad\ndamage\ndamp\ndance\ndanger\ndaring\ndash\ndaughter\ndawn\nday\ndeal\ndebate\ndebris\ndecade\ndecember\ndecide\ndecline\ndecorate\ndecrease\ndeer\ndefense\ndefine\ndefy\ndegree\ndelay\ndeliver\ndemand\ndemise\ndenial\ndentist\ndeny\ndepart\ndepend\ndeposit\ndepth\ndeputy\nderive\ndescribe\ndesert\ndesign\ndesk\ndespair\ndestroy\ndetail\ndetect\ndevelop\ndevice\ndevote\ndiagram\ndial\ndiamond\ndiary\ndice\ndiesel\ndiet\ndiffer\ndigital\ndignity\ndilemma\ndinner\ndinosaur\ndirect\ndirt\ndisagree\ndiscover\ndisease\ndish\ndismiss\ndisorder\ndisplay\ndistance\ndivert\ndivide\ndivorce\ndizzy\ndoctor\ndocument\ndog\ndoll\ndolphin\ndomain\ndonate\ndonkey\ndonor\ndoor\ndose\ndouble\ndove\ndraft\ndragon\ndrama\ndrastic\ndraw\ndream\ndress\ndrift\ndrill\ndrink\ndrip\ndrive\ndrop\ndrum\ndry\nduck\ndumb\ndune\nduring\ndust\ndutch\nduty\ndwarf\ndynamic\neager\neagle\nearly\nearn\nearth\neasily\neast\neasy\necho\necology\neconomy\nedge\nedit\neducate\neffort\negg\neight\neither\nelbow\nelder\nelectric\nelegant\nelement\nelephant\nelevator\nelite\nelse\nembark\nembody\nembrace\nemerge\nemotion\nemploy\nempower\nempty\nenable\nenact\nend\nendless\nendorse\nenemy\nenergy\nenforce\nengage\nengine\nenhance\nenjoy\nenlist\nenough\nenrich\nenroll\nensure\nenter\nentire\nentry\nenvelope\nepisode\nequal\nequip\nera\nerase\nerode\nerosion\nerror\nerupt\nescape\nessay\nessence\nestate\neternal\nethics\nevidence\nevil\nevoke\nevolve\nexact\nexample\nexcess\nexchange\nexcite\nexclude\nexcuse\nexecute\nexercise\nexhaust\nexhibit\nexile\nexist\nexit\nexotic\nexpand\nexpect\nexpire\nexplain\nexpose\nexpress\nextend\nextra\neye\neyebrow\nfabric\nface\nfaculty\nfade\nfaint\nfaith\nfall\nfalse\nfame\nfamily\nfamous\nfan\nfancy\nfantasy\nfarm\nfashion\nfat\nfatal\nfather\nfatigue\nfault\nfavorite\nfeature\nfebruary\nfederal\nfee\nfeed\nfeel\nfemale\nfence\nfestival\nfetch\nfever\nfew\nfiber\nfiction\nfield\nfigure\nfile\nfilm\nfilter\nfinal\nfind\nfine\nfinger\nfinish\nfire\nfirm\nfirst\nfiscal\nfish\nfit\nfitness\nfix\nflag\nflame\nflash\nflat\nflavor\nflee\nflight\nflip\nfloat\nflock\nfloor\nflower\nfluid\nflush\nfly\nfoam\nfocus\nfog\nfoil\nfold\nfollow\nfood\nfoot\nforce\nforest\nforget\nfork\nfortune\nforum\nforward\nfossil\nfoster\nfound\nfox\nfragile\nframe\nfrequent\nfresh\nfriend\nfringe\nfrog\nfront\nfrost\nfrown\nfrozen\nfruit\nfuel\nfun\nfunny\nfurnace\nfury\nfuture\ngadget\ngain\ngalaxy\ngallery\ngame\ngap\ngarage\ngarbage\ngarden\ngarlic\ngarment\ngas\ngasp\ngate\ngather\ngauge\ngaze\ngeneral\ngenius\ngenre\ngentle\ngenuine\ngesture\nghost\ngiant\ngift\ngiggle\nginger\ngiraffe\ngirl\ngive\nglad\nglance\nglare\nglass\nglide\nglimpse\nglobe\ngloom\nglory\nglove\nglow\nglue\ngoat\ngoddess\ngold\ngood\ngoose\ngorilla\ngospel\ngossip\ngovern\ngown\ngrab\ngrace\ngrain\ngrant\ngrape\ngrass\ngravity\ngreat\ngreen\ngrid\ngrief\ngrit\ngrocery\ngroup\ngrow\ngrunt\nguard\nguess\nguide\nguilt\nguitar\ngun\ngym\nhabit\nhair\nhalf\nhammer\nhamster\nhand\nhappy\nharbor\nhard\nharsh\nharvest\nhat\nhave\nhawk\nhazard\nhead\nhealth\nheart\nheavy\nhedgehog\nheight\nhello\nhelmet\nhelp\nhen\nhero\nhidden\nhigh\nhill\nhint\nhip\nhire\nhistory\nhobby\nhockey\nhold\nhole\nholiday\nhollow\nhome\nhoney\nhood\nhope\nhorn\nhorror\nhorse\nhospital\nhost\nhotel\nhour\nhover\nhub\nhuge\nhuman\nhumble\nhumor\nhundred\nhungry\nhunt\nhurdle\nhurry\nhurt\nhusband\nhybrid\nice\nicon\nidea\nidentify\nidle\nignore\nill\nillegal\nillness\nimage\nimitate\nimmense\nimmune\nimpact\nimpose\nimprove\nimpulse\ninch\ninclude\nincome\nincrease\nindex\nindicate\nindoor\nindustry\ninfant\ninflict\ninform\ninhale\ninherit\ninitial\ninject\ninjury\ninmate\ninner\ninnocent\ninput\ninquiry\ninsane\ninsect\ninside\ninspire\ninstall\nintact\ninterest\ninto\ninvest\ninvite\ninvolve\niron\nisland\nisolate\nissue\nitem\nivory\njacket\njaguar\njar\njazz\njealous\njeans\njelly\njewel\njob\njoin\njoke\njourney\njoy\njudge\njuice\njump\njungle\njunior\njunk\njust\nkangaroo\nkeen\nkeep\nketchup\nkey\nkick\nkid\nkidney\nkind\nkingdom\nkiss\nkit\nkitchen\nkite\nkitten\nkiwi\nknee\nknife\nknock\nknow\nlab\nlabel\nlabor\nladder\nlady\nlake\nlamp\nlanguage\nlaptop\nlarge\nlater\nlatin\nlaugh\nlaundry\nlava\nlaw\nlawn\nlawsuit\nlayer\nlazy\nleader\nleaf\nlearn\nleave\nlecture\nleft\nleg\nlegal\nlegend\nleisure\nlemon\nlend\nlength\nlens\nleopard\nlesson\nletter\nlevel\nliar\nliberty\nlibrary\nlicense\nlife\nlift\nlight\nlike\nlimb\nlimit\nlink\nlion\nliquid\nlist\nlittle\nlive\nlizard\nload\nloan\nlobster\nlocal\nlock\nlogic\nlonely\nlong\nloop\nlottery\nloud\nlounge\nlove\nloyal\nlucky\nluggage\nlumber\nlunar\nlunch\nluxury\nlyrics\nmachine\nmad\nmagic\nmagnet\nmaid\nmail\nmain\nmajor\nmake\nmammal\nman\nmanage\nmandate\nmango\nmansion\nmanual\nmaple\nmarble\nmarch\nmargin\nmarine\nmarket\nmarriage\nmask\nmass\nmaster\nmatch\nmaterial\nmath\nmatrix\nmatter\nmaximum\nmaze\nmeadow\nmean\nmeasure\nmeat\nmechanic\nmedal\nmedia\nmelody\nmelt\nmember\nmemory\nmention\nmenu\nmercy\nmerge\nmerit\nmerry\nmesh\nmessage\nmetal\nmethod\nmiddle\nmidnight\nmilk\nmillion\nmimic\nmind\nminimum\nminor\nminute\nmiracle\nmirror\nmisery\nmiss\nmistake\nmix\nmixed\nmixture\nmobile\nmodel\nmodify\nmom\nmoment\nmonitor\nmonkey\nmonster\nmonth\nmoon\nmoral\nmore\nmorning\nmosquito\nmother\nmotion\nmotor\nmountain\nmouse\nmove\nmovie\nmuch\nmuffin\nmule\nmultiply\nmuscle\nmuseum\nmushroom\nmusic\nmust\nmutual\nmyself\nmystery\nmyth\nnaive\nname\nnapkin\nnarrow\nnasty\nnation\nnature\nnear\nneck\nneed\nnegative\nneglect\nneither\nnephew\nnerve\nnest\nnet\nnetwork\nneutral\nnever\nnews\nnext\nnice\nnight\nnoble\nnoise\nnominee\nnoodle\nnormal\nnorth\nnose\nnotable\nnote\nnothing\nnotice\nnovel\nnow\nnuclear\nnumber\nnurse\nnut\noak\nobey\nobject\noblige\nobscure\nobserve\nobtain\nobvious\noccur\nocean\noctober\nodor\noff\noffer\noffice\noften\noil\nokay\nold\nolive\nolympic\nomit\nonce\none\nonion\nonline\nonly\nopen\nopera\nopinion\noppose\noption\norange\norbit\norchard\norder\nordinary\norgan\norient\noriginal\norphan\nostrich\nother\noutdoor\nouter\noutput\noutside\noval\noven\nover\nown\nowner\noxygen\noyster\nozone\npact\npaddle\npage\npair\npalace\npalm\npanda\npanel\npanic\npanther\npaper\nparade\nparent\npark\nparrot\nparty\npass\npatch\npath\npatient\npatrol\npattern\npause\npave\npayment\npeace\npeanut\npear\npeasant\npelican\npen\npenalty\npencil\npeople\npepper\nperfect\npermit\nperson\npet\nphone\nphoto\nphrase\nphysical\npiano\npicnic\npicture\npiece\npig\npigeon\npill\npilot\npink\npioneer\npipe\npistol\npitch\npizza\nplace\nplanet\nplastic\nplate\nplay\nplease\npledge\npluck\nplug\nplunge\npoem\npoet\npoint\npolar\npole\npolice\npond\npony\npool\npopular\nportion\nposition\npossible\npost\npotato\npottery\npoverty\npowder\npower\npractice\npraise\npredict\nprefer\nprepare\npresent\npretty\nprevent\nprice\npride\nprimary\nprint\npriority\nprison\nprivate\nprize\nproblem\nprocess\nproduce\nprofit\nprogram\nproject\npromote\nproof\nproperty\nprosper\nprotect\nproud\nprovide\npublic\npudding\npull\npulp\npulse\npumpkin\npunch\npupil\npuppy\npurchase\npurity\npurpose\npurse\npush\nput\npuzzle\npyramid\nquality\nquantum\nquarter\nquestion\nquick\nquit\nquiz\nquote\nrabbit\nraccoon\nrace\nrack\nradar\nradio\nrail\nrain\nraise\nrally\nramp\nranch\nrandom\nrange\nrapid\nrare\nrate\nrather\nraven\nraw\nrazor\nready\nreal\nreason\nrebel\nrebuild\nrecall\nreceive\nrecipe\nrecord\nrecycle\nreduce\nreflect\nreform\nrefuse\nregion\nregret\nregular\nreject\nrelax\nrelease\nrelief\nrely\nremain\nremember\nremind\nremove\nrender\nrenew\nrent\nreopen\nrepair\nrepeat\nreplace\nreport\nrequire\nrescue\nresemble\nresist\nresource\nresponse\nresult\nretire\nretreat\nreturn\nreunion\nreveal\nreview\nreward\nrhythm\nrib\nribbon\nrice\nrich\nride\nridge\nrifle\nright\nrigid\nring\nriot\nripple\nrisk\nritual\nrival\nriver\nroad\nroast\nrobot\nrobust\nrocket\nromance\nroof\nrookie\nroom\nrose\nrotate\nrough\nround\nroute\nroyal\nrubber\nrude\nrug\nrule\nrun\nrunway\nrural\nsad\nsaddle\nsadness\nsafe\nsail\nsalad\nsalmon\nsalon\nsalt\nsalute\nsame\nsample\nsand\nsatisfy\nsatoshi\nsauce\nsausage\nsave\nsay\nscale\nscan\nscare\nscatter\nscene\nscheme\nschool\nscience\nscissors\nscorpion\nscout\nscrap\nscreen\nscript\nscrub\nsea\nsearch\nseason\nseat\nsecond\nsecret\nsection\nsecurity\nseed\nseek\nsegment\nselect\nsell\nseminar\nsenior\nsense\nsentence\nseries\nservice\nsession\nsettle\nsetup\nseven\nshadow\nshaft\nshallow\nshare\nshed\nshell\nsheriff\nshield\nshift\nshine\nship\nshiver\nshock\nshoe\nshoot\nshop\nshort\nshoulder\nshove\nshrimp\nshrug\nshuffle\nshy\nsibling\nsick\nside\nsiege\nsight\nsign\nsilent\nsilk\nsilly\nsilver\nsimilar\nsimple\nsince\nsing\nsiren\nsister\nsituate\nsix\nsize\nskate\nsketch\nski\nskill\nskin\nskirt\nskull\nslab\nslam\nsleep\nslender\nslice\nslide\nslight\nslim\nslogan\nslot\nslow\nslush\nsmall\nsmart\nsmile\nsmoke\nsmooth\nsnack\nsnake\nsnap\nsniff\nsnow\nsoap\nsoccer\nsocial\nsock\nsoda\nsoft\nsolar\nsoldier\nsolid\nsolution\nsolve\nsomeone\nsong\nsoon\nsorry\nsort\nsoul\nsound\nsoup\nsource\nsouth\nspace\nspare\nspatial\nspawn\nspeak\nspecial\nspeed\nspell\nspend\nsphere\nspice\nspider\nspike\nspin\nspirit\nsplit\nspoil\nsponsor\nspoon\nsport\nspot\nspray\nspread\nspring\nspy\nsquare\nsqueeze\nsquirrel\nstable\nstadium\nstaff\nstage\nstairs\nstamp\nstand\nstart\nstate\nstay\nsteak\nsteel\nstem\nstep\nstereo\nstick\nstill\nsting\nstock\nstomach\nstone\nstool\nstory\nstove\nstrategy\nstreet\nstrike\nstrong\nstruggle\nstudent\nstuff\nstumble\nstyle\nsubject\nsubmit\nsubway\nsuccess\nsuch\nsudden\nsuffer\nsugar\nsuggest\nsuit\nsummer\nsun\nsunny\nsunset\nsuper\nsupply\nsupreme\nsure\nsurface\nsurge\nsurprise\nsurround\nsurvey\nsuspect\nsustain\nswallow\nswamp\nswap\nswarm\nswear\nsweet\nswift\nswim\nswing\nswitch\nsword\nsymbol\nsymptom\nsyrup\nsystem\ntable\ntackle\ntag\ntail\ntalent\ntalk\ntank\ntape\ntarget\ntask\ntaste\ntattoo\ntaxi\nteach\nteam\ntell\nten\ntenant\ntennis\ntent\nterm\ntest\ntext\nthank\nthat\ntheme\nthen\ntheory\nthere\nthey\nthing\nthis\nthought\nthree\nthrive\nthrow\nthumb\nthunder\nticket\ntide\ntiger\ntilt\ntimber\ntime\ntiny\ntip\ntired\ntissue\ntitle\ntoast\ntobacco\ntoday\ntoddler\ntoe\ntogether\ntoilet\ntoken\ntomato\ntomorrow\ntone\ntongue\ntonight\ntool\ntooth\ntop\ntopic\ntopple\ntorch\ntornado\ntortoise\ntoss\ntotal\ntourist\ntoward\ntower\ntown\ntoy\ntrack\ntrade\ntraffic\ntragic\ntrain\ntransfer\ntrap\ntrash\ntravel\ntray\ntreat\ntree\ntrend\ntrial\ntribe\ntrick\ntrigger\ntrim\ntrip\ntrophy\ntrouble\ntruck\ntrue\ntruly\ntrumpet\ntrust\ntruth\ntry\ntube\ntuition\ntumble\ntuna\ntunnel\nturkey\nturn\nturtle\ntwelve\ntwenty\ntwice\ntwin\ntwist\ntwo\ntype\ntypical\nugly\numbrella\nunable\nunaware\nuncle\nuncover\nunder\nundo\nunfair\nunfold\nunhappy\nuniform\nunique\nunit\nuniverse\nunknown\nunlock\nuntil\nunusual\nunveil\nupdate\nupgrade\nuphold\nupon\nupper\nupset\nurban\nurge\nusage\nuse\nused\nuseful\nuseless\nusual\nutility\nvacant\nvacuum\nvague\nvalid\nvalley\nvalve\nvan\nvanish\nvapor\nvarious\nvast\nvault\nvehicle\nvelvet\nvendor\nventure\nvenue\nverb\nverify\nversion\nvery\nvessel\nveteran\nviable\nvibrant\nvicious\nvictory\nvideo\nview\nvillage\nvintage\nviolin\nvirtual\nvirus\nvisa\nvisit\nvisual\nvital\nvivid\nvocal\nvoice\nvoid\nvolcano\nvolume\nvote\nvoyage\nwage\nwagon\nwait\nwalk\nwall\nwalnut\nwant\nwarfare\nwarm\nwarrior\nwash\nwasp\nwaste\nwater\nwave\nway\nwealth\nweapon\nwear\nweasel\nweather\nweb\nwedding\nweekend\nweird\nwelcome\nwest\nwet\nwhale\nwhat\nwheat\nwheel\nwhen\nwhere\nwhip\nwhisper\nwide\nwidth\nwife\nwild\nwill\nwin\nwindow\nwine\nwing\nwink\nwinner\nwinter\nwire\nwisdom\nwise\nwish\nwitness\nwolf\nwoman\nwonder\nwood\nwool\nword\nwork\nworld\nworry\nworth\nwrap\nwreck\nwrestle\nwrist\nwrite\nwrong\nyard\nyear\nyellow\nyou\nyoung\nyouth\nzebra\nzero\nzone\nzoo`.split("\\n");\n\n  // ../sign/lib/noble-hashes/sha256.js\n  var sha2562 = sha256;\n\n  // ../sign/lib/noble-curves/abstract/utils.js\n  var bytesToNumberBE2 = bytesToNumberBE;\n\n  // ../sign/src/crypto.js\n  var NETWORKS = {\n    mainnet: {\n      id: "mainnet",\n      label: "Mainnet",\n      hrp: "prl",\n      coinType: 808276,\n      wifVersion: 128,\n      txVersion: 1,\n      blockbook: "https://blockbook.pearlresearch.ai"\n    },\n    testnet: {\n      id: "testnet",\n      label: "Testnet",\n      hrp: "tprl",\n      coinType: 1,\n      wifVersion: 239,\n      txVersion: 1,\n      blockbook: ""\n      // no public Pearl testnet blockbook known \u2014 user configurable\n    }\n  };\n  var PRLS = Object.freeze({\n    tick: "prls",\n    max: "2100000000",\n    lim: "100000",\n    dec: "18",\n    mintFeeGrain: 1e8\n  });\n  var CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";\n  var BECH32M_CONST = 734539939;\n  function polymod(values) {\n    const GEN = [996825010, 642813549, 513874426, 1027748829, 705979059];\n    let chk = 1;\n    for (const v of values) {\n      const b = chk >>> 25;\n      chk = (chk & 33554431) << 5 ^ v;\n      for (let i = 0; i < 5; i++) if (b >>> i & 1) chk ^= GEN[i];\n    }\n    return chk;\n  }\n  function hrpExpand(hrp) {\n    const a = [];\n    for (const c of hrp) a.push(c.charCodeAt(0) >>> 5);\n    a.push(0);\n    for (const c of hrp) a.push(c.charCodeAt(0) & 31);\n    return a;\n  }\n  function checksum2(hrp, data) {\n    const values = hrpExpand(hrp).concat(data, [0, 0, 0, 0, 0, 0]);\n    const mod2 = polymod(values) ^ BECH32M_CONST;\n    const out = [];\n    for (let i = 0; i < 6; i++) out.push(mod2 >>> 5 * (5 - i) & 31);\n    return out;\n  }\n  function convertBits(data, fromBits, toBits, pad, strictPadding = false) {\n    let acc = 0, bits = 0;\n    const ret = [];\n    const maxv = (1 << toBits) - 1;\n    for (const value of data) {\n      acc = acc << fromBits | value;\n      bits += fromBits;\n      while (bits >= toBits) {\n        bits -= toBits;\n        ret.push(acc >>> bits & maxv);\n      }\n    }\n    if (pad && bits) ret.push(acc << toBits - bits & maxv);\n    if (!pad && bits) {\n      if (strictPadding && (acc & (1 << bits) - 1) !== 0) throw new Error("invalid padding");\n    }\n    return ret;\n  }\n  function encodeBech32m(hrp, version, program) {\n    if (!(program instanceof Uint8Array) || program.length !== 32) throw new Error("program must be 32 bytes");\n    if (version !== 1) throw new Error("only witness v1 (taproot) supported");\n    const data5 = [version, ...convertBits([...program], 8, 5, true)];\n    return hrp + "1" + data5.concat(checksum2(hrp, data5)).map((v) => CHARSET[v]).join("");\n  }\n  function decodeBech32m(addr, expectHrp = null) {\n    if (typeof addr !== "string") throw new Error("address must be string");\n    const raw = addr.trim();\n    if (raw !== raw.toLowerCase() && raw !== raw.toUpperCase()) throw new Error("mixed case");\n    addr = raw.toLowerCase();\n    if (addr.length > 90) throw new Error("too long");\n    const pos = addr.lastIndexOf("1");\n    if (pos < 1 || addr.length - pos - 1 < 7) throw new Error("missing separator");\n    const hrp = addr.slice(0, pos);\n    if (!/^[a-z0-9]+$/.test(hrp)) throw new Error("bad hrp");\n    if (expectHrp && hrp !== expectHrp) throw new Error(`wrong network: expected ${expectHrp}, got ${hrp}`);\n    const data5 = [];\n    for (const c of addr.slice(pos + 1)) {\n      const v = CHARSET.indexOf(c);\n      if (v === -1) throw new Error("invalid char");\n      data5.push(v);\n    }\n    if (polymod(hrpExpand(hrp).concat(data5)) !== BECH32M_CONST) throw new Error("bad checksum");\n    const payload = data5.slice(0, -6);\n    if (payload[0] !== 1) throw new Error("only witness v1 (taproot) supported");\n    const data8 = convertBits(payload.slice(1), 5, 8, false, true);\n    if (data8.length !== 32) throw new Error("program must be 32 bytes (v1 taproot)");\n    return { hrp, version: payload[0], program: Uint8Array.from(data8) };\n  }\n  var b58check = createBase58check(sha2562);\n  function walletToWIF(priv, network) {\n    const payload = new Uint8Array(34);\n    payload[0] = network.wifVersion;\n    payload.set(priv, 1);\n    payload[33] = 1;\n    return b58check.encode(payload);\n  }\n\n  // src/vanity-core.js\n  var BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";\n  var MAX_PREFIX_LEN = 5;\n  var MIN_PREFIX_LEN = 1;\n  function normalizePrefix(raw) {\n    const s = String(raw ?? "").trim().toLowerCase();\n    if (s.length < MIN_PREFIX_LEN) return { error: `Type at least ${MIN_PREFIX_LEN} character.` };\n    if (s.length > MAX_PREFIX_LEN)\n      return { error: `Keep it to ${MAX_PREFIX_LEN} characters \\u2014 32^${s.length} combinations is not a browser job.` };\n    for (const ch of s) {\n      if (!BECH32_CHARSET.includes(ch)) {\n        const hint = ch === "1" ? " \\u2014 \'1\' is the bech32 separator and can never appear in the data part" : "bii o".includes(ch) && "bio".includes(ch) ? " \\u2014 bech32 drops b, i, o to avoid look-alikes" : "";\n        return { error: `Character \'${ch}\' is not in the bech32 alphabet${hint}.` };\n      }\n    }\n    return { prefix: s };\n  }\n  function expectedAttempts(prefixLen) {\n    return 32n ** BigInt(prefixLen);\n  }\n  function hitProbability(attempts, prefixLen) {\n    const p = 1 / Number(expectedAttempts(prefixLen));\n    const k = Number(attempts);\n    if (!Number.isFinite(k) || k < 0) return 0;\n    return 1 - Math.exp(-k * p);\n  }\n  function formatBig(n) {\n    const s = n.toString();\n    return s.replace(/\\B(?=(\\d{3})+(?!\\d))/g, ",");\n  }\n  function formatDuration(seconds) {\n    if (!Number.isFinite(seconds)) return "\\u2014";\n    if (seconds < 1) return "< 1 second";\n    const units = [\n      ["day", 86400],\n      ["hour", 3600],\n      ["minute", 60],\n      ["second", 1]\n    ];\n    const parts = [];\n    let rem = Math.floor(seconds);\n    for (const [name, size] of units) {\n      const v = Math.floor(rem / size);\n      if (v > 0) {\n        parts.push(`${v} ${name}${v > 1 ? "s" : ""}`);\n        rem -= v * size;\n      }\n      if (parts.length === 2) break;\n    }\n    return parts.join(" ") || "< 1 second";\n  }\n  function randomScalar(rng) {\n    const n = secp256k1.CURVE.n;\n    for (; ; ) {\n      const b = rng(32);\n      if (!(b instanceof Uint8Array) || b.length !== 32) throw new Error("rng must return 32 bytes");\n      let zero = true;\n      for (let i = 0; i < 32; i++) if (b[i] !== 0) {\n        zero = false;\n        break;\n      }\n      if (zero) continue;\n      if (bytesToNumberBE2(b) >= n) continue;\n      return b;\n    }\n  }\n  function vanityFromPriv(priv, network) {\n    const p = priv instanceof Uint8Array ? priv : hexToBytes(priv);\n    if (p.length !== 32) throw new Error("private key must be 32 bytes");\n    const xonly = schnorr.getPublicKey(p);\n    return {\n      priv: p,\n      xonly,\n      address: encodeBech32m(network.hrp, 1, xonly),\n      network\n    };\n  }\n  function vanityToWIF(priv, network) {\n    const p = priv instanceof Uint8Array ? priv : hexToBytes(priv);\n    return walletToWIF(p, network);\n  }\n  function vanityFromWIF(wif, network) {\n    return vanityFromPriv(decodeRawWIF(wif, network), network);\n  }\n  function decodeRawWIF(wif, network) {\n    const b58check2 = createBase58check(sha2562);\n    const raw = b58check2.decode(String(wif).trim());\n    if (raw.length < 33) throw new Error("invalid WIF payload length");\n    if (raw[0] !== network.wifVersion) throw new Error("wrong WIF network version");\n    let key = raw.slice(1);\n    if (key.length === 33 && key[32] === 1) key = key.slice(0, 32);\n    if (key.length !== 32) throw new Error("invalid WIF key length");\n    return key;\n  }\n  function seedFromMnemonic(mnemonic) {\n    const words = String(mnemonic ?? "").trim().split(/\\s+/);\n    if (words.length !== 12 && words.length !== 24) throw new Error("Enter a 12- or 24-word BIP-39 mnemonic.");\n    if (!validateMnemonic(words.join(" "), wordlist)) throw new Error("Mnemonic failed checksum validation \\u2014 check the words.");\n    return mnemonicToSeedSync(words.join(" "));\n  }\n  function newVanityMnemonic() {\n    return generateMnemonic(wordlist, 128);\n  }\n  function bip86AccountNode(seedBytes, network, account) {\n    if (!Number.isInteger(account) || account < 0 || account > 2147483647) throw new Error("bad account");\n    const root = HDKey.fromMasterSeed(seedBytes);\n    return {\n      node: root.derive(`m/86\'/${network.coinType}\'/${account}\'`),\n      account,\n      network\n    };\n  }\n  function bip86ChildPriv(accountNode, index) {\n    if (!Number.isInteger(index) || index < 0 || index > 2147483647) throw new Error("bad index");\n    const child = accountNode.node.deriveChild(0).deriveChild(index);\n    if (!child.privateKey) throw new Error("derivation failed");\n    return { priv: child.privateKey, path: `m/86\'/${accountNode.network.coinType}\'/${accountNode.account}\'/0/${index}` };\n  }\n  function fullTarget(networkId, prefix) {\n    const hrp = NETWORKS[networkId].hrp;\n    return `${hrp}1p${prefix}`;\n  }\n  function addressMatches(address, networkId, prefix) {\n    return address.startsWith(fullTarget(networkId, prefix));\n  }\n  function grindBatch(opts) {\n    const { prefix, networkId, mode, startIndex, batchSize, rng } = opts;\n    const network = NETWORKS[networkId];\n    if (!network) throw new Error("unknown network");\n    const norm = normalizePrefix(prefix);\n    if (norm.error) throw new Error(norm.error);\n    const want = fullTarget(networkId, norm.prefix);\n    let scanned = 0;\n    for (let i = 0; i < batchSize; i++) {\n      let priv, path = null, index = null;\n      if (mode === "random") {\n        priv = randomScalar(rng);\n      } else if (mode === "bip86") {\n        if (!opts.accountNode) throw new Error("bip86 mode needs accountNode");\n        index = startIndex + i * (opts.stride || 1);\n        const c = bip86ChildPriv(opts.accountNode, index);\n        priv = c.priv;\n        path = c.path;\n      } else {\n        throw new Error("unknown grind mode");\n      }\n      const w = vanityFromPriv(priv, network);\n      scanned++;\n      if (w.address.startsWith(want)) {\n        return {\n          scanned,\n          found: {\n            address: w.address,\n            xonlyHex: bytesToHex(w.xonly),\n            privHex: bytesToHex(w.priv),\n            wif: vanityToWIF(w.priv, network),\n            mode,\n            path,\n            index,\n            networkId\n          }\n        };\n      }\n    }\n    return { scanned, found: null };\n  }\n  function verifyFound(found, prefix) {\n    const network = NETWORKS[found.networkId];\n    if (!network) return { ok: false, error: "unknown network" };\n    const norm = normalizePrefix(prefix);\n    if (norm.error) return { ok: false, error: norm.error };\n    const w = vanityFromPriv(hexToBytes(found.privHex), network);\n    if (w.address !== found.address) return { ok: false, error: "address does not re-derive from the private key" };\n    if (!w.address.startsWith(fullTarget(found.networkId, norm.prefix)))\n      return { ok: false, error: "address does not match the requested prefix" };\n    return { ok: true, xonlyHex: bytesToHex(w.xonly) };\n  }\n  function proveKeyControl(privHex, messageBytes) {\n    const priv = hexToBytes(privHex);\n    const xonly = schnorr.getPublicKey(priv);\n    const sig = schnorr.sign(messageBytes, priv);\n    const ok = schnorr.verify(sig, messageBytes, xonly);\n    return { ok, sigHex: bytesToHex(sig), xonlyHex: bytesToHex(xonly) };\n  }\n  function decodeVanityAddress(address, networkId) {\n    const network = NETWORKS[networkId];\n    const d = decodeBech32m(address, network.hrp);\n    if (d.version !== 1) throw new Error("not a v1 (Taproot) address");\n    if (d.program.length !== 32) throw new Error("program is not 32 bytes");\n    return bytesToHex(d.program);\n  }\n  return __toCommonJS(grind_entry_exports);\n})();\n/*! noble-hashes - MIT License (c) 2022 Paul Miller (paulmillr.com) */\n/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */\n/*! scure-base - MIT License (c) 2022 Paul Miller (paulmillr.com) */\n/*! scure-bip32 - MIT License (c) 2022 Patricio Palladino, Paul Miller (paulmillr.com) */\n/*! scure-bip39 - MIT License (c) 2022 Patricio Palladino, Paul Miller (paulmillr.com) */\n\n/* Pearl Vanity worker driver \u2014 classic dedicated-worker script.\n * build.mjs concatenates the grind bundle (above) with this driver into\n * grind-worker.js. The page spawns it via Blob URL so it works on both\n * https (GitHub Pages) and file://. Cooperative: yields via setTimeout(0)\n * so \'stop\' messages are honored between batches.\n */\nvar __vanityStop = false;\nvar __vanityAccountNode = null;\n\nonmessage = function (e) {\n  var cfg = e.data || {};\n  if (cfg.cmd === "stop") { __vanityStop = true; return; }\n  if (cfg.cmd !== "start") return;\n  __vanityStop = false;\n  __vanityAccountNode = null;\n  var G = PearlVanityGrind;\n  var BATCH = 1024;\n  var attempts = 0;\n  var idx = cfg.startIndex | 0;\n  var stride = cfg.stride | 0 || 1;\n  var t0 = performance.now();\n  var lastPing = 0;\n  var accountNode = null;\n  if (cfg.mode === "bip86") {\n    accountNode = G.bip86AccountNode(G.hexToBytes(cfg.seedHex), G.NETWORKS[cfg.networkId], cfg.account);\n  }\n  function rng(n) {\n    var b = new Uint8Array(n);\n    crypto.getRandomValues(b);\n    return b;\n  }\n  (function loop() {\n    if (__vanityStop) { postMessage({ type: "stopped", attempts: attempts }); return; }\n    var res;\n    try {\n      res = G.grindBatch({\n        prefix: cfg.prefix, networkId: cfg.networkId, mode: cfg.mode,\n        accountNode: accountNode, startIndex: idx, stride: stride,\n        batchSize: BATCH, rng: rng,\n      });\n    } catch (err) {\n      postMessage({ type: "error", message: String((err && err.message) || err) });\n      return;\n    }\n    attempts += res.scanned;\n    idx += res.scanned * stride;\n    if (res.found) { postMessage({ type: "found", result: res.found, attempts: attempts }); return; }\n    if (cfg.maxAttempts && attempts >= cfg.maxAttempts) {\n      postMessage({ type: "capped", attempts: attempts }); return;\n    }\n    var now = performance.now();\n    if (now - lastPing > 250) {\n      lastPing = now;\n      postMessage({ type: "progress", attempts: attempts, rate: attempts / ((now - t0) / 1000) });\n    }\n    setTimeout(loop, 0);\n  })();\n};\n';
  return __toCommonJS(index_exports);
})();
/*! noble-hashes - MIT License (c) 2022 Paul Miller (paulmillr.com) */
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
/*! scure-base - MIT License (c) 2022 Paul Miller (paulmillr.com) */
/*! scure-bip32 - MIT License (c) 2022 Patricio Palladino, Paul Miller (paulmillr.com) */
/*! scure-bip39 - MIT License (c) 2022 Patricio Palladino, Paul Miller (paulmillr.com) */
