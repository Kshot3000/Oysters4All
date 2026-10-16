// Pearl Will DOM tests: boot the COMMITTED bundle in a strict VM shim and
// drive the core through window.PearlWill (proving the shipped bundle == the
// tested core), plus static wiring checks on index.html (every id that
// app.js touches must exist, every script tag cache-busted).
// Usage: node tests/dom.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve as P } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { TextEncoder, TextDecoder } from "node:util";
import { webcrypto } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = P(here, "..");

function bootBundle() {
  const src = readFileSync(P(appDir, "pearl-will.bundle.js"), "utf8");
  const sandbox = {
    console,
    TextEncoder, TextDecoder,
    Uint8Array, Uint16Array, Uint32Array, BigInt,
    crypto: webcrypto,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: "pearl-will.bundle.js" });
  const W = sandbox.window.PearlWill;
  assert.ok(W && W.version === 1, "bundle must set window.PearlWill = {version: 1, ...}");
  return W;
}

const W = bootBundle();
const DONATION = "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d";

test("bundle exposes the full core surface", () => {
  for (const fn of ["buildWillVault", "buildOwnerScript", "buildHeirScript",
    "numsInternalKeyWill", "verifyWillDescriptor", "willFromDescriptor",
    "assertClaimable", "buildOwnerClaim", "buildHeirClaim", "reverifyClaimTx",
    "fetchChainTip", "fetchVaultStatus", "scriptAsm", "spendVBytes", "planSpend",
    "decodeRawTx", "newMnemonic", "walletFromMnemonic", "NETWORKS", "BLOCK_SECONDS"]) {
    assert.ok(W[fn] !== undefined, "bundle exposes " + fn);
  }
});

test("bundle: draft → vault → PROVEN descriptor (end to end in the shipped bundle)", () => {
  const v = W.buildWillVault({
    network: "mainnet",
    owner: "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5",
    heirs: [
      "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9",
      "8200cf0ce11447bf6353cbac964d07d1c390d61d07e6c5d0214450b3add6449b",
    ],
    m: 2, unlockHeight: 240000, label: "dom-qa",
  });
  assert.ok(v.address.startsWith("prl1"));
  const r = W.verifyWillDescriptor(v.descriptor, v.address, v.sealed);
  assert.equal(r.verdict, "PROVEN");
  // Pinned: same inputs must always rebuild the same address + seal.
  assert.equal(v.address, "prl1p9l8x0uh87sn698snzjq8lx3kupuad0f9jg8r0ppz6z3e9m604nks3dn7mw");
  assert.equal(v.sealed, "pearl-will:v1:prl:0d98791db739d10a80433d7f01f37e9684fd96c5dc55badc4368e67a1fbbddbb");
});

test("bundle: loud pre-unlock refusal from the shipped code", () => {
  assert.throws(() => W.assertClaimable(240000, 239999, "heir"), /WILL REFUSED.*heir claim locked/);
});

test("index.html wires every id app.js needs", () => {
  const html = readFileSync(P(appDir, "index.html"), "utf8");
  const js = readFileSync(P(appDir, "app.js"), "utf8");
  const ids = new Set();
  for (const m of js.matchAll(/\$\("([^"]+)"\)/g)) ids.add(m[1]);
  for (const m of js.matchAll(/getElementById\("([^"]+)"\)/g)) ids.add(m[1]);
  const missing = [...ids].filter((id) => !html.includes(`id="${id}"`));
  assert.deepEqual(missing, [], "every $('...') id exists in index.html: " + missing.join(","));
});

test("index.html: five steps, five panels, honest limits, attribution", () => {
  const html = readFileSync(P(appDir, "index.html"), "utf8");
  for (const s of ["draft", "fund", "watch", "claim", "verify"]) {
    assert.ok(html.includes(`data-step="${s}"`), "step " + s);
    assert.ok(html.includes(`id="step-${s}"`), "panel " + s);
  }
  assert.ok(html.includes('id="honest-limits"'), "honest limits panel");
  assert.ok(html.includes("@kshot9000"), "@kshot9000 in footer");
  assert.ok(html.includes(DONATION), "donation address in footer");
  // every local script is cache-busted
  for (const m of html.matchAll(/<script src="([^"]+)"><\/script>/g)) {
    const src = m[1];
    if (!src.startsWith("http")) assert.ok(src.includes("?v="), "cache-busted: " + src);
  }
  assert.ok(html.includes('href="styles.css?v=8"'), "styles cache-busted");
});

test("styles.css exists and is non-trivial", () => {
  const css = readFileSync(P(appDir, "styles.css"), "utf8");
  assert.ok(css.length > 3000, "real stylesheet");
  assert.ok(css.includes("--wax"), "midnight-archive theme tokens");
});

test("qrcode lib vendored", () => {
  assert.ok(existsSync(P(appDir, "qrcode.min.js")), "qrcode.min.js vendored");
});

test("offline tally uses the exact core parser (float-parse class closed)", () => {
  const js = readFileSync(P(appDir, "app.js"), "utf8");
  assert.ok(js.includes("W.parsePRLToGrains(parts[1])"), "tally delegates to the core exact parser");
  assert.ok(!js.includes("Math.round(amt * 1e8)"), "no float tally parse left");
  const html = readFileSync(P(appDir, "index.html"), "utf8");
  assert.ok(html.includes("pearl-will.bundle.js?v=9"), "bundle cache key bumped");
  assert.ok(html.includes('src="app.js?v=6"'), "app cache key bumped");
});

test("builder tip: checkbox opt-in, disclosure, bundle tipped owner claim exact on the wire", () => {
  const html = readFileSync(P(appDir, "index.html"), "utf8");
  assert.ok(html.includes('id="co-tip"'), "tip checkbox present");
  assert.ok(html.includes('type="checkbox" id="co-tip"'), "tip control is a checkbox");
  assert.ok(!/<input type="checkbox" id="co-tip" checked/.test(html), "tip checkbox unchecked by default");
  assert.ok(html.includes("Optional builder tip — add 1% of the reclaimed amount"), "disclosure names the 1%");
  assert.ok(html.includes("heir claims never carry a tip"), "heir exclusion disclosed");
  assert.ok(html.includes('id="co-tip-amt"'), "signed panel shows the tip as its own line");
  // Bundle-level: tipped owner claim pays the builder exactly 1% as its own output.
  const priv = new Uint8Array(32).fill(0x11);
  const ownerX = W.bytesToHex(W.schnorr.getPublicKey(priv));
  const heirX = W.bytesToHex(W.schnorr.getPublicKey(new Uint8Array(32).fill(0x22)));
  const v = W.buildWillVault({ network: "mainnet", owner: ownerX, heirs: [heirX], m: 1, unlockHeight: 240000 });
  const dest = W.encodeBech32m("prl", 1, W.tweakKeypath(W.hexToBytes(ownerX)).tweakedX);
  const input = { txid: "ab".repeat(32), vout: 0, value: 200_000_000_00 };
  const tip = W.builderTipGrainsFor(input.value, W.NETWORKS.mainnet, true);
  assert.equal(tip, 200_000_000);
  const built = W.buildOwnerClaim(v, {
    input, payments: [{ address: dest, value: input.value - 100000 - tip }],
    changeAddress: dest, feeRateGrainsPerVByte: 10,
    privOwner: priv, signerXOnly: ownerX, builderTipEnabled: true,
  });
  const dec = W.decodeRawTx(built.hex);
  const builderSpk = "5120" + W.bytesToHex(W.addressToProgram(W.BUILDER_TIP_ADDRESS, W.NETWORKS.mainnet));
  const tipOuts = dec.outputs.filter((o) => W.bytesToHex(o.spk) === builderSpk);
  assert.equal(tipOuts.length, 1);
  assert.equal(Number(tipOuts[0].value), 200_000_000);
});

test("claim-tab fee estimates use the exact ceiling (float-ceil class, app.js sites)", () => {
  const js = readFileSync(P(appDir, "app.js"), "utf8");
  // The Claim tab sized its payments as input − feeEst, and planSpend folds
  // the remainder into the fee — so a float-inflated feeEst IS the fee paid.
  // The no-tip owner reclaim estimates over 180 vB, where 180 × 2.2 float-ceils
  // to 397 instead of the exact 396 (also 1.1 → 199/198, 4.4 → 793/792).
  assert.ok(!js.includes("Math.ceil(W.spendVBytes"), "no float fee estimate left in app.js");
  assert.ok(js.includes("W.ceilFeeGrains(W.spendVBytes({ nOut: tip > 0 ? 3 : 2"), "owner reclaim estimate is exact");
  assert.ok(js.includes("W.ceilFeeGrains(W.spendVBytes({ nOut: 2"), "heir digest estimate is exact");
  // Bundle-level flow, replicating the app.js owner-reclaim computation at
  // 2.2 g/vB: payment = input − exact fee, and the signed claim pays 396.
  const priv = new Uint8Array(32).fill(0x11);
  const ownerX = W.bytesToHex(W.schnorr.getPublicKey(priv));
  const heirX = W.bytesToHex(W.schnorr.getPublicKey(new Uint8Array(32).fill(0x22)));
  const v = W.buildWillVault({ network: "mainnet", owner: ownerX, heirs: [heirX], m: 1, unlockHeight: 240000 });
  const dest = W.encodeBech32m("prl", 1, W.tweakKeypath(W.hexToBytes(ownerX)).tweakedX);
  const input = { txid: "ab".repeat(32), vout: 0, value: 100_000_000 };
  const feeEst = W.ceilFeeGrains(W.spendVBytes({ nOut: 2, scriptLen: v.ownerScript.length, controlLen: v.controlBlocks[0].length, stackLens: [64] }), 2.2);
  assert.equal(feeEst, 396, "180 vB at 2.2 g/vB prices exactly 396 grains");
  const built = W.buildOwnerClaim(v, {
    input, payments: [{ address: dest, value: input.value - feeEst }],
    changeAddress: dest, feeRateGrainsPerVByte: 2.2,
    privOwner: priv, signerXOnly: ownerX, builderTipEnabled: false,
  });
  assert.equal(built.fee, 396, "signed owner reclaim pays the exact fee");
});

test("app.js grain formatter is BigInt-exact (pool float-format class)", async () => {
  const { readFileSync } = await import("node:fs");
  const { dirname, resolve } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "app.js"), "utf8");
  assert.ok(src.includes("100000000n"), "BigInt-exact grain formatter present");
  assert.ok(src.includes("/^-?\\d+$/"), "integer-grain gate present");
});
