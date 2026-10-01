// Pearl Policy core unit tests — run:
//   node --no-warnings --loader ./tests/loader.mjs tests/policy.test.mjs
// Asserts: leaf templates byte-equal to audited lineage, pinned descriptor /
// address / control block / tweak vectors, descriptor round-trip, tamper
// cases fail loudly, internal-key sources behave.
import test from "node:test";
import assert from "node:assert/strict";
import {
  forgePolicy, policyFromDescriptor, verifyPolicy, policyDescriptor,
  templateKeylock, templateTimelock, templateMultisig,
  numsInternalKeyPolicy, bip86InternalKey, taptreeN,
  verifyPolicyControlBlock, sealedCommitment, shareUrl,
  exportJson, exportMarkdown, parseLeafSpec,
  buildAwardScript, buildRefundScript, buildMultisigScript, sortKeys,
  parseXOnlyKey, bytesToHex, hexToBytes, decodeBech32m,
  NETWORKS, walletFromMnemonic, newMnemonic,
  DESCRIPTOR_PREFIX, MAX_LEAVES,
} from "../src/policy-core.js";

const K1 = "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
const K2 = "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9";
const K3 = "8200cf0ce11447bf6353cbac964d07d1c390d61d07e6c5d0214450b3add6449b";

const PIN_DESCRIPTOR =
  "pearl-policy:v1:prl:nums:" +
  "k:c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5;" +
  "t:900000:f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9;" +
  "m:2of3:8200cf0ce11447bf6353cbac964d07d1c390d61d07e6c5d0214450b3add6449b:" +
  "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5:" +
  "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9";
const PIN_ADDRESS = "prl1p80pyvs0jh82hdl3zf7zq3gcvmlfv2qutfm9yhszam2nd44c8qsysnfqxjm";
const PIN_SEALED = "pearl-policy:v1:prl:c72f8c4927a9d8a5d3bf1413176ac98c5678e80ea84d49601eea130b9dae2f07";
const PIN_INTERNAL = "c52d1a9db0fe231f32bed2cd1d9fdc085de4ff33c2d041c6f9494f1294700d10";
const PIN_ROOT = "718175c0e420955492ae0ba03821e577b06172243e07bb7c26eb95d4cc0d7063";
const PIN_TWEAK = "18f0942e8748aadac46c5d4d0c2294e740cf792c895cd65c2144831d87ceb095";
const PIN_LEAF_HASHES = [
  "390b139a9b6ab60840a1e766504bc79feb9a3cf61dafb50dcd842e5b1909d218", // multisig
  "ab11b8ce98a88b0dccf33a8144f90266dd8228b9fec6fa0cc0f7d4c0a28b8977", // keylock
  "f28e4863f2f0f71ee27f4580b8e361af3d73f80a8635efdfeee83db98d86b521", // timelock
];
const PIN_CONTROL_BLOCKS = [
  "c0c52d1a9db0fe231f32bed2cd1d9fdc085de4ff33c2d041c6f9494f1294700d10ab11b8ce98a88b0dccf33a8144f90266dd8228b9fec6fa0cc0f7d4c0a28b8977f28e4863f2f0f71ee27f4580b8e361af3d73f80a8635efdfeee83db98d86b521",
  "c0c52d1a9db0fe231f32bed2cd1d9fdc085de4ff33c2d041c6f9494f1294700d10" +
  "390b139a9b6ab60840a1e766504bc79feb9a3cf61dafb50dcd842e5b1909d218" +
  "f28e4863f2f0f71ee27f4580b8e361af3d73f80a8635efdfeee83db98d86b521",
  "c0c52d1a9db0fe231f32bed2cd1d9fdc085de4ff33c2d041c6f9494f1294700d10" +
  "f2ae3aa220b9cfa62f8d5499a112a33f041792257feeb711583f1ee6bacfc30c",
];

const pinInputs = () => ({
  network: NETWORKS.mainnet,
  internalSource: { mode: "nums" },
  leafInputs: [
    { kind: "keylock", xonly: K1 },
    { kind: "timelock", xonly: K2, height: 900000 },
    { kind: "multisig", m: 2, keys: [K1, K2, K3] },
  ],
});

/* ---- lineage byte-equality ---- */

test("keylock leaf is byte-identical to the audited Pearl Bounty award leaf", () => {
  const ours = templateKeylock(K1);
  const audited = buildAwardScript(parseXOnlyKey(K1));
  assert.deepEqual(bytesToHex(ours), bytesToHex(audited));
  assert.equal(bytesToHex(ours).slice(-2), "ac"); // OP_CHECKSIG
});

test("timelock leaf is byte-identical to the audited Pearl Escrow refund leaf", () => {
  const ours = templateTimelock(K2, 900000);
  const audited = buildRefundScript(parseXOnlyKey(K2), 900000);
  assert.deepEqual(bytesToHex(ours), bytesToHex(audited));
});

test("multisig leaf matches the audited Pearl Covenant multisig script pattern", () => {
  const keys = [K1, K2, K3];
  const ours = templateMultisig(keys, 2);
  const audited = buildMultisigScript(sortKeys(keys.map(parseXOnlyKey)), 2);
  assert.deepEqual(bytesToHex(ours), bytesToHex(audited));
  assert.ok(bytesToHex(ours).startsWith("00")); // <0> CHECKSIGADD pattern
});

/* ---- pinned vector ---- */

test("pinned 3-leaf vector: descriptor, sealed, address, NUMS key, root, tweak", () => {
  const bp = forgePolicy(pinInputs());
  assert.equal(bp.descriptor, PIN_DESCRIPTOR);
  assert.equal(bp.sealed, PIN_SEALED);
  assert.equal(bp.address, PIN_ADDRESS);
  assert.equal(bytesToHex(bp.internalXOnly), PIN_INTERNAL);
  assert.equal(bytesToHex(bp.root), PIN_ROOT);
  assert.equal(bytesToHex(bp.tweak), PIN_TWEAK);
});

test("pinned leaf hashes and control blocks (spend-ready for Pearl Sign)", () => {
  const bp = forgePolicy(pinInputs());
  assert.equal(bp.leaves.length, 3);
  bp.leaves.forEach((l, i) => {
    assert.equal(l.leafHash, PIN_LEAF_HASHES[i]);
    assert.equal(l.controlBlock, PIN_CONTROL_BLOCKS[i]);
    assert.equal(l.controlValid, true);
    // control block layout: 0xc0|parity || internal key || sibling path
    assert.equal(l.controlBlock.slice(0, 2), "c0");
    assert.equal(l.controlBlock.slice(2, 66), PIN_INTERNAL);
  });
  // every control block re-verifies against the tweaked key
  for (const l of bp.leaves) {
    assert.ok(verifyPolicyControlBlock(bp.internalXOnly, l.script, hexToBytes(l.controlBlock), bp.tweakedX));
  }
});

test("address decodes as a canonical bech32m v1 32-byte program on prl", () => {
  const bp = forgePolicy(pinInputs());
  const dec = decodeBech32m(bp.address);
  assert.equal(dec.hrp, "prl");
  assert.equal(dec.version, 1);
  assert.deepEqual(bytesToHex(dec.program), bytesToHex(bp.tweakedX));
});

test("sealed commitment is sha256 of the descriptor", () => {
  assert.equal(sealedCommitment(PIN_DESCRIPTOR), PIN_SEALED);
  assert.equal(sealedCommitment(PIN_DESCRIPTOR).split(":").length, 4);
});

/* ---- internal key sources ---- */

test("NUMS internal key is deterministic and pinned", () => {
  const bp = forgePolicy(pinInputs());
  assert.equal(bytesToHex(numsInternalKeyPolicy(bp.leaves.map((l) => l.script))), PIN_INTERNAL);
});

test("BIP-86 internal key derives the wallet's own key (spendable keypath)", () => {
  const mnemonic = newMnemonic();
  const w = walletFromMnemonic(mnemonic, NETWORKS.mainnet, 86, 0);
  const k = bip86InternalKey(mnemonic, NETWORKS.mainnet);
  assert.deepEqual(bytesToHex(k.xonly), bytesToHex(w.internalXOnly));
  const bp = forgePolicy({
    network: NETWORKS.mainnet,
    internalSource: { mode: "bip86", mnemonic },
    leafInputs: [{ kind: "keylock", xonly: K1 }],
  });
  assert.ok(bp.descriptor.includes(":bip86:"));
  assert.deepEqual(bytesToHex(bp.internalXOnly), bytesToHex(w.internalXOnly));
});

test("pasted internal key accepts a prl address too", () => {
  const w = walletFromMnemonic(newMnemonic(), NETWORKS.mainnet, 86, 1);
  const program = decodeBech32m(w.address).program; // the address's tweaked key
  const bp = forgePolicy({
    network: NETWORKS.mainnet,
    internalSource: { mode: "key", xonly: w.address },
    leafInputs: [{ kind: "keylock", xonly: K1 }],
  });
  assert.deepEqual(bytesToHex(bp.internalXOnly), bytesToHex(program));
  assert.ok(bp.descriptor.includes(`key:${bytesToHex(program)}`));
});

/* ---- tree shape ---- */

test("1-leaf tree: 33-byte control block, zero siblings", () => {
  const bp = forgePolicy({
    network: NETWORKS.mainnet,
    internalSource: { mode: "nums" },
    leafInputs: [{ kind: "keylock", xonly: K1 }],
  });
  assert.equal(bp.leaves.length, 1);
  assert.equal(bp.leaves[0].controlBlock.length, 66); // 33 bytes hex
  assert.equal(bp.leaves[0].depth, 0);
  assert.ok(bp.leaves[0].controlValid);
});

test("8-leaf tree works; 9 leaves are refused", () => {
  const eight = Array.from({ length: 8 }, (_, i) => ({
    kind: "custom",
    hex: "51" + i.toString(16).padStart(2, "0") + "ac", // 8 distinct scripts
  }));
  const bp = forgePolicy({ network: NETWORKS.mainnet, internalSource: { mode: "nums" }, leafInputs: eight });
  assert.equal(bp.leaves.length, 8);
  for (const l of bp.leaves) assert.ok(l.controlValid);
  assert.throws(() =>
    forgePolicy({
      network: NETWORKS.mainnet,
      internalSource: { mode: "nums" },
      leafInputs: [...eight, { kind: "custom", hex: "51ac" }],
    }),
    /need 1\.\.8 leaves/
  );
});

test("custom expert script round-trips through the descriptor", () => {
  const bp = forgePolicy({
    network: NETWORKS.testnet,
    internalSource: { mode: "nums" },
    leafInputs: [{ kind: "custom", hex: "522103" + K1 + "52ae" }],
  });
  assert.ok(bp.descriptor.startsWith("pearl-policy:v1:tprl:nums:x:"));
  const back = policyFromDescriptor(bp.descriptor);
  assert.equal(back.address, bp.address);
});

/* ---- tamper cases (verifier must fail loudly) ---- */

test("verifier: pinned descriptor + address + sealed -> PROVEN", () => {
  const r = verifyPolicy(PIN_DESCRIPTOR, PIN_ADDRESS, PIN_SEALED);
  assert.equal(r.proven, true);
});

test("verifier: one flipped leaf hex -> NOT PROVEN (invalid key is caught loudly)", () => {
  const tampered = PIN_DESCRIPTOR.replace(K1, K1.slice(0, -1) + (K1.endsWith("5") ? "6" : "5"));
  assert.notEqual(tampered, PIN_DESCRIPTOR);
  const r = verifyPolicy(tampered, PIN_ADDRESS);
  assert.equal(r.proven, false);
  assert.ok(typeof r.reason === "string" && r.reason.length > 0);
});

test("verifier: one leaf key swapped for another valid key -> NOT PROVEN (address mismatch)", () => {
  const tampered = PIN_DESCRIPTOR.replace("k:" + K1, "k:" + K3);
  const r = verifyPolicy(tampered, PIN_ADDRESS);
  assert.equal(r.proven, false);
  assert.ok(/mismatch/i.test(r.reason));
});

test("verifier: height tamper moves the address -> NOT PROVEN", () => {
  const tampered = PIN_DESCRIPTOR.replace("t:900000:", "t:900001:");
  const r = verifyPolicy(tampered, PIN_ADDRESS);
  assert.equal(r.proven, false);
});

test("verifier: wrong claimed address -> NOT PROVEN", () => {
  const bp = forgePolicy(pinInputs());
  const other = forgePolicy({
    network: NETWORKS.mainnet,
    internalSource: { mode: "nums" },
    leafInputs: [{ kind: "keylock", xonly: K3 }],
  });
  const r = verifyPolicy(PIN_DESCRIPTOR, other.address);
  assert.equal(r.proven, false);
  assert.ok(/mismatch/i.test(r.reason));
  assert.equal(r.recomputedAddress, bp.address);
});

test("verifier: wrong sealed commitment -> NOT PROVEN", () => {
  const r = verifyPolicy(PIN_DESCRIPTOR, PIN_ADDRESS, "pearl-policy:v1:prl:" + "0".repeat(64));
  assert.equal(r.proven, false);
  assert.ok(/sealed/i.test(r.reason));
});

test("verifier: garbage descriptor -> NOT PROVEN, never throws", () => {
  for (const bad of ["", "pearl-hedge:v1:prl:x", "pearl-policy:v1:xxx:nums:k:" + K1, PIN_DESCRIPTOR + ";"]) {
    const r = verifyPolicy(bad, PIN_ADDRESS);
    assert.equal(r.proven, false, bad.slice(0, 40));
  }
});

test("verifier: bip86 descriptor without mnemonic cannot recompute -> NOT PROVEN", () => {
  const mnemonic = newMnemonic();
  const bp = forgePolicy({
    network: NETWORKS.mainnet,
    internalSource: { mode: "bip86", mnemonic },
    leafInputs: [{ kind: "keylock", xonly: K1 }],
  });
  const r = verifyPolicy(bp.descriptor, bp.address);
  assert.equal(r.proven, false);
  assert.ok(/mnemonic/i.test(r.reason));
});

/* ---- forge refusals ---- */

test("forge refuses: empty leaves, duplicate leaves, bad height, bad m, bad custom hex", () => {
  const net = NETWORKS.mainnet, isrc = { mode: "nums" };
  assert.throws(() => forgePolicy({ network: net, internalSource: isrc, leafInputs: [] }), /need 1\.\.8/);
  assert.throws(
    () => forgePolicy({ network: net, internalSource: isrc, leafInputs: [{ kind: "keylock", xonly: K1 }, { kind: "keylock", xonly: K1 }] }),
    /duplicate/
  );
  assert.throws(() => forgePolicy({ network: net, internalSource: isrc, leafInputs: [{ kind: "timelock", xonly: K1, height: 0 }] }), /height/);
  assert.throws(() => forgePolicy({ network: net, internalSource: isrc, leafInputs: [{ kind: "timelock", xonly: K1, height: 500000000 }] }), /height/);
  assert.throws(() => forgePolicy({ network: net, internalSource: isrc, leafInputs: [{ kind: "multisig", m: 3, keys: [K1, K2] }] }), /m must/);
  assert.throws(() => forgePolicy({ network: net, internalSource: isrc, leafInputs: [{ kind: "custom", hex: "zz" }] }), /hex/);
  assert.throws(() => forgePolicy({ network: net, internalSource: { mode: "nope" }, leafInputs: [{ kind: "keylock", xonly: K1 }] }), /mode/);
});

test("leaf spec parser: strict formats", () => {
  assert.throws(() => parseLeafSpec("k:abc"), /64-hex/);
  assert.throws(() => parseLeafSpec("t:0:" + K1), /timelock/);
  assert.throws(() => parseLeafSpec("m:2of3:" + K1), /3 keys but has 1/);
  assert.throws(() => parseLeafSpec("q:" + K1), /unknown leaf kind/);
  assert.equal(parseLeafSpec("k:" + K1).kind, "keylock");
});

test("descriptor prefix constant", () => {
  assert.equal(DESCRIPTOR_PREFIX, "pearl-policy:v1");
  assert.ok(PIN_DESCRIPTOR.startsWith(DESCRIPTOR_PREFIX + ":prl:nums:"));
});

/* ---- export ---- */

test("export JSON and markdown carry the blueprint honestly", () => {
  const bp = forgePolicy(pinInputs());
  const j = JSON.parse(exportJson(bp));
  assert.equal(j.descriptor, PIN_DESCRIPTOR);
  assert.equal(j.address, PIN_ADDRESS);
  assert.equal(j.leaves.length, 3);
  assert.ok(j.honestLimits.length >= 1);
  const md = exportMarkdown(bp);
  assert.ok(md.includes(PIN_ADDRESS) && md.includes(PIN_DESCRIPTOR) && md.includes("## Honest limits"));
});
