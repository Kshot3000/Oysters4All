// Pearl Rain test suite.
// Run: node --no-warnings --loader ./tests/loader.mjs tests/rain.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  NETWORKS, GRAIN_PER_PRL, DUST_GRAIN, SIGHASH_DEFAULT,
  RAIN_ACCOUNT, MAX_OUTPUTS,
  parseRainSecret, parseRecipients, sampleRainCsv, assertUtxosBelong,
  parseManualUtxos,
  planRain, buildRainTx,
  fmtPRL, parsePRL, decodeRawTx, verifySignedTx,
} from "../src/rain-core.js";
import {
  walletFromMnemonic, walletFromWIF, decodeBech32m, tweakKeypath, p2trScriptPubKey,
  keypathTxVBytes, bytesToHex, hexToBytes,
} from "../../sign/src/crypto.js";

const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
// Known-answer vector: m/86'/0'/0'/0/0 of the abandon mnemonic (matches Pearl
// Sign's audited vector for the same derivation path).
const ACCOUNT0 = "prl1pr6yuq8u2r95wjzzgpdy8cpnncpl7l8zgy6x5q0367pnc53s2famqg7pt74";
const R1 = "prl1p7dwp74zgd4te3mqr58d6x3p3t70jljmpe4auey8g824ra4x43tks3y4pr6";
const R2 = "prl1p5gfau0gepxzjkjyx9t88ewnhujrmpjqgqfh8v9vympjaz94x36jqpepvyt";
const WRONG_MNEMONIC = "legal winner thank year wave sausage worth useful legal winner thank yellow";

test("parseRainSecret: known-answer funder vector + secret forms", () => {
  assert.equal(RAIN_ACCOUNT, 0);
  const f = parseRainSecret(MNEMONIC, NETWORKS.mainnet);
  assert.equal(f.address, ACCOUNT0);
  assert.equal(f.account, 0); assert.equal(f.index, 0);
  const d = decodeBech32m(f.address, "prl");
  assert.equal(d.version, 1); assert.equal(d.program.length, 32);
  const viaWif = parseRainSecret(f.wif, NETWORKS.mainnet);
  assert.equal(viaWif.address, f.address);
  const viaHex = parseRainSecret(f.privHex, NETWORKS.mainnet);
  assert.equal(viaHex.address, f.address);
  // not the gift account
  const gift = walletFromMnemonic(MNEMONIC, NETWORKS.mainnet, 1000, 0);
  assert.notEqual(f.address, gift.address, "funder must use account 0, not the gift account");
});

test("parseRainSecret: bad secrets rejected", () => {
  assert.throws(() => parseRainSecret(""), /paste the funder secret/);
  assert.throws(() => parseRainSecret("obviously not a key"), /unrecognized secret/);
  assert.throws(() => parseRainSecret("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon"), /not valid BIP-39/);
});

test("parseRecipients: formats, units, merge, dust, rejects", () => {
  const { recipients, merged } = parseRecipients(`${R1} 1.25\n${R2},0.5`, NETWORKS.mainnet);
  assert.equal(recipients.length, 2); assert.equal(merged, 0);
  assert.equal(recipients[0].address, R1);
  assert.equal(recipients[0].amount, 125000000n);
  assert.equal(recipients[1].amount, 50000000n);

  const grains = parseRecipients(`${R1} 546 grains`, NETWORKS.mainnet);
  assert.equal(grains.recipients[0].amount, 546n, "exact dust floor allowed");
  assert.throws(() => parseRecipients(`${R1} 545 grains`, NETWORKS.mainnet), /below the dust floor/);
  assert.throws(() => parseRecipients(`${R1} 0`, NETWORKS.mainnet), /must be positive/);
  assert.throws(() => parseRecipients(`${R1}`, NETWORKS.mainnet), /need "<address> <amount>"/);
  assert.throws(() => parseRecipients(`bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4 1`, NETWORKS.mainnet), /not a valid prl1 address/);
  assert.throws(() => parseRecipients(`notanaddress 1`, NETWORKS.mainnet), /not a valid prl1 address/);
  assert.throws(() => parseRecipients(`${R1} 1 peanuts`, NETWORKS.mainnet), /unknown unit/);
  assert.throws(() => parseRecipients(``, NETWORKS.mainnet), /no recipients/);

  // duplicates merge into one output
  const m = parseRecipients(`${R1} 1\n# a comment\n${R2} 2\n${R1} 0.5`, NETWORKS.mainnet);
  assert.equal(m.recipients.length, 2);
  assert.equal(m.merged, 1);
  assert.equal(m.recipients[0].amount, 150000000n, "1 + 0.5 merged");

  // too many unique recipients refused
  const many = Array.from({ length: MAX_OUTPUTS + 1 }, (_, i) => {
    const { address } = walletFromMnemonic(MNEMONIC, NETWORKS.mainnet, 0, i + 1);
    return `${address} 0.001`;
  }).join("\n");
  assert.throws(() => parseRecipients(many, NETWORKS.mainnet), new RegExp(`max ${MAX_OUTPUTS}`));

  // the shipped sample parses cleanly
  const s = parseRecipients(sampleRainCsv(), NETWORKS.mainnet);
  assert.equal(s.recipients.length, 3);
  assert.equal(s.recipients[0].amount, 125000000n);
});

test("planRain: exact fee math with change", () => {
  const utxos = [{ txid: "aa".repeat(32), vout: 0, value: 1_000_000_000 }];
  const { recipients } = parseRecipients(`${R1} 1.25\n${R2} 0.5`, NETWORKS.mainnet);
  const f = parseRainSecret(MNEMONIC, NETWORKS.mainnet);
  const plan = planRain({ utxos, recipients, funderProgram: f.program, feeRateGrainsPerVByte: 5 });
  assert.equal(plan.nIn, 1); assert.equal(plan.nOut, 3, "2 recipients + change");
  assert.equal(plan.vBytes, keypathTxVBytes(1, 3));
  assert.equal(plan.fee, BigInt(plan.vBytes) * 5n);
  assert.equal(plan.sumOut, 175000000n);
  assert.equal(plan.change, 1_000_000_000n - 175000000n - plan.fee);
  assert.equal(plan.changeDropped, false);
  assert.equal(plan.outputs.filter((o) => o.change).length, 1);
  assert.equal(plan.outputs[2].address, f.address, "change returns to funder");
  // accounting closes exactly
  assert.equal(plan.total, plan.sumOut + plan.fee + plan.change);
});

test("planRain: dust change is absorbed into the fee; insufficient funds refused", () => {
  const f = parseRainSecret(MNEMONIC, NETWORKS.mainnet);
  const { recipients } = parseRecipients(`${R1} 1`, NETWORKS.mainnet);
  // total lands the change just under dust -> no change output, extra fee
  const vWithChange = keypathTxVBytes(1, 2);
  const feeWithChange = BigInt(vWithChange) * 5n;
  const dustChange = 100n;
  const total = 100000000n + feeWithChange + dustChange;
  const plan = planRain({
    utxos: [{ txid: "bb".repeat(32), vout: 0, value: Number(total) }],
    recipients, funderProgram: f.program, feeRateGrainsPerVByte: 5,
  });
  assert.equal(plan.changeDropped, true);
  assert.equal(plan.nOut, 1, "no change output");
  assert.equal(plan.fee, BigInt(keypathTxVBytes(1, 1)) * 5n, "fee recomputed for N outputs");
  assert.ok(plan.feeBump > 0n, "dust remainder becomes fee");

  // truly short: refuse with a useful message
  assert.throws(
    () => planRain({ utxos: [{ txid: "cc".repeat(32), vout: 0, value: 100000000 }], recipients, funderProgram: f.program, feeRateGrainsPerVByte: 5 }),
    /insufficient funds: have 1 PRL, need 1\.0\d+ PRL/,
  );
});

test("parseManualUtxos keeps addresses for the belong-check", () => {
  const f = parseRainSecret(MNEMONIC, NETWORKS.mainnet);
  const lines = `${"aa".repeat(32)}:0 250000000 ${f.address}\n${"bb".repeat(32)}:1 2.5 prl`;
  const u = parseManualUtxos(lines, NETWORKS.mainnet);
  assert.equal(u.length, 2);
  assert.equal(u[0].address, f.address);
  assert.equal(u[0].value, 250000000);
  assert.equal(u[1].value, 250000000, "2.5 prl -> grains");
  assert.equal(u[1].address, null);
  assert.doesNotThrow(() => assertUtxosBelong(u, f.address));
  assert.throws(() => parseManualUtxos(`${"aa".repeat(32)}:0 250000000 notanaddress`, NETWORKS.mainnet), /bad address/);
  assert.throws(() => parseManualUtxos("garbage line", NETWORKS.mainnet), /bad utxo line/);
  assert.throws(() => parseManualUtxos("", NETWORKS.mainnet), /at least one UTXO/);
});

test("assertUtxosBelong rejects foreign utxos", () => {
  const f = parseRainSecret(MNEMONIC, NETWORKS.mainnet);
  assert.doesNotThrow(() => assertUtxosBelong([{ txid: "aa".repeat(32), vout: 0, value: 1, address: f.address }], f.address));
  assert.throws(
    () => assertUtxosBelong([{ txid: "aa".repeat(32), vout: 0, value: 1, address: R1 }], f.address),
    /not the funder address/,
  );
});

test("buildRainTx: full rain signs + verifies, outputs correct on-chain", () => {
  const f = parseRainSecret(MNEMONIC, NETWORKS.mainnet);
  const utxos = [
    { txid: "aa".repeat(32), vout: 0, value: 600_000_000 },
    { txid: "bb".repeat(32), vout: 1, value: 500_000_000 },
  ];
  const { recipients } = parseRecipients(`${R1} 3.5\n${R2} 1.25`, NETWORKS.mainnet);
  const plan = planRain({ utxos, recipients, funderProgram: f.program, feeRateGrainsPerVByte: 5 });
  const { txid, hex } = buildRainTx({ privHex: f.privHex, utxos, plan });
  assert.match(txid, /^[0-9a-f]{64}$/);
  assert.ok(hex.length > 400);

  const dec = decodeRawTx(hex);
  assert.equal(dec.inputs.length, 2);
  assert.equal(dec.outputs.length, 3);
  assert.equal(dec.outputs[0].value, 350000000n);
  assert.equal(dec.outputs[1].value, 125000000n);
  assert.equal(dec.outputs[2].value, plan.change, "change output exact");
  assert.equal(dec.txid, txid, "txid commits to the signed bytes");

  // independent re-verification against the funder prevouts
  const { tweakedX } = tweakKeypath(hexToBytes(f.internalXOnlyHex));
  const spk = p2trScriptPubKey(tweakedX);
  const checks = verifySignedTx(NETWORKS.mainnet, hex, utxos.map((u) => ({ value: u.value, spk })));
  assert.equal(checks.length, 2);
  assert.ok(checks.every((c) => c.ok), JSON.stringify(checks));
});

test("buildRainTx: wrong-key signatures do not verify against the funded UTXOs", () => {
  const f = parseRainSecret(MNEMONIC, NETWORKS.mainnet);
  const wrong = parseRainSecret(WRONG_MNEMONIC, NETWORKS.mainnet);
  const utxos = [{ txid: "aa".repeat(32), vout: 0, value: 1_000_000_000 }];
  const { recipients } = parseRecipients(`${R1} 1`, NETWORKS.mainnet);
  const plan = planRain({ utxos, recipients, funderProgram: f.program, feeRateGrainsPerVByte: 5 });
  // signed with a key that doesn't fund these utxos: signatures fail against the
  // real prevouts — a wrong key can never produce a broadcastable rain tx
  const { hex } = buildRainTx({ privHex: wrong.privHex, utxos, plan });
  const { tweakedX } = tweakKeypath(hexToBytes(f.internalXOnlyHex));
  const spk = p2trScriptPubKey(tweakedX);
  const checks = verifySignedTx(NETWORKS.mainnet, hex, [{ value: 1_000_000_000, spk }]);
  assert.ok(checks.length > 0 && checks.every((c) => !c.ok), "wrong-key sigs must fail verification");
});
