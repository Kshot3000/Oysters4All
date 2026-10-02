/* Pearl Wallet — app controller.
   Classic script. Uses window.PearlWallet (esbuild IIFE bundle of the audited
   crypto core) and the global qrcode() (qrcode-generator). No modules, no build step, works from
   file:// and GitHub Pages.

   Security model:
   - The mnemonic lives ONLY in JS memory while unlocked (session.mnemonic).
   - localStorage holds ONLY the AES-256-GCM encrypted vault (600k PBKDF2).
   - Auto-lock wipes session keys; lock-on-hidden wipes them too.
   - No telemetry, no analytics, no third-party requests except the user's
     own configured endpoints (Blockbook, Pearlscriptions, CoinGecko).
*/
(function () {
"use strict";
var W = window.PearlWallet;
if (!W) {
  document.body.innerHTML = "<p style='padding:40px;font-family:sans-serif'>Pearl Wallet failed to load its crypto core (pearl-wallet.bundle.js missing).</p>";
  return;
}

/* ---------------- tiny dom utils ---------------- */
function $(id) { return document.getElementById(id); }
function el(tag, cls, text) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function shortAddr(a) { return a.length > 20 ? a.slice(0, 12) + "…" + a.slice(-8) : a; }

var toastTimer = null;
function toast(msg) {
  var t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { t.classList.remove("show"); }, 2600);
}

/* ---------------- storage ---------------- */
var LS_SETTINGS = "pearl-wallet:settings:v1";
var LS_VAULT = "pearl-wallet:vault:v1";
var LS_META = "pearl-wallet:meta:v1";

var DEFAULTS = {
  network: "mainnet",
  blockbook: "https://blockbook.pearlresearch.ai",
  testnetBlockbook: "",
  pearlscriptions: "",
  fiat: "USD",
  lockMinutes: 5,
};

function loadSettings() {
  try {
    var s = JSON.parse(localStorage.getItem(LS_SETTINGS) || "{}");
    var out = {};
    for (var k in DEFAULTS) out[k] = (s[k] !== undefined) ? s[k] : DEFAULTS[k];
    return out;
  } catch (e) { return Object.assign({}, DEFAULTS); }
}
function saveSettings(s) { localStorage.setItem(LS_SETTINGS, JSON.stringify(s)); }
function loadMeta() {
  try { return Object.assign({ recvIndex: 0, changeIndex: 0 }, JSON.parse(localStorage.getItem(LS_META) || "{}")); }
  catch (e) { return { recvIndex: 0, changeIndex: 0 }; }
}
function saveMeta(m) { localStorage.setItem(LS_META, JSON.stringify({ recvIndex: m.recvIndex, changeIndex: m.changeIndex })); }

var settings = loadSettings();
var meta = loadMeta();

function net() { return W.NETWORKS[settings.network] || W.NETWORKS.mainnet; }
function blockbookBase() {
  var b = settings.network === "testnet" ? settings.testnetBlockbook : settings.blockbook;
  return (b || "").replace(/\/+$/, "");
}

/* ---------------- session (MEMORY ONLY) ---------------- */
var session = {
  mnemonic: null,     // string — wiped on lock
  passphrase: "",     // BIP-39 passphrase — wiped on lock
  keys: new Map(),    // address -> {index, chain, priv, internalXOnly, tweakedX}
  utxos: [],          // [{txid, vout, value, address}]
  balances: { confirmed: 0, pending: 0 },
  txs: [],            // normalized activity
  tokens: [],         // [{ticker, balance, ...}]
  price: null,        // {usd-like per fiat, change24h}
  feeRates: null,     // {slow, normal, fast} grains/vbyte
  addrs: [],          // watched [{address, index, chain}]
};
function wipeSession() {
  if (session.mnemonic) {
    // best-effort: overwrite is not guaranteed for JS strings, but we drop
    // every reference so GC can collect; keys are Uint8Arrays we zero.
    session.mnemonic = null;
  }
  session.passphrase = "";
  session.keys.forEach(function (k) {
    try { k.priv.fill(0); k.internalXOnly.fill(0); } catch (e) {}
  });
  session.keys.clear();
  session.utxos = [];
  session.txs = [];
  session.tokens = [];
  session.addrs = [];
}

/* ---------------- views & tabs ---------------- */
function showView(name) {
  ["onboarding", "lock", "app"].forEach(function (v) {
    $("view-" + v).classList.toggle("active", v === name);
  });
  window.scrollTo(0, 0);
}
/* Skip link: <main> lives inside #view-app, so while onboarding or lock is
   the visible view the anchor target is display:none and the jump would land
   nowhere. In that state, land focus on the visible view instead. */
var skipLink = document.querySelector(".skip-link");
if (skipLink) {
  skipLink.addEventListener("click", function (e) {
    if ($("view-app").classList.contains("active")) return; /* normal jump to <main> */
    var current = document.querySelector(".view.active");
    if (current) {
      e.preventDefault();
      current.focus();
      try { history.replaceState(null, "", "#" + current.id); } catch (err) {}
    }
  });
}
function showTab(name) {
  document.querySelectorAll(".tab").forEach(function (t) {
    t.classList.toggle("active", t.dataset.tab === name);
  });
  document.querySelectorAll(".tabpage").forEach(function (p) {
    p.classList.toggle("active", p.id === "tab-" + name);
  });
  if (name === "activity") renderActivity();
  if (name === "receive") renderReceive();
  if (name === "home") { /* refreshed on show */ }
}
document.querySelectorAll(".tab").forEach(function (t) {
  t.addEventListener("click", function () { showTab(t.dataset.tab); poke(); });
});
$("btn-settings").addEventListener("click", function () { showTab("settings"); poke(); });
$("qa-send").addEventListener("click", function () { showTab("send"); });
$("qa-receive").addEventListener("click", function () { showTab("receive"); });

/* ---------------- bottom sheet ---------------- */
function openSheet(html) {
  $("sheet-body").innerHTML = html;
  $("scrim").classList.add("open");
}
function closeSheet() { $("scrim").classList.remove("open"); }
$("scrim").addEventListener("click", function (e) {
  if (e.target === $("scrim")) closeSheet();
});

/* ---------------- auto-lock ---------------- */
var lockTimer = null;
function armLock() {
  clearTimeout(lockTimer);
  if (!session.mnemonic) return;
  lockTimer = setTimeout(function () { lock("Auto-locked after " + settings.lockMinutes + "m idle"); }, settings.lockMinutes * 60 * 1000);
}
function poke() { armLock(); }
["pointerdown", "keydown", "touchstart"].forEach(function (ev) {
  document.addEventListener(ev, poke, { passive: true });
});
document.addEventListener("visibilitychange", function () {
  if (document.hidden && session.mnemonic) lock("Locked when app was hidden");
});

function lock(reason) {
  clearTimeout(lockTimer);
  wipeSession();
  $("lock-pw").value = "";
  $("lock-err").textContent = "";
  showView("lock");
  if (reason) toast(reason);
}

/* ================================================================
   ONBOARDING
   ================================================================ */
var ob = { words: 12, mnemonic: "", importKind: null, quizOrder: [], quizPos: 0 };

function obShow(id) {
  document.querySelectorAll(".obstep").forEach(function (s) { s.classList.add("hidden"); });
  $(id).classList.remove("hidden");
  window.scrollTo(0, 0);
}
document.querySelectorAll(".ob-back").forEach(function (b) {
  b.addEventListener("click", function () { obShow("ob-welcome"); });
});

$("btn-new").addEventListener("click", function () { obShow("ob-length"); });
$("btn-import").addEventListener("click", function () {
  $("import-secret").value = "";
  $("import-passphrase").value = "";
  $("import-err").textContent = "";
  obShow("ob-import");
});
document.querySelectorAll("[data-words]").forEach(function (b) {
  b.addEventListener("click", function () {
    ob.words = parseInt(b.dataset.words, 10);
    try {
      ob.mnemonic = W.newMnemonic(ob.words === 24 ? 256 : 128);
    } catch (e) { toast("Couldn't generate phrase: " + e.message); return; }
    renderSeed();
    obShow("ob-seed");
  });
});

function renderSeed() {
  var g = $("seed-grid");
  g.innerHTML = "";
  ob.mnemonic.split(" ").forEach(function (w, i) {
    var d = el("div", "w");
    d.style.animationDelay = (i * 22) + "ms";
    d.innerHTML = "<b>" + (i + 1) + "</b>" + esc(w);
    g.appendChild(d);
  });
}
$("btn-copy-seed").addEventListener("click", function () {
  copyText(ob.mnemonic).then(function () { toast("Copied — store it offline, then clear your clipboard"); });
});
$("btn-seed-done").addEventListener("click", function () { startQuiz(); });

/* quiz: 3 checkpoints, each "tap word #N" from 4 options drawn from the phrase */
function startQuiz() {
  var words = ob.mnemonic.split(" ");
  var idxs = [];
  while (idxs.length < 3) {
    var i = Math.floor(Math.random() * words.length);
    if (idxs.indexOf(i) < 0) idxs.push(i);
  }
  ob.quizOrder = idxs;
  ob.quizPos = 0;
  renderQuizStep();
  obShow("ob-quiz");
}
function renderQuizStep() {
  var words = ob.mnemonic.split(" ");
  var pos = ob.quizOrder[ob.quizPos];
  $("quiz-prompt").textContent = "Tap word #" + (pos + 1) + " (" + (ob.quizPos + 1) + " of 3)";
  $("quiz-err").textContent = "";
  // slots show progress
  var slots = $("quiz-slots");
  slots.innerHTML = "";
  ob.quizOrder.forEach(function (q, k) {
    var d = el("div", "w" + (k < ob.quizPos ? " picked" : ""));
    d.innerHTML = "<b>" + (q + 1) + "</b>" + (k < ob.quizPos ? esc(words[q]) : "···");
    slots.appendChild(d);
  });
  // bank: correct + 3 decoys from elsewhere in the phrase, shuffled
  var opts = [words[pos]];
  var pool = words.filter(function (w, i) { return i !== pos; });
  while (opts.length < 4 && pool.length) {
    var j = Math.floor(Math.random() * pool.length);
    var w = pool.splice(j, 1)[0];
    if (opts.indexOf(w) < 0) opts.push(w);
  }
  // (tiny phrase edge: pad from start if needed — can't happen with 12/24)
  opts.sort(function () { return Math.random() - 0.5; });
  var bank = $("quiz-bank");
  bank.innerHTML = "";
  opts.forEach(function (w) {
    var b = el("button", null, w);
    b.addEventListener("click", function () {
      if (w === words[pos]) {
        ob.quizPos++;
        if (ob.quizPos >= ob.quizOrder.length) {
          obShow("ob-password");
          $("pw1").value = ""; $("pw2").value = ""; $("pw-err").textContent = "";
        } else renderQuizStep();
      } else {
        b.classList.add("used");
        $("quiz-err").textContent = "That's not word #" + (pos + 1) + " — try again.";
      }
    });
    bank.appendChild(b);
  });
}

/* import */
$("btn-import-continue").addEventListener("click", function () {
  var secret = $("import-secret").value.trim();
  var err = $("import-err");
  err.textContent = "";
  if (!secret) { err.textContent = "Paste your recovery phrase or WIF key."; return; }
  var n = net();
  var words = secret.split(/\s+/);
  if (words.length === 12 || words.length === 24) {
    try {
      var norm = W.normalizeMnemonic(secret);
      if (!W.isValidMnemonic(norm)) throw new Error("bad checksum");
      // sanity: derive first address so a typo'd phrase fails now, not later
      W.walletFromMnemonic(norm, n, { passphrase: $("import-passphrase").value });
      ob.mnemonic = norm;
      ob.importKind = "mnemonic";
    } catch (e) { err.textContent = "Invalid recovery phrase: " + e.message; return; }
  } else if (/^[5KLc9][1-9A-HJ-NP-Za-km-z]{50,51}$/.test(secret.replace(/\s+/g, ""))) {
    try {
      var wif = secret.replace(/\s+/g, "");
      W.walletFromWIF(wif, n); // validates network + checksum
      ob.mnemonic = "wif:" + wif;
      ob.importKind = "wif";
    } catch (e) { err.textContent = "Invalid WIF key: " + e.message; return; }
  } else {
    err.textContent = "Unrecognized — enter 12/24 words or a WIF private key.";
    return;
  }
  obShow("ob-password");
  $("pw1").value = ""; $("pw2").value = ""; $("pw-err").textContent = "";
  $("btn-finish").textContent = "Import my wallet";
});

/* password -> seal vault */
$("btn-finish").addEventListener("click", async function () {
  var p1 = $("pw1").value, p2 = $("pw2").value;
  var err = $("pw-err");
  err.textContent = "";
  if (p1.length < 8) { err.textContent = "Password must be at least 8 characters."; return; }
  if (p1 !== p2) { err.textContent = "Passwords don't match."; return; }
  var btn = $("btn-finish");
  btn.disabled = true;
  btn.textContent = "Encrypting…";
  try {
    var secret = ob.mnemonic;
    if (ob.importKind === "wif") {
      // Convert WIF -> mnemonic-less session: store wif: payload in the vault.
      // (Session derives the single key directly; no HD chain.)
    }
    var vault = await W.vaultSeal(secret, p1);
    vault.k = ob.importKind || "mnemonic";
    if (ob.importKind === "mnemonic") vault.pp = !!$("import-passphrase").value;
    localStorage.setItem(LS_VAULT, JSON.stringify(vault));
    // stash the BIP-39 passphrase for this session only (memory)
    var pp = (ob.importKind === "mnemonic") ? $("import-passphrase").value : "";
    meta = { recvIndex: 0, changeIndex: 0 };
    saveMeta(meta);
    startSession(secret, pp);
    toast(ob.importKind === "wif" ? "Wallet imported" : "Wallet created — keep your phrase safe");
  } catch (e) {
    err.textContent = "Couldn't encrypt: " + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = ob.importKind === "wif" ? "Import my wallet" : "Create my wallet";
  }
});

/* ---------------- unlock ---------------- */
$("btn-unlock").addEventListener("click", doUnlock);
$("lock-pw").addEventListener("keydown", function (e) { if (e.key === "Enter") doUnlock(); });
async function doUnlock() {
  var pw = $("lock-pw").value;
  var err = $("lock-err");
  err.textContent = "";
  if (!pw) { err.textContent = "Enter your password."; return; }
  var btn = $("btn-unlock");
  btn.disabled = true; btn.textContent = "Unlocking…";
  try {
    var vault = JSON.parse(localStorage.getItem(LS_VAULT) || "null");
    if (!vault) throw new Error("no vault on this device");
    var secret = await W.vaultUnseal(vault, pw);
    var pp = "";
    // passphrase was verified at import; ask each unlock? No — v1 keeps it simple:
    // if the vault was created with a passphrase, prompt for it now.
    if (vault.pp) {
      pp = prompt("This wallet uses a BIP-39 passphrase. Enter it (empty if none):") || "";
    }
    if ((vault.k || "mnemonic") === "wif") {
      startSession(secret, ""); // secret is "wif:..."
    } else {
      // verify passphrase by deriving (wrong passphrase = different wallet, no error —
      // so we just accept it; the balance will reveal a mistake)
      startSession(secret, pp || "");
    }
    toast("Vault unlocked");
  } catch (e) {
    err.textContent = "Wrong password — try again.";
  } finally {
    btn.disabled = false; btn.textContent = "Unlock";
  }
}
$("btn-lock-wipe").addEventListener("click", function () {
  if (confirm("Wipe this device and re-import from your recovery phrase or backup?")) {
    localStorage.removeItem(LS_VAULT);
    localStorage.removeItem(LS_META);
    location.reload();
  }
});

/* ---------------- session start ---------------- */
function startSession(secret, passphrase) {
  wipeSession();
  session.mnemonic = secret; // "wif:..." or mnemonic words
  session.passphrase = passphrase || "";
  showView("app");
  showTab("home");
  syncSettingsUI();
  renderReceive(); // derive first address immediately
  armLock();
  refreshAll(true);
}

function copyText(t) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(t).catch(function () { fallbackCopy(t); });
  }
  return Promise.resolve(fallbackCopy(t));
}
function fallbackCopy(t) {
  var ta = document.createElement("textarea");
  ta.value = t; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.select();
  try { document.execCommand("copy"); } catch (e) {}
  document.body.removeChild(ta);
}

/* ================================================================
   KEYS + SYNC
   ================================================================ */
var GAP = 20;

function isWifSession() { return !!session.mnemonic && session.mnemonic.indexOf("wif:") === 0; }

function keyFor(index, chain) {
  var n = net();
  if (isWifSession()) {
    if (index !== 0 || chain !== 0) throw new Error("single-key wallet");
    return W.walletFromWIF(session.mnemonic.slice(4), n);
  }
  return W.walletFromMnemonic(session.mnemonic, n, { index: index, chain: chain, passphrase: session.passphrase });
}

function deriveWatched() {
  var list = [];
  if (isWifSession()) {
    var w = keyFor(0, 0);
    list.push({ address: w.address, index: 0, chain: 0 });
    session.keys.set(w.address, { index: 0, chain: 0, priv: w.priv, internalXOnly: w.internalXOnly, tweakedX: w.tweakedX });
    return list;
  }
  var n = net();
  var i, k;
  for (i = 0; i < meta.recvIndex + GAP; i++) {
    k = W.walletFromMnemonic(session.mnemonic, n, { index: i, chain: 0, passphrase: session.passphrase });
    list.push({ address: k.address, index: i, chain: 0 });
    session.keys.set(k.address, { index: i, chain: 0, priv: k.priv, internalXOnly: k.internalXOnly, tweakedX: k.tweakedX });
  }
  for (i = 0; i < meta.changeIndex + GAP; i++) {
    k = W.walletFromMnemonic(session.mnemonic, n, { index: i, chain: 1, passphrase: session.passphrase });
    list.push({ address: k.address, index: i, chain: 1 });
    session.keys.set(k.address, { index: i, chain: 1, priv: k.priv, internalXOnly: k.internalXOnly, tweakedX: k.tweakedX });
  }
  return list;
}

function setNetStatus(mode, label) {
  var dot = $("net-dot");
  dot.className = "dot" + (mode === "on" ? "" : mode === "warn" ? " warn" : " off");
  $("net-label").textContent = label;
}

async function mapPool(items, n, fn) {
  var out = new Array(items.length);
  var i = 0;
  async function worker() {
    while (i < items.length) {
      var j = i++;
      try { out[j] = await fn(items[j], j); } catch (e) { out[j] = null; }
    }
  }
  var ws = [];
  for (var k = 0; k < Math.min(n, items.length); k++) ws.push(worker());
  await Promise.all(ws);
  return out;
}

var syncing = false;
var lastSync = 0;

async function refreshAll(showSpin) {
  if (!session.mnemonic || syncing) return;
  syncing = true;
  var base = blockbookBase();
  try {
    if (showSpin) { $("bal-prl").textContent = "…"; }
    setNetStatus("warn", "syncing…");
    var t0 = Date.now();
    var watched = deriveWatched();
    session.addrs = watched;
    var mine = {};
    watched.forEach(function (a) { mine[a.address] = a; });

    var confirmed = 0, pending = 0, utxos = [], txById = {};
    if (base) {
      // 1) address info (bbGetAddress includes ?details=txs)
      var infos = await mapPool(watched, 8, function (a) { return W.bbGetAddress(base, a.address); });
      var fundedAddrs = [];
      infos.forEach(function (info, idx) {
        if (!info) return;
        var b = 0, u = 0;
        try { b = BigInt(info.balance || 0); } catch (e) {}
        try { u = BigInt(info.unconfirmedBalance || 0); } catch (e) {}
        if (b > 0n) { confirmed += Number(b); fundedAddrs.push(watched[idx].address); }
        pending += Number(u);
        var txList = Array.isArray(info.txs) ? info.txs : [];
        txList.forEach(function (tx) {
          if (tx && tx.txid && !txById[tx.txid]) txById[tx.txid] = tx;
        });
      });
      // 2) UTXOs for funded addresses (confirmed spendables)
      var utxoLists = await mapPool(fundedAddrs, 8, function (addr) {
        return W.bbGetUtxos(base, addr).then(function (list) {
          return list.map(function (u) { u.address = addr; return u; });
        });
      });
      utxoLists.forEach(function (l) { if (l) utxos = utxos.concat(l); });
      // keep only confirmed utxos for coin selection sanity
      utxos = utxos.filter(function (u) { return (u.confirmations || 0) > 0; });
      setNetStatus("on", "Blockbook · live");
    } else {
      setNetStatus("off", settings.network === "testnet" ? "testnet endpoint missing" : "no endpoint");
    }

    session.balances = { confirmed: confirmed, pending: pending };
    session.utxos = utxos;
    session.txs = normalizeTxs(txById, mine);
    lastSync = Date.now();

    // 3) fee rates (fast=1, normal=6, slow=144 blocks) — best effort
    if (base) {
      try {
        var r = await Promise.all([
          W.bbEstimateFeeRate(base, 1).catch(function () { return 0; }),
          W.bbEstimateFeeRate(base, 6).catch(function () { return 0; }),
          W.bbEstimateFeeRate(base, 144).catch(function () { return 0; }),
        ]);
        session.feeRates = {
          fast: Math.max(2, Math.ceil(r[0] || 15)),
          normal: Math.max(1, Math.ceil(r[1] || 5)),
          slow: Math.max(1, Math.ceil(r[2] || 2)),
        };
      } catch (e) { session.feeRates = { fast: 15, normal: 5, slow: 2 }; }
    } else {
      session.feeRates = { fast: 15, normal: 5, slow: 2 };
    }

    renderHome();
    renderSendFees();
    if ($("tab-activity").classList.contains("active")) renderActivity();
    if (!base) toast("Set a Blockbook URL in Settings to sync");
  } catch (e) {
    setNetStatus("off", "sync failed");
    toast("Sync failed: " + e.message);
  } finally {
    syncing = false;
  }
  // 4) price + tokens (non-blocking, best effort)
  refreshPrice();
  refreshTokens();
}

function normalizeTxs(txById, mine) {
  var out = [];
  Object.keys(txById).forEach(function (txid) {
    var tx = txById[txid];
    var received = 0n, sent = 0n;
    (tx.vout || []).forEach(function (o) {
      var addrs = o.addresses || (o.scriptPubKey && o.scriptPubKey.addresses) || [];
      if (addrs.some(function (a) { return mine[a]; })) {
        try { received += BigInt(o.value || 0); } catch (e) {}
      }
    });
    (tx.vin || []).forEach(function (vin) {
      var addrs = vin.addresses || [];
      if (addrs.some(function (a) { return mine[a]; })) {
        try { sent += BigInt(vin.value || 0); } catch (e) {}
      }
    });
    var netv = received - sent;
    var conf = Number(tx.confirmations != null ? tx.confirmations : 0);
    out.push({
      txid: txid,
      net: Number(netv),
      received: Number(received),
      sent: Number(sent),
      fee: (function () { try { return Number(BigInt(tx.fees || 0)); } catch (e) { return 0; } })(),
      confirmations: conf,
      pending: conf < 1,
      time: Number(tx.blockTime || tx.time || 0),
      height: Number(tx.blockHeight || -1),
    });
  });
  out.sort(function (a, b) {
    if (a.pending !== b.pending) return a.pending ? -1 : 1;
    return (b.time || b.height) - (a.time || a.height);
  });
  return out.slice(0, 60);
}

/* ---------------- price ---------------- */
var priceTimer = null;
async function refreshPrice() {
  try {
    var p = await W.fetchPrlUsd();
    session.price = p;
  } catch (e) { /* keep last */ }
  renderPriceBits();
}
function renderPriceBits() {
  var chip = $("price-chip");
  if (session.price && session.price.usd) {
    chip.textContent = "PRL " + W.fmtFiat(session.price.usd, 100000000, settings.fiat).replace(/\.00$/, "");
  } else {
    chip.textContent = "PRL —";
  }
  var f = $("bal-fiat");
  if (f) {
    if (session.price && session.price.usd) {
      f.textContent = "≈ " + W.fmtFiat(session.price.usd, session.balances.confirmed + Math.max(0, session.balances.pending), settings.fiat);
    } else f.textContent = "≈ —";
  }
  var sf = $("send-fiat");
  if (sf && $("tab-send").classList.contains("active")) updateSendFiat();
}

/* ---------------- tokens ---------------- */
async function refreshTokens() {
  var box = $("token-list");
  var idx = (settings.pearlscriptions || "").replace(/\/+$/, "");
  if (!idx) {
    box.innerHTML = '<div class="empty"><div class="big">◌</div>No indexer configured.<br><span class="tiny">Set a Pearlscriptions URL in Settings to see PRL-20 balances.</span></div>';
    $("tokens-src").textContent = "indexer: off";
    return;
  }
  $("tokens-src").textContent = "indexer: syncing…";
  try {
    var addrs = session.addrs.filter(function (a) { return a.chain === 0; }).slice(0, 12);
    var lists = await mapPool(addrs, 4, function (a) { return W.idxGetBalances(idx, a.address); });
    var agg = {};
    lists.forEach(function (j) {
      if (!j || !j.tokens) return;
      Object.keys(j.tokens).forEach(function (tick) {
        var v = Number(j.tokens[tick] || 0);
        if (v > 0) agg[tick] = (agg[tick] || 0) + v;
      });
    });
    var ticks = Object.keys(agg).sort();
    session.tokens = ticks.map(function (t) { return { ticker: t, balance: agg[t] }; });
    if (!ticks.length) {
      box.innerHTML = '<div class="empty"><div class="big">◌</div>No PRL-20 tokens on your addresses.</div>';
    } else {
      box.innerHTML = "";
      ticks.forEach(function (t) {
        var row = el("div", "token");
        row.innerHTML = '<div class="t-ic">' + esc(t.slice(0, 2).toUpperCase()) + '</div>' +
          '<div><div class="t-name">' + esc(t) + '</div><div class="t-sub">PRL-20</div></div>' +
          '<div class="t-bal">' + esc(agg[t].toLocaleString("en-US")) + '<small>' + esc(t) + '</small></div>';
        box.appendChild(row);
      });
    }
    $("tokens-src").textContent = "indexer: live";
  } catch (e) {
    $("tokens-src").textContent = "indexer: unreachable";
    box.innerHTML = '<div class="empty"><div class="big">⚠</div>Indexer unreachable.<br><span class="tiny">' + esc(e.message) + '</span></div>';
  }
}

/* ---------------- home ---------------- */
function renderHome() {
  var c = session.balances.confirmed, p = session.balances.pending;
  $("bal-prl").textContent = W.fmtPRL(c);
  var pend = $("bal-pend");
  if (p > 0) { pend.innerHTML = '· <span class="pend">+' + esc(W.fmtPRL(p)) + ' pending</span>'; }
  else if (p < 0) { pend.innerHTML = '· <span class="pend">' + esc(W.fmtPRL(p)) + ' outgoing</span>'; }
  else pend.textContent = "";
  renderPriceBits();
  $("stat-addrs").textContent = session.addrs.length;
  $("stat-lock").textContent = settings.lockMinutes + " min";
  $("stat-net").textContent = settings.network === "testnet" ? "Testnet" : "Mainnet";
  var pill = $("net-pill");
  pill.textContent = settings.network === "testnet" ? "Testnet" : "Mainnet";
  pill.classList.toggle("testnet", settings.network === "testnet");
}

$("btn-refresh").addEventListener("click", function () { poke(); refreshAll(true); toast("Syncing…"); });

/* pull-to-refresh on Home */
(function () {
  var startY = 0, pulling = false, dist = 0;
  var page = $("tab-home");
  page.addEventListener("touchstart", function (e) {
    if (window.scrollY === 0 && !syncing) { startY = e.touches[0].clientY; pulling = true; dist = 0; }
  }, { passive: true });
  page.addEventListener("touchmove", function (e) {
    if (!pulling) return;
    dist = e.touches[0].clientY - startY;
    if (dist > 0 && window.scrollY === 0) {
      page.style.transform = "translateY(" + Math.min(dist * 0.4, 70) + "px)";
      if (dist > 110) { page.style.transform = ""; pulling = false; refreshAll(true); toast("Syncing…"); }
    } else { page.style.transform = ""; pulling = false; }
  }, { passive: true });
  page.addEventListener("touchend", function () {
    if (pulling) { page.style.transform = ""; pulling = false; }
  });
})();

/* ================================================================
   SEND
   ================================================================ */
var feeChoice = "normal";
function feeRate() {
  var r = session.feeRates || { slow: 2, normal: 5, fast: 15 };
  return r[feeChoice] || r.normal;
}
document.querySelectorAll("#fee-seg .feeopt").forEach(function (o) {
  o.addEventListener("click", function () {
    document.querySelectorAll("#fee-seg .feeopt").forEach(function (x) { x.classList.remove("sel"); });
    o.classList.add("sel");
    feeChoice = o.dataset.fee;
    updateFeeNote(); poke();
  });
});
function renderSendFees() {
  var r = session.feeRates || { slow: 2, normal: 5, fast: 15 };
  $("fee-slow").textContent = r.slow + " g/vB";
  $("fee-normal").textContent = r.normal + " g/vB";
  $("fee-fast").textContent = r.fast + " g/vB";
  updateFeeNote();
}
function updateFeeNote() {
  var n = $("fee-note");
  if (!session.mnemonic) return;
  try {
    var amt = $("send-amt").value.trim();
    var target = amt ? W.prlToGrains(amt) : 0;
    var ins = Math.max(1, session.utxos.length);
    var fee = W.feeFor(ins, target > 0 ? 2 : 2, feeRate());
    $("fee-est").textContent = W.fmtPRL(fee) + " PRL";
    n.textContent = "≈" + feeRate() + " grains/vB · live estimate";
  } catch (e) { $("fee-est").textContent = "—"; }
}
function updateSendFiat() {
  var sf = $("send-fiat");
  try {
    var g = W.prlToGrains($("send-amt").value.trim() || "0");
    sf.textContent = session.price && session.price.usd
      ? "≈ " + W.fmtFiat(session.price.usd, g, settings.fiat)
      : "≈ —";
  } catch (e) { sf.textContent = "≈ —"; }
}
$("send-amt").addEventListener("input", function () { updateSendFiat(); updateFeeNote(); poke(); });
$("send-to").addEventListener("input", function () {
  var v = $("send-to").value.trim();
  var err = $("send-to-err");
  if (!v) { err.textContent = ""; $("send-to").classList.remove("err"); return; }
  try { W.validateAddress(v, net()); err.textContent = ""; $("send-to").classList.remove("err"); }
  catch (e) { err.textContent = e.message; $("send-to").classList.add("err"); }
  poke();
});

$("send-max").addEventListener("click", function () {
  poke();
  var total = session.utxos.reduce(function (s, u) { return s + u.value; }, 0);
  if (!total) { toast("No confirmed funds to send"); return; }
  var fee = W.feeFor(Math.max(1, session.utxos.length), 1, feeRate()); // 1 output, no change
  var max = total - fee;
  if (max <= 546) { toast("Balance too small to cover the fee"); return; }
  $("send-amt").value = W.fmtPRL(max);
  updateSendFiat(); updateFeeNote();
  toast("Max set — fee deducted");
});

var pendingSend = null;
$("btn-review").addEventListener("click", async function () {
  poke();
  var to = $("send-to").value.trim();
  var amtStr = $("send-amt").value.trim();
  var bad = false;
  try { W.validateAddress(to, net()); $("send-to-err").textContent = ""; $("send-to").classList.remove("err"); }
  catch (e) { $("send-to-err").textContent = e.message; $("send-to").classList.add("err"); bad = true; }
  var amountGrains = 0;
  try {
    amountGrains = W.prlToGrains(amtStr);
    if (amountGrains < 546) throw new Error("below dust (546 grains)");
    $("send-amt-err").textContent = "";
  } catch (e) { $("send-amt-err").textContent = "Invalid amount: " + e.message; bad = true; }
  if (bad) return;

  var btn = $("btn-review");
  btn.disabled = true; btn.textContent = "Preparing…";
  try {
    await refreshAll(false); // fresh UTXOs before coin selection
    if (!session.utxos.length) { toast("No confirmed UTXOs available"); return; }
    var rate = feeRate();
    var sel;
    try { sel = W.selectCoins(session.utxos, amountGrains, rate); }
    catch (e) { toast(e.message); return; }
    // attach keys
    var inputs = sel.inputs.map(function (u) {
      var k = session.keys.get(u.address);
      if (!k) throw new Error("missing key for " + shortAddr(u.address));
      return { txid: u.txid, vout: u.vout, value: u.value, priv: k.priv, internalXOnly: k.internalXOnly };
    });
    var changeKey = keyFor(meta.changeIndex, 1);
    var recipientProgram = W.validateAddress(to, net()).program;
    var built = W.buildSendTx({
      inputs: inputs,
      recipientProgram: recipientProgram,
      amountGrains: amountGrains,
      changeTweakedX: changeKey.tweakedX,
      feeRate: rate,
    });
    pendingSend = { built: built, to: to, amountGrains: amountGrains, rate: rate, nIn: sel.inputs.length, usedChange: built.changeGrains > 0 };
    showConfirmSheet();
  } catch (e) {
    toast("Couldn't build transaction: " + e.message);
  } finally {
    btn.disabled = false; btn.innerHTML = "Review &amp; send →";
  }
});

function showConfirmSheet() {
  var p = pendingSend, b = p.built;
  var fiat = function (g) {
    return session.price && session.price.usd ? " (" + W.fmtFiat(session.price.usd, g, settings.fiat) + ")" : "";
  };
  openSheet(
    "<h2>Confirm send</h2>" +
    '<p class="hint">Review everything. Your wallet signs locally — nothing broadcasts until you confirm.</p>' +
    '<div class="kv"><span class="k">To</span><span class="v mono">' + esc(p.to) + "</span></div>" +
    '<div class="kv"><span class="k">Amount</span><span class="v">' + esc(W.fmtPRL(p.amountGrains)) + " PRL" + esc(fiat(p.amountGrains)) + "</span></div>" +
    '<div class="kv"><span class="k">Network fee</span><span class="v">' + esc(W.fmtPRL(b.feeGrains)) + " PRL" + esc(fiat(b.feeGrains)) + ' <span class="tiny">(' + p.rate + " g/vB)</span></span></div>" +
    (b.changeGrains > 0
      ? '<div class="kv"><span class="k">Change back to you</span><span class="v">' + esc(W.fmtPRL(b.changeGrains)) + " PRL</span></div>"
      : '<div class="kv"><span class="k">Change</span><span class="v tiny">dust folded into fee</span></div>') +
    '<div class="kv"><span class="k">Total debit</span><span class="v">' + esc(W.fmtPRL(p.amountGrains + b.feeGrains)) + " PRL</span></div>" +
    '<div class="kv"><span class="k">Inputs</span><span class="v">' + p.nIn + " UTXO" + (p.nIn > 1 ? "s" : "") + "</span></div>" +
    '<div class="kv"><span class="k">Tx id</span><span class="v mono">' + esc(b.txid) + "</span></div>" +
    '<div class="btnrow"><button class="btn ghost" id="sheet-cancel">Cancel</button>' +
    '<button class="btn" id="sheet-broadcast">Confirm &amp; broadcast</button></div>' +
    '<p class="tiny center">Signed with Schnorr (BIP-340) · Taproot key-path spend</p>'
  );
  $("sheet-cancel").addEventListener("click", closeSheet);
  $("sheet-broadcast").addEventListener("click", broadcastSend);
}

async function broadcastSend() {
  var p = pendingSend;
  if (!p) return;
  var btn = $("sheet-broadcast");
  btn.disabled = true; btn.textContent = "Broadcasting…";
  try {
    var txid = await W.bbBroadcast(blockbookBase(), p.built.hex);
    if (p.usedChange) { meta.changeIndex++; saveMeta(meta); }
    closeSheet();
    pendingSend = null;
    $("send-to").value = ""; $("send-amt").value = "";
    updateSendFiat(); updateFeeNote();
    openSheet(
      "<h2>Sent ✓</h2>" +
      '<p class="hint">Your transaction is on the Pearl network.</p>' +
      '<div class="kv"><span class="k">Tx id</span><span class="v mono">' + esc(txid) + "</span></div>" +
      '<div class="btnrow"><button class="btn ghost" id="sheet-copy-txid">⧉ Copy txid</button>' +
      '<a class="btn" style="text-decoration:none" target="_blank" rel="noopener" href="' + esc(W.explorerTx(blockbookBase(), txid)) + '">View explorer ↗</a></div>' +
      '<button class="btn ghost mt" id="sheet-done">Done</button>'
    );
    $("sheet-copy-txid").addEventListener("click", function () {
      copyText(txid).then(function () { toast("Txid copied"); });
    });
    $("sheet-done").addEventListener("click", function () { closeSheet(); showTab("activity"); });
    refreshAll(true);
  } catch (e) {
    btn.disabled = false; btn.innerHTML = "Confirm &amp; broadcast";
    toast("Broadcast failed: " + e.message);
  }
}

/* ================================================================
   RECEIVE
   ================================================================ */
function currentReceiveKey() { return keyFor(meta.recvIndex, 0); }

function renderReceive() {
  if (!session.mnemonic) return;
  var k;
  try { k = currentReceiveKey(); }
  catch (e) { $("recv-addr").textContent = "error: " + e.message; return; }
  var addr = k.address;
  $("recv-addr").textContent = addr;
  var qr = $("recv-qr");
  qr.innerHTML = "";
  try {
    if (window.qrcode) {
      var q = window.qrcode(0, "M");
      q.addData(addr);
      q.make();
      var img = document.createElement("img");
      img.src = q.createDataURL(4, 0);
      img.alt = "Receive address QR code";
      img.width = 208; img.height = 208;
      qr.appendChild(img);
    } else {
      qr.innerHTML = '<p class="tiny">QR library missing</p>';
    }
  } catch (e) { qr.innerHTML = '<p class="tiny">QR failed</p>'; }
  // history (newest first)
  var h = $("addr-history");
  h.innerHTML = "";
  if (meta.recvIndex < 0) meta.recvIndex = 0;
  for (var i = meta.recvIndex; i >= 0; i--) {
    (function (idx) {
      var kk;
      try { kk = keyFor(idx, 0); } catch (e) { return; }
      var row = el("div", "tx");
      var tag = idx === meta.recvIndex ? ' <span class="pill conf">current</span>' : "";
      row.innerHTML = '<div class="tx-ic">↓</div><div class="tx-mid"><div class="tx-title mono" style="font-size:12px">' +
        esc(shortAddr(kk.address)) + "</div>" +
        '<div class="tx-sub">address #' + idx + tag + "</div></div>";
      var b = el("button", "btn ghost sm", "⧉");
      b.addEventListener("click", function () {
        copyText(kk.address).then(function () { toast("Address copied"); });
      });
      row.appendChild(b);
      h.appendChild(row);
    })(i);
    if (h.children.length >= 25) break; // cap history render
  }
  if (!h.children.length) h.innerHTML = '<div class="empty">No addresses yet.</div>';
}
$("btn-copy-addr").addEventListener("click", function () {
  copyText($("recv-addr").textContent).then(function () { toast("Address copied"); });
  poke();
});
$("btn-new-addr").addEventListener("click", function () {
  poke();
  meta.recvIndex++;
  saveMeta(meta);
  renderReceive();
  toast("Fresh address derived");
  refreshAll(false);
});

/* ================================================================
   ACTIVITY
   ================================================================ */
function renderActivity() {
  var box = $("tx-list");
  if (!session.mnemonic) return;
  if (!session.txs.length) {
    box.innerHTML = '<div class="empty"><div class="big">≣</div>No transactions yet.<br>Your history appears here after your first send or receive.</div>';
    return;
  }
  box.innerHTML = "";
  var base = blockbookBase();
  session.txs.forEach(function (t) {
    var isIn = t.net > 0;
    var row = el("div", "tx " + (isIn ? "in" : "out"));
    var title = isIn ? "Received" : (t.net < 0 ? "Sent" : "Self transfer");
    var amt = (isIn ? "+" : "") + W.fmtPRL(Math.abs(t.net)) + " PRL";
    var when = t.pending ? "in mempool" : (t.time ? new Date(t.time * 1000).toLocaleString() : ("block " + t.height));
    row.innerHTML =
      '<div class="tx-ic">' + (isIn ? "↓" : "↑") + "</div>" +
      '<div class="tx-mid"><div class="tx-title">' + title + "</div>" +
      '<div class="tx-sub">' + esc(t.txid.slice(0, 16)) + "… · " + esc(when) + "</div>" +
      '<span class="pill ' + (t.pending ? "pend" : "conf") + '">' + (t.pending ? "pending" : t.confirmations + " conf") + "</span></div>" +
      '<div class="tx-amt">' + esc(amt) + "</div>";
    row.style.cursor = "pointer";
    row.addEventListener("click", function () {
      if (base) window.open(W.explorerTx(base, t.txid), "_blank", "noopener");
    });
    box.appendChild(row);
  });
}
$("btn-act-refresh").addEventListener("click", function () { poke(); refreshAll(true); });

/* ================================================================
   SETTINGS
   ================================================================ */
function syncSettingsUI() {
  document.querySelectorAll("#seg-net button").forEach(function (b) {
    b.classList.toggle("sel", b.dataset.net === settings.network);
  });
  document.querySelectorAll("#seg-lock button").forEach(function (b) {
    b.classList.toggle("sel", parseInt(b.dataset.lock, 10) === settings.lockMinutes);
  });
  $("set-blockbook").value = settings.blockbook || "";
  $("set-testbook").value = settings.testnetBlockbook || "";
  $("set-pearlsc").value = settings.pearlscriptions || "";
  $("set-fiat").value = settings.fiat || "USD";
  renderHome();
}
document.querySelectorAll("#seg-net button").forEach(function (b) {
  b.addEventListener("click", function () {
    if (b.dataset.net === settings.network) return;
    settings.network = b.dataset.net;
    saveSettings(settings);
    syncSettingsUI();
    toast(settings.network === "testnet" ? "Testnet — set a Blockbook URL below" : "Mainnet");
    refreshAll(true); poke();
  });
});
document.querySelectorAll("#seg-lock button").forEach(function (b) {
  b.addEventListener("click", function () {
    settings.lockMinutes = parseInt(b.dataset.lock, 10);
    saveSettings(settings);
    syncSettingsUI(); armLock(); poke();
    toast("Auto-lock: " + settings.lockMinutes + " min");
  });
});
$("btn-save-settings").addEventListener("click", function () {
  settings.blockbook = $("set-blockbook").value.trim();
  settings.testnetBlockbook = $("set-testbook").value.trim();
  settings.pearlscriptions = $("set-pearlsc").value.trim();
  settings.fiat = $("set-fiat").value;
  saveSettings(settings);
  poke();
  toast("Settings saved");
  refreshAll(true);
});
$("btn-lock-now").addEventListener("click", function () { lock("Locked"); });

$("btn-change-pw").addEventListener("click", function () {
  openSheet(
    "<h2>Change password</h2>" +
    '<div class="field"><label for="cpw-old">Current password</label><input class="input" id="cpw-old" type="password"></div>' +
    '<div class="field"><label for="cpw-new">New password (min 8)</label><input class="input" id="cpw-new" type="password"></div>' +
    '<div class="field"><label for="cpw-new2">Confirm new</label><input class="input" id="cpw-new2" type="password"><div class="ferr" id="cpw-err"></div></div>' +
    '<div class="btnrow"><button class="btn ghost" id="cpw-cancel">Cancel</button><button class="btn" id="cpw-go">Change</button></div>'
  );
  $("cpw-cancel").addEventListener("click", closeSheet);
  $("cpw-go").addEventListener("click", async function () {
    var err = $("cpw-err"); err.textContent = "";
    var nw = $("cpw-new").value;
    if (nw.length < 8) { err.textContent = "New password must be at least 8 characters."; return; }
    if (nw !== $("cpw-new2").value) { err.textContent = "New passwords don't match."; return; }
    try {
      var vault = JSON.parse(localStorage.getItem(LS_VAULT) || "null");
      var secret = await W.vaultUnseal(vault, $("cpw-old").value);
      var nv = await W.vaultSeal(secret, nw);
      nv.k = vault.k; nv.pp = vault.pp;
      localStorage.setItem(LS_VAULT, JSON.stringify(nv));
      closeSheet(); toast("Password changed");
    } catch (e) { err.textContent = "Current password is wrong."; }
  });
});

/* backup export / import */
$("btn-export").addEventListener("click", function () {
  var vault = localStorage.getItem(LS_VAULT) || "";
  openSheet(
    "<h2>Encrypted backup</h2>" +
    '<p class="hint">AES-256-GCM, 600k PBKDF2 rounds. Needs your password to open — store it somewhere safe.</p>' +
    '<textarea class="input mono" id="bak-text" style="min-height:140px" readonly>' + esc(vault) + "</textarea>" +
    '<div class="btnrow"><button class="btn ghost" id="bak-copy">⧉ Copy</button><button class="btn" id="bak-dl">Download .json</button></div>' +
    '<button class="btn ghost mt" id="bak-close">Close</button>'
  );
  $("bak-close").addEventListener("click", closeSheet);
  $("bak-copy").addEventListener("click", function () {
    copyText(vault).then(function () { toast("Backup copied"); });
  });
  $("bak-dl").addEventListener("click", function () {
    var blob = new Blob([vault], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "pearl-wallet-backup.json";
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
  });
});
$("btn-import-bak").addEventListener("click", function () {
  openSheet(
    "<h2>Import backup</h2>" +
    '<p class="hint">Paste a backup JSON exported from Pearl Wallet. This replaces the wallet on this device.</p>' +
    '<textarea class="input mono" id="bak-in" style="min-height:140px" placeholder=\'{"v":1,"salt":"…","iv":"…","ct":"…"}\'></textarea>' +
    '<div class="ferr" id="bak-err"></div>' +
    '<div class="btnrow"><button class="btn ghost" id="bakc-cancel">Cancel</button><button class="btn" id="bakc-go">Import</button></div>'
  );
  $("bakc-cancel").addEventListener("click", closeSheet);
  $("bakc-go").addEventListener("click", function () {
    var err = $("bak-err"); err.textContent = "";
    try {
      var v = JSON.parse($("bak-in").value);
      if (!v || v.v !== 1 || !v.salt || !v.iv || !v.ct) throw new Error("not a Pearl Wallet backup");
      if (!confirm("Replace the wallet on this device with this backup?")) return;
      localStorage.setItem(LS_VAULT, JSON.stringify(v));
      localStorage.removeItem(LS_META);
      meta = { recvIndex: 0, changeIndex: 0 };
      closeSheet();
      lock("Backup imported — unlock with its password");
    } catch (e) { err.textContent = e.message; }
  });
});

$("btn-wipe").addEventListener("click", function () {
  if (!confirm("Wipe Pearl Wallet from this device?\n\nYour PRL stays on-chain. You can restore with your recovery phrase.")) return;
  if (!confirm("Last chance — do you have your 12/24-word recovery phrase written down?")) return;
  localStorage.removeItem(LS_VAULT);
  localStorage.removeItem(LS_META);
  localStorage.removeItem(LS_SETTINGS);
  location.reload();
});

/* ================================================================
   INIT
   ================================================================ */
(function init() {
  renderSendFees();
  // PWA: register the offline app shell (scope = this directory)
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("./sw.js").catch(function () {});
    });
  }
  var hasVault = !!localStorage.getItem(LS_VAULT);
  // iOS Add-to-Home-Screen nudge (only when running in the browser, not installed)
  try {
    var standalone = window.navigator.standalone === true ||
      (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
    var dismissed = localStorage.getItem("pearl-wallet:a2hs-dismissed") === "1";
    var isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent || "");
    if (!standalone && !dismissed && (isIOS || !("serviceWorker" in navigator))) {
      $("a2hs-card").classList.remove("hidden");
      $("a2hs-dismiss").addEventListener("click", function () {
        $("a2hs-card").classList.add("hidden");
        try { localStorage.setItem("pearl-wallet:a2hs-dismissed", "1"); } catch (e) {}
      });
    }
  } catch (e) {}
  if (hasVault) {
    showView("lock");
    setTimeout(function () { $("lock-pw").focus(); }, 350);
  } else {
    showView("onboarding");
    obShow("ob-welcome");
  }
})();
})();
