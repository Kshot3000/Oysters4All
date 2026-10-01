/* Pearl Sign UI — five-step forge wizard.
 * Uses window.PearlSign (bundled from src/). No network calls except the
 * user-configured blockbook / pearld endpoints for fetch + broadcast. */
(() => {
"use strict";
const P = window.PearlSign;
const $ = (id) => document.getElementById(id);
const DONATE = "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d";

const S = {
  networkId: "mainnet",
  mode: "mnemonic",
  mnemonic: null,
  wallets: [],        // derived wallets idx 0..4 (hot modes)
  signIndex: 0,
  watchAddress: null, // watch-only
  watchProgram: null,
  utxos: [],          // {txid,vout,value,confirmations,spk,selected}
  recipients: [{ address: "", prl: "" }],
  unsigned: null,
  signed: null,
  signedPrevouts: [],
};
const net = () => P.NETWORKS[S.networkId];
const DEFAULT_BB = { mainnet: "https://blockbook.pearlresearch.ai", testnet: "" };

/* ---------- helpers ---------- */
function msg(el, kind, text) {
  el.hidden = false;
  el.className = "msg " + kind;
  el.textContent = text;
}
function hide(el) { el.hidden = true; }
function shortAddr(a) { return a.length > 46 ? a.slice(0, 24) + "…" + a.slice(-14) : a; }
function copyText(t) {
  navigator.clipboard.writeText(t).catch(() => {
    const ta = document.createElement("textarea");
    ta.value = t; document.body.appendChild(ta); ta.select();
    document.execCommand("copy"); ta.remove();
  });
}
function download(name, text) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function decodedView(dec, prevouts) {
  const lines = [
    `txid:      ${dec.txid}`,
    `version:   ${dec.version}   locktime: ${dec.locktime}`,
    `inputs:   ${dec.inputs.length}   outputs: ${dec.outputs.length}   segwit: ${dec.witness ? "yes" : "no"}`,
    "",
  ];
  dec.inputs.forEach((inp, i) => {
    const po = prevouts && prevouts[i];
    lines.push(`in[${i}]  ${inp.txid}:${inp.vout}  seq=${inp.sequence >>> 0}` +
      (po ? `  value=${P.fmtPRL(BigInt(po.value))} PRL` : ""));
    if (dec.witness && dec.witness[i]) {
      dec.witness[i].forEach((w, j) => {
        const tag = w.length === 64 ? "sig64" : w.length === 65 ? `sig+0x${w[64].toString(16).padStart(2, "0")}` : `len=${w.length}`;
        lines.push(`        wit[${j}] ${tag} ${P.bytesToHex(w).slice(0, 24)}…`);
      });
    }
  });
  lines.push("");
  dec.outputs.forEach((o, i) => {
    const d = P.describeSpk(o.spk, net());
    lines.push(`out[${i}] ${P.fmtPRL(o.value)} PRL  →  ${d.type}${d.address ? "  " + d.address : ""}`);
  });
  return lines.join("\n");
}

/* ---------- step nav ---------- */
const steps = [...document.querySelectorAll("#stepNav li")];
const panels = [...document.querySelectorAll("[data-panel]")];
function gotoStep(n) {
  steps.forEach((li) => {
    const s = Number(li.dataset.step);
    li.classList.toggle("active", s === n);
    if (s < n) li.classList.add("done");
  });
  panels.forEach((p) => { p.hidden = Number(p.dataset.panel) !== n; });
  window.scrollTo({ top: 0, behavior: "smooth" });
}
steps.forEach((li) => li.addEventListener("click", () => gotoStep(Number(li.dataset.step))));

/* ---------- step 1: key ---------- */
function setNetwork(id) {
  S.networkId = id;
  $("netBadge").textContent = id;
  $("netBadge").classList.toggle("testnet", id !== "mainnet");
  // changing network invalidates everything downstream
  S.wallets = []; S.signIndex = 0; S.watchAddress = null; S.utxos = [];
  S.unsigned = null; S.signed = null;
  renderAddrList(); renderUtxos();
  $("bbBase").value = DEFAULT_BB[id];
  if (S.mode === "watch" && $("watchAddr").value) loadWatch();
}
$("network").addEventListener("change", (e) => setNetwork(e.target.value));

$("keyMode").addEventListener("change", (e) => {
  S.mode = e.target.value;
  $("mnemonicBox").hidden = S.mode !== "mnemonic";
  $("wifBox").hidden = S.mode !== "wif";
  $("watchBox").hidden = S.mode !== "watch";
  $("hotWarn").hidden = S.mode === "watch";
  $("watchSignNote").hidden = S.mode !== "watch";
});

function renderAddrList() {
  const box = $("addrList");
  box.innerHTML = "";
  if (S.mode === "watch") {
    if (S.watchAddress) {
      const row = document.createElement("div");
      row.className = "addr-row sel";
      row.innerHTML = `<span class="idx">watch</span><span>${S.watchAddress}</span>`;
      box.appendChild(row);
    } else box.innerHTML = '<p class="muted">No watch address set.</p>';
    return;
  }
  if (!S.wallets.length) { box.innerHTML = "<p class='muted'>No key loaded yet.</p>"; return; }
  S.wallets.forEach((w, i) => {
    const row = document.createElement("div");
    row.className = "addr-row" + (i === S.signIndex ? " sel" : "");
    const span = document.createElement("span");
    span.innerHTML = `<span class="idx">m/…/0/${i}</span> ${w.address}`;
    const btn = document.createElement("button");
    btn.className = "btn small";
    btn.textContent = i === S.signIndex ? "signing ✓" : "use for signing";
    btn.addEventListener("click", () => { S.signIndex = i; renderAddrList(); });
    row.append(span, btn);
    box.appendChild(row);
  });
}

function deriveFromMnemonic(mn) {
  S.mnemonic = mn.trim();
  S.wallets = [];
  for (let i = 0; i < 5; i++) S.wallets.push(P.walletFromMnemonic(S.mnemonic, net(), 0, i));
  S.signIndex = 0;
  renderAddrList();
  markStepDone(1);
}
$("btnDerive").addEventListener("click", () => {
  try { deriveFromMnemonic($("mnemonic").value); }
  catch (e) { alert("Derivation failed: " + e.message); }
});
$("btnGen").addEventListener("click", () => {
  $("mnemonic").value = P.newMnemonic();
  deriveFromMnemonic($("mnemonic").value);
});
$("btnDeriveWif").addEventListener("click", () => {
  try {
    const w = P.walletFromWIF($("wif").value, net());
    S.wallets = [w]; S.signIndex = 0; S.mnemonic = null;
    renderAddrList(); markStepDone(1);
  } catch (e) { alert("WIF load failed: " + e.message); }
});
function loadWatch() {
  try {
    const d = P.decodeBech32m($("watchAddr").value, net().hrp);
    S.watchAddress = $("watchAddr").value.trim().toLowerCase();
    S.watchProgram = d.program;
    renderAddrList(); markStepDone(1);
    $("utxoAddr").value = S.watchAddress;
  } catch (e) { renderAddrList(); alert("Invalid address: " + e.message); }
}
$("btnWatch").addEventListener("click", loadWatch);

function signingWallet() {
  if (S.mode === "watch") return null;
  return S.wallets[S.signIndex] || null;
}
function spkOfSigner() {
  const w = signingWallet();
  if (!w) return null;
  return P.p2trScriptPubKey(P.tweakKeypath(w.internalXOnly).tweakedX);
}
function markStepDone(n) {
  const li = steps.find((l) => Number(l.dataset.step) === n);
  if (li) li.classList.add("done");
}

/* ---------- step 2: coins ---------- */
document.querySelectorAll("[data-utxotab]").forEach((t) => t.addEventListener("click", () => {
  document.querySelectorAll("[data-utxotab]").forEach((x) => x.classList.toggle("active", x === t));
  $("utxoFetch").hidden = t.dataset.utxotab !== "fetch";
  $("utxoPaste").hidden = t.dataset.utxotab !== "paste";
}));

$("btnFetchUtxos").addEventListener("click", async () => {
  const base = $("bbBase").value.trim() || DEFAULT_BB[S.networkId];
  const addr = $("utxoAddr").value.trim() || (signingWallet() || {}).address || S.watchAddress || "";
  const m = $("utxoMsg");
  if (!base) return msg(m, "err", "No blockbook configured for this network — paste a UTXO list instead.");
  if (!addr) return msg(m, "err", "Enter an address to fetch UTXOs for.");
  msg(m, "ok", "Fetching…");
  try {
    const list = await P.fetchUtxos(base, addr);
    const signerSpk = spkOfSigner();
    S.utxos = list.map((u) => ({ ...u, selected: true, spk: signerSpk }));
    try { localStorage.setItem("pearl-sign-bb", base); } catch {}
    hide(m); renderUtxos(); markStepDone(2);
  } catch (e) { msg(m, "err", "Fetch failed: " + e.message); }
});
$("btnParseUtxos").addEventListener("click", () => {
  const m = $("utxoMsg");
  try {
    const list = P.parseUtxoList($("utxoText").value, net());
    const signerSpk = spkOfSigner();
    S.utxos = list.map((u) => ({ ...u, selected: true, spk: u.spk || signerSpk }));
    hide(m); renderUtxos(); markStepDone(2);
  } catch (e) { msg(m, "err", "Parse failed: " + e.message); }
});
function renderUtxos() {
  const tbl = $("utxoTable"), body = tbl.querySelector("tbody");
  body.innerHTML = "";
  tbl.hidden = !S.utxos.length;
  $("utxoTotal").hidden = !S.utxos.length;
  let total = 0n;
  S.utxos.forEach((u, i) => {
    const tr = document.createElement("tr");
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.checked = u.selected;
    cb.addEventListener("change", () => { u.selected = cb.checked; renderUtxos(); refreshFeeCard(); });
    const td0 = document.createElement("td"); td0.appendChild(cb);
    const td1 = document.createElement("td"); td1.className = "mono"; td1.textContent = `${u.txid.slice(0, 12)}…:${u.vout}`;
    td1.title = `${u.txid}:${u.vout}`;
    const td2 = document.createElement("td"); td2.className = "r mono"; td2.textContent = P.fmtPRL(BigInt(u.value));
    const td3 = document.createElement("td"); td3.className = "r"; td3.textContent = u.confirmations;
    tr.append(td0, td1, td2, td3);
    body.appendChild(tr);
    if (u.selected) total += BigInt(u.value);
  });
  $("utxoTotal").querySelector("strong").textContent = `${P.fmtPRL(total)} PRL`;
}
try {
  const saved = localStorage.getItem("pearl-sign-bb");
  $("bbBase").value = saved || DEFAULT_BB.mainnet;
} catch { $("bbBase").value = DEFAULT_BB.mainnet; }

/* ---------- step 3: build ---------- */
function renderRecipients() {
  const box = $("recipients");
  box.innerHTML = "";
  S.recipients.forEach((r, i) => {
    const div = document.createElement("div");
    div.className = "recipient";
    const a = document.createElement("input");
    a.placeholder = `Recipient ${i + 1} address (prl1p…)`; a.value = r.address; a.spellcheck = false;
    a.addEventListener("input", () => { r.address = a.value; refreshFeeCard(); });
    const v = document.createElement("input");
    v.placeholder = "PRL"; v.value = r.prl;
    v.addEventListener("input", () => { r.prl = v.value; refreshFeeCard(); });
    const x = document.createElement("button");
    x.className = "btn small"; x.textContent = "✕"; x.title = "Remove";
    x.addEventListener("click", () => {
      if (S.recipients.length > 1) { S.recipients.splice(i, 1); renderRecipients(); refreshFeeCard(); }
    });
    div.append(a, v, x);
    box.appendChild(div);
  });
}
$("btnAddRecipient").addEventListener("click", () => {
  S.recipients.push({ address: "", prl: "" });
  renderRecipients();
});
$("feeRate").addEventListener("input", refreshFeeCard);
$("btnFeeEst").addEventListener("click", async () => {
  const base = $("bbBase").value.trim() || DEFAULT_BB[S.networkId];
  try {
    const r = await P.fetchFeeRate(base, 2);
    $("feeRate").value = Math.max(1, Math.ceil(r));
    refreshFeeCard();
  } catch (e) { alert("Fee estimate failed: " + e.message); }
});
function selectedUtxos() { return S.utxos.filter((u) => u.selected); }
function buildPlan() {
  // Returns {outputs, feeGrains, changeGrains, vbytes, totalIn} or throws.
  const sel = selectedUtxos();
  if (!sel.length) throw new Error("Select at least one UTXO in step 2.");
  const outs = [];
  for (const r of S.recipients) {
    const addr = r.address.trim().toLowerCase();
    if (!addr) continue;
    const d = P.decodeBech32m(addr, net().hrp);
    const grains = P.parsePRL(r.prl);
    if (grains <= 0n) throw new Error("Recipient amounts must be > 0.");
    if (grains < BigInt(P.DUST_GRAIN)) throw new Error(`Output ${P.fmtPRL(grains)} PRL is dust (< ${P.DUST_GRAIN} grains).`);
    outs.push({ program: d.program, value: Number(grains), address: addr });
  }
  if (!outs.length) throw new Error("Add at least one recipient with an address and amount.");
  const feeRate = Math.max(1, Number($("feeRate").value) || 10);
  const target = outs.reduce((a, o) => a + BigInt(o.value), 0n);
  const pick = P.selectCoins(sel, target, feeRate, outs.length);
  let changeOut = null;
  if (pick.change > 0n) {
    let changeAddr = $("changeAddr").value.trim().toLowerCase();
    if (!changeAddr) {
      if (S.mode === "watch") throw new Error("Watch-only mode: enter a change address explicitly.");
      if (S.mnemonic) {
        // fresh change address: next index past the derived batch
        changeAddr = P.walletFromMnemonic(S.mnemonic, net(), 0, S.wallets.length).address;
      } else {
        // WIF mode: no mnemonic to derive from — change returns to the signing key
        changeAddr = signingWallet().address;
      }
      $("changeAddr").value = changeAddr;
    }
    const d = P.decodeBech32m(changeAddr, net().hrp);
    changeOut = { program: d.program, value: Number(pick.change), address: changeAddr };
  }
  const outputs = changeOut ? [...outs, changeOut] : outs;
  const vbytes = P.keypathTxVBytes(pick.selected.length, outputs.length);
  const totalIn = pick.selected.reduce((a, u) => a + BigInt(u.value), 0n);
  return { selected: pick.selected, outputs, feeGrains: pick.fee, changeGrains: pick.change, vbytes, totalIn, feeRate };
}
function refreshFeeCard() {
  try {
    const p = buildPlan();
    $("fInputs").textContent = p.selected.length;
    $("fOutputs").textContent = p.outputs.length;
    $("fVbytes").textContent = `${p.vbytes} vB`;
    $("fFee").textContent = `${P.fmtPRL(p.feeGrains)} PRL (${p.feeRate} gr/vB)`;
    $("fChange").textContent = p.changeGrains > 0n ? `${P.fmtPRL(p.changeGrains)} PRL` : "— (dust → fee)";
    $("fTotal").textContent = `${P.fmtPRL(p.totalIn)} → ${P.fmtPRL(p.totalIn - p.feeGrains)}`;
  } catch {
    for (const id of ["fInputs", "fOutputs"]) $(id).textContent = "0";
    for (const id of ["fVbytes", "fFee", "fChange", "fTotal"]) $(id).textContent = "–";
  }
}
$("btnBuild").addEventListener("click", () => {
  const m = $("buildMsg");
  try {
    const p = buildPlan();
    const inputs = p.selected.map((u) => {
      const spk = u.spk || spkOfSigner();
      if (!spk) throw new Error("Watch-only unsigned build needs each UTXO's address — paste lines with a trailing address.");
      return { txid: u.txid, vout: u.vout, spk };
    });
    // Unsigned serialization: build the tx core without witness.
    const unsigned = unsignedTxHex(p, inputs);
    const dec = P.decodeRawTx(unsigned.hex);
    const prevouts = p.selected.map((u, i) => ({ value: u.value, spk: inputs[i].spk }));
    S.unsigned = { ...p, hex: unsigned.hex, txid: unsigned.txid, prevouts };
    S.signed = null; hide($("signedBox")); hide($("sigResults"));
    $("unsignedHex").value = unsigned.hex;
    $("unsignedDecoded").textContent = decodedView(dec, prevouts);
    hide(m); $("unsignedBox").hidden = false; markStepDone(3);
  } catch (e) { msg(m, "err", "Build failed: " + e.message); }
});
function unsignedTxHex(p, inputs) {
  // Serialize the unsigned (no-witness) form directly.
  const bytes = [];
  const pushU32 = (n) => bytes.push(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
  const pushVarint = (n) => {
    if (n < 0xfd) bytes.push(n);
    else if (n <= 0xffff) bytes.push(0xfd, n & 0xff, (n >> 8) & 0xff);
    else bytes.push(0xfe, n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
  };
  const pushU64 = (n) => {
    const b = BigInt(n);
    pushU32(Number(b & 0xffffffffn)); pushU32(Number((b >> 32n) & 0xffffffffn));
  };
  const rev = (hex) => P.hexToBytes(hex).reverse();
  pushU32(net().txVersion);
  pushVarint(inputs.length);
  for (const inp of inputs) {
    bytes.push(...rev(inp.txid)); pushU32(inp.vout); pushVarint(0); pushU32(0xffffffff);
  }
  pushVarint(p.outputs.length);
  for (const o of p.outputs) {
    const s = P.p2trScriptPubKey(o.program);
    pushU64(o.value); pushVarint(s.length); bytes.push(...s);
  }
  pushU32(0);
  const raw = Uint8Array.from(bytes);
  const txid = P.bytesToHex(P.sha256(P.sha256(raw)).reverse());
  return { hex: P.bytesToHex(raw), txid };
}

/* ---------- step 4: sign ---------- */
$("btnSign").addEventListener("click", () => {
  const m = $("signMsg");
  if (S.mode === "watch") return msg(m, "warn", "Watch-only mode: carry the unsigned hex to your offline signer.");
  const w = signingWallet();
  if (!w) return msg(m, "err", "Load a signing key in step 1 first.");
  if (!S.unsigned) return msg(m, "err", "Build the transaction in step 3 first.");
  try {
    const hashType = Number($("sighash").value);
    if (hashType === P.SIGHASH_SINGLE_ANYONECANPAY && S.unsigned.outputs.length < S.unsigned.selected.length) {
      throw new Error("SIGHASH_SINGLE|ANYONECANPAY needs at least as many outputs as inputs (input i signs output i).");
    }
    const inputs = S.unsigned.selected.map((u, i) => ({
      txid: u.txid, vout: u.vout, value: u.value,
      spk: S.unsigned.prevouts[i].spk,
      priv: w.priv, internalXOnly: w.internalXOnly,
    }));
    const outputs = S.unsigned.outputs.map((o) => ({ program: o.program, value: o.value }));
    const built = P.buildKeypathTxEx(net(), inputs, outputs, hashType);
    const results = P.verifySignedTx(net(), built.hex, S.unsigned.prevouts);
    renderSigResults($("sigResults"), results);
    const allOk = results.every((r) => r.ok);
    $("verifyPill").textContent = allOk ? "all signatures verified" : "VERIFICATION FAILED";
    $("verifyPill").className = "pill " + (allOk ? "ok" : "bad");
    if (!allOk) return msg(m, "err", "Local verification failed — the signed bytes are shown but NOT safe to broadcast.");
    S.signed = built;
    S.signedPrevouts = S.unsigned.prevouts;
    $("signedHex").value = built.hex;
    $("signedDecoded").textContent = decodedView(P.decodeRawTx(built.hex), S.unsigned.prevouts);
    hide(m); $("signedBox").hidden = false; markStepDone(4);
  } catch (e) { msg(m, "err", "Signing failed: " + e.message); }
});
function renderSigResults(box, results) {
  box.innerHTML = "";
  box.hidden = false;
  for (const r of results) {
    const div = document.createElement("div");
    div.className = "sig-row " + (r.ok ? "ok" : "bad");
    div.innerHTML = `<span class="tick">${r.ok ? "✓" : "✕"}</span><span><strong>input ${r.index}</strong> — ${r.reason}</span>`;
    box.appendChild(div);
  }
}
$("btnVerifyPasted").addEventListener("click", () => {
  $("verifyPasteBox").hidden = !$("verifyPasteBox").hidden;
});
$("btnDoVerify").addEventListener("click", () => {
  const m = $("verifyPasteMsg"), box = $("verifyPasteResults");
  try {
    const hex = $("verifyHex").value.trim();
    if (!hex) throw new Error("Paste a signed transaction hex first.");
    const prevouts = P.parseUtxoList($("verifyPrevouts").value, net())
      .map((u) => ({ value: u.value, spk: u.spk }));
    if (prevouts.some((p) => !p.spk)) {
      throw new Error("Each prevout line needs a trailing address so the verifier can rebuild the scriptPubKey.");
    }
    const results = P.verifySignedTx(net(), hex, prevouts);
    renderSigResults(box, results);
    const allOk = results.every((r) => r.ok);
    msg(m, allOk ? "ok" : "err",
      allOk ? `All ${results.length} signature(s) verify against the supplied prevouts.`
            : "Verification FAILED — do not trust or broadcast this transaction.");
  } catch (e) { msg(m, "err", "Verify failed: " + e.message); }
});

/* ---------- step 5: broadcast ---------- */
$("bcMethod").addEventListener("change", (e) => {
  $("bcPearld").hidden = e.target.value !== "pearld";
});
try {
  const ep = localStorage.getItem("pearl-sign-rpc-endpoint");
  if (ep) $("rpcEndpoint").value = ep;
  const eu = localStorage.getItem("pearl-sign-rpc-user");
  if (eu) $("rpcUser").value = eu;
} catch {}
$("btnBroadcast").addEventListener("click", async () => {
  const m = $("bcMsg");
  const hex = (S.signed && S.signed.hex) || $("signedHex").value.trim();
  if (!hex) return msg(m, "err", "Nothing to broadcast — sign a transaction in step 4 first.");
  msg(m, "ok", "Broadcasting…");
  try {
    let txid;
    if ($("bcMethod").value === "blockbook") {
      const base = $("bbBase").value.trim() || DEFAULT_BB[S.networkId];
      if (!base) throw new Error("No blockbook configured.");
      txid = await P.broadcastViaBlockbook(base, hex);
    } else {
      const endpoint = $("rpcEndpoint").value.trim();
      const user = $("rpcUser").value, pass = $("rpcPass").value;
      if (!endpoint || !user) throw new Error("Enter the RPC endpoint and credentials.");
      try {
        localStorage.setItem("pearl-sign-rpc-endpoint", endpoint);
        localStorage.setItem("pearl-sign-rpc-user", user);
      } catch {}
      txid = await P.pearldRpc(endpoint, user, pass, "sendrawtransaction", [hex]);
    }
    hide(m);
    $("bcTxid").textContent = txid;
    const bb = $("bbBase").value.trim() || DEFAULT_BB[S.networkId];
    $("bcLink").href = bb ? `${bb.replace(/\/$/, "")}/tx/${txid}` : "#";
    $("bcLink").style.display = bb ? "" : "none";
    $("bcResult").hidden = false;
    markStepDone(5);
  } catch (e) { msg(m, "err", "Broadcast failed: " + e.message); }
});

/* ---------- copy / download ---------- */
document.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", () => {
  copyText($(b.dataset.copy).value !== undefined ? $(b.dataset.copy).value : $(b.dataset.copy).textContent);
  b.textContent = "Copied ✓";
  setTimeout(() => { b.textContent = "Copy"; }, 1500);
}));
document.querySelectorAll("[data-dl]").forEach((b) => b.addEventListener("click", () => {
  const kind = b.dataset.dl;
  const hex = kind === "signed" ? $("signedHex").value : $("unsignedHex").value;
  download(`pearl-${kind}-tx.hex`, hex);
}));

/* ---------- init ---------- */
renderAddrList();
renderRecipients();
refreshFeeCard();
$("bbBase").value = $("bbBase").value || DEFAULT_BB.mainnet;
})();
