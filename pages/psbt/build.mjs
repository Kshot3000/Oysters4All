// Build script for the Pearl PSBT committed browser bundle.
// Bundles src/index.js -> src/psbt-core.js -> ../../sign/src/crypto.js +
// vendored ../../sign/lib/ into a single IIFE classic script
// (window.PearlPSBT) so the page works from file:// and GitHub Pages with
// zero build step.
//
// Bare @-specifiers inside sign/src/crypto.js are resolved through
// ../sign/importmap.json (same importmapPlugin the Quorum desk uses).
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
  // NOTE: no globalName — esbuild's `var PearlPSBT = (()=>{...})()` wrapper would
  // clobber the explicit `window.PearlPSBT = {...}` at the end of src/index.js,
  // because the var assignment (undefined IIFE return) runs AFTER the IIFE body.
  platform: "browser",
  target: "es2020",
  minify: false,
  outfile: resolvePath(here, "pearl-psbt.bundle.js"),
  plugins: [importmapPlugin],
  logLevel: "info",
  banner: {
    js: "/* Pearl PSBT bundle (window.PearlPSBT) — built with esbuild from src/index.js. Do not edit by hand; run `node build.mjs`. */",
  },
});
console.log("wrote pearl-psbt.bundle.js");
