// Entry: re-export Pearl Bounty core as window.PearlBounty via the bundle.
// The audited Sign plumbing the UI needs (BIP-86 wallets, bech32m, Schnorr,
// script-path tx building, fee math, Blockbook) rides along as the
// `Sign` namespace — no second bundle, so the page still works from file://
// with zero build step. The one local construction (NUMS internal key under
// the "PearlBountyNUMS/v1" domain) lives in bounty-core.js and mirrors the
// audited escrow NUMS field-for-field; the reclaim leaf is byte-identical to
// the audited escrow buildRefundScript.
export * from "./bounty-core.js";
export * as Sign from "../../sign/src/sign-core.js";

// The `Crypto` bridge re-exports helpers from the same audited crypto.js.
export {
  walletFromWIF, walletToWIF, walletFromPriv, walletFromMnemonic, newMnemonic,
  tweakKeypath, tweakPrivKeypath, p2trScriptPubKey,
  keypathTxVBytes, encodeBech32m, decodeBech32m, bytesToHex, hexToBytes, sha256,
  DUST_GRAIN, NETWORKS, GRAIN_PER_PRL,
} from "../../sign/src/crypto.js";
