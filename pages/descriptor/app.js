/* Pearl Atlas — DOM wiring. Uses window.PearlDescriptor (pearl-descriptor.bundle.js).
   No network calls, ever. Private-key material is only ever held in memory and
   the Wipe button clears every input. */
(function () {
  "use strict";
  const P = window.PearlDescriptor;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));

  /* tabs */
  const tabs = [...document.querySelectorAll(".tab")];
  tabs.forEach((b) => b.addEventListener("click", () => {
    tabs.forEach((x) => { x.classList.toggle("active", x === b); x.setAttribute("aria-selected", x === b); });
    document.querySelectorAll(".panel").forEach((p) => p.classList.add("hidden"));
    $("tab-" + b.dataset.tab).classList.remove("hidden");
  }));
  const gotoTab = (name) => document.querySelector(`.tab[data-tab="${name}"]`).click();

  const errCard = (e) => `<div class="err"><strong>Refused:</strong> ${esc((e && e.message) || e)}</div>`;
  const trunc = (s, n = 42) => s.length > n ? s.slice(0, n) + "…" : s;

  /* ---------- Analyze ---------- */
  $("an-run").addEventListener("click", () => {
    const out = $("an-out");
    const input = $("an-input").value.trim();
    if (!input) { out.innerHTML = ""; return; }
    try {
      const ast = P.parseDescriptor(input);
      const lines = P.describe(ast);
      const kv = Object.fromEntries(lines.map((l) => [l.k, l.v]));
      const keys = P.listKeys(ast);
      const ck = P.descCheckChecksum(input);
      const seal = !ck.checksum ? `<span class="pill warn">no checksum</span>`
        : ck.ok ? `<span class="pill good">checksum OK</span>` : `<span class="pill bad">BAD checksum</span>`;

      let keyRows = keys.map((k, i) => {
        const o = k.origin ? `${esc(k.origin.fingerprint)}/${k.origin.path.map((s) => s.index + (s.hardened ? "h" : "")).join("/")}` : "—";
        const kind = k.wildcard ? "ranged <code>*</code>" : (k.path && k.path.length ? "derived path" : "single key");
        const priv = /priv|wif|xprv/i.test(k.kind || "") ? ` <span class="pill warn">private</span>` : "";
        return `<tr><td>${i + 1}</td><td>${o}</td><td>${esc(k.label || k.kind || "?")}${priv}</td><td>${kind}</td><td>${esc(trunc(k.text || "", 34))}</td></tr>`;
      }).join("");

      let treeHtml = "";
      if (ast.kind === "tr") {
        try {
          const d = P.deriveDescriptor(ast, { index: 0 });
          const leafRows = d.leaves.map((l, i) => {
            const depth = Math.max(1, Math.ceil(Math.log2(d.leaves.length || 1)));
            return `<tr><td>${i + 1}</td><td>${esc(l.leafHash.slice(0, 24))}…</td>` +
              `<td>${esc(l.controlBlock.slice(0, 24))}…</td><td>${esc(trunc(l.scriptHex, 40))}</td></tr>`;
          }).join("");
          treeHtml = `<div class="card"><h3>Taproot tree <span class="pill">${d.leaves.length || "key-path only"} leaf${d.leaves.length === 1 ? "" : "s"}</span></h3>` +
            `<div class="kv"><dt>Internal key</dt><dd>${esc(d.internalXOnly)}</dd>` +
            (d.merkleRoot ? `<dt>Merkle root</dt><dd>${esc(d.merkleRoot)}</dd>` : "") +
            `<dt>Output key</dt><dd>${esc(d.tweakedXOnly)}</dd>` +
            `<dt>Address (index 0)</dt><dd>${esc(d.address)}</dd></div>` +
            (leafRows ? `<table class="chart"><tr><th>#</th><th>Leaf hash</th><th>Control block</th><th>Script</th></tr>${leafRows}</table>`
              : `<p class="hint">Key-path only — no scripts in this descriptor.</p>`) + `</div>`;
        } catch (e) { treeHtml = `<div class="warn">Tree preview unavailable: ${esc(e.message)}</div>`; }
      }

      const privNote = keys.some((k) => /priv|wif|xprv/i.test(k.kind || ""))
        ? `<div class="warn"><strong>Private key material detected.</strong> It lives only in this page's memory. Use <strong>Wipe inputs</strong> on the Derive tab (or Clear here) when done.</div>` : "";
      const mpNote = P.hasMultipath(ast)
        ? `<div class="warn"><strong>Multipath descriptor.</strong> Expand it (BIP-389) before deriving — see the Derive tab.</div>` : "";

      out.innerHTML =
        `<div class="card"><h3>Summary ${seal}</h3><div class="kv">` +
        lines.map((l) => `<dt>${esc(l.k)}</dt><dd>${esc(l.v)}</dd>`).join("") +
        `</div></div>` + privNote + mpNote +
        `<div class="card"><h3>Keys <span class="pill">${keys.length}</span></h3>` +
        `<table class="chart"><tr><th>#</th><th>Origin</th><th>Type</th><th>Range</th><th>Key</th></tr>${keyRows}</table></div>` +
        treeHtml;
    } catch (e) { out.innerHTML = errCard(e); }
  });
  $("an-clear").addEventListener("click", () => { $("an-input").value = ""; $("an-out").innerHTML = ""; });

  /* ---------- Checksum ---------- */
  $("cs-add").addEventListener("click", () => {
    const out = $("cs-out");
    try {
      const sealed = P.descAddChecksum($("cs-input").value.trim());
      out.innerHTML = `<div class="card"><h3>Sealed <span class="pill good">BIP-380</span></h3>` +
        `<div class="tree">${esc(sealed)}</div></div>`;
    } catch (e) { out.innerHTML = errCard(e); }
  });
  $("cs-verify").addEventListener("click", () => {
    const out = $("cs-out");
    try {
      const r = P.descCheckChecksum($("cs-input").value.trim(), { require: true });
      out.innerHTML = r.ok
        ? `<div class="card"><h3><span class="pill good">Checksum valid</span></h3><div class="tree">${esc(r.body)}</div></div>`
        : `<div class="err"><strong>Invalid:</strong> ${esc(r.reason)}</div>`;
    } catch (e) { out.innerHTML = errCard(e); }
  });
  $("cs-clear").addEventListener("click", () => { $("cs-input").value = ""; $("cs-out").innerHTML = ""; });

  /* ---------- Derive ---------- */
  const wipeAll = () => {
    for (const id of ["an-input", "cs-input", "dv-input"]) $(id).value = "";
    for (const id of ["an-out", "cs-out", "dv-out"]) $(id).innerHTML = "";
    $("dv-warn").classList.add("hidden");
  };
  $("dv-wipe").addEventListener("click", wipeAll);

  $("dv-run").addEventListener("click", () => {
    const out = $("dv-out"), warn = $("dv-warn");
    warn.classList.add("hidden");
    try {
      const input = $("dv-input").value.trim();
      if (!input) { out.innerHTML = ""; return; }
      const ast = P.parseDescriptor(input);
      const keys = P.listKeys(ast);
      if (keys.some((k) => /priv|wif|xprv/i.test(k.kind || ""))) {
        warn.innerHTML = "<strong>Private key material detected</strong> — deriving locally in memory. Wipe when done.";
        warn.classList.remove("hidden");
      }
      const start = Math.max(0, parseInt($("dv-start").value, 10) || 0);
      const count = Math.min(50, Math.max(1, parseInt($("dv-count").value, 10) || 5));
      const hrp = $("dv-net").value.startsWith("tprl") ? "tprl" : "prl";

      let bodies = [input];
      if (P.hasMultipath(ast)) bodies = P.expandDescriptorMultipath(input);

      let html = "";
      for (const body of bodies) {
        const rows = [];
        for (let i = start; i < start + count; i++) {
          const d = P.deriveDescriptor(body, { index: i, hrp });
          const what = d.address
            ? `<span class="pill good">address</span> <code>${esc(d.address)}</code>`
            : `<span class="pill warn">scriptPubKey</span> <code>${esc(trunc(d.spk, 44))}</code><br><span class="hint">${esc(d.note || "")}</span>`;
          rows.push(`<tr><td>${i}</td><td>${what}</td></tr>`);
        }
        const label = bodies.length > 1 ? ` <span class="pill">${esc(trunc(body, 50))}</span>` : "";
        html += `<div class="card"><h3>Derived${label}</h3><table class="chart"><tr><th>Index</th><th>Result</th></tr>${rows.join("")}</table></div>`;
      }
      out.innerHTML = html;
    } catch (e) { out.innerHTML = errCard(e); }
  });

  /* ---------- Templates ---------- */
  const grid = $("tmpl-grid");
  grid.innerHTML = P.TEMPLATES.map((t, i) =>
    `<div class="tmpl"><h3>${esc(t.name)}</h3><p>${esc(t.description)}</p>` +
    `<code>${esc(t.body)}</code>` +
    `<button class="btn ghost" data-tmpl="${i}">Load into Analyze</button></div>`).join("");
  grid.addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-tmpl]");
    if (!b) return;
    $("an-input").value = P.TEMPLATES[+b.dataset.tmpl].body;
    gotoTab("analyze");
    $("an-run").click();
  });

  /* ---------- Verify ---------- */
  $("vf-run").addEventListener("click", () => {
    const out = $("vf-out");
    out.innerHTML = `<div class="card"><h3>Running…</h3></div>`;
    setTimeout(() => {
      try {
        const r = P.selfTest();
        const rows = r.lines.map((l) =>
          `<div class="${l.ok ? "ok-line" : "bad-line"}">${l.ok ? "✔" : "✖"} ${esc(l.name)}` +
          (l.extra ? ` <span class="mono">— ${esc(l.extra)}</span>` : "") + `</div>`).join("");
        out.innerHTML = `<div class="card"><h3>Self-test ${r.ok ? '<span class="pill good">ALL GREEN</span>' : '<span class="pill bad">FAILURES</span>'}</h3>${rows}</div>`;
      } catch (e) { out.innerHTML = errCard(e); }
    }, 30);
  });

  /* footer tip copy */
  $("tip-addr").addEventListener("click", () => {
    const t = $("tip-addr").textContent;
    if (navigator.clipboard) navigator.clipboard.writeText(t).catch(() => {});
  });
})();
