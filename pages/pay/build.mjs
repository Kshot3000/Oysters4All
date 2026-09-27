// Build script for the Pearl Pay committed browser bundle.
// Mirrors files/pages/prl20-launcher/pearl-bundle.js: bundles the ESM crypto
// core (pearl-pay-core.js + vendored lib/) into a single IIFE classic script
// (window.PearlPayCore) so index.html / invoice.html work from file:// and
// GitHub Pages with zero build step for end users.
//
// Usage: node build.mjs   (requires esbuild: npx --yes esbuild)
// The ESM source (pearl-pay-core.js), importmap.json and lib/ are kept for
// developers and for the node test suite (tests/verify.mjs).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
let esbuild;
try {
  esbuild = require("esbuild");
} catch {
  // Fallback: shared persistent install (see ~/workspace/.build-tools).
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
      return null; // let esbuild handle the rest (node builtins, etc.)
    });
  },
};

await esbuild.build({
  entryPoints: [resolvePath(here, "pearl-pay-core.js")],
  bundle: true,
  format: "iife",
  globalName: "PearlPayCore",
  platform: "browser",
  target: "es2020",
  minify: false,
  outfile: resolvePath(here, "pearl-pay-core.bundle.js"),
  plugins: [importmapPlugin],
  logLevel: "info",
  banner: {
    js: "/* Pearl Pay crypto core bundle (window.PearlPayCore) — built with esbuild from pearl-pay-core.js. Do not edit by hand; run `node build.mjs`. */",
  },
});
console.log("wrote pearl-pay-core.bundle.js");
