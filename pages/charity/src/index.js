// Entry: re-export Pearl Charity core as window.PearlCharity via the bundle.
// The audited Sign plumbing the UI needs (BIP-86 wallets, bech32m, Schnorr,
// Blockbook helpers) rides along as the `Sign` namespace — no second bundle,
// so the page still works from file:// with zero build step. All crypto in
// charity-core.js is the audited sign/escrow lineage; nothing new.
export * from "./charity-core.js";
export * as Sign from "../../sign/src/sign-core.js";

// The `Crypto` bridge re-exports helpers from the same audited crypto.js.
export {
  walletFromWIF, walletToWIF, walletFromPriv, walletFromMnemonic, newMnemonic,
  tweakKeypath, tweakPrivKeypath, p2trScriptPubKey,
  keypathTxVBytes, encodeBech32m, decodeBech32m, bytesToHex, hexToBytes, sha256,
  DUST_GRAIN, NETWORKS, GRAIN_PER_PRL,
} from "../../sign/src/crypto.js";
