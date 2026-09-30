// Entry: re-export the Pearl Split core as window.PearlSplit via the bundle.
// The audited sign/batch plumbing the UI needs (Blockbook reads, broadcast,
// pasted-UTXO parsing) rides along as the `Sign` namespace — no second bundle,
// so the page still works from file:// with zero build step.
export * from "./split-core.js";
export * as Sign from "../../sign/src/sign-core.js";
