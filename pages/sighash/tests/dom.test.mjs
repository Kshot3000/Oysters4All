// Pearl Sighash Studio DOM/wiring tests — bundle exports + HTML id coverage.
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

/* 1. bundle boots in a VM and exposes the full surface */
const bundleSrc = fs.readFileSync(path.join(root, "pearl-sighash.bundle.js"), "utf8");
const sandbox = { window: {}, console, TextEncoder, TextDecoder, crypto };
vm.createContext(sandbox);
vm.runInContext(bundleSrc, sandbox, { filename: "pearl-sighash.bundle.js" });
const P = sandbox.window.PearlSighash;
ok("bundle exposes window.PearlSighash", !!P);
ok("PearlSighash.version === 1", P && P.version === 1);
const fns = ["tapSighashAnatomy", "compareFlags", "flagDigestMatrix", "flagInfo",
  "taggedHash", "sha256", "bytesToHex", "hexToBytes", "concat", "u64le", "varint",
  "bip340Sign", "bip340Verify", "bip340Pubkey", "randomPrivkey",
  "parseUnsignedTx", "sealScenario", "verifySealed", "demoScenario",
  "p2trSpk", "grainsToPRL"];
for (const f of fns) ok("export " + f, typeof P[f] === "function");
ok("SEAL_DOMAIN === pearl-sighash:v1", P.SEAL_DOMAIN === "pearl-sighash:v1");
ok("vectors.BIP341_KEYPATH present", !!(P.vectors && P.vectors.BIP341_KEYPATH));
ok("BIP-341 vectors carry 7 cases", P.vectors.BIP341_KEYPATH.cases.length === 7);
ok("vectors.BIP340_VECTORS present", !!(P.vectors && P.vectors.BIP340_VECTORS));
ok("BIP-340 vectors carry 19 rows", P.vectors.BIP340_VECTORS.length === 19);

/* 2. app.js references only element ids present in index.html */
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const ids = new Set([...html.matchAll(/ id="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]));
const appSrc = fs.readFileSync(path.join(root, "app.js"), "utf8");
const refs = new Set([...appSrc.matchAll(/\$\("([A-Za-z0-9_-]+)"\)/g)].map((m) => m[1]));
const missing = [...refs].filter((id) => !ids.has(id));
ok("all app.js $(\"id\") refs exist in index.html", missing.length === 0, missing.join(", "));
ok("index.html has 5 step panels", (html.match(/class="panel( active)?"/g) || []).length === 5);
ok("steps nav has 5 buttons", (html.match(/data-step="[a-z]+"/g) || []).length === 5);

/* 3. deep-link anchors for the five tabs */
for (const s of ["build", "anatomy", "compare", "sign", "verify"]) {
  ok("step panel step-" + s + " exists", ids.has("step-" + s));
  ok("app.js wires #" + s + " deep link", appSrc.includes('"' + s + '"'));
}

/* 4. cache-busting keys on every local script/style */
for (const asset of ["styles.css", "pearl-sighash.bundle.js", "app.js"]) {
  ok(`${asset} referenced with ?v=`, new RegExp(asset.replace(".", "\\.") + "\\?v=\\d+").test(html));
}

/* 5. every panel has at least one action button */
for (const p of ["build", "anatomy", "compare", "sign", "verify"]) {
  const m = html.match(new RegExp(`id="step-${p}"[\\s\\S]*?(?=id="step-|</main>)`));
  ok(`step ${p} has action buttons`, m && /<button/.test(m[0]));
}

/* 6. honest limits panel + footer attribution present */
ok("honest limits panel present", html.includes('id="honest-limits"'));
ok("footer carries @kshot9000", html.includes("@kshot9000"));
ok("footer carries PRL donation address", html.includes("prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d"));
ok("no mock data presented as real: demo labeled", /labeled demo/i.test(html));
ok("SIGHASH_SINGLE loud-refusal documented", /SIGHASH_SINGLE/i.test(html));

/* 7. theme sanity: blueprint, not a clone of Pact/Burn/Will/Mesh */
const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");
ok("blueprint grid background", /linear-gradient/.test(css) && /0a2249/.test(css));
ok("cyan drafting ink", /7df9ff/.test(css));

console.log(`\ndom: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
