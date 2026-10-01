/* Pearl Paywall snippet crypto — MINIMAL dependency-free primitives for the
 * creator embed snippet (pages/paywall "Snippet" tab).
 *
 * These three functions are the ONLY code that ships inside the copy-paste
 * creator snippet, so each one is FULLY SELF-CONTAINED: no imports, no
 * references to module scope — paywall-core.js inlines them into the snippet
 * text via fn.toString(). Keep them that way.
 *
 * They are NOT new cryptography: they are mechanical minimizations of the
 * audited Sign-core lineage (noble sha256 / bech32m / BIP-340), and the test
 * suite differentially checks every one of them against the audited
 * implementations on randomized inputs plus pinned vectors. The desk itself
 * always uses the audited noble implementations; the snippet path is the
 * clearly-labeled, heavily-tested fallback for third-party pages that cannot
 * load the bundle.
 *
 * Conventions: byte arrays are plain JS Arrays of numbers 0..255 (never
 * Uint8Array) so the snippet has zero platform assumptions beyond ES2020
 * (BigInt).
 */

/** SHA-256 over a plain byte array. Returns a 32-byte plain array. */
export function snipSha256Bytes(data) {
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

/** bech32m decode. Returns {hrp, version, program} (program: plain byte array).
 *  Throws on any malformed input. */
export function snipBech32mDecode(addr) {
  var CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  var GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  var BECH32M_CONST = 0x2bc830a3;
  function polymod(values) {
    var chk = 1;
    for (var p = 0; p < values.length; p++) {
      var top = chk >>> 25;
      chk = ((chk & 0x1ffffff) << 5) ^ values[p];
      for (var i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
    }
    return chk >>> 0;
  }
  function hrpExpand(hrp) {
    var out = [];
    var i;
    for (i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >>> 5);
    out.push(0);
    for (i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
    return out;
  }
  function convertBits(data, fromBits, toBits, pad) {
    var acc = 0, bits = 0, ret = [], i, maxv = (1 << toBits) - 1;
    for (i = 0; i < data.length; i++) {
      acc = (acc << fromBits) | data[i];
      bits += fromBits;
      while (bits >= toBits) { bits -= toBits; ret.push((acc >>> bits) & maxv); }
    }
    if (pad) { if (bits > 0) ret.push((acc << (toBits - bits)) & maxv); }
    else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv)) throw new Error("bad padding");
    return ret;
  }
  var s = String(addr);
  if (s.length < 8 || s.length > 90) throw new Error("bad length");
  var lower = s.toLowerCase(), upper = s.toUpperCase();
  if (s !== lower && s !== upper) throw new Error("mixed case");
  s = lower;
  var pos = s.lastIndexOf("1");
  if (pos < 1 || pos + 7 > s.length) throw new Error("bad separator");
  var hrp = s.slice(0, pos);
  if (!/^[a-z0-9]+$/.test(hrp)) throw new Error("bad hrp");
  var data = [], i, d;
  for (i = pos + 1; i < s.length; i++) {
    d = CHARSET.indexOf(s.charAt(i));
    if (d === -1) throw new Error("bad char");
    data.push(d);
  }
  if (polymod(hrpExpand(hrp).concat(data)) !== BECH32M_CONST) throw new Error("bad checksum");
  var payload = data.slice(0, -6);
  var version = payload[0];
  var program = convertBits(payload.slice(1), 5, 8, false);
  return { hrp: hrp, version: version, program: program };
}

/** BIP-340 Schnorr verify. sig: 64 bytes, msg: 32 bytes, pub: 32 bytes
 *  (plain arrays). H: sha256 over a plain byte array -> 32-byte plain array.
 *  Returns true/false, never throws. */
export function snipSchnorrVerify(sig, msg, pub, H) {
  try {
    var P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2Fn;
    var N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
    var Gx = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798n;
    var Gy = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8n;
    function b2n(b) { var v = 0n, i; for (i = 0; i < b.length; i++) v = (v << 8n) + BigInt(b[i] & 255); return v; }
    function n2b(v, len) { var b = new Array(len), i; for (i = len - 1; i >= 0; i--) { b[i] = Number(v & 255n); v >>= 8n; } return b; }
    function mod(a, m) { var r = a % m; return r < 0n ? r + m : r; }
    function modPow(b, e, m) {
      var r = 1n; b = mod(b, m);
      while (e > 0n) { if (e & 1n) r = mod(r * b, m); b = mod(b * b, m); e >>= 1n; }
      return r;
    }
    function liftX(x) {
      if (x < 0n || x >= P) return null;
      var c = mod(x * x * x + 7n, P);
      var y = modPow(c, (P + 1n) / 4n, P);
      if (mod(y * y, P) !== c) return null;
      return { x: x, y: (y & 1n) ? P - y : y };
    }
    function ptAdd(p, q) {
      if (!p) return q;
      if (!q) return p;
      var lam;
      if (p.x === q.x) {
        if (p.y !== q.y || p.y === 0n) return null;
        lam = mod((3n * p.x * p.x) * modPow(2n * p.y, P - 2n, P), P);
      } else {
        lam = mod((q.y - p.y) * modPow(q.x - p.x, P - 2n, P), P);
      }
      var rx = mod(lam * lam - p.x - q.x, P);
      return { x: rx, y: mod(lam * (p.x - rx) - p.y, P) };
    }
    function ptMul(k, pt) {
      var r = null, a = pt;
      while (k > 0n) { if (k & 1n) r = ptAdd(r, a); a = ptAdd(a, a); k >>= 1n; }
      return r;
    }
    function asciiBytes(str) { var b = [], i; for (i = 0; i < str.length; i++) b.push(str.charCodeAt(i) & 255); return b; }
    function taggedHash(tag, m) {
      var t = H(asciiBytes(tag));
      return H(t.concat(t, m));
    }
    if (!sig || !msg || !pub || sig.length !== 64 || msg.length !== 32 || pub.length !== 32) return false;
    var Pp = liftX(b2n(pub));
    if (!Pp) return false;
    var r = b2n(sig.slice(0, 32)), s = b2n(sig.slice(32, 64));
    if (r >= P || s >= N) return false;
    var e = mod(b2n(taggedHash("BIP0340/challenge", n2b(r, 32).concat(n2b(b2n(pub), 32), msg))), N);
    var R = ptAdd(ptMul(s, { x: Gx, y: Gy }), ptMul(mod(N - e, N), Pp));
    if (!R) return false;
    if (R.y & 1n) return false;
    return R.x === r;
  } catch (err) {
    return false;
  }
}
