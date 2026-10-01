// Pearl Pact DOM/wiring tests — bundle exports + HTML id coverage.
// Usage: node tests/dom.test.mjs
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
const bundleSrc = fs.readFileSync(path.join(root, "pearl-pact.bundle.js"), "utf8");
const sandbox = { window: {}, console, TextEncoder, TextDecoder, crypto };
vm.createContext(sandbox);
vm.runInContext(bundleSrc, sandbox, { filename: "pearl-pact.bundle.js" });
const P = sandbox.window.PearlPact;
ok("bundle exposes window.PearlPact", !!P);
ok("PearlPact.version === 1", P && P.version === 1);
const fns = ["sha256", "prlToGrains", "grainsToPRL", "mintOracleKey", "oracleOutcomeSecret",
  "oracleAnnouncements", "oracleAttest", "verifyAttestation",
  "adaptorEncrypt", "adaptorVerify", "adaptorDecrypt",
  "buildPactTerms", "exportTerms", "importTerms", "verifyPactDescriptor", "numsInternalKeyPact",
  "partyPayoutAddress", "planFundingTx", "signFundingTx", "buildCets", "sealPact",
  "verifySealedPact", "exportSealed", "importSealed", "executePact", "buildRefundTx",
  "signRefundTx", "fetchUtxos", "broadcastTx", "mintDemoPact"];
for (const f of fns) ok("export " + f, typeof P[f] === "function");
for (const c of ["ATTRIBUTION", "NUMS_DOMAIN"]) ok("const " + c, typeof P[c] !== "undefined");

/* 2. app.js references only element ids present in index.html */
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const ids = new Set([...html.matchAll(/ id="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]));
const appSrc = fs.readFileSync(path.join(root, "app.js"), "utf8");
const refs = new Set([...appSrc.matchAll(/\$\("#([A-Za-z0-9_-]+)"\)/g)].map((m) => m[1]));
const missing = [...refs].filter((id) => !ids.has(id));
ok("all app.js #id refs exist in index.html", missing.length === 0, missing.join(", "));
ok("index.html has 5 step panels", STEP_PANELS(html) === 5);
function STEP_PANELS(h) { return (h.match(/class="panel( active)?"/g) || []).length; }
ok("steps nav has 5 buttons", (html.match(/data-step="[a-z]+"/g) || []).length === 5);

/* 3. cache-busting keys on every local script/style */
for (const asset of ["styles.css", "pearl-pact.bundle.js", "app.js", "qrcode.min.js"]) {
  ok(`${asset} referenced with ?v=`, new RegExp(asset.replace(".", "\\.") + "\\?v=\\d+").test(html));
}

/* 4. every panel has at least one primary action button */
const panels = ["draft", "fund", "seal", "execute", "refund"];
for (const p of panels) {
  const m = html.match(new RegExp(`id="step-${p}"[\\s\\S]*?(?=id="step-|</main>)`));
  ok(`step ${p} has action buttons`, m && /<button/.test(m[0]));
}

/* 5. honest limits panel + footer attribution present */
ok("honest limits panel present", html.includes('id="honest-limits"'));
ok("footer carries @kshot9000", html.includes("@kshot9000"));
ok("footer carries PRL donation address", html.includes("prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
