/* Pearl Gateway for WooCommerce — thank-you page payment watcher.
 * Uses the bundled PearlPay SDK (pearl-pay.js, global PearlPay):
 * draws the QR, polls Blockbook live (awaiting → partial → detected →
 * confirmed), and asks the SERVER (admin-ajax, order key + nonce) for the
 * authoritative state — only the server can mark the order paid.
 */
(function () {
  "use strict";

  function $(id) { return document.getElementById(id); }

  function text(msg) {
    var s = $("pearl-pay-state");
    if (s) s.textContent = msg;
  }

  function main() {
    var box = $("pearl-pay-box");
    if (!box || typeof PearlPay === "undefined") return;

    var address   = box.getAttribute("data-address");
    var grains    = box.getAttribute("data-grains");
    var blockbook = box.getAttribute("data-blockbook");
    var reqConf   = parseInt(box.getAttribute("data-req-conf") || "2", 10);
    var expiryMs  = parseInt(box.getAttribute("data-expiry-ms") || "0", 10);
    var orderId   = box.getAttribute("data-order-id");
    var orderKey  = box.getAttribute("data-order-key");
    var expiryAt  = Date.now() + expiryMs;

    // QR: pearl:<address>?amount=<prl>
    var prl = (parseInt(grains, 10) / 100000000).toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
    var uri = "pearl:" + address + "?amount=" + prl;
    try {
      PearlPay.drawQrCanvas($("pearl-pay-qr"), uri);
    } catch (e) { /* QR is convenience; address text remains */ }

    var copyBtn = $("pearl-pay-copy");
    if (copyBtn) {
      copyBtn.addEventListener("click", function () {
        if (navigator.clipboard) navigator.clipboard.writeText(address).catch(function () {});
        copyBtn.textContent = "Copied";
        setTimeout(function () { copyBtn.textContent = "Copy address"; }, 1500);
      });
    }

    var COPY = {
      awaiting: "Awaiting payment — send exactly the amount above.",
      partial: "Partial payment detected — still short of the full amount.",
      detected: "Payment detected on the network — waiting for confirmations.",
      confirmed: "Payment confirmed — thank you! Your order is being processed.",
      expired: "Payment window expired. Contact the merchant if you already paid.",
      error: "Connection issue — retrying…"
    };

    var done = false;

    // Ask the server for the authoritative state (it re-checks Blockbook
    // itself and completes the order when confirmations are reached).
    function serverCheck() {
      if (done || typeof PearlGateway === "undefined") return;
      var url = PearlGateway.ajaxUrl +
        "?action=pearl_gateway_check&order_id=" + encodeURIComponent(orderId) +
        "&key=" + encodeURIComponent(orderKey) +
        "&nonce=" + encodeURIComponent(PearlGateway.nonce);
      fetch(url, { credentials: "same-origin" })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (j && j.success && j.data && j.data.state === "confirmed") {
            done = true;
            text(COPY.confirmed);
            setTimeout(function () { window.location.reload(); }, 2500);
          }
        })
        .catch(function () {});
    }

    PearlPay.watchPayment({
      blockbook: blockbook,
      address: address,
      requiredGrains: grains,
      expiryMs: expiryAt,
      reqConf: reqConf,
      intervalMs: 15000,
      onEvent: function (state) {
        text(COPY[state] || state);
        if (state === "detected" || state === "confirmed") serverCheck();
        if (state === "confirmed" || state === "expired") done = true;
      }
    });

    // Backstop: poll the server every 30s too (covers the case where the
    // browser tab was closed and reopened, and the cron sweep).
    var backstop = setInterval(function () {
      if (done) { clearInterval(backstop); return; }
      serverCheck();
    }, 30000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", main);
  } else {
    main();
  }
})();
