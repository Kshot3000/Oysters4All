/* Pearl Drop bundle (window.PearlDrop) — built with esbuild from src/index.js. Do not edit by hand; run `node build.mjs`. */
(() => {
  // src/logic.js
  function snipSha256Bytes(data) {
    var K = [
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
    ];
    function rotr(x, n) {
      return x >>> n | x << 32 - n | 0;
    }
    var bytes = data.slice();
    var bitLen = bytes.length * 8;
    bytes.push(128);
    while (bytes.length % 64 !== 56) bytes.push(0);
    var hi = Math.floor(bitLen / 4294967296), lo = bitLen >>> 0;
    bytes.push(
      hi >>> 24 & 255,
      hi >>> 16 & 255,
      hi >>> 8 & 255,
      hi & 255,
      lo >>> 24 & 255,
      lo >>> 16 & 255,
      lo >>> 8 & 255,
      lo & 255
    );
    var H = [1779033703, 3144134277, 1013904242, 2773480762, 1359893119, 2600822924, 528734635, 1541459225];
    for (var off = 0; off < bytes.length; off += 64) {
      var w = new Array(64), i;
      for (i = 0; i < 16; i++) {
        w[i] = bytes[off + i * 4] << 24 | bytes[off + i * 4 + 1] << 16 | bytes[off + i * 4 + 2] << 8 | bytes[off + i * 4 + 3] | 0;
      }
      for (i = 16; i < 64; i++) {
        var s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ w[i - 15] >>> 3;
        var s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ w[i - 2] >>> 10;
        w[i] = w[i - 16] + s0 + w[i - 7] + s1 | 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], hh = H[7];
      for (i = 0; i < 64; i++) {
        var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        var ch = e & f ^ ~e & g;
        var t1 = hh + S1 + ch + K[i] + w[i] | 0;
        var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        var maj = a & b ^ a & c ^ b & c;
        var t2 = S0 + maj | 0;
        hh = g;
        g = f;
        f = e;
        e = d + t1 | 0;
        d = c;
        c = b;
        b = a;
        a = t1 + t2 | 0;
      }
      H[0] = H[0] + a | 0;
      H[1] = H[1] + b | 0;
      H[2] = H[2] + c | 0;
      H[3] = H[3] + d | 0;
      H[4] = H[4] + e | 0;
      H[5] = H[5] + f | 0;
      H[6] = H[6] + g | 0;
      H[7] = H[7] + hh | 0;
    }
    var out = [];
    for (i = 0; i < 8; i++) {
      out.push(H[i] >>> 24 & 255, H[i] >>> 16 & 255, H[i] >>> 8 & 255, H[i] & 255);
    }
    return out;
  }
  function sha256(bytes) {
    if (!(bytes instanceof Uint8Array)) throw new Error("sha256 input must be a Uint8Array");
    return Uint8Array.from(snipSha256Bytes(Array.from(bytes)));
  }
  function utf8ToBytes(s) {
    return new TextEncoder().encode(s);
  }
  function bytesToHex(bytes) {
    return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  function hexToBytes(hex) {
    if (typeof hex !== "string" || !/^(?:[0-9a-fA-F]{2})+$/.test(hex))
      throw new Error("bad hex");
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
    return out;
  }
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
  function checksum(hrp, data) {
    const values = hrpExpand(hrp).concat(data, [0, 0, 0, 0, 0, 0]);
    const mod = polymod(values) ^ BECH32M_CONST;
    const out = [];
    for (let i = 0; i < 6; i++) out.push(mod >>> 5 * (5 - i) & 31);
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
    return hrp + "1" + data5.concat(checksum(hrp, data5)).map((v) => CHARSET[v]).join("");
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
  var GRAIN_PER_PRL = 100000000n;
  function prlToGrains(raw) {
    if (typeof raw !== "string") throw new Error("amount must be a string");
    const s = raw.trim();
    const m = /^(\d+)(?:\.(\d{1,8}))?$/.exec(s);
    if (!m) throw new Error(`bad amount "${s}": use up to 8 decimals, no sign, no spaces`);
    const whole = BigInt(m[1]);
    const frac = (m[2] || "").padEnd(8, "0");
    return whole * GRAIN_PER_PRL + BigInt(frac);
  }
  function grainsToPrl(g) {
    if (typeof g !== "bigint" || g < 0n) throw new Error("grains must be a non-negative BigInt");
    const whole = g / GRAIN_PER_PRL;
    const frac = (g % GRAIN_PER_PRL).toString().padStart(8, "0").replace(/0+$/, "");
    return frac ? `${whole}.${frac}` : `${whole}`;
  }
  function validateDropAddress(addr) {
    const d = decodeBech32m(addr, "prl");
    if (d.version !== 1 || d.program.length !== 32)
      throw new Error("address is not a v1 taproot address");
    const canonical = encodeBech32m(d.hrp, 1, d.program);
    if (canonical !== String(addr).trim().toLowerCase())
      throw new Error("address is not in canonical form");
    return canonical;
  }
  var TICK_RE = /^[A-Z0-9]{1,8}$/;
  function composeCampaign({ name, tick, startsAt, endsAt, contact }) {
    if (typeof name !== "string" || !(name = name.trim()) || name.length > 80)
      throw new Error("campaign name must be 1\u201380 characters");
    if (!TICK_RE.test(String(tick || "").trim()))
      throw new Error("token tick must be 1\u20138 uppercase alphanumeric characters");
    const t = String(tick).trim();
    const ts = Date.parse(startsAt);
    const te = Date.parse(endsAt);
    if (!Number.isFinite(ts)) throw new Error("claim window start is not a valid date");
    if (!Number.isFinite(te)) throw new Error("claim window end is not a valid date");
    if (te <= ts) throw new Error("claim window end must be after start");
    const c = contact == null ? "" : String(contact);
    if (c.length > 200) throw new Error("operator contact must be \u2264200 characters");
    const fields = {
      v: 1,
      name,
      tick: t,
      starts_at: new Date(ts).toISOString(),
      ends_at: new Date(te).toISOString(),
      contact: c.trim()
    };
    const json = JSON.stringify(fields);
    return { json, fields };
  }
  var campaignId = (headerJson) => bytesToHex(sha256(utf8ToBytes(headerJson)));
  function transitionStatus(current, action) {
    const moves = {
      open: { draft: "open" },
      close: { open: "closed" },
      reopen: { closed: "open" },
      seal: { closed: "sealed" }
    };
    const next = (moves[action] || {})[current];
    if (!next) throw new Error(`cannot ${action} a campaign in status "${current}"`);
    return next;
  }
  function parseDropCsv(text) {
    const rows = [];
    const invalid = [];
    const lines = String(text || "").split(/\r?\n/);
    let seenHeader = false;
    for (let i = 0; i < lines.length; i++) {
      const lineNo = i + 1;
      const raw = lines[i].trim();
      if (!raw || raw.startsWith("#")) continue;
      if (!seenHeader) {
        seenHeader = true;
        if (/address/i.test(raw)) continue;
      }
      const cells = raw.split(",").map((c) => c.trim());
      if (cells.length < 2 || !cells[0] || !cells[1]) {
        invalid.push({ line: lineNo, raw, reason: "expected address,amount" });
        continue;
      }
      const [addrRaw, amtRaw] = cells;
      let address;
      try {
        address = validateDropAddress(addrRaw);
      } catch (e) {
        invalid.push({ line: lineNo, raw, reason: `bad address: ${e.message}` });
        continue;
      }
      let amountGrains;
      try {
        amountGrains = prlToGrains(amtRaw);
      } catch (e) {
        invalid.push({ line: lineNo, raw, reason: `bad amount: ${e.message}` });
        continue;
      }
      if (amountGrains <= 0n) {
        invalid.push({ line: lineNo, raw, reason: "amount must be > 0" });
        continue;
      }
      rows.push({ line: lineNo, address, amountGrains });
    }
    return { rows, invalid };
  }
  function dedupeRecipients(rows) {
    const seen = /* @__PURE__ */ new Map();
    const recipients = [];
    const duplicates = [];
    for (const row of rows) {
      if (seen.has(row.address)) {
        duplicates.push({ line: row.line, address: row.address, reason: "duplicate address (first-seen kept)" });
        continue;
      }
      seen.set(row.address, recipients.length);
      recipients.push({ index: recipients.length, address: row.address, amountGrains: row.amountGrains });
    }
    return { recipients, duplicates };
  }
  function dropLeafHash(index, address, amountGrains) {
    if (!Number.isInteger(index) || index < 0) throw new Error("leaf index must be a non-negative integer");
    if (typeof amountGrains !== "bigint" || amountGrains < 0n) throw new Error("leaf amount must be a non-negative BigInt");
    return sha256(utf8ToBytes(`drop-v1:${index}:${address}:${amountGrains.toString()}`));
  }
  function cmpBytes(a, b) {
    for (let i = 0; i < 32; i++) {
      if (a[i] !== b[i]) return a[i] - b[i];
    }
    return 0;
  }
  function buildDropTree(leaves) {
    if (!Array.isArray(leaves) || leaves.length === 0) throw new Error("need at least one leaf");
    for (const l of leaves) {
      if (!(l instanceof Uint8Array) || l.length !== 32) throw new Error("each leaf must be 32 bytes");
    }
    const layers = [leaves.map((l) => Uint8Array.from(l))];
    let cur = layers[0];
    let depth = 0;
    while (cur.length > 1) {
      const next = [];
      for (let i = 0; i < cur.length; i += 2) {
        const a = cur[i];
        const b = i + 1 < cur.length ? cur[i + 1] : cur[i];
        const lo = cmpBytes(a, b) <= 0 ? a : b;
        const hi = cmpBytes(a, b) <= 0 ? b : a;
        const both = new Uint8Array(64);
        both.set(lo, 0);
        both.set(hi, 32);
        next.push(sha256(both));
      }
      layers.push(next);
      cur = next;
      depth++;
    }
    return {
      root: layers[layers.length - 1][0],
      rootHex: bytesToHex(layers[layers.length - 1][0]),
      depth,
      leafCount: leaves.length,
      layers
    };
  }
  function dropProof(tree, index) {
    if (!tree || !Array.isArray(tree.layers)) throw new Error("bad tree");
    if (!Number.isInteger(index) || index < 0 || index >= tree.layers[0].length)
      throw new Error("leaf index out of range");
    const proof = [];
    let idx = index;
    for (let level = 0; level < tree.layers.length - 1; level++) {
      const layer = tree.layers[level];
      const isRight = idx % 2 === 1;
      let sibIdx = isRight ? idx - 1 : idx + 1;
      if (sibIdx >= layer.length) sibIdx = layer.length - 1;
      proof.push({
        siblingHex: bytesToHex(layer[sibIdx]),
        siblingOnLeft: isRight
      });
      idx = Math.floor(idx / 2);
    }
    return proof;
  }
  function verifyDropProof(leafHex, proof, rootHex) {
    try {
      let cur = hexToBytes(leafHex);
      for (const step of proof) {
        if (typeof step.siblingHex !== "string") return false;
        const sib = hexToBytes(step.siblingHex);
        const lo = cmpBytes(cur, sib) <= 0 ? cur : sib;
        const hi = cmpBytes(cur, sib) <= 0 ? sib : cur;
        const both = new Uint8Array(64);
        both.set(lo, 0);
        both.set(hi, 32);
        cur = sha256(both);
      }
      return bytesToHex(cur) === String(rootHex).toLowerCase();
    } catch {
      return false;
    }
  }
  function composeSeal({ campaignJson, tick, rootHex, leafCount, totalGrains, sealedAtIso }) {
    if (typeof campaignJson !== "string" || !campaignJson) throw new Error("campaign header is required");
    const id = campaignId(campaignJson);
    const header = JSON.parse(campaignJson);
    if (header.tick !== tick) throw new Error("tick does not match the campaign header");
    if (!/^[0-9a-f]{64}$/.test(rootHex)) throw new Error("merkle root must be 64 hex chars");
    if (!Number.isInteger(leafCount) || leafCount <= 0) throw new Error("leaf count must be positive");
    if (typeof totalGrains !== "bigint" || totalGrains <= 0n) throw new Error("total grains must be positive");
    const sealedAt = sealedAtIso || (/* @__PURE__ */ new Date()).toISOString();
    const fields = {
      v: 1,
      campaign_id: id,
      tick,
      merkle_root: rootHex.toLowerCase(),
      leaf_count: leafCount,
      total_grains: totalGrains.toString(),
      sealed_at: sealedAt,
      campaign: campaignJson
    };
    const json = JSON.stringify(fields);
    return { json, fields, sealId: bytesToHex(sha256(utf8ToBytes(json))) };
  }
  function dropEnvelopeBody(sealJson) {
    return {
      p: "prl-drop",
      op: "seal",
      body: sealJson
    };
  }
  function verifySealPackage(sealJsonText, csvText) {
    const checks = [];
    const fail = (label, detail) => {
      checks.push({ label, detail, ok: false });
      return { ok: false, checks };
    };
    const pass = (label, detail) => checks.push({ label, detail, ok: true });
    let seal;
    try {
      seal = JSON.parse(String(sealJsonText || ""));
    } catch (e) {
      return fail("seal document parses", e.message);
    }
    pass("seal document parses", "valid JSON");
    if (!seal || typeof seal !== "object") return fail("seal shape", "seal must be an object");
    for (const f of ["v", "campaign_id", "tick", "merkle_root", "leaf_count", "total_grains", "sealed_at", "campaign"]) {
      if (seal[f] === void 0) return fail("seal shape", `missing field "${f}"`);
    }
    if (seal.v !== 1) return fail("seal version", "v must be 1");
    pass("seal shape", "all required fields present, v=1");
    let header;
    try {
      header = JSON.parse(seal.campaign);
    } catch {
      return fail("campaign header", "embedded campaign header is not valid JSON");
    }
    const reId = campaignId(seal.campaign);
    if (reId !== seal.campaign_id) return fail("campaign id", `re-derived ${reId} \u2260 sealed ${seal.campaign_id}`);
    pass("campaign id", "SHA-256 over embedded header matches");
    if (header.tick !== seal.tick) return fail("tick", "header tick \u2260 sealed tick");
    pass("tick", `${seal.tick} matches the header`);
    const { rows, invalid } = parseDropCsv(csvText);
    const { recipients, duplicates } = dedupeRecipients(rows);
    if (recipients.length === 0) return fail("recipient list", "no valid recipient rows after parsing");
    pass("recipient list", `${recipients.length} unique recipients (${invalid.length} invalid rows, ${duplicates.length} duplicates skipped)`);
    const leaves = recipients.map((r) => dropLeafHash(r.index, r.address, r.amountGrains));
    const tree = buildDropTree(leaves);
    if (tree.rootHex !== seal.merkle_root) return fail("merkle root", `rebuilt ${tree.rootHex} \u2260 sealed ${seal.merkle_root}`);
    pass("merkle root", `rebuild matches (${tree.leafCount} leaves, depth ${tree.depth})`);
    if (tree.leafCount !== seal.leaf_count) return fail("leaf count", `${tree.leafCount} \u2260 ${seal.leaf_count}`);
    pass("leaf count", `${seal.leaf_count}`);
    const total = recipients.reduce((a, r) => a + r.amountGrains, 0n);
    if (total.toString() !== String(seal.total_grains)) return fail("total grains", `${total} \u2260 ${seal.total_grains}`);
    pass("total grains", `${total} grains = ${grainsToPrl(total)} PRL`);
    return { ok: true, checks, seal, recipients, tree };
  }
  function claimForAddress(sealJsonText, csvText, addressRaw) {
    const checks = [];
    const fail = (label, detail) => {
      checks.push({ label, detail, ok: false });
      return { ok: false, valid: false, checks };
    };
    let canonical;
    try {
      canonical = validateDropAddress(addressRaw);
    } catch (e) {
      return fail("address valid", e.message);
    }
    checks.push({ label: "address valid", detail: "bech32m v1 taproot, canonical", ok: true });
    const v = verifySealPackage(sealJsonText, csvText);
    for (const c of v.checks) checks.push(c);
    if (!v.ok) return { ok: false, valid: false, checks };
    const rec = v.recipients.find((r) => r.address === canonical);
    if (!rec) {
      checks.push({ label: "allocation found", detail: "address is not in this campaign", ok: false });
      return { ok: false, valid: false, checks };
    }
    const leafHex = bytesToHex(dropLeafHash(rec.index, rec.address, rec.amountGrains));
    const proof = dropProof(v.tree, rec.index);
    const recomputed = verifyDropProof(leafHex, proof, v.seal.merkle_root);
    checks.push({
      label: "proof recomputes to root",
      detail: recomputed ? `${proof.length} proof steps verify against the sealed root` : "PROOF FAILED \u2014 does not recompute to the sealed root",
      ok: recomputed
    });
    if (!recomputed) return { ok: false, valid: false, checks };
    return {
      ok: true,
      valid: true,
      checks,
      address: canonical,
      index: rec.index,
      amountGrains: rec.amountGrains,
      amountPrl: grainsToPrl(rec.amountGrains),
      leafHex,
      proof,
      rootHex: v.seal.merkle_root,
      tick: v.seal.tick
    };
  }
  var fingerprint = (idHex) => `${idHex.slice(0, 4)}-${idHex.slice(4, 8)}-${idHex.slice(8, 12)}-${idHex.slice(12, 16)}`;

  // src/index.js
  var $ = (id) => document.getElementById(id);
  var STORE_KEY = "pearl-drop-v1";
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
  var S = {
    campaign: { name: "", tick: "", start: "2026-10-01", end: "2026-10-31", contact: "" },
    status: "draft",
    csv: "",
    campaignJson: null,
    locked: false,
    treeMeta: null,
    sealJson: null
  };
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
  var MEM = { parsed: null, deduped: null, tree: null, claim: null };
  function rebuildMemory() {
    const parsed = parseDropCsv(S.csv);
    const deduped = dedupeRecipients(parsed.rows);
    let tree = null;
    if (deduped.recipients.length > 0) {
      const leaves = deduped.recipients.map((r) => dropLeafHash(r.index, r.address, r.amountGrains));
      tree = buildDropTree(leaves);
    }
    MEM = { parsed, deduped, tree, claim: null };
    return MEM;
  }
  function sampleProgram(seed) {
    return Uint8Array.from({ length: 32 }, (_, i) => seed + i * 37 & 255);
  }
  function sampleCsv() {
    const rows = [
      [11, "1.5"],
      [22, "0.25"],
      [33, "2.00000001"],
      [44, "10"]
    ];
    return "address,amount\n" + rows.map(([seed, amt]) => `${encodeBech32m("prl", 1, sampleProgram(seed))},${amt}`).join("\n") + "\n";
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
    const blob = new Blob([text], { type: mime || "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 500);
  }
  function fillCampaignForm() {
    $("c-name").value = S.campaign.name;
    $("c-tick").value = S.campaign.tick;
    $("c-start").value = S.campaign.start;
    $("c-end").value = S.campaign.end;
    $("c-contact").value = S.campaign.contact;
  }
  function renderStatus() {
    const b = $("c-status");
    b.textContent = S.status;
    b.className = "status-badge st-" + S.status;
  }
  $("c-compose").addEventListener("click", () => {
    setErr("c-err", "");
    if (S.locked) {
      setErr("c-err", "Campaign is sealed into the tree \u2014 reset the tree to edit.");
      return;
    }
    try {
      const { json } = composeCampaign({
        name: $("c-name").value,
        tick: $("c-tick").value,
        startsAt: $("c-start").value,
        endsAt: $("c-end").value,
        contact: $("c-contact").value
      });
      S.campaign = {
        name: $("c-name").value.trim(),
        tick: $("c-tick").value.trim().toUpperCase(),
        start: $("c-start").value,
        end: $("c-end").value,
        contact: $("c-contact").value.trim()
      };
      S.campaignJson = json;
      saveState();
      $("c-json").textContent = JSON.stringify(JSON.parse(json), null, 2);
      $("c-id").textContent = campaignId(json);
      $("c-fp").textContent = fingerprint(campaignId(json));
      show($("c-out"), true);
    } catch (e) {
      setErr("c-err", e.message);
    }
  });
  $("c-copy").addEventListener("click", (e) => copyText(S.campaignJson || "", e.target));
  for (const [btn, action] of [["c-open", "open"], ["c-close", "close"], ["c-reopen", "reopen"]]) {
    $(btn).addEventListener("click", () => {
      setErr("c-status-err", "");
      try {
        S.status = transitionStatus(S.status, action);
        saveState();
        renderStatus();
      } catch (e) {
        setErr("c-status-err", e.message);
      }
    });
  }
  function renderRecipients() {
    const { parsed, deduped } = MEM;
    if (!parsed) {
      show($("r-out"), false);
      return;
    }
    show($("r-out"), true);
    const total = deduped.recipients.reduce((a, r) => a + r.amountGrains, 0n);
    $("r-count").textContent = deduped.recipients.length;
    $("r-total").textContent = grainsToPrl(total);
    $("r-invalid-n").textContent = parsed.invalid.length;
    $("r-dup-n").textContent = deduped.duplicates.length;
    const tb = $("r-table").querySelector("tbody");
    tb.innerHTML = deduped.recipients.map(
      (r) => `<tr><td>${r.index}</td><td>${esc(r.address)}</td><td>${esc(grainsToPrl(r.amountGrains))}</td><td>${r.amountGrains}</td></tr>`
    ).join("");
    $("r-invalid").innerHTML = parsed.invalid.length ? parsed.invalid.map((x) => `<li class="bad"><span class="mono">line ${x.line}</span> \u2014 ${esc(x.reason)}<br><code class="mono dim">${esc(x.raw)}</code></li>`).join("") : `<li class="good">none \u2014 every row parsed clean</li>`;
    $("r-dups").innerHTML = deduped.duplicates.length ? deduped.duplicates.map((x) => `<li class="warn"><span class="mono">line ${x.line}</span> \u2014 ${esc(x.address)} (${esc(x.reason)})</li>`).join("") : `<li class="good">none</li>`;
  }
  function renderLock() {
    show($("r-locked"), S.locked);
    $("r-csv").disabled = S.locked;
    $("r-parse").disabled = S.locked;
    $("r-sample").disabled = S.locked;
    ["c-name", "c-tick", "c-start", "c-end", "c-contact", "c-compose"].forEach((id) => {
      $(id).disabled = S.locked;
    });
  }
  $("r-sample").addEventListener("click", () => {
    $("r-csv").value = sampleCsv();
  });
  $("r-parse").addEventListener("click", () => {
    setErr("r-err", "");
    try {
      S.csv = $("r-csv").value;
      saveState();
      rebuildMemory();
      renderRecipients();
      if (MEM.deduped.recipients.length === 0) setErr("r-err", "No valid recipient rows \u2014 check the invalid list below.");
    } catch (e) {
      setErr("r-err", e.message);
    }
  });
  $("r-unlock").addEventListener("click", () => {
    S.locked = false;
    S.treeMeta = null;
    S.sealJson = null;
    saveState();
    renderLock();
    show($("m-out"), false);
    show($("s-out"), false);
  });
  $("m-compute").addEventListener("click", () => {
    setErr("m-err", "");
    try {
      if (!S.campaignJson) throw new Error("Compose the campaign header first (Campaign tab).");
      if (S.status === "draft" || S.status === "open")
        throw new Error('Close the campaign first (Campaign tab \u2192 "close campaign") \u2014 open campaigns cannot be rooted.');
      if (MEM.deduped.recipients.length === 0) {
        rebuildMemory();
        if (MEM.deduped.recipients.length === 0) throw new Error("No valid recipients \u2014 parse the CSV in the Recipients tab first.");
      }
      const total = MEM.deduped.recipients.reduce((a, r) => a + r.amountGrains, 0n);
      S.locked = true;
      S.treeMeta = {
        rootHex: MEM.tree.rootHex,
        depth: MEM.tree.depth,
        leafCount: MEM.tree.leafCount,
        totalGrains: total.toString()
      };
      saveState();
      renderLock();
      $("m-root").textContent = MEM.tree.rootHex;
      $("m-depth").textContent = MEM.tree.depth;
      $("m-leaves").textContent = MEM.tree.leafCount;
      $("m-total").textContent = grainsToPrl(total);
      show($("m-out"), true);
    } catch (e) {
      setErr("m-err", e.message);
    }
  });
  $("m-reset").addEventListener("click", () => {
    S.locked = false;
    S.treeMeta = null;
    S.sealJson = null;
    MEM.tree = null;
    saveState();
    renderLock();
    show($("m-out"), false);
    show($("s-out"), false);
  });
  $("m-lookup").addEventListener("click", () => {
    setErr("m-proof-err", "");
    show($("m-proof"), false);
    try {
      if (!MEM.tree) throw new Error("Compute the Merkle root first.");
      const addr = validateDropAddress($("m-addr").value);
      const rec = MEM.deduped.recipients.find((r) => r.address === addr);
      if (!rec) throw new Error("Address is not in this recipient list.");
      const proof = dropProof(MEM.tree, rec.index);
      const leafHex = bytesToHex(dropLeafHash(rec.index, rec.address, rec.amountGrains));
      $("m-proof").textContent = JSON.stringify({
        address: rec.address,
        index: rec.index,
        amount_grains: rec.amountGrains.toString(),
        amount_prl: grainsToPrl(rec.amountGrains),
        leaf: leafHex,
        root: MEM.tree.rootHex,
        proof
      }, null, 2);
      show($("m-proof"), true);
    } catch (e) {
      setErr("m-proof-err", e.message);
    }
  });
  $("m-export").addEventListener("click", () => {
    if (!MEM.tree) return;
    const bundle = MEM.deduped.recipients.map((rec) => ({
      address: rec.address,
      index: rec.index,
      amount_grains: rec.amountGrains.toString(),
      amount_prl: grainsToPrl(rec.amountGrains),
      leaf: bytesToHex(dropLeafHash(rec.index, rec.address, rec.amountGrains)),
      proof: dropProof(MEM.tree, rec.index)
    }));
    download("pearl-drop-proofs.json", JSON.stringify({
      app: "Pearl Drop",
      campaign: JSON.parse(S.campaignJson),
      root: MEM.tree.rootHex,
      depth: MEM.tree.depth,
      proofs: bundle
    }, null, 2));
  });
  $("s-compose").addEventListener("click", () => {
    setErr("s-err", "");
    try {
      if (!S.locked || !S.treeMeta) throw new Error("Compute the Merkle root first (Merkle tab).");
      if (S.status !== "closed") throw new Error('Campaign must be "closed" to seal (Campaign tab).');
      const header = JSON.parse(S.campaignJson);
      const { json, sealId } = composeSeal({
        campaignJson: S.campaignJson,
        tick: header.tick,
        rootHex: S.treeMeta.rootHex,
        leafCount: S.treeMeta.leafCount,
        totalGrains: BigInt(S.treeMeta.totalGrains),
        sealedAtIso: (/* @__PURE__ */ new Date()).toISOString()
      });
      S.sealJson = json;
      S.sealId = sealId;
      S.status = "sealed";
      saveState();
      renderStatus();
      $("s-doc").textContent = JSON.stringify(JSON.parse(json), null, 2);
      $("s-sealid").textContent = sealId;
      $("s-envelope").textContent = JSON.stringify(dropEnvelopeBody(json), null, 2);
      show($("s-out"), true);
    } catch (e) {
      setErr("s-err", e.message);
    }
  });
  $("s-copy").addEventListener("click", (e) => copyText(S.sealJson || "", e.target));
  $("s-copy-env").addEventListener("click", (e) => copyText(JSON.stringify(dropEnvelopeBody(S.sealJson || "{}")), e.target));
  $("s-download").addEventListener("click", () => {
    if (S.sealJson) download("pearl-drop-seal.json", S.sealJson);
  });
  function renderChecks(listEl, checks) {
    listEl.innerHTML = checks.map(
      (c) => `<li class="${c.ok ? "good" : "bad"}"><strong>${esc(c.label)}</strong> \u2014 ${esc(c.detail)}</li>`
    ).join("");
  }
  $("s-verify").addEventListener("click", () => {
    const v = verifySealPackage($("s-seal-json").value, $("s-verify-csv").value);
    const verdict = $("s-verdict");
    verdict.className = "verdict " + (v.ok ? "valid" : "invalid");
    verdict.innerHTML = v.ok ? "\u2713 PROVEN \u2014 seal document fully re-derived from the recipient list" : "\u2717 NOT PROVEN \u2014 this package does not check out";
    show(verdict, true);
    renderChecks($("s-checks"), v.checks);
  });
  $("cl-use-current").addEventListener("click", () => {
    if (S.sealJson) $("cl-seal-json").value = S.sealJson;
    if (S.csv) $("cl-csv").value = S.csv;
  });
  $("cl-check").addEventListener("click", () => {
    const r = claimForAddress($("cl-seal-json").value, $("cl-csv").value, $("cl-addr").value);
    MEM.claim = r.ok && r.valid ? r : null;
    const verdict = $("cl-verdict");
    verdict.className = "verdict " + (r.ok && r.valid ? "valid" : "invalid");
    verdict.innerHTML = r.ok && r.valid ? `\u2713 VALID CLAIM \u2014 <span class="mono">${esc(r.amountPrl)} ${esc(r.tick)}</span> for this address` : `\u2717 INVALID \u2014 ${r.checks.length ? esc(r.checks[r.checks.length - 1].detail) : "no result"}`;
    show(verdict, true);
    if (r.ok && r.valid) {
      $("cl-amount").textContent = `${r.amountPrl} ${r.tick} (${r.amountGrains} grains)`;
      $("cl-index").textContent = String(r.index);
      $("cl-leaf").textContent = r.leafHex;
      $("cl-proof").textContent = JSON.stringify({
        address: r.address,
        index: r.index,
        amount_grains: r.amountGrains.toString(),
        leaf: r.leafHex,
        root: r.rootHex,
        proof: r.proof
      }, null, 2);
      show($("cl-detail"), true);
    } else {
      show($("cl-detail"), false);
    }
  });
  $("cl-copy-proof").addEventListener("click", (e) => {
    if (MEM.claim) copyText($("cl-proof").textContent, e.target);
  });
  $("donate-copy").addEventListener("click", (e) => copyText($("donate-addr").textContent.trim(), e.target));
  loadState();
  fillCampaignForm();
  $("r-csv").value = S.csv || "";
  renderStatus();
  renderLock();
  rebuildMemory();
  if (MEM.deduped.recipients.length > 0) renderRecipients();
  if (S.campaignJson) {
    $("c-json").textContent = JSON.stringify(JSON.parse(S.campaignJson), null, 2);
    $("c-id").textContent = campaignId(S.campaignJson);
    $("c-fp").textContent = fingerprint(campaignId(S.campaignJson));
    show($("c-out"), true);
  }
  if (S.locked && S.treeMeta) {
    $("m-root").textContent = S.treeMeta.rootHex;
    $("m-depth").textContent = S.treeMeta.depth;
    $("m-leaves").textContent = S.treeMeta.leafCount;
    $("m-total").textContent = grainsToPrl(BigInt(S.treeMeta.totalGrains));
    show($("m-out"), true);
  }
  if (S.sealJson) {
    $("s-doc").textContent = JSON.stringify(JSON.parse(S.sealJson), null, 2);
    $("s-sealid").textContent = S.sealId || "";
    $("s-envelope").textContent = JSON.stringify(dropEnvelopeBody(S.sealJson), null, 2);
    show($("s-out"), true);
  }
  window.PearlDrop = {
    state: () => S,
    rebuildMemory,
    sampleCsv
  };
})();
