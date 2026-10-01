// Node ESM resolve hook for Pearl Paywall tests.
// Reads ../../sign/importmap.json (browser-style relative paths) and resolves
// each @-specifier to an absolute file URL anchored at the sign directory.
// Usage: node --no-warnings --loader tests/loader.mjs --test tests/predict-core.test.mjs
import { readFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const signDir = resolvePath(here, "..", "..", "sign");
const map = JSON.parse(readFileSync(resolvePath(signDir, "importmap.json"), "utf8")).imports;
const keys = Object.keys(map).sort((a, b) => b.length - a.length); // longest-prefix first

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@")) {
    for (const k of keys) {
      if (k.endsWith("/") && specifier.startsWith(k)) {
        const url = pathToFileURL(resolvePath(signDir, map[k].slice(2) + specifier.slice(k.length))).href;
        return { url, shortCircuit: true };
      }
      if (specifier === k) {
        const url = pathToFileURL(resolvePath(signDir, map[k].slice(2))).href;
        return { url, shortCircuit: true };
      }
    }
  }
  return nextResolve(specifier, context);
}
