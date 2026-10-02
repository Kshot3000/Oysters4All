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
  assert.ok(html.includes('href="styles.css?v=2"'), "styles cache-busted");
});

test("styles.css exists and is non-trivial", () => {
  const css = readFileSync(P(appDir, "styles.css"), "utf8");
  assert.ok(css.length > 3000, "real stylesheet");
  assert.ok(css.includes("--wax"), "midnight-archive theme tokens");
});

test("qrcode lib vendored", () => {
  assert.ok(existsSync(P(appDir, "qrcode.min.js")), "qrcode.min.js vendored");
});
