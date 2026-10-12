// Pearl Gift core: BIP-86 paper wallets / gift cards + air-gapped redeem.
// Reuses the audited Pearl Sign crypto (keys, sighash, schnorr, wire) —
// no new cryptography is introduced here.
import {
  NETWORKS, GRAIN_PER_PRL, DUST_GRAIN,
  newMnemonic, walletFromMnemonic, walletFromWIF, walletToWIF, walletFromPriv,
  decodeBech32m, encodeBech32m, tweakKeypath, p2trScriptPubKey,
  keypathTxVBytes, bytesToHex, hexToBytes, broadcastTx,
} from "../../sign/src/crypto.js";
import {
  SIGHASH_DEFAULT, fmtPRL, parsePRL,
  buildKeypathTxEx, verifySignedTx, decodeRawTx,
  fetchUtxos, fetchFeeRate,
} from "../../sign/src/sign-core.js";

export {
  NETWORKS, GRAIN_PER_PRL, DUST_GRAIN,
  fmtPRL, parsePRL,
  fetchUtxos, fetchFeeRate, broadcastTx, decodeRawTx,
  verifySignedTx, SIGHASH_DEFAULT,
  tweakKeypath, p2trScriptPubKey, decodeBech32m, encodeBech32m,
  bytesToHex, hexToBytes, keypathTxVBytes,
  newMnemonic, walletFromMnemonic, walletFromWIF, walletToWIF, walletFromPriv,
};

/** BIP-86 account index this app reserves for gift cards.
 *  Path: m/86'/coin'/1000'/0/0 — a dedicated account so gift keys never
 *  collide with a creator's main (account 0) wallet. App convention,
 *  not a protocol rule: any BIP-86 key imports as a gift. */
export const GIFT_ACCOUNT = 1000;

export const DONATE_ADDRESS = "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d";

/* Optional builder tip (profit mandate, disclosed, opt-in/default-off):
 * a redeem sweep spends the gift card's funds, signed by the card holder
 * alone, so — like Batch/Payroll/Rain/Sweep — the tip is never automatic:
 * the redeemer explicitly opts in. builderTipGrainsFor() is the single
 * source; planSweep() adds the tip as its own output BEFORE signing, and
 * the keypath sighash commits to every output — so it cannot be added or
 * skimmed after signing. Off = plan identical to the pre-tip planner. The
 * recipient is the operator address above, the same address in every
 * Gift footer. */
export const BUILDER_TIP_BPS = 100; // 1%
export const BUILDER_TIP_ADDRESS = DONATE_ADDRESS;
export const BUILDER_TIP_NAME = "Builder tip (optional)";

/** Builder tip in grains for a sweep totaling totalGrains, on network.
 *  Returns 0n unless enabled === true, the network is mainnet, and the
 *  1% floor reaches the dust floor (waived, never rounded up). */
export function builderTipGrainsFor(totalGrains, network, enabled) {
  if (enabled !== true) return 0n;
  if (!network || network.hrp !== "prl") return 0n;
  const total = BigInt(totalGrains);
  if (total <= 0n) throw new Error("bad total for builder tip");
  const tip = (total * BigInt(BUILDER_TIP_BPS)) / 10000n;
  return tip >= BigInt(DUST_GRAIN) ? tip : 0n;
}

const isHex64 = (s) => /^[0-9a-fA-F]{64}$/.test(s);
const isWifLike = (s) => /^[1-9A-HJ-NP-Za-km-z]{40,60}$/.test(s);

/** Create or import gift key material.
 *  Exactly one of {mnemonic, wif, privHex} may be given; none => fresh mnemonic.
 *  Returns { mnemonic (fresh or supplied), privHex, wif, internalXOnlyHex,
 *  address, account, index, network }. account/index are null for wif/priv imports
 *  (no derivation path applies). */
export function createGift({ mnemonic = null, wif = null, privHex = null, account = GIFT_ACCOUNT, index = 0, network = NETWORKS.mainnet } = {}) {
  const given = [mnemonic, wif, privHex].filter((x) => x != null);
  if (given.length > 1) throw new Error("give exactly one of mnemonic, wif, privHex");
  let w, freshMnemonic = null, acc = account, idx = index;
  if (privHex != null) {
    w = walletFromPriv(privHex, network); acc = null; idx = null;
  } else if (wif != null) {
    w = walletFromWIF(wif, network); acc = null; idx = null;
  } else {
    freshMnemonic = mnemonic || newMnemonic();
    w = walletFromMnemonic(freshMnemonic, network, account, index);
  }
  return {
    mnemonic: freshMnemonic,
    privHex: bytesToHex(w.priv),
    wif: walletToWIF(w.priv, network),
    internalXOnlyHex: bytesToHex(w.internalXOnly),
    address: w.address,
    account: acc, index: idx, network,
  };
}

/** Accept a pasted gift secret: 12/24-word mnemonic, WIF, or 64-hex private key. */
export function parseGiftSecret(text, network = NETWORKS.mainnet) {
  const t = String(text ?? "").trim();
  if (!t) throw new Error("paste a gift secret — a 12/24-word mnemonic, a WIF key, or a 64-hex private key");
  const words = t.split(/\s+/);
  if (words.length === 12 || words.length === 24) {
    try { return createGift({ mnemonic: words.join(" "), network }); }
    catch (e) { throw new Error("that mnemonic is not valid BIP-39 (" + (e.message || e) + ")"); }
  }
  if (isHex64(t)) return createGift({ privHex: t.toLowerCase(), network });
  if (isWifLike(t)) return createGift({ wif: t, network });
  throw new Error("unrecognized secret — paste a 12/24-word mnemonic, a WIF key, or a 64-hex private key");
}

/** Payload for the private QR code: the WIF (standard, importable by wallets). */
export function privateQrPayload(gift) {
  return gift.wif;
}

/** Machine-readable card payload (export/import a whole card definition). */
export function cardPayload(gift, { to = "", from = "", message = "", design = "abyss" } = {}) {
  return JSON.stringify({
    app: "pearl-gift/v1", design, to, from, message,
    address: gift.address, wif: gift.wif,
    account: gift.account, index: gift.index,
  });
}

/** Parse a card payload produced by cardPayload(). */
export function parseCardPayload(json, network = NETWORKS.mainnet) {
  let obj;
  try { obj = JSON.parse(String(json)); } catch { throw new Error("not a valid card payload"); }
  if (!obj || obj.app !== "pearl-gift/v1") throw new Error("not a Pearl Gift card payload");
  const gift = createGift({ wif: String(obj.wif || ""), network });
  if (gift.address !== String(obj.address || "")) throw new Error("card payload is inconsistent (address does not match key)");
  return { gift, to: String(obj.to || ""), from: String(obj.from || ""), message: String(obj.message || ""), design: String(obj.design || "abyss") };
}

/** Redeem plan: sweep every UTXO to `recipient`, deducting an exact fee.
 *  utxos: [{txid, vout, value (grains)}]. Returns {total, fee, amount (BigInt),
 *  recipient (canonical), program, feeRate, nIn}. */
export function planSweep({ utxos, recipient, feeRateGrainsPerVByte, network = NETWORKS.mainnet, builderTipEnabled = false }) {
  if (!Array.isArray(utxos) || utxos.length === 0) throw new Error("no UTXOs to sweep — the gift card looks empty");
  const dec = decodeBech32m(String(recipient || "").trim(), network.hrp);
  if (dec.version !== 1) throw new Error("recipient must be a Pearl v1 (Taproot) address");
  const rate = Math.ceil(Number(feeRateGrainsPerVByte));
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("fee rate must be a positive number");
  const seenUtxoOutpoints = new Set();
  for (const u of utxos) {
    if (!/^[0-9a-f]{64}$/i.test(u.txid || "")) throw new Error("bad utxo txid");
    if (!Number.isInteger(u.vout) || u.vout < 0) throw new Error("bad utxo vout");
    if (!Number.isSafeInteger(u.value) || u.value <= 0) throw new Error("bad utxo value");
    const outpointKey = `${u.txid.toLowerCase()}:${u.vout}`;
    if (seenUtxoOutpoints.has(outpointKey)) throw new Error(`duplicate utxo ${outpointKey} — an outpoint can only be spent once`);
    seenUtxoOutpoints.add(outpointKey);
  }
  const total = utxos.reduce((a, u) => a + BigInt(u.value), 0n);
  // Optional builder tip: 1% of the swept total, its own extra output.
  const builderTip = builderTipGrainsFor(total, network, builderTipEnabled === true);
  const builderTipDec = builderTip > 0n ? decodeBech32m(BUILDER_TIP_ADDRESS, "prl") : null;
  const fee = BigInt(keypathTxVBytes(utxos.length, builderTip > 0n ? 2 : 1)) * BigInt(rate);
  const amount = total - fee - builderTip;
  if (amount < BigInt(DUST_GRAIN)) {
    if (builderTip > 0n) {
      throw new Error(`dust: after the fee and the ${fmtPRL(builderTip)} builder tip the sweep pays ${fmtPRL(amount)} — below the ${fmtPRL(DUST_GRAIN)} dust floor. Load more PRL, lower the fee rate, or leave the builder tip off.`);
    }
    throw new Error(`dust: after fees the sweep pays ${fmtPRL(amount)} — below the ${fmtPRL(DUST_GRAIN)} dust floor. Load more PRL or lower the fee rate.`);
  }
  return {
    total, fee, amount,
    recipient: encodeBech32m(network.hrp, 1, dec.program),
    program: dec.program, feeRate: rate, nIn: utxos.length,
    builderTip,
    builderTipAddress: builderTip > 0n ? BUILDER_TIP_ADDRESS : null,
    builderTipProgram: builderTipDec ? builderTipDec.program : null,
  };
}

/** Build + Schnorr-sign + locally verify the sweep transaction.
 *  utxos: [{txid, vout, value}] — every utxo must belong to the gift address;
 *  callers MUST fetch them for the derived gift address (or verify pasted ones).
 *  Returns { txid, hex, plan }. Throws if any local signature fails. */
export function buildSweepTx({ privHex, utxos, plan, network = NETWORKS.mainnet }) {
  const w = walletFromPriv(privHex, network);
  const { tweakedX } = tweakKeypath(w.internalXOnly);
  const spk = p2trScriptPubKey(tweakedX);
  const giftAddress = encodeBech32m(network.hrp, 1, tweakedX);
  const inputs = utxos.map((u) => {
    const txid = String(u.txid).toLowerCase();
    return { txid, vout: u.vout, value: u.value, spk, priv: w.priv, internalXOnly: w.internalXOnly };
  });
  const outputs = [{ program: plan.program, value: Number(plan.amount) }];
  // A builder tip in the plan is a trust claim: its program must pay the
  // builder address exactly, or signing is refused (Batch/Sweep pattern).
  const builderTip = BigInt(plan.builderTip ?? 0n);
  if (builderTip > 0n) {
    if (builderTip < BigInt(DUST_GRAIN)) throw new Error("builder tip in the plan is below the dust floor — refusing to sign");
    const want = decodeBech32m(BUILDER_TIP_ADDRESS, "prl").program;
    const got = plan.builderTipProgram;
    const paysBuilder = got instanceof Uint8Array && got.length === 32 && got.every((b, i) => b === want[i]);
    if (!paysBuilder) throw new Error("REFUSED — the plan carries a builder tip that does not pay the builder address.");
    outputs.push({ program: want, value: Number(builderTip) });
  }
  const { txid, hex } = buildKeypathTxEx(network, inputs, outputs, SIGHASH_DEFAULT);
  const prevouts = inputs.map((i) => ({ value: i.value, spk: i.spk }));
  const checks = verifySignedTx(network, hex, prevouts);
  const bad = checks.filter((c) => !c.ok);
  if (bad.length || checks.length !== inputs.length) {
    throw new Error("local signature verification failed: " + bad.map((b) => `#${b.index}: ${b.reason}`).join("; "));
  }
  return { txid, hex, plan, giftAddress };
}

/** Check a pasted UTXO list against the gift address: every line may carry an
 *  optional trailing address; those that do must equal the gift address. */
export function assertUtxosBelong(utxos, giftAddress) {
  for (const u of utxos) {
    if (u.address && String(u.address).toLowerCase() !== giftAddress.toLowerCase()) {
      throw new Error(`utxo ${String(u.txid).slice(0, 12)}… belongs to ${u.address}, not the gift address`);
    }
  }
}
