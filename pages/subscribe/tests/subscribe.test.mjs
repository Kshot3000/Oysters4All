// Pearl Subscribe verification suite — node --test, zero new deps.
// Run: node --no-warnings --loader ./tests/loader.mjs tests/subscribe.test.mjs
//
// Covers: terms validation (loud refusals), descriptor tamper-evidence,
// schedule math, funding plan exactness, the nLockTime keypath builder
// (byte-equality with the audited builder at locktime=0; INDEPENDENT
// TapSighash digest re-derivation with node:crypto for locktime!=0),
// sign/verify round-trips, tamper rejection, cancel math, and the
// per-period on-chain status classifier.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  NETWORKS,
  DUST_GRAIN,
  decodeBech32m,
  bytesToHex,
  hexToBytes,
  sha256,
  schnorr,
  taggedHash,
  tweakKeypath,
  tweakPrivKeypath,
  walletFromPriv,
  p2trScriptPubKey,
  keypathTxVBytes,
  u32le,
  u64le,
  varint,
  txidLE,
} from "../../sign/src/crypto.js";
import {
  fmtPRL,
  parsePRL,
  buildKeypathTxEx,
  verifySignedTx,
  decodeRawTx,
  selectCoins,
} from "../../sign/src/sign-core.js";
import {
  DESCRIPTOR_VERSION,
  BUNDLE_VERSION,
  BLOCK_TIME_S,
  MAX_PERIODS,
  MIN_PERIOD_BLOCKS,
  LOCKTIME_SEQ,
  FINAL_SEQ,
  PERIOD_PRESETS,
  canonicalJson,
  fingerprintOf,
  subscriberKeyFromInput,
  assertKeyMatchesAnchor,
  validateLocktime,
  validateTerms,
  periodLocktimes,
  makeDescriptor,
  parseDescriptor,
  paymentVBytes,
  cancelVBytes,
  feeReserveGrains,
  planFunding,
  buildKeypathTxLocktime,
  paymentTxPlan,
  signPaymentTxs,
  makeSignedBundle,
  parseSignedBundle,
  verifySignedBundle,
  verifySignedTxLocktime,
  buildCancelTx,
  periodStatuses,
} from "../src/subscribe-core.js";

const NW = NETWORKS.mainnet;
const K1 = "11".repeat(32); // subscriber (anchor) — deterministic, never funded
const K2 = "22".repeat(32); // merchant
const K3 = "33".repeat(32); // stranger (wrong key)

const anchorOf = (k) => walletFromPriv(hexToBytes(k), NW).address;
const ANCHOR = anchorOf(K1);
const MERCHANT = anchorOf(K2);

function goodTerms(over = {}) {
  return {
    network: "mainnet",
    merchant: MERCHANT,
    anchor: ANCHOR,
    amountGrains: 100_000_000, // 1 PRL
    periodBlocks: 3118,
    periods: 3,
    startHeight: 500000,
    feeRate: 5,
    ...over,
  };
}
const key1 = () => subscriberKeyFromInput(K1, NW);

/* ---------------- terms validation ---------------- */

test("validateTerms accepts good terms", () => {
  const { network } = validateTerms(goodTerms());
  assert.equal(network.hrp, "prl");
});

test("validateTerms refuses loudly: bad merchant / same address / dust / bounds", () => {
  assert.throws(() => validateTerms(goodTerms({ merchant: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4" })), /merchant address/);
  assert.throws(() => validateTerms(goodTerms({ merchant: ANCHOR })), /same address/);
  assert.throws(() => validateTerms(goodTerms({ amountGrains: 545 })), /dust/);
  assert.throws(() => validateTerms(goodTerms({ periods: 0 })), /periods/);
  assert.throws(() => validateTerms(goodTerms({ periods: 61 })), /periods/);
  assert.throws(() => validateTerms(goodTerms({ periodBlocks: 143 })), /period/);
  assert.throws(() => validateTerms(goodTerms({ feeRate: 0 })), /fee rate/);
  assert.throws(() => validateTerms(goodTerms({ network: "bogus" })), /unknown network/);
  assert.throws(() => validateTerms(goodTerms({ startHeight: 500_000_000 })), /start height/);
});

test("validateLocktime enforces height range", () => {
  assert.throws(() => validateLocktime(0), /block height/);
  assert.throws(() => validateLocktime(500_000_000), /block height/);
  validateLocktime(1); validateLocktime(499_999_999);
});

test("subscriberKeyFromInput + address-match guard", () => {
  const k = key1();
  assert.equal(k.keypathAddress, ANCHOR);
  assertKeyMatchesAnchor(k, ANCHOR, NW);
  const wrong = subscriberKeyFromInput(K3, NW);
  assert.throws(() => assertKeyMatchesAnchor(wrong, ANCHOR, NW), /KEY MISMATCH/);
  assert.throws(() => subscriberKeyFromInput("nope", NW), /not recognized/);
});

/* ---------------- descriptor ---------------- */

test("descriptor: fingerprint stable + tamper-evident", () => {
  const a = makeDescriptor(goodTerms());
  const b = makeDescriptor(goodTerms());
  assert.equal(a.fingerprint, b.fingerprint);
  assert.match(a.fingerprint, /^[0-9a-f]{16}$/);
  assert.deepEqual(a.schedule, [500000, 503118, 506236]);
  const parsed = parseDescriptor(JSON.stringify(a.descriptor));
  assert.equal(parsed.fingerprint, a.fingerprint);
  const evil = { ...a.descriptor, amountGrains: 1 };
  assert.throws(() => parseDescriptor(JSON.stringify(evil)), /TAMPERED/);
  assert.throws(() => parseDescriptor('{"v":"nope"}'), /pearl-sub:v1/);
});

test("canonicalJson is key-order independent", () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
  assert.equal(fingerprintOf("x").length, 16);
});

/* ---------------- schedule + funding plan ---------------- */

test("period presets derive from the 194s block target", () => {
  const weekly = PERIOD_PRESETS.find((p) => p.key === "weekly");
  assert.ok(Math.abs(weekly.blocks * BLOCK_TIME_S - 7 * 86400) < BLOCK_TIME_S * 2);
  const monthly = PERIOD_PRESETS.find((p) => p.key === "monthly");
  assert.ok(Math.abs(monthly.blocks * BLOCK_TIME_S - 30 * 86400) < BLOCK_TIME_S * 2);
});

test("planFunding: exact per-output and total math", () => {
  const plan = planFunding(goodTerms());
  assert.equal(plan.paymentVBytes, 154); // audited keypathTxVBytes(1,2)
  assert.equal(plan.feeReserveGrains, 770n); // 154 * 5
  assert.equal(plan.perOutputGrains, 100_000_770n);
  assert.equal(plan.outputs.length, 3);
  assert.ok(plan.outputs.every((o) => o.address === ANCHOR && o.value === 100_000_770n));
  assert.equal(plan.totalGrains, 300_002_310n);
});

/* ---------------- the nLockTime builder ---------------- */

function fixtureTxParts() {
  const k = key1();
  const anchorSpk = p2trScriptPubKey(tweakKeypath(k.internalXOnly).tweakedX);
  const mProg = decodeBech32m(MERCHANT, "prl").program;
  const aProg = decodeBech32m(ANCHOR, "prl").program;
  const inputs = [{ txid: "aa".repeat(32), vout: 0, value: 100_000_770, priv: k.priv, internalXOnly: k.internalXOnly }];
  const outputs = [{ program: mProg, value: 100_000_000 }, { program: aProg, value: 770 }];
  return { k, inputs, outputs, anchorSpk };
}

test("buildKeypathTxLocktime at locktime=0 is byte-identical to the audited builder", () => {
  const { inputs, outputs } = fixtureTxParts();
  const mine = buildKeypathTxLocktime(NW, inputs, outputs, { locktime: 0, sequence: FINAL_SEQ });
  const audited = buildKeypathTxEx(NW, inputs.map((i) => ({ ...i, spk: p2trScriptPubKey(tweakKeypath(i.internalXOnly).tweakedX) })), outputs);
  assert.equal(mine.hex, audited.hex);
  assert.equal(mine.txid, audited.txid);
});

test("independent TapSighash re-derivation: locktime is committed in the digest", () => {
  // Rebuild the BIP-341 message by hand with node:crypto (independent of noble),
  // then check the builder's emitted signature verifies against it.
  const { k, outputs } = fixtureTxParts();
  const locktime = 500000;
  const seq = LOCKTIME_SEQ;
  const spk = p2trScriptPubKey(tweakKeypath(k.internalXOnly).tweakedX);
  const inputs = [{ txid: "aa".repeat(32), vout: 0, value: 100_000_770, spk }];
  const sha = (b) => createHash("sha256").update(b).digest();
  const msg = Buffer.concat([
    Buffer.from([0x00, 0x00]),
    Buffer.from(u32le(NW.txVersion)),
    Buffer.from(u32le(locktime)),
    sha(Buffer.concat([Buffer.from(txidLE(inputs[0].txid)), Buffer.from(u32le(0))])),
    sha(Buffer.from(u64le(inputs[0].value))),
    sha(Buffer.concat([Buffer.from(varint(spk.length)), Buffer.from(spk)])),
    sha(Buffer.from(u32le(seq))),
    sha(Buffer.concat(outputs.flatMap((o) => {
      const s = p2trScriptPubKey(o.program);
      return [Buffer.from(u64le(o.value)), Buffer.from(varint(s.length)), Buffer.from(s)];
    }))),
    Buffer.from([0x00]),
    Buffer.from(u32le(0)),
  ]);
  const tagHash = sha(Buffer.from("TapSighash", "utf8"));
  const digest = sha(Buffer.concat([tagHash, tagHash, msg]));
  const built = buildKeypathTxLocktime(NW, [{
    txid: "aa".repeat(32), vout: 0, value: 100_000_770, priv: k.priv, internalXOnly: k.internalXOnly,
  }], outputs, { locktime, sequence: seq });
  const dec = decodeRawTx(built.hex);
  assert.equal(dec.locktime, locktime);
  assert.equal(dec.inputs[0].sequence, seq);
  const sig = Buffer.from(dec.witness[0][0]);
  assert.equal(sig.length, 64);
  const tweaked = tweakPrivKeypath(k.priv, k.internalXOnly);
  const tweakedPub = Buffer.from(schnorr.getPublicKey(tweaked));
  assert.ok(schnorr.verify(sig, digest, tweakedPub), "signature must verify against the independently derived digest");
  // and the independent txid preimage matches too
  const core = Buffer.concat([
    Buffer.from(u32le(NW.txVersion)), Buffer.from([0x01]),
    Buffer.from(txidLE(inputs[0].txid)), Buffer.from(u32le(0)), Buffer.from([0x00]), Buffer.from(u32le(seq)),
    Buffer.from([outputs.length]),
    ...outputs.flatMap((o) => {
      const s = p2trScriptPubKey(o.program);
      return [Buffer.from(u64le(o.value)), Buffer.from(varint(s.length)), Buffer.from(s)];
    }),
    Buffer.from(u32le(locktime)),
  ]);
  const txid = Buffer.from(sha(sha(core))).reverse().toString("hex");
  assert.equal(txid, built.txid);
});

test("verifySignedTxLocktime agrees with the audited verifier at locktime=0", () => {
  const { k, inputs, outputs, anchorSpk } = fixtureTxParts();
  const built = buildKeypathTxEx(NW, inputs.map((i) => ({ ...i, spk: anchorSpk })), outputs);
  const prevouts = [{ value: inputs[0].value, spk: anchorSpk }];
  const a = verifySignedTx(NW, built.hex, prevouts);
  const m = verifySignedTxLocktime(NW, built.hex, prevouts);
  assert.ok(a.every((r) => r.ok), "audited verifier passes");
  assert.deepEqual(m.map((r) => r.ok), a.map((r) => r.ok), "locktime-aware verifier agrees at locktime=0");
});

test("tampered locktime byte fails signature re-verification", () => {
  const { k, outputs, anchorSpk } = fixtureTxParts();
  const built = buildKeypathTxLocktime(NW, [{
    txid: "aa".repeat(32), vout: 0, value: 100_000_770, priv: k.priv, internalXOnly: k.internalXOnly,
  }], outputs, { locktime: 500000, sequence: LOCKTIME_SEQ });
  const prevouts = [{ value: 100_000_770, spk: anchorSpk }];
  const good = verifySignedTxLocktime(NW, built.hex, prevouts);
  assert.ok(good.every((r) => r.ok), "untampered locked tx verifies: " + good.map((r) => r.reason).join(";"));
  const evil = hexToBytes(built.hex);
  evil[evil.length - 1] ^= 0x01; // flip top locktime byte
  const vr = verifySignedTxLocktime(NW, bytesToHex(evil), prevouts);
  assert.ok(vr.every((r) => !r.ok), "tampered locktime must not verify");
});

/* ---------------- payment signing ---------------- */

test("signPaymentTxs: N locked payments, txids precomputed, key wiped", () => {
  const terms = goodTerms();
  const k = key1();
  const privCopy = Uint8Array.from(k.priv);
  const { payments } = signPaymentTxs(terms, "bb".repeat(32), k);
  assert.equal(payments.length, 3);
  assert.deepEqual(payments.map((p) => p.locktime), [500000, 503118, 506236]);
  // txid was computable before signing (witness-independent)
  for (let i = 0; i < 3; i++) {
    const plan = paymentTxPlan(terms, "bb".repeat(32), i);
    assert.equal(payments[i].txid, plan.txid);
    const dec = decodeRawTx(payments[i].hex);
    assert.equal(dec.locktime, plan.locktime);
    assert.equal(dec.inputs[0].sequence, LOCKTIME_SEQ);
    assert.equal(dec.inputs[0].txid, "bb".repeat(32));
    assert.equal(dec.inputs[0].vout, i);
  }
  // key wiped
  assert.ok(k.priv.every((b) => b === 0), "key material must be zeroed after signing");
  assert.ok(privCopy.some((b) => b !== 0), "sanity: the test key was non-zero");
});

test("signPaymentTxs refuses wrong key before touching crypto", () => {
  assert.throws(() => signPaymentTxs(goodTerms(), "bb".repeat(32), subscriberKeyFromInput(K3, NW)), /KEY MISMATCH/);
});

test("paymentTxPlan: fee math exact, change and dust handling", () => {
  const plan = paymentTxPlan(goodTerms(), "bb".repeat(32), 0);
  assert.equal(plan.inputValue, 100_000_770);
  assert.equal(plan.merchantValue, 100_000_000);
  assert.equal(plan.feeGrains, 770); // 154 vB * 5, change exactly 0
  assert.equal(plan.changeValue, 0);
  assert.equal(plan.outputs.length, 1);
});

/* ---------------- signed bundle verify ---------------- */

test("makeSignedBundle + verifySignedBundle round-trip", () => {
  const terms = goodTerms();
  const { payments } = signPaymentTxs(terms, "bb".repeat(32), key1());
  const { bundle, json } = makeSignedBundle(terms, "bb".repeat(32), payments);
  assert.equal(bundle.v, BUNDLE_VERSION);
  const res = verifySignedBundle(json);
  assert.ok(res.ok, "bundle should verify: " + res.failures.join("; "));
  assert.equal(res.checks.length, 4); // descriptor + 3 periods
});

test("verifySignedBundle rejects: tampered amount, swapped locktime, wrong sequence", () => {
  const terms = goodTerms();
  const { payments } = signPaymentTxs(terms, "bb".repeat(32), key1());
  const { json } = makeSignedBundle(terms, "bb".repeat(32), payments);
  const tamperHex = (fn) => {
    const b = JSON.parse(json);
    b.payments[1].hex = fn(b.payments[1].hex);
    return JSON.stringify(b);
  };
  // 1. flip merchant output value bytes (amount tamper)
  let r = verifySignedBundle(tamperHex((h) => {
    const b = hexToBytes(h); b[60] ^= 0x01; return bytesToHex(b);
  }));
  assert.ok(!r.ok, "amount tamper must fail");
  // 2. bundle lies about locktime
  const b2 = JSON.parse(json);
  b2.payments[0].locktime += 1;
  r = verifySignedBundle(JSON.stringify(b2));
  assert.ok(!r.ok && r.failures.some((f) => /locktime/.test(f)), "locktime lie must fail: " + r.failures.join(";"));
  // 3. bundle with tampered descriptor
  const b3 = JSON.parse(json);
  b3.descriptor.amountGrains = 1;
  r = verifySignedBundle(JSON.stringify(b3));
  assert.ok(!r.ok, "descriptor tamper must fail");
  assert.throws(() => parseSignedBundle('{"v":"nope"}'), /pearl-sub-bundle/);
});

/* ---------------- cancel ---------------- */

test("buildCancelTx: reclaims funding output minus exact fee", () => {
  const terms = goodTerms();
  const { txid, hex, feeGrains, reclaimedGrains } = buildCancelTx(terms, "bb".repeat(32), 1, key1());
  assert.equal(feeGrains, cancelVBytes() * 5);
  assert.equal(reclaimedGrains, 100_000_770 - feeGrains);
  const dec = decodeRawTx(hex);
  assert.equal(dec.locktime, 0);
  assert.equal(dec.inputs[0].vout, 1);
  assert.equal(Number(dec.outputs[0].value), reclaimedGrains);
  const anchorSpk = p2trScriptPubKey(decodeBech32m(ANCHOR, "prl").program);
  const vr = verifySignedTx(NW, hex, [{ value: 100_000_770, spk: anchorSpk }]);
  assert.ok(vr.every((r) => r.ok));
  assert.equal(dec.txid, txid);
});

/* ---------------- period statuses ---------------- */

test("periodStatuses classifies upcoming/due/paid/cancelled/unknown", () => {
  const terms = goodTerms();
  const fundingDetail = {
    vout: [
      { n: 0, spent: false },
      { n: 1, spent: false },
      { n: 2, spent: true, spentTxId: "cc".repeat(32) }, // the pre-signed payment
    ],
  };
  const expected = ["cc".repeat(32), undefined, "cc".repeat(32)];
  // tip below first locktime: all unspent upcoming
  let st = periodStatuses(terms, fundingDetail, 499000, expected);
  assert.deepEqual(st.map((s) => s.state), ["upcoming", "upcoming", "paid"]);
  // tip past first two locktimes
  st = periodStatuses(terms, fundingDetail, 504000, expected);
  assert.deepEqual(st.map((s) => s.state), ["due", "due", "paid"]);
  // spent by something else = cancelled (reclaimed/double-spent)
  const fd2 = { vout: [{ n: 0, spent: true, spentTxId: "dd".repeat(32) }] };
  st = periodStatuses(terms, fd2, 499000, expected);
  assert.equal(st[0].state, "cancelled");
  assert.equal(st[1].state, "unknown");
});

/* ---------------- misc ---------------- */

test("PRL parse/format round-trip", () => {
  assert.equal(parsePRL("1.5"), 150_000_000n);
  assert.equal(fmtPRL(150_000_000n), "1.5");
  assert.throws(() => parsePRL("abc"), /invalid/);
});

test("selectCoins covers the funding total (audited path)", () => {
  const plan = planFunding(goodTerms({ periods: 2 }));
  const utxos = [
    { txid: "aa".repeat(32), vout: 0, value: 150_000_000n, confirmations: 6 },
    { txid: "bb".repeat(32), vout: 1, value: 200_000_000n, confirmations: 6 },
  ];
  const sel = selectCoins(utxos, plan.totalGrains, 5, plan.outputs.length);
  assert.ok(sel.selected.reduce((a, u) => a + u.value, 0n) >= plan.totalGrains + sel.fee);
});
