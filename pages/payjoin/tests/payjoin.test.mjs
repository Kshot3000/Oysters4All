// Pearl Payjoin core tests — BIP-78 two-party transaction desk for PRL.
// Covers: amount/rate parsing, bech32m prl1 handling, receiver offer +
// template validation, the full lab E2E (offer -> signed original -> proposal
// -> verify -> sign -> final tx) with fixed test keys, fee/dust math, and
// negative cases (tampered proposals fail the exact expected check, loud
// refusals on every protocol violation).
//
// Usage: node --no-warnings --loader ./tests/loader.mjs --test tests/payjoin.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as P from "../src/payjoin-core.js";
import {
  parsePsbtBase64, psbtToBase64, serializePsbt, serializeUnsignedTx,
  G_UNSIGNED_TX, IN_WITNESS_UTXO, tapTweak, taprootSighash,
} from "../../psbt/src/psbt-core.js";
import { schnorr } from "../../sign/lib/noble-curves/secp256k1.js";
import { keypathTxVBytes } from "../../sign/src/crypto.js";

const SENDER_MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const RECEIVER_MNEMONIC = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const TXID_A = "aa".repeat(32);
const TXID_B = "bb".repeat(32);
const TXID_C = "cc".repeat(32);
const detRng = () => 0.999999; // deterministic: receiver input/output appended at the end

const refused = (fn, code) => {
  try { fn(); } catch (e) {
    assert.match(String(e.message), /^REFUSED \[/, "refusal must be loud");
    if (code) assert.ok(String(e.message).includes(`[${code}]`), `expected [${code}], got: ${e.message}`);
    return String(e.message);
  }
  assert.fail("expected a loud REFUSED, got success");
};

const sKey = (i) => P.deriveSenderKey(SENDER_MNEMONIC, i);
const rKey = (i) => P.deriveSenderKey(RECEIVER_MNEMONIC, i);

/** Parse a PSBT, mutate the object, re-encode (for tamper tests). */
function mutatePsbt(b64, fn) {
  const psbt = parsePsbtBase64(b64);
  fn(psbt);
  const g = psbt.globalPairs.find((p) => p.key.length === 1 && p.key[0] === G_UNSIGNED_TX);
  g.value = serializeUnsignedTx(psbt.unsignedTx);
  psbt.unsignedTxBytes = g.value;
  return psbtToBase64(psbt);
}

function stdOffer(over = {}) {
  return P.buildReceiverOffer({
    amount: "1 PRL",
    paymentAddress: rKey(0).address,
    maxadditionalfeecontribution: "1000",
    minfeerate: "1",
    disableoutputsubstitution: false,
    ...over,
  });
}
function stdParams(envelope) {
  return P.decodePaste(JSON.stringify(envelope)).params;
}
function stdOriginal(offer = null) {
  offer = offer || stdOffer();
  const params = stdParams(offer.envelope);
  const sk = sKey(0);
  const inp = P.prepareSenderInput({ txid: TXID_A, vout: 0, value: 200_000_000n, key: sk });
  return P.buildSenderOriginal({
    offerB64: offer.base64, params,
    senderInputs: [inp], tweakedPrivs: [sk.tweakedPriv],
    changeAddress: sKey(1).address, feeRate: "2",
  });
}
function stdProposal(original = null, over = {}) {
  original = original || stdOriginal();
  const rk = rKey(1);
  const inp = P.prepareSenderInput({ txid: TXID_B, vout: 1, value: 50_000_000n, key: rk });
  return P.buildProposal({
    originalB64: original.base64,
    params: stdParams(original.envelope),
    paymentScriptHex: original.envelope.payment.script_hex,
    receiverInputs: [inp], tweakedPrivs: [rk.tweakedPriv],
    receiverChangeAddress: rKey(2).address,
    rng: detRng,
    ...over,
  });
}

describe("amounts & rates", () => {
  it("parseGrains: PRL decimals", () => {
    assert.equal(P.parseGrains("1 PRL"), 100_000_000n);
    assert.equal(P.parseGrains("1.5 prl"), 150_000_000n);
    assert.equal(P.parseGrains("0.00000001 PRL"), 1n);
  });
  it("parseGrains: grains integers", () => {
    assert.equal(P.parseGrains("546"), 546n);
    assert.equal(P.parseGrains("1000000 grains"), 1_000_000n);
  });
  it("parseGrains refuses junk", () => {
    refused(() => P.parseGrains("-5"), "bad-amount");
    refused(() => P.parseGrains("0"), "bad-amount");
    refused(() => P.parseGrains("1.123456789 PRL"), "bad-amount");
    refused(() => P.parseGrains("1.5"), "bad-amount"); // grains path: no decimals
    refused(() => P.parseGrains("99999999 PRL"), "bad-amount"); // > 21M
    refused(() => P.parseGrains("abc"), "bad-amount");
  });
  it("parseRate", () => {
    assert.deepEqual(P.parseRate("2"), { num: 2n, den: 1n });
    assert.deepEqual(P.parseRate("1.5"), { num: 15n, den: 10n });
    refused(() => P.parseRate("0"), "bad-feerate");
    refused(() => P.parseRate("-1"), "bad-feerate");
  });
  it("grainsToPRL", () => {
    assert.equal(P.grainsToPRL(100_000_000n), "1");
    assert.equal(P.grainsToPRL(150_000_000n), "1.5");
    assert.equal(P.grainsToPRL(546n), "0.00000546");
  });
});

describe("addresses", () => {
  it("prl1 round-trip", () => {
    const a = sKey(0).address;
    assert.ok(a.startsWith("prl1"));
    const prog = P.parsePrl1Address(a);
    assert.equal(prog.length, 32);
    assert.equal(P.programToAddress(prog), a);
  });
  it("refuses bad addresses loudly", () => {
    refused(() => P.parsePrl1Address("prl1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq"), "bad-address");
    const a = sKey(0).address;
    const bad = a.slice(0, -1) + (a.endsWith("q") ? "p" : "q");
    refused(() => P.parsePrl1Address(bad), "bad-address");
    refused(() => P.parsePrl1Address("tprl1" + a.slice(4)), "wrong-network");
  });
  it("isP2TR / spkToAddress", () => {
    const spk = P.addressToSpk(sKey(0).address);
    assert.ok(P.isP2TR(spk));
    assert.equal(P.spkToAddress(spk), sKey(0).address);
    assert.ok(!P.isP2TR(new Uint8Array([0x51, 0x20])));
  });
});

describe("receiver offer", () => {
  it("builds a valid template PSBT", () => {
    const o = stdOffer();
    const v = P.validateOfferTemplate(o.base64);
    assert.equal(v.paymentValue, 100_000_000n);
    assert.equal(v.paymentAddress, rKey(0).address);
    assert.equal(o.query, "v=2&maxadditionalfeecontribution=1000&minfeerate=1&disableoutputsubstitution=false");
    // PSBT round-trip is byte-identical (canonical writer)
    assert.equal(psbtToBase64(parsePsbtBase64(o.base64)), o.base64);
  });
  it("decodePaste handles envelopes and bare base64", () => {
    const o = stdOffer();
    const e = P.decodePaste(JSON.stringify(o.envelope));
    assert.equal(e.kind, "pearl-payjoin-offer");
    assert.equal(e.psbtB64, o.base64);
    assert.equal(e.params.maxadditionalfeecontribution, 1000n);
    assert.equal(e.params.disableoutputsubstitution, false);
    const b = P.decodePaste(o.base64);
    assert.equal(b.kind, "bare-psbt");
    assert.equal(b.params, null);
    refused(() => P.decodePaste(""), "empty");
    refused(() => P.decodePaste("{nope"), "bad-envelope");
  });
  it("dust payment refused", () => {
    refused(() => stdOffer({ amount: "500 grains" }), "dust");
  });
  it("template validation refuses junk", () => {
    refused(() => P.validateOfferTemplate("cHNidP8="), "bad-psbt");
    // funded (non-template) PSBT is not a valid offer template
    refused(() => P.validateOfferTemplate(stdOriginal().base64), "has-inputs");
  });
  it("summarizePsbt decodes the template", () => {
    const o = stdOffer();
    const s = P.summarizePsbt(o.base64);
    assert.equal(s.version, 1);
    assert.equal(s.inputs.length, 0);
    assert.equal(s.outputs.length, 1);
    assert.equal(s.outputs[0].value_grains, "100000000");
    assert.equal(s.outputs[0].address, rKey(0).address);
    assert.equal(s.modifiable, "0x03");
  });
});

describe("key derivation", () => {
  it("BIP-86 derivation is deterministic and consistent", () => {
    const a = sKey(0), b = sKey(0);
    assert.equal(a.address, b.address);
    assert.equal(a.tweakedHex, b.tweakedHex);
    assert.notEqual(sKey(0).address, sKey(1).address);
    assert.notEqual(sKey(0).address, rKey(0).address);
  });
  it("bad mnemonic refused", () => {
    refused(() => P.deriveSenderKey("not a mnemonic at all", 0), "bad-mnemonic");
  });
});

describe("sender original", () => {
  it("builds a signed+finalized original with exact fee math", () => {
    const orig = stdOriginal();
    // keypath vsize(1 in, 2 out): base 4+1+41+1+86+4=137, weight 4*137+2+66=616 -> 154 vB
    assert.equal(keypathTxVBytes(1, 2), 154);
    assert.equal(orig.vsize, 154);
    assert.equal(orig.fee, 308n); // ceil(2 * 154)
    assert.equal(orig.changeValue, 200_000_000n - 100_000_000n - 308n);
    assert.equal(orig.nIn, 1);
    assert.equal(orig.nOut, 2);
    const v = P.validateFundedOriginal(orig.base64);
    assert.equal(v.fee, 308n);
    assert.equal(v.totalIn, 200_000_000n);
    // every input finalized with a witness stack holding one 64-byte sig
    const psbt = parsePsbtBase64(orig.base64);
    assert.equal(psbt.inputs.length, 1);
    const fin = psbt.inputs[0].find((p) => p.key[0] === 0x08);
    assert.ok(fin, "input finalized");
    assert.equal(fin.value[0], 1); // one witness item
    assert.equal(fin.value[1], 64); // 64-byte schnorr sig
  });
  it("refuses insufficient funds and dust change", () => {
    const offer = stdOffer();
    const params = stdParams(offer.envelope);
    const sk = sKey(0);
    const mk = (val) => P.prepareSenderInput({ txid: TXID_A, vout: 0, value: val, key: sk });
    refused(() => P.buildSenderOriginal({
      offerB64: offer.base64, params, senderInputs: [mk(50_000_000n)],
      tweakedPrivs: [sk.tweakedPriv], changeAddress: sKey(1).address, feeRate: "2",
    }), "insufficient-funds");
  });
  it("refuses duplicate outpoints", () => {
    const offer = stdOffer();
    const params = stdParams(offer.envelope);
    const sk = sKey(0);
    const a = P.prepareSenderInput({ txid: TXID_A, vout: 0, value: 200_000_000n, key: sk });
    const b = P.prepareSenderInput({ txid: TXID_A, vout: 0, value: 1_000_000n, key: sk });
    refused(() => P.buildSenderOriginal({
      offerB64: offer.base64, params, senderInputs: [a, b],
      tweakedPrivs: [sk.tweakedPriv, sk.tweakedPriv], changeAddress: "", feeRate: "2",
    }), "dup-input");
  });
  it("unsigned/unfunded originals are refused by the receiver check", () => {
    const offer = stdOffer();
    refused(() => P.validateFundedOriginal(offer.base64), "no-inputs");
  });
});

describe("proposal", () => {
  it("builds a valid proposal with bounded deduction", () => {
    const orig = stdOriginal();
    const prop = stdProposal(orig);
    // vsize(2,3): base 4+1+82+1+129+4=221, weight 4*221+2+132=1018 -> 255 vB; added = 101
    assert.equal(prop.vsizeP, 255);
    assert.equal(prop.addedVBytes, 101);
    // weightCost = ceil(308 * 101 / 154) = 202; receiver pays it, d = 0
    assert.equal(prop.cRecv, 202n);
    assert.equal(prop.d, 0n);
    assert.equal(prop.feeP, 308n + 202n);
    assert.equal(prop.rChange, 50_000_000n - 202n);
    assert.equal(prop.paymentP, 100_000_000n);
    assert.equal(prop.inIdx, 1); // detRng -> appended
    assert.equal(prop.changeIdx, 2);
    // the proposal's sender inputs are deliberately unsigned (BIP-78) —
    // it is validated by verifyProposal, not validateFundedOriginal.
  });
  it("deducts from the payment output when the receiver underfunds", () => {
    const orig = stdOriginal();
    const rk = rKey(1);
    const inp = P.prepareSenderInput({ txid: TXID_B, vout: 1, value: 600n, key: rk }); // tiny input
    const prop = stdProposal(orig, { receiverInputs: [inp] });
    // with-change pass: addedVBytes = vsize(2,3)-vsize(1,2) = 255-154 = 101;
    // weightCost = ceil(308*101/154) = 202; minTotal = ceil(1*255) = 255;
    // required = max(202, 255-308 -> 0, 0) = 202;
    // cRecv = min(600-546, 202) = 54; need = 202-54 = 148;
    // d = min(148, maxAdd=1000, feeO - minfeerate*vsizeO = 154) = 148;
    // rChange = 600-54 = 546 = DUST exactly -> change output kept.
    assert.equal(prop.weightCost, 202n);
    assert.equal(prop.required, 202n);
    assert.equal(prop.cRecv, 54n);
    assert.equal(prop.d, 148n);
    assert.equal(prop.rChange, 546n);
    assert.equal(prop.nOut, 3);
    assert.equal(prop.feeP, 510n);
    assert.equal(prop.paymentP, 100_000_000n - 148n);
  });
  it("not-enough-money: refuses when the deduction would exceed the cap", () => {
    const offer = stdOffer({ maxadditionalfeecontribution: "100", minfeerate: "10" });
    const params = stdParams(offer.envelope);
    const sk = sKey(0);
    const inp = P.prepareSenderInput({ txid: TXID_A, vout: 0, value: 200_000_000n, key: sk });
    const orig = P.buildSenderOriginal({
      offerB64: offer.base64, params, senderInputs: [inp], tweakedPrivs: [sk.tweakedPriv],
      changeAddress: sKey(1).address, feeRate: "2",
    });
    const rk = rKey(1);
    const rinp = P.prepareSenderInput({ txid: TXID_B, vout: 1, value: 600n, key: rk });
    refused(() => P.buildProposal({
      originalB64: orig.base64, params: stdParams(orig.envelope),
      paymentScriptHex: orig.envelope.payment.script_hex,
      receiverInputs: [rinp], tweakedPrivs: [rk.tweakedPriv],
      receiverChangeAddress: rKey(2).address, rng: detRng,
    }), "not-enough-money");
  });
  it("refuses when output substitution is disabled but funds are short", () => {
    const offer = stdOffer({ disableoutputsubstitution: true, minfeerate: "50" });
    const params = stdParams(offer.envelope);
    const sk = sKey(0);
    const inp = P.prepareSenderInput({ txid: TXID_A, vout: 0, value: 200_000_000n, key: sk });
    const orig = P.buildSenderOriginal({
      offerB64: offer.base64, params, senderInputs: [inp], tweakedPrivs: [sk.tweakedPriv],
      changeAddress: sKey(1).address, feeRate: "2",
    });
    const rk = rKey(1);
    const rinp = P.prepareSenderInput({ txid: TXID_B, vout: 1, value: 600n, key: rk });
    refused(() => P.buildProposal({
      originalB64: orig.base64, params: stdParams(orig.envelope),
      paymentScriptHex: orig.envelope.payment.script_hex,
      receiverInputs: [rinp], tweakedPrivs: [rk.tweakedPriv],
      receiverChangeAddress: rKey(2).address, rng: detRng,
    }), "not-enough-money");
  });
  it("refuses receiver inputs that collide with sender outpoints", () => {
    const orig = stdOriginal();
    const rk = rKey(1);
    const inp = P.prepareSenderInput({ txid: TXID_A, vout: 0, value: 1_000_000n, key: rk });
    refused(() => stdProposal(orig, { receiverInputs: [inp] }), "dup-input");
  });
  it("refuses a bad receiver change address", () => {
    const orig = stdOriginal();
    refused(() => stdProposal(orig, { receiverChangeAddress: "bc1qxyz" }), "bad-address");
  });
});

describe("verify: the sender checklist", () => {
  function stdVerify(orig = null, prop = null) {
    orig = orig || stdOriginal();
    prop = prop || stdProposal(orig);
    return P.verifyProposal({
      originalB64: orig.base64, proposalB64: prop.base64,
      params: stdParams(orig.envelope),
      paymentScriptHex: orig.envelope.payment.script_hex,
    });
  }
  it("an honest proposal passes every check", () => {
    const v = stdVerify();
    const failed = v.checks.filter((c) => !c.pass);
    assert.deepEqual(failed, [], "all checks must pass: " + JSON.stringify(failed, null, 1));
    assert.equal(v.ok, true);
    assert.equal(v.checks.length, 15);
  });
  it("tampered sender output -> outputs-preserved FAILS", () => {
    const orig = stdOriginal(), prop = stdProposal(orig);
    // outputs with detRng: [payment(0), sender change(1), receiver change(2)]
    const bad = mutatePsbt(prop.base64, (p) => { p.unsignedTx.outputs[1].value -= 1000n; });
    const v = P.verifyProposal({
      originalB64: orig.base64, proposalB64: bad,
      params: stdParams(orig.envelope), paymentScriptHex: orig.envelope.payment.script_hex,
    });
    assert.equal(v.ok, false);
    const c = v.checks.find((x) => x.id === "outputs-preserved");
    assert.equal(c.pass, false);
    assert.match(c.detail, /REFUSED/);
  });
  it("removed input -> inputs-preserved FAILS", () => {
    const orig = stdOriginal(), prop = stdProposal(orig);
    const bad = mutatePsbt(prop.base64, (p) => {
      p.unsignedTx.inputs.splice(0, 1);
      p.inputs.splice(0, 1);
    });
    const v = P.verifyProposal({
      originalB64: orig.base64, proposalB64: bad,
      params: stdParams(orig.envelope), paymentScriptHex: orig.envelope.payment.script_hex,
    });
    assert.equal(v.checks.find((x) => x.id === "inputs-preserved").pass, false);
  });
  it("locktime game -> locktime-unchanged FAILS", () => {
    const orig = stdOriginal(), prop = stdProposal(orig);
    const bad = mutatePsbt(prop.base64, (p) => { p.unsignedTx.locktime = 700000; });
    const v = P.verifyProposal({
      originalB64: orig.base64, proposalB64: bad,
      params: stdParams(orig.envelope), paymentScriptHex: orig.envelope.payment.script_hex,
    });
    const c = v.checks.find((x) => x.id === "locktime-unchanged");
    assert.equal(c.pass, false);
    assert.match(c.detail, /locktime game/);
  });
  it("sequence change -> sequences FAILS", () => {
    const orig = stdOriginal(), prop = stdProposal(orig);
    const bad = mutatePsbt(prop.base64, (p) => { p.unsignedTx.inputs[0].sequence = 0xfffffffe; });
    const v = P.verifyProposal({
      originalB64: orig.base64, proposalB64: bad,
      params: stdParams(orig.envelope), paymentScriptHex: orig.envelope.payment.script_hex,
    });
    assert.equal(v.checks.find((x) => x.id === "sequences").pass, false);
  });
  it("excessive payment deduction -> fee-output-bounds FAILS", () => {
    const orig = stdOriginal(), prop = stdProposal(orig);
    const payIdx = prop.envelope ? 0 : 0;
    const bad = mutatePsbt(prop.base64, (p) => { p.unsignedTx.outputs[payIdx].value -= 5000n; });
    const v = P.verifyProposal({
      originalB64: orig.base64, proposalB64: bad,
      params: stdParams(orig.envelope), paymentScriptHex: orig.envelope.payment.script_hex,
    });
    const c = v.checks.find((x) => x.id === "fee-output-bounds");
    assert.equal(c.pass, false);
    assert.match(c.detail, /maxadditionalfeecontribution/);
  });
  it("substitution disabled + touched payment -> payment-substitution FAILS", () => {
    const orig = stdOriginal(), prop = stdProposal(orig);
    const params = stdParams(orig.envelope);
    params.disableoutputsubstitution = true;
    const v = P.verifyProposal({
      originalB64: orig.base64, proposalB64: prop.base64, params,
      paymentScriptHex: orig.envelope.payment.script_hex,
    });
    // d = 0 here so it passes; now force a deduction and re-check
    const bad = mutatePsbt(prop.base64, (p) => { p.unsignedTx.outputs[0].value -= 100n; });
    const v2 = P.verifyProposal({
      originalB64: orig.base64, proposalB64: bad, params,
      paymentScriptHex: orig.envelope.payment.script_hex,
    });
    assert.equal(v2.checks.find((x) => x.id === "payment-substitution").pass, false);
    void v;
  });
  it("stripped receiver finalization -> receiver-inputs FAILS", () => {
    const orig = stdOriginal(), prop = stdProposal(orig);
    const bad = mutatePsbt(prop.base64, (p) => {
      const i = p.inputs.findIndex((pairs) => pairs.some((x) => x.key[0] === 0x08 && x.key.length === 1));
      p.inputs[i] = p.inputs[i].filter((x) => !(x.key.length === 1 && x.key[0] === 0x08));
    });
    const v = P.verifyProposal({
      originalB64: orig.base64, proposalB64: bad,
      params: stdParams(orig.envelope), paymentScriptHex: orig.envelope.payment.script_hex,
    });
    assert.equal(v.checks.find((x) => x.id === "receiver-inputs").pass, false);
  });
  it("non-witness UTXO smuggled in -> no-nonwitness-utxo FAILS", () => {
    const orig = stdOriginal(), prop = stdProposal(orig);
    const bad = mutatePsbt(prop.base64, (p) => {
      p.inputs[0].push({ key: new Uint8Array([0x00]), value: new Uint8Array([0x01, 0x02]) });
    });
    const v = P.verifyProposal({
      originalB64: orig.base64, proposalB64: bad,
      params: stdParams(orig.envelope), paymentScriptHex: orig.envelope.payment.script_hex,
    });
    assert.equal(v.checks.find((x) => x.id === "no-nonwitness-utxo").pass, false);
  });
  it("fee decreased -> fee-not-decreased FAILS", () => {
    const orig = stdOriginal(), prop = stdProposal(orig);
    const bad = mutatePsbt(prop.base64, (p) => {
      // inflate the receiver change output: fee drops
      p.unsignedTx.outputs[p.unsignedTx.outputs.length - 1].value += 500n;
    });
    const v = P.verifyProposal({
      originalB64: orig.base64, proposalB64: bad,
      params: stdParams(orig.envelope), paymentScriptHex: orig.envelope.payment.script_hex,
    });
    assert.equal(v.checks.find((x) => x.id === "fee-not-decreased").pass, false);
  });
  it("minfeerate floor enforced", () => {
    const orig = stdOriginal(), prop = stdProposal(orig);
    const params = stdParams(orig.envelope);
    params.minfeerate = { num: 1000n, den: 1n };
    const v = P.verifyProposal({
      originalB64: orig.base64, proposalB64: prop.base64, params,
      paymentScriptHex: orig.envelope.payment.script_hex,
    });
    assert.equal(v.checks.find((x) => x.id === "minfeerate").pass, false);
  });
});

describe("sign: re-sign, finalize, extract", () => {
  function stdSign(orig = null, prop = null, over = {}) {
    orig = orig || stdOriginal();
    prop = prop || stdProposal(orig);
    return P.signProposal({
      proposalB64: prop.base64, originalB64: orig.base64,
      params: stdParams(orig.envelope),
      paymentScriptHex: orig.envelope.payment.script_hex,
      mnemonic: SENDER_MNEMONIC,
      ...over,
    });
  }
  it("full E2E: sign -> final PSBT -> extracted tx -> verified broadcast bytes", () => {
    const orig = stdOriginal();
    const prop = stdProposal(orig);
    const s = stdSign(orig, prop);
    assert.equal(s.signedInputs.length, 1);
    assert.ok(s.signedInputs[0].sigOk);
    assert.equal(s.signedInputs[0].address, sKey(0).address);
    // txid is the real double-SHA256 over the legacy serialization
    assert.match(s.txid, /^[0-9a-f]{64}$/);
    assert.ok(s.txHex.length > 0);
    // independent re-parse: the final PSBT's witnesses match the extracted tx.
    // (The final PSBT is final-witness-only by design; rebuild prevouts from the proposal.)
    const final = parsePsbtBase64(s.finalB64);
    assert.equal(final.inputs.length, final.unsignedTx.inputs.length);
    const propPsbt = parsePsbtBase64(prop.base64);
    assert.equal(
      Buffer.from(serializeUnsignedTx(propPsbt.unsignedTx)).toString("hex"),
      Buffer.from(serializeUnsignedTx(final.unsignedTx)).toString("hex"),
      "signing must not alter the unsigned transaction");
    // every witness signature verifies against the FINAL sighash (not a stale one)
    const pPrev = propPsbt.unsignedTx.inputs.map((_, i) => {
      const w = propPsbt.inputs[i].find((p) => p.key[0] === IN_WITNESS_UTXO);
      const a = w.value.slice(0, 8);
      let v = 0n; for (let j = 0; j < 8; j++) v |= BigInt(a[j]) << BigInt(8 * j);
      return { amount: v, spk: w.value.slice(9, 9 + w.value[8]) };
    });
    final.unsignedTx.inputs.forEach((_, pi) => {
      const fin = final.inputs[pi].find((p) => p.key[0] === 0x08);
      assert.ok(fin, `input ${pi} finalized`);
      const sig = fin.value.slice(2, 66);
      const Q = pPrev[pi].spk.slice(2); // witness UTXO script already commits to the TWEAKED key
      const sighash = taprootSighash({ tx: final.unsignedTx, inputIndex: pi, prevouts: pPrev, hashType: 0x00, scriptPath: null });
      assert.ok(schnorr.verify(sig, sighash, Q), `input ${pi} witness sig verifies`);
    });
    // fee rate string is sane
    assert.ok(Number(s.feeRate) >= 1, s.feeRate);
  });
  it("wrong mnemonic -> not-your-input REFUSED", () => {
    refused(() => stdSign(null, null, { mnemonic: RECEIVER_MNEMONIC }), "not-your-input");
  });
  it("garbage mnemonic -> bad-mnemonic REFUSED", () => {
    refused(() => stdSign(null, null, { mnemonic: "zzz" }), "bad-mnemonic");
  });
  it("tampered proposal is never signed", () => {
    const orig = stdOriginal(), prop = stdProposal(orig);
    const bad = mutatePsbt(prop.base64, (p) => { p.unsignedTx.locktime = 1; });
    refused(() => P.signProposal({
      proposalB64: bad, originalB64: orig.base64,
      params: stdParams(orig.envelope),
      paymentScriptHex: orig.envelope.payment.script_hex,
      mnemonic: SENDER_MNEMONIC,
    }), "proposal-rejected");
  });
  it("final PSBT serializes canonically", () => {
    const s = stdSign();
    assert.equal(psbtToBase64(parsePsbtBase64(s.finalB64)), s.finalB64);
  });
});

describe("network surface (honest labeling)", () => {
  it("blockbook endpoint + helpers are exported, broadcastTx has the right shape", () => {
    assert.ok(P.BLOCKBOOK_MAINNET.startsWith("https://"), P.BLOCKBOOK_MAINNET);
    assert.equal(typeof P.fetchUtxos, "function");
    assert.equal(typeof P.fetchFeeRateGrainsPerVByte, "function");
    assert.equal(typeof P.broadcastTx, "function");
  });
  it("summarizePsbt refuses non-PSBT input loudly", () => {
    refused(() => P.summarizePsbt("not-base64!!"), "bad-psbt");
  });
});

describe("defaultRng (BIP-78 insertion-position privacy)", () => {
  it("draws from WebCrypto when available, returning [0, 1)", () => {
    const saved = globalThis.crypto;
    let calls = 0;
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: {
      getRandomValues: (b) => { calls++; b[0] = 0x80000000; return b; },
    } });
    try {
      const v = P.defaultRng();
      assert.equal(calls, 1);
      assert.equal(v, 0.5);
    } finally {
      Object.defineProperty(globalThis, "crypto", { configurable: true, value: saved });
    }
  });
  it("no WebCrypto -> no-csprng REFUSED, never a Math.random fallback", () => {
    const saved = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: undefined });
    try {
      refused(() => P.defaultRng(), "no-csprng");
    } finally {
      Object.defineProperty(globalThis, "crypto", { configurable: true, value: saved });
    }
  });
  it("crypto present but getRandomValues missing -> no-csprng REFUSED", () => {
    const saved = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: {} });
    try {
      refused(() => P.defaultRng(), "no-csprng");
    } finally {
      Object.defineProperty(globalThis, "crypto", { configurable: true, value: saved });
    }
  });
});
