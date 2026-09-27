// Build script for the Pearl Wallet committed browser bundle.
// Mirrors files/pages/pay/build.mjs: bundles the ESM crypto core
// (src/pearl-wallet-core.js + vendored lib/) into a single IIFE classic script
// (window.PearlWallet) so index.html works from file:// and GitHub Pages with
// zero build step for end users.
//
// Usage: node build.mjs   (esbuild resolved via ~/workspace/.build-tools)
// The ESM source, importmap.json and lib/ are kept for developers and for the
// node test suite (tests/verify.mjs).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
let esbuild;
try {
  esbuild = require("esbuild");
} catch {
  esbuild = createRequire("/home/hatch/workspace/.build-tools/package.json")("esbuild");
}

const here = dirname(fileURLToPath(import.meta.url));
const map = JSON.parse(
  readFileSync(resolvePath(here, "importmap.json"), "utf8")
).imports;
const keys = Object.keys(map).sort((a, b) => b.length - a.length); // longest-prefix first

const importmapPlugin = {
  name: "importmap",
  setup(build) {
    build.onResolve({ filter: /^[^./]/ }, (args) => {
      for (const k of keys) {
        if (k.endsWith("/") && args.path.startsWith(k)) {
          return {
            path: resolvePath(here, map[k].slice(2) + args.path.slice(k.length)),
          };
        }
        if (args.path === k) {
          return { path: resolvePath(here, map[k].slice(2)) };
        }
      }
      return null;
    });
  },
};

await esbuild.build({
  entryPoints: [resolvePath(here, "src/pearl-wallet-core.js")],
  bundle: true,
  format: "iife",
  globalName: "PearlWallet",
  platform: "browser",
  target: "es2020",
  minify: false,
  outfile: resolvePath(here, "pearl-wallet.bundle.js"),
  plugins: [importmapPlugin],
  logLevel: "info",
  banner: {
    js: "/* Pearl Wallet crypto core bundle (window.PearlWallet) — built with esbuild from src/pearl-wallet-core.js. Do not edit by hand; run `node build.mjs`. */",
  },
});
console.log("wrote pearl-wallet.bundle.js");
