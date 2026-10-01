// Pearl Paywall core tests — run:
// node --no-warnings --loader ./tests/loader.mjs --test ./tests/paywall-core.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import * as P from "../src/paywall-core.js";
import { walletToWIF } from "../../sign/src/crypto.js";

const MN = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const WRONG_MN = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const PAYWALL_ADDR = "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d";
const TXID = "ab".repeat(32);
const FUNDER = P.walletFromMnemonic(MN, P.NETWORKS.mainnet);

// Pinned vectors (audited core, fixed auxRand 0x07*32)
const PIN_CANONICAL = '{"v":1,"title":"Backstage pass: studio session stems","priceGrains":"250000000","address":"prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d","deliverable":"WAV stems + project file, delivered by email within 48h of payment.","expiry":"2027-12-31","hrp":"prl"}';
const PIN_HASH = "d20d4c7652d8091d047c7f25ad4f04d457e60aa3f0c0b21b98490b44fd12b02f";
const PIN_DESC = "pearl-paywall:v1:prl:" + PIN_HASH;
const PIN_PUBKEY = "1e89c01f8a1968e908480b487c0673c07fef9c48268d403e3af0678a460a4f76";
const PIN_SIG = "ab4283fe3f1912c3c3829b713dbf1e6e882492ae90e1396aaaac7d56b67e53d98c748480a1203552e199ecd0c2c473eaa9cf001490316441845cce99387afeb5";
const PIN_FUNDER_ADDR = "prl1pr6yuq8u2r95wjzzgpdy8cpnncpl7l8zgy6x5q0367pnc53s2famqg7pt74";

function goodSpec(over = {}) {
  return P.validatePaywallSpec({
    title: "Backstage pass: studio session stems",
    pricePRL: "2.5",
    address: PAYWALL_ADDR,
    deliverable: "WAV stems + project file, delivered by email within 48h of payment.",
    expiry: "2027-12-31",
    hrp: "prl",
    ...over,
  });
}

function stubTxFunder(confirmations = 3, valueGrains = "250000000") {
  return {
    txid: TXID, confirmations,
    vin: [{ txid: "00".repeat(32), vout: 0, addresses: [FUNDER.address] }],
    vout: [{ n: 0, value: valueGrains, scriptPubKey: { hex: "5120" + "00".repeat(32), addresses: [PAYWALL_ADDR] } }],
  };
}
const stubFetchTx = (tx) => async (url) => {
  const u = String(url);
  if (u.includes("/api/v2/tx/")) return { ok: true, status: 200, text: async () => JSON.stringify(tx) };
  throw new Error("unexpected url " + u);
};
const AUX = new Uint8Array(32).fill(7);

async function mintPinned() {
  const sealed = P.sealPaywall(goodSpec());
  const { token } = await P.mintToken({
    descriptor: sealed.descriptor, txid: TXID, keyInput: MN,
    blockbookBase: "https://blockbook.pearlresearch.ai",
    fetcher: stubFetchTx(stubTxFunder()), auxRand: AUX,
  });
  return { sealed, token };
}

/* ---------------- spec validation ---------------- */

test("validatePaywallSpec: good spec, grain-exact price", () => {
  const s = goodSpec();
  assert.equal(s.priceGrains, 250000000n);
  assert.equal(s.expiry, "2027-12-31");
  assert.equal(FUNDER.address, PIN_FUNDER_ADDR);
});

test("validatePaywallSpec: rejects bad inputs loudly", () => {
  assert.throws(() => goodSpec({ pricePRL: "0" }), /positive/);
  assert.throws(() => goodSpec({ pricePRL: "-1" }), /invalid PRL amount/);
  assert.throws(() => goodSpec({ pricePRL: "abc" }), /invalid PRL amount/);
  assert.throws(() => goodSpec({ pricePRL: "0.000000001" }), /invalid PRL amount/); // 9 decimals
  assert.throws(() => goodSpec({ title: "" }), /title/);
  assert.throws(() => goodSpec({ deliverable: "" }), /deliverable/);
  assert.throws(() => goodSpec({ address: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4" }), /invalid for prl/);
  assert.throws(() => goodSpec({ address: "prl1invalid" }), /invalid for prl/);
  assert.throws(() => goodSpec({ expiry: "2020-01-01" }), /future/);
  assert.throws(() => goodSpec({ expiry: "2026-02-30" }), /not a real date/);
  assert.throws(() => goodSpec({ expiry: "tomorrow" }), /YYYY-MM-DD/);
  assert.throws(() => goodSpec({ hrp: "xyz" }), /unsupported hrp/);
  const noExp = goodSpec({ expiry: "" });
  assert.equal(noExp.expiry, null);
});

test("descriptor: pinned canonical/hash/descriptor, parse round-trip", () => {
  const sealed = P.sealPaywall(goodSpec());
  assert.equal(sealed.canonical, PIN_CANONICAL);
  assert.equal(sealed.hash, PIN_HASH);
  assert.equal(sealed.descriptor, PIN_DESC);
  assert.deepEqual(P.parseDescriptor(PIN_DESC), { hrp: "prl", hash: PIN_HASH });
  assert.throws(() => P.parseDescriptor("pearl-paywall:v1:prl:zzz"), /must look like/);
  assert.throws(() => P.parseDescriptor("pearl-paywall:v2:prl:" + PIN_HASH), /must look like/);
});

test("paymentURI: BIP-21 style with exact amount", () => {
  assert.equal(P.paymentURI(PAYWALL_ADDR, 250000000n), `pearl:${PAYWALL_ADDR}?amount=2.5`);
  assert.equal(P.paymentURI(PAYWALL_ADDR, 1n), `pearl:${PAYWALL_ADDR}?amount=0.00000001`);
});

/* ---------------- payment analysis ---------------- */

test("analyzePayment: paid / shortfall / unconfirmed", () => {
  const paid = P.analyzePayment(stubTxFunder(3), PAYWALL_ADDR, 250000000n);
  assert.equal(paid.paid, true);
  assert.equal(paid.paidGrains, 250000000n);
  assert.equal(paid.unconfirmed, false);
  const short = P.analyzePayment(stubTxFunder(1, "100000000"), PAYWALL_ADDR, 250000000n);
  assert.equal(short.paid, false);
  assert.equal(short.shortfallGrains, 150000000n);
  const zero = P.analyzePayment(stubTxFunder(0), PAYWALL_ADDR, 250000000n);
  assert.equal(zero.paid, true);
  assert.equal(zero.unconfirmed, true);
  const over = P.analyzePayment(stubTxFunder(6, "300000000"), PAYWALL_ADDR, 250000000n);
  assert.equal(over.paid, true);
  assert.equal(over.overpaidGrains, 50000000n);
});

test("analyzePayment: tolerates both vout address shapes", () => {
  const flat = { txid: TXID, confirmations: 2, vout: [{ value: "250000000", addresses: [PAYWALL_ADDR] }] };
  assert.equal(P.analyzePayment(flat, PAYWALL_ADDR, 250000000n).paid, true);
});

/* ---------------- token mint ---------------- */

test("mintToken: pinned deterministic signature, audited verify", async () => {
  const { sealed, token } = await mintPinned();
  assert.equal(token.descriptor, PIN_DESC);
  assert.equal(token.pubkey, PIN_PUBKEY);
  assert.equal(token.txid, TXID);
  assert.equal(token.sig, PIN_SIG);
  const digest = P.tokenDigest(token.descriptor, token.pubkey, token.txid);
  assert.equal(P.schnorr.verify(P.hexToBytes(token.sig), digest, P.hexToBytes(token.pubkey)), true);
});

test("mintToken: accepts hex and WIF funding keys", async () => {
  const sealed = P.sealPaywall(goodSpec());
  const hexKey = P.bytesToHex(FUNDER.priv);
  const wif = walletToWIF(FUNDER.priv, P.NETWORKS.mainnet);
  for (const keyInput of [hexKey, wif]) {
    const { token, source } = await P.mintToken({
      descriptor: sealed.descriptor, txid: TXID, keyInput,
      blockbookBase: "https://blockbook.pearlresearch.ai",
      fetcher: stubFetchTx(stubTxFunder()), auxRand: AUX,
    });
    assert.equal(token.pubkey, PIN_PUBKEY);
    assert.ok(source.length > 0);
  }
});

test("mintToken: KEY REFUSED on wrong key / non-P2TR inputs", async () => {
  const sealed = P.sealPaywall(goodSpec());
  await assert.rejects(
    P.mintToken({
      descriptor: sealed.descriptor, txid: TXID, keyInput: WRONG_MN,
      blockbookBase: "https://blockbook.pearlresearch.ai", fetcher: stubFetchTx(stubTxFunder()),
    }),
    /KEY REFUSED/
  );
  const noP2tr = { txid: TXID, confirmations: 3, vin: [{ addresses: ["1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"] }], vout: [] };
  await assert.rejects(
    P.mintToken({
      descriptor: sealed.descriptor, txid: TXID, keyInput: MN,
      blockbookBase: "https://blockbook.pearlresearch.ai", fetcher: stubFetchTx(noP2tr),
    }),
    /KEY REFUSED/
  );
  await assert.rejects(
    P.mintToken({ descriptor: "bogus", txid: TXID, keyInput: MN, blockbookBase: "https://x", fetcher: stubFetchTx(stubTxFunder()) }),
    /descriptor must look like/
  );
});

/* ---------------- standalone verifier ---------------- */

test("verifyToken: PROVEN end-to-end", async () => {
  const { sealed, token } = await mintPinned();
  const v = await P.verifyToken({
    descriptor: sealed.descriptor, canonical: sealed.canonical,
    token: JSON.stringify(token),
    blockbookBase: "https://blockbook.pearlresearch.ai", fetcher: stubFetchTx(stubTxFunder()),
  });
  assert.equal(v.proven, true);
  assert.ok(v.reasons.join(" ").includes("BIP-340 signature verifies"));
});

test("verifyToken: NOT PROVEN on tampering / mismatch / expiry / outage", async () => {
  const { sealed, token } = await mintPinned();
  const base = {
    descriptor: sealed.descriptor, canonical: sealed.canonical,
    blockbookBase: "https://blockbook.pearlresearch.ai", fetcher: stubFetchTx(stubTxFunder()),
  };
  const evil = { ...token, sig: token.sig.slice(0, 126) + (token.sig.endsWith("b5") ? "b6" : "b5") };
  let v = await P.verifyToken({ ...base, token: JSON.stringify(evil) });
  assert.equal(v.proven, false);
  assert.ok(v.reasons.join(" ").includes("does NOT verify"));

  v = await P.verifyToken({ ...base, token: JSON.stringify({ ...token, descriptor: PIN_DESC.replace("prl:", "tprl:") }) });
  assert.equal(v.proven, false);

  const tamperedCanon = sealed.canonical.replace("Backstage pass", "Frontstage pass");
  v = await P.verifyToken({ ...base, canonical: tamperedCanon, token: JSON.stringify(token) });
  assert.equal(v.proven, false);
  assert.ok(v.reasons.join(" ").includes("does NOT match"));

  v = await P.verifyToken({ ...base, fetcher: stubFetchTx(stubTxFunder(2, "100000000")), token: JSON.stringify(token) });
  assert.equal(v.proven, false);
  assert.ok(v.reasons.join(" ").includes("insufficient"));

  const expired = P.sealPaywall(goodSpec());
  v = await P.verifyToken({ ...base, canonical: expired.canonical, descriptor: expired.descriptor, token: JSON.stringify(token), nowMs: new Date("2028-01-02T00:00:00Z").getTime() });
  assert.equal(v.proven, false);
  assert.ok(v.reasons.join(" ").includes("expired"));

  const down = async () => { throw new Error("boom"); };
  v = await P.verifyToken({ ...base, token: JSON.stringify(token), fetcher: down });
  assert.equal(v.proven, false);
  assert.ok(v.reasons.join(" ").includes("blockbook unreachable"));

  v = await P.verifyToken({ ...base, token: "not json" });
  assert.equal(v.proven, false);
});

/* ---------------- snippet-crypto differentials ---------------- */

function randBytes(n) {
  const b = new Array(n);
  for (let i = 0; i < n; i++) b[i] = Math.floor(Math.random() * 256);
  return b;
}
const h2a = (hex) => Array.from(P.hexToBytes(hex));
const a2h = (arr) => P.bytesToHex(Uint8Array.from(arr));

test("snipSha256Bytes matches audited sha256 on random inputs", () => {
  for (let i = 0; i < 60; i++) {
    const msg = randBytes(Math.floor(Math.random() * 200));
    const want = a2h(P.sha256(Uint8Array.from(msg)));
    assert.equal(a2h(P.snipSha256Bytes(msg)), want, `vector ${i}`);
  }
  // pinned: sha256("abc")
  assert.equal(a2h(P.snipSha256Bytes([97, 98, 99])), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  // empty
  assert.equal(a2h(P.snipSha256Bytes([])), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("snipBech32mDecode matches audited decodeBech32m", () => {
  for (let i = 0; i < 40; i++) {
    const prog = P.hexToBytes(Array.from({ length: 32 }, (_, k) => ((i * 37 + k * 11) & 255).toString(16).padStart(2, "0")).join(""));
    const hrp = i % 2 ? "tprl" : "prl";
    const addr = P.encodeBech32m(hrp, 1, prog);
    const a = P.decodeBech32m(addr, hrp);
    const b = P.snipBech32mDecode(addr);
    assert.equal(b.hrp, a.hrp);
    assert.equal(b.version, a.version);
    assert.equal(a2h(b.program), P.bytesToHex(a.program));
    assert.equal(P.snipBech32mDecode(addr.toUpperCase()).hrp, hrp);
  }
  assert.throws(() => P.snipBech32mDecode(PIN_FUNDER_ADDR.slice(0, -1) + "x"), /bad checksum/);
  assert.throws(() => P.snipBech32mDecode("prl1short"), /bad/);
});

test("snipSchnorrVerify matches audited schnorr.verify (valid + invalid)", () => {
  const H = (arr) => Array.from(P.sha256(Uint8Array.from(arr)));
  let checked = 0;
  for (let i = 0; i < 24; i++) {
    const priv = P.sha256(P.utf8ToBytes("paywall-test-key-" + i));
    const msg = Array.from(P.sha256(P.utf8ToBytes("paywall-test-msg-" + i)));
    const pub = Array.from(P.schnorr.getPublicKey(priv));
    const sig = Array.from(P.schnorr.sign(Uint8Array.from(msg), priv));
    assert.equal(P.snipSchnorrVerify(sig, msg, pub, P.snipSha256Bytes), true, `valid ${i}`);
    checked++;
    // flip a bit in the signature -> must fail in both
    const bad = sig.slice(); bad[10] ^= 1;
    assert.equal(P.snipSchnorrVerify(bad, msg, pub, P.snipSha256Bytes), P.schnorr.verify(Uint8Array.from(bad), Uint8Array.from(msg), Uint8Array.from(pub)));
    // wrong message -> must fail in both
    const badMsg = msg.slice(); badMsg[0] ^= 1;
    assert.equal(P.snipSchnorrVerify(sig, badMsg, pub, P.snipSha256Bytes), false);
    // wrong pubkey -> must fail in both
    const badPub = pub.slice(); badPub[5] ^= 1;
    assert.equal(
      P.snipSchnorrVerify(sig, msg, badPub, P.snipSha256Bytes),
      P.schnorr.verify(Uint8Array.from(sig), Uint8Array.from(msg), Uint8Array.from(badPub))
    );
  }
  assert.ok(checked >= 24);
  // pinned BIP-340-adjacent: the paywall token signature itself
  const digest = Array.from(P.tokenDigest(PIN_DESC, PIN_PUBKEY, TXID));
  assert.equal(P.snipSchnorrVerify(h2a(PIN_SIG), digest, h2a(PIN_PUBKEY), P.snipSha256Bytes), true);
  assert.equal(P.snipSchnorrVerify(h2a(PIN_SIG), digest, h2a(PIN_PUBKEY), P.snipSha256Bytes), P.schnorr.verify(P.hexToBytes(PIN_SIG), Uint8Array.from(digest), P.hexToBytes(PIN_PUBKEY)));
});

/* ---------------- embed snippet ---------------- */

function extractSnippetFns(snippet) {
  const fns = {};
  for (const name of ["snipSha256Bytes", "snipBech32mDecode", "snipSchnorrVerify"]) {
    const m = new RegExp(`var ${name} = (function ${name}[\\s\\S]*?\\n});`).exec(snippet);
    assert.ok(m, `inlined ${name} found`);
    fns[name] = m[1];
  }
  return fns;
}

test("buildEmbedSnippet: inlines the exact snippet-crypto sources", () => {
  const snip = P.buildEmbedSnippet({
    descriptor: PIN_DESC, address: PAYWALL_ADDR, priceGrains: "250000000",
    expiry: "2027-12-31", blockbook: "https://blockbook.pearlresearch.ai",
  });
  assert.ok(snip.startsWith("<script>") && snip.trimEnd().endsWith("</script>"));
  assert.ok(snip.includes(`"descriptor":"${PIN_DESC}"`));
  assert.ok(snip.includes("@kshot9000"));
  const fns = extractSnippetFns(snip);
  // the inlined source must be byte-identical to the module functions
  assert.equal(fns.snipSha256Bytes, P.snipSha256Bytes.toString());
  assert.equal(fns.snipBech32mDecode, P.snipBech32mDecode.toString());
  assert.equal(fns.snipSchnorrVerify, P.snipSchnorrVerify.toString());
});

test("buildEmbedSnippet: inlined functions evaluate + pass differentials", () => {
  const snip = P.buildEmbedSnippet({ descriptor: PIN_DESC, address: PAYWALL_ADDR, priceGrains: "250000000" });
  const fns = extractSnippetFns(snip);
  const box = {};
  vm.createContext(box);
  for (const [name, src] of Object.entries(fns)) {
    box[name] = vm.runInContext(`(${src})`, box);
  }
  // sha256 differential on the INLINED copy
  for (let i = 0; i < 10; i++) {
    const msg = randBytes(1 + Math.floor(Math.random() * 120));
    assert.equal(a2h(box.snipSha256Bytes(msg)), a2h(P.sha256(Uint8Array.from(msg))));
  }
  // schnorr differential on the INLINED copy
  const digest = Array.from(P.tokenDigest(PIN_DESC, PIN_PUBKEY, TXID));
  assert.equal(box.snipSchnorrVerify(h2a(PIN_SIG), digest, h2a(PIN_PUBKEY), box.snipSha256Bytes), true);
  const bad = h2a(PIN_SIG); bad[63] ^= 1;
  assert.equal(box.snipSchnorrVerify(bad, digest, h2a(PIN_PUBKEY), box.snipSha256Bytes), false);
  // bech32m differential on the INLINED copy
  const d = box.snipBech32mDecode(PIN_FUNDER_ADDR);
  assert.equal(d.version, 1);
  assert.equal(d.hrp, "prl");
});

test("embed snippet: verifyToken end-to-end in a page-like sandbox", async () => {
  const snip = P.buildEmbedSnippet({
    descriptor: PIN_DESC, address: PAYWALL_ADDR, priceGrains: "250000000",
    expiry: "2027-12-31", blockbook: "https://blockbook.pearlresearch.ai",
  });
  const js = snip.replace(/^<script>\n?/, "").replace(/\n?<\/script>\s*$/, "");
  const tx = stubTxFunder();
  const box = {
    fetch: async (url) => {
      assert.ok(String(url).includes("/api/v2/tx/" + TXID));
      return { ok: true, status: 200, json: async () => tx };
    },
    document: { getElementById: () => null },
  };
  box.window = box;
  vm.createContext(box);
  vm.runInContext(js, box, { filename: "snippet.js" });
  const gate = box.window.PearlPaywallGate;
  assert.ok(gate, "snippet exposes PearlPaywallGate");
  const token = JSON.stringify({ v: 1, descriptor: PIN_DESC, pubkey: PIN_PUBKEY, txid: TXID, sig: PIN_SIG });
  const okRes = await gate.verifyToken(token);
  assert.equal(okRes.ok, true, JSON.stringify(okRes));
  const evil = JSON.stringify({ v: 1, descriptor: PIN_DESC, pubkey: PIN_PUBKEY, txid: TXID, sig: PIN_SIG.slice(0, 126) + "b6" });
  const badRes = await gate.verifyToken(evil);
  assert.equal(badRes.ok, false);
  assert.ok(badRes.reason.includes("signature"));
  const wrongDesc = await gate.verifyToken(JSON.stringify({ v: 1, descriptor: PIN_DESC.replace("prl:", "tprl:"), pubkey: PIN_PUBKEY, txid: TXID, sig: PIN_SIG }));
  assert.equal(wrongDesc.ok, false);
});
