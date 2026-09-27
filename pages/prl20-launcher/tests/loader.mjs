// Node ESM resolve hook for running tests/verify.mjs.
// Reads ../importmap.json (relative paths, browser-style) and resolves each
// entry to an absolute file URL so `node --loader tests/loader.mjs` works.
// Usage: node --no-warnings --loader tests/loader.mjs tests/verify.mjs
import { readFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const launcherDir = resolvePath(here, "..");
const map = JSON.parse(readFileSync(resolvePath(launcherDir, "importmap.json"), "utf8")).imports;
const keys = Object.keys(map).sort((a, b) => b.length - a.length); // longest-prefix first

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@")) {
    for (const k of keys) {
      if (k.endsWith("/") && specifier.startsWith(k)) {
        const url = pathToFileURL(resolvePath(launcherDir, map[k].slice(2) + specifier.slice(k.length))).href;
        return { url, shortCircuit: true };
      }
      if (specifier === k) {
        const url = pathToFileURL(resolvePath(launcherDir, map[k].slice(2))).href;
        return { url, shortCircuit: true };
      }
    }
  }
  return nextResolve(specifier, context);
}
