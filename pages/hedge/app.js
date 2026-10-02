/* Pearl Hedge — browser UI (classic script, window.PearlHedge bundle).
 * Keys and secrets live in memory only and are wiped after use. */
(function () {
  "use strict";
  const E = window.PearlHedge;
  if (!E) { document.body.innerHTML = "<p style='padding:2rem'>Pearl Hedge failed to load.</p>"; return; }

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* storage that survives hostile localStorage — only non-secret prefs */
  const store = {
    m: {},
    get(k) { try { return localStorage.getItem(k); } catch { return this.m[k] ?? null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { this.m[k] = v; } },
  };

  const S = {
    network: E.NETWORKS.mainnet,
    blockbook: store.get("ph.blockbook") || "",
    option: null,        // { parsed, forged } from write/load
    strikeVerified: null, // { txid, addr, strikeGrains }
  };
  const DEFAULT_BB = "https://blockbook.pearlresearch.ai";
  const bb = (v) => String(v || "").trim() || DEFAULT_BB;

  function showErr(id, msg) { const e = $(id); e.textContent = msg; e.hidden = false; }
  function hideErr(id) { $(id).hidden = true; }
  function grainsToPRL(g) { return (Number(g) / E.GRAIN_PER_PRL).toFixed(8).replace(/\.?0+$/, ""); }
  function go(step) {
    document.querySelectorAll("#steps button").forEach((x) => x.classList.remove("active"));
    const b = document.querySelector(`#steps button[data-step="${step}"]`);
    if (b) b.classList.add("active");
    document.querySelectorAll(".panel").forEach((s) => s.classList.remove("active"));
    $("step-" + step).classList.add("active");
    $("honest-limits").classList.add("active");
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
      el.innerHTML = "<p class='hint'>QR too large — use copy/download instead.</p>";
    }
  }

  function randomPreimageHex() {
    const b = new Uint8Array(32);
    crypto.getRandomValues(b);
    return E.bytesToHex(b);
  }

  /* ---------- decorative ticker (no prices — desk flavor only) ---------- */
  (function ticker() {
    const items = ["COVERED CALL", "PROTECTIVE PUT", "2-LEAF TAPROOT VAULT", "NUMS INTERNAL KEY",
      "HASHLOCKED EXERCISE", "CLTV REFUND", "LOCAL SCHNORR SIGNING", "NO SMART CONTRACTS",
      "BLOCKBOOK GET-ONLY", "NOT FINANCIAL ADVICE"];
    const half = items.map((t) => `<span>&nbsp;◈&nbsp;${esc(t)}</span>`).join("");
    $("ticker").innerHTML = half + half;
  })();

  /* ---------- step nav ---------- */
  document.querySelectorAll("#steps button").forEach((b) => b.addEventListener("click", () => go(b.dataset.step)));

  /* ---------- copy buttons ---------- */
  document.querySelectorAll(".copy-btn").forEach((b) => b.addEventListener("click", async () => {
    const t = $(b.dataset.for);
    const txt = t.tagName === "CODE" ? t.textContent : t.value;
    try { await navigator.clipboard.writeText(txt); b.textContent = "Copied"; }
    catch { b.textContent = "Copy failed"; }
    setTimeout(() => { b.textContent = "Copy"; }, 1500);
  }));

  /* ---------- network + blockbook ---------- */
  function syncBlockbookInputs() {
    for (const id of ["w-blockbook", "f-blockbook", "x-blockbook", "t-blockbook"]) {
      const el = $(id);
      if (el && !el.value) el.placeholder = DEFAULT_BB;
    }
  }
  $("w-network").addEventListener("change", (e) => {
    S.network = E.NETWORKS[e.target.value];
    S.option = null;
  });
  for (const id of ["w-blockbook", "f-blockbook", "x-blockbook", "t-blockbook"]) {
    $(id).addEventListener("change", (e) => { S.blockbook = e.target.value.trim(); store.set("ph.blockbook", S.blockbook); });
  }
  if (S.blockbook) for (const id of ["w-blockbook", "f-blockbook", "x-blockbook", "t-blockbook"]) $(id).value = S.blockbook;
  syncBlockbookInputs();

  /* ---------- role labels swap for puts ---------- */
  function syncKindLabels() {
    const isPut = $("w-kind").value === "P";
    document.querySelectorAll(".locker-label").forEach((el) => { el.textContent = isPut ? "Put holder (collateral locker)" : "Writer (collateral locker)"; });
    document.querySelectorAll(".holder-label").forEach((el) => { el.textContent = isPut ? "Put writer (exercise-right holder)" : "Buyer (exercise-right holder)"; });
    $("locker-role").textContent = isPut ? "put holder" : "writer";
    $("holder-role").textContent = isPut ? "put writer" : "buyer";
    document.querySelectorAll(".locker-role2").forEach((el) => { el.textContent = isPut ? "put holder" : "writer"; });
  }
  $("w-kind").addEventListener("change", syncKindLabels);
  $("w-strike-mode").addEventListener("change", (e) => { $("w-rate-wrap").hidden = e.target.value !== "usd"; });

  /* ---------- WRITE ---------- */
  $("w-tip").addEventListener("click", async () => {
    hideErr("w-err");
    try {
      const tip = await E.fetchChainTip(bb($("w-blockbook").value));
      if (tip == null) throw new Error("Blockbook unreachable — paste the anchor height manually");
      $("w-anchor").value = tip;
    } catch (e) { showErr("w-err", e.message); }
  });

  $("w-hashlock").addEventListener("click", () => {
    const pre = randomPreimageHex();
    $("w-preimage-in").value = pre;
    $("w-preimage").textContent = pre;
    $("w-lockhash").textContent = E.bytesToHex(E.lockHashForPreimage(pre));
    $("w-hashlock-out").hidden = false;
  });

  $("w-write").addEventListener("click", () => {
    hideErr("w-err");
    try {
      const kind = $("w-kind").value;
      const writer = E.counterpartyKeyFromInput($("w-writer").value, S.network);
      const buyer = E.counterpartyKeyFromInput($("w-buyer").value, S.network);
      const qty = Number($("w-qty").value);
      if (!Number.isFinite(qty) || qty <= 0) throw new Error("qty must be a positive PRL amount");
      const qtyGrains = Math.round(qty * E.GRAIN_PER_PRL);
      if (!Number.isSafeInteger(qtyGrains) || qtyGrains < E.DUST_GRAIN) {
        throw new Error(`qty is below the ${E.DUST_GRAIN}-grain dust floor`);
      }
      let strikeGrains;
      if ($("w-strike-mode").value === "usd") {
        const usd = Number($("w-strike").value), rate = Number($("w-rate").value);
        if (!Number.isFinite(usd) || usd <= 0) throw new Error("strike must be positive");
        if (!Number.isFinite(rate) || rate <= 0) throw new Error("a positive PRL/USD rate is required to pin a USD strike");
        strikeGrains = Math.round((usd / rate) * E.GRAIN_PER_PRL);
      } else {
        const prl = Number($("w-strike").value);
        if (!Number.isFinite(prl) || prl <= 0) throw new Error("strike must be a positive PRL amount");
        strikeGrains = Math.round(prl * E.GRAIN_PER_PRL);
      }
      if (!Number.isSafeInteger(strikeGrains) || strikeGrains <= 0) throw new Error("strike resolves to an invalid grain amount");
      const preHex = $("w-preimage-in").value.trim();
      if (!/^[0-9a-fA-F]{64}$/.test(preHex)) throw new Error("a 32-byte buyer preimage (64 hex chars) is required — generate or paste one");
      const lockHash = E.lockHashForPreimage(preHex);
      const days = Number($("w-days").value);
      const anchor = Number($("w-anchor").value);
      if (!Number.isInteger(anchor) || anchor < 1) throw new Error("anchor block height required (fetch the tip or paste it)");
      const blocks = E.expiryBlocksFromDays(days);
      const expiry = anchor + blocks;
      E.validateExpiry(expiry);
      const premiumGrains = Math.max(0, Math.round(Number($("w-premium").value) || 0));

      const forged = E.forgeOption({
        network: S.network, kind,
        writer: writer.key, buyer: buyer.key, lockHash,
        qtyGrains, strikeGrains, expiry, premiumGrains,
      });
      const { parsed } = E.optionFromDescriptor(forged.descriptor);
      S.option = { parsed, forged };

      const rv = $("w-review");
      rv.innerHTML = `
        <dt>Product</dt><dd>${esc(kind === "C" ? "Covered call" : "Protective put")}</dd>
        <dt>Vault address</dt><dd>${esc(forged.address)}</dd>
        <dt>Collateral</dt><dd>${esc(grainsToPRL(qtyGrains))} PRL (${qtyGrains} grains)</dd>
        <dt>Strike</dt><dd>${esc(grainsToPRL(strikeGrains))} PRL (${strikeGrains} grains)${$("w-strike-mode").value === "usd" ? " · pinned from USD at rate " + esc($("w-rate").value) : ""}</dd>
        <dt>Expiry</dt><dd>block ${expiry} (anchor ${anchor} + ${blocks} blocks ≈ ${esc(String(days))}d @ ~194 s/block)</dd>
        <dt>Premium pledged</dt><dd>${premiumGrains} grains (off-chain)</dd>
        <dt>Sealed</dt><dd>${esc(forged.sealed)}</dd>`;
      $("w-asm-e").textContent = E.scriptAsm(forged.exerciseScript);
      $("w-asm-x").textContent = E.scriptAsm(forged.refundScript);
      $("w-descriptor").value = forged.descriptor;
      $("w-out").hidden = false;
    } catch (e) { showErr("w-err", e.message); }
  });

  $("w-descriptor-download").addEventListener("click", () => {
    if (!S.option) return;
    const blob = new Blob([JSON.stringify({ descriptor: S.option.parsed && S.option.forged.descriptor, sealed: S.option.forged.sealed, address: S.option.forged.address }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "pearl-hedge-option.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });

  $("w-to-fund").addEventListener("click", () => { $("f-descriptor").value = $("w-descriptor").value; go("fund"); });

  /* ---------- FUND ---------- */
  function renderFundFees() {
    const o = S.option;
    if (!o) return;
    const rate = Math.max(1, Number($("f-feerate").value) || 2);
    const ex = E.planOptionSpend({ inputValue: o.parsed.qtyGrains, feeRateGrainsPerVByte: rate, scriptLen: o.forged.exerciseScript.length, controlLen: 65, stackLens: [64, 32] });
    const rf = E.planOptionSpend({ inputValue: o.parsed.qtyGrains, feeRateGrainsPerVByte: rate, scriptLen: o.forged.refundScript.length, controlLen: 65, stackLens: [64] });
    $("f-fees").innerHTML = `
      <dt>Exercise spend</dt><dd>${ex.vBytes} vB · ${ex.fee} grains fee · buyer nets ${grainsToPRL(ex.payment)} PRL</dd>
      <dt>Refund spend</dt><dd>${rf.vBytes} vB · ${rf.fee} grains fee · writer nets ${grainsToPRL(rf.payment)} PRL</dd>`;
    $("f-dust").textContent = E.DUST_GRAIN;
  }

  $("f-load").addEventListener("click", () => {
    hideErr("f-err");
    try {
      const { parsed, forged } = E.optionFromDescriptor($("f-descriptor").value);
      S.option = { parsed, forged };
      const isPut = parsed.kind === "P";
      $("f-review").innerHTML = `
        <dt>Product</dt><dd>${esc(isPut ? "Protective put" : "Covered call")}</dd>
        <dt>Collateral</dt><dd>${esc(grainsToPRL(parsed.qtyGrains))} PRL</dd>
        <dt>Strike</dt><dd>${esc(grainsToPRL(parsed.strikeGrains))} PRL</dd>
        <dt>Expiry</dt><dd>block ${parsed.expiry}</dd>
        <dt>Premium</dt><dd>${parsed.premiumGrains} grains (pledged off-chain)</dd>`;
      $("f-address").textContent = forged.address;
      $("f-sealed").textContent = forged.sealed;
      renderQR($("f-qr"), forged.address);
      renderFundFees();
      $("f-out").hidden = false;
    } catch (e) { showErr("f-err", e.message); }
  });
  $("f-fees-refresh").addEventListener("click", renderFundFees);

  $("f-scan").addEventListener("click", async () => {
    hideErr("f-err");
    try {
      if (!S.option) throw new Error("re-derive the vault first");
      const sum = await E.fetchAddressSummary(bb($("f-blockbook").value), S.option.forged.address);
      const funded = sum.utxos.filter((u) => u.value > 0);
      const total = funded.reduce((s, u) => s + u.value, 0);
      $("f-review").innerHTML += `<dt>Funding</dt><dd>${funded.length} UTXO(s) · ${total} grains ${total >= S.option.parsed.qtyGrains ? "✓ collateral present" : "— awaiting " + (S.option.parsed.qtyGrains - total) + " more grains"}</dd>`;
    } catch (e) { showErr("f-err", "funding scan failed: " + e.message); }
  });

  /* ---------- EXERCISE ---------- */
  function optShape() {
    const o = S.option;
    if (!o) return null;
    return {
      parsed: o.parsed, forged: o.forged,
      exerciseScript: o.forged.exerciseScript, exerciseControlBlock: o.forged.exerciseControlBlock,
      refundScript: o.forged.refundScript, refundControlBlock: o.forged.refundControlBlock,
      expiry: o.parsed.expiry,
    };
  }

  $("x-load").addEventListener("click", () => {
    hideErr("x-err");
    try {
      const { parsed, forged } = E.optionFromDescriptor($("x-descriptor").value);
      S.option = { parsed, forged };
      S.strikeVerified = null;
      $("x-strike-ok").hidden = true;
      $("x-option").hidden = false;
      $("x-review").innerHTML = `
        <dt>Product</dt><dd>${esc(parsed.kind === "P" ? "Protective put" : "Covered call")}</dd>
        <dt>Vault</dt><dd>${esc(forged.address)}</dd>
        <dt>Collateral</dt><dd>${esc(grainsToPRL(parsed.qtyGrains))} PRL</dd>
        <dt>Strike</dt><dd>${esc(grainsToPRL(parsed.strikeGrains))} PRL (${parsed.strikeGrains} grains)</dd>
        <dt>Expiry</dt><dd>block ${parsed.expiry}</dd>
        <dt>Lock hash</dt><dd>${esc(parsed.lockHash)}</dd>`;
    } catch (e) { showErr("x-err", e.message); }
  });

  $("x-import-utxo").addEventListener("click", async () => {
    hideErr("x-err");
    try {
      if (!S.option) throw new Error("load the option first");
      const utxos = await E.fetchUtxos(bb($("x-blockbook").value), S.option.forged.address);
      if (!utxos.length) throw new Error("no UTXOs at the vault address — unfunded");
      const u = utxos[0];
      $("x-utxo").value = `${u.txid}:${u.vout}:${u.value}`;
    } catch (e) { showErr("x-err", "UTXO import failed: " + e.message); }
  });

  function parseUtxo() {
    const m = /^([0-9a-fA-F]{64}):(\d+):(\d+)$/.exec($("x-utxo").value.trim());
    if (!m) throw new Error("UTXO must look like txid:vout:value-in-grains");
    return { txid: m[1].toLowerCase(), vout: Number(m[2]), value: Number(m[3]) };
  }

  async function feeRate() {
    const v = Number($("x-feerate").value);
    if (Number.isFinite(v) && v > 0) return v;
    return E.fetchFeeRateGrainsPerVByte(bb($("x-blockbook").value));
  }

  async function chainTip() {
    try { return await E.fetchChainTip(bb($("x-blockbook").value)); }
    catch { return null; }
  }

  async function assertUtxoLive(utxo) {
    // Loud refusal: the vault output is already spent (option closed).
    try {
      const utxos = await E.fetchUtxos(bb($("x-blockbook").value), S.option.forged.address);
      const live = utxos.some((u) => u.txid.toLowerCase() === utxo.txid && u.vout === utxo.vout);
      if (!live) throw new Error("this vault UTXO is already spent — the option is closed");
    } catch (e) {
      if (/already spent|closed/.test(e.message)) throw e;
      // Blockbook unreachable: proceed, the network enforces everything anyway.
    }
  }

  $("x-verify-strike").addEventListener("click", async () => {
    hideErr("x-err");
    $("x-strike-ok").hidden = true;
    try {
      const o = optShape();
      if (!o) throw new Error("load the option first");
      const res = await E.verifyStrikePayment({
        blockbookBase: bb($("x-blockbook").value),
        txid: $("x-strike-txid").value,
        writerAddress: $("x-strike-addr").value.trim(),
        strikeGrains: o.parsed.strikeGrains,
      });
      S.strikeVerified = { txid: $("x-strike-txid").value.trim().toLowerCase(), addr: $("x-strike-addr").value.trim(), strikeGrains: o.parsed.strikeGrains };
      const el = $("x-strike-ok");
      el.textContent = `✓ Strike payment verified: ${res.paidGrains} grains to the writer's address, ${res.confirmations} confirmation(s).`;
      el.hidden = false;
    } catch (e) { showErr("x-err", e.message); }
  });

  function showSigned(tx, label, asm) {
    $("x-signed-dl").innerHTML = `
      <dt>Type</dt><dd>${esc(label)}</dd>
      <dt>txid</dt><dd>${esc(tx.txid)}</dd>
      <dt>Payout</dt><dd>${esc(grainsToPRL(tx.payment))} PRL (${tx.payment} grains)</dd>
      <dt>Fee</dt><dd>${tx.fee} grains · ${tx.vBytes} vB</dd>
      <dt>nLockTime</dt><dd>${tx.locktime}</dd>
      <dt>Signature</dt><dd>locally signed + re-verified ✓ (${esc(tx.sigHex.slice(0, 32))}…)</dd>`;
    $("x-asm").textContent = asm;
    $("x-hex").value = tx.hex;
    $("x-txid").hidden = true;
    $("x-signed").hidden = false;
    S.lastHex = tx.hex;
  }

  $("x-exercise").addEventListener("click", async () => {
    hideErr("x-err");
    let signer = null;
    try {
      const o = optShape();
      if (!o) throw new Error("load the option first");
      const sv = S.strikeVerified;
      const txidNow = $("x-strike-txid").value.trim().toLowerCase();
      const addrNow = $("x-strike-addr").value.trim();
      if (!sv || sv.txid !== txidNow || sv.addr !== addrNow || sv.strikeGrains !== o.parsed.strikeGrains) {
        throw new Error("verify the strike payment first (step 1) — the desk will not build an exercise on an unverified strike");
      }
      const utxo = parseUtxo();
      await assertUtxoLive(utxo);
      const preHex = $("x-preimage").value.trim();
      if (!/^[0-9a-fA-F]{64}$/.test(preHex)) throw new Error("preimage must be 64 hex chars (32 bytes)");
      const dest = E.addressToProgram($("x-buyer-dest").value.trim(), S.network);
      signer = E.buyerSignerFor($("x-buyer-secret").value, S.network, o.parsed.buyer, $("x-buyer-mode").value);
      const tip = await chainTip();
      const tx = E.buildExerciseTx({
        network: S.network, utxo, option: o,
        preimage: preHex, signerPriv: signer.priv,
        destinationProgram: dest, feeRateGrainsPerVByte: await feeRate(), chainTip: tip,
      });
      showSigned(tx, "Buyer exercise (leaf E)", tx.scriptAsm);
      if (tip == null) showErr("x-err", "Note: chain tip unreachable — the desk could not pre-check CLTV; the network enforces it. Broadcast carefully.");
    } catch (e) { showErr("x-err", e.message); }
    finally {
      if (signer) { E.wipeSecrets(signer.priv); signer = null; }
      $("x-buyer-secret").value = "";
    }
  });

  $("x-refund").addEventListener("click", async () => {
    hideErr("x-err");
    let signer = null;
    try {
      const o = optShape();
      if (!o) throw new Error("load the option first");
      const utxo = parseUtxo();
      await assertUtxoLive(utxo);
      const dest = E.addressToProgram($("x-writer-dest").value.trim(), S.network);
      signer = E.writerSignerFor($("x-writer-secret").value, S.network, o.parsed.writer, $("x-writer-mode").value);
      const tip = await chainTip();
      const tx = E.buildRefundTx({
        network: S.network, utxo, option: o,
        signerPriv: signer.priv,
        destinationProgram: dest, feeRateGrainsPerVByte: await feeRate(), chainTip: tip,
      });
      showSigned(tx, "Writer refund (leaf X)", tx.scriptAsm);
      if (tip == null) showErr("x-err", "Note: chain tip unreachable — the desk could not pre-check CLTV; the network enforces it. Broadcast carefully.");
    } catch (e) { showErr("x-err", e.message); }
    finally {
      if (signer) { E.wipeSecrets(signer.priv); signer = null; }
      $("x-writer-secret").value = "";
    }
  });

  $("x-buyer-clear").addEventListener("click", () => {
    $("x-buyer-secret").value = ""; $("x-preimage").value = "";
  });
  $("x-writer-clear").addEventListener("click", () => { $("x-writer-secret").value = ""; });

  $("x-broadcast").addEventListener("click", async () => {
    hideErr("x-err");
    try {
      if (!S.lastHex) throw new Error("nothing to broadcast");
      const txid = await E.broadcastTx(bb($("x-blockbook").value), S.lastHex);
      const el = $("x-txid");
      el.textContent = "Broadcast accepted: " + txid;
      el.hidden = false;
      S.lastHex = null;
    } catch (e) { showErr("x-err", e.message); }
  });

  /* ---------- TRACK ---------- */
  $("t-scan").addEventListener("click", async () => {
    hideErr("t-err");
    try {
      const { parsed, forged } = E.optionFromDescriptor($("t-descriptor").value);
      const base = bb($("t-blockbook").value);
      const [sum, tip] = await Promise.all([
        E.fetchAddressSummary(base, forged.address),
        E.fetchChainTip(base),
      ]);
      const state = E.classifyLifecycle({ utxos: sum.utxos, txCount: sum.txCount, tip, expiry: parsed.expiry });
      const labels = {
        "unfunded": "UNFUNDED — nothing at the vault address yet",
        "funded": "FUNDED — collateral locked, awaiting expiry",
        "expired-funded": "EXPIRED · FUNDED — exercise or refund now",
        "spent": "SPENT — the vault output moved (exercised or refunded)",
      };
      const funded = sum.utxos.filter((u) => u.value > 0);
      $("t-review").innerHTML = `
        <dt>Vault</dt><dd>${esc(forged.address)}</dd>
        <dt>State</dt><dd>${esc(labels[state] || state)}</dd>
        <dt>UTXOs</dt><dd>${funded.length} · ${funded.reduce((s, u) => s + u.value, 0)} grains</dd>
        <dt>Chain tip</dt><dd>${tip == null ? "unreachable" : "block " + tip}</dd>
        <dt>Expiry</dt><dd>block ${parsed.expiry}</dd>`;
      if (tip != null && tip < parsed.expiry) {
        const left = parsed.expiry - tip;
        const mins = Math.round((left * E.BLOCK_SECONDS) / 60);
        $("t-countdown").textContent = `⏳ ${left} blocks to expiry (≈ ${mins} min @ ~194 s/block — approximate)`;
      } else if (tip != null) {
        $("t-countdown").textContent = "◈ Expiry reached — the exercise window is open and the writer may refund.";
      } else {
        $("t-countdown").textContent = "";
      }
      $("t-out").hidden = false;
    } catch (e) { showErr("t-err", "lifecycle scan failed: " + e.message); }
  });

  /* ---------- VERIFY ---------- */
  $("v-check").addEventListener("click", () => {
    hideErr("v-err");
    $("v-out").hidden = true;
    try {
      const d = $("v-descriptor").value;
      const { parsed, forged } = E.optionFromDescriptor(d);
      const sealedGiven = $("v-sealed").value.trim();
      let sealOk = null;
      if (sealedGiven) sealOk = (E.sealedDescriptor(d) === sealedGiven);
      const verdict = $("v-verdict");
      if (sealOk === false) {
        verdict.className = "verdict notproven";
        verdict.textContent = "✗ NOT PROVEN — sealed commitment does not match this descriptor";
      } else {
        verdict.className = "verdict proven";
        verdict.textContent = "✓ PROVEN — descriptor is canonical and re-derives the vault";
      }
      $("v-review").innerHTML = `
        <dt>Product</dt><dd>${esc(parsed.kind === "P" ? "Protective put" : "Covered call")}</dd>
        <dt>Vault address</dt><dd>${esc(forged.address)}</dd>
        <dt>Collateral</dt><dd>${esc(grainsToPRL(parsed.qtyGrains))} PRL</dd>
        <dt>Strike</dt><dd>${esc(grainsToPRL(parsed.strikeGrains))} PRL</dd>
        <dt>Expiry</dt><dd>block ${parsed.expiry}</dd>
        <dt>Sealed</dt><dd>${esc(forged.sealed)}${sealOk === true ? " ✓ matches" : sealOk === false ? " ✗ MISMATCH" : ""}</dd>`;
      $("v-out").hidden = false;
    } catch (e) {
      const verdict = $("v-verdict");
      verdict.className = "verdict notproven";
      verdict.textContent = "✗ NOT PROVEN — " + e.message;
      $("v-review").innerHTML = "";
      $("v-out").hidden = false;
    }
  });

  syncKindLabels();
})();
