// Pearl Burn DOM tests: boot the COMMITTED bundle in a strict VM shim and
// drive the core through window.PearlBurn (proving the shipped bundle == the
// tested core), plus static wiring checks on index.html (every id that
// app.js touches must exist, every script tag cache-busted).
// Usage: node --no-warnings --loader ./tests/loader.mjs tests/dom.test.mjs
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
  const src = readFileSync(P(appDir, "pearl-burn.bundle.js"), "utf8");
  const sandbox = {
    console,
    TextEncoder, TextDecoder,
    Uint8Array, Uint16Array, Uint32Array, BigInt,
    crypto: webcrypto,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: "pearl-burn.bundle.js" });
  const W = sandbox.window.PearlBurn;
  assert.ok(W && W.version === 1, "bundle must set window.PearlBurn = {version: 1, ...}");
  return W;
}

const W = bootBundle();

test("bundle exposes the full core surface", () => {
  for (const fn of ["burnAddressForTag", "numsBurnKey", "normalizeTag",
    "formatCertificate", "parseCertificate", "verifyBurnSeal",
    "burnVBytes", "planBurnTx", "buildUnsignedBurnTx", "reverifyUnsignedBurnHex",
    "verifyBurnTx", "prlToGrains", "grainsToPRL",
    "decodeRawTx", "NETWORKS", "NUMS_DOMAIN", "SEAL_PREFIX", "DUST_GRAIN"]) {
    assert.ok(W[fn] !== undefined, "bundle exposes " + fn);
  }
});

test("bundle: generate -> certificate -> PROVEN (end to end in the shipped bundle)", () => {
  const b = W.burnAddressForTag("pearl-genesis-burn", "mainnet");
  assert.equal(b.address, "prl1p26le8zxmcvacgj0er326pr6k4j450c0svq3d295lxf3qkk9xsjqq69l057");
  const cert = W.formatCertificate({ tag: "pearl-genesis-burn", networkId: "mainnet", amountGrains: 100000000, txid: "pending" });
  const r = W.verifyBurnSeal(cert);
  assert.equal(r.verdict, "PROVEN");
});

test("bundle: plan -> unsigned hex decodes with the planned outputs", () => {
  const b = W.burnAddressForTag("dom-plan-probe", "mainnet");
  const change = W.burnAddressForTag("dom-change-probe", "mainnet").address;
  const p = W.planBurnTx({
    networkId: "mainnet",
    utxo: { txid: "e".repeat(64), vout: 0, value: 200000000 },
    burnAddress: b.address, amountGrains: 100000000,
    changeAddress: change, feeRateGrainsPerVByte: 10,
  });
  assert.equal(p.vBytes, 154);
  assert.equal(p.feeGrains, 1540);
  const dec = W.decodeRawTx(p.unsignedHex);
  assert.equal(dec.outputs.length, 2);
});

test("index.html: every id touched by app.js exists", () => {
  const html = readFileSync(P(appDir, "index.html"), "utf8");
  const js = readFileSync(P(appDir, "app.js"), "utf8");
  const ids = new Set();
  for (const m of js.matchAll(/\$\("#([A-Za-z0-9-]+)"\)/g)) ids.add(m[1]);
  for (const m of js.matchAll(/data-copy="#([A-Za-z0-9-]+)"/g)) ids.add(m[1]);
  // ids referenced inside template strings for step switching
  for (const s of ["generate", "plan", "certify", "verify"]) ids.add("step-" + s);
  assert.ok(ids.size > 20, "expected many wired ids, found " + ids.size);
  for (const id of ids) {
    assert.ok(html.includes(`id="${id}"`), `index.html missing id="${id}"`);
  }
});

test("index.html: all asset scripts cache-busted, QR lib present", () => {
  const html = readFileSync(P(appDir, "index.html"), "utf8");
  for (const asset of ["styles.css?v=2", "qrcode.min.js?v=1", "pearl-burn.bundle.js?v=1", "app.js?v=2"]) {
    assert.ok(html.includes(asset), "cache-busted asset missing: " + asset);
  }
  assert.ok(existsSync(P(appDir, "qrcode.min.js")), "qrcode.min.js must be vendored");
});

test("index.html carries attribution (@kshot9000 + PRL address)", () => {
  const html = readFileSync(P(appDir, "index.html"), "utf8");
  assert.ok(html.includes("@kshot9000"), "attribution @kshot9000 missing");
  assert.ok(html.includes("prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d"), "PRL donation address missing");
});

test("honest limits panel is present and visible", () => {
  const html = readFileSync(P(appDir, "index.html"), "utf8");
  assert.ok(html.includes('id="honest-limits"'), "honest limits panel missing");
  assert.ok(html.includes("Burns are irreversible"), "irreversibility warning missing");
  assert.ok(html.includes("never holds your keys"), "no-keys statement missing");
});
