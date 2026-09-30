// Build script for the Pearl Circle committed browser bundle.
// Bundles ENTRY -> circle-core.js + ../sign/src/crypto.js +
// ../sign/src/sign-core.js + ../escrow + ../games + ../bond + ../covenant
// lineage helpers + vendored ../sign/lib/ into a single IIFE
// classic script (window.PearlCircle) so the page works from file:// and
// GitHub Pages with zero build step.
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
  globalName: "PearlCircle",
  platform: "browser",
  target: "es2020",
  minify: false,
  outfile: resolvePath(here, "pearl-circle.bundle.js"),
  plugins: [importmapPlugin],
  logLevel: "info",
  banner: {
    js: "/* Pearl Circle bundle (window.PearlCircle) — built with esbuild from src/index.js (circle-core.js + sign/escrow/games/bond/covenant-lineage helpers). Do not edit by hand; run `node build.mjs`. */",
  },
});
console.log("wrote pearl-circle.bundle.js");
