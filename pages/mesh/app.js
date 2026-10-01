/* Pearl Mesh app — MuSig2 collaborative keypath desk UI.
 * Drives window.PearlMesh (committed esbuild bundle of mesh-core + the audited
 * Sign primitives). Fully offline except the optional GET-only Blockbook
 * balance lookup. No storage: mnemonics and secrets live in memory only.
 */
(function () {
  "use strict";
  const M = window.PearlMesh;
  if (!M) throw new Error("Pearl Mesh bundle failed to load");

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function showErr(id, msg) { const e = $(id); e.textContent = msg; e.hidden = false; }
  function hideErr(id) { $(id).hidden = true; }
  function trunc(h, n) { n = n || 16; return h.length > 2 * n ? h.slice(0, n) + "…" + h.slice(-n) : h; }

  /* ---------- step nav ---------- */
  const panels = { setup: "step-setup", aggregate: "step-aggregate", fund: "step-fund", sign: "step-sign", verify: "step-verify" };
  function goStep(name) {
    document.querySelectorAll("#steps button").forEach((b) => {
      b.classList.toggle("active", b.dataset.step === name);
    });
    Object.keys(panels).forEach((k) => { $(panels[k]).classList.toggle("active", k === name); });
    if (name === "aggregate") renderAggregate();
    if (name === "fund") renderFund();
    if (name === "sign") renderSign();
    window.scrollTo(0, 0);
  }
  document.querySelectorAll("#steps button").forEach((b) => {
    b.addEventListener("click", () => goStep(b.dataset.step));
  });

  /* ---------- QR + copy ---------- */
  function renderQR(el, text) {
    el.innerHTML = "";
    try {
      if (typeof window.qrcode === "undefined") throw new Error("qr lib missing");
      const qr = window.qrcode(0, "M");
      qr.addData(text);
      qr.make();
      el.innerHTML = qr.createImgTag(4, 8);
    } catch (e) {
      el.textContent = "QR unavailable: " + e.message;
    }
  }
  function wireCopyButtons(scope) {
    scope.querySelectorAll(".copy-btn").forEach((b) => {
      if (b._wired) return;
      b._wired = true;
      b.addEventListener("click", async () => {
        const src = document.getElementById(b.dataset.for);
        const txt = src ? (src.value !== undefined && src.value !== "" ? src.value : src.textContent) : "";
        const old = b.textContent;
        try { await navigator.clipboard.writeText(txt); b.textContent = "Copied"; }
        catch { b.textContent = "Copy failed"; }
        b.addEventListener("blur", () => { b.textContent = old; }, { once: true });
      });
    });
  }
  wireCopyButtons(document);

  /* ---------- state (memory only) ---------- */
  const S = {
    members: [],       // {name, pubkey, local: {priv: Uint8Array, d: bigint, path} | null}
    descriptor: null,  // mesh descriptor object
    ceremony: null,    // {msg, salt, commits: {pubkey: {bundle, nonce}}, aggBundle, partials: {pubkey: {partial, nonceBundle}}}
    mnemonic: "",
  };
  const networkId = () => $("s-network").value;

  /* ---------- setup ---------- */
  function refreshMemberList() {
    const list = $("s-list");
    $("s-count").textContent = `(${S.members.length} of 2–7)`;
    if (!S.members.length) {
      list.innerHTML = '<p class="empty">No members yet — add at least two above.</p>';
      return;
    }
    list.innerHTML = "";
    S.members.forEach((m, i) => {
      const row = document.createElement("div");
      row.className = "member-row";
      row.innerHTML =
        `<span class="mname">${esc(m.name)}</span>` +
        `<span class="mpub">${esc(m.pubkey)}</span>` +
        (m.local
          ? `<span class="badge-local" title="Key derived on this device — can commit & sign here">local key</span>`
          : `<span class="badge-remote" title="Pasted key — signs on its own device">remote</span>`) +
        `<button class="ghost" data-i="${i}">Remove</button>`;
      row.querySelector("button").addEventListener("click", (e) => {
        S.members.splice(Number(e.target.dataset.i), 1);
        S.descriptor = null;
        refreshMemberList();
      });
      list.appendChild(row);
    });
  }

  $("s-add").addEventListener("click", () => {
    hideErr("s-err");
    try {
      const name = $("s-name").value.trim() || `Member ${S.members.length + 1}`;
      const pubkey = $("s-pubkey").value.trim().toLowerCase();
      M.parseXOnlyKey(pubkey); // validates curve membership
      if (S.members.some((m) => m.pubkey === pubkey)) throw new Error("duplicate member key");
      if (S.members.length >= 7) throw new Error("a mesh holds at most 7 members");
      S.members.push({ name, pubkey, local: null });
      $("s-name").value = ""; $("s-pubkey").value = "";
      S.descriptor = null;
      refreshMemberList();
    } catch (e) { showErr("s-err", e.message); }
  });

  $("s-gen-mnemonic").addEventListener("click", () => {
    S.mnemonic = M.newMnemonic();
    $("s-mnemonic").value = S.mnemonic;
  });
  $("s-wipe-mnemonic").addEventListener("click", () => {
    S.mnemonic = "";
    $("s-mnemonic").value = "";
  });
  $("s-derive").addEventListener("click", () => {
    hideErr("s-err");
    try {
      const mnemonic = $("s-mnemonic").value.trim() || S.mnemonic;
      if (!mnemonic) throw new Error("generate or paste a mnemonic first");
      const idx = Math.max(0, Number($("s-index").value) || 0);
      const name = $("s-name").value.trim() || `Member ${S.members.length + 1}`;
      const keys = M.deriveBip86Keys(mnemonic, idx, 1);
      const { d, pub } = M.memberFromPriv(keys[0].priv);
      const pubkey = M.bytesToHex(pub);
      if (S.members.some((m) => m.pubkey === pubkey)) throw new Error("that derived key is already a member");
      if (S.members.length >= 7) throw new Error("a mesh holds at most 7 members");
      S.mnemonic = mnemonic;
      S.members.push({ name, pubkey, local: { priv: keys[0].priv, d, path: keys[0].path } });
      S.descriptor = null;
      refreshMemberList();
    } catch (e) { showErr("s-err", e.message); }
  });

  function ensureDescriptor() {
    if (S.descriptor) return S.descriptor;
    S.descriptor = M.buildMeshDescriptor(networkId(), S.members.map((m) => ({ name: m.name, pubkey: m.pubkey })));
    return S.descriptor;
  }

  $("s-continue").addEventListener("click", () => {
    hideErr("s-err");
    try {
      if (S.members.length < 2) throw new Error("add at least 2 members to weave a mesh");
      S.descriptor = null;
      ensureDescriptor();
      goStep("aggregate");
    } catch (e) { showErr("s-err", e.message); }
  });
  refreshMemberList();

  /* ---------- aggregate ---------- */
  function renderAggregate() {
    hideErr("a-err");
    try {
      const d = ensureDescriptor();
      $("a-address").textContent = d.address;
      $("a-sealed").textContent = d.sealed;
      $("a-L").textContent = d.L;
      $("a-agg").textContent = d.agg;
      $("a-tweak").textContent = d.tweak;
      $("a-parity").textContent = `gacc=${d.gacc} · pacc=${d.pacc}`;
      $("a-descriptor").textContent = d.descriptor;
      const box = $("a-members");
      box.innerHTML = "";
      d.members.forEach((m, i) => {
        const row = document.createElement("div");
        row.className = "member-row";
        row.innerHTML =
          `<span class="mname">${esc(m.name)}</span>` +
          `<span class="mpub">${esc(m.pubkey)}</span>` +
          `<span class="coef">aᵢ=${esc(trunc(d.coefficients[i], 10))}</span>`;
        box.appendChild(row);
      });
      $("a-check-input").value = d.descriptor;
      $("a-check-result").hidden = true;
    } catch (e) { showErr("a-err", e.message); }
  }

  function verdictBox(el, verdict, checks, headline) {
    el.classList.toggle("proven", verdict === "PROVEN");
    el.classList.toggle("notproven", verdict !== "PROVEN");
    el.innerHTML = `<h4>${verdict === "PROVEN" ? "✓ PROVEN" : "✗ NOT PROVEN"}</h4>` +
      (headline ? `<p class="lede">${esc(headline)}</p>` : "") +
      "<ul>" + checks.map((c) =>
        `<li class="${c.ok ? "ok" : "bad"}"><strong>${esc(c.label)}</strong> — ${esc(c.detail)}</li>`
      ).join("") + "</ul>";
    el.hidden = false;
  }

  $("a-check").addEventListener("click", () => {
    hideErr("a-err");
    try {
      const d = ensureDescriptor();
      const v = M.verifyMeshDescriptor($("a-check-input").value, d.address, d.sealed);
      verdictBox($("a-check-result"), v.verdict, v.checks,
        v.verdict === "PROVEN"
          ? "The pasted descriptor re-derives this exact address and sealed commitment."
          : "The pasted descriptor does NOT reproduce this mesh — do not fund or sign with it.");
    } catch (e) { showErr("a-err", e.message); }
  });
  $("a-back").addEventListener("click", () => goStep("setup"));
  $("a-continue").addEventListener("click", () => goStep("fund"));

  /* ---------- fund ---------- */
  function renderFund() {
    hideErr("f-err");
    try {
      const d = ensureDescriptor();
      $("f-address").textContent = d.address;
      renderQR($("f-qr"), d.address);
      $("f-balance").hidden = true;
      $("f-tally-result").hidden = true;
    } catch (e) { showErr("f-err", e.message); }
  }
  function fmtPRL(grains) { return (Number(grains) / 1e8).toFixed(8) + " PRL"; }

  $("f-check").addEventListener("click", async () => {
    hideErr("f-err");
    const box = $("f-balance");
    try {
      const d = ensureDescriptor();
      const base = $("f-blockbook").value.trim().replace(/\/+$/, "");
      const [aRes, uRes] = await Promise.all([
        fetch(`${base}/api/v2/address/${d.address}`),
        fetch(`${base}/api/v2/utxo/${d.address}`),
      ]);
      if (!aRes.ok) throw new Error(`blockbook /address: HTTP ${aRes.status}`);
      if (!uRes.ok) throw new Error(`blockbook /utxo: HTTP ${uRes.status}`);
      const a = await aRes.json(), u = await uRes.json();
      box.innerHTML =
        `<div><span>Balance</span><code class="good">${esc(fmtPRL(a.balance || "0"))}</code></div>` +
        `<div><span>Transactions</span><code>${esc(String(a.txs ?? a.txApperances ?? 0))}</code></div>` +
        `<div><span>UTXOs</span><code>${esc(String(Array.isArray(u) ? u.length : 0))}</code></div>`;
      box.hidden = false;
    } catch (e) {
      showErr("f-err", "Balance lookup failed: " + e.message + " — paste UTXOs below instead.");
    }
  });

  $("f-tally").addEventListener("click", () => {
    hideErr("f-err");
    const box = $("f-tally-result");
    try {
      const d = ensureDescriptor();
      const utxos = M.parseUtxoList($("f-utxos").value, M.NETWORKS[networkId()]);
      let total = 0n;
      for (const u of utxos) total += BigInt(u.value);
      box.innerHTML =
        `<div><span>UTXOs parsed</span><code>${utxos.length}</code></div>` +
        `<div><span>Total</span><code class="good">${esc(fmtPRL(total.toString()))}</code></div>`;
      box.hidden = false;
    } catch (e) { showErr("f-err", e.message); }
  });
  $("f-back").addEventListener("click", () => goStep("aggregate"));
  $("f-continue").addEventListener("click", () => goStep("sign"));

  /* ---------- sign: guided ceremony ---------- */
  function freshCeremony() {
    S.ceremony = {
      msg: null, salt: M.newSalt(), commits: {}, aggBundle: null, partials: {},
    };
    $("g-salt").value = M.bytesToHex(S.ceremony.salt);
    $("g-aggbundle").hidden = true;
    $("g-final").hidden = true;
    $("g-sim-result").hidden = true;
  }
  freshCeremony();
  $("g-new-salt").addEventListener("click", () => {
    S.ceremony.salt = M.newSalt();
    $("g-salt").value = M.bytesToHex(S.ceremony.salt);
  });

  function ceremonyMsg() {
    return M.digestForSigning($("g-msg").value);
  }

  function localMembers() {
    return S.members.filter((m) => m.local);
  }

  function renderSign() {
    hideErr("g-err");
    try {
      ensureDescriptor();
    } catch (e) { showErr("g-err", e.message); return; }
    // round 1: local commit cards
    const lc = $("g-local-commit");
    lc.innerHTML = "";
    const locals = localMembers();
    if (!locals.length) {
      lc.innerHTML = '<p class="empty">No local keys on this device — every member commits on their own machine and you paste the bundles below.</p>';
    }
    locals.forEach((m) => {
      const card = document.createElement("div");
      card.className = "ceremony-member";
      const existing = S.ceremony.commits[m.pubkey];
      card.innerHTML =
        `<div class="chead"><strong>${esc(m.name)}</strong>` +
        `<span class="badge-local">local key</span>` +
        `<button class="ghost" data-pub="${esc(m.pubkey)}">Commit nonce</button></div>` +
        (existing ? `<pre>${esc(existing.bundle)}</pre>` : `<p class="empty">No commitment yet.</p>`);
      card.querySelector("button").addEventListener("click", (e) => {
        hideErr("g-err");
        try {
          const d = ensureDescriptor();
          const msg = ceremonyMsg();
          const nonce = M.memberNoncePair({
            sec: m.local.d,
            aggX: M.hexToBytes(d.agg),
            L: M.hexToBytes(d.L),
            msg,
            salt: S.ceremony.salt,
          });
          const bundle = M.nonceCommitBundle({
            memberName: m.name, pubkey: m.pubkey,
            R1i: nonce.R1i, R2i: nonce.R2i, msg, salt: S.ceremony.salt,
          });
          S.ceremony.commits[m.pubkey] = { bundle, nonce };
          S.ceremony.msg = msg;
          renderSign();
        } catch (err) { showErr("g-err", err.message); }
      });
      lc.appendChild(card);
    });
    // round 2: local sign cards (only after aggBundle exists)
    const ls = $("g-local-sign");
    ls.innerHTML = "";
    if (!S.ceremony.aggBundle) {
      ls.innerHTML = '<p class="empty">Aggregate the nonce bundles above first — the challenge unlocks signing.</p>';
    } else if (!locals.length) {
      ls.innerHTML = '<p class="empty">No local keys — paste the partials members send back below.</p>';
    }
    locals.forEach((m) => {
      if (!S.ceremony.aggBundle) return;
      const card = document.createElement("div");
      card.className = "ceremony-member";
      const existing = S.ceremony.partials[m.pubkey];
      card.innerHTML =
        `<div class="chead"><strong>${esc(m.name)}</strong>` +
        `<span class="badge-local">local key</span>` +
        `<button class="ghost" data-pub="${esc(m.pubkey)}">Sign locally</button></div>` +
        (existing ? `<pre>${esc(existing.partial)}</pre>` : `<p class="empty">Not signed yet.</p>`);
      card.querySelector("button").addEventListener("click", () => {
        hideErr("g-err");
        try {
          const d = ensureDescriptor();
          const commit = S.ceremony.commits[m.pubkey];
          if (!commit) throw new Error(`${m.name} has no nonce commitment in this ceremony — commit first`);
          const { bundle } = M.memberPartialSign({
            priv: m.local.priv,
            slotPubkey: m.pubkey,
            descriptor: d,
            aggBundle: S.ceremony.aggBundle,
            nonce: commit.nonce,
            memberName: m.name,
          });
          S.ceremony.partials[m.pubkey] = { partial: bundle, nonceBundle: commit.bundle };
          renderSign();
        } catch (err) { showErr("g-err", err.message); }
      });
      ls.appendChild(card);
    });
    wireCopyButtons(lc); wireCopyButtons(ls);
  }

  function splitLines(id) {
    return $(id).value.split("\n").map((l) => l.trim()).filter(Boolean);
  }

  $("g-aggregate-nonces").addEventListener("click", () => {
    hideErr("g-err");
    try {
      const d = ensureDescriptor();
      const msg = ceremonyMsg();
      const bundles = splitLines("g-bundles");
      if (!bundles.length) {
        // convenience: use the local commits already made on this device
        const local = Object.values(S.ceremony.commits).map((c) => c.bundle);
        if (!local.length) throw new Error("paste the members' nonce bundles, or commit a local nonce first");
        bundles.push(...local);
      }
      const aggBundle = M.aggregateNonces({ bundles, descriptor: d, msg });
      S.ceremony.aggBundle = aggBundle;
      S.ceremony.msg = msg;
      const box = $("g-aggbundle");
      box.innerHTML =
        `<div><span>Aggregate R</span><code>${esc(aggBundle.R)}</code></div>` +
        `<div><span>Nonce coefficient b</span><code>${esc(trunc(aggBundle.b, 12))}</code></div>` +
        `<div><span>R parity flip</span><code>${aggBundle.odd ? "yes — coordinator negated" : "no"}</code></div>` +
        `<div><span>Bundles</span><code class="good">${bundles.length} / ${d.members.length} members</code></div>`;
      box.hidden = false;
      renderSign();
    } catch (e) { showErr("g-err", e.message); }
  });

  $("g-aggregate-partials").addEventListener("click", () => {
    hideErr("g-err");
    try {
      const d = ensureDescriptor();
      if (!S.ceremony.aggBundle) throw new Error("aggregate the nonce bundles first");
      let partials = splitLines("g-partials").map((p) => {
        const o = JSON.parse(p);
        const nb = S.ceremony.commits[o.pubkey];
        return { partial: p, nonceBundle: nb ? nb.bundle : p };
      });
      if (!partials.length) {
        const local = Object.values(S.ceremony.partials);
        if (!local.length) throw new Error("paste the members' partial signatures, or sign locally first");
        partials = local;
      }
      // attach each partial to its member's nonce bundle (locals known; remotes resolved by pubkey)
      const byPub = {};
      splitLines("g-bundles").forEach((b) => {
        try { byPub[JSON.parse(b).pubkey] = b; } catch { /* ignore */ }
      });
      Object.values(S.ceremony.commits).forEach((c) => { byPub[JSON.parse(c.bundle).pubkey] = c.bundle; });
      partials = partials.map((e) => {
        const o = JSON.parse(e.partial);
        if (!byPub[o.pubkey]) throw new Error(`no nonce bundle on file for ${o.member || o.pubkey.slice(0, 12)}…`);
        return { partial: e.partial, nonceBundle: byPub[o.pubkey] };
      });
      const fin = M.aggregatePartials({ partials, descriptor: d, aggBundle: S.ceremony.aggBundle });
      const el = $("g-final");
      if (fin.ok) {
        el.classList.add("proven"); el.classList.remove("notproven");
        el.innerHTML = `<h4>✓ PROVEN — signature verifies</h4>` +
          `<div class="kv"><div><span>Signature</span><code class="good">${esc(fin.sig)}</code></div>` +
          `<div><span>Key</span><code>${esc(d.address)}</code></div></div>` +
          `<div class="row"><button class="copy-btn ghost" data-for="g-final-sig">Copy signature</button></div>` +
          `<span id="g-final-sig" hidden>${esc(fin.sig)}</span>`;
      } else {
        el.classList.add("notproven"); el.classList.remove("proven");
        el.innerHTML = `<h4>✗ NOT PROVEN</h4><p class="lede">${esc(fin.reason)}</p>`;
      }
      el.hidden = false;
      wireCopyButtons(el);
    } catch (e) { showErr("g-err", e.message); }
  });

  /* ---------- local simulation (demo-grade) ---------- */
  function randomPriv() {
    for (;;) {
      const c = new Uint8Array(32);
      crypto.getRandomValues(c);
      try { M.memberFromPriv(c); return c; } catch { /* retry */ }
    }
  }
  $("g-simulate").addEventListener("click", () => {
    hideErr("g-err");
    try {
      const net = networkId();
      const n = Math.min(7, Math.max(2, S.members.length || 3));
      const privs = Array.from({ length: n }, randomPriv);
      const msg = ceremonyMsg();
      const sim = M.runSimulation({ privs, msg, networkId: net });
      const box = $("g-sim-result");
      const v = M.verifyMeshSignature({ sig: sim.sig, msg: sim.msg, aggKey: sim.descriptor.address });
      box.innerHTML =
        `<div><span>Members</span><code>${n} ephemeral keys (throwaway — never fund)</code></div>` +
        `<div><span>Address</span><code>${esc(sim.descriptor.address)}</code></div>` +
        `<div><span>Signature</span><code>${esc(trunc(sim.sig, 20))}</code></div>` +
        `<div><span>Standalone verify</span><code class="${v.ok ? "good" : "bad"}">${v.ok ? "✓ PROVEN" : "✗ NOT PROVEN"}</code></div>`;
      box.hidden = false;
    } catch (e) { showErr("g-err", e.message); }
  });
  $("g-back").addEventListener("click", () => goStep("fund"));
  $("g-continue").addEventListener("click", () => goStep("verify"));

  /* ---------- verify ---------- */
  $("v-check-desc").addEventListener("click", () => {
    hideErr("v-err");
    try {
      const v = M.verifyMeshDescriptor($("v-desc").value, $("v-addr").value, $("v-sealed").value || null);
      verdictBox($("v-desc-result"), v.verdict, v.checks,
        v.verdict === "PROVEN"
          ? "The descriptor re-derives the claimed address" + ($("v-sealed").value ? " and sealed commitment." : ".")
          : "The descriptor does NOT back the claim — do not trust it.");
    } catch (e) { showErr("v-err", e.message); }
  });
  $("v-check-sig").addEventListener("click", () => {
    hideErr("v-err");
    try {
      const msgText = $("v-msg").value;
      let msg;
      try { msg = M.digestForSigning(msgText); }
      catch { msg = msgText; }
      const v = M.verifyMeshSignature({ sig: $("v-sig").value, msg, aggKey: $("v-key").value });
      verdictBox($("v-sig-result"), v.ok ? "PROVEN" : "NOT PROVEN",
        [{ label: "BIP-340 verification", ok: v.ok, detail: v.reason }],
        v.ok ? "The signature is valid for this message under the aggregate key."
             : "The signature is NOT valid — do not act on it.");
    } catch (e) { showErr("v-err", e.message); }
  });
  $("v-back").addEventListener("click", () => goStep("sign"));
})();
