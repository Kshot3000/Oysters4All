// PRL-20 Launcher verification suite.
// Usage: node --no-warnings --loader tests/loader.mjs tests/verify.mjs
// (run from the prl20-launcher directory)
//
// When this workspace's Pearlscriptions indexer + pearlpurse checkouts are
// present, the suite additionally round-trips generated reveal transactions
// through the INDEXER's own parser (extractTaprootInscriptionsFromRawTxHex),
// prl20-core's PRL-20 validator, the indexer's mint-fee matcher, and
// pearlpurse's audited BIP-86 derivation. Otherwise those sections are
// skipped with a note; every self-contained check still runs.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const goalDir = resolvePath(here, "..", "..", "..", ".."); // .../goals/pearl-blockchain-24-7-builder
const IDX = resolvePath(goalDir, "hidden_files/ecosystem-checkouts/pearlscriptions-indexer");
const PURSE = resolvePath(goalDir, "hidden_files/ecosystem-checkouts/buildandtestppg_pearlpurse");

import {
  NETWORKS, PRLS, DUST_GRAIN,
  encodeBech32m, decodeBech32m,
  walletFromMnemonic, walletFromWIF, walletToWIF, newMnemonic,
  tweakKeypath,
  buildDeployJson, buildMintJson, validatePrl20Json,
  buildInscriptionScript, tapLeafHash, commitKeyInfo,
  buildKeypathTx, buildRevealTx, keypathTxVBytes, revealTxVBytes,
  bytesToHex, hexToBytes,
} from "../pearl-inscribe.js";
import { schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToNumberBE } from "@noble/curves/abstract/utils";
import { utf8ToBytes } from "@noble/hashes/utils";

let pass = 0, fail = 0, skipped = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
};
const skip = (name) => { skipped++; console.log(`skip ${name}`); };

// --- optional cross-check modules -------------------------------------------
let extractTaprootInscriptionsFromRawTxHex = null;
let parsePrl20Operation = null;
let findMintFeePayment = null, normalizeMintFeePolicy = null;
let purseDerive = null;
try {
  const idxJs = resolvePath(IDX, "apps/indexer-api/src/indexer.js");
  const coreJs = resolvePath(IDX, "packages/prl20-core/src/index.js");
  if (existsSync(idxJs) && existsSync(coreJs)) {
    const idx = await import("file://" + idxJs);
    const core = await import("file://" + coreJs);
    extractTaprootInscriptionsFromRawTxHex = idx.extractTaprootInscriptionsFromRawTxHex;
    findMintFeePayment = idx.findMintFeePayment;
    normalizeMintFeePolicy = idx.normalizeMintFeePolicy;
    parsePrl20Operation = core.parsePrl20Operation;
  }
} catch { /* optional */ }
try {
  const purseJs = resolvePath(PURSE, "src/lib/pearl.js");
  if (existsSync(purseJs)) {
    const p = await import("file://" + purseJs);
    purseDerive = { derivePriv: p.derivePriv, addressFromPriv: p.addressFromPriv, coinType: p.PEARL.coinType };
  }
} catch { /* optional */ }

const MN = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const mainnet = NETWORKS.mainnet;

/* 1. bech32m against the real upstream address from Pearlscriptions release-manifest.example.json */
{
  const prog = hexToBytes("0effd3c4e44fd3886e8c1ebe943138fa6a944e21e4bbe7e2d9ab800b7f4c4ffa");
  const addr = encodeBech32m("prl", 1, prog);
  ok("bech32m matches PRLS fee recipient address",
    addr === "prl1ppmla838yflfcsm5vr6lfgvfclf4fgn3puja70cke4wqqkl6vflaq3cn7ea", addr);
  const d = decodeBech32m(addr, "prl");
  ok("bech32m decode round-trip", bytesToHex(d.program) === bytesToHex(prog) && d.version === 1);
}

/* 2. wallet derivation */
const w = walletFromMnemonic(MN, mainnet);
ok("wallet address is prl taproot", w.address.startsWith("prl1p") && w.address.length > 50, w.address);
ok("wallet derivation deterministic", walletFromMnemonic(MN, mainnet).address === w.address);
ok("testnet wallet uses tprl", walletFromMnemonic(MN, NETWORKS.testnet).address.startsWith("tprl1p"));
ok("fresh mnemonic validates", (() => { try { walletFromMnemonic(newMnemonic(), mainnet); return true; } catch { return false; } })());

/* 2b. BIP-86 against pearlpurse's audited reference (optional) */
if (purseDerive) {
  const { HDKey } = await import("@scure/bip32");
  const { mnemonicToSeedSync } = await import("@scure/bip39");
  const root = HDKey.fromMasterSeed(mnemonicToSeedSync(MN));
  for (const index of [0, 1, 5]) {
    const refPriv = purseDerive.derivePriv(root, index);
    const refAddr = purseDerive.addressFromPriv(refPriv);
    const mine = walletFromMnemonic(MN, mainnet, 0, index);
    ok(`bip86 index ${index} matches pearlpurse`, bytesToHex(mine.priv) === bytesToHex(refPriv) && mine.address === refAddr);
  }
} else skip("bip86 vs pearlpurse (checkout absent)");

/* 3. WIF round-trip */
{
  const wif = walletToWIF(w.priv, mainnet);
  ok("WIF mainnet prefix K/L", /^[KL]/.test(wif), wif.slice(0, 4));
  ok("WIF round-trip address", walletFromWIF(wif, mainnet).address === w.address);
  ok("WIF testnet prefix c", walletToWIF(walletFromMnemonic(MN, NETWORKS.testnet).priv, NETWORKS.testnet).startsWith("c"));
  ok("WIF wrong-network rejected", (() => { try { walletFromWIF(wif, NETWORKS.testnet); return false; } catch { return true; } })());
}

/* 4. PRL-20 JSON validation (mirrors prl20-core rules) */
{
  const dep = buildDeployJson({ tick: "PEARL", max: "21000000", lim: "1000", dec: "8" });
  ok("deploy JSON canonical", dep === '{"p":"prl-20","op":"deploy","tick":"pearl","max":"21000000","lim":"1000","dec":"8"}', dep);
  const mint = buildMintJson({ tick: "pearl", amt: "1000" });
  ok("mint JSON canonical", mint === '{"p":"prl-20","op":"mint","tick":"pearl","amt":"1000"}', mint);
  const bad = [
    ['{"p":"prl-20","op":"deploy","tick":"pearl","max":"021","lim":"1","dec":"8"}', "deploy", "leading zero"],
    ['{"p":"prl-20","op":"deploy","tick":"PEARL!","max":"21","lim":"1","dec":"8"}', "deploy", "bad ticker"],
    ['{"p":"prl-20","op":"deploy","tick":"pearl","max":"10","lim":"11","dec":"8"}', "deploy", "lim>max"],
    ['{"p":"prl-20","op":"deploy","tick":"pearl","max":"10","lim":"1","dec":"19"}', "deploy", "dec>18"],
    ['{"p":"prl-20","op":"deploy","tick":"pearl","max":"10","lim":"1","dec":"8","x":"1"}', "deploy", "extra field"],
    ['{"p":"prl-20","op":"deploy","tick":"pearl","tick":"pearl","max":"10","lim":"1","dec":"8"}', "deploy", "dup field"],
    ['{"p":"prl-20","op":"mint","tick":"pearl","amt":"0"}', "mint", "zero amt"],
    ['{"p":"prl-20","op":"deploy","tick":"prls","max":"1","lim":"1","dec":"8"}', "deploy", "prls wrong params"],
  ];
  for (const [raw, op, label] of bad) {
    const v = validatePrl20Json(raw, op);
    ok(`reject ${label}`, !v.ok, JSON.stringify(v.errors));
  }
  ok("prls deploy exact params", validatePrl20Json(buildDeployJson({ tick: "prls", max: PRLS.max, lim: PRLS.lim, dec: PRLS.dec }), "deploy").ok);
}

/* helper: parse reveal hex through the INDEXER's own parser (optional) */
function parseReveal(hex) {
  const found = extractTaprootInscriptionsFromRawTxHex(hex);
  if (found.length !== 1) return { error: `expected 1 envelope, got ${found.length}` };
  const ins = found[0];
  let op;
  try { op = parsePrl20Operation(ins.body); }
  catch (err) { return { error: "prl20 parse: " + err.message }; }
  return { ins, op };
}
const canParse = !!extractTaprootInscriptionsFromRawTxHex;

/* 5. full deploy commit/reveal */
const deployJson = buildDeployJson({ tick: "kshot", max: "21000000", lim: "1000", dec: "8" });
const script = buildInscriptionScript(w.internalXOnly, utf8ToBytes(deployJson));
{
  ok("script starts <32B> OP_CHECKSIG", script[0] === 0x20 && script[33] === 0xac);
  ok("script has OP_FALSE OP_IF", script[34] === 0x00 && script[35] === 0x63);
  ok("script ends OP_ENDIF", script[script.length - 1] === 0x68);
  ok("marker prl-20", Buffer.from(script.slice(37, 43)).toString() === "prl-20");
}
const cki = commitKeyInfo(mainnet, w.internalXOnly, script);
ok("commit address prl1p", cki.commitAddress.startsWith("prl1p"), cki.commitAddress);
ok("control block 33B, leaf version", cki.controlBlock.length === 33 && (cki.controlBlock[0] & 0xfe) === 0xc0);
// tweak math cross-check: Q == lift(P) + TapTweak(P||leaf)*G, parity bit honest
{
  const leaf = tapLeafHash(script);
  const tagHash = sha256(utf8ToBytes("TapTweak"));
  const full = new Uint8Array(96); full.set(tagHash); full.set(tagHash, 32); full.set(w.internalXOnly, 64);
  const withLeaf = new Uint8Array(96 + 32); withLeaf.set(full); withLeaf.set(leaf, 96);
  const tval = sha256(withLeaf);
  const P = schnorr.utils.lift_x(bytesToNumberBE(w.internalXOnly));
  const Q = P.add(schnorr.Point.BASE.multiply(bytesToNumberBE(tval)));
  ok("commit key == P + TapTweak(P||leaf)*G", bytesToHex(schnorr.utils.pointToBytes(Q)) === bytesToHex(cki.commitXOnly));
  ok("control block parity honest", cki.controlBlock[0] === (0xc0 | (Q.toAffine().y & 1n ? 1 : 0)));
}

// fake funding utxo (offline; never broadcast)
const fundTxid = "aa".repeat(32);
const commitIn = [{ txid: fundTxid, vout: 0, value: 500_000_000, priv: w.priv, internalXOnly: w.internalXOnly }];
const FEE = 10; // grains/vB
const revealFee = revealTxVBytes(script.length, 1) * FEE;
const commitValue = revealFee + DUST_GRAIN;
const commitFee = keypathTxVBytes(1, 2) * FEE;
const change = 500_000_000 - commitValue - commitFee;
const { tweakedX } = tweakKeypath(w.internalXOnly);
const commit = buildKeypathTx(mainnet, commitIn, [
  { program: cki.commitXOnly, value: commitValue },
  { program: tweakedX, value: change },
]);
ok("commit tx built", commit.hex.length > 200 && /^[0-9a-f]{64}$/.test(commit.txid), commit.txid);
// txid self-consistency: independent base-serialization reparse
{
  const raw = hexToBytes(commit.hex);
  let o = 0;
  const u32 = () => { const v = raw[o] | (raw[o+1]<<8) | (raw[o+2]<<16) | (raw[o+3]<<24); o += 4; return v; };
  const vi = () => { const b = raw[o++]; if (b < 0xfd) return b; if (b === 0xfd) { const v = raw[o] | (raw[o+1]<<8); o += 2; return v; } if (b === 0xfe) { const v = raw[o]|(raw[o+1]<<8)|(raw[o+2]<<16)|(raw[o+3]<<24); o += 4; return v; } throw new Error("vi64"); };
  const bytes = (n) => { o += n; };
  u32();
  const hasWit = raw[o] === 0x00 && raw[o+1] === 0x01; o += hasWit ? 2 : 0;
  ok("commit has segwit marker/flag", hasWit);
  const nIn = vi();
  for (let i = 0; i < nIn; i++) { bytes(36); bytes(vi()); u32(); }
  const nOut = vi();
  for (let i = 0; i < nOut; i++) { bytes(8); bytes(vi()); }
  const baseEnd = o;
  for (let i = 0; i < nIn; i++) { const c = vi(); for (let k = 0; k < c; k++) bytes(vi()); }
  const lockStart = o; u32();
  ok("commit hex fully consumed", o === raw.length, `o=${o} len=${raw.length}`);
  const base = new Uint8Array([...raw.slice(0, 4), ...raw.slice(hasWit ? 6 : 4, baseEnd), ...raw.slice(lockStart, o)]);
  ok("commit txid == dblsha(base)", bytesToHex(sha256(sha256(base)).reverse()) === commit.txid);
  const weight = base.length * 4 + (raw.length - base.length);
  ok("commit weight matches txVBytes", Math.ceil(weight / 4) === keypathTxVBytes(1, 2), `${Math.ceil(weight/4)} vs ${keypathTxVBytes(1,2)}`);
}

const ownerProg = decodeBech32m(w.address, "prl").program;
const reveal = buildRevealTx(mainnet, {
  commitTxid: commit.txid, commitVout: 0, commitValue,
  commitProgram: cki.commitXOnly,
  internalPriv: w.priv, script, controlBlock: cki.controlBlock,
  outputs: [{ program: ownerProg, value: commitValue - revealFee }],
});
ok("reveal tx built", /^[0-9a-f]{64}$/.test(reveal.txid), reveal.txid);
ok("reveal sig verifies (script-path)", schnorr.verify(hexToBytes(reveal.sig), hexToBytes(reveal.digest), w.internalXOnly));
{
  // weight cross-check against the actual serialized hex
  const raw = hexToBytes(reveal.hex);
  const baseLen = 4 + 1 + 41 + 1 + 43 + 4;
  const weight = baseLen * 4 + (raw.length - baseLen);
  ok("reveal weight matches revealTxVBytes", Math.ceil(weight / 4) === revealTxVBytes(script.length, 1));
}
if (canParse) {
  const parsed = parseReveal(reveal.hex);
  ok("indexer parses reveal envelope", !parsed.error, parsed.error ?? "");
  if (!parsed.error) {
    ok("indexer: marker prl-20", parsed.ins.protocolMarker === "prl-20");
    ok("indexer: content-type", parsed.ins.contentType === "application/json");
    ok("indexer: body == deploy JSON", parsed.ins.body === deployJson);
    ok("indexer: valid PRL-20 deploy", parsed.op.op === "deploy" && parsed.op.tick === "kshot");
  }
} else skip("indexer round-trip (checkout absent)");

// estimator exactness for scripts >= 253 bytes (multi-byte CompactSize)
{
  const bigScript = buildInscriptionScript(w.internalXOnly, utf8ToBytes("x".repeat(400)));
  const bcki = commitKeyInfo(mainnet, w.internalXOnly, bigScript);
  const bFee = revealTxVBytes(bigScript.length, 2) * FEE;
  const bCommitValue = bFee + DUST_GRAIN;
  const bcommit = buildKeypathTx(mainnet, commitIn, [
    { program: bcki.commitXOnly, value: bCommitValue },
    { program: tweakedX, value: 500_000_000 - bCommitValue - commitFee },
  ]);
  const breveal = buildRevealTx(mainnet, {
    commitTxid: bcommit.txid, commitVout: 0, commitValue: bCommitValue,
    commitProgram: bcki.commitXOnly, internalPriv: w.priv,
    script: bigScript, controlBlock: bcki.controlBlock,
    outputs: [
      { program: ownerProg, value: DUST_GRAIN },
      { program: tweakedX, value: bCommitValue - bFee - DUST_GRAIN },
    ],
  });
  const raw = hexToBytes(breveal.hex);
  const baseLen = 4 + 1 + 41 + 1 + 86 + 4;
  const weight = baseLen * 4 + (raw.length - baseLen);
  ok(`revealTxVBytes exact for ${bigScript.length}B script`, Math.ceil(weight / 4) === revealTxVBytes(bigScript.length, 2));
}

/* 6. mint flow */
{
  const mintJson = buildMintJson({ tick: "kshot", amt: "1000" });
  const mscript = buildInscriptionScript(w.internalXOnly, utf8ToBytes(mintJson));
  const mcki = commitKeyInfo(mainnet, w.internalXOnly, mscript);
  const mFee = revealTxVBytes(mscript.length, 1) * FEE;
  const mCommitValue = mFee + DUST_GRAIN;
  const mcommit = buildKeypathTx(mainnet, commitIn, [{ program: mcki.commitXOnly, value: mCommitValue }, { program: tweakedX, value: 500_000_000 - mCommitValue - commitFee }]);
  const mreveal = buildRevealTx(mainnet, {
    commitTxid: mcommit.txid, commitVout: 0, commitValue: mCommitValue,
    commitProgram: mcki.commitXOnly, internalPriv: w.priv,
    script: mscript, controlBlock: mcki.controlBlock,
    outputs: [{ program: ownerProg, value: mCommitValue - mFee }],
  });
  if (canParse) {
    const parsed = parseReveal(mreveal.hex);
    ok("mint: indexer parses + validates", !parsed.error && parsed.op.op === "mint" && parsed.op.tick === "kshot" && parsed.op.amt === "1000", parsed.error ?? "");
  } else skip("mint indexer check (checkout absent)");
}

/* 7. PRLS mint: fee output detected by the INDEXER's own fee matcher (optional) */
if (canParse) {
  const feeProgHex = "0effd3c4e44fd3886e8c1ebe943138fa6a944e21e4bbe7e2d9ab800b7f4c4ffa";
  const feeProg = hexToBytes(feeProgHex);
  const feeAddr = encodeBech32m("prl", 1, feeProg);
  const mintJson = buildMintJson({ tick: "prls", amt: "100000" });
  const mscript = buildInscriptionScript(w.internalXOnly, utf8ToBytes(mintJson));
  const mcki = commitKeyInfo(mainnet, w.internalXOnly, mscript);
  const mFee = revealTxVBytes(mscript.length, 2) * FEE;
  const mCommitValue = mFee + DUST_GRAIN + PRLS.mintFeeGrain;
  const mcommit = buildKeypathTx(mainnet, commitIn, [{ program: mcki.commitXOnly, value: mCommitValue }, { program: tweakedX, value: 500_000_000 - mCommitValue - commitFee }]);
  const mreveal = buildRevealTx(mainnet, {
    commitTxid: mcommit.txid, commitVout: 0, commitValue: mCommitValue,
    commitProgram: mcki.commitXOnly, internalPriv: w.priv,
    script: mscript, controlBlock: mcki.controlBlock,
    outputs: [
      { program: ownerProg, value: DUST_GRAIN },
      { program: feeProg, value: PRLS.mintFeeGrain },
    ],
  });
  const parsed = parseReveal(mreveal.hex);
  ok("prls mint: indexer parses", !parsed.error && parsed.op.op === "mint", parsed.error ?? "");
  const policy = normalizeMintFeePolicy({
    required: true, valueGrain: String(PRLS.mintFeeGrain),
    address: feeAddr, scriptPubKey: "5120" + feeProgHex,
  });
  const outs = [
    { scriptPubKey: "5120" + bytesToHex(ownerProg), valueGrain: String(DUST_GRAIN) },
    { scriptPubKey: "5120" + feeProgHex, valueGrain: String(PRLS.mintFeeGrain) },
  ];
  const res = findMintFeePayment(outs, policy);
  ok("prls mint: indexer fee matcher satisfied", res.paid && res.paidGrain === String(PRLS.mintFeeGrain), JSON.stringify(res));
} else skip("prls fee matcher (checkout absent)");

{
  const { readFileSync } = await import("node:fs");
  const appSrc = readFileSync(resolvePath(here, "..", "app.js"), "utf8");
  ok("app.js fmtPRL is BigInt-exact (pool float-format class)", appSrc.includes("100000000n") && appSrc.includes("/^-?\\d+$/"));
}

console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ""}`);
process.exit(fail ? 1 : 0);
