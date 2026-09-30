// Entry: re-export Pearl Boost core as window.PearlBoost via the bundle.
// The audited Sign plumbing the UI needs (key derivation from WIF, P2TR
// address encoding, keypath tx building, BIP-341 digests, Schnorr signing,
// per-signature re-verification, dust constant, fee/vByte math, Blockbook
// broadcast) rides along as the `Sign` namespace — no second bundle, so the
// page still works from file:// with zero build step. No new cryptography
// anywhere in this app.
export * from "./boost-core.js";
export * as Sign from "../../sign/src/sign-core.js";

// The `Crypto` bridge re-exports a few more helpers from the same audited
// crypto.js (WIF -> tweaked P2TR address, script building, bech32m decode,
// networks) — also no new cryptography anywhere in this app.
export {
  walletFromWIF, walletToWIF, tweakKeypath, p2trScriptPubKey, keypathTxVBytes,
  encodeBech32m, decodeBech32m, bytesToHex, hexToBytes, DUST_GRAIN, NETWORKS,
} from "../../sign/src/crypto.js";
