/* Pearl PSBT bundle (window.PearlPSBT) — built with esbuild from src/index.js. Do not edit by hand; run `node build.mjs`. */
(() => {
  var __defProp = Object.defineProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };

  // src/psbt-core.js
  var psbt_core_exports = {};
  __export(psbt_core_exports, {
    GRAIN_PER_PRL: () => GRAIN_PER_PRL,
    G_FALLBACK_LOCKTIME: () => G_FALLBACK_LOCKTIME,
    G_INPUT_COUNT: () => G_INPUT_COUNT,
    G_OUTPUT_COUNT: () => G_OUTPUT_COUNT,
    G_TX_MODIFIABLE: () => G_TX_MODIFIABLE,
    G_TX_VERSION: () => G_TX_VERSION,
    G_UNSIGNED_TX: () => G_UNSIGNED_TX,
    G_XPUB: () => G_XPUB,
    IN_FINAL_SCRIPTSIG: () => IN_FINAL_SCRIPTSIG,
    IN_FINAL_SCRIPTWITNESS: () => IN_FINAL_SCRIPTWITNESS,
    IN_NON_WITNESS_UTXO: () => IN_NON_WITNESS_UTXO,
    IN_PARTIAL_SIG: () => IN_PARTIAL_SIG,
    IN_SIGHASH_TYPE: () => IN_SIGHASH_TYPE,
    IN_TAP_BIP32_DERIVATION: () => IN_TAP_BIP32_DERIVATION,
    IN_TAP_INTERNAL_KEY: () => IN_TAP_INTERNAL_KEY,
    IN_TAP_KEY_SIG: () => IN_TAP_KEY_SIG,
    IN_TAP_LEAF_SCRIPT: () => IN_TAP_LEAF_SCRIPT,
    IN_TAP_MERKLE_ROOT: () => IN_TAP_MERKLE_ROOT,
    IN_TAP_SCRIPT_SIG: () => IN_TAP_SCRIPT_SIG,
    IN_WITNESS_UTXO: () => IN_WITNESS_UTXO,
    NETWORKS: () => NETWORKS,
    OUT_AMOUNT: () => OUT_AMOUNT,
    OUT_SCRIPT: () => OUT_SCRIPT,
    OUT_TAP_BIP32_DERIVATION: () => OUT_TAP_BIP32_DERIVATION,
    OUT_TAP_INTERNAL_KEY: () => OUT_TAP_INTERNAL_KEY,
    OUT_TAP_TREE: () => OUT_TAP_TREE,
    PSBT_MAGIC: () => PSBT_MAGIC,
    SIGHASH: () => SIGHASH,
    SIGHASH_OPTIONS: () => SIGHASH_OPTIONS,
    addressToSpk: () => addressToSpk,
    asmToScript: () => asmToScript,
    base64ToBytes: () => base64ToBytes,
    buildExamplePsbt: () => buildExamplePsbt,
    bytesToBase64: () => bytesToBase64,
    bytesToHex: () => bytesToHex,
    combinePsbts: () => combinePsbts,
    compactUint: () => compactUint,
    controlBlockFor: () => controlBlockFor,
    createPsbt: () => createPsbt,
    describePsbt: () => describePsbt,
    examplePrivkeys: () => examplePrivkeys,
    exampleSpec: () => exampleSpec,
    extractTx: () => extractTx,
    finalizePsbt: () => finalizePsbt,
    finalizePsbtInput: () => finalizePsbtInput,
    grainsToPrl: () => grainsToPrl,
    hexToBytes: () => hexToBytes,
    parseFinalTx: () => parseFinalTx,
    parseGrains: () => parseGrains,
    parseLeafScript: () => parseLeafScript,
    parsePrivKey: () => parsePrivKey,
    parsePsbt: () => parsePsbt,
    parsePsbtBase64: () => parsePsbtBase64,
    parseUnsignedTx: () => parseUnsignedTx,
    prevoutsFromPsbt: () => prevoutsFromPsbt,
    psbtToBase64: () => psbtToBase64,
    schnorr: () => schnorr,
    scriptNum: () => scriptNum,
    scriptPushes: () => scriptPushes,
    scriptToAsm: () => scriptToAsm,
    serializePsbt: () => serializePsbt,
    serializeUnsignedTx: () => serializeUnsignedTx,
    sha256: () => sha2562,
    sighashName: () => sighashName,
    signPsbtInput: () => signPsbtInput,
    tapLeafHash: () => tapLeafHash,
    tapTweak: () => tapTweak,
    taprootSighash: () => taprootSighash,
    txidOfUnsigned: () => txidOfUnsigned,
    u64le: () => u64le2,
    validatePrlAddress: () => validatePrlAddress,
    xonlyToAddress: () => xonlyToAddress
  });

  // ../sign/lib/noble-hashes/crypto.js
  var crypto2 = typeof globalThis === "object" && "crypto" in globalThis ? globalThis.crypto : void 0;

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
    if (crypto2 && typeof crypto2.getRandomValues === "function") {
      return crypto2.getRandomValues(new Uint8Array(bytesLength));
    }
    if (crypto2 && typeof crypto2.randomBytes === "function") {
      return Uint8Array.from(crypto2.randomBytes(bytesLength));
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
    const gcd = b;
    if (gcd !== _1n2)
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
    let S2 = 0;
    while (Q % _2n === _0n2) {
      Q /= _2n;
      S2++;
    }
    let Z = _2n;
    const _Fp = Field(P);
    while (FpLegendre(_Fp, Z) === 1) {
      if (Z++ > 1e3)
        throw new Error("Cannot find square root: probably non-prime P");
    }
    if (S2 === 1)
      return sqrt3mod4;
    let cc = _Fp.pow(Z, Q);
    const Q1div2 = (Q + _1n2) / _2n;
    return function tonelliSlow(Fp, n) {
      if (Fp.is0(n))
        return n;
      if (FpLegendre(Fp, n) !== 1)
        throw new Error("Cannot find square root");
      let M = S2;
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
    const _32n = BigInt(32);
    const _u32_max = BigInt(4294967295);
    const wh = Number(value >> _32n & _u32_max);
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

  // ../sign/lib/noble-hashes/_u64.js
  var U32_MASK64 = /* @__PURE__ */ BigInt(2 ** 32 - 1);

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
  var sha256 = /* @__PURE__ */ createHasher(() => new SHA256());

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
  function calcOffsets(n, window2, wOpts) {
    const { windowSize, mask, maxNumber, shiftBy } = wOpts;
    let wbits = Number(n & mask);
    let nextN = n >> shiftBy;
    if (wbits > windowSize) {
      wbits -= maxNumber;
      nextN += _1n3;
    }
    const offsetStart = window2 * windowSize;
    const offset = offsetStart + Math.abs(wbits) - 1;
    const isZero = wbits === 0;
    const isNeg = wbits < 0;
    const isNegF = window2 % 2 !== 0;
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
      for (let window2 = 0; window2 < windows; window2++) {
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
      for (let window2 = 0; window2 < wo.windows; window2++) {
        const { nextN, offset, isZero, isNeg, isNegF, offsetF } = calcOffsets(n, window2, wo);
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
      for (let window2 = 0; window2 < wo.windows; window2++) {
        if (n === _0n3)
          break;
        const { nextN, offset, isZero, isNeg } = calcOffsets(n, window2, wo);
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
  var genBase58 = /* @__NO_SIDE_EFFECTS__ */ (abc) => /* @__PURE__ */ chain(/* @__PURE__ */ radix(58), /* @__PURE__ */ alphabet(abc), /* @__PURE__ */ join(""));
  var base58 = /* @__PURE__ */ genBase58("123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz");
  var createBase58check = (sha2563) => /* @__PURE__ */ chain(checksum(4, (data) => sha2563(sha2563(data))), base58);

  // ../sign/lib/scure-bip32/index.js
  var Point = secp256k1.ProjectivePoint;
  var base58check = createBase58check(sha256);
  var MASTER_SECRET = utf8ToBytes("Bitcoin seed");

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
  var TAPLEAF_VERSION = 192;
  function tapLeafHash(script) {
    const pre = Uint8Array.from([TAPLEAF_VERSION, ...varint(script.length), ...script]);
    return taggedHash2("TapLeaf", pre);
  }

  // src/psbt-core.js
  function concat(...arrs) {
    let total = 0;
    for (const a of arrs) total += a.length;
    const out = new Uint8Array(total);
    let o = 0;
    for (const a of arrs) {
      out.set(a, o);
      o += a.length;
    }
    return out;
  }
  function le32(n) {
    return Uint8Array.from([n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24 & 255]);
  }
  function u64le2(n) {
    let v = BigInt(n);
    if (v < 0n || v > 0xffffffffffffffffn) throw new Error("u64 out of range");
    const b = new Uint8Array(8);
    for (let i = 0; i < 8; i++) {
      b[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    return b;
  }
  function compactUint(n) {
    const v = BigInt(n);
    if (v < 0n) throw new Error("negative compact uint");
    if (v < 0xfdn) return [Number(v)];
    if (v <= 0xffffn) return [253, Number(v & 0xffn), Number(v >> 8n & 0xffn)];
    if (v <= 0xffffffffn) return [254, ...le32(Number(v))];
    if (v <= 0xffffffffffffffffn) return [255, ...u64le2(v)];
    throw new Error("compact uint too large");
  }
  function bytesToBigInt(b) {
    return BigInt("0x" + bytesToHex(b));
  }
  function eq(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  function bytesToBase64(b) {
    if (typeof Buffer !== "undefined") return Buffer.from(b).toString("base64");
    let s = "";
    for (let i = 0; i < b.length; i += 32768) {
      s += String.fromCharCode.apply(null, b.subarray(i, i + 32768));
    }
    return btoa(s);
  }
  function base64ToBytes(s) {
    const t = String(s).trim().replace(/\s+/g, "");
    if (t.length === 0) throw new Error("empty base64");
    if (t.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(t)) throw new Error("not valid base64");
    if (typeof Buffer !== "undefined") return Uint8Array.from(Buffer.from(t, "base64"));
    const bin = atob(t);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function randomBytes32() {
    const g = typeof globalThis !== "undefined" ? globalThis.crypto : null;
    if (!g || !g.getRandomValues) throw new Error("no secure RNG available");
    const b = new Uint8Array(32);
    g.getRandomValues(b);
    return b;
  }
  var utf8 = (s) => new TextEncoder().encode(s);
  var Reader = class {
    constructor(bytes) {
      this.b = bytes;
      this.o = 0;
    }
    eof() {
      return this.o >= this.b.length;
    }
    bytes(n) {
      if (!Number.isInteger(n) || n < 0) throw new Error("bad read length");
      if (this.o + n > this.b.length) throw new Error("truncated data");
      const s = this.b.slice(this.o, this.o + n);
      this.o += n;
      return s;
    }
    u8() {
      return this.bytes(1)[0];
    }
    u32() {
      const x = this.bytes(4);
      return (x[0] | x[1] << 8 | x[2] << 16) + x[3] * 16777216;
    }
    u64() {
      const x = this.bytes(8);
      let v = 0n;
      for (let i = 7; i >= 0; i--) v = v << 8n | BigInt(x[i]);
      return v;
    }
    varint() {
      const f = this.u8();
      if (f < 253) return BigInt(f);
      if (f === 253) {
        const b = this.bytes(2);
        return BigInt(b[0] | b[1] << 8);
      }
      if (f === 254) {
        const b = this.bytes(4);
        return BigInt(b[0]) | BigInt(b[1]) << 8n | BigInt(b[2]) << 16n | BigInt(b[3]) << 24n;
      }
      return this.u64();
    }
  };
  function parseGrains(str) {
    const t = String(str).trim();
    if (!/^\d+$/.test(t)) throw new Error("amount must be a whole number of grains (no decimals)");
    const v = BigInt(t.replace(/^0+(?=\d)/, ""));
    if (v <= 0n) throw new Error("amount must be > 0 grains");
    if (v > 21000000n * BigInt(GRAIN_PER_PRL)) throw new Error("amount exceeds max PRL supply");
    return v;
  }
  function grainsToPrl(g) {
    const v = BigInt(g);
    if (v < 0n) throw new Error("negative grains");
    const w = v.toString().padStart(9, "0");
    const i = w.slice(0, -8).replace(/^0+(?=\d)/, "") || "0";
    const f = w.slice(-8).replace(/0+$/, "");
    return f ? `${i}.${f}` : i;
  }
  function validatePrlAddress(addr) {
    const d = decodeBech32m(addr, "prl");
    const canon = encodeBech32m("prl", 1, d.program);
    if (canon !== String(addr).trim().toLowerCase()) throw new Error("non-canonical address encoding");
    return d.program;
  }
  var addressToSpk = (addr) => p2trScriptPubKey(validatePrlAddress(addr));
  var xonlyToAddress = (xonly) => encodeBech32m("prl", 1, xonly);
  function tapTweak(internalXOnly, merkleRoot) {
    if (!(internalXOnly instanceof Uint8Array) || internalXOnly.length !== 32)
      throw new Error("internal key must be 32 bytes");
    if (merkleRoot !== null && (!(merkleRoot instanceof Uint8Array) || merkleRoot.length !== 32))
      throw new Error("merkle root must be 32 bytes");
    const t = taggedHash2("TapTweak", merkleRoot ? concat(internalXOnly, merkleRoot) : internalXOnly);
    const P = schnorr.utils.lift_x(bytesToBigInt(internalXOnly));
    const Q = P.add(schnorr.Point.BASE.multiply(bytesToBigInt(t)));
    return { Q: schnorr.utils.pointToBytes(Q), t, parity: Number(Q.toAffine().y & 1n) };
  }
  function controlBlockFor(internalXOnly, merkleRoot) {
    const { parity } = tapTweak(internalXOnly, merkleRoot);
    return Uint8Array.from([192 | parity, ...internalXOnly]);
  }
  function scriptPushes(script) {
    const pushes = [];
    let i = 0;
    while (i < script.length) {
      const op = script[i++];
      let n = -1;
      if (op <= 75) n = op;
      else if (op === 76) {
        n = script[i++];
      } else if (op === 77) {
        n = script[i] | script[i + 1] << 8;
        i += 2;
      } else if (op === 78) {
        n = script[i] | script[i + 1] << 8 | script[i + 2] << 16 | script[i + 3] << 24;
        i += 4;
      } else continue;
      if (n < 0 || i + n > script.length) throw new Error("truncated push in script");
      pushes.push(script.slice(i, i + n));
      i += n;
    }
    return pushes;
  }
  var OPCODES = {
    OP_0: 0,
    OP_FALSE: 0,
    OP_1NEGATE: 79,
    OP_1: 81,
    OP_TRUE: 81,
    OP_2: 82,
    OP_3: 83,
    OP_4: 84,
    OP_5: 85,
    OP_6: 86,
    OP_7: 87,
    OP_8: 88,
    OP_9: 89,
    OP_10: 90,
    OP_11: 91,
    OP_12: 92,
    OP_13: 93,
    OP_14: 94,
    OP_15: 95,
    OP_16: 96,
    OP_DUP: 118,
    OP_EQUAL: 135,
    OP_EQUALVERIFY: 136,
    OP_SHA256: 168,
    OP_HASH160: 169,
    OP_CHECKSIG: 172,
    OP_CHECKSIGVERIFY: 173,
    OP_CHECKSIGADD: 186,
    OP_CHECKLOCKTIMEVERIFY: 177,
    OP_CHECKSEQUENCEVERIFY: 178,
    OP_DROP: 117,
    OP_2DROP: 109,
    OP_SWAP: 124,
    OP_SIZE: 130,
    OP_IF: 99,
    OP_NOTIF: 100,
    OP_ELSE: 103,
    OP_ENDIF: 104,
    OP_RETURN: 106
  };
  var OPCODE_NAMES = {};
  for (const [name, code] of Object.entries(OPCODES)) {
    if (!(code in OPCODE_NAMES)) OPCODE_NAMES[code] = name;
  }
  OPCODE_NAMES[0] = "OP_0";
  OPCODE_NAMES[81] = "OP_1";
  OPCODE_NAMES[172] = "OP_CHECKSIG";
  OPCODE_NAMES[177] = "OP_CHECKLOCKTIMEVERIFY";
  function pushBytes(b) {
    if (b.length === 0) return [0];
    if (b.length <= 75) return [b.length, ...b];
    if (b.length <= 255) return [76, b.length, ...b];
    if (b.length <= 520) return [77, b.length & 255, b.length >> 8 & 255, ...b];
    throw new Error("push exceeds 520 bytes");
  }
  function scriptNum(n) {
    let v = BigInt(n);
    if (v === 0n) return new Uint8Array(0);
    const neg = v < 0n;
    if (neg) v = -v;
    const out = [];
    while (v > 0n) {
      out.push(Number(v & 0xffn));
      v >>= 8n;
    }
    if (out[out.length - 1] & 128) out.push(neg ? 128 : 0);
    else if (neg) out[out.length - 1] |= 128;
    return Uint8Array.from(out);
  }
  function asmToScript(asm) {
    const toks = String(asm).trim().split(/\s+/).filter(Boolean);
    if (!toks.length) throw new Error("empty script");
    const out = [];
    for (const t of toks) {
      if (t.startsWith("<") && t.endsWith(">") && t.length >= 2) {
        const hex = t.slice(1, -1);
        if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex))
          throw new Error(`bad <hex> push: ${t}`);
        out.push(...pushBytes(hexToBytes(hex)));
      } else if (/^\d+$/.test(t)) {
        out.push(...pushBytes(scriptNum(BigInt(t))));
      } else if (t in OPCODES) {
        out.push(OPCODES[t]);
      } else {
        throw new Error(`unknown token: ${t}`);
      }
    }
    return Uint8Array.from(out);
  }
  function parseLeafScript(input) {
    const t = String(input).trim();
    if (!t) throw new Error("leaf script required");
    const isAsm = /[<>\s]/.test(t) || /OP_[A-Z0-9_]+/.test(t) || /[^0-9a-fA-F\s]/.test(t);
    if (!isAsm) {
      const hex = t.replace(/\s+/g, "");
      if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex))
        throw new Error("bad hex leaf script");
      return hexToBytes(hex);
    }
    return asmToScript(t);
  }
  function scriptToAsm(script) {
    const out = [];
    let i = 0;
    while (i < script.length) {
      const op = script[i++];
      if (op <= 75) {
        const data = script.slice(i, i + op);
        if (data.length !== op) throw new Error("truncated push");
        i += op;
        out.push("<" + bytesToHex(data) + ">");
        continue;
      }
      if (op === 76 || op === 77 || op === 78) {
        let n;
        if (op === 76) {
          n = script[i++];
        } else if (op === 77) {
          n = script[i] | script[i + 1] << 8;
          i += 2;
        } else {
          n = script[i] | script[i + 1] << 8 | script[i + 2] << 16 | script[i + 3] << 24;
          i += 4;
        }
        const data = script.slice(i, i + n);
        if (data.length !== n) throw new Error("truncated push");
        i += n;
        out.push("<" + bytesToHex(data) + ">");
        continue;
      }
      const name = OPCODE_NAMES[op];
      out.push(name !== void 0 ? name : "OP_UNKNOWN_0x" + op.toString(16).padStart(2, "0"));
    }
    return out.join(" ");
  }
  function parseUnsignedTx(bytes) {
    const r = new Reader(bytes);
    const version = r.u32();
    const nIn = r.varint();
    if (nIn > 100000n) throw new Error("absurd input count");
    const inputs = [];
    for (let i = 0n; i < nIn; i++) {
      const txidLEb = r.bytes(32);
      const vout = r.u32();
      const scriptLen = r.varint();
      if (scriptLen !== 0n) throw new Error(`input ${i}: unsigned tx must have empty scriptSig`);
      const sequence = r.u32();
      inputs.push({ txid: bytesToHex(Uint8Array.from(txidLEb).reverse()), vout, sequence });
    }
    const nOut = r.varint();
    if (nOut > 100000n) throw new Error("absurd output count");
    const outputs = [];
    for (let i = 0n; i < nOut; i++) {
      const value = r.u64();
      const sl = r.varint();
      if (sl > 10000n) throw new Error(`output ${i}: absurd script length`);
      const script = r.bytes(Number(sl));
      outputs.push({ value, script });
    }
    const locktime = r.u32();
    if (!r.eof()) throw new Error("trailing bytes in unsigned tx");
    return { version, inputs, outputs, locktime };
  }
  function serializeUnsignedTx(tx) {
    const out = [...u32le(tx.version), ...compactUint(tx.inputs.length)];
    for (const inp of tx.inputs) {
      out.push(...txidLE(inp.txid), ...u32le(inp.vout), 0, ...u32le(inp.sequence));
    }
    out.push(...compactUint(tx.outputs.length));
    for (const o of tx.outputs) {
      out.push(...u64le2(o.value), ...compactUint(o.script.length), ...o.script);
    }
    out.push(...u32le(tx.locktime));
    return Uint8Array.from(out);
  }
  function txidOfUnsigned(unsignedTxBytes) {
    return bytesToHex(Uint8Array.from(dblSha(unsignedTxBytes)).reverse());
  }
  var PSBT_MAGIC = Uint8Array.from([112, 115, 98, 116, 255]);
  var G_UNSIGNED_TX = 0;
  var G_XPUB = 1;
  var G_TX_VERSION = 251;
  var G_FALLBACK_LOCKTIME = 252;
  var G_INPUT_COUNT = 253;
  var G_OUTPUT_COUNT = 254;
  var G_TX_MODIFIABLE = 255;
  var IN_NON_WITNESS_UTXO = 0;
  var IN_WITNESS_UTXO = 1;
  var IN_PARTIAL_SIG = 2;
  var IN_SIGHASH_TYPE = 3;
  var IN_FINAL_SCRIPTSIG = 7;
  var IN_FINAL_SCRIPTWITNESS = 8;
  var IN_TAP_KEY_SIG = 19;
  var IN_TAP_SCRIPT_SIG = 20;
  var IN_TAP_LEAF_SCRIPT = 21;
  var IN_TAP_BIP32_DERIVATION = 22;
  var IN_TAP_INTERNAL_KEY = 23;
  var IN_TAP_MERKLE_ROOT = 24;
  var OUT_AMOUNT = 3;
  var OUT_SCRIPT = 4;
  var OUT_TAP_BIP32_DERIVATION = 22;
  var OUT_TAP_INTERNAL_KEY = 23;
  var OUT_TAP_TREE = 24;
  function readMap(r, label) {
    const pairs = [];
    const seen = /* @__PURE__ */ new Set();
    for (; ; ) {
      const klen = r.varint();
      if (klen === 0n) break;
      if (klen > 512n) throw new Error(`${label}: key too long`);
      const key = r.bytes(Number(klen));
      const vlen = r.varint();
      if (vlen > 10000000n) throw new Error(`${label}: value too long`);
      const value = r.bytes(Number(vlen));
      const kh = bytesToHex(key);
      if (seen.has(kh)) throw new Error(`${label}: duplicate key 0x${kh}`);
      seen.add(kh);
      pairs.push({ key, value });
    }
    return pairs;
  }
  function writeMap(pairs) {
    const out = [];
    for (const { key, value } of pairs) {
      out.push(...compactUint(key.length), ...key, ...compactUint(value.length), ...value);
    }
    out.push(0);
    return Uint8Array.from(out);
  }
  var findKey = (pairs, b0, keyLen = 1) => pairs.find((p) => p.key.length === keyLen && p.key[0] === b0);
  var findKeyPrefix = (pairs, b0, keyLen) => pairs.filter((p) => p.key.length === keyLen && p.key[0] === b0);
  function parsePsbt(bytes) {
    const r = new Reader(bytes);
    const magic = r.bytes(5);
    if (!eq(magic, PSBT_MAGIC)) throw new Error("bad magic: not a PSBT (expected 'psbt\\xff')");
    const globalPairs = readMap(r, "global");
    const unsignedTxEntry = findKey(globalPairs, G_UNSIGNED_TX);
    if (!unsignedTxEntry) throw new Error("global map missing PSBT_GLOBAL_UNSIGNED_TX (0x00)");
    const unsignedTxBytes = unsignedTxEntry.value;
    const unsignedTx = parseUnsignedTx(unsignedTxBytes);
    for (const [kt, label, want] of [
      [G_INPUT_COUNT, "input", unsignedTx.inputs.length],
      [G_OUTPUT_COUNT, "output", unsignedTx.outputs.length]
    ]) {
      const e = findKey(globalPairs, kt);
      if (e) {
        const n = new Reader(e.value).varint();
        if (n !== BigInt(want)) throw new Error(`PSBT_GLOBAL_${label.toUpperCase()}_COUNT mismatch (${n} vs ${want})`);
      }
    }
    const inputs = [], outputs = [];
    for (let i = 0; i < unsignedTx.inputs.length; i++) inputs.push(readMap(r, `input ${i}`));
    for (let i = 0; i < unsignedTx.outputs.length; i++) outputs.push(readMap(r, `output ${i}`));
    if (!r.eof()) throw new Error("trailing bytes after output maps");
    return { globalPairs, unsignedTx, unsignedTxBytes, inputs, outputs };
  }
  var parsePsbtBase64 = (b64) => parsePsbt(base64ToBytes(b64));
  function serializePsbt(psbt) {
    return concat(
      PSBT_MAGIC,
      writeMap(psbt.globalPairs),
      ...psbt.inputs.map(writeMap),
      ...psbt.outputs.map(writeMap)
    );
  }
  var psbtToBase64 = (psbt) => bytesToBase64(serializePsbt(psbt));
  function upsertPair(pairs, key, value) {
    const kh = bytesToHex(key);
    const i = pairs.findIndex((p) => bytesToHex(p.key) === kh);
    const e = { key, value };
    if (i >= 0) pairs[i] = e;
    else pairs.push(e);
  }
  function createPsbt({ inputs, outputs, locktime = 0 }) {
    if (!Array.isArray(inputs) || inputs.length === 0) throw new Error("at least one input required");
    if (!Array.isArray(outputs) || outputs.length === 0) throw new Error("at least one output required");
    if (!Number.isInteger(locktime) || locktime < 0 || locktime > 4294967295)
      throw new Error("locktime must be a uint32");
    const txInputs = [], txOutputs = [], inMaps = [], outMaps = [];
    const inputInfo = [];
    let totalIn = 0n, totalOut = 0n;
    inputs.forEach((inp, i) => {
      const label = `input ${i}`;
      if (!/^[0-9a-fA-F]{64}$/.test(inp.txid || "")) throw new Error(`${label}: bad txid (64 hex chars)`);
      const vout = inp.vout;
      if (!Number.isInteger(vout) || vout < 0 || vout > 4294967295) throw new Error(`${label}: bad vout`);
      const amount = BigInt(inp.amount);
      if (amount <= 0n || amount > 0xffffffffffffffffn) throw new Error(`${label}: bad amount`);
      if (!/^[0-9a-fA-F]{64}$/.test(inp.internalKey || "")) throw new Error(`${label}: internal key must be 32-byte x-only hex`);
      const internalKey = hexToBytes(inp.internalKey.toLowerCase());
      let merkleRoot = null, leafScript = null, controlBlock = null, leafHash = null;
      if (inp.mode === "scriptpath") {
        leafScript = parseLeafScript(inp.script);
        if (leafScript.length === 0 || leafScript.length > 1e4) throw new Error(`${label}: bad leaf script length`);
        leafHash = tapLeafHash(leafScript);
        merkleRoot = leafHash;
        controlBlock = controlBlockFor(internalKey, merkleRoot);
      } else if (inp.mode !== "keypath") {
        throw new Error(`${label}: mode must be "keypath" or "scriptpath"`);
      }
      const { Q } = tapTweak(internalKey, merkleRoot);
      const spk = p2trScriptPubKey(Q);
      const witnessUtxo = concat(u64le2(amount), Uint8Array.from(compactUint(spk.length)), spk);
      const pairs = [
        { key: Uint8Array.from([IN_WITNESS_UTXO]), value: witnessUtxo },
        { key: Uint8Array.from([IN_TAP_INTERNAL_KEY]), value: internalKey }
      ];
      if (merkleRoot) {
        pairs.push({ key: Uint8Array.from([IN_TAP_MERKLE_ROOT]), value: merkleRoot });
        pairs.push({ key: concat(Uint8Array.from([IN_TAP_LEAF_SCRIPT]), controlBlock), value: leafScript });
        pairs.push({
          key: concat(Uint8Array.from([IN_TAP_BIP32_DERIVATION]), internalKey),
          value: concat(Uint8Array.from(compactUint(1)), leafHash, new Uint8Array(4), Uint8Array.from(compactUint(0)))
        });
      }
      inMaps.push(pairs);
      txInputs.push({ txid: inp.txid.toLowerCase(), vout, sequence: 4294967295 });
      totalIn += amount;
      inputInfo.push({
        mode: inp.mode,
        internalKeyHex: inp.internalKey.toLowerCase(),
        outputKeyHex: bytesToHex(Q),
        spkHex: bytesToHex(spk),
        leafHashHex: leafHash ? bytesToHex(leafHash) : null,
        leafAsm: leafScript ? scriptToAsm(leafScript) : null
      });
    });
    const outputInfo = [];
    outputs.forEach((o, i) => {
      const label = `output ${i}`;
      let script, amount;
      if (o.opReturn !== void 0) {
        const hex = String(o.opReturn).trim().replace(/\s+/g, "");
        if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new Error(`${label}: bad OP_RETURN hex`);
        const data = hexToBytes(hex);
        if (data.length > 80) throw new Error(`${label}: OP_RETURN data > 80 bytes`);
        amount = BigInt(o.amount || 0);
        if (amount !== 0n) throw new Error(`${label}: OP_RETURN output amount must be 0`);
        script = concat(Uint8Array.from([106]), Uint8Array.from(pushBytes(data)));
        outputInfo.push({ kind: "op_return", dataHex: hex });
      } else {
        const prog = validatePrlAddress(o.address);
        script = p2trScriptPubKey(prog);
        amount = BigInt(o.amount);
        if (amount <= 0n || amount > 0xffffffffffffffffn) throw new Error(`${label}: bad amount`);
        outputInfo.push({ kind: "p2tr", address: String(o.address).trim().toLowerCase() });
      }
      outMaps.push([
        { key: Uint8Array.from([OUT_AMOUNT]), value: u64le2(amount) },
        { key: Uint8Array.from([OUT_SCRIPT]), value: script }
      ]);
      txOutputs.push({ value: amount, script });
      totalOut += amount;
    });
    if (totalOut > totalIn) throw new Error(`outputs (${totalOut}) exceed inputs (${totalIn})`);
    const fee = totalIn - totalOut;
    const unsignedTx = { version: 1, inputs: txInputs, outputs: txOutputs, locktime };
    const unsignedTxBytes = serializeUnsignedTx(unsignedTx);
    const psbt = {
      globalPairs: [
        { key: Uint8Array.from([G_UNSIGNED_TX]), value: unsignedTxBytes },
        { key: Uint8Array.from([G_TX_MODIFIABLE]), value: Uint8Array.from([3]) }
        // inputs+outputs modifiable
      ],
      unsignedTx,
      unsignedTxBytes,
      inputs: inMaps,
      outputs: outMaps
    };
    const base = 10 + 41 * txInputs.length + 43 * txOutputs.length;
    const vsize = Math.ceil((4 * base + 2 + 66 * txInputs.length) / 4);
    return {
      base64: psbtToBase64(psbt),
      fee,
      totalIn,
      totalOut,
      inputCount: txInputs.length,
      outputCount: txOutputs.length,
      vsizeEst: vsize,
      feeRateEst: fee === 0n ? "0" : (Number(fee) / vsize).toFixed(2),
      txidPreview: txidOfUnsigned(unsignedTxBytes),
      inputInfo,
      outputInfo
    };
  }
  var SIGHASH = {
    DEFAULT: 0,
    ALL: 1,
    NONE: 2,
    SINGLE: 3,
    ALL_ANYONECANPAY: 129,
    NONE_ANYONECANPAY: 130,
    SINGLE_ANYONECANPAY: 131
  };
  var SIGHASH_NAMES = {
    0: "DEFAULT",
    1: "ALL",
    2: "NONE",
    3: "SINGLE",
    129: "ALL|ANYONECANPAY",
    130: "NONE|ANYONECANPAY",
    131: "SINGLE|ANYONECANPAY"
  };
  function sighashName(b) {
    const n = SIGHASH_NAMES[b];
    if (n === void 0) throw new Error(`unknown sighash byte 0x${Number(b).toString(16).padStart(2, "0")}`);
    return n;
  }
  var SIGHASH_OPTIONS = [0, 1, 2, 3, 129, 130, 131];
  function taprootSighash({ tx, inputIndex, prevouts, hashType = 0, scriptPath = null }) {
    sighashName(hashType);
    const nIn = tx.inputs.length;
    if (!Number.isInteger(inputIndex) || inputIndex < 0 || inputIndex >= nIn)
      throw new Error("input index out of range");
    if (!Array.isArray(prevouts) || prevouts.length !== nIn)
      throw new Error("prevouts length must match input count");
    const acp = (hashType & 128) !== 0;
    const base = hashType & 31;
    const msg = [];
    const push = (...parts) => {
      for (const p of parts) msg.push(...p);
    };
    push([0, hashType]);
    push(u32le(tx.version), u32le(tx.locktime));
    if (!acp) {
      push(sha2562(concat(...tx.inputs.map((inp) => concat(txidLE(inp.txid), le32(inp.vout))))));
      push(sha2562(concat(...prevouts.map((p) => u64le2(p.amount)))));
      push(sha2562(concat(...prevouts.map((p) => concat(Uint8Array.from(compactUint(p.spk.length)), p.spk)))));
      push(sha2562(concat(...tx.inputs.map((inp) => le32(inp.sequence)))));
    }
    if (base !== 2 && base !== 3) {
      push(sha2562(concat(...tx.outputs.map((o) => concat(u64le2(o.value), Uint8Array.from(compactUint(o.script.length)), o.script)))));
    }
    push([scriptPath ? 2 : 0]);
    if (scriptPath) {
      if (!(scriptPath.leafHash instanceof Uint8Array) || scriptPath.leafHash.length !== 32)
        throw new Error("scriptPath.leafHash must be 32 bytes");
      push(scriptPath.leafHash, [0], u32le(4294967295));
    }
    if (acp) {
      const inp = tx.inputs[inputIndex], p = prevouts[inputIndex];
      push(
        txidLE(inp.txid),
        le32(inp.vout),
        u64le2(p.amount),
        Uint8Array.from(compactUint(p.spk.length)),
        p.spk,
        le32(inp.sequence)
      );
    } else {
      push(u32le(inputIndex));
    }
    if (base === 3) {
      if (inputIndex >= tx.outputs.length)
        throw new Error("SIGHASH_SINGLE: no output at input index");
      const o = tx.outputs[inputIndex];
      push(sha2562(concat(u64le2(o.value), Uint8Array.from(compactUint(o.script.length)), o.script)));
    }
    return taggedHash2("TapSighash", Uint8Array.from(msg));
  }
  function prevoutsFromPsbt(psbt) {
    return psbt.inputs.map((pairs, i) => {
      const w = findKey(pairs, IN_WITNESS_UTXO);
      if (!w) throw new Error(`input ${i}: missing PSBT_IN_WITNESS_UTXO (needed for the BIP-341 sighash)`);
      const r = new Reader(w.value);
      const amount = r.u64();
      const sl = r.varint();
      if (sl > 10000n) throw new Error(`input ${i}: absurd scriptPubKey length`);
      const spk = r.bytes(Number(sl));
      if (!r.eof()) throw new Error(`input ${i}: trailing bytes in witness UTXO`);
      return { amount, spk };
    });
  }
  function parsePrivKey(input) {
    const t = String(input).trim();
    if (/^[0-9a-fA-F]{64}$/.test(t)) return hexToBytes(t.toLowerCase());
    try {
      return walletFromWIF(t, NETWORKS.mainnet).priv;
    } catch {
      throw new Error("private key must be 32-byte hex or mainnet WIF");
    }
  }
  function signPsbtInput({ psbt, inputIndex, privKey, hashType = 0, leafIndex = 0, auxRand = null }) {
    sighashName(hashType);
    if (!(privKey instanceof Uint8Array) || privKey.length !== 32)
      throw new Error("private key must be 32 bytes");
    const tx = psbt.unsignedTx;
    if (!Number.isInteger(inputIndex) || inputIndex < 0 || inputIndex >= tx.inputs.length)
      throw new Error("input index out of range");
    const prevouts = prevoutsFromPsbt(psbt);
    const pairs = psbt.inputs[inputIndex];
    const internalE = findKey(pairs, IN_TAP_INTERNAL_KEY);
    if (!internalE || internalE.value.length !== 32)
      throw new Error(`input ${inputIndex}: missing PSBT_IN_TAP_INTERNAL_KEY`);
    const internalKey = internalE.value;
    const merkleE = findKey(pairs, IN_TAP_MERKLE_ROOT);
    const merkleRoot = merkleE ? merkleE.value : null;
    if (merkleE && merkleE.value.length !== 32)
      throw new Error(`input ${inputIndex}: bad merkle root length`);
    const leafEntries = findKeyPrefix(pairs, IN_TAP_LEAF_SCRIPT, 34).map((p) => ({
      controlBlock: p.key.slice(1),
      script: p.value,
      leafHash: tapLeafHash(p.value)
    }));
    const pubBytes = schnorr.getPublicKey(privKey);
    let mode, sighash, signKey, verifyKey, sigKey, keyNote;
    if (leafEntries.length === 0) {
      mode = "keypath";
      const { Q } = tapTweak(internalKey, merkleRoot);
      const qHex = bytesToHex(Q);
      if (bytesToHex(pubBytes) === qHex) {
        signKey = privKey;
        keyNote = "pasted key is the tweaked keypath key (pubkey == Q)";
      } else {
        const tweaked = tweakPrivKeypath(privKey, internalKey);
        if (bytesToHex(schnorr.getPublicKey(tweaked)) !== qHex) {
          throw new Error(
            `input ${inputIndex}: private key matches neither the tweaked output key Q (${qHex.slice(0, 16)}\u2026) nor the internal key it was derived from \u2014 wrong key or wrong input`
          );
        }
        signKey = tweaked;
        keyNote = "pasted key is the internal key; desk applied the TapTweak";
      }
      verifyKey = Q;
      sighash = taprootSighash({ tx, inputIndex, prevouts, hashType, scriptPath: null });
      sigKey = Uint8Array.from([IN_TAP_KEY_SIG]);
    } else {
      mode = "scriptpath";
      const leaf = leafEntries[leafIndex];
      if (!leaf) throw new Error(`input ${inputIndex}: leaf index out of range`);
      const pushes = scriptPushes(leaf.script);
      if (!pushes.some((p) => p.length === 32 && eq(p, pubBytes))) {
        throw new Error(
          `input ${inputIndex}: this key's x-only pubkey is not a 32-byte push in the chosen leaf script \u2014 it cannot sign this leaf`
        );
      }
      signKey = privKey;
      verifyKey = pubBytes;
      sighash = taprootSighash({ tx, inputIndex, prevouts, hashType, scriptPath: { leafHash: leaf.leafHash } });
      sigKey = concat(Uint8Array.from([IN_TAP_SCRIPT_SIG]), pubBytes, leaf.leafHash);
      keyNote = `signing leaf ${leafIndex} (leaf hash ${bytesToHex(leaf.leafHash).slice(0, 16)}\u2026)`;
    }
    const sig64 = schnorr.sign(sighash, signKey, auxRand || randomBytes32());
    if (!schnorr.verify(sig64, sighash, verifyKey))
      throw new Error("internal error: fresh signature failed re-verification");
    const sig = hashType === 0 ? sig64 : concat(sig64, Uint8Array.from([hashType]));
    upsertPair(pairs, sigKey, sig);
    const declared = findKey(pairs, IN_SIGHASH_TYPE);
    let declaredWarn = null;
    if (declared && declared.value.length === 4) {
      const dv = new Reader(declared.value).u32();
      if (dv !== hashType) declaredWarn = `PSBT declares ${sighashName(dv)} but you signed ${sighashName(hashType)}`;
    }
    return {
      sighashHex: bytesToHex(sighash),
      sigHex: bytesToHex(sig),
      pubkeyHex: bytesToHex(verifyKey),
      mode,
      keyNote,
      declaredWarn,
      leafHashHex: leafEntries.length ? bytesToHex(leafEntries[leafIndex].leafHash) : null
    };
  }
  function combinePsbts(b64a, b64b) {
    const a = parsePsbtBase64(b64a), b = parsePsbtBase64(b64b);
    if (!eq(a.unsignedTxBytes, b.unsignedTxBytes))
      throw new Error("unsigned transactions differ \u2014 refusing to combine PSBTs that spend different txns");
    if (a.inputs.length !== b.inputs.length || a.outputs.length !== b.outputs.length)
      throw new Error("input/output count mismatch between the two PSBTs");
    const mergeMaps = (ma, mb, label) => {
      const out = ma.map((p) => ({ key: p.key, value: p.value }));
      const seen = new Map(out.map((p) => [bytesToHex(p.key), bytesToHex(p.value)]));
      for (const p of mb) {
        const kh = bytesToHex(p.key), vh = bytesToHex(p.value);
        if (seen.has(kh)) {
          if (seen.get(kh) !== vh) throw new Error(`${label}: conflicting values for key 0x${kh}`);
        } else {
          seen.set(kh, vh);
          out.push({ key: p.key, value: p.value });
        }
      }
      return out;
    };
    const psbt = {
      globalPairs: mergeMaps(a.globalPairs, b.globalPairs, "global map"),
      unsignedTx: a.unsignedTx,
      unsignedTxBytes: a.unsignedTxBytes,
      inputs: a.inputs.map((m, i) => mergeMaps(m, b.inputs[i], `input ${i}`)),
      outputs: a.outputs.map((m, i) => mergeMaps(m, b.outputs[i], `output ${i}`))
    };
    return psbtToBase64(psbt);
  }
  function sigHashTypeOf(sig, label) {
    if (sig.length === 64) return 0;
    if (sig.length === 65) {
      sighashName(sig[64]);
      return sig[64];
    }
    throw new Error(`${label}: bad signature length ${sig.length}`);
  }
  function parseWitnessStack(bytes) {
    const r = new Reader(bytes);
    const n = r.varint();
    const stack = [];
    for (let i = 0n; i < n; i++) {
      const l = r.varint();
      stack.push(r.bytes(Number(l)));
    }
    if (!r.eof()) throw new Error("trailing bytes in witness stack");
    return stack;
  }
  function finalizePsbtInput(psbt, i, prevouts) {
    const tx = psbt.unsignedTx;
    if (!prevouts) prevouts = prevoutsFromPsbt(psbt);
    const pairs = psbt.inputs[i];
    const keySigE = findKey(pairs, IN_TAP_KEY_SIG);
    const scriptSigEs = findKeyPrefix(pairs, IN_TAP_SCRIPT_SIG, 65).map((p) => ({
      pubkey: p.key.slice(1, 33),
      leafHash: p.key.slice(33, 65),
      sig: p.value
    }));
    const leafEs = findKeyPrefix(pairs, IN_TAP_LEAF_SCRIPT, 34).map((p) => ({
      controlBlock: p.key.slice(1),
      script: p.value,
      leafHash: tapLeafHash(p.value)
    }));
    const internalE = findKey(pairs, IN_TAP_INTERNAL_KEY);
    const internalKey = internalE ? internalE.value : null;
    const merkleE = findKey(pairs, IN_TAP_MERKLE_ROOT);
    const merkleRoot = merkleE ? merkleE.value : null;
    let witness, desc;
    if (keySigE && scriptSigEs.length === 0) {
      if (!internalKey) throw new Error(`input ${i}: keypath sig without internal key`);
      const { Q } = tapTweak(internalKey, merkleRoot);
      const ht = sigHashTypeOf(keySigE.value, `input ${i} key sig`);
      const sighash = taprootSighash({ tx, inputIndex: i, prevouts, hashType: ht, scriptPath: null });
      if (!schnorr.verify(keySigE.value.slice(0, 64), sighash, Q))
        throw new Error(`input ${i}: keypath signature does not verify \u2014 refusing to finalize`);
      witness = [keySigE.value];
      desc = `keypath \xB7 sig ${sighashName(ht)} verified against Q`;
    } else if (scriptSigEs.length > 0 && !keySigE) {
      const byLeaf = /* @__PURE__ */ new Map();
      for (const s of scriptSigEs) {
        const h = bytesToHex(s.leafHash);
        if (!byLeaf.has(h)) byLeaf.set(h, []);
        byLeaf.get(h).push(s);
      }
      let chosen = null;
      for (const leaf of leafEs) {
        const h = bytesToHex(leaf.leafHash);
        const sigs = byLeaf.get(h);
        if (!sigs || sigs.length === 0) continue;
        let okAll = true;
        for (const s of sigs) {
          const ht = sigHashTypeOf(s.sig, `input ${i} script sig`);
          const sighash = taprootSighash({
            tx,
            inputIndex: i,
            prevouts,
            hashType: ht,
            scriptPath: { leafHash: leaf.leafHash }
          });
          if (!schnorr.verify(s.sig.slice(0, 64), sighash, s.pubkey)) {
            okAll = false;
            break;
          }
        }
        if (okAll) {
          chosen = { leaf, sigs };
          break;
        }
      }
      if (!chosen) throw new Error(`input ${i}: no leaf with fully-verifying script sigs`);
      witness = [...chosen.sigs.map((s) => s.sig), chosen.leaf.script, chosen.leaf.controlBlock];
      desc = `scriptpath \xB7 ${chosen.sigs.length} sig(s) verified, leaf ${bytesToHex(chosen.leaf.leafHash).slice(0, 16)}\u2026`;
    } else if (keySigE && scriptSigEs.length > 0) {
      throw new Error(`input ${i}: has both keypath and scriptpath sigs \u2014 ambiguous, refusing`);
    } else {
      throw new Error(`input ${i}: no signatures present \u2014 sign it first`);
    }
    const witBytes = concat(
      Uint8Array.from(compactUint(witness.length)),
      ...witness.map((w) => concat(Uint8Array.from(compactUint(w.length)), w))
    );
    psbt.inputs[i] = [{ key: Uint8Array.from([IN_FINAL_SCRIPTWITNESS]), value: witBytes }];
    return { ok: true, witnessHex: witness.map(bytesToHex), desc };
  }
  function finalizePsbt(b64) {
    const psbt = parsePsbtBase64(b64);
    const prevouts = prevoutsFromPsbt(psbt);
    const results = psbt.inputs.map((_, i) => finalizePsbtInput(psbt, i, prevouts));
    return { base64: psbtToBase64(psbt), results };
  }
  function serializeWitnessTx(tx, witnesses) {
    const core = serializeUnsignedTx(tx);
    const body = core.slice(4, core.length - 4);
    const wit = concat(...witnesses.map((stack) => concat(
      Uint8Array.from(compactUint(stack.length)),
      ...stack.map((w) => concat(Uint8Array.from(compactUint(w.length)), w))
    )));
    return concat(core.slice(0, 4), Uint8Array.from([0, 1]), body, wit, core.slice(core.length - 4));
  }
  function extractTx(psbtOrB64) {
    const psbt = typeof psbtOrB64 === "string" ? parsePsbtBase64(psbtOrB64) : psbtOrB64;
    const tx = psbt.unsignedTx;
    const witnesses = tx.inputs.map((_, i) => {
      const f = findKey(psbt.inputs[i], IN_FINAL_SCRIPTWITNESS);
      if (!f) throw new Error(`input ${i} is not finalized`);
      return parseWitnessStack(f.value);
    });
    const raw = serializeWitnessTx(tx, witnesses);
    const stripped = serializeUnsignedTx(tx);
    const weight = 3 * stripped.length + raw.length;
    return { hex: bytesToHex(raw), txid: txidOfUnsigned(stripped), vsize: Math.ceil(weight / 4) };
  }
  function parseFinalTx(hex) {
    const bytes = hexToBytes(hex);
    const r = new Reader(bytes);
    const version = r.u32();
    const marker = r.u8(), flag = r.u8();
    if (marker !== 0 || flag !== 1) throw new Error("not a witness tx");
    const nIn = r.varint();
    const inputs = [];
    for (let i = 0n; i < nIn; i++) {
      const txidLEb = r.bytes(32);
      const vout = r.u32();
      const sl = r.varint();
      r.bytes(Number(sl));
      const sequence = r.u32();
      inputs.push({ txid: bytesToHex(Uint8Array.from(txidLEb).reverse()), vout, sequence });
    }
    const nOut = r.varint();
    const outputs = [];
    for (let i = 0n; i < nOut; i++) {
      const value = r.u64();
      const sl = r.varint();
      const script = r.bytes(Number(sl));
      outputs.push({ value, script });
    }
    const witnesses = [];
    for (let i = 0n; i < nIn; i++) {
      const stackLen = r.varint();
      if (stackLen > 100n) throw new Error("absurd witness stack size");
      const stack = [];
      for (let j = 0n; j < stackLen; j++) {
        const l = r.varint();
        if (l > 10000n) throw new Error("absurd witness item size");
        stack.push(r.bytes(Number(l)));
      }
      witnesses.push(stack);
    }
    const locktime = r.u32();
    if (!r.eof()) throw new Error("trailing bytes in final tx");
    return { version, inputs, outputs, witnesses, locktime };
  }
  function describeSpk(script) {
    if (script.length === 34 && script[0] === 81 && script[1] === 32) {
      const prog = script.slice(2);
      return { kind: "p2tr", keyHex: bytesToHex(prog), address: xonlyToAddress(prog) };
    }
    if (script.length >= 1 && script[0] === 106) {
      let dataHex = "";
      try {
        const pushes = scriptPushes(script.slice(1));
        dataHex = pushes.map(bytesToHex).join("");
      } catch {
      }
      return { kind: "op_return", dataHex };
    }
    return { kind: "other", asm: (() => {
      try {
        return scriptToAsm(script);
      } catch {
        return "(undecodable)";
      }
    })() };
  }
  function decodeModifiable(b) {
    if (b.length !== 1) return { raw: bytesToHex(b), note: "must be 1 byte" };
    const v = b[0];
    const flags = [];
    if (v & 1) flags.push("inputs modifiable");
    if (v & 2) flags.push("outputs modifiable");
    if (v & 4) flags.push("sighash_single");
    return { raw: "0x" + v.toString(16).padStart(2, "0"), flags: flags.length ? flags : ["nothing modifiable"] };
  }
  function describePsbt(psbt) {
    const tx = psbt.unsignedTx;
    const issues = [];
    const g = {};
    for (const p of psbt.globalPairs) {
      const k = bytesToHex(p.key);
      if (g[k]) issues.push(`global: duplicate key 0x${k} (rejected at parse \u2014 unreachable)`);
      g[k] = p.value;
    }
    const KNOWN_GLOBAL = /* @__PURE__ */ new Set(["00", "fb", "fc", "fd", "fe", "ff"]);
    const proprietary = psbt.globalPairs.filter((p) => {
      const k = bytesToHex(p.key);
      if (KNOWN_GLOBAL.has(k)) return false;
      if (p.key.length === 79 && p.key[0] === 1) return false;
      return true;
    }).map((p) => "0x" + bytesToHex(p.key));
    const global = {
      txVersion: tx.version,
      locktime: tx.locktime,
      nInputs: tx.inputs.length,
      nOutputs: tx.outputs.length,
      unsignedTxid: txidOfUnsigned(psbt.unsignedTxBytes),
      modifiable: g["ff"] ? decodeModifiable(g["ff"]) : null,
      txVersionProp: g["fb"] ? new Reader(g["fb"]).u32() : null,
      fallbackLocktime: g["fc"] ? new Reader(g["fc"]).u32() : null,
      xpubs: psbt.globalPairs.filter((p) => p.key.length === 79 && p.key[0] === 1).length,
      proprietary
    };
    const inputs = psbt.inputs.map((pairs, i) => {
      const u = tx.inputs[i];
      const w = findKey(pairs, IN_WITNESS_UTXO);
      const nw = findKey(pairs, IN_NON_WITNESS_UTXO);
      let witnessUtxo = null;
      if (w) {
        try {
          const r = new Reader(w.value);
          const amount = r.u64();
          const sl = r.varint();
          const spk = r.bytes(Number(sl));
          witnessUtxo = { amount, spkHex: bytesToHex(spk), desc: describeSpk(spk) };
        } catch (e) {
          issues.push(`input ${i}: bad WITNESS_UTXO (${e.message})`);
        }
      }
      const shE = findKey(pairs, IN_SIGHASH_TYPE);
      let sighash = "not declared (signer may choose; DEFAULT assumed)";
      if (shE) {
        try {
          const v = new Reader(shE.value).u32();
          sighash = `0x${v.toString(16).padStart(8, "0")} = SIGHASH_${sighashName(v & 255)}${v > 255 ? " (upper bytes set \u2014 nonstandard)" : ""}`;
        } catch (e) {
          sighash = `unparseable (${e.message})`;
          issues.push(`input ${i}: bad SIGHASH_TYPE`);
        }
      }
      const internalE = findKey(pairs, IN_TAP_INTERNAL_KEY);
      const internalKeyHex = internalE ? bytesToHex(internalE.value) : null;
      if (internalE && internalE.value.length !== 32) issues.push(`input ${i}: internal key not 32 bytes`);
      const merkleE = findKey(pairs, IN_TAP_MERKLE_ROOT);
      const merkleRootHex = merkleE ? bytesToHex(merkleE.value) : null;
      const leaves = findKeyPrefix(pairs, IN_TAP_LEAF_SCRIPT, 34).map((p) => {
        const cb = p.key.slice(1);
        const leafVersion = cb[0] & 254, parity = cb[0] & 1;
        const cbInternal = bytesToHex(cb.slice(1));
        const script = p.value;
        let leafHashHex = null, asm = null;
        try {
          leafHashHex = bytesToHex(tapLeafHash(script));
          asm = scriptToAsm(script);
        } catch (e) {
          issues.push(`input ${i}: bad leaf script (${e.message})`);
        }
        return {
          leafVersion: "0x" + leafVersion.toString(16).padStart(2, "0"),
          parity,
          cbInternal,
          cbMatchesInternalKey: internalKeyHex ? cbInternal === internalKeyHex : null,
          leafHashHex,
          asm,
          matchesMerkleRoot: merkleRootHex ? leafHashHex === merkleRootHex : null,
          pathBytes: cb.length - 33
        };
      });
      const keySigE = findKey(pairs, IN_TAP_KEY_SIG);
      const keySig = keySigE ? {
        len: keySigE.value.length,
        sighash: (() => {
          try {
            return sighashName(keySigE.value.length === 64 ? 0 : keySigE.value[64]);
          } catch {
            return "UNKNOWN";
          }
        })(),
        hex: bytesToHex(keySigE.value)
      } : null;
      const scriptSigs = findKeyPrefix(pairs, IN_TAP_SCRIPT_SIG, 65).map((p) => ({
        pubkeyHex: bytesToHex(p.key.slice(1, 33)),
        leafHashHex: bytesToHex(p.key.slice(33, 65)),
        len: p.value.length,
        sighash: (() => {
          try {
            return sighashName(p.value.length === 64 ? 0 : p.value[64]);
          } catch {
            return "UNKNOWN";
          }
        })(),
        hex: bytesToHex(p.value),
        leafKnown: leaves.some((l) => l.leafHashHex === bytesToHex(p.key.slice(33, 65)))
      }));
      const derivations = findKeyPrefix(pairs, IN_TAP_BIP32_DERIVATION, 33).map((p) => {
        try {
          const r = new Reader(p.value);
          const nH = r.varint();
          const hashes = [];
          for (let j = 0n; j < nH; j++) hashes.push(bytesToHex(r.bytes(32)));
          const fp = bytesToHex(r.bytes(4));
          const nP = r.varint();
          const path = [];
          for (let j = 0n; j < nP; j++) path.push(r.u32());
          return { xonlyHex: bytesToHex(p.key.slice(1)), leafHashes: hashes, masterFp: fp, path };
        } catch (e) {
          return { xonlyHex: bytesToHex(p.key.slice(1)), error: e.message };
        }
      });
      const finalized = !!findKey(pairs, IN_FINAL_SCRIPTWITNESS);
      return {
        index: i,
        prevout: `${u.txid}:${u.vout}`,
        sequence: "0x" + u.sequence.toString(16).padStart(8, "0"),
        hasWitnessUtxo: !!w,
        hasNonWitnessUtxo: !!nw,
        witnessUtxo,
        sighash,
        internalKeyHex,
        merkleRootHex,
        leaves,
        keySig,
        scriptSigs,
        derivations,
        finalized
      };
    });
    const outputs = psbt.outputs.map((pairs, i) => {
      const aE = findKey(pairs, OUT_AMOUNT);
      const sE = findKey(pairs, OUT_SCRIPT);
      const amount = aE ? new Reader(aE.value).u64() : null;
      const script = sE ? sE.value : null;
      const txo = tx.outputs[i];
      const match = script ? eq(script, txo.script) : null;
      if (match === false) issues.push(`output ${i}: PSBT_OUT_SCRIPT differs from unsigned tx output script`);
      return {
        index: i,
        amount,
        amountPrl: amount !== null ? grainsToPrl(amount) : null,
        scriptHex: script ? bytesToHex(script) : null,
        desc: script ? describeSpk(script) : null,
        matchesUnsignedTx: match
      };
    });
    return { global, inputs, outputs, issues };
  }
  function examplePriv(tag) {
    return sha2562(utf8("psbt-example-" + tag));
  }
  function examplePrivkeys() {
    return {
      keypath: bytesToHex(examplePriv("keypath-internal")),
      scriptpath: bytesToHex(examplePriv("scriptpath-internal")),
      note: "TEST KEYS for the demo PSBT only \u2014 never use for real funds"
    };
  }
  function exampleSpec() {
    const k1 = examplePriv("keypath-internal");
    const k2 = examplePriv("scriptpath-internal");
    const destProg = sha2562(utf8("psbt-example-dest"));
    const leafAsm = `500000 OP_CHECKLOCKTIMEVERIFY OP_DROP <${bytesToHex(schnorr.getPublicKey(k2))}> OP_CHECKSIG`;
    return {
      inputs: [
        {
          txid: bytesToHex(sha2562(utf8("psbt-example-prevout-1"))),
          vout: 0,
          amount: 250000000n,
          mode: "keypath",
          internalKey: bytesToHex(schnorr.getPublicKey(k1))
        },
        {
          txid: bytesToHex(sha2562(utf8("psbt-example-prevout-2"))),
          vout: 1,
          amount: 100000000n,
          mode: "scriptpath",
          internalKey: bytesToHex(schnorr.getPublicKey(k2)),
          script: leafAsm
        }
      ],
      outputs: [
        { address: xonlyToAddress(destProg), amount: 300000000n },
        { opReturn: bytesToHex(utf8("pearl-psbt")), amount: 0n }
      ],
      locktime: 0
    };
  }
  function buildExamplePsbt() {
    return createPsbt(exampleSpec());
  }

  // src/index.js
  var $ = (id) => document.getElementById(id);
  var STORE_KEY = "pearl-psbt-v1";
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[c]);
  }
  function show(el, on) {
    el.classList.toggle("hidden", !on);
  }
  function setErr(id, msg) {
    $(id).textContent = msg || "";
  }
  var S = { psbtBase64: "" };
  function loadState() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) S = { ...S, ...JSON.parse(raw) };
    } catch {
    }
  }
  function saveState() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(S));
    } catch {
    }
  }
  function gotoTab(name) {
    document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    document.querySelectorAll("main .panel").forEach((p) => p.classList.toggle("active", p.id === "tab-" + name));
    const sec = $("tab-" + name);
    if (sec) sec.scrollIntoView({ block: "start" });
  }
  document.querySelectorAll("#tabs button").forEach((b) => b.addEventListener("click", () => gotoTab(b.dataset.tab)));
  document.querySelectorAll("[data-goto]").forEach((a) => a.addEventListener("click", (e) => {
    e.preventDefault();
    gotoTab(a.dataset.goto);
  }));
  async function copyText(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    if (btn) {
      const old = btn.textContent;
      btn.textContent = "copied \u2713";
      setTimeout(() => {
        btn.textContent = old;
      }, 1500);
    }
  }
  function download(name, text, mime) {
    const blob = new Blob([text], { type: mime || "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 4e3);
  }
  function setCurrent(b64) {
    S.psbtBase64 = b64;
    saveState();
  }
  function shortAddr(a) {
    return a.length > 24 ? a.slice(0, 14) + "\u2026" + a.slice(-8) : a;
  }
  function parseCreateInputs(text) {
    const lines = text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    return lines.map((line, li) => {
      const parts = line.split(":");
      if (parts.length < 4) throw new Error(`input line ${li + 1}: want txid:vout:amountGrains:internalKeyHex[:leafAsm]`);
      const [txid, voutS, amountS, internalKey, ...rest] = parts;
      const vout = Number(voutS);
      if (!/^[0-9a-fA-F]{64}$/.test(txid)) throw new Error(`input line ${li + 1}: bad txid`);
      if (!Number.isInteger(vout) || vout < 0 || vout > 4294967295) throw new Error(`input line ${li + 1}: bad vout`);
      const amount = parseGrains(amountS);
      if (!/^[0-9a-fA-F]{64}$/.test(internalKey)) throw new Error(`input line ${li + 1}: internal key must be 32-byte hex`);
      const inp = { txid: txid.toLowerCase(), vout, amount, internalKey: internalKey.toLowerCase() };
      if (rest.length > 0) {
        inp.mode = "scriptpath";
        inp.script = rest.join(":").trim();
        if (!inp.script) throw new Error(`input line ${li + 1}: empty leaf script`);
      } else {
        inp.mode = "keypath";
      }
      return inp;
    });
  }
  function parseCreateOutputs(text) {
    const lines = text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    return lines.map((line, li) => {
      const ci = line.indexOf(":");
      if (ci < 0) throw new Error(`output line ${li + 1}: want address:amountGrains or OP_RETURN:hexdata`);
      const head = line.slice(0, ci).trim(), tail = line.slice(ci + 1).trim();
      if (/^op_return$/i.test(head)) {
        if (!/^[0-9a-fA-F]*$/.test(tail) || tail.length % 2 !== 0)
          throw new Error(`output line ${li + 1}: OP_RETURN data must be even hex`);
        if (tail.length / 2 > 80) throw new Error(`output line ${li + 1}: OP_RETURN data > 80 bytes`);
        return { opReturn: tail.toLowerCase(), amount: 0n };
      }
      const amount = parseGrains(tail);
      validatePrlAddress(head);
      return { address: head, amount };
    });
  }
  function loadDemo() {
    const ex = buildExamplePsbt();
    setCurrent(ex.base64);
    renderCreated(ex);
    return ex.base64;
  }
  function renderCreated(ex) {
    $("c-nin").textContent = ex.inputCount;
    $("c-nout").textContent = ex.outputCount;
    $("c-in").textContent = grainsToPrl(ex.totalIn);
    $("c-out-amt").textContent = grainsToPrl(ex.totalOut);
    $("c-fee").textContent = grainsToPrl(ex.fee);
    $("c-txid").textContent = txidOfUnsigned(parsePsbtBase64(ex.base64).unsignedTxBytes);
    $("c-b64").textContent = ex.base64;
    show($("c-out"), true);
  }
  function buildFromText() {
    setErr("c-err", "");
    try {
      const inputs = parseCreateInputs($("c-inputs").value);
      const outputs = parseCreateOutputs($("c-outputs").value);
      const locktime = Number($("c-locktime").value.trim());
      if (!Number.isInteger(locktime) || locktime < 0 || locktime > 4294967295)
        throw new Error("locktime must be a uint32");
      const sighash = Number($("c-sighash").value);
      const ex = createPsbt({ inputs, outputs, locktime, sighashType: sighash });
      setCurrent(ex.base64);
      renderCreated(ex);
      return ex.base64;
    } catch (e) {
      setErr("c-err", e.message);
      show($("c-out"), false);
      throw e;
    }
  }
  $("c-demo").addEventListener("click", () => {
    setErr("c-err", "");
    try {
      loadDemo();
    } catch (e) {
      setErr("c-err", e.message);
    }
  });
  $("c-build").addEventListener("click", () => {
    try {
      buildFromText();
    } catch {
    }
  });
  $("c-copy").addEventListener("click", (e) => copyText($("c-b64").textContent, e.target));
  $("c-download").addEventListener("click", () => download("unsigned.psbt", $("c-b64").textContent, "application/octet-stream"));
  $("c-to-inspect").addEventListener("click", () => {
    $("i-b64").value = $("c-b64").textContent;
    gotoTab("inspect");
  });
  function kvRow(k, v, wrap) {
    return `<div class="kv"><span>${esc(k)}</span><code class="mono${wrap ? " wrap" : ""}">${esc(v)}</code></div>`;
  }
  function inspectText(b64) {
    setErr("i-err", "");
    const psbt = parsePsbtBase64(b64.trim());
    const d = describePsbt(psbt);
    $("i-global").innerHTML = kvRow("Tx version", String(d.global.txVersion)) + kvRow("Locktime", String(d.global.locktime)) + kvRow("Unsigned txid", d.global.unsignedTxid, true) + kvRow("Inputs / outputs", `${d.global.nInputs} / ${d.global.nOutputs}`) + (d.global.modifiable ? kvRow("Modifiable flags", `${d.global.modifiable.raw} \u2014 ${d.global.modifiable.flags.join(", ")}`) : "") + (d.global.xpubs ? kvRow("XPubs", String(d.global.xpubs)) : "") + (d.global.proprietary.length ? kvRow("Proprietary keys", d.global.proprietary.join(", "), true) : "");
    $("i-inputs").innerHTML = d.inputs.map((inp) => {
      const w = inp.witnessUtxo;
      const leaves = inp.leaves.map((l, j) => `<li class="info">leaf ${j}: hash <code class="mono">${esc(l.leafHashHex || "(bad script)")}</code>` + (l.matchesMerkleRoot === true ? " \u2713 matches merkle root" : l.matchesMerkleRoot === false ? " \u2717 NOT the merkle root" : "") + (l.cbMatchesInternalKey === false ? " \u2717 control block internal key \u2260 declared internal key" : "") + (l.asm ? `<br><code class="mono">${esc(l.asm)}</code>` : "") + `</li>`).join("");
      const sigs = [
        inp.keySig ? `<li class="info">keypath sig: ${inp.keySig.len} bytes \xB7 SIGHASH_${esc(inp.keySig.sighash)}</li>` : "",
        ...inp.scriptSigs.map((s) => `<li class="info">script sig: ${s.len} bytes \xB7 SIGHASH_${esc(s.sighash)} \xB7 pubkey <code class="mono">${esc(s.pubkeyHex.slice(0, 16))}\u2026</code> \xB7 leaf ${s.leafKnown ? "known \u2713" : "<strong>UNKNOWN \u2717</strong>"}</li>`)
      ].join("");
      const derivs = inp.derivations.map((x) => `<li class="info"><code class="mono">${esc(x.xonlyHex.slice(0, 16))}\u2026</code>` + (x.error ? ` \u2014 bad: ${esc(x.error)}` : ` \xB7 fp ${esc(x.masterFp)} \xB7 path m/${x.path.map((n) => n & 2147483648 ? (n & 2147483647) + "'" : String(n)).join("/")}`) + `</li>`).join("");
      return `<div class="card"><h4>Input ${inp.index} ${inp.finalized ? "\xB7 FINALIZED" : ""}</h4>` + kvRow("Prevout", inp.prevout, true) + kvRow("Sequence", inp.sequence) + (w ? kvRow("Witness UTXO", `${grainsToPrl(w.amount)} PRL \u2192 ${w.desc.kind === "p2tr" ? shortAddr(w.desc.address) : w.desc.kind}`) : kvRow("Witness UTXO", inp.hasNonWitnessUtxo ? "(non-witness UTXO only)" : "MISSING \u2014 signer cannot verify amounts!")) + kvRow("Sighash", inp.sighash) + (inp.internalKeyHex ? kvRow("Internal key", inp.internalKeyHex.slice(0, 16) + "\u2026") : "") + (inp.merkleRootHex ? kvRow("Merkle root", inp.merkleRootHex.slice(0, 16) + "\u2026") : "") + (leaves ? `<h4>Tap leaves (${inp.leaves.length})</h4><ul class="checklist">${leaves}</ul>` : "") + (sigs ? `<h4>Partial signatures</h4><ul class="checklist">${sigs}</ul>` : "") + (derivs ? `<h4>BIP-32 derivations</h4><ul class="checklist">${derivs}</ul>` : "") + `</div>`;
    }).join("");
    $("i-outputs").innerHTML = `<div class="tablewrap"><table class="mono"><thead><tr><th>#</th><th>amount (PRL)</th><th>destination</th><th>unsigned-tx match</th></tr></thead><tbody>` + d.outputs.map((o) => {
      const dest = !o.desc ? "\u2014" : o.desc.kind === "p2tr" ? `P2TR <code>${esc(shortAddr(o.desc.address))}</code>` : o.desc.kind === "op_return" ? `OP_RETURN <code>${esc(o.desc.dataHex.slice(0, 40))}${o.desc.dataHex.length > 40 ? "\u2026" : ""}</code>` : `<code>${esc(o.desc.asm.slice(0, 60))}</code>`;
      return `<tr><td>${o.index}</td><td>${o.amountPrl}</td><td>${dest}</td><td>${o.matchesUnsignedTx === false ? "<strong>\u2717 MISMATCH</strong>" : "\u2713"}</td></tr>`;
    }).join("") + `</tbody></table></div>`;
    $("i-issues").innerHTML = d.issues.length === 0 ? `<li class="pass">No issues \u2014 maps parse, counts line up, leaves commit correctly.</li>` : d.issues.map((x) => `<li class="fail">${esc(x)}</li>`).join("");
    show($("i-out"), true);
    return d;
  }
  $("i-parse").addEventListener("click", () => {
    try {
      inspectText($("i-b64").value);
    } catch (e) {
      setErr("i-err", e.message);
      show($("i-out"), false);
    }
  });
  $("i-use-current").addEventListener("click", () => {
    if (!S.psbtBase64) {
      setErr("i-err", "no current PSBT \u2014 create or load one first");
      return;
    }
    $("i-b64").value = S.psbtBase64;
  });
  function wipeKeyField() {
    $("s-key").value = "";
  }
  $("s-wipe").addEventListener("click", wipeKeyField);
  $("s-gen").addEventListener("click", () => {
    const b = new Uint8Array(32);
    crypto.getRandomValues(b);
    $("s-key").value = bytesToHex(b);
    $("s-key").type = "text";
    setErr("s-err", "test key generated \u2014 fund it never, reuse it never");
  });
  function signText(b64, index, sighash, keyText) {
    setErr("s-err", "");
    const psbt = parsePsbtBase64(b64.trim());
    let priv;
    try {
      priv = parsePrivKey(keyText.trim());
    } catch (e) {
      throw new Error("private key: " + e.message);
    }
    let result;
    try {
      result = signPsbtInput({ psbt, inputIndex: index, privKey: priv, hashType: sighash });
    } finally {
      priv.fill(0);
      wipeKeyField();
    }
    const outB64 = psbtToBase64(psbt);
    $("s-mode").textContent = result.mode;
    $("s-keynote").textContent = result.keyNote;
    $("s-sighash-hex").textContent = result.sighashHex;
    $("s-sig").textContent = result.sigHex;
    $("s-verified").textContent = "\u2713 signature re-verified before write";
    $("s-b64out").textContent = outB64;
    show($("s-out"), true);
    return { result, base64: outB64 };
  }
  $("s-sign").addEventListener("click", () => {
    try {
      const idx = Number($("s-index").value.trim());
      if (!Number.isInteger(idx) || idx < 0) throw new Error("input index must be a non-negative integer");
      const r = signText($("s-b64").value, idx, Number($("s-sighash").value), $("s-key").value);
      setErr("s-err", "");
      void r;
    } catch (e) {
      setErr("s-err", e.message);
      show($("s-out"), false);
    }
  });
  $("s-use-current").addEventListener("click", () => {
    if (!S.psbtBase64) {
      setErr("s-err", "no current PSBT \u2014 create or load one first");
      return;
    }
    $("s-b64").value = S.psbtBase64;
  });
  $("s-copy").addEventListener("click", (e) => copyText($("s-b64out").textContent, e.target));
  $("s-make-current").addEventListener("click", () => {
    setCurrent($("s-b64out").textContent);
    setErr("s-err", "signed PSBT is now current");
  });
  function combineText(aB64, bB64) {
    setErr("cb-err", "");
    const merged = combinePsbts(aB64.trim(), bB64.trim());
    const d = describePsbt(parsePsbtBase64(merged));
    $("cb-summary").innerHTML = d.inputs.map((inp) => `<div class="kv"><span>Input ${inp.index}</span><code class="mono">${inp.keySig ? "keypath sig \u2713 " : ""}${inp.scriptSigs.length ? inp.scriptSigs.length + " script sig(s) \u2713 " : ""}${!inp.keySig && !inp.scriptSigs.length ? "unsigned" : ""}</code></div>`).join("");
    $("cb-b64").textContent = merged;
    show($("cb-out"), true);
    return merged;
  }
  $("cb-go").addEventListener("click", () => {
    try {
      combineText($("cb-a").value, $("cb-b").value);
    } catch (e) {
      setErr("cb-err", e.message);
      show($("cb-out"), false);
    }
  });
  $("cb-a-current").addEventListener("click", () => {
    $("cb-a").value = S.psbtBase64 || "";
  });
  $("cb-b-current").addEventListener("click", () => {
    $("cb-b").value = S.psbtBase64 || "";
  });
  $("cb-copy").addEventListener("click", (e) => copyText($("cb-b64").textContent, e.target));
  $("cb-make-current").addEventListener("click", () => {
    setCurrent($("cb-b64").textContent);
    setErr("cb-err", "combined PSBT is now current");
  });
  function finalizeText(b64) {
    setErr("f-err", "");
    const fin = finalizePsbt(b64.trim());
    $("f-report").innerHTML = fin.results.map((r) => `<li class="pass">input finalized \u2014 ${esc(r.desc)}</li>`).join("");
    const ext = extractTx(fin.base64);
    $("f-txid").textContent = ext.txid;
    $("f-vsize").textContent = `${ext.vsize} vbytes`;
    $("f-hex").textContent = ext.hex;
    show($("f-out"), true);
    return { fin, ext };
  }
  $("f-go").addEventListener("click", () => {
    try {
      finalizeText($("f-b64").value);
    } catch (e) {
      setErr("f-err", e.message);
      show($("f-out"), false);
    }
  });
  $("f-use-current").addEventListener("click", () => {
    if (!S.psbtBase64) {
      setErr("f-err", "no current PSBT \u2014 create or load one first");
      return;
    }
    $("f-b64").value = S.psbtBase64;
  });
  $("f-copy").addEventListener("click", (e) => copyText($("f-hex").textContent, e.target));
  $("f-download").addEventListener("click", () => download("final.txhex", $("f-hex").textContent, "text/plain"));
  $("donate-copy").addEventListener("click", (e) => copyText($("donate-addr").textContent.trim(), e.target));
  loadState();
  window.PearlPSBT = {
    core: psbt_core_exports,
    gotoTab,
    getCurrent: () => S.psbtBase64,
    setCurrent,
    loadDemo,
    buildFromText,
    inspectText,
    signText,
    combineText,
    finalizeText,
    wipeKeyField
  };
})();
/*! noble-hashes - MIT License (c) 2022 Paul Miller (paulmillr.com) */
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
/*! scure-base - MIT License (c) 2022 Paul Miller (paulmillr.com) */
/*! scure-bip32 - MIT License (c) 2022 Patricio Palladino, Paul Miller (paulmillr.com) */
/*! scure-bip39 - MIT License (c) 2022 Patricio Palladino, Paul Miller (paulmillr.com) */
