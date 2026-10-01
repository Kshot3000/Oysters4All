// Pearl Payjoin browser entry — explicit window assignment (no esbuild
// globalName: the IIFE-wrapper globalName clobbers explicit window
// assignment; see AGENTS.md).
import * as core from "./payjoin-core.js";
window.PearlPayjoin = { version: 1, ...core };
