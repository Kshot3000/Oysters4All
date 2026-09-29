/* Pearl Tipjar core — embeddable PRL tip-jar / donation-widget generator.
 *
 * Pure ESM. The browser ships a committed esbuild IIFE bundle
 * (pearl-tipjar.bundle.js, entry src/index.js re-exporting this file);
 * node runs this file directly for the verification suite.
 *
 * Model: a creator configures a tip jar (recipient prl1/tprl1 address,
 * title, 1-4 amount presets, optional PRL goal, visual theme, poll cadence)
 * and gets a self-contained copy-paste embed snippet. The embedded widget
 * does GET-only Blockbook polling of the address and renders an animated
 * jar, confetti on new tips, a recent-tips feed, goal progress, and a
 * pearl: payment URI + QR for the active preset amount.
 *
 * Crypto lineage: NO new cryptography. Address validation reuses the
 * audited Pearl Sign core (../../sign/src/crypto.js) bech32m decoder —
 * witness v1, 32-byte program, prl/tprl hrp. Descriptor hashing is SHA-256
 * over the canonical config JSON (tamper-evident, not a signature).
 *
 * Grain math is BigInt throughout (1 PRL = 1e8 grains). Outputs below
 * TIP_DUST_FLOOR (1000 grains) are not counted as tips: they are
 * uneconomical to ever spend on-chain and would let anyone spam the jar
 * feed for free. Confirmations are detected at 1+ — 0-conf mempool
 * transactions are not counted as tips.
 */

import {
  NETWORKS,
  GRAIN_PER_PRL,
  decodeBech32m,
  sha256,
  bytesToHex,
} from "../../sign/src/crypto.js";

export { NETWORKS, GRAIN_PER_PRL };

/* ---------------- constants ---------------- */

export const DONATE_ADDRESS = "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d";
export const BUILDER_X = "@kshot9000";

export const TIP_DUST_FLOOR = 1000n; // grains; smaller outputs are not counted as tips
export const DEFAULT_POLL_SEC = 30;
export const MIN_POLL_SEC = 15;
export const MAX_POLL_SEC = 300;
export const MAX_PRESETS = 4;
export const MAX_TITLE_LEN = 60;
export const MAX_FEED_ROWS = 20;

export const THEMES = {
  "harbor-lantern": {
    name: "Harbor Lantern",
    blurb: "Amber glass glow — a warm lantern on the night harbor.",
  },
  "deep-abyss": {
    name: "Deep Abyss",
    blurb: "Indigo and teal bioluminescence from the deep chain.",
  },
  "ember-forge": {
    name: "Ember Forge",
    blurb: "Crimson and charcoal — tips land like sparks on the anvil.",
  },
};
export const DEFAULT_THEME = "harbor-lantern";

const DESCRIPTOR_RE = /^tipjar:v1:([a-z0-9]+):([0-9a-f]{64})$/;

const utf8 = (s) => new TextEncoder().encode(String(s));
const sha256Hex = (s) => bytesToHex(sha256(utf8(s)));

/* ---------------- address ---------------- */

/**
 * Validate a Pearl tip recipient address. Must be bech32m (NOT bech32),
 * hrp prl or tprl, witness version 1, 32-byte program (Taproot only).
 * Returns { address (canonical), network, program } — throws otherwise.
 */
export function validateTipAddress(raw) {
  const t = String(raw ?? "").trim();
  if (!t) throw new Error("recipient address is required");
  let dec;
  try {
    dec = decodeBech32m(t);
  } catch (e) {
    throw new Error(`not a valid Pearl address: ${e.message}`);
  }
  if (dec.hrp !== "prl" && dec.hrp !== "tprl") {
    throw new Error(`wrong network hrp "${dec.hrp}" — tip jars accept prl1… (mainnet) or tprl1… (testnet) only`);
  }
  if (dec.version !== 1) {
    throw new Error(`witness version ${dec.version} is not a Pearl Taproot address (need v1)`);
  }
  if (!dec.program || dec.program.length !== 32) {
    throw new Error("address program must be 32 bytes (Taproot x-only key)");
  }
  const network = dec.hrp === "prl" ? NETWORKS.mainnet : NETWORKS.testnet;
  return { address: t.toLowerCase(), network, program: dec.program };
}

/* ---------------- grain math ---------------- */

/** Exact grains -> PRL decimal string (no float anywhere). */
export function formatPrl(grains) {
  const g = typeof grains === "bigint" ? grains : BigInt(grains);
  if (g < 0n) throw new Error("negative grain amount");
  const whole = g / BigInt(GRAIN_PER_PRL);
  const frac = g % BigInt(GRAIN_PER_PRL);
  if (frac === 0n) return `${whole}`;
  return `${whole}.${frac.toString().padStart(8, "0").replace(/0+$/, "")}`;
}

/**
 * Parse an exact PRL decimal string ("0.1", "2.5", "100") into grains
 * (BigInt). At most 8 decimal places — anything finer is not representable
 * and is rejected rather than rounded. Throws on bad input.
 */
export function parsePRLToGrains(raw) {
  const t = String(raw ?? "").trim();
  if (!/^\d+(\.\d{1,8})?$/.test(t)) {
    throw new Error(`not an exact PRL amount (up to 8 decimals): "${String(raw).slice(0, 40)}"`);
  }
  const [w, f = ""] = t.split(".");
  return BigInt(w) * BigInt(GRAIN_PER_PRL) + BigInt(f.padEnd(8, "0") || "0");
}

/** pearl: payment URI (BIP-21 style), amount in exact PRL. */
export function pearlUri(address, grains) {
  if (grains == null) return `pearl:${address}`;
  return `pearl:${address}?amount=${formatPrl(grains)}`;
}

/* ---------------- config ---------------- */

/**
 * Validate + normalize a tip-jar config. raw fields:
 *   address, title, presets: [prl strings], goal: prl string | "" ,
 *   theme, pollSec, blockbook
 * Returns the canonical config:
 *   { address, hrp, networkId, title, presets:[PRL decimal strings asc],
 *     goal: PRL decimal string | null, theme, pollSec, blockbook }
 * Presets/goal are stored as canonical PRL decimals (via formatPrl), which
 * makes normalizeConfig idempotent — the verifier re-normalizes the JSON
 * and must arrive at the identical canonical form.
 * Throws on anything ambiguous.
 */
export function normalizeConfig(raw) {
  const r = raw || {};
  const { address, network } = validateTipAddress(r.address);
  const networkId = network.id;

  const title = String(r.title ?? "").trim();
  if (!title) throw new Error("jar title is required");
  if (title.length > MAX_TITLE_LEN) throw new Error(`title too long (max ${MAX_TITLE_LEN} chars)`);

  const presetInputs = Array.isArray(r.presets) ? r.presets : [];
  if (presetInputs.length < 1) throw new Error("at least one amount preset is required");
  if (presetInputs.length > MAX_PRESETS) throw new Error(`at most ${MAX_PRESETS} presets`);
  const presetSet = new Set();
  for (const p of presetInputs) {
    const g = parsePRLToGrains(p);
    if (g <= 0n) throw new Error("presets must be positive PRL amounts");
    if (g < TIP_DUST_FLOOR) {
      throw new Error(`preset ${formatPrl(g)} PRL is below the ${formatPrl(TIP_DUST_FLOOR)} PRL dust floor — it could never be counted as a tip`);
    }
    presetSet.add(g);
  }
  const presets = [...presetSet].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  let goal = null;
  const goalRaw = String(r.goal ?? "").trim();
  if (goalRaw) {
    goal = parsePRLToGrains(goalRaw);
    if (goal <= 0n) throw new Error("goal must be a positive PRL amount");
    if (goal < presets[presets.length - 1]) {
      throw new Error(`goal ${formatPrl(goal)} PRL is below the largest preset ${formatPrl(presets[presets.length - 1])} PRL`);
    }
  }

  const theme = String(r.theme ?? DEFAULT_THEME);
  if (!THEMES[theme]) throw new Error(`unknown theme "${theme}" — pick one of: ${Object.keys(THEMES).join(", ")}`);

  const pollSec = r.pollSec == null || r.pollSec === "" ? DEFAULT_POLL_SEC : Number(r.pollSec);
  if (!Number.isInteger(pollSec) || pollSec < MIN_POLL_SEC || pollSec > MAX_POLL_SEC) {
    throw new Error(`poll interval must be an integer ${MIN_POLL_SEC}–${MAX_POLL_SEC} seconds`);
  }

  let blockbook = String(r.blockbook ?? "").trim();
  if (!blockbook) blockbook = network.blockbook || NETWORKS.mainnet.blockbook;
  blockbook = blockbook.replace(/\/$/, "");
  if (!/^https?:\/\//.test(blockbook)) throw new Error("Blockbook URL must start with http(s)://");

  return {
    address,
    hrp: network.hrp,
    networkId,
    title,
    presets: presets.map((g) => formatPrl(g)),
    goal: goal == null ? null : formatPrl(goal),
    theme,
    pollSec,
    blockbook,
  };
}

/** Canonical JSON for a normalized config (fixed key order). */
export function canonicalConfigJSON(cfg) {
  const ordered = {
    address: cfg.address,
    title: cfg.title,
    presets: cfg.presets,
    goal: cfg.goal,
    theme: cfg.theme,
    pollSec: cfg.pollSec,
    blockbook: cfg.blockbook,
  };
  return JSON.stringify(ordered);
}

/* ---------------- descriptor ---------------- */

/**
 * Forge a tamper-evident tip-jar descriptor: canonical config JSON ->
 * SHA-256 -> `tipjar:v1:<hrp>:<configHash>`. Returns
 * { descriptor, descriptorHash, config, configJson }.
 */
export function forgeTipjar(rawConfig) {
  const config = normalizeConfig(rawConfig);
  const configJson = canonicalConfigJSON(config);
  const configHash = sha256Hex(configJson);
  const descriptor = `tipjar:v1:${config.hrp}:${configHash}`;
  return {
    descriptor,
    descriptorHash: sha256Hex(descriptor),
    configHash,
    config,
    configJson,
  };
}

/** Parse a tipjar descriptor. Throws on any malformed field. */
export function parseDescriptor(s) {
  const t = String(s ?? "").trim();
  const m = t.match(DESCRIPTOR_RE);
  if (!m) throw new Error("not a tipjar descriptor — expected tipjar:v1:<hrp>:<64-hex config hash>");
  const [, hrp, configHash] = m;
  const network = Object.values(NETWORKS).find((n) => n.hrp === hrp);
  if (!network) throw new Error(`unknown network hrp "${hrp}"`);
  return { hrp, network, configHash, descriptor: t, descriptorHash: sha256Hex(t) };
}

/**
 * Verify a (config JSON, descriptor) pair. Re-canonicalizes the config,
 * re-hashes, and compares. Returns { ok: true, ... } on match.
 * LOUDLY REFUSES (throws) on any mismatch or malformed input.
 */
export function verifyTipjar({ configJson, descriptor }) {
  const d = parseDescriptor(descriptor);
  let raw;
  try {
    raw = JSON.parse(String(configJson ?? ""));
  } catch {
    throw new Error("⛔ TIPJAR VERIFY REFUSED — config is not valid JSON");
  }
  let config;
  try {
    config = normalizeConfig(raw);
  } catch (e) {
    throw new Error(`⛔ TIPJAR VERIFY REFUSED — config is invalid: ${e.message}`);
  }
  if (config.hrp !== d.hrp) {
    throw new Error(`⛔ TIPJAR VERIFY REFUSED — descriptor is for hrp "${d.hrp}" but the config address is "${config.hrp}1…"`);
  }
  const recomputed = sha256Hex(canonicalConfigJSON(config));
  if (recomputed !== d.configHash) {
    throw new Error(
      `⛔ TIPJAR VERIFY REFUSED — descriptor does not match this config. ` +
      `Descriptor commits to ${d.configHash.slice(0, 16)}…, this config hashes to ${recomputed.slice(0, 16)}…. ` +
      `The config was altered after the descriptor was forged.`
    );
  }
  return { ok: true, descriptor: d.descriptor, configHash: d.configHash, config };
}

/* ---------------- blockbook polling ---------------- */

function defaultFetcher(url, signal) {
  return fetch(url, { signal }).then((res) => {
    if (!res.ok) {
      // Blockbook returns 404 for never-seen addresses — treat as no activity.
      if (res.status === 404) return { txs: 0, transactions: [] };
      throw new Error(`blockbook ${res.status} on ${url}`);
    }
    return res.json();
  });
}

/**
 * GET-only read of tip activity: GET {base}/api/v2/address/<addr>?details=txs.
 * Returns { txs: [{ txid, confirmations, vout }], txCount, totalReceived }.
 * fetcher(url, signal) -> parsed JSON; inject a stub in tests.
 */
export async function fetchTipActivity(fetcher, blockbookBase, address, pageSize = 25, signal) {
  const base = String(blockbookBase).replace(/\/$/, "");
  const f = fetcher || defaultFetcher;
  const r = await f(`${base}/api/v2/address/${encodeURIComponent(address)}?details=txs&pageSize=${pageSize}`, signal);
  const txs = Array.isArray(r && r.transactions) ? r.transactions : [];
  let totalReceived = null;
  if (r && r.totalReceived != null) {
    try {
      totalReceived = BigInt(r.totalReceived);
    } catch {
      throw new Error("blockbook returned a non-integer totalReceived");
    }
  }
  return {
    txs: txs.map((t) => ({
      txid: String(t.txid || ""),
      confirmations: Number(t.confirmations || 0),
      vout: Array.isArray(t.vout) ? t.vout : [],
    })),
    txCount: Number((r && r.txs) || 0),
    totalReceived,
  };
}

/** Sum of vout values (grains, BigInt) paying the watched address in one tx. */
export function extractReceived(tx, address) {
  let sum = 0n;
  for (const o of tx.vout || []) {
    const addrs = o.addresses || (o.scriptPubKey && o.scriptPubKey.addresses) || [];
    if (!addrs.includes(address)) continue;
    try {
      const v = BigInt(o.value != null ? o.value : 0);
      if (v > 0n) sum += v;
    } catch {
      throw new Error(`blockbook returned a non-integer vout value in tx ${tx.txid}`);
    }
  }
  return sum;
}

/**
 * Diff fetched txs against previously-seen txids.
 * New-tip detection = txids not seen before (tracked in page memory).
 * Only counts: confirmations >= 1, received >= TIP_DUST_FLOOR.
 * Returns { tips: [{txid, grains, confirmations}], ignoredDust, seen }.
 */
export function detectNewTips(seen, fetchedTxs, address) {
  const seenSet = new Set(seen || []);
  const tips = [];
  let ignoredDust = 0;
  for (const tx of fetchedTxs || []) {
    if (!tx.txid || seenSet.has(tx.txid)) continue;
    seenSet.add(tx.txid);
    if (tx.confirmations < 1) continue; // 0-conf mempool txs are not counted as tips
    const grains = extractReceived(tx, address);
    if (grains <= 0n) continue;
    if (grains < TIP_DUST_FLOOR) { ignoredDust++; continue; }
    tips.push({ txid: tx.txid, grains, confirmations: tx.confirmations });
  }
  return { tips, ignoredDust, seen: [...seenSet] };
}

/** Sum of tip grains (BigInt). */
export function sumTips(tips) {
  return (tips || []).reduce((a, t) => a + t.grains, 0n);
}

/** Goal progress: { pct (0–100, 2dp), filled, goal } — goal null → pct null. */
export function goalProgress(totalGrains, goalGrains) {
  if (goalGrains == null) return { pct: null, filled: totalGrains, goal: null };
  const g = typeof goalGrains === "bigint" ? goalGrains : BigInt(goalGrains);
  if (g <= 0n) throw new Error("goal must be positive");
  const pct = totalGrains >= g ? 100 : Number((totalGrains * 10000n) / g) / 100;
  return { pct, filled: totalGrains, goal: g };
}

/* ---------------- CSV export ---------------- */

const TIPS_CSV_HEADER = "txid,received_grains,received_prl,confirmations";

/** CSV of detected tips. */
export function tipsToCsv(tips) {
  const lines = [TIPS_CSV_HEADER];
  for (const t of tips || []) {
    lines.push([t.txid, t.grains.toString(), formatPrl(t.grains), t.confirmations].join(","));
  }
  return lines.join("\n") + "\n";
}

/* ---------------- embed snippet ---------------- */

/**
 * The self-contained widget runtime. Written as a real function and
 * serialized with .toString() so the generator page (via the bundle) and
 * the copy-paste snippet share byte-identical logic.
 *
 * mount(root, config): config = { address, title, presets:[PRL decimal strings],
 * goal:PRL decimal string|null, theme, pollSec, blockbook, qr:{prlStr| "": svg} }.
 * GET-only Blockbook polling; read-only, never moves funds.
 */
function pearlTipjarWidget(root, config) {
  "use strict";
  var THEME_VARS = {
    "harbor-lantern": {
      "--ptj-bg": "#0b0f1c", "--ptj-panel": "#101828", "--ptj-line": "#2a2f45",
      "--ptj-text": "#f4ecd9", "--ptj-dim": "#a99f86", "--ptj-accent": "#ffb454",
      "--ptj-accent2": "#ffdf9e", "--ptj-glow": "rgba(255,180,84,.55)",
      "--ptj-fill1": "#ffdf9e", "--ptj-fill2": "#e08a2e", "--ptj-good": "#7dffa8",
      "--ptj-bad": "#ff8d8d", "--ptj-btn": "#1a2338"
    },
    "deep-abyss": {
      "--ptj-bg": "#050b16", "--ptj-panel": "#081222", "--ptj-line": "#16324a",
      "--ptj-text": "#dcf6ff", "--ptj-dim": "#7fa3b8", "--ptj-accent": "#4de3ff",
      "--ptj-accent2": "#a5f3d0", "--ptj-glow": "rgba(77,227,255,.5)",
      "--ptj-fill1": "#a5f3d0", "--ptj-fill2": "#1d9dbf", "--ptj-good": "#7dffce",
      "--ptj-bad": "#ff8d9e", "--ptj-btn": "#0c1c30"
    },
    "ember-forge": {
      "--ptj-bg": "#100607", "--ptj-panel": "#180b0c", "--ptj-line": "#3d1f22",
      "--ptj-text": "#ffe9e2", "--ptj-dim": "#b08d86", "--ptj-accent": "#ff5d49",
      "--ptj-accent2": "#ffb03c", "--ptj-glow": "rgba(255,93,73,.55)",
      "--ptj-fill1": "#ffb03c", "--ptj-fill2": "#c22e2e", "--ptj-good": "#8dff9e",
      "--ptj-bad": "#ff8dd0", "--ptj-btn": "#261114"
    }
  };
  var GRAIN = 100000000;
  var DUST = 1000;
  var theme = THEME_VARS[config.theme] ? config.theme : "harbor-lantern";
  var V = THEME_VARS[theme];

  function fmtP(g) {
    g = BigInt(g);
    var w = g / BigInt(GRAIN), f = g % BigInt(GRAIN);
    if (f === 0n) return w.toString();
    return w.toString() + "." + f.toString().padStart(8, "0").replace(/0+$/, "");
  }
  function prlToGrains(s) {
    var parts = String(s).split(".");
    return BigInt(parts[0]) * BigInt(GRAIN) + BigInt((parts[1] || "").padEnd(8, "0") || "0");
  }
  function shortAddr(a) { return a.length > 18 ? a.slice(0, 10) + "…" + a.slice(-6) : a; }

  // --- scoped styles (injected once per theme) ---
  var styleId = "pearl-tipjar-style-" + theme;
  if (!document.getElementById(styleId)) {
    var vars = Object.keys(V).map(function (k) { return k + ":" + V[k] + ";"; }).join("");
    var css =
      ".ptj{--x:0;" + vars + "background:var(--ptj-bg);color:var(--ptj-text);" +
      "border:1px solid var(--ptj-line);border-radius:16px;padding:18px;" +
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,sans-serif;" +
      "max-width:420px;position:relative;overflow:hidden;box-sizing:border-box;line-height:1.45}" +
      ".ptj *{box-sizing:border-box}" +
      ".ptj h3{margin:0 0 2px;font-size:1.15rem;letter-spacing:.02em}" +
      ".ptj .ptj-sub{color:var(--ptj-dim);font-size:.8rem;margin:0 0 12px}" +
      ".ptj .ptj-jarwrap{display:flex;gap:14px;align-items:stretch}" +
      ".ptj .ptj-jar{position:relative;width:110px;min-height:190px;flex:0 0 110px;" +
      "border:2px solid var(--ptj-line);border-top-width:6px;border-radius:14px 14px 22px 22px;" +
      "background:linear-gradient(180deg,rgba(255,255,255,.05),rgba(255,255,255,.01));overflow:hidden}" +
      ".ptj .ptj-fill{position:absolute;left:0;right:0;bottom:0;height:0%;" +
      "background:linear-gradient(180deg,var(--ptj-fill1),var(--ptj-fill2));" +
      "box-shadow:0 0 24px var(--ptj-glow);transition:height 1.2s ease}" +
      ".ptj .ptj-grain{position:absolute;width:7px;height:7px;border-radius:50%;" +
      "background:var(--ptj-accent2);box-shadow:0 0 8px var(--ptj-glow);opacity:.9;" +
      "animation:ptj-float 5s ease-in-out infinite}" +
      "@keyframes ptj-float{0%,100%{transform:translateY(0)}50%{transform:translateY(-9px)}}" +
      ".ptj .ptj-side{flex:1;min-width:0}" +
      ".ptj .ptj-total{font-size:1.5rem;font-weight:700;color:var(--ptj-accent2)}" +
      ".ptj .ptj-goalbar{height:10px;border-radius:99px;background:rgba(255,255,255,.08);" +
      "margin:8px 0 4px;overflow:hidden}" +
      ".ptj .ptj-goalbar i{display:block;height:100%;width:0%;border-radius:99px;" +
      "background:linear-gradient(90deg,var(--ptj-fill2),var(--ptj-fill1));" +
      "box-shadow:0 0 12px var(--ptj-glow);transition:width 1.2s ease}" +
      ".ptj .ptj-goaltext{font-size:.78rem;color:var(--ptj-dim)}" +
      ".ptj .ptj-presets{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}" +
      ".ptj .ptj-presets button{border:1px solid var(--ptj-line);background:var(--ptj-btn);" +
      "color:var(--ptj-text);border-radius:10px;padding:8px 12px;cursor:pointer;font-size:.85rem}" +
      ".ptj .ptj-presets button.on{border-color:var(--ptj-accent);color:var(--ptj-accent2);" +
      "box-shadow:0 0 12px var(--ptj-glow)}" +
      ".ptj .ptj-pay{display:flex;gap:12px;align-items:center;margin:6px 0 4px}" +
      ".ptj .ptj-qr{width:96px;height:96px;flex:0 0 96px;background:#fff;border-radius:10px;padding:4px}" +
      ".ptj .ptj-qr svg{width:100%;height:100%;display:block}" +
      ".ptj .ptj-uri{font-size:.72rem;word-break:break-all;color:var(--ptj-dim)}" +
      ".ptj .ptj-uri a{color:var(--ptj-accent2)}" +
      ".ptj .ptj-feed{margin:10px 0 0;padding:0;list-style:none;max-height:150px;overflow:auto}" +
      ".ptj .ptj-feed li{font-size:.78rem;padding:6px 8px;border:1px solid var(--ptj-line);" +
      "border-radius:8px;margin-bottom:6px;display:flex;justify-content:space-between;gap:8px;" +
      "animation:ptj-in .5s ease}" +
      "@keyframes ptj-in{from{transform:translateY(-8px);opacity:0}to{transform:none;opacity:1}}" +
      ".ptj .ptj-feed .tx{font-family:ui-monospace,Menlo,Consolas,monospace;color:var(--ptj-dim)}" +
      ".ptj .ptj-feed .amt{color:var(--ptj-good);font-weight:600;white-space:nowrap}" +
      ".ptj .ptj-status{font-size:.72rem;color:var(--ptj-dim);margin-top:10px}" +
      ".ptj .ptj-err{color:var(--ptj-bad);font-size:.75rem;margin-top:6px}" +
      ".ptj .ptj-fine{font-size:.68rem;color:var(--ptj-dim);opacity:.75;margin-top:8px}" +
      ".ptj .ptj-confetti{position:absolute;width:8px;height:12px;top:38%;left:50%;pointer-events:none;z-index:5}";
    var st = document.createElement("style");
    st.id = styleId;
    st.textContent = css;
    document.head.appendChild(st);
  }

  // --- shell ---
  root.classList.add("ptj");
  root.innerHTML =
    "<h3></h3><p class='ptj-sub'></p>" +
    "<div class='ptj-jarwrap'><div class='ptj-jar'><div class='ptj-fill'></div><div class='ptj-graindot'></div></div>" +
    "<div class='ptj-side'><div class='ptj-total'>0 PRL</div>" +
    "<div class='ptj-goalbar'><i></i></div><div class='ptj-goaltext'></div>" +
    "<div class='ptj-presets'></div></div></div>" +
    "<div class='ptj-pay'><div class='ptj-qr'></div><div class='ptj-uri'></div></div>" +
    "<ul class='ptj-feed'></ul>" +
    "<div class='ptj-status'>starting…</div><div class='ptj-err' hidden></div>" +
    "<div class='ptj-fine'>Read-only widget — it watches the chain and never moves funds. Tips count at 1+ confirmations.</div>";
  var q = function (s) { return root.querySelector(s); };
  q("h3").textContent = config.title;
  q(".ptj-sub").textContent = "tipping " + shortAddr(config.address);

  // floating grains inside the jar
  var dotBox = q(".ptj-graindot");
  for (var gi = 0; gi < 14; gi++) {
    var d = document.createElement("div");
    d.className = "ptj-grain";
    d.style.left = (6 + Math.random() * 88) + "px";
    d.style.bottom = (8 + Math.random() * 150) + "px";
    d.style.animationDelay = (Math.random() * 5).toFixed(2) + "s";
    d.style.opacity = "0.15";
    dotBox.appendChild(d);
  }

  var state = { seen: [], tips: [], total: 0n, active: config.presets[0], timer: null, stopped: false };
  var goal = config.goal == null ? null : prlToGrains(config.goal);

  function confettiBurst() {
    var palette = [V["--ptj-accent"], V["--ptj-accent2"], V["--ptj-good"], "#ffffff"];
    for (var i = 0; i < 28; i++) {
      var c = document.createElement("div");
      c.className = "ptj-confetti";
      c.style.background = palette[i % palette.length];
      c.style.transform = "rotate(" + Math.floor(Math.random() * 360) + "deg)";
      root.appendChild(c);
      var dx = (Math.random() - 0.5) * 320, dy = -60 - Math.random() * 200;
      var anim = c.animate(
        [{ transform: "translate(0,0) rotate(0deg)", opacity: 1 },
         { transform: "translate(" + dx + "px," + dy + "px) rotate(" + (360 + Math.random() * 360) + "deg)", opacity: 0 }],
        { duration: 900 + Math.random() * 900, easing: "cubic-bezier(.2,.7,.3,1)" }
      );
      (function (el) { anim.onfinish = function () { el.remove(); }; })(c);
    }
  }

  function render() {
    q(".ptj-total").textContent = fmtP(state.total) + " PRL";
    var denom = goal != null ? goal : state.total > 0n ? state.total : prlToGrains(config.presets[config.presets.length - 1]) * 4n;
    var pct = denom > 0n ? Number((state.total * 10000n) / denom) / 100 : 0;
    if (pct > 100) pct = 100;
    q(".ptj-fill").style.height = pct.toFixed(2) + "%";
    q(".ptj-goalbar i").style.width = pct.toFixed(2) + "%";
    q(".ptj-goaltext").textContent = goal != null
      ? fmtP(state.total) + " / " + fmtP(goal) + " PRL goal (" + pct.toFixed(1) + "%)"
      : state.tips.length + (state.tips.length === 1 ? " tip" : " tips") + " received";
    var dots = dotBox.children;
    for (var i = 0; i < dots.length; i++) dots[i].style.opacity = (0.15 + (pct / 100) * 0.85).toFixed(2);
  }

  function renderPay() {
    var g = state.active;
    var uri = "pearl:" + config.address + "?amount=" + g;
    q(".ptj-qr").innerHTML = (config.qr && (config.qr[g] || config.qr[""])) || "";
    q(".ptj-uri").innerHTML = "";
    var a = document.createElement("a");
    a.href = uri;
    a.textContent = uri.length > 64 ? uri.slice(0, 60) + "…" : uri;
    var label = document.createElement("div");
    label.textContent = "Scan or tap to tip " + g + " PRL:";
    q(".ptj-uri").appendChild(label);
    q(".ptj-uri").appendChild(a);
    var btns = root.querySelectorAll(".ptj-presets button");
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle("on", btns[i].getAttribute("data-g") === g);
    }
  }

  function addFeedRow(tip) {
    var li = document.createElement("li");
    var tx = document.createElement("span");
    tx.className = "tx";
    tx.textContent = tip.txid.slice(0, 12) + "…" + tip.txid.slice(-6);
    tx.title = tip.txid;
    var amt = document.createElement("span");
    amt.className = "amt";
    amt.textContent = "+" + fmtP(tip.grains) + " PRL";
    li.appendChild(tx);
    li.appendChild(amt);
    var feed = q(".ptj-feed");
    feed.insertBefore(li, feed.firstChild);
    while (feed.children.length > 20) feed.removeChild(feed.lastChild);
  }

  function poll() {
    if (state.stopped || document.hidden) return;
    var url = config.blockbook.replace(/\/$/, "") +
      "/api/v2/address/" + encodeURIComponent(config.address) + "?details=txs&pageSize=25";
    fetch(url, { cache: "no-store" }).then(function (res) {
      if (!res.ok) {
        if (res.status === 404) return { transactions: [] };
        throw new Error("blockbook " + res.status);
      }
      return res.json();
    }).then(function (data) {
      var txs = Array.isArray(data.transactions) ? data.transactions : [];
      var fresh = 0;
      for (var i = txs.length - 1; i >= 0; i--) {
        var t = txs[i];
        var txid = String(t.txid || "");
        if (!txid || state.seen.indexOf(txid) !== -1) continue;
        state.seen.push(txid);
        if (Number(t.confirmations || 0) < 1) continue;
        var sum = 0n;
        var vouts = Array.isArray(t.vout) ? t.vout : [];
        for (var j = 0; j < vouts.length; j++) {
          var o = vouts[j];
          var addrs = o.addresses || (o.scriptPubKey && o.scriptPubKey.addresses) || [];
          if (addrs.indexOf(config.address) === -1) continue;
          try { var v = BigInt(o.value != null ? o.value : 0); if (v > 0n) sum += v; } catch (e) { /* skip bad values */ }
        }
        if (sum <= 0n || sum < BigInt(DUST)) continue; // dust is not counted as a tip
        state.tips.push({ txid: txid, grains: sum, confirmations: Number(t.confirmations || 0) });
        state.total += sum;
        addFeedRow(state.tips[state.tips.length - 1]);
        fresh++;
      }
      if (fresh > 0) {
        // First successful poll is the baseline: show history, no confetti.
        // Only tips arriving AFTER the baseline get the confetti burst.
        if (state.baselined) confettiBurst();
        render();
      }
      state.baselined = true;
      var err = q(".ptj-err");
      err.hidden = true;
      q(".ptj-status").textContent = "watching " + shortAddr(config.address) +
        " · poll " + config.pollSec + "s · last check " + new Date().toLocaleTimeString() +
        " · " + state.tips.length + " tip" + (state.tips.length === 1 ? "" : "s");
    }).catch(function (e) {
      var err = q(".ptj-err");
      err.hidden = false;
      err.textContent = "poll failed (" + (e && e.message ? e.message : e) + ") — retrying on schedule";
    });
  }

  // preset buttons
  var pw = q(".ptj-presets");
  config.presets.forEach(function (g) {
    var b = document.createElement("button");
    b.type = "button";
    b.setAttribute("data-g", g);
    b.textContent = g + " PRL";
    b.addEventListener("click", function () { state.active = g; renderPay(); });
    pw.appendChild(b);
  });

  renderPay();
  render();
  poll();
  state.timer = setInterval(poll, config.pollSec * 1000);
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && !state.stopped) poll();
  });

  root._pearlTipjar = {
    tips: function () { return state.tips.slice(); },
    totalGrains: function () { return state.total; },
    seen: function () { return state.seen.slice(); },
    stop: function () { state.stopped = true; if (state.timer) clearInterval(state.timer); },
    config: config,
  };
}

/** Serialized widget runtime — byte-identical logic for the snippet and the page preview. */
export const WIDGET_RUNTIME = pearlTipjarWidget.toString();

/**
 * Build the copy-paste embed block. configWithQr = normalized config plus
 * qr: { "<presetGrains>": "<svg>", "": "<svg for plain address>" }.
 * Returns the full HTML string: mount div + JSON config block + inline script.
 * Self-contained: no external deps except the Blockbook base URL in config.
 */
export function buildEmbedSnippet(configWithQr) {
  const cfg = { ...configWithQr };
  if (!cfg.qr || typeof cfg.qr !== "object") throw new Error("snippet needs pre-rendered QR art (config.qr)");
  if (!THEMES[cfg.theme]) throw new Error(`unknown theme "${cfg.theme}"`);
  const id = "ptj-" + sha256Hex(cfg.address + "|" + cfg.title).slice(0, 10);
  const json = JSON.stringify(cfg).replace(/<\//g, "<\\/");
  return (
    `<!-- Pearl Tipjar v1 — paste this block anywhere on your site.\n` +
    `     Self-contained: no external JS/CSS. Polls your Blockbook (GET-only)\n` +
    `     every ${cfg.pollSec}s for tips to ${cfg.address}. Read-only: never moves funds.\n` +
    `     Descriptor: tipjar:v1:${cfg.hrp}:${sha256Hex(canonicalConfigJSON(cfg))} -->\n` +
    `<div id="${id}"></div>\n` +
    `<script type="application/json" id="${id}-config">${json}</` + `script>\n` +
    `<script>\n/* Pearl Tipjar v1 widget — do not edit. Regenerate at the Pearl Tipjar app. */\n` +
    `(function(){\n` +
    `  var cfgEl = document.currentScript.previousElementSibling;\n` +
    `  var mount = document.getElementById(cfgEl.id.replace(/-config$/, ""));\n` +
    `  var config = JSON.parse(cfgEl.textContent);\n` +
    `  (${WIDGET_RUNTIME})(mount, config);\n` +
    `})();\n` +
    `</` + `script>`
  );
}
