/* wPRL bridge site logic.
 *
 * Pure helpers at the top are shared with the contracts/backend math:
 *   1 PRL = 1e8 grains, 1 grain = 1e10 wei (exact)
 *   deposit fee  = ceil(D * 25 / 10000) grains   (backend deposit.js)
 *   withdraw fee = floor(amountWei * 25 / 10000) (WPRLBridge.requestWithdraw)
 *
 * The pure section has no DOM dependencies and is unit-tested by web/test/.
 */
"use strict";

/* ================= pure helpers (testable) ================= */

const GRAINS_PER_PRL = 100000000n;
const WEI_PER_GRAIN = 10000000000n;
const WEI_PER_WPRL = 1000000000000000000n;
const FEE_BPS_DEFAULT = 25n;

/** "10.5" PRL -> 1050000000n grains. Throws on anything that isn't a valid
 *  PRL decimal (max 8 places). Never goes through a float. */
function parsePrlToGrains(s) {
  const t = String(s).trim();
  if (!/^\d+(\.\d{1,8})?$/.test(t)) throw new Error("enter a PRL amount like 10 or 2.5 (max 8 decimals)");
  const [w, f = ""] = t.split(".");
  return BigInt(w) * GRAINS_PER_PRL + BigInt(f.padEnd(8, "0"));
}

/** "5.25" wPRL -> wei BigInt (18 decimals). Throws on invalid input. */
function parseWprlToWei(s) {
  const t = String(s).trim();
  if (!/^\d+(\.\d{1,18})?$/.test(t)) throw new Error("enter a wPRL amount (max 18 decimals)");
  const [w, f = ""] = t.split(".");
  return BigInt(w) * WEI_PER_WPRL + BigInt(f.padEnd(18, "0"));
}

/** grains -> "1.2345" PRL string (trailing zeros trimmed). */
function grainsToPrlString(grains) {
  const g = BigInt(grains);
  const w = g / GRAINS_PER_PRL;
  const f = (g % GRAINS_PER_PRL).toString().padStart(8, "0").replace(/0+$/, "");
  return f ? `${w}.${f}` : `${w}`;
}

/** wei -> "5.25" wPRL string (trailing zeros trimmed). */
function weiToWprlString(wei) {
  const w = BigInt(wei);
  const whole = w / WEI_PER_WPRL;
  const frac = (w % WEI_PER_WPRL).toString().padStart(18, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** Pearl-side deposit fee: ceil(depositGrains * feeBps / 10000). The operator
 *  rounds UP so the fee output can never be a grain under. */
function depositFeeGrains(depositGrains, feeBps = FEE_BPS_DEFAULT) {
  const d = BigInt(depositGrains), b = BigInt(feeBps);
  if (d < 0n) throw new RangeError("deposit must be non-negative");
  return (d * b + 9999n) / 10000n;
}

/** Base-side withdraw fee: floor(amountWei * feeBps / 10000) — exactly the
 *  contract's integer division: feeWei = amountWei * BRIDGE_FEE_BPS / 10000. */
function withdrawFeeWei(amountWei, feeBps = FEE_BPS_DEFAULT) {
  const a = BigInt(amountWei), b = BigInt(feeBps);
  if (a < 0n) throw new RangeError("amount must be non-negative");
  return (a * b) / 10000n;
}

function isValidEvmAddress(s) {
  return /^0x[0-9a-fA-F]{40}$/.test(String(s).trim());
}

/** Mirrors WPRLBridge's on-chain check (starts with "prl1", length >= 8)
 *  plus a guard against pasting an EVM address. bech32m checksum itself is
 *  validated by the operator before any release. */
function isValidPrlAddress(s) {
  const t = String(s).trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(t)) return false;
  return t.startsWith("prl1") && t.length >= 8;
}

/** OP_RETURN memo the deposit tx must carry (UTF-8): wprl:<evm-address> */
function buildMemo(evmAddress) {
  return `wprl:${evmAddress.trim()}`;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    parsePrlToGrains, parseWprlToWei, grainsToPrlString, weiToWprlString,
    depositFeeGrains, withdrawFeeWei, isValidEvmAddress, isValidPrlAddress, buildMemo,
  };
}

/* ================= DOM app ================= */
(function () {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const cfg = window.WPRL_CONFIG || {};
  const FEE_BPS = BigInt(cfg.feeBps ?? 25);
  const MIN_DEPOSIT = BigInt(cfg.minDepositGrains ?? "100000");
  const $ = (id) => document.getElementById(id);

  /* ---------- toast + copy ---------- */
  let toastTimer = null;
  function toast(msg) {
    const el = $("toast");
    el.textContent = msg;
    el.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add("hidden"), 2200);
  }
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-copy]");
    if (!btn) return;
    const src = $(btn.getAttribute("data-copy"));
    if (!src) return;
    const text = src.dataset.raw || src.textContent.trim();
    navigator.clipboard.writeText(text).then(
      () => toast("Copied to clipboard"),
      () => toast("Copy failed — select the text manually")
    );
  });

  /* ---------- tabs ---------- */
  const tabs = [...document.querySelectorAll(".tab")];
  tabs.forEach((t) =>
    t.addEventListener("click", () => {
      tabs.forEach((x) => { x.classList.remove("active"); x.setAttribute("aria-selected", "false"); });
      t.classList.add("active");
      t.setAttribute("aria-selected", "true");
      document.querySelectorAll(".tabbody").forEach((b) => b.classList.remove("active"));
      $("tab-" + t.dataset.tab).classList.add("active");
    })
  );

  /* ---------- deposit generator ---------- */
  const depEvm = $("dep-evm"), depAmount = $("dep-amount");
  const depSteps = $("dep-steps"), depInstructions = $("dep-instructions"), depError = $("dep-error");

  function renderDeposit() {
    depError.classList.add("hidden");
    depEvm.classList.remove("invalid");
    depAmount.classList.remove("invalid");
    let evm = depEvm.value.trim(), grains;
    try {
      if (!isValidEvmAddress(evm)) { depEvm.classList.add("invalid"); throw new Error("enter a valid 0x Base address (40 hex chars)"); }
      grains = parsePrlToGrains(depAmount.value);
      if (grains <= 0n) { depAmount.classList.add("invalid"); throw new Error("amount must be greater than zero"); }
      if (grains < MIN_DEPOSIT) {
        depAmount.classList.add("invalid");
        throw new Error(`minimum deposit is ${grainsToPrlString(MIN_DEPOSIT)} PRL`);
      }
    } catch (err) {
      depSteps.classList.add("hidden");
      depInstructions.classList.remove("hidden");
      if (depEvm.value.trim() || depAmount.value.trim()) {
        depError.textContent = err.message;
        depError.classList.remove("hidden");
      }
      return;
    }
    const fee = depositFeeGrains(grains, FEE_BPS);
    const total = grains + fee;

    $("dep-total-prl").textContent = grainsToPrlString(total) + " PRL";
    $("dep-total-prl").dataset.raw = grainsToPrlString(total);
    $("dep-vault-amt").textContent = grainsToPrlString(grains) + " PRL";
    $("dep-fee-amt").textContent = grainsToPrlString(fee) + " PRL";
    $("dep-fee-addr").textContent = cfg.prlFeeAddress || "";
    $("dep-memo").textContent = buildMemo(evm);
    $("dep-mint").textContent = grainsToPrlString(grains) + " wPRL";

    const vaultEl = $("dep-vault");
    if (cfg.vaultAddress) {
      vaultEl.textContent = cfg.vaultAddress;
    } else {
      vaultEl.textContent = "not published yet — operator vault address TBA (testnet deploy pending)";
    }
    depInstructions.classList.add("hidden");
    depSteps.classList.remove("hidden");
  }
  depEvm.addEventListener("input", renderDeposit);
  depAmount.addEventListener("input", renderDeposit);

  /* ---------- withdraw planner ---------- */
  const wdAmount = $("wd-amount"), wdPrl = $("wd-prl");
  const wdQuote = $("wd-quote"), wdError = $("wd-error");

  function renderWithdraw() {
    wdError.classList.add("hidden");
    wdQuote.classList.add("hidden");
    wdAmount.classList.remove("invalid");
    wdPrl.classList.remove("invalid");
    if (!wdAmount.value.trim() && !wdPrl.value.trim()) return;
    let amountWei, prl = wdPrl.value.trim();
    try {
      amountWei = parseWprlToWei(wdAmount.value);
      if (amountWei <= 0n) { wdAmount.classList.add("invalid"); throw new Error("amount must be greater than zero"); }
      if (!isValidPrlAddress(prl)) {
        wdPrl.classList.add("invalid");
        throw new Error(prl.startsWith("0x")
          ? "that's an EVM address — paste a prl1… Pearl address"
          : "enter a valid prl1… Pearl address");
      }
    } catch (err) {
      wdError.textContent = err.message;
      wdError.classList.remove("hidden");
      return;
    }
    const fee = withdrawFeeWei(amountWei, FEE_BPS);
    const net = amountWei - fee;
    $("wd-q-burn").textContent = weiToWprlString(amountWei) + " wPRL";
    $("wd-q-fee").textContent = weiToWprlString(fee) + " wPRL → " + (cfg.evmFeeAddress || "");
    $("wd-q-net").textContent = grainsToPrlString(net / WEI_PER_GRAIN) + " PRL";
    wdQuote.classList.remove("hidden");
  }
  wdAmount.addEventListener("input", renderWithdraw);
  wdPrl.addEventListener("input", renderWithdraw);

  /* ---------- withdraw execution (only when deployed) ---------- */
  const bridgeAddr = (cfg.bridgeAddress || "").trim();
  $("cfg-network").textContent = `${cfg.networkName || "Base Sepolia"} (chain ${cfg.chainId ?? 11155111})`;
  $("cfg-token").textContent = (cfg.tokenAddress || "").trim() || "not deployed";
  $("cfg-bridge").textContent = bridgeAddr || "not deployed";
  if (bridgeAddr && isValidEvmAddress(bridgeAddr)) {
    $("wd-live").classList.remove("hidden");
    $("wd-pending").classList.add("hidden");
    $("wd-connect").addEventListener("click", async () => {
      const status = $("wd-txstatus");
      try {
        if (!window.ethereum) throw new Error("no EVM wallet found in this browser");
        if (!window.ethers) throw new Error("ethers library failed to load — check your connection and retry");
        let amountWei, prl = wdPrl.value.trim();
        amountWei = parseWprlToWei(wdAmount.value);
        if (amountWei <= 0n) throw new Error("enter a wPRL amount first");
        if (!isValidPrlAddress(prl)) throw new Error("enter a valid prl1… Pearl address first");
        status.textContent = "Connecting wallet…";
        const provider = new window.ethers.BrowserProvider(window.ethereum);
        const net = await provider.getNetwork();
        if (Number(net.chainId) !== Number(cfg.chainId ?? 11155111)) {
          throw new Error(`wrong network — switch your wallet to ${cfg.networkName || "Base Sepolia"}`);
        }
        const signer = await provider.getSigner();
        const bridge = new window.ethers.Contract(
          bridgeAddr,
          ["function requestWithdraw(uint256 amountWei, string prlRecipient)"],
          signer
        );
        status.textContent = "Sending requestWithdraw… confirm in your wallet.";
        const tx = await bridge.requestWithdraw(amountWei.toString(), prl);
        status.textContent = "Submitted: " + tx.hash + " — waiting for confirmation…";
        await tx.wait();
        status.textContent = "Confirmed. The operator will release " +
          grainsToPrlString((amountWei - withdrawFeeWei(amountWei, FEE_BPS)) / WEI_PER_GRAIN) +
          " PRL to " + prl + ".";
        toast("Withdrawal requested");
      } catch (err) {
        status.textContent = "Failed: " + (err.reason || err.shortMessage || err.message);
      }
    });
  }

  /* ---------- proof-of-reserves dashboard ---------- */
  const apiBase = (cfg.reservesApiUrl || "").replace(/\/$/, "");
  async function loadReserves() {
    const loading = $("res-loading"), live = $("res-live"), offline = $("res-offline");
    loading.classList.remove("hidden"); live.classList.add("hidden"); offline.classList.add("hidden");
    if (!apiBase) {
      loading.classList.add("hidden");
      $("res-offline-msg").innerHTML = "The operator API isn't published yet — reserves are <strong>unavailable</strong>, not zero. " +
        "This dashboard shows real numbers only once the bridge operator is running.";
      offline.classList.remove("hidden");
      return;
    }
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(apiBase + "/reserves", { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const d = await res.json();
      const vaultPrl = grainsToPrlString(BigInt(d.pearlChain.vaultBalanceGrains));
      const supplyWprl = weiToWprlString(BigInt(d.baseChain.totalSupplyWei));
      $("res-vault").textContent = vaultPrl + " PRL";
      $("res-supply").textContent = supplyWprl + " wPRL";
      const bps = d.backing.backingBps;
      if (bps === null) {
        $("res-ratio").textContent = "n/a (no supply)";
        $("res-status").innerHTML = '<span class="badge-warn">NO SUPPLY</span>';
        $("res-bar").style.width = "0%";
      } else {
        $("res-ratio").textContent = (bps / 100).toFixed(2) + "%";
        const ok = d.backing.fullyBacked;
        $("res-status").innerHTML = ok
          ? '<span class="badge-ok">● FULLY BACKED</span>'
          : '<span class="badge-bad">● UNDER-COLLATERALIZED</span>';
        $("res-bar").style.width = Math.min(100, bps / 100) + "%";
        $("res-bar").style.background = ok ? "" : "linear-gradient(90deg, #f87171, #fbbf24)";
      }
      $("res-checked").textContent = new Date(d.checkedAt).toLocaleString();
      $("res-fee-prl").textContent = d.fees.prlFeeAddress || "";
      $("res-fee-evm").textContent = d.fees.evmFeeAddress || "";
      loading.classList.add("hidden");
      live.classList.remove("hidden");
    } catch (err) {
      loading.classList.add("hidden");
      $("res-offline-msg").innerHTML = "The operator API is <strong>unreachable</strong> right now (" +
        String(err.message || err).replace(/</g, "&lt;") + ") — reserves are <strong>unavailable</strong>, not zero.";
      offline.classList.remove("hidden");
    }
  }
  loadReserves();
  setInterval(loadReserves, 60000);

  /* ---------- pearlfield background ---------- */
  (function pearlfield() {
    const cv = $("pearlfield"), ctx = cv.getContext("2d");
    let W, H, orbs;
    function resize() {
      W = cv.width = innerWidth; H = cv.height = innerHeight;
      orbs = Array.from({ length: Math.min(70, W / 22) }, () => ({
        x: Math.random() * W, y: Math.random() * H,
        r: 1 + Math.random() * 3.2,
        vx: (Math.random() - 0.5) * 0.22, vy: (Math.random() - 0.5) * 0.22,
        hue: 195 + Math.random() * 75, // cyan -> violet
        a: 0.25 + Math.random() * 0.5,
        pulse: Math.random() * Math.PI * 2,
      }));
    }
    resize();
    addEventListener("resize", resize);
    (function tick() {
      ctx.clearRect(0, 0, W, H);
      for (const o of orbs) {
        o.x += o.vx; o.y += o.vy; o.pulse += 0.012;
        if (o.x < -10) o.x = W + 10; if (o.x > W + 10) o.x = -10;
        if (o.y < -10) o.y = H + 10; if (o.y > H + 10) o.y = -10;
        const tw = o.a * (0.7 + 0.3 * Math.sin(o.pulse));
        const g = ctx.createRadialGradient(o.x, o.y, 0, o.x, o.y, o.r * 4);
        g.addColorStop(0, `hsla(${o.hue}, 90%, 82%, ${tw})`);
        g.addColorStop(1, "hsla(220, 80%, 60%, 0)");
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(o.x, o.y, o.r * 4, 0, 7); ctx.fill();
        ctx.fillStyle = `hsla(${o.hue}, 95%, 92%, ${Math.min(1, tw + 0.25)})`;
        ctx.beginPath(); ctx.arc(o.x, o.y, o.r * 0.9, 0, 7); ctx.fill();
      }
      requestAnimationFrame(tick);
    })();
  })();
})();
