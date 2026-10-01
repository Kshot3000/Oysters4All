// Build script for the Pearl Drop committed browser bundle.
// Bundles src/index.js (+ src/logic.js) into a single IIFE classic script
// (window.PearlDrop) so the page works from file:// and GitHub Pages
// with zero build step. Usage: node build.mjs
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
  // NOTE: no globalName — esbuild's `var PearlDrop = (()=>{...})()` wrapper would
  // clobber the explicit `window.PearlDrop = {...}` at the end of src/index.js,
  // because the var assignment (undefined IIFE return) runs AFTER the IIFE body.
  platform: "browser",
  target: "es2020",
  minify: false,
  outfile: resolvePath(here, "pearl-drop.bundle.js"),
  logLevel: "info",
  banner: {
    js: "/* Pearl Drop bundle (window.PearlDrop) — built with esbuild from src/index.js. Do not edit by hand; run `node build.mjs`. */",
  },
});
console.log("wrote pearl-drop.bundle.js");
