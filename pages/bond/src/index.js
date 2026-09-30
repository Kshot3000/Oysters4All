// Entry: re-export Pearl Bond core as window.PearlBond via the bundle.
// The audited Sign plumbing the UI needs (BIP-86 wallets, bech32m, Schnorr,
// keypath/script-path tx building, fee math, Blockbook) rides along as the
// `Sign` namespace — no second bundle, so the page still works from file://
// with zero build step. The one new construction (script-path 0x83 sighash)
// lives in bond-core.js and is covered by the consensus cross-check tests.
export * from "./bond-core.js";
export * as Sign from "../../sign/src/sign-core.js";

// The `Crypto` bridge re-exports helpers from the same audited crypto.js.
export {
  walletFromWIF, walletToWIF, walletFromPriv, tweakKeypath, tweakPrivKeypath, p2trScriptPubKey,
  keypathTxVBytes, encodeBech32m, decodeBech32m, bytesToHex, hexToBytes,
  DUST_GRAIN, NETWORKS, GRAIN_PER_PRL,
} from "../../sign/src/crypto.js";
