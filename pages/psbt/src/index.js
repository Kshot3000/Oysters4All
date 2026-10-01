/* Pearl PSBT UI — wires the six tabs to src/psbt-core.js.
 *
 * Plain IIFE-friendly module: imports only ./psbt-core.js (which itself
 * re-exports the audited sign core). Bundled by build.mjs into
 * pearl-psbt.bundle.js. The bundle sets window.PearlPSBT at the END of this
 * file — never via esbuild globalName (see AGENTS.md lesson: the var wrapper
 * would clobber the explicit assignment).
 *
 * Key hygiene: private keys are held in a local variable only for the
 * duration of one signing call, then the reference is dropped and the field
 * cleared. Keys are never persisted (not even in memory beyond the click).
 */
import * as C from "./psbt-core.js";

const $ = (id) => document.getElementById(id);
const STORE_KEY = "pearl-psbt-v1";

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
function show(el, on) { el.classList.toggle("hidden", !on); }
function setErr(id, msg) { $(id).textContent = msg || ""; }

/* ---------------- state (working PSBT only — never keys) ---------------- */

let S = { psbtBase64: "" };
function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) S = { ...S, ...JSON.parse(raw) };
  } catch { /* hostile localStorage: start fresh */ }
}
function saveState() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch { /* ignore */ }
}

/* ---------------- tabs ---------------- */

function gotoTab(name) {
  document.querySelectorAll("#tabs button").forEach((b) =>
    b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll("main .panel").forEach((p) =>
    p.classList.toggle("active", p.id === "tab-" + name));
  const sec = $("tab-" + name);
  if (sec) sec.scrollIntoView({ block: "start" });
}
document.querySelectorAll("#tabs button").forEach((b) =>
  b.addEventListener("click", () => gotoTab(b.dataset.tab)));
document.querySelectorAll("[data-goto]").forEach((a) =>
  a.addEventListener("click", (e) => { e.preventDefault(); gotoTab(a.dataset.goto); }));

/* ---------------- copy / download ---------------- */

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  if (btn) {
    const old = btn.textContent;
    btn.textContent = "copied ✓";
    setTimeout(() => { btn.textContent = old; }, 1500);
  }
}
function download(name, text, mime) {
  const blob = new Blob([text], { type: mime || "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}

function setCurrent(b64) {
  S.psbtBase64 = b64;
  saveState();
}
function shortAddr(a) { return a.length > 24 ? a.slice(0, 14) + "…" + a.slice(-8) : a; }

/* ================= 1 · CREATE ================= */

function parseCreateInputs(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  return lines.map((line, li) => {
    const parts = line.split(":");
    if (parts.length < 4) throw new Error(`input line ${li + 1}: want txid:vout:amountGrains:internalKeyHex[:leafAsm]`);
    const [txid, voutS, amountS, internalKey, ...rest] = parts;
    const vout = Number(voutS);
    if (!/^[0-9a-fA-F]{64}$/.test(txid)) throw new Error(`input line ${li + 1}: bad txid`);
    if (!Number.isInteger(vout) || vout < 0 || vout > 0xffffffff) throw new Error(`input line ${li + 1}: bad vout`);
    const amount = C.parseGrains(amountS);
    if (!/^[0-9a-fA-F]{64}$/.test(internalKey)) throw new Error(`input line ${li + 1}: internal key must be 32-byte hex`);
    const inp = { txid: txid.toLowerCase(), vout, amount, internalKey: internalKey.toLowerCase() };
    if (rest.length > 0) {
      inp.mode = "scriptpath";
      inp.script = rest.join(":").trim();
      if (!inp.script) throw new Error(`input line ${li + 1}: empty leaf script`);
    } else {
      inp.mode = "keypath";
    }
    return inp;
  });
}
function parseCreateOutputs(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  return lines.map((line, li) => {
    const ci = line.indexOf(":");
    if (ci < 0) throw new Error(`output line ${li + 1}: want address:amountGrains or OP_RETURN:hexdata`);
    const head = line.slice(0, ci).trim(), tail = line.slice(ci + 1).trim();
    if (/^op_return$/i.test(head)) {
      if (!/^[0-9a-fA-F]*$/.test(tail) || tail.length % 2 !== 0)
        throw new Error(`output line ${li + 1}: OP_RETURN data must be even hex`);
      if (tail.length / 2 > 80) throw new Error(`output line ${li + 1}: OP_RETURN data > 80 bytes`);
      return { opReturn: tail.toLowerCase(), amount: 0n };
    }
    const amount = C.parseGrains(tail);
    C.validatePrlAddress(head); // throws on any rule violation
    return { address: head, amount };
  });
}

function loadDemo() {
  const ex = C.buildExamplePsbt();
  setCurrent(ex.base64);
  renderCreated(ex);
  return ex.base64;
}
function renderCreated(ex) {
  $("c-nin").textContent = ex.inputCount;
  $("c-nout").textContent = ex.outputCount;
  $("c-in").textContent = C.grainsToPrl(ex.totalIn);
  $("c-out-amt").textContent = C.grainsToPrl(ex.totalOut);
  $("c-fee").textContent = C.grainsToPrl(ex.fee);
  $("c-txid").textContent = C.txidOfUnsigned(C.parsePsbtBase64(ex.base64).unsignedTxBytes);
  $("c-b64").textContent = ex.base64;
  show($("c-out"), true);
}
function buildFromText() {
  setErr("c-err", "");
  try {
    const inputs = parseCreateInputs($("c-inputs").value);
    const outputs = parseCreateOutputs($("c-outputs").value);
    const locktime = Number($("c-locktime").value.trim());
    if (!Number.isInteger(locktime) || locktime < 0 || locktime > 0xffffffff)
      throw new Error("locktime must be a uint32");
    const sighash = Number($("c-sighash").value);
    const ex = C.createPsbt({ inputs, outputs, locktime, sighashType: sighash });
    setCurrent(ex.base64);
    renderCreated(ex);
    return ex.base64;
  } catch (e) {
    setErr("c-err", e.message);
    show($("c-out"), false);
    throw e;
  }
}
$("c-demo").addEventListener("click", () => { setErr("c-err", ""); try { loadDemo(); } catch (e) { setErr("c-err", e.message); } });
$("c-build").addEventListener("click", () => { try { buildFromText(); } catch { /* err shown */ } });
$("c-copy").addEventListener("click", (e) => copyText($("c-b64").textContent, e.target));
$("c-download").addEventListener("click", () => download("unsigned.psbt", $("c-b64").textContent, "application/octet-stream"));
$("c-to-inspect").addEventListener("click", () => { $("i-b64").value = $("c-b64").textContent; gotoTab("inspect"); });

/* ================= 2 · INSPECT ================= */

function kvRow(k, v, wrap) {
  return `<div class="kv"><span>${esc(k)}</span><code class="mono${wrap ? " wrap" : ""}">${esc(v)}</code></div>`;
}
function inspectText(b64) {
  setErr("i-err", "");
  const psbt = C.parsePsbtBase64(b64.trim());
  const d = C.describePsbt(psbt);
  // global
  $("i-global").innerHTML =
    kvRow("Tx version", String(d.global.txVersion)) +
    kvRow("Locktime", String(d.global.locktime)) +
    kvRow("Unsigned txid", d.global.unsignedTxid, true) +
    kvRow("Inputs / outputs", `${d.global.nInputs} / ${d.global.nOutputs}`) +
    (d.global.modifiable ? kvRow("Modifiable flags", `${d.global.modifiable.raw} — ${d.global.modifiable.flags.join(", ")}`) : "") +
    (d.global.xpubs ? kvRow("XPubs", String(d.global.xpubs)) : "") +
    (d.global.proprietary.length ? kvRow("Proprietary keys", d.global.proprietary.join(", "), true) : "");
  // inputs
  $("i-inputs").innerHTML = d.inputs.map((inp) => {
    const w = inp.witnessUtxo;
    const leaves = inp.leaves.map((l, j) =>
      `<li class="info">leaf ${j}: hash <code class="mono">${esc(l.leafHashHex || "(bad script)")}</code>` +
      (l.matchesMerkleRoot === true ? " ✓ matches merkle root" : l.matchesMerkleRoot === false ? " ✗ NOT the merkle root" : "") +
      (l.cbMatchesInternalKey === false ? " ✗ control block internal key ≠ declared internal key" : "") +
      (l.asm ? `<br><code class="mono">${esc(l.asm)}</code>` : "") + `</li>`).join("");
    const sigs = [
      inp.keySig ? `<li class="info">keypath sig: ${inp.keySig.len} bytes · SIGHASH_${esc(inp.keySig.sighash)}</li>` : "",
      ...inp.scriptSigs.map((s) =>
        `<li class="info">script sig: ${s.len} bytes · SIGHASH_${esc(s.sighash)} · pubkey <code class="mono">${esc(s.pubkeyHex.slice(0, 16))}…</code> · leaf ${s.leafKnown ? "known ✓" : "<strong>UNKNOWN ✗</strong>"}</li>`),
    ].join("");
    const derivs = inp.derivations.map((x) =>
      `<li class="info"><code class="mono">${esc(x.xonlyHex.slice(0, 16))}…</code>` +
      (x.error ? ` — bad: ${esc(x.error)}` : ` · fp ${esc(x.masterFp)} · path m/${x.path.map((n) => (n & 0x80000000) ? (n & 0x7fffffff) + "'" : String(n)).join("/")}`) + `</li>`).join("");
    return `<div class="card"><h4>Input ${inp.index} ${inp.finalized ? "· FINALIZED" : ""}</h4>` +
      kvRow("Prevout", inp.prevout, true) +
      kvRow("Sequence", inp.sequence) +
      (w ? kvRow("Witness UTXO", `${C.grainsToPrl(w.amount)} PRL → ${w.desc.kind === "p2tr" ? shortAddr(w.desc.address) : w.desc.kind}`) : kvRow("Witness UTXO", inp.hasNonWitnessUtxo ? "(non-witness UTXO only)" : "MISSING — signer cannot verify amounts!")) +
      kvRow("Sighash", inp.sighash) +
      (inp.internalKeyHex ? kvRow("Internal key", inp.internalKeyHex.slice(0, 16) + "…") : "") +
      (inp.merkleRootHex ? kvRow("Merkle root", inp.merkleRootHex.slice(0, 16) + "…") : "") +
      (leaves ? `<h4>Tap leaves (${inp.leaves.length})</h4><ul class="checklist">${leaves}</ul>` : "") +
      (sigs ? `<h4>Partial signatures</h4><ul class="checklist">${sigs}</ul>` : "") +
      (derivs ? `<h4>BIP-32 derivations</h4><ul class="checklist">${derivs}</ul>` : "") +
      `</div>`;
  }).join("");
  // outputs
  $("i-outputs").innerHTML =
    `<div class="tablewrap"><table class="mono"><thead><tr><th>#</th><th>amount (PRL)</th><th>destination</th><th>unsigned-tx match</th></tr></thead><tbody>` +
    d.outputs.map((o) => {
      const dest = !o.desc ? "—"
        : o.desc.kind === "p2tr" ? `P2TR <code>${esc(shortAddr(o.desc.address))}</code>`
        : o.desc.kind === "op_return" ? `OP_RETURN <code>${esc(o.desc.dataHex.slice(0, 40))}${o.desc.dataHex.length > 40 ? "…" : ""}</code>`
        : `<code>${esc(o.desc.asm.slice(0, 60))}</code>`;
      return `<tr><td>${o.index}</td><td>${o.amountPrl}</td><td>${dest}</td><td>${o.matchesUnsignedTx === false ? "<strong>✗ MISMATCH</strong>" : "✓"}</td></tr>`;
    }).join("") + `</tbody></table></div>`;
  // issues
  $("i-issues").innerHTML = d.issues.length === 0
    ? `<li class="pass">No issues — maps parse, counts line up, leaves commit correctly.</li>`
    : d.issues.map((x) => `<li class="fail">${esc(x)}</li>`).join("");
  show($("i-out"), true);
  return d;
}
$("i-parse").addEventListener("click", () => {
  try { inspectText($("i-b64").value); } catch (e) { setErr("i-err", e.message); show($("i-out"), false); }
});
$("i-use-current").addEventListener("click", () => {
  if (!S.psbtBase64) { setErr("i-err", "no current PSBT — create or load one first"); return; }
  $("i-b64").value = S.psbtBase64;
});

/* ================= 3 · SIGN ================= */

function wipeKeyField() { $("s-key").value = ""; }
$("s-wipe").addEventListener("click", wipeKeyField);
$("s-gen").addEventListener("click", () => {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  $("s-key").value = C.bytesToHex(b);
  $("s-key").type = "text";
  setErr("s-err", "test key generated — fund it never, reuse it never");
});
function signText(b64, index, sighash, keyText) {
  setErr("s-err", "");
  const psbt = C.parsePsbtBase64(b64.trim());
  let priv;
  try {
    priv = C.parsePrivKey(keyText.trim());
  } catch (e) { throw new Error("private key: " + e.message); }
  let result;
  try {
    result = C.signPsbtInput({ psbt, inputIndex: index, privKey: priv, hashType: sighash });
  } finally {
    priv.fill(0); // wipe the key material immediately after the signing call
    wipeKeyField();
  }
  const outB64 = C.psbtToBase64(psbt);
  $("s-mode").textContent = result.mode;
  $("s-keynote").textContent = result.keyNote;
  $("s-sighash-hex").textContent = result.sighashHex;
  $("s-sig").textContent = result.sigHex;
  $("s-verified").textContent = "✓ signature re-verified before write";
  $("s-b64out").textContent = outB64;
  show($("s-out"), true);
  return { result, base64: outB64 };
}
$("s-sign").addEventListener("click", () => {
  try {
    const idx = Number($("s-index").value.trim());
    if (!Number.isInteger(idx) || idx < 0) throw new Error("input index must be a non-negative integer");
    const r = signText($("s-b64").value, idx, Number($("s-sighash").value), $("s-key").value);
    setErr("s-err", "");
    void r;
  } catch (e) { setErr("s-err", e.message); show($("s-out"), false); }
});
$("s-use-current").addEventListener("click", () => {
  if (!S.psbtBase64) { setErr("s-err", "no current PSBT — create or load one first"); return; }
  $("s-b64").value = S.psbtBase64;
});
$("s-copy").addEventListener("click", (e) => copyText($("s-b64out").textContent, e.target));
$("s-make-current").addEventListener("click", () => { setCurrent($("s-b64out").textContent); setErr("s-err", "signed PSBT is now current"); });

/* ================= 4 · COMBINE ================= */

function combineText(aB64, bB64) {
  setErr("cb-err", "");
  const merged = C.combinePsbts(aB64.trim(), bB64.trim());
  const d = C.describePsbt(C.parsePsbtBase64(merged));
  $("cb-summary").innerHTML = d.inputs.map((inp) =>
    `<div class="kv"><span>Input ${inp.index}</span><code class="mono">` +
    `${inp.keySig ? "keypath sig ✓ " : ""}` +
    `${inp.scriptSigs.length ? inp.scriptSigs.length + " script sig(s) ✓ " : ""}` +
    `${!inp.keySig && !inp.scriptSigs.length ? "unsigned" : ""}</code></div>`).join("");
  $("cb-b64").textContent = merged;
  show($("cb-out"), true);
  return merged;
}
$("cb-go").addEventListener("click", () => {
  try { combineText($("cb-a").value, $("cb-b").value); }
  catch (e) { setErr("cb-err", e.message); show($("cb-out"), false); }
});
$("cb-a-current").addEventListener("click", () => { $("cb-a").value = S.psbtBase64 || ""; });
$("cb-b-current").addEventListener("click", () => { $("cb-b").value = S.psbtBase64 || ""; });
$("cb-copy").addEventListener("click", (e) => copyText($("cb-b64").textContent, e.target));
$("cb-make-current").addEventListener("click", () => { setCurrent($("cb-b64").textContent); setErr("cb-err", "combined PSBT is now current"); });

/* ================= 5 · FINALIZE ================= */

function finalizeText(b64) {
  setErr("f-err", "");
  const fin = C.finalizePsbt(b64.trim());
  $("f-report").innerHTML = fin.results.map((r) =>
    `<li class="pass">input finalized — ${esc(r.desc)}</li>`).join("");
  const ext = C.extractTx(fin.base64);
  $("f-txid").textContent = ext.txid;
  $("f-vsize").textContent = `${ext.vsize} vbytes`;
  $("f-hex").textContent = ext.hex;
  show($("f-out"), true);
  return { fin, ext };
}
$("f-go").addEventListener("click", () => {
  try { finalizeText($("f-b64").value); }
  catch (e) { setErr("f-err", e.message); show($("f-out"), false); }
});
$("f-use-current").addEventListener("click", () => {
  if (!S.psbtBase64) { setErr("f-err", "no current PSBT — create or load one first"); return; }
  $("f-b64").value = S.psbtBase64;
});
$("f-copy").addEventListener("click", (e) => copyText($("f-hex").textContent, e.target));
$("f-download").addEventListener("click", () => download("final.txhex", $("f-hex").textContent, "text/plain"));

/* ---------------- footer donate copy ---------------- */

$("donate-copy").addEventListener("click", (e) => copyText($("donate-addr").textContent.trim(), e.target));

/* ---------------- init ---------------- */

loadState();

/* The bundle sets window.PearlPSBT at the END of this file — never via
 * esbuild globalName (see AGENTS.md lesson). The QA harness drives the desk
 * through this surface without touching the DOM directly. */
window.PearlPSBT = {
  core: C,
  gotoTab,
  getCurrent: () => S.psbtBase64,
  setCurrent,
  loadDemo,
  buildFromText,
  inspectText,
  signText,
  combineText,
  finalizeText,
  wipeKeyField,
};
