/* Pearl Pay SDK v1.0.0 — accept PRL on any website.
 *
 * Dependency-free, dependency-less IIFE: include it with a plain <script> tag,
 * no build step, no bundler. Renders payment buttons + checkout modals and
 * verifies payments against any Blockbook-compatible backend.
 *
 *   <script src="https://kshot3000.github.io/Pearl-Muse-24-7-Ai-builder/pages/pay/pearl-pay.js"></script>
 *   <script>
 *     PearlPay.createButton(document.getElementById('pay'), {
 *       address: 'prl1p…',          // fresh invoice address (derive per order!)
 *       grains: '150000000',        // 1.5 PRL in grains (integer string)
 *       label: 'Order #123',
 *       blockbook: 'https://blockbook.pearlresearch.ai',
 *       expiryMinutes: 60,
 *       requiredConfirmations: 2,
 *       onState: (state, detail) => console.log(state, detail),
 *     });
 *   </script>
 *
 * QR codes are drawn on <canvas> with the SDK's own dependency-free encoder
 * (byte mode, EC level M, versions 1–10), cross-verified module-for-module
 * against the vendored qrcode-generator reference in the test suite.
 *
 * Security notes (read before mainnet use):
 *  - Derive a FRESH address per invoice from your account xpub (BIP-86) — the
 *    toolkit at …/pages/pay/ does this for you. Never reuse one address.
 *  - Only treat goods as paid on "confirmed" with YOUR requiredConfirmations.
 *    "detected" means seen on the network (0-conf): fine for coffee, not cars.
 *  - An xpub is PUBLIC data (anyone can see your addresses) — but it can never
 *    spend. Keep your seed offline regardless.
 */
(function (global) {
  "use strict";

  var GRAIN_PER_PRL = 100_000_000;
  var VERSION = "1.0.0";

  /* ================= QR encoder (byte mode, EC level M) =================
   * Verified against the qrcode-generator reference implementation:
   * same data/EC codewords, same placement, same format info for every
   * test string (see tests/verify-sdk.mjs). Mask choice follows the
   * standard penalty rules; ties may differ from the reference, which is
   * still a perfectly valid code.
   */

  // Galois field GF(256), primitive poly 0x11D
  var GF_EXP = new Array(512), GF_LOG = new Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      GF_EXP[i] = x; GF_LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (var j = 255; j < 512; j++) GF_EXP[j] = GF_EXP[j - 255];
  })();
  function gfMul(a, b) { return (a === 0 || b === 0) ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]]; }

  // Reed–Solomon generator polynomial of given degree (EC codewords per block).
  // Coefficients are highest-degree-first: g(x) = x^deg + g1*x^(deg-1) + ….
  function rsGenerator(degree) {
    var poly = [1];
    for (var i = 0; i < degree; i++) {
      var next = new Array(poly.length + 1).fill(0);
      for (var j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];                 // × x term
        next[j + 1] ^= gfMul(poly[j], GF_EXP[i]); // × α^i term
      }
      poly = next;
    }
    return poly;
  }
  function rsRemainder(data, genPoly) {
    var res = new Array(genPoly.length - 1).fill(0);
    for (var k = 0; k < data.length; k++) {
      var factor = data[k] ^ res[0];
      res.shift();
      res.push(0);
      for (var j = 0; j < res.length; j++) res[j] ^= gfMul(genPoly[j + 1] || 0, factor);
    }
    return res;
  }

  // [totalDataCodewords per block-group, ecCodewordsPerBlock] for EC level M
  var QR_BLOCKS = {
    1:  { ec: 10, groups: [[1, 16]] },
    2:  { ec: 16, groups: [[1, 28]] },
    3:  { ec: 26, groups: [[1, 44]] },
    4:  { ec: 18, groups: [[2, 32]] },
    5:  { ec: 24, groups: [[2, 43]] },
    6:  { ec: 16, groups: [[4, 27]] },
    7:  { ec: 18, groups: [[4, 31]] },
    8:  { ec: 22, groups: [[2, 38], [2, 39]] },
    9:  { ec: 22, groups: [[3, 36], [2, 37]] },
    10: { ec: 26, groups: [[4, 43], [1, 44]] }
  };
  // max byte-mode payload per version (level M)
  var QR_CAP = { 1: 14, 2: 26, 3: 42, 4: 62, 5: 84, 6: 106, 7: 122, 8: 152, 9: 180, 10: 213 };
  var ALIGN_POS = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
    6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50]
  };

  function utf8Bytes(str) {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(str);
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
        var d = str.charCodeAt(++i);
        var cp = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    return out;
  }

  function pickVersion(byteLen) {
    for (var v = 1; v <= 10; v++) if (byteLen <= QR_CAP[v]) return v;
    throw new Error("PearlPay.qr: text too long (max " + QR_CAP[10] + " bytes at EC level M)");
  }

  function encodeDataCodewords(bytes, version) {
    var spec = QR_BLOCKS[version];
    var totalData = 0;
    spec.groups.forEach(function (g) { totalData += g[0] * g[1]; });
    var bits = [];
    function put(val, len) { for (var i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); }
    put(4, 4); // byte mode
    put(bytes.length, version < 10 ? 8 : 16); // char count
    for (var i = 0; i < bytes.length; i++) put(bytes[i], 8);
    var capacity = totalData * 8;
    var term = Math.min(4, capacity - bits.length);
    put(0, term);
    while (bits.length % 8) bits.push(0);
    var cw = [];
    for (var b = 0; b < bits.length; b += 8) {
      var v = 0;
      for (var k = 0; k < 8; k++) v = (v << 1) | bits[b + k];
      cw.push(v);
    }
    var pad = [0xec, 0x11], pi = 0;
    while (cw.length < totalData) cw.push(pad[pi++ % 2]);
    return cw;
  }

  function interleaveBlocks(dataCw, version) {
    var spec = QR_BLOCKS[version];
    var gen = rsGenerator(spec.ec);
    var blocks = []; // [{data:[], ec:[]}]
    var off = 0;
    spec.groups.forEach(function (g) {
      for (var i = 0; i < g[0]; i++) {
        var d = dataCw.slice(off, off + g[1]); off += g[1];
        blocks.push({ data: d, ec: rsRemainder(d, gen) });
      }
    });
    var out = [];
    var maxData = Math.max.apply(null, blocks.map(function (b) { return b.data.length; }));
    for (var i = 0; i < maxData; i++)
      blocks.forEach(function (b) { if (i < b.data.length) out.push(b.data[i]); });
    for (var j = 0; j < spec.ec; j++)
      blocks.forEach(function (b) { out.push(b.ec[j]); });
    return out;
  }

  /* ---- matrix construction ---- */

  function emptyMatrix(size) {
    var m = [], f = [];
    for (var r = 0; r < size; r++) {
      m.push(new Array(size).fill(null));
      f.push(new Array(size).fill(false));
    }
    return { modules: m, func: f, size: size };
  }
  function setFunc(mx, r, c, v) { mx.modules[r][c] = v; mx.func[r][c] = true; }

  function placeFinder(mx, r, c) {
    for (var dr = -1; dr <= 7; dr++) for (var dc = -1; dc <= 7; dc++) {
      var rr = r + dr, cc = c + dc;
      if (rr < 0 || cc < 0 || rr >= mx.size || cc >= mx.size) continue;
      var dark = (dr >= 0 && dr <= 6 && (dc === 0 || dc === 6)) ||
                 (dc >= 0 && dc <= 6 && (dr === 0 || dr === 6)) ||
                 (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4);
      setFunc(mx, rr, cc, (dr === -1 || dr === 7 || dc === -1 || dc === 7) ? false : dark);
    }
  }
  function placeTiming(mx) {
    for (var i = 8; i < mx.size - 8; i++) {
      if (!mx.func[i][6]) setFunc(mx, i, 6, i % 2 === 0);
      if (!mx.func[6][i]) setFunc(mx, 6, i, i % 2 === 0);
    }
  }
  function placeAlignment(mx, version) {
    var pos = ALIGN_POS[version];
    for (var i = 0; i < pos.length; i++) for (var j = 0; j < pos.length; j++) {
      var r = pos[i], c = pos[j];
      if (mx.func[r][c]) continue; // center already a function module (finder/timing) → skip whole pattern
      for (var dr = -2; dr <= 2; dr++) for (var dc = -2; dc <= 2; dc++) {
        if (mx.func[r + dr][c + dc]) continue;
        setFunc(mx, r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
      }
    }
  }
  function bch(bits, poly, deg) { // remainder of bits*2^deg / poly
    var v = bits << deg;
    while (v.toString(2).length - 1 >= poly.toString(2).length - 1) {
      v ^= poly << (v.toString(2).length - poly.toString(2).length);
    }
    return v;
  }
  function placeFormatInfo(mx, mask) {
    // EC level M = 00; 5 data bits = 00mmm; BCH(15,5) poly 10100110111; xor mask 101010000010010
    var data = mask; // 00mmm
    var bits = ((data << 10) | bch(data, 0x537, 10)) ^ 0x5412;
    for (var i = 0; i < 15; i++) {
      var bit = ((bits >> i) & 1) === 1;
      // vertical (col 8)
      if (i < 6) setFunc(mx, i, 8, bit);
      else if (i < 8) setFunc(mx, i + 1, 8, bit);
      else setFunc(mx, mx.size - 15 + i, 8, bit);
      // horizontal (row 8)
      if (i < 8) setFunc(mx, 8, mx.size - i - 1, bit);
      else if (i < 9) setFunc(mx, 8, 15 - i, bit);
      else setFunc(mx, 8, 15 - i - 1, bit);
    }
    setFunc(mx, mx.size - 8, 8, true); // dark module
  }
  function placeVersionInfo(mx, version) {
    if (version < 7) return;
    var bits = (version << 12) | bch(version, 0x1f25, 12);
    for (var i = 0; i < 18; i++) {
      var bit = ((bits >> i) & 1) === 1;
      var r = Math.floor(i / 3), c = i % 3;
      setFunc(mx, mx.size - 11 + c, r, bit);
      setFunc(mx, r, mx.size - 11 + c, bit);
    }
  }
  function placeData(mx, codewords) {
    var bits = [];
    codewords.forEach(function (cw) { for (var i = 7; i >= 0; i--) bits.push((cw >> i) & 1); });
    var size = mx.size, bi = 0, dir = -1;
    for (var col = size - 1; col > 0; col -= 2) {
      if (col === 6) col--; // skip vertical timing
      for (var row = 0; row < size; row++) {
        var r = dir === -1 ? size - 1 - row : row;
        for (var c = 0; c < 2; c++) {
          var cc = col - c;
          if (mx.modules[r][cc] !== null) continue;
          mx.modules[r][cc] = bi < bits.length ? bits[bi++] === 1 : false;
        }
      }
      dir = -dir;
    }
  }
  var MASKS = [
    function (r, c) { return (r + c) % 2 === 0; },
    function (r, c) { return r % 2 === 0; },
    function (r, c) { return c % 3 === 0; },
    function (r, c) { return (r + c) % 3 === 0; },
    function (r, c) { return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0; },
    function (r, c) { return (r * c) % 2 + (r * c) % 3 === 0; },
    function (r, c) { return ((r * c) % 2 + (r * c) % 3) % 2 === 0; },
    function (r, c) { return ((r + c) % 2 + (r * c) % 3) % 2 === 0; }
  ];
  function applyMask(mx, mask) {
    var fn = MASKS[mask], size = mx.size, out = [];
    for (var r = 0; r < size; r++) {
      out.push([]);
      for (var c = 0; c < size; c++)
        out[r].push(mx.func[r][c] ? mx.modules[r][c] : (mx.modules[r][c] !== fn(r, c)));
    }
    return out;
  }
  function penalty(mods) {
    var size = mods.length, score = 0, r, c, k;
    function runPenalty(line) { // N1 + N3
      var s = 0, count = 1, bits = "";
      for (var i = 0; i < line.length; i++) {
        bits += line[i] ? "1" : "0";
        if (i > 0 && line[i] === line[i - 1]) count++;
        else { if (count >= 5) s += 3 + (count - 5); count = 1; }
      }
      if (count >= 5) s += 3 + (count - 5);
      for (var j = 0; j + 10 < bits.length; j++) {
        var p = bits.substr(j, 11);
        if (p === "10111010000" || p === "00001011101") s += 40;
      }
      return s;
    }
    for (r = 0; r < size; r++) score += runPenalty(mods[r]);
    for (c = 0; c < size; c++) { var col = []; for (r = 0; r < size; r++) col.push(mods[r][c]); score += runPenalty(col); }
    for (r = 0; r < size - 1; r++) for (c = 0; c < size - 1; c++) { // N2
      var v = mods[r][c];
      if (mods[r][c + 1] === v && mods[r + 1][c] === v && mods[r + 1][c + 1] === v) score += 3;
    }
    var dark = 0; // N4
    for (r = 0; r < size; r++) for (c = 0; c < size; c++) if (mods[r][c]) dark++;
    var pct = (dark * 100) / (size * size);
    var prev = Math.floor(pct / 5) * 5, next = Math.ceil(pct / 5) * 5;
    score += 10 * Math.min(Math.abs(prev - 50) / 5, Math.abs(next - 50) / 5);
    return score;
  }

  /**
   * Encode text → { size, mask, version, modules } (2-D boolean array).
   * opts.mask (0-7) forces a mask (used by the test suite); otherwise the
   * lowest-penalty mask wins.
   */
  function qrEncode(text, opts) {
    opts = opts || {};
    var bytes = utf8Bytes(text);
    var version = pickVersion(bytes.length);
    var size = version * 4 + 17;
    var codewords = interleaveBlocks(encodeDataCodewords(bytes, version), version);
    // NOTE: function-pattern order mirrors the qrcode-generator reference:
    // finders → alignment → timing (timing yields to alignment) → format info
    // → version info → data (data placement MUST come after the info patterns
    // so it skips those modules) → mask. Verified module-for-module in tests.
    function build(mask) {
      var mx = emptyMatrix(size);
      placeFinder(mx, 0, 0); placeFinder(mx, 0, size - 7); placeFinder(mx, size - 7, 0);
      placeAlignment(mx, version);
      placeTiming(mx);
      placeFormatInfo(mx, mask);
      placeVersionInfo(mx, version);
      placeData(mx, codewords);
      return applyMask(mx, mask);
    }
    var bestMask = opts.mask != null ? opts.mask : 0, bestMods = null, bestScore = Infinity;
    for (var m = 0; m < 8; m++) {
      if (opts.mask != null && m !== opts.mask) continue;
      var mods = build(m);
      var s = penalty(mods);
      if (s < bestScore) { bestScore = s; bestMask = m; bestMods = mods; }
    }
    return { size: size, mask: bestMask, version: version, modules: bestMods };
  }

  function drawQrCanvas(canvas, text, scale) {
    var q = qrEncode(text);
    scale = scale || 6;
    var quiet = 4;
    canvas.width = canvas.height = (q.size + quiet * 2) * scale;
    var ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#000000";
    for (var r = 0; r < q.size; r++) for (var c = 0; c < q.size; c++)
      if (q.modules[r][c]) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
    return q;
  }

  /* ================= money ================= */

  function usdToGrains(usd, rateUsd) {
    var u = Number(usd), r = Number(rateUsd);
    if (!isFinite(u) || u <= 0) throw new Error("usd must be > 0");
    if (!isFinite(r) || r <= 0) throw new Error("rate must be > 0");
    return String(Math.round((u / r) * GRAIN_PER_PRL));
  }
  function formatPRL(grains) {
    var g = BigInt(grains), unit = BigInt(GRAIN_PER_PRL);
    var whole = g / unit, frac = (g % unit).toString().padStart(8, "0").replace(/0+$/, "");
    return frac ? whole.toString() + "." + frac : whole.toString();
  }
  function formatUSD(usd) {
    return Number(usd).toLocaleString("en-US", { style: "currency", currency: "USD" });
  }

  /* ================= payment verification ================= */

  function classifyPayment(o) {
    var req = BigInt(o.requiredGrains), rec = BigInt(o.receivedGrains), conf = BigInt(o.confirmedGrains);
    if (conf >= req) return "confirmed";
    if (Number(o.nowMs) >= Number(o.expiryMs)) return "expired";
    if (rec >= req) return "detected";
    if (rec > 0n) return "partial";
    return "awaiting";
  }
  function summarizeAddress(bb) {
    var totalReceived = BigInt(bb.totalReceived || 0), totalSent = BigInt(bb.totalSent || 0);
    var unconf = 0n;
    try { unconf = BigInt(bb.unconfirmedBalance || 0); } catch (e) { unconf = 0n; }
    if (unconf < 0n) unconf = 0n;
    var received = totalReceived > totalSent ? totalReceived - totalSent : 0n;
    var confirmedReceived = received > unconf ? received - unconf : 0n;
    return { received: received.toString(), confirmedReceived: confirmedReceived.toString(), txCount: Number(bb.txs || 0) };
  }
  function defaultFetch() {
    if (typeof fetch !== "undefined") return fetch;
    throw new Error("PearlPay: no fetch available");
  }
  // Confirmation-aware summary. reqConf<=0: 0-conf counts. reqConf==1: cheap
  // path (received minus unconfirmed). reqConf>1: sums only outputs whose
  // transaction has >= reqConf confirmations (?details=txs).
  function confirmationAwareSummary(blockbook, address, reqConf, fetchFn) {
    if (reqConf <= 1) {
      return fetchFn(blockbook + "/api/v2/address/" + address).then(function (r) {
        if (!r.ok) throw new Error("blockbook " + r.status);
        return r.json();
      }).then(function (j) {
        var s = summarizeAddress(j);
        if (reqConf <= 0) s.confirmedReceived = s.received;
        return s;
      });
    }
    return fetchFn(blockbook + "/api/v2/address/" + address + "?details=txs").then(function (r) {
      if (!r.ok) throw new Error("blockbook " + r.status);
      return r.json();
    }).then(function (j) {
      var s = summarizeAddress(j);
      var deep = 0n, txs = Array.isArray(j.txs) ? j.txs : [];
      txs.forEach(function (tx) {
        var conf = Number(tx && tx.confirmations != null ? tx.confirmations : 0);
        if (!(conf >= reqConf)) return;
        (tx.vout || []).forEach(function (vout) {
          var addrs = (vout && (vout.addresses || (vout.scriptPubKey && vout.scriptPubKey.addresses))) || [];
          if (addrs.indexOf(address) !== -1) {
            try { deep += BigInt(vout.value || 0); } catch (e) {}
          }
        });
      });
      s.confirmedReceived = deep.toString();
      return s;
    });
  }
  function watchPayment(opts) {
    var blockbook = String(opts.blockbook || "").replace(/\/+$/, "");
    var address = opts.address, requiredGrains = String(opts.requiredGrains);
    var expiryMs = Number(opts.expiryMs), reqConf = opts.reqConf != null ? opts.reqConf : 1;
    var intervalMs = opts.intervalMs || 15000, onEvent = opts.onEvent || function () {};
    var fetchFn = opts.fetchFn || defaultFetch();
    var stopped = false, timer = null, lastState = null;
    function stop() { stopped = true; if (timer) clearInterval(timer); }
    function check() {
      if (stopped) return;
      confirmationAwareSummary(blockbook, address, reqConf, fetchFn).then(function (s) {
        if (stopped) return;
        var state = classifyPayment({ nowMs: Date.now(), expiryMs: expiryMs, receivedGrains: s.received, confirmedGrains: s.confirmedReceived, requiredGrains: requiredGrains });
        if (state !== lastState) { lastState = state; onEvent(state, s); }
        if (state === "confirmed" || state === "expired") stop();
      }).catch(function (e) { onEvent("error", { message: String(e && e.message || e), lastState: lastState }); });
    }
    timer = setInterval(check, intervalMs);
    check();
    return stop;
  }

  function invoiceUrl(pageUrl, code) {
    return String(pageUrl).split("?")[0].split("#")[0] + "?inv=" + code;
  }

  /* ================= checkout modal ================= */

  var STATE_COPY = {
    awaiting: ["Awaiting payment", "Send the exact amount to the address below."],
    partial: ["Partial payment detected", "Some funds arrived, but less than the invoice amount."],
    detected: ["Payment detected", "Seen on the network — waiting for confirmations."],
    confirmed: ["Payment confirmed", "Thank you! This invoice is paid."],
    expired: ["Invoice expired", "The payment window closed before funds arrived."],
    error: ["Connection issue", "Could not reach the backend — retrying."]
  };

  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }

  function openCheckout(opts) {
    if (typeof document === "undefined") throw new Error("PearlPay.openCheckout needs a DOM");
    var grains = String(opts.grains);
    if (!/^[1-9][0-9]*$/.test(grains)) throw new Error("grains must be a positive integer string");
    var address = String(opts.address || "");
    if (!address) throw new Error("address is required");
    var label = String(opts.label || "Payment");
    var blockbook = opts.blockbook || "https://blockbook.pearlresearch.ai";
    var expiryMs = opts.expiryMs || (Date.now() + 60 * 60 * 1000);
    var reqConf = opts.requiredConfirmations != null ? opts.requiredConfirmations : 1;
    var onState = opts.onState || function () {};
    var usdNote = opts.usdNote || "";

    var overlay = el("div", "pp-overlay");
    var modal = el("div", "pp-modal");
    overlay.appendChild(modal);

    var head = el("div", "pp-head",
      "<div><div class=\"pp-title\">" + escapeHtml(label) + "</div>" +
      "<div class=\"pp-amount\">" + escapeHtml(formatPRL(grains)) + " PRL" +
      (usdNote ? " <span class=\"pp-usd\">≈ " + escapeHtml(usdNote) + "</span>" : "") + "</div></div>");
    var close = el("button", "pp-close", "✕");
    close.setAttribute("aria-label", "Close");
    close.onclick = function () { stop(); document.body.removeChild(overlay); };
    head.appendChild(close);
    modal.appendChild(head);

    var qrWrap = el("div", "pp-qr");
    var canvas = document.createElement("canvas");
    qrWrap.appendChild(canvas);
    modal.appendChild(qrWrap);
    try { drawQrCanvas(canvas, address, 5); }
    catch (e) { qrWrap.innerHTML = "<div class=\"pp-qr-fallback\">QR unavailable</div>"; }

    var addrRow = el("div", "pp-addr-row");
    var addrCode = el("code", "pp-addr", escapeHtml(address));
    var copyBtn = el("button", "pp-btn pp-small", "Copy");
    copyBtn.onclick = function () {
      copyText(address);
      copyBtn.textContent = "Copied ✓";
      setTimeout(function () { copyBtn.textContent = "Copy"; }, 1500);
    };
    addrRow.appendChild(addrCode); addrRow.appendChild(copyBtn);
    modal.appendChild(addrRow);

    var status = el("div", "pp-status pp-awaiting");
    modal.appendChild(status);
    var countdown = el("div", "pp-countdown");
    modal.appendChild(countdown);
    var note = el("div", "pp-note",
      "Waiting for <strong>" + reqConf + "</strong> confirmation" + (reqConf === 1 ? "" : "s") +
      " before this counts as paid. Do not close this window.");
    modal.appendChild(note);

    function render(state, detail) {
      var c = STATE_COPY[state] || STATE_COPY.error;
      status.className = "pp-status pp-" + state;
      status.innerHTML = "<strong>" + escapeHtml(c[0]) + "</strong><span>" + escapeHtml(c[1]) + "</span>";
      if (state === "confirmed") { note.innerHTML = "Paid. You can close this window."; clearInterval(cdTimer); }
      if (state === "expired") { clearInterval(cdTimer); }
      onState(state, detail || {});
    }
    var stop = watchPayment({
      blockbook: blockbook, address: address, requiredGrains: grains,
      expiryMs: expiryMs, reqConf: reqConf, onEvent: render
    });
    var cdTimer = setInterval(function () {
      var left = Math.max(0, expiryMs - Date.now());
      var m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
      countdown.textContent = "Expires in " + m + ":" + String(s).padStart(2, "0");
      if (left <= 0) clearInterval(cdTimer);
    }, 1000);

    overlay.addEventListener("click", function (e) { if (e.target === overlay) close.onclick(); });
    document.body.appendChild(overlay);
    render("awaiting", {});
    return { close: close.onclick, stop: stop };
  }

  function createButton(elm, opts) {
    var host = typeof elm === "string" ? document.querySelector(elm) : elm;
    if (!host) throw new Error("PearlPay.createButton: element not found");
    var btn = el("button", "pp-pay-btn",
      "<span class=\"pp-pearl\">🐚</span> Pay " + escapeHtml(formatPRL(opts.grains)) + " PRL");
    btn.type = "button";
    btn.onclick = function () { openCheckout(opts); };
    host.appendChild(btn);
    return btn;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function copyText(t) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(t);
    var ta = document.createElement("textarea");
    ta.value = t; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch (e) {}
    document.body.removeChild(ta);
    return Promise.resolve();
  }

  /* ================= export ================= */

  var PearlPay = {
    version: VERSION,
    qrEncode: qrEncode,
    drawQrCanvas: drawQrCanvas,
    usdToGrains: usdToGrains,
    formatPRL: formatPRL,
    formatUSD: formatUSD,
    classifyPayment: classifyPayment,
    summarizeAddress: summarizeAddress,
    watchPayment: watchPayment,
    invoiceUrl: invoiceUrl,
    openCheckout: openCheckout,
    createButton: createButton
  };

  // minimal styles injected once (pages can override with their own CSS)
  var CSS_ID = "pearlpay-sdk-css";
  function injectCss() {
    if (typeof document === "undefined" || document.getElementById(CSS_ID)) return;
    var css = ".pp-overlay{position:fixed;inset:0;background:rgba(6,9,15,.8);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;z-index:9999;padding:1rem;animation:pp-fade .18s ease}" +
      ".pp-modal{background:#0d1420;border:1px solid rgba(148,197,255,.12);border-radius:14px;max-width:400px;width:100%;padding:1.5rem;color:#e8eef7;font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",Inter,Roboto,sans-serif;box-shadow:0 24px 64px rgba(0,0,0,.5),0 0 48px rgba(125,255,212,.06);position:relative;overflow:hidden}" +
      ".pp-modal::before{content:\"\";position:absolute;top:0;left:1.5rem;right:1.5rem;height:2px;border-radius:2px;background:linear-gradient(120deg,#7dffd4,#6fd3ff 55%,#c9a7ff);opacity:.7}" +
      ".pp-head{display:flex;justify-content:space-between;align-items:flex-start;gap:.75rem;margin-bottom:1rem}" +
      ".pp-title{font-weight:700;font-size:.95rem}.pp-amount{font-size:1.5rem;font-weight:800;background:linear-gradient(120deg,#7dffd4,#6fd3ff 55%,#c9a7ff);-webkit-background-clip:text;background-clip:text;color:transparent;margin-top:.25rem}.pp-usd{font-size:.85rem;color:#93a1b8;font-weight:400}" +
      ".pp-close{background:rgba(13,20,32,.6);border:1px solid rgba(148,197,255,.12);color:#93a1b8;border-radius:999px;cursor:pointer;padding:.35rem .65rem;font-size:.8rem;line-height:1;transition:border-color .15s,color .15s}" +
      ".pp-close:hover{border-color:#7dffd4;color:#e8eef7}" +
      ".pp-qr{display:flex;justify-content:center;background:#fff;border-radius:12px;padding:.7rem;margin-bottom:1rem;box-shadow:0 0 32px rgba(125,255,212,.18)}" +
      ".pp-qr canvas{max-width:100%;height:auto;display:block}" +
      ".pp-addr-row{display:flex;gap:.5rem;align-items:center;margin-bottom:1rem}" +
      ".pp-addr{flex:1;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.72rem;word-break:break-all;color:#93a1b8}" +
      ".pp-btn{background:linear-gradient(120deg,#7dffd4,#6fd3ff 55%,#c9a7ff);color:#04121a;border:0;border-radius:999px;padding:.55rem 1.1rem;font-weight:650;cursor:pointer;font-size:.9rem;transition:transform .15s ease,box-shadow .15s ease}" +
      ".pp-btn:hover{transform:translateY(-1px);box-shadow:0 8px 28px rgba(125,255,212,.35)}" +
      ".pp-small{font-size:.8rem;padding:.4rem .85rem}" +
      ".pp-status{border-radius:10px;padding:.7rem .9rem;margin-bottom:.6rem;border:1px solid rgba(148,197,255,.12);background:rgba(10,15,24,.6);transition:border-color .3s}" +
      ".pp-status strong{display:block;font-size:.9rem}.pp-status span{font-size:.82rem;color:#93a1b8}" +
      ".pp-awaiting{border-color:rgba(252,211,77,.45)}.pp-partial{border-color:rgba(252,211,77,.45)}.pp-detected{border-color:rgba(111,211,255,.45)}" +
      ".pp-confirmed{border-color:rgba(125,255,212,.55);background:rgba(125,255,212,.07)}.pp-expired{border-color:rgba(252,165,165,.45)}.pp-error{border-color:rgba(252,165,165,.45)}" +
      ".pp-countdown{font-size:.8rem;color:#93a1b8;margin-bottom:.6rem;font-variant-numeric:tabular-nums}" +
      ".pp-note{font-size:.78rem;color:#93a1b8}" +
      ".pp-pay-btn{background:linear-gradient(120deg,#7dffd4,#6fd3ff 55%,#c9a7ff);border:0;border-radius:999px;padding:.7rem 1.4rem;font-weight:700;cursor:pointer;font-size:1rem;color:#04121a;transition:transform .15s ease,box-shadow .15s ease}" +
      ".pp-pay-btn:hover{transform:translateY(-2px);box-shadow:0 8px 28px rgba(125,255,212,.35)}" +
      "@keyframes pp-fade{from{opacity:0}to{opacity:1}}";
    var st = document.createElement("style");
    st.id = CSS_ID; st.textContent = css;
    document.head.appendChild(st);
  }
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", injectCss);
    else injectCss();
  }

  global.PearlPay = PearlPay;
  return PearlPay;
})(typeof globalThis !== "undefined" ? globalThis : this);
