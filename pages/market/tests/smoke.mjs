/* Pearl Bazaar headless UI smoke tests (jsdom).
 *
 * Loads the REAL pages (index.html, token.html, portfolio.html, list.html)
 * plus the REAL built bundle and app.js into jsdom, then drives the flows:
 * home/demo/live-offline rendering, token chart+order book, bid placement,
 * demo fill, listing wizard (identity -> lot pick -> price -> sign ->
 * publish), portfolio listing/bid cancellation, and settings persistence.
 *
 * No real funds: the wizard's indexer is a stubbed fetch, keys are random
 * throwaway keys, and nothing is broadcast.
 *
 * Run: node --no-warnings tests/smoke.mjs
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

const require = createRequire("/tmp/package.json");
const { JSDOM } = require("jsdom");

const dir = dirname(fileURLToPath(import.meta.url));
const root = join(dir, "..");
const bundleSrc = readFileSync(join(root, "market.bundle.js"), "utf8");
const appSrc = readFileSync(join(root, "app.js"), "utf8");

let passed = 0, failed = 0;
const failures = [];
function ok(cond, name) {
  if (cond) { passed++; /* console.log("  ok:", name); */ }
  else { failed++; failures.push(name); console.log("  FAIL:", name); }
}

/** Build a jsdom window with the real page + scripts evaluated in order. */
function loadPage(file, query = "", { beforeEval } = {}) {
  const html = readFileSync(join(root, file), "utf8");
  const errors = [];
  const dom = new JSDOM(html, {
    // https origin (not file://) so localStorage works in jsdom; the real
    // pages remain file://-safe — this only affects the test harness.
    url: "https://localhost/market/" + file + query,
    pretendToBeVisual: true,
    runScripts: "outside-only",
  });
  const win = dom.window;
  win.addEventListener("error", (e) => errors.push("window.onerror: " + (e.message || e.error)));
  // jsdom has no canvas backend: stub getContext so drawChart's null-guard is exercised quietly
  if (win.HTMLCanvasElement && win.HTMLCanvasElement.prototype)
    win.HTMLCanvasElement.prototype.getContext = () => null;
  if (beforeEval) beforeEval(win);
  const inline = [];
  for (const s of win.document.querySelectorAll("script")) {
    if (s.src) continue;
    inline.push(s.textContent);
    s.textContent = ""; // prevent double-run if anything re-evals
  }
  try { win.eval(bundleSrc); } catch (e) { errors.push("bundle eval: " + e.message); }
  try { win.eval(appSrc); } catch (e) { errors.push("app eval: " + e.message); }
  for (const src of inline) { try { win.eval(src); } catch (e) { errors.push("inline eval: " + e.message); } }
  return { win, errors };
}
const flush = (ms = 60) => new Promise((r) => setTimeout(r, ms));
function seedSettings(win, s) {
  win.localStorage.setItem("pearl-market-settings-v1", JSON.stringify(s));
}
const doc = (win) => win.document;
const q = (win, sel) => doc(win).querySelector(sel);
const qa = (win, sel) => Array.from(doc(win).querySelectorAll(sel));
function click(win, el) {
  el.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
}

/* ================= 1. home, demo mode (defaults) ================= */
{
  const { win, errors } = loadPage("index.html");
  await flush();
  ok(errors.length === 0, "home: zero window errors (demo) :: " + errors.join(" | "));
  const cards = qa(win, ".token-card");
  ok(cards.length === 4, `home: 4 demo token cards (got ${cards.length})`);
  ok(cards.every((c) => c.textContent.includes("demo")), "home: token cards labelled demo");
  ok(q(win, "#movers").textContent.includes("PRLS") || q(win, "#movers").textContent.includes("24h") || qa(win, "#movers table").length === 1,
    "home: top movers table rendered");
  ok(qa(win, "#featured table").length === 1, "home: featured listings table rendered");
  ok(q(win, "#demo-slot").textContent.includes("DEMO"), "home: demo banner present");
  ok(q(win, "#local-slot").textContent.includes("Local board"), "home: local-board banner present");
  ok(q(win, "#conn").textContent.includes("demo"), "home: conn badge shows demo");
  ok(q(win, "#donate-address").textContent.trim() === "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d",
    "home: donation address in footer");
  ok(q(win, "#set-demo").checked === true, "home: settings demo toggle on by default");
}

/* ================= 2. home, live-offline (no demo, no indexer) ================= */
{
  const { win, errors } = loadPage("index.html", "", {
    beforeEval: (w) => seedSettings(w, { demo: false, indexerBase: "", blockbookBase: "https://blockbook.pearlresearch.ai", address: "", networkId: "mainnet" }),
  });
  await flush();
  ok(errors.length === 0, "home offline: zero window errors :: " + errors.join(" | "));
  ok(q(win, "#token-dir").textContent.includes("Offline"), "home offline: graceful offline state");
  ok(q(win, "#conn").textContent.includes("not connected"), "home offline: conn badge not connected");
  ok(!q(win, "#demo-slot").textContent.includes("DEMO"), "home offline: no demo banner when demo off");
}

/* ================= 3. token page: chart + book + bid + demo fill ================= */
{
  const { win, errors } = loadPage("token.html", "?tick=prls");
  await flush();
  ok(errors.length === 0, "token: zero window errors :: " + errors.join(" | "));
  ok(q(win, "#token-head").textContent.includes("PRLS"), "token: header shows PRLS");
  ok(q(win, "#chart") instanceof win.HTMLCanvasElement, "token: chart canvas present");
  const askRows = qa(win, "#asks .book-row");
  ok(askRows.length > 0, `token: asks rendered (${askRows.length})`);
  ok(qa(win, "#bids .book-row").length > 0, "token: bids rendered");
  ok(qa(win, "#asks .fill-btn").length > 0, "token: fill buttons on asks");
  ok(q(win, "#tape").textContent.length > 50, "token: trade tape rendered");

  // place a resting bid that does NOT cross (max price way below asks)
  const M = win.PearlMarket;
  const buyer = M.walletFromPriv(randomBytes(32).toString("hex"), M.NETWORKS.mainnet).address;
  q(win, "#bid-amount").value = "100000";
  q(win, "#bid-max").value = "0.000001"; // 1000 grains/token, far under demo asks
  q(win, "#bid-address").value = buyer;
  q(win, "#bid-form").dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }));
  await flush();
  ok(errors.length === 0, "token: bid submit, zero window errors :: " + errors.join(" | "));
  ok(q(win, "#bids").textContent.includes(buyer.slice(0, 10)), "token: resting demo bid appears in book");

  // demo fill of the first ask
  const asksBefore = qa(win, "#asks .book-row").length;
  click(win, qa(win, "#asks .fill-btn")[0]);
  await flush();
  ok(q(win, ".modal-backdrop") != null, "token: fill modal opens");
  ok(q(win, "#fill-demo-go") != null, "token: demo fill button present");
  click(win, q(win, "#fill-demo-go"));
  await flush();
  ok(q(win, ".modal-backdrop") == null, "token: modal closes after demo fill");
  const asksAfter = qa(win, "#asks .book-row").length;
  ok(asksAfter === asksBefore - 1, `token: demo fill consumes the ask (${asksBefore} -> ${asksAfter})`);
  ok(errors.length === 0, "token: after flows, zero window errors :: " + errors.join(" | "));
}

/* ================= 4. listing wizard end-to-end (mocked indexer) ================= */
{
  const lotTxid = randomBytes(32).toString("hex");
  const { win, errors } = loadPage("list.html", "", {
    beforeEval: (w) => {
      seedSettings(w, { demo: true, indexerBase: "https://idx.test", blockbookBase: "https://blockbook.pearlresearch.ai", address: "", networkId: "mainnet" });
    },
  });
  // throwaway key generated inside the window so bech32m matches the bundle
  const M = win.PearlMarket;
  const privHex = randomBytes(32).toString("hex");
  const w = M.walletFromPriv(privHex, M.NETWORKS.mainnet);
  const walletAddr = w.address;

  // stub the indexer fetch for this window
  win.fetch = async (url) => {
    const u = String(url);
    const json = (obj) => ({ ok: true, status: 200, json: async () => obj });
    if (u.includes("/transfer-lots")) return json({ transferLots: [{
      id: "lot1", ticker: "prls", displayTicker: "PRLS", amount: "250000000000000000000",
      currentOutpoint: lotTxid + ":0", currentOwnerAddress: walletAddr, locationStatus: "confirmed",
    }], tokens: {}, total: 1 });
    if (u.includes("/utxos")) return json({ utxos: [{ outpoint: lotTxid + ":0", txid: lotTxid, vout: 0, valueGrain: 546, protected: true }] });
    throw new Error("unexpected fetch " + u);
  };

  await flush();
  ok(errors.length === 0, "wizard: zero window errors on load :: " + errors.join(" | "));

  // step 1: validation first
  click(win, q(win, "#w-next"));
  await flush();
  ok(q(win, "#wizard-panel").textContent.includes("Who is selling"), "wizard: step1 blocks empty address");
  q(win, "#w-address").value = walletAddr;
  click(win, q(win, "#w-next"));
  await flush(120);
  ok(q(win, "#lot-list") != null, "wizard: step2 lot picker rendered");

  // step 2: pick the mocked lot
  const radio = q(win, '#lot-list input[name=lot]');
  ok(radio != null, "wizard: mocked indexer lot listed");
  if (radio) {
    click(win, radio.closest(".lot-option"));
    click(win, q(win, "#lot-pick"));
    await flush(120);
  }
  ok(q(win, "#p-per") != null, "wizard: step3 price step rendered");

  // step 3: price
  q(win, "#p-per").value = "0.025";
  q(win, "#p-per").dispatchEvent(new win.Event("input", { bubbles: true }));
  await flush();
  const total = q(win, "#p-total").textContent;
  ok(total.includes("PRL") && !total.includes("—"), `wizard: total computed (${total.trim()})`);
  click(win, q(win, "#w-next"));
  await flush();
  ok(q(win, "#w-sign") != null, "wizard: step4 review rendered");

  // step 4: sign with the key (memory only)
  q(win, "#w-key2").value = privHex;
  click(win, q(win, "#w-sign"));
  await flush();
  ok(q(win, "#sign-out") && q(win, "#sign-out").textContent.includes("valid"), "wizard: presignature signs and verifies");
  const pub = q(win, "#w-publish");
  ok(pub != null && !pub.disabled, "wizard: publish enabled");
  click(win, pub);
  await flush();
  const board = M.loadBoard();
  ok(board.listings.length === 1, `wizard: listing published to local board (${board.listings.length})`);
  const L = board.listings[0];
  ok(L.tick === "prls" && L.seller === walletAddr, "wizard: listing tick+seller correct");
  ok(M.verifyListing(L, M.NETWORKS.mainnet).ok, "wizard: published listing verifies");
  ok(q(win, "#wizard-panel").textContent.includes("local board"), "wizard: done screen notes local board");
  ok(errors.length === 0, "wizard: zero window errors end-to-end :: " + errors.join(" | "));
}

/* ================= 5. portfolio: listings/bids render + cancel ================= */
{
  const { win, errors } = loadPage("portfolio.html");
  const M = win.PearlMarket;
  const seller = M.walletFromPriv(randomBytes(32).toString("hex"), M.NETWORKS.mainnet).address;
  seedSettings(win, { demo: false, indexerBase: "", blockbookBase: "https://blockbook.pearlresearch.ai", address: seller, networkId: "mainnet" });
  // seed a listing + bid directly on the board
  const fakeSig = randomBytes(64).toString("hex");
  const lotTxid = randomBytes(32).toString("hex");
  const prog = M.decodeBech32m(seller, "prl").program;
  M.boardAddListing({ v: 1, tick: "prls", amt: "50000", lotTxid, lotVout: 0, lotValue: 546,
    lotSpkHex: M.bytesToHex(M.p2trScriptPubKey(prog)), priceGrains: "2500000", seller,
    expiry: Date.now() + 86400000, created: Date.now(), sig: fakeSig });
  const bidId = M.boardAddBid({ tick: "prls", amount: "10000", maxPrice: "2000000", buyerAddress: seller, created: Date.now() });
  void bidId;
  win.location.hash = "";
  win.eval(`document.getElementById("pf-address").value = ${JSON.stringify(seller)};
            document.getElementById("pf-show").click();`);
  await flush();
  ok(errors.length === 0, "portfolio: zero window errors :: " + errors.join(" | "));
  ok(q(win, "#pf-body").textContent.includes("PRLS"), "portfolio: listing shown");
  ok(qa(win, "[data-cancel-listing]").length === 1, "portfolio: listing cancel button");
  ok(qa(win, "[data-cancel-bid]").length === 1, "portfolio: bid cancel button");
  click(win, q(win, "[data-cancel-bid]"));
  await flush();
  ok(M.loadBoard().bids.length === 0, "portfolio: bid cancel removes from board");
  click(win, q(win, "[data-cancel-listing]"));
  await flush();
  ok(M.loadBoard().listings.length === 0, "portfolio: listing cancel removes from board");
}

/* ================= 6. settings persistence ================= */
{
  const { win, errors } = loadPage("index.html");
  await flush();
  q(win, "#set-indexer").value = "https://idx.example.com";
  q(win, "#set-demo").checked = false;
  click(win, q(win, "#set-save"));
  await flush();
  const saved = JSON.parse(win.localStorage.getItem("pearl-market-settings-v1"));
  ok(saved.indexerBase === "https://idx.example.com" && saved.demo === false, "settings: saved to localStorage");
  ok(errors.length === 0, "settings: zero window errors :: " + errors.join(" | "));
}

console.log(`\nSMOKE: ${passed} passed, ${failed} failed`);
if (failures.length) { console.log("failures:"); for (const f of failures) console.log(" -", f); }
process.exit(failed ? 1 : 0);
