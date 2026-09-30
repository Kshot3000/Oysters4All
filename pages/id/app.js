/* Pearl ID — Sign-in with Pearl (page logic). All crypto via window.PearlID
 * (audited Sign core underneath). Keys live in page memory only. */
(function () {
  "use strict";
  var E = window.PearlID;
  if (!E) { document.body.innerHTML = "<p style='padding:40px'>Pearl ID failed to load (pearl-id.bundle.js missing).</p>"; return; }

  var key = null; // { priv, internalXOnly, address, xonly, source, network }
  var pendingFields = null;

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function show(el, on) { el.hidden = !on; }
  function setErr(id, msg) { var el = $(id); el.textContent = msg; show(el, !!msg); }
  function copyText(text, btn) {
    var done = function () {
      if (!btn) return;
      var old = btn.textContent; btn.textContent = "Copied ✓";
      setTimeout(function () { btn.textContent = old; }, 1400);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
    } else { fallbackCopy(text); done(); }
  }
  function fallbackCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch (e) {}
    document.body.removeChild(ta);
  }
  function download(name, text, type) {
    var blob = new Blob([text], { type: type || "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  /* ---------- tabs ---------- */
  document.querySelectorAll("#tabs button").forEach(function (b) {
    b.addEventListener("click", function () {
      document.querySelectorAll("#tabs button").forEach(function (x) { x.classList.remove("active"); });
      b.classList.add("active");
      document.querySelectorAll(".tab").forEach(function (t) {
        t.classList.toggle("active", t.id === "tab-" + b.dataset.tab);
      });
    });
  });
  document.querySelectorAll(".copy-btn[data-for]").forEach(function (b) {
    b.addEventListener("click", function () { copyText($(b.dataset.for).textContent, b); });
  });

  /* ---------- keys tab ---------- */
  function wipeKey() {
    if (key && key.priv) { try { key.priv.fill(0); } catch (e) {} }
    key = null;
    show($("pid-key-out"), false);
    show($("pid-wipe"), false);
    $("pid-import-input").value = "";
  }
  function loadKey(w, source) {
    wipeKey();
    var xonly = E.idPubkeyHex(w.internalXOnly);
    key = {
      priv: w.priv, internalXOnly: w.internalXOnly,
      address: w.address, xonly: xonly,
      source: source, network: (w.network && w.network.label) || "Mainnet",
    };
    renderIdentity();
  }
  function renderIdentity() {
    if (!key) { show($("pid-key-out"), false); show($("pid-wipe"), false); return; }
    $("pid-key-source").textContent = key.source;
    $("pid-address").textContent = key.address;
    $("pid-xonly").textContent = key.xonly;
    $("pid-network").textContent = key.network;
    show($("pid-key-out"), true);
    show($("pid-wipe"), true);
  }
  $("pid-gen12").addEventListener("click", function () {
    try {
      setErr("pid-identity-err", "");
      loadKey(E.idKeyFromInput(E.newMnemonic()), "fresh 12-word mnemonic (BIP-86 m/86'/coin'/0'/0/0)");
    } catch (e) { setErr("pid-identity-err", String((e && e.message) || e)); }
  });
  $("pid-import").addEventListener("click", function () {
    try {
      setErr("pid-identity-err", "");
      var w = E.idKeyFromInput($("pid-import-input").value);
      loadKey(w, w.source);
    } catch (e) { setErr("pid-identity-err", String((e && e.message) || e)); }
  });
  $("pid-wipe").addEventListener("click", wipeKey);

  /* ---------- sign-in tab ---------- */
  $("pid-new-challenge").addEventListener("click", function () {
    try { $("pid-challenge").value = E.newChallengeHex(); }
    catch (e) { setErr("pid-sign-err", String((e && e.message) || e)); }
  });
  $("pid-fill-demo").addEventListener("click", function () {
    $("pid-domain").value = "demo.local";
    try { $("pid-challenge").value = E.newChallengeHex(); }
    catch (e) { setErr("pid-sign-err", String((e && e.message) || e)); }
    setErr("pid-sign-err", "");
  });
  function buildFields() {
    var now = Math.floor(Date.now() / 1000);
    var lifetime = parseInt($("pid-expiry").value, 10) || 300;
    return {
      domain: $("pid-domain").value,
      address: key.address,
      xonly: key.xonly,
      challenge: $("pid-challenge").value,
      issued_at: String(now),
      expires_at: String(now + lifetime),
      _lifetime: lifetime,
    };
  }
  $("pid-sign").addEventListener("click", function () {
    setErr("pid-sign-err", "");
    show($("pid-cred-out"), false);
    if (!key) { setErr("pid-sign-err", "Load an identity key first (tab 1)."); return; }
    var f;
    try {
      f = buildFields();
      var fv = E.validateUnsignedFields(f);
      if (!fv.ok) throw new Error(fv.errors.join("; "));
      pendingFields = f;
    } catch (e) { setErr("pid-sign-err", String((e && e.message) || e)); return; }
    // Confirm screen: domain BIG, so phishing is hard to miss.
    $("pid-confirm-domain").textContent = f.domain.trim().toLowerCase();
    $("pid-confirm-address").textContent = f.address;
    $("pid-confirm-challenge").textContent = f.challenge.trim().toLowerCase();
    var mins = Math.round(f._lifetime / 60);
    $("pid-confirm-expiry").textContent = mins >= 60
      ? "in " + (mins / 60) + " hour(s) (" + new Date((parseInt(f.expires_at, 10)) * 1000).toLocaleString() + ")"
      : "in " + mins + " minute(s)";
    show($("pid-confirm"), true);
    $("pid-confirm").scrollIntoView({ block: "nearest" });
  });
  $("pid-confirm-cancel").addEventListener("click", function () {
    pendingFields = null;
    show($("pid-confirm"), false);
  });
  $("pid-confirm-sign").addEventListener("click", function () {
    if (!key || !pendingFields) return;
    try {
      var now = Math.floor(Date.now() / 1000);
      var f = Object.assign({}, pendingFields, {
        issued_at: String(now),
        expires_at: String(now + pendingFields._lifetime),
      });
      var env = E.signCredential({ fields: f, priv: key.priv, internalXOnly: key.internalXOnly });
      $("pid-cred-json").textContent = E.credentialJSON(env);
      $("pid-cred-fingerprint").textContent = env.fingerprint;
      $("pid-cred-address").textContent = env.address;
      show($("pid-confirm"), false);
      show($("pid-cred-out"), true);
      pendingFields = null;
    } catch (e) { setErr("pid-sign-err", String((e && e.message) || e)); }
  });
  $("pid-copy-cred").addEventListener("click", function (ev) {
    copyText($("pid-cred-json").textContent, ev.target);
  });
  $("pid-download-cred").addEventListener("click", function () {
    download("pearl-id-credential.json", $("pid-cred-json").textContent);
  });

  /* ---------- verify tab ---------- */
  $("pid-verify-btn").addEventListener("click", function () {
    var expected = $("pid-verify-domain").value.trim();
    var v = E.verifyCredential($("pid-verify-input").value, {
      expectedDomain: expected || undefined,
    });
    show($("pid-verify-result"), true);
    var vd = $("pid-verdict");
    vd.textContent = v.verdict === "VALID-WARN" ? "VALID ⚠" : v.verdict;
    vd.className = "verdict " + v.verdict;
    $("pid-verify-id").textContent = v.id || "— (could not recompute)";
    var box = $("pid-verify-checks");
    box.innerHTML = "";
    v.checks.forEach(function (c) {
      var d = document.createElement("div");
      d.className = "check " + c.status;
      d.innerHTML = "<span class=\"cs\">" + c.status + "</span><span><span class=\"cn\">" +
        esc(c.name) + "</span><br><span class=\"cd\">" + esc(c.detail) + "</span></span>";
      box.appendChild(d);
    });
  });

  /* ---------- integrate tab ---------- */
  var VERIFY_SNIPPET = [
    "// \"Sign in with Pearl\" — relying-party verifier.",
    "// Load pearl-id.bundle.js first: <script src=\"pearl-id.bundle.js\"></script>",
    "function pearlLogin(credentialText, expectedDomain) {",
    "  const v = PearlID.verifyCredential(credentialText, {",
    "    expectedDomain, // e.g. \"shop.example.com\" — must be YOUR domain",
    "    nowSec: Math.floor(Date.now() / 1000),",
    "  });",
    "  if (v.verdict === \"INVALID\") {",
    "    return { ok: false,",
    "      reasons: v.checks.filter(c => c.status === \"fail\")",
    "                         .map(c => c.name + \": \" + c.detail) };",
    "  }",
    "  // VALID or VALID-WARN (warnings are listed in v.checks — log them).",
    "  // The prl1… address IS the account id. No passwords stored, ever.",
    "  return { ok: true, address: v.credential.address,",
    "           warnings: v.checks.filter(c => c.status === \"warn\") };",
    "}",
  ].join("\n");
  var ISSUER_SNIPPET = [
    "import { randomBytes } from \"node:crypto\";",
    "",
    "// 1. When the user clicks \"Sign in with Pearl\", mint a challenge:",
    "const challenge = randomBytes(32).toString(\"hex\"); // 256-bit, single-use",
    "//    Store server-side: { challenge, createdAt: Date.now() }, 5-minute TTL.",
    "// 2. Show the user YOUR domain + this challenge",
    "//    (they sign it in the Pearl ID desk and POST the credential back).",
    "// 3. Verify the credential (snippet above), then:",
    "//      - require credential.challenge === the stored challenge",
    "//      - DELETE the stored challenge (never accept it twice)",
    "//      - log them in as credential.address",
  ].join("\n");
  $("pid-snippet-verify").textContent = VERIFY_SNIPPET;
  $("pid-snippet-issuer").textContent = ISSUER_SNIPPET;
  $("pid-copy-snippet-verify").addEventListener("click", function (ev) { copyText(VERIFY_SNIPPET, ev.target); });
  $("pid-copy-snippet-issuer").addEventListener("click", function (ev) { copyText(ISSUER_SNIPPET, ev.target); });

  /* ---------- boot ---------- */
  renderIdentity();
})();
