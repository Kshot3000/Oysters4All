// Pearl Tipjar verification suite.
// Run: node --no-warnings --loader ./tests/loader.mjs tests/tipjar.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  validateTipAddress,
  formatPrl,
  parsePRLToGrains,
  pearlUri,
  normalizeConfig,
  canonicalConfigJSON,
  forgeTipjar,
  parseDescriptor,
  verifyTipjar,
  extractReceived,
  detectNewTips,
  sumTips,
  goalProgress,
  tipsToCsv,
  buildEmbedSnippet,
  WIDGET_RUNTIME,
  THEMES,
  TIP_DUST_FLOOR,
  DEFAULT_POLL_SEC,
  NETWORKS,
  DONATE_ADDRESS,
} from "../src/tipjar-core.js";
import { encodeBech32m } from "../../sign/src/crypto.js";

// deterministic fixtures: program bytes 0..31
const PROGRAM = new Uint8Array(32).map((_, i) => i);
const ADDR = encodeBech32m("prl", 1, PROGRAM);
const TADDR = encodeBech32m("tprl", 1, PROGRAM);

// tiny bech32m encoder for negative-case fixtures (v0 witness, wrong hrp)
function bech32mEncode(hrp, version, program) {
  const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  const polymod = (values) => {
    let chk = 1;
    for (const v of values) {
      const b = chk >>> 25;
      chk = ((chk & 0x1ffffff) << 5) ^ v;
      for (let i = 0; i < 5; i++) if ((b >>> i) & 1) chk ^= GEN[i];
    }
    return chk;
  };
  const hrpExpand = (h) => {
    const a = [];
    for (const c of h) a.push(c.charCodeAt(0) >>> 5);
    a.push(0);
    for (const c of h) a.push(c.charCodeAt(0) & 31);
    return a;
  };
  const convert = (data, from, to, pad) => {
    let acc = 0, bits = 0;
    const ret = [], maxv = (1 << to) - 1;
    for (const v of data) {
      acc = (acc << from) | v; bits += from;
      while (bits >= to) { bits -= to; ret.push((acc >>> bits) & maxv); }
    }
    if (pad && bits) ret.push((acc << (to - bits)) & maxv);
    return ret;
  };
  const data5 = [version, ...convert([...program], 8, 5, true)];
  const mod = polymod(hrpExpand(hrp).concat(data5, [0, 0, 0, 0, 0, 0])) ^ 0x2bc830a3;
  const chk = [];
  for (let i = 0; i < 6; i++) chk.push((mod >>> (5 * (5 - i))) & 31);
  return hrp + "1" + data5.concat(chk).map((v) => CHARSET[v]).join("");
}

const GOOD_CFG = {
  address: ADDR,
  title: "Tip the builder",
  presets: ["2.5", "0.5", "1"],
  goal: "100",
  theme: "deep-abyss",
  pollSec: 45,
  blockbook: "https://blockbook.pearlresearch.ai",
};

/* ---------------- address validation ---------------- */

test("validateTipAddress accepts a valid prl1 Taproot address", () => {
  const v = validateTipAddress(ADDR);
  assert.equal(v.address, ADDR);
  assert.equal(v.network.id, "mainnet");
  assert.equal(v.program.length, 32);
});

test("validateTipAddress accepts tprl1 and canonicalizes uppercase", () => {
  const v = validateTipAddress("  " + TADDR.toUpperCase() + " ");
  assert.equal(v.address, TADDR);
  assert.equal(v.network.id, "testnet");
});

test("validateTipAddress rejects wrong hrp", () => {
  const other = bech32mEncode("bc", 1, PROGRAM);
  assert.throws(() => validateTipAddress(other), /wrong network hrp/);
});

test("validateTipAddress rejects non-v1 witness", () => {
  const v0 = bech32mEncode("prl", 0, PROGRAM);
  assert.throws(() => validateTipAddress(v0), /witness|not a valid Pearl address/);
});

test("validateTipAddress rejects bad checksum and empty input", () => {
  assert.throws(() => validateTipAddress(ADDR.slice(0, -1) + (ADDR.endsWith("q") ? "p" : "q")), /not a valid Pearl address/);
  assert.throws(() => validateTipAddress(""), /required/);
});

/* ---------------- grain math ---------------- */

test("parsePRLToGrains is exact, formatPrl round-trips", () => {
  assert.equal(parsePRLToGrains("1"), 100000000n);
  assert.equal(parsePRLToGrains("0.1"), 10000000n);
  assert.equal(parsePRLToGrains("0.00000001"), 1n);
  assert.equal(parsePRLToGrains("2.5"), 250000000n);
  assert.equal(formatPrl(1n), "0.00000001");
  assert.equal(formatPrl(100000000n), "1");
  assert.equal(formatPrl(150000000n), "1.5");
  assert.equal(formatPrl(parsePRLToGrains("123.45678901")), "123.45678901");
});

test("parsePRLToGrains rejects 9-decimal dust and junk", () => {
  assert.throws(() => parsePRLToGrains("0.000000001"), /not an exact PRL amount/);
  assert.throws(() => parsePRLToGrains("-1"), /not an exact PRL amount/);
  assert.throws(() => parsePRLToGrains("abc"), /not an exact PRL amount/);
  assert.throws(() => parsePRLToGrains(""), /not an exact PRL amount/);
});

test("pearlUri formats BIP-21 style URIs", () => {
  assert.equal(pearlUri(ADDR, 150000000n), `pearl:${ADDR}?amount=1.5`);
  assert.equal(pearlUri(ADDR, null), `pearl:${ADDR}`);
});

/* ---------------- config ---------------- */

test("normalizeConfig validates, dedupes + sorts presets, applies defaults", () => {
  const c = normalizeConfig({ address: ADDR, title: "  Jar  ", presets: ["2", "0.5", "2"] });
  assert.equal(c.address, ADDR);
  assert.equal(c.hrp, "prl");
  assert.equal(c.title, "Jar");
  assert.deepEqual(c.presets, ["0.5", "2"]);
  assert.equal(c.goal, null);
  assert.equal(c.theme, "harbor-lantern");
  assert.equal(c.pollSec, DEFAULT_POLL_SEC);
  assert.equal(c.blockbook, NETWORKS.mainnet.blockbook);
  assert.equal(TIP_DUST_FLOOR, 1000n);
});

test("normalizeConfig rejects bad configs loudly", () => {
  const bad = (patch, re) => assert.throws(() => normalizeConfig({ ...GOOD_CFG, ...patch }), re);
  bad({ presets: [] }, /at least one amount preset/);
  bad({ presets: ["1", "2", "3", "4", "5"] }, /at most 4 presets/);
  bad({ presets: ["0.00000999"] }, /dust floor/); // 999 grains
  bad({ presets: ["0"] }, /positive/);
  bad({ goal: "0.25" }, /below the largest preset/); // goal < 2.5 max preset
  bad({ pollSec: 10 }, /15–300/);
  bad({ pollSec: 400 }, /15–300/);
  bad({ pollSec: 30.5 }, /15–300/);
  bad({ theme: "neon" }, /unknown theme/);
  bad({ title: "" }, /title is required/);
  bad({ title: "x".repeat(61) }, /too long/);
  bad({ address: "nope" }, /not a valid Pearl address/);
  bad({ blockbook: "ftp://x" }, /http\(s\)/);
});

/* ---------------- descriptor ---------------- */

test("forgeTipjar produces tipjar:v1: descriptor; verify round-trips", () => {
  const f = forgeTipjar(GOOD_CFG);
  assert.match(f.descriptor, /^tipjar:v1:prl:[0-9a-f]{64}$/);
  assert.equal(f.descriptorHash.length, 64);
  assert.equal(f.config.presets.join(","), "0.5,1,2.5");
  assert.equal(f.config.goal, "100");
  const v = verifyTipjar({ configJson: f.configJson, descriptor: f.descriptor });
  assert.equal(v.ok, true);
  assert.equal(v.configHash, f.configHash);
});

test("verifyTipjar LOUDLY REFUSES a tampered config", () => {
  const f = forgeTipjar(GOOD_CFG);
  const tampered = JSON.parse(f.configJson);
  tampered.title = "Tip the attacker instead";
  assert.throws(
    () => verifyTipjar({ configJson: JSON.stringify(tampered), descriptor: f.descriptor }),
    /⛔ TIPJAR VERIFY REFUSED/
  );
  // tampered preset amount also refused
  const tampered2 = JSON.parse(f.configJson);
  tampered2.presets = ["999999999999"];
  assert.throws(
    () => verifyTipjar({ configJson: JSON.stringify(tampered2), descriptor: f.descriptor }),
    /REFUSED/
  );
});

test("parseDescriptor rejects malformed descriptors", () => {
  assert.throws(() => parseDescriptor("tipjar:v1:prl:zzz"), /not a tipjar descriptor/);
  assert.throws(() => parseDescriptor("raffle:v1:prl:" + "a".repeat(64)), /not a tipjar descriptor/);
  assert.throws(() => verifyTipjar({ configJson: "{bad json", descriptor: forgeTipjar(GOOD_CFG).descriptor }), /REFUSED/);
  // hrp mismatch between descriptor and config address
  const f = forgeTipjar(GOOD_CFG);
  const tcfg = { ...GOOD_CFG, address: TADDR };
  const tf = forgeTipjar(tcfg);
  assert.throws(
    () => verifyTipjar({ configJson: tf.configJson, descriptor: f.descriptor }),
    /REFUSED/
  );
});

/* ---------------- tip detection ---------------- */

const TXS = [
  {
    txid: "aaa",
    confirmations: 3,
    vout: [
      { value: "50000000", addresses: [ADDR] },
      { value: "1000000", addresses: ["prl1other"] },
    ],
  },
  {
    txid: "bbb",
    confirmations: 0, // 0-conf: not counted
    vout: [{ value: "90000000", addresses: [ADDR] }],
  },
  {
    txid: "ccc",
    confirmations: 2,
    vout: [{ value: "500", addresses: [ADDR] }], // dust: not counted
  },
  {
    txid: "ddd",
    confirmations: 5,
    vout: [{ value: "250000000", addresses: [ADDR] }],
  },
];

test("extractReceived sums only outputs paying the watched address", () => {
  assert.equal(extractReceived(TXS[0], ADDR), 50000000n);
  assert.equal(extractReceived(TXS[0], "prl1other"), 1000000n);
  assert.equal(extractReceived({ txid: "x", vout: [] }, ADDR), 0n);
});

test("detectNewTips counts only confirmed, above-dust, unseen txs", () => {
  const r1 = detectNewTips([], TXS, ADDR);
  assert.deepEqual(r1.tips.map((t) => t.txid), ["aaa", "ddd"]);
  assert.equal(r1.tips[0].grains, 50000000n);
  assert.equal(r1.ignoredDust, 1); // ccc
  assert.equal(r1.seen.length, 4); // bbb marked seen even though not counted
  // second poll: nothing new
  const r2 = detectNewTips(r1.seen, TXS, ADDR);
  assert.deepEqual(r2.tips, []);
  assert.equal(r2.ignoredDust, 0);
});

test("sumTips and goalProgress do exact grain math", () => {
  const tips = [{ txid: "a", grains: 50000000n, confirmations: 3 }];
  assert.equal(sumTips(tips), 50000000n);
  assert.equal(formatPrl(sumTips(tips)), "0.5");
  const g = goalProgress(50000000n, 100000000n);
  assert.equal(g.pct, 50);
  const over = goalProgress(250000000n, 100000000n);
  assert.equal(over.pct, 100);
  const none = goalProgress(0n, null);
  assert.equal(none.pct, null);
});

/* ---------------- CSV + snippet ---------------- */

test("tipsToCsv exports exact rows", () => {
  const csv = tipsToCsv([
    { txid: "aaa", grains: 50000000n, confirmations: 3 },
    { txid: "bbb", grains: 1n, confirmations: 12 },
  ]);
  const lines = csv.trim().split("\n");
  assert.equal(lines[0], "txid,received_grains,received_prl,confirmations");
  assert.equal(lines[1], "aaa,50000000,0.5,3");
  assert.equal(lines[2], "bbb,1,0.00000001,12");
});

test("buildEmbedSnippet emits a self-contained block with the descriptor", () => {
  const f = forgeTipjar(GOOD_CFG);
  const qr = { "0.5": "<svg>qr1</svg>", "1": "<svg>qr2</svg>", "2.5": "<svg>qr3</svg>", "": "<svg>qr0</svg>" };
  const snip = buildEmbedSnippet({ ...f.config, qr });
  assert.match(snip, /data-pearl-tipjar|<div id="ptj-[0-9a-f]{10}">/);
  assert.match(snip, /application\/json/);
  assert.ok(snip.includes(WIDGET_RUNTIME.slice(0, 60)), "embeds the runtime");
  assert.ok(snip.includes("confettiBurst"), "runtime has confetti");
  assert.ok(snip.includes("details=txs"), "runtime polls Blockbook GET-only");
  assert.ok(snip.includes("never moves funds"), "honest footer in widget");
  assert.ok(snip.includes("harbor-lantern") || snip.includes("deep-abyss"), "theme travels with config");
  assert.ok(snip.includes(`tipjar:v1:prl:${f.configHash}`), "descriptor comment matches config hash");
  // the embedded JSON round-trips through the verifier
  const m = snip.match(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/);
  assert.ok(m, "config block extractable");
  const parsed = JSON.parse(m[1].replace(/<\\\//g, "</"));
  assert.equal(parsed.address, ADDR);
  const v = verifyTipjar({ configJson: JSON.stringify(parsed), descriptor: f.descriptor });
  assert.equal(v.ok, true);
});

test("WIDGET_RUNTIME is a serializable mount function covering all themes", () => {
  assert.match(WIDGET_RUNTIME, /^function pearlTipjarWidget\(root, config\)/);
  for (const t of Object.keys(THEMES)) {
    assert.ok(WIDGET_RUNTIME.includes(`"${t}"`), `runtime styles theme ${t}`);
  }
  assert.equal(Object.keys(THEMES).length, 3);
});

test("DONATE_ADDRESS is Kyle's address, copied from the suite constant", () => {
  assert.equal(DONATE_ADDRESS, "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d");
});
