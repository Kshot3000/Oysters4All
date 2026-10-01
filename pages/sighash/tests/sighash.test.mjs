// Pearl Sighash Studio core tests.
// Usage: node --no-warnings --loader ./tests/loader.mjs tests/sighash.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  tapSighashAnatomy, compareFlags, flagDigestMatrix, flagInfo, VALID_HASH_TYPES,
  SIGHASH_FLAGS, taggedHash, sha256, bytesToHex, hexToBytes, concat, u64le, varint,
  bip340Sign, bip340Verify, bip340Pubkey, parseUnsignedTx,
  sealScenario, verifySealed, demoScenario, p2trSpk, grainsToPRL, SEAL_DOMAIN,
} from "../src/sighash-core.js";
import { BIP341_KEYPATH as V341 } from "../src/vectors-bip341.js";
import { BIP340_VECTORS as V340 } from "../src/vectors-bip340.js";

const lc = (s) => String(s).toLowerCase();

/* Build the exact scenario for a BIP-341 wallet-test-vector case. */
function vectorParams(c) {
  const tx = parseUnsignedTx(V341.rawUnsignedTx);
  return {
    version: tx.version, locktime: tx.locktime,
    inputs: tx.inputs.map((inp, i) => ({
      txid: inp.txid, vout: inp.vout,
      valueGrains: V341.utxosSpent[i].amountSats.toString(),
      spk: V341.utxosSpent[i].scriptPubKey, sequence: inp.sequence,
    })),
    outputs: tx.outputs.map((o) => ({ valueGrains: o.valueGrains, spk: o.spk })),
    inputIndex: c.txinIndex, hashType: c.hashType,
    spend: { scriptPath: false }, annex: null,
  };
}

describe("BIP-341 wallet-test-vectors: all 7 hash types pin byte-exact", () => {
  for (const c of V341.cases) {
    const flag = SIGHASH_FLAGS[c.hashType].name;
    it(`ht 0x${c.hashType.toString(16)} (${flag}) idx ${c.txinIndex}: preimage === sigMsg`, () => {
      const a = tapSighashAnatomy(vectorParams(c));
      assert.equal(lc(a.preimageHex), lc(c.sigMsg));
    });
    it(`ht 0x${c.hashType.toString(16)} (${flag}) idx ${c.txinIndex}: digest === sigHash`, () => {
      const a = tapSighashAnatomy(vectorParams(c));
      assert.equal(lc(a.digestHex), lc(c.sigHash));
    });
  }
  it("precomputed all-input hashes match the published intermediaries", () => {
    const a = tapSighashAnatomy(vectorParams(V341.cases[3])); // DEFAULT
    const get = (id) => a.intermediates.find((x) => x.id === id).valueHex;
    assert.equal(lc(get("sha_prevouts")), lc(V341.precomputed.hashPrevouts));
    assert.equal(lc(get("sha_amounts")), lc(V341.precomputed.hashAmounts));
    assert.equal(lc(get("sha_scriptpubkeys")), lc(V341.precomputed.hashScriptPubkeys));
    assert.equal(lc(get("sha_sequences")), lc(V341.precomputed.hashSequences));
    assert.equal(lc(get("sha_outputs")), lc(V341.precomputed.hashOutputs));
  });
  it("vector tx parses to 9 inputs / 2 outputs, locktime 500000000", () => {
    const tx = parseUnsignedTx(V341.rawUnsignedTx);
    assert.equal(tx.inputs.length, 9);
    assert.equal(tx.outputs.length, 2);
    assert.equal(tx.locktime, 500000000);
    assert.equal(tx.inputs[0].vout, 1);
  });
});

describe("BIP-340 official vectors: sign + verify", () => {
  for (const r of V340) {
    if (r.seckey) {
      it(`row ${r.index}: sign reproduces the published signature`, () => {
        assert.equal(lc(bip340Sign(r.msg, r.seckey, r.aux)), lc(r.sig));
      });
      it(`row ${r.index}: derived pubkey matches the published pubkey`, () => {
        assert.equal(lc(bip340Pubkey(r.seckey)), lc(r.pubkey));
      });
    }
    it(`row ${r.index}: verify returns ${r.valid ? "TRUE" : "FALSE"}`, () => {
      assert.equal(bip340Verify(r.msg, r.sig, r.pubkey), r.valid);
    });
  }
});

describe("TapTweak pin from the BIP-341 vectors (domain separation across tags)", () => {
  it("taggedHash('TapTweak', internalPubkey) === published tweak", () => {
    const t = taggedHash("TapTweak", hexToBytes(V341.tapTweak.internalPubkey));
    assert.equal(lc(bytesToHex(t)), lc(V341.tapTweak.tweak));
  });
  it("TapSighash tag is domain-separated from TapTweak / TapLeaf / raw sha256", () => {
    const m = hexToBytes("00112233445566778899aabbccddeeff");
    const a = bytesToHex(taggedHash("TapSighash", m));
    const b = bytesToHex(taggedHash("TapTweak", m));
    const c = bytesToHex(taggedHash("TapLeaf", m));
    const d = bytesToHex(sha256(m));
    assert.equal(new Set([a, b, c, d]).size, 4);
  });
  it("sha256('abc') is the well-known digest", () => {
    assert.equal(bytesToHex(sha256(new TextEncoder().encode("abc"))),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("flag table + refusals", () => {
  it("exactly the 7 valid hash types are accepted", () => {
    assert.deepEqual([...VALID_HASH_TYPES].sort((x, y) => x - y), [0, 1, 2, 3, 129, 130, 131]);
    for (const ht of VALID_HASH_TYPES) assert.ok(flagInfo(ht).name);
  });
  it("unknown hash_type is refused loudly", () => {
    assert.throws(() => tapSighashAnatomy({ ...demoScenario(), hashType: 0x04 }), /unknown hash_type/);
    assert.throws(() => tapSighashAnatomy({ ...demoScenario(), hashType: 0x80 }), /unknown hash_type/);
  });
  it("SIGHASH_SINGLE with input index >= nOutputs is refused loudly", () => {
    const p = demoScenario(); // 2 inputs, 2 outputs
    // input index beyond the inputs is refused as a bad index first
    assert.throws(() => tapSighashAnatomy({ ...p, hashType: 0x03, inputIndex: 2 }), /bad input index/);
    // valid input index but no corresponding output -> the consensus refusal
    const oneOut = { ...p, outputs: [p.outputs[0]] };
    assert.throws(() => tapSighashAnatomy({ ...oneOut, hashType: 0x03, inputIndex: 1 }), /no corresponding output/);
    assert.throws(() => tapSighashAnatomy({ ...oneOut, hashType: 0x83, inputIndex: 1 }), /no corresponding output/);
    // ...but input 1 with 2 outputs is fine
    assert.ok(tapSighashAnatomy({ ...p, hashType: 0x03, inputIndex: 1 }).digestHex);
  });
  it("annex without the 0x50 prefix is refused", () => {
    assert.throws(() => tapSighashAnatomy({ ...demoScenario(), annex: "00".repeat(32) }), /0x50/);
  });
  it("script-path spend without a leaf script is refused", () => {
    assert.throws(() => tapSighashAnatomy({ ...demoScenario(), spend: { scriptPath: true } }), /tapleaf script/);
  });
  it("malformed hex / amounts are refused", () => {
    assert.throws(() => tapSighashAnatomy({ ...demoScenario(), inputs: [{ ...demoScenario().inputs[0], txid: "zz" }] }), /hex/);
    assert.throws(() => tapSighashAnatomy({ ...demoScenario(), inputs: [{ ...demoScenario().inputs[0], valueGrains: "-1" }] }), /negative/);
  });
});

describe("flag-difference matrix (3-in/2-out scenario)", () => {
  const base = {
    version: 2, locktime: 0,
    inputs: [0, 1, 2].map((i) => ({
      txid: String(i).repeat(64).slice(0, 64).replace(/./g, (ch, j) => "0123456789abcdef"[(i + j) % 16]),
      vout: i, valueGrains: String(100000000 * (i + 1)),
      spk: p2trSpk("79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"),
      sequence: 0xffffffff,
    })),
    outputs: [
      { valueGrains: "500000000", spk: p2trSpk("d6889cb081036e0faefa3a35157ad71086b123b2b144b649798b494c300a961d") },
      { valueGrains: "99900000", spk: p2trSpk("79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798") },
    ],
    inputIndex: 1, hashType: 0x00, spend: { scriptPath: false }, annex: null,
  };
  const at = (ht) => tapSighashAnatomy({ ...base, hashType: ht });
  const present = (a, id) => a.intermediates.find((x) => x.id === id).present;

  it("all 7 digests are pairwise distinct", () => {
    const ds = Object.values(flagDigestMatrix(base));
    assert.equal(new Set(ds).size, 7);
  });
  it("DEFAULT vs ALL: coverage identical, only the hash_type byte differs", () => {
    const cmp = compareFlags(base, 0x00, 0x01);
    const diff = cmp.rows.filter((r) => !r.same).map((r) => r.id).sort();
    assert.deepEqual(diff, ["digest", "hash_type"]);
  });
  it("NONE omits sha_outputs; everything else matches ALL", () => {
    const cmp = compareFlags(base, 0x01, 0x02);
    const diff = cmp.rows.filter((r) => !r.same).map((r) => r.id).sort();
    assert.deepEqual(diff, ["digest", "hash_type", "sha_outputs"]);
    assert.ok(!present(at(0x02), "sha_outputs"));
  });
  it("ANYONECANPAY drops the four all-input hashes and swaps input_data", () => {
    const cmp = compareFlags(base, 0x01, 0x81);
    const diff = cmp.rows.filter((r) => !r.same).map((r) => r.id).sort();
    assert.deepEqual(diff, ["digest", "hash_type", "input_data", "sha_amounts", "sha_prevouts", "sha_scriptpubkeys", "sha_sequences"]);
    for (const id of ["sha_prevouts", "sha_amounts", "sha_scriptpubkeys", "sha_sequences"])
      assert.ok(!present(at(0x81), id));
  });
  it("SINGLE carries sha_single_output = sha256(CTxOut at input index)", () => {
    const a = at(0x03);
    const rec = a.intermediates.find((x) => x.id === "sha_single_output");
    assert.ok(rec.present);
    const o = base.outputs[1];
    const ctu = concat(u64le(BigInt(o.valueGrains)), varint(hexToBytes(o.spk).length), hexToBytes(o.spk));
    assert.equal(rec.preimageHex, bytesToHex(ctu));
    assert.equal(rec.valueHex, bytesToHex(sha256(ctu)));
    assert.ok(!present(a, "sha_outputs"));
  });
  it("compare rows expose values/presence and include the script-path extension row", () => {
    const cmp = compareFlags(base, 0x01, 0x02);
    assert.equal(cmp.rows.length, 15);
    assert.ok(cmp.rows.every((r) => "aValue" in r && "bValue" in r && "aPresent" in r && "bPresent" in r));
    assert.ok(cmp.rows.some((r) => r.id === "tapscript_ext"));
    const noneRow = cmp.rows.find((r) => r.id === "sha_outputs");
    assert.equal(noneRow.aPresent, true);
    assert.equal(noneRow.bPresent, false);
  });
  it("sha_single_output sits AFTER the input data (BIP-341 field order)", () => {
    const ids = at(0x03).intermediates.filter((x) => x.present).map((x) => x.id);
    assert.ok(ids.indexOf("sha_single_output") > ids.indexOf("input_data"));
    assert.ok(ids.indexOf("sha_single_output") > ids.indexOf("spend_type"));
  });
});

describe("tamper regressions", () => {
  const p = demoScenario();
  const dig = (q) => tapSighashAnatomy(q).digestHex;
  it("tampering an output changes ALL but not NONE", () => {
    const q = structuredClone(p);
    q.outputs[0].valueGrains = "600000001";
    assert.notEqual(dig({ ...q, hashType: 0x01 }), dig({ ...p, hashType: 0x01 }));
    assert.equal(dig({ ...q, hashType: 0x02 }), dig({ ...p, hashType: 0x02 }));
  });
  it("tampering another input's amount changes ALL but not ANYONECANPAY", () => {
    const q = structuredClone(p);
    q.inputs[1].valueGrains = "250000001";
    assert.notEqual(dig({ ...q, hashType: 0x01 }), dig({ ...p, hashType: 0x01 }));
    assert.equal(dig({ ...q, hashType: 0x81 }), dig({ ...p, hashType: 0x81 }));
  });
  it("tampering the annex changes the digest only when the annex is present", () => {
    const withAnnex = { ...p, annex: "50" + "11".repeat(10) };
    const tampered = { ...p, annex: "50" + "22".repeat(10) };
    assert.notEqual(dig(withAnnex), dig(tampered));
    const rec = tapSighashAnatomy(withAnnex).intermediates.find((x) => x.id === "sha_annex");
    assert.ok(rec.present);
    // sha_annex commits to (compact_size(len) || annex): length prefix is hashed
    assert.equal(rec.preimageHex.slice(0, 2), "0b"); // 11-byte annex -> compact size 0x0b
    assert.ok(!tapSighashAnatomy(p).intermediates.find((x) => x.id === "sha_annex").present);
  });
  it("annex flips spend_type's low bit", () => {
    assert.equal(tapSighashAnatomy(p).spendType, 0);
    assert.equal(tapSighashAnatomy({ ...p, annex: "50" }).spendType, 1);
    assert.equal(tapSighashAnatomy({ ...p, spend: { scriptPath: true, leafScript: "ac" } }).spendType, 2);
    assert.equal(tapSighashAnatomy({ ...p, spend: { scriptPath: true, leafScript: "ac" }, annex: "50" }).spendType, 3);
  });
});

describe("cross-implementation check vs audited sign/crypto.js", () => {
  it("DEFAULT and SINGLE|ANYONECANPAY digests match the Pearl-consensus-verified implementation", async () => {
    const { keypathSigDigestEx } = await import("../../sign/src/crypto.js");
    const network = { txVersion: 1 };
    const p = demoScenario();
    // keypathSigDigestEx applies ONE sequence to every input — use a uniform scenario
    const seq = 0xfffffffe;
    const mine = { ...p, version: 1, inputIndex: 0,
      inputs: p.inputs.map((i) => ({ ...i, sequence: seq })) };
    const theirs = {
      inputs: mine.inputs.map((i) => ({ txid: i.txid, vout: i.vout, value: Number(i.valueGrains), spk: hexToBytes(i.spk) })),
      outputs: mine.outputs.map((o) => ({ program: hexToBytes(o.spk.slice(4)), value: Number(o.valueGrains) })),
    };
    for (const ht of [0x00, 0x83]) {
      const a = tapSighashAnatomy({ ...mine, hashType: ht }).digestHex;
      const b = bytesToHex(keypathSigDigestEx(network, theirs.inputs, theirs.outputs, seq, 0, ht));
      assert.equal(a, b, `hash_type 0x${ht.toString(16)}`);
    }
  });
});

describe("script-path extension (structural)", () => {
  const leafScript = "20" + "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798" + "ac"; // <key> OP_CHECKSIG
  const p = { ...demoScenario(), spend: { scriptPath: true, leafScript } };
  it("tapleaf_hash = taggedHash('TapLeaf', 0xc0 || len || script)", () => {
    const a = tapSighashAnatomy(p);
    const rec = a.intermediates.find((x) => x.id === "tapleaf_hash");
    const want = taggedHash("TapLeaf", concat(Uint8Array.of(0xc0), varint(leafScript.length / 2), hexToBytes(leafScript)));
    assert.equal(rec.valueHex, bytesToHex(want));
    assert.ok(rec.present);
  });
  it("script-path preimage extends the key-path preimage: same prefix, spend_type 0x02, ext appended", () => {
    const key = tapSighashAnatomy(demoScenario());
    const scr = tapSighashAnatomy(p);
    // same bytes up to and including nLockTime + input hashes + sha_outputs
    assert.ok(scr.preimageHex.startsWith(key.preimageHex.slice(0, 2 * (10 + 128 + 32))));
    assert.equal(scr.spendType, 2);
    assert.ok(scr.digestHex !== key.digestHex);
  });
  it("codeseed position is committed (default 0xffffffff)", () => {
    const a = tapSighashAnatomy(p).intermediates.find((x) => x.id === "ext");
    assert.ok(a.preimageHex.endsWith("ffffffff"));
    const b = tapSighashAnatomy({ ...demoScenario(), spend: { scriptPath: true, leafScript, codeseedPos: 7 } });
    assert.notEqual(a.valueHex, b.intermediates.find((x) => x.id === "ext").valueHex);
  });
});

describe("sealed descriptors", () => {
  it("seal -> verifySealed returns PROVEN with matching digest", () => {
    const s = sealScenario(demoScenario());
    const v = verifySealed(s.sealed);
    assert.equal(v.verdict, "PROVEN");
    assert.equal(v.digest, s.digest);
    assert.ok(s.fingerprint);
    assert.ok(v.checks.every((c) => c.ok), "all sub-checks pass");
    assert.deepEqual(v.checks.map((c) => c.name), [
      "seal domain pearl-sighash:v1",
      "fingerprint binds all parameters",
      "sealed digest matches recomputation",
    ]);
  });
  it("tampered digest -> NOT PROVEN, loud", () => {
    const s = sealScenario(demoScenario());
    const obj = JSON.parse(s.sealed);
    obj.digest = "00".repeat(32);
    const v = verifySealed(JSON.stringify(obj));
    assert.equal(v.verdict, "NOT PROVEN");
    assert.ok(v.errors.some((e) => /tampered/i.test(e)));
  });
  it("tampered parameter -> NOT PROVEN (fingerprint mismatch)", () => {
    const s = sealScenario(demoScenario());
    const obj = JSON.parse(s.sealed);
    obj.outputs[0].valueGrains = "1";
    const v = verifySealed(JSON.stringify(obj));
    assert.equal(v.verdict, "NOT PROVEN");
    assert.ok(v.errors.length > 0);
  });
  it("raw parameter set -> UNSEALED with recomputed digest", () => {
    const v = verifySealed(JSON.stringify(demoScenario()));
    assert.equal(v.verdict, "UNSEALED");
    assert.ok(v.digest);
  });
  it("garbage -> NOT PROVEN", () => {
    assert.equal(verifySealed("not json").verdict, "NOT PROVEN");
  });
});

describe("helpers", () => {
  it("grainsToPRL formats 8 decimals", () => {
    assert.equal(grainsToPRL(100000000n), "1.00000000");
    assert.equal(grainsToPRL(149990000n), "1.49990000");
  });
  it("p2trSpk builds a 34-byte scriptPubKey (35 with varint prefix)", () => {
    const s = p2trSpk("ab".repeat(32));
    assert.equal(s.length, 68);
    assert.ok(s.startsWith("5120"));
  });
  it("demoScenario is a 2-in/2-out keypath DEFAULT scenario", () => {
    const d = demoScenario();
    assert.equal(d.inputs.length, 2);
    assert.equal(d.outputs.length, 2);
    assert.equal(d.hashType, 0x00);
  });
});
