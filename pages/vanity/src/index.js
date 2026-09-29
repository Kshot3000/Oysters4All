// Browser entry: re-export the vanity core as window.PearlVanity,
// plus the generated inline worker source (src/worker-src.js, written by build.mjs).
export * from "./vanity-core.js";
export { WORKER_SRC } from "./worker-src.js";
