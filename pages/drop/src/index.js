/* Pearl Drop UI — wires the six tabs to src/logic.js.
 *
 * Plain IIFE-friendly module: no imports beyond ./logic.js (bundled by
 * build.mjs into pearl-drop.bundle.js). The bundle sets window.PearlDrop at
 * the END of this file — never via esbuild globalName (see AGENTS.md lesson:
 * the var wrapper would clobber the explicit assignment).
 */
import {
  encodeBech32m,
  prlToGrains, grainsToPrl, validateDropAddress,
  composeCampaign, campaignId, transitionStatus, fingerprint,
  parseDropCsv, dedupeRecipients,
  dropLeafHash, buildDropTree, dropProof, verifyDropProof,
  composeSeal, dropEnvelopeBody, verifySealPackage, claimForAddress,
  bytesToHex,
} from "./logic.js";

const $ = (id) => document.getElementById(id);
const STORE_KEY = "pearl-drop-v1";

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
function show(el, on) { el.classList.toggle("hidden", !on); }
function setErr(id, msg) { $(id).textContent = msg || ""; }

/* ---------------- state ---------------- */

let S = {
  campaign: { name: "", tick: "", start: "2026-10-01", end: "2026-10-31", contact: "" },
  status: "draft",
  csv: "",
  campaignJson: null,
  locked: false,
  treeMeta: null,
  sealJson: null,
};
function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) S = { ...S, ...JSON.parse(raw) };
  } catch { /* hostile localStorage: start fresh */ }
}
function saveState() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch { /* ignore */ }
}

/* in-memory derived data (rebuilt from S.csv — identical while locked) */
let MEM = { parsed: null, deduped: null, tree: null, claim: null };

function rebuildMemory() {
  const parsed = parseDropCsv(S.csv);
  const deduped = dedupeRecipients(parsed.rows);
  let tree = null;
  if (deduped.recipients.length > 0) {
    const leaves = deduped.recipients.map((r) => dropLeafHash(r.index, r.address, r.amountGrains));
    tree = buildDropTree(leaves);
  }
  MEM = { parsed, deduped, tree, claim: null };
  return MEM;
}

/* ---------------- sample data (deterministic, vendored encoder) ---------------- */

function sampleProgram(seed) {
  return Uint8Array.from({ length: 32 }, (_, i) => (seed + i * 37) & 255);
}
function sampleCsv() {
  const rows = [
    [11, "1.5"],
    [22, "0.25"],
    [33, "2.00000001"],
    [44, "10"],
  ];
  return "address,amount\n" + rows.map(([seed, amt]) => `${encodeBech32m("prl", 1, sampleProgram(seed))},${amt}`).join("\n") + "\n";
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
  const blob = new Blob([text], { type: mime || "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

/* ---------------- campaign tab ---------------- */

function fillCampaignForm() {
  $("c-name").value = S.campaign.name;
  $("c-tick").value = S.campaign.tick;
  $("c-start").value = S.campaign.start;
  $("c-end").value = S.campaign.end;
  $("c-contact").value = S.campaign.contact;
}
function renderStatus() {
  const b = $("c-status");
  b.textContent = S.status;
  b.className = "status-badge st-" + S.status;
}
$("c-compose").addEventListener("click", () => {
  setErr("c-err", "");
  if (S.locked) { setErr("c-err", "Campaign is sealed into the tree — reset the tree to edit."); return; }
  try {
    const { json } = composeCampaign({
      name: $("c-name").value,
      tick: $("c-tick").value,
      startsAt: $("c-start").value,
      endsAt: $("c-end").value,
      contact: $("c-contact").value,
    });
    S.campaign = {
      name: $("c-name").value.trim(),
      tick: $("c-tick").value.trim().toUpperCase(),
      start: $("c-start").value,
      end: $("c-end").value,
      contact: $("c-contact").value.trim(),
    };
    S.campaignJson = json;
    saveState();
    $("c-json").textContent = JSON.stringify(JSON.parse(json), null, 2);
    $("c-id").textContent = campaignId(json);
    $("c-fp").textContent = fingerprint(campaignId(json));
    show($("c-out"), true);
  } catch (e) {
    setErr("c-err", e.message);
  }
});
$("c-copy").addEventListener("click", (e) => copyText(S.campaignJson || "", e.target));
for (const [btn, action] of [["c-open", "open"], ["c-close", "close"], ["c-reopen", "reopen"]]) {
  $(btn).addEventListener("click", () => {
    setErr("c-status-err", "");
    try {
      S.status = transitionStatus(S.status, action);
      saveState();
      renderStatus();
    } catch (e) {
      setErr("c-status-err", e.message);
    }
  });
}

/* ---------------- recipients tab ---------------- */

function renderRecipients() {
  const { parsed, deduped } = MEM;
  if (!parsed) { show($("r-out"), false); return; }
  show($("r-out"), true);
  const total = deduped.recipients.reduce((a, r) => a + r.amountGrains, 0n);
  $("r-count").textContent = deduped.recipients.length;
  $("r-total").textContent = grainsToPrl(total);
  $("r-invalid-n").textContent = parsed.invalid.length;
  $("r-dup-n").textContent = deduped.duplicates.length;
  const tb = $("r-table").querySelector("tbody");
  tb.innerHTML = deduped.recipients.map((r) =>
    `<tr><td>${r.index}</td><td>${esc(r.address)}</td><td>${esc(grainsToPrl(r.amountGrains))}</td><td>${r.amountGrains}</td></tr>`
  ).join("");
  $("r-invalid").innerHTML = parsed.invalid.length
    ? parsed.invalid.map((x) => `<li class="bad"><span class="mono">line ${x.line}</span> — ${esc(x.reason)}<br><code class="mono dim">${esc(x.raw)}</code></li>`).join("")
    : `<li class="good">none — every row parsed clean</li>`;
  $("r-dups").innerHTML = deduped.duplicates.length
    ? deduped.duplicates.map((x) => `<li class="warn"><span class="mono">line ${x.line}</span> — ${esc(x.address)} (${esc(x.reason)})</li>`).join("")
    : `<li class="good">none</li>`;
}
function renderLock() {
  show($("r-locked"), S.locked);
  $("r-csv").disabled = S.locked;
  $("r-parse").disabled = S.locked;
  $("r-sample").disabled = S.locked;
  ["c-name", "c-tick", "c-start", "c-end", "c-contact", "c-compose"].forEach((id) => {
    $(id).disabled = S.locked;
  });
}
$("r-sample").addEventListener("click", () => {
  $("r-csv").value = sampleCsv();
});
$("r-parse").addEventListener("click", () => {
  setErr("r-err", "");
  try {
    S.csv = $("r-csv").value;
    saveState();
    rebuildMemory();
    renderRecipients();
    if (MEM.deduped.recipients.length === 0) setErr("r-err", "No valid recipient rows — check the invalid list below.");
  } catch (e) {
    setErr("r-err", e.message);
  }
});
$("r-unlock").addEventListener("click", () => {
  S.locked = false;
  S.treeMeta = null;
  S.sealJson = null;
  saveState();
  renderLock();
  show($("m-out"), false);
  show($("s-out"), false);
});

/* ---------------- merkle tab ---------------- */

$("m-compute").addEventListener("click", () => {
  setErr("m-err", "");
  try {
    if (!S.campaignJson) throw new Error("Compose the campaign header first (Campaign tab).");
    if (S.status === "draft" || S.status === "open")
      throw new Error('Close the campaign first (Campaign tab → "close campaign") — open campaigns cannot be rooted.');
    if (MEM.deduped.recipients.length === 0) {
      rebuildMemory();
      if (MEM.deduped.recipients.length === 0) throw new Error("No valid recipients — parse the CSV in the Recipients tab first.");
    }
    const total = MEM.deduped.recipients.reduce((a, r) => a + r.amountGrains, 0n);
    S.locked = true; // campaign + recipients freeze the moment the root exists
    S.treeMeta = {
      rootHex: MEM.tree.rootHex,
      depth: MEM.tree.depth,
      leafCount: MEM.tree.leafCount,
      totalGrains: total.toString(),
    };
    saveState();
    renderLock();
    $("m-root").textContent = MEM.tree.rootHex;
    $("m-depth").textContent = MEM.tree.depth;
    $("m-leaves").textContent = MEM.tree.leafCount;
    $("m-total").textContent = grainsToPrl(total);
    show($("m-out"), true);
  } catch (e) {
    setErr("m-err", e.message);
  }
});
$("m-reset").addEventListener("click", () => {
  S.locked = false;
  S.treeMeta = null;
  S.sealJson = null;
  MEM.tree = null;
  saveState();
  renderLock();
  show($("m-out"), false);
  show($("s-out"), false);
});
$("m-lookup").addEventListener("click", () => {
  setErr("m-proof-err", "");
  show($("m-proof"), false);
  try {
    if (!MEM.tree) throw new Error("Compute the Merkle root first.");
    const addr = validateDropAddress($("m-addr").value);
    const rec = MEM.deduped.recipients.find((r) => r.address === addr);
    if (!rec) throw new Error("Address is not in this recipient list.");
    const proof = dropProof(MEM.tree, rec.index);
    const leafHex = bytesToHex(dropLeafHash(rec.index, rec.address, rec.amountGrains));
    $("m-proof").textContent = JSON.stringify({
      address: rec.address,
      index: rec.index,
      amount_grains: rec.amountGrains.toString(),
      amount_prl: grainsToPrl(rec.amountGrains),
      leaf: leafHex,
      root: MEM.tree.rootHex,
      proof,
    }, null, 2);
    show($("m-proof"), true);
  } catch (e) {
    setErr("m-proof-err", e.message);
  }
});
$("m-export").addEventListener("click", () => {
  if (!MEM.tree) return;
  const bundle = MEM.deduped.recipients.map((rec) => ({
    address: rec.address,
    index: rec.index,
    amount_grains: rec.amountGrains.toString(),
    amount_prl: grainsToPrl(rec.amountGrains),
    leaf: bytesToHex(dropLeafHash(rec.index, rec.address, rec.amountGrains)),
    proof: dropProof(MEM.tree, rec.index),
  }));
  download("pearl-drop-proofs.json", JSON.stringify({
    app: "Pearl Drop",
    campaign: JSON.parse(S.campaignJson),
    root: MEM.tree.rootHex,
    depth: MEM.tree.depth,
    proofs: bundle,
  }, null, 2));
});

/* ---------------- seal tab ---------------- */

$("s-compose").addEventListener("click", () => {
  setErr("s-err", "");
  try {
    if (!S.locked || !S.treeMeta) throw new Error("Compute the Merkle root first (Merkle tab).");
    if (S.status !== "closed") throw new Error('Campaign must be "closed" to seal (Campaign tab).');
    const header = JSON.parse(S.campaignJson);
    const { json, sealId } = composeSeal({
      campaignJson: S.campaignJson,
      tick: header.tick,
      rootHex: S.treeMeta.rootHex,
      leafCount: S.treeMeta.leafCount,
      totalGrains: BigInt(S.treeMeta.totalGrains),
      sealedAtIso: new Date().toISOString(),
    });
    S.sealJson = json;
    S.sealId = sealId;
    S.status = "sealed";
    saveState();
    renderStatus();
    $("s-doc").textContent = JSON.stringify(JSON.parse(json), null, 2);
    $("s-sealid").textContent = sealId;
    $("s-envelope").textContent = JSON.stringify(dropEnvelopeBody(json), null, 2);
    show($("s-out"), true);
  } catch (e) {
    setErr("s-err", e.message);
  }
});
$("s-copy").addEventListener("click", (e) => copyText(S.sealJson || "", e.target));
$("s-copy-env").addEventListener("click", (e) =>
  copyText(JSON.stringify(dropEnvelopeBody(S.sealJson || "{}")), e.target));
$("s-download").addEventListener("click", () => {
  if (S.sealJson) download("pearl-drop-seal.json", S.sealJson);
});

function renderChecks(listEl, checks) {
  listEl.innerHTML = checks.map((c) =>
    `<li class="${c.ok ? "good" : "bad"}"><strong>${esc(c.label)}</strong> — ${esc(c.detail)}</li>`
  ).join("");
}
$("s-verify").addEventListener("click", () => {
  const v = verifySealPackage($("s-seal-json").value, $("s-verify-csv").value);
  const verdict = $("s-verdict");
  verdict.className = "verdict " + (v.ok ? "valid" : "invalid");
  verdict.innerHTML = v.ok
    ? "✓ PROVEN — seal document fully re-derived from the recipient list"
    : "✗ NOT PROVEN — this package does not check out";
  show(verdict, true);
  renderChecks($("s-checks"), v.checks);
});

/* ---------------- claim tab ---------------- */

$("cl-use-current").addEventListener("click", () => {
  if (S.sealJson) $("cl-seal-json").value = S.sealJson;
  if (S.csv) $("cl-csv").value = S.csv;
});
$("cl-check").addEventListener("click", () => {
  const r = claimForAddress($("cl-seal-json").value, $("cl-csv").value, $("cl-addr").value);
  MEM.claim = r.ok && r.valid ? r : null;
  const verdict = $("cl-verdict");
  verdict.className = "verdict " + (r.ok && r.valid ? "valid" : "invalid");
  verdict.innerHTML = (r.ok && r.valid)
    ? `✓ VALID CLAIM — <span class="mono">${esc(r.amountPrl)} ${esc(r.tick)}</span> for this address`
    : `✗ INVALID — ${r.checks.length ? esc(r.checks[r.checks.length - 1].detail) : "no result"}`;
  show(verdict, true);
  if (r.ok && r.valid) {
    $("cl-amount").textContent = `${r.amountPrl} ${r.tick} (${r.amountGrains} grains)`;
    $("cl-index").textContent = String(r.index);
    $("cl-leaf").textContent = r.leafHex;
    $("cl-proof").textContent = JSON.stringify({
      address: r.address,
      index: r.index,
      amount_grains: r.amountGrains.toString(),
      leaf: r.leafHex,
      root: r.rootHex,
      proof: r.proof,
    }, null, 2);
    show($("cl-detail"), true);
  } else {
    show($("cl-detail"), false);
  }
});
$("cl-copy-proof").addEventListener("click", (e) => {
  if (MEM.claim) copyText($("cl-proof").textContent, e.target);
});

/* ---------------- footer ---------------- */

$("donate-copy").addEventListener("click", (e) =>
  copyText($("donate-addr").textContent.trim(), e.target));

/* ---------------- init ---------------- */

loadState();
fillCampaignForm();
$("r-csv").value = S.csv || "";
renderStatus();
renderLock();
rebuildMemory();
if (MEM.deduped.recipients.length > 0) renderRecipients();
if (S.campaignJson) {
  $("c-json").textContent = JSON.stringify(JSON.parse(S.campaignJson), null, 2);
  $("c-id").textContent = campaignId(S.campaignJson);
  $("c-fp").textContent = fingerprint(campaignId(S.campaignJson));
  show($("c-out"), true);
}
if (S.locked && S.treeMeta) {
  $("m-root").textContent = S.treeMeta.rootHex;
  $("m-depth").textContent = S.treeMeta.depth;
  $("m-leaves").textContent = S.treeMeta.leafCount;
  $("m-total").textContent = grainsToPrl(BigInt(S.treeMeta.totalGrains));
  show($("m-out"), true);
}
if (S.sealJson) {
  $("s-doc").textContent = JSON.stringify(JSON.parse(S.sealJson), null, 2);
  $("s-sealid").textContent = S.sealId || "";
  $("s-envelope").textContent = JSON.stringify(dropEnvelopeBody(S.sealJson), null, 2);
  show($("s-out"), true);
}

/* Exported for tests / debugging — set at the END (esbuild IIFE has no
 * globalName; the var wrapper would otherwise clobber this assignment). */
window.PearlDrop = {
  state: () => S,
  rebuildMemory,
  sampleCsv,
};
