/* Invoice payment page: ?inv=<code> [&demo=1]. (classic script)
 * Decodes the invoice, renders QR + countdown, polls Blockbook for the real
 * payment state (awaiting → partial → detected → confirmed / expired). */
const {
  NETWORKS, decodeInvoice, watchPayment, formatPRL, pearlUri,
} = window.PearlPayCore || {};
if (!window.PearlPayCore) {
  document.body.innerHTML = "<p style='padding:2rem'>Failed to load pearl-pay-core.bundle.js</p>";
  throw new Error("PearlPayCore bundle missing");
}

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const DEMO = params.get("demo") === "1";

function fail(msg) {
  $("inv-card").hidden = true;
  $("inv-error").hidden = false;
  $("inv-error-msg").textContent = msg;
}

function main() {
  const toggle = document.querySelector(".nav-toggle");
  const links = document.querySelector(".nav-links");
  if (toggle && links) {
    toggle.addEventListener("click", () => {
      const open = links.classList.toggle("open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      toggle.textContent = open ? "✕" : "☰";
    });
  }

  const code = params.get("inv");
  if (!code) { fail("No invoice code in the URL. Ask the merchant for a fresh invoice link."); return; }
  let inv;
  try {
    inv = decodeInvoice(code);
  } catch (e) {
    fail("This invoice code is invalid or corrupted (" + e.message + "). Ask the merchant for a fresh link.");
    return;
  }

  $("inv-card").hidden = false;
  $("inv-label").textContent = inv.label || "Invoice";
  $("inv-amount").textContent = formatPRL(inv.grains);
  $("inv-addr").textContent = inv.address;
  $("inv-conf").textContent = String(inv.conf);
  $("demo-banner").hidden = !DEMO;

  // QR encodes the payment URI (short enough to scan) — wallets pay from it.
  // The full shareable invoice link is the page URL itself.
  window.PearlPay.drawQrCanvas($("inv-qr"), pearlUri(inv.address, inv.grains), 6);

  $("btn-copy").onclick = async () => {
    await navigator.clipboard.writeText(inv.address).catch(() => {});
    $("btn-copy").textContent = "Copied ✓";
    setTimeout(() => ($("btn-copy").textContent = "Copy"), 1500);
  };

  const pill = $("inv-pill"), progress = $("inv-progress");
  const PILL = {
    awaiting: ["Awaiting payment", "awaiting"],
    partial: ["Partial payment", "partial"],
    detected: ["Detected — confirming…", "detected"],
    confirmed: ["✓ Paid", "confirmed"],
    expired: ["Expired", "expired"],
  };
  function setState(state, detail) {
    const [label, cls] = PILL[state] || ["Error", "expired"];
    pill.textContent = label;
    pill.className = "pill " + cls;
    if (detail && detail.received) {
      const pct = Math.min(100, Number((BigInt(detail.received) * 100n) / BigInt(inv.grains)));
      progress.style.width = pct + "%";
    }
    if (state === "confirmed") {
      $("inv-note").textContent = "Payment confirmed. Thank you! You can close this page.";
      clearInterval(cdTimer);
    } else if (state === "expired") {
      $("inv-note").textContent = "This invoice expired before payment arrived. Ask the merchant for a new one.";
      clearInterval(cdTimer);
    } else if (state === "partial") {
      $("inv-note").textContent = "Partial payment seen — please send the remaining amount to the same address.";
    }
  }

  // countdown
  const expiryMs = inv.exp * 1000;
  function tick() {
    const left = Math.max(0, expiryMs - Date.now());
    const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
    $("inv-countdown").textContent = left > 0 ? `Expires in ${m}:${String(s).padStart(2, "0")}` : "Expired";
    if (left <= 0) clearInterval(cdTimer);
  }
  const cdTimer = setInterval(tick, 1000);
  tick();

  if (DEMO) {
    setState("awaiting");
    setTimeout(() => setState("partial", { received: String(BigInt(inv.grains) / 3n) }), 2500);
    setTimeout(() => setState("detected", { received: inv.grains }), 5000);
    setTimeout(() => setState("confirmed", { received: inv.grains }), 8000);
    return;
  }

  const blockbook = NETWORKS[inv.net].blockbook;
  (async () => {
    try {
      const r = await fetch(blockbook + "/api/v2/api", { cache: "no-store" });
      if (r.ok) {
        const j = await r.json();
        $("conn").textContent = `connected · block ${j.blockbook?.bestHeight ?? "?"}`;
        $("conn").classList.add("ok");
      }
    } catch { /* badge stays neutral */ }
  })();

  watchPayment({
    blockbookBase: blockbook,
    address: inv.address,
    requiredGrains: inv.grains,
    expiryMs,
    reqConf: inv.conf,
    intervalMs: 15000,
    onEvent: setState,
  });
  setState("awaiting");
}

main();
