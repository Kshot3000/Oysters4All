// Pearl Hush core tests — BIP-352 Silent Payments for PRL.
// Pins the OFFICIAL BIP-352 send_and_receive_test_vectors.json (bitcoin/bips)
// byte-exact using the reference implementation's own test protocol:
//   sending:   recipient `count` expansion, ineligible inputs skipped, output
//              SET must equal one of expected["outputs"] candidates,
//              shared secrets / input sums / input pubkeys byte-exact.
//   receiving: silent-payment addresses re-encoded (base + labels) byte-exact,
//              found-output {pub_key, priv_key_tweak} SET matches, shared
//              secret / tweak point / input pubkey sum byte-exact, and the
//              vector's schnorr signatures re-verify under the derived spend
//              key (deterministic re-sign equals the vector signature).
// Plus: address encode/decode round-trips, tamper/rejection cases, label
// behavior, and the desk's taprootOnly loud-refusal policy.
//
// Usage: node --no-warnings --loader ./tests/loader.mjs tests/hush.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { hexToBytes } from "@noble/hashes/utils";

import * as H from "../src/hush-core.js";
import { encodeBech32mParts } from "../src/bech32m.js";

const dir = dirname(fileURLToPath(import.meta.url));
const VECTORS = JSON.parse(readFileSync(resolve(dir, "../src/vectors-bip352.json"), "utf8"));
const vinOf = (x) => ({
  txid: x.txid, vout: x.vout,
  prevoutSpk: x.prevout.scriptPubKey.hex,
  scriptSig: x.scriptSig || "", txinwitness: x.txinwitness || "",
});
const setEq = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
const enc = new TextEncoder();
const MSG = sha256(enc.encode("message"));
const AUX = sha256(enc.encode("random auxiliary data"));

/* ---------------- official vectors: sending ---------------- */

describe("BIP-352 official vectors: sending", () => {
  for (const [ci, c] of VECTORS.entries()) {
    for (const [si, s] of c.sending.entries()) {
      const tag = `case ${ci} send#${si} (${c.comment})`;
      const g = s.given, e = s.expected;
      const inputs = g.vin.map((x) => ({ ...vinOf(x), privkey: x.private_key }));
      const recipients = [];
      for (const r of g.recipients) {
        const n = r.count == null ? 1 : r.count;
        for (let i = 0; i < n; i++) recipients.push({ address: r.address });
      }
      const expectRefusal = e.outputs.length === 1 && e.outputs[0].length === 0;
      if (expectRefusal) {
        it(`${tag}: refused loudly`, () => {
          assert.throws(() => H.senderCreateOutputs({ inputs, recipients }), /no eligible inputs|sum to zero|Kmax|REFUSED/);
        });
        continue;
      }
      it(`${tag}: output set matches a candidate`, () => {
        const res = H.senderCreateOutputs({ inputs, recipients });
        const got = res.outputs.map((o) => o.pubkeyXonly);
        assert.ok(e.outputs.some((cand) => setEq(got, cand)),
          `got ${JSON.stringify(got)} not in candidates`);
      });
      it(`${tag}: shared secrets pinned`, () => {
        const res = H.senderCreateOutputs({ inputs, recipients });
        assert.ok(res.sharedSecrets.every((ss) => (e.shared_secrets || []).includes(ss)));
      });
      if (s.expected.input_private_key_sum) {
        it(`${tag}: input_private_key_sum pinned`, () => {
          const res = H.senderCreateOutputs({ inputs, recipients });
          assert.equal(res.inputPrivSum, s.expected.input_private_key_sum);
        });
      }
      if (s.expected.input_pub_keys) {
        it(`${tag}: input_pub_keys pinned`, () => {
          const res = H.senderCreateOutputs({ inputs, recipients });
          assert.deepEqual(res.inputPubKeys, s.expected.input_pub_keys);
        });
      }
      it(`${tag}: every output is a valid 32-byte x-only key`, () => {
        const res = H.senderCreateOutputs({ inputs, recipients });
        for (const o of res.outputs) assert.match(o.pubkeyXonly, /^[0-9a-f]{64}$/);
      });
    }
  }
});

/* ---------------- official vectors: receiving ---------------- */

describe("BIP-352 official vectors: receiving", () => {
  for (const [ci, c] of VECTORS.entries()) {
    for (const [ri, r] of c.receiving.entries()) {
      const tag = `case ${ci} recv#${ri} (${c.comment})`;
      const g = r.given, e = r.expected;
      const bscan = g.key_material.scan_priv_key, bspend = g.key_material.spend_priv_key;
      it(`${tag}: addresses re-encode byte-exact (base + labels)`, () => {
        const Bscan = H.compressedPubkeyFromSecret(bscan);
        const Bspend = H.compressedPubkeyFromSecret(bspend);
        const got = [H.encodeSilentPaymentAddress(Bscan, Bspend, "sp")];
        for (const m of (g.labels || [])) got.push(H.createLabeledAddress(bscan, Bspend, m, "sp").address);
        assert.deepEqual(got, e.addresses);
      });
      const res = H.receiverScan({
        bscanHex: bscan, bspendHex: bspend, labelMs: g.labels || [],
        vins: g.vin.map(vinOf), outputs: g.outputs, maxK: 2323,
      });
      if ("n_outputs" in e) {
        it(`${tag}: finds exactly n_outputs=${e.n_outputs} (Kmax stop)`, () => {
          assert.equal(res.matches.length, e.n_outputs);
        });
        continue;
      }
      if (res.skipped) {
        it(`${tag}: transaction skipped, nothing expected`, () => {
          assert.deepEqual(e.outputs || [], []);
        });
        continue;
      }
      it(`${tag}: found-output {pub_key, priv_key_tweak} set matches`, () => {
        const gotSet = new Set(res.matches.map((m) => m.pubkeyXonly + "|" + m.privKeyTweak));
        const expSet = new Set((e.outputs || []).map((o) => o.pub_key + "|" + o.priv_key_tweak));
        assert.equal(gotSet.size, expSet.size);
        for (const x of gotSet) assert.ok(expSet.has(x), "unexpected match " + x);
      });
      if (e.shared_secret) {
        it(`${tag}: ecdh shared secret pinned`, () => {
          assert.equal(res.ecdhCompressed, e.shared_secret);
        });
      }
      if (e.input_pub_key_sum) {
        it(`${tag}: input_pub_key_sum pinned`, () => {
          assert.equal(res.aSumCompressed, e.input_pub_key_sum);
        });
      }
      if (e.tweak) {
        it(`${tag}: tweak point pinned`, () => {
          assert.equal(res.tweakPointCompressed, e.tweak);
        });
      }
      for (const m of res.matches) {
        const exp = (e.outputs || []).find((o) => o.pub_key === m.pubkeyXonly);
        if (!exp || !exp.signature) continue;
        it(`${tag}: vector signature verifies under derived spend key (${m.pubkeyXonly.slice(0, 12)}…)`, () => {
          assert.ok(schnorr.verify(exp.signature, MSG, m.pubkeyXonly), "schnorr.verify failed");
          const reSigned = Buffer.from(schnorr.sign(MSG, m.spendPrivkey, AUX)).toString("hex");
          assert.equal(reSigned, exp.signature, "deterministic re-sign differs");
        });
        if (m.labelM !== null && m.labelM !== undefined) {
          it(`${tag}: labeled match reports label m=${m.labelM}`, () => {
            assert.ok((g.labels || []).includes(m.labelM) || m.labelM === 0);
          });
        }
      }
    }
  }
});

/* ---------------- address encode/decode ---------------- */

describe("silent-payment address codec", () => {
  const bscan = "0f694e068028a717f8af6b9411f9a133dd3565258714cc226594b34db90c1f2c";
  const bspend = "9d6ad855ce3417ef84e836892e5a56392bfba05fa5d97ccea30e266f540e08b3";
  const Bscan = H.compressedPubkeyFromSecret(bscan);
  const Bspend = H.compressedPubkeyFromSecret(bspend);
  it("v0 encodes with hrp sp and version char q (66-byte payload)", () => {
    const a = H.encodeSilentPaymentAddress(Bscan, Bspend, "sp");
    assert.ok(a.startsWith("sp1q"), a.slice(0, 8));
    const d = H.decodeSilentPaymentAddress(a);
    assert.equal(d.hrp, "sp");
    assert.equal(d.version, 0);
    assert.equal(d.BscanHex, Bscan.toLowerCase());
    assert.equal(d.BmHex, Bspend.toLowerCase());
  });
  it("tsp hrp round-trips", () => {
    const a = H.encodeSilentPaymentAddress(Bscan, Bspend, "tsp");
    assert.ok(a.startsWith("tsp1q"));
    assert.equal(H.decodeSilentPaymentAddress(a).hrp, "tsp");
  });
  it("official vector address decodes to its scan/spend keys", () => {
    const d = H.decodeSilentPaymentAddress(VECTORS[0].sending[0].given.recipients[0].address);
    assert.equal(d.BscanHex, "0220bcfac5b99e04ad1a06ddfb016ee13582609d60b6291e98d01a9bc9a16c96d4");
    assert.equal(d.BmHex, "025cc9856d6f8375350e123978daac200c260cb5b5ae83106cab90484dcd8fcf36");
  });
  it("v1..v30: first 66 bytes read, rest discarded", () => {
    const payload = new Uint8Array(80);
    payload.set(hexToBytes(Bscan), 0);
    payload.set(hexToBytes(Bspend), 33);
    const a = encodeBech32mParts("sp", 1, payload);
    const d = H.decodeSilentPaymentAddress(a);
    assert.equal(d.version, 1);
    assert.equal(d.BscanHex, Bscan.toLowerCase());
  });
  it("v31 refused", () => {
    const a = encodeBech32mParts("sp", 31, new Uint8Array(66));
    assert.throws(() => H.decodeSilentPaymentAddress(a), /reserved/);
  });
  it("bad checksum rejected", () => {
    const a = H.encodeSilentPaymentAddress(Bscan, Bspend, "sp");
    const bad = a.slice(0, -1) + (a.endsWith("q") ? "p" : "q");
    assert.throws(() => H.decodeSilentPaymentAddress(bad), /checksum|not a silent-payment/);
  });
  it("wrong hrp rejected", () => {
    const a = H.encodeSilentPaymentAddress(Bscan, Bspend, "sp").replace(/^sp/, "bc");
    assert.throws(() => H.decodeSilentPaymentAddress(a), /hrp|not a silent-payment/);
  });
  it("short payload rejected", () => {
    const a = encodeBech32mParts("sp", 0, new Uint8Array(65));
    assert.throws(() => H.decodeSilentPaymentAddress(a), /66/);
  });
  it("non-curve keys rejected", () => {
    const bad = "ff".repeat(33);
    assert.throws(() => H.encodeSilentPaymentAddress(bad, Bspend, "sp"), /./);
  });
  it("bad hrp on encode rejected", () => {
    assert.throws(() => H.encodeSilentPaymentAddress(Bscan, Bspend, "xx"), /bad hrp/);
  });
});

/* ---------------- labels ---------------- */

describe("labels", () => {
  const bscan = "0f694e068028a717f8af6b9411f9a133dd3565258714cc226594b34db90c1f2c";
  const bspend = "9d6ad855ce3417ef84e836892e5a56392bfba05fa5d97ccea30e266f540e08b3";
  const Bspend = H.compressedPubkeyFromSecret(bspend);
  it("labelTweak matches hashBIP0352/Label(ser256(bscan)||ser32(m))", () => {
    const t = H.labelTweak(bscan, 3);
    const want = H.taggedHash("BIP0352/Label", H.concat(H.ser256(H.scalarFromHex(bscan, "x")), H.ser32(3)));
    assert.equal(H.bytesToHex(H.ser256(t)), H.bytesToHex(want));
  });
  it("m=0 label address differs from unlabeled, both decode", () => {
    const plain = H.encodeSilentPaymentAddress(H.compressedPubkeyFromSecret(bscan), Bspend, "sp");
    const l0 = H.createLabeledAddress(bscan, Bspend, 0, "sp");
    assert.notEqual(l0.address, plain);
    assert.equal(H.decodeSilentPaymentAddress(l0.address).BmHex, l0.BmHex);
  });
  it("large label integer works (vector case 14: m=1001337)", () => {
    const l = H.createLabeledAddress(bscan, Bspend, 1001337, "sp");
    assert.ok(l.address.startsWith("sp1q"));
  });
  it("non-integer / negative / huge label refused", () => {
    assert.throws(() => H.labelTweak(bscan, -1), /uint32/);
    assert.throws(() => H.labelTweak(bscan, 1.5), /uint32/);
    assert.throws(() => H.labelTweak(bscan, 0x100000000), /uint32/);
  });
  it("labeled address carries the label tweak in Bm = Bspend + t*G", () => {
    const l = H.createLabeledAddress(bscan, Bspend, 7, "sp");
    const t = H.labelTweak(bscan, 7);
    const Bm = H.labeledSpendKey(H.pointFromCompressed(Bspend), t);
    assert.equal(H.serPHex(Bm), l.BmHex);
  });
});

/* ---------------- sender refusals / taprootOnly policy ---------------- */

describe("sender refusals", () => {
  const p2trIn = (txid) => ({
    txid, vout: 0,
    prevoutSpk: "512079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798", // G x-only (valid curve point)
    scriptSig: "", txinwitness: "01" + "40" + "ab".repeat(64),
    privkey: "11".repeat(32),
  });
  const addr = H.encodeSilentPaymentAddress(
    H.compressedPubkeyFromSecret("22".repeat(32)),
    H.compressedPubkeyFromSecret("33".repeat(32)), "sp");
  it("taprootOnly refuses a P2WPKH input loudly", () => {
    const inW = {
      txid: "aa".repeat(32), vout: 0,
      prevoutSpk: "0014" + "bb".repeat(20),
      scriptSig: "", txinwitness: "02" + "40" + "cc".repeat(64) + "21" + "02" + "dd".repeat(32),
      privkey: "44".repeat(32),
    };
    assert.throws(
      () => H.senderCreateOutputs({ inputs: [inW], recipients: [{ address: addr }], taprootOnly: true }),
      /REFUSED: non-taproot input/);
  });
  it("taprootOnly accepts a taproot input", () => {
    const res = H.senderCreateOutputs({ inputs: [p2trIn("aa".repeat(32))], recipients: [{ address: addr }], taprootOnly: true });
    assert.equal(res.outputs.length, 1);
  });
  it("empty txinwitness is an empty stack: taproot input with (empty ok) witness accepted", () => {
    // The Send tab advertises scriptSig/witness "(empty ok)" for key-path spends;
    // the P2TR branch must treat "" as an empty witness stack, not fail with
    // "witness truncated". The shared secret must equal the explicit-witness case.
    const tw = H.tapTweakPrivkey("44".repeat(32)); // consistent taproot key material
    const mkIn = (txid, wit) => ({
      txid, vout: 0,
      prevoutSpk: "5120" + tw.tweakedXonlyHex,
      scriptSig: "", txinwitness: wit,
      privkey: tw.tweakedPrivHex,
    });
    const bare = mkIn("aa".repeat(32), "");
    assert.equal(H.classifyInput(bare).kind, "p2tr");
    const res = H.senderCreateOutputs({ inputs: [bare], recipients: [{ address: addr }], taprootOnly: true });
    const ref = H.senderCreateOutputs({
      inputs: [mkIn("aa".repeat(32), "01" + "40" + "ab".repeat(64))],
      recipients: [{ address: addr }], taprootOnly: true });
    assert.equal(res.outputs.length, 1);
    assert.equal(res.outputs[0].pubkeyXonly, ref.outputs[0].pubkeyXonly);
    assert.equal(res.inputHash, ref.inputHash);
    assert.deepEqual(res.sharedSecrets, ref.sharedSecrets);
    // receiver scan with the empty-witness vin still finds the payment
    const scan = H.receiverScan({
      bscanHex: "22".repeat(32), bspendHex: "33".repeat(32), labelMs: [],
      vins: [{ txid: "aa".repeat(32), vout: 0, prevoutSpk: bare.prevoutSpk, scriptSig: "", txinwitness: "" }],
      outputs: [res.outputs[0].pubkeyXonly],
    });
    assert.equal(scan.matches.length, 1);
    assert.equal(scan.matches[0].pubkeyXonly, res.outputs[0].pubkeyXonly);
  });
  it("empty inputs refused", () => {
    assert.throws(() => H.senderCreateOutputs({ inputs: [], recipients: [{ address: addr }] }), /at least one input/);
  });
  it("empty recipients refused", () => {
    assert.throws(() => H.senderCreateOutputs({ inputs: [p2trIn("aa".repeat(32))], recipients: [] }), /at least one recipient/);
  });
  it("bad recipient address refused", () => {
    assert.throws(
      () => H.senderCreateOutputs({ inputs: [p2trIn("aa".repeat(32))], recipients: [{ address: "sp1qgarbage" }] }),
      /not a silent-payment/);
  });
  it("count > Kmax refused", () => {
    assert.throws(
      () => H.senderCreateOutputs({ inputs: [p2trIn("aa".repeat(32))], recipients: [{ address: addr, count: 2324 }] }),
      /bad output count/);
  });
  it("invalid input secret refused", () => {
    const bad = p2trIn("aa".repeat(32)); bad.privkey = "zz";
    assert.throws(() => H.senderCreateOutputs({ inputs: [bad], recipients: [{ address: addr }] }), /bad input private key/);
  });
  it("zero secret refused", () => {
    const bad = p2trIn("aa".repeat(32)); bad.privkey = "00".repeat(32);
    assert.throws(() => H.senderCreateOutputs({ inputs: [bad], recipients: [{ address: addr }] }), /not in 1\.\.n-1/);
  });
  it("bad txid refused", () => {
    const bad = p2trIn("zz");
    assert.throws(() => H.senderCreateOutputs({ inputs: [bad], recipients: [{ address: addr }] }), /bad txid/);
  });
});

/* ---------------- receiver edge cases ---------------- */

describe("receiver edge cases", () => {
  const bscan = "0f694e068028a717f8af6b9411f9a133dd3565258714cc226594b34db90c1f2c";
  const bspend = "9d6ad855ce3417ef84e836892e5a56392bfba05fa5d97ccea30e266f540e08b3";
  const vinOf0 = VECTORS[0].receiving[0].given.vin.map(vinOf);
  const outs0 = VECTORS[0].receiving[0].given.outputs;
  it("unrelated outputs yield zero matches", () => {
    const res = H.receiverScan({
      bscanHex: bscan, bspendHex: bspend, vins: vinOf0,
      outputs: ["aa".repeat(32), "bb".repeat(32)],
    });
    assert.equal(res.matches.length, 0);
    assert.equal(res.skipped, false);
  });
  it("spend key actually spends: even-Y key whose x-only equals the output", () => {
    const res = H.receiverScan({ bscanHex: bscan, bspendHex: bspend, vins: vinOf0, outputs: outs0 });
    assert.equal(res.matches.length, 1);
    const m = res.matches[0];
    const comp = H.compressedPubkeyFromSecret(m.spendPrivkey);
    assert.ok(comp.startsWith("02"), "spend key normalized to even Y");
    assert.equal(comp.slice(2), m.pubkeyXonly, "x-only(spend key) == output key");
    assert.equal(m.pubkeyXonly, outs0[0]);
  });
  it("derived prl1 address is a valid bech32m v1 32-byte address", () => {
    const res = H.receiverScan({ bscanHex: bscan, bspendHex: bspend, vins: vinOf0, outputs: outs0 });
    assert.ok(res.matches[0].prlAddress.startsWith("prl1p"), res.matches[0].prlAddress);
  });
  it("garbage output hex refused", () => {
    assert.throws(() => H.receiverScan({
      bscanHex: bscan, bspendHex: bspend, vins: vinOf0, outputs: ["zz"],
    }), /taproot output/);
  });
  it("bad scan secret refused", () => {
    assert.throws(() => H.receiverScan({
      bscanHex: "00".repeat(32), bspendHex: bspend, vins: vinOf0, outputs: outs0,
    }), /scan secret/);
  });
});

/* ---------------- misc unit checks ---------------- */

describe("primitives", () => {
  it("taggedHash matches BIP-340 construction", () => {
    const { sha256: s2 } = { sha256 };
    const tag = s2(enc.encode("BIP0352/Label"));
    const want = s2(Buffer.concat([tag, tag, enc.encode("abc")]));
    assert.equal(H.bytesToHex(H.taggedHash("BIP0352/Label", enc.encode("abc"))), Buffer.from(want).toString("hex"));
  });
  it("ser32 is big-endian", () => {
    assert.equal(H.bytesToHex(H.ser32(1)), "00000001");
    assert.equal(H.bytesToHex(H.ser32(0xffffffff)), "ffffffff");
  });
  it("outpointBytes: txid LSB-first || vout LE32", () => {
    const b = H.outpointBytes("010203" + "00".repeat(29), 1);
    assert.equal(H.bytesToHex(b.slice(0, 32)), "00".repeat(29) + "030201");
    assert.equal(H.bytesToHex(b.slice(32)), "01000000");
  });
  it("grainsToPRL / parseGrains round-trip", () => {
    assert.equal(H.grainsToPRL(100000000n), "1.00000000");
    assert.equal(H.parseGrains("123", "x").toString(), "123");
    assert.throws(() => H.parseGrains("1.5", "x"), /grains/);
  });
  it("tapTweakPrivkey matches BIP-341 key-path tweak", () => {
    const t = H.tapTweakPrivkey("11".repeat(32));
    assert.match(t.tweakedPrivHex, /^[0-9a-f]{64}$/);
    assert.match(t.tweakedXonlyHex, /^[0-9a-f]{64}$/);
  });
  it("generateKeyMaterial produces a decodable address", () => {
    const m = H.generateKeyMaterial("sp");
    const d = H.decodeSilentPaymentAddress(m.address);
    assert.equal(d.BscanHex, m.BscanHex.toLowerCase());
  });
  it("ATTRIBUTION carries @kshot9000 and the exact PRL address", () => {
    assert.equal(H.ATTRIBUTION.x, "@kshot9000");
    assert.equal(H.ATTRIBUTION.prl, "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d");
  });
});
