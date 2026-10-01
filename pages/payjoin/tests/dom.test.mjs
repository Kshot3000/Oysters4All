// Pearl Payjoin DOM/wiring tests — bundle exports + HTML id coverage.
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
const bundleSrc = fs.readFileSync(path.join(root, "pearl-payjoin.bundle.js"), "utf8");
const sandbox = { window: {}, console, TextEncoder, TextDecoder, crypto, btoa, atob };
vm.createContext(sandbox);
vm.runInContext(bundleSrc, sandbox, { filename: "pearl-payjoin.bundle.js" });
const P = sandbox.window.PearlPayjoin;
ok("bundle exposes window.PearlPayjoin", !!P);
ok("PearlPayjoin.version === 1", P && P.version === 1);
const fns = ["fail", "parseGrains", "parseRate", "grainsToPRL", "parsePrl1Address",
  "programToAddress", "addressToSpk", "spkToAddress", "isP2TR", "deriveSenderKey",
  "prepareSenderInput", "parseOfferParams", "endpointQuery", "buildReceiverOffer",
  "decodePaste", "validateOfferTemplate", "summarizePsbt", "buildSenderOriginal",
  "validateFundedOriginal", "buildProposal", "verifyProposal", "signProposal",
  "labSelfTest", "defaultRng", "fetchUtxos", "fetchFeeRateGrainsPerVByte", "broadcastTx"];
for (const f of fns) ok("export " + f, typeof P[f] === "function");
ok("BLOCKBOOK_MAINNET is https", typeof P.BLOCKBOOK_MAINNET === "string" && P.BLOCKBOOK_MAINNET.startsWith("https://"));
ok("ATTRIBUTION.x === @kshot9000", P.ATTRIBUTION && P.ATTRIBUTION.x === "@kshot9000");
ok("ATTRIBUTION.prl is the exact PRL address", P.ATTRIBUTION && P.ATTRIBUTION.prl === PRL);

/* 2. in-VM: the full lab self-test runs green inside the sandbox */
{
  const r = P.labSelfTest();
  ok("in-VM labSelfTest ok", r && r.ok === true && r.lines.length === 7, String(r && r.lines.length));
  ok("in-VM self-test txid looks real", /^[0-9a-f]{64}$/.test(r.txid), r.txid);
}

/* 3. app.js references only element ids present in index.html */
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const ids = new Set([...html.matchAll(/ id="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]));
const appSrc = fs.readFileSync(path.join(root, "app.js"), "utf8");
const refs = new Set([...appSrc.matchAll(/\$\("([A-Za-z0-9_-]+)"\)/g)].map((m) => m[1]));
const missing = [...refs].filter((id) => !ids.has(id));
ok("all app.js $(\"id\") refs exist in index.html", missing.length === 0, missing.join(", "));

/* 4. five tabs, five panels, deep links */
const tabBtns = (html.match(/data-tab="[a-z]+"/g) || []).length;
ok("tab bar has 5 buttons", tabBtns === 5, String(tabBtns));
for (const t of ["receiver", "sender", "proposal", "verify", "sign"]) {
  ok("panel tab-" + t + " exists", ids.has("tab-" + t));
  ok("tab button data-tab=" + t, html.includes(`data-tab="${t}"`));
  const m = html.match(new RegExp(`id="tab-${t}"[\\s\\S]*?(?=id="tab-|</main>)`));
  ok(`tab ${t} has action buttons`, m && /<button/.test(m[0]));
}

/* 5. cache-busting keys on every local script/style */
for (const asset of ["styles.css", "pearl-payjoin.bundle.js", "app.js"]) {
  ok(`${asset} referenced with ?v=`, new RegExp(asset.replace(".", "\\.") + "\\?v=\\d+").test(html));
}

/* 6. honest framing + attribution */
ok("honest limits section present", /What this is, honestly/.test(html));
ok("honest: lab not a wallet/server", /lab, not a wallet/i.test(html));
ok("honest: keys never leave the page", /never leave the page/i.test(html));
ok("honest: broadcast is double-gated", /double-gated/i.test(html));
ok("footer carries @kshot9000", html.includes("@kshot9000"));
ok("footer carries exact PRL address verbatim", html.includes("<code>" + PRL + "</code>"));
ok("verify tab warns failing proposals must never be signed", /must never be signed/i.test(html));

/* 7. theme sanity: teal/cyan duet, not hush indigo */
const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");
ok("teal sender accent", /2dd4bf/.test(css));
ok("cyan receiver accent", /22d3ee/.test(css));
ok("not the hush indigo theme", !/070a18/.test(css));

/* 8. app.js hygiene */
ok("app.js calls labSelfTest", appSrc.includes("labSelfTest"));
ok("app.js never touches localStorage", !/localStorage\s*[\.\[]/.test(appSrc));
ok("no mock txids in app.js", !/aa"\.repeat\(32\)/.test(appSrc));
ok("broadcast button starts disabled", /id="g-broadcast"[^>]*disabled/.test(html));
ok("bundle script tag precedes app.js", html.indexOf("pearl-payjoin.bundle.js") < html.indexOf("app.js?v="));

console.log(`\ndom: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
