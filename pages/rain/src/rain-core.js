// Pearl Rain core: non-custodial PRL batch-send / airdrop tool.
// One keypath-Schnorr transaction, N recipient outputs + change back to the
// funder. Reuses the audited Pearl Sign crypto (keys, sighash, schnorr, wire,
// fee math, Blockbook helpers) — no new cryptography is introduced here.
import {
  NETWORKS, GRAIN_PER_PRL, DUST_GRAIN,
  newMnemonic, walletFromMnemonic, walletFromWIF, walletToWIF, walletFromPriv,
  decodeBech32m, encodeBech32m, tweakKeypath, p2trScriptPubKey,
  keypathTxVBytes, bytesToHex, hexToBytes, broadcastTx,
} from "../../sign/src/crypto.js";
import {
  SIGHASH_DEFAULT, fmtPRL, parsePRL,
  buildKeypathTxEx, verifySignedTx, decodeRawTx, parseUtxoList,
  fetchUtxos, fetchFeeRate,
} from "../../sign/src/sign-core.js";

export {
  NETWORKS, GRAIN_PER_PRL, DUST_GRAIN,
  fmtPRL, parsePRL,
  fetchUtxos, fetchFeeRate, broadcastTx, decodeRawTx, parseUtxoList,
  verifySignedTx, SIGHASH_DEFAULT,
  tweakKeypath, p2trScriptPubKey, decodeBech32m, encodeBech32m,
  bytesToHex, hexToBytes, keypathTxVBytes,
  newMnemonic, walletFromMnemonic, walletFromWIF, walletToWIF, walletFromPriv,
};

/** BIP-86 account index a rain funder imports under (main account 0).
 *  Path: m/86'/coin'/0'/0/0 — the funder's ordinary wallet account.
 *  WIF/hex imports are used as-is (no derivation path applies). */
export const RAIN_ACCOUNT = 0;

/** Maximum recipients per rain transaction (relay/peer standardness headroom). */
export const MAX_OUTPUTS = 250;

const isHex64 = (s) => /^[0-9a-fA-F]{64}$/.test(s);
const isWifLike = (s) => /^[1-9A-HJ-NP-Za-km-z]{40,60}$/.test(s);

/** Accept a funder secret: 12/24-word mnemonic (BIP-86 account 0/0/0),
 *  WIF, or 64-hex private key. Returns { mnemonic (or null), privHex,
 *  internalXOnlyHex, address, account, index, network }. */
export function parseRainSecret(text, network = NETWORKS.mainnet) {
  const t = String(text ?? "").trim();
  if (!t) throw new Error("paste the funder secret — a 12/24-word mnemonic, a WIF key, or a 64-hex private key");
  const words = t.split(/\s+/);
  let w, mnemonic = null, account = null, index = null;
  if (words.length === 12 || words.length === 24) {
    try { w = walletFromMnemonic(words.join(" "), network, RAIN_ACCOUNT, 0); }
    catch (e) { throw new Error("that mnemonic is not valid BIP-39 (" + (e.message || e) + ")"); }
    mnemonic = words.join(" ");
    account = RAIN_ACCOUNT; index = 0;
  } else if (isHex64(t)) {
    w = walletFromPriv(t.toLowerCase(), network);
  } else if (isWifLike(t)) {
    try { w = walletFromWIF(t, network); }
    catch (e) { throw new Error("that WIF is not valid (" + (e.message || e) + ")"); }
  } else {
    throw new Error("unrecognized secret — paste a 12/24-word mnemonic, a WIF key, or a 64-hex private key");
  }
  const { tweakedX } = tweakKeypath(w.internalXOnly);
  return {
    mnemonic, account, index, network,
    privHex: bytesToHex(w.priv),
    wif: walletToWIF(w.priv, network),
    internalXOnlyHex: bytesToHex(w.internalXOnly),
    address: encodeBech32m(network.hrp, 1, tweakedX),
    program: tweakedX,
  };
}

/** Parse one recipient line: `address amount [prl|grains]` — comma or
 *  whitespace separated. Amount is PRL (decimals ok) unless the `grains`
 *  unit word is given. Returns { address, program, amount (BigInt) }. */
function parseRecipientLine(line, lineNo, network) {
  const parts = line.replace(/,/g, " ").split(/\s+/).filter(Boolean);
  if (parts.length < 2) throw new Error(`line ${lineNo}: need "<address> <amount>", got: ${line}`);
  if (parts.length > 3) throw new Error(`line ${lineNo}: too many fields: ${line}`);
  const [addr, amountS, unit] = parts;
  let dec;
  try { dec = decodeBech32m(addr, network.hrp); }
  catch { throw new Error(`line ${lineNo}: not a valid ${network.hrp}1 address: ${addr}`); }
  if (dec.version !== 1 || dec.program.length !== 32) {
    throw new Error(`line ${lineNo}: address must be a Pearl v1 (Taproot) address`);
  }
  const canonical = encodeBech32m(network.hrp, 1, dec.program);
  let amount;
  if (unit == null || /^prl$/i.test(unit)) {
    try { amount = parsePRL(amountS); } catch { throw new Error(`line ${lineNo}: invalid PRL amount: ${amountS}`); }
  } else if (/^grains?$/i.test(unit)) {
    if (!/^\d+$/.test(amountS)) throw new Error(`line ${lineNo}: invalid grains amount: ${amountS}`);
    amount = BigInt(amountS);
  } else {
    throw new Error(`line ${lineNo}: unknown unit "${unit}" — use "prl" or "grains"`);
  }
  if (amount <= 0n) throw new Error(`line ${lineNo}: amount must be positive`);
  if (amount < BigInt(DUST_GRAIN)) {
    throw new Error(`line ${lineNo}: ${fmtPRL(amount)} PRL is below the dust floor of ${fmtPRL(DUST_GRAIN)} PRL — raise it or drop the line`);
  }
  return { address: canonical, program: dec.program, amount };
}

/** Parse a recipient list (textarea paste or CSV import).
 *  Returns { recipients: [{address, program, amount}], merged: number } —
 *  duplicate addresses are merged into one output (amounts summed). */
export function parseRecipients(text, network = NETWORKS.mainnet) {
  const t = String(text ?? "");
  const lines = t.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  if (lines.length === 0) throw new Error("no recipients — paste one \"<address> <amount>\" per line, or import a CSV");
  if (lines.length > MAX_OUTPUTS * 4) throw new Error(`too many lines (max ${MAX_OUTPUTS} recipients — duplicates merge down)`);
  const parsed = lines.map((l, i) => parseRecipientLine(l, i + 1, network));
  const byAddr = new Map();
  let merged = 0;
  for (const r of parsed) {
    if (byAddr.has(r.address)) {
      byAddr.get(r.address).amount += r.amount;
      merged++;
    } else {
      byAddr.set(r.address, { address: r.address, program: r.program, amount: r.amount });
    }
  }
  const recipients = [...byAddr.values()];
  if (recipients.length > MAX_OUTPUTS) throw new Error(`too many unique recipients (${recipients.length}) — max ${MAX_OUTPUTS} per transaction; split the rain`);
  return { recipients, merged };
}

/** Downloadable sample recipient list (replace the addresses + amounts). */
export function sampleRainCsv() {
  return [
    "# Pearl Rain sample — one \"<address> <amount>\" per line",
    "# address = Pearl v1 (Taproot) prl1… address · amount = PRL (decimals ok)",
    "# commas work too: <address>,<amount> · lines starting with # are ignored",
    "# duplicates merge into one output; change returns to the funder",
    "prl1pr6yuq8u2r95wjzzgpdy8cpnncpl7l8zgy6x5q0367pnc53s2famqg7pt74 1.25",
    "prl1p7dwp74zgd4te3mqr58d6x3p3t70jljmpe4auey8g824ra4x43tks3y4pr6 0.5",
    "prl1p5gfau0gepxzjkjyx9t88ewnhujrmpjqgqfh8v9vympjaz94x36jqpepvyt 10",
  ].join("\n") + "\n";
}

/** Check a pasted UTXO list against the funder address: every line carrying a
 *  trailing address must equal the funder address. */
export function assertUtxosBelong(utxos, funderAddress) {
  for (const u of utxos) {
    if (u.address && String(u.address).toLowerCase() !== funderAddress.toLowerCase()) {
      throw new Error(`utxo ${String(u.txid).slice(0, 12)}… belongs to ${u.address}, not the funder address`);
    }
  }
}

/** Parse a manually pasted UTXO list (air-gapped mode), one per line:
 *  `txid:vout value [prl|grains] [address]` — the trailing address is kept
 *  so assertUtxosBelong() can refuse foreign coins. Value defaults to grains
 *  (like the sign app's format); "prl" switches to PRL decimals.
 *  Returns [{txid, vout, value, confirmations: 0, address|null}]. */
export function parseManualUtxos(text, network = NETWORKS.mainnet) {
  const lines = String(text ?? "").split(/\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  if (!lines.length) throw new Error("paste at least one UTXO line — txid:vout value, optional trailing address");
  const out = [];
  for (const line of lines) {
    const m = line.match(/^([0-9a-fA-F]{64}):(\d+)\s+(\S+)(?:\s+(prl|grains?))?(?:\s+(\S+))?$/i);
    if (!m) throw new Error(`bad utxo line: "${line.slice(0, 48)}…" — expected txid:vout value [prl|grains] [address]`);
    let value;
    const unit = (m[4] || "grains").toLowerCase();
    if (unit === "prl") {
      try { value = parsePRL(m[3]); } catch { throw new Error(`bad PRL value on line: "${line.slice(0, 48)}…"`); }
    } else {
      if (!/^\d+$/.test(m[3])) throw new Error(`bad grains value on line: "${line.slice(0, 48)}…"`);
      value = BigInt(m[3]);
    }
    if (value <= 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`bad utxo value on line: "${line.slice(0, 48)}…"`);
    }
    let address = null;
    if (m[5]) {
      try {
        const dec = decodeBech32m(m[5], network.hrp);
        if (dec.version !== 1 || dec.program.length !== 32) throw new Error("not taproot");
        address = encodeBech32m(network.hrp, 1, dec.program);
      } catch { throw new Error(`bad address on utxo line: "${line.slice(0, 48)}…"`); }
    }
    out.push({ txid: m[1].toLowerCase(), vout: Number(m[2]), value: Number(value), confirmations: 0, address });
  }
  return out;
}

/** Plan the rain transaction: N recipient outputs + change back to the funder.
 *  utxos: [{txid, vout, value (grains)}]; recipients: [{address, program, amount}].
 *  Fee = keypathTxVBytes(nIn, nOut) * rate, dust change is absorbed into the fee.
 *  Returns { total, sumOut, fee, change, outputs: [{address|funder, program, value, change:boolean}],
 *  vBytes, feeRate, nIn, nOut, changeDropped }.
 *  Throws if inputs can't cover outputs + fee. */
export function planRain({ utxos, recipients, funderProgram, feeRateGrainsPerVByte, network = NETWORKS.mainnet }) {
  if (!Array.isArray(utxos) || utxos.length === 0) throw new Error("no UTXOs to spend — fetch the funder's UTXOs first");
  if (!Array.isArray(recipients) || recipients.length === 0) throw new Error("no recipients to rain on");
  if (recipients.length > MAX_OUTPUTS) throw new Error(`too many recipients (max ${MAX_OUTPUTS})`);
  for (const u of utxos) {
    if (!/^[0-9a-f]{64}$/i.test(u.txid || "")) throw new Error("bad utxo txid");
    if (!Number.isInteger(u.vout) || u.vout < 0) throw new Error("bad utxo vout");
    if (!Number.isSafeInteger(u.value) || u.value <= 0) throw new Error("bad utxo value");
  }
  if (!(funderProgram instanceof Uint8Array) || funderProgram.length !== 32) throw new Error("bad funder program");
  const rate = Math.ceil(Number(feeRateGrainsPerVByte));
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("fee rate must be a positive number");
  for (const r of recipients) {
    if (r.amount < BigInt(DUST_GRAIN)) throw new Error(`recipient ${r.address.slice(0, 18)}… is below dust — re-validate the list`);
  }
  const total = utxos.reduce((a, u) => a + BigInt(u.value), 0n);
  const sumOut = recipients.reduce((a, r) => a + BigInt(r.amount), 0n);
  const nIn = utxos.length;
  const n = recipients.length;

  // Try with a change output; dust change falls back to no-change.
  let vBytes = keypathTxVBytes(nIn, n + 1);
  let fee = BigInt(vBytes) * BigInt(rate);
  let change = total - sumOut - fee;
  let changeDropped = false;
  if (change >= BigInt(DUST_GRAIN)) {
    // keep change
  } else if (change >= 0n) {
    changeDropped = true; // dust change -> absorbed into the fee
    vBytes = keypathTxVBytes(nIn, n);
    fee = BigInt(vBytes) * BigInt(rate);
    change = 0n;
  }
  const minNeed = sumOut + fee;
  if (total < minNeed) {
    throw new Error(`insufficient funds: have ${fmtPRL(total)} PRL, need ${fmtPRL(minNeed)} PRL (${fmtPRL(sumOut)} to recipients + ${fmtPRL(fee)} fee). Reduce recipients/amounts or lower the fee rate.`);
  }
  const leftover = total - sumOut - fee; // to change, or extra fee when change was dropped
  const outputs = recipients.map((r) => ({
    address: r.address, program: r.program, value: Number(r.amount), change: false,
  }));
  if (!changeDropped) {
    outputs.push({ address: encodeBech32m(network.hrp, 1, funderProgram), program: funderProgram, value: Number(leftover), change: true });
  }
  return {
    total, sumOut, fee, change: changeDropped ? 0n : leftover,
    outputs, vBytes, feeRate: rate, nIn, nOut: outputs.length, changeDropped,
    feeBump: changeDropped ? leftover : 0n,
  };
}

/** Build + Schnorr-sign + locally verify the rain transaction.
 *  Every input is the funder's keypath spend; each signature is re-verified
 *  before the hex leaves this function. Returns { txid, hex, plan }.
 *  Throws (and never exposes hex) if any local verification fails. */
export function buildRainTx({ privHex, utxos, plan, network = NETWORKS.mainnet }) {
  const w = walletFromPriv(privHex, network);
  const { tweakedX } = tweakKeypath(w.internalXOnly);
  const spk = p2trScriptPubKey(tweakedX);
  const funderAddress = encodeBech32m(network.hrp, 1, tweakedX);
  const inputs = utxos.map((u) => ({
    txid: String(u.txid).toLowerCase(), vout: u.vout, value: u.value,
    spk, priv: w.priv, internalXOnly: w.internalXOnly,
  }));
  const outputs = plan.outputs.map((o) => ({ program: o.program, value: o.value }));
  const { txid, hex } = buildKeypathTxEx(network, inputs, outputs, SIGHASH_DEFAULT);
  const prevouts = inputs.map((i) => ({ value: i.value, spk: i.spk }));
  const checks = verifySignedTx(network, hex, prevouts);
  const bad = checks.filter((c) => !c.ok);
  if (bad.length || checks.length !== inputs.length) {
    throw new Error("local signature verification failed: " + bad.map((b) => `#${b.index}: ${b.reason}`).join("; "));
  }
  return { txid, hex, plan, funderAddress };
}
