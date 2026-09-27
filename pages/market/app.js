/* Pearl Bazaar UI — page logic (classic script, uses window.PearlMarket). */
(function () {
  "use strict";
  const M = window.PearlMarket;
  if (!M) {
    document.body.innerHTML = "<p style='padding:2rem'>Failed to load market.bundle.js</p>";
    return;
  }

  /* ---------------- dom helpers ---------------- */
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const el = (tag, cls, html) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  };

  function toast(msg, ms = 4200) {
    const t = el("div", "toast", esc(msg));
    document.body.appendChild(t);
    setTimeout(() => t.remove(), ms);
  }

  /* ---------------- chrome ---------------- */
  $$(".nav-toggle").forEach((b) => b.addEventListener("click", () => {
    const links = $(".nav-links");
    const open = links.classList.toggle("open");
    b.setAttribute("aria-expanded", String(open));
  }));
  $$("[data-copy]").forEach((b) => b.addEventListener("click", async () => {
    const target = document.getElementById(b.getAttribute("data-copy"));
    const text = target ? target.textContent.trim() : "";
    try { await navigator.clipboard.writeText(text); toast("Copied"); }
    catch { toast("Copy failed — select the text manually"); }
  }));

  /* ---------------- settings ---------------- */
  const settings = M.loadSettings();
  const network = () => M.NETWORKS[settings.networkId] || M.NETWORKS.mainnet;

  function setConn(mode, label) {
    const c = $("#conn");
    if (!c) return;
    c.className = "conn " + mode;
    c.textContent = label;
  }
  function refreshConn() {
    if (settings.demo) setConn("demo", "demo mode");
    else if (settings.indexerBase) setConn("live", "indexer connected");
    else setConn("", "not connected");
  }

  /* ---------------- data layer ---------------- */
  // Unified book: live board + (optional) demo. Demo books are cached per
  // tick for the session so demo fills can consume listings.
  const demoCache = new Map();
  const getDemoBook = (tick) => {
    const t = String(tick).toLowerCase();
    if (!demoCache.has(t)) demoCache.set(t, M.demoBook(t, network()));
    return demoCache.get(t);
  };

  const nowMs = () => Date.now();
  const liveAsks = (tick) =>
    M.loadBoard().listings.filter((l) => l.tick === String(tick).toLowerCase() && l.expiry > nowMs() && !l.demo);
  const liveBids = (tick) =>
    M.loadBoard().bids.filter((b) => b.tick === String(tick).toLowerCase() && !b.demo);

  function cmpAsk(a, b) { // lowest unit price first
    const l = BigInt(a.priceGrains) * BigInt(b.amt), r = BigInt(b.priceGrains) * BigInt(a.amt);
    return l < r ? -1 : l > r ? 1 : (a.created || 0) - (b.created || 0);
  }
  function cmpBid(a, b) { // highest unit price first
    const l = BigInt(a.maxPrice) * BigInt(b.amount), r = BigInt(b.maxPrice) * BigInt(a.amount);
    return l > r ? -1 : l < r ? 1 : (a.created || 0) - (b.created || 0);
  }

  function getBook(tick) {
    const t = String(tick).toLowerCase();
    let asks = liveAsks(t), bids = liveBids(t);
    if (settings.demo) {
      const d = getDemoBook(t);
      asks = asks.concat(d.listings);
      bids = bids.concat(d.bids);
    }
    asks.sort(cmpAsk); bids.sort(cmpBid);
    return { asks, bids };
  }

  function getTape(tick) {
    const t = String(tick).toLowerCase();
    const local = M.loadBoard().trades.filter((x) => x.tick === t);
    const demo = settings.demo ? getDemoBook(t).trades : [];
    return local.concat(demo).sort((a, b) => a.ts - b.ts);
  }

  async function getTokens() {
    if (settings.demo) return { tokens: M.demoTokens(network()), source: "demo" };
    if (settings.indexerBase) {
      const { tokens } = await M.idxGetTokens(settings.indexerBase);
      return { tokens, source: "live" };
    }
    return { tokens: [], source: "offline" };
  }

  function unitPriceStr(priceGrains, amt) { // per-token price, human-readable
    const g = BigInt(priceGrains), a = BigInt(amt);
    if (a <= 0n) return "—";
    // g/a = whole grains per token; fmtPRL renders grains/1e8, so per-token
    // price x lot size == total exactly (up to sub-grain truncation, which
    // 8-decimal PRL display cannot represent anyway).
    return M.fmtPRL(g / a) + " PRL";
  }

  /* ---------------- key handling (memory only) ---------------- */
  const keys = { wallet: null }; // never persisted
  function walletFromKeyInput(str) {
    const s = String(str || "").trim();
    if (!s) throw new Error("enter a mnemonic, WIF, or hex private key");
    const nw = network();
    try { return M.walletFromWIF(s, nw); } catch { /* not WIF */ }
    try { return M.walletFromMnemonic(s, nw); } catch { /* not mnemonic */ }
    if (/^[0-9a-f]{64}$/i.test(s)) return M.walletFromPriv(s, nw);
    throw new Error("unrecognized key format (need BIP-39 mnemonic, WIF, or 32-byte hex)");
  }

  /* ---------------- chart ---------------- */
  function drawChart(canvas, trades) {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const W = canvas.width = canvas.offsetWidth * 2 || 1200;
    const H = canvas.height = 520;
    ctx.clearRect(0, 0, W, H);
    if (!trades.length) {
      ctx.fillStyle = "#6b7891"; ctx.font = "28px sans-serif";
      ctx.fillText("No trades yet", 40, H / 2);
      return;
    }
    const px = trades.map((t) => Number(BigInt(t.pricePerTokenGrains ?? "0") || (BigInt(t.priceGrains) / BigInt(t.amount))));
    const lo = Math.min(...px), hi = Math.max(...px);
    const span = hi - lo || 1;
    const pad = 60;
    const X = (i) => pad + (i * (W - pad * 2)) / Math.max(1, trades.length - 1);
    const Y = (v) => 30 + (1 - (v - lo) / span) * (H - 90);
    // grid
    ctx.strokeStyle = "rgba(244,63,94,0.12)"; ctx.lineWidth = 1;
    for (let g = 0; g <= 4; g++) {
      const y = 30 + (g / 4) * (H - 90);
      ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(W - pad, y); ctx.stroke();
      const val = hi - (g / 4) * span;
      ctx.fillStyle = "#6b7891"; ctx.font = "22px monospace";
      ctx.fillText(M.fmtPRL(BigInt(Math.round(val))) + " PRL", 8, y + 8);
    }
    // line
    const grad = ctx.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, "#f43f5e"); grad.addColorStop(1, "#e8c47a");
    ctx.strokeStyle = grad; ctx.lineWidth = 4; ctx.beginPath();
    px.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
    ctx.stroke();
    // last point
    ctx.fillStyle = "#e8c47a";
    ctx.beginPath(); ctx.arc(X(px.length - 1), Y(px[px.length - 1]), 8, 0, 7); ctx.fill();
    // x-axis: real time progression across the tape's range (hourly steps
    // for intraday tapes, daily for multi-day, monthly beyond that)
    const ts0 = trades.map((t) => Number(t.ts) || 0).filter(Boolean);
    if (ts0.length > 1) {
      const t0 = Math.min(...ts0), t1 = Math.max(...ts0), range = Math.max(1, t1 - t0);
      const fmtTick = (ts) => {
        const d = new Date(ts);
        if (range < 2 * 86400000)
          return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
        if (range < 90 * 86400000)
          return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
        return d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
      };
      const nT = 5;
      ctx.fillStyle = "#6b7891"; ctx.font = "22px monospace"; ctx.textAlign = "center";
      ctx.strokeStyle = "rgba(244,63,94,0.25)"; ctx.lineWidth = 1;
      for (let k = 0; k <= nT; k++) {
        const x = pad + (k / nT) * (W - pad * 2);
        const ts = t0 + (range * k) / nT;
        ctx.beginPath(); ctx.moveTo(x, H - 44); ctx.lineTo(x, H - 36); ctx.stroke();
        ctx.fillText(fmtTick(ts), x, H - 12);
      }
      ctx.textAlign = "left";
    }
  }

  /* ---------------- shared widgets ---------------- */
  function demoBanner() {
    if (!settings.demo) return "";
    return `<div class="banner demo">DEMO — simulated order book and trades. No real funds, no real listings. Turn demo off in Settings and configure the indexer for live data.</div>`;
  }
  function localBanner() {
    return `<div class="banner local">Local board — listings and bids are stored only in this browser (localStorage). No listing relay is configured, so other users cannot see them.</div>`;
  }

  function settingsPanel() {
    return `
    <section class="section" id="settings">
      <div class="container narrow">
        <h2>Settings</h2>
        <div class="card">
          <div class="toggle-row">
            <div><strong>Demo mode</strong><br><span class="muted small">Deterministic simulated tokens, listings and trades.</span></div>
            <label class="switch"><input type="checkbox" id="set-demo" ${settings.demo ? "checked" : ""}><span class="track"></span></label>
          </div>
          <div class="field" style="margin-top:1rem">
            <label for="set-indexer">Pearlscriptions indexer base URL</label>
            <input id="set-indexer" placeholder="https://indexer.example.com" value="${esc(settings.indexerBase)}">
            <p class="hint">Serves <span class="mono">GET /tokens</span>, <span class="mono">/tokens/:ticker</span>, <span class="mono">/addresses/:address/transfer-lots</span>. Leave empty for offline mode.</p>
          </div>
          <div class="field">
            <label for="set-blockbook">Blockbook base URL (PRL UTXOs + broadcast)</label>
            <input id="set-blockbook" value="${esc(settings.blockbookBase)}">
          </div>
          <div class="field">
            <label for="set-address">My Pearl address (portfolio + defaults)</label>
            <input id="set-address" class="mono" placeholder="prl1..." value="${esc(settings.address)}">
          </div>
          <button class="btn btn-primary" id="set-save" type="button">Save settings</button>
        </div>
      </div>
    </section>`;
  }
  function wireSettings() {
    const save = $("#set-save");
    if (!save) return;
    save.addEventListener("click", () => {
      const next = {
        indexerBase: $("#set-indexer").value.trim().replace(/\/$/, ""),
        blockbookBase: $("#set-blockbook").value.trim().replace(/\/$/, "") || "https://blockbook.pearlresearch.ai",
        demo: $("#set-demo").checked,
        address: $("#set-address").value.trim(),
        networkId: settings.networkId,
      };
      if (next.address) {
        try { M.decodeBech32m(next.address, network().hrp); }
        catch { toast("Address is not a valid " + network().hrp + " Taproot address"); return; }
      }
      M.saveSettings(next);
      Object.assign(settings, next);
      refreshConn();
      toast("Settings saved");
      setTimeout(() => location.reload(), 600);
    });
  }

  /* ================================================================
     HOME
     ================================================================ */
  async function initHome() {
    refreshConn();
    $("#demo-slot").innerHTML = demoBanner();
    $("#local-slot").innerHTML = localBanner();

    let tokens = [], source = "offline";
    try {
      ({ tokens, source } = await getTokens());
    } catch (e) {
      $("#tokens-error").innerHTML = `<div class="banner warn">Token directory unreachable: ${esc(e.message)}</div>`;
    }
    const dir = $("#token-dir");
    if (!tokens.length) {
      dir.innerHTML = `<div class="banner info">${source === "offline"
        ? "Offline — configure the indexer base URL below, or enable demo mode to browse simulated tokens."
        : "No tokens found."}</div>`;
    } else {
      dir.innerHTML = tokens.map((t) => `
        <a class="card token-card" href="token.html?tick=${esc(t.ticker)}">
          <div class="row"><span class="tick">${esc((t.displayTicker || t.ticker).toUpperCase())}</span>
          ${t.demo ? '<span class="pill demo">demo</span>' : '<span class="pill live">live</span>'}</div>
          <div class="row" style="margin-top:0.6rem"><span class="stat-label">Minted</span><span class="stat">${esc(M.fmtInt(t.mintedSupply ?? "0"))}</span></div>
          <div class="row"><span class="stat-label">Holders</span><span class="stat">${esc(String(t.holderCount ?? "—"))}</span></div>
          <div class="row"><span class="stat-label">Mint progress</span><span class="stat">${t.mintProgress != null ? Number(t.mintProgress).toFixed(1) + "%" : "—"}</span></div>
        </a>`).join("");
    }

    // movers from tape
    const ticks = tokens.map((t) => t.ticker);
    const allTrades = ticks.flatMap((t) => getTape(t));
    const movers = M.tapeMovers(allTrades, ticks).filter((m) => m.last != null)
      .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct)).slice(0, 6);
    $("#movers").innerHTML = movers.length ? `
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Token</th><th class="num">Last price</th><th class="num">24h</th><th class="num">Trades</th></tr></thead>
        <tbody>${movers.map((m) => `
          <tr><td><a href="token.html?tick=${esc(m.tick)}"><strong>${esc(m.tick.toUpperCase())}</strong></a>
            ${settings.demo ? ' <span class="pill demo">demo</span>' : ""}</td>
            <td class="num">${esc(M.fmtPRL(BigInt(Math.round(m.last))))} PRL</td>
            <td class="num ${m.changePct >= 0 ? "up" : "down"}">${m.changePct >= 0 ? "+" : ""}${m.changePct.toFixed(2)}%</td>
            <td class="num">${m.trades}</td></tr>`).join("")}
        </tbody></table></div>`
      : `<p class="muted">No trade tape yet — place the first trade, or enable demo mode.</p>`;

    // featured listings: cheapest asks across tokens
    const featured = [];
    for (const t of ticks) for (const a of getBook(t).asks.slice(0, 2)) featured.push(a);
    featured.sort(cmpAsk);
    $("#featured").innerHTML = featured.length ? `
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Token</th><th class="num">Amount</th><th class="num">Price/token</th><th class="num">Total</th><th>Seller</th><th></th></tr></thead>
        <tbody>${featured.slice(0, 8).map((a) => `
          <tr><td><a href="token.html?tick=${esc(a.tick)}"><strong>${esc(a.tick.toUpperCase())}</strong></a>
            ${a.demo ? ' <span class="pill demo">demo</span>' : ""}</td>
            <td class="num">${esc(M.fmtInt(a.amt))}</td>
            <td class="num">${esc(unitPriceStr(a.priceGrains, a.amt))}</td>
            <td class="num">${esc(M.fmtPRL(a.priceGrains))} PRL</td>
            <td class="mono small">${esc(M.shortAddr(a.seller))}</td>
            <td><a class="btn btn-ghost btn-small" href="token.html?tick=${esc(a.tick)}">View</a></td></tr>`).join("")}
        </tbody></table></div>`
      : `<p class="muted">No live listings. <a href="list.html">List the first lot</a>.</p>`;

    $("#settings-slot").innerHTML = settingsPanel();
    wireSettings();
  }

  /* ================================================================
     TOKEN PAGE
     ================================================================ */
  async function initToken() {
    refreshConn();
    const tick = new URLSearchParams(location.search).get("tick");
    if (!tick || !/^[a-z0-9]{1,16}$/i.test(tick)) {
      $("#token-body").innerHTML = `<div class="banner warn">Bad token ticker. <a href="./">Back to market</a></div>`;
      return;
    }
    const t = tick.toLowerCase();
    $("#demo-slot").innerHTML = demoBanner();
    $("#local-slot").innerHTML = localBanner();

    // header
    let meta = null;
    try {
      if (settings.demo) meta = M.demoTokens(network()).find((x) => x.ticker === t) || null;
      else if (settings.indexerBase) meta = await M.idxGetToken(settings.indexerBase, t);
    } catch (e) { /* offline header */ }
    $("#token-head").innerHTML = `
      <p class="eyebrow">PRL-20 market</p>
      <h1>${esc((meta && meta.displayTicker || t).toUpperCase())} <span class="muted" style="font-size:1.2rem">/${esc(t)}</span>
        ${settings.demo ? '<span class="pill demo">demo</span>' : ""}</h1>
      <p class="lede">${meta ? `Minted ${esc(M.fmtInt(meta.mintedSupply ?? "0"))} of ${esc(M.fmtInt(meta.maxSupply ?? "0"))} · ${esc(String(meta.holderCount ?? "—"))} holders · ${meta.mintProgress != null ? Number(meta.mintProgress).toFixed(1) + "%" : "—"} minted` : "Token metadata unavailable offline."}</p>`;

    const render = () => {
      const { asks, bids } = getBook(t);
      const tape = getTape(t);

      // chart
      const last = tape[tape.length - 1];
      const lastPx = last ? Number(BigInt(last.pricePerTokenGrains ?? "0") || (BigInt(last.priceGrains) / BigInt(last.amount))) : null;
      $("#chart-price").innerHTML = lastPx != null
        ? `${esc(M.fmtPRL(BigInt(Math.round(lastPx))))} <span class="muted small">PRL / ${esc(t.toUpperCase())}</span>` : "—";
      drawChart($("#chart"), tape);

      // depth: per-side maxima (a whale on one side must not flatten the
      // other side's bars), guarded so an empty/zero side yields 0% bars.
      const capNum = (v) => { const b = BigInt(v); return Number(b > 10n ** 18n ? 10n ** 18n : b); };
      const askMax = Math.max(0, ...asks.map((a) => capNum(a.amt)));
      const bidMax = Math.max(0, ...bids.map((b) => capNum(b.amount)));
      const row = (o, isAsk) => {
        const amt = isAsk ? o.amt : o.amount;
        const price = isAsk ? o.priceGrains : o.maxPrice;
        const max = isAsk ? askMax : bidMax;
        const w = max > 0 ? Math.min(100, Math.max(0, (capNum(amt) / max) * 100)) : 0;
        return `<div class="book-row">
          <span class="depth-bar" style="width:${w.toFixed(1)}%"></span>
          <span>${esc(unitPriceStr(price, isAsk ? o.amt : o.amount))}</span>
          <span>${esc(M.fmtInt(amt))}</span>
          ${isAsk ? `<button class="btn btn-ghost btn-small fill-btn" data-ask="${esc(o.boardId || o.seller + o.created)}" type="button">Fill</button>` : `<span class="tape-side bidder-chip">${esc(M.shortAddr(o.buyerAddress))}</span>`}
        </div>`;
      };
      $("#asks").innerHTML = `<h3>Asks (${asks.length})</h3>` +
        (asks.slice(0, 20).map((a) => row(a, true)).join("") || `<p class="muted small">No asks.</p>`);
      $("#bids").innerHTML = `<h3>Bids (${bids.length})</h3>` +
        (bids.slice(0, 20).map((b) => row(b, false)).join("") || `<p class="muted small">No bids.</p>`);

      // tape
      $("#tape").innerHTML = tape.length ? `
        <div class="table-wrap"><table class="data">
          <thead><tr><th>Time</th><th class="num">Amount</th><th class="num">Price/token</th><th class="num">Total</th><th>Side</th></tr></thead>
          <tbody>${tape.slice(-25).reverse().map((x) => `
            <tr><td class="tape-side">${esc(M.timeAgo(x.ts))}${x.demo ? ' <span class="pill demo">demo</span>' : ""}</td>
              <td class="num">${esc(M.fmtInt(x.amount))}</td>
              <td class="num">${esc(M.fmtPRL(BigInt(x.pricePerTokenGrains ?? String(BigInt(x.priceGrains) / BigInt(x.amount)))))} PRL</td>
              <td class="num">${esc(M.fmtPRL(x.priceGrains))} PRL</td>
              <td class="mono small">${esc(M.shortAddr(x.buyer))} ← ${esc(M.shortAddr(x.seller))}</td></tr>`).join("")}
          </tbody></table></div>`
        : `<p class="muted">No trades yet on the local tape.</p>`;

      // wire fill buttons
      $$("#asks .fill-btn").forEach((b) => b.addEventListener("click", () => {
        const ask = asks.find((a) => (a.boardId || a.seller + a.created) === b.getAttribute("data-ask"));
        if (ask) openFillModal(t, ask, render);
      }));
    };
    render();

    // buy panel: place bid
    $("#bid-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        const amount = $("#bid-amount").value.trim();
        const maxPRL = $("#bid-max").value.trim();
        if (!/^\d+$/.test(amount) || BigInt(amount) <= 0n) throw new Error("amount must be a positive integer (token base units)");
        const maxPrice = M.parsePRL(maxPRL);
        if (maxPrice <= 0n) throw new Error("max price must be positive");
        const buyerAddress = $("#bid-address").value.trim() || settings.address;
        if (!buyerAddress) throw new Error("enter your Pearl address");
        M.decodeBech32m(buyerAddress, network().hrp);

        if (settings.demo) {
          // run the real matching engine over the demo book: bids that cross
          // whole-lot asks execute immediately as simulated fills; a bid that
          // only partially fills a lot rests (lots sell whole)
          const book = getDemoBook(t);
          const MB = new M.Matching.Market({ knownTickers: [t] });
          for (const a of book.listings) MB.addAsk({ id: a.boardId, tick: t, amt: a.amt, priceGrains: a.priceGrains, seller: a.seller, expiry: a.expiry, created: a.created });
          for (const b of book.bids) MB.addBid({ id: b.boardId, tick: t, amount: b.amount, maxPrice: b.maxPrice, buyerAddress: b.buyerAddress, created: b.created });
          const bidId = "demo-bid-" + Date.now();
          MB.addBid({ id: bidId, tick: t, amount, maxPrice: maxPrice.toString(), buyerAddress, created: Date.now() });
          const { trades } = MB.book(t).match();
          const engine = MB.book(t);
          for (const tr of trades) {
            if (engine.asks.has(tr.askId)) continue; // partial: lot stays whole, stays listed
            const li = book.listings.findIndex((x) => x.boardId === tr.askId);
            if (li >= 0) book.listings.splice(li, 1);
            book.trades.push({
              tick: t, amount: tr.amount, priceGrains: tr.priceGrains,
              pricePerTokenGrains: (BigInt(tr.priceGrains) / BigInt(tr.amount)).toString(),
              buyer: tr.buyer, seller: tr.seller, ts: Date.now(), demo: true,
            });
          }
          if (!engine.bids.has(bidId)) {
            toast(`Simulated fill: ${trades.length} trade(s) executed`);
          } else {
            book.bids.push({ tick: t, amount, maxPrice: maxPrice.toString(), buyerAddress, created: Date.now(), demo: true, boardId: bidId });
            toast(trades.length
              ? "Bid placed — lots sell whole, so the crossed ask stays listed"
              : "Bid placed on the demo book");
          }
        } else {
          M.boardAddBid({ tick: t, amount, maxPrice: maxPrice.toString(), buyerAddress, created: Date.now() });
          // nudge: does it cross a live ask? the buyer can fill directly
          const { asks } = getBook(t);
          const cross = asks.find((a) => a.seller !== buyerAddress &&
            maxPrice * BigInt(a.amt) >= BigInt(a.priceGrains) * BigInt(amount));
          toast(cross ? "Bid placed — it crosses an ask; consider filling it directly." : "Bid placed on the local board");
        }
        e.target.reset();
        render();
      } catch (err) { toast("Bid failed: " + err.message); }
    });
    if (settings.address) $("#bid-address").value = settings.address;
  }

  /* ---------------- fill modal ---------------- */
  /** Cross-check a listing against the live indexer record: the 0x83
   *  presignature commits to outpoint/value/price but NOT to the off-chain
   *  tick+amt metadata, so a fill must confirm those against the indexer. */
  async function crossCheckListing(ask) {
    if (!settings.indexerBase)
      return { ok: true, soft: true, note: "Indexer not configured — tick/amount could not be cross-checked. Verify independently before filling." };
    const { transferLots } = await M.idxGetTransferLots(settings.indexerBase, ask.seller);
    const out = ask.lotTxid + ":" + ask.lotVout;
    const lot = (transferLots || []).find((l) => l.currentOutpoint === out);
    if (!lot)
      return { ok: false, reason: "lot outpoint not found in the seller's transfer lots — it may be spent or moved." };
    if (String(lot.ticker).toLowerCase() !== String(ask.tick).toLowerCase())
      return { ok: false, reason: `ticker mismatch: listing says ${ask.tick}, indexer says ${lot.ticker}.` };
    if (String(lot.amount) !== String(ask.amt))
      return { ok: false, reason: `amount mismatch: listing says ${ask.amt}, indexer says ${lot.amount}.` };
    let utxos = [];
    try { utxos = await M.idxGetUtxos(settings.indexerBase, ask.seller); } catch { /* value check best-effort */ }
    const u = utxos.find((x) => x.outpoint === out || (x.txid === ask.lotTxid && Number(x.vout) === Number(ask.lotVout)));
    if (u && u.valueGrain != null && Number(u.valueGrain) !== Number(ask.lotValue))
      return { ok: false, reason: `lot value mismatch: listing says ${ask.lotValue} grains, indexer says ${u.valueGrain}.` };
    return { ok: true, note: "Lot ticker, amount, owner and outpoint match the live indexer record." };
  }

  /** Buyer funding UTXOs, minus any inscription-protected coins. */
  async function spendableBuyerUtxos(address) {
    const utxos = await M.fetchUtxos(settings.blockbookBase, address);
    const prot = new Set();
    if (settings.indexerBase) {
      try {
        for (const u of await M.idxGetUtxos(settings.indexerBase, address))
          if (u.protected) prot.add(u.outpoint);
      } catch { /* protection check best-effort */ }
    }
    return utxos.filter((u) => !prot.has(u.txid + ":" + u.vout));
  }

  function openFillModal(tick, ask, rerender) {
    const back = el("div", "modal-backdrop");
    const m = el("div", "modal");
    back.appendChild(m);
    document.body.appendChild(back);
    back.addEventListener("click", (e) => { if (e.target === back) back.remove(); });

    const isDemo = !!ask.demo;
    const unit = unitPriceStr(ask.priceGrains, ask.amt);
    m.innerHTML = `
      <h3>Fill ask ${isDemo ? '<span class="pill demo">demo</span>' : ""}</h3>
      <div class="review-box">
        <dl class="kv">
          <dt>Token</dt><dd>${esc(ask.tick.toUpperCase())}</dd>
          <dt>Amount</dt><dd>${esc(M.fmtInt(ask.amt))} ${esc(ask.tick.toUpperCase())}</dd>
          <dt>Price</dt><dd class="total">${esc(M.fmtPRL(ask.priceGrains))} PRL</dd>
          <dt>Per token</dt><dd>${esc(unit)}</dd>
          <dt>Seller</dt><dd>${esc(ask.seller)}</dd>
          <dt>Lot</dt><dd>${esc(ask.lotTxid ? ask.lotTxid.slice(0, 16) + "…" : "n/a")}:${esc(String(ask.lotVout ?? ""))}</dd>
          <dt>Expires</dt><dd>${esc(M.expiryLabel(ask.expiry))}</dd>
        </dl>
      </div>
      <div id="fill-verify"></div>
      <div id="fill-body"></div>`;

    if (isDemo) {
      $("#fill-verify", m).innerHTML = `<div class="banner demo">Simulated fill — no real funds move. The listing is consumed and the trade is added to the local tape.</div>`;
      $("#fill-body", m).innerHTML = `<button class="btn btn-primary" id="fill-demo-go" type="button">Simulate fill</button>`;
      $("#fill-demo-go", m).addEventListener("click", () => {
        const book = getDemoBook(tick);
        const i = book.listings.findIndex((x) => x.boardId === ask.boardId);
        if (i >= 0) book.listings.splice(i, 1);
        book.trades.push({
          tick, amount: ask.amt, priceGrains: ask.priceGrains,
          pricePerTokenGrains: (BigInt(ask.priceGrains) / BigInt(ask.amt)).toString(),
          buyer: "demo-buyer", seller: ask.seller, ts: Date.now(), demo: true,
        });
        back.remove(); rerender(); toast("Simulated fill recorded on the demo tape");
      });
      return;
    }

    // live fill: verify the presignature first, then cross-check the lot on
    // the indexer before any buyer input is attached
    const v = M.verifyListing(ask, network());
    $("#fill-verify", m).innerHTML = v.ok
      ? `<div class="banner info">Seller 0x83 presignature <strong>verified</strong> — the price, lot outpoint and seller address match the signature. Cross-checking the lot's ticker/amount on the indexer…</div>`
      : `<div class="banner warn"><strong>Presignature invalid:</strong> ${esc(v.reason)}. Do not fill this listing.</div>`;
    if (!v.ok) return;
    $("#fill-body", m).innerHTML = `<p class="muted">Checking the indexer record…</p>`;
    crossCheckListing(ask).then((chk) => {
      if (!chk.ok) {
        $("#fill-body", m).innerHTML = `<div class="banner warn"><strong>Indexer mismatch — do not fill:</strong> ${esc(chk.reason)}</div>`;
        $("#fill-verify", m).innerHTML = `<div class="banner warn">Indexer cross-check failed.</div>`;
        return;
      }
      $("#fill-verify", m).innerHTML = `<div class="banner ${chk.soft ? "local" : "info"}">${chk.soft ? esc(chk.note) : "<strong>Indexer record matches.</strong> " + esc(chk.note)}</div>`;
      showFillForm();
    }).catch((e) => {
      $("#fill-body", m).innerHTML = `<div class="banner warn"><strong>Indexer check failed:</strong> ${esc(e.message)} — refusing to proceed. Try again when the indexer is reachable.</div>`;
    });
    return;

    function showFillForm() {
    $("#fill-body", m).innerHTML = `
      <div class="field"><label>Your Pearl address (buyer)</label>
        <input id="fill-buyer" class="mono" value="${esc(settings.address)}" placeholder="prl1..."></div>
      <div class="field"><label>Your key (mnemonic, WIF, or hex — memory only, never stored)</label>
        <input id="fill-key" type="password" placeholder="paste key to sign" autocomplete="off"></div>
      <div id="fill-quote"></div>
      <div style="display:flex;gap:0.75rem;margin-top:1rem">
        <button class="btn btn-ghost" id="fill-estimate" type="button">Estimate fee</button>
        <button class="btn btn-primary" id="fill-go" type="button" disabled>Sign &amp; broadcast</button>
      </div>
      <p class="hint muted small" style="margin-top:0.75rem">You pay the network fee. The lot UTXO moves to your address; the indexer credits the tokens to you on confirmation.</p>`;

    let quote = null;
    $("#fill-estimate", m).addEventListener("click", async () => {
      try {
        const buyerAddress = $("#fill-buyer", m).value.trim();
        const w = walletFromKeyInput($("#fill-key", m).value);
        if (w.address !== buyerAddress) throw new Error("key does not match the buyer address");
        toast("Fetching buyer UTXOs…");
        const utxos = await spendableBuyerUtxos(buyerAddress);
        const rate = await M.fetchFeeRateGrainsPerVByte(settings.blockbookBase);
        const withKeys = utxos.map((u) => ({ ...u, priv: w.priv, internalXOnly: w.internalXOnly }));
        quote = { withKeys, rate, wallet: w, buyerAddress };
        const sel = M.selectFillCoins({ buyerUtxos: withKeys, priceGrains: ask.priceGrains, feeRate: rate });
        quote.sel = sel;
        $("#fill-quote", m).innerHTML = `
          <div class="review-box"><dl class="kv">
            <dt>Price</dt><dd>${esc(M.fmtPRL(ask.priceGrains))} PRL</dd>
            <dt>Est. fee (buyer pays)</dt><dd>${esc(M.fmtPRL(sel.feeGrains))} PRL</dd>
            <dt>Inputs</dt><dd>${sel.inputs.length} (+ 1 lot input)</dd>
            <dt>Change</dt><dd>${esc(M.fmtPRL(sel.changeGrains))} PRL</dd>
            <dt>Total from you</dt><dd class="total">${esc(M.fmtPRL(BigInt(ask.priceGrains) + BigInt(sel.feeGrains)))} PRL</dd>
          </dl></div>`;
        $("#fill-go", m).disabled = false;
      } catch (e) { toast("Estimate failed: " + e.message); }
    });

    $("#fill-go", m).addEventListener("click", async () => {
      if (!quote) return;
      try {
        $("#fill-go", m).disabled = true;
        toast("Building + signing fill…");
        const fill = M.buildFillTx({
          network: network(), listing: ask,
          buyerUtxos: quote.withKeys, buyerAddress: quote.buyerAddress, feeRate: quote.rate,
        });
        toast("Broadcasting…");
        const txid = await M.broadcastTx(settings.blockbookBase, fill.hex);
        M.boardAddTrade({
          tick, amount: ask.amt, priceGrains: ask.priceGrains,
          pricePerTokenGrains: (BigInt(ask.priceGrains) / BigInt(ask.amt)).toString(),
          buyer: quote.buyerAddress, seller: ask.seller, txid, ts: Date.now(),
        });
        // delist locally — the lot is spent
        if (ask.boardId) M.boardCancelListing(ask.boardId);
        $("#fill-body", m).innerHTML = `
          <div class="banner info"><strong>Fill broadcast.</strong><br>
          <span class="mono small">${esc(txid)}</span><br>
          <span class="muted small">The lot moves to your address; the indexer credits ${esc(M.fmtInt(ask.amt))} ${esc(ask.tick.toUpperCase())} to you on confirmation.</span></div>
          <button class="btn btn-ghost" id="fill-done" type="button">Done</button>`;
        $("#fill-done", m).addEventListener("click", () => { back.remove(); rerender(); });
      } catch (e) { toast("Fill failed: " + e.message); $("#fill-go", m).disabled = false; }
    });
  } // end showFillForm
  } // end openFillModal

  /* ================================================================
     PORTFOLIO
     ================================================================ */
  function initPortfolio() {
    refreshConn();
    $("#demo-slot").innerHTML = demoBanner();
    $("#local-slot").innerHTML = localBanner();

    const render = () => {
      const addr = ($("#pf-address").value.trim() || settings.address).trim();
      const board = M.loadBoard();
      const mine = (l) => l.seller === addr || l.buyerAddress === addr;
      const listings = board.listings.filter((l) => l.seller === addr);
      const bids = board.bids.filter((b) => b.buyerAddress === addr);
      const trades = board.trades.filter((x) => x.buyer === addr || x.seller === addr)
        .sort((a, b) => b.ts - a.ts);

      if (!addr) {
        $("#pf-body").innerHTML = `<div class="banner info">Enter your Pearl address above to see your listings, bids and trades.</div>`;
        return;
      }
      const listingRows = listings.map((l) => `
        <tr><td><a href="token.html?tick=${esc(l.tick)}"><strong>${esc(l.tick.toUpperCase())}</strong></a></td>
          <td class="num">${esc(M.fmtInt(l.amt))}</td>
          <td class="num">${esc(M.fmtPRL(l.priceGrains))} PRL</td>
          <td class="tape-side">${esc(M.expiryLabel(l.expiry))}</td>
          <td><button class="btn btn-danger btn-small" data-cancel-listing="${esc(l.boardId)}" type="button">Cancel</button></td></tr>`).join("");
      const bidRows = bids.map((b) => `
        <tr><td><a href="token.html?tick=${esc(b.tick)}"><strong>${esc(b.tick.toUpperCase())}</strong></a></td>
          <td class="num">${esc(M.fmtInt(b.amount))}</td>
          <td class="num">${esc(M.fmtPRL(b.maxPrice))} PRL</td>
          <td><button class="btn btn-danger btn-small" data-cancel-bid="${esc(b.boardId)}" type="button">Cancel</button></td></tr>`).join("");
      const tradeRows = trades.map((x) => `
        <tr><td class="tape-side">${esc(M.timeAgo(x.ts))}${x.demo ? ' <span class="pill demo">demo</span>' : ""}</td>
          <td><strong>${esc(x.tick.toUpperCase())}</strong></td>
          <td class="num">${esc(M.fmtInt(x.amount))}</td>
          <td class="num">${esc(M.fmtPRL(x.priceGrains))} PRL</td>
          <td class="${x.buyer === addr ? "up" : "down"}">${x.buyer === addr ? "bought" : "sold"}</td></tr>`).join("");

      $("#pf-body").innerHTML = `
        <h2>My listings <span class="pill local">local</span></h2>
        ${listings.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Token</th><th class="num">Amount</th><th class="num">Price</th><th>Expiry</th><th></th></tr></thead><tbody>${listingRows}</tbody></table></div>
        <p class="muted small">Cancel only removes the listing from this browser's board — the on-chain lot stays yours.</p>`
          : `<p class="muted">No listings. <a href="list.html">List a lot</a>.</p>`}
        <h2 style="margin-top:2rem">My bids <span class="pill local">local</span></h2>
        ${bids.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Token</th><th class="num">Amount</th><th class="num">Max price</th><th></th></tr></thead><tbody>${bidRows}</tbody></table></div>` : `<p class="muted">No bids.</p>`}
        <h2 style="margin-top:2rem">My trades</h2>
        ${trades.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Time</th><th>Token</th><th class="num">Amount</th><th class="num">Total</th><th>Side</th></tr></thead><tbody>${tradeRows}</tbody></table></div>` : `<p class="muted">No trades on the local tape yet.</p>`}`;

      $$("[data-cancel-listing]").forEach((b) => b.addEventListener("click", () => {
        M.boardCancelListing(b.getAttribute("data-cancel-listing"));
        toast("Listing removed from the local board"); render();
      }));
      $$("[data-cancel-bid]").forEach((b) => b.addEventListener("click", () => {
        M.boardCancelBid(b.getAttribute("data-cancel-bid"));
        toast("Bid removed from the local board"); render();
      }));
      void mine;
    };

    if (settings.address) $("#pf-address").value = settings.address;
    $("#pf-show").addEventListener("click", render);
    render();
  }

  /* ================================================================
     LIST WIZARD
     ================================================================ */
  function initList() {
    refreshConn();
    $("#demo-slot").innerHTML = demoBanner();
    const presetTick = new URLSearchParams(location.search).get("tick");
    const W = { step: 1, wallet: null, address: settings.address, lot: null, tick: presetTick || "", amt: "", decimals: 18, pricePerToken: "", expiryDays: 7, listing: null };

    const steps = ["Identity", "Pick a lot", "Set price", "Review & sign"];
    const renderSteps = () => {
      $("#wizard-steps").innerHTML = steps.map((s, i) => `
        <div class="step-dot ${i + 1 === W.step ? "active" : ""} ${i + 1 < W.step ? "done" : ""}">
          <span class="n">${i + 1}</span>${esc(s)}</div>`).join("");
    };

    const show = (html) => { $("#wizard-panel").innerHTML = html; };

    /* ---- step 1: identity ---- */
    function step1() {
      W.step = 1; renderSteps();
      show(`
        <h2>Who is selling?</h2>
        <p class="muted">Your keys stay in memory only — they are never stored or sent anywhere. You need the key that controls the lot's address to presign the listing.</p>
        <div class="field"><label>Your Pearl address</label>
          <input id="w-address" class="mono" value="${esc(W.address)}" placeholder="prl1..."></div>
        <div class="field"><label>Key for this address (mnemonic, WIF, or hex priv) — needed at signing</label>
          <input id="w-key" type="password" placeholder="paste when ready to sign" autocomplete="off">
          <p class="hint">You can pick the lot first and paste the key at the review step.</p></div>
        <div class="wizard-nav"><span></span><button class="btn btn-primary" id="w-next" type="button">Continue</button></div>`);
      $("#w-next").addEventListener("click", () => {
        const addr = $("#w-address").value.trim();
        if (!addr) { toast("Enter your Pearl address"); return; }
        try { M.decodeBech32m(addr, network().hrp); } catch { toast("Not a valid " + network().hrp + " address"); return; }
        W.address = addr;
        const k = $("#w-key").value;
        if (k.trim()) {
          try {
            const w = walletFromKeyInput(k);
            if (w.address !== addr) { toast("Key does not match the address"); return; }
            W.wallet = w; keys.wallet = w;
          } catch (e) { toast("Key error: " + e.message); return; }
        }
        $("#w-key").value = "";
        step2();
      });
    }

    /* ---- step 2: pick lot ---- */
    async function step2() {
      W.step = 2; renderSteps();
      show(`<h2>Pick the lot to sell</h2>
        <p class="muted">A lot is a transfer inscription UTXO — the whole lot sells atomically.</p>
        <div id="lot-list"><p class="muted">Loading transfer lots…</p></div>
        <hr class="divider">
        <h3>Or create a new transfer lot</h3>
        <p class="muted small">Inscribe a <span class="mono">transfer</span> op (commit + reveal) from your available balance. Needs Blockbook for UTXOs/fees and your key.</p>
        <div class="input-row">
          <div class="field"><label>Tick</label><input id="nl-tick" value="${esc(W.tick)}" placeholder="prls"></div>
          <div class="field"><label>Amount (base units)</label><input id="nl-amt" placeholder="100000"></div>
        </div>
        <button class="btn btn-ghost" id="nl-go" type="button">Inscribe transfer lot</button>
        <div id="nl-status" style="margin-top:1rem"></div>
        <div class="wizard-nav"><button class="btn btn-ghost" id="w-back" type="button">Back</button><span></span></div>`);
      $("#w-back").addEventListener("click", step1);

      // load lots from indexer
      const listEl = $("#lot-list");
      if (!settings.indexerBase) {
        listEl.innerHTML = `<div class="banner info">Indexer not configured — point it at a Pearlscriptions indexer in <a href="./#settings">Settings</a>, or create a new transfer lot below.</div>`;
      } else {
        try {
          const { transferLots } = await M.idxGetTransferLots(settings.indexerBase, W.address);
          const utxos = await M.idxGetUtxos(settings.indexerBase, W.address).catch(() => []);
          const valByOutpoint = new Map(utxos.map((u) => [u.outpoint, Number(u.valueGrain)]));
          if (!transferLots.length) {
            listEl.innerHTML = `<div class="banner info">No transferable lots found for this address.</div>`;
          } else {
            listEl.innerHTML = transferLots.map((lot, i) => {
              const val = valByOutpoint.get(lot.currentOutpoint);
              const { txid, vout } = M.parseOutpoint(lot.currentOutpoint);
              return `<label class="lot-option" data-lot="${i}">
                <input type="radio" name="lot" value="${i}">
                <div><strong>${esc((lot.displayTicker || lot.ticker).toUpperCase())}</strong>
                  <span class="muted">· ${esc(M.fmtInt(lot.amount))} base units</span><br>
                  <span class="mono small muted">${esc(txid.slice(0, 20))}…:${vout} · ${val != null ? val + " grains" : "value unknown"}</span>
                  ${lot.locationStatus === "mempool" ? ' <span class="pill local">mempool</span>' : ""}</div>
              </label>`;
            }).join("") + `<button class="btn btn-primary" id="lot-pick" type="button" style="margin-top:0.5rem">Sell selected lot</button>`;
            const lots = transferLots;
            $$("#lot-list .lot-option").forEach((o) => o.addEventListener("click", () => {
              $$("#lot-list .lot-option").forEach((x) => x.classList.remove("selected"));
              o.classList.add("selected");
              o.querySelector("input").checked = true;
            }));
            $("#lot-pick").addEventListener("click", () => {
              const sel = $("#lot-list input[name=lot]:checked");
              if (!sel) { toast("Select a lot first"); return; }
              const lot = lots[Number(sel.value)];
              const { txid, vout } = M.parseOutpoint(lot.currentOutpoint);
              const val = valByOutpoint.get(lot.currentOutpoint);
              if (val == null) { toast("Lot value unknown — cannot presign without the UTXO value"); return; }
              W.lot = {
                txid, vout, value: val,
                spkHex: M.bytesToHex(M.p2trScriptPubKey(M.decodeBech32m(W.address, network().hrp).program)),
                tick: String(lot.ticker).toLowerCase(), amount: String(lot.amount),
              };
              W.tick = W.lot.tick; W.amt = W.lot.amount;
              step3();
            });
          }
        } catch (e) {
          listEl.innerHTML = `<div class="banner warn">Could not load lots: ${esc(e.message)}</div>`;
        }
      }

      // new-lot inscription flow
      $("#nl-go").addEventListener("click", async () => {
        const st = $("#nl-status");
        try {
          const tick = $("#nl-tick").value.trim().toLowerCase();
          const amt = $("#nl-amt").value.trim();
          if (!W.wallet) throw new Error("paste your key in step 1 first (needed to sign the reveal)");
          st.innerHTML = `<p class="muted">Planning inscription…</p>`;
          const utxos = await M.fetchUtxos(settings.blockbookBase, W.address);
          const rate = await M.fetchFeeRateGrainsPerVByte(settings.blockbookBase);
          const plan = M.planTransferLot({ network: network(), wallet: W.wallet, utxos, tick, amt, feeRate: rate });
          st.innerHTML = `<div class="review-box"><dl class="kv">
              <dt>Inscription</dt><dd>${esc(plan.json)}</dd>
              <dt>Commit fee</dt><dd>${esc(M.fmtPRL(plan.commitFeeGrains))} PRL</dd>
              <dt>Reveal fee</dt><dd>${esc(M.fmtPRL(plan.revealFeeGrains))} PRL</dd>
              <dt>Commit tx</dt><dd>${esc(plan.commitTx.txid)}</dd></dl>
            <button class="btn btn-primary" id="nl-broadcast" type="button">Broadcast commit, then reveal</button></div>`;
          $("#nl-broadcast").addEventListener("click", async () => {
            try {
              st.innerHTML = `<p class="muted">Broadcasting commit…</p>`;
              const cTxid = await M.broadcastTx(settings.blockbookBase, plan.commitTx.hex);
              st.innerHTML = `<p class="muted">Commit ${esc(cTxid.slice(0, 16))}… broadcast. Waiting 20s for propagation before reveal…</p>`;
              await new Promise((r) => setTimeout(r, 20000));
              st.innerHTML = `<p class="muted">Broadcasting reveal…</p>`;
              const rTxid = await M.broadcastTx(settings.blockbookBase, plan.revealTx.hex);
              W.lot = { txid: plan.lot.txid, vout: 0, value: plan.lot.value, spkHex: plan.lot.spkHex, tick: plan.lot.tick, amount: plan.lot.amount };
              W.tick = W.lot.tick; W.amt = W.lot.amount;
              st.innerHTML = `<div class="banner info"><strong>Lot inscribed.</strong> Reveal ${esc(rTxid.slice(0, 16))}… — wait for confirmation, then continue.</div>
                <button class="btn btn-primary" id="nl-continue" type="button">Continue to pricing</button>`;
              $("#nl-continue").addEventListener("click", step3);
            } catch (e) { st.innerHTML = `<div class="banner warn">Broadcast failed: ${esc(e.message)}</div>`; }
          });
        } catch (e) { st.innerHTML = `<div class="banner warn">${esc(e.message)}</div>`; }
      });
    }

    /* ---- step 3: price ---- */
    async function step3() {
      W.step = 3; renderSteps();
      let decimals = W.decimals;
      if (settings.indexerBase && !settings.demo) {
        try { const info = await M.idxGetToken(settings.indexerBase, W.tick); if (info && info.decimals != null) decimals = Number(info.decimals); }
        catch { /* keep default */ }
      } else if (settings.demo) {
        const dt = M.demoTokens(network()).find((x) => x.ticker === W.tick);
        if (dt) decimals = Number(dt.decimals);
      }
      W.decimals = decimals;
      show(`
        <h2>Set the price</h2>
        <p class="muted">Selling <strong>${esc(M.fmtInt(W.amt))}</strong> base units of <strong>${esc(W.tick.toUpperCase())}</strong>.</p>
        <div class="input-row">
          <div class="field"><label>Price per whole token (PRL)</label>
            <input id="p-per" inputmode="decimal" placeholder="0.025" value="${esc(W.pricePerToken)}"></div>
          <div class="field"><label>Token decimals</label>
            <input id="p-dec" inputmode="numeric" value="${decimals}"></div>
        </div>
        <div class="field"><label>Listing duration</label>
          <select id="p-exp">
            <option value="1">24 hours</option>
            <option value="7" selected>7 days</option>
            <option value="30">30 days</option>
          </select></div>
        <div class="review-box"><dl class="kv">
          <dt>Total price</dt><dd class="total" id="p-total">—</dd>
          <dt>You receive</dt><dd id="p-recv">—</dd></dl>
          <p class="hint muted small">The buyer pays the network fee on fill. Your presignature commits to this exact total.</p></div>
        <div class="wizard-nav"><button class="btn btn-ghost" id="w-back" type="button">Back</button>
          <button class="btn btn-primary" id="w-next" type="button">Review</button></div>`);
      $("#w-back").addEventListener("click", step2);
      const recalc = () => {
        try {
          const per = M.parsePRL($("#p-per").value.trim() || "0");
          const dec = Number($("#p-dec").value);
          if (!Number.isInteger(dec) || dec < 0 || dec > 18) throw new Error("decimals 0-18");
          const total = (per * BigInt(W.amt)) / (10n ** BigInt(dec));
          if (total <= 0n) throw new Error("total must be positive");
          $("#p-total").textContent = M.fmtPRL(total) + " PRL";
          $("#p-recv").textContent = "≈ " + M.fmtPRL(total) + " PRL (minus nothing — buyer pays fees)";
          return { total, dec };
        } catch (e) { $("#p-total").textContent = "—"; $("#p-recv").textContent = esc(e.message); return null; }
      };
      ["p-per", "p-dec"].forEach((id) => $("#" + id).addEventListener("input", recalc));
      recalc();
      $("#w-next").addEventListener("click", () => {
        const r = recalc();
        if (!r) { toast("Fix the price first"); return; }
        W.pricePerToken = $("#p-per").value.trim();
        W.priceTotal = r.total.toString();
        W.decimals = r.dec;
        W.expiryDays = Number($("#p-exp").value);
        step4();
      });
    }

    /* ---- step 4: review + sign + publish ---- */
    function step4() {
      W.step = 4; renderSteps();
      const needKey = !W.wallet;
      show(`
        <h2>Review &amp; sign</h2>
        <div class="review-box"><dl class="kv">
          <dt>Token</dt><dd>${esc(W.tick.toUpperCase())} — ${esc(M.fmtInt(W.amt))} base units</dd>
          <dt>Total price</dt><dd class="total">${esc(M.fmtPRL(W.priceTotal))} PRL</dd>
          <dt>Seller</dt><dd>${esc(W.address)}</dd>
          <dt>Lot</dt><dd>${esc(W.lot.txid.slice(0, 24))}…:${W.lot.vout}</dd>
          <dt>Expires</dt><dd>${W.expiryDays} day(s)</dd></dl></div>
        <div class="banner info">Your signature uses <span class="mono">SIGHASH_SINGLE | ANYONECANPAY (0x83)</span>:
          it commits to the lot outpoint and this exact price output — nothing else.
          The buyer appends their own inputs; they cannot change your price.</div>
        ${needKey ? `<div class="field"><label>Key for ${esc(M.shortAddr(W.address))} (memory only)</label>
          <input id="w-key2" type="password" autocomplete="off"></div>` : ""}
        <div id="sign-out"></div>
        <div class="wizard-nav"><button class="btn btn-ghost" id="w-back" type="button">Back</button>
          <button class="btn btn-primary" id="w-sign" type="button">Sign listing</button></div>`);
      $("#w-back").addEventListener("click", step3);
      $("#w-sign").addEventListener("click", () => {
        try {
          let w = W.wallet;
          if (!w) {
            w = walletFromKeyInput($("#w-key2").value);
            if (w.address !== W.address) throw new Error("key does not match the seller address");
            W.wallet = w;
          }
          const unsigned = M.makeListing({
            tick: W.tick, amt: W.amt,
            lotTxid: W.lot.txid, lotVout: W.lot.vout, lotValue: W.lot.value, lotSpkHex: W.lot.spkHex,
            priceGrains: W.priceTotal, seller: W.address,
            expiry: Date.now() + W.expiryDays * 86400000,
          });
          const signed = M.signListing(unsigned, w, network());
          W.listing = signed;
          const chk = M.verifyListing(signed, network());
          $("#sign-out").innerHTML = `
            <div class="banner ${chk.ok ? "info" : "warn"}">Presignature ${chk.ok ? "<strong>valid</strong> — verified locally before publishing." : "INVALID: " + esc(chk.reason)}</div>
            <div class="field"><label>Signed listing (shareable JSON)</label>
              <textarea class="mono" rows="4" readonly>${esc(M.encodeListing(signed))}</textarea></div>
            <button class="btn btn-primary" id="w-publish" type="button" ${chk.ok ? "" : "disabled"}>Publish to local board</button>`;
          const pub = $("#w-publish");
          if (pub) pub.addEventListener("click", () => {
            const id = M.boardAddListing(signed);
            $("#wizard-panel").innerHTML = `
              <h2>Listed</h2>
              <div class="banner local">Published to the <strong>local board</strong> — visible only in this browser. No listing relay is configured.</div>
              <p class="muted">Your lot stays in your wallet until a buyer fills the listing with an atomic swap.</p>
              <div style="display:flex;gap:0.75rem"><a class="btn btn-primary" href="token.html?tick=${esc(W.tick)}">View market</a>
              <a class="btn btn-ghost" href="portfolio.html">My portfolio</a></div>`;
            void id;
          });
        } catch (e) { toast("Signing failed: " + e.message); }
      });
    }

    renderSteps();
    step1();
  }

  /* ================================================================
     ROUTER
     ================================================================ */
  function boot() {
    const page = document.body.getAttribute("data-page");
    try {
      if (page === "home") initHome();
      else if (page === "token") initToken();
      else if (page === "portfolio") initPortfolio();
      else if (page === "list") initList();
    } catch (e) {
      console.error(e);
      toast("Page error: " + e.message);
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  // exposed for headless smoke tests
  window.__bazaar = { initHome, initToken, initPortfolio, initList, toast };
})();


