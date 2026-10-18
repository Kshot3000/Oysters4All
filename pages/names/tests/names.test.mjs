// Pearl Names node test suite. Run: node --no-warnings --loader ./tests/loader.mjs tests/names.test.mjs
import { strict as assert } from "node:assert";
import {
  NETWORKS, bytesToHex, hexToBytes, tweakKeypath,
  validateName, displayName, RESERVED_NAMES,
  composeBinding, validateNameRecord, bindingId, fingerprint,
  signBinding, verifySignedBinding,
  buildNameScript, planNameInscription, composeNamePayload,
  addressToProgram, verifyNameWitness, buildCommitTx, buildRevealTxSigned,
  resolveRegistry, buildNameCertificate, verifyNameOnChain,
  NAME_MARKER, NAME_VERSION, NAME_SUFFIX,
  newMnemonic, walletFromMnemonic,
} from "../src/names-core.js";
import { utf8ToBytes } from "@noble/hashes/utils";

const MN = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const NET = "mainnet";
const now = () => Math.floor(Date.now() / 1000);

let pass = 0, fail = 0;
function t(label, fn) {
  try { fn(); pass++; }
  catch (e) { fail++; console.error("FAIL:", label, "—", e.message); }
}
const throws = (fn, part) => {
  try { fn(); } catch (e) { if (part && !e.message.includes(part)) throw new Error(`wrong error: ${e.message}`); return; }
  throw new Error("did not throw");
};

/* ---- name format ---- */
t("valid names normalize", () => {
  assert.equal(validateName("Kshot"), "kshot");
  assert.equal(validateName("  bob-builder7  "), "bob-builder7");
  assert.equal(validateName("kshot.prl"), "kshot"); // suffix stripped
});
t("rejects bad names", () => {
  throws(() => validateName("ab"), "3–63");
  throws(() => validateName("a".repeat(64)), "3–63");
  throws(() => validateName("-abc"), "a–z");
  throws(() => validateName("abc-"), "a–z");
  throws(() => validateName("a--b"), "consecutive");
  throws(() => validateName("a_b"), "a–z");
  throws(() => validateName("A B"), "a–z");
  throws(() => validateName("123"), "all digits");
  throws(() => validateName("pearl"), "reserved");
  throws(() => validateName("prl"), "reserved");
});
t("reserved set is non-empty", () => assert.ok(RESERVED_NAMES.size > 10));
t("displayName appends suffix", () => assert.equal(displayName("kshot"), "kshot" + NAME_SUFFIX));

/* ---- binding composition ---- */
const W = walletFromMnemonic(MN, NETWORKS[NET]);
t("composeBinding canonical order", () => {
  const b = composeBinding({ name: "Test-Name", address: W.address, xonly: bytesToHex(W.internalXOnly), network: NET, registeredAt: 1788000000, expiresAt: null });
  const keys = Object.keys(JSON.parse(b.json));
  assert.deepEqual(keys, ["v", "name", "address", "xonly", "network", "registered_at", "expires_at"]);
  assert.equal(JSON.parse(b.json).name, "test-name");
  assert.equal(JSON.parse(b.json).address, W.address); // re-encoded canonical
  assert.equal(JSON.parse(b.json).expires_at, null);
});
t("composeBinding rejects bad fields", () => {
  const good = { name: "alice", address: W.address, xonly: bytesToHex(W.internalXOnly), network: NET, registeredAt: 1788000000, expiresAt: null };
  throws(() => composeBinding({ ...good, address: "bc1qxyz" }));
  throws(() => composeBinding({ ...good, xonly: "zz" }), "64");
  throws(() => composeBinding({ ...good, registeredAt: 100 }), "epoch");
  throws(() => composeBinding({ ...good, expiresAt: 1788000000 }), "after registered_at");
  throws(() => composeBinding({ ...good, expiresAt: 100000000000000000000 }), "integer unix timestamp");
  throws(() => composeBinding({ ...good, name: "root" }), "reserved");
});
t("composeBinding allows expires_at years in the future", () => {
  const good = { name: "alice", address: W.address, xonly: bytesToHex(W.internalXOnly), network: NET, registeredAt: 1788000000, expiresAt: null };
  const far = Math.floor(Date.now() / 1000) + 5 * 365 * 86400; // 5 years out
  const b = composeBinding({ ...good, expiresAt: far });
  assert.equal(JSON.parse(b.json).expires_at, far);
  throws(() => composeBinding({ ...good, expiresAt: 1700000000 }), "epoch");
  // and the verifier rules it VALID ⚠ only when inside the 30-day warning window
  const soon = Math.floor(Date.now() / 1000) + 10 * 86400;
  const b2 = composeBinding({ ...good, registeredAt: Math.floor(Date.now() / 1000), expiresAt: soon });
  const sig = signBinding(W.priv, b2, NETWORKS[NET]);
  const v = verifySignedBinding({ json: b2.json, sig: bytesToHex(sig) });
  assert.equal(v.ok, true, JSON.stringify(v.checks.filter((c) => !c.ok)));
  assert.ok(v.checks.some((c) => c.label === "not expired" && c.warn), "expiring-soon warning expected");
  assert.ok(v.checks.some((c) => c.label === "not expired" && c.ok));
});
t("verifySignedBinding: expiry beyond the Date-representable range never throws", () => {
  // expires_at is a safe integer and allowFuture sets no upper bound, so
  // 1e13 passes validation — but new Date(1e13 * 1000).toISOString()
  // throws RangeError. The verifier documents "never throws": it must
  // rule the binding valid with a non-throwing expiry detail.
  const good = { name: "alice", address: W.address, xonly: bytesToHex(W.internalXOnly), network: NET, registeredAt: 1788000000, expiresAt: null };
  const b = composeBinding({ ...good, expiresAt: 10000000000000 });
  const sig = signBinding(W.priv, b, NETWORKS[NET]);
  const v = verifySignedBinding({ json: b.json, sig: bytesToHex(sig) });
  assert.equal(v.ok, true, JSON.stringify(v.checks.filter((c) => !c.ok)));
  const exp = v.checks.find((c) => c.label === "not expired");
  assert.ok(exp && exp.ok && /beyond the representable range/.test(exp.detail), JSON.stringify(exp));
});
t("validateNameRecord round-trips", () => {
  const b = composeBinding({ name: "alice", address: W.address, xonly: bytesToHex(W.internalXOnly), network: NET, registeredAt: 1788000000, expiresAt: null });
  validateNameRecord(JSON.parse(b.json));
  throws(() => validateNameRecord({ ...JSON.parse(b.json), v: 2 }), "v must be 1");
});
t("bindingId/fingerprint shapes", () => {
  const b = composeBinding({ name: "alice", address: W.address, xonly: bytesToHex(W.internalXOnly), network: NET, registeredAt: 1788000000, expiresAt: null });
  const id = bindingId(b.bytes);
  assert.match(id, /^[0-9a-f]{64}$/);
  assert.match(fingerprint(id), /^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/);
});

/* ---- ownership proof ---- */
t("sign + verify binding (happy path)", () => {
  const b = composeBinding({ name: "alice", address: W.address, xonly: bytesToHex(W.internalXOnly), network: NET, registeredAt: 1788000000, expiresAt: null });
  const sig = signBinding(W.priv, b, NETWORKS[NET]);
  assert.equal(sig.length, 64);
  const v = verifySignedBinding({ json: b.json, sig: bytesToHex(sig) });
  assert.equal(v.ok, true, JSON.stringify(v.checks.filter((c) => !c.ok)));
  assert.equal(v.name, "alice");
  assert.equal(v.address, W.address);
  assert.equal(v.checks.length, 6);
});
t("signBinding wrong-key refusal", () => {
  const W2 = walletFromMnemonic(MN, NETWORKS[NET], 0, 1);
  const b = composeBinding({ name: "alice", address: W.address, xonly: bytesToHex(W.internalXOnly), network: NET, registeredAt: 1788000000, expiresAt: null });
  throws(() => signBinding(W2.priv, b, NETWORKS[NET]), "WRONG KEY");
});
t("verify rejects tampered JSON", () => {
  const b = composeBinding({ name: "alice", address: W.address, xonly: bytesToHex(W.internalXOnly), network: NET, registeredAt: 1788000000, expiresAt: null });
  const sig = signBinding(W.priv, b, NETWORKS[NET]);
  const tampered = b.json.replace("alice", "mallory");
  const v = verifySignedBinding({ json: tampered, sig: bytesToHex(sig) });
  assert.equal(v.ok, false);
  const bad = v.checks.find((c) => c.label === "signature valid");
  assert.equal(bad.ok, false);
});
t("verify rejects swapped sig bytes", () => {
  const b = composeBinding({ name: "alice", address: W.address, xonly: bytesToHex(W.internalXOnly), network: NET, registeredAt: 1788000000, expiresAt: null });
  const sig = signBinding(W.priv, b, NETWORKS[NET]);
  sig[0] ^= 0x01;
  const v = verifySignedBinding({ json: b.json, sig: bytesToHex(sig) });
  assert.equal(v.ok, false);
});
t("verify flags expired binding", () => {
  const b = composeBinding({ name: "alice", address: W.address, xonly: bytesToHex(W.internalXOnly), network: NET, registeredAt: 1788000000, expiresAt: 1788003600 });
  const sig = signBinding(W.priv, b, NETWORKS[NET]);
  const v = verifySignedBinding({ json: b.json, sig: bytesToHex(sig) });
  // The pinned lifetime (2026-08-29 10:40–11:40 UTC) is in the past, so the
  // real-clock verdict is expired — assert the verdict itself, not merely
  // that an expiry check exists.
  assert.equal(v.ok, false);
  const exp = v.checks.find((c) => c.label === "not expired");
  assert.ok(exp && exp.ok === false && exp.detail.includes("expired at 2026-08-29T11:40:00.000Z"), JSON.stringify(exp));
});
t("verify judges expiry against opts.nowSec, not the wall clock", () => {
  // Same pinned binding as above: judged inside its lifetime it verifies,
  // judged past expiry it does not — the verdict is a function of the
  // record and the stated instant. On the pre-fix core (no clock
  // injection) the first assertion fails: the real clock rules instead.
  const b = composeBinding({ name: "alice", address: W.address, xonly: bytesToHex(W.internalXOnly), network: NET, registeredAt: 1788000000, expiresAt: 1788003600 });
  const sig = signBinding(W.priv, b, NETWORKS[NET]);
  const signed = { json: b.json, sig: bytesToHex(sig) };
  const live = verifySignedBinding(signed, { nowSec: 1788001800 });
  assert.equal(live.ok, true, JSON.stringify(live.checks.filter((c) => !c.ok)));
  const dead = verifySignedBinding(signed, { nowSec: 1788003601 });
  assert.equal(dead.ok, false);
  // The registered_at future check is judged against the same instant:
  // two hours before registration the record is future-dated and invalid.
  const early = verifySignedBinding(signed, { nowSec: 1788000000 - 7200 });
  assert.equal(early.ok, false);
  assert.ok(early.checks.some((c) => c.label === "record valid" && !c.ok && /future/.test(c.detail)), JSON.stringify(early.checks));
});

/* ---- envelope ---- */
t("buildNameScript carries prl-name marker", () => {
  const s = buildNameScript(W.internalXOnly, utf8ToBytes('{"p":"prl-name"}'));
  const hex = bytesToHex(s);
  assert.ok(hex.includes(Buffer.from(NAME_MARKER).toString("hex")));
  assert.ok(s[s.length - 1] === 0x68); // OP_ENDIF
});
t("envelope marker ≠ prl-20", () => assert.notEqual(NAME_MARKER, "prl-20"));

/* ---- plan ---- */
t("planNameInscription math sanity", () => {
  const b = composeBinding({ name: "alice", address: W.address, xonly: bytesToHex(W.internalXOnly), network: NET, registeredAt: 1788000000, expiresAt: null });
  const sig = signBinding(W.priv, b, NETWORKS[NET]);
  const payload = composeNamePayload({ binding: b, sigHex: bytesToHex(sig) });
  const plan = planNameInscription({ network: NETWORKS[NET], internalXOnly: W.internalXOnly, payload, ownerAddress: W.address, changeAddress: W.address, feeRate: 5 });
  assert.equal(plan.commitValue, plan.revealFee + 1000);
  assert.ok(plan.revealFee > 0);
  assert.ok(plan.commitAddress.startsWith("prl1"));
  assert.ok(plan.leafHash.length === 64);
  assert.ok(plan.controlBlockHex.length > 0);
});
t("composeNamePayload enforces p marker + sig", () => {
  const b = composeBinding({ name: "alice", address: W.address, xonly: bytesToHex(W.internalXOnly), network: NET, registeredAt: 1788000000, expiresAt: null });
  const payload = composeNamePayload({ binding: b, sigHex: "ab".repeat(64) });
  assert.equal(JSON.parse(payload.json).p, NAME_MARKER);
  throws(() => composeNamePayload({ binding: b, sigHex: "ab" }), "128");
});

/* ---- witness round-trip through etch-core ---- */
t("reveal round-trip: witness parses prl-name envelope + verifies", () => {
  const b = composeBinding({ name: "alice", address: W.address, xonly: bytesToHex(W.internalXOnly), network: NET, registeredAt: 1788000000, expiresAt: null });
  const sig = signBinding(W.priv, b, NETWORKS[NET]);
  const payload = composeNamePayload({ binding: b, sigHex: bytesToHex(sig) });
  const plan = planNameInscription({ network: NETWORKS[NET], internalXOnly: W.internalXOnly, payload, ownerAddress: W.address, changeAddress: W.address, feeRate: 2 });
  const commit = buildCommitTx({
    network: NETWORKS[NET],
    fundingInputs: [{ txid: "00".repeat(32), vout: 0, value: plan.commitValue + 20000, program: plan.changeProgram, priv: W.priv, internalXOnly: W.internalXOnly }],
    commitProgram: plan.commitProgram, commitValue: plan.commitValue,
    changeProgram: plan.changeProgram, feeRate: 2,
  });
  const reveal = buildRevealTxSigned({
    plan, commitTxid: commit.txid, commitVout: 0,
    internalPriv: W.priv, changeAddress: W.address,
  });
  const v = verifyNameWitness(reveal.hex);
  assert.equal(v.verify.ok, true, JSON.stringify(v.verify.checks.filter((c) => !c.ok)));
  assert.equal(v.verify.name, "alice");
  assert.equal(v.record.name, "alice");
});
t("verifyNameWitness throws without prl-name envelope", () => {
  const b = composeBinding({ name: "alice", address: W.address, xonly: bytesToHex(W.internalXOnly), network: NET, registeredAt: 1788000000, expiresAt: null });
  throws(() => verifyNameWitness(bytesToHex(utf8ToBytes("00".repeat(200)))));
});

/* ---- registry ---- */
t("resolveRegistry first-seen wins", () => {
  const W2 = walletFromMnemonic(MN, NETWORKS[NET], 0, 1);
  const mk = (name, w, ts) => {
    const b = composeBinding({ name, address: w.address, xonly: bytesToHex(w.internalXOnly), network: NET, registeredAt: ts, expiresAt: null });
    const sig = signBinding(w.priv, b, NETWORKS[NET]);
    return { json: b.json, sig: bytesToHex(sig), fields: b.fields };
  };
  const r1 = mk("dupe", W, 1788000100);
  const r2 = mk("dupe", W2, 1788000200); // later, contested
  const r3 = mk("solo", W2, 1788000300);
  const { winners, contested, rejected } = resolveRegistry([r2, r3, r1]);
  assert.equal(winners.size, 2);
  assert.equal(winners.get("dupe").id, verifySignedBinding(r1).id);
  assert.equal(contested.length, 1);
  assert.equal(rejected.length, 0);
});
t("resolveRegistry rejects invalid records", () => {
  const { winners, rejected } = resolveRegistry([{ json: "not json", sig: "00".repeat(64) }]);
  assert.equal(winners.size, 0);
  assert.equal(rejected.length, 1);
});

/* ---- certificate ---- */
t("buildNameCertificate shape", () => {
  const b = composeBinding({ name: "alice", address: W.address, xonly: bytesToHex(W.internalXOnly), network: NET, registeredAt: 1788000000, expiresAt: null });
  const sig = signBinding(W.priv, b, NETWORKS[NET]);
  const payload = composeNamePayload({ binding: b, sigHex: bytesToHex(sig) });
  const plan = planNameInscription({ network: NETWORKS[NET], internalXOnly: W.internalXOnly, payload, ownerAddress: W.address, changeAddress: W.address, feeRate: 2 });
  const cert = buildNameCertificate({ plan, payload, commitTxid: "11".repeat(32), revealTxid: "22".repeat(32), blockHeight: 42, blockTime: 1700000000 });
  assert.equal(cert.app, "Pearl Names");
  assert.equal(cert.name, "alice.prl");
  assert.equal(cert.commit.txid, "11".repeat(32));
  assert.match(cert.registration.fingerprint, /^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/);
});

/* ---- address plumbing ---- */
t("addressToProgram round-trip", () => {
  const prog = addressToProgram(W.address, NETWORKS[NET]);
  const { tweakedX } = tweakKeypath(W.internalXOnly);
  assert.equal(bytesToHex(prog), bytesToHex(tweakedX));
});
t("newMnemonic wallet pipeline", () => {
  const m = newMnemonic();
  const w = walletFromMnemonic(m, NETWORKS[NET]);
  assert.ok(w.address.startsWith("prl1"));
  assert.equal(w.internalXOnly.length, 32);
});

/* ---- on-chain verify: endpoint strings never pass through ---- */
await (async () => {
  // The verify result's chain fields are rendered by callers — a hostile
  // user-configured Blockbook returning string blockHeight/blockTime/
  // confirmations (or a forged response txid) must not pass through raw.
  const b = composeBinding({ name: "alice", address: W.address, xonly: bytesToHex(W.internalXOnly), network: NET, registeredAt: 1788000000, expiresAt: null });
  const sig = signBinding(W.priv, b, NETWORKS[NET]);
  const payload = composeNamePayload({ binding: b, sigHex: bytesToHex(sig) });
  const plan = planNameInscription({ network: NETWORKS[NET], internalXOnly: W.internalXOnly, payload, ownerAddress: W.address, changeAddress: W.address, feeRate: 2 });
  const commit = buildCommitTx({
    network: NETWORKS[NET],
    fundingInputs: [{ txid: "00".repeat(32), vout: 0, value: plan.commitValue + 20000, program: plan.changeProgram, priv: W.priv, internalXOnly: W.internalXOnly }],
    commitProgram: plan.commitProgram, commitValue: plan.commitValue,
    changeProgram: plan.changeProgram, feeRate: 2,
  });
  const reveal = buildRevealTxSigned({ plan, commitTxid: commit.txid, commitVout: 0, internalPriv: W.priv, changeAddress: W.address });
  const EVIL = "<svg onload=alert(1)>";
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ hex: reveal.hex, txid: EVIL, blockHeight: EVIL, blockTime: EVIL, confirmations: EVIL }) });
  try {
    const v = await verifyNameOnChain("https://evil.example", "ab".repeat(32));
    t("verifyNameOnChain coerces endpoint-supplied chain fields", () => {
      assert.equal(v.confirmations, 0);
      assert.equal(v.blockHeight, null);
      assert.equal(v.blockTime, null);
      assert.equal(v.txid, "ab".repeat(32)); // the validated request txid, not the response's
    });
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ hex: reveal.hex, txid: "ab".repeat(32), blockHeight: 900000, blockTime: 1760000000, confirmations: 9 }) });
    const good = await verifyNameOnChain("https://ok.example", "ab".repeat(32));
    t("verifyNameOnChain keeps real numeric chain fields", () => {
      assert.equal(good.confirmations, 9);
      assert.equal(good.blockHeight, 900000);
      assert.equal(good.blockTime, 1760000000);
    });
  } finally { globalThis.fetch = realFetch; }
})();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
