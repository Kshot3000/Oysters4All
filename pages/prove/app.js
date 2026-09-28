/* Pearl Prove — UI wiring. prove-core.js does all the math; this file only
   talks to the DOM and to blockbook. */
"use strict";

const P = window.PearlProve;
const $ = (id) => document.getElementById(id);

/* ---------------- tabs ---------------- */
document.querySelectorAll(".tab").forEach((t) => {
  t.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((x) => {
      x.classList.toggle("active", x === t);
      x.setAttribute("aria-selected", x === t ? "true" : "false");
    });
    document.querySelectorAll("[data-panel]").forEach((p) => {
      p.hidden = p.dataset.panel !== t.dataset.tab;
    });
  });
});

/* ---------------- inclusion: mode switch ---------------- */
document.querySelectorAll(".btn.mode").forEach((b) => {
  b.addEventListener("click", () => {
    document.querySelectorAll(".btn.mode").forEach((x) => x.classList.toggle("active", x === b));
    $("modeFetch").hidden = b.dataset.mode !== "fetch";
    $("modePaste").hidden = b.dataset.mode !== "paste";
  });
});

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function renderWalk(container, txid, proof, root) {
  container.innerHTML = "";
  let cur = txid.toLowerCase();
  const row0 = el("div", "step",
    `<span class="lvl">leaf</span> · txid<br><span class="h">${esc(cur)}</span>`);
  container.appendChild(row0);
  proof.forEach((s, i) => {
    const dir = s.position === "left" ? "dir-l" : "dir-r";
    const label = s.position === "left" ? "sibling LEFT" : "sibling RIGHT";
    container.appendChild(el("div", "step",
      `<span class="lvl">level ${i + 1}</span> · <span class="${dir}">${label}</span><br>` +
      `<span class="h">${esc(s.sibling)}</span><br>` +
      `<span class="muted">→ parent = dsha(${s.position === "left" ? "sibling ‖ running" : "running ‖ sibling"})</span>`));
  });
  container.appendChild(el("div", "step",
    `<span class="lvl">root</span> · computed<br><span class="h">${esc(root)}</span>`));
}

function verdict(box, ok, big, detail) {
  box.hidden = false;
  box.className = "verdict " + (ok ? "ok" : "bad");
  box.innerHTML = `<span class="big">${ok ? "✓ VERIFIED" : "✗ NOT PROVEN"} — ${esc(big)}</span>${detail || ""}`;
}

/* ---------------- inclusion: fetch mode ---------------- */

async function bbGet(base, path) {
  const r = await fetch(base.replace(/\/+$/, "") + path);
  if (!r.ok) throw new Error(`blockbook ${r.status} on ${path}`);
  return r.json();
}

async function fetchBlockTxids(base, blk) {
  // blk: {height} or {hash}
  const hash = blk.hash || (await bbGet(base, `/block-index/${blk.height}`)).blockHash;
  if (!hash) throw new Error("block not found at that height");
  const first = await bbGet(base, `/block/${hash}`);
  const totalPages = first.totalPages || 1;
  const txCount = first.txCount || 0;
  if (txCount > 5000) {
    throw new Error(`block has ${txCount.toLocaleString()} transactions — too many to fetch in a browser. Paste a proof instead.`);
  }
  let txs = (first.txs || []).map((t) => t.txid);
  for (let p = 2; p <= totalPages; p++) {
    const pg = await bbGet(base, `/block/${hash}?page=${p}`);
    txs = txs.concat((pg.txs || []).map((t) => t.txid));
  }
  return { hash, height: first.height, merkleRoot: first.merkleRoot, txs, txCount };
}

$("btnProve").addEventListener("click", async () => {
  const box = $("proveVerdict"), walk = $("proofWalk");
  box.hidden = true;
  try {
    const base = $("bbBase").value.trim() || "https://blockbook.pearlresearch.ai/api/v2";
    const height = $("blkHeight").value.trim();
    const hash = $("blkHash").value.trim();
    const txid = $("proveTxid").value.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/i.test(txid)) throw new Error("enter a 64-hex transaction ID");
    if (!height && !/^[0-9a-f]{64}$/i.test(hash)) throw new Error("enter a block height or a 64-hex block hash");
    walk.innerHTML = `<p class="muted"><span class="spin">◌</span> fetching block…</p>`;
    const blk = await fetchBlockTxids(base, height ? { height } : { hash: hash.toLowerCase() });
    const idx = blk.txs.findIndex((t) => t.toLowerCase() === txid);
    if (idx < 0) {
      walk.innerHTML = `<p class="muted">Block ${blk.height} fetched (${blk.txCount} txs). The txid is <strong>not in this block</strong>.</p>`;
      verdict(box, false, "transaction not in block",
        `<span class="muted">Fetched ${blk.txCount} txids from block ${esc(String(blk.height))}; ${esc(txid.slice(0, 16))}… is not among them.</span>`);
      return;
    }
    const proof = P.merkleProof(blk.txs, idx);
    const computed = P.merkleRoot(blk.txs);
    renderWalk(walk, txid, proof, computed);
    const headerOk = computed.toLowerCase() === String(blk.merkleRoot).toLowerCase();
    const ok = headerOk && P.verifyProof(txid, proof, blk.merkleRoot);
    verdict(box, ok,
      ok ? `tx is in Pearl block ${blk.height}` : "root mismatch with block header",
      `<span class="muted">Block ${esc(String(blk.height))} · ${blk.txCount} txs · leaf index ${idx} · ` +
      `proof depth ${proof.length} · header merkleRoot ${esc(String(blk.merkleRoot).slice(0, 24))}… ` +
      `${headerOk ? "matches recomputed root" : "<strong>does NOT match</strong>"}.</span>`);
  } catch (e) {
    walk.innerHTML = `<p class="err">Error: ${esc(e.message)}</p>`;
    box.hidden = true;
  }
});

$("btnTryDemo").addEventListener("click", () => {
  $("blkHeight").value = "120195";
  $("blkHash").value = "";
  // coinbase txid of block 120195 (from the shipped fixture — a real chain value)
  fetch("tests/fixture-120195.json").then((r) => r.json()).then((f) => {
    $("proveTxid").value = f.txids[17];
    $("btnProve").click();
  }).catch(() => {
    $("proofWalk").innerHTML = `<p class="err">Could not load the demo fixture.</p>`;
  });
});

/* ---------------- inclusion: paste mode ---------------- */

function fillFixtureProof() {
  fetch("tests/fixture-120195.json").then((r) => r.json()).then((f) => {
    const idx = 17;
    const proof = P.merkleProof(f.txids, idx);
    $("ppTxid").value = f.txids[idx];
    $("ppRoot").value = f.merkleRoot;
    $("ppPath").value = proof.map((s) => `${s.position === "left" ? "L" : "R"} ${s.sibling}`).join("\n");
  });
}
$("btnLoadFixture").addEventListener("click", fillFixtureProof);

$("btnVerifyPaste").addEventListener("click", () => {
  const box = $("pasteVerdict"), walk = $("pasteWalk");
  box.hidden = true;
  try {
    const txid = $("ppTxid").value.trim();
    const root = $("ppRoot").value.trim();
    const proof = P.parseProofLines($("ppPath").value);
    renderWalk(walk, txid, proof, "(computed below)");
    const ok = P.verifyProof(txid, proof, root);
    // re-render walk with the actual computed root for honesty
    let cur = P.txidToInternal(txid);
    for (const s of proof) {
      const sib = P.txidToInternal(s.sibling);
      const cat = new Uint8Array(64);
      if (s.position === "left") { cat.set(sib, 0); cat.set(cur, 32); }
      else { cat.set(cur, 0); cat.set(sib, 32); }
      cur = P.dsha(cat);
    }
    const computed = P.internalToTxid(cur);
    renderWalk(walk, txid, proof, computed);
    verdict(box, ok,
      ok ? "proof checks out against the header root" : "proof does NOT reproduce the header root",
      `<span class="muted">Computed root <code>${esc(computed.slice(0, 32))}…</code> vs expected <code>${esc(root.toLowerCase().slice(0, 32))}…</code> · ${proof.length} steps.</span>`);
  } catch (e) {
    walk.innerHTML = `<p class="err">Error: ${esc(e.message)}</p>`;
    box.hidden = true;
  }
});

/* ---------------- root builder ---------------- */

$("btnBuildRoot").addEventListener("click", () => {
  const out = $("rootOut");
  out.hidden = true;
  try {
    const txids = P.parseTxidList($("rbTxids").value);
    if (txids.length > 200000) throw new Error("that many txids will hang the tab — keep it under 200k");
    const t0 = performance.now();
    const root = P.merkleRoot(txids);
    const ms = Math.round(performance.now() - t0);
    let html = `<div class="k">transactions</div><div class="v">${txids.length.toLocaleString()} (${ms} ms)</div>`;
    html += `<div class="k">merkle root</div>`;
    html += `<div class="bigroot">${esc(root)}</div>`;
    const want = $("rbProveTx").value.trim().toLowerCase();
    if (want) {
      const idx = txids.findIndex((t) => t.toLowerCase() === want);
      if (idx < 0) throw new Error("that txid is not in the list");
      const proof = P.merkleProof(txids, idx);
      html += `<div class="k">proof for leaf ${idx}</div><div class="v">${proof.length} steps — copy it into the Inclusion tab's "Verify a pasted proof" mode:</div>`;
      html += `<div class="proofdump">${esc(proof.map((s) => `${s.position === "left" ? "L" : "R"} ${s.sibling}`).join("\n"))}</div>`;
    }
    out.innerHTML = `<div class="kv">${html}</div>`;
    out.hidden = false;
  } catch (e) {
    out.innerHTML = `<p class="err">Error: ${esc(e.message)}</p>`;
    out.hidden = false;
  }
});

/* ---------------- header inspector ---------------- */

$("btnDecode").addEventListener("click", () => {
  const out = $("headerOut");
  out.hidden = true;
  try {
    const h = P.decodeHeader($("hdrHex").value.trim());
    const rows = [
      ["version", "0x" + h.version.toString(16).padStart(8, "0") + ` (${h.version})`],
      ["previous block", h.prevHash],
      ["merkle root", h.merkleRoot],
      ["time", `${h.time} → ${h.timeISO}`],
      ["bits", "0x" + h.bits],
      ["nonce", String(h.nonce)],
      ["block id (dsha)", h.hash],
      ["target", "0x" + h.targetHex],
    ];
    out.innerHTML =
      `<div class="fieldgrid">` +
      rows.map(([k, v]) => `<div class="k">${esc(k)}</div><div class="v">${esc(v)}</div>`).join("") +
      `</div>` +
      `<div class="workline ${h.meetsTarget ? "pass" : "fail"}">` +
      (h.meetsTarget
        ? "✓ VALID WORK — the header hash is at or below the nBits target."
        : "✗ INSUFFICIENT WORK — the header hash is above the nBits target. " +
          "This header would be rejected by consensus (or you pasted a non-header).") +
      `</div>`;
    out.hidden = false;
  } catch (e) {
    out.innerHTML = `<p class="err">Error: ${esc(e.message)}</p>`;
    out.hidden = false;
  }
});

/* ---------------- footer: click-to-copy donation ---------------- */
$("donateAddr").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("donateAddr").textContent.trim());
    $("copiedMsg").hidden = false;
    setTimeout(() => { $("copiedMsg").hidden = true; }, 1600);
  } catch { /* clipboard unavailable — address is selectable */ }
});
