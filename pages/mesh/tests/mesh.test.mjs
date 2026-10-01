// Pearl Mesh core tests — MuSig2 key aggregation, descriptor, ceremony.
// Run: node --no-warnings --loader ./tests/loader.mjs tests/mesh.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import * as M from "../src/mesh-core.js";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1";
import { bytesToNumberBE } from "@noble/curves/abstract/utils";

const N = secp256k1.CURVE.n;
const G = schnorr.Point.BASE;
const enc = new TextEncoder();

const K1 = "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
const K2 = "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9";
const K3 = "8200cf0ce11447bf6353cbac964d07d1c390d61d07e6c5d0214450b3add6449b";
const PIN_MEMBERS = [
  { name: "Ada", pubkey: K1 },
  { name: "Bo", pubkey: K2 },
  { name: "Cy", pubkey: K3 },
];
const PIN_ADDRESS = "prl1p3faqn7s30jk4qmz06309lyry3v7yjy34lglq22px3ypheykhyq0s23h6ky";
const PIN_SEALED = "pearl-mesh:v1:prl:6bac3d1db6e81bf04c56bd16c8fca636f28a981b4ffdd51ef1b1628de7edf5a9";
const PIN_DESCRIPTOR = '{"kind":"pearl-mesh","v":1,"network":"mainnet","members":[{"name":"Cy","pubkey":"8200cf0ce11447bf6353cbac964d07d1c390d61d07e6c5d0214450b3add6449b"},{"name":"Ada","pubkey":"c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5"},{"name":"Bo","pubkey":"f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9"}],"L":"60d7a6f04eac6b47eceecc7fa0f72c7bd49e0eab34d5ced1f6fece16efedcf83","coefficients":["9a28931fa5280723955770c92e3fbc596e33fbae39f3bd514421480efcb84854","1debc227eef026a131232f1c37b90b78e3efd596fc5c4748d496f5680bfb608e","22264048bd01c445e31bc1685fd1a2cf78e84acd26b66288571e30ab65e1141b"],"agg":"3d06b8cbbfb705cfe7990de9e0e0aadd57cdd6886a2a3d5616be232517924f50","tweak":"70ac79d2132a3e06751569566297ba0eeb3205b2d3038dcf1b1bc17eda6df41b","pacc":"1","address":"prl1p3faqn7s30jk4qmz06309lyry3v7yjy34lglq22px3ypheykhyq0s23h6ky"}';

const priv = (fill, last) => {
  const p = new Uint8Array(32).fill(fill);
  p[31] = last;
  return p;
};

/* ---------- key aggregation ---------- */

test("pinned 3-member descriptor: byte-identical canonical form, address, sealed", () => {
  const d = M.buildMeshDescriptor("mainnet", PIN_MEMBERS);
  assert.equal(d.descriptor, PIN_DESCRIPTOR);
  assert.equal(d.address, PIN_ADDRESS);
  assert.equal(d.sealed, PIN_SEALED);
  assert.equal(d.gacc, "1");
  assert.equal(d.pacc, "1");
});

test("aggregation is deterministic and order-independent", () => {
  const a = M.buildMeshDescriptor("mainnet", PIN_MEMBERS);
  const b = M.buildMeshDescriptor("mainnet", [...PIN_MEMBERS].reverse());
  const c = M.buildMeshDescriptor("mainnet", [PIN_MEMBERS[2], PIN_MEMBERS[0], PIN_MEMBERS[1]]);
  assert.equal(a.descriptor, b.descriptor);
  assert.equal(a.descriptor, c.descriptor);
  assert.equal(a.address, PIN_ADDRESS);
});

test("keys are sorted lexicographically in the canonical descriptor", () => {
  const d = M.buildMeshDescriptor("mainnet", PIN_MEMBERS);
  const keys = d.members.map((m) => m.pubkey);
  const sorted = [...keys].sort();
  assert.deepEqual(keys, sorted);
});

test("member count bounds enforced (2-7)", () => {
  const one = [{ name: "A", pubkey: K1 }];
  assert.throws(() => M.buildMeshDescriptor("mainnet", one), /2-7/);
  const eight = Array.from({ length: 8 }, (_, i) => ({ name: "M" + i, pubkey: M.bytesToHex(priv(i + 1, i + 2)) }));
  // need real curve keys; use memberFromPriv-derived pubs instead
  const pubs = Array.from({ length: 8 }, (_, i) => {
    const { pub } = M.memberFromPriv(priv(i + 1, 40 + i));
    return { name: "M" + i, pubkey: M.bytesToHex(pub) };
  });
  assert.throws(() => M.buildMeshDescriptor("mainnet", pubs), /2-7/);
  const two = pubs.slice(0, 2);
  assert.ok(M.buildMeshDescriptor("mainnet", two).address.startsWith("prl1p"));
  const seven = pubs.slice(0, 7);
  assert.ok(M.buildMeshDescriptor("mainnet", seven).address.startsWith("prl1p"));
});

test("duplicate member keys are refused", () => {
  assert.throws(
    () => M.buildMeshDescriptor("mainnet", [
      { name: "A", pubkey: K1 },
      { name: "B", pubkey: K1 },
    ]),
    /duplicate/i
  );
});

test("malformed keys are refused", () => {
  const bad = ["zz", "00".repeat(31), "00".repeat(33), "ff".repeat(32)];
  for (const b of bad) {
    assert.throws(
      () => M.buildMeshDescriptor("mainnet", [
        { name: "A", pubkey: K1 },
        { name: "B", pubkey: b },
      ]),
      /./,
      "key " + b
    );
  }
  // x >= p is not a curve point
  assert.throws(() => M.parseXOnlyKey("ff".repeat(32)), /./);
});

test("coefficients bind to (L, key): Q == sum(a_i * lift_x(P_i))", () => {
  const d = M.buildMeshDescriptor("mainnet", PIN_MEMBERS);
  const L = M.hexToBytes(d.L);
  let Q = null;
  d.members.forEach((m, i) => {
    const a = bytesToNumberBE(M.hexToBytes(d.coefficients[i]));
    const P = schnorr.utils.lift_x(bytesToNumberBE(M.hexToBytes(m.pubkey)));
    Q = Q ? Q.add(P.multiply(a)) : P.multiply(a);
  });
  const gacc = d.gacc === "n-1" ? N - 1n : 1n;
  const Qnorm = gacc === 1n ? Q : Q.negate();
  assert.equal(M.bytesToHex(schnorr.utils.pointToBytes(Qnorm)), d.agg);
});

test("tweak matches the audited crypto.js tweakKeypath", () => {
  const d = M.buildMeshDescriptor("mainnet", PIN_MEMBERS);
  const { tweakedX } = M.tweakKeypath(M.hexToBytes(d.agg));
  assert.equal(M.bytesToHex(tweakedX), M.bytesToHex(M.decodeBech32m(d.address, "prl").program));
});

test("odd-y aggregate internal key takes the gacc = n-1 path and still round-trips", () => {
  // find a 2-member set whose pre-normalized Q has odd y
  let pair = null;
  for (let s = 1; s < 60 && !pair; s++) {
    const q = priv(s, s + 1), r = priv(s + 100, s + 101);
    const pubs = [q, r].map((p) => M.bytesToHex(M.memberFromPriv(p).pub));
    const d = M.buildMeshDescriptor("mainnet", pubs.map((pubkey, i) => ({ name: "M" + i, pubkey })));
    if (d.gacc === "n-1") pair = { q, r, d };
  }
  assert.ok(pair, "found an odd-Q member pair");
  const msg = M.sha256(enc.encode("odd-q round trip"));
  const sim = M.runSimulation({ privs: [pair.q, pair.r], msg, networkId: "mainnet" });
  assert.equal(sim.ok, true, "odd-Q (gacc=n-1) ceremony verifies: " + sim.reason);
  assert.equal(sim.descriptor.gacc, "n-1");
});

test("memberFromPriv normalizes odd-y secrets to the even-y lift", () => {
  // scalar 6 has odd-y pubkey (verified during development)
  const p = new Uint8Array(32); p[31] = 6;
  const { d, pub } = M.memberFromPriv(p);
  const P = G.multiply(d);
  assert.equal((P.toAffine().y & 1n), 0n, "normalized secret has even y");
  assert.equal(M.bytesToHex(schnorr.utils.pointToBytes(P)), M.bytesToHex(pub));
  // and it still matches the x-only key
  assert.equal(M.bytesToHex(pub), M.bytesToHex(schnorr.getPublicKey(p)));
});

test("unknown network is refused", () => {
  assert.throws(() => M.buildMeshDescriptor("regtest", PIN_MEMBERS.slice(0, 2)), /unknown network/);
});

/* ---------- descriptor tamper evidence ---------- */

test("verifyMeshDescriptor PROVEN on the pinned descriptor", () => {
  const d = M.buildMeshDescriptor("mainnet", PIN_MEMBERS);
  const v = M.verifyMeshDescriptor(d.descriptor, d.address, d.sealed);
  assert.equal(v.verdict, "PROVEN");
  assert.ok(v.checks.every((c) => c.ok));
});

test("tampered member key moves the address -> NOT PROVEN", () => {
  const d = M.buildMeshDescriptor("mainnet", PIN_MEMBERS);
  const tampered = d.descriptor.replace(K1.slice(0, 12), "00" + K1.slice(2, 12));
  assert.notEqual(tampered, d.descriptor);
  const v = M.verifyMeshDescriptor(tampered, d.address, d.sealed);
  assert.equal(v.verdict, "NOT PROVEN");
  const addrCheck = v.checks.find((c) => c.label.includes("address re-derives"));
  assert.equal(addrCheck.ok, false);
});

test("tampered name breaks the sealed commitment but not the address", () => {
  const d = M.buildMeshDescriptor("mainnet", PIN_MEMBERS);
  const tampered = d.descriptor.replace('"Ada"', '"Ade"');
  const v = M.verifyMeshDescriptor(tampered, d.address, d.sealed);
  assert.equal(v.verdict, "NOT PROVEN");
  const addrCheck = v.checks.find((c) => c.label.includes("address re-derives"));
  assert.equal(addrCheck.ok, true, "keys unchanged -> address still re-derives");
  const sealCheck = v.checks.find((c) => c.label.includes("sealed"));
  assert.equal(sealCheck.ok, false);
});

test("wrong claimed address -> NOT PROVEN", () => {
  const d = M.buildMeshDescriptor("mainnet", PIN_MEMBERS);
  const other = M.buildMeshDescriptor("mainnet", PIN_MEMBERS.slice(0, 2));
  const v = M.verifyMeshDescriptor(d.descriptor, other.address, d.sealed);
  assert.equal(v.verdict, "NOT PROVEN");
});

test("non-canonical member order in pasted JSON -> NOT PROVEN", () => {
  const d = M.buildMeshDescriptor("mainnet", PIN_MEMBERS);
  const o = JSON.parse(d.descriptor);
  o.members.reverse(); // unsorted now
  const v = M.verifyMeshDescriptor(JSON.stringify(o), d.address);
  assert.equal(v.verdict, "NOT PROVEN");
  const canon = v.checks.find((c) => c.label.includes("canonical"));
  assert.equal(canon.ok, false);
});

test("garbage descriptor -> NOT PROVEN, not a throw", () => {
  for (const g of ["", "{", "null", '{"kind":"pearl-policy"}']) {
    const v = M.verifyMeshDescriptor(g, PIN_ADDRESS);
    assert.equal(v.verdict, "NOT PROVEN", g);
  }
});

/* ---------- nonce ceremony ---------- */

function ceremonyPrivs(n, seed) {
  return Array.from({ length: n }, (_, i) => priv(seed, (i * 37 + 11 + seed) % 251 + 1));
}

function fullCeremony(n, seed, networkId = "mainnet") {
  const privs = ceremonyPrivs(n, seed);
  const members = privs.map((p, i) => {
    const { pub } = M.memberFromPriv(p);
    return { name: "Member " + (i + 1), pubkey: M.bytesToHex(pub) };
  });
  const descriptor = M.buildMeshDescriptor(networkId, members);
  const msg = M.sha256(enc.encode(`ceremony ${n}/${seed}`));
  const salt = new Uint8Array(32).fill(seed);
  const aggX = M.hexToBytes(descriptor.agg);
  const L = M.hexToBytes(descriptor.L);
  const commits = privs.map((p, i) => {
    const { d, pub } = M.memberFromPriv(p);
    const nonce = M.memberNoncePair({ sec: d, aggX, L, msg, salt });
    return {
      i, d, pub: M.bytesToHex(pub), name: members[i].name, nonce,
      nonceText: M.nonceCommitBundle({ memberName: members[i].name, pubkey: M.bytesToHex(pub), R1i: nonce.R1i, R2i: nonce.R2i, msg, salt }),
    };
  });
  const aggBundle = M.aggregateNonces({ bundles: commits.map((c) => c.nonceText), descriptor, msg });
  const partials = commits.map((c) => {
    const { bundle } = M.memberPartialSign({
      priv: privs[c.i],
      slotPubkey: c.pub, descriptor, aggBundle, nonce: c.nonce, memberName: c.name,
    });
    return { partial: bundle, nonceBundle: c.nonceText };
  });
  return { descriptor, aggBundle, partials, msg, privs, commits };
}

test("full n-party ceremony round-trips (2..7 members), final BIP-340 sig verifies", () => {
  for (let n = 2; n <= 7; n++) {
    const { descriptor, aggBundle, partials, msg } = fullCeremony(n, n * 13);
    const fin = M.aggregatePartials({ partials, descriptor, aggBundle });
    assert.equal(fin.ok, true, `n=${n}: ` + fin.reason);
    // independent check: plain BIP-340 verify against the tweaked key
    const QtweakX = M.decodeBech32m(descriptor.address, "prl").program;
    assert.equal(schnorr.verify(M.hexToBytes(fin.sig), msg, QtweakX), true);
    // and via the standalone verifier
    const v = M.verifyMeshSignature({ sig: fin.sig, msg: M.bytesToHex(msg), aggKey: descriptor.address });
    assert.equal(v.ok, true);
    assert.match(v.reason, /PROVEN/);
  }
});

test("wrong private key is KEY REFUSED at signing time", () => {
  const { descriptor, aggBundle, commits } = fullCeremony(3, 99);
  const c = commits[0];
  const wrong = priv(9, 9);
  assert.throws(
    () => M.memberPartialSign({ priv: wrong, slotPubkey: c.pub, descriptor, aggBundle, nonce: c.nonce }),
    /KEY REFUSED/
  );
});

test("signing into another member's slot is refused", () => {
  const { descriptor, aggBundle, commits, privs } = fullCeremony(3, 100);
  const c0 = commits[0], c1 = commits[1];
  assert.throws(
    () => M.memberPartialSign({ priv: privs[0], slotPubkey: c1.pub, descriptor, aggBundle, nonce: c0.nonce }),
    /KEY REFUSED/
  );
});

test("tampered partial is rejected by the coordinator", () => {
  const { descriptor, aggBundle, partials } = fullCeremony(3, 101);
  const p = JSON.parse(partials[0].partial);
  const sBytes = M.hexToBytes(p.s);
  sBytes[0] ^= 0x01;
  p.s = M.bytesToHex(sBytes);
  const bad = [{ partial: JSON.stringify(p), nonceBundle: partials[0].nonceBundle }, partials[1], partials[2]];
  assert.throws(() => M.aggregatePartials({ partials: bad, descriptor, aggBundle }), /partial rejected/);
});

test("coordinator rejects duplicate and non-member bundles", () => {
  const { descriptor, aggBundle, partials, commits } = fullCeremony(3, 102);
  const dup = [partials[0], partials[0], partials[2]];
  assert.throws(() => M.aggregatePartials({ partials: dup, descriptor, aggBundle }), /duplicate partial/);
  // non-member nonce bundle at aggregation
  const outsider = M.memberFromPriv(priv(77, 78));
  const fake = M.nonceCommitBundle({
    memberName: "Mallory", pubkey: M.bytesToHex(outsider.pub), R1i: commits[0].nonce.R1i, R2i: commits[0].nonce.R2i,
    msg: M.hexToBytes(aggBundle.msg), salt: M.hexToBytes(aggBundle.salt),
  });
  const bundles = [fake, commits[1].nonceText, commits[2].nonceText];
  assert.throws(() => M.aggregateNonces({ bundles, descriptor, msg: M.hexToBytes(aggBundle.msg) }), /not a mesh member/);
});

test("mismatched message or salt across bundles is rejected", () => {
  const { descriptor, aggBundle, commits } = fullCeremony(2, 103);
  const other = M.nonceCommitBundle({
    memberName: commits[0].name, pubkey: commits[0].pub, R1i: commits[0].nonce.R1i, R2i: commits[0].nonce.R2i,
    msg: M.sha256(enc.encode("different")), salt: M.hexToBytes(aggBundle.salt),
  });
  assert.throws(
    () => M.aggregateNonces({ bundles: [other, commits[1].nonceText], descriptor, msg: M.hexToBytes(aggBundle.msg) }),
    /different message/
  );
});

test("final signature does not verify against a different message", () => {
  const { descriptor, aggBundle, partials } = fullCeremony(3, 104);
  const fin = M.aggregatePartials({ partials, descriptor, aggBundle });
  assert.equal(fin.ok, true);
  const QtweakX = M.decodeBech32m(descriptor.address, "prl").program;
  const other = M.sha256(enc.encode("something else"));
  assert.equal(schnorr.verify(M.hexToBytes(fin.sig), other, QtweakX), false);
});

test("verifyMeshSignature: loud NOT PROVEN on tampered sig / key / msg", () => {
  const { descriptor, aggBundle, partials, msg } = fullCeremony(2, 105);
  const fin = M.aggregatePartials({ partials, descriptor, aggBundle });
  const msgHex = M.bytesToHex(msg);
  assert.equal(M.verifyMeshSignature({ sig: fin.sig, msg: msgHex, aggKey: descriptor.address }).ok, true);
  // tampered sig
  const bad = fin.sig.slice(0, 10) + (fin.sig[10] === "0" ? "1" : "0") + fin.sig.slice(11);
  const v1 = M.verifyMeshSignature({ sig: bad, msg: msgHex, aggKey: descriptor.address });
  assert.equal(v1.ok, false);
  assert.match(v1.reason, /does NOT verify/);
  // wrong key
  const v2 = M.verifyMeshSignature({ sig: fin.sig, msg: msgHex, aggKey: K1 });
  assert.equal(v2.ok, false);
  // malformed inputs
  assert.equal(M.verifyMeshSignature({ sig: "00", msg: msgHex, aggKey: descriptor.address }).ok, false);
  assert.equal(M.verifyMeshSignature({ sig: fin.sig, msg: "zz", aggKey: descriptor.address }).ok, false);
  // descriptor JSON accepted as the key
  const v3 = M.verifyMeshSignature({ sig: fin.sig, msg: msgHex, aggKey: descriptor.descriptor });
  assert.equal(v3.ok, true);
});

test("odd-R sessions (nonce parity flip) round-trip", () => {
  let found = 0;
  for (let seed = 200; seed < 260 && found < 3; seed++) {
    const { descriptor, aggBundle, partials, msg } = fullCeremony(3, seed);
    if (!aggBundle.odd) continue;
    found++;
    const fin = M.aggregatePartials({ partials, descriptor, aggBundle });
    assert.equal(fin.ok, true, `odd-R seed ${seed} must verify`);
    const QtweakX = M.decodeBech32m(descriptor.address, "prl").program;
    assert.equal(schnorr.verify(M.hexToBytes(fin.sig), msg, QtweakX), true);
  }
  assert.ok(found >= 2, "expected to find odd-R sessions");
});

test("runSimulation: end-to-end demo path verifies", () => {
  const privs = ceremonyPrivs(4, 55);
  const msg = M.sha256(enc.encode("simulation demo"));
  const sim = M.runSimulation({ privs, msg, networkId: "mainnet" });
  assert.equal(sim.ok, true);
  assert.equal(sim.descriptor.members.length, 4);
  const v = M.verifyMeshSignature({
    sig: sim.sig, msg: sim.msg, aggKey: sim.descriptor.address,
  });
  assert.equal(v.ok, true);
});

test("digestForSigning: 64-hex passthrough, text hashed, empty refused", () => {
  const h = "ab".repeat(32);
  assert.equal(M.bytesToHex(M.digestForSigning(h)), h);
  assert.equal(M.bytesToHex(M.digestForSigning(h.toUpperCase())), h);
  const t = M.digestForSigning("hello mesh");
  assert.equal(M.bytesToHex(t), M.bytesToHex(M.sha256(enc.encode("hello mesh"))));
  assert.throws(() => M.digestForSigning(""), /enter a message/);
  assert.throws(() => M.digestForSigning("   "), /enter a message/);
});

test("nonce determinism: same inputs -> same nonces; fresh salt -> fresh nonces", () => {
  const { descriptor, commits } = fullCeremony(2, 106);
  const c = commits[0];
  const again = M.memberNoncePair({
    sec: c.d, aggX: M.hexToBytes(descriptor.agg), L: M.hexToBytes(descriptor.L),
    msg: M.hexToBytes(M.bytesToHex(M.sha256(enc.encode("ceremony 2/106")))), salt: new Uint8Array(32).fill(106),
  });
  assert.equal(again.R1i, c.nonce.R1i);
  assert.equal(again.R2i, c.nonce.R2i);
  const fresh = M.memberNoncePair({
    sec: c.d, aggX: M.hexToBytes(descriptor.agg), L: M.hexToBytes(descriptor.L),
    msg: M.hexToBytes(M.bytesToHex(M.sha256(enc.encode("ceremony 2/106")))), salt: M.newSalt(),
  });
  assert.notEqual(fresh.R1i, c.nonce.R1i);
});

test("parseUtxoList re-export works for air-gapped UTXOs", () => {
  const txid = "ab".repeat(32);
  const utxos = M.parseUtxoList(`${txid}:0 1.5 prl prl1p3faqn7s30jk4qmz06309lyry3v7yjy34lglq22px3ypheykhyq0s23h6ky`, M.NETWORKS.mainnet);
  assert.equal(utxos.length, 1);
  assert.equal(utxos[0].value, 150000000);
  assert.ok(utxos[0].spk instanceof Uint8Array);
});
