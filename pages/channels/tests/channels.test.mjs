// Pearl Channels core tests — fixed vectors, no network.
// Run: node --no-warnings --loader ./tests/loader.mjs tests/channels.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import * as C from "../src/channels-core.js";

const privA = "11".repeat(32);
const privB = "22".repeat(32);
const privC = "33".repeat(32); // my payout key
const privD = "44".repeat(32); // peer payout key
const xA = C.bytesToHex(C.schnorr.getPublicKey(C.hexToBytes(privA)));
const xB = C.bytesToHex(C.schnorr.getPublicKey(C.hexToBytes(privB)));
const xC = C.bytesToHex(C.schnorr.getPublicKey(C.hexToBytes(privC)));
const xD = C.bytesToHex(C.schnorr.getPublicKey(C.hexToBytes(privD)));

function prlAddr(xonlyHex) {
  const tweaked = C.tweakKeypath(C.hexToBytes(xonlyHex)).tweakedX;
  return C.encodeBech32m("prl", 1, tweaked);
}
const myPayout = prlAddr(xC);
const peerPayout = prlAddr(xD);

const SECRET_A = C.hexToBytes("aa".repeat(32));
const SECRET_B = C.hexToBytes("bb".repeat(32));
const RH_A = C.bytesToHex(C.revocationHash160(SECRET_A));
const RH_B = C.bytesToHex(C.revocationHash160(SECRET_B));

function openTestChannel(csvDelay = 144) {
  return C.openChannel({
    myKeyInput: xA,
    peerXOnlyHex: xB,
    peerPayoutAddr: peerPayout,
    myCapacityGrains: 1_000_000_00n * 10n, // 10 PRL
    peerCapacityGrains: 1_000_000_00n * 5n, // 5 PRL
    csvDelay,
    networkId: "mainnet",
  });
}
function testState(chan, version = 0, myBal = null, peerBal = null) {
  const cap = BigInt(chan.capacity);
  const mb = myBal === null ? BigInt(chan.myCapacity) : BigInt(myBal);
  const pb = peerBal === null ? BigInt(chan.peerCapacity) : BigInt(peerBal);
  assert.equal(mb + pb, cap);
  return {
    version, myBal: mb.toString(), peerBal: pb.toString(),
    myPayoutAddr: myPayout, myRevokeHash160: RH_A, peerRevokeHash160: RH_B,
  };
}
const FUNDING_TXID = "ff".repeat(32);
const FEE_RATE = 2;

test("funding script is the exact 2-of-2 CHECKSIGADD template", () => {
  const s = C.buildFundingScript(xA, xB);
  assert.equal(s.length, 71);
  assert.equal(s[0], 0x00);
  assert.equal(s[1], 0x20);
  assert.deepEqual(s.slice(2, 34), C.hexToBytes(xA));
  assert.equal(s[34], 0xba);
  assert.equal(s[35], 0x20);
  assert.deepEqual(s.slice(36, 68), C.hexToBytes(xB));
  assert.equal(s[68], 0xba);
  assert.equal(s[69], 0x52);
  assert.equal(s[70], 0x87);
});

test("delay + penalty leaves encode csv/hash160 correctly", () => {
  const d = C.buildDelayLeaf(144, xA);
  // <144> CSV DROP <A> CHECKSIG  =>  02 9000 b2 75 20 <32B> ac
  assert.equal(d[0], 0x02);
  assert.equal(d[1], 0x90);
  assert.equal(d[2], 0x00);
  assert.equal(d[3], 0xb2);
  assert.equal(d[4], 0x75);
  assert.equal(d[5], 0x20);
  assert.deepEqual(d.slice(6, 38), C.hexToBytes(xA));
  assert.equal(d[38], 0xac);
  const h160 = C.hexToBytes(RH_A);
  assert.equal(h160.length, 20);
  const p = C.buildPenaltyLeaf(h160, xB);
  assert.equal(p[0], 0xa9);
  assert.equal(p[1], 0x14);
  assert.deepEqual(p.slice(2, 22), h160);
  assert.equal(p[22], 0x88);
  assert.equal(p[23], 0x20);
  assert.deepEqual(p.slice(24, 56), C.hexToBytes(xB));
  assert.equal(p[56], 0xac);
  assert.throws(() => C.buildDelayLeaf(0, xA), /CSV delay/);
  assert.throws(() => C.buildDelayLeaf(65536, xA), /CSV delay/);
});

test("revocation hash160 is deterministic and 20 bytes", () => {
  assert.equal(C.bytesToHex(C.revocationHash160(SECRET_A)), RH_A);
  assert.notEqual(RH_A, RH_B);
});

test("openChannel derives a prl1 address and tamper-evident descriptor", () => {
  const chan = openTestChannel();
  assert.match(chan.address, /^prl1/);
  assert.equal(chan.network, "mainnet");
  assert.equal(chan.csvDelay, 144);
  assert.equal(chan.capacity, (15n * 100_000_000n).toString());
  // NUMS internal key: deterministic and not equal to any party key
  assert.notEqual(chan.internalXOnly, xA);
  assert.notEqual(chan.internalXOnly, xB);
  const chan2 = openTestChannel();
  assert.equal(chan.address, chan2.address, "deterministic");
  assert.match(C.shortDescriptor(chan), /^chan:v1:mainnet:[0-9a-f]{16}:144:[0-9a-f]{16}:[0-9a-f]{16}:\d+$/);
  assert.match(C.channelFingerprint(chan), /^[0-9a-f]{16}$/);
  assert.equal(C.channelFingerprint(chan), C.channelFingerprint(chan2));
});

test("openChannel refuses bad inputs loudly", () => {
  assert.throws(() => openTestChannel(0), /CSV delay/);
  assert.throws(() => C.openChannel({
    myKeyInput: xA, peerXOnlyHex: xA, peerPayoutAddr: peerPayout,
    myCapacityGrains: 1000n, peerCapacityGrains: 1000n, csvDelay: 144, networkId: "mainnet",
  }), /must differ/);
  assert.throws(() => C.openChannel({
    myKeyInput: xA, peerXOnlyHex: xB, peerPayoutAddr: "bc1qxyz",
    myCapacityGrains: 1000n, peerCapacityGrains: 1000n, csvDelay: 144, networkId: "mainnet",
  }), /payout address/);
  assert.throws(() => C.openChannel({
    myKeyInput: xA, peerXOnlyHex: xB, peerPayoutAddr: peerPayout,
    myCapacityGrains: 0n, peerCapacityGrains: 0n, csvDelay: 144, networkId: "mainnet",
  }), /capacity must be positive/);
});

test("verifyChannelDescriptor accepts a good descriptor and rejects tampering", () => {
  const chan = openTestChannel();
  const vr = C.verifyChannelDescriptor(JSON.parse(JSON.stringify(chan)));
  assert.equal(vr.ok, true, vr.failures.join("; "));
  assert.ok(vr.checks.length >= 4);
  const bad = JSON.parse(JSON.stringify(chan));
  bad.address = prlAddr(xA); // swap in a different address
  const vr2 = C.verifyChannelDescriptor(bad);
  assert.equal(vr2.ok, false);
  assert.ok(vr2.failures.some((f) => /address mismatch/.test(f)));
  const bad2 = JSON.parse(JSON.stringify(chan));
  bad2.internalXOnly = xA; // keypath backdoor attempt
  const vr3 = C.verifyChannelDescriptor(bad2);
  assert.equal(vr3.ok, false);
  assert.ok(vr3.failures.some((f) => /NUMS/.test(f)));
});

test("commitment pair conserves capacity and deducts the fee from the owner", () => {
  const chan = openTestChannel();
  const state = testState(chan);
  const pair = C.buildCommitmentPair("mainnet", chan, FUNDING_TXID, 0, state, FEE_RATE);
  for (const side of ["mine", "theirs"]) {
    const c = pair[side];
    assert.equal(c.version, 0);
    assert.equal(c.outputs.length, 2);
    const spent = c.outputs.reduce((s, o) => s + BigInt(o.value), 0n);
    assert.equal(spent + BigInt(c.fee), BigInt(chan.capacity));
    assert.match(c.fingerprint, /^[0-9a-f]{16}$/);
    assert.match(c.digest, /^[0-9a-f]{64}$/);
    // to_local is a fresh P2TR address each state (revocation hash differs)
    assert.match(c.toLocal.address, /^prl1/);
  }
  // Mirror images: my to_remote pays the peer's payout; their to_remote pays mine
  const mineRemote = pair.mine.outputs.find((o) => o.kind === "to_remote");
  assert.equal(mineRemote.program, C.bytesToHex(C.payoutProgram(peerPayout, C.NETWORKS.mainnet)));
  const theirsRemote = pair.theirs.outputs.find((o) => o.kind === "to_remote");
  assert.equal(theirsRemote.program, C.bytesToHex(C.payoutProgram(myPayout, C.NETWORKS.mainnet)));
  // Determinism
  const pair2 = C.buildCommitmentPair("mainnet", chan, FUNDING_TXID, 0, state, FEE_RATE);
  assert.equal(pair.mine.digest, pair2.mine.digest);
});

test("commitment pair refuses unbalanced or dust states", () => {
  const chan = openTestChannel();
  const bad = testState(chan);
  bad.myBal = (BigInt(chan.capacity) - 1n).toString();
  assert.throws(() => C.buildCommitmentPair("mainnet", chan, FUNDING_TXID, 0, bad, FEE_RATE), /conserve/);
  const dust = testState(chan, 1, 600n, BigInt(chan.capacity) - 600n); // my bal can't cover fee
  assert.throws(() => C.buildCommitmentTx("mainnet", chan, FUNDING_TXID, 0, "mine", dust, FEE_RATE), /cannot cover/);
});

test("full sign -> assemble -> verify round trip for a commitment", () => {
  const chan = openTestChannel();
  const state = testState(chan);
  const pair = C.buildCommitmentPair("mainnet", chan, FUNDING_TXID, 0, state, FEE_RATE);
  const sigA = C.signChannelDigest(privA, pair.mine.digest);
  const sigB = C.signChannelDigest(privB, pair.mine.digest);
  const signed = C.assembleFundingSpend("mainnet", chan, pair.mine, sigA, sigB);
  assert.match(signed.txid, /^[0-9a-f]{64}$/);
  const vr = C.verifyChannelTx("mainnet", chan, signed.hex, FUNDING_TXID, 0, state, myPayout, FEE_RATE);
  assert.equal(vr.ok, true, vr.failures.join("; "));
  assert.equal(vr.kind, "commitment (yours)");
  assert.ok(vr.checks.some((c) => /party A signature verifies/.test(c)));
  assert.ok(vr.checks.some((c) => /party B signature verifies/.test(c)));
});

test("assemble refuses a forged peer signature", () => {
  const chan = openTestChannel();
  const state = testState(chan);
  const pair = C.buildCommitmentPair("mainnet", chan, FUNDING_TXID, 0, state, FEE_RATE);
  const sigA = C.signChannelDigest(privA, pair.mine.digest);
  const forgedB = C.signChannelDigest(privC, pair.mine.digest); // wrong key
  assert.throws(() => C.assembleFundingSpend("mainnet", chan, pair.mine, sigA, forgedB), /does not verify/);
});

test("verifier rejects a tx with tampered outputs", () => {
  const chan = openTestChannel();
  const state = testState(chan);
  const pair = C.buildCommitmentPair("mainnet", chan, FUNDING_TXID, 0, state, FEE_RATE);
  const sigA = C.signChannelDigest(privA, pair.mine.digest);
  const sigB = C.signChannelDigest(privB, pair.mine.digest);
  const signed = C.assembleFundingSpend("mainnet", chan, pair.mine, sigA, sigB);
  // Flip the last hex char of the tx (corrupts the locktime/output) — digest sigs won't match
  const tampered = signed.hex.slice(0, -1) + (signed.hex.slice(-1) === "0" ? "1" : "0");
  const vr = C.verifyChannelTx("mainnet", chan, tampered, FUNDING_TXID, 0, state, myPayout, FEE_RATE);
  assert.equal(vr.ok, false);
  assert.ok(vr.failures.length > 0);
});

test("cooperative close splits the fee and verifies", () => {
  const chan = openTestChannel();
  // state after a 1 PRL payment from me to the peer
  const state = testState(chan, 1, BigInt(chan.myCapacity) - 100_000_000n, BigInt(chan.peerCapacity) + 100_000_000n);
  const close = C.buildCoopClose("mainnet", chan, FUNDING_TXID, 0, myPayout, state, FEE_RATE);
  assert.equal(close.outputs.length, 2);
  const spent = close.outputs.reduce((s, o) => s + BigInt(o.value), 0n);
  assert.equal(spent + BigInt(close.fee), BigInt(chan.capacity));
  const sigA = C.signChannelDigest(privA, close.digest);
  const sigB = C.signChannelDigest(privB, close.digest);
  const signed = C.assembleFundingSpend("mainnet", chan, close, sigA, sigB);
  const vr = C.verifyChannelTx("mainnet", chan, signed.hex, FUNDING_TXID, 0, state, myPayout, FEE_RATE);
  assert.equal(vr.ok, true, vr.failures.join("; "));
  assert.equal(vr.kind, "cooperative close");
});

test("unilateral claim builds with CSV sequence and assembles", () => {
  const chan = openTestChannel(72);
  const state = testState(chan);
  const pair = C.buildCommitmentPair("mainnet", chan, FUNDING_TXID, 0, state, FEE_RATE);
  const sigA = C.signChannelDigest(privA, pair.mine.digest);
  const sigB = C.signChannelDigest(privB, pair.mine.digest);
  const signed = C.assembleFundingSpend("mainnet", chan, pair.mine, sigA, sigB);
  const claim = C.buildClaimTx("mainnet", chan, pair.mine, myPayout, FEE_RATE);
  assert.equal(claim.sequence, 72);
  assert.equal(claim.maturesAfterBlocks, 72);
  assert.match(claim.outputs[0].program, /^[0-9a-f]{64}$/);
  const claimSig = C.signChannelDigest(privA, claim.digest);
  const assembled = C.assembleClaimTx("mainnet", chan, claim, claimSig);
  assert.match(assembled.txid, /^[0-9a-f]{64}$/);
  // The claim spends the commitment's to_local output
  const dec = C.decodeRawTx(assembled.hex);
  assert.equal(dec.inputs[0].txid, signed.txid);
  assert.equal(dec.inputs[0].vout, 0);
  assert.equal(dec.inputs[0].sequence, 72);
});

test("state bundle export/import round-trips; tampered bundles rejected", () => {
  const chan = openTestChannel();
  const state = { ...testState(chan), revokedSecrets: { mine: [], theirs: [] } };
  const pair = C.buildCommitmentPair("mainnet", chan, FUNDING_TXID, 0, state, FEE_RATE);
  const sigA = C.signChannelDigest(privA, pair.mine.digest);
  const json = C.exportStateBundle(chan, FUNDING_TXID, 0, state, pair, { mine: sigA, theirs: null });
  const b = C.importStateBundle(json);
  assert.equal(b.version, 0);
  assert.equal(b.mySigs.mine, sigA);
  assert.equal(b.shortDescriptor, C.shortDescriptor(chan));
  const tampered = JSON.parse(json);
  tampered.myBal = (BigInt(tampered.myBal) + 1n).toString();
  assert.throws(() => C.importStateBundle(JSON.stringify(tampered)), /conserve/);
  assert.throws(() => C.importStateBundle("not json"), /valid JSON/);
});

test("funding tx builds, signs and re-verifies from wallet UTXOs", () => {
  const chan = openTestChannel();
  const w = C.walletFromPriv(C.hexToBytes(privA), C.NETWORKS.mainnet);
  const tweaked = C.tweakKeypath(w.internalXOnly).tweakedX;
  const spkHex = C.bytesToHex(C.p2trScriptPubKey(tweaked));
  const utxos = [
    { txid: "aa".repeat(32), vout: 0, value: (20n * 100_000_000n).toString(), spk: spkHex },
  ];
  const funded = C.planChannelFunding("mainnet", chan, utxos, w, FEE_RATE);
  assert.match(funded.txid, /^[0-9a-f]{64}$/);
  assert.ok(BigInt(funded.fee) > 0n);
  const dec = C.decodeRawTx(funded.hex);
  assert.equal(dec.outputs[0].value, BigInt(chan.capacity));
});

test("to_local output re-derives and control blocks verify", () => {
  const chan = openTestChannel();
  const network = C.NETWORKS.mainnet;
  const tol = C.toLocalOutput(network, chan.csvDelay, xA, xB, C.hexToBytes(RH_A));
  assert.match(tol.address, /^prl1/);
  const delayLeaf = C.hexToBytes(tol.delayScript);
  const penaltyLeaf = C.hexToBytes(tol.penaltyScript);
  const internal = C.numsInternalKeyToLocal(delayLeaf, penaltyLeaf);
  assert.ok(C.verifyControlBlock(internal, delayLeaf, tol.controlBlocks[0], C.decodeBech32m(tol.address).program));
  assert.ok(C.verifyControlBlock(internal, penaltyLeaf, tol.controlBlocks[1], C.decodeBech32m(tol.address).program));
});
