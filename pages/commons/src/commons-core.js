// Pearl Commons — quadratic funding rounds desk, pure core logic.
// No DOM here: everything is importable in node tests and bundled for the page.
//
// Money math convention (documented, deterministic):
//   - All stored amounts are integer GRAINS (BigInt, serialized as decimal strings).
//   - Quadratic funding follows Buterin–Hitzig–Weyl liberal radicalism with a
//     capital constraint: for each project,
//         desired_p = (sum_i sqrt(c_i))^2 - sum_i c_i
//     where c_i is the TOTAL contributed by donor i to project p (multiple
//     contributions from the same donor label are aggregated first).
//   - The square-root leg is computed in floating point on PRL-denominated
//     values (well inside float64 exact range), then converted back to grains
//     with Math.floor. The floor dust is reported as `remainderGrains` and
//     stays in the matching pool. A single-donor project gets zero match —
//     that is the correct QF behavior (matching rewards breadth of support).
//   - Capital constraint: if total desired match exceeds the pool, every
//     project's match is scaled by k = pool / totalDesired and floored again;
//     the leftover is reported honestly as unallocated pool remainder.
// Cryptography: NONE new. Address validation + sha256 come from the audited
// Pearl Sign core (../sign/src/crypto.js), vendored @noble deps.

import {
  GRAIN_PER_PRL,
  DUST_GRAIN,
  NETWORKS,
  decodeBech32m,
  encodeBech32m,
  sha256,
  bytesToHex,
} from "../../sign/src/crypto.js";

export { GRAIN_PER_PRL, DUST_GRAIN, NETWORKS };

export const COMMONS_VERSION = 1;
export const ROUND_NAME_MIN = 3;
export const ROUND_NAME_MAX = 80;
export const PROJECT_NAME_MIN = 2;
export const PROJECT_NAME_MAX = 60;
export const DONOR_LABEL_MIN = 1;
export const DONOR_LABEL_MAX = 40;
export const DESC_MAX = 500;
export const MAX_PROJECTS_PER_ROUND = 64;
// Total PRL supply cap 2.1B (upstream tokenomics) — sanity ceiling for amounts.
export const MAX_SUPPLY_GRAINS = 2_100_000_000n * 100_000_000n;

const te = new TextEncoder();

/* ---------- canonical JSON + hashing ---------- */

export function canon(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return "[" + value.map(canon).join(",") + "]";
  if (typeof value === "object") {
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canon(value[k]))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value);
}

export function sha256HexText(s) {
  return bytesToHex(sha256(te.encode(String(s))));
}

/* ---------- PRL <-> grains ---------- */

/** Parse a human PRL amount string into integer grains (BigInt). Throws on junk. */
export function parsePRLtoGrains(input) {
  const s = String(input ?? "").trim();
  if (!/^\d+(\.\d{1,8})?$/.test(s)) {
    throw new Error("Amount must be a positive number with at most 8 decimals (e.g. 12.5).");
  }
  const [whole, frac = ""] = s.split(".");
  const grains = BigInt(whole) * BigInt(GRAIN_PER_PRL) + BigInt((frac + "00000000").slice(0, 8));
  if (grains <= 0n) throw new Error("Amount must be greater than zero.");
  if (grains > MAX_SUPPLY_GRAINS) throw new Error("Amount exceeds the 2.1B PRL supply cap.");
  return grains;
}

/** Format integer grains as a human PRL string, trimming trailing zeros. */
export function formatPRL(grains) {
  const g = BigInt(grains);
  const neg = g < 0n;
  const abs = neg ? -g : g;
  const whole = abs / BigInt(GRAIN_PER_PRL);
  const frac = (abs % BigInt(GRAIN_PER_PRL)).toString().padStart(8, "0").replace(/0+$/, "");
  return (neg ? "-" : "") + whole.toString() + (frac ? "." + frac : "");
}

/* ---------- Pearl address validation (Taproot-only, like the chain) ---------- */

export function networkHrp(networkId) {
  const n = NETWORKS[networkId];
  if (!n) throw new Error(`Unknown network "${networkId}".`);
  return n.hrp;
}

/**
 * Validate a Pearl Taproot address for the given network.
 * Returns { canonical, xonlyHex, hrp }. Throws with a human reason otherwise.
 * Rules mirror pearld's DecodeAddress policy (bech32m, witness v1, 32-byte program).
 */
export function validatePearlAddress(addr, networkId = "mainnet") {
  const s = String(addr ?? "").trim();
  if (!s) throw new Error("Address is empty.");
  const hrp = networkHrp(networkId);
  let dec;
  try {
    dec = decodeBech32m(s, hrp);
  } catch (e) {
    throw new Error(`Not a valid ${hrp}1… bech32m address (${e.message || e}).`);
  }
  if (dec.version !== 1) throw new Error("Only witness v1 (Taproot) addresses are accepted.");
  if (dec.program.length !== 32) throw new Error("Taproot program must be 32 bytes.");
  const canonical = encodeBech32m(hrp, 1, dec.program);
  return { canonical, xonlyHex: bytesToHex(dec.program), hrp };
}

/* ---------- donor labels ---------- */

export function normalizeDonorLabel(label) {
  const s = String(label ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  if (s.length < DONOR_LABEL_MIN) throw new Error("Donor label is empty.");
  if (s.length > DONOR_LABEL_MAX)
    throw new Error(`Donor label is too long (max ${DONOR_LABEL_MAX} chars).`);
  if (!/^[\p{L}\p{N} ._\-@]+$/u.test(s))
    throw new Error("Donor label uses characters outside letters/numbers/space . _ - @.");
  return s;
}

/* ---------- rounds ---------- */

function cleanText(s, min, max, what) {
  const t = String(s ?? "").trim().replace(/\s+/g, " ");
  if (t.length < min) throw new Error(`${what} is too short (min ${min} chars).`);
  if (t.length > max) throw new Error(`${what} is too long (max ${max} chars).`);
  return t;
}

export function createRound({ name, description = "", matchingPoolPRL, minContributionPRL, startsAt, endsAt, nowMs = Date.now() }) {
  const rname = cleanText(name, ROUND_NAME_MIN, ROUND_NAME_MAX, "Round name");
  const desc = String(description ?? "").trim().slice(0, DESC_MAX);
  const pool = parsePRLtoGrains(matchingPoolPRL);
  const minC = parsePRLtoGrains(minContributionPRL);
  if (minC < 1n) throw new Error("Minimum contribution must be at least 1 grain.");
  const start = Date.parse(startsAt);
  const end = Date.parse(endsAt);
  if (!Number.isFinite(start)) throw new Error("Start time is not a valid date.");
  if (!Number.isFinite(end)) throw new Error("End time is not a valid date.");
  if (start >= end) throw new Error("Round must end after it starts.");
  if (end <= nowMs) throw new Error("Round end must be in the future.");
  if (start < nowMs - 24 * 3600 * 1000) throw new Error("Round start is more than a day in the past.");

  const body = {
    v: COMMONS_VERSION,
    name: rname,
    description: desc,
    matchingPoolGrains: pool.toString(),
    minContributionGrains: minC.toString(),
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(end).toISOString(),
    status: "upcoming",
    createdAt: new Date(nowMs).toISOString(),
  };
  return { ...body, id: sha256HexText(canon(body)) };
}

/** Derive the live status of a round at nowMs (finalized is sticky, set by operator). */
export function roundStatus(round, nowMs = Date.now()) {
  if (round.status === "finalized") return "finalized";
  const t = Number(nowMs);
  if (t < Date.parse(round.startsAt)) return "upcoming";
  if (t < Date.parse(round.endsAt)) return "active";
  return "closed";
}

export function canContribute(round, nowMs = Date.now()) {
  return roundStatus(round, nowMs) === "active";
}

/* ---------- projects ---------- */

const CATEGORIES = ["infra", "dev-tooling", "wallet", "defi", "education", "community", "research", "other"];

export function projectCategories() {
  return [...CATEGORIES];
}

export function createProject({ roundId, name, address, networkId = "mainnet", category = "other", description = "" }) {
  if (!roundId || typeof roundId !== "string") throw new Error("Project needs a round id.");
  const pname = cleanText(name, PROJECT_NAME_MIN, PROJECT_NAME_MAX, "Project name");
  const { canonical, xonlyHex } = validatePearlAddress(address, networkId);
  if (!CATEGORIES.includes(category)) throw new Error(`Unknown category "${category}".`);
  const desc = String(description ?? "").trim().slice(0, DESC_MAX);
  const body = {
    v: COMMONS_VERSION,
    roundId,
    name: pname,
    address: canonical,
    xonly: xonlyHex,
    network: networkId,
    category,
    description: desc,
    createdAt: new Date().toISOString(),
  };
  return { ...body, id: sha256HexText(canon(body)) };
}

/* ---------- contributions ---------- */

const TXID_RE = /^[0-9a-fA-F]{64}$/;

export function recordContribution({ round, project, donor, amountPRL, txid = "", notedAtMs = Date.now() }) {
  if (!canContribute(round, notedAtMs)) {
    throw new Error(`Round is ${roundStatus(round, notedAtMs)} — contributions are only accepted while active.`);
  }
  const donorNorm = normalizeDonorLabel(donor);
  const amount = parsePRLtoGrains(amountPRL);
  const min = BigInt(round.minContributionGrains);
  if (amount < min) {
    throw new Error(`Contribution is below this round's minimum of ${formatPRL(min)} PRL.`);
  }
  let tx = "";
  if (String(txid ?? "").trim() !== "") {
    tx = String(txid).trim().toLowerCase();
    if (!TXID_RE.test(tx)) throw new Error("txid must be 64 lowercase hex characters.");
  }
  const body = {
    v: COMMONS_VERSION,
    roundId: round.id,
    projectId: project.id,
    donor: donorNorm,
    amountGrains: amount.toString(),
    txid: tx,
    notedAt: new Date(notedAtMs).toISOString(),
  };
  return { ...body, id: sha256HexText(canon(body)) };
}

/* ---------- quadratic funding results ---------- */

/**
 * Aggregate contributions per (project, donor): multiple contributions from one
 * donor label to one project count as a single c_i. Returns Map projectId ->
 * Map donor -> BigInt sum.
 */
export function aggregateByDonor(contributions) {
  const perProject = new Map();
  for (const c of contributions) {
    if (!perProject.has(c.projectId)) perProject.set(c.projectId, new Map());
    const m = perProject.get(c.projectId);
    m.set(c.donor, (m.get(c.donor) || 0n) + BigInt(c.amountGrains));
  }
  return perProject;
}

/**
 * Compute QF matching for one project from its per-donor grain sums (BigInt[]).
 * Returns { contributedGrains: BigInt, donorCount, desiredMatchGrains: BigInt }.
 */
export function qfDesiredMatch(donorSums) {
  let contributed = 0n;
  let sumSqrt = 0; // in PRL space
  let sumC = 0; // in PRL space
  for (const s of donorSums) {
    contributed += s;
    const prl = Number(s) / GRAIN_PER_PRL;
    sumSqrt += Math.sqrt(prl);
    sumC += prl;
  }
  const desiredPRL = sumSqrt * sumSqrt - sumC;
  const desiredGrains =
    desiredPRL <= 0 ? 0n : BigInt(Math.floor(desiredPRL * GRAIN_PER_PRL + 1e-6));
  return { contributedGrains: contributed, donorCount: donorSums.length, desiredMatchGrains: desiredGrains };
}

/**
 * Full round results with the capital constraint applied.
 * Returns { projects: [...ranked], totals: {...}, poolGrains, scaleK }.
 * project rows: { projectId, name, address, contributedGrains, donorCount,
 *   desiredMatchGrains, matchGrains, totalGrains } — grains as decimal strings.
 */
export function computeResults(round, projects, contributions) {
  const pool = BigInt(round.matchingPoolGrains);
  const perProject = aggregateByDonor(contributions.filter((c) => c.roundId === round.id));
  const known = new Map(projects.filter((p) => p.roundId === round.id).map((p) => [p.id, p]));

  const rows = [];
  let totalDesired = 0n;
  let totalContributed = 0n;
  const allDonors = new Set();
  for (const [pid, proj] of known) {
    const donorMap = perProject.get(pid) || new Map();
    const { contributedGrains, donorCount, desiredMatchGrains } = qfDesiredMatch([...donorMap.values()]);
    for (const d of donorMap.keys()) allDonors.add(d);
    totalDesired += desiredMatchGrains;
    totalContributed += contributedGrains;
    rows.push({
      projectId: pid,
      name: proj.name,
      address: proj.address,
      category: proj.category,
      contributedGrains: contributedGrains.toString(),
      donorCount,
      desiredMatchGrains: desiredMatchGrains.toString(),
    });
  }

  // Capital constraint: scale matches down if desired exceeds the pool.
  let scaleK = 1;
  if (totalDesired > 0n && totalDesired > pool) {
    scaleK = Number(pool) / Number(totalDesired);
  }
  let totalMatch = 0n;
  for (const r of rows) {
    const desired = BigInt(r.desiredMatchGrains);
    const match = scaleK === 1 ? desired : BigInt(Math.floor(Number(desired) * scaleK));
    r.matchGrains = match.toString();
    r.totalGrains = (BigInt(r.contributedGrains) + match).toString();
    totalMatch += match;
  }
  rows.sort((a, b) => {
    const d = BigInt(b.totalGrains) - BigInt(a.totalGrains);
    return d === 0n ? a.name.localeCompare(b.name) : Number(d > 0n ? 1n : -1n);
  });

  const remainder = pool - totalMatch;
  return {
    roundId: round.id,
    computedAt: new Date().toISOString(),
    poolGrains: pool.toString(),
    scaleK,
    capitalConstrained: totalDesired > pool,
    projects: rows,
    totals: {
      contributedGrains: totalContributed.toString(),
      projectCount: rows.length,
      uniqueDonors: allDonors.size,
      desiredMatchGrains: totalDesired.toString(),
      matchGrains: totalMatch.toString(),
      remainderGrains: remainder.toString(),
    },
  };
}

/* ---------- hash-chained audit log ---------- */

export function appendAuditEvent(log, type, body) {
  const prev = log.length ? log[log.length - 1].hash : "GENESIS";
  const entry = {
    seq: log.length,
    ts: new Date().toISOString(),
    type,
    body,
    prev,
  };
  entry.hash = sha256HexText(prev + canon(entry));
  log.push(entry);
  return entry;
}

export function verifyAuditChain(log) {
  let prev = "GENESIS";
  for (let i = 0; i < log.length; i++) {
    const e = log[i];
    if (e.seq !== i) return { ok: false, badSeq: i, reason: "sequence break" };
    if (e.prev !== prev) return { ok: false, badSeq: i, reason: "prev-hash mismatch" };
    const { hash, ...rest } = e;
    if (sha256HexText(e.prev + canon(rest)) !== hash)
      return { ok: false, badSeq: i, reason: "hash mismatch" };
    prev = hash;
  }
  return { ok: true, entries: log.length, tip: prev };
}

/* ---------- Blockbook tx verify (GET-only, optional) ---------- */

/** Fetch a tx from Blockbook and return { txid, outputs: [{ addresses, valueGrains }] }. */
export async function fetchBlockbookTx(blockbookBase, txid) {
  const base = String(blockbookBase || "").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(base)) throw new Error("Blockbook URL must start with http(s)://");
  if (!TXID_RE.test(String(txid || "").trim().toLowerCase()))
    throw new Error("txid must be 64 hex characters.");
  const url = `${base}/api/v2/tx/${txid.trim().toLowerCase()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Blockbook returned HTTP ${res.status} for ${txid.slice(0, 12)}…`);
  const j = await res.json();
  return {
    txid: j.txid,
    confirmations: j.confirmations ?? 0,
    outputs: (j.vout || []).map((o) => ({
      addresses: o.addresses || [],
      valueGrains: BigInt(Math.round(Number(o.value) * GRAIN_PER_PRL)).toString(),
    })),
  };
}

/**
 * Find a contribution's on-chain footprint: first output paying the project's
 * address with value >= amount. Returns { valueGrains, confirmations } or null.
 */
export function locateContributionOutput(tx, projectAddress, amountGrains) {
  const want = BigInt(amountGrains);
  for (const o of tx.outputs) {
    if (o.addresses.includes(projectAddress) && BigInt(o.valueGrains) >= want) {
      return { valueGrains: o.valueGrains, confirmations: tx.confirmations };
    }
  }
  return null;
}
