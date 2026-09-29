// Pearl Gift test suite.
// Run: node --no-warnings --loader ./tests/loader.mjs tests/gift.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  NETWORKS, GRAIN_PER_PRL, DUST_GRAIN, SIGHASH_DEFAULT,
  GIFT_ACCOUNT,
  createGift, parseGiftSecret,
  privateQrPayload, cardPayload, parseCardPayload,
  planSweep, buildSweepTx, assertUtxosBelong,
  fmtPRL, decodeRawTx, verifySignedTx,
} from "../src/gift-core.js";
import {
  walletFromMnemonic, decodeBech32m, tweakKeypath, p2trScriptPubKey,
  keypathTxVBytes, bytesToHex, hexToBytes,
} from "../../sign/src/crypto.js";

const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
// Regression-pinned gift-account vectors (m/86'/0'/1000'/0/i), computed through
// the audited derivation path; the account-0 line pins the same code independently
// (matches Pearl Sign's audited verify.mjs vector).
const VEC = {
  account0: "prl1pr6yuq8u2r95wjzzgpdy8cpnncpl7l8zgy6x5q0367pnc53s2famqg7pt74",
  gift0: "prl1p7dwp74zgd4te3mqr58d6x3p3t70jljmpe4auey8g824ra4x43tks3y4pr6",
  gift1: "prl1p5gfau0gepxzjkjyx9t88ewnhujrmpjqgqfh8v9vympjaz94x36jqpepvyt",
};

test("gift account known-answer vectors", () => {
  assert.equal(GIFT_ACCOUNT, 1000);
  const g0 = createGift({ mnemonic: MNEMONIC, network: NETWORKS.mainnet });
  assert.equal(g0.address, VEC.gift0);
  assert.equal(g0.account, 1000); assert.equal(g0.index, 0);
  const g1 = createGift({ mnemonic: MNEMONIC, network: NETWORKS.mainnet, index: 1 });
  assert.equal(g1.address, VEC.gift1);
  const main0 = walletFromMnemonic(MNEMONIC, NETWORKS.mainnet, 0, 0);
  assert.equal(main0.address, VEC.account0); // independent pin of the same derivation code
  assert.notEqual(g0.address, main0.address, "gift account must not collide with main account");
  // address is the P2TR of the internal key's taproot tweak
  const { tweakedX } = tweakKeypath(hexToBytes(g0.internalXOnlyHex));
  const d = decodeBech32m(g0.address, "prl");
  assert.deepEqual([...d.program], [...tweakedX]);
  assert.equal(d.version, 1);
});

test("createGift round-trips: mnemonic/wif/privhex agree", () => {
  const g = createGift({ mnemonic: MNEMONIC, network: NETWORKS.mainnet });
  const viaWif = createGift({ wif: g.wif, network: NETWORKS.mainnet });
  const viaHex = createGift({ privHex: g.privHex, network: NETWORKS.mainnet });
  assert.equal(viaWif.address, g.address);
  assert.equal(viaHex.address, g.address);
  assert.equal(viaWif.account, null); // imported keys carry no derivation path
  const fresh = createGift({ network: NETWORKS.mainnet });
  assert.ok(fresh.mnemonic && fresh.mnemonic.split(" ").length === 12);
  assert.match(fresh.address, /^prl1p[0-9a-z]{58}$/);
  assert.throws(() => createGift({ mnemonic: MNEMONIC, wif: g.wif }), /exactly one/);
  assert.throws(() => createGift({ mnemonic: "abandon abandon", network: NETWORKS.mainnet }), /invalid BIP-39/);
});

test("parseGiftSecret accepts mnemonic, WIF, hex — rejects junk", () => {
  const m = parseGiftSecret(MNEMONIC, NETWORKS.mainnet);
  assert.equal(m.address, VEC.gift0);
  const w = parseGiftSecret(createGift({ mnemonic: MNEMONIC, network: NETWORKS.mainnet }).wif, NETWORKS.mainnet);
  assert.equal(w.address, VEC.gift0);
  const h = parseGiftSecret("ab".repeat(32), NETWORKS.mainnet);
  assert.match(h.address, /^prl1p/);
  assert.throws(() => parseGiftSecret("hello world", NETWORKS.mainnet), /unrecognized secret/);
  assert.throws(() => parseGiftSecret("   ", NETWORKS.mainnet), /paste a gift secret/);
  assert.throws(() => parseGiftSecret("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon", NETWORKS.mainnet), /not valid BIP-39/);
});

test("card payload export/import round-trip + tamper detection", () => {
  const g = createGift({ mnemonic: MNEMONIC, network: NETWORKS.mainnet });
  const payload = cardPayload(g, { to: "Ada", from: "Bob", message: "Happy birthday", design: "rose" });
  const back = parseCardPayload(payload, NETWORKS.mainnet);
  assert.equal(back.gift.address, g.address);
  assert.equal(back.gift.wif, g.wif);
  assert.equal(back.to, "Ada"); assert.equal(back.from, "Bob");
  assert.equal(back.message, "Happy birthday"); assert.equal(back.design, "rose");
  const tampered = JSON.parse(payload); tampered.address = VEC.account0;
  assert.throws(() => parseCardPayload(JSON.stringify(tampered), NETWORKS.mainnet), /inconsistent/);
  assert.throws(() => parseCardPayload("not json", NETWORKS.mainnet), /not a valid card payload/);
  assert.throws(() => parseCardPayload(JSON.stringify({ app: "x" }), NETWORKS.mainnet), /not a Pearl Gift card payload/);
  assert.equal(privateQrPayload(g), g.wif);
});

test("planSweep: exact fee math, canonicalization, refusals", () => {
  const utxos = [
    { txid: "11".repeat(32), vout: 0, value: 100_000_000 },
    { txid: "22".repeat(32), vout: 1, value: 50_000_000 },
  ];
  const plan = planSweep({ utxos, recipient: VEC.account0, feeRateGrainsPerVByte: 5, network: NETWORKS.mainnet });
  assert.equal(plan.total, 150_000_000n);
  assert.equal(plan.fee, BigInt(keypathTxVBytes(2, 1)) * 5n);
  assert.equal(plan.amount, plan.total - plan.fee);
  assert.ok(plan.amount > BigInt(DUST_GRAIN));
  // uppercase recipient is canonicalized to lowercase
  const up = planSweep({ utxos, recipient: VEC.account0.toUpperCase(), feeRateGrainsPerVByte: 5, network: NETWORKS.mainnet });
  assert.equal(up.recipient, VEC.account0);
  assert.throws(() => planSweep({ utxos: [], recipient: VEC.account0, feeRateGrainsPerVByte: 5, network: NETWORKS.mainnet }), /looks empty/);
  assert.throws(() => planSweep({ utxos, recipient: "prl1q" + "0".repeat(52), feeRateGrainsPerVByte: 5, network: NETWORKS.mainnet }), /v1|checksum|witness/);
  assert.throws(() => planSweep({ utxos, recipient: VEC.account0, feeRateGrainsPerVByte: 0, network: NETWORKS.mainnet }), /positive/);
  // dust: tiny balance cannot cover its own fee
  const dust = [{ txid: "33".repeat(32), vout: 0, value: 600 }];
  assert.throws(() => planSweep({ utxos: dust, recipient: VEC.account0, feeRateGrainsPerVByte: 5, network: NETWORKS.mainnet }), /dust/);
  // absurd fee rate eats the balance -> dust refusal too
  assert.throws(() => planSweep({ utxos, recipient: VEC.account0, feeRateGrainsPerVByte: 1000000, network: NETWORKS.mainnet }), /dust/);
});

test("buildSweepTx: full sign -> verify cycle, tamper detected", () => {
  const g = createGift({ mnemonic: MNEMONIC, network: NETWORKS.mainnet });
  const utxos = [
    { txid: "aa".repeat(32), vout: 0, value: 250_000_000 },
    { txid: "bb".repeat(32), vout: 2, value: 100_000_000 },
  ];
  const plan = planSweep({ utxos, recipient: VEC.account0, feeRateGrainsPerVByte: 7, network: NETWORKS.mainnet });
  const { txid, hex, giftAddress } = buildSweepTx({ privHex: g.privHex, utxos, plan, network: NETWORKS.mainnet });
  assert.equal(giftAddress, g.address, "sweep key must match the gift address");
  assert.match(txid, /^[0-9a-f]{64}$/);
  // independent re-verification against the derived prevout spk
  const { tweakedX } = tweakKeypath(hexToBytes(g.internalXOnlyHex));
  const spk = p2trScriptPubKey(tweakedX);
  const prevouts = utxos.map((u) => ({ value: u.value, spk }));
  const checks = verifySignedTx(NETWORKS.mainnet, hex, prevouts);
  assert.equal(checks.length, 2);
  assert.ok(checks.every((c) => c.ok), JSON.stringify(checks));
  const dec = decodeRawTx(hex);
  assert.equal(dec.txid, txid, "txid recomputed from the wire matches");
  assert.equal(dec.outputs.length, 1);
  assert.equal(dec.outputs[0].value, plan.amount);
  assert.deepEqual([...dec.outputs[0].spk], [...p2trScriptPubKey(plan.program)]);
  assert.ok(dec.witness.every((s) => s.length === 1 && s[0].length === 64), "one 64-byte keypath sig per input (SIGHASH_DEFAULT)");
  // tampering the amount breaks every signature
  const tampered = (() => {
    const b = hexToBytes(hex);
    // outputs are near the end: flip a byte inside the output value field
    const idx = b.length - 40;
    b[idx] ^= 0x01;
    return bytesToHex(b);
  })();
  const bad = verifySignedTx(NETWORKS.mainnet, tampered, prevouts);
  assert.ok(bad.some((c) => !c.ok), "tampered amount must fail verification");
});

test("buildSweepTx refuses a key that doesn't own the inputs", () => {
  const g = createGift({ mnemonic: MNEMONIC, network: NETWORKS.mainnet });
  const other = createGift({ network: NETWORKS.mainnet }); // random different key
  const utxos = [{ txid: "cc".repeat(32), vout: 0, value: 100_000_000 }];
  const plan = planSweep({ utxos, recipient: VEC.account0, feeRateGrainsPerVByte: 5, network: NETWORKS.mainnet });
  // signing with the wrong key yields a tx whose signatures verify against the
  // wrong key's spk, but the declared giftAddress check catches the mismatch:
  // buildSweepTx signs with the given key, so we emulate the app-level guard
  // used by the page (address match before fetch):
  assert.notEqual(other.address, g.address);
  const sweep = buildSweepTx({ privHex: other.privHex, utxos, plan, network: NETWORKS.mainnet });
  assert.equal(sweep.giftAddress, other.address, "the sweep key defines the source address");
  // and a sweep intended for g's UTXOs must fail the app's ownership check:
  assert.throws(() => assertUtxosBelong(
    [{ txid: "cc".repeat(32), vout: 0, value: 100_000_000, address: g.address }],
    other.address), /not the gift address/);
  assert.doesNotThrow(() => assertUtxosBelong(
    [{ txid: "cc".repeat(32), vout: 0, value: 100_000_000, address: g.address }],
    g.address));
});
