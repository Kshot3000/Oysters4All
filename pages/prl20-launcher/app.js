/* PRL-20 Token Launcher — browser controller (classic script).
 * Uses the PearlInscribe global from pearl-bundle.js and the qrcode global.
 * All keys stay in memory; nothing secret is persisted. */
(function () {
"use strict";
const P = window.PearlInscribe;
if (!P) { document.body.innerHTML = "<p style='padding:2rem'>Failed to load pearl-bundle.js</p>"; return; }

const DONATION = "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d";
const MAINNET_BB = "https://blockbook.pearlresearch.ai";

/* ---------- tiny helpers ---------- */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtInt = (s) => { try { return BigInt(s).toLocaleString("en-US"); } catch { return String(s); } };
const fmtPRL = (grains) => {
/* BigInt-exact (pool float-format class): the old float format
   * silently rounds grain counts past Number.MAX_SAFE_INTEGER.
   * Integer string/BigInt grain counts format exactly; anything
   * else keeps the legacy float rendering. */
  const s = typeof grains === "bigint" ? grains.toString() : String(grains).trim();
  if (!/^-?\d+$/.test(s)) return (Number(grains) / 1e8).toFixed(8).replace(/\.?0+$/, "") + " PRL";
  const b = BigInt(s), neg = b < 0n, a = neg ? -b : b;
  const w = (a / 100000000n).toString();
  const f = (a % 100000000n).toString().padStart(8, "0").replace(/0+$/, "");
  return (neg ? "-" : "") + w + (f ? "." + f : "") + " PRL";
};
async function copyText(t, btn) {
  try { await navigator.clipboard.writeText(t); }
  catch {
    const ta = document.createElement("textarea");
    ta.value = t; document.body.appendChild(ta); ta.select();
    document.execCommand("copy"); ta.remove();
  }
  if (btn) { const o = btn.textContent; btn.textContent = "Copied ✓"; setTimeout(() => (btn.textContent = o), 1200); }
}
function download(name, text) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
function qrDataURL(text) {
  const qr = qrcode(0, "M");
  qr.addData(text); qr.make();
  return qr.createDataURL(4, 0);
}

/* ---------- state ---------- */
const store = {
  load() { try { return JSON.parse(localStorage.getItem("prl20launcher.settings") || "{}"); } catch { return {}; } },
  save(s) { try { localStorage.setItem("prl20launcher.settings", JSON.stringify(s)); } catch {} },
};
const settings = Object.assign({ network: "mainnet", blockbook: MAINNET_BB, indexer: "", feeRate: 10 }, store.load());
const wallet = { priv: null, internalXOnly: null, address: null, mnemonic: null }; // memory only
const launch = { opJson: null, op: null, utxos: [], selected: new Set(), built: null, pollTimer: null };

const net = () => P.NETWORKS[settings.network];

/* ---------- settings ---------- */
function applySettingsToUI() {
  $("set-network").value = settings.network;
  $("set-blockbook").value = settings.blockbook || "";
  $("set-indexer").value = settings.indexer || "";
  $("set-feerate").value = settings.feeRate;
  $("network-hint").innerHTML = settings.network === "mainnet"
    ? "<strong>Mainnet is live.</strong> Real PRL will move if you broadcast. Practice on <strong>testnet</strong> first — switch networks in Settings."
    : "<strong>Testnet mode.</strong> No verified public testnet Blockbook exists — enter your own Blockbook URL above, otherwise reads and broadcasts will fail.";
  if (wallet.address) {
    const w = walletFromKey(wallet.priv);
    wallet.address = w.address; wallet.internalXOnly = w.internalXOnly;
    renderWalletAddress();
  }
  updateConn("settings updated");
}
function walletFromKey(priv) {
  const w = P.walletFromPriv(priv, net());
  return w;
}
function saveSettings() {
  settings.network = $("set-network").value;
  settings.blockbook = $("set-blockbook").value.trim();
  settings.indexer = $("set-indexer").value.trim().replace(/\/$/, "");
  const fr = Math.max(1, Math.ceil(Number($("set-feerate").value) || 10));
  settings.feeRate = fr; $("set-feerate").value = fr;
  store.save(settings);
  applySettingsToUI();
}
function updateConn(msg, cls) {
  const c = $("conn");
  c.textContent = msg;
  c.className = "conn" + (cls ? " " + cls : "");
}

/* ---------- tabs ---------- */
document.querySelectorAll(".tab").forEach((t) => {
  t.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((x) => { x.classList.remove("active"); x.setAttribute("aria-selected", "false"); });
    document.querySelectorAll(".tabpanel").forEach((x) => x.classList.add("hidden"));
    t.classList.add("active"); t.setAttribute("aria-selected", "true");
    $("panel-" + t.dataset.tab).classList.remove("hidden");
  });
});

/* ---------- deploy designer ---------- */
const dFields = ["d-name", "d-tick", "d-max", "d-dec", "d-lim", "d-premine-mode", "d-premine-amt"];
function deployState() {
  return {
    name: $("d-name").value.trim(),
    tick: $("d-tick").value.trim().toLowerCase(),
    max: $("d-max").value.trim(),
    dec: $("d-dec").value.trim(),
    lim: $("d-lim").value.trim(),
    premineMode: $("d-premine-mode").value,
    premineAmt: $("d-premine-amt").value.trim(),
  };
}
function refreshDeploy() {
  const s = deployState();
  const errs = [];
  if (!s.tick) errs.push("Ticker is required.");
  if (s.max && !/^(0|[1-9][0-9]*)$/.test(s.max)) errs.push("Max supply must be a non-negative integer (no decimals, no leading zeroes).");
  if (s.lim && !/^(0|[1-9][0-9]*)$/.test(s.lim)) errs.push("Per-mint limit must be a non-negative integer.");
  let json = "";
  let okJson = false;
  try {
    json = P.buildDeployJson({ tick: s.tick || "tick", max: s.max || "0", lim: s.lim || "0", dec: s.dec || "0" });
    const v = P.validatePrl20Json(json, "deploy");
    if (!v.ok) errs.push(...v.errors);
    else okJson = s.tick && s.max && s.lim ? true : false;
  } catch (e) { errs.push(e.message); }
  // premine plan
  const prow = $("d-premine-row");
  if (s.premineMode === "none") { prow.classList.add("hidden"); }
  else {
    prow.classList.remove("hidden");
    const plan = $("d-premine-plan");
    if (okJson && /^[1-9][0-9]*$/.test(s.premineAmt) && /^[1-9][0-9]*$/.test(s.lim)) {
      const lim = BigInt(s.lim), want = BigInt(s.premineAmt);
      if (s.premineMode === "tokens") {
        const mints = (want + lim - 1n) / lim;
        const last = want - (mints - 1n) * lim;
        plan.textContent = `${mints.toLocaleString()} mint inscription(s) after deploy` +
          (last === lim ? ` (${fmtInt(s.premineAmt)} ${s.tick})` : ` (${mints - 1n}× ${fmtInt(s.lim)} + 1× ${fmtInt(String(last))})`);
      } else {
        plan.textContent = `${fmtInt(s.premineAmt)} mint inscription(s) → up to ${fmtInt(String(want * lim))} ${s.tick} (capped by max supply)`;
      }
    } else plan.textContent = "— fill in a valid deploy + premine amount —";
  }
  const box = $("d-errors");
  box.innerHTML = errs.map((e) => `<div class="verr">✕ ${esc(e)}</div>`).join("") +
    (okJson && !errs.length ? `<div class="vok">✓ Valid PRL-20 deploy — ready to inscribe.</div>` : "");
  const jb = $("d-json");
  jb.textContent = json || "{}";
  jb.classList.toggle("bad", !!errs.length);
  launch._deployJson = okJson && !errs.length ? json : null;
  return launch._deployJson;
}
dFields.forEach((id) => $(id).addEventListener("input", refreshDeploy));
$("d-copy").addEventListener("click", (e) => copyText($("d-json").textContent, e.target));
$("d-download").addEventListener("click", () => download("prl20-deploy-" + (deployState().tick || "token") + ".json", $("d-json").textContent));
$("d-to-launch").addEventListener("click", () => {
  const j = refreshDeploy();
  if (!j) { alert("Fix the validation errors first."); return; }
  $("l-json").value = j;
  document.querySelector('[data-tab="launch"]').click();
  refreshLaunchJson();
});

/* ---------- mint designer ---------- */
function mintState() {
  return {
    tick: $("m-tick").value.trim().toLowerCase(),
    amt: $("m-amt").value.trim(),
    feeRecipient: $("m-fee-recipient").value.trim(),
  };
}
function refreshMint() {
  const s = mintState();
  const errs = [];
  const isPrls = s.tick === "prls";
  $("m-prls-box").classList.toggle("hidden", !isPrls);
  if (isPrls && $("m-amt").value.trim() !== "" && $("m-amt").value.trim() !== "100000") {
    errs.push("PRLS amount is fixed at 100000 — resetting.");
    $("m-amt").value = "100000";
  }
  if (isPrls) $("m-amt").value = "100000";
  let json = "", okJson = false;
  try {
    const amt = isPrls ? "100000" : (s.amt || "0");
    json = P.buildMintJson({ tick: s.tick || "tick", amt });
    const v = P.validatePrl20Json(json, "mint");
    if (!v.ok) errs.push(...v.errors);
    else okJson = !!(s.tick && amt);
  } catch (e) { errs.push(e.message); }
  if (isPrls) {
    if (!s.feeRecipient) errs.push("PRLS mints require the operator's fee recipient address (see warning above).");
    else {
      try {
        const d = P.decodeBech32m(s.feeRecipient, net().hrp);
        if (d.version !== 1 || d.program.length !== 32) errs.push("Fee recipient must be a Taproot (witness v1) address.");
      } catch { errs.push("Fee recipient is not a valid " + net().hrp + " address."); }
    }
  }
  $("m-errors").innerHTML = errs.map((e) => `<div class="verr">✕ ${esc(e)}</div>`).join("") +
    (okJson && !errs.length ? `<div class="vok">✓ Valid PRL-20 mint — ready to inscribe.</div>` : "");
  const jb = $("m-json");
  jb.textContent = json || "{}";
  jb.classList.toggle("bad", !!errs.length);
  launch._mintJson = okJson && !errs.length ? json : null;
  launch._mintFeeRecipient = isPrls ? s.feeRecipient : null;
  return launch._mintJson;
}
["m-tick", "m-amt", "m-fee-recipient"].forEach((id) => $(id).addEventListener("input", refreshMint));
$("m-copy").addEventListener("click", (e) => copyText($("m-json").textContent, e.target));
$("m-download").addEventListener("click", () => download("prl20-mint-" + (mintState().tick || "token") + ".json", $("m-json").textContent));
$("m-to-launch").addEventListener("click", () => {
  const j = refreshMint();
  if (!j) { alert("Fix the validation errors first."); return; }
  $("l-json").value = j;
  document.querySelector('[data-tab="launch"]').click();
  refreshLaunchJson();
});

/* ---------- wallet ---------- */
function renderWalletAddress() {
  if (!wallet.address) return;
  $("w-address-box").classList.remove("hidden");
  $("w-network-label").textContent = "(" + net().name + ")";
  $("w-address").textContent = wallet.address;
  $("w-qr").src = qrDataURL(wallet.address);
}
$("w-generate").addEventListener("click", () => {
  const mnemonic = P.newMnemonic();
  const w = P.walletFromMnemonic(mnemonic, net());
  wallet.mnemonic = mnemonic; wallet.priv = w.priv;
  wallet.internalXOnly = w.internalXOnly; wallet.address = w.address;
  $("w-mnemonic-box").classList.remove("hidden");
  $("w-mnemonic").textContent = mnemonic;
  $("w-mnemonic").classList.add("blur");
  $("w-reveal").classList.remove("hidden");
  $("w-hide").classList.add("hidden");
  renderWalletAddress();
  updateConn("wallet ready — back it up", "on");
});
$("w-reveal").addEventListener("click", () => {
  if (!wallet.mnemonic) return;
  $("w-mnemonic").classList.remove("blur");
  $("w-reveal").classList.add("hidden");
  $("w-hide").classList.remove("hidden");
});
$("w-hide").addEventListener("click", () => {
  $("w-mnemonic").classList.add("blur");
  $("w-hide").classList.add("hidden");
  $("w-reveal").classList.remove("hidden");
});
$("w-copy-mnemonic").addEventListener("click", (e) => {
  if (!$("w-mnemonic").classList.contains("blur")) copyText(wallet.mnemonic || "", e.target);
  else alert("Reveal the phrase first — and make sure no one is looking.");
});
$("w-copy-address").addEventListener("click", (e) => copyText(wallet.address || "", e.target));
$("w-import").addEventListener("click", () => {
  const wif = $("w-wif").value.trim();
  const note = $("w-import-note");
  try {
    const w = P.walletFromWIF(wif, net());
    wallet.mnemonic = null; wallet.priv = w.priv;
    wallet.internalXOnly = w.internalXOnly; wallet.address = w.address;
    $("w-mnemonic-box").classList.add("hidden");
    renderWalletAddress();
    note.textContent = "✓ WIF imported. Anyone with this WIF controls the funds — keep it private.";
    updateConn("wallet ready", "on");
  } catch (e) {
    note.textContent = "✕ Import failed: " + e.message + " — check the network setting matches the WIF.";
  }
  $("w-wif").value = "";
});

/* ---------- launch ---------- */
function parseOpJson() {
  const raw = $("l-json").value.trim();
  if (!raw) return { error: "Paste an inscription JSON first." };
  let obj;
  try { obj = JSON.parse(raw); }
  catch { return { error: "Not valid JSON." }; }
  if (obj.p !== "prl-20") return { error: 'Field "p" must be "prl-20".' };
  if (obj.op !== "deploy" && obj.op !== "mint") return { error: 'Field "op" must be "deploy" or "mint".' };
  const v = P.validatePrl20Json(raw, obj.op);
  if (!v.ok) return { error: v.errors.join(" ") };
  // rebuild canonical JSON so what we inscribe is byte-exact
  const canon = obj.op === "deploy"
    ? P.buildDeployJson({ tick: obj.tick, max: obj.max, lim: obj.lim, dec: obj.dec })
    : P.buildMintJson({ tick: obj.tick, amt: obj.amt });
  return { op: obj, canon };
}
function refreshLaunchJson() {
  const r = parseOpJson();
  const box = $("l-json-errors"), sum = $("l-op-summary");
  if (r.error) {
    box.innerHTML = `<div class="verr">✕ ${esc(r.error)}</div>`;
    sum.classList.add("hidden");
    launch.opJson = null; launch.op = null;
    return false;
  }
  box.innerHTML = `<div class="vok">✓ Valid ${esc(r.op.op)} operation.</div>`;
  const extra = r.op.op === "mint" && r.op.tick === "prls"
    ? ` <strong>PRLS:</strong> 100,000 ${esc(r.op.tick)} per mint + 1 PRL launch fee to the operator recipient you set on the Mint tab.`
    : "";
  sum.innerHTML = `<strong>${esc(r.op.op)} ${esc(r.op.tick)}</strong> — inscription JSON is canonical and valid.${extra}`;
  sum.classList.remove("hidden");
  launch.opJson = r.canon; launch.op = r.op;
  return true;
}
$("l-json").addEventListener("input", refreshLaunchJson);

$("l-fetch-utxos").addEventListener("click", async () => {
  const box = $("l-utxos"), sum = $("l-utxo-summary");
  if (!wallet.address) { box.innerHTML = `<div class="verr">✕ Set up a wallet on the Wallet tab first.</div>`; return; }
  if (!settings.blockbook) { box.innerHTML = `<div class="verr">✕ Set a Blockbook URL in Settings first.</div>`; return; }
  box.innerHTML = `<span class="muted">Loading UTXOs…</span>`;
  try {
    const utxos = await P.fetchUtxos(settings.blockbook, wallet.address);
    launch.utxos = utxos.filter((u) => u.confirmations > 0);
    launch.selected = new Set(launch.utxos.map((_, i) => i));
    updateConn("blockbook ok", "on");
  } catch (e) {
    box.innerHTML = `<div class="verr">✕ UTXO fetch failed: ${esc(e.message)}. Check the Blockbook URL and CORS.</div>`;
    updateConn("blockbook error", "err");
    return;
  }
  renderUtxos();
});
function selectedUtxos() {
  return launch.utxos.filter((_, i) => launch.selected.has(i));
}
function renderUtxos() {
  const box = $("l-utxos");
  if (!launch.utxos.length) {
    box.innerHTML = `<span class="muted">No confirmed UTXOs. Fund <code class="mono">${esc(wallet.address || "")}</code> first.</span>`;
    $("l-utxo-summary").textContent = "";
    return;
  }
  box.innerHTML = launch.utxos.map((u, i) => `
    <label class="utxo">
      <input type="checkbox" data-i="${i}" ${launch.selected.has(i) ? "checked" : ""} />
      <span class="mono">${esc(u.txid.slice(0, 16))}…:${u.vout}</span>
      <span class="mono">${u.confirmations} conf</span>
      <span class="val">${fmtPRL(u.value)}</span>
    </label>`).join("");
  box.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener("change", () => {
      const i = Number(cb.dataset.i);
      if (cb.checked) launch.selected.add(i); else launch.selected.delete(i);
      updateUtxoSummary();
    });
  });
  updateUtxoSummary();
}
function updateUtxoSummary() {
  const total = selectedUtxos().reduce((a, u) => a + u.value, 0);
  $("l-utxo-summary").textContent = `${selectedUtxos().length} selected · ${fmtPRL(total)}`;
}

function feeRecipientForOp() {
  if (launch.op && launch.op.op === "mint" && launch.op.tick === "prls") {
    const addr = mintState().feeRecipient;
    if (!addr) throw new Error("PRLS mint needs a fee recipient address (Mint tab).");
    return P.decodeBech32m(addr, net().hrp).program;
  }
  return null;
}

$("l-build").addEventListener("click", () => {
  const errBox = $("l-build-errors");
  errBox.innerHTML = "";
  try {
    if (!refreshLaunchJson()) throw new Error("Invalid operation JSON.");
    if (!wallet.priv) throw new Error("Set up a wallet on the Wallet tab first.");
    const ins = selectedUtxos();
    if (!ins.length) throw new Error("Select at least one UTXO.");
    const rate = Math.max(1, Math.ceil(Number(settings.feeRate) || 10));

    const body = new TextEncoder().encode(launch.opJson);
    const script = P.buildInscriptionScript(wallet.internalXOnly, body);
    const cki = P.commitKeyInfo(net(), wallet.internalXOnly, script);

    const feeProg = feeRecipientForOp();
    const outputs = [{ program: P.decodeBech32m(wallet.address, net().hrp).program, value: P.DUST_GRAIN }];
    if (feeProg) outputs.push({ program: feeProg, value: P.PRLS.mintFeeGrain });
    const outSum = outputs.reduce((a, o) => a + o.value, 0);

    // two-pass commit sizing: assume change output, drop it if below dust
    let commitFee, commitValue, change;
    for (const nOut of [2, 1]) {
      commitFee = P.keypathTxVBytes(ins.length, nOut) * rate;
      const revealFee = P.revealTxVBytes(script.length, outputs.length) * rate;
      commitValue = revealFee + outSum;
      change = ins.reduce((a, u) => a + u.value, 0) - commitValue - commitFee;
      if (nOut === 1 || change >= P.DUST_GRAIN) break;
    }
    const totalIn = ins.reduce((a, u) => a + u.value, 0);
    if (change < 0) {
      throw new Error(`Insufficient funds: need ${fmtPRL(commitValue + commitFee)} but selected UTXOs total ${fmtPRL(totalIn)}. Shortfall ${fmtPRL(-change)}.`);
    }
    const { tweakedX } = P.tweakKeypath(wallet.internalXOnly);
    const commitOuts = [{ program: cki.commitXOnly, value: commitValue }];
    let changeShown = 0;
    if (change >= P.DUST_GRAIN) { commitOuts.push({ program: tweakedX, value: change }); changeShown = change; }
    else commitFee += Math.max(0, change); // dust change becomes extra fee

    const commit = P.buildKeypathTx(net(), ins.map((u) => ({
      txid: u.txid, vout: u.vout, value: u.value, priv: wallet.priv, internalXOnly: wallet.internalXOnly,
    })), commitOuts);
    const reveal = P.buildRevealTx(net(), {
      commitTxid: commit.txid, commitVout: 0, commitValue,
      commitProgram: cki.commitXOnly,
      internalPriv: wallet.priv, script, controlBlock: cki.controlBlock,
      outputs,
    });

    launch.built = { commit, reveal, cki, commitValue, commitFee, change: changeShown, revealFee: P.revealTxVBytes(script.length, outputs.length) * rate, outputs, feeProg: !!feeProg };
    renderBuilt();
    updateConn("transactions built — nothing broadcast", "on");
  } catch (e) {
    errBox.innerHTML = `<div class="verr">✕ ${esc(e.message)}</div>`;
  }
});

function renderBuilt() {
  const b = launch.built;
  if (!b) return;
  $("l-txs").classList.remove("hidden");
  $("l-commit-txid").textContent = b.commit.txid;
  $("l-commit-hex").value = b.commit.hex;
  $("l-reveal-txid").textContent = b.reveal.txid;
  $("l-reveal-hex").value = b.reveal.hex;
  const rows = [
    ["Commit fee", fmtPRL(b.commitFee)],
    ["Reveal fee", fmtPRL(b.revealFee)],
    ["Reveal owner output", fmtPRL(P.DUST_GRAIN)],
  ];
  if (b.feeProg) rows.push(["PRLS launch fee", fmtPRL(P.PRLS.mintFeeGrain)]);
  if (b.change) rows.push(["Change back to wallet", fmtPRL(b.change)]);
  rows.push(["Total from wallet", "<b>" + fmtPRL(b.commitValue + b.commitFee) + "</b>"]);
  $("l-cost").innerHTML = rows.map(([k, v]) => `<div class="krow"><span>${k}</span><span class="mono">${v}</span></div>`).join("");
  $("l-cost").classList.remove("hidden");
  $("l-commit-status").classList.add("hidden");
  $("l-reveal-status").classList.add("hidden");
  $("l-broadcast-reveal").disabled = true;
  stopPoll();
}
document.querySelectorAll("[data-copy]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const el = $(btn.dataset.copy);
    copyText(el.value !== undefined ? el.value : el.textContent, btn);
  });
});
$("l-commit-download").addEventListener("click", () => download("commit-" + $("l-commit-txid").textContent + ".hex", $("l-commit-hex").value));
$("l-reveal-download").addEventListener("click", () => download("reveal-" + $("l-reveal-txid").textContent + ".hex", $("l-reveal-hex").value));

/* broadcast sequencing */
function setStatus(el, cls, html) {
  el.className = "hint " + cls;
  el.innerHTML = html;
  el.classList.remove("hidden");
}
function stopPoll() {
  if (launch.pollTimer) { clearInterval(launch.pollTimer); launch.pollTimer = null; }
}
$("l-broadcast-commit").addEventListener("click", async () => {
  const b = launch.built;
  if (!b) return;
  const isMain = settings.network === "mainnet";
  if (!confirm(`Broadcast the COMMIT transaction?\n\n${b.commit.txid}\n\nThis moves ${fmtPRL(b.commitValue + b.commitFee)}${isMain ? " of REAL mainnet PRL" : ""}. This cannot be undone.`)) return;
  setStatus($("l-commit-status"), "", "Broadcasting…");
  try {
    const txid = await P.broadcastTx(settings.blockbook, b.commit.hex);
    setStatus($("l-commit-status"), "ok", `<strong>Commit broadcast:</strong> <code class="mono">${esc(txid)}</code><br><span class="muted">Waiting for confirmation… the reveal unlocks after 1 confirmation (or enable 0-conf override).</span>`);
    updateConn("commit broadcast", "on");
    pollCommit(txid);
  } catch (e) {
    setStatus($("l-commit-status"), "err", `<strong>Broadcast failed:</strong> ${esc(e.message)}`);
    updateConn("broadcast error", "err");
  }
});
async function pollCommit(txid) {
  stopPoll();
  const check = async () => {
    try {
      const st = await P.fetchTxStatus(settings.blockbook, txid);
      const conf = Number(st.confirmations ?? 0);
      if (conf >= 1) {
        setStatus($("l-commit-status"), "ok", `<strong>Commit confirmed</strong> (${conf} confirmation${conf > 1 ? "s" : ""}). You can broadcast the reveal.`);
        $("l-broadcast-reveal").disabled = false;
        stopPoll();
      } else {
        setStatus($("l-commit-status"), "", `<strong>Commit in mempool</strong> (0 confirmations). Waiting for a block…`);
        if ($("l-zero-conf").checked) $("l-broadcast-reveal").disabled = false;
      }
    } catch (e) {
      setStatus($("l-commit-status"), "", `<strong>Commit sent.</strong> Not visible yet — retrying… <span class="muted">${esc(e.message)}</span>`);
    }
  };
  await check();
  launch.pollTimer = setInterval(check, 15000);
}
$("l-zero-conf").addEventListener("change", () => {
  if ($("l-zero-conf").checked && launch.built && !$("l-commit-status").classList.contains("hidden")) {
    $("l-broadcast-reveal").disabled = false;
  }
});
$("l-broadcast-reveal").addEventListener("click", async () => {
  const b = launch.built;
  if (!b) return;
  const isMain = settings.network === "mainnet";
  if (!confirm(`Broadcast the REVEAL transaction?\n\n${b.reveal.txid}\n\nThis publishes the inscription${isMain ? " on REAL mainnet" : ""}. This cannot be undone.`)) return;
  setStatus($("l-reveal-status"), "", "Broadcasting…");
  try {
    const txid = await P.broadcastTx(settings.blockbook, b.reveal.hex);
    setStatus($("l-reveal-status"), "ok",
      `<strong>Reveal broadcast:</strong> <code class="mono">${esc(txid)}</code><br>` +
      `Your <strong>${esc(launch.op.op)} ${esc(launch.op.tick)}</strong> inscription is on-chain. ` +
      (launch.op.op === "deploy"
        ? "It becomes the canonical deploy if no earlier valid deploy for this ticker exists."
        : "Indexers will credit it once confirmed (PRLS mints additionally need the 1 PRL fee output confirmed)."));
    updateConn("reveal broadcast", "on");
    stopPoll();
  } catch (e) {
    setStatus($("l-reveal-status"), "err", `<strong>Broadcast failed:</strong> ${esc(e.message)}`);
    updateConn("broadcast error", "err");
  }
});

/* ---------- token directory ---------- */
let dirTokens = [];
$("dir-refresh").addEventListener("click", async () => {
  const box = $("dir-tokens"), st = $("dir-status");
  $("dir-detail").classList.add("hidden");
  if (!settings.indexer) { box.innerHTML = `<span class="muted">Set a Pearlscriptions indexer URL in Settings first.</span>`; return; }
  box.innerHTML = `<span class="muted">Loading…</span>`;
  try {
    const res = await fetch(settings.indexer + "/tokens", { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    dirTokens = (data && data.tokens) || [];
    st.textContent = dirTokens.length + " token(s)";
    updateConn("indexer ok", "on");
  } catch (e) {
    box.innerHTML = `<div class="verr">✕ Directory fetch failed: ${esc(e.message)}. Check the indexer URL and CORS.</div>`;
    updateConn("indexer error", "err");
    return;
  }
  renderDirTokens("");
});
$("dir-search").addEventListener("input", () => renderDirTokens($("dir-search").value.trim().toLowerCase()));
function progressOf(t) {
  try {
    const max = BigInt(t.maxSupply), minted = BigInt(t.mintedSupply);
    if (max <= 0n) return 0;
    return Math.min(100, Number((minted * 10000n) / max) / 100);
  } catch { return 0; }
}
function renderDirTokens(filter) {
  const box = $("dir-tokens");
  const list = dirTokens.filter((t) => !filter || String(t.ticker || "").toLowerCase().includes(filter));
  if (!list.length) { box.innerHTML = `<span class="muted">No tokens match.</span>`; return; }
  box.innerHTML = list.map((t) => {
    const p = progressOf(t);
    return `<div class="tcard" data-ticker="${esc(t.ticker)}" tabindex="0" role="button" aria-label="Token ${esc(t.ticker)}">
      <div class="tick">${esc(t.ticker ?? "?")}</div>
      <div class="kv"><span>Max supply</span><b>${fmtInt(t.maxSupply ?? "?")}</b></div>
      <div class="kv"><span>Minted</span><b>${fmtInt(t.mintedSupply ?? "?")}</b></div>
      ${t.holders != null ? `<div class="kv"><span>Holders</span><b>${fmtInt(t.holders)}</b></div>` : ""}
      <div class="pbar"><i style="width:${p.toFixed(1)}%"></i></div>
    </div>`;
  }).join("");
  box.querySelectorAll(".tcard").forEach((el) => {
    const open = () => loadTokenDetail(el.dataset.ticker);
    el.addEventListener("click", open);
    el.addEventListener("keydown", (e) => { if (e.key === "Enter") open(); });
  });
}
async function loadTokenDetail(ticker) {
  const d = $("dir-detail");
  d.classList.remove("hidden");
  d.innerHTML = `<div class="card"><span class="muted">Loading ${esc(ticker)}…</span></div>`;
  try {
    const res = await fetch(settings.indexer + "/tokens/" + encodeURIComponent(ticker));
    if (!res.ok) throw new Error("HTTP " + res.status);
    const t = await res.json();
    const rows = [
      ["Ticker", `<code class="mono">${esc(t.ticker)}</code>`],
      ["Max supply", fmtInt(t.maxSupply)],
      ["Minted", fmtInt(t.mintedSupply)],
      ["Per-mint limit", fmtInt(t.mintLimit ?? t.lim ?? "—")],
      ["Decimals", esc(t.decimals ?? t.dec ?? "—")],
      ["Holders", t.holders != null ? fmtInt(t.holders) : "—"],
      ["Deploy tx", t.deployTxid ? `<code class="mono">${esc(t.deployTxid)}</code>` : "—"],
    ];
    d.innerHTML = `<div class="card"><h2>${esc(t.ticker)}</h2>
      <div class="pbar"><i style="width:${progressOf(t).toFixed(1)}%"></i></div>
      <table class="dtable">${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("")}</table>
      <div class="row" style="margin-top:1rem">
        <button class="btn ghost" id="dir-mint-this" type="button">Mint this token →</button>
      </div></div>`;
    $("dir-mint-this").addEventListener("click", () => {
      $("m-tick").value = t.ticker;
      document.querySelector('[data-tab="mint"]').click();
      refreshMint();
    });
  } catch (e) {
    d.innerHTML = `<div class="card"><div class="verr">✕ Detail fetch failed: ${esc(e.message)}</div></div>`;
  }
}

/* ---------- fee auto-estimate ---------- */
$("fee-auto").addEventListener("click", async () => {
  if (!settings.blockbook) { alert("Set a Blockbook URL in Settings first."); return; }
  $("fee-auto").textContent = "…";
  try {
    const v = await P.fetchFeeRateGrainsPerVByte(settings.blockbook, 2);
    settings.feeRate = Math.max(1, Math.ceil(v));
    $("set-feerate").value = settings.feeRate;
    store.save(settings);
    updateConn("fee rate updated", "on");
  } catch (e) {
    alert("Fee estimate failed: " + e.message + "\nKeep the manual rate.");
    updateConn("fee estimate failed", "err");
  }
  $("fee-auto").textContent = "Auto";
});

/* ---------- footer ---------- */
$("donate-copy").addEventListener("click", (e) => copyText(DONATION, e.target));

/* ---------- init ---------- */
["set-network", "set-blockbook", "set-indexer", "set-feerate"].forEach((id) => {
  $(id).addEventListener("change", saveSettings);
});
applySettingsToUI();
refreshDeploy();
refreshMint();
updateConn(settings.blockbook ? "ready" : "set blockbook url");
})();
