/* Pearl Charity UI — five-step wizard driving the real window.PearlCharity bundle.
 * The page never holds or moves funds: every chain read is GET-only Blockbook;
 * every donation happens in the donor's own wallet. Organizer keys live in
 * memory only and are wiped right after forging. Receipts live in
 * localStorage, keyed by campaign fingerprint (hash-bound records — the page
 * re-checks every hash on render).
 */
(function () {
  "use strict";
  const B = window.PearlCharity;
  const $ = (id) => {
    const el = document.getElementById(id);
    if (!el) throw new Error("missing element #" + id);
    return el;
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const setErr = (id, msg) => { $(id).textContent = msg || ""; };
  const short = (s, a = 16, b = 10) => (s && s.length > a + b + 1 ? s.slice(0, a) + "…" + s.slice(-b) : s);
  const prl = (g) => B.fmtPRL(g);
  const bbBaseFor = (net, override) => {
    const o = String(override || "").trim().replace(/\/$/, "");
    if (o) return o;
    if (net.id === "testnet") throw new Error("no public testnet Blockbook is configured — enter a base URL (e.g. your own Blockbook) to check testnet donations");
    return B.BLOCKBOOK_MAINNET;
  };

  let campaign = null; // loaded campaign spec (shared across steps)
  let network = null;
  let launchTip = null;

  /* ---------- step nav ---------- */
  document.querySelectorAll("#steps button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#steps button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      document.querySelectorAll("main .panel").forEach((p) => p.classList.remove("active"));
      $("step-" + btn.dataset.step).classList.add("active");
    });
  });
  const goto = (step) => document.querySelector(`#steps button[data-step="${step}"]`).click();

  const fanOut = (specText, descText, address) => {
    for (const id of ["f-spec", "r-spec", "t-spec", "v-spec"]) $(id).value = specText;
    $("v-descriptor").value = descText;
    if (address) $("v-address").value = address;
  };

  function loadCampaign(specText, net) {
    const t = String(specText || "").trim();
    if (!t) throw new Error("paste the campaign spec first");
    return B.parseCampaignSpec(t, net);
  }

  async function copyText(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
      const old = btn.textContent;
      btn.textContent = "Copied ✓";
      setTimeout(() => { btn.textContent = old; }, 1200);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } catch {}
      ta.remove();
    }
  }

  function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime || "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  /* ---------- localStorage: receipt ledger (hash-bound records) ---------- */
  const LEDGER_KEY = "pearl-charity-receipts:v1";
  function readLedger() {
    try {
      const raw = localStorage.getItem(LEDGER_KEY);
      const j = raw ? JSON.parse(raw) : {};
      return (j && typeof j === "object") ? j : {};
    } catch { return {}; }
  }
  function writeLedger(l) {
    try { localStorage.setItem(LEDGER_KEY, JSON.stringify(l)); } catch {}
  }
  function receiptsFor(fp) {
    const l = readLedger();
    const rows = l[fp];
    return Array.isArray(rows) ? rows : [];
  }
  function addReceipt(r) {
    const l = readLedger();
    const rows = receiptsFor(r.campaignFingerprint);
    rows.push(r);
    l[r.campaignFingerprint] = rows;
    writeLedger(l);
  }
  function deleteReceipt(fp, idx) {
    const l = readLedger();
    const rows = receiptsFor(fp);
    rows.splice(idx, 1);
    l[fp] = rows;
    writeLedger(l);
  }

  /* ---------- 1 · LAUNCH ---------- */
  $("l-mode").addEventListener("change", () => {
    $("l-keywrap").classList.toggle("hidden", $("l-mode").value !== "sign");
  });

  $("l-gettip").addEventListener("click", async () => {
    setErr("l-err");
    try {
      const net = B.NETWORKS[$("l-network").value];
      launchTip = await B.fetchTipHeight(bbBaseFor(net, ""));
      $("l-tipinfo").textContent = `tip ${launchTip}`;
    } catch (e) {
      launchTip = null;
      $("l-tipinfo").textContent = "tip unavailable";
      setErr("l-err", e.message);
    }
  });

  $("l-forge").addEventListener("click", () => {
    setErr("l-err");
    try {
      const net = B.NETWORKS[$("l-network").value];
      const dlRaw = $("l-deadline").value.trim();
      const deadline = dlRaw === "" ? null : Number(dlRaw);
      if (deadline !== null && launchTip !== null && deadline <= launchTip) {
        throw new Error(`deadline ${deadline} is not in the future (tip ${launchTip}) — pick a height past the current tip`);
      }
      const { campaign: c, secret } = B.forgeCampaign({
        network: net,
        orgName: $("l-org").value,
        recipient: $("l-recipient").value,
        goalPRL: $("l-goal").value,
        deadlineHeight: deadline,
        description: $("l-desc").value,
        contact: $("l-contact").value,
        orgKeyInput: $("l-key").value,
        orgSignMode: $("l-mode").value,
      });
      // The organizer key dies with this handler — never retained, never stored.
      if (secret) secret.priv = "0".repeat(64);
      $("l-key").value = "";
      campaign = c; network = net;
      const spec = B.serializeCampaign(c);
      $("l-address").value = c.recipient;
      $("l-descriptor").value = c.descriptor;
      $("l-fp").textContent = c.fingerprint;
      $("l-spec").value = spec;
      $("l-authnote").innerHTML = c.orgSigHex
        ? `Organizer authorship: signed by x-only key <code>${esc(c.orgXOnly)}</code> (BIP-340, self-verified at forge). Key wiped from this page.`
        : "Organizer authorship: unsigned — anyone can verify the campaign text, but no key vouches for it.";
      $("l-checklist").innerHTML = [
        `Share the donation address <code>${esc(c.recipient)}</code> with donors.`,
        "Publish the descriptor + spec where donors gather (the spec re-derives the descriptor — publish both).",
        "Before donating, anyone can run step 5 Verify: the claimed address must match the descriptor, or it refuses loudly.",
        "Receipts are issued on step 3 after donations confirm.",
      ].map((x) => `<li>${x}</li>`).join("");
      $("l-summary").innerHTML =
        `Forged <b>${esc(c.orgName)}</b> — goal <b>${esc(c.goalPRL)} PRL</b>` +
        (c.deadlineHeight !== null ? `, deadline at height <b>${c.deadlineHeight}</b>` : ", no deadline") +
        `. Fingerprint <code>${esc(c.fingerprint)}</code>. Funds go straight to the charity address; this page never touches them.`;
      $("l-out").classList.remove("hidden");
      fanOut(spec, c.descriptor, c.recipient);
    } catch (e) { setErr("l-err", e.message); }
  });
  $("l-copyaddr").addEventListener("click", (e) => copyText($("l-address").value, e.target));
  $("l-copydesc").addEventListener("click", (e) => copyText($("l-descriptor").value, e.target));
  $("l-copyspec").addEventListener("click", (e) => copyText($("l-spec").value, e.target));
  $("l-gofund").addEventListener("click", () => goto("fund"));

  /* ---------- donations table ---------- */
  function renderDonations(tableId, donations) {
    const tb = $(tableId).querySelector("tbody");
    tb.innerHTML = "";
    for (const d of donations) {
      const tr = document.createElement("tr");
      tr.innerHTML =
        `<td class="mono">${esc(short(d.txid))}</td>` +
        `<td>${esc(prl(d.valueGrains))}</td>` +
        `<td>${d.blockHeight >= 0 ? d.blockHeight : "<em>unconfirmed</em>"}</td>` +
        `<td>${d.confirmations}</td>`;
      tb.appendChild(tr);
    }
    $(tableId).classList.toggle("hidden", donations.length === 0);
  }

  async function statsAndClassify(c, net, bbOverride, donationsOverride) {
    let stats, tip = null, offline = false;
    if (donationsOverride) {
      let received = 0;
      for (const d of donationsOverride) received += d.valueGrains;
      stats = { address: c.recipient, receivedGrains: received, txCount: donationsOverride.length, donations: donationsOverride };
      offline = true;
    } else {
      const base = bbBaseFor(net, bbOverride);
      stats = await B.fetchCampaignStats(base, c.recipient);
      try { tip = await B.fetchTipHeight(base); } catch { tip = null; }
    }
    const cls = B.classifyCampaign(c, stats, tip);
    return { stats, tip, cls, offline };
  }

  /* ---------- 2 · FUND ---------- */
  $("f-load").addEventListener("click", () => {
    setErr("f-err");
    try {
      const parsed = JSON.parse($("f-spec").value);
      const n = B.NETWORKS[parsed.network] || B.NETWORKS.mainnet;
      campaign = loadCampaign($("f-spec").value, n); network = n;
      $("f-address").value = campaign.recipient;
      $("f-out").classList.remove("hidden");
    } catch (e) { setErr("f-err", e.message); }
  });

  $("f-check").addEventListener("click", async () => {
    setErr("f-err");
    try {
      if (!campaign) throw new Error("load the campaign first");
      const { stats, tip, cls } = await statsAndClassify(campaign, network, $("f-bburl").value, null);
      renderDonations("f-table", stats.donations);
      $("f-meta").innerHTML =
        `<b>Status: ${esc(cls.status)}</b> — ${esc(cls.detail)}. ` +
        `Raised <b>${esc(prl(cls.raisedGrains))} PRL</b> of ${esc(campaign.goalPRL)} PRL. ` +
        (tip !== null ? `Chain tip ${tip}. ` : "Chain tip unavailable — classification ran without a tip. ") +
        (stats.donations.some((d) => d.blockHeight < 0) ? "<em>Some donations are unconfirmed.</em>" : "");
    } catch (e) { setErr("f-err", e.message); }
  });

  $("f-airload").addEventListener("click", () => {
    setErr("f-err");
    try {
      if (!campaign) throw new Error("load the campaign first");
      let arr;
      try { arr = JSON.parse($("f-airtx").value); } catch { throw new Error("donation records are not valid JSON"); }
      if (!Array.isArray(arr) || arr.length === 0) throw new Error("paste a non-empty JSON array of donation records");
      const donations = arr.map((d, i) => {
        const txid = String(d.txid || "").trim().toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(txid)) throw new Error(`record ${i}: txid must be 64 hex chars`);
        const v = Number(d.valueGrains);
        if (!Number.isSafeInteger(v) || v <= 0) throw new Error(`record ${i}: valueGrains must be a positive integer`);
        const bh = d.blockHeight === undefined || d.blockHeight === null ? -1 : Number(d.blockHeight);
        if (!Number.isSafeInteger(bh)) throw new Error(`record ${i}: bad blockHeight`);
        return { txid, valueGrains: v, blockHeight: bh, confirmations: 0 };
      });
      statsAndClassify(campaign, network, null, donations).then(({ stats, cls }) => {
        renderDonations("f-table", stats.donations);
        $("f-meta").innerHTML =
          `<b>Status: ${esc(cls.status)}</b> — ${esc(cls.detail)}. ` +
          `Raised <b>${esc(prl(cls.raisedGrains))} PRL</b> of ${esc(campaign.goalPRL)} PRL. ` +
          "<em>Computed from your manually pasted records — NOT verified against the chain.</em>";
      });
    } catch (e) { setErr("f-err", e.message); }
  });
  $("f-goreceipts").addEventListener("click", () => goto("receipts"));

  /* ---------- 3 · RECEIPTS ---------- */
  $("r-load").addEventListener("click", () => {
    setErr("r-err");
    try {
      const parsed = JSON.parse($("r-spec").value);
      const n = B.NETWORKS[parsed.network] || B.NETWORKS.mainnet;
      campaign = loadCampaign($("r-spec").value, n); network = n;
      $("r-out").classList.remove("hidden");
      renderReceipts();
    } catch (e) { setErr("r-err", e.message); }
  });

  $("r-add").addEventListener("click", () => {
    setErr("r-err");
    try {
      if (!campaign) throw new Error("load the campaign first");
      const r = B.recordReceipt({
        campaign,
        donor: $("r-donor").value,
        txid: $("r-txid").value,
        amountPRL: $("r-amount").value,
        blockHeight: $("r-height").value.trim() === "" ? null : $("r-height").value.trim(),
      });
      addReceipt(r);
      $("r-txid").value = ""; $("r-amount").value = ""; $("r-height").value = "";
      renderReceipts();
    } catch (e) { setErr("r-err", e.message); }
  });

  function renderReceipts() {
    if (!campaign) return;
    const rows = receiptsFor(campaign.fingerprint);
    const tb = $("r-table").querySelector("tbody");
    tb.innerHTML = "";
    let total = 0;
    rows.forEach((r, i) => {
      total += r.amountGrains;
      let ok = false;
      try { ok = B.verifyReceiptHash(r); } catch { ok = false; }
      const tr = document.createElement("tr");
      tr.innerHTML =
        `<td>${esc(r.donor)}</td>` +
        `<td>${esc(r.amountPRL)}</td>` +
        `<td class="mono">${esc(short(r.txid))}</td>` +
        `<td class="${ok ? "ok" : "bad"}">${ok ? "✓" : "✗ TAMPERED"}</td>` +
        `<td><button data-del="${i}" class="danger">Delete</button></td>`;
      tb.appendChild(tr);
    });
    tb.querySelectorAll("button[data-del]").forEach((btn) => {
      btn.addEventListener("click", () => {
        deleteReceipt(campaign.fingerprint, Number(btn.dataset.del));
        renderReceipts();
      });
    });
    const donors = B.countDonors(rows);
    $("r-total").innerHTML =
      `<b>${rows.length}</b> receipt(s) · <b>${donors}</b> donor(s) · total <b>${esc(prl(total))} PRL</b>` +
      (rows.some((r) => { try { return !B.verifyReceiptHash(r); } catch { return true; }; })
        ? ' · <span class="bad">⚠ a record failed its hash check — do not trust it</span>' : "");
  }

  const ledgerCSV = () => {
    const rows = receiptsFor(campaign.fingerprint);
    // Spreadsheet formula-injection guard (CWE-1236): a cell whose text
    // begins (after optional spaces) with =, +, -, @, | or % is executed
    // as a formula in Excel/Sheets — quoting does NOT prevent it. Prefix
    // such cells with an apostrophe; plain numbers pass untouched.
    const q = (s) => {
      let v = String(s);
      if (!/^-?\d+(\.\d+)?$/.test(v) && /^\s*[=+\-@|%]/.test(v)) v = "'" + v;
      return `"${v.replace(/"/g, '""')}"`;
    };
    return ["donor,amountPRL,amountGrains,txid,blockHeight,recordedAt,hash",
      ...rows.map((r) => [q(r.donor), q(r.amountPRL), r.amountGrains, q(r.txid), r.blockHeight === null ? "" : r.blockHeight, q(r.recordedAt), q(r.hash)].join(","))].join("\n");
  };
  $("r-exportcsv").addEventListener("click", () => {
    if (!campaign) return setErr("r-err", "load the campaign first");
    download(`pearl-charity-receipts-${campaign.fingerprint}.csv`, ledgerCSV(), "text/csv");
  });
  $("r-exportjson").addEventListener("click", () => {
    if (!campaign) return setErr("r-err", "load the campaign first");
    download(`pearl-charity-receipts-${campaign.fingerprint}.json`,
      JSON.stringify({ campaign: campaign.descriptor, receipts: receiptsFor(campaign.fingerprint) }, null, 2),
      "application/json");
  });
  $("r-print").addEventListener("click", () => {
    if (!campaign) return setErr("r-err", "load the campaign first");
    const rows = receiptsFor(campaign.fingerprint);
    if (!rows.length) return setErr("r-err", "no receipts to print");
    $("r-printarea").innerHTML =
      `<h1>Pearl Charity — Donor Receipts</h1>` +
      `<p>Campaign: ${esc(campaign.orgName)} · fingerprint <code>${esc(campaign.fingerprint)}</code><br>` +
      `Donation address: <code>${esc(campaign.recipient)}</code></p>` +
      rows.map((r) =>
        `<div class="receipt-card"><h3>Receipt — ${esc(r.donor)}</h3>` +
        `<p>Amount: <b>${esc(r.amountPRL)} PRL</b><br>txid: <code>${esc(r.txid)}</code><br>` +
        (r.blockHeight !== null ? `Block: ${r.blockHeight}<br>` : "") +
        `Recorded: ${esc(r.recordedAt)}<br>Hash: <code>${esc(r.hash)}</code></p></div>`
      ).join("") +
      `<p class="dim">Hash-bound records — recompute the hash to verify. Donor names are self-declared.</p>`;
    window.print();
  });
  $("r-clear").addEventListener("click", () => {
    if (!campaign) return setErr("r-err", "load the campaign first");
    if (!window.confirm("Delete ALL receipts for this campaign in this browser? Exported copies are unaffected.")) return;
    const l = readLedger();
    delete l[campaign.fingerprint];
    writeLedger(l);
    renderReceipts();
  });

  /* ---------- 4 · TRACK ---------- */
  const loadTrack = () => {
    const parsed = JSON.parse($("t-spec").value);
    const n = B.NETWORKS[parsed.network] || B.NETWORKS.mainnet;
    campaign = loadCampaign($("t-spec").value, n); network = n;
    $("t-out").classList.remove("hidden");
  };
  $("t-load").addEventListener("click", () => {
    setErr("t-err");
    try { loadTrack(); } catch (e) { setErr("t-err", e.message); }
  });
  $("t-refresh").addEventListener("click", async () => {
    setErr("t-err");
    try {
      if (!campaign) { loadTrack(); }
      const { stats, tip, cls } = await statsAndClassify(campaign, network, $("t-bburl").value, null);
      const pct = campaign.goalGrains > 0 ? Math.min(100, (cls.raisedGrains / campaign.goalGrains) * 100) : 0;
      $("t-bar").style.width = pct.toFixed(2) + "%";
      $("t-pct").innerHTML = `<b>${pct.toFixed(1)}%</b> of goal — ${esc(cls.detail)}`;
      $("t-raised").textContent = prl(cls.raisedGrains) + " PRL";
      $("t-goal").textContent = campaign.goalPRL + " PRL";
      $("t-donors").textContent = String(B.countDonors(receiptsFor(campaign.fingerprint)));
      $("t-deadline").textContent = campaign.deadlineHeight === null
        ? "none"
        : `height ${campaign.deadlineHeight} — ${cls.approxCountdown}`;
      renderDonations("t-table", stats.donations);
      $("t-meta").innerHTML =
        `Status <b>${esc(cls.status)}</b> · ${esc(stats.donations.length)} donation(s) on record · ` +
        (tip !== null ? `chain tip ${tip}` : "chain tip unavailable") +
        (campaign.orgSigHex ? " · campaign signed by organizer" : " · campaign unsigned");
    } catch (e) { setErr("t-err", e.message); }
  });

  /* ---------- 5 · VERIFY ---------- */
  $("v-verifydesc").addEventListener("click", () => {
    setErr("v-erra");
    try {
      const net = B.NETWORKS[$("v-network").value];
      const claimed = $("v-address").value.trim() === "" ? null : $("v-address").value.trim();
      const v = B.verifyDescriptor($("v-descriptor").value, net, claimed, $("v-spec").value);
      $("v-descout").innerHTML =
        `<span class="ok"><b>DESCRIPTOR VERIFIED</b></span> — the spec recomputes to this descriptor ` +
        `(fingerprint <code>${esc(v.fingerprint)}</code>), recipient <code>${esc(v.campaign.recipient)}</code> ` +
        (claimed ? "matches the claimed address — <b>safe to fund this address</b>" : "shown for inspection") +
        `. Authorship: <b>${esc(v.authorship)}</b>.` +
        (v.authorship === "unsigned" ? " <em>No organizer key vouches for this campaign — verify the organizer socially.</em>" : "");
    } catch (e) {
      $("v-descout").innerHTML = `<span class="bad"><b>REFUSED</b></span> — ${esc(e.message)}`;
    }
  });

  $("v-verifyreceipt").addEventListener("click", () => {
    setErr("v-errb");
    try {
      let r;
      try { r = JSON.parse($("v-receipt").value); } catch { throw new Error("receipt is not valid JSON"); }
      const ok = B.verifyReceiptHash(r);
      $("v-receiptout").innerHTML = ok
        ? `<span class="ok"><b>RECEIPT HASH MATCHES</b></span> — donor <b>${esc(r.donor)}</b>, ` +
          `<b>${esc(r.amountPRL)} PRL</b>, txid <code>${esc(r.txid)}</code>. ` +
          `<em>Hash check only: run the live cross-check to prove the donation exists on-chain.</em>`
        : `<span class="bad"><b>RECEIPT REFUSED</b></span> — the hash does not recompute. The record was altered; do not trust it.`;
    } catch (e) {
      $("v-receiptout").innerHTML = `<span class="bad"><b>RECEIPT REFUSED</b></span> — ${esc(e.message)}`;
    }
  });

  $("v-crosscheck").addEventListener("click", async () => {
    setErr("v-errb");
    try {
      let r;
      try { r = JSON.parse($("v-receipt").value); } catch { throw new Error("receipt is not valid JSON"); }
      const parsed = JSON.parse($("v-spec").value || "{}");
      const n = B.NETWORKS[parsed.network] || B.NETWORKS.mainnet;
      const c = loadCampaign($("v-spec").value, n);
      if (r.campaignFingerprint !== c.fingerprint) {
        throw new Error(`receipt binds campaign fingerprint ${r.campaignFingerprint}, but the spec is ${c.fingerprint} — wrong campaign`);
      }
      $("v-receiptout").textContent = "Checking Blockbook…";
      const base = bbBaseFor(n, $("v-bburl").value);
      const res = await B.crossCheckReceipt(base, r, c);
      $("v-receiptout").innerHTML =
        (res.proven
          ? `<span class="ok"><b>RECEIPT PROVEN</b></span>`
          : `<span class="bad"><b>RECEIPT NOT PROVEN</b></span>`) +
        "<ul>" + res.reasons.map((x) => `<li>${esc(x)}</li>`).join("") + "</ul>";
    } catch (e) {
      $("v-receiptout").innerHTML = `<span class="bad"><b>RECEIPT NOT PROVEN</b></span> — ${esc(e.message)}`;
    }
  });
})();
