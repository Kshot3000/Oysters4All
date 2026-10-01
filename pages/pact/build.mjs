// Build script for the Pearl Pact committed browser bundle.
// Bundles the ESM sources (src/index.js -> pact-core.js + ../sign/src/crypto.js
// + ../vault/src/vault-core.js + vendored ../sign/lib/) into a single plain
// IIFE classic script (window.PearlPact is assigned explicitly in
// src/index.js) so the page works from file:// and GitHub Pages with zero
// build step. NOTE: no esbuild `globalName` — an IIFE `globalName` wrapper
// clobbers the explicit window assignment (see AGENTS.md).
//
// Usage: node build.mjs   (esbuild resolved via ~/workspace/.build-tools)
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
const signDir = resolvePath(here, "..", "sign");
const map = JSON.parse(readFileSync(resolvePath(signDir, "importmap.json"), "utf8")).imports;
const keys = Object.keys(map).sort((a, b) => b.length - a.length);

const importmapPlugin = {
  name: "importmap",
  setup(build) {
    build.onResolve({ filter: /^[^./]/ }, (args) => {
      for (const k of keys) {
        if (k.endsWith("/") && args.path.startsWith(k)) {
          return { path: resolvePath(signDir, map[k].slice(2) + args.path.slice(k.length)) };
        }
        if (args.path === k) {
          return { path: resolvePath(signDir, map[k].slice(2)) };
        }
      }
      return null;
    });
  },
};

await esbuild.build({
  entryPoints: [resolvePath(here, "src/index.js")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2020",
  minify: false,
  outfile: resolvePath(here, "pearl-pact.bundle.js"),
  plugins: [importmapPlugin],
  logLevel: "info",
  banner: {
    js: "/* Pearl Pact bundle (window.PearlPact) — built with esbuild from src/index.js. Do not edit by hand; run `node build.mjs`. */",
  },
});
console.log("wrote pearl-pact.bundle.js");
