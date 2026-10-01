/* Pearl Drop core tests — run with plain `node tests/logic.test.mjs`.
 * Pinned vectors + edge cases for every crypto and business-logic function. */
import {
  sha256, utf8ToBytes, bytesToHex, hexToBytes,
  encodeBech32m, decodeBech32m, convertBits,
  prlToGrains, grainsToPrl, validateDropAddress,
  composeCampaign, campaignId, transitionStatus,
  parseDropCsv, dedupeRecipients,
  dropLeafHash, buildDropTree, dropProof, verifyDropProof,
  composeSeal, dropEnvelopeBody, verifySealPackage, claimForAddress,
  fingerprint,
} from "../src/logic.js";

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; }
  else { fail++; console.error("FAIL:", label); }
}
function throws(fn, label) {
  try { fn(); fail++; console.error("FAIL (no throw):", label); }
  catch { pass++; }
}

/* ---- deterministic test addresses (fixed 32-byte programs) ---- */
function prog(seed) {
  return Uint8Array.from({ length: 32 }, (_, i) => (seed + i * 37) & 255);
}
const A1 = encodeBech32m("prl", 1, prog(1));
const A2 = encodeBech32m("prl", 1, prog(2));
const A3 = encodeBech32m("prl", 1, prog(3));
const A4 = encodeBech32m("prl", 1, prog(4));
const A5 = encodeBech32m("prl", 1, prog(5));

/* ---- SHA-256 known vectors ---- */
ok(bytesToHex(sha256(utf8ToBytes("abc"))) === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "sha256('abc')");
ok(bytesToHex(sha256(utf8ToBytes(""))) === "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "sha256('')");
ok(bytesToHex(sha256(utf8ToBytes("The quick brown fox jumps over the lazy dog"))) === "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592", "sha256(fox)");

/* ---- grains math ---- */
ok(prlToGrains("0.00000001") === 1n, "1 grain");
ok(prlToGrains("1") === 100000000n, "1 PRL");
ok(prlToGrains("1.5") === 150000000n, "1.5 PRL");
ok(prlToGrains("  21.00000001 ") === 2100000001n, "trimmed input");
ok(prlToGrains("0.1") === 10000000n, "0.1 PRL");
throws(() => prlToGrains("0.000000001"), "reject 9 decimals");
throws(() => prlToGrains("-1"), "reject negative");
throws(() => prlToGrains("abc"), "reject garbage");
throws(() => prlToGrains(""), "reject empty");
throws(() => prlToGrains("1."), "reject trailing dot");
throws(() => prlToGrains("1.0000000x"), "reject trailing junk");
ok(grainsToPrl(1n) === "0.00000001", "grainsToPrl 1");
ok(grainsToPrl(100000000n) === "1", "grainsToPrl 1 PRL");
ok(grainsToPrl(150000000n) === "1.5", "grainsToPrl trims zeros");
ok(grainsToPrl(0n) === "0", "grainsToPrl zero");
throws(() => grainsToPrl(-1n), "reject negative grains");

/* ---- bech32m round-trip + strict address validation ---- */
{
  const d = decodeBech32m(A1, "prl");
  ok(d.version === 1 && d.program.length === 32, "decode v1/32");
  ok(encodeBech32m(d.hrp, 1, d.program) === A1, "canonical re-encode");
  ok(validateDropAddress(A1) === A1, "accept valid prl1 address");
  ok(validateDropAddress(" " + A2 + " ") === A2, "accept padded");
}
throws(() => validateDropAddress(encodeBech32m("tprl", 1, prog(9))), "reject wrong HRP (tprl)");
throws(() => validateDropAddress(A1.slice(0, -1) + (A1.endsWith("q") ? "p" : "q")), "reject bad checksum");
ok(validateDropAddress(A1.toUpperCase()) === A1, "uppercase accepted (BIP-350), normalized to canonical lowercase");
throws(() => validateDropAddress("prl1notanaddress"), "reject garbage");
throws(() => validateDropAddress("prl1QQqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq"), "reject bad charset");
{
  // v0 witness built by hand (BIP-350: v0 uses bech32, and drop only accepts v1 anyway)
  const p = prog(7);
  const d5 = [0, ...convertBits([...p], 8, 5, true)];
  const addr = "prl1" + "qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq"; // wrong on purpose
  throws(() => validateDropAddress(addr), "reject v0-style junk");
}

/* ---- campaign ---- */
const goodCampaign = {
  name: "Genesis Storm",
  tick: "PEARL",
  startsAt: "2026-10-01T00:00:00Z",
  endsAt: "2026-10-31T23:59:59Z",
  contact: "operator self-declared",
};
const header = composeCampaign(goodCampaign);
ok(header.fields.tick === "PEARL", "campaign tick");
ok(header.fields.starts_at === "2026-10-01T00:00:00.000Z", "starts_at canonical ISO");
const id1 = campaignId(header.json);
const id2 = campaignId(composeCampaign(goodCampaign).json);
ok(id1 === id2 && /^[0-9a-f]{64}$/.test(id1), "campaign id stable");
ok(campaignId(composeCampaign({ ...goodCampaign, name: "Other Storm" }).json) !== id1, "campaign id changes with name");
throws(() => composeCampaign({ ...goodCampaign, tick: "pearl" }), "reject lowercase tick");
throws(() => composeCampaign({ ...goodCampaign, tick: "TOOLONGTICK" }), "reject 9-char tick");
throws(() => composeCampaign({ ...goodCampaign, tick: "PEARL!" }), "reject punctuation tick");
throws(() => composeCampaign({ ...goodCampaign, endsAt: "2026-10-01T00:00:00Z" }), "reject end == start");
throws(() => composeCampaign({ ...goodCampaign, name: "" }), "reject empty name");
throws(() => composeCampaign({ ...goodCampaign, contact: "x".repeat(201) }), "reject long contact");
ok(composeCampaign({ ...goodCampaign, contact: "" }).fields.contact === "", "empty contact ok");
ok(transitionStatus("draft", "open") === "open", "draft->open");
ok(transitionStatus("open", "close") === "closed", "open->closed");
ok(transitionStatus("closed", "reopen") === "open", "closed->open");
ok(transitionStatus("closed", "seal") === "sealed", "closed->sealed");
throws(() => transitionStatus("draft", "seal"), "cannot seal from draft");
throws(() => transitionStatus("sealed", "open"), "cannot reopen sealed");

/* ---- CSV parsing ---- */
const csv = `# comment line
address,amount
${A1},1.5

${A2},0.00000001
${A3},  21
# another comment
${A1}, 9
badaddress,1
${A4},notanumber
${A5},0
${A4},2.5,extra-column-ignored
`;
const parsed = parseDropCsv(csv);
ok(parsed.rows.length === 5, "csv rows parsed (got " + parsed.rows.length + ")");
ok(parsed.rows[0].address === A1 && parsed.rows[0].amountGrains === 150000000n, "csv row 1");
ok(parsed.rows[1].amountGrains === 1n, "csv 1-grain row");
ok(parsed.invalid.length === 3, "csv invalid rows (got " + parsed.invalid.length + ")");
ok(parsed.invalid.some((r) => r.reason.startsWith("bad address")), "bad address flagged");
ok(parsed.invalid.some((r) => r.reason.startsWith("bad amount")), "bad amount flagged");
ok(parsed.invalid.some((r) => r.reason === "amount must be > 0"), "zero amount flagged");
const empty = parseDropCsv("address,amount\n# nothing here\n\n");
ok(empty.rows.length === 0 && empty.invalid.length === 0, "empty csv");
{
  // parseDropCsv never throws on hostile rows — it reports them instead
  const r = parseDropCsv(`${A1},0.000000001`);
  ok(r.rows.length === 0 && r.invalid.length === 1, "9-decimal row reported, not thrown");
}

/* ---- dedupe: first-seen wins ---- */
const ded = dedupeRecipients(parsed.rows);
ok(ded.recipients.length === 4, "dedupe count (got " + ded.recipients.length + ")");
ok(ded.duplicates.length === 1 && ded.duplicates[0].address === A1, "duplicate reported");
ok(ded.recipients.find((r) => r.address === A1).amountGrains === 150000000n, "first-seen amount wins");
ok(ded.recipients[0].index === 0 && ded.recipients[3].index === 3, "0-based indices after dedupe");

/* ---- merkle tree ---- */
function treeOf(addrs, amounts) {
  const recs = addrs.map((a, i) => ({ index: i, address: a, amountGrains: amounts[i] }));
  return buildDropTree(recs.map((r) => dropLeafHash(r.index, r.address, r.amountGrains)));
}
const t4 = treeOf([A1, A2, A3, A4], [100n, 200n, 300n, 400n]);
const t4b = treeOf([A1, A2, A3, A4], [100n, 200n, 300n, 400n]);
ok(t4.rootHex === t4b.rootHex && t4.depth === 2, "root deterministic, depth 2 for 4 leaves");
ok(t4.leafCount === 4, "leaf count");
for (let i = 0; i < 4; i++) {
  const recs = [A1, A2, A3, A4].map((a, j) => ({ index: j, address: a, amountGrains: [100n, 200n, 300n, 400n][j] }));
  const leafHex = bytesToHex(dropLeafHash(i, recs[i].address, recs[i].amountGrains));
  ok(verifyDropProof(leafHex, dropProof(t4, i), t4.rootHex), "proof verifies leaf " + i);
}
{
  // tamper detection: same proof, flipped amount -> must fail
  const proof = dropProof(t4, 1);
  const badLeaf = bytesToHex(dropLeafHash(1, A2, 999999n));
  ok(!verifyDropProof(badLeaf, proof, t4.rootHex), "tampered leaf fails");
  const badProof = JSON.parse(JSON.stringify(proof));
  badProof[0].siblingHex = "00".repeat(32);
  const leaf1 = bytesToHex(dropLeafHash(1, A2, 200n));
  ok(!verifyDropProof(leaf1, badProof, t4.rootHex), "tampered proof fails");
  ok(!verifyDropProof(leaf1, proof, "ff".repeat(32)), "wrong root fails");
}
{
  // odd count duplicates the last leaf; single leaf tree
  const t3 = treeOf([A1, A2, A3], [1n, 2n, 3n]);
  ok(t3.depth === 2 && t3.leafCount === 3, "odd count tree ok");
  const t1 = treeOf([A1], [42n]);
  ok(t1.depth === 0 && t1.leafCount === 1, "single leaf depth 0");
  const leaf = bytesToHex(dropLeafHash(0, A1, 42n));
  ok(t1.rootHex === leaf, "single leaf root == leaf");
  ok(verifyDropProof(leaf, dropProof(t1, 0), t1.rootHex), "single leaf proof (empty) verifies");
  ok(dropProof(t1, 0).length === 0, "single leaf proof empty");
}
throws(() => buildDropTree([]), "reject empty tree");
throws(() => dropProof(t4, 9), "reject out-of-range proof index");
ok(bytesToHex(dropLeafHash(0, A1, 1n)) === bytesToHex(dropLeafHash(0, A1, 1n)), "leaf deterministic");
ok(bytesToHex(dropLeafHash(0, A1, 1n)) !== bytesToHex(dropLeafHash(1, A1, 1n)), "leaf binds index");

/* ---- seal + verify package ---- */
const sealCsv = `${A1},1.5\n${A2},2\n${A3},0.00000001\n`;
const sealRows = dedupeRecipients(parseDropCsv(sealCsv).rows).recipients;
const sealLeaves = sealRows.map((r) => dropLeafHash(r.index, r.address, r.amountGrains));
const sealTree = buildDropTree(sealLeaves);
const sealTotal = sealRows.reduce((a, r) => a + r.amountGrains, 0n);
const seal = composeSeal({
  campaignJson: header.json,
  tick: "PEARL",
  rootHex: sealTree.rootHex,
  leafCount: sealTree.leafCount,
  totalGrains: sealTotal,
  sealedAtIso: "2026-09-30T21:00:00.000Z",
});
ok(/^[0-9a-f]{64}$/.test(seal.sealId), "seal id is sha256 hex");
ok(seal.sealId === bytesToHex(sha256(utf8ToBytes(seal.json))), "seal id = sha256(canonical)");
ok(seal.fields.leaf_count === 3 && seal.fields.total_grains === sealTotal.toString(), "seal fields");
const env = dropEnvelopeBody(seal.json);
ok(env.p === "prl-drop" && env.op === "seal" && env.body === seal.json, "prl-drop envelope body");
const vv = verifySealPackage(seal.json, sealCsv);
ok(vv.ok === true && vv.checks.every((c) => c.ok), "verify package PROVEN");
ok(vv.checks.length >= 7, "verify has full check list");
const vvBad = verifySealPackage(seal.json, `${A1},1.5\n${A2},2\n${A3},999\n`);
ok(vvBad.ok === false && vvBad.checks.some((c) => !c.ok && c.label === "merkle root"), "tampered amounts -> NOT PROVEN");
const vvWrongCount = JSON.parse(seal.json);
vvWrongCount.leaf_count = 99;
ok(verifySealPackage(JSON.stringify(vvWrongCount), sealCsv).ok === false, "wrong leaf count -> NOT PROVEN");
ok(verifySealPackage("not json", sealCsv).ok === false, "garbage seal -> NOT PROVEN");
ok(verifySealPackage(seal.json, "address,amount\n").ok === false, "empty recipient list -> NOT PROVEN");

/* ---- claim lookup ---- */
const c1 = claimForAddress(seal.json, sealCsv, A2);
ok(c1.ok && c1.valid && c1.amountGrains === 200000000n && c1.amountPrl === "2", "claim VALID with amount");
ok(c1.proof.length > 0 && c1.rootHex === sealTree.rootHex, "claim returns proof + root");
const cUnknown = claimForAddress(seal.json, sealCsv, A5);
ok(!cUnknown.ok && !cUnknown.valid, "unknown address -> INVALID");
const cBad = claimForAddress(seal.json, sealCsv, "prl1junk");
ok(!cBad.ok && !cBad.valid, "bad address -> INVALID");

ok(fingerprint("abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890") === "abcd-ef12-3456-7890", "fingerprint grouping");
ok(hexToBytes(bytesToHex(sha256(utf8ToBytes("x")))).length === 32, "hex round trip");

console.log(`\n${pass}/${pass + fail} logic tests passed`);
if (fail) process.exit(1);
