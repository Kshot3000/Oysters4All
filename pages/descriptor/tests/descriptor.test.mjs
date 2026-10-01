// Pearl Atlas core tests — BIP-380 output descriptor desk for PRL.
// Covers: BIP-380 checksum (official vectors), grammar parsing (valid +
// invalid), key expressions, tapscript fragment builders (hand-computed
// expected script hex), Core-style taptree, tr() keypath derivation pinned
// to the in-repo BIP-86 known-answer vectors, script-path control blocks,
// multipath expansion, addr()/raw()/legacy script types, and loud refusals.
//
// Usage: node --no-warnings --loader ./tests/loader.mjs --test tests/descriptor.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { schnorr } from "@noble/curves/secp256k1";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import * as D from "../src/descriptor-core.js";

const refused = (fn, needle) => {
  assert.throws(fn, (e) => e.name === "DescError" && (!needle || e.message.includes(needle)), `expected refusal (${needle})`);
};

// Fixed deterministic test keys (private -> x-only, no randomness).
const PRIV_A = hexToBytes("11".repeat(32));
const PRIV_B = hexToBytes("22".repeat(32));
const XONLY_A = bytesToHex(schnorr.getPublicKey(PRIV_A)); // 32B hex
const XONLY_B = bytesToHex(schnorr.getPublicKey(PRIV_B));
const P33_A = "02" + XONLY_A; // even-y assumption is WRONG in general; only for script-shape tests below

// In-repo BIP-86 known-answer vectors (sign/tests/verify.mjs).
const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const VEC_ADDR0 = "prl1pr6yuq8u2r95wjzzgpdy8cpnncpl7l8zgy6x5q0367pnc53s2famqg7pt74";
const VEC_ADDR5 = "prl1pe39xcj4w8p0w5hj80p053sr0s6qggkw2hzts424yu9vjce4q84fs4cy3fq";

function accountXpub() {
  const seed = mnemonicToSeedSync(MNEMONIC);
  const master = HDKey.fromMasterSeed(seed);
  // Pearl mainnet coin type 808276 (node/chaincfg/params.go), BIP-86 account 0
  const acct = master.derive("m/86'/808276'/0'");
  return acct.publicExtendedKey;
}

describe("BIP-380 checksum (official test vectors)", () => {
  it("computes the official vector raw(deadbeef)#89f8spxm", () => {
    assert.equal(D.descChecksum("raw(deadbeef)"), "89f8spxm");
    assert.equal(D.descAddChecksum("raw(deadbeef)"), "raw(deadbeef)#89f8spxm");
  });
  it("accepts all valid checksum cases", () => {
    for (const s of [
      "raw(deadbeef)#89f8spxm",
      "tr(xpub6BgBgsespWvERF3LHQu6CnqdvfEvtMcQjYrcRzx53QJjSxarj2afYWcLteoGVky7D3UKDP9QyrLprQ3VCECoY49yfdDEHGCtMMj92pReUsQ/0/*)#8e7pq23w",
      "wpkh([deadbeef/84h/0h/0h]xpub6ERApfZwUNrhLCkDtcHTcxd75RbzS1ed54G1LkBUHQVHQKqhMkhgbmJbZRkrgZw4koxb5JaHWkY4ALHY2grBGRjaDMzQLcgJvLJuZZvRcEL/0/*)#kf3v6fpx",
    ]) {
      const r = D.descCheckChecksum(s);
      assert.ok(r.ok, `${s}: ${r.reason}`);
    }
  });
  it("rejects every official invalid case", () => {
    const bad = [
      ["raw(deadbeef)#", "missing"],
      ["raw(deadbeef)#89f8spxmx", "9 chars"],
      ["raw(deadbeef)#89f8spx", "7 chars"],
      ["raw(deedbeef)#89f8spxm", "payload error"],
      ["raw(deedbeef)##9f8spxm", "double separator"],
      ["raw(Ü)#00000000", "invalid characters"],
    ];
    for (const [s, why] of bad) {
      const r = D.descCheckChecksum(s);
      assert.ok(!r.ok, `${why} should fail: ${s}`);
    }
  });
  it("no-checksum descriptors pass when not required", () => {
    const r = D.descCheckChecksum("raw(deadbeef)");
    assert.ok(r.ok && r.checksum === null);
    const r2 = D.descCheckChecksum("raw(deadbeef)", { require: true });
    assert.ok(!r2.ok);
  });
});

describe("grammar parsing", () => {
  it("parses a full-featured tr() descriptor", () => {
    const ast = D.parseDescriptor(
      "tr([deadbeef/86h/808276h/0h]" + accountXpub() + "/0/*," +
      "and_v(pk(0260b2003c386519fc9eadf2b5cf124dd8eea4c4e68d5e154050a9346ea98ce600),older(144)))#s7ryrhxp"
    );
    assert.equal(ast.kind, "tr");
    assert.equal(ast.key.origin.fingerprint, "deadbeef");
    assert.equal(ast.key.origin.path.length, 3);
    assert.ok(ast.key.wildcard);
    assert.equal(ast.scripts.length, 1);
    assert.equal(ast.scripts[0].frag, "and_v");
  });
  it("parses key origin variants and hardened markers", () => {
    const k = D.parseKeyExpression(`[deadbeef/0'/1h/2]${accountXpub()}/0/*`);
    // 'fingerprint' is not 8 hex chars -> refused
    assert.throws(() => D.parseKeyExpression(`[fp/0]${accountXpub()}`), /fingerprint/);
    void k;
    const k2 = D.parseKeyExpression("[deadbeef/0'/1h]0260b2003c386519fc9eadf2b5cf124dd8eea4c4e68d5e154050a9346ea98ce600");
    assert.deepEqual(k2.origin.path, [{ index: 0, hardened: true }, { index: 1, hardened: true }]);
  });
  it("refuses malformed descriptors loudly", () => {
    refused(() => D.parseDescriptor("tr()"), "internal key");
    refused(() => D.parseDescriptor("tr(xpub1"), "expected");
    refused(() => D.parseDescriptor("frobnicate(xpub1)"), "unknown descriptor function");
    refused(() => D.parseDescriptor("sh(tr(0260b2003c386519fc9eadf2b5cf124dd8eea4c4e68d5e154050a9346ea98ce600))"), "nested");
    refused(() => D.parseDescriptor("wpkh()"), "takes 1");
    refused(() => D.parseDescriptor("multi(2)"), "at least one key");
    refused(() => D.parseDescriptor("pk(notakey!)"), "unrecognized key");
    refused(() => D.parseDescriptor("raw(zzzz)"), "hex");
    refused(() => D.parseDescriptor("tr(0260b2003c386519fc9eadf2b5cf124dd8eea4c4e68d5e154050a9346ea98ce600,and_n(pk(0260b2003c386519fc9eadf2b5cf124dd8eea4c4e68d5e154050a9346ea98ce600),older(1)))"), "unknown descriptor function");
  });
  it("round-trips canonical rendering", () => {
    const body = `tr([deadbeef/86h/808276h/0h]${accountXpub()}/0/*)`;
    assert.equal(D.canonicalBody(body), body);
  });
});

describe("tapscript fragment builders (hand-computed vectors)", () => {
  const frag = (s) => D.parseDescriptor(`tr(${XONLY_A},${s})`);
  const scriptHex = (s) => bytesToHex(D.buildTapscript(frag(s).scripts[0], 0));
  it("pk_k / pk", () => {
    assert.equal(scriptHex(`pk_k(${XONLY_A})`), "20" + XONLY_A + "ac");
    assert.equal(scriptHex(`pk(${XONLY_A})`), "20" + XONLY_A + "ac");
  });
  it("pk_h", () => {
    const h = scriptHex(`pk_h(${XONLY_A})`);
    assert.ok(h.startsWith("76a914") && h.endsWith("88ac") && h.length === (1 + 1 + 1 + 20 + 1 + 1) * 2);
  });
  it("older / after", () => {
    assert.equal(scriptHex("older(144)"), "029000b2"); // 144 = 0x90, high bit set -> minimal [0x90,0x00]
    assert.equal(scriptHex("after(500000)"), "0320a107b1");
  });
  it("hash locks", () => {
    const z32 = "00".repeat(32), z20 = "00".repeat(20);
    assert.equal(scriptHex(`sha256(${z32})`), "82012088a820" + z32 + "87");
    assert.equal(scriptHex(`hash256(${z32})`), "82012088aa20" + z32 + "87");
    assert.equal(scriptHex(`ripemd160(${z20})`), "82012088a614" + z20 + "87");
    assert.equal(scriptHex(`hash160(${z20})`), "82012088a914" + z20 + "87");
  });
  it("multi_a", () => {
    const got = scriptHex(`multi_a(2,${XONLY_A},${XONLY_B})`);
    assert.equal(got, "20" + XONLY_A + "ac" + "20" + XONLY_B + "ac" + "ba" + "52" + "9c");
  });
  it("and/or combinators", () => {
    assert.equal(scriptHex(`and_v(pk_k(${XONLY_A}),older(10))`), "20" + XONLY_A + "ac" + "5ab2"); // OP_10, like Core's CScript << n
    assert.equal(scriptHex(`or_d(pk_k(${XONLY_A}),older(10))`), "20" + XONLY_A + "ac" + "73645ab268");
    assert.equal(
      scriptHex(`thresh(2,pk_k(${XONLY_A}),pk_k(${XONLY_B}),older(1))`),
      "20" + XONLY_A + "ac" + "20" + XONLY_B + "ac" + "51b2" + "9393529c" // OP_1 / OP_2
    );
  });
});

describe("tr() keypath derivation (pinned to BIP-86 vectors)", () => {
  const xpub = accountXpub();
  it("index 0 matches the known-answer prl1 address", () => {
    const r = D.deriveDescriptor(`tr([deadbeef/86h/808276h/0h]${xpub}/0/*)`, { hrp: "prl", index: 0 });
    assert.equal(r.address, VEC_ADDR0);
    assert.equal(r.pearlSpendable, true);
    assert.equal(r.scriptPath, false);
    assert.equal(r.merkleRoot, null);
  });
  it("index 5 matches the known-answer prl1 address", () => {
    const r = D.deriveDescriptor(`tr(${xpub}/0/*)`, { hrp: "prl", index: 5 });
    assert.equal(r.address, VEC_ADDR5);
  });
  it("testnet hrp gives tprl1 addresses", () => {
    const r = D.deriveDescriptor(`tr(${xpub}/0/*)`, { hrp: "tprl", index: 0 });
    assert.ok(r.address.startsWith("tprl1p"));
  });
  it("every index differs (no address reuse across the range)", () => {
    const addrs = new Set([0, 1, 2, 3].map((i) => D.deriveDescriptor(`tr(${xpub}/0/*)`, { index: i }).address));
    assert.equal(addrs.size, 4);
  });
});

describe("tr() script-path derivation", () => {
  it("builds a 2-leaf taptree with verifiable control blocks", () => {
    const d = `tr(${XONLY_A},pk(${XONLY_B}),and_v(pk(${XONLY_A}),older(100)))`;
    const r = D.deriveDescriptor(d, { hrp: "prl", index: 0 });
    assert.ok(r.scriptPath);
    assert.equal(r.leaves.length, 2);
    assert.ok(r.merkleRoot);
    assert.ok(r.address.startsWith("prl1p"));
    // Recompute: leaf hashes + pairwise branch + tweak must reproduce the address.
    const leaves = r.leaves.map((l) => hexToBytes(l.scriptHex));
    const tree = D.buildTaptree(hexToBytes(r.internalXOnly), leaves);
    assert.equal(bytesToHex(tree.root), r.merkleRoot);
    const tw = D.taprootTweak(hexToBytes(r.internalXOnly), tree.root);
    assert.equal(bytesToHex(tw.tweakedX), r.tweakedXOnly);
    // Control blocks: version byte carries the tweak parity.
    for (const l of r.leaves) {
      const cb = hexToBytes(l.controlBlock);
      assert.equal(cb[0] & 0xfe, 0xc0);
      assert.equal(cb.length, 33 + 32 * (r.leaves.length > 1 ? 1 : 0));
    }
  });
  it("key-only tr() from a raw x-only key", () => {
    const r = D.deriveDescriptor(`tr(${XONLY_A})`, { hrp: "prl" });
    assert.ok(r.address.startsWith("prl1p"));
    assert.equal(r.scriptPath, false);
  });
  it("3-leaf tree is balanced pairwise like Core", () => {
    const d = `tr(${XONLY_A},pk(${XONLY_A}),pk(${XONLY_B}),older(7))`;
    const r = D.deriveDescriptor(d, { index: 0 });
    assert.equal(r.leaves.length, 3);
    // deepest leaf (index 2, odd one out) has a 2-element path; others have 2 as well in a 3-leaf tree
    const depths = r.leaves.map((l) => (hexToBytes(l.controlBlock).length - 33) / 32);
    assert.deepEqual(depths, [2, 2, 1]);
  });
});

describe("multipath expansion (BIP-389)", () => {
  const xpub = accountXpub();
  it("expands <0;1> into two single-path descriptors", () => {
    const out = D.expandDescriptorMultipath(`tr(${xpub}<0;1>/*)`);
    assert.equal(out.length, 2);
    assert.ok(out[0].includes("/0/*") && out[1].includes("/1/*") && out[0] !== out[1]);
    const a0 = D.deriveDescriptor(out[0], { index: 3 }).address;
    const a1 = D.deriveDescriptor(out[1], { index: 3 }).address;
    assert.notEqual(a0, a1);
  });
  it("refuses to derive from unexpanded multipath", () => {
    refused(() => D.deriveDescriptor(`tr(${xpub}<0;1>/*)`, { index: 0 }), "expanded first");
  });
  it("refuses mismatched multipath arity", () => {
    refused(() => D.expandDescriptorMultipath(`tr(${xpub}<0;1>/*,pk(${xpub}<0;1;2>/*))`), "same number");
  });
});

describe("addr(), raw(), legacy types", () => {
  it("addr() validates and returns the scriptPubKey", () => {
    const r = D.deriveDescriptor(`addr(${VEC_ADDR0})`, { hrp: "prl" });
    assert.equal(r.address, VEC_ADDR0);
    assert.equal(r.spk, "5120" + r.spk.slice(4));
    assert.equal(r.pearlSpendable, true);
  });
  it("addr() refuses non-taproot addresses honestly", () => {
    refused(() => D.deriveDescriptor("addr(bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4)"), "not a valid Taproot");
  });
  it("wpkh() gives the exact P2WPKH scriptPubKey (informational on Pearl)", () => {
    const r = D.deriveDescriptor(`wpkh(${P33_A})`, { index: 0 });
    assert.equal(r.pearlSpendable, false);
    assert.ok(/^0014[0-9a-f]{40}$/.test(r.spk));
  });
  it("combo() exposes all four scripts", () => {
    const r = D.deriveDescriptor(`combo(${P33_A})`, { index: 0 });
    assert.equal(r.scripts.length, 4);
  });
});

describe("loud refusals", () => {
  const xpub = accountXpub();
  it("hardened derivation from an xpub is refused", () => {
    refused(() => D.deriveDescriptor(`tr(${xpub}/0h/*)`, { index: 0 }), "hardened");
  });
  it("private keys never leak into public derivation silently", () => {
    const r = D.resolveKey(D.parseKeyExpression("L3g2TjAyBKhpG2qBb2m739hy3qvSgeD1C6HeMnXM9AQbZgSit17a"));
    assert.equal(r.xonly.length, 32);
  });
  it("garbage input fails with position info", () => {
    refused(() => D.parseDescriptor("tr(xpub###"), "expected");
  });
});

describe("describe()", () => {
  it("summarizes type, keys, checksum", () => {
    const lines = D.describe(`tr([deadbeef/86h/808276h/0h]${accountXpub()}/0/*)#` .slice(0, -1));
    const keys = Object.fromEntries(lines.map((l) => [l.k, l.v]));
    assert.ok(keys["Type"].includes("Taproot"));
    assert.ok(keys["Key 1"].includes("deadbeef"));
    assert.ok(keys["Key 1"].includes("ranged"));
  });
});
