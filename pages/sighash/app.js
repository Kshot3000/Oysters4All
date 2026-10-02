/* Pearl Sighash Studio — DOM wiring.
   Classic script (no modules): runs after pearl-sighash.bundle.js, which sets
   window.PearlSighash. Every number shown is computed live from user input;
   the demo scenario is always labeled demo. */
(function () {
  "use strict";
  var PS = window.PearlSighash;
  if (!PS) { document.body.innerHTML = "<p style='padding:40px;font-family:monospace'>PearlSighash failed to load (bundle missing?).</p>"; return; }

  var $ = function (id) { return document.getElementById(id); };
  var STEPS = ["build", "anatomy", "compare", "sign", "verify"];
  var PRL_ADDR = "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d";

  function showError(id, err) {
    var el = $(id); el.hidden = false;
    el.textContent = "Refused: " + (err && err.message ? err.message : String(err));
  }
  function hideError(id) { $(id).hidden = true; $(id).textContent = ""; }

  /* ---------- deep-link tabs ---------- */
  function activate(step, push) {
    if (STEPS.indexOf(step) < 0) step = "build";
    STEPS.forEach(function (s) {
      $("step-" + s).classList.toggle("active", s === step);
    });
    Array.prototype.forEach.call(document.querySelectorAll("#steps button"), function (b) {
      b.classList.toggle("active", b.getAttribute("data-step") === step);
    });
    if (push !== false) {
      try { history.replaceState(null, "", "#" + step); } catch (e) {}
    }
  }
  Array.prototype.forEach.call(document.querySelectorAll("#steps button"), function (b) {
    b.addEventListener("click", function () { activate(b.getAttribute("data-step")); });
  });
  window.addEventListener("hashchange", function () {
    activate(location.hash.replace(/^#/, ""));
  });
  activate(location.hash.replace(/^#/, ""), false);

  /* ---------- scenario read/write ---------- */
  function hexVal(v) { return (v || "").trim().toLowerCase().replace(/^0x/, ""); }
  function numVal(v, what) {
    var n = Number((v || "").trim());
    if (!/^\d+$/.test((v || "").trim()) || n > 4294967295) throw new Error("bad " + what + ": need a uint32, got " + JSON.stringify(v));
    return n;
  }
  function readScenario() {
    var inputs = [], outputs = [];
    Array.prototype.forEach.call(document.querySelectorAll("#b-inputs tbody tr"), function (tr) {
      var tds = tr.querySelectorAll("input");
      inputs.push({
        txid: hexVal(tds[0].value), vout: numVal(tds[1].value, "vout"),
        valueGrains: (tds[2].value || "").trim(), spk: hexVal(tds[3].value),
        sequence: tds[4].value.trim() === "" ? 0xffffffff : numVal(tds[4].value, "sequence"),
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll("#b-outputs tbody tr"), function (tr) {
      var tds = tr.querySelectorAll("input");
      outputs.push({ valueGrains: (tds[0].value || "").trim(), spk: hexVal(tds[1].value) });
    });
    var scriptPath = $("b-spend-type").value === "scriptpath";
    return {
      version: numVal($("b-version").value, "nVersion"),
      locktime: numVal($("b-locktime").value, "nLockTime"),
      inputs: inputs, outputs: outputs,
      inputIndex: numVal($("b-input-index").value, "input index"),
      hashType: selectedFlag(),
      spend: scriptPath ? {
        scriptPath: true,
        leafScript: hexVal($("b-leaf-script").value),
        keyVersion: hexVal($("b-key-version").value || "00"),
        codeseedPos: $("b-codeseed").value.trim() === "" ? 0xffffffff : numVal($("b-codeseed").value, "codesep position"),
      } : { scriptPath: false },
      annex: $("b-annex").value.trim() === "" ? null : hexVal($("b-annex").value),
    };
  }
  function inputRow(i, txid, vout, value, spk, seq) {
    var tr = document.createElement("tr");
    tr.innerHTML =
      '<td class="num">' + i + '</td>' +
      '<td><input type="text" spellcheck="false" size="40" value="' + (txid || "") + '"></td>' +
      '<td><input type="text" size="4" value="' + (vout == null ? "" : vout) + '"></td>' +
      '<td><input type="text" size="14" value="' + (value == null ? "" : value) + '"></td>' +
      '<td><input type="text" spellcheck="false" size="40" value="' + (spk || "") + '"></td>' +
      '<td><input type="text" size="10" value="' + (seq == null ? "4294967295" : seq) + '"></td>' +
      '<td><button class="mini danger rm">×</button></td>';
    tr.querySelector(".rm").addEventListener("click", function () { tr.remove(); renumber("#b-inputs"); });
    return tr;
  }
  function outputRow(i, value, spk) {
    var tr = document.createElement("tr");
    tr.innerHTML =
      '<td class="num">' + i + '</td>' +
      '<td><input type="text" size="14" value="' + (value == null ? "" : value) + '"></td>' +
      '<td><input type="text" spellcheck="false" size="52" value="' + (spk || "") + '"></td>' +
      '<td><button class="mini danger rm">×</button></td>';
    tr.querySelector(".rm").addEventListener("click", function () { tr.remove(); renumber("#b-outputs"); });
    return tr;
  }
  function renumber(sel) {
    Array.prototype.forEach.call(document.querySelectorAll(sel + " tbody tr"), function (tr, i) {
      tr.firstChild.textContent = i;
    });
  }
  function fillScenario(p, demoTag) {
    $("b-version").value = p.version; $("b-locktime").value = p.locktime;
    $("b-input-index").value = p.inputIndex;
    var ib = $("b-inputs").querySelector("tbody"); ib.innerHTML = "";
    p.inputs.forEach(function (inp, i) { ib.appendChild(inputRow(i, inp.txid, inp.vout, inp.valueGrains, inp.spk, inp.sequence)); });
    var ob = $("b-outputs").querySelector("tbody"); ob.innerHTML = "";
    p.outputs.forEach(function (o, i) { ob.appendChild(outputRow(i, o.valueGrains, o.spk)); });
    $("b-spend-type").value = p.spend && p.spend.scriptPath ? "scriptpath" : "keypath";
    if (p.spend && p.spend.scriptPath) {
      $("b-leaf-script").value = p.spend.leafScript || "";
      $("b-key-version").value = p.spend.keyVersion || "00";
      $("b-codeseed").value = p.spend.codeseedPos == null ? "ffffffff" : p.spend.codeseedPos.toString(16);
    }
    $("b-annex").value = p.annex || "";
    selectFlag(p.hashType);
    toggleScriptOnly();
    $("b-demo").textContent = demoTag ? "Demo scenario loaded (2-in / 2-out, invented txids)" : "Load demo scenario (2-in / 2-out, labeled demo)";
  }
  $("b-add-input").addEventListener("click", function () {
    var tb = $("b-inputs").querySelector("tbody");
    tb.appendChild(inputRow(tb.rows.length, "", 0, "", "", "4294967295"));
  });
  $("b-add-output").addEventListener("click", function () {
    var tb = $("b-outputs").querySelector("tbody");
    tb.appendChild(outputRow(tb.rows.length, "", ""));
  });
  $("b-demo").addEventListener("click", function () { fillScenario(PS.demoScenario(), true); });
  function toggleScriptOnly() {
    var on = $("b-spend-type").value === "scriptpath";
    Array.prototype.forEach.call(document.querySelectorAll(".scriptonly"), function (el) {
      el.style.opacity = on ? "1" : ".35";
    });
    Array.prototype.forEach.call(document.querySelectorAll(".scriptonly input"), function (el) {
      el.disabled = !on;
    });
  }
  $("b-spend-type").addEventListener("change", toggleScriptOnly);

  /* ---------- flag cards ---------- */
  var FLAGS = PS.SIGHASH_FLAGS;
  var ORDER = [0x00, 0x01, 0x02, 0x03, 0x81, 0x82, 0x83];
  var NAMES = {};
  ORDER.forEach(function (ht) { NAMES[ht] = FLAGS[ht].name; });
  function selectedFlag() {
    var el = document.querySelector("#b-flags .flag-card.sel");
    return el ? parseInt(el.getAttribute("data-ht"), 10) : 0x00;
  }
  function selectFlag(ht) {
    Array.prototype.forEach.call(document.querySelectorAll("#b-flags .flag-card"), function (c) {
      var on = parseInt(c.getAttribute("data-ht"), 10) === ht;
      c.classList.toggle("sel", on);
      c.setAttribute("aria-checked", on ? "true" : "false");
      c.tabIndex = on ? 0 : -1;
    });
  }
  ORDER.forEach(function (ht) {
    var f = FLAGS[ht];
    var card = document.createElement("div");
    card.className = "flag-card" + (ht === 0x00 ? " sel" : "");
    card.setAttribute("data-ht", ht);
    card.innerHTML = '<div class="fname">' + f.name + '</div><div class="fcode">0x' +
      ht.toString(16).toUpperCase().padStart(2, "0") + "</div>" +
      '<div class="fdesc">' + f.blurb + "</div>";
    card.setAttribute("role", "radio");
    card.setAttribute("aria-checked", ht === 0x00 ? "true" : "false");
    card.tabIndex = ht === 0x00 ? 0 : -1;
    card.addEventListener("click", function () { selectFlag(ht); });
    card.addEventListener("keydown", function (e) {
      var cards = Array.prototype.slice.call(document.querySelectorAll("#b-flags .flag-card"));
      var idx = cards.indexOf(card);
      var next = null;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") next = cards[(idx + 1) % cards.length];
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = cards[(idx - 1 + cards.length) % cards.length];
      else if (e.key === " " || e.key === "Enter") { e.preventDefault(); selectFlag(ht); return; }
      else return;
      e.preventDefault();
      selectFlag(parseInt(next.getAttribute("data-ht"), 10));
      next.focus();
    });
    $("b-flags").appendChild(card);
  });
  [ ["c-flag-a", 0x01], ["c-flag-b", 0x02] ].forEach(function (pair) {
    var sel = $(pair[0]);
    ORDER.forEach(function (ht) {
      var o = document.createElement("option");
      o.value = ht; o.textContent = NAMES[ht] + " (0x" + ht.toString(16).toUpperCase().padStart(2, "0") + ")";
      sel.appendChild(o);
    });
    sel.value = pair[1];
  });

  /* ---------- build: compute + seal ---------- */
  function computeAnatomy() {
    hideError("b-error");
    return PS.tapSighashAnatomy(readScenario());
  }
  $("b-compute").addEventListener("click", function () {
    try {
      var a = computeAnatomy();
      $("b-result").hidden = false;
      $("b-digest").textContent = a.digestHex;
      $("b-meta").textContent = "flag " + a.flagName + " · input " + a.inputIndex +
        " · spend_type 0x" + a.spendType.toString(16) + " · preimage " + (a.preimageHex.length / 2) + " bytes · " +
        a.intermediates.filter(function (x) { return x.present; }).length + " components present";
      $("b-sealed").value = "";
    } catch (e) { showError("b-error", e); }
  });
  $("b-seal").addEventListener("click", function () {
    try {
      var s = PS.sealScenario(readScenario());
      $("b-result").hidden = false;
      $("b-digest").textContent = s.digest;
      $("b-meta").textContent = "flag " + s.flagName + " · fingerprint " + s.fingerprint.slice(0, 32) + "…";
      $("b-sealed").value = s.sealed;
      $("b-sealed").select();
    } catch (e) { showError("b-error", e); }
  });

  /* ---------- anatomy render ---------- */
  function methodLabel(m) {
    return { raw: "RAW BYTES", sha256: "SHA256", tagged: 'taggedHash("TapSighash")', omitted: "OMITTED" }[m] || m;
  }
  $("a-render").addEventListener("click", function () {
    hideError("a-error");
    var list = $("a-list"); list.innerHTML = "";
    try {
      var a = PS.tapSighashAnatomy(readScenario());
      a.intermediates.forEach(function (rec, i) {
        var div = document.createElement("div");
        div.className = "ana" + (rec.present ? "" : " omitted");
        var head = document.createElement("div");
        head.className = "ana-head";
        head.innerHTML = '<span class="ana-idx">' + String(i + 1).padStart(2, "0") + '</span>' +
          '<span class="ana-name">' + rec.id + '</span>' +
          '<span class="ana-value">' + (rec.present ? rec.valueHex.slice(0, 40) + (rec.valueHex.length > 40 ? "…" : "") : "—") + "</span>" +
          '<span class="ana-method">' + methodLabel(rec.method) + "</span>";
        var body = document.createElement("div");
        body.className = "ana-body";
        var note = document.createElement("p"); note.className = "ana-note"; note.textContent = rec.note;
        body.appendChild(note);
        if (rec.present && rec.preimageHex) {
          var h = document.createElement("div"); h.className = "hex"; h.textContent = rec.preimageHex;
          var cap = document.createElement("p"); cap.className = "meta";
          cap.textContent = "preimage (" + (rec.preimageHex.length / 2) + " bytes) → " + methodLabel(rec.method) + " → " + rec.valueHex;
          body.appendChild(h); body.appendChild(cap);
        } else {
          var om = document.createElement("p"); om.className = "why";
          om.textContent = rec.why || "Omitted for this flag — never hashed, never zeroed.";
          body.appendChild(om);
        }
        div.appendChild(head); div.appendChild(body);
        head.addEventListener("click", function () { div.classList.toggle("open"); });
        list.appendChild(div);
      });
      $("a-preimage").textContent = a.preimageHex;
      $("a-preimage-len").textContent = "(" + (a.preimageHex.length / 2) + " bytes)";
      $("a-digest").textContent = a.digestHex;
    } catch (e) { showError("a-error", e); }
  });

  /* ---------- compare ---------- */
  $("c-run").addEventListener("click", function () {
    hideError("c-error");
    var tb = $("c-table").querySelector("tbody"); tb.innerHTML = "";
    $("c-verdict").innerHTML = "";
    var mb = $("c-matrix").querySelector("tbody"); mb.innerHTML = "";
    try {
      var params = readScenario();
      var ha = parseInt($("c-flag-a").value, 10), hb = parseInt($("c-flag-b").value, 10);
      $("c-head-a").textContent = "A · " + NAMES[ha];
      $("c-head-b").textContent = "B · " + NAMES[hb];
      var cmp = PS.compareFlags(params, ha, hb);
      var ndiff = 0;
      cmp.rows.forEach(function (r) {
        if (!r.same) ndiff++;
        var tr = document.createElement("tr");
        tr.className = r.same ? "same" : "diff";
        function cell(v, present) {
          return !present ? '<span class="badge dim">omitted</span>'
            : "<code>" + String(v).slice(0, 24) + (String(v).length > 24 ? "…" : "") + "</code>";
        }
        tr.innerHTML = "<td><strong>" + r.id + "</strong></td><td>" + cell(r.aValue, r.aPresent) + "</td><td>" + cell(r.bValue, r.bPresent) + "</td>" +
          '<td>' + (r.same ? '<span class="badge good">same</span>' : '<span class="badge warn">differs</span>') + "</td>" +
          '<td class="why">' + r.why + "</td>";
        tb.appendChild(tr);
      });
      var v = document.createElement("p"); v.className = "meta";
      v.textContent = "A digest " + cmp.digestA + " · B digest " + cmp.digestB +
        " · digests " + (cmp.digestA === cmp.digestB ? "IDENTICAL" : "DIFFER") +
        " · " + ndiff + " component(s) differ";
      $("c-verdict").appendChild(v);
      var m = PS.flagDigestMatrix(params);
      ORDER.forEach(function (ht) {
        var tr = document.createElement("tr");
        tr.innerHTML = "<td><strong>" + NAMES[ht] + "</strong></td><td><code>" + m[ht] + "</code></td>";
        mb.appendChild(tr);
      });
    } catch (e) { showError("c-error", e); }
  });

  /* ---------- sign / verify (BIP-340) ---------- */
  function msgHex() {
    if ($("s-msg-src").value === "scenario") {
      return PS.tapSighashAnatomy(readScenario()).digestHex;
    }
    return hexVal($("s-digest").value);
  }
  function refreshPub() {
    try {
      var p = hexVal($("s-priv").value);
      $("s-pub").value = p ? PS.bip340Pubkey(p) : "";
    } catch (e) { $("s-pub").value = ""; }
  }
  $("s-priv").addEventListener("input", refreshPub);
  $("s-gen").addEventListener("click", function () {
    $("s-priv").value = PS.randomPrivkey(); refreshPub();
  });
  $("s-wipe").addEventListener("click", function () {
    $("s-priv").value = ""; $("s-pub").value = ""; $("s-sig") && ($("s-sig").textContent = "");
    $("s-result").hidden = true;
  });
  $("s-sign").addEventListener("click", function () {
    hideError("s-error");
    try {
      var sig = PS.bip340Sign(msgHex(), hexVal($("s-priv").value), "00".repeat(32));
      $("s-result").hidden = false;
      $("s-sig").textContent = sig;
      $("s-meta").textContent = "signed with BIP-340 (zero aux randomness) · pubkey " + $("s-pub").value.slice(0, 16) + "…";
    } catch (e) { showError("s-error", e); }
  });
  $("v-verify").addEventListener("click", function () {
    var el = $("v-result"); el.innerHTML = "";
    var ok = PS.bip340Verify(hexVal($("v-digest").value), hexVal($("v-sig").value), hexVal($("v-pub").value));
    var d = document.createElement("div");
    d.className = "verdict " + (ok ? "proven" : "notproven");
    d.textContent = ok ? "Valid" : "Invalid";
    el.appendChild(d);
  });

  /* ---------- verify tab: official vectors + sealed descriptors ---------- */
  function vecRow(c, okPre, okDig) {
    var tr = document.createElement("tr");
    tr.innerHTML = "<td><code>0x" + c.hashType.toString(16).toUpperCase().padStart(2, "0") + "</code></td>" +
      "<td>" + NAMES[c.hashType] + "</td><td class='num'>" + c.txinIndex + "</td>" +
      '<td>' + (okPre ? '<span class="badge good">preimage ✓</span>' : '<span class="badge bad">preimage ✗</span>') + "</td>" +
      '<td>' + (okDig ? '<span class="badge good">digest ✓</span>' : '<span class="badge bad">digest ✗</span>') + "</td>";
    return tr;
  }
  $("vf-run-vectors").addEventListener("click", function () {
    var box = $("vf-vector-results"); box.innerHTML = "";
    try {
      var V = PS.vectors.BIP341_KEYPATH;
      var tx = PS.parseUnsignedTx(V.rawUnsignedTx);
      var fails = 0;
      var tb = document.createElement("tbody");
      V.cases.forEach(function (c) {
        var params = {
          version: tx.version, locktime: tx.locktime,
          inputs: tx.inputs.map(function (inp, i) {
            return { txid: inp.txid, vout: inp.vout,
              valueGrains: V.utxosSpent[i].amountSats.toString(),
              spk: V.utxosSpent[i].scriptPubKey, sequence: inp.sequence };
          }),
          outputs: tx.outputs.map(function (o) { return { valueGrains: o.valueGrains, spk: o.spk }; }),
          inputIndex: c.txinIndex, hashType: c.hashType,
          spend: { scriptPath: false }, annex: null,
        };
        var okPre = false, okDig = false;
        try {
          var a = PS.tapSighashAnatomy(params);
          okPre = a.preimageHex.toLowerCase() === c.sigMsg.toLowerCase();
          okDig = a.digestHex.toLowerCase() === c.sigHash.toLowerCase();
        } catch (e) {}
        if (!okPre || !okDig) fails++;
        tb.appendChild(vecRow(c, okPre, okDig));
      });
      var t = document.createElement("table"); t.className = "draft";
      t.innerHTML = "<thead><tr><th>hash_type</th><th>Flag</th><th class='num'>Input</th><th>Preimage</th><th>Digest</th></tr></thead>";
      t.appendChild(tb);
      var wrap = document.createElement("div"); wrap.className = "table-wrap";
      wrap.appendChild(t); box.appendChild(wrap);
      var d = document.createElement("div");
      d.className = "verdict " + (fails === 0 ? "proven" : "notproven");
      d.textContent = fails === 0 ? "7 / 7 vectors reproduced" : fails + " vector(s) FAILED";
      box.appendChild(d);
      var note = document.createElement("p"); note.className = "hint";
      note.textContent = "Each preimage and digest compared byte-for-byte against the published sigMsg/sigHash of the official vectors.";
      box.appendChild(note);
    } catch (e) {
      box.innerHTML = ""; showErrorBox(box, e);
    }
  });
  function showErrorBox(box, e) {
    var d = document.createElement("div"); d.className = "error";
    d.textContent = "Refused: " + (e && e.message ? e.message : String(e));
    box.appendChild(d);
  }
  $("vf-verify").addEventListener("click", function () {
    var box = $("vf-verdict"); box.innerHTML = "";
    try {
      var v = PS.verifySealed($("vf-input").value);
      var d = document.createElement("div");
      d.className = "verdict " + (v.verdict === "PROVEN" ? "proven" : v.verdict === "NOT PROVEN" ? "notproven" : "unsealed");
      d.textContent = v.verdict;
      box.appendChild(d);
      var ul = document.createElement("ul"); ul.className = "vlist";
      v.checks.forEach(function (c) {
        var li = document.createElement("li");
        li.className = c.ok ? "ok" : "no";
        li.textContent = (c.ok ? "✓ " : "✗ ") + c.name + (c.detail ? " — " + c.detail : "");
        ul.appendChild(li);
      });
      box.appendChild(ul);
      v.errors.forEach(function (e) {
        var p = document.createElement("p"); p.className = "no";
        p.style.cssText = "font-family:var(--mono);color:var(--bad)";
        p.textContent = "✗ " + e; box.appendChild(p);
      });
      if (v.digest) {
        var h = document.createElement("div"); h.className = "hex"; h.textContent = v.digest;
        var cap = document.createElement("p"); cap.className = "meta";
        cap.textContent = "recomputed digest — " + (v.verdict === "PROVEN" ? "matches the seal" : "does not match any seal");
        box.appendChild(cap); box.appendChild(h);
      }
    } catch (e) { showErrorBox(box, e); }
  });

  /* ---------- wipe keys ---------- */
  $("wipe-keys").addEventListener("click", function () {
    ["s-priv", "s-pub", "s-digest", "v-digest", "v-sig", "v-pub"].forEach(function (id) { $(id).value = ""; });
    $("s-result").hidden = true; $("v-result").innerHTML = "";
  });

  /* ---------- init ---------- */
  fillScenario(PS.demoScenario(), true);
  toggleScriptOnly();

  /* PRL address sanity: footer carries the canonical address, character-for-character */
  (function () {
    var ok = document.body.textContent.indexOf(PRL_ADDR) >= 0;
    if (!ok) console.warn("PRL address missing from page");
  })();
})();
