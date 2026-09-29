// Pearl Batch core tests (node:test). Runs against src/ via the importmap
// loader hook — exercises the real audited Sign lineage, not the bundle.
// Usage: node --no-warnings --loader ./tests/loader.mjs tests/batch.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "../../sign/lib/scure-bip39/index.js";
import {
  NETWORKS, GRAIN_PER_PRL, DUST_GRAIN, fmtPRL, parsePRL,
  decodeBech32m, encodeBech32m, walletFromMnemonic, walletFromPriv,
  walletToWIF, newMnemonic, keypathTxVBytes, hexToBytes, decodeRawTx,
  tweakKeypath,
  parseBatchSecret, assertKeyControlsAddress, canonicalAddress,
  parseRecipients, sampleManifest, planDispatch, autoSelectUtxos,
  buildUnsignedTx, buildDescriptor, exportUnsignedBundle, importUnsignedBundle,
  buildBatchTx, auditBatchTx, canonicalJson, descriptorFingerprint,
  BATCH_MAX_OUTPUTS, BATCH_DESCRIPTOR_KIND, BATCH_BUNDLE_KIND,
} from "../src/index.js";

const N = NETWORKS.mainnet;
const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const HEXKEY = "0f".repeat(32);

function senderOf(privHex) {
  const w = walletFromPriv(privHex, N);
  const { tweakedX } = tweakKeypath(w.internalXOnly);
  return encodeBech32m(N.hrp, 1, tweakedX);
}
const SENDER = senderOf(HEXKEY);

function recipAddr(seedHex) { return senderOf(seedHex); }
const A1 = recipAddr("aa".repeat(32));
const A2 = recipAddr("bb".repeat(32));
const A3 = recipAddr("cc".repeat(32));

const utxo = (txid, vout, value) => ({ txid, vout, value, confirmations: 6 });

/* ---------------- amounts ---------------- */

test("fmtPRL/parsePRL grain-exact round-trip", () => {
  assert.equal(parsePRL("1.25"), 125000000n);
  assert.equal(parsePRL("0.00000546"), 546n);
  assert.equal(fmtPRL(1125000005n), "11.25000005");
  assert.equal(fmtPRL(546n), "0.00000546");
  assert.throws(() => parsePRL("1.123456789"), /invalid PRL amount/);
  assert.throws(() => parsePRL("-1"), /invalid PRL amount/);
});

/* ---------------- recipient manifest ---------------- */

test("parseRecipients: sample manifest exact totals", () => {
  const { recipients, merged, total } = parseRecipients(sampleManifest(), N);
  assert.equal(recipients.length, 3);
  assert.equal(merged, 0);
  // 1.25 PRL + 546 grains + 10 PRL
  assert.equal(total, 125000000n + 546n + 1000000000n);
  assert.equal(recipients[0].memo, "Q3 vendor payout");
  assert.equal(recipients[1].amount, 546n); // grains unit parsed (dust boundary)
  assert.equal(recipients[2].memo, "contractor bonus");
  for (const r of recipients) assert.ok(r.program instanceof Uint8Array && r.program.length === 32);
});

test("parseRecipients: whitespace format + memos with spaces", () => {
  const { recipients } = parseRecipients(`${A1} 2.5 monthly retainer fee`, N);
  assert.equal(recipients.length, 1);
  assert.equal(recipients[0].amount, 250000000n);
  assert.equal(recipients[0].memo, "monthly retainer fee");
});

test("parseRecipients: dust refused loudly, boundary accepted", () => {
  assert.throws(() => parseRecipients(`${A1}, 0.00000545`, N), /dust floor/);
  assert.throws(() => parseRecipients(`${A1}, 545 grains`, N), /dust floor/);
  const ok = parseRecipients(`${A1}, 546 grains`, N);
  assert.equal(ok.recipients[0].amount, 546n);
});

test("parseRecipients: bad addresses refused", () => {
  assert.throws(() => parseRecipients("junk, 1", N), /not a valid prl1 address/);
  assert.throws(() => parseRecipients(`${A1}, 0`, N), /must be positive/);
  assert.throws(() => parseRecipients(`${A1}\n`, N), /need "<address>, <amount>"/);
});

test("parseRecipients: duplicates merge with summed amounts", () => {
  const text = `${A1}, 1\n${A2}, 2\n${A1}, 0.5, second memo`;
  const { recipients, merged, total } = parseRecipients(text, N);
  assert.equal(recipients.length, 2);
  assert.equal(merged, 1);
  assert.equal(recipients[0].amount, 150000000n);
  assert.equal(total, 350000000n);
  assert.match(recipients[0].memo || "", /second memo/);
});

test("parseRecipients: mergeDuplicates:false refuses duplicates loudly", () => {
  const text = `${A1}, 1\n${A2}, 2\n${A1}, 0.5`;
  assert.throws(() => parseRecipients(text, N, { mergeDuplicates: false }), /merging is OFF/);
  // and merging on (explicit or default) still works
  assert.equal(parseRecipients(text, N, { mergeDuplicates: true }).merged, 1);
  assert.equal(parseRecipients(text, N).merged, 1);
});

test("parseRecipients: >250 unique recipients refused", () => {
  const lines = [];
  for (let i = 0; i < 251; i++) lines.push(`${senderOf((i + 1000).toString(16).padStart(64, "0"))}, 1`);
  assert.throws(() => parseRecipients(lines.join("\n"), N), /max 250/);
});

test("parseRecipients: empty + memo length refused", () => {
  assert.throws(() => parseRecipients("# only comments\n", N), /no recipients/);
  assert.throws(() => parseRecipients(`${A1}, 1, ${"x".repeat(141)}`, N), /memo longer/);
});

test("canonicalAddress: re-encodes to canonical form, wrong hrp refused", () => {
  const dec = decodeBech32m(A1, N.hrp);
  assert.equal(canonicalAddress(A1.toUpperCase(), N), A1); // case-insensitive decode
  assert.throws(() => canonicalAddress("tprl1" + A1.slice(4), N), /not a valid prl1/);
});

/* ---------------- sender secret ---------------- */

test("parseBatchSecret: mnemonic derives BIP-86 account 0/0/0", () => {
  const s = parseBatchSecret(MNEMONIC, N);
  const w = walletFromMnemonic(MNEMONIC, N, 0, 0);
  assert.equal(s.kind, "mnemonic");
  assert.equal(s.address, w.address);
  assert.equal(s.privHex.length, 64);
});

test("parseBatchSecret: hex + WIF round-trip to the same address", () => {
  const h = parseBatchSecret(HEXKEY, N);
  const wif = walletToWIF(hexToBytes(HEXKEY), N);
  const w = parseBatchSecret(wif, N);
  assert.equal(h.kind, "hex");
  assert.equal(w.kind, "wif");
  assert.equal(h.address, w.address);
  assert.equal(h.address, SENDER);
});

test("parseBatchSecret: xprv derives m/86'/coin'/0'/0/0 from the extended key", () => {
  const root = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC));
  const xprv = root.privateExtendedKey; // bitcoin-version xprv; derivation below re-paths for Pearl
  const s = parseBatchSecret(xprv, N);
  assert.equal(s.kind, "xprv");
  const child = root.derive(`m/86'/${N.coinType}'/0'/0/0`);
  const w = walletFromPriv(child.privateKey, N);
  assert.equal(s.address, w.address);
  assert.throws(() => parseBatchSecret(root.publicExtendedKey, N), /unrecognized secret/);
});

test("parseBatchSecret: garbage refused", () => {
  assert.throws(() => parseBatchSecret("hello world", N), /unrecognized secret/);
  assert.throws(() => parseBatchSecret("   ", N), /paste the sender secret/);
  assert.throws(() => parseBatchSecret("abandon abandon", N), /unrecognized secret/);
});

test("assertKeyControlsAddress: match passes, mismatch refuses loudly", () => {
  const s = parseBatchSecret(HEXKEY, N);
  assertKeyControlsAddress(s, SENDER);
  const other = parseBatchSecret("ab".repeat(32), N);
  assert.throws(() => assertKeyControlsAddress(other, SENDER), /KEY DOES NOT CONTROL/);
});

/* ---------------- planning + selection ---------------- */

function threeRecipients() {
  const { recipients } = parseRecipients(`${A1}, 1\n${A2}, 2\n${A3}, 3`, N);
  return recipients;
}
const SENDER_PROGRAM = (() => { const w = walletFromPriv(HEXKEY, N); const { tweakedX } = tweakKeypath(w.internalXOnly); return tweakedX; })();
const TWO_UTXOS = [utxo("a".repeat(64), 0, 500000000), utxo("b".repeat(64), 1, 300000000)];

test("planDispatch: exact fee math (keypathTxVBytes, grain-exact BigInt)", () => {
  const plan = planDispatch({ utxos: TWO_UTXOS, recipients: threeRecipients(), senderProgram: SENDER_PROGRAM, feeRateGrainsPerVByte: 20, network: N });
  const wantVBytes = keypathTxVBytes(2, 4);
  assert.equal(plan.vBytes, wantVBytes);
  assert.equal(plan.fee, BigInt(wantVBytes) * 20n);
  assert.equal(plan.nOut, 4);
  assert.ok(plan.outputs[3].change);
  assert.equal(plan.total, plan.sumOut + plan.fee + plan.change);
  assert.equal(plan.sumOut, 600000000n);
  assert.ok(plan.change >= BigInt(DUST_GRAIN));
});

test("planDispatch: dust change absorbed into the fee, disclosed", () => {
  // inputs: 600000000 + 5400; fee (no-change size) 5100 -> leftover 300 dust
  const u = [utxo("c".repeat(64), 0, 600000000), utxo("d".repeat(64), 1, 5400)];
  const vb = keypathTxVBytes(2, 3); // no-change size
  const rate = 20;
  const sumOut = 600000000n;
  const total = 600005400n;
  const leftover = total - sumOut - BigInt(vb) * BigInt(rate);
  assert.ok(leftover >= 0n && leftover < BigInt(DUST_GRAIN), `fixture sanity: leftover=${leftover}`);
  const plan = planDispatch({ utxos: u, recipients: threeRecipients(), senderProgram: SENDER_PROGRAM, feeRateGrainsPerVByte: rate, network: N });
  assert.equal(plan.changeDropped, true);
  assert.equal(plan.change, 0n);
  assert.equal(plan.nOut, 3);
  assert.equal(plan.changeBump, leftover);
  assert.equal(plan.nominalFee, BigInt(vb) * BigInt(rate));
  assert.equal(plan.fee, total - sumOut); // actual fee: every grain not paid out
  assert.equal(plan.total, plan.sumOut + plan.fee + plan.change); // balance invariant holds
});

test("planDispatch: insufficient funds refused loudly", () => {
  const poor = [utxo("e".repeat(64), 0, 100000)];
  assert.throws(
    () => planDispatch({ utxos: poor, recipients: threeRecipients(), senderProgram: SENDER_PROGRAM, feeRateGrainsPerVByte: 20, network: N }),
    /insufficient funds/
  );
});

test("autoSelectUtxos: largest-first, covers sumOut + fee", () => {
  const utxos = [utxo("1".repeat(64), 0, 100000), utxo("2".repeat(64), 1, 900000000), utxo("3".repeat(64), 2, 50000000)];
  const sumOut = 600000000n;
  const r = autoSelectUtxos(utxos, sumOut, 20, 3);
  assert.ok(r.selected.length >= 1);
  assert.equal(r.selected[0].value, 900000000); // largest first
  assert.equal(BigInt(r.selected.reduce((a, u) => a + u.value, 0)), sumOut + r.fee + r.change);
  assert.throws(() => autoSelectUtxos([utxo("9".repeat(64), 0, 10)], sumOut, 20, 3), /insufficient funds/);
});

/* ---------------- unsigned wire + bundle ---------------- */

test("buildUnsignedTx: deterministic, txid is dbl-sha256 of the wire", () => {
  const plan = planDispatch({ utxos: TWO_UTXOS, recipients: threeRecipients(), senderProgram: SENDER_PROGRAM, feeRateGrainsPerVByte: 20, network: N });
  const a = buildUnsignedTx(N, TWO_UTXOS, plan.outputs);
  const b = buildUnsignedTx(N, TWO_UTXOS, plan.outputs);
  assert.equal(a.hex, b.hex);
  assert.equal(a.txid, b.txid);
  assert.match(a.txid, /^[0-9a-f]{64}$/);
});

test("canonicalJson + descriptorFingerprint: deterministic 64-bit hex", () => {
  const d = { b: 1, a: [3, { z: 1, y: 2 }] };
  assert.equal(canonicalJson(d), canonicalJson({ a: [3, { y: 2, z: 1 }], b: 1 }));
  const fp = descriptorFingerprint(d);
  assert.match(fp, /^[0-9a-f]{16}$/);
  assert.equal(fp, descriptorFingerprint(JSON.parse(JSON.stringify(d))));
});

test("bundle export/import round-trip with full cross-checks", () => {
  const plan = planDispatch({ utxos: TWO_UTXOS, recipients: threeRecipients(), senderProgram: SENDER_PROGRAM, feeRateGrainsPerVByte: 20, network: N });
  const bundle = exportUnsignedBundle({ network: N, senderAddress: SENDER, recipients: threeRecipients(), plan, feeRate: 20 });
  assert.equal(bundle.bundle, BATCH_BUNDLE_KIND);
  assert.equal(bundle.descriptor.kind, BATCH_DESCRIPTOR_KIND);
  assert.match(bundle.fingerprint, /^[0-9a-f]{16}$/);
  const imp = importUnsignedBundle(JSON.parse(JSON.stringify(bundle))); // through JSON: no BigInt leakage
  assert.equal(imp.fingerprint, bundle.fingerprint);
  assert.equal(imp.senderAddress, SENDER);
  assert.equal(imp.plan.fee.toString(), bundle.feeGrains);
  assert.equal(imp.plan.vBytes, bundle.vBytes);
  assert.equal(imp.recipients.length, 3);
});

test("importUnsignedBundle: tampered amount -> FINGERPRINT MISMATCH", () => {
  const plan = planDispatch({ utxos: TWO_UTXOS, recipients: threeRecipients(), senderProgram: SENDER_PROGRAM, feeRateGrainsPerVByte: 20, network: N });
  const bundle = exportUnsignedBundle({ network: N, senderAddress: SENDER, recipients: threeRecipients(), plan, feeRate: 20 });
  bundle.descriptor.recipients[0].amountGrains = "999999999";
  assert.throws(() => importUnsignedBundle(bundle), /FINGERPRINT MISMATCH/);
});

test("importUnsignedBundle: tampered txid -> DIGEST MISMATCH", () => {
  const plan = planDispatch({ utxos: TWO_UTXOS, recipients: threeRecipients(), senderProgram: SENDER_PROGRAM, feeRateGrainsPerVByte: 20, network: N });
  const bundle = exportUnsignedBundle({ network: N, senderAddress: SENDER, recipients: threeRecipients(), plan, feeRate: 20 });
  bundle.unsignedTxid = "0".repeat(64);
  assert.throws(() => importUnsignedBundle(bundle), /DIGEST MISMATCH/);
});

test("importUnsignedBundle: tampered fee -> FEE MISMATCH", () => {
  const plan = planDispatch({ utxos: TWO_UTXOS, recipients: threeRecipients(), senderProgram: SENDER_PROGRAM, feeRateGrainsPerVByte: 20, network: N });
  const bundle = exportUnsignedBundle({ network: N, senderAddress: SENDER, recipients: threeRecipients(), plan, feeRate: 20 });
  bundle.feeGrains = "1";
  assert.throws(() => importUnsignedBundle(bundle), /FEE MISMATCH/);
});

test("importUnsignedBundle: wrong kind / bad JSON refused", () => {
  assert.throws(() => importUnsignedBundle({ bundle: "nope" }), /not a Pearl Batch unsigned bundle/);
  assert.throws(() => importUnsignedBundle("{bad json"), /Unexpected token|not valid JSON|JSON/);
});

/* ---------------- build + sign + verify ---------------- */

test("buildBatchTx: deterministic txid, all signatures re-verified, exact outputs", () => {
  const secret = parseBatchSecret(HEXKEY, N);
  const recipients = threeRecipients();
  const plan = planDispatch({ utxos: TWO_UTXOS, recipients, senderProgram: SENDER_PROGRAM, feeRateGrainsPerVByte: 20, network: N });
  const a = buildBatchTx({ secret, senderAddress: SENDER, utxos: TWO_UTXOS, plan, network: N });
  const b = buildBatchTx({ secret, senderAddress: SENDER, utxos: TWO_UTXOS, plan, network: N });
  assert.equal(a.txid, b.txid); // deterministic (RFC6979-style nonce)
  assert.match(a.txid, /^[0-9a-f]{64}$/);
  const dec = decodeRawTx(a.hex);
  assert.equal(dec.inputs.length, 2);
  assert.equal(dec.outputs.length, 4);
  const vals = dec.outputs.map((o) => o.value);
  assert.deepEqual(vals, [100000000n, 200000000n, 300000000n, plan.change]);
  for (const o of dec.outputs) assert.equal(o.spk[0], 0x51); // all P2TR
  assert.ok(dec.witness.every((w) => w.length === 1 && w[0].length === 64)); // 64B Schnorr, SIGHASH_DEFAULT
  const unsignedTxid = buildUnsignedTx(N, TWO_UTXOS, plan.outputs).txid;
  // Segwit property: the txid commits only to the non-witness serialization,
  // so the unsigned bundle's txid IS the final txid — signatures can't move it.
  assert.equal(a.txid, unsignedTxid);
  const unsignedHex = buildUnsignedTx(N, TWO_UTXOS, plan.outputs).hex;
  assert.notEqual(a.hex, unsignedHex); // but the wire gains the witness
});

test("buildBatchTx: wrong sender address refused before signing", () => {
  const secret = parseBatchSecret(HEXKEY, N);
  const recipients = threeRecipients();
  const plan = planDispatch({ utxos: TWO_UTXOS, recipients, senderProgram: SENDER_PROGRAM, feeRateGrainsPerVByte: 20, network: N });
  assert.throws(
    () => buildBatchTx({ secret, senderAddress: A1, utxos: TWO_UTXOS, plan, network: N }),
    /KEY DOES NOT CONTROL/
  );
});

test("memos never reach the chain", () => {
  const secret = parseBatchSecret(HEXKEY, N);
  const { recipients } = parseRecipients(`${A1}, 1, super secret payroll memo`, N);
  const plan = planDispatch({ utxos: TWO_UTXOS, recipients, senderProgram: SENDER_PROGRAM, feeRateGrainsPerVByte: 20, network: N });
  const { hex } = buildBatchTx({ secret, senderAddress: SENDER, utxos: TWO_UTXOS, plan, network: N });
  assert.ok(!hex.includes(Buffer.from("payroll").toString("hex")), "memo bytes must not appear in the wire");
});

/* ---------------- standalone audit ---------------- */

function fakeBlockbookTx(txid, sender, recips, fee) {
  const vin = [{ addresses: [sender], value: String(800000000n) }];
  const vout = recips.map((r) => ({ addresses: [r.address], value: r.amount.toString() }));
  vout.push({ addresses: [sender], value: String(800000000n - recips.reduce((a, r) => a + r.amount, 0n) - fee) });
  return { txid, confirmations: 3, blockHeight: 900001, vin, vout };
}

test("auditBatchTx: clean batch verifies with exact fee", () => {
  const recipients = threeRecipients();
  const txid = "ab".repeat(32);
  const tx = fakeBlockbookTx(txid, SENDER, recipients, 7880n);
  const r = auditBatchTx(tx, { txid, senderAddress: SENDER, recipients }, N);
  assert.equal(r.ok, true);
  assert.equal(r.fee, 7880n);
  assert.equal(r.confirmations, 3);
  assert.match(r.verdict, /BATCH VERIFIED/);
});

test("auditBatchTx: shorted recipient -> NOT VERIFIED", () => {
  const recipients = threeRecipients();
  const txid = "ab".repeat(32);
  const shorted = [{ address: recipients[0].address, amount: 100000000n }, recipients[1], recipients[2]];
  const tx = fakeBlockbookTx(txid, SENDER, [{ address: recipients[0].address, amount: 50000000n }, recipients[1], recipients[2]], 7880n);
  const r = auditBatchTx(tx, { txid, senderAddress: SENDER, recipients: shorted }, N);
  assert.equal(r.ok, false);
  assert.equal(r.missingRecipients.length, 1);
  assert.match(r.verdict, /NOT VERIFIED/);
});

test("buildDescriptor: memo included, totals balance", () => {
  const recipients = parseRecipients(`${A1}, 1, payroll`, N).recipients;
  const plan = planDispatch({ utxos: TWO_UTXOS, recipients, senderProgram: SENDER_PROGRAM, feeRateGrainsPerVByte: 20, network: N });
  const { descriptor, fingerprint } = buildDescriptor({ network: N, senderAddress: SENDER, recipients, plan, feeRate: 20 });
  assert.equal(descriptor.recipients[0].memo, "payroll");
  assert.equal(BigInt(descriptor.totals.inputsGrains), BigInt(descriptor.totals.recipientsGrains) + BigInt(descriptor.totals.feeGrains) + BigInt(descriptor.totals.changeGrains));
  assert.match(fingerprint, /^[0-9a-f]{16}$/);
});
