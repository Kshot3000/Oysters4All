// Pearl Sign ESM entry — re-exports the audited crypto plus the forge core.
// NOTE: crypto.js and sign-core.js both export `fetchUtxos`. Under `export *`
// from both modules the name is ambiguous and is silently DROPPED from the
// bundle — which broke the "Fetch UTXOs" button at runtime
// ("P.fetchUtxos is not a function", caught 2026-10-01 by browser QA).
// The explicit re-export below resolves the collision in favor of
// sign-core.js (its version reports unreachable backends more clearly).
export * from "./crypto.js";
export * from "./sign-core.js";
export { fetchUtxos } from "./sign-core.js";
