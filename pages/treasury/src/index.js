// Entry: re-export Pearl Treasury core as window.PearlTreasury via the bundle.
// The audited Sign plumbing the UI needs (BIP-86 wallets, bech32m, Schnorr,
// script-path tx building, fee math, Blockbook) rides along as the
// `Sign` namespace; covenant vault construction and signing rounds ride as
// `Covenant` — no second bundle, so the page still works from file://
// with zero build step. The one local construction (proposal ids,
// schedules, audit hash-chain) lives in treasury-core.js and adds no new
// cryptography: it only orchestrates the audited primitives.
export * from "./treasury-core.js";
export * as Covenant from "../../covenant/src/covenant-core.js";
export * as Sign from "../../sign/src/sign-core.js";

// The `Crypto` bridge re-exports helpers from the same audited crypto.js.
export {
  walletFromWIF, walletToWIF, walletFromPriv, walletFromMnemonic, newMnemonic,
  tweakKeypath, tweakPrivKeypath, p2trScriptPubKey,
  keypathTxVBytes, encodeBech32m, decodeBech32m, bytesToHex, hexToBytes, sha256,
  DUST_GRAIN, NETWORKS, GRAIN_PER_PRL,
} from "../../sign/src/crypto.js";
