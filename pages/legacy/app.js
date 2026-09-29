/* Pearl Legacy UI — Plan / Vault / Watch / Claim & Refresh / Verifier.
 * All cryptography runs through the window.PearlLegacy bundle (audited Sign
 * lineage); this file is pure UI wiring. Secrets live in page memory only,
 * are wiped from inputs after use, and are never written to storage.
 * Blockbook is only ever read with GET; returned UTXOs are re-checked
 * against the vault contract before being believed. */
(() => {
  "use strict";
  const E = window.PearlLegacy;
  if (!E) { document.body.innerHTML = "<p style='padding:2rem'>Failed to load pearl-legacy.bundle.js</p>"; return; }

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtPRL = (g) => E.fmtPRL(typeof g === "bigint" ? g : BigInt(g)) + " PRL";
  const err = (id, msg) => { const e = $(id); e.hidden = !msg; e.textContent = msg || ""; };
  const radioVal = (name) => { const r = document.querySelector(`input[name="${name}"]:checked`); return r ? r.value : null; };

  /* storage that survives hostile localStorage */
  const store = {
    m: {},
    get(k) { try { return localStorage.getItem(k); } catch { return this.m[k] ?? null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { this.m[k] = v; } },
    del(k) { try { localStorage.removeItem(k); } catch { delete this.m[k]; } },
  };

  const S = {
    network: E.NETWORKS.mainnet,
    blockbook: store.get("legacy.blockbook") || E.NETWORKS.mainnet.blockbook,
    planVault: null,
    vault: null,          // parsed+re-derived vault spec in the Vault/Claim tabs
    vaultJson: "",
    watch: null,          // { tip, utxos:[{txid,vout,value,fundingHeight,status}], vault }
    lastBuild: null,      // { kind, hex, txid, feeGrains, vbytes, vault }
    autoTimer: null,
  };

  /* ---------- step navigation ---------- */
  const STEPS = ["plan", "vault", "watch", "claim", "verify"];
  function goto(step) {
    STEPS.forEach((s) => {
      $("step-" + s).classList.toggle("active", s === step);
      const b = document.querySelector(`#steps button[data-step="${s}"]`);
      if (b) {
        b.classList.toggle("active", s === step);
        if (STEPS.indexOf(s) < STEPS.indexOf(step)) b.classList.add("done");
      }
    });
    window.scrollTo(0, 0);
  }
  document.querySelectorAll("#steps button").forEach((b) =>
    b.addEventListener("click", () => goto(b.dataset.step)));

  /* ---------- copy buttons ---------- */
  document.querySelectorAll(".copy-btn").forEach((b) => b.addEventListener("click", async () => {
    const t = $(b.dataset.for);
    const txt = (t.value !== undefined && t.tagName !== "CODE") ? t.value : t.textContent;
    try { await navigator.clipboard.writeText(txt); b.textContent = "Copied"; }
    catch { b.textContent = "Copy failed"; }
    setTimeout(() => { b.textContent = "Copy"; }, 1500);
  }));

  /* ---------- QR ---------- */
  function drawQR(el, text) {
    el.innerHTML = "";
    try {
      if (!window.qrcode || !text) return;
      const qr = window.qrcode(0, "M");
      qr.addData(text);
      qr.make();
      el.innerHTML = qr.createImgTag(5, 8);
    } catch { /* QR is a convenience; never fatal */ }
  }

  /* ---------- network ---------- */
  function setNetwork(id) {
    S.network = E.NETWORKS[id] || E.NETWORKS.mainnet;
    const def = store.get("legacy.blockbook");
    S.blockbook = def || S.network.blockbook;
    $("w-blockbook").value = S.blockbook;
  }
  $("pl-network").addEventListener("change", (e) => setNetwork(e.target.value));
  $("w-blockbook").addEventListener("change", (e) => {
    S.blockbook = e.target.value.trim() || S.network.blockbook;
    store.set("legacy.blockbook", S.blockbook);
  });

  /* ---------- PLAN ---------- */
  function planOwnerMode() {
    const mode = radioVal("pl-owner-mode");
    $("pl-owner-priv-box").hidden = mode !== "priv";
    $("pl-owner-xonly-box").hidden = mode !== "watch";
  }
  document.querySelectorAll('input[name="pl-owner-mode"]').forEach((r) =>
    r.addEventListener("change", planOwnerMode));
  planOwnerMode();

  $("pl-n").addEventListener("input", () => {
    const n = Number($("pl-n").value);
    $("pl-days").innerHTML = Number.isSafeInteger(n) && n >= 1 && n <= 65535
      ? `≈ ${E.blocksToDays(n).toFixed(1)} days at 194 s/block (estimate only — the chain enforces blocks, never time).<br>OP_CHECKSEQUENCEVERIFY is 16-bit: a "one year" setting is impossible and is refused, not silently truncated.`
      : `n must be an integer 1 – 65535 (CSV 16-bit limit).`;
  });

  $("pl-forge").addEventListener("click", () => {
    err("pl-error", "");
    try {
      const mode = radioVal("pl-owner-mode");
      const ownerKeyInput = mode === "priv" ? $("pl-owner-input").value : $("pl-owner-xonly").value;
      const { vault } = E.planLegacy({
        network: S.network,
        ownerKeyInput,
        ownerKeyMode: mode,
        heirKeyInput: $("pl-heir").value,
        n: Number($("pl-n").value),
      });
      S.planVault = vault;
      $("pl-address").textContent = vault.address;
      $("pl-desc").textContent = vault.descriptor;
      $("pl-spec").value = E.serializeVault(vault);
      $("pl-leafA").textContent = vault.leafAScriptHex;
      $("pl-leafB").textContent = vault.leafBScriptHex;
      $("pl-internal").textContent = vault.internalKeyHex;
      drawQR($("pl-qr"), "pearl:" + vault.address);
      $("pl-out").hidden = false;
      // wipe secrets from the inputs; the plan itself carries no private keys
      $("pl-owner-input").value = "";
      $("pl-owner-xonly").value = "";
    } catch (e) { err("pl-error", "Refused: " + e.message); }
  });

  $("pl-dl").addEventListener("click", () => {
    const blob = new Blob([$("pl-spec").value], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "pearl-legacy-vault.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });
  $("pl-carry-vault").addEventListener("click", () => {
    $("v-spec").value = $("pl-spec").value;
    goto("vault");
    $("v-load").click();
  });
  $("pl-carry-watch").addEventListener("click", () => {
    $("w-address").value = $("pl-address").textContent;
    goto("watch");
  });

  /* ---------- VAULT ---------- */
  function loadVaultFromJson(jsonText) {
    err("v-error", "");
    const vault = E.parseVaultSpec(jsonText, S.network);
    S.vault = vault;
    S.vaultJson = E.serializeVault(vault);
    $("v-address").textContent = vault.address;
    $("v-desc").textContent = vault.descriptor;
    $("v-owner").textContent = vault.ownerXOnly.slice(0, 20) + "…" + " (" + vault.ownerKeySource + ")";
    $("v-heir").textContent = vault.heirXOnly.slice(0, 20) + "…" + " (" + vault.heirKeySource + ")";
    $("v-n").textContent = `${vault.n} blocks (≈ ${vault.nDaysEstimate} days at 194 s/block — estimate)`;
    $("v-leafA").textContent = vault.leafAScriptHex;
    $("v-leafB").textContent = vault.leafBScriptHex;
    drawQR($("v-qr"), "pearl:" + vault.address);
    $("v-out").hidden = false;
    return vault;
  }
  $("v-load").addEventListener("click", () => {
    try { loadVaultFromJson($("v-spec").value); }
    catch (e) { $("v-out").hidden = true; err("v-error", "LOUD REFUSAL: " + e.message); }
  });
  $("v-save").addEventListener("click", () => {
    if (!S.vaultJson) { err("v-error", "Load a spec first."); return; }
    store.set("legacy.spec", S.vaultJson);
    err("v-error", "");
    $("v-storage-note").innerHTML = "Spec saved in this browser (localStorage or in-memory fallback). Private keys are <b>never</b> saved — they only ever live in page memory.";
  });
  $("v-loadsaved").addEventListener("click", () => {
    const j = store.get("legacy.spec");
    if (!j) { err("v-error", "No saved spec in this browser."); return; }
    $("v-spec").value = j;
    $("v-load").click();
  });
  $("v-clear-saved").addEventListener("click", () => {
    store.del("legacy.spec");
    $("v-storage-note").textContent = "Saved spec cleared.";
  });
  $("v-carry-watch").addEventListener("click", () => {
    if (!S.vault) return;
    $("w-address").value = S.vault.address;
    goto("watch");
  });
  $("v-carry-claim").addEventListener("click", () => {
    if (!S.vault) return;
    $("c-spec").value = S.vaultJson;
    goto("claim");
    $("c-load").click();
  });

  /* ---------- WATCH ---------- */
  async function getTip() {
    if ($("w-manual").checked) {
      const h = Number($("w-height").value);
      if (!Number.isSafeInteger(h) || h < 0) throw new Error("manual height must be a non-negative integer");
      return { height: h, source: "manual" };
    }
    const h = await E.fetchBlockHeight(S.blockbook);
    return { height: h, source: "blockbook" };
  }

  $("w-scan").addEventListener("click", async () => {
    err("w-error", "");
    $("w-out").hidden = true;
    try {
      const addr = $("w-address").value.trim();
      if (!addr) throw new Error("paste a vault address first");
      // find the vault contract: prefer the loaded spec, else derive from a carried descriptor
      let vault = S.vault && S.vault.address === addr ? S.vault : null;
      if (!vault && S.planVault && S.planVault.address === addr) vault = S.planVault;
      if (!vault) throw new Error("load the vault spec in the Vault tab first (watch needs the contract to verify UTXOs against)");
      const { height: tip, source } = await getTip();
      // GET-only watch; every UTXO's vout script is re-checked against the
      // vault contract inside fetchLegacyUtxos (scriptOk:false = not believed)
      const items = await E.fetchLegacyUtxos(S.blockbook, vault);
      const ignored = items.filter((u) => !u.scriptOk).length;
      const utxos = [];
      for (const u of items) {
        if (!u.scriptOk) continue; // foreign script — never believed
        if (u.fundingHeight == null) {
          utxos.push({ ...u, confirmed: false, st: null });
          continue;
        }
        utxos.push({ ...u, confirmed: true, st: E.vaultUtxoStatus(vault, u.fundingHeight, tip) });
      }
      utxos.sort((a, b) => (a.fundingHeight ?? 1e18) - (b.fundingHeight ?? 1e18));
      S.watch = { tip, tipSource: source, utxos, vault, address: addr, ignored };
      renderWatch();
    } catch (e) { err("w-error", "Scan failed: " + e.message); }
  });

  function pillFor(u) {
    if (!u.confirmed) return `<span class="pill warn">unconfirmed</span>`;
    if (u.st.status === "heir-claimable") return `<span class="pill ok">CLAIMABLE</span>`;
    if (u.st.blocksLeft <= Math.ceil(S.watch.vault.n / 10)) return `<span class="pill warn">maturing soon</span>`;
    return `<span class="pill info">locked</span>`;
  }

  function renderWatch() {
    const w = S.watch;
    $("w-out").hidden = false;
    const total = w.utxos.reduce((a, u) => a + BigInt(u.value), 0n);
    $("w-tip").textContent = `${w.tip.toLocaleString()} (${w.tipSource})`;
    $("w-balance").textContent = fmtPRL(total) + (w.ignored ? ` (${w.ignored} foreign-script UTXO${w.ignored > 1 ? "s" : ""} ignored)` : "");
    const confirmed = w.utxos.filter((u) => u.confirmed);
    if (!confirmed.length) {
      $("w-status").innerHTML = w.utxos.length
        ? `<span class="pill warn">only unconfirmed UTXOs</span>`
        : `<span class="pill warn">no vault UTXOs found</span>`;
      $("w-age").textContent = "—";
      $("w-countdown").textContent = "—";
      $("w-utxos").querySelector("tbody").innerHTML = w.utxos.map(utxoRow).join("");
      return;
    }
    const oldest = confirmed[0];
    const anyMature = confirmed.some((u) => u.st.status === "heir-claimable");
    const minLeft = Math.min(...confirmed.map((u) => u.st.blocksLeft));
    $("w-status").innerHTML = anyMature
      ? `<span class="pill ok">HEIR CLAIM LIVE</span> at least one UTXO is ≥ n blocks old`
      : `<span class="pill info">vault sealed</span> heir claim not yet mature`;
    $("w-age").textContent = `${oldest.st.age} blocks (oldest confirmed UTXO, funded at ${oldest.fundingHeight})`;
    const secs = minLeft * E.PEARL_BLOCK_SECS;
    const dd = Math.floor(secs / 86400), hh = Math.floor((secs % 86400) / 3600);
    $("w-countdown").textContent = anyMature
      ? "0 — claimable now"
      : `${minLeft.toLocaleString()} blocks to go (≈ ${dd}d ${hh}h at 194 s/block — estimate)`;
    $("w-utxos").querySelector("tbody").innerHTML = w.utxos.map(utxoRow).join("");
  }

  function utxoRow(u) {
    return `<tr><td>${esc(u.txid.slice(0, 12))}…:${u.vout}</td><td>${fmtPRL(u.value)}</td>` +
      `<td>${u.fundingHeight ?? "unconfirmed"}</td><td>${u.confirmed ? u.st.age + " blocks" : "—"}</td><td>${pillFor(u)}</td></tr>`;
  }

  $("w-auto").addEventListener("change", () => {
    if (S.autoTimer) { clearInterval(S.autoTimer); S.autoTimer = null; }
    if ($("w-auto").checked) {
      const mins = Math.max(1, Number($("w-every").value) || 10);
      S.autoTimer = setInterval(() => $("w-scan").click(), mins * 60 * 1000);
    }
  });

  function carryUtxos(toRefresh) {
    const confirmed = (S.watch && S.watch.utxos || []).filter((u) => u.confirmed);
    if (!confirmed.length) { err("w-error", "Scan first — there are no confirmed UTXOs to carry."); return; }
    if (toRefresh) {
      $("r-utxos").value = confirmed.map((u) => `${u.txid}:${u.vout}:${u.value}`).join("\n");
      document.querySelector('input[name="c-mode"][value="refresh"]').checked = true;
    } else {
      // one claim spends one UTXO: carry the oldest (first to mature)
      const u = confirmed[0];
      $("c-txid").value = u.txid;
      $("c-vout").value = String(u.vout);
      $("c-value").value = String(u.value);
      $("c-fheight").value = String(u.fundingHeight);
      $("c-cheight").value = String(S.watch.tip);
      document.querySelector('input[name="c-mode"][value="claim"]').checked = true;
    }
    claimMode();
    goto("claim");
  }
  $("w-carry-claim").addEventListener("click", () => carryUtxos(false));
  $("w-carry-refresh").addEventListener("click", () => carryUtxos(true));

  /* ---------- CLAIM & REFRESH ---------- */
  function claimMode() {
    const mode = radioVal("c-mode");
    $("c-claim-box").hidden = mode !== "claim";
    $("c-refresh-box").hidden = mode !== "refresh";
  }
  document.querySelectorAll('input[name="c-mode"]').forEach((r) =>
    r.addEventListener("change", claimMode));
  claimMode();

  $("c-load").addEventListener("click", () => {
    err("c-error", "");
    try {
      const vault = E.parseVaultSpec($("c-spec").value, S.network);
      S.vault = vault;
      S.vaultJson = E.serializeVault(vault);
      $("c-summary").hidden = false;
      $("c-summary").innerHTML =
        `Vault <code>${esc(vault.address)}</code> · n=${vault.n} blocks · ` +
        `<code>${esc(vault.descriptor)}</code>`;
    } catch (e) { $("c-summary").hidden = true; err("c-error", "LOUD REFUSAL: " + e.message); }
  });

  function parseUtxoLines(text, needHeight) {
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) throw new Error("no UTXOs pasted");
    return lines.map((ln, i) => {
      const p = ln.split(":");
      if (p.length < 3) throw new Error(`line ${i + 1}: expected txid:vout:valueGrains${needHeight ? ":fundingHeight" : ""}`);
      const [txid, voutRaw, valueRaw, hRaw] = p;
      if (!/^[0-9a-fA-F]{64}$/.test(txid)) throw new Error(`line ${i + 1}: bad txid`);
      const vout = Number(voutRaw), value = Number(valueRaw);
      if (!Number.isSafeInteger(vout) || vout < 0) throw new Error(`line ${i + 1}: bad vout`);
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`line ${i + 1}: bad value`);
      const u = { txid: txid.toLowerCase(), vout, value };
      if (needHeight) {
        const h = Number(hRaw);
        if (!Number.isSafeInteger(h) || h < 0) throw new Error(`line ${i + 1}: bad fundingHeight`);
        u.fundingHeight = h;
      }
      return u;
    });
  }

  function showResult(build) {
    S.lastBuild = build;
    $("c-txid-out").textContent = build.txid;
    $("c-fee-out").textContent = `${fmtPRL(build.feeGrains)} (${build.feeGrains} grains @ ${build.vBytes} vbytes)`;
    $("c-vsize-out").textContent = `${build.vBytes} vbytes`;
    $("c-hex").value = build.hex;
    $("c-result").hidden = false;
    $("c-confirm").hidden = true;
    $("c-broadcast-result").hidden = true;
    $("c-broadcast").disabled = false;
  }

  $("c-build").addEventListener("click", () => {
    err("c-error", "");
    try {
      if (!S.vault) throw new Error("load the vault spec first");
      const txid = $("c-txid").value.trim();
      const utxo = {
        txid,
        vout: Number($("c-vout").value),
        value: Number($("c-value").value),
      };
      const dest = $("c-dest").value.trim();
      if (!dest) throw new Error("enter the heir destination address");
      const w = E.ownerPrivFromInput($("c-heir-input").value, S.network); // auto-detects mnemonic/WIF/hex
      const build = E.buildHeirClaim(S.network, S.vault, {
        utxo,
        heirPrivHex: E.bytesToHex(w.priv),
        destAddress: dest,
        fundingHeight: Number($("c-fheight").value),
        currentHeight: Number($("c-cheight").value),
        feeRateGrainsPerVByte: Number($("c-fee").value),
      });
      showResult({ kind: "claim", ...build });
      $("c-heir-input").value = ""; // wipe secret
    } catch (e) { err("c-error", "Refused: " + e.message); }
  });

  $("r-build").addEventListener("click", () => {
    err("c-error", "");
    try {
      if (!S.vault) throw new Error("load the vault spec first");
      const utxos = parseUtxoLines($("r-utxos").value, false);
      const w = E.ownerPrivFromInput($("r-owner-input").value, S.network); // auto-detects
      const build = E.buildOwnerRefresh(S.network, S.vault, {
        utxos,
        ownerPrivHex: E.bytesToHex(w.priv),
        feeRateGrainsPerVByte: Number($("r-fee").value),
      });
      showResult({ kind: "refresh", ...build });
      // heartbeat confirmation panel: SAME address, fresh UTXO — the new
      // coin's funding height is what restarts the inactivity clock.
      $("r-fresh-address").textContent = S.vault.address;
      $("r-fresh-note").textContent =
        `Heartbeat confirmed: ${E.fmtPRL(build.totalInGrains)} PRL in → ` +
        `${E.fmtPRL(build.totalInGrains - build.feeGrains)} PRL back to the SAME vault address ` +
        `(fee ${E.fmtPRL(build.feeGrains)} PRL). The new UTXO's funding height restarts the heir's ` +
        `${S.vault.n}-block clock. The vault spec is unchanged — same keys, same n, same address.`;
      drawQR($("r-qr"), "pearl:" + S.vault.address);
      $("r-fresh").hidden = false;
      $("r-owner-input").value = ""; // wipe secret
    } catch (e) { err("c-error", "Refused: " + e.message); }
  });

  $("r-carry-vault").addEventListener("click", () => {
    $("v-spec").value = S.vaultJson; // spec unchanged — same address, same descriptor
    goto("vault");
    $("v-load").click();
  });

  /* broadcast: explicit double confirmation */
  $("c-broadcast").addEventListener("click", () => {
    if (!S.lastBuild) return;
    $("c-confirm").hidden = false;
    $("c-ack1").checked = false;
    $("c-ack2").checked = false;
    $("c-broadcast-go").disabled = true;
    $("c-broadcast").disabled = true;
  });
  const ackCheck = () => { $("c-broadcast-go").disabled = !($("c-ack1").checked && $("c-ack2").checked); };
  $("c-ack1").addEventListener("change", ackCheck);
  $("c-ack2").addEventListener("change", ackCheck);
  $("c-broadcast-go").addEventListener("click", async () => {
    const box = $("c-broadcast-result");
    box.hidden = false;
    box.className = "alert info";
    box.textContent = "Broadcasting…";
    try {
      const res = await E.broadcastTx(S.blockbook, S.lastBuild.hex);
      box.className = "alert ok";
      box.textContent = "Broadcast accepted: " + JSON.stringify(res).slice(0, 300);
    } catch (e) {
      box.className = "alert error";
      box.textContent = "Broadcast failed: " + e.message;
    }
  });

  /* ---------- VERIFIER ---------- */
  $("vf-run").addEventListener("click", () => {
    err("vf-error", "");
    $("vf-verdict").innerHTML = "";
    try {
      const descriptor = $("vf-descriptor").value.trim();
      const address = $("vf-address").value.trim();
      if (!descriptor) throw new Error("paste a descriptor");
      if (!address) throw new Error("paste the claimed address too — a descriptor alone cannot prove which address it describes");
      const f = E.parseDescriptor(descriptor);
      const network = Object.values(E.NETWORKS).find((n) => n.hrp === f.hrp);
      if (!network) throw new Error("unknown network hrp in descriptor: " + f.hrp);
      const v = E.verifyDescriptor(descriptor, network, address);
      $("vf-verdict").innerHTML =
        `<div class="verdict verified"><h3>✓ VERIFIED</h3>
         <div class="kv">
           <dt>Address</dt><dd><code>${esc(v.vault.address)}</code></dd>
           <dt>Descriptor</dt><dd><code>${esc(v.recomputed)}</code></dd>
           <dt>Heartbeat leaf hash</dt><dd><code>${esc(v.leafAHash)}</code></dd>
           <dt>Heir leaf hash</dt><dd><code>${esc(v.leafBHash)}</code></dd>
           <dt>Inactivity n</dt><dd>${v.vault.n} blocks (≈ ${v.vault.nDaysEstimate} days at 194 s/block — estimate)</dd>
         </div>
         <p>This descriptor recomputes to the claimed address. A descriptor is not signed: anyone can mint a valid-looking one for a different vault, so fund it only if you trust whoever published it — verification proves consistency, not intent.</p></div>`;
    } catch (e) {
      err("vf-error", "");
      $("vf-verdict").innerHTML =
        `<div class="verdict refused"><h3>✗ REFUSED</h3><p>${esc(e.message)}</p></div>`;
    }
  });

  /* init */
  setNetwork("mainnet");
})();
