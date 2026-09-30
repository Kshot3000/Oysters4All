// Node ESM resolve hook for running tests/games.test.mjs.
// Reuses ../sign/importmap.json: bare @-specifiers resolve to the vendored
// libs in ../sign/lib/. Usage:
//   node --no-warnings --loader ./tests/loader.mjs tests/games.test.mjs
import { readFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const signDir = resolvePath(here, "..", "..", "sign");
const map = JSON.parse(readFileSync(resolvePath(signDir, "importmap.json"), "utf8")).imports;
const keys = Object.keys(map).sort((a, b) => b.length - a.length); // longest-prefix first

const toFileUrl = (rel) => {
  let u = pathToFileURL(resolvePath(signDir, rel)).href;
  if (rel.endsWith("/") && !u.endsWith("/")) u += "/";
  return u;
};
const resolved = keys.map((k) => [k, toFileUrl(map[k])]);

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@")) {
    for (const [k, url] of resolved) {
      if (k.endsWith("/") && specifier.startsWith(k)) {
        return { url: url + specifier.slice(k.length), shortCircuit: true };
      }
      if (specifier === k) return { url, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}
