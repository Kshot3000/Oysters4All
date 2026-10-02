/* Pearl Auction UI — list / commit / reveal / settle / verify / track.
 * All hashing runs through the window.PearlAuction bundle (audited Sign lineage);
 * this file is pure UI wiring. No secrets exist in this flow; nothing is stored
 * server-side. Blockbook is only ever read, never trusted blindly. */
(() => {
  "use strict";
  const E = window.PearlAuction;
  if (!E) { document.body.innerHTML = "<p style='padding:2rem'>Failed to load pearl-auction.bundle.js</p>"; return; }

  const $ = (id) => document.getElementById(id);

  /* storage that survives hostile localStorage */
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return this.m?.[k] ?? null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { (this.m ??= {})[k] = v; } },
  };

  const S = {
    network: E.NETWORKS.mainnet,
    blockbook: store.get("auction.blockbook") || E.NETWORKS.mainnet.blockbook,
    liTip: null,
    liResult: null,      // forgeAuction() result
    ledger: E.emptyLedger(),
    reveals: [],         // applyReveal() results, in reveal order
    stResult: null,
  };

  const err = (id, msg) => { const e = $(id); e.hidden = !msg; e.textContent = msg || ""; };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtPRL = (g) => E.fmtPRL(typeof g === "bigint" ? g : BigInt(g)) + " PRL";
  const shortAddr = (a) => esc(a.slice(0, 14)) + "…" + esc(a.slice(-10));

  document.querySelectorAll(".copy-btn").forEach((b) => b.addEventListener("click", async () => {
    const t = $(b.dataset.for);
    const txt = t.value !== undefined && t.tagName !== "CODE" ? t.value : t.textContent;
    try { await navigator.clipboard.writeText(txt); b.textContent = "Copied"; }
    catch { b.textContent = "Copy failed"; }
    setTimeout(() => { b.textContent = "Copy"; }, 1500);
  }));

  /* ---------- step navigation ---------- */
  const STEPS = ["list", "commit", "reveal", "settle", "verify", "track"];
  function goto(step) {
    STEPS.forEach((s) => {
      $("step-" + s).classList.toggle("active", s === step);
      const b = document.querySelector(`#steps button[data-step="${s}"]`);
      if (b) {
        b.classList.toggle("active", s === step);
        if (STEPS.indexOf(s) < STEPS.indexOf(step)) b.classList.add("done");
      }
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  document.querySelectorAll("#steps button").forEach((b) => b.addEventListener("click", () => goto(b.dataset.step)));

  function blockbookBase(fallbackInputId) {
    const v = ($(fallbackInputId).value || S.blockbook || "").trim().replace(/\/+$/, "");
    if (v) { S.blockbook = v; store.set("auction.blockbook", v); }
    return v;
  }

  function renderQR(el, text) {
    el.innerHTML = "";
    try {
      if (typeof window.qrcode === "undefined") throw new Error("qr lib missing");
      const qr = window.qrcode(0, "M");
      qr.addData(text);
      qr.make();
      el.innerHTML = qr.createImgTag(4, 8);
    } catch {
      el.innerHTML = "<p class='hint'>QR too large — copy the URI instead.</p>";
    }
  }

  const eta = (blocks) => {
    const s = blocks * E.BLOCK_TARGET_S;
    if (s < 90) return `~${Math.max(1, Math.round(s / 60))} min`;
    const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
    if (h < 48) return `~${h}h ${m}m`;
    return `~${(h / 24).toFixed(1)} days`;
  };

  /* ================= LIST ================= */
  $("li-network").addEventListener("change", (e) => {
    S.network = E.NETWORKS[e.target.value];
    if (!store.get("auction.blockbook")) { S.blockbook = S.network.blockbook || ""; $("li-blockbook").value = S.blockbook; }
    S.liResult = null;
    $("li-out").hidden = true;
    err("li-error", "");
  });
  $("li-blockbook").value = S.blockbook || "";
  $("li-nonce").value = E.genNonceHex();
  $("li-new-nonce").addEventListener("click", () => { $("li-nonce").value = E.genNonceHex(); });

  $("li-tip").addEventListener("click", async () => {
    err("li-error", "");
    try {
      const base = blockbookBase("li-blockbook");
      if (!base) throw new Error("no Blockbook endpoint — enter the tip manually instead");
      const h = await E.fetchTipHeight(base);
      S.liTip = h;
      $("li-tip-manual").value = "";
      $("li-tip-out").hidden = false;
      $("li-tip-out").textContent = `Chain tip: block ${h.toLocaleString()} (Blockbook). Commit deadline must be at least ${h + 2}.`;
    } catch (e) { err("li-error", "tip lookup failed: " + e.message + " — enter the tip manually"); }
  });

  $("li-button").addEventListener("click", () => {
    err("li-error", "");
    try {
      const minBid = E.parsePRL($("li-minbid").value.trim());
      const commitRaw = $("li-commith").value.trim();
      const revealRaw = $("li-revealh").value.trim();
      if (!/^\d+$/.test(commitRaw)) throw new Error("commit deadline must be a positive integer block height");
      if (!/^\d+$/.test(revealRaw)) throw new Error("reveal deadline must be a positive integer block height");
      let tip = S.liTip;
      const manual = $("li-tip-manual").value.trim();
      if (manual) {
        if (!/^\d+$/.test(manual)) throw new Error("manual tip must be a non-negative integer");
        tip = Number(manual);
      }
      if (tip == null) throw new Error("need the current chain height — read it from Blockbook or enter it manually");
      const forged = E.forgeAuction({
        network: S.network,
        name: $("li-name").value,
        description: $("li-desc").value,
        imageUrl: $("li-image").value,
        seller: $("li-seller").value,
        minBidGrains: minBid,
        commitH: Number(commitRaw),
        revealH: Number(revealRaw),
        nonce: $("li-nonce").value,
        currentHeight: tip,
      });
      S.liResult = forged;
      const listedAt = new Date().toISOString();
      $("li-descriptor").value = forged.descriptor;
      $("li-commit-height").textContent = String(forged.commitH);
      $("li-dhash").textContent = forged.descriptorHash;
      $("li-publish").value =
        `PEARL-AUCTION:v1 — sealed-bid auction listing\n${forged.descriptor}\nSHA-256: ${forged.descriptorHash}\n` +
        `item: ${forged.item.name}\nlisted: ${listedAt}\n` +
        `MUST be published BEFORE block ${forged.commitH}. Minimum bid ${fmtPRL(forged.minBidGrains)} · ` +
        `commit by block ${forged.commitH} · reveal by block ${forged.revealH}.\n` +
        `Rules: one bidder, one commitment (second commitment = flagged, both excluded); ` +
        `ties broken by earliest reveal; winner pays the seller directly.`;
      $("li-listed-at").textContent = listedAt;
      $("li-minbid-out").textContent = fmtPRL(forged.minBidGrains);
      $("li-commith-out").textContent = String(forged.commitH);
      $("li-revealh-out").textContent = String(forged.revealH);
      $("li-out").hidden = false;
      $("st-seller").value = forged.item.seller;
      document.querySelector('#steps button[data-step="list"]').classList.add("done");
    } catch (e) { err("li-error", e.message); }
  });

  $("li-download").addEventListener("click", () => {
    if (!S.liResult) return;
    const f = S.liResult;
    const data = {
      kind: "pearl-auction-listing", version: 1,
      descriptor: f.descriptor, descriptorHash: f.descriptorHash,
      network: f.network.hrp,
      item: {
        name: f.item.name, description: f.item.description,
        imageUrl: f.item.imageUrl, seller: f.item.seller,
      },
      itemHash: f.itemHash,
      minBidGrains: f.minBidGrains.toString(), minBidPRL: E.fmtPRL(f.minBidGrains),
      commitH: f.commitH, revealH: f.revealH, nonce: f.nonce,
      rules: [
        "One bidder, one commitment. A second commitment from the same address is flagged and both are excluded.",
        "Commitment hashes must be published before the commit deadline block; late hashes are refused.",
        "Reveals are accepted after the commit deadline and before the reveal deadline; (bid, salt) must reproduce the recorded commitment or the bid is refused.",
        "Bids below the minimum are refused. Highest verified bid wins; ties are broken by earliest reveal.",
        "The winner pays the seller directly, off-page. This page never moves PRL.",
      ],
      listedAt: new Date().toISOString(),
    };
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    a.download = "pearl-auction-listing.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });

  $("li-carry").addEventListener("click", () => {
    if (S.liResult) $("cm-descriptor").value = S.liResult.descriptor;
    goto("commit");
  });

  /* ================= COMMIT ================= */
  function currentDescriptor(whichInput) {
    return $(whichInput).value.trim();
  }

  $("cm-new-salt").addEventListener("click", () => {
    try { $("cm-salt").value = E.genSaltHex(); err("cm-error", ""); }
    catch (e) { err("cm-error", e.message); }
  });

  $("cm-button").addEventListener("click", () => {
    err("cm-error", "");
    try {
      const d = E.parseDescriptor(currentDescriptor("cm-descriptor"));
      const addr = E.validBidderAddress($("cm-address").value, d.network);
      const bid = E.parsePRL($("cm-bid").value.trim());
      if (bid < d.minBidGrains) throw new Error(`bid of ${fmtPRL(bid)} is below the auction minimum of ${fmtPRL(d.minBidGrains)}`);
      const salt = $("cm-salt").value.trim().toLowerCase();
      const c = E.makeCommitment({ descriptorHash: d.descriptorHash, bidderAddr: addr, bidGrains: bid, saltHex: salt });
      $("cm-hash").textContent = c.commitment;
      $("cm-bid-out").textContent = `${fmtPRL(bid)} (${bid} grains)`;
      $("cm-salt-out").textContent = c.saltHex;
      $("cm-preimage").textContent = c.preimage;
      $("cm-out").hidden = false;
      $("cm-rec-hash").value = c.commitment;
      $("cm-rec-address").value = addr;
    } catch (e) { err("cm-error", e.message); $("cm-out").hidden = true; }
  });

  function renderLedger() {
    const n = S.ledger.commitments.length;
    $("cm-count").textContent = String(n);
    if (n === 0) { $("cm-ledger-wrap").hidden = true; return; }
    $("cm-ledger").innerHTML = S.ledger.commitments.map((c, i) =>
      `<tr><td>${i + 1}</td><td class="addr">${esc(c.address)}</td><td class="mono">${esc(c.commitment)}</td><td class="num">${c.tipHeight}</td></tr>`).join("");
    $("cm-ledger-wrap").hidden = false;
  }

  async function tipFromBlockbook(inputId, outSetter) {
    const base = blockbookBase(inputId);
    if (!base) throw new Error("no Blockbook endpoint — enter the height manually instead");
    const h = await E.fetchTipHeight(base);
    outSetter(h);
    return h;
  }

  $("cm-rec-fetch-tip").addEventListener("click", async () => {
    err("cm-rec-error", "");
    try { await tipFromBlockbook("li-blockbook", (h) => { $("cm-rec-tip").value = String(h); }); }
    catch (e) { err("cm-rec-error", e.message); }
  });

  $("cm-record").addEventListener("click", () => {
    err("cm-rec-error", "");
    try {
      const desc = currentDescriptor("cm-descriptor");
      const tipRaw = $("cm-rec-tip").value.trim();
      if (!/^\d+$/.test(tipRaw)) throw new Error("current chain height must be a non-negative integer (read it from Blockbook or enter it)");
      E.recordCommitment(S.ledger, {
        descriptor: desc,
        address: $("cm-rec-address").value,
        commitmentHex: $("cm-rec-hash").value,
        tipHeight: Number(tipRaw),
      });
      renderLedger();
      $("cm-rec-hash").value = "";
      $("cm-rec-address").value = "";
      document.querySelector('#steps button[data-step="commit"]').classList.add("done");
    } catch (e) { err("cm-rec-error", e.message); }
  });

  $("cm-clear").addEventListener("click", () => {
    if (!confirm("Clear the whole commitment ledger and all reveals?")) return;
    S.ledger = E.emptyLedger();
    S.reveals = [];
    renderLedger();
    renderReveals();
  });

  $("cm-carry").addEventListener("click", () => {
    $("rv-descriptor").value = $("cm-descriptor").value;
    goto("reveal");
  });

  /* ================= REVEAL ================= */
  function renderReveals() {
    const n = S.reveals.length;
    $("rv-count").textContent = String(n);
    $("rv-empty").hidden = n !== 0;
    if (n === 0) { $("rv-table-wrap").hidden = true; return; }
    $("rv-table").innerHTML = S.reveals.map((r, i) =>
      `<tr><td>${i + 1}</td><td class="addr">${esc(r.address)}</td><td class="num">${fmtPRL(r.bidGrains)}</td><td class="ok">✓ commitment reproduced</td></tr>`).join("");
    $("rv-table-wrap").hidden = false;
  }

  $("rv-fetch-tip").addEventListener("click", async () => {
    err("rv-error", "");
    try { await tipFromBlockbook("li-blockbook", (h) => { $("rv-tip").value = String(h); }); }
    catch (e) { err("rv-error", e.message); }
  });

  $("rv-button").addEventListener("click", () => {
    err("rv-error", "");
    try {
      const desc = currentDescriptor("rv-descriptor");
      const tipRaw = $("rv-tip").value.trim();
      if (!/^\d+$/.test(tipRaw)) throw new Error("current chain height must be a non-negative integer (read it from Blockbook or enter it)");
      const bid = E.parsePRL($("rv-bid").value.trim());
      const v = E.applyReveal(S.ledger, {
        descriptor: desc,
        address: $("rv-address").value,
        bidGrains: bid,
        saltHex: $("rv-salt").value,
        tipHeight: Number(tipRaw),
      });
      S.reveals.push(v);
      renderReveals();
      $("rv-salt").value = "";
      document.querySelector('#steps button[data-step="reveal"]').classList.add("done");
    } catch (e) { err("rv-error", e.message); }
  });

  $("rv-carry").addEventListener("click", () => {
    $("st-descriptor").value = $("rv-descriptor").value;
    goto("settle");
  });

  /* ================= SETTLE ================= */
  function derivationRowsHtml(res) {
    return res.derivation.map((r) => {
      const order = r.revealOrder == null ? "—" : r.revealOrder;
      const bid = r.bidGrains == null ? "hidden" : esc(E.fmtPRL(r.bidGrains)) + " PRL";
      let check;
      if (r.valid) check = `<span class="ok">${esc(r.check)}</span>`;
      else if (r.excludeReason) check = `<span class="excl">✗ ${esc(r.excludeReason)}</span>`;
      else check = `<span class="excl">✗ ${esc(r.check)}</span>`;
      return `<tr><td>${order}</td><td class="addr">${esc(r.address)}</td><td class="num">${bid}</td><td>${check}</td></tr>`;
    }).join("");
  }

  $("st-button").addEventListener("click", () => {
    err("st-error", "");
    try {
      const desc = currentDescriptor("st-descriptor");
      const d = E.parseDescriptor(desc);
      const commitments = S.ledger.commitments.map((c) => ({ address: c.address, commitment: c.commitment }));
      const reveals = S.reveals.map((r) => ({ address: r.address, bidGrains: r.bidGrains, saltHex: r.saltHex }));
      const res = E.settleAuction({ descriptor: d, commitments, reveals });
      S.stResult = { res, d };
      const box = $("st-verdict");
      if (res.noSale) {
        box.className = "verdict bad";
        box.innerHTML = `<span class="big">✗ NO SALE</span><br><span class="hint">No valid bid at or above the ${esc(fmtPRL(d.minBidGrains))} minimum. The signed result record below proves it.</span>`;
        $("st-payment").innerHTML = `<p class="hint">No winner — no payment plan.</p>`;
      } else {
        const w = res.winner;
        box.className = "verdict ok";
        box.innerHTML = `<span class="big">✓ SOLD</span><br><span class="hint">Highest verified bid wins · tie-break: earliest reveal</span>` +
          `<div class="addr">${esc(w.address)}</div><div class="big">${esc(fmtPRL(w.bidGrains))}</div>` +
          `<div class="hint">reveal #${w.revealOrder} of ${res.validCount} valid reveal(s) · ${res.commitmentCount} commitment(s) recorded</div>`;
        let seller = $("st-seller").value.trim();
        try { if (seller) seller = E.validBidderAddress(seller, d.network); else seller = null; }
        catch { seller = null; }
        if (seller) {
          const uri = E.paymentUri(seller, w.bidGrains);
          $("st-payment").innerHTML =
            `<div class="winner-card"><div class="round">Payment plan — winner pays the seller off-page</div>` +
            `<div class="addr">to seller: ${esc(seller)}</div>` +
            `<div class="prize">${esc(fmtPRL(w.bidGrains))}</div>` +
            `<div class="uri">${esc(uri)}</div>` +
            `<div class="row"><button class="ghost" id="st-show-qr">Show QR</button><button class="ghost" id="st-copy-uri">Copy URI</button></div>` +
            `<div class="qr" id="st-qr"></div>` +
            `<p class="fineprint">This page never moves PRL. The winner scans the QR (or copies the <code>pearl:</code> URI) in their own wallet and pays the seller directly.</p></div>`;
          $("st-show-qr").addEventListener("click", () => renderQR($("st-qr"), uri));
          $("st-copy-uri").addEventListener("click", async (ev) => {
            try { await navigator.clipboard.writeText(uri); ev.target.textContent = "Copied"; }
            catch { ev.target.textContent = "Copy failed"; }
            setTimeout(() => { ev.target.textContent = "Copy URI"; }, 1500);
          });
        } else {
          $("st-payment").innerHTML = `<p class="hint">Enter the seller address above and settle again to build the <code>pearl:</code> payment URI.</p>`;
        }
      }
      $("st-table").innerHTML = derivationRowsHtml(res);
      $("st-record").value = res.resultRecord;
      $("st-out").hidden = false;
      $("st-csv").disabled = false;
      $("st-json").disabled = false;
      document.querySelector('#steps button[data-step="settle"]').classList.add("done");
    } catch (e) { err("st-error", e.message); $("st-out").hidden = true; }
  });

  function download(name, text, type) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  $("st-csv").addEventListener("click", () => {
    if (!S.stResult) return;
    download("pearl-auction-result.csv", E.settleCsv(S.stResult.res), "text/csv");
  });

  $("st-json").addEventListener("click", () => {
    if (!S.stResult) return;
    const { res, d } = S.stResult;
    const data = {
      kind: "pearl-auction-result", version: 1,
      descriptor: d.descriptor, descriptorHash: d.descriptorHash,
      outcome: res.noSale ? "NO_SALE" : "SALE",
      winner: res.winner ? {
        address: res.winner.address,
        bidGrains: res.winner.bidGrains.toString(),
        bidPRL: E.fmtPRL(res.winner.bidGrains),
        revealOrder: res.winner.revealOrder,
      } : null,
      ranking: res.ranked.map((r) => ({ rank: r.rank, address: r.address, bidGrains: r.bidGrains.toString(), revealOrder: r.revealOrder })),
      derivation: res.derivation.map((r) => ({
        revealOrder: r.revealOrder, address: r.address,
        bidGrains: r.bidGrains == null ? null : r.bidGrains.toString(),
        valid: r.valid, check: r.check, excludeReason: r.excludeReason,
      })),
      canonicalSettle: res.canonicalSettle,
      resultHash: res.resultHash,
      resultRecord: res.resultRecord,
      settledAt: res.settledAt,
    };
    download("pearl-auction-result.json", JSON.stringify(data, null, 2), "application/json");
  });

  $("st-carry-verify").addEventListener("click", () => {
    const { res, d } = S.stResult || {};
    if (!d) return;
    $("vf-descriptor").value = d.descriptor;
    $("vf-commitments").value = S.ledger.commitments.map((c) => `${c.address} ${c.commitment}`).join("\n");
    $("vf-reveals").value = S.reveals.map((r) => `${r.address} ${r.bidGrains.toString()} ${r.saltHex}`).join("\n");
    goto("verify");
  });

  /* ================= VERIFY ================= */
  function parseCommitmentLines(text, network) {
    const lines = String(text ?? "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    return lines.map((l, i) => {
      const parts = l.split(/\s+/);
      if (parts.length !== 2) throw new Error(`commitments line ${i + 1}: need "<address> <64-hex-hash>", got: ${l}`);
      const [addr, hash] = parts;
      E.validBidderAddress(addr, network);
      if (!/^[0-9a-f]{64}$/i.test(hash)) throw new Error(`commitments line ${i + 1}: not a 64-hex commitment hash`);
      return { address: E.validBidderAddress(addr, network), commitment: hash.toLowerCase() };
    });
  }

  function parseRevealLines(text, network) {
    const lines = String(text ?? "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    return lines.map((l, i) => {
      const parts = l.split(/\s+/);
      if (parts.length !== 3) throw new Error(`reveals line ${i + 1}: need "<address> <bid> <32-hex-salt>", got: ${l}`);
      const [addr, bidS, salt] = parts;
      E.validBidderAddress(addr, network);
      let bidGrains;
      if (/^\d+$/.test(bidS)) bidGrains = BigInt(bidS);
      else bidGrains = E.parsePRL(bidS);
      if (!/^[0-9a-f]{32}$/i.test(salt)) throw new Error(`reveals line ${i + 1}: salt must be 32 hex chars`);
      return { address: E.validBidderAddress(addr, network), bidGrains, saltHex: salt.toLowerCase() };
    });
  }

  function showVerifyResult(v) {
    const box = $("vf-verdict");
    if (v.noSale) {
      box.className = "verdict ok";
      box.innerHTML = `<span class="big">✓ VERIFIED — NO SALE</span><br><span class="hint">Recomputed locally: no valid bid at or above the minimum. Result hash <code>${esc(v.resultHash)}</code></span>`;
    } else {
      box.className = "verdict ok";
      box.innerHTML = `<span class="big">✓ VERIFIED — SOLD</span><br><span class="hint">Commitments all re-checked · winner recomputed locally</span>` +
        `<div class="addr">${esc(v.winner.address)}</div><div class="big">${esc(fmtPRL(v.winner.bidGrains))}</div>` +
        `<div class="hint">result hash <code>${esc(v.resultHash)}</code></div>`;
    }
    $("vf-table").innerHTML = derivationRowsHtml(v);
    $("vf-record").value = v.resultRecord;
    $("vf-out").hidden = false;
    document.querySelector('#steps button[data-step="verify"]').classList.add("done");
  }

  function showVerifyRefusal(e) {
    const box = $("vf-verdict");
    box.className = "verdict bad";
    box.innerHTML = `<span class="big">✗ NOT PROVEN</span><br>${esc(e.message)}`;
    $("vf-table").innerHTML = "";
    $("vf-record").value = "";
    $("vf-out").hidden = false;
  }

  $("vf-run").addEventListener("click", () => {
    err("vf-error", "");
    try {
      const d = E.parseDescriptor($("vf-descriptor").value);
      const commitments = parseCommitmentLines($("vf-commitments").value, d.network);
      const reveals = parseRevealLines($("vf-reveals").value, d.network);
      const v = E.verifyAuction({ descriptor: d.descriptor, commitments, reveals });
      showVerifyResult(v);
    } catch (e) {
      showVerifyRefusal(e);
      err("vf-error", e.message);
    }
  });

  /* ================= TRACK ================= */
  function loadTrack() {
    const d = E.parseDescriptor($("tk-descriptor").value);
    $("tk-fields").innerHTML =
      `<dt>Network</dt><dd>${esc(d.network.label)} (${esc(d.hrp)})</dd>` +
      `<dt>Minimum bid</dt><dd>${fmtPRL(d.minBidGrains)} (${d.minBidGrains} grains)</dd>` +
      `<dt>Commit deadline</dt><dd>block ${d.commitH}</dd>` +
      `<dt>Reveal deadline</dt><dd>block ${d.revealH}</dd>` +
      `<dt>itemHash</dt><dd>${esc(d.itemHash)}</dd>` +
      `<dt>Descriptor hash</dt><dd>${esc(d.descriptorHash)}</dd>`;
    $("tk-committed").textContent = `${S.ledger.commitments.length} (this ledger)`;
    $("tk-revealed").textContent = `${S.reveals.length} (this ledger)`;
    $("tk-out").hidden = false;
    return d;
  }

  $("tk-load").addEventListener("click", () => {
    err("tk-error", "");
    try { loadTrack(); } catch (e) { err("tk-error", e.message); $("tk-out").hidden = true; }
  });

  $("tk-scan").addEventListener("click", async () => {
    err("tk-error", "");
    try {
      const d = E.parseDescriptor($("tk-descriptor").value);
      $("tk-load").click();
      const base = blockbookBase("tk-blockbook");
      if (!base) throw new Error("no Blockbook endpoint — countdowns need a tip; use the manual paths on other steps");
      const tip = await E.fetchTipHeight(base);
      $("tk-tip").textContent = tip.toLocaleString();
      const cl = d.commitH - tip, rl = d.revealH - tip;
      let phase;
      if (tip < d.commitH) phase = "Commit open";
      else if (tip < d.revealH) phase = "Reveal open";
      else phase = "Closed — ready to settle";
      $("tk-phase").textContent = phase;
      $("tk-commit-left").textContent = cl > 0 ? `${cl.toLocaleString()} (${eta(cl)})` : "passed ✓";
      $("tk-reveal-left").textContent = rl > 0 ? `${rl.toLocaleString()} (${eta(rl)})` : "passed ✓";
      document.querySelector('#steps button[data-step="track"]').classList.add("done");
    } catch (e) { err("tk-error", e.message); }
  });

  renderLedger();
  renderReveals();
})();
