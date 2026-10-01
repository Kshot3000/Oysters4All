// Pearl Hush — pure bech32m codec.
// Mirrors the audited sign core (pages/sign/src/crypto.js: same CHARSET,
// polymod, hrpExpand, checksum, convertBits, and the 3-arg encodeBech32m
// with data5 = [version, ...convertBits(program, 8, 5, true)]).
// Extended with decodeBech32mParts() returning raw parts so silent-payment
// addresses (version 0, 66-byte payload, hrp sp/tsp) can be validated by
// the BIP-352 layer instead of the taproot-only decoder.

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

/** Generic bech32m encode: data5 = [version5, ...convertBits(data8, 8, 5, true)]. */
export function encodeBech32mParts(hrp, version5, data8) {
  const data5 = [version5, ...convertBits([...data8], 8, 5, true)];
  return hrp + "1" + data5.concat(checksum(hrp, data5)).map((v) => CHARSET[v]).join("");
}

/** Taproot-only encode (v1, 32-byte program) — same contract as the sign core. */
export function encodeBech32m(hrp, version, program) {
  if (!(program instanceof Uint8Array) || program.length !== 32) throw new Error("program must be 32 bytes");
  if (version !== 1) throw new Error("only witness v1 (taproot) supported");
  return encodeBech32mParts(hrp, version, program);
}

/** Generic bech32m decode: returns { hrp, version, data } where data is the
 *  raw payload bytes (version 5-bit value excluded). Callers enforce
 *  version/length/network. */
export function decodeBech32mParts(addr) {
  if (typeof addr !== "string") throw new Error("address must be a string");
  const raw = addr.trim();
  if (raw !== raw.toLowerCase() && raw !== raw.toUpperCase()) throw new Error("mixed case");
  addr = raw.toLowerCase();
  if (addr.length > 1023) throw new Error("too long");
  const pos = addr.lastIndexOf("1");
  if (pos < 1 || addr.length - pos - 1 < 7) throw new Error("missing separator");
  const hrp = addr.slice(0, pos);
  if (!/^[a-z0-9]+$/.test(hrp)) throw new Error("bad hrp");
  const data5 = [];
  for (const c of addr.slice(pos + 1)) {
    const v = CHARSET.indexOf(c);
    if (v === -1) throw new Error("invalid char");
    data5.push(v);
  }
  if (polymod(hrpExpand(hrp).concat(data5)) !== BECH32M_CONST) throw new Error("bad checksum (not bech32m)");
  const payload = data5.slice(0, -6);
  const version = payload[0];
  const data = Uint8Array.from(convertBits(payload.slice(1), 5, 8, false, true));
  return { hrp, version, data };
}

/** Taproot-only Pearl address decode (v1, 32-byte program). */
export function decodeBech32m(addr, expectHrp = null) {
  const d = decodeBech32mParts(addr);
  if (d.version !== 1) throw new Error("only witness v1 (taproot) supported");
  if (d.data.length !== 32) throw new Error("program must be 32 bytes (v1 taproot)");
  if (expectHrp && d.hrp !== expectHrp) throw new Error(`wrong network: expected ${expectHrp}, got ${d.hrp}`);
  return { hrp: d.hrp, version: d.version, program: d.data };
}

/** Encode a 32-byte x-only key as a Pearl taproot address (bech32m, hrp "prl", v1). */
export function encodePearlTaproot(xonly32) {
  return encodeBech32m("prl", 1, xonly32);
}
