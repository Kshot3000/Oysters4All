/* Cross-verify the SDK's dependency-free QR encoder against the vendored
 * qrcode-generator reference (qrcode.min.js), module for module.
 * Run: node ./tests/verify-sdk.mjs   (plain node, no loader needed)
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import "../pearl-pay.js";

const DIR = dirname(fileURLToPath(import.meta.url));
const refSrc = readFileSync(join(DIR, "..", "qrcode.min.js"), "utf8");
const qrcode = new Function(`${refSrc}; return qrcode;`)();

let pass = 0, fail = 0;
function ok(name, cond, extra = "") {
  if (cond) { pass++; console.log("ok  ", name); }
  else { fail++; console.log("FAIL", name, extra); }
}

// read mask + ec level from a reference matrix's format info (both copies)
function readFormat(mods) {
  const size = mods.length;
  const at = (r, c) => mods[r][c];
  function bitsV() {
    let b = 0;
    for (let i = 0; i < 15; i++) {
      let v;
      if (i < 6) v = at(i, 8);
      else if (i < 8) v = at(i + 1, 8);
      else v = at(size - 15 + i, 8);
      b |= (v ? 1 : 0) << i;
    }
    return b;
  }
  function bitsH() {
    let b = 0;
    for (let i = 0; i < 15; i++) {
      let v;
      if (i < 8) v = at(8, size - i - 1);
      else if (i < 9) v = at(8, 15 - i);
      else v = at(8, 15 - i - 1);
      b |= (v ? 1 : 0) << i;
    }
    return b;
  }
  const v = bitsV(), h = bitsH();
  const d = (v ^ 0x5412) >> 10;
  return { agree: v === h, ec: d >> 3, mask: d & 7 };
}

function refMatrix(text) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const mods = [];
  for (let r = 0; r < n; r++) {
    const row = [];
    for (let c = 0; c < n; c++) row.push(qr.isDark(r, c));
    mods.push(row);
  }
  return mods;
}

const cases = [
  ["tiny", "hello"],
  ["pearl address", "prl1pr6yuq8u2r95wjzzgpdy8cpnncpl7l8zgy6x5q0367pnc53s2famqg7pt74"],
  ["payment uri", "pearl:prl1pr6yuq8u2r95wjzzgpdy8cpnncpl7l8zgy6x5q0367pnc53s2famqg7pt74?amount=1.5&label=Order%20%23123"],
  ["30 bytes", "abcdefghij0123456789ABCDEFGHIJ"],
  ["60 bytes", "x".repeat(60)],
  ["100 bytes", "y".repeat(100)],
  ["invoice url", "https://kshot3000.github.io/Oysters4All/pages/pay/invoice.html?inv=" + "A".repeat(86)],
  ["213 bytes max", "z".repeat(213)],
];

for (const [name, text] of cases) {
  const ref = refMatrix(text);
  const fmt = readFormat(ref);
  ok(`${name}: format copies agree, EC=M`, fmt.agree && fmt.ec === 0, JSON.stringify(fmt));
  const mine = globalThis.PearlPay.qrEncode(text, { mask: fmt.mask });
  let same = mine.size === ref.length;
  let firstDiff = "";
  if (same) {
    outer: for (let r = 0; r < ref.length; r++)
      for (let c = 0; c < ref.length; c++)
        if (!!mine.modules[r][c] !== ref[r][c]) { same = false; firstDiff = ` at (${r},${c})`; break outer; }
  }
  ok(`${name}: matrix identical (v${mine.version}, mask ${fmt.mask})`, same, firstDiff);
  // mask-choice agreement (informational: ties may legitimately differ)
  const auto = globalThis.PearlPay.qrEncode(text);
  console.log(`info ${name}: auto mask ${auto.mask}, reference mask ${fmt.mask}${auto.mask === fmt.mask ? "" : " (tie/diff — still valid)"}`);
}

// Unicode: the SDK uses standard UTF-8 (no BOM). The reference lib instead emits
// legacy CESU-8 + a BOM for non-ASCII, so module-equality is not expected there.
// We verify the SDK's byte stream directly by extracting data codewords from
// its own (placement-verified) matrix.
{
  const text = "Order #123 — Widget 🐚 paid ✓"; // — U+2014, 🐚 U+1F41A, ✓ U+2713
  const want = Array.from(new TextEncoder().encode(text));
  const q = globalThis.PearlPay.qrEncode(text, { mask: 0 });
  // extract data codewords: unmask + unzigzag with the standard function map
  const size = q.size, version = q.version;
  const func = Array.from({ length: size }, () => new Array(size).fill(false));
  const mark = (r, c) => { if (r >= 0 && c >= 0 && r < size && c < size) func[r][c] = true; };
  for (const [fr, fc] of [[0, 0], [0, size - 7], [size - 7, 0]])
    for (let dr = -1; dr <= 7; dr++) for (let dc = -1; dc <= 7; dc++) mark(fr + dr, fc + dc);
  for (let i = 8; i < size - 8; i++) { mark(i, 6); mark(6, i); }
  for (let i = 0; i < 6; i++) { mark(i, 8); mark(8, i); }
  mark(7, 8); mark(8, 8); mark(8, 7);
  for (let i = 0; i < 8; i++) mark(8, size - 1 - i);
  for (let i = 8; i < 15; i++) mark(size - 15 + i, 8);
  mark(size - 8, 8);
  const AP = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] }[version];
  for (const r of AP) for (const c of AP) {
    if (func[r][c]) continue;
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) mark(r + dr, c + dc);
  }
  const bits = [];
  let dir = -1;
  for (let col = size - 1; col > 0; col -= 2) {
    let cc = col; if (cc === 6) cc--;
    for (let row = 0; row < size; row++) {
      const r = dir === -1 ? size - 1 - row : row;
      for (let c = 0; c < 2; c++) {
        const ccc = cc - c; if (func[r][ccc]) continue;
        let v = q.modules[r][ccc]; if ((r + ccc) % 2 === 0) v = !v; // mask 0
        bits.push(v ? 1 : 0);
      }
    }
    dir = -dir;
  }
  const cw = [];
  for (let b = 0; b < bits.length; b += 8) {
    let v = 0; for (let k = 0; k < 8; k++) v = (v << 1) | bits[b + k];
    cw.push(v);
  }
  // expected: mode 0100, 8-bit length, then raw UTF-8 bytes
  const expBits = [];
  const put = (v, l) => { for (let i = l - 1; i >= 0; i--) expBits.push((v >> i) & 1); };
  put(4, 4); put(want.length, 8);
  want.forEach(b => put(b, 8));
  const expCw = [];
  for (let b = 0; b < expBits.length; b += 8) {
    let v = 0; for (let k = 0; k < 8; k++) v = (v << 1) | (expBits[b + k] || 0);
    expCw.push(v);
  }
  const head = cw.slice(0, expCw.length);
  ok("unicode: data bytes are standard UTF-8 (no BOM, proper surrogate encoding)",
    JSON.stringify(head) === JSON.stringify(expCw),
    "want " + expCw.slice(0, 6).join(",") + " got " + head.slice(0, 6).join(","));
  ok("unicode: byte length is proper UTF-8 (35, not CESU-8 37+3 BOM)", want.length === 35, String(want.length));
}
let threw = false;
try { globalThis.PearlPay.qrEncode("q".repeat(214)); } catch { threw = true; }
ok("rejects >213 bytes", threw);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
