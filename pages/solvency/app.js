/* Pearl Solvency — proof-of-reserves desk. All crypto runs locally; the page only
 * reads the chain (GET) during verification. Keys are wiped the moment signing
 * finishes and are never stored. */
(() => {
  "use strict";
  const E = window.PearlSolvency;
  if (!E) {
    document.body.innerHTML = "<p style='padding:2rem'>Pearl Solvency failed to load (pearl-solvency.bundle.js missing). Check the console.</p>";
    return;
  }
  const $ = (id) => document.getElementById(id);
  const DONATE = "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d";

  /* storage that survives hostile localStorage (Gallery lesson) */
  const store = {
    m: {},
    get(k) { try { return localStorage.getItem(k); } catch { return this.m[k] ?? null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { this.m[k] = v; } },
    del(k) { try { localStorage.removeItem(k); } catch { delete this.m[k]; } },
  };

  const S = {
    network: E.NETWORKS.mainnet,
    blockbook: store.get("solvency.blockbook") || E.NETWORKS.mainnet.blockbook,
    custodian: "", dateISO: "", nonce: "", liabilitiesGrains: 0n,
    addresses: [],
    proofs: [],       // [{address, sig}]
    bundle: null,      // {bundle, fingerprint, json}
    unsignedJson: "",
  };

  function err(id, msg) {
    const el = $(id);
    if (msg == null) { el.hidden = true; el.textContent = ""; }
    else { el.hidden = false; el.textContent = msg; }
  }
  function ok(id, msg) {
    const el = $(id);
    if (msg == null) { el.hidden = true; el.textContent = ""; }
    else { el.hidden = false; el.textContent = msg; }
  }
  function goto(step) {
    for (const b of document.querySelectorAll("#steps button")) {
      b.classList.toggle("active", b.dataset.step === step);
    }
    for (const s of document.querySelectorAll("main > section.panel")) {
      s.classList.toggle("active", s.id === "step-" + step);
    }
    window.scrollTo(0, 0);
  }
  function markDone(step) {
    const b = document.querySelector(`#steps button[data-step="${step}"]`);
    if (b) b.classList.add("done");
  }
  for (const b of document.querySelectorAll("#steps button")) {
    b.addEventListener("click", () => goto(b.dataset.step));
  }
  async function copyText(text, btn, label) {
    try { await navigator.clipboard.writeText(text); if (btn) btn.textContent = "Copied"; }
    catch { if (btn) btn.textContent = "Copy failed"; }
    if (btn && label) setTimeout(() => { btn.textContent = label; }, 1500);
  }
  for (const b of document.querySelectorAll(".copy-btn")) {
    b.addEventListener("click", () => {
      const t = $(b.dataset.for);
      copyText(t.value || t.textContent, b, "Copy");
    });
  }

  /* ---------- init ---------- */
  $("blockbook").value = S.blockbook;
  $("chall-date").value = new Date().toISOString().slice(0, 10);

  $("network").addEventListener("change", () => {
    S.network = E.NETWORKS[$("network").value];
    if (!$("blockbook").value || $("blockbook").value !== store.get("solvency.blockbook")) {
      // keep a custom URL if the user typed one; otherwise follow the network default
    }
    $("blockbook").placeholder = S.network.blockbook || "no public testnet blockbook known — enter one";
    // changing network invalidates everything downstream
    S.addresses = []; S.proofs = []; S.bundle = null;
    $("addr-results").innerHTML = ""; $("prove-list").innerHTML = "";
    $("addr-next").disabled = true; $("prove-next").disabled = true;
  });
  $("blockbook").placeholder = S.network.blockbook;

  $("nonce-gen").addEventListener("click", () => {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    $("chall-nonce").value = E.bytesToHex(b);
  });

  /* ---------- step 1: custodian ---------- */
  $("custodian-next").addEventListener("click", () => {
    err("custodian-err", null);
    try {
      S.custodian = E.validateCustodian($("custodian").value);
      S.dateISO = E.validateDateISO($("chall-date").value);
      S.nonce = E.validateNonce($("chall-nonce").value);
      S.liabilitiesGrains = E.parsePRLtoGrains($("liabilities").value);
      const bb = $("blockbook").value.trim();
      if (!bb) throw new Error("Blockbook API URL is required for verification (read-only).");
      S.blockbook = bb.replace(/\/$/, "");
      store.set("solvency.blockbook", S.blockbook);
      markDone("custodian");
      goto("addresses");
    } catch (e) { err("custodian-err", e.message); }
  });

  /* ---------- step 2: addresses ---------- */
  $("addr-validate").addEventListener("click", () => {
    err("addr-err", null);
    $("addr-results").innerHTML = "";
    try {
      const { addresses, errors } = E.parseAddressList($("addr-list").value, S.network);
      if (addresses.length === 0) throw new Error("no valid addresses — fix the list and try again.");
      S.addresses = addresses;
      S.proofs = []; // new list invalidates old proofs
      for (const a of addresses) {
        const li = document.createElement("li");
        li.textContent = a;
        $("addr-results").appendChild(li);
      }
      for (const e of errors) {
        const li = document.createElement("li");
        li.className = "bad";
        li.textContent = "⚠ " + e;
        $("addr-results").appendChild(li);
      }
      $("addr-count").textContent = `${addresses.length} valid address${addresses.length === 1 ? "" : "es"}`;
      $("addr-next").disabled = false;
      renderProveRows();
      markDone("addresses");
    } catch (e) { err("addr-err", e.message); }
  });
  $("addr-next").addEventListener("click", () => goto("prove"));

  /* ---------- step 3: prove ---------- */
  function renderProveRows() {
    const wrap = $("prove-list");
    wrap.innerHTML = "";
    S.addresses.forEach((addr, i) => {
      const div = document.createElement("div");
      div.className = "prove-row";
      div.id = "prove-row-" + i;
      div.innerHTML =
        `<div class="paddr">${addr}</div>` +
        `<input id="prove-key-${i}" type="password" autocomplete="off" spellcheck="false" ` +
        `placeholder="private key: WIF, 64-hex, or 12/24-word mnemonic">` +
        `<div class="pstatus" id="prove-status-${i}"></div>` +
        `<div class="sig" id="prove-sig-${i}"></div>`;
      wrap.appendChild(div);
    });
    $("prove-next").disabled = true;
    $("prove-count").textContent = "";
  }

  /** Sign one row. Returns the proof or throws. Wipes the key input either way. */
  function signRow(i) {
    const addr = S.addresses[i];
    const input = $("prove-key-" + i);
    const raw = input.value;
    input.value = ""; // wipe immediately, before any parsing
    if (!raw.trim()) throw new Error("no key entered");
    const key = E.custodianKeyFromInput(raw, S.network);
    // scrub the raw string reference
    E.assertKeyMatchesAddress(key, addr);
    const ch = E.challengeString({ hrp: S.network.hrp, custodian: S.custodian, dateISO: S.dateISO, nonce: S.nonce, address: addr });
    const sig = E.signChallenge(key.tweakedPriv, ch);
    // scrub key material
    key.priv.fill(0); key.tweakedPriv.fill(0);
    return { address: addr, sig, source: key.source };
  }

  function setRowStatus(i, cls, msg, sig) {
    const st = $("prove-status-" + i);
    st.className = "pstatus " + cls;
    st.textContent = msg;
    if (sig) $("prove-sig-" + i).textContent = "sig: " + sig.slice(0, 32) + "…" + sig.slice(-8);
    $("prove-row-" + i).classList.toggle("signed", cls === "ok");
  }

  function refreshProveState() {
    const n = S.proofs.length;
    $("prove-count").textContent = n === 0 ? "" : `${n} of ${S.addresses.length} signed`;
    $("prove-next").disabled = n !== S.addresses.length;
    if (n === S.addresses.length && n > 0) markDone("prove");
  }

  $("prove-sign-all").addEventListener("click", () => {
    err("prove-err", null);
    S.proofs = [];
    S.addresses.forEach((addr, i) => {
      const already = S.proofs.find((p) => p.address === addr);
      if (already) { setRowStatus(i, "ok", "Signed ✓ (" + already.source + ")", already.sig); return; }
      try {
        const p = signRow(i);
        S.proofs.push({ address: p.address, sig: p.sig });
        setRowStatus(i, "ok", "Signed ✓ (" + p.source + ")", p.sig);
      } catch (e) {
        setRowStatus(i, "bad", "✗ " + e.message);
      }
    });
    refreshProveState();
    if (S.proofs.length !== S.addresses.length) {
      err("prove-err", `${S.addresses.length - S.proofs.length} address(es) still unsigned — check each row.`);
    }
  });
  $("prove-next").addEventListener("click", () => { buildBundle(); goto("bundle"); });

  /* air-gap */
  $("unsigned-export").addEventListener("click", () => {
    err("prove-err", null);
    try {
      const { json } = E.exportUnsignedBundle({
        network: S.network, custodian: S.custodian, dateISO: S.dateISO, nonce: S.nonce,
        addresses: S.addresses,
      });
      S.unsignedJson = json;
      $("unsigned-text").value = json;
    } catch (e) { err("prove-err", e.message); }
  });
  $("unsigned-copy").addEventListener("click", (ev) => copyText($("unsigned-text").value, ev.target, "Copy"));

  $("signed-import-btn").addEventListener("click", () => {
    err("prove-err", null); ok("signed-import-out", null);
    try {
      if (!S.unsignedJson) throw new Error("export the unsigned bundle first.");
      const proofs = E.importSignedChallenges(S.unsignedJson, $("signed-import").value);
      // verify each imported signature against its challenge before accepting
      const u = JSON.parse(S.unsignedJson);
      const chByAddr = new Map(u.items.map((it) => [it.address, it.challenge]));
      S.proofs = [];
      proofs.forEach((p) => {
        const prog = E.addressToProgram(p.address, S.network);
        const okSig = E.verifyChallengeSig(p.sig, chByAddr.get(p.address), prog);
        const i = S.addresses.indexOf(p.address);
        if (!okSig) {
          setRowStatus(i, "bad", "✗ imported signature does NOT verify — rejected");
          return;
        }
        S.proofs.push(p);
        if (i >= 0) setRowStatus(i, "ok", "Signed ✓ (air-gapped import)", p.sig);
      });
      $("signed-import").value = ""; // wipe pasted signatures from the form
      const bad = S.addresses.length - S.proofs.length;
      if (bad > 0) throw new Error(`${bad} signature(s) missing or invalid — see rows above.`);
      ok("signed-import-out", `All ${S.proofs.length} imported signatures verify.`);
      refreshProveState();
    } catch (e) { err("prove-err", e.message); }
  });

  /* ---------- step 4: bundle ---------- */
  function buildBundle() {
    const { bundle, fingerprint, json } = E.makeSolvencyBundle({
      network: S.network, custodian: S.custodian, liabilitiesGrains: S.liabilitiesGrains,
      dateISO: S.dateISO, nonce: S.nonce, proofs: S.proofs,
    });
    S.bundle = { bundle, fingerprint, json };
    $("bundle-fp").textContent = fingerprint;
    $("bundle-naddr").textContent = S.proofs.length;
    $("bundle-liab").textContent = E.fmtPRL(S.liabilitiesGrains) + " PRL";
    $("bundle-text").value = json;
    markDone("bundle");
  }
  $("bundle-copy").addEventListener("click", (ev) => copyText($("bundle-text").value, ev.target, "Copy bundle JSON"));
  $("bundle-fp-copy").addEventListener("click", (ev) => copyText($("bundle-fp").textContent, ev.target, "Copy"));
  $("bundle-download").addEventListener("click", () => {
    const blob = new Blob([$("bundle-text").value], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `pearl-solvency-${S.bundle.fingerprint}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });
  $("bundle-next").addEventListener("click", () => goto("verify"));

  /* ---------- step 5: verify ---------- */
  $("verify-load-mine").addEventListener("click", () => {
    if (!S.bundle) { err("verify-err", "No bundle built yet in this session — paste one instead."); return; }
    err("verify-err", null);
    $("verify-input").value = S.bundle.json;
  });

  $("verify-run").addEventListener("click", async () => {
    err("verify-err", null);
    $("verdict").hidden = true;
    $("verify-detail").hidden = true;
    const btn = $("verify-run");
    btn.disabled = true;
    try {
      const parsed = E.parseSolvencyBundle($("verify-input").value);
      // 1. fingerprint already checked by parse; 2. signatures
      const sigChecks = E.verifyBundleSignatures(parsed);
      const badSig = sigChecks.find((s) => !s.ok);
      if (badSig) throw new Error(`INVALID: signature for ${badSig.address.slice(0, 20)}… does not verify. The bundle is not authentic.`);
      // 3. chain reads (GET-only)
      const bb = ($("blockbook").value.trim().replace(/\/$/, "")) || S.blockbook;
      const rows = [];
      let total = 0n, totalUnconf = 0n, totalChecked = 0;
      const foreignAll = [];
      for (let i = 0; i < parsed.proofs.length; i++) {
        const p = parsed.proofs[i];
        btn.textContent = `Reading chain… ${i + 1}/${parsed.proofs.length}`;
        const r = await E.sumAddressReserves(bb, p.address, parsed.network);
        total += r.confirmedGrains;
        totalUnconf += r.unconfirmedGrains;
        totalChecked += r.checked;
        for (const f of r.foreign) foreignAll.push({ ...f, address: p.address });
        rows.push({ address: p.address, ...r });
      }
      // 4. verdict
      const v = E.reserveVerdict(total, parsed.liabilitiesGrains);
      renderVerdict(parsed, v, total, totalUnconf, totalChecked);
      renderReserves(rows, foreignAll);
      markDone("verify");
    } catch (e) {
      err("verify-err", e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "Verify proof of reserves";
    }
  });

  function renderVerdict(parsed, v, total, totalUnconf, totalChecked) {
    const el = $("verdict");
    el.hidden = false;
    el.className = "verdict " + (v.verdict === "PROVEN" ? "proven" : v.verdict === "SHORTFALL" ? "shortfall" : "invalid");
    const stamp = v.verdict === "PROVEN" ? "✓ Reserves proven" : v.verdict === "SHORTFALL" ? "✗ Under-collateralized" : "∅ No reserves";
    el.innerHTML =
      `<p class="stamp">${stamp}</p>` +
      `<p class="big">${E.fmtPRL(total)} PRL confirmed across ${parsed.proofs.length} address(es)</p>` +
      `<p class="sub">Declared liabilities: <strong>${E.fmtPRL(parsed.liabilitiesGrains)} PRL</strong> · ` +
      `Reserve ratio: <strong>${E.fmtRatioBp(v.ratioBp)}</strong>` +
      (v.verdict === "SHORTFALL" ? ` · Shortfall: <strong>${E.fmtPRL(v.shortfallGrains)} PRL</strong>` : "") +
      `</p><p class="sub">Custodian: ${escapeHtml(parsed.custodian)} · Challenge date: ${parsed.dateISO} · ` +
      `Fingerprint <code>${parsed.fingerprint}</code> · ${totalChecked} funding script(s) byte-verified` +
      (totalUnconf > 0n ? ` · ${E.fmtPRL(totalUnconf)} PRL unconfirmed (not counted)` : "") +
      `</p><p class="sub hint">Snapshot only — balances move. This proves assets, not liabilities.</p>`;
  }

  function renderReserves(rows, foreignAll) {
    $("verify-detail").hidden = false;
    const tb = $("reserves-body");
    tb.innerHTML = "";
    for (const r of rows) {
      const tr = document.createElement("tr");
      tr.innerHTML =
        `<td class="addr">${r.address}</td>` +
        `<td class="num">${E.fmtPRL(r.confirmedGrains)}</td>` +
        `<td class="num">${E.fmtPRL(r.unconfirmedGrains)}</td>` +
        `<td class="num">${r.checked}</td>`;
      tb.appendChild(tr);
    }
    const fw = $("foreign-warn");
    if (foreignAll.length > 0) {
      fw.hidden = false;
      fw.textContent = `⚠ ${foreignAll.length} UTXO(s) claimed by Blockbook did not byte-match the address script and were EXCLUDED from reserves:\n` +
        foreignAll.map((f) => `  ${f.txid}:${f.vout} (${E.fmtPRL(BigInt(f.valueGrains))} PRL) at ${f.address.slice(0, 20)}…`).join("\n");
    } else { fw.hidden = true; fw.textContent = ""; }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
})();
