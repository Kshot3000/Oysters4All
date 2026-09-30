// Build script for the Pearl Commons committed browser bundle.
// Bundles src/index.js (commons-core.js + audited ../sign/src/crypto.js and its
// vendored ../sign/lib/ deps) into a single IIFE classic script
// (window.PearlCommons) so the page works from file:// and GitHub Pages
// with zero build step. Usage: node build.mjs
//
// NOTE: no esbuild `globalName` — the wrapper `var PearlCommons = (()=>{...})()`
// would clobber the explicit `window.PearlCommons = {...}` at the end of
// src/index.js (IIFE body runs first, then the outer var assignment overwrites
// it with the undefined IIFE return). See AGENTS.md.
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
  outfile: resolvePath(here, "pearl-commons.bundle.js"),
  plugins: [importmapPlugin],
  logLevel: "info",
  banner: {
    js: "/* Pearl Commons bundle (window.PearlCommons) — built with esbuild from src/index.js (commons-core.js + audited sign crypto core). Do not edit by hand; run `node build.mjs`. */",
  },
});
console.log("wrote pearl-commons.bundle.js");
