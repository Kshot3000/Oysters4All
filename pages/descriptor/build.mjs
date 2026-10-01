// Build script for the BIP-380 descriptor committed browser bundle.
// Bundles the ESM sources (src/index.js -> payjoin-core.js, which imports the
// audited ../descriptor-core.js and ../sign/src/crypto.js, with bare
// @-specifiers resolved through the vendored ../sign/importmap.json) into a
// single plain IIFE classic script (window.PearlDescriptor is assigned explicitly
// in src/index.js) so the page works from file:// and GitHub Pages with zero
// build step. NOTE: no esbuild `globalName` — an IIFE globalName wrapper
// clobbers the explicit window assignment (see AGENTS.md).
//
// Usage: node build.mjs   (esbuild resolved via ~/workspace/.build-tools)
import { readFileSync, writeFileSync } from "node:fs";
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

const out = await esbuild.build({
  entryPoints: [resolvePath(here, "src/index.js")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2020",
  minify: true,
  write: false,
  plugins: [importmapPlugin],
});

const banner = "/* BIP-380 descriptor bundle — BIP-380 output-descriptor desk for PRL. " +
  "Crypto: audited files/pages/sign/src/crypto.js + files/pages/descriptor-core.js " +
  "(@noble/* + @scure/*, MIT, paulmillr.com). Protocol: BIP-78. Built " +
  new Date().toISOString().slice(0, 10) + ". */\n";
writeFileSync(resolvePath(here, "pearl-descriptor.bundle.js"), banner + out.outputFiles[0].text);
console.log("wrote pearl-descriptor.bundle.js", out.outputFiles[0].text.length, "bytes");
