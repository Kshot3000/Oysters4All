// Build script for the Pearl Node committed browser bundle.
// Bundles src/index.js (node-core.js) into a single IIFE classic script
// (window.PearlNode) so the page works from file:// and GitHub Pages with
// zero build step. Usage: node build.mjs (esbuild via ~/workspace/.build-tools)
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

await esbuild.build({
  entryPoints: [resolvePath(here, "src/index.js")],
  bundle: true,
  format: "iife",
  globalName: "PearlNode",
  platform: "browser",
  target: "es2020",
  minify: false,
  outfile: resolvePath(here, "pearl-node.bundle.js"),
  logLevel: "info",
  banner: {
    js: "/* Pearl Node bundle (window.PearlNode) — built with esbuild from src/index.js. Do not edit by hand; run `node build.mjs`. */",
  },
});
console.log("wrote pearl-node.bundle.js");
