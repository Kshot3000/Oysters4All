// Pearl Hedge browser entry — explicit namespace export.
// Bundled by build.mjs as a plain IIFE (no globalName wrapper); the explicit
// window assignment below is the single source of the public name.
import * as core from "./hedge-core.js";

window.PearlHedge = core;
