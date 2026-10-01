/* Pearl Policy app — blueprint studio UI.
 * Drives window.PearlPolicy (committed esbuild bundle). Fully offline:
 * no network requests, no storage; mnemonics live in memory only.
 */
(function () {
  "use strict";
  const P = window.PearlPolicy;
  if (!P) throw new Error("Pearl Policy bundle failed to load");

  function $(id) { return document.getElementById(id); }
  function leafField(i, name) { return document.getElementById("leaf-" + i + "-" + name); }
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function showErr(id, msg) {
    const e = $(id);
    e.textContent = msg;
    e.hidden = false;
  }
  function hideErr(id) { $(id).hidden = true; }

  /* ---------- step nav ---------- */
  const panels = { design: "step-design", address: "step-address", verify: "step-verify", export: "step-export", learn: "step-learn" };
  function goStep(name) {
    document.querySelectorAll("#steps button").forEach((b) => {
      b.classList.toggle("active", b.dataset.step === name);
    });
    Object.keys(panels).forEach((k) => {
      $(panels[k]).classList.toggle("active", k === name);
    });
  }
  document.querySelectorAll("#steps button").forEach((b) => {
    b.addEventListener("click", () => goStep(b.dataset.step));
  });

  /* ---------- QR ---------- */
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

  /* ---------- copy buttons ---------- */
  function wireCopyButtons(scope) {
    scope.querySelectorAll(".copy-btn").forEach((b) => {
      if (b._wired) return;
      b._wired = true;
      b.addEventListener("click", async () => {
        const src = document.getElementById(b.dataset.for);
        const txt = src ? (src.value !== undefined && src.value !== "" ? src.value : src.textContent) : "";
        const old = b.textContent;
        try {
          await navigator.clipboard.writeText(txt);
          b.textContent = "Copied";
        } catch {
          b.textContent = "Copy failed";
        }
        // restore label without timers (DOM-test shim never fires setTimeout)
        b.addEventListener("blur", () => { b.textContent = old; }, { once: true });
      });
    });
  }
  wireCopyButtons(document);

  /* ---------- internal key source ---------- */
  let draftMnemonic = "";
  function srcMode() {
    if ($("d-src-bip86").checked) return "bip86";
    if ($("d-src-key").checked) return "key";
    return "nums";
  }
  function refreshSrcUI() {
    const m = srcMode();
    $("d-mnemonic-wrap").hidden = m !== "bip86";
    $("d-key-wrap").hidden = m !== "key";
    $("d-gen-mnemonic").hidden = m !== "bip86";
    $("d-wipe").hidden = m !== "bip86";
  }
  ["d-src-nums", "d-src-bip86", "d-src-key"].forEach((id) => {
    $(id).addEventListener("change", refreshSrcUI);
  });
  refreshSrcUI();
  $("d-gen-mnemonic").addEventListener("click", () => {
    draftMnemonic = P.newMnemonic();
    $("d-mnemonic").value = draftMnemonic;
  });
  $("d-wipe").addEventListener("click", () => {
    draftMnemonic = "";
    $("d-mnemonic").value = "";
  });

  /* ---------- leaf editor ---------- */
  const LEAF_KIND_INFO = {
    keylock: "KeyLock — <xonly> OP_CHECKSIG. Byte-identical to the audited Pearl Bounty award leaf.",
    timelock: "TimelockRefund — <height> OP_CHECKLOCKTIMEVERIFY OP_DROP <xonly> OP_CHECKSIG. Byte-identical to the audited Pearl Escrow refund leaf.",
    multisig: "MultiSig — m-of-n <0> <K1> CHECKSIGADD … <m> EQUAL. The audited Pearl Covenant multisig pattern; keys are sorted canonically.",
    custom: "Custom script hex — EXPERT MODE. Unreviewed: verify the script yourself, test on testnet, never fund what you cannot read.",
  };
  let leafKinds = ["keylock"];

  function renderLeaves() {
    const box = $("d-leaves");
    let html = "";
    leafKinds.forEach((kind, i) => {
      html += '<div class="leaf-card' + (kind === "custom" ? " expert" : "") + '" id="leaf-' + i + '-card">';
      html += '<h4>Leaf ' + (i + 1) + ' <button class="ghost leaf-remove" id="leaf-' + i + '-remove" data-i="' + i + '" type="button">Remove</button></h4>';
      html += '<label>Template<select id="leaf-' + i + '-kind">'
        + ["keylock", "timelock", "multisig", "custom"].map((k) =>
          '<option value="' + k + '"' + (k === kind ? " selected" : "") + ">" + k + "</option>").join("")
        + "</select></label>";
      html += '<p class="hint leaf-kind-info" id="leaf-' + i + '-info">' + esc(LEAF_KIND_INFO[kind]) + "</p>";
      // keylock + timelock key
      html += '<div class="form-grid leaf-grp-key" id="leaf-' + i + '-grp-key"' + (kind === "multisig" || kind === "custom" ? " hidden" : "") + ">";
      html += '<label class="wide">Key — 64-hex x-only pubkey, 12/24-word mnemonic, or prl1… address<input id="leaf-' + i + '-key" type="text" autocomplete="off" spellcheck="false" placeholder="64-hex · mnemonic · prl1p…"></label>';
      html += '<label class="leaf-height-wrap" id="leaf-' + i + '-height-wrap"' + (kind === "timelock" ? "" : " hidden") + '>Refund height (block)<input id="leaf-' + i + '-height" type="number" min="1" max="499999999" step="1" value="900000"></label>';
      html += "</div>";
      // multisig
      html += '<div class="form-grid leaf-grp-ms" id="leaf-' + i + '-grp-ms"' + (kind === "multisig" ? "" : " hidden") + ">";
      html += '<label>m (signatures required)<input id="leaf-' + i + '-m" type="number" min="1" max="16" step="1" value="2"></label>';
      html += '<label class="wide">Cosigner keys — one per line (64-hex, mnemonic, or prl1… address)<textarea id="leaf-' + i + '-keys" rows="3" spellcheck="false" placeholder="one key per line"></textarea></label>';
      html += "</div>";
      // custom
      html += '<div class="form-grid leaf-grp-x" id="leaf-' + i + '-grp-x"' + (kind === "custom" ? "" : " hidden") + ">";
      html += '<label class="wide">Raw script hex (expert)<textarea id="leaf-' + i + '-hex" rows="2" spellcheck="false" placeholder="hex-encoded script"></textarea></label>';
      html += "</div>";
      html += '<div class="expert-warn" id="leaf-' + i + '-warn"' + (kind === "custom" ? "" : " hidden") + ">⚠ EXPERT MODE — this script is UNREVIEWED. Pearl Policy cannot check what it does. Verify it yourself; never fund a tree you cannot fully read.</div>";
      html += "</div>";
    });
    box.innerHTML = html;
    $("d-leaf-count").textContent = "(" + leafKinds.length + " of 8)";
    $("d-add-leaf").disabled = leafKinds.length >= 8;
    // sensible defaults (the value="" attribute is enough in real browsers;
    // this also covers minimal-DOM harnesses that don't parse attributes)
    leafKinds.forEach((kind, i) => {
      const h = leafField(i, "height");
      if (h && !h.value) h.value = "900000";
      const m = leafField(i, "m");
      if (m && !m.value) m.value = "2";
    });
    box.querySelectorAll(".leaf-remove").forEach((b) => {
      b.addEventListener("click", () => {
        const i = Number(b.dataset.i);
        if (leafKinds.length <= 1) { showErr("d-err", "A policy tree needs at least one leaf."); return; }
        leafKinds.splice(i, 1);
        renderLeaves();
      });
    });
    box.querySelectorAll("select").forEach((sel) => {
      sel.addEventListener("change", () => {
        const m = /^leaf-(\d+)-kind$/.exec(sel.id);
        if (!m) return;
        const i = Number(m[1]);
        leafKinds[i] = sel.value;
        const kind = sel.value;
        // in-place update — values stay, no re-render needed
        const gid = (n) => document.getElementById("leaf-" + i + "-" + n);
        gid("card").classList.toggle("expert", kind === "custom");
        gid("info").textContent = LEAF_KIND_INFO[kind];
        gid("grp-key").hidden = kind === "multisig" || kind === "custom";
        gid("grp-ms").hidden = kind !== "multisig";
        gid("grp-x").hidden = kind !== "custom";
        gid("height-wrap").hidden = kind !== "timelock";
        gid("warn").hidden = kind !== "custom";
      });
    });
  }

  function readLeafInputs() {
    return leafKinds.map((kind, i) => {
      const v = { kind };
      const g = (n) => leafField(i, n);
      if (g("key")) v.key = g("key").value;
      if (g("height")) v.height = g("height").value;
      if (g("m")) v.m = g("m").value;
      if (g("keys")) v.keys = g("keys").value;
      if (g("hex")) v.hex = g("hex").value;
      return v;
    });
  }
  function writeLeafInputs(saved) {
    saved.forEach((v, i) => {
      const g = (n) => leafField(i, n);
      if (v.key !== undefined && g("key")) g("key").value = v.key;
      if (v.height !== undefined && g("height")) g("height").value = v.height;
      if (v.m !== undefined && g("m")) g("m").value = v.m;
      if (v.keys !== undefined && g("keys")) g("keys").value = v.keys;
      if (v.hex !== undefined && g("hex")) g("hex").value = v.hex;
    });
  }

  $("d-add-leaf").addEventListener("click", () => {
    const saved = readLeafInputs();
    if (leafKinds.length >= 8) return;
    leafKinds.push("keylock");
    renderLeaves();
    writeLeafInputs(saved);
  });
  renderLeaves();

  /* ---------- tree SVG ---------- */
  function treeSVG(bp) {
    const levels = bp.levels;
    const n = bp.leaves.length;
    const rowH = 56, colW = 230, padX = 30, padY = 34;
    const width = padX * 2 + colW * levels.length;
    const height = padY * 2 + rowH * Math.max(n, 1);
    const yOf = (node) => padY + ((node.leafIndices[0] + node.leafIndices[node.leafIndices.length - 1]) / 2) * rowH + rowH / 2;
    let s = '<svg viewBox="0 0 ' + width + " " + height + '" xmlns="http://www.w3.org/2000/svg">';
    // wires first (child -> parent)
    for (let li = 0; li < levels.length - 1; li++) {
      const cur = levels[li], nxt = levels[li + 1];
      for (const node of cur) {
        const parent = nxt.find((p) => node.leafIndices.every((x) => p.leafIndices.includes(x)));
        if (!parent) continue;
        s += '<line class="twire" x1="' + (padX + li * colW + 150) + '" y1="' + yOf(node) + '" x2="' + (padX + (li + 1) * colW) + '" y2="' + yOf(parent) + '"/>';
      }
    }
    levels.forEach((level, li) => {
      const isRoot = li === levels.length - 1;
      for (const node of level) {
        const x = padX + li * colW, y = yOf(node);
        const cls = isRoot ? "tnode troot" : "tnode";
        s += '<rect class="' + cls + '" x="' + x + '" y="' + (y - 20) + '" width="150" height="40" rx="6"/>';
        let label, sub;
        if (li === 0) {
          const leaf = bp.leaves[node.leafIndices[0]];
          label = "L" + (leaf.index + 1) + " · " + leaf.kind;
          sub = leaf.leafHash.slice(0, 12) + "…";
        } else if (isRoot) {
          label = "merkle root";
          sub = P.bytesToHex(bp.root).slice(0, 12) + "…";
        } else {
          label = "branch";
          sub = P.bytesToHex(node.hash).slice(0, 12) + "…";
        }
        s += '<text class="tlabel" x="' + (x + 10) + '" y="' + (y - 3) + '">' + esc(label) + "</text>";
        s += '<text class="thash" x="' + (x + 10) + '" y="' + (y + 12) + '">' + esc(sub) + "</text>";
      }
    });
    return s + "</svg>";
  }

  function leafDetailHTML(bp) {
    return bp.leaves.map((l) => {
      const cid = "cb-" + l.index;
      return '<div class="leaf-block">'
        + "<h4>Leaf " + (l.index + 1) + " · " + esc(l.kind) + ' <span class="' + (l.controlValid ? "badge-ok" : "badge-bad") + '">'
        + (l.controlValid ? "control block verified" : "CONTROL BLOCK INVALID") + "</span></h4>"
        + '<pre class="asm">' + esc(l.asm) + "</pre>"
        + '<dl class="kv">'
        + "<dt>leaf hash</dt><dd><code>" + l.leafHash + "</code></dd>"
        + "<dt>control block</dt><dd><code id=\"" + cid + "\">" + l.controlBlock + '</code> <button class="copy-btn" data-for="' + cid + '">Copy</button></dd>'
        + "<dt>merkle depth</dt><dd>" + l.depth + "</dd>"
        + "</dl></div>";
    }).join("");
  }

  /* ---------- draft ---------- */
  let blueprint = null;

  function internalSourceFromUI() {
    const network = $("d-network").value === "testnet" ? P.NETWORKS.testnet : P.NETWORKS.mainnet;
    const m = srcMode();
    if (m === "nums") return { mode: "nums" };
    if (m === "bip86") {
      const mn = ($("d-mnemonic").value || "").trim() || draftMnemonic;
      if (!mn) throw new Error("BIP-86 needs a mnemonic — paste one or generate one.");
      return { mode: "bip86", mnemonic: mn };
    }
    const k = ($("d-key").value || "").trim();
    if (!k) throw new Error("Paste an x-only public key first.");
    return { mode: "key", xonly: k };
  }

  $("d-draft").addEventListener("click", () => {
    hideErr("d-err");
    try {
      const network = $("d-network").value === "testnet" ? P.NETWORKS.testnet : P.NETWORKS.mainnet;
      const inputs = readLeafInputs();
      const leafInputs = inputs.map((v) => {
        if (v.kind === "keylock") {
          if (!v.key || !v.key.trim()) throw new Error("leaf: keylock needs a key");
          return { kind: "keylock", xonly: v.key.trim() };
        }
        if (v.kind === "timelock") {
          if (!v.key || !v.key.trim()) throw new Error("leaf: timelock needs a key");
          return { kind: "timelock", xonly: v.key.trim(), height: v.height };
        }
        if (v.kind === "multisig") {
          const keys = (v.keys || "").split("\n").map((x) => x.trim()).filter(Boolean);
          if (keys.length < 1) throw new Error("leaf: multisig needs at least one key");
          return { kind: "multisig", m: v.m, keys };
        }
        if (!v.hex || !v.hex.trim()) throw new Error("leaf: custom needs script hex");
        return { kind: "custom", hex: v.hex.trim() };
      });
      blueprint = P.forgePolicy({ network, internalSource: internalSourceFromUI(), leafInputs });

      $("d-out").hidden = false;
      $("d-descriptor").value = blueprint.descriptor;
      const r = $("d-review");
      r.innerHTML =
        "<dt>address</dt><dd>" + esc(blueprint.address) + "</dd>"
        + "<dt>internal key</dt><dd>" + esc(blueprint.internalLabel) + "</dd>"
        + "<dt>leaves</dt><dd>" + blueprint.leaves.length + "</dd>"
        + "<dt>sealed</dt><dd>" + esc(blueprint.sealed) + "</dd>";
      $("d-tree").innerHTML = treeSVG(blueprint);
      $("d-leaf-detail").innerHTML = leafDetailHTML(blueprint);
      wireCopyButtons($("d-out"));
      renderAddressTab();
    } catch (e) {
      $("d-out").hidden = true;
      blueprint = null;
      showErr("d-err", e.message);
    }
  });

  $("d-to-address").addEventListener("click", () => goStep("address"));

  /* ---------- address tab ---------- */
  function renderAddressTab() {
    if (!blueprint) return;
    const bp = blueprint;
    $("a-out").hidden = false;
    $("a-lede").textContent = "Every value below is recomputed from the canonical descriptor — nothing is stored, nothing is sent anywhere.";
    $("a-addr").textContent = bp.address;
    renderQR($("a-qr"), bp.address);
    $("a-review").innerHTML =
      "<dt>scriptPubKey</dt><dd>" + P.bytesToHex(bp.spk) + "</dd>"
      + "<dt>internal key</dt><dd>" + P.bytesToHex(bp.internalXOnly) + " — " + esc(bp.internalLabel) + "</dd>"
      + "<dt>merkle root</dt><dd>" + P.bytesToHex(bp.root) + "</dd>"
      + "<dt>tweak</dt><dd>" + P.bytesToHex(bp.tweak) + "</dd>"
      + "<dt>descriptor</dt><dd>" + esc(bp.descriptor) + "</dd>";
    $("a-tree").innerHTML = treeSVG(bp);
    $("a-leaves").innerHTML = leafDetailHTML(bp);
    wireCopyButtons($("a-out"));
  }

  $("a-reverify").addEventListener("click", () => {
    if (!blueprint) return;
    const bad = blueprint.leaves.filter((l) =>
      !P.verifyPolicyControlBlock(blueprint.internalXOnly, l.script, P.hexToBytes(l.controlBlock), blueprint.tweakedX));
    const o = $("a-reverify-out");
    o.hidden = false;
    if (bad.length === 0) {
      o.className = "ok";
      o.textContent = "All " + blueprint.leaves.length + " control blocks re-verified against the tweaked key — every leaf is spend-ready.";
    } else {
      o.className = "err";
      o.textContent = bad.length + " control block(s) FAILED verification — do not use this blueprint.";
    }
  });

  /* ---------- verify tab ---------- */
  $("v-check").addEventListener("click", () => {
    hideErr("v-err");
    const r = P.verifyPolicy($("v-descriptor").value, $("v-address").value, $("v-sealed").value);
    $("v-out").hidden = false;
    const v = $("v-verdict");
    if (r.proven) {
      v.className = "verdict proven";
      v.innerHTML = '<span class="big-verdict">✓ PROVEN</span>' + esc(r.reason);
      const bp = r.blueprint;
      $("v-review").innerHTML =
        "<dt>address</dt><dd>" + esc(bp.address) + "</dd>"
        + "<dt>internal key</dt><dd>" + esc(bp.internalLabel) + "</dd>"
        + "<dt>leaves</dt><dd>" + bp.leaves.map((l) => l.kind).join(", ") + "</dd>"
        + "<dt>sealed</dt><dd>" + esc(bp.sealed) + "</dd>";
    } else {
      v.className = "verdict notproven";
      v.innerHTML = '<span class="big-verdict">✗ NOT PROVEN</span>' + esc(r.reason || "unknown failure");
      $("v-review").innerHTML = r.recomputedAddress
        ? "<dt>recomputed address</dt><dd>" + esc(r.recomputedAddress) + "</dd>"
        : "";
    }
  });

  /* ---------- export tab ---------- */
  function shareBase() {
    try {
      if (location.origin && location.pathname && location.origin !== "null") {
        return location.origin + location.pathname;
      }
    } catch { /* sandboxed */ }
    return "https://kshot3000.github.io/Pearl-Muse-24-7-Ai-builder/pages/policy/";
  }
  function renderExport() {
    const has = !!blueprint;
    $("x-out").hidden = !has;
    if (!has) {
      showErr("x-err", "Draft a blueprint in the Design step first — there is nothing to export yet.");
      return;
    }
    hideErr("x-err");
    $("x-json").value = P.exportJson(blueprint);
    $("x-md").value = P.exportMarkdown(blueprint);
    $("x-share").value = shareBase() + "#p=" + encodeURIComponent(blueprint.descriptor);
    wireCopyButtons($("x-out"));
  }
  document.querySelectorAll('#steps button[data-step="export"]').forEach((b) => {
    b.addEventListener("click", renderExport);
  });
  $("x-download").addEventListener("click", () => {
    if (!blueprint) return;
    const blob = new Blob([P.exportJson(blueprint)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "pearl-policy-blueprint.json";
    document.body.appendChild(a);
    a.click();
  });

  /* ---------- share-URL intake ---------- */
  (function () {
    let hash = "";
    try { hash = String(location.hash || ""); } catch { /* sandboxed */ }
    if (hash.startsWith("#p=")) {
      try {
        $("v-descriptor").value = decodeURIComponent(hash.slice(3));
        goStep("verify");
      } catch { /* malformed hash: ignore */ }
    }
  })();
})();
