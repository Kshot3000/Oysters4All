// Pearl Atlas DOM/wiring tests — bundle exports + HTML id coverage + cache keys.
// Usage: node --no-warnings --loader ./tests/loader.mjs tests/dom.test.mjs
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, "..");
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("✔ " + name); }
  else { fail++; console.log("✖ " + name + (extra ? " — " + extra : "")); }
};

const PRL = "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d";

/* 1. bundle boots in a VM and exposes the full surface */
const bundleSrc = fs.readFileSync(path.join(root, "pearl-descriptor.bundle.js"), "utf8");
const sandbox = { window: {}, console, TextEncoder, TextDecoder, crypto, btoa, atob };
vm.createContext(sandbox);
vm.runInContext(bundleSrc, sandbox, { filename: "pearl-descriptor.bundle.js" });
const P = sandbox.window.PearlDescriptor;
ok("bundle exposes window.PearlDescriptor", !!P);
ok("PearlDescriptor.version === 1", P && P.version === 1);
const fns = ["selfTest", "parseDescriptor", "descChecksum", "descAddChecksum", "descCheckChecksum",
  "deriveDescriptor", "expandDescriptorMultipath", "buildTapscript", "taprootTweak", "controlBlock",
  "describe", "listKeys", "hasMultipath", "canonicalBody", "scriptNum", "validateRanges"];
for (const f of fns) ok("export " + f, typeof P[f] === "function");
ok("TEMPLATES is a non-empty array", Array.isArray(P.TEMPLATES) && P.TEMPLATES.length >= 4);
ok("ATTRIBUTION.x === @kshot9000", P.ATTRIBUTION && P.ATTRIBUTION.x === "@kshot9000");
ok("ATTRIBUTION.prl is the exact PRL address", P.ATTRIBUTION && P.ATTRIBUTION.prl === PRL);

/* 2. in-VM: the full self-test battery runs green inside the sandbox */
{
  const r = P.selfTest();
  const bad = r.lines.filter((l) => !l.ok);
  ok("in-VM selfTest ok", r && r.ok === true, bad.map((l) => l.name + ": " + l.extra).join(" | "));
  ok("in-VM self-test ran 8 checks", r.lines.length === 8, String(r.lines.length));
}

/* 3. app.js references only element ids present in index.html */
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const ids = new Set([...html.matchAll(/ id="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]));
const appSrc = fs.readFileSync(path.join(root, "app.js"), "utf8");
const refs = new Set([...appSrc.matchAll(/\$\("([A-Za-z0-9_-]+)"\)/g)].map((m) => m[1]));
const missing = [...refs].filter((id) => !ids.has(id));
ok('all app.js $("id") refs exist in index.html', missing.length === 0, missing.join(", "));

/* 4. every tab button has a matching panel */
const tabs = [...html.matchAll(/data-tab="([a-z]+)"/g)].map((m) => m[1]);
ok("5 tabs", tabs.length === 5, tabs.join(","));
ok("every tab has a panel", tabs.every((t) => ids.has("tab-" + t)));

/* 5. cache keys: bundle, app.js, styles.css all carry ?v= */
for (const f of ["pearl-descriptor.bundle.js?v=", "app.js?v=", "styles.css?v="]) {
  ok("cache key on " + f.split("?")[0], html.includes(f), "missing ?v=");
}

/* 6. honest-limits panel is always in the DOM */
ok("honest limits panel present", html.includes('class="limits"'));

/* 7. no external URLs anywhere in the page (offline guarantee) */
const extUrls = [...html.matchAll(/https?:\/\//g)].length + [...appSrc.matchAll(/https?:\/\//g)].length;
ok("no http(s) URLs in index.html/app.js (offline)", extUrls === 0, String(extUrls));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
