// Build script for the Pearl Tax committed browser bundle.
// pearl-tax.bundle.js — IIFE (PearlTax) page bundle.
// Crypto resolves through ../sign/importmap.json (same plugin as the other apps).
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
  globalName: "PearlTax",
  platform: "browser",
  target: "es2020",
  minify: false,
  outfile: resolvePath(here, "pearl-tax.bundle.js"),
  plugins: [importmapPlugin],
  logLevel: "warning",
  banner: {
    js: `/* Pearl Tax bundle (window.PearlTax) — built with esbuild from src/index.js. Do not edit by hand; run \`node build.mjs\`. */`,
  },
});
console.log("wrote pearl-tax.bundle.js");
