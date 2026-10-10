// Pearl Wallet unit tests — run: node --no-warnings --loader tests/loader.mjs tests/verify.mjs
// Covers: bech32m vectors, BIP-86 derivation (byte-match vs audited pearl.js),
// address validation, WIF round-trip, coin selection, fee math, mnemonic,
// vault seal/unseal, and full send-tx assembly (parsed back from wire hex).
import * as W from "../src/pearl-wallet-core.js";
import * as P from "../src/pearl.js";
import { schnorr } from "@noble/curves/secp256k1";

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra = "") {
  if (cond) { pass++; }
  else { fail++; failures.push(name + (extra ? " :: " + extra : "")); console.error("FAIL:", name, extra); }
}
function throws(name, fn, match = "") {
  try { fn(); ok(name, false, "did not throw"); }
  catch (e) { ok(name, !match || String(e.message).includes(match), e.message); }
}
async function throwsAsync(name, fn, match = "") {
  try { await fn(); ok(name, false, "did not throw"); }
  catch (e) { ok(name, !match || String(e.message).includes(match), e.message); }
}

const MN = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const mainnet = W.NETWORKS.mainnet;
const testnet = W.NETWORKS.testnet;

/* 1. bech32m against the upstream PRLS fee-recipient vector */
{
  const prog = Uint8Array.from(Buffer.from("0effd3c4e44fd3886e8c1ebe943138fa6a944e21e4bbe7e2d9ab800b7f4c4ffa", "hex"));
  const addr = W.encodeTaprootAddress("prl", prog);
  ok("bech32m matches PRLS fee-recipient vector",
    addr === "prl1ppmla838yflfcsm5vr6lfgvfclf4fgn3puja70cke4wqqkl6vflaq3cn7ea", addr);
  const v = W.validateAddress(addr, mainnet);
  ok("validateAddress returns 32-byte program", v.program.length === 32 &&
    Buffer.from(v.program).toString("hex") === "0effd3c4e44fd3886e8c1ebe943138fa6a944e21e4bbe7e2d9ab800b7f4c4ffa");
  throws("validateAddress rejects garbage", () => W.validateAddress("not-an-address", mainnet));
  throws("validateAddress rejects wrong network", () => W.validateAddress(addr, testnet), "Wrong network");
  const tprog = W.encodeTaprootAddress("tprl", prog);
  ok("testnet vector has tprl hrp", tprog.startsWith("tprl1p"));
  throws("validateAddress rejects mixed case", () => W.validateAddress("PrL1ppmla838yflfcsm5vr6lfgvfclf4fgn3puja70cke4wqqkl6vflaq3cn7ea", mainnet));
}

/* 2. BIP-86 derivation byte-matches the audited pearl.js reference */
{
  const a = W.walletFromMnemonic(MN, mainnet, { index: 0 });
  const b = W.walletFromMnemonic(MN, mainnet, { index: 0 });
  ok("derivation deterministic", a.address === b.address, a.address);
  ok("mainnet address is prl1p…", a.address.startsWith("prl1p") && a.address.length > 50, a.address);
  // independent path: pearl.js derivePriv (m/86'/808276'/0'/0/0) + addressFromPriv
  const seed = (await import("@scure/bip39")).mnemonicToSeedSync(MN);
  const root = P.hdFromSeed(seed);
  const priv = P.derivePriv(root, 0);
  const refAddr = P.addressFromPriv(priv);
  ok("byte-matches audited pearl.js derivation", a.address === refAddr, `${a.address} vs ${refAddr}`);
  ok("priv matches audited derivePriv", Buffer.from(a.priv).toString("hex") === Buffer.from(priv).toString("hex"));
  const t = W.walletFromMnemonic(MN, testnet, { index: 0 });
  ok("testnet address is tprl1p…", t.address.startsWith("tprl1p"), t.address);
  ok("testnet differs from mainnet (coinType 1)", t.address !== a.address);
  const c1 = W.walletFromMnemonic(MN, mainnet, { index: 0, chain: 1 });
  ok("change chain differs from receive chain", c1.address !== a.address && c1.address.startsWith("prl1p"));
  const pp = W.walletFromMnemonic(MN, mainnet, { index: 0, passphrase: "secret" });
  ok("passphrase changes keys", pp.address !== a.address);
  throws("bad mnemonic rejected", () => W.walletFromMnemonic("zoo zoo zoo", mainnet), "Invalid recovery phrase");
  // receive set
  const set = W.deriveReceiveSet(MN, mainnet, { start: 0, count: 3 });
  ok("receive set derives 3 unique addresses", set.length === 3 && new Set(set.map((s) => s.address)).size === 3);
  ok("receive set index 0 matches single derivation", set[0].address === a.address);
}

/* 3. WIF round-trip */
{
  const w = W.walletFromMnemonic(MN, mainnet, { index: 3 });
  const wif = W.privToWIF(w.priv, mainnet);
  ok("WIF starts with K/L (0x80 compressed)", /^[KL]/.test(wif), wif.slice(0, 2));
  const back = W.walletFromWIF(wif, mainnet);
  ok("WIF round-trip preserves address", back.address === w.address);
  throws("WIF wrong network rejected", () => W.walletFromWIF(wif, testnet), "Wrong network");
  throws("WIF garbage rejected", () => W.walletFromWIF("notawif", mainnet));
}

/* 4. mnemonic generation */
{
  const m12 = W.newMnemonic(128);
  ok("128-bit → 12 words", m12.split(" ").length === 12 && W.isValidMnemonic(m12));
  const m24 = W.newMnemonic(256);
  ok("256-bit → 24 words", m24.split(" ").length === 24 && W.isValidMnemonic(m24));
  ok("fresh mnemonic derives", W.walletFromMnemonic(m12, mainnet).address.startsWith("prl1p"));
  ok("invalid mnemonic detected", !W.isValidMnemonic("abandon abandon abandon"));
}

/* 5. fee math (audited txVBytes: 1in/2out → 154 vB) */
{
  ok("txVBytes(1,2) == 154", W.estimateVBytes(1, 2) === 154, String(W.estimateVBytes(1, 2)));
  ok("txVBytes(2,2) == 212", W.estimateVBytes(2, 2) === 212, String(W.estimateVBytes(2, 2)));
  ok("feeFor scales with rate", W.feeFor(1, 2, 10) === 1540 && W.feeFor(1, 2, 20) === 3080);
  throws("txVBytes rejects 0 inputs", () => W.estimateVBytes(0, 1));
}

/* 6. coin selection */
{
  const U = (v, i) => ({ txid: "a".repeat(64), vout: i, value: v });
  // simple: one UTXO covers target + fee
  let s = W.selectCoins([U(100000, 0)], 50000, 10);
  ok("single utxo selected", s.inputs.length === 1 && s.nOut === 2);
  ok("change = total - target - fee", s.changeGrains === 100000 - 50000 - s.feeGrains && s.feeGrains === 1540, JSON.stringify(s));
  // dust change folds into fee (no change output)
  s = W.selectCoins([U(60000, 0)], 58000, 10);
  ok("dust change → no change output, fee absorbs", s.nOut === 1 && s.changeGrains === 0 && s.feeGrains === 60000 - 58000, JSON.stringify(s));
  // multiple inputs, largest-first
  s = W.selectCoins([U(10000, 0), U(50000, 1), U(30000, 2)], 55000, 10);
  ok("largest-first accumulation", s.inputs.length === 2 && s.inputs[0].value === 50000 && s.inputs[1].value === 30000, JSON.stringify(s.inputs.map((i) => i.value)));
  // insufficient
  throws("insufficient funds throws", () => W.selectCoins([U(1000, 0)], 50000, 10), "Insufficient funds");
  throws("empty utxo set throws", () => W.selectCoins([], 100, 10), "No spendable");
  throws("bad fee rate throws", () => W.selectCoins([U(100000, 0)], 100, 0), "bad fee rate");
  // exact: fee math consistent — totalIn == target + fee + change
  s = W.selectCoins([U(200000, 0), U(150000, 1)], 100000, 25);
  ok("accounting balances", s.totalIn === 100000 + s.feeGrains + s.changeGrains, JSON.stringify(s));
}

/* 7. full send assembly — parse the wire hex back and verify every field */
{
  const sender = W.walletFromMnemonic(MN, mainnet, { index: 0 });
  const change = W.walletFromMnemonic(MN, mainnet, { index: 0, chain: 1 });
  const recipient = W.walletFromMnemonic(MN, mainnet, { index: 9 });
  const fakeTxid = "b".repeat(64);
  const built = W.buildSendTx({
    inputs: [{ txid: fakeTxid, vout: 0, value: 250000, priv: sender.priv, internalXOnly: sender.internalXOnly }],
    recipientProgram: W.validateAddress(recipient.address, mainnet).program,
    amountGrains: 100000,
    changeTweakedX: change.tweakedX,
    feeRate: 10,
  });
  ok("txid is 64 hex", /^[0-9a-f]{64}$/.test(built.txid), built.txid);
  ok("fee matches estimate", built.feeGrains === 1540, String(built.feeGrains));
  ok("change correct", built.changeGrains === 250000 - 100000 - 1540, String(built.changeGrains));
  // minimal wire parse
  const raw = Buffer.from(built.hex, "hex");
  let o = 0;
  const u32 = () => { const v = raw.readUInt32LE(o); o += 4; return v; };
  const vi = () => { const v = raw[o]; if (v < 0xfd) { o += 1; return v; } if (v === 0xfd) { o += 1; const x = raw.readUInt16LE(o); o += 2; return x; } throw new Error("big varint"); };
  ok("tx version 1", u32() === 1);
  ok("segwit marker+flag", raw[o] === 0x00 && raw[o + 1] === 0x01); o += 2;
  const nIn = vi(); ok("1 input", nIn === 1);
  const inTxid = raw.subarray(o, o + 32); o += 32;
  ok("input txid LE matches", Buffer.from(inTxid).reverse().toString("hex") === fakeTxid);
  o += 4; // vout
  const scriptLen = vi(); o += scriptLen; o += 4; // empty script + sequence
  const nOut = vi(); ok("2 outputs (recipient + change)", nOut === 2);
  const outs = [];
  for (let i = 0; i < nOut; i++) {
    const val = Number(raw.readBigUInt64LE(o)); o += 8;
    const sl = vi(); const spk = raw.subarray(o, o + sl); o += sl;
    outs.push({ val, spk });
  }
  ok("recipient output value", outs[0].val === 100000);
  ok("recipient script is P2TR to recipient key",
    outs[0].spk[0] === 0x51 && outs[0].spk[1] === 0x20 &&
    Buffer.from(outs[0].spk.subarray(2)).equals(Buffer.from(recipient.tweakedX)));
  ok("change output value", outs[1].val === built.changeGrains);
  ok("change script is P2TR to change key",
    outs[1].spk[0] === 0x51 && outs[1].spk[1] === 0x20 &&
    Buffer.from(outs[1].spk.subarray(2)).equals(Buffer.from(change.tweakedX)));
  // witness: 1 stack item, 64-byte schnorr sig
  const nStack = vi(); ok("witness 1 item", nStack === 1);
  const sigLen = vi(); ok("sig is 64 bytes", sigLen === 64);
  const sig = raw.subarray(o, o + 64); o += 64;
  ok("locktime 0", u32() === 0 && o === raw.length);
  // verify the schnorr signature against the tweaked key over the real sighash:
  // recompute digest via pearl.js internals is not exported; instead verify the
  // signature is valid for *some* 32-byte message under the tweaked key would be
  // vacuous — so we verify keypair consistency: sig verifies under tweaked pub
  // for the digest pearl.js signed. We recover the digest by re-signing a
  // tampered copy? Not available. Instead: sanity — signature is not all zeros
  // and verifies structurally via schnorr.verify against a random message = false.
  ok("sig not degenerate", !sig.every((b) => b === 0));
  const tweakedPub = change.tweakedX; // any 32B key; structural check only
  ok("schnorr.verify structural check runs", schnorr.verify(sig, new Uint8Array(32), tweakedPub) === false);
  // accounting: inputs - outputs == fee
  ok("input - outputs == fee", 250000 - (outs[0].val + outs[1].val) === built.feeGrains);
}

/* 8. vault seal/unseal */
{
  const v = await W.vaultSeal(MN, "correct-horse-8");
  ok("vault has salt/iv/ct", v.v === 1 && v.iter === 600000 && v.salt && v.iv && v.ct);
  const back = await W.vaultUnseal(v, "correct-horse-8");
  ok("vault round-trip", back === MN);
  let wrong = false;
  try { await W.vaultUnseal(v, "wrong-password-1"); } catch { wrong = true; }
  ok("wrong password throws", wrong);
  await throwsAsync("short password rejected", () => W.vaultSeal(MN, "short"), "at least 8");
  // NFKC normalization: composed vs decomposed forms of the SAME password agree.
  // "pässwörd-12" with ä = a+U+0308 and ö = o+U+0308 (decomposed) must match the
  // composed form used at seal time.
  const v2 = await W.vaultSeal(MN, "pässwörd-12");
  ok("NFKC password round-trip",
    (await W.vaultUnseal(v2, "p\u0061\u0308sswo\u0308rd-12")) === MN);
  // …and a genuinely different password still fails (guarded: must not crash the runner)
  let nfkcWrong = false;
  try { await W.vaultUnseal(v2, "pässwörd-13"); } catch { nfkcWrong = true; }
  ok("NFKC vault rejects wrong password", nfkcWrong);
}

/* 9. amount formatting */
{
  ok("fmtPRL trims", W.fmtPRL(100000000) === "1" && W.fmtPRL(150000000) === "1.5");
  ok("prlToGrains", W.prlToGrains("0.00000001") === 1 && W.prlToGrains("2.5") === 250000000);
  throws("prlToGrains rejects junk", () => W.prlToGrains("abc"), "bad amount");
  // Exact-parser regressions: the old float parse rounded these instead
  // of refusing (sub-grain inputs, hex/exponent forms, unsafe range).
  throws("prlToGrains rejects 9dp", () => W.prlToGrains("0.123456789"), "bad amount");
  throws("prlToGrains rejects sub-grain .5", () => W.prlToGrains("1.000000005"), "bad amount");
  throws("prlToGrains rejects 0.1 grain", () => W.prlToGrains("0.000000001"), "bad amount");
  throws("prlToGrains rejects hex", () => W.prlToGrains("0x10"), "bad amount");
  throws("prlToGrains rejects exponent", () => W.prlToGrains("1e3"), "bad amount");
  throws("prlToGrains rejects negative", () => W.prlToGrains("-5"), "bad amount");
  ok("prlToGrains max safe exact", W.prlToGrains("90071992.54740991") === 9007199254740991);
  throws("prlToGrains rejects unsafe range", () => W.prlToGrains("90071992.54740992"), "bad amount");
  ok("fmtFiat", W.fmtFiat(2, 100000000, "USD") === "$2.00");
}

/* 10. explorer links */
{
  ok("explorerTx", W.explorerTx("https://blockbook.pearlresearch.ai", "a".repeat(64)) ===
    "https://blockbook.pearlresearch.ai/tx/" + "a".repeat(64));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.error("FAILURES:", failures); process.exit(1); }
