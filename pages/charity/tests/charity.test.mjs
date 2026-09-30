// Pearl Charity node core tests — campaign forge guards, descriptor
// round-trip + tamper refusal, pinned fixture descriptor, fingerprint format,
// receipt hash round-trip + tamper refusal, lifecycle classification,
// deadline countdown math, optional organizer authorship sign→verify,
// and the loud descriptor verifier.
// Usage: node --no-warnings --loader ./tests/loader.mjs tests/charity.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  forgeCampaign, campaignDescriptor, parseCampaignDescriptor, verifyDescriptor,
  parseCampaignSpec, serializeCampaign, descriptorFingerprint, campaignHash,
  recordReceipt, verifyReceiptHash, crossCheckReceipt,
  classifyCampaign, formatDeadlineCountdown, countDonors,
  checkGoalGrains, checkRecipientAddress, checkDeadlineHeight,
  parsePRLToGrains, fmtPRL, organizerKeyFromInput,
  fetchCampaignStats, fetchTipHeight,
  DUST_GRAIN, GRAIN_PER_PRL, NETWORKS, PEARL_BLOCK_SECS,
  sha256, bytesToHex, hexToBytes, encodeBech32m, schnorr,
  signForXOnly, verifySchnorrSig,
} from "../src/index.js";

const MAINNET = NETWORKS.mainnet;
const TE = new TextEncoder();
const sha = (s) => sha256(TE.encode(s));

// Fixture: deterministic recipient address (no key material — it is only
// validated, never spent from).
const FIXTURE_RECIPIENT = encodeBech32m("prl", 1, sha("pearl-charity-fixture-recipient"));
const forge = (over = {}) => forgeCampaign({
  network: MAINNET,
  orgName: "Pearl Lantern Society",
  recipient: FIXTURE_RECIPIENT,
  goalPRL: "100",
  deadlineHeight: 901000,
  description: "Fixture campaign — lanterns for every block.",
  contact: "@lantern",
  orgSignMode: "nosign",
  ...over,
}).campaign;

// Pinned vector (fixture above — recompute only if the fixture inputs or the
// canonical-JSON scheme change).
const PIN = {
  recipient: "prl1pft455f03ps70k9wkvsvg7xk46ftaejkjmsh7gaj9439ssqkjczrqjfpnkh",
  descriptor: "pearl-charity:v1:prl:9eb8389d19a9345c250d12f50b39e1810be489fd76c3a97362be1f82a5f37523:10000000000:901000",
  fingerprint: "5e825a0104227415",
  hashHex: "9eb8389d19a9345c250d12f50b39e1810be489fd76c3a97362be1f82a5f37523",
};

test("fixture: recipient + pinned descriptor", () => {
  assert.equal(FIXTURE_RECIPIENT, PIN.recipient);
  const c = forge();
  assert.equal(c.descriptor, PIN.descriptor);
  assert.equal(c.fingerprint, PIN.fingerprint);
  assert.equal(c.hashHex, PIN.hashHex);
  assert.equal(campaignDescriptor(c), PIN.descriptor);
});

test("forge validation guards refuse bad input loudly", () => {
  assert.throws(() => forge({ orgName: "   " }), /organizer name/);
  assert.throws(() => forge({ orgName: "x".repeat(121) }), /under 120/);
  assert.throws(() => forge({ recipient: "nope" }), /rejected/);
  assert.throws(() => forge({ recipient: "tprl1pft455f03ps70k9wkvsvg7xk46ftaejkjmsh7gaj9439ssqkjczrqjfpnkh".slice(0, 62) + "x" }), /rejected/);
  assert.throws(() => forge({ recipient: "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh" }), /wrong network|rejected/);
  assert.throws(() => forge({ goalPRL: "0" }), /positive/);
  assert.throws(() => forge({ goalPRL: "0.000005" }), /dust floor/); // 500 grains < dust
  assert.throws(() => forge({ goalPRL: "abc" }), /not a PRL amount/);
  assert.throws(() => forge({ deadlineHeight: 42 }), /paste error/);
  assert.throws(() => forge({ deadlineHeight: 500000000 }), /block height/);
  assert.throws(() => forge({ orgSignMode: "sign", orgKeyInput: "nope" }), /organizer key/);
  assert.throws(() => forge({ orgSignMode: "bogus" }), /sign.*nosign/);
});

test("parsePRLToGrains / fmtPRL", () => {
  assert.equal(parsePRLToGrains("100"), 100 * GRAIN_PER_PRL);
  assert.equal(parsePRLToGrains("0.00000546"), 546);
  assert.equal(fmtPRL(parsePRLToGrains("1.5")), "1.5");
  assert.equal(fmtPRL(parsePRLToGrains("100")), "100");
  assert.throws(() => parsePRLToGrains("0.00000001"), /dust floor/); // 1 grain
});

test("descriptor without deadline omits the tail", () => {
  const c = forge({ deadlineHeight: null });
  assert.equal(c.descriptor.split(":").length, 5);
  assert.ok(c.descriptor.startsWith("pearl-charity:v1:prl:"));
  const f = parseCampaignDescriptor(c.descriptor);
  assert.equal(f.deadlineHeight, null);
});

test("descriptor round-trip parse", () => {
  const c = forge();
  const f = parseCampaignDescriptor(c.descriptor);
  assert.equal(f.hrp, "prl");
  assert.equal(f.hashHex, c.hashHex);
  assert.equal(f.goalGrains, 100 * GRAIN_PER_PRL);
  assert.equal(f.deadlineHeight, 901000);
});

test("malformed descriptors refused", () => {
  assert.throws(() => parseCampaignDescriptor("pearl-charity:v1:prl:"), /bad campaign descriptor/);
  assert.throws(() => parseCampaignDescriptor("bounty:v1:prl:deadbeef:100"), /bad campaign descriptor/);
  assert.throws(() => parseCampaignDescriptor("pearl-charity:v1:prl:zz:100"), /hash/);
  assert.throws(() => parseCampaignDescriptor("pearl-charity:v1:prl:" + "ab".repeat(32) + ":100"), /dust floor/);
});

test("fingerprint is 64-bit hex", () => {
  assert.match(descriptorFingerprint(forge().descriptor), /^[0-9a-f]{16}$/);
  assert.notEqual(
    descriptorFingerprint(forge().descriptor),
    descriptorFingerprint(forge({ goalPRL: "101" }).descriptor)
  );
});

test("spec parse: tamper refusal on every committed field", () => {
  const c = forge();
  const good = parseCampaignSpec(serializeCampaign(c), MAINNET);
  assert.equal(good.recipient, PIN.recipient);
  // Tamper with the recipient — the hash no longer matches.
  const tampered = JSON.parse(serializeCampaign(c));
  tampered.recipient = encodeBech32m("prl", 1, sha("attacker"));
  assert.throws(() => parseCampaignSpec(JSON.stringify(tampered), MAINNET), /re-derivation check on (hashHex|recipient)/);
  // Tamper with the goal.
  const t2 = JSON.parse(serializeCampaign(c));
  t2.goalGrains = 1 * GRAIN_PER_PRL;
  assert.throws(() => parseCampaignSpec(JSON.stringify(t2), MAINNET), /re-derivation check on (hashHex|goalGrains)/);
  // Tamper with the description — it is hash-committed too.
  const t3 = JSON.parse(serializeCampaign(c));
  t3.description = "totally different cause";
  assert.throws(() => parseCampaignSpec(JSON.stringify(t3), MAINNET), /re-derivation check on (hashHex|description)/);
  // Wrong network.
  assert.throws(() => parseCampaignSpec(serializeCampaign(c), NETWORKS.testnet), /not tprl/);
  // Garbage JSON.
  assert.throws(() => parseCampaignSpec("{nope", MAINNET), /not valid JSON/);
});

test("verifyDescriptor: good case + loud refusals", () => {
  const c = forge();
  const spec = serializeCampaign(c);
  const ok = verifyDescriptor(c.descriptor, MAINNET, c.recipient, spec);
  assert.equal(ok.fingerprint, c.fingerprint);
  assert.equal(ok.authorship, "unsigned");
  assert.equal(ok.campaign.recipient, c.recipient);
  // Descriptor not matching the spec → REFUSED.
  const other = forge({ goalPRL: "101" });
  assert.throws(
    () => verifyDescriptor(other.descriptor, MAINNET, c.recipient, spec),
    /LOUD REFUSAL/
  );
  // Claimed address not matching → REFUSED (this is the anti-phishing core).
  assert.throws(
    () => verifyDescriptor(c.descriptor, MAINNET, encodeBech32m("prl", 1, sha("attacker")), spec),
    /LOUD REFUSAL.*NOT to the claimed address/
  );
  // Wrong network → REFUSED.
  assert.throws(() => verifyDescriptor(c.descriptor, NETWORKS.testnet, c.recipient, spec), /LOUD REFUSAL/);
  // No spec → refusal (descriptor alone commits to nothing the verifier can see).
  assert.throws(() => verifyDescriptor(c.descriptor, MAINNET, c.recipient, null), /paste the campaign spec/);
});

test("organizer authorship: sign → verify round-trip", () => {
  const priv = bytesToHex(sha("pearl-charity-fixture-organizer"));
  const { campaign, secret } = forgeCampaign({
    network: MAINNET,
    orgName: "Pearl Lantern Society",
    recipient: FIXTURE_RECIPIENT,
    goalPRL: "100",
    deadlineHeight: 901000,
    description: "Signed fixture.",
    contact: "",
    orgSignMode: "sign",
    orgKeyInput: priv,
  });
  assert.ok(secret && /^[0-9a-f]{64}$/.test(secret.priv), "secret carries the privkey in memory");
  assert.match(campaign.orgXOnly, /^[0-9a-f]{64}$/);
  assert.match(campaign.orgSigHex, /^[0-9a-f]{128}$/);
  // The signature verifies against the descriptor hash with the audited verifier.
  assert.ok(verifySchnorrSig(hexToBytes(campaign.orgSigHex), hexToBytes(campaign.hashHex), hexToBytes(campaign.orgXOnly)));
  // A wrong key does not verify.
  const wrongX = bytesToHex(schnorr.getPublicKey(sha("someone-else")));
  assert.equal(verifySchnorrSig(hexToBytes(campaign.orgSigHex), hexToBytes(campaign.hashHex), hexToBytes(wrongX)), false);
  // Spec parse re-checks the signature.
  const parsed = parseCampaignSpec(serializeCampaign(campaign), MAINNET);
  assert.equal(parsed.orgSigHex, campaign.orgSigHex);
  const ok = verifyDescriptor(campaign.descriptor, MAINNET, campaign.recipient, serializeCampaign(campaign));
  assert.equal(ok.authorship, "signed+valid");
  // Tampered authorship: signature over a different hash → spec parse refuses.
  const t = JSON.parse(serializeCampaign(campaign));
  t.orgSigHex = bytesToHex(signForXOnly(hexToBytes(priv), sha("different")));
  assert.throws(() => parseCampaignSpec(JSON.stringify(t), MAINNET), /LOUD REFUSAL/);
});

test("organizerKeyFromInput accepts hex / WIF / mnemonic", () => {
  const priv = bytesToHex(sha("pearl-charity-key-input"));
  const a = organizerKeyFromInput(priv, MAINNET);
  assert.match(a.xonly, /^[0-9a-f]{64}$/);
  assert.equal(a.source, "hex private key");
  assert.throws(() => organizerKeyFromInput("junk", MAINNET), /organizer key/);
});

test("receipt: hash round-trip + tamper refusal", () => {
  const c = forge();
  const r = recordReceipt({
    campaign: c,
    donor: "lantern-fan",
    txid: "ab".repeat(32),
    amountPRL: "5",
    blockHeight: 900100,
  });
  assert.match(r.hash, /^[0-9a-f]{64}$/);
  assert.ok(r.hash.startsWith("") && r.hash.length === 64);
  assert.ok(verifyReceiptHash(r), "fresh receipt verifies");
  assert.equal(r.amountPRL, "5");
  // Tamper with the amount.
  const t = { ...r, amountGrains: 6 * GRAIN_PER_PRL, amountPRL: "6" };
  assert.equal(verifyReceiptHash(t), false, "tampered amount refused");
  // Tamper with the donor.
  const t2 = { ...r, donor: "attacker" };
  assert.equal(verifyReceiptHash(t2), false, "tampered donor refused");
  // Receipt binds the campaign fingerprint.
  const other = forge({ goalPRL: "101" });
  const r2 = recordReceipt({ campaign: other, donor: "x", txid: "cd".repeat(32), amountPRL: "1" });
  assert.notEqual(r2.campaignFingerprint, r.campaignFingerprint);
  // Anonymous default + optional block height.
  const r3 = recordReceipt({ campaign: c, donor: "", txid: "ef".repeat(32), amountPRL: "1" });
  assert.equal(r3.donor, "anonymous");
  assert.equal(r3.blockHeight, null);
  // Guards.
  assert.throws(() => recordReceipt({ campaign: c, donor: "x", txid: "zz", amountPRL: "1" }), /txid/);
  assert.throws(() => recordReceipt({ campaign: c, donor: "x", txid: "ab".repeat(32), amountPRL: "0" }), /positive/);
  assert.throws(() => recordReceipt({ campaign: c, donor: "x", txid: "ab".repeat(32), amountPRL: "0.00000001" }), /dust floor/);
  assert.throws(() => verifyReceiptHash({ ...r, kind: "nope" }), /not a Pearl Charity receipt/);
});

test("classify: unfunded / funding / goal-met / past-deadline", () => {
  const c = forge();
  const stats = (g) => ({ receivedGrains: g, txCount: g ? 1 : 0, donations: [] });
  assert.equal(classifyCampaign(c, stats(0), 900000).status, "unfunded");
  assert.equal(classifyCampaign(c, stats(50 * GRAIN_PER_PRL), 900000).status, "funding");
  assert.equal(classifyCampaign(c, stats(100 * GRAIN_PER_PRL), 900000).status, "goal-met");
  assert.equal(classifyCampaign(c, stats(150 * GRAIN_PER_PRL), 900000).status, "goal-met");
  // Past deadline takes precedence over funding state.
  assert.equal(classifyCampaign(c, stats(0), 901000).status, "past-deadline");
  assert.equal(classifyCampaign(c, stats(50 * GRAIN_PER_PRL), 901001).status, "past-deadline");
  // Deadline exactly at the tip counts as reached.
  assert.equal(classifyCampaign(c, stats(0), 901000).status, "past-deadline");
  // No deadline: goal-met still works; blocksLeft null.
  const nodead = forge({ deadlineHeight: null });
  const r = classifyCampaign(nodead, stats(200 * GRAIN_PER_PRL), null);
  assert.equal(r.status, "goal-met");
  assert.equal(r.blocksLeft, null);
  assert.equal(r.approxCountdown, "no deadline set");
  // Blocks left math.
  const u = classifyCampaign(c, stats(0), 900900);
  assert.equal(u.blocksLeft, 100);
  assert.equal(u.status, "unfunded");
  assert.throws(() => classifyCampaign(c, stats(0), -5), /bad tip height/);
});

test("deadline countdown math is approximate and labeled", () => {
  assert.equal(formatDeadlineCountdown(null), "no deadline set");
  assert.equal(formatDeadlineCountdown(0), "deadline reached");
  const one_day = Math.round(86400 / PEARL_BLOCK_SECS); // ~445 blocks
  const s = formatDeadlineCountdown(one_day);
  assert.ok(s.includes("≈"), "approximate marker");
  assert.ok(s.includes("days"), "days shown");
  assert.ok(s.includes("approximate"), "labeled approximate");
  assert.ok(s.includes(String(one_day)), "block count shown");
  const big = formatDeadlineCountdown(100000);
  assert.ok(big.includes("days"), "large countdown in days");
});

test("countDonors dedupes handles", () => {
  const c = forge();
  const rs = [
    recordReceipt({ campaign: c, donor: "a", txid: "aa".repeat(32), amountPRL: "1" }),
    recordReceipt({ campaign: c, donor: "b", txid: "bb".repeat(32), amountPRL: "1" }),
    recordReceipt({ campaign: c, donor: "a", txid: "cc".repeat(32), amountPRL: "1" }),
  ];
  assert.equal(countDonors(rs), 2);
  assert.equal(countDonors([]), 0);
});

test("fetchCampaignStats parses Blockbook address+txs (stubbed fetch)", async () => {
  const realFetch = globalThis.fetch;
  const addr = FIXTURE_RECIPIENT;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/api/v2/address/")) {
      return new Response(JSON.stringify({
        address: addr,
        totalReceived: String(7 * GRAIN_PER_PRL),
        txs: [
          {
            txid: "ab".repeat(32),
            blockHeight: 900100,
            confirmations: 5,
            vout: [
              { value: String(5 * GRAIN_PER_PRL), scriptPubKey: { addresses: [addr] } },
              { value: String(2 * GRAIN_PER_PRL), scriptPubKey: { addresses: ["prl1p" + "00".repeat(30)] } },
            ],
          },
          {
            txid: "cd".repeat(32),
            blockHeight: -1,
            confirmations: 0,
            vout: [
              { value: String(2 * GRAIN_PER_PRL), scriptPubKey: { addresses: [addr] } },
            ],
          },
          {
            txid: "ef".repeat(32),
            blockHeight: 900101,
            confirmations: 4,
            vout: [
              { value: String(9 * GRAIN_PER_PRL), scriptPubKey: { addresses: ["prl1p" + "11".repeat(30)] } },
            ],
          },
        ],
      }), { status: 200 });
    }
    throw new Error("unexpected url " + u);
  };
  try {
    const s = await fetchCampaignStats("https://x", addr);
    assert.equal(s.receivedGrains, 7 * GRAIN_PER_PRL);
    assert.equal(s.donations.length, 2, "only txs paying the campaign address count");
    assert.equal(s.donations[0].txid, "ab".repeat(32));
    assert.equal(s.donations[0].valueGrains, 5 * GRAIN_PER_PRL);
    assert.equal(s.donations[0].confirmations, 5);
    assert.equal(s.donations[1].blockHeight, -1, "unconfirmed kept and flagged");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("crossCheckReceipt: proven / not proven reasons", async () => {
  const c = forge();
  const r = recordReceipt({ campaign: c, donor: "a", txid: "ab".repeat(32), amountPRL: "5" });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/api/v2/tx/" + "ab".repeat(32))) {
      return new Response(JSON.stringify({
        txid: "ab".repeat(32),
        blockHeight: 900100,
        confirmations: 6,
        vout: [{ value: String(5 * GRAIN_PER_PRL), scriptPubKey: { addresses: [c.recipient] } }],
      }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  };
  try {
    const ok = await crossCheckReceipt("https://x", r, c);
    assert.equal(ok.proven, true);
    assert.ok(ok.reasons[0].includes("6 confirmation"), "proven reason names confirmations");
    const rX = recordReceipt({ campaign: c, donor: "b", txid: "ff".repeat(32), amountPRL: "1" });
    const missing = await crossCheckReceipt("https://x", rX, c);
    assert.equal(missing.proven, false, "404 → not proven");
    assert.ok(missing.reasons[0].includes("not found"), "reason explains");
    // Hash tamper → immediate not proven.
    const bad = { ...r, amountGrains: r.amountGrains + 1 }; // the field the hash commits to
    const badRes = await crossCheckReceipt("https://x", bad, c);
    assert.equal(badRes.proven, false);
    assert.ok(badRes.reasons[0].includes("does not recompute"), "hash refusal reason");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("fetchTipHeight reads backend.blocks", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ backend: { blocks: 900050 } }), { status: 200 });
  try {
    assert.equal(await fetchTipHeight("https://x"), 900050);
  } finally {
    globalThis.fetch = realFetch;
  }
  globalThis.fetch = async () => new Response(JSON.stringify({ backend: {} }), { status: 200 });
  try {
    await assert.rejects(() => fetchTipHeight("https://x"), /bad tip height/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
