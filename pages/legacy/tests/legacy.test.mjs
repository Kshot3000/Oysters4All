// Pearl Legacy core verification suite.
// Run: node --no-warnings --loader ./tests/loader.mjs tests/legacy.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  NETWORKS, DUST_GRAIN, GRAIN_PER_PRL,
  bytesToHex, hexToBytes, sha256, schnorr, tapLeafHash,
  buildHeartbeatScript, buildHeirScript,
  numsInternalKey, legacyTaptree, verifyLegacyControlBlock,
  checkInactivity, blocksToDays, pubkeyFromPriv,
  ownerPrivFromInput, heirKeyFromInput,
  planLegacy, legacyDescriptor, parseDescriptor, serializeVault, parseVaultSpec,
  verifyDescriptor, describeVault, legacyScriptAsm,
  claimSpendVBytes, buildHeirClaim,
  buildOwnerRefresh, buildMultiScriptPathSpend, multiScriptPathVBytes,
  vaultUtxoStatus,
  parseTx, parseXOnlyKey, addressToProgram,
  verifySchnorrSig, signForXOnly, scriptPathSigDigestEx, buildScriptPathSpend,
  spendVBytes, encodeScriptNum, decodeBech32m,
  walletFromMnemonic, walletToWIF,
  LEGACY_KIND, LEGACY_VERSION, PEARL_BLOCK_SECS,
  MIN_CSV_BLOCKS, MAX_CSV_BLOCKS, FINAL_SEQUENCE,
} from "../src/legacy-core.js";
import { bytesToNumberBE, numberToBytesBE } from "@noble/curves/abstract/utils";
import { secp256k1 } from "@noble/curves/secp256k1";

const net = NETWORKS.mainnet;

// Deterministic test keys: priv 1..6 (x-only keys derived, even-Y normalized).
function testKey(i) {
  const priv = numberToBytesBE(BigInt(i), 32);
  const P = secp256k1.ProjectivePoint.fromPrivateKey(priv);
  return { priv: bytesToHex(priv), xonly: bytesToHex(P.toRawBytes(true).slice(1)) };
}
const K = [1, 2, 3, 4, 5, 6].map(testKey);

function makeVault(over = {}) {
  const { vault } = planLegacy({
    network: net,
    ownerKeyInput: K[0].xonly,
    ownerKeyMode: "watch",
    heirKeyInput: K[1].xonly,
    n: 445, // ~1 day at 194 s/block
    ...over,
  });
  return vault;
}

test("heartbeat leaf is the exact expected byte vector", () => {
  const script = buildHeartbeatScript(K[0].xonly);
  // 20 <owner:32> ac
  const expect = "20" + K[0].xonly + "ac";
  assert.equal(bytesToHex(script), expect);
  assert.equal(script.length, 34);
  assert.equal(legacyScriptAsm(script),
    `<${K[0].xonly.slice(0, 12)}…32B> OP_CHECKSIG`);
  assert.throws(() => buildHeartbeatScript("zzzz"), /64 hex/);
});

test("heir leaf is the exact expected byte vector (n=445, n=65535)", () => {
  // encodeScriptNum(445) = bd 01 -> push "02bd01"; then b2 75, 20 <heir>, ac
  const script = buildHeirScript(K[1].xonly, 445);
  const expect = "02bd01" + "b2" + "75" + "20" + K[1].xonly + "ac";
  assert.equal(bytesToHex(script), expect);
  assert.equal(script.length, 39);
  const asm = legacyScriptAsm(script);
  assert.ok(asm.includes("<445>"), asm);
  assert.ok(asm.includes("OP_CHECKSEQUENCEVERIFY"), asm);
  assert.ok(asm.includes("OP_DROP"), asm);
  // n=1: minimal push
  assert.equal(bytesToHex(buildHeirScript(K[1].xonly, 1)).slice(0, 4), "0101");
  // n=65535: encodeScriptNum = ff ff 00 (3 bytes, sign bit) -> push "03ffff00"
  const big = buildHeirScript(K[1].xonly, 65535);
  assert.equal(bytesToHex(big).slice(0, 8), "03ffff00");
  assert.ok(legacyScriptAsm(big).includes("<65535>"));
  assert.throws(() => buildHeirScript(K[1].xonly, 0), /at least 1 block/);
  assert.throws(() => buildHeirScript(K[1].xonly, 65536), /16-bit limit/);
  assert.throws(() => buildHeirScript(K[1].xonly, -5), /at least 1 block/);
  assert.throws(() => checkInactivity(200000), /16-bit limit/);
});

test("NUMS internal key is deterministic, binds both leaves, is nobody's key", () => {
  const k1 = numsInternalKey(hexToBytes("aa".repeat(32)), hexToBytes("bb".repeat(32)));
  const k2 = numsInternalKey(hexToBytes("aa".repeat(32)), hexToBytes("bb".repeat(32)));
  assert.deepEqual(k1, k2); // deterministic
  const k3 = numsInternalKey(hexToBytes("bb".repeat(32)), hexToBytes("aa".repeat(32)));
  assert.notDeepEqual(k1, k3); // leaf order matters (canonical: heartbeat, heir)
  assert.notDeepEqual(k1, hexToBytes(K[0].xonly)); // not the owner
  assert.notDeepEqual(k1, hexToBytes(K[1].xonly)); // not the heir
  schnorr.utils.lift_x(bytesToNumberBE(k1)); // valid curve x
});

test("taptree: prl1p address, control blocks re-derive, tamper fails, no keypath bypass", () => {
  const vault = makeVault();
  assert.ok(vault.address.startsWith("prl1p"), vault.address);
  assert.equal(hexToBytes(vault.leafAControlBlockHex).length, 65);
  assert.equal(hexToBytes(vault.leafBControlBlockHex).length, 65);
  assert.notEqual(vault.leafAControlBlockHex, vault.leafBControlBlockHex);
  for (const [scriptHex, cbHex] of [
    [vault.leafAScriptHex, vault.leafAControlBlockHex],
    [vault.leafBScriptHex, vault.leafBControlBlockHex],
  ]) {
    assert.equal(verifyLegacyControlBlock(
      hexToBytes(vault.internalKeyHex), hexToBytes(scriptHex),
      hexToBytes(cbHex), hexToBytes(vault.tweakedHex)), true);
  }
  // tampered control block fails
  const bad = hexToBytes(vault.leafBControlBlockHex);
  bad[40] ^= 1;
  assert.equal(verifyLegacyControlBlock(
    hexToBytes(vault.internalKeyHex), hexToBytes(vault.leafBScriptHex), bad,
    hexToBytes(vault.tweakedHex)), false);
  // tampered leaf script fails
  const badScript = hexToBytes(vault.leafAScriptHex);
  badScript[10] ^= 1;
  assert.equal(verifyLegacyControlBlock(
    hexToBytes(vault.internalKeyHex), badScript,
    hexToBytes(vault.leafAControlBlockHex), hexToBytes(vault.tweakedHex)), false);
  // NO keypath bypass: internal key is NUMS-derived (nobody's key) and the
  // tweaked address equals an independent re-derivation of the NUMS tweak.
  const leafHashes = [vault.leafAScriptHex, vault.leafBScriptHex]
    .map((h) => tapLeafHash(hexToBytes(h)));
  const nums = numsInternalKey(leafHashes[0], leafHashes[1]);
  assert.deepEqual(nums, hexToBytes(vault.internalKeyHex));
  for (const k of K) assert.notDeepEqual(nums, hexToBytes(k.xonly));
  // the tweaked key is NOT lift_x of any known key — the address commits to
  // the tweak scalar, which is a hash preimage nobody knows
  assert.notEqual(vault.tweakedHex, vault.internalKeyHex);
});

test("determinism: identical network + owner + heir + n always yield the SAME vault address", () => {
  const a = makeVault();
  const b = makeVault();
  assert.equal(a.address, b.address);
  assert.equal(a.spkHex, b.spkHex);
  assert.equal(a.descriptor, b.descriptor);
  assert.equal(a.internalKeyHex, b.internalKeyHex);
  // ...so a different address requires changing a committed parameter or key
  const otherN = makeVault({ n: 446 });
  assert.notEqual(otherN.address, a.address);
  const otherHeir = makeVault({ heirKeyInput: K[2].xonly });
  assert.notEqual(otherHeir.address, a.address);
  const otherNet = planLegacy({
    network: NETWORKS.testnet, ownerKeyInput: K[0].xonly, ownerKeyMode: "watch",
    heirKeyInput: K[1].xonly, n: 445,
  }).vault;
  assert.notEqual(otherNet.address, a.address);
});

test("plan guards: n range, owner==heir, key modes, secrets stay in memory", () => {
  assert.throws(() => makeVault({ n: 0 }), /at least 1 block/);
  assert.throws(() => makeVault({ n: 65536 }), /16-bit limit/);
  assert.throws(() => makeVault({ heirKeyInput: K[0].xonly }), /must differ/);
  assert.throws(() => makeVault({ ownerKeyMode: "nope" }), /priv.*watch/);
  // watch mode -> no secrets
  const { secrets } = planLegacy({
    network: net, ownerKeyInput: K[0].xonly, ownerKeyMode: "watch",
    heirKeyInput: K[1].xonly, n: 445,
  });
  assert.deepEqual(secrets, []);
  // priv mode -> in-memory secret, never in the JSON
  const MN = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  const r = planLegacy({
    network: net, ownerKeyInput: MN, heirKeyInput: K[1].xonly, n: 445,
  });
  assert.equal(r.secrets.length, 1);
  assert.equal(r.secrets[0].role, "owner");
  assert.equal(pubkeyFromPriv(r.secrets[0].priv), r.vault.ownerXOnly);
  const json = serializeVault(r.vault);
  assert.ok(!json.includes(r.secrets[0].priv), "private key must never enter the JSON");
  assert.ok(!json.includes(MN), "mnemonic must never enter the JSON");
});

test("owner priv inputs: hex, WIF, mnemonic", () => {
  const MN = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  const w = walletFromMnemonic(MN, net);
  const hex = ownerPrivFromInput(bytesToHex(w.priv), net);
  assert.equal(bytesToHex(hex.internalXOnly), bytesToHex(w.internalXOnly));
  const mn = ownerPrivFromInput(MN, net);
  assert.equal(bytesToHex(mn.internalXOnly), bytesToHex(w.internalXOnly));
  const wf = ownerPrivFromInput(walletToWIF(w.priv, net), net);
  assert.equal(bytesToHex(wf.internalXOnly), bytesToHex(w.internalXOnly));
  assert.throws(() => ownerPrivFromInput("not a key", net), /owner key must be/);
});

test("heir identity: x-only pubkey or prl1p address", () => {
  const fromPub = heirKeyFromInput(K[1].xonly, net);
  assert.equal(fromPub.xonly, K[1].xonly);
  // derive a real prl1p address for K[1] and use it as the heir identity
  const { vault: kw } = planLegacy({
    network: net, ownerKeyInput: K[2].xonly, ownerKeyMode: "watch",
    heirKeyInput: K[1].xonly, n: 445,
  });
  const heirAddr = kw.address; // any prl1p works as an identity carrier
  const prog = decodeBech32m(heirAddr, "prl").program;
  const fromAddr = heirKeyFromInput(heirAddr, net);
  assert.equal(fromAddr.xonly, bytesToHex(prog));
  assert.ok(fromAddr.source.includes("prl1p address"));
  // wrong network refused
  const { vault: tw } = planLegacy({
    network: NETWORKS.testnet, ownerKeyInput: K[2].xonly, ownerKeyMode: "watch",
    heirKeyInput: K[1].xonly, n: 445,
  });
  assert.throws(() => heirKeyFromInput(tw.address, net), /not prl/);
  assert.throws(() => heirKeyFromInput("prl1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqnrql8a", net));
});

test("descriptor round-trips; tampering is caught loudly", () => {
  const vault = makeVault();
  const d = legacyDescriptor(vault);
  assert.equal(d, `legacy:v1:prl:${K[0].xonly}:${K[1].xonly}:445`);
  const pf = parseDescriptor(d);
  assert.deepEqual(pf, { hrp: "prl", ownerXOnly: K[0].xonly, heirXOnly: K[1].xonly, n: 445 });
  assert.throws(() => parseDescriptor("legacy:v1:prl:abc"), /bad legacy descriptor/);
  assert.throws(() => parseDescriptor("swap:v1:prl:x:y:1"), /bad legacy descriptor/);
  assert.throws(() => parseDescriptor(`legacy:v1:prl:${"zz".repeat(32)}:${K[1].xonly}:445`), /64 hex/);
  assert.throws(() => parseDescriptor(`legacy:v1:prl:${K[0].xonly}:${K[1].xonly}:445:0`), /bad legacy descriptor/); // no 7th field
  assert.throws(() => parseDescriptor(`legacy:v1:prl:${K[0].xonly}:${K[1].xonly}:-1`), /at least 1 block/);

  // verifyDescriptor recomputes the address + leaf hashes
  const v = verifyDescriptor(d, net, vault.address);
  assert.equal(v.vault.address, vault.address);
  assert.equal(v.leafAHash, bytesToHex(tapLeafHash(hexToBytes(vault.leafAScriptHex))));
  assert.equal(v.leafBHash, bytesToHex(tapLeafHash(hexToBytes(vault.leafBScriptHex))));
  assert.equal(v.recomputed, d);

  // A tampered descriptor (n 445 -> 446) is SELF-CONSISTENT — it describes a
  // different, valid vault. The verifier catches the tamper only against the
  // claimed address: recomputed != claimed -> LOUD REFUSAL.
  const evilN = d.replace(":445", ":446");
  assert.equal(verifyDescriptor(evilN, net).vault.n, 446); // valid, different vault
  assert.throws(() => verifyDescriptor(evilN, net, vault.address), /LOUD REFUSAL/);
  // tamper with the heir key
  const evilH = d.replace(K[1].xonly, K[2].xonly);
  assert.throws(() => verifyDescriptor(evilH, net, vault.address), /LOUD REFUSAL/);
  // tamper with the owner key
  const evilO = d.replace(K[0].xonly, K[3].xonly);
  assert.throws(() => verifyDescriptor(evilO, net, vault.address), /LOUD REFUSAL/);
  // wrong network
  assert.throws(() => verifyDescriptor(d, NETWORKS.testnet, vault.address), /LOUD REFUSAL/);
  // garbage
  assert.throws(() => verifyDescriptor("hello world", net), /bad legacy descriptor/);
});

test("vault JSON spec round-trips; tampering caught", () => {
  const vault = makeVault();
  const back = parseVaultSpec(serializeVault(vault), net);
  assert.equal(back.address, vault.address);
  assert.equal(back.descriptor, vault.descriptor);
  const evil = JSON.parse(serializeVault(vault));
  evil.n = 446;
  assert.throws(() => parseVaultSpec(JSON.stringify(evil), net), /tampered/);
  const evil2 = JSON.parse(serializeVault(vault));
  evil2.heirXOnly = K[2].xonly;
  assert.throws(() => parseVaultSpec(JSON.stringify(evil2), net), /tampered/);
  const evil3 = JSON.parse(serializeVault(vault));
  evil3.descriptor = evil3.descriptor.replace(":445", ":446");
  assert.throws(() => parseVaultSpec(JSON.stringify(evil3), net), /tampered/);
  assert.throws(() => parseVaultSpec("{nope", net), /not valid JSON/);
  assert.throws(() => parseVaultSpec(JSON.stringify({ kind: "nope" }), net), /not a Pearl Legacy/);
  assert.throws(() => parseVaultSpec(serializeVault(vault), NETWORKS.testnet), /not tprl/);
});

test("multiScriptPathVBytes == spendVBytes for single input; manual math check", () => {
  const vault = makeVault();
  const scriptLen = vault.leafBScriptHex.length / 2; // 39
  const single = spendVBytes({ nOut: 1, scriptLen, controlLen: 65, stackLens: [64] });
  const multi = multiScriptPathVBytes({
    nIn: 1, nOut: 1, perInput: [{ scriptLen, controlLen: 65, stackLens: [64] }],
  });
  assert.equal(multi, single);
  // hand-computed: base = 4 + 1 + 41 + 1 + 43 + 4 = 94;
  // witness = 1(count) + (1+64) + (1+39) + (1+65) = 172;
  // vBytes = ceil((94*3 + (94+2+172)) / 4) = ceil(550/4) = 138
  assert.equal(single, 138);
  // two inputs: base = 4 + 1 + 82 + 1 + 43 + 4 = 135; wit = 344;
  // vBytes = ceil((135*3 + (135+2+344)) / 4) = ceil(886/4) = 222 (221.5 -> 222)
  const two = multiScriptPathVBytes({
    nIn: 2, nOut: 1, perInput: [
      { scriptLen, controlLen: 65, stackLens: [64] },
      { scriptLen, controlLen: 65, stackLens: [64] },
    ],
  });
  assert.equal(two, 222);
});

test("buildMultiScriptPathSpend single-input == buildScriptPathSpend bytes", () => {
  const vault = makeVault();
  const leafA = hexToBytes(vault.leafAScriptHex);
  const cb = hexToBytes(vault.leafAControlBlockHex);
  const dest = walletFromMnemonic(
    "legal winner thank year wave sausage worth useful legal winner thank yellow", net);
  const input = { txid: "ab".repeat(32), vout: 0, value: 1e8, spk: hexToBytes(vault.spkHex) };
  const outputs = [{ program: addressToProgram(dest.address, net), value: 99999000 }];
  const digest = scriptPathSigDigestEx(net, input, outputs, leafA, { sequence: FINAL_SEQUENCE });
  const sig = signForXOnly(hexToBytes(K[0].priv), digest);
  const a = buildScriptPathSpend(net, input, outputs, leafA, cb, [sig], { sequence: FINAL_SEQUENCE });
  const b = buildMultiScriptPathSpend(net,
    [{ input, leafScript: leafA, controlBlock: cb, stackItems: [sig] }],
    outputs, { sequence: FINAL_SEQUENCE });
  assert.equal(b.hex, a.hex); // identical wire bytes
  assert.equal(b.txid, a.txid);
  assert.deepEqual(b.digests, [a.digest]);
  assert.equal(b.vBytes, a.vBytes);
});

test("heir claim: maturity guard, key guard, exact fee math, wire structure", () => {
  const vault = makeVault(); // n = 445
  const dest = walletFromMnemonic(
    "legal winner thank year wave sausage worth useful legal winner thank yellow", net);
  const utxo = { txid: "ab".repeat(32), vout: 0, value: GRAIN_PER_PRL };
  const base = {
    utxo, heirPrivHex: K[1].priv, destAddress: dest.address,
    feeRateGrainsPerVByte: 5, fundingHeight: 120000, currentHeight: 120445,
  };
  // one block early: loud refusal with blocks-to-go
  assert.throws(() => buildHeirClaim(net, vault, { ...base, currentHeight: 120444 }),
    /not yet mature.*444 blocks old.*445.*1 blocks to go/);
  // owner's key is refused for the heir leaf
  assert.throws(() => buildHeirClaim(net, vault, { ...base, heirPrivHex: K[0].priv }),
    /not the heir's claim key/);
  // exactly at maturity: builds
  const claim = buildHeirClaim(net, vault, base);
  assert.ok(/^[0-9a-f]{64}$/.test(claim.txid));
  assert.equal(claim.claimHeight, 120445);
  // fee math: ceil(claimSpendVBytes * rate)
  assert.equal(claim.feeGrains, Math.ceil(claimSpendVBytes(vault) * 5));
  assert.equal(claimSpendVBytes(vault), 138);
  // wire structure: nSequence == n == 445, disable flag clear, type flag clear
  const parsed = parseTx(claim.hex);
  assert.equal(parsed.inputs[0].sequence, 445);
  assert.equal(parsed.inputs[0].sequence & 0x80000000, 0);
  assert.equal(parsed.inputs[0].sequence & 0x00400000, 0);
  assert.equal(parsed.locktime, 0);
  // witness layout: [heir_sig, heirScript, controlBlock]
  const wit = parsed.inputs[0].witness;
  assert.equal(wit.length, 3);
  assert.equal(wit[0].length, 64);
  assert.equal(bytesToHex(wit[1]), vault.leafBScriptHex);
  assert.equal(bytesToHex(wit[2]), vault.leafBControlBlockHex);
  // output pays the destination the UTXO value minus the exact fee
  assert.equal(parsed.outputs[0].value, GRAIN_PER_PRL - claim.feeGrains);
  // sig verifies against the heir key (re-verification happened inside)
  assert.equal(verifySchnorrSig(wit[0],
    scriptPathSigDigestEx(net, { ...utxo, spk: hexToBytes(vault.spkHex) },
      [{ program: addressToProgram(dest.address, net), value: parsed.outputs[0].value }],
      hexToBytes(vault.leafBScriptHex), { sequence: 445 }),
    hexToBytes(vault.heirXOnly)), true);
  // max n: sequence = 65535, flags still clear
  const bigVault = makeVault({ n: 65535 });
  const big = buildHeirClaim(net, bigVault, {
    ...base, fundingHeight: 100000, currentHeight: 165535,
  });
  assert.equal(parseTx(big.hex).inputs[0].sequence, 65535);
});

test("heir claim: dust refusal", () => {
  const vault = makeVault();
  const dest = walletFromMnemonic(
    "legal winner thank year wave sausage worth useful legal winner thank yellow", net);
  assert.throws(() => buildHeirClaim(net, vault, {
    utxo: { txid: "ab".repeat(32), vout: 0, value: 600 },
    heirPrivHex: K[1].priv, destAddress: dest.address,
    feeRateGrainsPerVByte: 5, fundingHeight: 120000, currentHeight: 120445,
  }), /below dust/);
});

test("owner refresh: same address, fresh clock, multi-input, exact fee", () => {
  const vault = makeVault();
  const spkHex = vault.spkHex;
  const utxos = [
    { txid: "ab".repeat(32), vout: 0, value: GRAIN_PER_PRL, spkHex },
    { txid: "cd".repeat(32), vout: 1, value: 2 * GRAIN_PER_PRL, spkHex },
  ];
  const r = buildOwnerRefresh(net, vault, {
    utxos, ownerPrivHex: K[0].priv, feeRateGrainsPerVByte: 5,
  });
  assert.ok(/^[0-9a-f]{64}$/.test(r.txid));
  // The heartbeat: same address by design (identical keys + n always
  // re-derive the same vault). The new UTXO's fresh funding height is what
  // restarts the heir's inactivity clock.
  assert.equal(r.totalInGrains, 3 * GRAIN_PER_PRL);
  // fee: 2 inputs of leaf A (34-byte script), 1 output.
  // hand math: base = 4+1+82+1+43+4 = 135; witness/input = 1+(1+64)+(1+34)+(1+65) = 167;
  // vBytes = ceil((135*3 + (135+2+334)) / 4) = ceil(876/4) = 219
  assert.equal(multiScriptPathVBytes({
    nIn: 2, nOut: 1,
    perInput: [
      { scriptLen: 34, controlLen: 65, stackLens: [64] },
      { scriptLen: 34, controlLen: 65, stackLens: [64] },
    ],
  }), 219);
  const expectFee = Math.ceil(multiScriptPathVBytes({
    nIn: 2, nOut: 1,
    perInput: [
      { scriptLen: 34, controlLen: 65, stackLens: [64] },
      { scriptLen: 34, controlLen: 65, stackLens: [64] },
    ],
  }) * 5);
  assert.equal(r.feeGrains, expectFee);
  // output = all inputs minus the exact fee, paying the vault's OWN spk
  // (same-address heartbeat — the address must NOT change)
  const parsed = parseTx(r.hex);
  assert.equal(parsed.outputs.length, 1);
  assert.equal(parsed.outputs[0].value, 3 * GRAIN_PER_PRL - expectFee);
  assert.equal(bytesToHex(parsed.outputs[0].spk), vault.spkHex);
  assert.equal(parsed.inputs.length, 2);
  for (const pin of parsed.inputs) {
    assert.equal(pin.sequence, FINAL_SEQUENCE);
    assert.equal(pin.witness.length, 3);
    assert.equal(bytesToHex(pin.witness[1]), vault.leafAScriptHex);
    assert.equal(bytesToHex(pin.witness[2]), vault.leafAControlBlockHex);
  }
  // no warnings when spkHex given and matching
  assert.deepEqual(r.warnings, []);
  // belong-check: wrong spk refused
  assert.throws(() => buildOwnerRefresh(net, vault, {
    utxos: [{ txid: "ab".repeat(32), vout: 0, value: 1e8, spkHex: "76".repeat(34) }],
    ownerPrivHex: K[0].priv, feeRateGrainsPerVByte: 5,
  }), /does not belong/);
  // no spk: accepted with a warning
  const w2 = buildOwnerRefresh(net, vault, {
    utxos: [{ txid: "ab".repeat(32), vout: 0, value: 1e8 }],
    ownerPrivHex: K[0].priv, feeRateGrainsPerVByte: 5,
  });
  assert.equal(w2.warnings.length, 1);
  // heir's key cannot refresh (owner leaf)
  assert.throws(() => buildOwnerRefresh(net, vault, {
    utxos, ownerPrivHex: K[1].priv, feeRateGrainsPerVByte: 5,
  }), /not the owner's heartbeat key/);
  // dust total refused
  assert.throws(() => buildOwnerRefresh(net, vault, {
    utxos: [{ txid: "ab".repeat(32), vout: 0, value: 600, spkHex }],
    ownerPrivHex: K[0].priv, feeRateGrainsPerVByte: 5,
  }), /below dust/);
  // owner can refresh ANYTIME — no maturity concept on leaf A
  const early = buildOwnerRefresh(net, vault, {
    utxos: [{ txid: "ab".repeat(32), vout: 0, value: 1e8, spkHex }],
    ownerPrivHex: K[0].priv, feeRateGrainsPerVByte: 5,
  });
  assert.ok(early.txid);
});

test("vaultUtxoStatus classifier", () => {
  const vault = makeVault(); // n = 445
  const s1 = vaultUtxoStatus(vault, 120000, 120100);
  assert.equal(s1.status, "owner-active");
  assert.equal(s1.age, 100);
  assert.equal(s1.blocksLeft, 345);
  assert.equal(s1.claimHeight, 120445);
  assert.equal(s1.etaSecs, 345 * PEARL_BLOCK_SECS);
  assert.equal(s1.reorgNote, null);
  const s2 = vaultUtxoStatus(vault, 120000, 120445); // exactly mature
  assert.equal(s2.status, "heir-claimable");
  assert.equal(s2.blocksLeft, 0);
  assert.ok(s2.reorgNote.includes("reorg"));
  const s3 = vaultUtxoStatus(vault, 120000, 121000);
  assert.equal(s3.status, "heir-claimable");
  assert.equal(s3.blocksLeft, 0);
  assert.throws(() => vaultUtxoStatus(vault, 0, 120000), /funding height/);
});

test("describeVault is human-readable", () => {
  const d = describeVault(makeVault());
  assert.ok(d.address.startsWith("prl1p"));
  assert.equal(d.n, 445);
  assert.ok(Math.abs(d.daysEstimate - 1.0) < 0.01, d.daysEstimate);
  assert.ok(d.descriptor.startsWith("legacy:v1:"));
  const d2 = describeVault(makeVault({ n: 65535 }));
  assert.ok(Math.abs(d2.daysEstimate - 147.1) < 0.2, d2.daysEstimate);
});

test("constants: block time from pearl-knowledge.md", () => {
  assert.equal(PEARL_BLOCK_SECS, 194);
  assert.equal(MIN_CSV_BLOCKS, 1);
  assert.equal(MAX_CSV_BLOCKS, 65535);
  assert.equal(LEGACY_KIND, "pearl-legacy");
  assert.equal(LEGACY_VERSION, 1);
  // ~1 day / ~30 day presets land where the UI claims
  assert.ok(Math.abs(blocksToDays(445) - 1.0) < 0.01);
  assert.ok(Math.abs(blocksToDays(13361) - 30.0) < 0.02);
});
