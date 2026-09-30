// Entry: re-export the Pearl Quorum core as window.PearlQuorum via the bundle.
// The audited sign/escrow/batch plumbing the UI needs (Blockbook reads,
// broadcast, Schnorr, taptree helpers) rides along as the `Sign` and
// `Escrow` namespaces — no second bundle, so the page still works from
// file:// with zero build step.
export * from "./quorum-core.js";
export * as Sign from "../../sign/src/sign-core.js";
export * as Escrow from "../../escrow/src/escrow-core.js";
