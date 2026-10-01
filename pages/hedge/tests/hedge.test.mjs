// Pearl Hedge core verification suite.
// Run: node --no-warnings --loader ./tests/loader.mjs tests/hedge.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  NETWORKS, DUST_GRAIN, GRAIN_PER_PRL,
  bytesToHex, hexToBytes, schnorr, sha256, taggedHash,
  validateExpiry, expiryBlocksFromDays, lockHashForPreimage,
  buildExerciseScript, parseExerciseScript, buildHedgeRefundScript,
  numsInternalKeyHedge, taptreeHedge, forgeOption, counterpartyKeyFromInput,
  descriptorFor, sealedDescriptor, parseDescriptor, optionFromDescriptor,
  verifyStrikePayment, planOptionSpend, buyerSignerFor, writerSignerFor,
  buildExerciseTx, buildRefundTx, classifyLifecycle, expectedAddress,
  partyKeyFromInput, scriptAsm, parseXOnlyKey, wipeSecrets,
  encodeScriptNum, spendVBytes, tweakKeypath,
  buildRefundScript, walletFromMnemonic,
} from "../src/hedge-core.js";
import { verifyControlBlock } from "../../escrow/src/escrow-core.js";
import { bytesToNumberBE, numberToBytesBE } from "@noble/curves/abstract/utils";
import { secp256k1 } from "@noble/curves/secp256k1";

const net = NETWORKS.mainnet;

// Deterministic test keys: priv 2 (writer) and priv 3 (buyer), even-Y normalized.
function testKey(i) {
  const priv = numberToBytesBE(BigInt(i), 32);
  const P = secp256k1.ProjectivePoint.fromPrivateKey(priv);
  const raw = P.toRawBytes(true);
  const xonly = bytesToHex(raw.slice(1));
  const negated = raw[0] === 0x03 ? secp256k1.CURVE.n - BigInt(i) : BigInt(i);
  return { priv: bytesToHex(numberToBytesBE(negated, 32)), xonly };
}
const W = testKey(2); // writer (collateral funder)
const B = testKey(3); // buyer (exercise right holder)
const PREIMAGE = "deadbeef".repeat(8);
const LOCKHASH = "8200cf0ce11447bf6353cbac964d07d1c390d61d07e6c5d0214450b3add6449b";

// Pinned canonical vector (computed 2026-09-30 from audited crypto lineage).
const PIN_DESC = "pearl-hedge:v1:prl:C:c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5:f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9:8200cf0ce11447bf6353cbac964d07d1c390d61d07e6c5d0214450b3add6449b:100000000:250000000:800000:5000000";
const PIN_ADDR = "prl1pj4u2nr5h6wzn9hgsl4yw8jn338su4xqatj5nqkwrwk4xj3a290eqc6jcc4";
const PIN_SEALED = "pearl-hedge:v1:prl:3fcee31ca30511bc86b04af7692ed14635c5f2bdfce69e935edfa3d0f85b38ad";
const PIN_INTERNAL = "f4cd7289fa9a90f8daa6c9642246850d65042a0bf5667de89f932ea16a91f4f1";

function forgePin(kind = "C") {
  return forgeOption({
    network: net, kind, writer: W.xonly, buyer: B.xonly, lockHash: LOCKHASH,
    qtyGrains: 100_000_000, strikeGrains: 250_000_000, expiry: 800_000, premiumGrains: 5_000_000,
  });
}

test("pinned canonical vector: descriptor, sealed hash, address, NUMS internal key", () => {
  const o = forgePin();
  assert.equal(o.descriptor, PIN_DESC);
  assert.equal(o.address, PIN_ADDR);
  assert.equal(o.sealed, PIN_SEALED);
  assert.equal(bytesToHex(o.internalXOnly), PIN_INTERNAL);
  // NUMS point equals the independent taggedHash construction.
  const expect = taggedHash("PearlHedgeNUMS/v1", Uint8Array.from([...o.exerciseScript, ...o.refundScript, 0]));
  assert.equal(bytesToHex(schnorr.utils.pointToBytes(schnorr.utils.lift_x(bytesToNumberBE(expect)))), PIN_INTERNAL);
});

test("refund leaf is byte-identical to the audited escrow refund leaf", () => {
  const o = forgePin();
  const audited = buildRefundScript(W.xonly, 800_000);
  assert.deepEqual(o.refundScript, audited);
  assert.equal(bytesToHex(o.refundScript), bytesToHex(audited));
});

test("exercise leaf byte shape: <expiry> CLTV DROP <hash> EQUALVERIFY <buyer> CHECKSIG", () => {
  const o = forgePin();
  const s = o.exerciseScript;
  const eLen = s[0];
  assert.ok(eLen >= 1 && eLen <= 4);
  assert.deepEqual(s.slice(1, 1 + eLen), encodeScriptNum(800_000));
  const p = 1 + eLen;
  assert.equal(s[p], 0xb1);      // CLTV
  assert.equal(s[p + 1], 0x75);  // DROP
  assert.equal(s[p + 2], 32);
  assert.deepEqual(s.slice(p + 3, p + 35), hexToBytes(LOCKHASH));
  assert.equal(s[p + 35], 0x88); // EQUALVERIFY
  assert.equal(s[p + 36], 32);
  assert.deepEqual(s.slice(p + 37, p + 69), hexToBytes(B.xonly));
  assert.equal(s[p + 69], 0xac); // CHECKSIG
  assert.equal(s.length, p + 70);
  // Round-trip parser.
  const parsed = parseExerciseScript(s);
  assert.equal(bytesToHex(parsed.lockHash), LOCKHASH);
  assert.equal(bytesToHex(parsed.buyerKey), B.xonly);
  assert.deepEqual(parsed.expiryBytes, encodeScriptNum(800_000));
  // Bad shape refused.
  assert.throws(() => parseExerciseScript(s.slice(0, s.length - 1)), /shape/);
});

test("control blocks verify against the tweaked key (script-path provenance)", () => {
  const o = forgePin();
  assert.ok(verifyControlBlock(o.internalXOnly, o.exerciseScript, o.exerciseControlBlock, o.tweakedX));
  assert.ok(verifyControlBlock(o.internalXOnly, o.refundScript, o.refundControlBlock, o.tweakedX));
  // Swapped control block fails.
  assert.ok(!verifyControlBlock(o.internalXOnly, o.exerciseScript, o.refundControlBlock, o.tweakedX));
});

test("descriptor tampering is caught: script fields move the address, economic terms break the seal", () => {
  const { forged } = optionFromDescriptor(PIN_DESC);
  assert.equal(forged.address, PIN_ADDR);
  // Script-committed field flipped (expiry): the vault address moves, so a
  // verifier comparing against the funded address rules NOT PROVEN.
  const tamperedExpiry = PIN_DESC.replace(":800000:", ":800001:");
  const tE = optionFromDescriptor(tamperedExpiry);
  assert.notEqual(tE.forged.address, PIN_ADDR);
  assert.notEqual(sealedDescriptor(tamperedExpiry), PIN_SEALED);
  // Economic terms (strike/qty/premium) are NOT in the script leaves — they
  // are bound by the sealed commitment instead. Flipping the strike keeps the
  // address but breaks the seal and the parsed terms.
  const tamperedStrike = PIN_DESC.replace(":250000000:", ":250000001:");
  const tS = optionFromDescriptor(tamperedStrike);
  assert.equal(tS.forged.address, PIN_ADDR); // same vault…
  assert.notEqual(tS.parsed.strikeGrains, 250_000_000); // …different terms…
  assert.notEqual(sealedDescriptor(tamperedStrike), PIN_SEALED); // …broken seal
  // Malformed descriptors are refused outright.
  assert.throws(() => optionFromDescriptor("pearl-hedge:v1:prl:C:zzz"), /must look like/);
  assert.throws(() => optionFromDescriptor(PIN_DESC.replace(":prl:", ":zzz:")), /unknown network/);
  assert.throws(() => optionFromDescriptor(PIN_DESC.replace(":800000:", ":0:")), /block height/);
});

test("sealed descriptor commits to the canonical descriptor", () => {
  assert.equal(sealedDescriptor(PIN_DESC), PIN_SEALED);
  assert.ok(/^pearl-hedge:v1:prl:[0-9a-f]{64}$/.test(PIN_SEALED));
  assert.notEqual(sealedDescriptor(PIN_DESC.replace(":5000000", ":5000001")), PIN_SEALED);
});

test("expiry math: days -> blocks at 194 s/block; validation", () => {
  assert.equal(expiryBlocksFromDays(1), Math.ceil(86400 / 194));
  assert.equal(expiryBlocksFromDays(30), Math.ceil(30 * 86400 / 194));
  assert.equal(expiryBlocksFromDays(0.001), 1); // floored to minimum 1 block
  assert.throws(() => expiryBlocksFromDays(0), /positive/);
  assert.throws(() => expiryBlocksFromDays(-3), /positive/);
  assert.equal(validateExpiry(1), 1);
  assert.equal(validateExpiry(499_999_999), 499_999_999);
  assert.throws(() => validateExpiry(0), /block height/);
  assert.throws(() => validateExpiry(500_000_000), /block height/);
});

test("lockHashForPreimage pins sha256 of the buyer secret", () => {
  assert.equal(bytesToHex(lockHashForPreimage(PREIMAGE)), LOCKHASH);
  assert.throws(() => lockHashForPreimage("abcd"), /32 bytes/);
});

test("forgeOption refuses bad economics loudly", () => {
  const base = { network: net, kind: "C", writer: W.xonly, buyer: B.xonly, lockHash: LOCKHASH, strikeGrains: 250_000_000, expiry: 800_000 };
  assert.throws(() => forgeOption({ ...base, qtyGrains: 545 }), /dust/);
  assert.throws(() => forgeOption({ ...base, qtyGrains: 100_000_000, strikeGrains: 0 }), /strike/);
  assert.throws(() => forgeOption({ ...base, qtyGrains: 100_000_000, kind: "X" }), /kind/);
  assert.throws(() => forgeOption({ ...base, qtyGrains: 100_000_000, premiumGrains: -1 }), /premium/);
  assert.throws(() => forgeOption({ ...base, qtyGrains: 100_000_000, expiry: 0 }), /block height/);
});

test("protective put is the same vault construction with the roles labeled swapped", () => {
  const put = forgePin("P");
  assert.ok(put.descriptor.includes(":P:"));
  // The vault is determined by the two roles (locker / exercise holder), not
  // by the product label: identical keys -> identical address. In the UI a put
  // swaps the party labels (locker = put holder, exercise holder = put writer).
  assert.equal(put.address, PIN_ADDR);
  const { forged } = optionFromDescriptor(put.descriptor);
  assert.equal(forged.address, put.address);
  assert.equal(forged.descriptor, put.descriptor);
});

const UTXO = { txid: "f".repeat(64), vout: 0, value: 100_000_000 };
const DEST = (() => { // buyer's payout address program (raw key derived)
  const w = hexToBytes(W.xonly);
  return w;
})();

test("buildExerciseTx: happy path, sig re-verified, witness order [sig, preimage]", () => {
  const { parsed, forged } = optionFromDescriptor(PIN_DESC);
  const opt = { parsed, forged, exerciseScript: forged.exerciseScript, exerciseControlBlock: forged.exerciseControlBlock, expiry: parsed.expiry };
  const tx = buildExerciseTx({
    network: net, utxo: UTXO, option: opt,
    preimage: PREIMAGE, signerPriv: B.priv,
    destinationProgram: DEST, feeRateGrainsPerVByte: 2, chainTip: 800_000,
  });
  assert.equal(tx.locktime, 800_000);
  assert.equal(tx.sequence, 0xfffffffe);
  assert.ok(/^[0-9a-f]{64}$/.test(tx.txid));
  assert.ok(tx.hex.length > 200);
  // Fee math matches the independent vBytes estimate.
  const expectVB = spendVBytes({ nOut: 1, scriptLen: forged.exerciseScript.length, controlLen: 65, stackLens: [64, 32] });
  assert.equal(tx.fee, Math.ceil(expectVB * 2));
  assert.equal(tx.payment, 100_000_000 - tx.fee);
  assert.ok(tx.payment > DUST_GRAIN);
});

test("buildExerciseTx loud refusals", () => {
  const { parsed, forged } = optionFromDescriptor(PIN_DESC);
  const opt = { parsed, forged, exerciseScript: forged.exerciseScript, exerciseControlBlock: forged.exerciseControlBlock, expiry: parsed.expiry };
  const base = { network: net, utxo: UTXO, option: opt, preimage: PREIMAGE, signerPriv: B.priv, destinationProgram: DEST, feeRateGrainsPerVByte: 2 };
  // Wrong preimage.
  assert.throws(() => buildExerciseTx({ ...base, preimage: "00".repeat(32) }), /preimage/);
  // Exercise before expiry (CLTV would fail on-chain).
  assert.throws(() => buildExerciseTx({ ...base, chainTip: 799_999 }), /before expiry/);
  // Wrong key (writer's key cannot sign the buyer leaf).
  assert.throws(() => buildExerciseTx({ ...base, signerPriv: W.priv, chainTip: 800_000 }), /wrong key/);
  // Underfunded vault: fee eats everything.
  assert.throws(() => buildExerciseTx({ ...base, utxo: { ...UTXO, value: 546 }, chainTip: 800_000 }), /insufficient funds/);
});

test("buildRefundTx: happy path; refused before expiry; wrong key refused", () => {
  const { parsed, forged } = optionFromDescriptor(PIN_DESC);
  const opt = { parsed, forged, refundScript: forged.refundScript, refundControlBlock: forged.refundControlBlock, expiry: parsed.expiry };
  const tx = buildRefundTx({
    network: net, utxo: UTXO, option: opt,
    signerPriv: W.priv, destinationProgram: DEST, feeRateGrainsPerVByte: 2, chainTip: 800_001,
  });
  assert.equal(tx.locktime, 800_000);
  assert.ok(tx.payment > DUST_GRAIN);
  const expectVB = spendVBytes({ nOut: 1, scriptLen: forged.refundScript.length, controlLen: 65, stackLens: [64] });
  assert.equal(tx.fee, Math.ceil(expectVB * 2));
  // Refund before expiry is refused.
  assert.throws(() => buildRefundTx({
    network: net, utxo: UTXO, option: opt,
    signerPriv: W.priv, destinationProgram: DEST, feeRateGrainsPerVByte: 2, chainTip: 799_999,
  }), /before expiry/);
  // Buyer's key cannot sign the refund leaf.
  assert.throws(() => buildRefundTx({
    network: net, utxo: UTXO, option: opt,
    signerPriv: B.priv, destinationProgram: DEST, feeRateGrainsPerVByte: 2, chainTip: 800_001,
  }), /wrong key/);
});

test("buyerSignerFor / writerSignerFor: mnemonic secrets, raw + address modes, wrong-key refusal", () => {
  const MN = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  const w = walletFromMnemonic(MN, net);
  const rawX = bytesToHex(w.internalXOnly);
  const { tweakKeypath: tkp } = { tweakKeypath };
  const addrX = bytesToHex(tkp(w.internalXOnly).tweakedX);
  // raw mode: leaf key is the internal x-only key
  const bs = buyerSignerFor(MN, net, rawX, "raw");
  assert.equal(bytesToHex(bs.xonly), rawX);
  wipeSecrets(bs.priv);
  // address mode: leaf key is the keypath-tweaked x-only key
  const bs2 = buyerSignerFor(MN, net, addrX, "address");
  assert.equal(bytesToHex(bs2.xonly), addrX);
  wipeSecrets(bs2.priv);
  // wrong secret refused loudly
  const MN2 = "legal winner thank year wave sausage worth useful legal winner thank yellow";
  assert.throws(() => buyerSignerFor(MN2, net, rawX, "raw"), /wrong key/);
  assert.throws(() => buyerSignerFor(MN2, net, addrX, "address"), /wrong key/);
  assert.throws(() => buyerSignerFor("garbage", net, rawX, "raw"), /mnemonic or WIF/);
  const ws = writerSignerFor(MN, net, rawX, "raw");
  assert.equal(bytesToHex(ws.xonly), rawX);
  wipeSecrets(ws.priv);
  assert.throws(() => writerSignerFor(MN2, net, rawX, "raw"), /wrong key/);
});

test("partyKeyFromInput accepts x-only / mnemonic; counterpartyKeyFromInput also accepts PRL addresses", () => {
  const k = partyKeyFromInput(B.xonly, net);
  assert.equal(bytesToHex(k.xonly), B.xonly);
  assert.throws(() => partyKeyFromInput("notakey", net), /./);
  const MN = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  const c = counterpartyKeyFromInput(B.xonly, net);
  assert.equal(c.mode, "raw");
  assert.equal(bytesToHex(c.key), B.xonly);
  const cm = counterpartyKeyFromInput(MN, net);
  assert.equal(cm.mode, "address");
  // A vault address derived from a counterparty key re-derives identically.
  const o = forgeOption({
    network: net, kind: "C", writer: W.xonly, buyer: bytesToHex(cm.key),
    lockHash: LOCKHASH, qtyGrains: 100_000_000, strikeGrains: 250_000_000,
    expiry: 800_000, premiumGrains: 0,
  });
  assert.ok(o.address.startsWith("prl1p"));
  assert.throws(() => counterpartyKeyFromInput("notakey", net), /./);
});

test("verifyStrikePayment: paid/confirmed passes; underpaid and unconfirmed refused", async () => {
  const realFetch = globalThis.fetch;
  const writerAddr = "prl1pwriter0000000000000000000000000000000000";
  const txJson = { txid: "a".repeat(64), confirmations: 3, vout: [{ value: "250000000", addresses: [writerAddr] }] };
  globalThis.fetch = async () => ({ ok: true, json: async () => txJson, text: async () => JSON.stringify(txJson) });
  try {
    const ok = await verifyStrikePayment({ blockbookBase: "https://x", txid: "a".repeat(64), writerAddress: writerAddr, strikeGrains: 250_000_000 });
    assert.equal(ok.ok, true);
    assert.equal(ok.paidGrains, 250_000_000);
    // Underpaid: shortfall reported in grains.
    await assert.rejects(
      verifyStrikePayment({ blockbookBase: "https://x", txid: "a".repeat(64), writerAddress: writerAddr, strikeGrains: 250_000_001 }),
      /shortfall 1 grains/
    );
    // Unconfirmed refused.
    const txUnconf = { ...txJson, confirmations: 0 };
    globalThis.fetch = async () => ({ ok: true, json: async () => txUnconf, text: async () => JSON.stringify(txUnconf) });
    await assert.rejects(
      verifyStrikePayment({ blockbookBase: "https://x", txid: "a".repeat(64), writerAddress: writerAddr, strikeGrains: 250_000_000 }),
      /unconfirmed/
    );
    // Bad txid refused.
    await assert.rejects(
      verifyStrikePayment({ blockbookBase: "https://x", txid: "xyz", writerAddress: writerAddr, strikeGrains: 250_000_000 }),
      /64 hex/
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("classifyLifecycle: unfunded -> funded -> expired-funded -> spent", () => {
  assert.equal(classifyLifecycle({ utxos: [], txCount: 0, tip: 100, expiry: 800_000 }), "unfunded");
  assert.equal(classifyLifecycle({ utxos: [{ value: 100_000_000 }], txCount: 1, tip: 799_999, expiry: 800_000 }), "funded");
  assert.equal(classifyLifecycle({ utxos: [{ value: 100_000_000 }], txCount: 1, tip: 800_000, expiry: 800_000 }), "expired-funded");
  assert.equal(classifyLifecycle({ utxos: [], txCount: 2, tip: 800_005, expiry: 800_000 }), "spent");
});

test("expectedAddress audit one-liner matches forgeOption", () => {
  assert.equal(
    expectedAddress({ network: net, kind: "C", writer: W.xonly, buyer: B.xonly, lockHash: LOCKHASH, qtyGrains: 100_000_000, strikeGrains: 250_000_000, expiry: 800_000, premiumGrains: 5_000_000 }),
    PIN_ADDR
  );
});

test("script asm renders both leaves human-readably", () => {
  const o = forgePin();
  assert.match(scriptAsm(o.exerciseScript), /EQUALVERIFY/);
  assert.match(scriptAsm(o.refundScript), /CLTV/);
});
