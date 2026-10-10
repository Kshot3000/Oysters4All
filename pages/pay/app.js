/* Pearl Pay — merchant app logic (classic script). Crypto via the
 * window.PearlPayCore bundle (pearl-pay-core.bundle.js), checkout modal + QR
 * via the global PearlPay SDK (pearl-pay.js). */
const {
  NETWORKS, parseAccountXpub, deriveInvoiceAddress, findNextUnusedIndex,
  encodeInvoice, usdToGrains, grainsToUsd, fetchPrlUsd, formatPRL, formatUSD, pearlUri,
  parsePRLToGrains,
} = window.PearlPayCore || {};
if (!window.PearlPayCore) {
  document.body.innerHTML = "<p style='padding:2rem'>Failed to load pearl-pay-core.bundle.js</p>";
  throw new Error("PearlPayCore bundle missing");
}

const $ = (id) => document.getElementById(id);
const LS_KEY = "pearl-pay-settings-v1";
const DONATION = "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d";

const settings = loadSettings();
let rate = { usd: null, at: 0, source: "none" };

function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(LS_KEY) || "{}"); } catch { s = {}; }
  return {
    network: s.network || "mainnet",
    blockbook: s.blockbook || "",
    xpub: s.xpub || "",
    index: Number.isInteger(s.index) ? s.index : 0,
    conf: Number.isInteger(s.conf) ? s.conf : 1,
    expiry: Number.isInteger(s.expiry) ? s.expiry : 60,
    rateSrc: s.rateSrc || "auto",
    rateManual: s.rateManual || "",
  };
}
function saveSettings() {
  localStorage.setItem(LS_KEY, JSON.stringify(settings));
}
function blockbookUrl() {
  return (settings.blockbook || NETWORKS[settings.network].blockbook).replace(/\/+$/, "");
}
function net() { return settings.network; }

/* ---------- settings UI ---------- */
function bindSettings() {
  $("set-network").value = settings.network;
  $("set-blockbook").value = settings.blockbook;
  $("set-blockbook").placeholder = NETWORKS[settings.network].blockbook;
  $("set-xpub").value = settings.xpub;
  $("set-index").value = settings.index;
  $("set-conf").value = settings.conf;
  $("set-expiry").value = settings.expiry;
  $("set-rate-src").value = settings.rateSrc;
  $("set-rate-manual").value = settings.rateManual;

  $("set-network").onchange = (e) => { settings.network = e.target.value; saveSettings(); refreshXpub(); $("set-blockbook").placeholder = NETWORKS[settings.network].blockbook; updateSnippet(); };
  $("set-blockbook").oninput = (e) => { settings.blockbook = e.target.value.trim(); saveSettings(); };
  $("set-xpub").oninput = (e) => { settings.xpub = e.target.value.trim(); saveSettings(); refreshXpub(); updateSnippet(); };
  $("set-index").oninput = (e) => { settings.index = Math.max(0, parseInt(e.target.value || "0", 10)); saveSettings(); updateSnippet(); };
  $("set-conf").oninput = (e) => { settings.conf = Math.max(0, parseInt(e.target.value || "0", 10)); saveSettings(); updateSnippet(); };
  $("set-expiry").oninput = (e) => { settings.expiry = Math.max(5, parseInt(e.target.value || "60", 10)); saveSettings(); };
  $("set-rate-src").onchange = (e) => { settings.rateSrc = e.target.value; saveSettings(); refreshRate(true); };
  $("set-rate-manual").oninput = (e) => { settings.rateManual = e.target.value; saveSettings(); refreshRate(true); };
  $("btn-scan").onclick = scanChain;
}

function refreshXpub() {
  const box = $("xpub-status");
  const xpub = settings.xpub.trim();
  if (!xpub) {
    box.className = "xpub-status muted";
    box.textContent = "No xpub configured — paste one to enable fresh addresses.";
    return null;
  }
  try {
    const info = parseAccountXpub(xpub, net());
    box.className = "xpub-status ok";
    box.textContent = `✓ Valid ${info.network} account xpub (depth ${info.depth}) — fresh addresses ready.` +
      (info.warnings.length ? " ⚠ " + info.warnings.join(" ") : "");
    return info;
  } catch (e) {
    box.className = "xpub-status bad";
    box.textContent = "✕ " + e.message;
    return null;
  }
}

async function scanChain() {
  const info = refreshXpub();
  if (!info) { $("scan-status").textContent = "Set a valid xpub first."; return; }
  $("scan-status").textContent = "Scanning…";
  $("btn-scan").disabled = true;
  try {
    const r = await findNextUnusedIndex(info.xpub, net(), blockbookUrl(), { gapLimit: 20 });
    settings.index = r.index;
    $("set-index").value = r.index;
    saveSettings();
    $("scan-status").textContent = `Next unused index: ${r.index} (scanned ${r.scanned}, ${r.used.length} used)`;
    updateSnippet();
  } catch (e) {
    $("scan-status").textContent = "Scan failed: " + e.message;
  }
  $("btn-scan").disabled = false;
}

/* ---------- rate ---------- */
async function refreshRate(force) {
  const meta = $("rate-meta"), val = $("rate-value");
  if (settings.rateSrc === "manual") {
    const m = parseFloat(settings.rateManual);
    if (m > 0) {
      rate = { usd: m, at: Date.now(), source: "manual" };
      val.textContent = formatUSD(m);
      meta.textContent = "manual rate";
    } else {
      val.textContent = "—";
      meta.textContent = "enter a manual rate";
    }
    updateHeroUsd();
    updateSnippet(); return;
  }
  if (!force && rate.usd && Date.now() - rate.at < 60000 && rate.source === "coingecko") return;
  meta.textContent = "fetching…";
  try {
    const r = await fetchPrlUsd();
    rate = { usd: r.usd, at: r.at, source: "coingecko" };
    val.textContent = formatUSD(r.usd);
    const chg = r.change24h != null ? ` (${r.change24h >= 0 ? "+" : ""}${r.change24h.toFixed(1)}% 24h)` : "";
    meta.textContent = `CoinGecko · ${new Date(r.at).toLocaleTimeString()}${chg}`;
  } catch (e) {
    val.textContent = rate.usd ? formatUSD(rate.usd) : "—";
    meta.textContent = "rate fetch failed — " + e.message + ". Use manual rate or try again.";
  }
  updateHeroUsd();
  updateSnippet();
}

/* ---------- hero invoice preview ---------- */
const HERO_PRL = 25;
function updateHeroUsd() {
  const el = $("hero-usd");
  if (!el) return;
  el.textContent = rate.usd
    ? `≈ ${formatUSD(HERO_PRL * rate.usd)} USD · live rate`
    : "≈ … USD";
}
function drawHeroQr() {
  const cv = $("hero-qr");
  if (!cv || !window.PearlPay) return;
  try {
    window.PearlPay.drawQrCanvas(cv, pearlUri(DONATION, String(HERO_PRL * 100_000_000)), 5);
  } catch { /* decorative preview — never fatal */ }
}

/* ---------- amounts ---------- */
function grainsFor(cur, amountStr) {
  if (cur === "USD") {
    /* Fiat has no exact grain value (usdToGrains rounds at the quoted
     * rate), but the typed amount must still be one clean decimal —
     * the old parseFloat silently accepted "10abc" and "1.2.3". */
    const t = String(amountStr).trim();
    if (!/^\d+(?:\.\d+)?$/.test(t)) throw new Error("Enter a valid USD amount.");
    const a = Number(t);
    if (!isFinite(a) || a <= 0) throw new Error("Enter an amount greater than zero.");
    if (!rate.usd) throw new Error("No USD rate available — refresh the rate or set a manual one.");
    return { grains: usdToGrains(a, rate.usd), usdNote: formatUSD(a) };
  }
  /* Exact parser (core): the old parseFloat+Math.round silently
   * truncated "1.2.3", accepted "10abc", and rounded sub-grain amounts
   * instead of rejecting them — the result is baked into invoices and
   * payment buttons, so a misparse charges the wrong amount. */
  /* A negative amount is well-formed input with a bad value, not a
   * parse failure: refuse it with the same message as zero (and as the
   * USD branch above) instead of leaking the parser's raw error. */
  if (/^-(?:\d|\.\d)/.test(String(amountStr).trim())) throw new Error("Enter an amount greater than zero.");
  const grains = parsePRLToGrains(amountStr);
  if (grains <= 0) throw new Error("Enter an amount greater than zero.");
  const usdNote = rate.usd ? "≈ " + formatUSD(grainsToUsd(String(grains), rate.usd)) : "";
  return { grains: String(grains), usdNote };
}

function currentAddress() {
  const info = refreshXpub();
  if (!info) throw new Error("Set a valid account xpub in Settings first.");
  return deriveInvoiceAddress(info.xpub, settings.index, net());
}

/* ---------- button generator ---------- */
function bindGenerator() {
  for (const id of ["gen-cur", "gen-amount", "gen-label"]) {
    $("" + id).addEventListener("input", updateSnippet);
  }
  $("btn-preview").onclick = () => openPreview(false);
  $("btn-demo").onclick = () => openPreview(true);
  $("btn-copy-snippet").onclick = async () => {
    await navigator.clipboard.writeText($("gen-snippet").value).catch(() => {});
    $("snippet-meta").textContent = "Copied ✓";
    setTimeout(() => ($("snippet-meta").textContent = ""), 1500);
  };
  updateSnippet();
}

function snippetFor(address, grains, label, usdNote) {
  const sdkUrl = new URL("pearl-pay.js", location.href).href;
  return `<!-- Pearl Pay button — generated ${new Date().toISOString().slice(0, 10)} -->
<!-- SECURITY: this snippet embeds ONE invoice address. For production, -->
<!-- generate a FRESH address per order (server-side from your xpub).   -->
<script src="${sdkUrl}"><\/script>
<div id="pearl-pay-btn"></div>
<script>
PearlPay.createButton("#pearl-pay-btn", {
  address: "${address}",
  grains: "${grains}",           // ${formatPRL(grains)} PRL${usdNote ? " (" + usdNote + ")" : ""}
  label: ${JSON.stringify(label)},
  blockbook: "${blockbookUrl()}",
  expiryMinutes: ${settings.expiry},
  requiredConfirmations: ${settings.conf},
  onState: function (state, detail) {
    console.log("[pearl-pay]", state, detail);
    // TODO: notify your server when state === "confirmed"
  },
});
<\/script>`;
}

function updateSnippet() {
  const box = $("gen-snippet"), meta = $("snippet-meta");
  try {
    const { grains, usdNote } = grainsFor($("gen-cur").value, $("gen-amount").value);
    const address = currentAddress();
    const label = $("gen-label").value || "Payment";
    box.value = snippetFor(address, grains, label, usdNote);
    meta.textContent = `Address index ${settings.index} · ${formatPRL(grains)} PRL → ${address.slice(0, 18)}…`;
  } catch (e) {
    box.value = "";
    meta.textContent = e.message;
  }
}

function openPreview(demo) {
  try {
    const { grains, usdNote } = grainsFor($("gen-cur").value, $("gen-amount").value);
    const label = $("gen-label").value || "Payment";
    const host = $("gen-preview");
    host.innerHTML = "";
    if (demo) {
      demoCheckout(host, grains, label, usdNote);
      return;
    }
    const address = currentAddress();
    window.PearlPay.createButton(host, {
      address, grains, label,
      blockbook: blockbookUrl(),
      expiryMs: Date.now() + settings.expiry * 60_000,
      requiredConfirmations: settings.conf,
      usdNote,
      onState: (s, d) => console.log("[preview]", s, d),
    });
  } catch (e) {
    alert(e.message);
  }
}

/* ---------- demo mode: simulated state progression, no chain ---------- */
function demoCheckout(host, grains, label, usdNote) {
  const overlay = document.createElement("div");
  overlay.className = "pp-overlay";
  overlay.innerHTML = `
    <div class="pp-modal">
      <div class="pp-head"><div>
        <div class="pp-title"></div>
        <div class="pp-amount">${formatPRL(grains)} PRL <span class="pp-usd">${usdNote || ""}</span></div>
        <div class="pp-usd">DEMO MODE — no real payment</div>
      </div><button class="pp-close" aria-label="Close">✕</button></div>
      <div class="pp-qr"></div>
      <div class="pp-addr-row"><code class="pp-addr">demo1q… (no real address)</code></div>
      <div class="pp-status pp-awaiting"><strong>Awaiting payment</strong><span>Simulating…</span></div>
      <div class="pp-note">Watch the states progress: awaiting → partial → detected → confirmed.</div>
    </div>`;
  overlay.querySelector(".pp-title").textContent = label;
  const qrWrap = overlay.querySelector(".pp-qr");
  const canvas = document.createElement("canvas");
  qrWrap.appendChild(canvas);
  window.PearlPay.drawQrCanvas(canvas, "pearl:demo?amount=" + formatPRL(grains), 5);
  const status = overlay.querySelector(".pp-status");
  const close = () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); overlay.remove(); };
  overlay.querySelector(".pp-close").onclick = close;
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  document.body.appendChild(overlay);
  const set = (cls, title, sub) => {
    status.className = "pp-status " + cls;
    status.innerHTML = `<strong></strong><span></span>`;
    status.querySelector("strong").textContent = title;
    status.querySelector("span").textContent = sub;
  };
  const t1 = setTimeout(() => set("pp-partial", "Partial payment detected", "0.4 PRL arrived — waiting for the rest…"), 2500);
  const t2 = setTimeout(() => set("pp-detected", "Payment detected", "Full amount seen on the network (0-conf)…"), 5000);
  const t3 = setTimeout(() => set("pp-confirmed", "Payment confirmed", "Demo complete — this is what your customers will see."), 8000);
}

/* ---------- invoice creator ---------- */
function bindInvoices() {
  $("btn-invoice").onclick = createInvoice;
  $("btn-copy-link").onclick = async () => {
    await navigator.clipboard.writeText($("invoice-link").value).catch(() => {});
  };
  $("btn-copy-addr").onclick = async () => {
    await navigator.clipboard.writeText($("invoice-addr").textContent).catch(() => {});
    $("btn-copy-addr").textContent = "Copied ✓";
    setTimeout(() => ($("btn-copy-addr").textContent = "Copy"), 1500);
  };
}

function createInvoice() {
  const meta = $("invoice-meta");
  try {
    const { grains, usdNote } = grainsFor($("inv-cur").value, $("inv-amount").value);
    const label = $("inv-label").value || "Invoice";
    const address = currentAddress();
    const exp = Math.floor(Date.now() / 1000) + settings.expiry * 60;
    const code = encodeInvoice({
      net: net(), grains, label, xpub: settings.xpub.trim(), idx: settings.index,
      exp, conf: settings.conf,
    });
    const link = new URL("invoice.html", location.href).href.split("?")[0] + "?inv=" + code;
    $("invoice-out").hidden = false;
    $("invoice-addr").textContent = address;
    $("invoice-amount").textContent = formatPRL(grains) + " PRL";
    $("invoice-usd").textContent = usdNote || "";
    $("invoice-idx").textContent = `Address index ${settings.index} · expires in ${settings.expiry} min · needs ${settings.conf} confirmation(s)`;
    $("invoice-link").value = link;
    $("btn-open-invoice").href = link;
    // QR encodes the payment URI (short) — wallets scan it to pay.
    // The full shareable invoice link stays in the field above.
    window.PearlPay.drawQrCanvas($("invoice-qr"), pearlUri(address, grains), 5);
    meta.textContent = "Invoice created ✓";
    // advance the index so the next invoice uses a fresh address
    settings.index += 1;
    $("set-index").value = settings.index;
    saveSettings();
    updateSnippet();
  } catch (e) {
    meta.textContent = e.message;
  }
}

/* ---------- conn badge ---------- */
async function checkConn() {
  const badge = $("conn");
  try {
    const r = await fetch(blockbookUrl() + "/api/v2/api", { cache: "no-store" });
    if (!r.ok) throw new Error("http " + r.status);
    const j = await r.json();
    badge.textContent = `connected · block ${j.blockbook?.bestHeight ?? "?"}`;
    badge.classList.add("ok");
  } catch {
    badge.textContent = "backend unreachable";
    badge.classList.remove("ok");
  }
}

/* ---------- chrome: nav toggle + donation copy ---------- */
function bindChrome() {
  const toggle = document.querySelector(".nav-toggle");
  const links = document.querySelector(".nav-links");
  if (toggle && links) {
    toggle.addEventListener("click", () => {
      const open = links.classList.toggle("open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      toggle.textContent = open ? "✕" : "☰";
    });
  }
  const copyBtn = $("copy-donate");
  if (copyBtn) {
    copyBtn.onclick = async () => {
      await navigator.clipboard.writeText(DONATION).catch(() => {});
      copyBtn.textContent = "Copied ✓";
      setTimeout(() => (copyBtn.textContent = "Copy"), 1500);
    };
  }
}

/* ---------- init ---------- */
bindChrome();
drawHeroQr();
bindSettings();
refreshXpub();
bindGenerator();
bindInvoices();
refreshRate(true);
checkConn();
$("rate-refresh").onclick = () => refreshRate(true);
setInterval(() => refreshRate(false), 120000);
setInterval(checkConn, 60000);
console.log(`Pearl Pay app ready. Donations: ${DONATION}`);
